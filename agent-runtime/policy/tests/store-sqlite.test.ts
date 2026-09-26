/**
 * Unit tests for SqlitePolicyStore
 *
 * Uses an in-memory bun:sqlite database. Exercises the full CRUD surface plus
 * the tableName identifier, which is interpolated into every query and so must
 * be validated as a plain SQL identifier.
 */

import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { SqlitePolicyStore } from "../src/store/sqlite";

const SCHEMA = `
  CREATE TABLE execution_policies (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    action TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    tool_name TEXT,
    risk_level TEXT,
    channel TEXT,
    actor_id TEXT,
    path_pattern TEXT,
    domain_pattern TEXT,
    note TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )
`;

function makeDb(): Database {
  const db = new Database(":memory:");
  db.exec(SCHEMA);
  return db;
}

function makeStore(tableName?: string): SqlitePolicyStore {
  return new SqlitePolicyStore({ db: makeDb(), tableName });
}

describe("SqlitePolicyStore - CRUD", () => {
  let store: SqlitePolicyStore;

  beforeEach(() => {
    store = makeStore();
  });

  test("create persists a rule and returns it", async () => {
    const created = await store.create({
      name: "block-curl",
      type: "permission",
      action: "deny",
      toolName: "bash",
      note: "no network egress",
    });

    expect(created.id).toBeString();
    expect(created.name).toBe("block-curl");
    expect(created.enabled).toBe(true);
    expect(created.toolName).toBe("bash");
    expect(created.createdAt).toBe(created.updatedAt);
  });

  test("getById round-trips every nullable field", async () => {
    const created = await store.create({
      name: "full-rule",
      type: "approval",
      action: "require_confirmation",
      toolName: "write_file",
      riskLevel: "high",
      channel: "discord",
      actorId: "u1",
      pathPattern: "/etc/**",
      domainPattern: "*.evil.com",
      note: "careful",
    });

    expect(await store.getById(created.id)).toEqual(created);
  });

  test("getById returns null for unknown id", async () => {
    expect(await store.getById("nope")).toBeNull();
  });

  test("listEnabled excludes disabled rules and orders by id descending", async () => {
    const a = await store.create({
      name: "a",
      type: "permission",
      action: "allow",
    });
    const disabled = await store.create({
      name: "b",
      type: "permission",
      action: "deny",
      enabled: false,
    });
    const c = await store.create({
      name: "c",
      type: "permission",
      action: "deny",
    });

    const enabled = await store.listEnabled();
    const ids = enabled.map((r) => r.id);

    expect(ids).not.toContain(disabled.id);
    expect(new Set(ids)).toEqual(new Set([a.id, c.id]));
    // ORDER BY id DESC — ids share a millisecond prefix, so compare as strings
    expect([...ids].sort().reverse()).toEqual(ids);
  });

  test("update writes only patched fields and leaves the rest intact", async () => {
    const created = await store.create({
      name: "original",
      type: "permission",
      action: "allow",
      toolName: "bash",
    });

    const updated = await store.update(created.id, { name: "renamed" });

    expect(updated.name).toBe("renamed");
    expect(updated.toolName).toBe("bash");

    const persisted = await store.getById(created.id);
    expect(persisted?.name).toBe("renamed");
    expect(persisted?.toolName).toBe("bash");
  });

  test("update toggling enabled to false removes it from listEnabled", async () => {
    const created = await store.create({
      name: "x",
      type: "permission",
      action: "allow",
    });
    expect(await store.listEnabled()).toHaveLength(1);

    await store.update(created.id, { enabled: false });

    expect(await store.listEnabled()).toHaveLength(0);
    expect((await store.getById(created.id))?.enabled).toBe(false);
  });

  test("update on unknown id rejects", async () => {
    expect(store.update("missing", { name: "x" })).rejects.toThrow(
      /not found/i,
    );
  });

  test("delete removes the rule", async () => {
    const created = await store.create({
      name: "gone",
      type: "permission",
      action: "allow",
    });
    await store.delete(created.id);
    expect(await store.getById(created.id)).toBeNull();
  });

  test("honours a custom tableName", async () => {
    const db = makeDb();
    db.exec(SCHEMA.replace("execution_policies", "custom_policies"));
    const custom = new SqlitePolicyStore({ db, tableName: "custom_policies" });

    const created = await custom.create({
      name: "c",
      type: "permission",
      action: "allow",
    });
    expect((await custom.getById(created.id))?.name).toBe("c");
  });
});

describe("SqlitePolicyStore - tableName validation", () => {
  test("rejects an identifier that would break out of the query", () => {
    expect(() =>
      makeStore("execution_policies; DROP TABLE execution_policies"),
    ).toThrow(/invalid table name/i);
  });

  test("rejects non-identifier characters", () => {
    for (const bad of [
      "has space",
      "1leading-digit",
      "quote'inject",
      "back`tick",
      "",
    ]) {
      expect(() => makeStore(bad)).toThrow(/invalid table name/i);
    }
  });

  test("accepts ordinary identifiers", () => {
    expect(() => makeStore("custom_policies")).not.toThrow();
    expect(() => makeStore("_private2")).not.toThrow();
  });

  test("a malicious tableName cannot execute arbitrary SQL", () => {
    const db = makeDb();

    // rejected at construction, before any query is ever built
    expect(
      () =>
        new SqlitePolicyStore({
          db,
          tableName:
            "execution_policies WHERE 1=1 UNION SELECT * FROM sqlite_master --",
        }),
    ).toThrow(/invalid table name/i);

    const row = db
      .query("SELECT count(*) AS n FROM execution_policies")
      .get() as { n: number };
    expect(row.n).toBe(0);
  });
});
