// Regenerates openclaw.plugin.json and package.json#openclaw.channel from the
// built sources, so the manifest the host reads before loading code cannot
// drift from the code. `--check` fails instead of writing (CI / prepack).
import { readFileSync, writeFileSync } from "node:fs";
import { sabhaConfigSchema } from "../dist/src/config/schema.js";
import { sabhaSetupContract } from "../dist/src/config/setup-contract.js";
import { SABHA_CLI_DESCRIPTORS, SABHA_TOOL_METADATA, SABHA_TOOL_NAMES, sabhaMeta } from "../dist/src/plugin/meta.js";

const DESCRIPTION = "Connect OpenClaw to a Sabha workspace as an app";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const { id: _id, ...channelMeta } = sabhaMeta;
pkg.openclaw.channel = { id: sabhaMeta.id, ...channelMeta, markdownCapable: true, setup: sabhaSetupContract.metadata };

const manifest = {
  id: sabhaMeta.id,
  channels: [sabhaMeta.id],
  name: sabhaMeta.label,
  description: DESCRIPTION,
  version: pkg.version,
  contracts: { tools: [...SABHA_TOOL_NAMES] },
  toolMetadata: SABHA_TOOL_METADATA,
  cliCommands: SABHA_CLI_DESCRIPTORS,
  configSchema: { type: "object", additionalProperties: false, properties: {} },
  channelConfigs: {
    [sabhaMeta.id]: {
      label: sabhaMeta.label,
      description: "Connect to a Sabha workspace with an app key over the AppEvents WebSocket.",
      schema: sabhaConfigSchema.schema,
      uiHints: sabhaConfigSchema.uiHints,
    },
  },
};

const stale = [];
for (const [path, data] of [["openclaw.plugin.json", manifest], ["package.json", pkg]]) {
  const rendered = `${JSON.stringify(data, null, 2)}\n`;
  if (readFileSync(path, "utf8") === rendered) continue;
  if (process.argv.includes("--check")) stale.push(path);
  else writeFileSync(path, rendered);
}
if (stale.length) {
  console.error(`Stale: ${stale.join(", ")}. Run: npm run manifest:generate`);
  process.exit(1);
}
