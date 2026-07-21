import { describe, it, expect } from "bun:test";

describe("Angel", () => {
  it("should pass a basic sanity check", () => {
    expect(1 + 1).toBe(2);
  });

  it("should have required source modules", async () => {
    // Verify core modules can be imported
    const mod = await import("../src/index.ts");
    expect(mod).toBeDefined();
  });
});
