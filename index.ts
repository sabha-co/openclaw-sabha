import {
  defineChannelPluginEntry,
  type PluginRuntime,
} from "openclaw/plugin-sdk/channel-core";
import { sabhaPlugin, resolveAccount } from "./src/channel.js";
import { parseWebhookPayload } from "./src/webhook.js";
import { processInboundMessage } from "./src/inbound.js";
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

  registerFull(api) {
    const getConfig = () => api.runtime.config.loadConfig();

    // Register room/member management agent tools
    const tools = createSabhaTools(getConfig);
    for (const tool of tools) {
      api.registerTool(tool);
    }

    // Fetch /skill on startup and cache for agent prompt hints
    const account = resolveAccount(getConfig());
    if (account.baseUrl) {
      fetchSkillPrompt(account.baseUrl).then((text) => {
        if (text) {
          api.logger.info?.("[sabha] Loaded /skill prompt for agent context");
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

          if (payload.event === "message_created" && pluginRuntime) {
            const cfg = getConfig();
            const currentAccount = resolveAccount(cfg);
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
