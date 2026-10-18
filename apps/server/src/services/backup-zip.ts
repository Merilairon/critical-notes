/**
 * The backup zip format: a bounded writer, and a bounded reader that verifies a zip and extracts it
 * (docs/design/backup.md sections 3, 5, 6 and 9). Restore (M3.3) reuses the reader as it is.
 *
 * WRITER. Every entry is a `ZipDeflate` stream (level 1, level 6 for the database; never stored, never level 0),
 * pushed in 64 KiB chunks with an `await` on the output write between chunks (back-pressure). fflate's `Zip` only
 * ever sees ONE entry, to produce that entry's local header, data and data descriptor; this module writes the central
 * directory itself, because `Zip.end()` writes 32-bit offsets and a 16-bit entry count (an archive over 4 GiB or with
 * over 65,535 entries would be corrupt) while this one adds the zip64 records when they are needed.
 *
 * READER. It reads the central directory with positional reads and inflates every entry with `node:zlib`, NOT with
 * fflate's streaming `Unzip`. Measured (docs/PLAN.md): that reader finds the end of an entry by scanning the data for
 * `PK\x07\x08` / `PK\x01\x02`, and deflate emits incompressible data (images!) as stored blocks, so it truncates real
 * uploads that happen to contain those four bytes. The format is unchanged: a standard zip that unzip and Python read.
 *
 * Everything the reader is told by the archive (names, sizes, the manifest, the checksums) is attacker-controlled; it
 * is only ever compared with what was actually read.
 */
import { createHash } from 'node:crypto';
import { constants as fsc } from 'node:fs';
import { mkdir, open, readdir, rm, rmdir, stat, type FileHandle } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { pipeline, Readable } from 'node:stream';
import { crc32, createInflateRaw, inflateRawSync } from 'node:zlib';
import { Zip, ZipDeflate } from 'fflate';
import { z } from 'zod';

const KiB = 1024;
const MiB = 1024 * KiB;
export const CHUNK = 64 * KiB;

/** Same constant for the writer and the reader (design 5 and 9.2): upload files plus manifest, database and checksums. */
export const MAX_UPLOAD_FILES = 200_000;
export const FIXED_ENTRIES = 3;
export const MAX_ENTRIES = MAX_UPLOAD_FILES + FIXED_ENTRIES;
export const MAX_MANIFEST_BYTES = 1 * MiB;
export const MAX_CHECKSUMS_BYTES = 48 * MiB;
/** `MAX_UPLOAD_BYTES` (15 MiB) + 1 MiB. */
export const MAX_UPLOAD_ENTRY_BYTES = 16 * MiB;
export const MAX_THUMB_ENTRY_BYTES = 4 * MiB;
/** The writer refuses an entry of 4 GiB or more; the reader caps `app.sqlite` at the same size. */
export const MAX_DB_ENTRY_BYTES = 4 * 1024 * MiB - 2; // 0xffffffff is the zip64 sentinel
/** Default cap on the total inflated output of one pass (verify mode): 200,000 entries of zeros must not cost 200 GB of CPU. */
export const DEFAULT_TOTAL_BUDGET = 64 * 1024 * MiB;
export const RATIO_LIMIT = 200;
export const DB_RATIO_LIMIT = 50;
/** The database's ratio rule starts later (a fresh, mostly empty database sits near 49:1 at 1 MiB). */
export const DB_RATIO_AFTER = 4 * MiB;
/** The ratio rules only apply after this much output. */
const RATIO_AFTER = 1 * MiB;
export const MAX_NAME_BYTES = 120;
const MAX_EXTRA_BYTES = 64;

export const REFUSAL = 'This is not a complete Critical Notes backup';

export type EntryKind = 'manifest' | 'db' | 'checksums' | 'upload' | 'thumb';
export const UPLOAD_ENTRY_RE = /^uploads\/([0-9a-f-]{36})(\.thumb)?$/;
export const UPLOAD_FILE_RE = /^[0-9a-f-]{36}(\.thumb)?$/;

/** The allowlist of entry names. Anchored, no `m` flag, tested on the whole string. */
export function entryKind(name: string): EntryKind | null {
  if (name === 'manifest.json') return 'manifest';
  if (name === 'app.sqlite') return 'db';
  if (name === 'checksums.json') return 'checksums';
  const m = UPLOAD_ENTRY_RE.exec(name);
  if (m) return m[2] ? 'thumb' : 'upload';
  return null;
}

/** Control characters become `?` and the text is cut at 120 characters: safe to echo untrusted names. */
export function safeText(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, '?').slice(0, 120);
}

export type BackupZipErrorCode = 'invalid' | 'too-new' | 'unsupported';

/** Every structural problem ends in this one error; `message` is the stable user text, `detail` the (sanitised) reason. */
export class BackupZipError extends Error {
  constructor(
    readonly code: BackupZipErrorCode,
    readonly detail: string,
    message = REFUSAL,
  ) {
    super(message);
    this.name = 'BackupZipError';
  }
}
const invalid = (detail: string) => new BackupZipError('invalid', safeText(detail));

// region Manifest and checksums

export const TRIGGERS = ['api', 'cli', 'scheduler'] as const;
export type Trigger = (typeof TRIGGERS)[number];
export const isTrigger = (v: unknown): v is Trigger => typeof v === 'string' && (TRIGGERS as readonly string[]).includes(v);

export const MANIFEST_KIND = 'critical-notes-backup';
export const MANIFEST_FORMAT = 1;

const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const manifestSchema = z.object({
  kind: z.literal(MANIFEST_KIND),
  format: z.number().int().min(1),
  createdAt: z.string().max(40),
  trigger: z.enum(TRIGGERS),
  app: z.object({ version: z.string().max(64) }),
  database: z.object({
    engine: z.string().max(32),
    sqliteVersion: z.string().max(32),
    bytes: count,
    migrations: z.array(z.object({ tag: z.string().max(200).nullable(), hash: z.string().max(128), when: z.number() })).max(10_000),
    latestTag: z.string().max(200).nullable(),
    latestWhen: z.number().nullable(),
  }),
  counts: z.object({ users: count, campaigns: count, uploads: count }),
  uploads: z.object({ files: count, bytes: count, missing: count }),
});
export type Manifest = z.infer<typeof manifestSchema>;

const checksumsSchema = z.object({ entries: z.array(z.object({ path: z.string().max(MAX_NAME_BYTES), size: count, sha256: z.string().regex(/^[0-9a-f]{64}$/) })) });
export type ChecksumEntry = { path: string; size: number; sha256: string };

/** Parses a manifest, refusing a newer format and a foreign engine with their own codes. */
export function parseManifest(raw: Buffer): Manifest {
  let json: unknown;
  try {
    json = JSON.parse(raw.toString('utf8'));
  } catch {
    throw invalid('manifest is not JSON');
  }
  const probe = json as { kind?: unknown; format?: unknown; app?: { version?: unknown } };
  if (!probe || typeof probe !== 'object' || probe.kind !== MANIFEST_KIND) throw invalid('manifest kind');
  if (typeof probe.format === 'number' && probe.format > MANIFEST_FORMAT) {
    const v = typeof probe.app?.version === 'string' ? safeText(probe.app.version) : 'unknown';
    throw new BackupZipError('too-new', 'format', `This backup was made by a newer Critical Notes (version ${v}); update before restoring it`);
  }
  const parsed = manifestSchema.safeParse(json);
  if (!parsed.success) throw invalid('manifest schema');
  if (parsed.data.format !== MANIFEST_FORMAT) throw invalid('manifest format');
  if (parsed.data.database.engine !== 'sqlite') throw new BackupZipError('unsupported', 'engine', 'This backup was made with a database engine this version cannot restore');
  return parsed.data;
}

// endregion

// region Writer

interface CdRecord {
  name: string;
  crc: number;
  csize: number;
  usize: number;
  offset: number;
  /** General purpose flags exactly as fflate wrote them into the local header. */
  flags: number;
}

function dosDateTime(d: Date): { time: number; date: number } {
  const y = d.getFullYear() - 1980;
  if (y < 0 || y > 119) throw new Error('Backup date out of the zip range');
  return { time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1), date: (y << 9) | ((d.getMonth() + 1) << 5) | d.getDate() };
}

async function writeAll(fh: FileHandle, buf: Uint8Array): Promise<void> {
  let off = 0;
  while (off < buf.length) {
    const { bytesWritten } = await fh.write(buf, off, buf.length - off);
    off += bytesWritten;
  }
}

export interface ZipWriterOptions {
  /** Modification time recorded for every entry. */
  mtime: Date;
  /** Called before each write with the number of archive bytes written so far (a test seam; may throw, e.g. ENOSPC). */
  onWrite?: (bytesSoFar: number) => void;
  maxEntries?: number;
  /** Test seam: pretend the archive already holds this many bytes, to exercise the zip64 offset encoding without 4 GiB. */
  offsetBase?: number;
}

export class ZipFileWriter {
  private offset: number;
  private readonly cd: CdRecord[] = [];
  private readonly archiveHash = createHash('sha256');
  constructor(
    private readonly fh: FileHandle,
    private readonly opts: ZipWriterOptions,
  ) {
    this.offset = opts.offsetBase ?? 0;
  }

  get entryCount(): number {
    return this.cd.length;
  }
  get bytesWritten(): number {
    return this.offset;
  }
  /** sha256 of the whole archive; only final after `finish()`. */
  digest(): string {
    return this.archiveHash.copy().digest('hex');
  }

  private async write(buf: Uint8Array): Promise<void> {
    this.opts.onWrite?.(this.offset);
    await writeAll(this.fh, buf);
    this.archiveHash.update(buf);
    this.offset += buf.length;
  }

  /**
   * Adds one entry. `chunks` is read lazily; each chunk is hashed and deflated, and its output is written before the
   * next chunk is pulled, so at most a few 64 KiB chunks are in flight.
   */
  async addFile(name: string, level: 1 | 6, chunks: AsyncIterable<Uint8Array> | Iterable<Uint8Array>): Promise<{ size: number; sha256: string }> {
    if (!entryKind(name)) throw new Error('Refusing to archive an unexpected entry name');
    if (this.cd.length >= (this.opts.maxEntries ?? MAX_ENTRIES)) throw new Error(`A backup holds at most ${MAX_UPLOAD_FILES.toLocaleString('en')} upload files`);
    const start = this.offset;
    const pending: Uint8Array[] = [];
    let zipError: Error | null = null;
    const zip = new Zip((err, data) => {
      if (err) zipError = err;
      else pending.push(data);
    });
    const deflate = new ZipDeflate(name, { level });
    deflate.mtime = this.opts.mtime;
    zip.add(deflate);
    let emitted = 0;
    const flush = async () => {
      while (pending.length) {
        const buf = pending.shift() as Uint8Array;
        await this.write(buf);
        emitted += buf.length;
      }
      if (zipError) throw zipError;
    };
    const sha = createHash('sha256');
    let size = 0;
    for await (const chunk of chunks) {
      if (!chunk.length) continue;
      size += chunk.length;
      if (size > MAX_DB_ENTRY_BYTES) throw new Error('Refusing to archive an entry of 4 GiB or more');
      sha.update(chunk);
      deflate.push(chunk, false);
      await flush();
    }
    deflate.push(new Uint8Array(0), true);
    await flush();
    const headerLen = 30 + Buffer.byteLength(name);
    const csize = emitted - headerLen - 16;
    if (csize >= 0xffffffff) throw new Error('entry too large to store');
    if (csize < 0 || deflate.size !== size) throw new Error('Unexpected zip stream state');
    this.cd.push({ name, crc: deflate.crc >>> 0, csize, usize: size, offset: start, flags: (deflate.flag << 1) | 8 });
    return { size, sha256: sha.digest('hex') };
  }

  /** Writes the central directory and the end records (zip64 where a value does not fit), without any comment. */
  async finish(): Promise<void> {
    const { time, date } = dosDateTime(this.opts.mtime);
    const cdStart = this.offset;
    let cdSize = 0;
    let batch: Buffer[] = [];
    let batchBytes = 0;
    const drain = async () => {
      if (!batch.length) return;
      await this.write(Buffer.concat(batch));
      batch = [];
      batchBytes = 0;
    };
    for (const e of this.cd) {
      const nameBuf = Buffer.from(e.name, 'utf8');
      const big = e.offset >= 0xffffffff;
      const extra = big ? Buffer.alloc(12) : Buffer.alloc(0);
      if (big) {
        extra.writeUInt16LE(1, 0);
        extra.writeUInt16LE(8, 2);
        extra.writeBigUInt64LE(BigInt(e.offset), 4);
      }
      const h = Buffer.alloc(46);
      h.writeUInt32LE(0x02014b50, 0);
      h.writeUInt16LE((3 << 8) | (big ? 45 : 20), 4); // made by: Unix
      h.writeUInt16LE(big ? 45 : 20, 6);
      h.writeUInt16LE(e.flags, 8); // bit 3 (data descriptor) plus ZipDeflate's compression-level hint, as in the local header
      h.writeUInt16LE(8, 10);
      h.writeUInt16LE(time, 12);
      h.writeUInt16LE(date, 14);
      h.writeUInt32LE(e.crc, 16);
      h.writeUInt32LE(e.csize, 20);
      h.writeUInt32LE(e.usize, 24);
      h.writeUInt16LE(nameBuf.length, 28);
      h.writeUInt16LE(extra.length, 30);
      h.writeUInt32LE((0o100600 << 16) >>> 0, 38); // a regular file, 0600
      h.writeUInt32LE(big ? 0xffffffff : e.offset, 42);
      const rec = Buffer.concat([h, nameBuf, extra]);
      batch.push(rec);
      batchBytes += rec.length;
      cdSize += rec.length;
      if (batchBytes >= 1 * MiB) await drain();
    }
    await drain();
    const n = this.cd.length;
    const zip64 = n >= 0xffff || cdStart >= 0xffffffff || cdSize >= 0xffffffff;
    if (zip64) {
      const rec = Buffer.alloc(56 + 20);
      rec.writeUInt32LE(0x06064b50, 0);
      rec.writeBigUInt64LE(44n, 4);
      rec.writeUInt16LE(45, 12);
      rec.writeUInt16LE(45, 14);
      rec.writeBigUInt64LE(BigInt(n), 24);
      rec.writeBigUInt64LE(BigInt(n), 32);
      rec.writeBigUInt64LE(BigInt(cdSize), 40);
      rec.writeBigUInt64LE(BigInt(cdStart), 48);
      rec.writeUInt32LE(0x07064b50, 56);
      rec.writeBigUInt64LE(BigInt(cdStart + cdSize), 64);
      rec.writeUInt32LE(1, 72);
      await this.write(rec);
    }
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(Math.min(n, 0xffff), 8);
    eocd.writeUInt16LE(Math.min(n, 0xffff), 10);
    eocd.writeUInt32LE(Math.min(cdSize, 0xffffffff), 12);
    eocd.writeUInt32LE(Math.min(cdStart, 0xffffffff), 16);
    await this.write(eocd);
  }
}

// endregion

// region Reader

export interface ZipEntry {
  name: string;
  kind: EntryKind;
  crc: number;
  csize: number;
  usize: number;
  /** Offset of the local file header. */
  offset: number;
  flags: number;
}

async function readExact(fh: FileHandle, length: number, position: number): Promise<Buffer> {
  const buf = Buffer.alloc(length);
  let off = 0;
  while (off < length) {
    const { bytesRead } = await fh.read(buf, off, length - off, position + off);
    if (bytesRead === 0) throw invalid('unexpected end of file');
    off += bytesRead;
  }
  return buf;
}

/** Reads `length` bytes from `start` in 64 KiB pieces without ever closing the shared handle. */
function ranged(fh: FileHandle, start: number, length: number, counter?: { n: number }): Readable {
  async function* gen() {
    let pos = start;
    const end = start + length;
    while (pos < end) {
      const want = Math.min(CHUNK, end - pos);
      const buf = Buffer.allocUnsafe(want);
      const { bytesRead } = await fh.read(buf, 0, want, pos);
      if (bytesRead === 0) throw invalid('unexpected end of file');
      pos += bytesRead;
      if (counter) counter.n += bytesRead;
      yield buf.subarray(0, bytesRead);
    }
  }
  return Readable.from(gen(), { objectMode: false });
}

function capFor(kind: EntryKind): number {
  switch (kind) {
    case 'manifest':
      return MAX_MANIFEST_BYTES;
    case 'checksums':
      return MAX_CHECKSUMS_BYTES;
    case 'upload':
      return MAX_UPLOAD_ENTRY_BYTES;
    case 'thumb':
      return MAX_THUMB_ENTRY_BYTES;
    case 'db':
      return MAX_DB_ENTRY_BYTES;
  }
}

export interface ReadEntryOptions {
  maxBytes: number;
  ratio: number;
  /** Output size after which the ratio rule applies (default 1 MiB; the database uses 4 MiB). */
  ratioAfter?: number;
  /** Receives every decompressed chunk, in order; awaited before the next one is pulled. */
  sink?: (chunk: Buffer) => Promise<void> | void;
  /** Keep the output in memory and return it (only for the small JSON entries). */
  collect?: boolean;
  /** Called once the entry's local header has passed the checks, before the first byte is inflated (the "gate"). */
  onGate?: (entry: ZipEntry) => void;
}

export class BackupZip {
  private constructor(
    private readonly fh: FileHandle,
    readonly entries: ZipEntry[],
    readonly size: number,
    private readonly cdOffset: number,
  ) {}

  /** Opens the archive and validates its whole structure from the central directory; nothing is inflated. */
  static async open(path: string): Promise<BackupZip> {
    let fh: FileHandle;
    try {
      fh = await open(path, fsc.O_RDONLY | fsc.O_NOFOLLOW);
    } catch {
      throw invalid('cannot open');
    }
    try {
      const st = await fh.stat();
      if (!st.isFile()) throw invalid('not a regular file');
      const zip = await BackupZip.parse(fh, st.size);
      return zip;
    } catch (e) {
      await fh.close().catch(() => undefined);
      throw e instanceof BackupZipError ? e : invalid('unreadable');
    }
  }

  private static async parse(fh: FileHandle, size: number): Promise<BackupZip> {
    if (size < 22 + 3 * 46) throw invalid('too small');
    // The end record must be the last 22 bytes: a comment (length 0 is required) or trailing bytes would move it
    const eocd = await readExact(fh, 22, size - 22);
    if (eocd.readUInt32LE(0) !== 0x06054b50 || eocd.readUInt16LE(20) !== 0) throw invalid('end of central directory (or trailing bytes/comment)');
    if (eocd.readUInt16LE(4) !== 0 || eocd.readUInt16LE(6) !== 0) throw invalid('multi-disk archive');
    let total = eocd.readUInt16LE(10);
    let cdSize = eocd.readUInt32LE(12);
    let cdOffset = eocd.readUInt32LE(16);
    let cdEnd = size - 22;
    if (total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
      if (size < 22 + 20 + 56) throw invalid('zip64 records missing');
      const loc = await readExact(fh, 20, size - 22 - 20);
      if (loc.readUInt32LE(0) !== 0x07064b50 || loc.readUInt32LE(4) !== 0 || loc.readUInt32LE(16) !== 1) throw invalid('zip64 locator');
      const z64Pos = Number(loc.readBigUInt64LE(8));
      if (z64Pos !== size - 22 - 20 - 56) throw invalid('zip64 record position');
      const rec = await readExact(fh, 56, z64Pos);
      if (rec.readUInt32LE(0) !== 0x06064b50 || rec.readBigUInt64LE(4) !== 44n || rec.readUInt32LE(16) !== 0 || rec.readUInt32LE(20) !== 0) throw invalid('zip64 record');
      const n = rec.readBigUInt64LE(24);
      if (n !== rec.readBigUInt64LE(32) || n > BigInt(MAX_ENTRIES)) throw invalid('zip64 entry count');
      total = Number(n);
      const cs = rec.readBigUInt64LE(40);
      const co = rec.readBigUInt64LE(48);
      if (cs > BigInt(size) || co > BigInt(size)) throw invalid('zip64 directory range');
      cdSize = Number(cs);
      cdOffset = Number(co);
      cdEnd = z64Pos;
    }
    if (eocd.readUInt16LE(8) !== Math.min(total, 0xffff)) throw invalid('entry counts differ');
    if (total < FIXED_ENTRIES || total > MAX_ENTRIES) throw invalid('entry count');
    // The directory ends exactly where the end records begin, and is bounded by the entry count
    if (cdOffset + cdSize !== cdEnd || cdSize > total * (46 + MAX_NAME_BYTES + MAX_EXTRA_BYTES)) throw invalid('directory range');
    const cd = await readExact(fh, cdSize, cdOffset);
    const entries: ZipEntry[] = [];
    const names = new Set<string>();
    let p = 0;
    for (let i = 0; i < total; i++) {
      if (p + 46 > cd.length || cd.readUInt32LE(p) !== 0x02014b50) throw invalid('directory entry');
      const flags = cd.readUInt16LE(p + 8);
      const method = cd.readUInt16LE(p + 10);
      const crc = cd.readUInt32LE(p + 16);
      const csize = cd.readUInt32LE(p + 20);
      const usize = cd.readUInt32LE(p + 24);
      const nl = cd.readUInt16LE(p + 28);
      const el = cd.readUInt16LE(p + 30);
      const cl = cd.readUInt16LE(p + 32);
      let offset = cd.readUInt32LE(p + 42);
      // The gate: deflate (8) only, before anything is read. Stored, LZMA, AES (99) and the rest are refused outright.
      if (method !== 8) throw invalid(`compression method ${method}`);
      if ((flags & ~0x080e) !== 0 || (flags & 8) === 0) throw invalid('general purpose flags');
      if (nl === 0 || nl > MAX_NAME_BYTES || el > MAX_EXTRA_BYTES || cl !== 0 || cd.readUInt16LE(p + 34) !== 0) throw invalid('directory entry fields');
      if (p + 46 + nl + el > cd.length) throw invalid('directory entry range');
      const name = cd.toString('utf8', p + 46, p + 46 + nl);
      const kind = entryKind(name);
      if (!kind) throw invalid(`entry name ${name}`);
      if (names.has(name)) throw invalid(`duplicate entry ${name}`);
      names.add(name);
      if (csize === 0xffffffff || usize === 0xffffffff) throw invalid('entry of 4 GiB or more');
      if (offset === 0xffffffff) {
        // zip64 extra field carrying the offset (only the offset is saturated)
        let q = p + 46 + nl;
        const end = q + el;
        let found = false;
        while (q + 4 <= end) {
          const id = cd.readUInt16LE(q);
          const len = cd.readUInt16LE(q + 2);
          if (q + 4 + len > end) break;
          if (id === 1 && len >= 8) {
            const big = cd.readBigUInt64LE(q + 4);
            if (big > BigInt(size)) throw invalid('entry offset');
            offset = Number(big);
            found = true;
            break;
          }
          q += 4 + len;
        }
        if (!found) throw invalid('zip64 offset');
      }
      if (usize > capFor(kind)) throw invalid(`entry ${name} is larger than allowed`);
      entries.push({ name, kind, crc, csize, usize, offset, flags });
      p += 46 + nl + el;
    }
    if (p !== cd.length) throw invalid('directory length');
    // The layout the writer produces: manifest first, database second, checksums last, nothing else of those kinds
    const kinds = entries.map((e) => e.kind);
    if (kinds[0] !== 'manifest' || kinds[1] !== 'db' || kinds[total - 1] !== 'checksums') throw invalid('entry order');
    for (let i = 2; i < total - 1; i++) if (kinds[i] !== 'upload' && kinds[i] !== 'thumb') throw invalid('entry order');
    // Contiguity: header + data + 16-byte descriptor, then the next entry, and the last one ends at the directory.
    // Nothing can hide between entries, and nothing follows checksums.json.
    let expect = 0;
    for (const e of entries) {
      if (e.offset !== expect) throw invalid('entry layout');
      expect = e.offset + 30 + Buffer.byteLength(e.name) + e.csize + 16;
    }
    if (expect !== cdOffset) throw invalid('data after the last entry');
    return new BackupZip(fh, entries, size, cdOffset);
  }

  async close(): Promise<void> {
    await this.fh.close().catch(() => undefined);
  }

  /** Sum of the sizes the directory declares (advisory: the real limits are enforced while inflating). */
  declaredBytes(): number {
    return this.entries.reduce((n, e) => n + e.usize, 0);
  }

  /**
   * Inflates one entry within `maxBytes` and the ratio limit, checks its crc and size against the directory, and checks
   * its local header and data descriptor against the directory first. Throws `BackupZipError` on any mismatch.
   */
  async readEntry(e: ZipEntry, o: ReadEntryOptions): Promise<{ size: number; sha256: string; data?: Buffer }> {
    const nameLen = Buffer.byteLength(e.name);
    const head = await readExact(this.fh, 30 + nameLen, e.offset);
    if (head.readUInt32LE(0) !== 0x04034b50) throw invalid(`local header of ${e.name}`);
    if (head.readUInt16LE(6) !== e.flags || head.readUInt16LE(8) !== 8) throw invalid(`local header of ${e.name}: flags or method`);
    if (head.readUInt16LE(26) !== nameLen || head.readUInt16LE(28) !== 0 || head.toString('utf8', 30) !== e.name) throw invalid(`local header of ${e.name}: name`);
    const lcrc = head.readUInt32LE(14);
    if ((lcrc !== 0 && lcrc !== e.crc) || (head.readUInt32LE(18) !== 0 && head.readUInt32LE(18) !== e.csize) || (head.readUInt32LE(22) !== 0 && head.readUInt32LE(22) !== e.usize)) throw invalid(`local header of ${e.name}: sizes`);
    const dataStart = e.offset + 30 + nameLen;
    const dd = await readExact(this.fh, 16, dataStart + e.csize);
    if (dd.readUInt32LE(0) !== 0x08074b50 || dd.readUInt32LE(4) !== e.crc || dd.readUInt32LE(8) !== e.csize || dd.readUInt32LE(12) !== e.usize) throw invalid(`data descriptor of ${e.name}`);
    o.onGate?.(e);

    const sha = createHash('sha256');
    let crc = 0;
    let out = 0;
    const parts: Buffer[] = [];
    const take = async (chunk: Buffer) => {
      out += chunk.length;
      sha.update(chunk);
      crc = crc32(chunk, crc);
      if (o.collect) parts.push(chunk);
      if (o.sink) await o.sink(chunk);
    };
    const tooBig = () => invalid(`entry ${e.name} exceeds its limit`);
    const after = o.ratioAfter ?? RATIO_AFTER;
    if (e.usize > o.maxBytes) throw tooBig();

    if (e.csize <= CHUNK) {
      // Small entry (most uploads' thumbnails, the JSON files): one read, one bounded synchronous inflate
      const input = await readExact(this.fh, e.csize, dataStart);
      let data: Buffer;
      try {
        const inflateInfo = inflateRawSync as unknown as (b: Buffer, opts: object) => { buffer: Buffer; engine: { bytesWritten: number } };
        const r = inflateInfo(input, { info: true, maxOutputLength: Math.max(1, Math.min(o.maxBytes, e.usize, Math.max(after, o.ratio * e.csize))) });
        data = r.buffer;
        // The deflate stream must end exactly where the directory says the entry ends: no junk inside the compressed span
        if (r.engine.bytesWritten !== e.csize) throw invalid(`entry ${e.name} has bytes after its deflate stream`);
      } catch (err) {
        if (err instanceof BackupZipError) throw err;
        throw (err as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE' ? tooBig() : invalid(`entry ${e.name} is not valid deflate data`);
      }
      if (data.length > after && data.length > o.ratio * Math.max(e.csize, 1)) throw tooBig();
      await take(data);
    } else {
      const inBytes = { n: 0 };
      const input = ranged(this.fh, dataStart, e.csize, inBytes);
      const inflate = createInflateRaw({ chunkSize: CHUNK });
      pipeline(input, inflate, () => undefined);
      const sinkError: { err?: unknown; failed: boolean } = { failed: false };
      try {
        for await (const chunk of inflate as AsyncIterable<Buffer>) {
          if (out + chunk.length > Math.min(o.maxBytes, e.usize)) throw tooBig();
          if (out + chunk.length > after && out + chunk.length > o.ratio * Math.max(inBytes.n, 1)) throw tooBig();
          try {
            await take(chunk);
          } catch (err) {
            sinkError.failed = true;
            sinkError.err = err; // a failing sink (ENOSPC, EIO) is not an invalid archive: it propagates as it is
            throw err;
          }
        }
        if (inflate.bytesWritten !== e.csize) throw invalid(`entry ${e.name} has bytes after its deflate stream`);
      } catch (err) {
        if (sinkError.failed) throw sinkError.err;
        throw err instanceof BackupZipError ? err : invalid(`entry ${e.name} is not valid deflate data`);
      } finally {
        input.destroy();
        inflate.destroy();
      }
    }
    if (out !== e.usize || (crc >>> 0) !== e.crc) throw invalid(`entry ${e.name} does not match its directory record`);
    return { size: out, sha256: sha.digest('hex'), data: o.collect ? Buffer.concat(parts) : undefined };
  }
}

// endregion

// region Verify and extract

export interface ReadBackupOptions {
  /** Extract into this existing, empty directory (`app.sqlite`, `uploads/`). Without it, the pass only verifies. */
  extractTo?: string;
  /** Cap on the total decompressed size (free space minus 64 MiB for a restore). */
  maxTotalBytes?: number;
  /** Test seam: called for every entry once it passed the local-header gate and before its first byte is inflated. */
  onGate?: (entry: ZipEntry) => void;
}

export interface ReadBackupResult {
  manifest: Manifest;
  entries: number;
  uploadFiles: number;
  /** Total decompressed bytes of all entries. */
  bytes: number;
  checksums: ChecksumEntry[];
}

/**
 * The single pass shared by "verify before publish" (writer side), `restore --check` and the restore extraction:
 * structure and gate (deflate only, allowlisted names, exact layout, no comment, nothing after the end), the limits of
 * 9.2 while inflating, every crc, and `checksums.json` against what was actually read. With `extractTo` the database
 * and uploads are written below it (files 0600, directories 0700, `wx`, fsynced); a failure removes what was written.
 */
export async function readBackup(path: string, opts: ReadBackupOptions = {}): Promise<ReadBackupResult> {
  const zip = await BackupZip.open(path);
  const written: string[] = [];
  let madeUploadsDir = false;
  const staging = opts.extractTo ? resolve(opts.extractTo) : null;
  try {
    const maxTotal = opts.maxTotalBytes ?? DEFAULT_TOTAL_BUDGET;
    if (zip.declaredBytes() > maxTotal) throw invalid('declared sizes exceed the space available');
    const entries = zip.entries;
    const mEntry = entries[0] as ZipEntry;
    const mRead = await zip.readEntry(mEntry, { maxBytes: MAX_MANIFEST_BYTES, ratio: RATIO_LIMIT, collect: true, onGate: opts.onGate });
    const manifest = parseManifest(mRead.data as Buffer);
    let total = mRead.size;
    const dbEntry = entries[1] as ZipEntry;
    // A lying manifest can only LOWER what is accepted for the database, never raise it
    if (dbEntry.usize > manifest.database.bytes) throw invalid('app.sqlite is larger than the manifest says');

    if (staging) {
      // The staging directory must exist and be empty: this function only ever removes what it wrote itself
      const st = await stat(staging).catch(() => null);
      if (!st?.isDirectory()) throw invalid('extraction target is not a directory');
      if ((await readdir(staging)).length) throw invalid('extraction target is not empty');
      await mkdir(join(staging, 'uploads'), { mode: 0o700 }); // not recursive: EEXIST throws before anything is marked as created
      madeUploadsDir = true;
    }
    const seen = new Map<string, { size: number; sha256: string }>();
    let uploadFiles = 0;
    for (let i = 1; i < entries.length - 1; i++) {
      const e = entries[i] as ZipEntry;
      const cap = Math.min(e.kind === 'db' ? Math.min(MAX_DB_ENTRY_BYTES, manifest.database.bytes) : capFor(e.kind), maxTotal - total);
      let sink: ((chunk: Buffer) => Promise<void>) | undefined;
      let fh: FileHandle | null = null;
      if (staging) {
        const target = resolve(staging, e.kind === 'db' ? 'app.sqlite' : e.name);
        if (!target.startsWith(staging + sep)) throw invalid('path escapes staging');
        fh = await open(target, 'wx', 0o600);
        written.push(target);
        const handle = fh;
        sink = async (chunk) => {
          let off = 0;
          while (off < chunk.length) off += (await handle.write(chunk, off, chunk.length - off)).bytesWritten;
        };
      }
      try {
        const r = await zip.readEntry(e, { maxBytes: cap, ratio: e.kind === 'db' ? DB_RATIO_LIMIT : RATIO_LIMIT, ratioAfter: e.kind === 'db' ? DB_RATIO_AFTER : undefined, sink, onGate: opts.onGate });
        if (fh) await fh.sync();
        seen.set(e.name, { size: r.size, sha256: r.sha256 });
        total += r.size;
        if (e.kind === 'upload' || e.kind === 'thumb') uploadFiles++;
      } finally {
        await fh?.close().catch(() => undefined);
      }
    }
    const cEntry = entries[entries.length - 1] as ZipEntry;
    const cRead = await zip.readEntry(cEntry, { maxBytes: Math.min(MAX_CHECKSUMS_BYTES, maxTotal - total), ratio: RATIO_LIMIT, collect: true, onGate: opts.onGate });
    total += cRead.size;
    let parsed;
    try {
      parsed = checksumsSchema.safeParse(JSON.parse((cRead.data as Buffer).toString('utf8')));
    } catch {
      throw invalid('checksums.json is not JSON');
    }
    if (!parsed.success) throw invalid('checksums.json schema');
    const listed = new Map<string, { size: number; sha256: string }>();
    for (const c of parsed.data.entries) {
      const kind = entryKind(c.path);
      if (!kind || kind === 'manifest' || kind === 'checksums') throw invalid(`checksums.json path ${c.path}`);
      if (listed.has(c.path)) throw invalid('checksums.json duplicate path');
      listed.set(c.path, { size: c.size, sha256: c.sha256 });
    }
    if (listed.size !== seen.size) throw invalid('checksums.json does not list exactly the archived files');
    for (const [name, s] of seen) {
      const l = listed.get(name);
      if (!l || l.size !== s.size || l.sha256 !== s.sha256) throw invalid(`checksum mismatch for ${name}`);
    }
    if (staging) {
      // Directories are made durable too (the caller records the staged state afterwards)
      for (const dir of [join(staging, 'uploads'), staging]) {
        const dh = await open(dir, fsc.O_RDONLY | fsc.O_DIRECTORY);
        await dh.sync().catch(() => undefined);
        await dh.close();
      }
    }
    return { manifest, entries: entries.length, uploadFiles, bytes: total, checksums: parsed.data.entries };
  } catch (e) {
    for (const f of written) await rm(f, { force: true }).catch(() => undefined);
    if (madeUploadsDir && staging) await rmdir(join(staging, 'uploads')).catch(() => undefined); // only the folder this call made, and only once empty
    throw e;
  } finally {
    await zip.close();
  }
}

// endregion

/**
 * Classification read (design 11): the manifest is the first entry. Reads only that entry (deflate only, at most
 * 1 MiB, no central directory, nothing else extracted) and returns its `trigger`, or null when the file is corrupt,
 * foreign, hand-copied or has no readable manifest (the caller treats null as `api`).
 */
export async function readTrigger(path: string, onRead?: () => void): Promise<Trigger | null> {
  return (await readManifestHead(path, onRead))?.trigger ?? null;
}

/** What the backup list shows about one file; every field comes from the (untrusted) manifest and is control-character safe. */
export interface ManifestSummary {
  trigger: Trigger;
  /** Null when the manifest parses leniently (trigger known) but fails the full schema. */
  detail: { appVersion: string; migrationLevel: string | null; counts: { users: number; campaigns: number; uploads: number }; missingUploads: number } | null;
}

/** Same bounded first-entry read as `readTrigger`, one read for the trigger and the list details. */
export async function readManifestHead(path: string, onRead?: () => void): Promise<ManifestSummary | null> {
  onRead?.();
  let fh: FileHandle | null = null;
  try {
    fh = await open(path, fsc.O_RDONLY | fsc.O_NOFOLLOW);
    const st = await fh.stat();
    if (!st.isFile() || st.size < 30 + 13) return null;
    const head = Buffer.alloc(30 + 13);
    if ((await fh.read(head, 0, head.length, 0)).bytesRead !== head.length) return null;
    const flags = head.readUInt16LE(6);
    if (head.readUInt32LE(0) !== 0x04034b50 || head.readUInt16LE(8) !== 8 || (flags & 1) !== 0 || head.readUInt16LE(26) !== 13 || head.toString('utf8', 30, 43) !== 'manifest.json') return null;
    const start = 30 + 13 + head.readUInt16LE(28);
    // Compressed bytes are bounded too: a legitimate manifest is a few hundred bytes
    const end = Math.min(st.size, start + MAX_MANIFEST_BYTES) - 1;
    if (end < start) return null;
    const input = ranged(fh, start, end - start + 1);
    const inflate = createInflateRaw({ chunkSize: CHUNK });
    pipeline(input, inflate, () => undefined);
    const parts: Buffer[] = [];
    let out = 0;
    try {
      for await (const chunk of inflate as AsyncIterable<Buffer>) {
        out += chunk.length;
        if (out > MAX_MANIFEST_BYTES) return null;
        parts.push(chunk);
      }
    } finally {
      input.destroy();
      inflate.destroy();
    }
    const json = JSON.parse(Buffer.concat(parts).toString('utf8')) as { kind?: unknown; trigger?: unknown };
    if (!(json && json.kind === MANIFEST_KIND && isTrigger(json.trigger))) return null;
    const full = manifestSchema.safeParse(json);
    if (!full.success) return { trigger: json.trigger, detail: null };
    const m = full.data;
    return {
      trigger: json.trigger,
      detail: {
        appVersion: safeText(m.app.version),
        migrationLevel: m.database.latestTag === null ? null : safeText(m.database.latestTag),
        counts: m.counts,
        missingUploads: m.uploads.missing,
      },
    };
  } catch {
    return null;
  } finally {
    await fh?.close().catch(() => undefined);
  }
}
