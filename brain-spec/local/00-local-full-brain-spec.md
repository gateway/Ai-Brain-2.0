# Local Full-Brain Spec

## Scope

This is the detailed engineering spec for building the full AI Brain 2.0
locally on an Apple Silicon Mac.

This is the primary reference architecture.

Target outcomes:

- rich long-term memory
- timeline and relationship recall
- chat plus voice plus file ingestion
- low token burn
- explicit provenance
- active truth and historical truth management
- provider-agnostic reasoning access through MCP

## Local Reference Stack

Primary substrate:

- `PostgreSQL 18`

Primary extensions and components:

- `TimescaleDB`
- `pgvector`
- `pgvectorscale`
- `pgai`
- BM25 lexical layer
- SQL RRF
- Node workers
- local MCP server

Optional provider layer:

- OpenAI
- OpenRouter
- local models

## Source-Check Corrections

NotebookLM was used repeatedly to sanity-check this architecture.

Its strongest signals were:

- tripartite memory
- hybrid retrieval
- TMT-style temporal hierarchy
- provenance
- consolidation and recency-based truth updates

The parts that required correction from primary sources or local reality were:

- do not assume `io_uring` on macOS
- do not assume every extension has equally easy local packaging
- do not assume multimodal embeddings are turnkey for every ingestion path

## System Hierarchy

### 1. Raw artifact layer

Stores:

- markdown files
- chat transcripts
- audio recordings
- transcript text
- PDFs
- images
- project files

Responsibilities:

- durable source of truth
- re-indexability
- provenance root

Required metadata:

- `artifact_id`
- `uri`
- `checksum`
- `mime_type`
- `namespace_id`
- `source_channel`
- `created_at`

### 2. Ingestion and normalization layer

Responsibilities:

- detect new artifacts
- preserve originals
- extract text
- fragment content
- enrich metadata
- generate embeddings
- classify candidate memory types

Fragment rule:

- `1` to `3` sentences per fragment

Benefits:

- reduces token burn
- improves retrieval precision
- keeps provenance granular

### 3. Episodic memory layer

Responsibilities:

- append-only event history
- exact transcript fragments
- tool call outcomes
- time-ordered evidence

Implementation shape:

- Timescale hypertables
- UUID v7 keys
- time indexes
- source pointers

Why it matters:

- "What happened?"
- "What happened in 2005?"
- "What did I say then?"

### 4. Semantic memory layer

Responsibilities:

- distilled facts
- patterns
- durable summaries
- reusable knowledge

Implementation shape:

- `pgvector`
- `pgvectorscale`
- importance scoring
- validity windows
- provenance back-links

Why it matters:

- concept-level recall
- lower retrieval payload
- long-term preference and knowledge search

### 5. Procedural state layer

Responsibilities:

- current truth
- user preferences
- active project specs
- agent skills
- runbooks

Implementation shape:

- relational tables
- JSONB where helpful
- explicit updates and versioning

Why it matters:

- current truth must not be reconstructed from history on every query

### 6. Relationship memory layer

Responsibilities:

- entity resolution
- links between people, places, projects, and artifacts

Implementation shape:

- `entities`
- `entity_aliases`
- `memory_entity_mentions`
- `entity_relationships`

Why it matters:

- relationship-heavy queries
- stronger temporal and social context

### 7. Temporal hierarchy layer

Responsibilities:

- organize memory by time
- support year, month, week, and day zoom-in
- reduce long-horizon search cost

Implementation shape:

- Temporal Memory Tree tables
- summary nodes
- parent-child links

Expected levels:

- segment
- session
- day
- week
- month or profile
- optionally year

Why it matters:

- "What was I doing in Japan in 2005, and who was I with?"

### 8. Retrieval layer

Responsibilities:

- exact-match recall
- semantic recall
- relationship-aware filtering
- temporal filtering
- rank fusion

Implementation shape:

- lexical branch
- vector branch
- metadata branch
- time branch
- RRF fusion

Why it matters:

- names and dates need exact search
- concepts need vector search
- neither is enough alone

### 9. Consolidation layer

Responsibilities:

- move durable signals out of episodic memory
- deduplicate
- resolve contradictions
- promote or suppress candidate memories

Implementation shape:

- candidate retrieval
- adjudication model or rules
- writeback actions:
  - `ADD`
  - `UPDATE`
  - `SUPERSEDE`
  - `IGNORE`

Why it matters:

- prevents memory junk drawer behavior

### 10. Forgetting layer

Responsibilities:

- keep the system bounded
- decay low-value derived memory
- preserve high-value anchors

Implementation shape:

- importance scores
- anchor flags
- hot/warm/cold tiers
- last-access tracking
- archival or deletion thresholds

Why it matters:

- lower token burn
- lower storage drag
- stronger retrieval quality

### 11. Interface layer

Responsibilities:

- expose the brain as tools

Implementation shape:

- MCP server
- tool contracts
- namespace-aware access control

Suggested tools:

- `memory.search`
- `memory.timeline`
- `memory.get_artifact`
- `memory.get_relationships`
- `memory.save_candidate`
- `memory.upsert_state`

### 12. Reasoning layer

Responsibilities:

- plan queries
- request only needed context
- answer with evidence
- optionally write new candidate memory

Why it matters:

- the brain should support any top-end model without coupling itself to it

## Ingestion Workflow

1. preserve the original artifact
2. register it in `artifacts`
3. extract text or transcript
4. split into atomic fragments
5. attach provenance and namespace
6. extract entities and tags
7. generate embeddings
8. insert episodic rows
9. stage candidate semantic or procedural memories

## Query Workflow

1. classify the query
2. extract entities, keywords, and time windows
3. choose memory layers
4. run lexical and vector search in parallel
5. apply temporal and relationship filters
6. fuse rankings with RRF
7. optionally expand through TMT summary nodes
8. assemble minimal context
9. answer with evidence and artifact pointers

## Conflict Resolution

Main rule:

- historical truth remains in episodic memory
- active truth is updated in semantic or procedural memory

Example:

- "I like sour stuff" remains in history
- "I now like sweet stuff" becomes active truth
- old durable belief is marked superseded

## Day, Week, And Month Summaries

Daily summaries:

- major events
- locations
- people
- decisions
- project activity

Weekly summaries:

- repeated themes
- preference movement
- relationship patterns
- project momentum

Monthly or profile summaries:

- long-term trajectories
- durable traits
- persistent project goals

These are part of the TMT and should always link back to supporting evidence.

## Token Burn Strategy

Use:

- atomic fragments
- summary nodes
- namespace scoping
- temporal scoping
- relationship-aware filtering
- semantic cache

Avoid:

- whole transcript injection
- redundant summary stacking
- reasoning without retrieval planning

## Mac-Specific Notes

Important correction:

- PostgreSQL 18 AIO on macOS should be treated as `io_method = worker`
- do not assume `io_uring` on the Mac path

Packaging-sensitive areas:

- local BM25 packaging
- extension installation order
- extension compatibility testing

Practical note:

- the architecture still wants a BM25-grade lexical layer
- if ParadeDB packaging is the initial blocker, use native PostgreSQL full-text
  search as the temporary bring-up path while preserving the richer target

## Build Order

1. local substrate and extensions
2. artifact registry
3. ingestion pipeline
4. episodic memory
5. semantic and procedural memory
6. hybrid retrieval
7. relationships
8. consolidation
9. TMT and summaries
10. forgetting
11. MCP
12. evaluation and tuning

## Benefits

- strongest privacy and ownership
- maximum extension freedom
- best fit for the ambitious brain
- easiest way to prove the full architecture

## Risks

- extension installation complexity
- TMT over-complexity if implemented too early
- bad adjudication corrupting active truth
- weak evaluation leading to self-deception
