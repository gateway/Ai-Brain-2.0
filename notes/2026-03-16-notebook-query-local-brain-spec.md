# Notebook Query: Local Brain Spec

## Purpose

This note captures a focused NotebookLM query aimed at producing a more
defensible Brain 2.0 development spec.

The query was constrained toward:

- local-first Apple Silicon deployment
- optional Supabase transition path
- PostgreSQL-first design
- reduced vendor lock-in
- avoidance of multi-database sprawl

## Query Shape Used

The notebook was asked to create a source-specific development spec using a
selected source set that emphasized:

- the Open Brain guide
- the cognitive substrate writeup
- tripartite memory sources
- temporal memory sources
- hybrid search sources
- pgvectorscale and pgvector sources
- security and SQL-tooling guidance

The request forced the notebook to answer in a structured engineering format
instead of a generic essay.

## High-Signal Notebook Output

The notebook returned a stronger and more specific answer than the earlier,
broader prompts.

### Strong Recommendations

These are the parts of the response that look directionally right:

- use a `tripartite memory architecture`
  - episodic
  - semantic
  - procedural/state
- keep `PostgreSQL` as the unified substrate
- use `pgvector`
- strongly consider `pgvectorscale`
- add lexical search and `RRF` instead of relying on vector-only retrieval
- run the `database + MCP + procedural memory` locally in MVP
- keep remote models optional during transition
- delay full multimodal support to `V2` unless it is immediately necessary
- delay a full `Temporal Memory Tree` to `V2`
- avoid a separate graph database in MVP
- use namespaces and `RLS` for personal vs work vs project isolation

### Strongest Practical Point

The notebook implicitly converged on a very pragmatic build stance:

- Brain 2.0 should not begin as a maximal system
- the durable substrate matters more than perfect multimodal or temporal features
- local-first Postgres plus a disciplined schema is a better starting point than
  trying to build the entire futuristic stack at once

## Most Useful Specific Guidance

### Local vs Remote Split

The notebook recommends:

- local:
  - PostgreSQL
  - MCP server
  - procedural memory
  - core state and retrieval path
- remote during transition:
  - embeddings
  - higher-level reasoning
  - some adjudication or summarization tasks

That aligns well with the current reality of a Mac-first build that still wants
to stay portable and practical.

### MVP vs V2

The best part of the notebook answer is that it explicitly pushed some features
out of MVP:

- multimodal native embeddings are probably `V2`
- full TMT is probably `V2`
- simple timestamped metadata is enough for MVP
- relationship modeling should start as tagged entities and linked rows, not a
  separate graph stack

This is exactly the kind of anti-overengineering filter we need.

## Where The Notebook Is Still Too Aggressive

Even with the tighter prompt, some parts still need human judgment.

### 1. Extension Stack Inflation

The notebook recommended a fairly large stack:

- PostgreSQL 18
- pgvector
- pgvectorscale
- pg_search
- Deno or Node

Possible issue:

- good direction, but still potentially too much for the very first prototype

### 2. Memory Update Semantics

The notebook suggested update or delete behavior in semantic memory when new
claims arrive.

That is directionally right, but the implementation should be conservative:

- append raw episodes forever
- preserve historical records
- mark older semantic facts as superseded or invalid
- avoid destructive deletion unless we are extremely certain

### 3. Supabase Assumptions

The notebook treats Supabase as a useful transition platform, which is fine.
But we still need to independently verify:

- extension availability
- performance limits
- how much custom hybrid logic should live in SQL vs functions
- what is portable back to a pure local PostgreSQL deployment

## Working Interpretation

The notebook answer supports this current design stance:

- `MVP`
  - local PostgreSQL brain
  - episodic, semantic, procedural schema
  - namespaces
  - MCP interface
  - hybrid retrieval
  - conservative consolidation rules
  - provider-agnostic model hooks

- `V2`
  - multimodal embeddings
  - temporal memory trees
  - richer relationship modeling
  - stronger local model coverage

## Best Next Question To Ask NotebookLM

The next high-value notebook query should be even narrower:

- given a local-first MVP on a Mac M4 with optional Supabase parity, define the
  exact schema, retrieval SQL, consolidation rules, and MCP tool surface for
  version one

That would move us from architectural direction into actual implementation
specification.
