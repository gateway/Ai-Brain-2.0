# 04 — Routes, Pages, and User Flows

## Information architecture

Recommended top-level routes:

- `/`
- `/sessions`
- `/sessions/new`
- `/sessions/[sessionId]`
- `/sessions/[sessionId]/overview`
- `/sessions/[sessionId]/intake`
- `/sessions/[sessionId]/artifacts`
- `/sessions/[sessionId]/text`
- `/sessions/[sessionId]/review`
- `/sessions/[sessionId]/clarifications`
- `/sessions/[sessionId]/graph`
- `/sessions/[sessionId]/timeline`
- `/sessions/[sessionId]/query`
- `/models`
- `/settings`
- `/audit`

## Route purpose

### `/`
Landing/dashboard with:
- recent sessions
- runtime health
- queued jobs
- open clarification counts
- model runtime status

### `/sessions`
List of all sessions with:
- title
- created date
- status
- number of inputs
- number of artifacts
- open review items
- open clarifications
- last updated

### `/sessions/new`
Create a session with:
- title
- description/notes
- tags
- optional default model settings

### `/sessions/[sessionId]/overview`
Session summary page showing:
- session metadata
- input summary
- job timeline
- derived outputs summary
- key entities
- key relationships
- open review items
- latest graph snapshot metrics

### `/sessions/[sessionId]/intake`
Intake workspace:
- text paste
- audio record
- file upload
- model run options
- submit buttons
- upload/progress indicators

### `/sessions/[sessionId]/artifacts`
Artifact browser:
- raw files
- derivation files
- mime type
- status
- preview where possible
- provenance details

### `/sessions/[sessionId]/text`
Text/transcript view:
- derived transcript
- OCR text
- chunk list
- source-to-text mapping
- copy/export options

### `/sessions/[sessionId]/review`
Reviewable system output:
- extracted entities
- candidate relationships
- claims
- summary blocks
- unresolved items
- confidence values
- model-run provenance

### `/sessions/[sessionId]/clarifications`
Operator correction center:
- aliases
- duplicate candidates
- unknown kinship terms
- unresolved references
- confidence mismatches
- merge/reject/create-new-entity actions

### `/sessions/[sessionId]/graph`
Graph explorer:
- initial session graph
- node expansion
- filters
- provenance sidebar
- edge detail drawer

### `/sessions/[sessionId]/timeline`
Time-oriented session view:
- chronological evidence
- derived summaries
- temporal grouping
- event drilldown

### `/sessions/[sessionId]/query`
Read-only workbench:
- search
- timeline query
- safe SQL
- result tables
- saved queries

### `/models`
Model lab and runtime inspector:
- discover supported models
- view loaded models
- load/unload
- prompt presets
- quick ASR test
- quick classify test
- quick embeddings test

### `/settings`
Environment and preferences:
- default endpoints
- model defaults
- role permissions if any
- feature flags

### `/audit`
Operator and system audit log:
- session actions
- review submissions
- reprocessing triggers
- query executions
- errors

## Primary user flows

## Flow A — Create session and ingest text

1. Operator goes to `/sessions/new`
2. Creates session
3. App redirects to `/sessions/[sessionId]/intake`
4. Operator pastes text
5. Operator selects optional classify checkbox and preset/model
6. Operator clicks submit
7. App shows:
   - upload/submit progress
   - ingest status
   - classify status if selected
8. On success, operator lands on `/sessions/[sessionId]/overview` or review page

### Acceptance
- session record exists
- source text is preserved
- brain ingest completed or clear error shown
- review data is accessible

## Flow B — Record audio and transcribe

1. Operator opens intake page
2. Clicks record
3. Records audio
4. Stops and reviews playback
5. Clicks submit
6. App uploads audio artifact
7. Brain triggers ASR
8. Transcript appears in text page
9. Optional classify runs
10. Review items populate

### Acceptance
- audio artifact stored
- ASR JSON stored or accessible
- transcript attached to session
- operator can inspect segment/word metadata if available

## Flow C — Upload multiple files

1. Operator drags in mixed files
2. App validates type and size
3. Files enter upload queue
4. App shows per-file statuses
5. Brain registers artifacts
6. Supported derivations run
7. Unsupported files are marked clearly
8. Operator can continue with successful files

### Acceptance
- queue UX is clear
- per-file failure does not destroy whole session
- session overview reflects mixed outcomes

## Flow D — Resolve clarification item

1. Operator opens session clarifications
2. Selects unresolved item
3. Reviews evidence and candidate options
4. Chooses:
   - link to existing entity
   - create new entity
   - alias existing
   - reject match
   - fill in missing name/label
5. Submits resolution
6. App shows new status
7. Brain queues reprocessing if required
8. Updated graph/review appears after completion

### Acceptance
- resolution is persisted
- action is auditable
- reprocessing state is visible
- item leaves open queue or changes status appropriately

## Flow E — Explore graph

1. Operator opens graph page
2. Initial graph loads using session-scoped entities/edges
3. Operator clicks a node
4. Sidebar shows details and provenance
5. Operator expands neighbors
6. Operator filters by type or confidence
7. Operator can reset graph

### Acceptance
- graph loads from session context
- expansions do not freeze the UI
- provenance is visible for nodes/edges

## Flow F — Use read-only query workbench

1. Operator opens query page
2. Runs search/timeline or SQL query
3. Results display in table/list form
4. Operator can save the query
5. Query history is auditable

### Acceptance
- only safe queries execute
- bad SQL is rejected with clear message
- results can be tied back to session if applicable

## Navigation rules

### Session subnav
Every session route should have a consistent session subnav:
- Overview
- Intake
- Artifacts
- Text
- Review
- Clarifications
- Graph
- Timeline
- Query

### Global nav
Top nav recommended:
- Sessions
- Models
- Audit
- Settings

## Empty states

Each primary page must have:
- clear no-data state
- primary CTA
- explanation of why nothing is shown yet

## Loading states

Each data-heavy page must support:
- skeleton state
- partial data state
- retry action on failure

## Route guards

Suggested route guards:
- query page only for permitted roles
- models page only for permitted roles
- audit/settings only for admin/engineer roles if role system exists
