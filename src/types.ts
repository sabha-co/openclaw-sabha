// Sabha Bot API types

export type SabhaRoom = {
  id: number;
  name: string;
  type: "Open" | "Closed" | "Direct" | "Thread";
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

export type SabhaWebhookRoom = {
  id: number;
  name: string;
  type: string;
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
  dmPolicy?: "open" | "allowlist";
  allowFrom?: string[];
};

export type SabhaAccount = {
  accountId: string | null;
  baseUrl: string;
  botKey: string;
  botId: number;
  webhookPort: number;
  dmPolicy: string;
  allowFrom: string[];
};
