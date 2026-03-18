# BM25 And TMT Optimization Run Log

Date: `2026-03-18`

## Summary

This slice focused on three concrete goals:

- reduce BM25 fallback frequency on natural-language temporal questions
- deepen TMT recall beyond ancestor-only context
- benchmark the lexical branch more honestly instead of assuming BM25 is ready by narrative

The result is materially better:

- BM25 now clears the seeded lexical suite at `14/14`
- BM25 fallback on the seeded suite is now `0`
- temporal recall now attaches bounded descendant episodic support beneath matched summary nodes
- BM25 is still kept opt-in because token-burn is improved but not yet better than native FTS on the benchmark corpus

## NotebookLM Loop

NotebookLM was queried for:

- BM25 query construction for natural-language temporal prompts
- the next TMT retrieval step after ancestor expansion
- practical benchmark patterns for lexical precision, temporal grounding, relationship recall, supersession, and abstention

Useful guidance retained:

- do not feed raw natural-language temporal questions directly into BM25 term construction
- separate lexical intent from temporal filters
- use bounded descendant support under temporal summaries instead of unbounded tree descent
- benchmark exact lexical recall, relationship recall, supersession, and abstention explicitly

Guidance rejected or corrected:

- NotebookLM drifted into “exclude personal names” for planner keywords; that is wrong for this brain because names are often primary lexical evidence
- NotebookLM leaned toward broad LLM planner/gating language; this slice stayed deterministic and implementation-safe

## What Changed

### 1. BM25 Query Shaping

`planRecallQuery()` now emits planner-shaped lexical terms.

Behavior:

- natural-language temporal queries like `What was I doing in Japan in 2025?` collapse to a small lexical set such as `Japan`
- time stays in SQL range filters
- non-date numeric tokens like `3000` no longer become fake year hints
- code/version strings like `CVE-2026-3172` and `pgvector 0.8.2` are preserved as lexical terms

### 2. BM25 Branch Safety

The artifact-derivation BM25 branch was causing ParadeDB query-shape failures on joined queries.

Current handling:

- `artifact_derivation` lexical search now uses an explicit FTS bridge inside BM25 mode
- BM25 remains active for the branches it handles reliably
- this removes the old “one bad branch collapses the whole lexical provider” behavior on the seeded corpus

### 3. TMT Descendant Support

Temporal recall now does more than ancestor expansion.

Current behavior:

- matched temporal summaries can descend into bounded child layers
- descendant episodic leaves are linked back into the result set as support evidence
- if the same episodic row was already present lexically, the result keeps the direct hit and adds `temporal_support` provenance instead of silently dropping the support path

This is still not the final TMT:

- no full best-effort recursive descent
- no LLM recall gate
- no session/profile maturity yet

But it is a real step from “summary plus parents” to “summary plus supporting leaves.”

## Benchmark Changes

The lexical benchmark now tracks:

- effective lexical provider
- whether fallback was used
- fallback reason

The suite currently covers `14` cases including:

- exact temporal lexical recall
- natural-language temporal recall
- relationship-context recall
- active-truth procedural recall
- rare code/entity lookup
- acronym/version lookup
- artifact/provenance lookup
- abstention

Current benchmark state:

- `FTS: 14/14`
- `BM25: 14/14`
- `BM25 fallback cases: 0`
- `BM25 token delta vs FTS: +83`

## Why BM25 Is Still Opt-In

BM25 is now technically strong enough to use.

But the honest benchmark conclusion is:

- it still returns a slightly fatter lexical tail than native FTS on the current benchmark corpus
- that means token-burn is improved from prior slices, but not yet clearly better than the FTS baseline

So the current runtime stance is:

- default lexical provider: `fts`
- opt-in lexical provider: `bm25`
- BM25 is no longer “experimental and fragile”
- BM25 is “strong, benchmarked, and still being tuned for tighter answer payloads”

## Self Review

What went well:

- the real ParadeDB failure path was isolated instead of guessed
- the planner bug on `3000` being treated as a year was found and fixed
- TMT depth improved without schema churn
- benchmark reporting is now more honest

What is still not done:

- deeper TMT descent with per-level sufficiency gating
- broader eval corpus beyond the seeded synthetic suite
- real OCR/STT/caption provider execution against the external endpoint
- richer relative-time resolution such as `two weeks later`

## Next Best Moves

1. Add a second benchmark slice for relative-time offsets and relationship attribution.
2. Tighten BM25 token-burn further so it can become the runtime default honestly.
3. Keep TMT moving toward complexity-aware per-level budgets and optional sufficiency gating.
4. After that, wire the real OCR/STT/caption endpoint and move back to multimodal execution.
