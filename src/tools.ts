// Agent tools (tool context v2). The account comes from trusted host context:
// the current turn's account when the agent is on Sabha, else the default.
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import { Type, type TSchema } from "typebox";
import { accountClient } from "./client/account-client.js";
import type { SabhaClient } from "./client/client.js";
import { SABHA_CHANNEL_ID, type SabhaToolName } from "./plugin/meta.js";

type ToolContext = OpenClawPluginToolContext<2>;
type ToolResult = { content: Array<{ type: "text"; text: string }>; details: unknown };

const ok = (data: unknown): ToolResult => ({ content: [{ type: "text", text: JSON.stringify(data) }], details: data });
const fail = (error: unknown): ToolResult => {
  const message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: "text", text: `Error: ${message}` }], details: { error: message } };
};

const onSabha = (ctx: ToolContext) => ctx.messageChannel === SABHA_CHANNEL_ID;

type ToolSpec<P> = {
  name: SabhaToolName;
  label: string;
  description: string;
  parameters: TSchema;
  run: (args: { client: SabhaClient; params: P; ctx: ToolContext }) => Promise<unknown>;
};

function defineTool<P>(spec: ToolSpec<P>, getConfig: () => OpenClawConfig) {
  return {
    contextVersion: 2 as const,
    create: (ctx: ToolContext) => ({
      name: spec.name,
      label: spec.label,
      description: spec.description,
      parameters: spec.parameters,
      async execute(_toolCallId: string, rawParams: unknown): Promise<ToolResult> {
        try {
          const cfg = ctx.getRuntimeConfig?.() ?? ctx.runtimeConfig ?? ctx.config ?? getConfig();
          const { client } = accountClient(cfg, onSabha(ctx) ? ctx.agentAccountId : undefined);
          return ok(await spec.run({ client, params: (rawParams ?? {}) as P, ctx }));
        } catch (error) {
          return fail(error);
        }
      },
    }),
  };
}

export function createSabhaTools(getConfig: () => OpenClawConfig) {
  return [
    defineTool<{ room_id?: number; query?: string }>({
      name: "sabha_search_members",
      label: "Search Sabha room members",
      description:
        "Find people in a Sabha room by partial name, to mention them as @{USER_ID}. Returns up to 20 candidates; refine the query if you get exactly 20. Defaults to the current room.",
      parameters: Type.Object({
        room_id: Type.Optional(Type.Number({ description: "Room to search. Defaults to the room of the current conversation." })),
        query: Type.Optional(Type.String({ description: "Partial name. Omit to list the room's recent posters." })),
      }),
      run: async ({ client, params, ctx }) => {
        const current = onSabha(ctx) && ctx.nativeChannelId && /^\d+$/.test(ctx.nativeChannelId) ? Number(ctx.nativeChannelId) : undefined;
        const roomId = params.room_id ?? current;
        if (roomId === undefined) throw new Error("room_id is required outside a Sabha conversation");
        const users = await client.searchUsers({ roomId, ...(params.query ? { query: params.query } : {}) });
        return users.map((user) => ({ id: user.id, name: user.name, mention: `@{${user.id}}`, ...(user.bot ? { app: true } : {}) }));
      },
    }, getConfig),
    defineTool<{ user_id: number }>({
      name: "sabha_create_dm",
      label: "Open a Sabha DM",
      description: "Open (or find) the direct-message room with a Sabha user. Returns the room id to send to.",
      parameters: Type.Object({ user_id: Type.Number({ description: "User id to DM" }) }),
      run: async ({ client, params, ctx }) => {
        if (!Number.isInteger(params.user_id)) throw new Error("user_id must be a Sabha user id");
        ctx.assertInvocationCurrent();
        const { roomId } = await client.createDm([params.user_id]);
        return { roomId, target: `channel:${roomId}` };
      },
    }, getConfig),
  ];
}
