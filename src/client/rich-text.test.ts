import { describe, expect, it } from "vitest";
import { markdownToSabhaHtml } from "./rich-text.js";

describe("markdownToSabhaHtml", () => {
  it("renders inline styles inside a paragraph", () => {
    expect(markdownToSabhaHtml("**bold** *em* ~~gone~~ `x < y`")).toBe(
      "<p><strong>bold</strong> <em>em</em> <s>gone</s> <code>x &lt; y</code></p>",
    );
  });

  it("escapes raw HTML and entities instead of passing them through", () => {
    expect(markdownToSabhaHtml("a < b & <script>alert(1)</script>")).toBe(
      "<p>a &lt; b &amp; &lt;script&gt;alert(1)&lt;/script&gt;</p>",
    );
  });

  it("keeps mention tokens for the server to resolve", () => {
    expect(markdownToSabhaHtml("hi @{42}, see `@{7}`")).toBe("<p>hi @{42}, see <code>@{7}</code></p>");
  });

  it("treats single newlines as line breaks and blank lines as paragraphs", () => {
    expect(markdownToSabhaHtml("one\ntwo\n\nthree")).toBe("<p>one<br>\ntwo</p>\n<p>three</p>");
  });

  it("exports fenced code the way Lexxy does", () => {
    expect(markdownToSabhaHtml("```ts\nconst a = 1 < 2;\n```")).toBe('<pre data-language="ts">const a = 1 &lt; 2;</pre>');
    expect(markdownToSabhaHtml("```\nplain\n```")).toBe("<pre>plain</pre>");
    expect(markdownToSabhaHtml('```x" onload="y\nz\n```')).toBe("<pre>z</pre>");
  });

  it("renders GFM tables as real tables", () => {
    const html = markdownToSabhaHtml("| a | b |\n|---|---|\n| 1 | 2 |");
    expect(html).toContain("<table>");
    expect(html).toContain("<th>a</th>");
    expect(html).toContain("<td>2</td>");
  });

  it("renders headings, lists, quotes and rules", () => {
    expect(markdownToSabhaHtml("## Title")).toBe("<h2>Title</h2>");
    expect(markdownToSabhaHtml("- a\n- b")).toBe("<ul>\n<li>a</li>\n<li>b</li>\n</ul>");
    expect(markdownToSabhaHtml("1. a\n2. b")).toBe("<ol>\n<li>a</li>\n<li>b</li>\n</ol>");
    expect(markdownToSabhaHtml("> quoted")).toBe("<blockquote>\n<p>quoted</p>\n</blockquote>");
    expect(markdownToSabhaHtml("---")).toBe("<hr>");
  });

  it("links URLs and refuses unsafe link schemes", () => {
    expect(markdownToSabhaHtml("see https://example.com/a_(b)")).toBe(
      '<p>see <a href="https://example.com/a_(b)">https://example.com/a_(b)</a></p>',
    );
    expect(markdownToSabhaHtml("[x](javascript:alert(1))")).toBe("<p>[x](javascript:alert(1))</p>");
  });

  it("turns images into links rather than hotlinking them", () => {
    expect(markdownToSabhaHtml("![chart](https://example.com/c.png)")).toBe(
      '<p><a href="https://example.com/c.png">chart</a></p>',
    );
  });

  it("returns an empty string for blank input", () => {
    expect(markdownToSabhaHtml("  \n ")).toBe("");
  });
});
