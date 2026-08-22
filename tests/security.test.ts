import { describe, expect, it } from "vitest";
import { SenderRateLimiter } from "../src/security";

describe("SenderRateLimiter", () => {
  it("allows unlimited messages when max is 0 (default off)", () => {
    const limiter = new SenderRateLimiter(0);
    for (let i = 0; i < 100; i += 1) {
      expect(limiter.check("discord", "alice").allowed).toBe(true);
    }
  });

  it("blocks after the per-minute budget is exhausted", () => {
    const limiter = new SenderRateLimiter(2);
    const now = 1_000_000;
    expect(limiter.check("discord", "alice", now).allowed).toBe(true);
    expect(limiter.check("discord", "alice", now + 1).allowed).toBe(true);
    const blocked = limiter.check("discord", "alice", now + 2);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("tracks senders independently and windows independently", () => {
    const limiter = new SenderRateLimiter(1);
    const now = 5_000_000;
    expect(limiter.check("discord", "alice", now).allowed).toBe(true);
    // different sender, same window: fine
    expect(limiter.check("discord", "bob", now).allowed).toBe(true);
    // same sender, next window: fine again
    expect(limiter.check("discord", "alice", now + 61_000).allowed).toBe(true);
  });

  it("keys by channel so discord and telegram budgets don't mix", () => {
    const limiter = new SenderRateLimiter(1);
    const now = 9_000_000;
    expect(limiter.check("discord", "carol", now).allowed).toBe(true);
    expect(limiter.check("telegram", "carol", now).allowed).toBe(true);
  });

  it("prune drops expired windows", () => {
    const limiter = new SenderRateLimiter(1);
    limiter.check("slack", "dave", 1_000);
    limiter.prune(120_000);
    // internal map should be empty; verify indirectly that count restarted
    expect(limiter.check("slack", "dave", 121_000).allowed).toBe(true);
  });
});
