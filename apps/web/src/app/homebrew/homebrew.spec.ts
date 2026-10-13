import { json } from '@codemirror/lang-json';
import { syntaxTree, ensureSyntaxTree } from '@codemirror/language';
import { EditorState } from '@codemirror/state';
import { provideHttpClient } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { cardKind, EntriesEditor } from './entries-editor';
import { FormField } from './forms/entity-form';
import { getAt, normalizeValue, setAt } from './forms/path';
import { blankEntity, FORM_SPECS, unlistedFields, type FieldSpec } from './forms/specs';
import { rangeOfPath } from './json-editor';
import { entityCompletion, tagContext } from './tag-textarea';

describe('tag autocomplete context', () => {
  it('detects tag names and entity names being typed', () => {
    expect(tagContext('Casts {@sp')).toEqual({ mode: 'tag', start: 6, query: 'sp' });
    expect(tagContext('Casts {@spell fire')).toEqual({ mode: 'entity', start: 6, tag: 'spell', kind: 'spell', query: 'fire' });
    expect(tagContext('A {@creature goblin|')).toBeNull(); // already past the name
    expect(tagContext('Done {@b bold} now')).toBeNull();
    expect(tagContext('{@dice 1d')).toBeNull(); // not an entity tag
  });

  it('always inserts an explicit source', () => {
    expect(entityCompletion('spell', { name: 'Fireball', source: 'XPHB' })).toBe('{@spell Fireball|XPHB}');
  });
});

describe('path helpers', () => {
  it('sets nested values immutably and removes empty ones', () => {
    const data = { name: 'X', hp: { average: 5, formula: '1d8' }, size: ['M'] };
    const next = setAt(data, ['hp', 'average'], 9);
    expect(next).toEqual({ name: 'X', hp: { average: 9, formula: '1d8' }, size: ['M'] });
    expect(data.hp.average).toBe(5);
    expect(setAt(setAt(data, ['hp', 'average'], undefined), ['hp', 'formula'], undefined)).toEqual({ name: 'X', size: ['M'] });
    expect(setAt({}, ['speed', 'fly'], 30)).toEqual({ speed: { fly: 30 } });
    expect(getAt(next, ['hp', 'average'])).toBe(9);
    expect([normalizeValue(''), normalizeValue([]), normalizeValue(NaN), normalizeValue(0)]).toEqual([undefined, undefined, undefined, 0]);
  });
});

describe('form specs', () => {
  it('lists fields the form does not cover', () => {
    expect(unlistedFields('monster', { ...blankEntity('monster'), source: 'X', legendaryGroup: { name: 'Y' }, isNpc: true })).toEqual(['legendaryGroup', 'isNpc']);
    expect(Object.keys(FORM_SPECS)).toEqual(expect.arrayContaining(['monster', 'spell', 'item', 'baseitem', 'feat', 'race', 'subrace', 'background', 'condition', 'variantrule', 'table']));
  });

  it('falls back to JSON for values the widget cannot represent, and keeps them', () => {
    TestBed.configureTestingModule({ imports: [FormField], providers: [provideHttpClient()] });
    const spec: FieldSpec = { path: ['type'], label: 'Type', kind: 'text' };
    const fixture = TestBed.createComponent(FormField);
    const data = { name: 'Orc', type: { type: 'humanoid', tags: ['orc'] } };
    fixture.componentRef.setInput('spec', spec);
    fixture.componentRef.setInput('data', data);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('input')).toBeNull();
    expect(el.querySelector('textarea')!.value).toContain('"tags"');
  });
});

describe('entries editor', () => {
  it('classifies entries and keeps unknown properties when editing', () => {
    expect([cardKind('text'), cardKind({ type: 'entries', name: 'A', entries: [] }), cardKind({ type: 'list', items: [] }), cardKind({ type: 'table', rows: [] }), cardKind({ type: 'statblock' })]).toEqual([
      'text',
      'container',
      'list',
      'table',
      'raw',
    ]);
    TestBed.configureTestingModule({ imports: [EntriesEditor], providers: [provideHttpClient()] });
    const fixture = TestBed.createComponent(EntriesEditor);
    const section = { type: 'entries', name: 'Old', entries: ['x'], data: { overwrite: 'Keep me' }, id: 'abc' };
    fixture.componentRef.setInput('entries', ['intro', section]);
    const emitted: unknown[] = [];
    fixture.componentInstance.changed.subscribe((v) => emitted.push(v));
    fixture.detectChanges();
    const heading = (fixture.nativeElement as HTMLElement).querySelector<HTMLInputElement>('input[aria-label=Heading]')!;
    heading.value = 'New';
    heading.dispatchEvent(new Event('change'));
    expect(emitted).toEqual([{ path: [1, 'name'], value: 'New' }]);
    expect(setAt(['intro', section], [1, 'name'], 'New')).toEqual(['intro', { ...section, name: 'New' }]);
  });
});

describe('JSON path ranges', () => {
  it('finds the text of a JSON pointer', () => {
    const text = JSON.stringify({ name: 'X', hp: { average: 7 }, action: [{ name: 'Bite' }, { name: 'Claw' }] }, null, 2);
    const state = EditorState.create({ doc: text, extensions: [json()] });
    const tree = ensureSyntaxTree(state, state.doc.length) ?? syntaxTree(state);
    const at = (p: string) => {
      const r = rangeOfPath(tree, state.doc, p);
      return r ? text.slice(r.from, r.to) : null;
    };
    expect(at('/hp/average')).toBe('7');
    expect(at('/action/1/name')).toBe('"Claw"');
    expect(at('/action/1')).toContain('Claw');
    expect(at('/missing')).toBeNull();
  });
});
