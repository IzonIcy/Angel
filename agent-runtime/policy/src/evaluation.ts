/**
 * Core policy evaluation logic
 *
 * Pure functions with no external dependencies.
 * This is the heart of the policy engine.
 */

import type {
  EvaluateOptions,
  PolicyContext,
  PolicyDecision,
  PolicyRule,
  Tool,
} from "./types";

import {
  fieldMatches,
  getDomainFromToolInput,
  getPathFromToolInput,
  isDirectChat,
} from "./utils";

/**
 * Check if a single rule matches the given tool, input, and context.
 */
export function ruleMatches(
  rule: PolicyRule,
  tool: Tool,
  input: unknown,
  ctx: PolicyContext,
): boolean {
  if (!fieldMatches(tool.name, rule.toolName)) return false;
  if (!fieldMatches(tool.risk, rule.riskLevel)) return false;
  if (!fieldMatches(ctx.channel, rule.channel)) return false;
  if (!fieldMatches(ctx.actorId, rule.actorId)) return false;

  const pathValue = getPathFromToolInput(tool.name, input as any);
  if (!fieldMatches(pathValue, rule.pathPattern)) return false;

  const domainValue = getDomainFromToolInput(tool.name, input as any);
  if (!fieldMatches(domainValue, rule.domainPattern)) return false;

  return true;
}

/**
 * Evaluate a list of policy rules against a tool execution request.
 *
 * Rules are evaluated in order (newest first). The FIRST matching rule decides:
 * - deny → immediately returns denied
 * - allow → immediately returns allowed
 * - require_confirmation → remembers match, continues scanning for deny
 *
 * If no rule matches:
 * - High-risk tools in non-direct chats require confirmation (fail-safe)
 * - Otherwise allowed
 */
export function evaluatePolicy(
  rules: PolicyRule[],
  tool: Tool,
  input: unknown,
  ctx: PolicyContext,
  options: EvaluateOptions = {},
): PolicyDecision {
  let requireConfirmationMatch: PolicyRule | null = null;

  for (const rule of rules) {
    if (!rule.enabled) continue;
    if (!ruleMatches(rule, tool, input, ctx)) continue;

    if (rule.action === "deny") {
      return {
        allowed: false,
        requireConfirmation: false,
        reason: `Blocked by policy "${rule.name}"${rule.note ? `: ${rule.note}` : ""}`,
      };
    }

    if (rule.action === "require_confirmation" && !requireConfirmationMatch) {
      // A satisfied confirmation fulfils the requirement but must not skip
      // the rest of the scan — an explicit deny further down still applies.
      if (options.confirmationSatisfied) continue;
      requireConfirmationMatch = rule;
      continue;
    }

    if (rule.action === "allow") {
      return { allowed: true, requireConfirmation: false };
    }
  }

  if (requireConfirmationMatch) {
    return options.confirmationSatisfied
      ? { allowed: true, requireConfirmation: false }
      : {
          allowed: false,
          requireConfirmation: true,
          reason: `Confirmation required by policy "${requireConfirmationMatch.name}"`,
        };
  }

  // No rule matched. Unconfigured must not mean "allow everything" in
  // multi-party chats: high-risk tools fall back to requiring confirmation
  // there, so an empty ruleset fails safe instead of fail-open.
  //
  // Direct chats (owner DMs) keep the historical allow behavior; that is
  // where the safe-word flow itself resolves (approve_confirmation is
  // high-risk); failing closed here would brick confirmations entirely.
  if (tool.risk === "high" && !isDirectChat(ctx.channel)) {
    if (!options.confirmationSatisfied) {
      return {
        allowed: false,
        requireConfirmation: true,
        reason:
          "No matching execution policy for a high-risk tool outside a direct chat",
      };
    }
  }

  return { allowed: true, requireConfirmation: false };
}
