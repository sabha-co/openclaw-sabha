import type {
  SabhaRoom,
  SabhaMember,
  SabhaMessage,
  SabhaSearchResult,
  SabhaThreadReply,
  SabhaMessageBody,
} from "./types.js";

/**
 * HTTP client for Sabha's Bot API.
 *
 * All endpoints authenticate via bot_key in the URL path.
 * Bot key format: "{bot_id}-{bot_token}" (e.g., "42-AbCdEfGhIjKl").
 */
export class SabhaClient {
  constructor(
    private readonly baseUrl: string,
    private readonly botKey: string,
  ) {}

  // --- Messaging ---

  async sendMessage(roomId: number, text: string): Promise<number> {
    const res = await this.fetch(`/rooms/${roomId}/${this.botKey}/messages`, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: text,
    });

    // Returns 201 with Location header
    const location = res.headers.get("location");
    if (!location) return 0;
    const match = location.match(/\/messages\/(\d+)/);
    return match ? Number(match[1]) : 0;
  }

  async sendAttachment(
    roomId: number,
    file: Blob,
    filename: string,
  ): Promise<number> {
    const form = new FormData();
    form.append("attachment", file, filename);

    const res = await this.fetch(`/rooms/${roomId}/${this.botKey}/messages`, {
      method: "POST",
      body: form,
    });

    const location = res.headers.get("location");
    if (!location) return 0;
    const match = location.match(/\/messages\/(\d+)/);
    return match ? Number(match[1]) : 0;
  }

  async editMessage(
    roomId: number,
    messageId: number,
    text: string,
  ): Promise<SabhaMessageBody> {
    const res = await this.fetch(
      `/rooms/${roomId}/${this.botKey}/messages/${messageId}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "text/plain" },
        body: text,
      },
    );

    const json = (await res.json()) as { id: number; body: SabhaMessageBody };
    return json.body;
  }

  async deleteMessage(roomId: number, messageId: number): Promise<void> {
    await this.fetch(
      `/rooms/${roomId}/${this.botKey}/messages/${messageId}`,
      { method: "DELETE" },
    );
  }

  async getMessage(roomId: number, messageId: number): Promise<SabhaMessage> {
    const res = await this.fetch(
      `/rooms/${roomId}/${this.botKey}/messages/${messageId}`,
    );
    return (await res.json()) as SabhaMessage;
  }

  async getMessages(roomId: number): Promise<SabhaMessage[]> {
    const res = await this.fetch(
      `/rooms/${roomId}/${this.botKey}/messages`,
    );
    return (await res.json()) as SabhaMessage[];
  }

  async replyInThread(
    roomId: number,
    messageId: number,
    text: string,
  ): Promise<SabhaThreadReply> {
    const res = await this.fetch(
      `/rooms/${roomId}/${this.botKey}/messages/${messageId}/thread`,
      {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: text,
      },
    );
    return (await res.json()) as SabhaThreadReply;
  }

  // --- Reactions ---

  async addReaction(
    roomId: number,
    messageId: number,
    emoji: string,
  ): Promise<number> {
    const res = await this.fetch(
      `/rooms/${roomId}/${this.botKey}/messages/${messageId}/boosts`,
      {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: emoji,
      },
    );

    const json = (await res.json()) as { id: number };
    return json.id;
  }

  async removeReaction(
    roomId: number,
    messageId: number,
    boostId: number,
  ): Promise<void> {
    await this.fetch(
      `/rooms/${roomId}/${this.botKey}/messages/${messageId}/boosts/${boostId}`,
      { method: "DELETE" },
    );
  }

  // --- Rooms ---

  async listRooms(): Promise<SabhaRoom[]> {
    const res = await this.fetch(`/rooms/${this.botKey}`);
    return (await res.json()) as SabhaRoom[];
  }

  async listJoinableRooms(): Promise<SabhaRoom[]> {
    const res = await this.fetch(`/rooms/${this.botKey}?joinable=true`);
    return (await res.json()) as SabhaRoom[];
  }

  async createRoom(
    name: string,
    type: "open" | "closed",
  ): Promise<SabhaRoom> {
    const res = await this.fetch(`/rooms/${this.botKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, type }),
    });
    return (await res.json()) as SabhaRoom;
  }

  async updateRoom(roomId: number, name: string): Promise<SabhaRoom> {
    const res = await this.fetch(`/rooms/${roomId}/${this.botKey}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    return (await res.json()) as SabhaRoom;
  }

  async archiveRoom(roomId: number): Promise<void> {
    await this.fetch(`/rooms/${roomId}/${this.botKey}`, {
      method: "DELETE",
    });
  }

  async joinRoom(roomId: number): Promise<SabhaRoom> {
    const res = await this.fetch(
      `/rooms/${roomId}/${this.botKey}/membership`,
      { method: "POST" },
    );
    return (await res.json()) as SabhaRoom;
  }

  async leaveRoom(roomId: number): Promise<void> {
    await this.fetch(`/rooms/${roomId}/${this.botKey}/membership`, {
      method: "DELETE",
    });
  }

  // --- Members ---

  async listMembers(roomId: number): Promise<SabhaMember[]> {
    const res = await this.fetch(
      `/rooms/${roomId}/${this.botKey}/members`,
    );
    return (await res.json()) as SabhaMember[];
  }

  async addMember(
    roomId: number,
    userId: number,
  ): Promise<{ id: number; name: string }> {
    const res = await this.fetch(
      `/rooms/${roomId}/${this.botKey}/members`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: userId }),
      },
    );
    return (await res.json()) as { id: number; name: string };
  }

  async removeMember(roomId: number, userId: number): Promise<void> {
    await this.fetch(
      `/rooms/${roomId}/${this.botKey}/members/${userId}`,
      { method: "DELETE" },
    );
  }

  // --- DMs ---

  async createDm(userIds: number[]): Promise<{ room: { id: number } }> {
    const res = await this.fetch(`/rooms/${this.botKey}/directs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_ids: userIds }),
    });
    return (await res.json()) as { room: { id: number } };
  }

  // --- Search ---

  async search(query: string): Promise<SabhaSearchResult[]> {
    const res = await this.fetch(
      `/${this.botKey}/search?q=${encodeURIComponent(query)}`,
    );
    return (await res.json()) as SabhaSearchResult[];
  }

  // --- Bot settings ---

  async updateSettings(params: {
    name?: string;
    webhook_url?: string;
  }): Promise<void> {
    await this.fetch(`/bots/${this.botKey}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    });
  }

  // --- Internal ---

  private async fetch(path: string, init?: RequestInit): Promise<Response> {
    const url = `${this.baseUrl}${path}`;
    const res = await globalThis.fetch(url, init);

    if (!res.ok && res.status !== 201 && res.status !== 204) {
      const body = await res.text().catch(() => "");
      throw new SabhaApiError(res.status, body, url);
    }

    return res;
  }
}

export class SabhaApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
    public readonly url: string,
  ) {
    super(`Sabha API error ${status}: ${body} (${url})`);
    this.name = "SabhaApiError";
  }
}

/**
 * Extract the numeric bot ID from a bot key.
 * "42-AbCdEfGhIjKl" -> 42
 */
export function extractBotId(botKey: string): number {
  const dash = botKey.indexOf("-");
  return dash > 0 ? Number(botKey.slice(0, dash)) : 0;
}
