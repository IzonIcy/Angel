/**
 * Per-chat serialization for processMessage.
 *
 * processMessage is invoked from four entry points — the message handler
 * (user messages), the scheduler (cron tasks), the notifiers (coding-agent
 * completions), and the subagent tool. All of them load, mutate, and save the
 * same per-chat session row, so concurrent runs on one chatId were corrupting
 * sessions and duplicating side effects.
 *
 * This mutex serializes every run per chatId. The interrupt flow still works:
 * the message handler aborts the previous run's controller before starting a
 * new one, and because the abort signal now cancels the in-flight LLM call,
 * the previous run winds down quickly and releases the lock.
 */

const queues = new Map<number, Promise<void>>();

/**
 * Run `fn` exclusively for `chatId`. Concurrent callers for the same chat
 * wait in FIFO order. Runs for different chats proceed in parallel.
 */
export async function withChatLock<T>(
  chatId: number,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = queues.get(chatId) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((resolve) => (release = resolve));
  queues.set(chatId, next);

  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (queues.get(chatId) === next) queues.delete(chatId);
  }
}
