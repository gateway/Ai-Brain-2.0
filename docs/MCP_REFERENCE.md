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
- [local-brain/src/benchmark/mcp-smoke.ts](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/benchmark/mcp-smoke.ts)

## Current tool set

### `memory.search`

Purpose:

- lexical-first recall over episodic, semantic, procedural, and historical memory
- supports mixed-intent decomposition for broad life-recap queries

Required inputs:

- `query`
- `namespace_id`

Optional inputs:

- `time_start`
- `time_end`
- `reference_now`
- `limit`

### `memory.recap`

Purpose:

- return a grouped evidence pack for recap-style queries such as `what did Dan and I talk about yesterday?`
- optionally return a derived recap summary from `local` or `openrouter`, but only on top of retrieved evidence

Required inputs:

- `query`
- `namespace_id`

Optional inputs:

- `time_start`
- `time_end`
- `reference_now`
- `participants`
- `topics`
- `projects`
- `limit`
- `provider`
- `model`

### `memory.extract_tasks`

Purpose:

- extract task candidates from a recap-style evidence pack
- keep every task linked to evidence IDs instead of inventing free text

Required inputs:

- `query`
- `namespace_id`

Optional inputs:

- `time_start`
- `time_end`
- `reference_now`
- `participants`
- `topics`
- `projects`
- `limit`
- `provider`
- `model`

### `memory.extract_calendar`

Purpose:

- extract calendar-style commitments and plans from a recap-style evidence pack

Required inputs:

- `query`
- `namespace_id`

Optional inputs:

- `time_start`
- `time_end`
- `reference_now`
- `participants`
- `topics`
- `projects`
- `limit`
- `provider`
- `model`

### `memory.explain_recap`

Purpose:

- return the provenance/evidence bundle that explains why a recap/task/calendar answer was produced
- intended for `why do you think that?` follow-ups from an LLM client

Required inputs:

- `query`
- `namespace_id`

Optional inputs:

- `time_start`
- `time_end`
- `reference_now`
- `participants`
- `topics`
- `projects`
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

### `memory.get_graph`

Purpose:

- return a provenance-backed relationship graph centered on an entity or namespace

Required inputs:

- `namespace_id`

Optional inputs:

- `entity_name`
- `time_start`
- `time_end`
- `limit`

### `memory.get_clarifications`

Purpose:

- read unresolved clarification items and suggested follow-up guidance for weak or missing answers

Required inputs:

- `namespace_id`

Optional inputs:

- `query`
- `limit`

### `memory.get_stats`

Purpose:

- return read-only system health, queue, worker, bootstrap, and monitored-source state for operator-style assistant checks

Required inputs:

- none

Optional inputs:

- `source_limit`

### `memory.get_protocols`

Purpose:

- return active `constraint` and `style_spec` rules that govern assistant behavior and operational workflow

Required inputs:

- `namespace_id`

Optional inputs:

- `query`
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
- focused graph inspection
- clarification follow-up
- operator health checks
- protocol/rule inspection
- controlled candidate/state writes

## MCP Smoke Validation

Current benchmark command:

```bash
cd /Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain
npm run benchmark:mcp-smoke
```

The MCP smoke pass currently validates user-like assistant queries through the
tool surface, including:

- `memory.search` for current-home recall
- `memory.search` for transcript-style prompts like `what did Dan say about karaoke?`
- `memory.search` for clarification-driven abstention like `who is Uncle?`
- `memory.recap`-style assistant scenarios through replay, OMI, and recap-family battle surfaces
- `memory.extract_tasks` for Project A task harvesting
- `memory.extract_calendar` for weekend commitment extraction
- `memory.explain_recap` for provenance-backed `why this recap?` follow-ups
- `memory.get_relationships` for Steve-centered relationship lookup
- `memory.get_graph` for graph-context lookup around synthetic entities
- `memory.get_clarifications` for follow-up guidance
- `memory.get_stats` for operator/system-health lookup
- `memory.get_protocols` for active replay/clarification workflow rules
- `memory.timeline` for chronological window inspection

Additional production recap surfaces now live in:

- `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/benchmark/recap-family.ts`
- `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/benchmark/task-calendar-extraction.ts`
- `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/benchmark/session-start-memory.ts`
- `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/benchmark/recap-provider-parity.ts`

It is not the always-on background worker layer. Watch-folder monitoring, outbox propagation, and temporal summary jobs should run in the runtime worker layer, not through MCP.
