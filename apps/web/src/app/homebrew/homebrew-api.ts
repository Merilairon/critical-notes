import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import type {
  CampaignSummaryDto,
  CreateHomebrewSourceInput,
  EntityDto,
  HomebrewEdition,
  HomebrewEntityDto,
  HomebrewEntitySummaryDto,
  HomebrewImportReportDto,
  HomebrewRevisionDto,
  HomebrewSourceDto,
  HomebrewUsageDto,
  HomebrewValidationDto,
  SaveHomebrewEntityInput,
  UpdateHomebrewSourceInput,
} from '@cn/shared';
import { firstValueFrom } from 'rxjs';

const base = '/api/homebrew';

/** Thin client for the homebrew API. */
@Injectable({ providedIn: 'root' })
export class HomebrewApi {
  private readonly http = inject(HttpClient);

  sources() {
    return firstValueFrom(this.http.get<{ sources: HomebrewSourceDto[] }>(`${base}/sources`)).then((r) => r.sources);
  }
  source(id: string) {
    return firstValueFrom(this.http.get<HomebrewSourceDto>(`${base}/sources/${id}`));
  }
  createSource(input: CreateHomebrewSourceInput) {
    return firstValueFrom(this.http.post<HomebrewSourceDto>(`${base}/sources`, input));
  }
  updateSource(id: string, patch: UpdateHomebrewSourceInput) {
    return firstValueFrom(this.http.patch<HomebrewSourceDto>(`${base}/sources/${id}`, patch));
  }
  deleteSource(id: string) {
    return firstValueFrom(this.http.delete<void>(`${base}/sources/${id}`));
  }
  share(id: string, campaignIds: string[]) {
    return firstValueFrom(this.http.put<HomebrewSourceDto>(`${base}/sources/${id}/shares`, { campaignIds }));
  }
  entities(sourceId: string, includeDeleted = false) {
    return firstValueFrom(
      this.http.get<{ entities: HomebrewEntitySummaryDto[] }>(`${base}/sources/${sourceId}/entities`, { params: includeDeleted ? { deleted: '1' } : {} }),
    ).then((r) => r.entities);
  }
  entity(id: string) {
    return firstValueFrom(this.http.get<HomebrewEntityDto>(`${base}/entities/${id}`));
  }
  create(sourceId: string, input: SaveHomebrewEntityInput) {
    return firstValueFrom(this.http.post<{ entity: HomebrewEntityDto; validation: HomebrewValidationDto }>(`${base}/sources/${sourceId}/entities`, input));
  }
  save(id: string, input: SaveHomebrewEntityInput) {
    return firstValueFrom(this.http.put<{ entity: HomebrewEntityDto; validation: HomebrewValidationDto }>(`${base}/entities/${id}`, input));
  }
  delete(id: string) {
    return firstValueFrom(this.http.delete<void>(`${base}/entities/${id}`));
  }
  restore(id: string) {
    return firstValueFrom(this.http.post<HomebrewEntityDto>(`${base}/entities/${id}/restore`, {}));
  }
  revisions(id: string) {
    return firstValueFrom(this.http.get<{ revisions: HomebrewRevisionDto[] }>(`${base}/entities/${id}/revisions`)).then((r) => r.revisions);
  }
  revision(id: string, revNo: number) {
    return firstValueFrom(this.http.get<{ data: Record<string, unknown>; fluff: Record<string, unknown> | null }>(`${base}/entities/${id}/revisions/${revNo}`));
  }
  restoreRevision(id: string, revNo: number) {
    return firstValueFrom(this.http.post<HomebrewEntityDto>(`${base}/entities/${id}/revisions/${revNo}/restore`, {}));
  }
  usage(id: string) {
    return firstValueFrom(this.http.get<{ usage: HomebrewUsageDto[] }>(`${base}/entities/${id}/usage`)).then((r) => r.usage);
  }
  preview(sourceId: string, entityType: string, data: Record<string, unknown>, entityId: string | null) {
    return firstValueFrom(
      this.http.post<{ entity: EntityDto | null; validation: HomebrewValidationDto }>(`${base}/preview`, { sourceId, entityType, data, entityId }),
    );
  }
  copy(sourceId: string, baseUid: string, mode: 'clone' | 'variant', name?: string) {
    return firstValueFrom(this.http.post<{ entity: HomebrewEntityDto; validation: HomebrewValidationDto }>(`${base}/copy`, { sourceId, baseUid, mode, name }));
  }
  importFiles(files: File[], defaultEdition: HomebrewEdition) {
    const form = new FormData();
    for (const f of files) form.append('files', f, f.name);
    form.append('defaultEdition', defaultEdition);
    return firstValueFrom(this.http.post<HomebrewImportReportDto>(`${base}/import`, form));
  }
  importUrl(url: string, defaultEdition: HomebrewEdition) {
    return firstValueFrom(this.http.post<HomebrewImportReportDto>(`${base}/import-url`, { url, defaultEdition }));
  }
  exportUrl(sourceId: string) {
    return `${base}/sources/${sourceId}/export`;
  }
  campaigns() {
    return firstValueFrom(this.http.get<{ campaigns: CampaignSummaryDto[] }>('/api/campaigns')).then((r) => r.campaigns);
  }
}
