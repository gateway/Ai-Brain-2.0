# Post-Green Hardening

This note freezes the current sampled-standard LoCoMo baseline and defines the
next hardening loop for latency, observability, and transfer validation.

## Baseline

- latest sampled standard artifact:
  - `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/locomo-2026-04-03T09-57-07-278Z.md`
- sampled score delta:
  - `0.82 -> 1.0`
- current caveat:
  - the green artifact is the sampled `locomo10` 100-question compatibility run,
    not the full unsampled corpus
- current tail risk:
  - `p50 = 999.69ms`
  - `p95 = 6386.78ms`

## Why The Next Slice Is Telemetry-First

Sampled correctness is now strong enough that broad retrieval tuning would
mostly add noise. The next bottleneck is understanding why a query is slow:

- planner-heavy
- conditional-descent-heavy
- reducer-heavy
- or stuck in weak fallback / final-claim shaping

The retrieval substrate already has conditional descent and family-lane routing.
The remaining work is to expose those decisions cleanly in benchmark artifacts
before any DB or index churn.

## Open-Source Comparison And Repo Decisions

### TiMem

Primary source:
- [TiMem paper](https://arxiv.org/abs/2601.02845)

What maps well to this repo:
- temporal hierarchy as a first-class retrieval control
- recall-time gating instead of unrestricted leaf traversal
- progressive summary layers above leaf evidence

Repo decision:
- keep the current typed-lane plus conditional-descent shape
- add `leafTraversalTriggered`, `dominantStage`, and `finalClaimSource` to make
  TiMem-style scope control measurable

### GraphRAG

Primary source:
- [Microsoft GraphRAG](https://github.com/microsoft/graphrag)

What maps well to this repo:
- summary/community nodes should answer broad queries before leaf scans
- graph/context routing should be visible and auditable, not implicit

Repo decision:
- keep summary and community routing as the first pass for broad profile and
  commonality queries
- do not reopen broad traversal unless telemetry shows top-lane insufficiency

### HippoRAG

Primary source:
- [HippoRAG](https://github.com/OSU-NLP-Group/HippoRAG)

What maps well to this repo:
- hierarchical memory retrieval
- query-aware activation of deeper evidence only when higher layers are weak

Repo decision:
- continue favoring deterministic descent order over generic fan-out
- use latency-tail suites to prove where deeper evidence is actually required

### pgvector / pgvectorscale / ParadeDB

Primary sources:
- [pgvector](https://github.com/pgvector/pgvector)
- [pgvectorscale](https://github.com/timescale/pgvectorscale)
- [ParadeDB](https://github.com/paradedb/paradedb)

What maps well to this repo:
- vector and lexical acceleration can help only after the hot branches are
  measured precisely
- optimizer behavior and scan shape still matter more than theoretical index
  capability

Repo decision:
- do not add a broad index batch yet
- only add verified DB fixes after telemetry proves the repeated p95 hotspot

## Current Ranked Plan

1. add retrieval observability to `memory.search`
2. build a dedicated latency-tail review suite from real slow sampled queries
3. rerun sampled standard and confirm no correctness regression
4. run a slow full-corpus LoCoMo pass
5. run private OMI / OpenClaw review suites with the same telemetry surface
6. only then choose performance fixes or index work
