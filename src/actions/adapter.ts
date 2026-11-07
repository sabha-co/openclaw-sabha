// Discovery for the shared `message` tool stays static and light; handlers
// (and the client graph) load only when an action runs.
import { jsonResult } from "openclaw/plugin-sdk/channel-actions";
import type { ChannelMessageActionAdapter, ChannelMessageActionName } from "openclaw/plugin-sdk/channel-contract";
import { Type } from "typebox";

export const SABHA_ACTION_NAMES = [
  "send",
  "thread-reply",
  "edit",
  "unsend",
  "react",
  "reactions",
  "read",
  "search",
  "member-info",
] as const satisfies readonly ChannelMessageActionName[];

const supported = new Set<ChannelMessageActionName>(SABHA_ACTION_NAMES);

const pagingSchema = {
  properties: {
    before: Type.Optional(Type.String({ description: "ISO timestamp upper bound (search, read)." })),
    after: Type.Optional(Type.String({ description: "ISO timestamp lower bound (search, read)." })),
    limit: Type.Optional(Type.Number({ description: "Max results (search, read). Default 50, max 200." })),
    cursor: Type.Optional(Type.String({ description: "`nextCursor` from a previous search/read page, to walk further back." })),
  },
  actions: ["search", "read"] as ChannelMessageActionName[],
  visibility: "current-channel" as const,
};

export const sabhaMessageActions: ChannelMessageActionAdapter = {
  describeMessageTool: () => ({
    actions: SABHA_ACTION_NAMES,
    capabilities: [],
    schema: [pagingSchema],
    mediaSourceParams: { send: ["media", "mediaUrl", "filePath", "path"] },
  }),
  supportsAction: ({ action }) => supported.has(action),
  handleAction: async (ctx) => {
    const [{ accountClient }, { runSabhaAction }] = await Promise.all([
      import("../client/account-client.js"),
      import("./handlers.js"),
    ]);
    const { account, client } = accountClient(ctx.cfg, ctx.accountId);
    return jsonResult(await runSabhaAction({ ctx, client, account }));
  },
};
