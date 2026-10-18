import { z } from 'zod';
import { PAGE_TYPES, type PageType } from './page-types';

export { PAGE_TYPES, PAGE_TYPE_ICONS, PAGE_TYPE_LABELS, type PageType } from './page-types';
export const pageTypeSchema = z.enum(PAGE_TYPES);

export const VISIBILITY_VALUES = ['dm', 'all', 'selected'] as const;
export const visibilitySchema = z.enum(VISIBILITY_VALUES);
export type PageVisibility = (typeof VISIBILITY_VALUES)[number];

/** Block document (ProseMirror JSON of our schema). Detailed per-block validation arrives with the block registry. */
export const blockDocSchema = z
  .object({ type: z.literal('doc'), schemaVersion: z.number().int().optional(), content: z.array(z.unknown()).max(5000).optional() })
  .passthrough();
export type BlockDoc = z.infer<typeof blockDocSchema>;

const tagSchema = z.string().trim().min(1).max(48);

export const createPageInput = z.object({
  type: pageTypeSchema.default('generic'),
  title: z.string().trim().min(1).max(200),
  parentId: z.string().max(64).nullable().default(null),
  /** Insert after this sibling (default: last). */
  afterId: z.string().max(64).nullable().optional(),
  icon: z.string().max(16).nullable().optional(),
  visibility: visibilitySchema.default('dm'),
  tags: z.array(tagSchema).max(30).default([]),
  body: blockDocSchema.optional(),
  facet: z.record(z.string(), z.unknown()).optional(),
  /** Custom property values by key. */
  props: z.record(z.string().max(60), z.unknown()).optional(),
});
export type CreatePageInput = z.input<typeof createPageInput>;

export const updatePageInput = z.object({
  /** Optimistic concurrency: the revision the client edited. */
  revision: z.number().int().min(1),
  title: z.string().trim().min(1).max(200).optional(),
  icon: z.string().max(16).nullable().optional(),
  cover: z.string().max(512).nullable().optional(),
  type: pageTypeSchema.optional(),
  visibility: visibilitySchema.optional(),
  viewers: z.array(z.string().max(64)).max(100).optional(),
  tags: z.array(tagSchema).max(30).optional(),
  body: blockDocSchema.optional(),
  facet: z.record(z.string(), z.unknown()).optional(),
  /** Custom property values by key (null clears). */
  props: z.record(z.string().max(60), z.unknown()).optional(),
});
export type UpdatePageInput = z.input<typeof updatePageInput>;

export const movePageInput = z.object({
  parentId: z.string().max(64).nullable(),
  /** Place between these siblings (either may be null for start/end). */
  beforeId: z.string().max(64).nullable().optional(),
  afterId: z.string().max(64).nullable().optional(),
});
export type MovePageInput = z.input<typeof movePageInput>;

export interface PageSummaryDto {
  id: string;
  parentId: string | null;
  sortKey: string;
  type: PageType;
  title: string;
  icon: string | null;
  visibility: PageVisibility;
  updatedAt: number;
}

/** Days a deleted page stays in the trash before the automatic purge removes it. */
export const TRASH_RETENTION_DAYS = 30;

/** One deleted page tree in the campaign trash: its root, how many subpages went with it, and when. */
export interface TrashEntryDto {
  id: string;
  title: string;
  type: PageType;
  icon: string | null;
  subpageCount: number;
  deletedAt: number;
}

export interface PageDto extends PageSummaryDto {
  campaignId: string;
  cover: string | null;
  body: BlockDoc | null;
  revision: number;
  tags: string[];
  viewers: string[];
  facet: Record<string, unknown> | null;
  /** Custom property values by key. */
  props: Record<string, unknown>;
  createdAt: number;
}
