// Static plugin metadata, shared by the entries and the manifest generator.

export const SABHA_CHANNEL_ID = "sabha";

export const sabhaMeta = {
  id: SABHA_CHANNEL_ID,
  label: "Sabha",
  selectionLabel: "Sabha (app)",
  detailLabel: "Sabha app",
  docsPath: "/channels/sabha",
  docsLabel: "sabha",
  systemImage: "bubble.left.and.bubble.right",
  blurb: "Connect OpenClaw to a Sabha workspace as an app.",
} as const;

export const SABHA_TOOL_NAMES = ["sabha_search_members", "sabha_create_dm"] as const;
export type SabhaToolName = (typeof SABHA_TOOL_NAMES)[number];

export const SABHA_TOOL_METADATA = {
  sabha_search_members: { replaySafe: true },
  sabha_create_dm: { sideEffecting: true },
} satisfies Record<SabhaToolName, Record<string, boolean>>;

export const SABHA_CLI_DESCRIPTORS = [{ name: "sabha", description: "Sabha channel commands", hasSubcommands: true }];
