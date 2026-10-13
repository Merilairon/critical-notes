import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { makeEditionLists } from '@cn/fivetools';
import sharp from 'sharp';
import { miniFiles } from '../../../packages/fivetools/test/fixtures/mini';
import { createApp } from '../src/app';
import { loadConfig, type AppConfig } from '../src/config';
import { openAppDb, type AppDb } from '../src/db';
import { openIndexDb, type IndexDb } from '../src/reference/index-db';
import { runIndexer } from '../src/reference/indexer';

export const fixtureLists = makeEditionLists({ classic: ['TST', 'OLD'], modern: ['XTST'], legacy: ['OLD'] });

export interface Fixture {
  root: string;
  srcPath: string;
  imgPath: string;
  config: AppConfig;
  indexDb: IndexDb;
  db: AppDb;
  cleanup(): void;
}

/** Writes the synthetic mini dataset (and a tiny image tree) to a temp dir and indexes it. */
export async function createFixture(): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), 'cn-test-'));
  const srcPath = join(root, '5etools-src');
  const imgPath = join(root, '5etools-img');
  for (const f of miniFiles) {
    const abs = join(srcPath, 'data', f.path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, JSON.stringify(f.json));
  }
  mkdirSync(join(imgPath, 'bestiary', 'TST'), { recursive: true });
  writeFileSync(join(imgPath, 'bestiary', 'TST', 'Gloomling.webp'), Buffer.from('RIFF0000WEBPVP8 fake'));
  writeFileSync(join(root, 'secret.webp'), 'outside the image root');

  const dataDir = join(root, 'var');
  mkdirSync(dataDir, { recursive: true });
  const config = loadConfig({
    fivetoolsSrcPath: srcPath,
    fivetoolsImgPath: imgPath,
    dataDir,
    appDbPath: join(dataDir, 'app.sqlite'),
    indexDbPath: join(dataDir, 'index.sqlite'),
    uploadsDir: join(dataDir, 'uploads'),
  });
  const indexDb = openIndexDb(config.indexDbPath);
  await runIndexer({ srcPath, db: indexDb, editionLists: fixtureLists });
  const db = openAppDb(config.appDbPath);
  return {
    root,
    srcPath,
    imgPath,
    config,
    indexDb,
    db,
    cleanup() {
      indexDb.close();
      db.$client.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

export type TestApp = ReturnType<typeof createApp>['app'];

/** A small client that keeps cookies, sends JSON with a same-origin header, and parses responses. */
export class TestClient {
  cookie = '';
  constructor(readonly app: TestApp) {}

  async request(method: string, path: string, body?: unknown) {
    const headers: Record<string, string> = { origin: 'http://localhost', host: 'localhost' };
    if (this.cookie) headers.cookie = this.cookie;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await this.app.request(`http://localhost${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) {
      const pair = setCookie.split(';')[0]!;
      this.cookie = pair.endsWith('=') ? '' : pair;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- loose JSON access in assertions
    const data: any = res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text();
    return { status: res.status, body: data, res };
  }
  get = (path: string) => this.request('GET', path);
  post = (path: string, body?: unknown) => this.request('POST', path, body ?? {});
  patch = (path: string, body: unknown) => this.request('PATCH', path, body);
  put = (path: string, body: unknown) => this.request('PUT', path, body);
  delete = (path: string) => this.request('DELETE', path);
}

/** Creates the app for a fixture and signs in a fresh admin (first-run setup). */
export async function createSignedInApp(fx: Fixture) {
  const { app, services } = createApp({ config: fx.config, indexDb: fx.indexDb, db: fx.db });
  const client = new TestClient(app);
  const res = await client.post('/api/auth/setup', { username: 'dm', displayName: 'The DM', password: 'correct horse battery' });
  if (res.status !== 201) throw new Error(`setup failed: ${JSON.stringify(res.body)}`);
  return { app, services, client };
}

/** A real (decodable) image; `exifCopyright` embeds EXIF metadata, as a phone photo carries its location. */
export async function testImage(format: 'png' | 'jpeg' = 'png', opts: { width?: number; height?: number; exifCopyright?: string } = {}): Promise<Uint8Array> {
  let img = sharp({ create: { width: opts.width ?? 6, height: opts.height ?? 4, channels: 3, background: '#b33' } });
  if (opts.exifCopyright) img = img.withExif({ IFD0: { Copyright: opts.exifCopyright } });
  return new Uint8Array(await (format === 'png' ? img.png() : img.jpeg()).toBuffer());
}
