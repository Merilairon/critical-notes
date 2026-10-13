/**
 * Filesystem access to a local 5etools-src clone. Read-only by design.
 */
import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, relative, sep } from 'node:path';
import type { RawDataFile } from '../dataset/build';
import { makeEditionLists, type EditionLists } from '../edition/sources';
import { isObject } from '../util/object';

export interface DataFileInfo {
  /** Path relative to `<src>/data`, with forward slashes. */
  rel: string;
  abs: string;
  size: number;
  mtimeMs: number;
}

const SKIP_DIRS = new Set(['adventure', 'book']);

/** Lists JSON files under `<srcPath>/data` (adventure/book content excluded; their metadata files are kept). */
export async function listDataFiles(srcPath: string): Promise<DataFileInfo[]> {
  const root = join(srcPath, 'data');
  const out: DataFileInfo[] = [];
  const walk = async (dir: string) => {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const abs = join(dir, e.name);
      if (e.isDirectory()) {
        if (dir === root && SKIP_DIRS.has(e.name)) continue;
        await walk(abs);
      } else if (e.isFile() && e.name.endsWith('.json')) {
        const s = await stat(abs);
        out.push({ rel: relative(root, abs).split(sep).join('/'), abs, size: s.size, mtimeMs: Math.floor(s.mtimeMs) });
      }
    }
  };
  await walk(root);
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

export async function sha1File(abs: string): Promise<string> {
  return createHash('sha1').update(await readFile(abs)).digest('hex');
}

/** Reads and parses data files. Files that fail to parse are reported and skipped. */
export async function readDataFiles(files: DataFileInfo[]): Promise<{ files: RawDataFile[]; errors: string[] }> {
  const errors: string[] = [];
  const out: RawDataFile[] = [];
  await Promise.all(
    files.map(async (f) => {
      try {
        out.push({ path: f.rel, json: JSON.parse(await readFile(f.abs, 'utf8')) });
      } catch (err) {
        errors.push(`${f.rel}: ${(err as Error).message}`);
      }
    }),
  );
  out.sort((a, b) => a.path.localeCompare(b.path));
  return { files: out, errors };
}

export interface SourceMeta {
  id: string;
  name: string | null;
  abbreviation: string | null;
  published: string | null;
  group: string | null;
  kind: 'book' | 'adventure' | 'other';
}

/** Book/adventure metadata from `books.json` / `adventures.json`. */
export function sourceMetaFromIndexes(books: unknown, adventures: unknown): Map<string, SourceMeta> {
  const out = new Map<string, SourceMeta>();
  const add = (list: unknown, kind: 'book' | 'adventure') => {
    if (!Array.isArray(list)) return;
    for (const b of list) {
      if (!isObject(b)) continue;
      const id = String(b.source ?? b.id ?? '');
      if (!id) continue;
      out.set(id.toLowerCase(), {
        id,
        name: typeof b.name === 'string' ? b.name : null,
        abbreviation: typeof b.id === 'string' ? b.id : id,
        published: typeof b.published === 'string' ? b.published : null,
        group: typeof b.group === 'string' ? b.group : null,
        kind,
      });
    }
  };
  add(isObject(books) ? books.book : null, 'book');
  add(isObject(adventures) ? adventures.adventure : null, 'adventure');
  return out;
}

/**
 * Extracts `SOURCE_JSON_TO_FULL/ABV/DATE` maps from 5etools' `js/parser.js`. These cover sources that have
 * no books.json/adventures.json entry. Best-effort: unparseable lines are ignored.
 */
export function extractParserSourceMeta(parserJs: string): Map<string, SourceMeta> {
  const consts = new Map<string, string>();
  for (const m of parserJs.matchAll(/^Parser\.(SRC_[A-Za-z0-9_]+)\s*=\s*"([^"]+)";/gm)) consts.set(m[1]!, m[2]!);
  const out = new Map<string, SourceMeta>();
  const get = (id: string) => {
    const key = id.toLowerCase();
    let meta = out.get(key);
    if (!meta) {
      meta = { id, name: null, abbreviation: null, published: null, group: null, kind: 'other' };
      out.set(key, meta);
    }
    return meta;
  };
  const re = /^Parser\.SOURCE_JSON_TO_(FULL|ABV|DATE)\[Parser\.(SRC_[A-Za-z0-9_]+)\]\s*=\s*"((?:[^"\\]|\\.)*)";/gm;
  for (const m of parserJs.matchAll(re)) {
    const id = consts.get(m[2]!);
    if (!id) continue;
    const value = m[3]!.replace(/\\(.)/g, '$1');
    const meta = get(id);
    if (m[1] === 'FULL') meta.name = value;
    else if (m[1] === 'ABV') meta.abbreviation = value;
    else meta.published = value;
  }
  return out;
}

const require = createRequire(import.meta.url);

/** Classic/modern/legacy source lists shipped in the `5etools-utils` package (MIT). */
export function loadEditionListsFromPackage(): EditionLists {
  try {
    const json = require('5etools-utils/schema/site/sources-5etools.json') as {
      $defs: { sourcesClassic: { enum: string[] }; sourcesModern: { enum: string[] }; sourcesLegacy: { enum: string[] } };
    };
    return makeEditionLists({
      classic: json.$defs.sourcesClassic.enum,
      modern: json.$defs.sourcesModern.enum,
      legacy: json.$defs.sourcesLegacy.enum,
    });
  } catch {
    return makeEditionLists({ classic: [], modern: [], legacy: [] });
  }
}

export async function readParserJs(srcPath: string): Promise<string | null> {
  try {
    return await readFile(join(srcPath, 'js', 'parser.js'), 'utf8');
  } catch {
    return null;
  }
}

export async function readGitHead(repoPath: string): Promise<string | null> {
  try {
    const head = (await readFile(join(repoPath, '.git', 'HEAD'), 'utf8')).trim();
    if (!head.startsWith('ref:')) return head;
    const ref = head.slice(5).trim();
    try {
      return (await readFile(join(repoPath, '.git', ref), 'utf8')).trim();
    } catch {
      const packed = await readFile(join(repoPath, '.git', 'packed-refs'), 'utf8');
      return packed.split('\n').find((l) => l.endsWith(` ${ref}`))?.split(' ')[0] ?? null;
    }
  } catch {
    return null;
  }
}

export async function readPackageVersion(srcPath: string): Promise<string | null> {
  try {
    const pkg = JSON.parse(await readFile(join(srcPath, 'package.json'), 'utf8')) as { version?: string };
    return pkg.version ?? null;
  } catch {
    return null;
  }
}
