# Test prompts for the production Sabha bot

Manual smoke-test prompts to exercise the bot's main code paths against a live Sabha workspace. Grouped so each prompt validates a specific path documented in `CLAUDE.md`.

When a prompt requires a real id (room, user, message), substitute one from your workspace. Numeric ids in this doc (e.g. `room 21`, `@{12345}`) are placeholders.

---

## Recent commits (2026-05-01)

These prompts target the changes shipped in 2026.4.30 / 2026.5.1.

| # | Where to send | Prompt | What it exercises |
|---|---|---|---|
| 1 | Group room (small numeric id, e.g. 21) | `@bot send a test message to room 21 saying "hello"` | `messaging.targetResolver` (ae79be4) — was previously rejected with `Unknown target "21"` because the SDK default required 6+ digit ids |
| 2 | Any room | `@bot send "ping" then immediately react to that same message with 🎉` | `jsonResult` on writes (3c57961) — chain only works if the agent sees `messageId` from the first send |
| 3 | Any room | `@bot read the last 3 messages and quote each one back with the author's name` | `jsonResult` on read (1928105) — the agent must see ids/text/authors that previously hid in `details` |
| 4 | Any room | `@bot search for messages containing "hello" and tell me how many you found` | `/search` wire fix (63eaaec) — was 422'ing in production before the `q=` rename |
| 5 | Any room with reactions on a recent message | `@bot what reactions are on the message above?` (reply-context to a reacted message) | `reactions` action visibility + the `react`/`reactions` auto-fill gate |
| 6 | Thread (reply on an existing message, then talk to bot inside) | `@bot quote the parent message of this thread`, then `@bot now spawn a sub-agent to summarize this thread` | `MessageThreadId` (140c3d5) — sub-agent should inherit thread context, not escape to parent room |
| 7 | DM (no @mention needed) | `react with 🚀 to your last message` | Confirms `WasMentioned` undefined in DM doesn't suppress action; auto-fill from `currentChannelId` works in DM |

## Broader feature surface

| # | Where | Prompt | Path |
|---|---|---|---|
| 8 | Group | `@bot tell me about user @{12345}` (use a real user id) | `member-info` action + workspace scoping |
| 9 | Group | `@bot list the rooms you can see` | `directory.listGroups` adapter |
| 10 | Group | `@bot find the user named "alex"` | `directory.listPeers` + workspace name resolution |
| 11 | Group | `@bot find a member named "alex" in this room` | `sabha_search_members` agent tool (room-scoped name lookup) |
| 12 | Group | `@bot start a DM with user @{12345}` | `sabha_create_dm` agent tool |
| 13 | Group | `@bot write me a 500-word essay on octopuses` | Streaming preview edits + typing indicator + `chunkMarkdownText` (long output crosses chunk boundary) |
| 14 | Group | `@bot send a code block with a 10-line python example, then a bulleted list of three things` | Markdown → Trix (code fences, lists; see `OUTBOUND-RICH-TEXT.md`) |
| 15 | Group | `@bot send a markdown table with 3 rows of any data` | Trix downgrade to `<pre>` (Sabha sanitizer drops table tags) |
| 16 | Group | `@bot mention @{12345} and ask them what time it is` | Bot uses `@{USER_ID}` syntax per `inboundFormattingHints` |
| 17 | Group, then thread-reply on bot's response | `@bot continue the previous answer with one more paragraph` | Thread routing (`sabha:group:R:thread:T` session key); `replyToMode` honored |
| 18 | Group | `@bot edit your last message to add a 🎉 at the end` | `edit` action; id-only mutating wire path |
| 19 | Group | `@bot delete your last message` | `unsend` action; id-only |
| 20 | Group | (right after #2) `@bot remove your 🎉 reaction from the message you just reacted to` | `react`/unreact via `boostId` (now visible in `jsonResult`) |

## Negative / regression checks

| # | Where | Prompt | What you're watching for |
|---|---|---|---|
| 21 | Group, no @mention | `hey what's the weather` | Bot should **not** reply — group + no mention is filtered by `processInboundMessage` |
| 22 | DM | `hey what's the weather` | Bot **should** reply — DM is auto-addressed |
| 23 | Group | Right after bot starts a long stream, send another `@bot ...` quickly | Two concurrent streams shouldn't double-post or collide preview ids (regression for the `isAlive()` invariant in commit `e47974c`) |
| 24 | Group | Cause a deliberate failure (e.g. `@bot edit message 99999999 to "x"`) | Error copy must not leak the bot key (`formatStreamError` redaction) |

---

## Notes

- For prompts with placeholder ids (`@{12345}`, `room 21`), substitute a real id from your workspace before sending.
- For thread-related tests (#6, #17), reply on the bot's previous message in the Sabha UI to materialize a thread room before sending the test prompt.
- For #23, the easiest way to overlap streams is to ask the bot for two long generations from two different rooms in quick succession, or open two messages in the same room.
