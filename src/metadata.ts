export const SABHA_TOOL_NAMES = ["sabha_search_members", "sabha_create_dm"] as const;
export const SABHA_CLI_DESCRIPTORS = [{ name: "sabha", description: "Sabha channel commands", hasSubcommands: true }];
export const SABHA_TOOL_METADATA = {
  sabha_search_members: { replaySafe: true },
  sabha_create_dm: { sideEffecting: true },
};
