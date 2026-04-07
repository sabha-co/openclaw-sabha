# Plugin Entry Points

> Source: https://docs.openclaw.ai/plugins/sdk-entrypoints

## defineChannelPluginEntry

```typescript
import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";

export default defineChannelPluginEntry({
  id: "my-channel",
  name: "My Channel",
  description: "Short summary",
  plugin: myChannelPlugin,
  setRuntime: setMyRuntime,
  registerCliMetadata(api) {
    api.registerCli(/* ... */);
  },
  registerFull(api) {
    api.registerGatewayMethod(/* ... */);
  },
});
```

## Configuration Fields

| Field | Type | Required | Details |
|-------|------|----------|---------|
| `id` | string | Yes | Must match `openclaw.plugin.json` |
| `name` | string | Yes | Display name |
| `description` | string | Yes | Brief summary |
| `plugin` | `ChannelPlugin` | Yes | Core channel implementation |
| `configSchema` | Schema or factory | No | Lazy-evaluated config |
| `setRuntime` | `(runtime: PluginRuntime) => void` | No | Store runtime reference |
| `registerCliMetadata` | `(api) => void` | No | Runs in both cli-metadata and full modes |
| `registerFull` | `(api) => void` | No | Runs only in full mode |

## Lifecycle

### setRuntime
- Invoked during registration phase
- Skipped during CLI metadata capture
- Use `createPluginRuntimeStore` for storage

### registerCliMetadata
- Executes in both `"cli-metadata"` and `"full"` modes
- Register channel CLI descriptors here

### registerFull
- Executes only when `api.registrationMode === "full"`
- Skipped during `"setup-only"` or `"cli-metadata"`
- Heavy runtime registrations: services, gateway RPC, HTTP routes

## Registration Mode Behavior

| Mode | setRuntime | registerCliMetadata | registerFull |
|------|-----------|-------------------|-------------|
| `"cli-metadata"` | No | Yes | No |
| `"full"` | Yes | Yes | Yes |
| `"setup-only"` | Yes | No | No |
| `"setup-runtime"` | Yes | No | No |

## defineSetupPluginEntry

```typescript
import { defineSetupPluginEntry } from "openclaw/plugin-sdk/channel-core";
export default defineSetupPluginEntry(myChannelPlugin);
```

Lightweight setup loading — avoids heavy runtime code during onboarding.

## Key Constraints

1. `configSchema` supports lazy factory functions (memoized on first access)
2. Gateway RPC methods must use plugin-specific prefixes
3. Reserved namespaces: `config.*`, `exec.approvals.*`, `wizard.*`, `update.*`
4. `defineChannelPluginEntry` gates `registerFull` on full registration mode automatically
