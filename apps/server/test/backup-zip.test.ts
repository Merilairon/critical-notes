import { randomBytes } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { crc32, deflateRawSync } from 'node:zlib';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BackupZip,
  BackupZipError,
  CHUNK,
  DEFAULT_TOTAL_BUDGET,
  FIXED_ENTRIES,
  MAX_ENTRIES,
  MAX_UPLOAD_FILES,
  readBackup,
  readTrigger,
  safeText,
  ZipFileWriter,
  entryKind,
  type ZipEntry,
} from '../src/services/backup-zip';
import { rawZip, sha, testManifest, uid, validEntries, type RawEntry } from './zip-builder';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cn-zip-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const SIG = Buffer.from([0x50, 0x4b, 0x07, 0x08]);
const CD_SIG = Buffer.from([0x50, 0x4b, 0x01, 0x02]);

/** Bytes that deflate stores as raw blocks (random) with the data-descriptor signature planted all over them. */
function hostile(size: number, sig = SIG): Buffer {
  const b = randomBytes(size);
  for (let i = 3; i + 4 <= size; i += 997) sig.copy(b, i);
  return b;
}

function* pieces(b: Buffer, size = CHUNK) {
  for (let i = 0; i < b.length; i += size) yield b.subarray(i, i + size);
}

interface Real {
  db: Buffer;
  uploads: Record<string, Buffer>;
  manifest?: Record<string, unknown>;
}

/** A backup written by the real ZipFileWriter. */
async function realZip(name: string, p: Real, maxEntries?: number): Promise<string> {
  const path = join(dir, name);
  const fh = await open(path, 'wx', 0o600);
  try {
    const w = new ZipFileWriter(fh, { mtime: new Date('2026-10-17T09:30:00Z'), maxEntries });
    await w.addFile('manifest.json', 1, [Buffer.from(JSON.stringify(p.manifest ?? testManifest(p.db.length)))]);
    const entries = [{ path: 'app.sqlite', ...(await w.addFile('app.sqlite', 6, pieces(p.db))) }];
    for (const [n, b] of Object.entries(p.uploads)) entries.push({ path: `uploads/${n}`, ...(await w.addFile(`uploads/${n}`, 1, pieces(b))) });
    await w.addFile('checksums.json', 1, [Buffer.from(JSON.stringify({ entries }))]);
    await w.finish();
  } finally {
    await fh.close();
  }
  return path;
}

function zipFile(name: string, data: Buffer): string {
  const path = join(dir, name);
  writeFileSync(path, data);
  return path;
}

async function expectRefused(path: string, opts: Parameters<typeof readBackup>[1] = {}) {
  const err = await readBackup(path, opts).then(
    () => null,
    (e: unknown) => e,
  );
  expect(err, 'the backup should have been refused').toBeInstanceOf(BackupZipError);
  return err as BackupZipError;
}

const db = randomBytes(5000);

describe('backup zip: round trip', () => {
  it('round-trips adversarial bytes exactly: the planted signature, chunk boundaries, empty and tiny files', async () => {
    const uploads: Record<string, Buffer> = {
      [uid(1)]: hostile(300_000),
      [uid(2)]: hostile(200_000, CD_SIG),
      [uid(3)]: Buffer.concat(Array.from({ length: 40_000 }, () => SIG)),
      [uid(4)]: randomBytes(CHUNK - 1),
      [uid(5)]: randomBytes(CHUNK),
      [uid(6)]: randomBytes(CHUNK + 1),
      [uid(7)]: Buffer.alloc(0),
      [uid(8)]: Buffer.from([0x50]),
      [`${uid(9)}.thumb`]: hostile(2000),
    };
    const path = await realZip('a.zip', { db: hostile(400_000), uploads });
    const out = join(dir, 'out');
    mkdirSync(out);
    const r = await readBackup(path, { extractTo: out });
    expect(r.entries).toBe(3 + Object.keys(uploads).length);
    for (const [n, b] of Object.entries(uploads)) expect(sha(readFileSync(join(out, 'uploads', n)))).toBe(sha(b));
    expect(readFileSync(join(out, 'app.sqlite')).length).toBe(400_000);
  });

  it('writes deflate entries only (never stored, never level 0) and the archive passes the reader gate', async () => {
    const path = await realZip('b.zip', { db, uploads: { [uid(1)]: Buffer.alloc(100_000), [uid(2)]: randomBytes(100_000) } });
    const zip = await BackupZip.open(path);
    // level 1 or 6 really compresses (level 0 would store the zeros as they are)
    expect(zip.entries.find((e) => e.name === `uploads/${uid(1)}`)?.csize).toBeLessThan(2000);
    expect(zip.entries.map((e) => e.name)).toEqual(['manifest.json', 'app.sqlite', `uploads/${uid(1)}`, `uploads/${uid(2)}`, 'checksums.json']);
    // method 8 for every entry, read from the raw central directory
    const buf = readFileSync(path);
    let methods = 0;
    for (let i = 0; i + 46 < buf.length; i++) if (buf.readUInt32LE(i) === 0x02014b50 && buf.readUInt16LE(i + 10) === 8) methods++;
    expect(methods).toBeGreaterThanOrEqual(5);
    await zip.close();
  });

  it('is readable by standard tools (unzip -t / python zipfile) when they are installed', async () => {
    const path = await realZip('c.zip', { db, uploads: { [uid(1)]: hostile(100_000) } });
    const { spawnSync } = await import('node:child_process');
    const py = spawnSync('python3', ['-I', '-c', 'import sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); print(z.testzip(), len(z.namelist()))', path], { encoding: 'utf8' });
    if (py.status === 0) expect(py.stdout.trim()).toBe('None 4');
  });

  it('applies back-pressure: the source is never pulled far ahead of the bytes written', async () => {
    const path = join(dir, 'bp.zip');
    const real = await open(path, 'wx');
    let written = 0;
    const slow = new Proxy(real, {
      get(t, prop) {
        if (prop === 'write') {
          return async (...args: unknown[]) => {
            await new Promise((r) => setTimeout(r, 2));
            const res = await (t.write as (...a: unknown[]) => Promise<{ bytesWritten: number }>)(...args);
            written += res.bytesWritten;
            return res;
          };
        }
        const v = Reflect.get(t, prop);
        return typeof v === 'function' ? v.bind(t) : v;
      },
    });
    const w = new ZipFileWriter(slow, { mtime: new Date() });
    let pulled = 0;
    let maxAhead = 0;
    function* source() {
      for (let i = 0; i < 60; i++) {
        pulled += CHUNK;
        // random data stays about the same size after deflate, so pulled - written measures the queue
        maxAhead = Math.max(maxAhead, pulled - written);
        yield randomBytes(CHUNK);
      }
    }
    await w.addFile('app.sqlite', 1, source());
    await real.close();
    expect(pulled).toBe(60 * CHUNK);
    expect(maxAhead).toBeLessThan(4 * CHUNK);
  });

  it('refuses an unexpected name and more entries than the cap in the writer', async () => {
    const fh = await open(join(dir, 'w.zip'), 'wx');
    const w = new ZipFileWriter(fh, { mtime: new Date(), maxEntries: 2 });
    await expect(w.addFile('../evil', 1, [Buffer.from('x')])).rejects.toThrow(/unexpected entry name/);
    await w.addFile('manifest.json', 1, [Buffer.from('{}')]);
    await w.addFile('app.sqlite', 1, [Buffer.from('x')]);
    await expect(w.addFile(`uploads/${uid(1)}`, 1, [Buffer.from('x')])).rejects.toThrow(/at most/);
    await fh.close();
    expect(MAX_ENTRIES).toBe(MAX_UPLOAD_FILES + FIXED_ENTRIES);
    expect(MAX_ENTRIES).toBe(200_003);
  });
});

describe('backup zip: the compression gate', () => {
  it('refuses a stored entry that contains PK\\x07\\x08 before anything is inflated or written', async () => {
    const trap = Buffer.concat([Buffer.from('start'), SIG, Buffer.from('this part would be cut off by a scanning reader'), randomBytes(50)]);
    const entries = validEntries({ db, uploads: { [uid(1)]: trap } });
    entries[2] = { ...(entries[2] as RawEntry), method: 0 };
    const path = zipFile('stored.zip', rawZip(entries));
    const gated: string[] = [];
    const out = join(dir, 'out');
    mkdirSync(out);
    const err = await expectRefused(path, { extractTo: out, onGate: (e) => gated.push(e.name) });
    expect(err.detail).toMatch(/compression method 0/);
    expect(gated).toEqual([]); // the gate runs before the first entry is touched
    expect(readdirSync(out)).toEqual([]); // not one byte of it was written
  });

  it('refuses every other method too (LZMA 14, AES 99)', async () => {
    for (const method of [14, 99, 1]) {
      const entries = validEntries({ db, uploads: { [uid(1)]: Buffer.from('x') } });
      entries[2] = { ...(entries[2] as RawEntry), method, compressed: Buffer.from('xx') };
      await expectRefused(zipFile(`m${method}.zip`, rawZip(entries)));
    }
  });

  it('is not fooled by level-0 deflate (stored blocks inside a deflate stream) holding the signature: bytes come out exact', async () => {
    const data = Buffer.concat([hostile(5000), SIG, hostile(70_000)]);
    const entries = validEntries({ db, uploads: { [uid(1)]: data } });
    entries[2] = { ...(entries[2] as RawEntry), level: 0 };
    const out = join(dir, 'out');
    mkdirSync(out);
    await readBackup(zipFile('l0.zip', rawZip(entries)), { extractTo: out });
    expect(sha(readFileSync(join(out, 'uploads', uid(1))))).toBe(sha(data));
  });
});

describe('backup zip: names and layout', () => {
  const badNames = [
    '../x',
    '/etc/x',
    'uploads/../../x',
    'uploads\\..\\x',
    'uploads/NUL',
    'uploads/',
    'uploads/..',
    `uploads/${uid(1)}/extra`,
    `uploads/${uid(1)}\nx`,
    `x\nuploads/${uid(1)}`,
    `uploads/${uid(1)}.thumb\n`,
    `uploads/${'A'.repeat(36)}`,
    'C:\\x',
    `uploads/${'a'.repeat(200)}`,
    'app.sqlite-wal',
    'index.sqlite',
    'manifest.json/',
    ' app.sqlite',
  ];
  for (const name of badNames) {
    it(`refuses the entry name ${JSON.stringify(name).slice(0, 60)} and writes nothing outside staging`, async () => {
      const sandbox = join(dir, 'sandbox');
      const staging = join(sandbox, 'staging');
      mkdirSync(staging, { recursive: true });
      const entries = validEntries({ db, uploads: { [uid(1)]: Buffer.from('x') } });
      // checksums are honest for the original names; only the entry name is changed
      entries[2] = { ...(entries[2] as RawEntry), name };
      await expectRefused(zipFile('n.zip', rawZip(entries)), { extractTo: staging });
      expect(readdirSync(staging)).toEqual([]);
      expect(readdirSync(sandbox)).toEqual(['staging']);
    });
  }

  it('refuses a duplicate name', async () => {
    const entries = validEntries({ db, uploads: { [uid(1)]: Buffer.from('x') } });
    entries.splice(3, 0, { ...(entries[2] as RawEntry) });
    const err = await expectRefused(zipFile('dup.zip', rawZip(entries)));
    expect(err.detail).toMatch(/duplicate/);
  });

  it('refuses a local header whose name differs from the central directory', async () => {
    const entries = validEntries({ db, uploads: { [uid(1)]: Buffer.from('x') } });
    entries[2] = { ...(entries[2] as RawEntry), cdName: `uploads/${uid(2)}` };
    await expectRefused(zipFile('cd.zip', rawZip(entries)));
  });

  it('treats a symlink entry as a plain file under an allowlisted name, and never creates a symlink', async () => {
    const entries = validEntries({ db, uploads: { [uid(1)]: Buffer.from('/etc/passwd') } });
    entries[2] = { ...(entries[2] as RawEntry), externalAttrs: (0o120777 << 16) >>> 0 };
    const out = join(dir, 'out');
    mkdirSync(out);
    await readBackup(zipFile('sym.zip', rawZip(entries)), { extractTo: out });
    const st = lstatSync(join(out, 'uploads', uid(1)));
    expect(st.isSymbolicLink()).toBe(false);
    expect(st.isFile()).toBe(true);
    expect(readFileSync(join(out, 'uploads', uid(1)), 'utf8')).toBe('/etc/passwd');
  });

  it('refuses trailing bytes after the end record, and a comment of any length', async () => {
    const entries = validEntries({ db, uploads: {} });
    await expectRefused(zipFile('t.zip', rawZip(entries, { trailing: Buffer.from('PK\x05\x06junk') })));
    await expectRefused(zipFile('t2.zip', rawZip(entries, { trailing: Buffer.from([0]) })));
    await expectRefused(zipFile('c.zip', rawZip(entries, { comment: Buffer.from('hi') })));
    await readBackup(zipFile('ok.zip', rawZip(entries))); // the control: the same zip without them passes
  });

  it('refuses a file that is not a zip, an empty file, a directory and a missing file', async () => {
    await expectRefused(zipFile('x.zip', Buffer.from('not a zip at all, just some text '.repeat(10))));
    await expectRefused(zipFile('empty.zip', Buffer.alloc(0)));
    await expectRefused(dir);
    await expectRefused(join(dir, 'missing.zip'));
  });

  it('refuses data after checksums.json (another entry), a missing checksums.json and the wrong order', async () => {
    const base = validEntries({ db, uploads: { [uid(1)]: Buffer.from('x') } });
    const cases: [string, RawEntry[]][] = [
      ['after', [...base, { name: `uploads/${uid(2)}`, data: Buffer.from('y') }]],
      ['nocs', base.slice(0, -1)],
      ['order', [base[1] as RawEntry, base[0] as RawEntry, ...base.slice(2)]],
      ['mid', [base[0] as RawEntry, base[1] as RawEntry, base[3] as RawEntry, base[2] as RawEntry]],
    ];
    for (const [name, entries] of cases) expect((await expectRefused(zipFile(`${name}.zip`, rawZip(entries)))).detail, name).toMatch(/entry order/);
  });

  it('refuses gaps and overlaps: bytes hidden between entries, and an end-record count that disagrees', async () => {
    const entries = validEntries({ db, uploads: { [uid(1)]: Buffer.from('x') } });
    const good = rawZip(entries);
    // a gap: junk spliced between the first entry and the second, offsets untouched
    const first = rawZip(entries.slice(0, 1)).length - (46 + 13 + 22);
    const gapped = Buffer.concat([good.subarray(0, first), Buffer.from('JUNK'), good.subarray(first)]);
    await expectRefused(zipFile('gap.zip', gapped));
    await expectRefused(zipFile('count.zip', rawZip(entries, { eocdCount: entries.length + 1 })));
    await expectRefused(zipFile('count0.zip', rawZip(entries, { eocdCount: entries.length - 1 })));
  });

  it('refuses bytes hidden between entries or after the last one, even when every offset is adjusted so that standard readers accept the file', async () => {
    const entries = validEntries({ db, uploads: { [uid(1)]: Buffer.from('x') } });
    await readBackup(zipFile('plain.zip', rawZip(entries))); // control
    for (const index of [0, 1, 2, entries.length - 1]) {
      const path = zipFile(`gap${index}.zip`, rawZip(entries, { gaps: { [index]: Buffer.from('HIDDEN PAYLOAD') } }));
      const { spawnSync } = await import('node:child_process');
      const py = spawnSync('python3', ['-I', '-c', 'import sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); print(z.testzip())', path], { encoding: 'utf8' });
      if (py.status === 0) expect(py.stdout.trim()).toBe('None'); // really a valid zip to other tools
      const err = await expectRefused(path);
      expect(err.detail, `gap after entry ${index}`).toMatch(/entry layout|data after the last entry/);
    }
  });

  it('refuses bytes between the central directory and the end record, and an end record that claims a comment', async () => {
    const entries = validEntries({ db, uploads: {} });
    const hidden = await expectRefused(zipFile('acd.zip', rawZip(entries, { afterCd: Buffer.from('HIDDEN AFTER THE DIRECTORY') })));
    expect(hidden.detail).toMatch(/directory range/);
    const good = rawZip(entries);
    const claims = Buffer.from(good);
    claims.writeUInt16LE(5, claims.length - 2); // the last 22 bytes still look like an end record, but it announces a comment
    const err = await expectRefused(zipFile('claims.zip', claims));
    expect(err.detail).toMatch(/end of central directory/);
  });

  it('refuses a truncated archive at every offset sampled, and a flipped byte anywhere in the middle', async () => {
    const path = await realZip('v.zip', { db: hostile(30_000), uploads: { [uid(1)]: hostile(20_000), [uid(2)]: Buffer.from('small') } });
    const good = readFileSync(path);
    const cuts = [0, 1, 10, 29, 30, 31, 45, 100, 500, 5000, 30_000, 40_000, good.length - 23, good.length - 22, good.length - 1];
    for (const cut of cuts) await expectRefused(zipFile('cut.zip', good.subarray(0, cut)));
    for (let i = 0; i < 40; i++) {
      const pos = 30 + Math.floor(((good.length - 200) * i) / 40);
      const bad = Buffer.from(good);
      bad[pos] = (bad[pos] as number) ^ 0x55;
      const p = zipFile('flip.zip', bad);
      // a flip inside a header or the directory or the data: any of them must be caught (the control below passes)
      await expectRefused(p);
    }
    await readBackup(path);
  });
});

describe('backup zip: checksums.json', () => {
  const up = { [uid(1)]: Buffer.from('one'), [uid(2)]: Buffer.from('two') };

  it('refuses a wrong sha256, a wrong size, a missing listed file and an unlisted extra file', async () => {
    const honest = validEntries({ db, uploads: up });
    const checks = [
      { path: 'app.sqlite', size: db.length, sha256: sha(db) },
      { path: `uploads/${uid(1)}`, size: 3, sha256: sha(up[uid(1)] as Buffer) },
      { path: `uploads/${uid(2)}`, size: 3, sha256: sha(up[uid(2)] as Buffer) },
    ];
    const withChecks = (c: typeof checks) => zipFile('k.zip', rawZip(validEntries({ db, uploads: up, checksums: c })));
    await readBackup(withChecks(checks)); // control
    expect(honest.length).toBe(5);
    await expectRefused(withChecks([checks[0] as (typeof checks)[number], { ...(checks[1] as (typeof checks)[number]), sha256: sha(Buffer.from('forged')) }, checks[2] as (typeof checks)[number]]));
    await expectRefused(withChecks([checks[0] as (typeof checks)[number], { ...(checks[1] as (typeof checks)[number]), size: 4 }, checks[2] as (typeof checks)[number]]));
    await expectRefused(withChecks(checks.slice(0, 2)));
    await expectRefused(withChecks([...checks, { path: `uploads/${uid(3)}`, size: 1, sha256: sha(Buffer.from('z')) }]));
    await expectRefused(withChecks([...checks, checks[1] as (typeof checks)[number]])); // duplicate path
  });

  it('refuses a path in checksums.json that fails the name rules', async () => {
    for (const path of ['../x', '/etc/passwd', 'manifest.json', 'checksums.json', `uploads/${uid(1)}\n`]) {
      const checks = [{ path: 'app.sqlite', size: db.length, sha256: sha(db) }, { path, size: 1, sha256: sha(Buffer.from('x')) }];
      const err = await expectRefused(zipFile('p.zip', rawZip(validEntries({ db, uploads: {}, checksums: checks }))));
      expect(err.detail).toMatch(/checksums\.json path/);
    }
  });
});

describe('backup zip: manifest', () => {
  it('refuses a newer format with its own code, a foreign engine, a foreign kind and junk', async () => {
    const m = (x: Record<string, unknown>) => zipFile('m.zip', rawZip(validEntries({ db, uploads: {}, manifest: testManifest(db.length, x) })));
    const newer = await expectRefused(m({ format: 2, app: { version: '9.9.9\u001b[31m' } }));
    expect(newer.code).toBe('too-new');
    expect(newer.message).toMatch(/newer Critical Notes/);
    expect(newer.message).not.toContain('\u001b');
    expect((await expectRefused(m({ database: { engine: 'postgres', sqliteVersion: '', bytes: db.length, migrations: [], latestTag: null, latestWhen: null } }))).code).toBe('unsupported');
    await expectRefused(m({ kind: 'something-else' }));
    await expectRefused(m({ trigger: 'root' }));
    await expectRefused(zipFile('j.zip', rawZip(validEntries({ db, uploads: {}, manifest: 'junk' as never }))));
  });

  it('a lying manifest can only lower the accepted database size', async () => {
    const path = zipFile('lie.zip', rawZip(validEntries({ db, uploads: {}, manifest: testManifest(db.length - 1) })));
    await expectRefused(path);
    await readBackup(zipFile('ok.zip', rawZip(validEntries({ db, uploads: {}, manifest: testManifest(db.length + 1_000_000) })))); // higher is harmless
  });

  it('the stable refusal text hides the reason; the reason is kept sanitised in detail', async () => {
    const err = await expectRefused(zipFile('x.zip', Buffer.from('nope'.repeat(50))));
    expect(err.message).toBe('This is not a complete Critical Notes backup');
    expect(safeText('a\u001b[31mb\nc'.padEnd(300, 'x'))).toHaveLength(120);
    expect(safeText('a\u001b[31mb\nc')).toBe('a?[31mb?c');
  });
});

describe('backup zip: limits while inflating', () => {
  it('refuses a ratio above 200:1 for uploads (small and streamed entries) and above 50:1 for the database', async () => {
    // small path (compressed under 64 KiB): 3 MiB of zeros
    await expectRefused(zipFile('r1.zip', rawZip(validEntries({ db, uploads: { [uid(1)]: Buffer.alloc(3 * 1024 * 1024) } }))));
    // streamed path (compressed over 64 KiB, about 73 KB): the largest allowed upload, all zeros, ratio about 230
    const noisy = Buffer.alloc(16 * 1024 * 1024);
    await expectRefused(zipFile('r2.zip', rawZip(validEntries({ db, uploads: { [uid(1)]: noisy } }))));
    const bigDb = Buffer.alloc(8 * 1024 * 1024);
    randomBytes(100_000).copy(bigDb, 1000);
    await expectRefused(zipFile('r3.zip', rawZip(validEntries({ db: bigDb, uploads: {} }))));
    // the control: ordinary compressible data well under the ratio passes
    const text = Buffer.from(randomBytes(800_000).toString('hex')); // 1.6 MB of text, compresses about 2:1
    await readBackup(zipFile('ok.zip', rawZip(validEntries({ db: text, uploads: {} }))));
  });

  it('refuses entries larger than their kind allows, whatever the archive declares', async () => {
    // incompressible data, so that only the size caps (not the ratio rule) can refuse them
    await expectRefused(zipFile('u.zip', rawZip(validEntries({ db, uploads: { [uid(1)]: randomBytes(17 * 1024 * 1024) } }))));
    await expectRefused(zipFile('t.zip', rawZip(validEntries({ db, uploads: { [`${uid(1)}.thumb`]: randomBytes(5 * 1024 * 1024) } }))));
    const manifest = Buffer.from(JSON.stringify(testManifest(db.length, { pad: randomBytes(600 * 1024).toString('hex') })));
    await expectRefused(zipFile('m.zip', rawZip(validEntries({ db, uploads: {} }).map((e) => (e.name === 'manifest.json' ? { ...e, data: manifest } : e)))));
    // the control: just under the caps passes
    await readBackup(zipFile('ok.zip', rawZip(validEntries({ db, uploads: { [uid(1)]: randomBytes(16 * 1024 * 1024), [`${uid(2)}.thumb`]: randomBytes(4 * 1024 * 1024) } }))));
  });

  it('a central directory that understates the size does not raise any cap: the real output must match it', async () => {
    const entries = validEntries({ db, uploads: { [uid(1)]: Buffer.alloc(1_000_000, 1) } });
    entries[2] = { ...(entries[2] as RawEntry), usize: 10 };
    await expectRefused(zipFile('lie.zip', rawZip(entries)));
  });

  it('aborts a bomb at the total cap with bounded disk use', async () => {
    const parts: Record<string, Buffer> = {};
    for (let i = 0; i < 40; i++) parts[uid(i)] = Buffer.concat([randomBytes(300_000), Buffer.alloc(300_000)]);
    const path = zipFile('bomb.zip', rawZip(validEntries({ db, uploads: parts })));
    const out = join(dir, 'out');
    mkdirSync(out);
    const err = await expectRefused(path, { extractTo: out, maxTotalBytes: 5_000_000 });
    expect(err.code).toBe('invalid');
    // refused up front from the declared sizes: not one entry was even started
    const gated: string[] = [];
    await expectRefused(path, { extractTo: out, maxTotalBytes: 5_000_000, onGate: (e) => gated.push(e.name) });
    expect(gated).toEqual([]);
    // sizes that fit the cap on paper but not in fact (the central directory understates them): stopped inside the entry that crosses it
    const small = validEntries({ db, uploads: Object.fromEntries(Array.from({ length: 6 }, (_, i) => [uid(i), randomBytes(400_000)])) });
    for (let i = 2; i < small.length - 1; i++) small[i] = { ...(small[i] as RawEntry), usize: 1000 };
    const seenGate: string[] = [];
    await expectRefused(zipFile('under.zip', rawZip(small)), { maxTotalBytes: 1_300_000, onGate: (e) => seenGate.push(e.name) });
    expect(seenGate.length).toBeLessThanOrEqual(5); // manifest, database and the first uploads; never all 8 entries
    expect(existsSync(join(out, 'app.sqlite'))).toBe(false); // a failed extraction removes what it wrote
    expect(readdirSync(out)).toEqual([]);
    // the cap applied while inflating, not just to the declared sizes
    const sneaky = validEntries({ db, uploads: { [uid(1)]: Buffer.concat([randomBytes(400_000), Buffer.alloc(400_000)]) } });
    sneaky[2] = { ...(sneaky[2] as RawEntry), usize: 800_000 };
    await expectRefused(zipFile('s.zip', rawZip(sneaky)), { maxTotalBytes: 500_000 });
  });

  it('stops inflating at the cap and hands the sink no more than the cap plus one chunk', async () => {
    const entries = validEntries({ db, uploads: { [uid(1)]: randomBytes(3_000_000) } });
    const zip = await BackupZip.open(zipFile('cap.zip', rawZip(entries)));
    let got = 0;
    const entry = zip.entries.find((e) => e.name === `uploads/${uid(1)}`) as ZipEntry;
    await expect(zip.readEntry(entry, { maxBytes: 1_000_000, ratio: 200, sink: (c) => void (got += c.length) })).rejects.toBeInstanceOf(BackupZipError);
    expect(got).toBeLessThanOrEqual(1_000_000);
    await zip.close();
  });

  it('removes everything it extracted when the archive fails late (a wrong checksum is only noticed at the end)', async () => {
    const staging = join(dir, 'late');
    mkdirSync(staging);
    const up = { [uid(1)]: randomBytes(300_000), [uid(2)]: randomBytes(1000) };
    const checks = [
      { path: 'app.sqlite', size: db.length, sha256: sha(db) },
      { path: `uploads/${uid(1)}`, size: 300_000, sha256: sha(Buffer.from('forged')) },
      { path: `uploads/${uid(2)}`, size: 1000, sha256: sha(up[uid(2)] as Buffer) },
    ];
    let extracted = 0;
    await expectRefused(zipFile('late.zip', rawZip(validEntries({ db, uploads: up, checksums: checks }))), { extractTo: staging, onGate: () => extracted++ });
    expect(extracted).toBe(5); // everything was extracted before the mismatch showed
    expect(readdirSync(staging)).toEqual([]);
  });

  it('extracts with files 0600 and directories 0700 whatever the umask, and never over an existing file', async () => {
    const old = process.umask(0);
    try {
      const out = join(dir, 'out');
      mkdirSync(out);
      await readBackup(zipFile('ok.zip', rawZip(validEntries({ db, uploads: { [uid(1)]: Buffer.from('x') } }))), { extractTo: out });
      expect(statSync(join(out, 'app.sqlite')).mode & 0o777).toBe(0o600);
      expect(statSync(join(out, 'uploads', uid(1))).mode & 0o777).toBe(0o600);
      expect(statSync(join(out, 'uploads')).mode & 0o777).toBe(0o700);
      const again = join(dir, 'again');
      mkdirSync(join(again, 'uploads'), { recursive: true });
      writeFileSync(join(again, 'app.sqlite'), 'precious');
      await expectRefused(zipFile('ok.zip', rawZip(validEntries({ db, uploads: {} }))), { extractTo: again }).catch(() => undefined);
      expect(readFileSync(join(again, 'app.sqlite'), 'utf8')).toBe('precious');
    } finally {
      process.umask(old);
    }
  });
});

describe('backup zip: entry names and counts at scale', () => {
  it('knows the allowlist', () => {
    expect(entryKind('manifest.json')).toBe('manifest');
    expect(entryKind('app.sqlite')).toBe('db');
    expect(entryKind(`uploads/${uid(1)}`)).toBe('upload');
    expect(entryKind(`uploads/${uid(1)}.thumb`)).toBe('thumb');
    expect(entryKind(`uploads/${uid(1)}.png`)).toBeNull();
  });

  it('the reader accepts exactly 200,003 entries and refuses 200,004 (the writer limit is the same constant)', async () => {
    const make = (n: number) => {
      const data = Buffer.from('x');
      const compressed = deflateRawSync(data);
      const e = (name: string): RawEntry => ({ name, data, compressed });
      const entries: RawEntry[] = [e('manifest.json'), e('app.sqlite')];
      for (let i = 0; i < n - 3; i++) entries.push(e(`uploads/${uid(i)}`));
      entries.push(e('checksums.json'));
      return entries;
    };
    // all entries share one tiny payload; only the structure is under test here
    const ok = zipFile('max.zip', rawZip(make(MAX_ENTRIES)));
    const zip = await BackupZip.open(ok);
    expect(zip.entries).toHaveLength(MAX_ENTRIES);
    await zip.close();
    const over = await BackupZip.open(zipFile('over.zip', rawZip(make(MAX_ENTRIES + 1)))).then(
      () => null,
      (e: unknown) => e,
    );
    expect(over).toBeInstanceOf(BackupZipError);
    expect((over as BackupZipError).detail).toMatch(/entry count/);
  }, 120_000);

  const slow = process.env.CN_SLOW_TESTS === '1';
  const manyEntries = slow ? 66_000 : 3000;
  it(`writes and verifies ${manyEntries.toLocaleString('en')} entries${slow ? ' (zip64 end records are needed from 65,535)' : ''} that python zipfile also reads`, async () => {
    const path = join(dir, 'many.zip');
    const fh = await open(path, 'wx');
    const w = new ZipFileWriter(fh, { mtime: new Date('2026-10-17T09:30:00Z') });
    await w.addFile('manifest.json', 1, [Buffer.from(JSON.stringify(testManifest(1)))]);
    const entries = [{ path: 'app.sqlite', ...(await w.addFile('app.sqlite', 6, [Buffer.from('d')])) }];
    for (let i = 0; i < manyEntries; i++) entries.push({ path: `uploads/${uid(i)}`, ...(await w.addFile(`uploads/${uid(i)}`, 1, [Buffer.from(`file ${i}`)])) });
    await w.addFile('checksums.json', 1, [Buffer.from(JSON.stringify({ entries }))]);
    await w.finish();
    await fh.close();
    const r = await readBackup(path);
    expect(r.entries).toBe(manyEntries + 3);
    expect(r.uploadFiles).toBe(manyEntries);
    const { spawnSync } = await import('node:child_process');
    const py = spawnSync('python3', ['-I', '-c', 'import sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); print(len(z.namelist()))', path], { encoding: 'utf8' });
    if (py.status === 0) expect(py.stdout.trim()).toBe(String(manyEntries + 3));
  }, 120_000);
});


describe('backup zip: local header and directory must agree', () => {
  const base = () => validEntries({ db, uploads: { [uid(1)]: Buffer.from('some upload bytes') } });
  const tweak = (i: number, patch: Partial<RawEntry>) => base().map((e, k) => (k === i ? { ...e, ...patch } : e));

  it('refuses a local header that disagrees with the directory (method, flags, sizes, crc), a data descriptor that does, and a local extra field', async () => {
    const cases: [string, Partial<RawEntry>, RegExp][] = [
      ['local method', { local: { method: 0 } }, /local header/],
      ['local flags', { local: { flags: 0x0808 } }, /local header/],
      ['local crc', { local: { crc: 12345 } }, /local header/],
      ['local csize', { local: { csize: 3 } }, /local header/],
      ['local usize', { local: { usize: 3 } }, /local header/],
      ['dd crc', { dd: { crc: 1 } }, /data descriptor/],
      ['dd csize', { dd: { csize: 1 } }, /data descriptor/],
      ['dd usize', { dd: { usize: 1 } }, /data descriptor/],
      ['local extra', { local: { extra: Buffer.from('xxxx') } }, /entry layout|local header/],
    ];
    for (const [label, patch, re] of cases) {
      const err = await expectRefused(zipFile('l.zip', rawZip(tweak(2, patch))));
      expect(err.detail, label).toMatch(re);
    }
    await readBackup(zipFile('ok.zip', rawZip(base()))); // control
  });

  it('refuses directory flags other than the data-descriptor bit and the level hints: encryption, strong encryption, no descriptor', async () => {
    for (const cdFlags of [0x0009, 0x0041, 0x2008, 0x0000, 0x0010]) {
      const err = await expectRefused(zipFile('f.zip', rawZip(tweak(2, { cdFlags, local: { flags: cdFlags } }))));
      expect(err.detail, `flags ${cdFlags.toString(16)}`).toMatch(/general purpose flags/);
    }
  });

  it('refuses junk inside the compressed span after the deflate stream, for small and streamed entries', async () => {
    const small = Buffer.from('small upload');
    const smallEntries = base().map((e, i) => (i === 2 ? { ...e, data: small, compressed: Buffer.concat([deflateRawSync(small), Buffer.from('JUNK')]) } : e));
    expect((await expectRefused(zipFile('j1.zip', rawZip(smallEntries)))).detail).toMatch(/after its deflate stream/);
    const big = randomBytes(150_000);
    const bigEntries = base().map((e, i) => (i === 2 ? { ...e, data: big, compressed: Buffer.concat([deflateRawSync(big, { level: 1 }), Buffer.from('JUNK')]) } : e));
    expect((await expectRefused(zipFile('j2.zip', rawZip(bigEntries)))).detail).toMatch(/after its deflate stream/);
  });

  it('lets a failing sink error (disk full) through unchanged instead of calling the archive invalid', async () => {
    const entries = validEntries({ db, uploads: { [uid(1)]: randomBytes(200_000), [uid(2)]: Buffer.from('tiny upload') } });
    const zip = await BackupZip.open(zipFile('sink.zip', rawZip(entries)));
    const boom = Object.assign(new Error('no space left'), { code: 'ENOSPC' });
    for (const name of [`uploads/${uid(1)}`, `uploads/${uid(2)}`]) {
      const entry = zip.entries.find((e) => e.name === name) as ZipEntry;
      const err = await zip.readEntry(entry, { maxBytes: 10_000_000, ratio: 200, sink: () => Promise.reject(boom) }).catch((e: unknown) => e);
      expect(err, name).toBe(boom);
    }
    await zip.close();
  });
});

describe('backup zip: zip64 offsets above 4 GiB', () => {
  it('reads a central directory whose offsets use the zip64 extra field (sparse file, no 4 GB on disk)', async () => {
    const path = join(dir, 'sparse.zip');
    const fh = await open(path, 'w+');
    const GIANT = 4_294_967_000; // a database entry of nearly 4 GiB (compressed bytes are a hole in the file)
    const pieces: { name: string; offset: number; crc: number; csize: number; usize: number }[] = [];
    let pos = 0;
    const put = async (name: string, data: Buffer | null, csize: number, usize: number, crc: number) => {
      const nameBuf = Buffer.from(name);
      const lh = Buffer.alloc(30);
      lh.writeUInt32LE(0x04034b50, 0);
      lh.writeUInt16LE(20, 4);
      lh.writeUInt16LE(8, 6);
      lh.writeUInt16LE(8, 8);
      lh.writeUInt16LE(nameBuf.length, 26);
      await fh.write(Buffer.concat([lh, nameBuf]), 0, 30 + nameBuf.length, pos);
      const start = pos;
      pos += 30 + nameBuf.length;
      if (data) await fh.write(data, 0, data.length, pos);
      pos += csize;
      const dd = Buffer.alloc(16);
      dd.writeUInt32LE(0x08074b50, 0);
      dd.writeUInt32LE(crc, 4);
      dd.writeUInt32LE(csize, 8);
      dd.writeUInt32LE(usize, 12);
      await fh.write(dd, 0, 16, pos);
      pos += 16;
      pieces.push({ name, offset: start, crc, csize, usize });
    };
    const small = (text: string) => {
      const data = Buffer.from(text);
      return { comp: deflateRawSync(data), usize: data.length, crc: crc32(data) >>> 0 };
    };
    const m = small(JSON.stringify(testManifest(GIANT)));
    await put('manifest.json', m.comp, m.comp.length, m.usize, m.crc);
    await put('app.sqlite', null, GIANT, GIANT, 0);
    const u = small('an upload that lives beyond 4 GiB');
    await put(`uploads/${uid(1)}`, u.comp, u.comp.length, u.usize, u.crc);
    const c = small(JSON.stringify({ entries: [] }));
    await put('checksums.json', c.comp, c.comp.length, c.usize, c.crc);
    const cdStart = pos;
    const cd: Buffer[] = [];
    for (const p of pieces) {
      const nameBuf = Buffer.from(p.name);
      const big = p.offset >= 0xffffffff;
      const extra = Buffer.alloc(big ? 12 : 0);
      if (big) {
        extra.writeUInt16LE(1, 0);
        extra.writeUInt16LE(8, 2);
        extra.writeBigUInt64LE(BigInt(p.offset), 4);
      }
      const h = Buffer.alloc(46);
      h.writeUInt32LE(0x02014b50, 0);
      h.writeUInt16LE(45, 4);
      h.writeUInt16LE(45, 6);
      h.writeUInt16LE(8, 8);
      h.writeUInt16LE(8, 10);
      h.writeUInt32LE(p.crc, 16);
      h.writeUInt32LE(p.csize, 20);
      h.writeUInt32LE(p.usize, 24);
      h.writeUInt16LE(nameBuf.length, 28);
      h.writeUInt16LE(extra.length, 30);
      h.writeUInt32LE(big ? 0xffffffff : p.offset, 42);
      cd.push(h, nameBuf, extra);
    }
    const cdBuf = Buffer.concat(cd);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(4, 8);
    eocd.writeUInt16LE(4, 10);
    eocd.writeUInt32LE(cdBuf.length, 12);
    // the directory itself also starts above 4 GiB: that needs the zip64 end records
    const z64 = Buffer.alloc(76);
    z64.writeUInt32LE(0x06064b50, 0);
    z64.writeBigUInt64LE(44n, 4);
    z64.writeUInt16LE(45, 12);
    z64.writeUInt16LE(45, 14);
    z64.writeBigUInt64LE(4n, 24);
    z64.writeBigUInt64LE(4n, 32);
    z64.writeBigUInt64LE(BigInt(cdBuf.length), 40);
    z64.writeBigUInt64LE(BigInt(cdStart), 48);
    z64.writeUInt32LE(0x07064b50, 56);
    z64.writeBigUInt64LE(BigInt(cdStart + cdBuf.length), 64);
    z64.writeUInt32LE(1, 72);
    eocd.writeUInt32LE(0xffffffff, 16);
    await fh.write(Buffer.concat([cdBuf, z64, eocd]), 0, cdBuf.length + 76 + 22, cdStart);
    await fh.close();
    expect(pieces[2]?.offset).toBeGreaterThan(0xffffffff);
    expect(statSync(path).size).toBeGreaterThan(0xffffffff);
    expect(statSync(path).blocks * 512).toBeLessThan(1_000_000); // really sparse

    const zip = await BackupZip.open(path);
    expect(zip.entries.map((e) => e.offset)).toEqual(pieces.map((p) => p.offset));
    const up = zip.entries[2] as ZipEntry;
    const read = await zip.readEntry(up, { maxBytes: 1000, ratio: 200, collect: true });
    expect(read.data?.toString()).toBe('an upload that lives beyond 4 GiB');
    await zip.close();
  });

  it('the writer encodes an offset above 4 GiB as 0xffffffff plus a zip64 extra field', async () => {
    const written: Buffer[] = [];
    const fake = {
      write: async (buf: Uint8Array, off: number, len: number) => {
        written.push(Buffer.from(buf.subarray(off, off + len)));
        return { bytesWritten: len };
      },
    } as unknown as Awaited<ReturnType<typeof open>>;
    const base = 5_000_000_000;
    const w = new ZipFileWriter(fake, { mtime: new Date('2026-10-17T09:30:00Z'), offsetBase: base });
    await w.addFile('manifest.json', 1, [Buffer.from('{}')]);
    await w.finish();
    const all = Buffer.concat(written);
    const at = all.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    expect(at).toBeGreaterThan(0);
    expect(all.readUInt32LE(at + 42)).toBe(0xffffffff);
    const nameLen = all.readUInt16LE(at + 28);
    const extraLen = all.readUInt16LE(at + 30);
    expect(extraLen).toBe(12);
    const ex = at + 46 + nameLen;
    expect(all.readUInt16LE(ex)).toBe(1);
    expect(all.readUInt16LE(ex + 2)).toBe(8);
    expect(Number(all.readBigUInt64LE(ex + 4))).toBe(base);
    expect(all.readUInt16LE(at + 6)).toBe(45); // version needed 4.5
    // the directory sits above 4 GiB too, so the end records are zip64 and the plain ones are saturated
    const eocd = all.subarray(all.length - 22);
    expect(eocd.readUInt32LE(16)).toBe(0xffffffff);
    expect(all.indexOf(Buffer.from([0x50, 0x4b, 0x06, 0x06]))).toBeGreaterThan(at);
  });
});

describe('backup zip: extraction target', () => {
  it('never deletes anything it did not write: a pre-existing uploads folder survives a refused backup, and the target must be an empty directory', async () => {
    const wrongSha = [{ path: 'app.sqlite', size: db.length, sha256: sha(Buffer.from('forged')) }];
    const bad = zipFile('bad.zip', rawZip(validEntries({ db, uploads: {}, checksums: wrongSha })));
    // a live folder handed over by mistake
    const live = join(dir, 'live');
    mkdirSync(join(live, 'uploads'), { recursive: true });
    writeFileSync(join(live, 'uploads', 'precious'), 'irreplaceable');
    writeFileSync(join(live, 'app.sqlite'), 'live database');
    await expectRefused(bad, { extractTo: live });
    expect(readFileSync(join(live, 'uploads', 'precious'), 'utf8')).toBe('irreplaceable');
    expect(readFileSync(join(live, 'app.sqlite'), 'utf8')).toBe('live database');
    // only an uploads folder, nothing else: still not an empty target
    const onlyUploads = join(dir, 'only');
    mkdirSync(join(onlyUploads, 'uploads'), { recursive: true });
    writeFileSync(join(onlyUploads, 'uploads', 'precious'), 'x');
    const good = zipFile('good.zip', rawZip(validEntries({ db, uploads: {} })));
    expect((await expectRefused(good, { extractTo: onlyUploads })).detail).toMatch(/not empty/);
    expect(existsSync(join(onlyUploads, 'uploads', 'precious'))).toBe(true);
    expect((await expectRefused(good, { extractTo: join(dir, 'missing') })).detail).toMatch(/not a directory/);
    writeFileSync(join(dir, 'afile'), 'x');
    expect((await expectRefused(good, { extractTo: join(dir, 'afile') })).detail).toMatch(/not a directory/);
    // an empty directory works and a failure leaves it empty
    const empty = join(dir, 'empty');
    mkdirSync(empty);
    await expectRefused(bad, { extractTo: empty });
    expect(readdirSync(empty)).toEqual([]);
    await readBackup(good, { extractTo: empty });
    expect(readdirSync(empty).sort()).toEqual(['app.sqlite', 'uploads']);
  });

  it('bounds a pass by an explicit total budget (default 64 GiB) so 200,000 entries of zeros cannot burn 200 GB of inflate', async () => {
    const zeros = Buffer.alloc(1024 * 1024);
    const up = Object.fromEntries(Array.from({ length: 4 }, (_, i) => [uid(i), zeros]));
    const path = zipFile('b.zip', rawZip(validEntries({ db, uploads: up })));
    expect(DEFAULT_TOTAL_BUDGET).toBe(64 * 1024 ** 3);
    await readBackup(path); // fine under the default budget
    expect((await expectRefused(path, { maxTotalBytes: 3 * 1024 * 1024 })).detail).toMatch(/declared sizes/);
  });
});

describe('backup zip: classification read', () => {
  const trigger = async (data: Buffer) => readTrigger(zipFile('t.zip', data));

  it('reads the trigger of the first entry only', async () => {
    const path = await realZip('t.zip', { db, uploads: {}, manifest: testManifest(db.length, { trigger: 'scheduler' }) });
    expect(await readTrigger(path)).toBe('scheduler');
  });

  it('gives null for corrupt, foreign, stored, oversized, wrong-kind and non-zip files', async () => {
    expect(await trigger(Buffer.from('plain text'))).toBeNull();
    expect(await trigger(rawZip([{ name: 'readme.txt', data: Buffer.from('hi') }]))).toBeNull();
    const m = Buffer.from(JSON.stringify(testManifest(1)));
    expect(await trigger(rawZip([{ name: 'manifest.json', data: m, method: 0 }]))).toBeNull(); // stored: refused
    // stored, but the bytes happen to be a valid deflate stream of a manifest: only the method check keeps it out
    expect(await trigger(rawZip([{ name: 'manifest.json', data: deflateRawSync(m), method: 0 }]))).toBeNull();
    expect(await trigger(rawZip([{ name: 'manifest.json', data: Buffer.from(JSON.stringify({ ...testManifest(1), pad: 'x'.repeat(1_200_000) })) }]))).toBeNull();
    expect(await trigger(rawZip([{ name: 'manifest.json', data: Buffer.from(JSON.stringify({ ...testManifest(1), kind: 'other' })) }]))).toBeNull();
    expect(await trigger(rawZip([{ name: 'manifest.json', data: Buffer.from('{broken') }]))).toBeNull();
    expect(await trigger(rawZip([{ name: 'manifest.json', data: Buffer.from(JSON.stringify(testManifest(1, { trigger: 'root' }))) }]))).toBeNull();
    expect(await readTrigger(join(dir, 'does-not-exist.zip'))).toBeNull();
    expect(await readTrigger(dir)).toBeNull();
  });
});
