import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { sabhaConfigSchema } from "./config-schema.js";
import { sabhaSetupContract } from "./setup-contract.js";
import { SABHA_TOOL_NAMES, SABHA_TOOL_METADATA, SABHA_CLI_DESCRIPTORS } from "./metadata.js";

it("ships the same schema, setup fields, tools and CLI metadata as runtime", () => {
  const manifest = JSON.parse(readFileSync("openclaw.plugin.json", "utf8"));
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  expect(manifest.channelConfigs.sabha.schema).toEqual(JSON.parse(JSON.stringify(sabhaConfigSchema.schema)));
  expect(manifest.channelConfigs.sabha.uiHints).toEqual(sabhaConfigSchema.uiHints);
  expect(manifest.contracts.tools).toEqual(SABHA_TOOL_NAMES);
  expect(manifest.toolMetadata).toEqual(SABHA_TOOL_METADATA);
  expect(manifest.cliCommands).toEqual(SABHA_CLI_DESCRIPTORS);
  expect(pkg.openclaw.channel.setup).toEqual(sabhaSetupContract.metadata);
  expect(pkg.devDependencies.openclaw).toBe("2026.9.2");
});
