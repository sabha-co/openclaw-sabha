# Read-endpoint scale plan

A decision record for the read-shaped methods in `src/client.ts` (and the agent-visible verbs that surface them). Use this when adding a new read endpoint, reshaping an existing one, or pushing back on a feature request that would re-introduce an unbounded dump.

Scope: read-shaped methods only (`list*`, `get*`, `search*`). Write methods (`send*`, `create*`, `update*`, `delete*`, `archive*`, `add*`, `remove*`) don't have the cardinality concern and are out of scope. Drafted 2026‑04‑27 against `src/client.ts` HEAD = `8828a05`. Updated same-day to assume the server-side companion ([`sabha-co/sabha#49`](https://github.com/sabha-co/sabha/pull/49)) is merged — the bot is not yet in production, so the plan describes the target state directly without migration phasing or lockstep-coordination ceremony.

## Why this doc exists

We just removed `listGroupMembers` (commit `8828a05`) because the SDK signature `(groupId, limit)` could only ever be a paginated dump, never a search — and at Slack/Discord scale a 100k-member roster can't be enumerated through one agent call regardless of pagination. The dump *shape* was wrong, and the removal stopped the bleeding.

But the removal alone is incomplete: it closed the unbounded-dump door without opening a search-shaped one, and that left Sabha agents without a way to resolve "which Alex is in room 42?" — a question Slack and Discord agents *don't* need to ask only because their inbound payloads already carry pre-resolved identity (Slack mention payloads include `<@U123|alex>`; Discord has a stateful guild member cache). Sabha's inbound doesn't always — only `@{user_id}` curly-brace mentions are pre-resolved. So a Sabha agent acting on a free-form name reference has no way to disambiguate. That's a real regression, and this doc tracks closing it as part of the broader scale review.

The aspirational scale target is Slack/Discord — millions of users per workspace, hundreds of thousands of messages per channel, thousands of channels per bot. Choices made now under "Sabha is small" assumptions become silent footguns when the platform actually grows. The plugin's job is to expose primitives the agent can use *correctly* at that scale, not primitives that work in dev and explode in prod — and not primitives that are removed without replacement.

## The lens

For every read-shaped endpoint:

1. **Cardinality at 100×.** Multiply today's typical response size by 100. Does the wire response stay reasonable (< 1 MB)? Does the agent's context budget survive consuming it? Does any downstream component (LLM tokens, JSON parser, mention resolver) choke?
2. **Agent affordance.** Does the primitive answer the question the agent is *actually* asking? "Who's in #general?" rarely means "all 50k members." It usually means "is X here?", "how many?", "anyone matching pattern?" If the primitive forces the agent to dump-and-filter, the primitive is wrong.
3. **Server-side filtering.** Are `query`, `room_id`, `author_id`, `before`/`after`, `page`/`cursor` all supported on the wire? Each unsupported filter is a future REST round-trip the plugin will paper over with in-memory work that doesn't scale.
4. **Hard caps.** Does the server enforce a maximum response size regardless of caller? Without server-side caps, an agent that asks "all messages this year" gets exactly that.
5. **Peer comparison.** What do Slack/Discord/Mattermost expose for the same need? If they don't expose it (`listGroupMembers`), why don't they?
6. **"Is more available?" signal.** Can the response indicate truncation explicitly? If the agent gets 50 results and the next 5,000 are silently dropped, the agent will conclude the answer is complete when it isn't.

If a primitive fails any of (1)–(4), it's wrong-shaped — not "just needs pagination."

## Inventory

Eight read-shaped methods in `src/client.ts` as of `8828a05`:

| # | Method | Line | Wire route | Callers (non-test) |
|---|---|---|---|---|
| 1 | `getMessage(roomId, msgId)` | 168 | `GET /rooms/:id/messages/:id` | none |
| 2 | `getMessages(roomId)` | 175 | `GET /rooms/:id/messages` | none |
| 3 | `listRooms()` | 236 | `GET /rooms` | `directory.ts` (`listGroups`), `doctor.ts` |
| 4 | `listJoinableRooms()` | 241 | `GET /rooms?joinable=true` | `setup-wizard.ts`, `tools.ts` (`sabha_list_joinable_rooms`) |
| 5 | `listUsers({ roomId?, page?, perPage? })` | 321 | `GET /users[?room_id&page&per_page]` | `directory.ts` (`listPeers`) |
| 6 | `getUser(userId)` | 343 | `GET /users/:id` | `message-actions.ts` (`member-info`) |
| 7 | `searchUsers({ query?, roomId? })` | 356 | `GET /autocompletable/users[?query&room_id]` | `directory.ts` (`listPeersLive`) |
| 8 | `search(query)` | 383 | `GET /search?q=…` | `message-actions.ts` (`search`) |

Already designed for scale: 5–7 (the `listPeers` / `member-info` / `listPeersLive` trio shipped 2026.4.27). The cardinality risk is concentrated in 1–4 and 8.

## Per-endpoint verdicts

### 1. `getMessage(roomId, msgId)` — DELETE

**Status:** dead code. Zero callers in `src/`, `index.ts`, or tests.

**Lens:** would have been low-risk (single record, bounded). Removed because YAGNI — every cycle this method exists, someone might think it's part of the public contract.

**Action:** delete, along with its server route from the plugin's mental model. If a `getMessage` verb is ever needed (e.g., for a hypothetical `quote-message` action), reintroduce it with the right scope at that point.

### 2. `getMessages(roomId)` — DELETE

**Status:** dead code. Zero callers anywhere except a stale row in `docs/CHANNEL-PLUGIN-COMPARISON.md` ("hypothetical growth: `readMessages` would call this").

**Lens:** the hypothetical itself is the trap. `getMessages(roomId)` returns *every* message in the room with no pagination, no time bound, no limit. At Slack scale that's tens of thousands of messages per call. This is exactly the `listGroupMembers` shape — paginated dump with no agent-meaningful question.

**Action:** delete. Update the comparison doc's hypothetical-growth row to point at a *future* `readMessages({ roomId, since?, before?, limit })` shape — never the unbounded dump. The agent question "what was just said in this room?" needs a time-bounded recent-messages primitive, not a history dump.

### 3. `listRooms()` — RESHAPE

**Status:** live. Used by the directory adapter (`listSabhaDirectoryGroups`) and the doctor smoke test.

**Cardinality at 100×:** today's bots are in a handful of rooms; at Slack scale a bot can be in 1000+ rooms. The current implementation fetches all of them in one REST call.

**SDK contract:** `ChannelDirectoryListParams` already passes `query?: string | null` and `limit?: number | null`. The plugin currently ignores both at the wire level — fetches all rooms then in-memory filters and slices. That's the bug.

**Peer comparison:**
- **Slack** — `conversations.list({ types, exclude_archived, limit: 1000, cursor })` — cursor pagination, server-side `limit` cap of 1000. The plugin paginates internally up to its own ceiling.
- **Discord** — `GET /users/@me/guilds` returns up to 200 guilds (server cap); per-guild channel reads are separate calls.
- **Mattermost** — `GET /teams/:id/channels?page=&per_page=` — page-based pagination.

All three peers paginate at the wire level. Sabha is the outlier.

**Right shape:**
```ts
async listRooms(opts?: {
  query?: string;
  page?: number;
  perPage?: number;
}): Promise<SabhaRoom[]>
```

…with `/api/bots/rooms?query=&page=&per_page=` server-side. Mirror `listUsers` exactly. The directory wrapper paginates with the same `MAX_PAGES` cap pattern as `listSabhaDirectoryPeers`.

**Doctor probe note.** `src/doctor.ts:176-180` calls `listRooms()` and reports `"listRooms() returned ${rooms.length} rooms"` to the operator. After the reshape, an arg-less call returns only the first page. Update the probe message to reflect that ("first page returned N rooms" or similar) so the operator doesn't read it as a workspace-wide count.

**Server contract:** `/api/bots/rooms` accepts `?query=&page=&per_page=` (default 50, max 100). Bare-array response.

### 4. `listJoinableRooms()` — RESHAPE

**Status:** live. Used by the setup wizard (one-shot at install, small N) and the `sabha_list_joinable_rooms` agent tool.

**Cardinality at 100×:** the agent tool is the cardinality bomb. A workspace can have thousands of public rooms a bot could join; the current method dumps all of them into the agent's context.

**Peer comparison:**
- **Slack** — `conversations.list({ types: "public_channel", cursor })` — same paginated path as listed channels.
- **Discord** — no equivalent (bots join guilds via OAuth invite, not by enumeration).
- **Mattermost** — `GET /channels/?page=&per_page=&include_deleted=` paginated.

**Right shape:** merge into `listRooms({ joinable, query?, page?, perPage? })`. Fewer client methods, more parameters. The `joinable` flag becomes an explicit query param (`?joinable=true`), and pagination/query work uniformly. The `sabha_list_joinable_rooms` agent tool propagates `query`, `page`, `perPage` from its action params into the call.

**Server contract:** `joinable` is a filter alongside `query` / `page` / `per_page` on `/api/bots/rooms`.

### 5–7. `listUsers` / `getUser` / `searchUsers` — KEEP

Already designed correctly. Listed here for completeness and so contributors don't redesign them.

`listUsers`: server-side `?page=&per_page=&room_id=`, paginated by the directory wrapper up to `PEERS_MAX_PAGES = 100` × `PEERS_PAGE_SIZE = 100` = 10,000 ceiling. Hard cap is documented and tested.

`getUser`: single record. Low cardinality. Server returns 404 when bot can't see the user (= "not visible," not "doesn't exist") — caller treats accordingly in `message-actions.ts:103-106`.

`searchUsers`: `/autocompletable/users?query=&room_id=` is the right shape for autocomplete UX. Server returns ≤20 results regardless. The `room_id` param is wired into the client signature but not currently surfaced through any agent path — the directory `listPeersLive` slot has no `roomId` field in `ChannelDirectoryListParams`, so room scoping reaches the wire only through the agent-tool path described below in "Room-scoped member resolution."

These three are the template the rest of the read surface should converge on.

### 8. `search(query)` — MAJOR RESHAPE

**Status:** live. Used by `message-actions.ts` `search` action. **Highest-risk endpoint in the read surface.**

**Cardinality at 100×:** message search at Slack scale routinely returns tens of thousands of hits for common terms. Current shape:

```ts
async search(query: string): Promise<SabhaSearchResult[]>  // unbounded
```

No scoping, no limit, no pagination. The agent passes a query, the server presumably returns "everything matching" (or whatever the server-side default cutoff is — neither documented nor enforced from the plugin).

**Peer comparison:**

- **Slack** — `search.messages({ query, count, page, sort })` — paginated with hard `count` cap of 100/page. Server enforces.
- **Discord** — `search` action takes `{ query, channelId?, channelIds?, authorId?, authorIds?, limit }` (`extensions/discord/src/actions/handle-action.guild-admin.ts:389-407`). Forced scoping by channel and/or author. The `searchMessages` runtime call honors `limit`; server enforces a max.
- **Mattermost** — `POST /teams/:id/posts/search` — paginated, scoped to a team.

All peers force scoping or strict pagination. Sabha exposes a bare `query` string.

**Right shape:**

```ts
async search(opts: {
  query: string;
  roomId?: number;           // scope to one room
  roomIds?: number[];        // scope to multiple rooms
  authorId?: number;         // scope to one user
  before?: string;           // ISO timestamp or message id
  after?: string;
  limit?: number;            // default 50, hard cap 200
  page?: number;             // for follow-up pagination
}): Promise<{
  results: SabhaSearchResult[];
  hasMore: boolean;          // explicit truncation signal
}>
```

The `search` message-action surfaces the same params (minus `page`, which the agent typically doesn't drive — it asks "more?" semantically and we paginate under the hood). Server enforces the hard cap (200) regardless of what the client requests.

The `hasMore` boolean closes the silent-truncation gap: when the agent gets 50 results and there are 30,000 more, it knows to refine the query or scope. Without this signal, the agent confidently summarizes the visible 50 as if it were the complete answer.

**Server contract:** `/api/bots/search` accepts `?query=&room_ids=&author_ids=&before=&after=&limit=` (default 50, hard cap 200), returns `{ results, has_more, next_cursor: "<iso>|<id>" \| null }`, 422s on unparseable timestamps. Cursor-based, no `page` param.

**Wire format for array params:** `room_ids` and `author_ids` are sent as repeated keys (`?room_ids=1&room_ids=2&author_ids=7`), matching Rails' default array parsing. Not CSV, not JSON — repeated keys are the only form that round-trips cleanly through both `URLSearchParams` on the client and Rails' `ActionController::Parameters` on the server without a custom parser. The companion server PR follows the same convention.

## Room-scoped member resolution: the `listGroupMembers` gap

When `listGroupMembers` was removed, the *shape* was the right thing to drop (paginated dump, no `query`), but the *capability* — "given a room and a partial name, who matches?" — is genuinely needed and was not replaced. This section is the design for the replacement.

### The regression

A Sabha agent receives an inbound message that says "tag @alex on this." The agent has the `roomId` (from the inbound payload) and the string `"alex"`. To act on it (mention, DM, react, react), the agent needs `userId`. The current surface offers:

- **`listPeers`** — returns workspace-reachable users. Returns every Alex in every room the bot can see. Doesn't disambiguate by room.
- **`listPeersLive`** — same scope, just autocomplete-trimmed to ≤20. Same disambiguation problem.
- **`member-info(userId)`** — requires `userId` already known. Useless when starting from a name.

So the agent's only path is "fetch all reachable users, filter by name in-prompt, hope there's only one match, fail otherwise." That's a regression from the old `listGroupMembers` which at least returned a room-scoped list the agent could match against.

### Why peer parity was a misleading argument

The original removal rationale leaned on "Slack/Discord/Mattermost don't wire this slot either." That's true at the API level but misses the inbound asymmetry:

- **Slack.** Inbound mention payloads are `<@U123|alex>` — both id and human-readable name pre-resolved by Slack itself. The agent never starts from a bare name.
- **Discord.** The bot maintains a stateful guild member cache (populated by `GUILD_MEMBER_*` gateway events under the privileged `GUILD_MEMBERS` intent). Membership is *always present in memory*; "find Alex in this guild" is a JS Map lookup, not a REST call.
- **Mattermost.** Per-channel mentions in posts include the user object inline.
- **Sabha.** Inbound carries `@{user_id}` for explicit numeric mentions only. Free-form name references arrive as plain text. There is no gateway cache. The plugin must do active resolution.

Sabha's plugin needs a primitive Slack/Discord plugins don't, because Sabha's inbound doesn't pre-resolve what theirs do. Removing the slot to "match peers" without accounting for this asymmetry was the conceptual error.

### The right shape

The plugin owns this through **two complementary surfaces**, both already supported by the SDK without a fork:

**Surface 1: `resolver.resolveTargets`** — the canonical SDK slot for "name → id." Discord (`extensions/discord/src/channel.ts:423`), Slack (`extensions/slack/src/channel.ts:438`), and Telegram (`extensions/telegram/src/channel.ts:718`) all wire this. Sabha currently doesn't. Adding it brings Sabha to peer parity for workspace-level name resolution.

```ts
resolver: {
  resolveTargets: async ({ cfg, accountId, inputs, kind }) => {
    // For each input: parse as numeric id first; for name strings,
    // hit client.searchUsers({ query: name }) and map the top match.
    // kind: "group" → numeric id or scan listRooms() for name match.
  }
}
```

Wire path: `GET /api/bots/autocompletable/users?query=` (no `room_id`). Server caps at 20 — taking the top match (or the unique match if 1) is the standard pattern. Returns a `ChannelResolveResult[]` with `{ input, resolved, id, name, note }` per input.

**Surface 2: `sabha_member_search` agent tool** in `src/tools.ts` — for the room-scoped case the SDK can't model. `ChannelDirectoryListParams` has no `roomId` field, and `ChannelDirectoryListGroupMembersParams` has no `query`, so neither directory slot fits. CLAUDE.md's `tools.ts` policy admits "operations that have no cross-channel analog," and Sabha's room-scoped name disambiguation qualifies: peers don't need the verb because their inbound is pre-resolved (Slack mentions, Discord guild member cache, Mattermost inline user objects). The asymmetry is the analog gap.

```ts
build<AccountAwareParams & { roomId: number; query?: string }>({
  name: "sabha_member_search",
  label: "Find users by name in a Sabha room",
  description: "Search users in a specific Sabha room by partial name.",
  parameters: Type.Object({
    roomId: Type.Number({ description: "Room id to search within" }),
    query: Type.Optional(Type.String({ description: "Partial name match" })),
  }),
  execute: async ({ cfg, params, agentAccountId }) =>
    await getClientForTool(cfg, params, agentAccountId)
      .searchUsers({ roomId: params.roomId, query: params.query }),
})
```

Wire path: `GET /api/bots/autocompletable/users?room_id=&query=`. Already exists in `client.ts:356`, already capped at 20 server-side.

This pair passes the lens:

1. **Cardinality at 100×.** Both surfaces bounded at 20 server-side. Doesn't grow with workspace size.
2. **Agent affordance.** `resolveTargets` answers "who is Alex" at workspace scope; `sabha_member_search` answers "who matches X in this room" with explicit room context.
3. **Server-side filtering.** `query` (and `room_id` for the agent tool) enforced server-side.
4. **Hard cap.** Server-enforced 20 on both.
5. **Peer comparison.** `resolver.resolveTargets` is exactly the slot Discord/Slack/Telegram use. Room-scoped variant has no peer because peers don't need it — Sabha's plugin owns the verb its inbound asymmetry creates.
6. **"Is more available?" signal.** A 20-result cap is tight enough that "exactly 20 returned" is the implicit truncation signal; the agent refines query rather than paginates.

### Server-side prerequisites

**None.** `client.searchUsers({ query, roomId? })` already exists; the server endpoint already accepts both params and caps at 20. Purely plugin-side surface additions.

### Why not a `message`-tool action

This was the original design. It doesn't work: the SDK's `ChannelMessageActionName` is a closed union exported from `node_modules/openclaw/dist/plugin-sdk/src/channels/plugins/message-action-names.d.ts` (`CHANNEL_MESSAGE_ACTION_NAMES` — ~55 entries: `send`, `edit`, `react`, `member-info`, `search`, …). `"member-search"` is not in that list, and `SUPPORTED_ACTIONS: ReadonlySet<ChannelMessageActionName>` would refuse it at compile time. The earlier rationale that "a message-action lives entirely within the plugin and doesn't depend on SDK evolution" was wrong on this point — message-action names are SDK-gated the same way directory slots are.

The two surfaces above are SDK-blessed (`resolver.resolveTargets`) or fully plugin-owned (`tools.ts`), and zero SDK changes are required.

### Why not the `listGroupMembers` directory slot

`ChannelDirectoryListGroupMembersParams` is `{ groupId, limit }` — no `query` — which is the dump shape we removed in `8828a05`. Filtering would have to happen in-memory after a paginated dump, which is the lens-failure the slot was retired for. If a future SDK release adds `query` to that param shape, `sabha_member_search` collapses into a thin directory adapter at that point; until then, the agent tool is the right home.

## Server-side contract (assumed shipped)

The plugin plan assumes [`sabha-co/sabha#49`](https://github.com/sabha-co/sabha/pull/49) is merged. The relevant endpoints behave as:

1. **`/api/bots/rooms`** accepts `?query=&joinable=&page=&per_page=` (default 50, max 100). `joinable` is a filter, not a mode switch. Empty page = end signal. Response is a bare array of `SabhaRoom`.
2. **`/api/bots/search`** accepts `?query=&room_ids=&author_ids=&before=&after=&limit=` (default 50, hard cap 200). Response is `{ results: SabhaSearchResult[], has_more: bool, next_cursor: "<iso>|<id>" | null }`. Cursor pagination, no `page` param. 422 on unparseable timestamps.
3. **`/api/bots/autocompletable/users`** already accepts `?query=&room_id=` and caps at 20 (predates the scale review).

One follow-on still open server-side: **cursor pagination on `/api/bots/rooms`**. Not blocking — page-based works fine at expected room cardinality. Worth picking up if a workspace's room list grows past a few thousand.

## What's already done (and what's incomplete)

- ✅ **`listGroupMembers` regression closed.** Commit `8828a05` (2026.4.27) removed the dump-shaped slot. Commit `ebdafe3` (2026.4.28) wired the replacement: `resolver.resolveTargets` for workspace-level name → id (peer parity with Discord/Slack/Telegram) and `sabha_search_members` for the room-scoped case (the verb the SDK can't model). Both surfaces are SDK-compliant and required no SDK fork.
- ✅ **Step 1 — dead reads deleted.** `getMessage` / `getMessages` removed (`45c2766`). `SabhaMessage` type and stale `SabhaMember` import gone. Comparison doc no longer points future contributors at the unbounded dump.
- ✅ **Step 3 — `listRooms` reshaped** (`1bb5150`). Single method `{ joinable?, query?, page?, perPage? }`; `listJoinableRooms` retired with both call sites updated. Directory adapter paginates with `ROOMS_MAX_PAGES = 100` × `ROOMS_PAGE_SIZE = 100`. Server-side query replaces in-memory filter. Doctor probe rewritten as a reachability check (no longer reports a misleading workspace count).
- ✅ **Step 4 — `search` reshaped** (`0828285`). New shape `search({ query, roomIds, authorIds, before, after, limit, cursor })` returning `{ results, hasMore, nextCursor }`. Array params use repeated keys; CSV strings accepted at the message-action layer for agent ergonomics. Agent prompt now carries an explicit `SEARCH IN SABHA` hint covering the truncation signal and scoping params.
- ✅ **`listUsers` / `getUser` / `searchUsers` shipped correctly** (pre-existing). Server-side pagination, hard cap, scoped search. Template for the rest.
- ✅ **`message-actions` `member-info` action** (pre-existing). Single-record lookup with documented 404-as-"not-visible" semantics.
- ⏳ **Step 5 — cursor pagination on `/api/bots/rooms`** (open, non-blocking). Picks up if a workspace's room list grows past a few thousand. Page-based pagination is fine until then.

## Plan

The bot is not in production. The server-side companion is assumed merged. There is no migration to phase — the plan describes the target plugin state and the work units to land it. Order is independence-first (smallest, no dependents) but each unit can ship on its own.

### 1. Delete dead reads

`client.getMessage` and `client.getMessages` have zero callers. Remove both. Touch `docs/CHANNEL-PLUGIN-COMPARISON.md` to fix the hypothetical-growth row that currently references `getMessages` as the path for a future `readMessages` action — point it instead at a *future* `readMessages({ roomId, since?, before?, limit })` shape.

### 2. Wire name resolution (closes the `listGroupMembers` regression)

Two surfaces, both plugin-side, no SDK changes:

**2a. `resolver.resolveTargets`** in `src/channel.ts` — peer parity with Discord/Slack/Telegram.

- Add a `resolver: { resolveTargets }` block alongside the existing `directory:` block.
- For `kind: "user"`: parse each input as a numeric id first; for name inputs, call `client.searchUsers({ query: name })` and emit the top match as `{ input, resolved: true, id, name }`. Emit `{ input, resolved: false }` when nothing matches.
- For `kind: "group"`: parse numeric id directly, or scan `client.listRooms()` results (post-step-3 reshape, with the `query` arg) for a name match.
- Tests: numeric id passthrough, name → id, ambiguous match (note: "multiple matches; chose best"), no-match.

**2b. `sabha_member_search` agent tool** in `src/tools.ts` — room-scoped disambiguation, the case no SDK slot models.

- Register alongside `sabha_list_joinable_rooms` etc.
- Params: `roomId` (required), `query?`.
- Dispatch: `client.searchUsers({ roomId, query })`; return `SabhaUser[]`. Server caps at 20.
- `messageToolHints`: add a line — "to resolve a name within a specific room, call `sabha_member_search` with `roomId` + `query`. Returns ≤20 matches; refine if you get exactly 20."
- Tests: happy path, missing `roomId` (fails closed via tool param schema), 20-cap behavior.

Wire path (`/api/bots/autocompletable/users?query=&room_id=`) already exists and already caps at 20 for both surfaces.

### 3. Reshape `listRooms` / `listJoinableRooms`

- Collapse to one client method: `listRooms(opts?: { joinable?: boolean; query?: string; page?: number; perPage?: number }): Promise<SabhaRoom[]>`. `listJoinableRooms()` becomes `listRooms({ joinable: true })` — drop the convenience wrapper or keep it as a one-line shim. The actual callers to update are `setup-wizard.ts:148,291` (one-shot at install) and `tools.ts:143` (the `sabha_list_joinable_rooms` agent tool); doctor uses `listRooms` directly and is unaffected by this collapse.
- `listSabhaDirectoryGroups` propagates `query` / `limit` from the SDK params and paginates with a `MAX_PAGES` cap (mirror `listSabhaDirectoryPeers`).
- `sabha_list_joinable_rooms` agent tool accepts and propagates `query` / `page` / `perPage`.
- Tests mirror `listSabhaDirectoryPeers` pagination tests: short-page terminator, empty-page break, MAX_PAGES cap.

### 4. Reshape `search`

- Replace `search(query: string): Promise<SabhaSearchResult[]>` with `search(opts: { query: string; roomIds?: number[]; authorIds?: number[]; before?: string; after?: string; limit?: number; cursor?: string }): Promise<{ results: SabhaSearchResult[]; hasMore: boolean; nextCursor: string | null }>`.
- `message-actions.ts` `search` action surfaces the same params; agent receives `hasMore` and `nextCursor` in its tool response.
- `messageToolHints`: "search returns up to 200 results; pass `roomIds` / `authorIds` to scope, refine if `hasMore` is true, or pass `cursor` to continue."
- Tests: unscoped query (default ≤200), scoped queries, `hasMore` signal, cursor follow, composite cursor format (`<iso>|<id>`), hard-cap clamp.

### 5. (Open, non-blocking) `listRooms` cursor pagination

Once the server adds `?cursor=` on `/api/bots/rooms`, swap the page-based loop in `listSabhaDirectoryGroups` for cursor-based. Caller API stays the same. Useful only if a workspace's room list grows past a few thousand — page-based is fine until then.

## When to revisit this doc

- Adding a new `list*` / `get*` / `search*` method to `client.ts`. Apply the lens before merging.
- Reshaping an existing endpoint. Update the inventory table and the per-endpoint section.
- A peer plugin ships a pattern Sabha doesn't have (e.g., Discord adds a new search filter, Slack adds a new pagination idiom). Audit whether the peer's choice should land here.
- An incident in production where an unbounded read blew up the agent or the server. Update the lens with the new failure mode.

## References

- Commit `8828a05` — `listGroupMembers` removal narrative.
- `docs/CHANNEL-PLUGIN-COMPARISON.md` — broader architectural comparison; this doc is the read-surface zoom-in.
- `src/client.ts` — the methods this plan governs.
- `src/directory.ts` — the canonical paginated wrapper pattern (`listSabhaDirectoryPeers`).
- Peer code: `extensions/slack/src/runtime.list-channels.ts` (cursor pagination of `conversations.list`), `extensions/discord/src/actions/handle-action.guild-admin.ts:389-407` (forced scoping on `search`).
