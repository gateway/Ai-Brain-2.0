# AI Brain 2.0

This workspace is building a local-first Brain 2.0 for Apple Silicon Macs.

The target is not a thin RAG demo. It is a PostgreSQL-centered cognitive
substrate with:

- episodic, semantic, and procedural memory
- relationship memory and entity linking
- temporal summaries and TMT-style hierarchy groundwork
- hybrid retrieval
- provenance back to durable artifacts on disk
- conflict-aware updates and slow forgetting
- producer bridges for chat, webhook, markdown, transcript, and artifact inputs

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

## Main Folders

- [local-brain](local-brain)
  Runtime code, migrations, CLI tools, eval harness, and local README/changelog.
- [brain-console](brain-console)
  Local Next.js + Tailwind + shadcn operator console for query/debug/benchmark visibility.
- [brain-spec/local](brain-spec/local)
  The detailed local-first architecture, run logs, self-critique passes, and NotebookLM-grounded design docs.
- `artifacts/the-digital-brain`
  Local-only mirrored NotebookLM media and exports. Excluded from Git because of size.
- [notes](notes)
  Research notes and earlier synthesis passes.

## Best Entry Points

- [local-brain/QUICKSTART.md](local-brain/QUICKSTART.md)
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
