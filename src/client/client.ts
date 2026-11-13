// Every Sabha REST call lives here: bearer auth, /api/v1 routes, retry
// classification, response parsing, and Markdown -> Sabha HTML.
import { randomUUID } from "node:crypto";
import { retryAsync } from "openclaw/plugin-sdk/runtime-env";
import { markdownToSabhaHtml } from "./rich-text.js";
import type {
  SabhaCommandDeclaration,
  SabhaMessage,
  SabhaPage,
  SabhaReactions,
  SabhaRoom,
  SabhaSearchResult,
  SabhaSent,
  SabhaUser,
  SabhaUserDetail,
} from "./types.js";

const DEFAULT_TIMEOUT_MS = 30_000;
/** Statuses that mean "not processed, try again". */
const TRANSIENT_STATUS = new Set([502, 503, 504]);

export class SabhaApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    readonly method: string,
    readonly path: string,
    readonly retryAfterMs?: number,
  ) {
    super(`Sabha API ${method} ${path} failed with ${status}${body ? `: ${body.slice(0, 300)}` : ""}${missingPermissionHint(body)}`);
    this.name = "SabhaApiError";
  }

  /** Sabha's JSON error `code` (`rate_limited`, `validation_failed`, `not_found`, …), when present. */
  get code(): string | undefined {
    try {
      const parsed = JSON.parse(this.body) as { code?: unknown };
      return typeof parsed.code === "string" ? parsed.code : undefined;
    } catch {
      return undefined;
    }
  }
}

/** A key without a permission is refused by name; say where an admin turns it on. */
function missingPermissionHint(body: string): string {
  try {
    const parsed = JSON.parse(body) as { code?: unknown; needed?: unknown };
    if (parsed.code !== "missing_permission" || typeof parsed.needed !== "string") return "";
    return ` (an admin can turn on "${parsed.needed}" under "What its key can do" on the app's page in Sabha, Settings → Apps)`;
  } catch {
    return "";
  }
}

/** Thrown when Sabha answered 2xx but not with the shape the contract promises. */
export class SabhaResponseError extends Error {
  constructor(readonly path: string, detail: string) {
    super(`Sabha ${path} returned an unexpected response: ${detail}`);
    this.name = "SabhaResponseError";
  }
}

export function parseRetryAfter(header: string | null): number | undefined {
  const trimmed = header?.trim();
  if (!trimmed) return undefined;
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds)) return seconds >= 0 ? Math.round(seconds * 1000) : undefined;
  const date = Date.parse(trimmed);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

export type SabhaClientOptions = {
  apiBaseUrl: string;
  appKey: string;
  abortSignal?: AbortSignal;
  timeoutMs?: number;
  /** `@Display Name` -> `@{id}` before rendering; see mention-rewrite.ts. */
  rewriteMentions?: (markdown: string) => string;
  fetchImpl?: typeof fetch;
  retry?: { attempts?: number; minDelayMs?: number; maxDelayMs?: number };
};

type RequestOptions = {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  query?: URLSearchParams;
  json?: unknown;
  text?: string;
  form?: FormData;
  /**
   * Retried on gateway errors and timeouts as well as 429. A create is, only
   * when it carries a client_message_id, so a repeat finds the first post.
   */
  idempotent?: boolean;
};

export class SabhaClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: SabhaClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** Markdown as the agent wrote it -> the HTML body Sabha stores. */
  renderBody(markdown: string): string {
    return markdownToSabhaHtml(this.options.rewriteMentions?.(markdown) ?? markdown);
  }

  // --- Identity ---

  async me(): Promise<{ id: number; name: string; workspace?: { name?: string; url?: string } }> {
    const json = await this.json<{ id?: unknown; name?: unknown; workspace?: { name?: string; url?: string } }>("/me");
    if (typeof json.id !== "number" || typeof json.name !== "string") throw new SabhaResponseError("/me", "missing id or name");
    return { id: json.id, name: json.name, workspace: json.workspace };
  }

  // --- Messages ---

  /**
   * Post Markdown to a room. `parentMessageId` opens (or finds) the parent's
   * thread; the returned `roomId` is then the thread room. `clientMessageId`
   * is the live draft's id, so the message replaces that draft in place;
   * without one the post gets its own.
   */
  async sendMessage(
    roomId: number,
    markdown: string,
    options: { parentMessageId?: number; clientMessageId?: string } = {},
  ): Promise<SabhaSent> {
    const html = this.renderBody(markdown);
    return this.createMessage(roomId, options.parentMessageId, options.clientMessageId ?? randomUUID(), (id) => ({
      json: id ? { body: html, client_message_id: id } : { body: html },
    }));
  }

  async sendAttachment(roomId: number, file: Blob, filename: string, options: { parentMessageId?: number } = {}): Promise<SabhaSent> {
    return this.createMessage(roomId, options.parentMessageId, randomUUID(), (id) => {
      const form = new FormData();
      form.append("attachment", file, filename);
      if (id) form.append("client_message_id", id);
      return { form };
    });
  }

  /**
   * A post that carries its own client_message_id, which makes it safe to
   * retry: Sabha answers a repeat of a saved post with that post. A server
   * that predates the field refuses it by name; the post then goes without
   * it, and unretried, since a repeat there could post twice.
   */
  private async createMessage(
    roomId: number,
    parentMessageId: number | undefined,
    clientMessageId: string,
    body: (clientMessageId?: string) => Pick<RequestOptions, "json" | "form">,
  ): Promise<SabhaSent> {
    const path = `/rooms/${roomId}/messages`;
    const query = threadQuery(parentMessageId);
    try {
      return parseSent(path, await this.json(path, { method: "POST", query, ...body(clientMessageId), idempotent: true }));
    } catch (error) {
      if (!refusesClientMessageId(error)) throw error;
      return parseSent(path, await this.json(path, { method: "POST", query, ...body() }));
    }
  }

  async editMessage(messageId: number, markdown: string): Promise<void> {
    await this.request(`/messages/${messageId}`, { method: "PATCH", json: { body: this.renderBody(markdown) }, idempotent: true });
  }

  async deleteMessage(messageId: number): Promise<void> {
    await this.request(`/messages/${messageId}`, { method: "DELETE", idempotent: true });
  }

  async getMessage(messageId: number): Promise<SabhaMessage> {
    return this.json<SabhaMessage>(`/messages/${messageId}`);
  }

  /** Newest first. `before` is an ISO time or the opaque `next_cursor`. */
  async readMessages(roomId: number, page: { before?: string; after?: string; limit?: number } = {}): Promise<SabhaPage<SabhaMessage>> {
    const path = `/rooms/${roomId}/messages`;
    return parsePage<SabhaMessage>(path, await this.json(path, { query: pageQuery(page) }));
  }

  async search(params: {
    query: string;
    roomIds?: number[];
    authorIds?: number[];
    before?: string;
    after?: string;
    limit?: number;
  }): Promise<SabhaPage<SabhaSearchResult>> {
    const query = pageQuery(params);
    query.set("q", params.query);
    for (const id of params.roomIds ?? []) query.append("room_ids[]", String(id));
    for (const id of params.authorIds ?? []) query.append("author_ids[]", String(id));
    return parsePage<SabhaSearchResult>("/search", await this.json("/search", { query }));
  }

  // --- Reactions ---

  async listReactions(messageId: number): Promise<SabhaReactions> {
    const path = `/messages/${messageId}/reactions`;
    const json = await this.json<Partial<SabhaReactions>>(path);
    if (!Array.isArray(json.reactions) || typeof json.total !== "number") throw new SabhaResponseError(path, "expected { reactions, total }");
    return { reactions: json.reactions, total: json.total, truncated: json.truncated === true };
  }

  /** Returns the reaction id, needed to remove it. */
  async addReaction(messageId: number, emoji: string): Promise<number> {
    const path = `/messages/${messageId}/reactions`;
    const json = await this.json<{ id?: unknown }>(path, { method: "POST", text: emoji });
    if (typeof json.id !== "number") throw new SabhaResponseError(path, "missing reaction id");
    return json.id;
  }

  async removeReaction(messageId: number, reactionId: number): Promise<void> {
    await this.request(`/messages/${messageId}/reactions/${reactionId}`, { method: "DELETE", idempotent: true });
  }

  // --- Rooms, people, DMs ---

  async listRooms(params: { query?: string; page?: number; perPage?: number } = {}): Promise<SabhaRoom[]> {
    const query = new URLSearchParams();
    if (params.query) query.set("query", params.query);
    if (params.page != null) query.set("page", String(params.page));
    if (params.perPage != null) query.set("per_page", String(params.perPage));
    return this.array<SabhaRoom>("/rooms", query);
  }

  async getRoom(roomId: number): Promise<SabhaRoom> {
    return this.json<SabhaRoom>(`/rooms/${roomId}`);
  }

  async listUsers(params: { roomId?: number; page?: number; perPage?: number } = {}): Promise<SabhaUser[]> {
    const query = new URLSearchParams();
    if (params.roomId != null) query.set("room_id", String(params.roomId));
    if (params.page != null) query.set("page", String(params.page));
    if (params.perPage != null) query.set("per_page", String(params.perPage));
    return this.array<SabhaUser>("/users", query);
  }

  async getUser(userId: number): Promise<SabhaUserDetail> {
    return this.json<SabhaUserDetail>(`/users/${userId}`);
  }

  /** Up to 20 matches; a blank query with a room lists its recent posters. */
  async searchUsers(params: { query?: string; roomId?: number }): Promise<SabhaUser[]> {
    const query = new URLSearchParams();
    if (params.query) query.set("query", params.query);
    if (params.roomId != null) query.set("room_id", String(params.roomId));
    return this.array<SabhaUser>("/autocompletable/users", query);
  }

  /** Finds or opens the DM; idempotent on Sabha's side (200 existing, 201 new). */
  // --- Slash commands ---

  /**
   * Replace the app's slash commands. Sabha takes the list whole or not at
   * all: a list with a name another app holds changes nothing, and the refused
   * names come back so the caller can declare the rest.
   */
  async declareCommands(commands: SabhaCommandDeclaration[]): Promise<string[]> {
    try {
      await this.request("/profile/commands", { method: "PUT", json: { commands }, idempotent: true });
      return [];
    } catch (error) {
      const refused = error instanceof SabhaApiError && error.status === 422 ? refusedNames(error.body) : [];
      if (!refused.length) throw error;
      return refused;
    }
  }

  /** Answer a command through its response_url, whose token is its own credential: no bearer key. */
  async respond(responseUrl: string, markdown: string): Promise<void> {
    const response = await this.fetchImpl(responseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ body: this.renderBody(markdown) }),
      signal: AbortSignal.timeout(this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new SabhaApiError(response.status, await response.text().catch(() => ""), "POST", "response_url");
    }
  }

  async createDm(userIds: number[]): Promise<{ roomId: number }> {
    const json = await this.json<{ room?: { id?: unknown } }>("/direct_messages", {
      method: "POST",
      json: { user_ids: userIds },
      idempotent: true,
    });
    if (typeof json.room?.id !== "number") throw new SabhaResponseError("/direct_messages", "missing room id");
    return { roomId: json.room.id };
  }

  // --- Transport ---

  private async array<T>(path: string, query: URLSearchParams): Promise<T[]> {
    const json = await this.json<unknown>(path, { query });
    if (!Array.isArray(json)) throw new SabhaResponseError(path, "expected an array");
    return json as T[];
  }

  private async json<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const response = await this.request(path, options);
    try {
      return (await response.json()) as T;
    } catch {
      throw new SabhaResponseError(path, "body is not JSON");
    }
  }

  private async request(path: string, options: RequestOptions = {}): Promise<Response> {
    const method = options.method ?? "GET";
    const idempotent = options.idempotent ?? method === "GET";
    const qs = options.query?.toString();
    const url = `${this.options.apiBaseUrl}${path}${qs ? `?${qs}` : ""}`;
    const shouldRetry = (error: unknown) =>
      error instanceof SabhaApiError
        ? error.status === 429 || (idempotent && TRANSIENT_STATUS.has(error.status))
        : idempotent && isTransportError(error) && !this.options.abortSignal?.aborted;

    return retryAsync(
      async () => {
        const headers = new Headers({ Authorization: `Bearer ${this.options.appKey}`, Accept: "application/json" });
        let body: RequestInit["body"];
        if (options.json !== undefined) {
          headers.set("Content-Type", "application/json");
          body = JSON.stringify(options.json);
        } else if (options.text !== undefined) {
          headers.set("Content-Type", "text/plain; charset=utf-8");
          body = options.text;
        } else if (options.form) {
          body = options.form;
        }
        const signals = [AbortSignal.timeout(this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS)];
        if (this.options.abortSignal) signals.push(this.options.abortSignal);
        const response = await this.fetchImpl(url, { method, headers, body, signal: AbortSignal.any(signals) });
        if (!response.ok) {
          const text = await response.text().catch(() => "");
          throw new SabhaApiError(response.status, text, method, path, parseRetryAfter(response.headers.get("retry-after")));
        }
        return response;
      },
      {
        attempts: this.options.retry?.attempts ?? 3,
        minDelayMs: this.options.retry?.minDelayMs ?? 500,
        maxDelayMs: this.options.retry?.maxDelayMs ?? 30_000,
        jitter: 0.2,
        label: `${method} ${path}`,
        shouldRetry,
        retryAfterMs: (error) => (error instanceof SabhaApiError ? error.retryAfterMs : undefined),
      },
    );
  }
}

/** The request timed out or never reached Sabha, so its outcome is unknown. */
function isTransportError(error: unknown): boolean {
  return error instanceof TypeError || (error instanceof Error && error.name === "TimeoutError");
}

function refusesClientMessageId(error: unknown): boolean {
  return error instanceof SabhaApiError && error.status === 422 && error.body.includes("client_message_id is not permitted");
}

function refusedNames(body: string): string[] {
  try {
    const parsed = JSON.parse(body) as { refusals?: unknown };
    if (!Array.isArray(parsed.refusals)) return [];
    return parsed.refusals.flatMap((refusal: { name?: unknown }) => (typeof refusal?.name === "string" ? [refusal.name] : []));
  } catch {
    return [];
  }
}

function threadQuery(parentMessageId: number | undefined): URLSearchParams | undefined {
  return parentMessageId == null ? undefined : new URLSearchParams({ parent_message_id: String(parentMessageId) });
}

function pageQuery(page: { before?: string; after?: string; limit?: number }): URLSearchParams {
  const query = new URLSearchParams();
  if (page.before) query.set("before", page.before);
  if (page.after) query.set("after", page.after);
  if (page.limit != null) query.set("limit", String(page.limit));
  return query;
}

function parseSent(path: string, json: unknown): SabhaSent {
  const { id, room_id: roomId } = (json ?? {}) as { id?: unknown; room_id?: unknown };
  if (typeof id !== "number" || typeof roomId !== "number") throw new SabhaResponseError(path, "expected { id, room_id }");
  return { id, roomId };
}

function parsePage<T>(path: string, json: unknown): SabhaPage<T> {
  const page = (json ?? {}) as { results?: unknown; has_more?: unknown; next_cursor?: unknown };
  if (!Array.isArray(page.results) || typeof page.has_more !== "boolean") {
    throw new SabhaResponseError(path, "expected { results, has_more, next_cursor }");
  }
  return { results: page.results as T[], hasMore: page.has_more, nextCursor: typeof page.next_cursor === "string" ? page.next_cursor : null };
}
