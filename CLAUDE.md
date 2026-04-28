# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`@sabha-co/openclaw-sabha` — an OpenClaw channel plugin that connects OpenClaw agents to Sabha chat servers. It speaks to Sabha's Bot REST API for outbound and prefers an outbound **WebSocket** (ActionCable/AnyCable `/cable`) for inbound events, falling back to an inbound **webhook** HTTP route. No reverse proxy or public IP is required in WebSocket mode.

The plugin is loaded at runtime by the `openclaw` host via `openclaw.plugin.json` and `defineChannelPluginEntry` — it is **not** a standalone app. There is no `main`/`start` script; install into a running OpenClaw gateway with `openclaw plugins install -l .` and restart the gateway.

## Commands

```bash
npm test                              # vitest run (all tests)
npm run test:watch                    # vitest watch
npx vitest run src/inbound.test.ts    # run a single test file
npx vitest run -t "dedups"            # run tests matching name
npm run lint                          # eslint flat config
npm run lint:fix
npm run build                         # tsc -> dist/ (typecheck + emit)
```

There is no dev server. To exercise the plugin end-to-end, install it into a local OpenClaw checkout (`openclaw plugins install -l .`) and `openclaw gateway restart`.

## Module system quirk

`"type": "module"` + `"module": "Node16"`. **All relative imports must use the `.js` extension** even though the files are `.ts` (e.g. `import { SabhaClient } from "./client.js"`). Likewise, cross-package imports from the SDK use subpaths like `openclaw/plugin-sdk/channel-core`. Do not rewrite these to extensionless imports — TypeScript will compile but runtime ESM resolution will fail.

Tests are colocated (`src/foo.test.ts` next to `src/foo.ts`) and excluded from the tsc build via `tsconfig.json`.

## Architecture

Two entry points, three execution paths, one plugin definition.

### Entry points

- `index.ts` — `defineChannelPluginEntry`. Stores the `PluginRuntime` in a module-scope `pluginRuntime`, registers agent tools, and registers the `/sabha/webhook` HTTP route (used only in webhook mode). This is the **full** runtime entry.
- `setup-entry.ts` — `defineSetupPluginEntry`. Used only by `openclaw configure` so the setup wizard can load without the whole gateway. Keep it lightweight; do not import monitor/gateway code from here.
- `src/channel.ts` — `createChatChannelPlugin(...)`. The plugin object itself: capabilities, config schema, DM security policy, outbound adapters (`sendText`/`sendMedia`), the `gateway.startAccount` hook that launches the WebSocket monitor, and `agentPrompt` hints (platform identity preamble + mention syntax in `messageToolHints`, markdown rules in `inboundFormattingHints`).

### Inbound paths

Two ways events reach the plugin:

1. **WebSocket monitor** (default, `connectionMode: "websocket"`). `gateway.startAccount` in `src/channel.ts` calls `monitorSabha()` in `src/monitor.ts`. The monitor opens `/cable?bot_key=...` (workspace id added as `wid` for multi-tenant), subscribes to `BotEventsChannel`, and converts incoming frames into the same `SabhaWebhookPayload` shape that the webhook path produces via `parseWebhookPayload`. Reconnect/backoff lives in `src/reconnect.ts`; WebSocket lifecycle (ping/pong, subscribe races, disconnect classification) lives in `src/monitor-websocket.ts`. Deduplication across reconnects lives in `src/dedup.ts` (FIFO eviction, not LRU — see `dedup.ts` comment).
2. **Webhook route** (fallback, `connectionMode: "webhook"`). `index.ts` registers `POST /sabha/webhook` (auth: `plugin`, 1 MB body cap) and parses via `parseWebhookPayload`.

Both converge on `processInboundMessage` in `src/inbound.ts`, which:
- Skips self-authored messages and (in groups) messages that don't @mention the bot.
- Immediately downloads signed-URL attachments via `runtime.channel.media.fetchRemoteMedia` + `saveMediaBuffer` — signed URLs expire in ~1h, so this must happen before dispatch, not lazily.
- Resolves the agent route, builds an envelope with `runtime.channel.reply.formatAgentEnvelope`, and calls `dispatchInboundReplyWithBase`.
- The `deliver` callback posts the LLM reply back via `SabhaClient.sendMessage` / `replyInThread`.

### Outbound paths

There are **five** outbound code paths, and new features often need to touch the relevant ones to stay consistent:

1. **Reply pipeline `deliver` callback** (automatic reply to an inbound event) — the lambda passed into `processInboundMessage` from `index.ts` and `monitor.ts`. In 0.9.2+ this lambda also receives a per-turn `SabhaDraftStream` and its finalization branches on `draftStream.isAlive()` — see "Streaming agent replies" below for the full contract before changing anything in the finalize path.
2. **`outbound.attachedResults.sendText` / `sendMedia`** on the plugin object in `src/channel.ts` — invoked by OpenClaw core's shared `message` tool when no channel-specific action is selected.
3. **Channel message-action adapter** (`actions.handleAction` in `src/message-actions.ts`, wired in `src/channel.ts`) — Sabha's contribution to the **shared `message` tool**. The agent reaches this by selecting `action: "send" | "edit" | "unsend" | "react" | "thread-reply" | "search" | "member-info"` on the canonical message tool. `member-info` hits `/api/bots/users/:id` to return a rich profile (bio + social URLs) — server-scoped to users sharing rooms with the bot, so a 404 means "not visible" not "doesn't exist". `reply` is intentionally NOT in the action list — `send` with `replyToId` covers implicit reply, `thread-reply` covers explicit (and fails closed if `messageId` is missing). Adding `reply` would either be redundant with `send` or duplicate `thread-reply` with looser semantics; Mattermost omits it for the same reason. Discovery half (`describeMessageTool`) lives in `src/channel.ts` so it sits next to `capabilities`; dispatch half lives in `src/message-actions.ts`. Add new message-action verbs by extending `SUPPORTED_ACTIONS` and `handleAction` together — peers (Mattermost, Slack) follow the same split.
4. **Channel directory adapter** (`directory` in `src/channel.ts`, helpers in `src/directory.ts`) — `listGroups` (rooms), `listPeers` (bot-reachable users via `GET /api/bots/users` — server-side scoped to users sharing rooms with the bot), and `listPeersLive` (autocompletable variant for autocomplete UX). Replaces the old `sabha_list_rooms` / `sabha_search` agent tools so cross-channel verbs ("list conversations", "find user named X") work uniformly. **Add channel/user listing here, not as `registerTool`.** **`listGroupMembers` is intentionally not wired** — Slack/Discord/Mattermost don't wire it either, and dumping a full room roster doesn't scale (a 100k-member room can't be paginated through a single agent call). Agents that need user-in-room context use `member-info` for individual lookups, read mention metadata from inbound payloads, or use `listPeers` with a query at the workspace level. The room-scoped name → id case (`given a roomId + partial name, find the user`) lives on the `sabha_search_members` agent tool — no SDK directory slot models `roomId + query`, and Sabha needs the verb because its inbound only pre-resolves `@{user_id}` mentions. See `docs/READ-ENDPOINT-SCALE-PLAN.md`. When `accountId` is null the adapter resolves through `resolveDefaultSabhaAccountId(cfg)` rather than unioning every enabled account — Sabha can be cross-tenant (different `apiBaseUrl`s = separate workspaces with overlapping room id namespaces), so a union would (a) collide bare numeric ids and (b) hand the agent room ids it cannot subsequently message because the message-action handler runs against one specific account. Mattermost gets away with union-all because it's single-workspace-per-config.

   **Channel resolver** (`resolver.resolveTargets` in `src/channel.ts`, helpers in `src/resolver.ts`) — workspace-level name → id resolution for both users and groups, the SDK slot Discord / Slack / Telegram all wire. Numeric and `@{id}`/`#id` inputs pass through without round-tripping; bare names hit `client.searchUsers({ query })` (users) or filter `client.listRooms()` (groups). One server call is shared across duplicate inputs in a batch via per-call cache. Disabled accounts and missing bot keys fall through `resolveTargetsWithOptionalToken` and surface as unresolved-with-note results.
5. **Agent tools** in `src/tools.ts` (`sabha_create_room`, `sabha_add_member`, `sabha_archive_room`, etc.) — invoked directly by the LLM via `api.registerTool`. **Use this only for room/member admin operations that have no cross-channel analog** (create, archive, add/remove member, join, leave, DM-open, list joinable rooms). Anything that's "send a message" or "list channels/users" belongs in paths 3 or 4 instead — peers (Slack/Discord/Mattermost) don't register any agent tools at all because every operation falls under the message or directory adapters.

All five ultimately go through `SabhaClient` (`src/client.ts`), which authenticates by sending `Authorization: Bearer ${botKey}` on every request. Endpoints live under `apiBaseUrl` (e.g. `https://sabha.co/1000006/api/bots`), which the server returns in the registration response. The WebSocket at `/cable?bot_key=…` still authenticates via query string — that path is unchanged.

### Session routing

Sabha rooms/threads/DMs map to OpenClaw session keys in `src/session.ts`:

| Sabha context    | OpenClaw session key                        |
|------------------|---------------------------------------------|
| Open/Closed room | `sabha:group:{room_id}`                     |
| Direct message   | `sabha:direct:{room_id}`                    |
| Thread           | `sabha:group:{room_id}:thread:{thread_id}`  |

Thread context comes from `message.thread` on the payload. `parentConversationCandidates` lets OpenClaw find the parent session key when resolving a thread reply.

### Typing indicators

`src/typing.ts` + `TypingManager` sends AnyCable **whispers** on the same WebSocket connection used for `BotEventsChannel`, subscribing to `TypingNotificationsChannel` per room and emitting `{action: "start"|"stop", user}` frames while the LLM is generating. Whispers are routed by AnyCable-Go directly between subscribers with no Rails round-trip — do not try to implement this via REST. See `docs/TYPING.md` for protocol details.

### Streaming agent replies

`src/draft-stream.ts`'s `createSabhaDraftStream()` edits one preview message in place as the agent yields partials, instead of waiting for the final turn. It wraps the SDK's `createFinalizableDraftLifecycle` from `openclaw/plugin-sdk/channel-lifecycle` — the same pattern as `extensions/discord/src/draft-stream.ts` and `extensions/telegram/src/draft-stream.ts`. The `onPartialReply` callback is threaded through `processInboundMessage` → `dispatchInboundReplyWithBase.replyOptions`, and gets the **full accumulated text snapshot** on every partial (not a delta). Callers pass the snapshot to `draftStream.update(text)`; the lifecycle helper internally throttles edits to ~500ms / 100 char. The first `update` sends a new message and captures its id; subsequent updates edit that id; `stop()` guarantees a final edit with the latest text.

**Finalization branches on `isAlive()`, not `messageId()`.** In `deliver` (both `monitor.ts` and the webhook path in `index.ts`):
- **Alive + preview exists** → finalize through the SDK loop via `update(finalText) + stop()`. `stop()`'s `flush()` awaits `inFlightPromise`, so if the first partial's `sendMessage` is still in-flight, the final edit correctly queues against the captured preview id.
- **Dead with preview** → bypass the loop and PATCH via direct `client.editMessage`, with a delete+fresh-send fallback.
- **No preview yet** → plain `sendMessage`.

Do **not** gate the fast-path on `draftStream.messageId() !== undefined`. It returns `undefined` during the window where the first send is in flight, and falling through in that window double-posts — the caller posts a second message via plain `sendMessage`, then the in-flight preview lands moments later. Regression test in `src/draft-stream.test.ts` anchors this invariant; see commit `e47974c` for the full narrative.

**Error copy must be redacted.** Since the bearer-auth refactor (`2026.4.25`) the bot_key rides in the `Authorization` header instead of the URL path, so `SabhaApiError.url` no longer interpolates the secret — the primary leak vector is closed. `formatStreamError(err)` in `src/draft-stream.ts` stays as defense-in-depth: it still redacts `\d{1,8}-[A-Za-z0-9]{10,}` patterns (narrow on purpose to avoid over-redacting commit hashes, port numbers, timestamps) and truncates to 500 chars. Use it for anything user-visible or anything that lands in operator logs, since a key can still leak through a manually-constructed error, a third-party integration, or a stray log line.

**Every inbound case streams.** The rule is "stream when the final reply's room id is known up front, or can be resolved on the first send." Three sub-shapes and how they're wired:

- **In-thread inbounds** — Sabha emits `payload.room.id == payload.message.thread.id` for in-thread events (see `app/models/bot/event_payload.rb#thread_to_api` server-side), so `createSabhaDraftStream({ roomId: payload.room.id })` already targets the right room.
- **DMs and top-level non-DM with `replyToMode: "off"`** — final reply lands inline in the same room as the partials, so the stream targets `payload.room.id` and no `firstSend` is needed.
- **Top-level non-DM with `replyToMode: "first" | "all"`** — final reply needs to live in a new thread room id we don't have yet. Both `monitor.ts` and `index.ts` wire a `firstSend` callback that posts the first partial via `client.replyInThread(parentRoomId, userMessageId, text)` and returns `{ roomId: r.thread.id, messageId: r.message.id }` from the response. The stream rebinds its effective room to the captured thread id so all subsequent edits + recovery paths target the thread, not the parent. Sabha's `/thread` endpoint is idempotent via `find_or_create_for`, so a network-drop retry can't fork the thread.

Recovery / error-replace paths in `deliver` MUST read `draftStream.roomId()` rather than `payload.room.id` — once `firstSend` resolves, those values diverge and editing `payload.room.id` would 404 on the message that lives in the thread. The case-(c) fallback in `deliver` (stream dead with no preview ever sent) honors `shouldThread` itself: `replyInThread` if we were supposed to thread, plain `sendMessage` otherwise. Don't drop that branch.

### Agent prompt hints

`src/channel.ts` ships two `agentPrompt` adapters:

- `messageToolHints` — platform identity preamble (`YOU ARE ON SABHA — NOT Discord, Slack, …`) + Sabha mention syntax (`@{user_id}` curly-brace form). **The OpenClaw SDK gates these behind `availableTools.has("message")`** — they vanish from the system prompt on profiles that don't include the `message` tool (e.g. `coding`). Operators on non-`messaging` profiles need `tools.alsoAllow: ["message"]` in `~/.openclaw/openclaw.json`.
- `inboundFormattingHints` — markdown rules (always rendered, except in fast-reply mode).

The plugin previously fetched `/skill` (Sabha's LLM-readable API reference) on startup and injected the 19 KB cached text into `messageToolHints`. That was removed in 2026.4.26 because (a) the SDK gate dropped the entire payload on `coding`-profile gateways, and (b) no other channel plugin in the ecosystem injects platform docs that way — Discord/MSTeams/Feishu/Slack/etc. keep `messageToolHints` to ~3 lines of narrow tool/format hints. The setup wizard still probes `{baseUrl}/skill` to verify a URL points at a Sabha server (response body discarded). See `docs/AGENT-PROMPT-CONTEXT.md` for the full survey + decision record.

If you add a new agent-visible capability, surface it as an agent tool (`src/tools.ts`) — don't try to inject API docs through `messageToolHints`.

### Design decisions worth knowing before changing things

- **No webhook auto-reply**. Sabha supports returning text in the HTTP response body of a webhook, but this plugin always returns `200` immediately because LLM replies are async and can take 30+s. Don't try to "simplify" by reintroducing sync reply.
- **No polling**. Inbound is push-only (WS or webhook).
- **Multi-account is the only shape.** Config is keyed as `channels.sabha` in `~/.openclaw/openclaw.json`. The base block holds shared fields (e.g. `baseUrl`); every bot is declared under `accounts: Record<id, Partial<SabhaConfig>>` with an optional `defaultAccount`. Canonical SDK keys — `accounts:` / `defaultAccount:` — match Feishu / Slack / Discord. `src/accounts.ts` layers each `accounts.<id>` entry over the base block via the SDK's `createAccountListHelpers("sabha")` + `resolveMergedAccountConfig`; `listSabhaAccountIds`, `resolveSabhaAccount`, and `listEnabledSabhaAccounts` are wired into the SDK's `listAccountIds` / `resolveAccount` slots so `gateway.startAccount` spins up one monitor per bot. Each bot has its own `baseUrl`, `botKey`, `botName`, `connectionMode`, `websocketUrl`, `dmPolicy`, `allowFrom`, `typingEnabled`, `replyToMode`. Workspace multi-tenancy can additionally be expressed via a numeric path prefix on `baseUrl` (e.g. `https://sabha.co/1000006`). There is **no per-agent persona mapping** (agent→bot); the bot that replies is whichever one's `botKey` received the inbound event. The webhook fallback route currently resolves to the default bot only — per-bot routes at `/sabha/webhook/:accountId` are v1.1 work. The `index.ts` startup calls `moveSingleAccountChannelSectionToDefaultAccount({ cfg, channelKey: "sabha" })` once so any leftover base-level credentials are auto-promoted into `accounts.default`. The set of keys actually moved is the union of the SDK's static common set and the arrays declared on `sabhaPlugin.setup` — see `src/setup-contract.ts` (`sabhaSingleAccountKeysToMove` covers `botKey` / `baseUrl` / `apiBaseUrl` / `botName` / etc.; `sabhaNamedAccountPromotionKeys` constrains promotion to creds-and-identity when named accounts already exist). Without that contract, the shim is a no-op for Sabha's actual credentials.
- **Dedup is FIFO, not LRU** — insertion order eviction. The comment in `src/dedup.ts` was recently corrected; keep it accurate.
- **Outbound text is markdown → Trix HTML.** Sabha stores message bodies as ActionText rich text (`has_rich_text :body`), so `SabhaClient.sendMessage` / `editMessage` / `replyInThread` run their `text` arg through `markdownToSabhaRichText` from `src/outbound/format.ts` before POST/PATCH. This lives in the client (not the adapter or dispatch layer) because every other wire-contract fact about Sabha's bot API already lives there — bearer-header auth, endpoints under `/api/bots/*`, `Content-Type: text/plain`, the `Location` header convention. All outbound paths (reply pipeline, `outbound.attachedResults.sendText`, agent tools, draft-stream) benefit automatically. See `docs/OUTBOUND-RICH-TEXT.md` for the three Sabha-specific deviations from canonical Trix output (h2–h6 emitted, `<br><br>` paragraph separation, pipe-tables downgraded to `<pre>` because Sabha's sanitizer allowlist doesn't include table tags). The chunker `chunkMarkdownText` in `src/outbound/chunk.ts` splits at markdown block boundaries so code fences and lists don't get torn; it's wired into `outbound.base.chunker` in `src/channel.ts`.

## Reference: related checkouts

The user's auto-memory records that `/Users/ashwin/dev/openclaw/extensions` contains reference sources for other OpenClaw channel plugins. Prefer grepping that tree for prior art (Telegram, Slack, Discord patterns) before inventing new conventions here.

## Docs in this repo

- `docs/ARCHITECTURE.md` — longer-form architecture, including a Sabha↔plugin diagram.
- `docs/TYPING.md` — whisper protocol, channel lifecycle, future presence-indicator plan.
- `docs/AGENT-PROMPT-CONTEXT.md` — how channel context reaches the agent system prompt, peer-plugin survey, why the `/skill` injection was removed.
- `docs/sdk-overview.md`, `sdk-channel-plugins.md`, `sdk-entrypoints.md` — vendored snapshots of the OpenClaw plugin SDK docs. Consult these before guessing at SDK surface; the live SDK types in `node_modules/openclaw/plugin-sdk/*` are authoritative if the two disagree.
