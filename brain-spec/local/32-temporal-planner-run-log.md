# 32 - Temporal Planner Slice Run Log

Date: 2026-03-18

Scope: retrieval-only TMT planner helper.

## What Changed

- Added `local-brain/src/retrieval/planner.ts`.
- Added query classification for `simple | hybrid | complex`.
- Infer year hints from queries like `2025` and expand them into a temporal window.
- Bias time-bounded queries toward episodic evidence and `temporal_nodes` summaries.
- Include the planner decision in retrieval response metadata.
- Keep non-temporal searches quiet by only expanding temporal summaries when the query is actually temporal.

## What This Slice Does

- Answers queries like `What was I doing in Japan in 2025?` with a planner that prefers:
  - episodic evidence
  - temporal summaries
  - then broader lexical hits
- Keeps the current DB shape intact.
- Avoids overpromising full TiMem or any new storage model.

## NotebookLM Check

NotebookLM said this is the correct next safe retrieval slice.

Minimal missing adjustment it pointed out:

- explicit parent-child linkage from episodic fragments to summary nodes

That is the next structural step for a fuller TMT hierarchy, but it is outside this worker's retrieval-only scope.

## Verification

- `npm run check` was run after the change.
- Repo-wide typecheck still fails on a pre-existing MCP typing issue in `src/mcp/server.ts`.
- No changes were made to MCP, providers, jobs, or producers.

## Current Assessment

- The retrieval layer now has a small TMT planner helper.
- Temporal recall is more intentional without turning into a new architecture.
- The next true structural gain is still parent-child linkage plus hierarchical ancestor traversal.
