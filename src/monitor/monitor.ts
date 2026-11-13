// One Sabha account's long-lived connection: identify the app (/me), open the
// durable ingress, then keep one AppEventsChannel subscription alive with
// backoff. Readiness is reported only after the subscription is confirmed.
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import { createAccountStatusSink } from "openclaw/plugin-sdk/channel-outbound";
import { channelBlockedPatch, channelReadyPatch, channelStoppedPatch } from "openclaw/plugin-sdk/gateway-runtime";
import { computeBackoff, type BackoffPolicy } from "openclaw/plugin-sdk/runtime-env";
import type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";
import { SabhaApiError, SabhaClient } from "../client/client.js";
import { MentionRewriter } from "../client/mention-rewrite.js";
import type { SabhaAppEvent, SabhaDraftFrame } from "../client/types.js";
import type { ResolvedSabhaAccount } from "../config/accounts.js";
import { handleSabhaEvent } from "../inbound/turn.js";
import { connectCable, type CableEventMeta, type CableSession, type CreateCableSocket } from "./cable-socket.js";
import { createReplayPositions, type ReplayStore, type SavedReplay } from "./replay-positions.js";
import { declareSabhaCommands } from "./commands.js";
import { isMessageEvent, isReactionEvent, parseSabhaEvent } from "./events.js";
import { createSabhaIngress } from "./ingress.js";

export const RECONNECT_BACKOFF: BackoffPolicy = { initialMs: 1_000, maxMs: 60_000, factor: 2, jitter: 0.2 };
/** Replay a little before the last confirmed connection, to cover streams with no known offset yet. */
const RESUME_OVERLAP_SECONDS = 5;

type Scheduler = {
  readonly signal: AbortSignal;
  schedule: (job: { id: string; delayMs: number; run: () => void }) => { cancel: () => void };
};

export type MonitorSabhaParams = {
  account: ResolvedSabhaAccount;
  cfg: OpenClawConfig;
  runtime: PluginRuntime;
  abortSignal: AbortSignal;
  scheduler: Scheduler;
  setStatus: Parameters<typeof createAccountStatusSink>[0]["setStatus"];
  log?: { info?: (message: string) => void; warn?: (message: string) => void; error?: (message: string) => void };
  createSocket?: CreateCableSocket;
  fetchImpl?: typeof fetch;
};

/** Host-owned timer: the scheduler retires it with the account. */
function delay(scheduler: Scheduler, abortSignal: AbortSignal, ms: number): Promise<void> {
  return new Promise((resolve) => {
    if (abortSignal.aborted) return resolve();
    const job = scheduler.schedule({ id: "sabha-reconnect", delayMs: ms, run: () => done() });
    const done = () => {
      abortSignal.removeEventListener("abort", onAbort);
      resolve();
    };
    const onAbort = () => {
      job.cancel();
      done();
    };
    abortSignal.addEventListener("abort", onAbort, { once: true });
  });
}

const untilAborted = (signal: AbortSignal) =>
  new Promise<void>((resolve) => (signal.aborted ? resolve() : signal.addEventListener("abort", () => resolve(), { once: true })));

function openReplayStore(runtime: PluginRuntime, onError: (error: unknown) => void): ReplayStore | undefined {
  try {
    return runtime.state.openKeyedStore<SavedReplay>({ namespace: "replay-positions", maxEntries: 64 });
  } catch (error) {
    onError(error);
    return undefined;
  }
}

const isAuthFailure = (error: unknown) => error instanceof SabhaApiError && (error.status === 401 || error.status === 403);

export async function monitorSabhaAccount(params: MonitorSabhaParams): Promise<void> {
  const { account, runtime, scheduler, log = {} } = params;
  const abortSignal = AbortSignal.any([params.abortSignal, scheduler.signal]);
  const prefix = `[sabha:${account.accountId}]`;
  const status = createAccountStatusSink({ accountId: account.accountId, setStatus: params.setStatus });
  const mentions = new MentionRewriter();
  const client = new SabhaClient({
    apiBaseUrl: account.apiBaseUrl,
    appKey: account.appKey,
    abortSignal,
    rewriteMentions: (text) => mentions.rewrite(text),
    ...(params.fetchImpl ? { fetchImpl: params.fetchImpl } : {}),
  });

  status({ running: true, connected: false, lifecycle: "starting" });

  // Identify first: the app id filters self echoes and tells mentions apart.
  let selfId: number | undefined;
  for (let attempt = 1; selfId === undefined && !abortSignal.aborted; attempt++) {
    try {
      selfId = (await client.me()).id;
    } catch (error) {
      if (abortSignal.aborted) break;
      if (isAuthFailure(error)) {
        const message = "Sabha rejected the app key (GET /me); update channels.sabha.accounts." + account.accountId + ".appKey";
        log.error?.(`${prefix} ${message}`);
        status(channelBlockedPatch(message, { running: true, connected: false }));
        await untilAborted(abortSignal);
        break;
      }
      const wait = computeBackoff(RECONNECT_BACKOFF, attempt);
      log.warn?.(`${prefix} cannot reach Sabha (${String(error)}); retrying in ${Math.round(wait / 1000)}s`);
      status({ lifecycle: "recovering", connected: false, lastError: String(error) });
      await delay(scheduler, abortSignal, wait);
    }
  }
  if (selfId === undefined) {
    status(channelStoppedPatch());
    return;
  }
  log.info?.(`${prefix} connected as app ${selfId}`);
  void declareSabhaCommands({ client, cfg: params.cfg, log, prefix });

  let session: CableSession | undefined;
  const performDraft = (frame: SabhaDraftFrame) => session?.perform("draft", frame) ?? false;
  const ingress = createSabhaIngress({
    accountId: account.accountId,
    selfId,
    log,
    abortSignal,
    dispatch: (event, lifecycle) =>
      handleSabhaEvent(event, lifecycle, {
        runtime, cfg: params.cfg, account, selfId, client, performDraft, log,
        onInbound: () => status({ lastInboundAt: Date.now() }),
        onOutbound: () => status({ lastOutboundAt: Date.now() }),
      }),
  });
  ingress.start();

  const replayStore = openReplayStore(runtime, (error) => log.warn?.(`${prefix} replay positions won't survive a restart: ${String(error)}`));
  const replay = createReplayPositions(
    replayStore && { store: replayStore, key: account.accountId, onError: (error) => log.warn?.(`${prefix} replay store: ${String(error)}`) },
  );
  let connection = 0;

  // Admit in arrival order; each admission is a durable write.
  let admissions = Promise.resolve();
  const onEvent = (message: unknown, meta: CableEventMeta, from: number) => {
    status({ lastEventAt: Date.now() });
    let event: SabhaAppEvent | undefined;
    try {
      event = parseSabhaEvent(message);
    } catch (error) {
      log.warn?.(`${prefix} ignoring event: ${String(error)}`);
    }
    if (event?.event === "draft_refused") {
      log.warn?.(`${prefix} Sabha refused draft ${String(event.draft_id)}: ${String(event.error)}`);
    }
    if (event && (isMessageEvent(event) || isReactionEvent(event))) {
      mentions.add(event.user.name, event.user.id);
      for (const user of event.message.mentionees ?? []) mentions.add(user.name, user.id);
    }
    const admit = event && event.event !== "draft_refused" ? event : undefined;
    admissions = admissions.then(async () => {
      if (admit) {
        try {
          const admission = await ingress.receive(admit);
          if (admission.kind === "invalid") log.warn?.(`${prefix} rejected event: ${admission.message}`);
        } catch (error) {
          log.error?.(`${prefix} could not store event ${admit.event}; will replay it after reconnecting: ${String(error)}`);
          replay.freeze(meta, from);
          // Reconnect now, so history replays the gap instead of waiting for the next drop.
          if (from === connection) session?.close();
          return;
        }
      }
      // Stored, or deliberately not stored (malformed, refused draft): either way handled.
      replay.commit(meta, from);
    });
  };

  // A restarted gateway asks for what arrived since the last one was connected.
  const lastConnectedAt = await replay.restore();
  let resumeSince = lastConnectedAt === undefined ? undefined : lastConnectedAt - RESUME_OVERLAP_SECONDS;
  let failures = 0;
  try {
    while (!abortSignal.aborted) {
      const current = ++connection;
      const outcome = await connectCable({
        url: account.cableUrl,
        appKey: account.appKey,
        abortSignal,
        positions: replay.positions,
        ...(resumeSince !== undefined ? { resumeSince } : {}),
        onReady: (live) => {
          session = live;
          failures = 0;
          resumeSince = Math.floor(Date.now() / 1000) - RESUME_OVERLAP_SECONDS;
          replay.connected();
          status(channelReadyPatch());
        },
        onEvent: (message, meta) => onEvent(message, meta, current),
        onHistory: (result) => {
          if (result === "stale") replay.forget();
        },
        log,
        ...(params.createSocket ? { createSocket: params.createSocket } : {}),
      });
      session = undefined;
      if (outcome.ready) replay.connected();
      if (abortSignal.aborted) break;
      if (outcome.terminal) {
        log.error?.(`${prefix} ${outcome.terminal.message}`);
        status(channelBlockedPatch(outcome.terminal.message, { running: true, connected: false }));
        await untilAborted(abortSignal);
        break;
      }
      // A close before confirmation counts as a failure, so backoff grows.
      failures = outcome.ready ? 1 : failures + 1;
      const wait = computeBackoff(RECONNECT_BACKOFF, failures);
      const reason = outcome.reason ?? `code ${outcome.code ?? "?"}`;
      log.warn?.(`${prefix} cable closed (${reason}); reconnecting in ${Math.round(wait / 1000)}s`);
      status({ lifecycle: "recovering", connected: false, lastDisconnect: { at: Date.now(), ...(outcome.code ? { status: outcome.code } : {}), error: reason } });
      await delay(scheduler, abortSignal, wait);
    }
  } finally {
    session = undefined;
    await admissions;
    await replay.flush();
    await ingress.stop();
    status(channelStoppedPatch());
  }
}
