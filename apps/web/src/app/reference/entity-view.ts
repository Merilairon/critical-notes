import { afterNextRender, ChangeDetectionStrategy, Component, computed, DestroyRef, effect, ElementRef, inject, input, signal, type WritableSignal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { isObject } from '@cn/fivetools';
import type { EntityDto } from '@cn/shared';
import { watchHeadingLevels } from '../blocks/heading-levels';
import { ContextService } from '../core/context.service';
import { imgUrl } from '../core/urls';
import { Entries } from './render/entries';
import { RENDER_EDITION } from './render/entry';
import { EntityLink } from './render/entity-link';
import { CharacterOptionBlock } from './statblocks/character-option-block';
import { ClassView } from './statblocks/class-view';
import { GenericBlock } from './statblocks/generic-block';
import { ItemBlock } from './statblocks/item-block';
import { MonsterStatblock } from './statblocks/monster-statblock';
import { SpellBlock } from './statblocks/spell-block';

const CHARACTER_OPTION_KINDS = new Set(['race', 'background', 'feat', 'optionalfeature', 'deity', 'charoption', 'reward', 'boon', 'cult', 'psionic']);

/** Full rendering of a reference entity: header, edition/reprint info, statblock, lore and images. */
@Component({
  selector: 'cn-entity-view',
  imports: [RouterLink, Entries, EntityLink, MonsterStatblock, SpellBlock, ItemBlock, CharacterOptionBlock, ClassView, GenericBlock],
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [{ provide: RENDER_EDITION, useFactory: () => signal<string>('') }],
  templateUrl: './entity-view.html',
})
export class EntityView {
  readonly entity = input.required<EntityDto>();
  /** Compact mode for hover previews: no lore, smaller header. */
  readonly compact = input(false);
  private readonly context = inject(ContextService);

  private readonly renderEdition = inject(RENDER_EDITION) as WritableSignal<string>;
  protected readonly ruleset = this.context.ruleset;
  protected readonly referenceBase = this.context.referenceBase;

  constructor() {
    effect(() => this.renderEdition.set(this.entity().edition));
    // The statblock and entry headings never skip a level below the page heading (aria-level only)
    const host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
    const destroy = inject(DestroyRef);
    afterNextRender(() => destroy.onDestroy(watchHeadingLevels(host)));
  }

  protected readonly block = computed(() => {
    const kind = this.entity().kind;
    if (kind === 'monster') return 'monster';
    if (kind === 'spell') return 'spell';
    if (kind === 'item') return 'item';
    if (kind === 'class' || kind === 'subclass') return 'class';
    if (CHARACTER_OPTION_KINDS.has(kind)) return 'option';
    return 'generic';
  });

  protected readonly kindLabel = computed(() => {
    const kind = this.entity().kind;
    if (kind === 'race') return this.ruleset().terminology.race;
    return kind.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase());
  });

  protected readonly image = computed(() => imgUrl(this.entity().tokenPath) ?? null);
  protected readonly art = computed(() => imgUrl(this.entity().imagePath) ?? null);
  protected readonly fluffEntries = computed(() => {
    const f = this.entity().fluff;
    return f && Array.isArray(f['entries']) ? (f['entries'] as unknown[]) : [];
  });
  protected readonly fluffImages = computed(() => {
    const f = this.entity().fluff;
    return (f && Array.isArray(f['images']) ? (f['images'] as unknown[]) : []).slice(0, 6).map((img) => ({ type: 'image', ...(isObject(img) ? img : {}) }));
  });

  /** "Reprinted as" banner: the campaign prefers another member of this entity's reprint group. */
  protected readonly preferred = computed(() => {
    const e = this.entity();
    if (e.preferredUid === e.uid) return null;
    return e.reprintGroup.find((m) => m.uid === e.preferredUid) ?? null;
  });
  protected readonly otherPrintings = computed(() => this.entity().reprintGroup.filter((m) => m.uid !== this.entity().uid));
  protected readonly missingReprints = computed(() => this.entity().reprintedAs.filter((r) => !r.exists));

  protected badgeLabel(badge: string | null): string | null {
    if (badge === 'legacy') return 'Legacy';
    if (badge === 'modern') return '2024';
    return null;
  }
}
