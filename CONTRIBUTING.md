# Contributing to Angel

Thanks for helping improve Angel. This project is an autonomous assistant with chat adapters, tool execution, memory, scheduling, plugins, skills, MCP integration, and security policy controls. Changes should preserve user safety and operational reliability.

## Development setup

```bash
bun install
bun run lint
bun run typecheck
bun test
```

Useful commands:

```bash
bun run dev       # run Angel with file watching
bun run doctor    # local diagnostics
bun run smoke     # read-only integration smoke checks
bun run build     # compile a local binary
```

## Before opening a PR

Run the same checks as CI:

```bash
bun run lint
bun run typecheck
bun test
bun run build
```

If your change touches integrations or credentials, also run:

```bash
bun run doctor
bun run smoke
```

## Project layout

```text
src/
├── index.ts          CLI entry point
├── agent.ts          message processing and tool loop
├── llm.ts            LLM calls, streaming, compaction
├── config.ts         YAML config loading and validation
├── db.ts             SQLite schema, migrations, queries
├── policy.ts         execution policy evaluation
├── scheduler.ts      cron/one-shot task scheduling
├── channels/         chat adapters
└── tools/            built-in tools and registry
```

## Adding a tool

1. Add the tool implementation under `src/tools/`.
2. Use the `Tool` interface from `src/tools/registry.ts`.
3. Choose the lowest accurate risk level: `low`, `medium`, or `high`.
4. Validate inputs at the tool boundary.
5. Scrub secrets from output when command output, HTTP responses, or external process output may contain credentials.
6. Register the tool in the relevant `*Tools` export.
7. Add tests for success, failure, and policy/security boundaries.

## Adding a channel adapter

1. Implement the shared channel interface from `src/channels/types.ts`.
2. Deny-by-default where an allowlist is available.
3. Normalize actor identifiers before policy checks.
4. Include clear error handling for missing credentials and disconnected services.
5. Add documentation and an example config.

## Database changes

- Add migrations in `src/db.ts`.
- Migrations must be idempotent.
- Include tests for new tables/columns when practical.
- Avoid destructive migrations unless there is a documented migration path.

## Security expectations

Angel can execute commands, read files, contact external services, and send messages. Treat every boundary as security-sensitive.

When changing security-sensitive code, add or update tests for:

- blocked shell commands
- secret scrubbing
- sensitive path blocking
- SSRF/private-network blocking
- allowlist behavior
- execution policy precedence
- confirmation requirements

Never commit real credentials. Use environment variable placeholders such as `${OPENAI_API_KEY}` in examples.

## Release process

Releases are created by `.github/workflows/release.yml` when `package.json` version changes on `main`/`master`. The release workflow builds binaries and publishes to npm. Normal PR validation is handled by `.github/workflows/ci.yml`.
