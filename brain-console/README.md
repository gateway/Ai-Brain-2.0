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
- relationship graph browsing with clickable entity refocus and edge inspection
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

The console is server-rendered first and graph-light on purpose.

Why:

- it keeps the operator workflow cheap while the brain semantics are still moving
- it makes BM25/FTS, temporal recall, provenance, and job state visible without inventing a second backend
- it avoids overcommitting to a client-heavy graph UI before relationship semantics are stable enough to deserve it

What exists now is the safe middle ground:

- a themed operator atlas
- a clickable SVG relationship graph backed by live runtime data
- a timeline page that shows both rolled-up temporal nodes and supporting episodic leaves

What still comes later:

- richer temporal containment diagnostics
- supersession and causal overlays in the graph
- heavier interactive graph exploration if the relationship semantics justify it
