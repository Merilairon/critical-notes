import { HttpClient } from '@angular/common/http';
import type { ElementRef} from '@angular/core';
import { ChangeDetectionStrategy, Component, computed, inject, input, output, signal, viewChild } from '@angular/core';
import { kindForTag } from '@cn/fivetools';
import type { SearchHitDto } from '@cn/shared';
import { firstValueFrom } from 'rxjs';
import { api } from '../core/api';
import { TAG_CHOICES } from '../editor/suggestion/tag-choices';

/** What the user is typing at the caret: a tag name after "{@", or an entity name after "{@tag ". */
export type TagContext = { mode: 'tag'; start: number; query: string } | { mode: 'entity'; start: number; tag: string; kind: string; query: string } | null;

export function tagContext(before: string): TagContext {
  const m = /\{@([A-Za-z0-9]*)(?:\s([^{}|]*))?$/.exec(before);
  if (!m) return null;
  const start = m.index;
  if (m[2] === undefined) return { mode: 'tag', start, query: m[1]!.toLowerCase() };
  const kind = kindForTag(m[1]!.toLowerCase());
  return kind ? { mode: 'entity', start, tag: m[1]!.toLowerCase(), kind, query: m[2] } : null;
}

export interface Completion {
  label: string;
  detail: string;
  /** Replaces the text from the context start to the caret. */
  insert: string;
  /** Keep completing after inserting (a tag name is followed by the entity search). */
  continues?: boolean;
}

/** Entity tags always carry an explicit source: 2024 content is not the tag default. */
export function entityCompletion(tag: string, hit: Pick<SearchHitDto, 'name' | 'source'>): string {
  return `{@${tag} ${hit.name}|${hit.source}}`;
}

let nextListId = 0;

/** A textarea for 5etools text with a formatting toolbar and `{@` autocomplete. */
@Component({
  selector: 'cn-tag-textarea',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'relative block' },
  template: `<div class="flex flex-wrap gap-0.5 text-xs" role="toolbar" [attr.aria-label]="'Insert into ' + label()">
      @for (b of buttons; track b.label) {
        <button type="button" class="rounded px-1.5 py-0.5 text-muted hover:bg-panel-2 hover:text-ink" [title]="b.title" (mousedown)="$event.preventDefault()" (click)="apply(b)">
          {{ b.label }}
        </button>
      }
    </div>
    <textarea
      #area
      class="block w-full rounded-md border border-control bg-bg px-2 py-1.5 font-mono text-sm leading-snug"
      [rows]="rows()"
      [value]="value()"
      [attr.aria-label]="label()"
      aria-autocomplete="list"
      aria-haspopup="listbox"
      [attr.aria-controls]="items().length ? listId : null"
      [attr.aria-activedescendant]="items().length ? listId + '-' + active() : null"
      [placeholder]="placeholder()"
      (input)="onInput()"
      (keydown)="onKey($event)"
      (blur)="close()"
      (click)="refresh()"
    ></textarea>
    <div class="sr-only" role="status">{{ status() }}</div>
    @if (items().length) {
      <ul [id]="listId" class="absolute right-0 left-0 z-30 mt-1 max-h-64 overflow-y-auto rounded-md border border-line bg-panel py-1 shadow-xl" role="listbox" [attr.aria-label]="label() + ' suggestions'">
        @for (item of items(); track item.insert; let i = $index) {
          <li
            role="option"
            [id]="listId + '-' + i"
            class="flex w-full cursor-pointer items-baseline gap-2 px-3 py-1 text-left text-sm touch:min-h-[44px] touch:items-center"
            [class.bg-panel-2]="i === active()"
            [attr.aria-selected]="i === active()"
            (mousedown)="$event.preventDefault(); choose(item)"
            (mouseenter)="active.set(i)"
          >
            <span class="truncate">{{ item.label }}</span><span class="shrink-0 text-xs text-muted">{{ item.detail }}</span>
          </li>
        }
      </ul>
    }`,
})
export class TagTextarea {
  readonly value = input('');
  readonly label = input('Text');
  readonly rows = input(3);
  readonly placeholder = input('');
  /** Query parameters for reference autocomplete (rules context). */
  readonly searchParams = input<Record<string, string>>({});
  readonly changed = output<string>();

  private readonly http = inject(HttpClient);
  private readonly area = viewChild.required<ElementRef<HTMLTextAreaElement>>('area');
  protected readonly items = signal<Completion[]>([]);
  protected readonly active = signal(0);
  protected readonly listId = `cn-tag-list-${nextListId++}`;
  /** Read out by screen readers when the suggestions change (live region). */
  protected readonly status = computed(() => {
    const n = this.items().length;
    return n ? `${n} ${n === 1 ? 'suggestion' : 'suggestions'}. Use the up and down arrow keys, Enter to insert.` : '';
  });
  private context: TagContext = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private requestId = 0;

  protected readonly buttons = [
    { label: 'B', title: 'Bold', wrap: ['{@b ', '}'] },
    { label: 'I', title: 'Italic', wrap: ['{@i ', '}'] },
    { label: 'dice', title: 'Dice roll', insert: '{@dice 1d6}' },
    { label: 'damage', title: 'Damage roll', insert: '{@damage 2d6}' },
    { label: 'DC', title: 'Difficulty class', insert: '{@dc 13}' },
    { label: 'hit', title: 'To-hit bonus', insert: '{@hit 5}' },
    { label: '{@ ref', title: 'Reference a spell, creature, item…', insert: '{@' },
  ] as const;

  protected apply(b: (typeof this.buttons)[number]) {
    const el = this.area().nativeElement;
    const { selectionStart: s, selectionEnd: e, value } = el;
    const text = 'wrap' in b ? `${b.wrap[0]}${value.slice(s, e) || 'text'}${b.wrap[1]}` : b.insert;
    el.setRangeText(text, s, e, 'end');
    el.focus();
    this.emit();
    this.refresh();
  }

  protected onInput() {
    this.emit();
    this.refresh();
  }

  private emit() {
    this.changed.emit(this.area().nativeElement.value);
  }

  protected refresh() {
    const el = this.area().nativeElement;
    this.context = tagContext(el.value.slice(0, el.selectionStart));
    clearTimeout(this.timer);
    const ctx = this.context;
    if (!ctx) return this.close();
    if (ctx.mode === 'tag') {
      this.items.set(
        TAG_CHOICES.filter((t) => !ctx.query || t.tag.startsWith(ctx.query) || t.label.toLowerCase().includes(ctx.query)).map((t) =>
          t.free ? { label: t.label, detail: `{@${t.tag}}`, insert: `{@${t.tag} ${t.free}}` } : { label: t.label, detail: `{@${t.tag}}`, insert: `{@${t.tag} `, continues: true },
        ),
      );
      this.active.set(0);
      return;
    }
    if (ctx.query.trim().length < 1) return this.items.set([]);
    const id = ++this.requestId;
    this.timer = setTimeout(async () => {
      const res = await firstValueFrom(
        this.http.get<{ hits: SearchHitDto[] }>(api.autocomplete(ctx.kind), { params: { ...this.searchParams(), q: ctx.query.trim() } }),
      ).catch(() => ({ hits: [] }));
      if (id !== this.requestId) return;
      this.items.set(res.hits.map((h) => ({ label: h.name, detail: h.source, insert: entityCompletion(ctx.tag, h) })));
      this.active.set(0);
    }, 150);
  }

  protected choose(item: Completion) {
    const el = this.area().nativeElement;
    if (!this.context) return;
    el.setRangeText(item.insert, this.context.start, el.selectionStart, 'end');
    this.emit();
    if (item.continues) this.refresh();
    else this.close();
  }

  protected onKey(e: KeyboardEvent) {
    if (e.isComposing || e.keyCode === 229) return; // an IME is choosing a candidate
    const items = this.items();
    if (!items.length) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      this.active.update((i) => (e.key === 'ArrowDown' ? Math.min(items.length - 1, i + 1) : Math.max(0, i - 1)));
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      this.choose(items[this.active()]!);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      this.close();
    }
  }

  protected close() {
    this.requestId++;
    this.items.set([]);
  }
}
