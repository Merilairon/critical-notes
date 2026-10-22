import { clampLevel, fixHeadingLevels, watchHeadingLevels } from './heading-levels';

describe('heading levels', () => {
  afterEach(() => document.body.replaceChildren());

  it('never goes more than one level below the previous heading', () => {
    expect(clampLevel(3, 1)).toBe(2);
    expect(clampLevel(3, 2)).toBe(3);
    expect(clampLevel(2, 4)).toBe(2);
    expect(clampLevel(4, 1)).toBe(2);
  });

  it('counts the page h1 before the root, only changes headings inside it, and is idempotent', () => {
    const mk = (tag: string, t: string) => Object.assign(document.createElement(tag), { textContent: t });
    const root = document.createElement('div');
    root.append(mk('h4', 'A'), mk('h5', 'B'), mk('h3', 'C'), mk('h5', 'D'));
    document.body.append(mk('h1', 'Page'), root);
    fixHeadingLevels(root);
    fixHeadingLevels(root);
    expect([...root.children].map((h) => h.getAttribute('aria-level'))).toEqual(['2', '3', null, '4']);
    expect(document.querySelector('h1')!.hasAttribute('aria-level')).toBe(false);
    // content changes: a level that is no longer a skip loses its aria-level
    root.firstElementChild!.remove();
    fixHeadingLevels(root);
    expect([...root.children].map((h) => h.getAttribute('aria-level'))).toEqual(['2', null, '4']);
  });

  const mk = (tag: string, t: string) => Object.assign(document.createElement(tag), { textContent: t });
  const frame = () => new Promise<void>((r) => setTimeout(r, 60));

  it('starts at level 1 when no heading precedes (no h1 on the page, e.g. the template editor)', () => {
    const root = document.createElement('div');
    root.append(mk('h3', 'A'), mk('h4', 'B'));
    document.body.append(root);
    fixHeadingLevels(root);
    expect([...root.children].map((h) => h.getAttribute('aria-level'))).toEqual(['2', '3']);
  });

  it('ignores hidden headings when working out the previous level', () => {
    const root = document.createElement('div');
    const hidden = mk('h2', 'Hidden');
    hidden.hidden = true;
    root.append(mk('h2', 'A'), hidden, mk('h3', 'B'));
    document.body.append(root);
    fixHeadingLevels(root);
    expect(root.children[2]!.hasAttribute('aria-level')).toBe(false);
  });

  it('re-levels when the page h1 renders later, with one shared watcher for several roots', async () => {
    const a = document.createElement('div');
    const b = document.createElement('div');
    a.append(mk('h4', 'A'));
    b.append(mk('h4', 'B'));
    document.body.append(a, b);
    const stopA = watchHeadingLevels(a);
    const stopB = watchHeadingLevels(b);
    await frame();
    // A: 4 -> 2; B follows A (level 2) so 4 -> 3
    expect([a, b].map((r) => r.firstElementChild!.getAttribute('aria-level'))).toEqual(['2', '3']);
    document.body.prepend(mk('h1', 'Page'));
    a.firstElementChild!.replaceWith(mk('h2', 'A2'));
    await frame();
    expect(b.firstElementChild!.getAttribute('aria-level')).toBe('3');
    stopA();
    stopB();
    expect(a.hasAttribute('data-cn-levels')).toBe(false);
  });
});
