import { Type } from "@sinclair/typebox";
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import { SabhaClient } from "./client.js";
import { resolveAccount } from "./channel.js";

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  details: unknown;
};

function toolResult(data: unknown): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data) }],
    details: data,
  };
}

function toolError(err: unknown): ToolResult {
  const message = err instanceof Error ? err.message : String(err);
  return {
    content: [{ type: "text", text: `Error: ${message}` }],
    details: { error: message },
  };
}

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
      label: "List Sabha rooms",
      description: "List all rooms the bot is a member of in Sabha",
      parameters: Type.Object({}),
      async execute(_id: string, _params: Record<string, never>): Promise<ToolResult> {
        try {
          const rooms = await getClient().listRooms();
          return toolResult(rooms);
        } catch (err) {
          return toolError(err);
        }
      },
    },
    {
      name: "sabha_list_joinable_rooms",
      label: "List joinable Sabha rooms",
      description: "List open rooms the bot can join in Sabha",
      parameters: Type.Object({}),
      async execute(_id: string, _params: Record<string, never>): Promise<ToolResult> {
        try {
          const rooms = await getClient().listJoinableRooms();
          return toolResult(rooms);
        } catch (err) {
          return toolError(err);
        }
      },
    },
    {
      name: "sabha_create_room",
      label: "Create Sabha room",
      description: "Create a new room in Sabha. The bot becomes the creator and can manage the room.",
      parameters: Type.Object({
        name: Type.String({ description: "Room name" }),
        type: Type.Union([Type.Literal("open"), Type.Literal("closed")], {
          description: "Room type: 'open' (anyone can join) or 'closed' (invite only)",
        }),
      }),
      async execute(_id: string, params: { name: string; type: "open" | "closed" }): Promise<ToolResult> {
        try {
          const room = await getClient().createRoom(params.name, params.type);
          return toolResult(room);
        } catch (err) {
          return toolError(err);
        }
      },
    },
    {
      name: "sabha_update_room",
      label: "Update Sabha room",
      description: "Rename a room the bot created in Sabha",
      parameters: Type.Object({
        room_id: Type.Number({ description: "Room ID" }),
        name: Type.String({ description: "New room name" }),
      }),
      async execute(_id: string, params: { room_id: number; name: string }): Promise<ToolResult> {
        try {
          const room = await getClient().updateRoom(params.room_id, params.name);
          return toolResult(room);
        } catch (err) {
          return toolError(err);
        }
      },
    },
    {
      name: "sabha_archive_room",
      label: "Archive Sabha room",
      description: "Archive (soft-delete) a room the bot created in Sabha",
      parameters: Type.Object({
        room_id: Type.Number({ description: "Room ID to archive" }),
      }),
      async execute(_id: string, params: { room_id: number }): Promise<ToolResult> {
        try {
          await getClient().archiveRoom(params.room_id);
          return toolResult("Room archived");
        } catch (err) {
          return toolError(err);
        }
      },
    },
    {
      name: "sabha_join_room",
      label: "Join Sabha room",
      description: "Join an open room in Sabha",
      parameters: Type.Object({
        room_id: Type.Number({ description: "Room ID to join" }),
      }),
      async execute(_id: string, params: { room_id: number }): Promise<ToolResult> {
        try {
          const room = await getClient().joinRoom(params.room_id);
          return toolResult(room);
        } catch (err) {
          return toolError(err);
        }
      },
    },
    {
      name: "sabha_leave_room",
      label: "Leave Sabha room",
      description: "Leave a room in Sabha",
      parameters: Type.Object({
        room_id: Type.Number({ description: "Room ID to leave" }),
      }),
      async execute(_id: string, params: { room_id: number }): Promise<ToolResult> {
        try {
          await getClient().leaveRoom(params.room_id);
          return toolResult("Left room");
        } catch (err) {
          return toolError(err);
        }
      },
    },
    {
      name: "sabha_list_members",
      label: "List Sabha room members",
      description: "List members of a room in Sabha",
      parameters: Type.Object({
        room_id: Type.Number({ description: "Room ID" }),
      }),
      async execute(_id: string, params: { room_id: number }): Promise<ToolResult> {
        try {
          const members = await getClient().listMembers(params.room_id);
          return toolResult(members);
        } catch (err) {
          return toolError(err);
        }
      },
    },
    {
      name: "sabha_add_member",
      label: "Add Sabha room member",
      description: "Add a user to a room the bot created in Sabha",
      parameters: Type.Object({
        room_id: Type.Number({ description: "Room ID" }),
        user_id: Type.Number({ description: "User ID to add" }),
      }),
      async execute(_id: string, params: { room_id: number; user_id: number }): Promise<ToolResult> {
        try {
          const member = await getClient().addMember(params.room_id, params.user_id);
          return toolResult(member);
        } catch (err) {
          return toolError(err);
        }
      },
    },
    {
      name: "sabha_remove_member",
      label: "Remove Sabha room member",
      description: "Remove a user from a room the bot created in Sabha",
      parameters: Type.Object({
        room_id: Type.Number({ description: "Room ID" }),
        user_id: Type.Number({ description: "User ID to remove" }),
      }),
      async execute(_id: string, params: { room_id: number; user_id: number }): Promise<ToolResult> {
        try {
          await getClient().removeMember(params.room_id, params.user_id);
          return toolResult("Member removed");
        } catch (err) {
          return toolError(err);
        }
      },
    },
    {
      name: "sabha_search",
      label: "Search Sabha messages",
      description: "Search messages across all rooms the bot is in",
      parameters: Type.Object({
        query: Type.String({ description: "Search query" }),
      }),
      async execute(_id: string, params: { query: string }): Promise<ToolResult> {
        try {
          const results = await getClient().search(params.query);
          return toolResult(results);
        } catch (err) {
          return toolError(err);
        }
      },
    },
    {
      name: "sabha_create_dm",
      label: "Create Sabha DM",
      description: "Create a direct message conversation with a user in Sabha",
      parameters: Type.Object({
        user_id: Type.Number({ description: "User ID to DM" }),
      }),
      async execute(_id: string, params: { user_id: number }): Promise<ToolResult> {
        try {
          const dm = await getClient().createDm([params.user_id]);
          return toolResult(dm);
        } catch (err) {
          return toolError(err);
        }
      },
    },
  ];
}
