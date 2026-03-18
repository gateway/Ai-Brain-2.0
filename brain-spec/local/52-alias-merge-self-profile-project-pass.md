# Alias Merge, Self Profile, and Project Pass

## Scope

This pass closed three brain-side gaps:

- alias correction / merge as a first-class operator action
- namespace self identity so project notes do not need to restate `Steve`
- stronger project/spec extraction for:
  - `working on X`
  - `created by Y`
  - `I'm the acting CTO for X`
  - `conference in Turkey`
  - association / org context

NotebookLM was used twice as a second-brain check before implementation. The overlapping guidance was:

- prefer a soft redirect-capable merge path over destructive rewrite-only behavior
- keep `working on X` as graph/event evidence first
- promote to procedural current truth only when there is an explicit role/current-state signal
- keep self identity as a durable profile above namespace-local graph entities

## What Changed

### Brain schema

- added [020_alias_merge_and_identity_profiles.sql](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/migrations/020_alias_merge_and_identity_profiles.sql)
- added:
  - `entities.merged_into_entity_id`
  - `entities.identity_profile_id`
  - `identity_profiles`
  - `namespace_self_bindings`

### Runtime

- added [identity/service.ts](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/identity/service.ts)
- extended [clarifications/service.ts](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/clarifications/service.ts) with:
  - `mergeEntityAlias(...)`
  - `entity.alias_merged` outbox events
  - outbox propagation that refreshes priors and re-runs consolidation/adjudication
- extended [server/http.ts](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/server/http.ts) with:
  - `GET /ops/profile/self`
  - `POST /ops/profile/self`
  - `POST /ops/entities/merge`
- extended [narrative.ts](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/relationships/narrative.ts) so ingestion now:
  - boots from namespace self profile
  - updates the self profile when a self identity claim is seen
  - extracts:
    - `created_by`
    - `works_on`
    - `member_of`
    - cleaner `project_role`
    - bounded conference/project focus

## Live Proofs

### 1. Gumee -> Gummi alias correction

Input namespace:

- `live_personal_circle_alias_test`

Action:

- `POST /ops/entities/merge`
- payload corrected `Gumee` to canonical `Gummi`

Observed result:

- merge mode: `rename`
- outbox processed successfully
- resulting entities in that namespace:
  - `Ben`
  - `Gummi`
  - `Steve`
  - `Tim`
  - `Australia`
  - `Well Inked`

Important outcome:

- `Gumee` no longer survives as a visible active person node in that namespace
- the correction path is now editable and replayable instead of requiring raw DB surgery

### 2. Project note with namespace self profile

Fresh namespace:

- `live_project_two_way_profile_test4`

First:

- `POST /ops/profile/self`
- canonical name: `Steve`
- aliases: `Stephen`, `Steven`

Then ingested:

- [live-project-two-way.md](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/examples/live-project-two-way.md)

Accepted claim output:

- `Gumee -> created_by -> Two-Way`
- `Steve -> works_on -> Two-Way`
- `Gumee -> member_of -> Pilot Association`
- `Steve -> project_role -> Two-Way` with role `CTO`
- `Two-Way -> project_focus -> conference in Turkey`

Procedural current-truth promotion:

- consolidation promoted:
  - `project_role`
  - key: `two-way:steve`
  - value: `{"role":"CTO","person":"Steve","project":"Two-Way"}`

Important outcome:

- project notes now resolve `I` correctly from namespace self profile
- `working on X` stays as graph/event evidence
- explicit role/current-state still promotes into procedural memory

## Validation

Passed:

- `cd local-brain && npm run check`
- `cd local-brain && npm run migrate`
- `cd local-brain && npm run benchmark:narrative`
- `cd local-brain && npm run eval`
- `cd brain-console && npm run lint`
- `cd brain-console && npm run build`

## Remaining Gaps

This pass improved the path materially, but did not finish every related problem:

1. redirect-merge UI is not exposed in the operator console yet
2. project extraction still does not capture every implicit product/workflow sentence
3. conference/travel handling is still represented as project focus/event context, not a richer dedicated work-event object
4. alias merge is correct for the user case and the redirect path exists, but it still needs broader pressure tests with existing duplicate canonical rows
5. namespace self profile is implemented for local brain runtime, but the console does not yet expose a dedicated profile editor page

## Confidence After This Pass

- alias correction / merge path: `~95%`
- namespace self identity path: `~96%`
- project/spec freeform ingestion: `~93-94%`
- local brain overall: still `~98%` on architecture, with implementation quality now improved in the two areas the live tests exposed
