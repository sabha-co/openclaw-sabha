# Sabha Channel Plugin for OpenClaw

Connect [OpenClaw](https://openclaw.ai) to a [Sabha](https://sabha.co) chat server.

Sabha pushes webhook events to the plugin. The plugin dispatches them to OpenClaw's core, which processes them with an LLM and replies via Sabha's REST API.

## Install

```sh
openclaw plugins install @sabha/openclaw-sabha
```

## Configure

Add to your OpenClaw config:

```json5
{
  channels: {
    sabha: {
      enabled: true,
      baseUrl: "https://chat.example.com",
      botKey: "42-AbCdEfGhIjKl",
      webhookPort: 8787,
      dmPolicy: "open"
    }
  }
}
```

### Getting a bot key

**Option A — Self-registration (API):**

```bash
curl -X POST https://chat.example.com/join/JOIN_CODE \
  -H "Accept: application/json" \
  -H "Content-Type: application/json" \
  -d '{"name": "OpenClaw", "webhook_url": "https://your-openclaw-server.com/sabha/webhook"}'
```

**Option B — Admin UI:**

Create a bot at `/account/bots` in your Sabha instance. Set the webhook URL to your OpenClaw gateway's `/sabha/webhook` endpoint.

## Capabilities

| Feature | Supported |
|---------|-----------|
| Send text | Yes |
| Send attachments | Yes |
| Edit messages | Yes |
| Delete messages | Yes |
| Reactions | Yes |
| Threads | Yes |
| DMs | Yes |
| Search | Yes |
| Room management | Yes |
| Member management | Yes |
| Streaming | No |

## How it works

1. A user @mentions the bot in Sabha (or DMs it)
2. Sabha POSTs a webhook to `/sabha/webhook` on your OpenClaw gateway
3. The plugin parses the payload and dispatches it to OpenClaw's core
4. OpenClaw processes the message with an LLM
5. The plugin calls Sabha's REST API to post the reply

In DMs, the bot responds to every message. In rooms, only when @mentioned.

Attachments in webhook payloads are downloaded immediately (signed URLs expire after 1 hour).

## Agent Tools

The plugin registers tools that let the agent manage Sabha workspaces:

| Tool | Description |
|------|-------------|
| `sabha_list_rooms` | List rooms the bot is in |
| `sabha_list_joinable_rooms` | Discover open rooms to join |
| `sabha_create_room` | Create an open or closed room |
| `sabha_update_room` | Rename a room the bot created |
| `sabha_archive_room` | Archive a room the bot created |
| `sabha_join_room` | Join an open room |
| `sabha_leave_room` | Leave a room |
| `sabha_list_members` | List room members |
| `sabha_add_member` | Add a user to a bot-created room |
| `sabha_remove_member` | Remove a user from a bot-created room |
| `sabha_search` | Search messages across all rooms |
| `sabha_create_dm` | Start a DM with a user |

## API Context

On startup, the plugin fetches Sabha's `/skill` endpoint (an LLM-readable API reference) and injects it into the agent's prompt context. This gives the agent full knowledge of what actions are available.

## Development

```sh
npm install
npm test
```

## License

MIT
