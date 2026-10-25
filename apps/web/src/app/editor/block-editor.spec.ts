import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { Component, signal } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import type { BlockDoc } from '@cn/shared';
import { closeHistory } from '@tiptap/pm/history';
import { NodeSelection, Selection } from '@tiptap/pm/state';
import { describe, expect, it } from 'vitest';
import { BlockEditor } from './block-editor';

// jsdom has no layout: ProseMirror's coordsAtPos and scrollIntoView need rects
const NO_RECT = { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) };
Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect ??= () => NO_RECT as DOMRect;


const para = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text }] });
const DOC = { type: 'doc', schemaVersion: 1, content: [para('One'), para('Two'), para('Three')] } as unknown as BlockDoc;

@Component({ imports: [BlockEditor], template: `<main><cn-block-editor [doc]="doc()" [beforeReveal]="before" [commit]="commit" /></main>` })
class Host {
  commit: (() => Promise<boolean>) | null = null;
  readonly doc = signal<BlockDoc>(DOC);
  before: (() => Promise<void>) | null = null;
}

const settle = () => new Promise<void>((r) => setTimeout(r));

async function mount() {
  TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
  const fixture: ComponentFixture<Host> = TestBed.createComponent(Host);
  document.body.appendChild(fixture.nativeElement);
  fixture.detectChanges();
  await fixture.whenStable();
  const el = fixture.nativeElement as HTMLElement;
  const editor = fixture.debugElement.children[0]!.children[0]!.componentInstance as BlockEditor;
  const texts = () => Array.from(el.querySelectorAll('.tiptap > p')).map((p) => p.textContent);
  const caretIn = async (index: number) => {
    let pos = 0;
    editor.editor.state.doc.forEach((n, offset, i) => (i === index ? (pos = offset + 1) : 0));
    editor.editor.chain().focus().setTextSelection(pos).run();
    // TipTap's focus() finishes on an animation frame: let it, or it would take focus back from the menu
    await new Promise((r) => setTimeout(r, 60));
  };
  const button = () => el.querySelector<HTMLButtonElement>('button[aria-label="Block options"]')!;
  const menu = () => el.querySelector<HTMLElement>('[role="menu"]');
  const items = () => Array.from(el.querySelectorAll<HTMLElement>('[role="menu"] [role^="menuitem"]'));
  const flush = async () => {
    TestBed.tick();
    await fixture.whenStable();
    await settle();
    TestBed.tick();
  };
  const key = (target: Element, k: string, init: KeyboardEventInit = {}) => {
    const event = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init });
    target.dispatchEvent(event);
    return event;
  };
  const choose = async (label: string) => {
    items().find((i) => i.textContent?.includes(label))!.click();
    await flush();
  };
  const status = () => el.querySelector('[role="status"]')!.textContent;
  const load = async (content: object[]) => {
    editor.editor.chain().setMeta('addToHistory', false).setContent({ type: 'doc', content }, { emitUpdate: false }).run();
    await flush();
  };
  const kinds = () => editor.editor.state.doc.children.map((n) => n.type.name);
  /** Puts the selection on top-level block `index`: a node selection for a leaf (rule), else a caret inside it. */
  const select = async (index: number) => {
    const { doc } = editor.editor.state;
    let pos = 0;
    doc.forEach((n, offset, i) => (i === index ? (pos = offset) : 0));
    const node = doc.child(index);
    const sel = node.isLeaf || node.isAtom ? NodeSelection.create(doc, pos) : Selection.near(doc.resolve(pos + 1));
    editor.editor.view.dispatch(editor.editor.state.tr.setSelection(sel));
    editor.editor.view.focus();
    await new Promise((r) => setTimeout(r, 60));
  };
  /** Focus is in the editing area and the selection is a caret in a block or a selected block (never lost). */
  const expectEditorFocused = () => {
    expect(document.activeElement).toBe(editor.editor.view.dom);
    const { selection } = editor.editor.state;
    expect(selection instanceof NodeSelection || selection.$from.parent.inlineContent).toBe(true);
  };
  const act = async (label: string) => {
    key(el.querySelector('.tiptap')!, '.', { ctrlKey: true });
    await flush();
    await choose(label);
  };
  return { fixture, host: fixture.componentInstance, el, editor, texts, caretIn, button, menu, items, flush, key, choose, status, load, kinds, select, expectEditorFocused, act };
}

describe('block options menu (keyboard)', () => {
  it('has a toolbar button that is a menu button and opens the menu for the caret block, focusing the first item', async () => {
    const t = await mount();
    expect(t.button().getAttribute('aria-haspopup')).toBe('menu');
    expect(t.button().getAttribute('aria-expanded')).toBe('false');
    await t.caretIn(1);
    t.button().click();
    await t.flush();
    expect(t.menu()).not.toBeNull();
    expect(t.menu()!.getAttribute('aria-label')).toContain('paragraph');
    expect(t.button().getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(t.items()[0]);
    expect(t.items().every((i) => i.tabIndex === -1)).toBe(true);
  });

  it('opens with Ctrl+. from the editing area', async () => {
    const t = await mount();
    await t.caretIn(0);
    const area = t.el.querySelector('.tiptap')!;
    expect(t.key(area, '.', { ctrlKey: true }).defaultPrevented).toBe(true);
    await t.flush();
    expect(t.menu()).not.toBeNull();
    expect(t.button().getAttribute('aria-expanded')).toBe('false');
  });

  it('moves with arrows (wrapping), Home and End; Esc closes and returns focus to the button; Tab closes', async () => {
    const t = await mount();
    await t.caretIn(1);
    t.button().focus();
    t.button().click();
    await t.flush();
    const items = t.items();
    const menu = t.menu()!;
    t.key(items[0], 'ArrowDown');
    expect(document.activeElement).toBe(items[1]);
    t.key(items[1], 'End');
    expect(document.activeElement).toBe(items[items.length - 1]);
    t.key(items[items.length - 1], 'ArrowDown');
    expect(document.activeElement).toBe(items[0]);
    t.key(items[0], 'ArrowUp');
    expect(document.activeElement).toBe(items[items.length - 1]);
    t.key(items[0], 'Home');
    expect(document.activeElement).toBe(items[0]);
    t.key(menu, 'Escape');
    await t.flush();
    expect(t.menu()).toBeNull();
    expect(document.activeElement).toBe(t.button());

    t.button().click();
    await t.flush();
    t.key(t.menu()!, 'Tab');
    await t.flush();
    expect(t.menu()).toBeNull();
  });

  it('returns focus to the editing area when opened with the shortcut and closed with Esc', async () => {
    const t = await mount();
    await t.caretIn(0);
    t.key(t.el.querySelector('.tiptap')!, '.', { ctrlKey: true });
    await t.flush();
    t.key(t.menu()!, 'Escape');
    await t.flush();
    await new Promise((r) => setTimeout(r, 60));
    expect(document.activeElement).toBe(t.el.querySelector('.tiptap'));
  });

  it('acts on the block with the caret: move down and up, duplicate, delete, and says so', async () => {
    const t = await mount();
    await t.caretIn(0);
    t.button().click();
    await t.flush();
    expect(t.items().some((i) => i.textContent?.includes('Move up'))).toBe(false);
    await t.choose('Move down');
    expect(t.texts()).toEqual(['Two', 'One', 'Three']);
    expect(t.status()).toBe('Block moved down, now 2 of 3');
    expect(t.menu()).toBeNull();

    await t.caretIn(2);
    t.button().click();
    await t.flush();
    expect(t.items().some((i) => i.textContent?.includes('Move down'))).toBe(false);
    await t.choose('Move up');
    expect(t.texts()).toEqual(['Two', 'Three', 'One']);

    // the caret followed the moved block: the next action applies to it
    t.button().click();
    await t.flush();
    await t.choose('Duplicate');
    expect(t.texts()).toEqual(['Two', 'Three', 'Three', 'One']);
    expect(t.status()).toBe('Block duplicated');

    await t.caretIn(0);
    t.button().click();
    await t.flush();
    await t.choose('Delete');
    expect(t.texts()).toEqual(['Three', 'Three', 'One']);
    expect(t.status()).toBe('Block deleted');
  });

  it('turns the caret block into a heading and announces it', async () => {
    const t = await mount();
    await t.caretIn(1);
    t.button().click();
    await t.flush();
    await t.choose('Turn into heading');
    expect(t.el.querySelectorAll('.tiptap h2').length).toBe(1);
    expect(t.el.querySelector('.tiptap h2')!.textContent).toBe('Two');
    expect(t.status()).toBe('Turned into heading');
  });
});

const cell = (t: string) => ({ type: 'tableCell', content: [para(t)] });
const BLOCKS: Record<string, object> = {
  rule: { type: 'horizontalRule' },
  table: { type: 'table', content: [{ type: 'tableRow', content: [cell('Cell')] }] },
  list: { type: 'bulletList', content: [{ type: 'listItem', content: [para('Item')] }] },
  details: { type: 'details', content: [{ type: 'detailsSummary', content: [{ type: 'text', text: 'Sum' }] }, { type: 'detailsContent', content: [para('Body')] }] },
};

describe('block options menu: focus and caret after every action', () => {
  for (const label of ['Duplicate', 'Delete', 'Move down', 'Turn into heading', 'Wrap in callout', 'DM only']) {
    it(`${label} leaves focus in the editing area with a caret in a block`, async () => {
      const t = await mount();
      await t.caretIn(1);
      await t.act(label);
      await new Promise((r) => setTimeout(r, 60));
      t.expectEditorFocused();
    });
  }

  it('Delete on the only block leaves one empty paragraph with the caret in it', async () => {
    const t = await mount();
    await t.load([para('Only')]);
    await t.select(0);
    await t.act('Delete');
    expect(t.kinds()).toEqual(['paragraph']);
    expect(t.editor.editor.state.doc.child(0).content.size).toBe(0);
    t.expectEditorFocused();
  });

  it('Delete in the middle puts the caret at the end of the block before', async () => {
    const t = await mount();
    await t.caretIn(1);
    await t.act('Delete');
    expect(t.editor.editor.state.selection.$from.parent.textContent).toBe('One');
  });
});

describe('block options menu: moving different kinds of block', () => {
  for (const [name, block] of Object.entries(BLOCKS)) {
    it(`moves a ${name} down and up, and the next action applies to it`, async () => {
      const t = await mount();
      await t.load([para('A'), block, para('B')]);
      const kind = (block as { type: string }).type;
      await t.select(1);
      await t.act('Move down');
      expect(t.kinds().slice(0, 3)).toEqual(['paragraph', 'paragraph', kind]);
      t.expectEditorFocused();
      // the selection moved with the block: moving up again restores the order instead of moving B
      await t.act('Move up');
      expect(t.kinds().slice(0, 3)).toEqual(['paragraph', kind, 'paragraph']);
      expect(t.texts().filter(Boolean)).toContain('A');
      await t.act('Move up');
      expect(t.kinds().slice(0, 3)).toEqual([kind, 'paragraph', 'paragraph']);
      t.expectEditorFocused();
    });
  }

  it('adds an empty paragraph in the same transaction when a move leaves a non-text block last (one undo removes both)', async () => {
    const t = await mount();
    await t.load([BLOCKS['table']!, para('A')]);
    expect(t.kinds()).toEqual(['table', 'paragraph']);
    // the loaded content is its own undo step, so one undo takes back only the move
    t.editor.editor.view.dispatch(closeHistory(t.editor.editor.state.tr));
    await t.select(0);
    await t.act('Move down');
    expect(t.kinds()).toEqual(['paragraph', 'table', 'paragraph']);
    t.editor.editor.commands.undo();
    expect(t.kinds()).toEqual(['table', 'paragraph']);
  });

  it('does the same for Duplicate and Wrap', async () => {
    const t = await mount();
    await t.load([para('A'), BLOCKS['rule']!]);
    // StarterKit keeps an empty paragraph after a last non-text block
    expect(t.kinds()).toEqual(['paragraph', 'horizontalRule', 'paragraph']);
    await t.select(1);
    await t.act('Duplicate');
    expect(t.kinds()).toEqual(['paragraph', 'horizontalRule', 'horizontalRule', 'paragraph']);
    await t.load([para('A')]);
    await t.select(0);
    await t.act('Wrap in callout');
    expect(t.kinds()).toEqual(['callout', 'paragraph']);
  });

  it('does not open for Ctrl+. while the suggestion popup is open', async () => {
    const t = await mount();
    await t.caretIn(0);
    const area = t.el.querySelector('.tiptap')!;
    area.setAttribute('aria-expanded', 'true');
    t.key(area, '.', { ctrlKey: true });
    await t.flush();
    expect(t.menu()).toBeNull();
  });

  it('clears the announcement after a few seconds', async () => {
    const t = await mount();
    await t.caretIn(0);
    await t.act('Duplicate');
    expect(t.status()).toBe('Block duplicated');
    await new Promise((r) => setTimeout(r, 3100));
    await t.flush();
    expect(t.status()).toBe('');
  }, 10000);
});

describe('Reveal now', () => {
  const withId = (id: string, text: string) => ({ ...para(text), attrs: { id } });
  const secret = (revealed = false) => ({ type: 'secret', attrs: { id: 's1', revealed }, content: [withId('c1', 'Hidden'), withId('c2', 'Also hidden')] });
  const ids = (node: { attrs?: { id?: string }; content?: unknown[] }): string[] => [
    ...(node.attrs?.id ? [node.attrs.id] : []),
    ...((node.content ?? []) as (typeof node)[]).flatMap(ids),
  ];
  const labels = (t: Awaited<ReturnType<typeof mount>>) => t.items().map((i) => i.textContent?.trim());
  const openMenu = async (t: Awaited<ReturnType<typeof mount>>, index: number) => {
    await t.select(index);
    t.key(t.el.querySelector('.tiptap')!, '.', { ctrlKey: true });
    await t.flush();
  };

  it('reveals a secret in one click, keeps every block id (children too) and asks the host to save now', async () => {
    const t = await mount();
    await t.load([secret(), withId('p9', 'After')]);
    const before = ids(t.editor.editor.getJSON() as never);
    expect(before.sort()).toEqual(['c1', 'c2', 'p9', 's1']);
    const docs: BlockDoc[] = [];
    let saves = 0;
    t.editor.changed.subscribe((d) => docs.push(d));
    t.editor.saveNow.subscribe(() => saves++);
    await t.select(0);
    await t.act('Reveal now');
    expect(saves).toBe(1);
    const saved = docs.at(-1) as unknown as { content: { attrs: { revealed: boolean } }[] };
    expect(saved.content[0]!.attrs.revealed).toBe(true);
    expect(ids(saved as never).sort()).toEqual(before);
    expect(t.status()).toBe('Revealed to players');
    expect(t.el.querySelector('.cn-reveal-notice')!.textContent).toContain('Revealed to players');
  });

  it('is offered for a hidden secret and a hidden DM-only block, with help text naming the same-save gap', async () => {
    const t = await mount();
    const dm = { ...withId('d1', 'Dm'), attrs: { id: 'd1', visibility: 'dm', revealed: false } };
    await t.load([para('Plain'), dm, secret()]);
    await openMenu(t, 0);
    expect(labels(t)).not.toContain('Reveal now');
    t.key(t.menu()!, 'Escape');
    await t.flush();
    await openMenu(t, 1);
    expect(t.items().find((i) => i.textContent?.includes('Reveal now'))!.getAttribute('title')).toContain('same save');
    t.key(t.menu()!, 'Escape');
    await t.flush();
    await openMenu(t, 2);
    expect(labels(t)).toContain('Reveal now');
  });

  it('is not offered once revealed', async () => {
    const t = await mount();
    await t.load([secret(true), para('After')]);
    await openMenu(t, 0);
    expect(labels(t)).not.toContain('Reveal now');
  });

  it('Undo hides it again with another save, ids unchanged', async () => {
    const t = await mount();
    await t.load([secret(), withId('p9', 'After')]);
    let saves = 0;
    t.editor.saveNow.subscribe(() => saves++);
    await t.select(0);
    await t.act('Reveal now');
    t.el.querySelector<HTMLButtonElement>('.cn-reveal-notice button')!.click();
    await t.flush();
    expect((t.editor.editor.getJSON().content![0]!.attrs as { revealed: boolean }).revealed).toBe(false);
    expect(ids(t.editor.editor.getJSON() as never).sort()).toEqual(['c1', 'c2', 'p9', 's1']);
    expect(saves).toBe(2);
    expect(t.el.querySelector('.cn-reveal-notice')).toBeNull();
  });

  it('a failed save reverts the local reveal and says so in plain sight', async () => {
    const t = await mount();
    t.host.commit = async () => false;
    t.fixture.changeDetectorRef.detectChanges();
    await t.load([secret(), withId('p9', 'After')]);
    await t.select(0);
    await t.act('Reveal now');
    expect((t.editor.editor.getJSON().content![0]!.attrs as { revealed: boolean }).revealed).toBe(false);
    const notice = t.el.querySelector('.cn-reveal-notice')!;
    expect(notice.textContent).toContain('Not saved');
    expect(notice.textContent).not.toContain('Revealed to players');
    expect(notice.querySelector('[role="alert"]')).not.toBeNull();
    // Announced once: by the alert, not also by the polite status line
    expect(t.status()).toBe('');
    // The menu offers Reveal now again, as the server still has it hidden
    await openMenu(t, 0);
    expect(labels(t)).toContain('Reveal now');
  });

  it('saves pending edits first, then the reveal', async () => {
    const t = await mount();
    const order: string[] = [];
    t.host.before = async () => void order.push('flush');
    t.fixture.changeDetectorRef.detectChanges();
    await t.load([secret(), withId('p9', 'After')]);
    t.editor.saveNow.subscribe(() => order.push('reveal'));
    await t.select(0);
    await t.act('Reveal now');
    expect(order).toEqual(['flush', 'reveal']);
  });
});

