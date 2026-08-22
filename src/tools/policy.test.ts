import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { DEFAULTS } from "../config";
import { getDb, upsertChat } from "../db";
import { evaluateExecutionPolicy, isDirectChat } from "../policy";
import { sanitizedEnv, scrubSecrets } from "../secrets";
import type { ToolContext } from "./registry";

let ctx: ToolContext;

beforeAll(() => {
  const dataDir = mkdtempSync(join(tmpdir(), "angel-policy-test-"));
  const db = getDb(dataDir);
  const chatId = upsertChat(db, "test", "policy-test-chat", "test");
  ctx = {
    chatId,
    channel: "test",
    workingDir: dataDir,
    db,
    config: { ...DEFAULTS, data_dir: dataDir },
  };
});

const highRiskTool = {
  name: "bash_test",
  risk: "high" as const,
};

describe("execution policy fail-safe", () => {
  test("empty ruleset allows high-risk tools in direct chats (owner DMs)", () => {
    const decision = evaluateExecutionPolicy(
      highRiskTool as any,
      {},
      { ...ctx, channel: "discord_dm" },
    );
    // Owner DM behavior is unchanged from pre-fail-safe releases.
    expect(decision.allowed).toBe(true);
    expect(decision.requireConfirmation).toBe(false);
  });

  test("signal_private counts as a direct chat", () => {
    const decision = evaluateExecutionPolicy(
      highRiskTool as any,
      {},
      { ...ctx, channel: "signal_private" },
    );
    expect(decision.allowed).toBe(true);
  });

  test("empty ruleset requires confirmation for high-risk tools in group chats", () => {
    const decision = evaluateExecutionPolicy(
      highRiskTool as any,
      {},
      { ...ctx, channel: "discord_guild" },
    );
    expect(decision.allowed).toBe(false);
    expect(decision.requireConfirmation).toBe(true);
  });

  test("slack channels are treated as multi-party", () => {
    const decision = evaluateExecutionPolicy(
      highRiskTool as any,
      {},
      { ...ctx, channel: "slack_channel" },
    );
    expect(decision.allowed).toBe(false);
  });

  test("low-risk tools are unaffected by the fail-safe", () => {
    const decision = evaluateExecutionPolicy(
      { name: "web_search_test", risk: "low" } as any,
      {},
      { ...ctx, channel: "discord_guild" },
    );
    expect(decision.allowed).toBe(true);
  });
});

describe("isDirectChat", () => {
  test("matches dm and private suffixes", () => {
    expect(isDirectChat("discord_dm")).toBe(true);
    expect(isDirectChat("signal_private")).toBe(true);
    expect(isDirectChat("telegram_private")).toBe(true);
    expect(isDirectChat("imessage_private")).toBe(true);
  });

  test("rejects group-style channels and undefined", () => {
    expect(isDirectChat("discord_guild")).toBe(false);
    expect(isDirectChat("slack_channel")).toBe(false);
    expect(isDirectChat(undefined)).toBe(false);
  });
});

describe("sanitizedEnv", () => {
  test("strips credential-shaped variables", () => {
    process.env.TEST_ANTHROPIC_API_KEY = "sk-ant-secret";
    process.env.TEST_DISCORD_TOKEN = "tok";
    process.env.AWS_ACCESS_KEY_ID = "AKIA...";
    process.env.SENTRY_DSN = "https://dsn";

    const env = sanitizedEnv();
    expect(env.TEST_ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.TEST_DISCORD_TOKEN).toBeUndefined();
    expect(env.AWS_ACCESS_KEY_ID).toBeUndefined();
    expect(env.SENTRY_DSN).toBeUndefined();

    for (const k of [
      "TEST_ANTHROPIC_API_KEY",
      "TEST_DISCORD_TOKEN",
      "AWS_ACCESS_KEY_ID",
      "SENTRY_DSN",
    ]) {
      delete process.env[k];
    }
  });

  test("keeps benign variables needed by spawned tools", () => {
    process.env.TEST_JUST_A_PATH = "/usr/bin";
    const env = sanitizedEnv();
    expect(env.TEST_JUST_A_PATH).toBe("/usr/bin");
    delete process.env.TEST_JUST_A_PATH;
  });
});

describe("scrubSecrets regression shapes", () => {
  test("redacts real Anthropic/OpenAI key shapes (not just sk-+alnum)", () => {
    const out = scrubSecrets(
      "key=sk-ant-api03-abcdef0123456789ABCDEF0123456789 & proj key=sk-proj-abc123_-456789abcdef012345",
    );
    expect(out).not.toContain("sk-ant-api03");
    expect(out).not.toContain("sk-proj");
  });

  test("redacts github fine-grained PATs and AWS access keys", () => {
    const out = scrubSecrets(
      "pat=github_pat_11AAAAAAA0abcdefghijklmnopqrstuv key=AKIAIOSFODNN7EXAMPLE",
    );
    expect(out).not.toContain("github_pat_");
    expect(out).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });
});
