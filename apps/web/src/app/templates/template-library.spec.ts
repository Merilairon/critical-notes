import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { TemplateLibrary } from './template-library';

const settle = () => new Promise((r) => setTimeout(r));

describe('TemplateLibrary deleted templates', () => {
  afterEach(() => document.body.replaceChildren());

  async function mount() {
    TestBed.configureTestingModule({ providers: [provideRouter([]), provideHttpClient(), provideHttpClientTesting()] });
    const fixture = TestBed.createComponent(TemplateLibrary);
    const http = TestBed.inject(HttpTestingController);
    document.body.append(fixture.nativeElement);
    fixture.detectChanges();
    http.expectOne((r) => r.url === '/api/templates').flush({ templates: [] });
    http.expectOne((r) => r.url === '/api/templates/trash').flush({
      templates: [{ id: 'a', kind: 'block', scope: 'user', name: 'Trap', description: '', icon: null, tags: [], version: 1, pageType: null, campaign: null, ownerName: null, canEdit: true, updatedAt: 0, builtinKey: null, deletedAt: Date.now() }],
    });
    await settle();
    fixture.detectChanges();
    return { fixture, http, el: fixture.nativeElement as HTMLElement };
  }

  it('reloads the list after a restore', async () => {
    const { fixture, http, el } = await mount();
    el.querySelector<HTMLButtonElement>('[data-action="restore"]')!.click();
    http.expectOne('/api/templates/a/restore').flush({ id: 'a', name: 'Trap' });
    await settle();
    http.expectOne((r) => r.url === '/api/templates').flush({ templates: [] });
    await settle();
    fixture.detectChanges();
    expect(el.textContent).toContain('Restored "Trap"');
  });

  it('shows a failed reload in the library message', async () => {
    const { fixture, http, el } = await mount();
    el.querySelector<HTMLButtonElement>('[data-action="restore"]')!.click();
    http.expectOne('/api/templates/a/restore').flush({ id: 'a', name: 'Trap' });
    await settle();
    http.expectOne((r) => r.url === '/api/templates').flush({ error: 'Library down' }, { status: 500, statusText: 'x' });
    await settle();
    fixture.detectChanges();
    expect(el.querySelector('p.text-accent[role="status"]')!.textContent).toContain('Library down');
  });
});
