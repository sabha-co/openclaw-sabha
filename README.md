# Sabha Channel for OpenClaw

Connect an OpenClaw agent to a [Sabha](https://sabha.co) workspace as an **app**.
The plugin opens an outbound WebSocket to Sabha's `AppEventsChannel` and talks to
the Sabha REST API with the app's key. No public IP, reverse proxy, webhook
endpoint or polling.

## Features

- Answers when @mentioned in a room, in DMs, and in any thread it is part of
  (no mention needed there). Top-level room replies go in a thread by default.
- Agent Markdown is rendered to the rich text Sabha stores (Lexxy): headings,
  lists, quotes, code blocks, tables, links. `@{USER_ID}` becomes a real mention.
- Attachments in and out (images, documents), downloaded through OpenClaw's
  SSRF-guarded media fetcher.
- Edits and reactions on messages reach the agent as context on the conversation.
- Missed events are replayed after a reconnect, and each event is handled once
  (durable ingress queue).
- `message` tool actions: `send`, `thread-reply`, `edit`, `unsend`, `react`,
  `reactions`, `read`, `search`, `member-info`.
- Directory and name lookup for rooms and people (`#general`, `@Ann`).
- Agent tools: `sabha_search_members`, `sabha_create_dm`.
- `openclaw sabha setup` and `openclaw sabha doctor`.

## Requirements

- OpenClaw **2026.11.1** or newer
- Node **24.16+** (or 26.1+)
- A Sabha server with the app API (`/api/v1`) and `AppEventsChannel`

This release is a rebuild for the current Sabha app API. It does not read
configuration from earlier `@sabha-co/openclaw-sabha` releases (bot keys, join
codes, `baseUrl`/`botKey`). Configure it fresh.

## Install

```bash
openclaw plugins install @sabha-co/openclaw-sabha --accept-capabilities
```

Allow the plugin in `~/.openclaw/openclaw.json`:

```json5
{ plugins: { enabled: true, allow: ["sabha"] } }
```

## Create the app in Sabha

An admin creates the app in **Settings → Apps** and copies its key
(`sabha_app_…`). The key is shown once. Add the app to the rooms it should
work in. Sabha has no self-registration for apps.

## Configure

```bash
openclaw sabha setup --url https://sabha.co/1000006 --key sabha_app_…
openclaw sabha doctor
openclaw gateway restart
```

`setup` checks the key with Sabha before saving it. `--key` can be left out if
`SABHA_APP_KEY` is set. `doctor` checks the config, the key, and a live
`AppEventsChannel` subscription, and exits non-zero on any problem.

`openclaw channels add --channel sabha --url … --app-key …` writes the same config.

### Manual config

```json5
{
  channels: {
    sabha: {
      // Settings shared by every account (no credentials here)
      replyToMode: "first",
      accounts: {
        default: {
          url: "https://sabha.co/1000006", // workspace URL
          appKey: "sabha_app_…",
          // cableUrl: "wss://chat.example.com/cable", // only if not at /cable
        },
      },
    },
  },
}
```

| Setting | Default | Meaning |
|---|---|---|
| `url` | (required) | Workspace URL. On sabha.co, include the workspace number. Self-hosted: the server's origin. |
| `appKey` | (required) | App key from Settings → Apps. Per account only. |
| `cableUrl` | derived | WebSocket URL. Derived as `wss://host/cable`, plus `?wid=<workspace>` on sabha.co. |
| `dmPolicy` | `open` | `open` answers anyone who DMs the app. `allowlist` answers only `allowFrom`. |
| `allowFrom` | `[]` | Sabha user ids admitted in allowlist mode. |
| `replyToMode` | `first` | `off` replies inline, `first` threads the first reply, `all` threads every reply. |
| `livePreview` | `false` | Stream replies into a live draft. Needs a Sabha server with live drafts. |
| `allowPrivateNetwork` | `false` | Let attachment downloads reach private addresses. Only for split-horizon DNS installs. |
| `rooms.<id>.systemPrompt` | — | Extra system prompt for one room's conversations. |
| `defaultAccount` | `default` | Account used when none is named. |

Root-level settings apply to every account; an account's own value wins.

### Several workspaces

Add one account per workspace or app. Room ids are per workspace, so sessions
are kept apart by account.

```json5
accounts: {
  work: { url: "https://sabha.co/1000006", appKey: "sabha_app_…" },
  home: { url: "https://chat.example.com", appKey: "sabha_app_…" },
}
```

### Live drafts and redacting hooks

With `livePreview: true` the reply appears as a draft while the agent writes,
and the final message replaces it. Draft text is sent before
`message_sending` / `reply_payload_sending` hooks run on the final, and
external plugins cannot detect those hooks. **If your hooks redact or rewrite
replies, keep `livePreview` off.**

## Mentions

Agents mention people as `@{USER_ID}` (numeric id). The sender's id is in each
inbound message as `Name (@{id})`, and `sabha_search_members` finds others by
name. `<@id>` does not notify anyone, and a plain `@Name` becomes a mention
only for people the plugin has already seen in an event.

## Prompt guidance

Sabha identity and mention syntax reach the agent on every inbound turn
(`inboundFormattingHints`), and on proactive runs when the tool profile
includes the `message` tool (`messageToolHints`). For more, add
`tools.alsoAllow: ["message"]` or a per-room `systemPrompt`.

## Update

```bash
openclaw plugins update sabha
openclaw gateway restart
```

## Development

See [AGENTS.md](AGENTS.md) for commands and conventions,
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the design, and
[docs/SABHA-API.md](docs/SABHA-API.md) for the Sabha API this plugin uses.

## License

MIT
