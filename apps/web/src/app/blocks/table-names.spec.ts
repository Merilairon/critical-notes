import { Editor } from '@tiptap/core';
import { Table, TableCell, TableHeader, TableRow } from '@tiptap/extension-table';
import StarterKit from '@tiptap/starter-kit';
import { TableNames } from './table-names';

function makeEditor(scope: string, content: object) {
  const el = document.createElement('div');
  document.body.append(el);
  const editor = new Editor({
    element: el,
    extensions: [StarterKit, Table.configure({ resizable: false }), TableRow, TableHeader, TableCell, TableNames.configure({ scope })],
    content,
  });
  return { editor, el };
}
const cell = { type: 'tableCell', content: [{ type: 'paragraph' }] };
const table = { type: 'table', content: [{ type: 'tableRow', content: [cell] }] };
const heading = (t: string) => ({ type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: t }] });
const nameOf = (t: Element) => document.getElementById(t.getAttribute('aria-labelledby') ?? '')?.textContent ?? null;

describe('table names in the editor', () => {
  afterEach(() => document.body.replaceChildren());

  it('names tables from the heading above and keeps working after edits', () => {
    const { editor, el } = makeEditor('t1', { type: 'doc', content: [table, heading('Treasure'), table] });
    let tables = [...el.querySelectorAll('table')];
    expect(tables.map(nameOf)).toEqual([null, 'Treasure']);
    editor.commands.insertContentAt(0, heading('Intro'));
    tables = [...el.querySelectorAll('table')];
    expect(tables.map(nameOf)).toEqual(['Intro', 'Treasure']);
    // the ids are decorations, never saved in the document
    expect(JSON.stringify(editor.getJSON())).not.toContain('t1-');
    editor.destroy();
  });

  it('uses unique ids per editor instance', () => {
    const a = makeEditor('t2', { type: 'doc', content: [heading('A'), table] });
    const b = makeEditor('t3', { type: 'doc', content: [heading('B'), table] });
    const ids = [...document.querySelectorAll('h2')].map((h) => h.id);
    expect(new Set(ids).size).toBe(2);
    expect(nameOf(a.el.querySelector('table')!)).toBe('A');
    expect(nameOf(b.el.querySelector('table')!)).toBe('B');
    a.editor.destroy();
    b.editor.destroy();
  });

  it('exposes heading levels that never skip below the page h1, without changing the document', () => {
    const lvl = (level: number, t: string) => ({ type: 'heading', attrs: { level }, content: [{ type: 'text', text: t }] });
    const { editor, el } = makeEditor('t4', { type: 'doc', content: [lvl(3, 'A'), lvl(4, 'B'), lvl(2, 'C'), lvl(4, 'D')] });
    // page h1 -> h3 becomes 2; h4 after it becomes 3; h2 stays; h4 after h2 becomes 3
    expect([...el.querySelectorAll('h1,h2,h3,h4')].map((h) => h.getAttribute('aria-level'))).toEqual(['2', '3', null, '3']);
    expect(JSON.stringify(editor.getJSON())).not.toContain('aria-level');
    editor.destroy();
  });
});
