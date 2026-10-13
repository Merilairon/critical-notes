import { isSafeImagePath } from '@cn/fivetools';

/** URL for a 5etools-img path (served by the API's /img route), or null if unsafe. */
export function imgUrl(path: string | null | undefined): string | null {
  if (!path || !isSafeImagePath(path)) return null;
  return `/img/${path.split('/').map(encodeURIComponent).join('/')}`;
}
