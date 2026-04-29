// Sabha Bot API types


export type SabhaRoom = {
  id: number;
  name: string;
  type: SabhaRoomType;
  messages_url: string;
};

export type SabhaMember = {
  id: number;
  name: string;
  role: "administrator" | "moderator" | "member" | "bot";
};

/**
 * User entry returned by `GET /api/bots/users` and the autocompletable
 * variant. Server JSON shape (per `app/views/api/bots/users/_user.json.jbuilder`):
 * `{ id, name, role, bot, url }`. Scoped server-side to "users sharing rooms
 * with the bot" — narrower than a workspace user list, but the right scope
 * for an agent-visible directory: rooms the bot can't reach are filtered
 * out, so every returned user is potentially DM-able or already a peer in
 * a shared room.
 */
export type SabhaUser = {
  id: number;
  name: string;
  role: SabhaMember["role"];
  bot: boolean;
  url: string;
};

/**
 * Rich user profile returned by `GET /api/bots/users/:id` (the `show`
 * endpoint). Adds bio + three optional social URL fields on top of the
 * standard SabhaUser shape — see `app/views/api/bots/users/show.json.jbuilder`.
 * The server treats unset fields as `null`; we keep them nullable here
 * so the type matches the wire shape directly.
 */
export type SabhaUserDetail = SabhaUser & {
  bio: string | null;
  twitter_url: string | null;
  linkedin_url: string | null;
  personal_url: string | null;
};

export type SabhaMessageBody = {
  html: string;
  plain: string;
};

export type SabhaAttachment = {
  url: string;
  filename: string;
  content_type: string;
  byte_size: number;
};

export type SabhaThreadInfo = {
  id: number;
  parent_message_id: number;
};

export type SabhaSearchResult = {
  id: number;
  creator: { id: number; name: string };
  body: SabhaMessageBody;
  room: { id: number; name: string };
  created_at: string;
};

/**
 * Envelope returned by `client.search`. `nextCursor` is a composite
 * `"<iso>|<id>"` token the server emits — opaque to the plugin, just
 * passed back on the next call. `hasMore` is the explicit truncation
 * signal the agent reads to decide between refining the query and
 * paginating.
 */
export type SabhaSearchResponse = {
  results: SabhaSearchResult[];
  hasMore: boolean;
  nextCursor: string | null;
};

/**
 * Single message returned by `GET /api/bots/rooms/:id/messages` (the bot
 * `index` endpoint added in `sabha-co/sabha#50`). Wire shape mirrors
 * `app/views/api/bots/messages/_message.json.jbuilder` — note that `index`
 * deliberately omits `mentionees` and `has_attachment` (kept on `show`).
 */
export type SabhaReadMessage = {
  id: number;
  creator: { id: number; name: string };
  body: SabhaMessageBody;
  attachment: SabhaAttachment | null;
  created_at: string;
};

/**
 * Cursor-paginated read response. Same envelope shape as `SabhaSearchResponse`
 * — same dual-purpose `before` URL parameter on the server (`controllers/
 * concerns/cursor_paginated.rb`), so `nextCursor` walks via `before` not a
 * separate URL param.
 */
export type SabhaReadMessagesResponse = {
  results: SabhaReadMessage[];
  hasMore: boolean;
  nextCursor: string | null;
};

/**
 * One reaction group from `GET /api/bots/rooms/:id/messages/:msg_id/boosts`.
 * `boosters` is server-capped at 100 (`BOOSTERS_CAP` in
 * `boosts_controller.rb`); `truncated` indicates the cap was hit for this
 * specific reaction.
 */
export type SabhaReaction = {
  content: string;
  count: number;
  boosters: { id: number; name: string }[];
  truncated: boolean;
};

/**
 * Aggregated reactions response. Server sorts groups `count DESC,
 * MIN(created_at) ASC` and caps at 50 distinct emoji (`REACTIONS_CAP`).
 * `total` is the sum across every reaction (including ones the cap clipped).
 */
export type SabhaReactionsResponse = {
  reactions: SabhaReaction[];
  total: number;
  truncated: boolean;
};

// Webhook payload from Sabha to bot
//
// Sabha's `BotEventsChannel` fans out nine event types (see Scout A
// findings). The payload shape varies by event — message/boost events
// carry `room` and `message`, while `user_*` events are scoped globally
// and carry ONLY `user`. Model as a discriminated union on `event` so
// TypeScript forces callers to narrow before touching optional fields.

export type SabhaWebhookEvent =
  | "message_created"
  | "message_updated"
  | "message_deleted"
  | "boost_created"
  | "boost_deleted"
  | "user_created"
  | "user_deleted";

export type SabhaWebhookUser = {
  id: number;
  name: string;
  // Tightened from `string` so callers can exhaustively switch on role
  // without runtime guards. Matches `SabhaMember.role`.
  role: SabhaMember["role"];
  url: string;
};

export type SabhaRoomType = "Open" | "Closed" | "Direct" | "Thread";

export type SabhaWebhookRoom = {
  id: number;
  name: string;
  type: SabhaRoomType;
  members: number;
  has_bot: boolean;
  messages_url: string;
};

export type SabhaWebhookMessage = {
  id: number;
  body: SabhaMessageBody;
  has_attachment: boolean;
  attachment: SabhaAttachment | null;
  mentionees: Array<{ id: number; name: string }>;
  url: string;
  created_at: string;
  updated_at: string;
  thread: SabhaThreadInfo | null;
};

export type SabhaMessageCreatedPayload = {
  event: "message_created";
  user: SabhaWebhookUser;
  room: SabhaWebhookRoom;
  message: SabhaWebhookMessage;
};

export type SabhaMessageUpdatedPayload = {
  event: "message_updated";
  user: SabhaWebhookUser;
  room: SabhaWebhookRoom;
  message: SabhaWebhookMessage;
};

export type SabhaMessageDeletedPayload = {
  event: "message_deleted";
  user: SabhaWebhookUser;
  room: SabhaWebhookRoom;
  message: SabhaWebhookMessage;
};

export type SabhaBoostCreatedPayload = {
  event: "boost_created";
  user: SabhaWebhookUser;
  room: SabhaWebhookRoom;
  message: SabhaWebhookMessage;
  boost: { id: number; body: string };
};

export type SabhaBoostDeletedPayload = {
  event: "boost_deleted";
  user: SabhaWebhookUser;
  room: SabhaWebhookRoom;
  message: SabhaWebhookMessage;
  boost: { id: number; body: string };
};

// `user_*` events fan out globally across every active bot in the
// workspace (notify_bots.rb:19-24) and explicitly do NOT carry a room
// or message — they are bare-user notifications. See the privacy
// invariant on the `handleUserCreated` / `handleUserDeleted` stubs
// in `./inbound.ts` before wiring these to any agent-visible surface.
export type SabhaUserCreatedPayload = {
  event: "user_created";
  user: SabhaWebhookUser;
};

export type SabhaUserDeletedPayload = {
  event: "user_deleted";
  user: SabhaWebhookUser;
};

export type SabhaWebhookPayload =
  | SabhaMessageCreatedPayload
  | SabhaMessageUpdatedPayload
  | SabhaMessageDeletedPayload
  | SabhaBoostCreatedPayload
  | SabhaBoostDeletedPayload
  | SabhaUserCreatedPayload
  | SabhaUserDeletedPayload;

/**
 * Subset of `SabhaWebhookPayload` that carries a `room` and `message`
 * (every event except `user_*`). Inbound helpers that read message
 * content should accept this narrower type so TypeScript narrows
 * correctly at every call site.
 */
export type SabhaMessageEventPayload =
  | SabhaMessageCreatedPayload
  | SabhaMessageUpdatedPayload
  | SabhaMessageDeletedPayload
  | SabhaBoostCreatedPayload
  | SabhaBoostDeletedPayload;

// Per-room config (operator-defined, keyed by room id)

export type SabhaRoomConfig = {
  systemPrompt?: string;
};

// Plugin config

export type SabhaConfig = {
  enabled?: boolean;
  // Shared base fields that per-account overrides in `accounts` layer onto.
  baseUrl?: string;
  // Bot API base (e.g. `https://sabha.co/1000006/api/bots`). Returned by
  // the server's registration response; `baseUrl` is the site root used by
  // the setup wizard's `/skill` URL-verification probe, while every
  // bearer-auth HTTP call goes through `apiBaseUrl`.
  apiBaseUrl?: string;
  botKey?: string;
  botName?: string;
  websocketUrl?: string;
  typingEnabled?: boolean;
  dmPolicy?: "open" | "allowlist";
  allowFrom?: string[];
  // Opt out of strict SSRF filtering on attachment downloads and outbound
  // media fetches. Only set this in corporate / split-horizon DNS setups
  // that legitimately need to fetch from RFC1918 addresses.
  allowPrivateAttachmentHosts?: boolean;
  replyToMode?: "off" | "first" | "all";
  // Per-room config. Keys are room ids (as strings). Used for
  // per-room system prompts that customize agent behavior.
  rooms?: Record<string, SabhaRoomConfig>;
  // Multi-account map. Each entry is a per-account override layered over
  // the base fields above. Canonical SDK key — matches Feishu / Slack /
  // Discord.
  accounts?: Record<string, Partial<Omit<SabhaConfig, "accounts" | "defaultAccount">>>;
  defaultAccount?: string;
};

export type { ResolvedSabhaAccount } from "./accounts.js";

// --- Delivery payload (from reply pipeline to deliver callback) ---

export type DeliveryPayload = {
  to?: string;
  text?: string;
  body?: string;
  threadId?: string;
  replyToId?: string;
};

// --- WebSocket connection status ---

export type ConnectionStatus = {
  connected?: boolean;
  lastConnectedAt?: number;
  lastError?: string | null;
  lastInboundAt?: number;
  lastDisconnect?: { at: number; status?: number; error?: string };
};
