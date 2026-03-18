# Brain Console

This app is the local operator console for Brain 2.0.

Stack:

- `Next.js`
- `Tailwind CSS`
- `shadcn/ui`

It is intentionally a developer/operator surface, not the final end-user product UI.

## What It Shows

- runtime health from the local brain HTTP server
- lexical status and BM25/FTS posture
- live query runs with planner and provenance details
- timeline browsing with rolled-up temporal summaries and supporting episodic evidence
- relationship graph browsing with live pan/zoom, click-to-focus, expand, recenter, and reset-root controls
- latest eval report
- latest lexical benchmark report
- queue and memory-health overview
- artifact detail pages for durable provenance inspection

## Requirements

1. Start the local brain runtime:

```bash
cd /Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain
npm run serve
```

2. Install console dependencies:

```bash
cd /Users/evilone/Documents/Development/AI-Brain/ai-brain/brain-console
npm install
```

## Run

```bash
cd /Users/evilone/Documents/Development/AI-Brain/ai-brain/brain-console
BRAIN_RUNTIME_BASE_URL=http://127.0.0.1:8787 npm run dev
```

Then open:

- `http://127.0.0.1:3000/console`

## Current Pages

- `/console`
- `/console/query`
- `/console/eval`
- `/console/benchmark`
- `/console/jobs`
- `/console/timeline`
- `/console/relationships`
- `/console/artifacts/[id]`

## Current Operator Actions

- `POST /console/eval/run`
- `POST /console/benchmark/run`

## Current Design Decision

The console is still SSR-first, but the graph surface is now client-interactive where it needs to be.

Why:

- the shell and data pages remain cheap and easy to reason about
- the relationships page now has enough room to behave like an atlas instead of a dashboard tile
- `Cytoscape.js` is contained to the graph surface, not the whole app

What exists now:

- a top-nav operator shell instead of the old left rail
- a darker 2026-style control-deck theme
- a live relationship graph with pan/zoom, focus, expand, recenter, and reset
- a timeline page that shows both rolled-up temporal nodes and supporting episodic leaves

What still comes later:

- richer temporal containment diagnostics
- supersession and causal overlays in the graph
- stronger provenance drilldowns directly from selected nodes and edges
