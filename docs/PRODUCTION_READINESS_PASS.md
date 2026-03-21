# Production Readiness Pass

This document records the current production-oriented read on the AI Brain 2.0
system after the latest retrieval, hypertable, replay, and operator passes.

## Verified Runs

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

The remaining weak or missing cases are intentional:

- pre-reconsolidation `what did Steve do on March 20 2026?` is weak before the
  reconsolidation pass, then confident afterward
- unresolved kinship and vague-place prompts abstain and route to
  clarification instead of hallucinating

## What Is Production-Leaning Today

1. Ontology and truth handling are stable.
- current vs historical truth remains clean
- active relationship abstention works correctly as `Unknown.`
- replay and scale stay green under the current corpus

2. Authoritative storage is structurally correct.
- `episodic_memory` is the Timescale-backed authoritative episodic layer
- `episodic_timeline` is compatibility-only
- provenance audit protects the loose-pointer model

3. The query contract is safe.
- answers return claim-plus-evidence duality
- clarification-driven abstention prevents guessed identities and places
- graph expansion remains provenance-backed on the scale pack

4. A conservative SQL-first hybrid kernel now exists.
- per-namespace core retrieval can rank core branches in SQL
- specialized enrichers still stay outside the kernel
- retrieval metadata now exposes whether ranking came from `app_fused` or
  `sql_hybrid_core`

## Main Production Gaps

1. Bounded event queries are still the latency tail.
- they remain the slowest query family on the current hypertable path
- this is still the main p95 driver

2. The local-brain runtime is not yet using a live authenticated embedding
provider.
- `provider:smoke` currently fails on OpenRouter auth in this runtime
- that means the new SQL hybrid kernel is code-ready but not yet exercised by
  live replay here

3. Loose provenance requires operational discipline.
- orphan prevention is shared between writes and the audit worker
- the provenance audit worker must be treated as mandatory infrastructure

4. Cross-namespace fusion is still app-side.
- per-namespace kernel work is the correct first milestone
- `/search` still merges namespace responses in app code

## Recommended Next Steps

1. Wire a live embedding provider into `local-brain`.
- prefer the local `external` provider path if that is the intended production
  runtime
- rerun replay and scale with hybrid actually active

2. Keep event-path tuning focused.
- optimize bounded event retrieval first
- avoid broad new index churn until event p95 is measured again under the live
  provider path

3. Keep provenance audit enabled and visible.
- do not treat it as optional maintenance
- surface audit freshness in ops if needed

4. Expand the corpus in controlled batches.
- a few hundred additional notes/documents is a safe next step
- do not jump straight to an unbounded dump
