# Feature Preservation Matrix

## Purpose

This document makes one thing explicit:

- we are not dropping the human-like brain features

It separates:

- `target behavior`
- `current implementation baseline`
- `upgrade path`

## 1. Tripartite Memory

### Target behavior

- `episodic` stores what happened and when
- `semantic` stores distilled durable knowledge
- `procedural` stores current active truth

### Current implementation baseline

- schema and contracts already preserve all three layers

### Upgrade path

- wire the layers into running code and retrieval

## 2. BM25-Grade Lexical Retrieval

### Target behavior

- exact names
- exact places
- exact years
- exact codes and technical terms

### Current implementation baseline

- native PostgreSQL full-text search is in the current retrieval SQL

### Upgrade path

- plug in the richer BM25 lexical layer once the local packaging path is
  confirmed

Important:

- lexical retrieval is not being removed
- the current SQL uses a safe baseline while preserving the stronger target

## 3. Vector Retrieval

### Target behavior

- semantic recall across long-term memory
- concept matching
- support for summaries and abstractions

### Current implementation baseline

- `pgvector` is already part of the schema and retrieval function shape

### Upgrade path

- enable `pgvectorscale` and DiskANN once the extension path is verified locally

## 4. RRF Hybrid Retrieval

### Target behavior

- combine lexical precision with semantic recall

### Current implementation baseline

- RRF is already in the retrieval SQL function design

### Upgrade path

- tune weighting and candidate counts with evaluation data

## 5. Relationship-Aware Recall

### Target behavior

- answer:
  - who was with whom
  - where events happened
  - what projects and entities were involved

### Current implementation baseline

- entity and relationship tables already exist in the migration design
- MCP includes relationship lookup tools

### Upgrade path

- implement entity extraction and relationship joins in live code

## 6. Relationship Memory And Entity Graphs

### Target behavior

The brain should maintain structured entity memory for:

- people
- places
- projects
- organizations
- artifacts
- skills

and relationship edges such as:

- `was_with`
- `visited`
- `worked_on`
- `mentioned_in`
- `supports`
- `supersedes`

### Current implementation baseline

- entity and relationship tables already exist in the schema migrations
- MCP includes a relationship lookup contract

### Upgrade path

- implement entity extraction during ingestion
- add alias resolution
- add relationship-strength updates from repeated evidence
- join relationships directly into recall queries

Important:

- relationship memory is not dropped
- it is one of the things that makes the brain feel human instead of flat

## 7. Ingestion Modalities

### Target behavior

The brain should ingest:

- text
- chat
- markdown
- speech and transcript text
- audio recordings
- PDFs
- images
- project notes and files

### Current implementation baseline

- first concrete worker contract already covers:
  - markdown
  - text
  - audio
  - transcript
  - pdf
  - image
  - project_note
  - chat_turn

### Upgrade path

- implement text and markdown first
- add transcript and audio pipeline
- add PDF extraction
- add image OCR or caption flow
- then add richer multimodal embedding paths if and when they are verified

Important:

- ingestion breadth is preserved in the design
- the order of implementation is staged, not the feature set

## 8. Temporal Recall

### Target behavior

- answer year, month, week, and day questions
- constrain searches by explicit time windows
- reconstruct coherent timelines

### Current implementation baseline

- episodic memory has time fields
- temporal node tables exist
- timeline retrieval function exists

### Upgrade path

- generate actual summary nodes and connect them through TMT membership

## 9. TimescaleDB Hypertables

### Target behavior

- use time-series optimization for episodic memory
- partition long-running event history into manageable chunks
- support compression and efficient time-window scans

### Current implementation baseline

- the migration layer already leaves an explicit hypertable upgrade hook
- the local full-brain spec still treats TimescaleDB as part of the target stack

### Upgrade path

- enable TimescaleDB in the local install path
- convert episodic memory into hypertables
- add compression policies for older data

Important:

- Timescale hypertables are not dropped
- they are delayed only until extension bring-up is confirmed locally

## 10. Temporal Memory Tree (TMT)

### Target behavior

- day
- week
- month
- profile
- optional year layer

### Current implementation baseline

- temporal node schema exists
- temporal membership schema exists

### Upgrade path

- implement daily, weekly, and monthly summary jobs
- implement TMT traversal logic in retrieval

Important:

- TMT is not dropped
- it is staged behind the base memory loop

## 11. StreamingDiskANN And SBQ

### Target behavior

- use `pgvectorscale`
- use StreamingDiskANN
- use SBQ-style compressed traversal for large semantic corpora on Apple Silicon

### Current implementation baseline

- migration files keep `pgvectorscale` as an explicit local upgrade path
- schema and retrieval design already assume the vector layer will be upgraded
  beyond plain `pgvector`

### Upgrade path

- install `pgvectorscale`
- replace baseline vector index path with DiskANN
- benchmark recall, latency, and build-time memory use
- tune for Apple Silicon SSD behavior

Important:

- StreamingDiskANN + SBQ is still part of the local target brain
- the current baseline does not remove it, it simply avoids faking it before
  the extension is installed

## 12. Conflict Resolution

### Target behavior

Example:

- user says: `I like spicy food`
- three months later: `I hate spicy food`

The brain should:

- preserve the old statement in episodic memory
- mark the old durable preference as superseded or inactive
- update active truth to the new preference

### Current implementation baseline

- semantic memory supports:
  - `valid_from`
  - `valid_until`
  - `status`
- procedural memory supports:
  - versioning
  - supersedes links
- consolidation job spec already includes:
  - `ADD`
  - `UPDATE`
  - `SUPERSEDE`
  - `IGNORE`

### Upgrade path

- implement adjudication logic and state updates in the background jobs

## 13. Human-Like Forgetting

### Target behavior

- raw evidence stays available
- outdated derived memories stop dominating retrieval
- low-value semantic clutter fades over time

### Current implementation baseline

- semantic memory includes:
  - `importance_score`
  - `is_anchor`
  - active/inactive status
- semantic decay job is already defined in the jobs spec

### Upgrade path

- implement decay thresholds
- implement hot/warm/cold behavior
- add metrics before aggressive pruning

Important:

- forgetting is not deleting the soul of the brain
- forgetting is mostly about derived memory hygiene first

## 14. Provenance

### Target behavior

- every answer can point back to source evidence
- provenance survives file moves and later edits where possible

### Current implementation baseline

- artifacts, chunks, episodic rows, and retrieval payloads all include
  provenance paths

### Upgrade path

- add content hashes and chunk fingerprints to the artifact registry
- wire source excerpts and artifact lookups into the MCP handlers

## 15. Evaluation And Drift Detection

### Target behavior

- the brain is measured on:
  - active truth
  - historical truth
  - timeline recall
  - relationship recall
  - preference evolution

### Current implementation baseline

- validation gates already call out the major behavior classes

### Upgrade path

- build a benchmark set from real examples
- run regression checks after retrieval and consolidation changes

## 16. Operator Safety

### Target behavior

- query-specific tuning does not leak into later queries
- pooled connections stay predictable

### Current implementation baseline

- this is documented as an operational rule, not yet enforced in code

### Upgrade path

- wrap DB tuning in transaction-scoped `SET LOCAL`
- keep retrieval settings out of long-lived shared session state

## 17. MCP Tooling

### Target behavior

- models query the brain as tools instead of loading everything into prompts

### Current implementation baseline

- the tool contracts are already written

### Upgrade path

- implement actual handlers over the SQL functions and file registry

## 18. Japan 2025 / Japan 2005 Query Behavior

### Target behavior

The brain should answer:

- "Who was I with in Japan in 2025?"

by combining:

- episodic memory
- time filtering
- relationship memory
- temporal hierarchy
- provenance

### Current implementation baseline

- schema supports all required layers
- retrieval SQL already supports time-bounded candidate search
- relationship lookup tool contract exists

### Upgrade path

- add relationship joins and TMT-aware expansion to the real retrieval service

## Final Statement

The human-like features are still in the design.

What is staged right now is:

- implementation order

What is not being staged away is:

- the actual behavior we want from the brain
