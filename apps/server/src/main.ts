/**
 * Server entry point: ensure the reference index is current, sync homebrew into it, then serve the API
 * (and, in production, the built web app).
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { loadEditionListsFromPackage } from '@cn/fivetools/node';
import { purgeExpiredSessions } from './auth/session';
import { createApp, createServices } from './app';
import { ensureDataDirs, loadConfig } from './config';
import { openAppDb } from './db';
import { openIndexDb } from './reference/index-db';
import { runIndexer } from './reference/indexer';

const config = loadConfig();
ensureDataDirs(config);
const indexDb = openIndexDb(config.indexDbPath);
const db = openAppDb(config.appDbPath);
purgeExpiredSessions(db);

if (existsSync(join(config.fivetoolsSrcPath, 'data'))) {
  const report = await runIndexer({ srcPath: config.fivetoolsSrcPath, db: indexDb, editionLists: loadEditionListsFromPackage() });
  console.log(`Reference index ${report.status} (${report.durationMs} ms)`);
} else {
  console.warn(`5etools data not found at ${config.fivetoolsSrcPath}; the reference browser will be empty.`);
}

const services = createServices({ indexDb, db, config });
const sync = services.homebrew.syncIndex();
console.log(`Homebrew indexed: ${sync.indexed} entities${sync.warnings.length ? ` (${sync.warnings.length} warnings)` : ''}`);
const builtins = services.templates.upsertBuiltins();
if (builtins.created || builtins.updated) console.log(`Built-in templates: ${builtins.created} added, ${builtins.updated} updated`);
if (services.pageSearch.count() === 0) {
  const n = services.pages.reindexAll();
  if (n) console.log(`Page index rebuilt for ${n} pages`);
}

const { app } = createApp({ config, indexDb, db }, services);

if (config.isProduction && existsSync(config.webDistDir)) {
  app.use('/*', serveStatic({ root: config.webDistDir }));
  app.get('*', async (c, next) => (c.req.path.startsWith('/api/') ? next() : serveStatic({ path: join(config.webDistDir, 'index.html') })(c, next)));
}

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`Critical Notes server listening on http://localhost:${info.port}`);
});
