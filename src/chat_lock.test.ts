import { describe, expect, test } from "bun:test";
import { withChatLock } from "./chat_lock";

describe("withChatLock", () => {
  test("serializes concurrent runs on the same chat", async () => {
    const run = (chatId: number, ms: number) =>
      withChatLock(chatId, () => Bun.sleep(ms));
    const started = Date.now();
    // Three 40ms runs on chat 1: serialized they take ~120ms, parallel ~40ms.
    await Promise.all([run(1, 40), run(1, 40), run(1, 40)]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(110);
  });

  test("does not serialize across different chats", async () => {
    const started = Date.now();
    await Promise.all([
      withChatLock(2, () => Bun.sleep(40)),
      withChatLock(3, () => Bun.sleep(40)),
    ]);
    // Ran concurrently: total wall time ~40ms, not ~80ms.
    expect(Date.now() - started).toBeLessThan(70);
  });

  test("releases the lock after completion", async () => {
    await withChatLock(1, () => Bun.sleep(30));
    const started = Date.now();
    await withChatLock(1, () => Bun.sleep(5));
    expect(Date.now() - started).toBeLessThan(50);
  });

  test("propagates errors and still releases the lock", async () => {
    await expect(
      withChatLock(1, () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    // Lock released: a new run must not deadlock.
    await withChatLock(1, () => Bun.sleep(1));
  });
});
