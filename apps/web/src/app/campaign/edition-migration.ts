import { HttpClient } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { RULESET_IDS, getRuleset, type RulesetId } from '@cn/fivetools';
import type { MigrationEntryDto, MigrationReportDto, MigrationResultDto, ReferenceSite } from '@cn/shared';
import { firstValueFrom } from 'rxjs';
import { ConfirmService } from '../core/confirm.service';
import { errorMessage } from '../core/http.interceptor';
import { CampaignStore } from './campaign.store';

const STATUS_LABELS = { mapped: 'Will change', unchanged: 'Stays', unmapped: 'No match' } as const;

/** Moving the campaign to the other edition: see every reference and what it becomes, then apply. */
@Component({
  selector: 'cn-edition-migration',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `@if (!report()) {
      <p class="text-sm">
        This campaign uses the {{ current().label }}. You can move it to the {{ other().label }}: references to rules (tags, embeds, statblocks,
        encounters, items) switch to their {{ other().label }} printing where one exists. First you see exactly what would change.
      </p>
      <button type="button" class="mt-2 rounded-md border border-line px-3 py-1.5 text-sm hover:border-accent" [disabled]="busy()" (click)="plan()">Check what would change</button>
    } @else if (report(); as r) {
      <p class="text-sm">
        Moving to the {{ other().label }}: <strong>{{ r.counts.mapped }}</strong> {{ r.counts.mapped === 1 ? 'reference changes' : 'references change' }},
        {{ r.counts.unchanged }} {{ r.counts.unchanged === 1 ? 'stays' : 'stay' }} as {{ r.counts.unchanged === 1 ? 'it is' : 'they are' }},
        <strong [class.text-accent]="r.counts.unmapped > 0">{{ r.counts.unmapped }}</strong> {{ r.counts.unmapped === 1 ? 'has' : 'have' }} no {{ other().label }} version
        (kept as they are, marked as the other edition).
      </p>
      <div class="mt-2 max-h-96 overflow-y-auto rounded-md border border-line">
        <table class="w-full text-sm">
          <thead class="sticky top-0 bg-panel text-left text-xs text-muted"><tr><th class="px-2 py-1">Keep</th><th class="px-2">Now</th><th class="px-2">Becomes</th><th class="px-2">Used in</th></tr></thead>
          <tbody>
            @for (e of r.entries; track e.from) {
              <tr class="border-t border-line">
                <td class="px-2 py-1">@if (e.status === 'mapped') {<input type="checkbox" [checked]="keep().has(e.from)" (change)="toggleKeep(e.from)" [attr.aria-label]="'Keep ' + e.fromName" />}</td>
                <td class="px-2">{{ e.fromName }} <span class="text-xs text-muted">{{ e.fromSource }}</span></td>
                <td class="px-2">
                  @if (e.status === 'mapped') { {{ e.toName }} <span class="text-xs text-muted">{{ e.toSource }}</span> }
                  @else {<span class="text-xs" [class.text-accent]="e.status === 'unmapped'">{{ label(e) }}</span>}
                </td>
                <td class="px-2 text-xs text-muted">{{ sitesText(e.sites) }}</td>
              </tr>
            }
          </tbody>
        </table>
      </div>
      <div class="mt-2 flex gap-2">
        <button type="button" class="rounded-md bg-accent px-3 py-1.5 text-sm font-semibold text-accent-ink" [disabled]="busy()" (click)="apply()">Move to the {{ other().label }}</button>
        <button type="button" class="rounded-md border border-line px-3 py-1.5 text-sm text-muted" (click)="report.set(null)">Cancel</button>
      </div>
    }
    @if (message()) {<p class="mt-2 text-sm" role="status">{{ message() }}</p>}
    @if (error()) {<p class="mt-2 text-sm text-accent" role="alert">{{ error() }}</p>}`,
})
export class EditionMigrationPanel {
  private readonly confirm = inject(ConfirmService);
  private readonly store = inject(CampaignStore);
  private readonly http = inject(HttpClient);
  protected readonly report = signal<MigrationReportDto | null>(null);
  protected readonly keep = signal(new Set<string>());
  protected readonly busy = signal(false);
  protected readonly message = signal('');
  protected readonly error = signal('');
  protected readonly current = computed(() => getRuleset((this.store.campaign()?.ruleset ?? RULESET_IDS[0]) as RulesetId));
  protected readonly other = computed(() => getRuleset(RULESET_IDS.find((r) => r !== this.current().id)!));

  protected label(e: MigrationEntryDto) {
    return STATUS_LABELS[e.status];
  }
  protected sitesText(sites: ReferenceSite[]) {
    const names = sites.map((s) => (s.kind === 'page' ? s.title : s.name));
    return [...new Set(names)].slice(0, 3).join(', ') + (new Set(names).size > 3 ? ` +${new Set(names).size - 3}` : '');
  }
  protected toggleKeep(uid: string) {
    const next = new Set(this.keep());
    if (next.has(uid)) next.delete(uid);
    else next.add(uid);
    this.keep.set(next);
  }

  protected async plan() {
    this.busy.set(true);
    this.error.set('');
    try {
      this.report.set(await firstValueFrom(this.http.get<MigrationReportDto>(`/api/campaigns/${this.store.id()}/migrate-edition`, { params: { to: this.other().id } })));
    } catch (err) {
      this.error.set(errorMessage(err));
    } finally {
      this.busy.set(false);
    }
  }

  protected async apply() {
    if (!(await this.confirm.ask({ title: 'Change edition?', message: `Move this campaign to the ${this.other().label}? Source choices are reset to the new edition's defaults.`, confirmLabel: 'Move campaign' }))) return;
    this.busy.set(true);
    try {
      const res = await firstValueFrom(this.http.post<MigrationResultDto>(`/api/campaigns/${this.store.id()}/migrate-edition`, { to: this.other().id, keep: [...this.keep()] }));
      this.report.set(null);
      this.message.set(`Done: ${res.changed} ${res.changed === 1 ? 'reference' : 'references'} changed.`);
      await this.store.load(this.store.id()!);
    } catch (err) {
      this.error.set(errorMessage(err));
    } finally {
      this.busy.set(false);
    }
  }
}
