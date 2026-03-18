# Local Full-Brain Target Architecture

## Goal

This note defines the ambitious local-first target for the AI Brain on an
Apple Silicon Mac.

This is not the minimal portable slice.

This is the full local brain we want to build toward:

- temporal memory
- relationships
- hybrid recall
- hierarchical consolidation
- conflict-aware truth updates
- smart forgetting
- MCP tool access
- high-performance Postgres-native vector retrieval

## Short Answer

Yes, we can target a serious local Brain 2.0 on a Mac Mini or MacBook Pro with
Apple Silicon.

The right local target is:

- `PostgreSQL 18`
- `TimescaleDB` hypertables for episodic history
- `pgvector`
- `pgvectorscale`
- `pgai`
- `ParadeDB` for BM25
- local or remote transcription
- hybrid RRF retrieval
- relationship tables
- Temporal Memory Tree logic in the application layer
- MCP server for model access

## What We Are Building

The brain has ten major sections.

## 1. Cognitive Substrate

### What it is

The substrate is the core database system that everything else attaches to.

### Local target

- `PostgreSQL 18`

### Why it belongs

- one substrate for relational state, time-series memory, vectors, and SQL
- avoids vendor sprawl
- gives us transactions, constraints, indexing, and extension support

### Important local detail

PostgreSQL 18 asynchronous I/O is real and useful, but on macOS the practical
setting is:

- `io_method = worker`

not:

- `io_method = io_uring`

because `io_uring` is Linux-specific and requires a build with `liburing`.

## 2. Episodic Timeline

### What it is

This is the append-only life log and transcript history.

### Local target

- `TimescaleDB`
- hypertables over `episodic_memory`
- time chunking
- compression for older data

### Why it belongs

- fast range queries over large histories
- supports questions like:
  - "What was I doing in Japan in 2005?"
- allows chunk pruning instead of scanning the entire table
- makes decades of episodic memory manageable

### Important implementation note

Use hypertables for:

- chat events
- transcript fragments
- imported journaling events
- timeline summaries

## 3. Vector Retrieval Layer

### What it is

This is the semantic recall engine.

### Local target

- `pgvector`
- `pgvectorscale`
- StreamingDiskANN
- SBQ compression
- filtered vector retrieval

### Why it belongs

- `pgvector` gives the core vector type and operators
- `pgvectorscale` gives the fast local ANN path we actually want
- StreamingDiskANN is designed for SSD-backed workloads
- SBQ reduces index size and helps the Mac fit larger memory corpora

### Verified points

From the official `pgvectorscale` README:

- supports StreamingDiskANN
- supports SBQ through `storage_layout = memory_optimized`
- supports label-based filtered vector search
- Apple Silicon build-from-source is the intended self-hosted path

## 4. Lexical Retrieval Layer

### What it is

This is the exact-match search engine for names, dates, codes, places, and
terms that embeddings miss.

### Local target

- `ParadeDB` / `pg_search`

### Why it belongs

- exact names like `Steve` or `Japan`
- exact years like `2005`
- product names, IDs, acronyms, and highly specific terms

### Important local detail

ParadeDB's current official local install path is Docker-first.

That means:

- it is part of the target brain
- but it likely changes the local bring-up path
- we may run the local brain either:
  - inside a Postgres/ParadeDB container stack
  - or start with native PostgreSQL full-text search and add ParadeDB when the
    Docker path is ready

This is a local packaging issue, not a reason to cut BM25 from the target
architecture.

## 5. Hybrid RRF Retrieval

### What it is

This is the ranking engine that fuses exact-match and semantic search.

### Local target

- SQL CTE search branches
- over-fetch lexical candidates
- over-fetch vector candidates
- fuse with Reciprocal Rank Fusion

### Why it belongs

- vector-only recall is not enough
- keyword-only recall is not enough
- RRF is simple, robust, and database-friendly

### Query types this enables

- person + place + year
- project + tool + date
- preference + time range
- relationship reconstruction queries

## 6. Relationship Memory

### What it is

This is the entity and relationship layer.

### Local target

- `entities`
- `entity_aliases`
- `memory_entity_mentions`
- `entity_relationships`

### Why it belongs

We need the brain to understand:

- who
- where
- what project
- what device
- what artifact
- what relationship

Example relationship types:

- `was_with`
- `visited`
- `worked_on`
- `mentioned_in`
- `owned`
- `supports`
- `supersedes`

This is how the brain becomes more than a vector search system.

## 7. Temporal Learning

### What it is

This is the logic that makes memory time-aware rather than just text-aware.

### Local target

- event timestamps
- validity windows
- timeline reconstruction
- temporal summaries
- Temporal Memory Tree

### Why it belongs

You explicitly want:

- "What was I doing in Japan in 2005?"

That requires:

- time-bounded recall
- entity linking
- historical truth
- current truth separation
- hierarchy over long horizons

### Recommended implementation path

Start with:

- `occurred_at`
- `captured_at`
- `valid_from`
- `valid_to`
- entity links
- time-bucketed summaries

Then build:

- day nodes
- week nodes
- month nodes
- year nodes

This becomes the actual Temporal Memory Tree.

TMT is not a PostgreSQL extension.

It is application logic plus tables plus consolidation rules.

## 8. Consolidation And Conflict Resolution

### What it is

This is the system that turns raw history into coherent memory.

### Local target

- session-time candidate extraction
- asynchronous adjudication
- semantic merge
- contradiction detection
- supersession links
- active truth updates

### Why it belongs

Without consolidation, memory becomes a junk drawer.

The brain needs to:

- detect duplicates
- merge near-duplicates
- distinguish temporary requests from durable preferences
- preserve history while updating current truth

### Core rule

- recency wins for active truth
- history remains for auditability

### Output actions

- `ADD`
- `UPDATE`
- `SUPERSEDE`
- `IGNORE`

## 9. Forgetting And Memory Temperature

### What it is

This is the mechanism that prevents uncontrolled memory bloat.

### Local target

- hot, warm, cold memory tiers
- importance decay
- permanent anchors
- access-based refresh
- deletion or archival thresholds for low-value derived memory

### Why it belongs

The brain should not retain every derived summary forever.

It should:

- always keep raw artifacts
- keep episodic evidence unless explicitly archived
- decay low-value semantic fragments
- preserve anchors and critical facts

### Important rule

Raw transcripts and canonical artifacts do not die.

Derived memory can decay.

## 10. Ingestion And Transformation

### What it is

This is the pipeline that converts life inputs into usable memory.

### Local target

- Node.js or Deno orchestration
- transcript import
- markdown import
- PDF text extraction
- audio transcription
- fragmenter
- metadata extractor
- embedding generator

### Why it belongs

Good memory depends on good ingestion.

Recommended fragment unit:

- `1` to `3` sentences

This is how we reduce context noise and improve retrieval precision.

## 11. pgai

### What it is

This is the database-native AI workflow layer.

### Local target

- `pgai`
- vectorizer workers
- synchronized embeddings
- optional S3/document loading later

### Why it belongs

`pgai` is not just a convenience package.

It helps us:

- keep embeddings synchronized with source tables
- define vectorizer workflows declaratively
- avoid writing fragile embedding sync plumbing by hand

### Verified point

The official `pgai` project explicitly says it:

- automatically creates and synchronizes embeddings
- works with any PostgreSQL database
- supports `pgvector` and `pgvectorscale`
- uses stateless vectorizer workers

This makes it a strong fit for the local full brain.

## 12. MCP Interface

### What it is

This is how Claude, ChatGPT, Cursor, or other agents talk to the brain.

### Local target

- local MCP server
- stdio transport first
- focused memory tools

### Why it belongs

- provider-agnostic model access
- the model calls the brain as tools
- the database remains the durable substrate

Recommended initial tool surface:

- `memory.search`
- `memory.timeline`
- `memory.get_artifact`
- `memory.get_relationships`
- `memory.save_candidate`
- `memory.upsert_state`

## 13. Semantic Cache

### What it is

This is a local response and retrieval cache for semantically similar queries.

### Local target

- local cache table in PostgreSQL
- optional `UNLOGGED` table for very hot short-lived cache data

### Why it belongs

- lower latency
- lower LLM cost
- repeated semantic queries should not always invoke the full stack

## 14. What Is Missing If We Stop At Basic RAG

If we stop at:

- flat embeddings
- one memory table
- no time layer
- no relationships
- no conflict-aware consolidation

then we do **not** have the brain you want.

The real Brain 2.0 requires:

- tripartite memory
- temporal memory
- relationship memory
- hybrid recall
- conflict-aware truth management
- provenance
- consolidation
- forgetting

## 15. Recommended Local Build Order

This is still the right order, even for the ambitious build.

### Phase 1: Local substrate

- install PostgreSQL 18
- install TimescaleDB
- enable `uuidv7()`
- create artifact and episodic tables

### Phase 2: Search core

- enable `pgvector`
- build semantic tables
- add native full-text search first if needed
- install `pgvectorscale`
- benchmark DiskANN locally

### Phase 3: Hybrid retrieval

- add RRF SQL functions
- add metadata filters
- add relationship-aware retrieval joins

### Phase 4: Consolidation

- add candidate tables
- add contradiction adjudication
- add supersession links
- add importance decay

### Phase 5: Temporal hierarchy

- add day, week, month, year summary nodes
- add TMT traversal logic
- add timeline-oriented tools

### Phase 6: MCP and agent use

- expose the retrieval and write tools over MCP
- test with real notebooks, transcripts, and project history

## 16. Local Feasibility Summary

### Strongly feasible on a Mac

- PostgreSQL 18
- TimescaleDB
- `pgvector`
- `pgvectorscale`
- `pgai`
- Node-based ingestion
- Whisper transcription
- MCP
- relationship tables
- consolidation workers

### Feasible but packaging-sensitive

- ParadeDB / `pg_search`

### Application logic, not extension install

- Temporal Memory Tree
- conflict-aware reconsolidation prompt
- forgetting and temperature tiers
- relationship extraction

## 17. Final Position

We should design and build the local brain as the full target brain.

That means:

- do **not** dumb it down
- do **not** stop at basic RAG
- do **not** remove `pgvectorscale`, `pgai`, hypertables, relationships, or
  temporal logic from the design

The correct engineering move is:

- define the full local architecture
- bring it up in a sane order
- test where it breaks
- then adapt the implementation without shrinking the vision
