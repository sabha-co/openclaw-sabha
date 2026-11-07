import { createPluginRuntimeStore, type PluginRuntime } from "openclaw/plugin-sdk/runtime-store";

// The full plugin runtime (ingress queue, inbound kernel, media store) is
// injected once at register time; transport modules read it from here.
const store = createPluginRuntimeStore<PluginRuntime>({
  pluginId: "sabha",
  errorMessage: "Sabha runtime not initialized",
});

export const setSabhaRuntime = store.setRuntime;
export const getSabhaRuntime = store.getRuntime;
