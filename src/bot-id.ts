/**
 * Extract the numeric bot ID from a bot key.
 * "42-AbCdEfGhIjKl" -> 42
 */
export function extractBotId(botKey: string): number {
  const dash = botKey.indexOf("-");
  return dash > 0 ? Number(botKey.slice(0, dash)) : 0;
}
