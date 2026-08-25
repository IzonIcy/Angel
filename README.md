<div align="center">

[![CI](https://github.com/IzonIcy/Angel/actions/workflows/ci.yml/badge.svg)](https://github.com/IzonIcy/Angel/actions/workflows/ci.yml)
    <img src="assets/weeping_angel.png" width="120" />
    <h3>Angel</h3>
    <p>A personal AI agent that lives in your chats and gets things done</p>
    <br/>
</div>

I built Angel because I wanted an assistant that shows up where I already am, not another browser tab to check. It connects to Discord, Slack, iMessage, and Signal (plus a basic Telegram adapter), reads your messages, and actually does things: runs shell commands, edits files, searches the web, drives a browser, schedules cron jobs. It also remembers you between conversations, so you don't re-explain yourself every morning.

One process, one YAML config file, backed by SQLite. Written in TypeScript on Bun.

## What it does

**Real work, not small talk.** The model gets tools: sandboxed shell execution, file operations, web search and fetch, Playwright browser automation, cross-chat messaging, scheduling. For bigger jobs it can spawn coding agents like Claude Code or Codex in the background, plus small subagents for parallel tasks.

**Memory that persists.** A reflection pass summarizes conversations into SQLite-backed memories. Old memories fade unless they keep being useful, contradictions get grouped so Angel doesn't act on stale info, and facts you care about can be pinned.

**Runs on its own.** Cron-style scheduled tasks with timezones and retries. You can set rules like "ping me if we haven't talked in 12 hours". Long conversations get compacted automatically instead of blowing the context window.

**Guardrails.** Shell commands run inside an OS sandbox on macOS. Dangerous operations need a confirmation code sent via DM. Per-channel allowlists control who can talk to it, secrets get scrubbed from tool output before the model sees them, and outbound fetches are blocked from reaching private/internal IPs.

## Getting started

```bash
git clone https://github.com/IzonIcy/Angel.git
cd angel
bun install
bun run setup    # wizard: API key, model, timezone, channel preferences

bun run start    # run the daemon
bun run dev      # same, with file watching
bun run doctor   # connectivity diagnostics
bun run smoke    # credentialed read-only checks of everything configured
```

Config ends up at `~/.angel/config`. Then talk to Angel through any enabled channel. In-chat commands: `/help` `/new` `/model [name]` `/memory` `/usage` `/dashboard` `/settings` `/clear` `/reset` `/restart` `/version`. `bun run smoke` checks your LLM providers, channels, and knowledge connectors (GitHub, Notion, Google Drive), skipping anything not set up and failing loudly on anything broken.

## Channels

### Discord

1. Create a bot at [discord.com/developers](https://discord.com/developers/applications)
2. Enable the Message Content intent
3. Generate a token and add it to your config

```yaml
channels:
  discord:
    enabled: true
    token: "your-bot-token"
```

### Slack

1. Create an app at [api.slack.com/apps](https://api.slack.com/apps), from scratch
2. Add bot token scopes: `chat:write`, `app_mentions:read`, `im:history`, `im:read`, `im:write`
3. Enable Socket Mode to get your `app_token` (`xapp-...`), then subscribe to `message.im` and `app_mention` under Event Subscriptions
4. Install the app to your workspace, which gives you the `bot_token` (`xoxb-...`)

```yaml
channels:
  slack:
    enabled: true
    bot_token: "xoxb-..."
    app_token: "xapp-..."
```

Socket Mode means no public URL, no ngrok, no webhook server.

### Signal

You need [signal-cli](https://github.com/AsamK/signal-cli) and a phone number. Cheap trick: create a free Google Voice number and register it with Signal.

```bash
signal-cli -a +1YOURGVOICENUMBER register
# verification code arrives as a text in Google Voice
signal-cli -a +1YOURGVOICENUMBER verify CODE
```

```yaml
channels:
  signal:
    enabled: true
    account: "+1YOURGVOICENUMBER"      # the number you registered
    allowed_numbers:
      - "+1YOURPERSONALNUMBER"
```

`allowed_numbers` is deny-by-default: leave it empty and nobody can use the bot. The check is per sender, not per group, so an unauthorized person mentioning Angel in a group chat gets ignored anyway. In groups Angel only responds when mentioned. Emoji reactions to its messages are logged as context but never trigger replies.

### iMessage

macOS only. Uses the [`imsg` CLI](https://github.com/steipete/imsg): `imsg watch --json` for incoming, `imsg send` for outgoing.

```yaml
channels:
  imessage:
    enabled: true
    service: "auto"     # auto | imessage | sms
    allowed_handles:    # optional hard allowlist
      - "+14155551212"
```

If `allowed_handles` is unset, anyone who texts the Mac can talk to it. Keep that in mind before enabling this one. (`imsg_path` and `region` options exist, see the example config.)

### Telegram

There's also a basic long-polling adapter: get a bot token from @BotFather and set `channels.telegram.enabled: true` plus `token`. It works, I just use it less than the others.

## Configuration

Full annotated example in [`angel.config.example.yaml`](./angel.config.example.yaml). Trimmed version:

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

daily_budget:
  enabled: false            # turn this on if the API bill scares you
  max_total_tokens: 500000

data_dir: "~/.angel"
```

`${VAR}` values resolve from environment variables. Memory reflection, model routing, proactive pings, and compaction all have knobs too, see the example file.

You can extend Angel without touching code: JSON hooks in `~/.angel/hooks/`, manifest-based plugins in `~/.angel/plugins/`, SKILL.md instruction files in `~/.angel/skills/`, and MCP servers loaded dynamically via `mcp_servers` in config.

## Security

The blocked-command list (recursive rm on root, keychain dumps, exfiltration piping, that kind of thing) is a tripwire, not a wall. Shell syntax makes it bypassable, `curl ... | bash` isn't caught, and I won't pretend otherwise. The actual enforcement boundary on macOS is a Seatbelt profile: shells can't write outside the working directory and temp space by default. Set `security.sandbox: "full"` to also deny network access from shells, `"off"` to disable entirely.

On top of that: policy rules scoped by tool, risk level, channel, user, path, and domain; safe-word confirmations over DM for dangerous ops; secret scrubbing of API keys and private keys in tool output; credential-bearing env vars stripped before shells spawn; sensitive paths like `.ssh` and `.env` off limits to file tools; SSRF protection on web_fetch that re-validates every redirect hop.

## Honest limitations

- The Seatbelt sandbox is macOS only. On Linux there's no OS-level boundary today, just policies and the tripwire list.
- bash runs with your user's full privileges. Confirmations and policies raise the bar, but treat every shell call as if it were you typing it.
- Signal depends on signal-cli staying alive and registered on the same machine.
- Subagents cap at depth 2 and 4 concurrent. That's deliberate.
- The Telegram adapter gets the least attention from me.

## Development

Requires Bun 1.0+. Main dependencies: openai, discord.js, @slack/bolt, cron-parser, yaml. Tests with `bun test`, linting with `bun run lint` (Biome).

## License

MIT License
