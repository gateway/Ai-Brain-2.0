# 57. Identity History, Strict Brand Mode, and Graph Pass

Date: 2026-03-18

## Goal

- keep resolved identity decisions visible after they leave the queue
- support strict canonical renames through API endpoints, not only UI
- make the relationship graph open in a more readable expanded state

## Notebook / Worker Direction

Digital Brain guidance and worker review converged on:

- canonical identity can span lanes
- raw evidence remains unchanged
- history of identity decisions should stay visible
- strict brand naming should be an explicit option, not implicit behavior
- graph layout should prefer structured, spread-out opening modes over dense force layouts

## What Landed

### Identity history

- `GET /ops/identity-conflicts/history?namespace_id=...`
- ambiguity workbench now returns:
  - `identityConflicts`
  - `identityHistory`

### Strict canonical mode

- both merge APIs now accept:
  - `preserve_aliases`
- `preserve_aliases=false` now retires prior aliases instead of keeping old variants searchable

### Inbox UI

- resolved history block added to inbox
- conflict forms now include:
  - `Keep prior names as aliases`
- this means the same decision can be made:
  - through dashboard forms
  - through direct runtime HTTP API

### Graph pass

- whole-atlas layout now uses a more spread-out structural layout
- focused graph mode opens wider
- added `Untangle` control
- edge labels are reduced unless they are relevant to the current focus / selection

## Verified

- `local-brain`: `npm run check`
- `local-brain`: `npm run build`
- `brain-console`: `npm run lint`
- `brain-console`: `npm run build`
- runtime health: `GET /health`

## Live proof

### Gummi

- `Gumi` and `Gumee` were previously surfaced as a cross-lane conflict
- canonical resolved to `Gummi`
- history now shows that merge

### 2Way strict brand mode

Direct API call:

- `POST /ops/identity-conflicts/resolve`
- `canonical_name = "2Way"`
- `preserve_aliases = false`

Result:

- both lanes now use canonical `2Way`
- alias table now contains only `2Way`
- `Two Way` / `Two-Way` were retired from aliases

## Current operator behavior

- inbox queue only shows unresolved conflicts
- resolved decisions now appear in history
- strict brand canonical mode is available to both UI and agents through the runtime API
