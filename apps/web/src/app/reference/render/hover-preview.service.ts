import { createCloseScrollStrategy, createFlexibleConnectedPositionStrategy, createOverlayRef, type OverlayRef } from '@angular/cdk/overlay';
import { ComponentPortal } from '@angular/cdk/portal';
import { inject, Injectable, InjectionToken, Injector, type Type } from '@angular/core';

/** Component rendered inside the preview (provided by the app to avoid import cycles). */
export const PREVIEW_COMPONENT = new InjectionToken<Type<unknown>>('PREVIEW_COMPONENT');
/** uid passed to the preview component. */
export const PREVIEW_UID = new InjectionToken<string>('PREVIEW_UID');

const SHOW_DELAY = 350;
const HIDE_DELAY = 200;

@Injectable({ providedIn: 'root' })
export class HoverPreviewService {
  private readonly injector = inject(Injector);
  private readonly component = inject(PREVIEW_COMPONENT, { optional: true });
  private ref: OverlayRef | null = null;
  private currentUid: string | null = null;
  private showTimer: ReturnType<typeof setTimeout> | undefined;
  private hideTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly canHover = globalThis.matchMedia?.('(hover: hover)').matches ?? true;

  show(origin: HTMLElement, uid: string) {
    if (!this.component || !this.canHover) return;
    clearTimeout(this.hideTimer);
    clearTimeout(this.showTimer);
    if (this.ref && this.currentUid === uid) return;
    this.showTimer = setTimeout(() => this.open(origin, uid), SHOW_DELAY);
  }

  hide() {
    clearTimeout(this.showTimer);
    clearTimeout(this.hideTimer);
    this.hideTimer = setTimeout(() => this.close(), HIDE_DELAY);
  }

  close() {
    clearTimeout(this.showTimer);
    this.ref?.dispose();
    this.ref = null;
    this.currentUid = null;
  }

  private open(origin: HTMLElement, uid: string) {
    this.close();
    const positionStrategy = createFlexibleConnectedPositionStrategy(this.injector, origin)
      .withPositions([
        { originX: 'start', originY: 'bottom', overlayX: 'start', overlayY: 'top', offsetY: 6 },
        { originX: 'start', originY: 'top', overlayX: 'start', overlayY: 'bottom', offsetY: -6 },
        { originX: 'end', originY: 'bottom', overlayX: 'end', overlayY: 'top', offsetY: 6 },
      ])
      .withPush(true)
      .withFlexibleDimensions(false)
      .withViewportMargin(12);
    const ref = createOverlayRef(this.injector, {
      positionStrategy,
      scrollStrategy: createCloseScrollStrategy(this.injector),
      panelClass: 'cn-preview-panel',
      maxWidth: 'min(560px, calc(100vw - 24px))',
      maxHeight: 'min(70vh, 640px)',
    });
    const injector = Injector.create({ providers: [{ provide: PREVIEW_UID, useValue: uid }], parent: this.injector });
    ref.attach(new ComponentPortal(this.component!, null, injector));
    ref.overlayElement.addEventListener('mouseenter', () => clearTimeout(this.hideTimer));
    ref.overlayElement.addEventListener('mouseleave', () => this.hide());
    this.ref = ref;
    this.currentUid = uid;
  }
}
