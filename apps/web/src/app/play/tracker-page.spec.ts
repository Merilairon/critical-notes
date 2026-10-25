import { provideHttpClient } from '@angular/common/http';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { Combatant, TrackerAction, TrackerDto } from '@cn/shared';
import { CampaignStore } from '../campaign/campaign.store';
import { PlayApi } from './play-api';
import { TrackerPage } from './tracker-page';

const mk = (o: Partial<Combatant> & { id: string }): Combatant => ({ kind: 'monster', ref: null, name: o.id, initiative: 10, initBonus: 0, hp: 10, hpMax: 10, tempHp: 0, ac: 12, conditions: [], hidden: false, notes: '', ...o });

describe('TrackerPage', () => {
  afterEach(() => vi.unstubAllGlobals());

  async function setup(combatants: Combatant[], activeId: string | null = null, failWith?: Error) {
    vi.stubGlobal('EventSource', class { addEventListener() {} close() {} });
    let dto: TrackerDto = { id: 't', campaignId: 'c', encounterId: null, name: 'Fight', status: 'active', state: { round: 1, activeId, combatants }, revision: 1, updatedAt: 0 };
    const sent: TrackerAction[] = [];
    const playApi = {
      tracker: async () => dto,
      eventsUrl: () => '/e',
      act: async (_c: string, _t: string, a: TrackerAction) => {
        if (failWith) throw failWith;
        sent.push(a);
        dto = { ...dto, revision: dto.revision + 1 };
        return dto;
      },
    };
    TestBed.configureTestingModule({
      providers: [provideRouter([]), provideHttpClient(), { provide: PlayApi, useValue: playApi }, { provide: CampaignStore, useValue: { id: signal('c'), pagesOfType: () => [], byId: signal(new Map()) } }],
    });
    const fixture = TestBed.createComponent(TrackerPage);
    fixture.componentRef.setInput('trackerId', 't');
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    return { fixture, el: fixture.nativeElement as HTMLElement, sent };
  }

  it('shows the death panel with accessible names, and sends a typed roll', async () => {
    const { fixture, el, sent } = await setup([mk({ id: 'b', name: 'Brenna', kind: 'pc', hp: 0, dying: { successes: 0, failures: 0, status: 'dying' } })]);
    const row = el.querySelector('li[data-trk-id=b]')!;
    expect(row.textContent).toContain('0 of 3');
    expect(row.querySelector('button[aria-label="Nat 20: up at 1 HP, death save for Brenna"]')).not.toBeNull();
    const input = row.querySelector<HTMLInputElement>('input[aria-label="Death save d20 roll of Brenna"]')!;
    input.value = '21';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    fixture.detectChanges();
    expect(sent).toEqual([]);
    expect(input.getAttribute('aria-invalid')).toBe('true');
    input.value = '7';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    await fixture.whenStable();
    expect(sent).toEqual([{ type: 'deathSave', id: 'b', roll: 7 }]);
  });

  it('has no HP, More or conditions on the lair row, and a fixed hide name', async () => {
    const { el } = await setup([mk({ id: 'l', kind: 'lair', name: 'Lair actions', hp: null, hpMax: null, ac: null, hidden: true, initiative: 20 })]);
    const row = el.querySelector('li[data-trk-id=l]')!;
    expect(row.querySelector('[data-trk=hp]')).toBeNull();
    expect(row.querySelector('[data-trk=more]')).toBeNull();
    expect(row.textContent).not.toContain('+ condition');
    const hide = row.querySelector('button[aria-label="Hidden from players, Lair actions"]')!;
    expect(hide.getAttribute('aria-pressed')).toBe('true');
    expect(row.textContent).toContain('No creature is marked as in lair');
  });

  it('merges recharge chips, spends legendary actions and gives rows no panels they lack', async () => {
    const { fixture, el, sent } = await setup([
      mk({ id: 'd', name: 'Dragon', legendary: { perRound: 3, perRoundLair: 4, used: 0 }, recharge: [{ name: 'Fire Breath', min: 5, ready: true }, { name: 'Fire Breath', min: 5, ready: true }] }),
      mk({ id: 'k', name: 'Kobold', initiative: 3 }),
    ]);
    const dragon = el.querySelector('li[data-trk-id=d]')!;
    expect(dragon.querySelectorAll('button[aria-label^="Fire Breath"]').length).toBe(1);
    expect(el.querySelector('li[data-trk-id=k]')!.textContent).not.toContain('Legendary');
    dragon.querySelector<HTMLButtonElement>('button[aria-label="Spend 2 legendary actions of Dragon"]')!.click();
    await fixture.whenStable();
    expect(sent).toEqual([{ type: 'legendarySpend', id: 'd', amount: 2 }]);
  });

  it('gives each More panel its own lair hint id, and d on a stable PC says so', async () => {
    const { fixture, el } = await setup([mk({ id: 'a', name: 'A' }), mk({ id: 'b', name: 'B', initiative: 5 }), mk({ id: 'c', name: 'C', kind: 'pc', hp: 0, initiative: 1, dying: { successes: 3, failures: 0, status: 'stable' } })]);
    for (const id of ['a', 'b']) el.querySelector<HTMLButtonElement>(`li[data-trk-id=${id}] [data-trk=more]`)!.click();
    fixture.detectChanges();
    const ids = [...el.querySelectorAll('[id^=cn-trk-lair-hint]')].map((e) => e.id);
    expect(ids).toEqual(['cn-trk-lair-hint-a', 'cn-trk-lair-hint-b']);
    expect(el.querySelector('li[data-trk-id=b] [role=switch]')!.getAttribute('aria-describedby')).toBe('cn-trk-lair-hint-b');
    const all = [...el.querySelectorAll('[id]')].map((e) => e.id);
    expect(new Set(all).size).toBe(all.length);
    const btn = el.querySelector<HTMLElement>('li[data-trk-id=c] button')!;
    btn.focus();
    btn.dispatchEvent(new KeyboardEvent('keydown', { key: 'd', bubbles: true }));
    await fixture.whenStable();
    fixture.detectChanges();
    expect(el.querySelector('[role=status][data-seq]')!.textContent).toContain('This combatant is not making death saves.');
  });

  it('shows a failed action in the always-present alert of the sticky slot, without scrolling', async () => {
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    const { fixture, el } = await setup([mk({ id: 'a' })], null, new Error('The active combatant can only move after a combatant that acts later'));
    const alert = el.querySelector('div.sticky [role=alert]')!;
    expect(alert.textContent!.trim()).toBe('');
    el.querySelector<HTMLButtonElement>('button[data-trk=next]')!.click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(alert.textContent).toContain('can only move after');
    expect(scroll).not.toHaveBeenCalled();
  });
});
