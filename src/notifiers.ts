import type { Database } from "bun:sqlite";
import { processMessage } from "./agent";
import { type ChannelRegistry, sendChunked } from "./channels/types";
import type { AngelConfig } from "./config";
import { upsertChat } from "./db";
import {
  type BackgroundProcess,
  setBackgroundProcessNotifier,
} from "./tools/background_processes";
import {
  type RunningAgent,
  setCodingAgentNotifier,
  setCodingAgentProgressNotifier,
} from "./tools/coding_agents";
import type { ToolRegistry } from "./tools/registry";

export interface NotifierDeps {
  db: Database;
  config: AngelConfig;
  registry: ToolRegistry;
  channels: ChannelRegistry;
}

/**
 * Wire the long-running coding-agent / background-process subsystems back to
 * the chat channels, so users get progress updates and results.
 */
export function setupNotifiers(deps: NotifierDeps): void {
  const { db, config, registry, channels } = deps;

  const resolveChatId = (channel: string, externalChatId: string): number =>
    upsertChat(db, channel, externalChatId, channel, "system");

  setCodingAgentNotifier(async (agent: RunningAgent, message: string) => {
    const adapter = channels.get(agent.channel);
    if (!adapter || !agent.externalChatId) return;

    const chatId = resolveChatId(agent.channel, agent.externalChatId);
    const syntheticInput = `[System: coding agent "${agent.agent}" just finished a task. Here is the raw output — summarize it for me in your own words and let me know what happened.]\n\nOriginal task: ${agent.prompt}\n\n${message}`;
    try {
      const response = await processMessage(syntheticInput, {
        chatId,
        channel: agent.channel,
        db,
        config,
        registry,
        isOnboarding: false,
        senderName: "system",
        contextTag: "system_summary",
      });
      if (typeof response === "string" && response) {
        await sendChunked(adapter, agent.externalChatId, response);
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      console.error(`[angel] Error processing agent result: ${detail}`);
      await sendChunked(adapter, agent.externalChatId, message);
    }
  });

  // Send progress updates for long-running coding agents
  setCodingAgentProgressNotifier(
    async (agent: RunningAgent, progressMessage: string) => {
      const adapter = channels.get(agent.channel);
      if (!adapter || !agent.externalChatId) return;
      try {
        await sendChunked(
          adapter,
          agent.externalChatId,
          `[${agent.agent} #${agent.id}] ${progressMessage}`,
        );
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        console.error(`[angel] Error sending progress: ${detail}`);
      }
    },
  );

  setBackgroundProcessNotifier(
    async (proc: BackgroundProcess, message: string) => {
      const adapter = channels.get(proc.channel);
      if (!adapter || !proc.externalChatId) return;
      try {
        await sendChunked(adapter, proc.externalChatId, message);
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        console.error(`[angel] Error notifying process exit: ${detail}`);
      }
    },
  );
}
