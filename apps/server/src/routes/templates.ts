/** Template library: built-in, personal and campaign templates; versions, usage, duplicate, import/export. */
import { Hono } from 'hono';
import { z } from 'zod';
import { createTemplateInput, duplicateTemplateInput, TEMPLATE_KINDS, updateTemplateInput, type TemplateKindDto } from '@cn/shared';
import type { AppEnv } from '../auth/session';
import { validate } from '../lib/http';
import type { TemplateService } from '../services/templates';

const importInput = z.object({
  scope: z.enum(['user', 'campaign']).default('user'),
  campaignId: z.string().max(64).nullable().default(null),
  document: z.unknown(),
});

export function templateRoutes(templates: TemplateService) {
  const app = new Hono<AppEnv>();
  const uid = (c: { get(key: 'user'): AppEnv['Variables']['user'] }) => c.get('user')!.id;

  app.get('/', (c) => {
    const kind = c.req.query('kind');
    return c.json({
      templates: templates.list(uid(c), {
        campaignId: c.req.query('campaignId') || null,
        kind: (TEMPLATE_KINDS as readonly string[]).includes(kind ?? '') ? (kind as TemplateKindDto) : undefined,
      }),
    });
  });

  app.post('/', validate('json', createTemplateInput), (c) => c.json(templates.create(uid(c), c.req.valid('json')), 201));

  /** Export one or more templates (`?ids=a,b`) as a file. */
  app.get('/export', (c) => {
    const ids = (c.req.query('ids') ?? '').split(',').filter(Boolean).slice(0, 500);
    const doc = templates.exportTemplates(uid(c), ids);
    c.header('content-disposition', `attachment; filename="${ids.length === 1 ? 'template' : 'templates'}.json"`);
    return c.json(doc);
  });

  app.post('/import', validate('json', importInput), (c) => {
    const { scope, campaignId, document } = c.req.valid('json');
    return c.json(templates.importTemplates(uid(c), document, { scope, campaignId }));
  });

  app.get('/:id', (c) => c.json(templates.get(uid(c), c.req.param('id'))));

  app.put('/:id', validate('json', updateTemplateInput), (c) => c.json(templates.update(uid(c), c.req.param('id'), c.req.valid('json'))));

  app.delete('/:id', (c) => {
    templates.remove(uid(c), c.req.param('id'));
    return c.body(null, 204);
  });

  app.post('/:id/duplicate', validate('json', duplicateTemplateInput), (c) => c.json(templates.duplicate(uid(c), c.req.param('id'), c.req.valid('json')), 201));

  app.get('/:id/usage', (c) => c.json({ usage: templates.usage(uid(c), c.req.param('id')) }));

  return app;
}
