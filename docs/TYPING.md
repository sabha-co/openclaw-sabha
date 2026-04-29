# Typing Indicators

The plugin shows "Bot is typing..." in Sabha while the LLM is generating a reply. Same UX as when a human user is typing.

## Why

Inbound messages arrive via WebSocket, the LLM takes anywhere from a few seconds to 30+ seconds to respond, and the reply posts via REST. Without a visible indicator, users don't know if the bot is working or ignoring them. Typing indicators close that gap.

## How Sabha handles typing

Sabha has a `TypingNotificationsChannel` (Rails ActionCable channel, `app/channels/typing_notifications_channel.rb`) that broadcasts `{action, user}` frames to all subscribers of a room. The browser frontend uses `@anycable/web` to call `channel.whisper({action, user})` when the user is typing, and renders "X is typing…" when it receives whispers from others.

`whisper` is an AnyCable extension to the ActionCable protocol. Unlike the regular `message` command (which invokes a method on the channel via Rails RPC), whispers are routed **directly by AnyCable-Go** to other subscribers — no Rails round-trip. Sabha's channel declares `stream_for @room, whisper: true` when AnyCable is enabled (`typing_notifications_channel.rb:8`), which opts the stream into whisper routing.

The plugin uses the same mechanism via the existing WebSocket connection — no HTTP calls, no server changes.

## Protocol

All frames below flow on the same WebSocket the plugin already uses for `BotEventsChannel`.

### Subscribe (once per room)

```json
{
  "command": "subscribe",
  "identifier": "{\"channel\":\"TypingNotificationsChannel\",\"room_id\":5}"
}
```

The server responds with `confirm_subscription` (or `reject_subscription` if the bot isn't a member of that room).

### Whisper start / stop

```json
{
  "command": "whisper",
  "identifier": "{\"channel\":\"TypingNotificationsChannel\",\"room_id\":5}",
  "data": {
    "action": "start",
    "user": { "id": 42, "name": "OpenClaw" }
  }
}
```

Important: whispers sent before `confirm_subscription` arrives are **silently dropped** by AnyCable. The first whisper per room must be queued until the subscription is confirmed.

Sabha's browser indicator fades after ~6s without a refresh, so the plugin re-sends `start` every 4s while the LLM is still generating.

## Components

### `src/typing.ts`

The `TypingManager` class tracks per-room state:

```ts
type RoomState = {
  subscription: "pending" | "ready";
  refreshTimer?: ReturnType<typeof setInterval>;
  pendingStart?: boolean;
};
```

Key methods:

- **`start(roomId)`** — If the room is new, sends a `subscribe` command and marks state `"pending"` with `pendingStart: true`. If the state is already `"ready"`, sends the `start` whisper immediately. Either way, resets a 4s refresh timer.
- **`stop(roomId)`** — Cancels the refresh timer. Sends a `stop` whisper only if state is `"ready"` (sending before confirm is pointless — AnyCable drops it).
- **`onSubscriptionConfirmed(identifier)`** — Called by the WebSocket layer when AnyCable confirms a typing subscription. Marks state `"ready"` and flushes any pending start whisper.
- **`onSubscriptionRejected(identifier)`** — Called when Sabha rejects a subscribe (e.g. room not found, bot not a member). Cancels the timer and forgets the room.
- **`reset()`** — Called on WebSocket reconnect. Wipes all local state because the server forgot all subscriptions. Does **not** send stop whispers — the old connection is gone and Sabha already cleaned up.
- **`size()`** — Diagnostic count of tracked rooms.

### `src/monitor-websocket.ts`

Three additions support the TypingManager:

**`ConnectionRef`** — a mutable reference object:

```ts
type ConnectionRef = { sendFrame: ((frame: string) => void) | null };
```

On `ws.open` the ref's `sendFrame` is set to a closure over the current ws. On `ws.close` it's cleared. The TypingManager reads this ref when it wants to send a frame, so it never holds a stale ws reference across reconnects.

**Three new callbacks:**

- `onBotEventsSubscribed()` — Fires once per connection when `BotEventsChannel` confirms. Used to call `TypingManager.reset()`.
- `onAuxSubscriptionConfirmed(identifier)` — Fires for `confirm_subscription` frames on any other channel. Routed to `TypingManager.onSubscriptionConfirmed()`.
- `onAuxSubscriptionRejected(identifier)` — Fires for `reject_subscription` frames on any other channel. Routed to `TypingManager.onSubscriptionRejected()`.

**Fixed data-frame routing** — the `{identifier, message}` branch now forwards to `onMessage` **only** if the identifier equals `BOT_EVENTS_IDENTIFIER`. Once the plugin subscribes to `TypingNotificationsChannel`, AnyCable delivers **other users' typing whispers** on the same WebSocket. Without this gate, those frames would hit `parseWebhookPayload` and spam parse errors.

### `src/monitor.ts`

```ts
const connectionRef = createConnectionRef();
const typing = account.typingEnabled
  ? new TypingManager({ connectionRef, botId, botName, logger })
  : null;

const connectOnce = createSabhaConnectOnce({
  ...,
  connectionRef,
  onBotEventsSubscribed: () => typing?.reset(),
  onAuxSubscriptionConfirmed: (id) => typing?.onSubscriptionConfirmed(id),
  onAuxSubscriptionRejected: (id) => typing?.onSubscriptionRejected(id),
  onMessage: async (raw) => {
    // ... parse, dedup ...
    if (!shouldHandleInbound(payload, account.botId)) return;
    // ... dedup check ...
    typing?.start(payload.room.id);
    try {
      await processInboundMessage(...);
      dedup.mark(dedupKey);
    } finally {
      typing?.stop(payload.room.id);
    }
  },
});

try {
  await runWithReconnect(connectOnce, {...});
} finally {
  typing?.reset();
}
```

Important ordering:

1. **`shouldHandleInbound()` runs before `typing.start()`** — the bot doesn't flicker a typing indicator for messages it will ignore (non-mentions in groups, bot's own echoes).
2. **`try/finally` around `processInboundMessage`** guarantees `typing.stop()` runs even if the LLM errors out.
3. **Outer `try/finally` around `runWithReconnect`** cancels all timers on monitor shutdown (abort signal, fatal error).

### `src/inbound.ts`

`shouldHandleInbound(payload, botId)` is extracted from the top of `processInboundMessage` and exported so `monitor.ts` can pre-check before triggering side effects.

## End-to-end flow

1. **Plugin starts** — `monitorSabha()` creates a `ConnectionRef` and `TypingManager`.
2. **WebSocket connects** — `ws.open` sets `ref.sendFrame`.
3. **Welcome → subscribe → confirm** for `BotEventsChannel`. `onBotEventsSubscribed()` fires → `typing.reset()` wipes any stale state from a previous connection.
4. **User @mentions the bot** in room #general (id 5):
   - BotEventsChannel delivers `{event: "message_created", room: {id: 5, ...}, ...}`
   - Dedup check passes
   - `shouldHandleInbound()` passes (it's a mention)
   - **`typing.start(5)`** — room 5 is new, sends the subscribe command, state becomes `{subscription: "pending", pendingStart: true, refreshTimer: ...}`. The refresh timer is scheduled but no-ops until `"ready"`.
   - Plugin dispatches to the LLM via `processInboundMessage()`
5. **~200ms later** — AnyCable confirms the typing subscription:
   - `confirm_subscription` frame with the typing identifier arrives
   - `onAuxSubscriptionConfirmed` → `TypingManager.onSubscriptionConfirmed()`
   - State becomes `"ready"`, `pendingStart` flushed → first whisper sent
   - Sabha broadcasts to other subscribers of room 5
   - Users in #general see "OpenClaw is typing…"
6. **Every 4s** the refresh timer fires another `start` whisper
7. **LLM finishes**, reply posts via REST → `finally` block runs → **`typing.stop(5)`** cancels the timer and sends a stop whisper. The indicator disappears as the reply arrives.
8. **Next message in the same room** — `start()` finds existing state, skips the subscribe, immediately sends a whisper, resets the timer
9. **WebSocket reconnects**:
   - `ws.close` → `ref.sendFrame = null`. Any in-flight `start()` calls no-op.
   - Reconnect loop establishes a new ws → `ref.sendFrame` reassigned
   - BotEventsChannel re-confirms → `typing.reset()` wipes stale state
   - Next message triggers a fresh subscribe for its room
10. **Monitor shutdown** (abort signal) — outer `finally` calls `typing.reset()` to cancel all lingering timers

## Configuration

Two new fields in `channels.sabha`:

```json5
{
  channels: {
    sabha: {
      typingEnabled: true,  // default
      botName: "OpenClaw"   // shown to users in "Bot is typing" UI
    }
  }
}
```

- **`typingEnabled`** — default `true`. Set to `false` to disable typing indicators entirely (e.g. for noise-sensitive rooms).
- **`botName`** — used in the `user.name` field of the whisper payload. The setup wizard auto-populates this from the registration response (`POST /join/{code}` → `{ name, ... }`). In the manual setup path the wizard prompts for it explicitly.

## Multi-tenancy safety

Sabha can run in SaaS mode where the same server hosts multiple workspaces. Cross-tenant leakage is structurally impossible because:

- **Connection scoping**: `buildWebSocketUrl` extracts the `wid` (workspace ID) from the base URL path and passes it as a query param. Sabha's `ApplicationCable::Connection#connect_bot` authenticates the bot within `current_tenant`.
- **Server-side room filtering**: Sabha's `RoomChannel#find_room` runs `current_user.rooms.find_by(id: params[:room_id])` inside `with_tenant_context`. A bot in workspace A trying to subscribe to a room in workspace B gets a `reject_subscription` response.
- **Stream scoping**: Sabha's `stream_for @room` uses the room's GlobalID, which includes `?tenant=<wid>`. Broadcasts don't cross workspaces.
- **Whisper scoping**: Whispers are broadcast to subscribers of the tenant-scoped stream. The `user: {id, name}` field we send is our bot's tenant-local ID and name — never seen by users in other tenants.
- **Aux-frame filtering**: Other users' typing whispers on `TypingNotificationsChannel` are dropped in `monitor-websocket.ts` before reaching `parseWebhookPayload` or influencing any plugin state.
- **Rejection cleanup**: `onSubscriptionRejected()` cancels timers and forgets rejected rooms, so the plugin never leaks state on a cross-tenant reject.

## Tests

`src/typing.test.ts` — 22 tests covering:

- Subscribe only once per room
- Pending state: no whisper before confirmation
- Flush on confirm
- Refresh timer fires only when `"ready"`
- Refresh timer reset on repeat `start()`
- `stop()` before confirm sends no whisper
- `stop()` without prior `start()` is a no-op
- Per-room isolation (stopping one room doesn't affect another)
- `reset()` cancels all timers without emitting whispers
- Re-subscribe after `reset()`
- `onSubscriptionRejected()` clears state and cancels timer
- `onSubscriptionConfirmed()` ignores identifiers for other channels
- Disconnected state: no timers, no frames
- Malformed identifier tolerance

`src/monitor-websocket.test.ts` — new tests for:

- BotEventsChannel rejection → fatal
- Auxiliary channel rejection → logged, routed to callback, non-fatal
- Data frames from auxiliary channels don't reach `onMessage`
- `onBotEventsSubscribed` fires only for `BotEventsChannel`

`src/inbound.test.ts` — tests for the extracted `shouldHandleInbound()`:

- Bot self-messages → false
- Group messages without mention → false
- Group messages with mention → true
- DMs regardless of mention → true

## Known limitations

- **No whisper fallback**: if Sabha is running without AnyCable whispering enabled (`AnyCable::Rails.enabled?` returns false), our whispers are silently dropped. We don't fall back to the slower `message` command that routes through Rails RPC. This matches Sabha's frontend, which only uses whispers when the `anycable-whisper` meta tag is present.
- **First-whisper latency**: for brand-new rooms the first whisper can't flush until `confirm_subscription` arrives (~200ms typical). Users may not see the indicator if the LLM responds in under ~200ms, but that's a rare case.
- **No explicit keepalive budget**: the refresh timer runs forever while a dispatch is in flight. If the LLM runs for 30+ minutes the plugin keeps whispering. Not a correctness issue, just a design choice.

## Future: presence (online indicator)

Deferred. Notes captured here so we don't re-research next time.

### How Sabha does presence today

Sabha has a custom `PresenceChannel` (`app/channels/presence_channel.rb`) that subclasses `RoomChannel`. It is **not** AnyCable's native presence protocol — it's plain ActionCable with `on_subscribe :present` / `on_unsubscribe :absent` hooks backed by a DB column on `memberships` (`connected_at`, `connections` counter, `CONNECTION_TTL = 60.seconds` — see `app/models/membership/connectable.rb`). The browser refreshes every 50s by sending an ActionCable RPC `{"command":"message", "data":"{\"action\":\"refresh\"}"}` to bump `connected_at`.

### Protocol (for when we implement it)

- **Subscribe**: `{"command":"subscribe","identifier":"{\"channel\":\"PresenceChannel\",\"room_id\":N}"}` — server fires `on_subscribe :present`, writes `connected_at = now`, responds with `confirm_subscription`.
- **Refresh**: `{"command":"message","identifier":"{\"channel\":\"PresenceChannel\",\"room_id\":N}","data":"{\"action\":\"refresh\"}"}` — every ~50s. Note: this is `message` (Rails RPC), not `whisper`, because the action mutates a DB row.
- **Leave**: no explicit frame. `ws.close` → `on_unsubscribe :absent` → `membership.disconnected`.
- **No inbound events**: the channel is write-only from the bot's perspective. Unlike typing whispers, other users' presence is not broadcast back over this stream — the online dot is rendered from DB state on page load / HTML updates.

### Key insight: room-scoped channel, user-scoped UX

`PresenceChannel` requires a `room_id` and is scoped per-room, but what Sabha actually displays is a **per-user** activity tier (`:active` / `:away` / `:offline`) computed from `MAX(connected_at)` across **all** of a user's memberships (`Membership.activity_statuses_for`). Consumers:

- **Web push routing** (`room/message_pusher.rb`) — skip push to users who are "connected" to the room. Bots don't receive push, so irrelevant to us.
- **Unread broadcasts** (`room.rb`) — only broadcast unread to disconnected users. Same: irrelevant to bots.
- **Green/yellow/gray dot** in sidebars and profile cards — computed globally per user.

**Implication**: a bot only needs to subscribe to `PresenceChannel` for **one** room to appear online everywhere in Sabha. No room enumeration required.

### Should we migrate Sabha to AnyCable's native presence?

Considered and rejected. Tradeoffs:

- **Pros**: offloads the 50s refresh RPC from Rails, enables real-time `presence:join`/`presence:leave` broadcasts to other subscribers.
- **Cons**: AnyCable+ (Pro) feature — requires a paid license. Presence state would live in AnyCable-Go memory, lost on restart. `Membership.connected` would stop being a DB scope, breaking every consumer listed above. Significant migration work for no bot-side benefit.

Not worth it unless Sabha moves to AnyCable+ for other reasons.

### Design questions to resolve before implementing

1. **Do we want the bot to show online at all?** The typing indicator already communicates "bot is thinking" — arguably a stronger signal than "bot is reachable." The online dot is a "is this human available" cue; applying it to a headless service may be noise. Leaning toward **skip** unless there's a concrete UX request.
2. **If yes, which room do we subscribe to?** Since one subscription marks the bot online globally, options are:
   - Subscribe to the first room the bot ever receives an inbound from; never unsubscribe until reconnect. Downside: after each restart, bot appears offline until someone pings it.
   - Subscribe to a deterministic "bot home" room on startup (would need server-side convention — probably overkill).
3. **Refresh interval**: match the browser at 50s (TTL is 60s).
4. **Timer architecture**: one global `setInterval` iterating tracked rooms is simpler than per-room timers (same cadence for all).
5. **Pending-start queue**: not needed. Unlike whispers, the `on_subscribe :present` server hook fires synchronously during subscription — the bot is marked present before `confirm_subscription` even reaches us. The first `refresh` RPC just needs to wait for `"ready"` state before firing.
6. **Config**: would add `presenceEnabled` (default?) alongside `typingEnabled`.

### Plugin-side sketch (for future reference)

Would mirror `TypingManager` structurally but simpler: no `pendingStart` queue, no `stop` whisper, one global refresh timer instead of per-room timers. Could reuse the existing `ConnectionRef`, `onAuxSubscriptionConfirmed`, and `onAuxSubscriptionRejected` plumbing in `monitor-websocket.ts` as-is — both managers would attach to the same aux-subscription callbacks and each would filter by `parsed.channel` in the identifier.
