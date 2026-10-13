/**
 * Optional smoke test against a real 5etools-src clone. Runs when FIVETOOLS_SRC_PATH (or the default
 * ./5etools-data/5etools-src) exists; skipped otherwise. Asserts robustness, not exact content.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildDataset, buildReprintGroups, buildSourceRegistry, entityText, mergeSourceMeta, reprintEdges } from '../src/index';
import { extractParserSourceMeta, listDataFiles, loadEditionListsFromPackage, readDataFiles, readParserJs, sourceMetaFromIndexes } from '../src/node/index';

const src = resolve(__dirname, '../../..', process.env.FIVETOOLS_SRC_PATH ?? '5etools-data/5etools-src');
const hasData = existsSync(resolve(src, 'data', 'books.json'));

describe.skipIf(!hasData)('real 5etools data', () => {
  it('builds every entity without throwing', { timeout: 60_000 }, async () => {
    const { files, errors } = await readDataFiles(await listDataFiles(src));
    expect(errors).toEqual([]);
    const result = buildDataset(files);
    expect(result.stats.entities).toBeGreaterThan(10_000);
    expect(result.warnings.length).toBeLessThan(50);
    for (const kind of ['monster', 'spell', 'item', 'race', 'background', 'feat', 'class', 'condition']) {
      expect(result.stats.byKind[kind], kind).toBeGreaterThan(0);
    }
    // every entity's text can be extracted (proxy for "renders without crashing" until the renderer exists)
    for (const e of result.entities) entityText(e.data);

    const books = files.find((f) => f.path === 'books.json')?.json;
    const adventures = files.find((f) => f.path === 'adventures.json')?.json;
    const parser = await readParserJs(src);
    const meta = mergeSourceMeta(sourceMetaFromIndexes(books, adventures), parser ? extractParserSourceMeta(parser) : new Map());
    const { sources, warnings } = buildSourceRegistry({ usedSources: new Set(result.entities.map((e) => e.source)), meta, lists: loadEditionListsFromPackage() });
    expect(warnings).toEqual([]);
    const ed = (id: string) => sources.find((s) => s.id === id)?.edition;
    expect([ed('PHB'), ed('MM'), ed('DMG'), ed('XGE')]).toEqual(['classic', 'classic', 'classic', 'classic']);
    expect([ed('XPHB'), ed('XMM'), ed('XDMG')]).toEqual(['one', 'one', 'one']);

    const uids = new Set(result.entities.map((e) => e.uid));
    const edges = reprintEdges(result.entities);
    const resolved = edges.filter((e) => uids.has(e.to)).length;
    expect(resolved / edges.length).toBeGreaterThan(0.97);
    const info = buildReprintGroups(edges, uids);
    expect(info.groupOf.get('spell:fireball|phb')).toBe(info.groupOf.get('spell:fireball|xphb'));
    expect(info.groupOf.get('item:+1 longsword|dmg')).toBe(info.groupOf.get('item:+1 longsword|xdmg'));
    expect(info.groupOf.get('item:+1 longsword|dmg')).not.toBe(info.groupOf.get('item:+1 dagger|dmg'));
    // a _versions variant must not join its parent's reprint group (it would compete with the parent in lists)
    expect(info.groupOf.get('monster:mage (familiar)|mm')).toBeUndefined();
    expect(info.groupOf.get('monster:mage|mm')).toBe(info.groupOf.get('monster:mage|xmm'));
  });
});
