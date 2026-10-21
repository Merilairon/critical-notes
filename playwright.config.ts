/**
 * Browser tests (`pnpm e2e`). They start the bundled server (`pnpm build` first) on a fresh data folder and
 * drive the system Chrome. They need the real 5etools data (Goblin|MM, Fire Bolt|PHB, Fireball|PHB).
 *   E2E_BASE=http://localhost:3000   test a server that is already running (a fresh instance: the first test sets it up)
 *   CHROME_PATH=/path/to/chrome      another Chrome or Chromium than /opt/google/chrome/chrome
 *   E2E_PHONE_BASE=http://localhost:3001   the phone project's own fresh instance (required together with E2E_BASE, else no phone project)
 *   E2E_NO_ARTIFACTS=1               no traces, HTML report, server log or error details (CI sets it: they would hold rules text)
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from '@playwright/test';
import { BASE_URL, DM_STATE, PHONE_BASE_URL, PHONE_DEVICE, PHONE_DM_STATE } from './e2e/env';

const noArtifacts = !!process.env.E2E_NO_ARTIFACTS;
const external = !!process.env.E2E_BASE;
// Set once in the main process; the workers inherit it
process.env.E2E_DATA_DIR ??= external ? '' : mkdtempSync(join(tmpdir(), 'cn-e2e-'));
process.env.E2E_PHONE_DATA_DIR ??= PHONE_BASE_URL && !process.env.E2E_PHONE_BASE ? mkdtempSync(join(tmpdir(), 'cn-e2e-')) : '';

/** A bundled server on a fresh data folder. The log holds names and titles of campaign content: not in a CI log. */
const server = (url: string, dataDir = '') => ({
  command: 'node apps/server/dist/main.mjs',
  url: `${url}/api/health`,
  env: { NODE_ENV: 'production', PORT: new URL(url).port, DATA_DIR: dataDir, PUBLIC_URL: url },
  reuseExistingServer: false,
  timeout: 120_000,
  stdout: noArtifacts ? ('ignore' as const) : ('pipe' as const),
  stderr: noArtifacts ? ('ignore' as const) : ('pipe' as const),
});

export default defineConfig({
  testDir: 'e2e',
  // One server, flows that build on each other: run everything in order
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: noArtifacts ? [['./e2e/ci-reporter.ts']] : [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  outputDir: 'test-results',
  use: {
    baseURL: BASE_URL,
    viewport: { width: 1440, height: 1000 },
    ...(process.env.CHROME_PATH ? { launchOptions: { executablePath: process.env.CHROME_PATH } } : { channel: 'chrome' }),
    trace: noArtifacts ? 'off' : 'retain-on-failure',
    screenshot: 'off',
    video: 'off',
  },
  projects: [
    { name: 'setup', testMatch: /auth\.setup\.ts/ },
    { name: 'app', testMatch: /\.spec\.ts/, dependencies: ['setup'], use: { storageState: DM_STATE } },
    // The phone: players.spec.ts and combat.spec.ts again, with the player's screens in an emulated phone, plus the
    // phone checks inside players.spec.ts / combat.spec.ts. On its own server (see e2e/env.ts), so its sign-ups
    // do not count against the desktop run's. `pnpm e2e:phone` runs only this project.
    ...(PHONE_BASE_URL
      ? [
          { name: 'phone-setup', testMatch: /auth\.setup\.ts/, use: { baseURL: PHONE_BASE_URL }, metadata: { state: PHONE_DM_STATE } },
          {
            name: 'phone',
            testMatch: /(players|combat)\.spec\.ts/,
            dependencies: ['phone-setup'],
            metadata: { phone: true },
            use: { ...PHONE_DEVICE, baseURL: PHONE_BASE_URL, storageState: PHONE_DM_STATE },
          },
        ]
      : []),
  ],
  webServer: [
    ...(external ? [] : [server(BASE_URL, process.env.E2E_DATA_DIR)]),
    ...(PHONE_BASE_URL && !process.env.E2E_PHONE_BASE ? [server(PHONE_BASE_URL, process.env.E2E_PHONE_DATA_DIR)] : []),
  ],
});
