/**
 * HTTP application. Built from explicit dependencies so tests can create isolated instances.
 */
import { Hono } from 'hono';
import { compress } from 'hono/compress';
import { secureHeaders } from 'hono/secure-headers';
import { requireAdmin, requireUser, originCheck, sessionMiddleware, type AppEnv } from './auth/session';
import type { AppConfig } from './config';
import type { AppDb } from './db';
import { HttpError } from './lib/http';
import { HomebrewIndex } from './reference/homebrew-index';
import type { IndexDb } from './reference/index-db';
import { ReferenceService } from './reference/service';
import { authRoutes } from './routes/auth';
import { campaignRoutes } from './routes/campaigns';
import { imageRoutes } from './routes/images';
import { policyFromQuery, referenceRoutes } from './routes/reference';
import { CampaignService } from './services/campaigns';
import { HomebrewService } from './services/homebrew';
import { PageIndexer } from './services/page-index';
import { PageService } from './services/pages';
import { PropertyService } from './services/properties';
import { UploadService } from './services/uploads';
import { PageSearchIndex } from './reference/page-search';
import { uploadRoutes } from './routes/uploads';
import { homebrewRoutes } from './routes/homebrew';
import { HomebrewTransfer } from './homebrew/transfer';
import { templateRoutes } from './routes/templates';
import { playRoutes } from './routes/play';
import { inviteRoutes } from './routes/invites';
import { EncounterService } from './services/encounters';
import { InventoryService } from './services/inventory';
import { TrackerService } from './services/trackers';
import { VisibilityService } from './services/visibility';
import { CampaignTransfer } from './services/campaign-transfer';
import { EditionMigration } from './services/migration';
import { TemplateService } from './services/templates';
import { ApiTokenService } from './services/api-tokens';
import { tokenRoutes } from './routes/tokens';
import { adminRoutes } from './routes/admin';
import { backupRoutes } from './routes/backups';
import { BackupScheduler } from './services/backup-scheduler';
import { BackupService } from './services/backups';
import { UserAdminService } from './services/users';
import { mcpRoutes } from './mcp/route';

/** `/api/admin/backups/<name>` (the zip download), whatever the name. */
const isBackupDownload = (path: string) => /^\/api\/admin\/backups\/[^/]+$/.test(path);

export interface AppDeps {
  config: AppConfig;
  indexDb: IndexDb;
  db: AppDb;
}

export function createServices({ indexDb, db, config }: AppDeps) {
  const reference = new ReferenceService(indexDb);
  const homebrewIndex = new HomebrewIndex(indexDb);
  const reload = () => reference.reloadSources();
  const campaigns = new CampaignService(db, homebrewIndex, reload);
  const properties = new PropertyService(db);
  const pageSearch = new PageSearchIndex(indexDb);
  const pages = new PageService(db, properties, new PageIndexer(db, pageSearch));
  const homebrew = new HomebrewService(db, homebrewIndex, indexDb, reload);
  const uploads = new UploadService(db, config.uploadsDir);
  const homebrewTransfer = new HomebrewTransfer(db, homebrew);
  const templates = new TemplateService(db, pages, properties, campaigns, reference);
  const encounters = new EncounterService(db, pages, reference);
  const trackers = new TrackerService(db, encounters, pages);
  const inventory = new InventoryService(db, reference);
  const visibility = new VisibilityService(db);
  const transfer = new CampaignTransfer(db, indexDb, { campaigns, pages, properties, templates, homebrew, homebrewTransfer, uploads });
  const migration = new EditionMigration(db, indexDb, { campaigns, pages, properties });
  const apiTokens = new ApiTokenService(db);
  const userAdmin = new UserAdminService(db);
  // Constructed once: validates BACKUP_DIR (throws on an invalid one, so the server refuses to start) and clears old leftovers
  const backups = new BackupService({ db, config });
  // Built here, started by main.ts (off unless BACKUP_EVERY_HOURS is set)
  const backupScheduler = new BackupScheduler({ service: backups, config });
  return { backups, backupScheduler, userAdmin, apiTokens, visibility, transfer, migration, reference, homebrewIndex, campaigns, pages, homebrew, homebrewTransfer, properties, pageSearch, uploads, templates, encounters, trackers, inventory };
}

export type Services = ReturnType<typeof createServices>;

export function createApp(deps: AppDeps, services: Services = createServices(deps)) {
  const { config, db } = deps;
  const { reference, campaigns, homebrew } = services;
  const app = new Hono<AppEnv>();

  const headerOptions = (referrerPolicy: 'same-origin' | 'no-referrer') =>
    secureHeaders({
      contentSecurityPolicy: {
        defaultSrc: ["'self'"],
        imgSrc: ["'self'", 'data:', 'https:'],
        styleSrc: ["'self'", "'unsafe-inline'"],
        scriptSrc: ["'self'"],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
      },
      crossOriginResourcePolicy: 'same-origin',
      referrerPolicy,
    });
  const standardHeaders = headerOptions('same-origin');
  const downloadHeaders = headerOptions('no-referrer');
  // A backup download says Referrer-Policy: no-referrer (secureHeaders would overwrite a header set by the route)
  app.use('*', (c, next) => (isBackupDownload(c.req.path) ? downloadHeaders(c, next) : standardHeaders(c, next)));
  // Event streams must not be compressed: gzip buffers, so updates would arrive late
  const compressed = compress();
  // ... and neither must backup zips: deflating a zip wastes CPU, and a multi-gigabyte body must stay a plain stream
  app.use('/api/*', (c, next) => (c.req.path.endsWith('/events') || isBackupDownload(c.req.path) ? next() : compressed(c, next)));
  app.use('*', sessionMiddleware(db, config.secureCookies));
  app.use('/api/*', originCheck([config.publicUrl]));

  app.get('/api/health', (c) => c.json({ ok: true }));
  app.route('/api/auth/tokens', tokenRoutes(services.apiTokens));
  app.route('/api/auth', authRoutes(db, { secureCookies: config.secureCookies, trustProxy: config.trustProxy, invites: campaigns }));
  app.route('/api/invites', inviteRoutes(campaigns));
  app.use('/api/admin/*', requireAdmin);
  app.route('/api/admin/backups', backupRoutes(services.backups, services.userAdmin, { trustProxy: config.trustProxy, schedule: () => services.backupScheduler.info() }));
  app.route('/api/admin/users', adminRoutes(services.userAdmin, { publicUrl: config.publicUrl, trustProxy: config.trustProxy }));

  // Everything below requires a signed-in user
  app.use('/api/reference/*', requireUser);
  app.use('/img/*', requireUser);
  app.route(
    '/api/reference',
    referenceRoutes(reference, (c) => {
      const campaignId = c.req.query('campaignId');
      const user = c.get('user')!.id;
      // Outside a campaign: the preview rules plus the homebrew this user can see
      return campaignId ? campaigns.policy(campaignId, user) : policyFromQuery(c.req.query(), homebrew.viewableJsonIds(user));
    }),
  );
  app.use('/api/templates/*', requireUser);
  app.route('/api/templates', templateRoutes(services.templates));
  app.use('/api/homebrew/*', requireUser);
  app.route('/api/homebrew', homebrewRoutes(services, services.homebrewTransfer));
  app.route('/api/campaigns', campaignRoutes(services));
  app.route('/api/campaigns', playRoutes(services));
  app.use('/api/uploads/*', requireUser);
  app.route('/api/uploads', uploadRoutes(services));
  app.route('/img', imageRoutes(config.fivetoolsImgPath));
  // AI assistants (MCP): tools that call the routes above in-process, as the token's user
  app.route('/mcp', mcpRoutes({ app, tokens: services.apiTokens, publicUrl: config.publicUrl }));

  app.notFound((c) => (c.req.path.startsWith('/api/') ? c.json({ error: 'Not found' }, 404) : c.text('Not found', 404)));
  app.onError((err, c) => {
    if (err instanceof HttpError) {
      if (err.retryAfterSec) c.header('Retry-After', String(err.retryAfterSec));
      return c.json({ error: err.message, ...(err.details ? { details: err.details } : {}) }, err.status);
    }
    if ('status' in err && typeof err.status === 'number' && err.status < 500) return c.json({ error: err.message }, err.status as 400);
    console.error(err);
    return c.json({ error: 'Internal error' }, 500);
  });

  return { app, services };
}
