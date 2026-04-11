import type { SabhaMessageEventPayload } from "./types.js";

/**
 * Build an OpenClaw session conversation key from a Sabha webhook payload.
 *
 * Accepts only message-bearing variants (`message_*` and `boost_*`).
 * `user_*` events are global and have no room/message context, so they
 * cannot produce a session key — callers must not invoke this with
 * those variants (TypeScript enforces this via the discriminated
 * union).
 *
 * Session key format:
 *   Room (Open/Closed): sabha:group:{room_id}
 *   Direct message:     sabha:direct:{room_id}
 *   Thread:             sabha:group:{parent_room_id}:thread:{thread_room_id}
 */
export function resolveSessionFromPayload(payload: SabhaMessageEventPayload): {
  chatType: "direct" | "group";
  conversationId: string;
  threadId?: string;
  baseConversationId?: string;
  parentConversationCandidates?: string[];
} {
  const roomId = String(payload.room.id);
  const chatType = payload.room.type === "Direct" ? "direct" : "group";
  const thread = payload.message.thread;

  if (thread) {
    return {
      chatType,
      conversationId: roomId,
      threadId: String(thread.id),
      baseConversationId: roomId,
      parentConversationCandidates: [roomId],
    };
  }

  return {
    chatType,
    conversationId: roomId,
  };
}

/**
 * Resolve a session conversation from raw IDs.
 * Used by the messaging adapter's resolveSessionConversation hook.
 */
export function resolveSessionConversation(params: {
  rawId: string;
  threadId?: string;
}): {
  id: string;
  threadId?: string;
  baseConversationId?: string;
  parentConversationCandidates?: string[];
} {
  if (params.threadId) {
    return {
      id: params.rawId,
      threadId: params.threadId,
      baseConversationId: params.rawId,
      parentConversationCandidates: [params.rawId],
    };
  }

  return { id: params.rawId };
}
