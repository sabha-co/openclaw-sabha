# AGENTS.md

`@sabha-co/openclaw-sabha` is an external OpenClaw channel plugin connecting
agents to Sabha through Bot REST API calls and an outbound ActionCable/AnyCable
WebSocket. No public IP, reverse proxy, polling, or standalone app server.

## Supported host and commands

Target OpenClaw **2026.9.2** and Node **>=24.15 <25 or >=25.9**. We own this
installation and can configure it afresh. Do not add backward compatibility,
root-credential fallback, session-history migration, or old-loader shims.

```bash
npm run build                 # tsc, including declaration emit
npm run lint
npm test
npx vitest run src/inbound.test.ts
npm run manifest:generate     # build and regenerate manifest/package setup fields
npm run manifest:check        # detect metadata drift after a build
npm run test:pack              # fresh host install and loopback transport integration
```

Build before loading the plugin. Package entry paths point to `dist/index.js`
and `dist/setup-entry.js`. `npm pack` rebuilds and regenerates metadata. A real
gateway reinstall/restart and publication require explicit user authorization.
The packed smoke test owns disposable state and never touches the live gateway.

## Module and loading boundaries

`type: module` with TypeScript Node16 resolution. All relative imports use `.js`
extensions. Import only public, typed `openclaw/plugin-sdk/*` subpaths. Zod and
TypeBox are direct dependencies. Tests are colocated and excluded from emit.

- `index.ts`: `defineChannelPluginEntry`; synchronous named tool factories,
  lazy CLI implementation. Tool discovery has no runtime: read config/construct
  clients only inside execution. Prefer `ctx.getRuntimeConfig()` when supplied.
- `setup-entry.ts` -> `src/channel-setup.ts`: `defineSetupPluginEntry`, lightweight
  schema/config/security/setup metadata. No static monitor, WebSocket, draft,
  tool, or HTTP client imports through this graph.
- `src/config-schema.ts`, `src/setup-contract.ts`, `src/metadata.ts` are the
  sources for generated `openclaw.plugin.json` and package setup fields.
- `src/channel.ts`: full channel, message/directory/resolver adapters, prompt
  hints, status, and gateway startup.

## Accounts and sessions

All credentials and bot identity live under `channels.sabha.accounts.<id>`.
Shared non-credential settings may live at channel root; overrides replace
arrays and room maps. Honor `defaultAccount`, never union tenant directories.
Only explicit accounts run. Startup does not write or migrate configuration.
Join URL wizard and `openclaw sabha setup` write the same named-account shape.

`src/session.ts` uses the public SDK route builder. Group peers include account
id because numeric room ids overlap across servers. DMs use
`per-account-channel-peer`. Keep inbound and outbound route construction aligned.
Wire delivery targets remain numeric. Thread events already name their thread
room; do not fabricate a parent room/session from that same id.

## Inbound and lifecycle

`monitor-websocket.ts` owns ActionCable protocol and heartbeat; `reconnect.ts`
owns backoff. `ready` means BotEventsChannel subscription confirmed; disconnect
means `recovering`, terminal failure `blocked`, abort `stopped`.

Dedup is FIFO (2,000 entries, five-minute TTL), with an in-flight guard across
reconnects. Filter self echoes before dedup. Failed turns release reservations.
Only `message_created` enters an agent turn. Other message events log metadata;
global `user_created`/`user_deleted` never enter an agent context or name cache.

`inbound.ts` resolves the agent and final account-scoped session before calling
the ingress resolver. Supply the exact ingress result once to the injected
`runtime.channel.inbound.buildContext`; then the injected kernel owns recording,
dispatch, hooks, and terminal observation. Do not forge owner authority or use
privileged state APIs unavailable to ordinary external plugins.

Top-level groups require a mention; DMs and existing threads do not. Enforce DM
allowlists before typing/media. Open DM policy maps to SDK wildcard admission;
command owners still use the explicit allowlist. Display names grant no access.

Download signed attachments immediately after admission using the guarded media
runtime. Use the saved absolute `path`, MIME type, and filename as media facts.
Keep attachment-only agent text empty. Default SSRF protection stays enabled;
private hosts require the existing explicit account opt-in. Keep numeric native
room/message fields, the sender's `@{id}` token, and room prompts in context.

## Delivery and typing

Typing uses AnyCable whispers on the event socket, never REST. Start only after
admission and stop on partial output, completion, failure, and abort.

`draft-stream.ts` uses `channel-outbound.createFinalizableDraftLifecycle`.
`delivery.ts` finalizes based on `isAlive()`, not `messageId()`: the first send
may still be pending. Await it and the final edit before reporting a receipt.
Track the resolved room returned by Sabha. Do not claim success for a null or
malformed send response, or label an attempted send as not dispatched.

Failed preview edits may be repaired directly. Delete must succeed before a
replacement send; failed deletion preserves partial-delivery evidence. Never
blindly resend an ambiguous first preview. Modifying reply/message hooks disable
eager previews; observer-only hooks do not. Clear silent/cancelled previews.
Do not post errors through a path that bypasses modifying hooks. Use
`formatStreamError` for operator-facing errors and redact WebSocket bot keys.

`replyToMode: off` and DMs send inline. New threaded replies send to the parent
room with `parentMessageId`; Sabha creates/finds the thread idempotently.
Existing threads send to their own room. Edits/deletes/reactions are id-only.

## Agent and wire contracts

All wire behavior belongs in `SabhaClient`: bearer auth, API routes, retry
classification, response parsing, and Markdown -> Trix rich text. Preserve code
fence/list chunking and Sabha's table/heading formatting rules.

Keep capabilities in their SDK slots:

- Shared message actions: send, edit, unsend, react, thread-reply, search,
  member-info, read, reactions. Extend discovery and dispatch together.
- Directory/resolver: room/user listing and workspace name lookup. Resolve one
  account; distinguish server lookup failure from a confirmed empty match.
- Two custom tools only: `sabha_search_members` (room-scoped query) and
  `sabha_create_dm` (explicit DM materialization). New tools need an SDK-gap
  argument. Humans own room/member administration.

`read` returns `{messages, hasMore, nextCursor}` with string ids, timestamp,
authorTag, author.username, and text for the CLI formatter. Reactions project
boosts to `{name, count, users, truncated}`. Search retains its `results`
envelope. Composite cursors go onto the wire's `before` parameter. New formatted
actions must match the host formatter. Preserve numeric native room context so
react/reactions target autofill works; never prompt an agent to invent `to`.

Keep both inboundFormattingHints and messageToolHints: they cover different
inbound/proactive prompt paths. Mention syntax is `@{USER_ID}`. Do not inject
whole API docs into prompts; correctness belongs in schemas/results.

## References

- `docs/ARCHITECTURE.md`: current implementation and evidence boundaries.
- `docs/TYPING.md`, `docs/OUTBOUND-RICH-TEXT.md`: Sabha wire details.
- `docs/sdk-*.md`: snapshots from stable 2026.9.2. Installed SDK types win if stale.
- `/Users/ashwin/dev/openclaw/extensions`: stable peer channel examples.
- `/Users/ashwin/dev/openclaw-basecamp`, `/Users/ashwin/dev/inline/openclaw`:
  external-plugin examples; verify their host version before copying contracts.
