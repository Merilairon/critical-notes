/**
 * Serves 5etools-img files: `GET /img/<relative path>`.
 * Path safety: decode once, reject traversal/absolute/odd paths, resolve under the root, then re-check the
 * real path (symlink escape). Only image extensions are served; responses carry ETag + cache headers.
 */
import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { isSafeImagePath } from '@cn/fivetools';
import { Hono } from 'hono';

const MIME: Record<string, string> = {
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
};

export async function resolveImageFile(root: string, requested: string): Promise<string | null> {
  let rel: string;
  try {
    rel = decodeURIComponent(requested);
  } catch {
    return null;
  }
  if (!isSafeImagePath(rel)) return null;
  const rootResolved = resolve(root);
  const candidate = resolve(rootResolved, rel);
  if (!candidate.startsWith(rootResolved + sep)) return null;
  try {
    const [real, realRoot] = await Promise.all([realpath(candidate), realpath(rootResolved)]);
    if (!real.startsWith(realRoot + sep)) return null;
    const s = await stat(real);
    return s.isFile() ? real : null;
  } catch {
    return null;
  }
}

export function imageRoutes(imgRoot: string) {
  const app = new Hono();
  app.get('/*', async (c) => {
    const requested = c.req.path.replace(/^\/img\//, '');
    const file = await resolveImageFile(imgRoot, requested);
    if (!file) return c.text('Not found', 404);
    const s = await stat(file);
    const etag = `"${s.size.toString(16)}-${Math.floor(s.mtimeMs).toString(16)}"`;
    const headers = {
      'Content-Type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
      'Cache-Control': 'public, max-age=86400',
      ETag: etag,
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
    };
    if (c.req.header('If-None-Match') === etag) return c.body(null, 304, headers);
    const stream = Readable.toWeb(createReadStream(file)) as ReadableStream;
    return c.body(stream, 200, { ...headers, 'Content-Length': String(s.size) });
  });
  return app;
}
