import type { Command } from "commander";
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import { parseJoinUrl, selfRegisterBot } from "./setup-wizard.js";
import {
  listEnabledBotAccounts,
  resolveBotAccount,
  resolveDefaultBotAccountId,
} from "./bot-accounts.js";
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

        const cfg = getConfig();
        const channels = (cfg.channels ?? {}) as Record<string, unknown>;
        const existing = (channels.sabha ?? {}) as Record<string, unknown>;
        const nextCfg = {
          ...cfg,
          channels: {
            ...channels,
            sabha: {
              ...existing,
              enabled: true,
              baseUrl: parsed.baseUrl,
              botKey: result.bot_key,
              websocketUrl: result.websocket_url,
            },
          },
        };
        await writeConfigFile(nextCfg);

        console.log(`✓ Bot "${result.name}" registered`);
        console.log(`✓ Config saved to channels.sabha`);
        console.log(`  baseUrl: ${parsed.baseUrl}`);
        console.log(`  botKey:  ${result.bot_key.replace(/^(\d+-).+$/, "$1***")}`);
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

      // Explicit `--account <id>` stays permissive: operators can probe
      // a disabled account on demand. The default fan-out only iterates
      // *enabled* accounts so a config with `enabled: false` entries
      // doesn't surface expected failures as health-check noise.
      const targetIds = options.account
        ? [options.account]
        : listEnabledBotAccounts(cfg).map((a) => a.accountId);

      if (!options.account) {
        if (targetIds.length === 0) {
          console.log("No enabled Sabha bot accounts configured.");
          return;
        }
        // Report the default id once so operators can see which config
        // the CLI resolved in the absence of `--account`.
        const defaultId = resolveDefaultBotAccountId(cfg);
        console.log(`(default bot account: ${defaultId})\n`);
      }

      let anyFailed = false;
      for (const id of targetIds) {
        const botAccount = resolveBotAccount({ cfg, botAccountId: id });
        const report = await runDoctor({ botAccount });
        console.log(formatDoctorReport(report));
        console.log("");
        if (!report.allPassed) anyFailed = true;
      }
      if (anyFailed) process.exit(1);
    });
}
