import { z } from 'zod';
import { PAGE_TYPES, VISIBILITY_VALUES, type PageType } from './pages';
import { PROPERTY_TYPES } from './properties';

export const TEMPLATE_KINDS = ['block', 'page'] as const;
export type TemplateKindDto = (typeof TEMPLATE_KINDS)[number];

/** global: built-in, read-only · user: the author's own · campaign: belongs to one campaign. */
export const TEMPLATE_SCOPES = ['global', 'user', 'campaign'] as const;
export type TemplateScope = (typeof TEMPLATE_SCOPES)[number];

const value = z.union([z.string().max(2000), z.number(), z.boolean()]);

export const templateVariableSchema = z.object({
  name: z.string().min(1).max(60),
  type: z.string().min(1).max(200),
  label: z.string().max(120).optional(),
  default: value.optional(),
  required: z.boolean().optional(),
});
export type TemplateVariableDto = z.infer<typeof templateVariableSchema>;

/** Template content: block nodes, sanitized by the server when instantiated. */
const blockNodes = z.array(z.record(z.string(), z.unknown())).max(2000);

export const blockTemplateDefSchema = z.object({
  variables: z.array(templateVariableSchema).max(100).default([]),
  content: blockNodes,
});

export const templatePropertySchema = z.object({
  key: z.string().min(1).max(60),
  label: z.string().min(1).max(60),
  type: z.enum(PROPERTY_TYPES),
  options: z.array(z.string().max(60)).max(50).nullable().optional(),
  required: z.boolean().optional(),
  default: z.unknown().optional(),
  dmOnly: z.boolean().optional(),
  refKind: z.string().max(40).nullable().optional(),
});

export const pageTemplateDefSchema = z.object({
  pageType: z.enum(PAGE_TYPES),
  extendsRef: z.string().max(80).nullable().default(null),
  bodyMode: z.enum(['append', 'replace']).default('append'),
  defaults: z
    .object({
      title: z.string().max(200).optional(),
      icon: z.string().max(16).nullable().optional(),
      visibility: z.enum(VISIBILITY_VALUES).optional(),
      tags: z.array(z.string().max(40)).max(30).optional(),
    })
    .default({}),
  facet: z.record(z.string(), z.unknown()).default({}),
  properties: z.array(templatePropertySchema).max(30).default([]),
  variables: z.array(templateVariableSchema).max(100).default([]),
  body: blockNodes,
  children: z.array(z.object({ title: z.string().min(1).max(200), templateRef: z.string().max(80).nullable().optional() })).max(30).default([]),
});

export const createTemplateInput = z.object({
  kind: z.enum(TEMPLATE_KINDS),
  scope: z.enum(['user', 'campaign']),
  campaignId: z.string().max(64).nullable().default(null),
  name: z.string().trim().min(1).max(120),
  description: z.string().max(500).default(''),
  icon: z.string().max(16).nullable().default(null),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
  definition: z.record(z.string(), z.unknown()),
});
export type CreateTemplateInput = z.input<typeof createTemplateInput>;

export const updateTemplateInput = z.object({
  /** Optimistic concurrency: the version the client edited. */
  version: z.number().int().min(1),
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().max(500).optional(),
  icon: z.string().max(16).nullable().optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
  definition: z.record(z.string(), z.unknown()).optional(),
});
export type UpdateTemplateInput = z.input<typeof updateTemplateInput>;

export const duplicateTemplateInput = z.object({
  scope: z.enum(['user', 'campaign']),
  campaignId: z.string().max(64).nullable().default(null),
  name: z.string().trim().min(1).max(120).optional(),
});

/** fill: values substituted · fields: unfilled variables stay as fields · linked: filled, and updates when the template changes. */
export const INSERT_MODES = ['fill', 'fields', 'linked'] as const;
export type InsertMode = (typeof INSERT_MODES)[number];

export const instantiateBlockInput = z.object({
  values: z.record(z.string(), z.unknown()).default({}),
  mode: z.enum(INSERT_MODES).default('fill'),
});

export const createPageFromTemplateInput = z.object({
  templateId: z.string().max(64),
  title: z.string().trim().max(200).optional(),
  parentId: z.string().max(64).nullable().default(null),
  values: z.record(z.string(), z.unknown()).default({}),
  mode: z.enum(['fill', 'fields']).default('fields'),
  /** Create the template's child pages too. */
  withChildren: z.boolean().default(true),
});
export type CreatePageFromTemplateInput = z.input<typeof createPageFromTemplateInput>;

export const applyTemplateInput = z.object({
  templateId: z.string().max(64),
  values: z.record(z.string(), z.unknown()).default({}),
  mode: z.enum(['fill', 'fields']).default('fields'),
});

export const setTemplateDefaultInput = z.object({ pageType: z.enum(PAGE_TYPES), templateId: z.string().max(64).nullable() });

export interface TemplateSummaryDto {
  id: string;
  kind: TemplateKindDto;
  scope: TemplateScope;
  builtinKey: string | null;
  name: string;
  description: string;
  icon: string | null;
  tags: string[];
  version: number;
  /** Page templates: the page type they create. */
  pageType: PageType | null;
  campaign: { id: string; name: string } | null;
  ownerName: string | null;
  canEdit: boolean;
  updatedAt: number;
}

export interface TemplateDto extends TemplateSummaryDto {
  definition: Record<string, unknown>;
  /** Variables of the template with its `extends` chain (page templates), ready for a values form. */
  resolvedVariables: TemplateVariableDto[];
  /** Problems in the content (unknown types, conflicting declarations). */
  issues: string[];
}

export interface TemplateUsageDto {
  pageId: string;
  pageTitle: string;
  campaignId: string;
  campaignName: string;
  mode: 'linked' | 'page';
  version: number;
}

export interface TemplateSaveResultDto {
  template: TemplateDto;
  /** Linked instances re-rendered with the new version. */
  propagated: number;
}

export interface TemplateImportReportDto {
  created: { id: string; name: string }[];
  skipped: string[];
}
