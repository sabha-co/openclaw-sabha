import type { ResolvedSabhaAccount } from "./accounts.js";
import { SabhaClient, SabhaApiError } from "./client.js";
import { createSabhaRetryRunner } from "./retry.js";
import { buildWebSocketUrl } from "./monitor.js";
import {
  defaultWebSocketFactory,
  type SabhaWebSocketFactory,
  type WebSocketLike,
} from "./monitor-websocket.js";

// Plugin-level runtime health check. Answers the operator question
// "is this bot actually working?" without tailing logs.
//
// This is NOT the SDK's `ChannelDoctorAdapter`, which is a config-health
// surface (legacy-key migration, allowlist warnings). The canonical
// reference plugins use that adapter only for config validation, and
// there is no SDK hook for runtime connectivity probing. We ship this as
// a dedicated CLI subcommand instead so operators can run it on demand.
//
// Check inventory:
//   1. Config — baseUrl + apiBaseUrl non-empty, botKey matches `\d+-.+`,
//      connectionMode is one of the two supported values.
//   2. API   — `listRooms()` round-trips successfully against the bearer
//      auth endpoint. Covers bot_key validity, HTTP reachability, and the
//      retry runner in one call. (Sabha does not expose a cheaper probe
//      like `GET /api/bots/profile`, so this is the lightest available.)
//   3. WS    — (only when connectionMode === "websocket") open a
//      connection, wait for `welcome`, subscribe to BotEventsChannel,
//      wait for `confirm_subscription`, close cleanly.
//   4. Webhook — (only when connectionMode === "webhook") soft warning:
//      reachability from Sabha to this host cannot be verified from
//      inside the plugin, so we emit a note and move on.

export type DoctorCheckStatus = "ok" | "fail" | "skip" | "warn";

export type DoctorCheck = {
  name: string;
  status: DoctorCheckStatus;
  message?: string;
};

export type DoctorReport = {
  accountId: string;
  checks: DoctorCheck[];
  allPassed: boolean;
};

export type RunDoctorOpts = {
  account: ResolvedSabhaAccount;
  /** Timeout per WebSocket handshake step, in milliseconds. Default 5s. */
  wsTimeoutMs?: number;
  /** Overall timeout for the API probe, in milliseconds. Default 10s. */
  apiTimeoutMs?: number;
  /** Injected for tests; defaults to real `ws` factory in production. */
  webSocketFactory?: SabhaWebSocketFactory;
};

const DEFAULT_WS_TIMEOUT_MS = 5_000;
const DEFAULT_API_TIMEOUT_MS = 10_000;

export async function runDoctor(opts: RunDoctorOpts): Promise<DoctorReport> {
  const { account } = opts;
  const checks: DoctorCheck[] = [];

  // --- Check 1: Config ---
  const configCheck = validateConfig(account);
  checks.push(configCheck);

  // If config is broken the downstream checks can't meaningfully run.
  // Skip them with an explanatory message rather than letting them fail
  // with noise like "fetch ''" or "invalid WebSocket URL".
  if (configCheck.status === "fail") {
    checks.push({
      name: "API reachable",
      status: "skip",
      message: "Skipped: config check failed.",
    });
    if (account.connectionMode === "websocket") {
      checks.push({
        name: "WebSocket subscribe",
        status: "skip",
        message: "Skipped: config check failed.",
      });
    }
    return finalize(account.accountId, checks);
  }

  // --- Check 2: API reachable ---
  checks.push(
    await probeApi(account, opts.apiTimeoutMs ?? DEFAULT_API_TIMEOUT_MS),
  );

  // --- Check 3 or 4: Transport ---
  if (account.connectionMode === "websocket") {
    checks.push(
      await probeWebSocket(
        account,
        opts.wsTimeoutMs ?? DEFAULT_WS_TIMEOUT_MS,
        opts.webSocketFactory ?? defaultWebSocketFactory,
      ),
    );
  } else {
    checks.push({
      name: "Webhook transport",
      status: "warn",
      message:
        "Webhook reachability cannot be verified from the plugin. Ensure Sabha can reach this host on the configured webhook port.",
    });
  }

  return finalize(account.accountId, checks);
}

function finalize(
  accountId: string,
  checks: DoctorCheck[],
): DoctorReport {
  const allPassed = checks.every(
    (c) => c.status === "ok" || c.status === "skip" || c.status === "warn",
  );
  return { accountId, checks, allPassed };
}

// ---------------------------------------------------------------------------
// Check 1: Config
// ---------------------------------------------------------------------------

function validateConfig(account: ResolvedSabhaAccount): DoctorCheck {
  const problems: string[] = [];
  if (!account.baseUrl) problems.push("baseUrl is empty");
  if (!account.apiBaseUrl) problems.push("apiBaseUrl is empty");
  if (!account.botKey) {
    problems.push("botKey is empty");
  } else if (!/^\d+-.+$/.test(account.botKey)) {
    problems.push(`botKey does not match "<id>-<token>" shape`);
  }
  if (
    account.connectionMode !== "websocket" &&
    account.connectionMode !== "webhook"
  ) {
    problems.push(`connectionMode "${account.connectionMode}" is invalid`);
  }
  if (problems.length > 0) {
    return {
      name: "Config",
      status: "fail",
      message: problems.join("; "),
    };
  }
  return {
    name: "Config",
    status: "ok",
    message: `apiBaseUrl=${account.apiBaseUrl}, mode=${account.connectionMode}`,
  };
}

// ---------------------------------------------------------------------------
// Check 2: API reachable
// ---------------------------------------------------------------------------

async function probeApi(
  account: ResolvedSabhaAccount,
  timeoutMs: number,
): Promise<DoctorCheck> {
  // Operator running `sabha doctor` expects immediate feedback. Override
  // the default retry runner with a single-attempt one so a transient 503
  // doesn't cause the probe to silently retry for ~6s before failing.
  // `requestTimeoutMs` is the only deadline — no redundant AbortController.
  const client = new SabhaClient(account.apiBaseUrl, account.botKey, {
    requestTimeoutMs: timeoutMs,
    retryRunner: createSabhaRetryRunner({
      retry: { attempts: 1, minDelayMs: 0, maxDelayMs: 0, jitter: 0 },
    }),
  });
  try {
    // First-page probe: enough to confirm bearer auth + JSON pipe-through.
    // The probe explicitly does NOT count workspace-wide rooms — listRooms
    // is paginated and a one-page response only reflects the first slice.
    const rooms = await client.listRooms({ perPage: 1 });
    return {
      name: "API reachable",
      status: "ok",
      message:
        rooms.length > 0
          ? "listRooms() reachable (first-page probe returned a room)"
          : "listRooms() reachable (no rooms visible to bot yet)",
    };
  } catch (err) {
    if (err instanceof SabhaApiError) {
      const hint =
        err.status === 401 || err.status === 403
          ? " (bot key likely invalid)"
          : err.status === 404
            ? " (check apiBaseUrl / workspace prefix)"
            : "";
      return {
        name: "API reachable",
        status: "fail",
        message: `HTTP ${err.status}${hint}`,
      };
    }
    const message = err instanceof Error ? err.message : String(err);
    return {
      name: "API reachable",
      status: "fail",
      message: `Network error: ${message}`,
    };
  }
}

// ---------------------------------------------------------------------------
// Check 3: WebSocket subscribe
// ---------------------------------------------------------------------------

const BOT_EVENTS_IDENTIFIER = JSON.stringify({ channel: "BotEventsChannel" });

async function probeWebSocket(
  account: ResolvedSabhaAccount,
  timeoutMs: number,
  factory: SabhaWebSocketFactory,
): Promise<DoctorCheck> {
  const wsUrl = buildWebSocketUrl(
    account.baseUrl,
    account.botKey,
    account.websocketUrl,
  );

  let ws: WebSocketLike;
  try {
    ws = factory(wsUrl);
  } catch (err) {
    return {
      name: "WebSocket subscribe",
      status: "fail",
      message: `Failed to open socket: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Track the farthest milestone we reached so failures report *where*
  // in the handshake we got stuck (welcome, subscribe, confirm).
  let phase: "connect" | "welcome" | "subscribe" | "confirmed" = "connect";

  return await new Promise<DoctorCheck>((resolve) => {
    // `finish` MUST be idempotent. The close handler below fires synchronously
    // when we call `ws.close()` from inside a finish path (e.g. after a
    // reject_subscription or timeout), which would otherwise reenter finish
    // and overwrite the real outcome with a generic "socket closed" message.
    let settled = false;
    const finish = (check: DoctorCheck) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      resolve(check);
    };

    const timer = setTimeout(() => {
      finish({
        name: "WebSocket subscribe",
        status: "fail",
        message: `Timed out in phase "${phase}" after ${timeoutMs}ms`,
      });
    }, timeoutMs);

    ws.on("open", () => {
      phase = "welcome";
    });

    ws.on("message", (data) => {
      let parsed: unknown;
      try {
        const raw = data.toString("utf8");
        parsed = JSON.parse(raw);
      } catch {
        // Ignore unparseable frames — ActionCable pings can be pure text
        return;
      }
      if (!parsed || typeof parsed !== "object") return;
      const frame = parsed as Record<string, unknown>;

      if (frame.type === "welcome") {
        phase = "subscribe";
        try {
          ws.send(
            JSON.stringify({
              command: "subscribe",
              identifier: BOT_EVENTS_IDENTIFIER,
            }),
          );
        } catch (err) {
          finish({
            name: "WebSocket subscribe",
            status: "fail",
            message: `Failed to send subscribe frame: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
        return;
      }

      if (
        frame.type === "confirm_subscription" &&
        frame.identifier === BOT_EVENTS_IDENTIFIER
      ) {
        phase = "confirmed";
        finish({
          name: "WebSocket subscribe",
          status: "ok",
          message: "BotEventsChannel subscription confirmed",
        });
        return;
      }

      if (
        frame.type === "reject_subscription" &&
        frame.identifier === BOT_EVENTS_IDENTIFIER
      ) {
        finish({
          name: "WebSocket subscribe",
          status: "fail",
          message: "Sabha rejected the BotEventsChannel subscription (bot_key likely invalid)",
        });
      }
    });

    ws.on("error", (err) => {
      finish({
        name: "WebSocket subscribe",
        status: "fail",
        message: `WebSocket error in phase "${phase}": ${err instanceof Error ? err.message : String(err)}`,
      });
    });

    ws.on("close", () => {
      // A close before "confirmed" is a failure; after is just the
      // natural cleanup triggered by finish(). The early-close branch
      // is guarded by phase so it doesn't race finish().
      if (phase !== "confirmed") {
        finish({
          name: "WebSocket subscribe",
          status: "fail",
          message: `Socket closed in phase "${phase}" before subscription was confirmed`,
        });
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Pretty-printing helpers for the CLI
// ---------------------------------------------------------------------------

const STATUS_SYMBOL: Record<DoctorCheckStatus, string> = {
  ok: "✓",
  fail: "✗",
  skip: "○",
  warn: "!",
};

export function formatDoctorReport(report: DoctorReport): string {
  const lines = [`Sabha doctor — bot account "${report.accountId}"`];
  for (const check of report.checks) {
    const symbol = STATUS_SYMBOL[check.status];
    const tail = check.message ? `  ${check.message}` : "";
    lines.push(`  ${symbol} ${check.name}${tail ? ` —${tail}` : ""}`);
  }
  lines.push("");
  lines.push(report.allPassed ? "All checks passed." : "One or more checks failed.");
  return lines.join("\n");
}
