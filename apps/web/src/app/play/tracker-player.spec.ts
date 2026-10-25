import { provideHttpClient } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { PlayerTrackerView } from '@cn/shared';
import { PlayApi } from './play-api';
import { describeChanges, TrackerPlayerView } from './tracker-player';

describe('TrackerPlayerView', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('has a way back to the campaign that is not inside a header (this screen has none)', async () => {
    vi.stubGlobal(
      'EventSource',
      class {
        addEventListener() {}
        close() {}
      },
    );
    const view = { round: 1, activeId: 'a', combatants: [{ id: 'a', name: 'Wren', initiative: 12, conditions: [], hp: null, health: 'unhurt' }, { id: 'b', name: 'Goblin', initiative: 5, conditions: [], hp: { current: 0, max: 7, temp: 0 }, health: null }] } as unknown as PlayerTrackerView;
    TestBed.configureTestingModule({
      providers: [provideRouter([]), provideHttpClient(), { provide: PlayApi, useValue: { playerView: async () => view, eventsUrl: () => '/events' } }],
    });
    const fixture = TestBed.createComponent(TrackerPlayerView);
    fixture.componentRef.setInput('campaignId', 'c1');
    fixture.componentRef.setInput('trackerId', 't1');
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const back = el.querySelector('a')!;
    expect(back.textContent).toContain('← Campaign');
    expect(back.getAttribute('href')).toBe('/c/c1');
    expect(back.closest('header')).toBeNull();
    expect(el.querySelector('header')).toBeNull();
    expect(el.textContent).toContain('Wren');
    expect(el.querySelector('h1')!.textContent).toBe('Initiative');
    const rows = el.querySelectorAll('li');
    expect(rows[1]!.classList.contains('opacity-50')).toBe(false);
    expect(rows[1]!.querySelector('.line-through')!.textContent).toContain('Goblin');
    expect(rows[1]!.textContent).toContain('Down');
    expect(rows[0]!.querySelector('.line-through')).toBeNull();
  });

  it('shows death saves and readied for PCs, strikes through only the dead, and shows a lair row', async () => {
    vi.stubGlobal('EventSource', class { addEventListener() {} close() {} });
    const base = { conditions: [], health: null, readied: null, dying: null };
    const view = {
      round: 1,
      activeId: null,
      combatants: [
        { ...base, id: 'a', name: 'Brenna', kind: 'pc', initiative: 18, hp: { current: 0, max: 31, temp: 0 }, dying: { successes: 2, failures: 1, status: 'dying' }, readied: { trigger: 'ZZ-TRIGGER' } },
        { ...base, id: 'b', name: 'Corin', kind: 'pc', initiative: 12, hp: { current: 0, max: 20, temp: 0 }, dying: { successes: 0, failures: 3, status: 'dead' } },
        { ...base, id: 'c', name: 'Lair actions', kind: 'lair', initiative: 20, hp: null },
      ],
    } as unknown as PlayerTrackerView;
    TestBed.configureTestingModule({ providers: [provideRouter([]), provideHttpClient(), { provide: PlayApi, useValue: { playerView: async () => view, eventsUrl: () => '/events' } }] });
    const fixture = TestBed.createComponent(TrackerPlayerView);
    fixture.componentRef.setInput('campaignId', 'c1');
    fixture.componentRef.setInput('trackerId', 't1');
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    const rows = (fixture.nativeElement as HTMLElement).querySelectorAll('li');
    expect(rows[0]!.textContent).toContain('Dying');
    expect(rows[0]!.textContent).toContain('Successes');
    expect(rows[0]!.textContent).toContain('2 of 3');
    expect(rows[0]!.textContent).toContain('Readied: ZZ-TRIGGER');
    expect(rows[0]!.querySelector('.line-through')).toBeNull();
    expect(rows[1]!.querySelector('.line-through')!.textContent).toContain('Corin');
    expect(rows[1]!.textContent).toContain('Dead');
    expect(rows[2]!.textContent).toContain('Lair actions');
    expect(rows[2]!.textContent).not.toContain('Down');
  });
});

describe('describeChanges', () => {
  it('announces only changes', () => {
    const c = (dying: unknown, readied: unknown = null) => ({ round: 1, activeId: null, combatants: [{ id: 'a', name: 'Brenna', kind: 'pc', initiative: 1, hp: null, health: null, conditions: [], dying, readied }] }) as unknown as PlayerTrackerView;
    expect(describeChanges(c(null), c(null))).toBe('');
    expect(describeChanges(c({ successes: 1, failures: 0, status: 'dying' }), c({ successes: 2, failures: 0, status: 'dying' }))).toBe('Brenna: 2 successes, 0 failures.');
    expect(describeChanges(c({ successes: 2, failures: 0, status: 'dying' }), c({ successes: 3, failures: 0, status: 'stable' }))).toBe('Brenna is stable.');
    expect(describeChanges(c(null), c(null, { trigger: 'x' }))).toBe('Brenna readied an action: x.');
  });
});
