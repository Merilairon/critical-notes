import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const SERVER_ROOT = join(import.meta.dirname, '..');
export const upName = (n: number) => `0000${n.toString(16).padStart(4, '0')}-0000-4000-8000-${String(n).padStart(12, '0')}`;

export interface ServerProc {
  child: ChildProcess;
  dataDir: string;
  port: number;
  out: () => string;
  /** Resolves with the exit status once the process ends. */
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null; at: number }>;
  stop(): Promise<void>;
}

export const tempRoot = () => mkdtempSync(join(tmpdir(), 'cn-srv-'));

/** `n` upload files of `mib` MiB of random bytes in DATA_DIR/uploads: a backup of them takes a while (they do not compress). */
export function seedBigUploads(dataDir: string, n: number, mib: number): void {
  mkdirSync(join(dataDir, 'uploads'), { recursive: true });
  const chunk = randomBytes(1024 * 1024);
  for (let i = 0; i < n; i++) writeFileSync(join(dataDir, 'uploads', upName(i + 1)), Buffer.concat(Array.from({ length: mib }, () => chunk)));
}

/** Starts the real `src/main.ts` on a random port with temp directories. Resolves once it listens (or has exited). */
export async function startServer(dataDir: string, extraEnv: Record<string, string> = {}): Promise<ServerProc> {
  const child = spawn(process.execPath, ['--import', 'tsx', join(SERVER_ROOT, 'src', 'main.ts')], {
    cwd: SERVER_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      CN_SKIP_DOTENV: '1',
      DATA_DIR: dataDir,
      PORT: '0',
      PUBLIC_URL: 'http://localhost:4200',
      FIVETOOLS_SRC_PATH: join(dataDir, 'nope'),
      FIVETOOLS_IMG_PATH: join(dataDir, 'nope2'),
      BACKUP_EVERY_HOURS: '',
      BACKUP_DIR: '',
      ...extraEnv,
    },
  });
  let buf = '';
  child.stdout!.on('data', (d: Buffer) => (buf += d.toString()));
  child.stderr!.on('data', (d: Buffer) => (buf += d.toString()));
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null; at: number }>((resolve) => child.once('exit', (code, signal) => resolve({ code, signal, at: Date.now() })));
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start: ${buf}`)), 60_000);
    const check = () => {
      const m = /listening on http:\/\/localhost:(\d+)/.exec(buf);
      if (m) {
        clearTimeout(timer);
        resolve(Number(m[1]));
      }
    };
    child.stdout!.on('data', check);
    void exited.then(() => {
      clearTimeout(timer);
      resolve(0);
    });
  });
  return {
    child,
    dataDir,
    port,
    out: () => buf,
    exited,
    async stop() {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await exited;
    },
  };
}

/** Admin session on a fresh server: runs /setup, returns a fetch helper that sends the cookie and the same-origin header. */
export async function adminClient(port: number) {
  const base = `http://127.0.0.1:${port}`;
  const headers = { 'content-type': 'application/json', origin: 'http://localhost:4200' };
  const res = await fetch(`${base}/api/auth/setup`, { method: 'POST', headers, body: JSON.stringify({ username: 'gm', displayName: 'GM', password: 'correct horse battery' }) });
  if (res.status !== 201) throw new Error(`setup failed: ${res.status} ${await res.text()}`);
  const cookie = (res.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
  return (method: string, path: string) => fetch(`${base}${path}`, { method, headers: { ...headers, cookie } });
}

export { rmSync };
