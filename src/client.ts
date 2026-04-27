import type {
  SabhaRoom,
  SabhaMember,
  SabhaMessage,
  SabhaSearchResult,
  SabhaThreadReply,
  SabhaMessageBody,
  SabhaUser,
} from "./types.js";
import { markdownToSabhaRichText } from "./outbound/format.js";
import {
  RETRYABLE_STATUS,
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
  /**
   * When `true`, the default retry runner logs each retry attempt at WARN.
   * Ignored when a custom `retryRunner` is supplied. Off by default so
   * production logs stay quiet; operators diagnosing a rate-limit storm
   * can flip it on per-account without touching the SDK runtime.
   */
  verbose?: boolean;
  /**
   * Optional pre-processor that rewrites `@DisplayName` to `@{user_id}`
   * before the text is converted to Trix HTML. Populated from inbound
   * events' `user.id` + `user.name` so the rewriter knows every user
   * the bot has seen. See `src/outbound/mention-rewrite.ts`.
   */
  mentionRewriter?: (text: string) => string;
};

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/**
 * HTTP client for Sabha's Bot API.
 *
 * All endpoints authenticate via `Authorization: Bearer <bot_key>`.
 * Bot key format: "{bot_id}-{bot_token}" (e.g., "42-AbCdEfGhIjKl").
 * `apiBaseUrl` is the full bot-API base (e.g. `https://…/api/bots`) as
 * returned in the registration response — path templates below are
 * suffixes appended to it.
 */
export class SabhaClient {
  private readonly abortSignal?: AbortSignal;
  private readonly requestTimeoutMs: number;
  private readonly retryRunner: RetryRunner;
  private readonly mentionRewriter?: (text: string) => string;

  constructor(
    private readonly apiBaseUrl: string,
    private readonly botKey: string,
    opts: SabhaClientOpts = {},
  ) {
    this.abortSignal = opts.abortSignal;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.mentionRewriter = opts.mentionRewriter;
    this.retryRunner =
      opts.retryRunner ??
      createSabhaRetryRunner(
        opts.verbose != null ? { verbose: opts.verbose } : {},
      );
  }

  /** Run mention rewriter (if configured) then markdown→Trix converter. */
  private toRichText(text: string): string {
    const rewritten = this.mentionRewriter ? this.mentionRewriter(text) : text;
    return markdownToSabhaRichText(rewritten);
  }

  // --- Messaging ---

  /**
   * Send a markdown message to a Sabha room.
   *
   * The `text` argument is treated as markdown and converted to Sabha's
   * ActionText / Trix HTML subset via `markdownToSabhaRichText` before the
   * POST. Sabha stores message bodies as rich text via `has_rich_text :body`
   * — every wire-level write has to be Trix-compatible HTML, and that's a
   * wire fact the client owns alongside authentication and URL shape.
   */
  async sendMessage(roomId: number, text: string): Promise<number | null> {
    const body = this.toRichText(text);
    const res = await this.fetch(`/rooms/${roomId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body,
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

    const res = await this.fetch(`/rooms/${roomId}/messages`, {
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

  /**
   * Edit an existing message. `text` is treated as markdown and converted
   * to Trix HTML before the PATCH, same as `sendMessage`. This is the only
   * edit entry point (draft-stream.ts uses it for streaming previews), so
   * the converter must run here too.
   */
  async editMessage(
    roomId: number,
    messageId: number,
    text: string,
  ): Promise<SabhaMessageBody> {
    const body = this.toRichText(text);
    const res = await this.fetch(
      `/rooms/${roomId}/messages/${messageId}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "text/plain" },
        body,
      },
    );

    const json = (await res.json()) as { id: number; body: SabhaMessageBody };
    return json.body;
  }

  async deleteMessage(roomId: number, messageId: number): Promise<void> {
    await this.fetch(
      `/rooms/${roomId}/messages/${messageId}`,
      { method: "DELETE" },
    );
  }

  async getMessage(roomId: number, messageId: number): Promise<SabhaMessage> {
    const res = await this.fetch(
      `/rooms/${roomId}/messages/${messageId}`,
    );
    return (await res.json()) as SabhaMessage;
  }

  async getMessages(roomId: number): Promise<SabhaMessage[]> {
    const res = await this.fetch(
      `/rooms/${roomId}/messages`,
    );
    return (await res.json()) as SabhaMessage[];
  }

  /**
   * Post a reply inside a message's thread. `text` is treated as markdown
   * and converted to Trix HTML before the POST, same as `sendMessage`.
   */
  async replyInThread(
    roomId: number,
    messageId: number,
    text: string,
  ): Promise<SabhaThreadReply> {
    const body = this.toRichText(text);
    const res = await this.fetch(
      `/rooms/${roomId}/messages/${messageId}/thread`,
      {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body,
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
      `/rooms/${roomId}/messages/${messageId}/boosts`,
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
      `/rooms/${roomId}/messages/${messageId}/boosts/${boostId}`,
      { method: "DELETE" },
    );
  }

  // --- Rooms ---

  async listRooms(): Promise<SabhaRoom[]> {
    const res = await this.fetch(`/rooms`);
    return (await res.json()) as SabhaRoom[];
  }

  async listJoinableRooms(): Promise<SabhaRoom[]> {
    const res = await this.fetch(`/rooms?joinable=true`);
    return (await res.json()) as SabhaRoom[];
  }

  async createRoom(
    name: string,
    type: "open" | "closed",
  ): Promise<SabhaRoom> {
    const res = await this.fetch(`/rooms`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, type }),
    });
    return (await res.json()) as SabhaRoom;
  }

  async updateRoom(roomId: number, name: string): Promise<SabhaRoom> {
    const res = await this.fetch(`/rooms/${roomId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    return (await res.json()) as SabhaRoom;
  }

  async archiveRoom(roomId: number): Promise<void> {
    await this.fetch(`/rooms/${roomId}`, {
      method: "DELETE",
    });
  }

  async joinRoom(roomId: number): Promise<SabhaRoom> {
    const res = await this.fetch(
      `/rooms/${roomId}/membership`,
      { method: "POST" },
    );
    return (await res.json()) as SabhaRoom;
  }

  async leaveRoom(roomId: number): Promise<void> {
    await this.fetch(`/rooms/${roomId}/membership`, {
      method: "DELETE",
    });
  }

  // --- Members ---

  async listMembers(roomId: number): Promise<SabhaMember[]> {
    const res = await this.fetch(
      `/rooms/${roomId}/members`,
    );
    return (await res.json()) as SabhaMember[];
  }

  async addMember(
    roomId: number,
    userId: number,
  ): Promise<{ id: number; name: string }> {
    const res = await this.fetch(
      `/rooms/${roomId}/members`,
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
      `/rooms/${roomId}/members/${userId}`,
      { method: "DELETE" },
    );
  }

  // --- Users (directory) ---

  /**
   * List users reachable to this bot (i.e. sharing at least one room with it),
   * paginated. When `roomId` is set, scopes to that room's members. Server
   * caps `perPage` at 100 and clamps `page` to >= 1; we forward whatever
   * the caller passes and let the server enforce.
   *
   * Server route: `GET /api/bots/users[?room_id=&page=&per_page=]`.
   */
  async listUsers(opts?: {
    roomId?: number;
    page?: number;
    perPage?: number;
  }): Promise<SabhaUser[]> {
    const params = new URLSearchParams();
    if (opts?.roomId != null) params.set("room_id", String(opts.roomId));
    if (opts?.page != null) params.set("page", String(opts.page));
    if (opts?.perPage != null) params.set("per_page", String(opts.perPage));
    const qs = params.toString();
    const res = await this.fetch(`/users${qs ? `?${qs}` : ""}`);
    return (await res.json()) as SabhaUser[];
  }

  /**
   * Autocompletable user search — server-side fast path designed for
   * autocomplete UX (limit 20). When `query` is set, server runs
   * `User.matching` (prefix-style match). Otherwise returns recent posters
   * for the room (when `roomId` set) or the default ordered list.
   *
   * Server route: `GET /api/bots/autocompletable/users[?query=&room_id=]`.
   */
  async searchUsers(opts?: {
    query?: string;
    roomId?: number;
  }): Promise<SabhaUser[]> {
    const params = new URLSearchParams();
    if (opts?.query) params.set("query", opts.query);
    if (opts?.roomId != null) params.set("room_id", String(opts.roomId));
    const qs = params.toString();
    const res = await this.fetch(
      `/autocompletable/users${qs ? `?${qs}` : ""}`,
    );
    return (await res.json()) as SabhaUser[];
  }

  // --- DMs ---

  async createDm(userIds: number[]): Promise<{ room: { id: number } }> {
    const res = await this.fetch(`/direct_messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_ids: userIds }),
    });
    return (await res.json()) as { room: { id: number } };
  }

  // --- Search ---

  async search(query: string): Promise<SabhaSearchResult[]> {
    const res = await this.fetch(
      `/search?q=${encodeURIComponent(query)}`,
    );
    return (await res.json()) as SabhaSearchResult[];
  }

  // --- Bot settings ---

  async updateSettings(params: {
    name?: string;
    webhook_url?: string;
  }): Promise<void> {
    await this.fetch(`/profile`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    });
  }

  // --- Internal ---

  private async fetch(path: string, init?: RequestInit): Promise<Response> {
    const url = `${this.apiBaseUrl}${path}`;
    const method = init?.method ?? "GET";
    return await this.retryRunner(async () => {
      // Rebuild the combined signal on each attempt so a previous attempt's
      // timeout doesn't leak into the retried request.
      const signal = this.combineSignals(init?.signal ?? undefined);
      const headers = new Headers(init?.headers);
      headers.set("Authorization", `Bearer ${this.botKey}`);
      const res = await globalThis.fetch(url, { ...init, headers, signal });
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
  /**
   * Whether the retry runner will attempt this error again. Mirrors
   * `isRetryableSabhaError` so callers can branch on the flag instead of
   * re-importing the predicate. True for 429/502/503/504, false otherwise.
   */
  public readonly retryable: boolean;

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
    this.retryable = RETRYABLE_STATUS.has(status);
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
