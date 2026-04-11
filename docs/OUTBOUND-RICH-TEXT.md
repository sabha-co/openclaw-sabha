# Outbound Rich Text Refactor (0.9.4)

Plan for fixing the outbound markdown → Sabha rich-text gap in the 0.9.4 release. Independent of the v1 work tracked in `~/Moss/Notes/Openclaw Sabha v1/` — this ships earlier because it's a straight bug fix with a known patch, and the v1 feature work (approvals, doctor improvements, etc.) shouldn't have to wait on it.

## What this is

The current plugin takes whatever `text` the OpenClaw reply pipeline hands it and POSTs it verbatim to `POST /rooms/{id}/{bot_key}/messages` with `Content-Type: text/plain`. Sabha stores message bodies as **ActionText rich text (Trix)** via `has_rich_text :body` on `Message`. The bot controller (`app/controllers/messages/by_bots_controller.rb:47-53`) reads the request body as a UTF-8 string and uses it as the rich-text body directly — no markdown parsing, no rendering step.

Result: an LLM reply like

```
**Here's what I found:**

- bullet one
- bullet two

```ruby
puts "hello"
```
```

lands in the Sabha UI as literal characters. The asterisks show, the dashes show, the triple-backticks show. Bold doesn't render, the list isn't a list, the fence isn't a code block. Users see raw markdown garbage on every bot reply that uses formatting.

This has been broken since 0.1.0. It wasn't caught earlier because short plain-text replies (one-line acknowledgements, search result snippets) look OK — the failure mode only shows up the moment an agent produces any formatted output, which is most of the time in practice.

## Why 0.9.4 and not v1

- **It's a bug, not a feature.** Every bot reply with markdown is visibly broken. Shipping this as part of v1 means shipping two more minor releases with known-bad formatting.
- **The fix is isolated.** No changes to inbound, no changes to dispatch, no changes to draft-stream's state machine, no changes to the bot account model. One new file + three edited files + tests.
- **There's a proven reference implementation.** `@37signals/openclaw-basecamp`'s `src/outbound/format.ts` is a regex-based markdown → ActionText HTML converter that's been running in production against the same ActionText + Trix backend Sabha uses. The module is 195 lines, zero dependencies, handles every common markdown construct, and has battle-tested tag choices. We reuse the module verbatim (plus one Sabha-specific addition for mentions) — not because we're matching Basecamp as a design principle, but because there's no reason to re-derive a parser that's already been tuned against identical requirements. Independent reasoning led us to the same regex pipeline; the fact that it already exists just lets us skip the rewrite.
- **The v1 `/skill` update depends on this.** v1's Sabha-side server change #2 (document the Trix wire format in `/skill`) is more convincing if the plugin already does the right thing at the wire — agents reading the updated `/skill` will have a plugin that backs up what the docs claim.

## What gets ported

The port target is `@37signals/openclaw-basecamp/src/outbound/format.ts`. It's a 195-line regex pipeline that handles every common markdown construct agents produce:

| Markdown | Trix HTML tag |
| --- | --- |
| `**bold**`, `__bold__` | `<strong>` |
| `*italic*`, `_italic_` | `<em>` |
| `~~strike~~` | `<del>` |
| `` `code` `` | `<code>` |
| ` ``` ` fenced blocks | `<pre class="language-X">` |
| `# h1` through `###### h6` | `<h1>` through `<h6>` |
| `> quote` (multi-line) | `<blockquote>` |
| `- list`, `* list`, `+ list` | `<ul><li>` |
| `1. list` | `<ol><li>` |
| `[text](url)` | `<a href>` |
| `---`, `***`, `___` | `<hr>` |
| `\| table \|` | `<pre>` wrapping raw pipe text (Sabha downgrade — see §Three deltas) |
| paragraph separation | `<br><br>` between blocks |
| single `\n` inside paragraph | `<br>` |

Plus the reverse helper `basecampHtmlToPlainText` (rename: `sabhaRichTextToPlainText`) that strips HTML back to plain text for inbound / tool-response paths that need to hand text back to the agent.

Plus the chunker `chunkMarkdownText` from the same module family, which splits markdown-before-conversion at block boundaries so a single outbound reply can be broken across multiple messages without tearing a code fence or list in half.

### Three places where the pipeline produces non-canonical Trix

Three cases where the regex pipeline's output isn't what the Trix editor natively round-trips. Each is a real choice, not an accident. Going through them one at a time with Sabha-specific reasoning:

1. **Headings are emitted as `<h1>`–`<h6>`** even though Trix's editor config only supports `<h1>` natively. Sabha's `ContentFilters::SanitizeTags::ALLOWED_TAGS` explicitly includes all six heading levels, so they render correctly in the UI. The only failure mode is "human opens a bot message in the Trix editor to edit it, sees h2–h6 flattened to a plain block," which for Sabha is fine because (a) bot messages are edited by humans approximately never, (b) agents legitimately use multi-level headings for structured responses like triage reports, and (c) flattening every `###` to `<h1>` would produce visually wrong output in the display path, which is the path that actually matters.

2. **Paragraph separation uses `<br><br>`** between blocks rather than wrapping each paragraph in `<div>`. Sabha's sanitizer allows `br`, `div`, and `p` all three, so alternatives exist but there's no reason to change what works. Visually identical in the rendered output. Different under the hood for Trix's document model — on editor reload, the paragraphs might collapse into one block with inline line breaks instead of separate blocks. Functionally equivalent for display and for the mention/search pipelines that read from the stored body. For Sabha, where bot messages are read and not edited, the difference is invisible.

3. **Pipe tables downgrade to `<pre>` wrapping** — the one place we deviate from Basecamp's pipeline. Basecamp emits `<table><thead><tbody><tr><th><td>` for markdown pipe tables, which works in Basecamp because Basecamp's deployment passes table tags through its ActionText sanitizer. **Sabha's `ContentFilters::SanitizeTags::ALLOWED_TAGS` does not include any table tags** (verified against `app/helpers/content_filters/sanitize_tags.rb`), so Basecamp's `<table>` output would be silently stripped at display time — the entire table element and its contents would be removed by `fragment.replace(not_allowed_tags_css_selector) { nil }`, and the user would see nothing where the table used to be. That's strictly worse than displaying the raw pipe characters.

   The fix is to downgrade markdown pipe tables to a `<pre>` block containing the raw pipe-table text (HTML-escaped). `<pre>` is in Sabha's allowlist, and monospace rendering preserves column alignment — readable and aligned, just not rendered as an HTML table with borders.

   The one regex change in the ported pipeline:

   ```ts
   // Instead of Basecamp's <table><thead>/<tbody>/<tr>/<th>/<td> assembly:
   html = html.replace(/(?:^|\n)((?:\|[^\n]+\|(?:\n|$))+)/g, (_match, block, offset) => {
     // Same "is this a real table" check — second row must be separator
     const rows = block.trim().split("\n");
     if (rows.length < 2 || !/^[\s|:-]+$/.test(rows[1]!)) return _match;
     // Downgrade: wrap the raw pipe-table text in <pre>, escape contents
     return `\n<pre>${escapeHtml(block.trimEnd())}</pre>\n`;
   });
   ```

   Upside vs. a server-side sanitizer PR to add table tags: 0.9.4 ships self-contained without depending on a Sabha server deploy. A follow-up plugin release can swap back to real `<table>` rendering once a server PR adds table tags to `ALLOWED_TAGS` — tracked as a separate item in `~/Moss/Notes/Openclaw Sabha v1/Sabha Server Changes for v1.md`.

**Decision: deltas 1 and 2 ship as Basecamp emits them; delta 3 downgrades to `<pre>`.** Deltas 1 and 2 are the right choices for Sabha because Sabha's sanitizer allowlist explicitly permits them. Delta 3 deviates because Sabha's sanitizer explicitly doesn't permit tables and we'd rather ship a readable monospace fallback than emit output that gets stripped to nothing.

The module header comment will document all three with the reasoning above, so the next reader doesn't have to re-derive it.

### Sanitizer verification

The "what's allowed through display" question was answered by reading Sabha's live sanitizer config, not by assuming Rails defaults. Reference files and what they establish:

- **`config/initializers/action_text.rb`** (11 lines) — extends `Rails::HTML4::SafeListSanitizer` with `details summary section turbo-frame` and a handful of `data-*` attributes for the mention popup. Doesn't touch the tag allowlist we care about.
- **`app/helpers/content_filters/sanitize_tags.rb`** (17 lines) — defines `ContentFilters::SanitizeTags::ALLOWED_TAGS`, a hand-curated allowlist that runs via `fragment.replace(not_allowed_tags_css_selector) { nil }`:

  ```ruby
  ALLOWED_TAGS = %w[ a abbr acronym address b big blockquote br cite code dd del dfn div dl dt em
    h1 h2 h3 h4 h5 h6 hr i ins kbd li ol
    p pre samp small span strong sub sup time tt ul var
    details summary section turbo-frame
  ] + [ ActionText::Attachment.tag_name, "figure", "figcaption" ]
  ```

- **`app/helpers/content_filters.rb`** (5 lines) — composes `SanitizeTags` with two other filters (`RemoveSoloUnfurledLinkText`, `StyleUnfurledTwitterAvatars`) into the `text_message_presentation_filters` chain.
- **`app/helpers/messages_helper.rb:118`** — where the filter chain is actually applied:

  ```ruby
  auto_link h(ContentFilters.text_message_presentation_filters.apply(message.body.body)), …
  ```

  This runs on **every message render**, not at save time. So content can contain anything in storage but only allowlist tags make it to the user's screen.

Cross-checking every tag the ported pipeline emits against this allowlist:

| Emitted | Survives `ALLOWED_TAGS`? |
| --- | --- |
| `<strong>`, `<em>`, `<del>`, `<code>`, `<pre>`, `<blockquote>`, `<ul>`, `<ol>`, `<li>`, `<a>`, `<hr>`, `<br>`, `<div>` | ✅ yes |
| `<h1>`, `<h2>`, `<h3>`, `<h4>`, `<h5>`, `<h6>` | ✅ all six explicitly listed |
| `<table>`, `<thead>`, `<tbody>`, `<tr>`, `<th>`, `<td>` | ❌ **none present — strip with contents** |

That's where delta 3 comes from: `<table>` family tags get stripped at render time along with everything inside them. The `<pre>` downgrade sidesteps the allowlist entirely.

**Verification date**: initial check 2026-04-12 against Sabha `main` HEAD. If `sanitize_tags.rb` or the `ALLOWED_TAGS` constant change, re-run this check and update the pipeline accordingly.

### Sabha-specific additions

Two things Basecamp's pipeline doesn't need but Sabha does.

1. **Mention placeholder pass.** Sabha's bot API accepts `@{user_id}` literal tokens in the message body and the server's `format_mentions` (in `by_bots_controller.rb:55-66`) rewrites them to full `<action-text-attachment>` tags at save time. For this to work, the `@{42}` token has to survive the markdown pipeline without getting HTML-escaped or mangled by any of the regex passes. The fix is a standard protect-a-token-through-a-pipeline trick: substitute `@{\d+}` for a NUL-delimited placeholder up front, run the entire pipeline, and restore the literals at the end.

   NUL (`\u0000`) is chosen as the delimiter because it cannot legally appear in any markdown input an LLM would produce — zero collision risk with legitimate agent output.

   ~15 lines. Lives inside `markdownToSabhaRichText` as bookend passes.

2. **Mentions inside code spans are NOT protected.** If an agent writes `` `@{42}` ``, the backtick-wrapped `@{42}` goes through the inline-code pass and becomes `<code>@{42}</code>` — which is exactly the right behavior because the server's `format_mentions` runs on the stored body and would rewrite `@{42}` inside a `<code>` tag too, creating an ugly half-mention inside a code block. By escaping the mention token **before** the code-span regex runs, the placeholder gets wrapped in `<code>…</code>` and the literal `@{42}` is restored inside the code tag, where the server will then correctly rewrite it if needed. Document this in tests — agents who want a literal `@{42}` in their code have no way to express it through this pipeline. Acceptable for v1.

## Where the conversion lives

`SabhaClient.sendMessage` / `editMessage` / `replyInThread` — the low-level client. Same layer as every other wire-contract fact the client already knows.

### The argument, short version

Sabha's bot API contract includes facts like:

- The body is POSTed with `Content-Type: text/plain`.
- Authentication is `bot_key` embedded in the URL path, not an `Authorization` header.
- The response's `Location` header is the canonical reference to the newly created message.
- Attachments go through `multipart/form-data` with an `attachment` field.
- Thread replies hit a nested URL shape (`/messages/{id}/thread`).
- Edits use PATCH; deletes use DELETE.

`SabhaClient` already encodes every one of those. They're all "how Sabha expects to see a request" facts, and they all live in the same module because that's the module whose job is to speak Sabha's wire protocol.

**"The body is stored as ActionText rich text, so markdown must be converted to a Trix-compatible HTML subset before it's POSTed" is the same kind of fact.** It's not about what the caller intended; it's about what Sabha expects on the wire. It belongs in the same place as all the other wire facts — the client.

Put another way: every caller of `SabhaClient.sendMessage` today believes they're sending "text that will appear in the room." Sabha's actual storage model makes that belief wrong unless the caller knows about the rich-text subset. Pushing the knowledge of "the body must be Trix-compatible HTML" onto every caller is a layering violation — the client is the only place that knows everything else about how to form a Sabha request, so it's the only place that should know this too.

### Callers and why they all benefit from client-level placement

Sabha has four consumers of `SabhaClient`'s text-sending methods today:

1. **Reply pipeline `deliver` callback** in `index.ts` and `monitor.ts` — the dominant path; runs once per final agent response.
2. **`outbound.attachedResults.sendText`** in `channel.ts` — wired to OpenClaw core's shared `message` tool for freeform agent text sends.
3. **Agent tools** in `src/tools.ts` — e.g. `sabha_create_dm` with a reply body.
4. **`src/draft-stream.ts`** — PATCHes `editMessage` per token batch as the LLM streams.

With the converter at client level, none of these have to know about markdown → Trix conversion. They all treat `SabhaClient.sendMessage(roomId, text)` as "send this text to this room" and the right thing happens. That's the contract callers already believe they're using; client-level placement makes that belief correct without asking anyone to change how they call the client.

Especially for **draft-stream**: its job is to own the state machine for "preview message that gets patched as tokens arrive." Making it *also* own rich-text conversion would leak a concern from a different axis into the streaming module. With the converter underneath, draft-stream stays focused on streaming.

### What the outbound adapter still does

The `outbound.base` slot on `channel.ts` still wires:

```ts
base: {
  deliveryMode: "direct",
  textChunkLimit: 10000,
  chunkerMode: "markdown",
  chunker: (text, limit) => chunkMarkdownText(text, limit),
},
```

Chunking stays at the adapter level because it's a **reply pipeline concern**, not a client concern. The reply pipeline calls the chunker to split long agent replies into multiple messages; each chunk is then passed to `sendText`, which threads through the client's converter. Markdown is chunked in markdown-space (respecting block boundaries) so that no chunk gets split mid-`<pre>` or mid-`<ul>`. After chunking, each chunk is individually valid markdown, and the client converts each to valid HTML. The two concerns compose cleanly at their respective layers.

Callers that bypass the reply pipeline take two different positions on chunking:

- **Agent tools** (`sabha_create_dm`, etc.) produce short structured messages by construction — no chunking needed, no chunking applied.
- **Draft-stream deliberately doesn't chunk** even though its buffer can exceed `textChunkLimit` in practice. Streaming agent replies routinely produce >10k chars when an agent emits a long analysis or multi-step plan, and draft-stream calls `editMessage` with the entire accumulated buffer on every PATCH. Chunking would break the "single message being edited in place" metaphor that makes the preview work — you can't chunk a preview without either (a) producing multi-message previews, which breaks the edit-in-place UX, or (b) chunking only after streaming ends, which means the preview grows without bound during streaming anyway. Both are worse than today's "one long Trix message, Sabha handles it fine in practice." Known asymmetry with pipeline-driven replies: long pipeline replies get chunked into multiple messages, long streaming replies stay as one long message. Finalize-time chunking of streaming replies is a separate design problem that doesn't belong in this refactor — revisit if long streaming replies turn out to cause a real problem in production.

### `sendRawRichText` escape hatch

A sibling method on `SabhaClient` for callers that have already produced Trix-compatible HTML:

```ts
/**
 * Send pre-formatted Trix HTML without running it through the markdown
 * converter. Intended for callers that build a structured HTML payload
 * from typed data (e.g. a future status-card tool).
 *
 * Do NOT call this from draft-stream.ts. Streaming previews require the
 * converter to run on every PATCH to guarantee edit-boundary coherence —
 * hand-maintained HTML buffers inside draft-stream will produce visible
 * flicker as partial markdown constructs complete. Use editMessage() and
 * let the client-level converter handle it.
 */
async sendRawRichText(roomId: number, html: string): Promise<number | null>
```

Identical wire shape to `sendMessage`, but sends `html` verbatim. Use cases:

- An agent tool that assembles a known-shape HTML blob from structured data (e.g., a future "status card" tool).
- Tests that want to assert byte-equal output against the server's stored form.
- Any caller that genuinely has Trix HTML and would double-convert if it went through `sendMessage`.

**Explicit non-use**: draft-stream. The JSDoc above is the load-bearing hint. Streaming previews require the converter to run on every PATCH so that partial markdown constructs complete cleanly when the closing delimiter arrives — if draft-stream tried to maintain its own running HTML buffer and call `sendRawRichText`, the "what HTML does my buffer currently represent" question would have to be answered consistently across PATCHes, and the client-side converter already handles that as a pure function of "current markdown buffer." Any hand-rolled HTML generation inside draft-stream would produce visible tear/flicker at edit boundaries. Documented in the JSDoc so the next person refactoring draft-stream doesn't reach for this method thinking it skips "unnecessary work."

Not wired to the outbound adapter slot, not reachable from the reply pipeline. Callers reach for it explicitly. It's on the client rather than as a free-standing helper because it's a **send-method variant**, not a formatting variant — the right mental model is "same wire path, skip the pre-processing step," not "format this then call some other thing."

### Quick cross-check against the other in-tree plugins

Where do the other OpenClaw plugins put conversion? Not a "we should match them" question, just a sanity check that our placement is in a sensible neighborhood.

- **Slack** (`extensions/slack/src/outbound-adapter.ts`) — adapter level via `chunker: markdownToSlackMrkdwnChunks`. Slack speaks its own mrkdwn dialect; chunker + converter are the same call. Client (`send.ts`) is a Slack API wrapper that takes already-rendered mrkdwn.
- **Telegram** (`extensions/telegram/src/outbound-adapter.ts`) — adapter level via `chunker: markdownToTelegramHtmlChunks` and `sendText` passes rendered HTML with `parse_mode: "HTML"`. Same pattern as Slack.
- **Mattermost** — no converter at all. Mattermost natively renders markdown, so the plugin passes through with a `normalizeOptionalString` cleanup.
- **Discord** — no converter at all. Discord natively renders markdown. `chunk.ts` handles code-fence-aware splitting.
- **Basecamp** — dispatch level (explicit call in `dispatch.ts:239`). Client is a thin OpenAPI wrapper.
- **Sabha (this plan)** — client level.

Five different answers for five different situations. The through-line isn't "use this layer" — it's "put conversion wherever the wire-format knowledge already lives for that plugin's architecture." For Slack and Telegram, the adapter owns the chunking+rendering coupling. For Mattermost and Discord, there's nothing to convert. For Basecamp, the client is a generated SDK that can't grow opinions. For Sabha, the client is hand-written and already owns every other wire fact — so the converter joins the rest of the wire-contract knowledge there.

That makes client-level the right answer *for Sabha*, derived from Sabha's architecture rather than copied from anywhere else.

## Config plumbing

Wire the chunker into `src/channel.ts` `outbound.base`:

```ts
base: {
  deliveryMode: "direct",
  textChunkLimit: 10000,
  chunkerMode: "markdown",
  chunker: (text, limit) => chunkMarkdownText(text, limit),
},
```

Currently `textChunkLimit: 10000` is set but no chunker is wired, so chunking is effectively disabled. 10000 is kept as the initial ceiling; revisit if we hit Trix's practical limit for a single stored message. (Campfire's front-end render tree handles very long messages fine in practice, but there's probably a DB row size at which things get ugly. Not a v0.9.4 problem.)

## Draft-stream interaction

`src/draft-stream.ts` currently PATCHes the Sabha message with accumulating partial text as LLM tokens arrive. After the refactor, every PATCH will pass partial markdown through `markdownToSabhaRichText`.

Two things to verify during implementation:

1. **Graceful degradation on unclosed markdown.** If the stream has `**half-bold` without the closing `**`, the converter should emit `**half-bold` as literal text (since the regex never matches), not corrupt state. Basecamp's pipeline handles this because its regexes are all `.+?` non-greedy and require closing tokens — unclosed spans just don't match. Test coverage: PATCH at every position of a known-good formatted message and assert no crashes, even with truncated input.

2. **Flicker on in-progress code fences.** When the agent is mid-emission of a ` ``` ` block, the stream will briefly contain an unclosed fence. The converter won't wrap it in `<pre>` until the closing fence arrives. Users see raw triple-backticks for a few hundred ms, then they snap to a rendered code block. This is acceptable for v0.9.4 — documented as a known minor flicker, revisit in a later release if users complain. The alternative (stream-aware partial parsing) is substantially more work and not worth it pre-v1.

No changes needed to `draft-stream.ts` itself. It already calls the client's send methods; the converter just sits underneath.

## Files changed

Net delta:

### New

- `src/outbound/format.ts` — ported from Basecamp, renamed, with mention pass and module-header comment explaining the three deltas and pointing at Basecamp as the reference implementation.
- `src/outbound/util.ts` — the two private helpers Basecamp's `format.ts` pulls from its own `util.ts`: `decodeEntities`, `stripTags`. About 30 lines.
- `src/outbound/format.test.ts` — tag coverage (every row of the table above), mention preservation cases, empty-input, nested blocks, unclosed-markdown safety, chunking boundaries.

### Edited

- `src/client.ts` — thread `markdownToSabhaRichText` through `sendMessage`, `editMessage`, `replyInThread`. Add `sendRawRichText` sibling.
- `src/channel.ts` — add `chunker` and `chunkerMode` to `outbound.base`.
- `CLAUDE.md` — new bullet under "Design decisions worth knowing": "Outbound text is converted markdown → ActionText/Trix HTML via `src/outbound/format.ts`, ported from `@37signals/openclaw-basecamp`. The conversion lives in `SabhaClient` so all three outbound paths (reply pipeline, `outbound.sendText`, agent tools) get it uniformly. Use `sendRawRichText` if you already produced Trix HTML."

### Unchanged

- `src/tools.ts` — no changes. Tools that call `SabhaClient.sendMessage` (e.g. `sabha_create_dm` reply bodies) will automatically get the converter because it's client-level. This is the whole point of the client-level placement.
- `src/draft-stream.ts` — see above. No code changes; behavior changes because the client underneath it is smarter.
- `src/monitor.ts`, `src/inbound.ts`, `src/webhook.ts` — inbound path is untouched. Inbound messages already come with `{html, plain}` pre-rendered by the server, so there's no conversion step needed on the way in.
- `src/bot-accounts.ts` — no interaction with outbound formatting.

Rough size: ~250 lines added (format.ts + util.ts + mention pass + tests), ~30 lines edited (client.ts + channel.ts).

## Test plan

### Unit: `src/outbound/format.test.ts`

Lift Basecamp's `outbound/format.test.ts` if it exists in the upstream repo; otherwise write from scratch. Table-driven cases, one per:

- Each style tag individually (`**bold**`, `*italic*`, `~~strike~~`, `` `code` ``, fenced code with and without language, h1 through h6, blockquote, ul, ol, link, hr, `<br>` within paragraph, paragraph separator).
- **Pipe table → `<pre>` downgrade** (delta 3):
  - Standard 2-column table with header + separator + two body rows → single `<pre>` block, contents HTML-escaped, newlines preserved, column alignment intact as monospace text.
  - Invalid "table" (missing separator row) → falls through unchanged, treated as plain text by later phases.
  - Table with cells containing HTML-special characters (`<`, `>`, `&`) → escaped inside the `<pre>`, no injection.
  - Table containing a `@{42}` mention → mention placeholder survives the `<pre>` wrap, emerges as literal `@{42}` inside `<pre>@{42}</pre>`.
  - Table adjacent to other blocks → `<pre>` block is emitted with its own paragraph break, doesn't bleed into adjacent `<strong>` / `<ul>`.
- Empty input → empty output.
- Plain text with no markdown → text passes through unchanged (HTML-escaped).
- HTML-special characters in plain text get escaped (`<script>` → `&lt;script&gt;`).
- Mention preservation:
  - `@{42}` alone → `@{42}` in output
  - `**@{42}**` → `<strong>@{42}</strong>`
  - `@{1} and @{2}` → both preserved
  - `- @{1} to review` → `<ul><li>@{1} to review</li></ul>`
  - `[@{42}](https://ex.com)` → `<a href="https://ex.com">@{42}</a>`
  - `` `@{42}` `` → `<code>@{42}</code>` (mention inside code block, server will still rewrite — documented quirk)
  - `@{nonumeric}` → falls through, gets HTML-escaped normally
  - Adjacent: `@{1}@{2}` → both preserved
- Unclosed markdown (draft-stream safety):
  - Single-token unclosed: `**half` → `**half`, ` ```unclosed ` → literal backticks, `[text](unclosed` → literal text.
  - **Nested partial state**: `**bold *italic` → neither wrap applied, both delimiters emitted as literal text. No half-open `<strong>` or `<em>` tags.
  - **Nested partial with inner close**: `**bold *italic*` → inner em closes normally (`<em>italic</em>`), outer strong stays as literal `**` because it never closed.
  - **Mid-list truncation**: `- item one\n- item two\n- ` → two `<li>` entries, trailing `-` as literal.
  - **Mid-blockquote at buffer end**: `> line one\n> line two` (no trailing blank) → `<blockquote>` still captures both lines.
  - **Edit-boundary coherence (the real draft-stream test)**: for a representative streaming buffer, run the converter on every prefix of length `n` for `n ∈ {1, 2, 4, 8, 16, 32, 64, 128, 256, 512}` and assert each output has **balanced tag nesting** — every opened tag has a matching close. No intermediate state produces invalid HTML that would render as broken markup. Accepts that rendered content can legitimately change when a construct completes (e.g. `**bold` → `<strong>bold</strong>` when the closing `**` arrives) — that's the construct completing, not a flicker. The assertion is purely about structural validity at every prefix, not about content stability.

### Integration: smoke against local Sabha

- Boot Sabha locally (`cd ~/dev/sabha && bin/rails s`).
- Register a test bot via the join code flow.
- Run the plugin against localhost and send messages containing each formatting construct from the unit tests.
- Verify in the Sabha web UI that each renders correctly — bold is bold, list is a list, code block is a code block, mention is a real pill.
- Edit a bot message from the UI to confirm Trix editor behavior matches expectations (minor degradation on h2-h6 and tables acceptable).

### Regression

- Existing draft-stream tests (`src/draft-stream.test.ts`, `src/channel.test.ts`) pass unchanged. The client send signature is unchanged; the behavior change is internal.
- Existing inbound dedup and self-echo tests (`src/inbound.test.ts`) unaffected — this PR doesn't touch inbound.

### Manual: does it actually look right

Post a representative LLM response in a local Sabha room and eyeball it. The representative response I'm using for the eye test:

```
Here are the **3 open issues** I found:

1. Auth middleware race condition (@{17} is owning this)
2. Missing rate limiter on `/api/search`
3. Stale token in the CI env

Code from the first one:
```ruby
class AuthMiddleware
  def call(env)
    Current.user = authenticate(env) || raise(Unauthorized)
  end
end
```

Let me know if you want me to file tickets for any of these — or `@{17}`, feel free to take it.
```

Expected in Sabha UI:

- Bold "3 open issues"
- Ordered list with 3 items
- `@{17}` in item 1 and in the closing line both render as real mention pills linked to user 17
- Inline `` `/api/search` `` and `` `@{17}` ``-in-backticks both render as monospace code
- Fenced Ruby block renders as a code block
- Paragraph breaks between sections work
- No raw `**`, no raw `-`, no raw triple-backticks visible

## Ship order

1. Write `src/outbound/format.ts` + `src/outbound/util.ts` + `src/outbound/format.test.ts` on a feature branch.
2. `npm test && npm run lint && npm run build` all green.
3. Wire into `src/client.ts`: thread converter through send methods, add `sendRawRichText`.
4. Wire into `src/channel.ts`: `chunkerMode: "markdown"`, `chunker`.
5. Re-run full test suite. Existing tests should pass unchanged; if anything breaks, the client-level placement was wrong and we need to think about it.
6. Manual smoke against local Sabha (see test plan).
7. Update CLAUDE.md.
8. Bump version to 0.9.4 in `package.json`.
9. Open PR titled something like "Convert outbound markdown to ActionText rich text".
10. PR description links to this doc for context.
11. Merge, tag, publish.

## Out of scope for 0.9.4

Deferred to later releases:

- **Streaming-aware partial markdown parsing.** Accept flicker on in-progress code fences for now.
- **Per-room member cache for `@name` → `@{user_id}` rewrite.** Agents get `@{user_id}` via `/skill` + event payload IDs; no plugin-side name resolution. Revisit only if real usage shows agents fighting the numeric-ID syntax.
- **`/skill` wire-format documentation.** Lives in the v1 plan — it's a server PR that depends on where the server repo is in its release cycle, and the plugin works fine against the current `/skill` once this refactor lands.
- **429 / Retry-After handling in `SabhaClient.fetch`.** Separate bug, different scope, lives in v1.
- **SSRF guard on send paths.** Already in place for attachment fetch; outbound text send doesn't hit user-controlled URLs.
- **Chunker byte-limit tuning.** 10000 is fine as an initial ceiling. Revisit if we hit real message-size issues.
- **Interactive cards, approval buttons, component UIs.** All v1 territory, all depend on server features that don't exist yet.

## References

- Basecamp's ported file: `/Users/ashwin/dev/openclaw-basecamp/src/outbound/format.ts` (195 lines)
- Basecamp's helper util: `/Users/ashwin/dev/openclaw-basecamp/src/util.ts` (56 lines; we only need `decodeEntities` and `stripTags`)
- Sabha bot message controller: `/Users/ashwin/dev/sabha/app/controllers/messages/by_bots_controller.rb` — `format_mentions` + `mention_user` is the rewrite contract we're preserving.
- Sabha Message model: `/Users/ashwin/dev/sabha/app/models/message.rb:15` — `has_rich_text :body` is why the wire format is Trix HTML.
- Sabha mention model: `/Users/ashwin/dev/sabha/app/models/user/mentionable.rb` + `/Users/ashwin/dev/sabha/app/models/message/mentionee.rb` — the ActionText attachable pipeline the server uses to discover mentions in the stored body.
- Trix editor config: https://github.com/basecamp/trix — `config/text_attributes.js`, `config/block_attributes.js`.
- ActionText sanitizer (more permissive than Trix editor config, which is why deltas 1/2/3 work at all): https://guides.rubyonrails.org/action_text_overview.html
- Plan discussion context: `~/Moss/Notes/openclaw (1)/Sabha vs Basecamp openclaw plugin comparison/Sabha vs Basecamp openclaw plugin comparison.md` — section "Outbound model" for background on why this was broken.
- v1 plan: `~/Moss/Notes/Openclaw Sabha v1/` — separate from this; this ships first.
