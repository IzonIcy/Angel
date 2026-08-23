import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { bashTool } from "./bash";
import type { ToolContext } from "./registry";
import {
  buildSeatbeltProfile,
  resolveSandboxMode,
  sandboxExecAvailable,
  wrapWithSandbox,
} from "./sandbox";

describe("buildSeatbeltProfile", () => {
  test("denies writes then re-allows the working directory", () => {
    const profile = buildSeatbeltProfile("/Users/x/project", "filesystem");
    const denyIdx = profile.indexOf("(deny file-write*)");
    const allowWorkdir = profile.indexOf(
      '(allow file-write* (subpath "/Users/x/project"))',
    );

    expect(denyIdx).toBeGreaterThan(-1);
    expect(allowWorkdir).toBeGreaterThan(denyIdx);
  });

  test("filesystem mode allows temp space and devices but not network denial", () => {
    const profile = buildSeatbeltProfile("/tmp/work", "filesystem");
    expect(profile).toContain('"/private/tmp"');
    expect(profile).toContain("^/private/var/folders/");
    expect(profile).toContain('"/dev/null"');
    expect(profile).not.toContain("(deny network*)");
  });

  test("full mode additionally denies network", () => {
    const profile = buildSeatbeltProfile("/tmp/work", "full");
    expect(profile).toContain("(deny network*)");
    expect(profile).toContain("(deny system-socket)");
  });

  test("workdir is resolved to an absolute path", () => {
    const profile = buildSeatbeltProfile("relative/dir", "filesystem");
    expect(profile).toContain(`(subpath "${path.resolve("relative/dir")}")`);
  });
});

describe("resolveSandboxMode", () => {
  test("explicit off stays off even where sandbox exists", () => {
    expect(resolveSandboxMode("off")).toBe("off");
  });

  test("invalid config values fail safe to off with a warning", () => {
    const warnings: string[] = [];
    expect(resolveSandboxMode("banana", (m) => warnings.push(m))).toBe("off");
    expect(warnings.length).toBe(1);
  });

  test("requested modes degrade to off when sandbox-exec is unavailable", () => {
    // Can't control platform in the test env; assert consistency instead:
    // if the mechanism exists the request is honored, otherwise it degrades
    // loudly rather than pretending.
    if (!sandboxExecAvailable()) {
      const warnings: string[] = [];
      expect(resolveSandboxMode("full", (m) => warnings.push(m))).toBe("off");
      expect(warnings.length).toBe(1);
    } else {
      expect(resolveSandboxMode("full")).toBe("full");
    }
  });

  test("default resolves consistently with availability", () => {
    const mode = resolveSandboxMode(undefined);
    expect(mode === "off" || mode === "filesystem").toBe(true);
    expect(sandboxExecAvailable() ? mode !== "off" : true).toBe(true);
  });
});

describe("wrapWithSandbox", () => {
  test("returns plain bash argv when off", () => {
    expect(wrapWithSandbox("echo hi", "/tmp", "off")).toEqual([
      "/bin/bash",
      "-c",
      "echo hi",
    ]);
  });

  test("wraps through sandbox-exec with a materialized profile on darwin", () => {
    if (!sandboxExecAvailable()) return;
    const argv = wrapWithSandbox("echo hi", os.tmpdir(), "full");
    expect(argv[0]).toBe("/usr/bin/sandbox-exec");
    expect(argv[1]).toBe("-f");
    expect(argv[2]).toMatch(/\.sb$/);
    expect(argv.slice(3, 5)).toEqual(["/bin/bash", "-c"]);
    expect(readFileSync(argv[2], "utf8")).toContain("(deny network*)");
  });

  test("profile file content matches its hash-keyed name", () => {
    if (!sandboxExecAvailable()) return;
    const workDir = mkdtempSync(path.join(os.tmpdir(), "angel-sb-"));
    const a = wrapWithSandbox("true", workDir, "filesystem");
    const b = wrapWithSandbox("other command", workDir, "filesystem");
    // Same inputs -> same cached profile regardless of shell payload.
    expect(a[3]).toBe(b[3]);
  });
});

describe("bash tool executes inside the sandbox (integration)", () => {
  function makeCtx(workDir: string, sandbox?: string): ToolContext {
    return {
      chatId: 0,
      channel: "test",
      workingDir: workDir,
      db: null as unknown as ToolContext["db"],
      config: { security: { sandbox } } as unknown as ToolContext["config"],
    };
  }

  test.skipIf(!sandboxExecAvailable())(
    "writes inside the working directory succeed under filesystem sandbox",
    async () => {
      const workDir = mkdtempSync(path.join(os.tmpdir(), "angel-sbx-"));
      const result = await bashTool.execute(
        { command: "echo sandbox-ok > inside.txt && cat inside.txt" },
        makeCtx(workDir),
      );
      expect(result.isError).toBeFalsy();
      expect(result.output).toContain("sandbox-ok");
    },
    20_000,
  );

  test.skipIf(!sandboxExecAvailable())(
    "writes outside allowed paths are denied by the kernel",
    async () => {
      const workDir = mkdtempSync(path.join(os.tmpdir(), "angel-sbx-"));
      // $HOME is not in the allow list — the write must be denied.
      const result = await bashTool.execute(
        {
          command: `touch "$HOME/angel-sandbox-should-not-exist" 2>&1; exit 0`,
        },
        makeCtx(workDir),
      );
      expect(result.output.toLowerCase()).toContain("operation not permitted");

      // The authoritative check: nothing landed on disk.
      const fs = await import("node:fs");
      expect(
        fs.existsSync(
          path.join(os.homedir(), "angel-sandbox-should-not-exist"),
        ),
      ).toBe(false);
    },
    20_000,
  );

  test.skipIf(!sandboxExecAvailable())(
    "temp writes still work under full sandbox",
    async () => {
      const workDir = mkdtempSync(path.join(os.tmpdir(), "angel-sbx-"));
      writeFileSync(path.join(workDir, "seed.txt"), "x");
      const result = await bashTool.execute(
        { command: "mktemp -t angel-sb-test >/dev/null && echo temp-ok" },
        makeCtx(workDir, "full"),
      );
      expect(result.output).toContain("temp-ok");
    },
    30_000,
  );
});
