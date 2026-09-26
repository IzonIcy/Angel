/**
 * @agent-runtime/policy — Policy engine for AI agent execution control
 *
 * A standalone, database-agnostic policy engine with recency-based precedence
 * and fail-safe defaults for high-risk tools in multi-party contexts.
 *
 * @packageDocumentation
 */

// Core evaluation logic
export {
  evaluatePolicy,
  ruleMatches,
} from "./evaluation";
export type { PolicyStore as PolicyStoreInterface } from "./store/interface";
// Storage implementations
export { MemoryPolicyStore } from "./store/memory";
export {
  SqlitePolicyStore,
  type SqlitePolicyStoreOptions,
} from "./store/sqlite";
// Types
export type {
  CreatePolicyRuleInput,
  EvaluateOptions,
  PolicyAction,
  PolicyContext,
  PolicyDecision,
  PolicyRule,
  PolicyStore,
  PolicyType,
  RiskLevel,
  Tool,
  UpdatePolicyRuleInput,
} from "./types";
// Utilities
export {
  fieldMatches,
  generatePolicyId,
  getDomainFromToolInput,
  getPathFromToolInput,
  isDirectChat,
  nowIso,
  wildcardMatch,
} from "./utils";
