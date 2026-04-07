import { Type } from "@sinclair/typebox";
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import { SabhaClient } from "./client.js";
import { resolveAccount } from "./channel.js";

/**
 * Agent tools for Sabha room and member management.
 * Registered via api.registerTool() in registerFull.
 */
export function createSabhaTools(getConfig: () => OpenClawConfig) {
  function getClient() {
    const cfg = getConfig();
    const account = resolveAccount(cfg);
    return new SabhaClient(account.baseUrl, account.botKey);
  }

  return [
    {
      name: "sabha_list_rooms",
      description: "List all rooms the bot is a member of in Sabha",
      parameters: Type.Object({}),
      async execute() {
        const rooms = await getClient().listRooms();
        return { result: rooms };
      },
    },
    {
      name: "sabha_list_joinable_rooms",
      description: "List open rooms the bot can join in Sabha",
      parameters: Type.Object({}),
      async execute() {
        const rooms = await getClient().listJoinableRooms();
        return { result: rooms };
      },
    },
    {
      name: "sabha_create_room",
      description: "Create a new room in Sabha. The bot becomes the creator and can manage the room.",
      parameters: Type.Object({
        name: Type.String({ description: "Room name" }),
        type: Type.Union([Type.Literal("open"), Type.Literal("closed")], {
          description: "Room type: 'open' (anyone can join) or 'closed' (invite only)",
        }),
      }),
      async execute(params: { name: string; type: "open" | "closed" }) {
        const room = await getClient().createRoom(params.name, params.type);
        return { result: room };
      },
    },
    {
      name: "sabha_update_room",
      description: "Rename a room the bot created in Sabha",
      parameters: Type.Object({
        room_id: Type.Number({ description: "Room ID" }),
        name: Type.String({ description: "New room name" }),
      }),
      async execute(params: { room_id: number; name: string }) {
        const room = await getClient().updateRoom(params.room_id, params.name);
        return { result: room };
      },
    },
    {
      name: "sabha_archive_room",
      description: "Archive (soft-delete) a room the bot created in Sabha",
      parameters: Type.Object({
        room_id: Type.Number({ description: "Room ID to archive" }),
      }),
      async execute(params: { room_id: number }) {
        await getClient().archiveRoom(params.room_id);
        return { result: "Room archived" };
      },
    },
    {
      name: "sabha_join_room",
      description: "Join an open room in Sabha",
      parameters: Type.Object({
        room_id: Type.Number({ description: "Room ID to join" }),
      }),
      async execute(params: { room_id: number }) {
        const room = await getClient().joinRoom(params.room_id);
        return { result: room };
      },
    },
    {
      name: "sabha_leave_room",
      description: "Leave a room in Sabha",
      parameters: Type.Object({
        room_id: Type.Number({ description: "Room ID to leave" }),
      }),
      async execute(params: { room_id: number }) {
        await getClient().leaveRoom(params.room_id);
        return { result: "Left room" };
      },
    },
    {
      name: "sabha_list_members",
      description: "List members of a room in Sabha",
      parameters: Type.Object({
        room_id: Type.Number({ description: "Room ID" }),
      }),
      async execute(params: { room_id: number }) {
        const members = await getClient().listMembers(params.room_id);
        return { result: members };
      },
    },
    {
      name: "sabha_add_member",
      description: "Add a user to a room the bot created in Sabha",
      parameters: Type.Object({
        room_id: Type.Number({ description: "Room ID" }),
        user_id: Type.Number({ description: "User ID to add" }),
      }),
      async execute(params: { room_id: number; user_id: number }) {
        const member = await getClient().addMember(params.room_id, params.user_id);
        return { result: member };
      },
    },
    {
      name: "sabha_remove_member",
      description: "Remove a user from a room the bot created in Sabha",
      parameters: Type.Object({
        room_id: Type.Number({ description: "Room ID" }),
        user_id: Type.Number({ description: "User ID to remove" }),
      }),
      async execute(params: { room_id: number; user_id: number }) {
        await getClient().removeMember(params.room_id, params.user_id);
        return { result: "Member removed" };
      },
    },
    {
      name: "sabha_search",
      description: "Search messages across all rooms the bot is in",
      parameters: Type.Object({
        query: Type.String({ description: "Search query" }),
      }),
      async execute(params: { query: string }) {
        const results = await getClient().search(params.query);
        return { result: results };
      },
    },
    {
      name: "sabha_create_dm",
      description: "Create a direct message conversation with a user in Sabha",
      parameters: Type.Object({
        user_id: Type.Number({ description: "User ID to DM" }),
      }),
      async execute(params: { user_id: number }) {
        const dm = await getClient().createDm([params.user_id]);
        return { result: dm };
      },
    },
  ];
}
