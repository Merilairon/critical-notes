/** User administration (Task M2.4). Browser sessions of admins only: never reachable with an API token. */
import { Hono, type Context } from 'hono';
import { adminUpdateUserInput, deleteUserInput, resetLinkInput } from '@cn/shared';
import { requireAdmin, type AppEnv } from '../auth/session';
import { forbidden, validate } from '../lib/http';
import { createClientKey, RateLimiter } from '../lib/rate-limit';
import type { UserAdminService } from '../services/users';

export function adminRoutes(users: UserAdminService, opts: { publicUrl: string; trustProxy?: boolean }) {
  const app = new Hono<AppEnv>();
  app.use('*', requireAdmin);
  /** Wrong passwords for the step-up check, per admin: 5 a minute. */
  const stepUp = new RateLimiter(5, 60_000);
  const clientKey = createClientKey(opts.trustProxy === true);
  const actor = (c: Context<AppEnv>) => c.get('user')!.id;

  async function confirm(c: Context<AppEnv>, password: string) {
    const id = actor(c);
    // Count the attempt BEFORE the await: concurrent guesses must not all pass the budget check before any
    // failure is recorded. A correct password gives back only its own attempt (not other failures, e.g. a thief's).
    stepUp.hit(id);
    if (!(await users.verifyActorPassword(id, password))) throw forbidden('Your password is wrong');
    stepUp.give(id);
  }

  app.get('/', (c) => c.json({ users: users.list() }));

  app.get('/:id/owned-campaigns', (c) => c.json({ campaigns: users.ownedCampaigns(c.req.param('id')) }));

  app.post('/:id/reset-link', validate('json', resetLinkInput), async (c) => {
    const { currentPassword, revokeTokens } = c.req.valid('json');
    await confirm(c, currentPassword);
    const link = users.createResetLink(actor(c), c.req.param('id'), opts.publicUrl, revokeTokens === true, clientKey(c));
    c.header('Cache-Control', 'no-store');
    return c.json(link, 201);
  });

  app.patch('/:id', validate('json', adminUpdateUserInput), async (c) => {
    const { currentPassword, ...change } = c.req.valid('json');
    // Enabling a non-admin restores nothing, so it needs no step-up; everything else does. Enabling an ADMIN
    // is refused by the service (400) unless a password was supplied (and verified here).
    if (currentPassword !== undefined) await confirm(c, currentPassword);
    return c.json({ user: users.update(actor(c), c.req.param('id'), { ...change, confirmed: currentPassword !== undefined }, clientKey(c)) });
  });

  /** POST rather than DELETE-with-body: clients and proxies handle DELETE bodies badly. */
  app.post('/:id/delete', validate('json', deleteUserInput), async (c) => {
    const { currentPassword, campaigns } = c.req.valid('json');
    await confirm(c, currentPassword);
    users.remove(actor(c), c.req.param('id'), campaigns, clientKey(c));
    return c.body(null, 204);
  });

  return app;
}
