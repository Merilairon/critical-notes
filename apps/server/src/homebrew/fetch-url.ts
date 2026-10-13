/**
 * Server-side download of homebrew JSON by URL, hardened against SSRF:
 * - http(s) only, no credentials in the URL, only the default ports or 1024+
 * - every resolved address is checked when the connection is made (custom `lookup`), so DNS rebinding
 *   cannot slip a private address in after the check
 * - redirects are followed manually (max 3), each hop checked again
 * - size and time limits
 */
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';

export const MAX_DOWNLOAD_BYTES = 10 * 1024 * 1024;
const TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 3;

const blocked = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  blocked.addSubnet(net, prefix, 'ipv4');
}
for (const [net, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96],
  ['100::', 64],
  ['2001:db8::', 32],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  blocked.addSubnet(net, prefix, 'ipv6');
}

/** True for loopback, private, link-local, CGNAT, multicast, documentation and other non-public addresses. */
export function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return blocked.check(address, 'ipv4');
  if (family !== 6) return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) return blocked.check(mapped[1]!, 'ipv4');
  return blocked.check(address, 'ipv6');
}

export class UrlFetchError extends Error {}

export interface FetchOptions {
  maxBytes?: number;
  timeoutMs?: number;
  /** Tests only: allow private addresses (e.g. a local test server). */
  allowPrivate?: boolean;
}

function checkUrl(url: URL) {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new UrlFetchError('Only http and https links can be imported');
  if (url.username || url.password) throw new UrlFetchError('Links with credentials are not allowed');
  const port = url.port ? Number(url.port) : 0;
  if (port && port < 1024 && port !== 80 && port !== 443) throw new UrlFetchError('That port is not allowed');
}

function safeLookup(allowPrivate: boolean): LookupFunction {
  return (hostname, options, callback) => {
    dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err, '', 4);
      const list = addresses as LookupAddress[];
      const bad = list.find((a) => !allowPrivate && isBlockedAddress(a.address));
      if (bad || !list.length) return callback(new UrlFetchError(`Refusing to connect to ${hostname}: not a public address`), '', 4);
      if (options.all) return (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, list);
      return callback(null, list[0]!.address, list[0]!.family);
    });
  };
}

function requestOnce(url: URL, opts: Required<FetchOptions>): Promise<{ status: number; location: string | null; body: Buffer | null }> {
  return new Promise((resolve, reject) => {
    const literal = isIP(url.hostname.replace(/^\[|\]$/g, ''));
    if (literal && !opts.allowPrivate && isBlockedAddress(url.hostname.replace(/^\[|\]$/g, ''))) {
      reject(new UrlFetchError(`Refusing to connect to ${url.hostname}: not a public address`));
      return;
    }
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.request(
      url,
      { method: 'GET', lookup: safeLookup(opts.allowPrivate), headers: { accept: 'application/json, text/plain;q=0.9', 'user-agent': 'CriticalNotes-HomebrewImport' }, timeout: opts.timeoutMs },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          res.resume();
          resolve({ status, location: res.headers.location ?? null, body: null });
          return;
        }
        const declared = Number(res.headers['content-length'] ?? 0);
        if (declared > opts.maxBytes) {
          res.destroy();
          reject(new UrlFetchError(`The file is too large (max ${Math.round(opts.maxBytes / 1024 / 1024)} MB)`));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > opts.maxBytes) {
            res.destroy();
            reject(new UrlFetchError(`The file is too large (max ${Math.round(opts.maxBytes / 1024 / 1024)} MB)`));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => resolve({ status, location: null, body: Buffer.concat(chunks) }));
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(new UrlFetchError('The download timed out')));
    req.on('error', (e) => reject(e instanceof UrlFetchError ? e : new UrlFetchError(`Download failed: ${e.message}`)));
    req.end();
  });
}

/** Downloads a URL as text, following redirects safely. */
export async function fetchUrlText(input: string, options: FetchOptions = {}): Promise<string> {
  const opts: Required<FetchOptions> = { maxBytes: MAX_DOWNLOAD_BYTES, timeoutMs: TIMEOUT_MS, allowPrivate: false, ...options };
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new UrlFetchError('Not a valid link');
  }
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    checkUrl(url);
    const res = await requestOnce(url, opts);
    if (res.location) {
      url = new URL(res.location, url);
      continue;
    }
    if (res.status < 200 || res.status >= 300) throw new UrlFetchError(`The server answered ${res.status}`);
    return res.body!.toString('utf8');
  }
  throw new UrlFetchError('Too many redirects');
}
