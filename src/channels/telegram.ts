import type { ChannelAdapter, IncomingMessage, MessageHandler } from "./types";

/**
 * Telegram Bot API channel — plain HTTPS long polling, no SDK needed.
 *
 * Requires a bot token from @BotFather. Set `enabled: true` and `token` in
 * the `telegram` section of angel.config.yaml.
 */
export class TelegramChannel implements ChannelAdapter {
  name = "telegram";
  maxMessageLength = 4096;
  private handler: MessageHandler | null = null;
  private token: string;
  private offset = 0;
  private abort: AbortController | null = null;

  constructor(token: string) {
    this.token = token;
  }

  private api<T>(method: string, body?: object): Promise<T> {
    return fetch(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body ?? {}),
      signal: this.abort?.signal,
    }).then(async (res) => {
      const payload = (await res.json()) as {
        ok: boolean;
        result?: T;
        description?: string;
      };
      if (!payload.ok) {
        throw new Error(payload.description ?? `telegram ${method} failed`);
      }
      return payload.result as T;
    });
  }

  async start(onMessage: MessageHandler): Promise<void> {
    this.handler = onMessage;
    this.abort = new AbortController();

    // Drop the backlog so a restart doesn't replay old messages.
    const me = await this.api<{ id: number }>("/getMe");
    console.log(`[angel] Telegram bot @${me.id} polling`);

    void this.pollLoop();
  }

  private async pollLoop(): Promise<void> {
    let backoffMs = 1000;
    while (this.abort && !this.abort.signal.aborted) {
      try {
        const updates = await this.api<
          Array<{
            update_id: number;
            message?: TgMessage;
          }>
        >("/getUpdates", { offset: this.offset, timeout: 30 });

        for (const update of updates) {
          this.offset = update.update_id + 1;
          const msg = update.message;
          if (!msg?.text) continue;

          const incoming: IncomingMessage = {
            externalChatId: String(msg.chat.id),
            chatType: `telegram_${msg.chat.type}`,
            senderName:
              msg.from?.username ??
              [msg.from?.first_name, msg.from?.last_name]
                .filter(Boolean)
                .join(" ") ??
              "unknown",
            senderId: msg.from?.id != null ? String(msg.from.id) : undefined,
            text: msg.text,
            replyToMessageId: msg.reply_to_message?.message_id
              ? String(msg.reply_to_message.message_id)
              : undefined,
          };
          await this.handler?.(incoming);
        }
        backoffMs = 1000;
      } catch (err) {
        if (this.abort?.signal.aborted) return;
        console.error(`[angel] telegram poll error: ${(err as Error).message}`);
        await new Promise((r) => setTimeout(r, backoffMs));
        backoffMs = Math.min(backoffMs * 2, 30_000);
      }
    }
  }

  async stop(): Promise<void> {
    this.abort?.abort();
    this.handler = null;
  }

  async sendText(externalChatId: string, text: string): Promise<void> {
    await this.api("/sendMessage", {
      chat_id: externalChatId,
      text,
    });
  }

  async sendTyping(externalChatId: string): Promise<void> {
    try {
      await this.api("/sendChatAction", {
        chat_id: externalChatId,
        action: "typing",
      });
    } catch {
      // typing indicator is best-effort
    }
  }
}

type TgUser = {
  /** Stable numeric user id from the Bot API — the only non-spoofable identity. */
  id?: number;
  username?: string;
  first_name?: string;
  last_name?: string;
};

type TgMessage = {
  message_id: number;
  chat: { id: number; type: string };
  from?: TgUser;
  text?: string;
  reply_to_message?: { message_id: number };
};
