# Spec: Postgres + Prisma Migration for Multi-Tenant Backend

## Problem Statement

Angel currently uses a single-file SQLite database (`angel.db`) with a module-level singleton. This architecture:

- Cannot scale beyond a single process
- Has no multi-tenancy (all users share one DB)
- Lacks proper migration tooling
- Cannot support Row-Level Security for workspace isolation
- Blocks Phase 2 (Dashboard + Billing) which requires multi-tenant Postgres

## Solution

Add Postgres + Prisma as the new primary database layer, with:

- Prisma schema covering all existing tables + multi-tenant extensions
- Row-Level Security (RLS) policies for workspace isolation
- Migration scripts from SQLite → Postgres
- Dual-write period during transition (write to both, read from Postgres)
- NextAuth-ready user/team schema

## User Stories

1. As a platform operator, I want to run Angel against Postgres so that multiple agent instances can share a database.
2. As a platform operator, I want Row-Level Security so that Team A's data is cryptographically isolated from Team B's.
3. As a developer, I want Prisma migrations so that schema changes are versioned, reviewable, and reversible.
4. As a platform operator, I want to migrate existing SQLite data to Postgres without data loss.
5. As a developer, I want type-safe database access via Prisma Client so that queries are checked at compile time.
6. As a platform operator, I want the migration to be reversible (dual-write period) so that rollback is possible.

## Implementation Decisions

### Prisma Schema (New `prisma/schema.prisma`)

**Core Models (from existing SQLite):**

- `User` — NextAuth user (id, email, name, image, emailVerified, createdAt, updatedAt)
- `Account` — NextAuth OAuth accounts
- `Session` — NextAuth sessions
- `VerificationToken` — NextAuth tokens
- `Team` — Workspace (id, name, slug, createdAt, updatedAt)
- `TeamMember` — User ↔ Team (role: OWNER, ADMIN, MEMBER, VIEWER)
- `Chat` — Conversation (teamId, channel, externalChatId, chatType, title)
- `Message` — Messages (chatId, role, content, toolCalls, toolCallId, isFromBot, senderName)
- `Memory` — Memories (teamId, chatId?, content, category, confidence, source, isArchived, pinned, sourceOfTruth, contradictionKey, decayHalfLifeDays)
- `ScheduledTask` — Cron tasks (teamId, chatId?, name, prompt, cronExpr, nextRunAt, status, timezone, maxRetries, retryCount, fallbackPrompt)
- `ExecutionPolicy` — Policies (teamId, name, type, action, enabled, toolName, riskLevel, channel, actorId, pathPattern, domainPattern, note)
- `KnowledgeConnector` — Knowledge sources (teamId, name, type, configJson, status, lastSyncedAt, lastError)
- `KnowledgeDocument` — Documents (connectorId, externalId, title, content, url, checksum)
- `ToolExecutionLog` — Observability (teamId, chatId, actorId, channel, toolName, success, durationMs, errorText)
- `SystemEvent` — System events (teamId, eventType, severity, context, details)

**RLS Strategy:**

- Every table with team-scoped data gets `teamId` column
- RLS policies: `CREATE POLICY ... USING (team_id = current_setting('app.current_team_id')::uuid)`
- Application sets `SET LOCAL app.current_team_id = '...'` per request
- `TeamMember` table enforces membership before RLS applies

### Migration Strategy

1. **Phase A: Prisma Setup** (this spec)
   - Add Prisma, create schema, generate client
   - Add `src/db-postgres.ts` with Prisma client singleton
   - Add `DATABASE_URL` to config

2. **Phase B: Dual Write** (next spec)
   - Modify `src/db.ts` to write to both SQLite and Postgres
   - Reads from Postgres (with SQLite fallback)
   - Verify data consistency

3. **Phase C: Cutover** (later)
   - Switch primary reads to Postgres
   - Remove SQLite writes
   - Drop SQLite dependency

### File Structure

```
src/
├── db.ts              # SQLite (legacy, dual-write during transition)
├── db-postgres.ts     # Prisma client + RLS helpers
├── config.ts          # Add databaseUrl, databaseProvider ('sqlite' | 'postgres')
└── prisma/
    ├── schema.prisma
    ├── migrations/
    └── seed.ts
```

### Key Technical Decisions

- **RLS via Postgres session variables**: `SET LOCAL app.current_team_id` per request/transaction
- **Team context propagation**: Middleware extracts team from auth/session, sets RLS variable
- **Prisma Client extension**: Custom extension to auto-set RLS context
- **Migration scripts**: `scripts/migrate-sqlite-to-postgres.ts` using Prisma's `$executeRaw` for bulk insert
- **Indexes**: Match existing SQLite indexes + composite indexes for RLS patterns

### Config Changes

```yaml
# angel.config.yaml additions
database:
  provider: "postgres" # or "sqlite"
  url: "postgresql://..." # required for postgres
  pool_size: 10
```

## Testing Decisions

- **Integration tests**: Use `testcontainers` to spin up real Postgres for tests
- **RLS tests**: Verify isolation — Team A cannot read Team B's data
- **Migration tests**: Round-trip SQLite → Postgres → verify row counts match
- **Existing seams**: Keep `getDb(dataDir)` signature for backward compat during transition
- **Property tests**: Generate random team/user/chat hierarchies, verify RLS boundaries

## Out of Scope

- NextAuth integration (separate spec)
- Dashboard UI (Phase 3)
- Real-time subscriptions (Postgres LISTEN/NOTIFY or Supabase Realtime)
- Read replicas / connection pooling (PgBouncer)
- Backup/restore automation

## Further Notes

- This is Phase 2 of the 90-day roadmap
- Requires `agent-runtime/policy` extraction first (policy store interface)
- Prisma version: latest stable (5.x)
- Postgres version: 16+ (for RLS performance)
- Consider `prisma-rls` extension or raw SQL for policies
