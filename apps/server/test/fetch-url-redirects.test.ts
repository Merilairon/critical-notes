import type { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The request layer is replaced, so "public" first hops need no network. The fake still runs the real `lookup`
// option that fetch-url.ts passes, so hostname hops go through the production address check.
const hops = vi.hoisted(() => ({ requested: [] as string[], routes: new Map<string, { status: number; location?: string; body?: string }>(), dns: new Map<string, string>() }));

vi.mock('node:dns', () => ({
  lookup: (host: string, _o: unknown, cb: (e: Error | null, a: Array<{ address: string; family: number }>) => void) => {
    const address = hops.dns.get(host);
    if (!address) return cb(new Error(`ENOTFOUND ${host}`), []);
    cb(null, [{ address, family: address.includes(':') ? 6 : 4 }]);
  },
}));

vi.mock('node:http', async () => {
  const { EventEmitter: EE } = await import('node:events');
  const request = (url: URL, opts: { lookup: (h: string, o: object, cb: (e: Error | null, a?: unknown) => void) => void }, cb: (res: unknown) => void) => {
    const req = new EE() as EventEmitter & { end: () => void; destroy: (e?: Error) => void };
    req.destroy = (e) => e && req.emit('error', e);
    req.end = () => {
      const host = url.hostname.replace(/^\[|\]$/g, '');
      // like node: an IP literal is connected to directly, only names go through `lookup`
      const resolve = /^[\d.]+$|:/.test(host) ? (c: (e: Error | null) => void) => c(null) : (c: (e: Error | null) => void) => opts.lookup(host, {}, c);
      resolve((err) => {
        if (err) return void req.emit('error', err);
        hops.requested.push(url.href);
        const r = hops.routes.get(url.href);
        if (!r) return void req.emit('error', new Error(`no route ${url.href}`));
        const res = new EE() as EventEmitter & { statusCode: number; headers: Record<string, string>; resume: () => void; destroy: () => void };
        res.statusCode = r.status;
        res.headers = r.location ? { location: r.location } : {};
        res.resume = () => {};
        res.destroy = () => {};
        cb(res);
        if (r.body !== undefined) queueMicrotask(() => { res.emit('data', Buffer.from(r.body!)); res.emit('end'); });
      });
    };
    return req;
  };
  return { default: { request }, request };
});

import { fetchUrlText } from '../src/homebrew/fetch-url';

const PUBLIC = '93.184.216.34';

beforeEach(() => {
  hops.requested.length = 0;
  hops.routes.clear();
  hops.dns.clear();
});

describe('fetchUrlText redirects (production address check, mocked request layer)', () => {
  it.each([
    ['a loopback literal', 'http://127.0.0.1/secret'],
    ['a private literal', 'http://10.0.0.5/secret'],
    ['the cloud metadata address', 'http://169.254.169.254/latest/meta-data'],
    ['an IPv6 loopback literal', 'http://[::1]/secret'],
    ['a hostname that resolves to a private address', 'http://internal.example/secret'],
  ])('refuses a 302 from a public host to %s, and never connects to it', async (_n, target) => {
    hops.dns.set('internal.example', '10.1.2.3');
    hops.routes.set(`http://${PUBLIC}/start`, { status: 302, location: target });
    await expect(fetchUrlText(`http://${PUBLIC}/start`)).rejects.toThrow(/not a public address/);
    expect(hops.requested).toEqual([`http://${PUBLIC}/start`]);
  });

  it('checks every hop, not only the first and the last', async () => {
    hops.routes.set(`http://${PUBLIC}/a`, { status: 301, location: `http://${PUBLIC}/b` });
    hops.routes.set(`http://${PUBLIC}/b`, { status: 307, location: '/c' }); // relative Location
    hops.routes.set(`http://${PUBLIC}/c`, { status: 302, location: 'http://192.168.1.1/x' });
    await expect(fetchUrlText(`http://${PUBLIC}/a`)).rejects.toThrow(/not a public address/);
    expect(hops.requested).toEqual([`http://${PUBLIC}/a`, `http://${PUBLIC}/b`, `http://${PUBLIC}/c`]);
  });

  it('refuses a redirect to a disallowed scheme, credentials or port', async () => {
    for (const [target, msg] of [
      ['file:///etc/passwd', /Only http and https/],
      [`http://user:pw@${PUBLIC}/x`, /credentials/],
      [`http://${PUBLIC}:22/x`, /port is not allowed/],
    ] as const) {
      hops.routes.set(`http://${PUBLIC}/start`, { status: 302, location: target });
      await expect(fetchUrlText(`http://${PUBLIC}/start`)).rejects.toThrow(msg);
    }
  });

  it('follows up to 3 redirects to a public file', async () => {
    hops.routes.set(`http://${PUBLIC}/1`, { status: 302, location: '/2' });
    hops.routes.set(`http://${PUBLIC}/2`, { status: 302, location: '/3' });
    hops.routes.set(`http://${PUBLIC}/3`, { status: 302, location: '/4' });
    hops.routes.set(`http://${PUBLIC}/4`, { status: 200, body: '{"ok":true}' });
    await expect(fetchUrlText(`http://${PUBLIC}/1`)).resolves.toBe('{"ok":true}');
    expect(hops.requested).toHaveLength(4);
  });

  it('stops after 3 redirects: the 4th redirect is not followed', async () => {
    for (let i = 1; i <= 6; i++) hops.routes.set(`http://${PUBLIC}/${i}`, { status: 302, location: `/${i + 1}` });
    await expect(fetchUrlText(`http://${PUBLIC}/1`)).rejects.toThrow('Too many redirects');
    expect(hops.requested).toEqual([1, 2, 3, 4].map((i) => `http://${PUBLIC}/${i}`));
  });
});
