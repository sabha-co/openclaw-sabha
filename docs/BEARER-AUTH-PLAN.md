# Bearer Auth + `/api/bots` Namespace (2026.4.25 release)

Implementation plan for the `v0.10.0-bearer-auth` branch (historical name; merged as the `2026.4.25` plugin release). Tracks the plugin-side work that shipped lockstep with the Sabha server's `bot-api-header-auth` branch.

## Goal

Swap `bot_key`-in-URL-path for `Authorization: Bearer` header. Move every HTTP endpoint under `/api/bots/*`. One breaking release; no compat layer.

## Non-goals

- **Webhook HMAC signature verification** — deferred to a future release. Plugin captures and stores `webhook_secret` in the `2026.4.25` release but does not verify inbound webhook signatures yet.
- **Config migration** — user wipes `channels.sabha` from `~/.openclaw/openclaw.json` and re-registers via `openclaw configure`. Plugin treats configs missing `apiBaseUrl` as "not configured" (silent, matches today's `baseUrl`-missing behavior).
- **WebSocket auth change** — `/cable?bot_key=…` query-string auth stays. Out of scope per server plan.
- **`bot_key` rotation handling** — if admin rotates via UI, plugin sees 401s, monitor parks the account per existing disconnect-classification logic. Admin fixes via `openclaw configure`.

## Server contract (verified on `bot-api-header-auth`)

Registration response from `POST /join/:join_code`:

```json
{
  "bot_key": "42-AbCdEfGhIjKl",
  "webhook_secret": "whsec_…",
  "name": "…",
  "webhook_url": null,
  "base_url": "https://chat.example.com",
  "api_base_url": "https://chat.example.com/api/bots",
  "websocket_url": "wss://chat.example.com/cable?bot_key=…",
  "rooms": [{ "id": 1, "name": "General", "type": "Open", "messages_url": "…" }]
}
```

- POST body accepts `{ name, webhook_url?, mentions_url?, everything_url? }`. Plugin sends `{ name }` only.
- `webhook_secret` always generated, regardless of `webhook_url`. Show-once in API response; always visible in admin UI.
- Invite code single-use.
- Auth for every subsequent call: `Authorization: Bearer ${bot_key}`.

## Tasks (execution order)

### 1. Config types + schema

- [ ] `src/types.ts:191` — `SabhaConfig` gains `apiBaseUrl?: string` and `webhookSecret?: string`.
- [ ] `src/bot-accounts.ts:33,146` — `ResolvedBotAccount` gains `apiBaseUrl: string` and `webhookSecret: string`; layering pulls both from merged config.
- [ ] `src/channel.ts:29,55` — Zod schema adds `apiBaseUrl` + `webhookSecret` (both `z.string().optional()`); config-card `fields` gains entries.
- [ ] `src/channel.ts:156,157,244,245,290` — `configured`/`enabled` booleans add `&& account.apiBaseUrl`. Do **not** gate on `webhookSecret` — WebSocket-mode bots don't need it in this release.

### 2. HTTP client — `src/client.ts`

- [ ] Constructor L66: rename `baseUrl` → `apiBaseUrl`. Field only; type + position unchanged.
- [ ] `fetch()` L348: inject `Authorization: Bearer ${this.botKey}` on every request.
- [ ] Class comment L53–58: describe header auth, drop "bot_key in URL path" language.
- [ ] Rewrite 22 path templates — drop `${this.botKey}` segment, reshape per server routes:

  | Method | Line | New suffix (appended to `apiBaseUrl`) |
  | --- | --- | --- |
  | `sendMessage` | 99 | `/rooms/${roomId}/messages` |
  | `sendAttachment` | 116 | `/rooms/${roomId}/messages` |
  | `editMessage` | 144 | `/rooms/${roomId}/messages/${messageId}` |
  | `deleteMessage` | 158 | same |
  | `getMessage` | 164 | same |
  | `getMessages` | 171 | `/rooms/${roomId}/messages` |
  | `replyInThread` | 187 | `/rooms/${roomId}/messages/${messageId}/thread` |
  | `addReaction` | 205 | `/rooms/${roomId}/messages/${messageId}/boosts` |
  | `removeReaction` | 223 | `/rooms/${roomId}/messages/${messageId}/boosts/${boostId}` |
  | `listRooms` | 232 | `/rooms` |
  | `listJoinableRooms` | 237 | `/rooms?joinable=true` |
  | `createRoom` | 245 | `/rooms` |
  | `updateRoom` | 254 | `/rooms/${roomId}` |
  | `archiveRoom` | 263 | `/rooms/${roomId}` |
  | `joinRoom` | 269 | `/rooms/${roomId}/membership` |
  | `leaveRoom` | 277 | `/rooms/${roomId}/membership` |
  | `listMembers` | 285 | `/rooms/${roomId}/members` |
  | `addMember` | 295 | `/rooms/${roomId}/members` |
  | `removeMember` | 307 | `/rooms/${roomId}/members/${userId}` |
  | `createDm` | 316 | `/direct_messages` |
  | `search` | 327 | `/search?q=…` |
  | `updateSettings` | 339 | `/profile` |

### 3. Constructor call sites (6)

Swap `account.baseUrl` → `account.apiBaseUrl`:

- [ ] `src/doctor.ts:168`
- [ ] `src/tools.ts:57`
- [ ] `src/channel.ts:110`
- [ ] `src/monitor.ts:186`
- [ ] `src/setup-wizard.ts:133`
- [ ] `src/setup-wizard.ts:273` — pre-registration probe builds `${baseUrl}/api/bots` as the `apiBaseUrl` (we don't have the server-returned value yet at this point).

### 4. Setup wizard + CLI

- [ ] `src/setup-wizard.ts` — `SelfRegisterResult`/`RegistrationResponse` type gains `api_base_url`, `base_url`, `webhook_secret`.
- [ ] `selfRegisterBot` L66 — parse all four fields (`bot_key` + new three), return.
- [ ] Interactive flow L687 — persist `apiBaseUrl`, `baseUrl` (**server-provided**, not user-entered), `webhookSecret`, `botKey` into config card.
- [ ] POST body to `/join/:join_code` — send `{ name: view.botName }`. No `webhook_url`.
- [ ] `src/cli.ts:42–67` — mirror.

### 5. Channel, monitor, doctor

- [ ] `src/channel.ts:200` — keep `account.baseUrl` in agent-identity prompt (server root, not API URL).
- [ ] `src/channel.ts:229` — keep `account.baseUrl` for `/skill` cache key.
- [ ] `src/monitor.ts:153` — `buildWebSocketUrl` untouched.
- [ ] `src/monitor.ts:592` — update error hint to mention `apiBaseUrl`.
- [ ] `src/doctor.ts:21,130,152,187,216` — check/display `apiBaseUrl`; skill probe stays on `baseUrl`.

### 6. Tests

- [ ] `rg 'rooms/\$?\{?.+?\}?/\$?\{?this\.botKey' src --glob '*.test.ts'` — locate all mocks with old URL shape, rewrite.
- [ ] Update `new SabhaClient(…)` positional-arg semantics in tests.
- [ ] Update setup-wizard registration-response fixtures to include `api_base_url`, `base_url`, `webhook_secret`.
- [ ] Add one `src/client.test.ts` case asserting `Authorization: Bearer ${botKey}` on every method.

### 7. Docs

- [ ] `CLAUDE.md` — rewrite "Outbound paths" paragraph on `SabhaClient` auth (header, not URL path); remove "Do not add header auth"; update "Design decisions" wire-fact bullet; soften `formatStreamError` note (primary leak vector closed, redactor stays as defense-in-depth).
- [ ] `README.md` — example config includes `apiBaseUrl` + `webhookSecret`; note that the `2026.4.25` release requires Sabha ≥ `bot-api-header-auth`.
- [ ] `docs/ARCHITECTURE.md` — update URL shape in diagrams if present.

### 8. Release

- [ ] `npm run build && npm test && npm run lint` all green.
- [ ] Manual e2e (checklist below).
- [ ] Bump `package.json` to `2026.4.25` (CalVer matches first-party OpenClaw plugins).
- [ ] Tag `2026.4.25` locally (no publish).

## Files touched

| File | Scope of change |
| --- | --- |
| `src/client.ts` | Auth header, 22 URL paths, constructor field, class comment |
| `src/types.ts` | `SabhaConfig` fields |
| `src/bot-accounts.ts` | `ResolvedBotAccount` fields, layering |
| `src/channel.ts` | Zod schema, card fields, `configured` checks, outbound client |
| `src/monitor.ts` | Client construction, error hint |
| `src/doctor.ts` | Client construction, status line, error hint |
| `src/tools.ts` | Client construction |
| `src/setup-wizard.ts` | Response parsing, persist new fields, pre-reg probe URL |
| `src/cli.ts` | Response parsing, persist new fields |
| `src/*.test.ts` | Fixture updates |
| `CLAUDE.md`, `README.md`, `docs/ARCHITECTURE.md` | Prose |
| `package.json` | Version bump |

## Untouched

`src/skill-prompt.ts`, `src/monitor-websocket.ts`, `src/reconnect.ts`, `src/dedup.ts`, `src/typing.ts`, `src/retry.ts`, `src/outbound/*`, `src/session.ts`, `src/draft-stream.ts`, agent-tool surface, multi-bot layering beyond the schema additions.

## Manual e2e checklist

Against a local Sabha checkout on `bot-api-header-auth`:

- [ ] Wipe `channels.sabha` from `~/.openclaw/openclaw.json`.
- [ ] `openclaw plugins install -l .` in `openclaw-sabha`.
- [ ] `openclaw gateway restart`.
- [ ] `openclaw configure` → Sabha → paste fresh `/join/<code>` URL.
- [ ] Verify config contains `apiBaseUrl`, `webhookSecret`, `baseUrl`, `botKey`.
- [ ] DM bot → reply lands, streaming preview visible.
- [ ] Group @mention → reply lands.
- [ ] Edit flow (draft-stream finalization) → confirm `PATCH /api/bots/rooms/:id/messages/:id`.
- [ ] Thread reply → `POST /api/bots/rooms/:id/messages/:id/thread`.
- [ ] Agent tool: `sabha_list_rooms` → `GET /api/bots/rooms`.
- [ ] Agent tool: `sabha_search` → `GET /api/bots/search?q=…`.
- [ ] Agent tool: `sabha_create_room` + `sabha_add_member` → POSTs against new shape.
- [ ] Server logs show `Authorization: Bearer` on every request; no `bot_key` in paths.
- [ ] Doctor: `openclaw plugins doctor sabha` reports healthy.

## Ship checklist

- [ ] Plan reviewed and accepted.
- [ ] Branch `v0.10.0-bearer-auth` created from `main`.
- [ ] Sabha server `bot-api-header-auth` running locally.
- [ ] All tasks above complete.
- [ ] Build + tests + lint green.
- [ ] Manual e2e green.
- [ ] Version bumped, tag `2026.4.25` created.
