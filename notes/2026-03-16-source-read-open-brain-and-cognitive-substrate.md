# Source Read: Open Brain and Cognitive Substrate

## What I Checked

I searched the `The Digital Brain` notebook for the exact slide or PDF titles:

- `open brain 2.0 architecture`
- `the multimodal substrate`
- `architecthing open brain 2.0`
- `architecting open brain 2.0`

Exact title matches were not present in the current notebook source list.

The closest matching sources currently in the notebook are:

- `Build Your Open Brain Complete Setup Guide — Guides`
- `The Cognitive Substrate of 2026: Architecting Autonomous Agency through Hierarchical Memory and Unified Relational-Vector Ecosystems`

## What The Open Brain Guide Adds

This source is useful as a practical baseline for an open memory system.

Key ideas:

- one shared memory layer for multiple AI tools
- one database as the durable memory substrate
- open protocol access through MCP
- vector search as the primary retrieval primitive
- capture plus retrieval as separate subsystems

Practical shape of the system:

- `Supabase` as the database
- `Slack` as a capture interface
- `OpenRouter` as an AI gateway
- hosted MCP retrieval so multiple AI tools can read and write to the same brain

Why it matters:

- it strongly supports the anti-vendor-lock direction
- it treats the brain as shared infrastructure rather than a feature inside one chat product
- it is concrete about ingestion and retrieval plumbing

Where it is weaker for our goal:

- it is closer to an `open memory plumbing` system than a full cognitive architecture
- it does not appear to deeply define episodic vs semantic vs procedural memory
- it is more `capture and search` than `belief revision, consolidation, and temporal reasoning`

## What The Cognitive Substrate Source Adds

This source is much closer to the architecture we actually want.

Key ideas:

- agents in 2026 need a true cognitive architecture, not simple chat memory
- memory should be split into `episodic`, `semantic`, and `procedural` layers
- `PostgreSQL` is treated as the primary substrate instead of a separate vector-only system
- `pgvector` and DiskANN-style indexing are positioned as core semantic retrieval tools
- hybrid retrieval is preferred over flat vector-only retrieval
- temporal memory structures are important for long-horizon recall
- multimodal fusion belongs in the perception layer
- consolidation should resolve contradictions and promote stable observations
- security should use least-privilege access and row-level controls

Why it matters:

- it directly supports our desired brain model
- it aligns with the user goal of tracking changing beliefs over time
- it gives us a strong basis for temporal queries like:
  - `Where was Steve in Japan in 2025?`
  - `What changed about my preferences over the last month?`

## Combined Reading So Far

These two sources complement each other well:

- `Open Brain` gives a practical open-system and shared-memory integration pattern
- `Cognitive Substrate` gives the deeper memory architecture and retrieval model

Taken together, they suggest a direction like this:

- PostgreSQL-centered memory core
- MCP or similar open tool interface
- durable shared storage across multiple AI clients
- explicit multi-layer memory model
- hybrid and temporal retrieval
- memory consolidation and belief updates

## Important Gap

The exact slide PDFs or decks named by the user do not appear to be in the current notebook source inventory by title.

That means one of two things is true:

- the ideas are already partially represented under different source titles
- the exact slide files still need to be added to the notebook or provided directly

## What To Do Next

- use these two sources as immediate architecture anchors
- if the exact slide PDFs matter, import them into the notebook or provide direct links
- after that, run the refined architecture prompt again with these source ideas in mind
