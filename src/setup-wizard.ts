import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import type { ChannelSetupWizard } from "openclaw/plugin-sdk/channel-setup";
import {
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
} from "openclaw/plugin-sdk/account-core";
import type { SabhaConfig, SabhaRoom } from "./types.js";
import { SabhaClient } from "./client.js";
import { mergeBotAccountConfig } from "./bot-accounts.js";

// The prompter is provided by OpenClaw — infer the type from the wizard's finalize param
type FinalizeParams = Parameters<NonNullable<ChannelSetupWizard["finalize"]>>[0];
type WizardPrompter = FinalizeParams["prompter"];

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
 * POST /join/{code} with JSON body → { bot_key, name, websocket_url, ... }
 *
 * Throws a typed error for the common failure codes so the wizard can show
 * friendly messages.
 */
const REGISTRATION_TIMEOUT_MS = 15_000;

export class SabhaRegistrationError extends Error {
  constructor(
    message: string,
    public readonly code?: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "SabhaRegistrationError";
  }
}

export async function selfRegisterBot(
  baseUrl: string,
  joinCode: string,
  params: { name: string; webhook_url?: string },
): Promise<{ bot_key: string; name: string; websocket_url?: string }> {
  const url = `${baseUrl}/join/${joinCode}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REGISTRATION_TIMEOUT_MS);

  let res: Response;
  try {
    res = await globalThis.fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(params),
      signal: controller.signal,
    });
  } catch (err) {
    const cause = err instanceof Error ? err : new Error(String(err));
    if (cause.name === "AbortError") {
      throw new SabhaRegistrationError(
        `Sabha registration timed out after ${REGISTRATION_TIMEOUT_MS / 1000}s (${url})`,
        "timeout",
      );
    }
    throw new SabhaRegistrationError(
      `Could not reach Sabha at ${url}: ${cause.message}`,
      "network",
    );
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
    throw new SabhaRegistrationError(
      body.error ?? `Registration failed: ${res.status} ${res.statusText}`,
      body.code,
      res.status,
    );
  }

  try {
    return (await res.json()) as { bot_key: string; name: string; websocket_url?: string };
  } catch (err) {
    throw new SabhaRegistrationError(
      `Sabha returned an invalid response body: ${err}`,
      "invalid_response",
    );
  }
}

/**
 * Auto-join all open rooms in the Sabha workspace.
 *
 * After self-registration (or manual bot key entry), the bot is only a member
 * of rooms granted by the join code. Joining all public/open rooms makes the
 * bot discoverable to users right away. Closed rooms still require explicit
 * invites.
 */
async function autoJoinOpenRooms(
  baseUrl: string,
  botKey: string,
  prompter: WizardPrompter,
): Promise<void> {
  const client = new SabhaClient(baseUrl, botKey);

  let joinable: SabhaRoom[];
  try {
    joinable = await client.listJoinableRooms();
  } catch (err) {
    await prompter.note(
      `Could not list joinable rooms: ${formatError(err)}\nYou can invite the bot manually later.`,
      "Auto-join skipped",
    );
    return;
  }

  if (joinable.length === 0) {
    return;
  }

  const progress = prompter.progress(`Joining ${joinable.length} open room${joinable.length === 1 ? "" : "s"}`);
  let joined = 0;
  const failures: string[] = [];

  for (const room of joinable) {
    try {
      await client.joinRoom(room.id);
      joined++;
      progress.update(`Joined ${joined}/${joinable.length}: #${room.name}`);
    } catch (err) {
      failures.push(`#${room.name}: ${formatError(err)}`);
    }
  }

  if (failures.length > 0) {
    progress.stop(`Joined ${joined}/${joinable.length} rooms (${failures.length} failed)`);
    await prompter.note(failures.join("\n"), "Some rooms could not be joined");
  } else {
    progress.stop(`Joined ${joined} open room${joined === 1 ? "" : "s"}`);
  }
}

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Returns `true` if `accountId` refers to the implicit legacy bot account
 * whose config lives in the base `channels.sabha` block (zero-migration for
 * pre-multi-bot configs). Named accounts under `botAccounts.<id>` are stored
 * separately and layered over the base by `mergeBotAccountConfig`.
 */
export function isDefaultBotAccount(
  accountId: string | undefined | null,
): boolean {
  if (!accountId) return true;
  return normalizeAccountId(accountId) === DEFAULT_ACCOUNT_ID;
}

/**
 * Merged view of one bot account's setup-relevant fields. Reads the base
 * `channels.sabha` block for the default account and the named entry under
 * `botAccounts.<id>` for every other account, merged on top of the base.
 */
export function getBotAccountView(
  cfg: OpenClawConfig,
  accountId: string | undefined | null,
): SabhaConfig {
  const id = accountId ? normalizeAccountId(accountId) : DEFAULT_ACCOUNT_ID;
  return mergeBotAccountConfig(cfg, id);
}

/**
 * Write setup output for one bot account. The default account continues to
 * write into the base `channels.sabha` block (preserving legacy single-bot
 * configs unchanged); named accounts write into `botAccounts.<id>` so the
 * base config is never clobbered when a second bot is configured.
 */
export function setBotAccountConfig(
  cfg: OpenClawConfig,
  accountId: string | undefined | null,
  patch: Partial<SabhaConfig>,
): OpenClawConfig {
  const channels = (cfg.channels ?? {}) as Record<string, unknown>;
  const existing = (channels.sabha ?? {}) as Record<string, unknown>;

  if (isDefaultBotAccount(accountId)) {
    return {
      ...cfg,
      channels: {
        ...channels,
        sabha: { ...existing, ...patch, enabled: true },
      },
    };
  }

  const id = normalizeAccountId(accountId!);
  const botAccounts = {
    ...((existing.botAccounts as Record<string, Partial<SabhaConfig>>) ?? {}),
  };
  const existingAccount = botAccounts[id] ?? {};
  botAccounts[id] = { ...existingAccount, ...patch, enabled: true };

  return {
    ...cfg,
    channels: {
      ...channels,
      sabha: {
        ...existing,
        // Base stays enabled so legacy default-account config keeps working
        // while named accounts layer over it.
        enabled: existing.enabled !== false,
        botAccounts,
      },
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
    resolveConfigured: ({ cfg, accountId }) => {
      const view = getBotAccountView(cfg, accountId);
      return Boolean(view.baseUrl && view.botKey);
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

  // All prompting happens in finalize() via the prompter — this gives us
  // branching (join URL vs manual key) and better error messages.
  credentials: [],

  finalize: async ({ cfg, accountId, prompter }) => {
    const view = getBotAccountView(cfg, accountId);
    const accountLabel = isDefaultBotAccount(accountId)
      ? ""
      : ` [${normalizeAccountId(accountId!)}]`;

    // If already configured, offer to keep or reconfigure
    if (view.baseUrl && view.botKey) {
      const keep = await prompter.confirm({
        message: `Keep existing Sabha bot${accountLabel} at ${view.baseUrl}?`,
        initialValue: true,
      });
      if (keep) return { cfg };
    }

    const mode = await prompter.select<"join" | "manual">({
      message: "How would you like to connect to Sabha?",
      options: [
        {
          value: "join",
          label: "Paste a join URL (recommended)",
          hint: "Self-registers a bot via your Sabha join code",
        },
        {
          value: "manual",
          label: "I already have a bot key",
          hint: "Enter a bot key and server URL directly",
        },
      ],
      initialValue: "join",
    });

    if (mode === "join") {
      const joinUrl = await prompter.text({
        message: "Sabha join URL",
        placeholder: "https://sabha.co/1000101/join/Ccnp-m7vD-L3aj",
        validate: (value) => {
          if (!value.trim()) return "Required";
          return parseJoinUrl(value)
            ? undefined
            : "Invalid join URL. Expected: https://chat.example.com/join/CODE";
        },
      });

      const parsed = parseJoinUrl(joinUrl)!;
      const progress = prompter.progress("Registering bot with Sabha");

      try {
        const result = await selfRegisterBot(parsed.baseUrl, parsed.joinCode, {
          name: "OpenClaw",
        });
        progress.stop(`Bot "${result.name}" registered`);

        // Auto-join all open rooms so the bot is immediately discoverable
        await autoJoinOpenRooms(parsed.baseUrl, result.bot_key, prompter);

        return {
          cfg: setBotAccountConfig(cfg, accountId, {
            baseUrl: parsed.baseUrl,
            botKey: result.bot_key,
            botName: result.name,
            websocketUrl: result.websocket_url,
            dmPolicy: view.dmPolicy ?? "open",
          }),
        };
      } catch (err) {
        progress.stop("Registration failed");

        if (err instanceof SabhaRegistrationError) {
          if (err.code === "self_registration_disabled") {
            await prompter.note(
              [
                "This Sabha server has bot self-registration disabled.",
                "",
                "Ask your admin to either:",
                "  1. Enable self-registration at /account/bots settings, or",
                "  2. Create a bot manually and share its bot key with you",
                "",
                "Then re-run the setup and choose 'I already have a bot key'.",
              ].join("\n"),
              "Self-registration disabled",
            );
          } else if (err.code === "join_code_not_found" || err.status === 404) {
            await prompter.note(
              `Join code not found. Double-check the URL: ${joinUrl}`,
              "Invalid join code",
            );
          } else if (err.code === "join_code_inactive" || err.code === "join_code_expired") {
            await prompter.note(
              "This join code has expired or been revoked. Ask your admin for a new one.",
              "Join code expired",
            );
          } else if (err.code === "rate_limited") {
            await prompter.note(
              "Too many registration attempts. Wait a minute and try again.",
              "Rate limited",
            );
          }
        }
        throw err;
      }
    }

    // Manual path — user already has a bot key
    const baseUrl = await prompter.text({
      message: "Sabha server URL",
      placeholder: "https://sabha.co/1000006",
      initialValue: view.baseUrl,
      validate: (value) => {
        if (!value.trim()) return "Required";
        try {
          new URL(value);
          return undefined;
        } catch {
          return "Invalid URL";
        }
      },
    });

    const botKey = await prompter.text({
      message: "Bot key",
      placeholder: "42-AbCdEfGhIjKl",
      initialValue: view.botKey,
      validate: (value) => {
        if (!value.trim()) return "Required";
        if (!/^\d+-/.test(value)) return 'Expected format: "42-AbCdEfGhIjKl"';
        return undefined;
      },
    });

    const botNameInput = await prompter.text({
      message: "Bot display name",
      placeholder: "OpenClaw",
      initialValue: view.botName ?? "OpenClaw",
      validate: (value) => (value.trim() ? undefined : "Required"),
    });

    const resolvedBaseUrl = baseUrl.replace(/\/+$/, "");
    const resolvedBotKey = botKey.trim();

    // Auto-join all open rooms so the bot is immediately discoverable
    await autoJoinOpenRooms(resolvedBaseUrl, resolvedBotKey, prompter);

    return {
      cfg: setBotAccountConfig(cfg, accountId, {
        baseUrl: resolvedBaseUrl,
        botKey: resolvedBotKey,
        botName: botNameInput.trim(),
        dmPolicy: view.dmPolicy ?? "open",
      }),
    };
  },

  completionNote: {
    title: "Sabha Connected",
    lines: [
      "Your bot is registered and connected via WebSocket.",
      "Messages will be received in real-time without webhook configuration.",
    ],
  },

  dmPolicy: {
    label: "DM policy",
    channel: "sabha",
    policyKey: "channels.sabha.dmPolicy",
    allowFromKey: "channels.sabha.allowFrom",
    getCurrent: (cfg: OpenClawConfig, accountId?: string) => {
      const view = getBotAccountView(cfg, accountId);
      return (view.dmPolicy ?? "open") as "open" | "allowlist";
    },
    setPolicy: (cfg: OpenClawConfig, policy: string, accountId?: string) => {
      const dmPolicy = policy === "allowlist" ? "allowlist" : "open";
      return setBotAccountConfig(cfg, accountId, { dmPolicy });
    },
  },
};
