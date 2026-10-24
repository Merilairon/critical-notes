/**
 * Runtime configuration from environment variables (optionally loaded from the repo-root `.env`).
 * Relative paths resolve against the repo root, so `pnpm --filter` and Docker behave the same.
 */
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function findRepoRoot(start: string): string {
  let dir = start;
  for (;;) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return process.cwd();
    dir = parent;
  }
}

export const REPO_ROOT = findRepoRoot(dirname(fileURLToPath(import.meta.url)));

let envLoaded = false;
function loadEnvOnce() {
  if (envLoaded) return;
  envLoaded = true;
  const envFile = join(REPO_ROOT, '.env');
  if (existsSync(envFile) && !process.env.CN_SKIP_DOTENV) process.loadEnvFile(envFile);
}

function resolvePath(value: string | undefined, fallback: string): string {
  const v = value?.trim() || fallback;
  return isAbsolute(v) ? v : resolve(REPO_ROOT, v);
}

export const DEFAULT_BACKUP_KEEP = 7;

/** `BACKUP_KEEP`: an integer from 1 to 1000. Anything else warns and falls back to the default. */
export function parseBackupKeep(value: string | undefined, warn: (msg: string) => void = (m) => console.warn(m)): number {
  if (value === undefined || value.trim() === '') return DEFAULT_BACKUP_KEEP;
  const v = value.trim();
  const n = /^\d{1,4}$/.test(v) ? Number(v) : NaN;
  if (Number.isInteger(n) && n >= 1 && n <= 1000) return n;
  warn(`BACKUP_KEEP must be an integer from 1 to 1000 (got "${v.slice(0, 40)}"); using ${DEFAULT_BACKUP_KEEP}`);
  return DEFAULT_BACKUP_KEEP;
}

/** A positive integer in range from the environment, else the default (the event stream limits are not worth refusing to start for). */
export function parseIntInRange(value: string | undefined, fallback: number, min: number, max: number): number {
  const v = value?.trim() ?? '';
  const n = /^\d{1,9}$/.test(v) ? Number(v) : NaN;
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}

export const MAX_BACKUP_EVERY_HOURS = 720;

/**
 * `BACKUP_EVERY_HOURS`: unset, empty or `0` = scheduled backups off; otherwise an integer from 1 to 720. Anything else is an
 * `error` (the server refuses to start; the command line, which never schedules, is not blocked, so a restore still works).
 */
export function parseBackupEveryHours(value: string | undefined): { hours: number; error: string | null } {
  const v = value?.trim() ?? '';
  if (v === '') return { hours: 0, error: null };
  const n = /^\d{1,4}$/.test(v) ? Number(v) : NaN;
  if (Number.isInteger(n) && n >= 0 && n <= MAX_BACKUP_EVERY_HOURS) return { hours: n, error: null };
  return { hours: 0, error: `BACKUP_EVERY_HOURS must be a whole number from 1 to ${MAX_BACKUP_EVERY_HOURS}, or 0 or empty for no scheduled backups (got "${v.slice(0, 40)}")` };
}

/** Page history settings (task N1.2): environment variables `HISTORY_*`, validated like `BACKUP_KEEP`. There is no switch to turn history off. */
export interface HistoryConfig {
  /** Every revision is kept this many days; older ones are thinned to one per page per day (`HISTORY_KEEP_ALL_DAYS`, 1 to 3650, default 30). */
  keepAllDays: number;
  /** Saves by the same author within this many minutes fold into one revision (`HISTORY_COALESCE_MINUTES`, 0 to 1440, default 2; 0 = off). */
  coalesceMinutes: number;
  /** A page over this many revisions is thinned early (`HISTORY_MAX_PER_PAGE`, 10 to 100000, default 200). */
  maxPerPage: number;
  /** Soft per-campaign ceiling for history in MB (`HISTORY_MAX_MB_PER_CAMPAIGN`, 10 to 1000000, default 500). */
  maxMbPerCampaign: number;
  /** After this many days only one revision per page per month is kept (`HISTORY_MONTHLY_AFTER_DAYS`, 1 to 36500, default 365). */
  monthlyAfterDays: number;
}

export const DEFAULT_HISTORY: HistoryConfig = { keepAllDays: 30, coalesceMinutes: 2, maxPerPage: 200, maxMbPerCampaign: 500, monthlyAfterDays: 365 };

function intSetting(name: string, value: string | undefined, min: number, max: number, fallback: number, warn: (msg: string) => void): number {
  if (value === undefined || value.trim() === '') return fallback;
  const v = value.trim();
  const n = /^\d{1,7}$/.test(v) ? Number(v) : NaN;
  if (Number.isInteger(n) && n >= min && n <= max) return n;
  warn(`${name} must be an integer from ${min} to ${max} (got "${v.slice(0, 40)}"); using ${fallback}`);
  return fallback;
}

/** The `HISTORY_*` settings; an invalid value warns and falls back to its default. */
export function parseHistoryConfig(env: Record<string, string | undefined>, warn: (msg: string) => void = (m) => console.warn(m)): HistoryConfig {
  const d = DEFAULT_HISTORY;
  return {
    keepAllDays: intSetting('HISTORY_KEEP_ALL_DAYS', env.HISTORY_KEEP_ALL_DAYS, 1, 3650, d.keepAllDays, warn),
    coalesceMinutes: intSetting('HISTORY_COALESCE_MINUTES', env.HISTORY_COALESCE_MINUTES, 0, 1440, d.coalesceMinutes, warn),
    maxPerPage: intSetting('HISTORY_MAX_PER_PAGE', env.HISTORY_MAX_PER_PAGE, 10, 100000, d.maxPerPage, warn),
    maxMbPerCampaign: intSetting('HISTORY_MAX_MB_PER_CAMPAIGN', env.HISTORY_MAX_MB_PER_CAMPAIGN, 10, 1_000_000, d.maxMbPerCampaign, warn),
    monthlyAfterDays: intSetting('HISTORY_MONTHLY_AFTER_DAYS', env.HISTORY_MONTHLY_AFTER_DAYS, 1, 36500, d.monthlyAfterDays, warn),
  };
}

export interface AppConfig {
  fivetoolsSrcPath: string;
  fivetoolsImgPath: string;
  dataDir: string;
  appDbPath: string;
  indexDbPath: string;
  uploadsDir: string;
  /** Where backup zips are written (`BACKUP_DIR`, default `DATA_DIR/backups`). Validated by `validateBackupDir` when the service starts. */
  backupDir: string;
  /** Backups to keep (`BACKUP_KEEP`, 1 to 1000, default 7). */
  backupKeep: number;
  /** Hours between scheduled backups (`BACKUP_EVERY_HOURS`, 1 to 720); 0 = off (the default). */
  backupEveryHours: number;
  /** Why `BACKUP_EVERY_HOURS` is invalid (the server refuses to start), or null. */
  backupEveryHoursError: string | null;
  /** Open event streams in total (`EVENTS_MAX_CONNECTIONS`, default 500) and per campaign (`EVENTS_MAX_PER_CAMPAIGN`, default 100); over a cap: 503. */
  eventsMaxConnections: number;
  eventsMaxPerCampaign: number;
  /**
   * Event stream heartbeat in ms (`EVENTS_HEARTBEAT_MS`, default 25000, 20 to 55000). A TEST-ONLY seam (short heartbeats for the
   * membership tests): deliberately not documented in README or .env.example. Keep it under the proxy's 60 s idle timeout.
   */
  eventsHeartbeatMs: number;
  /** Page history retention and folding. */
  history: HistoryConfig;
  publicUrl: string;
  /** Session cookies carry `Secure`: by default when PUBLIC_URL is https (browsers drop them over plain http). */
  secureCookies: boolean;
  /** Read the client address from X-Forwarded-For (rate limits). Only safe behind a proxy that overwrites it. */
  trustProxy: boolean;
  port: number;
  isProduction: boolean;
  /** Directory with the built web app, served as static files in production. */
  webDistDir: string;
}

export function loadConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  loadEnvOnce();
  const env = process.env;
  const dataDir = overrides.dataDir ?? resolvePath(env.DATA_DIR, './var');
  const publicUrl = env.PUBLIC_URL ?? 'http://localhost:4200';
  const every = parseBackupEveryHours(env.BACKUP_EVERY_HOURS);
  const config: AppConfig = {
    fivetoolsSrcPath: resolvePath(env.FIVETOOLS_SRC_PATH, './5etools-data/5etools-src'),
    fivetoolsImgPath: resolvePath(env.FIVETOOLS_IMG_PATH, './5etools-data/5etools-img'),
    dataDir,
    appDbPath: join(dataDir, 'app.sqlite'),
    indexDbPath: join(dataDir, 'index.sqlite'),
    uploadsDir: join(dataDir, 'uploads'),
    backupDir: resolvePath(env.BACKUP_DIR, join(dataDir, 'backups')),
    backupKeep: parseBackupKeep(env.BACKUP_KEEP),
    backupEveryHours: every.hours,
    backupEveryHoursError: every.error,
    eventsMaxConnections: parseIntInRange(env.EVENTS_MAX_CONNECTIONS, 500, 1, 100_000),
    eventsMaxPerCampaign: parseIntInRange(env.EVENTS_MAX_PER_CAMPAIGN, 100, 1, 100_000),
    eventsHeartbeatMs: parseIntInRange(env.EVENTS_HEARTBEAT_MS, 25_000, 20, 55_000),
    history: parseHistoryConfig(env),
    publicUrl,
    secureCookies: env.SECURE_COOKIES ? env.SECURE_COOKIES === '1' || env.SECURE_COOKIES === 'true' : publicUrl.startsWith('https://'),
    trustProxy: env.TRUST_PROXY === '1' || env.TRUST_PROXY === 'true',
    port: Number(env.PORT ?? 3000),
    isProduction: env.NODE_ENV === 'production',
    webDistDir: resolvePath(env.WEB_DIST_DIR, './apps/web/dist/web/browser'),
    ...overrides,
  };
  return config;
}

export function ensureDataDirs(config: AppConfig) {
  mkdirSync(config.dataDir, { recursive: true });
  mkdirSync(config.uploadsDir, { recursive: true });
}
