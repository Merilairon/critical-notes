import { HttpClient, httpResource } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, computed, inject, signal, viewChild, type ElementRef } from '@angular/core';
import { RouterLink } from '@angular/router';
import { isSafeImagePath } from '@cn/fivetools';
import { PAGE_TYPE_ICONS, PAGE_TYPE_LABELS, PAGE_TYPES, type EntityDto, type QueryRowDto, type UploadDto } from '@cn/shared';
import { AngularNodeViewComponent } from 'ngx-tiptap';
import { firstValueFrom } from 'rxjs';
import { CampaignStore } from '../../campaign/campaign.store';
import { PagePicker } from '../../campaign/page-picker';
import { RefPicker } from '../../campaign/ref-picker';
import { api } from '../../core/api';
import { ContextService } from '../../core/context.service';
import { errorMessage } from '../../core/http.interceptor';
import { imgUrl } from '../../core/urls';
import { EntityView } from '../../reference/entity-view';
import { EDITOR_CONTEXT } from '../editor-context';
import { QueryColumns } from './query-columns';
import { effectiveColumns, normalizeColumns, normalizeView, resolveColumn, type ColumnContext } from './query-model';
import { QueryResults } from './query-results';

let nextQueryViewId = 0;

type ImageSrc = { kind: 'upload'; id: string } | { kind: 'img'; path: string } | { kind: 'url'; url: string } | null;

export function imageSrcUrl(src: ImageSrc): string | null {
  if (!src) return null;
  if (src.kind === 'upload') return `/api/uploads/${encodeURIComponent(src.id)}`;
  if (src.kind === 'img') return imgUrl(src.path);
  return /^https:\/\//i.test(src.url) ? src.url : null;
}

@Component({
  selector: 'cn-image-view',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<figure class="cn-image-block" [attr.data-style]="style()" contenteditable="false" [class.ring-2]="selected()">
    @if (url(); as u) {
      <img [src]="u" [alt]="alt()" loading="lazy" referrerpolicy="no-referrer" />
      <input class="cn-image-caption" placeholder="Caption…" [value]="caption()" (change)="updateAttributes()({ caption: $any($event.target).value })" />
      <div class="cn-block-tools">
        <select (change)="updateAttributes()({ style: $any($event.target).value })" aria-label="Image style">
          @for (s of styles; track s) {<option [value]="s" [selected]="s === style()">{{ s }}</option>}
        </select>
        <button type="button" (click)="updateAttributes()({ src: null })">Replace</button>
      </div>
    } @else {
      <div class="cn-embed-empty">
        <div class="font-semibold">Image</div>
        <label class="cn-block-btn">Upload…<input type="file" accept="image/png,image/jpeg,image/gif,image/webp" hidden (change)="upload($any($event.target).files?.[0])" /></label>
        <input placeholder="5etools image path, e.g. bestiary/MM/Goblin.webp" (change)="usePath($any($event.target).value)" />
        <input placeholder="or https:// URL" (change)="useUrl($any($event.target).value)" />
        @if (busy()) {<span class="text-muted">Uploading…</span>}
        @if (error()) {<span class="text-accent">{{ error() }}</span>}
      </div>
    }
  </figure>`,
})
export class ImageView extends AngularNodeViewComponent {
  private readonly http = inject(HttpClient);
  private readonly store = inject(CampaignStore, { optional: true });
  protected readonly styles = ['inline', 'wide', 'map'];
  protected readonly busy = signal(false);
  protected readonly error = signal('');
  protected readonly url = computed(() => imageSrcUrl(this.node().attrs['src'] as ImageSrc));
  protected readonly alt = computed(() => String(this.node().attrs['alt'] ?? ''));
  protected readonly caption = computed(() => String(this.node().attrs['caption'] ?? ''));
  protected readonly style = computed(() => String(this.node().attrs['style'] ?? 'inline'));

  protected async upload(file: File | undefined) {
    if (!file || !this.store?.id()) return;
    this.busy.set(true);
    this.error.set('');
    try {
      const form = new FormData();
      form.append('file', file);
      const res = await firstValueFrom(this.http.post<UploadDto>(`/api/campaigns/${this.store.id()}/uploads`, form));
      this.updateAttributes()({ src: { kind: 'upload', id: res.id }, alt: file.name });
    } catch (err) {
      this.error.set(errorMessage(err));
    } finally {
      this.busy.set(false);
    }
  }
  protected usePath(path: string) {
    const p = path.trim().replace(/^\/?img\//, '');
    if (isSafeImagePath(p)) this.updateAttributes()({ src: { kind: 'img', path: p } });
    else this.error.set('Not a valid 5etools image path');
  }
  protected useUrl(url: string) {
    if (/^https:\/\//i.test(url.trim())) this.updateAttributes()({ src: { kind: 'url', url: url.trim() } });
    else this.error.set('Only https:// URLs are allowed');
  }
}

const EMBED_KINDS = [
  { kind: 'monster', label: 'Creature' },
  { kind: 'spell', label: 'Spell' },
  { kind: 'item', label: 'Item' },
  { kind: 'condition', label: 'Condition' },
  { kind: 'feat', label: 'Feat' },
  { kind: 'race', label: 'Species / race' },
  { kind: 'background', label: 'Background' },
  { kind: 'variantrule', label: 'Rule' },
  { kind: 'trap', label: 'Trap' },
  { kind: 'hazard', label: 'Hazard' },
  { kind: 'table', label: 'Table' },
];

@Component({
  selector: 'cn-ref-embed-view',
  imports: [RefPicker, EntityView],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<div class="cn-embed" contenteditable="false" [class.ring-2]="selected()">
    @if (uid()) {
      <div class="cn-block-tools">
        <button type="button" (click)="toggleDisplay()">{{ display() === 'full' ? 'Compact' : 'Full' }}</button>
        <button type="button" (click)="updateAttributes()({ uid: null })">Change</button>
      </div>
      @if (entity.hasValue()) {
        <cn-entity-view [entity]="entity.value()" [compact]="display() === 'compact'" />
      } @else if (entity.error()) {
        <p class="text-sm text-muted">This reference is not available in this campaign's sources.</p>
      } @else {
        <p class="text-sm text-muted">Loading…</p>
      }
    } @else {
      <div class="cn-embed-empty">
        <div class="font-semibold">Embed from the reference</div>
        <select (change)="pickKind.set($any($event.target).value)" aria-label="Reference kind">
          @for (k of kinds; track k.kind) {<option [value]="k.kind" [selected]="k.kind === pickKind()">{{ k.label }}</option>}
        </select>
        <cn-ref-picker [kind]="pickKind()" placeholder="Search…" (selected)="choose($event)" />
      </div>
    }
  </div>`,
})
export class RefEmbedView extends AngularNodeViewComponent {
  private readonly context = inject(ContextService);
  protected readonly kinds = EMBED_KINDS;
  protected readonly pickKind = signal('monster');
  protected readonly uid = computed(() => (this.node().attrs['uid'] as string | null) ?? null);
  protected readonly display = computed(() => String(this.node().attrs['display'] ?? 'full'));
  protected readonly entity = httpResource<EntityDto>(() => {
    const uid = this.uid();
    return uid ? { url: api.entity(uid), params: this.context.params() } : undefined;
  });
  protected choose(uid: string | null) {
    if (uid) this.updateAttributes()({ uid, kind: uid.split(':')[0] });
  }
  protected toggleDisplay() {
    this.updateAttributes()({ display: this.display() === 'full' ? 'compact' : 'full' });
  }
}

@Component({
  selector: 'cn-page-embed-view',
  imports: [PagePicker, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<div class="cn-embed" contenteditable="false" [class.ring-2]="selected()">
    @if (page(); as p) {
      <a class="cn-page-card" [routerLink]="['/c', store?.id(), 'p', p.id]">
        <span class="text-2xl">{{ p.icon || icons[p.type] }}</span>
        <span><span class="block font-semibold">{{ p.title }}</span><span class="text-xs text-muted">{{ labels[p.type] }}</span></span>
      </a>
      <div class="cn-block-tools"><button type="button" (click)="updateAttributes()({ pageId: null })">Change</button></div>
    } @else {
      <div class="cn-embed-empty">
        <div class="font-semibold">Link card to a page</div>
        <cn-page-picker [value]="null" (selected)="updateAttributes()({ pageId: $event })" />
      </div>
    }
  </div>`,
})
export class PageEmbedView extends AngularNodeViewComponent {
  protected readonly store = inject(CampaignStore, { optional: true });
  protected readonly icons = PAGE_TYPE_ICONS;
  protected readonly labels = PAGE_TYPE_LABELS;
  protected readonly page = computed(() => {
    const id = this.node().attrs['pageId'] as string | null;
    return id ? (this.store?.byId().get(id) ?? null) : null;
  });
}

@Component({
  selector: 'cn-query-view',
  imports: [QueryColumns, QueryResults],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<div class="cn-embed cn-query-frame" contenteditable="false" [class.ring-2]="selected()">
    <div class="flex flex-wrap items-center gap-2">
      <input class="cn-query-title" placeholder="Query title (e.g. NPCs here)" aria-label="Query title" [value]="title()" (change)="updateAttributes()({ title: $any($event.target).value })" />
      <button #configBtn type="button" class="cn-block-btn cn-config-btn" [attr.aria-expanded]="configuring()" (click)="configuring.set(!configuring())">{{ configuring() ? 'Done' : 'Configure' }}</button>
    </div>
    @if (configuring()) {
      <div class="cn-query-config" (keydown.escape)="closeConfig()">
        <fieldset class="cn-seg-group">
          <legend class="cn-label">View</legend>
          @for (v of views; track v.value) {
            <label class="cn-seg"><input type="radio" [name]="uid + '-view'" [value]="v.value" [checked]="mode() === v.value" (change)="setView(v.value)" /> <span>{{ v.label }}</span></label>
          }
        </fieldset>
        <cn-query-columns [columns]="columnsAttr()" [types]="filter().types" [mode]="mode()" (columnsChange)="updateAttributes()({ columns: $event })" />
        <div class="cn-sort-row">
          <label><span class="cn-label">Default sort</span>
            <select class="cn-input" (change)="setSortField($any($event.target).value)">
              @for (o of sortOptions(); track o.value) {<option [value]="o.value" [selected]="o.value === filter().sort.field">{{ o.label }}</option>}
            </select>
          </label>
          <fieldset class="cn-seg-group">
            <legend class="cn-label">Direction</legend>
            <label class="cn-seg"><input type="radio" [name]="uid + '-dir'" value="asc" [checked]="filter().sort.dir !== 'desc'" (change)="setSortDir('asc')" /> <span>Ascending</span></label>
            <label class="cn-seg"><input type="radio" [name]="uid + '-dir'" value="desc" [checked]="filter().sort.dir === 'desc'" (change)="setSortDir('desc')" /> <span>Descending</span></label>
          </fieldset>
        </div>
        <div><span class="cn-label">Types</span>
          @for (t of types; track t) {
            <label><input type="checkbox" [checked]="filter().types.includes(t)" (change)="toggleType(t)" /> {{ labels[t] }}</label>
          }
        </div>
        <label><span class="cn-label">Tags (comma separated)</span><input [value]="filter().tags.join(', ')" (change)="setTags($any($event.target).value)" /></label>
        <label><span class="cn-label">Relation to this page</span>
          <select (change)="setRelation($any($event.target).value)">
            @for (r of relations; track r.value) {<option [value]="r.value" [selected]="r.value === relation()">{{ r.label }}</option>}
          </select>
        </label>
      </div>
    }
    <cn-query-results
      [rows]="rows()"
      [view]="mode()"
      [columns]="columnsAttr()"
      [filter]="filter()"
      [title]="title()"
      [loading]="results.isLoading() && !results.hasValue()"
      [busy]="results.isLoading()"
      [error]="!!results.error()"
      [editing]="true"
      (retry)="results.reload()"
    />
  </div>`,
})
export class QueryView extends AngularNodeViewComponent {
  protected readonly store = inject(CampaignStore, { optional: true });
  protected readonly labels = PAGE_TYPE_LABELS;
  protected readonly types = PAGE_TYPES;
  protected readonly uid = `cn-qv-${nextQueryViewId++}`;
  protected readonly configuring = signal(false);
  private readonly configBtn = viewChild<ElementRef<HTMLButtonElement>>('configBtn');
  protected readonly views = [
    { value: 'list', label: 'List' },
    { value: 'table', label: 'Table' },
    { value: 'cards', label: 'Cards' },
  ] as const;
  protected readonly relations = [
    { value: '', label: 'Anywhere in the campaign' },
    { value: 'children', label: 'Subpages of this page' },
    { value: 'facet.locationPageId', label: 'NPCs located here' },
    { value: 'facet.factionPageId', label: 'Members of this faction' },
    { value: 'facet.parentLocationPageId', label: 'Places inside this location' },
    { value: 'facet.giverPageId', label: 'Quests given by this NPC' },
  ];
  protected readonly title = computed(() => String(this.node().attrs['title'] ?? ''));
  protected readonly mode = computed(() => normalizeView(this.node().attrs['view']));
  protected readonly columnsAttr = computed(() => normalizeColumns(this.node().attrs['columns']));
  protected readonly filter = computed(() => {
    const f = (this.node().attrs['filter'] ?? {}) as Partial<{ types: string[]; tags: string[]; parent: unknown; where: { field: string; op: string; value?: unknown }[]; sort: { field: string; dir: string }; limit: number }>;
    return { types: f.types ?? [], tags: f.tags ?? [], parent: f.parent ?? null, where: f.where ?? [], sort: f.sort ?? { field: 'title', dir: 'asc' }, limit: f.limit ?? 100 };
  });
  protected readonly relation = computed(() => {
    const f = this.filter();
    if (f.parent && typeof f.parent === 'object') return 'children';
    return f.where.find((w) => w.value && typeof w.value === 'object' && '$ctx' in (w.value as object))?.field ?? '';
  });
  private readonly columnContext = computed<ColumnContext>(() => ({ types: this.filter().types, props: this.store?.propertyDefs() ?? [], isGm: this.store?.isGm() ?? false }));
  /** Title, type and dates, every shown column the server can sort on, and the field the block uses now. */
  protected readonly sortOptions = computed(() => {
    const cx = this.columnContext();
    const options: { value: string; label: string }[] = [
      { value: 'title', label: 'Title' },
      { value: 'type', label: 'Type' },
      { value: 'updatedAt', label: 'Updated' },
      { value: 'createdAt', label: 'Created' },
    ];
    for (const c of effectiveColumns(this.columnsAttr(), this.filter().types, this.mode() === 'list' ? 'table' : this.mode(), cx)) {
      if (c.scalar && !options.some((o) => o.value === c.key)) options.push({ value: c.key, label: c.label });
    }
    if (!options.some((o) => o.value === 'facet.number')) options.push({ value: 'facet.number', label: 'Session number' });
    const current = this.filter().sort.field;
    if (!options.some((o) => o.value === current)) options.push({ value: current, label: `${resolveColumn(current, cx)?.label ?? current} (not shown)` });
    return options;
  });
  private readonly editorContext = inject(EDITOR_CONTEXT, { optional: true });
  private readonly pageId = computed(() => this.editorContext?.pageId() ?? null);
  protected readonly results = httpResource<{ rows: QueryRowDto[] }>(() => {
    const id = this.store?.id();
    this.store?.pages(); // refresh when pages change
    return id ? { url: `/api/campaigns/${id}/query`, method: 'POST', body: { filter: this.filter(), contextPageId: this.pageId() } } : undefined;
  });
  protected readonly rows = computed(() => (this.results.hasValue() ? this.results.value().rows : []));

  private setFilter(patch: Record<string, unknown>) {
    this.updateAttributes()({ filter: { ...this.filter(), ...patch } });
  }
  protected closeConfig() {
    this.configuring.set(false);
    this.configBtn()?.nativeElement.focus();
  }
  /** Switching views keeps the columns (they serve both table and cards). */
  protected setView(view: string) {
    this.updateAttributes()({ view });
  }
  protected toggleType(t: string) {
    const types = this.filter().types.includes(t) ? this.filter().types.filter((x) => x !== t) : [...this.filter().types, t];
    this.setFilter({ types });
  }
  protected setTags(raw: string) {
    this.setFilter({ tags: raw.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean) });
  }
  protected setRelation(value: string) {
    const where = this.filter().where.filter((w) => !(w.value && typeof w.value === 'object' && '$ctx' in (w.value as object)));
    if (value === 'children') this.setFilter({ parent: { $ctx: 'currentPage' }, where });
    else if (value) this.setFilter({ parent: null, where: [...where, { field: value, op: 'eq', value: { $ctx: 'currentPage' } }] });
    else this.setFilter({ parent: null, where });
  }
  protected setSortField(field: string) {
    this.setFilter({ sort: { field, dir: this.filter().sort.dir === 'desc' ? 'desc' : 'asc' } });
  }
  protected setSortDir(dir: 'asc' | 'desc') {
    this.setFilter({ sort: { field: this.filter().sort.field, dir } });
  }
}

@Component({
  selector: 'cn-stat-grid-view',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<div class="cn-stat-grid" contenteditable="false" [class.ring-2]="selected()" [style.grid-template-columns]="'repeat(' + columns() + ', minmax(0, 1fr))'">
    @for (item of items(); track $index; let i = $index) {
      <div class="cn-stat-item">
        <input class="cn-stat-label" [value]="item.label" placeholder="Label" (change)="update(i, { label: $any($event.target).value })" />
        <input class="cn-stat-value" [value]="item.value" placeholder="Value" (change)="update(i, { value: $any($event.target).value })" />
        <button type="button" class="cn-stat-remove" (click)="remove(i)" aria-label="Remove">✕</button>
      </div>
    }
    <div class="cn-block-tools">
      <button type="button" (click)="add()">+ Stat</button>
      <select (change)="updateAttributes()({ columns: +$any($event.target).value })" aria-label="Columns">
        @for (n of [1, 2, 3, 4]; track n) {<option [value]="n" [selected]="n === columns()">{{ n }} col</option>}
      </select>
    </div>
  </div>`,
})
export class StatGridView extends AngularNodeViewComponent {
  protected readonly items = computed(() => (this.node().attrs['items'] as { label: string; value: string }[] | undefined) ?? []);
  protected readonly columns = computed(() => Number(this.node().attrs['columns'] ?? 2));
  protected update(i: number, patch: Partial<{ label: string; value: string }>) {
    this.updateAttributes()({ items: this.items().map((it, ix) => (ix === i ? { ...it, ...patch } : it)) });
  }
  protected add() {
    this.updateAttributes()({ items: [...this.items(), { label: '', value: '' }] });
  }
  protected remove(i: number) {
    this.updateAttributes()({ items: this.items().filter((_, ix) => ix !== i) });
  }
}

@Component({
  selector: 'cn-unknown-view',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<details class="cn-unsupported" contenteditable="false">
    <summary>Unsupported block ({{ type() }}) — kept as-is, hidden from players</summary>
    <pre class="overflow-auto text-xs">{{ raw() }}</pre>
  </details>`,
})
export class UnknownView extends AngularNodeViewComponent {
  protected readonly type = computed(() => String((this.node().attrs['raw'] as { type?: string } | null)?.type ?? 'unknown'));
  protected readonly raw = computed(() => JSON.stringify(this.node().attrs['raw'], null, 2).slice(0, 4000));
}


@Component({
  selector: 'cn-gallery-view',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<div class="cn-embed" contenteditable="false" [class.ring-2]="selected()">
    <div class="cn-gallery">
      @for (img of images(); track $index; let i = $index) {
        <figure>
          @if (url(img.src); as u) {<img [src]="u" [alt]="img.caption" loading="lazy" referrerpolicy="no-referrer" />}
          <figcaption>
            <input [value]="img.caption" placeholder="Caption" (change)="update(i, $any($event.target).value)" />
            <button type="button" (click)="remove(i)" aria-label="Remove image">✕</button>
          </figcaption>
        </figure>
      }
    </div>
    <div class="cn-embed-empty">
      <label class="cn-block-btn">Upload…<input type="file" accept="image/png,image/jpeg,image/gif,image/webp" hidden (change)="upload($any($event.target).files?.[0])" /></label>
      <input placeholder="5etools image path or https:// URL" (change)="addRef($any($event.target))" />
      @if (error()) {<span class="text-accent">{{ error() }}</span>}
    </div>
  </div>`,
})
export class GalleryView extends AngularNodeViewComponent {
  private readonly http = inject(HttpClient);
  private readonly store = inject(CampaignStore, { optional: true });
  protected readonly error = signal('');
  protected readonly images = computed(() => (this.node().attrs['images'] as { src: ImageSrc; caption: string }[] | undefined) ?? []);
  protected url = (src: ImageSrc) => imageSrcUrl(src);

  private set(images: { src: ImageSrc; caption: string }[]) {
    this.updateAttributes()({ images });
  }
  protected update(i: number, caption: string) {
    this.set(this.images().map((img, ix) => (ix === i ? { ...img, caption } : img)));
  }
  protected remove(i: number) {
    this.set(this.images().filter((_, ix) => ix !== i));
  }
  protected addRef(input: HTMLInputElement) {
    const v = input.value.trim();
    input.value = '';
    if (/^https:\/\//i.test(v)) this.set([...this.images(), { src: { kind: 'url', url: v }, caption: '' }]);
    else if (isSafeImagePath(v.replace(/^\/?img\//, ''))) this.set([...this.images(), { src: { kind: 'img', path: v.replace(/^\/?img\//, '') }, caption: '' }]);
    else this.error.set('Use a 5etools image path or an https:// URL');
  }
  protected async upload(file: File | undefined) {
    if (!file || !this.store?.id()) return;
    try {
      const form = new FormData();
      form.append('file', file);
      const res = await firstValueFrom(this.http.post<UploadDto>(`/api/campaigns/${this.store.id()}/uploads`, form));
      this.set([...this.images(), { src: { kind: 'upload', id: res.id }, caption: file.name }]);
    } catch (err) {
      this.error.set(errorMessage(err));
    }
  }
}
