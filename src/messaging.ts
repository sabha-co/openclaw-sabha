import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";

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

/**
 * Plugin-owned mapping from session-grammar conversation ids to wire
 * delivery target. Read by the SDK at `delivery-context-BB8mcaUV.js:33,44`
 * (`formatConversationTarget` and `resolveConversationDeliveryTarget`).
 *
 * Mirrors the canonical pattern from Mattermost (`channel.ts:311-317`),
 * Slack, Telegram, Feishu, and Matrix: when a session has a parent
 * conversation distinct from the current one (i.e. it's a thread session),
 * deliver to the parent and surface the thread room as `threadId`. For
 * non-thread sessions, deliver to the conversation itself.
 *
 * Sabha's runtime delivery path goes through the draft-stream and doesn't
 * consult this hook today, but non-draft-stream apply paths (media
 * echo-transcript, captured registrations) read it. Without this hook,
 * the SDK fall-through at `delivery-context-BB8mcaUV.js:38` returns
 * `channel:${conversationId}` and loses the parent association — a
 * thread reply would then be attributed to the thread room, not the
 * parent room, which is the wrong shape for downstream consumers that
 * key on the parent room id.
 */
export function resolveSabhaDeliveryTarget(params: {
  conversationId: string;
  parentConversationId?: string;
}): { to?: string; threadId?: string } | null {
  const child = params.conversationId.trim();
  if (!child) return null;
  const parent = params.parentConversationId?.trim();
  if (parent && parent !== child) {
    return { to: `channel:${parent}`, threadId: child };
  }
  return { to: `channel:${child}` };
}
