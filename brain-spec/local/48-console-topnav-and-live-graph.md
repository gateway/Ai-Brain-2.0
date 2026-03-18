# Console Top-Nav And Live Graph

Date: 2026-03-18

## Why this slice

The console shell still behaved like a generic admin dashboard:

- too much width lost to the left rail
- graph page felt like a card beside other cards
- no real graph movement once the page loaded

The goal of this slice was to make the console feel more like a graph-first operator atlas.

## Research loop

NotebookLM was used again as a second brain for:

- the best graph UI path for a `Next.js + Tailwind + shadcn` operator console
- how to keep the page SSR-first while allowing richer interaction inside the graph

Useful guidance kept:

- move the shell to top navigation instead of a full-height left rail
- keep the relationships page graph-first instead of dashboard-first
- use `Cytoscape.js` for the first real interactive graph surface
- avoid rewriting the whole console into a heavy client app

Worker review agreed with the same direction:

- `top-nav` is better than the sidebar here
- the graph should own the relationships page
- the overview page should stay a launchpad, not the emotional center

## What changed

### Shell redesign

The shell now uses:

- a sticky top control deck
- horizontal route pills
- compact posture/status chips
- more breathing room for the actual content surface

This removed the main layout pressure from the old sidebar.

### Live graph

The relationships page now uses `Cytoscape.js`.

Current graph behavior:

- pan
- zoom
- click node to re-root locally
- expand 1-hop to 2-hop to full graph
- recenter on the current node
- reset back to the original root
- click edge to inspect the active relationship

This is still grounded in the current backend graph contract. It does not invent speculative links.

### Relationships page layout

The relationships page was rebalanced so:

- the graph sits above the fold as the main surface
- operator context sits below it
- the roster and predicate mix support the graph rather than competing with it

## Validation

Verified in `brain-console`:

- `npm run lint`
- `npm run build`

## Files changed in this slice

- `brain-console/package.json`
- `brain-console/package-lock.json`
- `brain-console/src/components/console-shell.tsx`
- `brain-console/src/components/relationship-graph.tsx`
- `brain-console/src/app/console/relationships/page.tsx`

The broader visual theme files from the earlier dark-pass remain part of the same console direction:

- `brain-console/src/app/layout.tsx`
- `brain-console/src/app/console/page.tsx`
- `brain-console/src/app/console/timeline/page.tsx`
- `brain-console/src/components/metric-card.tsx`
- `brain-console/src/components/ui/card.tsx`
- `brain-console/src/components/console-primitives.tsx`

## Honest status

This is a real improvement, but not the final graph UX.

Still to come:

- selected-node provenance drilldown
- graph overlays for ambiguity, supersession, and confidence bands
- stronger relationship semantics before more aggressive graph animation/filtering
- eventual containment and relative-time overlays once the data layer is upgraded
