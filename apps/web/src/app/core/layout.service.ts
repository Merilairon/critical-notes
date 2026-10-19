import { DOCUMENT, inject, Injectable, signal } from '@angular/core';

const COMPACT_QUERY = '(max-width: 1023.98px)';

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

  constructor() {
    this.media?.addEventListener?.('change', (e) => {
      this.compact.set(e.matches);
      if (!e.matches) this.drawerOpen.set(false);
    });
  }
}
