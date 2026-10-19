import { provideHttpClient } from '@angular/common/http';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { PropertyDefDto } from '@cn/shared';
import { CampaignStore } from './campaign.store';
import { PropertiesPanel } from './properties-panel';

const def = (key: string, type: PropertyDefDto['type'], extra: Partial<PropertyDefDto> = {}): PropertyDefDto => ({
  id: key,
  key,
  label: key,
  type,
  options: null,
  appliesTo: null,
  dmOnly: false,
  refKind: null,
  ...extra,
});

function setup(values: Record<string, unknown>) {
  const defs = [
    def('mood', 'select', { options: ['calm', 'angry'] }),
    def('traits', 'multiselect', { options: ['brave', 'greedy', 'loyal'] }),
    def('secret_plan', 'text', { dmOnly: true }),
    def('treasure', 'number', { appliesTo: ['location'] }),
  ];
  TestBed.configureTestingModule({
    imports: [PropertiesPanel],
    providers: [provideRouter([]), provideHttpClient(), { provide: CampaignStore, useValue: { propertyDefs: signal(defs), id: signal('c1'), pages: signal([]) } }],
  });
  const fixture = TestBed.createComponent(PropertiesPanel);
  fixture.componentRef.setInput('pageId', 'p1');
  fixture.componentRef.setInput('pageType', 'npc');
  fixture.componentRef.setInput('values', values);
  const emitted: Record<string, unknown>[] = [];
  fixture.componentInstance.changed.subscribe((v) => emitted.push(v));
  fixture.detectChanges();
  return { el: fixture.nativeElement as HTMLElement, emitted };
}

describe('PropertiesPanel', () => {
  it('shows only properties that apply to the page type, marking DM-only ones', () => {
    const { el } = setup({});
    const labels = [...el.querySelectorAll('[aria-label]')].map((e) => e.getAttribute('aria-label'));
    expect(labels).toEqual(expect.arrayContaining(['mood', 'traits', 'secret_plan', 'DM only']));
    expect(labels).not.toContain('treasure');
  });

  it('multi-select chips carry the chip class (the check mark comes from CSS) and read-only empty values show a dash', () => {
    const { el } = setup({ traits: ['brave'] });
    expect([...el.querySelectorAll('[aria-label=traits] button')].every((b) => b.classList.contains('cn-chip'))).toBe(true);
    TestBed.resetTestingModule();
    const fixtureEl = (() => {
      TestBed.configureTestingModule({
        imports: [PropertiesPanel],
        providers: [provideRouter([]), provideHttpClient(), { provide: CampaignStore, useValue: { propertyDefs: signal([def('mood', 'select', { options: ['calm'] })]), id: signal('c1'), pages: signal([]) } }],
      });
      const f = TestBed.createComponent(PropertiesPanel);
      f.componentRef.setInput('pageId', 'p1');
      f.componentRef.setInput('pageType', 'npc');
      f.componentRef.setInput('readOnly', true);
      f.detectChanges();
      return f.nativeElement as HTMLElement;
    })();
    expect(fixtureEl.textContent).toContain('–');
    expect(fixtureEl.querySelector('select')).toBeNull();
  });

  it('emits typed values: toggling multi-select options and clearing a select', () => {
    const { el, emitted } = setup({ mood: 'calm', traits: ['brave'] });
    const option = (name: string) => [...el.querySelectorAll<HTMLButtonElement>('[aria-label=traits] button')].find((b) => b.textContent!.trim() === name)!;
    expect(option('brave').getAttribute('aria-pressed')).toBe('true');
    option('loyal').click();
    option('brave').click();
    const select = el.querySelector<HTMLSelectElement>('select[aria-label=mood]')!;
    select.value = '';
    select.dispatchEvent(new Event('change'));
    expect(emitted).toEqual([{ traits: ['brave', 'loyal'] }, { traits: null }, { mood: null }]);
  });
});
