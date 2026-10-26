/** Encounters, initiative trackers (with a live event stream) and inventories of a campaign. */
import { Hono } from 'hono';
import { z } from 'zod';
import {
  addInventoryItemInput,
  awardLootInput,
  changeCoinsInput,
  combatantInput,
  createEncounterInput,
  trackerAction,
  isGameMaster,
  updateEncounterInput,
  updateInventoryItemInput,
  projectInventoryForPlayers,
  projectItemForPlayers,
  type InventoryItemDto,
} from '@cn/shared';
import { requireUser, type AppEnv } from '../auth/session';
import { writeContext } from '../auth/write-context';
import { forbidden, validate } from '../lib/http';
import { sseResponse, type SseChannel } from '../lib/sse';
import type { EventStreamHub } from '../services/event-streams';
import type { CampaignService } from '../services/campaigns';
import type { EncounterService } from '../services/encounters';
import type { InventoryService } from '../services/inventory';
import type { TrackerService } from '../services/trackers';
import type { Viewer, VisibilityService } from '../services/visibility';

const createTrackerInput = z.object({
  name: z.string().trim().min(1).max(120).default('Combat'),
  combatants: z.array(combatantInput).max(50).default([]),
});
const startInput = z.object({ includeParty: z.boolean().default(true) });

export function playRoutes(deps: {
  campaigns: CampaignService;
  encounters: EncounterService;
  trackers: TrackerService;
  inventory: InventoryService;
  visibility: VisibilityService;
  eventStreams: EventStreamHub;
}) {
  const { campaigns, encounters, trackers, inventory, visibility, eventStreams } = deps;
  const app = new Hono<AppEnv>();
  app.use('*', requireUser);
  const uid = (c: { get(key: 'user'): AppEnv['Variables']['user'] }) => c.get('user')!.id;
  /** DM check; returns the campaign id. */
  const dm = (c: Parameters<typeof uid>[0] & { req: { param(k: 'campaignId'): string } }) => {
    const campaignId = c.req.param('campaignId');
    campaigns.requireDm(campaignId, uid(c));
    return campaignId;
  };

  // region Encounters

  app.get('/:campaignId/encounters', (c) => {
    const campaignId = dm(c);
    return c.json({ encounters: encounters.list(campaignId), trackers: trackers.list(campaignId) });
  });

  app.post('/:campaignId/encounters', validate('json', createEncounterInput), (c) => {
    const campaignId = dm(c);
    const id = encounters.create(campaignId, c.req.valid('json'));
    return c.json(encounters.get(campaignId, id, campaigns.policy(campaignId, uid(c))), 201);
  });

  app.get('/:campaignId/encounters/:id', (c) => {
    const campaignId = dm(c);
    return c.json(encounters.get(campaignId, c.req.param('id'), campaigns.policy(campaignId, uid(c))));
  });

  app.patch('/:campaignId/encounters/:id', validate('json', updateEncounterInput), (c) => {
    const campaignId = dm(c);
    encounters.update(campaignId, c.req.param('id'), c.req.valid('json'));
    return c.json(encounters.get(campaignId, c.req.param('id'), campaigns.policy(campaignId, uid(c))));
  });

  app.delete('/:campaignId/encounters/:id', (c) => {
    encounters.remove(dm(c), c.req.param('id'));
    return c.body(null, 204);
  });

  /** Runs the encounter: a new tracker with its creatures (and the party). */
  app.post('/:campaignId/encounters/:id/start', validate('json', startInput), (c) => {
    const campaignId = dm(c);
    return c.json(
      trackers.startEncounter(campaignId, c.req.param('id'), campaigns.policy(campaignId, uid(c)), c.req.valid('json')),
      201,
    );
  });

  app.get('/:campaignId/encounters/:id/trackers', (c) =>
    c.json({ trackers: trackers.forEncounter(dm(c), c.req.param('id')) }),
  );

  // endregion

  /** Players may only change what belongs to their own characters. */
  const playerOwns = (campaignId: string, userId: string, ownerPageId: string | null) =>
    ownerPageId !== null && visibility.ownCharacterIds(campaignId, userId).has(ownerPageId);
  const member = (c: Parameters<typeof dm>[0]) => {
    const campaignId = c.req.param('campaignId');
    return { campaignId, viewer: campaigns.viewer(campaignId, uid(c)) };
  };

  // region Trackers

  app.get('/:campaignId/trackers', (c) => c.json({ trackers: trackers.list(dm(c)) }));

  /** Running combats, for every member (players open their player view from here). */
  app.get('/:campaignId/trackers/active', (c) => {
    const { campaignId } = member(c);
    return c.json({
      trackers: trackers
        .list(campaignId)
        .filter((t) => t.status === 'active')
        .map((t) => ({ id: t.id, name: t.name, round: t.round })),
    });
  });

  app.post('/:campaignId/trackers', validate('json', createTrackerInput), (c) => {
    const { name, combatants } = c.req.valid('json');
    return c.json(trackers.create(dm(c), name, combatants), 201);
  });

  app.get('/:campaignId/trackers/:id', (c) => c.json(trackers.get(dm(c), c.req.param('id'))));

  app.post('/:campaignId/trackers/:id/actions', validate('json', trackerAction), (c) =>
    c.json(trackers.apply(dm(c), c.req.param('id'), c.req.valid('json'), writeContext(c, 'tracker'))),
  );

  app.delete('/:campaignId/trackers/:id', (c) => {
    trackers.remove(dm(c), c.req.param('id'));
    return c.body(null, 204);
  });

  /** What players see (any campaign member; the DM can show it on a second screen). */
  app.get('/:campaignId/trackers/:id/player', (c) => {
    const campaignId = c.req.param('campaignId');
    campaigns.access(campaignId, uid(c));
    return c.json(trackers.playerView(campaignId, c.req.param('id')));
  });

  /** Server-sent events: the full state for the DM (`?view=dm`), the projection for players (`?view=player`). */
  app.get('/:campaignId/trackers/:id/events', (c) => {
    const campaignId = c.req.param('campaignId');
    const id = c.req.param('id');
    const view = c.req.query('view') === 'player' ? 'player' : 'dm';
    if (view === 'dm') campaigns.requireDm(campaignId, uid(c));
    else campaigns.access(campaignId, uid(c));
    const first = view === 'dm' ? trackers.get(campaignId, id) : trackers.playerView(campaignId, id);
    const userId = uid(c);
    const sessionId = c.get('sessionId');
    // Session, user state, membership and (for the DM view) the game-master role, checked again on every heartbeat and every
    // delivery; whoever fails is told `bye` and cut. The projection itself is unchanged.
    const stillAllowed = (ch: SseChannel) => {
      const role = eventStreams.currentRole({ campaignId, userId, sessionId });
      if (role && (view === 'player' || isGameMaster(role))) return true;
      ch.end({ event: 'bye', data: JSON.stringify({ reason: 'access' }) });
      return false;
    };
    return sseResponse(c, {
      heartbeatMs: eventStreams.heartbeatMs,
      onHeartbeat: (ch) => void stillAllowed(ch),
      open: (ch) => {
        ch.send({ event: 'state', data: JSON.stringify(first) });
        return trackers.subscribe(id, (e) => {
          // Fail closed: a throwing check cuts this viewer only
          try {
            if (ch.closed || !stillAllowed(ch)) return;
            ch.send({ event: 'state', data: JSON.stringify(view === 'dm' ? e.dm : e.player) });
          } catch (err) {
            console.error('Tracker stream delivery failed; closing the stream', err instanceof Error ? err.message : 'unknown error');
            ch.close();
          }
        });
      },
    });
  });

  // endregion

  // region Inventory and loot

  /** Every member sees the party's belongings and those of the characters they can see. */
  app.get('/:campaignId/inventory', (c) => {
    const { campaignId, viewer } = member(c);
    const inv = inventory.get(campaignId);
    return c.json(viewer.gm ? inv : projectInventoryForPlayers(inv, visibility.visiblePageIds(campaignId, viewer)));
  });
  /** Responses to a player's own changes go through the same projection. */
  const itemFor = (campaignId: string, viewer: Viewer, item: InventoryItemDto | null) =>
    item && !viewer.gm ? projectItemForPlayers(item, visibility.visiblePageIds(campaignId, viewer)) : item;

  app.post('/:campaignId/inventory/items', validate('json', addInventoryItemInput), (c) => {
    const { campaignId, viewer } = member(c);
    const input = c.req.valid('json');
    if (!viewer.gm && !playerOwns(campaignId, viewer.userId, input.ownerPageId))
      throw forbidden('You can only add items to your own character');
    return c.json(itemFor(campaignId, viewer, inventory.addItem(campaignId, input)), 201);
  });

  /** Players change their own characters' items, and may give them to the party or another character. */
  app.patch('/:campaignId/inventory/items/:id', validate('json', updateInventoryItemInput), (c) => {
    const { campaignId, viewer } = member(c);
    const patch = c.req.valid('json');
    if (!viewer.gm) {
      if (!playerOwns(campaignId, viewer.userId, inventory.ownerOf(campaignId, c.req.param('id'))))
        throw forbidden('That item is not yours');
      // What an item really is stays the DM's to reveal
      if (patch.identified !== undefined) throw forbidden('Only the DM can identify items');
      if (patch.name !== undefined && !inventory.isIdentified(campaignId, c.req.param('id')))
        throw forbidden('Unidentified items cannot be renamed');
    }
    return c.json({ item: itemFor(campaignId, viewer, inventory.updateItem(campaignId, c.req.param('id'), patch)) });
  });

  app.delete('/:campaignId/inventory/items/:id', (c) => {
    const { campaignId, viewer } = member(c);
    if (!viewer.gm && !playerOwns(campaignId, viewer.userId, inventory.ownerOf(campaignId, c.req.param('id'))))
      throw forbidden('That item is not yours');
    inventory.removeItem(campaignId, c.req.param('id'));
    return c.body(null, 204);
  });

  app.post('/:campaignId/inventory/coins', validate('json', changeCoinsInput), (c) => {
    const { campaignId, viewer } = member(c);
    const input = c.req.valid('json');
    if (!viewer.gm && !playerOwns(campaignId, viewer.userId, input.ownerPageId))
      throw forbidden('You can only change your own character’s coins');
    return c.json({ coins: inventory.changeCoins(campaignId, input) });
  });

  app.post('/:campaignId/loot/award', validate('json', awardLootInput), (c) =>
    c.json(inventory.awardLoot(dm(c), c.req.valid('json'))),
  );

  // endregion

  return app;
}
