import { DatePipe } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal, untracked, type OnDestroy } from '@angular/core';
import { Title } from '@angular/platform-browser';
import { Router, RouterLink } from '@angular/router';
import { editionRuleset, homebrewEditionToEdition } from '@cn/fivetools';
import {
  HOMEBREW_TYPE_LABELS,
  type EntityDto,
  type HomebrewEntityDto,
  type HomebrewIssue,
  type HomebrewRevisionDto,
  type HomebrewSourceDto,
  type HomebrewUsageDto,
  type HomebrewValidationDto,
} from '@cn/shared';
import { ContextService } from '../core/context.service';
import { errorMessage } from '../core/http.interceptor';
import { EntityView } from '../reference/entity-view';
import { EntriesEditor, type EntriesPatch } from './entries-editor';
import { EntityForm, type FieldPatch } from './forms/entity-form';
import { setAt } from './forms/path';
import { blankEntity, FORM_SPECS } from './forms/specs';
import { HomebrewApi } from './homebrew-api';
import { JsonEditor } from './json-editor';

type Data = Record<string, unknown>;
type View = 'form' | 'json' | 'lore';

const PREVIEW_DELAY = 400;

/** Homebrew entity editor: form / JSON / lore views over one value, live preview, validation, history. */
@Component({
  selector: 'cn-homebrew-entity-editor',
  imports: [DatePipe, RouterLink, EntityForm, JsonEditor, EntriesEditor, EntityView],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './entity-editor.html',
  host: { '(window:beforeunload)': 'onBeforeUnload($event)' },
})
export class HomebrewEntityEditor implements OnDestroy {
  /** Route params: an existing entity, or a source + type for a new one. */
  readonly entityId = input<string | undefined>(undefined);
  readonly sourceId = input<string | undefined>(undefined);
  readonly type = input<string | undefined>(undefined);

  private readonly api = inject(HomebrewApi);
  private readonly router = inject(Router);
  private readonly title = inject(Title);
  private readonly context = inject(ContextService);

  protected readonly source = signal<HomebrewSourceDto | null>(null);
  protected readonly entity = signal<HomebrewEntityDto | null>(null);
  protected readonly entityType = signal('');
  protected readonly data = signal<Data>({});
  protected readonly fluff = signal<Data | null>(null);
  protected readonly view = signal<View>('form');
  protected readonly dirty = signal(false);
  protected readonly status = signal<'idle' | 'saving' | 'saved' | 'conflict'>('idle');
  protected readonly error = signal('');
  protected readonly validation = signal<HomebrewValidationDto>({ errors: [], warnings: [] });
  /** Errors from the last save attempt are only schema errors: offer "Save anyway". */
  protected readonly canForce = signal(false);
  protected readonly preview = signal<EntityDto | null>(null);
  protected readonly revisions = signal<HomebrewRevisionDto[] | null>(null);
  protected readonly revisionView = signal<{ revNo: number; json: string } | null>(null);
  protected readonly usage = signal<HomebrewUsageDto[] | null>(null);
  protected readonly loadError = signal('');

  protected readonly typeLabel = computed(() => HOMEBREW_TYPE_LABELS[this.entityType()] ?? this.entityType());
  protected readonly hasForm = computed(() => !!FORM_SPECS[this.entityType()]);
  protected readonly canEdit = computed(() => this.source()?.canEdit ?? false);
  protected readonly isNew = computed(() => !this.entity());
  protected readonly copyOf = computed(() => {
    const c = this.data()['_copy'];
    return c && typeof c === 'object' ? (c as { name?: string; source?: string }) : null;
  });
  protected readonly allIssues = computed<(HomebrewIssue & { level: 'error' | 'warning' })[]>(() => [
    ...this.validation().errors.map((i) => ({ ...i, level: 'error' as const })),
    ...this.validation().warnings.map((i) => ({ ...i, level: 'warning' as const })),
  ]);
  /** Rules context for `{@` autocomplete: the source's edition, plus everything else (cross-edition). */
  protected readonly searchParams = computed<Record<string, string>>(() => {
    const src = this.source();
    const edition = src ? homebrewEditionToEdition(src.edition) : 'any';
    return { ruleset: edition === 'any' ? this.context.effectiveRulesetId() : editionRuleset(edition), cross: '1' };
  });
  protected readonly referenceLink = computed(() => {
    const uid = this.entity()?.uid;
    return uid ? ['/reference', uid.split(':')[0]!, uid] : null;
  });

  /** Set when this editor was opened right after creating the entity (shows "Saved"). */
  private readonly justCreated = !!this.router.getCurrentNavigation()?.extras.state?.['created'];
  private previewTimer: ReturnType<typeof setTimeout> | undefined;
  private previewSeq = 0;

  constructor() {
    effect(() => {
      const [entityId, sourceId, type] = [this.entityId(), this.sourceId(), this.type()];
      untracked(() => void this.load(entityId, sourceId, type));
    });
    effect(() => {
      const name = String(this.data()['name'] ?? '');
      this.title.setTitle(`${name || 'Homebrew'} — Homebrew — Critical Notes`);
    });
  }

  private async load(entityId?: string, sourceId?: string, type?: string) {
    this.loadError.set('');
    this.revisions.set(null);
    this.usage.set(null);
    this.revisionView.set(null);
    try {
      if (entityId) {
        const e = await this.api.entity(entityId);
        this.entity.set(e);
        this.source.set(e.source);
        this.entityType.set(e.entityType);
        this.setData(stripSource(e.data), e.fluff, false);
        if (this.justCreated) this.status.set('saved');
      } else if (sourceId && type) {
        this.entity.set(null);
        this.source.set(await this.api.source(sourceId));
        this.entityType.set(type);
        this.setData(blankEntity(type), null, true);
      }
      this.view.set(this.hasForm() ? 'form' : 'json');
    } catch (err) {
      this.loadError.set(errorMessage(err));
    }
  }

  private setData(data: Data, fluff: Data | null, dirty: boolean) {
    this.data.set(data);
    this.fluff.set(fluff);
    this.dirty.set(dirty);
    this.status.set('idle');
    this.canForce.set(false);
    // First preview right away; later ones are debounced while typing
    clearTimeout(this.previewTimer);
    void this.runPreview();
  }

  protected onData(next: unknown) {
    if (!next || typeof next !== 'object' || Array.isArray(next)) return;
    this.data.set(next as Data);
    this.dirty.set(true);
    this.status.set('idle');
    this.canForce.set(false);
    this.schedulePreview();
  }

  protected onPatch(patch: FieldPatch) {
    this.onData(setAt(this.data(), patch.path, patch.value));
  }

  protected onLore(patch: EntriesPatch) {
    const f = setAt<Data>(this.fluff() ?? {}, ['entries', ...patch.path], patch.value);
    this.fluff.set(Array.isArray(f['entries']) && f['entries'].length ? f : null);
    this.dirty.set(true);
  }

  private schedulePreview() {
    clearTimeout(this.previewTimer);
    this.previewTimer = setTimeout(() => void this.runPreview(), PREVIEW_DELAY);
  }

  private async runPreview() {
    const src = this.source();
    if (!src) return;
    const seq = ++this.previewSeq;
    try {
      const res = await this.api.preview(src.id, this.entityType(), this.data(), this.entity()?.id ?? null);
      if (seq !== this.previewSeq) return;
      this.preview.set(res.entity ? { ...res.entity, fluff: this.fluff() } : null);
      this.validation.set(res.validation);
    } catch {
      // Preview is best effort
    }
  }

  protected async save(force = false) {
    const src = this.source();
    if (!src) return;
    this.status.set('saving');
    this.error.set('');
    const input = { entityType: this.entityType(), data: this.data(), fluff: this.fluff(), force };
    try {
      const current = this.entity();
      const res = current ? await this.api.save(current.id, { ...input, revision: current.currentRevision }) : await this.api.create(src.id, input);
      this.validation.set(res.validation);
      this.entity.set(res.entity);
      this.dirty.set(false);
      this.status.set('saved');
      this.canForce.set(false);
      this.revisions.set(null);
      if (!current) await this.router.navigate(['/homebrew/e', res.entity.id], { replaceUrl: true, state: { created: true } });
    } catch (err) {
      this.status.set('idle');
      if (err instanceof HttpErrorResponse && err.status === 409) {
        this.status.set('conflict');
        return;
      }
      const details = err instanceof HttpErrorResponse ? (err.error?.details as HomebrewValidationDto | undefined) : undefined;
      if (details?.errors) {
        this.validation.set(details);
        this.canForce.set(details.errors.every((e) => e.message.startsWith('5etools schema')));
        this.error.set(`Not saved: ${details.errors.length} problem${details.errors.length === 1 ? '' : 's'} to fix.`);
      } else this.error.set(errorMessage(err));
    }
  }

  protected async reload() {
    const id = this.entity()?.id;
    if (id) await this.load(id);
  }

  protected async remove() {
    const e = this.entity();
    if (!e) return;
    const used = await this.api.usage(e.id).catch(() => []);
    const note = used.length ? `\n\nIt is used on ${used.length} page${used.length === 1 ? '' : 's'}; those keep showing it with a "deleted" badge.` : '';
    if (!confirm(`Delete "${e.name}"? You can restore it later from the source's deleted items.${note}`)) return;
    await this.api.delete(e.id);
    this.dirty.set(false);
    await this.router.navigate(['/homebrew/s', e.sourceId]);
  }

  protected async restore() {
    const e = this.entity();
    if (!e) return;
    try {
      this.entity.set(await this.api.restore(e.id));
    } catch (err) {
      this.error.set(errorMessage(err));
    }
  }

  protected async loadRevisions() {
    const e = this.entity();
    if (e) this.revisions.set(await this.api.revisions(e.id));
  }

  protected async showRevision(revNo: number) {
    const e = this.entity();
    if (!e) return;
    const r = await this.api.revision(e.id, revNo);
    this.revisionView.set({ revNo, json: JSON.stringify(r.data, null, 2) });
  }

  protected async restoreRevision(revNo: number) {
    const e = this.entity();
    if (!e || (this.dirty() && !confirm('Discard your unsaved changes and restore this revision?'))) return;
    const restored = await this.api.restoreRevision(e.id, revNo);
    this.entity.set(restored);
    this.setData(stripSource(restored.data), restored.fluff, false);
    this.revisionView.set(null);
    await this.loadRevisions();
  }

  protected async loadUsage() {
    const e = this.entity();
    if (e) this.usage.set(await this.api.usage(e.id));
  }

  protected focusIssue() {
    this.view.set('json');
  }

  protected onBeforeUnload(event: BeforeUnloadEvent) {
    if (this.dirty()) event.preventDefault();
  }

  /** Used by the route guard. */
  canLeave(): boolean {
    return !this.dirty() || confirm('You have unsaved changes. Leave anyway?');
  }

  ngOnDestroy() {
    clearTimeout(this.previewTimer);
  }
}

/** The server always sets `source` to the entity's homebrew source; the editor does not show it. */
function stripSource(data: Record<string, unknown>): Data {
  const { source: _source, ...rest } = data;
  return rest;
}
