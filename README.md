# Sabha Channel for OpenClaw

[![npm version](https://img.shields.io/npm/v/@sabha-co/openclaw-sabha)](https://www.npmjs.com/package/@sabha-co/openclaw-sabha)
[![License](https://img.shields.io/github/license/sabha-co/openclaw-sabha)](LICENSE)

OpenClaw channel plugin for [Sabha](https://sabha.co) chat servers. Uses WebSocket for real-time event delivery — no public IP or webhook URL needed.

## Features

- WebSocket mode (default) — connects outbound to Sabha, no tunnels needed
- Webhook mode (fallback) — for deployments that prefer inbound push
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
      baseUrl: "https://sabha.co/1000006",
      botKey: "42-AbCdEfGhIjKl"
    }
  }
}
```

Then restart the gateway:

```bash
openclaw gateway restart
```

## Connection Modes

*WebSocket (default)* — connects outbound to Sabha via ActionCable or AnyCable. No reverse proxy or tunnel needed.

*Webhook (fallback)* — Sabha pushes events to the plugin's HTTP endpoint. Requires OpenClaw to be network-reachable.

```json5
{
  channels: {
    sabha: {
      connectionMode: "webhook",  // default: "websocket"
      webhookPort: 8787
    }
  }
}
```

## How it works

1. A user @mentions the bot in Sabha (or DMs it)
2. Sabha delivers the event via WebSocket (or webhook)
3. The plugin dispatches to OpenClaw's agent
4. The agent processes the message with an LLM
5. The plugin replies via Sabha's REST API

In DMs, the bot responds to every message. In rooms, only when @mentioned.

## Agent Tools

| Tool | Description |
|------|-------------|
| `sabha_list_rooms` | List rooms the bot is in |
| `sabha_list_joinable_rooms` | Discover open rooms to join |
| `sabha_create_room` | Create an open or closed room |
| `sabha_update_room` | Rename a room |
| `sabha_archive_room` | Archive a room |
| `sabha_join_room` | Join an open room |
| `sabha_leave_room` | Leave a room |
| `sabha_list_members` | List room members |
| `sabha_add_member` | Add a user to a room |
| `sabha_remove_member` | Remove a user from a room |
| `sabha_search` | Search messages across all rooms |
| `sabha_create_dm` | Start a DM with a user |

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
openclaw plugins install -l .
```

Run tests:

```bash
npm test
```

## License

MIT
