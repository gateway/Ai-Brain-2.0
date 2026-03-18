# Changelog

## 2026-03-18

- Added a durable `derivation_jobs` queue for OCR, transcription, caption, summary, text, and embedding backfills so multimodal work can be deferred safely without a live provider.
- Added `POST /derive/queue` and a matching CLI so artifacts can be routed into a replayable job queue instead of only synchronous provider calls.
- Added a derivation worker CLI that drains the durable queue and writes finished text proxies back into `artifact_derivations`.
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
