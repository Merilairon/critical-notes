import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, type AppConfig } from '../src/config';
import { openAppDb, type AppDb } from '../src/db';
import { BackupService, type BackupServiceOptions } from '../src/services/backups';
import { sha } from './zip-builder';

export interface BackupEnv {
  root: string;
  config: AppConfig;
  db: AppDb;
  audits: { event: string; fields: Record<string, unknown> }[];
  clock: { now: number };
  service(opts?: Partial<BackupServiceOptions>): BackupService;
  addUpload(id: string, data: Buffer, opts?: { row?: boolean; thumb?: Buffer }): void;
  cleanup(): void;
}

export const T0 = Date.UTC(2026, 9, 17, 9, 30, 0);

/** A temp instance: app database with one admin and one campaign, an uploads folder and a backup folder. */
export function makeEnv(overrides: Partial<AppConfig> = {}): BackupEnv {
  const root = mkdtempSync(join(tmpdir(), 'cn-bk-'));
  const dataDir = join(root, 'var');
  mkdirSync(dataDir, { recursive: true });
  const config = loadConfig({
    dataDir,
    appDbPath: join(dataDir, 'app.sqlite'),
    indexDbPath: join(dataDir, 'index.sqlite'),
    uploadsDir: join(dataDir, 'uploads'),
    backupDir: join(dataDir, 'backups'),
    backupKeep: 7,
    webDistDir: join(root, 'web-dist'),
    fivetoolsSrcPath: join(root, '5etools-src'),
    fivetoolsImgPath: join(root, '5etools-img'),
    ...overrides,
  });
  mkdirSync(config.uploadsDir, { recursive: true });
  const db = openAppDb(config.appDbPath);
  db.$client.exec(`
    insert into users (id, username, display_name, password_hash, is_admin) values ('u1', 'gm', 'GM', 'hash', 1);
    insert into campaigns (id, name, ruleset, created_by) values ('c1', 'Camp', '2014', 'u1');
  `);
  const audits: BackupEnv['audits'] = [];
  const clock = { now: T0 };
  return {
    root,
    config,
    db,
    audits,
    clock,
    service: (opts = {}) =>
      new BackupService({ db, config, now: () => clock.now, audit: (event, fields) => audits.push({ event, fields }), warn: () => undefined, ...opts }),
    addUpload(id, data, o = {}) {
      writeFileSync(join(config.uploadsDir, id), data);
      if (o.thumb) writeFileSync(join(config.uploadsDir, `${id}.thumb`), o.thumb);
      if (o.row !== false) {
        db.$client
          .prepare('insert into uploads (id, campaign_id, owner_user_id, filename, mime, size, sha256) values (?, ?, ?, ?, ?, ?, ?)')
          .run(id, 'c1', 'u1', `${id}.png`, 'image/png', data.length, sha(data));
      }
    },
    cleanup() {
      try {
        db.$client.close();
      } catch {
        // already closed
      }
      rmSync(root, { recursive: true, force: true });
    },
  };
}

export const upId = (n: number) => `0000000${n.toString(16).padStart(1, '0')}-0000-4000-8000-${String(n).padStart(12, '0')}`.slice(0, 36);

export const noise = (n: number) => randomBytes(n);
