/**
 * App-level homebrew checks on top of the 5etools schema: things that would break indexing or the
 * app's own features (errors), and things that are probably mistakes (warnings): broken `{@tag}`
 * targets, unparseable dice and names that collide with existing content.
 */
import { CR_TO_XP, isObject, kindForProp, KINDS, parseDice, renderInline, type InlineRender } from '@cn/fivetools';
import type { HomebrewIssue } from '@cn/shared';
import type { IndexDb } from '../reference/index-db';

const MAX_TAG_CHECKS = 400;

/** Problems that block saving. */
export function appErrors(prop: string, data: unknown): HomebrewIssue[] {
  if (!isObject(data)) return [{ path: '', message: 'Entity must be a JSON object' }];
  const errors: HomebrewIssue[] = [];
  if (!kindForProp(prop) && prop !== 'subrace') errors.push({ path: '', message: `Unsupported type "${prop}"` });
  if (typeof data.name !== 'string' || !data.name.trim()) errors.push({ path: '/name', message: 'A name is required' });
  if (prop === 'monster' && data.cr !== undefined) {
    const cr = isObject(data.cr) ? data.cr.cr : data.cr;
    if (typeof cr !== 'string' || !(cr in CR_TO_XP)) errors.push({ path: '/cr', message: 'Challenge rating must be one of 0, 1/8, 1/4, 1/2, 1–30 (as text)' });
  }
  if (prop === 'spell' && data.level !== undefined && !(Number.isInteger(data.level) && (data.level as number) >= 0 && (data.level as number) <= 9)) {
    errors.push({ path: '/level', message: 'Spell level must be a whole number from 0 (cantrip) to 9' });
  }
  if (prop === 'subrace' && !data._copy && (typeof data.raceName !== 'string' || typeof data.raceSource !== 'string')) {
    errors.push({ path: '/raceName', message: 'A subrace needs raceName and raceSource (its parent race)' });
  }
  return errors;
}

/** Every string in an entity, with its JSON path. */
function* strings(value: unknown, path = ''): Generator<[string, string]> {
  if (typeof value === 'string') yield [path, value];
  else if (Array.isArray(value)) for (let i = 0; i < value.length; i++) yield* strings(value[i], `${path}/${i}`);
  else if (isObject(value)) for (const [k, v] of Object.entries(value)) if (!k.startsWith('_')) yield* strings(v, `${path}/${k}`);
}

function* walkInline(nodes: InlineRender[]): Generator<InlineRender> {
  for (const n of nodes) {
    yield n;
    if ('children' in n) yield* walkInline(n.children);
  }
}

/** Broken `{@tag}` targets and dice that cannot be rolled. */
export function tagWarnings(index: IndexDb, data: unknown, selfUid: string | null): HomebrewIssue[] {
  const exists = index.prepare('SELECT 1 FROM entity WHERE uid = ? UNION SELECT 1 FROM entity_alias WHERE alias_uid = ? LIMIT 1');
  const out: HomebrewIssue[] = [];
  const seen = new Set<string>();
  let checked = 0;
  for (const [path, str] of strings(data)) {
    if (!str.includes('{@')) continue;
    for (const node of walkInline(renderInline(str))) {
      if (++checked > MAX_TAG_CHECKS) return out;
      if (node.t === 'entity') {
        if (node.uid === selfUid || seen.has(node.uid)) continue;
        seen.add(node.uid);
        if (!exists.get(node.uid, node.uid)) {
          out.push({ path, message: `Unknown ${KINDS[node.kind].label.toLowerCase()} "${node.name}" (${node.source.toUpperCase()}): the link will not resolve` });
        }
      } else if (node.t === 'roll' && (node.mode === 'dice' || node.mode === 'damage') && !parseDice(node.expr)) {
        out.push({ path, message: `Dice expression "${node.expr}" cannot be rolled` });
      }
    }
  }
  return out;
}

/** Other entities of the same kind and name (a different source): probably intended, but worth knowing. */
export function collisionWarnings(index: IndexDb, prop: string, name: string, sourceJsonId: string): HomebrewIssue[] {
  const kind = kindForProp(prop === 'subrace' ? 'race' : prop);
  if (!kind || !name) return [];
  const rows = index
    .prepare('SELECT DISTINCT source_json FROM entity WHERE kind = ? AND name_lower = ? AND source != ? AND deleted = 0 ORDER BY source_json LIMIT 6')
    .all(kind, name.trim().toLowerCase(), sourceJsonId.toLowerCase()) as { source_json: string }[];
  if (!rows.length) return [];
  return [{ path: '/name', message: `A ${KINDS[kind].label.toLowerCase()} called "${name}" also exists in ${rows.map((r) => r.source_json).join(', ')}` }];
}
