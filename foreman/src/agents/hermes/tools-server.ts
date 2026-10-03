// Server-side dispatcher for POST /agentcraft/tool: the hermes characters' coordination
// tools. Semantics mirror the claude backend's MCP server (src/agents/claude/tools.ts);
// differences are inherent to the transport:
// - ask_user returns {decisionId} immediately; the character re-polls with ask_user_poll,
//   which long-polls on the DecisionQueue (the HTTP request waits up to ~110 s).
// - there is no in-process turn handle: an aborted character turn cannot be intercepted
//   here, so ask_user polls also check that the agent still has an open turn (the poll
//   returns cancelled if the decision was withdrawn).
import type { Foreman } from '../../foreman.js';
import { formatInbox } from '../../bus.js';
import { truncate } from '../../util/text.js';
import { MERGE_OPTIONS, type Decision, type TaskStatus } from '../../protocol.js';
import { userName } from '../../user.js';

export interface ToolCall {
  agentId: string;
  tool: string;
  args: Record<string, unknown>;
}

type ToolResult = { ok: true; result: Record<string, unknown> } | { ok: false; error: string };

const POLL_MS = 110_000;

const str = (v: unknown): string => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v));

export function createToolDispatcher(fm: Foreman, opts: { hooks: ToolHooks }): (call: ToolCall) => Promise<ToolResult> {
  const fail = (error: string): ToolResult => ({ ok: false, error });
  const withInbox = (agentId: string, result: Record<string, unknown>): ToolResult => {
    const inbox = fm.bus.inbox(agentId, { markRead: true });
    const extra = inbox.length ? { '[New messages]': formatInbox(inbox, (id) => fm.nameOf(id)) } : {};
    return { ok: true, result: { ...result, ...extra } };
  };

  return async (call: ToolCall): Promise<ToolResult> => {
    const { agentId, tool, args } = call;
    const agent = fm.agent(agentId);
    if (!agent) return fail(`no agent "${agentId}"`);
    if (!agent.active) return fail(`${fm.nameOf(agentId)} is off shift`);

    const lead = agentId === LEAD;
    switch (tool) {
      // ---- communication ---------------------------------------------------------------------
      case 'send_message': {
        let target = str(args.to).trim().toLowerCase();
        const text = str(args.text);
        if (!text) return fail('send_message needs text');
        if (target === 'lead') target = 'marlow';
        if (!['all', 'user'].includes(target)) {
          const id = fm.resolveAgentId(target);
          if (!id) return fail(`no teammate "${args.to}". Team: ${fm.agents().filter((a) => a.active).map((a) => a.id).join(', ')}`);
          target = id;
        }
        if (target === agentId) return fail('you cannot message yourself');
        fm.bus.send(agentId, target, text);
        if (lead && !['all', 'user'].includes(target) && !fm.agent(target)?.taskId) {
          return withInbox(agentId, {
            message: `Sent to ${target}, but ${fm.nameOf(target)} is not on a task, so they will only read it when their next task starts. To have ${fm.nameOf(target)} do something now, create a task for it with create_task (assignee "${target}").`,
          });
        }
        return withInbox(agentId, { message: `Sent to ${target}.` });
      }

      case 'ask_user': {
        const question = str(args.question);
        if (!question) return fail('ask_user needs question');
        const options = Array.isArray(args.options) ? args.options.map(str).filter(Boolean).slice(0, 6) : [];
        const d = fm.createDecision({
          agentId,
          kind: 'question',
          question,
          options,
          ...(typeof args.context === 'string' && args.context ? { context: args.context } : {}),
          ...(fm.agent(agentId)?.taskId ? { taskId: fm.agent(agentId)!.taskId } : {}),
        });
        fm.setAgent(agentId, { state: 'waiting_user', station: 'user', activity: 'waiting for your answer' });
        opts.hooks.onWaiting(agentId, true);
        return { ok: true, result: { decisionId: d.id, hint: 'poll ask_user_poll with this decisionId until it returns the answer' } };
      }

      case 'ask_user_poll': {
        const id = str(args.decisionId);
        const d = fm.decisions.get(id);
        if (!d || d.agentId !== agentId) return fail(`no open question ${id}`);
        if (d.status !== 'open') {
          opts.hooks.onWaiting(agentId, false);
          fm.setAgent(agentId, { state: 'thinking', station: lead ? 'meeting' : 'desk', activity: 'got your answer' });
          const ans = [d.answer?.option, d.answer?.text].filter(Boolean).join(' - ');
          return withInbox(agentId, d.status === 'answered' ? { answered: true, answer: ans } : { answered: false, cancelled: true, answer: '' });
        }
        const answered = await Promise.race([
          fm.decisions.wait(id),
          new Promise<never>((_, rej) => setTimeout(() => rej(new Error('poll-timeout')), POLL_MS)),
        ]).catch(() => undefined);
        if (!answered) return withInbox(agentId, { answered: false, timeout: true, decisionId: id, hint: 'call ask_user_poll again' });
        opts.hooks.onWaiting(agentId, false);
        fm.setAgent(agentId, { state: 'thinking', station: lead ? 'meeting' : 'desk', activity: 'got your answer' });
        if (answered.status === 'cancelled') return withInbox(agentId, { answered: false, cancelled: true, answer: '' });
        const ans = [answered.answer?.option, answered.answer?.text].filter(Boolean).join(' - ');
        return withInbox(agentId, { answered: true, answer: ans });
      }

      // ---- memory ----------------------------------------------------------------------------
      case 'write_memory': {
        const title = str(args.title);
        const body = str(args.body);
        if (!title || !body) return fail('write_memory needs title and body');
        const e = fm.memory.write({ scope: args.scope === 'private' ? agentId : 'shared', title, body, author: agentId, mode: args.mode === 'append' ? 'append' : 'replace' });
        fm.bus.feed('memory', `${fm.nameOf(agentId)} wrote memory: ${e.title}`, { agentId });
        return withInbox(agentId, { memoryId: e.id });
      }

      case 'read_memory': {
        const id = str(args.id);
        if (id) {
          const e = fm.memory.get(id) ?? fm.memory.get(`shared/${id}`) ?? fm.memory.get(`${agentId}/${id}`);
          if (!e || (e.scope !== 'shared' && e.scope !== agentId)) return fail(`no memory ${id}`);
          return withInbox(agentId, { memory: `# ${e.title} (${e.id})\n\n${e.body}` });
        }
        const query = str(args.query);
        const list = query ? fm.memory.search(query, agentId) : fm.memory.visibleTo(agentId);
        if (!list.length) return withInbox(agentId, { memory: 'No memory notes.' });
        if (query && list.length <= 3) return withInbox(agentId, { memory: list.map((e) => `# ${e.title} (${e.id})\n\n${truncate(e.body, 3000)}`).join('\n\n---\n\n') });
        return withInbox(agentId, { memory: list.map((e) => `- ${e.id}: ${e.title}`).join('\n') });
      }

      // ---- tasks -----------------------------------------------------------------------------
      case 'update_task': {
        const taskId = str(args.task_id);
        const t = fm.tasks.get(taskId);
        if (!t) return fail(`no task ${taskId}. ${fm.tasks.list().map((x) => `${x.id} [${x.status}] ${x.title}`).join('\n')}`);
        const isLead = lead;
        if (!isLead) {
          if (t.assignee !== agentId) return fail(`${t.id} is not your task`);
          const current = fm.agent(agentId)?.taskId;
          if (current && t.id !== current) return fail(`you are working on ${current}; you can only update that task. Tell Marlow (send_message to "lead") if ${t.id} is already covered.`);
          const s = str(args.status);
          if (s && !['review', 'blocked', 'doing'].includes(s)) return fail('workers can set status review, blocked or doing');
          if (args.assignee || args.title || args.description) return fail('only the lead can change assignee/title/description');
        }
        try {
          const summary = str(args.summary);
          const assignee = str(args.assignee);
          if (assignee) {
            const id = fm.resolveAgentId(assignee);
            if (!id) return fail(`no agent ${assignee}`);
            fm.tasks.update(t.id, { assignee: id });
          }
          if (str(args.title)) fm.tasks.update(t.id, { title: str(args.title) });
          if (str(args.description)) fm.tasks.update(t.id, { description: str(args.description) });
          if (summary) fm.tasks.update(t.id, { summary });
          const status = str(args.status);
          if (status && status !== t.status) {
            const prev = t.status;
            fm.tasks.setStatus(t.id, status as TaskStatus, { force: isLead || status === 'review', ...(str(args.blocked_reason) ? { reason: str(args.blocked_reason) } : {}), ...(summary ? { summary } : {}) });
            fm.bus.feed('task', `${fm.nameOf(agentId)}: ${t.id} ${prev} -> ${status}`, { agentId });
            if (status === 'review' && !isLead) opts.hooks.onReview(agentId, t.id);
            if (status === 'doing' && prev === 'review' && isLead) opts.hooks.onChangesRequested(t.id, summary || 'see review comments');
          }
          opts.hooks.onTasksChanged();
          return withInbox(agentId, { message: `Updated ${t.id}: ${fm.tasks.get(t.id)!.status}.` });
        } catch (e) {
          return fail((e as Error).message);
        }
      }

      case 'report_status': {
        const activity = str(args.activity).slice(0, 80);
        if (!activity) return fail('report_status needs activity');
        fm.setAgent(agentId, { activity });
        const note = str(args.note);
        if (note) fm.agentLog(agentId, 'text', note);
        return withInbox(agentId, { message: 'ok' });
      }

      case 'list_tasks':
        return withInbox(agentId, { board: fm.tasks.list().map((t) => `${t.id} [${t.status}] ${t.title}${t.assignee ? ` (${fm.nameOf(t.assignee)})` : ''}${t.deps.length ? ` deps: ${t.deps.join(', ')}` : ''}`).join('\n') || '(no tasks)' });

      // ---- lead only -------------------------------------------------------------------------
      case 'create_task': {
        if (!lead) return fail('only the lead can create_task');
        const title = str(args.title);
        const description = str(args.description);
        if (!title || !description) return fail('create_task needs title and description');
        let who: string | undefined;
        const assignee = str(args.assignee);
        if (assignee) {
          who = fm.resolveAgentId(assignee);
          if (!who) return fail(`no worker ${assignee}`);
          if (fm.agent(who)?.role === 'lead') return fail('assign tasks to workers, not yourself');
        }
        try {
          const goal = fm.currentGoal();
          const t = fm.tasks.create({
            title,
            description,
            deps: Array.isArray(args.deps) ? args.deps.map(str) : [],
            ...(who ? { assignee: who } : {}),
            ...(args.priority !== undefined ? { priority: Number(args.priority) || 0 } : {}),
            createdBy: agentId,
            ...(goal ? { goalId: goal.id } : {}),
            ...(goal?.repoId ? { repoId: goal.repoId } : {}),
          });
          fm.bus.feed('task', `Marlow created ${t.id}: ${t.title}`, { agentId });
          opts.hooks.onTasksChanged();
          return withInbox(agentId, { taskId: t.id });
        } catch (e) {
          return fail((e as Error).message);
        }
      }

      case 'request_merge': {
        if (!lead) return fail('only the lead can request_merge');
        const taskId = str(args.task_id);
        const t = fm.tasks.get(taskId);
        if (!t) return fail(`no task ${taskId}`);
        if (t.status !== 'review') return fail(`${t.id} is ${t.status}, not in review`);
        if (!t.worktree || !t.repoId) return fail(`${t.id} has no worktree to merge`);
        const open = fm.decisions.open().find((d) => d.kind === 'merge' && d.taskId === t.id);
        if (open) return withInbox(agentId, { message: `Merge decision ${open.id} for ${t.id} is already waiting for ${userName()}.` });
        if (await closeIfNoChanges(fm, t.id)) {
          opts.hooks.onTasksChanged();
          return withInbox(agentId, { message: `${t.id} changed no files, so there is nothing to merge: it is closed as done. Tell ${userName()} the result with send_message if you have not yet.` });
        }
        const wt = fm.repos.requireWorktree(t.repoId, t.worktree);
        const d = fm.createDecision({
          agentId,
          kind: 'merge',
          question: `Merge ${t.id} "${t.title}" (${wt.branch}) into ${wt.base}?`,
          options: [...MERGE_OPTIONS],
          context: `${str(args.summary) || t.summary || 'Work complete.'}\n${wt.files} files, +${wt.additions} -${wt.deletions} | tests: ${t.ci}`,
          taskId: t.id,
          repoId: t.repoId,
          worktree: wt.id,
        });
        opts.hooks.onMergeRequested(t.id, d);
        return withInbox(agentId, { decisionId: d.id });
      }

      default:
        return fail(`unknown tool "${tool}" (tools: send_message, ask_user, ask_user_poll, write_memory, read_memory, update_task, report_status, list_tasks${lead ? ', create_task, request_merge' : ''})`);
    }
  };
}

const LEAD = 'marlow';

// ---- shared helpers (duplicated deliberately: the claude one lives behind the SDK import) -------

/**
 * A task in review that changed no files (a report) has nothing to merge: close it as done
 * (worktree abandoned) instead of asking the user to approve an empty merge.
 */
async function closeIfNoChanges(fm: Foreman, taskId: string): Promise<boolean> {
  const t = fm.tasks.get(taskId);
  if (!t || t.status !== 'review' || !t.repoId || !t.worktree) return false;
  await fm.repos.refresh(t.repoId);
  const wt = fm.repos.findWorktree(t.repoId, t.worktree);
  if (!wt || wt.status !== 'active' || wt.files > 0) return false;
  await fm.repos.abandon(t.repoId, wt.id, `agentcraft: ${t.id} (no changes)`);
  fm.tasks.setStatus(t.id, 'done', { force: true, summary: t.summary ?? 'no changes' });
  fm.bus.feed('task', `${t.id} changed no files (report only): closed as done, nothing to merge`, { agentId: t.assignee ?? 'marlow' });
  if (t.assignee && fm.agent(t.assignee)?.taskId === t.id) fm.setAgent(t.assignee, { state: 'idle', station: 'lounge', activity: `${t.id} done`, taskId: null, worktree: null });
  return true;
}

export interface ToolHooks {
  onReview(agentId: string, taskId: string): void;
  onChangesRequested(taskId: string, feedback: string): void;
  onTasksChanged(): void;
  onMergeRequested(taskId: string, decision: Decision): void;
  onWaiting(agentId: string, waiting: boolean): void;
}
