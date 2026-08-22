import type { Tool, ToolContext } from "./tools/registry";

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
  input: any,
): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  if (
    toolName === "read_file" ||
    toolName === "write_file" ||
    toolName === "edit_file" ||
    toolName === "glob" ||
    toolName === "grep"
  ) {
    return input.path || undefined;
  }
  return undefined;
}

function getDomainFromToolInput(
  toolName: string,
  input: any,
): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  if (toolName === "web_fetch" && typeof input.url === "string") {
    try {
      return new URL(input.url).hostname;
    } catch {
      return undefined;
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
): PolicyDecision {
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
      requireConfirmationMatch = row;
      continue;
    }
    if (row.action === "allow") {
      return { allowed: true, requireConfirmation: false };
    }
  }

  if (requireConfirmationMatch) {
    return {
      allowed: false,
      requireConfirmation: true,
      reason: `Confirmation required by policy "${requireConfirmationMatch.name}"`,
    };
  }

  // No rule matched. Unconfigured must not mean "allow everything": high-risk
  // tools fall back to requiring confirmation so a misconfigured or empty
  // ruleset fails safe instead of fail-open.
  if (tool.risk === "high") {
    return {
      allowed: false,
      requireConfirmation: true,
      reason: "No matching execution policy for a high-risk tool",
    };
  }

  return { allowed: true, requireConfirmation: false };
}
