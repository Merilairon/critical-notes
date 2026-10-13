import { describe, expect, it } from 'vitest';
import { parseEntityTag, tagCategory } from '../src/tags/registry';
import { parseInline, splitByTags, splitTagArgs, stripTags } from '../src/tags/tokenize';
import { applyPropertiesToString } from '../src/expand/properties';

describe('tokenizer', () => {
  it('splits top-level tags and keeps nesting intact', () => {
    expect(splitByTags('a {@b x {@i y}} c {=prop} d')).toEqual(['a ', '{@b x {@i y}}', ' c ', '{=prop}', ' d']);
  });

  it('splits args only at depth 0', () => {
    expect(splitTagArgs('Fireball|PHB|{@b big|boom}')).toEqual(['Fireball', 'PHB', '{@b big|boom}']);
  });

  it('parses tags and degrades malformed input to text', () => {
    expect(parseInline('Cast {@spell fireball|phb|Big Fire} now')).toEqual([
      { type: 'text', text: 'Cast ' },
      { type: 'tag', tag: 'spell', text: 'fireball|phb|Big Fire', args: ['fireball', 'phb', 'Big Fire'], raw: '{@spell fireball|phb|Big Fire}' },
      { type: 'text', text: ' now' },
    ]);
    expect(parseInline('{@h}')[0]).toMatchObject({ type: 'tag', tag: 'h', args: [''] });
    expect(parseInline('unterminated {@b oops')).toEqual([{ type: 'text', text: 'unterminated {@b oops' }]);
    expect(parseInline('{@we!rd x}')).toEqual([{ type: 'text', text: '{@we!rd x}' }]);
    expect(parseInline('stray } brace')).toEqual([{ type: 'text', text: 'stray } brace' }]);
  });

  it('strips tags to display text', () => {
    expect(stripTags('{@atk mw} {@hit 4} to hit. {@h}5 ({@damage 1d6 + 2}) damage, {@dc 13}, {@creature goblin|mm|the goblins}, {@b {@i nested}}.'))
      .toBe(' +4 to hit. Hit: 5 (1d6 + 2) damage, DC 13, the goblins, nested.');
    expect(stripTags('{@dice 1d20+5|roll it} and {@recharge 5} and {@unknownTag Some text|x}')).toBe('roll it and (Recharge 5–6) and Some text');
  });
});

describe('tag registry', () => {
  it('categorizes tags', () => {
    expect(tagCategory('b')).toBe('format');
    expect(tagCategory('damage')).toBe('roll');
    expect(tagCategory('atkr')).toBe('statblock');
    expect(tagCategory('creature')).toBe('entity');
    expect(tagCategory('creatureFluff')).toBe('entity');
    expect(tagCategory('filter')).toBe('navigation');
    expect(tagCategory('mystery')).toBe('misc');
  });

  it('parses entity refs with default sources and special layouts', () => {
    expect(parseEntityTag('creature', ['Goblin'])).toMatchObject({ kind: 'monster', source: 'MM', identity: 'goblin|mm', implicitSource: true });
    expect(parseEntityTag('spell', ['Fireball', 'XPHB', 'boom'])).toMatchObject({ source: 'XPHB', display: 'boom', implicitSource: false });
    expect(parseEntityTag('item', ['Longsword', ''])).toMatchObject({ source: 'DMG' });
    expect(parseEntityTag('classFeature', ['Rage', 'Barbarian', '', '1'])).toMatchObject({ identity: 'rage|barbarian|phb|1|phb' });
    expect(parseEntityTag('subclassFeature', ['Fast Hands', 'Rogue', '', 'Thief', '', '3'])).toMatchObject({ identity: 'fast hands|rogue|phb|thief|phb|3|phb' });
    expect(parseEntityTag('subclass', ['Berserker', 'Barbarian'])).toMatchObject({ identity: 'barbarian|phb|berserker|phb' });
    expect(parseEntityTag('deity', ['Ehlonna', 'Greyhawk', 'XDMG'])).toMatchObject({ identity: 'ehlonna|greyhawk|xdmg' });
    expect(parseEntityTag('card', ['Vizier', 'Deck of Many Things'])).toMatchObject({ identity: 'vizier|deck of many things|dmg' });
    expect(parseEntityTag('b', ['x'])).toBeNull();
    expect(parseEntityTag('spell', [''])).toBeNull();
  });
});

describe('property injection', () => {
  it('applies modifiers and recurses into tags', () => {
    const obj = { baseName: 'Longsword', bonusWeapon: '+1', count: 3, half: 0.5 };
    expect(applyPropertiesToString('a {=baseName/l} with {=bonusWeapon}', obj)).toBe('a longsword with +1');
    expect(applyPropertiesToString('{=baseName/a} {=baseName}', { baseName: 'Axe' })).toBe('an Axe');
    expect(applyPropertiesToString('{=count/x} and {=half/v}', obj)).toBe('three and ½');
    expect(applyPropertiesToString('{@item {=baseName}|phb}', obj)).toBe('{@item Longsword|phb}');
  });
});
