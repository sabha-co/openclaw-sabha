# Architecture

## Overview

`@sabha-co/openclaw-sabha` is a channel plugin that connects OpenClaw to Sabha's Bot API. It runs inside the OpenClaw gateway process — not as a standalone service — and supports two inbound transports:

- **WebSocket (default)** — the plugin opens an outbound ActionCable/AnyCable connection to Sabha's `/cable` endpoint and subscribes to `BotEventsChannel`. No public IP, reverse proxy, or tunnel is required.
- **Webhook (fallback)** — Sabha pushes events to the plugin's HTTP route. Requires OpenClaw to be network-reachable from Sabha.

Both transports converge on the same inbound pipeline via a typed discriminated-union dispatch keyed on `payload.event`. Outbound replies always go through Sabha's REST Bot API.

Since 0.9.0 the plugin supports **multiple bot accounts per install**: one `channels.sabha` config slot can run several bot identities concurrently (e.g. `production` and `staging`), each with its own `baseUrl + botKey + botName`. The SDK drives the lifecycle — `gateway.startAccount` is called once per enabled bot account and the plugin stays stateless across them.

```
Sabha Server                                OpenClaw Gateway
-----------                                 ----------------

User sends message / edits / reacts
  |
  v
┌── WebSocket (default) ───────────────┐
│ BotEventsChannel frame               │ ──> monitor.ts (per bot account)
│  9 event types (see Inbound events)  │      - dedup (FIFO, 5min / 2000 entries,
│                                      │        key = `${event}:${id}`)
│                                      │      - typing start (AnyCable whisper)
│                                      │      - parseWebhookPayload (shared shape)
└──────────────────────────────────────┘           |
                                                   v
┌── Webhook (fallback) ────────────────┐     Typed dispatch by payload.event:
│ POST /sabha/webhook                  │ ──> message_created  → processInboundMessage
│ (event, user, room?, message?)       │      message_updated → handleMessageUpdated
└──────────────────────────────────────┘      message_deleted → handleMessageDeleted
                                              boost_created   → handleBoostCreated
                                              boost_deleted   → handleBoostDeleted
                                              user_created    → handleUserCreated  (stub)
                                              user_deleted    → handleUserDeleted  (stub)
                                                   |
                                                   v  (message_created only)
                                              inbound.ts:
                                                - skip self / unmentioned
                                                - download attachments (signed URLs)
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
  |                                                   (through retry runner:
  |                                                    429/5xx + Retry-After)
  v
Message appears in Sabha;
WebSocket typing "stop" whisper fires
```

## File Structure

```
index.ts                Full-runtime entry — defineChannelPluginEntry
                        Stores PluginRuntime, registers agent tools,
                        fetches /skill per unique bot-account baseUrl
                        on startup, registers the /sabha/webhook HTTP
                        route (webhook mode only) with typed per-event
                        dispatch mirroring the WebSocket monitor.

setup-entry.ts          Setup-only entry — defineSetupPluginEntry
                        Lightweight; loaded by `openclaw configure`
                        without the gateway / monitor / HTTP stack

src/
  channel.ts            Plugin object — createChatChannelPlugin
                        Capabilities, Zod config schema + UI hints
                        (including botAccounts / defaultBotAccount),
                        DM security policy, threading mode, outbound
                        adapters (sendText/sendMedia), gateway.startAccount
                        (launches a WebSocket monitor per bot account),
                        agentPrompt hints that inject the per-workspace
                        /skill text. Wires the bot-account resolver into
                        the SDK via config.resolveAccount / listAccountIds.

  bot-accounts.ts       Multi-bot-account model
                        ResolvedBotAccount type, listBotAccountIds,
                        resolveDefaultBotAccountId, mergeBotAccountConfig,
                        resolveBotAccount, listEnabledBotAccounts,
                        resolveBotAccountForSdk (SDK-boundary shim).
                        Layers `botAccounts.<id>` overrides on top of the
                        base `channels.sabha` block via the SDK's
                        resolveMergedAccountConfig.

  client.ts             Sabha REST Bot API client
                        All Bot API endpoints, typed responses.
                        Auth via bot_key embedded in the URL path
                        (not Authorization headers). Every fetch runs
                        through the Sabha retry runner (429/5xx +
                        Retry-After) with per-attempt AbortSignal
                        rebuild so timeouts don't leak across retries.
                        SabhaApiError exposes `retryable: boolean` so
                        callers can branch without re-importing the
                        predicate. Also exports extractBotId().

  retry.ts              Sabha retry runner
                        Thin wrapper around plugin-sdk/retry-runtime's
                        createRateLimitRetryRunner. Exports:
                          RETRYABLE_STATUS (429, 502, 503, 504),
                          isRetryableSabhaError, sabhaRetryAfterMs,
                          parseRetryAfter (delta-seconds + HTTP-date),
                          createSabhaRetryRunner({ retry?, verbose? }).
                        Defaults: 3 attempts, 500ms..30s exponential
                        backoff, ±20% jitter.

  ssrf-guard.ts         SSRF-safe attachment fetch
                        fetchGuardedAttachment wraps the SDK's
                        plugin-sdk/media-runtime fetchRemoteMedia with
                        a policy derived from
                        ssrfPolicyFromAllowPrivateNetwork. The
                        allowPrivateAttachmentHosts per-bot-account
                        flag is the dangerous-opt-in escape hatch for
                        corporate / split-horizon DNS. Covers
                        attachment downloads only; Sabha's own Bot API
                        baseUrl is operator-configured and trusted by
                        design.

  doctor.ts             runDoctor({ botAccount }) — runtime health checks
                        Config validation, listRooms() API probe,
                        fresh /cable WebSocket subscribe handshake
                        (connect → welcome → subscribe → confirmed),
                        webhook-mode soft-fail. Returns a structured
                        DoctorReport; formatDoctorReport renders
                        human-readable text for the CLI.

  types.ts              TypeScript types: webhook payloads (discriminated
                        union by `event` — all 7 variants), rooms,
                        messages, members, config (botAccounts +
                        defaultBotAccount), delivery payloads,
                        connection status.

  webhook.ts            Payload parser + helpers
                        parseWebhookPayload validates each variant's
                        required shape (user_* omit room/message;
                        message_* require them; boost_* also require
                        boost). Plus wasBotMentioned, resolveChatType.
                        Used by BOTH the WebSocket monitor and the
                        webhook HTTP route so there is one inbound shape.

  session.ts            Sabha room/thread/DM -> OpenClaw session key
                        resolveSessionFromPayload builds primary and
                        parentConversationCandidates entries.

  inbound.ts            Inbound processor + typed event handlers
                        shouldHandleInbound (pre-flight gate reused by
                        the monitor for typing, applies to created/
                        updated/deleted variants so bot self-echoes
                        don't loop). processInboundMessage runs the
                        full reply pipeline for message_created.
                        Typed stubs: handleMessageUpdated,
                        handleMessageDeleted, handleBoostCreated,
                        handleBoostDeleted, handleUserCreated,
                        handleUserDeleted. user_* stubs log at DEBUG
                        and never reach agent-visible surfaces — see
                        the "Event privacy invariant" decision below.

  monitor.ts            WebSocket monitor orchestration
                        buildWebSocketUrl (http->ws, multi-tenant wid),
                        monitorSabha (dedup, typing, typed event
                        dispatch). All state is scoped per invocation
                        so per-bot-account monitors don't collide.
                        Log prefix is `[sabha:<botAccountId>]`.

  monitor-websocket.ts  Low-level WebSocket lifecycle
                        createSabhaConnectOnce, ping/pong, subscribe
                        race handling, DisconnectNoReconnectError,
                        SubscriptionRejectedError, connection refs.

  reconnect.ts          runWithReconnect — exponential backoff loop
                        that calls connectOnce, respecting AbortSignal
                        and distinguishing fatal from retryable errors.

  dedup.ts              createDedupCache — FIFO eviction cache (NOT LRU)
                        keyed on `${event}:${id}` so the same numeric
                        id doesn't collide across create / update /
                        delete / boost variants. Bounded at 2000
                        entries with a 5-minute TTL.

  typing.ts             TypingManager
                        Subscribes to TypingNotificationsChannel per
                        room on demand and emits AnyCable whispers
                        ({action: "start"|"stop", user}) on the same
                        WebSocket. Rails never sees these frames.

  tools.ts              Agent tools registered via api.registerTool
                        Room CRUD, join/leave, member management,
                        search, DMs (12 tools total). Tool factories
                        read `ctx.agentAccountId` at execute time and
                        route through a shared `getClientForTool`
                        helper that resolves the right bot account's
                        client. The bot account id is NOT exposed in
                        tool schemas — the LLM never has to pick one.

  skill-prompt.ts       /skill endpoint fetcher + per-workspace cache
                        fetchSkillPrompt(baseUrl) and
                        getCachedSkillText(baseUrl). Cache is a
                        Map<baseUrl, string> because /skill renders
                        per workspace (template interpolates
                        Current.account.name + request.base_url), so
                        bot accounts sharing a baseUrl share an entry
                        while accounts on different workspaces each
                        get their own. index.ts fetches for every
                        unique baseUrl across listEnabledBotAccounts.

  setup-wizard.ts       sabhaSetupWizard — interactive configure flow.
                        Accepts either a join URL (self-registers via
                        POST /join/{code}) or a pre-existing bot key.
                        Honors the SDK-provided accountId: the default
                        account writes into the base channels.sabha
                        block (zero-migration); named accounts write
                        into channels.sabha.botAccounts.<id> without
                        clobbering the base. status.resolveConfigured
                        and dmPolicy.{getCurrent,setPolicy} also
                        honor accountId.

  cli.ts                registerSabhaCli — `openclaw sabha …` subcommands.
                        Lazily imported from registerCliMetadata so CLI
                        metadata capture stays cheap. Includes the
                        `doctor` subcommand, which iterates every
                        enabled bot account and exits non-zero on any
                        failing check.

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

### Dedup is FIFO, not LRU, and keyed by event+id

`src/dedup.ts` uses insertion-order eviction, bounded at 2000 entries with a 5-minute TTL. A recent commit corrected a stale LRU comment — keep the behavior and comment aligned. Since the typed event dispatch landed in 0.9.0, keys are `${event}:${id}` so a `message_created:42` and `message_updated:42` don't collide — the same numeric message id can legitimately produce frames on multiple event types within the dedup window.

### Typing indicators via AnyCable whisper

`TypingManager` subscribes to `TypingNotificationsChannel` per room and emits `whisper` commands on the existing WebSocket. Whispers are routed directly by AnyCable-Go between subscribers with no Rails round-trip — do not attempt to implement this over REST. Gated on the pre-flight `shouldHandleInbound` check so we don't type at our own messages or at messages that won't be handled. See `docs/TYPING.md` for the frame-level protocol and future presence-indicator plan.

### `/skill` prompt injection, cached per workspace

On startup, `index.ts` calls `fetchSkillPrompt(baseUrl)` for every unique `baseUrl` across enabled bot accounts. `agentPrompt.messageToolHints` in `channel.ts` reads the cached text via `getCachedSkillText(account.baseUrl)` and appends it to the agent's prompt. The cache is a `Map<baseUrl, string>` because `/skill` is rendered per workspace (the ActionText template interpolates `Current.account.name` and `request.base_url`): two bot accounts pointing at the same workspace share an entry, while accounts on different workspaces/servers each get their own.

This lets the agent reason about Sabha API capabilities without the plugin hardcoding documentation — prefer adding agent tools and letting `/skill` describe them over stuffing docs into source.

### Agent tools for workspace management

Room creation, member management, and search are exposed as 12 agent tools registered via `api.registerTool()`, not as message-tool actions. These are workspace-level operations the agent chooses to perform as part of reasoning — not replies.

Tool factories follow the **Feishu pattern**: the bot account id is never in the tool JSON schema — the LLM doesn't see a `bot_account_id` param. Each invocation reads `ctx.agentAccountId` inside `execute` and routes through a shared `getClientForTool(cfg, params, agentAccountId)` helper with precedence `params.accountId ?? agentAccountId ?? resolveDefaultBotAccountId(cfg)`. The `params.accountId` override is an undocumented explicit-routing escape hatch readable at execute time but never advertised, matching Feishu's tested pattern.

### Multi-bot-account model

The plugin supports N bot identities per install. The SDK drives the lifecycle — it calls `gateway.startAccount(ctx)` once per enabled bot account with `ctx.account: ResolvedBotAccount` already resolved. Nothing in the plugin loops over accounts; monitors, outbound adapters, tool routing, the doctor, and the setup wizard all operate on one account at a time and the SDK fans out.

**Config key naming — intentional deviation.** Sabha uses `botAccounts:` and `defaultBotAccount:` instead of the ecosystem-canonical `accounts:` and `defaultAccount:`. The rename exists to avoid colliding with Sabha's own server-side domain concept (multi-tenant workspaces and user accounts): an operator reading `channels.sabha.accounts:` could reasonably assume it referred to Sabha user accounts, not plugin-level bot identities. No other reference plugin (Slack, Discord, Feishu, Mattermost) renames the key, so contributors grepping the ecosystem will find `accounts:` everywhere — treat this deliberate deviation as a cost we accept, not a mistake. The SDK boundary still speaks `accountId` (hardcoded in `gateway.startAccount`, `ctx.agentAccountId`, outbound callbacks) and `bot-accounts.ts` translates locally via `resolveBotAccountForSdk`.

**All bots must be declared under `botAccounts`.** The base `channels.sabha` block holds only shared fields (e.g. `baseUrl`); per-bot overrides in `botAccounts.<id>` layer on top via `mergeBotAccountConfig`. There is no implicit default-account fallback when `botAccounts` is absent.

**`createAccountListHelpers` is deliberately not used.** The SDK helper hardcodes the config path to `channels.<key>.accounts`, which conflicts with the rename. `bot-accounts.ts` hand-rolls a ~10-line list helper using the lower-level `listCombinedAccountIds` + `resolveListedDefaultAccountId` primitives from `plugin-sdk/account-core`. Everything else — `resolveMergedAccountConfig`, `normalizeAccountId`, `DEFAULT_ACCOUNT_ID` — is generic and reused as-is.

### Retry runner + 429 handling

Every HTTP request issued by `SabhaClient.fetch()` runs inside a Sabha-flavored retry runner (`src/retry.ts`), a thin wrapper around `plugin-sdk/retry-runtime`'s `createRateLimitRetryRunner`. Retryable status set is exactly `{429, 502, 503, 504}` — 4xx bugs and 500s are intentionally non-retryable so typos don't turn into retry storms. `Retry-After` is parsed in both forms (delta-seconds and HTTP-date) and surfaced to the runner via `sabhaRetryAfterMs` so the server's hint wins over the client's exponential backoff. Defaults: 3 attempts, 500ms..30s exponential with ±20% jitter.

`SabhaApiError.retryable: boolean` mirrors `isRetryableSabhaError` so callers can branch directly on the flag. `SabhaClientOpts.verbose` plumbs `{verbose: true}` into `createSabhaRetryRunner` when no custom runner is supplied, so operators can flip on per-attempt WARN logging to diagnose a rate-limit storm without touching the SDK.

`client.ts` also rebuilds the combined `AbortSignal` (per-request timeout + client-wide abort + external) on each attempt so a previous attempt's timeout never leaks into the retried request — a subtlety most reference plugins don't handle.

### SSRF guard on attachment downloads

Inbound and outbound attachment fetches go through `fetchGuardedAttachment` (`src/ssrf-guard.ts`), which wraps the SDK's `plugin-sdk/media-runtime` `fetchRemoteMedia` with a policy resolved from `ssrfPolicyFromAllowPrivateNetwork`. The underlying SDK helper pins DNS per fetch, blocks private/loopback/link-local/ULA/IPv4-mapped IPv6 ranges, and blocks the well-known cloud metadata endpoints (`169.254.169.254`, `metadata.google.internal`, etc.) — Sabha delegates all of that.

The per-bot-account `allowPrivateAttachmentHosts: true` config flag is the dangerous-opt-in escape hatch for corporate or split-horizon DNS setups that legitimately need to fetch from RFC1918 addresses. Labeled as `advanced` in the Zod UI hints and documented as dangerous.

**Scope note:** the guard covers attachment downloads only. Sabha's own Bot API `baseUrl` is operator-configured and trusted by design — the plugin does not (and should not) SSRF-guard calls to it, since an attacker who controls `baseUrl` already controls the bot. If a defense-in-depth pass is ever desired, the places to audit are `client.ts`, `setup-wizard.ts` (`POST /join/<code>`), and `skill-prompt.ts` (`GET /skill`).

### Doctor / health checks

`src/doctor.ts` exposes `runDoctor({ botAccount })` which runs four checks per bot account: config validation (baseUrl, botKey shape, connectionMode), API reachability via `listRooms()`, a fresh WebSocket handshake (`connect → welcome → subscribe → confirmed`), and a webhook reachability soft-fail when `connectionMode === "webhook"`. Each check has a bounded timeout (5s WS, 10s API) and reports which phase it failed in.

The doctor is surfaced as the `openclaw sabha doctor [--account <id>]` CLI subcommand, not as a plugin-object field, because the SDK's `ChannelDoctorAdapter` is config-validation only — there is no runtime-probe hook. The CLI loops over every enabled bot account (or the one specified by `--account`) and exits non-zero if any check fails. `warn` and `skip` statuses do not cause a non-zero exit.

### Inbound event taxonomy & privacy invariant

Sabha fires nine events on `BotEventsChannel`, reducing to seven distinct webhook payload shapes (three message-bearing variants share a common shape, two boost variants share one, two user variants share another). The plugin models this as a discriminated union on `payload.event` and dispatches in both `monitor.ts` (WebSocket) and `index.ts` (webhook HTTP route) to keep the two transports in lock-step.

| Event | Handler | Behavior |
|---|---|---|
| `message_created` | `processInboundMessage` | Full reply pipeline |
| `message_updated` | `handleMessageUpdated` | Stateless log (tolerates unseen originals — fans out to all eligible members, not just @mention targets) |
| `message_deleted` | `handleMessageDeleted` | Log |
| `boost_created` | `handleBoostCreated` | Log (Phase 2.2 will intercept for reaction-based approvals) |
| `boost_deleted` | `handleBoostDeleted` | Log |
| `user_created` | `handleUserCreated` | DEBUG-log stub |
| `user_deleted` | `handleUserDeleted` | DEBUG-log stub |

**`shouldHandleInbound` self-echo filter extends to updates and deletes**, not just creates — without this, a bot editing its own message via `Messages::ByBotsController#update` would loop back through its own monitor.

**Privacy invariant on `user_*` events.** The Sabha server fans out `user_created` and `user_deleted` to **every** active bot in a workspace (`notify_bots.rb:19-24`), not scoped to a room or to any bot that cares. The stub handlers MUST NOT forward the payload to any agent-visible surface — that would let bot A observe bot B's user-creation patterns across tenants sharing a workspace. The stubs log at DEBUG and return. Any future welcome-DM / user-state-sync feature must opt in explicitly per bot account via a privacy-reviewed config flag; do not wire it through the shared dispatch path.

### Pre-configured bot key

The bot key is stored in `~/.openclaw/openclaw.json`, not obtained at runtime. Registration is a one-time action — either via the Sabha admin UI (`/account/bots`) or via `POST /join/{code}` triggered by the setup wizard.

## Data Flow

### Inbound, WebSocket path (default)

1. **`channel.ts` `gateway.startAccount`** is called once per enabled bot account by the SDK framework. It launches `monitorSabha` for that account when `connectionMode === "websocket"` and both `baseUrl` and `botKey` are set. The log prefix is `[sabha:<botAccountId>]`.
2. **`monitor.ts`** runs `runWithReconnect` → `createSabhaConnectOnce` (`monitor-websocket.ts`), which opens the `/cable` connection and subscribes to `BotEventsChannel`. Multi-tenant workspaces pass `wid` in the query string (extracted from the numeric path prefix on `baseUrl`).
3. For each incoming frame:
   - `createDedupCache` drops duplicates by `${event}:${id}` (FIFO, 5 min TTL, 2000 entries).
   - The frame is normalized via `parseWebhookPayload` into a `SabhaWebhookPayload` discriminated union.
   - The monitor dispatches by `payload.event`. For `message_created`, `shouldHandleInbound(payload, botId)` gates typing indicators and `processInboundMessage` runs the shared inbound pipeline. For `message_updated` / `message_deleted` / `boost_*`, the typed handler in `inbound.ts` runs (log-only in 0.9.0). For `user_*`, the privacy stub runs at DEBUG level and the payload never reaches agent-visible surfaces.
   - The `deliver` callback posts via `SabhaClient`; `TypingManager` stops whispering.
4. Disconnects classified as `DisconnectNoReconnectError` / `SubscriptionRejectedError` are fatal; everything else triggers backoff via `runWithReconnect`.

### Inbound, webhook path (fallback)

1. **Sabha** POSTs to `/sabha/webhook`.
2. **`index.ts`** reads the body (1 MB cap, `413` if exceeded), parses JSON, and calls `parseWebhookPayload`.
3. On `message_created`, constructs a `SabhaClient` for the default bot account and calls `processInboundMessage` with a `deliver` that sends via REST. The one-route-per-plugin constraint means webhook mode always routes through the default bot account; multi-bot webhook routing would need a path prefix scheme (deferred).
4. On every other event variant, routes to the matching typed handler (`handleMessageUpdated`, `handleBoostCreated`, `handleUserCreated`, …) — the same dispatch table as the WebSocket monitor, with an exhaustive `never` check so adding a new event type to the union fails compilation until the dispatch is extended.
5. Returns `200` immediately; the actual LLM reply posts later out of band.

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

Single-bot:

```json5
{
  channels: {
    sabha: {
      enabled: true,
      baseUrl: "https://sabha.co/1000006",  // shared; include workspace id for multi-tenant SaaS
      botAccounts: {
        default: {
          botKey: "42-AbCdEfGhIjKl",          // secret; stored as-is, used in URL path
          botName: "OpenClaw",                 // shown in typing indicators
          connectionMode: "websocket",         // "websocket" (default) | "webhook"
          dmPolicy: "open",                    // "open" | "allowlist"
        },
      },
    }
  }
}
```

Multi-bot. Named accounts under `botAccounts.<id>` layer over the base, so unset fields on a named account inherit from the base:

```json5
{
  channels: {
    sabha: {
      enabled: true,
      // Shared base — inherited by every bot unless overridden
      baseUrl: "https://sabha.co/1000006",
      botAccounts: {
        default: {
          botKey: "42-prodkey",
          botName: "OpenClaw",
        },
        staging: {
          baseUrl: "https://staging.sabha.co/1000006",
          botKey: "17-stagingkey",
          botName: "OpenClaw (staging)",
        },
        "prod-eu": {
          botKey: "23-eukey",
          // baseUrl / botName inherited from base
        },
      },
      defaultBotAccount: "default",  // optional; alphabetic-first otherwise
    }
  }
}
```

Note the intentional `botAccounts:` / `defaultBotAccount:` naming — see the "Multi-bot-account model" decision above for why this deviates from the ecosystem-canonical `accounts:` / `defaultAccount:`.

Multi-tenant note: `buildWebSocketUrl` extracts a 7+ digit path prefix from `baseUrl` and passes it as `wid` on the WebSocket query string.

## Dependencies

- `openclaw` — Plugin SDK. Subpaths used:
  - `plugin-sdk/channel-core` — `createChatChannelPlugin`, `defineChannelPluginEntry`, `PluginRuntime`
  - `plugin-sdk/channel-setup` — `ChannelSetupWizard`
  - `plugin-sdk/channel-inbound` + `plugin-sdk/inbound-reply-dispatch` — shared inbound dispatch
  - `plugin-sdk/account-core` — `DEFAULT_ACCOUNT_ID`, `normalizeAccountId`, `listCombinedAccountIds`, `resolveListedDefaultAccountId`, `resolveMergedAccountConfig`
  - `plugin-sdk/channel-config-primitives` — `buildChannelConfigSchema`
  - `plugin-sdk/channel-status` — `createDefaultChannelRuntimeState`, `buildBaseChannelStatusSummary`
  - `plugin-sdk/retry-runtime` — `createRateLimitRetryRunner`, `RetryRunner`
  - `plugin-sdk/media-runtime` — `fetchRemoteMedia` (wrapped by `ssrf-guard.ts`)
  - `plugin-sdk/ssrf-runtime` — `ssrfPolicyFromAllowPrivateNetwork`
  - `plugin-sdk/zod`
- `ws` — Node WebSocket client used by the monitor.
- No other runtime dependencies. HTTP requests use `globalThis.fetch`.

Dev: `vitest`, `typescript`, `eslint` + `typescript-eslint` flat config, `@types/ws`.
