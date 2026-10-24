import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { PageSummaryDto, PropertyDefDto, QueryRowDto } from '@cn/shared';
import { CampaignStore } from '../../campaign/campaign.store';
import { QueryResults } from './query-results';

const row = (id: string, title: string, extra: Partial<QueryRowDto> = {}): QueryRowDto => ({
  id,
  parentId: null,
  sortKey: id,
  type: 'npc',
  title,
  icon: null,
  visibility: 'all',
  updatedAt: Date.UTC(2026, 9, 12, 12),
  createdAt: Date.UTC(2026, 0, 3, 12),
  tags: [],
  facet: null,
  props: {},
  ...extra,
});
const mood: PropertyDefDto = { id: 'm', key: 'mood', label: 'Mood', type: 'text', options: null, appliesTo: null, dmOnly: false, refKind: null };
const secret: PropertyDefDto = { ...mood, id: 's', key: 'secret', label: 'Secret', dmOnly: true };

interface Setup {
  rows?: QueryRowDto[];
  view?: unknown;
  columns?: unknown;
  filter?: unknown;
  title?: string;
  loading?: boolean;
  busy?: boolean;
  error?: boolean;
  editing?: boolean;
  isGm?: boolean;
  props?: PropertyDefDto[];
  pages?: PageSummaryDto[];
}

function mount(o: Setup = {}) {
  const pages = o.pages ?? [];
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideRouter([]),
      { provide: CampaignStore, useValue: { id: signal('c1'), isGm: signal(o.isGm ?? true), propertyDefs: signal(o.props ?? [mood, secret]), byId: signal(new Map(pages.map((p) => [p.id, p]))) } },
    ],
  });
  const fixture = TestBed.createComponent(QueryResults);
  const set = (inputs: Setup) => {
    for (const [k, v] of Object.entries(inputs)) if (['rows', 'view', 'columns', 'filter', 'title', 'loading', 'busy', 'error', 'editing'].includes(k)) fixture.componentRef.setInput(k, v);
  };
  set({ rows: [], ...o });
  const retry = vi.fn();
  fixture.componentInstance.retry.subscribe(retry);
  fixture.detectChanges();
  const el = fixture.nativeElement as HTMLElement;
  return { fixture, el, set, retry, update: (i: Setup) => { set(i); fixture.detectChanges(); } };
}

const heads = (el: HTMLElement) => Array.from(el.querySelectorAll('thead th')).map((th) => th.textContent!.replace(/[▲▼]/g, '').trim());
const bodyRow = (el: HTMLElement, i: number) => Array.from(el.querySelectorAll('tbody tr')[i]!.children).map((c) => c.textContent!.replace(/\s+/g, ' ').trim());
const order = (el: HTMLElement) => Array.from(el.querySelectorAll('tbody tr th a')).map((a) => a.lastChild!.textContent!.trim());

describe('QueryResults: list', () => {
  it('renders an old block (no view, no columns) as the list of today, with a label and a count', () => {
    const { el } = mount({ rows: [row('a', 'Sildar'), row('b', 'Gundren')], view: undefined, columns: undefined, title: 'NPCs here' });
    const ul = el.querySelector('ul.cn-query-results')!;
    expect(ul.getAttribute('aria-label')).toBe('NPCs here');
    const items = Array.from(ul.querySelectorAll('li')).map((li) => li.textContent!.trim());
    expect(items[0]).toMatch(/Sildar$/);
    expect(items[1]).toMatch(/Gundren$/);
    expect(el.querySelector('table')).toBeNull();
    expect(el.querySelector('[role=status]')!.textContent).toBe('2 pages.');
  });

  it('says "1 page" and notes a cut-off list at the limit', () => {
    expect(mount({ rows: [row('a', 'A')] }).el.querySelector('[role=status]')!.textContent).toBe('1 page.');
    const { el } = mount({ rows: [row('a', 'A'), row('b', 'B')], filter: { types: [], limit: 2 } });
    expect(el.querySelector('[role=status]')!.textContent).toContain('Showing the first 2. Narrow the filters to see others.');
  });
});

describe('QueryResults: states', () => {
  it('shows loading, error with a working retry, and empty with different words', () => {
    const loading = mount({ loading: true, busy: true });
    expect(loading.el.textContent).toContain('Loading pages...');
    expect(loading.fixture.nativeElement.getAttribute('aria-busy')).toBe('true');
    expect(loading.el.querySelector('table')).toBeNull();

    const failed = mount({ error: true });
    const alert = failed.el.querySelector('[role=alert]')!;
    expect(alert.textContent).toContain('Could not load these pages.');
    expect(failed.el.textContent).not.toContain('No matching pages');
    alert.querySelector('button')!.click();
    expect(failed.retry).toHaveBeenCalledOnce();

    const empty = mount({ rows: [], view: 'table' });
    expect(empty.el.textContent).toContain('No matching pages.');
    expect(empty.el.textContent).not.toContain('Configure');
    expect(empty.el.querySelector('table')).toBeNull();
    expect(mount({ rows: [], editing: true }).el.textContent).toContain('Change the filters in Configure.');
  });

  it('keeps the old rows and only sets aria-busy while reloading', () => {
    const { el, fixture } = mount({ rows: [row('a', 'Sildar')], busy: true, loading: false, view: 'table' });
    expect(fixture.nativeElement.getAttribute('aria-busy')).toBe('true');
    expect(el.querySelector('table')).not.toBeNull();
  });
});

describe('QueryResults: table', () => {
  const rows = [
    row('a', 'Sildar', { facet: { status: 'alive', factionPageId: 'f1' }, props: { mood: 'calm' } }),
    row('b', 'Gundren', { facet: { status: 'missing', factionPageId: 'hidden' }, props: {} }),
    row('c', 'Nezznar', { facet: { status: 'alive' }, props: { mood: 'angry' } }),
  ];
  const pages = [{ id: 'f1', title: 'Lords Alliance' } as PageSummaryDto];

  it('is a real table: caption, column and row headers, title first and not in the columns', () => {
    const { el } = mount({ rows, pages, view: 'table', title: 'NPCs in Neverwinter', columns: ['facet.status', 'prop.mood', 'facet.factionPageId', 'title'] });
    expect(el.querySelector('caption')!.textContent).toBe('NPCs in Neverwinter');
    expect(el.querySelector('table')!.hasAttribute('aria-label')).toBe(false);
    expect(heads(el)).toEqual(['Title', 'Status', 'Mood', 'Faction']);
    expect(el.querySelectorAll('thead th[scope=col]')).toHaveLength(4);
    expect(el.querySelectorAll('tbody th[scope=row]')).toHaveLength(3);
    expect(bodyRow(el, 0)).toEqual(['🧑NPC: Sildar', 'Alive', 'calm', 'Lords Alliance']);
    // A linked page the viewer cannot see is the empty cell, never the id
    expect(bodyRow(el, 1)[3]).toContain('empty');
    expect(el.textContent).not.toContain('hidden');
    const wrap = el.querySelector('.cn-table-wrap')!;
    expect(wrap.getAttribute('aria-label')).toBe('Scrollable table');
    expect(wrap.getAttribute('role')).toBe('region');
    expect(wrap.getAttribute('tabindex')).toBe('0');
  });

  it('labels an untitled table and uses a visible type column instead of hidden type text', () => {
    const { el } = mount({ rows, view: 'table', columns: ['type'] });
    expect(el.querySelector('table')!.getAttribute('aria-label')).toBe('Query results');
    expect(el.querySelector('caption')).toBeNull();
    expect(el.querySelector('.cn-table-wrap')!.getAttribute('aria-label')).toBe('Scrollable table');
    expect(el.querySelector('tbody th .sr-only')).toBeNull();
  });

  it('uses the defaults when no column is chosen, and follows the type filter', () => {
    const { el } = mount({ rows, view: 'table', columns: [], filter: { types: ['npc'] } });
    expect(heads(el)).toEqual(['Title', 'Role', 'Status', 'Attitude', 'Updated']);
    const generic = mount({ rows, view: 'table' });
    expect(heads(generic.el)).toEqual(['Title', 'Type', 'Updated']);
  });

  it('renders no column for keys that do not resolve, and never wipes the table', () => {
    const { el } = mount({ rows, view: 'table', columns: ['prop.removed', 'facet.status', 'facet.status'] });
    expect(heads(el)).toEqual(['Title', 'Status']);
    const none = mount({ rows, view: 'table', columns: ['prop.removed'] });
    expect(heads(none.el)).toEqual(['Title']);
    expect(none.el.querySelectorAll('tbody tr')).toHaveLength(3);
  });

  it('does not show a DM-only column to a player even if its key is in the block', () => {
    const { el } = mount({ rows, view: 'table', columns: ['prop.secret', 'facet.statblockUid', 'prop.mood'], isGm: false, props: [mood] });
    expect(heads(el)).toEqual(['Title', 'Mood']);
  });

  it('sorts from the header: ascending, descending, then back to the server order, with aria-sort on one header', () => {
    const { el, fixture } = mount({ rows, view: 'table', columns: ['facet.status', 'prop.mood'] });
    const sortBtn = (name: string) => Array.from(el.querySelectorAll<HTMLButtonElement>('thead button')).find((b) => b.textContent!.trim().startsWith(name))!;
    const sorted = () => Array.from(el.querySelectorAll('thead th[aria-sort]')).map((th) => `${th.textContent!.replace(/[▲▼]/g, '').trim()}:${th.getAttribute('aria-sort')}`);
    expect(order(el)).toEqual(['Sildar', 'Gundren', 'Nezznar']);
    sortBtn('Mood').click();
    fixture.detectChanges();
    expect(order(el)).toEqual(['Nezznar', 'Sildar', 'Gundren']); // angry, calm, empty last
    expect(sorted()).toEqual(['Mood:ascending']);
    expect(el.querySelector('[role=status]')!.textContent).toContain('Sorted by Mood, ascending.');
    sortBtn('Mood').click();
    fixture.detectChanges();
    expect(order(el)).toEqual(['Sildar', 'Nezznar', 'Gundren']); // empty stays last
    expect(sorted()).toEqual(['Mood:descending']);
    sortBtn('Status').click();
    fixture.detectChanges();
    expect(sorted()).toEqual(['Status:ascending']);
    sortBtn('Status').click();
    sortBtn('Status').click();
    fixture.detectChanges();
    expect(order(el)).toEqual(['Sildar', 'Gundren', 'Nezznar']);
    // Back to the saved default sort (the title), which is what the header shows
    expect(sorted()).toEqual(['Title:ascending']);
    expect(el.querySelector('[role=status]')!.textContent).not.toContain('Sorted');
  });

  it('marks the saved default sort in the header and starts a click on it with the opposite direction', () => {
    const { el, fixture } = mount({ rows, view: 'table', columns: ['facet.status'], filter: { types: [], sort: { field: 'title', dir: 'asc' }, limit: 100 } });
    expect(el.querySelector('thead th[aria-sort]')!.getAttribute('aria-sort')).toBe('ascending');
    el.querySelector<HTMLButtonElement>('thead th button')!.click();
    fixture.detectChanges();
    expect(order(el)).toEqual(['Sildar', 'Nezznar', 'Gundren']);
    expect(el.querySelector('thead th[aria-sort]')!.getAttribute('aria-sort')).toBe('descending');
  });

  it('puts numbers on the right, numerically sorted', () => {
    const pcs = [row('a', 'A', { type: 'pc', facet: { hpMax: 9 } }), row('b', 'B', { type: 'pc', facet: { hpMax: 10 } })];
    const { el, fixture } = mount({ rows: pcs, view: 'table', columns: ['facet.hpMax'] });
    expect(el.querySelector('tbody td')!.classList.contains('cn-num')).toBe(true);
    const btn = el.querySelectorAll<HTMLButtonElement>('thead button')[1]!;
    btn.click();
    btn.click();
    fixture.detectChanges();
    expect(order(el)).toEqual(['B', 'A']);
  });

  it('never renders cell text as markup', () => {
    const { el } = mount({ rows: [row('a', '<img src=x onerror=alert(1)>', { props: { mood: '<b>hi</b>' } })], view: 'table', columns: ['prop.mood'] });
    expect(el.querySelector('img')).toBeNull();
    expect(el.querySelector('b')).toBeNull();
    expect(el.textContent).toContain('<b>hi</b>');
  });
});

describe('QueryResults: cards', () => {
  it('is a labelled list of cards with the title link first and the columns as term/description pairs', () => {
    const { el } = mount({ rows: [row('a', 'Sildar', { facet: { status: 'alive' } })], view: 'cards', title: 'Cast', columns: ['facet.status', 'facet.role'] });
    const ul = el.querySelector('ul.cn-cards')!;
    expect(ul.getAttribute('aria-label')).toBe('Cast');
    expect(ul.querySelector('a.cn-card-link')!.textContent).toBe('Sildar');
    const terms = Array.from(el.querySelectorAll('dt')).map((d) => d.textContent);
    // The empty Role is left out of the card
    expect(terms).toEqual(['Status']);
    expect(el.querySelector('dd')!.textContent).toContain('Alive');
    expect(el.querySelector('table')).toBeNull();
  });

  it('shows three default columns and marks columns after the fourth as extra for narrow containers', () => {
    const facet = { status: 'alive', role: 'Guide', attitude: 'friendly' };
    expect(mount({ rows: [row('a', 'A', { facet })], view: 'cards', filter: { types: ['npc'] } }).el.querySelectorAll('dt')).toHaveLength(3);
    const many = mount({ rows: [row('a', 'A', { tags: ['t'], facet })], view: 'cards', columns: ['type', 'tags', 'updatedAt', 'createdAt', 'facet.status', 'facet.role'] });
    const extra = many.el.querySelectorAll('.cn-card-extra');
    expect(extra).toHaveLength(2);
    expect(Array.from(extra).map((e) => e.querySelector('dt')!.textContent)).toEqual(['Status', 'Role']);
  });

  it('has no sort control', () => {
    const { el } = mount({ rows: [row('a', 'A')], view: 'cards' });
    expect(el.querySelector('select, [aria-sort], thead')).toBeNull();
  });
});
