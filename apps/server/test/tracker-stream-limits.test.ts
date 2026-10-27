import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { EventReader } from './events-helpers';
import { createFixture, createSignedInApp, TestClient, type Fixture, type TestApp } from './helpers';

/** S1.3: tracker streams share the stream caps, and the delivery guard in routes/play.ts closes a stream on its own. */
let fx: Fixture;
let app: TestApp;
let services: Awaited<ReturnType<typeof createSignedInApp>>['services'];
let dm: TestClient;
let cid: string;
let tid: string;
let beast: string;
const base = () => `/api/campaigns/${cid}`;

async function join(username: string) {
  const token = (await dm.post(`${base()}/invites`, { role: 'player' })).body.token as string;
  const client = new TestClient(app);
  expect((await client.post('/api/auth/register', { token, username, displayName: username, password: 'a long enough password' })).status).toBe(201);
  return { client, userId: (await client.get('/api/auth/me')).body.user.id as string };
}
const request = (client: TestClient, view: 'dm' | 'player') =>
  app.request(`http://localhost${base()}/trackers/${tid}/events?view=${view}`, { headers: { cookie: client.cookie, origin: 'http://localhost', host: 'localhost' } });
async function open(client: TestClient, view: 'dm' | 'player') {
  const res = await request(client, view);
  expect(res.status).toBe(200);
  const reader = new EventReader(res);
  await reader.until((f) => f.event === 'state');
  return reader;
}
const poke = (name: string) => dm.post(`${base()}/trackers/${tid}/actions`, { type: 'update', id: beast, patch: { notes: name } });

beforeAll(async () => {
  fx = await createFixture();
  // A heartbeat far longer than any test: only the delivery path can close a stream here
  fx.config.eventsHeartbeatMs = 600_000;
  fx.config.eventsMaxPerCampaign = 8;
  ({ app, client: dm, services } = await createSignedInApp(fx));
  cid = (await dm.post('/api/campaigns', { name: 'Caps', ruleset: '2014' })).body.id;
  const t = (await dm.post(`${base()}/trackers`, { name: 'Live', combatants: [{ kind: 'monster', name: 'Goblin', hpMax: 7, initiative: 12 }] })).body;
  tid = t.id;
  beast = t.state.combatants[0].id;
}, 60_000);
afterAll(() => fx.cleanup());

describe('tracker stream caps', () => {
  it('counts tracker streams per user: the 7th evicts the oldest, which is told bye evicted', async () => {
    const ann = await join('ann');
    const streams: EventReader[] = [];
    for (let i = 0; i < 6; i++) streams.push(await open(ann.client, 'player'));
    expect(services.eventStreams.size).toBe(6);
    streams.push(await open(ann.client, 'player'));
    const bye = await streams[0]!.until((f) => f.event === 'bye');
    expect(JSON.parse(bye.data)).toEqual({ reason: 'evicted' });
    expect(await streams[0]!.endedWithin(1000)).toBe(true);
    expect(streams[1]!.ended).toBe(false);
    await Promise.all(streams.map((s) => s.cancel()));
    await vi.waitFor(() => expect(services.eventStreams.size).toBe(0));
  });

  it('counts tracker streams per campaign: 503 with Retry-After over the cap, and the slots come back', async () => {
    const opened: EventReader[] = [];
    for (const name of ['c1', 'c2']) {
      const u = await join(name);
      for (let i = 0; i < 4; i++) opened.push(await open(u.client, 'player'));
    }
    const refused = await request(dm, 'dm');
    expect(refused.status).toBe(503);
    expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(0);
    await opened[0]!.cancel();
    await vi.waitFor(() => expect(services.eventStreams.size).toBe(7));
    const ok = await open(dm, 'dm');
    await Promise.all([...opened, ok].map((s) => s.cancel()));
    await vi.waitFor(() => expect(services.eventStreams.size).toBe(0));
  });

  it('tells tracker streams to come back on shutdown', async () => {
    const dee = await join('dee');
    const r = await open(dee.client, 'player');
    services.eventStreams.closeStreams();
    const bye = await r.until((f) => f.event === 'bye');
    expect(JSON.parse(bye.data)).toEqual({ reason: 'restart' });
  });
});

describe('tracker delivery guard (no heartbeat in play)', () => {
  it('closes a removed member with bye on the next delivery, and nothing newer reaches them', async () => {
    const sam = await join('sam');
    const r = await open(sam.client, 'player');
    expect((await dm.delete(`${base()}/members/${sam.userId}`)).status).toBe(204);
    await poke('after removal');
    const bye = await r.until((f) => f.event === 'bye');
    expect(JSON.parse(bye.data)).toEqual({ reason: 'access' });
    expect(await r.endedWithin(1500)).toBe(true);
    expect(r.events.map((f) => f.event)).toEqual(['state', 'bye']);
  });

  it('a throwing re-check on a delivery closes only that stream and the process survives', async () => {
    const real = services.eventStreams.currentRole.bind(services.eventStreams);
    const bad = await join('bad');
    const b = await open(bad.client, 'player');
    const g = await open(dm, 'player');
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const spy = vi.spyOn(services.eventStreams, 'currentRole').mockImplementation((info) => {
      if (info.userId === bad.userId) throw new Error('SQLITE_BUSY');
      return real(info);
    });
    try {
      await poke('delivery');
      expect(await b.endedWithin(1500)).toBe(true);
      expect(JSON.stringify(b.events)).not.toContain('delivery');
      await g.until((f) => f.event === 'state', 2500, 1);
      expect(g.ended).toBe(false);
    } finally {
      spy.mockRestore();
      errors.mockRestore();
    }
    await g.cancel();
  });
});
