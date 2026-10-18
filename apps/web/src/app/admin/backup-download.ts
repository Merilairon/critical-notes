import { InjectionToken } from '@angular/core';

/**
 * Starts a download by navigating the browser to `url` (never fetch, XHR, blob or iframe: the file streams to disk).
 * A temporary same-origin anchor with `download` keeps the page open if the server answers with an error.
 * Tests replace this token.
 */
export const BACKUP_NAVIGATE = new InjectionToken<(url: string) => void>('BACKUP_NAVIGATE', {
  providedIn: 'root',
  factory: () => (url: string) => {
    const a = document.createElement('a');
    a.href = url;
    a.download = '';
    a.rel = 'noreferrer';
    a.hidden = true;
    document.body.append(a);
    a.click();
    a.remove();
  },
});
