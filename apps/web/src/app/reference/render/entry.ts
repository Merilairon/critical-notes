import { ChangeDetectionStrategy, Component, computed, inject, InjectionToken, input, type Signal } from '@angular/core';
import {
  entityUid,
  isObject,
  parseEntityTag,
  spellcastingBlock,
  splitTagArgs,
  stripTags,
  styleForEdition,
  type JsonObject,
} from '@cn/fivetools';
import type { RelatedEntityDto } from '@cn/shared';
import { imgUrl } from '../../core/urls';
import { EntityLink } from './entity-link';
import { Inline } from './inline';
import { Roll } from './roll';

/** Entities resolved alongside the current one (class features, subclasses), for `ref*` entries. */
export const RELATED_ENTITIES = new InjectionToken<Signal<Record<string, RelatedEntityDto>>>('RELATED_ENTITIES');
/** Edition of the entity being rendered (controls classic vs 2024 phrasing in nested blocks). */
export const RENDER_EDITION = new InjectionToken<Signal<string>>('RENDER_EDITION');

type EntryKind =
  | 'string' | 'number' | 'entries' | 'list' | 'table' | 'tableGroup' | 'inset' | 'readaloud' | 'quote' | 'variant' | 'image'
  | 'gallery' | 'hr' | 'inline' | 'link' | 'dice' | 'abilityDc' | 'abilityAttackMod' | 'abilityGeneric' | 'options' | 'statblock'
  | 'ref' | 'item' | 'flow' | 'homebrew' | 'code' | 'wrapper' | 'spellcasting' | 'actions' | 'attack' | 'unknown' | 'empty';

const KIND_BY_TYPE: Record<string, EntryKind> = {
  entries: 'entries', section: 'entries', chapter: 'entries', list: 'list', table: 'table', tableGroup: 'tableGroup',
  inset: 'inset', insetReadaloud: 'readaloud', quote: 'quote', variant: 'variant', variantInner: 'variant', variantSub: 'variant',
  image: 'image', gallery: 'gallery', hr: 'hr', inline: 'inline', inlineBlock: 'inline', link: 'link', dice: 'dice',
  abilityDc: 'abilityDc', abilityAttackMod: 'abilityAttackMod', abilityGeneric: 'abilityGeneric', options: 'options',
  statblock: 'statblock', statblockInline: 'statblock', refClassFeature: 'ref', refSubclassFeature: 'ref', refOptionalfeature: 'ref',
  refFeat: 'ref', item: 'item', itemSub: 'item', itemSpell: 'item', flowchart: 'flow', flowBlock: 'flow', homebrew: 'homebrew',
  code: 'code', wrapper: 'wrapper', spellcasting: 'spellcasting', actions: 'actions', attack: 'attack', cell: 'wrapper',
};

const ABIL: Record<string, string> = { str: 'Strength', dex: 'Dexterity', con: 'Constitution', int: 'Intelligence', wis: 'Wisdom', cha: 'Charisma', spellcasting: 'spellcasting ability' };

@Component({
  selector: 'cn-entry',
  imports: [Inline, Roll, EntityLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'contents' },
  templateUrl: './entry.html',
})
export class Entry {
  readonly entry = input.required<unknown>();
  readonly depth = input(0);
  /** Render strings without paragraph wrappers (table cells, list items). */
  readonly inlineMode = input(false);

  private readonly related = inject(RELATED_ENTITIES, { optional: true });
  private readonly renderEdition = inject(RENDER_EDITION, { optional: true });

  protected readonly kind = computed<EntryKind>(() => {
    const e = this.entry();
    if (e == null) return 'empty';
    if (typeof e === 'string') return 'string';
    if (typeof e === 'number') return 'number';
    if (Array.isArray(e)) return 'wrapper';
    if (!isObject(e)) return 'unknown';
    if (typeof e.type !== 'string') return Array.isArray(e.entries) ? 'entries' : 'unknown';
    return KIND_BY_TYPE[e.type] ?? 'unknown';
  });

  protected readonly obj = computed(() => (isObject(this.entry()) ? (this.entry() as JsonObject) : ({} as JsonObject)));
  protected readonly str = computed(() => String(this.entry() ?? ''));
  protected readonly name = computed(() => (typeof this.obj()['name'] === 'string' ? (this.obj()['name'] as string) : null));
  protected readonly children = computed<unknown[]>(() => {
    const o = this.obj();
    if (Array.isArray(this.entry())) return this.entry() as unknown[];
    if (Array.isArray(o['entries'])) return o['entries'] as unknown[];
    if (o['entry'] != null) return [o['entry']];
    if (Array.isArray(o['items'])) return o['items'] as unknown[];
    if (o['wrapped'] != null) return [o['wrapped']];
    return [];
  });

  /** For named entries at depth ≥ 2: render the name inline before the first paragraph. */
  protected readonly inlineHeader = computed(() => this.depth() >= 2 && !!this.name() && typeof this.children()[0] === 'string');

  protected readonly listClass = computed(() => {
    const style = String(this.obj()['style'] ?? '');
    if (style.includes('hang')) return 'cn-list-hang';
    if (style.includes('no-bullets') || style.includes('notitle')) return 'cn-list-plain';
    return '';
  });
  protected readonly listOrdered = computed(() => String(this.obj()['style'] ?? '').includes('decimal'));

  // region Tables
  protected readonly colLabels = computed(() => (Array.isArray(this.obj()['colLabels']) ? (this.obj()['colLabels'] as unknown[]) : []));
  protected readonly rows = computed<unknown[][]>(() =>
    (Array.isArray(this.obj()['rows']) ? (this.obj()['rows'] as unknown[]) : []).map((r) =>
      Array.isArray(r) ? r : isObject(r) && Array.isArray(r['row']) ? (r['row'] as unknown[]) : [r],
    ),
  );
  /** Dice expression from a first column label like "d8" or "1d20". */
  protected readonly tableDice = computed(() => {
    const first = this.colLabels()[0];
    if (typeof first !== 'string') return null;
    const m = /^\s*\{@dice ([^}|]+)/.exec(first) ?? /^\s*(\d*d\d+)\s*$/i.exec(stripTags(first));
    return m ? m[1]! : null;
  });
  protected cellText(cell: unknown): string | null {
    if (isObject(cell) && cell['type'] === 'cell' && isObject(cell['roll'])) {
      const roll = cell['roll'];
      const pad = (n: unknown) => (roll['pad'] ? String(n).padStart(2, '0') : String(n));
      if (roll['exact'] != null) return pad(roll['exact']);
      return `${pad(roll['min'])}–${pad(roll['max'])}`;
    }
    return null;
  }
  protected cellEntry(cell: unknown): unknown {
    return isObject(cell) && cell['type'] === 'cell' ? cell['entry'] : cell;
  }
  protected readonly tables = computed(() => (Array.isArray(this.obj()['tables']) ? (this.obj()['tables'] as unknown[]) : []));
  // endregion

  // region Images
  protected imageSrc(img: unknown): string | null {
    if (!isObject(img) || !isObject(img['href'])) return null;
    const href = img['href'];
    if (href['type'] === 'internal' && typeof href['path'] === 'string') return imgUrl(href['path']);
    if (href['type'] === 'external' && typeof href['url'] === 'string' && /^https:\/\//i.test(href['url'])) return href['url'];
    return null;
  }
  protected readonly images = computed(() => (Array.isArray(this.obj()['images']) ? (this.obj()['images'] as unknown[]) : []));
  protected imageTitle(img: unknown): string | null {
    return isObject(img) && typeof img['title'] === 'string' ? img['title'] : null;
  }
  protected imageCredit(img: unknown): string | null {
    return isObject(img) && typeof img['credit'] === 'string' ? img['credit'] : null;
  }
  // endregion

  // region Small types
  protected readonly attributes = computed(() =>
    (Array.isArray(this.obj()['attributes']) ? (this.obj()['attributes'] as string[]) : []).map((a) => ABIL[a] ?? a),
  );
  protected joinOr(items: string[]): string {
    return items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} or ${items.at(-1)}`;
  }
  protected readonly diceExpr = computed(() => {
    const o = this.obj();
    const toRoll = Array.isArray(o['toRoll']) ? (o['toRoll'] as JsonObject[]) : [];
    return toRoll.map((t) => `${String(t['number'] ?? 1)}d${String(t['faces'] ?? 6)}${t['modifier'] ? `+${String(t['modifier'])}` : ''}`).join('+');
  });
  protected readonly linkText = computed(() => String(this.obj()['text'] ?? ''));
  protected readonly linkHref = computed(() => {
    const href = this.obj()['href'];
    if (isObject(href) && href['type'] === 'external' && typeof href['url'] === 'string' && /^https?:\/\//i.test(href['url'])) return href['url'];
    return null;
  });
  protected readonly quoteBy = computed(() => {
    const o = this.obj();
    return [o['by'], o['from']].filter((x) => typeof x === 'string').join(', ') || null;
  });
  protected readonly preformatted = computed(() => String(this.obj()['preformatted'] ?? ''));
  // endregion

  // region References
  protected readonly ref = computed(() => {
    const o = this.obj();
    const pairs: [string, string][] = [
      ['classFeature', 'classFeature'],
      ['subclassFeature', 'subclassFeature'],
      ['optionalfeature', 'optfeature'],
      ['feat', 'feat'],
    ];
    for (const [prop, tag] of pairs) {
      if (typeof o[prop] !== 'string') continue;
      const parsed = parseEntityTag(tag, splitTagArgs(o[prop] as string));
      if (!parsed) return null;
      const uid = entityUid(parsed.kind, parsed.identity);
      return { uid, kind: parsed.kind, name: parsed.display ?? parsed.name, resolved: this.related?.()[uid] ?? null };
    }
    if (o['type'] === 'statblock' || o['type'] === 'statblockInline') {
      const tag = typeof o['tag'] === 'string' ? o['tag'] : 'creature';
      const name = typeof o['name'] === 'string' ? o['name'] : isObject(o['data']) ? String(o['data']['name'] ?? '') : '';
      const source = typeof o['source'] === 'string' ? o['source'] : '';
      const parsed = parseEntityTag(tag, [name, source]);
      return parsed ? { uid: entityUid(parsed.kind, parsed.identity), kind: parsed.kind, name: String(o['displayName'] ?? parsed.name), resolved: null } : null;
    }
    return null;
  });
  protected relatedEntries(r: RelatedEntityDto): unknown[] {
    return Array.isArray(r.data['entries']) ? (r.data['entries'] as unknown[]) : [];
  }
  // endregion

  protected readonly spellcasting = computed(() => spellcastingBlock(this.obj(), styleForEdition(this.renderEdition?.() ?? 'classic')));

  /** Best-effort text for unsupported entry types. */
  protected readonly fallbackText = computed(() => {
    const parts: string[] = [];
    const walk = (v: unknown) => {
      if (typeof v === 'string') parts.push(stripTags(v));
      else if (Array.isArray(v)) v.forEach(walk);
      else if (isObject(v)) Object.entries(v).forEach(([k, x]) => k !== 'type' && walk(x));
    };
    walk(this.entry());
    return parts.join(' ').slice(0, 600);
  });
  protected readonly typeName = computed(() => String(this.obj()['type'] ?? 'unknown'));
}
