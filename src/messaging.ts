import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";

import { resolveSabhaAccount } from "./accounts.js";
import { resolveSabhaTargets } from "./resolver.js";

/**
 * Plugin-owned helpers for the SDK's `messaging` slot.
 *
 * Wired into `channel.ts` because the SDK's message-action runner
 * (`node_modules/openclaw/dist/message-action-runner-BN7W0fv6.js`) consults
 * this slot at three points:
 *
 *   1. `looksLikeId` — short-circuits target resolution past directory lookup
 *      when the input is genuinely id-shaped. The runner's default rejects
 *      bare numerics under 6 digits (`^\+?\d{6,}$`), which doesn't fit Sabha
 *      where room id `21` is real. Without this override, `21` falls through
 *      to a name-based directory lookup that misses, then to `resolveTarget`,
 *      and ultimately surfaces as `Unknown target "21" for Sabha.`
 *
 *   2. `normalizeTarget` — canonicalizes a raw target string for dedup, cache
 *      keys, and downstream `to:` values. Strips the `sabha:` provider prefix,
 *      canonicalizes sigil/kind forms (`@alex` → `user:alex`, `#general` →
 *      `channel:general`, `@{42}` → `user:42`), and folds `group:` into
 *      `channel:` (the SDK consumer treats them as the same kind — see
 *      `formatTargetDisplay` in the runner).
 *
 *   3. `resolveTarget` — fallback called when the directory adapter returns
 *      no match. Uses the canonical normalized form (which always carries
 *      kind information) to decide whether to query users vs rooms, and
 *      passes a clean id-or-name to `resolveSabhaTargets`. Without honoring
 *      `normalized`, `sabha:general` was being queried literally as
 *      `sabha:general` against the rooms search and never resolving.
 */

const SABHA_PROVIDER_RE = /^sabha:/i;
const KIND_PREFIX_RE = /^(user|channel|group):(.*)$/i;
const USER_MENTION_RE = /^@\{(\d+)\}$/;
const NUMERIC_RE = /^\d+$/;
const KINDED_NUMERIC_RE = /^(user|channel):\d+$/i;

function stripProviderPrefix(value: string): string {
  return value.replace(SABHA_PROVIDER_RE, "").trim();
}

export function normalizeSabhaMessagingTarget(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const value = stripProviderPrefix(trimmed);
  if (!value) return undefined;

  // `@{N}` mention form (curly brace) → canonical `user:N`.
  const mention = value.match(USER_MENTION_RE);
  if (mention) return `user:${mention[1]}`;

  // Kind prefix → canonical kind:id, with `group:` folded into `channel:`
  // (the runner treats them as the same kind and only formats `channel:` /
  // `user:` when picking a display label).
  const kindMatch = value.match(KIND_PREFIX_RE);
  if (kindMatch) {
    const kind = kindMatch[1].toLowerCase() === "user" ? "user" : "channel";
    let id = kindMatch[2].trim();
    if (!id) return undefined;
    // Allow `user:@{42}` etc. by unwrapping an inner mention.
    const innerMention = id.match(USER_MENTION_RE);
    if (innerMention) id = innerMention[1];
    return `${kind}:${id}`;
  }

  // Sigil shorthands: `@alex` → `user:alex`, `#general` → `channel:general`.
  // A bare `@` or `#` (no text after) is invalid input.
  if (value.startsWith("@")) {
    const inner = value.slice(1).trim();
    return inner ? `user:${inner}` : undefined;
  }
  if (value.startsWith("#")) {
    const inner = value.slice(1).trim();
    return inner ? `channel:${inner}` : undefined;
  }

  return value;
}

export function looksLikeSabhaTargetId(
  raw: string,
  normalized?: string,
): boolean {
  const r = raw.trim();
  if (!r) return false;
  const n = (normalized ?? r).trim();

  // Genuinely numeric id forms: bare digits or `user:`/`channel:` + digits.
  // These are the only forms that should bypass directory lookup, because
  // a successful `looksLikeId` makes the runner trust the value as an id
  // and fall back to `to: <normalized>` if our `resolveTarget` returns null.
  // For bare-name inputs (`general`, `user:alice`) that fallback would emit
  // a non-numeric `to:` value that downstream Sabha action handlers can't
  // use, so names must take the directory path instead.
  if (NUMERIC_RE.test(n)) return true;
  if (KINDED_NUMERIC_RE.test(n)) return true;
  if (USER_MENTION_RE.test(r) || USER_MENTION_RE.test(n)) return true;
  // Defense for raw inputs that may not have been normalized yet.
  if (/^(user|channel|group):\d+$/i.test(r)) return true;

  return false;
}

type ResolveKind = "user" | "group";

function decideKind(
  normalized: string,
  preferredKind: "user" | "group" | "channel" | undefined,
): { kind: ResolveKind; queryInput: string } {
  // Canonical normalized form has already been stripped of `sabha:` and
  // canonicalized to one of `user:X` | `channel:X` | `<id-or-name>`. The
  // kind prefix tells us which directory namespace to hit and stripping
  // it gives the resolver the bare id-or-name it understands.
  const kinded = normalized.match(KIND_PREFIX_RE);
  if (kinded) {
    const kind = kinded[1].toLowerCase() === "user" ? "user" : "group";
    const queryInput = kinded[2].trim();
    return { kind, queryInput };
  }

  const kind: ResolveKind = preferredKind === "user" ? "user" : "group";
  return { kind, queryInput: normalized };
}

export async function resolveSabhaMessagingTarget(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  input: string;
  normalized: string;
  preferredKind?: "user" | "group" | "channel";
}): Promise<{
  to: string;
  kind: ResolveKind;
  display?: string;
  source: "normalized" | "directory";
} | null> {
  const { kind, queryInput } = decideKind(
    params.normalized,
    params.preferredKind,
  );
  if (!queryInput) return null;

  const [result] = await resolveSabhaTargets({
    cfg: params.cfg,
    accountId: params.accountId,
    inputs: [queryInput],
    kind,
  });

  if (!result?.resolved || !result.id) return null;

  // Bare-digit inputs come back from `resolveSabhaTargets` without a name
  // (it skips the server round-trip — see `resolver.ts:102,172`). Report
  // `source: "normalized"` for those so the SDK's display logic doesn't
  // misclaim a directory hit. Server-resolved name lookups carry a
  // `result.name` and report as directory.
  const isNumeric = NUMERIC_RE.test(queryInput);

  return {
    to: result.id,
    kind,
    display: result.name,
    source: isNumeric ? "normalized" : "directory",
  };
}

// Surfaced for kind detection in tests and by callers that need the shared
// canonical-prefix grammar.
export const sabhaTargetKindPrefixRe = KIND_PREFIX_RE;

/**
 * Lightweight chat-type inference used by the SDK at
 * `message-action-runner-BN7W0fv6.js:548` (`detectTargetKind`) BEFORE
 * directory lookup, so the runner can route directory queries to users
 * vs rooms without server round-tripping. The SDK accepts `"direct" |
 * "group" | "channel"` and translates `"direct"` → user kind for
 * directory routing.
 *
 * Sabha's `normalizeSabhaMessagingTarget` already canonicalizes every
 * input shape (`@{N}`, `@alex`, `#general`, `user:42`, `channel:21`,
 * etc.) into either `user:X` or `channel:X` (or a bare name/id if no
 * kind signal is present). So this inference is a one-liner against the
 * canonical prefix — same pattern as Slack's `parseSlackExplicitTarget`,
 * Discord's `parseDiscordExplicitTarget`, and Telegram's
 * `parseTelegramExplicitTarget`.
 *
 * Returns `undefined` for bare-numeric inputs (Sabha rooms and users
 * share a numeric id namespace; without a prefix we cannot tell DM from
 * group). The SDK accepts undefined and falls back to its own
 * raw-prefix heuristics, which already cover `user:` / `@` / `channel:`
 * / `#` from a different angle.
 */
export function inferSabhaTargetChatType(
  to: string,
): "direct" | "group" | undefined {
  const trimmed = to.trim();
  if (!trimmed) return undefined;
  if (/^user:/i.test(trimmed)) return "direct";
  if (/^channel:/i.test(trimmed)) return "group";
  return undefined;
}

/** Convert an account-scoped session peer back to Sabha's numeric room id. */
export function resolveSabhaDeliveryTarget(params: {
  conversationId: string;
  parentConversationId?: string;
}): { to?: string; threadId?: string } | null {
  const roomId = params.conversationId.trim().replace(/^[^:]+:(\d+)$/, "$1");
  return /^\d+$/.test(roomId) ? { to: `channel:${roomId}` } : null;
}

type ThreadingToolContextInput = {
  cfg: OpenClawConfig;
  accountId?: string | null;
  context: {
    To?: string;
    ChatType?: string;
    CurrentMessageId?: string | number;
    MessageThreadId?: string | number;
    ReplyToId?: string;
  };
  hasRepliedRef?: { value: boolean };
};

type ThreadingToolContextOutput = {
  currentChannelId?: string;
  currentMessageId?: string | number;
  currentThreadTs?: string;
  replyToMode?: "off" | "first" | "all" | "batched";
  hasRepliedRef?: { value: boolean };
};

/**
 * Plugin-owned `threading.buildToolContext`. Read by the SDK at
 * `agent-runner-utils-*.js` (the auto-generated id varies by build) and
 * fed into `message-action-runner-*.js:resolveAndApplyOutboundReplyToId`,
 * which is where the SDK auto-injects `replyTo` into the agent's
 * `message.send` params before dispatch.
 *
 * Why we need this: when the agent replies via `message.send` (rather
 * than yielding plain text that flows through the deliver pipeline in
 * `monitor.ts`), the message-action-runner is the one that decides
 * whether to thread the reply. It looks at `toolContext.replyToMode`
 * + `toolContext.currentMessageId` + `toolContext.currentChannelId`
 * + `toolContext.hasRepliedRef`. Without a plugin-owned `buildToolContext`,
 * the SDK fall-through at `agent-runner-utils-*.js:151-156` returns a
 * context **without** `replyToMode`, so the auto-inject at
 * `message-action-runner-*.js:443-467` short-circuits at
 * `if (mode === "off" || mode === "batched") return;` — and the
 * resulting `send` lands in the parent room instead of the thread.
 *
 * The fix: surface `account.replyToMode` so the auto-inject path sees
 * "first" / "all" and copies `currentMessageId` into `actionParams.replyTo`.
 * `src/message-actions.ts:send` already reads `replyTo` / `replyToId` and
 * passes it as `parentMessageId` to the wire client, which threads the
 * server-side via `Rooms::Thread.find_or_create_for`.
 *
 * We force-collapse `replyToMode` to `"off"` for two inbound shapes where
 * auto-injection would do the wrong thing:
 *
 *   - **In-thread inbounds** — `payload.room.id` already IS the thread
 *     room, so sending to it lands in the thread. Auto-injecting
 *     `parentMessageId` on top would create a nested thread (server
 *     resolves a thread room for the parent message via
 *     `Rooms::Thread.find_or_create_for`).
 *   - **DMs** — Sabha doesn't model threads in direct messages.
 *
 * The remaining cell (top-level group / channel inbound) is exactly
 * where the deliver-path `shouldThread` gate in `monitor.ts` would have
 * threaded, so the message-tool path now matches the deliver path.
 *
 * Shipped 2026-05-19 after the deferred Phase 3 entry in
 * `docs/SDK-PARITY-PLAN.md` became a live problem — see the doc for
 * the original "do only when triggered" framing and the trigger we hit.
 */
export function buildSabhaThreadingToolContext(
  params: ThreadingToolContextInput,
): ThreadingToolContextOutput {
  const { cfg, accountId, context, hasRepliedRef } = params;
  const account = resolveSabhaAccount({
    cfg,
    accountId: accountId ?? undefined,
  });

  const isInThread = context.MessageThreadId != null;
  const isDm = context.ChatType === "direct";

  // Sabha collapses "first" and "all" semantically (the server's thread
  // routing is idempotent — repeated parent_message_id posts land in the
  // same thread room), so reusing `account.replyToMode` directly is
  // enough to drive auto-inject. `hasRepliedRef` still gates "first" to
  // a single auto-inject per turn, matching the deliver path.
  const effectiveReplyToMode =
    isInThread || isDm ? "off" : account.replyToMode;

  const currentChannelId =
    typeof context.To === "string" && context.To.trim()
      ? context.To.trim()
      : undefined;

  return {
    currentChannelId,
    // SDK already falls back to its own `currentMessageId` when our
    // return value omits it (`agent-runner-utils-*.js:177`), but
    // surfacing it explicitly is the canonical shape per the parity
    // plan and matches Slack / Matrix / Telegram peers.
    currentMessageId: context.CurrentMessageId,
    // `currentThreadTs` is wired for future thread-aware verbs (e.g. a
    // hypothetical `thread-info` action) that read it from toolContext.
    // The auto-inject we care about today doesn't depend on it, but
    // peers populate it and the SDK happily threads it through.
    currentThreadTs:
      context.MessageThreadId != null
        ? String(context.MessageThreadId)
        : undefined,
    replyToMode: effectiveReplyToMode,
    hasRepliedRef,
  };
}
