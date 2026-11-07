// `openclaw sabha setup|doctor`. Setup takes what the app's page in Sabha
// (Settings → Apps) shows: the API base URL, the WebSocket URL and the key.
// There is no self-registration.
import { createInterface } from "node:readline/promises";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import type { OpenClawConfig, OpenClawPluginApi } from "openclaw/plugin-sdk/channel-core";
import { APP_KEY_PATTERN, describeProbeFailure, probeSabhaApp } from "./client/probe.js";
import {
  deriveCableUrl,
  listEnabledSabhaAccounts,
  normalizeCableUrl,
  normalizeWorkspaceUrl,
  patchSabhaAccount,
  resolveSabhaAccount,
} from "./config/accounts.js";
import { formatDoctorReport, runSabhaDoctor } from "./doctor.js";

type Program = Parameters<Parameters<OpenClawPluginApi["registerCli"]>[0]>[0]["program"];

type SetupOptions = { url?: string; cableUrl?: string; key?: string; account: string; skipVerify?: boolean };

/** Ask on a terminal for whatever the flags left out. */
async function fillFromTerminal(options: SetupOptions): Promise<SetupOptions> {
  if (options.url && (options.key || process.env.SABHA_APP_KEY)) return options;
  if (!process.stdin.isTTY) return options;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log("Copy these from the app's page in Sabha (Settings → Apps). The key is shown once.");
    const url = options.url ?? (await rl.question("API base URL: ")).trim();
    const derived = deriveCableUrl(normalizeWorkspaceUrl(url));
    const cableUrl = options.cableUrl ?? ((await rl.question(`WebSocket URL [${derived}]: `)).trim() || undefined);
    const key = options.key ?? process.env.SABHA_APP_KEY ?? (await rl.question("App key: ")).trim();
    return { ...options, url, ...(cableUrl ? { cableUrl } : {}), key };
  } finally {
    rl.close();
  }
}

export function registerSabhaCli(params: {
  program: Program;
  getConfig: () => OpenClawConfig;
  writeConfig: (cfg: OpenClawConfig) => Promise<void>;
}): void {
  const sabha = params.program.command("sabha").description("Sabha channel commands");

  sabha
    .command("setup")
    .description("Connect a Sabha app: check the URLs and key with Sabha, then save them")
    .option("--url <url>", "API base URL from the app's page, e.g. https://chat.example.com/api/v1")
    .option("--cable-url <url>", "WebSocket URL from the app's page (default: /cable on the same host)")
    .option("--key <appKey>", "app key (sabha_app_…); defaults to $SABHA_APP_KEY")
    .option("-a, --account <id>", "account id", DEFAULT_ACCOUNT_ID)
    .option("--skip-verify", "save without contacting Sabha")
    .action(async (flags: SetupOptions) => {
      const options = await fillFromTerminal(flags);
      const url = normalizeWorkspaceUrl(options.url);
      const appKey = (options.key ?? process.env.SABHA_APP_KEY ?? "").trim();
      if (!url) return fail(options.url ? `Not an http(s) URL: ${options.url}` : "Pass --url with the API base URL from the app's page.");
      if (!APP_KEY_PATTERN.test(appKey)) return fail("The app key should look like sabha_app_ followed by 32 hex characters.");
      const cableUrl = options.cableUrl ? normalizeCableUrl(options.cableUrl) : "";
      if (options.cableUrl && !cableUrl) return fail(`Not a ws(s) URL: ${options.cableUrl}`);
      if (!options.skipVerify) {
        const probe = await probeSabhaApp({ apiBaseUrl: `${url}/api/v1`, appKey });
        if (!probe.ok) return fail(describeProbeFailure(probe));
        console.log(`✓ Sabha knows this key: app "${probe.identity.name}" (id ${probe.identity.id})`);
      }
      const accountId = normalizeAccountId(options.account);
      await params.writeConfig(patchSabhaAccount(params.getConfig(), accountId, { url, appKey, ...(cableUrl ? { cableUrl } : {}) }));
      console.log(`✓ Saved channels.sabha.accounts.${accountId}`);
      console.log("Check the live connection with: openclaw sabha doctor");
      console.log("Then restart the gateway: openclaw gateway restart");
    });

  sabha
    .command("doctor")
    .description("Check a Sabha account's config, API key and live connection")
    .option("-a, --account <id>", "account id (default: every enabled account)")
    .action(async (options: { account?: string }) => {
      const cfg = params.getConfig();
      const accounts = options.account ? [resolveSabhaAccount(cfg, options.account)] : listEnabledSabhaAccounts(cfg);
      if (accounts.length === 0) {
        console.log("No enabled Sabha accounts. Run: openclaw sabha setup");
        return;
      }
      let ok = true;
      for (const account of accounts) {
        const report = await runSabhaDoctor(account);
        console.log(formatDoctorReport(report));
        ok &&= report.ok;
      }
      if (!ok) process.exitCode = 1;
    });
}

function fail(message: string): void {
  console.error(message);
  process.exitCode = 1;
}
