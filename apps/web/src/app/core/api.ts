/** Paths of the server API used by the web app. */
export const api = {
  kinds: '/api/reference/kinds',
  sources: '/api/reference/sources',
  list: (kind: string) => `/api/reference/kinds/${encodeURIComponent(kind)}`,
  entity: (uid: string) => `/api/reference/entities/${encodeURIComponent(uid)}`,
  search: '/api/reference/search',
  autocomplete: (kind: string) => `/api/reference/autocomplete/${encodeURIComponent(kind)}`,
};
