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

## Development

```sh
npm install
npm test
```

## License

MIT
