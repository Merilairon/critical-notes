import { describe, expect, it } from 'vitest';
import { buildDataset } from '../src/dataset/build';
import { buildSourceRegistry } from '../src/dataset/sources';
import {
  crossEditionBadge,
  isEntityVisible,
  isSourceEnabled,
  makePolicy,
  type RulesetId,
} from '../src/edition/policy';
import { buildReprintGroups, pickRepresentative, reprintTargetUid } from '../src/edition/reprints';
import { classifySource, entityEdition, makeEditionLists } from '../src/edition/sources';
import { miniBooks, miniFiles } from './fixtures/mini';

const lists = makeEditionLists({ classic: ['TST', 'OLD'], modern: ['XTST'], legacy: ['OLD'] });

describe('classifySource', () => {
  it('prefers homebrew declaration, then overrides, then lists, then date, then default', () => {
    expect(classifySource({ id: 'TST', homebrewEdition: 'any', lists })).toMatchObject({ edition: 'any', reason: 'homebrew' });
    expect(classifySource({ id: 'TST', lists, overrides: new Map([['tst', 'one' as const]]) })).toMatchObject({ edition: 'one', reason: 'override' });
    expect(classifySource({ id: 'xtst', lists })).toMatchObject({ edition: 'one', reason: 'list' });
    expect(classifySource({ id: 'OLD', lists })).toMatchObject({ edition: 'classic', legacy: true });
    expect(classifySource({ id: 'NEWBOOK', published: '2026-09-15', lists })).toMatchObject({ edition: 'one', reason: 'date' });
    expect(classifySource({ id: 'OLDBOOK', published: '2019-01-01', lists })).toMatchObject({ edition: 'classic', reason: 'date' });
    const unknown = classifySource({ id: 'MYSTERY', lists });
    expect(unknown).toMatchObject({ edition: 'classic', reason: 'default' });
    expect(unknown.warning).toBeTruthy();
  });

  it('lets entity-level edition override the source', () => {
    expect(entityEdition({ edition: 'one' }, 'classic')).toBe('one');
    expect(entityEdition({}, 'classic')).toBe('classic');
    expect(entityEdition({ edition: 'weird' }, 'one')).toBe('one');
  });
});

describe('campaign policy matrix', () => {
  const sources = new Map([
    ['tst', { id: 'TST', edition: 'classic' as const }],
    ['old', { id: 'OLD', edition: 'classic' as const }],
    ['xtst', { id: 'XTST', edition: 'one' as const }],
    ['brew', { id: 'BREW', edition: 'any' as const }], // no kind: treated like an official source here
  ]);
  const cases: [RulesetId, boolean, Record<string, boolean>, string, string, boolean][] = [
    // ruleset, crossEdition, overrides, entitySource, entityEdition, visible
    ['2014', false, {}, 'TST', 'classic', true],
    ['2014', false, {}, 'XTST', 'one', false],
    ['2014', true, {}, 'XTST', 'one', true],
    ['2014', true, { XTST: false }, 'XTST', 'one', false],
    ['2014', false, { XTST: true }, 'XTST', 'one', false], // toggles cannot bypass the cross-edition switch
    ['2014', false, { TST: false }, 'TST', 'classic', false],
    ['2024', false, {}, 'XTST', 'one', true],
    ['2024', false, {}, 'TST', 'classic', false],
    ['2024', true, {}, 'OLD', 'classic', true],
    ['2024', false, {}, 'BREW', 'any', true],
    ['2014', false, {}, 'BREW', 'any', true],
    ['2024', false, { BREW: false }, 'BREW', 'any', false],
    ['2024', false, {}, 'TST', 'one', false], // modern entity in a classic source: source disabled
    ['2024', false, {}, 'UNKNOWN', 'one', false],
  ];
  it.each(cases)('%s cross=%s overrides=%j → %s/%s visible=%s', (ruleset, cross, overrides, source, edition, visible) => {
    const policy = makePolicy(ruleset, { crossEdition: cross, sourceOverrides: Object.entries(overrides) });
    expect(isEntityVisible({ source, edition: edition as 'classic' | 'one' | 'any' }, policy, sources)).toBe(visible);
  });

  it('badges cross-edition content only', () => {
    expect(crossEditionBadge('classic', makePolicy('2024', { crossEdition: true }))).toBe('legacy');
    expect(crossEditionBadge('one', makePolicy('2014', { crossEdition: true }))).toBe('modern');
    expect(crossEditionBadge('one', makePolicy('2024'))).toBeNull();
    expect(crossEditionBadge('any', makePolicy('2014'))).toBeNull();
  });

  it('homebrew sources are only visible when the campaign allows them', () => {
    const brew = { id: 'MyBrew', edition: 'any' as const, kind: 'homebrew' as const };
    expect(isSourceEnabled(brew, makePolicy('2024'))).toBe(false);
    expect(isSourceEnabled(brew, makePolicy('2024', { homebrewSources: ['mybrew'] }))).toBe(true);
    expect(isSourceEnabled(brew, makePolicy('2024', { homebrewSources: ['MYBREW'], sourceOverrides: [['mybrew', false]] }))).toBe(false);
  });

  it('source enablement defaults', () => {
    expect(isSourceEnabled({ id: 'TST', edition: 'classic' }, makePolicy('2014'))).toBe(true);
    expect(isSourceEnabled({ id: 'XTST', edition: 'one' }, makePolicy('2014'))).toBe(false);
    expect(isSourceEnabled({ id: 'XTST', edition: 'one' }, makePolicy('2014', { crossEdition: true }))).toBe(true);
  });
});

describe('reprint groups', () => {
  const { entities } = buildDataset(miniFiles);
  const uids = new Set(entities.map((e) => e.uid));
  const edges = entities.flatMap((e) =>
    (Array.isArray(e.data.reprintedAs) ? e.data.reprintedAs : []).map((r) => ({ from: e.uid, to: reprintTargetUid(e.kind, r) ?? '' })),
  );
  const info = buildReprintGroups(edges, uids);
  const { sources } = buildSourceRegistry({
    usedSources: new Set(entities.map((e) => e.source)),
    meta: new Map(miniBooks.book.map((b) => [b.id.toLowerCase(), { ...b, abbreviation: b.id, kind: 'book' as const }])),
    lists,
  });
  const sourceEdition = new Map(sources.map((s) => [s.id.toLowerCase(), s.edition]));
  const member = (uid: string) => {
    const e = entities.find((x) => x.uid === uid)!;
    return { uid, edition: entityEdition(e.data, sourceEdition.get(e.source.toLowerCase())!), generation: info.generation.get(uid) ?? 0 };
  };

  it('groups reprints across kinds of reference', () => {
    expect(info.groupOf.get('spell:spark burst|tst')).toBe(info.groupOf.get('spell:spark burst|xtst'));
    expect(info.groupOf.get('monster:gloomling|tst')).toBe(info.groupOf.get('monster:gloomling scout|xtst'));
    expect(info.groupOf.get('item:+1 shortblade|tst')).toBe(info.groupOf.get('item:+1 shortblade|xtst'));
    expect(info.groupOf.has('item:glow stone|tst')).toBe(false);
    expect(info.generation.get('spell:spark burst|xtst')).toBe(1);
  });

  it('picks the in-edition member, then the newest', () => {
    const members = ['spell:spark burst|tst', 'spell:spark burst|xtst'].map(member);
    expect(pickRepresentative(members, makePolicy('2014', { crossEdition: true }))).toBe('spell:spark burst|tst');
    expect(pickRepresentative(members, makePolicy('2024', { crossEdition: true }))).toBe('spell:spark burst|xtst');
    expect(pickRepresentative([member('spell:spark burst|tst')], makePolicy('2024', { crossEdition: true }))).toBe('spell:spark burst|tst');
    expect(pickRepresentative([], makePolicy('2024'))).toBeNull();
  });

  it('resolves object-form and class-style reprint refs', () => {
    expect(reprintTargetUid('optionalfeature', { uid: 'Archery|XTST', tag: 'feat' })).toBe('feat:archery|xtst');
    expect(reprintTargetUid('subclass', 'Champion|Fighter|XTST|XTST')).toBe('subclass:fighter|xtst|champion|xtst');
    expect(reprintTargetUid('variantrule', { uid: 'Falling|XTST', tag: 'hazard' })).toBe('hazard:falling|xtst');
  });
});
