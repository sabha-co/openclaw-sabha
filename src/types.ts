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

export type SabhaWebhookEvent =
  | "message_created"
  | "message_updated"
  | "message_deleted"
  | "boost_created"
  | "user_created";

export type SabhaWebhookUser = {
  id: number;
  name: string;
  role: string;
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

export type SabhaWebhookPayload = {
  event: SabhaWebhookEvent;
  user: SabhaWebhookUser;
  room: SabhaWebhookRoom;
  message: SabhaWebhookMessage;
  boost?: { id: number; body: string };
};

// Plugin config

export type SabhaConfig = {
  enabled?: boolean;
  baseUrl: string;
  botKey: string;
  webhookPort?: number;
  connectionMode?: "websocket" | "webhook";
  websocketUrl?: string;
  dmPolicy?: "open" | "allowlist";
  allowFrom?: string[];
};

export type SabhaAccount = {
  accountId: string | null;
  baseUrl: string;
  botKey: string;
  botId: number;
  webhookPort: number;
  connectionMode: "websocket" | "webhook";
  websocketUrl: string;
  dmPolicy: "open" | "allowlist";
  allowFrom: string[];
};

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
  connected: boolean;
  lastConnectedAt?: number;
  lastError?: string | null;
  lastDisconnect?: { at: number; status?: number; error?: string };
};
