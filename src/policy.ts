import { evaluatePolicy, type PolicyRule } from "@agent-runtime/policy";
import type { JsonValue, Tool, ToolContext } from "./tools/registry";

export type { PolicyDecision } from "@agent-runtime/policy";
export { isDirectChat } from "@agent-runtime/policy";

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
  created_at: string;
  updated_at: string;
}

/**
 * Angel-side adapter over @agent-runtime/policy.
 *
 * All matching and precedence logic lives in the package. What stays here is
 * the part that is genuinely Angel's: the SQL, the snake_case row mapping, and
 * the ToolContext -> PolicyContext narrowing.
 */
function rowToRule(row: PolicyRow): PolicyRule {
  return {
    id: String(row.id),
    name: row.name,
    type: row.type,
    action: row.action,
    // The query already filters on enabled = 1.
    enabled: true,
    toolName: row.tool_name,
    riskLevel: row.risk_level,
    channel: row.channel,
    actorId: row.actor_id,
    pathPattern: row.path_pattern,
    domainPattern: row.domain_pattern,
    note: row.note,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function evaluateExecutionPolicy(
  tool: Tool,
  input: JsonValue,
  ctx: ToolContext,
  opts?: { confirmationSatisfied?: boolean },
): ReturnType<typeof evaluatePolicy> {
  // Rules are evaluated newest-first (ORDER BY id DESC) and the FIRST match
  // decides: deny wins immediately, allow wins immediately. That means a
  // newer `allow` rule intentionally shadows an older matching `deny`;
  // precedence is recency, not severity. Keep deny rules newer than the
  // allows they should override, or scope them more narrowly.
  const rows = ctx.db
    .query(
      `SELECT id, name, type, action, tool_name, risk_level, channel, actor_id, path_pattern, domain_pattern, note, created_at, updated_at
       FROM execution_policies
       WHERE enabled = 1
       ORDER BY id DESC`,
    )
    .all() as PolicyRow[];

  return evaluatePolicy(rows.map(rowToRule), tool, input, ctx, {
    confirmationSatisfied: opts?.confirmationSatisfied,
  });
}
