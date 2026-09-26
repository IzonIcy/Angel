/**
 * Property-based tests for policy engine invariants
 *
 * Uses fast-check to verify core policy engine invariants.
 */

import { describe, expect, test } from "bun:test";
import * as fc from "fast-check";
import { evaluatePolicy } from "../src/evaluation";
import type { PolicyRule, Tool, PolicyContext } from "../src/types";

// --- Helpers ---

function makeRule(overrides: Partial<PolicyRule> = {}): PolicyRule {
  const now = new Date().toISOString();
  return {
    id: `test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

function makeContext(overrides: Partial<PolicyContext> = {}): PolicyContext {
  return {
    channel: "test",
    actorId: "user123",
    workingDir: "/tmp",
    ...overrides,
  };
}

// --- Property Tests ---

describe("Property: Deny always wins when matching", () => {
  test("if a deny rule matches, decision is denied", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("bash", "read_file", "web_fetch"),
        fc.constantFrom("discord_guild", "slack_channel", "discord_dm"),
        (toolName, channel) => {
          const tool: Tool = { name: toolName, risk: "high", description: "test" };
          const context = makeContext({ channel });

          // Deny rule that matches
          const denyRule = makeRule({
            action: "deny",
            toolName: toolName,
            riskLevel: "high",
          });

          const decision = evaluatePolicy([denyRule], tool, {}, context);
          expect(decision.allowed).toBe(false);
          expect(decision.requireConfirmation).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });

  test("deny rule shadows older allow rule", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("bash", "read_file", "web_fetch"),
        fc.constantFrom("discord_guild", "slack_channel"),
        (toolName, channel) => {
          const tool: Tool = { name: toolName, risk: "high", description: "test" };
          const context = makeContext({ channel });

          // Older allow (second in array)
          const allowRule = makeRule({
            id: "1-older-allow",
            action: "allow",
            toolName: toolName,
            riskLevel: "high",
          });

          // Newer deny (first in array = higher recency)
          const denyRule = makeRule({
            id: "2-newer-deny",
            action: "deny",
            toolName: toolName,
            riskLevel: "high",
          });

          const decision = evaluatePolicy([denyRule, allowRule], tool, {}, context);
          expect(decision.allowed).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe("Property: Allow shadows older deny (recency precedence)", () => {
  test("newer allow rule beats older deny when both match", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("bash", "read_file", "web_fetch"),
        fc.constantFrom("discord_guild", "slack_channel"),
        (toolName, channel) => {
          const tool: Tool = { name: toolName, risk: "high", description: "test" };
          const context = makeContext({ channel });

          // Newer allow (first in array)
          const allowRule = makeRule({
            id: "2-newer-allow",
            action: "allow",
            toolName: toolName,
            riskLevel: "high",
          });

          // Older deny (second in array)
          const denyRule = makeRule({
            id: "1-older-deny",
            action: "deny",
            toolName: toolName,
            riskLevel: "high",
          });

          const decision = evaluatePolicy([allowRule, denyRule], tool, {}, context);
          expect(decision.allowed).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe("Property: Confirmation flow", () => {
  test("require_confirmation without confirmationSatisfied requires confirmation", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("bash", "read_file", "web_fetch"),
        fc.constantFrom("discord_guild", "slack_channel"),
        (toolName, channel) => {
          const tool: Tool = { name: toolName, risk: "high", description: "test" };
          const context = makeContext({ channel });

          const rule = makeRule({
            action: "require_confirmation",
            toolName: toolName,
            riskLevel: "high",
          });

          const decision = evaluatePolicy([rule], tool, {}, context);
          expect(decision.allowed).toBe(false);
          expect(decision.requireConfirmation).toBe(true);
        },
      ),
      { numRuns: 50 },
    );
  });

  test("require_confirmation with confirmationSatisfied allows", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("bash", "read_file", "web_fetch"),
        fc.constantFrom("discord_guild", "slack_channel"),
        (toolName, channel) => {
          const tool: Tool = { name: toolName, risk: "high", description: "test" };
          const context = makeContext({ channel });

          const rule = makeRule({
            action: "require_confirmation",
            toolName: toolName,
            riskLevel: "high",
          });

          const decision = evaluatePolicy([rule], tool, {}, context, { confirmationSatisfied: true });
          expect(decision.allowed).toBe(true);
          expect(decision.requireConfirmation).toBe(false);
        },
      ),
      { numRuns: 50 },
    );
  });

  test("confirmationSatisfied does not skip deny rules further down", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("bash", "read_file", "web_fetch"),
        fc.constantFrom("discord_guild", "slack_channel"),
        (toolName, channel) => {
          const tool: Tool = { name: toolName, risk: "high", description: "test" };
          const context = makeContext({ channel });

          const confirmRule = makeRule({
            id: "2-confirm",
            action: "require_confirmation",
            toolName: toolName,
            riskLevel: "high",
          });
          const denyRule = makeRule({
            id: "1-deny",
            action: "deny",
            toolName: toolName,
            riskLevel: "high",
          });

          const decision = evaluatePolicy([confirmRule, denyRule], tool, {}, context, { confirmationSatisfied: true });
          expect(decision.allowed).toBe(false);
          expect(decision.requireConfirmation).toBe(false);
        },
      ),
      { numRuns: 50 },
    );
  });
});

describe("Property: Fail-safe for high-risk tools in non-direct chats", () => {
  test("empty ruleset + high-risk + non-direct = require confirmation", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("discord_guild", "slack_channel", "slack_group"),
        (channel) => {
          const decision = evaluatePolicy(
            [],
            { name: "bash", risk: "high", description: "test" },
            {},
            makeContext({ channel }),
          );
          expect(decision.allowed).toBe(false);
          expect(decision.requireConfirmation).toBe(true);
        },
      ),
      { numRuns: 50 },
    );
  });

  test("empty ruleset + high-risk + direct = allowed", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("discord_dm", "signal_private", "telegram_private", "imessage_dm"),
        (channel) => {
          const decision = evaluatePolicy(
            [],
            { name: "bash", risk: "high", description: "test" },
            {},
            makeContext({ channel }),
          );
          expect(decision.allowed).toBe(true);
          expect(decision.requireConfirmation).toBe(false);
        },
      ),
      { numRuns: 50 },
    );
  });

  test("empty ruleset + low/medium risk = allowed regardless of channel", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("low", "medium"),
        fc.constantFrom("discord_guild", "slack_channel", "discord_dm", "signal_private"),
        (risk, channel) => {
          const decision = evaluatePolicy(
            [],
            { name: "web_search", risk, description: "test" },
            {},
            makeContext({ channel }),
          );
          expect(decision.allowed).toBe(true);
        },
      ),
      { numRuns: 50 },
    );
  });
});

describe("Property: Path and domain scoping", () => {
  test("path pattern only matches when tool provides matching path", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.constant("read_file"),
          fc.constant("write_file"),
          fc.constant("edit_file"),
        ),
        fc.oneof(
          fc.constant("*/secrets/*"),
          fc.constant("*/config/*"),
          fc.constant("*.key"),
          fc.constant("*"),
        ),
        fc.string({ minLength: 1, maxLength: 50 }),
        (toolName, pathPattern, actualPath) => {
          const rule = makeRule({
            action: "deny",
            toolName,
            riskLevel: "low",
            pathPattern,
          });

          // Convert wildcard pattern to regex for expected behavior
          const escaped = pathPattern
            .split("*")
            .map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
            .join(".*");
          const regex = new RegExp(`^${escaped}$`, "i");
          const shouldMatch = regex.test(actualPath);

          const decision = evaluatePolicy(
            [rule],
            { name: toolName, risk: "low" },
            { path: actualPath },
            makeContext(),
          );

          if (shouldMatch) {
            expect(decision.allowed).toBe(false);
          } else {
            expect(decision.allowed).toBe(true);
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  test("domain pattern only matches when web_fetch provides matching domain", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.constant("evil.com"),
          fc.constant("*.malicious.*"),
          fc.constant("*.com"),
          fc.constant("*"),
        ),
        fc.webUrl(),
        (domainPattern, url) => {
          const rule = makeRule({
            action: "deny",
            toolName: "web_fetch",
            riskLevel: "medium",
            domainPattern,
          });

          const hostname = new URL(url).hostname;
          const escaped = domainPattern
            .split("*")
            .map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
            .join(".*");
          const regex = new RegExp(`^${escaped}$`, "i");
          const shouldMatch = regex.test(hostname);

          const decision = evaluatePolicy(
            [rule],
            { name: "web_fetch", risk: "medium" },
            { url },
            makeContext(),
          );

          if (shouldMatch) {
            expect(decision.allowed).toBe(false);
          } else {
            expect(decision.allowed).toBe(true);
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe("Property: Recency ordering", () => {
  test("rules evaluated in array order (newest first)", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            action: fc.constantFrom("allow", "deny"),
            name: fc.string({ minLength: 1, maxLength: 10 }),
          }),
          { minLength: 2, maxLength: 4 },
        ),
        fc.constantFrom("bash", "read_file", "web_fetch"),
        (partialRules, toolName) => {
          const tool: Tool = { name: toolName, risk: "high", description: "test" };
          const context = makeContext({ channel: "discord_guild" });

          const rules = partialRules.map((r, i) => makeRule({
            id: `${10 - i}-rule`,
            action: r.action,
            name: r.name,
            toolName: toolName,
            riskLevel: "high",
          }));

          // Find first matching rule that isn't require_confirmation
          const firstMatch = rules.find(r => r.action !== "require_confirmation");
          const decision = evaluatePolicy(rules, tool, {}, context);

          if (firstMatch) {
            if (firstMatch.action === "deny") {
              expect(decision.allowed).toBe(false);
              expect(decision.requireConfirmation).toBe(false);
            } else if (firstMatch.action === "allow") {
              expect(decision.allowed).toBe(true);
            }
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe("Property: Wildcard matching", () => {
  test("wildcard * matches any substring", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 10 }),
        fc.string({ minLength: 1, maxLength: 10 }),
        fc.string({ minLength: 1, maxLength: 10 }),
        (prefix, middle, suffix) => {
          const pattern = `${prefix}*${suffix}`;
          const matchingValue = `${prefix}${middle}${suffix}`;
          const { wildcardMatch } = require("../src/utils");
          const result = wildcardMatch(matchingValue, pattern);
          expect(result).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });

  test("wildcard pattern without * is exact match (case-insensitive)", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 20 }).filter(s => !s.includes("*")),
        fc.string({ minLength: 1, maxLength: 20 }).filter(s => !s.includes("*")),
        (value, pattern) => {
          const { wildcardMatch } = require("../src/utils");
          const result = wildcardMatch(value, pattern);
          expect(result).toBe(value.toLowerCase() === pattern.toLowerCase());
        },
      ),
      { numRuns: 100 },
    );
  });
});