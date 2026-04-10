import type {
  SabhaMessageEventPayload,
  SabhaWebhookEvent,
  SabhaWebhookPayload,
  SabhaRoomType,
} from "./types.js";

// Events that carry a `room` and `message`. `user_*` events intentionally
// do NOT — they fan out globally and only carry `user`.
const MESSAGE_BEARING_EVENTS: ReadonlySet<SabhaWebhookEvent> = new Set([
  "message_created",
  "message_updated",
  "message_deleted",
  "boost_created",
  "boost_deleted",
]);

const BOOST_EVENTS: ReadonlySet<SabhaWebhookEvent> = new Set([
  "boost_created",
  "boost_deleted",
]);

const USER_EVENTS: ReadonlySet<SabhaWebhookEvent> = new Set([
  "user_created",
  "user_deleted",
]);

function isKnownEvent(event: string): event is SabhaWebhookEvent {
  return (
    MESSAGE_BEARING_EVENTS.has(event as SabhaWebhookEvent) ||
    USER_EVENTS.has(event as SabhaWebhookEvent)
  );
}

/**
 * Parse and validate an incoming Sabha webhook payload.
 *
 * Enforces the discriminated-union shape: message/boost events must
 * carry `room` and `message` (boost events additionally require
 * `boost`), while `user_*` events must NOT be rejected for missing
 * `room` / `message` because Sabha's fan-out path doesn't include them.
 */
export function parseWebhookPayload(body: unknown): SabhaWebhookPayload {
  if (!body || typeof body !== "object") {
    throw new WebhookParseError("Invalid webhook payload: not an object");
  }
  const payload = body as Record<string, unknown>;

  if (!payload.event || typeof payload.event !== "string") {
    throw new WebhookParseError("Missing or invalid 'event' field");
  }
  if (!isKnownEvent(payload.event)) {
    throw new WebhookParseError(`Unknown event type: ${payload.event}`);
  }

  if (!payload.user || typeof payload.user !== "object") {
    throw new WebhookParseError("Missing or invalid 'user' field");
  }

  if (MESSAGE_BEARING_EVENTS.has(payload.event)) {
    if (!payload.room || typeof payload.room !== "object") {
      throw new WebhookParseError(
        `${payload.event}: missing or invalid 'room' field`,
      );
    }
    if (!payload.message || typeof payload.message !== "object") {
      throw new WebhookParseError(
        `${payload.event}: missing or invalid 'message' field`,
      );
    }
    if (BOOST_EVENTS.has(payload.event)) {
      if (!payload.boost || typeof payload.boost !== "object") {
        throw new WebhookParseError(
          `${payload.event}: missing or invalid 'boost' field`,
        );
      }
    }
  }

  // user_* variants deliberately skip room/message validation.
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
 * Check if the bot was mentioned in a message-bearing webhook payload.
 * Typed to the narrower `SabhaMessageEventPayload` so TypeScript
 * prevents accidental calls with `user_*` variants (which have no
 * `message` to inspect).
 */
export function wasBotMentioned(
  payload: SabhaMessageEventPayload,
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
