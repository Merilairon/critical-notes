import * as z from 'zod';

/** Homebrew editions: a source is written for one ruleset, or for both. */
export const HOMEBREW_EDITIONS = ['2014', '2024', 'any'] as const;
export type HomebrewEdition = (typeof HOMEBREW_EDITIONS)[number];

/**
 * Who can use a source.
 * - private: only the owner (and the campaigns it is shared with)
 * - instance: every campaign on this server (admins only)
 * - campaign: the hidden source every campaign gets for quick, campaign-only content
 */
export const HOMEBREW_SCOPES = ['private', 'instance', 'campaign'] as const;
export type HomebrewScope = (typeof HOMEBREW_SCOPES)[number];

/** Entity types with a form editor. Everything else the index understands can still be imported and edited as JSON. */
export const HOMEBREW_FORM_TYPES = ['monster', 'spell', 'item', 'baseitem', 'feat', 'race', 'subrace', 'background', 'condition', 'variantrule', 'table'] as const;
export type HomebrewFormType = (typeof HOMEBREW_FORM_TYPES)[number];

export const HOMEBREW_TYPE_LABELS: Record<string, string> = {
  monster: 'Monster',
  spell: 'Spell',
  item: 'Magic item',
  baseitem: 'Mundane item',
  feat: 'Feat',
  race: 'Species / race',
  subrace: 'Subrace',
  background: 'Background',
  condition: 'Condition',
  variantrule: 'Rule',
  table: 'Table',
  optionalfeature: 'Optional feature',
  deity: 'Deity',
  trap: 'Trap',
  hazard: 'Hazard',
  object: 'Object',
  reward: 'Supernatural gift',
  vehicle: 'Vehicle',
  disease: 'Disease',
  action: 'Action',
  language: 'Language',
  cult: 'Cult',
  boon: 'Boon',
  psionic: 'Psionic',
  recipe: 'Recipe',
  deck: 'Deck',
  card: 'Card',
  class: 'Class',
  subclass: 'Subclass',
  classFeature: 'Class feature',
  subclassFeature: 'Subclass feature',
  itemGroup: 'Item group',
  magicvariant: 'Magic variant',
};

/**
 * Source ids for new homebrew, as the 5etools homebrew schema requires: at least 6 characters of letters,
 * digits and `-&+!` (inner spaces allowed), not starting with UA/XUA. Imported files keep their own ids.
 */
export const sourceJsonIdSchema = z
  .string()
  .trim()
  .min(6, 'At least 6 characters')
  .max(50)
  .regex(/^[-a-zA-Z0-9&+!][-a-zA-Z0-9&+! ]*[-a-zA-Z0-9&+!]$/, 'Use letters, digits and - & + ! (no other symbols)')
  .refine((id) => !/^X?UA/i.test(id), 'Ids starting with UA are reserved for Unearthed Arcana');

const colorSchema = z
  .string()
  .regex(/^[a-fA-F0-9]{6}$/, 'Six hex digits, without #')
  .nullable();

/** Source fields without defaults (so partial updates never reset anything). */
const sourceFields = z.object({
  abbreviation: z.string().trim().min(1).max(20),
  fullName: z.string().trim().min(1).max(120),
  authors: z.array(z.string().trim().min(1).max(80)).max(20),
  version: z.string().trim().min(1).max(20),
  edition: z.enum(HOMEBREW_EDITIONS),
  color: colorSchema,
  url: z.string().trim().max(500).regex(/^https?:\/\//i, 'Use an http(s) link').nullable(),
  scope: z.enum(['private', 'instance']),
});

export const createHomebrewSourceInput = sourceFields.extend({
  /** Omitted: derived from the full name. */
  jsonId: sourceJsonIdSchema.optional(),
  authors: sourceFields.shape.authors.default([]),
  version: sourceFields.shape.version.default('1.0.0'),
  color: colorSchema.default(null),
  url: sourceFields.shape.url.default(null),
  scope: sourceFields.shape.scope.default('private'),
});
export type CreateHomebrewSourceInput = z.input<typeof createHomebrewSourceInput>;

export const updateHomebrewSourceInput = sourceFields.partial();
export type UpdateHomebrewSourceInput = z.input<typeof updateHomebrewSourceInput>;

export const shareHomebrewSourceInput = z.object({ campaignIds: z.array(z.string().max(64)).max(200) });

export interface HomebrewSourceDto {
  id: string;
  jsonId: string;
  abbreviation: string;
  fullName: string;
  authors: string[];
  version: string;
  edition: HomebrewEdition;
  color: string | null;
  url: string | null;
  scope: HomebrewScope;
  ownerUserId: string | null;
  ownerName: string | null;
  /** The campaign this source belongs to (scope "campaign"). */
  campaign: { id: string; name: string } | null;
  sharedWith: { id: string; name: string }[];
  entityCount: number;
  canEdit: boolean;
  updatedAt: number;
}

export interface HomebrewIssue {
  /** JSON path inside the entity, e.g. "/hp/average" ("" for the entity itself). */
  path: string;
  message: string;
}

export interface HomebrewValidationDto {
  /** Block saving: the entity cannot be indexed or would break 5etools exports. */
  errors: HomebrewIssue[];
  /** Saved anyway: schema deviations, broken {@tag} targets, name collisions. */
  warnings: HomebrewIssue[];
}

export interface HomebrewEntitySummaryDto {
  id: string;
  sourceId: string;
  entityType: string;
  name: string;
  /** Reference uid while indexed (null if it could not be indexed). */
  uid: string | null;
  currentRevision: number;
  updatedAt: number;
  deleted: boolean;
  /** `_copy` parent ("Name|SOURCE"), when the entity is a variant of another. */
  copyOf: string | null;
}

export interface HomebrewEntityDto extends HomebrewEntitySummaryDto {
  data: Record<string, unknown>;
  fluff: Record<string, unknown> | null;
  source: HomebrewSourceDto;
}

export const saveHomebrewEntityInput = z.object({
  entityType: z.string().min(2).max(40),
  data: z.record(z.string(), z.unknown()),
  fluff: z.record(z.string(), z.unknown()).nullable().optional(),
  message: z.string().max(200).optional(),
  /** Optimistic concurrency for updates. */
  revision: z.number().int().min(1).optional(),
  /** Save even if the 5etools schema reports errors (app-level errors still block). */
  force: z.boolean().default(false),
});
export type SaveHomebrewEntityInput = z.input<typeof saveHomebrewEntityInput>;

export interface SaveHomebrewResultDto {
  entity: HomebrewEntityDto;
  validation: HomebrewValidationDto;
}

export const previewHomebrewInput = z.object({
  sourceId: z.string().max(64),
  entityType: z.string().min(2).max(40),
  data: z.record(z.string(), z.unknown()),
  /** The entity being edited, so it does not collide with itself. */
  entityId: z.string().max(64).nullable().default(null),
});

export const copyToHomebrewInput = z.object({
  sourceId: z.string().max(64),
  baseUid: z.string().max(300),
  /** clone: a full copy; variant: a `_copy` that stores only the changes. */
  mode: z.enum(['clone', 'variant']),
  name: z.string().trim().min(1).max(200).optional(),
});

export interface HomebrewRevisionDto {
  revNo: number;
  createdAt: number;
  authorName: string | null;
  message: string | null;
  /** Number of JSON-patch operations relative to the previous revision. */
  changes: number;
}

export interface HomebrewUsageDto {
  pageId: string;
  pageTitle: string;
  campaignId: string;
  campaignName: string;
  via: string;
}

export interface HomebrewImportReportDto {
  sources: { id: string; jsonId: string; fullName: string; created: boolean }[];
  created: number;
  updated: number;
  unchanged: number;
  skipped: { type: string; name: string; reason: string }[];
  warnings: string[];
  /** Data arrays the app cannot use (kept in the source for export). */
  unsupported: Record<string, number>;
}

export const importHomebrewUrlInput = z.object({
  url: z.string().trim().max(2000).regex(/^https?:\/\//i, 'Use an http(s) link'),
  defaultEdition: z.enum(HOMEBREW_EDITIONS).default('2014'),
});
