import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { httpResource } from '@angular/common/http';
import {
  abilityTable,
  acText,
  conditionImmuneText,
  crText,
  gearText,
  hpText,
  immResText,
  initiativeText,
  isModern,
  isObject,
  languagesText,
  monsterShortName,
  monsterTypeLine,
  savesText,
  sensesText,
  skillsText,
  speedText,
  styleForEdition,
  type JsonObject,
} from '@cn/fivetools';
import type { EntityDto } from '@cn/shared';
import { api } from '../../core/api';
import { Entries } from '../render/entries';
import { Entry } from '../render/entry';
import { Inline } from '../render/inline';
import { NamedEntries } from './named-entries';

const SECTIONS = [
  ['trait', null],
  ['action', 'Actions'],
  ['bonus', 'Bonus Actions'],
  ['reaction', 'Reactions'],
] as const;

@Component({
  selector: 'cn-monster-statblock',
  imports: [Inline, Entries, Entry, NamedEntries],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './monster-statblock.html',
})
export class MonsterStatblock {
  readonly entity = input.required<EntityDto>();
  readonly showName = input(true);

  protected readonly m = computed(() => this.entity().data as JsonObject);
  protected readonly style = computed(() => styleForEdition(this.entity().edition));
  protected readonly modern = computed(() => isModern(this.style()));

  protected readonly typeLine = computed(() => monsterTypeLine(this.m(), this.style()));
  protected readonly ac = computed(() => acText(this.m()['ac']));
  protected readonly hp = computed(() => hpText(this.m()['hp']));
  protected readonly speed = computed(() => speedText(this.m()['speed'], this.style()));
  protected readonly abilities = computed(() => abilityTable(this.m()));
  protected readonly abilityRows = computed(() => [this.abilities().slice(0, 3), this.abilities().slice(3, 6)]);
  protected readonly saves = computed(() => savesText(this.m()['save']));
  protected readonly skills = computed(() => skillsText(this.m()['skill']));
  protected readonly vulnerable = computed(() => immResText(this.m()['vulnerable'], 'vulnerable', this.style()));
  protected readonly resist = computed(() => immResText(this.m()['resist'], 'resist', this.style()));
  protected readonly immune = computed(() => immResText(this.m()['immune'], 'immune', this.style()));
  protected readonly conditionImmune = computed(() => conditionImmuneText(this.m()['conditionImmune'], this.style()));
  protected readonly immunitiesModern = computed(() => [this.immune(), this.conditionImmune()].filter(Boolean).join('; '));
  protected readonly senses = computed(() => sensesText(this.m(), this.style()));
  protected readonly languages = computed(() => languagesText(this.m()));
  protected readonly cr = computed(() => crText(this.m(), this.style()));
  protected readonly initiative = computed(() => initiativeText(this.m()));
  protected readonly gear = computed(() => gearText(this.m()['gear']));
  protected readonly pb = computed(() => {
    const parts = /PB ([+-]\d+)/.exec(crText(this.m(), styleForEdition('one')));
    return parts ? parts[1] : null;
  });

  /** Spellcasting blocks grouped by where they display (trait/action/bonus/reaction/legendary). */
  protected readonly spellcasting = computed(() => {
    const out: Record<string, JsonObject[]> = {};
    const list = Array.isArray(this.m()['spellcasting']) ? (this.m()['spellcasting'] as JsonObject[]) : [];
    for (const sc of list) {
      const key = typeof sc['displayAs'] === 'string' ? sc['displayAs'] : 'trait';
      (out[key] ??= []).push({ ...sc, type: 'spellcasting' });
    }
    return out;
  });

  protected readonly sections = computed(() =>
    SECTIONS.map(([prop, title]) => ({
      prop,
      title,
      items: (Array.isArray(this.m()[prop]) ? (this.m()[prop] as unknown[]) : []) as unknown[],
      spellcasting: this.spellcasting()[prop] ?? [],
      header: Array.isArray(this.m()[`${prop}Header`]) ? (this.m()[`${prop}Header`] as unknown[]) : [],
    })).filter((s) => s.items.length || s.spellcasting.length),
  );

  protected readonly legendary = computed(() => (Array.isArray(this.m()['legendary']) ? (this.m()['legendary'] as unknown[]) : []));
  protected readonly mythic = computed(() => (Array.isArray(this.m()['mythic']) ? (this.m()['mythic'] as unknown[]) : []));
  protected readonly legendaryHeader = computed<unknown[]>(() => {
    const m = this.m();
    if (Array.isArray(m['legendaryHeader'])) return m['legendaryHeader'] as unknown[];
    const n = Number(m['legendaryActions'] ?? 3);
    const lair = m['legendaryActionsLair'] != null ? Number(m['legendaryActionsLair']) : null;
    const name = monsterShortName(m, { titleCase: true });
    const lower = monsterShortName(m);
    if (this.modern()) {
      return [
        `{@i Legendary Action Uses: ${n}${lair && lair !== n ? ` (${lair} in Lair)` : ''}.} Immediately after another creature's turn, ${lower} can expend a use to take one of the following actions. ${name} regains all expended uses at the start of each of its turns.`,
      ];
    }
    return [
      `${name} can take ${n} legendary action${n === 1 ? '' : 's'}, choosing from the options below. Only one legendary action can be used at a time and only at the end of another creature's turn. ${name} regains spent legendary actions at the start of its turn.`,
    ];
  });

  /** Lair actions / regional effects live in a separate legendary group entity. */
  private readonly legendaryGroupUid = computed(() => {
    const lg = this.m()['legendaryGroup'];
    return isObject(lg) ? `legendaryGroup:${String(lg['name']).toLowerCase()}|${String(lg['source']).toLowerCase()}` : null;
  });
  protected readonly legendaryGroup = httpResource<EntityDto>(() => {
    const uid = this.legendaryGroupUid();
    return uid ? api.entity(uid) : undefined;
  });
  protected readonly lgData = computed(() => (this.legendaryGroup.hasValue() ? (this.legendaryGroup.value().data as JsonObject) : null));

  protected list(v: unknown): unknown[] {
    return Array.isArray(v) ? v : [];
  }
}
