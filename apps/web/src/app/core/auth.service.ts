import { HttpClient } from '@angular/common/http';
import { computed, inject, Injectable, signal } from '@angular/core';
import type { MeDto, UserDto } from '@cn/shared';
import { firstValueFrom } from 'rxjs';

@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly http = inject(HttpClient);
  readonly user = signal<UserDto | null>(null);
  readonly setupRequired = signal(false);
  readonly loaded = signal(false);
  readonly signedIn = computed(() => !!this.user());

  async refresh(): Promise<MeDto> {
    const me = await firstValueFrom(this.http.get<MeDto>('/api/auth/me'));
    this.user.set(me.user);
    this.setupRequired.set(me.setupRequired);
    this.loaded.set(true);
    return me;
  }

  async ensureLoaded(): Promise<void> {
    if (!this.loaded()) await this.refresh();
  }

  async login(username: string, password: string) {
    await firstValueFrom(this.http.post('/api/auth/login', { username, password }));
    await this.refresh();
  }

  async setup(username: string, displayName: string, password: string) {
    await firstValueFrom(this.http.post('/api/auth/setup', { username, displayName, password }));
    await this.refresh();
  }

  /** Creates an account through a campaign invite; returns the campaign joined. */
  async register(token: string, username: string, displayName: string, password: string): Promise<string> {
    const res = await firstValueFrom(this.http.post<{ campaignId: string }>('/api/auth/register', { token, username, displayName, password }));
    await this.refresh();
    return res.campaignId;
  }

  async logout() {
    await firstValueFrom(this.http.post('/api/auth/logout', {}));
    this.user.set(null);
  }

  /** Called by the HTTP interceptor when the server says the session is gone. */
  markSignedOut() {
    this.user.set(null);
  }
}
