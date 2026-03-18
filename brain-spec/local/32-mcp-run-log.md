# MCP Run Log

## Slice Goal

Implement the first runnable local MCP surface for the brain, using the existing
retrieval and artifact services instead of inventing a separate memory system.

## NotebookLM Guidance Used

NotebookLM recommended a minimal day-one tool surface centered on:

- semantic search
- timeline query
- artifact metadata read
- relationship / graph exploration
- candidate memory capture

It explicitly recommended deferring consolidation as an assistant-facing tool.

## Implemented Surface

The local stdio MCP server now exposes the repo's existing contract names:

- `memory.search`
- `memory.timeline`
- `memory.get_artifact`
- `memory.get_relationships`
- `memory.save_candidate`
- `memory.upsert_state`

## Files Added

- [/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/mcp/server.ts](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/mcp/server.ts)
- [/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/cli/mcp.ts](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/cli/mcp.ts)

## Docs Updated

- [/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/README.md](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/README.md)
- [/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/QUICKSTART.md](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/QUICKSTART.md)
- [/Users/evilone/Documents/Development/AI-Brain/ai-brain/brain-spec/local/README.md](/Users/evilone/Documents/Development/AI-Brain/ai-brain/brain-spec/local/README.md)

## Verification

Smoke-tested the emitted stdio server with a local Node harness:

- `initialize` returned the expected server metadata
- `tools/list` returned the six tool definitions
- `memory.search` returned real recall results for `Japan 2025 Sarah`
- `memory.save_candidate` inserted a durable pending candidate row
- `memory.upsert_state` inserted an active procedural state row

## Notes

This slice is read-first and candidate/state write-safe. Consolidation remains a
background job, not an assistant-facing MCP tool.
