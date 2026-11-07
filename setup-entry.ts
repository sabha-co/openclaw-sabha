import { defineSetupPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { sabhaSetupPlugin } from "./src/plugin/channel.setup.js";

export default defineSetupPluginEntry(sabhaSetupPlugin);
