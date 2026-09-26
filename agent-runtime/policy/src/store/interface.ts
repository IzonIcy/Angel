/**
 * PolicyStore interface
 *
 * Storage backends must implement this interface.
 */

import type {
  CreatePolicyRuleInput,
  PolicyRule,
  UpdatePolicyRuleInput,
} from "../types";

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
