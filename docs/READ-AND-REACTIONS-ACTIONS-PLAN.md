# Plan: `read` and `reactions` message actions

A decision record for the next plugin-side change set: wiring the agent-facing `read` and `reactions` actions on top of the bot API endpoints that landed via [`sabha-co/sabha#50`](https://github.com/sabha-co/sabha/pull/50). Companion to [`READ-ENDPOINT-SCALE-PLAN.md`](READ-ENDPOINT-SCALE-PLAN.md), which set the scale-aware bar that `client.search` and the room/user listings already meet on `main`.

Drafted 2026-04-28 against `main` HEAD = `c4c93be` (Scale-shape the read endpoints — #13). A v1 of this plan was written against `d5d4027` (the pre-#13 commit) and discarded — many of its claims about `client.search` being bare-string and `describeMessageTool.schema` being empty were wrong against current `main`. This v2 redrafts on the post-#13 baseline.

## Status

| Piece | State |
|---|---|
| Server endpoint `GET /rooms/:id/messages` (envelope, `after`/`before`/`limit`, cursor) | Shipped (`sabha-co/sabha#50`) |
| Server endpoint `GET /rooms/:id/messages/:msg_id/boosts` (aggregated reactions) | Shipped (`sabha-co/sabha#50`) |
| Plugin `read` action | This plan |
| Plugin `reactions` action | This plan |
| Latent `client.search` cursor bug (server-side concern only reads `before`) | Drive-by fix |

## Goals

Two new actions on the shared `message` tool, peer-parity with Slack and Discord:

- **`read`** — fetch time-bounded room history. Unblocks "what did we discuss?", "summarize this thread", time-bounded context reconstruction.
- **`reactions`** — read aggregated reactions on a message. Unblocks "who agreed?", boost-driven approval flows, sentiment-aware agents.

Plus a one-line correction to `client.search`'s cursor wire mapping that's a real bug today (see §2c).

## Grounding

### Server wire shapes (shipped)

```
GET /api/bots/rooms/:id/messages?before=&after=&limit=

→ {
    results: [
      {
        id: number,
        creator: { id: number, name: string },
        body: { html: string, plain: string },
        attachment: null | { url, filename, content_type, byte_size },
        created_at: string  // ISO 8601
      },
      ...
    ],
    has_more: boolean,
    next_cursor: "<iso>|<id>" | null
  }
```

`before` is **dual-purpose**: plain ISO timestamp = filter; composite `<iso>|<id>` = cursor. The server has no separate `cursor` URL param — cursor walks pass the composite token via `before`. Verified against `app/controllers/concerns/cursor_paginated.rb` (used unchanged by both `MessagesController#index` and `SearchesController#show`). Newest-first ordering (`reorder(created_at: :desc, id: :desc)`). Default `limit=50`, max `200` (`MAX_LIMIT` in the concern).

```
GET /api/bots/rooms/:id/messages/:msg_id/boosts

→ {
    reactions: [
      {
        content: string,                                   // emoji ≤16 chars
        count: number,                                     // total boosts of this content
        boosters: [ { id: number, name: string }, ... ],   // capped at 100
        truncated: boolean                                 // boosters cap hit
      },
      ...
    ],
    total: number,                                         // sum across all reactions
    truncated: boolean                                     // reactions cap hit (>50 distinct emoji)
  }
```

Reactions sorted by `count DESC, MIN(created_at) ASC` (`message.rb#boost_summary`). Boosters within a reaction sorted oldest-first ("who started this 🚀?"). 404 on room-not-visible OR message-not-found OR soft-deleted message — same fail-soft semantics as `member-info`. Server scopes through `Current.user.rooms.find` + `messages.active`, so the 404 collapses three distinct failure modes into one wire response.

**Failure modes worth knowing:**

- **Malformed `before`/`after` → 422 `validation_failed`.** `parse_pagination_params` (`controllers/concerns/cursor_paginated.rb:14-17`) renders `{ error, code: "validation_failed" }` if the timestamp doesn't parse or the composite cursor's id portion isn't an integer. `SabhaClient.fetch` will surface it verbatim as `SabhaApiError(422, body, url)`.
- **Trailing-pipe cursor** (`"2026-01-01T00:00:00Z|"`) parses as `[time, nil]` and silently falls into the *filter* branch (`created_before`), not the cursor branch. Irrelevant in practice since `next_cursor` always includes the id.
- **`messages.active` only.** Both `messages#index` and `boosts#set_room_and_message` filter on the `active` scope, so soft-deleted messages are invisible to the bot API. `read` cannot retrieve a deleted message, and `reactions` on a deleted message returns 404 — same wire shape as a never-existed message id.

### Plugin patterns to mirror (post-#13)

- **`client.search`** (`src/client.ts:410`) is the closest model for `client.readMessages`: same `URLSearchParams` build, same envelope `{ results, hasMore, nextCursor }`, same `parseSearchResponse` runtime guard pattern. Mirror its shape exactly so the two methods are visually paired in the file.
- **`parseSearchResponse`** (`src/client.ts:496`) is the model for `parseReadMessagesResponse` / `parseReactionsResponse`. It does a top-level structural check (verify `results` is an array and `has_more` is a boolean) and trusts array element shape. The new guards should match this stance — don't tighten only the new ones; consistency in the file beats the marginal defense from per-element validation, and a separate code-quality PR can revisit both pre-existing and new together.
- **Param helpers** in `src/message-actions.ts:57-128`: `readString`, `readNumber`, `readNumberArray` (CSV-or-array tolerant), `readNumberList` (merges plural and singular keys). Existing `search` handler reads canonical scoping fields via `readNumberList(params, ["channelIds", "channel_ids", "roomIds", "room_ids"], ["channelId", "channel_id", "roomId", "room_id"])`.
- **Schema contribution** in `src/channel.ts:227-263` already publishes `before`/`after`/`limit`/`cursor` as Sabha-specific extras (the canonical scoping fields `channelId`/`channelIds`/`authorId`/`authorIds` come from core's `buildChannelTargetSchema`). The same four fields apply unchanged to `read`. We do not add a new schema fragment — we broaden the existing field descriptions to mention both `search` and `read`.

## Implementation

### 1. `src/types.ts` — response types

```ts
export type SabhaReadMessage = {
  id: number;
  creator: { id: number; name: string };
  body: SabhaMessageBody;
  attachment: SabhaAttachment | null;
  created_at: string;
};

export type SabhaReadMessagesResponse = {
  results: SabhaReadMessage[];
  hasMore: boolean;
  nextCursor: string | null;
};

export type SabhaReaction = {
  content: string;
  count: number;
  boosters: { id: number; name: string }[];
  truncated: boolean;
};

export type SabhaReactionsResponse = {
  reactions: SabhaReaction[];
  total: number;
  truncated: boolean;
};
```

`SabhaReadMessage` reflects the `index` shape (no `mentionees`, no `has_attachment`). If a future caller needs `mentionees` it should hit `show` (single record, bounded N+1) — but `show` itself was deleted from `client.ts` in #13 (`getMessage` / `getMessages` were dump-shaped dead methods). Re-introducing a single-message fetcher is out of scope here; if needed, do it in its own PR with a real caller.

### 2. `src/client.ts` — three changes

**a. New `readMessages(opts)`:**

```ts
async readMessages(opts: {
  roomId: number;
  before?: string;   // ISO timestamp filter OR composite cursor token (server is dual-purpose)
  after?: string;
  limit?: number;
  cursor?: string;   // explicit cursor field for caller clarity
}): Promise<SabhaReadMessagesResponse> {
  const params = new URLSearchParams();
  // Wire's `before` is dual-purpose. If both are passed, prefer `cursor`
  // (agent intent is "continue paginating"). The server has no separate
  // `cursor` URL param — cursor walks ride on `before`. Confirmed via
  // app/controllers/concerns/cursor_paginated.rb on the server.
  const beforeParam = opts.cursor ?? opts.before;
  if (beforeParam) params.set("before", beforeParam);
  if (opts.after) params.set("after", opts.after);
  if (opts.limit != null) params.set("limit", String(opts.limit));
  const qs = params.toString();
  const path = qs
    ? `/rooms/${opts.roomId}/messages?${qs}`
    : `/rooms/${opts.roomId}/messages`;
  const res = await this.fetch(path);
  return parseReadMessagesResponse((await res.json()) as unknown);
}
```

**b. New `listReactions(roomId, messageId)`:**

```ts
async listReactions(
  roomId: number,
  messageId: number,
): Promise<SabhaReactionsResponse> {
  const res = await this.fetch(
    `/rooms/${roomId}/messages/${messageId}/boosts`,
  );
  return parseReactionsResponse((await res.json()) as unknown);
}
```

**c. Fix `client.search`'s cursor wire mapping** — currently a real bug:

```diff
-    if (opts.before) params.set("before", opts.before);
+    const beforeParam = opts.cursor ?? opts.before;
+    if (beforeParam) params.set("before", beforeParam);
     ...
-    if (opts.cursor) params.set("cursor", opts.cursor);
```

The server's `parse_pagination_params` (in `app/controllers/concerns/cursor_paginated.rb`) only reads `params[:before]`. `SearchesController` includes the same concern, so the post-#13 client code at `src/client.ts:426` (`if (opts.cursor) params.set("cursor", opts.cursor)`) sends a parameter the server silently ignores — agent cursor walks re-fetch page 1 instead of paginating.

This is a behavior change. Anyone whose agent has been silently re-fetching page 1 will start actually paginating. Flag it in the PR description; add a regression test.

**d. Runtime envelope guards** — siblings to `parseSearchResponse`:

```ts
function parseReadMessagesResponse(raw: unknown): SabhaReadMessagesResponse {
  if (
    !raw || typeof raw !== "object" ||
    !Array.isArray((raw as { results?: unknown }).results) ||
    typeof (raw as { has_more?: unknown }).has_more !== "boolean"
  ) {
    throw new Error(
      "Sabha read returned an unexpected shape (expected { results, has_more, next_cursor })",
    );
  }
  const json = raw as {
    results: SabhaReadMessage[];
    has_more: boolean;
    next_cursor?: string | null;
  };
  return {
    results: json.results,
    hasMore: json.has_more,
    nextCursor: json.next_cursor ?? null,
  };
}

function parseReactionsResponse(raw: unknown): SabhaReactionsResponse {
  if (
    !raw || typeof raw !== "object" ||
    !Array.isArray((raw as { reactions?: unknown }).reactions) ||
    typeof (raw as { total?: unknown }).total !== "number" ||
    typeof (raw as { truncated?: unknown }).truncated !== "boolean"
  ) {
    throw new Error(
      "Sabha reactions returned an unexpected shape (expected { reactions, total, truncated })",
    );
  }
  return raw as { reactions: SabhaReaction[]; total: number; truncated: boolean };
}
```

These match the structural-only stance of `parseSearchResponse` (top-level keys, no per-element validation). Matching the file's existing pattern matters more than the marginal extra defense from element validation; if both old and new should be tightened, that's a separate code-quality PR.

### 3. `src/message-actions.ts` — dispatch

Add `"read"` and `"reactions"` to `SUPPORTED_ACTIONS`. Branches placed alongside `search` / `member-info` (above the shared room-target extraction at `:198`), since these have their own validation messages and accept the canonical `channelId` field that the existing 6 fall-through actions don't:

```ts
if (action === "read") {
  // Single-room read. Match the canonical message-tool field naming
  // (`channelId` first) so a cross-channel agent's natural call works
  // verbatim. Sabha rooms ARE channels in the cross-channel sense.
  const roomId = readNumber(
    params,
    "channelId", "channel_id", "roomId", "room_id", "to", "target",
  );
  if (roomId == null) {
    throw new Error(
      "Sabha read requires a single room target ('channelId' or 'roomId').",
    );
  }
  const response = await client.readMessages({
    roomId,
    before: readString(params, "before"),
    after: readString(params, "after"),
    limit: readNumber(params, "limit"),
    cursor: readString(params, "cursor"),
  });
  // "newest first" baked into the note so the agent learns ordering
  // from the first call's tool result, regardless of which prompt-hint
  // slot is active for the current profile.
  const note = response.hasMore
    ? `Read ${response.results.length} message(s), newest first (more available — pass cursor to walk)`
    : `Read ${response.results.length} message(s), newest first`;
  return ok(note, {
    results: response.results,
    hasMore: response.hasMore,
    nextCursor: response.nextCursor,
  });
}

if (action === "reactions") {
  // Per-message lookup. Server returns 404 indistinguishably for "wrong
  // room", "wrong message id", and "deleted message" (messages.active
  // scope) — surfaces verbatim as SabhaApiError, matching member-info.
  const roomId = readNumber(
    params,
    "channelId", "channel_id", "roomId", "room_id", "to", "target",
  );
  const messageId = readNumber(
    params,
    "messageId", "message_id", "targetMessageId",
  );
  if (roomId == null) {
    throw new Error(
      "Sabha reactions requires a single room target ('channelId' or 'roomId').",
    );
  }
  if (messageId == null) {
    throw new Error("Sabha reactions requires 'messageId'.");
  }
  const response = await client.listReactions(roomId, messageId);
  const note = response.total === 0
    ? `No reactions on message ${messageId}`
    : `${response.total} reaction(s) on message ${messageId}`;
  return ok(note, response);
}
```

The two missing-field errors for `reactions` are split into separate `throw`s (rather than one combined message) so each test assertion can pin a specific branch instead of matching either with a regex disjunction.

### 4. `src/channel.ts` — `describeMessageTool` and `messageActionTargetAliases`

Three changes:

- Add `"read"` and `"reactions"` to the `actions` array.
- Broaden the four field descriptions in the existing schema fragment (`before`/`after`/`limit`/`cursor`) so they no longer say "Sabha search:" — replace with field-purpose descriptions that cover both `search` and `read`.
- **Publish `messageActionTargetAliases`** for the new actions:

```ts
messageActionTargetAliases: {
  read: { aliases: ["roomId", "room_id", "channel_id"] },
  reactions: { aliases: ["roomId", "room_id", "channel_id"] },
}
```

This is **load-bearing**, not cosmetic. Core's `message-action-runner` calls `actionHasTarget(action, params, { channel })` before dispatching to `handleAction`, and rejects with `Error("Action ${action} requires a target.")` if no target is found (`node_modules/openclaw/dist/message-action-runner-*.js`, `actionHasTarget` at `channel-target-*.js`). The runner accepts only:

1. `params.to` (always)
2. `params.channelId` (always)
3. Per-action aliases from core's `ACTION_TARGET_ALIASES` (none for `read` / `reactions`)
4. Per-action aliases from the plugin's `messageActionTargetAliases`

Without the publishing, an agent calling `{ action: "read", roomId: 5 }` is rejected by core *before* the dispatch handler runs, even though the handler accepts the alias. We publish `roomId` / `room_id` / `channel_id` because those are the genuine Sabha-native room targets; we deliberately do **not** publish `to` (always accepted by core), `channelId` (always accepted), or `target` (the runner uses `target` as a synthetic post-normalization field — claiming it as an alias would short-circuit the runner's auto-inference of `target` from `currentChannelId` in tool context).

The schema fragment itself doesn't need a new entry. The same four `before`/`after`/`limit`/`cursor` fields apply to `read` as to `search`; the `properties` bag is global on the merged tool, not per-action. The `channelId`/`channelIds`/`authorId`/`authorIds` canonical scoping fields continue to come from core's `buildChannelTargetSchema`.

**Caveat about the existing 6 actions.** `send`/`edit`/`unsend`/`react`/`thread-reply` have the same dead-code aliasing in dispatch (`readNumber(params, "to", "room_id", "roomId", "target")`) without publishing those aliases. Agents reach them via `to` in practice, so the dead-code aliasing hasn't bitten anyone — but a `roomId`-only call to those actions would be rejected by core for the same reason. Broadening the publishing to all 9 actions is a small mechanical change but is its own concern (separate PR; no behavior change for the existing aliases-via-`to` path).

### 5. `src/channel.ts` — `messageToolHints`

Add a third bullet under the existing platform-identity preamble + mention syntax:

> READING HISTORY: The `message` tool's `read` action returns messages newest-first. Reorder client-side before summarizing if you want chronological output. Pass `cursor` (from a prior page's `nextCursor`) to walk further back in time.

The hint is gated behind `availableTools.has("message")` by the SDK, so it's invisible on profiles without `message` (e.g. `coding`). That's fine — those profiles won't be calling `read` either. The dispatch response `note` from §3 is the load-bearing hint; this preamble line is a nice-to-have for agents that want to plan ahead.

## Tests

### `src/client.test.ts`

- `readMessages` builds correct URL with all params (happy path)
- `readMessages` prefers `cursor` over `before` when both given
- `readMessages` returns the parsed envelope (camelCase normalization: `has_more` → `hasMore`)
- `readMessages` throws on bare-array response (envelope-guard regression)
- `readMessages` throws on `null` body and on a non-object body (`<html>`)
- `readMessages` builds the URL with no query string when no opts beyond `roomId` are passed
- `readMessages` surfaces a 422 `validation_failed` body as `SabhaApiError` (malformed-cursor contract anchor)
- `listReactions` builds the right URL
- `listReactions` returns the typed shape verbatim
- `listReactions` throws on missing `total` field
- `listReactions` 404 surfaces as `SabhaApiError` (covers deleted + never-existed)
- **Drive-by:** `search` cursor-only call now sends `before=<cursor>` (regression for the latent bug fix)

### `src/message-actions.test.ts`

- `read` happy path: returns envelope, includes `hasMore` / `nextCursor`
- `read` accepts each of `channelId` / `channel_id` / `roomId` / `room_id` / `to` / `target` (one assertion per alias on the URL pathname, not coupled to a single string match)
- `read` cursor walk: passing only `cursor` correctly translates to wire's `before`
- `read` rejects when no room target is provided
- `reactions` happy path: returns aggregated reactions with totals
- `reactions` empty case: zero reactions returns `total: 0, reactions: []`
- `reactions` rejects with the room-target error when only `messageId` is given (specific, not regex disjunction)
- `reactions` rejects with the messageId error when only `roomId` is given (specific)
- `reactions` 404 bubbles as `SabhaApiError` (matches `member-info` semantics)

### `src/channel.test.ts`

- `describeMessageTool` lists `read` and `reactions` in the action enum
- `describeMessageTool`'s schema fragment still publishes `before` / `after` / `limit` / `cursor` (unchanged from main)
- The four field descriptions don't say "Sabha search:" anymore (regression guard for the broadening)
- `messageToolHints` preamble contains the "newest-first" sentence
- `messageActionTargetAliases.read` publishes `["roomId", "room_id", "channel_id"]` — load-bearing for the core gate; without it core rejects `{action: "read", roomId: 5}` before dispatch
- `messageActionTargetAliases.reactions` publishes the same alias set
- Neither published list contains `to` / `channelId` (always-accepted by core) or `target` (runner's synthetic post-normalization field)

## Doc updates (in same PR)

### `CLAUDE.md`

- Bump the message-action adapter description from 7 actions to 9.
- Brief mention of `read` (newest-first, dual-purpose `before`) and `reactions` (per-message aggregated) semantics.
- Cross-reference this plan and `READ-ENDPOINT-SCALE-PLAN.md`.

### `docs/ARCHITECTURE.md`

- Section "File structure" → `message-actions.ts`: extend the action list to include `read` and `reactions`.

### `docs/CHANNEL-PLUGIN-COMPARISON.md`

- Matrix line 14: `Message-action verbs | 7` → `9`.
- §3 narrative: bump "7 actions" → "9 actions" everywhere it appears. Add a one-bullet note under the Sabha highlights for `read` and `reactions` (peer parity with Slack's `read`/`reactions` and Discord's `read`/`reactions`).
- "What would a Mattermost developer find weird" item 5 (`Threads not streaming yet`) — drop, no longer true.
- "Hypothetical growth" table row for `readMessages (fetch room history for context)` — drop, now done. The `Pin / unpin / list-pins` row stays.
- Tests-section coverage list: mention `read` / `reactions` envelope-guard tests for client.
- "Resolved drifts" entry: new bullet for `read` + `reactions` + the search-cursor bug fix, with this PR's commit ref.
- References: add this doc.

## Open questions

1. **Reactions result wrapping.** Pass the wire response through verbatim (`content` field name) or rename `content` → `emoji` for cross-channel agent ergonomics? **Default: pass through.** `content` matches the Sabha codebase term (`Boost.content`) and the agent already knows it's on Sabha via the channel-context preamble.

2. **Reactions on a deleted/unseen message.** Server returns 404 for both. Bubble as `SabhaApiError` (matches `member-info`) or wrap as `{ reactions: [], total: 0, truncated: false, notFound: true }`? **Default: bubble.** Agent sees a clear 404 error string; explicit empty-but-found vs not-found distinction is rarely actionable.

3. **`read` array form** — agent passes `channelIds: [123, 456]`. The wire is per-room. `readNumber` returns `undefined` for arrays, so the agent gets the existing "single room target" error. **Default: rely on the existing default error.** An explicit "read accepts only a single room" error is marginal value over the current message.

## Risks

1. **The `client.search` cursor fix is a behavior change.** Anyone whose agent has been silently re-fetching page 1 will start actually paginating. PR description must call this out so a reviewer doesn't read it as scope creep, and so an operator can correlate any post-deploy behavior shift.

2. **Newest-first surprises agents expecting chronological order.** Mitigation: response `note` includes "newest first" + matching line in `messageToolHints`. Without these, summarize-this-thread agents produce mis-ordered output without realizing.

3. **`reactions` 404 behavior is a deliberate choice** matching `member-info`. PR description should call it out so a future contributor doesn't re-litigate to "but we should return empty."

4. **`SabhaReadMessage` type drift.** Server's `messages#index` shape is `{ id, creator, body, attachment, created_at }`. If a future server PR re-adds `mentionees` (after the `Mentionee` preload refactor lands per `BOT-READ-REACTIONS-PLAN.md`), the plugin's type and envelope guard will need to flex. Acceptable — types should match wire reality, not aspirational.

5. **Soft-deleted-vs-missing is invisible.** `messages.active` scoping means a deleted message and a never-existed message id both return 404 from `reactions`. Agents asking "did anyone react to my last message?" after the user deleted it will see a 404 they cannot distinguish from "wrong id." Defensive language in the action description is enough; not worth a server change.

6. **Asymmetric envelope-guard tightness.** New guards match `parseSearchResponse`'s top-level-only structural check. The reviewer flag for this asymmetry applies to the existing `parseSearchResponse` too — tightening only the new ones would create a different inconsistency. If we want stricter element validation across all three, that's a separate code-quality PR.

## Order of work

Single PR, three commits for clean review:

1. **Wire fixes + new client methods.** Fix `client.search` cursor mapping. Add `readMessages` + `listReactions` + envelope guards + types. `client.test.ts` coverage including the search-cursor regression.
2. **Action dispatch.** Add `read` and `reactions` to `SUPPORTED_ACTIONS` + `handleAction`. Add to `actions` enum in `describeMessageTool` and broaden the schema field descriptions. `messageToolHints` newest-first bullet. `message-actions.test.ts` + `channel.test.ts` coverage.
3. **Doc sweep.** CLAUDE.md + ARCHITECTURE.md + CHANNEL-PLUGIN-COMPARISON.md.

Total estimate: ~120 LOC implementation + ~80 LOC tests + doc updates. Single PR fits.

## What this plan deliberately skips

### `emoji-list`

Sabha has no custom emoji table. `EmojiHelper::REACTIONS` is a 20-emoji UI picker, not a server resource. `Boost.content` accepts any unicode ≤16 chars — agents can already react with whatever emoji they want. If Sabha-the-platform later adds Slack-style admin-uploaded custom emoji, an `emoji-list` action becomes natural and we'll add it then.

### Thread-aware read

Currently `read` returns messages from a single room. If the agent passes a thread room id (Sabha threads are Room subclasses with their own `room_id`), the read scopes to that thread's messages. **No special handling needed** — the existing wire shape handles it. Documented as part of the response `note` if needed later.

### Server-side enrichment of `mentionees`

The `BOT-READ-REACTIONS-PLAN.md` filed `mentionees` batch-preload as a server follow-up. Until that lands, `read` results don't expose mentionees. There's no plugin path to single-message fetch (`getMessage` was deleted in #13). Acceptable; agents that need mentionee context can read mention metadata directly from inbound payloads, which `inbound.ts` already exposes.

### Cross-action `channelId` alias normalization for the existing 6 actions

`read` and `reactions` adopt the canonical `channelId` field because they're peer to `search` (which already does). The 6 fall-through actions (`send`, `edit`, `unsend`, `react`, `thread-reply`) still use `("to", "room_id", "roomId", "target")` — broadening their alias set is a small mechanical change with broad benefit but is its own PR (separate concern, separate test surface).

### Element-level envelope validation

Already noted under risks. The new guards match `parseSearchResponse`'s structural-only stance for in-file consistency. If a maintainer wants stricter checks, do all three together in a code-quality PR rather than just the new ones.

## Postscript: formatter-shape projection (2026.4.28)

Post-merge review caught that the v1 `read` and `reactions` envelopes returned the wire shape verbatim, which broke the shared CLI formatter at `openclaw/src/commands/message-format.ts`:

- `renderMessagesFromPayload` reads `payload.messages[]`, not `results`.
- `renderMessageList` per-entry pulls `id` / `timestamp` (or `ts`) / `authorTag` (or `author.username` / `user`) / `text` (or `content`). Sabha's wire `{ id, creator: { id, name }, body: { html, plain }, created_at }` matches none except `id`, producing rows with empty Time/Author/Text columns.
- `renderReactions` reads `entry.name` for the emoji label and `entry.users[]` for booster identities, gating each on `typeof === "string"`. Sabha's `{ content, boosters: [{id: number, name}] }` would render with an empty Emoji column and silently-dropped boosters (numeric `id` fails the `typeof === "string"` gate).

Slack and Discord avoid this by either (a) returning a shape that natively matches the formatter's lookups (Slack — `messages: [...]` from the Slack Web API uses `ts` / `text` / `user` keys) or (b) running an explicit `normalizeMessage` projection (Discord — see `extensions/discord/src/actions/runtime.messaging.ts:325`).

**Decision:** project Sabha's wire shape into the formatter's expected field names in `handleAction`, and **drop the raw wire fields entirely** (do not ship `results` / `content` / `boosters` alongside the projection). Two reasons to drop:

1. **Two consumers, one field** — agents and the formatter both read `details`. Shipping both shapes lets the LLM consume the un-normalized one and produce reverse-conclusions about the wire (e.g., asking what "boosters" are when the answer is "they're called users now"). Slack/Discord ship one shape only.
2. **No Sabha-specific metadata is dropped** — per-emoji `truncated` and the message's `attachment` survive in the projection. Nothing meaningful is lost.

`hasMore` / `nextCursor` keep their names (matching `search`'s envelope) — those fields aren't formatter-consumed.

**Anti-regression:** `src/message-actions.test.ts` pins `details.results` is `undefined` (read) and that per-reaction `content` / `boosters` are `undefined` — a future refactor that "helpfully" re-exposes the wire shape will fail there.

**Open meta-issue, not blocking:** the formatter's expected field shape is hidden coupling — there's no SDK-level contract advertising "if you implement `read`, your `details.messages[]` must look like X." The right long-term fix is for `openclaw/plugin-sdk` to ship a typed `MessageRow` / `ReactionRow` interface that the formatter and channel handlers both depend on; until then, CLAUDE.md's outbound-paths section calls out the formatter file by path so the next maintainer adding a formatted action checks it directly.

## References

- [`sabha-co/sabha#50`](https://github.com/sabha-co/sabha/pull/50) — Server PR shipping both endpoints
- `READ-ENDPOINT-SCALE-PLAN.md` — Sibling design doc; `client.search` envelope shape this plan mirrors
- `CHANNEL-PLUGIN-COMPARISON.md` — At-a-glance and "Resolved drifts" section
- `src/client.ts:410` — `client.search` (closest in-file pattern for `readMessages`)
- `src/client.ts:496` — `parseSearchResponse` (model for the new envelope guards)
- `src/message-actions.ts:113-128` — `readNumberList` (canonical channelId/roomId merging pattern)
- `src/channel.ts:227-263` — existing `describeMessageTool.schema` fragment (where `before`/`after`/`limit`/`cursor` are already declared)
