/**
 * Hand-assembles zip files for the adversarial backup tests. The layout is the one the real writer produces (local header
 * with a data descriptor, data, 16-byte descriptor, then the central directory), so each test breaks exactly one rule.
 */
import { createHash } from 'node:crypto';
import { crc32, deflateRawSync } from 'node:zlib';

export interface RawEntry {
  name: string;
  data: Buffer;
  /** 0 = stored, 8 = deflate (default). */
  method?: number;
  /** Deflate level for method 8 (default 1). */
  level?: number;
  /** Name written in the central directory when it should differ from the local header. */
  cdName?: string;
  /** General purpose flags override (default 8). */
  flags?: number;
  /** Compressed bytes to use instead of compressing `data`. */
  compressed?: Buffer;
  /** CD sizes override. */
  usize?: number;
  /** Values written ONLY in the local header (the central directory keeps the real ones). */
  local?: { method?: number; flags?: number; extra?: Buffer; crc?: number; csize?: number; usize?: number };
  /** Values written ONLY in the data descriptor. */
  dd?: { crc?: number; csize?: number; usize?: number };
  /** Flags written ONLY in the central directory. */
  cdFlags?: number;
  /** External attributes written in the central directory (e.g. a Unix symlink mode in the high 16 bits). */
  externalAttrs?: number;
}

export interface RawZipOptions {
  comment?: Buffer;
  trailing?: Buffer;
  /** Number written as the entry count in the end record (default: the real count). */
  eocdCount?: number;
  /** Bytes hidden after entry i (key) with every later offset, and the directory offset, adjusted: a gap that standard readers accept. */
  gaps?: Record<number, Buffer>;
  /** Bytes between the central directory and the end record (the directory size in the end record is unchanged). */
  afterCd?: Buffer;
}

export function rawZip(entries: RawEntry[], opts: RawZipOptions = {}): Buffer {
  const parts: Buffer[] = [];
  const cd: Buffer[] = [];
  let offset = 0;
  let index = -1;
  for (const e of entries) {
    index++;
    const method = e.method ?? 8;
    const comp = e.compressed ?? (method === 0 ? e.data : deflateRawSync(e.data, { level: e.level ?? 1 }));
    const crc = crc32(e.data) >>> 0;
    const name = Buffer.from(e.name, 'utf8');
    const flags = e.flags ?? 8;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(e.local?.flags ?? flags, 6);
    lh.writeUInt16LE(e.local?.method ?? method, 8);
    lh.writeUInt32LE(e.local?.crc ?? 0, 14);
    lh.writeUInt32LE(e.local?.csize ?? 0, 18);
    lh.writeUInt32LE(e.local?.usize ?? 0, 22);
    lh.writeUInt16LE(name.length, 26);
    const lextra = e.local?.extra ?? Buffer.alloc(0);
    lh.writeUInt16LE(lextra.length, 28);
    const dd = Buffer.alloc(16);
    dd.writeUInt32LE(0x08074b50, 0);
    dd.writeUInt32LE(e.dd?.crc ?? crc, 4);
    dd.writeUInt32LE(e.dd?.csize ?? comp.length, 8);
    dd.writeUInt32LE(e.dd?.usize ?? e.usize ?? e.data.length, 12);
    parts.push(lh, name, lextra, comp, dd);
    const cdName = Buffer.from(e.cdName ?? e.name, 'utf8');
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(0x0314, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(e.cdFlags ?? flags, 8);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(comp.length, 20);
    ch.writeUInt32LE(e.usize ?? e.data.length, 24);
    ch.writeUInt16LE(cdName.length, 28);
    ch.writeUInt32LE((e.externalAttrs ?? 0) >>> 0, 38);
    ch.writeUInt32LE(offset, 42);
    cd.push(ch, cdName);
    offset += 30 + name.length + lextra.length + comp.length + 16;
    const gap = opts.gaps?.[index];
    if (gap) {
      parts.push(gap);
      offset += gap.length;
    }
  }
  const cdBuf = Buffer.concat(cd);
  const comment = opts.comment ?? Buffer.alloc(0);
  const count = opts.eocdCount ?? entries.length;
  const z64 =
    count >= 0xffff
      ? (() => {
          const r = Buffer.alloc(76);
          r.writeUInt32LE(0x06064b50, 0);
          r.writeBigUInt64LE(44n, 4);
          r.writeUInt16LE(45, 12);
          r.writeUInt16LE(45, 14);
          r.writeBigUInt64LE(BigInt(count), 24);
          r.writeBigUInt64LE(BigInt(count), 32);
          r.writeBigUInt64LE(BigInt(cdBuf.length), 40);
          r.writeBigUInt64LE(BigInt(offset), 48);
          r.writeUInt32LE(0x07064b50, 56);
          r.writeBigUInt64LE(BigInt(offset + cdBuf.length), 64);
          r.writeUInt32LE(1, 72);
          return r;
        })()
      : Buffer.alloc(0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  const n = opts.eocdCount ?? entries.length;
  eocd.writeUInt16LE(Math.min(n, 0xffff), 8);
  eocd.writeUInt16LE(Math.min(n, 0xffff), 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(comment.length, 20);
  return Buffer.concat([...parts, cdBuf, opts.afterCd ?? Buffer.alloc(0), z64, eocd, comment, opts.trailing ?? Buffer.alloc(0)]);
}

export const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

export function testManifest(dbBytes: number, extra: Record<string, unknown> = {}) {
  return {
    kind: 'critical-notes-backup',
    format: 1,
    createdAt: '2026-10-17T09:30:00.000Z',
    trigger: 'cli',
    app: { version: '1.0.0' },
    database: { engine: 'sqlite', sqliteVersion: '3.50.1', bytes: dbBytes, migrations: [], latestTag: null, latestWhen: null },
    counts: { users: 0, campaigns: 0, uploads: 0 },
    uploads: { files: 0, bytes: 0, missing: 0 },
    ...extra,
  };
}

export const uid = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;

export interface ValidParts {
  db: Buffer;
  /** name (below `uploads/`) to bytes */
  uploads: Record<string, Buffer>;
  manifest?: Record<string, unknown>;
  /** Replace the entries listed in checksums.json (default: honest). */
  checksums?: { path: string; size: number; sha256: string }[];
}

/** Entries of a valid backup (manifest, database, uploads, checksums), for a test to tweak before assembling. */
export function validEntries(p: ValidParts): RawEntry[] {
  const files: [string, Buffer][] = [['app.sqlite', p.db], ...Object.entries(p.uploads).map(([n, b]) => [`uploads/${n}`, b] as [string, Buffer])];
  const checks = p.checksums ?? files.map(([path, b]) => ({ path, size: b.length, sha256: sha(b) }));
  return [
    { name: 'manifest.json', data: Buffer.from(JSON.stringify(p.manifest ?? testManifest(p.db.length))) },
    { name: 'app.sqlite', data: p.db, level: 6 },
    ...files.slice(1).map(([name, data]) => ({ name, data })),
    { name: 'checksums.json', data: Buffer.from(JSON.stringify({ entries: checks })) },
  ];
}
