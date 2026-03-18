# Console Timeline And Relationship Slice

Date: 2026-03-18
Branch: `codex/brain-2-0-foundation`

## What Changed

This slice turned the operator console into a more visual local atlas instead of
just a benchmark/debug shell.

Delivered:

- themed console shell with a stronger visual identity
- timeline page with:
  - chronological episodic evidence
  - rolled-up temporal summaries
  - time-window controls
- relationship page with:
  - clickable server-rendered graph
  - entity focus controls
  - edge ledger
  - node/edge summary cards
- live runtime ops endpoints for:
  - `GET /ops/timeline`
  - `GET /ops/graph`
- deeper deterministic TMT descent:
  - broad year queries descend by layer
  - `month -> week -> day`
  - early stop when current evidence is sufficient

## NotebookLM Sanity Check

NotebookLM was used again as a second brain for this slice.

Prompt theme:

- how to present TMT and relationship memory in an operator console
- how to avoid overclaiming certainty
- what controls and diagnostics matter

Useful guidance retained:

- show hierarchy and provenance, not just a pretty picture
- keep the graph explicit and evidence-linked, not semantic-vibe spaghetti
- expose what the planner and retrieval stages are doing
- do not imply the graph is more authoritative than the current data model

What I did not copy blindly:

- I did not implement a full Gantt-style TMT explorer yet
- I did not add LLM gating UI or certainty theater
- I kept the current graph view server-rendered and grounded in active
  relationship memory instead of building an overstated force-graph frontend

## Files

Backend:

- `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/ops/service.ts`
- `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/server/http.ts`
- `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/retrieval/planner.ts`
- `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/retrieval/service.ts`
- `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/retrieval/types.ts`
- `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/eval/runner.ts`
- `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/test/planner-temporal-depth.mjs`

Console:

- `/Users/evilone/Documents/Development/AI-Brain/ai-brain/brain-console/src/app/console/page.tsx`
- `/Users/evilone/Documents/Development/AI-Brain/ai-brain/brain-console/src/app/console/query/page.tsx`
- `/Users/evilone/Documents/Development/AI-Brain/ai-brain/brain-console/src/app/console/timeline/page.tsx`
- `/Users/evilone/Documents/Development/AI-Brain/ai-brain/brain-console/src/app/console/relationships/page.tsx`
- `/Users/evilone/Documents/Development/AI-Brain/ai-brain/brain-console/src/app/globals.css`
- `/Users/evilone/Documents/Development/AI-Brain/ai-brain/brain-console/src/components/console-shell.tsx`
- `/Users/evilone/Documents/Development/AI-Brain/ai-brain/brain-console/src/components/relationship-graph.tsx`
- `/Users/evilone/Documents/Development/AI-Brain/ai-brain/brain-console/src/lib/brain-runtime.ts`

Docs:

- `/Users/evilone/Documents/Development/AI-Brain/ai-brain/README.md`
- `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/README.md`
- `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/CHANGELOG.md`
- `/Users/evilone/Documents/Development/AI-Brain/ai-brain/brain-console/README.md`

## Verification

Local brain:

- `npm run check`
- `npm run eval`

Console:

- `npm run lint`
- `npm run build`

Live operator checks:

- `/ops/timeline` returned episodic rows plus temporal summaries
- `/ops/graph` returned nodes and edges for the seeded eval namespace
- `/console/timeline` rendered successfully
- `/console/relationships` rendered successfully

## Why This Slice Matters

Before this pass, the console was mainly:

- overview
- query
- benchmark/eval
- jobs

After this pass, the local brain is inspectable as:

- a timeline of lived evidence
- a hierarchy of temporal rollups
- a relationship graph that can be re-centered interactively

This makes the brain much easier to debug and much easier to trust.

## Self-Review

What went well:

- the graph is useful without becoming a client-heavy toy
- the timeline is readable and grounded in provenance
- the TMT descent got materially better without pretending to be a full
  hierarchical recall engine

What is still incomplete:

- no explicit temporal containment violation view yet
- no supersession overlay in the relationship graph yet
- no causal edge family yet
- no screenshot capture in docs yet

Current status:

- BM25: closed enough to be runtime default
- console: now genuinely usable as an operator atlas
- TMT: deeper and more honest, but not finished
