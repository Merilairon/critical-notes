/**
 * Reference API (5etools-powered). The policy comes from `?campaignId=` (campaign settings, membership
 * required) or, outside a campaign, from preview params (`ruleset`, `cross`, `sources=SRC:0,SRC2:1`).
 */
import { isKind, makePolicy, RULESET_IDS, type CampaignPolicy, type EntityKind, type RulesetId } from '@cn/fivetools';
import { Hono, type Context } from 'hono';
import type { AppEnv } from '../auth/session';
import type { ReferenceService } from '../reference/service';

export type PolicyResolver = (c: Context<AppEnv>) => CampaignPolicy | Promise<CampaignPolicy>;

export function policyFromQuery(query: Record<string, string | undefined>, homebrewSources: string[] = []): CampaignPolicy {
  const ruleset = (RULESET_IDS as readonly string[]).includes(query.ruleset ?? '') ? (query.ruleset as RulesetId) : RULESET_IDS[1]!;
  const overrides: [string, boolean][] = (query.sources ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((pair) => {
      const [id = '', flag] = pair.split(':');
      return [id, flag !== '0'];
    });
  return makePolicy(ruleset, { crossEdition: query.cross === '1' || query.cross === 'true', sourceOverrides: overrides, homebrewSources });
}

export function referenceRoutes(service: ReferenceService, resolvePolicy: PolicyResolver = (c) => policyFromQuery(c.req.query())) {
  const app = new Hono<AppEnv>();

  app.get('/sources', async (c) => c.json({ sources: service.listSources(await resolvePolicy(c)) }));

  app.get('/kinds', async (c) => c.json({ kinds: service.kindCounts(await resolvePolicy(c)) }));

  app.get('/search', async (c) => {
    const q = c.req.query('q') ?? '';
    const kinds = (c.req.query('kinds') ?? '').split(',').filter((k): k is EntityKind => isKind(k));
    const limit = Number(c.req.query('limit') ?? 20);
    return c.json({ hits: service.search(q, await resolvePolicy(c), { kinds, limit }) });
  });

  app.get('/autocomplete/:kind', async (c) => {
    const kind = c.req.param('kind');
    if (!isKind(kind)) return c.json({ error: 'Unknown kind' }, 400);
    return c.json({ hits: service.autocomplete(kind, c.req.query('q') ?? '', await resolvePolicy(c)) });
  });

  app.get('/entities/:uid', async (c) => {
    const entity = service.get(c.req.param('uid'), await resolvePolicy(c));
    if (!entity) return c.json({ error: 'Not found' }, 404);
    return c.json(entity);
  });

  app.get('/kinds/:kind', async (c) => {
    const kind = c.req.param('kind');
    if (!isKind(kind)) return c.json({ error: 'Unknown kind' }, 400);
    return c.json({ items: service.list(kind, await resolvePolicy(c)) });
  });

  return app;
}
