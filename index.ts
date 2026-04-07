import {
  defineChannelPluginEntry,
  type PluginRuntime,
} from "openclaw/plugin-sdk/channel-core";
import { sabhaPlugin, resolveAccount } from "./src/channel.js";
import { parseWebhookPayload } from "./src/webhook.js";
import { processInboundMessage } from "./src/inbound.js";
import { SabhaClient } from "./src/client.js";

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
    api.registerHttpRoute({
      path: "/sabha/webhook",
      auth: "plugin",
      handler: async (req, res) => {
        try {
          const chunks: Buffer[] = [];
          for await (const chunk of req) {
            chunks.push(
              typeof chunk === "string" ? Buffer.from(chunk) : chunk,
            );
          }
          const body = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
          const payload = parseWebhookPayload(body);

          if (payload.event === "message_created" && pluginRuntime) {
            const cfg = api.runtime.config.loadConfig();
            const account = resolveAccount(cfg);
            const client = new SabhaClient(account.baseUrl, account.botKey);

            await processInboundMessage(payload, {
              runtime: pluginRuntime,
              cfg,
              account,
              logger: api.logger,
              deliver: async (replyPayload) => {
                // Deliver OpenClaw's reply back to Sabha
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
        } catch (err) {
          api.logger.error?.(`[sabha] Webhook error: ${err}`);
          res.statusCode = 400;
          res.end("Bad Request");
        }

        return true;
      },
    });
  },
});

export default entry;
