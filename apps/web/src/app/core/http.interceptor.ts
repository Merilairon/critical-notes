import type { HttpInterceptorFn } from '@angular/common/http';
import { HttpErrorResponse } from '@angular/common/http';
import { inject } from '@angular/core';
import { Router } from '@angular/router';
import { catchError, throwError } from 'rxjs';
import { AuthService } from './auth.service';

/** Sends JSON-friendly headers and redirects to the login page when the session expires. */
export const httpInterceptor: HttpInterceptorFn = (req, next) => {
  const auth = inject(AuthService);
  const router = inject(Router);
  return next(req).pipe(
    catchError((err: unknown) => {
      if (err instanceof HttpErrorResponse && err.status === 401 && !req.url.startsWith('/api/auth/')) {
        auth.markSignedOut();
        router.navigate(['/login'], { queryParams: { next: router.url } });
      }
      return throwError(() => err);
    }),
  );
};

/** Human-readable message from an API error response. */
export function errorMessage(err: unknown): string {
  if (err instanceof HttpErrorResponse) {
    const body = err.error as { error?: string; issues?: { path: string; message: string }[] } | null;
    if (body?.issues?.length) return body.issues.map((i) => (i.path ? `${i.path}: ${i.message}` : i.message)).join('; ');
    if (body?.error) return body.error;
    if (err.status === 0) return 'Cannot reach the server';
    return `${err.status} ${err.statusText}`;
  }
  return err instanceof Error ? err.message : 'Something went wrong';
}

/** Error text for a form request, with a retry hint when the server rate-limits (429 + Retry-After). */
export function requestError(err: unknown): string {
  if (err instanceof HttpErrorResponse && err.status === 429) {
    const secs = Number(err.headers.get('Retry-After'));
    return secs > 0 ? `Too many attempts. Try again in ${secs >= 60 ? `${Math.ceil(secs / 60)} min` : `${secs} s`}.` : 'Too many attempts. Try again in a minute.';
  }
  return errorMessage(err);
}
