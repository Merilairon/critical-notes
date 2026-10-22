import * as z from 'zod';

export const COINS = ['cp', 'sp', 'ep', 'gp', 'pp'] as const;
export type Coin = (typeof COINS)[number];
export type Coins = Record<Coin, number>;

/** Attuned magic items per character (both editions). */
export const MAX_ATTUNED = 3;

export interface InventoryItemDto {
  id: string;
  /** Owning player character page; null for the party stash. */
  ownerPageId: string | null;
  itemUid: string | null;
  name: string;
  quantity: number;
  attuned: boolean;
  identified: boolean;
  /** The session the item was awarded in. */
  sessionPageId: string | null;
  notes: string;
}

export interface InventoryDto {
  items: InventoryItemDto[];
  /** By owner: "party" or a player character page id. */
  coins: Record<string, Coins>;
  owners: { pageId: string | null; name: string }[];
}

const owner = z.string().max(64).nullable();

export const addInventoryItemInput = z.object({
  ownerPageId: owner.default(null),
  itemUid: z.string().max(300).nullable().default(null),
  name: z.string().trim().max(200).default(''),
  quantity: z.number().int().min(1).max(100000).default(1),
  notes: z.string().max(1000).default(''),
});

export const updateInventoryItemInput = z.object({
  ownerPageId: owner.optional(),
  name: z.string().trim().min(1).max(200).optional(),
  quantity: z.number().int().min(0).max(100000).optional(),
  attuned: z.boolean().optional(),
  identified: z.boolean().optional(),
  notes: z.string().max(1000).optional(),
});

const coinsSchema = z.object({ cp: z.number().int(), sp: z.number().int(), ep: z.number().int(), gp: z.number().int(), pp: z.number().int() }).partial();

/** Adds (or with negative numbers, removes) coins. */
export const changeCoinsInput = z.object({ ownerPageId: owner.default(null), change: coinsSchema });

export const awardLootInput = z.object({
  /** The page with the loot block (recorded as the session when it is a session page). */
  pageId: z.string().max(64),
  blockId: z.string().max(64),
  /** "party" or a player character page id. */
  to: z.string().max(64).default('party'),
  items: z.array(z.object({ uid: z.string().max(300).nullable().default(null), name: z.string().max(200).default(''), qty: z.number().int().min(1).max(100000).default(1), note: z.string().max(300).default('') })).max(100),
  coins: coinsSchema.default({}),
  /** Award again even though this block was already awarded. */
  again: z.boolean().default(false),
});
export type AwardLootInput = z.input<typeof awardLootInput>;

/** What players see of an item the party has not identified yet. */
export const UNIDENTIFIED_ITEM_NAME = 'Unidentified item';

/** An item as players see it: unidentified items don't give away what they are; sessions they can't see aren't linked. */
export function projectItemForPlayers(item: InventoryItemDto, visiblePageIds: ReadonlySet<string>): InventoryItemDto {
  const sessionPageId = item.sessionPageId && visiblePageIds.has(item.sessionPageId) ? item.sessionPageId : null;
  return item.identified ? { ...item, sessionPageId } : { ...item, sessionPageId, itemUid: null, name: UNIDENTIFIED_ITEM_NAME, notes: '' };
}

/** The inventory as players see it: the party stash and the characters they can see. */
export function projectInventoryForPlayers(inv: InventoryDto, visiblePageIds: ReadonlySet<string>): InventoryDto {
  const owners = inv.owners.filter((o) => o.pageId === null || visiblePageIds.has(o.pageId));
  const shown = new Set(owners.map((o) => o.pageId ?? 'party'));
  return {
    owners,
    items: inv.items.filter((i) => shown.has(i.ownerPageId ?? 'party')).map((i) => projectItemForPlayers(i, visiblePageIds)),
    coins: Object.fromEntries(Object.entries(inv.coins).filter(([owner]) => shown.has(owner))),
  };
}
