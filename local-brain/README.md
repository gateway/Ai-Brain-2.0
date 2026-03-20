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
- deeper TMT planner with query classification, year/month/day window expansion, deterministic descendant layer order, and sufficiency gating
- preference supersession into semantic and procedural memory
- timeline and relationship CLI queries
- webhook producer ingestion (generic/slack/discord payload adapters)
- live Slack event receiver (`POST /producer/slack/events`)
- live Discord relay receiver (`POST /producer/discord/events`)
- provider adapter scaffolding for OpenRouter and Gemini
- provider adapter scaffolding for a generic external AI endpoint
- provider-backed structured text classification into staged candidates and ambiguities
- binary artifact registration for image / pdf / audio evidence
- text-proxy derivations for searchable captions / OCR / manual extraction notes
- durable derivation job queue for OCR / transcription / caption / summary work
- provider-backed derivation route (`POST /derive/provider`)
- queue-first derivation route (`POST /derive/queue`)
- deterministic temporal summary scaffolding (`day`/`week`/`month`/`year`)
- parent-linked temporal nodes for the first real TMT ancestry chain
- recursive place-containment support through active relationship edges
- stronger relative-time normalization anchored to `captured_at` or prior scene context
- graph-history priors with a persisted `relationship_priors` table
- timeline and relationship ops surfaces for the console (`GET /ops/timeline`, `GET /ops/graph`)
- typed clarification inbox plus outbox-driven reprocessing for alias collisions, kinship resolution, place grounding, and misspellings
- first-class alias merge / correction route for accepted entities (`POST /ops/entities/merge`)
- namespace self profile support (`GET/POST /ops/profile/self`) so project notes can resolve `I` without restating the user identity
- deterministic relationship adjudication into `relationship_memory`
- deterministic semantic forgetting/decay loop with archival thresholds
- ParadeDB BM25 lexical branch implemented, benchmarked, and now the default lexical provider
- graph atlas UI with whole-window view by default and click-to-root exploration

This is not the full brain yet. It is the first implementation slice that
proves the substrate, schema, and file ingestion loop without Docker.

## Setup

1. Start PostgreSQL 18 locally.
2. Create a dedicated local database once:
   - `/opt/homebrew/opt/postgresql@18/bin/createdb ai_brain_local`
3. Optional for Python helper tooling:
   - create or activate a repo-local helper virtual environment
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
- default lexical mode is `bm25`
- use `BRAIN_LEXICAL_PROVIDER=fts` to force native PostgreSQL full-text for comparison/debugging
- if BM25 fails, retrieval falls back to native FTS unless fallback is disabled

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
- `brain_outbox_events`
- `identity_profiles`
- `namespace_self_bindings`
- `semantic_memory`
- `semantic_decay_events`
- `procedural_memory`
- `temporal_nodes`
- `temporal_node_members`
- `narrative_scenes`
- `claim_candidates`
- `narrative_events`
- `narrative_event_members`
- `vector_sync_jobs`

## Query The Brain

Search current plus historical memory:

```bash
cd /Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain
npm run search -- "What was I doing in Chiang Mai in 2026?" --namespace personal --time-start 2026-01-01T00:00:00Z --time-end 2026-12-31T23:59:59Z
```

Provider-backed hybrid query:

```bash
cd /Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain
OPENROUTER_API_KEY=... npm run search -- "Kyoto shrine companion notes" --namespace personal --provider openrouter --model text-embedding-3-small --dimensions 1536
```

Current retrieval behavior:

- ParadeDB BM25 is the default lexical branch
- native PostgreSQL full-text remains available with `BRAIN_LEXICAL_PROVIDER=fts`
- `semantic_memory` and embedded `artifact_derivations` drive the vector branch
- RRF fusion runs in the app today
- if no embedding provider or query embedding is available, search degrades safely to lexical-only
- time-bounded queries infer a temporal planning window and bias episodic plus temporal summaries ahead of flatter lexical hits
- the planner now distinguishes year, month, and day-granularity temporal windows before retrieval
- parent-linked `temporal_nodes` plus bounded descendant episodic support now add real TMT-style context instead of only flat summary scans
- ancestor expansion is now budgeted per layer and descendant support is gated so broad year queries still get temporal context without over-expanding narrow date lookups
- temporal descent now proceeds one layer at a time (`month -> week -> day` for year-level queries) and stops early when the current evidence is already sufficient
- time-windowed queries bias historical episodic evidence above speculative candidate rows
- BM25 currently covers `episodic_memory`, `semantic_memory`, `memory_candidates`, `artifact_derivations`, and `temporal_nodes`
- `procedural_memory` stays on an FTS bridge inside BM25 mode for now, because that path is still more trustworthy for active-truth preference/state lookups
- the expanded lexical benchmark now passes `14/14` for both FTS and BM25
- BM25 no longer falls back on the seeded corpus and now stays within a small acceptable token delta versus FTS on the strengthened benchmark set
- exact relationship recall, active-truth preference recall, and narrow date lookups were all re-verified before flipping BM25 to the runtime default
- broad year queries now prefer the `year` temporal ancestor over arbitrary lower-layer temporal rows, which closes the remaining BM25/TMT mismatch on the seeded suite
- freeform narrative ingestion now surfaces clarification work instead of forcing bad edges, and the console can drive alias/kinship/place fixes back through the outbox

Operator console-backed ops endpoints:

- `GET /ops/overview`
- `GET /ops/inbox?namespace_id=...`
- `POST /ops/inbox/resolve`
- `POST /ops/inbox/ignore`
- `GET /ops/profile/self?namespace_id=...`
- `POST /ops/profile/self`
- `POST /ops/entities/merge`
- `GET /ops/timeline?namespace_id=...&time_start=...&time_end=...&limit=...`
- `GET /ops/graph?namespace_id=...&entity_name=...&time_start=...&time_end=...&limit=...`

Clarification reprocessing worker:

```bash
cd /Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain
npm run outbox:work
```

Example search with the default lexical provider:

```bash
cd /Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain
npm run search -- "Chiang Mai Gumi CTO 2026" --namespace personal --time-start 2026-01-01T00:00:00Z --time-end 2026-12-31T23:59:59Z
```

Example forced FTS comparison:

```bash
cd /Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain
BRAIN_LEXICAL_PROVIDER=fts npm run search -- "Chiang Mai Gumi CTO 2026" --namespace personal --time-start 2026-01-01T00:00:00Z --time-end 2026-12-31T23:59:59Z
```

Relationship lookup:

```bash
cd /Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain
npm run relationships -- Gumi --namespace personal --time-start 2026-01-01T00:00:00Z --time-end 2026-12-31T23:59:59Z
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

Golden-story narrative benchmark:

```bash
cd /Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain
npm run benchmark:narrative
```

This validates:

- freeform personal-story entity extraction
- relationship graph promotion
- project/spec current-truth promotion
- preference supersession
- negative-control abstention on junk entities

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

External classification provider contract:

- `POST /v1/chat/completions`
- request fields used by the brain:
  - `model`
  - `preset_id` when the provider supports preset routing
  - `system_prompt`
  - `max_tokens`
  - `messages`
- response fields used by the brain:
  - `choices[0].message.content`
  - optional `usage.prompt_tokens`
  - optional `usage.completion_tokens`
  - optional `usage.total_tokens`
  - optional provider metrics

The external classification path is intentionally staged:

- provider returns structured JSON only
- the brain writes `entities`, `relationship_candidates`, `claim_candidates`, `memory_candidates`, and ambiguity rows
- the provider does **not** write `semantic_memory`, `procedural_memory`, or `relationship_memory` directly
- low-confidence or vague items stay in the inbox path instead of becoming truth

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

The first assistant-facing slice keeps consolidation deferred and exposes a
small read-first surface plus safe candidate/state write paths.

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

Provider classification smoke check:

```bash
cd /Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain
BRAIN_EXTERNAL_AI_BASE_URL=http://127.0.0.1:8090 npm run provider:smoke -- --provider external --mode classify --preset research-analyst
```

Stage text classification into candidates:

```bash
cd /Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain
BRAIN_EXTERNAL_AI_BASE_URL=http://127.0.0.1:8090 npm run classify:text -- --namespace personal --provider external --preset research-analyst --text "Steve is friends with Gummi and works on Two-Way."
```

Or through the HTTP runtime:

```bash
curl -s -X POST http://127.0.0.1:8787/classify/text \
  -H 'content-type: application/json' \
  --data '{"namespace_id":"personal","provider":"external","preset_id":"research-analyst","text":"Steve is friends with Gummi and works on Two-Way."}'
```

The current intended production split is:

- the brain owns memory, graph state, BM25/vector retrieval, TMT, inbox/outbox, and promotion
- external providers own ephemeral inference:
  - embeddings
  - OCR / transcription / captions
  - structured extraction / classification
  - optional final reasoning
- provider outputs stay portable behind one adapter contract so a local Qwen endpoint and OpenRouter can both plug in without schema changes

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
- BM25 is now the runtime default lexical branch; native FTS remains available as an explicit override and guarded fallback
- LLM adjudication for relationship and conflict refinement
- deeper TMT descent with per-level budgets, profile/session layers, and recall gating
