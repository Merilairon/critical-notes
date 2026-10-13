/**
 * Homebrew API: sources (CRUD, sharing, export), entities (validated saves, revisions, soft delete,
 * usage), live preview, "copy to homebrew" from the reference, and import from files or a URL.
 */
import { makePolicy, RULESET_IDS, type JsonObject } from '@cn/fivetools';
import {
  copyToHomebrewInput,
  createHomebrewSourceInput,
  HOMEBREW_EDITIONS,
  importHomebrewUrlInput,
  previewHomebrewInput,
  saveHomebrewEntityInput,
  shareHomebrewSourceInput,
  updateHomebrewSourceInput,
  type HomebrewEdition,
} from '@cn/shared';
import { Hono } from 'hono';
import type { AppEnv } from '../auth/session';
import { fetchUrlText, UrlFetchError } from '../homebrew/fetch-url';
import type { BrewFile, HomebrewTransfer } from '../homebrew/transfer';
import { badRequest, HttpError, notFound, validate } from '../lib/http';
import type { Services } from '../app';

const MAX_IMPORT_FILE_BYTES = 10 * 1024 * 1024;
const MAX_IMPORT_TOTAL_BYTES = 50 * 1024 * 1024;
const MAX_IMPORT_FILES = 200;

export function homebrewRoutes({ homebrew, reference }: Pick<Services, 'homebrew' | 'reference'>, transfer: HomebrewTransfer) {
  const app = new Hono<AppEnv>();
  const uid = (c: { get: (k: 'user') => AppEnv['Variables']['user'] }) => c.get('user')!.id;

  // region Sources

  app.get('/sources', (c) => c.json({ sources: homebrew.listSources(uid(c)) }));

  app.post('/sources', validate('json', createHomebrewSourceInput), (c) => c.json(homebrew.createSource(uid(c), c.req.valid('json')), 201));

  app.get('/sources/:id', (c) => c.json(homebrew.getSource(uid(c), c.req.param('id'))));

  app.patch('/sources/:id', validate('json', updateHomebrewSourceInput), (c) => c.json(homebrew.updateSource(uid(c), c.req.param('id'), c.req.valid('json'))));

  app.delete('/sources/:id', (c) => {
    homebrew.deleteSource(uid(c), c.req.param('id'));
    return c.body(null, 204);
  });

  app.put('/sources/:id/shares', validate('json', shareHomebrewSourceInput), (c) =>
    c.json(homebrew.shareSource(uid(c), c.req.param('id'), c.req.valid('json').campaignIds)),
  );

  app.get('/sources/:id/entities', (c) =>
    c.json({ entities: homebrew.listEntities(uid(c), c.req.param('id'), { includeDeleted: c.req.query('deleted') === '1' }) }),
  );

  app.post('/sources/:id/entities', validate('json', saveHomebrewEntityInput), (c) => c.json(homebrew.createEntity(uid(c), c.req.param('id'), c.req.valid('json')), 201));

  app.get('/sources/:id/export', (c) => {
    const doc = transfer.exportSource(uid(c), c.req.param('id'));
    const jsonId = String(((doc._meta as JsonObject).sources as JsonObject[])[0]?.json ?? 'homebrew').replace(/[^A-Za-z0-9_.-]/g, '_');
    c.header('content-disposition', `attachment; filename="${jsonId}.json"`);
    return c.json(doc);
  });

  // endregion

  // region Entities

  app.get('/entities/:id', (c) => c.json(homebrew.getEntity(uid(c), c.req.param('id'))));

  app.put('/entities/:id', validate('json', saveHomebrewEntityInput), (c) => c.json(homebrew.updateEntity(uid(c), c.req.param('id'), c.req.valid('json'))));

  app.delete('/entities/:id', (c) => {
    homebrew.deleteEntity(uid(c), c.req.param('id'));
    return c.body(null, 204);
  });

  app.post('/entities/:id/restore', (c) => c.json(homebrew.restoreEntity(uid(c), c.req.param('id'))));

  app.get('/entities/:id/revisions', (c) => c.json({ revisions: homebrew.revisions(uid(c), c.req.param('id')) }));

  app.get('/entities/:id/revisions/:rev', (c) => c.json(homebrew.revision(uid(c), c.req.param('id'), Number(c.req.param('rev')))));

  app.post('/entities/:id/revisions/:rev/restore', (c) => c.json(homebrew.restoreRevision(uid(c), c.req.param('id'), Number(c.req.param('rev')))));

  app.get('/entities/:id/usage', (c) => c.json({ usage: homebrew.usage(uid(c), c.req.param('id')) }));

  // endregion

  /** Resolve and validate an unsaved entity (editor preview). */
  app.post('/preview', validate('json', previewHomebrewInput), (c) => {
    const { sourceId, entityType, data, entityId } = c.req.valid('json');
    return c.json(homebrew.preview(uid(c), sourceId, entityType, data as JsonObject, entityId));
  });

  /** "Copy to homebrew": a full clone or a `_copy` variant of a reference entity. */
  app.post('/copy', validate('json', copyToHomebrewInput), (c) => {
    const user = uid(c);
    const { sourceId, baseUid, mode, name } = c.req.valid('json');
    // Any official content, plus homebrew this user can see
    const policy = makePolicy(RULESET_IDS[1]!, { crossEdition: true, homebrewSources: homebrew.viewableJsonIds(user) });
    const base = reference.get(baseUid, policy);
    if (!base) throw notFound('Reference entity not found');
    const source = homebrew.source(sourceId);
    if (!homebrew.canEdit(source, user)) throw new HttpError(403, 'You cannot edit this homebrew source');
    const { entityType, data } = homebrew.fromReference(base, mode, name);
    const validation = homebrew.validate(source, entityType, data, { force: true });
    // Name clashes are fine here: the copy gets a numbered name
    const errors = validation.errors.filter((e) => !e.message.startsWith('This source already has'));
    if (errors.length) throw badRequest('The copy has errors', { ...validation, errors });
    const { entity } = homebrew.create(source.id, user, entityType, data, null, mode === 'clone' ? `Copied from ${base.name} (${base.source})` : `Variant of ${base.name} (${base.source})`);
    return c.json({ entity: homebrew.getEntity(user, entity.id), validation }, 201);
  });

  // region Import

  app.post('/import', async (c) => {
    const body = await c.req.parseBody({ all: true });
    const edition = parseEdition(body['defaultEdition']);
    const raw = body['files'];
    const list = (Array.isArray(raw) ? raw : raw ? [raw] : []).filter((f): f is File => f instanceof File);
    if (!list.length) throw badRequest('Choose one or more .json files');
    if (list.length > MAX_IMPORT_FILES) throw badRequest(`Import at most ${MAX_IMPORT_FILES} files at once`);
    let total = 0;
    const files: BrewFile[] = [];
    for (const f of list) {
      if (f.size > MAX_IMPORT_FILE_BYTES) throw badRequest(`${f.name} is larger than ${MAX_IMPORT_FILE_BYTES / 1024 / 1024} MB`);
      total += f.size;
      if (total > MAX_IMPORT_TOTAL_BYTES) throw badRequest(`The files are larger than ${MAX_IMPORT_TOTAL_BYTES / 1024 / 1024} MB together`);
      files.push({ name: f.name, text: await f.text() });
    }
    return c.json(transfer.importFiles(uid(c), files, edition));
  });

  app.post('/import-url', validate('json', importHomebrewUrlInput), async (c) => {
    const { url, defaultEdition } = c.req.valid('json');
    let text: string;
    try {
      text = await fetchUrlText(url);
    } catch (e) {
      throw badRequest(e instanceof UrlFetchError ? e.message : 'Download failed');
    }
    const name = decodeURIComponent(new URL(url).pathname.split('/').pop() || url).slice(0, 200);
    return c.json(transfer.importFiles(uid(c), [{ name, text }], defaultEdition));
  });

  // endregion

  return app;
}

function parseEdition(v: unknown): HomebrewEdition {
  return typeof v === 'string' && (HOMEBREW_EDITIONS as readonly string[]).includes(v) ? (v as HomebrewEdition) : '2014';
}
