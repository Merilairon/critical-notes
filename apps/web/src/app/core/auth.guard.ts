import { inject } from '@angular/core';
import { Router, type CanActivateFn } from '@angular/router';
import { AuthService } from './auth.service';

export const authGuard: CanActivateFn = async (_route, state) => {
  const auth = inject(AuthService);
  const router = inject(Router);
  try {
    await auth.ensureLoaded();
  } catch {
    return router.createUrlTree(['/login']);
  }
  if (auth.setupRequired()) return router.createUrlTree(['/setup']);
  if (!auth.user()) return router.createUrlTree(['/login'], { queryParams: { next: state.url } });
  return true;
};

export const anonymousGuard: CanActivateFn = async () => {
  const auth = inject(AuthService);
  await auth.ensureLoaded().catch(() => undefined);
  return true;
};
