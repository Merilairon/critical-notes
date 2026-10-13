/**
 * Full-text search over campaign pages, stored in the (rebuildable) index database. Player text excludes
 * DM-only and secret blocks, so player searches can never match hidden content.
 */
import { toFtsQuery } from './service';
import type { IndexDb } from './index-db';

export interface PageSearchRecord {
  pageId: string;
  campaignId: string;
  type: string;
  icon: string | null;
  visibility: string;
  title: string;
  textDm: string;
  textPlayer: string;
}

export interface PageSearchHit {
  pageId: string;
  type: string;
  icon: string | null;
  title: string;
  snippet: string | null;
  visibility: string;
}

export class PageSearchIndex {
  constructor(private readonly db: IndexDb) {}

  upsert(r: PageSearchRecord) {
    this.db.transaction(() => {
      const existing = this.db.prepare('SELECT id FROM page_search WHERE page_id = ?').get(r.pageId) as { id: number } | undefined;
      let id: number;
      if (existing) {
        id = existing.id;
        this.db.prepare('UPDATE page_search SET campaign_id=?, type=?, icon=?, visibility=?, title=? WHERE id=?').run(r.campaignId, r.type, r.icon, r.visibility, r.title, id);
        this.db.prepare('DELETE FROM page_fts WHERE rowid = ?').run(id);
      } else {
        id = Number(
          this.db.prepare('INSERT INTO page_search (page_id, campaign_id, type, icon, visibility, title) VALUES (?, ?, ?, ?, ?, ?)').run(r.pageId, r.campaignId, r.type, r.icon, r.visibility, r.title)
            .lastInsertRowid,
        );
      }
      this.db.prepare('INSERT INTO page_fts (rowid, title, text_dm, text_player) VALUES (?, ?, ?, ?)').run(id, r.title, r.textDm, r.textPlayer);
    })();
  }

  remove(pageIds: string[]) {
    const del = this.db.prepare('DELETE FROM page_search WHERE page_id = ? RETURNING id');
    const delFts = this.db.prepare('DELETE FROM page_fts WHERE rowid = ?');
    this.db.transaction(() => {
      for (const id of pageIds) {
        const row = del.get(id) as { id: number } | undefined;
        if (row) delFts.run(row.id);
      }
    })();
  }

  count(campaignId?: string): number {
    const row = campaignId
      ? (this.db.prepare('SELECT count(*) AS n FROM page_search WHERE campaign_id = ?').get(campaignId) as { n: number })
      : (this.db.prepare('SELECT count(*) AS n FROM page_search').get() as { n: number });
    return row.n;
  }

  /**
   * Searches a campaign's pages. DMs search title + DM text; players search title + player text and only
   * pages in `visiblePageIds`.
   */
  search(campaignId: string, query: string, opts: { mode: 'dm' | 'player'; visiblePageIds?: ReadonlySet<string>; limit?: number }): PageSearchHit[] {
    const fts = toFtsQuery(query);
    if (!fts) return [];
    const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
    const column = opts.mode === 'dm' ? 'text_dm' : 'text_player';
    const match = `{title ${column}} : (${fts})`;
    const rows = this.db
      .prepare(
        `SELECT s.page_id, s.type, s.icon, s.title, s.visibility,
                snippet(page_fts, ${opts.mode === 'dm' ? 1 : 2}, '', '', '…', 12) AS snippet
         FROM page_fts f JOIN page_search s ON s.id = f.rowid
         WHERE page_fts MATCH ? AND s.campaign_id = ?
         ORDER BY (lower(s.title) = ?) DESC, (lower(s.title) LIKE ?) DESC, bm25(page_fts, 10.0, 1.0, 1.0)
         LIMIT ?`,
      )
      .all(match, campaignId, query.trim().toLowerCase(), `${query.trim().toLowerCase()}%`, limit * (opts.visiblePageIds ? 4 : 1)) as {
      page_id: string;
      type: string;
      icon: string | null;
      title: string;
      visibility: string;
      snippet: string | null;
    }[];
    return rows
      .filter((r) => !opts.visiblePageIds || opts.visiblePageIds.has(r.page_id))
      .slice(0, limit)
      .map((r) => ({ pageId: r.page_id, type: r.type, icon: r.icon, title: r.title, snippet: r.snippet, visibility: r.visibility }));
  }
}
