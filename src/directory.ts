// Directory listings and name → id resolution for one account at a time.
// A failed lookup throws (or reports "lookup failed"); it is never presented
// as an empty result, which would read as "nobody by that name".
import type { ChannelDirectoryEntry, ChannelResolveKind, ChannelResolveResult } from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import { accountClient, SabhaAccountUnavailableError } from "./client/account-client.js";
import type { SabhaClient } from "./client/client.js";
import type { SabhaRoom, SabhaUser } from "./client/types.js";

type ListParams = { cfg: OpenClawConfig; accountId?: string | null; query?: string | null; limit?: number | null };

const PAGE_SIZE = 100;
const MAX_PAGES = 50;

const capOf = (limit?: number | null) => (limit && limit > 0 ? limit : Number.POSITIVE_INFINITY);
const roomEntry = (room: SabhaRoom): ChannelDirectoryEntry => ({ kind: "group", id: String(room.id), ...(room.name ? { name: room.name, handle: room.name } : {}) });
const userEntry = (user: SabhaUser): ChannelDirectoryEntry => ({ kind: "user", id: String(user.id), name: user.name, handle: user.name });

async function collectPages<T>(fetchPage: (page: number) => Promise<T[]>, keep: (item: T) => boolean, cap: number): Promise<T[]> {
  const out: T[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const items = await fetchPage(page);
    for (const item of items) {
      if (!keep(item)) continue;
      out.push(item);
      if (out.length >= cap) return out;
    }
    if (items.length < PAGE_SIZE) break;
  }
  return out;
}

/** Rooms the app belongs to. */
export async function listSabhaGroups(params: ListParams): Promise<ChannelDirectoryEntry[]> {
  const { client } = accountClient(params.cfg, params.accountId);
  const query = params.query?.trim() || undefined;
  const rooms = await collectPages((page) => client.listRooms({ ...(query ? { query } : {}), page, perPage: PAGE_SIZE }), () => true, capOf(params.limit));
  return rooms.map(roomEntry);
}

/** People who share a room with the app (other apps excluded). */
export async function listSabhaPeers(params: ListParams): Promise<ChannelDirectoryEntry[]> {
  const { client } = accountClient(params.cfg, params.accountId);
  const query = params.query?.trim().toLowerCase();
  const users = await collectPages(
    (page) => client.listUsers({ page, perPage: PAGE_SIZE }),
    (user) => !user.bot && (!query || user.name.toLowerCase().includes(query)),
    capOf(params.limit),
  );
  return users.map(userEntry);
}

/** Server-side autocomplete; the fast path for typed queries. */
export async function listSabhaPeersLive(params: ListParams): Promise<ChannelDirectoryEntry[]> {
  const { client } = accountClient(params.cfg, params.accountId);
  const query = params.query?.trim() || undefined;
  const users = (await client.searchUsers(query ? { query } : {})).filter((user) => !user.bot);
  return users.slice(0, capOf(params.limit)).map(userEntry);
}

export async function listSabhaGroupMembers(params: { cfg: OpenClawConfig; accountId?: string | null; groupId: string; limit?: number | null }) {
  const { client } = accountClient(params.cfg, params.accountId);
  const roomId = Number(params.groupId.replace(/^(?:sabha:)?(?:channel:|room:|group:)?/i, ""));
  if (!Number.isInteger(roomId)) throw new Error(`Not a Sabha room id: ${params.groupId}`);
  const users = await collectPages((page) => client.listUsers({ roomId, page, perPage: PAGE_SIZE }), () => true, capOf(params.limit));
  return users.map(userEntry);
}

// --- Resolver ---

type Parsed = { kind: "id"; id: number } | { kind: "query"; query: string } | { kind: "empty" };

function parseInput(input: string, kind: ChannelResolveKind): Parsed {
  const value = input.trim().replace(/^sabha:/i, "").replace(kind === "user" ? /^user:/i : /^(?:channel|room|group):/i, "");
  if (!value) return { kind: "empty" };
  const mention = kind === "user" ? /^@\{(\d+)\}$/.exec(value) : null;
  if (mention) return { kind: "id", id: Number(mention[1]) };
  if (/^\d+$/.test(value)) return { kind: "id", id: Number(value) };
  const query = value.replace(kind === "user" ? /^@/ : /^#/, "").trim();
  return query ? { kind: "query", query } : { kind: "empty" };
}

type Named = { id: number; name: string | null };

/** Exact (case-insensitive) name first, then the server's own ranking. */
function pick<T extends Named>(input: string, query: string, matches: readonly T[]): ChannelResolveResult {
  if (matches.length === 0) return { input, resolved: false, note: "no match" };
  const exact = matches.filter((match) => match.name?.toLowerCase() === query.toLowerCase());
  const best = exact[0] ?? matches[0]!;
  const ambiguous = exact.length > 1 || (exact.length === 0 && matches.length > 1);
  return {
    input,
    resolved: true,
    id: String(best.id),
    ...(best.name ? { name: best.name } : {}),
    ...(ambiguous ? { note: `${matches.length} matches; chose ${best.name ?? best.id}` } : {}),
  };
}

async function lookup(client: SabhaClient, kind: ChannelResolveKind, query: string): Promise<Named[]> {
  if (kind === "group") return client.listRooms({ query, perPage: 20 });
  return (await client.searchUsers({ query })).filter((user) => !user.bot);
}

export async function resolveSabhaTargets(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  inputs: string[];
  kind: ChannelResolveKind;
}): Promise<ChannelResolveResult[]> {
  let client: SabhaClient;
  try {
    client = accountClient(params.cfg, params.accountId).client;
  } catch (error) {
    if (!(error instanceof SabhaAccountUnavailableError)) throw error;
    return params.inputs.map((input) => ({ input, resolved: false, note: error.message }));
  }
  const cache = new Map<string, Promise<Named[]>>();
  const results: ChannelResolveResult[] = [];
  for (const input of params.inputs) {
    const parsed = parseInput(input, params.kind);
    if (parsed.kind === "empty") {
      results.push({ input, resolved: false, note: "empty input" });
      continue;
    }
    if (parsed.kind === "id") {
      results.push({ input, resolved: true, id: String(parsed.id) });
      continue;
    }
    const key = parsed.query.toLowerCase();
    if (!cache.has(key)) cache.set(key, lookup(client, params.kind, parsed.query));
    try {
      results.push(pick(input, parsed.query, await cache.get(key)!));
    } catch (error) {
      results.push({ input, resolved: false, note: `lookup failed: ${String(error)}` });
    }
  }
  return results;
}
