import { computed, effect, Injectable, signal } from '@angular/core';
import { getRuleset, makePolicy, RULESET_IDS, type CampaignPolicy, type RulesetId } from '@cn/fivetools';
import type { CampaignRole } from '@cn/shared';
import { readStored, writeStored } from './storage';

interface StoredContext {
  ruleset: RulesetId;
  crossEdition: boolean;
  overrides: Record<string, boolean>;
}

/**
 * The rules context used for reference lookups. Until campaigns exist (milestone c) this is a
 * user-chosen "preview" context; later it is derived from the active campaign.
 */
@Injectable({ providedIn: 'root' })
export class ContextService {
  private readonly stored = readStored<StoredContext>('cn.context', { ruleset: RULESET_IDS[1]!, crossEdition: false, overrides: {} });

  readonly rulesetId = signal<RulesetId>(RULESET_IDS.includes(this.stored.ruleset) ? this.stored.ruleset : RULESET_IDS[1]!);
  readonly crossEdition = signal(!!this.stored.crossEdition);
  readonly overrides = signal<Record<string, boolean>>(this.stored.overrides ?? {});

  /** Active campaign (set by the campaign workspace); reference lookups then use its rules and sources. */
  readonly campaign = signal<{ id: string; name: string; ruleset: RulesetId; crossEdition: boolean; overrides: Record<string, boolean>; role: CampaignRole } | null>(null);

  readonly effectiveRulesetId = computed<RulesetId>(() => this.campaign()?.ruleset ?? this.rulesetId());
  readonly ruleset = computed(() => getRuleset(this.effectiveRulesetId()));
  readonly policy = computed<CampaignPolicy>(() => {
    const c = this.campaign();
    if (c) return makePolicy(c.ruleset, { crossEdition: c.crossEdition, sourceOverrides: Object.entries(c.overrides) });
    return makePolicy(this.rulesetId(), { crossEdition: this.crossEdition(), sourceOverrides: Object.entries(this.overrides()) });
  });

  /** Route prefix for reference pages (kept inside the campaign workspace when one is active). */
  readonly referenceBase = computed<string[]>(() => {
    const c = this.campaign();
    return c ? ['/c', c.id, 'reference'] : ['/reference'];
  });

  /** Query params understood by the reference API. */
  readonly params = computed<Record<string, string>>(() => {
    const c = this.campaign();
    if (c) return { campaignId: c.id } as Record<string, string>;
    const sources = Object.entries(this.overrides())
      .map(([id, on]) => `${id}:${on ? 1 : 0}`)
      .join(',');
    return { ruleset: this.rulesetId(), cross: this.crossEdition() ? '1' : '0', ...(sources ? { sources } : {}) };
  });

  readonly paramsKey = computed(() => new URLSearchParams(this.params()).toString());

  constructor() {
    effect(() => writeStored('cn.context', { ruleset: this.rulesetId(), crossEdition: this.crossEdition(), overrides: this.overrides() }));
  }

  setSource(id: string, enabled: boolean | null) {
    this.overrides.update((o) => {
      const next = { ...o };
      if (enabled == null) delete next[id.toLowerCase()];
      else next[id.toLowerCase()] = enabled;
      return next;
    });
  }
}

/**
 * The server only lists homebrew sources the current context may use, so a listed homebrew source is allowed.
 * Client-side policies need that to show homebrew toggles correctly.
 */
export function withListedHomebrew(policy: CampaignPolicy, sources: readonly { id: string; origin: string }[]): CampaignPolicy {
  return { ...policy, homebrewSources: new Set(sources.filter((s) => s.origin === 'homebrew').map((s) => s.id.toLowerCase())) };
}
