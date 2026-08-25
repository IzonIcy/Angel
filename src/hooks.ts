import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";
import type { AngelConfig } from "./config";

export interface HookOutcome {
  action: "allow" | "block" | "modify";
  reason?: string;
  data?: any;
}

interface HookDef {
  name: string;
  event: string;
  command: string;
  timeout_ms: number;
  enabled: boolean;
}

// Cache is keyed by hooks directory: two configs with different hooks dirs
// (or hook files edited at runtime) must not see each other's definitions.
// Tests rely on this too; a hooks cache from one test file must not leak
// into another's config.
let hooksCache: { dir: string; hooks: HookDef[] } | null = null;

function loadHooks(config: AngelConfig): HookDef[] {
  const dir = config.hooks_dir || join(config.data_dir, "hooks");
  if (hooksCache && hooksCache.dir === dir) return hooksCache.hooks;

  if (!existsSync(dir)) {
    hooksCache = { dir, hooks: [] };
    return [];
  }

  const hooks: HookDef[] = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".json")) continue;
    try {
      const raw = readFileSync(join(dir, file), "utf-8");
      const def = JSON.parse(raw);
      hooks.push({
        name: def.name || file.replace(".json", ""),
        event: def.event,
        command: def.command,
        timeout_ms: def.timeout_ms || 5000,
        enabled: def.enabled !== false,
      });
    } catch {}
  }

  hooksCache = { dir, hooks };
  return hooks;
}

export async function runHook(
  event: string,
  data: any,
  config: AngelConfig,
): Promise<HookOutcome | null> {
  const hooks = loadHooks(config).filter((h) => h.event === event && h.enabled);
  if (hooks.length === 0) return null;

  for (const hook of hooks) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const proc = Bun.spawn(["bash", "-c", hook.command], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });

      const stdin = proc.stdin as any;
      stdin.write(JSON.stringify({ event, data }));
      stdin.end();

      timer = setTimeout(() => proc.kill(), hook.timeout_ms);
      const stdout = await new Response(proc.stdout).text();
      clearTimeout(timer);
      timer = undefined;
      await proc.exited;

      if (proc.exitCode !== 0) {
        console.error(
          `[angel] Hook "${hook.name}" (${event}) exited with code ${proc.exitCode}`,
        );
        // Fail closed: a non-zero exit means the hook failed.
        return {
          action: "block",
          reason: `Hook ${hook.name} failed (exit ${proc.exitCode})`,
        };
      }

      if (stdout.trim()) {
        let result: HookOutcome;
        try {
          result = JSON.parse(stdout.trim());
        } catch (err: any) {
          console.error(
            `[angel] Hook "${hook.name}" (${event}) returned invalid JSON: ${err.message}`,
          );
          // Fail closed: a hook we can't parse is a hook we can't trust.
          return {
            action: "block",
            reason: `Hook ${hook.name} returned invalid output`,
          };
        }
        if (result.action === "block") return result;
        if (result.action === "modify") return result;
      }
    } catch (err: any) {
      console.error(
        `[angel] Hook "${hook.name}" (${event}) failed: ${err.message}`,
      );
      // Fail closed: a blocking hook that crashes, times out, or emits bad
      // JSON must not silently permit the action it exists to stop.
      return {
        action: "block",
        reason: `Hook ${hook.name} failed`,
      };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  return { action: "allow" };
}

export function invalidateHooksCache() {
  hooksCache = null;
}
