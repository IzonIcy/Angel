import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "fs";
import { join } from "path";

// Row types matching the sqlite schemas in this file. SQLite returns
// numbers for INTEGER/REAL columns and null for nullable columns.
export interface MessageRow {
  id: string;
  chat_id: number;
  role: string;
  sender_name: string | null;
  content: string;
  tool_calls: string | null;
  tool_call_id: string | null;
  is_from_bot: number;
  timestamp: string;
}

export interface MemoryRow {
  id: number;
  chat_id: number | null;
  content: string;
  category: string;
  confidence: number;
  source: string;
  is_archived: number;
  created_at: string;
  updated_at: string;
}

export interface ScheduledTaskRow {
  id: number;
  chat_id: number | null;
  name: string | null;
  prompt: string;
  cron_expr: string | null;
  next_run_at: string | null;
  status: string;
  timezone: string;
  max_retries: number;
  retry_count: number;
  created_at: string;
}

export interface UsageStatsRow {
  model: string;
  total_input: number;
  total_output: number;
  calls: number;
}

let _db: Database | null = null;

export function getDb(dataDir: string): Database {
  if (_db) return _db;
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
  _db = new Database(join(dataDir, "angel.db"));
  _db.exec("PRAGMA journal_mode = WAL");
  _db.exec("PRAGMA foreign_keys = ON");
  migrate(_db);
  return _db;
}

function migrate(db: Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS db_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  const version = db
    .query("SELECT value FROM db_meta WHERE key = 'schema_version'")
    .get() as { value: string } | null;
  const current = version ? parseInt(version.value, 10) : 0;

  const migrations = [migrationV1, migrationV2, migrationV3];

  for (let i = current; i < migrations.length; i++) {
    migrations[i](db);
    db.run(
      "INSERT OR REPLACE INTO db_meta (key, value) VALUES ('schema_version', ?)",
      [String(i + 1)],
    );
  }
}

function migrationV1(db: Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS chats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel TEXT NOT NULL,
      external_chat_id TEXT NOT NULL,
      chat_type TEXT NOT NULL DEFAULT 'private',
      title TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(channel, external_chat_id)
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      chat_id INTEGER NOT NULL REFERENCES chats(id),
      role TEXT NOT NULL DEFAULT 'user',
      sender_name TEXT,
      content TEXT NOT NULL,
      tool_calls TEXT,
      tool_call_id TEXT,
      is_from_bot INTEGER DEFAULT 0,
      timestamp TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_messages_chat_ts ON messages(chat_id, timestamp);

    CREATE TABLE IF NOT EXISTS sessions (
      chat_id INTEGER PRIMARY KEY REFERENCES chats(id),
      messages_json TEXT,
      model_override TEXT,
      compaction_summary TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id INTEGER,
      content TEXT NOT NULL,
      category TEXT DEFAULT 'general',
      confidence REAL DEFAULT 0.8,
      source TEXT DEFAULT 'user',
      is_archived INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_memories_chat ON memories(chat_id);
    CREATE INDEX IF NOT EXISTS idx_memories_active ON memories(is_archived, updated_at);

    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id INTEGER REFERENCES chats(id),
      name TEXT,
      prompt TEXT NOT NULL,
      cron_expr TEXT,
      next_run_at TEXT,
      status TEXT DEFAULT 'active',
      timezone TEXT DEFAULT 'UTC',
      max_retries INTEGER DEFAULT 3,
      retry_count INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_tasks_status ON scheduled_tasks(status, next_run_at);

    CREATE TABLE IF NOT EXISTS task_run_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER REFERENCES scheduled_tasks(id),
      chat_id INTEGER,
      started_at TEXT,
      finished_at TEXT,
      duration_ms INTEGER,
      success INTEGER,
      result_summary TEXT
    );

    CREATE TABLE IF NOT EXISTS scheduled_task_dlq (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER,
      chat_id INTEGER,
      failed_at TEXT DEFAULT (datetime('now')),
      error_text TEXT,
      original_prompt TEXT,
      retry_count INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS llm_usage_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id INTEGER,
      model TEXT,
      input_tokens INTEGER,
      output_tokens INTEGER,
      duration_ms INTEGER,
      context TEXT DEFAULT 'agent_loop',
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_usage_created ON llm_usage_logs(created_at);

    CREATE TABLE IF NOT EXISTS subagent_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id INTEGER,
      parent_run_id INTEGER,
      name TEXT,
      prompt TEXT,
      status TEXT DEFAULT 'running',
      result TEXT,
      depth INTEGER DEFAULT 0,
      max_iterations INTEGER,
      created_at TEXT DEFAULT (datetime('now')),
      finished_at TEXT
    );

    CREATE TABLE IF NOT EXISTS auth_sessions (
      token TEXT PRIMARY KEY,
      expires_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS memory_reflector_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id INTEGER,
      started_at TEXT,
      finished_at TEXT,
      extracted_count INTEGER DEFAULT 0,
      inserted_count INTEGER DEFAULT 0,
      skipped_count INTEGER DEFAULT 0,
      error_text TEXT
    );

    CREATE TABLE IF NOT EXISTS hooks (
      name TEXT PRIMARY KEY,
      event TEXT NOT NULL,
      command TEXT NOT NULL,
      timeout_ms INTEGER DEFAULT 5000,
      enabled INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS plugins (
      name TEXT PRIMARY KEY,
      manifest_path TEXT NOT NULL,
      enabled INTEGER DEFAULT 1,
      loaded_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS pending_confirmations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      origin_chat_id INTEGER NOT NULL,
      dm_chat_id INTEGER,
      channel TEXT NOT NULL,
      dm_id TEXT NOT NULL,
      action_description TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      tool_input TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      created_at TEXT DEFAULT (datetime('now')),
      resolved_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_pending_status ON pending_confirmations(status, dm_id);

    CREATE TABLE IF NOT EXISTS allowed_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel TEXT NOT NULL,
      user_id TEXT NOT NULL,
      added_by TEXT DEFAULT 'config',
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(channel, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_allowed_channel ON allowed_users(channel);
  `);
}

function migrationV2(_db: Database) {
  // Tables already created in migrationV1 — this was a no-op duplicate.
  // Kept as empty migration to preserve schema_version numbering.
}

function migrationV3(db: Database) {
  addColumnIfMissing(db, "scheduled_tasks", "fallback_prompt", "TEXT");
  addColumnIfMissing(db, "memories", "pinned", "INTEGER DEFAULT 0");
  addColumnIfMissing(db, "memories", "source_of_truth", "TEXT");
  addColumnIfMissing(db, "memories", "contradiction_key", "TEXT");
  addColumnIfMissing(
    db,
    "memories",
    "decay_half_life_days",
    "INTEGER DEFAULT 45",
  );

  db.exec(`
    CREATE TABLE IF NOT EXISTS goals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id INTEGER REFERENCES chats(id),
      name TEXT NOT NULL,
      outcome TEXT NOT NULL,
      status TEXT DEFAULT 'active',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_goals_chat ON goals(chat_id, status);

    CREATE TABLE IF NOT EXISTS goal_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      goal_id INTEGER NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      details TEXT,
      status TEXT DEFAULT 'pending',
      dependency_task_ids TEXT DEFAULT '[]',
      checkpoint_order INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_goal_tasks_goal ON goal_tasks(goal_id, status);

    CREATE TABLE IF NOT EXISTS goal_checkpoints (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      goal_id INTEGER NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      summary TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_goal_checkpoints_goal ON goal_checkpoints(goal_id);

    CREATE TABLE IF NOT EXISTS execution_policies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      type TEXT NOT NULL CHECK(type IN ('approval', 'permission')),
      action TEXT NOT NULL CHECK(action IN ('allow', 'deny', 'require_confirmation')),
      enabled INTEGER DEFAULT 1,
      tool_name TEXT,
      risk_level TEXT,
      channel TEXT,
      actor_id TEXT,
      path_pattern TEXT,
      domain_pattern TEXT,
      note TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_policies_scope ON execution_policies(enabled, type, tool_name, risk_level, channel, actor_id);

    CREATE TABLE IF NOT EXISTS knowledge_connectors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      type TEXT NOT NULL,
      config_json TEXT NOT NULL DEFAULT '{}',
      status TEXT DEFAULT 'active',
      last_synced_at TEXT,
      last_error TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS knowledge_documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      connector_id INTEGER NOT NULL REFERENCES knowledge_connectors(id) ON DELETE CASCADE,
      external_id TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      url TEXT,
      checksum TEXT,
      updated_at TEXT DEFAULT (datetime('now')),
      UNIQUE(connector_id, external_id)
    );
    CREATE INDEX IF NOT EXISTS idx_knowledge_docs_connector ON knowledge_documents(connector_id);

    CREATE TABLE IF NOT EXISTS workflow_recipes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id INTEGER REFERENCES chats(id),
      name TEXT NOT NULL,
      description TEXT,
      steps_json TEXT NOT NULL DEFAULT '[]',
      enabled INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS workflow_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      recipe_id INTEGER NOT NULL REFERENCES workflow_recipes(id) ON DELETE CASCADE,
      chat_id INTEGER,
      status TEXT DEFAULT 'running',
      started_at TEXT DEFAULT (datetime('now')),
      finished_at TEXT,
      result_summary TEXT,
      error_text TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_workflow_runs_recipe ON workflow_runs(recipe_id, started_at);

    CREATE TABLE IF NOT EXISTS proactive_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id INTEGER REFERENCES chats(id),
      name TEXT NOT NULL,
      trigger_type TEXT NOT NULL CHECK(trigger_type IN ('cron', 'inactivity')),
      cron_expr TEXT,
      threshold_minutes INTEGER,
      message_template TEXT NOT NULL,
      status TEXT DEFAULT 'active',
      next_run_at TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      last_triggered_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_proactive_status ON proactive_rules(status, next_run_at);

    CREATE TABLE IF NOT EXISTS system_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL,
      severity TEXT NOT NULL DEFAULT 'info',
      context TEXT,
      details TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_system_events_created ON system_events(created_at, severity);

    CREATE TABLE IF NOT EXISTS tool_execution_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id INTEGER,
      actor_id TEXT,
      channel TEXT,
      tool_name TEXT NOT NULL,
      success INTEGER NOT NULL,
      duration_ms INTEGER NOT NULL,
      error_text TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_tool_exec_created ON tool_execution_logs(created_at, tool_name, success);
  `);
}

function addColumnIfMissing(
  db: Database,
  table: string,
  column: string,
  definition: string,
) {
  const rows = db.query(`PRAGMA table_info(${table})`).all() as Array<{
    name: string;
  }>;
  if (rows.some((r) => r.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

export function upsertChat(
  db: Database,
  channel: string,
  externalChatId: string,
  chatType?: string,
  title?: string,
): number {
  db.run(
    `INSERT INTO chats (channel, external_chat_id, chat_type, title)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(channel, external_chat_id) DO UPDATE SET title = COALESCE(excluded.title, title)`,
    [channel, externalChatId, chatType || "private", title || null],
  );
  const row = db
    .query("SELECT id FROM chats WHERE channel = ? AND external_chat_id = ?")
    .get(channel, externalChatId) as { id: number };
  return row.id;
}

export function storeMessage(
  db: Database,
  chatId: number,
  role: string,
  content: string,
  opts?: {
    senderName?: string;
    isFromBot?: boolean;
    toolCalls?: string;
    toolCallId?: string;
  },
): string {
  const id = crypto.randomUUID();
  db.run(
    `INSERT INTO messages (id, chat_id, role, content, sender_name, is_from_bot, tool_calls, tool_call_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      chatId,
      role,
      content,
      opts?.senderName || null,
      opts?.isFromBot ? 1 : 0,
      opts?.toolCalls || null,
      opts?.toolCallId || null,
    ],
  );
  return id;
}

export function getRecentMessages(
  db: Database,
  chatId: number,
  limit: number,
): MessageRow[] {
  return db
    .query(
      `SELECT * FROM messages WHERE chat_id = ? ORDER BY timestamp DESC LIMIT ?`,
    )
    .all(chatId, limit)
    .reverse() as MessageRow[];
}

export function saveSession(
  db: Database,
  chatId: number,
  messagesJson: string,
) {
  db.run(
    `INSERT INTO sessions (chat_id, messages_json, updated_at)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(chat_id) DO UPDATE SET messages_json = excluded.messages_json, updated_at = datetime('now')`,
    [chatId, messagesJson],
  );
}

export function loadSession(db: Database, chatId: number): string | null {
  const row = db
    .query("SELECT messages_json FROM sessions WHERE chat_id = ?")
    .get(chatId) as { messages_json: string } | null;
  return row?.messages_json || null;
}

export function getMemories(
  db: Database,
  chatId: number | null,
  limit = 20,
): MemoryRow[] {
  if (chatId !== null) {
    return db
      .query(
        `SELECT * FROM memories WHERE (chat_id = ? OR chat_id IS NULL) AND is_archived = 0 ORDER BY updated_at DESC LIMIT ?`,
      )
      .all(chatId, limit) as MemoryRow[];
  }
  return db
    .query(
      `SELECT * FROM memories WHERE chat_id IS NULL AND is_archived = 0 ORDER BY updated_at DESC LIMIT ?`,
    )
    .all(limit) as MemoryRow[];
}

export function insertMemory(
  db: Database,
  chatId: number | null,
  content: string,
  category = "general",
  source = "user",
): number {
  db.run(
    `INSERT INTO memories (chat_id, content, category, source) VALUES (?, ?, ?, ?)`,
    [chatId, content, category, source],
  );
  const row = db.query("SELECT last_insert_rowid() as id").get() as {
    id: number;
  };
  return row.id;
}

export function archiveMemory(db: Database, id: number) {
  db.run(
    "UPDATE memories SET is_archived = 1, updated_at = datetime('now') WHERE id = ?",
    [id],
  );
}

export function logUsage(
  db: Database,
  chatId: number,
  model: string,
  inputTokens: number,
  outputTokens: number,
  durationMs: number,
  context = "agent_loop",
) {
  db.run(
    `INSERT INTO llm_usage_logs (chat_id, model, input_tokens, output_tokens, duration_ms, context)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [chatId, model, inputTokens, outputTokens, durationMs, context],
  );
}

export function getScheduledTasksDue(db: Database): ScheduledTaskRow[] {
  return db
    .query(
      `SELECT * FROM scheduled_tasks WHERE status = 'active' AND next_run_at <= datetime('now')`,
    )
    .all() as ScheduledTaskRow[];
}

/**
 * Atomically claim a due task so overlapping scheduler ticks can't run it
 * twice. Returns true only if THIS call won the claim.
 */
export function claimScheduledTask(db: Database, taskId: number): boolean {
  const result = db
    .query(
      `UPDATE scheduled_tasks SET status = 'running' WHERE id = ? AND status = 'active'`,
    )
    .run(taskId);
  return result.changes > 0;
}

function toSqliteDatetime(iso: string): string {
  return iso
    .replace("T", " ")
    .replace(/\.\d+Z$/, "")
    .replace(/Z$/, "");
}

export function createScheduledTask(
  db: Database,
  chatId: number,
  name: string,
  prompt: string,
  cronExpr: string | null,
  nextRunAt: string,
  timezone = "UTC",
  fallbackPrompt?: string,
): number {
  db.run(
    `INSERT INTO scheduled_tasks (chat_id, name, prompt, cron_expr, next_run_at, timezone, fallback_prompt) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      chatId,
      name,
      prompt,
      cronExpr,
      toSqliteDatetime(nextRunAt),
      timezone,
      fallbackPrompt || null,
    ],
  );
  return (db.query("SELECT last_insert_rowid() as id").get() as { id: number })
    .id;
}

export function updateTaskNextRun(
  db: Database,
  taskId: number,
  nextRunAt: string,
) {
  // Resets status to 'active' too: tasks are claimed as 'running' while they
  // execute, and rescheduling always means "eligible to run again".
  db.run(
    "UPDATE scheduled_tasks SET next_run_at = ?, status = 'active' WHERE id = ?",
    [toSqliteDatetime(nextRunAt), taskId],
  );
}

export function updateTaskStatus(db: Database, taskId: number, status: string) {
  db.run("UPDATE scheduled_tasks SET status = ? WHERE id = ?", [
    status,
    taskId,
  ]);
}

export function updateScheduledTask(
  db: Database,
  taskId: number,
  fields: {
    name?: string;
    prompt?: string;
    cron_expr?: string | null;
    next_run_at?: string;
    timezone?: string;
    fallback_prompt?: string | null;
  },
) {
  const sets: string[] = [];
  const params: (string | number | null)[] = [];
  if (fields.name !== undefined) {
    sets.push("name = ?");
    params.push(fields.name);
  }
  if (fields.prompt !== undefined) {
    sets.push("prompt = ?");
    params.push(fields.prompt);
  }
  if (fields.cron_expr !== undefined) {
    sets.push("cron_expr = ?");
    params.push(fields.cron_expr);
  }
  if (fields.next_run_at !== undefined) {
    sets.push("next_run_at = ?");
    params.push(toSqliteDatetime(fields.next_run_at));
  }
  if (fields.timezone !== undefined) {
    sets.push("timezone = ?");
    params.push(fields.timezone);
  }
  if (fields.fallback_prompt !== undefined) {
    sets.push("fallback_prompt = ?");
    params.push(fields.fallback_prompt);
  }
  if (sets.length === 0) return;
  params.push(taskId);
  db.run(`UPDATE scheduled_tasks SET ${sets.join(", ")} WHERE id = ?`, params);
}

export function insertTaskDlq(
  db: Database,
  taskId: number,
  chatId: number | null,
  errorText: string,
  prompt: string,
  retryCount: number,
) {
  db.run(
    `INSERT INTO scheduled_task_dlq (task_id, chat_id, error_text, original_prompt, retry_count) VALUES (?, ?, ?, ?, ?)`,
    [taskId, chatId, errorText, prompt, retryCount],
  );
}

export function getUsageStats(db: Database, days = 30): UsageStatsRow[] {
  return db
    .query(
      `SELECT model, SUM(input_tokens) as total_input, SUM(output_tokens) as total_output, COUNT(*) as calls
     FROM llm_usage_logs WHERE created_at >= datetime('now', '-' || ? || ' days')
     GROUP BY model ORDER BY total_input DESC`,
    )
    .all(days) as UsageStatsRow[];
}

export function getUsageTotalsForWindow(
  db: Database,
  days = 1,
  chatId?: number,
): { input: number; output: number; total: number } {
  const whereChat = chatId ? "AND chat_id = ?" : "";
  const row = db
    .query(
      `SELECT
         COALESCE(SUM(input_tokens), 0) as input,
         COALESCE(SUM(output_tokens), 0) as output,
         COALESCE(SUM(input_tokens + output_tokens), 0) as total
       FROM llm_usage_logs
       WHERE created_at >= datetime('now', '-' || ? || ' days')
       ${whereChat}`,
    )
    .get(...(chatId ? [days, chatId] : [days])) as {
    input: number;
    output: number;
    total: number;
  };

  return row || { input: 0, output: 0, total: 0 };
}

export function logSystemEvent(
  db: Database,
  eventType: string,
  severity: "info" | "warn" | "error",
  details: string,
  context?: string,
) {
  db.run(
    "INSERT INTO system_events (event_type, severity, context, details) VALUES (?, ?, ?, ?)",
    [eventType, severity, context || null, details],
  );
}

export function logToolExecution(
  db: Database,
  args: {
    chatId: number;
    actorId?: string;
    channel: string;
    toolName: string;
    success: boolean;
    durationMs: number;
    errorText?: string;
  },
) {
  db.run(
    `INSERT INTO tool_execution_logs (chat_id, actor_id, channel, tool_name, success, duration_ms, error_text)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      args.chatId,
      args.actorId || null,
      args.channel,
      args.toolName,
      args.success ? 1 : 0,
      args.durationMs,
      args.errorText || null,
    ],
  );
}

export function getObservabilitySnapshot(db: Database): {
  usage24h: { input: number; output: number; total: number };
  toolCalls24h: number;
  toolErrors24h: number;
  failedTasks24h: number;
  pendingConfirmations: number;
  activeScheduledTasks: number;
  liveRuns: number;
  queueDepth: number;
  recentFailures24h: number;
  channelHealth: Array<{
    channel: string;
    status: "ok" | "degraded" | "unknown";
    chats: number;
    errors24h: number;
    lastErrorAt: string | null;
  }>;
} {
  const usage24h = getUsageTotalsForWindow(db, 1);
  const toolRow = db
    .query(
      `SELECT
         COUNT(*) as calls,
         SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) as errors
       FROM tool_execution_logs
       WHERE created_at >= datetime('now', '-1 days')`,
    )
    .get() as { calls: number; errors: number } | null;
  const failedTasks = db
    .query(
      "SELECT COUNT(*) as count FROM task_run_logs WHERE success = 0 AND started_at >= datetime('now', '-1 days')",
    )
    .get() as { count: number };
  const pendingConfirmations = db
    .query(
      "SELECT COUNT(*) as count FROM pending_confirmations WHERE status = 'pending'",
    )
    .get() as { count: number };
  const activeTasks = db
    .query(
      "SELECT COUNT(*) as count FROM scheduled_tasks WHERE status = 'active'",
    )
    .get() as { count: number };
  const dueTasks = db
    .query(
      "SELECT COUNT(*) as count FROM scheduled_tasks WHERE status = 'active' AND next_run_at <= datetime('now')",
    )
    .get() as { count: number };
  const runningWorkflows = db
    .query(
      "SELECT COUNT(*) as count FROM workflow_runs WHERE status = 'running'",
    )
    .get() as { count: number };
  const runningSubagents = db
    .query(
      "SELECT COUNT(*) as count FROM subagent_runs WHERE status = 'running'",
    )
    .get() as { count: number };
  const systemErrors = db
    .query(
      "SELECT COUNT(*) as count FROM system_events WHERE severity = 'error' AND created_at >= datetime('now', '-1 days')",
    )
    .get() as { count: number };
  const channels = db
    .query("SELECT channel, COUNT(*) as chats FROM chats GROUP BY channel")
    .all() as Array<{ channel: string; chats: number }>;
  const channelEvents = db
    .query(
      `SELECT context as channel, MAX(created_at) as lastEventAt
       FROM system_events
       WHERE event_type IN ('channel_started', 'channel_start_failed')
         AND context IS NOT NULL
       GROUP BY context`,
    )
    .all() as Array<{ channel: string; lastEventAt: string }>;
  const channelErrors = db
    .query(
      `SELECT context as channel, COUNT(*) as errors24h, MAX(created_at) as lastErrorAt
       FROM system_events
       WHERE severity = 'error'
         AND context IS NOT NULL
         AND created_at >= datetime('now', '-1 days')
       GROUP BY context`,
    )
    .all() as Array<{
    channel: string;
    errors24h: number;
    lastErrorAt: string | null;
  }>;
  const errorByChannel = new Map(channelErrors.map((c) => [c.channel, c]));
  const channelNames = new Set([
    ...channels.map((c) => c.channel),
    ...channelEvents.map((c) => c.channel),
  ]);
  const chatsByChannel = new Map(channels.map((c) => [c.channel, c.chats]));
  const channelHealth = [...channelNames].map((channel) => {
    const chats = chatsByChannel.get(channel) || 0;
    const errors = errorByChannel.get(channel);
    return {
      channel,
      status: errors?.errors24h ? ("degraded" as const) : ("ok" as const),
      chats,
      errors24h: errors?.errors24h || 0,
      lastErrorAt: errors?.lastErrorAt || null,
    };
  });

  return {
    usage24h,
    toolCalls24h: toolRow?.calls || 0,
    toolErrors24h: toolRow?.errors || 0,
    failedTasks24h: failedTasks.count,
    pendingConfirmations: pendingConfirmations.count,
    activeScheduledTasks: activeTasks.count,
    liveRuns: runningWorkflows.count + runningSubagents.count,
    queueDepth: dueTasks.count,
    recentFailures24h:
      (toolRow?.errors || 0) + failedTasks.count + systemErrors.count,
    channelHealth,
  };
}
