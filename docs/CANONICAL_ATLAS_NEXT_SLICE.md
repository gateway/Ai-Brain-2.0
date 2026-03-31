# Canonical Atlas Next Slice

This document originally froze the next build slice before more implementation
started. It now records the current validated state after the clean-replay
canonical-atlas push and the follow-on temporal-recap/warm-start slice so the
next widening step can start from the right place.

## Goal

Push the AI Brain from “good canonical foundations” into a broader
person/kinship/atlas product state without losing the current clean-replay
green status.

The next slice should improve:

- more real-person alias handling
- kinship clarification closure
- atlas-backed relationship queries
- atlas polish on top of cleaner truth

## Current validated state

What is now validated from clean replay:

- more real-person alias handling is green in the private OMI review
- kinship clarification for `Uncle -> Billy Smith` is green
- canonical place alias collapse for `Samui / Koh Samui / Kozimui` is green
- atlas-backed relationship and graph queries are green in MCP smoke
- the latest `what did I do yesterday?` OMI note is live and queryable
- the atlas UI now shows canonical resolution, active vs historical status,
  validity windows, provenance tier, and clarification/conflict pressure

Current benchmark state:

- canonical identity review: `5 pass / 0 fail`
- personal OMI review: `24 pass / 0 warning / 0 fail`
- MCP production smoke: `30 pass / 0 fail`
- personal OpenClaw review: `9 pass / 0 fail`
- dashboard lint/build: pass

## Scope

### 1. More real people aliases

Target:

- widen canonical coverage for real names and noisy variants
- keep aliases, nicknames, ASR drift, and place drift attached to one canonical
  entity

Examples:

- `Uncle`, `Billy Smith`, `Joe Bob`
- `Samui`, `Koh Samui`, `Kozimui`
- real people that appear in new OMI notes

### 2. Kinship clarification

Target:

- when the system sees ambiguous kinship labels like `uncle`, `aunt`,
  `grandma`, or relationship nicknames, it should either:
  - resolve through existing canonical identity, or
  - create a clarification that can rebuild the canonical layer once resolved

Examples:

- `Who is Uncle?`
- `Did you mean Billy Smith when you said uncle?`

### 3. Atlas backend relationship queries

Target:

- widen query support behind the existing atlas surfaces so the graph is not
  just visual, but queryable with stronger canonical truth

Examples:

- `Who is James in my life and what is he associated with?`
- `What is Steve's history with Lauren?`
- `What did I do yesterday?`
- `What was I working on with Ben?`

### 4. Atlas polish

Target:

- keep using the current dashboard/console
- deepen the existing atlas instead of inventing a new UI

Immediate polish items:

- better node detail for aliases and kinship labels
- clearer active vs historical relationship badges
- clearer provenance cues
- better conflict/clarification pointers from graph nodes

## Current user-facing state

What already works:

- `/console/relationships` is the main relationship atlas surface
- `/sessions/[sessionId]/graph` is the session-scoped atlas bridge
- direct relationship/history queries are green in MCP smoke
- canonical alias resolution for `Kozimui` and `Uncle` is green
- `What did I do yesterday?` now returns a shaped recap grounded in the latest
  OMI note instead of metadata headings
- `What did I talk about yesterday?` now returns a shaped recap through the
  same recap-family path instead of falling through to raw transcript rows
- `What should you know about me to start today?` now returns a warm-start
  pack with current focus and recent recap context, and the knowledge surface
  exposes that pack directly
- relationship/profile queries for `Ben`, `James`, and `Omi` are now
  source-backed and cleaner after typed extraction cleanup
- typed purchase queries are live and compact:
  - `What did I buy today and what were the prices?`
  - returns the bought items plus the honest total when only the total is
    grounded
- typed media summary queries are live:
  - `What movies have I talked about?`
  - returns grounded titles instead of a mixed recap blob
- explicit food-preference questions now abstain honestly when the corpus does
  not yet contain grounded food-preference facts
- explicit self-preference questions now use typed preference facts from the
  latest OMI note instead of leaking foreign media facts
- routine questions now return a shaped routine summary from the new OMI note
- direct relationship-change queries for Lauren now route through typed
  person-time transition facts before falling back to broad lexical retrieval

What is still immature:

- atlas node detail for kinship and alias context is still shallow
- not all real people have explicit canonical alias coverage yet
- atlas-backed query bundles can still be richer and tighter
- some atlas polish is still first-pass rather than final product depth
- typed preference coverage is still shallow because the current corpus does not
  yet contain many explicit preference statements

## New OMI note now in scope

Imported into `personal` on `2026-03-28` and now validated in query behavior:

- `2026-03-28T01-29-10Z__omi__ce78791a-9a8b-4949-88b6-15d6a6f2598c.md`

It adds fresh “what I did yesterday” support for:

- AI Brain
- Preset Kitchen
- Bumblebee / OpenClaw at Well Inked
- KIE.ai Python wrappers
- Two Way work with Omi

This note now feeds both:

- continuity-style recap queries
- atlas/person/project relationship queries
- typed temporal recap shaping for `What did I do yesterday?`
- warm-start startup synthesis for `What should you know about me to start today?`

Observed recap behavior:

- `What did I do yesterday?`
  - now returns: `Yesterday you worked on AI Brain, Preset Kitchen,
    Bumblebee, Well Inked, Two Way.`

## Success metrics

These are the operator-readable metrics for this slice.

### Canonical alias score

Goal:

- more real-person and kinship alias cases collapse to one canonical entity

### Clarification closure score

Goal:

- resolved kinship ambiguities stop reappearing after rebuild and replay

### Atlas query score

Goal:

- more direct person/history/association questions pass through atlas-backed
  relationship truth

### Atlas polish score

Goal:

- node/edge detail is clearer and more obviously trustworthy
- canonical resolution and validity windows remain visible in the atlas UI

### Yesterday recap reality check

Goal:

- the new OMI note changes what `what did I do yesterday?` returns
- the answer should mention at least some of:
  - AI Brain
  - Preset Kitchen
  - Bumblebee / OpenClaw
  - KIE wrappers
  - Two Way

## Test loop

Run in this order:

```bash
cd /Users/evilone/Documents/Development/AI-Brain/ai-brain
npm run omi:sync

cd /Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain
npm run namespace:reset -- --namespace-id personal
npm run namespace:replay -- --namespace-id personal --force
npm run typed-memory:rebuild -- --namespace-id personal
npm run namespace:reset -- --namespace-id personal_continuity_shadow
npm run namespace:replay -- --namespace-id personal_continuity_shadow --force
npm run typed-memory:rebuild -- --namespace-id personal_continuity_shadow
npm run benchmark:canonical-identity-review
npm run benchmark:personal-omi-review
npm run benchmark:mcp-production-smoke
npm run benchmark:personal-openclaw-review
npm run benchmark:session-start-memory
```

Then manually inspect:

- `/console/relationships`
- `/sessions/[sessionId]/graph`
- targeted natural queries for yesterday recap, person/kinship lookup, typed
  purchase recall, typed media recall, and explicit food-preference abstention

## Guardrails

- keep Postgres as truth
- keep graph as a derived read model
- do not widen retrieval heuristics to hide identity problems
- do not bypass clarifications when ambiguity is real
- keep clean replay as the trusted validation posture

## Next widening step

The next widening step from this baseline should focus on:

- more real-person alias coverage from fresh OMI notes
- more kinship and nickname clarification cases
- richer atlas-backed node dossiers and edge provenance summaries
- tighter atlas query bundles so graph exploration and direct MCP answers stay
  aligned
- deeper typed preference and person-time fact coverage so more natural
  language questions route to compact structured answers
