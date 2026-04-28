import type {
  ChannelResolveKind,
  ChannelResolveResult,
} from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import { resolveTargetsWithOptionalToken } from "openclaw/plugin-sdk/target-resolver-runtime";

import { resolveSabhaAccount } from "./accounts.js";
import { SabhaClient } from "./client.js";
import type { SabhaRoom, SabhaUser } from "./types.js";

/**
 * Channel resolver — turns free-form name/handle inputs from the agent
 * into `{ id, name }` pairs the rest of the plugin can act on.
 *
 * Wired into `resolver.resolveTargets` in `channel.ts`. Discord, Slack, and
 * Telegram all expose this same SDK slot for the same purpose. Sabha needs
 * it because the inbound payload only pre-resolves explicit `@{user_id}`
 * curly-brace mentions — anything else (a free-form "tag @alex") arrives
 * as plain text and the agent has nowhere else to translate name → id.
 *
 * Note: `resolveTargets` has no `roomId` field on the SDK params, so this
 * resolver is workspace-scoped. The room-scoped variant lives as the
 * `sabha_search_members` agent tool in `src/tools.ts`. See
 * `docs/READ-ENDPOINT-SCALE-PLAN.md` for the rationale.
 */

type ParsedInput =
  | { kind: "id"; id: number }
  | { kind: "query"; query: string }
  | { kind: "empty" };

/**
 * Parse a free-form input string into either a numeric id or a search query.
 *
 * - Empty / whitespace → `{ kind: "empty" }`.
 * - Bare digits ("123") → `{ kind: "id", id }`.
 * - Sabha mention form `@{N}` (users only) → `{ kind: "id", id }`. Disabled
 *   for groups since `#{N}` is not a Sabha shape.
 * - Anything else → `{ kind: "query", query }` with one leading `sigil`
 *   character stripped (`@` for users, `#` for groups).
 */
function parseInput(
  input: string,
  opts: { sigil: "@" | "#"; allowMentionForm: boolean },
): ParsedInput {
  const trimmed = input.trim();
  if (!trimmed) return { kind: "empty" };

  if (opts.allowMentionForm) {
    const mention = trimmed.match(/^@\{(\d+)\}$/);
    if (mention) return { kind: "id", id: Number(mention[1]) };
  }

  if (/^\d+$/.test(trimmed)) return { kind: "id", id: Number(trimmed) };

  const stripped = trimmed.startsWith(opts.sigil)
    ? trimmed.slice(1).trim()
    : trimmed;
  return stripped ? { kind: "query", query: stripped } : { kind: "empty" };
}

const parseUserInput = (input: string): ParsedInput =>
  parseInput(input, { sigil: "@", allowMentionForm: true });

const parseGroupInput = (input: string): ParsedInput =>
  parseInput(input, { sigil: "#", allowMentionForm: false });

type InternalResolution = {
  input: string;
  resolved: boolean;
  id?: string;
  name?: string;
  note?: string;
};

type UserLookup =
  | { ok: true; users: SabhaUser[] }
  | { ok: false };

async function resolveUserInputs(
  client: SabhaClient,
  inputs: string[],
): Promise<InternalResolution[]> {
  const results: InternalResolution[] = [];
  // Cache per-call so repeated names within one resolveTargets batch don't
  // each trigger their own server round-trip.
  const queryCache = new Map<string, UserLookup>();

  for (const input of inputs) {
    const parsed = parseUserInput(input);

    if (parsed.kind === "empty") {
      results.push({ input, resolved: false, note: "empty input" });
      continue;
    }

    if (parsed.kind === "id") {
      // Don't round-trip to verify — server returns 404 only on actual
      // sends, and that's the right place for the visibility error to
      // surface (matches `member-info` semantics in message-actions.ts).
      results.push({ input, resolved: true, id: String(parsed.id) });
      continue;
    }

    const cacheKey = parsed.query.toLowerCase();
    let cached = queryCache.get(cacheKey);
    if (!cached) {
      try {
        const users = await client.searchUsers({ query: parsed.query });
        cached = { ok: true as const, users };
      } catch {
        // Distinguish "lookup failed" from "no match found": agents act
        // very differently on the two. A transient 5xx returning a bare
        // `resolved: false` would let the agent fabricate a name → user
        // pairing on the next turn.
        cached = { ok: false as const };
      }
      queryCache.set(cacheKey, cached);
    }

    if (!cached.ok) {
      results.push({ input, resolved: false, note: "lookup failed" });
      continue;
    }

    if (cached.users.length === 0) {
      results.push({ input, resolved: false });
      continue;
    }

    // Server returns up to 20 results. We take the first as the best match
    // (server orders by `User.matching` rank). An exact-name preference
    // could be layered later if the rank ever feels off.
    const top = cached.users[0];
    results.push({
      input,
      resolved: true,
      id: String(top.id),
      name: top.name,
      note:
        cached.users.length > 1 ? "multiple matches; chose best" : undefined,
    });
  }

  return results;
}

type GroupLookup =
  | { ok: true; rooms: SabhaRoom[] }
  | { ok: false };

async function resolveGroupInputs(
  client: SabhaClient,
  inputs: string[],
): Promise<InternalResolution[]> {
  const results: InternalResolution[] = [];
  // Cache per-call so duplicate name inputs (e.g. ["general", "general"])
  // share one server round-trip. Same lookup-failed/no-match split as
  // resolveUserInputs.
  const queryCache = new Map<string, GroupLookup>();

  for (const input of inputs) {
    const parsed = parseGroupInput(input);

    if (parsed.kind === "empty") {
      results.push({ input, resolved: false, note: "empty input" });
      continue;
    }

    if (parsed.kind === "id") {
      results.push({ input, resolved: true, id: String(parsed.id) });
      continue;
    }

    const cacheKey = parsed.query.toLowerCase();
    let cached = queryCache.get(cacheKey);
    if (!cached) {
      try {
        // Server-side query — small payload, scoped to the room name.
        // Mirrors the user path's `searchUsers` shape.
        const rooms = await client.listRooms({ query: parsed.query });
        cached = { ok: true as const, rooms };
      } catch {
        cached = { ok: false as const };
      }
      queryCache.set(cacheKey, cached);
    }

    if (!cached.ok) {
      results.push({ input, resolved: false, note: "lookup failed" });
      continue;
    }

    if (cached.rooms.length === 0) {
      results.push({ input, resolved: false });
      continue;
    }

    const top = cached.rooms[0];
    results.push({
      input,
      resolved: true,
      id: String(top.id),
      name: top.name,
      note:
        cached.rooms.length > 1 ? "multiple matches; chose best" : undefined,
    });
  }

  return results;
}

export async function resolveSabhaTargets(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  inputs: string[];
  kind: ChannelResolveKind;
}): Promise<ChannelResolveResult[]> {
  const account = resolveSabhaAccount({
    cfg: params.cfg,
    accountId: params.accountId ?? undefined,
  });

  const tokenAvailable =
    account.enabled && Boolean(account.botKey) && Boolean(account.apiBaseUrl);

  return resolveTargetsWithOptionalToken({
    token: tokenAvailable ? account.botKey : null,
    inputs: params.inputs,
    missingTokenNote: account.enabled
      ? "missing Sabha bot key or apiBaseUrl"
      : "Sabha account disabled",
    resolveWithToken: async ({ token, inputs }) => {
      const client = new SabhaClient(account.apiBaseUrl, token);
      return params.kind === "group"
        ? await resolveGroupInputs(client, inputs)
        : await resolveUserInputs(client, inputs);
    },
    mapResolved: (entry) => ({
      input: entry.input,
      resolved: entry.resolved,
      id: entry.id,
      name: entry.name,
      note: entry.note,
    }),
  });
}
