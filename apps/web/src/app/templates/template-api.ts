import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import type {
  CreatePageFromTemplateInput,
  CreateTemplateInput,
  InsertMode,
  PageDto,
  TemplateDto,
  TemplateImportReportDto,
  TemplateKindDto,
  TemplateSaveResultDto,
  TemplateTrashItemDto,
  TemplateSummaryDto,
  TemplateUsageDto,
  UpdateTemplateInput,
} from '@cn/shared';
import type { BlockNode } from '@cn/blocks';
import { firstValueFrom } from 'rxjs';

/** Thin client for the template API. */
@Injectable({ providedIn: 'root' })
export class TemplateApi {
  private readonly http = inject(HttpClient);

  list(opts: { campaignId?: string | null; kind?: TemplateKindDto } = {}) {
    const params: Record<string, string> = {};
    if (opts.campaignId) params['campaignId'] = opts.campaignId;
    if (opts.kind) params['kind'] = opts.kind;
    return firstValueFrom(this.http.get<{ templates: TemplateSummaryDto[] }>('/api/templates', { params })).then((r) => r.templates);
  }
  get(id: string) {
    return firstValueFrom(this.http.get<TemplateDto>(`/api/templates/${id}`));
  }
  create(input: CreateTemplateInput) {
    return firstValueFrom(this.http.post<TemplateDto>('/api/templates', input));
  }
  update(id: string, input: UpdateTemplateInput) {
    return firstValueFrom(this.http.put<TemplateSaveResultDto>(`/api/templates/${id}`, input));
  }
  remove(id: string) {
    return firstValueFrom(this.http.delete<void>(`/api/templates/${id}`));
  }
  trash(campaignId: string | null) {
    const params: Record<string, string> = campaignId ? { campaignId } : {};
    return firstValueFrom(this.http.get<{ templates: TemplateTrashItemDto[] }>('/api/templates/trash', { params })).then((r) => r.templates);
  }
  restore(id: string) {
    return firstValueFrom(this.http.post<TemplateDto>(`/api/templates/${id}/restore`, {}));
  }
  purge(id: string) {
    return firstValueFrom(this.http.delete<{ purged: string[] }>(`/api/templates/${id}/purge`));
  }
  duplicate(id: string, scope: 'user' | 'campaign', campaignId: string | null) {
    return firstValueFrom(this.http.post<TemplateDto>(`/api/templates/${id}/duplicate`, { scope, campaignId }));
  }
  usage(id: string) {
    return firstValueFrom(this.http.get<{ usage: TemplateUsageDto[] }>(`/api/templates/${id}/usage`)).then((r) => r.usage);
  }
  exportUrl(ids: string[]) {
    return `/api/templates/export?ids=${ids.map(encodeURIComponent).join(',')}`;
  }
  import(document: unknown, scope: 'user' | 'campaign', campaignId: string | null) {
    return firstValueFrom(this.http.post<TemplateImportReportDto>('/api/templates/import', { document, scope, campaignId }));
  }
  instantiate(campaignId: string, templateId: string, values: Record<string, unknown>, mode: InsertMode) {
    return firstValueFrom(this.http.post<{ content: BlockNode[] }>(`/api/campaigns/${campaignId}/templates/${templateId}/instantiate`, { values, mode })).then((r) => r.content);
  }
  createPage(campaignId: string, input: CreatePageFromTemplateInput) {
    return firstValueFrom(this.http.post<PageDto>(`/api/campaigns/${campaignId}/pages/from-template`, input));
  }
  apply(campaignId: string, pageId: string, templateId: string, values: Record<string, unknown>, mode: 'fill' | 'fields') {
    return firstValueFrom(this.http.post<PageDto>(`/api/campaigns/${campaignId}/pages/${pageId}/apply-template`, { templateId, values, mode }));
  }
  defaults(campaignId: string) {
    return firstValueFrom(this.http.get<{ defaults: Record<string, string> }>(`/api/campaigns/${campaignId}/template-defaults`)).then((r) => r.defaults);
  }
  setDefault(campaignId: string, pageType: string, templateId: string | null) {
    return firstValueFrom(this.http.put<{ defaults: Record<string, string> }>(`/api/campaigns/${campaignId}/template-defaults`, { pageType, templateId })).then((r) => r.defaults);
  }
}
