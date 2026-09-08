# Sabha Channel for OpenClaw

[![npm version](https://img.shields.io/npm/v/@sabha-co/openclaw-sabha)](https://www.npmjs.com/package/@sabha-co/openclaw-sabha)
[![License](https://img.shields.io/github/license/sabha-co/openclaw-sabha)](LICENSE)

OpenClaw channel plugin for [Sabha](https://sabha.co) chat servers. Uses WebSocket for real-time event delivery — no public IP or webhook URL needed.

## Features

- WebSocket mode — connects outbound to Sabha, no tunnels needed
- Supports DMs, group chat, threads, reactions, attachments, search
- Two Sabha-specific agent tools (room-scoped member search, DM creation); everything else (send / edit / react / read / search / list / resolve) flows through OpenClaw's shared `message` tool, directory adapter, and resolver
- Sabha self-host support (single-tenant and multi-tenant SaaS)
- Message dedup across WebSocket reconnects
- Auto-registration via join URL
- Auto-joins all open rooms on setup
- Typing indicator while the bot is generating a reply (via AnyCable whisper)

## Requirements and fresh installation

Requires **OpenClaw 2026.9.2+** and **Node 24.15+** (Node 25 requires 25.9+).
This release targets the OpenClaw 2 plugin architecture. Configure a fresh
installation; old root credentials and session history are not migrated.
Credentials belong only under `channels.sabha.accounts.<id>`.

## Install

```bash
openclaw plugins install @sabha-co/openclaw-sabha --accept-capabilities
```

## Post-install: allowlist the plugin

Add `sabha` to the allowlist in `~/.openclaw/openclaw.json`:

```json5
{
  plugins: {
    enabled: true,
    allow: ["sabha"]
  }
}
```

Verify and restart:

```bash
openclaw plugins list
openclaw gateway restart
```

## Configure

### Option 1: interactive

```bash
openclaw configure --section channels
```

When prompted, select **Sabha**. The wizard offers two paths:

- **Paste a join URL** (recommended) — e.g. `https://sabha.co/1000101/join/Ccnp-m7vD-L3aj`. The plugin self-registers a bot and saves the bot key automatically. Requires your Sabha admin to have bot self-registration enabled at `/account/bots`.
- **I already have a bot key** — if your admin created a bot manually and shared its key with you, pick this path and paste the bot key plus the server URL.

Either way, the plugin connects via WebSocket on the next gateway restart.

### Option 2: manual

Edit `~/.openclaw/openclaw.json`:

```json5
{
  channels: {
    sabha: {
      enabled: true,
      baseUrl: "https://sabha.co/1000006",              // site root (setup wizard verifies via /skill)
      apiBaseUrl: "https://sabha.co/1000006/api/bots",  // bearer-auth bot API base
      accounts: {
        default: {
          botKey: "42-AbCdEfGhIjKl",
        }
      }
    }
  }
}
```

The join-URL flow auto-populates `apiBaseUrl` and `websocketUrl` from the server's registration response — manual config only needs these when pasting credentials by hand.

> **Bearer-auth refactor (2026.4.25 release).** Bot API auth moved from path-embedded `bot_key` to `Authorization: Bearer`, and endpoints now live under `/api/bots/*`. Plugin releases ≥ 2026.4.25 require a Sabha server that includes the bearer-auth refactor; the legacy 0.9.x line will not work against newer servers.

Then restart the gateway:

```bash
openclaw gateway restart
```

## How it works

1. A user @mentions the bot in Sabha (or DMs it)
2. Sabha delivers the event via WebSocket
3. The plugin dispatches to OpenClaw's agent
4. The agent processes the message with an LLM
5. The plugin replies via Sabha's REST API

Open DMs admit every sender; `dmPolicy: "allowlist"` restricts them to `allowFrom`. Top-level rooms require a mention; existing threads continue without another mention.

## Agent Tools

The plugin registers **two** Sabha-specific agent tools. Everything else (sending, editing, reacting, reading, searching, listing rooms, listing or resolving users) flows through OpenClaw's shared `message` tool, the channel directory adapter, and the resolver — peer-parity with Slack/Discord/Mattermost.

| Tool | Description |
|------|-------------|
| `sabha_search_members` | Find a user by partial name within a specific room |
| `sabha_create_dm` | Open a direct message with a user |

These two are kept because the SDK has no slot for room-scoped name → user lookup, and Sabha doesn't auto-create DMs on first send. Channel/member admin (create / archive / join / leave / add / remove) is intentionally **not** exposed to agents — humans run those operations through the Sabha UI. See `docs/CHANNEL-ADMIN-DROP-PLAN.md` for the rationale.

## Tool profile guidance

Sabha identity and `@{USER_ID}` mention syntax reach the agent through two parallel paths so coverage is robust across deployment shapes:

- **Inbound auto-reply** (a user @mentions the bot or DMs it): identity + mention syntax arrive via OpenClaw's `inboundFormattingHints` hook on every reply, regardless of tool profile.
- **Proactive runs** (an agent is invoked outside the inbound pipeline and uses the `message` tool to send to Sabha): a minimal identity + mention reminder arrives via `messageToolHints`, gated on whether your tool profile includes the `message` tool.

This is the **baseline** — no operator action needed for either path on a `messaging` profile, and the inbound path works on any profile.

Two stronger options if you want richer Sabha context in the system prompt:

- **`tools.alsoAllow: ["message"]`** in `~/.openclaw/openclaw.json`. Layers the `message` tool onto your selected profile so OpenClaw renders the `### message tool` subsection with Sabha's hints (advisory search/read planning notes plus the minimal identity reminder). Useful when running a non-`messaging` profile but you still want guidance about Sabha's message actions on proactive paths.
- **Per-room `systemPrompt`** in your `accounts.<id>.rooms.<roomId>` config. Most powerful override — anything you put here is injected verbatim for that room's conversations. Use for room-specific behavior or when you need stricter Sabha context than the baseline provides.

**Known limitation.** Fast-reply mode skips `inboundFormattingHints` entirely. The inbound + fast-reply combination on a `coding`-style profile loses both hooks — use one of the two options above to compensate.

## Multi-tenant

For multi-tenant Sabha instances, include the workspace ID in the URL:

```
https://sabha.co/1000006
```

The plugin passes the workspace ID as `wid` in the WebSocket connection.

## Update

```bash
openclaw plugins update sabha
openclaw gateway restart
```

## Development

Install from source for local development or debugging:

```bash
git clone https://github.com/sabha-co/openclaw-sabha.git
cd openclaw-sabha
npm install
npm run build
openclaw plugins install .
```

`npm run build` is required: the plugin manifest points the OpenClaw loader at `./dist/index.js`, which doesn't exist until `tsc` has run. `npm install` (not `--omit=dev`) is needed so TypeScript is on the path.

This copies the plugin into OpenClaw's managed plugin directory, where it surfaces in `openclaw configure --section channels` and the rest of the channel CLI.

For active development with edit-in-place, swap the install line for `openclaw plugins install -l .`. Linked installs still read `./dist/index.js`, so re-run `npm run build` after edits before restarting the gateway. Linked installs go into `plugins.load.paths`, which currently aren't surfaced by the configure menu (upstream OpenClaw catalog-discovery gap); configure sabha by hand-editing `channels.sabha` in `~/.openclaw/openclaw.json` while linked.

Run tests:

```bash
npm test
```

## License

MIT

## Development verification

```bash
npm ci --ignore-scripts
npm run lint
npm run build
npm run manifest:check
npm test
npm run test:pack
```

The package test installs the actual archive into disposable OpenClaw state,
validates metadata and CLI loading, then checks streaming, hook rewrites,
cancellation, shared-message reaction routing, replay dedup, and fatal-disconnect
shutdown against fake loopback Sabha servers. It does not
reinstall your real gateway or send messages to real rooms. Local archive/link
installation needs the host's `--force --accept-capabilities` flags.

Replies stream as one edited preview unless a modifying hook is installed, in
which case they wait for the hook-approved final content. Missing send receipts
are errors rather than reported success. Fresh sessions isolate bot accounts
even when their servers have overlapping room ids. See [architecture](docs/ARCHITECTURE.md).
