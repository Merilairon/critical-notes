import { httpResource } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, computed, forwardRef, inject, input, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { PAGE_TYPE_ICONS, type EntityDto, type QueryRowDto } from '@cn/shared';
import { CampaignStore } from '../campaign/campaign.store';
import { api } from '../core/api';
import { ContextService } from '../core/context.service';
import { imageSrcUrl } from '../editor/views/atom-views';
import { EntityView } from '../reference/entity-view';
import { Inline } from '../reference/render/inline';
import { Roll } from '../reference/render/roll';

export interface ViewNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: ViewNode[];
  marks?: { type: string; attrs?: Record<string, unknown> }[];
  text?: string;
}

const MARK_CLASS: Record<string, string> = {
  bold: 'cn-s-bold',
  italic: 'cn-s-italic',
  underline: 'cn-s-underline',
  strike: 'cn-s-strike',
  code: 'cn-s-code',
  highlight: 'cn-s-highlight',
};

/** Inline content: text with marks, inline 5etools tags, page links, template fields. */
@Component({
  selector: 'cn-inline-content',
  imports: [Inline, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'contents' },
  template: `@for (n of nodes(); track $index) {
    @switch (n.type) {
      @case ('text') {
        @if (href(n); as h) {
          <a class="cn-link" [href]="h" target="_blank" rel="noopener noreferrer nofollow"><span [class]="classes(n)">{{ n.text }}</span></a>
        } @else {
          <span [class]="classes(n)">{{ n.text }}</span>
        }
      }
      @case ('hardBreak') {<br />}
      @case ('tag') {<cn-inline [text]="$any(n.attrs?.['markup'])" />}
      @case ('pageLink') {
        <a class="cn-page-link" [routerLink]="['/c', store?.id(), 'p', n.attrs?.['pageId']]">{{ pageTitle(n) }}</a>
      }
      @case ('placeholder') {<span class="cn-placeholder">{{ n.attrs?.['label'] || n.attrs?.['name'] }}</span>}
      @default {<span>{{ n.text ?? '' }}</span>}
    }
  }`,
})
export class InlineContent {
  readonly nodes = input<ViewNode[]>([]);
  protected readonly store = inject(CampaignStore, { optional: true });
  protected classes(n: ViewNode) {
    return (n.marks ?? []).map((m) => MARK_CLASS[m.type] ?? '').join(' ');
  }
  protected href(n: ViewNode): string | null {
    const link = n.marks?.find((m) => m.type === 'link');
    const h = link?.attrs?.['href'];
    return typeof h === 'string' && /^(https?:|mailto:)/i.test(h) ? h : null;
  }
  protected pageTitle(n: ViewNode) {
    const id = String(n.attrs?.['pageId'] ?? '');
    return this.store?.byId().get(id)?.title ?? String(n.attrs?.['label'] ?? '');
  }
}

@Component({
  selector: 'cn-ref-embed-block',
  imports: [EntityView],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `@if (entity.hasValue()) {
      <div class="cn-embed"><cn-entity-view [entity]="entity.value()" [compact]="compact()" /></div>
    } @else if (entity.error()) {
      <p class="cn-unsupported">Reference not available.</p>
    }`,
})
export class RefEmbedBlock {
  readonly uid = input.required<string>();
  readonly compact = input(false);
  private readonly context = inject(ContextService);
  protected readonly entity = httpResource<EntityDto>(() => ({ url: api.entity(this.uid()), params: this.context.params() }));
}

@Component({
  selector: 'cn-query-block',
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<div class="cn-embed">
    @if (title()) {<div class="font-semibold">{{ title() }}</div>}
    <ul class="cn-query-results">
      @for (row of rows(); track row.id) {
        <li><a [routerLink]="['/c', store?.id(), 'p', row.id]">{{ row.icon || icons[row.type] }} {{ row.title }}</a></li>
      } @empty {<li class="text-muted">No matching pages</li>}
    </ul>
  </div>`,
})
export class QueryBlock {
  readonly filter = input.required<unknown>();
  readonly title = input('');
  readonly pageId = input<string | null>(null);
  protected readonly store = inject(CampaignStore, { optional: true });
  protected readonly icons = PAGE_TYPE_ICONS;
  protected readonly results = httpResource<{ rows: QueryRowDto[] }>(() => {
    const id = this.store?.id();
    return id ? { url: `/api/campaigns/${id}/query`, method: 'POST', body: { filter: this.filter(), contextPageId: this.pageId() } } : undefined;
  });
  protected readonly rows = computed(() => (this.results.hasValue() ? this.results.value().rows : []));
}

@Component({
  selector: 'cn-tabs-block',
  imports: [forwardRef(() => BlockNodes)],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<div class="cn-tabs">
    <div class="flex gap-1 border-b border-line" role="tablist">
      @for (tab of tabs(); track $index; let i = $index) {
        <button type="button" role="tab" class="px-3 py-1 text-sm" [class.font-bold]="i === active()" [class.border-b-2]="i === active()" [attr.aria-selected]="i === active()" (click)="active.set(i)">
          {{ tab.attrs?.['title'] || 'Tab ' + (i + 1) }}
        </button>
      }
    </div>
    @if (tabs()[active()]; as tab) {
      <div role="tabpanel"><cn-block-nodes [nodes]="tab.content ?? []" [pageId]="pageId()" /></div>
    }
  </div>`,
})
export class TabsBlock {
  readonly tabs = input<ViewNode[]>([]);
  readonly pageId = input<string | null>(null);
  protected readonly active = signal(0);
}

/** Read-only rendering of block nodes (used for player views, previews and embeds). */
@Component({
  selector: 'cn-block-nodes',
  imports: [InlineContent, RefEmbedBlock, QueryBlock, TabsBlock, RouterLink, Roll],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'contents' },
  templateUrl: './block-view.html',
})
export class BlockNodes {
  readonly nodes = input<ViewNode[]>([]);
  readonly pageId = input<string | null>(null);
  protected readonly store = inject(CampaignStore, { optional: true });
  protected readonly icons = PAGE_TYPE_ICONS;
  protected imageUrl = (src: unknown) => imageSrcUrl(src as never);
  protected tableRoll(n: ViewNode): string | null {
    const roll = n.attrs?.['roll'];
    return typeof roll === 'string' && /^\d*d\d+$/i.test(roll) ? (roll.startsWith('d') ? `1${roll}` : roll) : null;
  }
  protected page(n: ViewNode) {
    const id = n.attrs?.['pageId'];
    return typeof id === 'string' ? (this.store?.byId().get(id) ?? null) : null;
  }
  protected items(n: ViewNode): { label: string; value: string }[] {
    return (n.attrs?.['items'] as { label: string; value: string }[] | undefined) ?? [];
  }
  protected galleryImages(n: ViewNode): { src: unknown; caption: string }[] {
    return (n.attrs?.['images'] as { src: unknown; caption: string }[] | undefined) ?? [];
  }
  protected lootItems(n: ViewNode): { name: string; qty: number; note: string }[] {
    return (n.attrs?.['items'] as { name: string; qty: number; note: string }[] | undefined) ?? [];
  }
  protected lootCoins(n: ViewNode): string {
    const coins = (n.attrs?.['coins'] as Record<string, number> | undefined) ?? {};
    return ['pp', 'gp', 'ep', 'sp', 'cp']
      .filter((c) => (coins[c] ?? 0) > 0)
      .map((c) => `${coins[c]} ${c}`)
      .join(', ');
  }
  protected summary(n: ViewNode): ViewNode[] {
    return n.content?.find((c) => c.type === 'detailsSummary')?.content ?? [];
  }
  protected detailsBody(n: ViewNode): ViewNode[] {
    return n.content?.find((c) => c.type === 'detailsContent')?.content ?? [];
  }
}

@Component({
  selector: 'cn-block-view',
  imports: [BlockNodes],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<div class="cn-prose cn-block-view"><cn-block-nodes [nodes]="doc()?.content ?? []" [pageId]="pageId()" /></div>`,
})
export class BlockView {
  readonly doc = input<{ content?: ViewNode[] } | null>(null);
  readonly pageId = input<string | null>(null);
}
