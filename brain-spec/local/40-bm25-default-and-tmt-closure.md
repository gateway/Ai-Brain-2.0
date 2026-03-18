# BM25 Default And TMT Closure

Date: `2026-03-18`

## Summary

This slice was the BM25 closure pass.

Goals:

- finish BM25 honestly instead of leaving it half-feature-gated
- deepen TMT retrieval beyond parent links and loose descendant expansion
- re-run eval and the lexical benchmark until the result was stable enough to become current truth

Final result:

- baseline eval: clean
- lexical benchmark: `FTS 14/14`, `BM25 14/14`
- BM25 fallback cases: `0`
- BM25 token delta vs FTS: `-17`
- runtime lexical default: `bm25`

Native PostgreSQL FTS still remains in two places by design:

- guarded fallback when BM25 fails
- the `procedural_memory` bridge inside BM25 mode because that path still gives the cleanest active-truth behavior on the current schema

## What Changed

### 1. BM25 Tail Reduction

BM25 is no longer using the old broad-tail posture on the seeded corpus.

Changes:

- precision lexical detection now narrows exact-match queries instead of letting them drag a wide lexical tail
- exact relationship-style queries now collapse to the top episodic evidence row when appropriate
- rare code/version/hash/port-style queries now prune to the best exact evidence instead of carrying extra semantic tail
- candidate budget is lower for precision lexical queries

Outcome:

- `relationship_context_kyoto` now returns `1` result for both FTS and BM25
- `entity_collision_sara` now returns `1` result for both FTS and BM25
- `rare_entity_cve` now returns `1` result for both FTS and BM25

### 2. Active Truth Protection

BM25 briefly regressed on preference truth by allowing semantic memory to outrank procedural truth.

Fix:

- non-temporal active-truth queries now prefer `procedural_memory` when procedural and semantic rows compete on the same topic

Outcome:

- `spicy_active_truth` and `sweet_active_truth` now resolve back to procedural current truth for both FTS and BM25

### 3. TMT Hardening

The TMT path is now materially stronger than the earlier ancestor-only shape.

Changes:

- ancestor expansion is now budgeted per layer
- descendant support expansion is now gated by deterministic sufficiency checks
- narrow time windows now prefer the evidentiary episodic leaf over broad temporal rollups
- broad year queries still keep temporal summaries plus bounded episodic support
- temporal overlap is now explicitly checked in the benchmark

Outcome:

- `march_redesign_date` now returns the March 12 episodic leaf again
- `japan_exact_temporal` and `japan_temporal_natural_language` still return temporal context with good overlap and bounded support

## Verification

Commands run:

```bash
cd /Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain
npm run check
npm run eval
npm run benchmark:lexical
```

Verified outputs:

- [latest eval](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/eval-results/latest.md)
- [latest lexical benchmark](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/latest.md)

Current benchmark truth:

- baseline eval passed
- BM25 passes the strengthened lexical suite
- BM25 no longer increases token load versus FTS on the seeded benchmark corpus
- BM25 no longer falls back on the seeded benchmark corpus

## Self Review

What went well:

- the benchmark is now strong enough to catch real regressions instead of flattering the system
- BM25 promotion was earned by rerunning proof after the ranking changes, not by rewriting the docs first
- TMT got deeper without adding schema churn or an LLM gate

What is still not finished:

- the benchmark is still seeded/self-consistent, not a full noisy holdout corpus
- TMT is not yet a full complexity-aware hierarchical descent stack
- BM25 is the lexical default now, but the hybrid kernel is still app-side RRF rather than the final SQL-first fused kernel

## Current Truth

For the local brain track:

- BM25 is put to bed for this phase
- BM25 is now the runtime default lexical branch
- FTS remains as explicit override/fallback
- TMT is stronger and more deterministic than the previous slice

The next best moves are no longer “should BM25 be default?” They are:

1. expand the operator console with timeline and relationships
2. deepen TMT further with richer per-level descent/gating
3. wire the real external OCR/STT/caption endpoint when ready
