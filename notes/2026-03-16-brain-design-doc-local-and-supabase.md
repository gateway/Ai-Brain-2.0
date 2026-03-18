# Brain Design Doc: Local Mac and Supabase

## Purpose

This document defines the first real build of a local-first AI brain that:

- runs on an Apple Silicon Mac with `16 GB` to `24 GB` RAM
- can be ported to Supabase without rewriting the architecture
- avoids multi-database sprawl
- preserves transcripts and raw notes as durable source material
- uses PostgreSQL as the actual brain substrate

This is not a "future V2" document.

This is the first build we should actually implement, test, break, and learn
from.

## Design Rules

1. One brain substrate: PostgreSQL.
2. Raw artifacts are never thrown away.
3. Retrieval is hybrid, not vector-only.
4. Memory is layered, not monolithic.
5. Every durable memory row must point back to source evidence.
6. Local Mac and Supabase should share the same schema and tool surface.
7. Use only the overlap stack in the first build:
   - PostgreSQL 18
   - `pgvector`
   - native PostgreSQL full-text search
   - SQL RRF
   - MCP

## Two Levels Of Architecture

To avoid losing capability, we need to separate:

- the `target brain`
- the `portable first slice`

### Target brain

This is the full smart architecture we are aiming for:

- `PostgreSQL 18`
- `pgvector`
- `pgvectorscale`
- `pgai`
- hybrid retrieval
- provenance
- temporal recall
- relationship links
- consolidation and belief revision
- MCP

### Portable first slice

This is the part that should run both locally and in Supabase without changing
the mental model:

- `PostgreSQL 18`
- `pgvector`
- native PostgreSQL full-text search
- SQL RRF
- tripartite memory model
- provenance
- namespace controls
- MCP

Important:

- we are **not** removing `pgvectorscale` or `pgai`
- we are placing them in the `target architecture` where they belong
- the first implementation slice should not depend on every environment
  exposing them the same way

## Architecture Summary

The first build has five main layers:

1. `Artifacts`
   - raw markdown, transcripts, PDFs, notes, and imported files
2. `Ingestion`
   - detect, normalize, fragment, enrich, and store memory candidates
3. `Memory Substrate`
   - episodic, semantic, and procedural memory in PostgreSQL
4. `Retrieval`
   - full-text + vector + metadata + time filters + RRF
5. `Agent Interface`
   - MCP tools and local or hosted workers

## Section Map

Each section below answers:

- what it does
- how it works
- why we are doing it this way
- local Mac implementation
- Supabase implementation

## 1. Artifacts and Source of Truth

### What this section does

It preserves the raw evidence layer:

- chats
- markdown notes
- dictated audio transcripts
- PDFs
- imported project files
- agent conversation transcripts

### How it works

Raw artifacts live outside the memory tables.

The system stores:

- the original file on disk or object storage
- an artifact record in PostgreSQL
- checksums and metadata
- provenance pointers from memory fragments back to the artifact

Suggested artifact folders on the Mac:

- `artifacts/raw/chat/`
- `artifacts/raw/transcripts/`
- `artifacts/raw/markdown/`
- `artifacts/raw/pdf/`
- `artifacts/raw/project/`

Minimum artifact metadata:

- `artifact_id`
- `artifact_type`
- `uri`
- `checksum`
- `mime_type`
- `created_at`
- `source_channel`
- `transcript_status`

### Why we do it this way

- transcripts must never be lost
- the database should not be the only copy of history
- provenance matters for trust, debugging, and re-indexing
- this matches the strongest OpenClaw lesson: files remain durable truth

### Local Mac

- canonical artifacts live on the filesystem
- PostgreSQL stores URIs that point back to local files

### Supabase

- canonical artifacts live in Supabase Storage or an equivalent object store
- PostgreSQL stores Storage paths plus checksums and metadata

## 2. Ingestion

### What this section does

It turns incoming raw material into machine-usable memory rows.

Inputs:

- direct chat turns
- markdown files
- dictated audio transcripts
- PDFs
- project notes
- imported logs
- agent-generated memory candidates

### How it works

Recommended first-build pipeline:

1. detect new or changed artifacts
2. extract text
3. fragment into atomic units
4. classify memory intent
5. generate embeddings
6. attach metadata and provenance
7. insert into episodic memory
8. stage semantic or procedural candidates for review

Fragment rule:

- store `1` to `3` sentence fragments
- never embed whole long documents as single rows

Recommended extracted metadata:

- `artifact_id`
- `fragment_index`
- `char_start`
- `char_end`
- `speaker`
- `channel`
- `captured_at`
- `namespace_id`
- `tags`
- `importance_score`
- `memory_candidate_type`

### Why we do it this way

- smaller fragments retrieve better
- atomic fragments reduce token waste
- provenance remains precise
- later re-embedding is easier

### Local Mac

Use a Node.js ingestion worker because Node is already present on this machine.

The local worker should:

- watch configured folders
- parse markdown and PDFs
- accept transcript drops from dictation flows
- insert fragments into PostgreSQL

### Supabase

Use an Edge Function or external worker for ingestion.

Recommended split:

- Edge Functions for API-style ingest
- external worker for heavier file parsing or long-running jobs if needed

## 3. Models and Media Understanding

### What this section does

It decides which model tasks exist in the system and whether they are local or
remote.

### How it works

First-build model tasks:

- transcription
- text embedding
- lightweight metadata extraction
- optional consolidation reasoning
- final answer generation by the client-facing LLM

### Why we do it this way

- it keeps the core memory system provider-agnostic
- it avoids baking a single vendor into the database shape
- it separates memory infrastructure from reasoning infrastructure

### Hard recommendation for the first build

Do **not** build the system around multimodal-native embeddings yet.

Reason:

- NotebookLM suggested Gemini multimodal embeddings repeatedly
- current official Google AI embeddings docs are text-oriented, not the
  general multimodal embedding workflow the notebook implied

First-build media strategy:

- audio:
  - transcribe to text, keep original audio
- PDFs:
  - extract text and keep original PDF
- images:
  - optional caption/OCR later, keep original image
- everything gets embedded as text for now

### Local Mac

Keep the runtime pluggable:

- transcription:
  - local preferred later
  - remote acceptable initially
- embeddings:
  - remote text embeddings first
  - local embeddings later if needed
- reasoning:
  - remote model is acceptable because the memory stays local

### Supabase

- embeddings and metadata extraction can run inside Edge Functions when light
- heavier document parsing or transcription should run in a worker, not inside
  a fragile serverless path

## 4. Memory Model

### What this section does

It defines how the brain stores different kinds of memory.

### How it works

Use three memory layers.

#### Episodic memory

Purpose:

- immutable event record
- session and life history
- exact historical evidence

Properties:

- append-only
- timestamped
- provenance-linked
- queryable by time, person, project, and namespace

Use it for:

- "Where was Steve in Japan in 2025?"
- "What did we discuss last Tuesday?"
- transcript-level recall

#### Semantic memory

Purpose:

- distilled facts
- recurring patterns
- stable summaries
- long-term user and project knowledge

Properties:

- mutable but governed
- embedding-backed
- deduplicated
- linked back to episodic evidence

Use it for:

- stable preferences
- recurring relationships
- summarized project knowledge

#### Procedural memory

Purpose:

- current truth
- active project configuration
- skills
- rules
- instructions

Properties:

- mutable
- relational first
- authoritative for current behavior

Use it for:

- current project specs
- current user preferences
- agent skills and policies
- runbooks and required workflows

### Why we do it this way

- history and current truth are different things
- this handles contradictions cleanly
- it matches the strongest stable architecture signal in the notebook

### Local Mac

- all three layers live in PostgreSQL 18

### Supabase

- same schema
- same table names
- same SQL functions

## 4A. Relationship Memory

### What this section does

It builds entity and relationship awareness so the brain can connect:

- people
- places
- projects
- devices
- organizations
- sessions
- memories

### How it works

Use relational links inside PostgreSQL, not a separate graph database in the
first build.

Recommended relationship tables:

- `entities`
- `entity_aliases`
- `memory_entity_mentions`
- `entity_relationships`

Example entity types:

- `person`
- `place`
- `project`
- `organization`
- `artifact`
- `skill`

Example relationship types:

- `knows`
- `worked_on`
- `visited`
- `was_with`
- `mentioned_in`
- `supports`
- `supersedes`

### Why we do it this way

- it supports queries like:
  - "What was I doing in Japan in 2005?"
  - "Who was I with?"
  - "Which projects were active then?"
- it keeps relationships queryable in SQL
- it avoids adding a separate graph system too early

### Local Mac

- use normal relational tables plus indexes
- derive many links during ingestion or consolidation

### Supabase

- identical schema
- identical query model
- RLS can scope relationship visibility by namespace

## 5. Contradictions, Forgetting, and Belief Updates

### What this section does

It decides how the brain updates current truth without erasing history.

### How it works

Use a two-step rule:

1. history is never deleted from episodic memory
2. current truth is updated in semantic or procedural memory

Belief update pattern:

- old preference remains in episodic memory
- current preference becomes active in procedural or semantic memory
- old durable belief is marked:
  - `superseded`
  - `inactive`
  - `valid_to`

Recommended policy:

- `recency wins` for active truth
- `history stays` for auditability

Forgetting policy:

- do not forget raw artifacts
- do not delete episodic evidence by default
- expire or demote low-value semantic rows
- keep session-specific noise out of long-term memory

Examples:

- "I like spicy food" becomes a durable belief if repeated
- "No spicy food right now" updates active truth immediately
- "Window seat for this trip" stays session-scoped unless repeated later

### Why we do it this way

- it matches human-style changing preferences
- it avoids polluted long-term memory
- it preserves explainability

### Local Mac

- a consolidation worker runs at session end and on a periodic schedule

### Supabase

- use `pg_cron` plus an Edge Function or worker for scheduled consolidation

## 6. Retrieval

### What this section does

It answers memory queries accurately.

### How it works

Use hybrid retrieval with four parts:

1. native PostgreSQL full-text search
2. `pgvector` similarity search
3. metadata and namespace filters
4. reciprocal rank fusion in SQL

Recommended first-build retrieval flow:

1. run full-text search for exact terms
2. run vector search for conceptual similarity
3. filter by namespace, artifact type, and time range
4. merge with RRF
5. return top fragments plus provenance

Use metadata filters for:

- namespace
- project
- person
- artifact type
- source channel
- time range

Use time filters first, not Temporal Memory Tree, for the first build.

### Why we do it this way

- exact names and dates matter
- vector-only search misses precise facts
- full-text alone misses meaning
- RRF is simple and portable
- timestamp filtering solves most real first-build temporal questions

### Do we need Temporal Memory Tree now?

No.

First-build answer:

- use normal timestamp fields and indexes
- use time-window filters
- add temporal hierarchies only after proving they are necessary

## 6A. Temporal Learning And Recall

### What this section does

It gives the brain a real sense of time:

- what happened
- when it happened
- in what sequence it happened
- how beliefs changed over time

### How it works

The first build should support temporal reasoning through:

- `occurred_at`
- `captured_at`
- `valid_from`
- `valid_to`
- `session_id`
- `artifact_id`
- person and place links

This supports:

- time-window retrieval
- timeline reconstruction
- active-truth vs historical-truth queries
- longitudinal learning

Example query path for:

- "What was I doing in Japan in 2005?"

Recommended steps:

1. resolve `Japan` to a place entity
2. filter episodic memories to `2005-01-01` through `2005-12-31`
3. prioritize rows linked to the Japan entity
4. retrieve co-mentioned people, projects, and artifacts
5. fuse lexical, vector, and relationship signals
6. return a timeline summary with cited fragments

### Why we do it this way

- it is enough to make the system meaningfully time-aware
- it avoids overbuilding a Temporal Memory Tree before the base loop works
- it preserves a clean migration path to temporal hierarchies later

### Where temporal learning actually happens

It happens in two places:

- ingestion:
  - every event is stamped and linked
- consolidation:
  - repeated patterns are promoted
  - outdated beliefs are superseded
  - durable timelines become easier to reconstruct

### Future upgrade path

If timestamp filtering and timeline reconstruction are not enough, then add:

- day, week, month summary nodes
- year buckets
- explicit parent-child temporal rollups

That is the point where a real `Temporal Memory Tree` becomes justified.

### Local Mac

Recommended first-build retrieval stack:

- PostgreSQL 18
- `pgvector`
- native full-text search
- SQL RRF function

Optional later local optimization:

- `pgvectorscale`

### Supabase

Recommended hosted retrieval stack:

- PostgreSQL
- `pgvector`
- native full-text search
- SQL RRF function

Do not depend on:

- ParadeDB
- `pgvectorscale`

for the shared local + Supabase first build.

## 7. Security and Namespaces

### What this section does

It keeps personal, work, and project memory logically separated.

### How it works

Every memory-bearing row should include:

- `namespace_id`
- `project_id`
- `owner_id` if needed
- classification tags

Recommended namespace examples:

- `personal`
- `work`
- `project_<slug>`
- `skills`

### Why we do it this way

- personal and work memory should not blur together by accident
- retrieval precision improves when the search space is scoped
- it maps cleanly to Supabase RLS

### Local Mac

- namespace filtering is mainly application-level
- RLS can still be used if multiple agents or users ever touch the database

### Supabase

- use Row-Level Security
- Edge Functions use service role only for internal maintenance
- client-facing read paths should stay scoped to authorized namespaces

## 8. MCP and Agent Interface

### What this section does

It exposes the brain as tools instead of dumping the full database into the
model context.

### How it works

The MCP server should expose a minimal first-build surface:

- `memory.search`
- `memory.get_fragment`
- `memory.get_artifact`
- `memory.save_candidate`
- `memory.upsert_procedural`
- `memory.list_recent`

Each result should return:

- fragment text
- source artifact
- timestamp
- namespace
- confidence or rank

### Why we do it this way

- open protocol, low vendor lock
- portable across clients
- easier to reason about than provider-specific memory features

### Local Mac

- run MCP as a local Node.js service
- use stdio or localhost transport depending on the client

### Supabase

- either expose an HTTP MCP-compatible service
- or keep the MCP server outside Supabase and point it at Supabase Postgres

## 9. Runtime Layout

### Local Mac runtime

First-build recommended services:

1. PostgreSQL 18
2. ingestion worker
3. consolidation worker
4. MCP server
5. optional transcript drop folder or capture adapter

What you need to install:

- `postgresql@18`
- `pgvector`
- Node.js

What is not yet installed on this machine:

- PostgreSQL client/server
- Docker
- Rust toolchain
- Deno

Recommendation:

- use a Node-first build, not Deno-first
- avoid Docker as a hard dependency for the Mac-only path
- avoid Rust-built extensions until the core system is working
- add `pgvectorscale` locally once PostgreSQL 18 is installed and the base
  schema is working
- add `pgai` when we want automatic embedding sync and in-database vectorizer
  workflows

### Supabase runtime

First-build recommended services:

1. Supabase Postgres
2. `pgvector`
3. SQL functions for retrieval
4. RLS policies
5. Edge Functions for light ingest and hosted APIs
6. scheduled jobs via `pg_cron`
7. optional external worker for heavier parsing

Important current constraint:

- local Supabase development requires Docker, which is not installed here yet

## 10. Database Shape

### Required tables

- `artifacts`
- `artifact_transcripts` if needed
- `episodic_memory`
- `semantic_memory`
- `procedural_memory`
- `memory_links`
- `memory_candidates`
- `consolidation_runs`

### Minimum table responsibilities

`artifacts`

- one row per raw file or import

`episodic_memory`

- fragment-level append-only records

`semantic_memory`

- distilled knowledge rows with embeddings

`procedural_memory`

- active state and current truth

`memory_links`

- cross-links such as:
  - `derived_from`
  - `supports`
  - `supersedes`

`memory_candidates`

- agent-proposed memories pending consolidation

## 11. Do We Need To Write Code?

Yes.

The first build needs at least:

- SQL migrations
- a folder ingestion worker
- transcript import logic
- fragmenter
- embedding adapter
- retrieval SQL functions
- consolidation worker
- MCP server

The notebook is useful for architecture, but none of this becomes real without
code.

## 12. Recommended Build Order

### Phase 1

- install PostgreSQL 18
- enable `pgvector`
- create the core schema
- implement artifact registry
- ingest markdown and plain text transcripts

### Phase 2

- add hybrid retrieval
- add RRF SQL
- expose MCP search tools
- validate personal and project queries

### Phase 3

- add consolidation and belief updates
- add procedural memory writes
- add namespace controls

### Phase 4

- add PDF extraction
- add audio transcript ingestion
- add hosted Supabase mirror

### Phase 5

- consider local-only acceleration:
  - `pgvectorscale`
- consider richer image handling
- consider temporal hierarchy only if timestamp filtering proves insufficient

## 13. Functionalities By Section

### Artifact management

- preserve raw files
- checksum and provenance
- re-index support

### Ingestion

- watch folders
- import transcripts
- parse markdown
- parse PDFs
- fragment and enrich text

### Memory

- store events
- store distilled facts
- store active truth
- track relationships and supersession

### Retrieval

- exact keyword recall
- semantic recall
- time-bounded recall
- namespace-scoped recall

### Consolidation

- deduplicate
- update beliefs
- promote durable knowledge
- keep historical truth

### Interface

- MCP access
- local agent integration
- future OpenClaw alignment

### Security

- namespaces
- RLS in hosted mode
- provenance and auditability

## 14. Final Recommendation

Build the first shipped implementation on the conservative overlap stack:

- PostgreSQL 18
- `pgvector`
- native PostgreSQL full-text search
- SQL RRF
- Node.js workers
- MCP
- raw artifacts preserved outside the DB

Then layer the full target-brain features on top:

- `pgvectorscale` for higher-performance filtered vector search on local or
  Timescale-compatible deployments
- `pgai` for vectorizer workflows, embedding sync, and tighter database-native
  AI pipelines
- richer relationship extraction
- temporal rollups or a real Temporal Memory Tree if evidence shows we need it

This is the strongest architecture because it:

- matches the notebook's stable signal
- works locally on a Mac
- ports cleanly to Supabase
- avoids vendor lock and multi-database sprawl
- preserves the path to a much smarter brain instead of flattening it

## 15. Open Questions After This Spec

- which transcript capture channels come first
- which embedding provider is the temporary default
- whether local transcription is required from day one
- whether the first codebase should start local-first only or dual-target local
  plus Supabase from the start
