import * as z from 'zod';
import { RULESET_VALUES } from './campaign';

/** Where a campaign refers to rules content. */
export type ReferenceSite =
  | { kind: 'page'; pageId: string; title: string; via: 'tag' | 'embed' | 'facet' | 'property' }
  | { kind: 'encounter'; encounterId: string; name: string }
  | { kind: 'inventory'; itemId: string; name: string };

export interface MigrationEntryDto {
  /** The uid as it is now. */
  from: string;
  fromName: string;
  fromSource: string;
  /** mapped: a printing for the new edition exists · unchanged: already fits (or edition-neutral) · unmapped: nothing to map to. */
  status: 'mapped' | 'unchanged' | 'unmapped';
  to: string | null;
  toName: string | null;
  toSource: string | null;
  sites: ReferenceSite[];
}

export interface MigrationReportDto {
  from: (typeof RULESET_VALUES)[number];
  to: (typeof RULESET_VALUES)[number];
  entries: MigrationEntryDto[];
  counts: { mapped: number; unchanged: number; unmapped: number; sites: number };
}

export const migrateEditionInput = z.object({
  to: z.enum(RULESET_VALUES),
  /** uids to leave as they are even though they could be mapped. */
  keep: z.array(z.string().max(300)).max(5000).default([]),
});

export interface MigrationResultDto {
  report: MigrationReportDto;
  /** References rewritten. */
  changed: number;
}

export const CAMPAIGN_EXPORT_FORMAT = 'critical-notes/campaign';
export const CAMPAIGN_EXPORT_VERSION = 1;

export interface CampaignImportReportDto {
  campaignId: string;
  pages: number;
  encounters: number;
  templates: number;
  homebrew: number;
  uploads: number;
  warnings: string[];
}
