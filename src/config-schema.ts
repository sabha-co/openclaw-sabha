import { z } from "zod";
import { buildChannelConfigSchema } from "openclaw/plugin-sdk/channel-config-primitives";

export const SabhaAccountSchema = z.object({
  enabled: z.boolean().optional(),
  baseUrl: z.string().optional(),
  apiBaseUrl: z.string().optional(),
  botKey: z.string().optional(),
  botName: z.string().optional(),
  websocketUrl: z.string().optional(),
  typingEnabled: z.boolean().optional(),
  dmPolicy: z.enum(["open", "allowlist"]).optional(),
  allowFrom: z.array(z.string()).optional(),
  allowPrivateAttachmentHosts: z.boolean().optional(),
  replyToMode: z.enum(["off", "first", "all"]).optional(),
  rooms: z.record(z.string(), z.object({ systemPrompt: z.string().optional() }).strict()).optional(),
}).strict();

export const SabhaConfigSchema = SabhaAccountSchema.omit({ botKey: true, botName: true, websocketUrl: true }).extend({
  accounts: z.record(z.string(), SabhaAccountSchema).optional(),
  defaultAccount: z.string().optional(),
}).strict();

export const sabhaConfigSchema: ReturnType<typeof buildChannelConfigSchema> = buildChannelConfigSchema(SabhaConfigSchema, {
  uiHints: {
    enabled: { label: "Enabled" },
    baseUrl: {
      label: "Server URL",
      placeholder: "https://sabha.co/1000006",
      help: "Sabha server URL (include workspace ID for multi-tenant)",
    },
    apiBaseUrl: {
      label: "Bot API base URL",
      placeholder: "https://sabha.co/1000006/api/bots",
      advanced: true,
      help: "Auto-detected from registration; endpoint for bearer-auth HTTP calls",
    },
    "accounts.*.botKey": {
      label: "Bot key",
      placeholder: "42-AbCdEfGhIjKl",
      sensitive: true,
      help: "Bot key from registration via join code",
    },
    "accounts.*.botName": {
      label: "Bot display name",
      placeholder: "OpenClaw",
      advanced: true,
      help: "Shown to users in typing indicators",
    },
    typingEnabled: {
      label: "Typing indicators",
      advanced: true,
      help: "Show 'Bot is typing...' while processing",
    },
    "accounts.*.websocketUrl": {
      label: "WebSocket URL",
      advanced: true,
      help: "Auto-detected from registration",
    },
    dmPolicy: { label: "DM policy" },
    allowFrom: {
      label: "Allow list",
      advanced: true,
      help: "User IDs for allowlist mode",
    },
    allowPrivateAttachmentHosts: {
      label: "Allow private attachment hosts",
      advanced: true,
      help: "Dangerous — disables SSRF protection on attachment downloads. Only enable in corporate / split-horizon DNS setups.",
    },
    replyToMode: {
      label: "Reply threading mode",
      help: '"off" = inline, "first" = thread on first reply, "all" = always thread',
    },
  },
});
