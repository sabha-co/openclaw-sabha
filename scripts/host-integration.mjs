// The packed plugin runs in the real host registry against fake Sabha transports.
// The only agent substitution is the model/reply producer; admission, session
// recording, hooks, delivery settlement, registration, and transports are real.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, readdirSync, copyFileSync, existsSync } from "node:fs";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocketServer } from "ws";

const mode = process.argv[2];
const state = process.env.OPENCLAW_STATE_DIR;
assert(state && state.includes("sabha-pack."), "only run in verify-pack's disposable state");
const pluginPath = `${state}/extensions/sabha`;
const requests = [];
const server = createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  requests.push({ method: req.method, url: req.url, body, auth: req.headers.authorization });
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ id: 12, room_id: 99 }));
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
const wss = new WebSocketServer({ server });
let socket;
wss.on("connection", (ws) => {
  socket = ws;
  ws.send(JSON.stringify({ type: "welcome" }));
  ws.on("message", (raw) => {
    const frame = JSON.parse(String(raw));
    if (frame.command === "subscribe") ws.send(JSON.stringify({ type: "confirm_subscription", identifier: frame.identifier }));
  });
});
const cfg = JSON.parse(readFileSync(process.env.OPENCLAW_CONFIG_PATH, "utf8"));
cfg.channels = { sabha: { accounts: { primary: {
  baseUrl: `http://127.0.0.1:${port}`, apiBaseUrl: `http://127.0.0.1:${port}/api/bots`, botKey: "42-testkey",
  typingEnabled: false, replyToMode: "first",
} } } };
cfg.session = { dmScope: "per-account-channel-peer", store: `${state}/sessions/{agentId}.json` };
writeFileSync(process.env.OPENCLAW_CONFIG_PATH, JSON.stringify(cfg));
// Capture the genuine external-plugin runtime, without changing the installed
// implementation. Optional hooks are test instrumentation on this local copy.
if (!existsSync(`${pluginPath}/dist/original-entry.js`)) copyFileSync(`${pluginPath}/dist/index.js`, `${pluginPath}/dist/original-entry.js`);
writeFileSync(`${pluginPath}/dist/index.js`, `import entry from './original-entry.js';
export default {...entry, register(api) {
  globalThis.sabhaTestRuntime = api.runtime;
  entry.register(api);
  api.on('message_sent', event => { globalThis.sabhaTestObserved.push(event); });
  ${mode === "stream" ? "" : `api.on('message_sending', () => { globalThis.sabhaTestHookCalls++; return ${mode === "rewrite" ? "{content:'Safe replacement'}" : "{cancel:true}"}; });`}
}};`);
globalThis.sabhaTestObserved = [];
globalThis.sabhaTestHookCalls = 0;
// Private host loader is confined to this version-pinned integration harness.
// Production code imports public SDK subpaths exclusively.
const hostDist = resolve("node_modules/openclaw/dist");
const loaderPath = readdirSync(hostDist).find((name) => /^loader-.*\.js$/.test(name) && readFileSync(`${hostDist}/${name}`, "utf8").includes("function loadOpenClawPlugins("));
assert(loaderPath, "pinned host loader not found");
const loader = await import(pathToFileURL(`${hostDist}/${loaderPath}`));
const load = Object.values(loader).find((value) => typeof value === "function" && value.name === "loadOpenClawPlugins");
let dispatched = 0;
let context;
const registry = await load({
  config: cfg, onlyPluginIds: ["sabha"], cache: false, activate: true, throwOnLoadError: true, preferBuiltPluginArtifacts: true,
  runtimeOptions: { dispatchReplyFromConfig: async ({ ctx, dispatcher, replyOptions }) => {
    context = ctx; dispatched++;
    await replyOptions?.onPartialReply?.({ text: "Preview before final" });
    // Allow a real preview POST to begin; finalization must reuse it.
    await delay(20);
    dispatcher.sendFinalReply({ text: "Host final reply" });
    return { queuedFinal: true, counts: { tool: 0, block: 0, final: 1 } };
  } },
});
assert.equal(registry.plugins.find((p) => p.id === "sabha").origin, "global");
assert.equal(registry.tools.length, 2);
const channel = registry.channels.find((c) => c.plugin.id === "sabha").plugin;
const account = channel.config.resolveAccount(cfg, "primary");
const abort = new AbortController();
let status = {};
const monitor = channel.gateway.startAccount({
  account, accountId: "primary", cfg, abortSignal: abort.signal,
  channelRuntime: globalThis.sabhaTestRuntime.channel,
  log: { info() {}, error: console.error },
  getStatus: () => status, setStatus: (next) => { status = next; },
});
async function until(check, label) {
  const deadline = Date.now() + 10_000;
  while (!check()) { if (Date.now() > deadline) throw new Error(`Timed out: ${label}`); await delay(20); }
}
try {
  await until(() => status.lifecycle === "ready", "subscription readiness");
  const payload = { event: "message_created", user: { id: 1, name: "Alice", role: "member", url: "http://example/users/1" },
    room: { id: 5, name: "Test", type: "Open", members: 2, has_bot: true, messages_url: "" },
    message: { id: 10, body: { plain: "Hello @{42}", html: "Hello" }, has_attachment: false, attachment: null, mentionees: [{ id: 42, name: "Bot" }], url: "", created_at: new Date().toISOString(), updated_at: new Date().toISOString(), thread: null } };
  socket.send(JSON.stringify({ identifier: JSON.stringify({ channel: "BotEventsChannel" }), message: payload }));
  await until(() => dispatched === 1, "inbound dispatch");
  await until(() => mode === "cancel" ? globalThis.sabhaTestHookCalls === 1 : globalThis.sabhaTestObserved.length === 1, "settled delivery");
  await delay(60);
  assert.equal(context.To, "5"); assert.equal(context.AccountId, "primary"); assert.equal(context.SenderId, "1");
  assert.match(context.Body, /@\{1\}/);
  assert.match(context.SessionKey, /sabha/);
  if (mode === "cancel") {
    assert.equal(requests.length, 0, "cancellation must leave no preview or final");
    assert.equal(globalThis.sabhaTestObserved.length, 0);
  }
  else {
    const sends = requests.filter((r) => r.method === "POST");
    assert.equal(sends.length, 1, "one native send per turn");
    assert.match(sends[0].url, /parent_message_id=10/);
    assert.equal(sends[0].auth, "Bearer 42-testkey");
    assert.equal(globalThis.sabhaTestObserved.length, 1);
    if (mode === "rewrite") {
      assert.equal(globalThis.sabhaTestHookCalls, 1);
      assert.match(sends[0].body, /Safe replacement/);
      assert.ok(requests.every((r) => !r.body.includes("Preview before final") && !r.body.includes("Host final reply")));
    } else assert.ok(requests.some((r) => r.method === "PATCH" && r.body.includes("Host final reply")));
  }
  // Replayed event is deduplicated after the real dispatch settles.
  socket.send(JSON.stringify({ identifier: JSON.stringify({ channel: "BotEventsChannel" }), message: payload }));
  await delay(80); assert.equal(dispatched, 1);
  await until(() => globalThis.sabhaTestRuntime.agent.session.getSessionEntry({ sessionKey: context.SessionKey, storePath: `${state}/sessions/main.json` }), "host session recording");
  assert.match(context.SessionKey, /primary/);
  if (mode === "stream") {
    const actionPath = readdirSync(hostDist).find((name) => /^message-action-runner-.*\.js$/.test(name) && readFileSync(`${hostDist}/${name}`, "utf8").includes("export { getToolResult, runMessageAction }"));
    const { runMessageAction } = await import(pathToFileURL(`${hostDist}/${actionPath}`));
    await runMessageAction({ cfg, action: "react", agentId: "main", sessionKey: context.SessionKey, requesterAccountId: context.AccountId,
      params: { channel: "sabha", accountId: "primary", messageId: "12", emoji: "👍" },
      toolContext: { currentChannelProvider: "sabha", currentChannelId: "5", currentMessageId: "10" },
    });
    assert.ok(requests.some((request) => request.url.includes("/messages/12/boosts")), "real message runner target autofill reached Sabha react");
    socket.send(JSON.stringify({ type: "disconnect", reconnect: false, reason: "test revoked bot" }));
    await until(() => status.lifecycle === "blocked", "fatal account parking");
  }
  console.log(`PASS packed host integration: ${mode}`);
} finally {
  abort.abort(); await monitor;
  for (const ws of wss.clients) ws.terminate();
  await new Promise((resolve) => wss.close(resolve));
  await new Promise((resolve) => server.close(resolve));
}
assert.equal(status.lifecycle, "stopped", "aborted monitor must leave a stopped lifecycle");
