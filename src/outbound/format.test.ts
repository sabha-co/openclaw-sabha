import { describe, it, expect } from "vitest";
import { markdownToSabhaRichText } from "./format.js";
import { chunkMarkdownText } from "./chunk.js";

describe("markdownToSabhaRichText — inline styles", () => {
  it("converts **bold** to <strong>", () => {
    expect(markdownToSabhaRichText("**bold**")).toBe("<strong>bold</strong>");
  });

  it("converts __bold__ to <strong>", () => {
    expect(markdownToSabhaRichText("__bold__")).toBe("<strong>bold</strong>");
  });

  it("converts *italic* to <em>", () => {
    expect(markdownToSabhaRichText("*italic*")).toBe("<em>italic</em>");
  });

  it("converts _italic_ to <em>", () => {
    expect(markdownToSabhaRichText("_italic_")).toBe("<em>italic</em>");
  });

  it("converts ~~strike~~ to <del>", () => {
    expect(markdownToSabhaRichText("~~strike~~")).toBe("<del>strike</del>");
  });

  it("converts inline `code` to <code>", () => {
    expect(markdownToSabhaRichText("`x + 1`")).toBe("<code>x + 1</code>");
  });

  it("HTML-escapes the contents of inline code", () => {
    expect(markdownToSabhaRichText("`<script>`")).toBe("<code>&lt;script&gt;</code>");
  });

  it("converts [text](url) to <a>", () => {
    expect(markdownToSabhaRichText("[click](https://example.com)")).toBe(
      '<a href="https://example.com">click</a>',
    );
  });

  it("preserves balanced parens inside a link URL (e.g. Wikipedia)", () => {
    // The naive `[^)]+` destination class truncates at the first `)` —
    // broken for Wikipedia and many other real-world URLs. The Sabha
    // pipeline allows one level of nested balanced parens.
    expect(
      markdownToSabhaRichText("[Foo](https://en.wikipedia.org/wiki/Foo_(bar))"),
    ).toBe('<a href="https://en.wikipedia.org/wiki/Foo_(bar)">Foo</a>');
  });

  it("does not extend a link URL past a stray trailing `)`", () => {
    // Regression guard for the opposite direction: an unmatched `)`
    // outside the URL should not be consumed by the new nested-paren
    // regex.
    const out = markdownToSabhaRichText("[x](https://example.com))");
    expect(out).toContain('<a href="https://example.com">x</a>');
    expect(out).toContain(")");
  });
});

describe("markdownToSabhaRichText — block elements", () => {
  it("converts # h1 through ###### h6", () => {
    for (let level = 1; level <= 6; level++) {
      const md = `${"#".repeat(level)} Title`;
      const html = markdownToSabhaRichText(md);
      expect(html).toBe(`<h${level}>Title</h${level}>`);
    }
  });

  it("wraps consecutive > lines in a single <blockquote>", () => {
    const md = "> line one\n> line two";
    expect(markdownToSabhaRichText(md)).toBe("<blockquote>line one\nline two</blockquote>");
  });

  it("converts unordered lists (-)", () => {
    const md = "- one\n- two";
    const out = markdownToSabhaRichText(md);
    expect(out).toContain("<ul>");
    expect(out).toContain("<li>one</li>");
    expect(out).toContain("<li>two</li>");
    expect(out).toContain("</ul>");
  });

  it("converts unordered lists (* and +)", () => {
    expect(markdownToSabhaRichText("* a\n* b")).toContain("<li>a</li>");
    expect(markdownToSabhaRichText("+ a\n+ b")).toContain("<li>a</li>");
  });

  it("converts ordered lists", () => {
    const md = "1. first\n2. second";
    const out = markdownToSabhaRichText(md);
    expect(out).toContain("<ol>");
    expect(out).toContain("<li>first</li>");
    expect(out).toContain("<li>second</li>");
    expect(out).toContain("</ol>");
  });

  it("converts --- to <hr>", () => {
    expect(markdownToSabhaRichText("---")).toBe("<hr>");
  });

  it("converts fenced code blocks", () => {
    const md = "```\nhello\n```";
    expect(markdownToSabhaRichText(md)).toBe("<pre>hello</pre>");
  });

  it("attaches language class on fenced code blocks", () => {
    const md = "```ruby\nputs :hi\n```";
    expect(markdownToSabhaRichText(md)).toBe('<pre class="language-ruby">puts :hi</pre>');
  });

  it("HTML-escapes the contents of fenced code blocks", () => {
    const md = "```\n<script>alert(1)</script>\n```";
    expect(markdownToSabhaRichText(md)).toBe(
      "<pre>&lt;script&gt;alert(1)&lt;/script&gt;</pre>",
    );
  });

  it("separates paragraphs with <br><br>", () => {
    const md = "first para\n\nsecond para";
    const out = markdownToSabhaRichText(md);
    expect(out).toContain("first para<br>\n<br>\nsecond para");
  });

  it("converts single newlines inside a paragraph to <br>", () => {
    const md = "line one\nline two";
    const out = markdownToSabhaRichText(md);
    expect(out).toContain("line one<br>");
    expect(out).toContain("line two");
  });
});

describe("markdownToSabhaRichText — pipe table <pre> downgrade (delta 3)", () => {
  it("wraps a standard table in <pre> with contents escaped", () => {
    const md = "| name | age |\n| --- | --- |\n| Alice | 30 |\n| Bob | 25 |";
    const out = markdownToSabhaRichText(md);
    expect(out).toContain("<pre>");
    expect(out).toContain("</pre>");
    // No HTML table tags.
    expect(out).not.toContain("<table");
    expect(out).not.toContain("<tr");
    expect(out).not.toContain("<td");
    // Pipe characters preserved for monospace alignment.
    expect(out).toContain("| Alice | 30 |");
  });

  it("escapes HTML-special characters inside table cells", () => {
    const md = "| a | b |\n| --- | --- |\n| <x> | &y |";
    const out = markdownToSabhaRichText(md);
    expect(out).toContain("&lt;x&gt;");
    expect(out).toContain("&amp;y");
    expect(out).not.toContain("<x>");
  });

  it("leaves a pipe block without a separator row alone", () => {
    const md = "| not | really |\n| a | table |";
    const out = markdownToSabhaRichText(md);
    expect(out).not.toContain("<pre>");
  });

  it("preserves @{user_id} mentions inside a table <pre>", () => {
    const md = "| name | reviewer |\n| --- | --- |\n| bug-1 | @{42} |";
    const out = markdownToSabhaRichText(md);
    expect(out).toContain("<pre>");
    expect(out).toContain("@{42}");
  });

  it("does not bleed into adjacent blocks", () => {
    const md = "**bold before**\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n- after";
    const out = markdownToSabhaRichText(md);
    expect(out).toContain("<strong>bold before</strong>");
    expect(out).toContain("<pre>");
    expect(out).toContain("<ul>");
    expect(out).toContain("<li>after</li>");
  });
});

describe("markdownToSabhaRichText — mentions", () => {
  it("preserves a bare @{id}", () => {
    expect(markdownToSabhaRichText("@{42}")).toBe("@{42}");
  });

  it("preserves a mention inside bold", () => {
    expect(markdownToSabhaRichText("**@{42}**")).toBe("<strong>@{42}</strong>");
  });

  it("preserves two mentions on a line", () => {
    const out = markdownToSabhaRichText("@{1} and @{2}");
    expect(out).toContain("@{1}");
    expect(out).toContain("@{2}");
  });

  it("preserves a mention inside a list item", () => {
    const out = markdownToSabhaRichText("- @{1} to review");
    expect(out).toContain("<li>@{1} to review</li>");
  });

  it("preserves a mention inside a link", () => {
    expect(markdownToSabhaRichText("[@{42}](https://ex.com)")).toBe(
      '<a href="https://ex.com">@{42}</a>',
    );
  });

  it("preserves a mention inside inline code (documented quirk)", () => {
    // Server's format_mentions will still rewrite the token inside <code>,
    // producing an attachment-tag-in-code. Documented in module header.
    expect(markdownToSabhaRichText("`@{42}`")).toBe("<code>@{42}</code>");
  });

  it("leaves @{nonnumeric} alone", () => {
    // The mention regex only matches digits, so this falls through.
    expect(markdownToSabhaRichText("@{foo}")).toBe("@{foo}");
  });

  it("preserves adjacent mentions with no separator", () => {
    const out = markdownToSabhaRichText("@{1}@{2}");
    expect(out).toContain("@{1}");
    expect(out).toContain("@{2}");
  });

  it("does not silently delete input that looks like a placeholder sentinel", () => {
    // Regression: if the *input* contains a literal `\u0000MENTION\u0000<n>\u0000`
    // sequence (e.g. from a tool that emitted a binary blob), the post-pass
    // used to look up `mentions[n]`, find undefined, and substitute empty
    // string — silently deleting the content. Now it falls back to the
    // literal match so nothing is lost; Sabha's display-time sanitizer will
    // strip the NULs before they reach users.
    const input = "before\u0000MENTION\u00000\u0000after";
    const out = markdownToSabhaRichText(input);
    expect(out).toContain("before");
    expect(out).toContain("after");
  });
});

describe("markdownToSabhaRichText — edge cases", () => {
  it("returns empty output for empty input", () => {
    expect(markdownToSabhaRichText("")).toBe("");
  });

  it("plain text passes through verbatim", () => {
    expect(markdownToSabhaRichText("just text")).toBe("just text");
  });

  it("passes raw HTML through (Sabha sanitizer strips on display)", () => {
    // We deliberately do NOT escape general plain-text HTML. Sabha's
    // ContentFilters::SanitizeTags runs at display time and strips any
    // tag not in the allowlist, so `<script>` is safe to emit as-is
    // (it will be removed by the server's sanitize pass). Matches
    // Basecamp's pipeline, which relies on ActionText's sanitizer the
    // same way.
    const out = markdownToSabhaRichText("<script>alert(1)</script>");
    expect(out).toContain("<script>");
  });
});

describe("markdownToSabhaRichText — unclosed markdown safety (draft-stream)", () => {
  // Draft-stream calls the converter on every partial buffer as LLM tokens
  // arrive. These tests assert the converter never produces malformed HTML
  // when a construct is mid-emission.

  it("leaves an unclosed **bold** as literal text", () => {
    expect(markdownToSabhaRichText("**half")).toBe("**half");
  });

  it("leaves an unclosed fence as literal backticks", () => {
    const out = markdownToSabhaRichText("```\nunclosed");
    expect(out).not.toContain("<pre>");
    expect(out).toContain("```");
  });

  it("leaves an unclosed [link]( as literal text", () => {
    const out = markdownToSabhaRichText("[text](unclosed");
    expect(out).not.toContain("<a ");
  });

  it("nested partial: **bold *italic — neither wraps", () => {
    const out = markdownToSabhaRichText("**bold *italic");
    expect(out).not.toContain("<strong>");
    expect(out).not.toContain("<em>");
    expect(out).toContain("**bold *italic");
  });

  it("nested partial with inner close: **bold *italic*", () => {
    // Inner em closes; outer strong stays literal.
    const out = markdownToSabhaRichText("**bold *italic*");
    expect(out).toContain("<em>italic</em>");
    expect(out).not.toContain("<strong>");
    expect(out).toContain("**bold");
  });

  it("mid-list truncation: trailing `- ` stays literal", () => {
    const out = markdownToSabhaRichText("- one\n- two\n- ");
    expect(out).toContain("<li>one</li>");
    expect(out).toContain("<li>two</li>");
    // The trailing dangling dash-space is either kept literal or folded
    // into nothing — either way, no half-open <li>.
    expect(out).not.toMatch(/<li>\s*<\/li>/);
  });

  it("mid-blockquote at buffer end captures both lines", () => {
    const out = markdownToSabhaRichText("> line one\n> line two");
    expect(out).toBe("<blockquote>line one\nline two</blockquote>");
  });

  it("edit-boundary coherence: every prefix of a streaming buffer produces balanced tag nesting", () => {
    const buffer =
      "# Analysis\n\n" +
      "Found **3 issues**:\n\n" +
      "1. First\n" +
      "2. Second\n" +
      "3. Third\n\n" +
      "Details:\n" +
      "- item *a*\n" +
      "- item `b`\n\n" +
      "```ruby\nputs :hi\n```\n\n" +
      "@{42} take a look";

    // Short + tail prefixes: draft-stream spends most wall-clock time in
    // the "almost complete" region, so explicitly exercise it.
    const prefixLengths = [
      1, 2, 4, 8, 16, 32, 64, 96, 128, 160, 200, buffer.length - 1, buffer.length,
    ];
    for (const n of prefixLengths) {
      if (n > buffer.length) continue;
      const prefix = buffer.slice(0, n);
      const out = markdownToSabhaRichText(prefix);
      expect(
        isBalanced(out),
        `prefix length ${n} produced imbalanced HTML: ${JSON.stringify(out)}`,
      ).toBe(true);
    }
  });
});

describe("chunkMarkdownText integration with markdownToSabhaRichText", () => {
  it("chunks below limit returns single chunk", () => {
    expect(chunkMarkdownText("short", 100)).toEqual(["short"]);
  });

  it("empty input returns []", () => {
    expect(chunkMarkdownText("", 100)).toEqual([]);
  });

  it("each chunk individually converts to valid rich text", () => {
    const md =
      "First paragraph with **bold**.\n\n" +
      "Second paragraph with *italic*.\n\n" +
      "```\ncode\n```\n\n" +
      "- list one\n- list two";
    const chunks = chunkMarkdownText(md, 40);
    // Every chunk should convert cleanly with balanced tags.
    for (const chunk of chunks) {
      const out = markdownToSabhaRichText(chunk);
      expect(isBalanced(out), `chunk "${chunk}" produced ${out}`).toBe(true);
    }
  });

  it("keeps fenced code blocks intact when the fence fits under the limit", () => {
    // With a limit large enough to hold the fence block as a single unit,
    // splitPreservingCodeBlocks pulls it out as one paragraph and the
    // merge phase puts the whole thing in one chunk.
    const md = "before\n\n```\nline one\nline two\nline three\n```\n\nafter";
    const chunks = chunkMarkdownText(md, 100);
    const fenceChunks = chunks.filter((c) => c.includes("```"));
    for (const c of fenceChunks) {
      const fences = c.match(/```/g) ?? [];
      expect(fences.length % 2).toBe(0);
    }
  });

  it("never emits a chunk larger than the declared limit, even for a single oversize word", () => {
    // A 150-char base64-like blob with no whitespace. Previously
    // mergeSegments would push the whole segment unchanged. Now it hard-
    // slices so the ceiling is honored.
    const blob = "x".repeat(150);
    const chunks = chunkMarkdownText(blob, 40);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(40);
    }
    // Reassembling the chunks should reproduce the original.
    expect(chunks.join("")).toBe(blob);
  });

  it("line-splits a long list instead of word-splitting it", () => {
    // A long list as a single "paragraph" (no blank lines between items).
    // Previously splitLongBlock fell through to word-splitting which
    // destroyed the `- ` markers. Now line-split-first preserves them.
    const md = Array.from({ length: 20 }, (_, i) => `- item number ${i}`).join("\n");
    const chunks = chunkMarkdownText(md, 80);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(80);
      // Every non-empty line in every chunk must start with the list marker.
      for (const line of chunk.split("\n").filter(Boolean)) {
        expect(line).toMatch(/^- /);
      }
    }
  });

  it("re-wraps an overlong fenced code block so each sub-chunk is still a valid fence", () => {
    // Long code block > limit. Sub-chunks should each have matched ``` fences
    // on their own so downstream rendering doesn't see a bare code body.
    const body = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n");
    const md = "```ruby\n" + body + "\n```";
    const chunks = chunkMarkdownText(md, 80);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(80);
      // Every chunk starts with ```ruby and ends with ```.
      expect(chunk.startsWith("```ruby")).toBe(true);
      expect(chunk.trimEnd().endsWith("```")).toBe(true);
      // Fence count is even (open + close).
      const fenceCount = (chunk.match(/```/g) ?? []).length;
      expect(fenceCount).toBe(2);
    }
  });
});

// --- Helpers ---

/**
 * Minimal HTML tag balance check: every non-void opening tag must be
 * matched by a close tag in correct nesting order. Ignores void tags
 * (br, hr) and attribute contents.
 *
 * Deliberately permissive — the point is to catch cases where the regex
 * pipeline emits a half-open `<strong>` without the matching `</strong>`,
 * not to validate strict XHTML.
 */
function isBalanced(html: string): boolean {
  const voidTags = new Set(["br", "hr", "img", "input"]);
  const tagRe = /<\/?([a-zA-Z][a-zA-Z0-9]*)(?:\s[^>]*)?>/g;
  const stack: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = tagRe.exec(html)) !== null) {
    const full = match[0];
    const name = match[1]!.toLowerCase();
    if (voidTags.has(name)) continue;
    const isClose = full.startsWith("</");
    if (isClose) {
      if (stack.length === 0) return false;
      const top = stack.pop();
      if (top !== name) return false;
    } else {
      stack.push(name);
    }
  }
  return stack.length === 0;
}
