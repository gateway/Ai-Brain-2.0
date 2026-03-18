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
- deterministic temporal summary scaffolding (`day`/`week`/`month`)
- deterministic semantic decay/forgetting pass
- a simple HTTP runtime surface
- a reproducible evaluation harness
- provider adapter scaffolding (OpenRouter/Gemini) with a smoke test CLI
- external AI provider scaffolding for derivation and embeddings
- text-proxy derivations for captions / OCR / extracted notes
- durable derivation job queue for OCR / transcription / caption / summary work
- live Slack/Discord receivers with env-gated signatures and allowlists

## One-Time Setup

1. Start PostgreSQL 18.
2. Create the local database:
   - `/opt/homebrew/opt/postgresql@18/bin/createdb ai_brain_local`
3. Install Node dependencies:
   - `cd /Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain`
   - `npm install`
4. Apply migrations:
   - `npm run migrate`

BM25 prerequisite:

- ParadeDB `pg_search` must be installed in the local PostgreSQL 18 instance before BM25 mode will work
- default lexical mode is still native FTS

Lexical env controls:

- `BRAIN_LEXICAL_PROVIDER=fts|bm25`
- `BRAIN_LEXICAL_FALLBACK_ENABLED=true|false`

## Run A Reproducible Evaluation

```bash
cd /Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain
npm run eval
```

BM25 / ParadeDB validation run:

```bash
cd /Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain
BRAIN_LEXICAL_PROVIDER=bm25 npm run eval
```

BM25 lexical smoke:

```bash
cd /Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain
BRAIN_LEXICAL_PROVIDER=bm25 npm run search -- "Japan 2025 Sarah" --namespace personal --time-start 2025-01-01T00:00:00Z --time-end 2025-12-31T23:59:59Z
```

Expected behavior:

- same top episodic result as default FTS on the current benchmark set
- no results for clearly unknown lexical probes
- active-truth preference lookups still resolve cleanly

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

Hybrid search example:

```bash
cd /Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain
OPENROUTER_API_KEY=... npm run search -- "Kyoto shrine companion notes" --namespace personal --provider openrouter --model text-embedding-3-small --dimensions 1536
```

## Ingest OpenClaw-Style Files

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
- ParadeDB BM25 is now available behind `BRAIN_LEXICAL_PROVIDER=bm25`, but it is not the default yet
- the procedural/current-truth branch still uses an FTS bridge even in BM25 mode because that behavior is currently more reliable than pure BM25 for state rows
- relationship extraction is still heuristic; adjudication is deterministic threshold/rule-based (no LLM judge yet)
- raw binary artifacts are stored, and the new derivation queue is the safe path for OCR/transcription/caption work when no live external service is connected
- the current safe multimodal path is artifact registration plus queued derivation jobs, with embeddings handled as a second queued stage
- relative-time resolution is still limited
- time-bounded queries now infer year windows and include temporal summaries when useful, but explicit parent-child TMT links are still the next structural step

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
