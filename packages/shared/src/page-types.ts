/** Page type constants. Kept free of zod so UI code that only needs labels and icons stays small. */
export const PAGE_TYPES = ['generic', 'npc', 'location', 'session', 'quest', 'faction', 'pc', 'item', 'lore', 'handout'] as const;
export type PageType = (typeof PAGE_TYPES)[number];

export const PAGE_TYPE_LABELS: Record<PageType, string> = {
  generic: 'Page',
  npc: 'NPC',
  location: 'Location',
  session: 'Session',
  quest: 'Quest',
  faction: 'Faction',
  pc: 'Player Character',
  item: 'Item',
  lore: 'Lore',
  handout: 'Handout',
};

export const PAGE_TYPE_ICONS: Record<PageType, string> = {
  generic: '📄',
  npc: '🧑',
  location: '📍',
  session: '🗓️',
  quest: '❗',
  faction: '🛡️',
  pc: '⚔️',
  item: '💎',
  lore: '📜',
  handout: '✉️',
};
