# Spec: Extract Policy Engine to `agent-runtime` Library

## Problem Statement

The policy engine (`src/policy.ts`) is tightly coupled to Angel's SQLite database and Bun runtime. To achieve the Phase 1 goal of extracting an `agent-runtime` library (publishable to npm + crates.io), the policy engine must be decoupled from Angel-specific dependencies and made reusable as a standalone module.

## Solution

Extract the policy engine into a new `agent-runtime` package with:

- Pure TypeScript implementation (no Bun-specific APIs)
- Database-agnostic interface (policy store as a pluggable interface)
- Property-based tests using `fast-check`
- Clean public API for policy evaluation, rule management, and persistence

## User Stories

1. As a library consumer, I want to import `@agent-runtime/policy` and use the policy engine without any Angel dependencies, so that I can embed it in my own agent framework.
2. As a library consumer, I want to provide my own policy storage backend (Postgres, Redis, in-memory, file), so that the policy engine works with my existing infrastructure.
3. As a library consumer, I want the policy evaluation logic to be identical to Angel's (recency-based precedence, fail-safe for high-risk tools in multi-party chats), so that security guarantees are preserved.
4. As a library maintainer, I want property-based tests that verify the policy engine's invariants (deny always wins, allow shadows older deny, confirmation flow), so that regressions are caught automatically.
5. As a library consumer, I want TypeScript types that are self-documenting and strict, so that integration is type-safe.
6. As an Angel developer, I want Angel to consume `@agent-runtime/policy` as a dependency, so that policy improvements flow both ways.

## Implementation Decisions

### Package Structure

```
agent-runtime/
├── packages/
│   ├── policy/           # @agent-runtime/policy (npm)
│   │   ├── src/
│   │   │   ├── index.ts           # Public API exports
│   │   │   ├── types.ts           # PolicyRule, PolicyDecision, PolicyStore interface
│   │   │   ├── evaluation.ts      # Core evaluation logic (pure functions)
│   │   │   ├── store/             # Storage implementations
│   │   │   │   ├── interface.ts   # PolicyStore interface
│   │   │   │   ├── memory.ts      # In-memory implementation
│   │   │   │   └── sqlite.ts      # SQLite implementation (for Angel compat)
│   │   │   └── utils.ts           # wildcardMatch, fieldMatches, etc.
│   │   ├── tests/
│   │   │   ├── evaluation.test.ts     # Unit tests (existing behavior)
│   │   │   ├── property.test.ts       # fast-check property tests
│   │   │   └── integration.test.ts    # Store integration tests
│   │   ├── package.json
│   │   └── tsconfig.json
│   └── ...               # Future: sandbox, tools, memory, scheduler, llm
├── package.json          # Workspace root
└── turbo.json            # Turborepo config (optional)
```

### Core Types (from existing `policy.ts`)

- `PolicyRule` — matches `PolicyRow` but without DB-specific `id`
- `PolicyDecision` — unchanged (`allowed`, `requireConfirmation`, `reason`)
- `PolicyContext` — minimal context needed for evaluation (`channel`, `actorId`, `workingDir`, etc.)
- `PolicyStore` — interface for CRUD + query operations

### Evaluation Logic (Pure Functions)

- `evaluatePolicy(rules: PolicyRule[], tool, input, context): PolicyDecision` — pure, no DB
- `wildcardMatch`, `fieldMatches`, `getPathFromToolInput`, `getDomainFromToolInput` — extracted as pure utils
- `ruleMatches` — pure function
- `isDirectChat` — pure function

### Storage Interface

```typescript
interface PolicyStore {
  listEnabled(): Promise<PolicyRule[]>;
  getById(id: string): Promise<PolicyRule | null>;
  create(
    rule: Omit<PolicyRule, "id" | "createdAt" | "updatedAt">,
  ): Promise<PolicyRule>;
  update(id: string, patch: Partial<PolicyRule>): Promise<PolicyRule>;
  delete(id: string): Promise<void>;
}
```

### Angel Integration

- Angel's `src/policy.ts` becomes a thin adapter that:
  - Implements `PolicyStore` using `bun:sqlite`
  - Re-exports `evaluateExecutionPolicy` from `@agent-runtime/policy`
  - Keeps the same function signature for zero-breaking-change migration

### Property-Based Tests (fast-check)

Invariants to verify:

1. **Deny always wins**: If any matching rule has `action: "deny"`, decision is `allowed: false`
2. **Allow shadows older deny**: Newer `allow` rule beats older `deny` if both match
3. **Confirmation flow**: `require_confirmation` → needs `confirmationSatisfied: true` to allow
4. **Fail-safe for high-risk**: Empty ruleset + high-risk tool + non-direct chat = require confirmation
5. **Direct chat bypass**: High-risk tools allowed in direct chats with empty ruleset
6. **Recency ordering**: Rules evaluated newest-first (highest ID first)
7. **Path/domain scoping**: Rules with path/domain patterns only match when tool input provides matching values

## Testing Decisions

- **Unit tests**: Port existing `policy.test.ts` cases to new package (14 tests)
- **Property tests**: Use `fast-check` to generate random rule sets, tools, inputs, contexts and verify invariants
- **Integration tests**: Test each `PolicyStore` implementation (memory, SQLite) against same contract
- **Existing seams**: Reuse `ToolContext` shape from Angel but make it generic
- **No implementation details**: Tests only verify `PolicyDecision` outputs, not internal rule iteration

## Out of Scope

- Postgres storage implementation (Phase 2)
- Policy DSL/authoring UI
- Audit logging for policy changes
- Distributed policy synchronization
- Other `agent-runtime` packages (sandbox, tools, memory, scheduler, llm)

## Further Notes

- This is the first package in `agent-runtime` — sets patterns for future extractions
- Keep dependency count minimal: only `fast-check` (dev), `zod` (optional validation)
- Version: `0.1.0` (pre-1.0, breaking changes expected)
- Angel's `package.json` will add `@agent-runtime/policy` as dependency after publish
