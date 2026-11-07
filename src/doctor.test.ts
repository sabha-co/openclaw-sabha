import { describe, expect, it, vi } from "vitest";
import type { ResolvedSabhaAccount } from "./config/accounts.js";
import { formatDoctorReport, runSabhaDoctor } from "./doctor.js";

vi.mock("./monitor/cable-socket.js", () => ({
  connectCable: vi.fn(async ({ onReady }: { onReady: () => void }) => (onReady(), { ready: true })),
}));

const account = {
  accountId: "default",
  enabled: true,
  configured: true,
  url: "https://sabha.test",
  apiBaseUrl: "https://sabha.test/api/v1",
  cableUrl: "wss://sabha.test/cable",
  appKey: "sabha_app_0123456789abcdef0123456789abcdef",
} as ResolvedSabhaAccount;

const fetchWith = (status: number, body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;

describe("runSabhaDoctor", () => {
  it("passes config, api and cable checks", async () => {
    const report = await runSabhaDoctor(account, { fetchImpl: fetchWith(200, { id: 508, name: "Claw" }) });
    expect(report.ok).toBe(true);
    expect(report.checks.map((check) => check.name)).toEqual(["config", "api", "cable"]);
    expect(formatDoctorReport(report)).toContain('✓ api: app "Claw" (id 508)');
  });

  it("stops after a rejected key", async () => {
    const report = await runSabhaDoctor(account, { fetchImpl: fetchWith(401, { error: "unauthorized" }) });
    expect(report.ok).toBe(false);
    expect(report.checks.map((check) => check.name)).toEqual(["config", "api"]);
  });

  it("flags an unconfigured account without network calls", async () => {
    const fetchImpl = fetchWith(200, {});
    const report = await runSabhaDoctor({ ...account, configured: false }, { fetchImpl });
    expect(report.checks).toEqual([{ name: "config", ok: false, detail: "url and appKey are required" }]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
