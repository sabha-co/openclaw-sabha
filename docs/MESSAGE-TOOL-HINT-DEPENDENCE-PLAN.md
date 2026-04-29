# Reduce dependence on `messageToolHints`

**Status:** Proposed (2026-04-29).
**Problem area:** Sabha-specific agent context currently depends too heavily on `agentPrompt.messageToolHints`, even though OpenClaw core owns prompt wiring and gates that hook behind the shared `message` tool.

## Goal

Reduce dependence on `messageToolHints` for correctness-critical Sabha identity, so future tool-profile drift does not silently degrade the bot.

The current state works for the common path. Most current Sabha deployments run on the `messaging` profile, where `messageToolHints` renders normally and identity is already present. This plan hardens the dependency surface before it becomes a user-visible problem.

## Non-goals

- Do not maintain a private OpenClaw SDK fork.
- Do not reintroduce `/skill` prompt injection or any other large prompt-payload workaround.
- Do not redesign OpenClaw's global prompt builder from this repo.
- Do not expand Sabha-specific `registerTool` surface as a substitute for missing prompt context.
- Do not chase observability or measurement work for this change. This is structural simplification, not metric work.

## Known residual gap

Fast-reply mode skips `inboundFormattingHints` entirely. Any deployment running fast-reply on a non-`messaging` profile loses both `messageToolHints` (gated) and `inboundFormattingHints` (skipped).

This plan does not solve that case. It is accepted scope. Operators on that combination should use `tools.alsoAllow: ["message"]` or per-room `systemPrompt`.

## Background

The official SDK docs describe prompt wiring as a **core** responsibility, not a channel-plugin responsibility. Channel plugins own config, security, threading, target resolution, and outbound behavior; core owns the shared `message` tool and prompt assembly. See `docs/sdk-channel-plugins.md` and `docs/sdk-overview.md`.

The relevant OpenClaw core behavior is the `buildMessagingSection` gate in `openclaw/src/agents/system-prompt.ts`: `messageToolHints` is rendered only when `availableTools.has("message")`. On profiles like `coding`, the entire `message`-tool subsection is omitted.

Peer-plugin context matters here:

| Plugin | `messageToolHints` | `inboundFormattingHints` |
|---|---|---|
| Slack | narrow, tool-adjacent guidance | yes, formatting-only |
| Discord | narrow, component-oriented guidance | no |
| Mattermost | none | no |
| Sabha | identity + mention syntax + planning notes | yes, currently markdown-only |

Sabha is the unusual case because wrong mention syntax is silently dropped by the server: `@{USER_ID}` works, while Discord-style `<@id>` and Slack-style `@username` do not.

The operator-side workarounds already available are:

- `tools.alsoAllow: ["message"]` to ensure the `messageToolHints` block renders
- per-room `systemPrompt` for deployments that need stricter room-specific identity guidance

## Current state

Today Sabha still carries some correctness load in `src/channel.ts:messageToolHints`:

- platform identity preamble
- mention syntax (`@{USER_ID}`)
- search truncation guidance
- `read` newest-first ordering note

That is the structural smell. The common path works, but correctness depends on a prompt hook that core may omit depending on tool profile.

## Target state

After this work:

1. Losing `messageToolHints` should degrade convenience, not correctness.
2. On the non-fast-reply inbound path, Sabha identity and mention syntax should arrive independently of whether the agent's tool profile includes `message`.
3. `messageToolHints` should remain as optional advisory guidance for `message`-enabled profiles, not as the only source of truth.
4. The plan should be self-contained and should not rely on deleted prompt-context docs for rationale.

## Proposed design

Identity + mention syntax live in **both** hooks because the two cover different render paths, not the same path twice. This was clarified by review feedback after the initial draft assumed a single render path.

- `messageToolHints` is rendered by `buildMessagingSection` on **every agent system prompt** where the `message` tool is in scope — including proactive (non-inbound) agent runs.
- `inboundFormattingHints` is rendered by `buildInboundMetaSystemPrompt` on the **inbound auto-reply path only** — it does not fire for proactive runs.

So a "move identity out of `messageToolHints`" approach would regress proactive Sabha sends (e.g. a `messaging`-profile agent invoked by a user to "send a Sabha message about the build"). The agent would have the `message` tool but no Sabha-platform identity in the prompt, and would default back to Discord/Slack mention syntax.

The right shape is:

### `inboundFormattingHints` carries the fuller identity stub (additive)

- "You are on Sabha — a team chat platform. NOT Discord, Slack, Teams, or Telegram."
- "To mention a user, emit `@{USER_ID}` (curly braces). Discord-style `<@id>` and Slack-style `@username` are silently dropped."

This is the path that survives non-`messaging` tool profiles (where the SDK gate would otherwise drop `messageToolHints` entirely on the inbound path).

### `messageToolHints` retains a minimal identity reminder (preserved)

- "SABHA MENTIONS: You're on Sabha (not Discord/Slack/Teams). Mention users with `@{USER_ID}` (curly braces, numeric id) — Discord-style `<@id>` and Slack-style `@username` are silently dropped by Sabha's server."

Single line. Covers proactive runs that `inboundFormattingHints` doesn't reach. Not redundant with the inbound path — different scenario, different render site.

### `messageToolHints` advisory hints (unchanged)

- search-truncation note (`hasMore`, `nextCursor`, scoping guidance)
- `read` newest-first note

### Stripped from `messageToolHints` (subtractive)

- the verbose platform-identity preamble (700+ chars about room types, threading rules, role taxonomy, etc.)
- the verbose mention-syntax block (the long form with worked example)

The verbose copies are the cost we wanted to drop. The minimal one-line reminder stays.

## Decisions

### Decision 1: Stay plugin-side

Do not plan around patching OpenClaw core.

Reason:

- the cleanest fix would be upstream: render `messageToolHints` whenever `runtimeChannel` is set
- this repo cannot assume upstream acceptance
- a private SDK fork would create permanent merge and support cost

### Decision 2: Keep `messageToolHints`, shrink it, but retain minimal identity

Do not delete `messageToolHints`.

Initial draft proposed a clean "move identity out" — that was reversed in review after recognizing that `messageToolHints` and `inboundFormattingHints` cover **different render paths**, not the same one twice.

Concretely:

- shrink the verbose identity preamble + verbose mention-syntax block (the cost we wanted to drop)
- retain a minimal one-line identity + mention reminder for proactive (non-inbound) agent runs
- retain advisory `message`-tool-adjacent hints (search truncation, read newest-first)
- treat its absence on `coding`-profile inbound runs as a convenience loss covered by `inboundFormattingHints`

### Decision 3: Use room `systemPrompt` as the operator escape hatch, not the default fix

Keep per-room `systemPrompt` documented as the strongest no-code override for operators who need stricter Sabha identity context.

The field already exists in `SabhaRoomConfigSchema`; no plugin code change is needed for operators to use it.

Do not treat it as the primary architectural fix because:

- it is operator-configured, not automatic
- it is room-scoped, which is too granular for baseline platform identity
- it pushes plugin correctness onto deployment config

### Decision 4: Action correctness lives on action surfaces

If an agent must know a fact to use an action correctly, encode it in:

- the action schema
- the action result or note
- or `inboundFormattingHints`

`messageToolHints` is reserved for planning hints that are nice-to-have, not correctness-load-bearing.

Today's `read` and `search` envelopes already meet this bar. This decision codifies the rule going forward.

## Implementation units

### 1. Narrow and rebalance prompt responsibilities

Files:

- `src/channel.ts`
- `src/channel.test.ts`

Changes:

- Add the Sabha identity + mention syntax stub to `inboundFormattingHints.rules` (fuller form for inbound path)
- Replace the verbose preamble + verbose mention block in `messageToolHints` with a single minimal identity-and-mention line for proactive runs
- Retain advisory `message`-tool hints (search truncation, `read` ordering)

Tests:

- `src/channel.test.ts`

Scenarios:

- `inboundFormattingHints` includes the Sabha identity line
- `inboundFormattingHints` includes the `@{USER_ID}` mention rule
- `messageToolHints` retains a minimal identity reminder (matches `Sabha` and one of `Discord/Slack/Teams`)
- `messageToolHints` retains the `@{USER_ID}` mention rule with the silent-drop warning
- `messageToolHints` still returns advisory search/read guidance
- `messageToolHints` no longer carries the verbose pre-2026.4.29 preamble (`YOU ARE ON SABHA`, room-type taxonomy)
- tests assert key substrings rather than large exact prompt blobs

### 2. Document the new responsibility split and clean references

Files:

- `docs/ARCHITECTURE.md`
- `docs/CHANNEL-PLUGIN-COMPARISON.md`
- `README.md`
- `CLAUDE.md`
- `docs/MESSAGE-TOOL-HINT-DEPENDENCE-PLAN.md`

Changes:

- Update the prompt-architecture narrative to say:
  - `inboundFormattingHints` carries the minimal Sabha identity and mention syntax
  - `messageToolHints` is advisory and `message`-tool-scoped
  - per-room `systemPrompt` remains the operator override
- Update README operator guidance to distinguish:
  - baseline: identity + mention syntax arrive via `inboundFormattingHints` on standard-reply paths regardless of profile
  - stronger: `tools.alsoAllow: ["message"]` adds advisory `messageToolHints` such as search/read planning notes
  - strongest: per-room `systemPrompt` for room-specific behavior
- Add explicit reference cleanup for the removed `AGENT-PROMPT-CONTEXT.md`

Reference cleanup:

- Strip stale references from `CLAUDE.md`, `docs/ARCHITECTURE.md`, `docs/CHANNEL-PLUGIN-COMPARISON.md`, and this plan's own references section
- Absorb the still-relevant institutional context into this plan's Background section:
  - the SDK gate in `buildMessagingSection`
  - the peer-plugin survey summary
  - the operator workaround via `tools.alsoAllow: ["message"]` or per-room `systemPrompt`

## Suggested execution order

1. Move the minimum identity and mention syntax into `inboundFormattingHints`.
2. Trim `messageToolHints` to the residual advisory content.
3. Tighten `src/channel.test.ts` around the new split.
4. Update docs and remove stale references to deleted prompt-context material.

## Risks

### Putting identity in `inboundFormattingHints` is a peer-plugin deviation

Slack is the only peer using this hook today, and only for formatting.

Mitigation:

- keep the stub minimal
- use it only for identity and mention syntax
- revisit if the SDK ever adds a dedicated identity slot

### Overloading `inboundFormattingHints`

Putting too much identity prose into a formatting hook would recreate the same problem under a different name.

Mitigation:

- keep the stub minimal
- move action semantics into action surfaces, not prompt prose

### Test brittleness from long prompt strings

If tests pin large exact strings, every wording change becomes noisy.

Mitigation:

- assert for key substrings and intent
- avoid snapshotting full hint payloads

## Future work, not in scope

- Explore whether a tiny Sabha identity marker can live in the inbound envelope itself. That is the only plugin-local direction that could help the fast-reply path without relying on `messageToolHints`, but it is not part of this plan.
- Revisit an OpenClaw core-side fix only if fast-reply plus non-`messaging` profile becomes a real deployment problem.

## Exit criteria

This plan is complete when:

- on the non-fast-reply inbound path, Sabha identity and mention syntax arrive via `inboundFormattingHints`, independent of whether the agent's tool profile includes `message`
- on proactive (non-inbound) runs with the `message` tool in scope, Sabha identity and mention syntax still arrive via `messageToolHints` — the minimal one-line stub covers the path that `inboundFormattingHints` does not reach
- fast-reply remains a known residual gap with accepted scope
- the verbose pre-2026.4.29 identity preamble (room types, threading rules, role taxonomy, worked examples) is gone from both hooks; only the minimal identity + mention rule remains
- no doc references to deleted prompt-context material remain

## References

- `docs/sdk-channel-plugins.md`
- `docs/sdk-overview.md`
- `src/channel.ts`
- `src/inbound.ts`
- `docs/ARCHITECTURE.md`
- `docs/CHANNEL-PLUGIN-COMPARISON.md`
- `README.md`
- `CLAUDE.md`
