import { z } from 'zod';

export const usernameSchema = z
  .string()
  .trim()
  .min(2)
  .max(40)
  .regex(/^[a-zA-Z0-9_.-]+$/, 'Letters, numbers, dots, dashes and underscores only');
export const passwordSchema = z.string().min(8, 'At least 8 characters').max(200);

export const loginInput = z.object({ username: z.string().trim().min(1).max(40), password: z.string().min(1).max(200) });
export type LoginInput = z.infer<typeof loginInput>;

export const setupInput = z.object({ username: usernameSchema, displayName: z.string().trim().min(1).max(80), password: passwordSchema });
export type SetupInput = z.infer<typeof setupInput>;

export const changePasswordInput = z.object({ currentPassword: z.string().min(1).max(200), newPassword: passwordSchema });

export const updateMeInput = z.object({ displayName: z.string().trim().min(1).max(80) }).strict();
export type UpdateMeInput = z.infer<typeof updateMeInput>;

export interface UserDto {
  id: string;
  username: string;
  displayName: string;
  isAdmin: boolean;
}

export interface MeDto {
  user: UserDto | null;
  setupRequired: boolean;
}

// region Admin: user management (Task M2.4)

export interface AdminUserDto {
  id: string;
  username: string;
  displayName: string;
  isAdmin: boolean;
  /** Epoch ms, null = enabled. */
  disabledAt: number | null;
  createdAt: number;
  ownedCampaignCount: number;
}

/** Step-up: every sensitive admin action carries the acting admin's own password. */
export const resetLinkInput = z.object({ currentPassword: z.string().min(1).max(200), revokeTokens: z.boolean().optional() }).strict();
export type ResetLinkInput = z.infer<typeof resetLinkInput>;

/** Redeeming a reset link: the new password only (the token is in the path). */
export const redeemResetInput = z.object({ newPassword: passwordSchema }).strict();
export type RedeemResetInput = z.infer<typeof redeemResetInput>;

/** Whose account a live reset link belongs to. */
export interface ResetInfoDto {
  username: string;
  displayName: string;
  expiresAt: number;
}

export interface ResetLinkDto {
  /** `<PUBLIC_URL>/reset#<token>`: shown once, never stored. */
  url: string;
  expiresAt: number;
}

export const adminUpdateUserInput = z
  .object({ disabled: z.boolean().optional(), isAdmin: z.boolean().optional(), currentPassword: z.string().min(1).max(200).optional() })
  .strict()
  .refine((v) => v.disabled !== undefined || v.isAdmin !== undefined, 'Nothing to change')
  // `{ disabled: false }` alone is password-free here; the server still demands the password when the target is an admin.
  .refine((v) => v.currentPassword !== undefined || (v.disabled === false && v.isAdmin === undefined), 'Enter your password to confirm');
export type AdminUpdateUserInput = z.infer<typeof adminUpdateUserInput>;

export const ownedCampaignPlan = z.discriminatedUnion('action', [
  z.object({ campaignId: z.string().min(1), action: z.literal('transfer'), toUserId: z.string().min(1) }).strict(),
  z.object({ campaignId: z.string().min(1), action: z.literal('archive') }).strict(),
]);
export type OwnedCampaignPlan = z.infer<typeof ownedCampaignPlan>;

export const deleteUserInput = z.object({ currentPassword: z.string().min(1).max(200), campaigns: z.array(ownedCampaignPlan).max(500) }).strict();
export type DeleteUserInput = z.infer<typeof deleteUserInput>;

export interface OwnedCampaignDto {
  campaignId: string;
  name: string;
  members: { userId: string; displayName: string; role: string; /** Disabled accounts cannot receive a transfer. */ disabled: boolean }[];
}

// endregion
