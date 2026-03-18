# Place, Time, Priors, And Graph Plan

Date: 2026-03-18

## Why this slice

After closing the ambiguity inbox and BM25/TMT benchmark path, the next pressure points are:

- place containment is still flat
- relative-time normalization is still weak
- inbox controls are still generic
- graph-history priors are still mostly scene-local
- the graph UI is inspectable, but not yet a real navigable life graph

## NotebookLM takeaways

NotebookLM was queried on two narrow questions:

1. the best minimal implementation order for place containment, relative-time normalization, richer inbox controls, and graph-history priors
2. the most practical graph UI path for a Next.js + Tailwind + shadcn operator console

Useful conclusions kept:

- do `not` start with a second graph system or ontology engine
- do `not` build a full temporal reasoning engine first
- add a lightweight place containment layer inside the existing relationship model
- anchor relative time to artifact capture time or nearby scene/event anchors
- use typed inbox flows on top of the current clarification/outbox path
- add graph-history priors as scoring features, not as a new truth store
- for the frontend, use `Cytoscape.js` later as the interactive graph surface while keeping the page/server shell SSR-first

## Worker research takeaways

### Place containment and relative time

Best next slice:

- add `contained_in` place edges
- use recursive expansion at retrieval time
- keep place hierarchy curated and namespace-local first
- normalize relative time only when an anchor exists in the same artifact/scene sequence

### Typed inbox controls

The current inbox is the right surface, but it needs type-specific flows:

- alias merge
- kinship clarification
- vague place grounding
- defer / ignore

### Graph-history priors

Do not create a new subsystem. Add:

- a `relationship_priors` table as a materialized prior cache
- neighbor-signature style priors derived from accepted edges and event memberships
- history-aware score boosts during claim/relationship adjudication

### Graph UI

Best path:

- keep the relationships page server-rendered
- later add one client graph component for the graph surface only
- use `Cytoscape.js` for click-to-expand, re-root, reset-to-root, and inspection
- avoid turning the whole console into a heavy client rewrite

## Recommended implementation order

1. Place containment

Add:

- `contained_in` relationship predicate for places
- retrieval expansion from child place to parent place and optionally parent to child for search windows
- clarification resolution path that can add containment edges when vague places are grounded

Why first:

- it improves both graph quality and retrieval immediately
- it is the simplest structural upgrade

2. Relative-time anchors

Add:

- `anchor_scene_id`
- `anchor_event_id`
- `anchor_basis`
- `anchor_confidence`

Behavior:

- resolve `two months later`, `last Friday`, `earlier that year` using artifact capture time or prior anchored scene in the same observation
- keep unresolved text if confidence is weak

Why second:

- it improves narrative event quality without inventing dates

3. Relationship priors

Add:

- `relationship_priors` table keyed by subject/predicate/object or typed neighbor pattern
- support counts, support score, first/last seen timestamps
- refresh job from accepted `relationship_memory` and `narrative_event_members`

Behavior:

- use prior scores during claim and relationship candidate ranking
- keep priors advisory, not authoritative

Why third:

- this is where alias and vague-entity disambiguation becomes materially better

4. Richer inbox controls

Add:

- type-specific UI controls for alias, kinship, and place grounding
- better operator payloads from `ops/service.ts`
- explicit defer / save-without-rerun action

Why fourth:

- the inbox becomes much more useful after place containment and priors exist

## Graph UI recommendation

Use `Cytoscape.js` for the next graph jump.

Why:

- the current SVG graph is fine for static inspection
- `React Flow` is better for workflow canvases than relationship graphs
- `Sigma.js` is more appropriate when scale is the core constraint
- `vis-network` is workable but less attractive for a polished operator surface

Rollout:

1. keep `/console/relationships` server-rendered
2. add a client-only graph canvas component inside that page
3. support:
   - click node to focus
   - expand neighbors
   - recenter to root
   - reset to namespace root
   - open details panel
   - highlight unresolved ambiguity edges/nodes

## UI direction

The uploaded dark UI references point in a clear direction:

- darker, softer shell
- fewer dense column layouts
- stronger panels and hierarchy
- more obvious control-room feeling
- graph and timeline treated as primary surfaces, not afterthought cards

The first pass should keep:

- overview
- relationships
- timeline
- inbox

with richer dark styling and less spreadsheet energy.

## Honest constraints

- no new external graph database
- no GIS stack
- no LLM-heavy default temporal normalization pass
- no giant frontend rewrite for the console

## Immediate next slice

The best next code slice is:

1. `relationship_priors` migration + refresh job
2. `contained_in` place edges + recursive retrieval expansion
3. relative-time anchor fields + local normalization improvements
4. richer `/console/inbox` actions
5. `Cytoscape.js` proof-of-concept on `/console/relationships`
