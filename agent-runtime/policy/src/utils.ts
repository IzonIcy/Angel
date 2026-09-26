/**
 * Utility functions for policy evaluation
 *
 * These are pure functions with no external dependencies.
 */

/** JSON-serializable value for tool parameters and results */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: unknown };

/**
 * Convert a wildcard pattern to a RegExp.
 * Supports * as wildcard, escapes other regex metacharacters.
 */
export function wildcardMatch(value: string, pattern: string): boolean {
  const escaped = pattern
    .split("*")
    .map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${escaped}$`, "i").test(value);
}

/**
 * Check if a value matches a comma-separated list of patterns.
 * Each pattern supports wildcards. Empty pattern matches anything.
 */
export function fieldMatches(
  value: string | undefined,
  pattern: string | null,
): boolean {
  if (!pattern?.trim()) return true;
  if (!value) return false;
  return pattern
    .split(",")
    .map((p) => p.trim())
    .some((p) => wildcardMatch(value, p));
}

/**
 * Extract file path from tool input for file operations.
 * Returns undefined if tool doesn't have a path parameter or input is invalid.
 */
export function getPathFromToolInput(
  toolName: string,
  input: JsonValue,
): string | undefined {
  if (!input || typeof input !== "object") return undefined;

  // File operations that have a 'path' parameter
  const fileTools = new Set([
    "read_file",
    "write_file",
    "edit_file",
    "glob",
    "grep",
  ]);

  if (!fileTools.has(toolName)) return undefined;

  const obj = input as Record<string, JsonValue>;
  return typeof obj.path === "string" ? obj.path : undefined;
}

/**
 * Extract domain from tool input for web operations.
 * Returns undefined if tool doesn't have a URL parameter or input is invalid.
 */
export function getDomainFromToolInput(
  toolName: string,
  input: JsonValue,
): string | undefined {
  if (!input || typeof input !== "object") return undefined;

  if (toolName === "web_fetch") {
    const obj = input as Record<string, JsonValue>;
    if (typeof obj.url === "string") {
      try {
        return new URL(obj.url).hostname;
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

/**
 * Check if a channel identifier represents a direct (1:1) chat.
 * Direct chats: discord_dm, signal_private, imessage_private, telegram_private, etc.
 */
export function isDirectChat(channel: string | undefined): boolean {
  return typeof channel === "string" && /_(dm|private)$/.test(channel);
}

/**
 * Generate a unique ID for policy rules.
 * Uses timestamp + random suffix for ordering by recency.
 */
export function generatePolicyId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

/**
 * Get current ISO 8601 timestamp.
 */
export function nowIso(): string {
  return new Date().toISOString();
}
