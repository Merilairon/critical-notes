import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { RefPicker } from './ref-picker';

const settle = () => new Promise((r) => setTimeout(r, 200));

async function open() {
  TestBed.configureTestingModule({ providers: [provideRouter([]), provideHttpClient(), provideHttpClientTesting()] });
  const fixture = TestBed.createComponent(RefPicker);
  fixture.componentRef.setInput('kind', 'monster');
  fixture.componentRef.setInput('placeholder', 'Search the bestiary…');
  const picked: (string | null)[] = [];
  fixture.componentInstance.selected.subscribe((v) => picked.push(v));
  document.body.append(fixture.nativeElement);
  fixture.detectChanges();
  const http = TestBed.inject(HttpTestingController);
  const el = fixture.nativeElement as HTMLElement;
  const input = el.querySelector<HTMLInputElement>('input')!;
  input.value = 'gob';
  input.dispatchEvent(new Event('input'));
  await settle();
  http.expectOne((r) => r.url.startsWith('/api/reference/autocomplete/monster')).flush({
    hits: [
      { uid: 'goblin|mm', name: 'Goblin', source: 'MM' },
      { uid: 'goblin-boss|mm', name: 'Goblin Boss', source: 'MM' },
    ],
  });
  await settle();
  fixture.detectChanges();
  return { fixture, el, input, picked };
}

describe('RefPicker combobox', () => {
  it('is a combobox over a listbox of plain options (no buttons inside), with a result count announced', async () => {
    const { el, input } = await open();
    expect(input.getAttribute('role')).toBe('combobox');
    expect(input.getAttribute('aria-expanded')).toBe('true');
    const list = el.querySelector('[role="listbox"]')!;
    expect(input.getAttribute('aria-controls')).toBe(list.id);
    const options = [...list.querySelectorAll('[role="option"]')];
    expect(options.length).toBe(2);
    expect(list.querySelector('button')).toBeNull();
    expect(input.getAttribute('aria-activedescendant')).toBe(options[0]!.id);
    expect(options[0]!.getAttribute('aria-selected')).toBe('true');
    expect(el.querySelector('[role="status"]')!.textContent).toContain('2 results');
  });

  it('arrow keys move the active option, Enter picks it and closes the list', async () => {
    const { fixture, el, input, picked } = await open();
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    fixture.detectChanges();
    const options = [...el.querySelectorAll('[role="option"]')];
    expect(input.getAttribute('aria-activedescendant')).toBe(options[1]!.id);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    fixture.detectChanges();
    expect(picked).toEqual(['goblin-boss|mm']);
    expect(el.querySelector('[role="listbox"]')).toBeNull();
  });

  it('clicking an option picks it', async () => {
    const { el, picked } = await open();
    el.querySelectorAll<HTMLElement>('[role="option"]')[0]!.click();
    expect(picked).toEqual(['goblin|mm']);
  });

  it('Escape closes the list without picking', async () => {
    const { fixture, el, input, picked } = await open();
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await settle();
    fixture.detectChanges();
    expect(picked).toEqual([]);
    expect(el.querySelector('[role="listbox"]')).toBeNull();
    expect(input.getAttribute('aria-expanded')).toBe('false');
  });
});
