/**
 * Campaign export and import as a zip: `campaign.json` (settings, pages with their content, details and
 * properties, property definitions, encounters, inventory, campaign templates, the campaign's own homebrew
 * as a 5etools document) plus `uploads/<id>` image files.
 *
 * Import always creates a new campaign owned by the importer. Every id is replaced (pages, encounters,
 * templates, uploads) and the campaign-only homebrew moves to the new campaign's source, so the same file
 * can be imported next to the original. Members and who may see "selected" pages are not exported.
 */
import { and, asc, eq, isNull } from 'drizzle-orm';
import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from 'fflate';
import { isObject, RULESET_IDS, type JsonObject, type RulesetId } from '@cn/fivetools';
import {
  CAMPAIGN_EXPORT_FORMAT,
  CAMPAIGN_EXPORT_VERSION,
  type CampaignImportReportDto,
  type EncounterCreature,
  type PageDto,
  type PageType,
  type PageVisibility,
  type PropertyType,
} from '@cn/shared';
import type { AppDb } from '../db';
import { campaigns, campaignTemplateDefaults, currencies, encounters, inventoryItems, pages, templates } from '../db/schema';
import type { HomebrewTransfer } from '../homebrew/transfer';
import { badRequest } from '../lib/http';
import { newId } from '../lib/ids';
import type { IndexDb } from '../reference/index-db';
import type { CampaignService } from './campaigns';
import type { HomebrewService } from './homebrew';
import type { PageService } from './pages';
import type { PropertyService } from './properties';
import { contextFor, type WriteOrigin } from './revisions';
import type { TemplateService } from './templates';
import type { UploadService } from './uploads';

export const MAX_ZIP_BYTES = 150 * 1024 * 1024;
const MAX_JSON_BYTES = 60 * 1024 * 1024;
const MAX_UPLOADS = 2000;

interface ExportedPage {
  id: string;
  parentId: string | null;
  type: string;
  title: string;
  icon: string | null;
  cover: string | null;
  visibility: string;
  tags: string[];
  body: unknown;
  facet: Record<string, unknown> | null;
  props: Record<string, unknown>;
  fromTemplateId: string | null;
}

export interface CampaignExport {
  format: typeof CAMPAIGN_EXPORT_FORMAT;
  schemaVersion: number;
  exportedAt: number;
  campaign: { name: string; description: string; ruleset: string; crossEdition: boolean; houseRules: unknown; status: string };
  sourceOverrides: Record<string, boolean>;
  propertyDefs: { id: string; key: string; label: string; type: string; options: string[] | null; appliesTo: string[] | null; dmOnly: boolean; refKind: string | null }[];
  pages: ExportedPage[];
  encounters: { id: string; name: string; notes: string; locationPageId: string | null; creatures: unknown[]; party: unknown }[];
  inventory: { items: { ownerPageId: string | null; itemUid: string | null; name: string; quantity: number; attuned: boolean; identified: boolean; sessionPageId: string | null; notes: string }[]; coins: Record<string, Record<string, number>> };
  templates: { id: string; kind: string; name: string; description: string; icon: string | null; tags: string[]; definition: Record<string, unknown> }[];
  templateDefaults: Record<string, string>;
  /** json id of the campaign-only homebrew source, and its content as 5etools homebrew. */
  homebrewSourceId: string | null;
  homebrew: JsonObject | null;
  uploads: { id: string; filename: string; mime: string }[];
}

function escapeRegExp(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Replaces old ids (exact string matches) and moves `|OldSource` references to the new homebrew source. */
function remapper(ids: Map<string, string>, oldSource: string | null, newSource: string | null) {
  const sourceRe = oldSource && newSource ? new RegExp(`\\|${escapeRegExp(oldSource)}(?=$|[|}\\s"])`, 'gi') : null;
  const fix = (value: unknown): unknown => {
    if (typeof value === 'string') {
      const mapped = ids.get(value);
      if (mapped) return mapped;
      return sourceRe ? value.replace(sourceRe, (m) => (m === m.toLowerCase() ? `|${newSource!.toLowerCase()}` : `|${newSource}`)) : value;
    }
    if (Array.isArray(value)) return value.map(fix);
    if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fix(v)]));
    return value;
  };
  return fix;
}

export class CampaignTransfer {
  constructor(
    private readonly db: AppDb,
    private readonly indexDb: IndexDb,
    private readonly services: {
      campaigns: CampaignService;
      pages: PageService;
      properties: PropertyService;
      templates: TemplateService;
      homebrew: HomebrewService;
      homebrewTransfer: HomebrewTransfer;
      uploads: UploadService;
    },
  ) {}

  // region Export

  async exportZip(campaignId: string, userId: string): Promise<{ name: string; zip: Uint8Array }> {
    const { campaigns: cs, pages: ps, properties, uploads, homebrewTransfer } = this.services;
    const campaign = cs.get(campaignId, userId);
    const rows = this.db
      .select({ id: pages.id, parentId: pages.parentId, fromTemplateId: pages.fromTemplateId })
      .from(pages)
      .where(and(eq(pages.campaignId, campaignId), isNull(pages.deletedAt)))
      .orderBy(asc(pages.sortKey))
      .all();
    const exportedPages: ExportedPage[] = rows.map((r) => {
      const p: PageDto = ps.get(campaignId, r.id);
      const { playerUserId: _player, ...facet } = (p.facet ?? {}) as Record<string, unknown>;
      return {
        id: p.id,
        parentId: p.parentId,
        type: p.type,
        title: p.title,
        icon: p.icon,
        cover: p.cover,
        visibility: p.visibility,
        tags: p.tags,
        body: p.body,
        facet: p.facet ? facet : null,
        props: p.props,
        fromTemplateId: r.fromTemplateId,
      };
    });
    const ownSource = cs.campaignSource(campaignId);
    const doc: CampaignExport = {
      format: CAMPAIGN_EXPORT_FORMAT,
      schemaVersion: CAMPAIGN_EXPORT_VERSION,
      exportedAt: Date.now(),
      campaign: {
        name: campaign.name,
        description: campaign.description,
        ruleset: campaign.ruleset,
        crossEdition: campaign.crossEdition,
        houseRules: campaign.houseRules,
        status: campaign.status,
      },
      sourceOverrides: campaign.sourceOverrides,
      propertyDefs: properties.list(campaignId).map((d) => ({ id: d.id, key: d.key, label: d.label, type: d.type, options: d.options, appliesTo: d.appliesTo, dmOnly: d.dmOnly, refKind: d.refKind })),
      pages: exportedPages,
      encounters: this.db
        .select()
        .from(encounters)
        .where(and(eq(encounters.campaignId, campaignId), isNull(encounters.deletedAt)))
        .all()
        .map((e) => ({ id: e.id, name: e.name, notes: e.notes, locationPageId: e.locationPageId, creatures: e.creatures as unknown[], party: e.party })),
      inventory: {
        items: this.db
          .select()
          .from(inventoryItems)
          .where(eq(inventoryItems.campaignId, campaignId))
          .all()
          .map((i) => ({ ownerPageId: i.ownerPageId, itemUid: i.itemUid, name: i.name, quantity: i.quantity, attuned: i.attuned, identified: i.identified, sessionPageId: i.sessionPageId, notes: i.notes })),
        coins: Object.fromEntries(
          this.db
            .select()
            .from(currencies)
            .where(eq(currencies.campaignId, campaignId))
            .all()
            .map((c) => [c.ownerKey, { cp: c.cp, sp: c.sp, ep: c.ep, gp: c.gp, pp: c.pp }]),
        ),
      },
      templates: this.db
        .select()
        .from(templates)
        .where(and(eq(templates.campaignId, campaignId), eq(templates.scope, 'campaign'), isNull(templates.deletedAt)))
        .all()
        .map((t) => ({ id: t.id, kind: t.kind, name: t.name, description: t.description, icon: t.icon, tags: (t.tags as string[]) ?? [], definition: t.definition as Record<string, unknown> })),
      templateDefaults: Object.fromEntries(
        this.db
          .select()
          .from(campaignTemplateDefaults)
          .where(eq(campaignTemplateDefaults.campaignId, campaignId))
          .all()
          .map((d) => [d.pageType, d.templateId]),
      ),
      homebrewSourceId: ownSource?.jsonId ?? null,
      homebrew: ownSource ? homebrewTransfer.exportSource(userId, ownSource.id) : null,
      uploads: uploads.list(campaignId).map((u) => ({ id: u.id, filename: u.filename, mime: u.mime })),
    };
    const files: Zippable = { 'campaign.json': strToU8(JSON.stringify(doc)) };
    for (const u of doc.uploads) {
      try {
        // Images are already compressed: store them as they are
        files[`uploads/${u.id}`] = [await uploads.read(u.id), { level: 0 }];
      } catch {
        // a missing file is skipped (the image block shows a placeholder)
      }
    }
    return { name: campaign.name, zip: zipSync(files, { level: 6 }) };
  }

  // endregion

  // region Import

  private readZip(bytes: Uint8Array): { doc: CampaignExport; files: Map<string, Uint8Array> } {
    if (bytes.length > MAX_ZIP_BYTES) throw badRequest(`The file is larger than ${MAX_ZIP_BYTES / 1024 / 1024} MB`);
    let entries: Record<string, Uint8Array>;
    let total = 0;
    let count = 0;
    try {
      entries = unzipSync(bytes, {
        // Only the files a campaign export contains, and nothing that decompresses into something huge
        filter: (f) => {
          if (f.name !== 'campaign.json' && !/^uploads\/[0-9a-f-]{36}$/.test(f.name)) return false;
          total += f.originalSize;
          count++;
          if (f.originalSize > (f.name === 'campaign.json' ? MAX_JSON_BYTES : 16 * 1024 * 1024) || total > MAX_JSON_BYTES * 5 || count > MAX_UPLOADS + 1) {
            throw new Error('The archive is too large');
          }
          return true;
        },
      });
    } catch (e) {
      throw badRequest(e instanceof Error && e.message === 'The archive is too large' ? e.message : 'Not a Critical Notes campaign file (not a zip archive)');
    }
    const json = entries['campaign.json'];
    if (!json) throw badRequest('Not a Critical Notes campaign file (no campaign.json)');
    let doc: CampaignExport;
    try {
      doc = JSON.parse(strFromU8(json)) as CampaignExport;
    } catch {
      throw badRequest('campaign.json is not valid JSON');
    }
    if (!isObject(doc) || doc.format !== CAMPAIGN_EXPORT_FORMAT) throw badRequest('Not a Critical Notes campaign file');
    if (typeof doc.schemaVersion !== 'number' || doc.schemaVersion > CAMPAIGN_EXPORT_VERSION) {
      throw badRequest(`This campaign was exported by a newer version of Critical Notes (format ${String(doc.schemaVersion)}). Update the app to import it.`);
    }
    const files = new Map<string, Uint8Array>();
    for (const [name, data] of Object.entries(entries)) if (name.startsWith('uploads/')) files.set(name.slice(8), data);
    return { doc, files };
  }

  async importZip(userId: string, bytes: Uint8Array, origin: WriteOrigin): Promise<CampaignImportReportDto> {
    const { doc, files } = this.readZip(bytes);
    const { campaigns: cs, pages: ps, properties, templates: ts, homebrewTransfer, uploads } = this.services;
    const warnings: string[] = [];
    const list = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
    const ruleset = (RULESET_IDS as readonly string[]).includes(String(doc.campaign?.ruleset)) ? (doc.campaign.ruleset as RulesetId) : null;
    if (!ruleset || typeof doc.campaign?.name !== 'string') throw badRequest('campaign.json has no valid campaign');

    const created = cs.create(userId, {
      name: doc.campaign.name.slice(0, 120),
      description: String(doc.campaign.description ?? '').slice(0, 2000),
      ruleset,
      crossEdition: !!doc.campaign.crossEdition,
    });
    const campaignId = created.id;
    // One import: the create and the fill of a page are one history row (design 4.6)
    const writeCtx = contextFor(userId, origin, 'import', { operationId: newId() });
    const newSource = cs.campaignSource(campaignId)!;
    const ids = new Map<string, string>();

    // Uploads first: content refers to them by id
    let uploaded = 0;
    for (const u of list<CampaignExport['uploads'][number]>(doc.uploads)) {
      const data = typeof u?.id === 'string' ? files.get(u.id) : undefined;
      if (!data) continue;
      try {
        ids.set(u.id, (await uploads.storeBytes(campaignId, userId, String(u.filename ?? 'image'), data)).id);
        uploaded++;
      } catch (e) {
        warnings.push(`Image ${String(u.filename)}: ${(e as Error).message}`);
      }
    }
    const fix = () => remapper(ids, doc.homebrewSourceId, newSource.jsonId);

    // Property definitions (keys can only differ if labels collide)
    const keyMap = new Map<string, string>();
    for (const d of list<CampaignExport['propertyDefs'][number]>(doc.propertyDefs)) {
      try {
        const def = properties.create(campaignId, { label: d.label, type: d.type as PropertyType, options: d.options ?? null, appliesTo: (d.appliesTo as PageType[] | null) ?? null, dmOnly: !!d.dmOnly, refKind: d.refKind ?? null });
        keyMap.set(d.key, def.key);
      } catch (e) {
        warnings.push(`Property ${String(d.label)}: ${(e as Error).message}`);
      }
    }

    // The campaign's own homebrew moves to the new campaign's source
    let homebrewCount = 0;
    if (isObject(doc.homebrew)) {
      const report = homebrewTransfer.importInto(userId, newSource.id, fix()(doc.homebrew) as JsonObject);
      homebrewCount = report.created + report.updated;
      warnings.push(...report.skipped.map((s) => `Homebrew ${s.name}: ${s.reason}`));
    }
    const homebrewIds = new Map(
      (this.indexDb.prepare("SELECT uid, homebrew_entity_id AS id FROM entity WHERE source = ? AND origin = 'homebrew'").all(newSource.jsonIdLower) as { uid: string; id: string }[]).map((r) => [r.uid, r.id]),
    );

    // Campaign templates (their content may refer to pages, so ids are fixed again after the pages exist)
    const exportedTemplates = list<CampaignExport['templates'][number]>(doc.templates);
    for (const t of exportedTemplates) {
      try {
        const tpl = ts.create(userId, { kind: t.kind === 'page' ? 'page' : 'block', scope: 'campaign', campaignId, name: String(t.name).slice(0, 120), description: String(t.description ?? '').slice(0, 500), icon: t.icon ?? null, tags: list<string>(t.tags).slice(0, 20), definition: fix()(t.definition) as Record<string, unknown> });
        ids.set(t.id, tpl.id);
      } catch (e) {
        warnings.push(`Template ${String(t.name)}: ${(e as Error).message}`);
      }
    }

    // Pages: the tree first (parents before children, in their order), then content once every page exists
    const exportedPages = list<ExportedPage>(doc.pages).filter((p) => typeof p?.id === 'string');
    const byParent = new Map<string | null, ExportedPage[]>();
    const known = new Set(exportedPages.map((p) => p.id));
    for (const p of exportedPages) {
      const parent = p.parentId && known.has(p.parentId) ? p.parentId : null;
      byParent.set(parent, [...(byParent.get(parent) ?? []), p]);
    }
    const ordered: ExportedPage[] = [];
    const visit = (parent: string | null) => {
      for (const p of byParent.get(parent) ?? []) {
        ordered.push(p);
        visit(p.id);
      }
    };
    visit(null);
    for (const p of ordered) {
      try {
        const page = ps.create(campaignId, userId, {
          type: p.type as PageType,
          title: String(p.title || 'Untitled').slice(0, 200),
          parentId: p.parentId ? (ids.get(p.parentId) ?? null) : null,
          icon: p.icon ?? null,
          // Named viewers do not exist here: "selected" pages become DM-only
          visibility: (p.visibility === 'all' ? 'all' : 'dm') as PageVisibility,
          tags: list<string>(p.tags).slice(0, 30),
        }, writeCtx);
        ids.set(p.id, page.id);
      } catch (e) {
        warnings.push(`Page ${String(p.title)}: ${(e as Error).message}`);
      }
    }
    const remap = fix();
    for (const p of ordered) {
      const id = ids.get(p.id);
      if (!id) continue;
      try {
        const facet = isObject(p.facet) ? (remap(p.facet) as Record<string, unknown>) : undefined;
        if (facet && typeof facet['statblockUid'] === 'string') facet['statblockHomebrewEntityId'] = homebrewIds.get(facet['statblockUid']) ?? null;
        const props = Object.fromEntries(
          Object.entries(isObject(p.props) ? (remap(p.props) as Record<string, unknown>) : {})
            .filter(([k]) => keyMap.has(k))
            .map(([k, v]) => [keyMap.get(k)!, v]),
        );
        ps.update(campaignId, id, {
          revision: 1,
          ...(isObject(p.body) ? { body: remap(p.body) as never } : {}),
          ...(facet ? { facet } : {}),
          ...(Object.keys(props).length ? { props } : {}),
          ...(p.cover ? { cover: String(p.cover) } : {}),
        }, writeCtx);
        const template = p.fromTemplateId ? ids.get(p.fromTemplateId) : undefined;
        if (template) this.db.update(pages).set({ fromTemplateId: template }).where(eq(pages.id, id)).run();
      } catch (e) {
        warnings.push(`Page ${String(p.title)}: ${(e as Error).message}`);
      }
    }
    // Templates again, now that page ids are known (e.g. a query in a template filtering on a page)
    for (const t of exportedTemplates) {
      const id = ids.get(t.id);
      if (id) this.db.update(templates).set({ definition: remap(t.definition) as Record<string, unknown> }).where(eq(templates.id, id)).run();
    }

    // Encounters, inventory, defaults, settings
    const pageIds = new Set(ordered.map((p) => ids.get(p.id)).filter((id): id is string => !!id));
    let encounterCount = 0;
    for (const e of list<CampaignExport['encounters'][number]>(doc.encounters)) {
      try {
        const fixed = remap(e) as CampaignExport['encounters'][number];
        this.db
          .insert(encounters)
          .values({
            id: newId(),
            campaignId,
            name: String(fixed.name).slice(0, 120),
            notes: String(fixed.notes ?? '').slice(0, 5000),
            locationPageId: fixed.locationPageId && pageIds.has(fixed.locationPageId) ? fixed.locationPageId : null,
            creatures: list<EncounterCreature>(fixed.creatures).slice(0, 100),
            party: isObject(fixed.party) ? fixed.party : { mode: 'campaign', levels: [] },
          })
          .run();
        encounterCount++;
      } catch (err) {
        warnings.push(`Encounter ${String(e.name)}: ${(err as Error).message}`);
      }
    }
    for (const i of list<CampaignExport['inventory']['items'][number]>(doc.inventory?.items)) {
      const fixed = remap(i) as typeof i;
      this.db
        .insert(inventoryItems)
        .values({
          id: newId(),
          campaignId,
          ownerPageId: fixed.ownerPageId && pageIds.has(fixed.ownerPageId) ? fixed.ownerPageId : null,
          itemUid: typeof fixed.itemUid === 'string' ? fixed.itemUid : null,
          name: String(fixed.name || 'Item').slice(0, 200),
          quantity: Math.max(1, Math.min(100000, Math.floor(Number(fixed.quantity) || 1))),
          attuned: !!fixed.attuned,
          identified: fixed.identified !== false,
          sessionPageId: fixed.sessionPageId && pageIds.has(fixed.sessionPageId) ? fixed.sessionPageId : null,
          notes: String(fixed.notes ?? '').slice(0, 1000),
        })
        .run();
    }
    for (const [owner, coins] of Object.entries(isObject(doc.inventory?.coins) ? doc.inventory.coins : {})) {
      const key = owner === 'party' ? 'party' : ids.get(owner);
      if (!key || !isObject(coins)) continue;
      const n = (c: string) => Math.max(0, Math.floor(Number((coins as Record<string, unknown>)[c]) || 0));
      this.db.insert(currencies).values({ campaignId, ownerKey: key, cp: n('cp'), sp: n('sp'), ep: n('ep'), gp: n('gp'), pp: n('pp') }).onConflictDoNothing().run();
    }
    for (const [pageType, templateId] of Object.entries(isObject(doc.templateDefaults) ? doc.templateDefaults : {})) {
      const id = typeof templateId === 'string' ? ids.get(templateId) : undefined;
      if (id) this.db.insert(campaignTemplateDefaults).values({ campaignId, pageType, templateId: id }).onConflictDoNothing().run();
    }
    const overrides = isObject(doc.sourceOverrides) ? Object.fromEntries(Object.entries(doc.sourceOverrides).filter(([, v]) => typeof v === 'boolean')) : {};
    cs.update(campaignId, userId, {
      houseRules: isObject(doc.campaign.houseRules) ? (remap(doc.campaign.houseRules) as never) : null,
      sourceOverrides: overrides as Record<string, boolean>,
      ...(doc.campaign.status === 'archived' ? { status: 'archived' as const } : {}),
    });
    this.db.update(campaigns).set({ updatedAt: Date.now() }).where(eq(campaigns.id, campaignId)).run();
    return { campaignId, pages: ordered.filter((p) => ids.has(p.id)).length, encounters: encounterCount, templates: exportedTemplates.filter((t) => ids.has(t.id)).length, homebrew: homebrewCount, uploads: uploaded, warnings };
  }

  // endregion
}
