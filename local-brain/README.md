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
- small TMT planner helper with query classification and year hint expansion
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
- deterministic temporal summary scaffolding (`day`/`week`/`month`)
- deterministic relationship adjudication into `relationship_memory`
- deterministic semantic forgetting/decay loop with archival thresholds

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

- native PostgreSQL full-text search drives the lexical branch
- `semantic_memory` and embedded `artifact_derivations` drive the vector branch
- RRF fusion runs in the app today
- if no embedding provider or query embedding is available, search degrades safely to lexical-only
- time-bounded queries infer a temporal planning window and bias episodic plus temporal summaries ahead of flatter lexical hits
- time-windowed queries bias historical episodic evidence above speculative candidate rows

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

MCP server:

```bash
cd /Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain
npm run build && node dist/cli/mcp.js
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

Allowlists are comma-separated IDs. Leave them empty to allow all channels/users.
Slack requests also enforce a 5 minute replay window when signing validation is enabled.

This is the current safe path for images and PDFs:

- register the binary as durable evidence
- attach caption / OCR / extraction text as a derivation
- search the derivation text with provenance back to the raw file
- add provider-backed embeddings later when keys and provider behavior are verified

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

- ParadeDB / BM25-native indexing
- SQL-first fused hybrid retrieval kernel
- automatic OCR / caption / transcription jobs for binary artifacts
- fully automated `pgai` vectorizer ownership beyond controlled sidecar evaluation
- provider-backed multimodal derivation execution against a real external AI endpoint
- signed Slack/Discord production deployments with allowlists, attachment auth, and retry hardening
- ParadeDB BM25 remains the next lexical upgrade; today the honest branch is native PostgreSQL FTS plus vector RRF
- LLM adjudication for relationship and conflict refinement
