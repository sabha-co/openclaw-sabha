// Whether a room can hold threads, as last seen on an inbound event. The
// host's threading context carries only a chat type, which is "group" for
// both an Open room and a group DM, but Sabha refuses a new thread in a DM
// (422). Inbound turns record the room's kind here so the message tool's
// thread context can tell the two apart.
const MAX_ROOMS = 5_000;
const threadable = new Map<string, boolean>();

const keyOf = (accountId: string, roomId: string | number) => `${accountId}:${roomId}`;

export function noteRoomThreading(accountId: string, roomId: string | number, canThread: boolean): void {
  const key = keyOf(accountId, roomId);
  threadable.delete(key);
  threadable.set(key, canThread);
  if (threadable.size > MAX_ROOMS) threadable.delete(threadable.keys().next().value!);
}

/** `undefined` when no event from that room has been seen. */
export function roomCanThread(accountId: string, roomId: string | number): boolean | undefined {
  return threadable.get(keyOf(accountId, roomId));
}
