# 05 — Functional Spec: Intake and Sessions

## Goal

Define exactly how session creation and intake should work.

## Session definition

A **session** is a bounded operator-run ingestion context.

A session groups:
- one or more operator inputs
- uploaded artifacts
- derivations
- model runs
- staged review items
- clarifications
- operator actions
- graph state snapshots or summaries

## Session fields

Minimum required fields:
- `id`
- `title`
- `status`
- `created_at`
- `updated_at`
- `created_by`
- `notes`
- `tags`
- `default_asr_model` nullable
- `default_llm_model` nullable
- `default_llm_preset` nullable
- `default_embedding_model` nullable

Suggested statuses:
- `draft`
- `intake_in_progress`
- `awaiting_review`
- `clarifications_open`
- `reprocessing`
- `completed`
- `failed`
- `archived`

## Intake modes

### 1. Paste text
Operator pastes text into a multiline field.

Required behaviors:
- character count
- basic validation
- preserve original text
- allow optional title/label for the input
- optional run classification toggle

### 2. Record audio
Operator records audio directly in browser.

Required behaviors:
- request mic permission
- start/stop recording
- show waveform or timer
- preview playback before submit
- allow delete/re-record
- capture mime type and duration if possible

### 3. Upload audio
Operator uploads one or more audio files.

Supported behaviors:
- drag/drop
- browse select
- queue multiple files
- show upload progress
- show file metadata

### 4. Upload PDF/image/text/mixed files
Operator uploads a mixed set of files.

Required behaviors:
- type detection
- supported/unsupported labeling
- per-file status
- retry failed upload
- clear explanation for files awaiting OCR/vision support

## Intake page layout

Recommended layout:

### Left/main column
- session title/notes summary
- tabs or cards for input mode
- upload queue
- submit controls

### Right/sidebar
- selected models and presets
- ingest options
- classify options
- estimated pipeline actions
- latest run statuses

## Pipeline options on intake page

Recommended controls:
- `Run ingest`
- `Run classification after ingest`
- `Run ASR for audio`
- `Save raw artifact only`
- `Run embeddings after text derivation` optional/hidden for MVP
- model selectors
- prompt preset selector
- advanced toggle for engineers

## Processing rules by input type

## Text input rules
When text is submitted:
1. create input record
2. register source as text artifact or text input
3. call brain ingest
4. persist operator request metadata
5. optionally call classify
6. update session status

## Audio input rules
When audio is submitted:
1. upload artifact
2. register with session
3. trigger ASR through brain/provider adapter
4. store ASR output
5. attach transcript derivation
6. ingest transcript text
7. optionally classify transcript
8. update session state

## PDF/image rules
When PDF/image is submitted:
1. upload raw artifact
2. register with session
3. if OCR/vision derive path exists, queue derive
4. if no derive path exists, mark artifact as `awaiting_supported_derivation`
5. do not pretend ingest succeeded if no text proxy exists
6. still allow artifact preview and later re-run

## Multi-file session rules

If multiple files are uploaded:
- each file has its own artifact status
- a session can be partially successful
- the session status should reflect aggregate state but not hide file-level outcomes
- operators can continue reviewing successful files while failed ones are retried

## Session overview requirements

After any intake activity, the overview page must show:

- session metadata
- count of raw inputs
- count of artifacts
- count of derived text outputs
- count of model runs
- count of open review items
- count of open clarifications
- session status
- last job outcome
- quick links to graph, review, query

## Artifact requirements

For every artifact, capture:
- artifact id
- file name
- mime type
- size
- source kind
- uploaded at
- current processing status
- derivation status
- preview availability
- linked session id

Suggested artifact statuses:
- `uploaded`
- `queued`
- `processing`
- `derived`
- `classified`
- `review_ready`
- `failed`
- `unsupported`
- `awaiting_adapter`

## Job tracking requirements

Every pipeline step should create a job or run record with:
- session id
- artifact/input id
- job type
- status
- started at
- finished at
- endpoint used
- model used if applicable
- error summary
- raw request/response reference if retained

## Ingest acceptance criteria

### Session creation
- operator can create session with required fields only
- session is visible in list immediately

### Text submit
- pasted text is preserved
- ingest request is issued
- success/failure shown
- review page is populated when ready

### Audio submit
- audio can be recorded or uploaded
- audio is persisted as raw artifact
- ASR output is available
- transcript is attached
- session can be reviewed

### Mixed upload
- multiple files can be uploaded in one session
- per-file status is visible
- unsupported items do not break supported ones

### Errors
- operators can tell which step failed
- they can retry the failed step where reasonable

## Nice-to-have enhancements

- bulk tagging of inputs
- session duplication
- import from folder
- chunk preview during ingest
- automatic language detection badge on transcript
