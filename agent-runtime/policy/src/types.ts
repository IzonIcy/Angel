/**
 * Core policy types for @agent-runtime/policy
 *
 * These types are designed to be database-agnostic and runtime-agnostic.
 * The policy engine operates on pure data structures; persistence is
 * delegated to a PolicyStore implementation.
 */

import type { JsonValue } from "./utils";

/** Risk level of a tool */
export type RiskLevel = "low" | "medium" | "high";

/** Action a policy rule can take */
export type PolicyAction = "allow" | "deny" | "require_confirmation";

/** Type of policy rule */
export type PolicyType = "approval" | "permission";

/** Minimal context required for policy evaluation */
export interface PolicyContext {
  /** Channel identifier (e.g., "discord_dm", "slack_channel", "signal_private") */
  channel: string | undefined;

  /** Actor/user identifier within the channel. Absent means "no actor", which
   *  is distinct from an empty string only for a rule that patterns on it. */
  actorId?: string;

  /** Working directory for path-based rules */
  workingDir: string;
}

/** A policy rule (without database-specific fields) */
export interface PolicyRule {
  /** Unique identifier */
  id: string;

  /** Human-readable name */
  name: string;

  /** Rule type: "approval" (user-facing) or "permission" (system) */
  type: PolicyType;

  /** Action to take when rule matches */
  action: PolicyAction;

  /** Whether the rule is enabled */
  enabled: boolean;

  /** Tool name pattern (supports wildcards, comma-separated) */
  toolName: string | null;

  /** Risk level pattern (supports wildcards, comma-separated) */
  riskLevel: string | null;

  /** Channel pattern (supports wildcards, comma-separated) */
  channel: string | null;

  /** Actor ID pattern (supports wildcards, comma-separated) */
  actorId: string | null;

  /** File path pattern for file tools (supports wildcards, comma-separated) */
  pathPattern: string | null;

  /** Domain pattern for web tools (supports wildcards, comma-separated) */
  domainPattern: string | null;

  /** Optional note for audit/debugging */
  note: string | null;

  /** Creation timestamp (ISO 8601) */
  createdAt: string;

  /** Last update timestamp (ISO 8601) */
  updatedAt: string;
}

/** Result of policy evaluation */
export interface PolicyDecision {
  /** Whether the action is allowed */
  allowed: boolean;

  /** Whether confirmation is required before proceeding */
  requireConfirmation: boolean;

  /** Human-readable reason for the decision */
  reason?: string;
}

/** Options for policy evaluation */
export interface EvaluateOptions {
  /** Whether a required confirmation has been satisfied */
  confirmationSatisfied?: boolean;
}

/** Interface for policy storage backends */
export interface PolicyStore {
  /** List all enabled rules, ordered by recency (newest first) */
  listEnabled(): Promise<PolicyRule[]>;

  /** Get a rule by ID */
  getById(id: string): Promise<PolicyRule | null>;

  /** Create a new rule */
  create(rule: CreatePolicyRuleInput): Promise<PolicyRule>;

  /** Update an existing rule */
  update(id: string, patch: UpdatePolicyRuleInput): Promise<PolicyRule>;

  /** Delete a rule */
  delete(id: string): Promise<void>;
}

/** Input for creating a policy rule */
export interface CreatePolicyRuleInput {
  name: string;
  type: PolicyType;
  action: PolicyAction;
  enabled?: boolean;
  toolName?: string | null;
  riskLevel?: string | null;
  channel?: string | null;
  actorId?: string | null;
  pathPattern?: string | null;
  domainPattern?: string | null;
  note?: string | null;
}

/** Input for updating a policy rule */
export interface UpdatePolicyRuleInput {
  name?: string;
  type?: PolicyType;
  action?: PolicyAction;
  enabled?: boolean;
  toolName?: string | null;
  riskLevel?: string | null;
  channel?: string | null;
  actorId?: string | null;
  pathPattern?: string | null;
  domainPattern?: string | null;
  note?: string | null;
}

/** Tool definition for policy evaluation */
export interface Tool {
  /** Tool name */
  name: string;

  /** Tool risk level */
  risk: RiskLevel;

  /** Tool description (unused by policy engine, for context) */
  description?: string;

  /** Tool parameters schema (unused by policy engine) */
  parameters?: Record<string, JsonValue>;
}
