/** Encounters: creatures from the bestiary, NPC pages and custom entries, against the party's levels. */
import { and, desc, eq, isNull } from 'drizzle-orm';
import { abilityModifier, monsterCombatStats, type CampaignPolicy } from '@cn/fivetools';
import {
  createEncounterInput,
  updateEncounterInput,
  type CreateEncounterInput,
  type EncounterCreature,
  type EncounterDto,
  type EncounterSummaryDto,
  type PartyMemberDto,
  type ResolvedEncounterCreature,
  type UpdateEncounterInput,
} from '@cn/shared';
import type { AppDb } from '../db';
import { encounters } from '../db/schema';
import { notFound } from '../lib/http';
import { newId } from '../lib/ids';
import type { ReferenceService } from '../reference/service';
import type { PageService } from './pages';

type Row = typeof encounters.$inferSelect;

export class EncounterService {
  constructor(
    private readonly db: AppDb,
    private readonly pages: PageService,
    private readonly reference: ReferenceService,
  ) {}

  private row(campaignId: string, id: string): Row {
    const r = this.db.select().from(encounters).where(and(eq(encounters.id, id), eq(encounters.campaignId, campaignId), isNull(encounters.deletedAt))).get();
    if (!r) throw notFound('Encounter not found');
    return r;
  }

  list(campaignId: string): EncounterSummaryDto[] {
    return this.db
      .select()
      .from(encounters)
      .where(and(eq(encounters.campaignId, campaignId), isNull(encounters.deletedAt)))
      .orderBy(desc(encounters.updatedAt))
      .all()
      .map((r) => ({ id: r.id, name: r.name, creatureCount: (r.creatures as EncounterCreature[]).reduce((n, c) => n + c.count, 0), updatedAt: r.updatedAt }));
  }

  /** The campaign's player characters with what the tracker and the difficulty need. */
  partyMembers(campaignId: string): PartyMemberDto[] {
    return this.pages.listWithFacets(campaignId, 'pc').map((p) => {
      const f = (p.facet ?? {}) as { classes?: { level?: number }[]; hpMax?: number | null; ac?: number | null; abilities?: Record<string, number> | null };
      const level = Math.max(1, Math.min(20, (f.classes ?? []).reduce((n, c) => n + (c.level ?? 0), 0) || 1));
      const dex = f.abilities?.['dex'];
      return { pageId: p.id, name: p.title, level, hpMax: f.hpMax ?? null, ac: f.ac ?? null, initBonus: typeof dex === 'number' ? abilityModifier(dex) : 0 };
    });
  }

  /** Names, XP and combat numbers for each line (monsters through the campaign's rules and homebrew). */
  resolve(campaignId: string, creatures: EncounterCreature[], policy: CampaignPolicy): ResolvedEncounterCreature[] {
    return creatures.map((c) => {
      const base: ResolvedEncounterCreature = { id: c.id, name: c.name || 'Creature', uid: null, cr: null, xp: c.xp, hasLairXp: false, hp: c.hp, ac: c.ac, initBonus: 0, missing: false };
      let uid = c.kind === 'monster' ? c.uid : null;
      if (c.kind === 'npc') {
        try {
          const page = this.pages.get(campaignId, c.pageId ?? '');
          base.name = c.name || page.title;
          uid = (page.facet?.['statblockUid'] as string | null | undefined) ?? null;
          if (!uid) return base; // an NPC without a statblock: no XP
        } catch {
          return { ...base, missing: true };
        }
      }
      if (!uid) return base;
      const entity = this.reference.get(uid, policy);
      if (!entity) return { ...base, uid, missing: true };
      const stats = monsterCombatStats(entity.data);
      return {
        ...base,
        uid: entity.uid,
        name: c.kind === 'monster' ? c.name || entity.name : base.name,
        cr: stats.cr,
        xp: c.lair && stats.xpLair !== null ? stats.xpLair : stats.xp,
        hasLairXp: stats.xpLair !== null,
        hp: c.hp ?? stats.hp,
        ac: c.ac ?? stats.ac,
        initBonus: stats.initBonus,
      };
    });
  }

  get(campaignId: string, id: string, policy: CampaignPolicy): EncounterDto {
    const r = this.row(campaignId, id);
    const creatures = r.creatures as EncounterCreature[];
    const party = r.party as EncounterDto['party'];
    const partyMembers = this.partyMembers(campaignId);
    return {
      id: r.id,
      name: r.name,
      notes: r.notes,
      locationPageId: r.locationPageId,
      creatures,
      party,
      resolved: this.resolve(campaignId, creatures, policy),
      partyMembers,
      partyLevels: party.mode === 'custom' ? party.levels : partyMembers.map((m) => m.level),
      updatedAt: r.updatedAt,
    };
  }

  create(campaignId: string, input: CreateEncounterInput): string {
    const v = createEncounterInput.parse(input);
    const id = newId();
    this.db.insert(encounters).values({ id, campaignId, name: v.name, notes: v.notes, locationPageId: v.locationPageId, creatures: v.creatures, party: v.party }).run();
    return id;
  }

  update(campaignId: string, id: string, input: UpdateEncounterInput) {
    this.row(campaignId, id);
    const v = updateEncounterInput.parse(input);
    this.db
      .update(encounters)
      .set({ ...v, updatedAt: Date.now() })
      .where(eq(encounters.id, id))
      .run();
  }

  remove(campaignId: string, id: string) {
    this.row(campaignId, id);
    this.db.update(encounters).set({ deletedAt: Date.now() }).where(eq(encounters.id, id)).run();
  }
}
