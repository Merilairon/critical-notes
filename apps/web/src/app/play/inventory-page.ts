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
            <h2 class="flex-1 font-semibold">{{ o.pageId ? o.name : '🎒 Party stash' }}</h2>
            @if (o.pageId) {<span class="text-xs text-muted">Attuned {{ attunedCount(o.pageId) }}/{{ maxAttuned }}</span>}
          </div>
          <div class="mb-2 flex flex-wrap items-center gap-3 text-sm" aria-label="Coins">
            @for (c of coins; track c) {<span><span class="font-mono font-semibold">{{ coinsOf(o.pageId)[c] }}</span> <span class="text-muted">{{ c }}</span></span>}
            @if (canManage(o.pageId)) {
            <form class="ml-auto flex items-center gap-1" (submit)="$event.preventDefault()">
              <input #amount type="number" min="1" class="cn-prop-input w-24" placeholder="Amount" [attr.aria-label]="'Coins for ' + o.name" />
              <select #coin class="cn-prop-input" [attr.aria-label]="'Coin type for ' + o.name">@for (c of coins; track c) {<option [value]="c" [selected]="c === 'gp'">{{ c }}</option>}</select>
              <button type="button" class="rounded border border-line px-2 py-0.5" (click)="changeCoins(o.pageId, amount, coin.value, 1)">Add</button>
              <button type="button" class="rounded border border-line px-2 py-0.5" (click)="changeCoins(o.pageId, amount, coin.value, -1)">Spend</button>
            </form>
            }
          </div>
          <table class="w-full text-sm">
            <tbody>
              @for (it of itemsOf(o.pageId); track it.id) {
                <tr class="border-t border-line">
                  <td class="py-1 pr-2">
                    @if (it.itemUid) {<a class="cn-link" [routerLink]="['/c', store.id(), 'reference', 'item', it.itemUid]">{{ it.name }}</a>} @else {<span>{{ it.name }}</span>}
                    @if (!it.identified && store.isGm()) {<span class="ml-1 text-xs text-muted" title="Players see it as an unidentified item">(unidentified)</span>}
                    @if (it.sessionPageId) {<a class="ml-1 text-xs text-muted hover:text-accent" [routerLink]="['/c', store.id(), 'p', it.sessionPageId]">from {{ sessionTitle(it.sessionPageId) }}</a>}
                  </td>
                  @if (canManage(o.pageId)) {
                    <td class="w-20 pr-2"><input type="number" min="0" class="cn-prop-input w-16" [value]="it.quantity" [attr.aria-label]="'Quantity of ' + it.name" (change)="update(it, { quantity: +$any($event.target).value })" /></td>
                    <td class="pr-2">
                      @if (o.pageId) {
                        <label class="text-xs"><input type="checkbox" [checked]="it.attuned" (change)="update(it, { attuned: $any($event.target).checked })" /> attuned</label>
                      }
                    </td>
                    <td class="pr-2">
                      @if (store.isGm()) {<label class="text-xs"><input type="checkbox" [checked]="it.identified" (change)="update(it, { identified: $any($event.target).checked })" /> identified</label>}
                    </td>
                    <td class="pr-2">
                      <select class="cn-prop-input text-xs" [attr.aria-label]="'Give ' + it.name + ' to'" (change)="update(it, { ownerPageId: $any($event.target).value || null })">
                        @for (to of inv.owners; track to.pageId) {<option [value]="to.pageId ?? ''" [selected]="to.pageId === it.ownerPageId">{{ to.name }}</option>}
                      </select>
                    </td>
                    <td class="text-right"><button type="button" class="text-muted hover:text-accent" (click)="remove(it)" [attr.aria-label]="'Remove ' + it.name">✕</button></td>
                  } @else {
                    <td class="w-20 pr-2 font-mono">×{{ it.quantity }}</td>
                    <td class="pr-2 text-xs text-muted" colspan="4">{{ it.attuned ? 'attuned' : '' }}</td>
                  }
                </tr>
              } @empty {
                <tr><td class="py-2 text-muted">Nothing yet.</td></tr>
              }
            </tbody>
          </table>
          @if (canManage(o.pageId)) {
            @if (addingFor() === (o.pageId ?? 'party')) {
              <div class="mt-2 grid gap-2 sm:grid-cols-[1fr_auto]">
                <cn-ref-picker kind="item" placeholder="Search items…" (selected)="addItem(o.pageId, $event, '')" />
                <form class="flex gap-1" (submit)="$event.preventDefault(); addItem(o.pageId, null, custom.value)">
                  <input #custom class="cn-prop-input" placeholder="Or a custom item" aria-label="Custom item" />
                  <button type="submit" class="rounded border border-line px-2">Add</button>
                </form>
              </div>
            } @else {
              <button type="button" class="mt-2 text-xs text-muted hover:text-accent" (click)="addingFor.set(o.pageId ?? 'party')">+ Item</button>
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
