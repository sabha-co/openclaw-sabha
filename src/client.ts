import type {
  SabhaRoom,
  SabhaMember,
  SabhaMessage,
  SabhaSearchResult,
  SabhaThreadReply,
  SabhaMessageBody,
} from "./types.js";
import {
  createSabhaRetryRunner,
  parseRetryAfter,
  type RetryRunner,
} from "./retry.js";

export type SabhaClientOpts = {
  /**
   * Signal shared by every request this client issues. Aborting it cancels
   * all in-flight fetches so the owning monitor can drain cleanly on shutdown.
   */
  abortSignal?: AbortSignal;
  /**
   * Per-request deadline. Defaults to 30s. A hung server must never wedge
   * the inbound pipeline — `processInboundMessage` awaits `sendMessage`
   * inline on the WebSocket handler, so every call needs a bounded wait.
   */
  requestTimeoutMs?: number;
  /**
   * Retry runner wrapping every HTTP call. Defaults to the Sabha rate-limit
   * runner, which honors `Retry-After` on 429 and retries 502/503/504 with
   * exponential backoff + jitter. Pass a custom runner in tests.
   */
  retryRunner?: RetryRunner;
};

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/**
 * HTTP client for Sabha's Bot API.
 *
 * All endpoints authenticate via bot_key in the URL path.
 * Bot key format: "{bot_id}-{bot_token}" (e.g., "42-AbCdEfGhIjKl").
 */
export class SabhaClient {
  private readonly abortSignal?: AbortSignal;
  private readonly requestTimeoutMs: number;
  private readonly retryRunner: RetryRunner;

  constructor(
    private readonly baseUrl: string,
    private readonly botKey: string,
    opts: SabhaClientOpts = {},
  ) {
    this.abortSignal = opts.abortSignal;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.retryRunner = opts.retryRunner ?? createSabhaRetryRunner();
  }

  // --- Messaging ---

  async sendMessage(roomId: number, text: string): Promise<number | null> {
    const res = await this.fetch(`/rooms/${roomId}/${this.botKey}/messages`, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: text,
    });

    return this.extractMessageId(res);
  }

  async sendAttachment(
    roomId: number,
    file: Blob,
    filename: string,
  ): Promise<number | null> {
    const form = new FormData();
    form.append("attachment", file, filename);

    const res = await this.fetch(`/rooms/${roomId}/${this.botKey}/messages`, {
      method: "POST",
      body: form,
    });

    return this.extractMessageId(res);
  }

  private extractMessageId(res: Response): number | null {
    const location = res.headers.get("location");
    if (!location) return null;
    const match = location.match(/\/messages\/(\d+)/);
    return match ? Number(match[1]) : null;
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
    const method = init?.method ?? "GET";
    return await this.retryRunner(async () => {
      // Rebuild the combined signal on each attempt so a previous attempt's
      // timeout doesn't leak into the retried request.
      const signal = this.combineSignals(init?.signal ?? undefined);
      const res = await globalThis.fetch(url, { ...init, signal });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        const retryAfterMs = parseRetryAfter(res.headers.get("retry-after"));
        throw new SabhaApiError(res.status, body, url, retryAfterMs);
      }
      return res;
    }, `${method} ${path}`);
  }

  private combineSignals(external?: AbortSignal): AbortSignal {
    const timeout = AbortSignal.timeout(this.requestTimeoutMs);
    const sources = [timeout, this.abortSignal, external].filter(
      (s): s is AbortSignal => s !== undefined,
    );
    if (sources.length === 1) return sources[0];

    const ctrl = new AbortController();
    const forward = (source: AbortSignal) => {
      if (ctrl.signal.aborted) return;
      ctrl.abort(source.reason);
    };
    for (const source of sources) {
      if (source.aborted) {
        forward(source);
        return ctrl.signal;
      }
      source.addEventListener("abort", () => forward(source), { once: true });
    }
    return ctrl.signal;
  }
}

export class SabhaApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
    public readonly url: string,
    /**
     * Milliseconds the server asked us to wait before retrying (parsed from
     * the `Retry-After` response header). Present on 429/503 responses when
     * Sabha supplies a backpressure hint; read by the retry runner's
     * `retryAfterMs` callback.
     */
    public readonly retryAfterMs?: number,
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
