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
import { refuseWhileRestoring } from './lib/restore-marker';
import { createShutdown, installSignalHandlers } from './lib/shutdown';
import { openIndexDb } from './reference/index-db';
import { runIndexer } from './reference/indexer';
import { assertBackupDirWritable, BackupError, validateBackupDir } from './services/backups';
import { purgeOldResets } from './services/users';

const config = loadConfig();
if (config.backupEveryHoursError) {
  console.error(`Refusing to start: ${config.backupEveryHoursError}`);
  process.exit(1);
}
// A restore is running or was interrupted: touch NOTHING in the data directory (docs/design/backup.md 7.1). Checked again after
// the database is open, which closes the window of a server that passed the first check just before the marker appeared.
refuseWhileRestoring(config.dataDir);
// An invalid BACKUP_DIR (inside the web build, uploads, 5etools or the data root; world-writable) stops the server now,
// before the slow indexer (docs/design/backup.md 11). `createServices` builds the BackupService, which validates again.
// The same call proves this user can write there (creating the folder with mode 0700 when missing): a folder owned by root
// would otherwise fail the first scheduled backup, about 90 s after start. Refuses at once and names the fix.
try {
  assertBackupDirWritable(validateBackupDir(config).dir);
} catch (e) {
  if (!(e instanceof BackupError)) throw e;
  console.error(`Refusing to start: ${e.message}`);
  process.exit(1);
}
// From here until the server listens (the indexer can take minutes) a stop signal exits at once (143 / 130, like the default);
// `shutdown.arm` below turns it into the clean shutdown. Handlers are installed whether or not scheduled backups are on.
const shutdown = createShutdown();
installSignalHandlers(shutdown);
ensureDataDirs(config);
const indexDb = openIndexDb(config.indexDbPath);
const db = openAppDb(config.appDbPath);
refuseWhileRestoring(config.dataDir, () => {
  db.$client.close();
  indexDb.close();
});
purgeExpiredSessions(db);
purgeOldResets(db);

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

const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`Critical Notes server listening on http://localhost:${info.port}`);
});

// Scheduled backups (off unless BACKUP_EVERY_HOURS is set). Started after the server listens, so indexing is long done.
const scheduler = services.backupScheduler;
if (scheduler.enabled) {
  scheduler.start();
  console.log(`Scheduled backups: every ${config.backupEveryHours} h, keeping ${config.backupKeep}`);
}

// Trash purge: pages deleted more than 30 days ago, shortly after start and daily; defers while a backup runs.
const trashPurger = services.trashPurger;
trashPurger.start();

// SIGTERM / SIGINT (docker stop, Ctrl+C): stop accepting requests, wait up to 8 s for a running backup (scheduled or from the
// web page), close both databases, exit 0. An interrupted backup publishes nothing; a second signal exits at once.
// SHUTDOWN_BACKUP_WAIT_MS shortens the 8 s wait (tests only; invalid or missing = 8000)
const waitMs = Number(process.env.SHUTDOWN_BACKUP_WAIT_MS);
shutdown.arm({
  backupWaitMs: Number.isInteger(waitMs) && waitMs > 0 && waitMs <= 8000 ? waitMs : undefined,
  server,
  closeStreams: () => services.eventStreams.closeStreams(),
  stopScheduler: () => Promise.all([scheduler.stop(), trashPurger.stop()]).then(() => undefined),
  backupRunning: () => services.backups.isRunning(),
  abortBackup: () => services.backups.abortInFlightSync(),
  closeDatabases: () => {
    db.$client.close();
    indexDb.close();
  },
});
