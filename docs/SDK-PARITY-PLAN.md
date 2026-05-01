# Close SDK parity gaps with bundled peers

**Status:** Mostly shipped (2026-05-01). Phase 1, Phase 2 minimum viable subset, and Phase 2.5 (`resolveDeliveryTarget` + `inferTargetChatType`) are all live; Phase 3 and Phase 4 deferred per their entry conditions; two new bug classes surfaced during implementation are also closed.
**Problem area:** Sabha is an externally-installed channel plugin (`@sabha-co/openclaw-sabha`, origin `"global"`) and has accumulated several quiet divergences from the bundled-peer baseline — fields and slots the SDK silently relies on. Most are no-ops in the happy path; each manifests as a confusing "agent confabulates / target unknown / sub-agent loses thread" failure when an edge case fires.

## What shipped on 2026-05-01

Re-deploy on the VPS confirmed the "edit your last message to 'ok'" workflow end-to-end after these landed (`react` → `read` → `edit` all return `[sabha-action] ok` against live traffic).

- `63eaaec` — wire-param fix: `client.search` now sends `q=<value>` instead of `query=`. Live `/search` was 422'ing because the Sabha server reads `params[:q]` (`app/controllers/api/bots/searches_controller.rb:7-8`). Not part of the original plan; surfaced from the same triage thread.
- `ae79be4` — Phase 2 minimum viable subset: `messaging.targetResolver { looksLikeId, hint, resolveTarget }` + `messaging.normalizeTarget`. Closes the `Unknown target "21"` cascade. See "Phase 2" below for the deferred sub-fields.
- `1928105` — `read`/`search`/`reactions`/`member-info` switched from a bespoke `ok(text, details)` helper to the SDK's `jsonResult(payload)`. Not part of the original plan; see "Bug classes uncovered" below.
- `3c57961` — `send`/`thread-reply`/`edit`/`unsend`/`react` write actions also switched to `jsonResult`. Drops the `ok` helper entirely; Sabha now matches Slack/Discord uniformly.
- `140c3d5` — Phase 1: `MessageThreadId` and `WasMentioned` on inbound `MsgContext`. Tests cover thread/non-thread × group/DM × mention/no-mention cells. Latent bug — closes the sub-agent-thread-escape and per-thread-transcript-collapse risks before they bite.

Untouched: Phase 3 (`threading.buildToolContext`), Phase 4 (`secrets`), and the two deferred Phase 2 sub-fields (`resolveDeliveryTarget`, `inferTargetChatType`) below.

## Goal

Close the remaining concrete gaps between Sabha's plugin contract and the bundled-peer baseline (Slack / Discord / Telegram / Feishu / Mattermost), in priority order driven by impact, so future debugging stops re-deriving the same SDK call sites from `node_modules` line by line.

## Non-goals

- Do not maintain a private OpenClaw SDK fork.
- Do not chase parity with every peer slot — only the ones with a concrete behavior signal.
- Do not redesign Sabha's outbound or threading models. This is plumbing parity, not architecture.
- Do not gate this work on upstream SDK changes (e.g., the `messageActionTargetAliases` bootstrap-registry gap, which we cannot fix from plugin code).

## Background

This plan came out of two consecutive triage sessions on 2026-04-30 where the same investigative pattern repeated:

1. Live VPS journal shows an unexpected agent failure (`"Action react requires a target"`, `"Unknown target 'General'"`, `"Sabha API error 404"` on edit).
2. Investigation traces into `node_modules/openclaw/dist/*` to read the SDK call site that produced the error.
3. We discover Sabha is missing a field or slot that every bundled peer wires.
4. Fix it, ship, redeploy, and immediately surface the next gap behind it.

Two fixes have already shipped:

- `0fbf175` — dropped the dead `messageActionTargetAliases` block (silently dropped by the gate because `getBootstrapChannelPlugin` is bundled-only) and removed a misleading prompt nudge.
- `ef12585` — set `Provider` / `Surface` / `OriginatingChannel` / `OriginatingTo` on `finalizeInboundContext` so `buildThreadingToolContext` no longer short-circuits at `if (!rawProvider) return { currentMessageId };`. Auto-fill of `target` from `currentChannelId` now works for Sabha inbounds.

This plan covers the **remaining** divergences identified in the audit pass that followed those two fixes.

## Findings (prioritized)

### P1 — `messaging` slot entirely absent

Sabha's plugin object has no `messaging: { … }` block. Every bundled peer ships one:

- Slack — `extensions/slack/src/channel.ts`
- Discord — `extensions/discord/src/channel.ts`
- Telegram — `extensions/telegram/src/channel.ts:683-720`
- Feishu — `extensions/feishu/src/channel.ts:1147-1190`
- Mattermost — `extensions/mattermost/src/channel.ts:308-340`

The SDK reads `plugin.messaging?.X` at **~25 call sites** under `node_modules/openclaw/dist/`. Without the slot, each falls through to a generic default; some defaults work, some return `undefined` and the caller fails or silently misroutes.

The most impactful sub-fields, ranked by user-visible consequence:

1. **`targetResolver: { looksLikeId, hint, resolveTarget }`** — the *fallback* the message-action runner consults when the directory adapter returns no match. Sabha has `resolver.resolveTargets` for the **directory** path; this is a separate path. The "Unknown target 'General' for Sabha." failure observed live is most likely landing here.
   - Sites: `reply-payloads-dedupe-Behk9vEr.js:48-72` (`maybeResolvePluginMessagingTarget`), `message-action-runner-BN7W0fv6.js:670` (hint), `targets-C9PQ3zQd.js:42`.

2. **`normalizeTarget(raw)`** — canonicalizes a target string before dedup / send.
   - Sites: `reply-payloads-dedupe-Behk9vEr.js:16`, `pi-embedded-Vw-lS5ti.js:11035`.
   - Without this, replies addressed to the same room with different surface forms (e.g. `"5"` vs `"sabha:5"`) won't dedup, risking duplicate sends in retry paths.

3. **`resolveDeliveryTarget({ conversationId, parentConversationId })`** — derives the outbound `{ to, threadId }` pair from a session id pair. Critical for thread-aware delivery.
   - Sites: `delivery-context-BB8mcaUV.js:33,44`.
   - For Sabha threads, the parent room and the thread room are distinct; without this hook, the SDK falls back to using `conversationId` directly, which is the thread room id — fine for the wire but loses the parent association used by some auto-reply paths.

4. **`resolveInboundConversation({ to, conversationId, threadId })`** — Sabha-specific inbound conversation resolution.
   - Sites: `captured-registration-B0zh8nof.js:510`, `message-hook-mappers-Cvg4GTnD.js:84`.
   - Used for captured-message routing (slash commands, captured registrations). Less critical for the runtime auto-reply path; matters for advanced features.

5. **`parseExplicitTarget({ raw })`** — parses `<channel>:` / `<user>:` prefix forms before lookup.
   - Sites: `target-parsing-B0rjiTg_.js:10`.
   - Sabha rooms are bare numeric ids today; minor unless we introduce prefix forms.

6. **`inferTargetChatType({ to })`** — infer DM vs group from the target shape.
   - Sites: `message-action-runner-BN7W0fv6.js:548`, `targets-C9PQ3zQd.js:251`.
   - Without it, the SDK can't distinguish DM-like targets from group targets when the agent supplies only a numeric id. We currently rely on session-key chat-type inference, so this is partial coverage at best.

7. **`formatTargetDisplay({ target, display, kind })`** — pretty-print a target for logs / UI.
   - Sites: `message-action-runner-BN7W0fv6.js:521`.
   - Cosmetic; Sabha shows raw room ids today.

8. **`transformReplyPayload(payload)`** — last-mile reply payload mutation.
   - Sites: `agent-command-8TL7BESJ.js:571`, `channel-reply-pipeline-BqQuVf4k.js:9`.
   - We currently do this work inside `client.sendMessage` (markdown → Trix). Likely no-op to add here too.

9. **`resolveOutboundSessionRoute(params)`** — session-routing for outbound.
   - Sites: `message-action-runner-BN7W0fv6.js:1088`.
   - Defines how outbound messages map onto session keys. Sabha's `session.ts:resolveSessionFromPayload` handles inbound; outbound routing currently uses generic SDK defaults.

**Why this is P1:** the cumulative effect is that *most* SDK paths that go through the plugin contract for outbound routing skip Sabha's customization. The "Unknown target" failures are the visible tip; the silent-misroute and dedup-miss cases are the iceberg.

### P2 — `MessageThreadId` not set on inbound MsgContext

`src/inbound.ts:210-215` sets `ReplyToId: session.threadId` for thread inbounds but never sets `MessageThreadId`. Bundled peers (Mattermost `monitor.ts:662`, Feishu, Telegram) all set both.

SDK readers:

- `apply-DIHPhxcY.js:57` — `threadId: ctx.MessageThreadId ?? void 0` for outbound apply path. Sabha's draft-stream owns deliver, so this primarily affects non-draft-stream apply paths (e.g. media echo-transcript).
- `action-spawn-DNsZAtA6.js:37` — `agentThreadId: params.ctx.MessageThreadId` when an agent **spawns a sub-agent** from a thread. Without this, the spawned sub-agent inherits no thread context and replies escape to the parent room.
- `agent-runner.runtime-BhSS0F7i.js:2408` — per-thread session transcript paths. `resolveSessionTranscriptPath` keys by thread id; without it, multiple threads collapse into one transcript file.
- `agent-runner-utils-BZCgD3JD.js:79,159` — passed to `threading.buildToolContext` and session-context resolution.

**Why this is P2:** sub-agent spawning from a Sabha thread is rare today, so latent. Will bite when used.

### P3 — `threading.buildToolContext` not implemented

Sabha's `threading: { resolveReplyToMode }` is a single-field block (`src/channel.ts:443-452`). Bundled peers implement `buildToolContext` to populate richer tool context — `currentThreadTs`, conditional message-tool gating per thread, etc.

Without it, the SDK fall-through at `agent-runner-utils-BZCgD3JD.js:62-67` populates only `{ currentChannelId, currentChannelProvider, currentMessageId, hasRepliedRef }` — which is what the recent fix (commit `ef12585`) just enabled.

**Why this is P3:** the minimal default works for Sabha's current verbs. Filling in `buildToolContext` only matters once we add threading-aware verbs that read `currentThreadTs` (e.g., a `thread-info` or `set-thread-state` action).

### P4 — `WasMentioned` not set on MsgContext

Sabha already detects mentions in `src/webhook.ts:wasBotMentioned()` and uses the result to skip non-mention group inbounds (`src/inbound.ts`). The bit is computed but never plumbed to MsgContext. Peers (Mattermost `monitor.ts:664`, Feishu, Telegram) all set it.

SDK readers: `ack-reactions-wu9Zf6cu.js:29` (drives ack-reaction emission for some channels), command-gating paths.

**Why this is P4:** Sabha doesn't currently use ack-reactions. Setting `WasMentioned` is one line and future-proofs the bit; nothing user-visible today.

### P5 — `secrets` slot absent

Feishu (`channel.ts:677-680`) and Mattermost (`channel.ts:294-297`) wire:

```ts
secrets: {
  secretTargetRegistryEntries,
  collectRuntimeConfigAssignments,
}
```

This powers `openclaw secrets` CLI integration (rotation, target registry). Sabha doesn't expose any agent-targetable secrets beyond the bot key, which lives at `accounts.<id>.botKey` and is already canonical.

**Why this is P5:** zero runtime impact on chat. Only needed if operators ask for `openclaw secrets` integration with Sabha.

### Lesser-tier (defer indefinitely unless a signal appears)

| Slot | Peer that uses it | Why we can skip |
|------|-------------------|-----------------|
| `streaming` | Mattermost | Sabha has its own draft-stream throttles in `src/draft-stream.ts`. |
| `reload` | Mattermost | OpenClaw default config-prefix matching catches `channels.sabha.*`. |
| `text.resolveTextChunkLimit` | Mattermost | Sabha uses its own `chunkMarkdownText` in `src/outbound/chunk.ts`. |
| `scopedAccountReplyToMode` | Mattermost | Sabha threads `replyToMode` through `threading.resolveReplyToMode` already. |
| `approvalCapability` | Mattermost / Feishu / Telegram | No action-approval flows on Sabha today. |
| `doctor` | Mattermost | Sabha has its own `doctor` command via the CLI (`src/doctor.ts`). |
| `groups` | Mattermost | Group management was deliberately dropped (`docs/CHANNEL-ADMIN-DROP-PLAN.md`). |

## Bug classes uncovered during Phase 2 implementation

These don't fit the "missing slot" framing the plan was scoped to, but surfaced from the same triage thread and are documented here so future audits look for them.

### Wire-param drift between client and server

`client.search` was sending `?query=<value>` against `/api/bots/search`, but the server's `API::Bots::SearchesController` reads `params[:q]`. The client docstring claimed `?query=` and was simply wrong. Fixed in `63eaaec`.

**Audit guideline:** for any `SabhaClient` method, verify the URL-param names against the actual Sabha controller in `/Users/ashwin/dev/sabha/app/controllers/api/bots/`, not against the client's own docstring or CLAUDE.md notes. Other endpoints (`rooms`, `autocompletable/users`) genuinely use `?query=` — only `/search` uses `?q=`. Never assume uniformity.

### Tool-result `content` vs `details` inversion

Sabha had a bespoke `ok(text, details)` helper that put a human note in `content` and the structured payload in `details`. The agent loop's transformer (`pi-ai/dist/providers/anthropic.js:664`, type contract at `pi-agent-core/dist/types.d.ts:248-253`) only serializes `content` into the wire `tool_result` block; `details` goes to logs/UI and never reaches the LLM.

So `read` returned `{content: [{text: "Read 2 message(s), newest first"}], details: {messages: [...]}}` and the LLM literally got `"Read 2 message(s), newest first"` — no IDs, no authors, no text. The agent then truthfully reported "I don't have the message IDs from that read" and stalled.

Slack (17 sites), Discord (47 sites), and Telegram (17 sites) use the SDK's `jsonResult(payload)` helper directly (`extensions/slack/src/action-runtime.ts`, `extensions/discord/src/actions/runtime.messaging.ts`), which JSON-stringifies the whole payload into `content[0].text` while mirroring it into `details`. Feishu reaches the same shape via its own thin wrapper at `extensions/feishu/src/tool-result.ts:jsonToolResult` (`{content: [{text: JSON.stringify(data, null, 2)}], details: data}`).

**Mattermost was the only other outlier**: it returns `{content: [{text}], details: {}}` with empty details. That works for Mattermost because it has no list-style actions (`read` / `search` / `reactions`) — the human-readable text in `content` carries the full result. If Mattermost ever adds a list action without switching to `jsonResult`, the same bug Sabha had will reappear.

Sabha's pre-fix shape (`ok(text, details)` with payload only in `details`) was uniquely broken because Sabha *does* have list actions and the LLM had no way to consume their results. Fixed across all nine actions in `1928105` and `3c57961`.

**Audit guideline:** every `ChannelMessageActionContext` handler in `src/message-actions.ts` should return `jsonResult({ ok: true, ...payload })`. The `ok` helper is gone; if it shows back up, that's a regression. The same applies to any future `agentTool` execute paths — assume `details` is logs-only and put everything the LLM needs into the JSON-stringified content.

## Implementation phasing

Three PRs, decoupled so each can ship and bake before the next.

### Phase 1 — Cheap inbound-context fields (shipped in `140c3d5`)

Combines P2 and P4. Both are one-line changes to `src/inbound.ts`'s `finalizeInboundContext` call.

```ts
// In src/inbound.ts:
MessageThreadId: session.threadId,
// WasMentioned: 3 of 4 inbound-handling peers gate the field on
// non-direct (Telegram `bot-message-context.session.ts:365`:
// `isGroup ? effectiveWasMentioned : undefined`; Slack
// `message-handler/prepare.ts:694`: `isRoomish ? ... : undefined`;
// Mattermost `monitor.ts:1563`: `kind !== "direct" ? ... :
// undefined`). Discord (`message-handler.process.ts:513`) sets
// `effectiveWasMentioned` unconditionally because its mention
// detection already treats DMs as mentioned. Sabha matches the
// majority pattern: leave the field absent on DMs so the
// ack-reactions check at `ack-reactions-wu9Zf6cu.js:12` doesn't
// over-trigger (`mentioned` here is from `wasBotMentioned()`,
// which examines `payload.message.mentionees` and would return
// `false` for a DM where the user just typed without an `@{N}`).
WasMentioned: session.isGroup ? mentioned : undefined,
```

`MsgContext` accepts `MessageThreadId?: string | number` and `WasMentioned?: boolean` — verified against `node_modules/openclaw/dist/plugin-sdk/src/auto-reply/templating.d.ts:144,158` and `types.core.d.ts:360`. Sabha's `session.threadId` is already string-compatible.

Tests: extend `src/inbound.test.ts`'s "PascalCase field names" test to pin both fields:
- For thread inbounds: assert `MessageThreadId === <expected thread id>`.
- For non-thread group inbounds: assert `MessageThreadId` is absent and `WasMentioned` reflects the mention-detection result.
- For DM inbounds: assert `WasMentioned` is undefined (canonical group-only behavior).

Risk: trivial. Both fields are documented on `MsgContext`; the only subtle bit is the `isGroup` gate on `WasMentioned`, which the test above pins.

### Phase 2 — `messaging` slot (partially shipped)

**Shipped in `ae79be4`** — minimum viable subset that closes the `Unknown target` cascade. Implementation in `src/messaging.ts`:

- ✅ `normalizeTarget(raw)` — canonicalizes to `<digits>` | `user:X` | `channel:X` | `<name>`, stripping `sabha:` provider prefix, folding `group:` into `channel:`, unwrapping `@{N}` (incl. inside kind prefixes), and converting `@x` / `#x` sigils to kinded forms. Tested in `src/messaging.test.ts`.
- ✅ `targetResolver.looksLikeId(raw, normalized)` — accepts bare digits, `user:<digits>`, `channel:<digits>`, `@{N}`, and (for raw inputs) `user:`/`channel:`/`group:` numeric prefixes. Names (`user:alice`, `general`) intentionally fall through to the directory path; the inline comment in `messaging.ts` explains why.
- ✅ `targetResolver.hint` — `"<roomId | userId | @{userId}>"`.
- ✅ `targetResolver.resolveTarget` — reads kind from canonical normalized form, strips the prefix, delegates to existing `resolveSabhaTargets`. Pure passthrough for numeric ids; server lookup for names.

Verified against `https://docs.openclaw.ai/plugins/architecture-internals.md` ("Channel target resolution" section). The doc explicitly says `looksLikeId` is for "explicit/native target id" checks (not directory search) and `resolveTarget` is the "provider-specific normalization fallback after directory miss" — both match what shipped.

**Phase 2.5 — both deferred sub-fields shipped together (2026-05-01):**

- ✅ `resolveDeliveryTarget({ conversationId, parentConversationId })` — implemented as `resolveSabhaDeliveryTarget` in `src/messaging.ts`. Mirrors Mattermost's `channel.ts:311-317` pattern verbatim: `parent && parent !== child ? { to: 'channel:${parent}', threadId: child } : { to: 'channel:${child}' }`. Wired by 5 peers (Mattermost, Feishu, Matrix, Slack, Telegram).

- ✅ `inferTargetChatType({ to })` — implemented as `inferSabhaTargetChatType`. One-liner against the canonical normalize prefix:
  ```ts
  if (/^user:/i.test(to)) return "direct";
  if (/^channel:/i.test(to)) return "group";
  return undefined; // bare digits stay ambiguous
  ```
  Wired by 8+ peers (Discord, Slack, Telegram, BlueBubbles, Signal, iMessage, WhatsApp, QA). The original plan's "can't tell DM vs group from a bare numeric without a server lookup" was true before Phase 2 normalize landed; once normalize emits canonical kinded forms (`user:N` / `channel:N`), inference is trivial. Bare-numeric inputs still return undefined (Sabha rooms and users share the numeric id namespace), and the SDK falls back to its own raw-prefix heuristics for those.

Tests for both at `src/messaging.test.ts` cover prefix matching, bare-numeric undefined returns, thread vs non-thread delivery, parent === child collapse, and empty-input null.

**Skip permanently** (unchanged from original plan):
- `parseExplicitTarget` — Sabha's `normalizeTarget` already canonicalizes `user:`/`channel:`/`group:`/`@{N}`/`@x`/`#x` forms to a single grammar. The SDK's default behavior over the canonical form is sufficient.
- `formatTargetDisplay` — cosmetic; current raw-id display works.
- `transformReplyPayload` — Trix conversion already happens in `client.sendMessage`.
- `resolveOutboundSessionRoute` — generic SDK fallback works for current verbs.
- `resolveInboundConversation` — only relevant for captured-registration paths Sabha doesn't currently use.

**Bake observation:** the `[sabha-action]` debug logs since deploy show `read` / `react` / `search` resolving cleanly against bare-numeric room ids. No double-route or dedup-miss signals. Original Phase 2 risk (subtle dedup behavior shift) does not appear to have manifested in the first ~hour of live traffic; keep watching for ~48h before declaring it bedded in.

### Phase 3 — `threading.buildToolContext` (1 PR, ½ day, do only when triggered)

Implement `buildToolContext({ cfg, accountId, context, hasRepliedRef })` returning:

```ts
{
  currentChannelId: context.To,
  currentChannelProvider: "sabha",
  currentMessageId: context.CurrentMessageId,
  currentThreadTs: context.MessageThreadId,  // string; SDK accepts opaque
  replyToMode: account.replyToMode,
  hasRepliedRef,
}
```

Trigger: defer until we add a verb that reads `currentThreadTs` (e.g., a `thread-info` or `mark-thread-read` action), or until live logs show empty `currentThreadTs` correlating with a user-visible bug.

Risk: low when triggered; touches one new function.

### Phase 4 — `secrets` slot (defer)

Add only if operators ask for `openclaw secrets` integration with Sabha. Spec is identical to Mattermost / Feishu — re-export `secretTargetRegistryEntries` and `collectRuntimeConfigAssignments` from a new `src/secrets-contract.ts` module, then declare the slot. Half a day.

## Testing strategy

For all phases:

1. **Unit tests** colocated with the changes (`src/inbound.test.ts`, `src/messaging.test.ts`, `src/message-actions.test.ts`).
2. **Live verification on the VPS** via the `[sabha-action]` debug logs landed in commit `b1548a5`. After each phase, redeploy and trigger the relevant agent verbs. Specifically check:
   - **Phase 1 (pending):** `MessageThreadId` and `WasMentioned` are inbound-context fields, not action-dispatch fields, so `[sabha-action]` logs won't show them directly. Verify via a test snapshot in `src/inbound.test.ts` against `finalizeInboundContext`'s output, then live-verify via `journalctl | grep MessageThreadId` once the value flows through to a downstream consumer (e.g. sub-agent spawn).
   - **Phase 2 (shipped 2026-05-01):** Confirmed live. `react`/`read` against bare-numeric room ids resolve cleanly; the `Unknown target "21"` cascade no longer reproduces. Watch the `[sabha-action]` journal stream for ~48h to confirm no dedup misses or unintended double-routes.
   - **Phase 3 (deferred):** would need new verbs to verify; n/a until a `currentThreadTs`-reading verb is added.

## Out-of-scope

- The auto-reply messageId surfacing problem (the "edit your last message" failure that brought us into this audit). **Downgraded to optional optimization as of 2026-05-01.** The `jsonResult` fixes (`1928105` + `3c57961`) closed both halves of the original bug:
  - Within-turn: `send` / `edit` / `react` now return the new id in LLM-visible content; the agent can chain on its own action results without per-room state.
  - Across-turn ("edit your previous message" later): now works via `read({roomId, limit:N})` → filter by `author.username` → pick latest id. Verified live against `OpenSabhaClaw` (msgId 150) on 2026-05-01.

  A per-room messageId cache would save a `read` round-trip but is no longer load-bearing. Open separately only if the round-trip latency or an LLM that fails the `read`-then-pick pattern becomes a real signal.
- Removing the `[sabha-action]` debug logs added in commit `b1548a5`. Drop those once the surface stays stable for ~2 weeks of production traffic. Phase 2 deploy is at day 1; revisit around 2026-05-13.
- Filing an upstream SDK PR to make `getBootstrapChannelPlugin` consult globally-installed plugins. That would re-enable `messageActionTargetAliases` for externally-installed plugins like Sabha, but: (a) we don't need it now that Phase 2 has landed the `messaging` slot, (b) we cannot self-merge it, (c) it duplicates the other paths.

## Risks

1. **Behavior shifts from adding `messaging` slot.** The SDK's reply-payload dedup, target-resolver fallback chain, and outbound delivery routing all get new branches when the slot is wired. Mitigation: keep the per-call `[sabha-action]` debug logs running through Phase 2 deployment so we can spot unintended double-routing or dedup misses immediately. *Status (2026-05-01):* Phase 2 minimum viable subset is live; first ~hour of live traffic shows clean resolves with no double-route or dedup-miss signal. Keep watching through ~2026-05-03.
2. **Type signature drift in the SDK.** The plugin contract evolves between openclaw versions. Mitigation: pin the contract version in `package.json` and run `npm run build` on every phase boundary; the type errors will surface signature changes.
3. ~~**Phase 1 / Phase 2 coupling.**~~ *No longer applies.* The coupling concern was that `resolveDeliveryTarget` (a Phase 2 sub-field) might reference `MessageThreadId` (a Phase 1 field). Phase 2 shipped without `resolveDeliveryTarget`, so the dependency vanished. Phase 1 can be opened standalone whenever, with no sequencing constraint relative to Phase 2.

## Decision points

- **Do we need this at all?** Yes. The audit started after a real user-visible failure cascade (commit `0fbf175` → `b1548a5` → `ef12585`); Phase 2 closes the most likely remaining cause of "Unknown target" in production.
- **Could we instead push fixes upstream?** No — Sabha is externally installed and the `messaging` slot is per-plugin. Upstream would only help with `messageActionTargetAliases` (already accepted as unfixable from plugin code; this plan replaces that mechanism with the slot peers actually use).
- **Phase 2 minimum viable subset.** If time-pressed, ship only `targetResolver` + `normalizeTarget`. The rest of the sub-fields are progressively less impactful and can land in a follow-up.

## Verification record (2026-05-01)

Plan claims were re-verified against the SDK internals AND the public docs at `https://docs.openclaw.ai/llms.txt` after Phase 2 shipped. Findings:

- ✅ All `MessageThreadId` reader sites cited in P2 confirmed at the listed line numbers.
- ✅ `WasMentioned` reader at `ack-reactions-wu9Zf6cu.js` confirmed; refinement to gate the field on `isGroup` (matching peer behavior at `bot-ClNJQIfx.js:3206`) folded into Phase 1's snippet.
- ✅ `threading.buildToolContext` fall-through behavior at `agent-runner-utils-BZCgD3JD.js:62-67` matches what the plan describes.
- ✅ Phase 2 design reviewed against `https://docs.openclaw.ai/plugins/architecture-internals.md` ("Channel target resolution") — `looksLikeId` semantics, `resolveTarget` as the post-directory-miss fallback, and provider-native ids in `to:` all line up.
- ✅ "Each channel plugin owns its own inbound pipeline" documented at `https://docs.openclaw.ai/plugins/sdk-channel-plugins.md`, confirming Sabha's choice to bypass the kernel `runChannelTurn` flow and run `processInboundMessage` directly is supported (rather than a workaround we should unwind).
- ⚠️ Public docs do not cover the specific `MsgContext` field set, sub-agent `agentThreadId` propagation, or the `pi-agent-core` tool-result transformer's content-vs-details semantics. Those claims are verified against `node_modules/openclaw/dist/*` only, not against `docs.openclaw.ai`. Future SDK upgrades should re-verify these claims; the docs won't be a tripwire.

A follow-up audit pass (also 2026-05-01) cross-checked the plan's peer-behavior claims against `/Users/ashwin/dev/openclaw/extensions/{slack,discord,telegram,feishu,mattermost,matrix}/src/`. Three findings:

- ↻ `WasMentioned` gating is **not** universal across peers as the plan originally implied. 3-of-4 inbound-handling peers (Telegram, Slack, Mattermost) gate on group; Discord sets `effectiveWasMentioned` unconditionally because its own mention-detection treats DMs as mentioned. Sabha matches the majority pattern, not "the canonical pattern". Phase 1 snippet updated with the fuller picture.
- ↻ `jsonResult` adoption is **not** "Sabha vs everyone" as the plan originally framed. Slack/Discord/Telegram use `jsonResult` directly; Feishu wraps it in a local `jsonToolResult`; **Mattermost** uses raw `{content, details:{}}` and gets away with it because Mattermost has no list-style actions. Sabha was uniquely broken because Sabha *does* have list actions. "Bug classes" section updated.
- ↻ Phase 2's deferred sub-fields (`resolveDeliveryTarget`, `inferTargetChatType`) are **more broadly adopted** by peers than the original "indefinite defer" framing. 5 peers wire `resolveDeliveryTarget`; 8+ wire `inferTargetChatType`. Both reclassified to Phase 2.5 with concrete shapes (`inferTargetChatType` is now a one-liner because Phase 2's normalize emits canonical kinded forms).

## References

- `src/channel.ts` — Sabha plugin object (the slots audited).
- `src/inbound.ts:192-220` — `finalizeInboundContext` call (Phase 1 target).
- `src/resolver.ts` — existing target resolution that Phase 2 will adapt.
- `node_modules/openclaw/dist/agent-runner-utils-BZCgD3JD.js:46-87` — `buildThreadingToolContext` (the function whose short-circuit ef12585 fixed; Phase 3 implements its callee).
- `node_modules/openclaw/dist/reply-payloads-dedupe-Behk9vEr.js` — primary consumer of the `messaging` slot's target resolver and normalizer.
- `node_modules/openclaw/dist/channel-target-BYsT_Fvn.js:185` — the `messageActionTargetAliases` site we cannot reach from an externally-installed plugin (context only; not part of this plan).
- `extensions/{slack,discord,telegram,feishu,mattermost}/src/channel.ts` — peer plugins used as the parity baseline.
- `docs/CHANNEL-PLUGIN-COMPARISON.md` — running comparison doc; will be updated as phases land.
- `docs/MESSAGE-TOOL-HINT-DEPENDENCE-PLAN.md` — adjacent prior plan; pattern reference for this doc's shape.
