# AI Brain 2.0 Requirements

## Core Goal

Build a local-first AI brain that avoids vendor lock-in, can run on Apple Silicon hardware such as a MacBook or Mac mini, and can optionally be deployed on a PostgreSQL-backed hosted platform such as Supabase without changing the core memory model.

## Product Direction

This system should feel less like a chatbot with history and more like a durable cognitive substrate:

- it remembers over time
- it separates different types of memory
- it updates beliefs when newer evidence conflicts with older information
- it can answer personal, project, and procedural questions
- it can reason across notes, chats, documents, source code, skills, and agent instructions

## Hardware and Deployment Targets

- Primary target: local Apple Silicon machine
- Minimum target: M4-class machine with 16 GB RAM
- Preferred local target: 24 GB or more RAM when available
- Secondary deployment target: Supabase or plain hosted PostgreSQL
- Architecture should not depend on a single cloud vendor or proprietary memory backend

## Non-Negotiables

- local-first
- PostgreSQL-centered
- portable between local and hosted environments
- no hard dependency on one model vendor
- no hard dependency on one vector database vendor
- strong privacy boundaries for personal memory
- support for long-term memory maintenance and change over time

## Memory Model Requirements

The brain must support at least these memory categories:

- episodic memory
- semantic memory
- procedural memory
- project memory
- personal memory
- agent and skill memory

It must also support:

- temporal recall
- recency weighting
- importance scoring
- contradiction handling
- belief updates
- selective forgetting or decay
- durable provenance back to original evidence

## Example Behaviors

- "Where was Steve in Japan in 2025?"
- "What changed in my preferences about food in the last month?"
- "How do I usually deploy this project?"
- "What decisions did I make for the AI brain architecture?"
- "Which skill or agent instruction should be used for this task?"

## Data Sources We Need To Support

- markdown notes
- local files
- PDFs
- websites
- transcripts
- chats
- code repositories
- project documents
- task logs
- user preference statements
- skill and agent instruction files

## Desired Memory Behavior

The system should not merely append facts forever.

It should:

- consolidate repeated information
- merge similar memories
- mark stale or contradicted beliefs
- preserve raw episode history for auditability
- promote stable repeated observations into semantic or procedural memory

Example:

- if the user says they like spicy food, the system stores that belief
- if weeks later the user says they no longer like spicy food, the system should update the active belief while preserving the historical record that the old preference used to be true

## Architecture Themes To Evaluate

- PostgreSQL 18 as the primary data substrate
- `pgvector`
- `pgvectorscale`
- BM25 and lexical search
- hybrid search with rank fusion
- temporal indexing and hierarchical recall
- graph-style relationships between people, places, projects, and events
- background consolidation jobs
- local embeddings versus remote embeddings
- local inference versus remote reasoning
- namespace and policy separation between personal and project data
- skills and tools as procedural memory

## Open Questions

- What should the exact schema be for episodic, semantic, and procedural memory?
- Should graph relationships live in PostgreSQL tables or a separate graph layer?
- Which local models are realistic on 16 GB RAM versus 24 GB RAM?
- What should be fully local versus optionally remote?
- How should memory decay, confidence, and contradiction resolution be scored?
- What is the cleanest migration path between local Postgres and Supabase?

## Immediate Goal

Use NotebookLM and related research to define a concrete, opinionated build outline for AI Brain 2.0 in 2026, optimized for local-first operation and low vendor lock-in.
