import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { BlockDocument, ProjectContext } from '@cn/blocks';
import { internalAuth } from '../src/auth/session';
import { campaignMembers } from '../src/db/schema';
import { createShutdown } from '../src/lib/shutdown';
import type { InMemoryCampaignEventBus, CampaignEvent } from '../src/services/event-bus';
import { newlyVisibleBlockIds } from '../src/services/reveal';
import { viewerOf } from '../src/services/visibility';
import { contextFor } from '../src/services/revisions';
import { openEvents } from './events-helpers';
import { createFixture, createSignedInApp, TestClient, type Fixture, type TestApp } from './helpers';

/** The campaign event stream (docs/design/reveal.md): pointers to what a player can now see, nothing else. */
let fx: Fixture;
let app: TestApp;
let services: Awaited<ReturnType<typeof createSignedInApp>>['services'];
let dm: TestClient;
let pat: TestClient;
let bo: TestClient;
let cody: TestClient;
let patId: string;
let boId: string;
let codyId: string;
let dmId: string;
let cid: string;
const base = () => `/api/campaigns/${cid}`;
const para = (text: string, attrs: Record<string, unknown> = {}) => ({ type: 'paragraph', attrs, content: [{ type: 'text', text }] });
const secret = (id: string, text: string, attrs: Record<string, unknown> = {}) => ({ type: 'secret', attrs: { id, ...attrs }, content: [para(text, { id: `${id}-child` })] });
const doc = (...content: unknown[]) => ({ type: 'doc', content });
let seq = 0;

async function join(token: string, username: string) {
  const client = new TestClient(app);
  expect((await client.post('/api/auth/register', { token, username, displayName: username, password: 'a long enough password' })).status).toBe(201);
  return { client, userId: (await client.get('/api/auth/me')).body.user.id as string };
}
const invite = async (campaign: string, role: 'player' | 'codm' = 'player') => (await dm.post(`/api/campaigns/${campaign}/invites`, { role })).body.token as string;

async function page(body: object, campaign = cid): Promise<string> {
  const res = await dm.post(`/api/campaigns/${campaign}/pages`, { title: `Page ${++seq}`, ...body });
  expect(res.status).toBe(201);
  return res.body.id;
}
async function save(pageId: string, body: object, campaign = cid, client = dm) {
  const current = (await client.get(`/api/campaigns/${campaign}/pages/${pageId}`)).body;
  const res = await client.patch(`/api/campaigns/${campaign}/pages/${pageId}`, { revision: current.revision, ...body });
  expect(res.status).toBe(200);
  return res.body;
}
const kinds = (r: { events: { event: string }[] }) => r.events.map((e) => e.event);
const shared = (r: { events: { event: string; data: string }[] } | { event: string; data: string }[]) => (Array.isArray(r) ? r : r.events).filter((e) => e.event === 'page-shared').map((e) => JSON.parse(e.data).pageId as string);

/** Opens a stream and waits for its `hello`. */
async function connect(client: TestClient, opts: { lastEventId?: string; campaign?: string } = {}) {
  const { res, reader } = await openEvents(app, client, opts.campaign ?? cid, opts);
  expect(res.status).toBe(200);
  const hello = await reader.until((f) => f.event === 'hello');
  return { reader, hello };
}

beforeAll(async () => {
  fx = await createFixture();
  // Short heartbeat (membership checks), small per-campaign cap (cap test)
  fx.config.eventsHeartbeatMs = 60;
  fx.config.eventsMaxPerCampaign = 8;
  ({ app, client: dm, services } = await createSignedInApp(fx));
  dmId = (await dm.get('/api/auth/me')).body.user.id;
  cid = (await dm.post('/api/campaigns', { name: 'Events', ruleset: '2014' })).body.id;
  ({ client: pat, userId: patId } = await join(await invite(cid), 'pat'));
  ({ client: bo, userId: boId } = await join(await invite(cid), 'bo'));
  ({ client: cody, userId: codyId } = await join(await invite(cid, 'codm'), 'cody'));
}, 60_000);
afterAll(() => fx.cleanup());

describe('who may open the stream', () => {
  it('needs a session, a membership and a browser: tokens get 403, strangers 404', async () => {
    expect((await openEvents(app, new TestClient(app), cid)).res.status).toBe(401);
    const stranger = (await join(await invite((await dm.post('/api/campaigns', { name: 'Other', ruleset: '2014' })).body.id), 'zed')).client;
    expect((await openEvents(app, stranger, cid)).res.status).toBe(404);
    expect((await openEvents(app, pat, 'no-such-campaign')).res.status).toBe(404);
    for (const scope of ['read', 'write'] as const) {
      const res = await app.request(`http://localhost${base()}/events`, { headers: { host: 'localhost' } }, internalAuth({ userId: dmId, scope }));
      expect(res.status).toBe(403);
    }
  });

  it('streams uncompressed, unbuffered and uncached, starting with a hello that carries a random retry', async () => {
    const { res, reader } = await openEvents(app, pat, cid, { headers: { 'accept-encoding': 'gzip, br' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(res.headers.get('content-encoding')).toBeNull();
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-accel-buffering')).toBe('no');
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    const hello = await reader.until((f) => f.event === 'hello');
    expect(JSON.parse(hello.data)).toEqual({ replayed: false });
    expect(hello.retry).toBeGreaterThanOrEqual(3000);
    expect(hello.retry).toBeLessThanOrEqual(6000);
    expect(hello.id).toBeUndefined();
    // `retry:` leads the frame, as in the design sketch
    expect(hello.raw.startsWith('retry: ')).toBe(true);
    // The heartbeat has no id either, so it never moves Last-Event-ID
    const ping = await reader.until((f) => f.event === 'ping');
    expect(ping.id).toBeUndefined();
    expect(reader.frames.some((f) => f.event === 'resync')).toBe(false);
    await reader.cancel();
  });
});

describe('what the stream announces', () => {
  it('tells a player about a page only when it becomes visible to them', async () => {
    const hid = await page({ visibility: 'dm' });
    const [p, b, d] = [await connect(pat), await connect(bo), await connect(dm)];
    await save(hid, { visibility: 'selected', viewers: [patId] });
    expect(JSON.parse((await p.reader.until((f) => f.event === 'page-shared')).data)).toEqual({ pageId: hid });
    await d.reader.until((f) => f.event === 'page-shared');
    expect(shared(await b.reader.settle(250))).toEqual([]);
    await save(hid, { visibility: 'all' });
    await b.reader.until((f) => f.event === 'page-shared');
    // Pat could already see it: no second toast
    expect(shared(await p.reader.settle(250))).toEqual([hid]);
    // Each event carries its own random id
    const ids = p.reader.events.filter((f) => f.event === 'page-shared').map((f) => f.id);
    expect(ids[0]).toMatch(/^[A-Za-z0-9_-]{22}$/);
    // A new page created already shared counts, a new hidden page does not
    const born = await page({ visibility: 'all' });
    await page({ visibility: 'dm' });
    await b.reader.until((f) => f.event === 'page-shared' && JSON.parse(f.data).pageId === born);
    expect(shared(await b.reader.settle(150))).toEqual([hid, born]);
    await Promise.all([p.reader.cancel(), b.reader.cancel(), d.reader.cancel()]);
  });

  it('announces revealed blocks on pages the player sees, and nothing for edits, hiding, or pages they cannot see', async () => {
    const town = await page({ visibility: 'all', body: doc(para('Welcome', { id: 'p1' }), secret('s1', 'The mayor lies'), para('Note', { id: 'd1', visibility: 'dm' }), secret('s2', 'More')) });
    const forBo = await page({ visibility: 'selected', body: doc(secret('x1', 'Only for Bo')) });
    await save(forBo, { viewers: [boId] });
    const [p, b] = [await connect(pat), await connect(bo)];
    // Typing in a visible paragraph, editing a still hidden block: nothing
    await save(town, { body: doc(para('Welcome, traveller', { id: 'p1' }), secret('s1', 'The mayor lies!'), para('Note', { id: 'd1', visibility: 'dm' }), secret('s2', 'More')) });
    // Reveal a secret
    await save(town, { body: doc(para('Welcome, traveller', { id: 'p1' }), secret('s1', 'The mayor lies!', { revealed: true }), para('Note', { id: 'd1', visibility: 'dm' }), secret('s2', 'More')) });
    const e = await p.reader.until((f) => f.event === 'block-revealed');
    expect(JSON.parse(e.data)).toEqual({ pageId: town, blockIds: ['s1'] });
    // A DM-only paragraph switched to everyone, right after: held for the one-second window, then sent on its own
    await save(town, { body: doc(para('Welcome, traveller', { id: 'p1' }), secret('s1', 'The mayor lies!', { revealed: true }), para('Note', { id: 'd1', visibility: 'inherit' }), secret('s2', 'More')) });
    const second = await p.reader.until((f) => f.event === 'block-revealed' && JSON.parse(f.data).blockIds[0] === 'd1', 2500);
    expect(second.id).not.toBe(e.id);
    // Hiding again: nothing
    await save(town, { body: doc(para('Welcome, traveller', { id: 'p1' }), secret('s1', 'The mayor lies!'), para('Note', { id: 'd1', visibility: 'dm' }), secret('s2', 'More')) });
    // Revealing and rewriting the same block in one save: no live event (the next load shows it)
    await save(town, { body: doc(para('Welcome, traveller', { id: 'p1' }), secret('s1', 'The mayor lies!'), para('Note', { id: 'd1', visibility: 'dm' }), secret('s2', 'Rewritten', { revealed: true })) });
    // A reveal on a page only Bo can see
    await save(forBo, { body: doc(secret('x1', 'Only for Bo', { revealed: true })) });
    await b.reader.until((f) => f.event === 'block-revealed' && JSON.parse(f.data).pageId === forBo);
    await p.reader.settle(1300);
    expect(p.reader.events.filter((f) => f.event === 'block-revealed').map((f) => JSON.parse(f.data).blockIds)).toEqual([['s1'], ['d1']]);
    expect(kinds(p.reader).filter((k) => k !== 'hello' && k !== 'block-revealed')).toEqual([]);
    expect(b.reader.events.filter((f) => f.event === 'block-revealed').map((f) => JSON.parse(f.data).pageId)).toContain(forBo);
    await Promise.all([p.reader.cancel(), b.reader.cancel()]);
  });

  it('sends only page-shared when one save both shares a page and reveals a block on it', async () => {
    const both = await page({ visibility: 'dm', body: doc(secret('b1', 'Secret')) });
    const p = await connect(pat);
    await save(both, { visibility: 'all', body: doc(secret('b1', 'Secret', { revealed: true })) });
    await p.reader.until((f) => f.event === 'page-shared');
    expect(kinds(await p.reader.settle(1200).then(() => p.reader))).toEqual(['hello', 'page-shared']);
    await p.reader.cancel();
  });

  it('emits nothing for a player editing their own character (they cannot reveal anything)', async () => {
    const pc = await page({ type: 'pc', visibility: 'all', facet: { playerUserId: patId }, body: doc(para('My story', { id: 'm1' }), para('DM note', { id: 'm2', visibility: 'dm' }), secret('m3', 'Hidden')) });
    const [p, b, d] = [await connect(pat), await connect(bo), await connect(dm)];
    const mine = (await pat.get(`${base()}/pages/${pc}`)).body;
    const forged = doc(para('My story, edited', { id: 'm1' }), para('DM note', { id: 'm2', visibility: 'inherit' }), secret('m3', 'Hidden', { revealed: true }));
    const res = await pat.patch(`${base()}/pages/${pc}`, { revision: mine.revision, body: forged });
    expect(res.status).toBe(200);
    // The DM's blocks are still hidden for everyone
    const stored = (await dm.get(`${base()}/pages/${pc}`)).body.body;
    expect(JSON.stringify(stored)).toContain('DM note');
    // Their forged flags did not touch the DM's blocks: m2 is still DM-only and m3 still unrevealed
    const kept = (stored.content as { attrs: { id: string; visibility: string; revealed: boolean } }[]).filter((n) => n.attrs.id === 'm2' || n.attrs.id === 'm3');
    expect(kept.map((n) => [n.attrs.visibility, n.attrs.revealed])).toEqual([['dm', false], ['inherit', false]]);
    for (const r of [p, b, d]) expect(kinds(await r.reader.settle(150).then(() => r.reader))).toEqual(['hello']);
    await Promise.all([p.reader.cancel(), b.reader.cancel(), d.reader.cancel()]);
  });

  it('keeps campaigns apart', async () => {
    const other = (await dm.post('/api/campaigns', { name: 'Next door', ruleset: '2014' })).body.id as string;
    const mate = (await join(await invite(other), 'otto')).client;
    const [p, m] = [await connect(pat), await connect(mate, { campaign: other })];
    await page({ visibility: 'all' }, other);
    await m.reader.until((f) => f.event === 'page-shared');
    expect(kinds(await p.reader.settle(200).then(() => p.reader))).toEqual(['hello']);
    await Promise.all([p.reader.cancel(), m.reader.cancel()]);
  });

  it('gives game masters and players their own view of the same moment', async () => {
    const hid = await page({ visibility: 'dm' });
    const [p, c, b] = [await connect(pat), await connect(cody), await connect(bo)];
    await save(hid, { visibility: 'selected', viewers: [boId] });
    await b.reader.until((f) => f.event === 'page-shared');
    await c.reader.until((f) => f.event === 'page-shared');
    expect(shared(await p.reader.settle(200).then(() => p.reader))).toEqual([]);
    // Promoted mid-stream: the next event reaches Pat at once
    fx.db.update(campaignMembers).set({ role: 'codm' }).where(and(eq(campaignMembers.campaignId, cid), eq(campaignMembers.userId, patId))).run();
    const hid2 = await page({ visibility: 'dm' });
    await save(hid2, { visibility: 'selected', viewers: [boId] });
    await p.reader.until((f) => f.event === 'page-shared' && JSON.parse(f.data).pageId === hid2);
    // Demoted again: back to the audience rule
    fx.db.update(campaignMembers).set({ role: 'player' }).where(and(eq(campaignMembers.campaignId, cid), eq(campaignMembers.userId, patId))).run();
    const hid3 = await page({ visibility: 'dm' });
    await save(hid3, { visibility: 'selected', viewers: [boId] });
    await c.reader.until((f) => f.event === 'page-shared' && JSON.parse(f.data).pageId === hid3);
    expect(shared(await p.reader.settle(200).then(() => p.reader))).toEqual([hid2]);
    await Promise.all([p.reader.cancel(), c.reader.cancel(), b.reader.cancel()]);
    void codyId;
  });
});

describe('revoking, replaying and closing', () => {
  it('replays what was missed once, minus what can no longer be seen, and resyncs on an unknown id', async () => {
    const first = await page({ visibility: 'dm' });
    let p = await connect(pat);
    await save(first, { visibility: 'all' });
    const e1 = await p.reader.until((f) => f.event === 'page-shared');
    await p.reader.cancel();
    // Missed while away: two shares (one is withdrawn again), one for somebody else
    const kept = await page({ visibility: 'all' });
    const withdrawn = await page({ visibility: 'all' });
    await save(withdrawn, { visibility: 'dm' });
    const forBo = await page({ visibility: 'selected' });
    await save(forBo, { viewers: [boId] });
    const lastSeq = await page({ visibility: 'all' });
    p = await connect(pat, { lastEventId: e1.id });
    expect(JSON.parse(p.hello.data)).toEqual({ replayed: true });
    await p.reader.until((f) => f.event === 'page-shared' && JSON.parse(f.data).pageId === lastSeq);
    // Once each, in order; the withdrawn page (404 now) and Bo's page are not replayed
    expect(shared(p.reader)).toEqual([kept, lastSeq]);
    expect(p.reader.events.some((f) => f.event === 'resync')).toBe(false);
    await p.reader.cancel();
    // Unknown, foreign (addressed to somebody else) and absent ids
    const boStream = await connect(bo);
    const forBoOnly = await page({ visibility: 'selected' });
    await save(forBoOnly, { viewers: [boId] });
    const boEvent = await boStream.reader.until((f) => f.event === 'page-shared' && JSON.parse(f.data).pageId === forBoOnly);
    await boStream.reader.cancel();
    for (const lastEventId of ['nope', boEvent.id!]) {
      const c = await connect(pat, { lastEventId });
      expect(JSON.parse(c.hello.data)).toEqual({ replayed: false });
      await c.reader.until((f) => f.event === 'resync');
      await c.reader.cancel();
    }
    const fresh = await connect(pat);
    expect((await fresh.reader.settle(100)).map((f) => f.event)).toEqual(['hello']);
    await fresh.reader.cancel();
  });

  it('does not replay an event whose page was un-shared, and the refetch is a 404', async () => {
    const pg = await page({ visibility: 'dm' });
    const marker = await connect(pat);
    await save(pg, { visibility: 'all' });
    const shown = await marker.reader.until((f) => f.event === 'page-shared');
    await marker.reader.cancel();
    expect((await pat.get(`${base()}/pages/${pg}`)).status).toBe(200);
    const lost = await page({ visibility: 'all' });
    await save(lost, { visibility: 'dm' });
    expect((await pat.get(`${base()}/pages/${lost}`)).status).toBe(404);
    const again = await connect(pat, { lastEventId: shown.id });
    expect(JSON.parse(again.hello.data)).toEqual({ replayed: true });
    expect((await again.reader.settle(150)).map((f) => f.event)).toEqual(['hello']);
    await again.reader.cancel();
  });

  it('closes the stream after logout, and when the member is removed', async () => {
    const sam = await join(await invite(cid), 'sam');
    const lou = await join(await invite(cid), 'lou');
    const [s, l] = [await connect(sam.client), await connect(lou.client)];
    expect((await lou.client.post('/api/auth/logout')).status).toBeLessThan(300);
    expect(await l.reader.endedWithin(1500)).toBe(true);
    expect(s.reader.ended).toBe(false);
    expect((await dm.delete(`${base()}/members/${sam.userId}`)).status).toBe(204);
    expect(await s.reader.endedWithin(1500)).toBe(true);
  });

  it('stops delivering the moment the member loses the page, without waiting for a heartbeat', async () => {
    const [p] = [await connect(pat)];
    const pg = await page({ visibility: 'dm' });
    // The event is published while Pat can see the page, then it is withdrawn before delivery: simulate a race by publishing late
    await save(pg, { visibility: 'all' });
    await p.reader.until((f) => f.event === 'page-shared');
    await save(pg, { visibility: 'dm' });
    services.eventBus.publish(cid, { kind: 'page-shared', pageId: pg, audience: new Set([patId]), gm: true });
    expect(shared(await p.reader.settle(150).then(() => p.reader))).toEqual([pg]);
    await p.reader.cancel();
  });

  it('tells every stream to come back when the server shuts down, before it stops listening', async () => {
    const [p, d] = [await connect(pat), await connect(dm)];
    const order: string[] = [];
    const shutdown = createShutdown({ exit: () => order.push('exit') });
    shutdown.arm({
      server: { close: () => void order.push('close') },
      closeStreams: () => {
        order.push('closeStreams');
        services.eventStreams.closeStreams();
      },
      stopScheduler: async () => undefined,
      backupRunning: () => false,
      closeDatabases: () => undefined,
      httpDrainMs: 10,
    });
    shutdown.handle('SIGTERM');
    const bye = await p.reader.until((f) => f.event === 'bye');
    expect(JSON.parse(bye.data)).toEqual({ reason: 'restart' });
    await d.reader.until((f) => f.event === 'bye');
    expect(await p.reader.endedWithin(1000)).toBe(true);
    expect(order.slice(0, 2)).toEqual(['closeStreams', 'close']);
  });
});

describe('limits and cleanup', () => {
  it('lets a user keep 6 streams and evicts the oldest on the 7th, which is told not to come back', async () => {
    const streams = [];
    for (let i = 0; i < 6; i++) streams.push(await connect(bo));
    const seventh = await connect(bo);
    const bye = await streams[0]!.reader.until((f) => f.event === 'bye');
    expect(JSON.parse(bye.data)).toEqual({ reason: 'evicted' });
    expect(await streams[0]!.reader.endedWithin(1000)).toBe(true);
    expect(streams[1]!.reader.ended).toBe(false);
    expect(services.eventStreams.size).toBe(6);
    await Promise.all([...streams, seventh].map((s) => s.reader.cancel()));
  });

  it('answers 503 with Retry-After over the campaign cap, and the cap frees up with the streams', async () => {
    await new Promise((r) => setTimeout(r, 100));
    const open = [];
    for (let i = 0; i < 4; i++) open.push(await connect(pat));
    for (let i = 0; i < 4; i++) open.push(await connect(cody));
    const refused = await openEvents(app, dm, cid);
    expect(refused.res.status).toBe(503);
    expect(Number(refused.res.headers.get('retry-after'))).toBeGreaterThan(0);
    // At the cap, a user over THEIR limit would evict only if that frees a slot: Pat has 4 so a 5th is simply refused too
    expect((await openEvents(app, pat, cid)).res.status).toBe(503);
    await open[0]!.reader.cancel();
    await new Promise((r) => setTimeout(r, 100));
    const ok = await connect(dm);
    await Promise.all([...open, ok].map((s) => s.reader.cancel()));
  });

  it('releases its slot when opening the stream throws', async () => {
    const spy = vi.spyOn(services.eventBus, 'since').mockImplementation(() => {
      throw new Error('forced failure');
    });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const { res, reader } = await openEvents(app, pat, cid, { lastEventId: 'any' });
      expect(res.status).toBe(200);
      expect(await reader.endedWithin(1500)).toBe(true);
    } finally {
      spy.mockRestore();
      errors.mockRestore();
    }
    expect(services.eventStreams.size).toBe(0);
    expect((services.eventBus as InMemoryCampaignEventBus).subscriberCount()).toBe(0);
  });

  it('does not keep the subscriber of an evicted stream whose reader stalled', async () => {
    await new Promise((r) => setTimeout(r, 100));
    const bus = services.eventBus as InMemoryCampaignEventBus;
    const aborts: AbortController[] = [];
    const open = async () => {
      const ac = new AbortController();
      aborts.push(ac);
      const res = await app.request(`http://localhost${base()}/events`, { headers: { cookie: bo.cookie, origin: 'http://localhost', host: 'localhost' }, signal: ac.signal });
      expect(res.status).toBe(200);
    };
    for (let i = 0; i < 6; i++) await open();
    // Never read: a dozen events stall every one of them (the bye of an eviction queues behind them)
    const shown: string[] = [];
    for (let i = 0; i < 12; i++) shown.push(await page({ visibility: 'all' }));
    for (const pageId of shown) bus.publish(cid, { kind: 'page-shared', pageId, audience: new Set([boId]), gm: false });
    for (let i = 0; i < 8; i++) await open();
    const deadline = Date.now() + 1500;
    while ((bus.subscriberCount() > 6 || services.eventStreams.size > 6) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
    expect(services.eventStreams.size).toBeLessThanOrEqual(6);
    expect(bus.subscriberCount()).toBeLessThanOrEqual(6);
    for (const ac of aborts) ac.abort();
    // Shutdown does not wait on the stalled readers either: everything is gone shortly after
    services.eventStreams.closeStreams();
    while ((bus.subscriberCount() > 0 || services.eventStreams.size > 0) && Date.now() < deadline + 3000) await new Promise((r) => setTimeout(r, 25));
    expect(bus.subscriberCount()).toBe(0);
  });

  it('does not let an unencodable frame leak the pending counter or throw into the publisher', async () => {
    const { reader } = await openEvents(app, dm, cid);
    await reader.until((f) => f.event === 'hello');
    // An event name with a line break cannot be sent; the stream stays usable
    expect(() => services.eventBus.publish(cid, { kind: 'bad\nkind' as never, pageId: 'x', audience: new Set(), gm: true })).not.toThrow();
    const pg = await page({ visibility: 'dm' });
    await save(pg, { visibility: 'all' });
    await reader.until((f) => f.event === 'page-shared' && JSON.parse(f.data).pageId === pg);
    await reader.cancel();
  });

  it('frees every subscriber when streams are aborted', async () => {
    await new Promise((r) => setTimeout(r, 100));
    const bus = services.eventBus as InMemoryCampaignEventBus;
    for (let i = 0; i < 100; i++) {
      const s = await connect(pat);
      await s.reader.cancel();
    }
    const deadline = Date.now() + 2000;
    while ((services.eventStreams.size > 0 || bus.subscriberCount() > 0) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
    expect(services.eventStreams.size).toBe(0);
    expect(bus.subscriberCount()).toBe(0);
  });

  it('drops a reader that stops reading instead of buffering without bound', async () => {
    const { res } = await openEvents(app, dm, cid);
    expect(res.status).toBe(200);
    // Never read the body; the DM (a game master) is sent a flood of events
    for (let i = 0; i < 200; i++) services.eventBus.publish(cid, { kind: 'page-shared', pageId: `flood-${i}`, audience: new Set(), gm: true });
    const deadline = Date.now() + 2000;
    while (services.eventStreams.size > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
    expect(services.eventStreams.size).toBe(0);
    await res.body!.cancel().catch(() => undefined);
  });
});

describe('VisibilityService.canSee', () => {
  it('answers exactly like visiblePageIds for every viewer and every kind of page', async () => {
    const campaign = (await dm.post('/api/campaigns', { name: 'Property', ruleset: '2014' })).body.id as string;
    const players = [patId, boId];
    for (const u of players) fx.db.insert(campaignMembers).values({ campaignId: campaign, userId: u, role: 'player' }).run();
    fx.db.insert(campaignMembers).values({ campaignId: campaign, userId: codyId, role: 'codm' }).run();
    // Deterministic pseudo-random
    let s = 12345;
    const rnd = (n: number) => ((s = (s * 1103515245 + 12345) & 0x7fffffff) % n);
    const made: string[] = [];
    for (let i = 0; i < 40; i++) {
      const visibility = (['dm', 'all', 'selected'] as const)[rnd(3)]!;
      const isPc = rnd(3) === 0;
      const id = await page({ visibility, ...(isPc ? { type: 'pc', facet: { playerUserId: [patId, boId, null][rnd(3)] } } : {}) }, campaign);
      made.push(id);
      if (visibility === 'selected') await save(id, { viewers: players.filter(() => rnd(2) === 0) }, campaign);
      if (rnd(5) === 0) expect((await dm.delete(`/api/campaigns/${campaign}/pages/${id}`)).status).toBe(200);
    }
    const foreign = await page({ visibility: 'all' });
    for (const [userId, role] of [[patId, 'player'], [boId, 'player'], [codyId, 'codm'], [dmId, 'dm'], ['nobody', 'player']] as const) {
      const viewer = viewerOf(userId, role);
      const visible = services.visibility.visiblePageIds(campaign, viewer);
      for (const id of [...made, foreign, 'missing']) expect(services.visibility.canSee(campaign, viewer, id), `${role} ${userId} ${id}`).toBe(visible.has(id));
    }
    expect(services.visibility.visiblePageIds(campaign, viewerOf(patId, 'player')).size).toBeGreaterThan(0);
  });
});

describe('PageService.onCommitted, batch and flushCommitted', () => {
  const collect = () => {
    const got: CampaignEvent[] = [];
    const off = services.eventBus.subscribe(cid, (e) => got.push(e));
    return { got, off };
  };
  const wctx = contextFor(dmId, { source: 'web' }, 'create');
  const input = (visibility: 'all' | 'dm') => ({ type: 'generic' as const, title: `Batch ${++seq}`, parentId: null, visibility, tags: [] as string[] });

  it('publishes after the save, and a page write inside a transaction must use batch', async () => {
    const { got, off } = collect();
    const players = fx.db.select({ id: campaignMembers.userId }).from(campaignMembers).where(and(eq(campaignMembers.campaignId, cid), eq(campaignMembers.role, 'player'))).all().map((r) => r.id).sort();
    expect(players).toContain(patId);
    // Up to three new shared pages in one flush: one event each
    services.pages.batch(() => {
      for (let i = 0; i < 3; i++) services.pages.create(cid, dmId, input('all'), wctx);
    });
    expect(got.map((e) => e.kind)).toEqual(['page-shared', 'page-shared', 'page-shared']);
    expect([...got[0]!.audience].sort()).toEqual(players);
    got.length = 0;
    // More than three: one resync for the players, no page-shared
    services.pages.batch(() => {
      for (let i = 0; i < 5; i++) services.pages.create(cid, dmId, input('all'), wctx);
    });
    expect(got.map((e) => e.kind)).toEqual(['resync']);
    expect([...got[0]!.audience].sort()).toEqual(players);
    expect(got[0]!.token).toBe('');
    got.length = 0;
    // A write inside somebody else's transaction without a batch is refused (and rolled back with it)
    expect(() => fx.db.transaction(() => services.pages.create(cid, dmId, input('all'), wctx))).toThrow(/pages\.batch/);
    // Inside a batch the event waits for the commit, and a rollback publishes nothing
    let during = -1;
    services.pages.batch(() => {
      fx.db.transaction(() => services.pages.create(cid, dmId, input('all'), wctx));
      during = got.length;
    });
    expect(during).toBe(0);
    expect(got.map((e) => e.kind)).toEqual(['page-shared']);
    got.length = 0;
    expect(() =>
      services.pages.batch(() => {
        fx.db.transaction(() => {
          services.pages.create(cid, dmId, input('all'), wctx);
          throw new Error('rolled back');
        });
      }),
    ).toThrow('rolled back');
    expect(got).toEqual([]);
    services.pages.flushCommitted();
    expect(got).toEqual([]);
    // A hidden page, or a change that touches neither body nor visibility, costs one compare and no event
    const hidden = services.pages.create(cid, dmId, input('dm'), wctx);
    services.pages.update(cid, hidden.id, { revision: hidden.revision, title: 'Renamed' }, wctx);
    expect(got).toEqual([]);
    off();
  });
});

describe('newlyVisibleBlockIds', () => {
  const ctx: ProjectContext = { role: 'player', canSeePage: () => false };
  const d = (...content: unknown[]) => ({ type: 'doc', content }) as unknown as BlockDocument;
  const ids = (a: BlockDocument, b: BlockDocument) => newlyVisibleBlockIds(a, b, ctx);

  it('finds blocks that went from hidden to visible, by revealed flag or by visibility', () => {
    expect(ids(d(secret('s', 'x')), d(secret('s', 'x', { revealed: true })))).toEqual(['s']);
    expect(ids(d(para('x', { id: 'p', visibility: 'dm' })), d(para('x', { id: 'p', visibility: 'inherit' })))).toEqual(['p']);
    expect(ids(d(secret('s', 'x', { revealed: true })), d(secret('s', 'x')))).toEqual([]);
  });

  it('matches id and content: an edit, a reused id or an unchanged block are not reveals', () => {
    expect(ids(d(secret('s', 'x')), d(secret('s', 'edited', { revealed: true })))).toEqual([]);
    expect(ids(d(secret('s', 'x')), d(para('other content', { id: 's' })))).toEqual([]);
    expect(ids(d(secret('s', 'x')), d(secret('s', 'x')))).toEqual([]);
    // Duplicate ids in the new body: one hidden block earns at most one match
    expect(ids(d(secret('s', 'x')), d(secret('s', 'x', { revealed: true }), secret('s', 'x', { revealed: true })))).toEqual(['s']);
  });

  it('counts only the tops of hidden subtrees, and ignores reveal flags all the way down', () => {
    const inner = (revealed: boolean) => ({ type: 'callout', attrs: { id: 'c' }, content: [secret('in', 'deep', revealed ? { revealed: true } : {})] });
    // The child alone cannot be reached through a hidden parent
    expect(ids(d({ ...inner(false), attrs: { id: 'c', visibility: 'dm' } }), d({ ...inner(true), attrs: { id: 'c', visibility: 'dm' } }))).toEqual([]);
    // Revealing the parent while the child flips too: the parent is the top, the fingerprint ignores the child's flag
    expect(ids(d({ ...inner(false), attrs: { id: 'c', visibility: 'dm' } }), d({ ...inner(true), attrs: { id: 'c' } }))).toEqual(['c']);
    // A hidden child inside a visible container is a top of its own
    expect(ids(d(inner(false)), d(inner(true)))).toEqual(['in']);
  });

  it('does not treat a link to a page the player cannot see as a reveal', () => {
    const embed = { type: 'pageEmbed', attrs: { id: 'e', pageId: 'secret-page' } };
    expect(ids(d(embed), d(embed))).toEqual([]);
    expect(newlyVisibleBlockIds(d(embed), d(embed), { role: 'player', canSeePage: () => true })).toEqual([]);
  });

  it('names at most 20 blocks', () => {
    const many = (revealed: boolean) => d(...Array.from({ length: 30 }, (_, i) => secret(`s${i}`, `n${i}`, revealed ? { revealed: true } : {})));
    expect(ids(many(false), many(true))).toHaveLength(20);
  });
});
