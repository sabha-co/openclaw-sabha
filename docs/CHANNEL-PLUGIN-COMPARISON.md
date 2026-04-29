# Channel plugin architecture comparison

How `@sabha-co/openclaw-sabha` compares structurally to the in-tree OpenClaw channel plugins (Mattermost, Slack, Discord). Use this when you're about to introduce a new pattern in this repo and want to know whether peers solve the same problem differently — and whether the divergence is justified.

Surveyed against `/Users/ashwin/dev/openclaw/extensions/{mattermost,slack,discord}` on 2026‑04‑27, refreshed 2026‑04‑29. File counts and line numbers may drift; treat numbers as orders of magnitude.

## At a glance

| Dimension | Sabha | Mattermost | Slack | Discord |
|---|---|---|---|---|
| `.ts` files | 51 | 98 | 248 | 351 |
| Test files (ratio) | 22 (43%) | 37 (38%) | 85 (34%) | 124 (35%) |
| Inbound event types | 7 | ~10 | ~70 (Events API) | ~40 (gateway, intent‑gated) |
| Message-action verbs | 9 | 2 | 13 | 39 |
| Directory adapter slots wired | 3 (`listGroups`, `listPeers`, `listPeersLive`) | 4 (+ `listGroupsLive`) | 4 (+ `listGroupsLive`) | 4 (+ `listGroupsLive`) |
| `api.registerTool` calls | 2 (`sabha_search_members`, `sabha_create_dm` — SDK-gap verbs) | 0 | 0 | 0 |
| Connection mode | WS (AnyCable) | WS only | HTTP Events API *or* Socket Mode | WS gateway only |
| Streaming dead‑state probe | `isAlive()` exposed | not exposed (uses `discardPending` / `seal` instead) | `isStopped()` exposed | not exposed (uses `discardPending` / `seal` instead) |
| Thread streaming | yes (in‑thread direct; top‑level→new thread via `firstSend` hook) | yes | yes (`thread_ts` injected) | yes (native) |
| Multi‑account | `accounts` map (canonical SDK keys) | single bot | per‑workspace OAuth installs | single bot per app |
| Rich UI primitives | none | none | Block Kit (modals, buttons, selects) | Carbon components (17 types, modals) |
| Setup ceremony | join‑URL POST → bot key | manual token paste | OAuth + dual tokens (bot + app) | manual token + Dev Portal walkthrough |
| Identity preamble in `messageToolHints` | yes (~50 source lines, 4 hint strings) | no | only Slack mrkdwn rules | only component hints (~2 lines) |

## Why the size gap

Discord and Slack are 5–7× Sabha's file count almost entirely because of *platform* surface, not architecture quality. Each rich‑UI primitive (Block Kit blocks, Carbon components, slash commands, modals, interactions) needs render code, schema, agent‑hint copy, and an inbound interaction route. Sabha is text‑first with mentions and reactions, so it doesn't pay any of that.

Mattermost is the closest peer: text‑first, REST + WS, no rich UI. It clocks in at 98 files vs. Sabha's 49 — the gap there is real complexity worth understanding, not platform breadth. Counterintuitively, Mattermost only contributes **2 actions** (`send`, `react`) to the shared `message` tool — *less* than Sabha's 9 — and most of its file count comes from the slash‑command surface and a heavier action‑gating config layer rather than messaging breadth.

## Dimension‑by‑dimension

### 1. Entry points

- **Sabha** — `index.ts` (`defineChannelPluginEntry`) + `setup-entry.ts` (`defineSetupPluginEntry`). Config schema lives in `openclaw.plugin.json` + `src/channel.ts`. External plugin (npm‑published), so direct entry rather than the bundled pattern.
- **Mattermost / Slack / Discord** — `defineBundledChannelEntry` with `loadBundledEntryExportSync`, splitting plugin contract across `channel-plugin-api.ts`, `secret-contract-api.ts`, `runtime-api.ts`. Bundled = in‑repo, lazy‑loads implementation modules.

**Sabha verdict: justified divergence.** External plugins use the direct entry; the bundled pattern is for in‑repo lazy loading.

### 2. Inbound event surface

- **Sabha** — 7 event types (`message_created/updated/deleted`, `boost_*`, `user_*`). Single `inbound.ts` with branching. `parseWebhookPayload()` produces a discriminated union; the WS monitor converges on `processInboundMessage`.
- **Mattermost** — WS only; ~10 event types; inline dispatch in `monitor.ts`.
- **Slack** — Events API delivers ~70 event types across namespaces (messages, reactions, members, channels, pins, interactions). Each namespace gets its own handler in `src/monitor/events/{namespace}.ts`.
- **Discord** — ~40 gateway events, intent‑gated. Carbon's gateway library handles sequencing, dedup, resume.

**Sabha verdict: in line with peers.** Flat dispatch works at 7 event types. If we ever cross ~15 (e.g., adding presence, reactions, room_*), copy Slack's `monitor/events/<namespace>.ts` pattern.

### 3. Outbound surface

The SDK splits outbound capability into three slots, and the "tools vs actions" terminology gap maps to which slot a plugin uses. Per `https://docs.openclaw.ai/plugins/sdk-channel-plugins`:

> "Channel plugins do not need their own send/edit/react tools. OpenClaw keeps one shared `message` tool in core."

The three slots:

1. **`ChannelMessageActionAdapter`** (`describeMessageTool` + `handleAction`) — contributes platform‑specific affordances to the **shared `message` tool that core owns**. This is where send / edit / delete / react / pin / file ops belong.
2. **`createChannelDirectoryAdapter`** — channel/user listing and search.
3. **`api.registerTool(factory)`** — agent-facing verbs the SDK has no slot for. Use sparingly; peers wire **zero**, Sabha wires two (`sabha_search_members`, `sabha_create_dm`).

Per‑plugin breakdown (counts re-verified 2026‑04‑27 by enumerating switch cases and `actions.add(...)` lines):

- **Slack** — `ChannelMessageActionAdapter` returning `describeMessageTool` that gates actions on per-account capability flags. **13 actions** total when all gates open: `send`, `react`, `reactions`, `read`, `edit`, `delete`, `download-file`, `upload-file`, `pin`, `unpin`, `list-pins`, `member-info`, `emoji-list`. Directory adapter wires **4 slots**: `listGroups` + `listGroupsLive` + `listPeers` + `listPeersLive` (no `listGroupMembers`). **Zero `api.registerTool` calls.**
- **Discord** — `discordMessageActions: ChannelMessageActionAdapter` dispatching **39 actions** across messaging / guild / moderation / presence: messaging (`send`, `edit`, `delete`, `react`, `reactions`, `read`, `pin`, `unpin`, `list-pins`, `thread-create`, `thread-list`, `thread-reply`, `search`, `member-info`, `poll`, `sticker`, `sticker-upload`, `emoji-list`, `emoji-upload`), guild admin (`channel-create`, `channel-edit`, `channel-delete`, `channel-info`, `channel-list`, `channel-move`, `category-create`, `category-edit`, `category-delete`, `event-create`, `event-list`, `voice-status`, `set-presence`), moderation (`role-add`, `role-remove`, `role-info`, `permissions`, `ban`, `kick`, `timeout`). Directory adapter wires **4 slots**: `listGroups` + `listGroupsLive` + `listPeers` + `listPeersLive`. Zero `api.registerTool` calls.
- **Mattermost** — `ChannelMessageActionAdapter` with **only 2 actions**: `send` and `react`. (Prior survey claimed ~73 — that was wrong; it likely conflated total grep hits with message-tool actions. The verb surface is genuinely tiny.) Directory wires **4 slots**: `listGroups` + `listGroupsLive` + `listPeers` + `listPeersLive`. The bulk of Mattermost's file count comes from the slash-command dispatcher (`monitor-slash.ts`, `slash-commands.ts`) and a heavier action-gating config layer, not from messaging breadth. Zero `api.registerTool` calls.
- **Sabha** — `ChannelMessageActionAdapter` wired in `src/channel.ts` with dispatch in `src/message-actions.ts`; supports **9 actions** (`send`, `edit`, `unsend`, `react`, `thread-reply`, `search`, `member-info`, `read`, `reactions`). `search` and `read` return the same envelope `{ results, hasMore, nextCursor }` capped at 200 server-side and accept the canonical scoping aliases (`channelId`/`channelIds`/`authorId`/`authorIds`) plus Sabha-native `roomId`/`roomIds`. `read` is cursor-paginated room history (newest-first); `reactions` returns aggregated boosts on a single message. Directory adapter in `src/directory.ts` wires **3 of the 4 slots peers wire**: `listGroups` (rooms — server-paginated via `?query=&page=&per_page=` with a 100×100 = 10k ceiling), `listPeers` (`GET /api/bots/users`, paginated 100/page, capped at 10k), `listPeersLive` (autocomplete-friendly variant trimmed to ≤20). **`listGroupsLive` is not wired** (Mattermost / Slack / Discord all wire it for live group autocomplete in operator UI); not yet observed as a gap, but a candidate for parity if Sabha gets richer admin tooling. `ChannelResolverAdapter.resolveTargets` wired in `src/resolver.ts` for workspace-level name → id (peer parity with Discord/Slack/Telegram). **2 `registerTool` entries** — both verbs the SDK can't model: `sabha_search_members` (room-scoped name → user; `ChannelDirectoryListGroupMembersParams` has no `query` and `ChannelDirectoryListPeersParams` has no `roomId`) and `sabha_create_dm` (Sabha doesn't auto-create DMs on first send the way Slack/Discord do). The broader room/member admin surface (create / update / archive / join / leave / add / remove / list-joinable, 8 tools) was dropped on 2026.4.29 to reduce the maintained code surface — see `docs/CHANNEL-ADMIN-DROP-PLAN.md`.

**Sabha verdict: aligned with peers.** The earlier framing ("drift on the missing message adapter and directory misplacement") is fully resolved as of 2026.4.27, and the room-admin-as-`registerTool` outlier was resolved on 2026.4.29 by dropping rather than migrating. Highlights:

- `reply` is intentionally absent from the action list. `send` with `replyToId` covers the implicit case; `thread-reply` covers the explicit case (and fails closed when `messageId` is missing). Mattermost (with its 2 actions) and Slack/Discord all omit `reply` for the same reason — exposing it would either be redundant with `send` or duplicate `thread-reply` with looser semantics.
- `member-info` (added 2026.4.27) hits `/api/bots/users/:id` for a rich profile (bio + social URLs). Comment in `message-actions.ts` calls out that 404 means "bot can't see this user" (server-scoped to room overlap), not "user doesn't exist". Slack and Discord both expose `member-info` too; Mattermost doesn't.
- **`listGroupMembers` is intentionally not wired** (dropped 2026.4.27). All three peers (Slack/Discord/Mattermost) skip this slot too — exposing a "list every member of room X" primitive doesn't scale (Slack channels can have 100k+ members, Discord guilds millions). The slot's SDK signature `(groupId, limit)` doesn't include a `query` param either, so it can only be a paginated dump, not a search. The architectural choice is to **force the agent to think differently**: ask `member-info` for a specific user, search via `listPeers` at the workspace level, or read mention metadata from inbound payloads. Briefly wired and removed in the same week — the prior version was a 1-call REST dump with no pagination, and aspiring to Slack/Discord scale meant cutting the slot rather than retrofitting pagination. See the comparison doc's "Resolved drifts" entry for narrative.
- The directory adapter scopes to the resolved default account when `accountId` is null rather than unioning every enabled account. Sabha can be cross‑tenant (different `apiBaseUrl`s = separate workspaces with overlapping room id namespaces); a union would collide bare numeric ids and hand the agent room ids it could not subsequently message. Mattermost union‑all is safe for it (single‑workspace‑per‑config); for Sabha it is not.
- The two retained `registerTool` factories are kept because the SDK has no slot for room-scoped name lookup and Sabha doesn't auto-create DMs on first send. Both have human-side substitutes through the Sabha UI, but neither has an *agent-reachable* substitute. Adding more `registerTool` factories without a matching SDK-gap argument should be resisted.

### 4. Multi‑account / multi‑workspace

- **Sabha** — `accounts: Record<id, Partial<SabhaConfig>>` layered over a base block. `resolveSabhaAccount(cfg, id?)` merges; `gateway.startAccount` spawns one monitor per bot. **Account = bot identity.** Uses the canonical SDK helpers (`createAccountListHelpers("sabha")` + `resolveMergedAccountConfig`).
- **Mattermost / Discord** — single bot per instance; no multi‑account. Discord's model is one app = one token.
- **Slack** — multi‑workspace via OAuth installs; each install has bot token + app token + (sometimes) user token. **Account = workspace installation.**
- **Feishu** (cross‑check, not in matrix) — same `accounts: Record<id, ...>` + base override pattern as Sabha. Validates the design.

**Sabha verdict: justified divergence.** Sabha hosts multiple bots per workspace; Mattermost/Discord don't have that need. Slack's "account" is a workspace install, which is a different abstraction. Document the model in ARCHITECTURE.md and point at Feishu as the parallel.

### 5. Inbound connection mode

- **Sabha** — WS (AnyCable) only.
- **Mattermost** — WS only.
- **Slack** — HTTP Events API (default) *or* Socket Mode WS.
- **Discord** — gateway WS only; no HTTP receive.

**Sabha verdict: in line with peers.**

### 6. Session routing

- **Sabha** — `sabha:group:{room_id}` / `sabha:direct:{room_id}` / `sabha:group:{room}:thread:{thread}`. Thread id pulled from `payload.message.thread`.
- **Mattermost** — `mattermost:channel:{id}` / `mattermost:thread:{channel}:{root}`.
- **Slack** — `slack:channel:{id}`; thread keyed on `thread_ts` (a timestamp string, not an id).
- **Discord** — `discord:channel:{id}`; threads have discrete IDs and route as their own channels.

**Sabha verdict: in line with peers.** The pattern matches Mattermost almost exactly.

### 7. Streaming agent replies

All three peers use the same SDK primitive Sabha uses — `createFinalizableDraftLifecycle` (Discord, Mattermost) or `createDraftStreamLoop` (Slack, slightly lighter — no guaranteed final flush). All throttle to ~250ms floor. Max chars vary by platform cap:

- **Sabha** — 16,000 chars (no hard limit, soft cap)
- **Slack** — 8,000 (`SLACK_TEXT_LIMIT` in `slack/src/limits.ts`)
- **Discord** — 2,000 (API limit)
- **Mattermost** — 4,000 (hard limit)

All four use the same internal `{ stopped, final }` state object shared with the SDK helper. The divergence is whether the dead‑state is exposed on the returned handle:

- **Sabha** — exposes `isAlive(): boolean` (inverted polarity of the same flag)
- **Slack** — exposes `isStopped(): boolean` **and** the `discardPending()` / `seal()` controls (superset)
- **Discord / Mattermost** — expose only `discardPending()` / `seal()`; the dead-state flag is not surfaced on the returned handle

Sabha needs the probe because the `deliver` callback (in `monitor.ts`) has three branches: alive → finalize through `update()+stop()`; dead with preview → bypass loop and PATCH directly via `client.editMessage`; no preview → plain `sendMessage`. Discord and Mattermost achieve the same effect through the richer controls. Slack exposes both — `isStopped` is the same flag Sabha does, just with the opposite name.

The polarity choice (`isAlive` over `isStopped`) is a readability call — `if (draftStream.isAlive())` reads better in the deliver branch than `if (!draftStream.isStopped())`. Neither is more "defensive" than the other; they're the same boolean.

The doc invariant in `CLAUDE.md` (don't gate the fast‑path on `messageId() !== undefined`) is anchored by `src/draft-stream.test.ts`. `messageId()` returns `undefined` during the in‑flight window of the first `sendMessage`, so it can't distinguish "not sent yet" from "stream dead" — that's why the dedicated probe exists at all.

**Thread streaming:** Discord native, Slack via `thread_ts` injection on each flush, Mattermost yes. **Sabha:** in‑thread inbounds stream into the thread room directly (Sabha emits `payload.room.id == payload.message.thread.id`, so the existing draft stream already targets the right room). **Top‑level replies that create a new thread stream via a `firstSend` hook on `createSabhaDraftStream`** — the first partial posts via `client.replyInThread(parentRoomId, userMessageId, text)` and captures the new thread room id from the response (`r.thread.id`). After the 2026.4.29 id-only migration, that captured room id is no longer needed for editing the preview (`editMessage` / `deleteMessage` are id-only on the wire and resolve the room server-side); it's only kept around so `monitor.ts`'s recovery / error-replace paths can post a **fresh** error message into the thread room rather than the parent. The dedicated `firstSend` + `replyInThread` shape remains because server Phase 2 (inline `parent_message_id` on POST) hasn't shipped yet — that would let the first partial flow through the regular `sendMessage` path. Closest peer pattern is Slack's `resolveThreadTs` callback.

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
- **Slack** — emoji‑reaction signal (`typingReaction` config), not a typing frame. Slack's WS Events API doesn't ship a bot‑emittable typing payload, so the plugin reacts with a configured emoji while the LLM generates and removes it on finalize. See `slack/src/monitor/provider.ts` (`typingReaction`) and `slack/src/monitor/message-handler/dispatch.ts`.
- **Discord** — REST `POST /channels/{id}/typing`, inline.

**Sabha verdict: justified divergence.** AnyCable whispers require subscription state tracking that REST‑based peers don't need. The dedicated module is correct modularity, not over‑engineering.

### 10. Agent prompt hints

- **Sabha** — split as of 2026.4.29 (#18): `inboundFormattingHints` carries the fuller Sabha identity stub + `@{USER_ID}` mention rule + Markdown rules for the **inbound auto‑reply path** (ungated by tool profile, but inbound‑only). `messageToolHints` carries a single‑line minimal identity + mention reminder for **proactive (non‑inbound) agent runs** plus advisory hints (search truncation, `read` newest‑first). The two hooks cover different render paths, not the same path twice. Pre‑split, identity and mention lived only in `messageToolHints` and silently disappeared on `coding`‑profile inbound runs where the SDK gate fires.
- **Discord** — `messageToolHints` ≈ 2 lines, only on components (`set components when sending messages to include buttons, selects…`).
- **Slack** — ≈ 8 lines: `slack_mrkdwn` formatting + interactive‑replies guidance gated on the `interactiveReplies` capability flag. Splits hooks correctly: formatting in `inboundFormattingHints`, tool‑tier guidance in `messageToolHints`.
- **Mattermost** — minimal hints; trusts agent priors.

**Sabha verdict: aligned with peer convention as of 2026.4.29.** Discord and Slack assume agents know `<@id>` and `@username`. Sabha's `format_mentions` regex silently drops anything but `@{id}`, so the identity + mention rule defends against a concrete failure mode. Sabha is now the second peer (after Slack) to use `inboundFormattingHints` for non‑formatting content — a deliberate deviation justified by the SDK gating of `messageToolHints` (gone on non‑`messaging` profiles). See `docs/MESSAGE-TOOL-HINT-DEPENDENCE-PLAN.md` for the full plan + decision record. **Known residual gap:** fast‑reply mode skips `inboundFormattingHints`; operators on that path use `tools.alsoAllow: ["message"]` or per‑room `systemPrompt`.

### 11. Setup wizard

- **Sabha** — ~909 lines in `setup-wizard.ts`. Join URL → POST `/join/{code}` → server returns `{bot_key, name, websocket_url, …}` → save config. Multi‑account‑aware (can register a new bot under a new account id). Webhook inbound mode was dropped in 2026.4.29 (#17), so the wizard no longer captures `webhookSecret` / `webhookPort` / `connectionMode`; the server response still includes a `webhook_url` field for forward‑compat but the plugin discards it.
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

- **Sabha** — 22 / 49 = 45%. Coverage: accounts, account-inspect, channel, dedup, directory, draft-stream, inbound, monitor, monitor-websocket, reconnect, retry, setup-contract, setup-wizard, ssrf-guard, typing, client, message-actions, outbound chunking + mention-rewrite + format, doctor.
- **Mattermost** — 37 / 98 = 38%.
- **Slack** — 85 / 248 = 34%. Heavy emphasis on Block Kit rendering snapshots and action dispatch.
- **Discord** — 124 / 351 = 35%. Heavy emphasis on component rendering and interaction routing.

**Sabha verdict: highest coverage density of any peer in the matrix.** No action.

## What would a Mattermost developer find weird about Sabha

1. `accounts: Record<id, ...>` instead of one bot per instance.
3. The mention‑syntax sermon in `messageToolHints` (Mattermost mentions are `<@id>`, agent priors work).
4. Per‑bot `allowPrivateAttachmentHosts` (Mattermost has it per‑instance).

## What would a Discord/Slack developer find weird about Sabha

1. No rich UI primitives at all — coming from Block Kit / Carbon, the message envelope feels bare. (No `pin` / `unpin` / `list-pins` action either; Sabha's bot API has no native pin endpoint.)
2. Self‑registration flow vs. OAuth or Dev Portal token paste — easier, but unfamiliar.
3. Single inbound dispatch file (`inbound.ts`) instead of `monitor/events/<namespace>.ts` per event family.
4. The identity preamble is unusual — Discord/Slack don't tell agents what platform they're on.
5. Two `registerTool` agent tools (Slack/Discord/Mattermost expose **zero**). Sabha keeps `sabha_search_members` for room-scoped name lookup and `sabha_create_dm` for explicit DM materialization — both are SDK gaps the peer plugins don't run into.

## Hypothetical growth: what Sabha‑the‑plugin would need if Sabha‑the‑platform added X

| Sabha platform feature | Plugin code delta | Pattern to copy |
|---|---|---|
| Rich message cards (embeds) | +200–300 LOC, 2–3 files | Discord's `outbound-payload.ts` + schema additions |
| Buttons / select menus | +500–800 LOC, 4–5 files | **Slack's shorthand** (`[[slack_buttons:Label:value]]`), not Discord's raw component JSON |
| Slash commands | +200–400 LOC, 2–3 files | Discord's slash‑command + interaction routing |
| Pin / unpin / list-pins | +50 LOC | Add to `SUPPORTED_ACTIONS` + `handleAction` in `src/message-actions.ts` (the adapter slot is already wired) |

Inflection point for the codebase shape: at one new feature, file structure stays flat. Adding two of the above triggers `monitor/events/<namespace>.ts` reorganization and the action‑dispatcher pattern from Discord/Slack.

## Patterns Sabha is doing better

1. **Self‑registration via join URL** — cleanest setup ceremony of any peer. Captures a Sabha‑platform advantage.
2. **Bot‑key redaction in stream errors** — peers don't need it because their tokens are opaque blobs. Defense‑in‑depth.
3. **Verbose mention‑syntax preamble** — costs tokens, but defends against a concrete failure mode peers don't face.
4. **Defensive modules** (`ssrf-guard.ts`, `dedup.ts`, `retry.ts`) — better audit surface than peers' inline equivalents.

## Drift worth tracking

1. **Inbound + fast‑reply + non‑`messaging` profile loses both hooks.** After the 2026.4.29 split, identity + mention syntax live in `inboundFormattingHints` (inbound‑only, ungated by tool profile) and a minimal copy stays in `messageToolHints` (every‑prompt, gated on `availableTools.has("message")`). Cells covered: inbound + any profile (via `inboundFormattingHints`) and proactive + `messaging` (via `messageToolHints`). The uncovered cell is inbound + fast‑reply + non‑`messaging` — fast‑reply skips the formatting hints, and the gate drops the message‑tool hints. Workaround: `tools.alsoAllow: ["message"]` or per‑room `systemPrompt`. Closing this with a plugin‑only change isn't possible; revisit only if real‑world impact materializes. See `docs/MESSAGE-TOOL-HINT-DEPENDENCE-PLAN.md`.
2. **One harmless config writeback per boot from `dmPolicy`.** The SDK's static `COMMON_SINGLE_ACCOUNT_KEYS_TO_MOVE` set includes `dmPolicy`, which gets schema-defaulted at the channel root on every load. The migration shim then deletes it from the base block (because `accounts.default.dmPolicy` already holds the same value), bumping `meta.lastTouchedAt` once per boot. The watcher's restart predicate doesn't fire on a pure base-block deletion, so the loop is dead — but the writeback persists. Out of plugin's reach to fix without an SDK API to override the static set.

## Resolved drifts (kept for diff‑against‑history)

- ~~**Webhook fallback alongside WS, with multi‑bot interaction footgun (HTTP `POST /sabha/webhook` routed everything to default account regardless of which bot's secret signed the payload).**~~ **Resolved 2026.4.29** (PR #17). Webhook inbound mode dropped wholesale alongside `connectionMode` / `webhookSecret` / `webhookPort` config keys, the `groupManagement: true` capability flag, the HTTP route registration, and webhook branches in `startAccount` / `doctor` / `account-inspect`. Reasoning: the multi‑account routing gap was real, and the operator-facing benefit (run behind a NAT without WS access) was already covered by the AnyCable WS connection — Sabha's `/cable` endpoint works through the same outbound HTTPS that the bot already uses for REST. Cutting the mode was a strict reduction in maintained surface area; no new use case justified retrofitting per‑bot routing. The setup‑wizard still discards the server's `webhook_url` field for forward‑compat in case a future Sabha server only emits the WS URL conditionally.
- ~~**10 `registerTool` factories for room/member admin (`sabha_create_room`, `_update_room`, `_archive_room`, `_join_room`, `_leave_room`, `_add_member`, `_remove_member`, `_list_joinable_rooms`, plus `_search_members` and `_create_dm`); peers wire 0.**~~ **Resolved 2026.4.29** (this PR). 8 admin verbs deleted alongside their backing client methods (`createRoom`/`updateRoom`/`archiveRoom`/`leaveRoom`/`addMember`/`removeMember`); `joinRoom` and `listRooms` retained for `setup-wizard.ts` and the directory adapter respectively. Reasoning was code-surface reduction, not peer-imitation: each tool is ~25 LOC of factory + ~10 LOC of backing client method + tests + a pinned endpoint integration + an entry in the LLM's per-turn tool manifest, and none of those costs were exercised by the agent flows actually running. The earlier `channel-admin-migration-plan` branch's proposal to migrate the 6 with canonical analogues onto message-tool actions (`channel-create`/`channel-edit`/`channel-delete`/`addParticipant`/`removeParticipant`/`leaveGroup`) would have been a rewrite, not a reduction. `sabha_search_members` and `sabha_create_dm` retained because the SDK has no `roomId + query` directory slot and Sabha doesn't auto-create DMs on first send. See `docs/CHANNEL-ADMIN-DROP-PLAN.md`.
- ~~**No `read` / `reactions` actions; agents could not summarize history or inspect reaction aggregates.**~~ ~~**Latent `client.search` cursor bug — `cursor=` URL param sent but server-side `CursorPaginated` concern only reads `before`, so cursor walks silently re-fetched page 1.**~~ **All resolved 2026.4.28** (this PR). Server endpoints already shipped via `sabha-co/sabha#50`. Plugin wired both as message-tool actions: `client.readMessages(opts)` + `client.listReactions(roomId, messageId)` with envelope guards (`parseReadMessagesResponse` / `parseReactionsResponse`) mirroring `parseSearchResponse`'s structural-only stance for in-file consistency. The `client.search` cursor mapping was corrected in the same PR — `cursor` rides on the dual-purpose `before` URL param now (intentional behavior change, called out in PR description). Newest-first ordering surfaced both in the dispatch response `note` and in `messageToolHints` so summarize-this-thread agents reorder client-side. Schema fragment broadened: `before`/`after`/`limit`/`cursor` field descriptions now cover both `search` and `read` (no new fragment — same fields, shared underlying `CursorPaginated` concern). See `docs/READ-AND-REACTIONS-ACTIONS-PLAN.md` for the full design record (server-side wire-shape verification + the v1-against-stale-base story).
- ~~**Top‑level → new‑thread streaming was non‑streaming (Phase 2 gap).**~~ **Resolved 2026.4.28.** Added an optional `firstSend` callback to `createSabhaDraftStream`. When the deliver path detects `shouldThread === true` it wires `firstSend(text) → client.replyInThread(parentRoomId, userMessageId, text) → { roomId: r.thread.id, messageId: r.message.id }`. The stream rebinds its effective room id to the captured thread room so all subsequent `editMessage` / `deleteMessage` / recovery-edit / error-replace calls target the thread, not the parent. `shouldStreamReply` was deleted (every case streams now); `monitor.ts` creates the stream unconditionally and configures `firstSend` only for the threading-on case. (Pre-2026.4.29 the webhook entry in `index.ts` carried the same wiring; removed when webhook inbound mode was dropped — see the entry below.) Sabha's `/thread` endpoint is idempotent via `find_or_create_for`, so a network-drop retry can't fork the thread. The case-(c) deliver fallback (stream dead with no preview ever sent) still honors `shouldThread`: `replyInThread` if we were supposed to thread, plain `sendMessage` otherwise. Closest peer pattern: Slack's `resolveThreadTs`.
- ~~**No `ChannelMessageActionAdapter`; directory tools registered as agent tools.**~~ **Resolved 2026.4.27** (commits across the rename pass + #11 + `0ae9786` / `41ecefb` / `5e6dece`). `actions.handleAction` wired in `src/message-actions.ts` — 7 actions through the shared `message` tool. Directory adapter wires the canonical 3 slots (`listGroups`, `listPeers`, `listPeersLive`); the peer pair pulls from `GET /api/bots/users` (paginated, server-side scoped to bot-room-overlap). `sabha_list_rooms` / `sabha_search` / `sabha_list_members` removed from `src/tools.ts`. Directory adapter scopes to default account when `accountId` is null — Sabha is cross‑tenant (different `apiBaseUrl`s = separate workspaces with overlapping room ids), so unioning would collide ids.
- ~~**`listGroupMembers` wired as a 4th directory slot.**~~ **Resolved 2026.4.27 same-day.** Briefly wired then dropped after a scale review against Slack/Discord. The slot's SDK signature `(groupId, limit)` is paginated-dump-only (no `query` field), and at Slack/Discord scale a 100k-member room can't be enumerated through a single agent call. All three peers skip this slot for the same reason. Sabha now matches: agents reach `member-info` for individual user lookups, `listPeers` for workspace-level search, or read mention metadata directly from inbound payloads. Both `listGroupMembers` and the underlying `client.listMembers` REST wrapper were removed; the `/api/bots/rooms/:id/members` server endpoint still exists but isn't called from the plugin. If sabha-the-platform ever needs an in-room membership primitive, the right shape is per-question (`member-in-room?(userId, roomId)`, `room-info` summary) rather than a list.
- ~~**No `listPeers` because Sabha's bot API has no global users endpoint.**~~ **Resolved 2026.4.27** — `GET /api/bots/users` exists and returns the bot's reachable user set (server-side scoped to room overlap). Pagination capped at 100 pages × 100/page = 10 000 users, with a structural `users.length === 0 break` and short-page terminators in `src/directory.ts`.
- ~~**No `accountInspect` contract.**~~ **Resolved 2026.4.27 follow-on.** Brought up to Slack/Discord/Telegram parity in `src/account-inspect.ts`: tri-state credential status, per-credential `*Source`, full merged `config` for audit reuse. Sabha-tailored omissions: no env-var resolution path, no `tokenFile` indirection.
- ~~**Unknown `agentAccountId` falls through to base-only config**~~, ~~**disabled-account tools silently service**~~, ~~**`threading.resolveReplyToMode` ignores per-bot overrides**~~. **All resolved in the 2026.4.27 rename pass.** `getClientForTool` validates against `listSabhaAccountIds(cfg)` and falls back to default; throws on `enabled: false`. `threading.resolveReplyToMode` reads via `resolveSabhaAccount({ cfg, accountId })`, matching what the deliver callbacks see. The same pass collapsed multi-account plumbing onto `createAccountListHelpers("sabha")` (canonical SDK keys: `accounts:` / `defaultAccount:`).
- ~~**Boot loop from schema-defaulted promotion keys.**~~ **Resolved 2026.4.27** (commit `1cc5ec7`). `typingEnabled` / `replyToMode` (and formerly `connectionMode` / `webhookPort`, now removed) had `default:` values in `openclaw.plugin.json` *and* sat in `sabhaSingleAccountKeysToMove`; the schema loader injected them on every load, the migration shim "promoted" them, the file watcher saw `meta.lastTouchedAt` bump and fired SIGUSR1, ad infinitum. Fix: drop schema-defaulted keys from the migration list — they can never legitimately appear at the base block on disk in a post-rename install. Test pinned at `src/setup-contract.test.ts` to prevent re-introduction.

## References

- `/Users/ashwin/dev/openclaw/extensions/mattermost/` — closest peer (text‑first, simple)
- `/Users/ashwin/dev/openclaw/extensions/slack/` — Events API + Socket Mode + Block Kit
- `/Users/ashwin/dev/openclaw/extensions/discord/` — gateway + Carbon components
- `/Users/ashwin/dev/openclaw/extensions/feishu/` — multi‑account pattern parallel to Sabha (not in matrix)
- `docs/ARCHITECTURE.md` — Sabha plugin's own architecture
- `docs/MESSAGE-TOOL-HINT-DEPENDENCE-PLAN.md` — 2026.4.29 split moving identity + mention syntax out of `messageToolHints` into `inboundFormattingHints`
- `docs/OUTBOUND-RICH-TEXT.md` — Sabha's markdown → Trix HTML pipeline
- `docs/READ-AND-REACTIONS-ACTIONS-PLAN.md` — design record for `read` / `reactions` and the search-cursor fix
