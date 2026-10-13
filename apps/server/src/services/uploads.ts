import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { and, eq } from 'drizzle-orm';
import sharp from 'sharp';
import type { UploadDto } from '@cn/shared';
import type { AppDb } from '../db';
import { uploads } from '../db/schema';
import { badRequest, HttpError, notFound } from '../lib/http';
import { newId } from '../lib/ids';

export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;
/** Images with more pixels are refused before they are decoded (decompression bombs). */
const MAX_INPUT_PIXELS = 100_000_000;
/** Longer edges are scaled down (a large battle map still fits). */
const MAX_EDGE = 8192;
const THUMB_EDGE = 400;

/** Detects allowed image types from magic bytes (the client-provided type is never trusted). SVG is not allowed. */
export function sniffImageType(buf: Uint8Array): string | null {
  const at = (i: number, ...bytes: number[]) => bytes.every((b, j) => buf[i + j] === b);
  if (buf.length >= 8 && at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
  if (buf.length >= 3 && at(0, 0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (buf.length >= 6 && (at(0, 0x47, 0x49, 0x46, 0x38, 0x37, 0x61) || at(0, 0x47, 0x49, 0x46, 0x38, 0x39, 0x61))) return 'image/gif';
  if (buf.length >= 12 && at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return 'image/webp';
  return null;
}

/**
 * Decodes and re-encodes an image in its own format: applies the EXIF orientation and drops every piece of
 * metadata (location, camera, comments, embedded profiles), so nothing but the pixels reaches other players.
 */
export async function cleanImage(buf: Uint8Array, mime: string): Promise<{ data: Buffer; width: number; height: number; thumb: Buffer }> {
  const animated = mime === 'image/gif' || mime === 'image/webp';
  try {
    const img = sharp(buf, { animated, limitInputPixels: MAX_INPUT_PIXELS, failOn: 'error' })
      .rotate()
      .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: 'inside', withoutEnlargement: true });
    const encoded =
      mime === 'image/png' ? img.png() : mime === 'image/jpeg' ? img.jpeg({ quality: 88, mozjpeg: true }) : mime === 'image/gif' ? img.gif() : img.webp({ quality: 88 });
    const { data, info } = await encoded.toBuffer({ resolveWithObject: true });
    const thumb = await sharp(data).resize({ width: THUMB_EDGE, height: THUMB_EDGE, fit: 'inside', withoutEnlargement: true }).webp({ quality: 80 }).toBuffer();
    return { data, width: info.width, height: info.pageHeight ?? info.height, thumb };
  } catch {
    throw badRequest('The image could not be read');
  }
}

export class UploadService {
  constructor(
    private readonly db: AppDb,
    private readonly dir: string,
  ) {
    mkdirSync(dir, { recursive: true });
  }

  async store(campaignId: string, userId: string, file: File): Promise<UploadDto> {
    if (file.size > MAX_UPLOAD_BYTES) throw new HttpError(413, `File is larger than ${MAX_UPLOAD_BYTES / 1024 / 1024} MB`);
    return this.storeBytes(campaignId, userId, file.name, new Uint8Array(await file.arrayBuffer()));
  }

  /** Stores image bytes (checked by their content, never by name or declared type). */
  async storeBytes(campaignId: string, userId: string, name: string, buf: Uint8Array): Promise<UploadDto> {
    if (buf.length > MAX_UPLOAD_BYTES) throw new HttpError(413, `File is larger than ${MAX_UPLOAD_BYTES / 1024 / 1024} MB`);
    const mime = sniffImageType(buf);
    if (!mime) throw badRequest('Only PNG, JPEG, GIF and WebP images can be uploaded');
    const { data, width, height, thumb } = await cleanImage(buf, mime);
    const id = newId();
    const filename = (name || 'upload').replace(/[^\w.\- ]+/g, '_').slice(0, 120);
    await writeFile(join(this.dir, id), data, { flag: 'wx' });
    await writeFile(join(this.dir, `${id}.thumb`), thumb, { flag: 'wx' });
    this.db
      .insert(uploads)
      .values({ id, campaignId, ownerUserId: userId, filename, mime, size: data.length, sha256: createHash('sha256').update(data).digest('hex'), width, height })
      .run();
    return { id, url: `/api/uploads/${id}`, mime, size: data.length, filename };
  }

  get(id: string) {
    const row = this.db.select().from(uploads).where(eq(uploads.id, id)).get();
    if (!row) throw notFound();
    return row;
  }

  async read(id: string): Promise<Uint8Array> {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw notFound();
    return readFile(join(this.dir, id));
  }

  /** A small WebP preview (null for files stored before thumbnails existed). */
  async readThumb(id: string): Promise<Uint8Array | null> {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw notFound();
    return readFile(join(this.dir, `${id}.thumb`)).catch(() => null);
  }

  list(campaignId: string) {
    return this.db.select().from(uploads).where(eq(uploads.campaignId, campaignId)).all();
  }

  belongsTo(id: string, campaignId: string): boolean {
    return !!this.db.select({ id: uploads.id }).from(uploads).where(and(eq(uploads.id, id), eq(uploads.campaignId, campaignId))).get();
  }
}
