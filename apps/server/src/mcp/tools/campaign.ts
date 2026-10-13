/** Finding things: campaigns, a campaign's pages and setup, page search, rules search. */
import { getRuleset, KINDS, type EntityKind, type RulesetId } from '@cn/fivetools';
import { PAGE_TYPES, type CampaignDto, type CampaignSummaryDto, type MemberDto, type PageSearchHitDto, type PageSummaryDto, type PropertyDefDto, type SearchHitDto } from '@cn/shared';
import { z } from 'zod';
import { path } from '../api';
import { pageTypeGuide } from '../pages';
import type { Tools } from '../tools';

export const campaignId = z.string().min(1).max(64).describe('Campaign id (from list_campaigns)');

const rulesLabel = (ruleset: string) => getRuleset(ruleset as RulesetId).label;

export function campaignTools(t: Tools) {
  t.read('list_campaigns', 'List campaigns', 'The campaigns you belong to, with your role in each.', z.object({}), async () => {
    const { campaigns } = await t.api.get<{ campaigns: CampaignSummaryDto[] }>('/api/campaigns');
    return { data: campaigns.map((c) => ({ id: c.id, name: c.name, rules: rulesLabel(c.ruleset), role: c.role, status: c.status, pages: c.pageCount })) };
  });

  t.read(
    'get_campaign',
    'Get a campaign',
    'A campaign: its rules, your role, every page you can see (id, title, type, parent), what details each page type has, custom properties and members.',
    z.object({ campaignId }),
    async ({ campaignId: id }) => {
      const [campaign, { pages }, { properties }, { members }] = await Promise.all([
        t.api.get<CampaignDto>(path`/api/campaigns/${id}`),
        t.api.get<{ pages: PageSummaryDto[] }>(path`/api/campaigns/${id}/pages`),
        t.api.get<{ properties: PropertyDefDto[] }>(path`/api/campaigns/${id}/properties`),
        t.api.get<{ members: MemberDto[] }>(path`/api/campaigns/${id}/members`),
      ]);
      return {
        data: {
          id: campaign.id,
          name: campaign.name,
          description: campaign.description,
          rules: rulesLabel(campaign.ruleset),
          otherEditionAllowed: campaign.crossEdition,
          yourRole: campaign.role,
          pages: pages.map((p) => ({ id: p.id, title: p.title, type: p.type, parentId: p.parentId, visibility: p.visibility })),
          pageTypes: pageTypeGuide(),
          properties: properties.map((p) => ({ key: p.key, label: p.label, type: p.type, options: p.options, appliesTo: p.appliesTo, dmOnly: p.dmOnly })),
          members: members.map((m) => ({ userId: m.userId, name: m.displayName, role: m.role, characters: m.characters.map((c) => c.title) })),
        },
      };
    },
  );

  t.read(
    'search_pages',
    'Search pages',
    'Find pages in a campaign: by words in their title or text, or all pages of a type.',
    z.object({
      campaignId,
      query: z.string().max(200).optional().describe('Words to look for'),
      type: z.enum(PAGE_TYPES).optional().describe('Only pages of this type'),
    }),
    async ({ campaignId: id, query, type }) => {
      if (query) {
        const { pages } = await t.api.get<{ pages: PageSearchHitDto[] }>(path`/api/campaigns/${id}/search`, { q: query, limit: 25 });
        return { data: pages.filter((p) => !type || p.type === type).map((p) => ({ id: p.pageId, title: p.title, type: p.type, snippet: p.snippet })) };
      }
      const { pages } = await t.api.get<{ pages: PageSummaryDto[] }>(path`/api/campaigns/${id}/pages`, { type });
      return { data: pages.map((p) => ({ id: p.id, title: p.title, type: p.type, parentId: p.parentId })) };
    },
  );

  t.read(
    'search_rules',
    'Search the rules',
    "Search the campaign's rules (5etools: creatures, spells, items, species, classes, conditions… and its homebrew), following the campaign's edition. Gives each hit's uid (for ::embed and details) and the {@tag} to write in text.",
    z.object({
      campaignId,
      query: z.string().min(1).max(200),
      kind: z.enum(Object.keys(KINDS) as [EntityKind, ...EntityKind[]]).optional().describe('Only this kind, e.g. monster, spell, item, race, background, condition'),
    }),
    async ({ campaignId: id, query, kind }) => {
      const { hits } = await t.api.get<{ hits: SearchHitDto[] }>('/api/reference/search', { campaignId: id, q: query, kinds: kind, limit: 15 });
      return {
        data: hits.map((h) => ({
          name: h.name,
          kind: h.kind,
          source: h.source,
          uid: h.uid,
          ...(h.badge ? { note: h.badge } : {}),
          ...(KINDS[h.kind]?.tag ? { tag: `{@${KINDS[h.kind].tag} ${h.name}|${h.source}}` } : {}),
        })),
      };
    },
  );
}
