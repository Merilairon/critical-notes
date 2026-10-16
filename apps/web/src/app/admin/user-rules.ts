import type { AdminUserDto, OwnedCampaignDto, OwnedCampaignPlan } from '@cn/shared';

export interface RowReasons {
  reset?: string;
  disable?: string;
  delete?: string;
  admin?: string;
}

export interface RowRules {
  canReset: boolean;
  canDisable: boolean;
  canDelete: boolean;
  canToggleAdmin: boolean;
  reasons: RowReasons;
  /** Not blocking: shown under Delete when the person owns campaigns. */
  deleteHint?: string;
}

const isEnabledAdmin = (u: AdminUserDto) => u.isAdmin && u.disabledAt === null;

/**
 * Which row actions are available, and why not. The client rules are advice; every one has a server 409 behind it.
 * `enabledAdmins` counts all enabled admins in the list.
 */
export function rowRules(user: AdminUserDto, meId: string | undefined, enabledAdmins: number): RowRules {
  const self = user.id === meId;
  const lastAdmin = isEnabledAdmin(user) && enabledAdmins <= 1;
  const reasons: RowReasons = {};
  if (self) {
    reasons.disable = 'You cannot disable your own account.';
    reasons.delete = 'You cannot delete your own account.';
    reasons.reset = 'Change your own password on the Account page.';
    if (lastAdmin) reasons.admin = 'You are the only admin. Make someone else an admin first.';
  } else if (lastAdmin) {
    reasons.disable = reasons.delete = reasons.admin = 'There must be at least one admin.';
  }
  if (!reasons.reset && user.disabledAt !== null) reasons.reset = 'Enable this account first.';
  return {
    canReset: !reasons.reset,
    canDisable: !reasons.disable,
    canDelete: !reasons.delete,
    canToggleAdmin: !reasons.admin,
    reasons,
    deleteHint: !reasons.delete && user.ownedCampaignCount > 0 ? `Owns ${user.ownedCampaignCount} ${user.ownedCampaignCount === 1 ? 'campaign' : 'campaigns'}: you will choose what happens to each.` : undefined,
  };
}

export const enabledAdminCount = (users: readonly AdminUserDto[]) => users.filter(isEnabledAdmin).length;

/** Users sorted by display name (case-insensitive), then username, so rows do not jump after an action. */
export const sortUsers = (users: readonly AdminUserDto[]) =>
  [...users].sort((a, b) => a.displayName.localeCompare(b.displayName, undefined, { sensitivity: 'base' }) || a.username.localeCompare(b.username));

export type Member = OwnedCampaignDto['members'][number];

export interface CampaignOptions {
  campaign: OwnedCampaignDto;
  /** Members other than the target: co-DMs first, then by name. */
  candidates: Member[];
  /** Transfer targets that can actually receive the campaign. */
  transferable: Member[];
  canTransfer: boolean;
  canArchive: boolean;
  /** Why archive is unavailable. */
  archiveReason?: string;
  /** Neither transfer nor archive is possible. */
  blocked: 'solo' | 'only-disabled' | null;
  defaultAction: 'transfer' | 'archive' | null;
  defaultTo: string | null;
}

/** What can be done with one owned campaign, and the default choice (never silently picks a player: D5). */
export function campaignOptions(campaign: OwnedCampaignDto, targetId: string): CampaignOptions {
  const candidates = campaign.members
    .filter((m) => m.userId !== targetId)
    .sort((a, b) => Number(b.role === 'codm') - Number(a.role === 'codm') || a.displayName.localeCompare(b.displayName, undefined, { sensitivity: 'base' }));
  const transferable = candidates.filter((m) => !m.disabled);
  const hasCodm = candidates.some((m) => m.role === 'codm');
  const canTransfer = transferable.length > 0;
  const canArchive = hasCodm;
  const blocked = candidates.length === 0 ? 'solo' : !canTransfer && !canArchive ? 'only-disabled' : null;
  const firstCodm = transferable.find((m) => m.role === 'codm');
  return {
    campaign,
    candidates,
    transferable,
    canTransfer,
    canArchive,
    archiveReason: canArchive ? undefined : 'Not available: it has no co-DM, so nobody could open it afterwards.',
    blocked,
    defaultAction: blocked ? null : canTransfer ? 'transfer' : 'archive',
    defaultTo: firstCodm?.userId ?? (transferable.length === 1 ? transferable[0]!.userId : null),
  };
}

export interface Choice {
  action: 'transfer' | 'archive';
  toUserId: string | null;
}

/** Initial choices for every campaign (`planDefaults`), keeping `previous` choices that are still valid. */
export function planDefaults(campaigns: readonly OwnedCampaignDto[], targetId: string, previous: Readonly<Record<string, Choice>> = {}): Record<string, Choice> {
  const out: Record<string, Choice> = {};
  for (const c of campaigns) {
    const o = campaignOptions(c, targetId);
    if (o.blocked) continue;
    const prev = previous[c.campaignId];
    if (prev?.action === 'archive' && o.canArchive) out[c.campaignId] = prev;
    else if (prev?.action === 'transfer' && o.canTransfer) out[c.campaignId] = { action: 'transfer', toUserId: o.transferable.some((m) => m.userId === prev.toUserId) ? prev.toUserId : null };
    else out[c.campaignId] = { action: o.defaultAction!, toUserId: o.defaultAction === 'transfer' ? o.defaultTo : null };
  }
  return out;
}

export interface BuiltPlan {
  /** The request body's `campaigns`, only when every campaign has a valid choice. */
  campaigns: OwnedCampaignPlan[] | null;
  /** Campaigns without a complete choice. */
  incomplete: OwnedCampaignDto[];
  blocked: OwnedCampaignDto[];
  transfers: number;
  archives: number;
}

export function buildPlan(campaigns: readonly OwnedCampaignDto[], targetId: string, choices: Readonly<Record<string, Choice>>): BuiltPlan {
  const blocked: OwnedCampaignDto[] = [];
  const incomplete: OwnedCampaignDto[] = [];
  const plan: OwnedCampaignPlan[] = [];
  for (const c of campaigns) {
    const o = campaignOptions(c, targetId);
    const ch = choices[c.campaignId];
    if (o.blocked) blocked.push(c);
    else if (ch?.action === 'archive' && o.canArchive) plan.push({ campaignId: c.campaignId, action: 'archive' });
    else if (ch?.action === 'transfer' && ch.toUserId && o.transferable.some((m) => m.userId === ch.toUserId)) plan.push({ campaignId: c.campaignId, action: 'transfer', toUserId: ch.toUserId });
    else incomplete.push(c);
  }
  return {
    campaigns: blocked.length || incomplete.length ? null : plan,
    incomplete,
    blocked,
    transfers: plan.filter((p) => p.action === 'transfer').length,
    archives: plan.filter((p) => p.action === 'archive').length,
  };
}
