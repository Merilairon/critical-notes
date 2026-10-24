/**
 * Campaign event stream (`GET /api/campaigns/:cid/events`): payloads are pointers ("refetch this page"), never content.
 * See docs/design/reveal.md. The web app parses every frame with these strict schemas and ignores anything else.
 */
import * as z from 'zod';

/** Most block ids one `block-revealed` event names; the page refetch covers the rest. */
export const MAX_REVEALED_BLOCK_IDS = 20;

export const pageSharedEvent = z.strictObject({ pageId: z.string().min(1) });
export const blockRevealedEvent = z.strictObject({
  pageId: z.string().min(1),
  blockIds: z.array(z.string().min(1)).max(MAX_REVEALED_BLOCK_IDS),
});
export const helloEvent = z.strictObject({ replayed: z.boolean() });
export const byeEvent = z.strictObject({ reason: z.enum(['restart', 'evicted']) });

export type PageSharedEvent = z.infer<typeof pageSharedEvent>;
export type BlockRevealedEvent = z.infer<typeof blockRevealedEvent>;

/** Events that carry data and an `id:`; the control events are `hello`, `ping`, `resync` and `bye`. */
export const CAMPAIGN_EVENT_KINDS = ['page-shared', 'block-revealed'] as const;
export type CampaignEventKind = (typeof CAMPAIGN_EVENT_KINDS)[number];
