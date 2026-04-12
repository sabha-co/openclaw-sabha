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

export type SabhaMessage = {
  id: number;
  creator: { id: number; name: string };
  body: SabhaMessageBody;
  has_attachment: boolean;
  attachment: SabhaAttachment | null;
  mentionees: Array<{ id: number; name: string }>;
  created_at: string;
};

export type SabhaThreadInfo = {
  id: number;
  parent_message_id: number;
};

export type SabhaThreadReply = {
  thread: SabhaThreadInfo;
  message: { id: number };
};

export type SabhaSearchResult = {
  id: number;
  creator: { id: number; name: string };
  body: SabhaMessageBody;
  room: { id: number; name: string };
  created_at: string;
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

// Plugin config

export type SabhaConfig = {
  enabled?: boolean;
  // Shared base fields that per-bot overrides in `botAccounts` layer onto.
  baseUrl?: string;
  botKey?: string;
  botName?: string;
  webhookPort?: number;
  connectionMode?: "websocket" | "webhook";
  websocketUrl?: string;
  typingEnabled?: boolean;
  dmPolicy?: "open" | "allowlist";
  allowFrom?: string[];
  // Opt out of strict SSRF filtering on attachment downloads and outbound
  // media fetches. Only set this in corporate / split-horizon DNS setups
  // that legitimately need to fetch from RFC1918 addresses.
  allowPrivateAttachmentHosts?: boolean;
  // Multi-bot-account map. Each entry is a per-bot override layered over
  // the base fields above.
  botAccounts?: Record<string, Partial<Omit<SabhaConfig, "botAccounts" | "defaultBotAccount">>>;
  defaultBotAccount?: string;
};

export type { ResolvedBotAccount } from "./bot-accounts.js";

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
