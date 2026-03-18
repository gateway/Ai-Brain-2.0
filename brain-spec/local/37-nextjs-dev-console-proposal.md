# Next.js Dev Console Proposal

Date: 2026-03-18

## Goal

Create a local developer console for Brain 2.0 so we can:

- run queries visually
- inspect provenance and artifacts
- launch eval and benchmark runs
- inspect timeline and relationship outputs
- debug queues, jobs, and health

This is a development/operator surface, not the final product UI.

## Recommendation

Build the first version as a **server-rendered Next.js App Router console with no client JS by default**.

Why:

- the brain already exposes stable local HTTP and CLI surfaces
- queries, eval runs, artifacts, timelines, and provenance inspection all work well as form-submit + SSR pages
- this keeps the console cheap to build and aligned with the still-evolving backend

Do **not** overbuild the graph UI yet.

## What Can Stay No-JS

These are good fits for server components and plain HTML forms:

- query runner
- timeline browser
- relationship lookup table
- artifact detail/provenance page
- eval results page
- lexical benchmark page
- runtime/jobs dashboard
- health/config page

## What Likely Needs JS Later

These are poor fits for a strict no-JS rule if we want them polished:

- pan/zoom/drag relationship graph
- interactive temporal tree explorer
- live queue streaming
- dense provenance overlays

For the first slice, use:

- static SVG
- Mermaid diagrams
- server-rendered adjacency tables

That is enough to validate the model and data before building richer interaction.

## Proposed Pages

### `/console`

Overview page:

- health status
- latest eval status
- latest lexical benchmark status
- recent jobs
- quick links into query, artifacts, timeline, and graph

### `/console/query`

Server-rendered query page:

- search form
- namespace selector
- optional time filters
- optional provider/model fields
- rendered result cards
- provenance links

### `/console/timeline`

Chronological view:

- namespace
- time range
- grouped by day/week/month
- links into source artifacts

### `/console/relationships`

Relationship inspector:

- entity search
- predicate filter
- time filter
- adjacency list
- optional static SVG graph

### `/console/artifacts/[id]`

Artifact detail:

- artifact metadata
- observations
- derivations
- source URI
- checksum/version history
- linked memory hits

### `/console/eval`

Runtime verification page:

- run local eval
- show latest eval report
- pass/fail table
- metrics

### `/console/benchmark`

Lexical benchmark page:

- run benchmark
- compare FTS vs BM25
- show case table
- show recommendation

### `/console/jobs`

Operator dashboard:

- derivation jobs
- vector sync jobs
- recent consolidation runs
- recent semantic decay events
- temporal summary status

## Data Sources

The dev console should use the existing local runtime first:

- HTTP endpoints from `local-brain`
- latest eval/benchmark artifacts on disk
- DB-backed lookup pages through a small server-side adapter

This avoids duplicating brain logic in the console.

## Suggested Build Order

1. `query`
2. `artifact detail`
3. `eval`
4. `benchmark`
5. `timeline`
6. `relationships`
7. static graph view
8. richer graph UI only if it proves valuable

## Honest Constraint

The graph view should not become the priority while relationship semantics and TMT traversal are still evolving.

The right first goal is:

- make the brain observable
- make provenance debuggable
- make benchmarks one-click

Then build prettier visualization if it still feels worth it.
