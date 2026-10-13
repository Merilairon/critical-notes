/** Shared pieces of the browser tests. */
import { expect, test, type Browser, type Page } from '@playwright/test';
import { BASE_URL, DM_STATE } from './env';

export { BASE_URL, DM, DM_STATE } from './env';

/** A new browser page (its own cookies), signed in from `storageState` if given. Collects browser errors. */
export async function newPage(browser: Browser, storageState: string | undefined, errors: string[]): Promise<Page> {
  // Without a state, start signed out (Playwright would otherwise apply the project's: the DM's session)
  const context = await browser.newContext({ baseURL: BASE_URL, viewport: { width: 1440, height: 1000 }, storageState: storageState ?? { cookies: [], origins: [] } });
  return watch(await context.newPage(), errors);
}

/** Records the page's browser errors in `errors`, and accepts its confirm dialogs. */
export function watch(page: Page, errors: string[]): Page {
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    // Refused requests the app handles (401 before signing in, 403/404 by design) are not errors
    if (m.type() === 'error' && !/status of 40[0349]/.test(m.text())) errors.push(`console: ${m.text()}`);
  });
  page.on('dialog', (d) => void d.accept());
  return page;
}

/**
 * One page shared by the tests of a file, which run in order and build on each other (like the steps of a
 * session at the table). After each test: no browser errors; on failure, a screenshot is attached.
 */
export function sharedPage(storageState: string | undefined = DM_STATE) {
  const shared = { page: undefined as unknown as Page, errors: [] as string[] };
  test.describe.configure({ mode: 'serial' });
  test.beforeAll(async ({ browser }) => {
    shared.page = await newPage(browser, storageState, shared.errors);
  });
  // eslint-disable-next-line no-empty-pattern
  test.afterEach(async ({}, testInfo) => {
    if (testInfo.status !== testInfo.expectedStatus) await testInfo.attach('page', { body: await shared.page.screenshot({ fullPage: true }), contentType: 'image/png' });
    expect(shared.errors.splice(0), 'errors in the browser').toEqual([]);
  });
  test.afterAll(async () => shared.page?.context().close());
  return shared;
}

/** Calls the API with the page's cookies (as the server's own origin, which it requires for writes). */
export async function api<T = unknown>(page: Page, method: string, path: string, data?: unknown): Promise<T> {
  const res = await page.request.fetch(path, { method, ...(data === undefined ? {} : { data }), headers: { origin: BASE_URL } });
  expect(res.ok(), `${method} ${path}: ${res.status()} ${await res.text().catch(() => '')}`).toBe(true);
  return (res.status() === 204 ? null : await res.json()) as T;
}

/** The first block editor on the page. */
export const editor = (page: Page) => page.locator('.tiptap').first();

/** The page's save indicator says "Saved". */
export const saved = (page: Page) => expect(page.locator('[aria-live=polite]', { hasText: 'Saved' })).toBeVisible();

/** Picks an item from the open "/", "[[" or "{@" suggestion list. */
export async function pickSuggestion(page: Page, text: string) {
  await expect(page.locator('.cn-suggest-item', { hasText: text }).first()).toBeVisible();
  await page.keyboard.press('Enter');
}
