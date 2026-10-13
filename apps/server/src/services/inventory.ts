/** Party and character inventories, coins, attunement and loot awards. */
import { and, asc, eq, isNull } from 'drizzle-orm';
import {
  awardLootInput,
  COINS,
  MAX_ATTUNED,
  type AwardLootInput,
  type Coins,
  type InventoryDto,
  type InventoryItemDto,
} from '@cn/shared';
import type { z } from 'zod';
import type { addInventoryItemInput, updateInventoryItemInput, changeCoinsInput } from '@cn/shared';
import type { AppDb } from '../db';
import { currencies, inventoryItems, lootAwards, pages } from '../db/schema';
import { badRequest, conflict, notFound } from '../lib/http';
import { newId } from '../lib/ids';
import type { ReferenceService } from '../reference/service';

type Row = typeof inventoryItems.$inferSelect;
const PARTY = 'party';
const ZERO: Coins = { cp: 0, sp: 0, ep: 0, gp: 0, pp: 0 };

function toDto(r: Row): InventoryItemDto {
  return {
    id: r.id,
    ownerPageId: r.ownerPageId,
    itemUid: r.itemUid,
    name: r.name,
    quantity: r.quantity,
    attuned: r.attuned,
    identified: r.identified,
    sessionPageId: r.sessionPageId,
    notes: r.notes,
  };
}

export class InventoryService {
  constructor(
    private readonly db: AppDb,
    private readonly reference: ReferenceService,
  ) {}

  /** Owners are the party (null) and the campaign's player characters. */
  private assertOwner(campaignId: string, ownerPageId: string | null) {
    if (ownerPageId === null) return;
    const page = this.db
      .select({ type: pages.type })
      .from(pages)
      .where(and(eq(pages.id, ownerPageId), eq(pages.campaignId, campaignId), isNull(pages.deletedAt)))
      .get();
    if (!page || page.type !== 'pc') throw badRequest('Items can belong to the party or a player character');
  }

  private item(campaignId: string, id: string): Row {
    const r = this.db.select().from(inventoryItems).where(and(eq(inventoryItems.id, id), eq(inventoryItems.campaignId, campaignId))).get();
    if (!r) throw notFound('Item not found');
    return r;
  }

  get(campaignId: string): InventoryDto {
    const owners = [
      { pageId: null, name: 'Party' },
      ...this.db
        .select({ pageId: pages.id, name: pages.title })
        .from(pages)
        .where(and(eq(pages.campaignId, campaignId), eq(pages.type, 'pc'), isNull(pages.deletedAt)))
        .orderBy(asc(pages.title))
        .all(),
    ];
    const items = this.db.select().from(inventoryItems).where(eq(inventoryItems.campaignId, campaignId)).orderBy(asc(inventoryItems.name)).all().map(toDto);
    const coins: Record<string, Coins> = {};
    for (const c of this.db.select().from(currencies).where(eq(currencies.campaignId, campaignId)).all()) {
      coins[c.ownerKey] = { cp: c.cp, sp: c.sp, ep: c.ep, gp: c.gp, pp: c.pp };
    }
    return { items, coins, owners };
  }

  private itemName(uid: string | null, name: string): string {
    if (name.trim()) return name.trim();
    return (uid && this.reference.describe(uid)?.name) || 'Item';
  }

  addItem(campaignId: string, input: z.infer<typeof addInventoryItemInput>, sessionPageId: string | null = null): InventoryItemDto {
    this.assertOwner(campaignId, input.ownerPageId);
    const name = this.itemName(input.itemUid, input.name);
    // Stack with an identical, unattuned item of the same owner
    const same = this.db
      .select()
      .from(inventoryItems)
      .where(
        and(
          eq(inventoryItems.campaignId, campaignId),
          input.ownerPageId ? eq(inventoryItems.ownerPageId, input.ownerPageId) : isNull(inventoryItems.ownerPageId),
          input.itemUid ? eq(inventoryItems.itemUid, input.itemUid) : isNull(inventoryItems.itemUid),
          eq(inventoryItems.name, name),
          eq(inventoryItems.attuned, false),
        ),
      )
      .get();
    if (same && !input.notes) {
      this.db.update(inventoryItems).set({ quantity: same.quantity + input.quantity, updatedAt: Date.now() }).where(eq(inventoryItems.id, same.id)).run();
      return toDto(this.item(campaignId, same.id));
    }
    const id = newId();
    this.db
      .insert(inventoryItems)
      .values({ id, campaignId, ownerPageId: input.ownerPageId, itemUid: input.itemUid, name, quantity: input.quantity, notes: input.notes, sessionPageId })
      .run();
    return toDto(this.item(campaignId, id));
  }

  updateItem(campaignId: string, id: string, patch: z.infer<typeof updateInventoryItemInput>): InventoryItemDto | null {
    const current = this.item(campaignId, id);
    if (patch.quantity === 0) {
      this.db.delete(inventoryItems).where(eq(inventoryItems.id, id)).run();
      return null;
    }
    const owner = patch.ownerPageId !== undefined ? patch.ownerPageId : current.ownerPageId;
    if (patch.ownerPageId !== undefined) this.assertOwner(campaignId, owner);
    // Changing hands ends attunement
    let attuned = patch.ownerPageId !== undefined && patch.ownerPageId !== current.ownerPageId ? false : current.attuned;
    if (patch.attuned !== undefined) attuned = patch.attuned;
    if (attuned && !current.attuned) {
      if (!owner) throw badRequest('Only a character can attune to an item');
      const count = this.db
        .select({ id: inventoryItems.id })
        .from(inventoryItems)
        .where(and(eq(inventoryItems.campaignId, campaignId), eq(inventoryItems.ownerPageId, owner), eq(inventoryItems.attuned, true)))
        .all().length;
      if (count >= MAX_ATTUNED) throw badRequest(`A character can be attuned to at most ${MAX_ATTUNED} items`);
    }
    this.db
      .update(inventoryItems)
      .set({
        ownerPageId: owner,
        attuned,
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.quantity !== undefined ? { quantity: patch.quantity } : {}),
        ...(patch.identified !== undefined ? { identified: patch.identified } : {}),
        ...(patch.notes !== undefined ? { notes: patch.notes } : {}),
        updatedAt: Date.now(),
      })
      .where(eq(inventoryItems.id, id))
      .run();
    return toDto(this.item(campaignId, id));
  }

  /** The character (or null: the party) holding an item. */
  ownerOf(campaignId: string, id: string): string | null {
    return this.item(campaignId, id).ownerPageId;
  }

  isIdentified(campaignId: string, id: string): boolean {
    return this.item(campaignId, id).identified;
  }

  removeItem(campaignId: string, id: string) {
    this.item(campaignId, id);
    this.db.delete(inventoryItems).where(eq(inventoryItems.id, id)).run();
  }

  /** Adds (negative: spends) coins. A purse never goes below zero. */
  changeCoins(campaignId: string, input: z.infer<typeof changeCoinsInput>): Coins {
    this.assertOwner(campaignId, input.ownerPageId);
    const key = input.ownerPageId ?? PARTY;
    const row = this.db.select().from(currencies).where(and(eq(currencies.campaignId, campaignId), eq(currencies.ownerKey, key))).get();
    const current: Coins = row ? { cp: row.cp, sp: row.sp, ep: row.ep, gp: row.gp, pp: row.pp } : { ...ZERO };
    const next = { ...current };
    for (const c of COINS) next[c] += input.change[c] ?? 0;
    const short = COINS.filter((c) => next[c] < 0);
    if (short.length) throw badRequest(`Not enough ${short.join(', ')}`);
    this.db
      .insert(currencies)
      .values({ campaignId, ownerKey: key, ...next })
      .onConflictDoUpdate({ target: [currencies.campaignId, currencies.ownerKey], set: next })
      .run();
    return next;
  }

  /** Hands a loot block's items and coins to the party or a character, once. */
  awardLoot(campaignId: string, raw: AwardLootInput): InventoryDto {
    const input = awardLootInput.parse(raw);
    const page = this.db
      .select({ id: pages.id, type: pages.type })
      .from(pages)
      .where(and(eq(pages.id, input.pageId), eq(pages.campaignId, campaignId), isNull(pages.deletedAt)))
      .get();
    if (!page) throw notFound('Page not found');
    const owner = input.to === PARTY ? null : input.to;
    this.assertOwner(campaignId, owner);
    const previous = this.db.select().from(lootAwards).where(and(eq(lootAwards.pageId, page.id), eq(lootAwards.blockId, input.blockId))).get();
    if (previous && !input.again) throw conflict('This loot was already awarded', { awardedAt: previous.awardedAt, to: previous.toKey });
    const sessionPageId = page.type === 'session' ? page.id : null;
    this.db.transaction(() => {
      for (const it of input.items) {
        if (!it.uid && !it.name.trim()) continue;
        this.addItem(campaignId, { ownerPageId: owner, itemUid: it.uid, name: it.name, quantity: it.qty, notes: it.note }, sessionPageId);
      }
      if (COINS.some((c) => (input.coins[c] ?? 0) > 0)) this.changeCoins(campaignId, { ownerPageId: owner, change: input.coins });
      this.db
        .insert(lootAwards)
        .values({ pageId: page.id, blockId: input.blockId, toKey: input.to })
        .onConflictDoUpdate({ target: [lootAwards.pageId, lootAwards.blockId], set: { toKey: input.to, awardedAt: Date.now() } })
        .run();
    });
    return this.get(campaignId);
  }
}
