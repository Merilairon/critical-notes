/** Encounters (game masters) and the inventory (game masters, and players for their own characters). */
import { randomBytes } from 'node:crypto';
import { getRuleset, type RulesetId } from '@cn/fivetools';
import type { CampaignDto, EncounterCreature, EncounterDto, EncounterSummaryDto, InventoryDto, InventoryItemDto } from '@cn/shared';
import { z } from 'zod';
import { path } from '../api';
import { PageDirectory } from '../pages';
import type { Tools } from '../tools';
import { campaignId } from './campaign';

const encounterId = z.string().min(1).max(64).describe('Encounter id (from list_encounters)');
const creature = z.object({
  kind: z.enum(['monster', 'npc', 'custom']).describe('monster: from the rules (uid); npc: an NPC page (its statblock); custom: your own'),
  uid: z.string().max(300).optional().describe('monster: rules uid from search_rules, e.g. "monster:goblin|mm"'),
  npc: z.string().max(200).optional().describe('npc: NPC page id or exact title'),
  name: z.string().max(120).optional().describe('custom: its name (others: an optional display name)'),
  count: z.number().int().min(1).max(50).default(1),
  hidden: z.boolean().optional().describe('Starts hidden from the players in combat'),
  lair: z.boolean().optional().describe('Use lair XP (2024 statblocks)'),
  xp: z.number().int().min(0).optional().describe('custom: XP each'),
  hp: z.number().int().min(0).optional().describe('custom: hit points'),
  ac: z.number().int().min(0).max(99).optional().describe('custom: armour class'),
});
const party = z
  .object({ mode: z.enum(['campaign', 'custom']), levels: z.array(z.number().int().min(1).max(20)).max(12).default([]) })
  .describe('campaign: the player characters; custom: the given levels');

type CreatureInput = z.infer<typeof creature>;

function toCreatures(list: CreatureInput[], dir: PageDirectory): EncounterCreature[] {
  return list.map((c) => ({
    id: randomBytes(6).toString('base64url'),
    kind: c.kind,
    uid: c.kind === 'monster' ? (c.uid ?? null) : null,
    pageId: c.kind === 'npc' && c.npc ? dir.idFor(c.npc, 'npc', 'the encounter') : null,
    name: c.name ?? '',
    count: c.count,
    lair: !!c.lair,
    hidden: !!c.hidden,
    xp: c.xp ?? null,
    hp: c.hp ?? null,
    ac: c.ac ?? null,
  }));
}

function present(e: EncounterDto, ruleset: string) {
  const byId = new Map(e.resolved.map((r) => [r.id, r]));
  const result = getRuleset(ruleset as RulesetId).encounter.compute(
    e.partyLevels,
    e.creatures.map((c) => ({ xp: byId.get(c.id)?.xp ?? c.xp ?? 0, count: c.count })),
  );
  return {
    id: e.id,
    name: e.name,
    notes: e.notes,
    party: e.party.mode === 'campaign' ? { mode: 'campaign', characters: e.partyMembers.map((m) => `${m.name} (level ${m.level})`) } : e.party,
    creatures: e.creatures.map((c) => {
      const r = byId.get(c.id);
      return { kind: c.kind, name: r?.name ?? c.name, count: c.count, uid: c.uid, cr: r?.cr ?? null, xp: r?.xp ?? c.xp, hidden: c.hidden, ...(r?.missing ? { missing: true } : {}) };
    }),
    difficulty: result.difficulty,
    totalXp: result.totalXp,
  };
}

const owner = z.string().max(200).nullable().optional().describe("A player character page (id or exact title); null or left out: the party's stash");
const coin = z.number().int().min(-1_000_000).max(1_000_000).optional();

export function playTools(t: Tools) {
  const ruleset = async (cid: string) => (await t.api.get<CampaignDto>(path`/api/campaigns/${cid}`)).ruleset;

  t.read(
    'list_encounters',
    'List or read encounters',
    "The campaign's encounters (game masters only). With encounterId: its creatures, party and difficulty by the campaign's rules.",
    z.object({ campaignId, encounterId: encounterId.optional() }),
    async ({ campaignId: cid, encounterId: id }) => {
      if (id) {
        const [e, rules] = await Promise.all([t.api.get<EncounterDto>(path`/api/campaigns/${cid}/encounters/${id}`), ruleset(cid)]);
        return { data: present(e, rules) };
      }
      const { encounters } = await t.api.get<{ encounters: EncounterSummaryDto[] }>(path`/api/campaigns/${cid}/encounters`);
      return { data: encounters.map((e) => ({ id: e.id, name: e.name, creatures: e.creatureCount })) };
    },
  );

  t.write(
    'create_encounter',
    'Create an encounter',
    'Plans an encounter: creatures from the rules (uid), NPC pages or custom ones, against the party. Returns its difficulty.',
    z.object({
      campaignId,
      name: z.string().min(1).max(120),
      notes: z.string().max(5000).optional(),
      location: z.string().max(200).optional().describe('Location page (id or exact title)'),
      creatures: z.array(creature).max(100).default([]),
      party: party.optional(),
    }),
    async (a) => {
      const dir = await PageDirectory.load(t.api, a.campaignId);
      const e = await t.api.post<EncounterDto>(path`/api/campaigns/${a.campaignId}/encounters`, {
        name: a.name,
        notes: a.notes ?? '',
        locationPageId: a.location ? dir.idFor(a.location, 'location', 'the location') : null,
        creatures: toCreatures(a.creatures, dir),
        ...(a.party ? { party: a.party } : {}),
      });
      return { data: present(e, await ruleset(a.campaignId)) };
    },
  );

  t.write(
    'update_encounter',
    'Edit an encounter',
    'Changes an encounter. "creatures" replaces the whole list; leave it out to keep the creatures.',
    z.object({
      campaignId,
      encounterId,
      name: z.string().min(1).max(120).optional(),
      notes: z.string().max(5000).optional(),
      location: z.string().max(200).nullable().optional(),
      creatures: z.array(creature).max(100).optional(),
      party: party.optional(),
    }),
    async (a) => {
      const dir = await PageDirectory.load(t.api, a.campaignId);
      const e = await t.api.patch<EncounterDto>(path`/api/campaigns/${a.campaignId}/encounters/${a.encounterId}`, {
        ...(a.name !== undefined ? { name: a.name } : {}),
        ...(a.notes !== undefined ? { notes: a.notes } : {}),
        ...(a.location !== undefined ? { locationPageId: a.location ? dir.idFor(a.location, 'location', 'the location') : null } : {}),
        ...(a.creatures ? { creatures: toCreatures(a.creatures, dir) } : {}),
        ...(a.party ? { party: a.party } : {}),
      });
      return { data: present(e, await ruleset(a.campaignId)) };
    },
  );

  t.write(
    'delete_encounter',
    'Delete an encounter',
    'Deletes an encounter (encounter blocks on pages then show it as missing).',
    z.object({ campaignId, encounterId }),
    async ({ campaignId: cid, encounterId: id }) => {
      await t.api.delete(path`/api/campaigns/${cid}/encounters/${id}`);
      return { data: { deleted: id } };
    },
    { destructive: true },
  );

  t.read('get_inventory', 'Read the inventory', "The party's stash and each character's items and coins (players see what is shared with them).", z.object({ campaignId }), async ({ campaignId: cid }) => {
    const inv = await t.api.get<InventoryDto>(path`/api/campaigns/${cid}/inventory`);
    return {
      data: inv.owners.map((o) => ({
        owner: o.pageId ? { pageId: o.pageId, name: o.name } : 'party',
        coins: inv.coins[o.pageId ?? 'party'] ?? { cp: 0, sp: 0, ep: 0, gp: 0, pp: 0 },
        items: inv.items
          .filter((i) => i.ownerPageId === o.pageId)
          .map((i) => ({ id: i.id, name: i.name, quantity: i.quantity, itemUid: i.itemUid, attuned: i.attuned, identified: i.identified, notes: i.notes })),
      })),
    };
  });

  const ownerId = async (cid: string, value: string | null | undefined) => (value ? (await PageDirectory.load(t.api, cid)).idFor(value, 'pc', 'the owner') : null);

  t.write(
    'add_inventory_item',
    'Add an item',
    "Adds an item to a character or the party's stash: a rules item (uid from search_rules) or a custom one (name).",
    z.object({
      campaignId,
      owner,
      itemUid: z.string().max(300).optional().describe('Rules item uid, e.g. "item:longsword|phb"'),
      name: z.string().max(200).optional().describe('A custom item, or a different name'),
      quantity: z.number().int().min(1).max(100000).default(1),
      notes: z.string().max(1000).optional(),
    }),
    async (a) => {
      const item = await t.api.post<InventoryItemDto>(path`/api/campaigns/${a.campaignId}/inventory/items`, {
        ownerPageId: await ownerId(a.campaignId, a.owner),
        itemUid: a.itemUid ?? null,
        name: a.name ?? '',
        quantity: a.quantity,
        notes: a.notes ?? '',
      });
      return { data: item };
    },
  );

  t.write(
    'update_inventory_item',
    'Change an item',
    'Changes an item: quantity (0 removes it), owner (give it to a character or the party), attunement, identified (game masters), name or notes.',
    z.object({
      campaignId,
      itemId: z.string().min(1).max(64),
      quantity: z.number().int().min(0).max(100000).optional(),
      owner,
      attuned: z.boolean().optional(),
      identified: z.boolean().optional(),
      name: z.string().min(1).max(200).optional(),
      notes: z.string().max(1000).optional(),
    }),
    async (a) => {
      const { item } = await t.api.patch<{ item: InventoryItemDto | null }>(path`/api/campaigns/${a.campaignId}/inventory/items/${a.itemId}`, {
        ...(a.quantity !== undefined ? { quantity: a.quantity } : {}),
        ...(a.owner !== undefined ? { ownerPageId: await ownerId(a.campaignId, a.owner) } : {}),
        ...(a.attuned !== undefined ? { attuned: a.attuned } : {}),
        ...(a.identified !== undefined ? { identified: a.identified } : {}),
        ...(a.name !== undefined ? { name: a.name } : {}),
        ...(a.notes !== undefined ? { notes: a.notes } : {}),
      });
      return { data: item ?? { removed: a.itemId } };
    },
  );

  t.write(
    'remove_inventory_item',
    'Remove an item',
    'Removes an item from the inventory.',
    z.object({ campaignId, itemId: z.string().min(1).max(64) }),
    async ({ campaignId: cid, itemId }) => {
      await t.api.delete(path`/api/campaigns/${cid}/inventory/items/${itemId}`);
      return { data: { removed: itemId } };
    },
    { destructive: true },
  );

  t.write(
    'change_coins',
    'Add or spend coins',
    "Adds (positive) or spends (negative) coins for a character or the party's stash. A purse can't go below zero.",
    z.object({ campaignId, owner, cp: coin, sp: coin, ep: coin, gp: coin, pp: coin }),
    async (a) => {
      const change = Object.fromEntries((['cp', 'sp', 'ep', 'gp', 'pp'] as const).filter((k) => a[k] !== undefined).map((k) => [k, a[k]]));
      const { coins } = await t.api.post<{ coins: unknown }>(path`/api/campaigns/${a.campaignId}/inventory/coins`, { ownerPageId: await ownerId(a.campaignId, a.owner), change });
      return { data: coins };
    },
  );
}
