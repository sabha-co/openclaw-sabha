# Drop channel-admin agent tools

**Status:** Proposed (2026.4.29). Branch: `drop-channel-admin-tools`.
**Baseline:** Post-merge state of PR #15. 9 message-tool actions, 10 `api.registerTool` factories.
**Target state:** 9 message-tool actions, **2** `api.registerTool` factories.

## Decision

Delete 8 of the 10 room/member admin agent tools. Retain `sabha_search_members` and `sabha_create_dm`.

| Tool | Outcome |
|---|---|
| `sabha_create_room` | **Delete** |
| `sabha_update_room` | **Delete** |
| `sabha_archive_room` | **Delete** |
| `sabha_join_room` | **Delete** |
| `sabha_leave_room` | **Delete** |
| `sabha_add_member` | **Delete** |
| `sabha_remove_member` | **Delete** |
| `sabha_list_joinable_rooms` | **Delete** |
| `sabha_search_members` | Retain |
| `sabha_create_dm` | Retain |

## Why drop

Code-surface reduction. Every tool is plugin code we own and have to keep working:

- ~20 lines per factory in `src/tools.ts` (definition + Typebox schema + execute handler)
- ~10 lines per backing method in `src/client.ts`
- Tests in `tools.test.ts` and `client.test.ts`
- One pinned integration with a Sabha bot-API endpoint per tool — wire-shape changes upstream become our problem to track
- Tokens on every agent turn for the tool entry in the LLM's available-tools manifest

The 8 dropped tools represent roughly 250 LOC of plugin surface, 6 endpoint integrations (`createRoom`/`updateRoom`/`archiveRoom`/`leaveRoom`/`addMember`/`removeMember`; `joinRoom` and `listRooms` stay for non-tool callers), 8 tool entries in the LLM manifest, and the corresponding test files. None of that surface is exercised by the agent flows running today.

The earlier `CHANNEL-ADMIN-MIGRATION-PLAN.md` (on the unmerged `channel-admin-migration-plan` branch) proposed migrating 6 of the 10 onto canonical message-tool actions. That's a rewrite, not a reduction — same backing client methods, same endpoint integrations, same tests, with different dispatch routing. Dropping is strictly cheaper than migrating.

If a concrete use case for one of the dropped capabilities appears later, re-add it then — preferably via a canonical message-action so the work isn't done twice.

## Why retain `sabha_search_members` and `sabha_create_dm`

Same frame. Each of these earns its LOC by enabling an agent flow that's otherwise impossible:

- **`sabha_search_members`** — the only way to resolve `@alice` in a thread to a user id. Sabha's inbound payloads pre-resolve only `@{user_id}`. No SDK directory slot models `roomId + query` (`ChannelDirectoryListGroupMembersParams` has no `query`; `ChannelDirectoryListPeersParams` has no `roomId`). Removing this locks out thread-summarization flows that reference users by name.
- **`sabha_create_dm`** — the only way for an agent to initiate a DM. Sabha doesn't auto-create on first send. Removing this locks out any flow where the agent decides to start a private conversation.

The asymmetry vs. the dropped tools: those have human substitutes (operators use the Sabha UI for room admin); these don't have a substitute the agent itself can reach.

If the SDK ever ships `listGroupMembers({ groupId, query })` or a `dm-open` canonical action, both retentions migrate.

## Code delete map

### `src/tools.ts`

Delete 8 factory entries (~190 lines): `sabha_create_room`, `sabha_update_room`, `sabha_archive_room`, `sabha_join_room`, `sabha_leave_room`, `sabha_add_member`, `sabha_remove_member`, `sabha_list_joinable_rooms`.

The file shrinks from 307 → ~110 lines. Top-of-file comment block stays (still relevant to the 2 retained tools).

### `src/client.ts`

Audit each method that backed a deleted tool. Delete only those with no remaining caller.

| Method | Other callers? | Action |
|---|---|---|
| `createRoom` | none | Delete |
| `updateRoom` | none | Delete |
| `archiveRoom` | none | Delete |
| `leaveRoom` | none | Delete |
| `addMember` | none | Delete |
| `removeMember` | none | Delete |
| `joinRoom` | `setup-wizard.ts:167` (registration handshake) | **Keep** |
| `listRooms` | `directory.ts`, `resolver.ts`, `doctor.ts` | **Keep** |
| `searchUsers` | retained `sabha_search_members` + `resolver.ts` | **Keep** |
| `createDm` | retained `sabha_create_dm` | **Keep** |

The `joinable: true` parameter on `listRooms` becomes dead code if no caller passes it (the deleted `sabha_list_joinable_rooms` was the only one). Audit during the delete pass — if no caller, drop the parameter from `listRooms` to avoid a stale option. Verify by grepping callers of `listRooms({...})` for `joinable`.

### `src/tools.test.ts`

Delete tests for the 8 dropped factories. Tests for `sabha_search_members` and `sabha_create_dm` stay.

### `src/client.test.ts`

Delete tests for the 6 deleted client methods.

## Doc updates

- **`CLAUDE.md`** — outbound paths section #5 (agent tools): retarget from "room/member admin without cross-channel analog" to "two niche cases the SDK can't model: room-scoped name resolution (`sabha_search_members`) and explicit DM creation (`sabha_create_dm`)."
- **`docs/ARCHITECTURE.md`** — `tools.ts` listing in §File Structure (currently "10 tools total — all operations without cross-channel analogs") and the §Outbound capability split section (the `api.registerTool` bullet currently enumerates 9 admin tools).
- **`docs/CHANNEL-PLUGIN-COMPARISON.md`** — at-a-glance row `registerTool` count `10 → 2`. §3 narrative needs rework: the current text justifies all 10 as channel-bespoke verbs; the new text should describe the two retained tools as SDK-gap verbs and note that the broader admin surface was dropped to reduce maintained code. The "Mattermost/Discord developer would find weird" sections lose the room-admin bullet.
- **`README.md`** — tool list update.
- **`docs/BEARER-AUTH-PLAN.md`** and **`docs/READ-ENDPOINT-SCALE-PLAN.md`** — historical plan docs that reference dropped tool names. Inline trimming would muddy the historical narrative (the references describe past states accurately at the time those plans were executed). Instead, add a one-paragraph postscript at the top of each doc that points forward to this plan and clarifies which tool references are now stale. Keeps the historical doc readable while resolving the doc-vs-code contradiction in two seconds for future readers.

## Backward compatibility

None. Flag-day removal — agent calls to deleted tool names fail with a missing-tool error. If a future use case needs the capability back, re-add via canonical message-action verbs (`channel-create`/`channel-edit`/etc.); the unmerged migration plan in `channel-admin-migration-plan` is the template.

## Risks

1. **`listRooms({ joinable })` parameter.** If the audit finds no remaining caller, dropping the parameter is one extra cleanup commit. If something other than the deleted tool was using it, leave it.

## Implementation order

Single PR. The deletes are mechanical, the doc updates are bounded, and there's no migration shape to grade reviewer headspace against.

Suggested commit sequence within the PR:

1. Delete 8 tool factories from `src/tools.ts` and the corresponding tests.
2. Delete 6 unused client methods from `src/client.ts` and the corresponding tests.
3. Audit `listRooms({ joinable })`; drop the parameter if dead.
4. Doc updates (`CLAUDE.md`, `ARCHITECTURE.md`, `CHANNEL-PLUGIN-COMPARISON.md`, `README.md`, plus incidental references).
5. Run `npm run build && npm test && npm run lint`.

## References

- `src/tools.ts` — current 10-tool registry (lines 144–305)
- `src/client.ts` — backing methods (`createRoom`/`updateRoom`/`archiveRoom`/`joinRoom`/`leaveRoom`/`addMember`/`removeMember` at lines 312–375)
- `src/setup-wizard.ts:167` — sole non-tool caller of `client.joinRoom`
- `docs/CHANNEL-PLUGIN-COMPARISON.md` — peer comparison data (consistent with this plan's conclusion but not its load-bearing argument)
- Prior migration plan (`channel-admin-migration-plan` branch, unmerged) — historical context for the migrate-instead-of-drop alternative; preserved in branch history rather than as a doc
