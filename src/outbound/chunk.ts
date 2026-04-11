/**
 * Markdown-aware chunker for long agent replies.
 *
 * Splits a markdown string into chunks ≤ `limit` characters, respecting
 * block boundaries so no chunk tears a fenced code block or list in half.
 * The reply pipeline calls this before handing each chunk to `sendText`
 * — each chunk is individually valid markdown, which then converts to
 * individually valid Trix HTML via `markdownToSabhaRichText`.
 *
 * Ported from @37signals/openclaw-basecamp/src/adapters/outbound.ts. The
 * chunking strategy is identical — only the module location and the
 * hard-coded limit are changed (we let callers pass the limit explicitly
 * instead of exporting a per-plugin constant).
 */

/**
 * Split text into chunks that fit within a character limit.
 *
 * Strategy (in priority order):
 * 1. Split on paragraph boundaries (double newline), keeping fenced code
 *    blocks intact as single "paragraphs"
 * 2. Fall back to sentence boundaries (. ! ?)
 * 3. Fall back to word boundaries (space)
 */
export function chunkMarkdownText(text: string, limit: number): string[] {
  if (!text) return [];
  if (text.length <= limit) return [text];

  const paragraphs = splitPreservingCodeBlocks(text);
  const chunks: string[] = [];
  let current = "";

  for (const para of paragraphs) {
    const candidate = current ? `${current}\n\n${para}` : para;

    if (candidate.length <= limit) {
      current = candidate;
      continue;
    }

    if (current) {
      chunks.push(current);
      current = "";
    }

    if (para.length <= limit) {
      current = para;
      continue;
    }

    const subChunks = splitLongBlock(para, limit);
    for (let i = 0; i < subChunks.length - 1; i++) {
      chunks.push(subChunks[i]!);
    }
    current = subChunks[subChunks.length - 1] ?? "";
  }

  if (current) {
    chunks.push(current);
  }

  return chunks;
}

/**
 * Split text on paragraph boundaries while keeping fenced code blocks
 * (```...```) together as single units.
 */
function splitPreservingCodeBlocks(text: string): string[] {
  const parts: string[] = [];
  const codeBlockRe = /```[\s\S]*?```/g;
  let lastIdx = 0;
  let match: RegExpExecArray | null;

  while ((match = codeBlockRe.exec(text)) !== null) {
    if (match.index > lastIdx) {
      const before = text.slice(lastIdx, match.index);
      parts.push(...before.split(/\n\n/).filter(Boolean));
    }
    parts.push(match[0]);
    lastIdx = codeBlockRe.lastIndex;
  }

  if (lastIdx < text.length) {
    parts.push(...text.slice(lastIdx).split(/\n\n/).filter(Boolean));
  }

  return parts;
}

/**
 * Split a long block of text that exceeds the chunk limit.
 *
 * Strategy (in order):
 *   1. Fenced code blocks get line-split with each sub-chunk re-wrapped in
 *      ``` markers so every chunk remains independently valid markdown.
 *   2. Any other block gets line-split first (preserves list markers,
 *      blockquote prefixes, paragraph structure), then sentence-split,
 *      then word-split as a last resort.
 *
 * The fallback for "a single line is still longer than the limit" (e.g. a
 * 15k base64 blob with no whitespace) is a hard character-slice in
 * `mergeSegments`, which breaks whatever the content is but guarantees
 * the declared chunk limit is honored.
 */
function splitLongBlock(text: string, limit: number): string[] {
  // Fenced code block: preserve fence markers across sub-chunks so each
  // chunk is still a valid fenced block on its own.
  const fenceMatch = text.match(/^(```[^\n]*)\n([\s\S]*?)\n(```)\s*$/);
  if (fenceMatch) {
    const [, openFence, body, closeFence] = fenceMatch;
    // Reserve overhead for the re-wrapped fence markers plus newlines.
    const overhead = openFence!.length + closeFence!.length + 2;
    const bodyLimit = Math.max(1, limit - overhead);
    const bodyChunks = mergeSegments(
      body!.split("\n").map((line, i, arr) => (i < arr.length - 1 ? line + "\n" : line)),
      bodyLimit,
    );
    return bodyChunks.map((chunk) => `${openFence}\n${chunk}\n${closeFence}`);
  }

  // Line-split first so list markers (`- `, `1. `), blockquote prefixes
  // (`> `), and paragraph breaks survive. Each line is re-suffixed with a
  // newline (except the last) so the merged chunks stay well-formed.
  const lines = text.split("\n");
  if (lines.length > 1) {
    const lineSegments = lines.map((line, i) => (i < lines.length - 1 ? line + "\n" : line));
    const merged = mergeSegments(lineSegments, limit);
    // If every merged chunk already fits, we're done. Otherwise fall
    // through to sentence/word splitting for the stragglers.
    if (merged.every((chunk) => chunk.length <= limit)) {
      return merged;
    }
  }

  // Sentence split — works when a single paragraph has multiple sentences.
  const sentences = text.match(/[^.!?]+[.!?]+\s*/g);
  if (sentences && sentences.length > 1) {
    return mergeSegments(sentences, limit);
  }

  // Last resort: word split.
  const words = text.split(/\s+/);
  return mergeSegments(
    words.map((w, i) => (i < words.length - 1 ? w + " " : w)),
    limit,
  );
}

/** Merge an array of text segments into chunks that fit within the limit. */
function mergeSegments(segments: string[], limit: number): string[] {
  const chunks: string[] = [];
  let current = "";

  for (const seg of segments) {
    const trimmed = seg.trimEnd();
    const candidate = current ? current + seg : seg;

    if (candidate.length <= limit) {
      current = candidate;
      continue;
    }

    if (current) {
      chunks.push(current.trimEnd());
      current = "";
    }

    if (trimmed.length > limit) {
      // Single segment is itself too long for the limit (e.g. one very
      // long word, URL, or base64 blob with no internal whitespace).
      // Hard-slice at `limit` chars so we never emit a chunk larger than
      // the declared ceiling. Breaks mid-content, but any alternative
      // would silently violate the chunk contract.
      for (let i = 0; i < trimmed.length; i += limit) {
        chunks.push(trimmed.slice(i, i + limit));
      }
    } else {
      current = seg;
    }
  }

  if (current.trimEnd()) {
    chunks.push(current.trimEnd());
  }

  return chunks;
}
