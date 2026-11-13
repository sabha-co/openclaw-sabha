// The packed plugin runs in the real host registry against a fake Sabha
// (REST + AppEventsChannel cable). The only agent substitution is the reply
// producer; admission, ingress, session recording, hooks, delivery and
// registration are the host's own.
//
//   stream   live draft frames, final replaces the draft, react via the real
//            message-action runner, fatal disconnect parks the account
//   rewrite  a message_sending hook rewrites the final (livePreview off)
//   cancel   a message_sending hook cancels the final (livePreview off)
import assert from "node:assert/strict";
import { copyFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { WebSocketServer } from "openclaw/plugin-sdk/websocket-runtime";

const mode = process.argv[2];
assert(["stream", "rewrite", "cancel"].includes(mode), "usage: host-integration.mjs stream|rewrite|cancel");
const state = process.env.OPENCLAW_STATE_DIR;
assert(state && state.includes("sabha-pack."), "only run in verify-pack's disposable state");

const APP_KEY = "sabha_app_0123456789abcdef0123456789abcdef";
const APP_ID = 508;
const IDENTIFIER = JSON.stringify({ channel: "AppEventsChannel" });
const pluginPath = `${state}/extensions/sabha`;
// Modes share one state dir, and durable ingress remembers handled ids across runs.
const INBOUND_ID = { stream: 10, rewrite: 11, cancel: 12 }[mode];

// --- Fake Sabha ---
const requests = [];
let nextMessageId = 900;
const server = createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  requests.push({ method: req.method, url: req.url, body, auth: req.headers.authorization });
  const reply = (status, json) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(json));
  };
  const path = req.url.split("?")[0];
  // A response_url's token is its own credential.
  if (req.method === "POST" && path === "/api/v1/interaction_responses") return reply(200, { ok: true });
  if (req.headers.authorization !== `Bearer ${APP_KEY}`) return reply(401, { error: "unauthorized" });
  if (req.method === "PUT" && path === "/api/v1/profile/commands") return reply(200, { commands: [] });
  if (req.method === "GET" && /^\/api\/v1\/rooms\/\d+$/.test(path)) return reply(200, { id: 77, name: null, type: "Thread" });
  if (req.method === "GET" && path === "/api/v1/me") return reply(200, { id: APP_ID, name: "Claw" });
  if (req.method === "POST" && /^\/api\/v1\/rooms\/\d+\/messages$/.test(path)) return reply(201, { id: nextMessageId++, room_id: 99 });
  if (req.method === "POST" && /^\/api\/v1\/messages\/\d+\/reactions$/.test(path)) return reply(201, { id: 31 });
  reply(404, { error: "not found" });
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const port = server.address().port;

const frames = [];
let socket;
const wss = new WebSocketServer({ server, path: "/cable" });
wss.on("connection", (ws, req) => {
  assert.equal(req.headers.authorization, `Bearer ${APP_KEY}`);
  socket = ws;
  ws.send(JSON.stringify({ type: "welcome" }));
  ws.on("message", (raw) => {
    const frame = JSON.parse(String(raw));
    if (frame.command === "subscribe") ws.send(JSON.stringify({ type: "confirm_subscription", identifier: frame.identifier }));
    if (frame.command === "history") ws.send(JSON.stringify({ type: "confirm_history", identifier: frame.identifier }));
    if (frame.command === "message") frames.push(JSON.parse(frame.data));
  });
});
const pushEvent = (message, offset) =>
  socket.send(JSON.stringify({ identifier: IDENTIFIER, message, stream_id: "app:508", epoch: "e1", offset }));

// --- Host config ---
const cfg = JSON.parse(readFileSync(process.env.OPENCLAW_CONFIG_PATH, "utf8"));
cfg.channels = {
  sabha: {
    accounts: {
      primary: {
        url: `http://127.0.0.1:${port}`,
        appKey: APP_KEY,
        cableUrl: `ws://127.0.0.1:${port}/cable`,
        replyToMode: "first",
        livePreview: mode === "stream",
      },
    },
  },
};
cfg.session = { dmScope: "per-account-channel-peer", store: `${state}/sessions/{agentId}.json` };
writeFileSync(process.env.OPENCLAW_CONFIG_PATH, JSON.stringify(cfg));

// Capture the real external-plugin runtime without changing the installed
// implementation. The hooks are test instrumentation on this local copy.
if (!existsSync(`${pluginPath}/dist/original-entry.js`)) copyFileSync(`${pluginPath}/dist/index.js`, `${pluginPath}/dist/original-entry.js`);
writeFileSync(
  `${pluginPath}/dist/index.js`,
  `import entry from './original-entry.js';
export default {...entry, register(api) {
  globalThis.sabhaTestRuntime = api.runtime;
  // inbound.run takes its reply producer from the resolved turn, so the test
  // producer is attached there; everything around it stays the host's.
  const inbound = api.runtime.channel.inbound;
  const run = inbound.run;
  inbound.run = (params) => run({ ...params, adapter: { ...params.adapter,
    resolveTurn: async (...args) => ({ ...(await params.adapter.resolveTurn(...args)), dispatchReplyFromConfig: globalThis.sabhaTestDispatch }),
  } });
  entry.register(api);
  api.on('message_sent', (event) => { globalThis.sabhaTestObserved.push(event); });
  ${mode === "stream" ? "" : `api.on('message_sending', () => { globalThis.sabhaTestHookCalls++; return ${mode === "rewrite" ? "{ content: 'Safe replacement' }" : "{ cancel: true }"}; });`}
}};`,
);
globalThis.sabhaTestObserved = [];
globalThis.sabhaTestHookCalls = 0;

// --- Host loader (private; confined to this version-pinned harness) ---
const hostDist = resolve("node_modules/openclaw/dist");
const findHostModule = (pattern, marker) =>
  readdirSync(hostDist).find((name) => pattern.test(name) && readFileSync(`${hostDist}/${name}`, "utf8").includes(marker));
const loaderPath = findHostModule(/^loader-.*\.m?js$/, "function loadOpenClawPlugins(");
assert(loaderPath, "pinned host loader not found");
const loader = await import(pathToFileURL(`${hostDist}/${loaderPath}`));
const load = Object.values(loader).find((value) => typeof value === "function" && value.name === "loadOpenClawPlugins");
assert(load, "loadOpenClawPlugins export not found");

let dispatched = 0;
let context;
globalThis.sabhaTestDispatch = async ({ ctx, dispatcher, replyOptions }) => {
  context = ctx;
  dispatched++;
  await replyOptions?.onPartialReply?.({ text: "Preview before final" });
  await delay(300); // let the throttled draft frame go out
  dispatcher.sendFinalReply({ text: "Host final reply" });
  return { queuedFinal: true, counts: { tool: 0, block: 0, final: 1 } };
};
const registry = await load({
  config: cfg,
  onlyPluginIds: ["sabha"],
  cache: false,
  activate: true,
  throwOnLoadError: true,
  preferBuiltPluginArtifacts: true,
});
assert.equal(registry.plugins.find((plugin) => plugin.id === "sabha")?.origin, "global");
assert.deepEqual(registry.tools.flatMap((tool) => tool.names ?? [tool.name]).sort(), ["sabha_create_dm", "sabha_search_members"]);
const channel = registry.channels.find((entry) => entry.plugin.id === "sabha").plugin;
assert.equal(channel.gateway.apiVersion, 2);
const account = channel.config.resolveAccount(cfg, "primary");

// --- Gateway v2 account lifecycle ---
const abort = new AbortController();
let status = {};
const timers = new Set();
const scheduler = {
  signal: abort.signal,
  schedule: ({ delayMs, run }) => {
    const timer = setTimeout(() => (timers.delete(timer), run()), delayMs);
    timers.add(timer);
    return { cancel: () => (clearTimeout(timer), timers.delete(timer)) };
  },
};
const monitor = channel.gateway.startAccount({
  account,
  accountId: "primary",
  cfg,
  abortSignal: abort.signal,
  scheduler,
  log: { info() {}, warn() {}, error: console.error },
  getStatus: () => status,
  setStatus: (next) => {
    status = { ...status, ...next };
  },
});

async function until(check, label, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
    await delay(20);
  }
}

const now = new Date().toISOString();
const event = {
  event: "message_created",
  mentions_app: true,
  user: { id: 1, name: "Alice" },
  room: { id: 5, name: "general", type: "Open" },
  message: {
    id: INBOUND_ID,
    body: { html: "<p>Hello @Claw</p>", plain: "Hello @Claw", markdown: "Hello @{508}" },
    attachment: null,
    thread: null,
    mentionees: [{ id: APP_ID, name: "Claw" }],
    created_at: now,
    updated_at: now,
  },
};
const messagePosts = () => requests.filter((request) => request.method === "POST" && /\/rooms\/\d+\/messages/.test(request.url));
const draftText = () => frames.filter((frame) => frame.action === "draft" && frame.kind === "text");

try {
  await until(() => status.lifecycle === "ready" && socket, "subscription readiness");
  pushEvent(event, 1);
  await until(() => dispatched === 1, "inbound dispatch");
  await until(
    () => (mode === "cancel" ? globalThis.sabhaTestHookCalls === 1 : globalThis.sabhaTestObserved.length === 1),
    "settled delivery",
  );
  await delay(100);

  assert.equal(context.AccountId, "primary");
  assert.equal(context.SenderId, "1");
  assert.match(context.SessionKey, /sabha/);
  assert.match(context.SessionKey, /primary/);

  if (mode === "cancel") {
    assert.equal(messagePosts().length, 0, "a cancelled final sends nothing");
    assert.equal(draftText().length, 0, "no preview text with livePreview off");
    assert.equal(globalThis.sabhaTestObserved.length, 0);
  } else {
    const posts = messagePosts();
    assert.equal(posts.length, 1, "one native send per turn");
    assert.equal(posts[0].url, `/api/v1/rooms/5/messages?parent_message_id=${INBOUND_ID}`, "first reply threads under the inbound message");
    assert.equal(posts[0].auth, `Bearer ${APP_KEY}`);
    const body = JSON.parse(posts[0].body);
    if (mode === "rewrite") {
      assert.equal(globalThis.sabhaTestHookCalls, 1);
      assert.match(body.body, /Safe replacement/);
      assert.equal(draftText().length, 0, "pre-hook text never reaches Sabha");
      assert.ok(requests.every((request) => !request.body.includes("Preview before final") && !request.body.includes("Host final reply")));
    } else {
      assert.match(body.body, /Host final reply/);
      const [start] = frames.filter((frame) => frame.kind === "start");
      assert.ok(start, "a live draft started");
      assert.equal(start.room_id, 5);
      assert.equal(start.parent_message_id, INBOUND_ID);
      assert.ok(draftText().some((frame) => frame.text.includes("Preview before final")), "the partial streamed into the draft");
      assert.equal(body.client_message_id, start.draft_id, "the final replaces the draft in place");
    }
  }

  // A replayed event (same id, e.g. after resume) is deduplicated by durable ingress.
  pushEvent(event, 2);
  await delay(200);
  assert.equal(dispatched, 1, "replayed event is not dispatched twice");

  await until(
    () => globalThis.sabhaTestRuntime.agent.session.getSessionEntry({ sessionKey: context.SessionKey, storePath: `${state}/sessions/main.json` }),
    "host session recording",
  );

  if (mode === "stream") {
    const actionPath = findHostModule(/^message-action-runner-.*\.m?js$/, "runMessageAction");
    const runner = await import(pathToFileURL(`${hostDist}/${actionPath}`));
    const runMessageAction = Object.values(runner).find((value) => typeof value === "function" && value.name === "runMessageAction");
    assert(runMessageAction, "runMessageAction export not found");
    await runMessageAction({
      cfg,
      action: "react",
      agentId: "main",
      sessionKey: context.SessionKey,
      requesterAccountId: context.AccountId,
      params: { channel: "sabha", accountId: "primary", emoji: "👍" },
      toolContext: { currentChannelProvider: "sabha", currentChannelId: "channel:5", currentMessageId: "10" },
    });
    assert.ok(
      requests.some((request) => request.method === "POST" && request.url === "/api/v1/messages/10/reactions" && request.body === "👍"),
      "the real message runner reached Sabha react with the current message",
    );

    const [declared] = requests.filter((request) => request.method === "PUT" && request.url === "/api/v1/profile/commands");
    const names = JSON.parse(declared.body).commands.map((command) => command.name);
    assert.ok(names.includes("new") && !names.includes("help") && names.length <= 25, "the host's native commands are declared, less Sabha's own");

    const roomPosts = messagePosts().length;
    pushEvent({
      event: "command", id: "cmd-1", command: "/new", text: "", user_id: 1, user_name: "Alice", room_id: 77, room_name: null,
      thread: { id: 77, parent_message_id: INBOUND_ID, parent_room_id: 5 }, response_url: `http://127.0.0.1:${port}/api/v1/interaction_responses?token=t`,
    }, 3);
    await until(() => dispatched === 2, "command dispatch");
    await until(() => requests.some((request) => request.url.startsWith("/api/v1/interaction_responses")), "command answer");
    assert.equal(context.CommandSource, "native");
    assert.equal(context.CommandBody, "/new");
    const answer = requests.find((request) => request.url.startsWith("/api/v1/interaction_responses"));
    assert.equal(answer.auth, undefined, "a command answer carries no bearer key");
    assert.match(JSON.parse(answer.body).body, /Host final reply/);
    assert.equal(messagePosts().length, roomPosts, "a command's answer is never posted to the room");

    socket.send(JSON.stringify({ type: "disconnect", reconnect: false, reason: "unauthorized" }));
    await until(() => status.lifecycle === "blocked", "fatal account parking");
  }
  console.log(`PASS packed host integration: ${mode}`);
} finally {
  abort.abort();
  await monitor;
  for (const timer of timers) clearTimeout(timer);
  for (const client of wss.clients) client.terminate();
  await new Promise((done) => wss.close(done));
  await new Promise((done) => server.close(done));
}
assert.equal(status.lifecycle, "stopped", "an aborted monitor leaves a stopped lifecycle");
