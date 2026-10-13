import { ChangeDetectionStrategy, Component, computed, inject, input, output, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import type { EntityDto, HomebrewSourceDto } from '@cn/shared';
import { errorMessage } from '../core/http.interceptor';
import { HomebrewApi } from './homebrew-api';

/** "Copy to homebrew": a full copy, or a variant that stores only the changes (`_copy`). */
@Component({
  selector: 'cn-copy-to-homebrew',
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<div class="rounded-xl border border-line bg-panel p-3 text-sm">
    @if (!loaded()) {
      <p class="text-muted">Loading your sources…</p>
    } @else if (!targets().length) {
      <p>You have no homebrew source to copy into. <a class="cn-link" routerLink="/homebrew">Create one</a> first.</p>
    } @else {
      <form class="grid gap-2 sm:grid-cols-2" (submit)="$event.preventDefault(); copy(src.value, name.value)">
        <label class="flex flex-col gap-1">
          <span class="text-xs text-muted">Into</span>
          <select #src class="cn-prop-input">
            @for (s of targets(); track s.id) {<option [value]="s.id">{{ s.campaign ? s.campaign.name + ' (campaign)' : s.fullName }}</option>}
          </select>
        </label>
        <label class="flex flex-col gap-1">
          <span class="text-xs text-muted">Name</span>
          <input #name class="cn-prop-input" [placeholder]="mode() === 'clone' ? entity().name + ' (copy)' : entity().name" />
        </label>
        <fieldset class="flex flex-col gap-1 sm:col-span-2">
          <legend class="text-xs text-muted">How</legend>
          <label class="flex items-center gap-2"><input type="radio" name="mode" [checked]="mode() === 'variant'" (change)="mode.set('variant')" /> Variant: stores only your changes and follows the original</label>
          <label class="flex items-center gap-2"><input type="radio" name="mode" [checked]="mode() === 'clone'" (change)="mode.set('clone')" /> Full copy: independent of the original</label>
        </fieldset>
        <div class="flex items-center gap-2 sm:col-span-2">
          <button type="submit" class="rounded-md bg-accent px-3 py-1.5 font-semibold text-white" [disabled]="busy()">Copy and edit</button>
          <button type="button" class="rounded-md border border-line px-3 py-1.5 text-muted" (click)="closed.emit()">Cancel</button>
          @if (error()) {<span class="text-accent" role="alert">{{ error() }}</span>}
        </div>
      </form>
    }
  </div>`,
})
export class CopyToHomebrew {
  readonly entity = input.required<EntityDto>();
  readonly closed = output<void>();
  private readonly api = inject(HomebrewApi);
  private readonly router = inject(Router);
  protected readonly sources = signal<HomebrewSourceDto[]>([]);
  protected readonly loaded = signal(false);
  protected readonly mode = signal<'clone' | 'variant'>('variant');
  protected readonly busy = signal(false);
  protected readonly error = signal('');
  protected readonly targets = computed(() => this.sources().filter((s) => s.canEdit));

  constructor() {
    void this.api.sources().then((s) => {
      this.sources.set(s);
      this.loaded.set(true);
    });
  }

  protected async copy(sourceId: string, name: string) {
    this.busy.set(true);
    this.error.set('');
    try {
      const res = await this.api.copy(sourceId, this.entity().uid, this.mode(), name.trim() || undefined);
      await this.router.navigate(['/homebrew/e', res.entity.id]);
    } catch (err) {
      this.error.set(errorMessage(err));
    } finally {
      this.busy.set(false);
    }
  }
}
