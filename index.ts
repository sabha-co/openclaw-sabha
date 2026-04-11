import {
  defineChannelPluginEntry,
  type PluginRuntime,
} from "openclaw/plugin-sdk/channel-core";
import { sabhaPlugin } from "./src/channel.js";
import { listEnabledBotAccounts, resolveBotAccount } from "./src/bot-accounts.js";
import { parseWebhookPayload } from "./src/webhook.js";
import {
  processInboundMessage,
  handleMessageUpdated,
  handleMessageDeleted,
  handleBoostCreated,
  handleBoostDeleted,
  handleUserCreated,
  handleUserDeleted,
} from "./src/inbound.js";
import { SabhaClient } from "./src/client.js";
import { createSabhaTools } from "./src/tools.js";
import { fetchSkillPrompt } from "./src/skill-prompt.js";
let pluginRuntime: PluginRuntime | undefined;

const entry: ReturnType<typeof defineChannelPluginEntry> = defineChannelPluginEntry({
  id: "sabha",
  name: "Sabha",
  description: "Connect OpenClaw to a Sabha chat server",
  plugin: sabhaPlugin,

  setRuntime(runtime: PluginRuntime) {
    pluginRuntime = runtime;
  },

  // CLI-only registration path: runs on `openclaw sabha …` without loading the
  // full plugin (gateway, services, webhook route, etc.)
  registerCliMetadata(api) {
    const getConfig = () => api.runtime.config.loadConfig();

    api.registerCli(
      async ({ program }) => {
        const { registerSabhaCli } = await import("./src/cli.js");
        registerSabhaCli({
          program,
          getConfig,
          writeConfigFile: (cfg) => api.runtime.config.writeConfigFile(cfg),
        });
      },
      {
        descriptors: [
          {
            name: "sabha",
            description: "Sabha channel commands",
            hasSubcommands: true,
          },
        ],
      },
    );
  },

  registerFull(api) {
    const getConfig = () => api.runtime.config.loadConfig();

    // Register room/member management agent tools. Each entry is a
    // factory `(ctx) => tool` so the SDK can inject fresh agent context
    // (including `ctx.agentAccountId`) per invocation.
    const toolFactories = createSabhaTools(getConfig);
    for (const factory of toolFactories) {
      api.registerTool(factory);
    }

    // Fetch /skill on startup for every unique workspace across enabled
    // bot accounts. `/skill` renders per workspace (template interpolates
    // `Current.account.name` + `request.base_url`), so bot accounts sharing
    // a baseUrl share a cache entry while accounts on different workspaces
    // each get their own.
    const baseUrls = new Set<string>();
    for (const botAccount of listEnabledBotAccounts(getConfig())) {
      if (botAccount.baseUrl) baseUrls.add(botAccount.baseUrl);
    }
    for (const baseUrl of baseUrls) {
      fetchSkillPrompt(baseUrl).then((text) => {
        if (text) {
          api.logger.info?.(
            `[sabha] Loaded /skill prompt for ${baseUrl}`,
          );
        }
      });
    }

    // Inbound webhook handler (fallback for connectionMode: "webhook")
    api.registerHttpRoute({
      path: "/sabha/webhook",
      auth: "plugin",
      handler: async (req, res) => {
        const MAX_BODY_BYTES = 1024 * 1024; // 1 MB

        try {
          const chunks: Buffer[] = [];
          let totalBytes = 0;
          for await (const chunk of req) {
            const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
            totalBytes += buf.length;
            if (totalBytes > MAX_BODY_BYTES) {
              res.statusCode = 413;
              res.end("Payload Too Large");
              return true;
            }
            chunks.push(buf);
          }
          const body = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
          const payload = parseWebhookPayload(body);

          // Webhook mode binds to one HTTP route per plugin, so we route
          // every inbound event through the default bot account. Multi-
          // bot webhook routing would need a path prefix scheme (e.g.
          // /sabha/webhook/:botAccountId) — deferred to v1.1.
          const cfg = getConfig();
          const currentAccount = resolveBotAccount({ cfg });

          // Mirror the monitor's dispatch table so every variant routes
          // to its typed handler. Only `message_created` runs the full
          // reply pipeline; the rest log via their typed stubs (Phase
          // 2.2 will upgrade `boost_created` to approval routing).
          if (payload.event === "message_created" && pluginRuntime) {
            const client = new SabhaClient(
              currentAccount.baseUrl,
              currentAccount.botKey,
            );

            await processInboundMessage(payload, {
              runtime: pluginRuntime,
              cfg,
              account: currentAccount,
              logger: api.logger,
              deliver: async (replyPayload) => {
                const roomId = Number(
                  replyPayload.to ?? payload.room.id,
                );
                const text = replyPayload.text ?? replyPayload.body ?? "";

                if (replyPayload.threadId && replyPayload.replyToId) {
                  await client.replyInThread(
                    roomId,
                    Number(replyPayload.replyToId),
                    text,
                  );
                } else {
                  await client.sendMessage(roomId, text);
                }
              },
            });
          } else {
            const botId = currentAccount.botId;
            switch (payload.event) {
              case "message_updated":
                await handleMessageUpdated(payload, { botId, logger: api.logger });
                break;
              case "message_deleted":
                await handleMessageDeleted(payload, { botId, logger: api.logger });
                break;
              case "boost_created":
                await handleBoostCreated(payload, { botId, logger: api.logger });
                break;
              case "boost_deleted":
                await handleBoostDeleted(payload, { botId, logger: api.logger });
                break;
              case "user_created":
                await handleUserCreated(payload, { logger: api.logger });
                break;
              case "user_deleted":
                await handleUserDeleted(payload, { logger: api.logger });
                break;
              case "message_created":
                // Runtime not ready yet — drop silently. This branch
                // only fires when `pluginRuntime` is undefined (before
                // setRuntime has been called). Rare in practice.
                break;
              default: {
                // Exhaustiveness check. If v1.1 adds a new event type
                // and this branch fails to compile, extend the switch
                // above so webhook mode stays in lock-step with the
                // monitor's dispatch table.
                const _exhaustive: never = payload;
                void _exhaustive;
              }
            }
          }

          res.statusCode = 200;
          res.end();
          return true;
        } catch (err) {
          api.logger.error?.(`[sabha] Webhook error: ${err}`);
          res.statusCode = 400;
          res.end("Bad Request");
          return true;
        }
      },
    });
  },
});

export default entry;
