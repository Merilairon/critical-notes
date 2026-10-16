import { inject } from '@angular/core';
import { Router, type CanActivateFn } from '@angular/router';
import { AuthService } from '../core/auth.service';

/** Admin pages: signed-in non-admins land on the campaign list. The server's `requireAdmin` is the real boundary. */
export const adminGuard: CanActivateFn = async () => {
  const auth = inject(AuthService);
  const router = inject(Router);
  await auth.ensureLoaded().catch(() => undefined);
  return auth.user()?.isAdmin === true || router.createUrlTree(['/campaigns']);
};
