// Prompt guidance. `inboundFormattingHints` renders on inbound turns whatever
// the tool profile; `messageToolHints` renders wherever the message tool is in
// scope, including proactive runs. Identity and mention syntax go in both.
import type { ChannelPlugin } from "openclaw/plugin-sdk/channel-core";

const MENTIONS =
  "To mention someone, write `@{USER_ID}` with their numeric id (curly braces). The sender's id is in the envelope as `Name (@{id})`. Discord-style `<@id>` and Slack-style `@name` do not notify anyone.";

export const sabhaAgentPrompt: NonNullable<ChannelPlugin["agentPrompt"]> = {
  inboundFormattingHints: () => ({
    text_markup: "markdown",
    rules: [
      "You are on Sabha, a team chat app (not Discord, Slack, Teams or Telegram).",
      MENTIONS,
      "Write standard Markdown: headings, bold, italic, links, lists, quotes, code blocks and pipe tables all render.",
      "Images in Markdown show as links; send files as attachments instead.",
    ],
  }),
  reactionGuidance: () => ({ level: "minimal" as const, channelLabel: "Sabha" }),
  messageToolHints: () => [
    `SABHA: you're on Sabha (not Discord/Slack/Teams). ${MENTIONS} Use sabha_search_members to find an id by name.`,
    "SABHA SEARCH: `search` returns up to 200 results (default 50) and says `hasMore: true` when there are more. Narrow with channelIds / authorIds or before / after, or pass `cursor` (from `nextCursor`) to continue.",
    "SABHA READ: `read` returns messages newest first; reorder before summarizing chronologically. Pass `cursor` (from `nextCursor`) to go further back.",
    "SABHA THREADS: a thread is its own room. Replying in the current conversation needs no target; `thread-reply` with a top-level `messageId` starts or continues that message's thread.",
  ],
};
