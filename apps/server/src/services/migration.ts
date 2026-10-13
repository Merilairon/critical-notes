/**
 * Moving a campaign to the other edition. A dry run lists every reference to rules content (tags and embeds
 * in pages, page details and properties, encounters, inventory) and what it maps to: the printing for the
 * new edition from the reprint group, or nothing. Applying rewrites the mapped references, switches the
 * campaign's rules, resets source choices and logs the migration.
 */
import { and, eq, isNull } from 'drizzle-orm';
import { walk, type BlockDocument, type BlockNode } from '@cn/blocks';
import { findEntityRefs, rulesetEdition, splitTagArgs, type RulesetId } from '@cn/fivetools';
import {
  facetTypeFor,
  FACET_FIELDS,
  type MigrationEntryDto,
  type MigrationReportDto,
  type MigrationResultDto,
  type PageType,
  type ReferenceSite,
} from '@cn/shared';
import type { AppDb } from '../db';
import { campaignMigrations, campaigns, campaignSourceOverrides, encounters, inventoryItems, pages } from '../db/schema';
import { badRequest } from '../lib/http';
import { newId } from '../lib/ids';
import type { IndexDb } from '../reference/index-db';
import type { CampaignService } from './campaigns';
import type { PageService } from './pages';
import type { PropertyService } from './properties';

interface EntityRow {
  uid: string;
  name: string;
  source_json: string;
  edition: string;
  origin: string;
  reprint_group: string | null;
  reprint_generation: number;
}

type Target = { uid: string; name: string; source: string };

/** Innermost `{@tag …}` occurrences (tags can nest inside formatting tags). */
const TAG_RE = /\{@([A-Za-z0-9_]+) ([^{}]*)\}/g;

/** Rewrites `{@tag Name|SOURCE|…}` references whose target maps to another printing (display text is kept). */
export function rewriteTags(text: string, mapping: Map<string, Target>): { text: string; changed: number } {
  let changed = 0;
  const out = text.replace(TAG_RE, (whole, tag: string, args: string) => {
    const ref = findEntityRefs(whole)[0];
    const target = ref && mapping.get(ref.uid);
    // Only plain "name|source" references (class features and the like have other layouts)
    if (!target || ref.uid.split('|').length !== 2) return whole;
    const parts = splitTagArgs(args);
    changed++;
    return `{@${tag} ${[target.name, target.source, ...parts.slice(2)].join('|')}}`;
  });
  return { text: out, changed };
}

export class EditionMigration {
  constructor(
    private readonly db: AppDb,
    private readonly indexDb: IndexDb,
    private readonly services: { campaigns: CampaignService; pages: PageService; properties: PropertyService },
  ) {}

  private entity(uid: string): EntityRow | null {
    const alias = this.indexDb.prepare('SELECT target_uid FROM entity_alias WHERE alias_uid = ?').get(uid) as { target_uid: string } | undefined;
    return (this.indexDb
      .prepare('SELECT uid, name, source_json, edition, origin, reprint_group, reprint_generation FROM entity WHERE uid = ?')
      .get(alias?.target_uid ?? uid) ?? null) as EntityRow | null;
  }

  /** Every place the campaign refers to rules content, by uid. */
  private collect(campaignId: string): Map<string, ReferenceSite[]> {
    const sites = new Map<string, ReferenceSite[]>();
    const add = (uid: unknown, site: ReferenceSite) => {
      if (typeof uid !== 'string' || !uid.includes(':')) return;
      const key = uid.toLowerCase();
      sites.set(key, [...(sites.get(key) ?? []), site]);
    };
    const refDefs = this.services.properties.list(campaignId).filter((d) => d.type === 'refLink');
    const live = this.db.select({ id: pages.id }).from(pages).where(and(eq(pages.campaignId, campaignId), isNull(pages.deletedAt))).all();
    for (const { id } of live) {
      const page = this.services.pages.get(campaignId, id);
      const at = (via: 'tag' | 'embed' | 'facet' | 'property'): ReferenceSite => ({ kind: 'page', pageId: page.id, title: page.title, via });
      walk((page.body as BlockDocument | null)?.content, (n) => {
        if (n.type === 'refEmbed') add(n.attrs?.['uid'], at('embed'));
        const text = n.type === 'tag' ? n.attrs?.['markup'] : n.type === 'text' ? n.text : null;
        if (typeof text === 'string' && text.includes('{@')) for (const ref of findEntityRefs(text)) add(ref.uid, at('tag'));
      });
      const facetType = facetTypeFor(page.type as PageType);
      if (facetType && page.facet) {
        for (const f of FACET_FIELDS[facetType]) if (f.type === 'refLink') add(page.facet[f.key], at('facet'));
        for (const c of (page.facet['classes'] as { classUid?: string; subclassUid?: string | null }[] | undefined) ?? []) {
          add(c.classUid, at('facet'));
          add(c.subclassUid, at('facet'));
        }
      }
      for (const d of refDefs) add(page.props[d.key], at('property'));
    }
    for (const e of this.db.select().from(encounters).where(and(eq(encounters.campaignId, campaignId), isNull(encounters.deletedAt))).all()) {
      for (const c of e.creatures as { uid?: string | null }[]) add(c.uid, { kind: 'encounter', encounterId: e.id, name: e.name });
    }
    for (const i of this.db.select().from(inventoryItems).where(eq(inventoryItems.campaignId, campaignId)).all()) add(i.itemUid, { kind: 'inventory', itemId: i.id, name: i.name });
    return sites;
  }

  /** What would change (nothing is written). */
  plan(campaignId: string, userId: string, to: RulesetId): MigrationReportDto {
    const { campaign } = this.services.campaigns.requireOwner(campaignId, userId);
    if (campaign.ruleset === to) throw badRequest('The campaign already uses these rules');
    const target = rulesetEdition(to);
    const entries: MigrationEntryDto[] = [];
    for (const [uid, sites] of this.collect(campaignId)) {
      const row = this.entity(uid);
      const base = { from: uid, fromName: row?.name ?? uid, fromSource: row?.source_json ?? '', sites };
      if (!row) {
        entries.push({ ...base, status: 'unmapped', to: null, toName: null, toSource: null });
        continue;
      }
      if (row.origin === 'homebrew' || row.edition === 'any' || row.edition === target) {
        entries.push({ ...base, status: 'unchanged', to: null, toName: null, toSource: null });
        continue;
      }
      const candidate = row.reprint_group
        ? (this.indexDb
            .prepare('SELECT uid, name, source_json FROM entity WHERE reprint_group = ? AND edition = ? AND deleted = 0 ORDER BY reprint_generation DESC LIMIT 1')
            .get(row.reprint_group, target) as { uid: string; name: string; source_json: string } | undefined)
        : undefined;
      entries.push(
        candidate
          ? { ...base, status: 'mapped', to: candidate.uid, toName: candidate.name, toSource: candidate.source_json }
          : { ...base, status: 'unmapped', to: null, toName: null, toSource: null },
      );
    }
    entries.sort((a, b) => ['unmapped', 'mapped', 'unchanged'].indexOf(a.status) - ['unmapped', 'mapped', 'unchanged'].indexOf(b.status) || a.fromName.localeCompare(b.fromName));
    const count = (s: MigrationEntryDto['status']) => entries.filter((e) => e.status === s).length;
    return {
      from: campaign.ruleset as RulesetId,
      to,
      entries,
      counts: { mapped: count('mapped'), unchanged: count('unchanged'), unmapped: count('unmapped'), sites: entries.reduce((n, e) => n + e.sites.length, 0) },
    };
  }

  /** Rewrites the mapped references (except those to keep) and switches the campaign's rules. */
  apply(campaignId: string, userId: string, to: RulesetId, keep: string[]): MigrationResultDto {
    const report = this.plan(campaignId, userId, to);
    const skip = new Set(keep.map((k) => k.toLowerCase()));
    const mapping = new Map<string, Target>(
      report.entries.filter((e) => e.status === 'mapped' && e.to && !skip.has(e.from)).map((e) => [e.from, { uid: e.to!, name: e.toName!, source: e.toSource! }]),
    );
    let changed = 0;
    const mapUid = (v: unknown) => {
      const t = typeof v === 'string' ? mapping.get(v.toLowerCase()) : undefined;
      if (t) changed++;
      return t ? t.uid : v;
    };

    const refDefs = this.services.properties.list(campaignId).filter((d) => d.type === 'refLink');
    const touchedPages = new Set(report.entries.flatMap((e) => (mapping.has(e.from) ? e.sites : [])).filter((s) => s.kind === 'page').map((s) => (s as { pageId: string }).pageId));
    for (const pageId of touchedPages) {
      const page = this.services.pages.get(campaignId, pageId);
      const rewrite = (nodes: BlockNode[] | undefined): BlockNode[] | undefined =>
        nodes?.map((n) => {
          let next: BlockNode = n;
          if (n.type === 'refEmbed' && typeof n.attrs?.['uid'] === 'string') next = { ...n, attrs: { ...n.attrs, uid: mapUid(n.attrs['uid']) } };
          if (n.type === 'tag' && typeof n.attrs?.['markup'] === 'string') {
            const r = rewriteTags(n.attrs['markup'], mapping);
            changed += r.changed;
            next = { ...n, attrs: { ...n.attrs, markup: r.text } };
          }
          if (n.type === 'text' && n.text?.includes('{@')) {
            const r = rewriteTags(n.text, mapping);
            changed += r.changed;
            next = { ...n, text: r.text };
          }
          return n.content ? { ...next, content: rewrite(n.content) } : next;
        });
      const body = page.body ? { ...page.body, content: rewrite((page.body as BlockDocument).content) } : undefined;
      const facetType = facetTypeFor(page.type as PageType);
      let facet: Record<string, unknown> | undefined;
      if (facetType && page.facet) {
        facet = { ...page.facet };
        for (const f of FACET_FIELDS[facetType]) if (f.type === 'refLink') facet[f.key] = mapUid(facet[f.key]);
        if (Array.isArray(facet['classes'])) {
          facet['classes'] = (facet['classes'] as { classUid?: string; subclassUid?: string | null }[]).map((c) => ({ ...c, classUid: mapUid(c.classUid), subclassUid: mapUid(c.subclassUid) }));
        }
      }
      const props: Record<string, unknown> = {};
      for (const d of refDefs) if (typeof page.props[d.key] === 'string') props[d.key] = mapUid(page.props[d.key]);
      this.services.pages.update(campaignId, pageId, {
        revision: page.revision,
        ...(body ? { body: body as never } : {}),
        ...(facet ? { facet } : {}),
        ...(Object.keys(props).length ? { props } : {}),
      });
    }
    for (const e of this.db.select().from(encounters).where(and(eq(encounters.campaignId, campaignId), isNull(encounters.deletedAt))).all()) {
      const creatures = (e.creatures as { uid?: string | null }[]).map((c) => ({ ...c, uid: mapUid(c.uid) }));
      this.db.update(encounters).set({ creatures, updatedAt: Date.now() }).where(eq(encounters.id, e.id)).run();
    }
    for (const i of this.db.select().from(inventoryItems).where(eq(inventoryItems.campaignId, campaignId)).all()) {
      const uid = mapUid(i.itemUid);
      if (uid !== i.itemUid) this.db.update(inventoryItems).set({ itemUid: uid as string }).where(eq(inventoryItems.id, i.id)).run();
    }
    this.db.transaction((tx) => {
      tx.update(campaigns).set({ ruleset: to, crossEdition: false, updatedAt: Date.now() }).where(eq(campaigns.id, campaignId)).run();
      // Source choices were made for the old edition
      tx.delete(campaignSourceOverrides).where(eq(campaignSourceOverrides.campaignId, campaignId)).run();
      tx.insert(campaignMigrations).values({ id: newId(), campaignId, fromRuleset: report.from, toRuleset: to, report, changed, byUserId: userId }).run();
    });
    return { report, changed };
  }
}
