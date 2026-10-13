import { DOCUMENT, effect, inject, Injectable, signal } from '@angular/core';
import { readStored, writeStored } from './storage';

export type ThemeMode = 'light' | 'dark' | 'system';

@Injectable({ providedIn: 'root' })
export class ThemeService {
  private readonly doc = inject(DOCUMENT);
  readonly mode = signal<ThemeMode>(readStored<ThemeMode>('cn.theme', 'system'));
  private readonly media = this.doc.defaultView?.matchMedia?.('(prefers-color-scheme: dark)');
  private readonly systemDark = signal(!!this.media?.matches);

  constructor() {
    this.media?.addEventListener?.('change', (e) => this.systemDark.set(e.matches));
    effect(() => {
      const mode = this.mode();
      writeStored('cn.theme', mode);
      const dark = mode === 'dark' || (mode === 'system' && this.systemDark());
      this.doc.documentElement.classList.toggle('dark', dark);
    });
  }

  cycle() {
    this.mode.update((m) => (m === 'system' ? 'dark' : m === 'dark' ? 'light' : 'system'));
  }
}
