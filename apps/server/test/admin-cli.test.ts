import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { CliError, EXIT, resetLinkCommand, SUBCOMMANDS, type DbSubcommand } from '../src/cli/admin-core';
import { passwordResets, users } from '../src/db/schema';
import { hashPassword } from '../src/lib/password';
import { resetUrl } from '../src/services/users';
import { createFixture, TestClient, type Fixture } from './helpers';

let fx: Fixture;
const BASE = 'https://notes.example.org/';

beforeAll(async () => {
  fx = await createFixture();
});
afterAll(() => fx.cleanup());
beforeEach(async () => {
  fx.db.delete(passwordResets).run();
  fx.db.delete(users).run();
  const passwordHash = await hashPassword('another long password');
  fx.db.insert(users).values({ id: 'pat', username: 'pat', displayName: 'Pat', passwordHash, isAdmin: true }).run();
  fx.db.insert(users).values({ id: 'kim', username: 'kim', displayName: 'Kim', passwordHash, disabledAt: 1 }).run();
});

const fails = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(CliError);
    return e as CliError;
  }
  throw new Error('did not fail');
};

describe('reset-link command', () => {
  it('issues a link the reset endpoint redeems, with createdBy null and the shared url format', async () => {
    const { url, expiresAt } = resetLinkCommand(fx.db, ' Pat ', BASE);
    const token = url.split('#')[1]!;
    expect(url).toBe(resetUrl(BASE, token));
    expect(url.startsWith('https://notes.example.org/reset#')).toBe(true);
    expect(expiresAt).toBeGreaterThan(Date.now());
    const row = fx.db.select().from(passwordResets).get()!;
    expect(row.createdBy).toBeNull();
    expect(row.tokenHash).not.toContain(token);

    const app = createApp({ config: fx.config, indexDb: fx.indexDb, db: fx.db }).app;
    const res = await new TestClient(app).post(`/api/auth/reset/${token}`, { newPassword: 'brand new password' });
    expect(res.status).toBe(200);
    const again = await new TestClient(app).post(`/api/auth/reset/${token}`, { newPassword: 'brand new password' });
    expect(again.status).toBe(404);
  });

  it('refuses an unknown user (1) and a disabled user (2) and writes nothing', () => {
    expect(fails(() => resetLinkCommand(fx.db, 'nobody', BASE)).exitCode).toBe(EXIT.unknownUser);
    expect(fails(() => resetLinkCommand(fx.db, '  ', BASE)).exitCode).toBe(EXIT.unknownUser);
    const disabled = fails(() => resetLinkCommand(fx.db, 'KIM', BASE));
    expect(disabled.exitCode).toBe(EXIT.disabledUser);
    expect(disabled.message).toMatch(/disabled/);
    expect(fx.db.select().from(passwordResets).all()).toHaveLength(0);
  });

  it('a second link supersedes the first', async () => {
    const a = resetLinkCommand(fx.db, 'pat', BASE).url.split('#')[1]!;
    const b = resetLinkCommand(fx.db, 'pat', BASE).url.split('#')[1]!;
    const app = createApp({ config: fx.config, indexDb: fx.indexDb, db: fx.db }).app;
    expect((await new TestClient(app).post(`/api/auth/reset/${a}`, { newPassword: 'brand new password' })).status).toBe(404);
    expect((await new TestClient(app).post(`/api/auth/reset/${b}`, { newPassword: 'brand new password' })).status).toBe(200);
  });
});

describe('subcommand registry', () => {
  const resetLink = SUBCOMMANDS['reset-link'] as DbSubcommand;
  it('prints only the url on stdout and the expiry through info', async () => {
    const info: string[] = [];
    const out = (await resetLink.run(['pat'], { db: fx.db, config: fx.config, publicUrl: BASE, info: (m) => info.push(m) })) as string;
    expect(out).toMatch(/^https:\/\/notes\.example\.org\/reset#[\w-]+$/);
    expect(info.join('')).toMatch(/expires/);
    expect(info.join('')).not.toContain(out.split('#')[1]!);
  });

  it('rejects missing or extra arguments as usage errors', () => {
    const ctx = { db: fx.db, config: fx.config, publicUrl: BASE, info: () => {} };
    expect(fails(() => resetLink.run([], ctx)).exitCode).toBe(EXIT.usage);
    expect(fails(() => resetLink.run(['a', 'b'], ctx)).exitCode).toBe(EXIT.usage);
  });
});
