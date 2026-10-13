/**
 * Built-in templates (scope "global", read-only, upserted at startup by key and version). They work in both
 * editions: terms come from `{{rules.*}}` and condition tags from `$rulesetTag`, which resolve per campaign.
 * Bump a template's version when changing it so existing installs pick it up.
 */
import type { BlockNode } from '@cn/blocks';
import { syncVariables } from './collect';
import type { BlockTemplateDef, PageTemplateDef, TemplateKind } from './model';
import type { TemplateVariable } from './variables';

export interface BuiltinTemplate {
  key: string;
  version: number;
  kind: TemplateKind;
  name: string;
  description: string;
  icon: string;
  tags: string[];
  definition: BlockTemplateDef | PageTemplateDef;
}

// region Content builders

type Inline = BlockNode;
const t = (text: string, marks?: string[]): Inline => (marks ? { type: 'text', text, marks: marks.map((m) => ({ type: m })) } : { type: 'text', text });
const p = (...content: (Inline | string)[]): BlockNode => ({ type: 'paragraph', content: content.map((c) => (typeof c === 'string' ? t(c) : c)) });
const h = (level: number, text: string): BlockNode => ({ type: 'heading', attrs: { level }, content: [t(text)] });
const condition = (key: string): Inline => ({ type: 'tag', attrs: { markup: { $rulesetTag: `condition:${key}` } } });
const ul = (...items: string[]): BlockNode => ({ type: 'bulletList', content: items.map((i) => ({ type: 'listItem', content: [p(i)] })) });
const tasks = (...items: string[]): BlockNode => ({ type: 'taskList', content: items.map((i) => ({ type: 'taskItem', attrs: { checked: false }, content: [p(i)] })) });
const readAloud = (...content: BlockNode[]): BlockNode => ({ type: 'readAloud', content });
const secret = (...content: BlockNode[]): BlockNode => ({ type: 'secret', content });
const callout = (tone: string, icon: string, ...content: BlockNode[]): BlockNode => ({ type: 'callout', attrs: { tone, icon }, content });
const stats = (...items: [string, string][]): BlockNode => ({ type: 'statGrid', attrs: { columns: 2, items: items.map(([label, value]) => ({ label, value })) } });
const embed = (variable: string, display: 'full' | 'compact' = 'full'): BlockNode => ({ type: 'refEmbed', attrs: { uid: { $var: variable }, display } });
const cell = (text: string, header = false): BlockNode => ({ type: header ? 'tableHeader' : 'tableCell', content: [p(text)] });
const table = (roll: string | null, head: string[], rows: string[][]): BlockNode => ({
  type: 'table',
  attrs: { roll },
  content: [{ type: 'tableRow', content: head.map((c) => cell(c, true)) }, ...rows.map((r) => ({ type: 'tableRow', content: r.map((c) => cell(c)) }))],
});
const query = (title: string, filter: Record<string, unknown>): BlockNode => ({ type: 'query', attrs: { title, filter, view: 'list', columns: [] } });
const here = (field: string) => ({ types: ['npc'], where: [{ field, op: 'eq', value: { $ctx: 'currentPage' } }], sort: { field: 'title', dir: 'asc' } });

/** Variables from content, with labels and required flags added. */
function vars(content: BlockNode[], meta: Record<string, Partial<TemplateVariable>> = {}, extra: TemplateVariable[] = []): TemplateVariable[] {
  const stored = Object.entries(meta).map(([name, m]) => ({ name, type: 'text', ...m }));
  const synced = syncVariables(content, stored as TemplateVariable[]).variables;
  const names = new Set(synced.map((v) => v.name));
  return [...synced, ...extra.filter((e) => !names.has(e.name))];
}

function page(def: Partial<PageTemplateDef> & Pick<PageTemplateDef, 'pageType' | 'body'>, meta: Record<string, Partial<TemplateVariable>> = {}, extra: TemplateVariable[] = []): PageTemplateDef {
  const full: PageTemplateDef = { extendsRef: null, bodyMode: 'append', defaults: {}, facet: {}, properties: [], children: [], variables: [], ...def };
  // The default title and facet values can use variables too
  return { ...full, variables: vars([...full.body, ...pageMetaNodes(full)], meta, extra) };
}

/** A pseudo node carrying a page template's title and facet defaults, so their variables are collected. */
export function pageMetaNodes(def: Pick<PageTemplateDef, 'defaults' | 'facet'>): BlockNode[] {
  return [{ type: 'pageMeta', attrs: { title: def.defaults.title ?? '', facet: def.facet } }];
}

function block(content: BlockNode[], meta: Record<string, Partial<TemplateVariable>> = {}): BlockTemplateDef {
  return { content, variables: vars(content, meta) };
}

// endregion

const npcBody = [
  stats(['{{rules.race}}', '{{ancestry}}'], ['Role', '{{role}}'], ['Voice', '{{voice}}'], ['Wants', '{{wants}}']),
  h(2, 'Appearance'),
  p('{{appearance}}'),
  h(2, 'Personality'),
  ul('Trait: ', 'Ideal: ', 'Bond: ', 'Flaw: '),
  h(2, 'Statblock'),
  embed('statblock'),
  secret(h(3, 'Secrets'), p('{{secret}}')),
];

const locationBody = [
  readAloud(p('{{first_impression}}')),
  h(2, 'Description'),
  p(''),
  h(2, 'Who is here'),
  query('NPCs at this location', here('facet.locationPageId')),
  secret(h(3, 'Secrets'), p('')),
];

export const BUILTIN_TEMPLATES: BuiltinTemplate[] = [
  {
    key: 'npc',
    version: 1,
    kind: 'page',
    name: 'NPC',
    description: 'A non-player character: who they are, what they want, their statblock and secrets.',
    icon: '🧑',
    tags: ['npc'],
    definition: page(
      {
        pageType: 'npc',
        defaults: { visibility: 'dm' },
        facet: { role: '{{role}}', statblockUid: { $var: 'statblock' } },
        body: npcBody,
      },
      {
        ancestry: { label: 'Race / species' },
        role: { label: 'Role (e.g. innkeeper)' },
        statblock: { type: 'reference<monster>', label: 'Statblock' },
        wants: { label: 'What they want' },
      },
    ),
  },
  {
    key: 'location',
    version: 1,
    kind: 'page',
    name: 'Location',
    description: 'A place: first impression for the players, description, who is there and what is hidden.',
    icon: '📍',
    tags: ['location'],
    definition: page({ pageType: 'location', facet: { kind: 'site' }, body: locationBody }, { first_impression: { label: 'First impression (read aloud)' } }),
  },
  {
    key: 'settlement',
    version: 1,
    kind: 'page',
    name: 'Settlement',
    description: 'A village or city: population, who rules, services and rumors. Extends Location.',
    icon: '🏘️',
    tags: ['location', 'settlement'],
    definition: page(
      {
        pageType: 'location',
        extendsRef: 'builtin:location',
        facet: { kind: 'settlement' },
        body: [
          stats(['Population', '{{population: number}}'], ['Government', '{{government}}']),
          p('Ruled by {{ruler: pageLink<npc>}}.'),
          h(2, 'Services'),
          ul('Inn: ', 'Temple: ', 'Market: '),
          h(2, 'Rumors'),
          table('d6', ['d6', 'Rumor'], [['1', ''], ['2', ''], ['3', ''], ['4', ''], ['5', ''], ['6', '']]),
        ],
      },
      { ruler: { label: 'Ruler' } },
    ),
  },
  {
    key: 'dungeon-room',
    version: 1,
    kind: 'page',
    name: 'Dungeon room',
    description: 'One keyed room: boxed text, features, creatures, a trap and treasure. Extends Location.',
    icon: '🚪',
    tags: ['location', 'dungeon'],
    definition: page(
      {
        pageType: 'location',
        extendsRef: 'builtin:location',
        bodyMode: 'replace',
        facet: { kind: 'room' },
        body: [
          readAloud(p('{{boxed_text}}')),
          h(3, 'Features'),
          ul(''),
          h(3, 'Creatures'),
          p('{{count: number = 1}} × '),
          embed('creature', 'compact'),
          h(3, 'Hazards'),
          p('DC {{dc: number = 13}} Dexterity save or fall ', condition('prone'), '.'),
          h(3, 'Treasure'),
          { type: 'loot', attrs: { items: [] } },
        ],
      },
      { boxed_text: { label: 'Boxed text' }, creature: { type: 'reference<monster>', label: 'Creature' } },
    ),
  },
  {
    key: 'quest',
    version: 1,
    kind: 'page',
    name: 'Quest',
    description: 'A quest with its giver, reward, objectives and the complications only you know about.',
    icon: '❗',
    tags: ['quest'],
    definition: page(
      {
        pageType: 'quest',
        facet: { status: 'rumor' },
        body: [
          stats(['Reward', '{{reward}}'], ['Deadline', '{{deadline}}']),
          p('Offered by {{giver: pageLink<npc>}}.'),
          h(2, 'Hook'),
          readAloud(p('{{hook}}')),
          h(2, 'Objectives'),
          tasks('', ''),
          secret(h(3, 'Complications'), p('')),
        ],
      },
      { giver: { label: 'Quest giver' }, hook: { label: 'Hook (read aloud)' } },
    ),
  },
  {
    key: 'faction',
    version: 1,
    kind: 'page',
    name: 'Faction',
    description: 'An organization: leader, goals, symbol, members and secrets.',
    icon: '🛡️',
    tags: ['faction'],
    definition: page(
      {
        pageType: 'faction',
        body: [
          stats(['Goal', '{{goal}}'], ['Symbol', '{{symbol}}']),
          p('Led by {{leader: pageLink<npc>}}.'),
          h(2, 'Members'),
          query('Members', { ...here('facet.factionPageId') }),
          h(2, 'Resources'),
          ul(''),
          secret(h(3, 'Secret agenda'), p('')),
        ],
      },
      { leader: { label: 'Leader' } },
    ),
  },
  {
    key: 'session-prep',
    version: 1,
    kind: 'page',
    name: 'Session prep',
    description: 'Prepare a session: strong start, scenes, secrets and clues, locations, NPCs, monsters, rewards.',
    icon: '🗓️',
    tags: ['session'],
    definition: page({
      pageType: 'session',
      defaults: { title: 'Session {{number: number}}' },
      facet: { status: 'planned', number: { $var: 'number' } },
      body: [
        h(2, 'Strong start'),
        p(''),
        h(2, 'Possible scenes'),
        tasks('', '', ''),
        secret(h(3, 'Secrets and clues'), { type: 'orderedList', attrs: { start: 1 }, content: Array.from({ length: 6 }, () => ({ type: 'listItem', content: [p('')] })) }),
        h(2, 'Locations'),
        ul(''),
        h(2, 'NPCs'),
        ul(''),
        h(2, 'Monsters'),
        ul(''),
        h(2, 'Rewards'),
        { type: 'loot', attrs: { items: [] } },
      ],
    }),
  },
  {
    key: 'session-recap',
    version: 1,
    kind: 'page',
    name: 'Session recap',
    description: 'What happened, loot and experience, and the threads to pick up next time.',
    icon: '📜',
    tags: ['session'],
    definition: page({
      pageType: 'session',
      defaults: { title: 'Session {{number: number}} recap', visibility: 'all' },
      facet: { status: 'played', number: { $var: 'number' }, date: { $var: 'date' } },
      body: [
        stats(['Played on', '{{date: date}}'], ['Experience', '{{xp: number}} XP each']),
        h(2, 'Summary'),
        p('{{summary}}'),
        h(2, 'What happened'),
        ul('', ''),
        h(2, 'Loose threads'),
        tasks(''),
      ],
    }),
  },
  {
    key: 'shop',
    version: 1,
    kind: 'page',
    name: 'Shop',
    description: 'A shop with its owner and a price list. Extends Location.',
    icon: '🛒',
    tags: ['location', 'shop'],
    definition: page(
      {
        pageType: 'location',
        extendsRef: 'builtin:location',
        facet: { kind: 'site' },
        body: [
          p('Run by {{owner: pageLink<npc>}}.'),
          h(2, 'Wares'),
          table(null, ['Item', 'Price', 'Notes'], [['', '', ''], ['', '', ''], ['', '', '']]),
        ],
      },
      { owner: { label: 'Owner' } },
    ),
  },
  {
    key: 'player-handout',
    version: 1,
    kind: 'page',
    name: 'Player handout',
    description: 'A letter, notice or note to show the players.',
    icon: '✉️',
    tags: ['handout'],
    definition: page({ pageType: 'handout', defaults: { visibility: 'all' }, body: [readAloud(p('{{text}}')), p({ type: 'text', text: '— {{signed}}', marks: [{ type: 'italic' }] })] }, { text: { label: 'Handout text' }, signed: { label: 'Signed by' } }),
  },
  {
    key: 'magic-item-handout',
    version: 1,
    kind: 'page',
    name: 'Magic item handout',
    description: 'A magic item card for the players, with where it was found.',
    icon: '💎',
    tags: ['handout', 'item'],
    definition: page(
      {
        pageType: 'handout',
        defaults: { visibility: 'all' },
        body: [embed('item'), p('Found {{where}}.'), secret(h(3, 'Curse or secret'), p(''))],
      },
      { item: { type: 'reference<item>', label: 'Magic item', required: true }, where: { label: 'Where it was found' } },
    ),
  },
  {
    key: 'trap',
    version: 1,
    kind: 'block',
    name: 'Trap',
    description: 'A trap with its trigger, save, damage and how to disarm it.',
    icon: '🪤',
    tags: ['trap', 'hazard'],
    definition: block(
      [
        callout(
          'warning',
          '🪤',
          h(3, '{{name: text = Trap}}'),
          p({ type: 'text', text: 'Trigger. ', marks: [{ type: 'bold' }] }, '{{trigger}}'),
          p({ type: 'text', text: 'Effect. ', marks: [{ type: 'bold' }] }, 'DC {{dc: number = 13}} {{save: select(Strength|Dexterity|Constitution|Wisdom) = Dexterity}} save; on a failure the target takes {{damage: dice = 2d10}} damage and is ', condition('prone'), '.'),
        ),
        secret(p({ type: 'text', text: 'Detect and disarm. ', marks: [{ type: 'bold' }] }, '{{disarm}}')),
      ],
      { trigger: { label: 'Trigger' }, disarm: { label: 'How to find and disarm it' } },
    ),
  },
  {
    key: 'random-encounter-table',
    version: 1,
    kind: 'block',
    name: 'Random encounter table',
    description: 'A rollable d8 encounter table for a region.',
    icon: '🎲',
    tags: ['encounter', 'table'],
    definition: block([h(3, '{{region: text = Wilderness}} encounters'), table('d8', ['d8', 'Encounter'], Array.from({ length: 8 }, (_, i) => [String(i + 1), '']))]),
  },
];
