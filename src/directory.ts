import type { ChannelDirectoryEntry } from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import { SabhaClient } from "./client.js";
import { listEnabledSabhaAccounts } from "./accounts.js";

/**
 * Channel directory adapter — surfaces Sabha rooms (as groups) and per-room
 * members to OpenClaw's directory layer. Replaces `sabha_list_rooms` and
 * `sabha_list_members` agent tools so the same data flows through the
 * canonical SDK slot peers use (Slack/Mattermost). Cross-channel agent
 * verbs ("list conversations", "members of channel X") work uniformly.
 *
 * Sabha's bot API has no global users endpoint, so `listPeers` is omitted
 * — peers can only be discovered as members of a room the bot is in.
 *
 * Multi-account: scans every enabled account and dedupes by room id so
 * private rooms only one bot is in still surface, mirroring Mattermost.
 */

type DirectoryParams = {
  cfg: OpenClawConfig;
  accountId?: string | null;
  query?: string | null;
  limit?: number | null;
};

function buildClients(cfg: OpenClawConfig, accountId?: string | null): SabhaClient[] {
  const accounts = listEnabledSabhaAccounts(cfg);
  const filtered = accountId
    ? accounts.filter((a) => a.accountId === accountId)
    : accounts;
  const seen = new Set<string>();
  const clients: SabhaClient[] = [];
  for (const account of filtered) {
    if (!account.apiBaseUrl || !account.botKey) continue;
    if (seen.has(account.botKey)) continue;
    seen.add(account.botKey);
    clients.push(new SabhaClient(account.apiBaseUrl, account.botKey));
  }
  return clients;
}

function lower(s: string | null | undefined): string {
  return (s ?? "").toLowerCase();
}

export async function listSabhaDirectoryGroups(
  params: DirectoryParams,
): Promise<ChannelDirectoryEntry[]> {
  const clients = buildClients(params.cfg, params.accountId);
  if (!clients.length) return [];

  const q = lower(params.query);
  const seenIds = new Set<number>();
  const entries: ChannelDirectoryEntry[] = [];

  for (const client of clients) {
    let rooms;
    try {
      rooms = await client.listRooms();
    } catch {
      // Token may be revoked — try the next account.
      continue;
    }
    for (const room of rooms) {
      if (seenIds.has(room.id)) continue;
      if (q && !lower(room.name).includes(q)) continue;
      seenIds.add(room.id);
      entries.push({
        kind: "group" as const,
        id: String(room.id),
        name: room.name,
        handle: room.name,
      });
    }
  }

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

  const clients = buildClients(params.cfg, params.accountId);
  for (const client of clients) {
    try {
      const members = await client.listMembers(roomId);
      const entries = members.map((m) => ({
        kind: "user" as const,
        id: String(m.id),
        name: m.name,
        handle: m.name,
      }));
      return params.limit && params.limit > 0
        ? entries.slice(0, params.limit)
        : entries;
    } catch {
      // Bot isn't a member of this room — try the next bot account.
      continue;
    }
  }
  return [];
}
