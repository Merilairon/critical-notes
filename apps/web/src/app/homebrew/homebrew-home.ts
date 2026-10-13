import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import type { CreateHomebrewSourceInput, HomebrewSourceDto } from '@cn/shared';
import { AuthService } from '../core/auth.service';
import { errorMessage } from '../core/http.interceptor';
import { HomebrewApi } from './homebrew-api';
import { ImportPanel } from './import-panel';
import { SourceForm } from './source-form';

/** Homebrew area: the user's sources, new sources, and imports. */
@Component({
  selector: 'cn-homebrew-home',
  imports: [NgTemplateOutlet, RouterLink, SourceForm, ImportPanel],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<div class="mx-auto w-full max-w-5xl p-4 sm:p-6">
    <div class="flex flex-wrap items-center gap-2">
      <h1 class="flex-1 font-display text-3xl font-bold">Homebrew</h1>
      <button type="button" class="rounded-md border border-line px-3 py-1.5 text-sm hover:border-accent" [attr.aria-expanded]="panel() === 'import'" (click)="toggle('import')">Import</button>
      <button type="button" class="rounded-md bg-accent px-3 py-1.5 text-sm font-semibold text-white" [attr.aria-expanded]="panel() === 'new'" (click)="toggle('new')">New source</button>
    </div>
    <p class="mt-1 text-sm text-muted">
      Homebrew uses the 5etools format, so it works like official content: in the reference, in {{ '{@tags}' }}, as NPC statblocks. Share a source with a
      campaign to use it there.
    </p>

    @if (panel() === 'new') {
      <section class="mt-4 rounded-xl border border-line bg-panel p-4" aria-label="New source">
        <cn-source-form [allowInstance]="auth.user()?.isAdmin ?? false" [error]="formError()" (saved)="create($event)" (cancelled)="panel.set(null)" />
      </section>
    }
    @if (panel() === 'import') {
      <section class="mt-4 rounded-xl border border-line bg-panel p-4" aria-label="Import">
        <cn-import-panel (imported)="reload()" />
      </section>
    }

    <section class="mt-6">
      @if (own().length) {
        <h2 class="mb-2 text-xs font-semibold tracking-wide text-muted uppercase">Sources</h2>
        <ul class="grid gap-2 sm:grid-cols-2">
          @for (s of own(); track s.id) {
            <li><ng-container *ngTemplateOutlet="card; context: { $implicit: s }" /></li>
          }
        </ul>
      } @else if (loaded()) {
        <p class="rounded-lg border border-dashed border-line p-6 text-center text-muted">No homebrew yet. Create a source, or import a 5etools homebrew file.</p>
      }
      @if (campaignSources().length) {
        <h2 class="mt-6 mb-2 text-xs font-semibold tracking-wide text-muted uppercase">Campaign-only content</h2>
        <ul class="grid gap-2 sm:grid-cols-2">
          @for (s of campaignSources(); track s.id) {
            <li><ng-container *ngTemplateOutlet="card; context: { $implicit: s }" /></li>
          }
        </ul>
      }
    </section>

    <ng-template #card let-s>
      <a class="flex h-full flex-col gap-1 rounded-xl border border-line bg-panel p-3 hover:border-accent" [routerLink]="['/homebrew/s', s.id]">
        <span class="flex items-center gap-2">
          @if (s.color) {<span class="h-3 w-3 shrink-0 rounded-full" [style.background]="'#' + s.color"></span>}
          <span class="truncate font-semibold">{{ s.campaign ? s.campaign.name : s.fullName }}</span>
          <span class="ml-auto shrink-0 font-mono text-xs text-muted">{{ s.jsonId }}</span>
        </span>
        <span class="text-xs text-muted">
          {{ s.entityCount }} entr{{ s.entityCount === 1 ? 'y' : 'ies' }} · {{ s.edition === 'any' ? 'both editions' : s.edition + ' rules' }}
          @if (s.scope === 'instance') { · instance-wide }
          @if (s.sharedWith.length) { · in {{ s.sharedWith.length }} campaign{{ s.sharedWith.length === 1 ? '' : 's' }} }
          @if (!s.canEdit) { · read-only }
        </span>
      </a>
    </ng-template>
  </div>`,
})
export class HomebrewHome {
  protected readonly auth = inject(AuthService);
  private readonly api = inject(HomebrewApi);
  private readonly router = inject(Router);
  protected readonly sources = signal<HomebrewSourceDto[]>([]);
  protected readonly loaded = signal(false);
  protected readonly panel = signal<'new' | 'import' | null>(null);
  protected readonly formError = signal('');
  protected readonly own = computed(() => this.sources().filter((s) => s.scope !== 'campaign'));
  protected readonly campaignSources = computed(() => this.sources().filter((s) => s.scope === 'campaign'));

  constructor() {
    void this.reload();
  }

  protected async reload() {
    this.sources.set(await this.api.sources());
    this.loaded.set(true);
  }

  protected toggle(p: 'new' | 'import') {
    this.panel.set(this.panel() === p ? null : p);
  }

  protected async create(input: CreateHomebrewSourceInput) {
    this.formError.set('');
    try {
      const s = await this.api.createSource(input);
      await this.router.navigate(['/homebrew/s', s.id]);
    } catch (err) {
      this.formError.set(errorMessage(err));
    }
  }
}
