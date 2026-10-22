import { Editor, Extension } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Suggestion, { type SuggestionKeyDownProps, type SuggestionProps } from '@tiptap/suggestion';
import { createPopupRenderer, resultsStatus, type SuggestionItem } from './popup';

const item = (title: string, run = vi.fn()): SuggestionItem => ({ title, run });

function start(items: SuggestionItem[]) {
  const field = document.createElement('div');
  field.setAttribute('contenteditable', 'true');
  field.setAttribute('role', 'textbox');
  document.body.append(field);
  const props = { items, editor: { view: { dom: field } }, clientRect: null } as unknown as SuggestionProps<SuggestionItem>;
  const popup = createPopupRenderer()();
  popup.onStart(props);
  const key = (k: string) => popup.onKeyDown({ event: new KeyboardEvent('keydown', { key: k }) } as SuggestionKeyDownProps);
  return { field, props, popup, key };
}

describe('suggestion popup accessibility', () => {
  beforeAll(() => {
    Element.prototype.scrollIntoView = () => undefined;
  });
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    document.body.replaceChildren();
  });

  it('wires the editing area to a listbox of uniquely identified options', () => {
    const { field } = start([item('Text'), item('Heading')]);
    const list = document.querySelector('[role=listbox]')!;
    const options = [...list.querySelectorAll('[role=option]')];
    expect(options).toHaveLength(2);
    expect(new Set(options.map((o) => o.id)).size).toBe(2);
    expect(field.getAttribute('role')).toBe('combobox');
    expect(field.getAttribute('aria-expanded')).toBe('true');
    expect(field.getAttribute('aria-controls')).toBe(list.id);
    expect(field.getAttribute('aria-activedescendant')).toBe(options[0]!.id);
    expect(options[0]!.getAttribute('aria-selected')).toBe('true');
  });

  it('moves aria-activedescendant with the arrow keys and keeps Enter working', () => {
    const run = vi.fn();
    const { field, key } = start([item('Text'), item('Heading', run)]);
    expect(key('ArrowDown')).toBe(true);
    const options = [...document.querySelectorAll('[role=option]')];
    expect(field.getAttribute('aria-activedescendant')).toBe(options[1]!.id);
    expect(options[1]!.getAttribute('aria-selected')).toBe('true');
    key('Enter');
    expect(run).toHaveBeenCalled();
  });

  it('says how many results there are, politely', () => {
    const { popup, props } = start([item('Text'), item('Heading')]);
    const status = document.querySelector('[role=status]')!;
    expect(status.textContent).toBe('');
    vi.advanceTimersByTime(60);
    expect(status.textContent).toBe(resultsStatus(2));
    popup.onUpdate({ ...props, items: [] });
    vi.advanceTimersByTime(60);
    expect(status.textContent).toBe('No results');
    expect(document.querySelector('[role=listbox]')).toBeNull();
    popup.onUpdate({ ...props, items: [item('Only')] });
    expect(status.textContent).toContain('1 result.');
  });

  it('puts the editing area back as it was when the popup closes', () => {
    const { field, popup, key } = start([item('Text')]);
    key('Escape');
    expect(field.getAttribute('role')).toBe('textbox');
    for (const a of ['aria-expanded', 'aria-controls', 'aria-activedescendant']) expect(field.hasAttribute(a)).toBe(false);
    expect(document.querySelector('.cn-suggest')).toBeNull();
    popup.onExit();
    expect(document.querySelector('[role=status]')).toBeNull();
  });

  it('stops swallowing keys after Escape and does not reopen on later updates', () => {
    const run = vi.fn();
    const { popup, props, key, field } = start([item('Text', run)]);
    key('Escape');
    expect(key('ArrowDown')).toBe(false);
    expect(key('Enter')).toBe(false);
    popup.onUpdate({ ...props, items: [item('More')] });
    expect(document.querySelector('.cn-suggest')).toBeNull();
    expect(field.getAttribute('role')).toBe('textbox');
    expect(run).not.toHaveBeenCalled();
    popup.onStart(props);
    expect(document.querySelector('[role=listbox]')).not.toBeNull();
  });

  it('keeps aria-multiline while it is a combobox and removes it afterwards', () => {
    const { field, popup } = start([item('Text')]);
    expect(field.getAttribute('aria-multiline')).toBe('true');
    popup.onExit();
    expect(field.hasAttribute('aria-multiline')).toBe(false);
  });

  it('is removed when the editor is destroyed with the popup open', () => {
    const field = document.createElement('div');
    const main = document.createElement('main');
    main.append(field);
    document.body.append(main);
    const editor = new Editor({
      element: field,
      extensions: [
        StarterKit,
        Extension.create({
          name: 'sug',
          addProseMirrorPlugins() {
            return [Suggestion({ editor: this.editor, char: '/', items: () => [item('Text')], render: createPopupRenderer() })];
          },
        }),
      ],
    });
    editor.commands.insertContent('/');
    expect(main.querySelector('.cn-suggest')).not.toBeNull();
    editor.destroy();
    expect(main.querySelector('.cn-suggest')).toBeNull();
    expect(main.querySelector('[role=status]')).toBeNull();
  });
});
