# Channel plugin architecture comparison

How `@sabha-co/openclaw-sabha` compares structurally to the in-tree OpenClaw channel plugins (Mattermost, Slack, Discord). Use this when you're about to introduce a new pattern in this repo and want to know whether peers solve the same problem differently — and whether the divergence is justified.

Surveyed against `/Users/ashwin/dev/openclaw/extensions/{mattermost,slack,discord}` on 2026‑04‑26. File counts and line numbers may drift; treat numbers as orders of magnitude.

## At a glance

| Dimension | Sabha | Mattermost | Slack | Discord |
|---|---|---|---|---|
| `.ts` files | 39 | 87 | 224 | 328 |
| Test files (ratio) | 17 (43%) | 37 (43%) | 85 (34%) | 124 (35%) |
| Inbound event types | 7 | ~10 | ~70 (Events API) | ~40 (gateway, intent‑gated) |
| Outbound surface | 12 named tools | ~73 actions | ~14 actions (1 dispatcher tool) | ~42 actions (1 dispatcher tool) |
| Connection mode | WS (AnyCable) + webhook | WS only | HTTP Events API *or* Socket Mode | WS gateway only |
| Streaming dead‑state probe | `isAlive()` exposed | not exposed (uses `discardPending` / `seal` instead) | `isStopped()` exposed | not exposed (uses `discardPending` / `seal` instead) |
| Thread streaming | in‑thread inbounds: yes; top‑level→new thread: deferred (v1.1) | yes | yes (`thread_ts` injected) | yes (native) |
| Multi‑account | `botAccounts` map | single bot | per‑workspace OAuth installs | single bot per app |
| Rich UI primitives | none | none | Block Kit (modals, buttons, selects) | Carbon components (17 types, modals) |
| Setup ceremony | join‑URL POST → bot key | manual token paste | OAuth + dual tokens (bot + app) | manual token + Dev Portal walkthrough |
| Identity preamble in `messageToolHints` | yes (~245 lines) | no | only Slack mrkdwn rules | only component hints (~2 lines) |

## Why the size gap

Discord and Slack are 6–9× Sabha's file count almost entirely because of *platform* surface, not architecture quality. Each rich‑UI primitive (Block Kit blocks, Carbon components, slash commands, modals, interactions) needs render code, schema, agent‑hint copy, and an inbound interaction route. Sabha is text‑first with mentions and reactions, so it doesn't pay any of that.

Mattermost is the closest peer: text‑first, REST + WS, no rich UI. It clocks in at 87 files vs. Sabha's 39 — the gap there is real complexity worth understanding, not platform breadth.

## Dimension‑by‑dimension

### 1. Entry points

- **Sabha** — `index.ts` (`defineChannelPluginEntry`) + `setup-entry.ts` (`defineSetupPluginEntry`). Config schema lives in `openclaw.plugin.json` + `src/channel.ts`. External plugin (npm‑published), so direct entry rather than the bundled pattern.
- **Mattermost / Slack / Discord** — `defineBundledChannelEntry` with `loadBundledEntryExportSync`, splitting plugin contract across `channel-plugin-api.ts`, `secret-contract-api.ts`, `runtime-api.ts`. Bundled = in‑repo, lazy‑loads implementation modules.

**Sabha verdict: justified divergence.** External plugins use the direct entry; the bundled pattern is for in‑repo lazy loading.

### 2. Inbound event surface

- **Sabha** — 7 webhook event types (`message_created/updated/deleted`, `boost_*`, `user_*`). Single `inbound.ts` with branching. `parseWebhookPayload()` produces a discriminated union; both WS and webhook paths converge on `processInboundMessage`.
- **Mattermost** — WS only; ~10 event types; inline dispatch in `monitor.ts`.
- **Slack** — Events API delivers ~70 event types across namespaces (messages, reactions, members, channels, pins, interactions). Each namespace gets its own handler in `src/monitor/events/{namespace}.ts`.
- **Discord** — ~40 gateway events, intent‑gated. Carbon's gateway library handles sequencing, dedup, resume.

**Sabha verdict: in line with peers.** Flat dispatch works at 7 event types. If we ever cross ~15 (e.g., adding presence, reactions, room_*), copy Slack's `monitor/events/<namespace>.ts` pattern.

### 3. Outbound surface

- **Sabha** — 12 separate agent tools (`sabha_list_rooms`, `sabha_create_room`, …). One `SabhaClient` class per bot account. All tools accept hidden `accountId` override.
- **Mattermost** — ~73 actions, exposed inline.
- **Slack** — ~14 actions exposed via **one dispatcher tool** (`{ action: "sendMessage" | … }`). Lazy‑loaded action runtimes via `createLazySlackAction()`.
- **Discord** — ~42 actions exposed via one dispatcher tool, organized into 4 categories (messaging, guild, moderation, presence) under `src/actions/runtime.*.ts`.

**Sabha verdict: drift, but not urgent.** The single‑dispatcher pattern (one tool with an `action` enum) is what scales — Discord didn't end up with 42 separate tools polluting the LLM's tool list. Sabha's 12 separate tools are fine today; if the surface doubles, the inflection point is reached and the dispatcher pattern becomes the right move.

### 4. Multi‑account / multi‑workspace

- **Sabha** — `botAccounts: Record<id, Partial<SabhaConfig>>` layered over a base block. `resolveBotAccount(cfg, id?)` merges; `gateway.startAccount` spawns one monitor per bot. **Account = bot identity.**
- **Mattermost / Discord** — single bot per instance; no multi‑account. Discord's model is one app = one token.
- **Slack** — multi‑workspace via OAuth installs; each install has bot token + app token + (sometimes) user token. **Account = workspace installation.**
- **Feishu** (cross‑check, not in matrix) — same `accounts: Record<id, ...>` + base override pattern as Sabha. Validates the design.

**Sabha verdict: justified divergence.** Sabha hosts multiple bots per workspace; Mattermost/Discord don't have that need. Slack's "account" is a workspace install, which is a different abstraction. Document the model in ARCHITECTURE.md and point at Feishu as the parallel.

### 5. Inbound connection mode

- **Sabha** — WS (AnyCable) primary, webhook fallback. **Webhook fallback only routes to the default account in v1** (per‑bot routes deferred).
- **Mattermost** — WS only.
- **Slack** — HTTP Events API (default) *or* Socket Mode WS.
- **Discord** — gateway WS only; no HTTP receive.

**Sabha verdict: justified divergence on the mode itself; drift on the multi‑bot interaction.** The webhook fallback is genuinely useful for restricted networks. But the asymmetry — WS supports per‑bot routing, webhook routes everything to default — is a footgun. Either fix it (per‑bot webhook routes at `/sabha/webhook/:botAccountId`) or fail loudly at config‑load when `botAccounts` has >1 entry and any uses webhook.

### 6. Session routing

- **Sabha** — `sabha:group:{room_id}` / `sabha:direct:{room_id}` / `sabha:group:{room}:thread:{thread}`. Thread id pulled from `payload.message.thread`.
- **Mattermost** — `mattermost:channel:{id}` / `mattermost:thread:{channel}:{root}`.
- **Slack** — `slack:channel:{id}`; thread keyed on `thread_ts` (a timestamp string, not an id).
- **Discord** — `discord:channel:{id}`; threads have discrete IDs and route as their own channels.

**Sabha verdict: in line with peers.** The pattern matches Mattermost almost exactly.

### 7. Streaming agent replies

All three peers use the same SDK primitive Sabha uses — `createFinalizableDraftLifecycle` (Discord, Mattermost) or `createDraftStreamLoop` (Slack, slightly lighter — no guaranteed final flush). All throttle to ~250ms floor. Max chars vary by platform cap:

- **Sabha** — 16,000 chars (no hard limit, soft cap)
- **Slack** — 4,000 (API limit)
- **Discord** — 2,000 (API limit)
- **Mattermost** — 4,000 (hard limit)

All four use the same internal `{ stopped, final }` state object shared with the SDK helper. The divergence is whether the dead‑state is exposed on the returned handle:

- **Sabha** — exposes `isAlive(): boolean` (inverted polarity of the same flag)
- **Slack** — exposes `isStopped(): boolean`
- **Discord / Mattermost** — do not expose the flag; instead expose richer lifecycle controls (`discardPending()`, `seal()`) that let the caller drive finalization without peeking at state

Sabha needs the probe because the `deliver` callback (in `monitor.ts` and `index.ts` webhook path) has three branches: alive → finalize through `update()+stop()`; dead with preview → bypass loop and PATCH directly via `client.editMessage`; no preview → plain `sendMessage`. Discord and Mattermost achieve the same effect through the richer controls. Slack exposes the same flag Sabha does, just with the opposite name.

The polarity choice (`isAlive` over `isStopped`) is a readability call — `if (draftStream.isAlive())` reads better in the deliver branch than `if (!draftStream.isStopped())`. Neither is more "defensive" than the other; they're the same boolean.

The doc invariant in `CLAUDE.md` (don't gate the fast‑path on `messageId() !== undefined`) is anchored by `src/draft-stream.test.ts`. `messageId()` returns `undefined` during the in‑flight window of the first `sendMessage`, so it can't distinguish "not sent yet" from "stream dead" — that's why the dedicated probe exists at all.

**Thread streaming:** Discord native, Slack via `thread_ts` injection on each flush, Mattermost yes. **Sabha (Phase 1 shipped):** in‑thread inbounds stream into the thread room directly (Sabha emits `payload.room.id == payload.message.thread.id`, so the existing draft stream already targets the right room — only the gate needed lifting). **Top‑level replies that create a new thread are still non‑streaming** (Phase 2): the first partial would need to go via `replyInThread` to capture the new thread room id, then subsequent edits target it. Closest peer pattern is Slack's `resolveThreadTs` callback.

**Sabha verdict: in line with peers; ship thread streaming when it's worth the complexity.**

### 8. Rich UI primitives

- **Sabha** — none. Plain markdown → Trix HTML.
- **Mattermost** — none.
- **Slack** — Block Kit: sections, dividers, buttons, action blocks, select menus, modals, home tab. Agents emit either raw block JSON or shorthand `[[slack_buttons: Label:value]]` / `[[slack_select: Placeholder | …]]` that the plugin renders. Interactions come back via `block_actions` / `view_submission` events.
- **Discord** — Carbon component library: 17 component types (Button, CheckboxGroup, Container, File, Label, LinkButton, Modal, RadioGroup, Section, Separator, StringSelectMenu, TextDisplay, TextInput, Thumbnail, UserSelectMenu, ChannelSelectMenu, MentionableSelectMenu). Agents emit raw component JSON via the `components` schema field. Interactions arrive as `INTERACTION_CREATE` gateway events.

**Sabha verdict: not applicable today.** If Sabha‑the‑platform adds interactive UI later, copy Slack's shorthand pattern, not Discord's raw‑JSON pattern. Letting the agent write `[[sabha_buttons: Approve:y, Deny:n]]` is dramatically lighter than emitting Carbon JSON: fewer failure modes, fewer tokens, less LLM error surface. See "Hypothetical growth" below.

### 9. Typing indicators

- **Sabha** — dedicated `src/typing.ts` (236 lines) with `TypingManager`. Mechanism: AnyCable `whisper` on the same WS used for `BotEventsChannel`. Subscription state machine, 4s refresh timer, reset on reconnect.
- **Mattermost** — REST POST to `users/me/typing`, inline.
- **Slack** — WS `typing_indicator` frame, inline.
- **Discord** — REST `POST /channels/{id}/typing`, inline.

**Sabha verdict: justified divergence.** AnyCable whispers require subscription state tracking that REST‑based peers don't need. The dedicated module is correct modularity, not over‑engineering.

### 10. Agent prompt hints

- **Sabha** — `messageToolHints` ≈ 245 lines: platform identity preamble, room types (Open/Closed/DM/Thread), mention syntax (`@{user_id}` curly‑brace numeric form), Markdown support, tool‑routing notes. `inboundFormattingHints` carries Markdown rules.
- **Discord** — `messageToolHints` ≈ 2 lines, only on components (`set components when sending messages to include buttons, selects…`).
- **Slack** — ≈ 8 lines: `slack_mrkdwn` formatting + interactive‑replies guidance gated on the `interactiveReplies` capability flag. Splits hooks correctly: formatting in `inboundFormattingHints`, tool‑tier guidance in `messageToolHints`.
- **Mattermost** — minimal hints; trusts agent priors.

**Sabha verdict: justified verbosity, with a known SDK gating risk.** Discord and Slack assume agents know `<@id>` and `@username`. Sabha's `format_mentions` regex silently drops anything but `@{id}`, so the preamble defends against a concrete failure mode. The known caveat (the SDK gates `messageToolHints` behind `availableTools.has("message")`) is documented in `docs/AGENT-PROMPT-CONTEXT.md`.

### 11. Setup wizard

- **Sabha** — ~903 lines in `setup-wizard.ts`. Join URL → POST `/join/{code}` → server returns `{bot_key, webhook_secret, websocket_url, …}` → save config. Multi‑account‑aware (can register a new bot under a new account id).
- **Mattermost** — ~94 lines. Manual token + server URL paste.
- **Slack** — ~286 lines. OAuth flow + dual tokens (bot + app) + env var integration.
- **Discord** — ~189 lines. Manual token paste + Discord Developer Portal walkthrough copy.

**Sabha verdict: justified divergence.** The join‑URL flow is an *advantage* of Sabha‑the‑platform — no Dev Portal, no OAuth dance — and the wizard captures it. Length is proportionate to the registration ceremony.

### 12. Defensive infrastructure

- **Sabha** — dedicated modules: `ssrf-guard.ts`, `dedup.ts` (FIFO eviction, 5min TTL, 2000 entries), `retry.ts` (exponential backoff with jitter), `formatStreamError()` redaction in `draft-stream.ts` (defense‑in‑depth against bot‑key leak even after the bearer‑auth refactor closed the primary leak vector).
- **Mattermost / Slack / Discord** — same concerns handled inline; no dedicated modules.

**Sabha verdict: better modularity, not drift.** Dedicated modules are easier to audit. Bot‑key redaction is excellent defense‑in‑depth that peers don't need (their tokens look more like opaque blobs than `42-AbCdEfGhIjKl` regex‑recognizable patterns).

### 13. Module system

All four plugins: `"type": "module"`, `"module": "Node16"`, `.js` extension on relative imports, vitest, colocated `*.test.ts`. **In line with peers.** No quirks.

### 14. Tests

- **Sabha** — 43% test‑file ratio. Coverage: bot‑accounts, channel, draft‑stream, inbound, monitor, reconnect, setup‑wizard, ssrf‑guard, dedup, typing, retry, monitor‑websocket, client.
- **Mattermost** — 43% (same as Sabha).
- **Slack** — 34%. Heavy emphasis on Block Kit rendering snapshots and action dispatch.
- **Discord** — 35%. Heavy emphasis on component rendering and interaction routing.

**Sabha verdict: above‑average coverage density.** No action.

## What would a Mattermost developer find weird about Sabha

1. Webhook fallback at all (Mattermost is WS‑only).
2. `botAccounts: Record<id, ...>` instead of one bot per instance.
3. The mention‑syntax sermon in `messageToolHints` (Mattermost mentions are `<@id>`, agent priors work).
4. Per‑bot `allowPrivateAttachmentHosts` (Mattermost has it per‑instance).
5. Threads not streaming yet.

## What would a Discord/Slack developer find weird about Sabha

1. **12 separate agent tools** instead of one dispatcher tool with an `action` enum.
2. No rich UI primitives at all — coming from Block Kit / Carbon, the message envelope feels bare.
3. Self‑registration flow vs. OAuth or Dev Portal token paste — easier, but unfamiliar.
4. Single inbound dispatch file (`inbound.ts`) instead of `monitor/events/<namespace>.ts` per event family.
5. The identity preamble is unusual — Discord/Slack don't tell agents what platform they're on.

## Hypothetical growth: what Sabha‑the‑plugin would need if Sabha‑the‑platform added X

| Sabha platform feature | Plugin code delta | Pattern to copy |
|---|---|---|
| Rich message cards (embeds) | +200–300 LOC, 2–3 files | Discord's `outbound-payload.ts` + schema additions |
| Buttons / select menus | +500–800 LOC, 4–5 files | **Slack's shorthand** (`[[slack_buttons:Label:value]]`), not Discord's raw component JSON |
| Slash commands | +200–400 LOC, 2–3 files | Discord's slash‑command + interaction routing |
| Reactions as first‑class tool | +50 LOC | Mattermost / Slack `react` actions |

Inflection point for the codebase shape: at one new feature, file structure stays flat. Adding two of the above triggers `monitor/events/<namespace>.ts` reorganization and the action‑dispatcher pattern from Discord/Slack.

## Patterns Sabha is doing better

1. **Self‑registration via join URL** — cleanest setup ceremony of any peer. Captures a Sabha‑platform advantage.
2. **Webhook fallback alongside WS** — only Slack has anything similar (Socket Mode is the WS‑equivalent), and theirs is a different model. Useful for operators on restrictive networks.
3. **Bot‑key redaction in stream errors** — peers don't need it because their tokens are opaque blobs. Defense‑in‑depth.
4. **Verbose mention‑syntax preamble** — costs tokens, but defends against a concrete failure mode peers don't face.
5. **Defensive modules** (`ssrf-guard.ts`, `dedup.ts`, `retry.ts`) — better audit surface than peers' inline equivalents.

## Drift worth tracking

1. **Webhook + multi‑bot interaction**. Either route per‑bot at `/sabha/webhook/:botAccountId` or fail loudly at config load. (Already noted as v1.1.)
2. **12 separate tools vs. one dispatcher**. Not urgent. Inflection point is when the tool count doubles.
3. **No `accountInspect` contract**. Slack and Mattermost expose this for `openclaw doctor`‑style health checks. Sabha doesn't. Where the ecosystem is heading.
4. **Top‑level → new‑thread streaming** (Phase 2 — in‑thread streaming shipped in Phase 1; only the create‑new‑thread case still falls back to non‑streaming).
5. **`messageToolHints` SDK gating** (already documented in `docs/AGENT-PROMPT-CONTEXT.md`).

## References

- `/Users/ashwin/dev/openclaw/extensions/mattermost/` — closest peer (text‑first, simple)
- `/Users/ashwin/dev/openclaw/extensions/slack/` — Events API + Socket Mode + Block Kit
- `/Users/ashwin/dev/openclaw/extensions/discord/` — gateway + Carbon components
- `/Users/ashwin/dev/openclaw/extensions/feishu/` — multi‑account pattern parallel to Sabha (not in matrix)
- `docs/ARCHITECTURE.md` — Sabha plugin's own architecture
- `docs/AGENT-PROMPT-CONTEXT.md` — peer survey of `messageToolHints` usage and the SDK gating issue
- `docs/OUTBOUND-RICH-TEXT.md` — Sabha's markdown → Trix HTML pipeline
