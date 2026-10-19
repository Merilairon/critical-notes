import { provideHttpClient } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { PlayerTrackerView } from '@cn/shared';
import { PlayApi } from './play-api';
import { TrackerPlayerView } from './tracker-player';

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
});
