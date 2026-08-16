import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  claimScheduledTask,
  createScheduledTask,
  getDb,
  getScheduledTasksDue,
  updateTaskNextRun,
  upsertChat,
} from "./db";

// getDb is a process-wide singleton; create a chat so the FK on
// scheduled_tasks.chat_id is satisfied (foreign_keys = ON).
function makeDb() {
  const db = getDb(mkdtempSync(join(tmpdir(), "angel-db-test-")));
  const chatId = upsertChat(db, "test", "db-test-chat", "test");
  return { db, chatId };
}

function pastIso(): string {
  return new Date(Date.now() - 60_000).toISOString();
}

function futureIso(): string {
  return new Date(Date.now() + 60_000).toISOString();
}

describe("scheduled task claiming", () => {
  test("only one tick can claim a due task", () => {
    const { db, chatId } = makeDb();
    const id = createScheduledTask(db, chatId, "t", "prompt", null, pastIso());

    expect(getScheduledTasksDue(db)).toHaveLength(1);
    expect(claimScheduledTask(db, id)).toBe(true);
    // Second claim loses: the row is no longer 'active'.
    expect(claimScheduledTask(db, id)).toBe(false);
    // Claimed tasks are no longer due.
    expect(getScheduledTasksDue(db)).toHaveLength(0);
  });

  test("a claimed task is not visible to other ticks", () => {
    const { db, chatId } = makeDb();
    const id = createScheduledTask(db, chatId, "t2", "prompt", null, pastIso());
    claimScheduledTask(db, id);
    expect(getScheduledTasksDue(db)).toHaveLength(0);
  });

  test("rescheduling reactivates a claimed task", () => {
    const { db, chatId } = makeDb();
    const id = createScheduledTask(db, chatId, "t3", "prompt", null, pastIso());
    claimScheduledTask(db, id);
    expect(getScheduledTasksDue(db)).toHaveLength(0);

    // Cron tasks reschedule for the future: active again, not due.
    updateTaskNextRun(db, id, futureIso());
    expect(getScheduledTasksDue(db)).toHaveLength(0);
    // But once due, it can be claimed again.
    updateTaskNextRun(db, id, pastIso());
    expect(getScheduledTasksDue(db)).toHaveLength(1);
    expect(claimScheduledTask(db, id)).toBe(true);
  });
});
