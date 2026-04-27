import type { Command } from "commander";
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import {
  parseJoinUrl,
  selfRegisterBot,
  setSabhaAccountConfig,
} from "./setup-wizard.js";
import {
  listConfiguredSabhaAccountIds,
  listEnabledSabhaAccounts,
  resolveSabhaAccount,
  resolveDefaultSabhaAccountId,
} from "./accounts.js";
import { runDoctor, formatDoctorReport } from "./doctor.js";

export type RegisterSabhaCliOpts = {
  program: Command;
  getConfig: () => OpenClawConfig;
  writeConfigFile: (cfg: OpenClawConfig) => Promise<void>;
};

/**
 * Register `openclaw sabha ...` CLI commands.
 *
 * Supports:
 *   openclaw sabha setup <joinUrl>    — register a bot from a Sabha join URL
 *   openclaw sabha doctor [--account] — run runtime health checks
 */
export function registerSabhaCli({ program, getConfig, writeConfigFile }: RegisterSabhaCliOpts): void {
  const sabha = program
    .command("sabha")
    .description("Sabha channel commands");

  sabha
    .command("setup <joinUrl>")
    .description("Register a Sabha bot from a join URL and save credentials")
    .action(async (joinUrl: string) => {
      const parsed = parseJoinUrl(joinUrl);
      if (!parsed) {
        console.error(`Invalid Sabha join URL: ${joinUrl}`);
        console.error("Expected format: https://chat.example.com/join/CODE");
        console.error("              or: https://chat.example.com/1000006/join/CODE");
        process.exit(1);
      }

      try {
        console.log(`Registering bot at ${parsed.baseUrl}...`);
        const result = await selfRegisterBot(parsed.baseUrl, parsed.joinCode, {
          name: "OpenClaw",
        });

        const resolvedBaseUrl = result.base_url || parsed.baseUrl;
        const resolvedApiBaseUrl =
          result.api_base_url || `${resolvedBaseUrl}/api/bots`;

        // Write into the canonical multi-account shape
        // (`channels.sabha.accounts.default.*`) via the wizard's setter.
        // The base block keeps `enabled: true` automatically; the patch
        // only carries per-account fields. Matches what
        // `sabhaSetupWizard.finalize` writes during `openclaw configure`,
        // so the two setup paths stay in lock-step.
        const cfg = getConfig();
        const nextCfg = setSabhaAccountConfig(cfg, undefined, {
          baseUrl: resolvedBaseUrl,
          apiBaseUrl: resolvedApiBaseUrl,
          botKey: result.bot_key,
          webhookSecret: result.webhook_secret,
          websocketUrl: result.websocket_url,
        });
        await writeConfigFile(nextCfg);

        console.log(`✓ Bot "${result.name}" registered`);
        console.log(`✓ Config saved to channels.sabha.accounts.default`);
        console.log(`  baseUrl:    ${resolvedBaseUrl}`);
        console.log(`  apiBaseUrl: ${resolvedApiBaseUrl}`);
        console.log(`  botKey:     ${result.bot_key.replace(/^(\d+-).+$/, "$1***")}`);
        if (result.websocket_url) {
          console.log(
            `  websocketUrl: ${result.websocket_url.replace(/bot_key=[^&]+/, "bot_key=***")}`,
          );
        }
        console.log("\nRestart OpenClaw to activate the Sabha channel.");
      } catch (err) {
        console.error(`Registration failed: ${err}`);
        process.exit(1);
      }
    });

  sabha
    .command("doctor")
    .description("Run runtime health checks against a configured Sabha bot")
    .option(
      "-a, --account <id>",
      "Bot account id to check (default: all enabled bot accounts)",
    )
    .action(async (options: { account?: string }) => {
      const cfg = getConfig();

      // Empty-config short-circuit. `listSabhaAccountIds` (used by
      // `listEnabledSabhaAccounts` below) returns the SDK's implicit
      // ["default"] fallback even on a wholly-unconfigured install,
      // and `enabled` defaults to true, so without this guard the
      // doctor runs against an empty default and surfaces a misleading
      // config-check failure instead of the actionable "nothing is
      // configured" message. We use `listConfiguredSabhaAccountIds`,
      // which only counts explicit `accounts.<id>` entries.
      //
      // The migration shim in `registerFull` promotes base-level creds
      // into `accounts.default` at gateway startup, but the CLI is
      // registered via `registerCliMetadata` and never runs that shim.
      // So a pre-migration config (`channels.sabha.botKey` at base
      // level, no `accounts` map) would hit this guard with
      // `listConfiguredSabhaAccountIds` returning [] even though the
      // resolver's base→default layering yields a working bot. The
      // `&& !resolveSabhaAccount({cfg}).botKey` clause covers that
      // case — same pattern as the startup warning in `index.ts`.
      if (
        !options.account &&
        listConfiguredSabhaAccountIds(cfg).length === 0 &&
        !resolveSabhaAccount({ cfg }).botKey
      ) {
        console.log("No Sabha bot accounts configured.");
        return;
      }

      // Explicit `--account <id>` stays permissive: operators can probe
      // a disabled account on demand. The default fan-out only iterates
      // *enabled* accounts so a config with `enabled: false` entries
      // doesn't surface expected failures as health-check noise.
      const targetIds = options.account
        ? [options.account]
        : listEnabledSabhaAccounts(cfg).map((a) => a.accountId);

      if (!options.account) {
        if (targetIds.length === 0) {
          console.log("No enabled Sabha bot accounts configured.");
          return;
        }
        // Report the default id once so operators can see which config
        // the CLI resolved in the absence of `--account`.
        const defaultId = resolveDefaultSabhaAccountId(cfg);
        console.log(`(default bot account: ${defaultId})\n`);
      }

      let anyFailed = false;
      for (const id of targetIds) {
        const account = resolveSabhaAccount({ cfg, accountId: id });
        const report = await runDoctor({ account });
        console.log(formatDoctorReport(report));
        console.log("");
        if (!report.allPassed) anyFailed = true;
      }
      if (anyFailed) process.exit(1);
    });
}
