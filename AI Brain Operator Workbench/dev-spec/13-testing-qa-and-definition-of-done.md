# 13 — Testing, QA, and Definition of Done

## Goal

Define what engineering must test and what “done” means.

## Test levels

### 1. Unit tests
Test:
- validators
- reducers/state helpers
- SQL safety checker
- request builders
- response parsers
- classification JSON parser
- review item action mappers

### 2. Integration tests
Test:
- app server ↔ brain runtime calls
- app server ↔ model runtime calls
- session create/update flows
- file upload forwarding
- ASR flow
- classification flow
- correction submission flow
- graph data fetch
- query workbench safety

### 3. End-to-end tests
Test complete workflows:
- create session + paste text + classify + review
- create session + upload audio + ASR + classify + graph
- resolve clarification + reprocess + inspect updated session
- run safe SQL query
- load/unload model in model lab

## Required test scenarios

## A. Session workflows

### A1. Create session
Expected:
- session saved
- appears in sessions list
- default status correct

### A2. Update session
Expected:
- notes/tags persist
- updated timestamp changes

## B. Text intake workflows

### B1. Paste text and ingest
Expected:
- text preserved
- ingest request succeeds
- review items appear or empty state shown

### B2. Paste invalid/empty text
Expected:
- validation error
- no request sent

## C. Audio workflows

### C1. Upload audio and transcribe
Expected:
- artifact uploaded
- ASR request succeeds
- transcript visible
- metadata visible

### C2. Record audio in browser
Expected:
- permission flow handled
- recording saved
- submit works

### C3. ASR runtime unavailable
Expected:
- clear failure
- session remains intact
- retry path exists

## D. File workflows

### D1. Mixed upload with supported and unsupported files
Expected:
- supported files proceed
- unsupported files marked clearly
- session not broken

### D2. PDF/image without derive adapter
Expected:
- artifact stored
- status shows awaiting adapter
- no fake success on derive

## E. Classification workflows

### E1. Valid classification JSON
Expected:
- model run stored
- parsed candidates visible
- review items visible

### E2. Invalid classification JSON
Expected:
- parse failure recorded
- operator sees failure
- no broken state in session

## F. Clarification workflows

### F1. Resolve alias conflict
Expected:
- action stored
- item status changes
- reprocessing optionally queued

### F2. Create new entity from kinship placeholder
Expected:
- resolution stored
- reprocess possible
- graph updates after completion

### F3. Stale review item submit
Expected:
- conflict warning
- refresh prompt

## G. Graph workflows

### G1. Load initial session graph
Expected:
- session-scoped nodes/edges load
- detail drawer works

### G2. Expand node
Expected:
- incremental fetch works
- graph stays responsive

## H. Query workflows

### H1. Run safe SELECT query
Expected:
- results render
- duration shown

### H2. Run unsafe query
Expected:
- rejected before execution
- clear message

## I. Model lab workflows

### I1. Fetch models
Expected:
- runtime status visible

### I2. Load and unload model
Expected:
- action succeeds or clear error
- status refreshes

### I3. Run chat test
Expected:
- response visible
- payload visible in debug mode

## Regression checklist

Before release, verify:
- session subnav links work
- browser refresh does not lose core state
- upload queue survives minor route changes if intended
- graph filters persist per page session if intended
- no accidental write SQL allowed
- permissions gate query/model pages correctly
- raw artifacts are still inspectable
- correction actions are auditable

## Manual QA checklist

- create multiple sessions
- ingest same person with two spellings
- confirm clarification appears
- resolve it
- rerun/reprocess
- check graph update
- run search and SQL to confirm result
- inspect audit log

## Definition of done — engineering

Engineering work is done when:
- all required pages exist
- core workflows are wired
- critical validation and safety checks exist
- test coverage exists for important logic
- errors are surfaced clearly
- env/config is documented
- no blocker bugs remain in core flows

## Definition of done — product/MVP

MVP is done when a real operator can:

1. create a session
2. ingest text or audio
3. see derived text/transcript
4. see extracted review items
5. resolve at least one ambiguity item
6. trigger follow-up processing
7. inspect graph and query results
8. understand failures without asking engineering

## Release checklist

- env vars documented
- migration steps documented
- sample data or test session documented
- basic operator guide written
- fallback behavior for unavailable OCR/vision documented
