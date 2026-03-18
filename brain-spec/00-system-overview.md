# AI Brain 2.0 System Overview

## Goal

Build a rich long-term AI brain that can:

- ingest chat, voice, markdown, PDFs, images, and project files
- preserve source-of-truth artifacts
- remember events across years
- answer timeline and relationship queries
- maintain active truth while preserving historical truth
- expose memory through chat, voice, and tool calls
- keep token burn under control

Example target query:

- "What was I doing in Japan in 2005, and who was I with?"

This is not a flat note store.

This is not a simple vector database.

This is a cognitive memory substrate with:

- artifact preservation
- episodic memory
- semantic memory
- procedural state
- relationship memory
- temporal hierarchy
- hybrid retrieval
- consolidation
- forgetting
- MCP tools

## Two Build Paths

There are two valid implementation paths.

### Path A: Local full brain

This is the primary path.

Target stack:

- PostgreSQL 18
- TimescaleDB hypertables
- `pgvector`
- `pgvectorscale`
- `pgai`
- BM25 layer
- SQL RRF
- Node workers
- local MCP server

Use this path when the goal is maximum capability and local ownership.

### Path B: Hosted brain

This is the secondary path.

Target stack:

- Supabase Postgres
- `pgvector`
- SQL RRF
- Edge Functions
- external workers where needed
- hosted MCP-compatible bridge

Use this path when faster deployment and remote access matter more than perfect
parity with the local stack.

## Core Design Rules

1. PostgreSQL is the brain substrate.
2. Raw artifacts are not disposable.
3. Every durable memory row points back to evidence.
4. Retrieval is hybrid, not vector-only.
5. Time is a first-class dimension.
6. Relationships are explicit, not implied only by embeddings.
7. Current truth and historical truth are not the same thing.
8. Summaries are generated hierarchically.
9. Forgetting applies to derived memory before source evidence.
10. The reasoning model is replaceable; the brain is not.

## Main Layers

The system is organized from bottom to top.

1. Raw artifacts
2. Ingestion and normalization
3. Episodic memory
4. Semantic memory
5. Procedural state
6. Relationship memory
7. Temporal hierarchy
8. Retrieval and ranking
9. Consolidation and belief updates
10. Forgetting and compression
11. Interface and tool layer
12. Reasoning layer

## Why This Architecture Exists

Each part solves a different failure mode.

Raw artifacts:

- prevents data loss
- enables re-indexing
- supports provenance

Episodic memory:

- preserves what happened and when

Semantic memory:

- supports concept-level recall

Procedural state:

- stores active truth and current rules

Relationship memory:

- makes the brain understand people, places, projects, and links

Temporal hierarchy:

- supports long-horizon memory without scanning everything

Hybrid retrieval:

- combines precision and meaning

Consolidation:

- prevents memory from becoming a junk drawer

Forgetting:

- keeps the system fast and relevant

MCP:

- keeps the brain provider-agnostic

## Provider Strategy

The brain should support multiple providers for embeddings and lightweight AI
cleanup.

Possible providers:

- OpenAI
- OpenRouter
- local models

Guideline:

- the provider should be abstracted behind the ingestion and consolidation
  layers
- do not hard-code the architecture to a single model vendor

## NotebookLM Cross-Checks

NotebookLM was used to sanity-check:

- overall hierarchy
- ingestion and query loop
- consolidation and summaries
- temporal memory
- relationship-aware recall

The notebook strongly reinforced:

- tripartite memory
- RRF hybrid retrieval
- fragment-based ingestion
- provenance
- temporal hierarchy
- recency-based active truth updates

It also required correction on a few implementation details:

- do not assume `io_uring` on macOS
- treat multimodal embeddings carefully unless officially verified for the
  exact workflow we want

## What Success Looks Like

The finished brain can:

- accept a new audio dictation
- transcribe it
- fragment it
- attach provenance
- store the event in episodic memory
- extract durable preferences or facts
- update semantic or procedural memory when justified
- generate daily or weekly summaries
- answer a later question with evidence and source pointers

That is the minimum bar for "brain," not "chat history."
