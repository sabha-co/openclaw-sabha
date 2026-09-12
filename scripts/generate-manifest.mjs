import { readFileSync, writeFileSync } from "node:fs";
import { sabhaConfigSchema } from "../dist/src/config-schema.js";
import { sabhaSetupContract } from "../dist/src/setup-contract.js";
import { SABHA_TOOL_NAMES, SABHA_TOOL_METADATA, SABHA_CLI_DESCRIPTORS } from "../dist/src/metadata.js";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
pkg.openclaw.channel.setup = sabhaSetupContract.metadata;
const manifest = {
  id: "sabha", channels: ["sabha"], name: "Sabha",
  description: "Connect OpenClaw to a Sabha chat server",
  version: pkg.version,
  contracts: { tools: SABHA_TOOL_NAMES },
  toolMetadata: SABHA_TOOL_METADATA,
  cliCommands: SABHA_CLI_DESCRIPTORS,
  configSchema: { type: "object", additionalProperties: false, properties: {} },
  channelConfigs: { sabha: {
    label: "Sabha", description: "Connect to a Sabha chat server via WebSocket.",
    schema: sabhaConfigSchema.schema, uiHints: sabhaConfigSchema.uiHints,
  } },
};
for (const [path, data] of [["openclaw.plugin.json", manifest], ["package.json", pkg]]) {
  const rendered = JSON.stringify(data, null, 2) + "\n";
  if (process.argv.includes("--check")) {
    if (readFileSync(path, "utf8") !== rendered) throw new Error(`${path} is stale; run npm run manifest:generate`);
  } else writeFileSync(path, rendered);
}
