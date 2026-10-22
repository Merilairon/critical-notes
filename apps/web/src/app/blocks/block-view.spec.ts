import { provideHttpClient } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { BlockView, type ViewNode } from './block-view';

const text = (t: string, marks?: ViewNode['marks']): ViewNode => ({ type: 'text', text: t, ...(marks ? { marks } : {}) });
const para = (...content: ViewNode[]): ViewNode => ({ type: 'paragraph', content });

function render(content: ViewNode[]): HTMLElement {
  TestBed.configureTestingModule({ imports: [BlockView], providers: [provideRouter([]), provideHttpClient()] });
  const fixture = TestBed.createComponent(BlockView);
  fixture.componentRef.setInput('doc', { type: 'doc', content });
  fixture.detectChanges();
  return fixture.nativeElement as HTMLElement;
}

describe('BlockView', () => {
  it('renders text blocks, marks, inline tags and page links', () => {
    const el = render([
      { type: 'heading', attrs: { level: 2 }, content: [text('Phandalin')] },
      para(text('A '), text('quiet', [{ type: 'bold' }]), text(' town. Cast '), { type: 'tag', attrs: { markup: '{@spell light}' } }, text('. See '), {
        type: 'pageLink',
        attrs: { pageId: 'p1', label: 'Stonehill Inn' },
      }),
      { type: 'bulletList', content: [{ type: 'listItem', content: [para(text('one'))] }, { type: 'listItem', content: [para(text('two'))] }] },
    ]);
    expect(el.querySelector('h3')!.textContent!.trim()).toBe('Phandalin');
    expect(el.querySelector('.cn-s-bold')!.textContent).toBe('quiet');
    expect(el.querySelector('a.cn-link')!.textContent).toBe('light');
    expect(el.querySelector('a.cn-page-link')!.textContent).toBe('Stonehill Inn');
    expect(el.querySelectorAll('li')).toHaveLength(2);
  });

  it('never turns content into markup or unsafe links', () => {
    const el = render([para(text('<img src=x onerror=alert(1)>'), text('click', [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }]))]);
    expect(el.querySelector('img')).toBeNull();
    expect(el.querySelector('a')).toBeNull();
    expect(el.textContent).toContain('<img src=x onerror=alert(1)>click');
  });

  it('labels unrevealed secrets, hides the label once revealed, and shows unknown blocks as placeholders', () => {
    const el = render([
      { type: 'secret', attrs: { revealed: false }, content: [para(text('Glasstaff is Iarno'))] },
      { type: 'secret', attrs: { revealed: true }, content: [para(text('The map is in the desk'))] },
      { type: 'unknownBlock', attrs: { raw: { type: 'hologram' } } },
    ]);
    const secrets = el.querySelectorAll('.cn-secret');
    expect(secrets[0]!.querySelector('.cn-secret-head')).not.toBeNull();
    expect(secrets[1]!.querySelector('.cn-secret-head')).toBeNull();
    expect(el.querySelector('.cn-unsupported')!.textContent).toContain('unknownBlock');
  });

  it('renders layout blocks: columns, collapsible sections and tabs', () => {
    const el = render([
      { type: 'columns', content: [{ type: 'column', content: [para(text('left'))] }, { type: 'column', content: [para(text('right'))] }] },
      { type: 'details', attrs: { open: false }, content: [{ type: 'detailsSummary', content: [text('More')] }, { type: 'detailsContent', content: [para(text('hidden detail'))] }] },
      { type: 'tabs', content: [{ type: 'tab', attrs: { title: 'Day' }, content: [para(text('sunny'))] }, { type: 'tab', attrs: { title: 'Night' }, content: [para(text('dark'))] }] },
    ]);
    expect(el.querySelector('.cn-columns')!.children).toHaveLength(2);
    expect(el.querySelector('summary')!.textContent!.trim()).toBe('More');
    const tabs = el.querySelectorAll<HTMLButtonElement>('[role=tab]');
    expect([...tabs].map((t) => t.textContent!.trim())).toEqual(['Day', 'Night']);
    expect(el.querySelector('[role=tabpanel]')!.textContent).toContain('sunny');
  });
});

describe('table names', () => {
  const cell = (t: string): ViewNode => ({ type: 'tableCell', content: [para(text(t))] });
  const table = (): ViewNode => ({ type: 'table', content: [{ type: 'tableRow', content: [cell('a'), cell('b')] }] });
  const h = (level: number, t: string): ViewNode => ({ type: 'heading', attrs: { level }, content: [text(t)] });
  const nameOf = (t: Element) => {
    const id = t.getAttribute('aria-labelledby');
    return id ? document.getElementById(id)?.textContent?.trim() ?? null : null;
  };
  // The heading-level pass runs once per animation frame (setTimeout fallback of 16 ms): wait past it
  const frame = () => new Promise<void>((r) => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(() => r()) : setTimeout(r, 16)));
  const settle = async () => {
    await frame();
    await frame();
    await new Promise<void>((r) => setTimeout(r, 20));
  };

  it('names a table after the nearest heading above it, and leaves an unheaded table unnamed', async () => {
    const el = render([table(), h(1, 'Loot'), table(), para(text('x')), h(2, 'Prices'), table()]);
    document.body.append(el);
    await settle();
    const tables = [...el.querySelectorAll('table')];
    expect(tables.map(nameOf)).toEqual([null, 'Loot', 'Prices']);
    expect(tables[0]!.hasAttribute('aria-labelledby')).toBe(false);
    el.remove();
  });

  it("uses only the headings of its own rendered document (the server leaves DM-only blocks out of a player's document)", async () => {
    const player = render([h(1, 'Market'), table()]);
    document.body.append(player);
    await settle();
    expect(nameOf(player.querySelector('table')!)).toBe('Market');
    expect(player.textContent).not.toContain('Secret stock');
    player.remove();
  });

  it('keeps ids unique across views on one page and ignores empty headings', async () => {
    const a = render([h(1, 'One'), table()]);
    document.body.append(a);
    TestBed.resetTestingModule();
    const b = render([h(1, 'Two'), table(), { type: 'heading', attrs: { level: 1 }, content: [] }, table()]);
    document.body.append(b);
    await settle();
    const ids = [...document.querySelectorAll('h2')].map((x) => x.id).filter(Boolean);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...b.querySelectorAll('table')].map(nameOf)).toEqual(['Two', null]);
    a.remove();
    b.remove();
  });

  it('keeps ids unique and names right when a heading appears mid-view', async () => {
    TestBed.configureTestingModule({ imports: [BlockView], providers: [provideRouter([]), provideHttpClient()] });
    const fixture = TestBed.createComponent(BlockView);
    fixture.componentRef.setInput('doc', { type: 'doc', content: [h(1, 'A'), table(), h(1, 'B'), table()] });
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    document.body.append(el);
    await settle();
    fixture.componentRef.setInput('doc', { type: 'doc', content: [h(1, 'A'), table(), h(1, 'X'), table(), h(1, 'B'), table()] });
    fixture.detectChanges();
    await settle();
    const ids = [...el.querySelectorAll('h2')].map((x) => x.id);
    expect(new Set(ids).size).toBe(3);
    expect([...el.querySelectorAll('table')].map(nameOf)).toEqual(['A', 'X', 'B']);
    el.remove();
  });

  it('keeps heading tags but exposes levels that do not skip after the page h1', async () => {
    TestBed.configureTestingModule({ imports: [BlockView], providers: [provideRouter([]), provideHttpClient()] });
    const host = document.createElement('div');
    host.append(Object.assign(document.createElement('h1'), { textContent: 'Page' }));
    document.body.append(host);
    const fixture = TestBed.createComponent(BlockView);
    host.append(fixture.nativeElement);
    fixture.componentRef.setInput('doc', { type: 'doc', content: [h(2, 'Sub'), h(3, 'Subsub')] });
    fixture.detectChanges();
    await settle();
    const hs = [...host.querySelectorAll('h3,h4')];
    expect(hs.map((x) => x.tagName)).toEqual(['H3', 'H4']);
    expect(hs.map((x) => x.getAttribute('aria-level'))).toEqual(['2', '3']);
    host.remove();
  });
});
