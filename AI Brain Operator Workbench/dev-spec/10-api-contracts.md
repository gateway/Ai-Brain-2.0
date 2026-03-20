# 10 — API Contracts

## Goal

Define how the operator app should talk to the brain runtime and, where appropriate, the external model runtime.

## Contract design principles

- JSON over HTTP where possible
- multipart form-data for file uploads and audio
- explicit session IDs in operator-facing workflows
- all mutation responses should include updated status and references
- long-running work should return a job/run record, not just a fire-and-forget message

## Brain runtime contract additions/recommendations

The brain already exposes endpoints such as:
- `GET /health`
- `GET /ops/overview`
- `GET /search`
- `GET /timeline`
- `GET /relationships`
- `GET /artifacts/:id`
- `POST /ingest`
- `POST /consolidate`
- `POST /derive/text`
- `POST /derive/provider`
- `POST /derive/queue`
- `POST /classify/text`
- `POST /classify/derivation`

For the operator app, add or standardize a session-facing layer.

## Recommended session endpoints

### `POST /ops/sessions`
Create session.

Request:
```json
{
  "title": "Steve background intake",
  "notes": "Personal history session",
  "tags": ["bio", "people"],
  "default_asr_model": "Qwen/Qwen3-ASR-1.7B",
  "default_llm_model": "unsloth/Qwen3.5-35B-A3B-GGUF",
  "default_llm_preset": "research-analyst"
}
```

Response:
```json
{
  "session": {
    "id": "uuid",
    "status": "draft"
  }
}
```

### `GET /ops/sessions`
List sessions with pagination/filtering.

### `GET /ops/sessions/:sessionId`
Get session detail.

### `PATCH /ops/sessions/:sessionId`
Update title, notes, tags, defaults.

## Intake endpoints

### Option A — session-aware ingest wrapper
Preferred.

#### `POST /ops/sessions/:sessionId/intake/text`
Request:
```json
{
  "label": "Pasted notes",
  "text": "Long source text here...",
  "run_classification": true,
  "classification": {
    "model": "unsloth/Qwen3.5-35B-A3B-GGUF",
    "preset_id": "research-analyst",
    "system_prompt": null
  }
}
```

Response:
```json
{
  "session_id": "uuid",
  "input_id": "uuid",
  "ingest_job": { "id": "uuid", "status": "queued" },
  "classification_job": { "id": "uuid", "status": "queued" }
}
```

#### `POST /ops/sessions/:sessionId/intake/files`
Multipart:
- files[]
- metadata JSON field
- optional model options

Response:
```json
{
  "session_id": "uuid",
  "accepted": [
    { "input_id": "uuid", "file_name": "a.wav", "status": "queued" }
  ],
  "rejected": [
    { "file_name": "weird.bin", "reason": "unsupported mime type" }
  ]
}
```

#### `POST /ops/sessions/:sessionId/intake/audio-recording`
Multipart or upload-first approach.

## Review endpoints

### `GET /ops/sessions/:sessionId/review`
Return:
- entities
- relationship candidates
- claims
- summaries
- unresolved counts
- model run summaries

### `GET /ops/sessions/:sessionId/clarifications`
Return review items list.

### `GET /ops/review-items/:id`
Return one item with evidence and suggestions.

## Correction endpoints

### `POST /ops/review-items/:id/resolve`
Request examples:

#### Link to existing entity
```json
{
  "action": "link_existing_entity",
  "target_entity_id": "uuid",
  "note": "Uncle resolves to John Smith"
}
```

#### Create new entity
```json
{
  "action": "create_new_entity",
  "entity_type": "person",
  "canonical_label": "John Smith",
  "aliases": ["uncle"],
  "note": "Mentioned as maternal uncle"
}
```

#### Reject match
```json
{
  "action": "reject_match",
  "note": "Different person"
}
```

Response:
```json
{
  "review_item_id": "uuid",
  "status": "queued_for_reprocessing",
  "job": { "id": "uuid", "status": "queued" }
}
```

## Graph endpoints

### `GET /ops/sessions/:sessionId/graph`
Return initial session graph.

Suggested response:
```json
{
  "nodes": [
    { "id": "e1", "label": "Steve", "type": "person", "confidence": 0.98 }
  ],
  "edges": [
    { "id": "r1", "source": "e1", "target": "e2", "type": "friend_of", "confidence": 0.74 }
  ],
  "meta": {
    "session_scope": true,
    "node_count": 12,
    "edge_count": 18
  }
}
```

### `GET /ops/graph/node/:nodeId/neighbors`
Params:
- `session_id` optional
- `limit`
- `depth=1`

## Timeline endpoints

### `GET /ops/sessions/:sessionId/timeline`
Return ordered evidence and summaries.

## Query endpoints

### `POST /ops/query/search`
### `POST /ops/query/timeline`
### `POST /ops/query/sql`

#### SQL request example
```json
{
  "session_id": "uuid",
  "sql": "select * from some_safe_view limit 100"
}
```

SQL response:
```json
{
  "columns": ["id", "label"],
  "rows": [["1", "Steve"]],
  "row_count": 1,
  "duration_ms": 14
}
```

Unsafe response:
```json
{
  "error": "Only read-only SELECT queries are allowed."
}
```

## Model lab endpoints

The app may call model runtime directly from app backend or secure client path.

### `GET /models/runtime`
Proxy to `/v1/models`

### `GET /models/runtime/presets`
Proxy to `/v1/llm/presets`

### `POST /models/runtime/load`
### `POST /models/runtime/unload`
### `POST /models/runtime/asr-test`
### `POST /models/runtime/chat-test`
### `POST /models/runtime/embeddings-test`

## Standard response envelope recommendation

For app-owned endpoints, use a consistent envelope:

```json
{
  "ok": true,
  "data": {},
  "error": null,
  "meta": {}
}
```

For errors:
```json
{
  "ok": false,
  "data": null,
  "error": {
    "code": "QUERY_NOT_ALLOWED",
    "message": "Only read-only SELECT queries are allowed."
  },
  "meta": {}
}
```

## Job status contract

For long-running work, provide:
- job id
- type
- status
- started_at
- finished_at
- retryable boolean
- error summary

## Validation rules

- all input payloads validated with Zod or equivalent
- all file uploads checked for size/type limits
- all classification JSON parsed and schema-validated
- all query SQL passed through read-only validator

## Contract recommendation summary

Build a thin, explicit `ops/*` API surface for the operator app so the frontend does not have to guess how to connect sessions, artifacts, jobs, and review items together.
