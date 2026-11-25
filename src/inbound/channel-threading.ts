// Whether a channel can hold threads, as last seen on an inbound event. The
// host's threading context carries only a chat type, which is "group" for
// both an Open channel and a group DM, but Sabha refuses a new thread in a DM
// (422). Inbound turns record the channel's kind here so the message tool's
// thread context can tell the two apart.
const MAX_CHANNELS = 5_000;
const threadable = new Map<string, boolean>();

const keyOf = (accountId: string, channelId: string | number) => `${accountId}:${channelId}`;

export function noteChannelThreading(accountId: string, channelId: string | number, canThread: boolean): void {
  const key = keyOf(accountId, channelId);
  threadable.delete(key);
  threadable.set(key, canThread);
  if (threadable.size > MAX_CHANNELS) threadable.delete(threadable.keys().next().value!);
}

/** `undefined` when no event from that channel has been seen. */
export function channelCanThread(accountId: string, channelId: string | number): boolean | undefined {
  return threadable.get(keyOf(accountId, channelId));
}
