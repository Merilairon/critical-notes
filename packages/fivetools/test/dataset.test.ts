import { describe, expect, it } from 'vitest';
import { buildDataset } from '../src/dataset/build';
import { tokenPath, firstImagePath, isSafeImagePath } from '../src/dataset/images';
import { entityText } from '../src/dataset/text';
import { buildSummary } from '../src/dataset/summary';
import { isEditionMatch } from '../src/expand/items';
import type { JsonObject } from '../src/util/object';
import { miniFiles } from './fixtures/mini';

const result = buildDataset(miniFiles);
const byUid = new Map(result.entities.map((e) => [e.uid, e]));
const get = (uid: string) => {
  const e = byUid.get(uid);
  if (!e) throw new Error(`missing ${uid}; have ${[...byUid.keys()].join(', ')}`);
  return e;
};

describe('buildDataset', () => {
  it('ignores foundry/VTT files and collects stats', () => {
    expect(byUid.has('item:should be ignored|tst')).toBe(false);
    expect(result.stats.byKind.monster).toBeGreaterThan(0);
  });

  it('resolves _copy with "*" text mods and variables', () => {
    const chief = get('monster:gloomling chief|tst');
    expect(chief.raw?._copy).toBeDefined();
    expect(chief.data._copy).toBeUndefined();
    expect(chief.data.cr).toBe('1');
    // replaceTxt keeps the replacement's case, as in 5etools
    expect((chief.data.trait as JsonObject[])[0]!.entries).toEqual(['the chief can hide as a bonus action.']);
    // Plain-prop mods run before "*" mods (5etools order), so the appended text is also rewritten
    expect((chief.data.action as JsonObject[]).at(-1)!.entries).toEqual(['The chief commands the chief chief allies.']);
    expect(chief.data.reprintedAs).toBeUndefined(); // preserve-only prop
  });

  it('reports cycles and missing parents as warnings without dropping entities', () => {
    expect(get('monster:loop a|tst').data._copyUnresolved).toBeDefined();
    expect(get('monster:orphan|tst').data._copyUnresolved).toBe('missing');
    expect(result.warnings.some((w) => /cycle/.test(w))).toBe(true);
    expect(result.warnings.some((w) => /not found/.test(w))).toBe(true);
  });

  it('versions inherit reprintedAs but do not create reprint edges', async () => {
    const { reprintEdges } = await import('../src/edition/reprints');
    const shifter = { ...get('monster:shapeshifter|tst'), data: { ...get('monster:shapeshifter|tst').data, reprintedAs: ['Shapeshifter|XTST'] } };
    const wolf = { ...get('monster:shapeshifter (wolf form)|tst') };
    wolf.data = { ...wolf.data, reprintedAs: ['Shapeshifter|XTST'] };
    expect(reprintEdges([shifter, wolf]).map((e) => e.from)).toEqual(['monster:shapeshifter|tst']);
  });

  it('expands _versions including abstract implementations', () => {
    const wolf = get('monster:shapeshifter (wolf form)|tst');
    expect(wolf.generatedFrom).toBe('monster:shapeshifter|tst');
    expect((wolf.data.trait as JsonObject[]).map((t) => t.name)).toEqual(['Keen Nose']);
    const bear = get('monster:shapeshifter (bear)|tst');
    expect((bear.data.trait as JsonObject[])[0]!.entries).toEqual(['It is a Bear.']);
    expect(byUid.has('monster:shapeshifter (owl)|tst')).toBe(true);
    expect(bear.data._versionBase_isVersion).toBe(true);
  });

  it('merges subraces and keeps base races', () => {
    const base = get('race:sylph|tst');
    expect(base.data._isBaseRace).toBe(true);
    expect(base.data._subraces).toEqual([{ name: 'Sylph (Storm)', source: 'TST' }]);
    const storm = get('race:sylph (storm)|tst');
    expect(storm.generatedFrom).toBe('race:sylph|tst');
    expect(storm.data.ability).toEqual([{ dex: 1 }]);
    expect((storm.data.entries as JsonObject[]).map((e) => e.name)).toEqual(['Breeze', 'Static']);
    expect(get('race:sylph|xtst').data._isBaseRace).toBeUndefined();
  });

  it('generates specific magic variants with edition matching and derived reprints', () => {
    const classic = get('item:+1 shortblade|tst');
    const modern = get('item:+1 shortblade|xtst');
    expect(byUid.size).toBeGreaterThan(0);
    // Non-core base items get a "base item can be found in" note first, like 5etools
    expect(classic.data.entries).toEqual(['{@note The {@item Shortblade|TST|base item} can be found in TST.}', 'You have a +1 bonus with this shortblade.']);
    expect(classic.data.rarity).toBe('uncommon');
    expect(classic.data.value).toBeUndefined();
    expect(classic.data.reprintedAs).toEqual(['+1 Shortblade|XTST']);
    expect((modern.data.entries as string[]).at(-1)).toBe('Bonus +1.');
    expect(get('item:+1 blade|tst').data._category).toBe('Generic Variant');
    expect(get('item:shortblade|tst').data._category).toBe('Basic');
    expect(get('item:glow stone|tst').prop).toBe('item');
  });

  it('keeps abbreviation-only entities (item properties) with a display name', () => {
    expect(get('itemProperty:f|tst').name).toBe('Finesse');
  });

  it('attaches fluff, spell class lists and tokens', () => {
    const g = get('monster:gloomling|tst');
    expect(firstImagePath(g.fluff)).toBe('bestiary/TST/Gloomling.webp');
    expect(tokenPath('monster', g.data)).toBe('bestiary/tokens/TST/Gloomling.webp');
    expect(tokenPath('monster', get('monster:gloomling scout|xtst').data)).toBe('bestiary/tokens/TST/Gloomling.webp');
    expect(get('spell:spark burst|tst').data._classes).toEqual([{ name: 'Wizard', source: 'TST' }]);
  });
});

describe('item edition matching (5etools table)', () => {
  it.each([
    [null, null, true],
    ['classic', null, false],
    ['one', null, true],
    [null, 'classic', true],
    ['classic', 'classic', true],
    ['one', 'classic', false],
    [null, 'one', true],
    ['classic', 'one', false],
    ['one', 'one', true],
  ])('base %s × variant %s → %s', (base, variant, expected) => {
    expect(isEditionMatch(base, variant)).toBe(expected);
  });
});

describe('summaries, text and image path safety', () => {
  it('summarizes monsters and spells', () => {
    expect(buildSummary('monster', get('monster:gloomling|tst').data)).toMatchObject({ cr: '1/4', crNumber: 0.25, type: 'fey', size: ['Small'] });
    expect(buildSummary('spell', get('spell:spark burst|tst').data)).toMatchObject({ level: 3, school: 'Evocation', classes: ['Wizard'] });
  });

  it('extracts searchable text without markup', () => {
    const text = entityText(get('monster:gloomling|tst').data);
    expect(text).toContain('Needle');
    expect(text).toContain('+4 to hit');
    expect(text).not.toContain('{@');
  });

  it('rejects unsafe image paths', () => {
    expect(isSafeImagePath('bestiary/MM/Goblin.webp')).toBe(true);
    for (const bad of ['../etc/passwd.png', '/abs.webp', 'a/../../b.webp', 'x\\y.webp', 'file.svg', 'a/./b.webp', 'noext']) {
      expect(isSafeImagePath(bad)).toBe(false);
    }
  });
});
