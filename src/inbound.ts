import type {
  ResolvedBotAccount,
  DeliveryPayload,
  SabhaMessageCreatedPayload,
  SabhaMessageEventPayload,
  SabhaMessageUpdatedPayload,
  SabhaMessageDeletedPayload,
  SabhaBoostCreatedPayload,
  SabhaBoostDeletedPayload,
  SabhaUserCreatedPayload,
  SabhaUserDeletedPayload,
} from "./types.js";
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import { wasBotMentioned, resolveChatType } from "./webhook.js";
import { resolveSessionFromPayload } from "./session.js";
import { resolveAttachmentSsrfPolicy } from "./ssrf-guard.js";

import type { PluginRuntime } from "openclaw/plugin-sdk/channel-core";
import { dispatchInboundReplyWithBase } from "openclaw/plugin-sdk/inbound-reply-dispatch";

type ChannelRuntime = PluginRuntime["channel"];

type Logger = {
  debug?: (message: string) => void;
  info?: (message: string) => void;
  error?: (message: string) => void;
};

const CHANNEL_ID = "sabha";

/**
 * Pre-flight check: should the bot act on this inbound message at all?
 *
 * Mirrors the gating logic at the top of `processInboundMessage` so
 * callers (like the WebSocket monitor) can decide whether to start a
 * typing indicator without duplicating the rules. Applies uniformly to
 * every message-bearing variant: the bot's own events are always
 * filtered out, and in groups we require an @mention regardless of
 * whether the event is a create, edit, delete, or boost.
 */
export function shouldHandleInbound(
  payload: SabhaMessageEventPayload,
  botId: number,
): boolean {
  // Skip the bot's own events (self-echo filter). This covers both
  // `message_created` replies and any `message_updated` / `*_deleted`
  // echoes Sabha sends back when the bot edits / deletes its own content
  // through the by-bots controllers (Scout A, hazard #2).
  if (payload.user.id === botId) return false;
  // In DMs and threads, always handle — no mention required. Threads
  // the bot created are ongoing conversations; requiring a re-mention
  // on every reply would break the auto-thread flow.
  const isDm = resolveChatType(payload.room.type) === "direct";
  const isThread = payload.message.thread != null;
  if (isDm || isThread) return true;
  // In top-level group messages, require an @mention.
  if (!wasBotMentioned(payload, botId)) return false;
  return true;
}

/**
 * Should the bot stream its reply (draft-stream preview) for this inbound?
 *
 * Streaming requires a target room id known up front for both the partial
 * sends and the final edit. Three cases qualify:
 *
 *   - Already in a thread: `payload.room.id` IS the thread room id (Sabha
 *     models threads as Room subclasses; server emits `room.id == thread.id`
 *     when in-thread — see `app/models/bot/event_payload.rb#thread_to_api`).
 *     Stream directly into that room.
 *   - DM: never threaded, partials and final both go to the room.
 *   - Top-level non-DM with `replyToMode: "off"`: final reply is inline,
 *     same room as partials.
 *
 * The remaining case — top-level non-DM with threading on — would split
 * partials (parent room) from the final (new thread room). Phase 2 handles
 * this via a `firstSend` hook on the draft stream that creates the thread
 * on the first partial; until then, fall back to the non-streaming path.
 */
export function shouldStreamReply(
  payload: SabhaMessageEventPayload,
  account: { replyToMode?: "off" | "first" | "all" },
): boolean {
  if (payload.message.thread != null) return true;
  if (payload.room.type === "Direct") return true;
  return (account.replyToMode ?? "first") === "off";
}

type InboundDeps = {
  runtime: PluginRuntime | ChannelRuntime;
  cfg: OpenClawConfig;
  account: ResolvedBotAccount;
  deliver: (payload: DeliveryPayload) => Promise<void>;
  logger?: Logger;
  /**
   * Streaming hook. Called by the OpenClaw runtime as the agent yields
   * partial output during a turn. `payload.text` carries the full
   * accumulated snapshot on every call, not a delta. Wired into
   * `dispatchInboundReplyWithBase`'s `replyOptions.onPartialReply` so
   * Phase 2.1's draft stream can PATCH the preview message in place.
   * Left undefined on code paths that don't want streaming (e.g.
   * thread replies in v1 — see `src/draft-stream.ts` for why).
   */
  onPartialReply?: (payload: { text?: string }) => void | Promise<void>;
};

/**
 * Process an inbound Sabha webhook event and dispatch it to OpenClaw's reply pipeline.
 */
export async function processInboundMessage(
  payload: SabhaMessageCreatedPayload,
  deps: InboundDeps,
): Promise<void> {
  const {
    runtime: runtimeOrChannel,
    cfg,
    account,
    deliver,
    logger,
    onPartialReply,
  } = deps;

  // Normalize: accept either PluginRuntime or ChannelRuntime directly
  const channel: ChannelRuntime = "channel" in runtimeOrChannel
    ? (runtimeOrChannel as PluginRuntime).channel
    : runtimeOrChannel as ChannelRuntime;

  // Skip messages from the bot itself
  if (payload.user.id === account.botId) return;

  const chatType = resolveChatType(payload.room.type);
  const isDm = chatType === "direct";
  const isThread = payload.message.thread != null;
  const mentioned = wasBotMentioned(payload, account.botId);

  // DMs and threads are always handled. Top-level group messages require mention.
  if (!isDm && !isThread && !mentioned) return;

  const session = resolveSessionFromPayload(payload);
  const accountId = account.accountId ?? "";

  // Resolve agent route
  const route = channel.routing.resolveAgentRoute({
    cfg,
    channel: CHANNEL_ID,
    accountId,
    peer: {
      kind: chatType,
      id: session.conversationId,
    },
  });

  // Resolve store path
  const storePath = channel.session.resolveStorePath(undefined, {
    agentId: route.agentId,
  });

  // Download attachment immediately (signed URLs expire after 1 hour)
  let attachmentPath: string | undefined;
  if (payload.message.has_attachment && payload.message.attachment) {
    try {
      const { url, filename, content_type } = payload.message.attachment;
      const ssrfPolicy = resolveAttachmentSsrfPolicy(account);
      const fetched = await channel.media.fetchRemoteMedia({
        url,
        ...(ssrfPolicy ? { ssrfPolicy } : {}),
      });
      const saved = await channel.media.saveMediaBuffer(
        fetched.buffer,
        content_type,
        "inbound",
        undefined,
        filename,
      );
      attachmentPath = saved.id;
    } catch (err) {
      logger?.error?.(`[sabha] Failed to download attachment: ${err}`);
    }
  }

  // Build raw message body (clean text for the LLM)
  const rawBody = payload.message.body.plain;

  // Build body with attachment context if present
  const bodyWithAttachment = attachmentPath
    ? `${rawBody}\n\n[Attachment: ${payload.message.attachment!.filename} — saved to ${attachmentPath}]`
    : rawBody;

  // Build the formatted envelope (with sender/timestamp context).
  //
  // Why the `from` field embeds `@{id}`: Sabha's mention syntax is
  // `@{user_id}` (see `/skill` — "To mention a user, use @{user_id}
  // syntax"). The envelope body the LLM reads is the only place the
  // agent learns who sent the message, and `formatAgentEnvelope` only
  // accepts `from: string` (no separate id field on the SDK type). If we
  // pass just the display name the agent has no way to construct a
  // mention, because the numeric id lives in `ctxPayload.SenderId` which
  // is metadata, not prompt text. Folding the literal `@{id}` token into
  // the from string gives the agent the exact syntax to echo back —
  // nextcloud-talk sets precedent for non-plain-name from values
  // (`user:42`, `room:General`). This is the fix for 0.9.4's "mentions
  // never trigger server-side" bug where agents emitted plain-text
  // `@Alice` instead of `@{1}`.
  const envelopeOpts = channel.reply.resolveEnvelopeFormatOptions(cfg);
  const envelope = channel.reply.formatAgentEnvelope({
    channel: CHANNEL_ID,
    from: `${payload.user.name} (@{${payload.user.id}})`,
    timestamp: new Date(payload.message.created_at).getTime(),
    envelope: envelopeOpts,
    body: bodyWithAttachment,
  });

  // Resolve per-room system prompt (operator-defined via config)
  const roomConfig = account.rooms?.[String(payload.room.id)];
  const groupSystemPrompt = !isDm
    ? roomConfig?.systemPrompt?.trim() || undefined
    : undefined;

  // Build the inbound context with PascalCase field names (MsgContext)
  const ctxPayload = channel.reply.finalizeInboundContext({
    Body: envelope,
    BodyForAgent: envelope,
    RawBody: rawBody,
    BodyForCommands: rawBody,
    CommandBody: rawBody,
    From: payload.user.name,
    SenderId: String(payload.user.id),
    SenderName: payload.user.name,
    To: String(payload.room.id),
    SessionKey: route.sessionKey,
    AccountId: accountId,
    ChatType: chatType,
    ConversationLabel: payload.room.name,
    Timestamp: new Date(payload.message.created_at).getTime(),
    MessageSid: String(payload.message.id),
    GroupSystemPrompt: groupSystemPrompt,
    ...(session.threadId ? {
      ReplyToId: session.threadId,
      ParentSessionKey: session.baseConversationId
        ? route.sessionKey
        : undefined,
    } : {}),
    ...(attachmentPath ? {
      MediaPath: attachmentPath,
    } : {}),
  });

  logger?.info?.(
    `[sabha] Dispatching: ${payload.event} from ${payload.user.name} in ${payload.room.name}`,
  );

  // Record session and dispatch reply
  await dispatchInboundReplyWithBase({
    cfg,
    channel: CHANNEL_ID,
    accountId,
    route,
    storePath,
    ctxPayload,
    core: { channel },
    deliver,
    onRecordError: (err) => {
      logger?.error?.(`[sabha] Session record error: ${err}`);
    },
    onDispatchError: (err, info) => {
      logger?.error?.(`[sabha] Dispatch error (${info.kind}): ${err}`);
    },
    // `replyOptions` threads through to the agent runtime. `onPartialReply`
    // is how streaming draft-stream previews are driven — each call carries
    // the full accumulated text snapshot (not a delta), so the caller can
    // feed it directly into `SabhaDraftStream.update`. See §2.1 of the
    // plan for the Q10/Q12 decisions and `src/draft-stream.ts` for the
    // throttle / lifecycle contract.
    ...(onPartialReply ? { replyOptions: { onPartialReply } } : {}),
  });
}

// ---------------------------------------------------------------------------
// Edit / delete / boost handlers
// ---------------------------------------------------------------------------
//
// Phase 1.5 wires the dispatch table end-to-end for every message-bearing
// event but keeps the handlers intentionally light: they log at INFO so
// operators can confirm the pipeline is flowing, apply the same self-echo
// and mention filters as `message_created`, and otherwise return. Agent-
// facing semantics (forwarding an edit into the LLM's conversation state,
// propagating a delete, consuming a boost for approval routing) belong to
// Phase 2 — streaming will flesh out edit context and section 2.2
// (approvals via boost reactions) will upgrade `boost_created` to the
// approval handler. The current shape is: "fully typed, fully dispatched,
// ready to grow."

type MessageEventHandlerDeps = {
  botId: number;
  logger?: Logger;
};

export async function handleMessageUpdated(
  payload: SabhaMessageUpdatedPayload,
  deps: MessageEventHandlerDeps,
): Promise<void> {
  if (!shouldHandleInbound(payload, deps.botId)) return;
  // Stateless tolerance: the bot may receive `message_updated` for a
  // message it never observed at create time (Scout A, hazard #1 —
  // `Room#bot_memberships_for_events` fires updates to every eligible
  // member, not just the original mention targets). Don't assume prior
  // state. Log and return.
  deps.logger?.info?.(
    `[sabha] message_updated {id=${payload.message.id}, room=${payload.room.name}, from=${payload.user.name}}`,
  );
}

export async function handleMessageDeleted(
  payload: SabhaMessageDeletedPayload,
  deps: MessageEventHandlerDeps,
): Promise<void> {
  if (!shouldHandleInbound(payload, deps.botId)) return;
  // Soft-delete: `payload.message.body` is still populated server-side
  // at the moment this event fires. We don't forward the body here
  // because doing so would circumvent the user's intent to delete.
  deps.logger?.info?.(
    `[sabha] message_deleted {id=${payload.message.id}, room=${payload.room.name}, from=${payload.user.name}}`,
  );
}

export async function handleBoostCreated(
  payload: SabhaBoostCreatedPayload,
  deps: MessageEventHandlerDeps,
): Promise<void> {
  // Self-echo filter only — boosts are global by design and we do NOT
  // require an @mention on the underlying message to route a boost
  // through the plugin. Phase 2.2 (approval routing) will route boosts
  // on pending-approval messages here before this handler runs.
  if (payload.user.id === deps.botId) return;
  deps.logger?.info?.(
    `[sabha] boost_created {message=${payload.message.id}, boost=${payload.boost.id}, body=${JSON.stringify(payload.boost.body)}, from=${payload.user.name}}`,
  );
}

export async function handleBoostDeleted(
  payload: SabhaBoostDeletedPayload,
  deps: MessageEventHandlerDeps,
): Promise<void> {
  if (payload.user.id === deps.botId) return;
  deps.logger?.info?.(
    `[sabha] boost_deleted {message=${payload.message.id}, boost=${payload.boost.id}, from=${payload.user.name}}`,
  );
}

// ---------------------------------------------------------------------------
// user_* stubs
// ---------------------------------------------------------------------------
//
// PRIVACY INVARIANT: `user_created` and `user_deleted` fan out globally
// across every active bot in the Sabha workspace — see
// `app/controllers/concerns/notify_bots.rb:19-24`. If we forwarded these
// payloads to any agent-visible surface, bot A could observe bot B's
// user-creation patterns, leaking information across bot tenants in the
// same tenant. These stubs exist purely to keep the dispatch table
// complete (so future hooks don't have to re-touch webhook parsing or
// monitor dispatch); they MUST NOT emit the payload through
// `dispatchInboundReplyWithBase`, `formatAgentEnvelope`, or any other
// agent-runtime path. Any future feature wiring `user_*` to a visible
// surface must gate on a per-bot-account opt-in flag and document the
// tradeoff in `docs/ARCHITECTURE.md`.

type UserEventHandlerDeps = {
  logger?: Logger;
};

export async function handleUserCreated(
  payload: SabhaUserCreatedPayload,
  deps: UserEventHandlerDeps,
): Promise<void> {
  // TODO(v1.1+): optional welcome-DM hook, opted into per bot account
  // via `channels.sabha.botAccounts.<id>.onUserCreated: "welcome-dm"`.
  deps.logger?.debug?.(
    `[sabha] user_created {id=${payload.user.id}, name=${payload.user.name}} — no handler configured`,
  );
}

export async function handleUserDeleted(
  payload: SabhaUserDeletedPayload,
  deps: UserEventHandlerDeps,
): Promise<void> {
  // TODO(v1.1+): user-cleanup hook (e.g. purge cached user state).
  deps.logger?.debug?.(
    `[sabha] user_deleted {id=${payload.user.id}, name=${payload.user.name}} — no handler configured`,
  );
}
