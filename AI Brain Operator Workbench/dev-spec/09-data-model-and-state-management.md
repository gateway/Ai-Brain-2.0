# 09 — Data Model and State Management

## Goal

Define the data model additions and client/server state expectations needed by the operator app.

## Design principle

Use a thin app-owned schema for operator/session concerns and let the brain keep owning core memory tables.

Suggested schema for app-owned records:

- `ops.*`

## Proposed tables

## 1. `ops.ingestion_sessions`
Purpose: top-level session record.

Suggested columns:
- `id` UUID PK
- `title` text
- `notes` text null
- `tags` jsonb or text[]
- `status` text
- `created_by` text or UUID
- `created_at` timestamptz
- `updated_at` timestamptz
- `default_asr_model` text null
- `default_llm_model` text null
- `default_llm_preset` text null
- `default_embedding_model` text null
- `metadata` jsonb default '{}'

## 2. `ops.session_inputs`
Purpose: human-submitted source items before/alongside artifact registration.

Suggested columns:
- `id` UUID PK
- `session_id` FK
- `input_type` text
- `label` text null
- `raw_text` text null
- `file_name` text null
- `mime_type` text null
- `byte_size` bigint null
- `duration_seconds` numeric null
- `artifact_id` UUID/null
- `status` text
- `created_at` timestamptz
- `metadata` jsonb

## 3. `ops.session_artifacts`
Purpose: associate artifacts and derivation roles to session.

Suggested columns:
- `id` UUID PK
- `session_id` FK
- `artifact_id` UUID
- `role` text
- `status` text
- `derive_status` text null
- `classify_status` text null
- `created_at` timestamptz
- `metadata` jsonb

Roles:
- `raw_source`
- `transcript`
- `ocr_text`
- `caption`
- `summary`
- `search_proxy`

## 4. `ops.session_model_runs`
Purpose: track external model calls or brain provider runs.

Suggested columns:
- `id` UUID PK
- `session_id` FK
- `input_id` UUID null
- `artifact_id` UUID null
- `family` text
- `endpoint` text
- `provider_base_url` text
- `model` text
- `preset_id` text null
- `request_json` jsonb
- `response_json` jsonb null
- `status` text
- `started_at` timestamptz
- `finished_at` timestamptz null
- `metrics_json` jsonb
- `error_text` text null

## 5. `ops.session_review_items`
Purpose: unify unresolved review items for the app.

Suggested columns:
- `id` UUID PK
- `session_id` FK
- `kind` text
- `status` text
- `entity_id` UUID null
- `candidate_id` UUID null
- `source_artifact_id` UUID null
- `source_fragment_ref` text null
- `confidence` numeric null
- `title` text
- `description` text
- `evidence_json` jsonb
- `suggestions_json` jsonb
- `resolution_json` jsonb null
- `created_at` timestamptz
- `updated_at` timestamptz

## 6. `ops.session_actions`
Purpose: operator audit trail.

Suggested columns:
- `id` UUID PK
- `session_id` FK
- `actor_id` text or UUID
- `action_type` text
- `target_type` text
- `target_id` text
- `payload_json` jsonb
- `result_json` jsonb null
- `created_at` timestamptz

## 7. `ops.saved_queries`
Purpose: saved read-only search/SQL queries.

Suggested columns:
- `id` UUID PK
- `owner_id` text or UUID
- `session_id` UUID null
- `title` text
- `query_mode` text
- `query_text` text
- `metadata` jsonb
- `created_at` timestamptz
- `updated_at` timestamptz

## Relation to core brain tables

The app should link to, not replace:
- artifacts
- derivations
- episodic memory rows/chunks
- semantic/procedural candidates
- entities
- aliases
- relationships
- clarification queues
- jobs

Where the brain already has a suitable table, prefer referencing it rather than duplicating it.

## Client state model

### Server state
Use TanStack Query for:
- session lists/detail
- artifacts
- review items
- graph data
- timeline data
- query results
- runtime health
- model lists/presets

### Local UI state
Use local component state or lightweight store for:
- form drafts
- upload queue UI
- selected graph node
- graph filters
- prompt editor local content
- unsaved query text

### URL state
Use URL params for:
- active tab
- selected filters
- selected query mode
- graph node focus if useful

## Mutations

Core mutation categories:
- create/update session
- upload artifact
- submit text input
- run ASR/classification
- submit clarification resolution
- trigger reprocessing/consolidation
- run safe query
- save query
- model load/unload

## Caching strategy

Recommended query keys:
- `sessions`
- `session/{id}`
- `session/{id}/artifacts`
- `session/{id}/review`
- `session/{id}/clarifications`
- `session/{id}/graph`
- `session/{id}/timeline`
- `session/{id}/query/{mode}`
- `models`
- `llm-presets`

On successful mutation, invalidate targeted session keys.

## Concurrency considerations

### Review items
Use optimistic concurrency via:
- `version` column or
- `updated_at` check

### Session updates
Simple last-write-wins may be acceptable for notes/tags in MVP, but review item resolution should be guarded.

## Suggested enums

### Session status
- `draft`
- `intake_in_progress`
- `awaiting_review`
- `clarifications_open`
- `reprocessing`
- `completed`
- `failed`
- `archived`

### Review item status
- `open`
- `in_review`
- `resolved`
- `rejected`
- `deferred`
- `queued_for_reprocessing`
- `reprocessed`

### Model run status
- `queued`
- `running`
- `succeeded`
- `failed`
- `canceled`

## Migration recommendation

Introduce app-owned ops tables in a separate migration group so they can evolve without destabilizing the core brain schema.
