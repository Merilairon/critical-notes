import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { ReferenceList } from './reference-list';

const item = (name: string) => ({ uid: `spell:${name.toLowerCase()}|phb`, name, source: 'PHB', origin: 'official', badge: null, summary: {} });

describe('ReferenceList', () => {
  beforeAll(() => {
    globalThis.ResizeObserver ??= class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as never;
  });

  it('says which entry an arrow key selected, with its position, in a polite status', async () => {
    TestBed.configureTestingModule({ providers: [provideRouter([{ path: '**', children: [] }]), provideHttpClient(), provideHttpClientTesting()] });
    const fixture = TestBed.createComponent(ReferenceList);
    fixture.componentRef.setInput('kind', 'spell');
    fixture.detectChanges();
    TestBed.inject(HttpTestingController)
      .expectOne((r) => r.url.includes('/api/') && r.url.includes('spell'))
      .flush({ items: [item('Fireball'), item('Fly'), item('Light')] });
    await fixture.whenStable();
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const status = el.querySelector('[role=status]')!;
    expect(status.textContent).toBe('');
    const input = el.querySelector<HTMLInputElement>('input[type=search]')!;
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', cancelable: true }));
    fixture.detectChanges();
    expect(status.textContent).toBe('Fireball, 1 of 3');
  });
});
