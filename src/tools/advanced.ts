import { getObservabilitySnapshot, logSystemEvent } from "../db";
import { getNextCronRun } from "../scheduler";
import type { Tool, ToolContext, ToolResult } from "./registry";

type JsonObject = Record<string, unknown>;

type GoalTaskInput = {
  title: string;
  details?: string;
  dependency_task_ids?: number[];
};

function parseJsonObject(input: string): JsonObject | null {
  try {
    const parsed = JSON.parse(input);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed as JsonObject;
  } catch {
    return null;
  }
}

function parseTaskDependencies(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is number => typeof v === "number");
}

function toSqliteDatetime(iso: string): string {
  return iso
    .replace("T", " ")
    .replace(/\.\d+Z$/, "")
    .replace(/Z$/, "");
}

function buildDefaultGoalTasks(outcome: string): GoalTaskInput[] {
  const label = outcome.trim() || "the outcome";
  return [
    {
      title: "Define success criteria",
      details: `Clarify what must be true for this goal to be complete: ${label}`,
    },
    {
      title: "Map scope and blockers",
      details:
        "Identify required work, owners, dependencies, risks, and open questions.",
      dependency_task_ids: [1],
    },
    {
      title: "Build the execution plan",
      details:
        "Turn the scope into ordered implementation, review, and release steps.",
      dependency_task_ids: [2],
    },
    {
      title: "Execute and validate",
      details:
        "Complete the planned work and verify it against the success criteria.",
      dependency_task_ids: [3],
    },
    {
      title: "Launch and confirm outcome",
      details:
        "Finish launch/release steps, communicate status, and record final checkpoint evidence.",
      dependency_task_ids: [4],
    },
  ];
}

function normalizeNewTaskDependencies(
  dependencyIds: number[] | undefined,
  insertedIds: number[],
): number[] {
  const deps = parseTaskDependencies(dependencyIds || []);
  return deps
    .map((dep) => {
      if (insertedIds.includes(dep)) return dep;
      const oneBased = insertedIds[dep - 1];
      if (oneBased) return oneBased;
      const zeroBased = insertedIds[dep];
      return zeroBased || dep;
    })
    .filter(
      (dep, index, all) =>
        insertedIds.includes(dep) && all.indexOf(dep) === index,
    );
}

function workflowTemplateSteps(
  template: string,
): Array<{ tool: string; input?: unknown }> | null {
  const templates: Record<string, Array<{ tool: string; input?: unknown }>> = {
    daily_standup_digest: [
      {
        tool: "read_chat_history",
        input: { chat_id: "{{chat_id}}", limit: 50 },
      },
      { tool: "list_goals", input: { status: "active" } },
      { tool: "list_scheduled_tasks", input: { status: "active" } },
    ],
    triage_mentions: [
      {
        tool: "read_chat_history",
        input: { chat_id: "{{chat_id}}", limit: 80 },
      },
      { tool: "list_goals", input: { status: "active" } },
      {
        tool: "search_knowledge",
        input: { query: "mentions blockers todos", limit: 10 },
      },
    ],
    release_checklist: [
      { tool: "list_goals", input: { status: "active" } },
      { tool: "list_scheduled_tasks", input: { status: "active" } },
      { tool: "observability_dashboard", input: {} },
    ],
  };
  return templates[template] || null;
}

function renderRecipeInput(value: unknown, ctx: ToolContext): unknown {
  if (value === "{{chat_id}}") return ctx.chatId;
  if (value === "{{channel}}") return ctx.channel;
  if (Array.isArray(value)) return value.map((v) => renderRecipeInput(v, ctx));
  if (value && typeof value === "object") {
    const rendered: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      rendered[key] = renderRecipeInput(nested, ctx);
    }
    return rendered;
  }
  return value;
}

export const createGoalProjectTool: Tool = {
  name: "create_goal_project",
  description:
    "Create a project goal with a task graph and optional checkpoint title.",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "Goal name" },
      outcome: { type: "string", description: "Desired outcome" },
      tasks: {
        type: "array",
        description: "Task list with optional dependency_task_ids",
        items: {
          type: "object",
          properties: {
            title: { type: "string" },
            details: { type: "string" },
            dependency_task_ids: {
              type: "array",
              items: { type: "number" },
            },
          },
          required: ["title"],
        },
      },
      checkpoint_title: {
        type: "string",
        description: "Optional first checkpoint title",
      },
    },
    required: ["name", "outcome"],
  },
  risk: "low",
  async execute(
    input: {
      name: string;
      outcome: string;
      tasks?: Array<{
        title: string;
        details?: string;
        dependency_task_ids?: number[];
      }>;
      checkpoint_title?: string;
    },
    ctx: ToolContext,
  ): Promise<ToolResult> {
    ctx.db.run(
      "INSERT INTO goals (chat_id, name, outcome, status, updated_at) VALUES (?, ?, ?, 'active', datetime('now'))",
      [ctx.chatId, input.name, input.outcome],
    );
    const goalRow = ctx.db.query("SELECT last_insert_rowid() as id").get() as {
      id: number;
    };

    const tasks = input.tasks?.length
      ? input.tasks
      : buildDefaultGoalTasks(input.outcome);
    const insertedTaskIds: number[] = [];
    for (let i = 0; i < tasks.length; i++) {
      const task = tasks[i];
      ctx.db.run(
        `INSERT INTO goal_tasks (goal_id, title, details, status, dependency_task_ids, checkpoint_order, updated_at)
         VALUES (?, ?, ?, 'pending', ?, ?, datetime('now'))`,
        [
          goalRow.id,
          task.title,
          task.details || null,
          JSON.stringify(task.dependency_task_ids || []),
          i,
        ],
      );
      const row = ctx.db.query("SELECT last_insert_rowid() as id").get() as {
        id: number;
      };
      insertedTaskIds.push(row.id);
    }

    for (let i = 0; i < tasks.length; i++) {
      const deps = normalizeNewTaskDependencies(
        tasks[i].dependency_task_ids,
        insertedTaskIds,
      );
      ctx.db.run("UPDATE goal_tasks SET dependency_task_ids = ? WHERE id = ?", [
        JSON.stringify(deps),
        insertedTaskIds[i],
      ]);
    }

    const checkpointTitle = input.checkpoint_title || "Goal initialized";
    if (checkpointTitle) {
      ctx.db.run(
        "INSERT INTO goal_checkpoints (goal_id, title, summary) VALUES (?, ?, ?)",
        [goalRow.id, checkpointTitle, `Outcome: ${input.outcome}`],
      );
    }

    return {
      output: `Goal #${goalRow.id} created with ${tasks.length} task(s).`,
    };
  },
};

export const listGoalsTool: Tool = {
  name: "list_goals",
  description: "List goals and task progress for this chat.",
  parameters: {
    type: "object",
    properties: {
      status: {
        type: "string",
        enum: ["active", "paused", "completed", "cancelled", "all"],
      },
    },
  },
  risk: "low",
  async execute(
    input: { status?: string },
    ctx: ToolContext,
  ): Promise<ToolResult> {
    const status = input.status || "all";
    const where = status === "all" ? "" : "AND g.status = ?";
    const rows = ctx.db
      .query(
        `SELECT
           g.id,
           g.name,
           g.status,
           COUNT(t.id) as task_count,
           SUM(CASE WHEN t.status = 'done' THEN 1 ELSE 0 END) as done_count
         FROM goals g
         LEFT JOIN goal_tasks t ON t.goal_id = g.id
         WHERE g.chat_id = ? ${where}
         GROUP BY g.id
         ORDER BY g.updated_at DESC`,
      )
      .all(
        ...(status === "all" ? [ctx.chatId] : [ctx.chatId, status]),
      ) as Array<{
      id: number;
      name: string;
      status: string;
      task_count: number;
      done_count: number;
    }>;

    if (rows.length === 0) return { output: "No goals found." };
    return {
      output: rows
        .map(
          (r) =>
            `#${r.id} [${r.status}] ${r.name} — ${r.done_count || 0}/${r.task_count || 0} tasks done`,
        )
        .join("\n"),
    };
  },
};

export const advanceGoalTaskTool: Tool = {
  name: "advance_goal_task",
  description:
    "Update a task in a goal project and optionally add a checkpoint entry.",
  parameters: {
    type: "object",
    properties: {
      goal_id: { type: "number" },
      task_id: { type: "number" },
      status: { type: "string", enum: ["pending", "in_progress", "done"] },
      checkpoint_note: { type: "string" },
    },
    required: ["goal_id", "task_id", "status"],
  },
  risk: "low",
  async execute(
    input: {
      goal_id: number;
      task_id: number;
      status: "pending" | "in_progress" | "done";
      checkpoint_note?: string;
    },
    ctx: ToolContext,
  ): Promise<ToolResult> {
    const task = ctx.db
      .query("SELECT * FROM goal_tasks WHERE id = ? AND goal_id = ?")
      .get(input.task_id, input.goal_id) as
      | { dependency_task_ids: string; title: string }
      | undefined;
    if (!task) return { output: "Task not found.", isError: true };

    if (input.status !== "pending") {
      const dependencyIds = parseTaskDependencies(
        JSON.parse(task.dependency_task_ids || "[]"),
      );
      if (dependencyIds.length > 0) {
        const blocked = ctx.db
          .query(
            `SELECT id FROM goal_tasks
             WHERE goal_id = ?
               AND id IN (${dependencyIds.map(() => "?").join(",")})
               AND status != 'done'`,
          )
          .all(input.goal_id, ...dependencyIds) as Array<{ id: number }>;
        if (blocked.length > 0) {
          return {
            output: `Task is blocked by dependencies: ${blocked.map((b) => `#${b.id}`).join(", ")}`,
            isError: true,
          };
        }
      }
    }

    ctx.db.run(
      "UPDATE goal_tasks SET status = ?, updated_at = datetime('now') WHERE id = ?",
      [input.status, input.task_id],
    );
    ctx.db.run("UPDATE goals SET updated_at = datetime('now') WHERE id = ?", [
      input.goal_id,
    ]);

    if (input.checkpoint_note) {
      ctx.db.run(
        "INSERT INTO goal_checkpoints (goal_id, title, summary) VALUES (?, ?, ?)",
        [
          input.goal_id,
          `Task ${task.title} -> ${input.status}`,
          input.checkpoint_note,
        ],
      );
    }

    const remaining = ctx.db
      .query(
        "SELECT COUNT(*) as count FROM goal_tasks WHERE goal_id = ? AND status != 'done'",
      )
      .get(input.goal_id) as { count: number };
    if (remaining.count === 0) {
      ctx.db.run(
        "UPDATE goals SET status = 'completed', updated_at = datetime('now') WHERE id = ?",
        [input.goal_id],
      );
    }

    return { output: `Task #${input.task_id} marked ${input.status}.` };
  },
};

export const goalNextActionsTool: Tool = {
  name: "goal_next_actions",
  description: "Show ready-to-start tasks in a goal based on dependencies.",
  parameters: {
    type: "object",
    properties: {
      goal_id: { type: "number" },
    },
    required: ["goal_id"],
  },
  risk: "low",
  async execute(
    input: { goal_id: number },
    ctx: ToolContext,
  ): Promise<ToolResult> {
    const tasks = ctx.db
      .query(
        "SELECT id, title, dependency_task_ids, status FROM goal_tasks WHERE goal_id = ? AND status = 'pending' ORDER BY checkpoint_order ASC",
      )
      .all(input.goal_id) as Array<{
      id: number;
      title: string;
      dependency_task_ids: string;
      status: string;
    }>;
    if (tasks.length === 0) return { output: "No pending tasks." };

    const ready: Array<{ id: number; title: string }> = [];
    for (const t of tasks) {
      const deps = parseTaskDependencies(
        JSON.parse(t.dependency_task_ids || "[]"),
      );
      if (deps.length === 0) {
        ready.push({ id: t.id, title: t.title });
        continue;
      }
      const openDeps = ctx.db
        .query(
          `SELECT COUNT(*) as count FROM goal_tasks WHERE goal_id = ? AND id IN (${deps.map(() => "?").join(",")}) AND status != 'done'`,
        )
        .get(input.goal_id, ...deps) as { count: number };
      if (openDeps.count === 0) ready.push({ id: t.id, title: t.title });
    }

    if (ready.length === 0) return { output: "No tasks are ready yet." };
    return {
      output: ready.map((r) => `#${r.id} ${r.title}`).join("\n"),
    };
  },
};

export const manageExecutionPolicyTool: Tool = {
  name: "manage_execution_policy",
  description:
    "Create, list, enable/disable, or delete approval/permission execution policies.",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["create", "list", "enable", "disable", "delete"],
      },
      id: { type: "number" },
      name: { type: "string" },
      type: { type: "string", enum: ["approval", "permission"] },
      action_type: {
        type: "string",
        enum: ["allow", "deny", "require_confirmation"],
      },
      tool_name: { type: "string" },
      risk_level: { type: "string" },
      channel: { type: "string" },
      actor_id: { type: "string" },
      path_pattern: { type: "string" },
      domain_pattern: { type: "string" },
      note: { type: "string" },
    },
    required: ["action"],
  },
  risk: "high",
  async execute(input: any, ctx: ToolContext): Promise<ToolResult> {
    if (input.action === "list") {
      const rows = ctx.db
        .query(
          "SELECT id, name, type, action, enabled, tool_name, risk_level, channel, actor_id FROM execution_policies ORDER BY id DESC LIMIT 100",
        )
        .all() as Array<{
        id: number;
        name: string;
        type: string;
        action: string;
        enabled: number;
        tool_name: string | null;
        risk_level: string | null;
        channel: string | null;
        actor_id: string | null;
      }>;
      if (rows.length === 0) return { output: "No policies configured." };
      return {
        output: rows
          .map(
            (r) =>
              `#${r.id} [${r.enabled ? "on" : "off"}] ${r.name} (${r.type}/${r.action}) tool=${r.tool_name || "*"} risk=${r.risk_level || "*"} channel=${r.channel || "*"} actor=${r.actor_id || "*"}`,
          )
          .join("\n"),
      };
    }

    if (input.action === "create") {
      if (!input.name || !input.type || !input.action_type) {
        return {
          output: "name, type, and action_type are required for create.",
          isError: true,
        };
      }
      ctx.db.run(
        `INSERT INTO execution_policies
         (name, type, action, enabled, tool_name, risk_level, channel, actor_id, path_pattern, domain_pattern, note, updated_at)
         VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
        [
          input.name,
          input.type,
          input.action_type,
          input.tool_name || null,
          input.risk_level || null,
          input.channel || null,
          input.actor_id || null,
          input.path_pattern || null,
          input.domain_pattern || null,
          input.note || null,
        ],
      );
      return { output: `Policy "${input.name}" created.` };
    }

    if (!input.id) return { output: "id is required.", isError: true };

    if (input.action === "enable" || input.action === "disable") {
      ctx.db.run(
        "UPDATE execution_policies SET enabled = ?, updated_at = datetime('now') WHERE id = ?",
        [input.action === "enable" ? 1 : 0, input.id],
      );
      return { output: `Policy #${input.id} ${input.action}d.` };
    }

    if (input.action === "delete") {
      ctx.db.run("DELETE FROM execution_policies WHERE id = ?", [input.id]);
      return { output: `Policy #${input.id} deleted.` };
    }

    return { output: `Unknown action: ${input.action}`, isError: true };
  },
};

export const connectorTool: Tool = {
  name: "manage_knowledge_connector",
  description:
    "Create/list/sync knowledge connectors for GitHub issues/PRs, Notion, and Google Drive.",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["create", "list", "sync"] },
      connector_id: { type: "number" },
      name: { type: "string" },
      connector_type: { type: "string", enum: ["github", "notion", "gdrive"] },
      config_json: {
        type: "string",
        description:
          'Connector config JSON. GitHub: {"owner":"org","repo":"repo","token":"optional"}; Notion: {"token":"secret","query":"optional"}; Drive: {"access_token":"token"} or {"api_key":"key"}',
      },
    },
    required: ["action"],
  },
  risk: "medium",
  async execute(input: any, ctx: ToolContext): Promise<ToolResult> {
    if (input.action === "list") {
      const rows = ctx.db
        .query(
          "SELECT id, name, type, status, last_synced_at, last_error FROM knowledge_connectors ORDER BY id DESC",
        )
        .all() as Array<{
        id: number;
        name: string;
        type: string;
        status: string;
        last_synced_at: string | null;
        last_error: string | null;
      }>;
      if (rows.length === 0) return { output: "No connectors configured." };
      return {
        output: rows
          .map(
            (r) =>
              `#${r.id} ${r.name} [${r.type}] ${r.status} last_sync=${r.last_synced_at || "never"}${r.last_error ? ` error=${r.last_error}` : ""}`,
          )
          .join("\n"),
      };
    }

    if (input.action === "create") {
      if (!input.name || !input.connector_type) {
        return {
          output: "name and connector_type are required.",
          isError: true,
        };
      }
      const configJson = input.config_json || "{}";
      if (!parseJsonObject(configJson)) {
        return { output: "config_json must be a JSON object.", isError: true };
      }
      ctx.db.run(
        `INSERT INTO knowledge_connectors (name, type, config_json, status, updated_at)
         VALUES (?, ?, ?, 'active', datetime('now'))`,
        [input.name, input.connector_type, configJson],
      );
      return { output: `Connector "${input.name}" created.` };
    }

    if (input.action !== "sync") {
      return { output: `Unknown action: ${input.action}`, isError: true };
    }

    if (!input.connector_id) {
      return { output: "connector_id is required for sync.", isError: true };
    }

    const connector = ctx.db
      .query(
        "SELECT id, name, type, config_json FROM knowledge_connectors WHERE id = ?",
      )
      .get(input.connector_id) as
      | { id: number; name: string; type: string; config_json: string }
      | undefined;
    if (!connector) return { output: "Connector not found.", isError: true };

    const cfg = parseJsonObject(connector.config_json);
    if (!cfg)
      return { output: "Connector config is invalid JSON.", isError: true };

    try {
      const upserts = await syncConnectorDocuments(connector, cfg, ctx);

      ctx.db.run(
        "UPDATE knowledge_connectors SET last_synced_at = datetime('now'), last_error = NULL, updated_at = datetime('now') WHERE id = ?",
        [connector.id],
      );
      return {
        output: `Synced ${upserts} ${connector.type} document(s).`,
      };
    } catch (err: any) {
      ctx.db.run(
        "UPDATE knowledge_connectors SET last_error = ?, updated_at = datetime('now') WHERE id = ?",
        [err.message, connector.id],
      );
      return { output: `Connector sync error: ${err.message}`, isError: true };
    }
  },
};

async function syncConnectorDocuments(
  connector: { id: number; name: string; type: string },
  cfg: JsonObject,
  ctx: ToolContext,
): Promise<number> {
  if (connector.type === "github")
    return syncGitHubConnector(connector, cfg, ctx);
  if (connector.type === "notion")
    return syncNotionConnector(connector, cfg, ctx);
  if (connector.type === "gdrive")
    return syncDriveConnector(connector, cfg, ctx);
  throw new Error(`Unsupported connector type: ${connector.type}`);
}

function upsertKnowledgeDocument(
  ctx: ToolContext,
  connectorId: number,
  externalId: string,
  title: string,
  content: string,
  url?: string | null,
) {
  const safeContent = content.slice(0, 100000);
  ctx.db.run(
    `INSERT INTO knowledge_documents (connector_id, external_id, title, content, url, checksum, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(connector_id, external_id)
     DO UPDATE SET title = excluded.title, content = excluded.content, url = excluded.url, checksum = excluded.checksum, updated_at = datetime('now')`,
    [
      connectorId,
      externalId,
      title || "(untitled)",
      safeContent,
      url || null,
      String(Bun.hash(safeContent)),
    ],
  );
}

async function syncGitHubConnector(
  connector: { id: number },
  cfg: JsonObject,
  ctx: ToolContext,
): Promise<number> {
  const owner = String(cfg.owner || "");
  const repo = String(cfg.repo || "");
  if (!owner || !repo) {
    throw new Error("GitHub connector requires owner and repo in config_json.");
  }

  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "Angel/1.0",
  };
  if (typeof cfg.token === "string" && cfg.token) {
    headers.Authorization = `Bearer ${cfg.token}`;
  }

  const url = `https://api.github.com/repos/${owner}/${repo}/issues?state=all&per_page=100`;
  const resp = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(20_000),
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(
      `GitHub sync failed: HTTP ${resp.status}: ${body.slice(0, 200)}`,
    );
  }

  const issues = (await resp.json()) as Array<any>;
  let upserts = 0;
  for (const issue of issues) {
    const type = issue.pull_request ? "pull_request" : "issue";
    const labels = Array.isArray(issue.labels)
      ? issue.labels
          .map((l: any) => l.name)
          .filter(Boolean)
          .join(", ")
      : "";
    const content = [
      `Type: ${type}`,
      `Number: #${issue.number}`,
      `State: ${issue.state || "unknown"}`,
      labels ? `Labels: ${labels}` : "",
      `Author: ${issue.user?.login || "unknown"}`,
      "",
      issue.title || "(untitled)",
      "",
      issue.body || "",
    ]
      .filter(Boolean)
      .join("\n");
    upsertKnowledgeDocument(
      ctx,
      connector.id,
      `${type}:${issue.id}`,
      `${type === "pull_request" ? "PR" : "Issue"} #${issue.number}: ${issue.title || "(untitled)"}`,
      content,
      issue.html_url || null,
    );
    upserts++;
  }
  return upserts;
}

async function syncNotionConnector(
  connector: { id: number },
  cfg: JsonObject,
  ctx: ToolContext,
): Promise<number> {
  const token = String(cfg.token || "");
  if (!token)
    throw new Error("Notion connector requires token in config_json.");

  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "Notion-Version": "2022-06-28",
  };
  const body: Record<string, unknown> = { page_size: 50 };
  if (typeof cfg.query === "string" && cfg.query.trim()) {
    body.query = cfg.query.trim();
  }

  const resp = await fetch("https://api.notion.com/v1/search", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(
      `Notion sync failed: HTTP ${resp.status}: ${text.slice(0, 200)}`,
    );
  }

  const data = (await resp.json()) as { results?: any[] };
  let upserts = 0;
  for (const item of data.results || []) {
    const title = getNotionTitle(item);
    const blockText =
      item.object === "page" ? await getNotionBlockText(item.id, headers) : "";
    const content = [
      `Object: ${item.object || "unknown"}`,
      `Last edited: ${item.last_edited_time || "unknown"}`,
      "",
      title,
      "",
      getNotionPropertiesText(item),
      blockText,
    ]
      .filter(Boolean)
      .join("\n");
    upsertKnowledgeDocument(
      ctx,
      connector.id,
      `${item.object || "notion"}:${item.id}`,
      title,
      content,
      item.url || null,
    );
    upserts++;
  }
  return upserts;
}

function getNotionTitle(item: any): string {
  if (Array.isArray(item.title)) {
    const title = notionRichTextToText(item.title);
    if (title) return title;
  }
  for (const prop of Object.values(item.properties || {}) as any[]) {
    if (prop?.type === "title") {
      const title = notionRichTextToText(prop.title || []);
      if (title) return title;
    }
  }
  return item.object === "database" ? "Untitled database" : "Untitled page";
}

function notionRichTextToText(parts: any[]): string {
  return parts
    .map((p) => p?.plain_text || p?.text?.content || "")
    .filter(Boolean)
    .join("");
}

function getNotionPropertiesText(item: any): string {
  const lines: string[] = [];
  for (const [name, prop] of Object.entries(item.properties || {}) as Array<
    [string, any]
  >) {
    if (prop.type === "title") continue;
    const value = notionPropertyToText(prop);
    if (value) lines.push(`${name}: ${value}`);
  }
  return lines.join("\n");
}

function notionPropertyToText(prop: any): string {
  if (!prop?.type) return "";
  const value = prop[prop.type];
  if (Array.isArray(value)) return notionRichTextToText(value);
  if (prop.type === "select") return value?.name || "";
  if (prop.type === "multi_select") {
    return Array.isArray(value) ? value.map((v: any) => v.name).join(", ") : "";
  }
  if (prop.type === "date") return value?.start || "";
  if (prop.type === "people") {
    return Array.isArray(value)
      ? value.map((v: any) => v.name || v.id).join(", ")
      : "";
  }
  if (typeof value === "string" || typeof value === "number")
    return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  return "";
}

async function getNotionBlockText(
  pageId: string,
  headers: Record<string, string>,
): Promise<string> {
  const resp = await fetch(
    `https://api.notion.com/v1/blocks/${pageId}/children?page_size=100`,
    { headers, signal: AbortSignal.timeout(20_000) },
  );
  if (!resp.ok) return "";
  const data = (await resp.json()) as { results?: any[] };
  return (data.results || [])
    .map((block) => {
      const value = block[block.type];
      if (!value?.rich_text) return "";
      return notionRichTextToText(value.rich_text);
    })
    .filter(Boolean)
    .join("\n");
}

async function syncDriveConnector(
  connector: { id: number },
  cfg: JsonObject,
  ctx: ToolContext,
): Promise<number> {
  const accessToken = String(cfg.access_token || "");
  const apiKey = String(cfg.api_key || "");
  if (!accessToken && !apiKey) {
    throw new Error(
      "Google Drive connector requires access_token or api_key in config_json.",
    );
  }

  const headers: Record<string, string> = {};
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  const params = new URLSearchParams({
    pageSize: "50",
    fields: "files(id,name,mimeType,webViewLink,modifiedTime)",
    q: String(cfg.query || "trashed = false"),
  });
  if (apiKey) params.set("key", apiKey);

  const resp = await fetch(
    `https://www.googleapis.com/drive/v3/files?${params.toString()}`,
    { headers, signal: AbortSignal.timeout(20_000) },
  );
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(
      `Google Drive sync failed: HTTP ${resp.status}: ${text.slice(0, 200)}`,
    );
  }

  const data = (await resp.json()) as { files?: any[] };
  let upserts = 0;
  for (const file of data.files || []) {
    const body = await getDriveFileText(file, headers, apiKey);
    const content = [
      `Name: ${file.name || "(untitled)"}`,
      `MIME type: ${file.mimeType || "unknown"}`,
      `Modified: ${file.modifiedTime || "unknown"}`,
      "",
      body,
    ]
      .filter(Boolean)
      .join("\n");
    upsertKnowledgeDocument(
      ctx,
      connector.id,
      `drive:${file.id}`,
      file.name || "(untitled)",
      content,
      file.webViewLink || null,
    );
    upserts++;
  }
  return upserts;
}

async function getDriveFileText(
  file: any,
  headers: Record<string, string>,
  apiKey: string,
): Promise<string> {
  const keySuffix = apiKey ? `&key=${encodeURIComponent(apiKey)}` : "";
  let url = "";
  if (file.mimeType === "application/vnd.google-apps.document") {
    url = `https://www.googleapis.com/drive/v3/files/${file.id}/export?mimeType=text/plain${keySuffix}`;
  } else if (file.mimeType === "application/vnd.google-apps.spreadsheet") {
    url = `https://www.googleapis.com/drive/v3/files/${file.id}/export?mimeType=text/csv${keySuffix}`;
  } else if (
    typeof file.mimeType === "string" &&
    (file.mimeType.startsWith("text/") || file.mimeType === "application/json")
  ) {
    url = `https://www.googleapis.com/drive/v3/files/${file.id}?alt=media${keySuffix}`;
  }
  if (!url) return "Binary or unsupported file type; indexed metadata only.";

  const resp = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(20_000),
  });
  if (!resp.ok)
    return "File content could not be fetched; indexed metadata only.";
  return (await resp.text()).slice(0, 80000);
}

export const searchKnowledgeTool: Tool = {
  name: "search_knowledge",
  description: "Search synced connector documents by keyword.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string" },
      limit: { type: "number" },
    },
    required: ["query"],
  },
  risk: "low",
  async execute(
    input: { query: string; limit?: number },
    ctx: ToolContext,
  ): Promise<ToolResult> {
    const terms = input.query.toLowerCase().split(/\s+/).filter(Boolean);
    const docs = ctx.db
      .query(
        "SELECT d.id, d.title, d.content, d.url, c.name as connector_name FROM knowledge_documents d JOIN knowledge_connectors c ON c.id = d.connector_id ORDER BY d.updated_at DESC LIMIT 300",
      )
      .all() as Array<{
      id: number;
      title: string;
      content: string;
      url: string | null;
      connector_name: string;
    }>;
    const scored = docs
      .map((d) => {
        const hay = `${d.title}\n${d.content}`.toLowerCase();
        const score = terms.filter((t) => hay.includes(t)).length;
        return { ...d, score };
      })
      .filter((d) => d.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, input.limit || 10);

    if (scored.length === 0) return { output: "No matching knowledge found." };
    return {
      output: scored
        .map(
          (d) =>
            `[${d.connector_name}] ${d.title}\n${d.url || ""}\n${d.content.slice(0, 220).replace(/\s+/g, " ")}`,
        )
        .join("\n\n"),
    };
  },
};

export const workflowRecipeTool: Tool = {
  name: "workflow_recipe",
  description: "Create/list/run reusable workflow recipes made of tool steps.",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["create", "list", "run"] },
      recipe_id: { type: "number" },
      name: { type: "string" },
      description: { type: "string" },
      steps_json: {
        type: "string",
        description: 'JSON array of steps: [{"tool":"name","input":{...}}]',
      },
      template: {
        type: "string",
        enum: ["daily_standup_digest", "triage_mentions", "release_checklist"],
        description: "Optional built-in recipe template to create.",
      },
    },
    required: ["action"],
  },
  risk: "medium",
  async execute(input: any, ctx: ToolContext): Promise<ToolResult> {
    if (input.action === "list") {
      const rows = ctx.db
        .query(
          "SELECT id, name, description, enabled, updated_at FROM workflow_recipes WHERE chat_id = ? ORDER BY id DESC",
        )
        .all(ctx.chatId) as Array<{
        id: number;
        name: string;
        description: string | null;
        enabled: number;
        updated_at: string;
      }>;
      if (rows.length === 0) return { output: "No workflow recipes." };
      return {
        output: rows
          .map(
            (r) =>
              `#${r.id} [${r.enabled ? "enabled" : "disabled"}] ${r.name}${r.description ? ` — ${r.description}` : ""}`,
          )
          .join("\n"),
      };
    }

    if (input.action === "create") {
      const templateSteps = input.template
        ? workflowTemplateSteps(input.template)
        : null;
      if (input.template && !templateSteps) {
        return { output: `Unknown template: ${input.template}`, isError: true };
      }
      const stepsJson = input.steps_json || JSON.stringify(templateSteps || []);
      if (!input.name || !stepsJson) {
        return {
          output: "name and steps_json or template are required.",
          isError: true,
        };
      }
      let parsedSteps: Array<{ tool: string; input?: unknown }> = [];
      try {
        parsedSteps = JSON.parse(stepsJson);
      } catch {
        return { output: "steps_json must be valid JSON.", isError: true };
      }
      if (!Array.isArray(parsedSteps) || parsedSteps.length === 0) {
        return {
          output: "steps_json must be a non-empty array.",
          isError: true,
        };
      }
      for (const step of parsedSteps) {
        if (!step || typeof step.tool !== "string") {
          return {
            output: "Each step needs a string tool field.",
            isError: true,
          };
        }
      }
      ctx.db.run(
        `INSERT INTO workflow_recipes (chat_id, name, description, steps_json, enabled, updated_at)
         VALUES (?, ?, ?, ?, 1, datetime('now'))`,
        [ctx.chatId, input.name, input.description || null, stepsJson],
      );
      const id = (
        ctx.db.query("SELECT last_insert_rowid() as id").get() as { id: number }
      ).id;
      return { output: `Workflow recipe #${id} created.` };
    }

    if (input.action !== "run") {
      return { output: `Unknown action: ${input.action}`, isError: true };
    }
    if (!input.recipe_id)
      return { output: "recipe_id is required.", isError: true };
    if (!ctx.registry)
      return { output: "Tool registry not available.", isError: true };

    const recipe = ctx.db
      .query(
        "SELECT id, name, steps_json FROM workflow_recipes WHERE id = ? AND chat_id = ?",
      )
      .get(input.recipe_id, ctx.chatId) as
      | { id: number; name: string; steps_json: string }
      | undefined;
    if (!recipe) return { output: "Recipe not found.", isError: true };

    let steps: Array<{ tool: string; input?: any }> = [];
    try {
      steps = JSON.parse(recipe.steps_json);
    } catch {
      return { output: "Recipe steps are invalid JSON.", isError: true };
    }

    ctx.db.run(
      "INSERT INTO workflow_runs (recipe_id, chat_id, status) VALUES (?, ?, 'running')",
      [recipe.id, ctx.chatId],
    );
    const runId = (
      ctx.db.query("SELECT last_insert_rowid() as id").get() as { id: number }
    ).id;

    const lines: string[] = [];
    for (const step of steps) {
      const result = await ctx.registry.execute(
        step.tool,
        renderRecipeInput(step.input || {}, ctx),
        {
          ...ctx,
        },
      );
      lines.push(
        `[${step.tool}] ${result.isError ? "ERROR" : "OK"}: ${result.output.slice(0, 220)}`,
      );
      if (result.isError) {
        ctx.db.run(
          "UPDATE workflow_runs SET status = 'failed', finished_at = datetime('now'), error_text = ? WHERE id = ?",
          [result.output.slice(0, 2000), runId],
        );
        return {
          output: `Workflow run #${runId} failed.\n${lines.join("\n")}`,
          isError: true,
        };
      }
    }

    ctx.db.run(
      "UPDATE workflow_runs SET status = 'completed', finished_at = datetime('now'), result_summary = ? WHERE id = ?",
      [lines.join("\n").slice(0, 4000), runId],
    );
    return { output: `Workflow run #${runId} completed.\n${lines.join("\n")}` };
  },
};

export const observabilityDashboardTool: Tool = {
  name: "observability_dashboard",
  description: "Show operational metrics and health snapshot.",
  parameters: {
    type: "object",
    properties: {},
  },
  risk: "low",
  async execute(_input: unknown, ctx: ToolContext): Promise<ToolResult> {
    const snap = getObservabilitySnapshot(ctx.db);
    const channelHealth = snap.channelHealth.length
      ? snap.channelHealth
          .map(
            (c) =>
              `${c.channel}: ${c.status}, chats=${c.chats}, errors24h=${c.errors24h}`,
          )
          .join("\n")
      : "No channel activity recorded yet.";
    return {
      output: `Observability (last 24h)
Tokens: input ${snap.usage24h.input}, output ${snap.usage24h.output}, total ${snap.usage24h.total}
Tool calls: ${snap.toolCalls24h} (${snap.toolErrors24h} errors)
Failed scheduled runs: ${snap.failedTasks24h}
Pending confirmations: ${snap.pendingConfirmations}
Active scheduled tasks: ${snap.activeScheduledTasks}
Live runs: ${snap.liveRuns}
Queue depth: ${snap.queueDepth}
Recent failures: ${snap.recentFailures24h}
Channel health:
${channelHealth}`,
    };
  },
};

export const proactiveRuleTool: Tool = {
  name: "proactive_rule",
  description:
    "Create/list/update proactive rules (cron or inactivity triggers).",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["create", "list", "enable", "disable", "delete"],
      },
      id: { type: "number" },
      name: { type: "string" },
      trigger_type: { type: "string", enum: ["cron", "inactivity"] },
      cron: { type: "string" },
      threshold_minutes: { type: "number" },
      message_template: { type: "string" },
      timezone: { type: "string" },
    },
    required: ["action"],
  },
  risk: "medium",
  async execute(input: any, ctx: ToolContext): Promise<ToolResult> {
    if (input.action === "list") {
      const rows = ctx.db
        .query(
          "SELECT id, name, trigger_type, status, next_run_at, threshold_minutes FROM proactive_rules WHERE chat_id = ? ORDER BY id DESC",
        )
        .all(ctx.chatId) as Array<{
        id: number;
        name: string;
        trigger_type: string;
        status: string;
        next_run_at: string | null;
        threshold_minutes: number | null;
      }>;
      if (rows.length === 0) return { output: "No proactive rules." };
      return {
        output: rows
          .map(
            (r) =>
              `#${r.id} [${r.status}] ${r.name} (${r.trigger_type}) next=${r.next_run_at || "n/a"} threshold=${r.threshold_minutes || "n/a"}m`,
          )
          .join("\n"),
      };
    }

    if (input.action === "create") {
      if (!input.name || !input.trigger_type || !input.message_template) {
        return {
          output: "name, trigger_type, and message_template are required.",
          isError: true,
        };
      }
      const triggerType = input.trigger_type as "cron" | "inactivity";
      const threshold =
        typeof input.threshold_minutes === "number"
          ? input.threshold_minutes
          : ctx.config.proactive.inactivity_default_minutes;
      let nextRunAt: string | null = null;
      if (triggerType === "cron") {
        if (!input.cron)
          return { output: "cron is required for cron rules.", isError: true };
        try {
          nextRunAt = getNextCronRun(
            input.cron,
            input.timezone || ctx.config.timezone || "UTC",
          );
        } catch (err: any) {
          return { output: `Invalid cron: ${err.message}`, isError: true };
        }
      }
      ctx.db.run(
        `INSERT INTO proactive_rules
         (chat_id, name, trigger_type, cron_expr, threshold_minutes, message_template, status, next_run_at)
         VALUES (?, ?, ?, ?, ?, ?, 'active', ?)`,
        [
          ctx.chatId,
          input.name,
          triggerType,
          triggerType === "cron" ? input.cron : null,
          triggerType === "inactivity" ? threshold : null,
          input.message_template,
          nextRunAt ? toSqliteDatetime(nextRunAt) : null,
        ],
      );
      return { output: `Proactive rule "${input.name}" created.` };
    }

    if (!input.id) return { output: "id is required.", isError: true };
    if (input.action === "enable" || input.action === "disable") {
      ctx.db.run(
        "UPDATE proactive_rules SET status = ? WHERE id = ? AND chat_id = ?",
        [
          input.action === "enable" ? "active" : "disabled",
          input.id,
          ctx.chatId,
        ],
      );
      return { output: `Rule #${input.id} ${input.action}d.` };
    }
    if (input.action === "delete") {
      ctx.db.run("DELETE FROM proactive_rules WHERE id = ? AND chat_id = ?", [
        input.id,
        ctx.chatId,
      ]);
      return { output: `Rule #${input.id} deleted.` };
    }
    return { output: `Unknown action: ${input.action}`, isError: true };
  },
};

export const pinMemoryTool: Tool = {
  name: "pin_memory",
  description:
    "Pin a memory as source-of-truth so it resists aging and contradiction replacement.",
  parameters: {
    type: "object",
    properties: {
      id: { type: "number" },
      source_of_truth: { type: "string" },
    },
    required: ["id"],
  },
  risk: "low",
  async execute(
    input: { id: number; source_of_truth?: string },
    ctx: ToolContext,
  ): Promise<ToolResult> {
    ctx.db.run(
      "UPDATE memories SET pinned = 1, source_of_truth = ?, updated_at = datetime('now') WHERE id = ?",
      [input.source_of_truth || "manual", input.id],
    );
    return { output: `Memory #${input.id} pinned.` };
  },
};

export const memoryQualityReportTool: Tool = {
  name: "memory_quality_report",
  description:
    "Report memory aging and potential contradictions for the current chat.",
  parameters: {
    type: "object",
    properties: {
      limit: { type: "number" },
    },
  },
  risk: "low",
  async execute(
    input: { limit?: number },
    ctx: ToolContext,
  ): Promise<ToolResult> {
    const rows = ctx.db
      .query(
        `SELECT id, content, confidence, pinned, source_of_truth, contradiction_key, decay_half_life_days, updated_at
         FROM memories
         WHERE (chat_id = ? OR chat_id IS NULL) AND is_archived = 0
         ORDER BY updated_at DESC
         LIMIT ?`,
      )
      .all(ctx.chatId, input.limit || 40) as Array<{
      id: number;
      content: string;
      confidence: number;
      pinned: number;
      source_of_truth: string | null;
      contradiction_key: string | null;
      decay_half_life_days: number | null;
      updated_at: string;
    }>;
    if (rows.length === 0) return { output: "No memories to analyze." };

    const now = Date.now();
    const contradictionCounts = new Map<string, number>();
    for (const row of rows) {
      if (!row.contradiction_key) continue;
      contradictionCounts.set(
        row.contradiction_key,
        (contradictionCounts.get(row.contradiction_key) || 0) + 1,
      );
    }

    const lines = rows.map((m) => {
      const ageDays = Math.max(
        0,
        (now - new Date(m.updated_at).getTime()) / (1000 * 60 * 60 * 24),
      );
      const halfLife =
        m.decay_half_life_days ||
        ctx.config.memory_quality.decay_half_life_days;
      const decay = m.pinned ? 1 : 0.5 ** (ageDays / Math.max(1, halfLife));
      const effective = (m.confidence || 0.5) * decay;
      const contradictionFlag =
        m.contradiction_key &&
        (contradictionCounts.get(m.contradiction_key) || 0) > 1
          ? " ⚠ contradiction-group"
          : "";
      return `#${m.id} eff=${effective.toFixed(3)} conf=${(m.confidence || 0).toFixed(2)} age=${ageDays.toFixed(1)}d${m.pinned ? " pinned" : ""}${m.source_of_truth ? ` source=${m.source_of_truth}` : ""}${contradictionFlag}\n${m.content.slice(0, 180)}`;
    });

    return { output: lines.join("\n\n") };
  },
};

export const setBudgetTool: Tool = {
  name: "set_daily_budget",
  description:
    "Update runtime daily token budget guardrails without editing config files manually.",
  parameters: {
    type: "object",
    properties: {
      enabled: { type: "boolean" },
      max_total_tokens: { type: "number" },
      max_input_tokens: { type: "number" },
      max_output_tokens: { type: "number" },
      enforce_per_chat: { type: "boolean" },
    },
  },
  risk: "medium",
  async execute(
    input: {
      enabled?: boolean;
      max_total_tokens?: number;
      max_input_tokens?: number;
      max_output_tokens?: number;
      enforce_per_chat?: boolean;
    },
    ctx: ToolContext,
  ): Promise<ToolResult> {
    if (input.enabled !== undefined)
      ctx.config.daily_budget.enabled = input.enabled;
    if (input.max_total_tokens !== undefined) {
      ctx.config.daily_budget.max_total_tokens = input.max_total_tokens;
    }
    if (input.max_input_tokens !== undefined) {
      ctx.config.daily_budget.max_input_tokens = input.max_input_tokens;
    }
    if (input.max_output_tokens !== undefined) {
      ctx.config.daily_budget.max_output_tokens = input.max_output_tokens;
    }
    if (input.enforce_per_chat !== undefined) {
      ctx.config.daily_budget.enforce_per_chat = input.enforce_per_chat;
    }

    logSystemEvent(
      ctx.db,
      "budget_config_updated",
      "info",
      JSON.stringify(ctx.config.daily_budget),
      ctx.channel,
    );

    return {
      output: `Daily budget updated: enabled=${ctx.config.daily_budget.enabled}, total=${ctx.config.daily_budget.max_total_tokens}, input=${ctx.config.daily_budget.max_input_tokens}, output=${ctx.config.daily_budget.max_output_tokens}, per_chat=${ctx.config.daily_budget.enforce_per_chat}`,
    };
  },
};

export const advancedTools: Tool[] = [
  createGoalProjectTool,
  listGoalsTool,
  advanceGoalTaskTool,
  goalNextActionsTool,
  manageExecutionPolicyTool,
  connectorTool,
  searchKnowledgeTool,
  workflowRecipeTool,
  observabilityDashboardTool,
  proactiveRuleTool,
  pinMemoryTool,
  memoryQualityReportTool,
  setBudgetTool,
];
