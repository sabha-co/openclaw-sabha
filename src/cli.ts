// `openclaw sabha setup|doctor`. Setup takes the workspace URL and an app key
// an admin created in Sabha (Settings → Apps); there is no self-registration.
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import type { OpenClawConfig, OpenClawPluginApi } from "openclaw/plugin-sdk/channel-core";
import { APP_KEY_PATTERN, describeProbeFailure, probeSabhaApp } from "./client/probe.js";
import { listEnabledSabhaAccounts, normalizeWorkspaceUrl, patchSabhaAccount, resolveSabhaAccount } from "./config/accounts.js";
import { formatDoctorReport, runSabhaDoctor } from "./doctor.js";

type Program = Parameters<Parameters<OpenClawPluginApi["registerCli"]>[0]>[0]["program"];

export function registerSabhaCli(params: {
  program: Program;
  getConfig: () => OpenClawConfig;
  writeConfig: (cfg: OpenClawConfig) => Promise<void>;
}): void {
  const sabha = params.program.command("sabha").description("Sabha channel commands");

  sabha
    .command("setup")
    .description("Connect a Sabha app: verify the URL and key with Sabha, then save them")
    .requiredOption("--url <url>", "workspace URL, e.g. https://sabha.co/1000006")
    .option("--key <appKey>", "app key (sabha_app_…); defaults to $SABHA_APP_KEY")
    .option("-a, --account <id>", "account id", DEFAULT_ACCOUNT_ID)
    .option("--skip-verify", "save without contacting Sabha")
    .action(async (options: { url: string; key?: string; account: string; skipVerify?: boolean }) => {
      const url = normalizeWorkspaceUrl(options.url);
      const appKey = (options.key ?? process.env.SABHA_APP_KEY ?? "").trim();
      if (!url) return fail(`Not a workspace URL: ${options.url}`);
      if (!APP_KEY_PATTERN.test(appKey)) return fail("The app key should look like sabha_app_ followed by 32 hex characters.");
      if (!options.skipVerify) {
        const probe = await probeSabhaApp({ apiBaseUrl: `${url}/api/v1`, appKey });
        if (!probe.ok) return fail(describeProbeFailure(probe));
        console.log(`✓ Sabha knows this key: app "${probe.identity.name}" (id ${probe.identity.id})`);
      }
      const accountId = normalizeAccountId(options.account);
      await params.writeConfig(patchSabhaAccount(params.getConfig(), accountId, { url, appKey }));
      console.log(`✓ Saved channels.sabha.accounts.${accountId}`);
      console.log("Restart the gateway to connect: openclaw gateway restart");
    });

  sabha
    .command("doctor")
    .description("Check a Sabha account's config, API key and live connection")
    .option("-a, --account <id>", "account id (default: every enabled account)")
    .action(async (options: { account?: string }) => {
      const cfg = params.getConfig();
      const accounts = options.account ? [resolveSabhaAccount(cfg, options.account)] : listEnabledSabhaAccounts(cfg);
      if (accounts.length === 0) {
        console.log("No enabled Sabha accounts. Run: openclaw sabha setup --url <workspace URL> --key <app key>");
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
