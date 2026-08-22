import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

export interface ChannelConfig {
  enabled?: boolean;
  allowed_users?: string[];
}

export interface iMessageConfig extends ChannelConfig {
  service?: string;
  imsg_path?: string;
  region?: string;
  /** Optional sender allowlist (phone numbers or handles). */
  allowed_handles?: string[];
}

export interface DiscordConfig extends ChannelConfig {
  token?: string;
  bot_username?: string;
}

export interface SlackConfig extends ChannelConfig {
  bot_token?: string;
  app_token?: string;
}

export interface SignalConfig extends ChannelConfig {
  account?: string;
  signal_cli_path?: string;
  allowed_numbers?: string[];
}

export interface TelegramConfig extends ChannelConfig {
  /** Bot token from @BotFather */
  token?: string;
}

export interface SecurityConfig {
  /** Max messages per sender per minute across all channels (0 = unlimited) */
  max_messages_per_minute?: number;
}

export interface DashboardConfig {
  enabled?: boolean;
  port?: number;
}

export interface MemoryConfig {
  reflector_enabled: boolean;
  reflector_interval_ms: number;
  embedding_enabled: boolean;
  token_budget: number;
}

export interface ModelRouteConfig {
  context: string;
  model: string;
}

export interface ModelRoutingConfig {
  enabled: boolean;
  routes: ModelRouteConfig[];
}

export interface DailyBudgetConfig {
  enabled: boolean;
  max_total_tokens: number;
  max_input_tokens: number;
  max_output_tokens: number;
  enforce_per_chat: boolean;
}

export interface MemoryQualityConfig {
  aging_enabled: boolean;
  decay_half_life_days: number;
  contradiction_detection: boolean;
  source_of_truth_enabled: boolean;
}

export interface ProactiveConfig {
  enabled: boolean;
  inactivity_default_minutes: number;
}

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface RemoteConfig {
  /** Tailscale hostname of the remote machine (e.g., "my-macbook") */
  tailscale_host?: string;
  /** Path to the tailscale binary (default: "tailscale") */
  tailscale_bin?: string;
}

export interface AngelConfig {
  openai_api_key: string;
  anthropic_api_key?: string;
  model: string;
  max_tokens: number;
  max_tool_iterations: number;
  max_history_messages: number;
  compaction_threshold: number;
  compaction_keep_recent: number;
  working_dir: string;
  working_dir_isolation: "none" | "per_chat";
  data_dir: string;
  soul_md_path?: string;
  timezone: string;
  channels: {
    imessage?: iMessageConfig;
    discord?: DiscordConfig;
    slack?: SlackConfig;
    signal?: SignalConfig;
    telegram?: TelegramConfig;
  };
  security?: SecurityConfig;
  dashboard?: DashboardConfig;
  memory: MemoryConfig;
  model_routing: ModelRoutingConfig;
  daily_budget: DailyBudgetConfig;
  memory_quality: MemoryQualityConfig;
  proactive: ProactiveConfig;
  hooks_dir?: string;
  plugins_dir?: string;
  skills_dir?: string;
  mcp_servers?: Record<string, McpServerConfig>;
  sandbox?: { mode: "none" | "subprocess" };
  safe_word?: string;
  remote?: RemoteConfig;
}

const DEFAULT_DATA_DIR = join(homedir(), ".angel");

export const DEFAULTS: AngelConfig = {
  openai_api_key: "",
  model: "gpt-5.4",
  max_tokens: 8192,
  max_tool_iterations: 50,
  max_history_messages: 50,
  compaction_threshold: 40,
  compaction_keep_recent: 20,
  working_dir: join(DEFAULT_DATA_DIR, "working_dir"),
  working_dir_isolation: "per_chat",
  data_dir: DEFAULT_DATA_DIR,
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  channels: {},
  memory: {
    reflector_enabled: true,
    reflector_interval_ms: 15 * 60 * 1000,
    embedding_enabled: false,
    token_budget: 1500,
  },
  model_routing: {
    enabled: true,
    routes: [
      { context: "onboarding", model: "gpt-5.4-mini" },
      { context: "reflector", model: "gpt-5.4-mini" },
      { context: "compaction", model: "gpt-5.4-mini" },
      { context: "scheduler", model: "gpt-5.4" },
      { context: "default", model: "gpt-5.4" },
    ],
  },
  daily_budget: {
    enabled: false,
    max_total_tokens: 500000,
    max_input_tokens: 350000,
    max_output_tokens: 150000,
    enforce_per_chat: false,
  },
  memory_quality: {
    aging_enabled: true,
    decay_half_life_days: 45,
    contradiction_detection: true,
    source_of_truth_enabled: true,
  },
  proactive: {
    enabled: true,
    inactivity_default_minutes: 720,
  },
  remote: {
    tailscale_host: undefined,
    tailscale_bin: "tailscale",
  },
};

export function configPath(): string {
  return process.env.ANGEL_CONFIG || join(DEFAULT_DATA_DIR, "config");
}

export function configExists(): boolean {
  return existsSync(configPath());
}

export function loadConfig(): AngelConfig {
  const path = configPath();
  if (!existsSync(path)) {
    return validateConfig({ ...DEFAULTS });
  }
  const raw = readFileSync(path, "utf-8");
  const parsed = parseYaml(raw) || {};
  return validateConfig(resolveEnvVars(deepMerge(DEFAULTS, parsed)));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function validateNumber(
  errors: string[],
  config: Record<string, unknown>,
  key: string,
  options: { min?: number } = {},
): void {
  const value = config[key];
  if (!isFiniteNumber(value)) {
    errors.push(`${key} must be a finite number`);
    return;
  }
  if (options.min !== undefined && value < options.min) {
    errors.push(`${key} must be greater than or equal to ${options.min}`);
  }
}

function validateBoolean(
  errors: string[],
  config: Record<string, unknown>,
  key: string,
): void {
  if (typeof config[key] !== "boolean") {
    errors.push(`${key} must be a boolean`);
  }
}

function validateOptionalStringArray(
  errors: string[],
  config: Record<string, unknown>,
  key: string,
): void {
  const value = config[key];
  if (value !== undefined && !isStringArray(value)) {
    errors.push(`${key} must be an array of strings`);
  }
}

function validateChannelConfig(
  errors: string[],
  channelName: string,
  config: unknown,
): void {
  if (config === undefined) return;
  if (!isPlainObject(config)) {
    errors.push(`channels.${channelName} must be an object`);
    return;
  }
  if (config.enabled !== undefined && typeof config.enabled !== "boolean") {
    errors.push(`channels.${channelName}.enabled must be a boolean`);
  }
  validateOptionalStringArray(errors, config, "allowed_users");
}

function validateMcpServers(errors: string[], servers: unknown): void {
  if (servers === undefined) return;
  if (!isPlainObject(servers)) {
    errors.push("mcp_servers must be an object keyed by server name");
    return;
  }

  for (const [name, server] of Object.entries(servers)) {
    if (!isPlainObject(server)) {
      errors.push(`mcp_servers.${name} must be an object`);
      continue;
    }
    if (typeof server.command !== "string" || !server.command.trim()) {
      errors.push(`mcp_servers.${name}.command must be a non-empty string`);
    }
    if (server.args !== undefined && !isStringArray(server.args)) {
      errors.push(`mcp_servers.${name}.args must be an array of strings`);
    }
    if (server.env !== undefined) {
      if (!isPlainObject(server.env)) {
        errors.push(`mcp_servers.${name}.env must be an object`);
      } else {
        for (const [envKey, envValue] of Object.entries(server.env)) {
          if (typeof envValue !== "string") {
            errors.push(`mcp_servers.${name}.env.${envKey} must be a string`);
          }
        }
      }
    }
  }
}

export function validateConfig(config: unknown): AngelConfig {
  const errors: string[] = [];
  if (!isPlainObject(config)) {
    throw new Error("Invalid Angel config: config must be an object");
  }

  if (typeof config.openai_api_key !== "string") {
    errors.push("openai_api_key must be a string");
  }
  if (
    config.anthropic_api_key !== undefined &&
    typeof config.anthropic_api_key !== "string"
  ) {
    errors.push("anthropic_api_key must be a string");
  }
  if (typeof config.model !== "string" || !config.model.trim()) {
    errors.push("model must be a non-empty string");
  }
  if (typeof config.timezone !== "string" || !config.timezone.trim()) {
    errors.push("timezone must be a non-empty string");
  }
  if (typeof config.working_dir !== "string" || !config.working_dir.trim()) {
    errors.push("working_dir must be a non-empty string");
  }
  if (typeof config.data_dir !== "string" || !config.data_dir.trim()) {
    errors.push("data_dir must be a non-empty string");
  }
  if (
    config.working_dir_isolation !== "none" &&
    config.working_dir_isolation !== "per_chat"
  ) {
    errors.push('working_dir_isolation must be "none" or "per_chat"');
  }
  validateNumber(errors, config, "max_tokens", { min: 1 });
  validateNumber(errors, config, "max_tool_iterations", { min: 1 });
  validateNumber(errors, config, "max_history_messages", { min: 1 });
  validateNumber(errors, config, "compaction_threshold", { min: 1 });
  validateNumber(errors, config, "compaction_keep_recent", { min: 0 });

  if (!isPlainObject(config.channels)) {
    errors.push("channels must be an object");
  } else {
    validateChannelConfig(errors, "discord", config.channels.discord);
    validateChannelConfig(errors, "slack", config.channels.slack);
    validateChannelConfig(errors, "signal", config.channels.signal);
    validateChannelConfig(errors, "imessage", config.channels.imessage);
    validateChannelConfig(errors, "telegram", config.channels.telegram);

    if (config.security !== undefined) {
      if (!isPlainObject(config.security)) {
        errors.push("security must be an object");
      } else if (
        config.security.max_messages_per_minute !== undefined &&
        typeof config.security.max_messages_per_minute !== "number"
      ) {
        errors.push("security.max_messages_per_minute must be a number");
      }
    }

    if (config.dashboard !== undefined) {
      if (!isPlainObject(config.dashboard)) {
        errors.push("dashboard must be an object");
      } else {
        if (
          config.dashboard.enabled !== undefined &&
          typeof config.dashboard.enabled !== "boolean"
        ) {
          errors.push("dashboard.enabled must be a boolean");
        }
        if (
          config.dashboard.port !== undefined &&
          typeof config.dashboard.port !== "number"
        ) {
          errors.push("dashboard.port must be a number");
        }
      }
    }

    const discord = config.channels.discord;
    if (
      isPlainObject(discord) &&
      discord.token !== undefined &&
      typeof discord.token !== "string"
    ) {
      errors.push("channels.discord.token must be a string");
    }
    const slack = config.channels.slack;
    if (isPlainObject(slack)) {
      if (
        slack.bot_token !== undefined &&
        typeof slack.bot_token !== "string"
      ) {
        errors.push("channels.slack.bot_token must be a string");
      }
      if (
        slack.app_token !== undefined &&
        typeof slack.app_token !== "string"
      ) {
        errors.push("channels.slack.app_token must be a string");
      }
    }
    const signal = config.channels.signal;
    if (isPlainObject(signal)) {
      if (signal.account !== undefined && typeof signal.account !== "string") {
        errors.push("channels.signal.account must be a string");
      }
      validateOptionalStringArray(errors, signal, "allowed_numbers");
    }
    const imessage = config.channels.imessage;
    if (isPlainObject(imessage)) {
      if (
        imessage.service !== undefined &&
        typeof imessage.service !== "string"
      ) {
        errors.push("channels.imessage.service must be a string");
      }
      validateOptionalStringArray(errors, imessage, "allowed_handles");
    }
  }

  if (!isPlainObject(config.memory)) {
    errors.push("memory must be an object");
  } else {
    validateBoolean(errors, config.memory, "reflector_enabled");
    validateNumber(errors, config.memory, "reflector_interval_ms", {
      min: 1000,
    });
    validateBoolean(errors, config.memory, "embedding_enabled");
    validateNumber(errors, config.memory, "token_budget", { min: 1 });
  }

  if (!isPlainObject(config.model_routing)) {
    errors.push("model_routing must be an object");
  } else {
    validateBoolean(errors, config.model_routing, "enabled");
    if (!Array.isArray(config.model_routing.routes)) {
      errors.push("model_routing.routes must be an array");
    } else {
      config.model_routing.routes.forEach((route, index) => {
        if (!isPlainObject(route)) {
          errors.push(`model_routing.routes.${index} must be an object`);
          return;
        }
        if (typeof route.context !== "string" || !route.context.trim()) {
          errors.push(
            `model_routing.routes.${index}.context must be a non-empty string`,
          );
        }
        if (typeof route.model !== "string" || !route.model.trim()) {
          errors.push(
            `model_routing.routes.${index}.model must be a non-empty string`,
          );
        }
      });
    }
  }

  if (!isPlainObject(config.daily_budget)) {
    errors.push("daily_budget must be an object");
  } else {
    validateBoolean(errors, config.daily_budget, "enabled");
    validateNumber(errors, config.daily_budget, "max_total_tokens", { min: 0 });
    validateNumber(errors, config.daily_budget, "max_input_tokens", { min: 0 });
    validateNumber(errors, config.daily_budget, "max_output_tokens", {
      min: 0,
    });
    validateBoolean(errors, config.daily_budget, "enforce_per_chat");
  }

  if (!isPlainObject(config.memory_quality)) {
    errors.push("memory_quality must be an object");
  } else {
    validateBoolean(errors, config.memory_quality, "aging_enabled");
    validateNumber(errors, config.memory_quality, "decay_half_life_days", {
      min: 1,
    });
    validateBoolean(errors, config.memory_quality, "contradiction_detection");
    validateBoolean(errors, config.memory_quality, "source_of_truth_enabled");
  }

  if (!isPlainObject(config.proactive)) {
    errors.push("proactive must be an object");
  } else {
    validateBoolean(errors, config.proactive, "enabled");
    validateNumber(errors, config.proactive, "inactivity_default_minutes", {
      min: 1,
    });
  }

  validateMcpServers(errors, config.mcp_servers);

  if (config.sandbox !== undefined) {
    if (!isPlainObject(config.sandbox)) {
      errors.push("sandbox must be an object");
    } else if (
      config.sandbox.mode !== "none" &&
      config.sandbox.mode !== "subprocess"
    ) {
      errors.push('sandbox.mode must be "none" or "subprocess"');
    }
  }

  if (errors.length > 0) {
    throw new Error(`Invalid Angel config:\n- ${errors.join("\n- ")}`);
  }

  return config as unknown as AngelConfig;
}

export function saveConfig(config: Partial<AngelConfig>): void {
  const path = configPath();
  const dir = join(path, "..");
  if (!existsSync(dir)) {
    require("fs").mkdirSync(dir, { recursive: true });
  }
  const yaml = stringifyYaml(config);
  require("fs").writeFileSync(path, yaml, "utf-8");
}

function deepMerge(target: any, source: any): any {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (
      source[key] &&
      typeof source[key] === "object" &&
      !Array.isArray(source[key]) &&
      target[key] &&
      typeof target[key] === "object"
    ) {
      result[key] = deepMerge(target[key], source[key]);
    } else if (source[key] !== undefined) {
      result[key] = source[key];
    }
  }
  return result;
}

export function resolveEnvVars(obj: any): any {
  if (typeof obj === "string") {
    return obj.replace(/\$\{(\w+)\}/g, (_, name) => process.env[name] || "");
  }
  if (Array.isArray(obj)) return obj.map(resolveEnvVars);
  if (obj && typeof obj === "object") {
    const result: any = {};
    for (const [k, v] of Object.entries(obj)) {
      result[k] = resolveEnvVars(v);
    }
    return result;
  }
  return obj;
}
