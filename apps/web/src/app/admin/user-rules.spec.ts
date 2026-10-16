import type { AdminUserDto, OwnedCampaignDto } from '@cn/shared';
import { buildPlan, campaignOptions, enabledAdminCount, planDefaults, rowRules, sortUsers } from './user-rules';

const user = (id: string, extra: Partial<AdminUserDto> = {}): AdminUserDto => ({ id, username: id, displayName: id, isAdmin: false, disabledAt: null, createdAt: 0, ownedCampaignCount: 0, ...extra });
const member = (userId: string, role: string, disabled = false) => ({ userId, displayName: userId, role, disabled });
const campaign = (id: string, members: ReturnType<typeof member>[]): OwnedCampaignDto => ({ campaignId: id, name: `Camp ${id}`, members });

describe('rowRules', () => {
  it('blocks disable, delete and reset for yourself, with reasons', () => {
    const me = user('me', { isAdmin: true });
    const r = rowRules(me, 'me', 2);
    expect([r.canDisable, r.canDelete, r.canReset]).toEqual([false, false, false]);
    expect(r.reasons.disable).toBe('You cannot disable your own account.');
    expect(r.reasons.delete).toBe('You cannot delete your own account.');
    expect(r.reasons.reset).toBe('Change your own password on the Account page.');
    expect(r.canToggleAdmin).toBe(true);
  });

  it('refuses to remove the only admin', () => {
    const r = rowRules(user('me', { isAdmin: true }), 'me', 1);
    expect(r.canToggleAdmin).toBe(false);
    expect(r.reasons.admin).toBe('You are the only admin. Make someone else an admin first.');
  });

  it('protects the last enabled admin when it is somebody else', () => {
    const r = rowRules(user('x', { isAdmin: true }), 'me', 1);
    expect([r.canDisable, r.canDelete, r.canToggleAdmin]).toEqual([false, false, false]);
    expect(r.reasons.disable).toBe('There must be at least one admin.');
  });

  it('needs an enabled account for a reset link and hints about owned campaigns', () => {
    expect(rowRules(user('d', { disabledAt: 5 }), 'me', 2).reasons.reset).toBe('Enable this account first.');
    const r = rowRules(user('o', { ownedCampaignCount: 3 }), 'me', 2);
    expect([r.canReset, r.canDisable, r.canDelete, r.canToggleAdmin]).toEqual([true, true, true, true]);
    expect(r.deleteHint).toBe('Owns 3 campaigns: you will choose what happens to each.');
  });

  it('counts only enabled admins and sorts by display name', () => {
    const list = [user('b', { displayName: 'bob', isAdmin: true }), user('a', { displayName: 'Anna', isAdmin: true, disabledAt: 1 }), user('c', { displayName: 'Carl' })];
    expect(enabledAdminCount(list)).toBe(1);
    expect(sortUsers(list).map((u) => u.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('delete plan', () => {
  const t = 'target';

  it('presets the first co-DM as the new owner', () => {
    const o = campaignOptions(campaign('1', [member(t, 'dm'), member('p', 'player'), member('c', 'codm')]), t);
    expect(o.candidates.map((m) => m.userId)).toEqual(['c', 'p']);
    expect(o).toMatchObject({ defaultAction: 'transfer', defaultTo: 'c', canArchive: true, blocked: null });
  });

  it('does not pick a player for you, unless there is only one candidate', () => {
    const two = campaignOptions(campaign('1', [member(t, 'dm'), member('p', 'player'), member('q', 'player')]), t);
    expect(two).toMatchObject({ defaultTo: null, canArchive: false });
    expect(two.archiveReason).toContain('no co-DM');
    expect(campaignOptions(campaign('1', [member(t, 'dm'), member('p', 'player')]), t).defaultTo).toBe('p');
  });

  it('blocks a campaign nobody else is in', () => {
    expect(campaignOptions(campaign('1', [member(t, 'dm')]), t).blocked).toBe('solo');
  });

  it('never offers a disabled member as the new owner', () => {
    const o = campaignOptions(campaign('1', [member(t, 'dm'), member('c', 'codm', true), member('p', 'player')]), t);
    expect(o.transferable.map((m) => m.userId)).toEqual(['p']);
    expect(o.defaultTo).toBe('p');
    const only = campaignOptions(campaign('1', [member(t, 'dm'), member('p', 'player', true)]), t);
    expect(only.blocked).toBe('only-disabled');
  });

  it('presets the sole transferable player when a co-DM exists but is disabled', () => {
    const cs = [campaign('1', [member(t, 'dm'), member('c', 'codm', true), member('p', 'player')])];
    expect(planDefaults(cs, t)['1']).toEqual({ action: 'transfer', toUserId: 'p' });
  });

  it('builds the request only when every campaign has a valid choice', () => {
    const cs = [campaign('1', [member(t, 'dm'), member('c', 'codm')]), campaign('2', [member(t, 'dm'), member('p', 'player'), member('q', 'player')])];
    const defaults = planDefaults(cs, t);
    expect(defaults['1']).toEqual({ action: 'transfer', toUserId: 'c' });
    expect(defaults['2']).toEqual({ action: 'transfer', toUserId: null });
    const open = buildPlan(cs, t, defaults);
    expect(open.campaigns).toBeNull();
    expect(open.incomplete.map((c) => c.campaignId)).toEqual(['2']);
    const done = buildPlan(cs, t, { ...defaults, '2': { action: 'transfer', toUserId: 'q' } });
    expect(done.campaigns).toEqual([
      { campaignId: '1', action: 'transfer', toUserId: 'c' },
      { campaignId: '2', action: 'transfer', toUserId: 'q' },
    ]);
    expect(done).toMatchObject({ transfers: 2, archives: 0 });
    expect(buildPlan(cs, t, { '1': { action: 'archive', toUserId: null }, '2': { action: 'transfer', toUserId: 'q' } }).archives).toBe(1);
  });

  it('keeps earlier choices when the plan is rebuilt, dropping members that left', () => {
    const cs = [campaign('1', [member(t, 'dm'), member('a', 'player'), member('b', 'player')])];
    expect(planDefaults(cs, t, { '1': { action: 'transfer', toUserId: 'b' } })['1']!.toUserId).toBe('b');
    expect(planDefaults(cs, t, { '1': { action: 'transfer', toUserId: 'gone' } })['1']!.toUserId).toBeNull();
  });

  it('blocks the whole plan when one campaign is solo', () => {
    const cs = [campaign('1', [member(t, 'dm')]), campaign('2', [member(t, 'dm'), member('c', 'codm')])];
    const p = buildPlan(cs, t, planDefaults(cs, t));
    expect(p.campaigns).toBeNull();
    expect(p.blocked.map((c) => c.campaignId)).toEqual(['1']);
  });
});
