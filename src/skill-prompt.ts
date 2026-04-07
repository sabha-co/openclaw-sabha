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
  } catch (err) {
    // Don't cache failures — retry next time
    return "";
  }
}

export function getSkillPromptHints(baseUrl: string): () => Promise<string[]> {
  return async () => {
    const text = await fetchSkillPrompt(baseUrl);
    if (!text) return [];
    return [
      `You are connected to a Sabha chat server. Here is the full API reference:\n\n${text}`,
    ];
  };
}
