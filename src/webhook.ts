import type { SabhaWebhookPayload, SabhaRoomType } from "./types.js";

/**
 * Parse and validate an incoming Sabha webhook payload.
 */
export function parseWebhookPayload(body: unknown): SabhaWebhookPayload {
  if (!body || typeof body !== "object") {
    throw new WebhookParseError("Invalid webhook payload: not an object");
  }

  const payload = body as Record<string, unknown>;

  if (!payload.event || typeof payload.event !== "string") {
    throw new WebhookParseError("Missing or invalid 'event' field");
  }

  if (!payload.user || typeof payload.user !== "object") {
    throw new WebhookParseError("Missing or invalid 'user' field");
  }

  if (!payload.room || typeof payload.room !== "object") {
    throw new WebhookParseError("Missing or invalid 'room' field");
  }

  if (!payload.message || typeof payload.message !== "object") {
    throw new WebhookParseError("Missing or invalid 'message' field");
  }

  return payload as unknown as SabhaWebhookPayload;
}

/**
 * Determine the OpenClaw chat type from a Sabha room type.
 */
export function resolveChatType(
  roomType: SabhaRoomType,
): "direct" | "group" {
  return roomType === "Direct" ? "direct" : "group";
}

/**
 * Check if the bot was mentioned in a webhook payload.
 */
export function wasBotMentioned(
  payload: SabhaWebhookPayload,
  botId: number,
): boolean {
  return payload.message.mentionees.some((m) => m.id === botId);
}

export class WebhookParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookParseError";
  }
}
