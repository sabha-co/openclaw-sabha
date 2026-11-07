import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import type { ChannelSetupWizard } from "openclaw/plugin-sdk/channel-setup";
import { APP_KEY_PATTERN, describeProbeFailure, probeSabhaApp } from "../client/probe.js";
import {
  deriveCableUrl,
  listSabhaAccountIds,
  normalizeCableUrl,
  normalizeWorkspaceUrl,
  patchSabhaAccount,
  resolveDefaultSabhaAccountId,
  resolveSabhaAccount,
} from "./accounts.js";

type Prompter = Parameters<NonNullable<ChannelSetupWizard["finalize"]>>[0]["prompter"];

function configuredAccountIds(cfg: OpenClawConfig): string[] {
  return listSabhaAccountIds(cfg).filter((id) => resolveSabhaAccount(cfg, id).configured);
}


async function promptCredentials(params: {
  prompter: Prompter;
  url: string;
  cableUrl: string;
  appKey: string;
}): Promise<{ url: string; cableUrl?: string; appKey: string } | undefined> {
  const { prompter } = params;
  let { url, cableUrl, appKey } = params;
  await prompter.note(
    "Copy these from the app's page in Sabha (Settings → Apps). The key is shown once, when the app is made.",
    "Sabha",
  );
  for (;;) {
    url = normalizeWorkspaceUrl(
      await prompter.text({
        message: "API base URL",
        placeholder: "https://sabha.example.com/api/v1",
        initialValue: url ? `${url}/api/v1` : "",
        validate: (value) => (normalizeWorkspaceUrl(value) ? undefined : "Enter an http(s) URL"),
      }),
    );
    // The WebSocket can live on another host or port than the API, so ask rather than assume.
    const derived = deriveCableUrl(url);
    cableUrl = normalizeCableUrl(
      await prompter.text({
        message: "WebSocket URL",
        placeholder: derived,
        initialValue: cableUrl || derived,
        validate: (value) => (!value.trim() || normalizeCableUrl(value) ? undefined : "Enter a ws(s) URL"),
      }),
    ) || derived;
    appKey = (
      await prompter.text({
        message: "App key",
        placeholder: "sabha_app_…",
        initialValue: appKey,
        validate: (value) => (APP_KEY_PATTERN.test(value.trim()) ? undefined : 'Expected "sabha_app_" followed by 32 hex characters'),
      })
    ).trim();

    const progress = prompter.progress("Checking the app key with Sabha");
    const result = await probeSabhaApp({ apiBaseUrl: `${url}/api/v1`, appKey });
    if (result.ok) {
      progress.stop(`Connected as ${result.identity.name}`);
      return { url, appKey, ...(cableUrl !== derived ? { cableUrl } : {}) };
    }
    progress.stop("Sabha didn't accept these details");
    await prompter.note(describeProbeFailure(result), "Sabha");
    const next = await prompter.select<"retry" | "save" | "cancel">({
      message: "What next?",
      options: [
        { value: "retry", label: "Re-enter the URLs and key" },
        { value: "save", label: "Save anyway", hint: "The gateway will keep retrying until Sabha accepts it" },
        { value: "cancel", label: "Cancel" },
      ],
      initialValue: "retry",
    });
    if (next === "save") return { url, appKey, ...(cableUrl !== derived ? { cableUrl } : {}) };
    if (next === "cancel") return undefined;
  }
}

export const sabhaSetupWizard: ChannelSetupWizard = {
  channel: "sabha",
  resolveShouldPromptAccountIds: () => false,

  // First run configures the default account. Later runs offer each
  // configured account or a new named one, so a second app needs no hand edits.
  resolveAccountIdForConfigure: async ({ cfg, prompter, accountOverride, defaultAccountId }) => {
    const override = accountOverride?.trim();
    if (override) return normalizeAccountId(override);

    const configured = configuredAccountIds(cfg);
    if (configured.length === 0) return defaultAccountId;

    const choice = await prompter.select<string>({
      message: "Which Sabha app do you want to set up?",
      options: [
        ...configured.map((id) => ({ value: `edit:${id}`, label: id === DEFAULT_ACCOUNT_ID ? "Edit the primary app" : `Edit ${id}` })),
        { value: "new", label: "Add another app", hint: "Stored under channels.sabha.accounts.<id>" },
      ],
      initialValue: `edit:${configured[0]}`,
    });
    if (choice !== "new") return choice.slice("edit:".length);

    const name = await prompter.text({
      message: "Account id for the new app",
      placeholder: "analyst",
      validate: (value) => {
        const id = normalizeAccountId(value.trim());
        if (!value.trim()) return "Required";
        if (id === DEFAULT_ACCOUNT_ID) return `"${DEFAULT_ACCOUNT_ID}" is the primary app; pick another id`;
        if (configured.includes(id)) return "That account exists; choose Edit instead";
        return undefined;
      },
    });
    return normalizeAccountId(name.trim());
  },

  status: {
    configuredLabel: "Sabha (connected)",
    unconfiguredLabel: "Sabha",
    configuredHint: "App key saved",
    unconfiguredHint: "Connect an app to a Sabha workspace",
    resolveConfigured: ({ cfg, accountId }) => resolveSabhaAccount(cfg, accountId).configured,
  },

  introNote: {
    title: "Sabha setup",
    lines: [
      "An admin creates the app in Sabha under Settings → Apps and copies its key.",
      "You'll need the workspace URL and that app key (sabha_app_…).",
      "Then add the app to the rooms it should answer in.",
    ],
  },

  credentials: [],

  finalize: async ({ cfg, accountId, prompter }) => {
    const id = accountId ? normalizeAccountId(accountId) : resolveDefaultSabhaAccountId(cfg);
    const current = resolveSabhaAccount(cfg, id);
    if (configuredAccountIds(cfg).includes(id)) {
      const keep = await prompter.confirm({ message: `Keep the Sabha app saved for ${current.url}?`, initialValue: true });
      if (keep) return { cfg };
    }
    const credentials = await promptCredentials({ prompter, url: current.url, cableUrl: current.config.cableUrl ?? "", appKey: current.appKey });
    if (!credentials) return { cfg };
    return { cfg: patchSabhaAccount(cfg, id, { ...credentials, dmPolicy: current.dmPolicy }) };
  },

  completionNote: {
    title: "Sabha connected",
    lines: [
      "The gateway connects out to Sabha over a WebSocket; no public address is needed.",
      "Mention the app in a room it belongs to, or send it a DM.",
    ],
  },

  dmPolicy: {
    label: "DM policy",
    channel: "sabha",
    policyKey: `channels.sabha.accounts.${DEFAULT_ACCOUNT_ID}.dmPolicy`,
    allowFromKey: `channels.sabha.accounts.${DEFAULT_ACCOUNT_ID}.allowFrom`,
    resolveConfigKeys: (cfg: OpenClawConfig, accountId?: string) => {
      const id = accountId ? normalizeAccountId(accountId) : resolveDefaultSabhaAccountId(cfg);
      return { policyKey: `channels.sabha.accounts.${id}.dmPolicy`, allowFromKey: `channels.sabha.accounts.${id}.allowFrom` };
    },
    getCurrent: (cfg: OpenClawConfig, accountId?: string) => resolveSabhaAccount(cfg, accountId).dmPolicy,
    setPolicy: (cfg: OpenClawConfig, policy: string, accountId?: string) =>
      patchSabhaAccount(cfg, accountId ? normalizeAccountId(accountId) : resolveDefaultSabhaAccountId(cfg), {
        dmPolicy: policy === "allowlist" ? "allowlist" : "open",
      }),
  },
};
