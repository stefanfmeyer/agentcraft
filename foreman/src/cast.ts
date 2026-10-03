// The shared cast: the fixed lead (marlow) + placeholder workers, PLUS any dynamic
// characters persisted in the Foreman state (agent.create - see foreman.ts agentAction).
//
// Dynamic agents live in `store.data.dynamicCast` and are patched in by
// Foreman.initRoster AFTER the placeholder cast so restarts keep them. The art track can
// still override placeholder identity via assets-src/cast.json (unchanged).
import fs from 'node:fs';
import path from 'node:path';
import type { AgentRole } from './protocol.js';

export interface CastMember {
  id: string;
  name: string;
  role: AgentRole;
  title: string;
  color: string;
  accent?: string;
  description: string;
}

export const LEAD_ID = 'marlow';
export const WORKER_IDS = ['juniper', 'kit', 'wren', 'rowan', 'tove'] as const;

const PLACEHOLDER: CastMember[] = [
  { id: 'marlow', name: 'Marlow', role: 'lead', title: 'Lead', color: '#D97757', accent: '#3B2A20', description: 'Plans the work, splits it into tasks, reviews and asks you when it matters.' },
  { id: 'juniper', name: 'Juniper', role: 'worker', title: 'Worker', color: '#8FA98B', accent: '#F4EFE6', description: 'Careful generalist; likes CLIs and UX details.' },
  { id: 'kit', name: 'Kit', role: 'worker', title: 'Worker', color: '#2FA3A0', accent: '#1F1E1D', description: 'Fast backend tinkerer; writes the tests first.' },
  { id: 'wren', name: 'Wren', role: 'worker', title: 'Worker', color: '#C9A227', accent: '#3B2A20', description: 'Front-of-house polish: output, colors, docs.' },
  { id: 'rowan', name: 'Rowan', role: 'worker', title: 'Worker', color: '#B4553A', accent: '#E9E1D3', description: 'Documentation and release hygiene.' },
  { id: 'tove', name: 'Tove', role: 'worker', title: 'Worker', color: '#6F8FB5', accent: '#F4EFE6', description: 'Performance and tooling.' },
];

// identity colors drawn from the cast.json blue-violet-magenta arc (205-330 deg), avoiding
// the status palette; checked >= 18 CIEDE2000 from every other identity colour (gen/cast_check.py)
const DYNAMIC_COLORS = [
  '#5B4FE9', // indigo-violet
  '#9333EA', // purple
  '#C026D3', // fuchsia
  '#7C3AED', // violet
  '#2563EB', // cobalt
  '#DB2777', // magenta-pink
  '#4F46E5', // indigo
  '#A21CAF', // purple-magenta
  '#1D4ED8', // deep blue
  '#86198F', // dark fuchsia
  '#4338CA', // deep indigo
  '#9D174D', // dark magenta
];

/** One-per-identity name pool: cozy, unisex names in the same register as the base cast. */
const DYNAMIC_NAMES = [
  'Sable', 'Alden', 'Prynn', 'Oskar', 'Maple', 'Cove', 'Fen', 'Hollis', 'Isla', 'Bram',
  'Sorrel', 'Nell', 'Otter', 'Pike', 'Quill', 'Rook', 'Sylvie', 'Tam', 'Umber', 'Vetch',
  'Willow', 'Yarrow', 'Ash', 'Birch', 'Clover', 'Dill', 'Elder', 'Flint', 'Gale', 'Heather',
  'Ivo', 'Juno', 'Lark', 'Moss', 'Noor', 'Opal', 'Reed', 'Skylar', 'Thorn', 'Vale',
];

/** Stable worker id from a name: lowercase, ascii-ish. */
export function idFromName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 24);
}

/** Pick a fresh name + color for a new character (skips used ids). Deterministic order. */
export function pickIdentity(usedIds: string[], count: number): { name: string; id: string; color: string } {
  const used = new Set(usedIds);
  let name: string | undefined;
  for (const n of DYNAMIC_NAMES) {
    if (!used.has(idFromName(n))) {
      name = n;
      break;
    }
  }
  name ??= `Worker ${count + 1}`;
  const color = DYNAMIC_COLORS[count % DYNAMIC_COLORS.length]!;
  return { name: name as string, id: idFromName(name), color };
}

const HEX = /^#[0-9A-Fa-f]{6}$/;

export function loadCast(projectRoot: string | undefined): { cast: CastMember[]; source: string } {
  const file = projectRoot ? path.join(projectRoot, 'assets-src', 'cast.json') : undefined;
  if (!file || !fs.existsSync(file)) return { cast: PLACEHOLDER, source: 'placeholder' };
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    // accepted shapes: [...], {agents:[...]}, {cast:[...]}
    const obj = raw as { agents?: unknown; cast?: unknown };
    const arr = Array.isArray(raw) ? raw : Array.isArray(obj.agents) ? obj.agents : Array.isArray(obj.cast) ? obj.cast : [];
    const byId = new Map<string, Record<string, unknown>>();
    for (const r of arr as Array<Record<string, unknown>>) if (typeof r?.id === 'string') byId.set(r.id, r);
    const cast = PLACEHOLDER.map((p) => {
      const r = byId.get(p.id);
      if (!r) return p;
      const title =
        typeof r.title === 'string' && r.title ? r.title : typeof r.role === 'string' && !['lead', 'worker'].includes(r.role) ? r.role : p.title;
      return {
        ...p,
        name: typeof r.name === 'string' && r.name ? r.name : p.name,
        title,
        color: typeof r.color === 'string' && HEX.test(r.color) ? r.color : p.color,
        accent: typeof r.accent === 'string' && HEX.test(r.accent) ? r.accent : p.accent,
        description: typeof r.description === 'string' ? r.description : p.description,
      } satisfies CastMember;
    });
    return { cast, source: file };
  } catch {
    return { cast: PLACEHOLDER, source: 'placeholder (cast.json unreadable)' };
  }
}
