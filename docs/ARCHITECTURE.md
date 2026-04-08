# Architecture

## Overview

`@sabha/openclaw-sabha` is a channel plugin that connects OpenClaw to Sabha's Bot API. It follows the webhook-push model (similar to Telegram in webhook mode) — Sabha pushes events to the plugin, and the plugin replies via Sabha's REST API.

```
Sabha Server                          OpenClaw Gateway
-----------                           ----------------

User sends message
  |
  v
Webhook POST ───────────────────────> /sabha/webhook
  (event, user, room, message)            |
                                          v
                                    Parse payload
                                    Download attachments (signed URLs)
                                    Resolve session (room -> OpenClaw session key)
                                    Dispatch to OpenClaw reply pipeline
                                          |
                                          v
                                    LLM processes message
                                          |
                                          v
                                    outbound.sendText() / sendMedia()
                                          |
POST /rooms/{id}/{bot_key}/messages <─────┘
  |
  v
Message appears in Sabha
```

## File Structure

```
index.ts                Entry point — defineChannelPluginEntry
                        Registers webhook HTTP route, agent tools, /skill fetch
                        Wires runtime, config, and delivery

setup-entry.ts          Setup entry — defineSetupPluginEntry
                        Used by OpenClaw's setup wizard

src/
  channel.ts            Plugin object — createChatChannelPlugin
                        Declares capabilities, config, security, threading,
                        outbound adapters, agent prompt hints

  client.ts             Sabha REST API client
                        All Bot API endpoints, typed responses
                        Auth via bot_key in URL path (not headers)

  types.ts              TypeScript types for Sabha API
                        Webhook payloads, rooms, messages, members, config

  webhook.ts            Webhook payload parser and helpers
                        Validates structure, resolves chat type, mention detection

  session.ts            Session/conversation routing
                        Maps Sabha rooms/threads/DMs to OpenClaw session keys

  inbound.ts            Inbound message processor
                        Downloads attachments, builds context envelope,
                        dispatches to OpenClaw reply pipeline via PluginRuntime

  tools.ts              Agent tools (registered via api.registerTool)
                        Room CRUD, member management, search, DMs

  skill-prompt.ts       /skill endpoint fetcher
                        Caches Sabha's LLM-readable API docs for prompt injection

  client.test.ts        Tests for client helpers, webhook parser, session routing
```

## Key Design Decisions

### Webhook push, not polling

Sabha pushes events to the plugin's HTTP endpoint. The plugin never polls. This matches Sabha's webhook model and keeps the plugin stateless.

### No auto-reply mode

Sabha supports returning text in the webhook HTTP response body for simple bots. This plugin does NOT use that — OpenClaw needs async LLM processing, so we always return `200` immediately and use the REST API for replies. The auto-reply shortcut is incompatible with the time an LLM takes to generate a response.

### Immediate attachment download

Sabha's webhook payloads include signed attachment URLs that expire after 1 hour. The plugin downloads attachments immediately on inbound using `runtime.channel.media.fetchRemoteMedia` + `saveMediaBuffer`, before the URL expires. The saved media path is appended to the message body for the LLM.

### Bot key in URL path

Sabha authenticates bots via `bot_key` in the URL path (e.g., `/rooms/5/42-AbCdEfGhIjKl/messages`), not via `Authorization` headers. The `SabhaClient` embeds the key in every request URL.

### Pre-configured bot key

The bot key is set in OpenClaw's config file, not obtained via auto-registration. Registration is a one-time admin action — either via the Sabha admin UI (`/account/bots`) or via the self-registration API (`POST /join/{code}`).

### Agent tools for workspace management

Room creation, member management, and search are exposed as agent tools (registered via `api.registerTool()`), not message actions. These are workspace-level operations — the agent can decide to create a room, add members, or search history as part of its reasoning.

### /skill prompt injection

On startup, the plugin fetches Sabha's `/skill` endpoint (an LLM-readable API reference) and injects it into the agent's prompt context via `agentPrompt.messageToolHints`. This gives the agent full knowledge of the platform's capabilities without hardcoding documentation.

## Data Flow

### Inbound (Sabha -> OpenClaw)

1. **Sabha** fires a webhook to `/sabha/webhook` with the event payload
2. **index.ts** parses the JSON body via `parseWebhookPayload()`
3. **inbound.ts** `processInboundMessage()`:
   - Skips messages from the bot itself
   - In groups, skips unless the bot was @mentioned
   - Downloads any attachment immediately
   - Resolves the agent route via `runtime.channel.routing.resolveAgentRoute()`
   - Builds an inbound context envelope via `runtime.channel.reply.formatAgentEnvelope()`
   - Dispatches via `dispatchInboundReplyWithBase()` which records the session and runs the LLM reply pipeline
4. **deliver callback** in index.ts sends the LLM's reply back to Sabha via `SabhaClient`

### Outbound (OpenClaw -> Sabha)

Two paths:

**A. Via reply pipeline** (automatic replies to webhook events):
- The `deliver` callback in index.ts calls `client.sendMessage()` or `client.replyInThread()`

**B. Via outbound adapter** (OpenClaw's `message` tool):
- `outbound.attachedResults.sendText()` calls `client.sendMessage()` or `client.replyInThread()`
- `outbound.attachedResults.sendMedia()` downloads the media URL and calls `client.sendAttachment()`

**C. Via agent tools** (workspace management):
- Tools like `sabha_create_room`, `sabha_add_member` call `SabhaClient` methods directly

### Session Routing

Sabha rooms map to OpenClaw session keys:

| Sabha context | OpenClaw session key |
|---------------|---------------------|
| Open/Closed room | `sabha:group:{room_id}` |
| Direct message | `sabha:direct:{room_id}` |
| Thread | `sabha:group:{room_id}:thread:{thread_id}` |

Thread context is extracted from the webhook payload's `message.thread` field. The `parentConversationCandidates` array allows OpenClaw to find the parent session.

## Configuration

```json5
{
  channels: {
    sabha: {
      enabled: true,
      baseUrl: "https://chat.example.com",  // Sabha server URL
      botKey: "42-AbCdEfGhIjKl",            // Bot key (secret)
      webhookPort: 8787,                     // Port for inbound webhooks
      dmPolicy: "open",                      // "open" or "allowlist"
      allowFrom: []                          // User IDs allowed to DM (when policy is "allowlist")
    }
  }
}
```

## Dependencies

- `openclaw` — Plugin SDK (`openclaw/plugin-sdk/channel-core`, `channel-inbound`, `inbound-reply-dispatch`, `account-helpers`)
- `@sinclair/typebox` — Agent tool parameter schemas (transitive via openclaw)
- No other runtime dependencies. The plugin uses `globalThis.fetch` for HTTP.
