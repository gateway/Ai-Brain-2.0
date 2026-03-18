# Run Log: Timescale, pgvectorscale, pgai, and Live Producers

Date: 2026-03-18

## Summary

This pass completed four local bring-up goals:

- `TimescaleDB` was brought up locally through a safe sidecar hypertable instead of an in-place `episodic_memory` conversion.
- `pgvectorscale` was installed locally and DiskANN indexes were added to vector-bearing tables.
- `pgai` was installed into the repo-local Python venv and evaluated as a controlled sidecar for embedding sync/backfill.
- live Slack and Discord receiver endpoints were added on top of the existing producer normalization path, along with an external AI derivation route.

NotebookLM was queried before each section, then cross-checked against local runtime constraints and official tooling behavior. The useful pattern held: keep the database-centered brain stable, and add acceleration and producer layers around that core without letting them rewrite provenance rules.

## What Worked

### 1. TimescaleDB

- Direct conversion of `episodic_memory` into a hypertable was rejected because the current foreign-key graph is keyed on `episodic_memory(id)`, while Timescale requires unique indexes on hypertables to include the partition column.
- The safe solution was a derived `episodic_timeline` hypertable keyed by `(occurred_at, memory_id)`.
- `episodic_memory` remains the authoritative table for ids and downstream references.
- Time-bounded readers now use the hypertable where appropriate.

Verified locally:

- `timescaledb` extension installed.
- `episodic_timeline` exists as a hypertable with `occurred_at` as the primary dimension.
- chunk interval is `7 days`.
- eval parity check passed: `episodic_memory` and `episodic_timeline` row counts matched.

### 2. pgvectorscale

- `pgvectorscale` was compiled and installed against local PostgreSQL 18 using a Rust + `cargo-pgrx` toolchain.
- DiskANN indexes were created for:
  - `semantic_memory.embedding`
  - `artifact_derivations.embedding`
- The current retrieval query shape already matched the index-compatible `ORDER BY embedding <=> $query LIMIT n` form, so no retrieval rewrite was needed to start benefiting from DiskANN.

Verified locally:

- `vectorscale` extension installed.
- DiskANN indexes present.
- `EXPLAIN` showed `Index Scan using idx_semantic_embedding_diskann`.

### 3. pgai

- The first attempt used `pgai[vectorizer-worker]`, which pulled too much optional weight for the current evaluation pass.
- The useful path was narrower:
  - rebuild `.venv-brain` on Python 3.13
  - install base `pgai`
  - run `pgai install -d postgresql:///ai_brain_local`
  - keep Node as the write gateway
  - keep `vector_sync_jobs` as the controlled application queue
- Result: `ai` schema is installed and available for future vectorizer experiments, but the runtime still stays app-owned and auditable.

Verified locally:

- `.venv-brain` now uses Python `3.13.12`
- `pgai 0.12.1` installed
- `pgai install` completed against `ai_brain_local`
- `ai` schema and vectorizer-related objects exist

### 4. Live Producers and External Derivation Route

- Fixed the TypeScript break in `src/producers/live.ts`.
- Added and validated:
  - `POST /producer/slack/events`
  - `POST /producer/discord/events`
  - `POST /derive/provider`
- Slack URL verification style flow was smoke-tested successfully.
- Discord relay ingestion created a durable normalized artifact and reused the shared ingest path.
- External derivation route failed cleanly with `fetch failed` when no external AI service was present, which is the correct current boundary behavior.

Verified locally:

- `npm run check` passed
- `npm run eval` passed after these changes
- `GET /health` succeeded
- `POST /producer/slack/events` returned a challenge response
- `POST /producer/discord/events` ingested a test event
- `POST /derive/provider` failed cleanly without corrupting data when no external service was reachable

## What Did Not Work Cleanly

### 1. Direct Hypertable Conversion

That path would have forced a composite primary key refactor across the existing FK graph. It was rejected in favor of the sidecar hypertable approach.

### 2. `pgai[vectorizer-worker]` as the First Evaluation Step

That install path was too heavy for the narrow goal of controlled embedding sync/backfill. It also created confusion while the venv was still on Python 3.9. Base `pgai` was the correct first evaluation step.

### 3. Assuming External Derivation Was Already Live

The route is present, but the external endpoint is not yet connected. Current behavior is intentionally safe failure, not silent success.

## Design Direction After This Pass

- `TimescaleDB`: keep the sidecar hypertable model.
- `pgvectorscale`: keep DiskANN behind the existing retrieval shape and benchmark it on larger corpora next.
- `pgai`: keep it as a controlled sidecar, not the source of truth.
- live producers: keep provider-specific receivers thin and feed the shared provenance-preserving ingestion contract.
- external AI services: use them for derivation and embeddings, not as direct writers into semantic or procedural truth.

## Current Health

The system is still coherent:

- Postgres remains the center.
- Raw artifacts remain the evidence layer.
- Timescale, pgvectorscale, and pgai now extend the core instead of replacing it.
- Producer adapters and external AI routes feed the same ingestion and provenance model.

The main remaining gaps are:

- ParadeDB / BM25-native lexical branch
- SQL-first fused hybrid kernel
- automatic OCR / transcription / caption jobs
- real external AI endpoint integration
- signed, allowlisted production Slack/Discord deployment

## Latest Eval Snapshot

Latest passing eval run after this slice:

- namespace: `eval_1773804197889`
- fragments ingested: `5`
- candidate writes: `4`
- episodic inserts: `5`
- relationship count for Japan query: `2`
- timeline count for 2025 query: `1`
- abstention result count for unknown query: `0`
- hybrid vector candidate count: `2`
- adjudicated relationship count: `5`
- temporal node count: `1`
- semantic decay event count: `1`
- episodic timeline parity count: `9`
- approximate token payload for Japan query: `62`

All eval checks passed, including:

- Japan search relevance
- 2025 timeline recall
- relationship recall for Sarah and Ken
- spicy vs sweet preference supersession
- provenance pointers
- webhook ingest
- binary artifact plus proxy-text search
- hybrid vector branch
- Timescale mirror parity
