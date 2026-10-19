import { DOCUMENT, inject, Injectable, signal } from '@angular/core';

const COMPACT_QUERY = '(max-width: 1023.98px)';
/** Phones (portrait) and short landscape phones: sections such as the character sheet start collapsed. */
const PHONE_QUERY = '(max-width: 639.98px), (orientation: landscape) and (max-height: 500px)';

/**
 * Shell layout state shared by the app header and the campaign shell (siblings in the tree).
 * Below `lg` (1024 px) the header is compact and the campaign navigation is a drawer.
 */
@Injectable({ providedIn: 'root' })
export class LayoutService {
  private readonly media = inject(DOCUMENT).defaultView?.matchMedia?.(COMPACT_QUERY);

  /** True below `lg`. Stays false where matchMedia is missing (tests). */
  readonly compact = signal(!!this.media?.matches);
  /** The campaign drawer. Never open on a wide window, so `inert` cannot stick when the window grows. */
  readonly drawerOpen = signal(false);
  private readonly phoneMedia = inject(DOCUMENT).defaultView?.matchMedia?.(PHONE_QUERY);
  /** True on a phone (narrow, or short landscape). Stays false where matchMedia is missing (tests), so the desktop markup is the default. */
  readonly phone = signal(!!this.phoneMedia?.matches);

  constructor() {
    this.phoneMedia?.addEventListener?.('change', (e) => this.phone.set(e.matches));
    this.media?.addEventListener?.('change', (e) => {
      this.compact.set(e.matches);
      if (!e.matches) this.drawerOpen.set(false);
    });
  }
}
