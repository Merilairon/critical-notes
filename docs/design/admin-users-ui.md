# Admin users page and reset page: screen sketch

Task M2.8 and M2.9 · Owner: UX Architect · Implementer: Frontend Developer · QA: Evidence Collector, Accessibility Auditor · Date: 2026-10-16

Design only. No application code. Server behaviour is fixed by `docs/design/accounts.md` (sections 4, 5, 7) and by the real code in `apps/server/src/routes/admin.ts`, `apps/server/src/services/users.ts` and `packages/shared/src/auth.ts`. Everything below uses what the web app already has: Angular standalone components with signals, Tailwind tokens from `apps/web/src/styles.css`, `@angular/cdk` (already a dependency), `HttpClient`, `errorMessage()`. No new library.

## 1. Conventions reused (so the screens look and behave like the account page)

| Need | Existing pattern to copy |
|---|---|
| Page shell | `account-page.ts`: `mx-auto max-w-3xl p-4 sm:p-6`, `h1.font-display.text-3xl.font-bold`. The users table needs width, so use `max-w-5xl`. |
| Panels | `rounded-xl border border-line bg-panel p-4`, `aria-labelledby` on the section. |
| Inputs and buttons | `.cn-prop-input`; primary button `rounded-md bg-accent px-3 py-1.5 font-semibold text-accent-ink`; secondary `rounded border border-line px-2 py-0.5`. `--accent-ink` flips with the theme, so the primary button is correct in dark mode. |
| Busy and disabled | `aria-disabled` plus `aria-disabled:opacity-60`, not `[disabled]` (keeps the button focusable and announced). Submit handlers return early while busy (see `nameBusy`). |
| Inline errors | A `div role="alert"` that is always in the DOM, containing the `<p id="...-error">`; the field gets `aria-invalid="true"` and `aria-describedby` to the error id only while the error shows. Focus moves to the offending field. |
| Success | A `div role="status"` always in the DOM, text swapped in. |
| 429 | Copy `requestError()` from `account-page.ts` (Retry-After seconds, "Try again in 2 min"). Move it to `core/http.interceptor.ts` next to `errorMessage` and export it, so the account page, the admin dialog and the reset page share one copy. This is the only refactor the sketch asks for. |
| Copy to clipboard | `navigator.clipboard?.writeText(...)`, then a `copied` signal. (Improved below with a live region.) |
| Modal | `command-palette.ts` and `page-template-dialog.ts` use `fixed inset-0 z-50 bg-black/40`, `role="dialog" aria-modal="true"`, Esc on `document:keydown.escape`, click-outside closes. Neither traps focus nor returns it. The shared dialog below adds both using `@angular/cdk/a11y` (`cdkTrapFocus`, `cdkTrapFocusAutoCapture`), already installed. Click-outside must NOT close the step-up dialog (a stray click would discard a typed password and the choices), only Esc and Cancel do. |
| Colour tokens | `text-muted`, `text-accent` (error text, as the account page does), `border-line`, `bg-panel-2`, `--focus` ring comes from the global `:focus-visible`. Badges use existing tokens only (section 3). |
| Route guards | `authGuard` (`core/auth.guard.ts`) wraps the authenticated children. `gmGuard` shows the pattern of redirecting to a `UrlTree`. |

## 2. Route, guard and header link

### 2.1 `adminGuard`

New `apps/web/src/app/admin/admin.guard.ts`, same shape as `gmGuard`:

```
adminGuard: CanActivateFn
  auth = inject(AuthService); router = inject(Router)
  await auth.ensureLoaded().catch(() => undefined)
  return auth.user()?.isAdmin === true || router.createUrlTree(['/campaigns'])
```

- Registered as `canActivate: [adminGuard]` on the route, which sits inside the existing `authGuard` children, so a signed-out visitor goes to `/login?next=/admin/users` first, and a signed-in non-admin is sent to `/campaigns`.
- The guard is a convenience, not the security boundary. `requireAdmin` on the server is. A user demoted while on the page gets 403 from the next call (section 9, "Admin rights lost").
- Route: `{ path: 'admin/users', loadComponent: () => import('./admin/users-page').then(m => m.UsersPage), title: 'Users — Critical Notes', canActivate: [adminGuard] }`. Lazy, so non-admins never download it.
- Reset route (M2.9), outside the `authGuard` block: `{ path: 'reset', loadComponent: () => import('./auth/reset').then(m => m.ResetPage), title: 'Reset password — Critical Notes' }`. Top-level, next to `login`.

### 2.2 Header link (`app.html`)

In the existing `<nav>` after Templates, shown only for admins:

```
@if (auth.user()?.isAdmin) {
  <a routerLink="/admin/users" routerLinkActive="bg-panel-2 text-ink" class="rounded px-2 py-1 text-muted hover:text-ink">Users</a>
}
```

Label is "Users" (the page h1 is "Users"). Not shown to non-admins, not rendered at all (a header link to a page a person cannot open is noise; the page's own controls are the opposite case, see 4.3). The header already wraps (`flex-wrap`); at 320px it adds one item to a row that is already known to reflow badly (deferred to M6.3), so no extra work here.

## 3. Users list

### 3.1 Data and load

`GET /api/admin/users` returns `AdminUserDto[]`: `id, username, displayName, isAdmin, disabledAt, createdAt, ownedCampaignCount`. The page loads on entry and after every successful action (re-fetch the whole list: it is small, and it keeps last-admin state correct). Sort: enabled before disabled is NOT applied; keep the server order and add one client sort, by display name (case-insensitive), so rows do not jump after an action. Current user is found by comparing `id` with `auth.user()?.id`.

### 3.2 Desktop wireframe (md and up)

```
Users                                                    [ 7 users ]
Manage accounts on this server. Actions that change access ask for your password.

+------------------------------------------------------------------------------------------+
| Name                 Campaigns  Created      Status               Actions                |
|------------------------------------------------------------------------------------------|
| Jan Baetens          3 owned    12 Oct 2026  [Admin] [You]        (no actions on self;   |
|   jan                                                              Make not admin ...)   |
|------------------------------------------------------------------------------------------|
| Marie Dupont         1 owned    14 Oct 2026  [Admin]              [Reset link] [Remove   |
|   marie                                                            admin] [Disable] [Delete]
|------------------------------------------------------------------------------------------|
| Tom Peeters          0 owned    15 Oct 2026  [Disabled]           [Reset link*] [Make    |
|   tom                           disabled 16 Oct                    admin] [Enable] [Delete]
+------------------------------------------------------------------------------------------+
 * "Reset link" is disabled on a disabled user, with the reason (4.3).
```

- Columns: Name (display name bold, username below in `text-muted`), Campaigns ("N owned", "None"), Created (`date: 'mediumDate'`), Status (badges), Actions.
- Status badges, in this order: `Admin`, `Disabled`, `You`. They are text, never colour alone. Style: `rounded border px-1.5 py-0.5 text-xs font-medium`. `Admin`: `border-accent text-accent`. `Disabled`: `border-line bg-panel-2 text-muted` with a line "disabled 16 Oct" under it (`disabledAt | date:'mediumDate'`). `You`: `border-line text-ink`. A disabled admin shows both `Admin` and `Disabled`. Neutral tokens only, so both themes pass contrast the same way as the existing `text-accent`/`text-muted` text (the app-wide input-border finding is not made worse).
- Actions per row, left to right: **Reset link**, **Make admin** / **Remove admin**, **Disable** / **Enable**, **Delete**. Fixed positions so the eye finds the same button in every row. Delete is last and visually separated (`text-accent` text, not filled), it is the destructive one. Buttons are secondary-style (`rounded border border-line px-2 py-0.5 text-sm`); none is a primary button, because nothing on this page is a main call to action.
- Every button's accessible name includes the person, as the account page does for "Revoke {token}": `aria-label="Reset link for Marie Dupont"`, `"Disable Marie Dupont"`, `"Remove admin from Marie Dupont"`, `"Delete Marie Dupont"`. (Visible text stays short; the label starts with the visible text so voice control still works.)
- Markup is a real `<table>` with `<caption class="sr-only">Users and their access</caption>`, `<th scope="col">` headers, and `<th scope="row">` for the Name cell so a screen reader announces the person for each cell. The Actions header is visible text "Actions" (an empty `<th>` like the token table's is an a11y smell).

### 3.3 Mobile wireframe (390px, below `md`)

The table is replaced, not squeezed: below `md` the `<table>` is hidden with `hidden md:table` and a list of cards is shown with `md:hidden`. Both are rendered from the same signal; only one is exposed at a time (the hidden one is `display:none`, so it is out of the accessibility tree and the tab order).

```
+--------------------------------------+   390px wide, 16px gutters
| Users                         7 users |
|                                      |
| +----------------------------------+ |
| | Marie Dupont                     | |
| | marie · joined 14 Oct 2026       | |
| | [Admin]                          | |
| | Owns 1 campaign                  | |
| |                                  | |
| | [Reset link]  [Remove admin]     | |
| | [Disable]     [Delete]           | |
| +----------------------------------+ |
| +----------------------------------+ |
| | Tom Peeters                      | |
| | tom · joined 15 Oct 2026         | |
| | [Disabled] disabled 16 Oct       | |
| | Owns no campaigns                | |
| | [Reset link] unavailable: ...    | |
| | [Make admin]  [Enable]  [Delete] | |
| +----------------------------------+ |
+--------------------------------------+
```

- Card: `rounded-xl border border-line bg-panel p-3`, `<ul>` of `<li>`, each card `aria-labelledby` its name id. Name is an `h2`-level heading? No: use `<h2 class="sr-only">Users</h2>` before the list and make the name a `<strong>`; 40 headings for 40 users make heading navigation useless.
- Action buttons wrap in a two-column grid (`grid grid-cols-2 gap-2`), each at least 44px tall (`py-2`) on touch. Each button keeps the same `aria-label` with the person.
- Disabled-with-reason text (4.3) is visible text under the button row on mobile, not a tooltip (no hover on touch).
- Dialogs on mobile (section 5): full-width sheet with 12px margin (`p-3`), max height `calc(100dvh - 24px)` with the body scrolling and the footer buttons pinned, so the keyboard does not cover the Confirm button. The Delete plan scrolls inside the dialog.

### 3.4 States

| State | What is shown |
|---|---|
| Loading | Panel with `<p role="status">Loading users…</p>`. No skeleton. The h1 and intro are already visible. |
| Empty | Cannot normally happen (the admin is a user). If the list is `[]` anyway: "No users found." with the retry button. |
| Load error | Panel: `<div role="alert">` with `errorMessage(err)` and a `Try again` button (secondary style). 403 here (rights lost) reads "Admins only" from the server; show it as is plus a link "Back to campaigns". |
| After an action | `<div role="status">` above the table, always in the DOM: "Marie Dupont is disabled. Their sessions and API tokens were ended." Cleared on the next action or after the admin dismisses nothing (no timer; status text stays until replaced, matching `nameDone`). |
| Action error outside a dialog | Only the instant **Enable** action has none (no dialog): its error goes to a `role="alert"` region at the top of the list, and focus stays on the Enable button. |

## 4. Row actions and their rules

### 4.1 Which actions need what

| Action | Request | Needs step-up | Extra confirmation before the dialog |
|---|---|---|---|
| Reset link | `POST /:id/reset-link {currentPassword, revokeTokens?}` | yes | none; the dialog carries the `revokeTokens` checkbox (section 6) |
| Make admin | `PATCH /:id {isAdmin:true, currentPassword}` | yes | none beyond the dialog text (names the person, says what admin means) |
| Remove admin | `PATCH /:id {isAdmin:false, currentPassword}` | yes | dialog text; when the target is an admin the text names them (T22) |
| Disable | `PATCH /:id {disabled:true, currentPassword}` | yes | dialog text lists the consequences (sessions ended, API tokens revoked) |
| Enable | `PATCH /:id {disabled:false}` (no password) | **no** | **none** (reversible, restores nothing): runs directly. Announce "Tom Peeters is enabled. They need a new password link to sign in." in the status region; focus stays on the button. |
| Delete | `GET /:id/owned-campaigns`, then `POST /:id/delete {currentPassword, campaigns}` | yes | the Delete flow itself is the confirmation (section 7) |

"Destructive actions confirm first" (M2.8 acceptance) is met by one pattern for all of them: the step-up dialog is the confirmation. Its title names the action and the person, its body states the consequence in plain words, and its primary button repeats the verb ("Disable Tom Peeters"), never "OK". There is no second `confirm()` dialog: stacking a browser `confirm()` on top of the password dialog (the account page uses `confirm()` for Revoke) would be two modals for one decision. Enable is the one action with neither, by design (accounts.md T10).

### 4.2 Dialog consequence copy (shown in the dialog body)

- Reset link: "This creates a one-time link that lets Marie Dupont choose a new password. Anyone who has the link can take over the account until it is used or expires in 24 hours. Any earlier link for this account stops working."
- Make admin: "Marie Dupont will be able to manage every account on this server, including yours."
- Remove admin: "Marie Dupont will no longer be able to manage accounts." If the target is the acting admin ("You"): "You will lose access to this page as soon as this is saved."
- Disable: "Marie Dupont is signed out everywhere and can no longer sign in. Their API tokens (AI assistants) are revoked and do not come back if you enable the account again. Their campaigns, notes and characters are kept." If `ownedCampaignCount > 0`: "They own 1 campaign. It stays as it is and nobody else can manage its members until they return or you delete the account and hand it over."
- When the target is an admin, prefix every dialog above (except Enable) with a line in `font-medium`: "Marie Dupont is an admin." (T22: the confirm names the target when the target is an admin.)

### 4.3 Disabled buttons with reasons (never hidden)

Rule: a button that is unavailable stays in place, gets `aria-disabled="true"` (not the `disabled` attribute, so it stays focusable and its reason is read), is styled `opacity-60 cursor-not-allowed`, ignores clicks, and points with `aria-describedby` at visible text that gives the reason. On desktop the reason is a `<p class="sr-only">` plus a native `title` as a convenience only; on mobile it is visible text under the button row (no hover). To keep the table tidy on desktop, the reason is visible as one short muted line under the Actions cell for any row that has an unavailable button: "Cannot disable yourself." Several reasons stack.

| Situation | Unavailable | Reason text (also the `aria-describedby` target) |
|---|---|---|
| Row is the signed-in admin ("You") | Disable | "You cannot disable your own account." |
| Row is the signed-in admin | Delete | "You cannot delete your own account." |
| Row is the signed-in admin | Reset link | "Change your own password on the Account page." (This is the guidance; the server does allow it, but self-reset through an admin link is pointless and risky. See open question 2.) |
| Row is the signed-in admin, and no other enabled admin exists | Remove admin | "You are the only admin. Make someone else an admin first." |
| Row is the signed-in admin, another enabled admin exists | Remove admin | available; the dialog warns about losing the page (4.2) |
| Row is the only enabled admin (not you; cannot happen: you are an admin viewing this, so you would be the only one) | n/a | n/a |
| Row is an enabled admin and the last one | Disable, Delete, Remove admin | "There must be at least one admin." (Computed client-side as `enabledAdmins.length === 1 && row is that admin`; the server still enforces and answers 409 with the same sentence, which is shown inline if the client count was stale.) |
| Row is disabled | Reset link | "Enable this account first." (server: 409 "Enable the account first") |
| Row is disabled | Make admin / Remove admin | available (the server allows changing the flag of a disabled user); no reason needed |
| Row has `ownedCampaignCount > 0` | Delete | stays available; the Delete flow handles it (section 7). A hint is shown under the button: "Owns N campaigns: you will choose what happens to each." |

Reasons are computed in one place (a `rowRules(user)` function returning `{canReset, canDisable, canDelete, canToggleAdmin, reasons}`), unit-testable without the DOM. The client rules are advice; every one has a server 409 behind it and the dialog shows that error inline if the client was out of date (section 5.4).

Explicit non-goal: the client does not try to hide admin-on-admin actions. All admins are equally trusted (T22); the dialog line "Marie Dupont is an admin." is the whole mitigation in the UI.

### 4.4 Keyboard order and table semantics

- Tab order is DOM order: page h1, status region (not focusable), then row by row, left to right within a row: Reset link, Make/Remove admin, Disable/Enable, Delete. No custom roving tabindex or arrow-key grid: with 4 buttons per row and typically under 30 users, a plain tab order is predictable and needs no ARIA grid. A row with unavailable buttons still tabs through them (aria-disabled), so the order never changes after an action.
- `<table>` semantics as in 3.2. The "Status" cell's badges are inline text, read in order: "Admin, You". Each badge is plain text inside the cell (no `aria-label` override, no icon-only badge).
- Focus after an action: on success the list re-renders; focus returns to the same button if it still exists (same user, same action, e.g. Reset link), otherwise (Disable became Enable, Make admin became Remove admin) to the new button in the same position for that user, otherwise (row deleted) to the status region's heading target: the `h1`, with `tabindex="-1"` programmatically focused. The status text is then read by the live region.
- Escape never navigates. Shortcuts: none. (The app has Ctrl K for search; do not collide.)

## 5. The shared step-up confirmation dialog

ONE component, `cn-step-up-dialog`, used for all five protected actions (reset link, make admin, remove admin, disable, delete). The delete flow adds its plan as projected content (section 7); the reset-link flow adds the `revokeTokens` checkbox as projected content (section 6). Same chrome, same password handling, same error handling.

### 5.1 Contract

Inputs: `title` (e.g. "Disable Tom Peeters"), `confirmLabel` (e.g. "Disable Tom Peeters"), `danger` (boolean, styles the confirm button; see below), `submit: (password: string) => Promise<void>` (does the HTTP call; throws `HttpErrorResponse`), `disabledReason` (optional string: when set the confirm button is aria-disabled, used by the Delete plan while choices are incomplete). Projected content: the consequence text and any extra controls. Outputs: `done` (success), `cancelled`. The dialog owns: focus, Esc, the password field, busy state, error mapping. It never stores the password anywhere but the input element; it clears the input on success, on cancel and on a wrong-password error.

### 5.2 Wireframe

```
(page behind is dimmed: bg-black/40, inert)
+----------------------------------------------------------+
| Disable Tom Peeters                                      |   <h2 id="stepup-title">
|                                                          |
| Tom Peeters is signed out everywhere and can no longer   |   <p id="stepup-desc">  (consequence copy, 4.2)
| sign in. Their API tokens are revoked and do not come    |
| back if you enable the account again. ...                |
|                                                          |
|   [ projected extras: revokeTokens checkbox / delete plan ] |
|                                                          |
| Confirm with your password                               |   <label for="stepup-password">
| [ ******************************** ]                     |   autocomplete="current-password"
| Your password, not Tom's.                                |   <p id="stepup-hint"> muted, 12px
| (!) Your password is wrong. 4 tries left this minute.    |   <p id="stepup-error"> inside role="alert"
|                                                          |
|                         [ Cancel ]  [ Disable Tom Peeters ]
+----------------------------------------------------------+
```

- Container: `fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-3 pt-[8vh]`; panel `w-full max-w-lg rounded-xl border border-line bg-panel p-4 shadow-2xl`, `max-h-[calc(100dvh-1.5rem)] overflow-y-auto` (the Delete plan can be long).
- Confirm button: primary style (`bg-accent text-accent-ink`) for reversible-ish actions (reset link, make/remove admin, disable). For Delete, the same filled accent plus the label "Delete Tom Peeters"; the colour is not what carries the warning, the words in the title and body are. No red token exists and none is added.
- Cancel is a secondary button and is the first focusable control after the content in DOM order is NOT required; DOM order is: close/title, body, extras, password, Cancel, Confirm (confirm last, so Tab from the field reaches Cancel before the destructive button).

### 5.3 Accessibility behaviour

- Markup: `role="dialog" aria-modal="true" aria-labelledby="stepup-title" aria-describedby="stepup-desc"`. A destructive-confirmation dialog with a required input is a `dialog`, not `alertdialog` (the user must type something, and Esc must dismiss it).
- Focus trap: `cdkTrapFocus` with `cdkTrapFocusAutoCapture`. The page behind is made inert while open: set `inert` on the `<main>` and header wrappers from the dialog's parent (the Angular DOM has no `inert` binding by default; set the attribute through `Renderer2` or `host: { '[attr.inert]': ... }` on the page wrapper). This also stops screen-reader virtual-cursor escapes that `aria-modal` alone does not guarantee everywhere.
- Initial focus: the password input (the one thing the user must do). For the Delete plan, initial focus is the first unmade choice instead (section 7), because the password is useless before the choices are complete. The title is still announced because of `aria-labelledby`/`aria-describedby`.
- Esc: closes (emits `cancelled`) unless a request is in flight (then ignored, so a half-completed delete cannot be "cancelled" while it still runs). Click on the backdrop does nothing (see section 1).
- Return focus: the component stores `document.activeElement` when it opens and calls `.focus()` on it when it closes. If that element is gone after a successful action (deleted row, button text swapped), the page's focus rule (4.4) applies instead. The dialog emits `done` with no focus work of its own in that case.
- Enter in the password field submits the form (a real `<form novalidate>` with `(submit)="$event.preventDefault(); confirm()"`, exactly like the account page). A hidden `<input type="text" autocomplete="username" class="sr-only" tabindex="-1" aria-hidden="true" [value]="auth.user()?.username">` precedes the password field, copied from `account-page.ts`, so password managers fill the admin's password rather than the target's.
- Busy: Confirm becomes `aria-disabled="true"`, label "Working…", and the dialog `aria-busy="true"`. Cancel stays enabled before the request is sent and is `aria-disabled` while in flight.
- Error region: `<div role="alert"><p id="stepup-error">{{ error() }}</p></div>` always in the DOM, like `pw-error`. When an error shows, the relevant control gets `aria-invalid="true"` and `aria-describedby="stepup-error"` (password field for 403/429; none for general errors, whose text lives in the alert region).
- Reduced motion: no animation on open/close is specified.

### 5.4 Error handling (what the dialog shows, and where focus goes)

| Response | Meaning | Dialog behaviour |
|---|---|---|
| Client check: password empty | | Inline "Enter your password." Focus the password field. No request. |
| 403 `Your password is wrong` | step-up failed | Inline "Your password is wrong." Clear the field, focus it, `aria-invalid`. Dialog stays open with everything else (plan choices, checkbox) preserved. Do not distinguish further. |
| 403 `Admins only` | the acting admin lost rights meanwhile | Not a password problem. Replace the form with "You are no longer an admin." and a single "Close" button; on close navigate to `/campaigns`. (Matches the stale-actor check in accounts.md 4.7.) |
| 429 with `Retry-After` | step-up budget (5 wrong tries per minute) exhausted | Inline `requestError()` text: "Too many attempts. Try again in 40 s." Clear and focus the field. Confirm is `aria-disabled` until the countdown ends: a signal ticks once a second and updates the sentence only in the visible text, NOT in the `role="alert"` region on every tick (it would be re-announced every second); the alert region carries the first message once, and a separate non-live `<p>` shows the countdown. When it reaches 0 the message is cleared and Confirm is re-enabled. |
| 409 | rule violated, with the server's sentence: `There must be at least one admin`, `You cannot disable your own account`, `You cannot delete your own account`, `Enable the account first` | Inline, in the alert region, verbatim server text. The password was already accepted, so keep it in the field is NOT needed: clear it anyway (a retry re-prompts, which is cheap and avoids holding a password in the DOM). Dialog stays open; the admin can Cancel. Refresh the list in the background so the row's buttons update to match the rule. |
| 400 with `missing`/`extra`/per-campaign messages (delete only) | plan out of date (a member left, a campaign was handed over meanwhile) | Inline the server message, then re-fetch `owned-campaigns` and rebuild the plan (section 7.5), keeping the choices the admin already made for campaigns that still exist. |
| 404 `User not found` | the account was deleted elsewhere | Inline message; the Confirm button turns into "Close". Closing refreshes the list. |
| 401 | session expired | The global interceptor already redirects to `/login?next=...`. The dialog just closes. |
| 0 / network | | `errorMessage()` ("Cannot reach the server"). Dialog stays; nothing was changed as far as the admin knows. For Delete, after a network error show "Check the user list before trying again: the account may already be deleted." |
| 200/201/204 | success | Emit `done`; page shows the status message and re-fetches. |

## 6. Reset link flow

### 6.1 Step A: choose, then confirm (inside the step-up dialog)

Title "Reset link for Marie Dupont", body as 4.2, projected extras:

```
[ ] Also revoke Marie Dupont's API tokens
    Tick this if you think the account may be compromised. Their AI assistant
    tokens stop working at once. Leave it unticked for a forgotten password.
```

A single native checkbox with a visible `<label>`; default unticked (matches `revokeTokens` default false). Sent as `revokeTokens: true` only when ticked. Then the password field and "Create link" button (confirm label: "Create link for Marie Dupont").

### 6.2 Step B: result panel

The dialog does NOT close on success. It swaps its content in place (same `role="dialog"`, same focus trap) to the result view, because the link must not be lost by an accidental dismissal and the admin should read the warning first. The password field and Confirm button are removed; the single exit is "Done".

```
+----------------------------------------------------------+
| Reset link for Marie Dupont                              |
|                                                          |
| Send this link to Marie Dupont yourself (chat, in        |
| person). It works once and expires on 17 Oct 2026, 14:32|   expiresAt  (date:'medium'), plus "in 24 hours"
| (in 24 hours).                                           |
|                                                          |
| [ https://notes.example/reset#Xk3...AbC       ] [ Copy ] |   readonly input, font-mono text-xs, select-all on focus
| (Link copied)                                            |   <div role="status"> text appears after Copy
|                                                          |
| (!) This link will not be shown again. If you lose it,   |
|     create a new one; the new link cancels this one.    |
| (!) Anyone who has the link can set the password and     |
|     sign in as Marie Dupont.                             |
| Marie Dupont's API tokens were revoked.   <- only when revokeTokens was ticked
|                                                          |
|                                              [ Done ]    |
+----------------------------------------------------------+
```

- Receives `ResetLinkDto { url, expiresAt }`. `url` is already `<PUBLIC_URL>/reset#<token>`; show it as given. Do not rebuild it from `location.origin`: `PUBLIC_URL` may differ from the address the admin uses (reverse proxy), and the server built it for exactly that reason.
- Link box: `<input readonly class="cn-prop-input min-w-0 flex-1 font-mono text-xs" aria-label="Reset link" (focus)="select()">`, copied from the token creation panel in `account-page.ts` (same look the admins already know). On mobile the input is full width above the Copy button (stack), because a 100-character URL does not fit next to a button at 390px.
- Copy: button text "Copy link". After `navigator.clipboard.writeText` resolves, set `copied` and fill a `role="status"` element (always in the DOM) with "Link copied." The button's visible text can change to "Copied" as in the account page, but the live region is what screen readers hear; the account page's button-text-only change is not announced, and this is the improvement. If the clipboard API is missing or rejects (non-HTTPS origin, permission): the status says "Could not copy. Select the link and copy it by hand." and the input is selected (`select()`), which is also why it is a readonly input and not a `<pre>`.
- Expiry: show the absolute time (`expiresAt | date:'medium'`, local time) and the relative phrase "in 24 hours" computed once at render ("expires in about 24 hours"). Both visible text, no countdown.
- Warnings are plain visible paragraphs with a leading word ("Not shown again." / "Anyone with the link..."), not colour-only and not in an alert (they are static, read as part of the dialog description). Put the "will not be shown again" sentence in the dialog's `aria-describedby` target for this view so it is read when the view appears. When the view swaps, move focus to the readonly link input (so the next Tab reaches Copy), and announce "Reset link created" through the `role="status"` region (not through focus alone).
- The token never goes anywhere but this input: not `localStorage`, not a signal that outlives the dialog, not the router, not console logs. On Done (or Esc) the signal holding `ResetLinkDto` is set to `null` and the component is destroyed. There is no way back to the link: re-open the dialog and create another (it supersedes the old one, server side).
- `Cache-Control: no-store` is already sent by the server for this response.
- After Done, return focus to the "Reset link" button of that row; the page status region says "Reset link created for Marie Dupont. It expires on 17 Oct 2026, 14:32." (without the link).
- If the admin presses Esc in the result view: same as Done. No "are you sure you copied it?" prompt, the warning text carries that; a prompt on Esc would be an extra modal for an action that is trivially repeatable.

## 7. Delete flow with the per-campaign ownership choice

Delete is the same step-up dialog with a larger body. It is a two-phase dialog: a loading phase and a form phase.

### 7.1 Opening

On "Delete":
1. The dialog opens immediately in a loading phase (title "Delete Marie Dupont", `role="status"` "Checking which campaigns they own…").
2. `GET /api/admin/users/:id/owned-campaigns` returns `OwnedCampaignDto[]` (`campaignId, name, members[{userId, displayName, role}]`).
3. If the request fails: error in the alert region and a "Try again" button; nothing can be confirmed while the plan is unknown.
4. If the user owns no campaigns, skip the plan section: show just the consequence copy and the password field (7.4).
5. Always send `campaigns: []` for no owned campaigns; never trust the page's `ownedCampaignCount` for the payload (it can be stale; the server re-checks and 400s with `missing`).

### 7.2 Wireframe (owns campaigns)

```
+----------------------------------------------------------------+
| Delete Marie Dupont                                            |
|                                                                |
| This permanently deletes the account marie. It cannot be undone|
| Their notes and characters stay in the campaigns, shown as     |
| written by an unknown user. Their sessions and API tokens end. |
| Their open invites are revoked.                                |
|                                                                |
| Prefer to keep the account? Disabling it blocks sign-in and    |
| changes nothing else. [Disable instead]                        |   link-style button, closes this dialog and opens the Disable one
|                                                                |
| Marie Dupont owns 3 campaigns. Choose what happens to each.    |
|                                                                |
| Campaign: The Sunken Crown                                     |   <fieldset><legend>
|  (o) Transfer to  [ Anna Smit (co-DM)        v]                |
|  ( ) Archive      Keeps the campaign for its co-DM. See below. |
|                                                                |
| Campaign: Ashes of Karth                                       |
|  (o) Transfer to  [ Select a new owner       v]   <- no co-DM, several members, none preselected
|  ( ) Archive      Not available: no co-DM.                     |   aria-disabled radio + reason
|  (!) Choose who becomes the owner.                             |   shown only after a failed submit
|                                                                |
| Campaign: Solo Notes                                           |
|  Blocked. Marie Dupont is the only member, so the campaign     |
|  cannot be handed over or archived. Disable the account        |
|  instead, or ask Marie to invite someone and hand it over.     |
|                                                                |
| Confirm with your password   [ ****************** ]            |
| ...error...                         [Cancel] [Delete Marie Dupont]
+----------------------------------------------------------------+
```

### 7.3 Per-campaign rules and defaults (derived client-side from `members`, enforced again by the server)

For each campaign, let `candidates` = members other than the target (the target appears with role `dm`); `codms` = candidates with role `codm`.

| Case | Transfer | Archive | Default selection |
|---|---|---|---|
| `candidates` is empty (solo) | impossible | impossible | none; campaign is BLOCKED (7.4) |
| at least one `codm` | enabled, select lists all candidates, co-DMs first and labelled "(co-DM)" | enabled | **Transfer**, select preset to the first co-DM |
| no `codm`, one or more other members | enabled, select lists candidates with their role ("(player)") | disabled: "Not available: it has no co-DM, so nobody could open it afterwards." | **Transfer**, but the select has no preset (`Select a new owner`); the admin must pick (never silently hand a campaign to an arbitrary player). If exactly one candidate exists, preset it (one sensible answer). |

Every choice is explicit in the sense of D5: a radio is always checked for a transfer/archive-capable campaign, and the select must hold a real member before submit. The preselection satisfies "transfer pre-selected to a current member"; it does not satisfy "silent": the plan is visible on screen and the admin has to press the confirm button with the password.

Archive consequence copy (shown under the Archive radio when it is available, and again in the dialog's summary line when any campaign is set to archive). This is the STATUS note (archived campaign keeps its co-DMs and has no `dm` row):

> "Archiving keeps the campaign and its content for its co-DMs, but it will have no owner. Nobody will be able to change its members, roles or rules edition until a co-DM or an admin takes ownership again, and its owner-only actions stay unavailable. Choose Transfer if the campaign should stay fully manageable."

Whether "or an admin takes ownership again" is true is not defined by the server today; do not ship that clause unless it is. See open question 4. The safe wording without it: "...until the campaign is given a new owner." If no way to give an archived campaign a new owner exists, say so plainly: "There is currently no way to give an archived campaign an owner again." The Frontend Developer must verify which sentence is true before using this copy.

Members in the transfer select who are disabled users: the DTO carries no disabled flag (`members: {userId, displayName, role}`), so the UI cannot warn. See open question 3.

### 7.4 Blocked state

If any campaign is solo (no candidates):
- That campaign card shows the blocked text (wireframe) and has no radios.
- The Confirm button is `aria-disabled="true"`, `aria-describedby` pointing at a visible line directly above the buttons: "Delete is blocked by 1 campaign with no other member: Solo Notes. Disable the account instead." with the [Disable instead] button (the same one as near the top, repeated here so it is next to the blocked Confirm). The password field is still shown but disabled? No: leave it enabled and focusable (an aria-disabled Confirm with an enabled field is simply "not yet"), but never send a request.
- Initial focus goes to the "Disable instead" button in this case, the productive action, not to the password field.
- If some campaigns are fine and one is blocked, still show all the plans (so the admin sees the complete picture) but block submit.
- No server round trip is needed to learn this. The server would also refuse (400 on archive; transfer needs a member), so the client block is advice, not a boundary.

"Disable instead" closes the delete dialog and opens the Disable step-up dialog for the same user; focus return target stays the row's original Delete button's row.

### 7.5 Validation and messages

Validated on Confirm, all at once, before any request:
1. Every non-blocked campaign has a choice and, for Transfer, a selected member. Missing ones get an inline message under that campaign (`role` not needed; the group of messages is announced by the summary below): "Choose who becomes the owner of The Sunken Crown." Each campaign `fieldset` gets `aria-invalid="true"` on its select and `aria-describedby` to its message id.
2. A summary at the top of the form, in the alert region: "2 campaigns still need a choice: Ashes of Karth, Old Bones." Focus moves to the first incomplete select.
3. Password empty: as 5.4.

Messages mirroring the server (shown inline from a 400, under the matching campaign when `campaignId` is in the details, else in the summary):
- `Choose what happens to every campaign this user owns` (plan incomplete or stale; rebuild the plan from a fresh `owned-campaigns`, keep existing choices, say "The list of campaigns changed. Check the choices and confirm again.").
- `The new owner must be a member of the campaign`: "{Name} is no longer a member of {Campaign}. Choose someone else." and clear that select.
- `A campaign without a co-DM cannot be archived; transfer it, or disable the user instead`: switch that campaign to the Transfer radio and show the message.
- `Transfer to someone else` and duplicate-campaign errors cannot happen through this UI; show the server text if they do.

The confirm button text is the verb and target: "Delete Marie Dupont". Under it, after the plan is complete and before the password is typed, a one-line summary in muted text: "3 campaigns: 2 transferred, 1 archived."

### 7.6 Payload

```
POST /api/admin/users/:id/delete
{ currentPassword,
  campaigns: [ { campaignId, action: 'transfer', toUserId } | { campaignId, action: 'archive' } ] }   // exactly the owned set
```

Success is 204: close, status message "Marie Dupont was deleted. 2 campaigns were transferred and 1 archived." (counts from the plan that was sent), re-fetch the list, focus per 4.4.

### 7.7 What is NOT in the dialog

Q2 outcomes (shared homebrew sources go to the acting admin; private sources and templates stay ownerless) are one sentence in the body ("Homebrew sources they shared stay available and become yours; their private homebrew and templates become inaccessible."), not a separate choice. Confirm wording with the owner (open question 5).

## 8. Confirmations summary (destructive actions)

| Action | Confirmation the admin sees |
|---|---|
| Delete | The Delete dialog: consequence copy, per-campaign plan, "Disable instead", password, verb-and-name button. |
| Disable | Step-up dialog with consequence copy (4.2) and the owned-campaign count. |
| Reset link | Step-up dialog; result panel warns the link is shown once and grants takeover. |
| Remove admin / Make admin | Step-up dialog with the privilege sentence. |
| Enable | None, by design (accounts.md T10). Status message after. |

## 9. Cross-cutting states

| Situation | Behaviour |
|---|---|
| Admin rights lost while on the page | Any call returns 403 `Admins only`; show the "no longer an admin" view (5.4), then route to `/campaigns`. Header link disappears when `auth.user()` is refreshed (call `auth.refresh()` before navigating). |
| Admin removes their own admin flag | After success, `auth.refresh()`; the user is no longer admin, so navigate to `/campaigns` and set a message on arrival is overkill; the dialog already warned them. |
| Two admins act at once | Last-admin and stale-actor races are the server's job; the UI shows the 409/403 text and re-fetches. |
| Many users | No pagination (not requested; the server returns all). If the list exceeds roughly 100, add a text filter later; out of scope. |
| Dark mode | Only tokens listed in section 1; nothing hard-coded. Axe both themes (M2.7 precedent). |
| Reduced layout at 320px | The header reflow is a known deferred item (M6.3); the page body must not scroll horizontally at 320px: cards, wrapped buttons, `min-w-0` on the link input. |

## 10. M2.9 reset page, `/reset#<token>`

New `apps/web/src/app/auth/reset.ts`, `ResetPage`, route top-level (outside `authGuard`), layout copied from `auth/login.ts` / `auth/setup.ts` (centered card). The app header shows the signed-out variant (theme button only) when `auth.user()` is null; if someone else is signed in on this browser, the header shows them, see 10.5.

### 10.1 Token handling (normative)

1. On construct, read the fragment synchronously: `const token = location.hash.slice(1)` (decode nothing; the token is base64url so it needs no decoding).
2. Immediately, before any HTTP call and before the first render of the token anywhere: `history.replaceState(history.state, '', location.pathname + location.search)`. This removes `#<token>` from the address bar and the current history entry, so Back/forward/Share/history view do not hold it, and so a screenshot of the page has no token. The Angular router does not need to be told: `replaceState` with `history.state` unchanged keeps router state intact. Do not use `router.navigate` for this: it would add a navigation cycle and could re-trigger the component.
3. Keep the token only in a private field of the component (a plain `string`), not in a signal that is displayed, not in `localStorage`/`sessionStorage`, not in a URL parameter, not in the page title, not in console logs, not in error messages.
4. If the fragment is empty or fails a cheap shape check (43 base64url characters: `^[A-Za-z0-9_-]{43}$`; `randomBytes(32).toString('base64url')` is exactly 43), go straight to the invalid state without a request. Do the shape check client side only to avoid pointless requests; the server stays the authority and the message is identical.
5. A reload after the strip finds no token and shows the invalid state. That is acceptable and should be stated in copy ("This link can only be opened once in this window" is NOT said: instead the invalid text says what to do next). The admin simply issues a new link. (Alternative of keeping the token in `sessionStorage` to survive reload was rejected: it stores a live credential in the browser for convenience.)
6. `GET /api/auth/reset/${token}` (the token is in the path; accounts.md T5 notes API access logs). The same private token field is used for the POST. Do not log it. Both calls use the normal `HttpClient`; the interceptor's 401 redirect excludes `/api/auth/`, so a 404 stays on the page.

### 10.2 No-referrer and leakage concerns

- The fragment is never sent to a server and never in `Referer`. After `replaceState` it is not in `location.href` either, so anything that reads the URL later (extension, error reporter, `window.open`) sees `/reset`.
- The server already sets `Referrer-Policy: same-origin` (accounts.md T5). The page loads no third-party resources, and has no outgoing links except to `/login`; give that link `rel="noreferrer"` anyway, it costs nothing, and keep the page free of any `<a href="http...">`.
- Do not put `<title>` with the username. Route title is static "Reset password — Critical Notes".
- No `autofocus` that scrolls and no analytics; password managers get `autocomplete="new-password"` and a hidden username field with the account's username so they save the right entry.
- Chat apps and scanners prefetch only the HTML (the fragment is not sent), so they never hit the API; no extra handling.

### 10.3 States and wireframes

States: `checking` → `ready` | `invalid`; `ready` → `submitting` → `done`.

Checking (GET in flight, no content flash): card with `<p role="status">Checking your link…</p>`.

Ready:

```
+--------------------------------------------+
| Choose a new password                      |   h1
|                                            |
| For Marie Dupont (marie).                  |   displayName + username from ResetInfoDto
| This link works once and expires on        |
| 17 Oct 2026, 14:32.                        |   expiresAt, date:'medium'
|                                            |
| [hidden username field: marie]             |
| New password (at least 8 characters)       |
| [ ******************* ]                    |   autocomplete="new-password", minlength 8
| New password again                         |
| [ ******************* ]                    |
| (error, role="alert")                      |
|                                            |
| [ Set password and sign in ]               |   primary
+--------------------------------------------+
```

- It must be obvious whose account it is, because the link may have reached the wrong person: "For Marie Dupont (marie)." If that is not you, close this page. Do not offer a "not you?" action; there is nothing to do server side. Show a muted line: "Not your account? Close this page and tell the person who sent you the link."
- Field and error patterns are those of `changePassword` in `account-page.ts`: `passwordSchema.safeParse` for strength with the message "New password: At least 8 characters.", mismatch "The two passwords do not match.", `aria-invalid`/`aria-describedby="reset-error"`, focus the offending field, submit ignored while busy, button `aria-disabled` while busy with text "Setting password…".
- Order of client checks mirrors the server (accounts.md 4.1 step 6a): validate strength and match before the request; a weak password is a 400 and says nothing about the token.

Submit: `POST /api/auth/reset/${token}` with `{ newPassword }` (`redeemResetInput`, strict). Success is `{ ok: true }` with the session cookie set.

Done: call `auth.refresh()` (so the header and guards see the new session), then navigate to `/campaigns` with `router.navigateByUrl('/campaigns', { replaceUrl: true })` (replaceUrl so Back does not return to the reset page). Before navigating, set a message the next page can show? The campaign list has no such mechanism; keep it simple: the redirect is the confirmation. While `refresh()` runs the button stays busy; a `role="status"` says "Password set. Signing you in…". If `refresh()` fails, show "Your password was changed, but signing in failed. Sign in with your new password." with a link to `/login`.

Errors on POST:

| Response | Shown |
|---|---|
| 400 (weak/malformed) | The server's `issues` text via `errorMessage`, under the new-password field. Token still valid; stay in `ready`. |
| 404 uniform | Switch to the `invalid` state (not an inline error): the link died between GET and POST (used, expired, superseded, or the account was disabled). Clear the password fields. |
| 429 + Retry-After | `requestError()` text inline: "Too many attempts. Try again in 2 min." Stay in `ready`, keep fields (this is not a password problem). |
| network / 5xx | `errorMessage()`; stay in `ready`; "Nothing was changed" is not claimed. |

### 10.4 Uniform invalid state

Any of: no token, bad shape, GET 404 (unknown, expired, used, superseded, disabled user), POST 404. One screen, one message, no reason, no username, no hint which case it was:

```
+--------------------------------------------+
| This reset link is not valid               |   h1 (same text as the server's uniform 404 body)
|                                            |
| It may have been used already, or it may   |
| have expired or been replaced by a newer   |
| link. Ask the person who runs this server  |
| for a new one.                             |
|                                            |
| [ Go to sign in ]                          |
+--------------------------------------------+
```

- Focus moves to the h1 (`tabindex="-1"`) on entering this state so a screen reader announces it; `role="alert"` is not used for the whole card (it would be read twice with the h1).
- The sentence lists possible causes in a way that applies to every failure equally, so it leaks nothing (T2).
- 429 on the initial GET (the failed-lookup budget): the server cannot be told apart from invalid without the status. Treat it as its own small variant only for 429: "Too many attempts. Try again in N min." with a Retry button. A 429 reveals nothing about the token (budget counts failures from this client key), and showing "not valid" for a rate limit would send a person with a valid link to the admin for nothing.
- GET non-404 failures (network, 5xx): "We could not check this link. Try again." with a Retry button; the token stays in memory (it was already stripped from the URL), so Retry works without the fragment. This is why the token lives in the component field.

### 10.5 Someone is already signed in on this browser

The page is outside `authGuard`, so a different user may be signed in here (accounts.md 4.1 step 6d: the server also deletes the incoming cookie's session). In `ready`, if `auth.user()` is non-null, show an extra muted line: "You are signed in as Jan Baetens. Setting this password will sign you out and sign you in as Marie Dupont." No separate confirmation; it is informational and the primary button already says "Set password and sign in". `ensureLoaded()` is called in the constructor in a `try/catch` (the `anonymousGuard` pattern) just to know who is signed in; failure is ignored.

### 10.6 Accessibility

- One `h1` per state; `lang`/title static; labels visible; no placeholder-only labels.
- Errors via the always-present `role="alert"` wrapper; success via `role="status"`; busy state `aria-disabled` (not `disabled`).
- Password fields: no "show password" toggle in this iteration (not on the account page either; consistency).
- Tab order: new password, again, submit; hidden username field excluded (`tabindex="-1"`, `aria-hidden`).

## 11. Implementation notes for the Frontend Developer

Files (new): `apps/web/src/app/admin/admin.guard.ts`, `admin/users-page.ts` (list, cards, status/regions), `admin/step-up-dialog.ts`, `admin/user-rules.ts` (`rowRules`, `planDefaults` pure functions + specs), `auth/reset.ts`. Edited: `app.routes.ts` (two routes), `app.html` (one link), `core/http.interceptor.ts` (export `requestError`, remove the copy from `account-page.ts`).

Order: `user-rules.ts` + spec → `step-up-dialog` → page with Enable/Disable/Admin toggles → Reset link → Delete → M2.9 reset page.

Spec coverage (unit, next to components): `rowRules` (self, last admin, disabled, with and without owned campaigns); `planDefaults` (co-DM preselect, no-co-DM no preselect, solo blocked, single candidate); dialog focus return and Esc; copy fallback message; the reset page strips the fragment before the first request (assert `history.replaceState` was called before `HttpClient.get`), invalid shape makes no request, 404 on POST lands in the invalid state.

Test ids for Evidence Collector and M2.10: `data-testid` on the table, each row action, the dialog, the password field, the result link input.

## 12. Open questions for the Product Manager / owner

1. **Admin-on-admin copy.** The server treats all admins as equals (T22). Confirm the UI should do nothing more than name the target ("Marie Dupont is an admin.") in the dialog, with no extra typed confirmation for admin targets.
2. **Reset link for yourself.** The server allows it; this sketch disables the button with "Change your own password on the Account page." Confirm that is wanted (it also closes a path where a compromised admin session mints a link for its own account to survive a password change).
3. **Disabled members in the transfer list.** `OwnedCampaignDto.members` has no disabled flag, and the STATUS follow-up "reject transfer to a disabled member" is not done. Either the server rejects it (message needed) or the DTO gains `disabled: boolean` so the select can mark and exclude them. Which, and is it in scope for M2.8? Until decided the select can offer a disabled user as new owner.
4. **Archived campaign has no owner and the copy depends on a recovery path.** STATUS says an archived campaign keeps its co-DMs and has no `dm` row, so owner-only actions are dead. Is there (or will there be) a way to give it an owner again (a co-DM promoting themselves, an admin tool)? If not, the Archive copy must say there is none, and the owner may prefer to hide Archive altogether in favour of Transfer plus Disable. Decision needed before M2.8 ships the Archive radio.
5. **Homebrew sentence in the Delete dialog (Q2 outcome).** Is it acceptable to tell the admin "shared homebrew becomes yours; private homebrew and templates become inaccessible", and does anyone want a choice there instead?
6. **Admin list scale and sorting.** Sorted by display name, no pagination or filter. Fine for a self-hosted table group; confirm.
7. **Enable has no confirmation and no password** (server design). Confirm this is also wanted in the UI for a disabled admin (enabling a disabled admin restores their admin powers silently); the STATUS follow-up already asks "consider a password for enabling an admin target".
8. **After reset, where to land.** Sketch redirects to `/campaigns`. Confirm no "you were signed out elsewhere" notice is wanted on landing.
9. **`requestError` move** (shared 429 text) touches `account-page.ts` and its spec: confirm it can ride along with M2.8 rather than being a separate task.
