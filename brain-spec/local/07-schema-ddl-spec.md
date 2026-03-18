# Schema DDL Spec

## Scope

This document defines the schema areas that should exist in the first real
local implementation.

It is a DDL-level design spec, not the final SQL file.

## Core Tables

### `artifacts`

Purpose:

- register every source-of-truth file or import
- preserve external-tool evidence such as OpenClaw markdown sessions

Key fields:

- `id`
- `namespace_id`
- `artifact_type`
- `uri`
- `checksum`
- `mime_type`
- `created_at`
- `source_channel`
- `metadata`
- `current_version`
- `last_seen_at`

### `artifact_chunks`

Purpose:

- preserve extraction units tied to artifacts

Key fields:

- `id`
- `artifact_id`
- `chunk_index`
- `char_start`
- `char_end`
- `text`
- `metadata`
- `content_hash`
- `artifact_version`

### `episodic_memory`

Purpose:

- append-only historical record

Key fields:

- `id`
- `namespace_id`
- `session_id`
- `role`
- `content`
- `occurred_at`
- `captured_at`
- `artifact_id`
- `artifact_version`
- `source_offset`
- `source_hash`
- `metadata`

Indexes:

- namespace plus time
- role plus time where useful

### `semantic_memory`

Purpose:

- distilled long-term knowledge

Key fields:

- `id`
- `namespace_id`
- `content_abstract`
- `embedding`
- `importance_score`
- `valid_from`
- `valid_until`
- `is_anchor`
- `status`
- `superseded_by`
- `metadata`

Indexes:

- vector index
- text index
- validity-window index

### `procedural_memory`

Purpose:

- current truth and active state

Key fields:

- `id`
- `namespace_id`
- `state_type`
- `state_key`
- `state_value`
- `version`
- `updated_at`
- `supersedes_id`
- `source_artifact_id`

### `memory_candidates`

Purpose:

- staged memory proposals before consolidation

Key fields:

- `id`
- `namespace_id`
- `source_memory_id`
- `candidate_type`
- `content`
- `confidence`
- `created_at`
- `status`

### `entities`

Purpose:

- normalized people, places, projects, and other entities

Key fields:

- `id`
- `namespace_id`
- `entity_type`
- `canonical_name`
- `metadata`

### `entity_aliases`

Purpose:

- alias resolution

Key fields:

- `id`
- `entity_id`
- `alias`

### `memory_entity_mentions`

Purpose:

- connect memory rows to entities

Key fields:

- `id`
- `entity_id`
- `memory_table`
- `memory_id`
- `mention_role`

### `entity_relationships`

Purpose:

- structured relationship graph inside Postgres

Key fields:

- `id`
- `namespace_id`
- `subject_entity_id`
- `predicate`
- `object_entity_id`
- `valid_from`
- `valid_until`
- `support_count`
- `metadata`

### `temporal_nodes`

Purpose:

- summary nodes for TMT

Key fields:

- `id`
- `namespace_id`
- `node_level`
- `starts_at`
- `ends_at`
- `summary_text`
- `embedding`
- `metadata`
- `source_count`

Level mapping:

- `L1`: segment
- `L2`: session
- `L3`: day
- `L4`: week
- `L5`: profile

### `temporal_node_members`

Purpose:

- parent-child and membership links for TMT

Key fields:

- `id`
- `parent_node_id`
- `child_type`
- `child_id`

### `semantic_cache`

Purpose:

- low-latency repeat-query handling

Key fields:

- `id`
- `namespace_id`
- `query_hash`
- `query_text`
- `response_payload`
- `created_at`
- `expires_at`

### `consolidation_runs`

Purpose:

- audit consolidation jobs

Key fields:

- `id`
- `run_type`
- `started_at`
- `finished_at`
- `status`
- `summary`

## Function And Service Groups

### `search_ops`

Responsibilities:

- lexical retrieval
- vector retrieval
- hybrid RRF fusion
- timeline candidate retrieval

### `reconsolidation_ops`

Responsibilities:

- semantic promotion
- procedural updates
- supersession
- summary generation
- storage-time forgetting

### `metacognition_service`

Responsibilities:

- query classification
- recall planning
- choosing retrieval layers and temporal scope

### `context_refinement`

Responsibilities:

- recall gating
- contradiction/noise filtering
- final candidate trimming before answer generation

## Cross-Cutting Rules

### Provenance

Every durable memory table should be able to trace back to:

- artifact
- offset
- time
- source context
- source hash

### RLS

All memory-bearing table groups should be designed to support namespace-based
RLS:

- episodic
- semantic
- procedural
- entities
- relationships
- temporal nodes

This keeps personal and project memory separable while still allowing explicit
cross-namespace queries when intentionally authorized.

### Executable semantics

The brain should not rely only on labels and embeddings.

Where a concept becomes operationally important, the schema should allow
machine-enforceable meaning through:

- typed state records
- explicit relationship predicates
- validity windows
- policy-aware retrieval rules

### Namespaceing

Every memory-bearing row should include `namespace_id`.

### Validity

Anything representing active truth should support:

- `valid_from`
- `valid_until`
- active or superseded status

### Auditability

Destructive deletes should be avoided for durable memory.
