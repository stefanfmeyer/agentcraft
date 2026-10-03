import { describe, expect, test } from 'vitest';
import { makeForeman, tempDir } from './helpers.js';
import { pickIdentity, idFromName } from '../src/cast.js';

describe('dynamic cast (one character per session)', () => {
  test('create adds a parked character with a fresh identity', async () => {
    const h = makeForeman(tempDir());
    await h.fm.agentAction('', 'create');
    const created = h.fm.agents().find((a) => a.activity.startsWith('new'));
    expect(created).toBeTruthy();
    expect(created!.role).toBe('worker');
    expect(created!.active).toBe(false); // parked until /spawn
    expect(h.fm.cast.some((c) => c.id === created!.id)).toBe(true);
    // base cast ids are never reused
    expect(['marlow', 'juniper', 'kit', 'wren', 'rowan', 'tove']).not.toContain(created!.id);
  });

  test('every created character gets a unique id and color', async () => {
    const h = makeForeman(tempDir());
    for (let i = 0; i < 3; i++) await h.fm.agentAction('', 'create');
    const dyn = h.fm.agents().filter((a) => a.activity.startsWith('new'));
    expect(dyn.length).toBe(3);
    expect(new Set(dyn.map((a) => a.id)).size).toBe(3);
    expect(new Set(dyn.map((a) => a.color)).size).toBe(3);
  });

  test('created characters survive a Foreman restart', async () => {
    const home = tempDir();
    const h = makeForeman(home);
    await h.fm.agentAction('', 'create');
    const id = h.fm.agents().find((a) => a.activity.startsWith('new'))!.id;
    h.fm.store.flush(); // the write is debounced; force it before "restarting"
    const h2 = makeForeman(home); // same --home -> same profile state dir
    expect(h2.fm.agent(id)).toBeTruthy();
    expect(h2.fm.agent(id)!.active).toBe(false);
    expect(h2.fm.cast.some((c) => c.id === id)).toBe(true);
  });

  test('park -> spawn round trip keeps the character', async () => {
    const h = makeForeman(tempDir());
    await h.fm.agentAction('kit', 'stop');
    expect(h.fm.agent('kit')!.active).toBe(false);
    await h.fm.agentAction('kit', 'spawn');
    expect(h.fm.agent('kit')!.active).toBe(true);
  });

  test('pickIdentity skips used names and returns stable ids', () => {
    const used = ['sable', 'kit', 'marlow'];
    const p = pickIdentity(used, 0);
    expect(used).not.toContain(p.id);
    expect(p.id).toBe(idFromName(p.name));
    expect(p.color).toMatch(/^#[0-9A-Fa-f]{6}$/);
  });
});
