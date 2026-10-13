import { describe, expect, it } from 'vitest';
import { averageDice, parseDice, rollDice } from '../src/render/dice';
import {
  abilityBonusText,
  abilityTable,
  acText,
  alignmentList,
  crText,
  hpText,
  immResText,
  initiativeText,
  itemPropertiesLine,
  itemTypeLine,
  monsterTypeLine,
  prerequisiteText,
  proficiencyText,
  speedText,
  spellComponentsText,
  spellDurationText,
  spellLevelSchool,
  spellRangeText,
  spellTimeText,
} from '../src/render/format';
import { findEntityRefs, inlineToText, renderInline, type InlineRender } from '../src/render/inline';

const first = (s: string) => renderInline(s)[0] as InlineRender;

describe('renderInline', () => {
  it('renders entity links with uids and display text', () => {
    expect(first('{@spell fireball|xphb|Big Boom}')).toEqual({
      t: 'entity', kind: 'spell', uid: 'spell:fireball|xphb', name: 'fireball', source: 'xphb', children: [{ t: 'text', text: 'Big Boom' }],
    });
    expect(first('{@creature goblin}')).toMatchObject({ kind: 'monster', uid: 'monster:goblin|mm' });
    expect(first('{@condition Poisoned|XPHB}')).toMatchObject({ uid: 'condition:poisoned|xphb' });
  });

  it('renders statblock prose', () => {
    expect(inlineToText(renderInline('{@atk mw,rw} {@hit 5} to hit. {@h}7 ({@damage 1d8 + 3}) slashing'))).toBe(
      'Melee or Ranged Weapon Attack: +5 to hit. Hit: 7 (1d8 + 3) slashing',
    );
    expect(inlineToText(renderInline('{@atkr m} {@actSave dex} {@actSaveFail} {@actSaveFail 2} {@actSaveFailBy 5}'))).toBe(
      'Melee Attack Roll: Dexterity Saving Throw: Failure: Second Failure: Failure by 5 or More:',
    );
  });

  it('renders rolls with expressions', () => {
    expect(first('{@damage 2d6+3}')).toMatchObject({ t: 'roll', mode: 'damage', expr: '2d6+3' });
    expect(first('{@hit 4}')).toMatchObject({ t: 'roll', mode: 'hit', expr: '1d20+4', children: [{ t: 'text', text: '+4' }] });
    expect(first('{@hit -1}')).toMatchObject({ expr: '1d20-1' });
    expect(first('{@dice 1d20+2|roll it}')).toMatchObject({ expr: '1d20+2', children: [{ t: 'text', text: 'roll it' }] });
    expect(inlineToText(renderInline('{@recharge 5} {@recharge} {@dc 15} {@chance 25}'))).toBe('(Recharge 5–6) (Recharge 6) DC 15 25 percent');
    expect(inlineToText(renderInline('{@ability str 18}'))).toBe('18 (+4)');
  });

  it('nests formatting and keeps unknown tags as text', () => {
    expect(first('{@b {@i nested}}')).toEqual({ t: 'style', styles: ['bold'], children: [{ t: 'style', styles: ['italic'], children: [{ t: 'text', text: 'nested' }] }] });
    expect(inlineToText(renderInline('{@totallyNew some text|arg}'))).toBe('some text');
    expect(inlineToText(renderInline('{@spell}'))).toBe('');
  });

  it('only allows safe external links, colours and image paths', () => {
    expect(first('{@link docs|https://example.com}')).toMatchObject({ t: 'external', href: 'https://example.com' });
    expect(first('{@link bad|javascript:alert(1)}')).toMatchObject({ t: 'style' });
    expect(first('{@color red|ff0000}')).toMatchObject({ color: '#ff0000' });
    expect(first('{@color evil|red;background:url(x)}')).not.toHaveProperty('color');
    expect(first('{@5etoolsImg cover|covers/PHB.webp}')).toMatchObject({ t: 'image', path: 'covers/PHB.webp' });
    expect(first('{@5etoolsImg bad|../../etc/passwd.webp}')).toMatchObject({ t: 'style' });
  });

  it('maps filter tags to kinds', () => {
    expect(first('{@filter 1st|spells|level=1|class=Wizard}')).toMatchObject({ t: 'filter', page: 'spell', filters: { level: '1', class: 'Wizard' } });
  });

  it('finds entity references', () => {
    expect(findEntityRefs('Cast {@spell fireball|phb} at {@creature goblin|mm|goblins} ({@b {@item dagger|phb}})').map((r) => r.uid)).toEqual([
      'spell:fireball|phb',
      'monster:goblin|mm',
      'item:dagger|phb',
    ]);
  });
});

describe('dice', () => {
  const seq = (...values: number[]) => {
    let i = 0;
    return () => values[i++ % values.length]!;
  };

  it('parses common expressions', () => {
    expect(parseDice('2d6 + 3')).toMatchObject({ terms: [{ count: 2, faces: 6, sign: 1 }], constant: 3 });
    expect(parseDice('d20')).toMatchObject({ terms: [{ count: 1, faces: 20 }] });
    expect(parseDice('1d20-1')).toMatchObject({ constant: -1 });
    expect(parseDice('4d6kh3')!.terms[0]!.keep).toEqual({ type: 'kh', n: 3 });
    expect(parseDice('1d4×10')).toMatchObject({ multiplier: 10 });
    expect(parseDice('2d10 + 1d6 - 1')!.terms).toHaveLength(2);
    expect(parseDice('7')).toMatchObject({ terms: [], constant: 7 });
  });

  it('rejects junk and oversized rolls', () => {
    for (const bad of ['', 'abc', '2d', 'd', '1d6 2', '999d6', '1d6+alert(1)']) expect(parseDice(bad), bad).toBeNull();
  });

  it('rolls deterministically with an injected random source', () => {
    expect(rollDice(parseDice('2d6+3')!, seq(4, 5)).total).toBe(12);
    const kh = rollDice(parseDice('4d6kh3')!, seq(1, 6, 3, 5));
    expect(kh.total).toBe(14);
    expect(kh.rolls[0]!.kept).toEqual([false, true, true, true]);
    expect(rollDice(parseDice('1d4×10')!, seq(3)).total).toBe(30);
    expect(averageDice(parseDice('2d6+3')!)).toBe(10);
  });
});

describe('formatters', () => {
  const goblin = {
    name: 'Goblin', size: ['S'], type: { type: 'humanoid', tags: ['goblinoid'] }, alignment: ['N', 'E'], cr: '1/4',
    ac: [{ ac: 15, from: ['{@item leather armor|phb}', '{@item shield|phb}'] }], hp: { average: 7, formula: '2d6' },
    speed: { walk: 30, fly: { number: 60, condition: '(in bat form)' }, canHover: true }, str: 8, dex: 14, save: { dex: '+4' },
  };

  it('formats monster lines in both styles', () => {
    expect(monsterTypeLine(goblin, 'classic')).toBe('Small humanoid (goblinoid), neutral evil');
    expect(monsterTypeLine(goblin, 'one')).toBe('Small Humanoid (goblinoid), Neutral Evil');
    expect(acText(goblin.ac)).toBe('15 ({@item leather armor|phb}, {@item shield|phb})');
    expect(acText([12, { ac: 15, condition: 'with {@spell mage armor}', braces: true }])).toBe('12 (15 with {@spell mage armor})');
    expect(acText([12, 14])).toBe('12, 14');
    expect(hpText(goblin.hp)).toBe('7 ({@dice 2d6|2d6})');
    expect(speedText(goblin.speed)).toBe('30 ft., fly 60 ft. (in bat form) (hover)');
    expect(crText(goblin, 'classic')).toBe('1/4 (50 XP)');
    expect(crText({ cr: { cr: '10', lair: '11' } }, 'one')).toBe('10 (XP 5,900, or 7,200 in lair; PB +4)');
    expect(initiativeText({ dex: 14, cr: '5', initiative: { proficiency: 1 } })).toBe('+5 (15)');
    expect(abilityTable(goblin).map((a) => [a.label, a.score, a.mod, a.save])).toEqual([
      ['STR', 8, '-1', '-1'],
      ['DEX', 14, '+2', '+4'],
    ]);
  });

  it('formats alignments', () => {
    expect(alignmentList(['U'])).toBe('unaligned');
    expect(alignmentList(['A'])).toBe('any alignment');
    expect(alignmentList(['L', 'NX', 'C', 'NY', 'E'])).toBe('any non-good alignment');
    expect(alignmentList(['C', 'G', 'NY', 'E'])).toBe('any chaotic alignment');
    expect(alignmentList([{ alignment: ['L', 'G'], chance: 50 }, { alignment: ['N', 'E'], chance: 50 }])).toBe('lawful good (50%) or neutral evil (50%)');
  });

  it('formats damage immunities with groups', () => {
    expect(immResText(['fire', { resist: ['bludgeoning', 'piercing', 'slashing'], note: 'from nonmagical attacks', cond: true }], 'resist')).toBe(
      'fire; bludgeoning, piercing, slashing from nonmagical attacks',
    );
  });

  it('formats spells in both styles', () => {
    const spell = {
      level: 3, school: 'V', time: [{ number: 1, unit: 'action' }], range: { type: 'point', distance: { type: 'feet', amount: 150 } },
      components: { v: true, s: true, m: 'a tiny ball of bat guano and sulfur' }, duration: [{ type: 'instant' }],
      _classes: [{ name: 'Wizard', source: 'PHB' }, { name: 'Sorcerer', source: 'PHB' }], meta: { ritual: false },
    };
    expect(spellLevelSchool(spell, 'classic')).toBe('3rd-level evocation');
    expect(spellLevelSchool(spell, 'one')).toBe('Level 3 Evocation (Sorcerer, Wizard)');
    expect(spellLevelSchool({ level: 0, school: 'C' }, 'classic')).toBe('Conjuration cantrip');
    expect(spellTimeText(spell, 'classic')).toBe('1 action');
    expect(spellTimeText({ ...spell, meta: { ritual: true } }, 'one')).toBe('Action or Ritual');
    expect(spellRangeText(spell)).toBe('150 feet');
    expect(spellRangeText({ range: { type: 'cone', distance: { type: 'feet', amount: 15 } } })).toBe('Self (15-foot cone)');
    expect(spellComponentsText(spell)).toBe('V, S, M (a tiny ball of bat guano and sulfur)');
    expect(spellDurationText(spell)).toBe('Instantaneous');
    expect(spellDurationText({ duration: [{ type: 'timed', duration: { type: 'minute', amount: 1 }, concentration: true }] })).toBe('Concentration, up to 1 minute');
    expect(spellDurationText({ duration: [{ type: 'permanent', ends: ['dispel', 'trigger'] }] })).toBe('Until dispelled or triggered');
  });

  it('formats items', () => {
    const sword = { type: 'M|XPHB', weapon: true, weaponCategory: 'martial', rarity: 'none', dmg1: '1d8', dmgType: 'S', dmg2: '1d10', property: ['V|XPHB'], mastery: ['Sap|XPHB'] };
    expect(itemTypeLine(sword, 'classic')).toBe('Martial melee weapon');
    expect(itemPropertiesLine(sword)).toBe('{@damage 1d8} slashing — versatile ({@damage 1d10}) — Mastery: {@itemMastery Sap|XPHB}');
    expect(itemTypeLine({ wondrous: true, rarity: 'rare', reqAttune: 'by a wizard' }, 'classic')).toBe('Wondrous item, rare (requires attunement by a wizard)');
  });

  it('formats character options', () => {
    expect(abilityBonusText([{ dex: 2, wis: 1 }])).toBe('Dex +2, Wis +1');
    expect(abilityBonusText([{ choose: { weighted: { from: ['int', 'wis', 'cha'], weights: [2, 1] } } }])).toBe('Choose Int, Wis, Cha: +2/+1');
    expect(proficiencyText([{ insight: true, religion: true }], 'skill')).toBe('{@skill Insight}, {@skill Religion}');
    expect(proficiencyText([{ choose: { from: ['arcana', 'history'], count: 1 } }])).toBe('choose 1 from Arcana, History');
    expect(prerequisiteText([{ level: 4 }, { ability: [{ str: 13 }] }])).toBe('4th-level; or Strength 13 or higher');
  });
});

describe('spellcasting blocks', () => {
  it('lists at-will, per-day and slot spells', async () => {
    const { spellcastingBlock } = await import('../src/render/format');
    const block = spellcastingBlock(
      {
        name: 'Spellcasting',
        headerEntries: ['The mage casts spells.'],
        will: ['{@spell light}'],
        daily: { '1e': ['{@spell fly}', { entry: '{@spell secret}', hidden: true }], '2': ['{@spell shield}'] },
        spells: { '0': { spells: ['{@spell mage hand}'] }, '1': { slots: 4, spells: ['{@spell magic missile}'] } },
      },
      'classic',
    );
    expect(block.lines).toEqual([
      { label: 'At will', spells: '{@spell light}' },
      { label: '2/day', spells: '{@spell shield}' },
      { label: '1/day each', spells: '{@spell fly}' },
      { label: 'Cantrips (at will)', spells: '{@spell mage hand}' },
      { label: '1st level (4 slots)', spells: '{@spell magic missile}' },
    ]);
  });
});
