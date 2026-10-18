/**
 * Task M3.3 acceptance: "a restore drill (backup -> wipe -> restore -> start) passes in CI".
 * Runs `scripts/restore-drill.mjs` against the sources (tsx), so the test needs no build. The same script runs against the built
 * bundle with `pnpm drill` (build first); that is what M5.2's CI job calls. See docs/STATUS.md.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SERVER_DIR = join(import.meta.dirname, '..');

function drill(mode: 'src' | 'dist') {
  const r = spawnSync(process.execPath, [join(SERVER_DIR, 'scripts', 'restore-drill.mjs'), '--mode', mode], { cwd: SERVER_DIR, encoding: 'utf8', timeout: 240_000 });
  return { status: r.status, log: r.stderr };
}

describe('restore drill', () => {
  it('backup -> wipe -> restore -> start -> verify over HTTP passes (sources)', () => {
    const r = drill('src');
    expect(r.log).toContain('PASSED');
    expect(r.status, r.log).toBe(0);
  }, 260_000);

  // The bundle is what the Docker image runs; it exists after `pnpm --filter @cn/server build`
  it.runIf(existsSync(join(SERVER_DIR, 'dist', 'admin.mjs')) && existsSync(join(SERVER_DIR, 'dist', 'main.mjs')))('the same drill passes against the built bundle (dist/)', () => {
    const r = drill('dist');
    expect(r.status, r.log).toBe(0);
  }, 260_000);
});
