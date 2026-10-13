import { ChangeDetectionStrategy, Component, ElementRef, inject, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ContextService } from '../../core/context.service';
import { HoverPreviewService } from './hover-preview.service';

/** Link to a reference entity with a hover preview. */
@Component({
  selector: 'cn-entity-link',
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<a
    class="cn-link"
    [routerLink]="[...context.referenceBase(), kind(), uid()]"
    (mouseenter)="preview.show(host.nativeElement, uid())"
    (mouseleave)="preview.hide()"
    (click)="preview.close()"
    ><ng-content
  /></a>`,
  host: { class: 'contents' },
})
export class EntityLink {
  readonly uid = input.required<string>();
  readonly kind = input.required<string>();
  protected readonly preview = inject(HoverPreviewService);
  protected readonly context = inject(ContextService);
  protected readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
}
