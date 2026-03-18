# Local Brain

This folder is the first runnable local Brain 2.0 scaffold.

Current working slice:

- native PostgreSQL 18
- `pgvector`
- `timescaledb` sidecar hypertable for time-bounded episodic scans
- `pgvectorscale` DiskANN indexes on vector-bearing tables
- `pgai` installed and evaluated as an optional controlled vectorizer/sync layer
- runnable SQL migrations
- file-backed artifact registry
- versioned artifact observations
- markdown / markdown session / transcript / text ingestion
- atomic fragment creation
- episodic writes
- staged semantic/procedural candidate writes
- entity and relationship staging
- hybrid retrieval service with lexical fallback
- small TMT planner helper with query classification plus year/month/day window expansion
- preference supersession into semantic and procedural memory
- timeline and relationship CLI queries
- webhook producer ingestion (generic/slack/discord payload adapters)
- live Slack event receiver (`POST /producer/slack/events`)
- live Discord relay receiver (`POST /producer/discord/events`)
- provider adapter scaffolding for OpenRouter and Gemini
- provider adapter scaffolding for a generic external AI endpoint
- binary artifact registration for image / pdf / audio evidence
- text-proxy derivations for searchable captions / OCR / manual extraction notes
- durable derivation job queue for OCR / transcription / caption / summary work
- provider-backed derivation route (`POST /derive/provider`)
- queue-first derivation route (`POST /derive/queue`)
- deterministic temporal summary scaffolding (`day`/`week`/`month`/`year`)
- parent-linked temporal nodes for the first real TMT ancestry chain
- deterministic relationship adjudication into `relationship_memory`
- deterministic semantic forgetting/decay loop with archival thresholds
- ParadeDB BM25 lexical branch enabled by default with guarded fallback to native PostgreSQL FTS

This is not the full brain yet. It is the first implementation slice that
proves the substrate, schema, and file ingestion loop without Docker.

## Setup

1. Start PostgreSQL 18 locally.
2. Create a dedicated local database once:
   - `/opt/homebrew/opt/postgresql@18/bin/createdb ai_brain_local`
3. Optional for Python helper tooling:
   - `source /Users/evilone/Documents/Development/AI-Brain/ai-brain/use_brain_env.sh`
   - install/evaluate `pgai` into the current DB:
     - `pgai install -d postgresql:///ai_brain_local`
4. Install Node dependencies:
   - `cd /Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain`
   - `npm install`
5. The default database URL is:
   - `postgresql:///ai_brain_local`
6. Apply migrations:
   - `npm run migrate`

BM25 prerequisite:

- ParadeDB `pg_search` must already be installed in `ai_brain_local`
- migration `013_paradedb_bm25.sql` creates BM25 indexes, but the extension binary must exist locally first

Lexical env switches:

- `BRAIN_LEXICAL_PROVIDER=fts|bm25`
- `BRAIN_LEXICAL_FALLBACK_ENABLED=true|false`
- default lexical mode is `fts`
- if BM25 is selected and fails, retrieval falls back to native FTS unless fallback is disabled

## Ingest A File

```bash
cd /Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain
npm run ingest:file -- /absolute/path/to/file.md --source-type markdown_session --namespace personal --source-channel openclaw
```

Supported first-slice source types:

- `markdown`
- `markdown_session`
- `transcript`
- `text`
- `image`
- `pdf`
- `audio`

The worker currently expects a file-backed `inputUri`. That is intentional for
the first slice so every memory fragment has durable provenance.

For binary evidence (`image`, `pdf`, `audio`), the current behavior is:

- register the artifact and observation safely
- keep the raw file as source of truth
- do not force fake text chunks during ingestion
- wait for a later text-proxy derivation step

## Ingest A Webhook Event

The webhook producer writes durable files first, then calls the same ingest
pipeline:

- raw payload: `.json`
- normalized text event: `.md`

Default location: `./producer-inbox/<provider>/<date>/...`

```bash
cd /Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain
npm run ingest:webhook -- ./examples/webhook/slack-message.json --provider slack --namespace personal --source-channel slack:dm
```

HTTP endpoint:

```bash
POST /producer/webhook
{
  "namespace_id": "personal",
  "provider": "slack",
  "source_channel": "slack:dm",
  "payload": { ... }
}
```

Raw source text is preserved in artifacts, chunks, and episodic memory.
Any first-person to third-person normalization is intentionally deferred to
later semantic promotion and consolidation stages.

For explicit content-time mentions like `June 2025`, the fragmenter now
infers a conservative `occurred_at` value. Relative expressions like
`three months later` are not fully resolved yet.

## What It Writes

- `artifacts`
- `artifact_observations`
- `artifact_chunks`
- `artifact_derivations`
- `derivation_jobs`
- `episodic_memory`
- `episodic_timeline`
- `memory_candidates`
- `entities`
- `entity_aliases`
- `memory_entity_mentions`
- `relationship_candidates`
- `relationship_memory`
- `relationship_adjudication_events`
- `semantic_memory`
- `semantic_decay_events`
- `procedural_memory`
- `temporal_nodes`
- `temporal_node_members`
- `vector_sync_jobs`

## Query The Brain

Search current plus historical memory:

```bash
cd /Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain
npm run search -- "Japan 2025 Sarah" --namespace personal --time-start 2025-01-01T00:00:00Z --time-end 2025-12-31T23:59:59Z
```

Provider-backed hybrid query:

```bash
cd /Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain
OPENROUTER_API_KEY=... npm run search -- "Kyoto shrine companion notes" --namespace personal --provider openrouter --model text-embedding-3-small --dimensions 1536
```

Current retrieval behavior:

- native PostgreSQL full-text search is the default lexical branch
- ParadeDB BM25 is available with `BRAIN_LEXICAL_PROVIDER=bm25`
- `semantic_memory` and embedded `artifact_derivations` drive the vector branch
- RRF fusion runs in the app today
- if no embedding provider or query embedding is available, search degrades safely to lexical-only
- time-bounded queries infer a temporal planning window and bias episodic plus temporal summaries ahead of flatter lexical hits
- the planner now distinguishes year, month, and day-granularity temporal windows before retrieval
- parent-linked `temporal_nodes` plus bounded descendant episodic support now add real TMT-style context instead of only flat summary scans
- time-windowed queries bias historical episodic evidence above speculative candidate rows
- BM25 currently covers `episodic_memory`, `semantic_memory`, `memory_candidates`, `artifact_derivations`, and `temporal_nodes`
- `procedural_memory` stays on an FTS bridge inside BM25 mode for now, because that path is still more trustworthy for active-truth preference/state lookups
- the expanded lexical benchmark now passes `14/14` for both FTS and BM25, and BM25 no longer falls back on the seeded corpus
- BM25 is still kept opt-in because it returns a slightly larger lexical tail than FTS on the current benchmark set, so token-burn tuning is not fully settled

Example BM25 search:

```bash
cd /Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain
BRAIN_LEXICAL_PROVIDER=bm25 npm run search -- "Japan 2025 Sarah" --namespace personal --time-start 2025-01-01T00:00:00Z --time-end 2025-12-31T23:59:59Z
```

Relationship lookup:

```bash
cd /Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain
npm run relationships -- Japan --namespace personal --predicate with --time-start 2025-01-01T00:00:00Z --time-end 2025-12-31T23:59:59Z
```

Chronological timeline:

```bash
cd /Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain
npm run timeline -- --namespace personal --time-start 2025-01-01T00:00:00Z --time-end 2025-12-31T23:59:59Z
```

Consolidate preference candidates into active truth:

```bash
cd /Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain
npm run consolidate -- --namespace personal
```

Adjudicate relationship candidates into active/superseded relationship memory:

```bash
cd /Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain
npm run adjudicate:relationships -- --namespace personal --limit 200 --accept-threshold 0.6 --reject-threshold 0.4
```

Build deterministic temporal rollups:

```bash
cd /Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain
npm run summarize:temporal -- --namespace personal --layer day --lookback-days 30 --max-members 500
npm run summarize:temporal -- --namespace personal --layer year --lookback-days 800 --max-members 500
```

Planner regression test:

```bash
cd /Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain
npm run test:planner
```

Expanded lexical benchmark:

```bash
cd /Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain
npm run benchmark:lexical
```

Apply forgetting/decay on inactive non-anchor semantic memories:

```bash
cd /Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain
npm run decay:semantic -- --namespace personal --inactivity-hours 24 --decay-factor 0.995 --min-score 0.1
```

Attach a searchable text proxy to an artifact:

```bash
cd /Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain
npm run derive:attach-text -- --artifact-id <artifact_uuid> --type caption --text "Kyoto temple map from the June 2025 trip"
```

HTTP endpoint:

```bash
POST /derive/text
{
  "artifact_id": "<artifact_uuid>",
  "derivation_type": "caption",
  "text": "Kyoto temple map from the June 2025 trip",
  "embed": false
}
```

Provider-backed derivation endpoint:

```bash
POST /derive/provider
{
  "artifact_id": "<artifact_uuid>",
  "provider": "external",
  "embed": false
}
```

This currently expects a reachable external service at `BRAIN_EXTERNAL_AI_BASE_URL`.
If none is configured, the route fails cleanly and preserves the raw artifact.

Queue-first derivation endpoint:

```bash
POST /derive/queue
{
  "namespace_id": "personal",
  "artifact_id": "<artifact_uuid>",
  "artifact_observation_id": "<artifact_observation_uuid>",
  "job_kind": "ocr"
}
```

Use this when you want OCR, transcription, captioning, or summaries to stay durable and replayable even if no live external service is available.

Queue jobs are namespace-locked to the artifact they resolve, and repeat requests for the same artifact/job combination reuse the same durable row instead of spawning duplicates.

External derivation provider contract:

- `POST /v1/artifacts/derive`
- request fields:
  - `model`
  - `modality`
  - `artifact_uri`
  - `mime_type`
  - `max_output_tokens`
  - `metadata`
- response fields:
  - `contentAbstract`
  - `confidenceScore`
  - `entities`
  - `provenance.artifactUri`
  - optional provenance such as `pageNumber`, `timestampMs`, or byte offsets

Only the `external` provider currently supports multimodal `deriveFromArtifact`.
`OpenRouter` and `Gemini` are wired for embeddings here, not full local artifact derivation.

Queue worker:

```bash
cd /Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain
npm run derive:work -- --namespace personal --provider external --limit 25
```

Current worker behavior:

- claims jobs with `FOR UPDATE SKIP LOCKED`
- retries provider outages, timeouts, and transient transport failures with backoff
- fails terminal on auth and invalid-request errors
- writes finished derivations into `artifact_derivations` with provenance preserved

Optional second-stage embedding sync:

```bash
cd /Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain
npm run vector-sync:enqueue -- --namespace personal --provider external --model text-embedding-default --limit 50
npm run vector-sync:work -- --namespace personal --provider external --limit 50
```

This is the current recommended shape for multimodal memory:

- derive text first
- commit durable text proxies into `artifact_derivations`
- enqueue vector sync after the text write
- keep embeddings replayable and provider-independent from the extraction step

MCP server:

```bash
cd /Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain
npm run mcp
```

The first stdio tool surface is:

- `memory.search`
- `memory.timeline`
- `memory.get_artifact`
- `memory.get_relationships`
- `memory.save_candidate`
- `memory.upsert_state`

NotebookLM's guidance for the first assistant-facing slice was to keep
consolidation deferred and expose a small read-first surface plus safe
candidate/state write paths.

Live producer security knobs:

- `SLACK_SIGNING_SECRET`
- `SLACK_BOT_TOKEN`
- `BRAIN_SLACK_ALLOWED_TEAMS`
- `BRAIN_SLACK_ALLOWED_CHANNELS`
- `BRAIN_SLACK_ALLOWED_USERS`
- `DISCORD_BOT_TOKEN`
- `BRAIN_DISCORD_ALLOWED_GUILDS`
- `BRAIN_DISCORD_ALLOWED_CHANNELS`
- `BRAIN_DISCORD_ALLOWED_USERS`
- `BRAIN_PRODUCER_SHARED_SECRET`

Allowlists are comma-separated IDs. Leave them empty to allow all teams/guilds/channels/users.
Slack requests also enforce a 5 minute replay window when signing validation is enabled.

This is the current safe path for images and PDFs:

- register the binary as durable evidence
- attach caption / OCR / extraction text as a derivation
- search the derivation text with provenance back to the raw file
- add provider-backed embeddings as a second queued stage when keys and provider behavior are verified

Provider embedding smoke check:

```bash
cd /Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain
npm run provider:smoke -- --provider openrouter --text "local brain provider smoke test"
```

External AI endpoint smoke path:

```bash
curl -s -X POST http://127.0.0.1:8787/derive/provider \
  -H 'content-type: application/json' \
  --data '{"artifact_id":"<artifact_uuid>","provider":"external","embed":false}'
```

## Deferred

- SQL-first fused hybrid retrieval kernel
- automatic OCR / caption / transcription jobs for binary artifacts
- fully automated `pgai` vectorizer ownership beyond controlled sidecar evaluation
- provider-backed multimodal derivation execution against a real external AI endpoint remains targeted first through the `external` adapter
- signed Slack/Discord production deployments with allowlists, attachment auth, and retry hardening
- lexical defaulting now assumes ParadeDB BM25 is present locally; if it is missing or fails, the runtime falls back to native FTS
- LLM adjudication for relationship and conflict refinement
- deeper TMT descent with per-level budgets, profile/session layers, and recall gating
