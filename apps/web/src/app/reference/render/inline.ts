import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { renderInline, type InlineRender } from '@cn/fivetools';
import { ContextService } from '../../core/context.service';
import { imgUrl } from '../../core/urls';
import { EntityLink } from './entity-link';
import { Roll } from './roll';

/**
 * Renders 5etools inline markup (or pre-rendered nodes) as text and elements.
 * Never uses innerHTML: all text goes through interpolation.
 */
@Component({
  selector: 'cn-inline',
  imports: [EntityLink, Roll, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'contents' },
  template: `@for (node of nodes(); track $index) {
    @switch (node.t) {
      @case ('text') {<ng-container>{{ asText(node).text }}</ng-container>}
      @case ('style') {
        <span [class]="styleClass(node)" [style.color]="asStyle(node).color ?? null" [attr.title]="asStyle(node).title ?? null"
          ><cn-inline [nodes]="asStyle(node).children"
        /></span>
      }
      @case ('entity') {
        <cn-entity-link [uid]="asEntity(node).uid" [kind]="asEntity(node).kind"><cn-inline [nodes]="asEntity(node).children" /></cn-entity-link>
      }
      @case ('roll') {
        <cn-roll [expr]="asRoll(node).expr" [label]="asRoll(node).label"><cn-inline [nodes]="asRoll(node).children" /></cn-roll>
      }
      @case ('external') {
        <a class="cn-link" [href]="asExternal(node).href" target="_blank" rel="noopener noreferrer nofollow"
          ><cn-inline [nodes]="asExternal(node).children"
        /></a>
      }
      @case ('filter') {
        <a class="cn-link" [routerLink]="[...context.referenceBase(), asFilter(node).page]" [queryParams]="asFilter(node).filters"
          ><cn-inline [nodes]="asFilter(node).children"
        /></a>
      }
      @case ('image') {
        @if (imageHref(node); as href) {
          <a class="cn-link" [href]="href" target="_blank" rel="noopener"><cn-inline [nodes]="asImage(node).children" /></a>
        }
      }
      @case ('ref') {
        <span class="cn-ref" [title]="asRef(node).source"><cn-inline [nodes]="asRef(node).children" /></span>
      }
    }
  }`,
})
export class Inline {
  /** Raw markup string… */
  readonly text = input<string | null | undefined>(null);
  /** …or pre-rendered nodes. */
  readonly nodesInput = input<InlineRender[] | null>(null, { alias: 'nodes' });

  protected readonly context = inject(ContextService);
  protected readonly nodes = computed<InlineRender[]>(() => this.nodesInput() ?? (this.text() != null ? renderInline(String(this.text())) : []));

  protected asText = (n: InlineRender) => n as Extract<InlineRender, { t: 'text' }>;
  protected asStyle = (n: InlineRender) => n as Extract<InlineRender, { t: 'style' }>;
  protected asEntity = (n: InlineRender) => n as Extract<InlineRender, { t: 'entity' }>;
  protected asRoll = (n: InlineRender) => n as Extract<InlineRender, { t: 'roll' }>;
  protected asExternal = (n: InlineRender) => n as Extract<InlineRender, { t: 'external' }>;
  protected asFilter = (n: InlineRender) => n as Extract<InlineRender, { t: 'filter' }>;
  protected asImage = (n: InlineRender) => n as Extract<InlineRender, { t: 'image' }>;
  protected asRef = (n: InlineRender) => n as Extract<InlineRender, { t: 'ref' }>;

  protected styleClass(n: InlineRender): string {
    return (n as Extract<InlineRender, { t: 'style' }>).styles.map((s) => `cn-s-${s}`).join(' ');
  }

  protected imageHref(n: InlineRender): string | null {
    return imgUrl((n as Extract<InlineRender, { t: 'image' }>).path);
  }
}
