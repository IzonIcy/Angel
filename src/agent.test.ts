import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { INTERRUPTED, processMessage } from "./agent";
import { type AngelConfig, DEFAULTS } from "./config";
import { getDb, upsertChat } from "./db";
import { type Tool, ToolRegistry } from "./tools/registry";

// Stub out the LLM provider so the agent loop runs without credentials or
// network. agent.ts only consumes `chatComplete` at runtime from "./llm".
const chatComplete = mock<typeof import("./llm")["chatComplete"]>();
mock.module("./llm", () => ({ chatComplete }));

function makeConfig(): AngelConfig {
  const dataDir = mkdtempSync(join(tmpdir(), "angel-agent-test-"));
  return {
    ...DEFAULTS,
    openai_api_key: "test-key",
    model: "claude-test",
    timezone: "UTC",
    data_dir: dataDir,
    working_dir: join(dataDir, "work"),
    working_dir_isolation: "none",
  };
}

function makeRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  const echoTool: Tool = {
    name: "echo",
    description: "Echo the requested text back.",
    parameters: { type: "object", properties: { text: { type: "string" } } },
    risk: "low",
    async execute(input: { text: string }) {
      return { output: `echo: ${input.text}`, isError: false };
    },
  };
  registry.register(echoTool);
  return registry;
}

let db: Database;
let config: AngelConfig;
let chatId: number;

beforeEach(() => {
  config = makeConfig();
  db = getDb(config.data_dir);
  chatId = upsertChat(db, "test", "external-chat-1", "test_dm", "Tester");
  // Clear call history from the previous test, then apply the default behavior.
  chatComplete.mockReset();
  chatComplete.mockImplementation(async () => ({
    text: "All set.",
    toolCalls: [],
    finishReason: "stop",
    usage: { inputTokens: 10, outputTokens: 5 },
  }));
});

describe("processMessage", () => {
  test("runs a tool call then returns the final response", async () => {
    chatComplete.mockImplementationOnce(async () => ({
      text: "",
      toolCalls: [
        {
          id: "call_1",
          name: "echo",
          arguments: JSON.stringify({ text: "hello" }),
        },
      ],
      finishReason: "tool_calls",
      usage: { inputTokens: 5, outputTokens: 2 },
    }));

    const result = await processMessage("say hello", {
      chatId,
      channel: "test",
      db,
      config,
      registry: makeRegistry(),
    });

    expect(result).toBe("All set.");

    // The tool actually ran (logged by the registry).
    const toolLogs = db
      .query("SELECT tool_name, success FROM tool_execution_logs")
      .all() as Array<{ tool_name: string; success: number }>;
    expect(toolLogs).toContainEqual({ tool_name: "echo", success: 1 });

    // User message + assistant response both persisted.
    const rows = db
      .query(
        "SELECT role, content FROM messages WHERE chat_id = ? ORDER BY rowid",
      )
      .all(chatId) as Array<{ role: string; content: string }>;
    expect(rows.map((r) => r.role)).toEqual(["user", "assistant"]);
    expect(rows[1].content).toBe("All set.");
  });

  test("blocks on the daily budget before calling the LLM", async () => {
    config.daily_budget = {
      enabled: true,
      max_total_tokens: 0,
      max_input_tokens: 0,
      max_output_tokens: 0,
      enforce_per_chat: false,
    };

    const result = await processMessage("do the thing", {
      chatId,
      channel: "test",
      db,
      config,
      registry: makeRegistry(),
    });

    expect(result).toContain("can't continue");
    expect(chatComplete).not.toHaveBeenCalled();

    const event = db
      .query(
        "SELECT event_type FROM system_events WHERE event_type = 'budget_guardrail_block'",
      )
      .get() as { event_type: string } | null;
    expect(event?.event_type).toBe("budget_guardrail_block");
  });

  test("returns INTERRUPTED and persists the session when aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const registry = makeRegistry();

    const result = await processMessage("hello", {
      chatId,
      channel: "test",
      db,
      config,
      registry,
      signal: controller.signal,
    });

    expect(result).toBe(INTERRUPTED);
    const session = db
      .query("SELECT messages_json FROM sessions WHERE chat_id = ?")
      .get(chatId) as { messages_json: string } | null;
    expect(session?.messages_json).toBeTruthy();
  });
});
