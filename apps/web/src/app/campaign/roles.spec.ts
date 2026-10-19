import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { computed, signal, type Type } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { convertToParamMap, provideRouter, UrlTree, type ActivatedRouteSnapshot, type RouterStateSnapshot } from '@angular/router';
import { RULESET_IDS } from '@cn/fivetools';
import { isGameMaster, type CampaignDto, type CampaignRole, type InventoryDto, type MemberDto, type MigrationReportDto } from '@cn/shared';
import { AuthService } from '../core/auth.service';
import { ContextService } from '../core/context.service';
import { InventoryPage } from '../play/inventory-page';
import { PlayApi } from '../play/play-api';
import { CampaignStore } from './campaign.store';
import { EditionMigrationPanel } from './edition-migration';
import { gmGuard } from './gm.guard';
import { MembersPanel } from './members-panel';

const settle = () => new Promise((resolve) => setTimeout(resolve));

const member = (userId: string, role: CampaignRole, characters: MemberDto['characters'] = []): MemberDto => ({
  userId,
  displayName: userId,
  role,
  joinedAt: 0,
  characters,
});

/** The parts of the campaign store the panels use, for a member with the given role. */
function fakeStore(role: CampaignRole, members: MemberDto[] = []) {
  const campaign = signal({ id: 'c1', role, ruleset: RULESET_IDS[0] } as CampaignDto);
  return {
    campaign,
    id: signal('c1'),
    role: computed(() => campaign().role),
    isGm: computed(() => isGameMaster(campaign().role)),
    isOwner: computed(() => campaign().role === 'dm'),
    myId: signal('me'),
    members: signal(members),
    pages: signal([]),
    loadMembers: vi.fn(async () => undefined),
    load: vi.fn(async () => undefined),
  };
}

function mount<T>(component: Type<T>, store: ReturnType<typeof fakeStore>, providers: unknown[] = []) {
  TestBed.configureTestingModule({
    imports: [component],
    providers: [provideRouter([]), provideHttpClient(), provideHttpClientTesting(), { provide: CampaignStore, useValue: store }, ...(providers as never[])],
  });
  const fixture = TestBed.createComponent(component);
  fixture.detectChanges();
  return { fixture, el: fixture.nativeElement as HTMLElement, http: TestBed.inject(HttpTestingController) };
}

describe('CampaignStore roles', () => {
  function store(role: CampaignRole) {
    TestBed.configureTestingModule({
      providers: [CampaignStore, provideHttpClient(), provideHttpClientTesting(), { provide: AuthService, useValue: { user: signal({ id: 'me' }) } }],
    });
    const s = TestBed.inject(CampaignStore);
    s.campaign.set({ id: 'c1', role } as CampaignDto);
    return s;
  }
  const pc = (playerUserId: string | null) => ({ type: 'pc', facet: { playerUserId } });

  it('lets game masters edit every page', () => {
    for (const role of ['dm', 'codm'] as const) {
      const s = store(role);
      expect([s.isGm(), s.canEdit({ type: 'npc', facet: null }), s.canEdit(pc('someone'))]).toEqual([true, true, true]);
      TestBed.resetTestingModule();
    }
    expect(store('dm').isOwner()).toBe(true);
  });

  it('lets a player edit only their own character', () => {
    const s = store('player');
    expect(s.isGm()).toBe(false);
    expect(s.isOwner()).toBe(false);
    expect(s.canEdit(pc('me'))).toBe(true);
    expect(s.canEdit(pc('someone'))).toBe(false);
    expect(s.canEdit(pc(null))).toBe(false);
    expect(s.canEdit({ type: 'npc', facet: { playerUserId: 'me' } })).toBe(false);
  });
});

describe('gmGuard', () => {
  const route = { pathFromRoot: [{ paramMap: convertToParamMap({}) }, { paramMap: convertToParamMap({ campaignId: 'c1' }) }] } as unknown as ActivatedRouteSnapshot;
  function run(known: CampaignRole | null) {
    TestBed.configureTestingModule({ providers: [provideRouter([]), provideHttpClient(), provideHttpClientTesting()] });
    if (known) TestBed.inject(ContextService).campaign.set({ id: 'c1', name: 'C', ruleset: RULESET_IDS[0], crossEdition: false, overrides: {}, role: known });
    return TestBed.runInInjectionContext(() => gmGuard(route, {} as RouterStateSnapshot)) as Promise<boolean | UrlTree>;
  }

  it('lets game masters in and sends players to the overview', async () => {
    expect(await run('codm')).toBe(true);
    TestBed.resetTestingModule();
    const result = await run('player');
    expect(result instanceof UrlTree && result.toString()).toBe('/c/c1');
  });

  it('asks the server when the campaign is not loaded yet', async () => {
    const result = run(null);
    await settle();
    TestBed.inject(HttpTestingController).expectOne('/api/campaigns/c1').flush({ id: 'c1', role: 'player' });
    expect((await result).toString()).toBe('/c/c1');
  });
});

describe('MembersPanel', () => {
  const members = [member('owner', 'dm'), member('me', 'codm'), member('ann', 'player', [{ pageId: 'pc1', title: 'Wren' }])];

  it('gives the owner role controls for everyone but themselves, and no way to leave', async () => {
    const { fixture, el, http } = mount(MembersPanel, fakeStore('dm', members));
    await settle();
    http.expectOne('/api/campaigns/c1/invites').flush({ invites: [] });
    await settle();
    fixture.detectChanges();
    expect([...el.querySelectorAll('select[aria-label^="Role of"]')].map((s) => s.getAttribute('aria-label'))).toEqual(['Role of me', 'Role of ann']);
    expect(el.textContent).toContain('plays Wren');
    expect([...el.querySelectorAll('option')].map((o) => o.value)).toContain('codm');
    expect(el.textContent).not.toContain('Leave this campaign');
  });

  it('lets a co-DM invite players (not co-DMs) and shows a new link once', async () => {
    const { fixture, el, http } = mount(MembersPanel, fakeStore('codm', members));
    await settle();
    http.expectOne('/api/campaigns/c1/invites').flush({ invites: [] });
    await settle();
    fixture.detectChanges();
    expect(el.querySelector('select[aria-label^="Role of"]')).toBeNull();
    const inviteRoles = [...el.querySelector('form select')!.querySelectorAll('option')].map((o) => o.value);
    expect(inviteRoles).toEqual(['player']);

    el.querySelector<HTMLFormElement>('form')!.dispatchEvent(new Event('submit'));
    const req = http.expectOne({ method: 'POST', url: '/api/campaigns/c1/invites' });
    expect(req.request.body).toEqual({ role: 'player', expiresInDays: 14, maxUses: null });
    req.flush({ token: 'tok123' });
    await settle();
    http.expectOne('/api/campaigns/c1/invites').flush({ invites: [] });
    await settle();
    fixture.detectChanges();
    expect(el.querySelector<HTMLInputElement>('input[aria-label="Invite link"]')!.value).toBe(`${location.origin}/invite/tok123`);
    expect(el.textContent).toContain('Leave this campaign');
  });

  it('shows players the members and a way to leave, without invites', async () => {
    const { fixture, el, http } = mount(MembersPanel, fakeStore('player', members));
    await settle();
    fixture.detectChanges();
    http.expectNone('/api/campaigns/c1/invites');
    expect(el.textContent).not.toContain('Invite links');
    expect(el.querySelector('select')).toBeNull();
    expect(el.textContent).toContain('Co-DM');
    expect(el.textContent).toContain('Leave this campaign');
  });
});

describe('EditionMigrationPanel', () => {
  const [from, to] = RULESET_IDS;
  const report: MigrationReportDto = {
    from,
    to,
    entries: [
      { from: 'spell:old bolt|src', fromName: 'Old Bolt', fromSource: 'SRC', status: 'unmapped', to: null, toName: null, toSource: null, sites: [{ kind: 'encounter', encounterId: 'e1', name: 'Ambush' }] },
      {
        from: 'monster:goblin|src',
        fromName: 'Goblin',
        fromSource: 'SRC',
        status: 'mapped',
        to: 'monster:goblin|new',
        toName: 'Goblin Warrior',
        toSource: 'NEW',
        sites: [{ kind: 'page', pageId: 'p1', title: 'Cave', via: 'tag' }],
      },
    ],
    counts: { mapped: 1, unchanged: 0, unmapped: 1, sites: 2 },
  } as MigrationReportDto;

  it('shows the dry run, then applies it without the references to keep', async () => {
    const store = fakeStore('dm');
    const { fixture, el, http } = mount(EditionMigrationPanel, store);
    el.querySelector<HTMLButtonElement>('button')!.click();
    http.expectOne((r) => r.url === '/api/campaigns/c1/migrate-edition' && r.params.get('to') === to).flush(report);
    await settle();
    fixture.detectChanges();
    expect(el.textContent).toContain('Goblin Warrior');
    expect(el.textContent).toContain('No match');
    expect(el.textContent).toContain('Cave');
    // Only mapped references can be kept as they are
    const keep = el.querySelectorAll<HTMLInputElement>('input[type=checkbox]');
    expect([...keep].map((k) => k.getAttribute('aria-label'))).toEqual(['Keep Goblin']);
    keep[0]!.click();
    fixture.detectChanges();

    vi.spyOn(window, 'confirm').mockReturnValue(true);
    [...el.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent!.startsWith('Move to'))!.click();
    await settle();
    const req = http.expectOne({ method: 'POST', url: '/api/campaigns/c1/migrate-edition' });
    expect(req.request.body).toEqual({ to, keep: ['monster:goblin|src'] });
    req.flush({ report, changed: 0 });
    await settle();
    fixture.detectChanges();
    expect(el.querySelector('[role=status]')!.textContent).toContain('Done: 0 references changed.');
    expect(store.load).toHaveBeenCalledWith('c1');
  });
});

describe('InventoryPage permissions', () => {
  const inv: InventoryDto = {
    owners: [
      { pageId: null, name: 'Party' },
      { pageId: 'mine', name: 'Mine' },
      { pageId: 'theirs', name: 'Theirs' },
    ],
    items: [
      { id: 'i1', ownerPageId: null, itemUid: null, name: 'Rope', quantity: 1, attuned: false, identified: true, sessionPageId: null, notes: '' },
      { id: 'i2', ownerPageId: 'mine', itemUid: null, name: 'Dagger', quantity: 2, attuned: false, identified: true, sessionPageId: null, notes: '' },
      { id: 'i3', ownerPageId: 'theirs', itemUid: null, name: 'Lute', quantity: 3, attuned: true, identified: false, sessionPageId: null, notes: '' },
    ],
    coins: {},
  };

  async function render(role: CampaignRole) {
    const store = fakeStore(role, [member('me', role, role === 'player' ? [{ pageId: 'mine', title: 'Mine' }] : [])]);
    const { fixture, el } = mount(InventoryPage, store, [{ provide: PlayApi, useValue: { inventory: async () => inv } }]);
    await settle();
    fixture.detectChanges();
    const section = (name: string) => el.querySelector<HTMLElement>(`section[aria-label="${name}"]`)!;
    const editable = (name: string) => !!section(name).querySelector('input[aria-label^="Quantity of"]');
    return { el, section, editable };
  }

  it('lets a player manage only their own character', async () => {
    const { el, section, editable } = await render('player');
    expect([editable('Party'), editable('Mine'), editable('Theirs')]).toEqual([false, true, false]);
    expect(section('Theirs').textContent).toContain('×3');
    expect(section('Party').querySelector('button')).toBeNull();
    expect(el.textContent).not.toContain('identified');
  });

  it('lets game masters manage everything and identify items', async () => {
    const { el, editable } = await render('codm');
    expect([editable('Party'), editable('Mine'), editable('Theirs')]).toEqual([true, true, true]);
    expect(el.textContent).toContain('(unidentified)');
    expect(el.querySelectorAll('input[type=checkbox]').length).toBeGreaterThanOrEqual(3);
  });

  it('lists items as cards, not a table, with item-specific control names and 44 px targets', async () => {
    const { el, section } = await render('dm');
    expect(el.querySelector('table')).toBeNull();
    const card = section('Mine').querySelector('li')!;
    expect(card.textContent).toContain('Dagger');
    const names = [...card.querySelectorAll('[aria-label]')].map((e) => e.getAttribute('aria-label'));
    expect(names).toEqual(expect.arrayContaining(['Remove Dagger', 'Quantity of Dagger', 'Dagger attuned', 'Dagger identified', 'Give Dagger to']));
    expect(card.querySelector<HTMLElement>('button[aria-label="Remove Dagger"]')!.className).toContain('w-[44px]');
    expect(card.querySelector('input[aria-label="Dagger attuned"]')!.closest('label')!.className).toContain('min-h-[44px]');
  });
});
