# First-Run Setup Guide

This guide is the recommended path for getting AI Brain 2.0 running from a fresh install.

It covers:

- PostgreSQL and extension readiness
- root app startup
- local runtime vs OpenRouter setup
- the in-app first-run flow
- when OpenClaw-style import is the recommended source path

## 1. Prerequisites

- macOS with PostgreSQL 18 available locally
- Node.js and npm
- this repository checked out locally

Repo root:

```bash
cd /Users/evilone/Documents/Development/AI-Brain/ai-brain
```

## 2. Install JavaScript dependencies

```bash
npm install
npm install --workspace local-brain
npm install --workspace brain-console
cp .env.example .env
```

## 3. Prepare PostgreSQL

Create the local database once:

```bash
/opt/homebrew/opt/postgresql@18/bin/createdb ai_brain_local
```

The baseline database needs these extensions available to Postgres:

- `pgcrypto`
- `vector`
- `btree_gin`

The current full local path also expects these extension binaries to be installed before migrations:

- `vectorscale`
- `pg_search`

Optional but recommended for the richer time-series path:

- `timescaledb`

Optional for controlled sidecar experiments:

- `ai` / `pgai`

Useful verification SQL:

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

You can see the extension expectations in:

- [local-brain/migrations/001_extensions.sql](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/migrations/001_extensions.sql)
- [local-brain/migrations/009_vectorscale_diskann.sql](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/migrations/009_vectorscale_diskann.sql)
- [local-brain/migrations/013_paradedb_bm25.sql](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/migrations/013_paradedb_bm25.sql)

## 4. Run migrations

```bash
cd /Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain
npm run migrate
```

## 5. Choose your provider path

You have two main ways to run the system.

### Local runtime

Use this when you have your own model box or private endpoint.

Important envs in `/.env`:

```env
BRAIN_MODEL_RUNTIME_BASE_URL=http://your-runtime:8000
BRAIN_EXTERNAL_AI_BASE_URL=http://your-runtime:8000
```

Optional path overrides:

```env
BRAIN_EXTERNAL_AI_EMBEDDING_PATH=/v1/embeddings
BRAIN_EXTERNAL_AI_CLASSIFY_PATH=/v1/chat/completions
BRAIN_EXTERNAL_AI_DERIVE_PATH=/v1/artifacts/derive
```

### OpenRouter

Use this when you want hosted models and embeddings.

Important envs:

```env
OPENROUTER_API_KEY=your_key_here
BRAIN_OPENROUTER_CLASSIFY_MODEL=openai/gpt-4.1-mini
BRAIN_OPENROUTER_EMBEDDING_MODEL=text-embedding-3-small
```

## 6. Start the app

From repo root:

```bash
cd /Users/evilone/Documents/Development/AI-Brain/ai-brain
npm run dev
```

Default local URLs:

- UI: `http://127.0.0.1:3005`
- Runtime: `http://127.0.0.1:8787`

Optional monitored-source worker:

```bash
cd /Users/evilone/Documents/Development/AI-Brain/ai-brain
BRAIN_SOURCE_MONITOR_ENABLED=true npm run dev
```

Or separately:

```bash
cd /Users/evilone/Documents/Development/AI-Brain/ai-brain
npm run sources:monitor
```

If you want the combined runtime worker instead of only the source monitor:

```bash
cd /Users/evilone/Documents/Development/AI-Brain/ai-brain
BRAIN_RUNTIME_OPS_ENABLED=true npm run dev
```

## 7. Go through the in-app setup flow

Open:

- `http://127.0.0.1:3005`

Recommended order:

1. `Start Here`
2. `Guided Setup`
3. `Settings`
4. normal `Sessions`
5. `Legacy Console` only after setup is complete

Inside setup, do this in order:

1. confirm runtime reachable
2. choose brain purpose
3. complete owner setup
4. import trusted sources
5. run verification smoke checks
6. configure embeddings
7. test embeddings
8. rebuild namespace vectors after provider/model changes

## 8. What source path should I use?

### If you already have OpenClaw-style markdown

This is the recommended initial import path.

Use Guided Setup import with an OpenClaw-style folder when:

- you already have structured markdown session files
- you want a trusted historical bootstrap source
- you want durable evidence import without inventing a new format

Why this is preferred:

- it aligns with the existing ingestion contract
- it preserves raw evidence files
- it fits the monitored-source import flow
- it is already compatible with the current local-brain source service

### If you are starting from scratch

Use Owner Setup first, then add:

- typed narrative
- markdown notes
- audio notes
- trusted folders

## 9. How monitored folders work

The folder monitoring path is intentionally runtime-first:

- the dashboard stores monitored-source settings such as `monitor_enabled` and `scan_schedule`
- `local-brain` owns the actual scan/import execution
- the worker scans for changed `.md` and `.txt` files, fingerprints them, and imports only changed files
- imported files still go through the normal ingestion pipeline

Current MCP position:

- MCP is the right interface for assistants and tool clients
- MCP is not the right place to host the always-on folder watcher itself
- the watcher should stay in the runtime/worker layer
- MCP can expose monitoring controls or read tools later

## 10. Current known embedding caveat

`Qwen/Qwen3-Embedding-4B` works on the provider test path and returns valid embeddings, but it returns `2560` dimensions.

The current pgvector columns are still `1536`, so:

- embedding provider test: works
- full namespace re-embed: blocked until schema upgrade

Today, the cleanest end-to-end hybrid retrieval path is still a `1536`-dimension provider/model such as OpenRouter with `text-embedding-3-small`.

## 11. After setup is complete

Use the app like this:

- `Dashboard`: high-level operator status and recent work
- `Sessions`: create and manage intake/review loops
- `Models`: inspect runtime families and provider state
- `Settings`: manage embeddings/provider defaults
- `Legacy Console`: advanced query, graph, timeline, benchmark, and inbox exploration

## Related docs

- [README.md](/Users/evilone/Documents/Development/AI-Brain/ai-brain/README.md)
- [docs/OPERATOR_WORKBENCH_GUIDE.md](/Users/evilone/Documents/Development/AI-Brain/ai-brain/docs/OPERATOR_WORKBENCH_GUIDE.md)
- [local-brain/QUICKSTART.md](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/QUICKSTART.md)
- [docs/LIFE_ONTOLOGY.md](/Users/evilone/Documents/Development/AI-Brain/ai-brain/docs/LIFE_ONTOLOGY.md)
- [docs/ROUTING_RULES.md](/Users/evilone/Documents/Development/AI-Brain/ai-brain/docs/ROUTING_RULES.md)
