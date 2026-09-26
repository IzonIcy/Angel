/**
 * Unit tests for policy evaluation logic
 *
 * Ported from Angel's src/tools/policy.test.ts
 */

import { describe, expect, test, beforeAll } from "bun:test";
import { MemoryPolicyStore } from "../src/store/memory";
import { evaluatePolicy } from "../src/evaluation";
import { isDirectChat } from "../src/utils";
import type { PolicyRule, Tool, PolicyContext } from "../src/types";

const highRiskTool: Tool = { name: "bash_test", risk: "high", description: "test" };
const lowRiskTool: Tool = { name: "web_search_test", risk: "low", description: "test" };

function makeContext(overrides: Partial<PolicyContext> = {}): PolicyContext {
  return {
    channel: "test",
    actorId: "user123",
    workingDir: "/tmp",
    ...overrides,
  };
}

function makeRule(overrides: Partial<PolicyRule> = {}): PolicyRule {
  const now = new Date().toISOString();
  return {
    id: `test-${Date.now()}-${Math.random()}`,
    name: "test-rule",
    type: "permission",
    action: "allow",
    enabled: true,
    toolName: null,
    riskLevel: null,
    channel: null,
    actorId: null,
    pathPattern: null,
    domainPattern: null,
    note: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("evaluatePolicy - core logic", () => {
  test("empty ruleset allows high-risk tools in direct chats", () => {
    const decision = evaluatePolicy(
      [],
      highRiskTool,
      {},
      makeContext({ channel: "discord_dm" }),
    );
    expect(decision.allowed).toBe(true);
    expect(decision.requireConfirmation).toBe(false);
  });

  test("signal_private counts as a direct chat", () => {
    const decision = evaluatePolicy(
      [],
      highRiskTool,
      {},
      makeContext({ channel: "signal_private" }),
    );
    expect(decision.allowed).toBe(true);
  });

  test("empty ruleset requires confirmation for high-risk tools in group chats", () => {
    const decision = evaluatePolicy(
      [],
      highRiskTool,
      {},
      makeContext({ channel: "discord_guild" }),
    );
    expect(decision.allowed).toBe(false);
    expect(decision.requireConfirmation).toBe(true);
  });

  test("slack channels are treated as multi-party", () => {
    const decision = evaluatePolicy(
      [],
      highRiskTool,
      {},
      makeContext({ channel: "slack_channel" }),
    );
    expect(decision.allowed).toBe(false);
  });

  test("low-risk tools are unaffected by the fail-safe", () => {
    const decision = evaluatePolicy(
      [],
      lowRiskTool,
      {},
      makeContext({ channel: "discord_guild" }),
    );
    expect(decision.allowed).toBe(true);
  });

  test("explicit deny rule blocks high-risk tool", () => {
    const rules = [makeRule({ action: "deny", toolName: "bash_test", name: "deny-bash" })];
    const decision = evaluatePolicy(rules, highRiskTool, {}, makeContext({ channel: "discord_guild" }));
    expect(decision.allowed).toBe(false);
    expect(decision.requireConfirmation).toBe(false);
    expect(decision.reason).toContain("deny-bash");
  });

  test("explicit allow rule permits high-risk tool", () => {
    const rules = [makeRule({ action: "allow", toolName: "bash_test", name: "allow-bash" })];
    const decision = evaluatePolicy(rules, highRiskTool, {}, makeContext({ channel: "discord_guild" }));
    expect(decision.allowed).toBe(true);
    expect(decision.requireConfirmation).toBe(false);
  });

  test("require_confirmation rule requires confirmation", () => {
    const rules = [makeRule({ action: "require_confirmation", toolName: "bash_test", name: "confirm-bash" })];
    const decision = evaluatePolicy(rules, highRiskTool, {}, makeContext({ channel: "discord_guild" }));
    expect(decision.allowed).toBe(false);
    expect(decision.requireConfirmation).toBe(true);
    expect(decision.reason).toContain("confirm-bash");
  });

  test("satisfied confirmation allows require_confirmation rule", () => {
    const rules = [makeRule({ action: "require_confirmation", toolName: "bash_test", name: "confirm-bash" })];
    const decision = evaluatePolicy(
      rules,
      highRiskTool,
      {},
      makeContext({ channel: "discord_guild" }),
      { confirmationSatisfied: true },
    );
    expect(decision.allowed).toBe(true);
    expect(decision.requireConfirmation).toBe(false);
  });

  test("deny rule shadows older allow rule (recency precedence)", () => {
    // Newer deny (first in array) should win over older allow
    const rules = [
      makeRule({ action: "deny", toolName: "bash_test", name: "deny-bash", id: "2-newer" }),
      makeRule({ action: "allow", toolName: "bash_test", name: "allow-bash", id: "1-older" }),
    ];
    const decision = evaluatePolicy(rules, highRiskTool, {}, makeContext({ channel: "discord_guild" }));
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("deny-bash");
  });

  test("allow rule shadows older deny rule (recency precedence)", () => {
    // Newer allow (first in array) should win over older deny
    const rules = [
      makeRule({ action: "allow", toolName: "bash_test", name: "allow-bash", id: "2-newer" }),
      makeRule({ action: "deny", toolName: "bash_test", name: "deny-bash", id: "1-older" }),
    ];
    const decision = evaluatePolicy(rules, highRiskTool, {}, makeContext({ channel: "discord_guild" }));
    expect(decision.allowed).toBe(true);
  });

  test("require_confirmation continues scanning for deny", () => {
    const rules = [
      makeRule({ action: "require_confirmation", toolName: "bash_test", name: "confirm-bash", id: "2-newer" }),
      makeRule({ action: "deny", toolName: "bash_test", name: "deny-bash", id: "1-older" }),
    ];
    const decision = evaluatePolicy(rules, highRiskTool, {}, makeContext({ channel: "discord_guild" }));
    expect(decision.allowed).toBe(false);
    expect(decision.requireConfirmation).toBe(false);
    expect(decision.reason).toContain("deny-bash");
  });

  test("path pattern matches file tool input", () => {
    const rules = [makeRule({ action: "deny", toolName: "read_file", pathPattern: "*/secrets/*", name: "deny-secrets" })];
    const decision = evaluatePolicy(
      rules,
      { name: "read_file", risk: "low" },
      { path: "/home/user/secrets/api.key" },
      makeContext(),
    );
    expect(decision.allowed).toBe(false);
  });

  test("path pattern non-match allows", () => {
    const rules = [makeRule({ action: "deny", toolName: "read_file", pathPattern: "*/secrets/*", name: "deny-secrets" })];
    const decision = evaluatePolicy(
      rules,
      { name: "read_file", risk: "low" },
      { path: "/home/user/config.json" },
      makeContext(),
    );
    expect(decision.allowed).toBe(true);
  });

  test("domain pattern matches web_fetch input", () => {
    const rules = [makeRule({ action: "deny", toolName: "web_fetch", domainPattern: "evil.com", name: "deny-evil" })];
    const decision = evaluatePolicy(
      rules,
      { name: "web_fetch", risk: "medium" },
      { url: "https://evil.com/steal" },
      makeContext(),
    );
    expect(decision.allowed).toBe(false);
  });

  test("channel pattern matches specific channel", () => {
    const rules = [makeRule({ action: "deny", channel: "discord_guild", name: "deny-guild" })];
    const decision = evaluatePolicy(rules, highRiskTool, {}, makeContext({ channel: "discord_guild" }));
    expect(decision.allowed).toBe(false);
  });

  test("actor pattern matches specific actor", () => {
    const rules = [makeRule({ action: "deny", actorId: "bad-actor", name: "deny-bad" })];
    const decision = evaluatePolicy(rules, highRiskTool, {}, makeContext({ actorId: "bad-actor" }));
    expect(decision.allowed).toBe(false);
  });

  test("disabled rules are skipped", () => {
    const rules = [makeRule({ action: "deny", toolName: "bash_test", name: "deny-bash", enabled: false })];
    const decision = evaluatePolicy(rules, highRiskTool, {}, makeContext({ channel: "discord_guild" }));
    // Disabled rule is skipped, so fail-safe applies: high-risk + non-direct = require confirmation
    expect(decision.allowed).toBe(false);
    expect(decision.requireConfirmation).toBe(true);
  });

  test("wildcard tool name matches multiple tools", () => {
    const rules = [makeRule({ action: "deny", toolName: "bash_*", name: "deny-all-bash" })];
    const decision = evaluatePolicy(
      rules,
      { name: "bash_exec", risk: "high" },
      {},
      makeContext({ channel: "discord_guild" }),
    );
    expect(decision.allowed).toBe(false);
  });

  test("comma-separated patterns match any", () => {
    const rules = [makeRule({ action: "deny", toolName: "bash_test,web_fetch", name: "deny-two" })];
    const decision1 = evaluatePolicy(rules, highRiskTool, {}, makeContext({ channel: "discord_guild" }));
    expect(decision1.allowed).toBe(false);

    const decision2 = evaluatePolicy(
      rules,
      { name: "web_fetch", risk: "medium" },
      {},
      makeContext({ channel: "discord_guild" }),
    );
    expect(decision2.allowed).toBe(false);
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
    expect(isDirectChat("")).toBe(false);
  });
});

describe("MemoryPolicyStore", () => {
  let store: MemoryPolicyStore;

  beforeAll(() => {
    store = new MemoryPolicyStore();
  });

  test("create and list enabled", async () => {
    await store.create({ name: "rule1", type: "permission", action: "allow" });
    await store.create({ name: "rule2", type: "approval", action: "deny", enabled: false });
    const enabled = await store.listEnabled();
    expect(enabled.length).toBe(1);
    expect(enabled[0].name).toBe("rule1");
  });

  test("getById returns rule", async () => {
    const created = await store.create({ name: "rule1", type: "permission", action: "allow" });
    const found = await store.getById(created.id);
    expect(found).not.toBeNull();
    expect(found!.name).toBe("rule1");
  });

  test("update modifies rule", async () => {
    const created = await store.create({ name: "rule1", type: "permission", action: "allow" });
    await new Promise(r => setTimeout(r, 50)); // ensure timestamp changes
    const updated = await store.update(created.id, { action: "deny", name: "rule1-updated" });
    expect(updated.action).toBe("deny");
    expect(updated.name).toBe("rule1-updated");
    expect(updated.updatedAt).not.toBe(created.updatedAt);
  });

  test("delete removes rule", async () => {
    const created = await store.create({ name: "rule1", type: "permission", action: "allow" });
    await store.delete(created.id);
    const found = await store.getById(created.id);
    expect(found).toBeNull();
  });
});