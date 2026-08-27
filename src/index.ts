#!/usr/bin/env bun
import * as p from "@clack/prompts";
import color from "picocolors";
import pkg from "../package.json";

import { DiscordChannel } from "./channels/discord";
import { iMessageChannel } from "./channels/imessage";
import { SignalChannel } from "./channels/signal";
import { SlackChannel } from "./channels/slack";
import { TelegramChannel } from "./channels/telegram";
import { ChannelRegistry } from "./channels/types";
import {
  type ChannelConfig,
  configExists,
  configPath,
  loadConfig,
  unresolvedEnvVars,
} from "./config";
import { startDashboard } from "./dashboard";
import { getDb, logSystemEvent } from "./db";
import { runDoctor } from "./doctor";
import { hasRoseOAuthCredentials, isClaudeModel } from "./llm";
import { initMcpServers, shutdownMcpServers } from "./mcp";
import { createMessageHandler } from "./message_handler";
import { setupNotifiers } from "./notifiers";
import { loadPlugins } from "./plugins";
import { startScheduler } from "./scheduler";
import { runSetup } from "./setup";
import { discoverSkills } from "./skills";
import { runSmokeCli } from "./smoke";
import { advancedTools } from "./tools/advanced";
import {
  backgroundProcessTools,
  killAllBackgroundProcesses,
  persistBackgroundProcesses,
  restoreBackgroundProcesses,
  setBackgroundProcessDataDir,
} from "./tools/background_processes";
import { bashTool } from "./tools/bash";
import { browserTool } from "./tools/browser";
import {
  codingAgentTools,
  killAllCodingAgents,
  listCodingAgentsTool,
  persistRunningAgents,
  restoreRunningAgents,
  setCodingAgentDataDir,
} from "./tools/coding_agents";
import { confirmationTools } from "./tools/confirmation";
import { emitMessageTool } from "./tools/emit_message";
import { fileTools } from "./tools/files";
import { memoryTools } from "./tools/memory";
import { miscTools } from "./tools/misc";
import {
  createPolicyBypass,
  type ToolContext,
  ToolRegistry,
} from "./tools/registry";
import { remoteTools } from "./tools/remote";
import { scheduleTools } from "./tools/schedule";
import { sendMessageTool, setSendMessageDeps } from "./tools/send_message";
import { subagentTools } from "./tools/subagent";
import { webTools } from "./tools/web";

const VERSION: string = pkg.version;
const args = process.argv.slice(2);
const command = args[0] || "start";

function printHelp() {
  console.log(`
  ${color.bgCyan(color.black(" angel "))} ${color.dim(`v${VERSION}`)}

  ${color.bold("Usage:")} angel <command>

  ${color.bold("Commands:")}
    ${color.cyan("start")}       Start the agent ${color.dim("(default)")}
    ${color.cyan("setup")}       Interactive setup wizard
    ${color.cyan("doctor")}      Run diagnostics and health checks
    ${color.cyan("smoke")}       Run credentialed external integration smoke checks
    ${color.cyan("config")}      Show current configuration
    ${color.cyan("config path")} Show config file path
    ${color.cyan("config edit")} Open config in $EDITOR
    ${color.cyan("agents")}      Show installed coding agents
    ${color.cyan("reset")}       Reset onboarding and profile data
    ${color.cyan("version")}     Show version
    ${color.cyan("help")}        Show this help

  ${color.bold("Examples:")}
    ${color.dim("$")} angel              ${color.dim("# starts the agent")}
    ${color.dim("$")} angel setup        ${color.dim("# run setup wizard")}
    ${color.dim("$")} angel doctor       ${color.dim("# check everything works")}
    ${color.dim("$")} angel smoke        ${color.dim("# verify configured external integrations")}
`);
}

switch (command) {
  case "setup":
    await runSetup();
    break;

  case "doctor":
    await runDoctor();
    break;

  case "smoke":
    await runSmokeCli();
    break;

  case "version":
  case "v":
    console.log(`angel v${VERSION}`);
    break;

  case "help":
  case "h":
    printHelp();
    break;

  case "config": {
    const sub = args[1];
    if (sub === "path") {
      console.log(configPath());
    } else if (sub === "edit") {
      const editor = process.env.EDITOR || "nano";
      const proc = Bun.spawn([editor, configPath()], {
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      });
      await proc.exited;
    } else {
      if (!configExists()) {
        p.log.warn(`No config found. Run ${color.cyan("angel setup")} first.`);
        break;
      }
      const config = loadConfig();
      const enabledChannels = (
        Object.entries(config.channels) as Array<
          [string, ChannelConfig | undefined]
        >
      )
        .filter(([, v]) => v?.enabled !== false)
        .map(([k]) => k);
      p.intro(color.bgCyan(color.black(" angel config ")));
      p.log.info(`Model:      ${color.cyan(config.model)}`);
      p.log.info(`Max tokens: ${color.cyan(String(config.max_tokens))}`);
      p.log.info(`Timezone:   ${color.cyan(config.timezone)}`);
      p.log.info(
        `Channels:   ${enabledChannels.length ? color.cyan(enabledChannels.join(", ")) : color.dim("none")}`,
      );
      p.log.info(`Data dir:   ${color.dim(config.data_dir)}`);
      p.log.info(`Config:     ${color.dim(configPath())}`);
      p.outro("");
    }
    break;
  }

  case "reset": {
    if (!configExists()) {
      p.log.warn("Nothing to reset — no config found.");
      break;
    }
    const confirm = await p.confirm({
      message:
        "This will clear your onboarding data and profile memories. Continue?",
    });
    if (p.isCancel(confirm) || !confirm) {
      p.cancel("Reset cancelled.");
      break;
    }
    const config = loadConfig();
    const db = getDb(config.data_dir);
    db.run("DELETE FROM db_meta WHERE key IN ('onboarded', 'onboarding_chat')");
    db.run("DELETE FROM memories WHERE category = 'profile'");
    p.log.success(
      "Onboarding and profile data cleared. Next message will restart onboarding.",
    );
    break;
  }

  case "agents": {
    const config = loadConfig();
    const db = getDb(config.data_dir);
    const ctx: ToolContext = {
      chatId: 0,
      channel: "cli",
      workingDir: process.cwd(),
      db,
      config,
      skipPolicy: createPolicyBypass(),
    };
    p.intro(color.bgCyan(color.black(" angel agents ")));
    const result = await listCodingAgentsTool.execute({}, ctx);
    for (const line of result.output.split("\n")) {
      const installed = line.includes("installed (");
      if (installed) {
        p.log.success(line);
      } else {
        p.log.warn(line);
      }
    }
    p.outro(
      "Angel can use any installed agent via the spawn_coding_agent tool.",
    );
    break;
  }

  case "start":
    await boot();
    break;

  default:
    console.log(`\n  Unknown command: ${color.red(command)}\n`);
    printHelp();
    process.exit(1);
}

async function boot() {
  if (!configExists()) {
    p.log.warn("No config found. Running setup...");
    await runSetup();
    return;
  }

  p.intro(color.bgCyan(color.black(" angel ")));

  // Last-resort net: a stray async rejection from plugin/hook/MCP code must
  // not silently terminate an always-on daemon (Bun's default is fatal).
  process.on("unhandledRejection", (reason) => {
    console.error(
      `[angel] unhandled rejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`,
    );
  });

  const config = loadConfig();
  if (unresolvedEnvVars.size > 0) {
    p.log.warn(
      `Unresolved \${ENV_VAR} references in config: ${[...unresolvedEnvVars].join(", ")}. ` +
        `The affected values are empty strings — check for typos.`,
    );
    unresolvedEnvVars.clear();
  }
  // Only the credential required by the configured model is fatal. An
  // Anthropic-only setup should not be blocked for lacking an OpenAI key,
  // and Claude models can authenticate via Rose OAuth instead of an API key.
  const needsOpenAIKey = !isClaudeModel(config.model);
  const needsAnthropicKey = isClaudeModel(config.model);
  if (needsOpenAIKey && !config.openai_api_key) {
    p.log.error(`openai_api_key not set. Run ${color.cyan("bun run setup")}.`);
    process.exit(1);
  }
  if (
    needsAnthropicKey &&
    !config.anthropic_api_key &&
    !hasRoseOAuthCredentials()
  ) {
    p.log.error(
      `anthropic_api_key not set (required for model "${config.model}") and no Rose OAuth credentials found. Run ${color.cyan("bun run setup")}.`,
    );
    process.exit(1);
  }
  if (!needsOpenAIKey && !config.openai_api_key) {
    p.log.warn(
      `openai_api_key not set — fine while model "${config.model}" routes via Anthropic.`,
    );
  }

  const db = getDb(config.data_dir);
  const registry = new ToolRegistry();
  const channels = new ChannelRegistry();

  setCodingAgentDataDir(config.data_dir);
  setBackgroundProcessDataDir(config.data_dir);

  registry.register(bashTool);
  registry.registerMany(fileTools);
  registry.registerMany(webTools);
  registry.registerMany(miscTools);
  registry.registerMany(advancedTools);
  registry.registerMany(memoryTools);
  registry.registerMany(scheduleTools);
  registry.registerMany(subagentTools);
  registry.register(sendMessageTool);
  registry.register(emitMessageTool);
  registry.register(browserTool);
  registry.registerMany(codingAgentTools);
  registry.registerMany(backgroundProcessTools);
  registry.registerMany(confirmationTools);
  registry.registerMany(remoteTools);

  const mcpTools = await initMcpServers(config);
  registry.registerMany(mcpTools);

  const skillTools = discoverSkills(config);
  registry.registerMany(skillTools);

  const pluginTools = loadPlugins(config);
  registry.registerMany(pluginTools);

  setSendMessageDeps(channels, db);

  if (config.channels.imessage?.enabled) {
    channels.register(
      new iMessageChannel(
        config.channels.imessage.imsg_path,
        config.channels.imessage.service,
        config.channels.imessage.region,
        config.channels.imessage.allowed_handles,
      ),
    );
  }
  if (config.channels.discord?.enabled && config.channels.discord.token) {
    channels.register(
      new DiscordChannel(
        config.channels.discord.token,
        config.channels.discord.bot_username,
      ),
    );
  }
  if (
    config.channels.slack?.enabled &&
    config.channels.slack.bot_token &&
    config.channels.slack.app_token
  ) {
    channels.register(
      new SlackChannel(
        config.channels.slack.bot_token,
        config.channels.slack.app_token,
      ),
    );
  }
  if (config.channels.signal?.enabled && config.channels.signal.account) {
    channels.register(
      new SignalChannel(
        config.channels.signal.account,
        config.channels.signal.signal_cli_path,
        config.channels.signal.allowed_numbers,
      ),
    );
  }
  if (config.channels.telegram?.enabled && config.channels.telegram.token) {
    channels.register(
      new TelegramChannel(
        config.channels.telegram.token,
        config.channels.telegram.allowed_users,
      ),
    );
  }

  const messageHandler = createMessageHandler({
    db,
    config,
    registry,
    channels,
    onRestart: () => void doRestart(channels),
  });

  const channelHealth = await channels.startAll(messageHandler);
  for (const health of channelHealth) {
    logSystemEvent(
      db,
      health.status === "failed" ? "channel_start_failed" : "channel_started",
      health.status === "failed" ? "error" : "info",
      health.lastError || health.status,
      health.name,
    );
  }

  if (config.dashboard?.enabled) {
    startDashboard({ config, db, startedAt: Date.now() });
  }

  setupNotifiers({ db, config, registry, channels });

  const restoredAgents = restoreRunningAgents();
  if (restoredAgents > 0) {
    p.log.info(
      `Restored ${color.cyan(String(restoredAgents))} coding agent(s) from previous session`,
    );
  }

  const restoredProcesses = restoreBackgroundProcesses();
  if (restoredProcesses > 0) {
    p.log.info(
      `Restored ${color.cyan(String(restoredProcesses))} background process(es) from previous session`,
    );
  }

  startScheduler(db, config, registry, channels);

  p.log.success(
    `Started with ${color.cyan(String(registry.count()))} tools, ${color.cyan(String(channels.all().length))} channels`,
  );
  p.log.info(
    `Model: ${color.dim(config.model)} | Timezone: ${color.dim(config.timezone)}`,
  );

  process.on("SIGINT", async () => {
    console.log("\n[angel] Shutting down...");
    const forceExit = setTimeout(() => {
      console.error("[angel] Graceful shutdown timed out, forcing exit.");
      process.exit(1);
    }, 10_000);
    try {
      killAllCodingAgents();
      killAllBackgroundProcesses();
      await channels.stopAll();
      await shutdownMcpServers();
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      console.error(`[angel] Shutdown error: ${detail}`);
    }
    clearTimeout(forceExit);
    process.exit(0);
  });
}

async function doRestart(channels: ChannelRegistry): Promise<void> {
  const persistedAgents = persistRunningAgents();
  const persistedProcesses = persistBackgroundProcesses();
  console.log(
    `[angel] Restart requested. Preserving ${persistedAgents} coding agent(s) and ${persistedProcesses} background process(es)...`,
  );
  await channels.stopAll();
  await shutdownMcpServers();
  process.exit(0);
}
