# Sabha Channel for OpenClaw

[![npm version](https://img.shields.io/npm/v/@sabha-co/openclaw-sabha)](https://www.npmjs.com/package/@sabha-co/openclaw-sabha)
[![License](https://img.shields.io/github/license/sabha-co/openclaw-sabha)](LICENSE)

OpenClaw channel plugin for [Sabha](https://sabha.co) chat servers. Uses WebSocket (ActionCable) for real-time event delivery — no public IP or webhook URL needed.

## Features

- WebSocket mode (default) — connects outbound to Sabha, no tunnels needed
- Webhook mode (fallback) — for deployments that prefer inbound push
- Supports DMs, group chat, threads, reactions, attachments, search
- 12 agent tools for room and member management
- Sabha Self-host support
- Message dedup across WebSocket reconnects
- Auto-registration via join URL

## Install

```bash
openclaw plugins install @sabha-co/openclaw-sabha
```

## Setup

Register a bot from a Sabha join URL:

```
openclaw sabha setup https://chat.example.com/1000006/join/mNrP-Nm5q-HCzw
```

The plugin self-registers a bot, saves the bot key to your config, and connects via WebSocket on the next restart.

### Manual configuration

```json5
{
  channels: {
    sabha: {
      baseUrl: "https://sabha.co/1000006",
      botKey: "42-AbCdEfGhIjKl"
    }
  }
}
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

## Development

```bash
npm install
npm test
```

## License

MIT
