// Tolerant readers for model-supplied action params. Only *what* to do comes
// from params; *who* acts (the account) always comes from host context.

type Params = Record<string, unknown>;

export function readText(params: Params, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = params[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

export function readId(params: Params, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = params[key];
    if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
    if (typeof value === "string" && /^\d+$/.test(value.trim())) return Number(value.trim());
  }
  return undefined;
}

/** Plural keys (arrays or comma lists) merged with singular keys. */
export function readIds(params: Params, plural: string[], singular: string[]): number[] | undefined {
  const ids = new Set<number>();
  for (const key of plural) {
    const value = params[key];
    const items = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
    for (const item of items) {
      const id = readId({ item }, "item");
      if (id !== undefined) ids.add(id);
    }
  }
  for (const key of singular) {
    const id = readId(params, key);
    if (id !== undefined) ids.add(id);
  }
  return ids.size ? [...ids] : undefined;
}

export function readLimit(params: Params, max: number): number | undefined {
  const limit = readId(params, "limit");
  return limit === undefined ? undefined : Math.min(limit, max);
}

export function requireValue<T>(value: T | undefined, message: string): T {
  if (value === undefined) throw new Error(message);
  return value;
}
