import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { runAdmin } from '../src/cli/run';
import type { CliContext } from '../src/cli/admin-core';
import type { AppConfig } from '../src/config';
import { makeEnv, noise, upId, type BackupEnv } from './backup-helpers';

export interface Cli {
  code: number;
  out: string;
  err: string;
}

/** Runs the admin command line in-process against `config`; stdout and stderr are captured separately. */
export async function runCli(argv: string[], config: AppConfig, extra: { confirm?: CliContext['confirm']; restoreHooks?: CliContext['restoreHooks'] } = {}): Promise<Cli> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runAdmin(argv, { config, out: (t) => out.push(t), err: (t) => err.push(t), ...extra });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

export interface Seeded {
  env: BackupEnv;
  /** A backup of the seeded instance, copied OUT of the data directory (it survives a wipe). */
  zip: string;
  uploads: Map<string, Buffer>;
  work: string;
}

/** An instance with users, a disabled user, tokens, invites, sessions, pages and uploads (thumbnails too), and a backup of it. */
export async function seededInstance(): Promise<Seeded> {
  const env = makeEnv();
  const work = mkdtempSync(join(tmpdir(), 'cn-rcli-'));
  const q = env.db.$client;
  q.exec(`
    insert into users (id, username, display_name, password_hash, is_admin, disabled_at) values ('u2', 'player', 'Player', 'pwhash-player', 0, null), ('u3', 'locked', 'Locked', 'pwhash-locked', 0, 1700000000000);
    insert into campaign_members (campaign_id, user_id, role) values ('c1', 'u1', 'dm');
    insert into pages (id, campaign_id, sort_key, title, body, visibility) values ('p1', 'c1', 'a', 'Secret', '{"x":1}', 'dm'), ('p2', 'c1', 'b', 'Open', '{"x":2}', 'all');
    insert into sessions (id, user_id, expires_at) values ('s1', 'u1', 4102444800000), ('s2', 'u2', 4102444800000);
    insert into password_resets (id, user_id, token_hash, expires_at) values ('r1', 'u2', 'reset-hash-1', 4102444800000);
    insert into api_tokens (id, user_id, name, token_hash, scope, revoked_at) values ('t1', 'u1', 'live', 'token-hash-1', 'read', null), ('t2', 'u1', 'old', 'token-hash-2', 'read', 1690000000000);
    insert into campaign_invites (id, campaign_id, token_hash, role, revoked_at) values ('i1', 'c1', 'invite-hash-1', 'player', null), ('i2', 'c1', 'invite-hash-2', 'player', 1690000000000);
  `);
  const uploads = new Map<string, Buffer>();
  for (let i = 1; i <= 3; i++) {
    const data = noise(4000 * i);
    env.addUpload(upId(i), data, { thumb: noise(500) });
    uploads.set(upId(i), data);
  }
  const r = await env.service({ opsLog: false }).create({ actor: 'seed', trigger: 'cli' });
  const zip = join(work, r.name);
  cpSync(join(env.config.backupDir, r.name), zip);
  return { env, zip, uploads, work };
}

/** What happens to a live instance after the backup: a new user, a disabled user, a new token, new upload and stale state. */
export function changeLive(env: BackupEnv): void {
  env.db.$client.exec(`
    insert into users (id, username, display_name, password_hash, is_admin) values ('u9', 'newcomer', 'New', 'pwhash-new', 0);
    update users set disabled_at = 1800000000000 where id = 'u2';
    insert into api_tokens (id, user_id, name, token_hash, scope) values ('t9', 'u1', 'newer', 'token-hash-9', 'read');
    update api_tokens set revoked_at = 1800000000000 where id = 't1';
    insert into sessions (id, user_id, expires_at) values ('s9', 'u9', 4102444800000);
  `);
  env.addUpload(upId(9), noise(1234), { thumb: noise(100) });
}

/** Closes the app's database connection (a restore needs the instance stopped). */
export function stopServer(env: BackupEnv): void {
  try {
    env.db.$client.close();
  } catch {
    // already closed
  }
}

/** sha256 of every file under `dir` (relative path -> digest), symlinks as `->target`, directories as `dir`; `skip` filters relative paths. */
export function treeDigest(dir: string, skip: (rel: string) => boolean = () => false): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      const rel = relative(dir, p);
      if (skip(rel)) continue;
      const st = lstatSync(p);
      if (st.isSymbolicLink()) out[rel] = `->${readlinkSync(p)}`;
      else if (st.isDirectory()) {
        out[rel] = 'dir';
        walk(p);
      } else out[rel] = createHash('sha256').update(readFileSync(p)).digest('hex');
    }
  };
  if (existsSync(dir)) walk(dir);
  return out;
}

/** The files a refused or rolled-back restore must leave exactly as they were (the operations log legitimately grows). */
export const ignoreOpsLog = (rel: string) => rel === 'restore-log.jsonl' || rel === 'backups' || rel.startsWith('backups/');

export function preRestoreDirs(dataDir: string): string[] {
  return readdirSync(dataDir).filter((n) => n.startsWith('pre-restore-'));
}

/** A second process that holds the database open and writing in WAL mode, like a running server. */
export async function holdDatabase(path: string): Promise<ChildProcess> {
  const sqlitePath = createRequire(import.meta.url).resolve('better-sqlite3');
  const child = spawn(
    process.execPath,
    [
      '-e',
      `const D = require(process.argv[1]); const db = new D(process.argv[2]); db.pragma('journal_mode = WAL');
       db.exec("create table if not exists held_probe (x)"); db.exec("insert into held_probe values (1)");
       console.log('ready'); setInterval(() => {}, 1000);`,
      sqlitePath,
      path,
    ],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  await new Promise<void>((resolve, reject) => {
    child.stdout!.once('data', () => resolve());
    child.once('error', reject);
    child.once('exit', () => reject(new Error('holder exited')));
  });
  return child;
}

export async function killAndWait(child: ChildProcess): Promise<void> {
  const done = new Promise<void>((r) => child.once('exit', () => r()));
  child.kill('SIGKILL');
  await done;
}

export { makeEnv, mkdirSync, rmSync };
