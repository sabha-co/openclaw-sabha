# Sabha app API used by this plugin

What `@sabha-co/openclaw-sabha` relies on from sabha-ai (`~/dev/sabha-ai`), as
of 2026-11-07. The server's own reference is `GET {workspace}/skill`
(unauthenticated text) and `docs/features/APPS.md`. Where those disagree with
the server code, the code wins, and so does this file.

## Auth and URLs

- Key: `sabha_app_` + 32 hex. An admin creates it in Settings → Apps and sees it
  once. There is no self-registration.
- REST: `{url}/api/v1`, header `Authorization: Bearer <key>`. On sabha.co the
  workspace is in the path (`https://sabha.co/1000006/api/v1`).
- Cable: `wss://{host}/cable`, same Bearer header. On sabha.co add
  `?wid=<workspace>`; the cable is **not** under the workspace path. The
  `/skill` text says otherwise; it is wrong for SaaS.
- A bad key gets `401 {"error","code":"unauthorized"}`. Some `403`s have empty
  bodies. A room or message the app can't reach is `404`.
- Errors are `{error, code}`: `validation_failed` (422), `not_found`,
  `rate_limited` (429, `Retry-After`), `service_unavailable` (503),
  `internal_error`.

## Cable: `AppEventsChannel`

- Protocol `actioncable-v1-ext-json` (AnyCable): welcome, then
  `{"command":"subscribe","identifier":"{\"channel\":\"AppEventsChannel\"}"}`,
  then `confirm_subscription`. Only app keys may subscribe.
- Event frames: `{identifier, message: <event>, stream_id, epoch, offset}`.
  After subscribing, `{"command":"history","identifier":…,"history":{"streams":{…},"since":<unix>}}`
  replays missed events. The server answers `confirm_history` or
  `reject_history` (history expired or epoch changed).
- Pings every 3 s. `disconnect` with `reconnect: false` means stop.
- App → server actions: only `answer` (for `command` events). **There is no
  `draft` action yet.** The plugin's live drafts need one (plan Part A).

### Who hears what

- An app never hears its own messages. An app only hears another app's
  messages when they mention it explicitly.
- Open or Closed rooms: `message_created` only when the app is mentioned (or
  `@everyone`). Updates, deletes and reactions reach every member app.
- DMs and sub-rooms (threads, forum posts): every member app hears everything.
- Threads: the app must be a member of the thread room. It becomes one by
  posting there, including a post with `parent_message_id`. A mention inside a
  thread the app never joined does not reach it.

### Events

```jsonc
{
  "event": "message_created",            // or message_updated, message_deleted
  "user": { "id": 1, "name": "Alice", "role": "member|…|bot", "url": "…" },
  "room": { "id": 5, "name": "General", "type": "Open|Closed|Direct|Thread|Post", "members": 42, "has_app": true, "messages_url": "…" },
  "message": {
    "id": 10,
    "body": { "html": "…", "plain": "…", "markdown": "…" },
    "has_attachment": false,
    "attachment": null,                   // or { url (signed, 1 h), filename, content_type, byte_size }
    "mentionees": [{ "id": 508, "name": "Claw" }],
    "url": "…", "created_at": "…", "updated_at": "…",
    "thread": null                        // or { id, parent_message_id, parent_room_id } when the message is IN a thread
  },
  "mentions_app": true                    // message_created only
}
```

- `reaction_created` / `reaction_deleted`: `{event, user, room, message, reaction: {id, body}}`.
- `user_created` / `user_deleted`: `{event, user}`. Ignored by the plugin.
- `block_actions` and `command`: not handled yet.

## REST endpoints used

| Use | Request | Response / notes |
|---|---|---|
| Identity | `GET /me` | `{id, name, workspace?}` |
| Send | `POST /rooms/:id/messages[?parent_message_id=]` JSON `{body: html}` | `{id, room_id}`. With a parent, `room_id` is the thread room (created or found). 60 per minute per app. |
| Send file | same, multipart `attachment` | `{id, room_id}` |
| Edit | `PATCH /messages/:id` JSON `{body}` | Not rate limited |
| Delete | `DELETE /messages/:id` | |
| Get | `GET /messages/:id` | Message; `thread` describes the room it is in, not replies to it |
| Read | `GET /rooms/:id/messages?before=&after=&limit=` | `{results (newest first), has_more, next_cursor}`. `limit` 1–200, default 50. `before` takes ISO or a cursor. |
| Search | `GET /search?q=&room_ids[]=&author_ids[]=&before=&after=&limit=` | Same page shape. 300 per hour per app. Use `[]` keys. |
| Reactions | `GET /messages/:id/reactions` | `{reactions: [{content, count, users, truncated}], total, truncated}` |
| React | `POST /messages/:id/reactions`, `text/plain` emoji | `{id}` |
| Unreact | `DELETE /messages/:id/reactions/:reaction_id` | |
| Rooms | `GET /rooms?query=&page=&per_page=` (≤100) | Bare array |
| Room | `GET /rooms/:id` | |
| People | `GET /users?room_id=&page=&per_page=` | Bare array `[{id, name, role, bot, url}]`; no emails |
| Person | `GET /users/:id` | |
| Find people | `GET /autocompletable/users?query=&room_id=` | Up to 20 |
| DM | `POST /direct_messages` JSON `{user_ids: [...]}` | `{room: {id}}`; 200 existing, 201 new |

## Message bodies

`{body: html}` is stored as Action Text (edited with Lexxy) after `@{user_id}`
is replaced with a mention attachment. Raw Markdown would show literally, so
the plugin renders Markdown to Lexxy's own export markup
(`src/client/rich-text.ts`). Tags outside sabha-ai's safelist are stripped.

## Not available to apps (yet)

- **Live drafts.** There is no `AppEventsChannel#draft` action, and
  `client_message_id` is rejected (`422 client_message_id is not permitted`).
  The plugin keeps `livePreview` off by default until both ship.
- **Typing indicators.** There is no app endpoint (`/api/typing` is dev-only).
  The plugin sends none.
- **Ephemerals, Block Kit interactions, slash commands.** Not handled by the
  plugin yet.
