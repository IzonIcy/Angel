import type { Database } from "bun:sqlite";
import type { AngelConfig } from "./config";
import { getUsageTotalsForWindow } from "./db";

function normalizeContext(context: string): string {
  return context.trim().toLowerCase();
}

export function resolveModelForContext(
  config: AngelConfig,
  context: string,
): string {
  if (!config.model_routing.enabled) return config.model;
  const normalized = normalizeContext(context);
  const routes = config.model_routing.routes || [];
  const exact = routes.find((r) => normalizeContext(r.context) === normalized);
  if (exact?.model) return exact.model;
  const fallback = routes.find(
    (r) =>
      normalizeContext(r.context) === "default" ||
      normalizeContext(r.context) === "*",
  );
  return fallback?.model || config.model;
}

export function checkBudgetGuardrail(
  db: Database,
  config: AngelConfig,
  chatId: number,
): { allowed: boolean; reason?: string } {
  if (!config.daily_budget.enabled) return { allowed: true };

  const usage = getUsageTotalsForWindow(
    db,
    1,
    config.daily_budget.enforce_per_chat ? chatId : undefined,
  );

  if (usage.total >= config.daily_budget.max_total_tokens) {
    return {
      allowed: false,
      reason: `Daily token budget exceeded (${usage.total}/${config.daily_budget.max_total_tokens})`,
    };
  }
  if (usage.input >= config.daily_budget.max_input_tokens) {
    return {
      allowed: false,
      reason: `Daily input-token budget exceeded (${usage.input}/${config.daily_budget.max_input_tokens})`,
    };
  }
  if (usage.output >= config.daily_budget.max_output_tokens) {
    return {
      allowed: false,
      reason: `Daily output-token budget exceeded (${usage.output}/${config.daily_budget.max_output_tokens})`,
    };
  }

  return { allowed: true };
}
