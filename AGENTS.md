# AGENTS.md

`@sabha-co/openclaw-sabha` is an external OpenClaw channel plugin (id `sabha`)
that connects agents to a Sabha workspace as an **app**: REST at `/api/v1` with
an app key, events over the `AppEventsChannel` WebSocket (AnyCable extended
protocol, so missed events replay after a reconnect).

The server is `~/dev/sabha-ai`. Its `GET /skill` text and
`docs/features/APPS.md` describe the app API; where they disagree with its
code, the code wins. [docs/SABHA-API.md](docs/SABHA-API.md) lists what this
plugin relies on.

## Host and commands

Target OpenClaw **2026.11.1**, Node **>=24.16 <25 or >=26.1**. There are no
outside users of earlier releases: no backward compatibility, config
migration, or old-host shims.

```bash
npm run build              # clean dist/, then tsc with declarations
npm run lint
npm test                   # vitest
npx vitest run src/monitor/events.test.ts
npm run manifest:generate  # build, then regenerate openclaw.plugin.json + package.json#openclaw.channel
npm run manifest:check     # build, then fail if either is stale
npm run test:pack          # pack, install into a throwaway host, run scripts/host-integration.mjs
```

`test:pack` uses a disposable `OPENCLAW_STATE_DIR` and fake Sabha servers. It
never touches a real gateway. Publishing, and installing or restarting a real
gateway, need explicit user authorization. The production gateway runs on a
VPS: ask the user to run commands there.

## Rules

- ESM, TypeScript Node16 resolution, `.js` on every relative import. Tests sit
  next to the code and are excluded from the build.
- Import only public `openclaw/plugin-sdk/*` subpaths. `src/sdk-imports.test.ts`
  fails on anything in `scripts/sdk-private-subpaths.json`
  (`plugin-runtime`, `channel-entry-contract`, `outbound-media`, …). Only
  `scripts/host-integration.mjs` may reach into private host modules, and it is
  pinned to the dev host version.
- Authority comes from host context, never from model params. The account is
  `ctx.accountId` (actions) or `agentAccountId` when the agent is on Sabha
  (tools). Writes call `onPlatformSendDispatch` / `assertDirectAdapterHandoff`;
  side-effecting tools call `assertInvocationCurrent()` before acting.
- A failed lookup is an error or a "lookup failed" note, never an empty result.
- Keep discovery cheap: `setup-entry.ts`, the action adapter, the directory
  adapter and tool factories load the client and monitor lazily.
- Credentials (`appKey`, `cableUrl`, `name`) live only under
  `channels.sabha.accounts.<id>`. Other settings may sit at the channel root.

## Layout

| Path | Role |
|---|---|
| `index.ts` | `defineChannelPluginEntry`: channel, CLI (`registerCliMetadata`), tools (`registerFull`) |
| `setup-entry.ts` | `defineSetupPluginEntry` → `src/plugin/channel.setup.ts` (config, setup, status; no transport) |
| `src/plugin/` | `channel.ts` (full plugin), `channel.runtime.ts` (lazy runtime half), `messaging.ts` (targets, session routes, thread context), `agent-prompt.ts`, `meta.ts` (ids, tool and CLI metadata) |
| `src/config/` | Zod schema + UI hints, account resolution, setup contract, setup wizard |
| `src/client/` | REST client, probe, Markdown → Lexxy HTML (`rich-text.ts`), `@{id}` mention rewrite, account → client |
| `src/monitor/` | `cable-socket.ts` (one connection), `monitor.ts` (account lifecycle, reconnect, resume), `events.ts` (parse, addressing, ingress ids), `ingress.ts` (durable queue) |
| `src/inbound/` | `access.ts` (DM policy, mention gating), `turn.ts` (one event → one host turn, or a system event) |
| `src/outbound/` | `send.ts` (chunked text, media), `target.ts` (target grammar → room), `draft-transport.ts`, `reply-delivery.ts` |
| `src/actions/` | `message` tool adapter (static discovery) and handlers (lazy) |
| `src/directory.ts`, `src/tools.ts`, `src/cli.ts`, `src/doctor.ts` | Directory + resolver, agent tools, CLI, doctor checks |
| `scripts/generate-manifest.mjs` | Projects schema, setup contract and metadata into the manifests |

## Behaviour to preserve

- Top-level room messages need a mention. DMs and threads do not. The app
  never sees its own messages (server-side), and self echoes are dropped anyway.
- Ingress ids: `message:<id>`, `edit:<id>:<updated_at>`, `react:` / `unreact:`
  + reaction id. One lane per room. Deletes and `user_*` events never enter.
- Edits and reactions become system events on the conversation's session. They
  never start a turn.
- A thread is its own room. Inbound thread turns and outbound sends with a
  `threadId` both use the thread room's session.
- Group session peers include the account id (room ids overlap across
  servers). DMs are per account and peer.
- The final reply replaces the live draft when there is one
  (`client_message_id`). If that fails it is posted normally. A draft is always
  ended when the turn finishes without replacing it.
- `livePreview` is off by default: the current sabha-ai has no
  `AppEventsChannel#draft` action or `client_message_id`. Turn the default on
  when the server ships them.
- `401`/`403` at startup or a `disconnect` with `reconnect: false` parks the
  account as `blocked` until restart. Other failures reconnect with backoff
  and resume from the last stream position.

## Verifying against a local sabha-ai

sabha-ai runs at `http://localhost:3000` with AnyCable at `ws://localhost:8080/cable`.
Create an app in Settings → Apps (or reuse one), then in a throwaway state dir:

```bash
export OPENCLAW_STATE_DIR=$(mktemp -d)/state OPENCLAW_CONFIG_PATH=$OPENCLAW_STATE_DIR/openclaw.json
npm pack && node node_modules/openclaw/openclaw.mjs plugins install --force --accept-capabilities ./sabha-co-openclaw-sabha-*.tgz
node node_modules/openclaw/openclaw.mjs sabha setup --url http://localhost:3000 --key sabha_app_…
node node_modules/openclaw/openclaw.mjs config set channels.sabha.accounts.default.cableUrl ws://localhost:8080/cable
node node_modules/openclaw/openclaw.mjs sabha doctor
```
