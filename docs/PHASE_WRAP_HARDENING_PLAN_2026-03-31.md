# Phase Wrap And Hardening Plan - 2026-03-31

## Purpose

This document closes the current LoCoMo-focused remediation slice and defines the next hardening phase.

We are no longer in a state where another small retrieval tweak is the highest-leverage move. The repository is now dirty across multiple subsystems, the benchmark substrate is materially improved, and the remaining work needs to be organized into a hardening phase rather than another open-ended score chase.

## Frozen Benchmark Checkpoint

Current frozen LoCoMo checkpoint:
- [locomo-2026-03-31T08-04-13-012Z.json](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/locomo-2026-03-31T08-04-13-012Z.json)

Frozen score:
- mini LoCoMo `0.825`

Interpretation:
- good enough to preserve as a retrieval checkpoint
- not good enough to call the end state
- no longer the only priority, because product-lane integrity and operator/dashboard coherence now matter more than one more isolated benchmark gain

## Dirty Tree Inventory

Current grouped worktree inventory:
- `local-brain`: `63` files
- `brain-console`: `16` files
- `docs`: `9` files

Meaning:
- the worktree is no longer a single-feature branch
- multiple foundations are moving at once:
  - benchmark infrastructure
  - retrieval behavior
  - clarifications / identity / typed memory
  - operator/dashboard surfaces
  - docs and certification artifacts

## Subsystem Buckets

### 1. Local Brain Core

Scope:
- retrieval
- benchmark infrastructure
- clarifications
- identity / canonicalization
- typed memory
- MCP/server behavior
- replay/ops substrate

Representative files:
- [service.ts](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/retrieval/service.ts)
- [answerable-unit-reader.ts](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/retrieval/answerable-unit-reader.ts)
- [exact-answer-control.ts](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/retrieval/exact-answer-control.ts)
- [locomo.ts](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/benchmark/locomo.ts)
- [benchmark-jobs.ts](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/benchmark/benchmark-jobs.ts)
- [service.ts](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/typed-memory/service.ts)
- [service.ts](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/clarifications/service.ts)

Phase objective:
- preserve the `0.825` retrieval gains
- recover product-lane regressions without reopening broad retrieval churn

### 2. Brain Console / Operator Surfaces

Scope:
- bootstrap
- console
- inbox / resolve / ignore
- relationships
- graph/knowledge views
- runtime/operator helpers

Representative files:
- [page.tsx](/Users/evilone/Documents/Development/AI-Brain/ai-brain/brain-console/src/app/console/inbox/page.tsx)
- [route.ts](/Users/evilone/Documents/Development/AI-Brain/ai-brain/brain-console/src/app/console/inbox/resolve/route.ts)
- [route.ts](/Users/evilone/Documents/Development/AI-Brain/ai-brain/brain-console/src/app/console/inbox/ignore/route.ts)
- [page.tsx](/Users/evilone/Documents/Development/AI-Brain/ai-brain/brain-console/src/app/console/relationships/page.tsx)
- [page.tsx](/Users/evilone/Documents/Development/AI-Brain/ai-brain/brain-console/src/app/sessions/[sessionId]/graph/page.tsx)
- [brain-runtime.ts](/Users/evilone/Documents/Development/AI-Brain/ai-brain/brain-console/src/lib/brain-runtime.ts)
- [operator-workbench.ts](/Users/evilone/Documents/Development/AI-Brain/ai-brain/brain-console/src/lib/operator-workbench.ts)

Phase objective:
- align dashboard/operator views with the current clarification, ambiguity, graph, and typed-memory substrate
- make sure the UI reflects the truth model we now have instead of lagging behind it

### 3. Docs / Phase Artifacts

Scope:
- LoCoMo audit and remediation docs
- production-confidence docs
- temporal/profile docs
- operator/session docs

Representative files:
- [LOCOMO_REMEDIATION_LOOP_2026-03-29.md](/Users/evilone/Documents/Development/AI-Brain/ai-brain/docs/LOCOMO_REMEDIATION_LOOP_2026-03-29.md)
- [LOCOMO_FIRST_PASS_AUDIT_2026-03-29.md](/Users/evilone/Documents/Development/AI-Brain/ai-brain/docs/LOCOMO_FIRST_PASS_AUDIT_2026-03-29.md)
- [PRODUCTION_CONFIDENCE_98.md](/Users/evilone/Documents/Development/AI-Brain/ai-brain/docs/PRODUCTION_CONFIDENCE_98.md)
- [TEMPORAL_RECAP_PROFILE_PHASE.md](/Users/evilone/Documents/Development/AI-Brain/ai-brain/docs/TEMPORAL_RECAP_PROFILE_PHASE.md)

Phase objective:
- convert the current work from implicit context into explicit frozen checkpoints and phase boundaries
- reduce the chance of reopening already-finished loops by accident

## Hardening Phase Goals

### Goal 1: Product-Lane Recovery

Protected checks to recover and freeze:
- `benchmark:public-memory-miss-regressions`
- `benchmark:mcp-production-smoke`
- `benchmark:personal-omi-review`

Reason:
- benchmark-only improvement is not enough if product lanes regress
- these checks are now the primary stability gate

### Goal 2: Dashboard / Operator Sync

The dashboard should expose the same substrate improvements the backend now has:
- clarification truth and resolution state
- ambiguity/conflict markers
- graph payload fidelity
- relationship and canonical-identity improvements
- typed-memory-derived current truth where appropriate

Reason:
- retrieval and reasoning changes lose operational value if the operator cannot see or trust them

### Goal 3: Worktree Hygiene And Phase Boundaries

We need a deliberate subsystem-by-subsystem closeout:
- identify which files belong to the completed LoCoMo slice
- identify which files are part of the next product hardening phase
- avoid carrying unrelated modifications forward invisibly

Reason:
- the current dirty tree is now an execution risk and a review risk

## Recommended Execution Order

1. freeze the LoCoMo checkpoint and stop micro-tuning
2. run and recover protected product checks
3. inspect dashboard/operator surfaces against the new truth model
4. document subsystem boundaries and phase outcomes
5. only then reopen the remaining frozen LoCoMo families:
   - list-family answer shaping
   - residual temporal anchoring
   - bounded causal/profile chain shaping

## Recommended Commit Boundaries

The current branch should not be left as an unbounded dirty tree. The safest closeout path is:

1. `checkpoint commit`
- docs and benchmark-checkpoint closeout
- purpose:
  - preserve the frozen `0.825` LoCoMo slice
  - preserve the hardening-phase handoff

2. `backend substrate commit`
- `local-brain`
- scope:
  - retrieval
  - benchmark runners/jobs
  - clarifications / canonicalization / typed memory
  - migrations and test fixtures
- purpose:
  - keep the backend truth-model and evaluation substrate coherent

3. `dashboard/operator commit`
- `brain-console`
- scope:
  - clarifications
  - graph/relationship surfaces
  - bootstrap/runtime/operator pages
- purpose:
  - keep the operator surface changes reviewable on their own

If a fresh branch is created after the checkpoint, the recommended direction is:
- keep this branch as the wrap/checkpoint branch
- open the new branch for:
  - product-lane recovery
  - dashboard sync
  - only then the next frozen retrieval phase

## What Not To Do Next

- do not start another open-ended LoCoMo tuning loop immediately
- do not mix dashboard sync and retrieval surgery in the same pass without a written boundary
- do not claim new benchmark progress without a final artifact
- do not patch toward malformed benchmark normalization noise

## Phase Exit Criteria

This hardening phase is complete when:
- the current retrieval checkpoint is documented and preserved
- protected product lanes are re-run and either recovered or explicitly taxonomized
- dashboard/operator surfaces are reviewed against the current substrate and adjusted where needed
- the remaining LoCoMo miss families are rewritten as the next frozen retrieval phase instead of staying mixed into the current worktree
