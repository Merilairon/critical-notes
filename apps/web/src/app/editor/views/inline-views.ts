import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { AngularNodeViewComponent } from 'ngx-tiptap';
import { CampaignStore } from '../../campaign/campaign.store';
import { Inline } from '../../reference/render/inline';

/** Inline 5etools tag ({@spell …}, {@dice …}) rendered live, with links, previews and rolls. */
@Component({
  selector: 'cn-tag-view',
  imports: [Inline],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'cn-tag-node' },
  template: `<span [class.cn-tag-selected]="selected()"><cn-inline [text]="markup()" /></span>`,
})
export class TagView extends AngularNodeViewComponent {
  protected readonly markup = computed(() => String(this.node().attrs['markup'] ?? ''));
}

/** [[Page link]] — shows the current title of the linked page. */
@Component({
  selector: 'cn-page-link-view',
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<a class="cn-page-link" [class.cn-page-link-missing]="!exists()" [class.cn-tag-selected]="selected()" [routerLink]="exists() ? ['/c', store?.id(), 'p', pageId()] : null"
    >{{ title() }}</a
  >`,
})
export class PageLinkView extends AngularNodeViewComponent {
  protected readonly store = inject(CampaignStore, { optional: true });
  protected readonly pageId = computed(() => String(this.node().attrs['pageId'] ?? ''));
  protected readonly exists = computed(() => !!this.store?.byId().get(this.pageId()));
  protected readonly title = computed(() => this.store?.byId().get(this.pageId())?.title ?? String(this.node().attrs['label'] || 'missing page'));
}

/** Unfilled template field. */
@Component({
  selector: 'cn-placeholder-view',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<span class="cn-placeholder" [class.cn-tag-selected]="selected()">{{ label() }}</span>`,
})
export class PlaceholderView extends AngularNodeViewComponent {
  protected readonly label = computed(() => String(this.node().attrs['label'] || this.node().attrs['name'] || 'field'));
}
