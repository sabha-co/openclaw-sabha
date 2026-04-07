# Building Channel Plugins

> Source: https://docs.openclaw.ai/plugins/sdk-channel-plugins

## Core Architecture

Channel plugins connect OpenClaw to messaging platforms while leveraging a shared `message` tool owned by core.

**Plugin responsibilities:**
- Account resolution and configuration
- DM security policies and allowlists
- Pairing/approval flows for new contacts
- Session conversation mapping
- Outbound message delivery (text, media, polls)
- Reply threading behavior

**Core responsibilities:**
- Shared message tool
- Prompt wiring
- Session-key structure
- Generic thread bookkeeping
- Message dispatch

## createChatChannelPlugin Builder

```typescript
export const acmeChatPlugin = createChatChannelPlugin<ResolvedAccount>({
  base: createChannelPluginBase({
    id: "acme-chat",
    setup: { resolveAccount, inspectAccount },
  }),
  security: { dm: { /* ... */ } },
  pairing: { text: { /* ... */ } },
  threading: { topLevelReplyToMode: "reply" },
  outbound: { attachedResults: { sendText }, base: { sendMedia } },
});
```

**What it wires:**
- `security.dm` → DM security resolver from config
- `pairing.text` → Text-based pairing with code exchange
- `threading` → Reply-to-mode resolver
- `outbound.attachedResults` → Send functions returning message IDs

## Setup Configuration

```typescript
function resolveAccount(cfg: OpenClawConfig, accountId?: string | null) {
  const section = cfg.channels?.["acme-chat"];
  return {
    accountId: accountId ?? null,
    token: section?.token,
    allowFrom: section?.allowFrom ?? [],
    dmPolicy: section?.dmSecurity,
  };
}

inspectAccount(cfg, accountId) {
  const section = cfg.channels?.["acme-chat"];
  return {
    enabled: Boolean(section?.token),
    configured: Boolean(section?.token),
    tokenStatus: section?.token ? "available" : "missing",
  };
}
```

## Outbound Adapters

### sendText (attachedResults)

```typescript
outbound: {
  attachedResults: {
    sendText: async (params) => {
      const result = await acmeChatApi.sendMessage(params.to, params.text);
      return { messageId: result.id };
    },
  },
}
```

### sendMedia (base)

```typescript
outbound: {
  base: {
    sendMedia: async (params) => {
      await acmeChatApi.sendFile(params.to, params.filePath);
    },
  },
}
```

### Lifecycle Hooks

- `outbound.shouldSuppressLocalPayloadPrompt` — Hide duplicate approval prompts
- `outbound.beforeDeliverPayload` — Send typing indicators before delivery

## DM Security

```typescript
security: {
  dm: {
    channelKey: "acme-chat",
    resolvePolicy: (account) => account.dmPolicy,
    resolveAllowFrom: (account) => account.allowFrom,
    defaultPolicy: "allowlist",
  },
}
```

## Threading

```typescript
threading: { topLevelReplyToMode: "reply" }
```

Values: `"reply"` (native reply/threading), `"quote"` (quote original), or custom resolver.

## Session Routing

```typescript
messaging.resolveSessionConversation(rawId): {
  baseConversationId: string;
  threadId?: string;
  parentConversationCandidates?: Array<string>;
}
```

Return `parentConversationCandidates` ordered from narrowest to broadest parent.

## Inbound Message Handling

### Two-Layer Architecture

**Plugin layer:** Gather evidence (reply detection, mention parsing, thread checks)
**Shared layer:** Apply policy (requireMention, allowlists, command bypass)

### Mention Decision Pattern

```typescript
import { 
  resolveInboundMentionDecision,
  matchesMentionWithExplicit,
  implicitMentionKindWhen,
} from "openclaw/plugin-sdk/channel-inbound";

const facts = {
  canDetectMention: true,
  wasMentioned: mentionMatch.matched,
  hasAnyMention: mentionMatch.hasExplicitMention,
  implicitMentionKinds: [
    ...implicitMentionKindWhen("reply_to_bot", isReplyToBot),
    ...implicitMentionKindWhen("quoted_bot", isQuoteOfBot),
  ],
};

const decision = resolveInboundMentionDecision({
  facts,
  policy: {
    isGroup,
    requireMention,
    allowedImplicitMentionKinds: requireExplicitMention ? [] : ["reply_to_bot"],
    allowTextCommands,
    hasControlCommand,
    commandAuthorized,
  },
});

if (decision.shouldSkip) return;
```

### Webhook Handler

```typescript
registerFull(api) {
  api.registerHttpRoute({
    path: "/acme-chat/webhook",
    auth: "plugin",
    handler: async (req, res) => {
      const event = parseWebhookPayload(req);
      await handleAcmeChatInbound(api, event);
      res.statusCode = 200;
      res.end("ok");
      return true;
    },
  });
}
```

## Plugin Entry Points

```typescript
export default defineChannelPluginEntry({
  id: "acme-chat",
  name: "Acme Chat",
  description: "...",
  plugin: acmeChatPlugin,
  registerCliMetadata(api) {
    api.registerCli(/* ... */);
  },
  registerFull(api) {
    api.registerGatewayMethod(/* ... */);
    api.registerHttpRoute(/* ... */);
  },
});
```

Registration modes:
- `registerCliMetadata(...)` — CLI descriptors (light load)
- `registerFull(...)` — Runtime-only work (gateway RPC, HTTP routes)

## Configuration & Manifest

### package.json

```json
{
  "openclaw": {
    "extensions": ["./index.ts"],
    "setupEntry": "./setup-entry.ts",
    "channel": {
      "id": "acme-chat",
      "label": "Acme Chat",
      "blurb": "Connect OpenClaw to Acme Chat."
    }
  }
}
```

### openclaw.plugin.json

```json
{
  "id": "acme-chat",
  "kind": "channel",
  "channels": ["acme-chat"],
  "configSchema": {
    "type": "object",
    "properties": {
      "acme-chat": {
        "type": "object",
        "properties": {
          "token": { "type": "string" },
          "allowFrom": { "type": "array", "items": { "type": "string" } }
        }
      }
    }
  }
}
```

## File Structure

```
<plugin-root>/
├── package.json
├── openclaw.plugin.json
├── index.ts                  # defineChannelPluginEntry
├── setup-entry.ts            # defineSetupPluginEntry
└── src/
    ├── channel.ts            # createChatChannelPlugin
    ├── client.ts             # Platform API client
    ├── channel.test.ts       # Tests
    └── runtime.ts            # Runtime store (if needed)
```

## Key Constraints

1. Never expose secrets in `inspectAccount` — only return status flags
2. Gateway RPC methods use plugin-specific prefixes
3. Session parsing goes in `resolveSessionConversation`
4. Inbound mentions: split evidence gathering (plugin) from policy evaluation (shared layer)
5. Setup entry avoids heavy runtime during onboarding
6. Webhook auth: set `auth: "plugin"` and verify signatures yourself
