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
 * The app version: the root `package.json` `version`, the single source (M5.4). Used by `/api/health` and the backup manifest
 * (informational only; no compatibility decision uses it). The bundle has it baked in by `scripts/build.mjs`, so it never reads a
 * file from an unknown working directory; under tsx (dev, tests) it reads the root file through `REPO_ROOT`.
 */
export function appVersion(): string {
  if (typeof __APP_VERSION__ === 'string') return __APP_VERSION__;
  return readVersion(join(REPO_ROOT, 'package.json')) ?? 'unknown';
}
