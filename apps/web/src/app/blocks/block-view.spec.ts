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
