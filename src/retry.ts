import {
  createRateLimitRetryRunner,
  type RetryConfig,
  type RetryRunner,
} from "openclaw/plugin-sdk/retry-runtime";

// Sabha's Bot API rejects excess traffic with 429 + a `Retry-After` header.
// The 5xx gateway family can appear during deploys or upstream timeouts;
// they usually clear on a second attempt. Everything else (401/403/404/
// 4xx) is a caller bug or permanent failure and must NOT retry, or we'd
// turn typos into retry storms.
export const RETRYABLE_STATUS: ReadonlySet<number> = new Set([
  429, 502, 503, 504,
]);

export const SABHA_RETRY_DEFAULTS = {
  attempts: 3,
  minDelayMs: 500,
  maxDelayMs: 30_000,
  jitter: 0.2,
} satisfies Required<RetryConfig>;

/**
 * Predicate used by the retry runner. Duck-typed so the retry layer does
 * not need to import `SabhaApiError` (avoids a circular import with
 * `./client.js`, which in turn constructs the runner).
 */
export function isRetryableSabhaError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const status = (err as { status?: unknown }).status;
  return typeof status === "number" && RETRYABLE_STATUS.has(status);
}

/**
 * Surfaces the parsed `Retry-After` value from the error so the SDK runner
 * can wait the exact amount the server asked for instead of its own
 * exponential backoff.
 */
export function sabhaRetryAfterMs(err: unknown): number | undefined {
  if (!err || typeof err !== "object") return undefined;
  const v = (err as { retryAfterMs?: unknown }).retryAfterMs;
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/**
 * Parse an HTTP `Retry-After` header value. Supports both the delta-seconds
 * form (`"5"`) and the HTTP-date form (`"Wed, 10 Apr 2026 22:30:00 GMT"`).
 * Returns milliseconds or `undefined` when the header is missing / malformed.
 */
export function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const trimmed = header.trim();
  if (!trimmed) return undefined;

  // delta-seconds (most common form from Rack::Attack / nginx). If the
  // value looks numeric, trust that parse exclusively — don't fall through
  // to Date.parse, since `"-3"` would otherwise be interpreted as year -3.
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds)) {
    return seconds >= 0 ? Math.round(seconds * 1000) : undefined;
  }

  // HTTP-date
  const dateMs = Date.parse(trimmed);
  if (Number.isFinite(dateMs)) {
    return Math.max(0, dateMs - Date.now());
  }

  return undefined;
}

export function createSabhaRetryRunner(
  params: {
    retry?: RetryConfig;
    verbose?: boolean;
  } = {},
): RetryRunner {
  return createRateLimitRetryRunner({
    ...(params.retry ? { retry: params.retry } : {}),
    ...(params.verbose != null ? { verbose: params.verbose } : {}),
    defaults: SABHA_RETRY_DEFAULTS,
    logLabel: "sabha",
    shouldRetry: isRetryableSabhaError,
    retryAfterMs: sabhaRetryAfterMs,
  });
}

export type { RetryRunner, RetryConfig };
