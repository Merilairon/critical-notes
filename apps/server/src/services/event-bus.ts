/**
 * The campaign event bus (docs/design/reveal.md sections 5 and 6): publish/subscribe per campaign, plus a short ring of recent
 * events for `Last-Event-ID` replay. In memory, so it works exactly as far as the app does (one server process); a Postgres
 * deployment with several processes replaces the implementation behind this interface.
 */
import { randomBytes } from 'node:crypto';

export type CampaignEventKind = 'page-shared' | 'block-revealed' | 'resync';

export interface CampaignEvent {
  /** Random opaque token (the SSE `id:`); empty for `resync`, which carries no id and is not replayed. */
  token: string;
  kind: CampaignEventKind;
  pageId?: string;
  blockIds?: string[];
  /** Player members who gained sight, computed at commit. */
  audience: ReadonlySet<string>;
  /** Game masters receive the event whatever the audience. */
  gm: boolean;
  at: number;
}

export type CampaignEventInput = Omit<CampaignEvent, 'token' | 'at'>;
export type CampaignEventListener = (event: CampaignEvent) => void;

export interface CampaignEventBus {
  publish(campaignId: string, event: CampaignEventInput): void;
  subscribe(campaignId: string, listener: CampaignEventListener): () => void;
  /**
   * Events published after `token`, oldest first, or null when the token is not in the ring or was not addressed to the caller
   * (`addressedTo` decides that for the token's own entry). Unknown, expired and foreign tokens look the same.
   */
  since(campaignId: string, token: string, addressedTo: (event: CampaignEvent) => boolean): CampaignEvent[] | null;
}

export const RING_MAX_EVENTS = 200;
export const RING_MAX_AGE_MS = 10 * 60 * 1000;

export class InMemoryCampaignEventBus implements CampaignEventBus {
  private readonly listeners = new Map<string, Set<CampaignEventListener>>();
  private readonly rings = new Map<string, CampaignEvent[]>();

  constructor(
    private readonly opts: { ringMax?: number; ringMs?: number; now?: () => number } = {},
  ) {}

  private now() {
    return (this.opts.now ?? Date.now)();
  }

  private trim(ring: CampaignEvent[]) {
    const oldest = this.now() - (this.opts.ringMs ?? RING_MAX_AGE_MS);
    while (ring.length && (ring.length > (this.opts.ringMax ?? RING_MAX_EVENTS) || ring[0]!.at < oldest)) ring.shift();
  }

  publish(campaignId: string, input: CampaignEventInput): void {
    const resync = input.kind === 'resync';
    const event: CampaignEvent = { ...input, token: resync ? '' : randomBytes(16).toString('base64url'), at: this.now() };
    if (!resync) {
      const ring = this.rings.get(campaignId) ?? [];
      ring.push(event);
      this.trim(ring);
      this.rings.set(campaignId, ring);
    }
    // A copy: a listener may unsubscribe while we deliver
    for (const listener of [...(this.listeners.get(campaignId) ?? [])]) {
      try {
        listener(event);
      } catch (e) {
        console.error('Campaign event listener failed', e);
      }
    }
  }

  subscribe(campaignId: string, listener: CampaignEventListener): () => void {
    const set = this.listeners.get(campaignId) ?? new Set();
    set.add(listener);
    this.listeners.set(campaignId, set);
    return () => {
      set.delete(listener);
      if (!set.size && this.listeners.get(campaignId) === set) this.listeners.delete(campaignId);
    };
  }

  since(campaignId: string, token: string, addressedTo: (event: CampaignEvent) => boolean): CampaignEvent[] | null {
    const ring = this.rings.get(campaignId);
    if (!ring || !token) return null;
    this.trim(ring);
    const ix = ring.findIndex((e) => e.token === token);
    if (ix < 0 || !addressedTo(ring[ix]!)) return null;
    return ring.slice(ix + 1);
  }

  /** Subscribers in a campaign, or in all campaigns (tests). */
  subscriberCount(campaignId?: string): number {
    if (campaignId) return this.listeners.get(campaignId)?.size ?? 0;
    let n = 0;
    for (const s of this.listeners.values()) n += s.size;
    return n;
  }
}
