import { httpResource } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, computed, effect, inject, Injectable, input, signal } from '@angular/core';
import { entityUid, isObject, parseEntityTag, proficiencyText, splitTagArgs, type JsonObject } from '@cn/fivetools';
import type { EntityDto, RelatedEntityDto } from '@cn/shared';
import { api } from '../../core/api';
import { Entries } from '../render/entries';
import { Inline } from '../render/inline';
import { RELATED_ENTITIES } from '../render/entry';

@Injectable()
class RelatedHolder {
  readonly map = signal<Record<string, RelatedEntityDto>>({});
}

interface FeatureRow {
  level: number;
  uid: string;
  name: string;
  feature: RelatedEntityDto | null;
  isSubclassGain: boolean;
  fromSubclass: boolean;
}

const ABIL: Record<string, string> = { str: 'Strength', dex: 'Dexterity', con: 'Constitution', int: 'Intelligence', wis: 'Wisdom', cha: 'Charisma' };

function featureRefs(list: unknown, tag: 'classFeature' | 'subclassFeature'): { uid: string; name: string; level: number; gain: boolean }[] {
  return (Array.isArray(list) ? list : []).flatMap((ref) => {
    const raw = typeof ref === 'string' ? ref : isObject(ref) ? String(ref[tag] ?? '') : '';
    const parsed = parseEntityTag(tag, splitTagArgs(raw));
    if (!parsed) return [];
    const args = splitTagArgs(raw);
    const level = Number(args[tag === 'classFeature' ? 3 : 5]);
    return [{ uid: entityUid(parsed.kind, parsed.identity), name: parsed.name, level, gain: isObject(ref) && !!ref['gainSubclassFeature'] }];
  });
}

function tableCell(v: unknown): string {
  if (v == null) return '—';
  if (typeof v === 'number' || typeof v === 'string') return String(v === 0 ? '—' : v);
  if (isObject(v)) {
    switch (v['type']) {
      case 'bonus':
        return `+${String(v['value'])}`;
      case 'bonusSpeed':
        return `+${String(v['value'])} ft.`;
      case 'dice':
        return (Array.isArray(v['toRoll']) ? (v['toRoll'] as JsonObject[]) : []).map((t) => `${String(t['number'] ?? 1)}d${String(t['faces'])}`).join('+');
      default:
        return String(v['value'] ?? '');
    }
  }
  return '';
}

@Component({
  selector: 'cn-class-view',
  imports: [Inline, Entries],
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [RelatedHolder, { provide: RELATED_ENTITIES, useFactory: () => inject(RelatedHolder).map }],
  templateUrl: './class-view.html',
})
export class ClassView {
  readonly entity = input.required<EntityDto>();
  readonly showName = input(true);
  private readonly holder = inject(RelatedHolder);

  protected readonly c = computed(() => this.entity().data as JsonObject);
  protected readonly isSubclass = computed(() => this.entity().kind === 'subclass');
  protected readonly related = computed(() => this.entity().related ?? {});

  protected readonly subclasses = computed(() =>
    Object.values(this.related())
      .filter((r) => r.kind === 'subclass')
      .sort((a, b) => a.name.localeCompare(b.name) || a.source.localeCompare(b.source)),
  );
  protected readonly selectedSubclassUid = signal<string | null>(null);
  protected readonly subclass = httpResource<EntityDto>(() => {
    const uid = this.selectedSubclassUid();
    return uid ? api.entity(uid) : undefined;
  });

  constructor() {
    effect(() => {
      const sub = this.subclass.hasValue() ? (this.subclass.value().related ?? {}) : {};
      this.holder.map.set({ ...this.related(), ...sub });
    });
  }

  protected readonly hitDie = computed(() => (isObject(this.c()['hd']) ? `d${String((this.c()['hd'] as JsonObject)['faces'])}` : null));
  protected readonly saves = computed(() =>
    (Array.isArray(this.c()['proficiency']) ? (this.c()['proficiency'] as string[]) : []).map((a) => ABIL[a] ?? a).join(', '),
  );
  protected readonly startProf = computed(() => (isObject(this.c()['startingProficiencies']) ? (this.c()['startingProficiencies'] as JsonObject) : {}));
  protected readonly armor = computed(() => this.joinList(this.startProf()['armor']));
  protected readonly weapons = computed(() => this.joinList(this.startProf()['weapons']));
  protected readonly tools = computed(() => this.joinList(this.startProf()['tools']));
  protected readonly skills = computed(() => proficiencyText(this.startProf()['skills'], 'skill'));

  protected readonly tableGroups = computed(() => (Array.isArray(this.c()['classTableGroups']) ? (this.c()['classTableGroups'] as JsonObject[]) : []));
  protected readonly tableColumns = computed(() =>
    this.tableGroups().flatMap((g) => (Array.isArray(g['colLabels']) ? (g['colLabels'] as string[]) : [])),
  );
  protected readonly classFeatureRows = computed<FeatureRow[]>(() =>
    featureRefs(this.c()['classFeatures'], 'classFeature').map((r) => ({
      level: r.level,
      uid: r.uid,
      name: r.name,
      feature: this.related()[r.uid] ?? null,
      isSubclassGain: r.gain,
      fromSubclass: false,
    })),
  );
  protected readonly subclassFeatureRows = computed<FeatureRow[]>(() => {
    const source = this.isSubclass() ? this.entity() : this.subclass.hasValue() ? this.subclass.value() : null;
    if (!source) return [];
    const rel = source.related ?? {};
    return featureRefs(source.data['subclassFeatures'], 'subclassFeature').map((r) => ({
      level: r.level,
      uid: r.uid,
      name: r.name,
      feature: rel[r.uid] ?? null,
      isSubclassGain: false,
      fromSubclass: true,
    }));
  });
  protected readonly allFeatures = computed(() =>
    [...this.classFeatureRows(), ...this.subclassFeatureRows()].sort((a, b) => a.level - b.level || Number(a.fromSubclass) - Number(b.fromSubclass)),
  );

  /** One row per level: proficiency bonus, feature names, then the class table columns. */
  protected readonly levelRows = computed(() =>
    Array.from({ length: 20 }, (_, i) => {
      const level = i + 1;
      const cells = this.tableGroups().flatMap((g) => {
        const rows = (Array.isArray(g['rows']) ? g['rows'] : Array.isArray(g['rowsSpellProgression']) ? g['rowsSpellProgression'] : []) as unknown[][];
        const cols = Array.isArray(g['colLabels']) ? (g['colLabels'] as unknown[]).length : 0;
        const row = rows[i] ?? [];
        return Array.from({ length: cols }, (_, j) => tableCell(row[j]));
      });
      const features = this.classFeatureRows()
        .filter((f) => f.level === level)
        .map((f) => f.name);
      return { level, pb: `+${Math.ceil(level / 4) + 1}`, features: features.join(', '), cells };
    }),
  );

  protected entriesOf(f: FeatureRow): unknown[] {
    return f.feature && Array.isArray(f.feature.data['entries']) ? (f.feature.data['entries'] as unknown[]) : [];
  }

  private joinList(v: unknown): string {
    return (Array.isArray(v) ? v : [])
      .map((x) => (typeof x === 'string' ? x : isObject(x) ? String(x['full'] ?? x['proficiency'] ?? '') : ''))
      .filter(Boolean)
      .join(', ');
  }
}
