import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import type { ChannelSetupWizard } from "openclaw/plugin-sdk/channel-setup";
import {
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
} from "openclaw/plugin-sdk/account-core";
import type { SabhaConfig, SabhaRoom } from "./types.js";
import { SabhaClient, SabhaApiError } from "./client.js";
import {
  listBotAccountIds,
  mergeBotAccountConfig,
  resolveDefaultBotAccountId,
} from "./bot-accounts.js";

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

type ProbeResult =
  | { ok: true }
  | { ok: false; kind: "auth"; message: string }
  | { ok: false; kind: "network"; message: string };

type BaseUrlProbeResult =
  | { ok: true }
  | { ok: false; kind: "invalid"; message: string }
  | { ok: false; kind: "network"; message: string };

const BASE_URL_PROBE_TIMEOUT_MS = 10_000;

/**
 * Probe `{baseUrl}/skill` to decide whether `baseUrl` actually points at a
 * Sabha server. `/skill` is the unauthenticated LLM-readable API reference
 * (see `src/skill-prompt.ts`), which lets the wizard separate "wrong URL"
 * from "wrong bot key" — a bad URL fails here, a bad key fails later in
 * `probeBotKey`.
 *
 * Classification:
 * - `invalid` — reached an HTTP server but the response doesn't look like
 *   `/skill` (non-2xx, empty body, or an HTML page). Re-prompting the URL
 *   is the right action.
 * - `network` — couldn't reach anything at all (DNS, refused, TLS, timeout).
 *   User may prefer to save and come back later.
 */
async function probeBaseUrl(baseUrl: string): Promise<BaseUrlProbeResult> {
  const url = `${baseUrl}/skill`;
  let res: Response;
  try {
    res = await globalThis.fetch(url, {
      headers: { Accept: "text/plain" },
      signal: AbortSignal.timeout(BASE_URL_PROBE_TIMEOUT_MS),
    });
  } catch (err) {
    const cause = err instanceof Error ? err : new Error(String(err));
    if (cause.name === "AbortError" || cause.name === "TimeoutError") {
      return {
        ok: false,
        kind: "network",
        message: `Timed out after ${BASE_URL_PROBE_TIMEOUT_MS / 1000}s reaching ${url}`,
      };
    }
    return {
      ok: false,
      kind: "network",
      message: `Could not reach ${url}: ${cause.message}`,
    };
  }

  if (!res.ok) {
    return {
      ok: false,
      kind: "invalid",
      message: `${url} returned HTTP ${res.status} — this doesn't look like a Sabha server.`,
    };
  }

  const body = (await res.text().catch(() => "")).trim();
  if (!body) {
    return {
      ok: false,
      kind: "invalid",
      message: `${url} returned an empty body — this doesn't look like a Sabha server.`,
    };
  }
  // Rails default error pages / login redirects land here with HTML. The
  // real /skill endpoint returns plain markdown/text, so an HTML response
  // means we're either at the wrong workspace prefix or not pointed at
  // Sabha at all.
  if (/^<(?:!doctype|html|head|body)/i.test(body)) {
    return {
      ok: false,
      kind: "invalid",
      message: `${url} returned HTML instead of Sabha's /skill text. Check the workspace prefix in the URL (e.g. https://sabha.co/1000006).`,
    };
  }
  return { ok: true };
}

/**
 * Verify that `baseUrl` + `botKey` actually authenticate against a Sabha
 * server. Called from the manual setup path before the config is written,
 * so a typo/expired key is caught at setup time instead of silently
 * saving and then spinning the gateway's account supervisor through
 * ~15 minutes of "unauthorized" reconnect attempts.
 *
 * Classifies failures so the wizard can react differently:
 * - `auth` — server reachable but rejected the credential (401/403/404,
 *   or an HTML login page that failed JSON parse). Re-prompt is sensible.
 * - `network` — server unreachable or erroring in a way that doesn't
 *   indicate credential validity. "Save anyway" is sensible.
 */
async function probeBotKey(
  baseUrl: string,
  botKey: string,
): Promise<ProbeResult> {
  const client = new SabhaClient(baseUrl, botKey);
  try {
    await client.listJoinableRooms();
    return { ok: true };
  } catch (err) {
    if (err instanceof SabhaApiError) {
      if (err.status === 401 || err.status === 403 || err.status === 404) {
        return {
          ok: false,
          kind: "auth",
          message: `Server rejected the bot key (HTTP ${err.status})`,
        };
      }
      return {
        ok: false,
        kind: "network",
        message: `Server returned HTTP ${err.status}`,
      };
    }
    // `listJoinableRooms` calls `res.json()` — a 200 response that is
    // actually an HTML login page (common Rails default for an invalid
    // bot key) surfaces here as SyntaxError, not SabhaApiError. Treat
    // that as an auth problem since the server clearly didn't route
    // us to the JSON API.
    if (err instanceof SyntaxError) {
      return {
        ok: false,
        kind: "auth",
        message:
          "Server returned a non-JSON response — the bot key is likely invalid or the server URL is wrong.",
      };
    }
    return {
      ok: false,
      kind: "network",
      message: formatError(err),
    };
  }
}

/**
 * Run a probe and, on failure, ask the user whether to retry, save
 * anyway, or abort. Returns the user's decision so the caller can loop
 * back to re-prompting for credentials when the user picks "retry".
 */
async function verifyBotKeyInteractive(
  baseUrl: string,
  botKey: string,
  prompter: WizardPrompter,
): Promise<"accepted" | "retry" | "save-anyway"> {
  const progress = prompter.progress("Verifying bot key");
  const result = await probeBotKey(baseUrl, botKey);
  if (result.ok) {
    progress.stop("Bot key accepted");
    return "accepted";
  }
  progress.stop("Bot key verification failed");

  const title =
    result.kind === "auth"
      ? "Bot key rejected"
      : "Could not reach Sabha server";
  await prompter.note(result.message, title);

  const action = await prompter.select<"retry" | "save-anyway" | "abort">({
    message: "What would you like to do?",
    options: [
      {
        value: "retry",
        label: "Re-enter server URL and bot key",
        hint: "Recommended",
      },
      {
        value: "save-anyway",
        label: "Save anyway",
        hint: "Gateway will fail to connect until fixed",
      },
      { value: "abort", label: "Abort setup" },
    ],
    initialValue: "retry",
  });

  if (action === "abort") {
    throw new SabhaRegistrationError(
      "Bot key verification failed; setup aborted.",
      "verification_aborted",
    );
  }
  return action;
}

/**
 * Run `probeBaseUrl` and, on failure, let the user retry, save anyway,
 * or abort. Mirrors `verifyBotKeyInteractive` but with a different set
 * of failure messages — an invalid base URL is almost always a typo in
 * the workspace prefix, so we hint toward that.
 */
async function verifyBaseUrlInteractive(
  baseUrl: string,
  prompter: WizardPrompter,
): Promise<"accepted" | "retry" | "save-anyway"> {
  const progress = prompter.progress("Checking Sabha server URL");
  const result = await probeBaseUrl(baseUrl);
  if (result.ok) {
    progress.stop("Server URL looks good");
    return "accepted";
  }
  progress.stop("Server URL check failed");

  const title =
    result.kind === "invalid"
      ? "URL doesn't look like a Sabha server"
      : "Could not reach Sabha server";
  await prompter.note(result.message, title);

  const action = await prompter.select<"retry" | "save-anyway" | "abort">({
    message: "What would you like to do?",
    options: [
      {
        value: "retry",
        label: "Re-enter the server URL",
        hint: "Recommended",
      },
      {
        value: "save-anyway",
        label: "Save anyway",
        hint: "Gateway will fail to connect until fixed",
      },
      { value: "abort", label: "Abort setup" },
    ],
    initialValue: "retry",
  });

  if (action === "abort") {
    throw new SabhaRegistrationError(
      "Server URL verification failed; setup aborted.",
      "verification_aborted",
    );
  }
  return action;
}

/**
 * Returns `true` if `accountId` refers to the default bot account.
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
 * Return every bot account id that currently has both a `baseUrl` and a
 * `botKey` persisted (via its own entry or via the base layered through
 * `mergeBotAccountConfig`). Powers the multi-bot selector's Edit list
 * and the "Keep existing bot?" shortcut in `finalize`.
 *
 * `listBotAccountIds` from `bot-accounts.ts` only surfaces the default
 * slot via its empty-map fallback, so on a multi-bot config where named
 * accounts exist we have to check the default slot explicitly or it
 * gets hidden from the Edit list.
 */
export function listConfiguredBotAccountIds(
  cfg: OpenClawConfig,
): string[] {
  const ids: string[] = [];

  const defaultView = getBotAccountView(cfg, DEFAULT_ACCOUNT_ID);
  if (defaultView.baseUrl && defaultView.botKey) {
    ids.push(DEFAULT_ACCOUNT_ID);
  }

  for (const id of listBotAccountIds(cfg)) {
    if (id === DEFAULT_ACCOUNT_ID) continue;
    const view = getBotAccountView(cfg, id);
    if (view.baseUrl && view.botKey && !ids.includes(id)) {
      ids.push(id);
    }
  }

  return ids;
}

/**
 * Write setup output for one bot account. All accounts (including the
 * default) are written into `botAccounts.<id>`.
 */
export function setBotAccountConfig(
  cfg: OpenClawConfig,
  accountId: string | undefined | null,
  patch: Partial<SabhaConfig>,
): OpenClawConfig {
  const channels = (cfg.channels ?? {}) as Record<string, unknown>;
  const existing = (channels.sabha ?? {}) as Record<string, unknown>;

  const id = isDefaultBotAccount(accountId)
    ? DEFAULT_ACCOUNT_ID
    : normalizeAccountId(accountId!);
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
        enabled: existing.enabled !== false,
        botAccounts,
      },
    },
  };
}

export const sabhaSetupWizard: ChannelSetupWizard = {
  channel: "sabha",

  // We own account-id resolution via `resolveAccountIdForConfigure`
  // below, so tell the SDK's default prompter to stay out of the way.
  // The default runner would otherwise ask a generic "which account?"
  // question that doesn't understand our Add-vs-Edit flow.
  resolveShouldPromptAccountIds: () => false,

  // Wizard-time account picker. On first run there is nothing to pick,
  // so fall through to the SDK's `defaultAccountId`. On subsequent
  // runs with at least one configured bot we offer an explicit
  // Add-new-bot option so operators can stand up a second bot without
  // hand-editing `~/.openclaw/openclaw.json`.
  resolveAccountIdForConfigure: async ({
    cfg,
    prompter,
    accountOverride,
    defaultAccountId,
  }) => {
    // Programmatic callers (CLI flags, env, automated provisioning)
    // pass the account id explicitly; honor it without prompting.
    const override = accountOverride?.trim();
    if (override) return normalizeAccountId(override);

    const configured = listConfiguredBotAccountIds(cfg);
    if (configured.length === 0) return defaultAccountId;

    const choice = await prompter.select<string>({
      message: "Which Sabha bot account do you want to set up?",
      options: [
        ...configured.map((id) => ({
          value: `edit:${id}`,
          label:
            id === DEFAULT_ACCOUNT_ID
              ? "Edit the primary bot"
              : `Edit ${id}`,
        })),
        {
          value: "new",
          label: "Add a new bot account",
          hint: "Stored under channels.sabha.botAccounts.<id>",
        },
      ],
      initialValue: `edit:${configured[0]}`,
    });

    if (choice !== "new") {
      return choice.slice("edit:".length);
    }

    const name = await prompter.text({
      message: "Bot account name",
      placeholder: "Analyst",
      validate: (value) => {
        if (!value.trim()) return "Required";
        const id = normalizeAccountId(value.trim());
        if (id === DEFAULT_ACCOUNT_ID) {
          return `"${DEFAULT_ACCOUNT_ID}" is reserved for the primary bot — pick another name`;
        }
        if (configured.includes(id)) {
          return "An account with this name already exists — pick Edit instead";
        }
        return undefined;
      },
    });
    const accountId = normalizeAccountId(name.trim());
    if (name.trim() !== accountId) {
      await prompter.note(
        `Account id will be "${accountId}".`,
        "Sabha account",
      );
    }
    return accountId;
  },

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

    // Only offer "Keep existing" for accounts that actually have their
    // own credentials persisted. For a brand-new named slot picked via
    // the Add-new-bot flow, `view` inherits the default bot's baseUrl /
    // botKey through `mergeBotAccountConfig`, which would otherwise
    // trigger a misleading shortcut against a bot that hasn't been
    // configured yet.
    const isAlreadyConfigured =
      listConfiguredBotAccountIds(cfg).includes(
        accountId ? normalizeAccountId(accountId) : DEFAULT_ACCOUNT_ID,
      );

    if (isAlreadyConfigured && view.baseUrl && view.botKey) {
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

    // Manual path — user already has a bot key. Runs two independent
    // probes so each failure mode has a precise error message:
    //
    //   1. `verifyBaseUrlInteractive` hits `{baseUrl}/skill` (unauthenticated)
    //      to confirm we're pointed at a real Sabha server at the right
    //      workspace prefix. Wrong URL = retry the URL prompt only.
    //   2. `verifyBotKeyInteractive` hits an authenticated endpoint with
    //      the now-trusted baseUrl. Wrong key = retry *both* URL and key
    //      (the bot key can only be "wrong" in the sense of "invalid for
    //      this workspace," which may mean the workspace URL is also
    //      wrong — the advertised retry label says as much, so we honor
    //      it by re-prompting the URL from the outer loop below).
    //
    // Pre-filling `initialValue` with the last attempt makes "retry" a
    // one-keystroke correction instead of re-typing everything: the
    // user can hit enter through prompts they don't want to change.
    let pendingBaseUrl = view.baseUrl ?? "";
    let pendingBotKey = view.botKey ?? "";
    let pendingBotName = view.botName ?? "OpenClaw";
    let baseUrlAccepted = false;
    let botKeyAccepted = false;

    credentialsLoop: while (true) {
      baseUrlAccepted = false;
      botKeyAccepted = false;

      // Inner loop: re-prompt the URL alone on a base-URL-only retry
      // (the URL probe's label is "Re-enter the server URL", so this
      // one doesn't drag the bot key along).
      while (true) {
        const baseUrl = await prompter.text({
          message: "Sabha server URL",
          placeholder: "https://sabha.co/1000006",
          initialValue: pendingBaseUrl,
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
        pendingBaseUrl = baseUrl.replace(/\/+$/, "");

        const decision = await verifyBaseUrlInteractive(
          pendingBaseUrl,
          prompter,
        );
        if (decision === "retry") continue;
        baseUrlAccepted = decision === "accepted";
        break;
      }

      const botKey = await prompter.text({
        message: "Bot key",
        placeholder: "42-AbCdEfGhIjKl",
        initialValue: pendingBotKey,
        validate: (value) => {
          if (!value.trim()) return "Required";
          if (!/^\d+-/.test(value)) return 'Expected format: "42-AbCdEfGhIjKl"';
          return undefined;
        },
      });
      pendingBotKey = botKey.trim();

      // Only run the authenticated probe when we trust the base URL;
      // otherwise we'd be hitting a server we've already told the user
      // is unreliable, and the resulting error would be noise.
      if (baseUrlAccepted) {
        const decision = await verifyBotKeyInteractive(
          pendingBaseUrl,
          pendingBotKey,
          prompter,
        );
        // Bot-key retry jumps to the outer loop so the user gets a
        // fresh pass at *both* the URL and the key — the "retry" label
        // on that select promises "Re-enter server URL and bot key",
        // so this honors it. Without this, a user who entered the
        // correct-looking workspace URL for the wrong workspace would
        // be trapped re-typing bot keys forever.
        if (decision === "retry") continue credentialsLoop;
        botKeyAccepted = decision === "accepted";
      }
      break;
    }

    const botNameInput = await prompter.text({
      message: "Bot display name",
      placeholder: "OpenClaw",
      initialValue: pendingBotName,
      validate: (value) => (value.trim() ? undefined : "Required"),
    });
    pendingBotName = botNameInput.trim();

    // Auto-join open rooms only when *both* probes accepted. If either
    // was a "save-anyway" or couldn't run, hitting the authenticated
    // API again would just re-surface the same error (wrong URL, wrong
    // key, or unreachable server) as a noisy "Auto-join skipped" note.
    if (baseUrlAccepted && botKeyAccepted) {
      await autoJoinOpenRooms(pendingBaseUrl, pendingBotKey, prompter);
    }

    return {
      cfg: setBotAccountConfig(cfg, accountId, {
        baseUrl: pendingBaseUrl,
        botKey: pendingBotKey,
        botName: pendingBotName,
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
    policyKey: "channels.sabha.botAccounts.default.dmPolicy",
    allowFromKey: "channels.sabha.botAccounts.default.allowFrom",
    resolveConfigKeys: (cfg: OpenClawConfig, accountId?: string) => {
      const id = accountId
        ? normalizeAccountId(accountId)
        : resolveDefaultBotAccountId(cfg);
      return {
        policyKey: `channels.sabha.botAccounts.${id}.dmPolicy`,
        allowFromKey: `channels.sabha.botAccounts.${id}.allowFrom`,
      };
    },
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
