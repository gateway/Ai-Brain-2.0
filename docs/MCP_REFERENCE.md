# MCP Reference

This document describes the current MCP server surface exposed by `local-brain`.

Runtime entrypoint:

```bash
cd /Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain
npm run mcp
```

Implementation:

- [local-brain/src/mcp/server.ts](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/mcp/server.ts)
- [local-brain/src/mcp/tool-contracts.ts](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/mcp/tool-contracts.ts)

## Current tool set

### `memory.search`

Purpose:

- lexical-first recall over episodic, semantic, procedural, and historical memory

Required inputs:

- `query`
- `namespace_id`

Optional inputs:

- `time_start`
- `time_end`
- `limit`

### `memory.timeline`

Purpose:

- return chronological memory evidence within a time window

Required inputs:

- `namespace_id`
- `time_start`
- `time_end`

Optional inputs:

- `limit`

### `memory.get_artifact`

Purpose:

- fetch artifact metadata and source pointer details

Required inputs:

- `artifact_id`

### `memory.get_relationships`

Purpose:

- look up relationship edges and supporting evidence

Required inputs:

- `entity_name`
- `namespace_id`

Optional inputs:

- `predicate`
- `time_start`
- `time_end`
- `limit`

### `memory.save_candidate`

Purpose:

- stage a candidate memory for later consolidation

Required inputs:

- `namespace_id`
- `content`
- `candidate_type`

Optional inputs:

- `source_memory_id`
- `confidence`
- `metadata`

### `memory.upsert_state`

Purpose:

- write mutable active truth into procedural memory

Required inputs:

- `namespace_id`
- `state_type`
- `state_key`
- `state_value`

Optional inputs:

- `metadata`

## Protocol Notes

The current server supports the standard MCP calls:

- `initialize`
- `tools/list`
- `tools/call`

## Design Rules

The current MCP surface is intentionally narrow.

Principles:

- explicit namespace scope
- provenance-aware outputs
- time-aware query support
- minimal safe write tools
- no silent cross-namespace behavior

## What MCP Is For

MCP is the assistant and tool-client interface to the brain.

It is useful for:

- assistant retrieval
- timeline lookup
- artifact inspection
- relationship lookup
- controlled candidate/state writes

It is not the always-on background worker layer. Watch-folder monitoring, outbox propagation, and temporal summary jobs should run in the runtime worker layer, not through MCP.
