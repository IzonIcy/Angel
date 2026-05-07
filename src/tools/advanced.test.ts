import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { DEFAULTS } from "../config";
import { getDb, upsertChat } from "../db";
import { createGoalProjectTool, goalNextActionsTool } from "./advanced";
import { type Tool, type ToolContext, ToolRegistry } from "./registry";

let ctx: ToolContext;

beforeAll(() => {
  const dataDir = mkdtempSync(join(tmpdir(), "angel-advanced-test-"));
  const db = getDb(dataDir);
  const chatId = upsertChat(db, "test", "advanced-test-chat", "test");
  ctx = {
    chatId,
    channel: "test",
    workingDir: dataDir,
    db,
    config: { ...DEFAULTS, data_dir: dataDir, working_dir: dataDir },
  };
});

describe("goal projects", () => {
  test("auto-creates a dependency graph when tasks are omitted", async () => {
    const result = await createGoalProjectTool.execute(
      { name: "Launch demo", outcome: "launch the demo" },
      ctx,
    );

    expect(result.isError).toBeFalsy();
    const goalId = Number(result.output.match(/Goal #(\d+)/)?.[1]);
    expect(goalId).toBeGreaterThan(0);

    const tasks = ctx.db
      .query(
        "SELECT id, dependency_task_ids FROM goal_tasks WHERE goal_id = ? ORDER BY checkpoint_order ASC",
      )
      .all(goalId) as Array<{ id: number; dependency_task_ids: string }>;

    expect(tasks).toHaveLength(5);
    expect(JSON.parse(tasks[1].dependency_task_ids)).toEqual([tasks[0].id]);

    const next = await goalNextActionsTool.execute({ goal_id: goalId }, ctx);
    expect(next.output).toContain(`#${tasks[0].id}`);
  });
});

describe("execution policies", () => {
  test("confirmed executions can bypass the policy that required approval", async () => {
    const registry = new ToolRegistry();
    const dangerousTool: Tool = {
      name: "dangerous_test_tool",
      description: "Test high-risk tool",
      parameters: { type: "object", properties: {} },
      risk: "high",
      async execute() {
        return { output: "executed" };
      },
    };
    registry.register(dangerousTool);

    ctx.db.run(
      `INSERT INTO execution_policies (name, type, action, risk_level)
       VALUES ('require high-risk confirmation', 'approval', 'require_confirmation', 'high')`,
    );

    const blocked = await registry.execute("dangerous_test_tool", {}, ctx);
    expect(blocked.isError).toBe(true);
    expect(blocked.output).toContain("Confirmation required");

    const approved = await registry.execute(
      "dangerous_test_tool",
      {},
      {
        ...ctx,
        skipPolicy: true,
      },
    );
    expect(approved.isError).toBeFalsy();
    expect(approved.output).toBe("executed");
  });
});
