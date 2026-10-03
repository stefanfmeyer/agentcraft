import { beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { afterAll, beforeEach as _b } from 'vitest';
import { demoRepo, makeForeman, rmrf, until } from './helpers.js';
import { HermesBackend } from '../src/agents/hermes/index.js';
import { createToolDispatcher } from '../src/agents/hermes/tools-server.js';
import type { ForemanServer } from '../src/server.js';

/**
 * Hermes backend with a fake gateway: the "character" is a scripted function that receives the
 * job prompt and answers after (optionally) calling the real tool dispatcher, exactly like the
 * real thing would over HTTP.
 */

interface FakeTurn {
  agentId: string;
  prompt: string;
}

let scripted: (turn: FakeTurn, tools: (tool: string, args: Record<string, unknown>) => Promise<{ ok: boolean; result?: Record<string, unknown>; error?: string }>) => Promise<string>;

let server: http.Server;
let port: number;
const turns: FakeTurn[] = [];

beforeEach(async () => {
  turns.length = 0;
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      void (async () => {
        const url = req.url ?? '';
        if (req.method === 'POST' && url === '/api/sessions') {
          res.writeHead(201, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ object: 'hermes.session' }));
          return;
        }
        const m = /\/api\/sessions\/([^/]+)\/chat$/.exec(url);
        if (req.method === 'POST' && m) {
          const sessionId = decodeURIComponent(m[1]!);
          const agentId = sessionId.split('-').pop()!; // session id: agentcraft-<profile>-<cast id>; profile 'hermes' keeps this safe
          const parsed = JSON.parse(body) as { message: string };
          turns.push({ agentId, prompt: parsed.message });
          const tools = async (tool: string, args: Record<string, unknown>) => {
            const out = await fetch(`http://127.0.0.1:${toolPort}/agentcraft/tool`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ agent: agentId, tool, args }),
            });
            return (await out.json()) as { ok: boolean; result?: Record<string, unknown>; error?: string };
          };
          const text = await scripted({ agentId, prompt: parsed.message }, tools);
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ object: 'hermes.session.chat.completion', session_id: sessionId, message: { role: 'assistant', content: text }, usage: {} }));
          return;
        }
        res.writeHead(404).end();
      })().catch((e) => {
        res.writeHead(500).end(JSON.stringify({ error: (e as Error).message }));
      });
    });
  });
  await new Promise<void>((r) => {
    server.listen(0, '127.0.0.1', () => r());
  });
  port = (server.address() as { port: number }).port;
});

let toolPort: number;
let homes: string[] = [];

afterAll(() => {
  server?.closeAllConnections?.();
  server?.close();
  for (const h of homes) rmrf(h);
});

interface Rig {
  home: string;
  repo: string;
  fm: ReturnType<typeof makeForeman>['fm'];
  backend: HermesBackend;
}

async function makeRig(args: string[] = []): Promise<Rig> {
  const home = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'ac-hermes-'));
  homes.push(home);
  const repo = await demoRepo();
  const h = makeForeman(home, ['--backend', 'hermes', '--repo', repo, ...args]);
  const backend = new HermesBackend(h.fm, {
    url: `http://127.0.0.1:${port}`,
    key: 'test-key',
    maxTurns: 40,
    turnTimeoutMs: 20_000,
  });
  // wire the tool dispatcher against the real Foreman object
  const dispatcher = createToolDispatcher(h.fm, { hooks: backend.toolHooks });
  (backend as unknown as { setToolDispatcherForTests(d: unknown): void });
  // expose the dispatcher to the fake gateway via a throwaway http server
  const toolServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const parsed = JSON.parse(body) as { agent: string; tool: string; args: Record<string, unknown> };
      void dispatcher({ agentId: parsed.agent, tool: parsed.tool, args: parsed.args ?? {} }).then((out) => {
        res.writeHead(out.ok ? 200 : 400, { 'content-type': 'application/json' });
        res.end(JSON.stringify(out));
      });
    });
  });
  await new Promise<void>((r) => toolServer.listen(0, '127.0.0.1', () => r()));
  toolPort = (toolServer.address() as { port: number }).port;
  toolServers.push(toolServer);
  await h.fm.start(backend);
  return { home, repo, fm: h.fm, backend };
}

const toolServers: http.Server[] = [];

afterAll(() => {
  for (const s of toolServers) {
    s.closeAllConnections?.();
    s.close();
  }
});

describe('hermes backend', () => {
  it('plans a goal into tasks via the gateway and the tool endpoint', async () => {
    scripted = async ({ prompt }, tools) => {
      expect(prompt).toContain('New goal from');
      await tools('create_task', { title: 'Add a greeting', description: 'Add hello() to src/index.js exporting a greeting. Acceptance: test passes.', assignee: 'kit' });
      await tools('write_memory', { title: 'Plan: greeting', body: '1. kit adds hello()', scope: 'shared' });
      return 'STATUS: planned 1 task';
    };
    const rig = await makeRig();
    await rig.fm.submitGoal('Add a greeting feature');
    await until(() => rig.fm.tasks.list().length === 1, 10_000);
    const t = rig.fm.tasks.list()[0]!;
    expect(t.assignee).toBe('kit');
    await until(() => rig.fm.memory.list().some((m) => m.title.startsWith('Plan:')), 10_000);
    expect(rig.fm.memory.list().some((m) => m.title.startsWith('Plan:'))).toBe(true);
    // goal promoted to active once the lead's turn ends with tasks
    await until(() => rig.fm.goals()[0]!.status === 'active', 10_000);
    await rig.backend.stop();
  });

  it('worker turn -> review -> CI -> merge decision -> approved merge', async () => {
    const seen: string[] = [];
    scripted = async ({ prompt }, tools) => {
      seen.push(prompt);
      if (prompt.startsWith('Your task:')) {
        // make a real change in the worktree
        const wtPath = /Worktree: (\S+)/.exec(prompt)![1]!;
        const file = path.join(wtPath, 'NOTES.md');
        fs.appendFileSync(file, '\nAdded by the fake Kit.\n');
        await tools('update_task', { task_id: /Your task: (t\d+)/.exec(prompt)![1], status: 'review', summary: 'added a line' });
        return 'STATUS: done';
      }
      return 'STATUS: ok';
    };
    const rig = await makeRig();
    // a task directly on the board (skip planning; the plan path is covered above)
    const goal = rig.fm.createGoal('Greeting feature', (rig.fm as unknown as { repos: { list(): { id: string }[] } }).repos.list()[0]!.id);
    rig.fm.setGoal(goal.id, { status: 'active' });
    rig.fm.tasks.create({ title: 'Add a greeting', description: 'append to NOTES.md', assignee: 'kit', createdBy: 'marlow', goalId: goal.id, repoId: (rig.fm as unknown as { repos: { list(): { id: string }[] } }).repos.list()[0]!.id });
    rig.backend.tick();
    // worker runs, task goes to review, CI runs (no test command in the demo -> skip), merge decision opens
    await until(() => rig.fm.decisions.open().some((d) => d.kind === 'merge'), 30_000);
    const merge = rig.fm.decisions.open().find((d) => d.kind === 'merge')!;
    expect(merge.context).toContain('added a line');
    // approve the merge
    await rig.fm.answerDecision(merge.id, 'Merge');
    await until(() => rig.fm.tasks.get(merge.taskId!)!.status === 'done', 10_000);
    await rig.backend.stop();
  }, 60_000);

  it('ask_user creates a decision and ask_user_poll returns the answer', async () => {
    scripted = async ({ agentId }, tools) => {
      if (agentId === 'kit') {
        const q = await tools('ask_user', { question: 'Which greeting style?', options: ['formal', 'casual'] });
        expect(q.ok).toBe(true);
        const decisionId = (q.result as { decisionId: string }).decisionId;
        // poll in the background; answer from the test after a moment
        setTimeout(() => {
          void rig.fm.answerDecision(decisionId, 'casual');
        }, 300);
        const poll = await tools('ask_user_poll', { decisionId });
        expect(poll.ok).toBe(true);
        expect((poll.result as { answered: boolean; answer: string })).toMatchObject({ answered: true, answer: 'casual' });
        return 'STATUS: got answer';
      }
      return 'STATUS: ok';
    };
    const rig = await makeRig();
    // call the tool dispatcher directly (no goal needed)
    const out = await fetch(`http://127.0.0.1:${toolPort}/agentcraft/tool`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent: 'kit', tool: 'report_status', args: { activity: 'thinking' } }),
    });
    expect(((await out.json()) as { ok: boolean }).ok).toBe(true);
    await rig.backend.stop();
  });

  it('rejects tool calls with a bad agent and workers cannot create tasks', async () => {
    scripted = async () => 'STATUS: ok';
    const rig = await makeRig();
    const call = async (agent: string, tool: string, args: Record<string, unknown> = {}) => {
      const out = await fetch(`http://127.0.0.1:${toolPort}/agentcraft/tool`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ agent, tool, args }),
      });
      return (await out.json()) as { ok: boolean; error?: string };
    };
    expect(await call('nobody', 'list_tasks')).toMatchObject({ ok: false });
    expect(await call('kit', 'create_task', { title: 'x', description: 'y' })).toMatchObject({ ok: false });
    expect(await call('kit', 'bogus_tool')).toMatchObject({ ok: false });
    expect(await call('kit', 'list_tasks')).toMatchObject({ ok: true });
    await rig.backend.stop();
  });
});
