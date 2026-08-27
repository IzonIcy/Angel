import type { Database } from "bun:sqlite";
import type { AngelConfig } from "../config";
import { logToolExecution } from "../db";
import type { LlmTool } from "../llm";
import { evaluateExecutionPolicy, type PolicyDecision } from "../policy";

/**
 * Capability token for contexts that bypass the execution policy engine.
 *
 * This used to be a plain boolean on ToolContext, which meant any call site
 * could set `{ skipPolicy: true }` and silently skip every deny/confirm
 * rule. Now the only way to obtain one is `createPolicyBypass()` below;
 * the brand symbol is module-private, so nothing outside this file can
 * construct a valid bypass.
 */
const bypassBrand = Symbol("angel.policyBypass");
export type PolicyBypass = { readonly [bypassBrand]: true };

/** The only sanctioned producer of a policy bypass. Keep callers few. */
export function createPolicyBypass(): PolicyBypass {
  return { [bypassBrand]: true } as unknown as PolicyBypass;
}

export interface ToolContext {
  chatId: number;
  channel: string;
  workingDir: string;
  db: Database;
  config: AngelConfig;
  actorId?: string;
  registry?: ToolRegistry;
  sendIntermediate?: (text: string) => Promise<void>;
  /**
   * Privileged contexts only; see {@link createPolicyBypass}. When set,
   * the execution-policy engine is skipped entirely for this context.
   */
  skipPolicy?: PolicyBypass;
}

export interface ToolResult {
  output: string;
  isError?: boolean;
  metadata?: Record<string, any>;
}

export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, any>;
  risk: "low" | "medium" | "high";
  execute(input: any, ctx: ToolContext): Promise<ToolResult>;
}

export class ToolRegistry {
  private tools: Map<string, Tool> = new Map();

  register(tool: Tool) {
    this.tools.set(tool.name, tool);
  }

  registerMany(tools: Tool[]) {
    for (const t of tools) this.register(t);
  }

  unregister(name: string) {
    this.tools.delete(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  getDefinitions(): LlmTool[] {
    return [...this.tools.values()].map((t) => ({
      type: "function" as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));
  }

  async execute(
    name: string,
    input: any,
    ctx: ToolContext,
    opts?: { confirmationSatisfied?: boolean },
  ): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return { output: `Unknown tool: ${name}`, isError: true };
    }
    const started = Date.now();

    const policyDecision: PolicyDecision = ctx.skipPolicy
      ? { allowed: true, requireConfirmation: false }
      : evaluateExecutionPolicy(tool, input, ctx, opts);
    if (!policyDecision.allowed) {
      const denial = {
        output:
          policyDecision.reason ||
          (policyDecision.requireConfirmation
            ? "Action requires confirmation."
            : "Action blocked by policy."),
        isError: true,
      };
      logToolExecution(ctx.db, {
        chatId: ctx.chatId,
        actorId: ctx.actorId,
        channel: ctx.channel,
        toolName: name,
        success: false,
        durationMs: Date.now() - started,
        errorText: denial.output,
      });
      return denial;
    }

    try {
      const result = await tool.execute(input, ctx);
      logToolExecution(ctx.db, {
        chatId: ctx.chatId,
        actorId: ctx.actorId,
        channel: ctx.channel,
        toolName: name,
        success: !result.isError,
        durationMs: Date.now() - started,
        errorText: result.isError ? result.output : undefined,
      });
      return result;
    } catch (err: any) {
      const result = { output: `Tool error: ${err.message}`, isError: true };
      logToolExecution(ctx.db, {
        chatId: ctx.chatId,
        actorId: ctx.actorId,
        channel: ctx.channel,
        toolName: name,
        success: false,
        durationMs: Date.now() - started,
        errorText: result.output,
      });
      return result;
    }
  }

  listNames(): string[] {
    return [...this.tools.keys()];
  }

  count(): number {
    return this.tools.size;
  }
}
