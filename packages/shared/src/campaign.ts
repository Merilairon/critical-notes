import * as z from 'zod';

export const RULESET_VALUES = ['2014', '2024'] as const;
export const rulesetSchema = z.enum(RULESET_VALUES);

export const createCampaignInput = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().max(4000).default(''),
  ruleset: rulesetSchema,
  crossEdition: z.boolean().default(false),
});
export type CreateCampaignInput = z.input<typeof createCampaignInput>;

export const updateCampaignInput = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().max(4000).optional(),
  crossEdition: z.boolean().optional(),
  houseRules: z.unknown().optional(),
  coverImage: z.string().max(512).nullable().optional(),
  status: z.enum(['active', 'archived']).optional(),
  /** Lower-cased source id → enabled; null removes the override. */
  sourceOverrides: z.record(z.string().max(64), z.boolean().nullable()).optional(),
});
export type UpdateCampaignInput = z.input<typeof updateCampaignInput>;

/** dm: the campaign's owner · codm: a fellow game master (everything but members and editions) · player. */
export const CAMPAIGN_ROLES = ['dm', 'codm', 'player'] as const;
export type CampaignRole = (typeof CAMPAIGN_ROLES)[number];

/** Game masters see and edit everything in the campaign. */
export const isGameMaster = (role: CampaignRole) => role === 'dm' || role === 'codm';

export interface CampaignDto {
  id: string;
  name: string;
  description: string;
  ruleset: (typeof RULESET_VALUES)[number];
  crossEdition: boolean;
  status: 'active' | 'archived';
  coverImage: string | null;
  houseRules: unknown;
  role: CampaignRole;
  sourceOverrides: Record<string, boolean>;
  /** json id of the campaign-only homebrew source. */
  campaignSourceId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface CampaignSummaryDto {
  id: string;
  name: string;
  description: string;
  ruleset: (typeof RULESET_VALUES)[number];
  status: 'active' | 'archived';
  role: CampaignRole;
  pageCount: number;
  updatedAt: number;
}
