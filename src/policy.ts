import type { JsonValue, Tool, ToolContext } from "./tools/registry";

interface PolicyRow {
  id: number;
  name: string;
  type: "approval" | "permission";
  action: "allow" | "deny" | "require_confirmation";
  tool_name: string | null;
  risk_level: string | null;
  channel: string | null;
  actor_id: string | null;
  path_pattern: string | null;
  domain_pattern: string | null;
  note: string | null;
}

export interface PolicyDecision {
  allowed: boolean;
  requireConfirmation: boolean;
  reason?: string;
}

function wildcardMatch(value: string, pattern: string): boolean {
  const escaped = pattern
    .split("*")
    .map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${escaped}$`, "i").test(value);
}

function fieldMatches(
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

function getPathFromToolInput(
  toolName: string,
  input: JsonValue,
): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  if (
    toolName === "read_file" ||
    toolName === "write_file" ||
    toolName === "edit_file" ||
    toolName === "glob" ||
    toolName === "grep"
  ) {
    const obj = input as Record<string, JsonValue>;
    return typeof obj.path === "string" ? obj.path : undefined;
  }
  return undefined;
}

function getDomainFromToolInput(
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

function ruleMatches(
  row: PolicyRow,
  tool: Tool,
  input: any,
  ctx: ToolContext,
): boolean {
  if (!fieldMatches(tool.name, row.tool_name)) return false;
  if (!fieldMatches(tool.risk, row.risk_level)) return false;
  if (!fieldMatches(ctx.channel, row.channel)) return false;
  if (!fieldMatches(ctx.actorId, row.actor_id)) return false;

  const pathValue = getPathFromToolInput(tool.name, input);
  if (!fieldMatches(pathValue, row.path_pattern)) return false;

  const domainValue = getDomainFromToolInput(tool.name, input);
  if (!fieldMatches(domainValue, row.domain_pattern)) return false;

  return true;
}

export function evaluateExecutionPolicy(
  tool: Tool,
  input: any,
  ctx: ToolContext,
  opts?: { confirmationSatisfied?: boolean },
): PolicyDecision {
  // Rules are evaluated newest-first (ORDER BY id DESC) and the FIRST match
  // decides: deny wins immediately, allow wins immediately. That means a
  // newer `allow` rule intentionally shadows an older matching `deny`;
  // precedence is recency, not severity. Keep deny rules newer than the
  // allows they should override, or scope them more narrowly.
  const rows = ctx.db
    .query(
      `SELECT id, name, type, action, tool_name, risk_level, channel, actor_id, path_pattern, domain_pattern, note
       FROM execution_policies
       WHERE enabled = 1
       ORDER BY id DESC`,
    )
    .all() as PolicyRow[];

  let requireConfirmationMatch: PolicyRow | null = null;

  for (const row of rows) {
    if (!ruleMatches(row, tool, input, ctx)) continue;
    if (row.action === "deny") {
      return {
        allowed: false,
        requireConfirmation: false,
        reason: `Blocked by policy "${row.name}"${row.note ? `: ${row.note}` : ""}`,
      };
    }
    if (row.action === "require_confirmation" && !requireConfirmationMatch) {
      // A satisfied confirmation fulfils the requirement but must not skip
      // the rest of the scan — an explicit deny further down still applies.
      if (opts?.confirmationSatisfied) continue;
      requireConfirmationMatch = row;
      continue;
    }
    if (row.action === "allow") {
      return { allowed: true, requireConfirmation: false };
    }
  }

  if (requireConfirmationMatch) {
    return opts?.confirmationSatisfied
      ? { allowed: true, requireConfirmation: false }
      : {
          allowed: false,
          requireConfirmation: true,
          reason: `Confirmation required by policy "${requireConfirmationMatch.name}"`,
        };
  }

  // No rule matched. Unconfigured must not mean "allow everything" in
  // multi-party chats: high-risk tools fall back to requiring confirmation
  // there, so an empty ruleset fails safe instead of fail-open.
  //
  // Direct chats (owner DMs) keep the historical allow behavior; that is
  // where the safe-word flow itself resolves (approve_confirmation is
  // high-risk); failing closed here would brick confirmations entirely.
  if (tool.risk === "high" && !isDirectChat(ctx.channel)) {
    if (!opts?.confirmationSatisfied) {
      return {
        allowed: false,
        requireConfirmation: true,
        reason:
          "No matching execution policy for a high-risk tool outside a direct chat",
      };
    }
  }

  return { allowed: true, requireConfirmation: false };
}

/** True when the channel key refers to a 1:1 conversation
 *  (discord_dm, signal_private, imessage_private, telegram_private, …). */
export function isDirectChat(channel: string | undefined): boolean {
  return typeof channel === "string" && /_(dm|private)$/.test(channel);
}
