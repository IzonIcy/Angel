import type { Database } from "bun:sqlite";
import { INTERRUPTED, processMessage } from "./agent";
import {
  type ChannelAdapter,
  type ChannelRegistry,
  type IncomingMessage,
  type MessageHandler,
  sendChunked,
} from "./channels/types";
import { handleCommand } from "./commands";
import type { AngelConfig } from "./config";
import { storeMessage, upsertChat } from "./db";
import { handleExplicitMemory, scheduleReflector } from "./memory";
import type { ToolRegistry } from "./tools/registry";

export interface MessageHandlerDeps {
  db: Database;
  config: AngelConfig;
  registry: ToolRegistry;
  channels: ChannelRegistry;
  /** Invoked when the user issues the /restart command. */
  onRestart: () => void;
}

function getAllowedUsers(
  db: Database,
  channel: string,
  configList?: string[],
): Set<string> | null {
  const dbRows = db
    .query("SELECT user_id FROM allowed_users WHERE channel = ?")
    .all(channel) as { user_id: string }[];

  const combined = new Set<string>();
  if (configList) for (const u of configList) combined.add(u);
  for (const row of dbRows) combined.add(row.user_id);

  return combined.size > 0 ? combined : null;
}

/**
 * True when `chatId` is the chat Angel chose for first-time onboarding.
 * Requires onboarding to still be in progress (onboarded flag unset).
 */
function isOnboardingChat(db: Database, chatId: number): boolean {
  const onboarded = db
    .query("SELECT value FROM db_meta WHERE key = 'onboarded'")
    .get() as { value: string } | null;
  if (onboarded) return false;

  const chatRow = db
    .query("SELECT value FROM db_meta WHERE key = 'onboarding_chat'")
    .get() as { value: string } | null;
  return !!chatRow && parseInt(chatRow.value, 10) === chatId;
}

export function createMessageHandler(deps: MessageHandlerDeps): MessageHandler {
  const { db, config, registry, channels, onRestart } = deps;
  const activeChats: Map<number, AbortController> = new Map();

  const send = (
    adapter: ChannelAdapter | undefined,
    externalChatId: string,
    text: string,
  ): Promise<void> => sendChunked(adapter, externalChatId, text);

  return async (msg: IncomingMessage): Promise<void> => {
    const channelKey = msg.chatType.split("_")[0];
    const adapter = channels.get(channelKey);

    const channelConfig = (
      config.channels as Record<
        string,
        { enabled?: boolean; allowed_users?: string[] } | undefined
      >
    )[channelKey];
    const allowedUsers = getAllowedUsers(
      db,
      channelKey,
      channelConfig?.allowed_users,
    );
    if (allowedUsers && !allowedUsers.has(msg.senderName)) {
      return;
    }

    const chatId = upsertChat(
      db,
      channelKey,
      msg.externalChatId,
      msg.chatType,
      msg.senderName,
    );

    // Handle reactions: log them and store in message history for context,
    // but don't trigger a full LLM response (reactions are informational)
    if (msg.isReaction) {
      console.log(`[angel] Received reaction in chat ${chatId}: ${msg.text}`);
      storeMessage(db, chatId, "user", msg.text, {
        senderName: msg.senderName,
      });
      return;
    }

    const existing = activeChats.get(chatId);
    if (existing) {
      existing.abort();
      await new Promise((r) => setTimeout(r, 50));
    }

    const controller = new AbortController();
    activeChats.set(chatId, controller);

    const memoryResult = handleExplicitMemory(msg.text, db, chatId);
    if (memoryResult) {
      await send(adapter, msg.externalChatId, memoryResult);
      return;
    }

    const cmdResult = handleCommand(msg.text, chatId, db, config);
    if (cmdResult.handled) {
      await send(adapter, msg.externalChatId, cmdResult.text);
      if (cmdResult.action === "restart") onRestart();
      return;
    }

    // Onboarding: assign the first message's chat as the onboarding chat and
    // mark Angel as onboarded once enough profile memories are gathered.
    const onboarded = db
      .query("SELECT value FROM db_meta WHERE key = 'onboarded'")
      .get() as { value: string } | null;
    if (!onboarded) {
      const msgCount = db
        .query("SELECT COUNT(*) as count FROM messages WHERE chat_id = ?")
        .get(chatId) as { count: number };
      if (msgCount.count === 0) {
        db.run(
          "INSERT OR REPLACE INTO db_meta (key, value) VALUES ('onboarding_chat', ?)",
          [String(chatId)],
        );
      }
      const onboardingChat = db
        .query("SELECT value FROM db_meta WHERE key = 'onboarding_chat'")
        .get() as { value: string } | null;
      if (onboardingChat && parseInt(onboardingChat.value, 10) === chatId) {
        const memories = db
          .query(
            "SELECT COUNT(*) as count FROM memories WHERE category = 'profile'",
          )
          .get() as { count: number };
        if (memories.count >= 3) {
          db.run(
            "INSERT OR REPLACE INTO db_meta (key, value) VALUES ('onboarded', '1')",
          );
        }
      }
    }

    let typingInterval: ReturnType<typeof setInterval> | null = null;
    if (adapter?.sendTyping) {
      adapter.sendTyping(msg.externalChatId);
      typingInterval = setInterval(
        () => adapter.sendTyping!(msg.externalChatId),
        4000,
      );
    }

    try {
      const image = msg.imageBase64
        ? {
            base64: msg.imageBase64,
            mimeType: msg.imageMimeType || "image/jpeg",
          }
        : undefined;
      const isOnboarding = isOnboardingChat(db, chatId);
      const userText = msg.isGroupMention
        ? `[${msg.senderName}]: ${msg.text}`
        : msg.text;

      const response = await processMessage(
        userText,
        {
          chatId,
          channel: channelKey,
          db,
          config,
          registry,
          isOnboarding,
          signal: controller.signal,
          senderName: msg.senderName,
          senderDmId: msg.isGroupMention
            ? msg.senderDmId || msg.senderName
            : undefined,
          sendIntermediate: (text) => send(adapter, msg.externalChatId, text),
        },
        image,
      );

      if (typingInterval) {
        clearInterval(typingInterval);
        typingInterval = null;
      }

      if (response === INTERRUPTED) {
        console.log(`[angel] Chat ${chatId} interrupted by new message`);
        return;
      }

      if (typeof response === "string" && response) {
        await send(adapter, msg.externalChatId, response);
      }

      scheduleReflector(
        db,
        chatId,
        config,
        [msg.text, response].filter(Boolean),
      );
    } catch (err: unknown) {
      if (typingInterval) {
        clearInterval(typingInterval);
        typingInterval = null;
      }
      if (controller.signal.aborted) return;
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[angel] Error processing message: ${message}`);
      if (adapter) {
        await send(
          adapter,
          msg.externalChatId,
          "Sorry, I encountered an error processing your message.",
        );
      }
    } finally {
      if (activeChats.get(chatId) === controller) activeChats.delete(chatId);
    }
  };
}
