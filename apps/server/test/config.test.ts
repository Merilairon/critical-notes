import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';

describe('config', () => {
  const saved = { PUBLIC_URL: process.env.PUBLIC_URL, SECURE_COOKIES: process.env.SECURE_COOKIES };
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  });
  const secure = (publicUrl: string, flag?: string) => {
    process.env.PUBLIC_URL = publicUrl;
    if (flag === undefined) delete process.env.SECURE_COOKIES;
    else process.env.SECURE_COOKIES = flag;
    return loadConfig().secureCookies;
  };

  it('makes session cookies Secure only behind https, unless told otherwise', () => {
    expect(secure('https://notes.example.org')).toBe(true);
    // A LAN address over plain http: a Secure cookie would never come back
    expect(secure('http://192.168.1.20:3000')).toBe(false);
    expect(secure('http://192.168.1.20:3000', '1')).toBe(true);
    expect(secure('https://notes.example.org', '0')).toBe(false);
  });

  describe('empty backup variables (docker compose passes them empty when .env does not set them)', () => {
    const KEYS = ['BACKUP_EVERY_HOURS', 'BACKUP_KEEP', 'BACKUP_DIR', 'DATA_DIR'] as const;
    const before = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
    afterEach(() => {
      for (const k of KEYS) if (before[k] === undefined) delete process.env[k];
      else process.env[k] = before[k];
    });
    const load = (env: Record<string, string | undefined>) => {
      for (const k of KEYS) delete process.env[k];
      for (const [k, v] of Object.entries(env)) if (v !== undefined) process.env[k] = v;
      return loadConfig();
    };

    it('empty (or blank) behaves exactly like unset', () => {
      const unset = load({ DATA_DIR: '/srv/data' });
      for (const empty of ['', '   ']) {
        const c = load({ DATA_DIR: '/srv/data', BACKUP_EVERY_HOURS: empty, BACKUP_KEEP: empty, BACKUP_DIR: empty });
        expect(c.backupEveryHours).toBe(0);
        expect(c.backupEveryHoursError).toBeNull();
        expect(c.backupKeep).toBe(7);
        expect(c.backupDir).toBe('/srv/data/backups');
        expect(c).toEqual(unset);
      }
    });

    it('a real value still wins, and 0 turns the schedule off', () => {
      const c = load({ DATA_DIR: '/srv/data', BACKUP_EVERY_HOURS: '24', BACKUP_KEEP: '3', BACKUP_DIR: '/mnt/backups' });
      expect([c.backupEveryHours, c.backupKeep, c.backupDir]).toEqual([24, 3, '/mnt/backups']);
      expect(load({ BACKUP_EVERY_HOURS: '0' }).backupEveryHours).toBe(0);
    });
  });
});
