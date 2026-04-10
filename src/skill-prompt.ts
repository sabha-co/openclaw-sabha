/**
 * Fetches Sabha's /skill endpoint (LLM-readable API documentation)
 * and caches it for injection into the agent's system prompt.
 */

let cachedSkillText: string | null = null;

export async function fetchSkillPrompt(baseUrl: string): Promise<string> {
  if (cachedSkillText) return cachedSkillText;

  try {
    const res = await globalThis.fetch(`${baseUrl}/skill`, {
      headers: { Accept: "text/plain" },
    });

    if (!res.ok) {
      throw new Error(`/skill returned ${res.status}`);
    }

    cachedSkillText = await res.text();
    return cachedSkillText;
  } catch {
    // Don't cache failures — retry next time
    return "";
  }
}

export function getCachedSkillText(): string | null {
  return cachedSkillText;
}
