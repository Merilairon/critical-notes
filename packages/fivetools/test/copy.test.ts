import { describe, expect, it } from 'vitest';
import { applyCopy } from '../src/copy/apply';
import { CopyResolver } from '../src/copy/resolver';
import { identityKey } from '../src/kinds';
import type { JsonObject } from '../src/util/object';

const parent: JsonObject = {
  name: 'Gloomling',
  source: 'TST',
  page: 10,
  srd: true,
  reprintedAs: ['Gloomling|XTST'],
  cr: '1/4',
  str: 8,
  dex: 14,
  con: 10,
  size: ['S', 'M'],
  senses: ['darkvision 60 ft.'],
  skill: { stealth: '+6' },
  trait: [
    { name: 'Shadow Step', entries: ['The gloomling hides. {@b the gloomling} stays tagged.'] },
    { name: 'Keen Ears', entries: ['It hears.'] },
  ],
  action: [{ name: 'Needle', entries: ['{@hit 4} to hit, {@dc 12} or take damage.'] }],
  spellcasting: [{ name: 'Innate', spells: { '1': { slots: 2, spells: ['a', 'c'] } }, daily: { '1e': ['x'] }, will: ['w'] }],
  legendaryHeader: ['The gloomling acts.'],
};

const child = (mod: JsonObject, extra: JsonObject = {}): JsonObject => ({
  name: 'Child',
  source: 'TST',
  _copy: { name: 'Gloomling', source: 'TST', _mod: mod },
  ...extra,
});

describe('applyCopy: base merge', () => {
  it('copies missing props but not preserve-only ones', () => {
    const { entity, warnings } = applyCopy(parent, child({}));
    expect(warnings).toEqual([]);
    expect(entity.name).toBe('Child');
    expect(entity.str).toBe(8);
    expect(entity.page).toBeUndefined();
    expect(entity.srd).toBeUndefined();
    expect(entity.reprintedAs).toBeUndefined();
    expect(entity._isCopy).toBe(true);
    expect(entity._copy).toBeUndefined();
  });

  it('honours _preserve and null deletions', () => {
    const c = child({}, { dex: null });
    (c._copy as JsonObject)._preserve = { page: true };
    const { entity } = applyCopy(parent, c);
    expect(entity.page).toBe(10);
    expect('dex' in entity).toBe(false);
  });

  it('does not mutate inputs', () => {
    const p = structuredClone(parent);
    const c = child({ trait: { mode: 'appendArr', items: { name: 'X', entries: [] } } });
    const cSnapshot = structuredClone(c);
    applyCopy(p, c);
    expect(p).toEqual(parent);
    expect(c).toEqual(cSnapshot);
  });
});

describe('applyCopy: mod modes', () => {
  const run = (mod: JsonObject, extra?: JsonObject) => applyCopy(parent, child(mod, extra));

  it('replaceTxt skips text inside tags unless tagInsensitive', () => {
    const { entity } = run({ trait: { mode: 'replaceTxt', replace: 'the gloomling', with: 'Bob', flags: 'i' } });
    expect((entity.trait as JsonObject[])[0]!.entries).toEqual(['Bob hides. {@b the gloomling} stays tagged.']);
    const { entity: e2 } = run({ trait: { mode: 'replaceTxt', replace: 'the gloomling', with: 'Bob', flags: 'i', tagInsensitive: true } });
    expect((e2.trait as JsonObject[])[0]!.entries).toEqual(['Bob hides. {@b Bob} stays tagged.']);
  });

  it('replaceTxt on "*" also hits pure-string header arrays', () => {
    const { entity } = run({ '*': { mode: 'replaceTxt', replace: 'gloomling', with: 'imp' } });
    expect(entity.legendaryHeader).toEqual(['The imp acts.']);
  });

  it('prependArr / appendArr / insertArr', () => {
    const item = { name: 'New', entries: [] };
    expect((run({ trait: { mode: 'prependArr', items: item } }).entity.trait as JsonObject[])[0]!.name).toBe('New');
    expect((run({ trait: { mode: 'appendArr', items: item } }).entity.trait as JsonObject[])[2]!.name).toBe('New');
    expect((run({ trait: { mode: 'insertArr', index: 1, items: item } }).entity.trait as JsonObject[])[1]!.name).toBe('New');
    expect(run({ bonus: { mode: 'appendArr', items: item } }).entity.bonus).toEqual([item]);
  });

  it('replaceArr by name, regex and index; replaceOrAppendArr', () => {
    const item = { name: 'Swapped', entries: [] };
    const names = (e: JsonObject) => (e.trait as JsonObject[]).map((t) => t.name);
    expect(names(run({ trait: { mode: 'replaceArr', replace: 'Keen Ears', items: item } }).entity)).toEqual(['Shadow Step', 'Swapped']);
    expect(names(run({ trait: { mode: 'replaceArr', replace: { regex: '^Shadow' }, items: item } }).entity)).toEqual(['Swapped', 'Keen Ears']);
    expect(names(run({ trait: { mode: 'replaceArr', replace: { index: 1 }, items: item } }).entity)).toEqual(['Shadow Step', 'Swapped']);
    expect(names(run({ trait: { mode: 'replaceOrAppendArr', replace: 'Nope', items: item } }).entity)).toEqual(['Shadow Step', 'Keen Ears', 'Swapped']);
    const { warnings } = run({ trait: { mode: 'replaceArr', replace: 'Nope', items: item } });
    expect(warnings[0]).toMatch(/Could not find/);
  });

  it('appendIfNotExistsArr, removeArr, renameArr', () => {
    const { entity } = run({ senses: { mode: 'appendIfNotExistsArr', items: ['darkvision 60 ft.', 'tremorsense 10 ft.'] } });
    expect(entity.senses).toEqual(['darkvision 60 ft.', 'tremorsense 10 ft.']);
    const removed = run({ trait: { mode: 'removeArr', names: 'Keen Ears' } }).entity;
    expect((removed.trait as JsonObject[]).map((t) => t.name)).toEqual(['Shadow Step']);
    const renamed = run({ trait: { mode: 'renameArr', renames: { rename: 'Keen Ears', with: 'Sharp Ears' } } }).entity;
    expect((renamed.trait as JsonObject[])[1]!.name).toBe('Sharp Ears');
  });

  it('remove, setProp, prefixSuffixStringProp, appendStr', () => {
    expect('skill' in run({ skill: 'remove' }).entity).toBe(false);
    expect(run({ _: { mode: 'setProp', prop: 'hp.average', value: 42 } }).entity.hp).toEqual({ average: 42 });
    expect(run({ _: { mode: 'prefixSuffixStringProp', prop: 'name', prefix: 'Elder ', suffix: '!' } }).entity.name).toBe('Elder Child!');
    expect(run({ alignmentPrefix: { mode: 'appendStr', str: 'typically ' } }).entity.alignmentPrefix).toBe('typically ');
  });

  it('scalar mods and calculateProp use safe arithmetic', () => {
    expect(run({ skill: { mode: 'scalarAddProp', prop: 'stealth', scalar: 2 } }).entity.skill).toEqual({ stealth: '+8' });
    expect(run({ _: { mode: 'scalarMultProp', prop: 'str', scalar: 1.5, floor: true } }).entity.str).toBe(12);
    const calc = run({ hp: { mode: 'calculateProp', prop: 'average', formula: '<$prof_bonus$> * 3 + <$dex_mod$>' } }).entity;
    expect((calc.hp as JsonObject).average).toBe(2 * 3 + 2);
    const evil = run({ hp: { mode: 'calculateProp', prop: 'average', formula: 'process.exit(1)' } });
    // Never executed: identifiers are stripped and what remains (".(1)") is rejected by the arithmetic parser
    expect(evil.warnings[0]).toMatch(/Invalid number|Unexpected/);
  });

  it('scalarAddHit / scalarAddDc rewrite tags', () => {
    const { entity } = run({ action: { mode: 'scalarAddHit', scalar: 2 } });
    expect((entity.action as JsonObject[])[0]!.entries).toEqual(['{@hit 6} to hit, {@dc 12} or take damage.']);
    const { entity: e2 } = run({ action: { mode: 'scalarAddDc', scalar: -1 } });
    expect((e2.action as JsonObject[])[0]!.entries).toEqual(['{@hit 4} to hit, {@dc 11} or take damage.']);
  });

  it('bestiary mods: senses, saves, skills, size, xp', () => {
    expect(run({ _: { mode: 'addSenses', senses: [{ type: 'darkvision', range: 120 }, { type: 'blindsight', range: 10 }] } }).entity.senses).toEqual([
      'darkvision 120 ft.',
      'blindsight 10 ft.',
    ]);
    expect(run({ _: { mode: 'addSaves', saves: { dex: 1 } } }).entity.save).toEqual({ dex: '+4' });
    expect(run({ _: { mode: 'addSkills', skills: { perception: 2 } } }).entity.skill).toEqual({ stealth: '+6', perception: '+4' });
    expect(run({ _: { mode: 'addAllSaves', saves: 1 } }).entity.save).toMatchObject({ str: '+1', dex: '+4' });
    expect(run({ _: { mode: 'maxSize', max: 'S' } }).entity.size).toEqual(['S']);
    expect(run({ _: { mode: 'scalarMultXp', scalar: 2 } }).entity.cr).toEqual({ cr: '1/4', xp: 100 });
  });

  it('spell mods', () => {
    const added = run({ _: { mode: 'addSpells', spells: { '1': { spells: ['b'] } }, will: ['w2'], daily: { '1e': ['y'] } } }).entity;
    const sc = (added.spellcasting as JsonObject[])[0]!;
    expect((sc.spells as JsonObject)['1']).toEqual({ slots: 2, spells: ['a', 'b', 'c'] });
    expect(sc.will).toEqual(['w', 'w2']);
    expect(sc.daily).toEqual({ '1e': ['x', 'y'] });
    const replaced = run({ _: { mode: 'replaceSpells', spells: { '1': [{ replace: 'a', with: 'z' }] } } }).entity;
    expect(((replaced.spellcasting as JsonObject[])[0]!.spells as JsonObject)['1']).toEqual({ slots: 2, spells: ['c', 'z'] });
    const removed = run({ _: { mode: 'removeSpells', spells: { '1': ['a'] } } }).entity;
    expect((((removed.spellcasting as JsonObject[])[0]!.spells as JsonObject)['1'] as JsonObject).spells).toEqual(['c']);
  });

  it('resolves <$variables$> against the merged entity', () => {
    const { entity } = run(
      { action: { mode: 'appendArr', items: { name: 'Bite', entries: ['{@hit <$to_hit__str$>} DC <$dc__dex$>, <$title_short_name$> bites<$damage_mod__str$>.'] } } },
      { str: 16 },
    );
    expect((entity.action as JsonObject[])[1]!.entries).toEqual(['{@hit +5} DC 12, The child bites + 3.']);
  });

  it('unknown modes become warnings, not crashes', () => {
    const { entity, warnings } = run({ trait: { mode: 'explodeEverything' } });
    expect(entity.name).toBe('Child');
    expect(warnings[0]).toMatch(/Unhandled mode/);
  });

  it('applies _templates', () => {
    const c: JsonObject = { name: 'Zombie Gloomling', source: 'TST', _copy: { name: 'Gloomling', source: 'TST', _templates: [{ name: 'Zombie', source: 'TST' }] } };
    const templates = [{ name: 'Zombie', source: 'TST', apply: { _root: { type: 'undead', str: 99 }, _mod: { trait: { mode: 'appendArr', items: { name: 'Undead Fortitude', entries: [] } } } } }];
    const { entity } = applyCopy(parent, c, { templates });
    expect(entity.type).toBe('undead');
    expect(entity.str).toBe(99); // _root overrides inherited props, but never the child's own root props
    expect((entity.trait as JsonObject[]).at(-1)!.name).toBe('Undead Fortitude');
    expect(entity._copy_templates).toEqual([{ name: 'Zombie', source: 'TST' }]);
  });
});

describe('CopyResolver', () => {
  const official: JsonObject = { name: 'Gloomling', source: 'TST', cr: '1/4', str: 8, trait: [{ name: 'A', entries: [] }] };
  const mid: JsonObject = { name: 'Mid', source: 'TST', _copy: { name: 'Gloomling', source: 'TST', _mod: { trait: { mode: 'appendArr', items: { name: 'B', entries: [] } } } } };
  const homebrew: JsonObject = { name: 'Brew', source: 'MyBrew', _copy: { name: 'Mid', source: 'TST', _mod: { trait: { mode: 'appendArr', items: { name: 'C', entries: [] } } } } };
  const all = [official, mid, homebrew];
  const lookup = (prop: string, key: string) => all.find((e) => identityKey(prop, e) === key);

  it('resolves chains, including homebrew _copy of official entities', () => {
    const resolver = new CopyResolver(lookup);
    const out = resolver.resolve('monster', homebrew);
    expect((out.trait as JsonObject[]).map((t) => t.name)).toEqual(['A', 'B', 'C']);
    expect(out.source).toBe('MyBrew');
    expect(out.str).toBe(8);
    expect(resolver.warnings).toEqual([]);
    expect(resolver.resolve('monster', homebrew)).toBe(out); // memoized
  });

  it('detects cycles and missing parents', () => {
    const a: JsonObject = { name: 'A', source: 'TST', _copy: { name: 'B', source: 'TST' } };
    const b: JsonObject = { name: 'B', source: 'TST', _copy: { name: 'A', source: 'TST' } };
    const missing: JsonObject = { name: 'M', source: 'TST', _copy: { name: 'Nope', source: 'TST' } };
    const set = [a, b, missing];
    const resolver = new CopyResolver((prop, key) => set.find((e) => identityKey(prop, e) === key));
    expect(resolver.resolve('monster', a)._copyUnresolved).toBeDefined();
    expect(resolver.resolve('monster', missing)._copyUnresolved).toBe('missing');
    expect(resolver.warnings.some((w) => /cycle/.test(w))).toBe(true);
    expect(resolver.warnings.some((w) => /not found/.test(w))).toBe(true);
  });

  it('uses per-type identity for subclass copies', () => {
    const sc: JsonObject = { name: 'Path of Tests', shortName: 'Tests', source: 'TST', className: 'Warrior', classSource: 'TST', features: ['x'] };
    const copy: JsonObject = { name: 'Path of Tests', shortName: 'Tests', source: 'XTST', className: 'Warrior', classSource: 'TST', _copy: { name: 'Path of Tests', shortName: 'Tests', source: 'TST', className: 'Warrior', classSource: 'TST' } };
    const resolver = new CopyResolver((prop, key) => [sc, copy].find((e) => identityKey(prop, e) === key));
    expect(resolver.resolve('subclass', copy).features).toEqual(['x']);
  });
});
