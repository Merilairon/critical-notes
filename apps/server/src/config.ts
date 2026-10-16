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

export interface AppConfig {
  fivetoolsSrcPath: string;
  fivetoolsImgPath: string;
  dataDir: string;
  appDbPath: string;
  indexDbPath: string;
  uploadsDir: string;
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
  const config: AppConfig = {
    fivetoolsSrcPath: resolvePath(env.FIVETOOLS_SRC_PATH, './5etools-data/5etools-src'),
    fivetoolsImgPath: resolvePath(env.FIVETOOLS_IMG_PATH, './5etools-data/5etools-img'),
    dataDir,
    appDbPath: join(dataDir, 'app.sqlite'),
    indexDbPath: join(dataDir, 'index.sqlite'),
    uploadsDir: join(dataDir, 'uploads'),
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
