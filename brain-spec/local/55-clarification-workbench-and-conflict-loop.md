# 55 Clarification Workbench And Conflict Loop

## Goal

Tighten the deterministic brain path for:

- alias collisions
- name corrections
- duplicate entity detection
- human clarification
- outbox-driven propagation

The LLM remains optional. It can rank or explain a conflict, but it does not own truth.

## Notebook Guidance Used

The Digital Brain notebook said the clarification loop should follow this shape:

1. detect likely conflicts during staging
2. isolate them in a typed inbox instead of polluting active truth
3. represent user resolution as a soft redirect / canonical mapping
4. trigger background reprocessing after the edit
5. keep unresolved ambiguity out of semantic/procedural current truth

That matches the current substrate better than inventing a second clarification system.

## What Was Already Present

The repo already had:

- typed ambiguity rows on `claim_candidates`
- `POST /ops/inbox/resolve`
- `POST /ops/inbox/ignore`
- `POST /ops/entities/merge`
- `brain_outbox_events`
- deterministic reprocessing in `processBrainOutboxEvents`

The main missing piece was a first-class read path for entity-level duplicate conflicts plus a dashboard surface to resolve them.

## What Changed

### Backend

Added deterministic conflict detection in:

- `local-brain/src/ops/service.ts`

New endpoint:

- `GET /ops/ambiguities`

It returns:

- the existing typed clarification inbox
- deterministic duplicate-entity conflict candidates for the namespace

Current scoring signals:

- lexical overlap
- phonetic collision
- shared neighbors in `relationship_memory`
- shared predicates

This is intentionally deterministic and conservative.

### Console

Updated:

- `brain-console/src/lib/brain-runtime.ts`
- `brain-console/src/app/console/inbox/page.tsx`

Added:

- `brain-console/src/app/console/inbox/merge/route.ts`

The inbox page now has two surfaces:

1. clarification queue from `claim_candidates`
2. identity-conflict queue for merge/rename decisions

The merge forms drive the existing merge API and outbox flow rather than creating a parallel mutation path.

## Live Verification

Verified after rebuild/restart:

- `GET /ops/ambiguities?namespace_id=personal`
- `GET /search?query=where is Dan from?`
- `GET /ops/graph?namespace_id=personal`

Observed:

- runtime healthy on `127.0.0.1:8787`
- `where is Dan from?` returns `Dan from Mexico City`
- `personal` surfaces a real duplicate-place conflict:
  - `Koh Samui`
  - `Koh Samui Island`

That is the right type of conflict for the new workbench to catch.

## Current Honest Gaps

- cross-lane conflict detection is not done yet
  - example: `Gumi` in `personal` vs `Gumee` in `project:two-way`
- conflict detection is read-time only right now
  - it does not yet persist a separate `identity_conflicts` table
- query-time abstention on unresolved conflicts is still limited
- no dedicated “link to existing place” picker yet

## Next Best Moves

1. add optional cross-lane conflict review for identities tied by self/profile context
2. persist high-confidence conflicts into a durable work queue if needed
3. add query-time conflict warnings / abstention when a top answer is tied to an unresolved ambiguity
4. extend the workbench with place-grounding pickers and alias-history views
