/**
 * Per-sender rate limiting shared by all channels.
 *
 * Fixed-window counters keyed by `channel:sender`. Configured via:
 *
 *   security:
 *     max_messages_per_minute: 30   # 0 disables limiting
 */

export type RateLimitVerdict = {
  allowed: boolean;
  /** Seconds until the sender may retry (0 when allowed). */
  retryAfterSeconds: number;
};

/** Sender keys tracked before expired windows are pruned. */
const MAX_TRACKED_SENDERS = 5_000;

export class SenderRateLimiter {
  private counts = new Map<string, { windowStart: number; count: number }>();
  private readonly maxPerMinute: number;

  constructor(maxPerMinute = 0) {
    this.maxPerMinute = Math.max(0, Math.floor(maxPerMinute));
  }

  /** Whether this (channel, sender) may proceed right now. */
  check(
    channelKey: string,
    senderName: string,
    nowMs = Date.now(),
  ): RateLimitVerdict {
    if (this.maxPerMinute === 0) {
      return { allowed: true, retryAfterSeconds: 0 };
    }

    const key = `${channelKey}:${senderName}`;
    const windowLengthMs = 60_000;
    const entry = this.counts.get(key);

    // Public channels see one unique sender key per participant, and keys
    // were never evicted — an unbounded memory leak. Prune expired windows
    // once the map grows past a bound instead of relying on callers to
    // remember to schedule prune().
    if (this.counts.size >= MAX_TRACKED_SENDERS) {
      this.prune(nowMs);
      if (this.counts.size >= MAX_TRACKED_SENDERS) {
        this.counts.clear();
      }
    }

    if (!entry || nowMs - entry.windowStart >= windowLengthMs) {
      this.counts.set(key, { windowStart: nowMs, count: 1 });
      return { allowed: true, retryAfterSeconds: 0 };
    }

    if (entry.count < this.maxPerMinute) {
      entry.count += 1;
      return { allowed: true, retryAfterSeconds: 0 };
    }

    const retryAfterSeconds = Math.ceil(
      (entry.windowStart + windowLengthMs - nowMs) / 1000,
    );
    return { allowed: false, retryAfterSeconds };
  }

  /** Drop expired windows so the map doesn't grow forever. */
  prune(nowMs = Date.now()): void {
    for (const [key, entry] of this.counts) {
      if (nowMs - entry.windowStart >= 60_000) {
        this.counts.delete(key);
      }
    }
  }
}
