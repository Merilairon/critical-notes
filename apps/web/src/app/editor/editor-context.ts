import { InjectionToken, type Signal } from '@angular/core';

/** Context of the editor that hosts node views (the page being edited). */
export interface EditorContext {
  pageId: Signal<string | null>;
}

export const EDITOR_CONTEXT = new InjectionToken<EditorContext>('EDITOR_CONTEXT');
