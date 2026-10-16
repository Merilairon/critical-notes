/**
 * The MCP tools call the app's own REST API, in-process, as the token's user: every role check, validation
 * and player projection is the one the web app gets. Only the calls the tools need are allowed; tokens never
 * reach accounts, invites, members, imports or exports.
 */
import type { Hono } from 'hono';
import { internalAuth, type AppEnv, type InternalAuth } from '../auth/session';

const ID = '[^/?#]+';
const ROUTES: [string, RegExp][] = [
  ['GET', new RegExp(`^/api/campaigns(/${ID}(/(pages|properties|search|members|encounters|inventory)(/${ID})?)?)?$`)],
  ['GET', /^\/api\/reference\/(search|autocomplete\/[a-z]+)$/],
  ['GET', new RegExp(`^/api/homebrew/(sources(/${ID}(/entities)?)?|entities/${ID})$`)],
  ['GET', new RegExp(`^/api/templates(/${ID})?$`)],
  ['POST', new RegExp(`^/api/campaigns/${ID}/(pages(/from-template|/${ID}/(move|restore))?|properties|encounters|inventory/(items|coins))$`)],
  ['POST', new RegExp(`^/api/homebrew/(sources(/${ID}/entities)?|entities/${ID}/restore)$`)],
  ['POST', /^\/api\/templates$/],
  ['PATCH', new RegExp(`^/api/campaigns/${ID}/(pages|properties|encounters|inventory/items)/${ID}$`)],
  ['PATCH', new RegExp(`^/api/homebrew/sources/${ID}$`)],
  ['PUT', new RegExp(`^/api/(homebrew/entities|templates)/${ID}$`)],
  ['PUT', new RegExp(`^/api/homebrew/sources/${ID}/shares$`)],
  ['DELETE', new RegExp(`^/api/campaigns/${ID}/(pages|properties|encounters|inventory/items)/${ID}$`)],
  ['DELETE', new RegExp(`^/api/(homebrew/entities|templates)/${ID}$`)],
];

/** Whether the MCP tools may call this method and path (tests prove accounts and admin routes never match). */
export const isAllowed = (method: string, url: string) => ROUTES.some(([m, re]) => m === method && re.test(url));

/** A refused or failed API call, with the API's own explanation. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body: unknown,
  ) {
    super(message);
  }
}

/** Builds an API path, encoding every value so ids from the model can't change the path. */
export function path(strings: TemplateStringsArray, ...values: (string | number)[]): string {
  return strings.reduce((out, s, i) => out + s + (i < values.length ? encodeURIComponent(String(values[i])) : ''), '');
}

type Issue = { path?: string; message?: string };
const issueText = (i: Issue) => (i.path ? `${i.path}: ${i.message}` : String(i.message));

function describe(status: number, body: unknown): string {
  const b = (body ?? {}) as { error?: string; issues?: Issue[]; details?: { errors?: Issue[]; warnings?: Issue[]; current?: { revision?: number }; currentRevision?: number } };
  const parts = [b.error ?? `Request failed (${status})`];
  if (b.issues?.length) parts.push(b.issues.map(issueText).join('; '));
  // Homebrew validation
  if (b.details?.errors?.length) parts.push(`errors: ${b.details.errors.map(issueText).join('; ')}`);
  if (b.details?.warnings?.length) parts.push(`warnings: ${b.details.warnings.map(issueText).join('; ')}`);
  // Edited elsewhere in the meantime
  const current = b.details?.current?.revision ?? b.details?.currentRevision;
  if (current !== undefined) parts.push(`it is now at revision ${current}; read it again`);
  return parts.join(' — ');
}

export class Api {
  constructor(
    private readonly app: Hono<AppEnv>,
    readonly auth: InternalAuth,
  ) {}

  async request<T>(method: string, url: string, body?: unknown, query?: Record<string, string | number | undefined>): Promise<T> {
    if (!isAllowed(method, url)) throw new ApiError(403, `Not available to AI assistants: ${method} ${url}`, null);
    const params = new URLSearchParams(Object.entries(query ?? {}).flatMap(([k, v]): [string, string][] => (v === undefined || v === '' ? [] : [[k, String(v)]])));
    const target = `http://internal${url}${params.size ? `?${params}` : ''}`;
    const res = await this.app.request(
      target,
      { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }) },
      internalAuth(this.auth),
    );
    if (res.status === 204) return null as T;
    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    if (!res.ok) throw new ApiError(res.status, describe(res.status, json), json);
    return json as T;
  }

  get<T>(url: string, query?: Record<string, string | number | undefined>) {
    return this.request<T>('GET', url, undefined, query);
  }
  post<T>(url: string, body: unknown = {}, query?: Record<string, string | number | undefined>) {
    return this.request<T>('POST', url, body, query);
  }
  patch<T>(url: string, body: unknown) {
    return this.request<T>('PATCH', url, body);
  }
  put<T>(url: string, body: unknown) {
    return this.request<T>('PUT', url, body);
  }
  delete<T>(url: string) {
    return this.request<T>('DELETE', url);
  }
}
