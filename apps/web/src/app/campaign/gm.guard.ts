import { HttpClient } from '@angular/common/http';
import { inject } from '@angular/core';
import { Router, type CanActivateFn } from '@angular/router';
import { isGameMaster, type CampaignDto } from '@cn/shared';
import { firstValueFrom } from 'rxjs';
import { ContextService } from '../core/context.service';

/** Game-master pages (encounters, combat, campaign templates): players land on the campaign overview instead. */
export const gmGuard: CanActivateFn = async (route) => {
  const context = inject(ContextService);
  const http = inject(HttpClient);
  const router = inject(Router);
  const id = route.pathFromRoot.map((r) => r.paramMap.get('campaignId')).find((v) => !!v);
  if (!id) return true;
  const known = context.campaign();
  const role = known?.id === id ? known.role : (await firstValueFrom(http.get<CampaignDto>(`/api/campaigns/${id}`)).catch(() => null))?.role;
  // An unknown campaign is left to the page (it shows "not found")
  return !role || isGameMaster(role) || router.createUrlTree(['/c', id]);
};
