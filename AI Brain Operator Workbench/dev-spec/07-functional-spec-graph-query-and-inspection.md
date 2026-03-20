# 07 — Functional Spec: Graph, Query, and Inspection

## Goal

Define the graph explorer, timeline, artifact inspection, and query workbench.

## Graph explorer purpose

The graph explorer should let an operator understand how a session became connected knowledge.

The graph should be:
- session-scoped first
- expandable into wider graph context
- filterable
- inspectable
- provenance-aware

## Initial graph load

Default graph load should use **session-scoped entities and relationships**.

That means the first render should include:
- entities detected or involved in the session
- candidate or consolidated edges sourced by the session
- optional artifact nodes if useful
- lightweight metadata for counts and confidence

Do not load the entire global graph by default.

## Graph node types

Recommended node types:
- person
- place
- organization
- project
- event
- artifact
- skill
- concept
- unknown/unresolved

## Graph edge types

Examples:
- knows
- worked_at
- lived_in
- friend_of
- family_of
- part_of
- mentioned_in
- occurred_at
- associated_with
- alias_of
- uncertain_link

## Graph UI requirements

### Main canvas
- pan/zoom
- fit to view
- layout reset
- node click
- edge click
- expand node action
- collapse subgraph action if possible

### Right sidebar or drawer
Show selected node/edge detail:
- label
- type
- canonical id
- confidence
- source count
- provenance snippets
- related artifacts
- actions:
  - expand neighbors
  - open in review
  - open in timeline
  - open in query
  - open clarification if unresolved

### Top controls
- search in graph
- node type filter
- edge type filter
- confidence filter
- session/global toggle
- reset graph

## Graph expansion rules

When operator expands a node:
1. fetch neighbors from brain runtime
2. attach incremental nodes and edges
3. preserve previous layout where possible
4. visually distinguish newly added items

## Graph provenance requirements

Every node and edge shown should be traceable to:
- source session
- source artifact(s)
- source evidence snippet(s)
- review/correction status if applicable

## Graph performance rules

- use SSR for shell
- graph canvas can be client-only
- page should not block on full global graph data
- incremental expansion should be paged if large
- large graphs should support max nodes threshold and warning

## Timeline page

The timeline page should show:
- ordered evidence entries for the session
- transcript segments or text chunks
- temporal grouping by date/time if available
- relationship/claim emergence over time if feasible
- quick jump from event to source/artifact/review

## Artifact inspection page

Artifact detail should show:
- metadata
- original file info
- preview if supported
- derivation outputs
- transcript/OCR text if present
- linked review items
- linked graph entities if known

## Query workbench modes

### Mode 1 — Search
Simple search interface backed by brain retrieval.

Inputs:
- search query
- optional session scope
- optional retrieval options if exposed

Outputs:
- result list
- provenance
- relevant entities/relationships if available

### Mode 2 — Timeline query
Query by time or chronology.

Inputs:
- text query
- date range if applicable
- session scope

Outputs:
- ordered results
- temporal summaries if provided

### Mode 3 — SQL
Read-only SQL editor.

Inputs:
- SQL text
- optional saved query name

Rules:
- only `SELECT` and safe read constructs
- disallow `INSERT`, `UPDATE`, `DELETE`, `ALTER`, `DROP`, `TRUNCATE`, `COPY`, etc.
- add timeout and row limit
- preferably query against views if possible

Outputs:
- result grid
- row count
- execution time
- query rejection reason if blocked

## Saved queries

Allow saving:
- title
- SQL/query text
- scope
- owner
- last run date

## Query acceptance criteria

- operator can inspect the session using search and SQL
- unsafe SQL is rejected
- errors are understandable
- results are exportable or copyable in MVP-friendly ways

## Nice-to-have graph features

- alternate layout choices
- highlight path between two nodes
- show only review-confirmed edges
- color by entity type or confidence
- mini-map
- node pinning
