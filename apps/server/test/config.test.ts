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
});
