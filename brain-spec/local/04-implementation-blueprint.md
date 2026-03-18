# Local Implementation Blueprint

## Purpose

This document translates the local full-brain architecture into an actionable
implementation plan.

Goal:

- define what gets built first
- define what code and schema are needed
- define the operating shape of the local brain

## Build Order

1. local substrate bring-up
2. schema package
3. artifact registry
4. ingestion worker
5. episodic memory
6. semantic and procedural memory
7. hybrid retrieval
8. relationship layer
9. consolidation loop
10. temporal summaries and TMT
11. forgetting and cache
12. MCP server
13. evaluation harness

## Step 1: Local Substrate Bring-Up

### Deliverables

- PostgreSQL 18 installed and running
- extension install order documented
- baseline config file checked in

### Target components

- PostgreSQL 18
- TimescaleDB
- `pgvector`
- `pgvectorscale`
- `pgai`
- lexical retrieval path

### Output

- reproducible local install guide

## Step 2: Schema Package

### Deliverables

- schema directory
- versioned migrations
- seed or bootstrap SQL

### Required schema areas

- `artifacts`
- `artifact_chunks`
- `episodic_memory`
- `semantic_memory`
- `procedural_memory`
- `memory_candidates`
- `entities`
- `entity_aliases`
- `memory_entity_mentions`
- `entity_relationships`
- `temporal_nodes`
- `temporal_node_members`
- `semantic_cache`
- `consolidation_runs`

### Output

- first migration set that brings up the full substrate skeleton

## Step 3: Artifact Registry

### Deliverables

- filesystem conventions
- artifact insert API
- checksum and metadata registration

### Responsibilities

- save source-of-truth files
- assign `artifact_id`
- write artifact metadata into Postgres

### Output

- artifact ingest path working for markdown and plain text first

## Step 4: Ingestion Worker

### Deliverables

- Node worker process
- file watcher or drop-folder processor
- transcript import path
- PDF text extraction path

### Responsibilities

- extract text
- split into fragments
- attach provenance
- request embeddings
- write episodic rows

### Output

- working ingest for:
  - markdown
  - transcript text
  - project notes

## Step 5: Episodic Memory

### Deliverables

- hypertable setup
- indexes
- namespace-aware event inserts

### Responsibilities

- append-only event history
- evidence base for all later memory

### Output

- timeline queries over raw events

## Step 6: Semantic And Procedural Memory

### Deliverables

- semantic-memory write path
- procedural-state tables
- validity-window handling

### Responsibilities

- store durable abstractions
- store active truth

### Output

- first preference and project-state recall flow

## Step 7: Hybrid Retrieval

### Deliverables

- lexical query path
- vector query path
- SQL RRF function
- namespace and time filters

### Responsibilities

- produce high-quality candidate sets for the reasoning layer

### Output

- tested retrieval API for:
  - exact queries
  - semantic queries
  - mixed queries

## Step 8: Relationship Layer

### Deliverables

- entity extraction path
- relationship write path
- basic alias handling

### Responsibilities

- support people, place, project, and artifact joins

### Output

- first relationship-aware query flow

## Step 9: Consolidation Loop

### Deliverables

- candidate queue
- similarity retrieval
- adjudication interface
- writeback actions

### Responsibilities

- `ADD`
- `UPDATE`
- `SUPERSEDE`
- `IGNORE`

### Output

- working preference-change and duplicate-resolution behavior

## Step 10: Temporal Summaries And TMT

### Deliverables

- day summary generator
- week summary generator
- month or profile summary generator
- temporal node tables and links

### Responsibilities

- reduce long-horizon search cost
- enable year-scale recall

### Output

- first timeline zoom-in behavior

## Step 11: Forgetting And Semantic Cache

### Deliverables

- importance-scoring rules
- anchor rules
- decay job
- semantic cache table and policy

### Responsibilities

- reduce clutter
- improve latency
- control token burn

### Output

- bounded derived-memory growth

## Step 12: MCP Server

### Deliverables

- local MCP service
- tool contracts
- minimal auth or scoping rules

### First tool set

- `memory.search`
- `memory.timeline`
- `memory.get_artifact`
- `memory.get_relationships`
- `memory.save_candidate`
- `memory.upsert_state`

### Output

- external models can use the brain through tools

## Step 13: Evaluation Harness

### Deliverables

- recall test set
- timeline query test set
- preference-change regression tests
- latency and token-burn measurements

### Why this is mandatory

Without an evaluation harness, we will not know if:

- retrieval is actually good
- summaries are drifting
- consolidation is corrupting memory
- the brain is too expensive in tokens

## First Code To Write

The first concrete code areas should be:

1. migration scaffolding
2. artifact registry
3. markdown and transcript ingestion worker
4. episodic insert path
5. embedding adapter
6. hybrid retrieval SQL

## What To Delay Slightly

Delay until the base loop works:

- full TMT traversal optimization
- aggressive forgetting
- multimodal image reasoning
- complex semantic cache policies

## Definition Of Done For The First Real Slice

The first slice is done when the local brain can:

- ingest markdown and transcript artifacts
- preserve provenance
- answer scoped memory queries with evidence
- update active preferences without losing history
- generate daily summaries
- expose memory through MCP tools
