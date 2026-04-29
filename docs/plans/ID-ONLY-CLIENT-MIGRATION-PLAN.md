# Plugin migration to id-only bot ops + inline thread-reply

**Status:** Proposed (2026-04-29).
**Area:** `@sabha-co/openclaw-sabha` plugin (`src/client.ts`, `src/draft-stream.ts`, `src/monitor.ts`, tests, docs).
**Companion plan:** `/Users/ashwin/dev/sabha/docs/plans/ID-ONLY-BOT-MESSAGE-OPS-PLAN.md` (server side). The plugin migration cannot ship until the server change has merged and a Sabha release that includes it has been cut.

This plan is split into two phases that mirror the server plan one-for-one:

- **Phase 1 — adopt id-only mutating endpoints.** Eliminates the room-rebind requirement on the *editing* path of the streaming reply loop. Stand-alone, ships independently.
- **Phase 2 (conditional) — adopt inline thread-reply via `parent_message_id`.** Collapses the dedicated thread-creation send path. Decision deferred until after server Phase 2 ships (which is itself conditional).

Phase 1 is the load-bearing migration. Phase 2 is documented now so the option is explicit if the server commits to it.

The plugin is **not in production**, so both phases are clean breaks: replace methods outright, no transition window, no version sniffing.

---

# Phase 1 — adopt id-only mutating endpoints

## Why

After `2026.4.28` (commit `d5d4027`), the plugin streams agent replies via a `firstSend` callback that captures both the new thread room id and the new message id from the server's `replyInThread` response, then rebinds the draft stream's `effectiveRoomId` so subsequent edits target the thread (`src/draft-stream.ts` `effectiveRoomId`, `src/monitor.ts` `firstSend` wiring around line 357). This pattern exists because every mutating endpoint (`editMessage`, `deleteMessage`, `addReaction`, `removeReaction`) requires a room id in the URL, and the room id changes after thread creation.

The server-side plan (Phase 1) adds id-only counterparts:
- `PATCH /api/bots/messages/:id`
- `DELETE /api/bots/messages/:id`
- `POST /api/bots/messages/:message_id/boosts`
- `DELETE /api/bots/messages/:message_id/boosts/:id`

Once those exist, the plugin's edit loop no longer needs the room id. The `firstSend` callback still has to capture the thread room id (because `replyInThread` is unchanged in server Phase 1 and still returns a new thread room), but the room id is now only used for the **fresh error-message send** in `monitor.ts`'s case-(c) deliver fallback — not for editing the preview message. That's a meaningful simplification:

- `editMessage` and `deleteMessage` become `(messageId, text)` and `(messageId)` — same name, shorter signature
- `addReaction` and `removeReaction` lose the `roomId` arg
- the draft stream's `effectiveRoomId` becomes used only for fresh error sends, not for the edit loop
- the `roomId()` getter on the stream handle is still useful for recovery paths but no longer load-bearing for editing

The full elimination of the rebind concept (and `replyInThread`, and `firstSend`) waits for Phase 2. Phase 1's win is the simpler editing path and a unified mutation surface that no longer differs from peer plugins on edit semantics.

## What

### Method signature changes (`src/client.ts`)

| Before | After |
|---|---|
| `editMessage(roomId, messageId, text)` | `editMessage(messageId, text)` |
| `deleteMessage(roomId, messageId)` | `deleteMessage(messageId)` |
| `addReaction(roomId, messageId, emoji)` | `addReaction(messageId, emoji)` |
| `removeReaction(roomId, messageId, boostId)` | `removeReaction(messageId, boostId)` |

URL path changes:

| Old wire path | New wire path |
|---|---|
| `PATCH /rooms/:room_id/messages/:id` | `PATCH /messages/:id` |
| `DELETE /rooms/:room_id/messages/:id` | `DELETE /messages/:id` |
| `POST /rooms/:room_id/messages/:message_id/boosts` | `POST /messages/:message_id/boosts` |
| `DELETE /rooms/:room_id/messages/:message_id/boosts/:boost_id` | `DELETE /messages/:message_id/boosts/:boost_id` |

### Methods that do **not** change

- `sendMessage(roomId, text)` — POST stays room-scoped (server Phase 1 doesn't add an id-only POST; creation always picks a room)
- `replyInThread(roomId, messageId, text)` — unchanged in Phase 1; collapses into `sendMessage` only in Phase 2
- `listReactions(roomId, messageId)` — GET stays room-scoped (server Phase 1 deliberately leaves GETs alone)
- `readMessages(...)` and the rest of the read surface

### Draft-stream changes (`src/draft-stream.ts`)

- The `editMessage` and `deleteMessage` calls inside the loop (`flush`, `stop`, recovery paths) drop their `effectiveRoomId` argument
- `effectiveRoomId` stays as state because fresh error-message sends in `monitor.ts` still need it
- The `roomId()` getter stays for the same reason
- The `firstSend` callback's return shape `{ roomId, messageId }` stays unchanged — Phase 1 doesn't touch threading

### Monitor changes (`src/monitor.ts`)

- The deliver-path branches that call `client.editMessage(roomId, messageId, ...)` or `client.deleteMessage(roomId, messageId)` switch to id-only signatures
- The `shouldThread` branch that wires `firstSend` is unchanged in Phase 1
- The recovery / error-replace paths that read `draftStream.roomId()` for *editing* now don't need to (the edit calls don't take `roomId`); the same paths that read `draftStream.roomId()` for *fresh error sends* still do

## Non-goals (Phase 1)

- **No change to read-side methods.** `listReactions`, `readMessages`, `searchMessages`, etc. remain room-scoped per server Phase 1 scope.
- **No collapse of `replyInThread` into `sendMessage`.** That's Phase 2.
- **No removal of `firstSend` callback or `roomId()` getter.** Both still serve fresh-error-send paths.
- **No version sniffing or transition window.** The plugin and the new Sabha server release ship together; older Sabha servers (without the id-only routes) are not supported by this plugin version.
- **No new test coverage of the id-only routes themselves.** Those are tested in the server plan; the plugin tests just need to verify the plugin sends the right HTTP requests.

## Implementation units

### 1. Update `src/client.ts`

File: `src/client.ts`.

Changes:

```ts
async editMessage(messageId: number, text: string): Promise<SabhaMessageBody> {
  const body = this.toRichText(text);
  const res = await this.fetch(`/messages/${messageId}`, {
    method: "PATCH",
    headers: { "Content-Type": "text/plain" },
    body,
  });
  const json = (await res.json()) as { id: number; body: SabhaMessageBody };
  return json.body;
}

async deleteMessage(messageId: number): Promise<void> {
  await this.fetch(`/messages/${messageId}`, { method: "DELETE" });
}

async addReaction(messageId: number, emoji: string): Promise<number> {
  const res = await this.fetch(`/messages/${messageId}/boosts`, {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: emoji,
  });
  const json = (await res.json()) as { id: number };
  return json.id;
}

async removeReaction(messageId: number, boostId: number): Promise<void> {
  await this.fetch(`/messages/${messageId}/boosts/${boostId}`, {
    method: "DELETE",
  });
}
```

The doc comment on `editMessage` ("This is the only edit entry point (draft-stream.ts uses it for streaming previews)") stays — still accurate, just shorter.

### 2. Update `src/draft-stream.ts`

File: `src/draft-stream.ts`.

Find every internal call to `client.editMessage(effectiveRoomId, ...)` and `client.deleteMessage(effectiveRoomId, ...)` and drop the room-id argument. The `effectiveRoomId` variable stays declared (for the `roomId()` getter that recovery paths use), but no longer flows into the editing calls.

Comment update on `effectiveRoomId`: change "captured value to callers (recovery / error-replace paths)" to clarify that recovery uses it for *fresh sends*, not edits, after the migration.

### 3. Update `src/monitor.ts`

File: `src/monitor.ts`.

Find the deliver-path branches that call `client.editMessage(roomId, messageId, text)` or `client.deleteMessage(roomId, messageId)` and drop the `roomId` arg. Verify each branch:

- main flush path inside `deliver` (alive + preview exists)
- recovery / error-replace path (dead with preview)
- case-(c) deliver fallback (dead with no preview ever sent — this one still calls `client.sendMessage`/`client.replyInThread` with the room id, which is correct since those are unchanged)

The `shouldThread` block around line 340-370 is unchanged.

### 4. Update tests

Files:
- `src/client.test.ts` — adjust the recorded request URLs and bodies for the four mutating methods. Each test that previously asserted `PATCH /rooms/${roomId}/messages/${messageId}` now asserts `PATCH /messages/${messageId}`.
- `src/draft-stream.test.ts` — mock client calls drop the `roomId` first arg. Verify the regression test from `e47974c` (the in-flight first-send window) still passes — its invariant is about `messageId()` returning `undefined`, which is unchanged.
- `src/monitor.test.ts` — same adjustments where the test asserts on outgoing HTTP requests or mock client invocations.

No new test scenarios are introduced beyond updating the existing ones — the behavioral surface is identical.

### 5. Documentation

Files:
- `CLAUDE.md` — short note in the "Outbound paths" section that mutating message ops are now id-only on the wire
- `docs/CHANNEL-PLUGIN-COMPARISON.md` — section 7 (streaming agent replies): the "Sabha is the only plugin with a mid-stream rebind" framing softens. Replace with: "Sabha needs a `firstSend` callback for thread-creation sends; subsequent edits use id-only routes that match Slack/Mattermost edit shapes." The full rebind elimination waits for Phase 2 if it ships.
- `README.md` — no operator-facing change needed; the migration is invisible to operators

This plan moves to "shipped" status when merged.

## Backward compatibility

**Clean break.** The plugin is not in production. Old method signatures are deleted, not deprecated. The plugin version that ships this migration depends on a Sabha server version that includes server Phase 1.

The plugin's setup-wizard `probeBaseUrl` already verifies a URL points at a Sabha server by hitting `/skill`; if a future need arises, that probe can also confirm the server supports id-only routes (e.g. `HEAD /messages/0` returning 404 with the canonical JSON envelope vs. 404 from missing route). Don't add this check unless an actual version-skew incident demands it.

## Risks (Phase 1)

### Server-version skew during plugin development

While both PRs are in flight, plugin developers may run against an older Sabha server that doesn't have id-only routes. Tests pass against fixture URLs but the actual integration breaks.

Mitigation: pin the local Sabha checkout to a server PR branch that has the id-only routes during plugin-side development. Document this requirement in the plugin PR description.

### Test surface drift

Every test that previously hardcoded `/rooms/${roomId}/messages/${messageId}` URLs now needs an update. If any are missed, the test still passes (the mock returns OK regardless of the URL the plugin sends) but the wire-shape regression sneaks through.

Mitigation: explicitly grep the test files for `/rooms/.+/messages/` and confirm every match either points at `sendMessage`/`listReactions`/`replyInThread`/`readMessages` (still room-scoped) or has been migrated. Add this grep to the PR checklist.

### `effectiveRoomId` becomes a fragile mental-model leak

Phase 1 leaves `effectiveRoomId` declared but unused for editing. A future contributor reading the code sees it threaded through state without a clear use site, and might delete it — breaking fresh error sends silently.

Mitigation: rename `effectiveRoomId` to `freshSendRoomId` (or similar) and update the doc comment to spell out the single use case. Or extract the fresh-error-send path into a method that takes the room id explicitly, decoupling the stream state from the recovery semantics. Pick one before the PR ships.

## Migration checklist (Phase 1 plugin-side PR)

After server Phase 1 has merged and a Sabha release including it has been cut:

1. Rebase against `main` so the plan doc and any Phase 1 server-side cross-references are current
2. Apply the four `client.ts` method changes
3. Update `draft-stream.ts` edit/delete call sites
4. Update `monitor.ts` edit/delete call sites
5. Update the three test files
6. Update `CLAUDE.md` + `docs/CHANNEL-PLUGIN-COMPARISON.md`
7. Run `npm test`, `npm run build`, `npm run lint`
8. Smoke-test against a local Sabha server (with id-only routes) on the `messaging` profile: confirm an inbound @mention round-trips through edit and delete cleanly
9. Smoke-test threading: confirm a top-level inbound that creates a new thread streams, edits, and finalizes correctly

## Exit criteria (Phase 1)

- `client.editMessage`, `client.deleteMessage`, `client.addReaction`, `client.removeReaction` use id-only wire paths
- `draft-stream.ts` and `monitor.ts` no longer pass a room id to those four methods
- all 470+ existing tests pass; no new tests required (the behavioral surface is unchanged)
- the plugin runs against a Sabha server with id-only routes without HTTP errors (smoke-test verified)
- `CHANNEL-PLUGIN-COMPARISON.md` reflects the migrated state (rebind narrowed to fresh-send path, not edit path)

---

# Phase 2 (conditional) — adopt inline thread-reply via `parent_message_id`

**Decide whether to build this only after server Phase 2 ships.** Server Phase 2 is itself conditional ("decision criterion: revisit after Phase 1 has been in production for at least one Sabha plugin release cycle"). If the server doesn't ship Phase 2, this plugin phase is moot.

## Why

After Phase 1, the plugin's `monitor.ts` still has a `shouldThread` branch that wires `firstSend` differently from non-threading sends — because `replyInThread` is a separate endpoint with a different request shape than the regular `sendMessage`. The dedicated thread-creation send path remains:

- `client.replyInThread(roomId, messageId, text)` exists only to call `POST /rooms/:room_id/messages/:message_id/thread`
- the `firstSend` callback in `monitor.ts` exists only because `replyInThread` returns a different response shape than `sendMessage` (`{ thread, message }` vs `{ id }` plus Location header)
- the `effectiveRoomId` rebind logic in `draft-stream.ts` exists to route fresh error sends to the captured thread room

If server Phase 2 ships, `POST /api/bots/rooms/:room_id/messages?parent_message_id=N` becomes a unified send that returns `{ id, room_id }` (when `parent_message_id` is passed). The plugin can:

- collapse `replyInThread` into `sendMessage(roomId, text, { parentMessageId })`
- delete the `firstSend` callback (the unified `sendMessage` returns the resolved room id directly)
- simplify `effectiveRoomId` rebind into "any send may resolve to a different room id; capture from the response" — uniform across thread-creation and non-thread sends

The win: the plugin no longer has a thread-creation-specific code branch. The streaming agent reply loop becomes shape-identical to Slack/Mattermost (post first partial → capture id → edit by id), with one extra hop: capture the room id from the first send for fresh error routing.

### When *not* to build Phase 2

- Server Phase 2 doesn't ship
- After Phase 1, the `firstSend` + `replyInThread` surface in the plugin is already trivial enough that further collapse isn't worth the diff
- New Sabha bot-API consumers exist that depend on the dedicated `/thread` endpoint and we don't want a second canonical thread-create surface

### When to build Phase 2

- Server Phase 2 ships and is documented as the preferred shape
- The plugin maintainer (or peers) ask to remove `replyInThread` to match peer-plugin idioms
- New plugin features (e.g. richer thread management) would benefit from the unified `sendMessage` return shape

## What

### Method signature changes (`src/client.ts`)

| Before | After |
|---|---|
| `sendMessage(roomId, text)` | `sendMessage(roomId, text, opts?: { parentMessageId?: number })` returns `{ id, roomId }` |
| `replyInThread(roomId, messageId, text)` | **deleted** (or thin compat wrapper for one release if anyone outside this plugin uses it) |

The `sendMessage` return type changes from the current `{ id }` (or whatever `Location`-derived shape) to `{ id, roomId }` so callers know which room the message landed in. When `parentMessageId` is omitted, `roomId` equals the input arg; when present, `roomId` is the resolved thread room.

### Draft-stream changes (`src/draft-stream.ts`)

- The `firstSend` callback **is removed** from `createSabhaDraftStream`'s param shape
- The stream's first send becomes a normal `sendMessage(parentRoomId, text, { parentMessageId })` call when threading-on, captured by the loop's standard send-then-capture path
- `effectiveRoomId` becomes "the room id captured from the first send response" — uniform across all cases, no thread-creation special case

### Monitor changes (`src/monitor.ts`)

- The `shouldThread` branch around line 340-370 collapses: instead of constructing the stream with `firstSend` callback, the deliver path passes `parentMessageId` to the stream's first send via stream config or per-call option
- The `client.replyInThread(...)` call inside the case-(c) deliver fallback (dead with no preview) becomes `client.sendMessage(parentRoomId, errorText, { parentMessageId })`
- The `client.replyInThread(...)` call inside the recovery / error-replace fallback (dead with preview) similarly collapses

### Plugin docs

- `docs/CHANNEL-PLUGIN-COMPARISON.md` section 7 (streaming agent replies): the "Sabha needs a `firstSend` callback for thread-creation sends" framing becomes a historical note. Sabha now matches the Slack/Mattermost shape entirely.
- `CLAUDE.md` Outbound paths: drop the `replyInThread` mention; document that `sendMessage` accepts `parentMessageId` as the unified thread-creation surface.
- `README.md` Tool profile guidance: no operator-facing change.

## Non-goals (Phase 2)

- **No change to the data model.** Threads remain `Rooms::Thread` records server-side. The plugin's session-routing layer still needs to handle thread room ids (`sabha:group:{room}:thread:{thread}` keys in `src/session.ts`) — those are unchanged.
- **No removal of `effectiveRoomId` or `roomId()` getter.** They become uniform across cases but are still load-bearing for fresh error sends.
- **No new test scenarios beyond signature updates.** Phase 2's behavioral surface is the same as Phase 1's; only the wire shape changes.

## Implementation units (Phase 2)

### 1. `src/client.ts`

- Update `sendMessage` signature to accept optional `{ parentMessageId }` and return `{ id, roomId }` from the response body when `parent_message_id` was set, falling back to the input `roomId` when it wasn't
- Delete `replyInThread` (or keep a thin compat wrapper for one release if it's exported as part of the plugin's public surface — verify by grepping consumers)

### 2. `src/draft-stream.ts`

- Remove the `firstSend` param from `createSabhaDraftStream`
- Add an optional `parentMessageId` param to the stream config; the stream's first send uses `client.sendMessage(roomId, text, { parentMessageId })` when set
- Capture the response's `roomId` into `effectiveRoomId` uniformly

### 3. `src/monitor.ts`

- Drop the `shouldThread`-conditional `firstSend` wiring; pass `parentMessageId: payload.message.id` into the stream config when `shouldThread` is true
- Update the deliver-path fallback branches to use the unified `sendMessage`

### 4. Tests

- `src/client.test.ts` — update `sendMessage` test to cover both with-`parentMessageId` and without; assert the return shape and the wire request
- `src/draft-stream.test.ts` — replace `firstSend` mock with `parentMessageId` config; verify the stream captures the resolved room id from the first send response
- `src/monitor.test.ts` — verify the deliver path passes `parentMessageId` to the stream when `shouldThread` is true; verify recovery paths use the unified `sendMessage`
- The regression test from commit `e47974c` (in-flight first-send window) still applies; verify its invariant is preserved under the new shape

## Backward compatibility

Clean break, same as Phase 1. `replyInThread` is deleted outright (assuming it's only used inside the plugin). If grep reveals external consumers (unlikely — the plugin ships as `@sabha-co/openclaw-sabha` and `replyInThread` is on the `SabhaClient` class which is imported but the method isn't re-exported), keep a one-release thin compat wrapper that delegates to `sendMessage` with `parentMessageId`.

## Risks (Phase 2)

### Loss of the `replyInThread` distinct call site

Today, an audit of "where does the plugin create threads" trivially greps for `replyInThread`. After Phase 2, thread creation is implicit in any `sendMessage` call that includes `parentMessageId`. Audit ergonomics worsen slightly.

Mitigation: keep a comment in `monitor.ts` next to the `parentMessageId` config that says "this is the thread-creation site." Or define a constant `THREAD_CREATE_OPTS` for slight self-documentation. Worth it only if the audit pattern is actually used.

### Response-shape change on `sendMessage`

Current `sendMessage` returns `{ id }` (verify against actual code; may differ). New shape `{ id, roomId }`. Callers that destructure or pass the return value through a type-narrow boundary need updates.

Mitigation: TypeScript catches this. Run `npm run build` after the signature change and address every site the compiler flags.

### Server Phase 2 might never ship

Plugin Phase 2 sits in this doc as a deferred plan. If server Phase 2 is never built, this section becomes dead docs. That's fine — it's a designed contingency, kept for "if we revisit, here's the migration."

Mitigation: add a one-liner to the doc index (`CLAUDE.md` "Docs in this repo" section) noting that Phase 2 of this plan is conditional on the server-side decision.

## Migration checklist (Phase 2 plugin-side PR)

After server Phase 2 has merged and a Sabha release including it has been cut, *and* the project decision is to proceed:

1. Rebase against `main`
2. Apply the `client.ts` `sendMessage` signature change and delete `replyInThread`
3. Update `draft-stream.ts` to drop `firstSend` and accept `parentMessageId`
4. Update `monitor.ts` deliver-path branches
5. Update the three test files
6. Update `CLAUDE.md` and `docs/CHANNEL-PLUGIN-COMPARISON.md`
7. Run `npm test`, `npm run build`, `npm run lint`
8. Smoke-test against a Sabha server with both server phases: in-thread inbound and top-level → new-thread inbound, both stream and finalize correctly
9. Verify no `replyInThread` references remain (grep)

## Exit criteria (Phase 2)

- `client.sendMessage` accepts `{ parentMessageId }` and returns `{ id, roomId }`
- `client.replyInThread` is deleted (or reduced to a one-release compat wrapper)
- `createSabhaDraftStream` no longer accepts a `firstSend` callback
- `monitor.ts`'s `shouldThread` branch wires `parentMessageId` into the stream config without a separate callback
- all tests pass; no behavioral regressions in either streaming or non-streaming paths
- `CHANNEL-PLUGIN-COMPARISON.md` describes Sabha as shape-identical to Slack/Mattermost on the streaming reply path

---

## References

- `/Users/ashwin/dev/sabha/docs/plans/ID-ONLY-BOT-MESSAGE-OPS-PLAN.md` — server-side plan that this migration depends on
- `src/client.ts` — current `editMessage`, `deleteMessage`, `addReaction`, `removeReaction`, `replyInThread`, `sendMessage` signatures
- `src/draft-stream.ts` — `effectiveRoomId` rebind, `firstSend` callback shape, `roomId()` getter
- `src/monitor.ts` — `shouldThread` branch around line 340-370, deliver-path fallback paths
- `src/session.ts` — thread room id session key shape (unchanged by either phase)
- `docs/CHANNEL-PLUGIN-COMPARISON.md` section 7 — current "Sabha is the only plugin with a mid-stream rebind" framing (will be revised across both phases)
- commit `d5d4027` — original `firstSend` introduction (2026.4.28)
- commit `e47974c` — `messageId() === undefined` regression test
