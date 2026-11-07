// Durable ingress: each event is written to the host's per-account queue
// before any work starts, then drained one room (lane) at a time. Tombstones
// make AnyCable history replays after a reconnect harmless.
import { createStandardRawEventIngressMonitor } from "openclaw/plugin-sdk/channel-ingress-runtime";
import {
  createChannelIngressError,
  type ChannelIngressMonitorDeliveryResult,
  type ChannelIngressMonitorLifecycle,
  type ChannelIngressQueue,
} from "openclaw/plugin-sdk/channel-outbound";
import type { SabhaAppEvent } from "../client/types.js";
import { SabhaApiError } from "../client/client.js";
import { getSabhaRuntime } from "../runtime.js";
import { eventFacts, parseSabhaEvent, SabhaEventShapeError } from "./events.js";

type StoredEvent = { version: 1; rawEvent: string };

export type SabhaIngressLifecycle = Omit<ChannelIngressMonitorLifecycle, "admission">;

export type SabhaIngressDispatch = (
  event: SabhaAppEvent,
  lifecycle: SabhaIngressLifecycle,
) => Promise<ChannelIngressMonitorDeliveryResult | void> | ChannelIngressMonitorDeliveryResult | void;

const SabhaIngressPermanentError = createChannelIngressError<"invalid-event" | "sabha-auth">(
  "SabhaIngressPermanentError",
  { withReason: true },
);

function nonRetryable(error: unknown) {
  if (error instanceof SabhaIngressPermanentError) return { reason: error.reason, message: error.message };
  if (error instanceof SabhaEventShapeError) return { reason: "invalid-event", message: error.message };
  if (error instanceof SabhaApiError && (error.status === 401 || error.status === 403)) {
    return { reason: "sabha-auth", message: error.message };
  }
  return null;
}

export function createSabhaIngress(options: {
  accountId: string;
  selfId: number;
  dispatch: SabhaIngressDispatch;
  log: { info?: (message: string) => void; error?: (message: string) => void };
  abortSignal?: AbortSignal;
  queue?: ChannelIngressQueue<StoredEvent>;
}) {
  const decode = (rawEvent: string, claimId: string): SabhaAppEvent => {
    try {
      return parseSabhaEvent(JSON.parse(rawEvent));
    } catch (error) {
      throw new SabhaIngressPermanentError("invalid-event", `Sabha ingress row ${claimId} is unreadable.`, { cause: error });
    }
  };

  return createStandardRawEventIngressMonitor<SabhaAppEvent, unknown, { eventId: string; laneKey: string } | null>({
    queue: options.queue ?? (() => getSabhaRuntime().state.openChannelIngressQueue<StoredEvent>({ accountId: options.accountId })),
    inspect: (event) => eventFacts(event, options.selfId),
    payload: {
      serialize: (event) => JSON.stringify(event),
      deserialize: (rawEvent, { claim }) => decode(rawEvent, claim.id),
      createClaimError: (kind, claim) =>
        new SabhaIngressPermanentError(
          "invalid-event",
          kind === "invalid-version"
            ? `Sabha ingress row ${claim.id} has an unsupported version.`
            : `Sabha ingress row ${claim.id} does not match its event identity.`,
        ),
    },
    deliver: (event, lifecycle) => options.dispatch(event, lifecycle),
    drain: {
      resolveNonRetryableFailure: nonRetryable,
      onLog: (message) => options.log.info?.(`[sabha:${options.accountId}] ${message}`),
    },
    ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
    createStoppedError: () => new Error("Sabha ingress is stopped."),
    onError: (error) => options.log.error?.(`[sabha:${options.accountId}] ingress drain failed: ${String(error)}`),
    classifyAdmissionError: (error) =>
      error instanceof SabhaEventShapeError || error instanceof SabhaIngressPermanentError ? error.message : undefined,
  });
}

export type SabhaIngress = ReturnType<typeof createSabhaIngress>;
