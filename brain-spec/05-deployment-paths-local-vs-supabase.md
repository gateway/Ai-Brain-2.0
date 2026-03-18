# Deployment Paths: Local Vs Supabase

## Position

There are two build modes.

They do not need to be identical in every extension or packaging detail.

They should share the same mental model and as much schema as practical.

## Option A: Local Full Brain

### Goal

Build the richest version of the brain on the Mac first.

### Best for

- maximum capability
- data ownership
- local experimentation
- advanced extensions

### Strong candidate stack

- PostgreSQL 18
- TimescaleDB
- `pgvector`
- `pgvectorscale`
- `pgai`
- BM25 layer
- Node workers
- local artifact folders
- local MCP server

### Pros

- best substrate control
- best extension freedom
- best privacy
- lowest vendor lock

### Cons

- more setup friction
- extension installation may be tricky
- more local ops work

## Option B: Supabase Brain

### Goal

Stand up a hosted version faster with managed infrastructure.

### Best for

- remote access
- easy API exposure
- lighter ops burden

### Strong candidate stack

- Supabase Postgres
- `pgvector`
- SQL RRF
- Edge Functions
- remote workers
- Storage buckets
- hosted MCP bridge

### Pros

- easier remote integration
- quicker auth and API surface
- easier sharing

### Cons

- weaker extension parity
- less control over low-level tuning
- more vendor surface

## Recommended Strategy

Treat the local build as project A and the hosted build as project B.

That means:

- define the full brain once
- implement the local version first
- adapt the hosted path afterward

## Shared Concepts

Both paths should preserve:

- raw artifacts
- tripartite memory
- provenance
- hybrid retrieval
- relationships
- temporal hierarchy
- consolidation
- forgetting
- MCP style interfaces

## Where OpenRouter Fits

OpenRouter is a valid optional layer for:

- embeddings
- lightweight adjudication
- summary generation
- small cleanup models

It should be treated as:

- a provider option

not:

- the architecture itself

## Main Engineering Risk

The biggest difference between the two paths is not SQL.

It is:

- extension support
- background job model
- packaging
- tuning

That is why the local full-brain path should be treated as the reference build.
