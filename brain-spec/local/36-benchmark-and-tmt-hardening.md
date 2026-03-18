# Benchmark And TMT Hardening

Date: 2026-03-18

## Scope

This slice did two things in the local runtime:

- hardened the lexical benchmark so BM25 is judged on a larger stress set
- moved temporal retrieval from flat summary bias toward a first real TMT ancestry chain

NotebookLM was used first for:

- lexical benchmark case selection
- the next practical TMT step after year-hint planning
- hostile review of promoting BM25 too early

The useful NotebookLM signal was:

- keep BM25 feature-gated until the benchmark covers exact codes, entity collisions, abstention, provenance, preference supersession, and temporal queries
- move TMT forward with explicit parent-linked temporal nodes and ancestor propagation, not vague “summary magic”

Where NotebookLM was corrected:

- it drifted toward academic tree descriptions; the implemented slice keeps episodic rows immutable and puts lineage on `temporal_nodes`
- it suggested abstract LLM-style sufficiency gates; this slice stays deterministic and SQL-backed

## What Changed

### 1. Stronger Lexical Benchmark

The lexical benchmark now seeds a richer corpus and compares FTS vs BM25 across `13` cases:

- Japan temporal recall
- relationship-context lexical recall
- exact date/month recall
- current procedural truth
- changed food preferences
- rare CVE/code lookup
- exact version lookup
- acronym precision
- provenance hash lookup
- OCR-derived text lookup
- entity collision (`Sara` vs `Sarah`)
- abstention

Current result:

- `FTS`: `12/13`
- `BM25`: `12/13`
- recommendation: `keep_feature_gated`

Reason:

- both lexical providers still fail the same relationship-style exact query where `memory_candidate` outranks the raw episodic leaf

This is the right kind of failure:

- the benchmark is now catching a genuine ranking issue instead of rubber-stamping BM25 as default

### 2. Stronger Temporal / TMT Behavior

The runtime now has:

- `year` temporal rollups in addition to `day` / `week` / `month`
- `parent_id` and `depth` on `temporal_nodes`
- parent-linking across `day -> week -> month -> year`
- ancestor expansion during temporal retrieval

This means a time-bounded query can now pull:

- the leaf episodic evidence
- the relevant temporal summary node
- ancestor temporal context above that node

without pretending the system is already a full TiMem implementation.

## Verification

Commands run:

```bash
cd /Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain
npm run migrate
npm run check
npm run eval
npm run benchmark:lexical
npm run test:planner
```

Observed results:

- `npm run migrate`: passed, applied `014_temporal_tree_links.sql`
- `npm run check`: passed
- `npm run eval`: passed all checks
- `npm run benchmark:lexical`: passed and wrote a new `latest.md` / `latest.json`
- `npm run test:planner`: passed all 4 planner tests

Important eval proof points:

- temporal node count: `6`
- parent-linked temporal nodes: `4`
- Japan 2025 recall now includes temporal ancestor context

## Self-Review

What went well:

- the benchmark is harder now and caught a real lexical ranking weakness
- the TMT slice is structural, not cosmetic
- the local runtime is still coherent: Postgres remains the center, workers orbit it, raw evidence stays on disk

What is still not solved:

- BM25 is still not ready to become the default lexical provider
- one relationship-style exact query still prefers `memory_candidate` over raw episodic evidence
- TMT is stronger, but still not full recursive best-effort descent with per-level budgets and true recall gating

Current confidence after this slice:

- local runtime direction: `~93%`
- BM25 default-readiness: `not ready`
- TMT maturity: `real groundwork, not full completion`

## Next Move

The next highest-value local slice is:

1. fix the remaining relationship-style lexical ranking issue
2. decide whether that is done by ranking policy, query classification, or candidate/episodic routing
3. only then reconsider flipping BM25 on by default
