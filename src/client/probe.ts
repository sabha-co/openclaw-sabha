// Setup-safe identity probe: plain fetch, no socket or runtime imports, so the
// setup entry can verify a pasted URL and key without loading the transport.

export type SabhaIdentity = { id: number; name: string; workspace?: { name?: string; url?: string } };

export type SabhaProbeResult =
  | { ok: true; identity: SabhaIdentity }
  | { ok: false; reason: "unauthorized" | "unreachable" | "not_sabha"; detail: string };

export async function probeSabhaApp(params: {
  apiBaseUrl: string;
  appKey: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): Promise<SabhaProbeResult> {
  const fetchImpl = params.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(`${params.apiBaseUrl}/me`, {
      headers: { Authorization: `Bearer ${params.appKey}`, Accept: "application/json" },
      signal: AbortSignal.timeout(params.timeoutMs ?? 10_000),
    });
  } catch (error) {
    return { ok: false, reason: "unreachable", detail: error instanceof Error ? error.message : String(error) };
  }
  if (response.status === 401 || response.status === 403) {
    return { ok: false, reason: "unauthorized", detail: `HTTP ${response.status}` };
  }
  const body = (await response.json().catch(() => null)) as Partial<SabhaIdentity> | null;
  if (!response.ok || typeof body?.id !== "number" || typeof body.name !== "string") {
    return { ok: false, reason: "not_sabha", detail: `HTTP ${response.status}` };
  }
  return { ok: true, identity: { id: body.id, name: body.name, workspace: body.workspace } };
}

/** Sabha app keys: `sabha_app_` + 32 hex. */
export const APP_KEY_PATTERN = /^sabha_app_[0-9a-f]{32}$/;

export function describeProbeFailure(result: Exclude<SabhaProbeResult, { ok: true }>): string {
  switch (result.reason) {
    case "unauthorized":
      return "Sabha refused the app key. Check it was copied whole, or rotate it in Settings → Apps.";
    case "unreachable":
      return `Couldn't reach Sabha (${result.detail}). Check the workspace URL and that this host can reach it.`;
    case "not_sabha":
      return `That URL didn't answer like a Sabha workspace (${result.detail}). Use the address you open Sabha at, including /<workspace number> on sabha.co.`;
  }
}
