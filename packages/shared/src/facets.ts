/**
 * Typed facets: type-specific data stored 1:1 with a page (decision: "page + typed facet").
 * Field descriptors drive both server validation and the web forms; facet fields also act as built-in
 * properties for query blocks (milestone d).
 */
import { z } from 'zod';
import type { PageType } from './pages';

const pageId = z.string().max(64).nullable().default(null);
const uid = z.string().max(300).nullable().default(null);

export const ABILITY_KEYS = ['str', 'dex', 'con', 'int', 'wis', 'cha'] as const;

export const FACET_SCHEMAS = {
  npc: z.object({
    statblockUid: uid,
    statblockHomebrewEntityId: z.string().max(64).nullable().default(null),
    factionPageId: pageId,
    locationPageId: pageId,
    status: z.enum(['alive', 'dead', 'missing', 'unknown']).default('alive'),
    attitude: z.enum(['friendly', 'neutral', 'hostile', 'unknown']).default('neutral'),
    role: z.string().max(200).default(''),
  }),
  location: z.object({
    parentLocationPageId: pageId,
    kind: z.enum(['world', 'region', 'settlement', 'site', 'room', 'other']).default('site'),
    mapImage: z.string().max(512).nullable().default(null),
  }),
  session: z.object({
    number: z.number().int().min(0).max(100000).nullable().default(null),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().default(null),
    status: z.enum(['planned', 'played']).default('planned'),
    summary: z.string().max(2000).default(''),
  }),
  quest: z.object({
    status: z.enum(['rumor', 'active', 'completed', 'failed', 'abandoned']).default('rumor'),
    giverPageId: pageId,
    priority: z.enum(['low', 'normal', 'high']).default('normal'),
  }),
  faction: z.object({
    status: z.enum(['active', 'secret', 'disbanded']).default('active'),
    attitude: z.enum(['ally', 'friendly', 'neutral', 'unfriendly', 'hostile']).default('neutral'),
    headquartersPageId: pageId,
  }),
  pc: z.object({
    playerUserId: z.string().max(64).nullable().default(null),
    playerName: z.string().max(80).default(''),
    classes: z
      .array(z.object({ classUid: z.string().max(300), subclassUid: z.string().max(300).nullable().default(null), level: z.number().int().min(1).max(20) }))
      .max(5)
      .default([]),
    speciesUid: uid,
    backgroundUid: uid,
    hpMax: z.number().int().min(0).max(9999).nullable().default(null),
    hpCurrent: z.number().int().min(-9999).max(9999).nullable().default(null),
    hpTemp: z.number().int().min(0).max(9999).default(0),
    ac: z.number().int().min(0).max(99).nullable().default(null),
    speed: z.number().int().min(0).max(999).nullable().default(null),
    abilities: z.record(z.enum(ABILITY_KEYS), z.number().int().min(1).max(30)).nullable().default(null),
    passivePerception: z.number().int().min(0).max(99).nullable().default(null),
    inspiration: z.boolean().default(false),
  }),
  item: z.object({ itemUid: uid, itemHomebrewEntityId: z.string().max(64).nullable().default(null) }),
} as const;

export type FacetType = keyof typeof FACET_SCHEMAS;
export const FACET_TYPES = Object.keys(FACET_SCHEMAS) as FacetType[];
export type FacetData<T extends FacetType> = z.infer<(typeof FACET_SCHEMAS)[T]>;

export function facetTypeFor(pageType: PageType): FacetType | null {
  return (FACET_TYPES as string[]).includes(pageType) ? (pageType as FacetType) : null;
}

export interface FacetFieldDef {
  key: string;
  label: string;
  type: 'text' | 'longtext' | 'number' | 'select' | 'date' | 'checkbox' | 'pageLink' | 'refLink';
  options?: { value: string; label: string }[];
  /** For pageLink fields: restrict choices to this page type. */
  pageType?: PageType;
  /** For refLink fields: reference entity kind. */
  refKind?: string;
}

const opts = (...values: string[]) => values.map((v) => ({ value: v, label: v.charAt(0).toUpperCase() + v.slice(1) }));

export const FACET_FIELDS: Record<FacetType, FacetFieldDef[]> = {
  npc: [
    { key: 'role', label: 'Role', type: 'text' },
    { key: 'status', label: 'Status', type: 'select', options: opts('alive', 'dead', 'missing', 'unknown') },
    { key: 'attitude', label: 'Attitude', type: 'select', options: opts('friendly', 'neutral', 'hostile', 'unknown') },
    { key: 'factionPageId', label: 'Faction', type: 'pageLink', pageType: 'faction' },
    { key: 'locationPageId', label: 'Location', type: 'pageLink', pageType: 'location' },
    { key: 'statblockUid', label: 'Statblock', type: 'refLink', refKind: 'monster' },
  ],
  location: [
    { key: 'kind', label: 'Kind', type: 'select', options: opts('world', 'region', 'settlement', 'site', 'room', 'other') },
    { key: 'parentLocationPageId', label: 'Part of', type: 'pageLink', pageType: 'location' },
  ],
  session: [
    { key: 'number', label: 'Session #', type: 'number' },
    { key: 'date', label: 'Date', type: 'date' },
    { key: 'status', label: 'Status', type: 'select', options: opts('planned', 'played') },
    { key: 'summary', label: 'Summary', type: 'longtext' },
  ],
  quest: [
    { key: 'status', label: 'Status', type: 'select', options: opts('rumor', 'active', 'completed', 'failed', 'abandoned') },
    { key: 'priority', label: 'Priority', type: 'select', options: opts('low', 'normal', 'high') },
    { key: 'giverPageId', label: 'Quest giver', type: 'pageLink', pageType: 'npc' },
  ],
  faction: [
    { key: 'status', label: 'Status', type: 'select', options: opts('active', 'secret', 'disbanded') },
    { key: 'attitude', label: 'Attitude to party', type: 'select', options: opts('ally', 'friendly', 'neutral', 'unfriendly', 'hostile') },
    { key: 'headquartersPageId', label: 'Headquarters', type: 'pageLink', pageType: 'location' },
  ],
  pc: [
    { key: 'playerName', label: 'Player', type: 'text' },
    { key: 'speciesUid', label: 'Species / race', type: 'refLink', refKind: 'race' },
    { key: 'backgroundUid', label: 'Background', type: 'refLink', refKind: 'background' },
    { key: 'hpMax', label: 'Max HP', type: 'number' },
    { key: 'hpCurrent', label: 'Current HP', type: 'number' },
    { key: 'hpTemp', label: 'Temp HP', type: 'number' },
    { key: 'ac', label: 'AC', type: 'number' },
    { key: 'speed', label: 'Speed', type: 'number' },
    { key: 'passivePerception', label: 'Passive Perception', type: 'number' },
    { key: 'inspiration', label: 'Inspiration', type: 'checkbox' },
  ],
  item: [{ key: 'itemUid', label: 'Reference item', type: 'refLink', refKind: 'item' }],
};

export function parseFacet<T extends FacetType>(type: T, input: unknown): FacetData<T> {
  return FACET_SCHEMAS[type].parse(input ?? {}) as FacetData<T>;
}

/** Facet fields players never see (an NPC's statblock is the DM's business). */
export const FACET_DM_ONLY_FIELDS: Record<FacetType, readonly string[]> = {
  npc: ['statblockUid', 'statblockHomebrewEntityId'],
  location: [],
  session: [],
  quest: [],
  faction: [],
  pc: [],
  item: ['itemHomebrewEntityId'],
};

/** A facet as a player may see it: DM-only fields removed, links to pages they cannot see cleared. */
export function projectFacetForPlayers(type: FacetType, facet: Record<string, unknown> | null, canSeePage: (id: string) => boolean): Record<string, unknown> | null {
  if (!facet) return facet;
  const hidden = new Set(FACET_DM_ONLY_FIELDS[type]);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(facet)) {
    if (hidden.has(k)) continue;
    const field = FACET_FIELDS[type].find((f) => f.key === k);
    out[k] = field?.type === 'pageLink' && typeof v === 'string' && !canSeePage(v) ? null : v;
  }
  return out;
}
