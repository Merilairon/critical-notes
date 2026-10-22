/** Editor views for the encounter and loot blocks. */
import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { COINS, type Coin, type EncounterDto, type EncounterSummaryDto } from '@cn/shared';
import { AngularNodeViewComponent } from 'ngx-tiptap';
import { CampaignStore } from '../campaign/campaign.store';
import { RefPicker } from '../campaign/ref-picker';
import { ContextService } from '../core/context.service';
import { errorMessage } from '../core/http.interceptor';
import { EDITOR_CONTEXT } from '../editor/editor-context';
import { creatureSummary, encounterDifficulty } from './combat-math';
import { PlayApi } from './play-api';

/** An encounter on a page: pick or create one, see its creatures and difficulty, run it. Never shown to players. */
@Component({
  selector: 'cn-encounter-block-view',
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<div class="cn-embed" contenteditable="false" [class.ring-2]="selected()">
    @if (encounter(); as e) {
      <div class="flex flex-wrap items-center gap-2">
        <span class="text-xl">⚔️</span>
        <span class="min-w-0 flex-1">
          <span class="block font-semibold">{{ e.name }}</span>
          <span class="block text-sm text-muted">{{ summary() || 'No creatures yet' }}</span>
        </span>
        @if (difficulty(); as d) {<span class="rounded-full border border-line px-2 py-0.5 text-xs capitalize" title="Difficulty for the party">{{ d }}</span>}
        <a class="rounded-md border border-line px-2 py-1 text-sm hover:border-accent" [routerLink]="['/c', store?.id(), 'encounters', e.id]">Edit</a>
        <button type="button" class="rounded-md bg-accent px-3 py-1 text-sm font-semibold text-accent-ink" (click)="run(e.id)">Run</button>
      </div>
    } @else if (encounterId()) {
      <p class="text-sm text-muted">{{ error() || 'Loading encounter…' }}</p>
    } @else if (store?.id()) {
      <div class="flex flex-wrap items-center gap-2 text-sm">
        <span class="text-xl">⚔️</span>
        <button type="button" class="rounded-md border border-line px-3 py-1 hover:border-accent" (click)="create()">New encounter</button>
        @if (existing().length) {
          <select class="cn-prop-input" aria-label="Use an existing encounter" (change)="use($any($event.target).value)">
            <option value="">or use an existing one…</option>
            @for (x of existing(); track x.id) {<option [value]="x.id">{{ x.name }}</option>}
          </select>
        }
        <span class="text-xs text-muted">Only you see this block.</span>
      </div>
    } @else {
      <p class="text-sm text-muted">Encounter (available inside a campaign)</p>
    }
  </div>`,
})
export class EncounterBlockView extends AngularNodeViewComponent {
  protected readonly store = inject(CampaignStore, { optional: true });
  private readonly api = inject(PlayApi);
  private readonly router = inject(Router);
  private readonly context = inject(ContextService);
  protected readonly encounterId = computed(() => (this.node().attrs['encounterId'] as string | null) ?? null);
  protected readonly encounter = signal<EncounterDto | null>(null);
  protected readonly existing = signal<EncounterSummaryDto[]>([]);
  protected readonly error = signal('');
  protected readonly summary = computed(() => {
    const e = this.encounter();
    return e ? creatureSummary(e.creatures, e.resolved) : '';
  });
  protected readonly difficulty = computed(() => {
    const e = this.encounter();
    if (!e || !e.creatures.length) return null;
    return encounterDifficulty(this.context.ruleset(), e.partyLevels, e.creatures, e.resolved).difficulty;
  });

  constructor() {
    super();
    effect(() => {
      const id = this.encounterId();
      const campaignId = this.store?.id();
      untracked(() => void this.load(campaignId ?? null, id));
    });
  }

  private async load(campaignId: string | null, id: string | null) {
    if (!campaignId) return;
    this.error.set('');
    if (!id) {
      this.encounter.set(null);
      this.existing.set((await this.api.encounters(campaignId).catch(() => ({ encounters: [] }))).encounters);
      return;
    }
    try {
      this.encounter.set(await this.api.encounter(campaignId, id));
    } catch (err) {
      this.error.set(`The encounter could not be loaded (${errorMessage(err)}).`);
    }
  }

  protected async create() {
    const e = await this.api.createEncounter(this.store!.id()!, { name: 'New encounter' });
    this.updateAttributes()({ encounterId: e.id });
    await this.router.navigate(['/c', this.store!.id(), 'encounters', e.id]);
  }

  protected use(id: string) {
    if (id) this.updateAttributes()({ encounterId: id });
  }

  protected async run(id: string) {
    const t = await this.api.startEncounter(this.store!.id()!, id);
    await this.router.navigate(['/c', this.store!.id(), 'trackers', t.id]);
  }
}

interface LootItem {
  uid: string | null;
  name: string;
  qty: number;
  note: string;
}

/** Loot on a page: items and coins, and handing them to the party or a character (once). */
@Component({
  selector: 'cn-loot-block-view',
  imports: [RefPicker, DatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<div class="cn-embed" contenteditable="false" [class.ring-2]="selected()">
    <div class="mb-2 flex items-center gap-2"><span class="text-xl">💰</span><span class="font-semibold">Loot</span>
      @if (awarded(); as a) {<span class="ml-auto text-xs text-muted">Awarded to {{ ownerName(a.to) }} · {{ a.at | date: 'short' }}</span>}
    </div>
    <ul class="flex flex-col gap-1 text-sm">
      @for (it of items(); track $index; let i = $index) {
        <li class="flex flex-wrap items-center gap-2">
          <input type="number" min="1" class="cn-prop-input w-16" [value]="it.qty" [attr.aria-label]="'Quantity of ' + (it.name || 'item')" (change)="patchItem(i, { qty: Math.max(1, +$any($event.target).value || 1) })" />
          <span class="min-w-0 flex-1 truncate">{{ it.name || it.uid }}</span>
          <input class="cn-prop-input w-40" [value]="it.note" placeholder="Note" [attr.aria-label]="'Note for ' + (it.name || 'item')" (change)="patchItem(i, { note: $any($event.target).value })" />
          <button type="button" class="text-muted hover:text-accent" (click)="removeItem(i)" [attr.aria-label]="'Remove ' + (it.name || 'item')">✕</button>
        </li>
      }
    </ul>
    @if (adding()) {
      <div class="mt-2 grid gap-2 sm:grid-cols-[1fr_auto]">
        <cn-ref-picker kind="item" placeholder="Search items…" (selected)="addItem($event, '')" />
        <form class="flex gap-1" (submit)="$event.preventDefault(); addItem(null, custom.value)">
          <input #custom class="cn-prop-input" placeholder="Or a custom item" aria-label="Custom loot item" />
          <button type="submit" class="rounded border border-line px-2">Add</button>
        </form>
      </div>
    } @else {
      <button type="button" class="mt-1 text-xs text-muted hover:text-accent" (click)="adding.set(true)">+ Item</button>
    }
    <div class="mt-2 flex flex-wrap items-center gap-2 text-sm" aria-label="Coins">
      @for (c of coins; track c) {
        <label class="flex items-center gap-1"><input type="number" min="0" class="cn-prop-input w-16" [value]="coinValue(c)" (change)="setCoin(c, $any($event.target).value)" [attr.aria-label]="c" /> {{ c }}</label>
      }
    </div>
    @if (store?.id()) {
      <div class="mt-3 flex flex-wrap items-center gap-2 border-t border-line pt-2 text-sm">
        <span class="text-muted">Give to</span>
        <select class="cn-prop-input" [value]="to()" (change)="to.set($any($event.target).value)" aria-label="Give loot to">
          <option value="party">Party stash</option>
          @for (pc of pcs(); track pc.id) {<option [value]="pc.id">{{ pc.title }}</option>}
        </select>
        <button type="button" class="rounded-md bg-accent px-3 py-1 font-semibold text-accent-ink disabled:opacity-50" [disabled]="busy() || (!items().length && !hasCoins())" (click)="award()">
          {{ awarded() ? 'Award again' : 'Award' }}
        </button>
        @if (message()) {<span class="text-xs" [class.text-accent]="isError()" role="status">{{ message() }}</span>}
      </div>
    }
  </div>`,
})
export class LootBlockView extends AngularNodeViewComponent {
  protected readonly store = inject(CampaignStore, { optional: true });
  private readonly api = inject(PlayApi);
  private readonly editorContext = inject(EDITOR_CONTEXT);
  protected readonly coins = COINS;
  protected readonly Math = Math;
  protected readonly adding = signal(false);
  protected readonly to = signal('party');
  protected readonly busy = signal(false);
  protected readonly message = signal('');
  protected readonly isError = signal(false);
  protected readonly items = computed(() => (this.node().attrs['items'] as LootItem[] | undefined) ?? []);
  protected readonly awarded = computed(() => (this.node().attrs['awarded'] as { at: number; to: string } | null) ?? null);
  protected readonly pcs = computed(() => this.store?.pagesOfType('pc') ?? []);
  protected readonly hasCoins = computed(() => COINS.some((c) => this.coinValue(c) > 0));

  protected coinValue(c: Coin): number {
    return ((this.node().attrs['coins'] as Record<string, number> | undefined) ?? {})[c] ?? 0;
  }
  protected ownerName(to: string) {
    return to === 'party' ? 'the party' : (this.store?.byId().get(to)?.title ?? 'a character');
  }
  private setItems(items: LootItem[]) {
    this.updateAttributes()({ items });
  }
  protected patchItem(i: number, change: Partial<LootItem>) {
    this.setItems(this.items().map((it, j) => (j === i ? { ...it, ...change } : it)));
  }
  protected removeItem(i: number) {
    this.setItems(this.items().filter((_, j) => j !== i));
  }
  protected addItem(uid: string | null, name: string) {
    if (!uid && !name.trim()) return;
    const label = name.trim() || (uid ? uid.slice(uid.indexOf(':') + 1, uid.lastIndexOf('|')).replace(/\b\w/g, (m) => m.toUpperCase()) : '');
    this.setItems([...this.items(), { uid, name: label, qty: 1, note: '' }]);
    this.adding.set(false);
  }
  protected setCoin(c: Coin, raw: string) {
    const coins = { ...((this.node().attrs['coins'] as Record<string, number> | undefined) ?? {}), [c]: Math.max(0, Math.floor(Number(raw) || 0)) };
    this.updateAttributes()({ coins });
  }

  protected async award() {
    const campaignId = this.store?.id();
    const pageId = this.editorContext.pageId();
    const blockId = String(this.node().attrs['id'] ?? '');
    if (!campaignId || !pageId || !blockId) return;
    this.busy.set(true);
    this.message.set('');
    try {
      await this.api.awardLoot(campaignId, {
        pageId,
        blockId,
        to: this.to(),
        items: this.items(),
        coins: (this.node().attrs['coins'] as Record<string, number> | undefined) ?? {},
        again: !!this.awarded(),
      });
      this.updateAttributes()({ awarded: { at: Date.now(), to: this.to() } });
      this.isError.set(false);
      this.message.set('Added to the inventory');
    } catch (err) {
      this.isError.set(true);
      this.message.set(errorMessage(err));
    } finally {
      this.busy.set(false);
    }
  }
}
