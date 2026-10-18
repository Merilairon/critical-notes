import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createServices } from '../src/app';
import { createFixture, type Fixture } from './helpers';

// CN_TEST_BACKUP_HOLD_FILE pauses a backup before its snapshot (a test seam). It must do nothing in production.
let fx: Fixture;
const saved = process.env.CN_TEST_BACKUP_HOLD_FILE;
beforeAll(async () => {
  fx = await createFixture();
});
afterAll(() => fx.cleanup());
afterEach(() => {
  if (saved === undefined) delete process.env.CN_TEST_BACKUP_HOLD_FILE;
  else process.env.CN_TEST_BACKUP_HOLD_FILE = saved;
});

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const services = (isProduction: boolean) => createServices({ config: { ...fx.config, isProduction }, indexDb: fx.indexDb, db: fx.db });

describe('the backup hold test seam', () => {
  it('is ignored in production: the backup does not wait for a file that never appears', async () => {
    process.env.CN_TEST_BACKUP_HOLD_FILE = join(fx.root, 'never-created');
    const r = await Promise.race([services(true).backups.create({ actor: 'u1', trigger: 'cli' }), sleep(20_000).then(() => 'waited' as const)]);
    expect(r).not.toBe('waited');
    expect(r).toMatchObject({ trigger: 'cli' });
  }, 30_000);

  it('outside production the backup waits until the file exists', async () => {
    const hold = join(fx.root, 'release');
    process.env.CN_TEST_BACKUP_HOLD_FILE = hold;
    const svc = services(false).backups;
    let done = false;
    const run = svc.create({ actor: 'u1', trigger: 'cli' }).then((x) => ((done = true), x));
    await sleep(400);
    expect(done).toBe(false);
    expect(svc.isRunning()).toBe(true);
    writeFileSync(hold, '');
    await run;
    expect(done).toBe(true);
  }, 30_000);
});
