import { Type } from "@sinclair/typebox";
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import { SabhaClient } from "./client.js";
import {
  listSabhaAccountIds,
  resolveDefaultSabhaAccountId,
  resolveSabhaAccount,
} from "./accounts.js";

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  details: unknown;
};

function toolResult(data: unknown): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data) }],
    details: data,
  };
}

function toolError(err: unknown): ToolResult {
  const message = err instanceof Error ? err.message : String(err);
  return {
    content: [{ type: "text", text: `Error: ${message}` }],
    details: { error: message },
  };
}

/**
 * Every Sabha agent tool accepts an optional `accountId` override that is
 * read at execute time but NOT advertised in the tool's JSON schema. The
 * LLM therefore never sees a bot-account picker; routing flows implicitly
 * through `ctx.agentAccountId` (supplied by the SDK per invocation) with a
 * final fallback to `resolveDefaultSabhaAccountId`. This mirrors the Feishu
 * plugin's pattern — which was verified as the canonical multi-account
 * tool registration shape by the v1 scout work.
 */
type AccountAwareParams = { accountId?: string };

/**
 * Resolve the SabhaClient to route a tool invocation through.
 *
 * Precedence (high → low):
 *   1. `params.accountId` — explicit override (hidden from LLM schema but
 *      readable at execute time). Used by internal routing and tests.
 *   2. `ctx.agentAccountId` — supplied by the OpenClaw SDK based on the
 *      agent's current session / routing context.
 *   3. `resolveDefaultSabhaAccountId(cfg)` — fallback when neither is set
 *      (applied inside `resolveSabhaAccount` when `accountId` is nullish).
 *
 * Two safety guards on top of the precedence:
 *   - **Unknown id falls back to default.** If the resolved id is not a
 *     real Sabha account (e.g. a Slack workspace id reaching us via
 *     `agentAccountId` from a different channel's routing), we fall back
 *     to the configured default instead of returning a degenerate
 *     base-only config. Mirrors Feishu's `tool-account-routing.test.ts`
 *     behavior.
 *   - **Disabled accounts throw.** A bot account marked
 *     `enabled: false` should not silently service tool calls; surface
 *     that as an explicit error so operators can tell why a tool failed.
 */
function getClientForTool(
  cfg: OpenClawConfig,
  params: AccountAwareParams | undefined,
  agentAccountId: string | undefined,
): SabhaClient {
  const requestedId = params?.accountId ?? agentAccountId;
  const knownIds = listSabhaAccountIds(cfg);
  const resolvedId =
    requestedId && knownIds.includes(requestedId)
      ? requestedId
      : resolveDefaultSabhaAccountId(cfg);
  const account = resolveSabhaAccount({ cfg, accountId: resolvedId });
  if (!account.enabled) {
    throw new Error(
      `Sabha bot account "${account.accountId}" is disabled (channels.sabha.accounts.${account.accountId}.enabled === false). ` +
        `Re-enable it or pick a different accountId.`,
    );
  }
  return new SabhaClient(account.apiBaseUrl, account.botKey);
}

type ToolCtx = { agentAccountId?: string };

type ToolExecute<TParams> = (args: {
  cfg: OpenClawConfig;
  params: TParams;
  agentAccountId: string | undefined;
}) => Promise<unknown>;

type ToolDefinition<TParams extends AccountAwareParams> = {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  execute: ToolExecute<TParams>;
};

/**
 * Sabha agent tool factory. Returns per-invocation factories that the
 * host registers via `api.registerTool((ctx) => ...)`, so each call picks
 * up a fresh `ctx.agentAccountId` from the SDK.
 */
export function createSabhaTools(getConfig: () => OpenClawConfig) {
  const build = <TParams extends AccountAwareParams>(
    def: ToolDefinition<TParams>,
  ) => {
    return (ctx: ToolCtx) => ({
      name: def.name,
      label: def.label,
      description: def.description,
      parameters: def.parameters,
      async execute(_id: string, rawParams: unknown): Promise<ToolResult> {
        try {
          const cfg = getConfig();
          const params = (rawParams ?? {}) as TParams;
          const data = await def.execute({
            cfg,
            params,
            agentAccountId: ctx.agentAccountId,
          });
          return toolResult(data);
        } catch (err) {
          return toolError(err);
        }
      },
    });
  };

  return [
    // Note: room *listing* lives in `src/directory.ts` as a directory adapter;
    // message *search* is exposed via the shared `message` tool's `search`
    // action (see `src/message-actions.ts`); workspace-level name → id
    // resolution lives on `resolver.resolveTargets` in `src/channel.ts` (the
    // SDK slot Discord / Slack / Telegram use). The agent reaches all of
    // those through canonical SDK slots, not through `sabha_*` agent tools.
    // Tools below are room/member admin operations without cross-channel
    // analogs (`sabha_search_members` is the room-scoped variant of name
    // resolution — no SDK directory slot models `roomId + query`).
    build<
      AccountAwareParams & { query?: string; page?: number; per_page?: number }
    >({
      name: "sabha_list_joinable_rooms",
      label: "List joinable Sabha rooms",
      description:
        "List open rooms the bot can join in Sabha. Server paginates (default 50 per page, max 100); pass `query` for a name match, or `page` to walk further.",
      parameters: Type.Object({
        query: Type.Optional(
          Type.String({ description: "Optional partial name match" }),
        ),
        page: Type.Optional(
          Type.Number({ description: "1-indexed page number" }),
        ),
        per_page: Type.Optional(
          Type.Number({ description: "Page size (server caps at 100)" }),
        ),
      }),
      execute: async ({ cfg, params, agentAccountId }) =>
        await getClientForTool(cfg, params, agentAccountId).listRooms({
          joinable: true,
          query: params.query,
          page: params.page,
          perPage: params.per_page,
        }),
    }),
    // Room-scoped name disambiguation. Workspace-level resolution lives on
    // `resolver.resolveTargets` (see channel.ts) and matches what Discord /
    // Slack / Telegram expose. The room-scoped variant lives here because
    // no SDK directory slot models `roomId + query` — see
    // `docs/READ-ENDPOINT-SCALE-PLAN.md` for the full rationale. Server
    // returns ≤20 results; if exactly 20 come back the agent should refine.
    build<AccountAwareParams & { room_id: number; query?: string }>({
      name: "sabha_search_members",
      label: "Search Sabha room members",
      description:
        "Find users in a specific Sabha room by partial name. Returns up to 20 candidates; refine the query if you receive exactly 20.",
      parameters: Type.Object({
        room_id: Type.Number({ description: "Room ID to search within" }),
        query: Type.Optional(
          Type.String({
            description:
              "Partial name to match (server runs prefix-style match via User.matching). Omit to fetch recent posters.",
          }),
        ),
      }),
      execute: async ({ cfg, params, agentAccountId }) =>
        await getClientForTool(cfg, params, agentAccountId).searchUsers({
          roomId: params.room_id,
          query: params.query,
        }),
    }),
    build<AccountAwareParams & { name: string; type: "open" | "closed" }>({
      name: "sabha_create_room",
      label: "Create Sabha room",
      description:
        "Create a new room in Sabha. The bot becomes the creator and can manage the room.",
      parameters: Type.Object({
        name: Type.String({ description: "Room name" }),
        type: Type.Union([Type.Literal("open"), Type.Literal("closed")], {
          description: "Room type: 'open' (anyone can join) or 'closed' (invite only)",
        }),
      }),
      execute: async ({ cfg, params, agentAccountId }) =>
        await getClientForTool(cfg, params, agentAccountId).createRoom(
          params.name,
          params.type,
        ),
    }),
    build<AccountAwareParams & { room_id: number; name: string }>({
      name: "sabha_update_room",
      label: "Update Sabha room",
      description: "Rename a room the bot created in Sabha",
      parameters: Type.Object({
        room_id: Type.Number({ description: "Room ID" }),
        name: Type.String({ description: "New room name" }),
      }),
      execute: async ({ cfg, params, agentAccountId }) =>
        await getClientForTool(cfg, params, agentAccountId).updateRoom(
          params.room_id,
          params.name,
        ),
    }),
    build<AccountAwareParams & { room_id: number }>({
      name: "sabha_archive_room",
      label: "Archive Sabha room",
      description: "Archive (soft-delete) a room the bot created in Sabha",
      parameters: Type.Object({
        room_id: Type.Number({ description: "Room ID to archive" }),
      }),
      execute: async ({ cfg, params, agentAccountId }) => {
        await getClientForTool(cfg, params, agentAccountId).archiveRoom(
          params.room_id,
        );
        return "Room archived";
      },
    }),
    build<AccountAwareParams & { room_id: number }>({
      name: "sabha_join_room",
      label: "Join Sabha room",
      description: "Join an open room in Sabha",
      parameters: Type.Object({
        room_id: Type.Number({ description: "Room ID to join" }),
      }),
      execute: async ({ cfg, params, agentAccountId }) =>
        await getClientForTool(cfg, params, agentAccountId).joinRoom(
          params.room_id,
        ),
    }),
    build<AccountAwareParams & { room_id: number }>({
      name: "sabha_leave_room",
      label: "Leave Sabha room",
      description: "Leave a room in Sabha",
      parameters: Type.Object({
        room_id: Type.Number({ description: "Room ID to leave" }),
      }),
      execute: async ({ cfg, params, agentAccountId }) => {
        await getClientForTool(cfg, params, agentAccountId).leaveRoom(
          params.room_id,
        );
        return "Left room";
      },
    }),
    build<AccountAwareParams & { room_id: number; user_id: number }>({
      name: "sabha_add_member",
      label: "Add Sabha room member",
      description: "Add a user to a room the bot created in Sabha",
      parameters: Type.Object({
        room_id: Type.Number({ description: "Room ID" }),
        user_id: Type.Number({ description: "User ID to add" }),
      }),
      execute: async ({ cfg, params, agentAccountId }) =>
        await getClientForTool(cfg, params, agentAccountId).addMember(
          params.room_id,
          params.user_id,
        ),
    }),
    build<AccountAwareParams & { room_id: number; user_id: number }>({
      name: "sabha_remove_member",
      label: "Remove Sabha room member",
      description: "Remove a user from a room the bot created in Sabha",
      parameters: Type.Object({
        room_id: Type.Number({ description: "Room ID" }),
        user_id: Type.Number({ description: "User ID to remove" }),
      }),
      execute: async ({ cfg, params, agentAccountId }) => {
        await getClientForTool(cfg, params, agentAccountId).removeMember(
          params.room_id,
          params.user_id,
        );
        return "Member removed";
      },
    }),
    build<AccountAwareParams & { user_id: number }>({
      name: "sabha_create_dm",
      label: "Create Sabha DM",
      description: "Create a direct message conversation with a user in Sabha",
      parameters: Type.Object({
        user_id: Type.Number({ description: "User ID to DM" }),
      }),
      execute: async ({ cfg, params, agentAccountId }) =>
        await getClientForTool(cfg, params, agentAccountId).createDm([
          params.user_id,
        ]),
    }),
  ];
}
