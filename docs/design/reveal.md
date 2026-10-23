# Reveal to players: flow, event stream and threat note

Task N3.1 · Owner: Realtime Collaboration Engineer · QA: Security Architect · Reference: PRD §9 N3 · Date: 2026-10-23

Design only. Nothing here is implemented. Rule 4 of `docs/PROJECT.md` applies to every task that builds it
(sentinel tests in `apps/server/test/visibility.test.ts`, `pnpm -s typecheck && pnpm -s lint && pnpm -s test`,
`pnpm e2e` for UI). No schema change is needed: the event buffer is in memory (section 5), so no
`schema.ts` / `schema.pg.ts` work.

## 1. Consistency contract

| Thing | Model |
|---|---|
| Page content, visibility, `revealed` flags | Durable, in `app.sqlite`, written by the existing page save. The event stream never writes and never carries them. |
| Reveal events | A **hint**: "refetch this page, something you can see changed". Lossy by design. Dropping every event breaks nothing durable: the player sees the same state on the next page load. |
| What "revealed" means | The save committed. Events are emitted after commit, by the server, from a comparison of the stored old and new body or visibility. A client cannot send an event. |
| Delivery | At-most-once per connection, plus best-effort replay after a reconnect (section 5). Every event is idempotent: handling it means "GET the page again", so a duplicate or a replay is harmless. |
| Ordering | One server process, one in-memory bus: events leave in commit order. Clients do not rely on order, because each one just refetches. |

The server owns intent and ordering; the client only reacts. This is the same split the tracker uses, with one
difference: the tracker pushes state, this stream pushes **pointers**, because page content is large, is projected per
player, and must never travel anywhere except through the one projection code path.

## 2. The flow

```
DM clicks "Reveal now" / "Share now"            (N3.3, a normal page save: PATCH page)
   -> PageService.update commits
   -> PageService.onCommitted(change) -> RevealService: per-player detector (2.3) -> 0..n events { kind, pageId, blockIds?, audience }
   -> CampaignEventBus.publish(campaignId, event)
   -> for each open stream of that campaign: re-check "may this member see pageId right now?"  (sync, same tick)
        yes -> write the event       no -> write nothing (no placeholder, no gap)
   -> player's browser: GET the page (projected)  ->  toast + "New" badge + refresh the open page   (N3.4)
```

### 2.1 Events

| Event | Emitted when (server-side, after commit) | Payload (`data:` JSON) |
|---|---|---|
| `page-shared` | A page that a player could not see now is visible to them: visibility changed to `all`; changed to `selected` and the player was added to `viewers`; a new page created already shared. | `{"pageId":"…"}` |
| `block-revealed` | One or more blocks that were hidden from players in the old body are visible in the new body, on a page the player can see. | `{"pageId":"…","blockIds":["b…"]}` (at most 20 ids; more are cut, the page refetch covers them) |

Plus three **control** events with no campaign data: `hello` (first message on every connection: `{"replayed":true|false}`),
`ping` (heartbeat, empty), `resync` (`{}`: "I cannot replay what you missed, refetch what you show").

Not events, deliberately: edits to already-visible content, un-sharing, hiding a block again, deleting or
restoring pages, moving pages, character assignment. None is a table moment, and each is found by the next
refetch. (Q2 covers restore.) A player who loses sight of a page learns it the usual way: the
page is gone on the next fetch.

### 2.2 Where the hook lives (it does not exist yet)

`PageService` has no bus, no member list and no `VisibilityService` (it is built first in `createServices`, and
`VisibilityService` after it), so it must not publish itself. Instead:

- `PageService` gets an optional `onCommitted(change)` callback, set by `createServices` after the reveal service exists.
  `change = { campaignId, pageId, before, after }` where `before` and `after` hold `visibility`, the `viewers` ids,
  `deletedAt`, and the **stored, sanitized body** (the value written, not the request body; `sanitizeBody` runs first
  and also makes block ids unique within a document). `create` has no `before`.
- **Short-circuit:** if the stored body string and the visibility and viewers are unchanged, the callback returns at once
  (the tracker's hit-point write-back at `trackers.ts:154` and the edition migration's `pages.update` at
  `migration.ts:191` change facets, props and uid references, not reveal state, so they cost one string compare).
- **Only after the outermost commit.** `update` and `create` open their own `db.transaction`, and callers such as
  `templates.ts` and `migration.ts` wrap `pages.create` and `pages.update` in a larger transaction. A change made
  inside an outer transaction must not publish: neither better-sqlite3 nor drizzle has a commit hook, so there is an explicit
  mechanism. `PageService.batch(fn)` runs `fn` and collects every change made meanwhile into a queue. The code that owns the
  outer transaction calls `batch` around it (or calls `pages.flushCommitted()` right after its `db.transaction(...)` returns);
  the queue is delivered only then. If `fn` or the transaction throws, the queue is dropped and nothing is published, so no event
  describes a state that was not stored. Outside any batch, `update` and `create` deliver right after their own transaction.
  `templates.ts`, `migration.ts` and any other caller that wraps page writes in a transaction must use `batch` (N3.2 lists them; a test
  fails if a page write inside `db.transaction` bypasses it).
- **Bulk callers.** One batch produces at most one flush per campaign. Template instantiation (`templates.ts:573`, the
  root page, and `:602`, children created `dm`-only) can create many pages shared with everyone: after the batch, up to 3
  `page-shared` events go out; more than 3 collapse into a single `resync` for the players concerned, whose refetch
  finds the pages and shows one summary toast ("You have n new pages"). N shared child pages never fire N events.
- **Player edits** (`updateAsPlayer`) end in `this.update`, so they reach the callback too. The detector then finds nothing,
  because `mergePlayerEdit` keeps hidden blocks hidden and a player cannot change `revealed`, `visibility` or viewers.
  A test pins this (T9).
- **Everything else that writes pages** goes through the same two methods, so MCP and AI-token edits fire events too.

### 2.3 How the server decides (no client claim is trusted)

**`page-shared`:** audience = player members for whom `!canSee(before) && canSee(after)`, by the same rule as `visiblePageIds`, evaluated from the `before`/`after` visibility and viewers (the player's own assigned character counts as visible).

**`block-revealed`:** "hidden" is per player, not a property of the node. `droppedForPlayers` drops a node when
`isHiddenFromPlayers` is true **or** when its type's `project` hook returns null (for example a link or embed to a page the
player cannot see), and `isHiddenFromPlayers` alone is therefore not enough. So the detector works per candidate player:

1. Build the player context `ctx = { role: 'player', canSeePage: (id) => the player can see it in the after state }`.
   The same `ctx` is used for the old and the new body, so the comparison measures **only the body change**; a page that
   became visible in the same commit is `page-shared`'s business.
2. `H` = the **tops of hidden subtrees** in the old body: walk as `projectDoc` does; at each node, if
   `droppedForPlayers(node, ctx)` is true, record it and do **not** descend. A top may sit inside a visible container.
3. For each top in `H`, look in the new body for the same node: the same `attrs.id` **and** the same fingerprint. If it is
   found, reachable (not under a dropped ancestor) and not dropped for this `ctx`, it is newly visible to this player.
4. **Fingerprint** = the node's JSON with `attrs.revealed` and `attrs.visibility` stripped **recursively through every
   descendant**. Stripping `visibility` matters because the usual way a DM shows a block is switching `visibility` from
   `dm` to `all`; `revealed` is the other path. Both are ignored, so the compared content is the text, structure and other
   attributes only.
5. Matching is by multiset of `(id, fingerprint)` pairs, never by id alone. Block ids are not secret and not strong:
   the server assigns `b` + 6 random bytes (`newBlockId`), but the editor makes ids in the browser with `Math.random`
   (`block-editor.ts`), and API and MCP callers can supply any string. They are unique within one stored document (the
   sanitizer replaces duplicates) and that is all this design uses them for: to pair an old node with a new node in the
   **same page**. A client that reuses an id for different content gets no event (fingerprint differs); that is a missed
   hint, never a leak. Nothing relies on ids being unguessable, and the event only ever names ids the player already
   holds in their own projection.
6. A secret nested inside a still-hidden parent is not a top, and a reveal inside it flips nothing reachable: no event.
7. Revealing and editing the same block in one save changes the fingerprint, so no live event fires (the player gets it on
   the next load). Accepted; see Q1.

`block-revealed` audience = player members for whom `canSee(before) && canSee(after)` **and** at least one block became
newly visible to that member by the steps above. The `canSee(before)` condition means a commit that both shares the page
and reveals a block yields only `page-shared` (no double toast).

**Game masters** receive both events for every page. The delivery rule is `member is a game master now || member is in
the audience`, with the role read from the database at delivery. A player promoted to co-DM mid-stream starts receiving GM
events at once; a co-DM demoted to player stops, and on a replay the stored GM-flagged events are dropped for them unless
they pass the ordinary audience check and `canSee`.

**Noise control:** the detector only fires on a hidden-to-visible transition, so typing never emits. Coalescing is done
**after** filtering, per connection and per (page, kind): the first event goes out immediately (leading edge, so the 2 s toast
target is met); further ones within 1 s are merged (block ids united, capped at 20) and flushed once when the second
elapses.



### 2.4 Who gets a stream

`GET /api/campaigns/:cid/events`, any member (DM, co-DM, player). Players receive only what section 3 allows.

## 3. Per-player filtering

Filtering happens **at delivery, per connection, against current state**, not only when the event is created:

1. The bus stores each event with the audience computed at commit (the player members who gained sight) and a flag for
   "game masters".
2. When writing to a connection, the stream calls `campaigns.access(cid, userId)` (membership and current role). A game master
   gets the event. Anyone else must be in the audience **and** pass `VisibilityService.canSee(campaignId, viewer, pageId)`.
3. **`canSee` is a new method.** Only `visiblePageIds` exists today (it loads every live page, which would be one query
   of the whole campaign per event per connection). `canSee` answers for one page: the page row has this `campaignId` and
   `deletedAt IS NULL`, and then either `visibility = 'all'`, or `selected` with a `page_viewers` row for the user, or the
   page is a character assigned to the user (`character_facets.player_user_id`). It must give the same answer as
   `visiblePageIds(...).has(id)`; a property test over seeded pages asserts that. Cost: one or two indexed lookups per
   recipient connection per event, all synchronous; with a table of a handful of players this is negligible, and the per-user
   and per-campaign caps (section 6) bound it.
4. Everything in 2 and 3 is synchronous SQLite with no `await` between commit and check, so the answer cannot change under it.
5. Write only if allowed; otherwise write **nothing at all**: no empty event, no `id:` line, nothing a client could count.
6. `block-revealed` needs the page to be visible. A reveal on a page the player cannot see is silent; if the page is shared
   later, `page-shared` fires and the refetch shows the revealed blocks.

The same event id token goes to every recipient of an event. That is harmless: a token has no meaning outside the ring,
only the holder's own connection can use it, and players cannot compare streams without already sharing the information.

## 4. Wire format

```
GET /api/campaigns/:cid/events        Accept: text/event-stream     [Last-Event-ID: <token>]
200  Content-Type: text/event-stream; Cache-Control: no-store; X-Accel-Buffering: no

retry: 3000-6000 (random per connection, sent first)
event: hello
data: {"replayed":true}

id: 7c1e…(random)
event: page-shared
data: {"pageId":"01…"}

event: ping
data:
```

- **`id:` is an opaque random token** (16 random bytes, base64url), not a counter (reason in T2). Only
  `page-shared` and `block-revealed` carry an `id:`; control events do not, so they never move `Last-Event-ID`.
- Event names match the tracker's style (`state`, `ping`). The heartbeat constant `HEARTBEAT_MS` is a non-exported
  `const` inside `routes/play.ts`, so N3.2 first extracts a small shared `lib/sse.ts` (headers, heartbeat, abort cleanup,
  bounded write queue) that both the tracker route and this route use.
- Payload keys are fixed; the zod schema for the payload lives in `@cn/shared` and the web app validates it. Anything
  that does not parse is ignored.
- **Compression:** none. `app.ts` already skips `compress()` for any `/api/*` path that ends in `/events`, and the new
  route ends in `/events`. N3.2 adds a test that the response has no `Content-Encoding` even with
  `Accept-Encoding: gzip`, so a future rename cannot silently break it.

## 5. Reconnect, replay, heartbeat

**The client does not use the native `EventSource` for this stream.** Native `EventSource` has two properties that break the
requirements: on any non-200 response (a 502 or 503 from the proxy during a deploy, or our own 429/503) it fails
permanently and never retries, and a *new* `EventSource` object cannot send `Last-Event-ID`. The client therefore uses
`fetch()` with a streamed body and a small SSE line parser (same origin, so the cookie is sent; no token in the URL):

- It sends `Last-Event-ID` itself, from the last `id:` it saw.
- It treats any failure (network error, non-200, stream end, no frame or `ping` for 60 s) the same way: close, wait
  with **exponential backoff with full jitter** (1 s doubling to 30 s, reset after a stable minute; honours `Retry-After`
  and the server's `retry:` as a floor), reconnect.
- **One client rule: after every reconnect, refetch what is on screen** (the open page and the page tree), whatever `hello`
  says. Replayed events add the toasts for what was missed; any page found new by the refetch diff that was not already
  toasted gets one summary toast. `hello.replayed` therefore only decides whether the summary toast is needed. The first
  connect is the same code with an empty "known pages" set and no toast.
- It does not reconnect after `event: bye` with `reason: "evicted"` (section 6): the tab shows "Live updates paused in
  this tab" with a Resume button.

**Server buffer:** per campaign, an in-memory ring of the last 200 events or 10 minutes, whichever is smaller. Each entry:
token, event, audience, GM flag. A `Last-Event-ID` is looked up only among tokens that were delivered to (or addressed to) this user; any other token is treated as unknown. It is **lost on a restart** (the README says so); that is fine, because a missing token
gives `hello {replayed:false}` plus `resync` and the client refetches anyway. The ring is server-internal: its size
is never observable by a player, so it adds no volume leak.

| Reconnect case | Server does | Client does |
|---|---|---|
| `Last-Event-ID` is in the ring | `hello {replayed:true}`, then each later event this member may still receive (section 3 re-check at replay time) | Refetch, handle replayed events as normal toasts. |
| No `Last-Event-ID` (first connect) | `hello {replayed:false}` | Fetch page and tree. |
| Id unknown or expired, or restarted | `hello {replayed:false}` then `resync {}` | Refetch; one summary toast for new pages. |
| Replay would exceed 50 events | same as unknown | same |

**Deploys and shutdown.** `lib/shutdown.ts` stops accepting connections, closes idle keep-alive connections, and cuts
every remaining connection after `HTTP_DRAIN_MS` = 2 s; the 15 s compose `stop_grace_period` is only the outer
limit, not a drain window for streams. An SSE connection is never idle, so without help it is simply cut after 2 s.
Therefore the events route **registers with shutdown**: N3.2 adds a `closeStreams()` dependency to `ShutdownDeps`
that is called first, writes `event: bye` `data: {"reason":"restart"}` to every stream and ends it. Clients then reconnect
with jitter (above) to the new process, which has an empty ring, and refetch. The reconnect spread comes from the client's
full-jitter backoff plus the server's random `retry:` floor; players' refetches are further jittered 0 to 300 ms.

**Heartbeat:** `ping` every 25 s under the usual 60 s proxy idle timeouts. On every tick the server also **re-validates
the connection** (section 7) and closes it if the session is gone, the user is disabled, or the membership ended. The
README's reverse-proxy note must mention `proxy_buffering off` and a read timeout above 60 s.

**Last resort fallback:** if the stream cannot be kept open (repeated failures for more than 2 minutes), the client keeps
retrying slowly at the 30 s cap and also refetches the page tree on window focus and every 60 s, silently. Live toasts
degrade to "found on next poll"; nothing else changes.

## 6. Limits and processes

- **Per user:** at most 6 open streams (tabs and devices) in total. A 7th **evicts the oldest** of that user's streams, which
  is sent `event: bye` `{"reason":"evicted"}` and closed, and the client of an evicted tab shows "Live updates paused in this
  tab" with a Resume button (no automatic reconnect, so two over-limit tabs cannot evict each other forever). A 429 would
  strand the newest tab, which is the one the player is looking at.
- **Per campaign:** `EVENTS_MAX_PER_CAMPAIGN`, default 100. **Global:** `EVENTS_MAX_CONNECTIONS`, default 500. Over a
  cap: `503` with `Retry-After`; the fetch-based client backs off and retries (it is not stuck, unlike `EventSource`). Both are
  documented in the README. A Node process holds thousands of idle sockets; the caps protect file descriptors, memory
  and the per-event `canSee` fan-out, not CPU.
- **Backpressure:** each connection has a queue of at most 50 pending writes (events are about 100 bytes). On overflow
  the server drops that connection; the client reconnects and refetches. The server never buffers a slow consumer
  without bound. (The tracker's `void stream.writeSSE(...)` has no bound; do not copy that part into `lib/sse.ts`.)
- **Cleanup:** `stream.onAbort` unsubscribes, clears the heartbeat timer and frees the slot, as the tracker does.
  A test opens and aborts 100 streams and asserts the subscriber count returns to 0.
- **Single process:** the bus is an in-memory `Map<campaignId, Set<Connection>>` behind a small interface
  (`publish(campaignId, event)`, `subscribe(campaignId, listener)`), so it works exactly as far as the app does:
  SQLite with one server process, which is what the shipped compose file runs. **If two server processes share
  one database, an edit handled by process A never reaches streams held by process B**: no error, just no live
  toasts for the players on B. Reading is still correct, since pages come from the database. The README notes this
  next to the "one process" statement. N14 (Postgres, several processes) replaces the bus implementation with a
  backplane (Postgres `LISTEN/NOTIFY` or Redis); the interface and the payloads do not change, and the ring would move
  to a shared store. Until then, do not build for it.
- **Writes outside the process** (`admin.mjs restore`, edits to the database file) emit nothing. Restore signs
  everyone out anyway.
- **Existing gap, backlog (not N3):** the tracker's event stream calls `campaigns.access` only when the connection opens, so
  a member who is removed or disabled keeps receiving tracker states until they disconnect. The shared `lib/sse.ts`
  should give both routes the heartbeat re-validation of section 7; file this as a separate backlog item.

## 7. Authentication and authorization

- **Cookie session only.** The stream is a GET from the same origin, so the browser sends the session cookie.
  Route uses `requireUser`, then `campaigns.access(cid, userId)`: a non-member gets the same 404 as every other
  campaign route, so campaign ids do not leak. API tokens (`tokenScope` set) get 403, as on the token and admin
  routes: the MCP endpoint has no use for a push stream, and tokens stay off it.
- **No query-string credentials.** There is no `?token=`; URLs end in logs and `Referer`.
- **No CORS headers.** Another origin cannot read it; `SameSite=Lax` cookies are not sent on a cross-site `fetch` or `EventSource`.
- **The authenticated state is re-checked, not assumed.** A stream can live for hours. On every heartbeat and every
  delivery the server verifies: the session row (read by the id stored at connect time) exists and is unexpired, the
  user is not disabled, the member still belongs to the campaign. Failure closes the connection (logout,
  disable, "remove member", leaving, restore). Latency is the heartbeat interval at worst (25 s). The check is a plain
  read of the `sessions` and `users` rows; unlike the request middleware it **never extends the session expiry**, so an
  open stream does not keep a session alive. Only the connect request (which passes the normal middleware) can renew it.
- **Role changes** (player promoted to co-DM, or demoted) take effect at the next delivery, because the role is read
  from the database then; the connection is not trusted with a role captured at connect time.

## 8. Threat note: the stream leaks nothing a player cannot already fetch

**Claim.** For any member and any moment, everything the stream tells them is a function of facts they could already read
through the projected API at that moment. Let `V` be the set of pages the member can fetch. The stream reveals, at
most, "page `p` in `V` changed in a way they can see".

**What an event contains:** `kind`, a page id (always one in `V` at delivery time), up to 20 block ids that exist in
the member's own projection of that page, and an opaque token. No title, text, type, tag, author, count, timestamp,
or visibility value. Control events carry only a boolean.

| # | Threat | Verdict and why |
|---|---|---|
| T1 | **Content in the event** (title, excerpt, secret text) | Not possible: the payload schema has no such field, and the web app's strict zod parse ignores extras. The title shown in a toast comes from the player's own authorized fetch (N3.4), never from the event. |
| T2 | **Existence/count/timing of hidden pages via gaps** (a global counter as `id:`, so ids `41, 43` tell a player that a hidden event happened) | **Closed:** `id:` values are random tokens. There is no sequence to count and no gap. Delivery is skipped entirely for non-audience members: no empty frame, no comment line. Heartbeats are identical for everyone, on a fixed timer not tied to events. |
| T3 | **Timing of DM activity** (the DM edits secrets all night; does the player see traffic?) | Edits to hidden things emit nothing to anyone but game masters. A player sees traffic only when something becomes visible to them, which is also when it becomes fetchable. |
| T4 | **Page id of a hidden page** | Only ids in `V` are ever sent. Ids are UUIDv7 (time-ordered), which would give a creation time, but a page in `V` already gives that through the API. The sentinel crawl asserts that **hidden page ids** appear nowhere in the stream, which is stronger than the usual sentinel strings. |
| T5 | **Revoke after the event** (visibility removed after the event was written, or the DM re-hides the block, or removes the player) | (a) The event only said "refetch". The refetch goes through the normal projection; a revoked page answers 404, the same as a page that never existed, so the toast code, which fires only after a successful fetch, shows nothing. (b) If the toast already showed, the player had legitimate access at that moment; revoking cannot un-read it, same as for any page. (c) A re-hidden block is simply absent from the refetch; the "New" highlight is computed from the fetched document, so it cannot point at a removed block. (d) **Replay** re-runs section 3 at replay time, so an event from before a revoke is not replayed to someone who can no longer see the page. (e) A removed member or disabled user is dropped within one heartbeat and at their next delivery. |
| T6 | **Reveal then immediate un-reveal race** | Both are normal saves. The refetch shows whichever state is current; no stale content exists in the event. |
| T7 | **Cross-campaign leakage** | A connection is bound to the campaign in the path after `access()`. The bus is keyed by campaign id; a publish never touches another campaign's set. Test with two campaigns. |
| T8 | **Existence probing** (non-member, or member probing campaigns) | Non-member: 404, identical to a missing campaign. The stream URL has no other parameters. |
| T9 | **Forged events** (a player tries to publish) | There is no publish endpoint. Events come from server code after a committed save by an authorized writer. A player's own edit of their character page can reveal nothing to anyone, because `mergePlayerEdit` keeps the DM's hidden blocks hidden and players cannot change `revealed`. Add a test for that. |
| T10 | **Role confusion** (a player receives game master events) | Role is read at delivery. A test connects as player and as co-DM to the same campaign and compares streams. |
| T11 | **Resource abuse** | Section 6: per-user and global caps, bounded queue, heartbeat validation. Reconnect loops cost a session lookup each; the existing rate limit style (`lib/rate-limit.ts`) is not used because legitimate reconnects after a deploy are bursty; the per-user, per-campaign and global caps are the guard. |
| T12 | **Session fixation / long-lived stream after logout** | Re-validation per heartbeat (section 7); the stream cannot outlive its session by more than 25 s. |
| T13 | **Via an MCP edit** | MCP tools call `PageService.update` through the internal app; the detector runs there, so events fire. MCP read tools never see the stream. |
| T14 | **Fallback poller** | It fetches the already-projected tree, not a new surface. |

**Residual, accepted:** (1) A player who is a legitimate audience of a `page-shared` learns the moment it was shared;
that is the feature. (2) A player's network observer sees that a connection is open and that frames arrive at
intervals; they learn "something became visible to this user", which the user is entitled to know. (3) Over plain
HTTP (no TLS), content in the stream and the cookie are as exposed as everything else; deployments terminate TLS
(already the README's guidance).

**Tests required by N3.2/N3.5 (acceptance for this note):**
1. Sentinel crawl: seed hidden pages with SENTINEL titles/bodies, DM-only blocks, unrevealed secrets and `selected`
   pages for another player; connect as player A; perform every kind of write; read the stream for 3 s; assert no
   SENTINEL string, no hidden page id, no `id:` for anything A cannot see, and the exact expected events for what A can.
2. Revoke: share, receive event, un-share, refetch gives 404; reconnect with the old `Last-Event-ID` does not replay it.
3. Membership: remove the member while connected; the stream closes within one heartbeat (use a short test interval).
4. Replay: kill the socket mid-flow; reconnect with `Last-Event-ID`; the missed event arrives once; unknown id gets `resync`.
5. Role: player vs co-DM streams; API token gets 403; a stranger gets 404; no `Content-Encoding`.
6. Limits: 7th stream from one user evicts the oldest (which receives `bye` and does not reconnect); the per-campaign cap gives 503; a 503 from a proxy is retried with backoff; 100 aborted streams free all subscribers; a stalled reader gets dropped at 50 pending writes with bounded memory.
7. Latency (N3.5): DM saves reveal, player's browser shows the toast under 2 s.

## 9. What the player sees at the table (Narrative Designer's draft)

Principle: the table moment is the DM saying "you find a letter". The app's job is to be the letter on the table, not a
notification centre. It must arrive when the DM says it, be impossible to miss, and say nothing that is not already on
the page. **No spoilers:** never an excerpt, never "a secret", never a count of what remains hidden, never the word
"hidden" or "DM-only".

### 9.1 Toasts

| Situation | Toast text | Action |
|---|---|---|
| Handout/page shared with the whole party | **New: {page title}** | `Open` |
| Page shared with this player only (`selected`) | **Just for you: {page title}** | `Open` |
| Block revealed on the page the player is reading | **New details on this page** | `Show` (scrolls to the first new block) |
| Block revealed on a page the player is not reading | **New on {page title}** | `Open` |
| Several in 3 seconds | **{n} new things: {first title} and {n-1} more** | `View` (opens a small list) |
| After a resync | **You have {n} new pages** (never per page) | `View` |

Rules: sentence case, no exclamation marks, no emoji, no second-person drama ("You found a secret!" says too much and
spoils the DM's own telling). The title is rendered as plain text (rule 4, no raw HTML) and truncated to about 40
characters. The toast appears only after the fetch for that page succeeded (T5). Visible for 8 s, pauses on hover and
focus, `Esc` dismisses, role `status` with `aria-live="polite"`, no sound, no focus steal, respects
`prefers-reduced-motion`. It never covers the reading area on a phone (bottom sheet above the tab bar).

### 9.2 "New" badge

- A small **New** pill beside the page in the tree and the header of the page; on a revealed block, a thin accent edge
  plus the same pill at its corner. Text and shape, not colour alone (colour-blind safe, contrast-checked).
- A page badge clears when the page has been open and visible for 2 seconds. A block highlight clears when the block has
  scrolled into view for 2 seconds (an `IntersectionObserver`), or on the next navigation. The badge never blocks
  reading and never moves the page: no auto-scroll (that yanks a player out of a sentence), only the `Show` button does.
- The open page refreshes the new block in place (a 300 ms fade, none under reduced motion). If the player is mid-edit
  on their own character page, the refresh waits and the toast says `New details on this page` with a `Reload`
  button, so their unsaved text is never overwritten.
- Badge state is in memory plus `sessionStorage` per campaign: it survives a reload during the session but is not a
  "what's new since last visit" feature. That belongs to N2.

### 9.3 For the DM (N3.3 hint)

The click answers with a quiet "Revealed" or "Shared" confirmation on the button itself. It does not say how many
players saw it (the stream deliberately does not expose that), and has an Undo that re-hides in one click (a normal save).

## 10. Decisions and open questions

**Owner decisions needed**

- **Q1. Explicit reveal route or inference?** Recommendation: **infer from saves** (sections 2.2 and 2.3) and add no route.
  Reasons: inference covers every writer (the DM's "Reveal now" click is an ordinary save, co-DMs, and MCP/AI tokens,
  which can already change `revealed` and `visibility` through the existing update tools), so one detector protects all
  paths; an explicit `POST .../reveal` would be a second path that must be kept equal to the first. Cost accepted: the
  "reveal and edit the same block in one save" gap (2.3, step 7), which the DM's one-click UI cannot produce. If an
  explicit route is added later it must stay **off the MCP allowlist** (AI assistants keep using page updates, which
  fire the same events) and must itself only write a normal save. Owner confirms.
- **Q4. Numbers.** Ring 200 events or 10 minutes; 6 streams per user (evict oldest), 100 per campaign, 500 global; backoff
  1 s to 30 s with full jitter; heartbeat 25 s; coalescing window 1 s. Proposals, to be confirmed or changed.

**Accepted recommendations**

- **Q2.** Restoring a trashed page or reassigning a character does not emit `page-shared` in 1.3.
- **Q3.** The "New" badge does not persist across visits (that is N2).
- **Q5.** Game masters use the same endpoint; no separate view parameter.

**Follow-ups**

- Tracker stream re-validation (section 6, backlog).
- Page-save notes for N3.2: add `canSee`, `onCommitted`, `lib/sse.ts`, `closeStreams` in shutdown, the batch/flush rule,
  and the per-player detector with the multiset matching and the recursive fingerprint.
