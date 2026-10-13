import { provideHttpClient } from '@angular/common/http';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { CampaignStore } from '../campaign/campaign.store';
import { filterSlashItems } from '../editor/suggestion/extensions';
import { PageTemplateFields, type PageFields } from './page-template-fields';
import { TemplateValuesForm } from './values-form';
import { VariablesPanel } from './variables-panel';

describe('template UI', () => {
  it('offers "Template…" in the slash menu only where templates can be inserted', () => {
    expect(filterSlashItems('template').map((i) => i.title)).toEqual([]);
    expect(filterSlashItems('template', 30, { openTemplatePicker: () => undefined }).map((i) => i.title)).toEqual(['Template…']);
  });

  it('renders typed inputs for values and drops emptied ones', () => {
    TestBed.configureTestingModule({
      imports: [TemplateValuesForm],
      providers: [provideRouter([]), provideHttpClient(), { provide: CampaignStore, useValue: { pages: signal([]), pagesOfType: () => [], id: signal('c1') } }],
    });
    const fixture = TestBed.createComponent(TemplateValuesForm);
    fixture.componentRef.setInput('variables', [
      { name: 'dc', type: 'number', default: 13 },
      { name: 'save', type: 'select(Str|Dex)', label: 'Save' },
      { name: 'trapped', type: 'boolean' },
      { name: 'title', type: 'text', required: true },
    ]);
    fixture.componentRef.setInput('values', { title: 'Old' });
    const emitted: Record<string, unknown>[] = [];
    fixture.componentInstance.changed.subscribe((v) => emitted.push(v));
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const number = el.querySelector<HTMLInputElement>('input[type=number]')!;
    expect(number.placeholder).toBe('Default: 13');
    expect([...el.querySelectorAll('select option')].map((o) => o.textContent)).toEqual(['—', 'Str', 'Dex']);
    expect(el.textContent).toContain('title *');
    number.value = '15';
    number.dispatchEvent(new Event('input'));
    const text = el.querySelector<HTMLInputElement>('input[aria-label=title]')!;
    text.value = '';
    text.dispatchEvent(new Event('input'));
    expect(emitted).toEqual([{ title: 'Old', dc: '15' }, {}]);
  });

  it('locks the type of fields typed in the content', () => {
    TestBed.configureTestingModule({ imports: [VariablesPanel] });
    const fixture = TestBed.createComponent(VariablesPanel);
    fixture.componentRef.setInput('variables', [
      { name: 'dc', type: 'number' },
      { name: 'foe', type: 'text' },
    ]);
    fixture.componentRef.setInput('typed', new Set(['dc']));
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector<HTMLInputElement>('input[aria-label="dc type"]')!.disabled).toBe(true);
    expect(el.querySelector<HTMLInputElement>('input[aria-label="foe type"]')!.disabled).toBe(false);
  });

  it('keys template properties by their label', () => {
    TestBed.configureTestingModule({ imports: [PageTemplateFields] });
    const fixture = TestBed.createComponent(PageTemplateFields);
    const def: PageFields = { pageType: 'location', extendsRef: null, bodyMode: 'append', defaults: {}, facet: {}, properties: [{ key: 'property_1', label: 'Property', type: 'text' }], children: [] };
    fixture.componentRef.setInput('def', def);
    const emitted: Partial<PageFields>[] = [];
    fixture.componentInstance.changed.subscribe((v) => emitted.push(v));
    fixture.detectChanges();
    const label = (fixture.nativeElement as HTMLElement).querySelector<HTMLInputElement>('input[aria-label="Property label"]')!;
    label.value = 'Threat level';
    label.dispatchEvent(new Event('change'));
    expect(emitted[0]!.properties).toEqual([{ key: 'threat_level', label: 'Threat level', type: 'text' }]);
  });
});
