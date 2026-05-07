import type { Database } from "bun:sqlite";
import * as p from "@clack/prompts";
import color from "picocolors";
import {
  type AngelConfig,
  configExists,
  configPath,
  loadConfig,
} from "./config";
import { getDb } from "./db";

export type SmokeStatus = "pass" | "fail" | "skip";

export interface SmokeResult {
  name: string;
  status: SmokeStatus;
  detail: string;
  durationMs?: number;
}

interface ConnectorRow {
  id: number;
  name: string;
  type: string;
  config_json: string;
  status: string;
}

interface SmokeOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const SECRET_PATTERNS = [
  /sk-[a-zA-Z0-9_-]{20,}/g,
  /xox[baprs]-[a-zA-Z0-9-]+/g,
  /xapp-[a-zA-Z0-9-]+/g,
  /gh[pousr]_[a-zA-Z0-9_]+/g,
  /secret_[a-zA-Z0-9]+/g,
  /ya29\.[a-zA-Z0-9_-]+/g,
  /Bearer\s+[a-zA-Z0-9._-]+/g,
];

export async function runSmokeChecks(
  config: AngelConfig,
  db: Database,
  opts: SmokeOptions = {},
): Promise<SmokeResult[]> {
  const fetchImpl = opts.fetchImpl || fetch;
  const timeoutMs = opts.timeoutMs || 15_000;
  const results: SmokeResult[] = [];

  results.push(await smokeOpenAI(config, fetchImpl, timeoutMs));
  results.push(await smokeAnthropic(config, fetchImpl, timeoutMs));
  results.push(...(await smokeChannels(config, fetchImpl, timeoutMs)));
  results.push(...(await smokeKnowledgeConnectors(db, fetchImpl, timeoutMs)));

  return results;
}

export async function runSmokeCli(): Promise<void> {
  p.intro(color.bgCyan(color.black(" angel smoke ")));

  if (!configExists()) {
    p.log.warn(`Config not found. Run ${color.cyan("bun run setup")} first.`);
    p.outro("Smoke checks skipped.");
    return;
  }

  p.log.info(`Config: ${configPath()}`);
  const config = loadConfig();
  const db = getDb(config.data_dir);
  const results = await runSmokeChecks(config, db);

  for (const result of results) {
    const text = `${result.name}: ${result.detail}${
      result.durationMs !== undefined ? ` (${result.durationMs}ms)` : ""
    }`;
    if (result.status === "pass") p.log.success(text);
    else if (result.status === "fail") p.log.error(text);
    else p.log.warn(text);
  }

  const failed = results.filter((r) => r.status === "fail").length;
  const skipped = results.filter((r) => r.status === "skip").length;
  const passed = results.filter((r) => r.status === "pass").length;

  if (failed > 0) {
    process.exitCode = 1;
    p.outro(
      color.red(
        `Smoke checks failed: ${failed} failed, ${passed} passed, ${skipped} skipped.`,
      ),
    );
    return;
  }

  p.outro(`Smoke checks complete: ${passed} passed, ${skipped} skipped.`);
}

async function smokeOpenAI(
  config: AngelConfig,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<SmokeResult> {
  if (!config.openai_api_key) return skip("OpenAI", "API key not configured");
  return httpSmoke(
    "OpenAI",
    "https://api.openai.com/v1/models",
    {
      headers: { Authorization: `Bearer ${config.openai_api_key}` },
    },
    fetchImpl,
    timeoutMs,
    () => "models endpoint reachable",
  );
}

async function smokeAnthropic(
  config: AngelConfig,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<SmokeResult> {
  if (!config.anthropic_api_key) {
    return skip("Anthropic", "API key not configured");
  }
  return httpSmoke(
    "Anthropic",
    "https://api.anthropic.com/v1/models",
    {
      headers: {
        "anthropic-version": "2023-06-01",
        "x-api-key": config.anthropic_api_key,
      },
    },
    fetchImpl,
    timeoutMs,
    () => "models endpoint reachable",
  );
}

async function smokeChannels(
  config: AngelConfig,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<SmokeResult[]> {
  return [
    await smokeDiscord(config, fetchImpl, timeoutMs),
    await smokeSlack(config, fetchImpl, timeoutMs),
    await smokeIMessage(config),
    await smokeSignal(config),
  ];
}

async function smokeDiscord(
  config: AngelConfig,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<SmokeResult> {
  const discord = config.channels.discord;
  if (!discord?.enabled) return skip("Discord", "channel disabled");
  if (!discord.token) return fail("Discord", "enabled but token is missing");

  return httpSmoke(
    "Discord",
    "https://discord.com/api/v10/users/@me",
    {
      headers: { Authorization: `Bot ${discord.token}` },
    },
    fetchImpl,
    timeoutMs,
    async (resp) => {
      const json = (await resp.json()) as { username?: string };
      return `bot token valid${json.username ? ` for ${json.username}` : ""}`;
    },
  );
}

async function smokeSlack(
  config: AngelConfig,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<SmokeResult> {
  const slack = config.channels.slack;
  if (!slack?.enabled) return skip("Slack", "channel disabled");
  if (!slack.bot_token || !slack.app_token) {
    return fail("Slack", "enabled but bot_token or app_token is missing");
  }

  const start = Date.now();
  try {
    const authResp = await fetchImpl("https://slack.com/api/auth.test", {
      method: "POST",
      headers: { Authorization: `Bearer ${slack.bot_token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const authJson = (await authResp.json()) as {
      ok?: boolean;
      error?: string;
      team?: string;
      user?: string;
    };
    if (!authResp.ok || !authJson.ok) {
      return fail(
        "Slack",
        `bot auth failed: ${authJson.error || `HTTP ${authResp.status}`}`,
        start,
      );
    }

    const appResp = await fetchImpl(
      "https://slack.com/api/apps.connections.open",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${slack.app_token}` },
        signal: AbortSignal.timeout(timeoutMs),
      },
    );
    const appJson = (await appResp.json()) as { ok?: boolean; error?: string };
    if (!appResp.ok || !appJson.ok) {
      return fail(
        "Slack",
        `Socket Mode app token failed: ${appJson.error || `HTTP ${appResp.status}`}`,
        start,
      );
    }

    return pass(
      "Slack",
      `bot and Socket Mode tokens valid${authJson.team ? ` for ${authJson.team}` : ""}`,
      start,
    );
  } catch (err: any) {
    return fail("Slack", err.message, start);
  }
}

async function smokeIMessage(config: AngelConfig): Promise<SmokeResult> {
  const imessage = config.channels.imessage;
  if (!imessage?.enabled) return skip("iMessage", "channel disabled");
  const start = Date.now();
  const imsgPath = imessage.imsg_path || "imsg";

  const help = await runProcess([imsgPath, "--help"]);
  if (help.exitCode !== 0) {
    return fail(
      "iMessage",
      `imsg unavailable at ${imsgPath}: ${help.stderr || help.stdout || "command failed"}`,
      start,
    );
  }

  const chats = await runProcess([imsgPath, "chats", "--json", "--limit", "1"]);
  if (chats.exitCode !== 0) {
    return fail(
      "iMessage",
      `imsg cannot read chats: ${chats.stderr || chats.stdout || "command failed"}`,
      start,
    );
  }

  return pass("iMessage", "imsg available and chat read check passed", start);
}

async function smokeSignal(config: AngelConfig): Promise<SmokeResult> {
  const signal = config.channels.signal;
  if (!signal?.enabled) return skip("Signal", "channel disabled");
  if (!signal.account) return fail("Signal", "enabled but account is missing");
  const start = Date.now();
  const cliPath = signal.signal_cli_path || "signal-cli";

  const version = await runProcess([cliPath, "--version"]);
  if (version.exitCode !== 0) {
    return fail(
      "Signal",
      `signal-cli unavailable at ${cliPath}: ${version.stderr || version.stdout || "command failed"}`,
      start,
    );
  }

  const accounts = await runProcess([cliPath, "listAccounts"]);
  if (accounts.exitCode !== 0) {
    return fail(
      "Signal",
      `unable to list accounts: ${accounts.stderr || accounts.stdout || "command failed"}`,
      start,
    );
  }

  if (!accounts.stdout.includes(signal.account)) {
    return fail(
      "Signal",
      `configured account ${signal.account} is not registered`,
      start,
    );
  }

  return pass(
    "Signal",
    "signal-cli available and configured account is registered",
    start,
  );
}

async function smokeKnowledgeConnectors(
  db: Database,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<SmokeResult[]> {
  const connectors = db
    .query(
      "SELECT id, name, type, config_json, status FROM knowledge_connectors ORDER BY id ASC",
    )
    .all() as ConnectorRow[];

  if (connectors.length === 0) {
    return [skip("Knowledge connectors", "no connectors configured")];
  }

  const results: SmokeResult[] = [];
  for (const connector of connectors) {
    const name = `Connector ${connector.name}`;
    if (connector.status !== "active") {
      results.push(skip(name, `status is ${connector.status}`));
      continue;
    }

    let cfg: Record<string, unknown>;
    try {
      cfg = JSON.parse(connector.config_json || "{}");
    } catch {
      results.push(fail(name, "config_json is invalid JSON"));
      continue;
    }

    if (connector.type === "github") {
      results.push(await smokeGitHubConnector(name, cfg, fetchImpl, timeoutMs));
    } else if (connector.type === "notion") {
      results.push(await smokeNotionConnector(name, cfg, fetchImpl, timeoutMs));
    } else if (connector.type === "gdrive") {
      results.push(await smokeDriveConnector(name, cfg, fetchImpl, timeoutMs));
    } else {
      results.push(fail(name, `unsupported type ${connector.type}`));
    }
  }

  return results;
}

async function smokeGitHubConnector(
  name: string,
  cfg: Record<string, unknown>,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<SmokeResult> {
  const owner = String(cfg.owner || "");
  const repo = String(cfg.repo || "");
  if (!owner || !repo) return fail(name, "GitHub owner or repo missing");

  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "Angel/1.0",
  };
  if (typeof cfg.token === "string" && cfg.token) {
    headers.Authorization = `Bearer ${cfg.token}`;
  }

  return httpSmoke(
    name,
    `https://api.github.com/repos/${owner}/${repo}/issues?state=all&per_page=1`,
    { headers },
    fetchImpl,
    timeoutMs,
    () => `GitHub issues/PRs endpoint reachable for ${owner}/${repo}`,
  );
}

async function smokeNotionConnector(
  name: string,
  cfg: Record<string, unknown>,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<SmokeResult> {
  const token = String(cfg.token || "");
  if (!token) return fail(name, "Notion token missing");

  return httpSmoke(
    name,
    "https://api.notion.com/v1/search",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "Notion-Version": "2022-06-28",
      },
      body: JSON.stringify({ page_size: 1 }),
    },
    fetchImpl,
    timeoutMs,
    () => "Notion search endpoint reachable",
  );
}

async function smokeDriveConnector(
  name: string,
  cfg: Record<string, unknown>,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<SmokeResult> {
  const accessToken = String(cfg.access_token || "");
  const apiKey = String(cfg.api_key || "");
  if (!accessToken && !apiKey) {
    return fail(name, "Google Drive access_token or api_key missing");
  }

  const headers: Record<string, string> = {};
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  const params = new URLSearchParams({
    pageSize: "1",
    fields: "files(id,name)",
    q: String(cfg.query || "trashed = false"),
  });
  if (apiKey) params.set("key", apiKey);

  return httpSmoke(
    name,
    `https://www.googleapis.com/drive/v3/files?${params.toString()}`,
    { headers },
    fetchImpl,
    timeoutMs,
    () => "Google Drive files endpoint reachable",
  );
}

async function httpSmoke(
  name: string,
  url: string,
  init: RequestInit,
  fetchImpl: typeof fetch,
  timeoutMs: number,
  okDetail: (resp: Response) => string | Promise<string>,
): Promise<SmokeResult> {
  const start = Date.now();
  try {
    const resp = await fetchImpl(url, {
      ...init,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!resp.ok) {
      const body = await safeResponseText(resp);
      return fail(name, `HTTP ${resp.status}${body ? `: ${body}` : ""}`, start);
    }
    return pass(name, await okDetail(resp), start);
  } catch (err: any) {
    return fail(name, err.message, start);
  }
}

async function runProcess(args: string[]): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  try {
    const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return {
      exitCode,
      stdout: sanitize(stdout.trim()),
      stderr: sanitize(stderr.trim()),
    };
  } catch (err: any) {
    return { exitCode: 1, stdout: "", stderr: sanitize(err.message) };
  }
}

async function safeResponseText(resp: Response): Promise<string> {
  try {
    return sanitize((await resp.text()).slice(0, 300).replace(/\s+/g, " "));
  } catch {
    return "";
  }
}

function pass(name: string, detail: string, startMs?: number): SmokeResult {
  return result(name, "pass", detail, startMs);
}

function fail(name: string, detail: string, startMs?: number): SmokeResult {
  return result(name, "fail", detail, startMs);
}

function skip(name: string, detail: string): SmokeResult {
  return result(name, "skip", detail);
}

function result(
  name: string,
  status: SmokeStatus,
  detail: string,
  startMs?: number,
): SmokeResult {
  return {
    name,
    status,
    detail: sanitize(detail),
    durationMs: startMs !== undefined ? Date.now() - startMs : undefined,
  };
}

function sanitize(value: string): string {
  let sanitized = value;
  for (const pattern of SECRET_PATTERNS) {
    sanitized = sanitized.replace(pattern, "[REDACTED]");
  }
  return sanitized;
}
