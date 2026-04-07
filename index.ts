import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { sabhaPlugin } from "./src/channel.js";
import { parseWebhookPayload, wasBotMentioned, resolveChatType } from "./src/webhook.js";
import { resolveSessionFromPayload } from "./src/session.js";
import { extractBotId } from "./src/client.js";

export default defineChannelPluginEntry({
  id: "sabha",
  name: "Sabha",
  description: "Connect OpenClaw to a Sabha chat server",
  plugin: sabhaPlugin,

  registerFull(api) {
    api.registerHttpRoute({
      path: "/sabha/webhook",
      auth: "plugin",
      handler: async (req, res) => {
        try {
          const chunks: Buffer[] = [];
          for await (const chunk of req) {
            chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
          }
          const body = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
          const payload = parseWebhookPayload(body);

          // Only process message_created events for now
          if (payload.event === "message_created") {
            const account = sabhaPlugin.config.resolveAccount(
              (api as any).config,
            );
            const botId = extractBotId(account.botKey);

            // Skip messages from the bot itself
            if (payload.user.id !== botId) {
              const chatType = resolveChatType(payload.room.type);
              const session = resolveSessionFromPayload(payload);
              const isDm = chatType === "direct";
              const mentioned = wasBotMentioned(payload, botId);

              // In DMs, always respond. In groups, only when mentioned.
              if (isDm || mentioned) {
                // Dispatch to OpenClaw core via channelRuntime
                // (wired up when channelRuntime is available in context)
                api.logger?.info?.(
                  `[sabha] Inbound: ${payload.event} from ${payload.user.name} in ${payload.room.name} (${chatType}, mentioned=${mentioned})`,
                );
              }
            }
          }

          res.statusCode = 200;
          res.end();
        } catch (err) {
          api.logger?.error?.(`[sabha] Webhook error: ${err}`);
          res.statusCode = 400;
          res.end("Bad Request");
        }

        return true;
      },
    });
  },
});
