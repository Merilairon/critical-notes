import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { LayoutService } from '../core/layout.service';
import { CampaignStore } from './campaign.store';
import { PageEditor } from './page-editor';

const settle = () => new Promise((resolve) => setTimeout(resolve));

async function mount(phone: boolean) {
  const layout = { phone: signal(phone) };
  const store = {
    id: signal('c1'),
    isGm: () => false,
    canEdit: () => false,
    members: signal([]),
    loadMembers: async () => undefined,
    ancestors: () => [],
    childrenOf: () => new Map(),
    campaign: signal({ name: 'C' }),
    pages: signal([]),
    pagesOfType: () => [],
    propertyDefs: signal([]),
    byId: () => new Map(),
  };
  TestBed.configureTestingModule({
    providers: [provideRouter([]), provideHttpClient(), provideHttpClientTesting(), { provide: CampaignStore, useValue: store }, { provide: LayoutService, useValue: layout }],
  });
  const fixture = TestBed.createComponent(PageEditor);
  fixture.componentRef.setInput('pageId', 'p1');
  fixture.detectChanges();
  await settle();
  TestBed.inject(HttpTestingController)
    .expectOne('/api/campaigns/c1/pages/p1')
    .flush({
      id: 'p1', type: 'pc', title: 'Wren', icon: null, visibility: 'all', tags: [], viewers: [], props: {}, revision: 1,
      facet: { hpCurrent: 24, hpMax: 31, ac: 16, speed: 30 }, body: { schemaVersion: 1, type: 'doc', content: [] },
    });
  await settle();
  fixture.detectChanges();
  const el = fixture.nativeElement as HTMLElement;
  return { fixture, el, layout, sheet: () => el.querySelector('details')! };
}

describe('PageEditor character sheet', () => {
  it('on a phone it starts collapsed with a digest and toggles', async () => {
    const { fixture, el, sheet } = await mount(true);
    const summary = sheet().querySelector('summary')!;
    expect(sheet().open).toBe(false);
    expect(summary.classList.contains('hidden')).toBe(false);
    expect(summary.textContent).toContain('Character sheet');
    expect(summary.textContent).toContain('HP 24/31 · AC 16 · Speed 30 ft');
    expect(el.querySelector('h1')!.textContent).toBe('Wren');
    sheet().open = true;
    sheet().dispatchEvent(new Event('toggle'));
    fixture.detectChanges();
    expect(sheet().open).toBe(true);
  });

  it('on a wide window the sheet is always open and the summary is hidden; flipping to phone collapses it', async () => {
    const { fixture, layout, sheet } = await mount(false);
    expect(sheet().open).toBe(true);
    expect(sheet().querySelector('summary')!.classList.contains('hidden')).toBe(true);
    layout.phone.set(true);
    fixture.detectChanges();
    expect(sheet().open).toBe(false);
    expect(sheet().querySelector('summary')!.classList.contains('hidden')).toBe(false);
  });
});
