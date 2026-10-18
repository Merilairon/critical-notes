/**
 * Admin backup endpoints (Task M3.4, docs/design/backup.md 10, 11, 13, 14). Mounted under `/api/admin/backups`, so
 * `requireAdmin` applies (no API token, admins only) and the MCP allowlist never matches. No delete route (retention is
 * automatic) and no restore route (restore is the host's CLI). Error bodies are fixed sentences: never raw error text
 * and never a path.
 */
import { Hono, type Context } from 'hono';
import {
  backupTicketInput,
  BACKUP_NAME_PATTERN,
  type BackupDto,
  type BackupListDto,
  type BackupStartedDto,
  type BackupTicketDto,
} from '@cn/shared';
import type { AppEnv } from '../auth/session';
import { DownloadTickets, TICKET_TTL_MS } from '../lib/download-tickets';
import { audit } from '../lib/audit';
import { forbidden, HttpError, notFound, validate } from '../lib/http';
import { createClientKey, RateLimiter } from '../lib/rate-limit';
import { BackupError, type BackupFailureCode, type BackupInfo, type BackupService } from '../services/backups';
import type { UserAdminService } from '../services/users';

/** Fixed sentences for the last failed backup, keyed by the service's stable code. */
export const FAILURE_TEXT: Record<BackupFailureCode, string> = {
  disk: 'The last backup failed: not enough free disk space. Lower BACKUP_KEEP, free space or point BACKUP_DIR at a larger disk.',
  'no-space': 'The last backup failed: the disk filled up while writing it. Nothing was kept.',
  verify: 'The last backup failed its own verification pass. Nothing was kept; check the server log.',
  'too-many-files': 'The last backup failed: the uploads folder holds more files than a backup can hold.',
  'db-timeout': 'The last backup failed: the database was too busy to copy in time. Try again when the instance is quiet.',
  failed: 'The last backup failed. Nothing was kept; check the server log.',
};

const BUSY = 'A backup is already running';
const RESTORING = 'A restore is running or was interrupted; backups are refused until it is finished';
const NO_SPACE = 'Not enough free disk space for a backup. Lower BACKUP_KEEP, free space or point BACKUP_DIR at a larger disk';
/** How long the POST waits for an early refusal (another process holds the lock, the disk check fails) before answering 202. */
const EARLY_REFUSAL_WINDOW_MS = 300;
export const MAX_CONCURRENT_DOWNLOADS = 3;
/**
 * Tuning of the download stream. `idleMs`: a download whose reader drains nothing for this long is destroyed, which frees
 * its slot and its lease (so sockets that never read cannot pin the slots or block prune). There is no total cap: a client
 * that keeps reading may take as long as it needs for a multi-gigabyte file. Mutable only for tests.
 */
export const downloadLimits = { idleMs: 60_000 };

/** The one mapping from a service refusal to an HTTP error. Unknown errors become a generic 500 elsewhere. */
function refusal(e: unknown): HttpError | null {
  if (!(e instanceof BackupError)) return null;
  switch (e.code) {
    case 'busy':
      return new HttpError(409, BUSY);
    case 'restore-in-progress':
      return new HttpError(409, RESTORING);
    case 'api-cap':
      return new HttpError(409, e.message); // documented text; contains a count and the CLI command only
    case 'disk':
      return new HttpError(507, NO_SPACE);
    default:
      return null;
  }
}

function toDto(b: BackupInfo): BackupDto {
  return {
    name: b.name,
    size: b.size,
    createdAt: b.createdAt,
    trigger: b.trigger,
    appVersion: b.detail?.appVersion ?? null,
    migrationLevel: b.detail?.migrationLevel ?? null,
    counts: b.detail?.counts ?? null,
    missingUploads: b.detail?.missingUploads ?? null,
  };
}

export function backupRoutes(backups: BackupService, users: UserAdminService, opts: { tickets?: DownloadTickets; trustProxy?: boolean; schedule?: () => BackupListDto['schedule'] } = {}) {
  const app = new Hono<AppEnv>();
  const tickets = opts.tickets ?? new DownloadTickets();
  /** Ticket requests per admin: 5 a minute, every attempt counted BEFORE the password check is awaited (design 10, 13). */
  const ticketLimit = new RateLimiter(5, 60_000);
  /** Backups started from the page: 3 per admin per 10 minutes (design 14, B10). */
  const createLimit = new RateLimiter(3, 10 * 60_000);
  let downloading = 0;
  const clientKey = createClientKey(opts.trustProxy === true);
  const actor = (c: Context<AppEnv>) => c.get('user')!.id;

  app.get('/', async (c) => {
    const s = backups.status();
    const body: BackupListDto = {
      backups: (await backups.list()).map(toDto),
      running: s.running ? { name: s.running.name || null, startedAt: s.running.startedAt } : null,
      lastError: s.lastErrorCode ? FAILURE_TEXT[s.lastErrorCode] : null,
      lastWarnings: s.lastWarnings,
      schedule: opts.schedule?.() ?? null,
    };
    c.header('Cache-Control', 'no-store');
    return c.json(body);
  });

  // The trigger is always 'api' here and no request field, header or query parameter is read.
  app.post('/', async (c) => {
    const id = actor(c);
    createLimit.hit(id);
    c.header('Cache-Control', 'no-store');
    try {
      await backups.assertApiCreateAllowed();
    } catch (e) {
      throw refusal(e) ?? e;
    }
    // No await between this check and the call below: `create` takes the in-process mutex synchronously.
    if (backups.isRunning()) throw new HttpError(409, BUSY);
    const run = backups.create({ actor: id, trigger: 'api', ip: clientKey(c) });
    let timer: NodeJS.Timeout | undefined;
    const early = await Promise.race([
      run.then(
        () => 'done' as const,
        (e: unknown) => e,
      ),
      new Promise<'running'>((resolve) => {
        timer = setTimeout(() => resolve('running'), EARLY_REFUSAL_WINDOW_MS);
      }),
    ]);
    clearTimeout(timer);
    if (early !== 'running' && early !== 'done') {
      const r = refusal(early);
      if (r) throw r;
      // Any other failure is recorded by the service (fixed text in `lastError` on the list); the page sees it by polling.
    }
    const body: BackupStartedDto = { name: backups.status().running?.name || null, status: early === 'running' ? 'running' : 'done' };
    return c.json(body, 202);
  });

  app.post('/:name/ticket', validate('json', backupTicketInput), async (c) => {
    const name = c.req.param('name');
    if (!BACKUP_NAME_PATTERN.test(name)) throw notFound();
    const id = actor(c);
    const ip = clientKey(c);
    const deny = (reason: string) => audit('backup.ticket_denied', { actor: id, name, reason, ip });
    try {
      ticketLimit.hit(id); // before the await
    } catch (e) {
      deny('rate_limited');
      throw e;
    }
    if (!(await users.verifyActorPassword(id, c.req.valid('json').currentPassword))) {
      deny('wrong_password');
      throw forbidden('Your password is wrong');
    }
    const sessionId = c.get('sessionId');
    if (!sessionId) throw forbidden('Sign in with the browser to download a backup');
    const body: BackupTicketDto = { ticket: tickets.issue(id, sessionId, name), expiresInSec: TICKET_TTL_MS / 1000 };
    audit('backup.ticket_issued', { actor: id, name, ip });
    c.header('Cache-Control', 'no-store');
    return c.json(body, 200);
  });

  app.get('/:name', async (c) => {
    const name = c.req.param('name');
    // Before ANY file system call; anything else is the same 404 as an unknown file
    if (!BACKUP_NAME_PATTERN.test(name)) throw notFound();
    // HEAD (which hono routes here) sends no bytes: it must neither redeem a ticket nor count as a download
    if (c.req.method === 'HEAD') return c.body(null, 405, { Allow: 'GET' });
    const id = actor(c);
    const ip = clientKey(c);
    const ticket = c.req.query('ticket');
    const sessionId = c.get('sessionId');
    // The slot is checked BEFORE the ticket is redeemed, so a 429 does not burn a valid ticket (it only tells an
    // already-authenticated admin that downloads are busy)
    if (downloading >= MAX_CONCURRENT_DOWNLOADS) throw new HttpError(429, 'Too many downloads in progress, wait a few seconds and request a new ticket if this one is refused', undefined, 5);
    if (typeof ticket !== 'string' || ticket.length > 100 || !sessionId || !tickets.redeem(ticket, id, sessionId, name)) {
      audit('backup.ticket_denied', { actor: id, name, reason: 'invalid_ticket', ip });
      throw notFound();
    }
    downloading++;
    let ended = false;
    let lease: Awaited<ReturnType<BackupService['openForDownload']>> | undefined;
    let idle: NodeJS.Timeout | undefined;
    const end = () => {
      if (ended) return;
      ended = true;
      clearTimeout(idle);
      downloading--;
      void lease?.release();
    };
    try {
      lease = await backups.openForDownload(name, id, { ip });
      const headers = {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${name}"`,
        'Content-Length': String(lease.size),
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
        'Accept-Ranges': 'none', // a Range header is never read: always the whole file
      };
      const node = lease.handle.createReadStream({ highWaterMark: 64 * 1024, autoClose: true });
      node.once('close', end);
      // Idle watchdog: restarted whenever the reader asks for more data (pull); fires when nobody reads for `idleMs`.
      // (A 'data' listener would put the stream in flowing mode and defeat back-pressure, so the web stream pulls instead.)
      const arm = () => {
        clearTimeout(idle);
        idle = setTimeout(() => node.destroy(), downloadLimits.idleMs);
        idle.unref();
      };
      arm();
      const chunks = node[Symbol.asyncIterator]();
      const body = new ReadableStream<Uint8Array>(
        {
          async pull(controller) {
            arm();
            try {
              const r = await chunks.next();
              if (r.done) {
                end();
                controller.close();
              } else controller.enqueue(new Uint8Array((r.value as Buffer).buffer, (r.value as Buffer).byteOffset, (r.value as Buffer).length));
            } catch {
              end();
              controller.error(new Error('Download interrupted'));
            }
          },
          cancel() {
            node.destroy();
            end();
          },
        },
        { highWaterMark: 0 },
      );
      return new Response(body, { status: 200, headers });
    } catch (e) {
      end(); // a synchronous throw must not leak the slot or the lease
      if (e instanceof BackupError && e.code === 'not-found') throw notFound();
      throw e;
    }
  });

  return app;
}
