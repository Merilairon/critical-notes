import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import {
  abilityBonusText,
  creatureType,
  featCategoryText,
  featsGrantedText,
  isObject,
  prerequisiteText,
  proficiencyText,
  sizeText,
  speedText,
  styleForEdition,
  type JsonObject,
} from '@cn/fivetools';
import type { EntityDto } from '@cn/shared';
import { ContextService } from '../../core/context.service';
import { Entries } from '../render/entries';
import { Inline } from '../render/inline';

interface Line {
  label: string;
  text: string;
}

/** Species/race, background, feat and similar character options: a few labelled lines, then entries. */
@Component({
  selector: 'cn-character-option-block',
  imports: [Inline, Entries],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<div class="cn-statblock">
    @if (showName()) {
      <h2 class="cn-sb-name">{{ entity().name }}</h2>
    }
    @if (subtitle()) {
      <div class="cn-sb-sub">{{ subtitle() }}</div>
    }
    @if (lines().length) {
      <div class="cn-sb-rule"></div>
      @for (line of lines(); track line.label) {
        <div><span class="cn-sb-label">{{ line.label }}:</span>&ngsp;<cn-inline [text]="line.text" /></div>
      }
    }
    <div class="cn-sb-rule"></div>
    <div class="cn-prose">
      @if (subraces().length) {
        <p class="cn-inline-head">{{ subraceLabel() }}</p>
        <ul class="cn-list-plain">
          @for (sr of subraces(); track $index) {
            <li><cn-inline [text]="sr" /></li>
          }
        </ul>
      }
      <cn-entries [entries]="list(d()['entries'])" [depth]="1" />
    </div>
  </div>`,
})
export class CharacterOptionBlock {
  readonly entity = input.required<EntityDto>();
  readonly showName = input(true);
  private readonly context = inject(ContextService);

  protected readonly d = computed(() => this.entity().data as JsonObject);
  private readonly style = computed(() => styleForEdition(this.entity().edition));

  protected readonly subtitle = computed(() => {
    const kind = this.entity().kind;
    if (kind === 'feat') return featCategoryText(this.d()['category']);
    if (kind === 'race') return this.context.ruleset().terminology.race;
    return null;
  });

  protected readonly subraceLabel = computed(() => `${this.context.ruleset().terminology.subrace}s`);
  protected readonly subraces = computed(() =>
    (Array.isArray(this.d()['_subraces']) ? (this.d()['_subraces'] as JsonObject[]) : []).map((s) => `{@race ${String(s['name'])}|${String(s['source'])}}`),
  );

  protected readonly lines = computed<Line[]>(() => {
    const d = this.d();
    const out: Line[] = [];
    const push = (label: string, text: string | null | undefined) => {
      if (text) out.push({ label, text });
    };
    switch (this.entity().kind) {
      case 'race':
        push('Ability Scores', abilityBonusText(d['ability']));
        if (Array.isArray(d['creatureTypes'])) push('Creature Type', (d['creatureTypes'] as string[]).map((t) => creatureType(t, this.style())).join(', '));
        push('Size', sizeText(d['size']));
        push('Speed', speedText(d['speed'], this.style()));
        if (d['darkvision']) push('Darkvision', `${String(d['darkvision'])} ft.`);
        push('Languages', proficiencyText(d['languageProficiencies']));
        break;
      case 'background':
        push('Ability Scores', abilityBonusText(d['ability']));
        push('Feat', featsGrantedText(d['feats']));
        push('Skill Proficiencies', proficiencyText(d['skillProficiencies'], 'skill'));
        push('Tool Proficiencies', proficiencyText(d['toolProficiencies']));
        push('Languages', proficiencyText(d['languageProficiencies']));
        break;
      case 'feat':
        push('Prerequisite', prerequisiteText(d['prerequisite']));
        push('Ability Score Increase', abilityBonusText(d['ability']));
        break;
      case 'optionalfeature':
        push('Prerequisite', prerequisiteText(d['prerequisite']));
        break;
      case 'deity':
        if (typeof d['title'] === 'string') push('Title', d['title']);
        if (typeof d['pantheon'] === 'string') push('Pantheon', d['pantheon']);
        if (Array.isArray(d['domains'])) push('Domains', (d['domains'] as string[]).join(', '));
        if (typeof d['symbol'] === 'string') push('Symbol', d['symbol']);
        break;
      default:
        if (isObject(d['prerequisite']) || Array.isArray(d['prerequisite'])) push('Prerequisite', prerequisiteText(d['prerequisite']));
    }
    return out;
  });

  protected list(v: unknown): unknown[] {
    return Array.isArray(v) ? v : [];
  }
}
