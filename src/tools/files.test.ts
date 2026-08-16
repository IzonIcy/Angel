import { Database } from "bun:sqlite";
import { beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { DEFAULTS } from "../config";
import { readFileTool, writeFileTool } from "./files";
import type { ToolContext } from "./registry";

let root: string;
let work: string;
let ctx: ToolContext;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "angel-files-test-"));
  work = join(root, "work");
  mkdirSync(work, { recursive: true });
  writeFileSync(join(work, "ok.txt"), "hello from inside");
  writeFileSync(join(root, "secret.txt"), "TOP SECRET");
  symlinkSync(join(root, "secret.txt"), join(work, "link.txt"));
  ctx = {
    chatId: 1,
    channel: "test",
    workingDir: work,
    db: new Database(":memory:"),
    config: { ...DEFAULTS, data_dir: root, working_dir: work },
  };
});

describe("read_file containment", () => {
  test("reads files inside the working dir", async () => {
    // Regression guard: on macOS /var -> /private/var, realpath'ing a file
    // inside workingDir yields a different prefix than workingDir itself.
    // This used to false-positive block legitimate reads.
    const result = await readFileTool.execute({ path: "ok.txt" }, ctx);
    expect(result.isError).toBeFalsy();
    expect(result.output).toContain("hello from inside");
  });

  test("blocks a symlink pointing outside the working dir", async () => {
    const result = await readFileTool.execute({ path: "link.txt" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.output).toContain("Access denied");
    expect(result.output).not.toContain("TOP SECRET");
  });

  test("blocks .. traversal", async () => {
    const result = await readFileTool.execute({ path: "../secret.txt" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.output).toContain("Access denied");
  });

  test("blocks absolute paths outside the working dir", async () => {
    const result = await readFileTool.execute(
      { path: join(root, "secret.txt") },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(result.output).toContain("Access denied");
  });

  test("blocks sensitive paths like /etc/passwd", async () => {
    const result = await readFileTool.execute({ path: "/etc/passwd" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.output).toContain("Access denied");
  });
});

describe("write_file containment", () => {
  test("writes inside the working dir, creating parent dirs", async () => {
    const result = await writeFileTool.execute(
      { path: "nested/deep/file.txt", content: "new content" },
      ctx,
    );
    expect(result.isError).toBeFalsy();
    const readBack = await readFileTool.execute(
      { path: "nested/deep/file.txt" },
      ctx,
    );
    expect(readBack.output).toContain("new content");
  });

  test("rejects writes that escape via ..", async () => {
    const result = await writeFileTool.execute(
      { path: "../evil.txt", content: "x" },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(result.output).toContain("Access denied");
  });

  test("rejects absolute-path writes outside the working dir", async () => {
    const result = await writeFileTool.execute(
      { path: join(root, "evil.txt"), content: "x" },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(result.output).toContain("Access denied");
  });
});
