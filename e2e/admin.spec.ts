/**
 * Accounts (Epic M2): reset links, disabling, API tokens of disabled users, the account page, deleting a user who owns a
 * campaign. Every test makes its own people (through an invite link, the only way in) and finds them by a unique name, so
 * the tests do not depend on each other or on their order. The admin is the shared first-run admin (project storage state).
 *
 * Secrets: reset links, tokens and passwords are never logged or put in an assertion message. Nothing is recorded for
 * these tests (no trace, screenshot or video), because a trace would contain the reset link and the API token.
 */
import { randomBytes } from 'node:crypto';
import { expect, test, type APIRequestContext, type Browser, type Page, type PlaywrightWorkerArgs } from '@playwright/test';

type Playwright = PlaywrightWorkerArgs['playwright'];
import { api, BASE_URL, DM, watch } from './support';

test.use({ trace: 'off', screenshot: 'off', video: 'off' });

const run = Date.now().toString(36);
const secret = (label: string) => `${label}-${randomBytes(9).toString('base64url')}`;

interface Account {
  id: string;
  username: string;
  displayName: string;
  password: string;
  /** Signed in as this person, API only. */
  http: APIRequestContext;
}

const closers: (() => Promise<unknown>)[] = [];
const browserErrors: string[] = [];

test.afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close().catch(() => undefined)));
  expect(browserErrors.splice(0), 'errors in the browser').toEqual([]);
});

/** An API client with the server's own origin, which it requires for writes. */
async function apiClient(playwright: Playwright): Promise<APIRequestContext> {
  const http = await playwright.request.newContext({ baseURL: BASE_URL, extraHTTPHeaders: { origin: BASE_URL } });
  closers.push(() => http.dispose());
  return http;
}

/** A page of a new browser context, signed in from the state (or signed out). */
async function pageFor(browser: Browser, state?: Awaited<ReturnType<APIRequestContext['storageState']>>): Promise<Page> {
  const context = await browser.newContext({ baseURL: BASE_URL, viewport: { width: 1440, height: 1000 }, storageState: state ?? { cookies: [], origins: [] } });
  closers.push(() => context.close());
  return watch(await context.newPage(), browserErrors);
}

/** An invite (one use) to a campaign the admin owns; returns its token. */
const invite = async (admin: Page, campaignId: string) =>
  (await api<{ token: string }>(admin, 'POST', `/api/campaigns/${campaignId}/invites`, { role: 'player', expiresInDays: 1, maxUses: 1 })).token;

/** Registers a new person through an invite link. */
async function register(playwright: Playwright, token: string, tag: string): Promise<Account> {
  const http = await apiClient(playwright);
  const username = `${tag}${run}`;
  const displayName = `${tag.toUpperCase()} ${run}`;
  const password = secret('pw');
  const res = await http.post('/api/auth/register', { data: { token, username, displayName, password } });
  expect(res.status(), 'register').toBe(201);
  const me = (await (await http.get('/api/auth/me')).json()) as { user: { id: string } };
  return { id: me.user.id, username, displayName, password, http };
}

/** A new ordinary user, invited by the admin into a campaign of its own. */
async function newUser(playwright: Playwright, admin: Page, tag: string): Promise<Account> {
  const campaign = await api<{ id: string }>(admin, 'POST', '/api/campaigns', { name: `Accounts ${tag} ${run}`, ruleset: '2024' });
  return register(playwright, await invite(admin, campaign.id), tag);
}

/** Signs `account` in on a new API client (a second device). */
async function signInAgain(playwright: Playwright, account: Account, password = account.password): Promise<{ http: APIRequestContext; status: number }> {
  const http = await apiClient(playwright);
  const res = await http.post('/api/auth/login', { data: { username: account.username, password } });
  return { http, status: res.status() };
}

const dialogOf = (page: Page) => page.getByRole('dialog');
const row = (page: Page, name: string) => ({
  reset: page.getByRole('button', { name: `Reset link for ${name}`, exact: true }),
  disable: page.getByRole('button', { name: `Disable ${name}`, exact: true }),
  enable: page.getByRole('button', { name: `Enable ${name}`, exact: true }),
  remove: page.getByRole('button', { name: `Delete ${name}`, exact: true }),
});
const status = (page: Page, text: string) => expect(page.getByRole('status').filter({ hasText: text })).toBeVisible();

/** The admin asks for a reset link in the Users page; returns the address the person opens (the secret stays out of logs). */
async function createResetLink(admin: Page, who: Account, opts: { revokeTokens?: boolean } = {}): Promise<string> {
  await admin.goto('/admin/users');
  await row(admin, who.displayName).reset.click();
  const dialog = dialogOf(admin);
  await expect(dialog.getByRole('heading', { name: `Reset link for ${who.displayName}` })).toBeVisible();
  if (opts.revokeTokens) await dialog.getByLabel(`Also revoke ${who.displayName}'s API tokens`).check();
  await dialog.getByLabel('Confirm with your password').fill(DM.password);
  await dialog.getByRole('button', { name: `Create link for ${who.displayName}` }).click();
  const url = await dialog.getByLabel('Reset link', { exact: true }).inputValue();
  expect(new URL(url).hash.length > 40, 'a reset link with a token').toBe(true);
  await dialog.getByRole('button', { name: 'Done' }).click();
  await expect(dialog).toHaveCount(0);
  return `${BASE_URL}/reset${new URL(url).hash}`;
}

/** The admin disables a person in the Users page. */
async function disableInUi(admin: Page, who: Account) {
  await admin.goto('/admin/users');
  await row(admin, who.displayName).disable.click();
  const dialog = dialogOf(admin);
  await dialog.getByLabel('Confirm with your password').fill(DM.password);
  await dialog.getByRole('button', { name: `Disable ${who.displayName}`, exact: true }).click();
  await status(admin, `${who.displayName} is disabled`);
  await expect(row(admin, who.displayName).enable).toBeVisible();
}

/** Creates an API token for the person (as they would on the Account page) and returns it. */
async function newToken(who: Account): Promise<string> {
  const res = await who.http.post('/api/auth/tokens', { data: { name: 'e2e assistant', scope: 'read', expiresInDays: 1 } });
  expect(res.status(), 'create token').toBe(201);
  const { token } = (await res.json()) as { token: string };
  expect(token.startsWith('cn_'), 'a cn_ token').toBe(true);
  return token;
}

/** The HTTP status of an MCP `initialize` with the token: 200 while the token lives, 401 once it does not. */
async function mcpStatus(playwright: Playwright, token: string): Promise<number> {
  const http = await playwright.request.newContext();
  try {
    const res = await http.post(`${BASE_URL}/mcp`, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream', 'content-type': 'application/json' },
      data: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'e2e', version: '1.0.0' } } },
    });
    return res.status();
  } finally {
    await http.dispose();
  }
}

test('a reset link: the user sets a new password, is signed in, the old password is dead, the link works once', async ({ page: admin, browser, playwright }) => {
  const rhea = await newUser(playwright, admin, 'rhea');
  const rheaToken = await newToken(rhea);
  const link = await createResetLink(admin, rhea);

  const page = await pageFor(browser);
  await page.goto(link);
  await expect(page.getByRole('heading', { name: 'Choose a new password' })).toBeVisible();
  await expect(page.getByText(`For ${rhea.displayName} (${rhea.username}).`)).toBeVisible();
  // The token left the address bar as soon as the page loaded
  await expect.poll(() => new URL(page.url()).hash).toBe('');
  const fresh = secret('new');
  await page.getByLabel('New password (at least 8 characters)').fill(fresh);
  await page.getByLabel('New password again').fill(fresh);
  await page.getByRole('button', { name: 'Set password and sign in' }).click();
  await page.waitForURL('**/campaigns');
  await expect(page.getByRole('link', { name: rhea.displayName, exact: true })).toBeVisible();

  expect((await signInAgain(playwright, rhea)).status, 'old password').toBe(401);
  expect((await signInAgain(playwright, rhea, fresh)).status, 'new password').toBe(200);
  // A reset without the "revoke tokens" box leaves her API token alone
  expect(await mcpStatus(playwright, rheaToken), 'token after a plain reset').toBe(200);

  // The same link in another browser: used up
  const other = await pageFor(browser);
  await other.goto(link);
  await expect(other.getByRole('heading', { name: 'This reset link is not valid' })).toBeVisible();
  await expect(other.getByLabel('New password (at least 8 characters)')).toHaveCount(0);
});

test('a disabled user loses the session and the API token, cannot sign in; enabling restores sign-in only', async ({ page: admin, browser, playwright }) => {
  const dax = await newUser(playwright, admin, 'dax');
  const daxPage = await pageFor(browser, await dax.http.storageState());
  await daxPage.goto('/campaigns');
  await expect(daxPage.getByRole('link', { name: dax.displayName, exact: true })).toBeVisible();
  const token = await newToken(dax);
  expect(await mcpStatus(playwright, token), 'token before').toBe(200);

  await disableInUi(admin, dax);
  expect(await mcpStatus(playwright, token), 'token after disable').toBe(401);

  // The session they had is cut
  await daxPage.reload();
  await daxPage.waitForURL('**/login**');
  expect((await (await dax.http.get('/api/auth/me')).json()).user).toBeNull();

  // The right password still shows the disabled message, not a session
  const login = async (page: Page) => {
    await page.goto('/login');
    await page.getByLabel('Username').fill(dax.username);
    await page.getByLabel('Password').fill(dax.password);
    await page.getByRole('button', { name: 'Sign in' }).click();
  };
  const signedOut = await pageFor(browser);
  await login(signedOut);
  await expect(signedOut.getByText('This account is disabled. Ask the host.')).toBeVisible();
  await expect(signedOut).toHaveURL(/\/login/);

  await row(admin, dax.displayName).enable.click();
  await status(admin, `${dax.displayName} is enabled`);
  await expect(row(admin, dax.displayName).disable).toBeVisible();

  const again = await pageFor(browser);
  await login(again);
  await again.waitForURL('**/campaigns');
  await expect(again.getByRole('link', { name: dax.displayName, exact: true })).toBeVisible();
  // Disabling revoked the token for good
  expect(await mcpStatus(playwright, token), 'token after enable').toBe(401);
});

test('a reset link that revokes API tokens kills the token', async ({ page: admin, playwright }) => {
  const cut = await newUser(playwright, admin, 'cut');
  const token = await newToken(cut);
  expect(await mcpStatus(playwright, token), 'token before').toBe(200);

  await createResetLink(admin, cut, { revokeTokens: true });
  await status(admin, `Reset link created for ${cut.displayName}`);
  await expect(admin.getByRole('status').filter({ hasText: 'Their API tokens were revoked' })).toBeVisible();

  expect(await mcpStatus(playwright, token), 'revoked on reset').toBe(401);
});

test('a non-admin has no Users link and cannot open the page; renaming updates the header; a password change signs out the other device only', async ({ browser, playwright, page: admin }) => {
  const pia = await newUser(playwright, admin, 'pia');
  const page = await pageFor(browser, await pia.http.storageState());
  const second = await signInAgain(playwright, pia);
  expect(second.status).toBe(200);
  const otherDevice = await pageFor(browser, await second.http.storageState());

  await page.goto('/campaigns');
  await expect(page.getByRole('link', { name: pia.displayName, exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Users', exact: true })).toHaveCount(0);
  await page.goto('/admin/users');
  await page.waitForURL('**/campaigns');
  await expect(page.getByRole('heading', { name: 'Users', exact: true })).toHaveCount(0);
  expect((await pia.http.get('/api/admin/users')).status(), 'admin API as a non-admin').toBe(403);

  // Rename
  await page.goto('/account');
  const renamed = `Pia Renamed ${run}`;
  await page.getByRole('textbox', { name: 'Display name' }).fill(renamed);
  await page.getByRole('button', { name: 'Save name' }).click();
  await status(page, `Display name changed to ${renamed}.`);
  await expect(page.getByRole('link', { name: renamed, exact: true })).toBeVisible();

  // Password: this browser stays signed in, the other device does not
  await otherDevice.goto('/campaigns');
  await expect(otherDevice.getByRole('link', { name: renamed, exact: true })).toBeVisible();
  const fresh = secret('new');
  await page.getByLabel('Current password').fill(pia.password);
  await page.getByLabel('New password (at least 8 characters)').fill(fresh);
  await page.getByLabel('New password again').fill(fresh);
  await page.getByRole('button', { name: 'Change password' }).click();
  await status(page, 'Password changed.');

  await page.goto('/campaigns');
  await expect(page.getByRole('link', { name: renamed, exact: true })).toBeVisible();
  await otherDevice.goto('/campaigns');
  await otherDevice.waitForURL('**/login**');
  expect((await signInAgain(playwright, pia)).status, 'old password').toBe(401);
  expect((await signInAgain(playwright, pia, fresh)).status, 'new password').toBe(200);
});

test('deleting a user who owns a campaign with a member transfers it to the member', async ({ page: admin, browser, playwright }) => {
  const olga = await newUser(playwright, admin, 'olga');
  const campaignName = `Olga's table ${run}`;
  const campaign = (await (await olga.http.post('/api/campaigns', { data: { name: campaignName, ruleset: '2024' } })).json()) as { id: string };
  const inviteToken = (await (await olga.http.post(`/api/campaigns/${campaign.id}/invites`, { data: { role: 'player', expiresInDays: 1, maxUses: 1 } })).json()) as { token: string };
  const nils = await register(playwright, inviteToken.token, 'nils');

  await admin.goto('/admin/users');
  await expect(admin.getByText(`${olga.displayName}`).first()).toBeVisible();
  await row(admin, olga.displayName).remove.click();
  const dialog = dialogOf(admin);
  await expect(dialog.getByText('owns 1 campaign')).toBeVisible();
  await dialog.getByLabel(`New owner of ${campaignName}`).selectOption({ value: nils.id });
  await dialog.getByLabel('Confirm with your password').fill(DM.password);
  await dialog.getByRole('button', { name: `Delete ${olga.displayName}`, exact: true }).click();
  await status(admin, `${olga.displayName} was deleted. 1 campaign was transferred.`);
  await expect(row(admin, olga.displayName).remove).toHaveCount(0);

  // The new owner sees themself as the owner
  const page = await pageFor(browser, await nils.http.storageState());
  await page.goto(`/c/${campaign.id}/settings`);
  const members = page.locator('section[aria-label=Members]');
  await expect(members.getByRole('listitem').filter({ hasText: nils.displayName }).filter({ hasText: 'DM (owner)' })).toBeVisible();
  await expect(members.getByText(olga.displayName)).toHaveCount(0);
  expect((await signInAgain(playwright, olga)).status, 'deleted user').toBe(401);
});
