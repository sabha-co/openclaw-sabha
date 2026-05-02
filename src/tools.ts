import { Type, type TSchema } from "typebox";
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
  parameters: TSchema;
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
    // Sabha exposes only two `registerTool` factories. Everything else an
    // agent might want — room listing, message search, workspace-level
    // user lookup, send/edit/react/read — flows through canonical SDK
    // slots (directory adapter, message-action adapter, resolver). Channel
    // and member admin (create / archive / join / leave / add / remove)
    // were dropped in favor of letting humans run those operations through
    // the Sabha UI; see `docs/CHANNEL-ADMIN-DROP-PLAN.md`. The two retained
    // verbs are the ones with no SDK slot and no human-side substitute the
    // agent can reach:
    //
    //   - `sabha_search_members`: room-scoped name → user lookup. The SDK
    //     directory has no `roomId + query` slot; workspace-level
    //     `listPeers({ query })` is too broad when multiple users share a
    //     name.
    //   - `sabha_create_dm`: explicit DM materialization. Sabha doesn't
    //     auto-create on first send, so without this verb an agent can
    //     only reply in DMs that already exist.
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
