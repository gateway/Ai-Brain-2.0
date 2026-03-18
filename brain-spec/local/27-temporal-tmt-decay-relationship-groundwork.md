# 27 - Temporal/TMT + Decay + Relationship Groundwork (Deterministic)

Date: 2026-03-18  
Scope: safe groundwork only, no retrieval hot-path edits.

## What Was Added

### 1) Schema groundwork migration

File: `local-brain/migrations/007_temporal_decay_and_relationship_memory.sql`

Adds:

- `temporal_nodes`
- `temporal_node_members`
- `relationship_memory`
- `relationship_adjudication_events`
- `semantic_decay_events`
- `relationship_candidates.processed_at`, `relationship_candidates.decision_reason`
- `semantic_memory.last_accessed_at`, `semantic_memory.access_count`, `semantic_memory.decay_exempt`, `semantic_memory.decay_floor`

Design intent:

- preserve append-only episodic source of truth
- promote deterministic rollups/edges into separate tables
- keep audit trails for adjudication and forgetting actions

### 2) Deterministic jobs

Files:

- `local-brain/src/jobs/temporal-summary.ts`
- `local-brain/src/jobs/relationship-adjudication.ts`
- `local-brain/src/jobs/semantic-decay.ts`

Behavior:

- Temporal summaries:
  - rolls up episodic windows at `day|week|month`
  - upserts `temporal_nodes`
  - refreshes `temporal_node_members` as evidence links
- Relationship adjudication:
  - processes pending `relationship_candidates`
  - deterministic threshold logic (accept/reject)
  - promotes to `relationship_memory`
  - supersedes conflicting active edges for exclusive predicates
  - writes adjudication event logs
- Semantic decay:
  - decays inactive non-anchor semantic rows
  - archives rows at floor threshold (instead of deleting)
  - writes decay event logs

### 3) New CLI entry points

Files:

- `local-brain/src/cli/summarize-temporal.ts`
- `local-brain/src/cli/adjudicate-relationships.ts`
- `local-brain/src/cli/decay-semantic.ts`

New npm scripts:

- `npm run summarize:temporal -- --namespace personal --layer day`
- `npm run adjudicate:relationships -- --namespace personal`
- `npm run decay:semantic -- --namespace personal`

## Why This Is Safe

- No changes were made in retrieval hot-path files (`src/retrieval/*`).
- Existing ingestion/retrieval behavior remains intact.
- New behavior is opt-in via explicit job CLIs.
- All new logic is deterministic-first (no LLM dependency in this slice).

## Verification Run

Executed:

1. `npm run check` (pass)
2. `npm run build` (pass)

Notes:

- This run verifies compile/type safety for new migration references, jobs, and CLIs.
- Runtime DB execution of new jobs requires applying migrations first (`npm run migrate`) on the target local DB.

## Self-Review

What is solid now:

- clear table foundation for TMT scaffolding
- conflict-aware relationship promotion path
- explicit forgetting/decay auditability

What remains intentionally deferred:

- LLM judge in adjudication/recall gating
- true BM25 + vector RRF retrieval path integration
- TMT multi-level abstraction promotion beyond deterministic rollups (L1-L5 planner/orchestration)
