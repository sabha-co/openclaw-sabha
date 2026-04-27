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

export async function listSabhaDirectoryGroups(
  params: DirectoryParams,
): Promise<ChannelDirectoryEntry[]> {
  const client = buildClient(params.cfg, params.accountId);
  if (!client) return [];

  let rooms;
  try {
    rooms = await client.listRooms();
  } catch {
    return [];
  }

  const q = lower(params.query);
  const entries: ChannelDirectoryEntry[] = [];
  for (const room of rooms) {
    if (q && !lower(room.name).includes(q)) continue;
    entries.push({
      kind: "group" as const,
      id: String(room.id),
      name: room.name,
      handle: room.name,
    });
  }

  return params.limit && params.limit > 0
    ? entries.slice(0, params.limit)
    : entries;
}

/**
 * Page size for peer listing. The server caps at 100; we ask for the cap
 * so a single round-trip covers most workspaces. Larger workspaces will
 * show only the first 100 peers — pagination would need a SDK contract
 * extension and isn't wired here.
 */
const PEERS_PAGE_SIZE = 100;

export async function listSabhaDirectoryPeers(
  params: DirectoryParams,
): Promise<ChannelDirectoryEntry[]> {
  const client = buildClient(params.cfg, params.accountId);
  if (!client) return [];

  let users;
  try {
    users = await client.listUsers({ perPage: PEERS_PAGE_SIZE });
  } catch {
    return [];
  }

  const q = lower(params.query);
  const entries: ChannelDirectoryEntry[] = [];
  for (const user of users) {
    if (user.bot) continue;
    if (q && !lower(user.name).includes(q)) continue;
    entries.push({
      kind: "user" as const,
      id: String(user.id),
      name: user.name,
      handle: user.name,
    });
  }

  return params.limit && params.limit > 0
    ? entries.slice(0, params.limit)
    : entries;
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

type GroupMembersParams = {
  cfg: OpenClawConfig;
  accountId?: string | null;
  groupId: string;
  limit?: number | null;
};

export async function listSabhaDirectoryGroupMembers(
  params: GroupMembersParams,
): Promise<ChannelDirectoryEntry[]> {
  const roomId = Number(params.groupId);
  if (!Number.isFinite(roomId)) return [];

  const client = buildClient(params.cfg, params.accountId);
  if (!client) return [];

  let members;
  try {
    members = await client.listMembers(roomId);
  } catch {
    return [];
  }

  const entries = members.map((m) => ({
    kind: "user" as const,
    id: String(m.id),
    name: m.name,
    handle: m.name,
  }));
  return params.limit && params.limit > 0
    ? entries.slice(0, params.limit)
    : entries;
}
