import { beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { AngelConfig } from "./config";
import { invalidateHooksCache, runHook } from "./hooks";

function makeConfig(): AngelConfig {
  const dataDir = mkdtempSync(join(tmpdir(), "angel-hooks-test-"));
  const hooksDir = join(dataDir, "hooks");
  mkdirSync(hooksDir, { recursive: true });
  return { data_dir: dataDir, hooks_dir: hooksDir } as AngelConfig;
}

function writeHook(
  config: AngelConfig,
  name: string,
  command: string,
  event = "before_tool",
  timeoutMs = 2000,
) {
  writeFileSync(
    join(config.hooks_dir!, `${name}.json`),
    JSON.stringify({
      name,
      event,
      command,
      timeout_ms: timeoutMs,
      enabled: true,
    }),
  );
}

// Hooks are cached in a module-level map, so every test gets a clean slate.
beforeEach(() => invalidateHooksCache());

describe("runHook", () => {
  test("returns null when no hooks are configured", async () => {
    const config = makeConfig();
    expect(await runHook("before_tool", {}, config)).toBeNull();
  });

  test("fails closed when the hook command exits non-zero", async () => {
    const config = makeConfig();
    writeHook(config, "crash", "exit 1");
    const outcome = await runHook("before_tool", {}, config);
    expect(outcome?.action).toBe("block");
    expect(outcome?.reason).toContain("crash");
  });

  test("fails closed when the hook returns invalid JSON", async () => {
    const config = makeConfig();
    writeHook(config, "garbage", 'echo "not json"');
    const outcome = await runHook("before_tool", {}, config);
    expect(outcome?.action).toBe("block");
    expect(outcome?.reason).toContain("garbage");
  });

  test("blocks when the hook explicitly blocks", async () => {
    const config = makeConfig();
    writeHook(config, "deny", 'echo \'{"action":"block","reason":"no"}\'');
    const outcome = await runHook("before_tool", {}, config);
    expect(outcome?.action).toBe("block");
    expect(outcome?.reason).toBe("no");
  });

  test("allows when the hook explicitly allows", async () => {
    const config = makeConfig();
    writeHook(config, "allow", 'echo \'{"action":"allow"}\'');
    const outcome = await runHook("before_tool", {}, config);
    expect(outcome?.action).toBe("allow");
  });

  test("fails closed when the hook times out", async () => {
    const config = makeConfig();
    writeHook(config, "slow", "sleep 10", "before_tool", 100);
    const outcome = await runHook("before_tool", {}, config);
    expect(outcome?.action).toBe("block");
    expect(outcome?.reason).toContain("slow");
  });
});

describe("runHook cache", () => {
  test("invalidating the cache reloads hook definitions", async () => {
    const config = makeConfig();
    writeHook(config, "flip", 'echo \'{"action":"allow"}\'');
    expect((await runHook("before_tool", {}, config))?.action).toBe("allow");

    writeHook(config, "flip", 'echo \'{"action":"block","reason":"now"}\'');
    // Without invalidation the cached definition still allows...
    expect((await runHook("before_tool", {}, config))?.action).toBe("allow");

    // ...but after invalidation the new definition blocks.
    invalidateHooksCache();
    const reloaded = await runHook("before_tool", {}, config);
    expect(reloaded?.action).toBe("block");
    expect(reloaded?.reason).toBe("now");
  });
});
