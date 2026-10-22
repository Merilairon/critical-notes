import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { CampaignStore } from './campaign.store';
import { FacetForm } from './facet-form';

function mount(facetType: 'pc' | 'npc', value: Record<string, unknown>, readOnly = false) {
  TestBed.configureTestingModule({
    providers: [provideRouter([]), provideHttpClient(), provideHttpClientTesting(), { provide: CampaignStore, useValue: { pages: signal([]), pagesOfType: () => [], id: signal('c1') } }],
  });
  const fixture = TestBed.createComponent(FacetForm);
  fixture.componentRef.setInput('facetType', facetType);
  fixture.componentRef.setInput('value', value);
  fixture.componentRef.setInput('readOnly', readOnly);
  fixture.detectChanges();
  return fixture.nativeElement as HTMLElement;
}

describe('FacetForm on a phone', () => {
  it('uses the shared 44 px input class, numeric keyboards and a 44 px checkbox row', () => {
    const el = mount('pc', { hpMax: 31 });
    const numbers = [...el.querySelectorAll<HTMLInputElement>('input[type=number]')];
    expect(numbers.length).toBeGreaterThan(6);
    expect(numbers.every((i) => i.classList.contains('cn-input') && i.inputMode === 'numeric')).toBe(true);
    const inspiration = el.querySelector<HTMLInputElement>('input[type=checkbox]')!;
    expect(inspiration.closest('label')!.className).toContain('touch:min-h-[44px]');
  });

  it('puts number fields in one grid cell and text fields across both', () => {
    const el = mount('pc', {});
    const label = (text: string) => [...el.querySelectorAll('label')].find((l) => l.textContent!.includes(text))!;
    expect(label('Max HP').className).not.toContain('col-span-2');
    expect(label('Player').className).toContain('col-span-2');
  });

  it('marks add and remove class as edit-only, so readers do not see them', () => {
    const el = mount('pc', { classes: [{ classUid: 'bard|phb', subclassUid: null, level: 3 }] });
    const editOnly = [...el.querySelectorAll('button')].filter((b) => b.classList.contains('cn-edit-only'));
    // The pickers' "change" and "Clear" buttons are edit-only too
    expect(editOnly.map((b) => b.getAttribute('aria-label') ?? b.textContent!.trim())).toEqual(['Change class', 'Clear class', 'Remove class', '+ add class']);
  });

  it('shows an en dash for an empty value when read-only, the control otherwise', () => {
    const reader = mount('npc', { role: '' }, true);
    expect(reader.textContent).toContain('–');
    expect(reader.querySelector('input[type=text]')).toBeNull();
    TestBed.resetTestingModule();
    const editor = mount('npc', { role: '' }, false);
    expect(editor.querySelector('input[type=text]')).not.toBeNull();
  });
});
