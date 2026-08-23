<div align="center">

[![CI](https://github.com/IzonIcy/Angel/actions/workflows/ci.yml/badge.svg)](https://github.com/IzonIcy/Angel/actions/workflows/ci.yml)
    <img src="assets/weeping_angel.png" width="120" />
    <h3>Angel</h3>
    <p>Autonomous AI agent with multi-channel support, persistent memory, and an extensible tool system</p>
    <br/>
    <br/>
</div>

A self-directed assistant that connects to your communication platforms and gets things done. Angel receives messages from Discord, Slack, iMessage, and Signal, reasons through tasks using LLM-powered tool loops, and maintains long-term memory across conversations.

## Features

- **Multi-Channel**: Connects to Discord, Slack, iMessage, and Signal simultaneously
- **36+ Built-in Tools**: Shell execution, file operations, web search, browser automation, coding agents, cross-chat messaging, and more
- **Persistent Memory**: SQLite + file-backed memory with reflection, confidence scoring, duplicate detection, and scoped recall
- **Scheduled Tasks**: Cron-based and one-shot task scheduling with timezone support, retry logic, and dead-letter handling
- **Coding Agents**: Spawn external agents (Claude Code, Codex, Aider, Goose, Amp) for background work
- **Subagents**: Spawn isolated child agents for parallel task execution (max depth 2, max concurrent 4)
- **Confirmations**: Multi-step safe-word verification for dangerous operations via DM
- **Goal/Project Mode**: Goal tracking with task graphs, dependency-aware next actions, and checkpoints
- **Policy Engine**: Approval + permission policies scoped by tool/risk/channel/user/path/domain
- **Model Routing + Budgets**: Context-based model selection with daily token budget guardrails
- **Memory Quality Layer**: Aging-aware recall, contradiction grouping, and source-of-truth pinning
- **Knowledge Connectors**: Connector framework with sync + search across external sources
- **Workflow Recipes**: Reusable multi-step automations that execute tool sequences
- **Observability Dashboard**: Runtime metrics for usage, tool errors, tasks, and confirmations
- **Self-Healing Jobs**: Scheduled task fallback prompts after retry exhaustion
- **Proactive Mode**: Cron/inactivity rules for agent-initiated messages
- **Message Compaction**: Automatic conversation summarization when context grows large
- **Onboarding**: Guided new-user flow with profile and preference gathering
- **MCP Integration**: Dynamically load tools from Model Context Protocol servers
- **Hooks, Plugins, Skills**: Event interception, manifest-based plugins, and skill files for extensibility
- **Access Control**: Per-channel user allowlists with runtime management
- **Security**: 46 blocked command patterns, secret scrubbing, file access control, SSRF protection, and safe-word gating

## Install

```bash
git clone https://github.com/IzonIcy/Angel.git
cd angel
bun install
```

## Setup

```bash
bun run setup
```

The setup wizard will walk through API key configuration, channel setup, and initial preferences. Configuration file is stored at `~/.angel/config`.

## Usage

```bash
bun run start

bun run dev    # file watching (development)

bun run doctor # diagnostics

bun run smoke  # credentialed read-only integration smoke checks
```

Channel adapters connect automatically based on your configuration. Talk to Angel through any enabled channel.

`bun run smoke` performs safe, credentialed checks for configured LLM providers, Discord, Slack, iMessage, Signal, and active GitHub/Notion/Google Drive knowledge connectors. Missing optional integrations are reported as skipped; configured integrations fail the smoke run if credentials or read-only connectivity are broken.

### Chat Commands

`/help` · `/new` · `/model [name]` · `/memory` · `/usage` · `/dashboard` · `/settings` · `/clear` · `/reset` · `/version`


## Channels

### Discord

1. Create a bot at [discord.com/developers](https://discord.com/developers/applications)
2. Enable the Message Content intent
3. Generate a bot token and add it to your config

```yaml
channels:
  discord:
    enabled: true
    token: "your-bot-token"
```

### Slack

1. Go to [api.slack.com/apps](https://api.slack.com/apps) and create a new app **from scratch**
2. Go to **OAuth & Permissions** and add these bot token scopes: `chat:write`, `app_mentions:read`, `im:history`, `im:read`, `im:write`
3. Go to **Socket Mode** and enable it — this generates your `app_token` (`xapp-...`)
4. Go to **Event Subscriptions**, enable events, and subscribe to `message.im` and `app_mention`
5. Install the app to your workspace — this gives you the `bot_token` (`xoxb-...`)

```yaml
channels:
  slack:
    enabled: true
    bot_token: "xoxb-..."
    app_token: "xapp-..."
```

No public URL, no ngrok, no webhook server — Socket Mode handles everything over a WebSocket.

### Signal

Signal requires `signal-cli` and a phone number. Here's a cheap way to get one:

1. Create a [Google Voice](https://voice.google.com) account and get a free number
2. Install `signal-cli` ([github.com/AsamK/signal-cli](https://github.com/AsamK/signal-cli))
3. Register your Google Voice number with Signal using `signal-cli`:
   ```bash
   signal-cli -a +1YOURGVOICENUMBER register
   ```
   The verification code arrives as a text in Google Voice. Complete with:
   ```bash
   signal-cli -a +1YOURGVOICENUMBER verify CODE
   ```
4. Add to your config:

```yaml
channels:
  signal:
    enabled: true
    account: "+1YOURGVOICENUMBER"
    allowed_numbers:
      - "+1YOURPERSONALNUMBER"
```

The `account` field is your Angel bot's phone number (the one you registered with Signal). The `allowed_numbers` field specifies who can interact with Angel—only messages from these numbers will be processed. **If `allowed_numbers` is empty or not configured, all messages are denied by default.** You must explicitly list the phone numbers that are permitted to use the bot.

**Group chat security**: In Signal group chats, Angel only responds when mentioned. The `allowed_numbers` check is enforced **per-sender**, not per-group—meaning even if an unauthorized user mentions Angel in a group chat, their message is blocked. Only users whose phone numbers appear in `allowed_numbers` can trigger the bot, regardless of whether the conversation is a direct message or a group chat.

**Reactions**: Angel detects emoji reactions sent via Signal. Reactions to Angel's messages are logged and stored in message history, providing context for future conversations (e.g., "User reacted 👍 to your message"). Reactions do not trigger immediate responses—they serve as passive feedback that Angel can reference in subsequent interactions. In group chats, only reactions to Angel's own messages are surfaced to reduce noise.

Signal's servers relay messages, so your machine just needs to be on and running Angel.

### iMessage

```yaml
channels:
  imessage:
    enabled: true
    imsg_path: "imsg"   # optional
    service: "auto"     # auto | imessage | sms
    region: "US"        # phone normalization region
    allowed_handles:     # optional hard allowlist (phone/email handles)
      - "+14155551212"
```

Requires macOS and the [`imsg` CLI](https://github.com/steipete/imsg). Angel uses `imsg watch --json` for incoming messages and `imsg send` for outgoing messages.

If `allowed_handles` is set, iMessage messages are denied by default unless the sender handle is explicitly allowlisted.

## Configuration

Angel uses YAML configuration at `~/.angel/config`:

```yaml
openai_api_key: "${OPENAI_API_KEY}"
model: "gpt-5.4"
max_tokens: 8192
max_tool_iterations: 50
timezone: "America/New_York"

channels:
  discord:
    enabled: true
    token: "${DISCORD_TOKEN}"
  slack:
    enabled: true
    bot_token: "${SLACK_BOT_TOKEN}"
    app_token: "${SLACK_APP_TOKEN}"
  signal:
    enabled: true
    account: "+1234567890"

memory:
  reflector_enabled: true
  reflector_interval_ms: 900000

model_routing:
  enabled: true
  routes:
    - context: "default"
      model: "gpt-5.4"
    - context: "reflector"
      model: "gpt-5.4-mini"

daily_budget:
  enabled: false
  max_total_tokens: 500000
  max_input_tokens: 350000
  max_output_tokens: 150000
  enforce_per_chat: false

memory_quality:
  aging_enabled: true
  decay_half_life_days: 45
  contradiction_detection: true
  source_of_truth_enabled: true

proactive:
  enabled: true
  inactivity_default_minutes: 720

compaction_threshold: 40
working_dir_isolation: "per_chat"
data_dir: "~/.angel"
```

Values wrapped in `${VAR}` are resolved from environment variables.

### Extensibility

- **Hooks**: JSON config files in `~/.angel/hooks/` with event triggers, commands, and timeouts
- **Plugins**: Manifest-based tool and command bundles in `~/.angel/plugins/`
- **Skills**: SKILL.md instruction files in `~/.angel/skills/`
- **MCP Servers**: Config-driven subprocess integration with dynamic tool loading

## Architecture

```
src/
├── index.ts          Entry point
├── agent.ts          Core message processing, tool loop, image support, onboarding
├── llm.ts            OpenAI integration with streaming and message compaction
├── config.ts         YAML config loading with env var resolution
├── db.ts             SQLite layer (WAL mode, migrations)
├── memory.ts         Memory storage, reflection, confidence scoring, file-backed memory
├── model_router.ts   Context-aware model routing + budget guardrails
├── policy.ts         Approval/permission policy evaluation
├── scheduler.ts      Cron + one-shot task scheduling engine
├── subagents.ts      Isolated child agent spawning
├── commands.ts       Chat command routing
├── hooks.ts          Event hook system (before_llm interception)
├── plugins.ts        Plugin manifest loading
├── skills.ts         Skill discovery and activation
├── mcp.ts            Model Context Protocol server integration
├── doctor.ts         Connectivity and accessibility diagnostics
├── smoke.ts          Credentialed external integration smoke checks
├── setup.ts          Interactive setup wizard
├── channels/
│   ├── discord.ts    Discord adapter
│   ├── slack.ts      Slack adapter (Socket Mode)
│   ├── imessage.ts   iMessage adapter (macOS)
│   ├── signal.ts     Signal adapter (signal-cli, serialized stdin writes)
│   └── types.ts      Channel interface definitions
└── tools/
    ├── registry.ts       Tool registration and routing
    ├── bash.ts           Shell execution with guardrails
    ├── files.ts          File read/write/edit/glob/grep
    ├── web.ts            Web search and fetch
    ├── browser.ts        Playwright browser automation
    ├── memory.ts         Memory CRUD tools
    ├── schedule.ts       Scheduling tools
    ├── subagent.ts       Subagent tools
    ├── coding_agents.ts  External coding agent integration
    ├── confirmation.ts   Safe-word confirmation workflow
    ├── send_message.ts   Cross-chat messaging
    ├── advanced.ts       Goals, policies, connectors, recipes, observability, proactive tools
    └── misc.ts           Utilities (time, todo, export, calculate)
```

## Security

- **OS sandbox (macOS)**: bash commands run inside a Seatbelt profile that denies filesystem writes outside the working directory and temp space. Set `security.sandbox: "full"` to also deny all network access from shells, or `"off"` to disable. This is the real enforcement boundary; the blocked-pattern list below is tripwire telemetry and is bypassable by design of shell syntax.
- **Command guardrails**: 46 blocked patterns covering destructive operations, credential theft, data exfiltration, privilege escalation, and system tampering
- **Policy engine**: deny / allow / require-confirmation rules scoped by tool, risk level, channel, user, path, and domain — high-risk tools outside direct chats fail safe when no rule matches
- **Secret scrubbing**: OpenAI keys, Slack tokens, GitHub tokens, SSH/RSA/EC private keys automatically redacted from command output
- **Env sanitization**: credential-bearing environment variables are stripped before spawning shells so they can't leak into LLM context
- **File access control**: Sensitive paths (`.ssh`, `.aws`, `.gnupg`, `.env`, credentials, angel config) blocked from file tools
- **SSRF protection**: `web_fetch` resolves hostnames itself and blocks requests landing on private/internal IP ranges, re-validating every redirect hop
- **Safe-word system**: Configurable phrase required for dangerous operations, verified via DM
- **Per-channel access control**: User allowlists managed via config and runtime tools
- **Rate limiting**: per-sender message limits shared by all channels

## Development

```bash
bun run dev
```

Requires Bun 1.0+. Key dependencies: openai, discord.js, @slack/bolt, cron-parser, yaml.

## License

MIT License