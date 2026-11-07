/**
 * Markdown -> the HTML a Sabha message body stores.
 *
 * sabha-ai keeps message bodies as Action Text edited with Lexxy, and an app's
 * JSON `body` is stored as that HTML verbatim (after `@{user_id}` -> mention
 * attachment substitution). Raw Markdown would show its asterisks, so agent
 * text is rendered here, once, to the markup Lexxy itself exports:
 *
 * - paragraphs are `<p>`; a single newline is `<br>` (chat semantics)
 * - fenced code is `<pre data-language="lang">` with escaped text and no inner
 *   `<code>`, as Lexxy's CodeNode exports it
 * - tables are `<table>` with `thead`/`tbody`/`tr`/`th`/`td`, strikethrough is
 *   `<s>`, both in sabha-ai's effective safelist (Rails + Lexxy + Sabha extras)
 * - images become links: a chat message should not hotlink third-party pixels
 *
 * Raw HTML in the input is escaped, never passed through, so `a < b`, `&`, or
 * an echoed `<script>` arrive as text. `@{123}` mention tokens are plain text
 * to the parser and survive untouched for the server to resolve.
 */
import MarkdownIt from "markdown-it";

const md = new MarkdownIt({ html: false, linkify: true, breaks: true, typographer: false });

md.renderer.rules.fence = (tokens, idx) => {
  const token = tokens[idx]!;
  const language = token.info.trim().split(/\s+/)[0] ?? "";
  const attribute = /^[\w.+#-]+$/.test(language) ? ` data-language="${md.utils.escapeHtml(language)}"` : "";
  return `<pre${attribute}>${md.utils.escapeHtml(token.content.replace(/\n$/, ""))}</pre>\n`;
};

md.renderer.rules.code_block = (tokens, idx) =>
  `<pre>${md.utils.escapeHtml(tokens[idx]!.content.replace(/\n$/, ""))}</pre>\n`;

md.renderer.rules.image = (tokens, idx, options, env, self) => {
  const token = tokens[idx]!;
  const src = token.attrGet("src") ?? "";
  const label = self.renderInlineAsText(token.children ?? [], options, env) || src;
  return `<a href="${md.utils.escapeHtml(src)}">${md.utils.escapeHtml(label)}</a>`;
};

export function markdownToSabhaHtml(markdown: string): string {
  if (!markdown.trim()) return "";
  return md.render(markdown).trim();
}
