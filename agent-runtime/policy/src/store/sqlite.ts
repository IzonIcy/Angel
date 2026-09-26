/**
 * SQLite PolicyStore implementation
 *
 * For Angel compatibility — uses the same schema as Angel's execution_policies table.
 * Backed by bun:sqlite, which is what Angel's own db.ts uses.
 */

import { Database } from "bun:sqlite";
import type {
  CreatePolicyRuleInput,
  PolicyRule,
  PolicyStore,
  UpdatePolicyRuleInput,
} from "../types";

import { generatePolicyId, nowIso } from "../utils";

export interface SqlitePolicyStoreOptions {
  db: Database;
  tableName?: string;
}

const DEFAULT_TABLE = "execution_policies";

/**
 * The table name is interpolated into every query, so it is never a bound
 * parameter and must be validated as a plain SQL identifier instead.
 */
const VALID_TABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function assertValidTableName(tableName: string): void {
  if (!VALID_TABLE_NAME.test(tableName)) {
    throw new Error(
      `Invalid table name: ${JSON.stringify(tableName)}. Must match ${VALID_TABLE_NAME.source}`,
    );
  }
}

export class SqlitePolicyStore implements PolicyStore {
  private db: Database;
  private tableName: string;

  constructor(options: SqlitePolicyStoreOptions) {
    assertValidTableName(options.tableName ?? DEFAULT_TABLE);
    this.db = options.db;
    this.tableName = options.tableName ?? DEFAULT_TABLE;
  }

  async listEnabled(): Promise<PolicyRule[]> {
    const rows = this.db
      .query(
        `SELECT id, name, type, action, enabled, tool_name, risk_level, channel, actor_id, path_pattern, domain_pattern, note, created_at, updated_at
         FROM ${this.tableName}
         WHERE enabled = 1
         ORDER BY id DESC`,
      )
      .all() as SqlitePolicyRow[];

    return rows.map(rowToRule);
  }

  async getById(id: string): Promise<PolicyRule | null> {
    const row = this.db
      .query(
        `SELECT id, name, type, action, enabled, tool_name, risk_level, channel, actor_id, path_pattern, domain_pattern, note, created_at, updated_at
         FROM ${this.tableName}
         WHERE id = ?`,
      )
      .get(id) as SqlitePolicyRow | undefined;

    return row ? rowToRule(row) : null;
  }

  async create(input: CreatePolicyRuleInput): Promise<PolicyRule> {
    const id = generatePolicyId();
    const now = nowIso();

    this.db
      .query(
        `INSERT INTO ${this.tableName} (id, name, type, action, enabled, tool_name, risk_level, channel, actor_id, path_pattern, domain_pattern, note, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.name,
        input.type,
        input.action,
        input.enabled ?? 1,
        input.toolName ?? null,
        input.riskLevel ?? null,
        input.channel ?? null,
        input.actorId ?? null,
        input.pathPattern ?? null,
        input.domainPattern ?? null,
        input.note ?? null,
        now,
        now,
      );

    return {
      id,
      name: input.name,
      type: input.type,
      action: input.action,
      enabled: input.enabled ?? true,
      toolName: input.toolName ?? null,
      riskLevel: input.riskLevel ?? null,
      channel: input.channel ?? null,
      actorId: input.actorId ?? null,
      pathPattern: input.pathPattern ?? null,
      domainPattern: input.domainPattern ?? null,
      note: input.note ?? null,
      createdAt: now,
      updatedAt: now,
    };
  }

  async update(id: string, patch: UpdatePolicyRuleInput): Promise<PolicyRule> {
    const existing = await this.getById(id);
    if (!existing) {
      throw new Error(`Policy rule not found: ${id}`);
    }

    const now = nowIso();

    const sets: string[] = [];
    const params: (string | number | null)[] = [];

    if (patch.name !== undefined) {
      sets.push("name = ?");
      params.push(patch.name);
    }
    if (patch.type !== undefined) {
      sets.push("type = ?");
      params.push(patch.type);
    }
    if (patch.action !== undefined) {
      sets.push("action = ?");
      params.push(patch.action);
    }
    if (patch.enabled !== undefined) {
      sets.push("enabled = ?");
      params.push(patch.enabled ? 1 : 0);
    }
    if (patch.toolName !== undefined) {
      sets.push("tool_name = ?");
      params.push(patch.toolName);
    }
    if (patch.riskLevel !== undefined) {
      sets.push("risk_level = ?");
      params.push(patch.riskLevel);
    }
    if (patch.channel !== undefined) {
      sets.push("channel = ?");
      params.push(patch.channel);
    }
    if (patch.actorId !== undefined) {
      sets.push("actor_id = ?");
      params.push(patch.actorId);
    }
    if (patch.pathPattern !== undefined) {
      sets.push("path_pattern = ?");
      params.push(patch.pathPattern);
    }
    if (patch.domainPattern !== undefined) {
      sets.push("domain_pattern = ?");
      params.push(patch.domainPattern);
    }
    if (patch.note !== undefined) {
      sets.push("note = ?");
      params.push(patch.note);
    }

    sets.push("updated_at = ?");
    params.push(now);
    params.push(id);

    this.db
      .query(`UPDATE ${this.tableName} SET ${sets.join(", ")} WHERE id = ?`)
      .run(...params);

    // Re-read rather than assembling the return value from `patch`. Building it
    // here would duplicate the field mapping above, and the two could drift —
    // a field added to the SET clause but not the object would be reported as
    // saved when it was never written. Reading back makes that impossible.
    const stored = await this.getById(id);
    if (!stored) {
      throw new Error(`Policy rule disappeared during update: ${id}`);
    }
    return stored;
  }

  async delete(id: string): Promise<void> {
    this.db.query(`DELETE FROM ${this.tableName} WHERE id = ?`).run(id);
  }
}

interface SqlitePolicyRow {
  id: string;
  name: string;
  type: "approval" | "permission";
  action: "allow" | "deny" | "require_confirmation";
  enabled: number;
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

function rowToRule(row: SqlitePolicyRow): PolicyRule {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    action: row.action,
    enabled: row.enabled === 1,
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
