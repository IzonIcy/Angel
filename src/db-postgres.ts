import { Pool } from "pg";

// Postgres connection pool - analogous to bun:sqlite in src/db.ts
let _pool: Pool | null = null;

export function getPool(): Pool {
  if (_pool) return _pool;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL environment variable not set");
  }
  _pool = new Pool({ connectionString });
  return _pool;
}

// Execute a raw SQL query and return rows
export async function query(sql: string, params?: any[]): Promise<any[]> {
  const pool = getPool();
  const result = await pool.query(sql, params);
  return result.rows;
}

// Execute a raw SQL query and return a single row
export async function row(sql: string, params?: any[]): Promise<any | null> {
  const pool = getPool();
  const result = await pool.query(sql, params);
  return result.rows.length > 0 ? result.rows[0] : null;
}

// Core: ExecutionPolicy - the table that was in SQLite migrationV3
export interface ExecutionPolicyRow {
  id: number;
  name: string;
  type: "approval" | "permission" | null;
  action: "allow" | "deny" | "require_confirmation" | null;
  enabled: boolean;
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

// Query execution policy by name
export async function getExecutionPolicyByName(
  name: string,
): Promise<ExecutionPolicyRow | null> {
  return row("SELECT * FROM execution_policies WHERE name = $1", [name]);
}

// List all execution policies
export async function listExecutionPolicies(): Promise<ExecutionPolicyRow[]> {
  return query("SELECT * FROM execution_policies");
}

// Create a new execution policy
export async function createExecutionPolicy(data: {
  name: string;
  type?: "approval" | "permission";
  action: "allow" | "deny" | "require_confirmation";
  enabled?: boolean;
  tool_name?: string;
  risk_level?: string;
  channel?: string;
  actor_id?: string;
  path_pattern?: string;
  domain_pattern?: string;
  note?: string;
}) {
  await query(
    `INSERT INTO execution_policies (
      name, type, action, enabled, tool_name, risk_level,
      channel, actor_id, path_pattern, domain_pattern, note,
      created_at, updated_at
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW(), NOW()
    )`,
    [
      data.name,
      data.type,
      data.action,
      data.enabled ?? true,
      data.tool_name,
      data.risk_level,
      data.channel,
      data.actor_id,
      data.path_pattern,
      data.domain_pattern,
      data.note,
    ],
  );
}

// Update an execution policy
export async function updateExecutionPolicy(
  name: string,
  data: Partial<{
    type?: "approval" | "permission";
    action?: "allow" | "deny" | "require_confirmation";
    enabled?: boolean;
    tool_name?: string;
    risk_level?: string;
    channel?: string;
    actor_id?: string;
    path_pattern?: string;
    domain_pattern?: string;
    note?: string;
  }>,
) {
  const sets: string[] = [];
  const params: any[] = [name];
  let paramIdx = 2;

  if (data.type !== undefined) {
    sets.push(`type = $${paramIdx}`);
    params.push(data.type);
    paramIdx++;
  }
  if (data.action !== undefined) {
    sets.push(`action = $${paramIdx}`);
    params.push(data.action);
    paramIdx++;
  }
  if (data.enabled !== undefined) {
    sets.push(`enabled = $${paramIdx}`);
    params.push(data.enabled);
    paramIdx++;
  }
  if (data.tool_name !== undefined) {
    sets.push(`tool_name = $${paramIdx}`);
    params.push(data.tool_name);
    paramIdx++;
  }
  if (data.risk_level !== undefined) {
    sets.push(`risk_level = $${paramIdx}`);
    params.push(data.risk_level);
    paramIdx++;
  }
  if (data.channel !== undefined) {
    sets.push(`channel = $${paramIdx}`);
    params.push(data.channel);
    paramIdx++;
  }
  if (data.actor_id !== undefined) {
    sets.push(`actor_id = $${paramIdx}`);
    params.push(data.actor_id);
    paramIdx++;
  }
  if (data.path_pattern !== undefined) {
    sets.push(`path_pattern = $${paramIdx}`);
    params.push(data.path_pattern);
    paramIdx++;
  }
  if (data.domain_pattern !== undefined) {
    sets.push(`domain_pattern = $${paramIdx}`);
    params.push(data.domain_pattern);
    paramIdx++;
  }
  if (data.note !== undefined) {
    sets.push(`note = $${paramIdx}`);
    params.push(data.note);
    paramIdx++;
  }

  if (sets.length === 0) return;

  await query(
    `UPDATE execution_policies SET ${sets.join(", ")} WHERE name = $${paramIdx}`,
    params,
  );
}

// Delete an execution policy
export async function deleteExecutionPolicy(name: string) {
  await query("DELETE FROM execution_policies WHERE name = $1", [name]);
}

// Migrate data from SQLite to Postgres
export async function migrateFromSqlite(sqliteDb: any) {
  // Read from SQLite execution_policies table
  const policies: any[] =
    sqliteDb.query`SELECT * FROM execution_policies`.all();

  for (const policy of policies) {
    const existing = await getExecutionPolicyByName(policy.name);
    if (!existing) {
      await createExecutionPolicy({
        name: policy.name,
        type: policy.type,
        action: policy.action,
        enabled: policy.enabled !== 0,
        tool_name: policy.tool_name,
        risk_level: policy.risk_level,
        channel: policy.channel,
        actor_id: policy.actor_id,
        path_pattern: policy.path_pattern,
        domain_pattern: policy.domain_pattern,
        note: policy.note,
      });
      console.log(`Migrated execution policy: ${policy.name}`);
    }
  }

  console.log("SQLite to Postgres migration complete");
}

// Close the pool
export async function closePool(): Promise<void> {
  const pool = getPool();
  await pool.end();
}
