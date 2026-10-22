import { HttpClient } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal, untracked, type OnDestroy } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { monsterCombatStats } from '@cn/fivetools';
import { sortCombatants, TRACKER_CONDITIONS, type Combatant, type CombatantInput, type EntityDto, type TrackerAction, type TrackerDto } from '@cn/shared';
import { firstValueFrom } from 'rxjs';
import { api } from '../core/api';
import { ContextService } from '../core/context.service';
import { CampaignStore } from '../campaign/campaign.store';
import { RefPicker } from '../campaign/ref-picker';
import { ConfirmService } from '../core/confirm.service';
import { errorMessage } from '../core/http.interceptor';
import { parseHpInput } from './combat-math';
import { PlayApi } from './play-api';

/** The DM's initiative tracker: live, keyboard friendly (n = next, p = previous, r = roll initiative). */
@Component({
  selector: 'cn-tracker-page',
  imports: [RouterLink, RefPicker],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './tracker-page.html',
  host: { '(document:keydown)': 'onKey($event)' },
})
export class TrackerPage implements OnDestroy {
  readonly trackerId = input.required<string>();
  private readonly confirm = inject(ConfirmService);
  private readonly api = inject(PlayApi);
  private readonly router = inject(Router);
  private readonly http = inject(HttpClient);
  private readonly context = inject(ContextService);
  protected readonly store = inject(CampaignStore);

  protected readonly tracker = signal<TrackerDto | null>(null);
  protected readonly error = signal('');
  protected readonly adding = signal<'monster' | 'pc' | 'custom' | null>(null);
  protected readonly conditionFor = signal<string | null>(null);
  protected readonly notesFor = signal<string | null>(null);
  protected readonly conditions = TRACKER_CONDITIONS;

  protected readonly order = computed(() => sortCombatants(this.tracker()?.state.combatants ?? []));
  protected readonly ended = computed(() => this.tracker()?.status === 'ended');
  protected readonly started = computed(() => (this.tracker()?.state.round ?? 0) > 0);
  protected readonly playerViewLink = computed(() => ['/c', this.store.id(), 'trackers', this.trackerId(), 'view']);
  protected readonly pcs = computed(() => this.store.pagesOfType('pc'));

  private events: EventSource | null = null;

  constructor() {
    effect(() => {
      const id = this.trackerId();
      untracked(() => void this.load(id));
    });
  }

  private async load(id: string) {
    const campaignId = this.store.id()!;
    try {
      this.tracker.set(await this.api.tracker(campaignId, id));
    } catch (err) {
      this.error.set(errorMessage(err));
      return;
    }
    // Live updates (other DM tabs; actions answered by the server)
    this.events?.close();
    this.events = new EventSource(this.api.eventsUrl(campaignId, id, 'dm'));
    this.events.addEventListener('state', (e) => this.tracker.set(JSON.parse((e as MessageEvent<string>).data) as TrackerDto));
  }

  protected async act(action: TrackerAction) {
    this.error.set('');
    try {
      this.tracker.set(await this.api.act(this.store.id()!, this.trackerId(), action));
    } catch (err) {
      this.error.set(errorMessage(err));
    }
  }

  protected setInitiative(c: Combatant, raw: string) {
    const n = raw.trim() === '' ? null : Number(raw);
    if (n === null || Number.isInteger(n)) void this.act({ type: 'update', id: c.id, patch: { initiative: n } });
  }

  protected applyHp(c: Combatant, input: HTMLInputElement) {
    const change = parseHpInput(input.value);
    input.value = '';
    if (!change) return;
    switch (change.kind) {
      case 'damage':
        void this.act({ type: 'hp', id: c.id, change: -change.amount });
        break;
      case 'heal':
        void this.act({ type: 'hp', id: c.id, change: change.amount });
        break;
      case 'set':
        void this.act({ type: 'update', id: c.id, patch: { hp: change.amount } });
        break;
      case 'temp':
        void this.act({ type: 'update', id: c.id, patch: { tempHp: change.amount } });
        break;
    }
  }

  protected addCondition(c: Combatant, name: string, rounds: string) {
    if (!name.trim()) return;
    void this.act({ type: 'addCondition', id: c.id, name: name.trim(), rounds: rounds ? Number(rounds) : null });
    this.conditionFor.set(null);
  }

  /** A monster with its statblock's numbers (within the campaign's rules and homebrew). */
  protected async addMonster(uid: string | null) {
    if (!uid) return;
    try {
      const entity = await firstValueFrom(this.http.get<EntityDto>(api.entity(uid), { params: this.context.params() }));
      const stats = monsterCombatStats(entity.data);
      await this.addCombatant({ kind: 'monster', ref: entity.uid, name: entity.name, hpMax: stats.hp, ac: stats.ac, initBonus: stats.initBonus });
    } catch (err) {
      this.error.set(errorMessage(err));
    }
  }

  protected async addPc(pageId: string) {
    const page = this.store.byId().get(pageId);
    if (page) await this.addCombatant({ kind: 'pc', ref: pageId, name: page.title });
  }

  protected async addCustom(name: string, hp: string, ac: string, init: string) {
    if (!name.trim()) return;
    await this.addCombatant({ kind: 'custom', name: name.trim(), hpMax: hp ? Number(hp) : null, ac: ac ? Number(ac) : null, initiative: init ? Number(init) : null });
  }

  private async addCombatant(c: CombatantInput) {
    await this.act({ type: 'add', combatants: [c] });
    this.adding.set(null);
  }

  protected async end() {
    if (await this.confirm.ask({ title: 'End combat?', message: 'End this combat? Player characters keep their current hit points.', confirmLabel: 'End combat' })) await this.act({ type: 'end' });
  }

  protected async remove() {
    if (!(await this.confirm.ask({ title: 'Delete tracker?', message: 'Delete this tracker?', confirmLabel: 'Delete tracker' }))) return;
    await this.api.deleteTracker(this.store.id()!, this.trackerId());
    await this.router.navigate(['/c', this.store.id(), 'encounters']);
  }

  /** n: next turn, p: previous, r: roll missing initiative (not while typing). */
  protected onKey(e: KeyboardEvent) {
    const target = e.target as HTMLElement | null;
    if (e.ctrlKey || e.metaKey || e.altKey || this.ended() || (target && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)))) return;
    const action: TrackerAction | null = e.key === 'n' ? { type: this.started() ? 'next' : 'start' } : e.key === 'p' ? { type: 'prev' } : e.key === 'r' ? { type: 'rollInitiative', which: 'missing' } : null;
    if (!action) return;
    e.preventDefault();
    void this.act(action);
  }

  protected hpPercent(c: Combatant) {
    return c.hp !== null && c.hpMax ? Math.max(0, Math.min(100, Math.round((c.hp / c.hpMax) * 100))) : 0;
  }

  ngOnDestroy() {
    this.events?.close();
  }
}
