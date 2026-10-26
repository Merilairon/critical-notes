/**
 * Open campaign event streams (docs/design/reveal.md sections 3, 5, 6 and 7): admission limits, per-connection filtering at
 * delivery against CURRENT state, coalescing, `Last-Event-ID` replay with the same re-check, and re-validation of the session and
 * the membership on every delivery and every heartbeat. Events are pointers; the client refetches through the normal projection.
 */
import { randomInt } from 'node:crypto';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { isGameMaster, MAX_REVEALED_BLOCK_IDS, type CampaignRole } from '@cn/shared';
import type { AppDb } from '../db';
import { sessions, users } from '../db/schema';
import { HttpError } from '../lib/http';
import type { SseChannel } from '../lib/sse';
import type { CampaignService } from './campaigns';
import type { CampaignEvent, CampaignEventBus } from './event-bus';
import { viewerOf, type VisibilityService } from './visibility';

export interface EventStreamLimits {
  perUser: number;
  perCampaign: number;
  global: number;
  coalesceMs: number;
  /** A replay of more events than this is treated like an unknown id. */
  maxReplay: number;
}
export const DEFAULT_STREAM_LIMITS: EventStreamLimits = { perUser: 6, perCampaign: 100, global: 500, coalesceMs: 1000, maxReplay: 50 };

interface Pending {
  event: CampaignEvent;
  timer: ReturnType<typeof setTimeout>;
}
interface Slot {
  lastSent: number;
  pending?: Pending;
}

export interface StreamConnection {
  readonly campaignId: string;
  readonly userId: string;
  readonly sessionId: string;
  readonly lastEventId: string | null;
  channel: SseChannel | null;
  slots: Map<string, Slot>;
  closed: boolean;
}

export class EventStreamHub {
  private readonly conns = new Set<StreamConnection>();
  private readonly limits: EventStreamLimits;

  constructor(
    private readonly deps: { db: AppDb; campaigns: CampaignService; visibility: VisibilityService; bus: CampaignEventBus },
    limits: Partial<EventStreamLimits> = {},
    readonly heartbeatMs?: number,
  ) {
    this.limits = { ...DEFAULT_STREAM_LIMITS, ...limits };
  }

  /** Open streams (tests). */
  get size() {
    return this.conns.size;
  }

  /**
   * Reserves a slot or throws 503. A 7th stream of one user evicts that user's oldest (told `bye: evicted`), which frees its slot
   * first; the caps are checked as if it were already gone, and nothing is evicted when the caps would refuse anyway.
   */
  admit(info: { campaignId: string; userId: string; sessionId: string; lastEventId: string | null }): StreamConnection {
    const mine = [...this.conns].filter((c) => c.userId === info.userId);
    const victim = mine.length >= this.limits.perUser ? mine[0]! : null;
    const global = this.conns.size - (victim ? 1 : 0);
    const inCampaign = [...this.conns].filter((c) => c.campaignId === info.campaignId).length - (victim?.campaignId === info.campaignId ? 1 : 0);
    if (global >= this.limits.global || inCampaign >= this.limits.perCampaign) throw new HttpError(503, 'Too many live connections; try again shortly', undefined, 5);
    if (victim) {
      this.conns.delete(victim);
      victim.channel?.end({ event: 'bye', data: JSON.stringify({ reason: 'evicted' }) });
    }
    const conn: StreamConnection = { ...info, channel: null, slots: new Map(), closed: false };
    this.conns.add(conn);
    return conn;
  }

  /** Attaches the channel: `hello`, the replay, then live delivery. Returns the cleanup. */
  open(conn: StreamConnection, channel: SseChannel): () => void {
    const { bus } = this.deps;
    conn.channel = channel;
    let unsubscribe: (() => void) | null = null;
    // Idempotent; also run when anything below throws, so the slot taken in admit() cannot leak
    const release = () => {
      conn.closed = true;
      unsubscribe?.();
      unsubscribe = null;
      for (const slot of conn.slots.values()) if (slot.pending) clearTimeout(slot.pending.timer);
      conn.slots.clear();
      this.conns.delete(conn);
    };
    try {
      let replay: CampaignEvent[] | null = null;
      const role = this.validRole(conn);
      if (!role) {
        channel.close();
      } else {
        if (conn.lastEventId) {
          replay = bus.since(conn.campaignId, conn.lastEventId, (e) => e.audience.has(conn.userId) || (e.gm && isGameMaster(role)));
          // Section 3 again at replay time: an event from before a revoke is not replayed to someone who can no longer see the page
          if (replay) replay = replay.filter((e) => this.allowed(conn, e, role));
          if (replay && replay.length > this.limits.maxReplay) replay = null;
        }
        channel.send({ event: 'hello', data: JSON.stringify({ replayed: replay !== null }), retry: randomInt(3000, 6001) });
        if (conn.lastEventId && replay === null) channel.send({ event: 'resync', data: '{}' });
        for (const e of replay ?? []) this.write(conn, e);
      }
      // Same tick as the replay read: no event can fall between the two
      unsubscribe = bus.subscribe(conn.campaignId, (e) => this.deliver(conn, e));
    } catch (e) {
      console.error('Opening an event stream failed', e);
      release();
      channel.close();
    }
    return release;
  }

  /** Heartbeat tick: closes the stream when the session, the user or the membership is gone. Never extends the session. */
  heartbeat(conn: StreamConnection): void {
    if (!this.validRole(conn)) conn.channel?.close();
  }

  /** Shutdown: tells every client to reconnect (with jitter) to the next process. */
  closeStreams(): void {
    for (const conn of [...this.conns]) conn.channel?.end({ event: 'bye', data: JSON.stringify({ reason: 'restart' }) });
  }

  /** The member's current role, or null when the session expired, the user is disabled or the membership ended. */
  private validRole(conn: StreamConnection): CampaignRole | null {
    return this.currentRole(conn);
  }

  /**
   * The same re-validation for any long-lived stream (the tracker stream uses it too). With a browser session the session must be
   * unexpired and its user enabled; without one (an internal token call) the user must be enabled. Never extends the session.
   */
  currentRole(info: { campaignId: string; userId: string; sessionId?: string }): CampaignRole | null {
    const { db, campaigns } = this.deps;
    const live = info.sessionId
      ? db
          .select({ id: sessions.id })
          .from(sessions)
          .innerJoin(users, eq(users.id, sessions.userId))
          .where(and(eq(sessions.id, info.sessionId), eq(sessions.userId, info.userId), gt(sessions.expiresAt, Date.now()), isNull(users.disabledAt)))
          .get()
      : db.select({ id: users.id }).from(users).where(and(eq(users.id, info.userId), isNull(users.disabledAt))).get();
    if (!live) return null;
    try {
      return campaigns.access(info.campaignId, info.userId).role;
    } catch {
      return null;
    }
  }

  /** Section 3: a game master gets the event; anyone else must be in the audience AND see the page right now. */
  private allowed(conn: StreamConnection, e: CampaignEvent, role: CampaignRole): boolean {
    if (e.kind === 'resync') return e.audience.has(conn.userId);
    if (isGameMaster(role)) return e.gm;
    return !!e.pageId && e.audience.has(conn.userId) && this.deps.visibility.canSee(conn.campaignId, viewerOf(conn.userId, role), e.pageId);
  }

  private write(conn: StreamConnection, e: CampaignEvent) {
    if (e.kind === 'resync') conn.channel?.send({ event: 'resync', data: '{}' });
    else {
      const data = e.kind === 'page-shared' ? { pageId: e.pageId } : { pageId: e.pageId, blockIds: e.blockIds ?? [] };
      conn.channel?.send({ event: e.kind, id: e.token, data: JSON.stringify(data) });
    }
  }

  private deliver(conn: StreamConnection, e: CampaignEvent) {
    if (conn.closed || !conn.channel || conn.channel.closed) return;
    const role = this.validRole(conn);
    if (!role) {
      conn.channel.close();
      return;
    }
    // Not allowed: write nothing at all (no placeholder, no id line)
    if (!this.allowed(conn, e, role)) return;
    if (e.kind === 'resync') return this.write(conn, e);
    const key = `${e.kind}:${e.pageId}`;
    const now = Date.now();
    const slot = conn.slots.get(key);
    if (!slot || (!slot.pending && now - slot.lastSent >= this.limits.coalesceMs)) {
      // Leading edge: out at once
      for (const [k, s] of conn.slots) if (!s.pending && now - s.lastSent >= this.limits.coalesceMs) conn.slots.delete(k);
      conn.slots.set(key, { lastSent: now });
      return this.write(conn, e);
    }
    // Within the window: merge (block ids united, capped) and flush once when it ends
    if (slot.pending) {
      const prev = slot.pending.event;
      const blockIds = [...new Set([...(prev.blockIds ?? []), ...(e.blockIds ?? [])])].slice(0, MAX_REVEALED_BLOCK_IDS);
      slot.pending.event = { ...e, blockIds, audience: new Set([...prev.audience, ...e.audience]), gm: prev.gm || e.gm };
      return;
    }
    slot.pending = {
      event: e,
      timer: setTimeout(() => {
        const pending = slot.pending;
        slot.pending = undefined;
        if (!pending || conn.closed || !conn.channel || conn.channel.closed) return;
        // Re-checked at flush time: the page may have been hidden again meanwhile
        const r = this.validRole(conn);
        if (!r) return void conn.channel.close();
        if (!this.allowed(conn, pending.event, r)) return;
        slot.lastSent = Date.now();
        this.write(conn, pending.event);
      }, Math.max(0, slot.lastSent + this.limits.coalesceMs - now)),
    };
  }
}
