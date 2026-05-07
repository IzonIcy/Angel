import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { DEFAULTS } from "./config";
import { getDb } from "./db";
import { runSmokeChecks } from "./smoke";

function testDb() {
  return getDb(mkdtempSync(join(tmpdir(), "angel-smoke-test-")));
}

describe("smoke checks", () => {
  test("skips optional integrations when credentials are absent", async () => {
    const results = await runSmokeChecks(DEFAULTS, testDb(), {
      fetchImpl: (() => {
        throw new Error("fetch should not run without credentials");
      }) as any,
    });

    expect(results.some((r) => r.status === "fail")).toBe(false);
    expect(results.find((r) => r.name === "OpenAI")?.status).toBe("skip");
    expect(results.find((r) => r.name === "Discord")?.status).toBe("skip");
  });

  test("validates active GitHub connector endpoint", async () => {
    const db = testDb();
    const name = `github-${crypto.randomUUID()}`;
    db.run(
      `INSERT INTO knowledge_connectors (name, type, config_json, status)
       VALUES (?, 'github', ?, 'active')`,
      [
        name,
        JSON.stringify({
          owner: "owner",
          repo: "repo",
          token: "ghp_123456789012345678901234567890123456",
        }),
      ],
    );

    let requestedUrl = "";
    let authorization = "";
    const fetchImpl = (async (
      url: string | URL | Request,
      init?: RequestInit,
    ) => {
      requestedUrl = String(url);
      authorization = String(
        (init?.headers as Record<string, string>)?.Authorization || "",
      );
      return new Response("[]", { status: 200 });
    }) as unknown as typeof fetch;

    const results = await runSmokeChecks(DEFAULTS, db, { fetchImpl });
    const result = results.find((r) => r.name === `Connector ${name}`);

    expect(result?.status).toBe("pass");
    expect(requestedUrl).toContain("/repos/owner/repo/issues");
    expect(authorization).toContain("Bearer ghp_");
  });

  test("redacts secrets from failing HTTP details", async () => {
    const db = testDb();
    const name = `github-redact-${crypto.randomUUID()}`;
    db.run(
      `INSERT INTO knowledge_connectors (name, type, config_json, status)
       VALUES (?, 'github', ?, 'active')`,
      [name, JSON.stringify({ owner: "owner", repo: "repo" })],
    );

    const fetchImpl = (async () =>
      new Response("token ghp_123456789012345678901234567890123456 leaked", {
        status: 401,
      })) as unknown as typeof fetch;

    const results = await runSmokeChecks(DEFAULTS, db, { fetchImpl });
    const result = results.find((r) => r.name === `Connector ${name}`);

    expect(result?.status).toBe("fail");
    expect(result?.detail).toContain("[REDACTED]");
    expect(result?.detail).not.toContain("ghp_123456");
  });
});
