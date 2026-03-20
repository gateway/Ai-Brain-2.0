# AI Brain 2.0

AI Brain 2.0 is a local-first memory system for people who want durable recall, structured relationships, and operator-visible provenance instead of disposable chat history.

It combines:

- a guided Next.js operator workbench
- a Node.js brain runtime
- PostgreSQL-backed memory, retrieval, graph, and temporal layers

This is not a thin RAG demo. It is a reviewable cognitive substrate with evidence, staged extraction, clarifications, graph memory, hybrid retrieval, and time-aware summaries.

## What You Get

AI Brain 2.0 is built to help you:

- ingest notes, transcripts, markdown folders, audio, PDFs, and images as evidence
- classify entities, relationships, claims, ambiguities, and staged memory candidates
- review and correct uncertain facts instead of silently accepting bad extraction
- inspect relationship graphs and temporal memory state
- ask natural questions like `Where was I living in 2025?`
- trace answers back to supporting evidence and source files
- monitor watch folders and keep imports in sync over time
- generate deterministic time summaries with an optional LLM semantic overlay

## What You Get In The Dashboard

The operator dashboard is a real product surface, not just a debug shell.

It gives you:

- a guided first-run setup flow so a new install knows what to do next
- purpose and owner setup so the brain is grounded before broad ingestion
- trusted-source import and watch-folder controls
- a dedicated sources page for scan/import state and watch-folder management
- session-based intake for text, audio, files, and reviewable evidence
- clarifications and correction workflows for unresolved people, places, aliases, and relationships
- a dedicated clarifications page that ranks unknowns by operator priority
- relationship graph and timeline exploration
- query and verification surfaces that keep supporting evidence visible
- a runtime page for provider reachability, worker health, and quick control actions
- provider, embeddings, and operations settings in one place

In practice, the app is built to let an operator:

1. set up the brain
2. ingest material
3. review what the system learned
4. correct uncertainty
5. verify answers and provenance
6. keep the memory system healthy over time

For a fuller product tour with examples, see [docs/BRAIN_FEATURES_AND_EXAMPLES.md](docs/BRAIN_FEATURES_AND_EXAMPLES.md).
For a section-by-section guide to the app itself, see [docs/OPERATOR_WORKBENCH_GUIDE.md](docs/OPERATOR_WORKBENCH_GUIDE.md).

## Quick Start

On a new Mac, the shortest supported path is:

```bash
cd /Users/evilone/Documents/Development/AI-Brain/ai-brain
bash scripts/bootstrap_mac.sh
bash scripts/doctor_mac.sh
npm run dev
```

Then open [http://127.0.0.1:3005](http://127.0.0.1:3005) and go through:

1. `Start Here`
2. `Guided Setup`
3. `Settings` for optional tuning
4. `Sessions`

The bootstrap script prepares the repo, local Python helper venv, database, and Node dependencies. The doctor script verifies that the machine is actually ready before you trust the result.

## Prerequisites

The bootstrap script assumes:

- macOS
- Homebrew installed
- network access to install packages

It will then try to set up:

- `node`
- `postgresql@18`
- `pgvector`
- repo-local Python helper environments
- repo-local Node dependencies

Some PostgreSQL extension paths still require explicit local handling, especially newer PostgreSQL 18 setups involving `vectorscale`, `pg_search`, or `timescaledb`. The script fails clearly instead of pretending that part is complete.

## Product Surfaces

The product has two main runtime surfaces:

- `Operator Workbench`
  - guided first-run setup
  - owner bootstrap
  - source import
  - session-based intake and review
  - provider and embeddings controls
- `Local Brain`
  - runtime, ingestion, retrieval, graph, clarification, and memory services
  - PostgreSQL-backed storage and query layer

The target architecture is:

- episodic, semantic, and procedural memory
- relationship memory and entity linking
- temporal summaries and TMT-style hierarchy groundwork
- hybrid retrieval
- provenance back to durable artifacts on disk
- conflict-aware updates and slow forgetting
- producer bridges for chat, webhook, markdown, transcript, and artifact inputs

## Example Capabilities

Examples of what the system already supports:

- create a first-run owner profile and bootstrap the self anchor
- ingest text, markdown, audio, PDFs, and images as evidence
- classify evidence into entities, relationships, claims, and ambiguities
- surface clarifications like unresolved people, places, aliases, and kinship labels
- inspect a relationship graph and timeline views
- run hybrid retrieval with lexical fallback
- test local-runtime or OpenRouter provider paths for embeddings
- run deterministic temporal rollups with an optional small-LLM semantic summary layer
- import OpenClaw-style markdown folders as trusted historical bootstrap sources

If you already use OpenClaw-style markdown exports or personal knowledge folders, AI Brain can use them as a high-signal bootstrap source instead of forcing you to start from scratch.

## Current Runtime Stack

The live app path is currently:

- `brain-console`: Next.js / Node.js operator UI
- `local-brain`: Node.js runtime service
- PostgreSQL 18
- Postgres extensions such as `pgvector`, `pg_search`, `vectorscale`, and `timescaledb`

Python is currently used as an isolated helper/sidecar environment, not as the main app runtime:

 - repo-local Python helper environments can be used for optional tooling like `pgai`, OCR/document processing, and related sidecar experiments
Release policy:

- no dependency on system Python packages
- all Python packages installed into repo-local venvs
- Postgres and its extensions managed separately from Python
- local research artifacts, auth state, and workstation-only environments excluded from GitHub

## Summary And Worker Controls

The operator-facing settings surface now includes system operations controls for:

- watch-folder monitoring
- inbox/outbox propagation cadence
- temporal summary cadence
- temporal summary strategy
- summarizer provider, model, preset, and system prompt

The intended summary strategy is:

- deterministic temporal buckets remain authoritative
- an optional small-LLM semantic overlay can rewrite the readable summary text
- provider choice can be local runtime, OpenRouter, or Gemini depending on what the operator has configured

## Local Runtime Vs OpenRouter

AI Brain supports both local and hosted model paths.

- `external`
  - your own runtime endpoint
  - best when you want local control over ASR, LLM, and embeddings
- `openrouter`
  - easiest hosted path for chat and embeddings
  - useful when you do not want to run local models
- `gemini`
  - available as an additional provider path where configured

The intended operator flow is:

- choose the provider during `Guided Setup` or later in `Settings`
- test the provider path
- rebuild vectors if the embedding provider or model changed
- use the same routing for temporal semantic summaries if desired

## OpenClaw And Trusted Folders

If you already have OpenClaw-style markdown notes or a structured local knowledge folder, that is one of the best ways to bootstrap the brain.

Recommended pattern:

1. complete `Start Here`
2. choose the brain lane and intelligence route
3. define the owner/self anchor
4. import trusted markdown folders
5. enable watch-folder monitoring for sources that continue to change
6. verify the graph, clarifications, and retrieval results before broadening scope

## What Exists Today

Verified local runtime slice in [local-brain/README.md](local-brain/README.md):

- native PostgreSQL 18
- `pgvector`
- `timescaledb`
- `pgvectorscale` with DiskANN indexes
- `pgai` installed as a controlled optional embedding/vectorizer layer
- file-backed artifact registry
- markdown/text/transcript ingestion
- webhook ingestion for generic/slack/discord payloads
- live Slack event receiver and Discord relay receiver
- binary artifact registration for image/pdf/audio
- text-proxy derivations for captions / OCR / extraction notes
- provider-backed derivation route for external AI services
- provider-backed staged classification route for external AI services
- second-stage vector sync worker for replayable embedding backfill
- stdio MCP server for local assistant/tool integration
- hybrid retrieval with lexical fallback
- ParadeDB BM25 lexical branch implemented, benchmarked, and now the default lexical provider on the local track
- TMT-style temporal planner for historical recall
- preference supersession
- deterministic relationship adjudication
- deterministic temporal rollups
- deterministic semantic decay
- reproducible evaluation harness

Latest verified run log:

- [Timescale, pgvectorscale, pgai, and live producers run log](brain-spec/local/30-timescale-vectorscale-pgai-live-producers-run-log.md)
- [Progress, runtime proof, and next slices](brain-spec/local/31-progress-and-next-slices.md)
- [MCP, temporal planner, and multimodal/vector-sync runtime proof](brain-spec/local/33-multimodal-vector-sync-runtime-log.md)
- [ParadeDB BM25 rollout and benchmark notes](brain-spec/local/34-paradedb-bm25-run-log.md)
- [Post-BM25 benchmark and mock multimodal proof](brain-spec/local/35-benchmark-and-multimodal-proof.md)
- [Expanded lexical benchmark and TMT hardening](brain-spec/local/36-benchmark-and-tmt-hardening.md)
- [Next.js dev console proposal](brain-spec/local/37-nextjs-dev-console-proposal.md)
- [Operator console implementation and proof](brain-spec/local/39-operator-console-run-log.md)
- [BM25 closure and TMT hardening](brain-spec/local/40-bm25-default-and-tmt-closure.md)
- [Local status after BM25 closure](brain-spec/local/41-local-brain-status-after-bm25-closure.md)
- [Timeline, relationship graph, and console atlas slice](brain-spec/local/42-console-timeline-relationship-slice.md)
- [Ambiguity inbox, outbox propagation, and BM25/TMT closure refresh](brain-spec/local/46-ambiguity-inbox-and-bm25-refresh.md)
- [Place/time/prior research plan](brain-spec/local/47-place-time-priors-and-graph-plan.md)
- [Top-nav console and live graph slice](brain-spec/local/48-console-topnav-and-live-graph.md)

## Repository Layout

- [local-brain](local-brain)
  Runtime code, migrations, CLI tools, eval harness, and local README/changelog.
- [brain-console](brain-console)
  Local Next.js + Tailwind + shadcn operator console for query/debug/benchmark visibility.
- [brain-spec/local](brain-spec/local)
  The detailed local-first architecture, run logs, and engineering deep dives.
- [notes](notes)
  Research notes and earlier synthesis passes.

For repo organization and what intentionally stays local-only, see [docs/GITHUB_REPOSITORY_GUIDE.md](docs/GITHUB_REPOSITORY_GUIDE.md).
For a docs index, see [docs/README.md](docs/README.md).

## Best Entry Points

- [docs/GITHUB_REPOSITORY_GUIDE.md](docs/GITHUB_REPOSITORY_GUIDE.md)
- [docs/README.md](docs/README.md)
- [docs/BRAIN_FEATURES_AND_EXAMPLES.md](docs/BRAIN_FEATURES_AND_EXAMPLES.md)
- [docs/FIRST_RUN_SETUP.md](docs/FIRST_RUN_SETUP.md)
- [docs/API_REFERENCE.md](docs/API_REFERENCE.md)
- [docs/MCP_REFERENCE.md](docs/MCP_REFERENCE.md)
- [docs/OPERATIONS_RUNTIME.md](docs/OPERATIONS_RUNTIME.md)
- [local-brain/QUICKSTART.md](local-brain/QUICKSTART.md)
- [docs/OPERATOR_WORKBENCH_GUIDE.md](docs/OPERATOR_WORKBENCH_GUIDE.md)
- [brain-spec/local/17-full-local-brain-build-spec.md](brain-spec/local/17-full-local-brain-build-spec.md)
- [brain-spec/local/28-hybrid-retrieval-and-runtime-proof.md](brain-spec/local/28-hybrid-retrieval-and-runtime-proof.md)
- [brain-spec/local/29-runtime-proof-and-next-data-collection.md](brain-spec/local/29-runtime-proof-and-next-data-collection.md)
- [brain-spec/local/30-timescale-vectorscale-pgai-live-producers-run-log.md](brain-spec/local/30-timescale-vectorscale-pgai-live-producers-run-log.md)
- [brain-spec/local/33-multimodal-vector-sync-runtime-log.md](brain-spec/local/33-multimodal-vector-sync-runtime-log.md)
- [brain-spec/local/38-bm25-tmt-optimization-run-log.md](brain-spec/local/38-bm25-tmt-optimization-run-log.md)
- [brain-spec/local/40-bm25-default-and-tmt-closure.md](brain-spec/local/40-bm25-default-and-tmt-closure.md)
- [brain-spec/local/41-local-brain-status-after-bm25-closure.md](brain-spec/local/41-local-brain-status-after-bm25-closure.md)
- [brain-spec/local/39-operator-console-run-log.md](brain-spec/local/39-operator-console-run-log.md)
- [brain-spec/local/48-console-topnav-and-live-graph.md](brain-spec/local/48-console-topnav-and-live-graph.md)
- [local-brain/CHANGELOG.md](local-brain/CHANGELOG.md)

## Run As One App

The repository now runs as one root app surface even though it preserves a clean boundary between:

- [brain-console](brain-console): Next.js operator UI
- [local-brain](local-brain): controlled runtime/memory service

### Install

```bash
cd /Users/evilone/Documents/Development/AI-Brain/ai-brain
npm install
npm install --workspace local-brain
npm install --workspace brain-console
cp .env.example .env
```

### macOS bootstrap

For a new Mac, the intended bootstrap path is:

```bash
cd /Users/evilone/Documents/Development/AI-Brain/ai-brain
bash scripts/bootstrap_mac.sh
```

What it currently does:

- verifies Homebrew is present
- installs `node`, `postgresql@18`, and `pgvector`
- starts PostgreSQL 18
- creates `ai_brain_local` if needed
- creates the repo-local Python helper venv
- installs JavaScript dependencies
- creates `/.env` if missing
- runs migrations only if the required PostgreSQL extensions are actually available

Important current limitation:

- `vectorscale`, `pg_search`, and some PostgreSQL-18-specific extension paths still need explicit local setup and are not fully automated by the script yet
- the script fails clearly when those are missing instead of pretending setup is complete

### macOS doctor

After bootstrap, run:

```bash
cd /Users/evilone/Documents/Development/AI-Brain/ai-brain
npm run doctor:mac
```

This checks:

- Homebrew, Node, npm, and Python 3
- local `.env`
- repo-local Python helper venv
- PostgreSQL 18 readiness
- `ai_brain_local` database presence
- extension availability
- whether the runtime and console are already responding

### Run locally

```bash
cd /Users/evilone/Documents/Development/AI-Brain/ai-brain
npm run dev
```

If you want monitored folders to run on a schedule as part of the local stack:

```bash
cd /Users/evilone/Documents/Development/AI-Brain/ai-brain
BRAIN_SOURCE_MONITOR_ENABLED=true npm run dev
```

Or run the folder monitor worker by itself:

```bash
cd /Users/evilone/Documents/Development/AI-Brain/ai-brain
npm run sources:monitor
```

### First-time setup checklist

1. Install dependencies and create `/.env` from [/.env.example](/Users/evilone/Documents/Development/AI-Brain/ai-brain/.env.example).
2. Make sure PostgreSQL 18 is running and `ai_brain_local` exists.
3. Make sure the required PostgreSQL extension binaries are available before migrations:
   - core: `pgcrypto`, `vector`, `btree_gin`
   - current local path: `vectorscale`, `pg_search`
   - recommended: `timescaledb`
   - optional sidecar: `ai` / `pgai`
4. Run the database migrations:

```bash
cd /Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain
npm run migrate
```

5. Decide which provider path you want to use first:
   - local runtime: point `BRAIN_MODEL_RUNTIME_BASE_URL` and `BRAIN_EXTERNAL_AI_BASE_URL` at your own endpoint
   - OpenRouter: set `OPENROUTER_API_KEY`
6. Start the app with `npm run dev`.
7. Open `http://127.0.0.1:3005`.
8. Complete the first-run flow in this order:
   - `Start Here`
   - `Guided Setup`
   - `Settings`
   - `Sessions`
9. Inside the setup flow, do:
   - brain purpose
   - connect intelligence
   - owner setup
   - trusted source import, or skip it for now
   - verification
10. Open `/settings` and set embeddings:
   - `external` if you want your own local runtime
   - `openrouter` if you want hosted embeddings
   - `none` if you want lexical-only retrieval
11. Run `Test embeddings`.
12. Run `Rebuild namespace vectors` after changing provider or model.

If you already have OpenClaw-style markdown memory files, use Guided Setup import as the recommended historical bootstrap path.

For the full install, provider, and in-app setup guide, see [docs/FIRST_RUN_SETUP.md](docs/FIRST_RUN_SETUP.md).

For the section-by-section operator guide, see [docs/OPERATOR_WORKBENCH_GUIDE.md](docs/OPERATOR_WORKBENCH_GUIDE.md).

Important current note:

- `Qwen/Qwen3-Embedding-4B` works on the local provider test path, but full namespace re-embed currently requires a pgvector schema upgrade because the current vector columns are still `1536`-dimension.

Default local URLs:

- UI: `http://127.0.0.1:3005`
- Runtime: `http://127.0.0.1:8787`

### Serve as one routed app

```bash
cd /Users/evilone/Documents/Development/AI-Brain/ai-brain
npm run serve:one
```

This starts:

- `local-brain` on an internal runtime port
- `brain-console` on an internal Next.js port
- a root Node.js reverse proxy on `http://127.0.0.1:3005`

So later deployment can expose one entry URL while still preserving the runtime boundary inside the app.

### Run shared quality gates

```bash
cd /Users/evilone/Documents/Development/AI-Brain/ai-brain
npm run quality:gates
```

### Relationship graph smoke

```bash
cd /Users/evilone/Documents/Development/AI-Brain/ai-brain
npm run smoke:graph
```

## Honest Current Limits

- the default lexical branch is now ParadeDB BM25
- the expanded lexical suite now clears `14/14` for both FTS and BM25, BM25 fallback is `0`, and BM25 token delta is a small `+22` across the whole seeded suite
- native PostgreSQL FTS still remains as the guarded lexical fallback and as the procedural-memory bridge inside BM25 mode
- the `procedural_memory` branch still uses native FTS inside BM25 mode because that path currently preserves active-truth lookups better on live data
- the hybrid fusion kernel is still app-side, not the final SQL-first kernel
- Timescale is implemented as a sidecar hypertable mirror for episodic time-scans, not as an in-place conversion of the authoritative `episodic_memory` table
- `pgvectorscale` is in use through DiskANN indexes, but the current corpus is still small and not yet benchmarked at larger scale
- `pgai` is installed and evaluated, but the current production path still keeps Node as the write gateway and uses a SQL queue for controlled backfill
- multimodal-native derivation is not fully wired; the safe current path is binary artifact + attached text proxy, or a provider-backed external derive endpoint
- provider-backed structured classification is now wired as an optional staged path; provider outputs become candidates and ambiguities, not final truth
- the `external` provider path is now testable locally with a mock server, but real OCR/STT/caption quality still depends on a real backend
- provider adapters are wired, but live provider execution still requires API keys or a reachable external AI endpoint
- relative-time understanding is still limited
- TMT is stronger now through parent-linked temporal nodes, ancestor budgeting, and bounded descendant support, but it is still not a full best-effort hierarchical descent stack
- ambiguity handling is now real for misspellings, kinship placeholders, and vague places, but the inbox is still an operator workflow rather than fully autonomous clarification

## Next High-Value Moves

- finish real OCR / transcription / caption workers against the external/local AI endpoint
- expand the MCP server so assistants can actively use more of the brain
- strengthen temporal/TMT retrieval behavior for long-horizon recall
- move hybrid retrieval from transitional app-side RRF to a SQL-first fused kernel
- expand the lexical benchmark beyond the seeded corpus with noisier holdout data
- deepen the operator console with richer per-layer TMT debugging, temporal containment checks, and later graph semantics like supersession/causality overlays
