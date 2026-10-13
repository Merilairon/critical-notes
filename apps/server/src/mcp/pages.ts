/** Pages as the model sees them: titles for links and details, and what each page type's details are. */
import type { PageResolution } from '@cn/blocks/markdown';
import { FACET_FIELDS, FACET_SCHEMAS, facetTypeFor, PAGE_TYPE_LABELS, PAGE_TYPES, type PageSummaryDto, type PageType } from '@cn/shared';
import { path, type Api } from './api';
import { ToolError } from './tools';

/** The pages of a campaign the caller can see, for resolving `[[Title]]` links and page-link details. */
export class PageDirectory {
  private readonly byId: Map<string, PageSummaryDto>;
  private constructor(readonly pages: PageSummaryDto[]) {
    this.byId = new Map(pages.map((p) => [p.id, p]));
  }

  static async load(api: Api, campaignId: string): Promise<PageDirectory> {
    const { pages } = await api.get<{ pages: PageSummaryDto[] }>(path`/api/campaigns/${campaignId}/pages`);
    return new PageDirectory(pages);
  }

  get(id: string) {
    return this.byId.get(id);
  }

  private titled(title: string, type?: string) {
    const t = title.trim().toLowerCase();
    return this.pages.filter((p) => p.title.trim().toLowerCase() === t && (!type || p.type === type));
  }

  /** How a link to a page is written in Markdown: its title when that names one page. */
  readonly ref = (pageId: string, label: string): string => {
    const page = this.byId.get(pageId);
    return page && this.titled(page.title).length === 1 ? page.title : `page:${pageId}|${page?.title ?? label}`;
  };

  readonly title = (pageId: string) => this.byId.get(pageId)?.title ?? null;

  /** `[[Title]]` / `[[page:<id>|Label]]` → a page link. */
  readonly resolve = (ref: { id?: string; title?: string; label?: string }): PageResolution | null => {
    if (ref.id) {
      const page = this.byId.get(ref.id);
      return page ? { pageId: page.id, label: ref.label ?? page.title } : null;
    }
    const found = this.titled(ref.title ?? '');
    if (found.length > 1) return { error: `"${ref.title}" names ${found.length} pages (${found.map((p) => p.id).join(', ')}); write [[page:<id>|${ref.title}]]` };
    return found[0] ? { pageId: found[0].id, label: found[0].title } : null;
  };

  /** A page id from an id or an exact title (optionally of one page type). */
  idFor(value: string, type?: string, what = 'page'): string {
    if (this.byId.has(value)) return value;
    const found = this.titled(value, type);
    if (found.length === 1) return found[0]!.id;
    if (found.length > 1) throw new ToolError(`"${value}" names ${found.length} ${type ?? ''} pages: ${found.map((p) => `${p.id} (${p.title})`).join(', ')}. Give the id.`);
    throw new ToolError(`No ${type ? `${PAGE_TYPE_LABELS[type as PageType] ?? type} ` : ''}page "${value}" for ${what}`);
  }

  /** Details with page-link fields given as titles turned into ids. */
  resolveDetails(type: PageType, details: Record<string, unknown>): Record<string, unknown> {
    const facetType = facetTypeFor(type);
    if (!facetType) {
      if (Object.keys(details).length) throw new ToolError(`${PAGE_TYPE_LABELS[type]} pages have no details; use properties or the text`);
      return {};
    }
    const out = { ...details };
    for (const f of FACET_FIELDS[facetType]) {
      const v = out[f.key];
      if (f.type === 'pageLink' && typeof v === 'string' && v) out[f.key] = this.idFor(v, f.pageType, `"${f.key}"`);
    }
    return out;
  }
}

const SCHEMA_ONLY: Record<string, string> = {
  classes: 'list of {classUid: "class:fighter|phb", subclassUid: "subclass:…" or null, level: 1-20} (uids from search_rules)',
  abilities: '{str, dex, con, int, wis, cha}: scores 1-30',
  playerUserId: 'userId of the member who plays this character (get_campaign lists members); DM only',
};

/** Each page type and its details fields, described for the model. */
export function pageTypeGuide(): Record<string, { label: string; details: Record<string, string> }> {
  const guide: Record<string, { label: string; details: Record<string, string> }> = {};
  for (const type of PAGE_TYPES) {
    const facetType = facetTypeFor(type);
    const details: Record<string, string> = {};
    if (facetType) {
      const fields = new Map(FACET_FIELDS[facetType].map((f) => [f.key, f]));
      for (const key of Object.keys(FACET_SCHEMAS[facetType].shape)) {
        const f = fields.get(key);
        if (!f) {
          if (SCHEMA_ONLY[key]) details[key] = SCHEMA_ONLY[key];
          continue;
        }
        details[key] =
          f.type === 'select'
            ? `one of: ${(f.options ?? []).map((o) => o.value).join(', ')}`
            : f.type === 'pageLink'
              ? `${PAGE_TYPE_LABELS[(f.pageType ?? 'generic') as PageType] ?? 'page'} page: id or exact title`
              : f.type === 'refLink'
                ? `rules uid of a ${f.refKind} (search_rules)`
                : f.type === 'date'
                  ? 'date YYYY-MM-DD'
                  : f.type === 'checkbox'
                    ? 'true or false'
                    : f.type === 'longtext'
                      ? 'text (up to 2000 characters)'
                      : f.type;
      }
    }
    guide[type] = { label: PAGE_TYPE_LABELS[type], details };
  }
  return guide;
}
