/**
 * Markdown → Sabha rich text (ActionText / Trix-compatible HTML) converter.
 *
 * Sabha stores message bodies as ActionText rich text (`has_rich_text :body`
 * on `Message`). When the plugin posts to `POST /rooms/{id}/{bot_key}/messages`,
 * the server reads the request body as a UTF-8 string and stores it directly
 * as the rich-text body — no markdown parsing, no rendering step. If the
 * plugin sends literal markdown (`**bold**`, `- item`, ` ``` `), users see
 * the raw asterisks/dashes/backticks in the UI.
 *
 * This module converts markdown to an HTML subset that (a) renders correctly
 * through Sabha's display-time sanitizer (`ContentFilters::SanitizeTags`) and
 * (b) round-trips safely if a human ever opens a bot message in the Trix
 * editor to edit it.
 *
 * Ported from @37signals/openclaw-basecamp/src/outbound/format.ts. See
 * `docs/OUTBOUND-RICH-TEXT.md` for the port rationale.
 *
 * Three places this pipeline's output deviates from canonical Trix, each a
 * deliberate choice for Sabha's deployment:
 *
 * 1. Headings emit `<h1>`–`<h6>` even though Trix's editor config only
 *    supports `<h1>` natively. Sabha's sanitizer allowlist explicitly permits
 *    all six levels, so they render correctly. The only failure mode is
 *    "human opens a bot message in Trix and sees h2–h6 flattened" — fine for
 *    Sabha because bot messages are edited by humans approximately never,
 *    and flattening every `###` to `<h1>` would produce visually-wrong
 *    output in the display path, which is the path that actually matters.
 *
 * 2. Paragraph separation uses `<br><br>` between blocks rather than `<div>`
 *    or `<p>` wrappers. Visually identical in rendered output. Different
 *    under the hood for Trix's document model. Functionally equivalent for
 *    display and for the mention/search pipelines that read from the stored
 *    body.
 *
 * 3. Pipe tables downgrade to `<pre>` wrapping the raw pipe-table text
 *    (HTML-escaped). Basecamp emits `<table><thead><tbody><tr><th><td>`,
 *    but Sabha's `ContentFilters::SanitizeTags::ALLOWED_TAGS` does NOT
 *    include any table tags — emitting `<table>` would cause the entire
 *    element and its contents to be silently stripped at display time.
 *    `<pre>` is in the allowlist and preserves column alignment via
 *    monospace rendering — readable, just not rendered as an HTML table.
 *    Can be swapped back to real `<table>` once a server PR adds table
 *    tags to `ALLOWED_TAGS` (tracked in Sabha Server Changes for v1).
 *
 * Mention handling: Sabha's bot API accepts `@{user_id}` literal tokens in
 * the body and the server's `format_mentions` rewrites them to
 * `<action-text-attachment>` tags at save time. The `@{42}` token has to
 * survive every regex pass without getting HTML-escaped or mangled, so the
 * converter substitutes each mention for a NUL-delimited placeholder up
 * front, runs the whole pipeline, and restores the literals at the end.
 * NUL (`\u0000`) is chosen because it cannot legally appear in markdown
 * input an LLM would produce.
 *
 * Mentions inside inline code spans are intentionally NOT protected. Writing
 * `` `@{42}` `` produces `<code>@{42}</code>` and the server will still
 * rewrite the token inside the `<code>` tag at save time. Documented quirk —
 * agents that want a literal `@{42}` in a code span can't express it
 * through this pipeline.
 */

/** Escape HTML special characters. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** NUL-delimited placeholder used to protect `@{user_id}` tokens through the pipeline. */
const MENTION_PLACEHOLDER_PREFIX = "\u0000MENTION\u0000";
// eslint-disable-next-line no-control-regex -- NUL delimiter is deliberate; cannot occur in LLM input.
const MENTION_PLACEHOLDER_RE = /\u0000MENTION\u0000(\d+)\u0000/g;

/**
 * Convert a markdown string to Sabha-compatible Trix/ActionText HTML.
 *
 * Handles: headings, bold, italic, strikethrough, inline code, fenced code
 * blocks, links, blockquotes, unordered/ordered lists, pipe tables (as
 * `<pre>` fallback), horizontal rules, and paragraph/line breaks. Preserves
 * `@{user_id}` mention tokens verbatim so the server's `format_mentions`
 * rewrite runs against them at save time.
 */
export function markdownToSabhaRichText(md: string): string {
  if (!md) return "";

  // --- Mention placeholder pass (pre) ---
  // Substitute `@{\d+}` for a NUL-delimited sentinel so the rest of the
  // pipeline cannot touch the contents. Restored at the very end.
  const mentions: string[] = [];
  let html = md.replace(/@\{(\d+)\}/g, (match) => {
    mentions.push(match);
    return `${MENTION_PLACEHOLDER_PREFIX}${mentions.length - 1}\u0000`;
  });

  // --- Fenced code blocks (``` ... ```) ---
  // Must run before inline transforms to avoid mangling code contents.
  html = html.replace(/```([\w.+#/-]*)\n([\s\S]*?)```/g, (_match, lang, code) => {
    const langAttr = lang ? ` class="language-${lang}"` : "";
    return `<pre${langAttr}>${escapeHtml(code.replace(/\n$/, ""))}</pre>`;
  });

  // --- Pipe tables → <pre> downgrade (delta 3, see module header) ---
  // Must run after fenced code blocks but before inline transforms. Skip
  // matches inside <pre> blocks (already converted from fenced code).
  html = html.replace(/(?:^|\n)((?:\|[^\n]+\|(?:\n|$))+)/g, (match, block: string, offset: number) => {
    // Check if this match falls inside a <pre> block we just emitted.
    const matchStart = offset;
    const matchEnd = offset + match.length;
    const preOpenRegex = /<pre[^>]*>/g;
    let preMatch: RegExpExecArray | null;
    const tempHtml = html;
    while ((preMatch = preOpenRegex.exec(tempHtml)) !== null) {
      const preStart = preMatch.index;
      const preCloseIdx = tempHtml.indexOf("</pre>", preStart);
      if (preCloseIdx !== -1 && matchStart >= preStart && matchEnd <= preCloseIdx + 6) {
        return match;
      }
    }
    const rows = block.trim().split("\n");
    if (rows.length < 2) return match;
    // The second row must be a separator (only |, -, :, spaces).
    if (!/^[\s|:-]+$/.test(rows[1]!)) return match;

    // Downgrade: wrap the raw pipe-table text in <pre>, HTML-escape the
    // contents so `<` / `>` / `&` inside cells can't inject markup, and
    // preserve the leading newline for paragraph separation.
    return `\n<pre>${escapeHtml(block.trimEnd())}</pre>\n`;
  });

  // --- Inline code (`...`) ---
  // Run before other inline transforms so backtick contents stay literal.
  html = html.replace(/`([^`\n]+)`/g, (_match, code) => {
    return `<code>${escapeHtml(code)}</code>`;
  });

  // --- Blockquotes ---
  // Collect consecutive > lines into a single <blockquote>.
  html = html.replace(/(?:^|\n)((?:> ?.+(?:\n|$))+)/g, (_match, block: string) => {
    const inner = block
      .split("\n")
      .map((line: string) => line.replace(/^> ?/, ""))
      .join("\n")
      .trim();
    return `\n<blockquote>${inner}</blockquote>\n`;
  });

  // --- Headings (# through ######) ---
  html = html.replace(/^(#{1,6})\s+(.+)$/gm, (_match, hashes: string, content: string) => {
    const level = hashes.length;
    return `<h${level}>${content.trim()}</h${level}>`;
  });

  // --- Bold (**text** or __text__) ---
  html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/__(.+?)__/g, "<strong>$1</strong>");

  // --- Italic (*text* or _text_) ---
  // Avoid matching inside URLs or already-processed tags.
  html = html.replace(/(?<![*\w])\*([^*\n]+?)\*(?![*\w])/g, "<em>$1</em>");
  html = html.replace(/(?<![_\w])_([^_\n]+?)_(?![_\w])/g, "<em>$1</em>");

  // --- Strikethrough (~~text~~) ---
  html = html.replace(/~~(.+?)~~/g, "<del>$1</del>");

  // --- Links [text](url) ---
  // The destination allows one level of nested balanced parens so URLs like
  // `https://en.wikipedia.org/wiki/Foo_(bar)` don't get truncated at the
  // first inner `)`. Basecamp's upstream pipeline has the same limitation
  // (it uses `[^)]+`) — the nested-paren case is a Sabha-specific fix
  // because Wikipedia links show up constantly in agent output.
  html = html.replace(
    /\[([^\]]+)\]\(((?:[^()]|\([^)]*\))+)\)/g,
    '<a href="$2">$1</a>',
  );

  // --- Unordered lists ---
  html = html.replace(/(?:^|\n)((?:[ \t]*[-*+] .+(?:\n|$))+)/g, (_match, block: string) => {
    const items = block
      .trim()
      .split("\n")
      .map((line: string) => `<li>${line.replace(/^[ \t]*[-*+] /, "").trim()}</li>`)
      .join("\n");
    return `\n<ul>\n${items}\n</ul>\n`;
  });

  // --- Ordered lists ---
  html = html.replace(/(?:^|\n)((?:[ \t]*\d+\. .+(?:\n|$))+)/g, (_match, block: string) => {
    const items = block
      .trim()
      .split("\n")
      .map((line: string) => `<li>${line.replace(/^[ \t]*\d+\. /, "").trim()}</li>`)
      .join("\n");
    return `\n<ol>\n${items}\n</ol>\n`;
  });

  // --- Horizontal rules (---, ***, ___) ---
  html = html.replace(/^[-*_]{3,}$/gm, "<hr>");

  // --- Line breaks ---
  // Double newline = paragraph break, single newline = <br>.
  // First collapse triple+ newlines to double.
  html = html.replace(/\n{3,}/g, "\n\n");

  // Convert remaining single newlines to <br> (but not inside block elements).
  const paragraphs = html.split("\n\n");
  html = paragraphs
    .map((p) => {
      const trimmed = p.trim();
      if (!trimmed) return "";
      // Don't add <br> inside block-level elements we just emitted.
      if (/^<(pre|ul|ol|blockquote|h[1-6]|hr)/i.test(trimmed)) {
        return trimmed;
      }
      return trimmed.replace(/\n/g, "<br>\n");
    })
    .filter(Boolean)
    .join("<br>\n<br>\n");

  // --- Mention placeholder pass (post) ---
  // Restore the original `@{user_id}` literals. Must run after every other
  // transform so placeholders aren't damaged by HTML escaping or list/quote
  // splitting.
  //
  // If a NUL-delimited sentinel appears in the output without a matching
  // entry in `mentions` (e.g. because the input happened to contain a raw
  // NUL sequence that looked like a placeholder), fall back to the literal
  // match so we don't silently swallow content. NUL has no legitimate
  // rendering anyway — whatever survives here will be stripped by Sabha's
  // display-time sanitizer.
  html = html.replace(MENTION_PLACEHOLDER_RE, (match, idx) => mentions[Number(idx)] ?? match);

  return html.trim();
}

