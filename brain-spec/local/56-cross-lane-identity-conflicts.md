# 56. Cross-Lane Identity Conflicts

Date: 2026-03-18

## Goal

Make likely duplicate entities surface across durable namespaces, not just inside one lane, and let the operator either:

- resolve them into one shared identity
- keep them separate permanently

The Digital Brain notebook guidance was used as the policy reference:

- one canonical identity may span many lanes
- raw evidence stays immutable
- aliases are soft redirects
- clarification decisions should propagate through an outbox/rebuild loop

## What Landed

- `022_cross_lane_identity_conflicts.sql`
  - generalized `identity_profiles`
  - added `identity_conflict_decisions`
- cross-lane conflict detection in `local-brain/src/ops/service.ts`
- cross-lane resolve / keep-separate actions in `local-brain/src/clarifications/service.ts`
- new runtime routes:
  - `POST /ops/identity-conflicts/resolve`
  - `POST /ops/identity-conflicts/keep-separate`
- inbox UI updates:
  - lane badges
  - cross-lane badges
  - shared identity resolve flow
  - `These are different`

## Verified

Runtime:

- `GET /health` => `ok`
- `GET /ops/ambiguities?namespace_id=personal`
- `GET /ops/ambiguities?namespace_id=project:two-way`

Console:

- inbox page renders the new conflict cards and actions

## Live Proof

Before resolution, `personal` surfaced:

- `Two Way` vs `Two-Way`
- `Gumi` vs `Gumee`

Cross-lane resolve was executed for:

- canonical: `Gummi`
- aliases: `Gumi`, `Gumee`

Result:

- both lanes now point at the same `identity_profile_id`
- both entity rows now use canonical `Gummi`
- the `Gumi/Gumee` conflict no longer appears in the ambiguity workbench
- raw source notes were not rewritten

## Current Behavior

- same-namespace duplicates can still merge physically when appropriate
- cross-lane duplicates now link through shared identity profiles
- explicit `keep_separate` decisions are durable
- outbox processing re-runs consolidation / priors / adjudication after identity updates

## Remaining Work

- add operator-facing history for prior merge / keep-separate decisions
- add stronger conflict evidence display for shared predicates and source fragments
- decide canonical naming for `Two Way` vs `Two-Way`
- extend conflict detection toward more place/org variants and lower-confidence review queues
