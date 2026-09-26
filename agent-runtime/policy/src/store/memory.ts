/**
 * In-memory PolicyStore implementation
 *
 * Useful for testing, development, and single-process deployments.
 * Not suitable for multi-process or persistent deployments.
 */

import type {
  CreatePolicyRuleInput,
  PolicyRule,
  PolicyStore,
  UpdatePolicyRuleInput,
} from "../types";

import { generatePolicyId, nowIso } from "../utils";

export class MemoryPolicyStore implements PolicyStore {
  private rules: Map<string, PolicyRule> = new Map();

  async listEnabled(): Promise<PolicyRule[]> {
    return [...this.rules.values()]
      .filter((r) => r.enabled)
      .sort((a, b) => b.id.localeCompare(a.id)); // newest first (lexicographic on timestamp prefix)
  }

  async getById(id: string): Promise<PolicyRule | null> {
    return this.rules.get(id) ?? null;
  }

  async create(input: CreatePolicyRuleInput): Promise<PolicyRule> {
    const id = generatePolicyId();
    const now = nowIso();
    const rule: PolicyRule = {
      id,
      name: input.name,
      type: input.type,
      action: input.action,
      enabled: input.enabled ?? true,
      toolName: input.toolName ?? null,
      riskLevel: input.riskLevel ?? null,
      channel: input.channel ?? null,
      actorId: input.actorId ?? null,
      pathPattern: input.pathPattern ?? null,
      domainPattern: input.domainPattern ?? null,
      note: input.note ?? null,
      createdAt: now,
      updatedAt: now,
    };
    this.rules.set(id, rule);
    return rule;
  }

  async update(id: string, patch: UpdatePolicyRuleInput): Promise<PolicyRule> {
    const existing = this.rules.get(id);
    if (!existing) {
      throw new Error(`Policy rule not found: ${id}`);
    }
    const updated: PolicyRule = {
      ...existing,
      ...patch,
      updatedAt: nowIso(),
    };
    this.rules.set(id, updated);
    return updated;
  }

  async delete(id: string): Promise<void> {
    this.rules.delete(id);
  }

  /** Clear all rules (testing helper) */
  clear(): void {
    this.rules.clear();
  }

  /** Get all rules including disabled (testing helper) */
  async listAll(): Promise<PolicyRule[]> {
    return [...this.rules.values()].sort((a, b) => b.id.localeCompare(a.id));
  }
}
