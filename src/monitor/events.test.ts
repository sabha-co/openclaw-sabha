import { describe, expect, it } from "vitest";
import type { SabhaMessageEvent } from "../client/types.js";
import { addressesApp, chatTypeOf, eventFacts, isMentionGatedChannel, parseSabhaEvent, SabhaEventShapeError } from "./events.js";

const SELF = 508;

function message(overrides: Partial<SabhaMessageEvent> & { thread?: boolean; mentionees?: number[] } = {}): SabhaMessageEvent {
  const { thread, mentionees, ...rest } = overrides;
  return {
    event: "message_created",
    mentions_app: false,
    message: {
      id: 4214,
      body: { html: "<p>hi</p>", plain: "hi", markdown: "hi" },
      attachment: null,
      thread: thread ? { id: 221, parent_message_id: 4200, parent_channel_id: 3 } : null,
      mentionees: (mentionees ?? []).map((id) => ({ id, name: `u${id}` })),
      updated_at: "2026-11-07T10:00:00Z",
    },
    channel: { id: thread ? 221 : 3, name: "general", type: thread ? "Thread" : "Open" },
    user: { id: 7, name: "Ann" },
    ...rest,
  };
}

describe("addressesApp", () => {
  it("needs a mention only for top-level channel messages", () => {
    expect(addressesApp(message(), SELF)).toBe(false);
    expect(addressesApp(message({ mentions_app: true }), SELF)).toBe(true);
    expect(addressesApp(message({ mentionees: [SELF] }), SELF)).toBe(true);
    expect(addressesApp(message({ thread: true }), SELF)).toBe(true);
    expect(addressesApp(message({ channel: { id: 9, name: null, type: "Direct" } }), SELF)).toBe(true);
  });
});

describe("channel kinds", () => {
  it("treats a Direct channel with more than two members as a group that hears everything", () => {
    const groupDm = { id: 9, name: null, type: "Direct", members: 3 } as const;
    expect(chatTypeOf(groupDm)).toBe("group");
    expect(chatTypeOf({ id: 9, name: null, type: "Direct", members: 2 })).toBe("direct");
    expect(isMentionGatedChannel(groupDm)).toBe(false);
    expect(addressesApp(message({ channel: groupDm }), SELF)).toBe(true);
    expect(isMentionGatedChannel({ type: "Closed" })).toBe(true);
  });
});

describe("eventFacts", () => {
  it("keys messages by id and lanes them by channel", () => {
    expect(eventFacts(message({ mentions_app: true }), SELF)).toEqual({ eventId: "message:4214", laneKey: "channel:3" });
  });

  it("keys a slash command by its event id and lanes it by the channel it ran in", () => {
    const command = parseSabhaEvent({ event: "command", id: "c-1", command: "/new", text: "", user_id: 7, user_name: "Ann", channel_id: 221, channel_name: null, response_url: "https://r" });
    expect(eventFacts(command, SELF)).toEqual({ eventId: "command:c-1", laneKey: "channel:221" });
    expect(() => parseSabhaEvent({ event: "command", id: "c-2", command: "/new", user_id: 7, channel_id: 221 })).toThrow(SabhaEventShapeError);
  });

  it("keeps successive edits of one message distinct", () => {
    const edit = message({ event: "message_updated", mentions_app: true });
    expect(eventFacts(edit, SELF)?.eventId).toBe("edit:4214:2026-11-07T10:00:00Z");
  });

  it("drops self echoes, deletes, unaddressed messages and user lifecycle events", () => {
    expect(eventFacts(message({ mentions_app: true, user: { id: SELF, name: "bot" } }), SELF)).toBeNull();
    expect(eventFacts(message({ event: "message_deleted", mentions_app: true }), SELF)).toBeNull();
    expect(eventFacts(message(), SELF)).toBeNull();
    expect(eventFacts({ event: "user_created", user: { id: 1, name: "x" } }, SELF)).toBeNull();
  });

  it("keys reactions by reaction id and action", () => {
    const base = message();
    const reaction = { event: "reaction_deleted" as const, reaction: { id: 77, body: "🎉" }, message: base.message, channel: base.channel, user: base.user };
    expect(eventFacts(reaction, SELF)).toEqual({ eventId: "unreact:77", laneKey: "channel:3" });
  });
});

describe("parseSabhaEvent", () => {
  it("rejects message events missing what the plugin relies on", () => {
    expect(() => parseSabhaEvent({ event: "message_created", channel: { id: 1 }, user: { id: 1 } })).toThrow(SabhaEventShapeError);
    expect(() => parseSabhaEvent("nope")).toThrow(SabhaEventShapeError);
  });

  it("passes unknown event types through", () => {
    expect(parseSabhaEvent({ event: "draft_refused", draft_id: "d" })).toEqual({ event: "draft_refused", draft_id: "d" });
  });
});
