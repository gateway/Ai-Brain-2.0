# Verified Technology Matrix

## Scope

This note separates:

- what NotebookLM suggested
- what is currently verified from official docs or this Mac
- what should remain optional or deferred

Date of verification:

- `2026-03-16`

## Local Mac Verification

Machine:

- `arm64`
- `macOS 26.3.1`

Installed now:

- `node v25.6.1`
- `supabase 2.75.0`

Missing now:

- `docker`
- `psql`
- `rustc`
- `cargo`
- `deno`

Homebrew package availability verified:

- `postgresql@18`
- `pgvector`
- `supabase`

Interpretation:

- local PostgreSQL 18 is feasible on this Mac
- `pgvector` is easy to install locally
- Supabase local development is not ready yet because Docker is missing
- building Rust-based Postgres extensions locally is not ready yet because
  `rustc` and `cargo` are missing

## Official Supabase Verification

Verified from official Supabase docs:

- Supabase supports `pgvector`
- Supabase supports Edge Functions
- Supabase supports `pg_cron`
- Supabase supports local development through the Supabase CLI
- local Supabase development depends on Docker

Important current limitation:

- I did not find official Supabase docs confirming support for
  `pgvectorscale`
- I did not find official Supabase docs confirming `pg_search` as a native
  primary-database extension
- the official ParadeDB integration is presented as a separate replicated
  search product, not as "the same Postgres brain"

Interpretation:

- if we want one architecture that runs both locally and on Supabase, the
  first build should not depend on `pgvectorscale` or `ParadeDB`
- the safe common denominator is:
  - PostgreSQL
  - `pgvector`
  - native PostgreSQL full-text search
  - SQL-based reciprocal rank fusion

## Official Gemini Embeddings Verification

NotebookLM repeatedly suggested `Gemini Embedding 2` for multimodal vectors.

Current official Google AI documentation does **not** support that assumption.

Verified from official docs:

- Gemini embeddings are currently documented as text embeddings
- official docs do not currently document PDF or image embeddings as a stable
  general embeddings workflow

Interpretation:

- do not design the first build around Gemini multimodal embeddings
- for the first build:
  - transcribe audio to text
  - OCR or extract text from PDFs
  - caption or describe images if needed
  - embed text
- multimodal-native embeddings should stay optional until officially verified

## OpenClaw Verification

Verified from the OpenClaw repo docs:

- workspace memory is markdown-first
- session transcripts are persisted as JSONL files
- semantic memory is layered on top of files, not used as the sole source of
  truth
- memory is plugin-based, not the entire assistant architecture

Interpretation:

- OpenClaw is a good assistant shell and transcript source
- our AI brain should be the Postgres memory substrate behind it
- raw transcripts and raw markdown should remain durable files outside the
  memory tables

## NotebookLM Signals Worth Keeping

These themes were consistent across notebook answers and artifact decks:

- tripartite memory:
  - episodic
  - semantic
  - procedural
- hybrid retrieval:
  - lexical
  - vector
  - reciprocal rank fusion
- provenance back to raw artifacts
- consolidation and belief updates
- timestamp-aware retrieval
- relationship-aware retrieval
- MCP as the open interface

## NotebookLM Signals To Treat Carefully

- `Gemini Embedding 2` as a ready multimodal embedding layer
- `pgvectorscale` as if it were equally available on Supabase
- `ParadeDB` as if it were a no-compromise part of a single-Postgres hosted
  architecture
- `Temporal Memory Tree` as a first-build requirement

## Current Recommended MVP Stack

To maximize portability and minimize vendor lock:

- database:
  - `PostgreSQL 18`
- vector search:
  - `pgvector`
- lexical search:
  - native PostgreSQL full-text search with `tsvector` and `GIN`
- ranking:
  - reciprocal rank fusion in SQL
- raw artifacts:
  - local filesystem on Mac
  - local filesystem or Supabase Storage in hosted mode
- service layer:
  - Node.js workers and MCP server
- memory model:
  - episodic + semantic + procedural

Optional later accelerators:

- `pgvectorscale` for local-only scale tuning
- `pgai` for embedding synchronization and vectorizer workflows across
  PostgreSQL-backed deployments
- Supabase Edge Functions for hosted ingress and MCP
- multimodal-native embeddings once officially supported and justified

## What Stays In The Target Brain

These are not cut from the architecture:

- `pgvectorscale`
- `pgai`
- richer relationship extraction
- temporal rollups
- eventual Temporal Memory Tree support

The reason they were not placed in the strict overlap stack is deployment
portability, not lack of value.
