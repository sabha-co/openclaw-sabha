import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";
import { describe, expect, it, vi } from "vitest";
import type { ResolvedSabhaAccount } from "../config/accounts.js";
import { resolveSabhaAccess } from "./access.js";

function commandOwnersFor(account: Pick<ResolvedSabhaAccount, "dmPolicy" | "allowFrom">) {
  const resolveStable = vi.fn(async () => ({}));
  const runtime = { channel: { inbound: { ingress: { resolveStable } } } } as unknown as PluginRuntime;
  return resolveSabhaAccess({
    runtime, cfg: {} as OpenClawConfig, account: { accountId: "default", ...account } as ResolvedSabhaAccount,
    senderId: 5, roomId: "21", chatType: "direct", mentioned: false, requireMention: false, eventKind: "message", hasControlCommand: true,
  }).then(() => (resolveStable.mock.calls[0] as unknown as [{ command: { commandOwnerAllowFrom: unknown } }])[0].command.commandOwnerAllowFrom);
}

describe("command access", () => {
  it("lets anyone the app answers run commands in open mode", async () => {
    expect(await commandOwnersFor({ dmPolicy: "open", allowFrom: [] })).toEqual(["*"]);
  });

  it("limits commands to allowFrom in allowlist mode", async () => {
    expect(await commandOwnersFor({ dmPolicy: "allowlist", allowFrom: ["1"] })).toEqual(["1"]);
  });
});
