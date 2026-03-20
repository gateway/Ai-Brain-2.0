# 14 — Implementation Plan and Open Questions

## Goal

Give engineering a practical phased plan and list the remaining unknowns clearly.

## Recommended phases

## Phase 1 — foundations
Build:
- app shell
- auth/network config
- session CRUD
- session list/detail
- intake UI for text and file upload
- brain runtime client
- model runtime client/proxy
- basic audit logging

Exit criteria:
- session creation and listing work
- text intake works end-to-end
- file upload plumbing exists

## Phase 2 — ASR and review
Build:
- browser audio recording
- audio upload flow
- ASR integration
- transcript/text page
- review page with candidates and unresolved items

Exit criteria:
- audio can become transcript
- transcript can become reviewable output

## Phase 3 — clarifications and corrections
Build:
- clarification page
- resolution actions
- audit trail
- reprocessing trigger/status

Exit criteria:
- operator can resolve ambiguity and observe status changes

## Phase 4 — graph and query
Build:
- session graph explorer
- node detail drawer
- timeline page
- read-only query workbench
- saved queries

Exit criteria:
- operator can inspect memory via graph and query pages

## Phase 5 — model lab and polish
Build:
- runtime status page
- presets browser
- load/unload actions
- ASR/chat/embeddings test panels
- empty/error state polish
- performance tuning

Exit criteria:
- engineering can debug provider/runtime behavior from inside app

## Suggested engineering tickets

### Sessions
- create ops session schema and migrations
- build session list page
- build session overview page
- build session update actions

### Intake
- build text intake form
- build file dropzone
- build upload queue
- wire brain ingest wrappers
- attach job/run statuses to session

### Audio
- add microphone recording
- upload recorded blob
- show audio playback and metadata
- wire ASR flow

### Review
- build review cards
- build evidence snippets
- build model-run provenance display

### Clarifications
- build review item list/detail
- implement resolution forms
- implement stale-state guard
- implement reprocessing polling/refresh

### Graph
- implement session graph fetch
- add Cytoscape canvas
- add node/edge detail drawer
- add filters and expansion

### Query
- build search mode
- build timeline mode
- build read-only SQL mode
- implement SQL safety guard
- add saved queries

### Models
- build runtime status screen
- fetch model registry and presets
- add load/unload actions
- add ASR/chat/embedding test forms

## Recommended order of hard problems

1. session identity and data model
2. text/audio end-to-end ingest
3. classification parse/storage
4. clarification resolution path
5. graph data contract
6. SQL workbench safety
7. PDF/image derive adapter story
8. embeddings-backed hints

## Open questions

### 1. Where should session records live?
Recommendation: `ops.*` schema, with links into core brain records.

### 2. Does the brain already have a clarification API strong enough for operator resolution?
If not, add thin `ops/review-items/*` endpoints.

### 3. Should the app proxy all runtime calls through its backend?
Recommendation: yes by default, especially if auth, CORS, or TailScale access is involved.

### 4. What is the exact PDF/image derive plan?
This is the biggest unresolved backend question.

Options:
- extend model runtime with OCR/vision derive endpoint
- add separate OCR service
- add brain-side adapter using another worker

### 5. Are embeddings needed in MVP UI?
Recommendation: not as a primary page. Use them later for “related memories” and duplicate hints.

### 6. How much of existing brain-console should be reused?
Engineering should inspect the current codebase before deciding:
- embed as new routes if the console architecture is clean enough
- otherwise build a separate app

### 7. What level of auth is required?
At minimum, enough to protect query/model controls and sensitive artifacts.

### 8. Should operators be able to manually create relationship edges directly?
Recommendation: no direct arbitrary edge editor in MVP. Use review/correction actions that the brain can process safely.

## Known risks

- app and brain contracts diverge if not standardized
- PDF/image capability confusion if UI implies more than backend can do
- graph overload if initial fetch is too large
- classification schema drift if prompts change without validation
- unsafe query handling if SQL guard is too naive

## Recommended immediate next steps

1. confirm whether this is a separate app or extension of `brain-console`
2. add/confirm `ops` schema and session endpoints
3. finalize classification JSON schema
4. finalize clarification resolution API
5. implement text and audio happy path first
6. defer PDF/image “full done” until derive adapter plan is chosen

## Final recommendation

Do not wait for every provider capability to be perfect.

Build the app around:
- sessions
- text/audio intake
- review
- corrections
- graph
- query

That will already make AI Brain dramatically easier to operate, debug, and demonstrate.
