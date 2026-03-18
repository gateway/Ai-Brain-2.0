# Full Local Brain Build Spec

## Summary

This document is the consolidated local build, programming, setup, and install
spec for **Brain 2.0** on an Apple Silicon Mac.

It is meant to answer:

- what the brain is
- what parts live in PostgreSQL 18
- what parts live outside PostgreSQL
- how the system should be installed locally
- what services and workers need to exist
- what the core tables and jobs are
- how the brain handles memory, conflict, forgetting, and time
- how we validate that it is actually working

This document assumes:

- Apple Silicon Mac
- local-first deployment
- raw evidence kept on local disk
- Postgres-centered architecture
- provider-agnostic model layer

## Current Verified Status

As of `2026-03-17`, the local implementation has verified:

- native PostgreSQL 18 bring-up
- artifact registry and versioned observations
- markdown/text/transcript ingestion
- webhook producer ingestion
- entity and relationship staging
- lexical-first search, timeline, and relationship lookup
- deterministic preference supersession
- binary artifact registration for `image`, `pdf`, and `audio`
- text-proxy derivations for captions/OCR/manual extraction text
- HTTP runtime endpoints
- reproducible local evaluation with all current checks passing

Still deferred:

- true BM25-native retrieval path
- vector-backed hybrid retrieval in live recall
- Timescale hypertables
- `pgvectorscale` / DiskANN / SBQ
- `pgai`
- provider-backed multimodal derivation execution
- TMT summary jobs
- relationship adjudication and memory decay jobs

## One-Sentence Architecture

**Brain 2.0 is a Postgres 18-centered cognitive substrate that preserves raw
artifacts on disk, writes atomic episodic memory, promotes durable semantic and
procedural memory through background consolidation, retrieves with hybrid
lexical plus vector recall, and exposes the result through MCP tools.**

## What Lives In Postgres And What Does Not

### Lives in PostgreSQL 18

- artifact registry metadata
- episodic memory
- semantic memory
- procedural memory / active truth
- entity registry
- relationship graph
- temporal nodes and TMT structure
- retrieval SQL
- RRF fusion logic
- supersession and validity windows
- namespace isolation and RLS
- job audit data
- semantic cache

### Does not live entirely in PostgreSQL

- raw markdown, transcripts, audio, images, PDFs, and project files
- file watchers and reconciliation scanners
- transcription and OCR
- embedding generation
- contradiction adjudication models
- recall planner and recall gating calls
- MCP server transport

Postgres is the brain substrate, not the whole organism.

## Acronym Map

- `RAG`: retrieval-augmented generation
- `BM25`: lexical ranking using global corpus statistics
- `RRF`: reciprocal rank fusion
- `TMT`: Temporal Memory Tree
- `MCP`: Model Context Protocol
- `RLS`: Row-Level Security
- `AIO`: asynchronous I/O
- `SBQ`: Statistical Binary Quantization
- `pgvector`: Postgres vector type and search operators
- `pgvectorscale`: DiskANN/SBQ vector acceleration
- `pgai`: vectorizer and AI workflow tooling around Postgres

## Non-Negotiable Features

- tripartite memory:
  - episodic
  - semantic
  - procedural
- relationship memory and entity graph
- time-aware recall
- TMT-style hierarchy
- hybrid lexical plus vector retrieval
- RRF fusion
- provenance back to evidence
- conflict-aware updates
- gradual forgetting of derived low-value memory
- provider-agnostic model layer
- MCP tool access
- flexible ingestion producers

## Flexible Ingestion Principle

The brain must support many producers feeding one substrate.

Examples of valid ingestion producers:

- direct chat turns
- markdown note files
- OpenClaw-style markdown session logs
- voice dictation transcripts
- audio recordings after transcription
- PDFs after extraction
- images after OCR/captioning
- custom bridge scripts
- a pre-processing LLM that classifies or cleans input before it is submitted

The rule is:

- many producers
- one ingestion contract
- one Postgres-centered brain

## Tripartite Memory Substrate

### 1. Episodic Memory

What it is:

- append-only historical record
- immutable evidence timeline

What it stores:

- chat turns
- transcript fragments
- tool results
- imported note fragments
- raw event descriptions

Why it exists:

- reproducibility
- auditability
- time-travel queries
- evidence for later consolidation

Example:

- `"Dinner with Sarah in Kyoto after landing in Japan."`

### 2. Semantic Memory

What it is:

- distilled facts, patterns, and abstracted knowledge

What it stores:

- preferences
- travel facts
- recurring habits
- learned patterns
- project knowledge summaries

Why it exists:

- efficient long-term recall
- semantic retrieval
- less token burn than raw transcripts

Example:

- `"User traveled with Sarah frequently during Japan 2025 trip."`

### 3. Procedural Memory / Active Truth

What it is:

- mutable right-now state

What it stores:

- current preferences
- current project specs
- active workflows
- skill activation state
- policy-like operational facts

Why it exists:

- the system must answer current-state queries deterministically

Example:

- `"food.preference.spicy = dislike"`

## Temporal Memory Tree (TMT)

The target hierarchy is:

- `L1`: segment
- `L2`: session
- `L3`: day
- `L4`: week
- `L5`: profile

### TMT Rules

- every parent interval must contain its children
- higher levels must become fewer and more abstract
- summary nodes must link back to supporting evidence
- retrieval may descend or ascend depending on query complexity

### Why TMT Exists

- year-scale recall without scanning everything
- coherent timeline zoom-in
- lower token burn for long-horizon queries

Example:

- `"Who was I with in Japan in 2025?"`
  - planner narrows to 2025
  - retrieves segment evidence and supporting summaries
  - expands relationship edges
  - returns answer with provenance

## Relationship Memory

The brain must maintain entity memory for:

- people
- places
- projects
- organizations
- artifacts
- skills

And edges such as:

- `was_with`
- `visited`
- `worked_on`
- `mentioned_in`
- `supports`
- `supersedes`

### Important Rule

Relationship memory cannot depend on the model spontaneously deciding to create
 graph links.

Relationship extraction must be a mandatory consolidation behavior.

## Fragmentation Rule

Default fragment size:

- `1` to `3` sentences

Why:

- better retrieval precision
- better provenance
- lower token burn
- easier entity extraction

### Correction

First-pass fragmentation is not assumed perfect forever.

Long dictation, noisy transcripts, or mixed-topic notes may be re-segmented
during consolidation.

## Provenance Model

Every durable memory path should include:

- `artifact_id`
- `source_uri`
- `source_offset` or range when useful
- `captured_at`
- `namespace_id`
- `artifact_version`
- `source_hash`
- extraction metadata

### Provenance Durability Rule

Offsets alone are brittle.

So provenance should use:

- file URI for location
- byte offset for navigation
- content hash for durable identity
- chunk fingerprint for recovery after later edits

## Hybrid Retrieval

The brain must retrieve through multiple branches:

- lexical branch
- vector branch
- temporal branch
- relationship branch

### Lexical branch

Used for:

- names
- exact places
- years
- codes
- project terms

Target:

- BM25-grade lexical ranking

### Vector branch

Used for:

- meaning
- concept similarity
- abstraction matching
- summary recall

### Fusion

Results are combined with:

- `RRF`

### Retrieval planner

The planner should classify the query as:

- current-state
- historical
- relationship
- timeline
- project-state

That classification determines:

- which memory layers are primary
- whether TMT expansion is needed
- whether active-truth filters apply
- whether relationship joins are required

### Recall gating

After candidate retrieval, a final filtering pass should remove:

- semantic noise
- temporally wrong distractors
- stale current-state candidates
- contradictory context that should not reach the final reasoning window

## Conflict Resolution

Example:

- January: `"I like spicy food"`
- April: `"I hate spicy food"`

Expected behavior:

- January and April statements remain in episodic memory
- January semantic fact becomes superseded or inactive
- April semantic fact becomes the durable current preference candidate
- procedural memory updates active truth
- historical queries can still retrieve the January belief

### Minimum durable fields

- `valid_from`
- `valid_until`
- `status`
- `superseded_by`
- `confidence`
- `source_artifact_id`

### Consolidation actions

- `ADD`
- `UPDATE`
- `SUPERSEDE`
- `IGNORE`

## Human-Like Forgetting

What should decay first:

- repetitive chatter
- stale low-value derived summaries
- low-signal semantic clutter

What should be protected:

- raw artifacts
- core episodic evidence
- anchor facts
- explicit preference changes
- recurring error patterns
- strong relationship evidence
- high-value time-and-place facts

### Mechanisms

- `importance_score`
- `is_anchor`
- access frequency
- validity windows
- hot / warm / cold tiers
- storage-time decay jobs

### Rule

Forgetting should reduce derived clutter, not erase the evidence needed to
explain why the brain believes what it believes.

## Security And Isolation

Namespace-based isolation should exist from the beginning.

Primary namespaces may include:

- personal
- work
- project-specific
- skills / agent-state

Use RLS to keep default reads scoped to the intended namespace.

Allow cross-namespace queries only through explicit authorized retrieval paths.

## Current Machine State

Checked on this Mac as of `2026-03-17`:

- architecture: `arm64`
- Homebrew: present
- `postgresql@18` formula: available in Homebrew
- `pgvector` formula: available in Homebrew
- `postgres`, `psql`: not currently installed
- `docker`: not installed
- `rustc`, `cargo`: not installed
- default Homebrew search does not expose `timescaledb` or `paradedb` formulas
  without additional setup

This matters because the install spec must be honest about what is immediately
available and what needs taps, source builds, binaries, or containers.

## Target Local Stack

- PostgreSQL 18
- namespace-aware schema
- raw artifacts on disk
- TimescaleDB hypertables
- `pgvector`
- `pgvectorscale` with StreamingDiskANN and SBQ
- `pgai`
- BM25-grade lexical retrieval
- SQL RRF
- background consolidation jobs
- MCP server

## Safe First Baseline

If some extensions are not installed yet, the initial runnable baseline can use:

- PostgreSQL 18
- `pgvector`
- native PostgreSQL full-text search
- SQL RRF
- artifact registry on disk
- tripartite schema

This is not a feature reduction. It is a bring-up sequence.

## Local Install And Setup Spec

### Install order

1. Homebrew sanity
2. PostgreSQL 18
3. pgvector
4. TimescaleDB
5. Rust toolchain
6. pgvectorscale
7. lexical retrieval layer
8. pgai
9. application config
10. migrations

### Step 1: Homebrew sanity

Verify:

```bash
brew --version
brew update
```

### Step 2: PostgreSQL 18

Install:

```bash
brew install postgresql@18
```

Validate:

```bash
brew services start postgresql@18
psql --version
psql postgres -c "SELECT version();"
psql postgres -c "SELECT uuidv7();"
```

Config direction:

- prefer `io_method = worker` on macOS
- do not assume Linux-only `io_uring`

### Step 3: pgvector

Install:

```bash
brew install pgvector
```

Validate:

```sql
CREATE EXTENSION IF NOT EXISTS vector;
CREATE TABLE test_vectors (id bigserial primary key, embedding vector(3));
INSERT INTO test_vectors (embedding) VALUES ('[1,2,3]');
SELECT * FROM test_vectors ORDER BY embedding <=> '[1,2,3]' LIMIT 1;
```

### Step 4: TimescaleDB

Install path:

- official Tiger Data macOS docs indicate TimescaleDB on macOS should be
  installed against a Homebrew or MacPorts Postgres
- default Homebrew search on this machine did not expose a `timescaledb`
  formula directly, so this likely requires the vendor tap or source/binary path

Validate:

```sql
CREATE EXTENSION IF NOT EXISTS timescaledb;
SELECT extname FROM pg_extension WHERE extname = 'timescaledb';
```

Then verify hypertables on episodic memory.

### Step 5: Rust toolchain

Needed for:

- `pgvectorscale` source build path

Install:

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source "$HOME/.cargo/env"
rustc --version
cargo --version
```

### Step 6: pgvectorscale

Install path:

- likely source build or prebuilt binary path, depending on current release

Why:

- StreamingDiskANN
- SBQ
- better memory and SSD behavior for larger vector corpora

Validate:

```sql
CREATE EXTENSION IF NOT EXISTS vectorscale CASCADE;
```

Then test a DiskANN index on a real vector table.

### Step 7: lexical retrieval layer

Target:

- ParadeDB BM25-grade search

Reality on this machine:

- `brew search paradedb` did not show a formula
- ParadeDB official docs are current, but local install path may require their
  binaries, releases, or Docker path instead of default brew

Bring-up rule:

- if ParadeDB install is clean, use it
- if not, start with native `tsvector` plus RRF and preserve BM25 as the target

### Step 8: pgai

Why:

- vectorizer pipeline
- background sync
- queueing and retry model for embeddings

Validate:

- install database components
- create a small test vectorizer
- prove embeddings can sync without blocking primary writes

### Step 9: application config

Define:

- artifact root folders
- namespace conventions
- provider config
- ingestion producer config
- MCP server config
- model routing config

### Step 10: migrations

Run the first full schema only after:

- Postgres is stable
- chosen extensions are known
- config locations are fixed

## Programming Architecture

### Artifact Registry

Does:

- registers files
- computes hashes
- stores URIs and versions

Does not:

- OCR
- transcription
- embedding generation

### Ingestion Worker

Does:

- coordinate extraction
- fragment content
- attach provenance
- write episodic rows
- stage candidate semantic and procedural writes

Does not:

- own long-term memory policy
- perform final reasoning

### Transcription / OCR adapters

Does:

- convert audio, PDFs, or images into faithful text streams

Does not:

- summarize
- decide what becomes durable memory

### Embedding Adapter

Does:

- generate embeddings from text or multimodal input

Does not:

- choose active truth
- manage vector indexes directly

### Retrieval Service

Does:

- route query type
- run lexical/vector/time/relationship retrieval
- fuse candidates
- return provenance-rich results

Does not:

- answer the final user question by itself

### Relationship Extraction Service

Does:

- detect entities
- resolve aliases
- create or strengthen edges

Does not:

- replace retrieval logic

### Consolidation Jobs

Does:

- promote knowledge
- update procedural truth
- apply supersession

Does not:

- run inline during every synchronous chat turn

### TMT Summary Jobs

Does:

- build segment/session/day/week/profile hierarchy
- enforce temporal containment

Does not:

- overwrite episodic history

### Forgetting Jobs

Does:

- apply decay to derived memory
- protect anchor facts

Does not:

- delete raw evidence blindly

### MCP Server

Does:

- expose tools
- normalize input/output for models

Does not:

- duplicate business logic from retrieval or consolidation layers

### Evaluation Harness

Does:

- run regression questions
- score retrieval behavior
- benchmark extension performance

Does not:

- mutate production memory

## Schema And Table Responsibilities

### Artifact group

- `artifacts`
- `artifact_chunks`

Use for:

- source-of-truth registration
- versioning
- checksums
- extraction units

### Episodic group

- `episodic_memory`

Use for:

- append-only timeline
- raw evidence
- time-travel reconstruction

### Semantic group

- `semantic_memory`
- `memory_candidates`

Use for:

- durable abstractions
- candidate promotion
- validity windows
- supersession

### Procedural group

- `procedural_memory`

Use for:

- active truth
- current preferences
- current project state
- skill or workflow state

### Relationship group

- `entities`
- `entity_aliases`
- `memory_entity_mentions`
- `entity_relationships`

Use for:

- graph-like recall in Postgres

### Temporal group

- `temporal_nodes`
- `temporal_node_members`

Use for:

- TMT structure
- summary nodes
- temporal containment

### Support group

- `semantic_cache`
- `consolidation_runs`

Use for:

- latency improvement
- auditability of background jobs

## Example Flows

### Example 1: OpenClaw markdown session

1. OpenClaw writes `session-2026-03-17.md`
2. watcher notices the file
3. periodic reconciler also scans later as a correctness backstop
4. artifact registry stores:
   - URI
   - hash
   - version
5. text is extracted
6. fragments are created
7. episodic rows are written
8. entity mentions are extracted
9. candidate semantic/procedural writes are staged
10. consolidation later promotes durable knowledge

### Example 2: spicy food contradiction

1. January statement enters episodic memory
2. semantic candidate says user likes spicy food
3. procedural state may adopt that preference
4. April statement enters episodic memory
5. consolidator finds contradiction
6. old semantic fact becomes superseded
7. procedural state updates to dislike spicy food
8. historical query still shows the January belief
9. current-state query returns the April truth

### Example 3: Japan 2025

User asks:

- `"Who was I with in Japan in 2025?"`

System path:

1. planner classifies as historical relationship query
2. entity extractor resolves `Japan`
3. time filter narrows to 2025
4. lexical branch searches exact mentions
5. vector branch searches conceptual companions and travel fragments
6. relationship joins pull co-mentioned people
7. TMT nodes provide summary context if useful
8. recall gating removes semantically similar but temporally wrong items
9. answer returns with provenance to markdown, transcript, or itinerary

## Provider And Model Layer

The brain must remain provider-agnostic.

### Good provider split

- transcription:
  - local Whisper-style path first
- OCR/captioning:
  - local or external depending quality and privacy needs
- embeddings:
  - local-capable where possible
  - external acceptable where quality matters
- contradiction/adjudication:
  - small fast model or local NLI first
  - stronger model only when needed
- final reasoning:
  - local if good enough
  - otherwise routed through provider layer or OpenRouter-style gateway

### Rule

Store in Postgres:

- text
- vectors
- provenance
- status
- validity

Do not store provider-specific logic as the identity of the brain.

## Evaluation And Benchmark Plan

The brain is not real until it passes:

### Truth tests

- active truth recall
- historical truth recall
- preference evolution

### Relationship tests

- person and place recall
- project relationship recall
- repeated-edge strengthening

### Timeline tests

- Japan-style itinerary reconstruction
- month/week/day containment
- time-zone correctness

### Provenance tests

- source URI opens correctly
- evidence still recoverable after file moves or edits

### Token tests

- compare flat-document recall to fragment plus summary recall
- measure payload reduction

### Summary quality tests

- detect hallucinated or collapsed profile summaries
- compare summary statements to supporting leaf evidence

### Gating tests

- measure false positives and false negatives in recall gating

### Forgetting tests

- low-signal memory decays
- anchor facts survive
- evidence base remains intact

### Performance tests

- pgvector baseline
- DiskANN/SBQ target
- lexical branch latency
- RRF query latency
- `io_method = worker` throughput changes

## Recommended Build Order

1. substrate bring-up
2. schema migrations
3. artifact registry
4. markdown/transcript ingest
5. retrieval service
6. conflict-aware consolidation
7. relationship extraction
8. TMT summary jobs
9. forgetting jobs
10. MCP server
11. evaluation harness
12. multimodal expansion

## Immediate Detailed Next Steps

### 1. Finalize install matrix

- decide native-first vs Docker fallback
- verify extension paths one by one
- document exact commands per component

### 2. Turn schema spec into runnable migrations

- promote the current migration skeletons into the real first migration set
- align names and fields with this spec

### 3. Implement the artifact registry

- local folder conventions
- file registration
- hashing
- version observation

### 4. Implement first ingestion producer

- markdown session logs
- transcript text

### 5. Implement retrieval service

- lexical baseline
- vector baseline
- time filters
- provenance payloads

### 6. Implement supersession and procedural updates

- current truth path
- historical truth path

### 7. Implement relationship extraction

- entities
- aliases
- core predicates

### 8. Implement daily / weekly / profile jobs

- TMT summary generation
- evidence linking

### 9. Implement evaluation harness

- before claiming intelligence

## Confidence

### Current confidence in the direction

- `~93%`

### Why not higher yet

- extension bring-up on this exact Mac is not yet proven
- ParadeDB local path still needs the cleanest install decision
- relationship extraction quality is not yet benchmarked
- TMT jobs and recall gating still need runtime proof

## Final Read

This is still the full Brain 2.0.

We are not dropping:

- memory classes
- relationship memory
- TMT
- BM25-grade lexical retrieval
- RRF
- conflict-aware updates
- forgetting
- provenance
- flexible ingestion

What remains is not more architecture ideation.

What remains is install proof, migration implementation, service code, and
evaluation.
