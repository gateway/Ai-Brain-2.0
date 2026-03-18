# Supabase Brain Spec

## Scope

This is the hosted Brain 2.0 engineering spec built around Supabase as the
primary Postgres layer.

This is a separate track from the local full-brain reference architecture.

Goal:

- keep the same mental model as the local brain
- adapt to Supabase's managed environment
- use hosted storage, APIs, and serverless orchestration where they help

## Hosted Reference Stack

Core platform:

- Supabase Postgres
- Supabase Storage
- Edge Functions
- `pg_cron`
- `pgvector`

Likely companion layers:

- SQL RRF
- external worker for heavy processing
- hosted MCP bridge
- OpenRouter or other model providers

## Source-Check Corrections

NotebookLM was useful for hosted architecture direction, but it needed
correction in a few places.

Useful notebook signals:

- tripartite memory still applies
- hybrid retrieval still applies
- provenance and consolidation still apply
- Edge Functions are useful as orchestration points

Corrections from official Supabase checks:

- official support is clear for `pgvector`, `pg_cron`, Storage, and Edge
  Functions
- official support is not clearly confirmed for `pgvectorscale`, `pgai`, or
  ParadeDB as a seamless primary-database BM25 layer

This means the hosted spec should distinguish:

- the ideal target
- the safe current baseline

Safe current baseline:

- Supabase Postgres
- `pgvector`
- native PostgreSQL full-text search
- SQL RRF
- Storage
- Edge Functions
- external workers where needed

## System Hierarchy

### 1. Storage substrate

Responsibilities:

- host the memory tables
- expose SQL and API access
- enforce RLS

What should live in Postgres:

- artifacts registry
- episodic memory
- semantic memory
- procedural state
- entities
- relationships
- summary nodes
- retrieval functions
- consolidation state

### 2. Artifact storage

Responsibilities:

- preserve raw artifacts outside memory tables

What should live in Storage:

- markdown files
- transcripts
- audio files
- images
- PDFs
- import bundles

Why:

- raw evidence should not be collapsed into the DB alone

### 3. Ingestion layer

Responsibilities:

- accept uploads and events
- preserve artifacts
- extract text
- fragment content
- request embeddings
- write memory candidates

What belongs in Edge Functions:

- lightweight orchestration
- request validation
- artifact registration
- write-path coordination

What should not be forced into Edge Functions:

- long-running transcription
- heavy PDF pipelines
- large batch re-embedding
- deep reasoning chains

Use an external worker when jobs are long or compute-heavy.

### 4. Episodic memory

Responsibilities:

- append-only event log
- time-ordered evidence
- transcript history

Implementation:

- timestamped rows
- namespace-aware
- source pointers

### 5. Semantic memory

Responsibilities:

- distilled facts
- reusable knowledge
- vector-backed recall

Implementation:

- `pgvector`
- validity windows
- importance scores

### 6. Procedural state

Responsibilities:

- current truth
- current preferences
- active project specs
- agent configuration

Implementation:

- relational tables
- RLS-sensitive access paths

### 7. Relationship memory

Responsibilities:

- track people, places, projects, and links between them

Implementation:

- entities
- aliases
- mentions
- relationships

### 8. Temporal hierarchy

Responsibilities:

- day, week, and month summaries
- long-horizon recall

Implementation:

- summary tables
- parent-child temporal links
- background generation jobs

Note:

- this is application logic plus tables, not a native Supabase feature

### 9. Retrieval engine

Responsibilities:

- lexical retrieval
- semantic retrieval
- time and namespace filtering
- RRF fusion

Implementation:

- SQL functions
- `pgvector`
- native full-text search as the safe baseline

Target upgrade path:

- stronger BM25 path if officially supported and operationally clean

### 10. Consolidation and conflict resolution

Responsibilities:

- dedupe
- preference updates
- supersession links
- summary generation

Implementation:

- scheduled jobs
- worker or Edge Function orchestration
- adjudication model through provider abstraction

### 11. Hosted MCP layer

Responsibilities:

- expose brain tools to external models and clients

Implementation:

- hosted MCP-compatible service
- access keys
- RLS-aware execution

## Provider Strategy

OpenRouter is a valid provider layer for:

- embeddings
- lightweight metadata extraction
- summary generation
- adjudication calls

Do not bind the schema or memory model to OpenRouter.

Treat it as a swappable provider.

## Supabase Strengths

- hosted Postgres
- built-in auth and API surface
- Storage buckets
- Edge Functions
- RLS
- easier remote access

## Supabase Weaknesses

- weaker extension parity than the local full brain
- resource ceilings on lower tiers
- serverless cold starts
- not a good place for all heavy compute

## Main Design Rules

1. Keep raw artifacts outside the memory tables.
2. Keep tripartite memory.
3. Keep provenance.
4. Keep hybrid retrieval.
5. Keep consolidation.
6. Do not force all heavy jobs into Edge Functions.
7. Use RLS for namespace isolation.
8. Use provider abstraction for model-dependent tasks.
9. Default to the safe official baseline when extension availability is unclear.

## Benefits

- easy remote access
- fast path to hosted APIs
- cleaner collaboration surface

## Risks

- assuming local extension parity
- overloading Edge Functions
- underestimating free-tier limits
- confusing hosted convenience with architectural completeness
