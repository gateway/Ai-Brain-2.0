# Ingestion Worker Contracts

## Purpose

Define the contract between incoming data and the local brain.

## Worker Responsibilities

- preserve raw artifacts
- extract text
- fragment content
- enrich metadata
- request embeddings
- write episodic rows
- stage candidate memories

## OpenClaw-Style Markdown Ingestion

If a tool like OpenClaw writes markdown session files on disk, the local brain
should ingest them directly.

Recommended pattern:

- use a file watcher for low-latency ingestion
- also run a periodic reconciler scan so missed filesystem events do not create
  blind spots
- register each discovered file as an artifact
- compute a checksum or content hash for idempotency
- if a file changes later, treat that as a new observed version rather than
  mutating history in place

Important:

- markdown remains the human-readable evidence layer
- the database remains the machine-readable memory and reasoning layer

## Input Contract

The worker must accept:

- `source_type`
- `namespace_id`
- `input_uri` or payload
- `captured_at`
- optional metadata

Supported source types:

- `markdown`
- `text`
- `audio`
- `transcript`
- `pdf`
- `image`
- `project_note`
- `chat_turn`
- `markdown_session`

## Output Contract

The worker must produce:

- artifact registry row
- artifact version or changed-observation record where relevant
- extracted text or transcript
- fragment list
- provenance metadata
- episodic inserts
- candidate-memory records where justified

## Fragment Contract

Each fragment should carry:

- `artifact_id`
- `artifact_version`
- `fragment_index`
- `text`
- `char_start`
- `char_end`
- `speaker`
- `occurred_at`
- `namespace_id`
- `tags`
- `importance_score`
- `content_hash`

## Embedding Contract

The embedding adapter should accept:

- `fragment_id`
- `text`
- `model_provider`
- `model_name`

And return:

- embedding vector
- dimension
- provider metadata

## Failure Rules

If enrichment fails:

- preserve the artifact
- preserve extracted text if available
- mark the job partially complete
- never discard the raw source

## Idempotency Rules

The worker should be safe to retry.

Use:

- checksums
- source identifiers
- dedupe guards
- artifact versioning

## First Build Scope

The first implementation should support:

- markdown
- markdown session files from external tools
- transcript text
- chat turns
- project notes

Audio and PDF can follow immediately after the base loop is working.
