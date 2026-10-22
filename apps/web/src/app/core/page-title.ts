import { inject, Injectable } from '@angular/core';
import { Title } from '@angular/platform-browser';
import { TitleStrategy, type RouterStateSnapshot } from '@angular/router';

export const APP_NAME = 'Critical Notes';

/** '<part> — <part> — Critical Notes': every page title ends with the app name, once. */
export function pageTitle(...parts: (string | null | undefined)[]): string {
  const named = parts.map((p) => p?.trim().replace(/ — Critical Notes$/, '')).filter((p): p is string => !!p && p !== APP_NAME);
  return [...named, APP_NAME].join(' — ');
}

/** Route `title`s are written as the page name; this adds the suffix. Components that set their own title use `pageTitle`. */
@Injectable({ providedIn: 'root' })
export class AppTitleStrategy extends TitleStrategy {
  private readonly title = inject(Title);

  override updateTitle(snapshot: RouterStateSnapshot) {
    const built = this.buildTitle(snapshot);
    if (built !== undefined) this.title.setTitle(pageTitle(built));
  }
}
