# Local Confidence And Validation

## Confidence Rating

Current confidence:

- `90%`

Meaning:

- the architecture direction is strong
- the section hierarchy is strong
- the remaining uncertainty is mostly in packaging, tuning, and evaluation

## Why Confidence Is Not Higher

- local extension bring-up is not yet proven on this machine
- consolidation quality is untested
- BM25 local packaging still needs practical confirmation
- TMT implementation details still need empirical tuning

## What Must Be Validated First

### 1. Extension bring-up

Confirm:

- PostgreSQL 18
- TimescaleDB
- `pgvector`
- `pgvectorscale`
- `pgai`
- BM25 path

### 2. Artifact and ingestion flow

Confirm:

- markdown ingest
- transcript ingest
- provenance pointers
- fragment granularity

### 3. Retrieval quality

Benchmark:

- lexical only
- vector only
- hybrid RRF
- time-filtered hybrid
- relationship-aware hybrid

### 4. Consolidation quality

Test:

- duplicate merges
- preference changes
- temporary override handling
- supersession links

### 5. Timeline queries

Test queries like:

- "What was I doing in Japan in 2005?"
- "Who was I with?"
- "What projects was I working on then?"

## Acceptance Signals

The local brain is on the right path when it can:

- ingest artifacts without losing provenance
- answer timeline questions with supporting evidence
- distinguish active truth from history
- reduce prompt payload without losing correctness
- maintain stable behavior across repeated recall tests
