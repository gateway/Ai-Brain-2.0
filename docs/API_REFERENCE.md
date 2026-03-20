# API Reference

This document is the public-facing HTTP reference for the current `local-brain` runtime.

Base local runtime:

- `http://127.0.0.1:8787`

All responses are JSON unless noted otherwise.

## Health

### `GET /health`

Returns basic runtime health.

### `GET /ops/maintenance`

Returns whether the runtime is currently in maintenance mode because a replay or scale benchmark is holding the advisory lock.

## Sessions

### `POST /ops/sessions`

Create a new operator session.

### `GET /ops/sessions`

List recent sessions.

### `GET /ops/sessions/:sessionId`

Fetch one session.

### `PATCH /ops/sessions/:sessionId`

Update session metadata and default provider/model settings.

### `POST /ops/sessions/:sessionId/intake/text`

Ingest typed text into a session and optionally run classification.

### `POST /ops/sessions/:sessionId/intake/file`

Ingest one file into a session and optionally run ASR and classification.

### `GET /ops/sessions/:sessionId/review`

Return structured review data for the session.

### `GET /ops/sessions/:sessionId/timeline`

Return the session-scoped timeline view.

It includes:

- the session time window
- session-linked episodic rows
- overlapping temporal summaries for that session window
- semantic summary metadata when present

## Operator Overview

### `GET /ops/overview`

High-level runtime and queue overview for the operator surfaces.

### `GET /ops/namespaces`

List namespaces and the default namespace.

### `GET /ops/bootstrap-state`

Read first-run bootstrap/setup state.

### `PATCH /ops/bootstrap-state`

Update bootstrap/setup state and metadata.

## Timeline And Graph

### `GET /ops/timeline`

Operator timeline view for a namespace and time window.

Required query params:

- `namespace_id`
- `time_start`
- `time_end`

### `GET /ops/graph`

Operator relationship graph for a namespace.

Common query params:

- `namespace_id`
- `entity_name`
- `time_start`
- `time_end`
- `limit`

## Clarifications And Identity

### `GET /ops/inbox`

Read clarification inbox items for a namespace.

### `GET /ops/ambiguities`

Read ambiguity workbench items for a namespace.

### `GET /ops/clarifications`

Read clarification items plus available action routes.

Current response shape includes:

- namespace summary totals
- ambiguity totals by type
- priority totals by level
- per-item `priority_score`
- per-item `priority_level`
- per-item `priority_label`
- per-item `priority_reasons`

This is the backend-owned ranking contract used by the workbench queue.

### `GET /ops/identity-conflicts/history`

Read identity conflict history for a namespace.

### `POST /ops/inbox/resolve`

Resolve a clarification candidate.

### `POST /ops/inbox/ignore`

Ignore a clarification candidate.

### `POST /ops/entities/merge`

Merge or alias-resolve an entity through the controlled correction path.

### `POST /ops/identity-conflicts/resolve`

Resolve a cross-entity identity conflict.

### `POST /ops/identity-conflicts/keep-separate`

Mark an identity conflict as intentionally separate.

## Self Profile

### `GET /ops/profile/self`

Read the self/owner profile for a namespace.

Required query params:

- `namespace_id`

### `POST /ops/profile/self`

Create or update the self/owner profile.

Body fields:

- `namespace_id`
- `canonical_name`
- optional `aliases`
- optional `note`

## Sources And Monitoring

### `GET /ops/sources`

List monitored/trusted sources.

### `POST /ops/sources`

Create a monitored/trusted source.

### `PATCH /ops/sources/:sourceId`

Update a monitored source.

### `DELETE /ops/sources/:sourceId`

Delete a monitored source.

### `POST /ops/sources/:sourceId/scan`

Run a source scan preview.

### `GET /ops/sources/:sourceId/preview`

Read the latest scan preview.

### `GET /ops/sources/:sourceId/files`

List discovered files for a monitored source.

### `POST /ops/sources/:sourceId/import`

Import a monitored source through the normal ingestion path.

Optional body fields:

- `trigger_type`
- `file_ids`

When `file_ids` is supplied, the runtime retries import only for those discovered source files instead of re-importing the full pending lane.

### `POST /ops/sources/process`

Run the monitored-source worker loop manually.

Body options:

- optional `source_id`
- optional `limit`
- optional `scan_only`

## Retrieval

### `GET /search`

Primary retrieval endpoint.

Common query params:

- `query`
- optional `namespace_id`
- optional `time_start`
- optional `time_end`
- optional `limit`
- optional `provider`
- optional `model`
- optional `dimensions`

Returns retrieval results plus metadata such as resolved namespace and retrieval mode.

### `GET /timeline`

Direct retrieval timeline endpoint.

### `GET /relationships`

Direct relationship lookup endpoint.

### `GET /artifacts/:id`

Fetch artifact detail.

## Ingest And Derivation

### `POST /ingest`

Ingest one artifact directly into the runtime.

### `POST /consolidate`

Run candidate consolidation for a namespace.

### `POST /derive/text`

Attach text derivation content to an artifact.

### `POST /derive/provider`

Ask a provider to derive text from an artifact.

### `POST /derive/queue`

Queue a derivation job.

### `POST /classify/text`

Classify free text into candidates, claims, relationships, and ambiguities.

### `POST /classify/derivation`

Classify an existing derivation by id.

## Producers

### `POST /producer/webhook`

Generic producer ingestion endpoint.

### `POST /producer/slack/events`

Slack live producer endpoint.

### `POST /producer/discord/events`

Discord relay producer endpoint.

## Embeddings

### `POST /ops/embeddings/test`

Test the current embeddings provider/model selection.

Useful body fields:

- `provider`
- `model`
- `dimensions`
- `normalize`
- `instruction`
- optional `text`

### `POST /ops/embeddings/rebuild`

Enqueue a namespace vector rebuild.

Useful body fields:

- `namespace_id`
- `provider`
- `model`
- `dimensions`
- `normalize`
- `instruction`

## Operations Workers

### `GET /ops/workers`

Read the compact runtime worker health snapshot used by the Dashboard and Settings pages.

It includes:

- per-worker state
- latest run metadata
- next due time
- recent failure history
- retry guidance derived from failure classification when the latest run failed or degraded

### `POST /ops/outbox/process`

Run clarification/outbox propagation manually.

### `POST /ops/temporal/process`

Run deterministic temporal summaries, and optionally the semantic LLM overlay.

Useful body fields:

- `namespace_id`
- optional `lookback_days`
- optional `layers`
- optional `strategy`
- optional `provider`
- optional `model`
- optional `preset_id`
- optional `system_prompt`

## Failure Classification

Worker failures are normalized into operator-facing categories so the UI can show actionable retry guidance.

Current categories include:

- `provider_auth`
- `provider_timeout`
- `schema_mismatch`
- `source_access`
- `runtime_dependency`
- `unknown`

## Notes

- Core brain mutation should go through these runtime endpoints, not direct database edits.
- Query/debug SQL is intentionally separate from normal memory mutation.
- Session, clarification, source monitor, and temporal summary flows are all first-class runtime behaviors.
- Worker health is now backed by a durable runtime ledger instead of only transient UI banners.
