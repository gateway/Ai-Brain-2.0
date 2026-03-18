# 33 - Multimodal, Vector Sync, And Runtime Proof

Date: 2026-03-18

## Scope

This slice completed the next safe step for multimodal memory on the current
local brain:

- derivation queue stays the durable extraction layer
- vector sync becomes the separate embedding layer
- temporal recall gains an explicit planner
- MCP becomes a runnable local tool surface

## NotebookLM Guidance Used

### Multimodal Workers

NotebookLM recommended the same durable sequencing that the code now follows:

- raw artifact stays on disk
- OCR / transcription / caption work writes text proxies first
- embeddings happen as a second queued stage

This was cross-checked against the current repo shape and against the existing
`external` provider adapter.

### BM25 / pgai

NotebookLM was re-queried earlier in this phase and the conclusion still holds:

- `pgai` stays a sidecar
- BM25 / ParadeDB remains a later benchmark gate, not the next immediate slice

## What Changed

### Multimodal / Embedding Pipeline

- `derivation_jobs` remain the durable extraction queue.
- `embed` derivation jobs are now treated as a compatibility bridge instead of a
  mistaken second multimodal derive pass.
- `vector_sync_jobs` now have a real worker path:
  - claim pending jobs
  - resolve text from `semantic_memory` or `artifact_derivations`
  - call the configured embedding provider
  - write vectors back
  - retry transient failures with backoff

### Temporal Retrieval

- Added a planner helper that classifies recall as `simple`, `hybrid`, or
  `complex`.
- Queries containing a year like `2025` now infer a conservative calendar
  window.
- Temporal recall prefers episodic evidence and `temporal_nodes` summaries.

### MCP

- The local stdio MCP server is runnable and exposes:
  - `memory.search`
  - `memory.timeline`
  - `memory.get_artifact`
  - `memory.get_relationships`
  - `memory.save_candidate`
  - `memory.upsert_state`

## Verification Performed

### Typecheck

- `npm run check` passed.

### Full Eval

- `npm run eval` passed after the planner and queue changes.

### Temporal Search Smoke

Query:

- `What was I doing in Japan in 2025?`

Observed behavior:

- planner intent: `complex`
- inferred window: `2025-01-01` through `2025-12-31`
- branch preference: `episodic_then_temporal`
- top result remained the expected June 2025 episodic fragment

### Vector Sync Runtime Smoke

Using a fresh eval namespace:

- `vector-sync:enqueue` created pending rows for `semantic_memory` and
  `artifact_derivations`
- `vector-sync:work` claimed and retried those rows against an unavailable
  `external` provider
- persisted DB state showed:
  - `status = pending`
  - `retry_count = 1`
  - `last_error = 'fetch failed'`
  - `next_attempt_at` advanced

This confirms the current worker behaves like a real maintenance queue instead
of silently dropping jobs.

### MCP Smoke

A local stdio JSON-RPC harness verified:

- `initialize`
- `tools/list`
- `tools/call` for `memory.search`

The search response included the new planner metadata and returned the expected
historical recall result.

## Current Assessment

This branch is now meaningfully closer to the full brain:

- multimodal ingestion has a durable queue and a correct second-stage vector path
- temporal recall is more intentional
- MCP is live as a usable local interface

Still missing for the next slices:

- a reachable external OCR / STT / caption endpoint
- stronger parent-child TMT linkage
- BM25 / ParadeDB benchmark gate
- more complete MCP write/tool surface only if needed after real use
