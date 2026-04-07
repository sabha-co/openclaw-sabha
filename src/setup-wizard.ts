import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import type { ChannelSetupWizard } from "openclaw/plugin-sdk/channel-setup";
import type { SabhaConfig } from "./types.js";

/**
 * Parse a Sabha join URL into base URL and join code.
 *
 * Accepts formats:
 *   https://chat.example.com/join/mNrP-Nm5q-HCzw
 *   https://chat.example.com/1000006/join/mNrP-Nm5q-HCzw
 */
export function parseJoinUrl(raw: string): {
  baseUrl: string;
  joinCode: string;
} | null {
  try {
    const url = new URL(raw);
    const match = url.pathname.match(/^(\/\d{7,})?\/join\/([A-Za-z0-9_-]+)$/);
    if (!match) return null;

    const workspacePrefix = match[1] ?? "";
    const joinCode = match[2];
    const baseUrl = `${url.origin}${workspacePrefix}`;

    return { baseUrl, joinCode };
  } catch {
    return null;
  }
}

/**
 * Self-register a bot via Sabha's join code endpoint.
 * POST /join/{code} with JSON body → { bot_key, name, ... }
 */
export async function selfRegisterBot(
  baseUrl: string,
  joinCode: string,
  params: { name: string; webhook_url?: string },
): Promise<{ bot_key: string; name: string }> {
  const res = await globalThis.fetch(`${baseUrl}/join/${joinCode}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(params),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText })) as { error?: string };
    throw new Error(body.error ?? `Registration failed: ${res.status}`);
  }

  return (await res.json()) as { bot_key: string; name: string };
}

function getSabhaSection(cfg: OpenClawConfig): SabhaConfig | undefined {
  return (cfg.channels as Record<string, unknown>)?.sabha as SabhaConfig | undefined;
}

function setSabhaConfig(
  cfg: OpenClawConfig,
  patch: Partial<SabhaConfig>,
): OpenClawConfig {
  const channels = (cfg.channels ?? {}) as Record<string, unknown>;
  const existing = (channels.sabha ?? {}) as Record<string, unknown>;
  return {
    ...cfg,
    channels: {
      ...channels,
      sabha: { ...existing, ...patch, enabled: true },
    },
  };
}

export const sabhaSetupWizard: ChannelSetupWizard = {
  channel: "sabha",

  status: {
    configuredLabel: "Sabha (connected)",
    unconfiguredLabel: "Sabha",
    configuredHint: "Bot is registered and ready",
    unconfiguredHint: "Connect to a Sabha chat server",
    resolveConfigured: ({ cfg }) => {
      const section = getSabhaSection(cfg);
      return Boolean(section?.baseUrl && section?.botKey);
    },
  },

  introNote: {
    title: "Sabha Setup",
    lines: [
      "You'll need a join URL from your Sabha server.",
      "Get one from your Sabha admin at /account/join_codes,",
      "or ask an admin to share the link.",
      "",
      "The URL looks like: https://chat.example.com/join/mNrP-Nm5q-HCzw",
    ],
  },

  credentials: [
    {
      inputKey: "botToken",
      providerHint: "Sabha",
      credentialLabel: "Bot key",
      envPrompt: "Use SABHA_BOT_KEY from environment?",
      keepPrompt: "Keep current bot key?",
      inputPrompt: "Enter your Sabha bot key (or leave blank to auto-register via join URL):",
      preferredEnvVar: "SABHA_BOT_KEY",
      helpTitle: "Sabha Bot Key",
      helpLines: [
        "The bot key is obtained automatically when you provide a join URL.",
        "You can also set it manually from your Sabha admin at /account/bots.",
      ],
      inspect: ({ cfg }) => {
        const section = getSabhaSection(cfg);
        return {
          accountConfigured: Boolean(section?.botKey),
          hasConfiguredValue: Boolean(section?.botKey),
          resolvedValue: section?.botKey,
        };
      },
      applySet: ({ cfg, resolvedValue }) => {
        return setSabhaConfig(cfg, { botKey: resolvedValue });
      },
    },
  ],

  textInputs: [
    {
      inputKey: "httpUrl",
      message: "Sabha join URL or server URL",
      placeholder: "https://chat.example.com/join/mNrP-Nm5q-HCzw",
      required: true,
      currentValue: ({ cfg }) => {
        return getSabhaSection(cfg)?.baseUrl;
      },
      validate: ({ value }) => {
        // Accept either a join URL or a plain base URL
        const parsed = parseJoinUrl(value);
        if (parsed) return undefined;

        // Try as plain URL
        try {
          new URL(value);
          return undefined;
        } catch {
          return "Enter a valid Sabha URL (e.g., https://chat.example.com/join/CODE)";
        }
      },
      applySet: ({ cfg, value }) => {
        const parsed = parseJoinUrl(value);
        if (parsed) {
          return setSabhaConfig(cfg, { baseUrl: parsed.baseUrl });
        }
        // Plain base URL
        return setSabhaConfig(cfg, { baseUrl: value.replace(/\/+$/, "") });
      },
    },
  ],

  stepOrder: "text-first",

  finalize: async ({ cfg, credentialValues }) => {
    const section = getSabhaSection(cfg);
    const inputUrl = credentialValues?.httpUrl ?? "";

    // If user provided a join URL and we don't have a bot key yet, self-register
    const parsed = parseJoinUrl(inputUrl);
    if (parsed && !section?.botKey) {
      const result = await selfRegisterBot(parsed.baseUrl, parsed.joinCode, {
        name: "OpenClaw",
      });
      cfg = setSabhaConfig(cfg, {
        baseUrl: parsed.baseUrl,
        botKey: result.bot_key,
      });
    }

    return { cfg };
  },

  completionNote: {
    title: "Sabha Connected",
    lines: [
      "Your bot is registered and ready to receive messages.",
      "Make sure your Sabha server can reach this OpenClaw instance's webhook endpoint.",
    ],
  },

  dmPolicy: {
    label: "DM policy",
    channel: "sabha",
    policyKey: "channels.sabha.dmPolicy",
    allowFromKey: "channels.sabha.allowFrom",
    getCurrent: (cfg: OpenClawConfig) => {
      const section = getSabhaSection(cfg);
      return (section?.dmPolicy ?? "open") as "open" | "allowlist";
    },
    setPolicy: (cfg: OpenClawConfig, policy: string) => {
      const dmPolicy = policy === "allowlist" ? "allowlist" : "open";
      return setSabhaConfig(cfg, { dmPolicy });
    },
  },
};
