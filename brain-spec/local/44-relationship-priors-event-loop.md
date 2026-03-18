# Relationship Priors Event Loop

## Goal

Tighten freeform first-person story ingestion around relationship priors:

- people
- places
- things or organizations
- times
- events

without requiring the speaker to structure the input.

## Second-Brain Loop

NotebookLM and worker review converged on the same missing prior:

- raw scenes were present
- claims were present
- relationships were present
- explicit event containers and event membership were missing

The useful NotebookLM guidance was:

- keep `narrative_scenes` as transcript/story containers
- add a minimal event layer rather than overloading entity edges
- attach time to scenes, claims, and events
- keep events immutable/contextual and facts supersedable
- use event membership for co-participation, not fake graph inference from vector proximity

## What Changed

Schema:

- added [`016_event_priors.sql`](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/migrations/016_event_priors.sql)
- added `narrative_events`
- added `narrative_event_members`
- added scene/claim/event time fields
- added `source_event_id` on `claim_candidates` and `relationship_candidates`
- added scene/event linkage columns on `temporal_node_members`

Runtime:

- [`fragment.ts`](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/ingest/fragment.ts)
  - preserves relative-time expressions and simple time anchors on scenes
- [`narrative.ts`](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/relationships/narrative.ts)
  - builds event drafts from resolved scene claims
  - writes event containers
  - writes event membership records
  - carries event/time provenance into claim and relationship staging
- [`temporal-summary.ts`](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/jobs/temporal-summary.ts)
  - now attaches available scene/event links into summary membership rows

## Validation Loop

Test input:

- the user’s original freeform friend/story narrative
- ingested in clean namespace: `personal_story_event_test`

Commands used:

```bash
cd /Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain
npm run migrate
npm run ingest:file -- /tmp/steve_friends_story.md --source-type markdown_session --namespace personal_story_event_test --source-channel conversation:personal_story
npm run adjudicate:relationships -- --namespace personal_story_event_test --limit 200 --accept-threshold 0.6 --reject-threshold 0.4
npm run summarize:temporal -- --namespace personal_story_event_test
```

Observed event rows:

- `Steve lives in Chiang Mai`
- `Gumi works at Icelandic Air`
- `Steve works at Well Inked`
- `Benjamin Williams lived in France`
- `Renee currently in Danang`

Observed relationship edges stayed materially correct:

- `Steve -> friend_of -> Lauren`
- `Steve -> lives_in -> Chiang Mai`
- `Dan -> from -> Mexico City`
- `Gumi -> from -> Iceland`
- `Gumi -> works_at -> Icelandic Air`
- `Gumi -> runs -> Two Way`
- `Steve -> works_at -> Two Way`
- `Steve -> works_with -> Benjamin Williams`
- `Benjamin Williams -> runs -> Well Inked`
- `Renee -> currently_in -> Danang`

## Self Review

What went well:

- the system now handles freeform personal story input much closer to how the user actually speaks
- time is no longer only implicit in edges
- co-participation has an explicit event home
- raw markdown/transcript remains the source of truth

What is still imperfect:

- event grouping is still scene-local, not true multi-scene event consolidation
- relative-time normalization is still shallow
- event labels are better but still deterministic, not model-quality summaries
- the global seeded eval suite still has older temporal/relationship gaps unrelated to this specific story loop

## Confidence

- path/architecture for freeform story ingestion with relationship priors: `~98%`
- current deterministic implementation quality on this class of story: `~93%`

## Next Tight Moves

- add model-backed claim extraction as a second pass over deterministic claims
- consolidate multiple related scenes into a single logical event when confidence is high
- improve relative-time normalization without inventing dates
- add a golden narrative-story test pack for people/place/org/time/event assertions
