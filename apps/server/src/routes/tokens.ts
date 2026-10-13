/** The signed-in user's API tokens (for AI assistants). Only with a browser session: tokens never manage tokens. */
import { Hono } from 'hono';
import { createApiTokenInput } from '@cn/shared';
import { requireUser, type AppEnv } from '../auth/session';
import { forbidden, validate } from '../lib/http';
import type { ApiTokenService } from '../services/api-tokens';

export function tokenRoutes(tokens: ApiTokenService) {
  const app = new Hono<AppEnv>();
  app.use('*', requireUser);
  app.use('*', async (c, next) => {
    if (c.get('tokenScope')) throw forbidden('API tokens cannot manage tokens');
    await next();
  });
  const uid = (c: { get(key: 'user'): AppEnv['Variables']['user'] }) => c.get('user')!.id;
  app.get('/', (c) => c.json({ tokens: tokens.list(uid(c)) }));
  app.post('/', validate('json', createApiTokenInput), (c) => c.json(tokens.create(uid(c), c.req.valid('json')), 201));
  app.delete('/:id', (c) => {
    tokens.revoke(uid(c), c.req.param('id'));
    return c.body(null, 204);
  });
  return app;
}
