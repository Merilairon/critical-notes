import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import {
  applyTemplateInput,
  createCampaignInput,
  createPageFromTemplateInput,
  createPageInput,
  instantiateBlockInput,
  setTemplateDefaultInput,
  createPropertyInput,
  movePageInput,
  pageTypeSchema,
  updateCampaignInput,
  updatePageInput,
  updatePropertyInput,
  createInviteInput,
  migrateEditionInput,
  rulesetSchema,
  updateMemberInput,
  facetTypeFor,
  projectFacetForPlayers,
  type PageType,
} from '@cn/shared';
import { projectDoc, queryFilterSchema, type BlockDocument } from '@cn/blocks';
import type { PageSearchIndex } from '../reference/page-search';
import type { PropertyService } from '../services/properties';
import type { UploadService } from '../services/uploads';
import { requireUser, type AppEnv } from '../auth/session';
import { audit } from '../lib/audit';
import { badRequest, forbidden, notFound, validate } from '../lib/http';
import type { ReferenceService } from '../reference/service';
import type { CampaignService } from '../services/campaigns';
import type { HomebrewService } from '../services/homebrew';
import type { PageService } from '../services/pages';
import type { TemplateService } from '../services/templates';
import type { VisibilityService } from '../services/visibility';
import { MAX_ZIP_BYTES, type CampaignTransfer } from '../services/campaign-transfer';
import type { EditionMigration } from '../services/migration';

const cloneStatblockInput = z.object({
  pageId: z.string().max(64),
  baseUid: z.string().max(300),
  name: z.string().trim().min(1).max(120).optional(),
});

const homebrewUpdateInput = z.object({
  data: z.record(z.string(), z.unknown()),
  message: z.string().max(200).optional(),
});

const queryInput = z.object({
  filter: queryFilterSchema.optional(),
  contextPageId: z.string().max(64).nullable().optional(),
});

export function campaignRoutes(deps: {
  campaigns: CampaignService;
  pages: PageService;
  homebrew: HomebrewService;
  reference: ReferenceService;
  properties: PropertyService;
  pageSearch: PageSearchIndex;
  uploads: UploadService;
  templates: TemplateService;
  visibility: VisibilityService;
  transfer: CampaignTransfer;
  migration: EditionMigration;
}) {
  const {
    campaigns,
    pages,
    homebrew,
    reference,
    properties,
    pageSearch,
    uploads,
    templates,
    visibility,
    transfer,
    migration,
  } = deps;
  const app = new Hono<AppEnv>();
  app.use('*', requireUser);
  const uid = (c: { get(key: 'user'): AppEnv['Variables']['user'] }) => c.get('user')!.id;
  /** The member asking, and the pages they may see (every check below starts here). */
  const seen = (c: { get(key: 'user'): AppEnv['Variables']['user']; req: { param(k: 'campaignId'): string } }) => {
    const campaignId = c.req.param('campaignId');
    const viewer = campaigns.viewer(campaignId, uid(c));
    return { campaignId, viewer, visible: visibility.visiblePageIds(campaignId, viewer) };
  };

  app.get('/', (c) => c.json({ campaigns: campaigns.list(uid(c)) }));

  app.post('/', validate('json', createCampaignInput), (c) =>
    c.json(campaigns.create(uid(c), c.req.valid('json')), 201),
  );

  /** A campaign file (zip) becomes a new campaign owned by the importer. */
  app.post(
    '/import',
    bodyLimit({
      maxSize: MAX_ZIP_BYTES + 64 * 1024,
      onError: () => {
        throw badRequest(`The file is larger than ${MAX_ZIP_BYTES / 1024 / 1024} MB`);
      },
    }),
    async (c) => {
      const body = await c.req.parseBody();
      const file = body['file'];
      if (!(file instanceof File)) throw badRequest('Choose a campaign file (.zip)');
      return c.json(await transfer.importZip(uid(c), new Uint8Array(await file.arrayBuffer())), 201);
    },
  );

  app.get('/:campaignId/export', async (c) => {
    const campaignId = c.req.param('campaignId');
    campaigns.requireDm(campaignId, uid(c));
    const { name, zip } = await transfer.exportZip(campaignId, uid(c));
    const filename = `${
      name
        .replace(/[^\w\- ]+/g, '')
        .trim()
        .replace(/\s+/g, '-') || 'campaign'
    }.zip`;
    return c.body(zip as unknown as ArrayBuffer, 200, {
      'content-type': 'application/zip',
      'content-disposition': `attachment; filename="${filename}"`,
    });
  });

  app.get('/:campaignId', (c) => {
    const { campaignId, viewer, visible } = seen(c);
    const campaign = campaigns.get(campaignId, uid(c));
    if (viewer.gm) return c.json(campaign);
    // House rules may hold DM notes too
    return c.json({
      ...campaign,
      houseRules: projectDoc(campaign.houseRules as BlockDocument | null, {
        role: 'player',
        canSeePage: (id) => visible.has(id),
      }),
    });
  });

  app.patch('/:campaignId', validate('json', updateCampaignInput), (c) =>
    c.json(campaigns.update(c.req.param('campaignId'), uid(c), c.req.valid('json'))),
  );

  // region Pages (players see and receive only what the visibility service allows)

  app.get('/:campaignId/pages', (c) => {
    const { campaignId, viewer, visible } = seen(c);
    const type = c.req.query('type');
    if (type) {
      const parsed = pageTypeSchema.safeParse(type);
      if (!parsed.success) throw badRequest('Unknown page type');
      const list = pages.listWithFacets(campaignId, parsed.data as PageType);
      if (viewer.gm) return c.json({ pages: list });
      const facetType = facetTypeFor(parsed.data as PageType);
      return c.json({
        pages: list
          .filter((p) => visible.has(p.id))
          .map((p) => ({
            ...p,
            parentId: p.parentId && visible.has(p.parentId) ? p.parentId : null,
            facet: facetType ? projectFacetForPlayers(facetType, p.facet, (id) => visible.has(id)) : p.facet,
          })),
      });
    }
    return c.json({ pages: pages.treeFor(campaignId, viewer, visible) });
  });

  /** New pages of a type use the campaign's default template for it, unless a body is given or `?template=0`. */
  app.post('/:campaignId/pages', validate('json', createPageInput), (c) => {
    const campaignId = c.req.param('campaignId');
    campaigns.requireDm(campaignId, uid(c));
    const input = c.req.valid('json');
    const templateId =
      input.body === undefined && c.req.query('template') !== '0' ? templates.defaultFor(campaignId, input.type) : null;
    const page = templateId
      ? templates.createPage(uid(c), campaignId, {
          templateId,
          title: input.title,
          parentId: input.parentId,
          mode: 'fields',
          withChildren: true,
        })
      : pages.create(campaignId, uid(c), input);
    campaigns.touch(campaignId);
    return c.json(page, 201);
  });

  // region Templates in a campaign

  app.post('/:campaignId/pages/from-template', validate('json', createPageFromTemplateInput), (c) => {
    const campaignId = c.req.param('campaignId');
    const page = templates.createPage(uid(c), campaignId, c.req.valid('json'));
    campaigns.touch(campaignId);
    return c.json(page, 201);
  });

  app.post('/:campaignId/pages/:pageId/apply-template', validate('json', applyTemplateInput), (c) =>
    c.json(templates.applyToPage(uid(c), c.req.param('campaignId'), c.req.param('pageId'), c.req.valid('json'))),
  );

  /** Block template content to insert into a page (filled, as fields, or linked). */
  app.post('/:campaignId/templates/:templateId/instantiate', validate('json', instantiateBlockInput), (c) =>
    c.json(
      templates.instantiateBlock(uid(c), c.req.param('campaignId'), c.req.param('templateId'), c.req.valid('json')),
    ),
  );

  app.get('/:campaignId/template-defaults', (c) => {
    const campaignId = c.req.param('campaignId');
    campaigns.requireDm(campaignId, uid(c));
    return c.json({ defaults: templates.defaults(campaignId) });
  });

  app.put('/:campaignId/template-defaults', validate('json', setTemplateDefaultInput), (c) => {
    const { pageType, templateId } = c.req.valid('json');
    return c.json({ defaults: templates.setDefault(uid(c), c.req.param('campaignId'), pageType, templateId) });
  });

  // endregion

  app.get('/:campaignId/pages/:pageId', (c) => {
    const { campaignId, viewer, visible } = seen(c);
    // DM preview of what players receive (same projection the player API uses)
    if (viewer.gm && c.req.query('as') === 'player')
      return c.json(pages.projectForPlayers(campaignId, pages.get(campaignId, c.req.param('pageId'))));
    return c.json(pages.getFor(campaignId, viewer, c.req.param('pageId'), visible));
  });

  /** Game masters edit every page; players only their own character (hidden blocks are kept). */
  app.patch('/:campaignId/pages/:pageId', validate('json', updatePageInput), (c) => {
    const { campaignId, viewer, visible } = seen(c);
    const pageId = c.req.param('pageId');
    let page;
    if (viewer.gm) page = pages.update(campaignId, pageId, c.req.valid('json'));
    else if (visibility.canEdit(campaignId, viewer, pageId))
      page = pages.updateAsPlayer(campaignId, pageId, c.req.valid('json'), visible);
    else if (visible.has(pageId)) throw forbidden('Only the DM can edit this page');
    else throw notFound('Page not found');
    campaigns.touch(campaignId);
    return c.json(page);
  });

  app.post('/:campaignId/pages/:pageId/move', validate('json', movePageInput), (c) => {
    const campaignId = c.req.param('campaignId');
    campaigns.requireDm(campaignId, uid(c));
    return c.json(pages.move(campaignId, c.req.param('pageId'), c.req.valid('json')));
  });

  app.delete('/:campaignId/pages/:pageId', (c) => {
    const campaignId = c.req.param('campaignId');
    campaigns.requireDm(campaignId, uid(c));
    return c.json({ deleted: pages.remove(campaignId, c.req.param('pageId')) });
  });

  /** Brings back a deleted page (and the subpages deleted with it). */
  app.post('/:campaignId/pages/:pageId/restore', (c) => {
    const campaignId = c.req.param('campaignId');
    campaigns.requireDm(campaignId, uid(c));
    const restored = pages.restore(campaignId, c.req.param('pageId'));
    campaigns.touch(campaignId);
    return c.json({ restored });
  });

  /** Deleted page trees (GM only). */
  app.get('/:campaignId/trash', (c) => {
    const campaignId = c.req.param('campaignId');
    campaigns.requireDm(campaignId, uid(c));
    return c.json({ items: pages.trash(campaignId) });
  });

  /** Permanently deletes a page that is already in the trash, with the subpages deleted together with it. */
  app.delete('/:campaignId/pages/:pageId/purge', (c) => {
    const campaignId = c.req.param('campaignId');
    campaigns.requireDm(campaignId, uid(c));
    const purged = pages.purge(campaignId, c.req.param('pageId'));
    audit('page.purged', { campaignId, pageId: c.req.param('pageId'), actor: uid(c), count: purged.length });
    return c.json({ purged });
  });

  app.get('/:campaignId/pages/:pageId/backlinks', (c) => {
    const { campaignId, viewer, visible } = seen(c);
    const pageId = c.req.param('pageId');
    if (!visible.has(pageId)) throw notFound('Page not found');
    return c.json({ backlinks: pages.backlinksFor(campaignId, viewer, pageId, visible) });
  });

  /** Live page lists for query blocks. */
  app.post('/:campaignId/query', validate('json', queryInput), (c) => {
    const { campaignId, viewer, visible } = seen(c);
    const { filter, contextPageId } = c.req.valid('json');
    return c.json({ rows: pages.queryFor(campaignId, viewer, filter ?? {}, contextPageId ?? null, visible) });
  });

  /** Page search (Cmd-K, [[link]] autocomplete). Players search the text they can see, on pages they can see. */
  app.get('/:campaignId/search', (c) => {
    const { campaignId, viewer, visible } = seen(c);
    const q = c.req.query('q') ?? '';
    const limit = Math.min(50, Math.max(1, Number(c.req.query('limit') ?? 20) || 20));
    if (viewer.gm) return c.json({ pages: pageSearch.search(campaignId, q, { mode: 'dm', limit }) });
    const hits = pageSearch
      .search(campaignId, q, { mode: 'player', limit: limit * 3 })
      .filter((h) => visible.has(h.pageId));
    return c.json({ pages: hits.slice(0, limit).map((h) => ({ ...h, snippet: null })) });
  });

  // region Custom properties

  app.get('/:campaignId/properties', (c) => {
    const campaignId = c.req.param('campaignId');
    const viewer = campaigns.viewer(campaignId, uid(c));
    const list = properties.list(campaignId);
    return c.json({ properties: viewer.gm ? list : list.filter((d) => !d.dmOnly) });
  });

  app.post('/:campaignId/properties', validate('json', createPropertyInput), (c) => {
    const campaignId = c.req.param('campaignId');
    campaigns.requireDm(campaignId, uid(c));
    return c.json(properties.create(campaignId, c.req.valid('json')), 201);
  });

  app.patch('/:campaignId/properties/:propertyId', validate('json', updatePropertyInput), (c) => {
    const campaignId = c.req.param('campaignId');
    campaigns.requireDm(campaignId, uid(c));
    return c.json(properties.update(campaignId, c.req.param('propertyId'), c.req.valid('json')));
  });

  app.delete('/:campaignId/properties/:propertyId', (c) => {
    const campaignId = c.req.param('campaignId');
    campaigns.requireDm(campaignId, uid(c));
    properties.remove(campaignId, c.req.param('propertyId'));
    return c.json({ ok: true });
  });

  // endregion

  // region Uploads

  /** Any member (players add pictures to their characters). */
  app.post('/:campaignId/uploads', async (c) => {
    const campaignId = c.req.param('campaignId');
    campaigns.access(campaignId, uid(c));
    const body = await c.req.parseBody();
    const file = body['file'];
    if (!(file instanceof File)) throw badRequest('Expected a "file" field');
    return c.json(await uploads.store(campaignId, uid(c), file), 201);
  });

  // endregion

  // endregion

  // region NPC statblocks (campaign-only homebrew `_copy`)

  /** Clone a reference statblock into the campaign source and link it to an NPC page. */
  app.post('/:campaignId/npc-statblocks', validate('json', cloneStatblockInput), (c) => {
    const campaignId = c.req.param('campaignId');
    const user = uid(c);
    campaigns.requireDm(campaignId, user);
    const input = c.req.valid('json');
    const page = pages.get(campaignId, input.pageId);
    if (page.type !== 'npc') throw badRequest('Statblocks can only be attached to NPC pages');
    const base = reference.get(input.baseUid, campaigns.policy(campaignId, user));
    if (!base || base.kind !== 'monster') throw badRequest('Base statblock not found');
    const source = campaigns.campaignSource(campaignId);
    if (!source) throw badRequest('Campaign has no homebrew source');
    const baseRef =
      base.raw && typeof base.raw['name'] === 'string'
        ? { name: String(base.raw['name']), source: base.source }
        : { name: base.name, source: base.source };
    const {
      entity,
      uid: newUid,
      warnings,
    } = homebrew.create(source.id, user, 'monster', homebrew.copyOf(baseRef, input.name ?? page.title));
    const updated = pages.update(campaignId, page.id, {
      revision: page.revision,
      facet: { statblockUid: newUid, statblockHomebrewEntityId: entity.id },
    });
    return c.json({ page: updated, entityId: entity.id, uid: newUid, warnings }, 201);
  });

  /** Read a campaign homebrew entity (raw `_copy` JSON) for editing. */
  app.get('/:campaignId/homebrew/:entityId', (c) => {
    const campaignId = c.req.param('campaignId');
    campaigns.requireDm(campaignId, uid(c));
    const entity = homebrew.entity(c.req.param('entityId'));
    const source = homebrew.source(entity.sourceId);
    if (source.campaignId !== campaignId) throw badRequest('Not a campaign entity');
    return c.json({
      id: entity.id,
      entityType: entity.entityType,
      data: entity.data,
      revision: entity.currentRevision,
      sourceJsonId: source.jsonId,
    });
  });

  app.put('/:campaignId/homebrew/:entityId', validate('json', homebrewUpdateInput), (c) => {
    const campaignId = c.req.param('campaignId');
    const user = uid(c);
    campaigns.requireDm(campaignId, user);
    const entity = homebrew.entity(c.req.param('entityId'));
    const source = homebrew.source(entity.sourceId);
    if (source.campaignId !== campaignId) throw badRequest('Not a campaign entity');
    const { data, message } = c.req.valid('json');
    const result = homebrew.update(entity.id, user, data, undefined, message);
    if (result.uid) pages.relinkStatblock(entity.id, result.uid);
    return c.json({ uid: result.uid, warnings: result.warnings, revision: result.entity.currentRevision });
  });

  // endregion

  // region Edition migration (owner only)

  app.get('/:campaignId/migrate-edition', (c) => {
    const to = rulesetSchema.safeParse(c.req.query('to'));
    if (!to.success) throw badRequest('Choose the rules to move to');
    return c.json(migration.plan(c.req.param('campaignId'), uid(c), to.data));
  });

  app.post('/:campaignId/migrate-edition', validate('json', migrateEditionInput), (c) => {
    const { to, keep } = c.req.valid('json');
    return c.json(migration.apply(c.req.param('campaignId'), uid(c), to, keep));
  });

  // endregion

  // region Members and invites

  /** Players see who is in the campaign, and only the characters they can see. */
  const membersFor = (c: Parameters<typeof seen>[0]) => {
    const { campaignId, viewer, visible } = seen(c);
    const members = campaigns.members(campaignId, viewer.userId);
    if (viewer.gm) return members;
    return members.map((m) => ({ ...m, characters: m.characters.filter((ch) => visible.has(ch.pageId)) }));
  };
  app.get('/:campaignId/members', (c) => c.json({ members: membersFor(c) }));

  app.patch('/:campaignId/members/:userId', validate('json', updateMemberInput), (c) => {
    campaigns.setRole(c.req.param('campaignId'), uid(c), c.req.param('userId'), c.req.valid('json').role);
    return c.json({ members: campaigns.members(c.req.param('campaignId'), uid(c)) });
  });

  /** The owner removes a member, or a member leaves (their own id). */
  app.delete('/:campaignId/members/:userId', (c) => {
    campaigns.removeMember(c.req.param('campaignId'), uid(c), c.req.param('userId'));
    return c.body(null, 204);
  });

  app.get('/:campaignId/invites', (c) => c.json({ invites: campaigns.invites(c.req.param('campaignId'), uid(c)) }));

  app.post('/:campaignId/invites', validate('json', createInviteInput), (c) =>
    c.json(campaigns.createInvite(c.req.param('campaignId'), uid(c), c.req.valid('json')), 201),
  );

  app.delete('/:campaignId/invites/:inviteId', (c) => {
    campaigns.revokeInvite(c.req.param('campaignId'), uid(c), c.req.param('inviteId'));
    return c.body(null, 204);
  });

  // endregion

  return app;
}
