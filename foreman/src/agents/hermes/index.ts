// Hermes backend: each AgentCraft character is one persistent session of a Hermes gateway
// API server (for Stefan: NouStef, the same brain as Discord/OpenWebUI).
//
// The claude backend spawns a claude CLI per turn; here a turn is one HTTP call to the
// gateway's session-chat endpoint. The gateway persists the transcript (state.db), so
// session continuity is free: the Foreman stores nothing per character except inflight
// markers. Characters reach back into the Foreman through POST /agentcraft/tool
// (tools-server.ts), which the Foreman wires onto its HTTP server (server.ts).
//
// Job model mirrors agents/claude/index.ts: plan (lead), work (worker), review (lead),
// followup (user message / feedback / resume), one in-flight turn per character, per-turn
// timeout, nudges, CI loop, merge decisions, restart recovery.
import type { HermesConfig } from '../../config.js';
import { ClientError, type Backend, type Foreman } from '../../foreman.js';
import type { Decision, Goal, Task } from '../../protocol.js';
import { MERGE_OPTIONS } from '../../protocol.js';
import { renderDiffText } from '../../diff.js';
import { formatInbox } from '../../bus.js';
import { truncate } from '../../util/text.js';
import { userName } from '../../user.js';
import { characterSystemPrompt, planPrompt, RESUME_PROMPT, reviewPrompt, workPrompt, type PersonaContext } from './prompts.js';
import { createToolDispatcher, type ToolHooks } from './tools-server.js';

type JobKind = 'plan' | 'work' | 'review' | 'followup';

interface Job {
  kind: JobKind;
  agentId: string;
  prompt: string;
  /** extra instructions for followup turns (never shown in the feed) */
  note?: string;
  taskId?: string;
  goalId?: string;
  /** nudges already sent for this task (worker ended without update_task) */
  nudges?: number;
  resumed?: boolean;
}

interface Inflight {
  kind: JobKind;
  startedAt: number;
  taskId?: string;
  goalId?: string;
}

interface HermesState {
  inflight: Record<string, Inflight>;
  ciFixes: Record<string, number>;
  stopped: string[];
}

export interface HermesBackendOptions {
  /** injectable gateway base URL for tests (overrides cfg) */
  gateway?: (path: string, init: { method: string; body?: unknown; signal: AbortSignal }) => Promise<{ status: number; json: unknown }>;
}

const LEAD = 'marlow';

export class HermesBackend implements Backend {
  readonly name = 'hermes' as const;
  private queues = new Map<string, Job[]>();
  private running = new Map<string, { abort: AbortController; job: Job }>();
  private pausedJobs = new Map<string, Job>();
  private tickTimer: NodeJS.Timeout | undefined;
  private stopping = false;
  private authFailed: string | undefined;
  private readonly gateway: HermesBackendOptions['gateway'];
  /** exposed for main(): the tool dispatcher needs the same hooks */
  readonly toolHooks: ToolHooks;
  private sessions = new Map<string, boolean>(); // agentId -> session known to exist on the gateway
  private turnPromises = new Set<Promise<void>>();
  /** tasks whose CI + review hand-off is in progress */
  private reviewing = new Set<string>();
  private retryTimer: NodeJS.Timeout | undefined;
  private retryDelayMs = 2000;

  constructor(
    private fm: Foreman,
    private cfg: HermesConfig,
    private opts: HermesBackendOptions = {},
  ) {
    this.gateway = opts.gateway;
    this.toolHooks = {
      onReview: () => {
        /* handled after the worker's turn ends (CI then review) */
      },
      onChangesRequested: (taskId, feedback) => this.sendBackToWorker(taskId, `Marlow reviewed your work on ${taskId} and asks for changes:\n${feedback}\n\nMake the changes, re-run the tests, then update_task("${taskId}", status "review", summary).`),
      onTasksChanged: () => this.tick(),
      onMergeRequested: (taskId) => this.fm.log.info(`merge decision opened for ${taskId}`),
      onWaiting: () => {
        /* handled inside the tool dispatcher */
      },
    };
  }

  private get st(): HermesState {
    const b = this.fm.store.data.backend;
    let s = b.hermes as HermesState | undefined;
    if (!s) {
      s = { inflight: {}, ciFixes: {}, stopped: [] };
      b.hermes = s;
    }
    s.inflight ??= {};
    s.ciFixes ??= {};
    s.stopped ??= [];
    return s;
  }

  get team(): string[] {
    return this.fm.cast.filter((c) => c.role !== 'lead').map((c) => c.id);
  }

  // ---- gateway client ----------------------------------------------------------------------

  private personaCtx(): PersonaContext {
    const host = this.fm.status.backend === 'hermes' ? undefined : undefined; // no-op; url below
    void host;
    return { foremanUrl: this.foremanUrl(), token: this.token };
  }

  private foremanPort = 7878;
  private token: string | undefined;

  /** main() injects the real bind address + token before start(). */
  setEndpoint(port: number, token?: string): void {
    this.foremanPort = port;
    this.token = token;
  }

  private foremanUrl(): string {
    return `http://127.0.0.1:${this.foremanPort}`;
  }

  private sessionId(agentId: string): string {
    return `agentcraft-${this.fm.config.profile}-${agentId}`;
  }

  private async callGateway(path: string, init: { method: string; body?: unknown; signal: AbortSignal }): Promise<{ status: number; json: any }> {
    if (this.gateway) return this.gateway(path, init);
    const key = this.cfg.key;
    if (!key) throw new Error('no gateway key configured (set AGENTCRAFT_HERMES_KEY)');
    const res = await fetch(`${this.cfg.url}${path}`, {
      method: init.method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: init.signal,
    });
    const text = await res.text();
    let json: any = undefined;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      /* non-JSON error body */
    }
    return { status: res.status, json };
  }

  /** Ensure the character session exists on the gateway (idempotent; 409/exists is fine). */
  private async ensureSession(agentId: string, signal: AbortSignal): Promise<void> {
    if (this.sessions.get(agentId)) return;
    const role = agentId === LEAD ? 'lead' : 'worker';
    const persona = characterSystemPrompt(this.fm, agentId, role, this.personaCtx(), this.team);
    const res = await this.callGateway('/api/sessions', {
      method: 'POST',
      body: {
        id: this.sessionId(agentId),
        // titles are unique per gateway: include the profile so a second Foreman profile
        // does not collide with the first (the gateway refuses duplicate titles)
        title: `AgentCraft ${this.fm.nameOf(agentId)} (${this.fm.config.profile})`,
        system_prompt: persona,
      },
      signal,
    });
    if (res.status !== 201 && res.status !== 200 && res.status !== 409) {
      throw new Error(`gateway session create failed (${res.status}): ${truncate(JSON.stringify(res.json ?? ''), 200)}`);
    }
    this.sessions.set(agentId, true);
  }

  /** Run one character turn: POST the job prompt to the gateway, wait for the final text. */
  private async runTurn(agentId: string, prompt: string, signal: AbortSignal): Promise<{ text: string; error?: string }> {
    await this.ensureSession(agentId, signal);
    const persona = characterSystemPrompt(this.fm, agentId, agentId === LEAD ? 'lead' : 'worker', this.personaCtx(), this.team);
    const res = await this.callGateway(`/api/sessions/${this.sessionId(agentId)}/chat`, {
      method: 'POST',
      body: { message: prompt, system_message: persona },
      signal,
    });
    if (res.status === 404) {
      // session vanished on the gateway (wiped?): recreate and retry once
      this.sessions.delete(agentId);
      await this.ensureSession(agentId, signal);
      const retry = await this.callGateway(`/api/sessions/${this.sessionId(agentId)}/chat`, { method: 'POST', body: { message: prompt, system_message: persona }, signal });
      if (retry.status !== 200) return { text: '', error: `gateway chat failed (${retry.status}): ${truncate(JSON.stringify(retry.json ?? ''), 200)}` };
      return { text: String(retry.json?.message?.content ?? '') };
    }
    if (res.status !== 200) return { text: '', error: `gateway chat failed (${res.status}): ${truncate(JSON.stringify(res.json ?? ''), 200)}` };
    return { text: String(res.json?.message?.content ?? '') };
  }

  // ---- lifecycle --------------------------------------------------------------------------

  async start(): Promise<void> {
    if (!this.cfg.key) {
      this.authFailed = 'no gateway key: set AGENTCRAFT_HERMES_KEY to the API server key';
      this.fm.setStatus({ auth: 'failed', message: this.authFailed });
    } else {
      this.fm.setStatus({ auth: 'ok', message: `Hermes gateway (sessions at ${this.cfg.url})` });
    }
    for (const a of this.fm.agents()) {
      const onTeam = (a.id === LEAD || this.team.includes(a.id)) && !this.st.stopped.includes(a.id);
      this.fm.setAgent(a.id, { active: onTeam });
      if (!onTeam) this.fm.setAgent(a.id, { state: 'idle', station: 'lounge', activity: this.st.stopped.includes(a.id) ? 'stopped - off shift' : 'off shift' });
      else if (a.activity === 'off shift' || a.activity.startsWith('stopped')) this.fm.setAgent(a.id, { activity: 'ready' });
    }
    this.recover();
    this.fm.store.markDirty();
    this.tick();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.tickTimer) clearTimeout(this.tickTimer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    // abort in-flight gateway turns; the transcripts on the gateway survive and the next
    // start re-queues what was interrupted (inflight stays persisted)
    for (const r of this.running.values()) r.abort.abort();
    await Promise.race([Promise.allSettled([...this.turnPromises]), new Promise((r) => setTimeout(r, 4000))]);
    this.fm.store.markDirty();
  }

  /** After a restart: resume/re-queue everything that was in flight (mirror of claude's recover). */
  private recover(): void {
    const st = this.st;
    for (const d of this.fm.decisions.open().filter((x) => x.kind === 'permission')) this.fm.decisions.cancel(d.id, 'Foreman restarted');
    for (const [agentId, inf] of Object.entries(st.inflight)) {
      if (st.stopped.includes(agentId) || !this.fm.agent(agentId)) {
        delete st.inflight[agentId];
        continue;
      }
      const openQ = this.fm.decisions.open().find((x) => x.kind === 'question' && x.agentId === agentId);
      if (openQ) {
        this.fm.setAgent(agentId, { state: 'waiting_user', station: 'user', activity: 'waiting for your answer' });
        continue;
      }
      this.fm.log.info(`recover: resuming ${agentId} (${inf.kind}${inf.taskId ? ` ${inf.taskId}` : ''})`);
      this.enqueue({ kind: inf.kind === 'followup' ? 'followup' : inf.kind, agentId, prompt: RESUME_PROMPT, resumed: true, ...(inf.taskId ? { taskId: inf.taskId } : {}), ...(inf.goalId ? { goalId: inf.goalId } : {}) });
    }
    this.reconcile();
  }

  /** Bring planning goals, doing tasks and review tasks back in line with running/queued jobs. */
  private reconcile(): void {
    const st = this.st;
    for (const g of this.fm.goals().filter((x) => x.status === 'planning')) {
      const leadOnIt = st.inflight[LEAD]?.goalId === g.id || (this.queues.get(LEAD) ?? []).some((j) => j.goalId === g.id) || this.fm.decisions.open().some((d) => d.kind === 'question' && d.agentId === LEAD);
      if (leadOnIt || st.stopped.includes(LEAD)) continue;
      if (this.fm.tasks.forGoal(g.id).length) {
        this.fm.setGoal(g.id, { status: 'active' });
        this.tick();
      } else {
        const repo = g.repoId ? this.fm.repos.get(g.repoId) : undefined;
        if (!repo) continue;
        this.fm.log.info(`recover: re-planning ${g.id}`);
        this.enqueue({ kind: 'plan', agentId: LEAD, goalId: g.id, prompt: planPrompt(this.fm, g, repo.path, repo.branch) });
      }
    }
    for (const t of this.fm.tasks.list()) {
      if (t.status !== 'doing' || !t.assignee || t.assignee === LEAD) continue;
      const w = t.assignee;
      if (st.inflight[w]?.taskId === t.id || (this.queues.get(w) ?? []).some((j) => j.taskId === t.id)) continue;
      if (this.fm.decisions.open().some((d) => d.kind === 'question' && d.agentId === w && d.taskId === t.id)) continue;
      this.fm.log.info(`recover: ${t.id} was doing without a running turn; re-queued`);
      this.fm.tasks.setStatus(t.id, 'todo', { force: true });
      if (st.stopped.includes(w)) this.fm.tasks.update(t.id, { assignee: null });
    }
    this.sweepReviews();
  }

  private sweepReviews(): void {
    const st = this.st;
    for (const t of this.fm.tasks.list()) {
      if (t.status !== 'review' || !t.worktree) continue;
      if (this.fm.decisions.open().some((d) => d.taskId === t.id)) continue;
      if (Object.values(st.inflight).some((i) => i.taskId === t.id)) continue;
      if (this.reviewing.has(t.id) || (this.queues.get(LEAD) ?? []).some((j) => j.taskId === t.id) || (t.assignee && (this.queues.get(t.assignee) ?? []).some((j) => j.taskId === t.id))) continue;
      void this.afterWorkerDone(t.id);
    }
  }

  // ---- goals & scheduling -------------------------------------------------------------------

  async submitGoal(goal: Goal): Promise<void> {
    if (this.authFailed) {
      this.fm.setGoal(goal.id, { status: 'failed' });
      throw new ClientError(`Hermes backend is not available: ${this.authFailed}`);
    }
    const repo = this.fm.repos.require(goal.repoId!);
    const st = this.st;
    if (st.stopped.includes(LEAD)) {
      st.stopped = st.stopped.filter((x) => x !== LEAD);
      this.fm.bus.feed('system', 'Marlow is back on shift for the new goal', { agentId: LEAD });
    }
    for (const w of [LEAD, ...this.team]) if (!st.stopped.includes(w)) this.fm.setAgent(w, { active: true });
    this.fm.setAgent(LEAD, { state: 'thinking', station: 'meeting', activity: 'reading the goal', repoId: repo.id });
    this.enqueue({ kind: 'plan', agentId: LEAD, goalId: goal.id, prompt: planPrompt(this.fm, goal, repo.path, repo.branch) });
  }

  tick(): void {
    if (this.tickTimer || this.stopping) return;
    this.tickTimer = setTimeout(() => {
      this.tickTimer = undefined;
      this.schedule().catch((e) => {
        this.fm.log.error(`scheduler: ${(e as Error).stack ?? e}`);
        this.retryLater();
      });
    }, 50);
    this.tickTimer.unref?.();
  }

  private workersRunning(): number {
    return [...this.running.keys()].filter((id) => id !== LEAD).length;
  }

  private maxConcurrent = 3;

  /** main() injects the effective worker concurrency before start(). */
  setConcurrency(n: number): void {
    this.maxConcurrent = Math.max(1, n);
  }

  private isFree(w: string): boolean {
    const a = this.fm.agent(w);
    if (!a || !a.active || a.paused || st_stopped(this.st, w) || !this.team.includes(w)) return false;
    if (this.running.has(w) || (this.queues.get(w)?.length ?? 0) > 0) return false;
    return !this.fm.tasks.list().some((t) => t.assignee === w && t.status === 'doing');
  }

  private async schedule(): Promise<void> {
    if (this.authFailed || this.stopping) return;
    for (const goal of this.fm.goals().filter((g) => g.status === 'active')) {
      for (const t of this.fm.tasks.ready(goal.id)) {
        if (this.workersRunning() >= this.maxConcurrent) return;
        let w: string | undefined;
        if (t.assignee && this.team.includes(t.assignee) && !st_stopped(this.st, t.assignee)) {
          if (!this.isFree(t.assignee)) continue;
          w = t.assignee;
        } else {
          w = this.team.find((x) => this.isFree(x));
        }
        if (!w) continue;
        try {
          await this.startWork(w, t, goal);
          this.retryDelayMs = 2000;
        } catch (e) {
          this.fm.log.error(`could not start ${t.id} for ${w}: ${(e as Error).message}`);
          this.retryLater();
        }
      }
    }
    for (const id of this.queues.keys()) this.pump(id);
  }

  private async startWork(agentId: string, t: Task, goal: Goal): Promise<void> {
    if (!t.repoId) t.repoId = goal.repoId;
    this.fm.tasks.update(t.id, { assignee: agentId });
    let startPoint: string | undefined;
    let continuesFrom: string | undefined;
    const prev = t.worktree ? this.fm.repos.findWorktree(t.repoId!, t.worktree) : undefined;
    if (prev && prev.agentId !== agentId && prev.status !== 'merged') {
      if (prev.status === 'active') {
        await this.fm.repos.abandon(t.repoId!, prev.id, `agentcraft: ${t.id} work in progress (handed to ${this.fm.nameOf(agentId)})`).catch((e) => this.fm.log.warn(`abandon ${prev.id}: ${(e as Error).message}`));
      }
      if ((await this.fm.repos.commitsAhead(t.repoId!, prev.branch, prev.base)) > 0) {
        startPoint = prev.branch;
        continuesFrom = prev.agentId;
        this.fm.bus.feed('task', `${this.fm.nameOf(agentId)} continues ${t.id} from ${this.fm.nameOf(prev.agentId)}'s branch`, { agentId });
      }
    }
    const wt = await this.fm.repos.createWorktree(t.repoId!, agentId, t, startPoint ? { startPoint } : {});
    this.fm.tasks.update(t.id, { branch: wt.branch, worktree: wt.id });
    this.fm.tasks.setStatus(t.id, 'doing');
    this.fm.setAgent(agentId, { taskId: t.id, repoId: t.repoId!, worktree: wt.id, state: 'thinking', station: 'desk', activity: `starting ${t.id}` });
    this.fm.bus.feed('task', `${this.fm.nameOf(agentId)} started ${t.id}: ${t.title}`, { agentId });
    const inbox = formatInbox(this.fm.bus.inbox(agentId, { markRead: true }), (id) => this.fm.nameOf(id));
    this.enqueue({ kind: 'work', agentId, taskId: t.id, goalId: goal.id, prompt: workPrompt(this.fm, t, goal, wt, inbox, continuesFrom) });
  }

  private retryLater(): void {
    if (this.retryTimer || this.stopping) return;
    const delay = this.retryDelayMs;
    this.retryDelayMs = Math.min(60_000, this.retryDelayMs * 2);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      this.tick();
    }, delay);
    this.retryTimer.unref?.();
  }

  // ---- job queue ----------------------------------------------------------------------------

  private enqueue(job: Job): void {
    const q = this.queues.get(job.agentId) ?? [];
    q.push(job);
    this.queues.set(job.agentId, q);
    this.pump(job.agentId);
  }

  private pump(agentId: string): void {
    if (this.stopping || this.authFailed) return;
    if (this.running.has(agentId)) return;
    const a = this.fm.agent(agentId);
    if (!a || a.paused || !a.active || st_stopped(this.st, agentId)) return;
    const q = this.queues.get(agentId);
    if (!q?.length) return;
    if (agentId !== LEAD && this.workersRunning() >= this.maxConcurrent) return;
    const job = q.shift()!;
    const abort = new AbortController();
    const entry = { abort, job };
    this.running.set(agentId, entry);
    const p = this.runJob(job, abort).finally(() => {
      this.turnPromises.delete(p);
    });
    this.turnPromises.add(p);
  }

  private async runJob(job: Job, abort: AbortController): Promise<void> {
    const agentId = job.agentId;
    this.st.inflight[agentId] = { kind: job.kind, startedAt: Date.now(), ...(job.taskId ? { taskId: job.taskId } : {}), ...(job.goalId ? { goalId: job.goalId } : {}) };
    this.fm.store.markDirty();
    let text = '';
    let failed: string | undefined;
    try {
      this.fm.agentLog(agentId, 'text', `${job.resumed ? 'Resuming' : 'Starting'} ${job.kind}${job.taskId ? ` ${job.taskId}` : ''} (hermes)`);
      if (job.kind === 'followup') this.fm.agentLog(agentId, 'text', truncate(job.prompt, 400));
      const timer = setTimeout(() => abort.abort(), this.cfg.turnTimeoutMs);
      timer.unref?.();
      try {
        const out = await this.runTurn(agentId, job.prompt, abort.signal);
        text = out.text;
        failed = out.error;
      } finally {
        clearTimeout(timer);
      }
    } catch (e) {
      if (!abort.signal.aborted) {
        failed = (e as Error).message ?? String(e);
        this.fm.log.error(`${agentId} ${job.kind} failed: ${failed}`);
        this.fm.agentLog(agentId, 'error', `session error: ${truncate(failed, 400)}`);
      }
    } finally {
      this.running.delete(agentId);
    }
    if (abort.signal.aborted) return; // pause/stop/shutdown: runfile state stays as-is
    delete this.st.inflight[agentId];
    this.fm.store.markDirty();
    if (failed) {
      this.fm.setAgent(agentId, { state: 'error', activity: `turn failed: ${truncate(failed, 36)}`, ...(job.taskId ? { station: 'desk' as const } : {}) });
      if (job.kind === 'plan' && job.goalId) {
        const g = this.fm.goal(job.goalId);
        if (g?.status === 'planning') {
          this.fm.setGoal(g.id, { status: 'failed' });
          this.fm.bus.feed('error', `Marlow's planning turn failed: ${truncate(failed, 200)}`, { agentId: LEAD });
        }
      }
      this.pump(agentId);
      return;
    }
    this.fm.agentLog(agentId, 'result', truncate(text || '(no text)', 600));
    const status = /STATUS:\s*(.+)/.exec(text)?.[1]?.trim();
    if (status) this.fm.setAgent(agentId, { activity: truncate(status, 80) });
    await this.afterTurn(job, text).catch((e) => this.fm.log.error(`afterTurn ${agentId}: ${(e as Error).stack ?? e}`));
    this.pump(agentId);
    if (job.kind !== 'followup' || !job.resumed) this.deliverPending(agentId);
    this.tick();
  }

  // ---- after a turn -----------------------------------------------------------------------

  private async afterTurn(job: Job, text: string): Promise<void> {
    const fm = this.fm;
    if (job.agentId === LEAD) {
      const goal = job.goalId ? fm.goal(job.goalId) : undefined;
      if (goal && goal.status === 'planning') {
        const n = fm.tasks.forGoal(goal.id).length;
        if (n > 0) {
          fm.setGoal(goal.id, { status: 'active' });
          fm.bus.feed('plan', `Marlow planned the goal into ${n} task${n === 1 ? '' : 's'}`, { agentId: LEAD });
        } else if (job.kind === 'plan') {
          fm.setGoal(goal.id, { status: 'cancelled', progress: 0 });
          fm.bus.feed('goal', `Marlow planned no tasks: goal closed (${truncate(goal.text, 80)})`, { agentId: LEAD });
        }
      }
      fm.setAgent(LEAD, { state: 'idle', station: 'meeting', activity: 'watching the task wall' });
      return;
    }
    // worker
    const t = job.taskId ? fm.tasks.get(job.taskId) : undefined;
    if (!t) {
      fm.setAgent(job.agentId, { state: 'idle', station: 'lounge', activity: 'idle' });
      return;
    }
    if (t.status === 'review') {
      await this.afterWorkerDone(t.id);
      return;
    }
    if (t.status === 'doing') {
      const nudges = job.nudges ?? 0;
      if (nudges < 1) {
        this.enqueue({ ...job, kind: 'followup', nudges: nudges + 1, prompt: `You ended your turn but ${t.id} is still "doing". If the work is complete, call update_task("${t.id}", status "review", summary). If you are stuck, call update_task with status "blocked" and blocked_reason. Otherwise continue.` });
        return;
      }
      const wt = t.worktree && t.repoId ? fm.repos.findWorktree(t.repoId, t.worktree) : undefined;
      if (wt) await fm.repos.refresh(t.repoId!);
      if (wt && wt.files > 0) {
        fm.tasks.setStatus(t.id, 'review', { summary: truncate(text, 400) });
        await this.afterWorkerDone(t.id);
      } else {
        fm.tasks.setStatus(t.id, 'blocked', { reason: 'worker stopped without changes', force: true });
        fm.setAgent(job.agentId, { state: 'blocked', station: 'desk', activity: `${t.id} blocked` });
        fm.bus.send(job.agentId, LEAD, `${t.id} is blocked: ${fm.tasks.get(t.id)?.blockedReason}`);
      }
      return;
    }
    if (t.status === 'blocked') {
      fm.setAgent(job.agentId, { state: 'blocked', station: 'desk', activity: `${t.id} blocked` });
      return;
    }
    fm.setAgent(job.agentId, { state: 'idle', station: 'lounge', activity: 'idle' });
  }

  /** A worker finished a task: CI in the worktree, then lead review (or a merge decision). */
  private async afterWorkerDone(taskId: string): Promise<void> {
    if (this.reviewing.has(taskId)) return;
    this.reviewing.add(taskId);
    try {
      await this.ciThenReview(taskId);
    } finally {
      this.reviewing.delete(taskId);
    }
  }

  private async ciThenReview(taskId: string): Promise<void> {
    const fm = this.fm;
    const t = fm.tasks.get(taskId);
    if (!t || t.status !== 'review' || !t.repoId || !t.worktree) return;
    const worker = t.assignee;
    if (worker) fm.setAgent(worker, { state: 'idle', station: 'lounge', activity: `${t.id} in review` });
    let ci: { pass: boolean; command: string; output: string; durationMs: number } | undefined;
    try {
      fm.tasks.update(t.id, { ci: 'running' });
      fm.repos.setCi(t.repoId, 'running');
      if (worker) fm.agentLog(worker, 'tool', `CI: ${fm.repos.detectTestCommand(fm.repos.requireWorktree(t.repoId, t.worktree).path) ?? '(no tests)'}`);
      ci = await fm.repos.runTests(t.repoId, t.worktree, undefined);
      fm.tasks.update(t.id, { ci: ci.pass ? 'pass' : 'fail' });
      fm.repos.setCi(t.repoId, ci.pass ? 'pass' : 'fail');
      if (worker) fm.agentLog(worker, ci.pass ? 'result' : 'error', `CI ${ci.pass ? 'passed' : 'FAILED'} (${(ci.durationMs / 1000).toFixed(1)}s)\n${ci.output.split('\n').slice(-6).join('\n')}`);
      fm.bus.feed('ci', `${t.id}: tests ${ci.pass ? 'pass' : 'fail'} (${ci.command})`, { ...(worker ? { agentId: worker } : {}) });
    } catch (e) {
      fm.log.warn(`CI for ${t.id}: ${(e as Error).message}`);
    }
    await fm.repos.refresh(t.repoId);
    if (ci && !ci.pass && (this.st.ciFixes[t.id] ?? 0) < 1 && worker && !st_stopped(this.st, worker)) {
      this.st.ciFixes[t.id] = (this.st.ciFixes[t.id] ?? 0) + 1;
      this.sendBackToWorker(t.id, `CI failed for ${t.id} (${ci.command}):\n${ci.output}\n\nFix the failures, re-run the tests, then update_task("${t.id}", status "review", summary).`);
      return;
    }
    const diff = await fm.repos.diff(t.repoId, t.worktree);
    const summary = t.summary ?? 'Work complete.';
    const wt = fm.repos.requireWorktree(t.repoId, t.worktree);
    // this backend has no lead review session: surface the merge to the user directly,
    // with the diff summary as context (the lead reviewed nothing here)
    fm.createDecision({
      agentId: LEAD,
      kind: 'merge',
      question: `Merge ${t.id} "${t.title}" (${wt.branch}) into ${wt.base}?`,
      options: [...MERGE_OPTIONS],
      context: `${summary}\n${diff.stats.files} files, +${diff.stats.additions} -${diff.stats.deletions} | tests: ${t.ci}${worker ? `\nWork by ${fm.nameOf(worker)}` : ''}`,
      taskId: t.id,
      repoId: t.repoId,
      worktree: wt.id,
    });
    if (!st_stopped(this.st, LEAD)) fm.setAgent(LEAD, { state: 'idle', station: 'mergestation', activity: `awaiting your review of ${t.id}` });
  }

  /** Resume the worker's task "session" with feedback (lead/user changes, CI failure). */
  private sendBackToWorker(taskId: string, prompt: string): void {
    const t = this.fm.tasks.get(taskId);
    if (!t?.assignee) return;
    if (st_stopped(this.st, t.assignee)) {
      this.fm.tasks.setStatus(t.id, 'todo', { force: true, summary: truncate(prompt, 400) });
      this.fm.tasks.update(t.id, { assignee: null });
      this.tick();
      return;
    }
    if (t.status !== 'doing') this.fm.tasks.setStatus(t.id, 'doing', { force: true });
    this.fm.setAgent(t.assignee, { taskId: t.id, state: 'thinking', station: 'desk', activity: `revising ${t.id}`, ...(t.repoId ? { repoId: t.repoId } : {}), ...(t.worktree ? { worktree: t.worktree } : {}) });
    this.enqueue({ kind: 'followup', agentId: t.assignee, taskId: t.id, ...(t.goalId ? { goalId: t.goalId } : {}), prompt });
  }

  /** User messages that arrived after the character's last tool call: deliver as a followup. */
  private deliverPending(agentId: string): void {
    if (this.stopping || st_stopped(this.st, agentId) || this.running.has(agentId) || this.pausedJobs.has(agentId) || (this.queues.get(agentId)?.length ?? 0) > 0) return;
    const a = this.fm.agent(agentId);
    if (!a?.active || a.paused) return;
    const fromUser = this.fm.bus.inbox(agentId).filter((m) => m.from === 'user' && m.to === agentId);
    if (!fromUser.length) return;
    const body = fromUser.map((m) => m.text).join('\n\n');
    this.fm.log.info(`delivering ${fromUser.length} message(s) from ${userName()} to ${agentId}`);
    this.onUserMessage(agentId, body);
  }

  // ---- user intents -------------------------------------------------------------------------

  onUserMessage(to: string, text: string): void {
    const id = to === 'all' ? LEAD : to;
    const a = this.fm.agent(id);
    if (!a) return;
    if (st_stopped(this.st, id)) {
      this.fm.bus.send(id, 'user', `(${this.fm.nameOf(id)} is off shift - /resume @${id} to bring them back; your message is queued.)`);
      return;
    }
    if (this.running.has(id) || this.pausedJobs.has(id)) return; // rides along with the next tool result / turn
    const prompt = `Message from ${userName()}: ${text}\n\nRespond briefly with send_message(to "user") and act on it if needed (lead: create or update tasks; worker: adjust your work).`;
    this.enqueue({ kind: 'followup', agentId: id, prompt });
  }

  onDecisionSettled(_d: Decision): void {
    // ask_user_poll long-polls wake on their own via decisions.wait
  }

  onTaskAction(task: Task, action: string): void {
    this.fm.agentLog('marlow', 'text', `${userName()}: ${action} ${task.id} (${task.title}).`);
    if (action === 'retry') this.tick();
  }

  async onAgentAction(agentId: string, action: 'pause' | 'resume' | 'stop' | 'spawn', _arg?: string): Promise<void> {
    const st = this.st;
    if (action === 'pause') {
      this.running.get(agentId)?.abort.abort();
      const q = this.queues.get(agentId);
      const job = q?.shift();
      if (job) this.pausedJobs.set(agentId, job);
      this.fm.setAgent(agentId, { paused: true, state: 'idle', activity: 'paused' });
    } else if (action === 'resume' || action === 'spawn') {
      st.stopped = st.stopped.filter((x) => x !== agentId);
      this.fm.setAgent(agentId, { active: true, paused: false });
      const paused = this.pausedJobs.get(agentId);
      if (paused) {
        this.pausedJobs.delete(agentId);
        this.enqueue(paused);
      }
      this.fm.agentLog(agentId, 'text', 'Resumed.');
      this.tick();
    } else if (action === 'stop') {
      this.running.get(agentId)?.abort.abort();
      // any open question of this agent is moot now
      for (const d of this.fm.decisions.open().filter((x) => x.agentId === agentId && x.kind === 'question')) this.fm.decisions.cancel(d.id, `${this.fm.nameOf(agentId)}'s turn was stopped`);
      st.stopped = [...new Set([...st.stopped, agentId])];
      // its doing tasks go back to the board
      for (const t of this.fm.tasks.list()) {
        if (t.assignee === agentId && t.status === 'doing') {
          this.fm.tasks.setStatus(t.id, 'todo', { force: true });
          this.fm.tasks.update(t.id, { assignee: null });
        }
      }
      this.fm.setAgent(agentId, { active: false, paused: false, state: 'idle', station: 'lounge', activity: 'stopped - off shift', taskId: null, worktree: null });
      this.tick();
    }
  }
}

function st_stopped(st: HermesState, agentId: string): boolean {
  return st.stopped.includes(agentId);
}
