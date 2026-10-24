import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { PropertyDefDto } from '@cn/shared';
import { CampaignStore } from '../../campaign/campaign.store';
import { QueryColumns } from './query-columns';

const prop = (key: string, extra: Partial<PropertyDefDto> = {}): PropertyDefDto => ({ id: key, key, label: key[0]!.toUpperCase() + key.slice(1), type: 'text', options: null, appliesTo: null, dmOnly: false, refKind: null, ...extra });

function mount(o: { columns?: unknown; types?: string[]; mode?: 'list' | 'table' | 'cards'; isGm?: boolean; props?: PropertyDefDto[] } = {}) {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ providers: [{ provide: CampaignStore, useValue: { isGm: signal(o.isGm ?? true), propertyDefs: signal(o.props ?? [prop('mood'), prop('secret', { dmOnly: true })]) } }] });
  const fixture = TestBed.createComponent(QueryColumns);
  const emitted: string[][] = [];
  fixture.componentInstance.columnsChange.subscribe((c) => emitted.push(c));
  const set = (c: unknown) => fixture.componentRef.setInput('columns', c);
  set(o.columns ?? []);
  fixture.componentRef.setInput('types', o.types ?? []);
  fixture.componentRef.setInput('mode', o.mode ?? 'table');
  document.body.append(fixture.nativeElement);
  fixture.detectChanges();
  const el = fixture.nativeElement as HTMLElement;
  return {
    fixture,
    el,
    emitted,
    /** What the host does with an emitted change: stores it and passes it back in. */
    apply: async () => {
      set(emitted.at(-1));
      fixture.detectChanges();
      await fixture.whenStable();
      fixture.detectChanges();
    },
    items: () => Array.from(el.querySelectorAll('.cn-qcols-item')),
    live: () => {
      fixture.detectChanges();
      return el.querySelector('[aria-live]')!.textContent;
    },
    btn: (name: string) => el.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`)!,
  };
}

afterEach(() => document.body.replaceChildren());

describe('QueryColumns', () => {
  it('lists the chosen columns in order, each with named Up, Down and Remove buttons', () => {
    const { items, btn } = mount({ columns: ['facet.status', 'prop.mood', 'type'] });
    expect(items().map((li) => li.querySelector('.cn-qcols-name')!.textContent!.replace(/\s+/g, ' ').trim())).toEqual(['1Status', '2Mood', '3Type']);
    expect(btn('Move Mood up')).not.toBeNull();
    expect(btn('Move Mood down')).not.toBeNull();
    expect(btn('Remove Mood')).not.toBeNull();
  });

  it('uses aria-disabled, not disabled, for Up on the first and Down on the last', () => {
    const { btn, emitted, live } = mount({ columns: ['type', 'tags'] });
    const up = btn('Move Type up');
    expect(up.getAttribute('aria-disabled')).toBe('true');
    expect(up.disabled).toBe(false);
    up.click();
    expect(emitted).toEqual([]);
    expect(live()).toBe('Type is already first.');
    btn('Move Tags down').click();
    expect(live()).toBe('Tags is already last.');
  });

  it('adds a column from the grouped select, announces it, and drops it from the choices', async () => {
    const m = mount({ columns: ['type'], types: ['npc'] });
    const select = m.el.querySelector<HTMLSelectElement>('select')!;
    expect(Array.from(select.querySelectorAll('optgroup')).map((g) => g.label)).toEqual(['Page', 'Details', 'Properties']);
    expect(Array.from(select.options).map((o) => o.value)).not.toContain('type');
    select.value = 'facet.status';
    m.el.querySelector<HTMLButtonElement>('[data-act=add]')!.click();
    expect(m.emitted).toEqual([['type', 'facet.status']]);
    expect(m.live()).toBe('Added Status. 2 columns shown.');
    await m.apply();
    expect(Array.from(m.el.querySelector<HTMLSelectElement>('select')!.options).map((o) => o.value)).not.toContain('facet.status');
    expect(document.activeElement).toBe(m.el.querySelector('select'));
  });

  it('starts from the default columns when the first column is added', () => {
    const m = mount({ columns: [], types: ['quest'] });
    expect(m.el.textContent).toContain('Using the default columns for these pages: Status, Priority, Quest giver, Updated.');
    m.el.querySelector<HTMLSelectElement>('select')!.value = 'tags';
    m.el.querySelector<HTMLButtonElement>('[data-act=add]')!.click();
    expect(m.emitted[0]).toEqual(['facet.status', 'facet.priority', 'facet.giverPageId', 'updatedAt', 'tags']);
  });

  it('removes, announces, and puts focus on the Remove button now at that position', async () => {
    const m = mount({ columns: ['type', 'tags', 'updatedAt'] });
    m.btn('Remove Tags').click();
    expect(m.emitted).toEqual([['type', 'updatedAt']]);
    expect(m.live()).toBe('Removed Tags. 2 columns shown.');
    await m.apply();
    expect(document.activeElement).toBe(m.btn('Remove Updated'));
    m.btn('Remove Updated').click();
    await m.apply();
    expect(document.activeElement).toBe(m.btn('Remove Type'));
    m.btn('Remove Type').click();
    await m.apply();
    expect(document.activeElement).toBe(m.el.querySelector('select'));
  });

  it('moves a column and keeps focus on the same button of the moved item', async () => {
    const m = mount({ columns: ['type', 'tags', 'updatedAt'] });
    m.btn('Move Tags up').click();
    expect(m.emitted).toEqual([['tags', 'type', 'updatedAt']]);
    expect(m.live()).toBe('Tags moved to position 1 of 3.');
    await m.apply();
    expect(document.activeElement).toBe(m.btn('Move Tags up'));
  });

  it('resets to the defaults by emitting an empty list', () => {
    const m = mount({ columns: ['type', 'tags'] });
    m.el.querySelector<HTMLButtonElement>('[data-act=reset]')!.click();
    expect(m.emitted).toEqual([[]]);
    expect(m.live()).toBe('Columns reset to the default for these pages.');
  });

  it('does not let a pending focus fire on a later, unrelated change when nothing changed', async () => {
    const m = mount({ columns: [] });
    m.el.querySelector<HTMLButtonElement>('[data-act=reset]')!.click();
    expect(m.emitted).toEqual([[]]);
    (document.activeElement as HTMLElement | null)?.blur();
    m.fixture.componentRef.setInput('columns', ['type']);
    m.fixture.detectChanges();
    await m.fixture.whenStable();
    expect(document.activeElement).not.toBe(m.el.querySelector('[data-act=reset]'));
  });

  it('moves focus to the maximum hint when the 10th column is added', async () => {
    const nine = ['type', 'tags', 'updatedAt', 'createdAt', 'facet.status', 'facet.role', 'facet.attitude', 'facet.kind', 'facet.priority'];
    const m = mount({ columns: nine });
    m.el.querySelector<HTMLSelectElement>('select')!.value = 'prop.mood';
    m.el.querySelector<HTMLButtonElement>('[data-act=add]')!.click();
    await m.apply();
    const hint = m.el.querySelector<HTMLElement>('[data-act=end-hint]')!;
    expect(hint.textContent).toContain('10 columns is the maximum.');
    expect(document.activeElement).toBe(hint);
  });

  it('links the DM-only note to its row with aria-describedby', () => {
    const m = mount({ columns: ['prop.secret', 'type'] });
    const [dmRow, plainRow] = m.items();
    const id = dmRow!.getAttribute('aria-describedby')!;
    expect(m.el.querySelector(`#${id}`)!.textContent).toContain('Players will not see this column.');
    expect(plainRow!.hasAttribute('aria-describedby')).toBe(false);
  });

  it('clears the announcement when the view is switched', async () => {
    const m = mount({ columns: ['type', 'tags'] });
    m.btn('Remove Tags').click();
    expect(m.live()).toContain('Removed Tags');
    m.fixture.componentRef.setInput('mode', 'cards');
    m.fixture.detectChanges();
    await m.fixture.whenStable();
    expect(m.live()).toBe('');
  });

  it('stops at 10 columns', () => {
    const ten = ['type', 'tags', 'updatedAt', 'createdAt', 'facet.status', 'facet.role', 'facet.attitude', 'facet.kind', 'facet.priority', 'prop.mood'];
    const m = mount({ columns: ten });
    expect(m.el.querySelector('select')).toBeNull();
    expect(m.el.textContent).toContain('10 columns is the maximum.');
  });

  it('keeps a stale column in the list with a warning and a Remove button instead of dropping it', () => {
    const m = mount({ columns: ['prop.deleted', 'facet.priority', 'type'], types: ['npc'] });
    const names = m.items().map((li) => li.querySelector('.cn-qcols-name')!.textContent!.replace(/\s+/g, ' ').trim());
    expect(names[0]).toContain('Removed property (prop.deleted)');
    expect(names[0]).toContain('Not shown');
    expect(names[1]).toContain('Not available for these pages (facet.priority)');
    expect(m.btn('Remove prop.deleted')).not.toBeNull();
    expect(m.emitted).toEqual([]);
  });

  it('offers DM-only entries only to the DM and warns that players will not see them', () => {
    const dm = mount({ columns: ['prop.secret'], types: ['npc'] });
    expect(dm.items()[0]!.textContent).toContain('DM only');
    expect(dm.items()[0]!.textContent).toContain('Players will not see this column.');
    expect(Array.from(dm.el.querySelectorAll('option')).map((o) => o.textContent!.trim())).toContain('Role');
    const dmOptions = mount({ columns: [], types: ['npc'], props: [prop('secret', { dmOnly: true })] });
    expect(Array.from(dmOptions.el.querySelectorAll('option')).some((o) => o.textContent!.includes('Secret (DM only)'))).toBe(true);
    const player = mount({ columns: [], types: ['npc'], isGm: false, props: [prop('mood')] });
    expect(Array.from(player.el.querySelectorAll('option')).some((o) => o.textContent!.includes('DM only'))).toBe(false);
  });

  it('shows a hint instead of the picker in the list view', () => {
    const m = mount({ columns: ['type'], mode: 'list' });
    expect(m.el.textContent).toContain('Switch to Table or Cards to choose columns.');
    expect(m.el.querySelector('select')).toBeNull();
  });
});
