import { z } from 'zod';
import { passwordSchema, usernameSchema } from './auth';
import type { CampaignRole } from './campaign';

export interface MemberDto {
  userId: string;
  displayName: string;
  role: CampaignRole;
  joinedAt: number;
  /** Player characters assigned to this member. */
  characters: { pageId: string; title: string }[];
}

export const updateMemberInput = z.object({ role: z.enum(['codm', 'player']) });

export const createInviteInput = z.object({
  role: z.enum(['player', 'codm']).default('player'),
  /** Days until the link stops working (null: never). */
  expiresInDays: z.number().int().min(1).max(365).nullable().default(14),
  /** How many people can use it (null: unlimited). */
  maxUses: z.number().int().min(1).max(100).nullable().default(null),
});
export type CreateInviteInput = z.input<typeof createInviteInput>;

export interface InviteDto {
  id: string;
  role: 'player' | 'codm';
  createdAt: number;
  expiresAt: number | null;
  maxUses: number | null;
  uses: number;
  revoked: boolean;
}

/** The link token is only returned once, when the invite is created. */
export interface CreatedInviteDto {
  invite: InviteDto;
  token: string;
}

export interface InviteInfoDto {
  campaignName: string;
  role: 'player' | 'codm';
  valid: boolean;
  /** Why the invite cannot be used (expired, used up, revoked). */
  reason: string | null;
  alreadyMember: boolean;
}

export const registerWithInviteInput = z.object({
  token: z.string().min(10).max(200),
  username: usernameSchema,
  displayName: z.string().trim().min(1).max(80),
  password: passwordSchema,
});
