import { describe, expect, it, vi } from "vitest";
import { SabhaApiError, SabhaClient, SabhaResponseError, parseRetryAfter } from "./client.js";

type Call = { url: string; method: string; headers: Headers; body: unknown };

function fakeFetch(responses: Array<Response | (() => Response)>) {
  const calls: Call[] = [];
  const impl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method ?? "GET", headers: new Headers(init?.headers), body: init?.body });
    const next = responses.shift();
    if (!next) throw new Error("no more responses");
    return typeof next === "function" ? next() : next;
  });
  return { calls, impl: impl as unknown as typeof fetch };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

function client(responses: Array<Response | (() => Response)>, extra: Partial<ConstructorParameters<typeof SabhaClient>[0]> = {}) {
  const fetch = fakeFetch(responses);
  return {
    calls: fetch.calls,
    client: new SabhaClient({
      apiBaseUrl: "https://sabha.test/1000006/api/v1",
      appKey: "sabha_app_k",
      fetchImpl: fetch.impl,
      retry: { minDelayMs: 1, maxDelayMs: 2 },
      ...extra,
    }),
  };
}

describe("SabhaClient", () => {
  it("posts rendered HTML as JSON with bearer auth, thread and draft ids", async () => {
    const { client: c, calls } = client([json(201, { id: 9, room_id: 221 })], {
      rewriteMentions: (text) => text.replace("@Ann", "@{5}"),
    });
    await expect(c.sendMessage(3, "hi **@Ann**", { parentMessageId: 4214, clientMessageId: "d-1" })).resolves.toEqual({ id: 9, roomId: 221 });
    const [call] = calls;
    expect(call!.url).toBe("https://sabha.test/1000006/api/v1/rooms/3/messages?parent_message_id=4214");
    expect(call!.headers.get("authorization")).toBe("Bearer sabha_app_k");
    expect(call!.headers.get("content-type")).toBe("application/json");
    expect(JSON.parse(call!.body as string)).toEqual({ body: "<p>hi <strong>@{5}</strong></p>", client_message_id: "d-1" });
  });

  it("refuses a 2xx send without an id instead of claiming success", async () => {
    const { client: c } = client([json(201, {})]);
    await expect(c.sendMessage(3, "x")).rejects.toBeInstanceOf(SabhaResponseError);
  });

  it("gives a post its own client_message_id and retries it with that id after a gateway error or a timeout", async () => {
    const timeout = () => {
      throw new DOMException("The operation timed out.", "TimeoutError");
    };
    const { client: c, calls } = client([json(503, {}), timeout, json(200, { id: 1, room_id: 3 })]);
    await expect(c.sendMessage(3, "x")).resolves.toEqual({ id: 1, roomId: 3 });
    const ids = calls.map((call) => JSON.parse(call.body as string).client_message_id);
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(1);
    expect(ids[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it("posts without client_message_id on a server that refuses it", async () => {
    const { client: c, calls } = client([
      json(422, { error: "client_message_id is not permitted", code: "validation_failed" }),
      json(201, { id: 1, room_id: 3 }),
    ]);
    await expect(c.sendMessage(3, "x", { clientMessageId: "d-1" })).resolves.toEqual({ id: 1, roomId: 3 });
    expect(calls.map((call) => JSON.parse(call.body as string))).toEqual([
      { body: "<p>x</p>", client_message_id: "d-1" },
      { body: "<p>x</p>" },
    ]);
  });

  it("retries a create Sabha refused with 429, honouring Retry-After", async () => {
    const { client: c, calls } = client([json(429, { code: "rate_limited" }, { "retry-after": "0" }), json(201, { id: 1, room_id: 3 })]);
    await expect(c.sendMessage(3, "x")).resolves.toEqual({ id: 1, roomId: 3 });
    expect(calls).toHaveLength(2);
  });

  it("retries idempotent reads on transient errors", async () => {
    const { client: c, calls } = client([json(502, {}), json(200, { results: [], has_more: false, next_cursor: null })]);
    await expect(c.readMessages(3, { before: "2026-01-01T00:00:00Z|5", limit: 20 })).resolves.toEqual({ results: [], hasMore: false, nextCursor: null });
    expect(calls).toHaveLength(2);
    expect(calls[1]!.url).toContain("before=2026-01-01T00%3A00%3A00Z%7C5&limit=20");
  });

  it("sends search filters as Rails arrays", async () => {
    const { client: c, calls } = client([json(200, { results: [], has_more: false })]);
    await c.search({ query: "deploy", roomIds: [1, 2], authorIds: [7] });
    const url = new URL(calls[0]!.url);
    expect(url.searchParams.getAll("room_ids[]")).toEqual(["1", "2"]);
    expect(url.searchParams.getAll("author_ids[]")).toEqual(["7"]);
    expect(url.searchParams.get("q")).toBe("deploy");
  });

  it("uses the reactions routes with a raw emoji body", async () => {
    const { client: c, calls } = client([json(201, { id: 77, content: "🎉" }), new Response(null, { status: 204 })]);
    await expect(c.addReaction(4, "🎉")).resolves.toBe(77);
    await c.removeReaction(4, 77);
    expect(calls.map((call) => `${call.method} ${new URL(call.url).pathname}`)).toEqual([
      "POST /1000006/api/v1/messages/4/reactions",
      "DELETE /1000006/api/v1/messages/4/reactions/77",
    ]);
    expect(calls[0]!.body).toBe("🎉");
  });

  it("exposes Sabha's error code", async () => {
    const { client: c } = client([json(422, { error: "nope", code: "validation_failed" })]);
    const error = await c.editMessage(1, "x").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SabhaApiError);
    expect((error as SabhaApiError).code).toBe("validation_failed");
  });

  it("reads the DM room id", async () => {
    const { client: c, calls } = client([json(200, { room: { id: 7 } })]);
    await expect(c.createDm([42])).resolves.toEqual({ roomId: 7 });
    expect(JSON.parse(calls[0]!.body as string)).toEqual({ user_ids: [42] });
  });
});

describe("parseRetryAfter", () => {
  it("reads seconds and dates", () => {
    expect(parseRetryAfter("60")).toBe(60_000);
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter(new Date(Date.now() + 5_000).toUTCString())).toBeGreaterThan(0);
  });
});

describe("SabhaApiError", () => {
  it("says where an admin turns on a permission the key lacks", () => {
    const body = JSON.stringify({ error: "This app's key doesn't have the dm permission", code: "missing_permission", needed: "dm" });
    const error = new SabhaApiError(403, body, "POST", "/direct_messages");
    expect(error.code).toBe("missing_permission");
    expect(error.message).toContain(`turn on "dm" under "What its key can do"`);
    expect(new SabhaApiError(403, JSON.stringify({ error: "x", code: "forbidden" }), "POST", "/rooms").message).not.toContain("turn on");
  });
});
