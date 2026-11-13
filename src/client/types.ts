// Sabha wire shapes (sabha-ai /api/v1 and AppEventsChannel). Ids are numbers on
// the wire; only the plugin's host-facing results stringify them.

export type SabhaUserRef = { id: number; name: string };

export type SabhaUser = SabhaUserRef & { role?: string; bot?: boolean; url?: string };

export type SabhaUserDetail = SabhaUser & {
  bio?: string | null;
  twitter_url?: string | null;
  linkedin_url?: string | null;
  personal_url?: string | null;
};

/** "Open" | "Closed" | "Direct" | "Thread" | "Forum" | "Post" | … */
export type SabhaRoomType = string;

export type SabhaRoom = { id: number; name: string | null; type: SabhaRoomType; messages_url?: string };

export type SabhaBody = { html: string; plain: string; markdown: string };

export type SabhaAttachment = { url: string; filename: string; content_type: string; byte_size: number };

export type SabhaThreadRef = { id: number; parent_message_id: number; parent_room_id: number };

/** A message as `GET /rooms/:id/messages` and `GET /messages/:id` return it. */
export type SabhaMessage = {
  id: number;
  creator: SabhaUserRef;
  body: SabhaBody;
  attachment: SabhaAttachment | null;
  room_id: number;
  thread: SabhaThreadRef | null;
  url: string;
  created_at: string;
  mentionees?: SabhaUserRef[];
};

export type SabhaPage<T> = { results: T[]; hasMore: boolean; nextCursor: string | null };

export type SabhaSearchResult = {
  id: number;
  creator: SabhaUserRef;
  body: SabhaBody;
  room: { id: number; name: string | null };
  created_at: string;
};

export type SabhaReactionGroup = { content: string; count: number; users: SabhaUserRef[]; truncated: boolean };

export type SabhaReactions = { reactions: SabhaReactionGroup[]; total: number; truncated: boolean };

export type SabhaSent = { id: number; roomId: number };

// --- AppEventsChannel ---

export type SabhaEventRoom = { id: number; name: string | null; type: SabhaRoomType; has_app?: boolean; members?: number };

export type SabhaEventUser = SabhaUserRef & { role?: string; url?: string };

export type SabhaEventMessage = {
  id: number;
  body: SabhaBody;
  attachment: SabhaAttachment | null;
  has_attachment?: boolean;
  mentionees?: SabhaUserRef[];
  thread: SabhaThreadRef | null;
  url?: string;
  created_at?: string;
  updated_at?: string;
};

export type SabhaMessageEvent = {
  event: "message_created" | "message_updated" | "message_deleted";
  mentions_app?: boolean;
  message: SabhaEventMessage;
  room: SabhaEventRoom;
  user: SabhaEventUser;
};

export type SabhaReactionEvent = {
  event: "reaction_created" | "reaction_deleted";
  reaction: { id: number; body: string };
  message: SabhaEventMessage;
  room: SabhaEventRoom;
  user: SabhaEventUser;
};

export type SabhaUserEvent = { event: "user_created" | "user_deleted"; user: SabhaEventUser };

/** A member ran one of the app's slash commands; the text they typed is never posted. */
export type SabhaCommandEvent = {
  event: "command";
  id: string;
  /** With its slash: `/new`. */
  command: string;
  /** What followed the command, mentions written `<@user_id>`. */
  text: string;
  user_id: number;
  user_name: string;
  /** The thread room, when run in a thread. */
  room_id: number;
  room_name: string | null;
  thread?: SabhaThreadRef;
  response_url: string;
};

/** One slash command as `PUT /profile/commands` takes it. */
export type SabhaCommandDeclaration = { name: string; description: string; usage_hint?: string };

export type SabhaAppEvent =
  | SabhaMessageEvent
  | SabhaReactionEvent
  | SabhaUserEvent
  | SabhaCommandEvent
  | { event: string; [key: string]: unknown };

/** Draft frames the plugin sends on AppEventsChannel (`draft` action). */
export type SabhaDraftFrame =
  | { kind: "start"; draft_id: string; room_id: number; parent_message_id?: number }
  | { kind: "text"; draft_id: string; room_id: number; parent_message_id?: number; text: string; seq: number }
  | { kind: "activity"; draft_id: string; room_id: number; parent_message_id?: number; title: string; seq: number }
  | { kind: "end"; draft_id: string; room_id: number; parent_message_id?: number };
