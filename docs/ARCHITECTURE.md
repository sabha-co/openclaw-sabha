# Architecture

## Overview

`@sabha-co/openclaw-sabha` is a channel plugin that connects OpenClaw to Sabha's Bot API. It runs inside the OpenClaw gateway process — not as a standalone service — and supports two inbound transports:

- **WebSocket (default)** — the plugin opens an outbound ActionCable/AnyCable connection to Sabha's `/cable` endpoint and subscribes to `BotEventsChannel`. No public IP, reverse proxy, or tunnel is required.
- **Webhook (fallback)** — Sabha pushes events to the plugin's HTTP route. Requires OpenClaw to be network-reachable from Sabha.

Both transports converge on the same inbound pipeline. Outbound replies always go through Sabha's REST Bot API.

```
Sabha Server                                OpenClaw Gateway
-----------                                 ----------------

User sends message
  |
  v
┌── WebSocket (default) ───────────────┐
│ BotEventsChannel frame               │ ──> monitor.ts
│                                      │      - dedup (FIFO, 5min / 2000 entries)
│                                      │      - typing start (AnyCable whisper)
│                                      │      - parseWebhookPayload (shared shape)
└──────────────────────────────────────┘           |
                                                   v
┌── Webhook (fallback) ────────────────┐     inbound.ts:
│ POST /sabha/webhook                  │ ──> processInboundMessage
│ (event, user, room, message)         │      - skip self / unmentioned
└──────────────────────────────────────┘      - download attachments (signed URLs)
                                              - resolveSessionFromPayload
                                              - formatAgentEnvelope
                                              - dispatchInboundReplyWithBase
                                                   |
                                                   v
                                              LLM processes message
                                                   |
                                                   v
                                              deliver() callback:
                                                   |
POST /rooms/{id}/{bot_key}/messages  <─────────────┘  SabhaClient.sendMessage
  |                                                   / replyInThread
  v
Message appears in Sabha;
WebSocket typing "stop" whisper fires
```

## File Structure

```
index.ts                Full-runtime entry — defineChannelPluginEntry
                        Stores PluginRuntime, registers agent tools,
                        fetches /skill on startup, registers the
                        /sabha/webhook HTTP route (webhook mode only)

setup-entry.ts          Setup-only entry — defineSetupPluginEntry
                        Lightweight; loaded by `openclaw configure`
                        without the gateway / monitor / HTTP stack

src/
  channel.ts            Plugin object — createChatChannelPlugin
                        Capabilities, Zod config schema + UI hints,
                        DM security policy, threading mode, outbound
                        adapters (sendText/sendMedia), gateway.startAccount
                        (launches the WebSocket monitor), agentPrompt
                        hints that inject the cached /skill text

  client.ts             Sabha REST Bot API client
                        All Bot API endpoints, typed responses.
                        Auth via bot_key embedded in the URL path
                        (not Authorization headers). Also exports
                        extractBotId() for pulling the numeric bot ID
                        out of a "42-AbCdEfGhIjKl" key.

  types.ts              TypeScript types: webhook payloads, rooms,
                        messages, members, config, delivery payloads,
                        connection status.

  webhook.ts            Payload parser + helpers
                        parseWebhookPayload, wasBotMentioned,
                        resolveChatType. Used by BOTH the WebSocket
                        monitor and the webhook HTTP route so there is
                        one inbound shape.

  session.ts            Sabha room/thread/DM -> OpenClaw session key
                        resolveSessionFromPayload builds primary and
                        parentConversationCandidates entries.

  inbound.ts            Inbound processor
                        shouldHandleInbound (pre-flight gate reused by
                        the monitor for typing), processInboundMessage
                        (attachment download, envelope build, dispatch).

  monitor.ts            WebSocket monitor orchestration
                        buildWebSocketUrl (http->ws, multi-tenant wid),
                        monitorSabha (dedup, typing, inbound fan-in).

  monitor-websocket.ts  Low-level WebSocket lifecycle
                        createSabhaConnectOnce, ping/pong, subscribe
                        race handling, DisconnectNoReconnectError,
                        SubscriptionRejectedError, connection refs.

  reconnect.ts          runWithReconnect — exponential backoff loop
                        that calls connectOnce, respecting AbortSignal
                        and distinguishing fatal from retryable errors.

  dedup.ts              createDedupCache — FIFO eviction cache (NOT LRU)
                        keyed on message id, used to swallow duplicate
                        frames across WebSocket reconnects.

  typing.ts             TypingManager
                        Subscribes to TypingNotificationsChannel per
                        room on demand and emits AnyCable whispers
                        ({action: "start"|"stop", user}) on the same
                        WebSocket. Rails never sees these frames.

  tools.ts              Agent tools registered via api.registerTool
                        Room CRUD, join/leave, member management,
                        search, DMs (12 tools total).

  skill-prompt.ts       /skill endpoint fetcher + in-memory cache
                        fetchSkillPrompt(baseUrl), getCachedSkillText().
                        Called once on startup from index.ts; read from
                        channel.ts agentPrompt.messageToolHints.

  setup-wizard.ts       sabhaSetupWizard — interactive configure flow.
                        Accepts either a join URL (self-registers via
                        POST /join/{code}) or a pre-existing bot key.

  cli.ts                registerSabhaCli — `openclaw sabha …` subcommands.
                        Lazily imported from registerCliMetadata so CLI
                        metadata capture stays cheap.

  *.test.ts             Colocated Vitest suites. Excluded from tsc build.
```

## Key Design Decisions

### WebSocket default, webhook fallback

WebSocket is the default because it removes the public-IP/tunnel requirement for self-hosted OpenClaw users. Webhook mode remains for deployments that prefer inbound push or where outbound WebSockets are blocked. Both paths are treated as equals below `parseWebhookPayload`, so feature work should rarely branch on transport.

### Single inbound shape via `parseWebhookPayload`

The WebSocket monitor converts `BotEventsChannel` frames into the same `SabhaWebhookPayload` the webhook HTTP route produces, and then calls `processInboundMessage`. This keeps `inbound.ts` transport-agnostic — do not let transport-specific fields leak past `monitor.ts` or `index.ts`.

### No webhook auto-reply

Sabha supports returning text in the webhook HTTP response body for simple bots. The plugin does **not** use that — OpenClaw's LLM processing is async and can take 30+ seconds, well past the webhook response budget. The `/sabha/webhook` handler always returns `200` immediately and the eventual reply goes out via REST.

### Immediate attachment download

Webhook and WebSocket payloads both carry signed attachment URLs that expire after ~1 hour. `processInboundMessage` downloads attachments immediately via `runtime.channel.media.fetchRemoteMedia` + `saveMediaBuffer` before dispatching, and the saved media path is appended to the message body for the LLM. Do not defer this — lazy download will race the signed URL expiry.

### Bot key in URL path, not headers

Sabha authenticates bots by embedding `bot_key` in the URL (e.g., `/rooms/5/42-AbCdEfGhIjKl/messages`). `SabhaClient` handles this; do not add `Authorization` headers on top. The numeric bot ID can be recovered from the key via `extractBotId()`.

### Dedup is FIFO, not LRU

`src/dedup.ts` uses insertion-order eviction, bounded at 2000 entries with a 5-minute TTL. A recent commit corrected a stale LRU comment — keep the behavior and comment aligned.

### Typing indicators via AnyCable whisper

`TypingManager` subscribes to `TypingNotificationsChannel` per room and emits `whisper` commands on the existing WebSocket. Whispers are routed directly by AnyCable-Go between subscribers with no Rails round-trip — do not attempt to implement this over REST. Gated on the pre-flight `shouldHandleInbound` check so we don't type at our own messages or at messages that won't be handled. See `docs/TYPING.md` for the frame-level protocol and future presence-indicator plan.

### `/skill` prompt injection

On startup, `fetchSkillPrompt(baseUrl)` pulls Sabha's LLM-readable API reference and caches it. `agentPrompt.messageToolHints` in `channel.ts` reads the cached text via `getCachedSkillText()` and appends it to the agent's prompt. This lets the agent reason about Sabha API capabilities without the plugin hardcoding documentation — prefer adding agent tools and letting `/skill` describe them over stuffing docs into source.

### Agent tools for workspace management

Room creation, member management, and search are exposed as 12 agent tools registered via `api.registerTool()`, not as message-tool actions. These are workspace-level operations the agent chooses to perform as part of reasoning — not replies.

### Pre-configured bot key

The bot key is stored in `~/.openclaw/openclaw.json`, not obtained at runtime. Registration is a one-time action — either via the Sabha admin UI (`/account/bots`) or via `POST /join/{code}` triggered by the setup wizard.

## Data Flow

### Inbound, WebSocket path (default)

1. **`channel.ts` `gateway.startAccount`** launches `monitorSabha` when `connectionMode === "websocket"` and both `baseUrl` and `botKey` are set.
2. **`monitor.ts`** runs `runWithReconnect` → `createSabhaConnectOnce` (`monitor-websocket.ts`), which opens the `/cable` connection and subscribes to `BotEventsChannel`. Multi-tenant workspaces pass `wid` in the query string (extracted from the numeric path prefix on `baseUrl`).
3. For each incoming frame:
   - `createDedupCache` drops duplicates (FIFO, 5 min TTL, 2000 entries).
   - The frame is normalized via `parseWebhookPayload` into a `SabhaWebhookPayload`.
   - If `shouldHandleInbound(payload, botId)` passes, `TypingManager` starts whispering.
   - `processInboundMessage` runs the shared inbound pipeline.
   - The `deliver` callback posts via `SabhaClient`; `TypingManager` stops whispering.
4. Disconnects classified as `DisconnectNoReconnectError` / `SubscriptionRejectedError` are fatal; everything else triggers backoff via `runWithReconnect`.

### Inbound, webhook path (fallback)

1. **Sabha** POSTs to `/sabha/webhook`.
2. **`index.ts`** reads the body (1 MB cap, `413` if exceeded), parses JSON, and calls `parseWebhookPayload`.
3. On `message_created`, constructs a `SabhaClient` and calls `processInboundMessage` with a `deliver` that sends via REST.
4. Returns `200` immediately; the actual LLM reply posts later out of band.

### Shared inbound pipeline (`processInboundMessage`)

1. Skip if the message author is the bot itself.
2. In groups, skip unless the bot was @mentioned (`wasBotMentioned`).
3. Download each attachment now via `runtime.channel.media.fetchRemoteMedia` + `saveMediaBuffer`; append the saved path to the message body.
4. Resolve the agent route with `runtime.channel.routing.resolveAgentRoute()`.
5. Build the envelope via `runtime.channel.reply.formatAgentEnvelope()` using the session key from `resolveSessionFromPayload`.
6. Dispatch via `dispatchInboundReplyWithBase`, which records the session and runs OpenClaw's reply pipeline.
7. The caller-supplied `deliver` callback handles posting the final reply.

### Outbound paths

There are **three** outbound code paths and they all end up in `SabhaClient`. New features that produce outbound messages usually need to touch each one:

- **A. Reply-pipeline `deliver` callback** — the lambda passed into `processInboundMessage` from both `index.ts` (webhook) and `monitor.ts` (WebSocket). Handles automatic replies to inbound events.
- **B. `outbound.attachedResults.sendText` / `sendMedia`** — plugin-level adapters in `channel.ts` invoked by OpenClaw core's shared `message` tool. `sendMedia` fetches the remote URL into a Blob and calls `client.sendAttachment`.
- **C. Agent tools** in `tools.ts` — invoked directly by the LLM for workspace operations (`sabha_create_room`, `sabha_add_member`, `sabha_search`, …). These bypass the reply pipeline entirely.

### Session routing

| Sabha context        | OpenClaw session key                       |
|----------------------|--------------------------------------------|
| Open/Closed room     | `sabha:group:{room_id}`                    |
| Direct message       | `sabha:direct:{room_id}`                   |
| Thread               | `sabha:group:{room_id}:thread:{thread_id}` |

Thread context is extracted from `message.thread`. `resolveSessionFromPayload` also emits a `parentConversationCandidates` array so OpenClaw can locate the parent room session when resolving a thread reply.

## Configuration

```json5
{
  channels: {
    sabha: {
      enabled: true,
      baseUrl: "https://sabha.co/1000006",  // include workspace id for multi-tenant SaaS
      botKey: "42-AbCdEfGhIjKl",            // secret; stored as-is, used in URL path
      botName: "OpenClaw",                   // shown in typing indicators
      connectionMode: "websocket",           // "websocket" (default) | "webhook"
      websocketUrl: "",                      // optional override; auto-built from baseUrl
      webhookPort: 8787,                     // webhook mode only
      typingEnabled: true,                   // whisper-based typing indicator (WS only)
      dmPolicy: "open",                      // "open" | "allowlist"
      allowFrom: []                          // user ids allowed when policy is "allowlist"
    }
  }
}
```

Multi-tenant note: `buildWebSocketUrl` extracts a 7+ digit path prefix from `baseUrl` and passes it as `wid` on the WebSocket query string.

## Dependencies

- `openclaw` — Plugin SDK. Subpaths used: `plugin-sdk/channel-core`, `plugin-sdk/channel-inbound`, `plugin-sdk/inbound-reply-dispatch`, `plugin-sdk/account-helpers`, `plugin-sdk/channel-config-primitives`, `plugin-sdk/channel-status`, `plugin-sdk/zod`.
- `ws` — Node WebSocket client used by the monitor.
- No other runtime dependencies. HTTP requests use `globalThis.fetch`.

Dev: `vitest`, `typescript`, `eslint` + `typescript-eslint` flat config, `@types/ws`.
