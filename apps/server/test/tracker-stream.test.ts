import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sessions, users } from '../src/db/schema';
import { EventReader } from './events-helpers';
import { createFixture, createSignedInApp, TestClient, type Fixture, type TestApp } from './helpers';

/** H1.4: the tracker stream re-checks session, user state, membership and role while it is open. */
let fx: Fixture;
let app: TestApp;
let services: Awaited<ReturnType<typeof createSignedInApp>>['services'];
let dm: TestClient;
let cid: string;
let tid: string;
const base = () => `/api/campaigns/${cid}`;
const HEARTBEAT = 60;

async function join(role: 'player' | 'codm', username: string) {
  const token = (await dm.post(`${base()}/invites`, { role })).body.token as string;
  const client = new TestClient(app);
  expect((await client.post('/api/auth/register', { token, username, displayName: username, password: 'a long enough password' })).status).toBe(201);
  return { client, userId: (await client.get('/api/auth/me')).body.user.id as string };
}

async function open(client: TestClient, view: 'dm' | 'player') {
  const res = await app.request(`http://localhost${base()}/trackers/${tid}/events?view=${view}`, {
    headers: { cookie: client.cookie, origin: 'http://localhost', host: 'localhost' },
  });
  expect(res.status).toBe(200);
  const reader = new EventReader(res);
  await reader.until((f) => f.event === 'state');
  return reader;
}

const poke = (name: string) => dm.post(`${base()}/trackers/${tid}/actions`, { type: 'update', id: beast, patch: { notes: name } });
let beast: string;

beforeAll(async () => {
  fx = await createFixture();
  fx.config.eventsHeartbeatMs = HEARTBEAT;
  ({ app, client: dm, services } = await createSignedInApp(fx));
  cid = (await dm.post('/api/campaigns', { name: 'Streams', ruleset: '2014' })).body.id;
  const t = (await dm.post(`${base()}/trackers`, {
    name: 'Live',
    combatants: [{ kind: 'monster', name: 'Goblin', hpMax: 7, initiative: 12 }],
  })).body;
  tid = t.id;
  beast = t.state.combatants[0].id;
}, 60_000);
afterAll(() => fx.cleanup());

describe('tracker stream re-validation', () => {
  it('leaves a still-valid member and a still-valid DM alone', async () => {
    const pat = await join('player', 'pat');
    const p = await open(pat.client, 'player');
    const d = await open(dm, 'dm');
    await new Promise((r) => setTimeout(r, HEARTBEAT * 4));
    expect(p.ended).toBe(false);
    expect(d.ended).toBe(false);
    await poke('one');
    await p.until((f) => f.event === 'state', 2500, 1);
    await d.until((f) => f.event === 'state', 2500, 1);
    expect(p.events.map((f) => f.event)).toEqual(['state', 'state']);
    await p.cancel();
    await d.cancel();
  });

  it('closes a removed member with bye, on a heartbeat and on a delivery', async () => {
    for (const mode of ['heartbeat', 'delivery'] as const) {
      const sam = await join('player', `sam-${mode}`);
      const r = await open(sam.client, 'player');
      expect((await dm.delete(`${base()}/members/${sam.userId}`)).status).toBe(204);
      if (mode === 'delivery') await poke('after removal');
      const bye = await r.until((f) => f.event === 'bye');
      expect(JSON.parse(bye.data)).toEqual({ reason: 'access' });
      expect(await r.endedWithin(1500)).toBe(true);
      // Nothing from after the removal reached the stream
      expect(r.events.map((f) => f.event)).toEqual(['state', 'bye']);
      // A new connection is refused the usual way
      const again = await app.request(`http://localhost${base()}/trackers/${tid}/events?view=player`, { headers: { cookie: sam.client.cookie, origin: 'http://localhost', host: 'localhost' } });
      expect(again.status).toBe(404);
    }
  });

  it('closes a disabled user', async () => {
    const lee = await join('player', 'lee');
    const r = await open(lee.client, 'player');
    fx.db.update(users).set({ disabledAt: Date.now() }).where(eq(users.id, lee.userId)).run();
    await r.until((f) => f.event === 'bye');
    expect(await r.endedWithin(1500)).toBe(true);
  });

  it('closes a logged-out session, and an expired one', async () => {
    const lou = await join('player', 'lou');
    const r = await open(lou.client, 'player');
    expect((await lou.client.post('/api/auth/logout')).status).toBeLessThan(300);
    await r.until((f) => f.event === 'bye');
    expect(await r.endedWithin(1500)).toBe(true);

    const eve = await join('player', 'eve');
    const e = await open(eve.client, 'player');
    fx.db.update(sessions).set({ expiresAt: Date.now() - 1 }).where(eq(sessions.userId, eve.userId)).run();
    await poke('expired');
    await e.until((f) => f.event === 'bye');
    expect(e.events.map((f) => f.event)).toEqual(['state', 'bye']);
  });

  it('a throwing re-check closes only that stream, on a heartbeat and on a delivery, and the process survives', async () => {
    const real = services.eventStreams.currentRole.bind(services.eventStreams);
    const bad = await join('player', 'bad');
    const b = await open(bad.client, 'player');
    const g = await open(dm, 'player');
    const spy = vi.spyOn(services.eventStreams, 'currentRole').mockImplementation((info) => {
      if (info.userId === bad.userId) throw new Error('SQLITE_BUSY');
      return real(info);
    });
    try {
      expect(await b.endedWithin(1500)).toBe(true); // heartbeat path
      expect(g.ended).toBe(false);
      await poke('delivery');
      await g.until((f) => f.event === 'state', 2500, 1);
      expect(g.ended).toBe(false);
    } finally {
      spy.mockRestore();
    }
    await g.cancel();
  });

  it('stops the DM view of a demoted co-DM but keeps the player view working', async () => {
    const cody = await join('codm', 'cody');
    const dmView = await open(cody.client, 'dm');
    const playerView = await open(cody.client, 'player');
    expect((await dm.patch(`${base()}/members/${cody.userId}`, { role: 'player' })).status).toBe(200);
    await poke('after demotion');
    const bye = await dmView.until((f) => f.event === 'bye');
    expect(JSON.parse(bye.data)).toEqual({ reason: 'access' });
    expect(dmView.events.map((f) => f.event)).toEqual(['state', 'bye']);
    // Still a member: the player projection continues
    await playerView.until((f) => f.event === 'state', 2500, 1);
    expect(playerView.ended).toBe(false);
    expect(JSON.stringify(playerView.events)).not.toContain('after demotion');
    await playerView.cancel();
    // And a new DM view is refused
    const again = await app.request(`http://localhost${base()}/trackers/${tid}/events?view=dm`, { headers: { cookie: cody.client.cookie, origin: 'http://localhost', host: 'localhost' } });
    expect(again.status).toBe(403);
  });
});
