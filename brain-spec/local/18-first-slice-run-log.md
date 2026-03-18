# First Slice Run Log

Date: `2026-03-17`

This note records the real local bring-up for the first Brain 2.0
implementation slice:

- native PostgreSQL 18 substrate
- runnable migrations
- file-backed artifact registry
- versioned artifact observations
- markdown / transcript-style ingestion

## What Worked

### Native local substrate

- `brew install postgresql@18` succeeded
- PostgreSQL 18 service is running locally
- `SELECT version();` returned:
  - `PostgreSQL 18.3 (Homebrew) on aarch64-apple-darwin25.2.0`
- `SELECT uuidv7();` works on this machine
- `brew install pgvector` had already succeeded
- `CREATE EXTENSION vector;` works in the local database

### Python isolation

- created repo-local helper venv:
  - `/Users/evilone/Documents/Development/AI-Brain/ai-brain/.venv-brain`
- added helper:
  - [/Users/evilone/Documents/Development/AI-Brain/ai-brain/use_brain_env.sh](/Users/evilone/Documents/Development/AI-Brain/ai-brain/use_brain_env.sh)
- verified:
  - sourcing the helper activates the repo-local venv

### Dedicated local database

- created:
  - `ai_brain_local`
- verified with `psql`:
  - current database = `ai_brain_local`

### Runnable local code

- local runtime builds cleanly:
  - `npm run check`
  - `npm run build`
- migrations applied successfully:
  - `001_extensions.sql`
  - `002_artifacts_and_episodic.sql`
  - `003_semantic_and_procedural.sql`

### First ingest path

Sample file:
- [/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/examples/japan-memory.md](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/examples/japan-memory.md)

First ingest succeeded:
- `1` artifact
- `1` observation
- `4` chunks
- `4` episodic rows
- `4` memory candidates

Second ingest of the unchanged file succeeded and stayed idempotent:
- observation count stayed `1`
- chunk count stayed `4`
- episodic count stayed `4`
- candidate count stayed `4`

Third ingest after changing the same file path succeeded and created a new versioned observation:
- artifact count stayed `1`
- observation count became `2`
- chunk count became `9`
- episodic count became `9`
- candidate count became `8`

That proves:
- same path + same content = no duplicate memory rows
- same path + changed content = new artifact observation version

## What Did Not Work Cleanly

### Parallel validation caused false negatives

Twice, `psql` count queries were run in parallel with the ingest process and
returned stale zero or old counts. The app output was correct; the query timing
was not.

Fix:
- validate ingestion counts only after the ingest process has completed

### `npm run migrate` failed once with “database does not exist”

This happened because the dedicated database creation and migration were started
in parallel.

Fix:
- create the database first
- then run migrations

### TypeScript compile failed on the first pass

Issues:
- missing `@types/pg`
- one implicit `any`
- one nullable `inputUri` narrowing problem

Fix:
- installed `@types/pg`
- patched the TypeScript files
- reran `npm run check`

### CLI processes did not exit cleanly on success

Cause:
- the shared Postgres pool stayed open after `migrate` and `ingest:file`

Fix:
- added `closePool()` in the DB client
- updated both CLI entrypoints to close the pool in `finally`

## NotebookLM Cross-Checks Used

NotebookLM was used as a second-brain for this slice and then corrected toward
runtime reality.

Useful conclusions kept:
- Docker is not required for the first local slice
- preserve raw source text in artifacts/chunks/episodic memory
- defer narrative normalization to semantic promotion
- stage semantic/procedural candidates instead of auto-promoting them
- use content hashes plus versioned observations for file updates

NotebookLM guidance explicitly corrected:
- do not treat TimescaleDB, pgvectorscale, or embeddings as blockers for the
  first runnable slice
- do not rewrite first-person source text during ingestion if provenance matters

## Current Verified Local State

Working now:
- native PostgreSQL 18
- `pgvector`
- repo-local Python helper venv
- dedicated database `ai_brain_local`
- local TypeScript migration runner
- local file ingestion runner
- versioned artifact observation model

Not yet solved locally:
- TimescaleDB native bring-up
- pgvectorscale native bring-up
- ParadeDB native bring-up
- pgai native bring-up
- embeddings
- retrieval service
- relationship extraction
- temporal hierarchy jobs
- consolidation workers

## Immediate Next Layer

1. Add the first retrieval/query service over `episodic_memory` and
   `memory_candidates`
2. Add relationship/entity extraction staging
3. Add conflict-aware promotion rules for semantic and procedural memory
