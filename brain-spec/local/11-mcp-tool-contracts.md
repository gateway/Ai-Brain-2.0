# MCP Tool Contracts

## Purpose

Define the first MCP surface for the local brain.

## Tool Design Rules

Tools should:

- return minimal sufficient data
- include provenance
- respect namespaces
- support time and relationship-aware queries

## Initial Tools

### `memory.search`

Input:

- `query`
- `namespace_id`
- optional `time_start`
- optional `time_end`
- optional `entity_filters`
- optional `limit`

Output:

- ranked evidence fragments
- summary nodes when relevant
- source pointers

### `memory.timeline`

Input:

- `query`
- `namespace_id`
- time range

Output:

- ordered timeline fragments
- summary nodes
- linked relationships

### `memory.get_artifact`

Input:

- `artifact_id`

Output:

- artifact metadata
- URI
- optional excerpt pointers

### `memory.get_relationships`

Input:

- `entity`
- `namespace_id`
- optional time range

Output:

- related entities
- predicates
- supporting memory references

### `memory.save_candidate`

Input:

- `namespace_id`
- `content`
- `candidate_type`
- optional provenance

Output:

- candidate id
- acceptance status

### `memory.upsert_state`

Input:

- `namespace_id`
- `state_type`
- `state_key`
- `state_value`

Output:

- updated state record metadata

## Error Contract

Tools should return structured errors for:

- invalid namespace
- missing artifact
- invalid time window
- no results

## Security Rules

- namespace scope should be explicit
- tools should not silently cross namespaces
- provenance should be included without leaking unrelated content
