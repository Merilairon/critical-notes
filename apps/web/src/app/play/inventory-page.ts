import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { COINS, MAX_ATTUNED, type Coin, type InventoryDto, type InventoryItemDto } from '@cn/shared';
import { CampaignStore } from '../campaign/campaign.store';
import { RefPicker } from '../campaign/ref-picker';
import { ContextService } from '../core/context.service';
import { errorMessage } from '../core/http.interceptor';
import { PlayApi } from './play-api';

/** The party's stash and each character's items and coins. */
@Component({
  selector: 'cn-inventory-page',
  imports: [RouterLink, RefPicker],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<div class="mx-auto w-full max-w-5xl p-4 sm:p-6">
    <h1 class="font-display text-3xl font-bold">Inventory</h1>
    @if (error()) {<p class="mt-2 text-sm text-accent" role="alert">{{ error() }}</p>}
    @if (inv(); as inv) {
      @for (o of inv.owners; track o.pageId) {
        <section class="mt-4 rounded-xl border border-line bg-panel p-3 sm:p-4" [attr.aria-label]="o.name">
          <div class="mb-2 flex flex-wrap items-center gap-2">
            <h2 class="min-w-0 flex-1 font-semibold [overflow-wrap:anywhere]">{{ o.pageId ? o.name : '🎒 Party stash' }}</h2>
            @if (o.pageId) {<span class="text-sm text-muted">Attuned {{ attunedCount(o.pageId) }}/{{ maxAttuned }}</span>}
          </div>
          <div class="mb-2 text-sm" aria-label="Coins">
            <div class="grid grid-cols-5 gap-1 text-center sm:flex sm:flex-wrap sm:gap-3 sm:text-left">
              @for (c of coins; track c) {<span class="min-w-0"><span class="font-mono font-semibold">{{ coinsOf(o.pageId)[c] }}</span> <span class="block text-muted sm:inline">{{ c }}</span></span>}
            </div>
            @if (canManage(o.pageId)) {
            <form class="mt-2 grid grid-cols-[minmax(5rem,1fr)_minmax(44px,6rem)] gap-2 sm:flex sm:items-center" (submit)="$event.preventDefault()">
              <input #amount type="number" inputmode="numeric" min="1" class="cn-input sm:w-28" placeholder="Amount" [attr.aria-label]="'Coins for ' + o.name" />
              <select #coin class="cn-input sm:w-auto" [attr.aria-label]="'Coin type for ' + o.name">@for (c of coins; track c) {<option [value]="c" [selected]="c === 'gp'">{{ c }}</option>}</select>
              <div class="col-span-2 grid grid-cols-2 gap-2 sm:contents">
                <button type="button" class="cn-btn" (click)="changeCoins(o.pageId, amount, coin.value, 1)">Add</button>
                <button type="button" class="cn-btn" (click)="changeCoins(o.pageId, amount, coin.value, -1)">Spend</button>
              </div>
            </form>
            }
          </div>
          <ul class="mt-2 space-y-2">
            @for (it of itemsOf(o.pageId); track it.id) {
              <li class="rounded-lg border border-line bg-bg p-3">
                <div class="flex items-start justify-between gap-2">
                  <div class="min-w-0 [overflow-wrap:anywhere]">
                    @if (it.itemUid) {<a class="cn-link font-semibold" [routerLink]="['/c', store.id(), 'reference', 'item', it.itemUid]">{{ it.name }}</a>} @else {<span class="font-semibold">{{ it.name }}</span>}
                    @if (!it.identified && store.isGm()) {<span class="ml-1 text-xs text-muted" title="Players see it as an unidentified item">(unidentified)</span>}
                    @if (it.sessionPageId) {<a class="ml-1 text-xs text-muted hover:text-accent" [routerLink]="['/c', store.id(), 'p', it.sessionPageId]">from {{ sessionTitle(it.sessionPageId) }}</a>}
                  </div>
                  @if (canManage(o.pageId)) {
                    <button type="button" class="cn-btn w-[44px] shrink-0 px-0!" (click)="remove(it)" [attr.aria-label]="'Remove ' + it.name">✕</button>
                  }
                </div>
                @if (canManage(o.pageId)) {
                  <div class="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 sm:flex sm:flex-wrap sm:items-center sm:gap-x-4">
                    <label class="col-span-2 flex items-center gap-2 text-sm sm:col-span-1">Qty <input type="number" inputmode="numeric" min="0" class="cn-input min-w-16 flex-1 sm:w-20 sm:flex-none" [value]="it.quantity" [attr.aria-label]="'Quantity of ' + it.name" (change)="update(it, { quantity: +$any($event.target).value })" /></label>
                    @if (o.pageId) {
                      <label class="flex min-h-[44px] items-center gap-3 text-sm"><input type="checkbox" [checked]="it.attuned" [attr.aria-label]="it.name + ' attuned'" (change)="update(it, { attuned: $any($event.target).checked })" /> Attuned</label>
                    }
                    @if (store.isGm()) {
                      <label class="flex min-h-[44px] items-center gap-3 text-sm"><input type="checkbox" [checked]="it.identified" [attr.aria-label]="it.name + ' identified'" (change)="update(it, { identified: $any($event.target).checked })" /> Identified</label>
                    }
                    <label class="col-span-2 flex flex-col gap-1 text-sm sm:flex-row sm:items-center sm:gap-2">Give to
                      <select class="cn-input sm:w-auto" [attr.aria-label]="'Give ' + it.name + ' to'" (change)="update(it, { ownerPageId: $any($event.target).value || null })">
                        @for (to of inv.owners; track to.pageId) {<option [value]="to.pageId ?? ''" [selected]="to.pageId === it.ownerPageId">{{ to.name }}</option>}
                      </select>
                    </label>
                  </div>
                } @else {
                  <p class="mt-1 text-sm text-muted"><span class="font-mono">×{{ it.quantity }}</span>{{ it.attuned ? ' · attuned' : '' }}</p>
                }
              </li>
            } @empty {
              <li class="py-2 text-muted">Nothing yet.</li>
            }
          </ul>
          @if (canManage(o.pageId)) {
            @if (addingFor() === (o.pageId ?? 'party')) {
              <div class="mt-2 grid gap-2 sm:grid-cols-[1fr_auto]">
                <cn-ref-picker kind="item" placeholder="Search items…" (selected)="addItem(o.pageId, $event, '')" />
                <form class="flex gap-2" (submit)="$event.preventDefault(); addItem(o.pageId, null, custom.value)">
                  <input #custom class="cn-input min-w-0 flex-1" placeholder="Or a custom item" aria-label="Custom item" />
                  <button type="submit" class="cn-btn">Add</button>
                </form>
              </div>
            } @else {
              <button type="button" class="cn-btn mt-2 w-full sm:w-auto" (click)="addingFor.set(o.pageId ?? 'party')">+ Item</button>
            }
          }
        </section>
      }
    }
  </div>`,
})
export class InventoryPage {
  private readonly api = inject(PlayApi);
  protected readonly store = inject(CampaignStore);
  protected readonly context = inject(ContextService);
  protected readonly inv = signal<InventoryDto | null>(null);
  protected readonly error = signal('');
  protected readonly addingFor = signal<string | null>(null);
  protected readonly coins = COINS;
  protected readonly maxAttuned = MAX_ATTUNED;
  private readonly sessions = computed(() => new Map(this.store.pages().map((p) => [p.id, p.title])));

  /** Players manage the belongings of their own characters only. */
  private readonly ownCharacters = computed(() => new Set(this.store.members().find((m) => m.userId === this.store.myId())?.characters.map((c) => c.pageId) ?? []));
  protected canManage(ownerPageId: string | null) {
    return this.store.isGm() || (ownerPageId !== null && this.ownCharacters().has(ownerPageId));
  }

  constructor() {
    void this.reload();
    void this.store.loadMembers().catch(() => undefined);
  }

  private async reload() {
    try {
      this.inv.set(await this.api.inventory(this.store.id()!));
    } catch (err) {
      this.error.set(errorMessage(err));
    }
  }

  protected itemsOf(ownerPageId: string | null): InventoryItemDto[] {
    return (this.inv()?.items ?? []).filter((i) => i.ownerPageId === ownerPageId);
  }
  protected coinsOf(ownerPageId: string | null) {
    return this.inv()?.coins[ownerPageId ?? 'party'] ?? { cp: 0, sp: 0, ep: 0, gp: 0, pp: 0 };
  }
  protected attunedCount(ownerPageId: string) {
    return this.itemsOf(ownerPageId).filter((i) => i.attuned).length;
  }
  protected sessionTitle(id: string) {
    return this.sessions().get(id) ?? 'a session';
  }

  private async run(fn: () => Promise<unknown>) {
    this.error.set('');
    try {
      await fn();
    } catch (err) {
      this.error.set(errorMessage(err));
    }
    await this.reload();
  }

  protected update(it: InventoryItemDto, patch: Parameters<PlayApi['updateItem']>[2]) {
    void this.run(() => this.api.updateItem(this.store.id()!, it.id, patch));
  }
  protected remove(it: InventoryItemDto) {
    void this.run(() => this.api.deleteItem(this.store.id()!, it.id));
  }
  protected addItem(ownerPageId: string | null, itemUid: string | null, name: string) {
    if (!itemUid && !name.trim()) return;
    this.addingFor.set(null);
    void this.run(() => this.api.addItem(this.store.id()!, { ownerPageId, itemUid, name: name.trim() }));
  }
  protected changeCoins(ownerPageId: string | null, amountInput: HTMLInputElement, coin: string, sign: 1 | -1) {
    const amount = Number(amountInput.value);
    if (!Number.isInteger(amount) || amount <= 0) return;
    amountInput.value = '';
    void this.run(() => this.api.changeCoins(this.store.id()!, ownerPageId, { [coin as Coin]: sign * amount }));
  }
}
