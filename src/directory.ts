import type { ChannelDirectoryEntry } from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import { SabhaClient } from "./client.js";
import { resolveDefaultSabhaAccountId, resolveSabhaAccount } from "./accounts.js";

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
