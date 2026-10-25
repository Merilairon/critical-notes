import { NgTemplateOutlet } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { afterNextRender, ChangeDetectionStrategy, Component, computed, DestroyRef, effect, inject, Injector, input, signal, untracked, type OnDestroy } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { monsterCombatStats, parseStatblockCombatFacts } from '@cn/fivetools';
import { sortCombatants, TRACKER_CONDITIONS, type Combatant, type CombatantInput, type EntityDto, type RechargeRoll, type TrackerAction, type TrackerDto } from '@cn/shared';
import { firstValueFrom } from 'rxjs';
import { api } from '../core/api';
import { ContextService } from '../core/context.service';
import { CampaignStore } from '../campaign/campaign.store';
import { RefPicker } from '../campaign/ref-picker';
import { ConfirmService } from '../core/confirm.service';
import { errorMessage } from '../core/http.interceptor';
import { parseHpInput } from './combat-math';
import { PlayApi } from './play-api';
import * as L from './tracker-logic';

/** The recharge rolls of one action, shown to the DM until the next ones or Dismiss. */
interface RechargeNote {
  round: number;
  rolls: RechargeRoll[];
}

const rowSel = (id: string, part: string) => `li[data-trk-id="${CSS.escape(id)}"] [data-trk="${part}"]`;

/**
 * The DM's initiative tracker: live, keyboard friendly. Page keys: n next turn, p previous, r roll initiative,
 * ? help; with focus inside a row: d, l, Shift+L, u, Shift+U. Design: docs/design/tracker-ui.md.
 */
@Component({
  selector: 'cn-tracker-page',
  imports: [RouterLink, RefPicker, NgTemplateOutlet],
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
  private readonly injector = inject(Injector);
  protected readonly store = inject(CampaignStore);

  protected readonly L = L;
  protected readonly tracker = signal<TrackerDto | null>(null);
  protected readonly error = signal('');
  protected readonly adding = signal<'monster' | 'pc' | 'custom' | 'lair' | null>(null);
  protected readonly conditionFor = signal<string | null>(null);
  protected readonly notesFor = signal<string | null>(null);
  protected readonly conditions = TRACKER_CONDITIONS;
  /** Rows whose More panel is open. */
  protected readonly moreFor = signal<ReadonlySet<string>>(new Set());
  protected readonly readyFor = signal<string | null>(null);
  protected readonly moveFor = signal<string | null>(null);
  protected readonly rollInvalid = signal<string | null>(null);
  protected readonly readyInvalid = signal<string | null>(null);
  /** Rows whose Critical hit box is ticked. */
  protected readonly critFor = signal<ReadonlySet<string>>(new Set());
  protected readonly lairMarks = signal<ReadonlySet<string>>(new Set());
  protected readonly helpOpen = signal(false);
  /** One sentence for screen readers per action; the sequence forces a render so equal sentences repeat. */
  protected readonly live = signal('');
  protected readonly liveSeq = signal(0);
  protected readonly wide = signal(true);
  private readonly note = signal<RechargeNote | null>(null);
  protected readonly noteAll = signal(false);
  private lastRollRevision = -1;
  private helpOpener: HTMLElement | null = null;

  protected readonly order = computed(() => sortCombatants(this.tracker()?.state.combatants ?? []));
  protected readonly ended = computed(() => this.tracker()?.status === 'ended');
  protected readonly started = computed(() => (this.tracker()?.state.round ?? 0) > 0);
  protected readonly playerViewLink = computed(() => ['/c', this.store.id(), 'trackers', this.trackerId(), 'view']);
  protected readonly pcs = computed(() => this.store.pagesOfType('pc'));
  protected readonly lairWarning = computed(() => L.lairNeedsCreature(this.order()));
  protected readonly monsters = computed(() => this.order().filter((c) => c.kind === 'monster'));
  protected readonly lairCandidates = computed(() => this.order().filter((c) => c.kind !== 'lair'));
  /** Recharge roll lines of the note, result in words first. */
  protected readonly noteLines = computed(() => {
    const combatants = this.tracker()?.state.combatants ?? [];
    return (this.note()?.rolls ?? []).map((r) => L.rechargeLine(combatants.find((c) => c.id === r.combatantId)?.name ?? 'A creature', r));
  });
  protected readonly noteRound = computed(() => this.note()?.round ?? 0);
  protected readonly noteVisible = computed(() => (this.noteAll() ? this.noteLines() : this.noteLines().slice(0, 2)));
  protected readonly noteHidden = computed(() => this.noteLines().length - this.noteVisible().length);

  private events: EventSource | null = null;

  constructor() {
    effect(() => {
      const id = this.trackerId();
      untracked(() => void this.load(id));
    });
    if (typeof matchMedia === 'function') {
      const mq = matchMedia('(min-width: 640px)');
      this.wide.set(mq.matches);
      const change = (e: MediaQueryListEvent) => this.wide.set(e.matches);
      mq.addEventListener('change', change);
      inject(DestroyRef).onDestroy(() => mq.removeEventListener('change', change));
    }
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
    this.events.addEventListener('state', (e) => this.receive(JSON.parse((e as MessageEvent<string>).data) as TrackerDto));
  }

  /** A state from the server: the recharge rolls it carries show once per revision (the own SSE echo does not double them). */
  private receive(dto: TrackerDto) {
    this.tracker.set(dto);
    if (dto.rolls?.length && dto.revision !== this.lastRollRevision) {
      this.lastRollRevision = dto.revision;
      this.note.set({ round: dto.state.round, rolls: dto.rolls });
      this.noteAll.set(false);
    }
  }

  /** Runs an action; true when the server accepted it. Nothing changes on screen until the server answers. */
  protected async act(action: TrackerAction): Promise<boolean> {
    this.error.set('');
    const prev = this.tracker();
    try {
      const next = await this.api.act(this.store.id()!, this.trackerId(), action);
      this.receive(next);
      if (prev) this.say(L.announce(action, prev.state, next.state));
      return true;
    } catch (err) {
      this.error.set(errorMessage(err));
      return false;
    }
  }

  /** Tells screen readers (empty first, then the sentence after a render, so the same sentence is read again). */
  protected say(message: string) {
    this.live.set('');
    this.liveSeq.update((n) => n + 1);
    if (message) afterNextRender(() => this.live.set(message), { injector: this.injector });
  }

  /** Moves focus to the first of these that exists once the page has rendered; never to the body. */
  private focusAfterRender(...selectors: string[]) {
    afterNextRender(
      () => {
        for (const s of selectors) {
          const el = document.querySelector<HTMLElement>(s);
          if (el) return el.focus();
        }
      },
      { injector: this.injector },
    );
  }

  protected setInitiative(c: Combatant, raw: string) {
    const n = raw.trim() === '' ? null : Number(raw);
    if (n === null || Number.isInteger(n)) void this.act({ type: 'update', id: c.id, patch: { initiative: n } });
  }

  protected async applyHp(c: Combatant, input: HTMLInputElement) {
    const change = parseHpInput(input.value);
    input.value = '';
    if (!change) return;
    let ok = false;
    switch (change.kind) {
      case 'damage': {
        const crit = L.showCrit(c) && this.critFor().has(c.id);
        ok = await this.act({ type: 'hp', id: c.id, change: -change.amount, ...(crit ? { crit: true } : {}) });
        break;
      }
      case 'heal':
        ok = await this.act({ type: 'hp', id: c.id, change: change.amount });
        break;
      case 'set':
        ok = await this.act({ type: 'update', id: c.id, patch: { hp: change.amount } });
        break;
      case 'temp':
        ok = await this.act({ type: 'update', id: c.id, patch: { tempHp: change.amount } });
        break;
    }
    if (ok) this.toggleSet(this.critFor, c.id, false);
  }

  private toggleSet(sig: { update: (fn: (s: ReadonlySet<string>) => ReadonlySet<string>) => void }, id: string, on: boolean) {
    sig.update((s) => {
      const next = new Set(s);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  protected setCrit(c: Combatant, on: boolean) {
    this.toggleSet(this.critFor, c.id, on);
  }

  protected addCondition(c: Combatant, name: string, rounds: string) {
    if (!name.trim()) return;
    void this.act({ type: 'addCondition', id: c.id, name: name.trim(), rounds: rounds ? Number(rounds) : null });
    this.conditionFor.set(null);
  }

  // region Death saves

  /** Records the d20 typed in the field (Enter or Record roll). */
  protected async recordRoll(c: Combatant, input: HTMLInputElement) {
    const roll = L.parseRoll(input.value);
    if (roll === null) {
      this.rollInvalid.set(c.id);
      this.say('Enter 1 to 20');
      return;
    }
    this.rollInvalid.set(null);
    if (await this.sendDeathSave(c, roll)) input.value = '';
  }

  /** The d20 is rolled here, in the browser: never through the shared dice log the players can see. */
  protected rollForMe(c: Combatant) {
    return this.sendDeathSave(c, L.rollD20());
  }

  protected async sendDeathSave(c: Combatant, roll: number) {
    const wasActive = c.id === this.tracker()?.state.activeId;
    if (!(await this.act({ type: 'deathSave', id: c.id, roll }))) return false;
    if (roll === 20) this.focusAfterRender(rowSel(c.id, 'hp'), rowSel(c.id, 'more'));
    else if (wasActive) this.focusAfterRender('[data-trk="next"]');
    else this.focusAfterRender(rowSel(c.id, 'roll'), rowSel(c.id, 'more'));
    return true;
  }

  protected adjustCount(c: Combatant, which: 'successes' | 'failures', delta: 1 | -1) {
    return this.act({ type: 'deathSaveAdjust', id: c.id, [which]: delta });
  }

  /** A status button (Stable, Clear counts, Back to dying, Dead, Start death saves): focus stays in the panel. */
  protected async setDeathStatus(c: Combatant, change: { reset?: boolean; status?: 'dying' | 'stable' | 'dead' }) {
    if (await this.act({ type: 'deathSaveAdjust', id: c.id, ...change })) this.focusAfterRender(rowSel(c.id, 'ds-status'), rowSel(c.id, 'roll'), rowSel(c.id, 'more'));
  }

  protected rollEscape(e: Event, c: Combatant) {
    e.preventDefault();
    document.querySelector<HTMLElement>(rowSel(c.id, 'more'))?.focus();
  }

  // endregion

  // region More panel, Ready, Move after

  protected toggleMore(c: Combatant) {
    this.toggleSet(this.moreFor, c.id, !this.moreFor().has(c.id));
    if (!this.moreFor().has(c.id)) {
      if (this.readyFor() === c.id) this.readyFor.set(null);
      if (this.moveFor() === c.id) this.moveFor.set(null);
    }
  }

  protected closeMore(e: Event, c: Combatant) {
    e.preventDefault();
    e.stopPropagation();
    this.toggleSet(this.moreFor, c.id, false);
    if (this.readyFor() === c.id) this.readyFor.set(null);
    if (this.moveFor() === c.id) this.moveFor.set(null);
    document.querySelector<HTMLElement>(rowSel(c.id, 'more'))?.focus();
  }

  protected closeReady(e: Event, c: Combatant) {
    e.preventDefault();
    e.stopPropagation();
    this.readyFor.set(null);
    this.readyInvalid.set(null);
    this.focusAfterRender(rowSel(c.id, 'ready-open'), rowSel(c.id, 'more'));
  }

  protected async setReady(c: Combatant, trigger: string, spell: boolean) {
    const text = trigger.trim();
    if (!text) {
      this.readyInvalid.set(c.id);
      this.say('Enter a trigger');
      return;
    }
    this.readyInvalid.set(null);
    if (await this.act({ type: 'ready', id: c.id, trigger: text, spell })) {
      this.readyFor.set(null);
      this.focusAfterRender(rowSel(c.id, 'more'));
    }
  }

  protected async clearReady(c: Combatant) {
    if (await this.act({ type: 'readyClear', id: c.id })) this.focusAfterRender(rowSel(c.id, 'more'));
  }

  protected async moveAfter(c: Combatant, afterId: string) {
    if (!afterId) return;
    if (await this.act({ type: 'moveAfter', id: c.id, afterId })) {
      this.moveFor.set(null);
      this.focusAfterRender(rowSel(c.id, 'more'));
    }
  }

  protected setInLair(c: Combatant) {
    return this.act({ type: 'setInLair', id: c.id, inLair: !c.inLair });
  }

  protected toggleDeathFlag(c: Combatant) {
    return this.act({ type: 'update', id: c.id, patch: { deathSaves: !c.deathSaves } });
  }

  // endregion

  // region Lair row

  protected toggleLairMark(id: string, on: boolean) {
    this.toggleSet(this.lairMarks, id, on);
  }

  protected markAllMonsters() {
    this.lairMarks.set(new Set(this.monsters().map((c) => c.id)));
  }

  protected async addLair(name: string) {
    const ok = await this.act({ type: 'lairAdd', name: name.trim() || 'Lair actions', ref: null, markInLair: [...this.lairMarks()] });
    if (ok) {
      this.lairMarks.set(new Set());
      this.adding.set(null);
    }
  }

  // endregion

  // region Recharge note, help

  protected dismissNote() {
    this.note.set(null);
    this.noteAll.set(false);
  }

  protected noteEscape(e: Event) {
    e.preventDefault();
    this.dismissNote();
  }

  protected openHelp() {
    const active = document.activeElement;
    this.helpOpener = active instanceof HTMLElement && active !== document.body ? active : null;
    this.helpOpen.set(true);
    this.focusAfterRender('#cn-trk-help-h');
  }

  protected closeHelp(e?: Event) {
    e?.preventDefault();
    this.helpOpen.set(false);
    const opener = this.helpOpener && this.helpOpener.isConnected ? this.helpOpener : null;
    this.helpOpener = null;
    afterNextRender(() => (opener ?? document.querySelector<HTMLElement>('[data-trk="help-btn"]'))?.focus(), { injector: this.injector });
  }

  protected toggleHelp() {
    if (this.helpOpen()) this.closeHelp();
    else this.openHelp();
  }

  // endregion

  /** A monster with its statblock's numbers (within the campaign's rules and homebrew). */
  protected async addMonster(uid: string | null) {
    if (!uid) return;
    try {
      const entity = await firstValueFrom(this.http.get<EntityDto>(api.entity(uid), { params: this.context.params() }));
      const stats = monsterCombatStats(entity.data);
      const facts = parseStatblockCombatFacts(entity.data);
      await this.addCombatant({
        kind: 'monster',
        ref: entity.uid,
        name: entity.name,
        hpMax: stats.hp,
        ac: stats.ac,
        initBonus: stats.initBonus,
        // The input rejects null: leave the fields out when the statblock has none
        legendary: facts.legendary ?? undefined,
        resistance: facts.resistance ?? undefined,
        recharge: facts.recharge.length ? facts.recharge : undefined,
      });
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

  protected async removeCombatant(c: Combatant) {
    const order = this.order();
    const ix = order.findIndex((x) => x.id === c.id);
    const neighbour = order[ix + 1] ?? order[ix - 1];
    if (!(await this.act({ type: 'remove', id: c.id }))) return;
    this.focusAfterRender(...(neighbour ? [`li[data-trk-id="${CSS.escape(neighbour.id)}"] input`] : []), '[data-trk="add-monster"]');
  }

  protected async remove() {
    if (!(await this.confirm.ask({ title: 'Delete tracker?', message: 'Delete this tracker?', confirmLabel: 'Delete tracker' }))) return;
    await this.api.deleteTracker(this.store.id()!, this.trackerId());
    await this.router.navigate(['/c', this.store.id(), 'encounters']);
  }

  /**
   * Page keys: n next turn, p previous, r roll missing initiative, ? help. Inside a row only: d death-save field,
   * l / Shift+L spend / give back a legendary action, u / Shift+U use / give back Legendary Resistance.
   * None of them while typing, in a dialog, or with a modifier.
   */
  protected onKey(e: KeyboardEvent) {
    const target = e.target as HTMLElement | null;
    if (e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented || this.ended() || this.confirm.request()) return;
    if (target && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.closest('[role="dialog"], [aria-modal]'))) return;
    const page: TrackerAction | null = e.key === 'n' ? { type: this.started() ? 'next' : 'start' } : e.key === 'p' ? { type: 'prev' } : e.key === 'r' ? { type: 'rollInitiative', which: 'missing' } : null;
    if (page) {
      e.preventDefault();
      void this.act(page);
      return;
    }
    if (e.repeat || !['?', 'd', 'l', 'L', 'u', 'U'].includes(e.key)) return;
    e.preventDefault();
    if (e.key === '?') return this.toggleHelp();
    const rowId = (document.activeElement as HTMLElement | null)?.closest('li[data-trk-id]')?.getAttribute('data-trk-id') ?? null;
    let c = rowId ? this.order().find((x) => x.id === rowId) : undefined;
    if (!c && (e.key === 'l' || e.key === 'L' || e.key === 'u' || e.key === 'U')) {
      // Browsers that do not focus a button on click: act on the only creature that has the counter
      const has = this.order().filter((x) => (e.key.toLowerCase() === 'l' ? x.legendary : x.resistance));
      if (has.length === 1) c = has[0];
    }
    if (!c) return this.say('Focus a combatant first.');
    if (e.key === 'd') {
      if (c.dying?.status !== 'dying' || !L.showDeathPanel(c)) return this.say('This combatant is not making death saves.');
      return document.querySelector<HTMLElement>(rowSel(c.id, 'roll'))?.focus();
    }
    if (e.key.toLowerCase() === 'l') {
      if (!c.legendary) return this.say(`${c.name} has no legendary actions.`);
      void this.act(e.key === 'L' ? { type: 'legendaryUndo', id: c.id, amount: 1 } : { type: 'legendarySpend', id: c.id, amount: 1 });
      return;
    }
    if (!c.resistance) return this.say(`${c.name} has no Legendary Resistance.`);
    void this.act({ type: 'legendaryResist', id: c.id, undo: e.key === 'U' });
  }

  protected hpPercent(c: Combatant) {
    return c.hp !== null && c.hpMax ? Math.max(0, Math.min(100, Math.round((c.hp / c.hpMax) * 100))) : 0;
  }

  ngOnDestroy() {
    this.events?.close();
  }
}
