# Channel context in the agent system prompt

How Sabha-specific context (platform identity, mention syntax, output formatting) reaches the agent's system prompt — and why an earlier attempt to inject Sabha's full `/skill` API reference into every agent prompt was removed.

## The symptom that triggered this

In a sabha-routed session on a gateway running `tools.profile = "coding"`, a user asked the bot what app it was on. The bot replied:

> No memory or skill file mentions Sabha — the only clue was the `[sabha …]` prefix on your messages, which I wasn't sure how to interpret (could be a bridge, bot name, or app). I guessed WhatsApp-ish because I didn't want to pretend I knew for certain.

The plugin's `messageToolHints` resolver in `src/channel.ts` was emitting a 700-character platform identity preamble (`YOU ARE ON SABHA — NOT Discord, Slack, Teams, or Telegram…`) plus a 19 KB cached `/skill` API reference. The bot saw none of it. Inspecting `context.compiled` confirmed: 18 tools registered (`edit`, `exec`, `read`, `write`, `web_*`, `memory_*`, `sessions_*`, etc.), no `message`, and the strings `Sabha` / `La La Land` / `YOU ARE ON SABHA` appeared zero times in the 26 KB rendered system prompt.

## Root cause

The OpenClaw SDK's prompt builder gates `messageToolHints` behind tool registration. From `openclaw/src/agents/system-prompt.ts:buildMessagingSection` (verified against the local checkout on 2026‑04‑26 — line numbers may drift):

```ts
return [
  "## Messaging",
  // …generic preamble, always rendered…
  params.availableTools.has("message")
    ? [
        "",
        "### message tool",
        // …message-tool specific guidance…
        ...(params.messageToolHints ?? []),   // ← every channel hint lives here
      ].filter(Boolean).join("\n")
    : "",
  "",
];
```

If the agent's compiled tool list does not include `message`, the entire `### message tool` block — and with it every line a channel plugin returned from `messageToolHints` — is replaced by the empty string. There is no fallback section, no warning to the operator, no log line. The hints are silently dropped.

The `coding` tool profile (defined in `openclaw/src/agents/tool-catalog.ts:CORE_TOOL_PROFILES`) does not include `message`. Only the `messaging` profile (5 tools: `message`, `sessions_list`, `sessions_history`, `sessions_send`, `session_status`) and `full` (everything) do. So any operator running a capability-rich bot on a non-`messaging` profile loses every channel hint by default.

## What other channel plugins do

Surveyed every chat-channel extension in `openclaw/extensions/` on 2026‑04‑26:

| Plugin | `messageToolHints` content | `inboundFormattingHints` | Identity preamble | API/skill doc |
|---|---|---|---|---|
| Mattermost | none | none | — | — |
| Feishu | 3 lines (~400 chars: targeting + cards) | — | — | — |
| MSTeams | 2 lines (~400 chars: Adaptive Cards + targeting) | — | — | — |
| Discord | 2 lines (~250 chars: components + forms) | — | — | — |
| Telegram | only `messageToolCapabilities` | — | — | — |
| Synology Chat | ~25 lines of formatting rules (misuse — should be `inboundFormattingHints`) | — | — | — |
| Line | ~40 lines of `[[…]]` rich-message directives | — | — | — |
| Slack | interactive-replies guidance (conditional, ~3 lines) | mrkdwn rules | — | — |
| Sabha (before) | 18 KB: identity preamble + cached `/skill` doc | markdown rules | yes | yes |
| **Sabha (now)** | ~1.9 KB: identity preamble + mention syntax | markdown rules | yes | — |

Three things stand out:

- **Nobody else attempts to inject platform identity context.** Every other plugin trusts the model to infer the platform from naming conventions (`sabha_list_rooms`, `[sabha:…]` envelope prefix, `channel: "sabha"` in the per-turn inbound metadata JSON). They keep `messageToolHints` to narrow tool-routing or formatting tips, ~5 lines each. Sabha is the only one that defends explicitly against model priors ("you are NOT on Discord/Slack/Teams"), because the cost of getting it wrong is concrete: agents default to Discord-style `<@id>` or Slack-style `@username` mention syntax, and Sabha's `format_mentions` regex (`/@\{(.+?)\}/`) silently drops anything that isn't the curly-brace form. No pill, no notification, no `mentionees[]` entry. So the identity preamble + mention syntax stay.
- **Slack is the only plugin that splits hooks correctly.** Output formatting goes in `inboundFormattingHints` (always rendered, except in fast-reply mode), tool-tier guidance goes in `messageToolHints` (gated). Every other plugin that uses `messageToolHints` is also implicitly broken on non-`messaging` profiles, but their hint payload is small enough that the loss isn't catastrophic.
- **The `/skill` API reference doesn't belong in `messageToolHints`.** It's 19 KB of LLM-readable docs that the Sabha server already serves at a stable URL — duplicating it into every system prompt was a bandaid for the SDK gate, not a feature. Removing it brings Sabha's hint payload size into the same order of magnitude as Synology Chat / Line.

## Why we can't fix it upstream

The clean structural fix is a 10-line patch to `buildMessagingSection`: render `messageToolHints` whenever `runtimeChannel` is set, independent of `availableTools.has("message")`. Channels like Sabha that reply via `outbound.attachedResults.sendText` are fully functional without the `message` tool, so gating their identity context on it is structurally wrong.

**Upstream PRs to OpenClaw aren't being accepted.** Maintaining a private fork of the SDK creates a permanent merge-conflict surface with every release, and any non-fork operator (anyone installing `@sabha-co/openclaw-sabha` from npm and running stock OpenClaw) would not benefit. The fix has to live in this repo.

## Plugin-side options

Three paths, ranked by structural correctness given the SDK is read-only.

### Option A — match peer-plugin scope **← chosen**

Stop trying to inject the full `/skill` doc through `messageToolHints`. Keep the platform identity preamble + mention syntax (Sabha-specific behavior the model can't infer from priors). Rely on the per-turn inbound metadata, channel envelope prefix, and `sabha_*` tool names for everything else. Document the per-room `systemPrompt` field (already present in `SabhaRoomConfigSchema`) and the operator-side `tools.alsoAllow: ["message"]` workaround as the canonical paths for richer context.

- **Pro:** matches the rest of the ecosystem; honest about what the plugin can deliver; eliminates the "silently dropped 19 KB" failure mode by not promising it; deletes a whole subsystem (`src/skill-prompt.ts` startup fetch + cache + per-turn read).
- **Con:** the identity preamble + mention syntax still get dropped on non-`messaging` profiles. Bot still guesses at the platform on a `coding`-profile gateway. Same failure surface as before, just no longer compounded by 19 KB of phantom skill docs.
- **Status:** shipped. `src/skill-prompt.ts` deleted, `index.ts` no longer fetches `/skill` at startup, `src/channel.ts:messageToolHints` returns only the identity + mention hints. Setup wizard's URL-verification probe of `/skill` is unchanged (it was only ever using the endpoint to confirm "this URL is a Sabha server" and discarding the body).

### Option B — hybrid, lift identity into `inboundFormattingHints` (deferred)

Lift a short identity stub into `inboundFormattingHints.rules` so the bot always knows what platform it's on, even on non-`messaging` profiles:

```ts
inboundFormattingHints: () => ({
  text_markup: "markdown",
  rules: [
    "You are on Sabha — a team chat platform. NOT Discord, Slack, or WhatsApp.",
    "To mention a user, emit `@{USER_ID}` (curly braces). Discord/Slack syntax does not work.",
    "Write standard Markdown. Sabha converts it to rich text automatically.",
    // … existing markdown rules …
  ],
}),
```

`inboundFormattingHints` lands in the per-turn `## Inbound Context` JSON block (`openclaw/src/auto-reply/reply/inbound-meta.ts:buildInboundMetaSystemPrompt`) as `response_format`. Per-turn cost is ~50 tokens — negligible.

- **Pro:** the bot always knows it's on Sabha, regardless of tool profile.
- **Con:** `inboundFormattingHints` is dropped in fast-reply mode (`get-reply-run.ts:352` passes `includeFormattingHints: false` when `useFastReplyRuntime` is true). So fast-reply turns on `coding`-profile gateways still lose identity context — same failure mode, narrower window. Also a mild misuse: the hook is named for output formatting, not identity.
- **Status:** deferred. Revisit if real-world reports show the identity guess (Option A's residual failure mode) is hurting users on non-`messaging` profiles. The minimal addition is ~5 lines in `src/channel.ts:agentPrompt.inboundFormattingHints`.

### Option C — per-room `systemPrompt` (always available)

`SabhaRoomConfigSchema` already accepts a `systemPrompt` field per room. Operators who care strongly about Sabha context can set it explicitly:

```json5
{
  channels: {
    sabha: {
      botAccounts: {
        default: {
          rooms: {
            "10": { systemPrompt: "You are SabhaClaw, a bot on Sabha…" }
          }
        }
      }
    }
  }
}
```

- **Pro:** no code change, no SDK constraint — the field is already wired through to the agent.
- **Con:** purely an operator-side knob. Doesn't fix anything by default. Per-room granularity is overkill for "tell the bot what platform it's on."
- **Status:** documented as the escape hatch for operators who hit Option A's residual failure and don't want to flip their tool profile.

## Decision (2026‑04‑26)

Shipped Option A: removed the `/skill` runtime injection. The platform identity preamble + mention syntax stay because they defend against concrete failure modes (mention syntax silently dropping, model guessing the platform), and they're cheap. Surface Option C in the README so operators with strong needs have a way out without changing tool profiles. Hold Option B in reserve.

The earlier draft of this doc recommended Option B (hybrid). It was reconsidered after surveying peer plugins: nobody else does anything close to what Sabha was doing, and the 19 KB skill-doc injection was the noisiest part of the failure mode. Removing it first lets us measure whether Option B's residual coverage is actually needed, instead of guessing.

## Operator workaround (immediate)

For operators hitting this on a `coding`-profile (or any non-`messaging`) gateway, the one-line fix in `~/.openclaw/openclaw.json`:

```json5
{
  tools: {
    profile: "coding",       // or whatever profile you already have
    alsoAllow: ["message"]
  }
}
```

`tools.alsoAllow` layers extra tools on top of the selected profile (`openclaw/src/config/schema.help.ts: "tools.alsoAllow"`). Once `message` is in the compiled tool list, the SDK renders the `### message tool` subsection and the entire `messageToolHints` payload (identity preamble + mention syntax) flows in. Restart the gateway to pick it up. No plugin changes required.

## References

- `src/channel.ts` — `agentPrompt.messageToolHints` (identity preamble + mention syntax) and `agentPrompt.inboundFormattingHints` (markdown rules)
- `src/setup-wizard.ts:probeBaseUrl` — the only remaining `/skill` consumer; verifies a `baseUrl` points at a Sabha server during setup, discards the response body
- `openclaw/src/agents/system-prompt.ts:buildMessagingSection` — the gate
- `openclaw/src/agents/tool-catalog.ts:CORE_TOOL_PROFILES` — profile definitions
- `openclaw/src/auto-reply/reply/inbound-meta.ts:buildInboundMetaSystemPrompt` — where `inboundFormattingHints` lands
- `openclaw/src/auto-reply/reply/get-reply-run.ts:352` — fast-reply mode skips formatting hints
- `openclaw/extensions/{discord,feishu,line,mattermost,msteams,slack,synology-chat,telegram}/src/channel.ts` — peer plugin `agentPrompt` blocks compared in the matrix above
