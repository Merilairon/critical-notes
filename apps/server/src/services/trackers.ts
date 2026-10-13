/**
 * Initiative trackers. Actions are applied on the server one after another (no lost updates between DM tabs)
 * and every change is pushed to subscribers: the DM view gets the full state, the player view only the
 * projection (no hidden combatants, notes or monster hit points).
 */
import { randomInt } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import type { CampaignPolicy } from '@cn/fivetools';
import {
  applyTrackerAction,
  emptyTrackerState,
  projectTrackerForPlayers,
  type CombatantInput,
  type EncounterCreature,
  type PlayerTrackerView,
  type TrackerAction,
  type TrackerDto,
  type TrackerState,
  type TrackerSummaryDto,
} from '@cn/shared';
import type { AppDb } from '../db';
import { trackers } from '../db/schema';
import { badRequest, notFound } from '../lib/http';
import { newId } from '../lib/ids';
import type { EncounterService } from './encounters';
import type { PageService } from './pages';

type Row = typeof trackers.$inferSelect;
export type TrackerListener = (event: { dm: TrackerDto; player: PlayerTrackerView }) => void;

const shortId = () => newId().slice(-12);

export class TrackerService {
  private readonly listeners = new Map<string, Set<TrackerListener>>();

  constructor(
    private readonly db: AppDb,
    private readonly encounters: EncounterService,
    private readonly pages: PageService,
  ) {}

  private row(campaignId: string, id: string): Row {
    const r = this.db.select().from(trackers).where(and(eq(trackers.id, id), eq(trackers.campaignId, campaignId))).get();
    if (!r) throw notFound('Tracker not found');
    return r;
  }

  private dto(r: Row): TrackerDto {
    return {
      id: r.id,
      campaignId: r.campaignId,
      encounterId: r.encounterId,
      name: r.name,
      status: r.status as TrackerDto['status'],
      state: r.state as TrackerState,
      revision: r.revision,
      updatedAt: r.updatedAt,
    };
  }

  get(campaignId: string, id: string): TrackerDto {
    return this.dto(this.row(campaignId, id));
  }

  playerView(campaignId: string, id: string): PlayerTrackerView {
    return projectTrackerForPlayers(this.row(campaignId, id).state as TrackerState);
  }

  list(campaignId: string): TrackerSummaryDto[] {
    return this.db
      .select()
      .from(trackers)
      .where(eq(trackers.campaignId, campaignId))
      .orderBy(desc(trackers.updatedAt))
      .limit(50)
      .all()
      .map((r) => {
        const s = r.state as TrackerState;
        return { id: r.id, name: r.name, status: r.status as TrackerSummaryDto['status'], round: s.round, combatants: s.combatants.length, updatedAt: r.updatedAt };
      });
  }

  create(campaignId: string, name: string, combatants: CombatantInput[] = [], encounterId: string | null = null): TrackerDto {
    let state = emptyTrackerState();
    if (combatants.length) state = this.reduce(state, { type: 'add', combatants });
    // Monsters and NPCs roll right away; players say their own initiative
    if (combatants.some((c) => c.kind !== 'pc')) state = this.reduce(state, { type: 'rollInitiative', which: 'npcs' });
    const id = newId();
    this.db.insert(trackers).values({ id, campaignId, encounterId, name, state }).run();
    return this.get(campaignId, id);
  }

  /** A tracker with the encounter's creatures (numbered when there are several) and the party. */
  startEncounter(campaignId: string, encounterId: string, policy: CampaignPolicy, { includeParty = true }: { includeParty?: boolean } = {}): TrackerDto {
    const enc = this.encounters.get(campaignId, encounterId, policy);
    const combatants: CombatantInput[] = [];
    if (includeParty) {
      for (const pc of enc.partyMembers) {
        const page = this.pages.get(campaignId, pc.pageId);
        const current = page.facet?.['hpCurrent'];
        combatants.push({ kind: 'pc', ref: pc.pageId, name: pc.name, initBonus: pc.initBonus, hpMax: pc.hpMax, hp: typeof current === 'number' ? current : pc.hpMax, ac: pc.ac });
      }
    }
    for (const line of enc.creatures as EncounterCreature[]) {
      const r = enc.resolved.find((x) => x.id === line.id);
      if (!r) continue;
      for (let i = 1; i <= line.count; i++) {
        combatants.push({
          kind: line.kind,
          ref: line.kind === 'npc' ? line.pageId : r.uid,
          name: line.count > 1 ? `${r.name} ${i}` : r.name,
          initBonus: r.initBonus,
          hpMax: r.hp,
          ac: r.ac,
          hidden: line.hidden,
        });
      }
    }
    if (combatants.length > 50) throw badRequest('A tracker holds at most 50 combatants');
    return this.create(campaignId, enc.name, combatants, encounterId);
  }

  private reduce(state: TrackerState, action: TrackerAction): TrackerState {
    try {
      return applyTrackerAction(state, action, { d20: () => randomInt(1, 21), newId: shortId });
    } catch (e) {
      throw badRequest(e instanceof Error ? e.message.slice(0, 300) : 'Invalid action');
    }
  }

  /** Applies one action and notifies subscribers. */
  apply(campaignId: string, id: string, action: TrackerAction): TrackerDto {
    const r = this.row(campaignId, id);
    if (r.status === 'ended' && action.type !== 'start') throw badRequest('This combat has ended');
    const state = this.reduce(r.state as TrackerState, action);
    const status = action.type === 'end' ? 'ended' : action.type === 'start' ? 'active' : r.status;
    this.db
      .update(trackers)
      .set({ state, status, revision: r.revision + 1, updatedAt: Date.now() })
      .where(eq(trackers.id, id))
      .run();
    const dto = this.get(campaignId, id);
    if (action.type === 'end') this.syncPartyHp(campaignId, dto.state);
    this.notify(dto);
    return dto;
  }

  /** After combat, player characters' current hit points go back to their pages. */
  private syncPartyHp(campaignId: string, state: TrackerState) {
    for (const c of state.combatants) {
      if (c.kind !== 'pc' || !c.ref || c.hp === null) continue;
      try {
        const page = this.pages.get(campaignId, c.ref);
        if (page.facet?.['hpCurrent'] !== c.hp) this.pages.update(campaignId, c.ref, { revision: page.revision, facet: { hpCurrent: c.hp } });
      } catch {
        // The page was deleted or changed meanwhile: leave it
      }
    }
  }

  remove(campaignId: string, id: string) {
    this.row(campaignId, id);
    this.db.delete(trackers).where(eq(trackers.id, id)).run();
  }

  /** Trackers started from an encounter (most recent first). */
  forEncounter(campaignId: string, encounterId: string): TrackerSummaryDto[] {
    const ids = new Set(
      this.db
        .select({ id: trackers.id })
        .from(trackers)
        .where(and(eq(trackers.campaignId, campaignId), eq(trackers.encounterId, encounterId)))
        .all()
        .map((r) => r.id),
    );
    return this.list(campaignId).filter((t) => ids.has(t.id));
  }

  // region Live updates

  subscribe(trackerId: string, listener: TrackerListener): () => void {
    const set = this.listeners.get(trackerId) ?? new Set();
    set.add(listener);
    this.listeners.set(trackerId, set);
    return () => {
      set.delete(listener);
      if (!set.size) this.listeners.delete(trackerId);
    };
  }

  private notify(dto: TrackerDto) {
    const set = this.listeners.get(dto.id);
    if (!set?.size) return;
    const event = { dm: dto, player: projectTrackerForPlayers(dto.state) };
    for (const l of set) {
      try {
        l(event);
      } catch {
        // a broken connection must not stop the others
      }
    }
  }

  // endregion
}
