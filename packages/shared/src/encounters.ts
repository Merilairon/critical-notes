import * as z from 'zod';

/** One line of an encounter: a bestiary monster, an NPC page (its statblock), or a custom creature. */
export const encounterCreatureSchema = z.object({
  id: z.string().min(1).max(40),
  kind: z.enum(['monster', 'npc', 'custom']),
  uid: z.string().max(300).nullable().default(null),
  pageId: z.string().max(64).nullable().default(null),
  /** Custom creatures; for the others an optional display name. */
  name: z.string().max(120).default(''),
  count: z.number().int().min(1).max(50).default(1),
  /** Use the creature's lair XP (2024 statblocks with "xpLair"). */
  lair: z.boolean().default(false),
  /** Starts hidden from the player view in the tracker. */
  hidden: z.boolean().default(false),
  /** Custom creatures. */
  xp: z.number().int().min(0).max(1_000_000).nullable().default(null),
  hp: z.number().int().min(0).max(99999).nullable().default(null),
  ac: z.number().int().min(0).max(99).nullable().default(null),
});
export type EncounterCreature = z.infer<typeof encounterCreatureSchema>;

export const encounterPartySchema = z.object({
  /** campaign: the campaign's player characters; custom: the levels listed here. */
  mode: z.enum(['campaign', 'custom']).default('campaign'),
  levels: z.array(z.number().int().min(1).max(20)).max(12).default([]),
});

/** Fields without defaults: partial updates must never reset what they do not mention. */
const encounterFields = z.object({
  name: z.string().trim().min(1).max(120),
  notes: z.string().max(5000),
  locationPageId: z.string().max(64).nullable(),
  creatures: z.array(encounterCreatureSchema).max(100),
  party: encounterPartySchema,
});

export const createEncounterInput = encounterFields.extend({
  name: encounterFields.shape.name.default('New encounter'),
  notes: encounterFields.shape.notes.default(''),
  locationPageId: encounterFields.shape.locationPageId.default(null),
  creatures: encounterFields.shape.creatures.default([]),
  party: encounterPartySchema.default({ mode: 'campaign', levels: [] }),
});
export type CreateEncounterInput = z.input<typeof createEncounterInput>;

export const updateEncounterInput = encounterFields.partial();
export type UpdateEncounterInput = z.input<typeof updateEncounterInput>;

/** What the server knows about each line (from the bestiary or the NPC's statblock). */
export interface ResolvedEncounterCreature {
  id: string;
  name: string;
  /** Monster uid (also for NPCs with a statblock). */
  uid: string | null;
  cr: string | null;
  /** XP per creature (lair XP when `lair` is set and the statblock has it). */
  xp: number | null;
  hasLairXp: boolean;
  hp: number | null;
  ac: number | null;
  initBonus: number;
  /** The monster or NPC page could not be found. */
  missing: boolean;
}

export interface PartyMemberDto {
  pageId: string;
  name: string;
  level: number;
  hpMax: number | null;
  ac: number | null;
  initBonus: number;
}

export interface EncounterDto {
  id: string;
  name: string;
  notes: string;
  locationPageId: string | null;
  creatures: EncounterCreature[];
  party: z.infer<typeof encounterPartySchema>;
  resolved: ResolvedEncounterCreature[];
  /** The campaign's player characters (used when the party mode is "campaign"). */
  partyMembers: PartyMemberDto[];
  partyLevels: number[];
  updatedAt: number;
}

export interface EncounterSummaryDto {
  id: string;
  name: string;
  creatureCount: number;
  updatedAt: number;
}
