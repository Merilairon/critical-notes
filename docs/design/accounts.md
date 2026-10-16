# Accounts: recovery and user administration (design and threat model)

Task M2.1 · Owner: Identity & Access Engineer · QA: Security Architect · Reference: PRD §8 M2 · Date: 2026-10-16

Design only. Nothing here is implemented. Rule 4 of `docs/PROJECT.md` applies to every task that builds it
(both schemas, parity test, visibility sentinel tests, `pnpm -s typecheck && pnpm -s lint && pnpm -s test`).

## 1. To record in D5 (owner decision)

**Question:** when an admin deletes a user, what happens to the campaigns that user owns?
("Owns" = the single `campaign_members` row with `role = 'dm'`; co-DMs have `role = 'codm'`.)

| Option | What happens | Gain | Cost |
|---|---|---|---|
| A. Transfer only | Admin picks an existing member of each campaign; that member becomes owner (`dm`). | Always leaves a campaign with an owner who can manage members and edition. | Needs a second member. A solo campaign cannot be deleted-around. |
| B. Archive only | Campaign is set `archived`, the owner's membership goes with the user, nobody is owner. | Nothing is lost, no decision about who inherits. | Ownerless: `requireOwner` (members, roles, edition migration, `services/campaigns.ts`) can never pass again. Only co-DMs can still open it. With no co-DM it becomes unreachable. |
| C. Admin chooses per campaign (transfer or archive), no silent default | Delete is refused until every owned campaign has an explicit choice. | Fits both cases. | One extra step in the UI. |

**Recommended default: C, with "Transfer" pre-selected in the UI.**
Rules the server enforces:
1. Every owned campaign needs a choice, or the request is rejected (400, naming the uncovered campaigns).
2. Transfer target must be a current member of that campaign (a co-DM is pre-selected if one exists).
3. Archive is allowed only if at least one co-DM remains (otherwise nobody could ever open or unarchive it). A solo campaign cannot be archived-and-orphaned: the admin must disable the user instead (loses nothing, reversible) or have the user hand the campaign over first.
4. Disabling is the no-data-impact alternative and is the first thing the UI suggests.

Owner answer needed: "A, B or C (recommended)". If C, also confirm Q1 and Q2 in section 11.

## 2. What exists today (review of the real code)

| Area | Current behaviour | Consequence for this design |
|---|---|---|
| `auth/session.ts` `createSession` | 32 random bytes, only `hashToken` (sha256) stored in `sessions.id`; cookie `HttpOnly; SameSite=Lax; Secure` when `publicUrl` is https; 30 day sliding expiry. | Reuse `hashToken` for reset tokens. Fresh token per login, so no fixation. |
| `sessionMiddleware` | Cookie branch joins `sessions` to `users` on every request (no cache), so `isAdmin` is current. The `INTERNAL_AUTH` branch loads the user by id and **does not look at any disabled state**. | `disabled_at` must be checked in both branches (section 8). Role changes already take effect immediately. |
| `routes/auth.ts` `/password` | Verifies current password, writes new hash, **leaves every session alive**, no rate limit. | M2.3 must end other sessions and rate limit it. |
| `routes/auth.ts` `/login` | Dummy-hash verify for unknown users (measured: dummy and real hash both ~8 ms with `@node-rs/argon2`, so the timing defence works). Uniform "Wrong username or password". | Keep. Disabled-account message only after a correct password (section 8). |
| `AttemptLimiter` | 8 attempts/min, in memory, private to `routes/auth.ts`. Key is `x-forwarded-for` + username. Entries are never pruned. | **Finding:** the header is client-controlled when the app is not behind a proxy that overwrites it, so rotating it bypasses the limit. Map grows with every spoofed key. Fix in M2.3 (section 9). |
| `services/api-tokens.ts` `verify` | Joins `users`, checks revoked/expired. **No disabled check.** | Add one (section 8). |
| `mcp/route.ts` | Calls `tokens.verify` on every request; tool calls then re-enter the app via `internalAuth`. | Two enforcement points, both need the disabled check. |
| `mcp/api.ts` `ROUTES` | Allowlist of method+regex, every pattern anchored at `/api/campaigns`, `/api/reference`, `/api/homebrew`, `/api/templates`. `/api/auth/*` and `/api/admin/*` match nothing. | New routes are unreachable from MCP as long as nobody adds a pattern. Lock it with a test (section 9). |
| `routes/tokens.ts` | `requireUser` plus a guard rejecting `tokenScope` ("tokens never manage tokens"). | Copy this guard into the new account and admin routes (defence in depth). |
| `CampaignService` invites | `tokenHash` unique, `CampaignService.hash` (private sha256), `expiresAt`, `revokedAt`, `uses`; unknown/used/expired give *different* messages, but all need the 256-bit token first. | Reset tokens follow the same storage pattern but answer all failures identically. |
| `sessions` / `api_tokens` / `campaign_members` FKs | `ON DELETE CASCADE` to `users`. | Deleting a user already removes sessions, tokens and **memberships**. An owner's membership vanishing leaves an ownerless campaign. That is why delete needs the ownership step. |
| Other user FKs | `campaigns.created_by`, `pages.created_by`, `character_facets.player_user_id`, `homebrew_sources.owner_user_id`, `templates.owner_user_id`, `uploads.owner_user_id`, `campaign_invites.created_by` and others are `ON DELETE SET NULL`. | Content survives, attribution becomes null (UI must tolerate null authors; `services/homebrew.ts` already left-joins). Orphaned private homebrew/templates become invisible (Q2). |
| `main.ts` | `purgeExpiredSessions` runs once at start-up only. | Expired reset rows get the same one-shot purge; no new timer. |
| Runtime DB | `AppDb` is better-sqlite3 only (sync). `schema.pg.ts` is kept in parity by `test/pg-parity.test.ts` but not used at runtime. | Transactions are synchronous and single-process, which the last-admin rule relies on (section 6). |
| Audit | There is no audit table. | Section 10. |

## 3. Data model changes (M2.2)

Both `apps/server/src/db/schema.ts` and `schema.pg.ts`, then `pnpm --filter @cn/server db:generate`.

```
users
  + disabled_at   integer (epoch ms), nullable, no default      -- pg: bigint (the *_at rule in pg-parity.test.ts)

password_resets
  id          text primary key
  user_id     text not null  -> users.id   ON DELETE CASCADE
  token_hash  text not null  UNIQUE        -- sha256 of the token (hashToken), token never stored
  created_by  text null      -> users.id   ON DELETE SET NULL   -- null = created from the command line
  expires_at  integer not null             -- created time + 24 h
  used_at     integer null                 -- set when consumed OR superseded
  index password_resets_user (user_id)
```

Notes:
- `used_at` doubles as "no longer valid": issuing a new link for the same user sets `used_at` on that user's still-open links, so at most one link is live per user. No extra column needed.
- No `created_at` column (the task lists the columns exactly; creation time is `expires_at - 24 h`). Add only if the Backend Architect objects.
- `disabled_at` is a timestamp, not a boolean, so the admin list can show "disabled since".
- Existing rows migrate with `disabled_at = NULL` (enabled). Nothing else changes.

## 4. Flows

### 4.1 Admin-issued reset link
1. Admin opens the users page, presses "Reset link" for user U, and confirms with their own password (normative step-up, section 7, T10). The dialog has an optional checkbox "Also revoke this user's API tokens (suspected compromise)".
2. `POST /api/admin/users/:id/reset-link` with `{ currentPassword, revokeTokens?: boolean }` (default false). Server refuses if U is disabled (409 "Enable the account first"). In one transaction (rules of 4.7): set `used_at = now` on U's open links (audited as *superseded*, count logged); if `revokeTokens`, set `revoked_at = now` on U's non-revoked `api_tokens`; insert a row with `token_hash = hashToken(token)`, `token = randomBytes(32).toString('base64url')`, `expires_at = now + 24 h`, `created_by = admin.id`. The checkbox closes the window where a suspected compromise is handled by reset without a disable.
3. Response (once, never listed again): `{ url: "<PUBLIC_URL>/reset#<token>", expiresAt }`. The token sits in the URL **fragment**, so it never reaches proxy access logs, the `Referer` header or the server's request line. The UI shows it with a copy button. The token is not recoverable later; lost link = issue another.
4. The admin passes the link out of band (chat, in person).
5. U opens `/reset#<token>` (SPA route `/reset`, no auth guard). The page reads the fragment into memory and immediately calls `history.replaceState` to remove it from the address bar and history, then calls `GET /api/auth/reset/:token`: valid returns `{ username, displayName, expiresAt }`; anything else returns the one uniform 404 (section 5). GET never consumes the token (chat apps and link scanners prefetch links; and they do not run the SPA, so a prefetch of the fragment URL never even sends the token). The API call itself still carries the token in its path, so API access logs may contain it until it is consumed (T5).
6. U submits a new password to `POST /api/auth/reset/:token` (`{ newPassword }`). **Normative order**, M2.5 tests must match it:
   a. zod body validation first (`passwordSchema`). A weak or malformed password returns **400 before any token lookup**, so a 400 reveals nothing about the token, and a request with a garbage token and a weak password gets 400, not 404.
   b. **Look up first**, read-only: select the row by `token_hash` where `used_at IS NULL AND expires_at > now`, joined to a non-disabled user. If live, proceed to step c and ignore the failed-lookup budget entirely (a live token is never refused or counted, T12). If not live: check the failed-lookup budget (429 with `Retry-After` if exhausted), otherwise record one failure and return the uniform 404. No argon2 work happens on this path. The GET path uses the same order: look up; live = answer and ignore the budget; not live = budget check, record failure, uniform 404.
   c. Only for a live token: hash the new password (argon2, async, outside any transaction).
   d. One synchronous transaction: `UPDATE password_resets SET used_at = now WHERE token_hash = ? AND used_at IS NULL AND expires_at > now` and require `changes === 1` (the atomic single-use gate; `changes === 0` means another request won the race or the link just expired, and yields the **same uniform 404**); re-check the user is not disabled; set `password_hash`, `updated_at`; delete **all** the user's sessions; delete the session row of the request's incoming cookie if present (it may belong to a different user signed in on this browser) and clear the cookie; set `used_at` on any other open links of the user.
   e. `createSession` for a fresh session and return `{ ok: true }`.
   So the uniform 404 has two sources: the early liveness check (b) and the lost-race case (d). Tests: weak password with a garbage token = 400; garbage token with a valid password = 404; two concurrent POSTs with one live link = one 200 and one 404.
7. Any failure inside step 6d rolls the whole transaction back, so a failed reset does not burn the link.

By default a reset does not revoke API tokens (they are the user's own, managed on the Account page). If compromise is suspected the admin ticks `revokeTokens` when issuing the link (step 2); disabling the user (4.3), which also revokes tokens, remains the alternative. See Q3.

### 4.2 Self-service
- `PATCH /api/auth/me` changes the display name only. Username is immutable (it is the login and appears in no other mutable place).
- `POST /api/auth/password` (existing route, path unchanged): rate limited per user id; verifies the current password; writes the hash; deletes every session of the user **except** the current one (`hashToken(getCookie(c, SESSION_COOKIE))`); the current cookie is left untouched. Same-password reuse is allowed (not worth a rule).
- Neither route is reachable with a token (`tokenScope` guard).

### 4.3 Disable and enable
`PATCH /api/admin/users/:id { disabled: true }`, one transaction:
1. Require step-up (`currentPassword`, verified before the transaction, section 7). Refuse if target is the acting admin (409), or if the target is an enabled admin and this would leave zero enabled admins (409, last-admin rule).
2. Set `disabled_at = now`.
3. Delete all the user's `sessions` rows.
4. Set `revoked_at = now` on the user's non-revoked `api_tokens` (so re-enabling does not silently revive an AI assistant token; the user makes new ones).
5. Set `used_at = now` on the user's open `password_resets`.

Enforcement does not depend on steps 3 to 5 (section 8), so a missed row cannot leave access open. `{ disabled: false }` clears `disabled_at`; nothing else is restored. Enabling a **non-admin** needs no step-up. Enabling an **admin** (target `is_admin = true`) restores admin powers, so it needs `currentPassword` like the other protected actions: the service refuses inside the transaction with 400 "Enter your password to enable an admin account" when none was sent (the same status as any other missing password; a wrong one is 403 "Your password is wrong"). The shared zod schema cannot know the target, so it still lets a bare `{ disabled: false }` through. Campaign memberships are untouched (a disabled owner's campaign is still owned, just unattended).

### 4.4 Delete
`GET /api/admin/users/:id/owned-campaigns` returns `{ campaignId, name, members: [{userId, displayName, role}] }[]` for the plan screen.
`POST /api/admin/users/:id/delete` with `{ currentPassword, campaigns: [{ campaignId, action: 'transfer', toUserId } | { campaignId, action: 'archive' }] }`. (POST, not DELETE-with-body, because the Angular client and proxies handle DELETE bodies badly.) Success is 204. One transaction:
1. Refuse if target is the acting admin, or the last enabled admin.
2. Reload the target's owned campaigns; require the plan to cover exactly that set (extra or missing ids: 400 with the list). Never trust a client-supplied list of what the user owns.
3. Per campaign. Transfer: target must be a member (not the user); set that member's role to `dm`; set the campaign's `homebrew_sources` row with `scope = 'campaign'` to `owner_user_id = toUserId`. Archive: require at least one `codm`; set `status = 'archived'`, `updated_at`; the owner row disappears with the cascade.
4. Revoke open invites the user created (`campaign_invites.revoked_at`), because their `created_by` is about to become null and nobody owns them.
5. Delete the `users` row. FK cascades remove sessions, tokens, resets, memberships; `SET NULL` keeps pages, revisions and the rest. Their character pages stay, `player_user_id` becomes null (same as the existing `CampaignService.removeMember`).
6. Reassign or orphan personal homebrew sources and templates per Q2.

The username becomes free for reuse. That is acceptable because no row keeps pointing at the old id after steps 1 to 6.

### 4.5 Last-admin rule
Definition: an "admin" for this rule is a user with `is_admin = true AND disabled_at IS NULL`. One shared function, `assertNotLastAdmin(tx, userId)`, in `services/users.ts`, called inside the transaction by revoke-admin, disable and delete. It counts enabled admins *excluding* the target and refuses (409 "There must be at least one admin") if that count is 0 and the target is an enabled admin. An admin may not disable or delete themselves at all (stricter than the rule); an admin may revoke their own admin flag only if another enabled admin exists.

Concurrency: see 4.7. If Postgres is ever used at runtime this needs `SELECT ... FOR UPDATE` on the admin rows or serializable isolation; note it in `services/users.ts`.

### 4.6 Command-line reset (M2.6)
`node dist/admin.mjs reset-link <username>` (Docker: `docker compose exec app node admin.mjs reset-link <username>`).
- Entry `admin: 'src/cli/admin.ts'` in `scripts/build.mjs`. It uses `loadConfig()` and `openAppDb(config.appDbPath)` exactly as `cli/index.ts` does, opens the DB (WAL, `busy_timeout = 5000`, so it coexists with the running server), looks the user up by lower-cased username and calls the **same** creation function as 4.1 with `createdBy = null`.
- Prints one line, the URL (`<PUBLIC_URL>/reset#<token>`, built by the same `createResetLink` as the admin path, so the format cannot diverge), plus the expiry, to stdout. Nothing else, so scripts can capture it. Errors go to stderr with a non-zero exit: unknown user (1), disabled user (2, "enable it first": the CLI deliberately has no enable command, see Q5), bad usage.
- Prints a warning to stderr if `PUBLIC_URL` is still the default `http://localhost:4200`, since the link would be wrong.
- Authorisation is possession of the database file or container shell. Whoever has that can already read every password hash and edit `users` directly; the CLI adds no power. No password is ever accepted on the command line or printed.
- Works for any user, so it also unlocks a locked-out admin. The last-admin rule makes "no enabled admin exists" unreachable through the app, so the CLI does not need an override.

### 4.7 Transaction rules for every admin action (`services/users.ts`)
Step-up routes `await verifyPassword` (async, tens of ms) between `requireAdmin` and the synchronous transaction, so the admin's rights can change in that gap (stale actor). Therefore:
1. Every `services/users.ts` write that an admin triggers (reset-link, disable, enable, grant, revoke, delete) takes `actorId`, and **as its first statement inside the transaction re-reads the actor and asserts `is_admin = true AND disabled_at IS NULL`**; otherwise 403 and nothing is written. The middleware's earlier check is not trusted for writes.
2. `assertNotLastAdmin` counts enabled admins *other than the target* inside the same transaction. Race A-demotes-B while B-demotes-A: transactions serialise; the first commits (A still sees one other enabled admin: itself), the second fails rule 1 because its actor B is no longer an admin. If a third path ever lets the second proceed, the count of other enabled admins would be 0 and rule 2 refuses it too. Test both orders.
3. The guarantee that check and write cannot interleave holds only because there is one process with one synchronous better-sqlite3 writer (no `await` inside the transaction callback; lint/test: the callback must not be `async`). The CLI is a second process but only inserts reset rows and never changes admin or disabled flags. Running several app instances against one SQLite file is unsupported; Postgres needs the locking noted in 4.5.
4. Audit lines (section 10) are written after commit, from the service, with `actor`, `target`, `targetIsAdmin`.

## 5. Endpoints

All under the existing `originCheck` (same origin, JSON). JSON errors use `lib/http` helpers (`unauthorized`, `forbidden`, `badRequest`, `notFound`, 429 via the limiter).

| Method and path | Auth | Request | Response | Notes |
|---|---|---|---|---|
| `GET /api/auth/me` | none | | `MeDto` (unchanged) | |
| `PATCH /api/auth/me` | session, no token | `{ displayName }` (trim, 1 to 80) | `{ user }` | new `updateMeInput` in `packages/shared/src/auth.ts` |
| `POST /api/auth/password` | session, no token | `{ currentPassword, newPassword }` (existing `changePasswordInput`) | `{ ok: true }` | ends other sessions; 429 limiter per user |
| `GET /api/auth/reset/:token` | none | | `{ username, displayName, expiresAt }` or uniform 404 | does not consume; limited |
| `POST /api/auth/reset/:token` | none | `{ newPassword }` | `{ ok: true }` + session cookie, or uniform 404 | single use; limited; ends all sessions |
| `GET /api/admin/users` | `requireAdmin`, no token | | `{ users: AdminUserDto[] }` (`id, username, displayName, isAdmin, disabledAt, createdAt, ownedCampaignCount`) | |
| `POST /api/admin/users/:id/reset-link` | admin | `{ currentPassword, revokeTokens? }` | 201 `{ url, expiresAt }` (`url` = `<PUBLIC_URL>/reset#<token>`) | the only time the token appears |
| `PATCH /api/admin/users/:id` | admin | `{ disabled?: boolean, isAdmin?: boolean, currentPassword }` (at least one of the first two; `currentPassword` required unless the body is only `{ disabled: false }` on a non-admin target; an admin target needs it too, else 400) | `{ user: AdminUserDto }` | last-admin rule; no self-disable |
| `GET /api/admin/users/:id/owned-campaigns` | admin | | list for the plan screen | |
| `POST /api/admin/users/:id/delete` | admin | `{ currentPassword, campaigns: [...] }` | 204 | section 4.4 |

Uniform reset failure: unknown, expired, used, superseded and disabled-user tokens all return `404 { error: 'This reset link is not valid' }`, identical body and headers, and failed lookups (tokens that are not live) count against the reset budget (T12). (This differs deliberately from invites, which explain why an invite failed; an invite reveals a campaign name, a reset link reveals an account.) Responses on the reset routes carry `Cache-Control: no-store`.

Unknown user ids on admin routes return 404 (admins are trusted; no enumeration concern there).

## 6. Admin-route reachability from MCP

- `mcp/api.ts` `ROUTES` has no `/api/auth` or `/api/admin` pattern, and `Api.request` rejects anything not matching before dispatch. **Do not add any.**
- Defence in depth in M2.4: `requireAdmin` (in `auth/session.ts`) also rejects when `c.get('tokenScope')` is set (403), so a future allowlist mistake still cannot run an admin action for an admin's token. The same guard goes in the `PATCH /me` and `/password` routes.
- Test (M2.4): iterate `app.routes` (Hono exposes them), and for every `/api/admin/*` and `/api/auth/*` route assert no `ROUTES` pattern matches any method+path; plus a runtime test that an admin's `cn_` token on `/mcp` cannot reach them. Export `ROUTES` (or an `isAllowed(method, url)`) from `mcp/api.ts` for this, a one-line change.

## 7. Threats and mitigations

| # | Threat | Where | Mitigation |
|---|---|---|---|
| T1 | **User enumeration** via login | `/login` | Already uniform message and equal timing (dummy hash verified, ~8 ms both). Keep. Disabled message only after the correct password, so it reveals nothing to someone without the password. |
| T2 | Enumeration via reset | `GET/POST /api/auth/reset/:token` | One uniform 404 for unknown, expired, used, superseded, disabled. Tokens are 256-bit random, so guessing "valid" is infeasible. |
| T3 | Enumeration via register | `/register` returns "That username is taken" | Needs a valid invite token first; accepted, unchanged. Mention in the pen test (G1.1). |
| T4 | **Token theft: DB leak** | `password_resets`, `sessions`, `api_tokens` | Only sha256 stored; 256-bit tokens make a fast hash safe. |
| T5 | Token theft: link intercepted or kept in logs, history, Referer | URL fragment `/reset#<token>` and API path `/api/auth/reset/:token` | 24 h expiry, single use, superseded by a newer link. The fragment is never sent to the server, proxy or `Referer`, and the page strips it with `history.replaceState`. The API call carries the token in its path, so access logs of the app or a reverse proxy can contain a *live* token until used or expired: README tells hosts not to ship logs off-box and that consumed links are dead. `Referrer-Policy: same-origin` already set in `app.ts`; reset page loads no third-party resource, CSP is `'self'`; `no-store` on the API. The admin sees the link only in the response to their request. |
| T6 | Link prefetch by chat apps/scanners | `GET` | GET is read-only; only POST with a password consumes. |
| T7 | **Reset replay / race** (two POSTs with one link) | `POST` | Atomic conditional UPDATE, `changes === 1` inside one sync transaction; second request gets the uniform 404. |
| T8 | **Privilege escalation:** non-admin calls admin routes | `/api/admin/*` | `requireAdmin` on the whole sub-app; admin flag read from the DB each request (`sessionMiddleware`), so demotion is immediate; 403 tests on every route (M2.4 acceptance). |
| T9 | Escalation via MCP/API token of an admin | `/mcp` | Allowlist (section 6) plus `tokenScope` rejection in `requireAdmin`; `tokens` cannot manage tokens already. |
| T10 | Escalation by a compromised admin session (stolen cookie) minting resets, promoting, demoting or disabling | admin routes | **Step-up is normative for all of: reset-link, delete, grant-admin, revoke-admin, disable, enable-admin.** Each takes the acting admin's `currentPassword`, verified with `verifyPassword` before the transaction and limited per admin id (5/min). Enabling a non-admin needs none (it restores nothing: sessions are gone, tokens revoked, the user still needs a password); enabling an admin does (it silently restores admin powers). The attempt is counted before the verification is awaited and given back on success (only that one attempt, so a legitimate success does not erase a thief's failures), so concurrent guesses cannot all pass the budget check. Resolves Q4. |
| T11 | **Admin reset = account takeover by design** (no email): admin sets a password link, signs in as the user, reads their DM notes | by design | Unavoidable without email; the host already owns the DB. Mitigate by visibility: the reset ends every session so the user notices; the audit log (section 10) records who issued it; README states that the host is trusted. A reset link does not reveal the old password. |
| T12 | **Brute force:** login, reset GET/POST, password change | limiters | Today's `AttemptLimiter` is spoofable and prunes nothing. M2.3 extracts it to `lib/rate-limit.ts` with: prune on write (cap map size, e.g. 10 000 keys); an additional per-username login budget independent of IP (e.g. 30 failures/15 min, 429 with `Retry-After`) so rotating `X-Forwarded-For` does not help; trust `X-Forwarded-For` only when `TRUST_PROXY=1`, else key on the socket address. **Reset routes count failed lookups only** (a token that is not live): 30 failures per 10 min per IP key, gated at step 6b / the GET lookup. A request whose token *is* live is never refused by this budget and never counts, so link prefetch by chat apps (valid GETs) cannot burn it and an attacker's failures at a shared key cannot block a legitimate reset. There is no per-token budget (tokens are 256-bit; the budget only needs to bound guessing). Password change: 5/min per user id. |
| T13 | Lockout DoS: attacker burns the per-username login budget to lock a victim out; or, behind a reverse proxy with `TRUST_PROXY` off, all users share one key | T12 | Budgets are temporary (minutes), never a permanent lock; the victim keeps the admin reset link and the CLI. Concrete default-safe mitigations for the shared-key case: (1) login keys stay `ip|username`, so a shared IP never pools different users; (2) reset budgets exempt live tokens (T12), so one attacker cannot lock out resets; (3) the app logs one warning at the first request that carries an `X-Forwarded-For` header while `TRUST_PROXY` is off ("behind a proxy? set TRUST_PROXY=1"); (4) the shipped `docker-compose` does **not** set `TRUST_PROXY` because it publishes the app port directly, where trusting the header would reintroduce the spoof; the README's reverse-proxy section tells hosts to set it, and only when the proxy overwrites `X-Forwarded-For`. |
| T14 | **Timing** | login, reset | Login handled (above). Reset: lookup by unique-indexed hash of a 256-bit secret reveals nothing guessable. The POST's early 404 (no argon2) is faster than the live path; that only distinguishes "live token" for someone who already holds it, and GET shows that anyway. Ordering is normative in 4.1 step 6. |
| T15 | Disabled user keeps access | sessions, `/mcp`, in-flight requests | Enforced at use in every layer (section 8), not only by deleting rows. |
| T16 | Session fixation / stale session after reset | `createSession` | New random token every time; reset deletes all prior sessions before issuing the new one. |
| T17 | CSRF on new state-changing routes | `/api/auth`, `/api/admin` | Covered by `originCheck` (same host or `publicUrl`, JSON only) plus `SameSite=Lax`. New routes are all POST/PATCH with JSON bodies. |
| T18 | Mass-assignment | `PATCH /me`, `PATCH /admin/users/:id` | zod schemas are strict objects (`.strict()`); `PATCH /me` accepts `displayName` only, so `isAdmin`/`username` can never be set there. |
| T19 | Orphaned or stranded campaigns on delete | `campaign_members` cascade | Section 4.4 rules 1 to 3. |
| T20 | CLI misuse | `admin.mjs` | Requires shell/FS access (already total control); never prints hashes or passwords; refuses disabled accounts. |
| T21 | Last admin removed through a race or a second path | admin routes | One shared `assertNotLastAdmin` plus the actor re-check inside the same synchronous transaction for revoke, disable, delete (4.7); test each path, and the A-demotes-B / B-demotes-A race in both orders. |
| T22 | **Admin-on-admin abuse:** one admin resets, disables, demotes or deletes another admin (hostile admin, or a compromised one) | admin routes | **Decision (recommended): all admins are equally trusted with every admin-on-admin action**, protected by the normative step-up (T10), the last-admin rule and the stale-actor check (4.7), and **every such action is audited with `targetIsAdmin: true`**. Rejected: a second-admin approval flow (heavy for a self-hosted tool whose host owns the DB anyway). The M2.8 UI adds only a confirm dialog that names the target when the target is an admin. The victim admin learns of it from the forced logout and, with `revokeTokens`, the revoked tokens. |
| T23 | **Backup restore resurrects old security state:** a restored backup brings back `disabled_at = NULL` for since-disabled users, since-revoked API tokens, live sessions, and unexpired or already-used-at-the-time reset links | M3 restore | Rule handed to **M3.1/M3.2**: restore must (a) delete all `sessions` and all `password_resets` rows, (b) report to the admin the users who were disabled or whose tokens were revoked after the backup time if known, and tell them to re-check (disable state and token revocations cannot be reconstructed from the old file), and (c) force every user to sign in again. Backups hold password hashes and token hashes: only admins may download them (`requireAdmin`, no token scope), the file must not be written world-readable, and the guide warns hosts to store them like secrets. |

## 8. Disabled-user enforcement (M2.3 owns it)

Check `users.disabled_at IS NULL` at every place a user is resolved:
1. `sessionMiddleware`, cookie branch: add `isNull(users.disabledAt)` to the join `where`. A disabled user's cookie then behaves as no session.
2. `sessionMiddleware`, `INTERNAL_AUTH` branch: after loading the user, `if (!user || user.disabledAt) throw unauthorized()`.
3. `ApiTokenService.verify`: return `null` when `row.user.disabledAt !== null`. `mcp/route.ts` then answers 401, matching the acceptance "a disabled user gets 401 everywhere, including `/mcp`".
4. `/login`: after `verifyPassword` succeeds, if disabled return `403 'This account is disabled. Ask the host.'` without creating a session. The limiter is cleared only on full success.
5. `/reset/:token` GET and POST: disabled user = uniform 404.

## 9. Test checklist (for M2.3 to M2.5, summarised in M2.10)

Failure paths first, per the identity rules: expired / used / unknown / superseded reset (identical body); weak password with garbage token = 400, garbage token with good password = 404; valid GETs do not consume the failed-lookup budget; reset POST removes the incoming cookie's session row; stale-actor test (admin demoted between `requireAdmin` and the transaction is refused) and A/B mutual-demotion race in both orders; exactly one `dm` row per campaign after any delete plan; concurrent double-POST of one link; reset ends all sessions and the new cookie works; password change keeps current session, ends the others; disabled user: login 403 after right password, existing cookie 401, `cn_` token 401 at `/mcp` and on a tool call already in flight; re-enable does not revive revoked tokens; non-admin and token-authenticated admin get 403 on every `/api/admin/*`; allowlist test (section 6); last-admin under revoke/disable/delete; delete without a plan, with a plan missing a campaign, with a non-member target, and archive with no co-DM all rejected; X-Forwarded-For rotation does not bypass the limiter; `visibility.test.ts` unchanged (no campaign content leaves through these routes; the owned-campaigns list returns names and member names only, admin-only).

## 10. Audit trail

No audit table exists and the task list does not ask for one. For 1.0: one structured `console.info(JSON.stringify({ event, actor, target, ip, at }))` line per event, via a tiny `lib/audit.ts`, for: login failure and lockout (429), password change, reset link created (actor, target, `created_by` null for CLI, `revokeTokens`), reset links superseded (separate event, with count), reset used (separate event), disable/enable, admin grant/revoke, user delete with the plan. Never log tokens, links or passwords. A table is a possible later step (Q6).

## 11. Open questions

1. **D5:** option A, B or C (recommended C)? If C, is "archive requires a co-DM" acceptable, or do you want an admin "assign owner to an ownerless campaign" action (extra endpoint, extra task)?
2. **Personal homebrew and templates of a deleted user** (`homebrew_sources.scope` private/campaigns/instance, user-scoped `templates`, `uploads`): FK `SET NULL` leaves them ownerless. Recommended: shared sources (campaigns, instance) go to the acting admin so campaigns keep working; private ones and user templates stay ownerless and invisible (effectively deleted). M2.4 must verify how `homebrew.ts` and `templates.ts` treat null owners before choosing.
3. Should a **password reset** also revoke the user's API tokens? Recommended: default no (the reset is "I forgot"), with the admin's optional `revokeTokens` checkbox at issuance for suspected compromise; disabling the user is the alternative.
4. Step-up password re-entry is now normative for reset-link, delete, grant-admin, revoke-admin, disable and enabling an admin (T10). Owner only needs to confirm the UX cost is acceptable. Related decision T22: all admins equally trusted, admin-on-admin actions audited (recommended) versus a second-admin approval flow (rejected as heavy).
5. Should the CLI also have `enable <username>` and `make-admin <username>`? Not needed for 1.0 (the last-admin rule stops lock-out); left out to avoid scope creep.
6. Audit as log lines (recommended) or a table? A table needs a backup/restore story (M3.1).
7. PRD §8 M2 mentions a one-time *temporary password* as an alternative and `node dist/index.mjs reset-password` as an example. This design uses only links and `dist/admin.mjs reset-link` (per `docs/PROJECT.md` M2.1/M2.6). If accepted, log it in `docs/PLAN.md` deviations.
8. `TRUST_PROXY` is a new config flag (T12/T13). Default off, and the shipped compose file leaves it off because it publishes the port directly. Behind a reverse proxy users share one socket-address key until it is set; section T13 lists the mitigations that keep that safe. Confirm that default.
9. Reset links use the fragment form `/reset#<token>`, not the `/reset/:token` page route written in M2.9. Log this small deviation in `docs/PLAN.md` if accepted.

## 12. Task boundaries for M2.2 to M2.10

Shared functions are built once, by the first task that needs them, as pure services (take `db`, no Hono context) so the CLI can reuse them.

| Task | Does | Does not |
|---|---|---|
| **M2.2** Schema | `users.disabled_at`; `password_resets` (columns and indexes of section 3) in both schemas; generated migrations; parity test; populated-`var/` migration test. | No routes, no services, no `created_at` on resets, no audit table. |
| **M2.3** Self-service | `PATCH /api/auth/me` + `updateMeInput`; `/password` ends other sessions and is limited; `endUserSessions(db, userId, exceptSessionId?)` helper in `auth/session.ts`; extract `AttemptLimiter` to `lib/rate-limit.ts` with pruning, per-username budget, `TRUST_PROXY` and its one-time warning, and the failed-lookup-only reset budget (T12); all section 8 disabled checks (sessionMiddleware both branches, `ApiTokenService.verify`, `/login`); `tokenScope` guard. Tests set `disabled_at` directly in the DB. | No admin routes, no reset logic, no UI. |
| **M2.4** Admin endpoints | `routes/admin.ts`, `services/users.ts` (list, disable/enable incl. session end and token revoke, grant/revoke admin, delete with plan, `assertNotLastAdmin`), **`createResetLink(db, userId, createdBy | null, baseUrl)`** (pure, reused by M2.6), `requireAdmin` rejecting `tokenScope`, route mounted in `app.ts`, exported allowlist check plus the MCP-unreachability test, step-up password check for reset-link, delete, grant, revoke, disable and enabling an admin, `revokeTokens` option, the 4.7 transaction rules (actor re-read, non-async callback), audit lines. Applies the D5 answer. | No redeem (`/api/auth/reset/*`), no UI, no CLI. |
| **M2.5** Reset by link | `GET/POST /api/auth/reset/:token` with uniform failure and the normative POST order of 4.1 step 6 (zod 400, liveness check, hash, atomic UPDATE, delete incoming cookie's session), atomic single use, ends all sessions, new session cookie, limiter use; purge expired/used rows at start-up beside `purgeExpiredSessions`. | Does not create links. |
| **M2.6** CLI | `src/cli/admin.ts` + `scripts/build.mjs` entry `admin`; `reset-link <username>` calling M2.4's `createResetLink`; stdout/stderr/exit-code contract of 4.6; README section; Docker one-liner verified against a running instance (WAL). | No other subcommands (Q5), no password prompts. |
| **M2.7** Account page | Display-name and password sections calling M2.3's endpoints; inline errors; the page tells the user other devices were signed out. | No admin features. |
| **M2.8** Users page | After the UX Architect sketch: list, reset link shown once with copy, disable/enable, admin toggle, delete with the per-campaign plan screen from `owned-campaigns`, password re-entry dialog, destructive confirmations, `adminGuard`-style route guard (server still checks). | No new server behaviour. |
| **M2.9** Reset page | `/reset` outside the auth guard, reads the token from the URL fragment, strips it with `history.replaceState` (deviation from the task text `/reset/:token`, Q9); calls GET then POST; uniform "link not valid" screen; no external resources; moves to the app signed in. | Does not show anything the uniform 404 hides. |
| **M2.10** Tests | `e2e/admin.spec.ts` per the task, plus the failure paths of section 9 not already covered by unit tests. | No new product behaviour. |

Handoff to **M3.1/M3.2** (T23): restore purges `sessions` and `password_resets`, forces re-login, warns that disabled/revoked state predates the backup, and restricts backup download to admins.

Docs touched by implementers: `docs/STATUS.md` (behaviour changes), `docs/PLAN.md` (deviation in Q7 if accepted), README (CLI and `TRUST_PROXY`).
