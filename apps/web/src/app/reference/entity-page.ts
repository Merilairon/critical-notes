import { httpResource } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal } from '@angular/core';
import { Title } from '@angular/platform-browser';
import { RouterLink } from '@angular/router';
import type { EntityDto } from '@cn/shared';
import { api } from '../core/api';
import { CopyToHomebrew } from '../homebrew/copy-panel';
import { ContextService } from '../core/context.service';
import { EntityView } from './entity-view';
import { kindLabel } from './kind-labels';

@Component({
  selector: 'cn-entity-page',
  imports: [EntityView, RouterLink, CopyToHomebrew],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<div class="mx-auto max-w-4xl p-4 sm:p-6">
    <div class="flex flex-wrap items-center gap-2">
      <a class="cn-link text-sm" [routerLink]="[...context.referenceBase(), kind()]">← {{ backLabel() }}</a>
      @if (entity.hasValue()) {
        <span class="ml-auto flex gap-2 text-sm">
          @if (entity.value().homebrewEntityId; as hbId) {
            <a class="rounded-md border border-line px-2 py-1 text-muted hover:border-accent" [routerLink]="['/homebrew/e', hbId]">Edit homebrew</a>
          }
          <button type="button" class="rounded-md border border-line px-2 py-1 text-muted hover:border-accent" [attr.aria-expanded]="copying()" (click)="copying.set(!copying())">
            Copy to homebrew
          </button>
        </span>
      }
    </div>
    @if (copying() && entity.hasValue()) {
      <div class="mt-3"><cn-copy-to-homebrew [entity]="entity.value()" (closed)="copying.set(false)" /></div>
    }
    <div class="mt-3">
      @if (entity.hasValue()) {
        <cn-entity-view [entity]="entity.value()" />
      } @else if (entity.error()) {
        <p class="rounded-lg border border-dashed border-line p-4 text-muted">
          This entry was not found. It may come from a source that is not in the loaded 5etools data.
        </p>
      } @else {
        <p class="text-muted">Loading…</p>
      }
    </div>
  </div>`,
})
export class EntityPage {
  readonly kind = input.required<string>();
  readonly uid = input.required<string>();
  protected readonly context = inject(ContextService);
  private readonly title = inject(Title);
  protected readonly entity = httpResource<EntityDto>(() => ({ url: api.entity(this.uid()), params: this.context.params() }));
  protected readonly backLabel = computed(() => kindLabel(this.kind(), this.context.ruleset(), true));
  protected readonly copying = signal(false);

  constructor() {
    effect(() => {
      if (this.entity.hasValue()) this.title.setTitle(`${this.entity.value().name} — Critical Notes`);
    });
  }
}
