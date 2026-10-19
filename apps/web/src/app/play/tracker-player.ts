import { ChangeDetectionStrategy, Component, effect, inject, input, signal, untracked, type OnDestroy } from '@angular/core';
import { Title } from '@angular/platform-browser';
import { RouterLink } from '@angular/router';
import type { PlayerTrackerView } from '@cn/shared';
import { errorMessage } from '../core/http.interceptor';
import { healthWordLabel } from './health';
import { PlayApi } from './play-api';

/**
 * The player view of a tracker, for a second screen at the table: initiative order and how hurt everyone
 * looks. It only ever receives the server's player projection (no hidden creatures, notes or monster HP).
 */
@Component({
  selector: 'cn-tracker-player',
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block min-h-full bg-bg' },
  template: `<div class="mx-auto w-full max-w-3xl p-4 pt-[max(1rem,env(safe-area-inset-top))] sm:p-8">
    <!-- The way back. Not a <header>: this screen has none by design (second screen at the table). -->
    <h1 class="sr-only">Initiative</h1>
    <div class="flex min-h-[44px] items-center">
      <a [routerLink]="['/c', campaignId()]" class="inline-flex min-h-[44px] items-center gap-1 rounded px-2 text-sm text-muted hover:text-ink">← Campaign</a>
    </div>
    @if (view(); as v) {
      <p class="text-center font-display text-2xl text-muted" aria-live="polite">{{ v.round ? 'Round ' + v.round : 'Waiting for combat to start' }}</p>
      <ol class="mt-4 flex flex-col gap-3">
        @for (c of v.combatants; track c.id) {
          <li class="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-2xl border-2 bg-panel px-3 py-3 text-lg sm:gap-x-4 sm:px-5 sm:text-xl" [class.border-accent]="c.id === v.activeId" [class.border-line]="c.id !== v.activeId" [class.bg-panel-2]="isDown(c)" [class.border-dashed]="isDown(c)" [attr.aria-current]="c.id === v.activeId ? 'true' : null">
            <span class="w-8 shrink-0 text-center font-mono font-bold text-muted sm:w-10">{{ c.initiative ?? '–' }}</span>
            <span class="min-w-0 flex-1 basis-32 [overflow-wrap:anywhere]">
              <span class="font-semibold" [class.line-through]="isDown(c)">{{ c.name }}</span>
              @if (c.conditions.length) {
                <span class="mt-1 flex flex-wrap gap-1 text-sm">
                  @for (cond of c.conditions; track cond.name) {<span class="rounded-full bg-panel-2 px-2">{{ cond.name }}</span>}
                </span>
              }
            </span>
            @if (c.hp && isDown(c)) {<span class="shrink-0 rounded-full border border-line px-3 py-0.5 text-base text-accent">Down</span>}
            @if (c.hp; as hp) {
              <span class="shrink-0 font-mono">{{ hp.current }}<span class="text-muted">/{{ hp.max ?? '?' }}</span>@if (hp.temp) {<span class="text-accent"> +{{ hp.temp }}</span>}</span>
            } @else if (c.health) {
              <span class="shrink-0 rounded-full border border-line px-3 py-0.5 text-base" [class.text-accent]="c.health === 'bloodied' || c.health === 'down'">{{ label(c.health) }}</span>
            }
          </li>
        } @empty {
          <li class="text-center text-muted">No one is in the fight yet.</li>
        }
      </ol>
    } @else if (error()) {
      <p class="text-center text-muted">{{ error() }}</p>
    } @else {
      <p class="text-center text-muted">Loading…</p>
    }
  </div>`,
})
export class TrackerPlayerView implements OnDestroy {
  readonly campaignId = input.required<string>();
  readonly trackerId = input.required<string>();
  private readonly api = inject(PlayApi);
  private readonly title = inject(Title);
  protected readonly view = signal<PlayerTrackerView | null>(null);
  protected readonly error = signal('');
  protected readonly label = healthWordLabel;
  protected isDown(c: PlayerTrackerView['combatants'][number]) {
    return c.health === 'down' || c.hp?.current === 0;
  }
  private events: EventSource | null = null;

  constructor() {
    this.title.setTitle('Initiative — Critical Notes');
    effect(() => {
      const [campaignId, trackerId] = [this.campaignId(), this.trackerId()];
      untracked(() => void this.connect(campaignId, trackerId));
    });
  }

  private async connect(campaignId: string, trackerId: string) {
    try {
      this.view.set(await this.api.playerView(campaignId, trackerId));
    } catch (err) {
      this.error.set(errorMessage(err));
      return;
    }
    this.events?.close();
    this.events = new EventSource(this.api.eventsUrl(campaignId, trackerId, 'player'));
    this.events.addEventListener('state', (e) => this.view.set(JSON.parse((e as MessageEvent<string>).data) as PlayerTrackerView));
  }

  ngOnDestroy() {
    this.events?.close();
  }
}
