import { afterEach, describe, expect, it, vi } from 'vitest';
import { readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BackupListDto } from '@cn/shared';
import { runAdmin } from '../src/cli/run';
import { loadConfig } from '../src/config';
import { createShutdown, installSignalHandlers, type ShutdownDeps } from '../src/lib/shutdown';
import { readBackup } from '../src/services/backups';
import { BackupScheduler } from '../src/services/backup-scheduler';
import { makeEnv, noise, upId } from './backup-helpers';
import { adminClient, seedBigUploads, startServer, tempRoot, type ServerProc } from './server-proc';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function fakeDeps(over: Partial<ShutdownDeps> = {}) {
  const calls: string[] = [];
  const deps: ShutdownDeps = {
    server: {
      close: (cb) => {
        calls.push('close');
        cb?.();
      },
      closeIdleConnections: () => calls.push('idle'),
      closeAllConnections: () => calls.push('all'),
    },
    stopScheduler: async () => {
      calls.push('scheduler');
    },
    backupRunning: () => false,
    closeDatabases: () => calls.push('dbs'),
    log: () => undefined,
    ...over,
  };
  return { deps, calls };
}

describe('createShutdown (no global handlers)', () => {
  it('idle: stops accepting, stops the scheduler, closes the databases and exits 0, fast', async () => {
    const exit = vi.fn();
    const { deps, calls } = fakeDeps();
    const s = createShutdown({ exit });
    s.arm(deps);
    const t0 = Date.now();
    s.handle('SIGTERM');
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    expect(Date.now() - t0).toBeLessThan(500);
    expect(calls).toEqual(expect.arrayContaining(['close', 'idle', 'scheduler', 'dbs']));
    expect(calls.indexOf('dbs')).toBeGreaterThan(calls.indexOf('close'));
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('waits for a running backup (any trigger) before closing the databases', async () => {
    const exit = vi.fn();
    let running = true;
    const { deps, calls } = fakeDeps({ backupRunning: () => running });
    const s = createShutdown({ exit });
    s.arm(deps);
    s.handle('SIGTERM');
    await sleep(300);
    expect(exit).not.toHaveBeenCalled();
    expect(calls).not.toContain('dbs');
    running = false;
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    expect(calls).toContain('dbs');
  });

  it('gives up waiting after backupWaitMs and still exits 0', async () => {
    const exit = vi.fn();
    const { deps, calls } = fakeDeps({ backupRunning: () => true, backupWaitMs: 250 });
    const s = createShutdown({ exit });
    s.arm(deps);
    const t0 = Date.now();
    s.handle('SIGINT');
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    expect(Date.now() - t0).toBeGreaterThanOrEqual(240);
    expect(calls).toContain('dbs');
  });

  it('waits for a scheduled run that stop() is still awaiting', async () => {
    const exit = vi.fn();
    let release!: () => void;
    const { deps } = fakeDeps({ stopScheduler: () => new Promise<void>((r) => (release = r)) });
    const s = createShutdown({ exit });
    s.arm(deps);
    s.handle('SIGTERM');
    await sleep(200);
    expect(exit).not.toHaveBeenCalled();
    release();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
  });

  it('a second signal exits at once (143 for SIGTERM, 130 for SIGINT), also before the server is armed', () => {
    const exit = vi.fn();
    const { deps } = fakeDeps({ backupRunning: () => true });
    const s = createShutdown({ exit });
    s.handle('SIGINT'); // not armed: still starting
    expect(exit).toHaveBeenLastCalledWith(130);
    s.arm(deps);
    s.handle('SIGTERM'); // first: clean shutdown begins
    expect(exit).toHaveBeenCalledTimes(1);
    s.handle('SIGTERM');
    expect(exit).toHaveBeenLastCalledWith(143);
    s.handle('SIGINT');
    expect(exit).toHaveBeenLastCalledWith(130);
  });

  it('cuts the remaining connections after the drain time', async () => {
    const exit = vi.fn();
    const { deps, calls } = fakeDeps({ server: { close: () => undefined, closeAllConnections: () => calls.push('all') }, httpDrainMs: 100 });
    const s = createShutdown({ exit });
    s.arm(deps);
    s.handle('SIGTERM');
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    expect(calls).toContain('all');
  });

  it('installSignalHandlers uses on() for both signals and removes them again (no leaks)', () => {
    const on = vi.fn();
    const off = vi.fn();
    const handle = vi.fn();
    const remove = installSignalHandlers({ handle }, { on, off } as never);
    expect(on.mock.calls.map((c) => c[0])).toEqual(['SIGTERM', 'SIGINT']);
    (on.mock.calls[0]![1] as () => void)();
    (on.mock.calls[1]![1] as () => void)();
    expect(handle.mock.calls).toEqual([['SIGTERM'], ['SIGINT']]);
    remove();
    expect(off.mock.calls.map((c) => c[0])).toEqual(['SIGTERM', 'SIGINT']);
    expect(off.mock.calls[0]![1]).toBe(on.mock.calls[0]![1]);
  });

  it('importing the module installs nothing', () => {
    expect(process.listenerCount('SIGTERM') + process.listenerCount('SIGINT')).toBe(0);
  });
});

describe('with the real BackupService and scheduler', () => {
  it('a manual backup in progress is waited for, then published complete, with no partial file left', async () => {
    const env = makeEnv();
    try {
      env.addUpload(upId(1), noise(2000));
      let open!: () => void;
      const gate = new Promise<void>((r) => (open = r));
      const service = env.service({ hooks: { beforeSnapshot: () => gate } });
      const scheduler = new BackupScheduler({ service, config: { ...env.config, backupEveryHours: 24 }, log: () => undefined });
      const exit = vi.fn();
      const s = createShutdown({ exit });
      s.arm({ server: { close: (cb) => cb?.() }, stopScheduler: () => scheduler.stop(), backupRunning: () => service.isRunning(), closeDatabases: () => undefined, log: () => undefined });
      const run = service.create({ actor: 'u1', trigger: 'api' });
      await vi.waitFor(() => expect(service.isRunning()).toBe(true));
      s.handle('SIGTERM');
      await sleep(300);
      expect(exit, 'still waiting for the backup').not.toHaveBeenCalled();
      open();
      const r = await run;
      await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
      expect(service.isRunning()).toBe(false);
      const names = readdirSync(service.dir);
      expect(names.filter((n) => n.startsWith('.partial') || n.startsWith('.tmp'))).toEqual([]);
      expect(names).toContain(r.name);
      await readBackup(join(service.dir, r.name)); // complete and verified
    } finally {
      env.cleanup();
    }
  });
});

describe('the real server process (spawned)', () => {
  const procs: ServerProc[] = [];
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(procs.splice(0).map((p) => p.stop()));
    for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
  });
  const boot = async (extraEnv: Record<string, string> = {}, seed?: (dir: string) => void) => {
    const root = tempRoot();
    roots.push(root);
    seed?.(root);
    const p = await startServer(root, extraEnv);
    procs.push(p);
    expect(p.port, p.out()).toBeGreaterThan(0);
    return p;
  };
  const signalAndWait = async (p: ServerProc, signal: NodeJS.Signals) => {
    const t0 = Date.now();
    p.child.kill(signal);
    const r = await p.exited;
    return { ...r, ms: r.at - t0 };
  };

  for (const [label, env] of [
    ['scheduler off', {}],
    ['scheduler on', { BACKUP_EVERY_HOURS: '24' }],
  ] as const) {
    for (const signal of ['SIGTERM', 'SIGINT'] as const) {
      it(`${signal} on an idle server (${label}) exits 0 in well under 3 s`, async () => {
        const p = await boot(env);
        const r = await signalAndWait(p, signal);
        expect(r.code, p.out()).toBe(0);
        expect(r.ms).toBeLessThan(2000);
      }, 90_000);
    }
  }

  /** A running manual web backup, held before its snapshot until `release()` creates the hold file. */
  const heldBackup = async (extra: Record<string, string> = {}) => {
    const hold = join(tempRoot(), 'release');
    roots.push(join(hold, '..'));
    const p = await boot({ CN_TEST_BACKUP_HOLD_FILE: hold, ...extra }, (d) => seedBigUploads(d, 3, 1));
    const api = await adminClient(p.port);
    expect((await api('POST', '/api/admin/backups')).status).toBe(202);
    await vi.waitFor(async () => expect(((await (await api('GET', '/api/admin/backups')).json()) as BackupListDto).running).not.toBeNull());
    return { p, release: () => writeFileSync(hold, '') };
  };
  const zipsIn = (p: ServerProc) => readdirSync(join(p.dataDir, 'backups')).filter((n) => /^backup-.*\.zip$/.test(n));

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    it(`${signal} during a manual web backup waits for it to finish and leaves a complete, verified zip and no leftovers`, async () => {
      const { p, release } = await heldBackup();
      p.child.kill(signal);
      await sleep(500);
      expect(p.child.exitCode, 'still waiting for the backup').toBeNull();
      expect(p.child.signalCode).toBeNull();
      expect(zipsIn(p)).toEqual([]);
      const releasedAt = Date.now();
      release();
      const r = await p.exited;
      expect(r.code, p.out()).toBe(0);
      expect(r.at).toBeGreaterThanOrEqual(releasedAt);
      const dir = join(p.dataDir, 'backups');
      const zips = zipsIn(p);
      expect(zips).toHaveLength(1);
      await readBackup(join(dir, zips[0]!));
      expect(readdirSync(dir).filter((n) => n.startsWith('.partial') || n.startsWith('.tmp') || n === '.lock')).toEqual([]);
    }, 90_000);
  }

  it('gives up after the wait budget on a backup that cannot finish: exit 0, nothing published', async () => {
    const { p } = await heldBackup({ SHUTDOWN_BACKUP_WAIT_MS: '1000' }); // never released
    p.child.kill('SIGTERM');
    const r = await p.exited;
    expect(r.code, p.out()).toBe(0);
    expect(p.out()).toContain('the running backup did not finish in time');
    expect(zipsIn(p)).toEqual([]);
    // the process cleaned up after itself: nothing aside, no lock, so a new backup works at once
    const dir = join(p.dataDir, 'backups');
    expect(readdirSync(dir).filter((n) => n.startsWith('.partial') || n.startsWith('.tmp') || n === '.lock')).toEqual([]);
    const config = loadConfig({ dataDir: p.dataDir, appDbPath: join(p.dataDir, 'app.sqlite'), indexDbPath: join(p.dataDir, 'index.sqlite'), uploadsDir: join(p.dataDir, 'uploads'), backupDir: dir });
    const cli = await runAdmin(['backup'], { config, out: () => undefined, err: () => undefined });
    expect(cli).toBe(0);
    expect(zipsIn(p)).toHaveLength(1);
  }, 90_000);

  for (const [signal, code] of [
    ['SIGTERM', 143],
    ['SIGINT', 130],
  ] as const) {
    it(`a second ${signal} during the wait force-kills (${code}) and publishes nothing`, async () => {
      const { p } = await heldBackup(); // never released
      p.child.kill(signal);
      await sleep(300);
      expect(p.child.exitCode, 'still waiting for the backup').toBeNull();
      p.child.kill(signal);
      const r = await p.exited;
      expect(r.code, p.out()).toBe(code);
      expect(zipsIn(p)).toEqual([]);
    }, 90_000);
  }
});
