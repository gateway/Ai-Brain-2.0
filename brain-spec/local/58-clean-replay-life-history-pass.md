# 58. Clean Replay + Life History Pass

Date: 2026-03-19

## Goal

Run a true clean-database replay of Steve memory fixtures, improve deterministic life-history extraction, verify queryability, and cross-check the architecture against the Digital Brain notebook.

## Notebook Guidance Used

- Keep raw evidence immutable.
- Keep extraction deterministic first; use LLM only as classifier/checker.
- Normalize life data into people, places, orgs/projects, events, times, preferences, procedures, and relationship priors.
- Historical answer synthesis should be SQL-first and exact-evidence-first.
- Preference supersession should preserve raw evidence and decay derived summaries, not source truth.
- Temporal normalization remains a major follow-up gap.

## Code Changes

- `local-brain/src/relationships/narrative.ts`
  - Added broader structured life-history parsing for:
    - `Lived:` lines
    - `born_in`
    - `moved to`
    - numbered work headings
    - timeline work headings
    - `Role: X at Company`
  - Improved place cleanup and structured-place acceptance.
  - Fixed work-heading parsing for parenthetical company names and mixed heading formats.
  - Fixed Dreaming Computers style headings where role/org were previously swapped.
- `local-brain/src/retrieval/query-signals.ts`
  - Added stronger historical relationship query detection.
- `local-brain/src/retrieval/service.ts`
  - Relaxed pruning for historical `where has lived/worked` style queries so structured relationship results surface instead of being over-trimmed.

## Clean Replay Flow

- dropped and recreated `ai_brain_local`
- re-enabled `timescaledb`
- ran all migrations through `022_cross_lane_identity_conflicts.sql`
- replayed:
  - `story.md`
  - `live-personal-circle.md`
  - `steve-work-history-2026-03-18.md`
  - `steve-location-timeline-signature-work-2026-03-18.md`
  - `steve-thailand-friends-and-preferences-2026-03-18.md`
  - `live-project-two-way.md`
- ran consolidation
- ran relationship adjudication
- ran temporal summaries
- resolved known conflicts:
  - `Gumi` + `Gumee` -> `Gummi`
  - `Two Way` + `Two-Way` -> `2Way`
  - `Koh Samui` + `Koh Samui Island` -> `Koh Samui`

## Verified Query Outcomes

- `where has Steve lived?`
  - returns structured historical places including Dallas area, California, San Francisco Bay Area, Tahoe City / Lake Tahoe, Kansas, Santa Cruz area, Dallas, TX, San Diego, California
- `where was Steve born?`
  - returns `Steve Tietze born in Munich, Germany`
- `where has Steve worked?`
  - returns structured work rows including Likemoji, 2Way, Apogee Software, Rogue Entertainment, Nihilistic Software, Dreaming Computers, Sync-a-Lot Software, Factor 5
- `what did Steve do at Factor 5?`
  - returns procedural role truth for `Lead Tools Developer`
- `who are Steve's friends?`
  - returns Benjamin Williams, Gummi, and Dan
- `what is Steve working on?`
  - returns `Steve Tietze works on 2Way`

## Graph State

- historical companies now appear in the graph
- historical places now appear in the graph
- junk node `the United States around age` no longer appears
- remaining open duplicate-place conflict:
  - `Tahoe City / Lake Tahoe`
  - `Tahoe City / Lake Tahoe, California`

## Benchmark

- `npm run benchmark:narrative`
  - `5/5` passed
  - recommendation: `ready_for_more_story_types`

## Remaining Honest Gaps

- temporal normalization is still weaker than the notebook target
- historical answers like `what was Steve doing in Tahoe?` still return strong evidence fragments rather than a cleaner synthesized answer
- place hierarchy is still partly flat and curated
- preference anchor protection / decay policy needs a dedicated pass
- higher-level life-profile rollups are not implemented yet
