import { buildChannelConfigSchema } from "openclaw/plugin-sdk/channel-config-primitives";
import { z } from "zod";

const RoomSchema = z.object({ systemPrompt: z.string().optional() }).strict();

/** Settings an account may inherit from the channel root. Never credentials. */
const sharedShape = {
  enabled: z.boolean().optional(),
  url: z.string().optional(),
  dmPolicy: z.enum(["open", "allowlist"]).optional(),
  allowFrom: z.array(z.string()).optional(),
  allowPrivateNetwork: z.boolean().optional(),
  replyToMode: z.enum(["off", "first", "all"]).optional(),
  livePreview: z.boolean().optional(),
  rooms: z.record(z.string(), RoomSchema).optional(),
};

export const SabhaAccountSchema = z
  .object({
    ...sharedShape,
    name: z.string().optional(),
    appKey: z.string().optional(),
    cableUrl: z.string().optional(),
  })
  .strict();

export const SabhaChannelSchema = z
  .object({
    ...sharedShape,
    accounts: z.record(z.string(), SabhaAccountSchema).optional(),
    defaultAccount: z.string().optional(),
  })
  .strict();

export type SabhaAccountConfig = z.infer<typeof SabhaAccountSchema>;
export type SabhaChannelConfig = z.infer<typeof SabhaChannelSchema>;
export type SabhaRoomConfig = z.infer<typeof RoomSchema>;

export const sabhaConfigSchema: ReturnType<typeof buildChannelConfigSchema> = buildChannelConfigSchema(SabhaChannelSchema, {
  uiHints: {
    enabled: { label: "Enabled" },
    url: {
      label: "Workspace URL",
      placeholder: "https://sabha.co/1000006",
      help: "The Sabha workspace address, including the workspace number on sabha.co",
    },
    "accounts.*.appKey": {
      label: "App key",
      placeholder: "sabha_app_…",
      sensitive: true,
      help: "Shown once when an admin creates the app in Settings → Apps",
    },
    "accounts.*.cableUrl": {
      label: "WebSocket URL",
      placeholder: "wss://sabha.co/cable",
      advanced: true,
      help: "Only for servers whose WebSocket is not at /cable on the workspace host",
    },
    dmPolicy: { label: "DM policy", help: '"open" answers anyone; "allowlist" answers only allowFrom' },
    allowFrom: { label: "Allowed users", advanced: true, help: "Sabha user ids admitted in allowlist mode" },
    allowPrivateNetwork: {
      label: "Allow private-network attachments",
      advanced: true,
      help: "Dangerous: lets attachment downloads reach private addresses. Only for split-horizon DNS installs.",
    },
    replyToMode: {
      label: "Reply threading",
      help: '"off" replies inline, "first" threads the first reply, "all" threads every reply',
    },
    livePreview: { label: "Live drafts", advanced: true, help: "Stream replies into a live draft while the agent writes. On by default; a Sabha server without live drafts posts the reply as usual" },
  },
});
