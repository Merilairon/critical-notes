import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { ApiTokenDto } from '@cn/shared';
import { AuthService } from '../core/auth.service';
import { AccountPage } from './account-page';

const settle = () => new Promise((resolve) => setTimeout(resolve));
const token = (id: string, extra: Partial<ApiTokenDto> = {}): ApiTokenDto => ({ id, name: id, scope: 'write', createdAt: 0, lastUsedAt: null, expiresAt: null, ...extra });

async function mount(tokens: ApiTokenDto[]) {
  TestBed.configureTestingModule({
    imports: [AccountPage],
    providers: [provideHttpClient(), provideHttpClientTesting(), { provide: AuthService, useValue: { user: signal({ id: 'u', username: 'jan', displayName: 'Jan', isAdmin: true }) } }],
  });
  const fixture = TestBed.createComponent(AccountPage);
  const http = TestBed.inject(HttpTestingController);
  fixture.detectChanges();
  http.expectOne('/api/auth/tokens').flush({ tokens });
  await settle();
  fixture.detectChanges();
  return { fixture, el: fixture.nativeElement as HTMLElement, http };
}

describe('AccountPage', () => {
  it('creates a token and shows it once with the setup for MCP clients', async () => {
    const { fixture, el, http } = await mount([]);
    expect(el.textContent).toContain('No tokens yet.');
    el.querySelector<HTMLInputElement>('input[aria-label="Token name"]')!.value = 'Claude';
    el.querySelector<HTMLFormElement>('form')!.dispatchEvent(new Event('submit'));
    const req = http.expectOne({ method: 'POST', url: '/api/auth/tokens' });
    expect(req.request.body).toEqual({ name: 'Claude', scope: 'write', expiresInDays: 90 });
    req.flush({ ...token('t1', { name: 'Claude' }), token: 'cn_secret' });
    await settle();
    http.expectOne('/api/auth/tokens').flush({ tokens: [token('t1', { name: 'Claude' })] });
    await settle();
    fixture.detectChanges();
    expect(el.querySelector<HTMLInputElement>('input[aria-label="New token"]')!.value).toBe('cn_secret');
    expect(el.querySelector('pre[aria-label="Claude Code"]')!.textContent).toBe(`claude mcp add --transport http critical-notes ${location.origin}/mcp --header "Authorization: Bearer cn_secret"`);
    expect(el.textContent).toContain('Read and write');
  });

  it('lists tokens, marks expired ones and revokes', async () => {
    const { fixture, el, http } = await mount([token('old', { expiresAt: 1, scope: 'read' }), token('new')]);
    expect(el.textContent).toContain('Expired');
    expect(el.textContent).toContain('Read only');
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    el.querySelector<HTMLButtonElement>('button[aria-label="Revoke old"]')!.click();
    http.expectOne({ method: 'DELETE', url: '/api/auth/tokens/old' }).flush(null);
    await settle();
    http.expectOne('/api/auth/tokens').flush({ tokens: [token('new')] });
    await settle();
    fixture.detectChanges();
    expect(el.querySelector('button[aria-label="Revoke old"]')).toBeNull();
  });
});
