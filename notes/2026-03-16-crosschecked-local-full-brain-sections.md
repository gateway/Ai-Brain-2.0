# Cross-Checked Local Full-Brain Sections

## Purpose

This note captures the ambitious local Brain 2.0 design after:

- querying `The Digital Brain` notebook again
- comparing notebook answers against local Mac reality
- correcting the parts where the notebook drifts from implementation truth

Notebook:

- `The Digital Brain`
- id: `3fd8e35e-5115-4fb4-a81c-b28b69db002a`

## Core Position

We are designing the **full local brain**, not a basic RAG system.

The notebook strongly supports:

- PostgreSQL as the cognitive substrate
- episodic, semantic, and procedural memory
- Timescale hypertables for episodic timelines
- `pgvector` plus `pgvectorscale`
- BM25 plus vector search plus RRF
- temporal memory hierarchies
- consolidation and belief updates
- provenance
- MCP

This aligns with the direction you want.

## Sections

## 1. Substrate

### What it does

Provides one local database substrate for all memory layers.

### Notebook signal

- use `PostgreSQL 18`
- use `uuidv7()`
- use asynchronous I/O

### Cross-check correction

The notebook keeps recommending:

- `io_method = io_uring`

That is not the right Mac assumption.

For Apple Silicon macOS, the practical local configuration should be:

- `io_method = worker`

because `io_uring` is Linux-specific.

## 2. Episodic Timeline

### What it does

Stores append-only raw events:

- transcripts
- messages
- tool results
- dictation fragments
- imported historical notes

### Notebook signal

- use hypertables
- partition by time
- support temporal range queries

### Cross-checked decision

Keep:

- `TimescaleDB`
- hypertables
- compression for older data

This should stay in the full local brain.

## 3. Semantic Memory

### What it does

Stores distilled knowledge and vectorized recall units.

### Notebook signal

- use `pgvector`
- use `pgvectorscale`
- use DiskANN / StreamingDiskANN
- use importance scores

### Cross-checked decision

Keep:

- `pgvector`
- `pgvectorscale`
- semantic-memory rows that point back to episodic and artifact evidence

## 4. Procedural State

### What it does

Stores current truth:

- project specs
- preferences
- active rules
- agent skills

### Notebook signal

- use standard relational tables
- mutable authoritative state

### Cross-checked decision

Keep this relational-first.

Do not try to force procedural truth into vector-only storage.

## 5. Relationship Memory

### What it does

Lets the brain understand:

- who was with whom
- what happened where
- which project was involved
- how entities connect through time

### Notebook signal

- relationship memory belongs in the full design
- joins and structured links are needed for complex recall

### Cross-checked decision

Use PostgreSQL tables:

- `entities`
- `entity_aliases`
- `memory_entity_mentions`
- `entity_relationships`

This is how we support:

- "What was I doing in Japan in 2005, and who was I with?"

## 6. Temporal Memory

### What it does

Makes the system aware of sequence, time windows, and long-horizon memory.

### Notebook signal

- TMT is valuable
- temporal containment reduces search cost
- year -> month -> day style zoom-in is the right recall pattern

### Cross-checked decision

Keep Temporal Memory Tree in the target architecture.

Implementation rule:

- TMT is application logic and tables
- not a PostgreSQL extension

Practical first implementation path:

- timestamps
- validity windows
- time buckets
- summary nodes
- parent-child temporal links

## 7. Ingestion

### What it does

Converts raw life inputs into searchable memory.

### Notebook signal

- fragment inputs into `1` to `3` sentence units
- keep provenance pointers
- transcribe audio before fragmenting
- stage durable memory rather than promoting everything

### Cross-checked decision

Keep the ingestion shape exactly that way.

This remains one of the strongest notebook-derived decisions.

## 8. Hybrid Retrieval

### What it does

Combines exact-match and semantic retrieval.

### Notebook signal

- BM25 for exact keywords
- vector search for conceptual matches
- RRF to fuse rankings

### Cross-checked decision

Keep:

- ParadeDB as the target BM25 layer
- SQL RRF
- over-fetch both candidate pools
- apply metadata, time, and relationship filters

Practical local note:

- ParadeDB is still a local packaging wrinkle
- that does not remove it from the target architecture

## 9. Consolidation

### What it does

Turns raw evidence into coherent long-term memory.

### Notebook signal

- compare new evidence to similar existing memory
- classify as `ADD`, `UPDATE`, or `SUPERSEDE`
- use recency wins for active truth
- preserve historical truth

### Cross-checked decision

Keep:

- async consolidation loop
- contradiction adjudication
- supersession links
- historical auditability

## 10. Forgetting

### What it does

Prevents memory bloat without losing the evidence layer.

### Notebook signal

- semantic decay
- importance tiers
- never-forget anchors
- prune low-value derived memory

### Cross-checked decision

Keep forgetting in the full design, with one hard rule:

- raw artifacts and raw episodic evidence are not the first thing to delete

What should decay first:

- low-value derived semantic summaries
- stale unanchored abstractions
- repetitive low-signal session notes

## 11. MCP

### What it does

Exposes the brain as tools to outside models.

### Notebook signal

- keep the brain provider-agnostic
- use MCP as the stable interaction layer

### Cross-checked decision

Keep:

- local MCP server
- timeline tools
- relationship tools
- artifact provenance tools

## Query Walkthrough: Japan 2005

This is the concrete full-brain path for:

- "What was I doing in Japan in 2005, and who was I with?"

1. classify the query as temporal + relationship-heavy
2. resolve `Japan` to a place entity
3. constrain the episodic timeline to the `2005` branch
4. activate relevant daily and weekly summary nodes
5. run hybrid retrieval over leaves and summaries
6. pull linked people, projects, and artifacts
7. gate and rerank results
8. answer with provenance back to the original transcript or artifact

This is not basic RAG.

It is the exact kind of query the full local brain is meant to solve.

## Notebook Claims To Keep But Treat Carefully

These remain useful signals, but need engineering caution:

- `Gemini Embedding 2` as a production-ready multimodal embedding answer for
  everything
- `io_uring` on macOS
- assuming every local component has an equally simple install path

## Final Position

The notebook supports the ambitious local brain direction.

The correct move is not to simplify the brain.

The correct move is:

- keep the full local architecture
- correct the notebook where it is overly optimistic or platform-sloppy
- build the system in a staged order without shrinking the design
