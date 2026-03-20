# Local Brain Quickstart

## What This Gives You

This package currently provides:

- local PostgreSQL-backed artifact and memory storage
- TimescaleDB-backed episodic timeline hypertable
- `pgvectorscale` DiskANN indexes for vector-bearing tables
- `pgai` installed as an optional controlled vectorizer/sync layer
- file ingestion for markdown and text
- binary artifact registration for image/pdf/audio evidence
- entity and relationship staging
- hybrid search with lexical fallback
- TMT planner helper for temporal queries like `What was I doing in Japan in 2025?`
- timeline queries
- deterministic preference supersession
- deterministic relationship adjudication
- deterministic temporal summary scaffolding (`day`/`week`/`month`/`year`)
- deterministic semantic decay/forgetting pass
- a simple HTTP runtime surface
- a reproducible evaluation harness
- provider adapter scaffolding (OpenRouter/Gemini) with a smoke test CLI
- external AI provider scaffolding for derivation, embeddings, and staged classification
- text-proxy derivations for captions / OCR / extracted notes
- durable derivation job queue for OCR / transcription / caption / summary work
- live Slack/Discord receivers with env-gated signatures and allowlists

## One-Time Setup

1. Start PostgreSQL 18.
2. Create the local database:
   - `/opt/homebrew/opt/postgresql@18/bin/createdb ai_brain_local`
3. Make sure the required extension binaries are available to PostgreSQL before running migrations:
   - required baseline: `pgcrypto`, `vector`, `btree_gin`
   - current local path: `vectorscale`, `pg_search`
   - recommended: `timescaledb`
   - optional sidecar tooling: `ai` / `pgai`
4. Verify or enable the extensions inside the database:

```sql
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS btree_gin;
CREATE EXTENSION IF NOT EXISTS vectorscale CASCADE;
CREATE EXTENSION IF NOT EXISTS pg_search;
CREATE EXTENSION IF NOT EXISTS timescaledb;
-- Optional:
-- CREATE EXTENSION IF NOT EXISTS ai;
```
5. Install Node dependencies:
   - `cd /Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain`
   - `npm install`
6. Apply migrations:
   - `npm run migrate`

BM25 prerequisite:

- ParadeDB `pg_search` must be installed in the local PostgreSQL 18 instance before BM25 mode will work
- default lexical mode is BM25
- native FTS remains available with `BRAIN_LEXICAL_PROVIDER=fts` for comparison and debugging

Lexical env controls:

- `BRAIN_LEXICAL_PROVIDER=fts|bm25`
- `BRAIN_LEXICAL_FALLBACK_ENABLED=true|false`

## Run A Reproducible Evaluation

```bash
cd /Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain
npm run eval
```

Default lexical validation run:

```bash
cd /Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain
npm run eval
```

Forced FTS comparison run:

```bash
cd /Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain
BRAIN_LEXICAL_PROVIDER=fts npm run eval
```

Expected behavior:

- same or better exact lexical precision than default FTS on the current benchmark set
- no results for clearly unknown lexical probes
- active-truth preference lookups still resolve cleanly
- BM25 now clears the strengthened lexical suite without fallback and is the runtime default lexical provider
- native FTS remains available as a comparison override and guarded fallback

Outputs:

- `local-brain/eval-results/latest.json`
- `local-brain/eval-results/latest.md`

## Start The HTTP Runtime

```bash
cd /Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain
npm run serve
```

Useful endpoints:

- `GET /health`
- `GET /ops/overview`
- `GET /search`
- `GET /timeline`
- `GET /relationships`
- `GET /artifacts/:id`
- `POST /ingest`
- `POST /producer/webhook`
- `POST /producer/slack/events`
- `POST /producer/discord/events`
- `POST /consolidate`
- `POST /derive/text`
- `POST /derive/provider`
- `POST /derive/queue`
- `POST /classify/text`
- `POST /classify/derivation`
- `POST /ops/sources/process`

## Start The MCP Server

```bash
cd /Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain
npm run mcp
```

This is a stdio JSON-RPC surface intended for local assistant clients. The
first tools are:

- `memory.search`
- `memory.timeline`
- `memory.get_artifact`
- `memory.get_relationships`
- `memory.save_candidate`
- `memory.upsert_state`

Important boundary:

- MCP is the assistant/tool interface
- it is not the right place to run always-on folder monitoring
- monitored source scanning/import should run as a runtime worker or scheduled process against `local-brain`
- MCP can expose controls or inspection later, but it should not be the daemon

## Start The Operator Workbench

```bash
cd /Users/evilone/Documents/Development/AI-Brain/ai-brain
npm run dev
```

Open:

- `http://127.0.0.1:3005`

Recommended first-run order:

1. `/setup`
2. `/bootstrap`
3. `/settings`
4. `/sessions`

Use the Legacy Console only after setup is complete:

- `/console`
- `/console/query`
- `/console/eval`
- `/console/benchmark`
- `/console/jobs`
- `/console/artifacts/[id]`

For a clearer first-run path, see:

- [docs/FIRST_RUN_SETUP.md](/Users/evilone/Documents/Development/AI-Brain/ai-brain/docs/FIRST_RUN_SETUP.md)
- [docs/OPERATOR_WORKBENCH_GUIDE.md](/Users/evilone/Documents/Development/AI-Brain/ai-brain/docs/OPERATOR_WORKBENCH_GUIDE.md)

## Run Monitored Folder Imports

The monitored-source feature now has three parts:

- source records in the app
- scan/import HTTP endpoints
- a runtime worker for scheduled processing

One-shot scheduled-run simulation:

```bash
cd /Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain
npm run sources:work
```

Continuous loop from repo root:

```bash
cd /Users/evilone/Documents/Development/AI-Brain/ai-brain
BRAIN_SOURCE_MONITOR_ENABLED=true npm run dev
```

Or:

```bash
cd /Users/evilone/Documents/Development/AI-Brain/ai-brain
npm run sources:monitor
```

Current scheduling behavior:

- the worker checks `ops.monitored_sources`
- it looks for `monitor_enabled = true`
- it respects `scan_schedule`
- due sources are scanned and then imported with trigger type `scheduled`
- imported files still go through the normal ingestion/runtime path

## Run The Combined Operations Worker

If you want monitored folders, inbox propagation, and temporal summaries running together:

```bash
cd /Users/evilone/Documents/Development/AI-Brain/ai-brain
npm run ops:work
```

Or when starting the full stack:

```bash
cd /Users/evilone/Documents/Development/AI-Brain/ai-brain
BRAIN_RUNTIME_OPS_ENABLED=true npm run dev
```

This worker reads saved operations settings from bootstrap metadata and currently handles:

- source monitor runs
- outbox propagation
- deterministic temporal summary rebuilds

## Smoke Test Provider Wiring

OpenRouter:

```bash
cd /Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain
OPENROUTER_API_KEY=... npm run provider:smoke -- --provider openrouter --text "provider smoke"
```

Gemini:

```bash
cd /Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain
GEMINI_API_KEY=... npm run provider:smoke -- --provider gemini --text "provider smoke" --dimensions 1536
```

External classification:

```bash
cd /Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain
BRAIN_EXTERNAL_AI_BASE_URL=http://127.0.0.1:8090 npm run provider:smoke -- --provider external --mode classify --preset research-analyst
```

Hybrid search example:

```bash
cd /Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain
OPENROUTER_API_KEY=... npm run search -- "Kyoto shrine companion notes" --namespace personal --provider openrouter --model text-embedding-3-small --dimensions 1536
```

## Ingest OpenClaw-Style Files

This is still the recommended historical bootstrap path when you already have OpenClaw-style markdown notes or session logs.

Single file:

```bash
cd /Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain
npm run ingest:file -- /absolute/path/to/file.md --source-type markdown_session --namespace personal --source-channel openclaw
```

Whole folder:

```bash
cd /Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain
npm run reconcile:dir -- /absolute/path/to/folder --namespace personal --source-type markdown_session --source-channel openclaw
```

Webhook payload file:

```bash
cd /Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain
npm run ingest:webhook -- ./examples/webhook/slack-message.json --provider slack --namespace personal --source-channel slack:dm
```

Binary artifact:

```bash
cd /Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain
npm run ingest:file -- /absolute/path/to/file.pdf --source-type pdf --namespace personal --source-channel documents
```

Attach a searchable proxy text:

```bash
cd /Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain
npm run derive:attach-text -- --artifact-id <artifact_uuid> --type caption --text "Architecture diagram showing three memory tiers"
```

Queue a durable multimodal derivation job:

```bash
cd /Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain
npm run derive:queue -- --namespace personal --artifact-id <artifact_uuid> --provider external
npm run derive:work -- --namespace personal --provider external --limit 25
```

Queue second-stage embedding sync for derived text:

```bash
cd /Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain
npm run vector-sync:enqueue -- --namespace personal --provider external --model text-embedding-default --limit 50
npm run vector-sync:work -- --namespace personal --provider external --limit 50
```

Run the local mock external provider for multimodal tests:

```bash
cd /Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain
npm run mock:external -- --port 8090
```

Then point the brain at it:

```bash
cd /Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain
BRAIN_EXTERNAL_AI_BASE_URL=http://127.0.0.1:8090 npm run serve
```

Stage structured extraction from plain text:

```bash
cd /Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain
BRAIN_EXTERNAL_AI_BASE_URL=http://127.0.0.1:8090 npm run classify:text -- --namespace personal --provider external --preset research-analyst --text "Steve is friends with Gumee and Ben. Dan connected the Chiang Mai group. Steve is acting CTO for Two-Way."
```

Or classify an existing text derivation:

```bash
cd /Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain
BRAIN_EXTERNAL_AI_BASE_URL=http://127.0.0.1:8090 npm run classify:text -- --provider external --preset research-analyst --derivation-id <derivation_uuid>
```

External derive contract expected by the brain:

- `POST /v1/artifacts/derive`
- request:
  - `model`
  - `modality`
  - `artifact_uri`
  - `mime_type`
  - `max_output_tokens`
  - `metadata`
- response:
  - `contentAbstract`
  - `confidenceScore`
  - `entities`
  - `provenance.artifactUri`
  - optional provenance like `pageNumber`, `timestampMs`, `byteOffsetStart`, `byteOffsetEnd`

Only the `external` provider supports multimodal derivation right now.

External classify contract expected by the brain:

- `POST /v1/chat/completions`
- request:
  - `model`
  - `preset_id`
  - `system_prompt`
  - `max_tokens`
  - `messages`
- response:
  - `choices[0].message.content` as strict JSON
  - optional `usage`
  - optional `metrics`

The classifier path writes staged rows only:

- `relationship_candidates`
- `claim_candidates`
- `memory_candidates`
- ambiguity/inbox rows through `claim_candidates`

It does **not** write final truth directly.
If the provider is unreachable, queued derivation jobs retry with backoff instead of corrupting memory state.
If the provider is misconfigured or returns terminal errors, the job is marked failed cleanly and the raw artifact remains intact.

## Verified Example Queries

```bash
cd /Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain
npm run search -- "Japan 2025 Sarah" --namespace personal_refined2 --time-start 2025-01-01T00:00:00Z --time-end 2025-12-31T23:59:59Z
npm run relationships -- Japan --namespace personal_refined2 --predicate with --time-start 2025-01-01T00:00:00Z --time-end 2025-12-31T23:59:59Z
npm run consolidate -- --namespace personal_refined2
npm run adjudicate:relationships -- --namespace personal_refined2
npm run summarize:temporal -- --namespace personal_refined2 --layer week --lookback-days 120
npm run decay:semantic -- --namespace personal_refined2 --inactivity-hours 24 --decay-factor 0.995 --min-score 0.1
```

## Current Honest Limits

- retrieval is hybrid today, but the fusion kernel is still app-side
- BM25 is now the runtime default lexical branch
- ParadeDB BM25 no longer falls back on the seeded corpus and now beats FTS on token total in the strengthened benchmark
- the procedural/current-truth branch still uses an FTS bridge even in BM25 mode because that behavior is currently more reliable than pure BM25 for state rows
- relationship extraction is still heuristic; adjudication is deterministic threshold/rule-based (no LLM judge yet)
- raw binary artifacts are stored, and the new derivation queue is the safe path for OCR/transcription/caption work when no live external service is connected
- the current safe multimodal path is artifact registration plus queued derivation jobs, with embeddings handled as a second queued stage
- relative-time resolution is still limited
- time-bounded queries now infer year/month/day windows, pull parent-linked temporal ancestor context, and attach bounded descendant episodic support
- the current expanded lexical suite passes `14/14` for both FTS and BM25 on the seeded local corpus
- native FTS remains available as explicit override and guarded fallback, but BM25 is no longer feature-gated on the local track

## Live Producer Security

Set these env vars before using the live Slack/Discord receivers:

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

The MCP server is read-first and candidate/state write-safe. It is not the
consolidation engine.
