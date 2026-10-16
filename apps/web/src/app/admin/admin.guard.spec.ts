import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router, UrlTree, type ActivatedRouteSnapshot, type RouterStateSnapshot } from '@angular/router';
import { AuthService } from '../core/auth.service';
import { adminGuard } from './admin.guard';

const run = () => TestBed.runInInjectionContext(() => adminGuard({} as ActivatedRouteSnapshot, {} as RouterStateSnapshot)) as Promise<boolean | UrlTree>;

function setup(me: { user: unknown; setupRequired: boolean } | 'offline') {
  TestBed.configureTestingModule({ providers: [provideRouter([]), provideHttpClient(), provideHttpClientTesting()] });
  const http = TestBed.inject(HttpTestingController);
  const result = run();
  const req = http.expectOne('/api/auth/me');
  if (me === 'offline') req.flush(null, { status: 500, statusText: 'x' });
  else req.flush(me);
  return result;
}

describe('adminGuard', () => {
  it('lets an admin in', async () => {
    expect(await setup({ user: { id: 'a', username: 'a', displayName: 'A', isAdmin: true }, setupRequired: false })).toBe(true);
  });

  it('sends a signed-in non-admin to the campaign list', async () => {
    const res = await setup({ user: { id: 'p', username: 'p', displayName: 'P', isAdmin: false }, setupRequired: false });
    expect(res instanceof UrlTree && TestBed.inject(Router).serializeUrl(res)).toBe('/campaigns');
  });

  it('refuses an anonymous visitor (the auth guard sends them to sign in first)', async () => {
    const res = await setup({ user: null, setupRequired: false });
    expect(res instanceof UrlTree).toBe(true);
  });

  it('refuses when the session cannot be checked', async () => {
    expect((await setup('offline')) instanceof UrlTree).toBe(true);
    expect(TestBed.inject(AuthService).user()).toBeNull();
  });
});
