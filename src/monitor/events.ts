// Classifies AppEventsChannel payloads. Pure: no I/O, no host runtime.
import type { SabhaAppEvent, SabhaEventRoom, SabhaMessageEvent, SabhaReactionEvent } from "../client/types.js";

export type SabhaChatType = "direct" | "group";

const MESSAGE_EVENTS = new Set(["message_created", "message_updated", "message_deleted"]);
const REACTION_EVENTS = new Set(["reaction_created", "reaction_deleted"]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasId = (value: unknown): boolean => isRecord(value) && typeof value.id === "number";

export class SabhaEventShapeError extends Error {
  constructor(detail: string) {
    super(`Sabha event is malformed: ${detail}`);
    this.name = "SabhaEventShapeError";
  }
}

/** Validates the fields the plugin relies on; unknown event types pass through untouched. */
export function parseSabhaEvent(raw: unknown): SabhaAppEvent {
  if (!isRecord(raw) || typeof raw.event !== "string") throw new SabhaEventShapeError("missing event type");
  if (MESSAGE_EVENTS.has(raw.event) || REACTION_EVENTS.has(raw.event)) {
    if (!hasId(raw.message)) throw new SabhaEventShapeError(`${raw.event} without message.id`);
    if (!hasId(raw.room)) throw new SabhaEventShapeError(`${raw.event} without room.id`);
    if (!hasId(raw.user)) throw new SabhaEventShapeError(`${raw.event} without user.id`);
    const body = (raw.message as Record<string, unknown>).body;
    if (MESSAGE_EVENTS.has(raw.event) && !isRecord(body)) throw new SabhaEventShapeError(`${raw.event} without message.body`);
  }
  if (REACTION_EVENTS.has(raw.event) && !hasId(raw.reaction)) {
    throw new SabhaEventShapeError(`${raw.event} without reaction.id`);
  }
  return raw as SabhaAppEvent;
}

export const isMessageEvent = (event: SabhaAppEvent): event is SabhaMessageEvent => MESSAGE_EVENTS.has(event.event);
export const isReactionEvent = (event: SabhaAppEvent): event is SabhaReactionEvent => REACTION_EVENTS.has(event.event);

export const chatTypeOf = (room: SabhaEventRoom): SabhaChatType => (room.type === "Direct" ? "direct" : "group");

/** Sabha computes `mentions_app` server-side; mentionees cover events that predate it. */
export function mentionsApp(event: SabhaMessageEvent, selfId: number): boolean {
  return event.mentions_app === true || (event.message.mentionees ?? []).some((user) => user.id === selfId);
}

/**
 * Conversations the app is part of: DMs and threads without a mention (a thread
 * the app replied in is an ongoing conversation), top-level rooms only when
 * the message mentions the app.
 */
export function addressesApp(event: SabhaMessageEvent, selfId: number): boolean {
  if (chatTypeOf(event.room) === "direct" || event.message.thread != null) return true;
  return mentionsApp(event, selfId);
}

/**
 * The durable-ingress identity of an event, or null when the event never needs
 * work: the app's own echoes, deletes, user lifecycle events (global fan-out;
 * see the privacy note in ../inbound/turn.ts), and types the plugin doesn't handle.
 */
export function eventFacts(event: SabhaAppEvent, selfId: number): { eventId: string; laneKey: string } | null {
  if (isMessageEvent(event)) {
    if (event.user.id === selfId) return null;
    if (!addressesApp(event, selfId)) return null;
    const laneKey = `room:${event.room.id}`;
    switch (event.event) {
      case "message_created":
        return { eventId: `message:${event.message.id}`, laneKey };
      case "message_updated":
        // Every edit is a distinct event; updated_at separates them.
        return { eventId: `edit:${event.message.id}:${event.message.updated_at ?? ""}`, laneKey };
      case "message_deleted":
        // The author meant it gone; the agent never sees the body again.
        return null;
    }
  }
  if (isReactionEvent(event)) {
    if (event.user.id === selfId) return null;
    const kind = event.event === "reaction_created" ? "react" : "unreact";
    return { eventId: `${kind}:${event.reaction.id}`, laneKey: `room:${event.room.id}` };
  }
  return null;
}
