import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from '../config';

/** Injected by `scripts/build.mjs` (esbuild `define`) in the bundle; undefined under tsx and in tests. */
declare const __APP_VERSION__: string | undefined;

function readVersion(file: string): string | null {
  try {
    const v = (JSON.parse(readFileSync(file, 'utf8')) as { version?: unknown }).version;
    return typeof v === 'string' && v ? v : null;
  } catch {
    return null;
  }
}

/**
 * The app version for the backup manifest (informational only, no compatibility decision uses it).
 * Root `package.json` version if present, otherwise `apps/server/package.json`. M5.4 owns the single source of truth.
 */
export function appVersion(): string {
  if (typeof __APP_VERSION__ === 'string') return __APP_VERSION__;
  return readVersion(join(REPO_ROOT, 'package.json')) ?? readVersion(join(REPO_ROOT, 'apps', 'server', 'package.json')) ?? '0.0.0';
}
