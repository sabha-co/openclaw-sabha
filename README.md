# Sabha Channel for OpenClaw

[![npm version](https://img.shields.io/npm/v/@sabha-co/openclaw-sabha)](https://www.npmjs.com/package/@sabha-co/openclaw-sabha)
[![License](https://img.shields.io/github/license/sabha-co/openclaw-sabha)](LICENSE)

OpenClaw channel plugin for [Sabha](https://sabha.co) chat servers. Uses WebSocket for real-time event delivery — no public IP or webhook URL needed.

## Features

- WebSocket mode — connects outbound to Sabha, no tunnels needed
- Supports DMs, group chat, threads, reactions, attachments, search
- 12 agent tools for room and member management
- Sabha self-host support (single-tenant and multi-tenant SaaS)
- Message dedup across WebSocket reconnects
- Auto-registration via join URL
- Auto-joins all open rooms on setup
- Typing indicator while the bot is generating a reply (via AnyCable whisper)

## Install

```bash
openclaw plugins install @sabha-co/openclaw-sabha
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

In DMs, the bot responds to every message. In rooms, only when @mentioned.

## Agent Tools

The plugin registers **two** Sabha-specific agent tools. Everything else (sending, editing, reacting, reading, searching, listing rooms, listing or resolving users) flows through OpenClaw's shared `message` tool, the channel directory adapter, and the resolver — peer-parity with Slack/Discord/Mattermost.

| Tool | Description |
|------|-------------|
| `sabha_search_members` | Find a user by partial name within a specific room |
| `sabha_create_dm` | Open a direct message with a user |

These two are kept because the SDK has no slot for room-scoped name → user lookup, and Sabha doesn't auto-create DMs on first send. Channel/member admin (create / archive / join / leave / add / remove) is intentionally **not** exposed to agents — humans run those operations through the Sabha UI. See `docs/CHANNEL-ADMIN-DROP-PLAN.md` for the rationale.

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
npm install --omit=dev
openclaw plugins install .
```

This copies the plugin into OpenClaw's managed plugin directory, where it surfaces in `openclaw configure --section channels` and the rest of the channel CLI.

For active development with edit-in-place, swap the install line for `openclaw plugins install -l .`. Linked installs go into `plugins.load.paths`, which currently aren't surfaced by the configure menu (upstream OpenClaw catalog-discovery gap); configure sabha by hand-editing `channels.sabha` in `~/.openclaw/openclaw.json` while linked.

Run tests:

```bash
npm test
```

## License

MIT
