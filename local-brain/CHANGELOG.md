# Changelog

## 2026-03-18

- Added a feature-gated ParadeDB BM25 lexical branch with `BRAIN_LEXICAL_PROVIDER=bm25`, keeping native PostgreSQL FTS as the safe fallback/default path.
- Added BM25 indexes for `episodic_memory`, `semantic_memory`, `memory_candidates`, `artifact_derivations`, and `temporal_nodes`.
- Tightened BM25 query behavior to require must-match lexical terms instead of broad default query-string matching, fixing abstention and exact-term drift.
- Kept `procedural_memory` on an FTS bridge during BM25 mode after verifying that active-truth state lookups were more reliable that way on the current schema/data.
- Added a durable `derivation_jobs` queue for OCR, transcription, caption, summary, text, and embedding backfills so multimodal work can be deferred safely without a live provider.
- Added `POST /derive/queue` and a matching CLI so artifacts can be routed into a replayable job queue instead of only synchronous provider calls.
- Added a derivation worker CLI that drains the durable queue and writes finished text proxies back into `artifact_derivations`.
- Added a vector-sync worker CLI that drains `vector_sync_jobs` and keeps embedding sync separate from OCR/STT/caption extraction.
- Hardened live Slack/Discord producer intake with replay-window Slack signature checks, shared-secret Discord gating, and env-based team/guild/channel/user allowlists.
- Changed provider transport failures and timeouts to retryable queue errors instead of terminal one-shot failures.
- Added `timescaledb`-backed `episodic_timeline` as a sidecar hypertable mirror for time-windowed episodic recall, while keeping `episodic_memory` as the authoritative FK anchor.
- Added `pgvectorscale` DiskANN indexes for `semantic_memory` and `artifact_derivations`, and verified the planner can use them for vector ordering.
- Installed and evaluated `pgai`, added `vector_sync_jobs`, and kept the application-owned SQL queue as the primary controlled embedding sync/backfill path.
- Added live Slack event and Discord relay HTTP receivers with shared ingestion/provenance handling.
- Added an external AI provider adapter plus a provider-backed derivation route that fails cleanly when no external service is available.
- Added hybrid retrieval over native PostgreSQL full-text plus `pgvector` embeddings with RRF fusion and lexical fallback when embeddings are unavailable.
- Added retrieval metadata so searches report whether they ran in lexical or hybrid mode and why vector fallback occurred.
- Added provider/model/dimensions support to the search CLI and HTTP search route.
- Added a TMT-style recall planner helper that classifies temporal queries, infers year windows like `2025`, and biases historical recall toward episodic evidence plus temporal summaries.
- Added a first runnable stdio MCP server and CLI with `memory.search`, `memory.timeline`, `memory.get_artifact`, `memory.get_relationships`, `memory.save_candidate`, and `memory.upsert_state`.
- Added deterministic temporal summary scaffolding with `temporal_nodes` and `temporal_node_members`.
- Added deterministic relationship adjudication into `relationship_memory` with adjudication event logs.
- Added deterministic semantic forgetting/decay with `semantic_decay_events`.
- Expanded the evaluation harness to verify:
  - Timescale parity between `episodic_memory` and `episodic_timeline`
  - hybrid vector retrieval
  - relationship adjudication
  - weekly temporal summaries
  - semantic decay
  - provenance and token-budget behavior
