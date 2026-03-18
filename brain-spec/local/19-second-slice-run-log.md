# Second Slice Run Log

Date: `2026-03-17`

This note records the second verified local Brain 2.0 implementation slice:

- relationship and entity staging
- lexical-first retrieval service
- timeline query path
- preference supersession into semantic and procedural memory

## What Was Added

Schema:

- [004_entities_and_relationships.sql](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/migrations/004_entities_and_relationships.sql)
- [005_retrieval_and_promotion_support.sql](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/migrations/005_retrieval_and_promotion_support.sql)

Runtime:

- [relationships/extract.ts](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/relationships/extract.ts)
- [retrieval/service.ts](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/retrieval/service.ts)
- [jobs/consolidation.ts](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/jobs/consolidation.ts)
- [cli/search.ts](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/cli/search.ts)
- [cli/timeline.ts](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/cli/timeline.ts)
- [cli/relationships.ts](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/cli/relationships.ts)
- [cli/consolidate.ts](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/cli/consolidate.ts)

## NotebookLM Loop Used

NotebookLM was queried before implementation for:

- first-pass retrieval routing
- minimal relationship staging tables
- conservative preference supersession rules

The most useful guidance kept:

- separate active truth from historical truth
- keep relationships as staged hypotheses first
- use deterministic `canonical_key`, `valid_from`, `valid_until`, and `superseded_by_id`
- preserve provenance back to source fragments

Where NotebookLM drifted and was corrected:

- it kept trying to jump to vectors, HNSW, and LLM adjudication even when the prompt said not to
- it suggested heavier entity schemas than needed for a first reliable local slice
- it over-indexed on abstract architecture language when the actual need was migration-safe Postgres tables and deterministic rules

The fix was to re-ask narrower and more conservatively.

## What Worked

### Migrations

Applied successfully:

- `004_entities_and_relationships.sql`
- `005_retrieval_and_promotion_support.sql`

### Entity and relationship staging

After refining the extractor and ingesting the sample file into namespace
`personal_refined2`, the system produced a clean first-pass entity graph:

- people:
  - `Steve`
  - `Sarah`
  - `Ken`
- places:
  - `Japan`
  - `Tokyo`
  - `Kyoto`
  - `Osaka`
- project:
  - `Brain 2.0`

Relationship counts in `personal_refined2`:

- `with`: `2`
- `visited`: `3`

Verified query:

```bash
cd /Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain
npm run relationships -- Japan --namespace personal_refined2 --predicate with --time-start 2025-01-01T00:00:00Z --time-end 2025-12-31T23:59:59Z
```

Returned the expected `Steve -> Sarah` and `Steve -> Ken` relationships with
source provenance pointing back to the markdown file and chunk offsets.

### Time-aware retrieval

The fragmenter now does conservative content-time inference for obvious
expressions like `June 2025`.

Verified query:

```bash
cd /Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain
npm run search -- "Japan 2025 Sarah" --namespace personal_refined2 --time-start 2025-01-01T00:00:00Z --time-end 2025-12-31T23:59:59Z
```

Returned the correct episodic fragment with:

- `occurredAt = 2025-06-01T00:00:00.000Z`
- artifact provenance
- source chunk offsets

Verified timeline query:

```bash
cd /Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain
npm run timeline -- --namespace personal_refined2 --time-start 2025-01-01T00:00:00Z --time-end 2025-12-31T23:59:59Z
```

Returned the same June 2025 episodic fragment in chronological order.

### Preference supersession

Verified consolidation command:

```bash
cd /Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain
npm run consolidate -- --namespace personal_refined2
```

Result:

- scanned `1` pending preference candidate
- promoted `3` semantic memories
- superseded `1` semantic memory

Verified active truth:

- `preference:spicy food` version `2` is active with polarity `dislike`
- previous `preference:spicy food` semantic row is `superseded`
- `preference:sweet food` is active with polarity `like`

Verified search:

- `npm run search -- "spicy food" --namespace personal_refined2`
- `npm run search -- "sweet food" --namespace personal_refined2`

Both returned:

- procedural active truth first
- semantic active truth second
- candidate and episodic evidence below

## What Broke And Was Fixed

### False person entities

First pass extracted junk entities like:

- `Japan Memory Example`
- `In June`
- `An`
- `Project Brain`

Cause:

- the proper-name regex was too permissive for markdown headings and
  sentence-start words

Fix:

- reject short matches
- reject multi-token names containing stop words like month names, `Project`,
  and location tokens
- re-run validation in a fresh namespace

### Preference clause parsing

First pass incorrectly treated:

- `I hate spicy food and prefer sweet food instead`

as a single target string.

Fix:

- split clauses more conservatively
- allow implicit-subject follow-on clauses like `prefer sweet food`
- rerun validation in a fresh namespace

### Parallel validation false negatives happened again

Relationship/entity counts were queried while ingest was still running and
looked empty.

Fix:

- only validate counts after the ingest process exits

## Current Limits

- retrieval is still lexical-first, not true BM25 + vectors yet
- relationship rows are still `pending` staged hypotheses, not fully adjudicated facts
- content-time inference only handles explicit month/year or year mentions
- relative time expressions like `three months later` are not fully resolved
- no vector embeddings are written yet
- no Timescale hypertables yet
- no pgvectorscale / DiskANN / SBQ yet
- no pgai pipelines yet

## Net Result

The local brain now has a real second slice:

- file ingestion
- versioned evidence
- episodic memory
- entity and relationship staging
- current-vs-historical recall
- deterministic preference evolution
- provenance-backed search

It is still not the full Brain 2.0 target, but it now proves the core memory
classes are starting to behave like a real brain instead of a flat note store.
