import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import type {
  AwardLootInput,
  Coins,
  CombatantInput,
  CreateEncounterInput,
  EncounterDto,
  EncounterSummaryDto,
  InventoryDto,
  InventoryItemDto,
  PlayerTrackerView,
  TrackerAction,
  TrackerDto,
  TrackerSummaryDto,
  UpdateEncounterInput,
} from '@cn/shared';
import { firstValueFrom } from 'rxjs';

/** Client for encounters, trackers and inventories of one campaign. */
@Injectable({ providedIn: 'root' })
export class PlayApi {
  private readonly http = inject(HttpClient);
  private base(campaignId: string) {
    return `/api/campaigns/${campaignId}`;
  }

  encounters(campaignId: string) {
    return firstValueFrom(this.http.get<{ encounters: EncounterSummaryDto[]; trackers: TrackerSummaryDto[] }>(`${this.base(campaignId)}/encounters`));
  }
  encounter(campaignId: string, id: string) {
    return firstValueFrom(this.http.get<EncounterDto>(`${this.base(campaignId)}/encounters/${id}`));
  }
  createEncounter(campaignId: string, input: CreateEncounterInput) {
    return firstValueFrom(this.http.post<EncounterDto>(`${this.base(campaignId)}/encounters`, input));
  }
  updateEncounter(campaignId: string, id: string, patch: UpdateEncounterInput) {
    return firstValueFrom(this.http.patch<EncounterDto>(`${this.base(campaignId)}/encounters/${id}`, patch));
  }
  deleteEncounter(campaignId: string, id: string) {
    return firstValueFrom(this.http.delete<void>(`${this.base(campaignId)}/encounters/${id}`));
  }
  startEncounter(campaignId: string, id: string, includeParty = true) {
    return firstValueFrom(this.http.post<TrackerDto>(`${this.base(campaignId)}/encounters/${id}/start`, { includeParty }));
  }

  tracker(campaignId: string, id: string) {
    return firstValueFrom(this.http.get<TrackerDto>(`${this.base(campaignId)}/trackers/${id}`));
  }
  createTracker(campaignId: string, name: string, combatants: CombatantInput[] = []) {
    return firstValueFrom(this.http.post<TrackerDto>(`${this.base(campaignId)}/trackers`, { name, combatants }));
  }
  act(campaignId: string, id: string, action: TrackerAction) {
    return firstValueFrom(this.http.post<TrackerDto>(`${this.base(campaignId)}/trackers/${id}/actions`, action));
  }
  deleteTracker(campaignId: string, id: string) {
    return firstValueFrom(this.http.delete<void>(`${this.base(campaignId)}/trackers/${id}`));
  }
  playerView(campaignId: string, id: string) {
    return firstValueFrom(this.http.get<PlayerTrackerView>(`${this.base(campaignId)}/trackers/${id}/player`));
  }
  eventsUrl(campaignId: string, id: string, view: 'dm' | 'player') {
    return `${this.base(campaignId)}/trackers/${id}/events?view=${view}`;
  }

  inventory(campaignId: string) {
    return firstValueFrom(this.http.get<InventoryDto>(`${this.base(campaignId)}/inventory`));
  }
  addItem(campaignId: string, input: { ownerPageId: string | null; itemUid?: string | null; name?: string; quantity?: number }) {
    return firstValueFrom(this.http.post<InventoryItemDto>(`${this.base(campaignId)}/inventory/items`, input));
  }
  updateItem(campaignId: string, id: string, patch: Partial<Pick<InventoryItemDto, 'ownerPageId' | 'name' | 'quantity' | 'attuned' | 'identified' | 'notes'>>) {
    return firstValueFrom(this.http.patch<{ item: InventoryItemDto | null }>(`${this.base(campaignId)}/inventory/items/${id}`, patch)).then((r) => r.item);
  }
  deleteItem(campaignId: string, id: string) {
    return firstValueFrom(this.http.delete<void>(`${this.base(campaignId)}/inventory/items/${id}`));
  }
  changeCoins(campaignId: string, ownerPageId: string | null, change: Partial<Coins>) {
    return firstValueFrom(this.http.post<{ coins: Coins }>(`${this.base(campaignId)}/inventory/coins`, { ownerPageId, change })).then((r) => r.coins);
  }
  awardLoot(campaignId: string, input: AwardLootInput) {
    return firstValueFrom(this.http.post<InventoryDto>(`${this.base(campaignId)}/loot/award`, input));
  }
}
