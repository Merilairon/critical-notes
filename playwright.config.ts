/**
 * Browser tests (`pnpm e2e`). They start the bundled server (`pnpm build` first) on a fresh data folder and
 * drive the system Chrome. They need the real 5etools data (Goblin|MM, Fire Bolt|PHB, Fireball|PHB).
 *   E2E_BASE=http://localhost:3000   test a server that is already running (a fresh instance: the first test sets it up)
 *   CHROME_PATH=/path/to/chrome      another Chrome or Chromium than /opt/google/chrome/chrome
 *   E2E_NO_ARTIFACTS=1               no traces, HTML report, server log or error details (CI sets it: they would hold rules text)
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from '@playwright/test';
import { BASE_URL, DM_STATE } from './e2e/env';

const noArtifacts = !!process.env.E2E_NO_ARTIFACTS;
const external = !!process.env.E2E_BASE;
// Set once in the main process; the workers inherit it
process.env.E2E_DATA_DIR ??= external ? '' : mkdtempSync(join(tmpdir(), 'cn-e2e-'));

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
  ],
  webServer: external
    ? undefined
    : {
        command: 'node apps/server/dist/main.mjs',
        url: `${BASE_URL}/api/health`,
        env: { NODE_ENV: 'production', PORT: new URL(BASE_URL).port, DATA_DIR: process.env.E2E_DATA_DIR, PUBLIC_URL: BASE_URL },
        reuseExistingServer: false,
        timeout: 120_000,
        // The server log holds names and titles of campaign content: not in a CI log
        stdout: noArtifacts ? 'ignore' : 'pipe',
        stderr: noArtifacts ? 'ignore' : 'pipe',
      },
});
