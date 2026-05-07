import type { Database } from "bun:sqlite";
import { CronExpressionParser } from "cron-parser";
import { processMessage } from "./agent";
import type { ChannelRegistry } from "./channels/types";
import { splitMessage } from "./channels/types";
import type { AngelConfig } from "./config";
import {
  getScheduledTasksDue,
  insertTaskDlq,
  logSystemEvent,
  updateTaskNextRun,
  updateTaskStatus,
} from "./db";
import type { ToolRegistry } from "./tools/registry";

const TICK_INTERVAL = 15_000;

export function startScheduler(
  db: Database,
  config: AngelConfig,
  registry: ToolRegistry,
  channels: ChannelRegistry,
) {
  console.log("[angel] Scheduler started (15s tick)");

  setInterval(async () => {
    try {
      await tick(db, config, registry, channels);
    } catch (err: any) {
      console.error(`[angel] Scheduler tick error: ${err.message}`);
    }
  }, TICK_INTERVAL);
}

async function tick(
  db: Database,
  config: AngelConfig,
  registry: ToolRegistry,
  channels: ChannelRegistry,
) {
  const dueTasks = getScheduledTasksDue(db);
  for (const task of dueTasks) {
    try {
      const chatRow = db
        .query("SELECT * FROM chats WHERE id = ?")
        .get(task.chat_id) as any;
      if (!chatRow) {
        updateTaskStatus(db, task.id, "failed");
        continue;
      }

      const start = Date.now();
      const sentTracker = { value: false };
      const rawResult = await processMessage(task.prompt, {
        chatId: task.chat_id,
        channel: chatRow.channel,
        db,
        config,
        registry,
        senderName: "system",
        contextTag: "scheduler",
        usedSendMessage: sentTracker,
      });
      const durationMs = Date.now() - start;
      if (typeof rawResult !== "string") continue;
      const result = rawResult;

      db.run(
        `INSERT INTO task_run_logs (task_id, chat_id, started_at, finished_at, duration_ms, success, result_summary)
         VALUES (?, ?, datetime('now', '-' || ? || ' seconds'), datetime('now'), ?, 1, ?)`,
        [
          task.id,
          task.chat_id,
          Math.floor(durationMs / 1000),
          durationMs,
          result.slice(0, 500),
        ],
      );
      db.run("UPDATE scheduled_tasks SET retry_count = 0 WHERE id = ?", [
        task.id,
      ]);

      if (!sentTracker.value) {
        const adapter = channels.get(chatRow.channel);
        if (adapter && result) {
          const chunks = splitMessage(result, adapter.maxMessageLength || 4000);
          for (const chunk of chunks) {
            await adapter.sendText(chatRow.external_chat_id, chunk);
            if (chunks.length > 1) await sleep(500);
          }
        }
      }

      if (task.cron_expr) {
        const next = getNextCronRun(task.cron_expr, task.timezone);
        updateTaskNextRun(db, task.id, next);
      } else {
        updateTaskStatus(db, task.id, "completed");
      }
    } catch (err: any) {
      console.error(`[angel] Task ${task.id} failed: ${err.message}`);
      db.run(
        `INSERT INTO task_run_logs (task_id, chat_id, started_at, finished_at, duration_ms, success, result_summary)
         VALUES (?, ?, datetime('now'), datetime('now'), 0, 0, ?)`,
        [task.id, task.chat_id, err.message.slice(0, 500)],
      );
      const retryCount = (task.retry_count || 0) + 1;

      if (retryCount >= (task.max_retries || 3)) {
        const healed = await runTaskFallback(
          task,
          db,
          config,
          registry,
          channels,
          err.message,
        );
        if (!healed) {
          updateTaskStatus(db, task.id, "failed");
          insertTaskDlq(
            db,
            task.id,
            task.chat_id,
            err.message,
            task.prompt,
            retryCount,
          );
        } else if (task.cron_expr) {
          const next = getNextCronRun(task.cron_expr, task.timezone);
          updateTaskNextRun(db, task.id, next);
          db.run("UPDATE scheduled_tasks SET retry_count = 0 WHERE id = ?", [
            task.id,
          ]);
        } else {
          updateTaskStatus(db, task.id, "completed");
          db.run("UPDATE scheduled_tasks SET retry_count = 0 WHERE id = ?", [
            task.id,
          ]);
        }
      } else {
        db.run("UPDATE scheduled_tasks SET retry_count = ? WHERE id = ?", [
          retryCount,
          task.id,
        ]);
        const backoffMinutes = 2 ** retryCount;
        const nextRetry = new Date(
          Date.now() + backoffMinutes * 60_000,
        ).toISOString();
        updateTaskNextRun(db, task.id, nextRetry);
      }
    }
  }

  await tickProactiveRules(db, config, channels);
}

export function getNextCronRun(cronExpr: string, timezone = "UTC"): string {
  const expr = CronExpressionParser.parse(cronExpr, { tz: timezone });
  const next = expr.next();
  return next!.toISOString() as string;
}

function toSqliteDatetime(iso: string): string {
  return iso
    .replace("T", " ")
    .replace(/\.\d+Z$/, "")
    .replace(/Z$/, "");
}

function isDue(dateText: string | null): boolean {
  if (!dateText) return false;
  const normalized = dateText.includes("T")
    ? dateText
    : `${dateText.replace(" ", "T")}Z`;
  const time = new Date(normalized).getTime();
  return Number.isFinite(time) && time <= Date.now();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runTaskFallback(
  task: any,
  db: Database,
  config: AngelConfig,
  registry: ToolRegistry,
  channels: ChannelRegistry,
  originalError: string,
): Promise<boolean> {
  if (!task.fallback_prompt) return false;
  try {
    const chatRow = db
      .query("SELECT * FROM chats WHERE id = ?")
      .get(task.chat_id) as any;
    if (!chatRow) return false;

    const sentTracker = { value: false };
    const fallbackResult = await processMessage(task.fallback_prompt, {
      chatId: task.chat_id,
      channel: chatRow.channel,
      db,
      config,
      registry,
      senderName: "system",
      contextTag: "scheduler_fallback",
      usedSendMessage: sentTracker,
    });

    if (typeof fallbackResult !== "string") return false;

    if (!sentTracker.value && fallbackResult) {
      const adapter = channels.get(chatRow.channel);
      if (adapter) {
        const chunks = splitMessage(
          fallbackResult,
          adapter.maxMessageLength || 4000,
        );
        for (const chunk of chunks) {
          await adapter.sendText(chatRow.external_chat_id, chunk);
          if (chunks.length > 1) await sleep(500);
        }
      }
    }

    logSystemEvent(
      db,
      "task_self_heal_success",
      "warn",
      `Task ${task.id} recovered with fallback after error: ${originalError}`,
      chatRow.channel,
    );
    return true;
  } catch (err: any) {
    logSystemEvent(
      db,
      "task_self_heal_failed",
      "error",
      `Task ${task.id} fallback failed: ${err.message}`,
    );
    return false;
  }
}

async function tickProactiveRules(
  db: Database,
  config: AngelConfig,
  channels: ChannelRegistry,
) {
  if (!config.proactive.enabled) return;

  const rules = db
    .query(
      "SELECT * FROM proactive_rules WHERE status = 'active' ORDER BY id ASC LIMIT 100",
    )
    .all() as any[];

  for (const rule of rules) {
    try {
      const chat = db
        .query("SELECT * FROM chats WHERE id = ?")
        .get(rule.chat_id) as any;
      if (!chat) continue;
      const adapter = channels.get(chat.channel);
      if (!adapter) continue;

      if (rule.trigger_type === "cron") {
        if (!isDue(rule.next_run_at)) {
          continue;
        }
        const chunks = splitMessage(
          String(rule.message_template || "").trim(),
          adapter.maxMessageLength || 4000,
        );
        for (const chunk of chunks)
          await adapter.sendText(chat.external_chat_id, chunk);
        const next = getNextCronRun(rule.cron_expr, config.timezone);
        db.run(
          "UPDATE proactive_rules SET next_run_at = ?, last_triggered_at = datetime('now') WHERE id = ?",
          [toSqliteDatetime(next), rule.id],
        );
        continue;
      }

      if (rule.trigger_type === "inactivity") {
        const lastUser = db
          .query(
            "SELECT timestamp FROM messages WHERE chat_id = ? AND is_from_bot = 0 ORDER BY timestamp DESC LIMIT 1",
          )
          .get(rule.chat_id) as { timestamp: string } | null;
        if (!lastUser?.timestamp) continue;

        const threshold = Number(
          rule.threshold_minutes || config.proactive.inactivity_default_minutes,
        );
        const minutesSince =
          (Date.now() - new Date(lastUser.timestamp).getTime()) / (1000 * 60);
        if (minutesSince < threshold) continue;

        const lastTriggered = rule.last_triggered_at
          ? new Date(rule.last_triggered_at).getTime()
          : 0;
        if (
          lastTriggered > 0 &&
          Date.now() - lastTriggered < Math.max(30, threshold / 2) * 60_000
        ) {
          continue;
        }

        const rendered = String(rule.message_template || "").replace(
          /\{\{last_seen_minutes\}\}/g,
          String(Math.floor(minutesSince)),
        );
        const chunks = splitMessage(rendered, adapter.maxMessageLength || 4000);
        for (const chunk of chunks)
          await adapter.sendText(chat.external_chat_id, chunk);
        db.run(
          "UPDATE proactive_rules SET last_triggered_at = datetime('now') WHERE id = ?",
          [rule.id],
        );
      }
    } catch (err: any) {
      logSystemEvent(
        db,
        "proactive_rule_error",
        "error",
        `Rule ${rule.id} failed: ${err.message}`,
      );
    }
  }
}
