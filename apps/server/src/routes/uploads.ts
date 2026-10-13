import { Hono } from 'hono';
import type { AppEnv } from '../auth/session';
import { notFound } from '../lib/http';
import type { CampaignService } from '../services/campaigns';
import type { UploadService } from '../services/uploads';

/** Serves uploaded images (or their thumbnails) to members of the owning campaign. Ids are unguessable (UUIDv7 + random). */
export function uploadRoutes({ uploads, campaigns }: { uploads: UploadService; campaigns: CampaignService }) {
  const app = new Hono<AppEnv>();
  app.get('/:id', async (c) => {
    const id = c.req.param('id');
    const row = uploads.get(id);
    try {
      campaigns.access(row.campaignId, c.get('user')!.id);
    } catch {
      throw notFound();
    }
    // `?size=thumb`: a preview of at most 400 px
    const thumb = c.req.query('size') === 'thumb' ? await uploads.readThumb(id) : null;
    const data = thumb ?? (await uploads.read(id));
    return c.body(data as Uint8Array<ArrayBuffer>, 200, {
      'Content-Type': thumb ? 'image/webp' : row.mime,
      'Cache-Control': 'private, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Content-Disposition': `inline; filename="${row.filename.replace(/"/g, '')}"`,
    });
  });
  return app;
}
