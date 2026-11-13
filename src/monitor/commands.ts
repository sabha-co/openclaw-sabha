// The host's native commands as Sabha slash commands, declared when an account
// starts. Sabha shows them when a member types `/` in a room the app is in and
// sends a `command` event instead of posting the text.
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import { resolveNativeCommandsEnabled } from "openclaw/plugin-sdk/native-command-config-runtime";
import { listNativeCommandSpecsForConfig, type NativeCommandSpec } from "openclaw/plugin-sdk/native-command-registry";
import type { SabhaClient } from "../client/client.js";
import type { SabhaCommandDeclaration } from "../client/types.js";

/** Sabha's own commands, which no app may declare. */
const RESERVED = new Set(["help", "play", "me", "invite", "leave", "remind", "topic"]);
const MAX_COMMANDS = 25;
const TEXT_LIMIT = 100;
const NAME = /^[a-z0-9_-]{1,32}$/;
/**
 * The host has more commands than Sabha's 25 slots, in an order that would
 * leave these out. They're the ones a conversation is steered with.
 */
const FIRST = ["new", "reset", "stop", "model", "status", "compact", "think", "usage"];

/** Then the rest in the host's order, aliases last, so an alias never takes a command's slot. */
export function sabhaCommandDeclarations(specs: readonly NativeCommandSpec[]): SabhaCommandDeclaration[] {
  const rank = (spec: NativeCommandSpec) => (FIRST.includes(spec.name) ? FIRST.indexOf(spec.name) : FIRST.length + (spec.isAlias ? 1 : 0));
  const declared: SabhaCommandDeclaration[] = [];
  for (const spec of [...specs].sort((a, b) => rank(a) - rank(b))) {
    const name = spec.name.toLowerCase();
    if (!NAME.test(name) || RESERVED.has(name) || declared.some((d) => d.name === name)) continue;
    const usage = (spec.args ?? []).map((arg) => (arg.required ? `<${arg.name}>` : `[${arg.name}]`)).join(" ");
    declared.push({
      name,
      description: (spec.description.trim() || `/${name}`).slice(0, TEXT_LIMIT),
      ...(usage ? { usage_hint: usage.slice(0, TEXT_LIMIT) } : {}),
    });
    if (declared.length === MAX_COMMANDS) break;
  }
  return declared;
}

/** Another app may already hold a name; the rest are declared, and the taken ones still run as text (`@App /new`). */
export async function declareSabhaCommands(params: {
  client: SabhaClient;
  cfg: OpenClawConfig;
  log: { info?: (message: string) => void; warn?: (message: string) => void };
  prefix: string;
}): Promise<void> {
  const { client, cfg, log, prefix } = params;
  const enabled = resolveNativeCommandsEnabled({ providerId: "sabha", globalSetting: cfg.commands?.native, autoDefault: true });
  const declared = enabled ? sabhaCommandDeclarations(listNativeCommandSpecsForConfig(cfg, { provider: "sabha" })) : [];
  try {
    const refused = await client.declareCommands(declared);
    if (refused.length) {
      log.info?.(`${prefix} ${refused.join(", ")} taken by another app; declaring the rest`);
      await client.declareCommands(declared.filter((command) => !refused.includes(command.name)));
    }
  } catch (error) {
    log.warn?.(`${prefix} couldn't declare slash commands: ${String(error)}`);
  }
}
