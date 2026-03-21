# Hypertable Stabilization

This document tracks the post-migration stabilization work after moving
authoritative episodic storage onto the Timescale-backed `episodic_memory`
hypertable.

## What Was Done

- made `episodic_memory` authoritative and kept `episodic_timeline` as a
  compatibility surface instead of a required mirror
- cleared inbound foreign keys and moved episodic provenance to a loose-pointer
  model with audit coverage
- converted authoritative episodic storage to a real hypertable with the
  `(occurred_at, id)` key shape
- added planner pruning so direct current-truth and clarification queries avoid
  unnecessary temporal/event branches
- kept event-bounded retrieval fast by joining `artifact_observations` for the
  primary hit
- restored lost secondary context with a bounded same-observation episodic
  neighborhood fan-out for event queries
- added a runtime `provenance_audit` worker and manual processing endpoint

## Current Verified Runs

- clean replay:
  - `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/life-replay-2026-03-21T02-32-38-467Z.json`
- scale replay:
  - `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/life-scale-2026-03-21T02-33-04-182Z.json`

## Current Read

- clean replay:
  - `60 confident`
  - `1 weak`
  - `1 missing`
- scale replay:
  - `86 generated artifacts`
  - `p50 51.87ms`
  - `p95 213.01ms`
  - `Steve focus graph: 54 nodes / 70 edges`

The remaining `weak` and `missing` cases are intentional:

- pre-reconsolidation `what did Steve do on March 20 2026?` is weak before the
  reconsolidation pass, then confident afterward
- unresolved kinship and vague-place prompts abstain and route to clarification

## Main Fail Points

1. Bounded event queries are still the latency tail.
- current-truth queries are fast again
- clarification queries are cheap
- event queries with context recovery still cost materially more than direct
  current-state lookups even after capping the support fan-out to one primary
  event and two same-observation support rows on the scale pack

2. Loose provenance needs ongoing audit.
- this is the right tradeoff for hypertable conversion
- it means orphan protection is shared between application writes and audit jobs

3. Larger corpus behavior is not fully proven yet.
- the current scale pack is meaningful, not toy-sized
- it is still not a true large-production corpus

4. The local-brain runtime still needs a live authenticated embedding provider.
- the new per-namespace SQL hybrid kernel is in the codebase
- provider smoke currently fails on OpenRouter auth in this runtime
- until local `external` or another authenticated provider is wired here, the kernel remains production-ready but under-exercised

## What Improved

1. The hypertable path is now structurally correct.
- authoritative reads no longer depend on a fragile sidecar mirror
- foreign-key blockers are gone
- replay and scale both stay green

2. Query quality held through the storage change.
- no quality delta on the scale query pack
- clarification safety still prevents hallucinations for unknown kinship and
  vague places

3. Event retrieval recovered context without reverting the optimization.
- the primary hit stays bounded and cheap
- a tiny same-observation fan-out restores secondary details like project
  context when they are actually present in the source

4. Planner pruning is now a measured invariant, not just a design goal.
- direct current-truth scale queries now assert `retrievalMode=lexical`
- they also assert `vectorFallbackReason=planner:branch_pruned`
- this keeps the hypertable path focused on event/time questions instead of
  quietly broadening all retrieval

## Recommended Next Tuning

1. Add targeted hypertable indexes only after measuring.
- focus on event-bounded access patterns first
- avoid broad index churn now that the planner path is healthier

2. Keep `ANALYZE` and audit jobs in the operational loop.
- stale stats will hurt chunk pruning
- skipped provenance audits will hide loose-pointer drift

3. Expand the scale pack before calling the storage path fully proven.
- add more mixed event-heavy artifacts
- add more alias and vague-place noise
- watch event-query p95, not just correctness

4. Generalize the SQL-first fused retrieval path when vector retrieval becomes
reliably available.
- the current lexical-pruned path is correct for this corpus
- the next ranking step is to exercise the new core in-database hybrid kernel
  under a live embedding provider and then expand its query-class coverage

## Readiness For A Larger Corpus

The system is ready for a controlled next step, not an unbounded dump.

Safe next ingestion target:

- a few hundred additional documents or notes
- more mixed daily-life and project notes
- more clarification-heavy aliases and vague references

Not yet fully proven for:

- very large event-heavy corpora with deep temporal recall
- high-frequency multimodal derivation at production volume
- broad operator-driven graph exploration over a much denser social graph

## Operational Recommendation

Start feeding a moderately larger corpus now, but keep the same discipline:

1. ingest in batches
2. wipe/replay on schema or retrieval changes
3. run clean replay and scale replay together
4. watch p95 for bounded event queries
5. keep provenance audit enabled
