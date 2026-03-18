# Local Brain Progress And Next Slices

## Current Estimate

Current local-brain completion estimate: `~82%`

This is not a marketing number. It reflects what is already proven on this Mac
versus what still depends on real external inputs, larger-scale benchmarks, or a
missing interaction layer.

## Slice Ratings

- substrate, install, and DB runtime: `92%`
- artifacts, provenance, and ingestion spine: `88%`
- hybrid retrieval: `80%`
- relationships, supersession, and decay: `78%`
- temporal summaries and time-bounded recall: `76%`
- multimodal derivation pipeline: `60%`
- live producer ingestion and external endpoint integration: `72%`
- `pgai` integration and vector backfill controls: `70%`
- MCP and assistant tool-serving layer: `35%`
- docs, runbooks, and evaluation harness: `89%`

## What Was Proven In This Slice

- Slack live receiver:
  - valid signed challenge request returns `200`
  - invalid signature returns `401`
  - allowlist rejection returns `202`
- Discord live receiver:
  - invalid shared secret returns `401`
  - allowlist rejection returns `202`
- Derivation queue:
  - repeated enqueue of the same artifact/job pair reuses the same durable row
  - a dead external derivation provider now causes a retryable queue state, not a terminal one-shot failure
  - worker claims jobs with `FOR UPDATE SKIP LOCKED`
- Core eval:
  - `npm run eval` still passes after these runtime changes

## NotebookLM Reconciliation

### `pgai`

Recommendation after another loop: keep `pgai` as a sidecar.

Reason:
- Node already owns raw ingestion, provenance, and authoritative writes.
- That is the right control point for a brain with episodic, semantic, and procedural memory.
- `pgai` is useful for controlled embedding backfill, shadow-vector experiments, and derivative-table regeneration.
- It should not own raw artifacts, episodic memory, or active-truth tables.

### BM25 / ParadeDB

Recommendation after the reconciliation prompt: do **not** switch lexical retrieval to ParadeDB in the very next slice.

Reason:
- BM25 is still the right target lexical upgrade.
- But the current repo is more constrained by incomplete multimodal derivation, missing MCP, and not-yet-strong-enough temporal retrieval than by lexical precision alone.
- Native PostgreSQL FTS plus vector RRF is already functional.
- ParadeDB should come after the next capability slices, not before them.

## What Still Needs Real Runtime Inputs

- real Slack secrets, team/channel/user allowlists, and production relay wiring
- real Discord secrets, guild/channel/user allowlists, and production relay wiring
- a reachable external AI endpoint for OCR / transcription / caption / derivation work
- live OpenRouter and/or Gemini keys if those providers will be used directly

## The Next Slices In Order

### Slice 1: Real Multimodal Workers

Goal:
- turn binary artifacts into searchable text without manual proxy text

Build:
- OCR worker
- speech-to-text worker
- caption / extraction worker
- queue processors that write into `artifact_derivations`

Why now:
- this closes the `capture -> interpret` gap
- it is a bigger capability unlock than swapping lexical ranking today

### Slice 2: MCP Server

Goal:
- let Claude, ChatGPT, Cursor, and other clients actively query and write to the brain

Build:
- `memory.search`
- `memory.timeline`
- `memory.relationships`
- `artifact.get`
- controlled write tools for safe memory operations

Why now:
- the brain becomes an active tool substrate instead of passive local storage

### Slice 3: Stronger Temporal / TMT Retrieval

Goal:
- improve long-horizon recall and reduce token burn

Build:
- temporal branch selection
- layered day/week/month/profile traversal
- query classification for simple vs hybrid vs complex recall

Why now:
- this matters directly for questions like:
  - `Who was I with in Japan in 2025?`
  - `What changed about my preferences over the last three months?`

### Slice 4: BM25 / ParadeDB Benchmark Gate

Goal:
- decide with evidence whether to replace native FTS

Build:
- local install proof for ParadeDB
- mirrored lexical benchmark queries
- precision / MRR / latency comparison against current FTS

Switch only if:
- exact entity / code / acronym queries improve materially on your eval set
- local packaging is stable on this Mac
- write-path complexity stays acceptable

## Health Review

The system is still coherent.

What is good:
- Postgres remains the center of truth
- raw evidence remains on disk
- queues absorb external-provider instability
- memory classes are still explicit
- decay and supersession preserve history instead of deleting it

What is still transitional:
- lexical branch is honest but not final
- multimodal understanding is not yet autonomous
- MCP is specified but not yet running
- TMT is scaffolded, not fully behaviorally complete

## Recommended Immediate Next Move

Build the real multimodal worker loop first, targeting your external local AI
endpoint as the first derivation backend. That gives the current queue and
artifact model a real sensory pipeline without changing the core memory
architecture.
