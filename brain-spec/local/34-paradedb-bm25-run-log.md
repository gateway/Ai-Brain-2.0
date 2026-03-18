# ParadeDB BM25 Run Log

Date: 2026-03-18

## Goal

Add ParadeDB BM25 to the local brain without breaking the current retrieval loop,
relationship recall, temporal queries, or active-truth memory behavior.

## NotebookLM Loop

NotebookLM was used as a second brain for this slice. The useful guidance that
held up after verification was:

- add BM25 as a feature-gated shadow lexical branch
- keep native PostgreSQL full-text search as fallback
- do not change RRF just because the lexical scorer changes
- benchmark BM25 on exact terms, rare entities, codes, and abstention before making it the default

What NotebookLM got directionally right but too loosely:

- its first BM25 advice assumed query-string matching would be precise enough by default
- in practice, the raw ParadeDB text-query path was too broad for our preference examples and abstention check

## What Was Verified Locally

- `pg_search 0.22.1` is installed in `ai_brain_local`
- BM25 indexes were added in [013_paradedb_bm25.sql](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/migrations/013_paradedb_bm25.sql)
- retrieval now supports `BRAIN_LEXICAL_PROVIDER=bm25`
- `npm run check` passes
- `BRAIN_LEXICAL_PROVIDER=bm25 npm run eval` passes

## What Worked

- BM25 on `episodic_memory`
- BM25 on `semantic_memory`
- BM25 on `memory_candidates`
- BM25 on `artifact_derivations`
- BM25 on `temporal_nodes`
- BM25 plus the existing app-side RRF preserved the Japan 2025 recall path
- abstention improved once BM25 matching was tightened from loose query-string matching to must-match term groups

## What Did Not Work Cleanly

The first BM25 attempt was too permissive:

- `sweet food` surfaced too many `food` matches
- unknown lexical probes returned false positives

The cause was ParadeDB query-string behavior being broader than we wanted for
our memory queries.

The other issue was `procedural_memory`:

- pure BM25 on the procedural/state table did not give a reliable active-truth ranking on the current schema/data
- for example, preference-state lookups were better preserved by native FTS on the combined structured state text

## How It Was Fixed

1. Kept BM25 behind a feature flag instead of making it the default.
2. Tightened BM25 matching to require must-match lexical terms across indexed fields.
3. Preserved native PostgreSQL FTS as the safe fallback/default path.
4. Kept `procedural_memory` on an FTS bridge even during BM25 mode.

That final blend gives us:

- BM25 where it is already clearly better
- no regression on current-truth state lookups
- no loss of provenance, time-bounded recall, or relationship recall

## Current Assessment

This slice went well.

- quality: good
- risk: moderate but controlled
- confidence: about 90% for keeping BM25 available behind a flag
- confidence: not high enough yet to make BM25 the default lexical path everywhere

## Pending Issues

- benchmark BM25 vs native FTS on a dedicated lexical stress set
- decide whether `procedural_memory` should stay FTS permanently or get a different BM25 indexing/query shape later
- consider denormalizing `artifact_derivations.namespace_id` if we want even cleaner BM25 filtering there
- eventually compare the current mixed app-side lexical fusion to a more SQL-first lexical ranking kernel
