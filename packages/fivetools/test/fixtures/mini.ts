/**
 * A tiny synthetic dataset shaped like 5etools data. All names and text are invented for tests —
 * no 5etools/WotC content. Sources: TST (classic test book), XTST (2024-style reprint), OLD (legacy).
 */
import type { RawDataFile } from '../../src/dataset/build';

export const miniBooks = {
  book: [
    { name: 'Test Handbook', id: 'TST', source: 'TST', group: 'core', published: '2015-01-01' },
    { name: 'Test Handbook (2024)', id: 'XTST', source: 'XTST', group: 'core', published: '2025-01-01' },
    { name: 'Old Tome', id: 'OLD', source: 'OLD', group: 'supplement', published: '2014-10-01' },
  ],
};

export const miniFiles: RawDataFile[] = [
  { path: 'books.json', json: miniBooks },
  { path: 'adventures.json', json: { adventure: [] } },
  {
    path: 'bestiary/bestiary-tst.json',
    json: {
      monster: [
        {
          name: 'Gloomling',
          source: 'TST',
          page: 10,
          size: ['S'],
          type: 'fey',
          cr: '1/4',
          str: 8,
          dex: 14,
          hp: { average: 7, formula: '2d6' },
          reprintedAs: ['Gloomling Scout|XTST'],
          trait: [{ name: 'Shadow Step', entries: ['The gloomling can hide as a bonus action.'] }],
          action: [{ name: 'Needle', entries: ['{@atk mw} {@hit 4} to hit. {@h}5 ({@damage 1d6 + 2}) piercing damage. DC {@dc 12}.'] }],
          hasToken: true,
          hasFluff: true,
        },
        {
          name: 'Gloomling Chief',
          source: 'TST',
          page: 11,
          _copy: {
            name: 'Gloomling',
            source: 'TST',
            _mod: {
              '*': { mode: 'replaceTxt', replace: 'the gloomling', with: 'the chief', flags: 'i' },
              action: { mode: 'appendArr', items: { name: 'Command', entries: ['The chief commands <$short_name$> allies.'] } },
            },
          },
          cr: '1',
          str: 12,
        },
        {
          name: 'Loop A',
          source: 'TST',
          _copy: { name: 'Loop B', source: 'TST' },
        },
        {
          name: 'Loop B',
          source: 'TST',
          _copy: { name: 'Loop A', source: 'TST' },
        },
        {
          name: 'Orphan',
          source: 'TST',
          _copy: { name: 'Does Not Exist', source: 'TST' },
          cr: '2',
        },
        {
          name: 'Shapeshifter',
          source: 'TST',
          cr: '3',
          size: ['M'],
          _versions: [
            { name: 'Shapeshifter (Wolf Form)', source: 'TST', _mod: { trait: { mode: 'appendArr', items: { name: 'Keen Nose', entries: ['Smells well.'] } } } },
            {
              _abstract: { name: 'Shapeshifter ({{form}})', source: 'TST', _mod: { trait: { mode: 'appendArr', items: { name: '{{form}} Body', entries: ['It is a {{form}}.'] } } } },
              _implementations: [{ _variables: { form: 'Bear' } }, { _variables: { form: 'Owl' } }],
            },
          ],
        },
      ],
    },
  },
  {
    path: 'bestiary/bestiary-xtst.json',
    json: {
      monster: [{ name: 'Gloomling Scout', source: 'XTST', page: 20, size: ['S'], type: 'fey', cr: '1/4', token: { name: 'Gloomling', source: 'TST' } }],
    },
  },
  {
    path: 'bestiary/fluff-bestiary-tst.json',
    json: { monsterFluff: [{ name: 'Gloomling', source: 'TST', entries: ['Gloomlings lurk.'], images: [{ type: 'image', href: { type: 'internal', path: 'bestiary/TST/Gloomling.webp' } }] }] },
  },
  {
    path: 'spells/spells-tst.json',
    json: {
      spell: [
        { name: 'Spark Burst', source: 'TST', level: 3, school: 'V', reprintedAs: ['Spark Burst|XTST'], entries: ['A burst of {@damage 8d6} fire.'] },
        { name: 'Ancient Ward', source: 'OLD', level: 1, school: 'A', entries: ['Protective.'] },
      ],
    },
  },
  {
    path: 'spells/spells-xtst.json',
    json: { spell: [{ name: 'Spark Burst', source: 'XTST', level: 3, school: 'V', entries: ['A bigger burst of {@damage 8d6} fire.'] }] },
  },
  { path: 'spells/sources.json', json: { TST: { 'Spark Burst': { class: [{ name: 'Wizard', source: 'TST' }] } } } },
  {
    path: 'races.json',
    json: {
      race: [
        { name: 'Sylph', source: 'TST', size: ['M'], speed: 30, entries: [{ type: 'entries', name: 'Breeze', entries: ['Light on its feet.'] }] },
        { name: 'Sylph', source: 'XTST', size: ['M'], speed: 35, edition: 'one', entries: ['Modern sylph.'] },
      ],
      subrace: [
        { name: 'Storm', source: 'TST', raceName: 'Sylph', raceSource: 'TST', ability: [{ dex: 1 }], entries: [{ type: 'entries', name: 'Static', entries: ['Zap.'] }] },
      ],
    },
  },
  {
    path: 'items-base.json',
    json: {
      baseitem: [
        { name: 'Shortblade', source: 'TST', type: 'M', weapon: true, weaponCategory: 'simple', dmg1: '1d6', dmgType: 'P', edition: 'classic', value: 1000, reprintedAs: ['Shortblade|XTST'] },
        { name: 'Shortblade', source: 'XTST', type: 'M|XTST', weapon: true, weaponCategory: 'simple', dmg1: '1d6', dmgType: 'P', edition: 'one', value: 1000 },
      ],
      itemProperty: [{ abbreviation: 'F', source: 'TST', entries: [{ type: 'entries', name: 'Finesse', entries: ['Use Dex.'] }] }],
    },
  },
  {
    path: 'magicvariants.json',
    json: {
      magicvariant: [
        {
          name: '+1 Blade',
          edition: 'classic',
          requires: [{ weapon: true }],
          inherits: { namePrefix: '+1 ', source: 'TST', page: 50, rarity: 'uncommon', bonusWeapon: '+1', reprintedAs: ['+1 Blade|XTST'], entries: ['You have a {=bonusWeapon} bonus with this {=baseName/l}.'] },
        },
        {
          name: '+1 Blade',
          edition: 'one',
          requires: [{ weapon: true }],
          inherits: { namePrefix: '+1 ', source: 'XTST', page: 60, rarity: 'uncommon', bonusWeapon: '+1', entries: ['Bonus {=bonusWeapon}.'] },
        },
      ],
    },
  },
  {
    path: 'items.json',
    json: { item: [{ name: 'Glow Stone', source: 'TST', rarity: 'common', wondrous: true, entries: ['It glows.'] }], itemGroup: [] },
  },
  {
    path: 'conditionsdiseases.json',
    json: {
      condition: [
        { name: 'Dazed', source: 'TST', entries: ['You are dazed.'], reprintedAs: ['Dazed|XTST'] },
        { name: 'Dazed', source: 'XTST', entries: ['You are dazed (2024).'] },
      ],
    },
  },
  { path: 'foundry-items.json', json: { item: [{ name: 'Should Be Ignored', source: 'TST' }] } },
];
