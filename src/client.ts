import type {
  SabhaRoom,
  SabhaReaction,
  SabhaReactionsResponse,
  SabhaReadMessage,
  SabhaReadMessagesResponse,
  SabhaSearchResponse,
  SabhaSearchResult,
  SabhaMessageBody,
  SabhaUser,
  SabhaUserDetail,
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
   *
   * **Inline thread-reply.** When `opts.parentMessageId` is set, the server
   * routes the message into the parent's thread room (creating it via
   * `Rooms::Thread.find_or_create_for` if needed) and returns a JSON body
   * `{ id, room_id }` so the caller knows where the message landed. Without
   * `parentMessageId` the server keeps the legacy `head :created` shape with
   * just a `Location` header; the resolved room is the input `roomId`. Both
   * cases come back through this method as the uniform `{ id, roomId }`
   * tuple so callers don't have to branch on threading. The wire transport
   * for `parentMessageId` is a query string parameter, not a JSON body —
   * Sabha's POST /messages reads the request body as raw markdown.
   *
   * Returns `null` when neither the response body nor the Location header
   * yields a usable message id (network drop, malformed response).
   */
  async sendMessage(
    roomId: number,
    text: string,
    opts?: { parentMessageId?: number },
  ): Promise<{ id: number; roomId: number } | null> {
    const body = this.toRichText(text);
    const path =
      opts?.parentMessageId != null
        ? `/rooms/${roomId}/messages?parent_message_id=${opts.parentMessageId}`
        : `/rooms/${roomId}/messages`;
    const res = await this.fetch(path, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body,
    });

    return this.parseSendResponse(res);
  }

  async sendAttachment(
    roomId: number,
    file: Blob,
    filename: string,
  ): Promise<{ id: number; roomId: number } | null> {
    const form = new FormData();
    form.append("attachment", file, filename);

    const res = await this.fetch(`/rooms/${roomId}/messages`, {
      method: "POST",
      body: form,
    });

    return this.parseSendResponse(res);
  }

  /**
   * Read the `{ id, roomId }` tuple from a `POST /messages` response. The
   * server always returns `{ id, room_id }` in the body — for non-thread
   * sends `room_id` matches the URL room, for thread sends it's the
   * resolved thread room. `null` covers the rare case where the body
   * doesn't parse (network drop, malformed response).
   */
  private async parseSendResponse(
    res: Response,
  ): Promise<{ id: number; roomId: number } | null> {
    const json = (await res.json()) as { id?: number; room_id?: number };
    if (typeof json.id !== "number" || typeof json.room_id !== "number") {
      return null;
    }
    return { id: json.id, roomId: json.room_id };
  }

  /**
   * Edit an existing message. `text` is treated as markdown and converted
   * to Trix HTML before the PATCH, same as `sendMessage`. This is the only
   * edit entry point (draft-stream.ts uses it for streaming previews), so
   * the converter must run here too.
   *
   * Uses the id-only wire path `PATCH /messages/:id` — the server resolves
   * the room from the message and authorizes via the bot's room access. No
   * room id needs to flow through callers, which means streaming clients
   * don't have to track room rebinds across thread creates. See
   * `docs/plans/ID-ONLY-CLIENT-MIGRATION-PLAN.md`.
   */
  async editMessage(
    messageId: number,
    text: string,
  ): Promise<SabhaMessageBody> {
    const body = this.toRichText(text);
    const res = await this.fetch(
      `/messages/${messageId}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "text/plain" },
        body,
      },
    );

    const json = (await res.json()) as { id: number; body: SabhaMessageBody };
    return json.body;
  }

  async deleteMessage(messageId: number): Promise<void> {
    await this.fetch(
      `/messages/${messageId}`,
      { method: "DELETE" },
    );
  }

  /**
   * Cursor-paginated room history. Same envelope shape as `search` (results
   * + has_more + next_cursor) and the same dual-purpose `before` URL
   * parameter — the server's `parse_pagination_params` is shared between
   * `MessagesController#index` and `SearchesController#show`.
   *
   * Newest-first ordering server-side (`reorder(created_at: :desc, id: :desc)`).
   * Default `limit=50`, server clamp `max=200` (`CursorPaginated::MAX_LIMIT`).
   * A malformed `before` (unparseable iso, or composite with non-integer id)
   * returns 422 `validation_failed`, surfaced as `SabhaApiError`.
   *
   * Cursor walk semantics: when `cursor` is supplied, the server uses it
   * as the anchor and continues from that point. The plugin sends `cursor`
   * via the wire's `before` URL param since the server has no separate
   * `cursor` URL param for this endpoint.
   */
  async readMessages(opts: {
    roomId: number;
    before?: string;
    after?: string;
    limit?: number;
    cursor?: string;
  }): Promise<SabhaReadMessagesResponse> {
    const params = new URLSearchParams();
    const beforeParam = opts.cursor ?? opts.before;
    if (beforeParam) params.set("before", beforeParam);
    if (opts.after) params.set("after", opts.after);
    if (opts.limit != null) params.set("limit", String(opts.limit));
    const qs = params.toString();
    const path = qs
      ? `/rooms/${opts.roomId}/messages?${qs}`
      : `/rooms/${opts.roomId}/messages`;
    const res = await this.fetch(path);
    return parseReadMessagesResponse((await res.json()) as unknown);
  }

  // --- Reactions ---

  /**
   * Aggregated reactions on a single message. Server returns groups sorted
   * `count DESC, MIN(created_at) ASC` with boosters within a group oldest-first.
   * Capped at 50 distinct emoji and 100 boosters per emoji
   * (`REACTIONS_CAP` / `BOOSTERS_CAP` in `boosts_controller.rb`).
   *
   * Id-only on the wire — server resolves the room from the message id and
   * authorizes via the bot's room access. 404 surfaces as `SabhaApiError`
   * and is indistinguishable between "message not visible to bot,"
   * "message never existed," and "message was deleted" — the server scopes
   * through the bot's rooms plus `messages.active`, collapsing all three
   * failure modes into one wire shape.
   */
  async listReactions(messageId: number): Promise<SabhaReactionsResponse> {
    const res = await this.fetch(`/messages/${messageId}/boosts`);
    return parseReactionsResponse((await res.json()) as unknown);
  }

  async addReaction(messageId: number, emoji: string): Promise<number> {
    const res = await this.fetch(
      `/messages/${messageId}/boosts`,
      {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: emoji,
      },
    );

    const json = (await res.json()) as { id: number };
    return json.id;
  }

  async removeReaction(messageId: number, boostId: number): Promise<void> {
    await this.fetch(
      `/messages/${messageId}/boosts/${boostId}`,
      { method: "DELETE" },
    );
  }

  // --- Rooms ---

  /**
   * List rooms reachable to this bot, paginated. `joinable: true` filters
   * to open rooms the bot could join (but isn't in yet); `query` runs a
   * server-side name match. Server caps `perPage` at 100 and clamps
   * `page` to >= 1; we forward whatever the caller passes and let the
   * server enforce.
   *
   * `joinable` is intentionally typed as `true | undefined` rather than
   * `boolean`. The server treats absence as "all rooms" already; sending
   * `joinable=false` would either be ignored or, worse, treated as
   * "non-joinable" — the type narrows to express the asymmetry.
   *
   * Server route: `GET /api/bots/rooms[?joinable=&query=&page=&per_page=]`.
   */
  async listRooms(opts?: {
    joinable?: true;
    query?: string;
    page?: number;
    perPage?: number;
  }): Promise<SabhaRoom[]> {
    const params = new URLSearchParams();
    if (opts?.joinable) params.set("joinable", "true");
    if (opts?.query) params.set("query", opts.query);
    if (opts?.page != null) params.set("page", String(opts.page));
    if (opts?.perPage != null) params.set("per_page", String(opts.perPage));
    const qs = params.toString();
    const res = await this.fetch(`/rooms${qs ? `?${qs}` : ""}`);
    return (await res.json()) as SabhaRoom[];
  }

  async joinRoom(roomId: number): Promise<SabhaRoom> {
    const res = await this.fetch(
      `/rooms/${roomId}/membership`,
      { method: "POST" },
    );
    return (await res.json()) as SabhaRoom;
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
   * Fetch a single user's rich profile (bio + social URLs in addition to
   * the standard SabhaUser fields). Server-scoped to users sharing a room
   * with the bot — a 404 is returned if the bot can't reach the user, so
   * callers should treat that as "not visible" rather than "doesn't exist."
   *
   * Positional signature kept on purpose: the wire route has no optional
   * params and a single required id. If a `query` / `include` parameter
   * ever lands server-side, reshape to an opts object then; for now the
   * asymmetry with `listRooms` / `listUsers` / `searchUsers` is the
   * smaller cost.
   *
   * Server route: `GET /api/bots/users/:id`.
   */
  async getUser(userId: number): Promise<SabhaUserDetail> {
    const res = await this.fetch(`/users/${userId}`);
    return (await res.json()) as SabhaUserDetail;
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

  /**
   * Search messages. Server caps results at 200; default limit is 50.
   * Pass `roomIds` / `authorIds` to scope; pass `cursor` to walk results.
   *
   * Server route: `GET /api/bots/search?query=&room_ids=&author_ids=&before=&after=&limit=&cursor=`.
   * Array params (`room_ids`, `author_ids`) use repeated keys (Rails default).
   * Response shape: `{ results, has_more, next_cursor: "<iso>|<id>" | null }`.
   * 422 on unparseable `before` / `after` ISO timestamps.
   *
   * Cursor walk semantics: when `cursor` is supplied, the server uses it
   * as the anchor and continues from that point. `query`, `roomIds`, etc.
   * SHOULD match the original call — the cursor is only meaningful in the
   * scope it was issued from. Sending a different `query` alongside a
   * cursor produces undefined ordering at the server. Re-issue the
   * original opts plus the cursor; don't change the query mid-walk.
   */
  async search(opts: {
    query: string;
    roomIds?: number[];
    authorIds?: number[];
    before?: string;
    after?: string;
    limit?: number;
    cursor?: string;
  }): Promise<SabhaSearchResponse> {
    const params = new URLSearchParams();
    params.set("query", opts.query);
    for (const id of opts.roomIds ?? []) params.append("room_ids", String(id));
    for (const id of opts.authorIds ?? []) params.append("author_ids", String(id));
    // The wire's `before` is dual-purpose: plain ISO = filter, composite
    // `<iso>|<id>` = cursor. The server's `parse_pagination_params`
    // (controllers/concerns/cursor_paginated.rb) only reads `params[:before]`
    // and ignores any `cursor=` URL param. If both are passed, prefer the
    // explicit `cursor` field — agent intent "continue paginating" beats
    // "filter older than X".
    const beforeParam = opts.cursor ?? opts.before;
    if (beforeParam) params.set("before", beforeParam);
    if (opts.after) params.set("after", opts.after);
    if (opts.limit != null) params.set("limit", String(opts.limit));
    const res = await this.fetch(`/search?${params.toString()}`);
    const raw = (await res.json()) as unknown;
    return parseSearchResponse(raw);
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

/**
 * Validate the search-response JSON shape at the wire boundary. Without
 * this guard, a server regression to the pre-envelope bare-array shape
 * (or a misconfigured proxy returning HTML) reaches the agent path as
 * `response.results.length` throwing on `undefined`. Cheap structural
 * check beats either zod or letting the runtime error bubble.
 */
function parseSearchResponse(raw: unknown): SabhaSearchResponse {
  if (
    !raw ||
    typeof raw !== "object" ||
    !Array.isArray((raw as { results?: unknown }).results) ||
    typeof (raw as { has_more?: unknown }).has_more !== "boolean"
  ) {
    throw new Error(
      "Sabha /search returned an unexpected shape (expected { results, has_more, next_cursor })",
    );
  }
  const json = raw as {
    results: SabhaSearchResult[];
    has_more: boolean;
    next_cursor?: string | null;
  };
  return {
    results: json.results,
    hasMore: json.has_more,
    nextCursor: json.next_cursor ?? null,
  };
}

function parseReadMessagesResponse(raw: unknown): SabhaReadMessagesResponse {
  if (
    !raw ||
    typeof raw !== "object" ||
    !Array.isArray((raw as { results?: unknown }).results) ||
    typeof (raw as { has_more?: unknown }).has_more !== "boolean"
  ) {
    throw new Error(
      "Sabha read returned an unexpected shape (expected { results, has_more, next_cursor })",
    );
  }
  const json = raw as {
    results: SabhaReadMessage[];
    has_more: boolean;
    next_cursor?: string | null;
  };
  return {
    results: json.results,
    hasMore: json.has_more,
    nextCursor: json.next_cursor ?? null,
  };
}

function parseReactionsResponse(raw: unknown): SabhaReactionsResponse {
  if (
    !raw ||
    typeof raw !== "object" ||
    !Array.isArray((raw as { reactions?: unknown }).reactions) ||
    typeof (raw as { total?: unknown }).total !== "number" ||
    typeof (raw as { truncated?: unknown }).truncated !== "boolean"
  ) {
    throw new Error(
      "Sabha reactions returned an unexpected shape (expected { reactions, total, truncated })",
    );
  }
  return raw as { reactions: SabhaReaction[]; total: number; truncated: boolean };
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
