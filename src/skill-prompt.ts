/**
 * Fetches Sabha's /skill endpoint (LLM-readable API documentation)
 * and caches it for injection into the agent's system prompt.
 *
 * Cache is keyed by `baseUrl` because `/skill` is rendered per workspace
 * (ActionText template interpolates `Current.account.name`, `request.base_url`,
 * and the workspace path prefix — see `sabha/app/views/skills/show.text.erb`).
 * Two bot accounts pointing at the same workspace share an entry; accounts
 * on different workspaces / servers each get their own.
 */

const cache = new Map<string, string>();

export async function fetchSkillPrompt(baseUrl: string): Promise<string> {
  const cached = cache.get(baseUrl);
  if (cached !== undefined) return cached;

  try {
    const res = await globalThis.fetch(`${baseUrl}/skill`, {
      headers: { Accept: "text/plain" },
    });

    if (!res.ok) {
      throw new Error(`/skill returned ${res.status}`);
    }

    const text = await res.text();
    cache.set(baseUrl, text);
    return text;
  } catch {
    // Don't cache failures — retry next time
    return "";
  }
}

export function getCachedSkillText(baseUrl: string): string | null {
  return cache.get(baseUrl) ?? null;
}

/** Test-only: reset the cache between runs. */
export function __resetSkillCache(): void {
  cache.clear();
}
