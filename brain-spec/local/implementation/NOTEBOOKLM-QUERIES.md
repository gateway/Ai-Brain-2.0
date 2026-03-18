# NotebookLM Implementation Queries

These prompts were used as the "second brain" check before writing the local
implementation artifacts.

## Schema

Question:

- propose the first concrete PostgreSQL schema package for the local Brain 2.0
- focus on table groups, key columns, time fields, provenance fields, validity
  fields, entity and relationship tables, and temporal summary tables

Outcome:

- reinforced the table group split:
  - episodic
  - semantic
  - procedural
  - entities
  - relationships
  - temporal hierarchy
- reinforced validity windows and provenance fields

## Retrieval

Question:

- define the first concrete retrieval SQL shape for local Brain 2.0
- explain which queries hit which layers
- explain RRF and MCP payload needs

Outcome:

- reinforced parallel lexical and vector branches
- reinforced time and relationship-aware routing
- reinforced MCP payload fields such as provenance and timestamps

## Ingestion Worker

Question:

- define the practical ingestion worker contract
- include inputs, preserved artifact handling, fragments, provenance,
  idempotency, and failure handling

Outcome:

- reinforced immutable raw artifact preservation
- reinforced atomic fragment outputs
- reinforced checksum-based dedupe

## Consolidation Jobs

Question:

- define practical background jobs for adjudication, supersession,
  summaries, and semantic decay

Outcome:

- reinforced scheduled summary levels
- reinforced `ADD` / `UPDATE` / `SUPERSEDE` logic
- reinforced active-vs-historical truth split

## MCP Tool Surface

Question:

- define the first concrete MCP tool contracts for local Brain 2.0

Outcome:

- reinforced the initial tool set:
  - search
  - timeline
  - artifact lookup
  - relationship lookup
  - candidate write
  - state upsert

## Cross-Check Rule

NotebookLM was used for design pressure and sanity checks, not copied blindly.

Corrections applied during implementation:

- prefer safe PostgreSQL full-text SQL in the baseline instead of assuming
  specific BM25 operator syntax
- treat macOS AIO carefully and avoid Linux-specific assumptions
- keep optional extension upgrades explicit rather than pretending they are
  already guaranteed

## Validation And Self-Heal Pass

Additional section-specific queries were run during the documentation healing
pass.

### Ingestion

Question:

- define the local ingestion architecture for chat, markdown, voice dictation,
  transcripts, PDFs, images, and project files
- include provenance fields and the rule for writing to episodic, semantic, and
  procedural memory

Useful outcome:

- reinforced raw artifacts on disk
- reinforced text-first reasoning for most durable facts
- reinforced multimodal embeddings as additive rather than universal

Correction applied:

- treat first-pass segmentation as revisable during consolidation

### Temporal And Relationship Recall

Question:

- explain exactly how the system should answer:
  - `Who was I with in Japan in 2025?`

Useful outcome:

- reinforced explicit recall planning
- reinforced time filters, relationship joins, TMT expansion, and provenance

Correction applied:

- do not treat the TMT as magic; retrieval still needs explicit table design and
  evaluation

### Conflict And Forgetting

Question:

- explain the practical model for:
  - `I like spicy food`
  - later:
  - `I hate spicy food`

Useful outcome:

- reinforced active truth vs historical truth
- reinforced superseded durable facts instead of deletion
- reinforced decay of low-value derived memory rather than loss of evidence

Correction applied:

- summaries must preserve change over time instead of flattening contradictions

### Local Stack

Question:

- separate:
  - target stack
  - safe first baseline
  - macOS-specific cautions

Useful outcome:

- reinforced the target stack:
  - PostgreSQL 18
  - TimescaleDB
  - pgvector
  - pgvectorscale
  - pgai
  - BM25-grade lexical retrieval
  - RRF
  - MCP

Correction applied:

- keep the target stack intact but do not imply extension bring-up is already
  proven locally

### Hostile Critique

Question:

- attack the architecture and identify underspecified failure points

Useful outcome:

- surfaced risks around:
  - segmentation drift
  - provenance rot
  - empty relationship graphs
  - operator state leakage
  - missing evaluation

Correction applied:

- added those risks and countermeasures into the master local spec

## Second Slice Narrow Re-Asks

These narrower prompts were used before implementing retrieval, relationship
staging, and preference supersession.

### Retrieval Routing

Question:

- define a concrete first-pass retrieval service over `episodic_memory`,
  `semantic_memory`, `procedural_memory`, and `memory_candidates`
- explain current truth vs historical truth routing
- keep it implementation-oriented and avoid assuming vectors or LLM adjudication

Useful outcome:

- reinforced explicit current-vs-historical routing
- reinforced provenance payloads in the MCP-facing result shape

Correction applied:

- ignored the parts that jumped too quickly to HNSW and vector search because
  the current verified slice is lexical-first

### Conservative Relationship Staging

Question:

- define the minimal tables and SQL-join strategy for:
  - `Who was I with in Japan in 2025?`
- text ingestion only
- deterministic heuristics only

Useful outcome:

- reinforced a minimal `entities` plus `relationship_candidates` core
- reinforced that provenance must point back to episodic evidence

Correction applied:

- implemented a slightly richer local schema with mentions and aliases because
  it makes later refinement easier without adding a full graph engine

### Conservative Preference Supersession

Question:

- define the minimal columns and deterministic rules for first-pass preference
  supersession
- focus on:
  - `canonical_key`
  - `valid_from`
  - `valid_until`
  - `superseded_by_id`
  - source links
  - current-vs-historical query behavior

Useful outcome:

- reinforced deterministic `canonical_key` matching
- reinforced `valid_until IS NULL` for active truth
- reinforced immutable episodic evidence plus mutable current truth

## Third Slice Narrow Re-Asks

These narrower prompts were used before implementing producer hardening,
binary artifact registration, text-proxy derivations, and stronger benchmarks.

### External Producers

Question:

- after markdown ingestion, define the safest first external producer
  architecture for:
  - generic webhooks
  - Slack
  - Discord
- include raw evidence rules, idempotency keys, normalized fields, and
  promotion boundaries

Useful outcome:

- reinforced webhook first, Slack second, Discord later
- reinforced raw JSON payloads on disk plus normalized markdown/text
- reinforced native event IDs plus content hashes for dedupe

Correction applied:

- kept implementation local and deterministic instead of jumping straight to
  hosted queues or LLM-heavy filtering

### Binary Artifacts And Text Proxies

Question:

- with raw files on disk and only production-safe text embeddings assumed,
  define the safest implementation path for images and PDFs
- focus on provenance, derivation stages, and retrieval through extracted text
  proxies

Useful outcome:

- reinforced artifact-first ingestion
- reinforced text-proxy derivations as the safe bridge for images/PDFs
- reinforced retrieval over derived text with provenance back to the raw file

Correction applied:

- rejected direct multimodal embedding assumptions where they were not
  cleanly verified

### Benchmark Suite

Question:

- define the benchmark suite that should prove the system works
- include temporal recall, relationship recall, supersession, provenance,
  abstention, token burn, and idempotency

Useful outcome:

- reinforced deterministic checks for idempotency and provenance
- reinforced abstention and token-budget checks
- reinforced relationship and temporal recall as first-class benchmarks

Correction applied:

- treated published precision or latency numbers as directional references, not
  guarantees for this local build

## Provider And Multimodal Scaffolding Re-Ask

Question attempt 1:

- propose a minimal provider adapter contract for:
  - OpenRouter text embeddings
  - Gemini multimodal derivations
- include interfaces, provenance fields, and error taxonomy

Result:

- timed out (too broad in this notebook context)

Question attempt 2:

- provide a compact TypeScript interface set for:
  - `embedText` request/response
  - `deriveFromArtifact` request/response
  - error taxonomy
  - required provenance fields
- keep output short and implementation-oriented

Result:

- timed out again

Question attempt 3 (narrowed):

- list eight must-have fields for:
  - embedding provider responses
  - multimodal derivation responses

Useful outcome:

- reinforced explicit provider/model/dimensions/latency tracking
- reinforced provenance fields such as `source_uri` and offsets/page references
- reinforced confidence and modality tagging for derivations

Corrections applied:

- did not copy NotebookLM claims like universal `3072` dimensions into code
- kept provider adapters as safe scaffolding:
  - text embedding path implemented
  - multimodal derivation explicitly deferred with typed `PROVIDER_UNSUPPORTED`
- preserved storage targets (`artifact_derivations`) without faking full extraction

Correction applied:

- skipped vector similarity and LLM adjudication for the first reliable slice
- implemented clause-based parsing first, then corrected it after a live test
  exposed a bad merge of `hate spicy food and prefer sweet food`

## Hybrid Retrieval Re-Ask

Question attempt 1:

- define the next implementation-safe step for true hybrid retrieval on a Mac
- include staged architecture, minimal columns, RRF location, fallback behavior,
  artifact derivations, and deferrals

Useful outcome:

- reinforced lexical + vector parallel branches
- reinforced RRF over ranks instead of raw-score blending
- reinforced deferring ParadeDB / DiskANN / `pgai` until the core loop is stable

Correction applied:

- rejected NotebookLM drift toward `halfvec` / HNSW assumptions that do not
  match the current verified schema or installed stack

Question attempt 2:

- re-answer for the exact current schema:
  - `semantic_memory.embedding vector(1536)`
  - `artifact_derivations.embedding vector(1536)`
  - only `pgvector` installed
  - no `pgvectorscale`, ParadeDB, or `pgai`

Useful outcome:

- reinforced exact vector distance as acceptable before ANN indexes
- reinforced safe lexical-only fallback when embeddings are unavailable
- reinforced including `semantic_memory` and `artifact_derivations` in the same
  vector branch

Correction applied:

- NotebookLM still preferred SQL-only fusion immediately
- current code moved to an implementation-safe app-side RRF transitional slice
  and documented SQL-first fusion as the next upgrade, not the current reality

## Temporal / Decay / Relationship Re-Ask

Question:

- for temporal hierarchy, relationship adjudication, and semantic decay:
  - what should be deterministic first
  - what should wait for LLM adjudication
  - which fields matter most
  - what a minimal validation plan should prove

Useful outcome:

- reinforced deterministic-first handling for:
  - temporal containment
  - decay math
  - candidate selection
- reinforced keeping LLM use for:
  - contradiction classification
  - higher-level distillation
  - cold-memory review

Correction applied:

- preserved the current deterministic implementation as the verified baseline
- documented LLM adjudication as the next refinement layer rather than claiming
  it already exists
