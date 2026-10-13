import { httpResource } from '@angular/common/http';
import { computed, inject, type Signal } from '@angular/core';
import type { PageSummaryDto, PageType } from '@cn/shared';
import { CampaignStore } from '../campaign.store';

export type TypedPage = PageSummaryDto & { facet: Record<string, unknown> | null; tags: string[] };

/** Pages of one type with their facets, re-fetched when the page tree changes. Call in an injection context. */
export function typedPages(type: PageType): { items: Signal<TypedPage[]>; loading: Signal<boolean> } {
  const store = inject(CampaignStore);
  const res = httpResource<{ pages: TypedPage[] }>(() => {
    store.pages(); // refetch after tree changes
    const id = store.id();
    return id ? { url: `/api/campaigns/${id}/pages`, params: { type } } : undefined;
  });
  return { items: computed(() => (res.hasValue() ? res.value().pages : [])), loading: res.isLoading };
}

export function facetStr(p: TypedPage, key: string): string | null {
  const v = p.facet?.[key];
  return v == null || v === '' ? null : String(v);
}
