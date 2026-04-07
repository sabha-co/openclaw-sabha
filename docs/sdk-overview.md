# Plugin SDK Overview

> Source: https://docs.openclaw.ai/plugins/sdk-overview

## Import Convention

All imports must use specific subpaths:

```typescript
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";
```

## Registration API Methods

### Capability Registration
- `api.registerProvider(...)` — Text inference (LLM)
- `api.registerChannel(...)` — Messaging channel
- `api.registerSpeechProvider(...)` — TTS/STT
- `api.registerRealtimeTranscriptionProvider(...)` — Streaming transcription
- `api.registerRealtimeVoiceProvider(...)` — Duplex voice
- `api.registerMediaUnderstandingProvider(...)` — Image/audio/video analysis
- `api.registerImageGenerationProvider(...)` — Image generation
- `api.registerVideoGenerationProvider(...)` — Video generation
- `api.registerWebFetchProvider(...)` — Web fetch
- `api.registerWebSearchProvider(...)` — Web search

### Tools and Commands
- `api.registerTool(tool, opts?)` — Agent tool (`{ optional: true }` for optional)
- `api.registerCommand(def)` — Custom command (bypasses LLM)

### Infrastructure
- `api.registerHook(events, handler, opts?)` — Event hook
- `api.registerHttpRoute(params)` — Gateway HTTP endpoint
- `api.registerGatewayMethod(name, handler)` — Gateway RPC method
- `api.registerCli(registrar, opts?)` — CLI subcommand
- `api.registerService(service)` — Background service
- `api.registerMemoryPromptSupplement(builder)` — Additive memory prompt section
- `api.registerMemoryCorpusSupplement(adapter)` — Additive memory search corpus

### Exclusive Slots
- `api.registerContextEngine(id, factory)` — Context engine
- `api.registerMemoryCapability(capability)` — Unified memory
- `api.registerMemoryEmbeddingProvider(adapter)` — Embedding adapter

### Events
- `api.on(hookName, handler, opts?)` — Typed lifecycle hook

## API Object Fields

| Field | Type | Description |
|-------|------|-------------|
| `api.id` | `string` | Plugin identifier |
| `api.config` | `OpenClawConfig` | Current config snapshot |
| `api.pluginConfig` | `Record<string, unknown>` | Plugin-specific config |
| `api.runtime` | `PluginRuntime` | Runtime helpers |
| `api.logger` | `PluginLogger` | Scoped logger (debug/info/warn/error) |
| `api.registrationMode` | `PluginRegistrationMode` | Load mode |
| `api.resolvePath(input)` | `(string) => string` | Resolve relative path |

## Hook Decision Semantics

- `before_tool_call`: `{ block: true }` is terminal
- `before_install`: `{ block: true }` blocks installation
- `reply_dispatch`: `{ handled: true }` skips default dispatch
- `message_sending`: `{ cancel: true }` prevents sending

## Core Subpaths

| Subpath | Key Exports |
|---------|------------|
| `plugin-sdk/plugin-entry` | `definePluginEntry` |
| `plugin-sdk/channel-core` | `defineChannelPluginEntry`, `createChatChannelPlugin`, `defineSetupPluginEntry` |
| `plugin-sdk/config-schema` | `OpenClawSchema` |
| `plugin-sdk/provider-entry` | `defineSingleProviderPluginEntry` |

## Channel Subpaths

| Subpath | Key Exports |
|---------|------------|
| `plugin-sdk/channel-setup` | `createOptionalChannelSetupSurface`, `DEFAULT_ACCOUNT_ID` |
| `plugin-sdk/channel-pairing` | `createChannelPairingController` |
| `plugin-sdk/channel-reply-pipeline` | `createChannelReplyPipeline` |
| `plugin-sdk/channel-actions` | `createMessageToolButtonsSchema`, `createMessageToolCardSchema` |
| `plugin-sdk/channel-inbound` | Mention decision helpers |
| `plugin-sdk/inbound-reply-dispatch` | `dispatchInboundReplyWithBase` |
| `plugin-sdk/account-helpers` | `createAccountListHelpers` |

## Runtime and Storage Subpaths

| Subpath | Key Exports |
|---------|------------|
| `plugin-sdk/runtime-store` | `createPluginRuntimeStore` |
| `plugin-sdk/routing` | `resolveAgentRoute`, `buildAgentSessionKey` |
| `plugin-sdk/reply-runtime` | Shared reply/chunking helpers |
| `plugin-sdk/media-runtime` | Media fetch/transform/store helpers |
| `plugin-sdk/persistent-dedupe` | Disk-backed dedupe cache |

## Internal Module Convention

```
my-plugin/
  api.ts            # Public exports
  runtime-api.ts    # Internal runtime exports
  index.ts          # Plugin entry point
  setup-entry.ts    # Setup-only entry (optional)
```

Never import your own plugin through `openclaw/plugin-sdk/<your-plugin>` from production code.
