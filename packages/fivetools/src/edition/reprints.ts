/**
 * Reprint groups: connected components over `reprintedAs` links (string `Name|SRC` or `{uid, tag}` form).
 * Lists show one member per group; the rest stay reachable and show an "also printed as" link.
 */
import { entityUid, KINDS, type EntityKind } from '../kinds';
import { parseEntityTag } from '../tags/registry';
import { splitTagArgs } from '../tags/tokenize';
import { isObject } from '../util/object';
import { normalizeKey } from '../util/string';
import type { EditionOrAny } from './sources';
import { isEditionCompatible, type CampaignPolicy } from './policy';

/** Resolves one `reprintedAs` element of an entity of `kind` into a target entity uid. */
export function reprintTargetUid(kind: EntityKind, ref: unknown): string | null {
  if (typeof ref === 'string') {
    const parsed = parseEntityTag(KINDS[kind].tag ?? kind, splitTagArgs(ref));
    if (parsed) return entityUid(parsed.kind, parsed.identity);
    const [name, source] = ref.split('|');
    return name && source ? entityUid(kind, `${normalizeKey(name)}|${normalizeKey(source)}`) : null;
  }
  if (isObject(ref) && typeof ref.uid === 'string') {
    const tag = typeof ref.tag === 'string' ? ref.tag : (KINDS[kind].tag ?? kind);
    const parsed = parseEntityTag(tag, splitTagArgs(ref.uid));
    return parsed ? entityUid(parsed.kind, parsed.identity) : null;
  }
  return null;
}

class UnionFind {
  private parent = new Map<string, string>();
  find(x: string): string {
    let root = x;
    while (this.parent.has(root) && this.parent.get(root) !== root) root = this.parent.get(root)!;
    // path compression
    let cur = x;
    while (this.parent.has(cur) && this.parent.get(cur) !== root) {
      const next = this.parent.get(cur)!;
      this.parent.set(cur, root);
      cur = next;
    }
    if (!this.parent.has(root)) this.parent.set(root, root);
    return root;
  }
  union(a: string, b: string) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb);
  }
}

export interface ReprintEdge {
  from: string;
  to: string;
}

/**
 * Reprint edges for a set of resolved entities. `_versions` variants are skipped: they inherit their
 * parent's `reprintedAs` (via `_preserve`), which would wrongly merge e.g. "Mage (Familiar)" into Mage's group.
 */
export function reprintEdges(entities: { uid: string; kind: EntityKind; data: Record<string, unknown> }[]): ReprintEdge[] {
  const edges: ReprintEdge[] = [];
  for (const e of entities) {
    if (e.data._versionBase_isVersion) continue;
    const list = Array.isArray(e.data.reprintedAs) ? e.data.reprintedAs : [];
    for (const ref of list) {
      const to = reprintTargetUid(e.kind, ref);
      if (to) edges.push({ from: e.uid, to });
    }
  }
  return edges;
}

export interface ReprintInfo {
  /** Group id (stable: the lexicographically smallest member uid) for every entity in a group of 2+. */
  groupOf: Map<string, string>;
  /** Generation: 0 for originals, n+1 for reprints of generation n (longest path). Newer = higher. */
  generation: Map<string, number>;
}

/** Builds reprint groups. Edges to unknown uids are ignored (the target may be in an unloaded source). */
export function buildReprintGroups(edges: ReprintEdge[], knownUids: ReadonlySet<string>): ReprintInfo {
  const uf = new UnionFind();
  const outgoing = new Map<string, string[]>();
  for (const { from, to } of edges) {
    if (!knownUids.has(from) || !knownUids.has(to) || from === to) continue;
    uf.union(from, to);
    outgoing.set(from, [...(outgoing.get(from) ?? []), to]);
  }

  const groupOf = new Map<string, string>();
  for (const uid of new Set([...outgoing.keys(), ...[...outgoing.values()].flat()])) groupOf.set(uid, uf.find(uid));

  // Longest-path generation via DFS with cycle protection
  const generation = new Map<string, number>();
  const incoming = new Map<string, string[]>();
  for (const [from, tos] of outgoing) for (const to of tos) incoming.set(to, [...(incoming.get(to) ?? []), from]);
  const visiting = new Set<string>();
  const gen = (uid: string): number => {
    const cached = generation.get(uid);
    if (cached != null) return cached;
    if (visiting.has(uid)) return 0;
    visiting.add(uid);
    const parents = incoming.get(uid) ?? [];
    const value = parents.length ? Math.max(...parents.map(gen)) + 1 : 0;
    visiting.delete(uid);
    generation.set(uid, value);
    return value;
  };
  for (const uid of groupOf.keys()) gen(uid);
  return { groupOf, generation };
}

export interface ReprintMember {
  uid: string;
  edition: EditionOrAny;
  generation: number;
}

/**
 * Picks the member a campaign lists: in-edition members first, then the newest generation, then uid order.
 * Callers pass only the members visible to the campaign.
 */
export function pickRepresentative(members: ReprintMember[], policy: CampaignPolicy): string | null {
  if (!members.length) return null;
  const sorted = [...members].sort((a, b) => {
    const ea = isEditionCompatible(a.edition, policy) ? 0 : 1;
    const eb = isEditionCompatible(b.edition, policy) ? 0 : 1;
    if (ea !== eb) return ea - eb;
    if (a.generation !== b.generation) return b.generation - a.generation;
    return a.uid < b.uid ? -1 : 1;
  });
  return sorted[0]!.uid;
}
