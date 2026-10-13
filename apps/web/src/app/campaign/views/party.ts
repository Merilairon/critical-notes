import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { abilityModifier, signedNumber } from '@cn/fivetools';
import { CampaignStore } from '../campaign.store';
import { typedPages, type TypedPage } from './typed-pages';

@Component({
  selector: 'cn-party',
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<div class="mx-auto w-full max-w-6xl p-4 sm:p-6">
    <div class="flex items-center gap-2">
      <h1 class="font-display text-3xl font-bold">Party</h1>
      @if (store.isGm()) {
        <button type="button" class="ml-auto rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-ink" (click)="create()">+ Character</button>
      }
    </div>
    <div class="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
      @for (pc of data.items(); track pc.id) {
        <a class="rounded-xl border border-line bg-panel p-3 hover:border-accent" [routerLink]="['/c', store.id(), 'p', pc.id]">
          <div class="flex items-baseline justify-between">
            <span class="font-display text-xl font-bold">{{ pc.title }}</span>
            <span class="text-xs text-muted">{{ num(pc, 'playerName') || '' }}</span>
          </div>
          <div class="text-sm text-muted">{{ classLine(pc) }}</div>
          <div class="mt-2 flex gap-4 text-sm">
            <span><b>AC</b> {{ num(pc, 'ac') ?? '—' }}</span>
            <span><b>HP</b> {{ num(pc, 'hpCurrent') ?? '—' }}/{{ num(pc, 'hpMax') ?? '—' }}{{ num(pc, 'hpTemp') ? ' +' + num(pc, 'hpTemp') : '' }}</span>
            <span><b>PP</b> {{ num(pc, 'passivePerception') ?? '—' }}</span>
          </div>
          @if (hpPercent(pc) !== null) {
            <div class="mt-1 h-1.5 overflow-hidden rounded bg-panel-2"><div class="h-full bg-accent" [style.width.%]="hpPercent(pc)"></div></div>
          }
          @if (abilities(pc); as ab) {
            <div class="mt-2 grid grid-cols-6 gap-1 text-center text-xs">
              @for (a of ab; track a.key) {
                <div class="rounded bg-panel-2 py-1"><div class="font-semibold uppercase">{{ a.key }}</div>{{ a.score }} ({{ a.mod }})</div>
              }
            </div>
          }
        </a>
      } @empty {
        <p class="text-sm text-muted">No player characters yet.</p>
      }
    </div>
  </div>`,
})
export class Party {
  protected readonly store = inject(CampaignStore);
  private readonly router = inject(Router);
  protected readonly data = typedPages('pc');
  protected num = (p: TypedPage, k: string) => (p.facet?.[k] as number | string | null | undefined) ?? null;
  protected classLine(pc: TypedPage): string {
    const classes = (pc.facet?.['classes'] as { classUid: string; level: number }[] | undefined) ?? [];
    const name = (uid: string) => {
      const n = uid.split(':')[1]?.split('|')[0] ?? uid;
      return n.replace(/\b\w/g, (c) => c.toUpperCase());
    };
    const total = classes.reduce((s, c) => s + (c.level || 0), 0);
    return classes.length ? `${classes.map((c) => `${name(c.classUid)} ${c.level}`).join(' / ')} (level ${total})` : 'No class set';
  }
  protected hpPercent(pc: TypedPage): number | null {
    const max = Number(pc.facet?.['hpMax']);
    const cur = Number(pc.facet?.['hpCurrent']);
    if (!max || Number.isNaN(cur)) return null;
    return Math.max(0, Math.min(100, (cur / max) * 100));
  }
  protected abilities(pc: TypedPage) {
    const ab = pc.facet?.['abilities'] as Record<string, number> | null | undefined;
    if (!ab) return null;
    return ['str', 'dex', 'con', 'int', 'wis', 'cha'].map((key) => ({ key, score: ab[key] ?? '—', mod: ab[key] ? signedNumber(abilityModifier(ab[key]!)) : '—' }));
  }
  protected async create() {
    const p = await this.store.createPage({ type: 'pc', title: 'New Character' });
    await this.router.navigate(['/c', this.store.id(), 'p', p.id]);
  }
}
