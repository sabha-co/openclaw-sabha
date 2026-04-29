import { describe, it, expect } from "vitest";
import { sabhaPlugin } from "./channel.js";
import { resolveSabhaAccount } from "./accounts.js";
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";

function makeCfg(sabha?: Record<string, unknown>): OpenClawConfig {
  return { channels: { sabha } } as unknown as OpenClawConfig;
}

describe("resolveSabhaAccount", () => {
  it("resolves from config", () => {
    const cfg = makeCfg({
      accounts: {
        default: {
          baseUrl: "https://sabha.co/1000006",
          botKey: "42-AbCdEfGhIjKl",
        },
      },
    });
    const account = resolveSabhaAccount({ cfg });
    expect(account.baseUrl).toBe("https://sabha.co/1000006");
    expect(account.botKey).toBe("42-AbCdEfGhIjKl");
    expect(account.botId).toBe(42);
  });

  it("defaults dmPolicy to open", () => {
    const cfg = makeCfg({
      accounts: { default: { baseUrl: "x", botKey: "1-a" } },
    });
    expect(resolveSabhaAccount({ cfg }).dmPolicy).toBe("open");
  });

  it("returns empty strings for missing config", () => {
    const account = resolveSabhaAccount({ cfg: makeCfg() });
    expect(account.baseUrl).toBe("");
    expect(account.botKey).toBe("");
    expect(account.botId).toBe(0);
  });
});

describe("sabhaPlugin.config", () => {
  // The full inspector shape is exercised in src/account-inspect.test.ts.
  // These tests confirm the plugin object's `inspectAccount` slot is wired
  // through to the same module and surfaces the SDK-contract fields the
  // audit layer reads (`enabled`, `configured`, tri-state credential status).

  it("inspectAccount returns configured when baseUrl, apiBaseUrl, botKey set", () => {
    const cfg = makeCfg({
      baseUrl: "https://sabha.co/1000006",
      apiBaseUrl: "https://sabha.co/1000006/api/bots",
      botKey: "42-AbCdEfGhIjKl",
    });
    const result = sabhaPlugin.config.inspectAccount!(cfg) as {
      configured: boolean;
      enabled: boolean;
      tokenStatus: string;
    };
    expect(result.configured).toBe(true);
    expect(result.enabled).toBe(true);
    expect(result.tokenStatus).toBe("available");
  });

  it("inspectAccount reports missing when unconfigured", () => {
    const result = sabhaPlugin.config.inspectAccount!(makeCfg()) as {
      configured: boolean;
      tokenStatus: string;
    };
    expect(result.configured).toBe(false);
    expect(result.tokenStatus).toBe("missing");
  });

  it("inspectAccount reports missing without botKey", () => {
    const cfg = makeCfg({ baseUrl: "https://sabha.co" });
    const result = sabhaPlugin.config.inspectAccount!(cfg) as {
      configured: boolean;
      tokenStatus: string;
    };
    expect(result.configured).toBe(false);
    expect(result.tokenStatus).toBe("missing");
  });

  it("inspectAccount reports missing without apiBaseUrl", () => {
    const cfg = makeCfg({
      baseUrl: "https://sabha.co",
      botKey: "42-AbCdEfGhIjKl",
    });
    const result = sabhaPlugin.config.inspectAccount!(cfg) as {
      configured: boolean;
      apiBaseUrlStatus: string;
    };
    expect(result.configured).toBe(false);
    expect(result.apiBaseUrlStatus).toBe("missing");
  });
});

describe("sabhaPlugin.capabilities", () => {
  it("advertises expected chat types and features", () => {
    expect(sabhaPlugin.capabilities.chatTypes).toContain("direct");
    expect(sabhaPlugin.capabilities.chatTypes).toContain("group");
    expect(sabhaPlugin.capabilities.chatTypes).toContain("thread");
    expect(sabhaPlugin.capabilities.reactions).toBe(true);
    expect(sabhaPlugin.capabilities.threads).toBe(true);
    expect(sabhaPlugin.capabilities.media).toBe(true);
  });
});

describe("sabhaPlugin.meta", () => {
  it("declares sabha identity", () => {
    expect(sabhaPlugin.meta.id).toBe("sabha");
    expect(sabhaPlugin.meta.label).toBe("Sabha");
  });
});

describe("sabhaPlugin.actions.describeMessageTool", () => {
  function discover() {
    const fn = sabhaPlugin.actions!.describeMessageTool!;
    return fn({
      cfg: makeCfg(),
      accountId: null,
    } as unknown as Parameters<typeof fn>[0])!;
  }

  it("includes read and reactions in the actions enum (peer parity with Slack)", () => {
    const discovery = discover();
    expect(discovery.actions).toContain("read");
    expect(discovery.actions).toContain("reactions");
  });

  it("retains the seven pre-existing actions alongside the new pair", () => {
    const discovery = discover();
    for (const a of [
      "send",
      "edit",
      "unsend",
      "react",
      "thread-reply",
      "search",
      "member-info",
    ]) {
      expect(discovery.actions).toContain(a);
    }
  });

  it("publishes the cursor-paginated read fields once, shared between search and read", () => {
    // before/after/limit/cursor are the only Sabha-specific fields the
    // plugin contributes; canonical scoping (channelId/channelIds/...)
    // comes from core's buildChannelTargetSchema. The same four fields
    // serve both `search` and `read` because the underlying server
    // concern is shared. This test pins the property names so a future
    // change that renames or removes one surfaces here.
    const discovery = discover();
    const fragments = Array.isArray(discovery.schema)
      ? discovery.schema
      : discovery.schema
        ? [discovery.schema]
        : [];
    const properties = fragments.flatMap((f) => Object.keys(f.properties ?? {}));
    expect(properties.sort()).toEqual(["after", "before", "cursor", "limit"]);
  });

  it("schema field descriptions cover both `search` and `read` (regression guard for the broadening)", () => {
    // Before this PR the descriptions said "Sabha search:". Adding `read`
    // as a second consumer of the same fields means the descriptions
    // should mention both — otherwise an agent reading the field schema
    // wouldn't connect them to `read`. Asserting on the description text
    // for one representative field is enough to catch regressions.
    const discovery = discover();
    const fragments = Array.isArray(discovery.schema)
      ? discovery.schema
      : discovery.schema
        ? [discovery.schema]
        : [];
    const cursorField = fragments
      .flatMap((f) => Object.entries(f.properties ?? {}))
      .find(([k]) => k === "cursor");
    expect(cursorField).toBeDefined();
    const desc = (cursorField![1] as { description?: string }).description ?? "";
    expect(desc).toMatch(/search/);
    expect(desc).toMatch(/read/);
  });
});

describe("sabhaPlugin.actions.messageActionTargetAliases", () => {
  // The core message-action runner gates dispatch on `actionHasTarget`
  // (`node_modules/openclaw/dist/message-action-runner-*.js`). Without these
  // alias declarations, `{ action: "read", roomId: 5 }` would be rejected
  // before reaching `handleAction` even though dispatch accepts roomId.
  // These tests pin the publishing so a future drift (handler accepts an
  // alias that core silently rejects) surfaces here.

  it("publishes roomId / room_id / channel_id aliases for `read`", () => {
    const aliases = sabhaPlugin.actions!.messageActionTargetAliases!;
    expect(aliases.read?.aliases.sort()).toEqual([
      "channel_id",
      "roomId",
      "room_id",
    ]);
  });

  it("publishes messageId / message_id aliases for `reactions` (id-only on the wire, matches core's edit/unsend treatment)", () => {
    const aliases = sabhaPlugin.actions!.messageActionTargetAliases!;
    expect(aliases.reactions?.aliases.sort()).toEqual([
      "messageId",
      "message_id",
    ]);
  });

  it("does not publish `to`, `channelId`, or `target` (handled by core or as a synthetic field)", () => {
    // `to` and `channelId` are always accepted by core's actionHasTarget;
    // `target` is the runner's synthetic post-normalization field, which
    // we don't want to short-circuit by claiming it as an alias.
    const aliases = sabhaPlugin.actions!.messageActionTargetAliases!;
    for (const action of ["read", "reactions"] as const) {
      const list = aliases[action]?.aliases ?? [];
      expect(list).not.toContain("to");
      expect(list).not.toContain("channelId");
      expect(list).not.toContain("target");
    }
  });
});

describe("sabhaPlugin.agentPrompt.inboundFormattingHints", () => {
  // Identity + mention syntax live here (not in messageToolHints) so they
  // survive on non-`messaging` tool profiles where core's gate would
  // otherwise drop the entire `### message tool` subsection. See
  // docs/MESSAGE-TOOL-HINT-DEPENDENCE-PLAN.md.
  const fn = sabhaPlugin.agentPrompt!.inboundFormattingHints!;
  const rules = (fn() as { rules: string[] }).rules;

  it("declares Sabha identity so the agent does not default to Discord/Slack priors", () => {
    expect(rules.some((r) => /\bSabha\b/.test(r) && /Discord|Slack|Teams/.test(r))).toBe(true);
  });

  it("declares the @{USER_ID} mention syntax so server-side format_mentions does not silently drop the mention", () => {
    expect(rules.some((r) => r.includes("@{USER_ID}"))).toBe(true);
  });

  it("retains the standard markdown rule so outbound rendering still routes through Trix", () => {
    expect(rules.some((r) => /standard Markdown/i.test(r))).toBe(true);
  });
});

describe("sabhaPlugin.agentPrompt.messageToolHints", () => {
  // This hook renders on every agent system prompt that has the `message`
  // tool — including proactive (non-inbound) runs that
  // `inboundFormattingHints` does not reach. Identity + mention syntax
  // are kept here as a minimal stub for that path; the fuller version
  // lives in `inboundFormattingHints` for the inbound auto-reply path.
  // Plus advisory planning hints (search truncation, read newest-first).
  const fn = sabhaPlugin.agentPrompt!.messageToolHints!;
  const cfg = makeCfg({
    accounts: {
      default: {
        baseUrl: "https://sabha.example",
        botKey: "1-Key",
        botName: "Bot",
      },
    },
  });
  const joined = fn({ cfg } as Parameters<typeof fn>[0]).join("\n");

  it("retains a minimal identity reminder so proactive agent runs know they're on Sabha", () => {
    expect(joined).toMatch(/Sabha/);
    expect(joined).toMatch(/Discord|Slack|Teams/);
  });

  it("retains the @{USER_ID} mention rule so proactive sends do not regress to Discord/Slack syntax", () => {
    expect(joined).toMatch(/@\{USER_ID\}/);
    expect(joined).toMatch(/silently dropped/);
  });

  it("retains the newest-first read-history hint so agents reorder for chronological summaries", () => {
    expect(joined).toMatch(/newest[- ]first/i);
    expect(joined).toMatch(/cursor/i);
  });

  it("retains the search-truncation hint so agents do not summarize a 200-cap slice as complete", () => {
    expect(joined).toMatch(/hasMore/);
  });

  it("does not carry the verbose pre-2026.4.29 identity preamble (moved to inboundFormattingHints)", () => {
    expect(joined).not.toMatch(/YOU ARE ON SABHA/);
    expect(joined).not.toMatch(/Conversations happen in rooms/);
  });
});

describe("sabhaPlugin.threading.resolveReplyToMode", () => {
  // The deliver callbacks in monitor.ts / index.ts read `account.replyToMode`
  // directly; the SDK reply planner reads through this adapter. They must
  // see the same per-account value, otherwise the SDK plans inline replies
  // while the plugin threads them (or vice-versa).
  const adapter = sabhaPlugin.threading!.resolveReplyToMode!;

  it("returns the per-account override when set", () => {
    const cfg = makeCfg({
      replyToMode: "first",
      accounts: {
        production: { baseUrl: "y", botKey: "2-b", replyToMode: "off" },
      },
    });
    expect(adapter({ cfg, accountId: "production" })).toBe("off");
  });

  it("falls through to the base value when the account doesn't override", () => {
    const cfg = makeCfg({
      replyToMode: "all",
      accounts: { production: { baseUrl: "y", botKey: "2-b" } },
    });
    expect(adapter({ cfg, accountId: "production" })).toBe("all");
  });

  it("defaults to 'first' when nothing is configured", () => {
    expect(adapter({ cfg: makeCfg(), accountId: "default" })).toBe("first");
  });
});

describe("sabhaPlugin.gateway.startAccount fail-closed paths", () => {
  type CapturedLog = { level: string; message: string };

  // Minimal ctx that exercises the early-return branches without
  // touching monitorSabha. The disabled / wrong-mode branches never
  // reach the "should monitor" block, so cfg / setStatus / channelRuntime
  // don't need real implementations.
  function makeCtx(
    account: ReturnType<typeof resolveSabhaAccount>,
    logs: CapturedLog[],
    abortSignal: AbortSignal,
  ): Parameters<
    NonNullable<typeof sabhaPlugin.gateway>["startAccount"]
  >[0] {
    const record =
      (level: string) =>
      (message: string): void => {
        logs.push({ level, message });
      };
    return {
      account,
      cfg: makeCfg(),
      abortSignal,
      log: {
        debug: record("debug"),
        info: record("info"),
        warn: record("warn"),
        error: record("error"),
      },
      channelRuntime: undefined,
      setStatus: () => {},
      getStatus: () => ({}),
    } as unknown as Parameters<
      NonNullable<typeof sabhaPlugin.gateway>["startAccount"]
    >[0];
  }

  it("skips disabled accounts without starting a monitor", async () => {
    const account = {
      ...resolveSabhaAccount({
        cfg: makeCfg({ accounts: { default: { baseUrl: "https://x", botKey: "1-a" } } }),
      }),
      enabled: false,
    };
    const logs: CapturedLog[] = [];
    const ac = new AbortController();
    const startPromise = sabhaPlugin.gateway!.startAccount!(
      makeCtx(account, logs, ac.signal),
    );
    ac.abort();
    await startPromise;

    expect(
      logs.some((l) => l.level === "info" && /Disabled/i.test(l.message)),
    ).toBe(true);
    // Must not have logged "Starting WebSocket monitor"
    expect(logs.some((l) => /Starting WebSocket monitor/.test(l.message))).toBe(
      false,
    );
  });

});

describe("sabhaPlugin.status", () => {
  it("buildAccountSnapshot reports configured from account", () => {
    const account = resolveSabhaAccount({
      cfg: makeCfg({
        accounts: {
          default: {
            baseUrl: "https://sabha.co",
            apiBaseUrl: "https://sabha.co/api/bots",
            botKey: "1-abc",
          },
        },
      }),
    });
    const snapshot = sabhaPlugin.status!.buildAccountSnapshot!({
      account,
      cfg: makeCfg(),
      runtime: undefined,
    }) as { configured: boolean; running: boolean };
    expect(snapshot.configured).toBe(true);
    expect(snapshot.running).toBe(false);
  });

  it("buildAccountSnapshot reflects runtime running state", () => {
    const account = resolveSabhaAccount({
      cfg: makeCfg({ accounts: { default: { baseUrl: "x", botKey: "1-a" } } }),
    });
    const snapshot = sabhaPlugin.status!.buildAccountSnapshot!({
      account,
      cfg: makeCfg(),
      runtime: {
        accountId: "default",
        running: true,
        lastStartAt: 12345,
      },
    }) as { running: boolean; lastStartAt: number };
    expect(snapshot.running).toBe(true);
    expect(snapshot.lastStartAt).toBe(12345);
  });
});
