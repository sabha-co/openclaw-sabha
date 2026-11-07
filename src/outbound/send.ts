import { readFile } from "node:fs/promises";
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import { resolveOutboundAttachmentFromUrl, type OutboundMediaAccess } from "openclaw/plugin-sdk/media-runtime";
import { chunkMarkdownTextWithMode, resolveChunkMode, resolveTextChunkLimit } from "openclaw/plugin-sdk/reply-chunking";
import { ssrfPolicyFromAllowPrivateNetwork } from "openclaw/plugin-sdk/ssrf-runtime";
import type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";
import type { SabhaClient } from "../client/client.js";
import type { SabhaSent } from "../client/types.js";
import type { ResolvedSabhaAccount } from "../config/accounts.js";

/** Sabha has no hard body limit; long replies still read better split. */
export const SABHA_TEXT_CHUNK_LIMIT = 12_000;
export const SABHA_MEDIA_MAX_BYTES = 50 * 1024 * 1024;

export type SabhaTarget = {
  roomId: number;
  /** Set to post into (or start) the thread under this top-level message. */
  parentMessageId?: number;
};

export function chunkSabhaText(cfg: OpenClawConfig | undefined, accountId: string, text: string): string[] {
  const limit = resolveTextChunkLimit(cfg, "sabha", accountId, { fallbackLimit: SABHA_TEXT_CHUNK_LIMIT });
  const chunks = chunkMarkdownTextWithMode(text, limit, resolveChunkMode(cfg, "sabha", accountId));
  return chunks.filter((chunk) => chunk.trim().length > 0);
}

/**
 * Posts text in order. The first chunk may carry the draft id so it replaces
 * the live draft in place; later chunks are plain posts.
 */
export async function sendSabhaText(params: {
  client: SabhaClient;
  cfg?: OpenClawConfig;
  accountId: string;
  target: SabhaTarget;
  text: string;
  clientMessageId?: string;
  onSent?: (sent: SabhaSent) => void;
}): Promise<SabhaSent[]> {
  const sent: SabhaSent[] = [];
  for (const [index, chunk] of chunkSabhaText(params.cfg, params.accountId, params.text).entries()) {
    const message = await params.client.sendMessage(params.target.roomId, chunk, {
      ...(params.target.parentMessageId !== undefined ? { parentMessageId: params.target.parentMessageId } : {}),
      ...(index === 0 && params.clientMessageId ? { clientMessageId: params.clientMessageId } : {}),
    });
    sent.push(message);
    params.onSent?.(message);
  }
  return sent;
}

const isHttpUrl = (value: string) => /^https?:\/\//i.test(value);

/** Remote media goes through the SSRF guard; local media through the host's media access. */
export async function loadSabhaMedia(params: {
  runtime: Pick<PluginRuntime, "channel">;
  account: Pick<ResolvedSabhaAccount, "allowPrivateNetwork">;
  url: string;
  mediaAccess?: OutboundMediaAccess;
  maxBytes?: number;
}): Promise<{ buffer: Buffer; contentType?: string; fileName: string }> {
  const maxBytes = params.maxBytes ?? SABHA_MEDIA_MAX_BYTES;
  if (isHttpUrl(params.url)) {
    const fetched = await params.runtime.channel.media.readRemoteMediaBuffer({
      url: params.url,
      maxBytes,
      ...(params.account.allowPrivateNetwork ? { ssrfPolicy: ssrfPolicyFromAllowPrivateNetwork(true) } : {}),
    });
    return { buffer: fetched.buffer, contentType: fetched.contentType, fileName: fetched.fileName ?? fileNameOf(params.url) };
  }
  const staged = await resolveOutboundAttachmentFromUrl(params.url, maxBytes, params.mediaAccess ? { mediaAccess: params.mediaAccess } : {});
  return { buffer: await readFile(staged.path), contentType: staged.contentType, fileName: fileNameOf(params.url) };
}

function fileNameOf(url: string): string {
  const path = url.split(/[?#]/)[0] ?? "";
  const name = decodeURIComponent(path.split("/").pop() ?? "").trim();
  return name || "attachment";
}

/** A Sabha attachment posts as its own message (no caption). */
export async function sendSabhaMedia(params: {
  client: SabhaClient;
  runtime: Pick<PluginRuntime, "channel">;
  account: Pick<ResolvedSabhaAccount, "allowPrivateNetwork">;
  target: SabhaTarget;
  url: string;
  mediaAccess?: OutboundMediaAccess;
}): Promise<SabhaSent> {
  const media = await loadSabhaMedia(params);
  const blob = new Blob([new Uint8Array(media.buffer)], media.contentType ? { type: media.contentType } : {});
  return await params.client.sendAttachment(
    params.target.roomId,
    blob,
    media.fileName,
    params.target.parentMessageId !== undefined ? { parentMessageId: params.target.parentMessageId } : {},
  );
}
