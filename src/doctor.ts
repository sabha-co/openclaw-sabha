// `openclaw sabha doctor`: config, REST (/me) and cable subscription checks
// for one account, without touching the running gateway.
import { describeProbeFailure, probeSabhaApp } from "./client/probe.js";
import type { ResolvedSabhaAccount } from "./config/accounts.js";
import { connectCable, type CreateCableSocket } from "./monitor/cable-socket.js";

export type DoctorCheck = { name: string; ok: boolean; detail: string };
export type DoctorReport = { accountId: string; checks: DoctorCheck[]; ok: boolean };

async function checkCable(account: ResolvedSabhaAccount, timeoutMs: number, createSocket?: CreateCableSocket): Promise<DoctorCheck> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const outcome = await connectCable({
      url: account.cableUrl,
      appKey: account.appKey,
      abortSignal: controller.signal,
      positions: new Map(),
      onReady: () => controller.abort(),
      onEvent: () => {},
      timeouts: { handshakeMs: timeoutMs, subscribeMs: timeoutMs },
      ...(createSocket ? { createSocket } : {}),
    });
    if (outcome.ready) return { name: "cable", ok: true, detail: `AppEventsChannel subscribed at ${account.cableUrl}` };
    if (outcome.terminal) return { name: "cable", ok: false, detail: outcome.terminal.message };
    return { name: "cable", ok: false, detail: `no subscription from ${account.cableUrl} (${outcome.reason ?? `code ${outcome.code ?? "?"}`})` };
  } finally {
    clearTimeout(timer);
  }
}

export async function runSabhaDoctor(
  account: ResolvedSabhaAccount,
  options: { timeoutMs?: number; fetchImpl?: typeof fetch; createSocket?: CreateCableSocket } = {},
): Promise<DoctorReport> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const checks: DoctorCheck[] = [];
  if (!account.enabled) checks.push({ name: "config", ok: false, detail: "account is disabled" });
  else if (!account.configured) checks.push({ name: "config", ok: false, detail: "url and appKey are required" });
  else checks.push({ name: "config", ok: true, detail: `${account.url} (cable ${account.cableUrl})` });

  if (checks[0]!.ok) {
    const probe = await probeSabhaApp({ apiBaseUrl: account.apiBaseUrl, appKey: account.appKey, timeoutMs, ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}) });
    checks.push(
      probe.ok
        ? { name: "api", ok: true, detail: `app "${probe.identity.name}" (id ${probe.identity.id})${probe.identity.workspace?.name ? ` in ${probe.identity.workspace.name}` : ""}` }
        : { name: "api", ok: false, detail: describeProbeFailure(probe) },
    );
    if (probe.ok) checks.push(await checkCable(account, timeoutMs, options.createSocket));
  }
  return { accountId: account.accountId, checks, ok: checks.every((check) => check.ok) };
}

export function formatDoctorReport(report: DoctorReport): string {
  const lines = [`Sabha account "${report.accountId}": ${report.ok ? "ok" : "problems found"}`];
  for (const check of report.checks) lines.push(`  ${check.ok ? "✓" : "✗"} ${check.name}: ${check.detail}`);
  return lines.join("\n");
}
