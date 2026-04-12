/**
 * Deterministic @DisplayName → @{user_id} rewriter.
 *
 * LLMs do not reliably emit Sabha's `@{user_id}` mention syntax even
 * when prompted — they default to platform-native conventions like
 * Discord's `<@id>` or Slack's `@username`. This module rewrites
 * outbound `@DisplayName` tokens to `@{user_id}` before the text hits
 * Sabha's bot API, so `format_mentions` in `by_bots_controller.rb`
 * can find and rewrite them to real `<action-text-attachment>` tags.
 *
 * The rewriter is populated from inbound events: every `message_created`
 * payload carries `user.id` + `user.name`, and the `mentionees` array
 * carries the same for every user mentioned in that message. Both are
 * fed into the name→id map so the rewriter knows every user the bot
 * has seen in the current session.
 *
 * Placement: threaded into `SabhaClient` via `opts.mentionRewriter` so
 * every outbound path (reply pipeline, shared message tool, agent tools,
 * draft-stream) benefits automatically. Runs before
 * `markdownToSabhaRichText` so the converter's mention placeholder pass
 * protects the newly-rewritten `@{id}` tokens through the regex pipeline.
 */

/** Escape special regex characters in a string. */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * A name→id map that can rewrite `@DisplayName` to `@{user_id}` in
 * outbound message text.
 *
 * Thread-safe for single-threaded Node: all mutations are synchronous
 * Map ops, and the rewrite pass is a pure function of the current map
 * state at call time.
 */
export class MentionRewriter {
  /** Display name (lowercased for case-insensitive lookup) → numeric user id. */
  private readonly names = new Map<string, number>();
  /** Original-cased name for each lowercase key, used for regex construction. */
  private readonly originalNames = new Map<string, string>();

  /**
   * Register a user's display name → id mapping. Overwrites if the name
   * was already registered (name changes, duplicate events — both benign).
   */
  add(name: string, id: number): void {
    if (!name || id <= 0) return;
    const key = name.toLowerCase();
    this.names.set(key, id);
    this.originalNames.set(key, name);
  }

  /** Number of known name→id mappings. */
  get size(): number {
    return this.names.size;
  }

  /**
   * Rewrite `@DisplayName` tokens in `text` to `@{user_id}` for every
   * name in the map. Returns the text unchanged if no rewrites apply.
   *
   * Matching rules:
   * - Case-insensitive (`@ashwin m` matches a registered "Ashwin M")
   * - Names are tried longest-first so "Ashwin Mohan" matches before
   *   "Ashwin M" when both are registered
   * - `@Name` must be followed by a non-word character, punctuation,
   *   or end-of-string — `@Ashwin's` won't match "Ashwin" because
   *   the `'` would be consumed
   * - Tokens already in `@{...}` form are skipped (no double-rewrite)
   * - `<@id>` (Discord) is also rewritten: `<@42>` → `@{42}` for any
   *   id that matches a known user
   */
  rewrite(text: string): string {
    if (this.names.size === 0 || !text) return text;

    // First pass: fix Discord-style <@id> → @{id} for known user ids.
    const knownIds = new Set(this.names.values());
    text = text.replace(/<@(\d+)>/g, (match, idStr) => {
      const id = Number(idStr);
      return knownIds.has(id) ? `@{${id}}` : match;
    });

    // Second pass: rewrite @DisplayName → @{id}.
    // Sort names longest-first so longer names match before prefixes.
    const entries = [...this.names.entries()].sort(
      (a, b) => b[0].length - a[0].length,
    );

    for (const [key, id] of entries) {
      const originalName = this.originalNames.get(key) ?? key;
      // Build a case-insensitive regex that matches @Name followed by
      // a word boundary (non-word char or end-of-string). The negative
      // lookbehind `(?<!\{)` prevents matching inside an existing @{...}.
      const pattern = new RegExp(
        `(?<!\\{)@${escapeRegex(originalName)}(?=\\W|$)`,
        "gi",
      );
      text = text.replace(pattern, `@{${id}}`);
    }

    return text;
  }
}
