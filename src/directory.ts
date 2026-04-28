import type { ChannelDirectoryEntry } from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import { SabhaClient } from "./client.js";
import { resolveDefaultSabhaAccountId, resolveSabhaAccount } from "./accounts.js";

/**
 * Channel directory adapter — surfaces Sabha rooms (as groups), per-room
 * members, and reachable users (peers) to OpenClaw's directory layer.
 * Replaces `sabha_list_rooms` / `sabha_list_members` agent tools and
 * routes through the canonical SDK slot peers use (Slack/Mattermost).
 * Cross-channel agent verbs ("list conversations", "members of channel X",
 * "find user named …") work uniformly.
 *
 * `listPeers` hits `GET /api/bots/users` (server-side scoped to "users
 * sharing rooms with the bot" via `User.sharing_rooms_with`). That's
 * narrower than a workspace user list, but it's the right scope for a
 * directory: every returned user is reachable, and bots inherit the
 * server's privacy rule that they don't double as workspace people search.
 * `listPeersLive` hits the autocompletable variant (`?query=` matching,
 * limit 20) for autocomplete-style UX where freshness > completeness.
 *
 * Multi-account scoping: when `accountId` is null we resolve through the
 * channel's default account, NOT a union across all enabled accounts.
 * Sabha can be cross-tenant — different `accounts` entries can have
 * different `apiBaseUrl`s and therefore separate workspaces with
 * non-overlapping room id namespaces. Unioning rooms across them would
 * (a) collide bare numeric ids and (b) hand the agent room ids it cannot
 * subsequently message because the message-action handler runs against
 * one specific account. Scoping fixes both: ids are unique within the
 * resolved workspace and round-trip cleanly to send/edit/react.
 */

type DirectoryParams = {
  cfg: OpenClawConfig;
  accountId?: string | null;
  query?: string | null;
  limit?: number | null;
};

function buildClient(
  cfg: OpenClawConfig,
  accountId?: string | null,
): SabhaClient | null {
  const resolvedId = accountId ?? resolveDefaultSabhaAccountId(cfg);
  const account = resolveSabhaAccount({ cfg, accountId: resolvedId });
  if (!account.enabled) return null;
  if (!account.apiBaseUrl || !account.botKey) return null;
  return new SabhaClient(account.apiBaseUrl, account.botKey);
}

function lower(s: string | null | undefined): string {
  return (s ?? "").toLowerCase();
}

/**
 * Page size for room listing. Server clamps `per_page` to [1, 100]; we ask
 * for the cap so workspaces under that size resolve in a single round-trip.
 * Larger workspaces are paginated transparently below. Mirrors
 * `PEERS_PAGE_SIZE`.
 */
const ROOMS_PAGE_SIZE = 100;

/**
 * Hard ceiling on pagination loops as a server-misbehavior guard. With
 * `ROOMS_PAGE_SIZE = 100`, this caps total fetched rooms at 10,000 — well
 * above any realistic Sabha workspace, while preventing a runaway loop
 * if the server stops respecting the "short page = last page" convention.
 * Mirrors `PEERS_MAX_PAGES`.
 */
const ROOMS_MAX_PAGES = 100;

export async function listSabhaDirectoryGroups(
  params: DirectoryParams,
): Promise<ChannelDirectoryEntry[]> {
  const client = buildClient(params.cfg, params.accountId);
  if (!client) return [];

  // Server-side query keeps payloads bounded — per-page response only
  // contains rooms that already match the name. The plugin's older
  // approach (fetch-all + in-memory filter) didn't scale past a few
  // hundred rooms.
  const queryArg = params.query?.trim() || undefined;
  const cap =
    params.limit && params.limit > 0 ? params.limit : Number.POSITIVE_INFINITY;
  const entries: ChannelDirectoryEntry[] = [];

  for (let page = 1; page <= ROOMS_MAX_PAGES; page++) {
    let rooms;
    try {
      rooms = await client.listRooms({
        query: queryArg,
        page,
        perPage: ROOMS_PAGE_SIZE,
      });
    } catch {
      // Mid-stream failure (token expired, transient network, …): return
      // whatever we've accumulated rather than wiping a partially-good
      // result. Page 1 failing produces an empty array, same as before.
      break;
    }
    if (rooms.length === 0) break;

    for (const room of rooms) {
      entries.push({
        kind: "group" as const,
        id: String(room.id),
        name: room.name,
        handle: room.name,
      });
      if (entries.length >= cap) return entries;
    }

    // Server returns < perPage when on the last page. Avoids one extra
    // empty-page round-trip per call.
    if (rooms.length < ROOMS_PAGE_SIZE) break;
  }

  return entries;
}

/**
 * Page size for peer listing. The server clamps `per_page` to [1, 100];
 * we ask for the cap so a workspace under that size resolves in a single
 * round-trip. Larger workspaces are paginated transparently below.
 */
const PEERS_PAGE_SIZE = 100;

/**
 * Hard ceiling on pagination loops as a server-misbehavior guard. With
 * `PEERS_PAGE_SIZE = 100`, this caps total fetched users at 10,000 —
 * well above any realistic Sabha workspace, while preventing a runaway
 * loop if the server ever stops respecting the "short page = last page"
 * convention.
 */
const PEERS_MAX_PAGES = 100;

export async function listSabhaDirectoryPeers(
  params: DirectoryParams,
): Promise<ChannelDirectoryEntry[]> {
  const client = buildClient(params.cfg, params.accountId);
  if (!client) return [];

  const q = lower(params.query);
  const cap =
    params.limit && params.limit > 0 ? params.limit : Number.POSITIVE_INFINITY;
  const entries: ChannelDirectoryEntry[] = [];

  for (let page = 1; page <= PEERS_MAX_PAGES; page++) {
    let users;
    try {
      users = await client.listUsers({ page, perPage: PEERS_PAGE_SIZE });
    } catch {
      // Mid-stream failure (token expired, transient network, …): return
      // whatever we've accumulated rather than wiping a partially-good
      // result. Page 1 failing produces an empty array same as before.
      break;
    }
    if (users.length === 0) break;

    for (const user of users) {
      if (user.bot) continue;
      if (q && !lower(user.name).includes(q)) continue;
      entries.push({
        kind: "user" as const,
        id: String(user.id),
        name: user.name,
        handle: user.name,
      });
      if (entries.length >= cap) return entries;
    }

    // Server returns < perPage when on the last page. Avoids one extra
    // empty-page round-trip per call.
    if (users.length < PEERS_PAGE_SIZE) break;
  }

  return entries;
}

/**
 * Live peer search via the autocompletable endpoint. Faster path with the
 * server's prefix matcher; default cap is the server's limit (20).
 */
export async function listSabhaDirectoryPeersLive(
  params: DirectoryParams,
): Promise<ChannelDirectoryEntry[]> {
  const client = buildClient(params.cfg, params.accountId);
  if (!client) return [];

  let users;
  try {
    users = await client.searchUsers({
      query: params.query?.trim() || undefined,
    });
  } catch {
    return [];
  }

  const entries = users
    .filter((u) => !u.bot)
    .map((u) => ({
      kind: "user" as const,
      id: String(u.id),
      name: u.name,
      handle: u.name,
    }));

  return params.limit && params.limit > 0
    ? entries.slice(0, params.limit)
    : entries;
}

