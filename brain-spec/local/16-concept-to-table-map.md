# Concept To Table Map

## Purpose

This file maps the major Brain 2.0 concepts into table groups, function groups,
and service responsibilities so the architecture is not left as acronym soup.

It also makes clear that OpenClaw-style markdown memory can be ingested as raw
evidence while the actual memory logic lives in PostgreSQL.

## OpenClaw And External Markdown

If OpenClaw or another tool writes markdown files during or after a session:

- the markdown file is the source evidence
- the `artifacts` table registers it
- `artifact_chunks` preserves extracted units and hashes
- `episodic_memory` receives append-only event fragments from it
- consolidation later decides what becomes semantic or procedural memory

Recommended runtime pattern:

- watcher for low-latency ingestion
- periodic scan for reconciliation
- checksum-based idempotency
- versioned observation if the file is later edited

## Tripartite Memory Substrate

### Episodic memory

Tables:

- `artifacts`
- `artifact_chunks`
- `episodic_memory`

Role:

- immutable history
- time-travel reconstruction
- audit trail

### Semantic memory

Tables:

- `semantic_memory`
- `memory_candidates`

Role:

- distilled facts
- durable patterns
- learned summaries

### Procedural memory

Tables:

- `procedural_memory`

Role:

- active truth
- current preferences
- current project state
- active skills or operating rules

## TMT And Temporal Organization

Tables:

- `temporal_nodes`
- `temporal_node_members`

Levels:

- `L1`: segment
- `L2`: session
- `L3`: day
- `L4`: week
- `L5`: profile

Role:

- temporal containment
- progressive abstraction
- time-bounded recall

## Fragment Units

Primary responsibility:

- ingestion worker
- artifact chunking
- episodic fragment creation

Tables:

- `artifact_chunks`
- `episodic_memory`

Rule:

- 1 to 3 sentence units by default
- may be re-segmented later during consolidation for noisy or interleaved input

## Hybrid Retrieval

Function group:

- `search_ops`

Core pieces:

- lexical retrieval
- vector retrieval
- RRF fusion
- temporal filters
- relationship-aware filters

Tables touched:

- `episodic_memory`
- `semantic_memory`
- `temporal_nodes`
- `memory_entity_mentions`
- `entity_relationships`

## Recall Planner

Service:

- `metacognition_service`

Role:

- classify query as current-state, historical, relationship, timeline, or
  project-state
- choose retrieval layers
- choose temporal scope
- decide whether TMT expansion is needed

## Recall Gating

Service:

- `context_refinement`

Role:

- remove semantically similar but temporally wrong candidates
- suppress contradictory or stale candidates for current-state answers
- keep final context information-dense

## Consolidation Sleep Cycle

Function group:

- `reconsolidation_ops`

Tables touched:

- `memory_candidates`
- `semantic_memory`
- `procedural_memory`
- `temporal_nodes`
- `entity_relationships`
- `consolidation_runs`

Role:

- promote durable facts
- update procedural truth
- generate TMT summaries
- build relationship edges
- apply forgetting and decay

## Supersession

Tables:

- `semantic_memory`
- `procedural_memory`

Fields:

- `valid_from`
- `valid_until`
- `status`
- `superseded_by`
- `supersedes_id`

Role:

- preserve history
- update active truth
- answer both:
  - what is true now
  - what used to be true

## Storage-Time Forgetting

Function group:

- `reconsolidation_ops`

Tables:

- `semantic_memory`
- `temporal_nodes`
- optional cache tables

Fields:

- `importance_score`
- `is_anchor`
- `last_accessed_at`
- `status`

Role:

- decay low-value derived memory
- keep anchor facts and strong evidence
- reduce retrieval clutter without deleting the evidence base

## Provenance Pointers

Tables:

- `artifacts`
- `artifact_chunks`
- `episodic_memory`
- `semantic_memory`
- `procedural_memory`

Required fields:

- artifact id
- source URI
- source offset where useful
- source hash
- artifact version or observed revision marker

Role:

- explain answers
- recover source evidence
- survive file edits better than offset-only schemes

## RLS

Scope:

- all memory-bearing tables should support namespace-based RLS

Role:

- separate personal, work, and project memory
- allow explicit cross-namespace joins only when intentionally authorized

## Executable Semantics

This lives mostly in:

- `procedural_memory`
- `entity_relationships`
- retrieval and policy functions

Role:

- move beyond descriptive labels
- give the system machine-enforceable meaning for active state, relationships,
  validity, and policy
