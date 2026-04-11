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

- `index.ts` — `defineChannelPluginEntry`. Stores the `PluginRuntime` in a module-scope `pluginRuntime`, registers agent tools, fetches `/skill` from the Sabha server for prompt injection, and registers the `/sabha/webhook` HTTP route (used only in webhook mode). This is the **full** runtime entry.
- `setup-entry.ts` — `defineSetupPluginEntry`. Used only by `openclaw configure` so the setup wizard can load without the whole gateway. Keep it lightweight; do not import monitor/gateway code from here.
- `src/channel.ts` — `createChatChannelPlugin(...)`. The plugin object itself: capabilities, config schema, DM security policy, outbound adapters (`sendText`/`sendMedia`), the `gateway.startAccount` hook that launches the WebSocket monitor, and `agentPrompt.messageToolHints` that injects the cached `/skill` text.

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

There are **three** outbound code paths, and new features often need to touch all of them to stay consistent:

1. **Reply pipeline `deliver` callback** (automatic reply to an inbound event) — the lambda passed into `processInboundMessage` from `index.ts` and `monitor.ts`. In 0.9.2+ this lambda also receives a per-turn `SabhaDraftStream` and its finalization branches on `draftStream.isAlive()` — see "Streaming agent replies" below for the full contract before changing anything in the finalize path.
2. **`outbound.attachedResults.sendText` / `sendMedia`** on the plugin object in `src/channel.ts` — invoked by OpenClaw core's shared `message` tool.
3. **Agent tools** in `src/tools.ts` (`sabha_list_rooms`, `sabha_create_room`, `sabha_add_member`, `sabha_search`, etc.) — invoked directly by the LLM. These hit `SabhaClient` methods with no reply-pipeline involvement.

All three ultimately go through `SabhaClient` (`src/client.ts`), which authenticates by embedding `bot_key` in the URL path (e.g. `/rooms/5/42-AbCdEfGhIjKl/messages`), **not** via an `Authorization` header. Do not add header auth.

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

**Error copy must be redacted.** `SabhaApiError.message` interpolates the fetch URL, and `SabhaClient` embeds `bot_key` in the URL path (`/rooms/5/42-AbCdEfGhIjKl/messages`). Never do `draftStream.update(String(err))` or paste a raw error into a user-visible surface — use `formatStreamError(err)` exported from `src/draft-stream.ts`. It redacts `\d{1,8}-[A-Za-z0-9]{10,}` patterns (deliberately narrow to avoid over-redacting commit hashes, port numbers, timestamps) and truncates to 500 chars. Also used by the stream's internal warn logs so bot keys don't leak into operator logs either.

**Thread replies skip streaming** in 0.9.2. Thread sub-room id discovery would require a first `replyInThread` round-trip before edits can target the thread — the non-streaming path is retained for threads until that's worth the complexity.

### `/skill` prompt injection

On startup, `src/skill-prompt.ts` fetches the Sabha server's `/skill` endpoint (an LLM-readable API reference) and caches the text. `channel.ts`'s `agentPrompt.messageToolHints` reads it via `getCachedSkillText()` and appends it to the agent's prompt so the agent "knows" the Sabha API without the plugin hardcoding docs. If you add a new capability, prefer extending agent tools + letting `/skill` describe them over stuffing instructions into the plugin code.

### Design decisions worth knowing before changing things

- **No webhook auto-reply**. Sabha supports returning text in the HTTP response body of a webhook, but this plugin always returns `200` immediately because LLM replies are async and can take 30+s. Don't try to "simplify" by reintroducing sync reply.
- **No polling**. Inbound is push-only (WS or webhook).
- **Multi-bot-account is supported.** Config is keyed as `channels.sabha` in `~/.openclaw/openclaw.json`, and the base block can be extended with a `botAccounts: Record<id, Partial<SabhaConfig>>` map plus an optional `defaultBotAccount`. `src/bot-accounts.ts` layers each `botAccounts.<id>` entry over the base block; `listBotAccountIds`, `resolveBotAccount`, and `listEnabledBotAccounts` are wired into the SDK's `listAccountIds` / `resolveAccount` slots so `gateway.startAccount` spins up one monitor per bot. Legacy single-bot configs still work unchanged — the base block is the `"default"` bot. Each bot has its own `baseUrl`, `botKey`, `botName`, `connectionMode`, `websocketUrl`, `dmPolicy`, `allowFrom`, `typingEnabled`. Workspace multi-tenancy can additionally be expressed via a numeric path prefix on `baseUrl` (e.g. `https://sabha.co/1000006`). There is **no per-agent persona mapping** (agent→bot); the bot that replies is whichever one's `botKey` received the inbound event. The webhook fallback route currently resolves to the default bot only — per-bot routes at `/sabha/webhook/:botAccountId` are v1.1 work.
- **Dedup is FIFO, not LRU** — insertion order eviction. The comment in `src/dedup.ts` was recently corrected; keep it accurate.

## Reference: related checkouts

The user's auto-memory records that `/Users/ashwin/dev/openclaw/extensions` contains reference sources for other OpenClaw channel plugins. Prefer grepping that tree for prior art (Telegram, Slack, Discord patterns) before inventing new conventions here.

## Docs in this repo

- `docs/ARCHITECTURE.md` — longer-form architecture, including a Sabha↔plugin diagram.
- `docs/TYPING.md` — whisper protocol, channel lifecycle, future presence-indicator plan.
- `docs/sdk-overview.md`, `sdk-channel-plugins.md`, `sdk-entrypoints.md` — vendored snapshots of the OpenClaw plugin SDK docs. Consult these before guessing at SDK surface; the live SDK types in `node_modules/openclaw/plugin-sdk/*` are authoritative if the two disagree.
