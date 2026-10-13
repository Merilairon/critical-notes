import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal, untracked, type OnDestroy } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { CR_TO_XP } from '@cn/fivetools';
import type { EncounterCreature, EncounterDto, TrackerSummaryDto } from '@cn/shared';
import { firstValueFrom } from 'rxjs';
import { HttpClient } from '@angular/common/http';
import { CampaignStore } from '../campaign/campaign.store';
import { PagePicker } from '../campaign/page-picker';
import { RefPicker } from '../campaign/ref-picker';
import { ContextService } from '../core/context.service';
import { errorMessage } from '../core/http.interceptor';
import { CRS } from '../homebrew/forms/specs';
import { encounterDifficulty } from './combat-math';
import { PlayApi } from './play-api';

const SAVE_DELAY = 600;
const newLineId = () => Math.random().toString(36).slice(2, 10);

/** Build an encounter: creatures, the party, and the difficulty by the campaign's rules. */
@Component({
  selector: 'cn-encounter-builder',
  imports: [RouterLink, RefPicker, PagePicker],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './encounter-builder.html',
})
export class EncounterBuilder implements OnDestroy {
  readonly encounterId = input.required<string>();
  private readonly api = inject(PlayApi);
  private readonly http = inject(HttpClient);
  private readonly router = inject(Router);
  protected readonly store = inject(CampaignStore);
  protected readonly context = inject(ContextService);

  protected readonly enc = signal<EncounterDto | null>(null);
  protected readonly creatures = signal<EncounterCreature[]>([]);
  protected readonly runs = signal<TrackerSummaryDto[]>([]);
  protected readonly status = signal('');
  protected readonly error = signal('');
  protected readonly includeParty = signal(true);
  protected readonly adding = signal<'monster' | 'npc' | 'custom' | null>(null);
  protected readonly crs = CRS;
  protected readonly Math = Math;

  protected readonly partyLevels = computed(() => {
    const e = this.enc();
    if (!e) return [];
    return e.party.mode === 'custom' ? e.party.levels : e.partyMembers.map((m) => m.level);
  });
  protected readonly result = computed(() => {
    const e = this.enc();
    return e ? encounterDifficulty(this.context.ruleset(), this.partyLevels(), this.creatures(), e.resolved) : null;
  });
  protected readonly resolvedById = computed(() => new Map((this.enc()?.resolved ?? []).map((r) => [r.id, r])));
  /** How far along the threshold scale the encounter is (0–100%). */
  protected readonly meter = computed(() => {
    const r = this.result();
    const top = r?.tiers.at(-1)?.threshold ?? 0;
    return r && top > 0 ? Math.min(100, Math.round((r.adjustedXp / top) * 100)) : 0;
  });

  private timer: ReturnType<typeof setTimeout> | undefined;
  private pending: Parameters<PlayApi['updateEncounter']>[2] = {};

  constructor() {
    effect(() => {
      const id = this.encounterId();
      untracked(() => void this.load(id));
    });
  }

  private async load(id: string) {
    const campaignId = this.store.id()!;
    try {
      const enc = await this.api.encounter(campaignId, id);
      this.enc.set(enc);
      this.creatures.set(enc.creatures);
      this.runs.set(
        (await firstValueFrom(this.http.get<{ trackers: TrackerSummaryDto[] }>(`/api/campaigns/${campaignId}/encounters/${id}/trackers`)).catch(() => ({ trackers: [] }))).trackers,
      );
    } catch (err) {
      this.error.set(errorMessage(err));
    }
  }

  /** Queues a change; saves are debounced and merged. Creature changes also refresh the resolved numbers. */
  protected save(patch: Parameters<PlayApi['updateEncounter']>[2]) {
    const e = this.enc();
    if (!e) return;
    this.pending = { ...this.pending, ...patch };
    if (patch.name !== undefined || patch.notes !== undefined || patch.party !== undefined) this.enc.set({ ...e, ...(patch as Partial<EncounterDto>) });
    this.status.set('Unsaved changes');
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), SAVE_DELAY);
  }

  private async flush() {
    clearTimeout(this.timer);
    if (!Object.keys(this.pending).length) return;
    const patch = this.pending;
    this.pending = {};
    this.status.set('Saving…');
    try {
      const saved = await this.api.updateEncounter(this.store.id()!, this.encounterId(), patch);
      // Keep local edits made while saving; adopt the server's resolved numbers
      this.enc.set({ ...saved, name: this.enc()?.name ?? saved.name, notes: this.enc()?.notes ?? saved.notes, party: this.enc()?.party ?? saved.party });
      this.status.set('Saved');
    } catch (err) {
      this.status.set('');
      this.error.set(errorMessage(err));
    }
  }

  protected setCreatures(next: EncounterCreature[]) {
    this.creatures.set(next);
    this.save({ creatures: next });
  }

  protected patchCreature(id: string, change: Partial<EncounterCreature>) {
    this.setCreatures(this.creatures().map((c) => (c.id === id ? { ...c, ...change } : c)));
  }

  protected removeCreature(id: string) {
    this.setCreatures(this.creatures().filter((c) => c.id !== id));
  }

  private line(partial: Partial<EncounterCreature> & Pick<EncounterCreature, 'kind'>): EncounterCreature {
    return { id: newLineId(), uid: null, pageId: null, name: '', count: 1, lair: false, hidden: false, xp: null, hp: null, ac: null, ...partial };
  }

  protected addMonster(uid: string | null) {
    if (!uid) return;
    const existing = this.creatures().find((c) => c.kind === 'monster' && c.uid === uid);
    if (existing) this.patchCreature(existing.id, { count: existing.count + 1 });
    else this.setCreatures([...this.creatures(), this.line({ kind: 'monster', uid })]);
    this.adding.set(null);
  }

  protected addNpc(pageId: string | null) {
    if (!pageId) return;
    this.setCreatures([...this.creatures(), this.line({ kind: 'npc', pageId })]);
    this.adding.set(null);
  }

  protected addCustom(name: string, cr: string, hp: string, ac: string) {
    if (!name.trim()) return;
    this.setCreatures([
      ...this.creatures(),
      this.line({ kind: 'custom', name: name.trim(), xp: CR_TO_XP[cr] ?? 0, hp: hp ? Number(hp) : null, ac: ac ? Number(ac) : null }),
    ]);
    this.adding.set(null);
  }

  protected setPartyMode(mode: 'campaign' | 'custom') {
    const e = this.enc();
    if (!e) return;
    const levels = mode === 'custom' && !e.party.levels.length ? e.partyMembers.map((m) => m.level) : e.party.levels;
    this.save({ party: { mode, levels: levels.length ? levels : [1, 1, 1, 1] } });
  }

  protected setLevels(raw: string) {
    const levels = raw
      .split(/[,\s]+/)
      .map(Number)
      .filter((n) => Number.isInteger(n) && n >= 1 && n <= 20)
      .slice(0, 12);
    this.save({ party: { mode: 'custom', levels } });
  }

  protected async run() {
    await this.flush();
    try {
      const tracker = await this.api.startEncounter(this.store.id()!, this.encounterId(), this.includeParty());
      await this.router.navigate(['/c', this.store.id(), 'trackers', tracker.id]);
    } catch (err) {
      this.error.set(errorMessage(err));
    }
  }

  protected async remove() {
    const e = this.enc();
    if (!e || !confirm(`Delete the encounter "${e.name}"?`)) return;
    clearTimeout(this.timer);
    this.pending = {};
    await this.api.deleteEncounter(this.store.id()!, e.id);
    await this.router.navigate(['/c', this.store.id(), 'encounters']);
  }

  ngOnDestroy() {
    void this.flush();
  }
}
