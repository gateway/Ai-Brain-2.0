# Hybrid Retrieval And Runtime Proof

## Section

This slice moved local search from lexical-only into a real hybrid retrieval path:

- lexical branch: native PostgreSQL full-text search
- vector branch: `semantic_memory.embedding` plus `artifact_derivations.embedding`
- fusion: Reciprocal Rank Fusion (RRF)
- fallback: lexical-only when no query embedding is available

## NotebookLM Loop

NotebookLM guidance that held up:

- use hybrid lexical + vector retrieval
- fuse by rank, not by raw score
- exact vector distance is acceptable at personal-brain scale before ANN indexes
- keep ParadeDB, `pgvectorscale`, and `pgai` as later upgrades rather than pretending they already exist

NotebookLM guidance I corrected:

- it pushed strongly toward a SQL-only fused kernel immediately
- that is still a valid target, but the current local codebase already had heterogeneous retrieval split across several tables
- the implementation-safe step was to add vector retrieval and RRF now, verify it, and document that SQL-first fusion remains the next retrieval upgrade

## What Was Implemented

- `searchMemory()` now supports:
  - provided query embeddings
  - provider-generated query embeddings
  - lexical fallback on provider auth/unavailable conditions
- hybrid vector search covers:
  - `semantic_memory`
  - embedded `artifact_derivations`
- time-windowed search now biases `episodic_memory` above later-stage candidate rows when lexical scores tie
- search responses now include retrieval metadata:
  - `retrievalMode`
  - `queryEmbeddingSource`
  - `vectorFallbackReason`
  - lexical/vector candidate counts

## Runtime Verification

Verified on `2026-03-18`:

- `npm run check`
- `npm run eval`
- `npm run migrate`
- `npm run adjudicate:relationships -- --namespace <eval_ns> ...`
- `npm run summarize:temporal -- --namespace <eval_ns> ...`
- `npm run decay:semantic -- --namespace <eval_ns> ...`

Observed live DB effects for the seeded eval namespace:

- `relationship_memory`: populated
- `temporal_nodes`: populated
- `temporal_node_members`: populated
- `semantic_decay_events`: populated

The current evaluation harness now verifies:

- Japan 2025 episodic recall
- provenance pointers
- preference supersession
- webhook ingestion
- binary artifact + text-proxy behavior
- hybrid vector branch activation
- relationship adjudication
- weekly temporal summaries
- semantic decay

## Self Review

What went well:

- hybrid retrieval is now real, not just planned
- the regression harness caught a ranking problem immediately
- the ranking issue was fixed without losing provenance quality
- temporal/relationship/decay code is no longer “typecheck only”; it mutated real rows successfully

Pending issues:

- the hybrid fusion kernel is still app-side, not the final SQL-first plan
- lexical ranking is still PostgreSQL FTS, not ParadeDB BM25
- vector search is exact scan today; no ANN or `pgvectorscale` yet
- multimodal-native derivation remains deferred in favor of text proxies
- relative-time understanding is still weak

Current confidence:

- hybrid retrieval slice: about `90%`
- deterministic temporal/relationship/decay slice: about `88%`

The remaining gap is no longer whether the architecture makes sense. It is bringing up the heavier local extension stack and replacing transitional components with their final forms.
