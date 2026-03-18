# Retrieval SQL Spec

## Purpose

Define the retrieval logic the local brain should implement in SQL and adjacent
query orchestration.

## Retrieval Components

### Lexical branch

Purpose:

- exact names
- dates
- codes
- terms

### Vector branch

Purpose:

- conceptual similarity
- semantic recall

### Relationship branch

Purpose:

- person, place, and project joins

### Temporal branch

Purpose:

- year, month, week, day constraints

## RRF Fusion

The final ranked set should be a fused result of:

- lexical ranking
- vector ranking
- optionally relationship-aware boosts

Guideline:

- over-fetch candidate sets from each branch
- fuse in SQL
- apply strict final filters

## Required Filters

- `namespace_id`
- time window
- active-truth status
- entity constraints
- result count limit

## Output Contract

Retrieval should return:

- `memory_id`
- `memory_type`
- `content`
- `score`
- `artifact_id`
- `occurred_at`
- `namespace_id`
- provenance metadata

## Timeline Query Behavior

For:

- "What was I doing in Japan in 2005?"

The retrieval layer should:

1. resolve `Japan`
2. filter to the `2005` time window
3. search episodic memory and temporal nodes
4. expand linked relationships
5. return atomic evidence and relevant summaries

## Token-Burn Rule

Retrieval should prefer:

- a few high-quality evidence fragments
- a few relevant summary nodes

Retrieval should avoid:

- entire long transcripts
- redundant fragments
- multiple summary layers that say the same thing
