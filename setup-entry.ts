import { defineSetupPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { sabhaPlugin } from "./src/channel.js";

export default defineSetupPluginEntry(sabhaPlugin);
