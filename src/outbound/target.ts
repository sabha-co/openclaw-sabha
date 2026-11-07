import type { SabhaClient } from "../client/client.js";
import type { SabhaTarget } from "./send.js";

export type ParsedSabhaTarget = { kind: "room" | "user"; id: number };

/**
 * `21`, `channel:21`, `room:21`, `group:21` → room 21; `user:5`, `@{5}` → user 5.
 * An optional `sabha:` prefix is accepted on any form.
 */
export function parseSabhaTarget(raw: string): ParsedSabhaTarget | null {
  const value = raw.trim().replace(/^sabha:/i, "");
  const mention = /^@\{(\d+)\}$/.exec(value);
  if (mention) return { kind: "user", id: Number(mention[1]) };
  const match = /^(?:(channel|room|group|user):)?(\d+)$/i.exec(value);
  if (!match) return null;
  return { kind: match[1]?.toLowerCase() === "user" ? "user" : "room", id: Number(match[2]) };
}

/**
 * Where a host-initiated send lands. A thread id is the thread's own room, so
 * it wins over the parent room; otherwise `replyToId` starts or continues the
 * thread under that top-level message. Users are reached through their DM.
 */
export async function resolveSendTarget(params: {
  client: SabhaClient;
  to: string;
  threadId?: string | number | null;
  replyToId?: string | null;
}): Promise<SabhaTarget> {
  const parsed = parseSabhaTarget(params.to);
  if (!parsed) throw new Error(`Not a Sabha target: ${JSON.stringify(params.to)} (expected a room id, user:<id> or @{id})`);
  const threadRoom = params.threadId != null && /^\d+$/.test(String(params.threadId)) ? Number(params.threadId) : undefined;
  if (threadRoom !== undefined) return { roomId: threadRoom };
  const roomId = parsed.kind === "user" ? (await params.client.createDm([parsed.id])).roomId : parsed.id;
  const parent = params.replyToId != null && /^\d+$/.test(params.replyToId) ? Number(params.replyToId) : undefined;
  return { roomId, ...(parent !== undefined && parsed.kind === "room" ? { parentMessageId: parent } : {}) };
}
