# Local Brain Status After BM25 Closure

Date: `2026-03-18`

## Progress

Estimated local-track completion: `98%`

This rating means:

- the local substrate is real and running on this machine
- the major memory classes are in place
- BM25 is now closed and defaulted
- TMT is materially stronger than earlier slices
- the operator console exists
- the remaining work is no longer “core memory is missing”

## Closed

- PostgreSQL 18 local runtime
- Timescale sidecar timeline mirror
- `pgvector`
- `pgvectorscale` / DiskANN bring-up
- `pgai` sidecar evaluation path
- tripartite memory substrate
- relationship/entity extraction and adjudication
- temporal summaries and parent-linked temporal nodes
- BM25 lexical branch
- BM25 default decision
- lexical benchmark and eval harness
- MCP server
- operator console
- Slack/Discord producer intake

## Strong But Not Final

- TMT:
  - now includes parent-linked ancestry, layer budgets, and bounded descendant support
  - still not a full complexity-aware hierarchical descent stack
- hybrid retrieval:
  - works
  - still uses app-side RRF instead of a final SQL-first fused kernel
- forgetting:
  - semantic decay is implemented
  - richer long-horizon decay policies can still improve
- relationship memory:
  - already useful
  - still heuristic plus deterministic adjudication rather than full semantic adjudication

## Deferred By Choice

- real OCR/STT/caption execution against the final external/local AI endpoint
- richer multimodal-native embedding execution for image/pdf/audio
- broader holdout/noisy lexical benchmark corpora
- richer operator graph visualization

## Current Truth

- BM25 is no longer an open issue on the local track
- BM25 is the runtime default lexical provider
- FTS remains as override/fallback, not as the primary path
- TMT is improved enough that we are no longer at the “flat summary bias” stage

## Next Best Moves

1. deepen TMT further with richer per-level descent and sufficiency gating
2. expand the operator console with timeline and relationship views
3. wire the real external derivation endpoint when ready
4. add a noisier holdout benchmark corpus so the lexical story is strong beyond the seeded suite
