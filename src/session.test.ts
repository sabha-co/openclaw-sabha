import { expect, it } from "vitest";
import { buildSabhaSessionRoute } from "./session.js";

it("isolates tenant-local ids in both group and direct sessions", () => {
  for (const chatType of ["direct", "group"] as const) {
    const params = { cfg: {}, agentId: "main", roomId: "5", chatType };
    const a = buildSabhaSessionRoute({ ...params, accountId: "one" });
    const b = buildSabhaSessionRoute({ ...params, accountId: "two" });
    expect(a.sessionKey).not.toBe(b.sessionKey);
    expect(buildSabhaSessionRoute({ ...params, accountId: "one" }).sessionKey).toBe(a.sessionKey);
    expect(a.to).toBe("5");
  }
});
it("uses each thread room as its own conversation without fabricating a parent", () => {
  const params = { cfg: {}, agentId: "main", accountId: "one", chatType: "group" as const };
  const parent = buildSabhaSessionRoute({ ...params, roomId: "5" });
  const thread = buildSabhaSessionRoute({ ...params, roomId: "99", threadId: "99" });
  expect(thread.sessionKey).not.toBe(parent.sessionKey);
  expect(thread.to).toBe("99");
});
