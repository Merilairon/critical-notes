import { httpResource } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import type { EntityDto } from '@cn/shared';
import { api } from '../core/api';
import { ContextService } from '../core/context.service';
import { EntityView } from './entity-view';
import { PREVIEW_UID } from './render/hover-preview.service';

/** Content of the hover preview overlay. */
@Component({
  selector: 'cn-preview-card',
  imports: [EntityView],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<div class="p-3 sm:p-4">
    @if (entity.hasValue()) {
      <cn-entity-view [entity]="entity.value()" [compact]="true" />
    } @else if (entity.error()) {
      <p class="text-sm text-muted">Not found in the loaded data.</p>
    } @else {
      <p class="text-sm text-muted">Loading…</p>
    }
  </div>`,
})
export class PreviewCard {
  private readonly uid = inject(PREVIEW_UID);
  private readonly context = inject(ContextService);
  protected readonly entity = httpResource<EntityDto>(() => ({ url: api.entity(this.uid), params: this.context.params() }));
}
