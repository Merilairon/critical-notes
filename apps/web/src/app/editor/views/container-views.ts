import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import type { TemplateVariableDto } from '@cn/shared';
import { AngularNodeViewComponent, TiptapNodeViewContentDirective } from 'ngx-tiptap';
import { CampaignStore } from '../../campaign/campaign.store';
import { TemplateApi } from '../../templates/template-api';
import { issuesMessage } from '../../templates/template-insert';
import { TemplateValuesForm } from '../../templates/values-form';

const TONES = [
  { value: 'note', icon: '📝' },
  { value: 'info', icon: 'ℹ️' },
  { value: 'tip', icon: '💡' },
  { value: 'warning', icon: '⚠️' },
  { value: 'danger', icon: '☠️' },
];

@Component({
  selector: 'cn-callout-view',
  imports: [TiptapNodeViewContentDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<div class="cn-callout" [attr.data-tone]="tone()">
    <button type="button" contenteditable="false" class="cn-callout-icon" [title]="'Style: ' + tone()" (click)="cycle()">{{ icon() }}</button>
    <div tiptapNodeViewContent class="cn-callout-body"></div>
  </div>`,
})
export class CalloutView extends AngularNodeViewComponent {
  protected readonly tone = computed(() => String(this.node().attrs['tone'] ?? 'note'));
  protected readonly icon = computed(() => this.node().attrs['icon'] || TONES.find((t) => t.value === this.tone())?.icon || '📝');
  protected cycle() {
    const ix = TONES.findIndex((t) => t.value === this.tone());
    this.updateAttributes()({ tone: TONES[(ix + 1) % TONES.length]!.value, icon: null });
  }
}

@Component({
  selector: 'cn-secret-view',
  imports: [TiptapNodeViewContentDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<div class="cn-secret" [class.cn-secret-revealed]="revealed()">
    <div class="cn-secret-head" contenteditable="false">
      <span>🔒 DM secret</span>
      <button type="button" class="cn-secret-toggle" (click)="toggle()" [attr.aria-pressed]="revealed()">
        {{ revealed() ? 'Revealed to players' : 'Hidden from players' }}
      </button>
    </div>
    <div tiptapNodeViewContent></div>
  </div>`,
})
export class SecretView extends AngularNodeViewComponent {
  protected readonly revealed = computed(() => !!this.node().attrs['revealed']);
  protected toggle() {
    this.updateAttributes()({ revealed: !this.revealed() });
  }
}

@Component({
  selector: 'cn-tab-view',
  imports: [TiptapNodeViewContentDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<div class="cn-tab-edit">
    <input contenteditable="false" class="cn-tab-title" [value]="title()" (change)="rename($any($event.target).value)" aria-label="Tab title" />
    <div tiptapNodeViewContent></div>
  </div>`,
})
export class TabView extends AngularNodeViewComponent {
  protected readonly title = computed(() => String(this.node().attrs['title'] ?? 'Tab'));
  protected rename(title: string) {
    this.updateAttributes()({ title: title.trim() || 'Tab' });
  }
}

/**
 * A linked template instance: read-only while linked (it updates when the template changes). Its values can be
 * edited (the server re-renders it), or "Detach" turns it into ordinary editable blocks.
 */
@Component({
  selector: 'cn-template-instance-view',
  imports: [TiptapNodeViewContentDirective, TemplateValuesForm],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<div class="cn-linked-template" [class.cn-linked-detached]="detached()">
    <div class="cn-linked-template-head" contenteditable="false">
      <span>{{ detached() ? '🧩 From a template (detached)' : '🔗 Linked template · v' + version() }}</span>
      @if (!detached()) {
        @if (store?.id() && store.isGm()) {
          <button type="button" class="cn-linked-detach" (click)="edit()">Edit values</button>
        }
        <button type="button" class="cn-linked-detach" (click)="detach()" title="Stop following the template and edit these blocks">Detach</button>
      }
    </div>
    @if (editing()) {
      <div class="cn-linked-values" contenteditable="false">
        <cn-template-values [variables]="variables()" [values]="values()" (changed)="values.set($event)" />
        @if (error()) {<p class="mt-1 text-sm text-accent" role="alert">{{ error() }}</p>}
        <div class="mt-2 flex justify-end gap-2">
          <button type="button" class="cn-linked-detach" (click)="editing.set(false)">Cancel</button>
          <button type="button" class="cn-linked-detach" (click)="apply()">Apply</button>
        </div>
      </div>
    }
    <div tiptapNodeViewContent [attr.contenteditable]="detached() ? null : 'false'"></div>
  </div>`,
})
export class TemplateInstanceView extends AngularNodeViewComponent {
  protected readonly store = inject(CampaignStore, { optional: true });
  private readonly api = inject(TemplateApi);
  protected readonly detached = computed(() => !!this.node().attrs['detached']);
  protected readonly version = computed(() => Number(this.node().attrs['version'] ?? 0));
  protected readonly editing = signal(false);
  protected readonly variables = signal<TemplateVariableDto[]>([]);
  protected readonly values = signal<Record<string, unknown>>({});
  protected readonly error = signal('');

  protected detach() {
    this.updateAttributes()({ detached: true });
  }

  protected async edit() {
    this.error.set('');
    try {
      const t = await this.api.get(String(this.node().attrs['templateId']));
      this.variables.set(t.resolvedVariables);
      this.values.set({ ...((this.node().attrs['values'] as Record<string, unknown> | undefined) ?? {}) });
      this.editing.set(true);
    } catch {
      this.error.set('The template is no longer available. Detach to edit these blocks.');
      this.editing.set(true);
    }
  }

  /** Re-renders the instance on the server with the new values and replaces this block. */
  protected async apply() {
    const campaignId = this.store?.id();
    const pos = this.getPos()();
    if (!campaignId || pos === undefined) return;
    try {
      const [next] = await this.api.instantiate(campaignId, String(this.node().attrs['templateId']), this.values(), 'linked');
      if (!next) return;
      this.editor()
        .chain()
        .insertContentAt({ from: pos, to: pos + this.node().nodeSize }, next as never)
        .run();
      this.editing.set(false);
    } catch (err) {
      this.error.set(issuesMessage(err));
    }
  }
}
