# 03 — System Context and Architecture

## Big picture

The operator app is one surface in a larger AI Brain system.

The architecture should be:

```text
Operator App
    ↓
AI Brain HTTP Runtime
    ↓
Brain DB + artifact storage + jobs
    ↓
External model runtime(s)
```

## Core principle

The app should use the **AI Brain HTTP runtime** as its main integration boundary.

The app should not act as a second brain and should not write directly to core memory tables for normal workflows.

## Why this matters

AI Brain is already built around:

- durable artifacts
- episodic memory
- semantic/procedural candidate staging
- relationship memory
- clarification handling
- consolidation
- hybrid retrieval
- operator inspection

If the app writes directly into truth tables, it bypasses the architecture.

## Proposed subsystems

### 1. Operator App frontend
Responsibilities:
- page rendering
- form state
- upload UX
- graph visualization
- query editors
- operator review workflows

### 2. Operator App server layer
Responsibilities:
- auth/session gating
- proxying to brain/model runtime where secrets are needed
- request validation
- file forwarding
- audit event capture
- safe SQL enforcement if implemented through app backend

### 3. AI Brain runtime
Responsibilities:
- artifact registration
- ingestion
- derivation orchestration
- classification staging
- clarification creation
- consolidation
- retrieval/search/timeline/relationships
- artifact retrieval
- job tracking

### 4. External model runtime
Responsibilities:
- ASR transcription
- LLM completions for classification/summarization
- embeddings
- model discovery/load/unload

Base URL:
`http://100.99.84.124:8000/`

## Integration boundary rules

### Rule 1 — the app does not canonize memory
The app may trigger staging, correction, and reprocessing, but should not silently mark facts as final truth.

### Rule 2 — the brain owns memory policy
The brain decides how candidates are stored, promoted, superseded, or rejected.

### Rule 3 — the app may expose debug detail
The app can show raw request/response payloads and job states to operators, especially engineers.

### Rule 4 — raw artifacts remain authoritative evidence
Binary files and original text should be preserved and linked to everything derived from them.

### Rule 5 — provider integrations should be abstracted where possible
The app can have a model lab that talks to the model runtime directly, but standard ingestion should usually go through the brain runtime.

## Recommended app modules

- `sessions`
- `intake`
- `review`
- `clarifications`
- `graph`
- `timeline`
- `query`
- `models`
- `settings`
- `audit`

## Recommended backend modules

If the operator app has its own server/API layer:

- `sessions.service.ts`
- `uploads.service.ts`
- `brain-client.ts`
- `model-runtime-client.ts`
- `review-items.service.ts`
- `queries.service.ts`
- `auth.service.ts`
- `audit.service.ts`

## Runtime sequence overview

### Sequence A — text intake
1. Operator creates session
2. Operator pastes text
3. App submits to brain ingest endpoint
4. Brain writes artifact/input record
5. Brain fragments into episodic units
6. Brain optionally classifies text
7. Brain stores staged candidates
8. App loads session review data

### Sequence B — audio intake
1. Operator creates session
2. Operator records or uploads audio
3. App forwards file
4. Brain registers raw artifact
5. Brain calls model runtime `/asr/transcribe`
6. Brain stores transcript derivation
7. Brain ingests transcript text
8. Brain optionally classifies transcript
9. App loads results for review

### Sequence C — clarification correction
1. Operator opens a review item
2. Operator selects resolution action
3. App submits resolution to brain
4. Brain records review/correction event
5. Brain enqueues reprocessing or consolidation
6. App shows updated status
7. Graph/search/timeline views update after job completes

## Data boundaries

### App-owned data
The app may own supporting/operator data such as:
- session titles and notes
- saved queries
- UI preferences
- audit events
- prompt presets
- local graph layout settings

### Brain-owned data
The brain should own:
- artifacts
- derivations
- episodic/semantic/procedural memory
- entities and relationships
- candidate tables
- clarification items if they are part of core memory workflow
- job orchestration for ingest/classify/consolidate

## Read/write policy

### Allowed write paths
- create/update operator session metadata
- upload artifacts
- submit ingest/classify requests
- submit correction/review decisions
- trigger jobs
- save prompt presets or saved queries
- load/unload models in model lab if allowed

### Restricted write paths
- direct arbitrary inserts into semantic/procedural truth tables
- unrestricted graph mutation
- unrestricted relationship creation without staged path
- unrestricted SQL execution

## Recommendation on sessions

Sessions should become a first-class concept, not merely an informal grouping.

Every intake action, artifact, model run, review item, and graph expansion should be filterable by `session_id`.

## Error design principle

No opaque failures.

The app should surface:
- request failed
- runtime unreachable
- invalid model selection
- unsupported file type
- reprocessing job failed
- classification returned invalid JSON
- query rejected for safety reasons

## Architecture summary

Build the operator app as a **control and inspection surface** on top of the existing brain.

Keep:
- memory policy in the brain
- model execution in provider runtimes
- review and orchestration in the app
