# Sabha server endpoints used by the plugin

**As of:** 2026-04-29 (post canonical-surface cleanup: id-only mutations + reads, always-on `{ id, room_id }` body on POST /messages).
**Audience:** server engineers planning a refactor of `app/controllers/api/bots/*` and adjacent surface.

This is a complete inventory of every Sabha server URL the plugin touches, what it calls them with, and what it reads from the response. The goal is to make any server change visible: if a refactor renames a field, drops a route, or changes a status code listed here, the plugin breaks.

The plugin authenticates **every** REST call with `Authorization: Bearer <bot_key>` (the WebSocket still authenticates via query string — see "Cable" below). All paths are relative to `apiBaseUrl` (returned by registration, e.g. `https://sabha.co/1000006/api/bots`) unless noted.

Quick map:

| Area | Endpoints | Plugin caller |
|---|---|---|
| [Messaging — sends](#1-messaging--sends) | 1 POST + 1 multipart POST | `client.sendMessage`, `client.sendAttachment` |
| [Messaging — id-only mutations](#2-messaging--id-only-mutations) | 1 PATCH, 1 DELETE | `client.editMessage`, `client.deleteMessage` |
| [Reactions](#3-reactions) | 1 GET, 1 POST, 1 DELETE | `client.listReactions`, `client.addReaction`, `client.removeReaction` |
| [Reading](#4-reading) | 1 GET | `client.readMessages` |
| [Search](#5-search) | 1 GET | `client.search` |
| [Rooms](#6-rooms) | 1 GET, 1 POST | `client.listRooms`, `client.joinRoom` |
| [Users / directory](#7-users--directory) | 3 GET | `client.listUsers`, `client.getUser`, `client.searchUsers` |
| [Direct messages](#8-direct-messages) | 1 POST | `client.createDm` |
| [Bot profile](#9-bot-profile) | 1 PATCH | `client.updateSettings` |
| [Cable (WebSocket)](#10-cable-websocket) | 1 socket, 2 channels | `monitorSabha`, `TypingManager` |
| [Setup-only (unauthenticated)](#11-setup-only-unauthenticated) | 2 endpoints | `probeBaseUrl`, `selfRegisterBot` |
| [Out-of-band fetches](#12-out-of-band-fetches) | n/a | inbound attachment download |

Total REST surface: **16 routes** across `/api/bots/*`. WebSocket: **2 channels** on `/cable`. Setup-only HTTP: **2 routes** outside `/api/bots`.

---

## Conventions used below

- **Path** — exact URL path the plugin emits, with `:placeholders`.
- **Caller** — `src/<file>:<symbol>` of the method that constructs the request.
- **Wire body** — what the plugin sends in the request body.
- **Response — fields read** — which keys of the response the plugin actually consumes (renaming or removing one of these breaks the plugin; renaming an unlisted field is invisible to the plugin).
- **Status semantics relied on** — non-success status codes the plugin distinguishes (rather than treating as generic errors).
- **Notes** — invariants, idempotency, server-shape edge cases.

The plugin's HTTP wrapper (`SabhaClient.fetch`, `src/client.ts:484`) treats any non-2xx as `SabhaApiError` and retries 429/502/503/504 with backoff (`src/retry.ts`). Any status not listed below surfaces to the agent as a generic API error.

---

## 1. Messaging — sends

### 1.1 `POST /rooms/:room_id/messages`

| | |
|---|---|
| **Caller** | `src/client.ts:118 sendMessage(roomId, text, opts?)` |
| **Wire body** | Trix-compatible HTML produced by `markdownToSabhaRichText`; `Content-Type: text/plain` |
| **Query params** | `parent_message_id=:id` (optional) |
| **Response — fields read** | JSON body `{ id: number, room_id: number }` |
| **Status semantics** | 201; 422 from `parent.room.thread?` validation surfaces as `SabhaApiError`; 404 from missing parent surfaces as `SabhaApiError` |
| **Notes** | The server always returns `{ id, room_id }` — for non-thread sends `room_id` matches the URL room, for thread sends it's the resolved thread room id. The streaming draft loop uses this for first-send; the unified `sendMessage` is the only "create message" entry point on the wire (`replyInThread` is gone). |

### 1.2 `POST /rooms/:room_id/messages` (multipart)

| | |
|---|---|
| **Caller** | `src/client.ts:147 sendAttachment(roomId, file, filename)` |
| **Wire body** | `FormData` with `attachment` field; `Content-Type` left to fetch (multipart boundary) |
| **Response — fields read** | JSON body `{ id: number, room_id: number }` (same shape as 1.1) |
| **Status semantics** | 201; 422 surfaces as `SabhaApiError` |
| **Notes** | Plugin **never** sets `Content-Type` here — undici/Node fetch needs to auto-populate the multipart boundary. Multipart hits the same `MessagesController#create` action as 1.1 and returns the same body. |

---

## 2. Messaging — id-only mutations

These four endpoints are post-`b67fc38`. The plugin no longer uses the room-scoped `PATCH /rooms/:room_id/messages/:id` etc. — refactors that drop the id-only routes break streaming, member-action `edit`/`unsend`, and reaction add/remove.

### 2.1 `PATCH /messages/:id`

| | |
|---|---|
| **Caller** | `src/client.ts:191 editMessage(messageId, text)` |
| **Wire body** | Trix HTML; `Content-Type: text/plain` |
| **Response — fields read** | JSON body `body: { html: string, plain: string }` (the plugin discards `id`) |
| **Status semantics** | 200; 403 if not own message; 404 if not visible |
| **Notes** | The only edit entry point in the plugin. `draft-stream.ts` calls this on every streaming update after the first send; `message-actions.ts` calls it for the agent-driven `edit` action. The `id` field is unused — only the rendered body shape matters. |

### 2.2 `DELETE /messages/:id`

| | |
|---|---|
| **Caller** | `src/client.ts:209 deleteMessage(messageId)` |
| **Wire body** | none |
| **Response — fields read** | none (status only) |
| **Status semantics** | 204 = success; 403 if not own message |
| **Notes** | Used by `draft-stream.ts` `clear()`, monitor recovery / error-replace paths, and the agent-driven `unsend` action. |

### 2.3 `POST /messages/:message_id/boosts`

| | |
|---|---|
| **Caller** | `src/client.ts:275 addReaction(messageId, emoji)` |
| **Wire body** | UTF-8 emoji as plain text; `Content-Type: text/plain` |
| **Response — fields read** | JSON body `{ id: number }` (the boost id, returned to the agent so it can later remove the boost) |
| **Status semantics** | 201 |
| **Notes** | No ownership check on creation — boosts can come from any room participant (server uses room-access predicate, not creator-id). |

### 2.4 `DELETE /messages/:message_id/boosts/:boost_id`

| | |
|---|---|
| **Caller** | `src/client.ts:289 removeReaction(messageId, boostId)` |
| **Wire body** | none |
| **Response — fields read** | none |
| **Status semantics** | 204; 404 for someone else's boost (server-scoped via `where(booster: Current.user)`) |

---

## 3. Reactions

### 3.1 `GET /messages/:message_id/boosts`

| | |
|---|---|
| **Caller** | `src/client.ts:265 listReactions(messageId)` |
| **Response — fields read** | `reactions[]: { content: string, count: number, boosters: { id: number, name: string }[], truncated: boolean }`, `total: number`, `truncated: boolean` |
| **Status semantics** | 200; 404 indistinguishably covers missing-message and soft-deleted (server resolves the room from the message id and scopes through `messages.active`). The plugin surfaces 404 to the agent as `SabhaApiError`. |
| **Notes** | Plugin runs an envelope guard (`parseReactionsResponse`, `src/client.ts:577`) that throws if `reactions`/`total`/`truncated` aren't all present. The wire shape is then **projected** in `message-actions.ts:projectReaction` into formatter-friendly `{ name, count, users: { id: string, username }, truncated }` for the shared CLI message formatter. Renaming `content` → `name` server-side would let us drop the projection; renaming `boosters` → `users` similarly. |

---

## 4. Reading

### 4.1 `GET /rooms/:room_id/messages`

| | |
|---|---|
| **Caller** | `src/client.ts:232 readMessages({ roomId, before?, after?, limit?, cursor? })` |
| **Query params** | `before`, `after`, `limit`; **`cursor` is sent as `before=<cursor>`** because the server's `CursorPaginated` concern only reads `params[:before]` |
| **Response — fields read** | `results: SabhaReadMessage[]`, `has_more: boolean`, `next_cursor: string \| null` |
| `SabhaReadMessage` fields read | `id`, `creator: { id, name }`, `body: { html, plain }`, `attachment` (passed through verbatim), `created_at` |
| **Status semantics** | 200; 422 with `code: "validation_failed"` for malformed cursor (caller surfaces verbatim) |
| **Notes** | Newest-first ordering server-side (`reorder(created_at: :desc, id: :desc)`). Plugin runs an envelope guard (`parseReadMessagesResponse`, `src/client.ts:551`) that throws on bare-array, non-object, or null bodies. The plugin **does not consume** `mentionees` or `has_attachment` here (server's `index` JBuilder deliberately omits them). Exposed to the agent as the `read` action with field projection: ids stringified, `created_at` → `timestamp`, `creator.name` → both `authorTag` and `author.username`. |

---

## 5. Search

### 5.1 `GET /search`

| | |
|---|---|
| **Caller** | `src/client.ts:430 search({ query, roomIds?, authorIds?, before?, after?, limit?, cursor? })` |
| **Query params** | `query`, `room_ids` and `author_ids` as **repeated keys** (Rails default), `before`, `after`, `limit`. **`cursor` rides on `before=<cursor>`** — server has no separate `cursor` URL param. |
| **Response — fields read** | `results: { id, creator: { id, name }, body: { html, plain }, room: { id, name }, created_at }[]`, `has_more: boolean`, `next_cursor: string \| null` |
| **Status semantics** | 200; 422 on unparseable `before`/`after` |
| **Notes** | Same dual-purpose `before` semantic as `readMessages` (the two endpoints share the `CursorPaginated` concern). Plugin envelope guard at `src/client.ts:528`. Server cap: 200 results; default limit 50. Returned verbatim to the agent — **no field projection** today; agent reads `hasMore` to decide refine-vs-paginate. |

---

## 6. Rooms

### 6.1 `GET /rooms`

| | |
|---|---|
| **Caller** | `src/client.ts:312 listRooms({ joinable?, query?, page?, perPage? })` |
| **Query params** | `joinable=true` (only `true` is sent; absence = "all"), `query`, `page`, `per_page` |
| **Response — fields read** | `SabhaRoom[]`: `id`, `name`, `type`, `messages_url` |
| **Status semantics** | 200 |
| **Notes** | Used by (a) the directory adapter's `listGroups` slot for cross-channel verbs, (b) the channel resolver for name → id resolution, and (c) the setup wizard's `probeBotKey` which calls it once after registration to verify auth. The plugin **does not consume** `members` / `has_bot` from this endpoint (those land on the webhook payload's `room` object, see Cable below). |

### 6.2 `POST /rooms/:room_id/membership`

| | |
|---|---|
| **Caller** | `src/client.ts:328 joinRoom(roomId)` |
| **Wire body** | none |
| **Response — fields read** | `SabhaRoom` (parsed but only used by the wizard's progress UI; the wizard reads `name` for the "Joined #foo" message). |
| **Status semantics** | 201; failures surface as `SabhaApiError` and are reported per-room |
| **Notes** | Setup-only — called from `autoJoinOpenRooms` (`src/setup-wizard.ts:147`) once per joinable room after registration. Not invoked at runtime. Channel-admin agent tools that previously used room membership routes were dropped in `2026.4.29`. |

---

## 7. Users / directory

### 7.1 `GET /users`

| | |
|---|---|
| **Caller** | `src/client.ts:346 listUsers({ roomId?, page?, perPage? })` |
| **Query params** | `room_id` (optional, scopes to that room's members), `page`, `per_page` |
| **Response — fields read** | `SabhaUser[]`: `id`, `name`, `role`, `bot`, `url` |
| **Notes** | Backs the directory adapter's `listPeers` slot. Server-scoped to "users sharing rooms with the bot." |

### 7.2 `GET /users/:id`

| | |
|---|---|
| **Caller** | `src/client.ts:374 getUser(userId)` |
| **Response — fields read** | `SabhaUserDetail`: `id`, `name`, `role`, `bot`, `url`, `bio`, `twitter_url`, `linkedin_url`, `personal_url` (all four social fields are nullable on the wire and the plugin preserves null) |
| **Status semantics** | 200; 404 = "not visible to this bot" (server-scoped via `User.sharing_rooms_with`) — agent surfaces verbatim |
| **Notes** | Backs the `member-info` agent action. **Of all GET endpoints, this is the only one that consumes the four social URL fields.** A refactor that removes them would simplify the wire but reduces what the agent surfaces. |

### 7.3 `GET /autocompletable/users`

| | |
|---|---|
| **Caller** | `src/client.ts:387 searchUsers({ query?, roomId? })` |
| **Query params** | `query` (prefix match server-side via `User.matching`), `room_id` |
| **Response — fields read** | `SabhaUser[]` (same fields as 7.1) |
| **Notes** | Backs the directory adapter's `listPeersLive` slot (autocomplete UX) and the channel resolver's name → id lookup for users. Server-side limit is hardcoded to 20. |

---

## 8. Direct messages

### 8.1 `POST /direct_messages`

| | |
|---|---|
| **Caller** | `src/client.ts:403 createDm(userIds)` |
| **Wire body** | `{ user_ids: number[] }` JSON; `Content-Type: application/json` |
| **Response — fields read** | `{ room: { id: number } }` — only the nested `room.id` is consumed |
| **Status semantics** | 200/201 |
| **Notes** | Backs the `sabha_create_dm` agent tool (one of two surviving registerTool factories). Sabha doesn't auto-create DMs on first send like Slack/Discord, so this verb has to be explicit. |

---

## 9. Bot profile

### 9.1 `PATCH /profile`

| | |
|---|---|
| **Caller** | `src/client.ts:460 updateSettings({ name?, webhook_url? })` |
| **Wire body** | `{ name?: string, webhook_url?: string }` JSON; `Content-Type: application/json` |
| **Response — fields read** | none |
| **Status semantics** | 200/204 |
| **Notes** | Plugin sets `webhook_url` in legacy/test paths only; today's runtime is WebSocket-only. The auth-bearer test suite exercises this endpoint to confirm the bearer header lands. Refactors are safe to ignore the `webhook_url` field if webhook delivery is being deprecated. |

---

## 10. Cable (WebSocket)

The runtime inbound path is **WebSocket-only**. There is no webhook / no polling.

### 10.1 Connection

| | |
|---|---|
| **Caller** | `src/monitor.ts:153 buildWebSocketUrl(baseUrl, botKey, websocketUrl?)` |
| **URL** | If `websocketUrl` from registration is set, used verbatim. Otherwise derived: `wss://<host>/cable?bot_key=<key>[&wid=<workspace_id>]` (workspace id parsed from a 7+ digit path prefix on `baseUrl`). |
| **Auth** | `bot_key` query param — **the one place the bot key still rides in a URL.** A refactor that moves cable auth to a header would close the last credential-in-URL path. |
| **Notes** | `wid` is appended for multi-tenant SaaS mode (e.g. `https://sabha.co/1000006/...`). Single-tenant deployments don't see it. |

### 10.2 `BotEventsChannel` subscribe

| | |
|---|---|
| **Caller** | `src/monitor-websocket.ts:14 BOT_EVENTS_IDENTIFIER` |
| **Subscribe identifier** | `{"channel":"BotEventsChannel"}` |
| **Lifecycle** | Subscribe on `welcome`; reject on `reject_subscription` raises `BotEventsChannelRejectedError` (treated as auth failure — bot key invalid) |
| **Inbound events consumed** | 7 types: `message_created`, `message_updated`, `message_deleted`, `boost_created`, `boost_deleted`, `user_created`, `user_deleted` (parsed in `src/webhook.ts:parseWebhookPayload`) |
| **Payload fields read per event** | See `SabhaWebhookPayload` in `src/types.ts:237-244`. Critically: `room.{id, type, has_bot, messages_url, members}`, `message.{id, body, attachment, has_attachment, mentionees, thread, created_at, updated_at, url}`, `user.{id, name, role}`, `boost.{id, body}` (boost events only) |
| **Notes** | The plugin only **dispatches** on `message_created`; the other six event types currently fall through to log-only handlers. A refactor that removes any of the seven event names from the channel breaks runtime ingestion (for `message_created`) or the parser (for the others — the discriminated-union schema will reject unknown events). The `room.has_bot` field is read by `wasBotMentioned` to filter group-room messages where the bot wasn't mentioned. The `message.thread` field drives session routing for thread context. |

### 10.3 `TypingNotificationsChannel` subscribe + whisper

| | |
|---|---|
| **Caller** | `src/typing.ts:37 buildTypingIdentifier`, `src/typing.ts:201 whisper` |
| **Subscribe identifier** | `{"channel":"TypingNotificationsChannel","room_id":<id>}` (one per room the bot is typing in) |
| **Whisper command** | `{"command":"whisper","identifier":<typing-identifier>,"data":{"action":"start"\|"stop","user":{"id":<botId>,"name":<botName>}}}` |
| **Notes** | Whispers go through AnyCable-Go directly to other subscribers (no Rails round-trip). The plugin matches Sabha's browser-side `typing_notifications_controller.js` shape — if the JS controller's payload changes, this whisper shape has to track it. The plugin **does not consume** typing whispers from other users. Refresh interval defaults to a SDK-supplied value; whispers are silently dropped if sent before `confirm_subscription`, so the plugin queues until confirmed. |

---

## 11. Setup-only (unauthenticated)

These two endpoints are outside `/api/bots` and are touched **only by the setup wizard** (`src/setup-wizard.ts`). Runtime never calls them.

### 11.1 `GET {baseUrl}/skill`

| | |
|---|---|
| **Caller** | `src/setup-wizard.ts:212 probeBaseUrl(baseUrl)` |
| **Auth** | none |
| **Response — fields read** | response body must be non-empty plain text and **must not** start with `<!doctype` / `<html` / `<head` / `<body>` |
| **Notes** | Used to distinguish "wrong URL" from "wrong bot key" before saving config — a bad URL fails here, a bad key fails later in `probeBotKey`. The body content itself is discarded after the HTML-vs-text classification. A refactor that makes `/skill` return JSON or HTML would break this probe; if `/skill` is being moved or removed, the plugin needs an alternative URL-validity probe. |

### 11.2 `POST {baseUrl}/join/:code`

| | |
|---|---|
| **Caller** | `src/setup-wizard.ts:75 selfRegisterBot(baseUrl, joinCode, params)` |
| **Auth** | none (the join code is the credential) |
| **Wire body** | `{ name: string, webhook_url?: string }` JSON; `Accept: application/json` |
| **Response — fields read** | `bot_key`, `name`, `webhook_url`, `base_url`, `api_base_url`, `websocket_url`, `rooms?: SabhaRoom[]` |
| **Error body fields** | on non-2xx: `error`, `code` (parsed if response is JSON; otherwise the status text is used) |
| **Notes** | This is **the registration handshake** — every other field downstream of setup (`apiBaseUrl`, `botKey`, optional `websocketUrl`) is sourced from this response. A refactor that renames any of the seven response fields breaks first-time setup. The optional `rooms` field, when present, is shown to the user as "rooms granted by the join code" but the plugin doesn't store it (it re-lists via `GET /rooms` for auto-join). |

---

## 12. Out-of-band fetches

These don't touch the bot API but the plugin makes them based on data delivered by the bot API.

### 12.1 Attachment download

| | |
|---|---|
| **Caller** | `src/inbound.ts:137` (via SDK `channel.media.fetchRemoteMedia`) |
| **URL source** | `payload.message.attachment.url` from a `message_created` cable event |
| **Auth** | none — Sabha returns signed URLs in the webhook payload that authenticate the download |
| **Notes** | Signed URLs expire ~1h, which is why download happens immediately on inbound rather than lazily before delivery. SSRF policy comes from the per-account config (`allowPrivateAttachmentHosts`). The plugin **does not** download attachments via the bot API; it always uses the URL the server hands it. |

---

## What changed in the recent migration (2026.4.29)

Four things in case the refactor brief assumes the older shape:

1. **Mutating message ops moved to id-only paths** (`b67fc38`). The plugin no longer sends `room_id` in the URL for PATCH / DELETE / boost create / boost delete. Server resolves the room from the message id.

2. **`replyInThread` is gone** (`e2be713`). Threading is expressed as `parent_message_id` query param on the regular `POST /rooms/:room_id/messages`. The dedicated `POST /rooms/:room_id/messages/:message_id/thread` endpoint is no longer called by the plugin.

3. **Boost aggregation moved to id-only.** `GET /rooms/:room_id/messages/:message_id/boosts` is no longer called; the plugin uses `GET /messages/:message_id/boosts`. Server resolves the room from the message id.

4. **`POST /rooms/:room_id/messages` returns `{ id, room_id }` uniformly.** Both non-thread and thread sends return the same body shape; the plugin's `parseSendResponse` (`src/client.ts:155`) reads it without branching. (The Location header is still emitted — purely for HTTP semantics, the plugin no longer parses it.)

---

## What the plugin does **not** use (so a refactor here is invisible to us)

- `POST /rooms/:room_id/messages/:message_id/thread` — the dedicated thread-create endpoint; superseded by `parent_message_id` (see Section 1.1).
- Any room-scoped mutating endpoint: `PATCH /rooms/:room_id/messages/:id`, `DELETE /rooms/:room_id/messages/:id`, `POST /rooms/:room_id/messages/:message_id/boosts`, `DELETE /rooms/:room_id/messages/:message_id/boosts/:boost_id` — replaced by id-only forms (see Section 2).
- `GET /rooms/:room_id/messages/:id` (single message read) — never called.
- `GET /rooms/:room_id/members` — channel-admin tools that needed it were dropped in `2026.4.29`.
- Every member-management endpoint (`POST /rooms/:room_id/members`, `DELETE /rooms/:room_id/members/:user_id`) — same drop.
- Room create / archive endpoints — same drop.

If the refactor is removing those, the plugin needs no change.

---

## Refactor-flag list (places where a server change WOULD break the plugin)

In rough order of "how silent would the breakage be":

1. **Renaming a field consumed by the plugin** — silent until runtime. Ones with the most blast radius: `id` / `room_id` in the body of 1.1 and 1.2; `body.{html,plain}` in 2.1's edit response and 4.1's read; `id` on 2.3's boost create.
2. **Changing 5.1 / 4.1 to omit `has_more` or `next_cursor`** — envelope guards throw, but the cursor walks the agent does become stale.
3. **Dropping the JSON body on `POST /messages`** — the plugin no longer reads the Location header, so a regression that returned to the body-only-when-opted-in shape would surface as `messageId: null` in agent details and break streaming.
4. **`/skill` removed or reshaped** — wizard URL probe breaks; setup gets noisier but runtime still works.
5. **Cable URL structure (`/cable?bot_key=...&wid=...`)** — runtime won't connect.
6. **`BotEventsChannel` event name set** — parser rejects unknown events; runtime stops dispatching the renamed type.
7. **`TypingNotificationsChannel` whisper data shape** — the plugin's typing UX silently degrades (other users stop seeing the indicator).
8. **`POST /join/:code` response field rename** — first-time setup breaks; existing bots keep working until their `bot_key` is rotated.
