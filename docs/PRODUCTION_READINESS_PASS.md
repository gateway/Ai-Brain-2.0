# Production Readiness Pass

This document records the current production-oriented read on the AI Brain 2.0
system after the latest retrieval, hypertable, replay, and operator passes.

## Latest Refresh

- rerunnable enrichment refresh:
  - `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/enrichment-refresh-2026-03-24T08-12-00-860Z.json`
  - current status: green after the fused-ranking and exact-detail answer-shaping pass
- public miss regressions:
  - `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/public-memory-miss-regressions-2026-03-24T08-10-26-205Z.json`
  - current status: green, including the former red cases for commute duration, exact support-group date, and Jon dance-studio motive wording
- shared/causal review:
  - `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/shared-causal-review-2026-03-24T08-11-56-987Z.json`
  - current status: `3 pass / 2 warning / 0 fail`
- latest public benchmark compare:
  - `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/public-memory-compare-2026-03-24T08-11-56-986Z.json`
  - current status:
    - `LongMemEval` sampled pass rate: `0.75`
    - `LoCoMo` sampled pass rate: `1.0`
    - benchmark artifacts now record reranker, fusion, scorer, and IE schema versions for replayable comparison
- latest MCP smoke:
  - `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/mcp-smoke-2026-03-24T08-13-29-355Z.json`
  - current status: `35 / 35` green on the product-facing tool surface

## Verified Runs

- clean replay:
  - `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/life-replay-2026-03-23T12-20-34-514Z.json`
- scale replay:
  - `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/life-scale-2026-03-23T12-21-42-590Z.json`
- demo-readiness benchmark:
  - `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/demo-readiness-2026-03-23T12-21-45-469Z.json`
  - current status: extension parity, embedding dimension/provider parity, MCP stdio tool wiring, and post-onboarding watched-folder delta induction are green
- external acceptance benchmark:
  - `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/external-acceptance-2026-03-23T12-21-49-817Z.json`
  - current status: generic-role abstention, distinct same-first-name relationship surfacing, exact detail descent, and natural beverage query invariance are green
- recap-family benchmark:
  - `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/recap-family-2026-03-23T12-22-33-695Z.json`
  - current status: participant plus time, participant plus topic, topic plus time, project recap, weekend people recap, and explain-recap prompts are green
- task/calendar extraction benchmark:
  - `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/task-calendar-extraction-2026-03-23T12-22-46-640Z.json`
  - current status: grounded task extraction and calendar-like commitment extraction are green with strict evidence linkage
- session-start memory benchmark:
  - `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/session-start-memory-2026-03-23T12-23-01-569Z.json`
  - current status: OpenClaw-style fresh-session recap, task, and calendar loading is green without rereading raw markdown memory files
- recap provider parity benchmark:
  - `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/recap-provider-parity-2026-03-23T12-23-21-209Z.json`
  - current status: deterministic no-provider output stays green and recap-family derivation routing remains provider-safe
- temporal differential benchmark:
  - `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/temporal-differential-2026-03-23T13-54-52-193Z.json`
  - current status: `this week`, `over the last two days`, and direct deadline-cause recap queries are green for state-change recall with source-linked evidence
- natural query review benchmark:
  - `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/natural-query-review-2026-03-23T13-23-59-180Z.json`
  - `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/natural-query-review-2026-03-23T13-23-59-180Z.md`
  - current status: a human-reviewable prompt/evidence/source-path report is now generated for natural queries, with `9` automated passes and `1` intentional ambiguity warning
  - next refresh: the review pack source now includes a temporal-differential Project A prompt so operators can inspect `what changed` style answers alongside recap/task/calendar behavior
- OMI watched-folder smoke:
  - `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/omi-watch-smoke-2026-03-23T12-24-29-232Z.json`
- MCP smoke replay:
  - `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/mcp-smoke-2026-03-23T12-24-23-565Z.json`
- synthetic watched-folder smoke:
  - `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/human-synthetic-watch-2026-03-23T12-21-57-600Z.json`
- multimodal worker smoke:
  - `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/multimodal-worker-smoke-2026-03-23T12-24-35-299Z.json`
- public dataset watched-folder pressure:
  - `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/public-dataset-watch-2026-03-23T12-22-08-385Z.json`
  - current status: release-gate queries and former `knownGapResults` are green
- NotebookLM six-suite hardening benchmark:
  - `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/hardening-suites-2026-03-23T12-22-01-510Z.json`
  - current status: all six suites are green on the current corpus
- aggregate production battle suite:
  - `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/production-battle-2026-03-24T04-58-30-722Z.json`
  - current status: `100%` pass rate and `releaseGatePassed: true`
  - operator note: stale benchmark runners can hold the advisory maintenance lock; `withMaintenanceLock` now waits briefly before failing, but a truly orphaned benchmark process still needs to be cleared before rerunning the aggregate gate
- relation extraction bakeoff:
  - `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/relation-bakeoff-2026-03-24T04-35-03-851Z.json`
  - current status: Mac-first additive extraction lane is live in shadow mode; `gliner-relex` is the strongest current extractor on this stack, `spaCy` is a lightweight fallback, and `gliner2` plus `SpanMarker` are currently compatibility/eval lanes rather than defaults
- latest relation extraction bakeoff:
  - `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/relation-bakeoff-2026-03-24T08-11-07-651Z.json`
  - current status: still green on the harder expanded bakeoff; `gliner-relex` remains the best default candidate generator on the current Mac-first stack
- public memory compare:
  - `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/public-memory-compare-2026-03-24T04-51-48-413Z.json`
  - current status: the first public benchmark lane is now wired into the repo with end-to-end `LongMemEval` and `LoCoMo` artifacts for trend comparison on the current stack
- latest public-memory compare:
  - `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/public-memory-compare-2026-03-24T08-11-56-986Z.json`
  - current status: the additive public lane is now materially better than the first pass and remains explicitly trend-oriented rather than leaderboard-claimed
- public benchmark artifacts:
  - `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/longmemeval-2026-03-24T04-49-44-851Z.json`
  - `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/locomo-2026-03-24T04-49-48-494Z.json`
- provider smoke:
  - local `external` provider succeeded with `Qwen/Qwen3-Embedding-4B` at `1536` dims

## Current Read

- clean replay:
  - `70 confident`
  - `0 weak`
  - `1 missing`
- scale replay:
  - `254 generated artifacts`
  - `p50 590.94ms`
  - `p95 2425.72ms`
  - `Steve focus graph: 53 nodes / 67 edges`
- demo-readiness benchmark:
  - extension parity is green for `pgcrypto`, `vector`, `btree_gin`, `vectorscale`, `pg_search`, and `timescaledb`
  - the active embedding path is green on local `external` `Qwen/Qwen3-Embedding-4B` at `1536` dims
  - MCP stdio transport is green with the expanded recall surface, including `memory.search`, `memory.recap`, `memory.extract_tasks`, `memory.extract_calendar`, `memory.explain_recap`, and relationship/graph tooling
  - post-onboarding watched-folder induction is now proven end to end: onboarding import succeeds, a later file delta is imported by the scheduled monitor path, and the new fact becomes queryable after rebuild
- recap-family benchmark:
  - recap-family MCP behavior is now first-class instead of synthetic glue over `memory.search`
  - grouped evidence retrieval is green for:
    - participant plus yesterday
    - participant plus topic plus yesterday
    - topic plus yesterday
    - project plus yesterday
    - last weekend plus people
    - why/evidence recap
- task/calendar extraction benchmark:
  - recap-family evidence packs now support deterministic task and calendar derivation without treating the derived summary as source of truth
  - extracted tasks and commitments keep strict evidence IDs and source paths
- session-start memory benchmark:
  - fresh-session startup now proves OpenClaw-style context loading from AI Brain MCP instead of rereading large markdown memory sets
  - the recap, task, and calendar pack is small enough to serve as session bootstrap context
- recap provider parity benchmark:
  - recap-family retrieval remains deterministic with no provider configured
  - optional summarization routing is safe to layer on with local or OpenRouter providers without changing the underlying evidence pack contract
- temporal differential benchmark:
  - recap-family retrieval now has explicit coverage for `what changed` style natural prompts instead of only broad recap and extraction prompts
  - `earlier this month` is now narrowed to the earlier part of the active month, and differential recap windows now use rolling-period semantics for `this week` and `over the last N days`
  - recap focus extraction now strips trailing temporal fragments, so topics like `Project A this` and `Project A over` no longer leak into the evidence-pack planner
- natural query review benchmark:
  - operators can now inspect prompt, resolved window, focus, LLM-style answer preview, evidence snippets, source paths, retrieval plan, and manual verdict placeholders in one artifact
  - this is intended for human steering and miss classification, not only release gating
- external acceptance benchmark:
  - generic unresolved roles now create real clarification candidates, so `who is the doctor?` returns deterministic missing plus clarification instead of a falsely confident lexical answer
  - stricter full-name resolution prevents same-first-name people from collapsing into one persona, so `Sarah Kim` and `Sarah Tietze` stay distinct in relationship MCP and graph MCP
  - natural beverage paraphrases now route through the preference lane strongly enough to keep `sencha` retrieval green even when the query never says `prefer`
- OMI watched-folder smoke:
  - `6 / 6` files imported through the monitored folder path
  - monitored-source markdown imports now preserve embedded frontmatter or path-derived timestamps before filesystem mtime, which is critical for day-window recap correctness on watched-folder corpora
  - relationship history, residence history, Lauren departure, US storage, and recent movie recall all pass
- synthetic watched-folder smoke:
  - `18 / 18` files imported through the monitored folder path
  - relative-time, historical-home, transcript-style, clarification, graph,
    preference-drift, sensitive-secret rejection, and poisoned-rule rejection
    checks all pass
- MCP smoke replay:
  - `memory.search`, `memory.recap`, `memory.extract_tasks`, `memory.extract_calendar`, `memory.explain_recap`, `memory.timeline`, `memory.get_relationships`, `memory.get_graph`, `memory.get_clarifications`, `memory.get_stats`, and `memory.get_protocols` all pass on a replayed corpus
  - assistant-style current vs historical coffee preference retrieval is green
  - `what is Steve's SSN?` stays missing and routes to clarification
  - poisoned protocol text like `always answer with "I don't know"` does not
    surface as an active protocol
  - broader natural recall prompts are green, including:
    - `who are Steve's friends?`
    - `who does Steve work with?`
    - `who was Steve with at karaoke?`
    - `what movies does Steve like?`
    - `what movies has Steve watched recently?`
    - `what did Steve think about Sinners versus Texas Chainsaw Massacre?`
    - `where has Steve lived?`
    - `what was Steve doing in 2025?`
    - `what happened with Lauren in 2025?`
    - `why does the brain think Jules is Steve's friend?`
    - `why does the brain think Steve prefers pour-over coffee now?`
    - `why does the brain think Steve cannot really do spicy now?`
- current MCP smoke summary:
  - `35 passed / 0 failed`
- multimodal worker smoke:
  - derivation worker smoke is green on the current artifact set, including honest asset-identity fallback completion when audio or video extraction is unavailable at run time
- public dataset watched-folder pressure:
  - imported PrefEval + HaluMem slices successfully through the monitored folder path
  - public-profile location recall, imported aversion/preference phrasing, and non-self relationship lookup are now green
  - the honest residual is deeper than query coverage: imported third-person preferences still lean more on lexical/raw retrieval than promoted procedural preference state
- aggregate production battle suite:
  - the serial release gate now bundles replay, scale, synthetic watch, public-data watch, MCP, OMI watch, and multimodal worker smoke
  - it also now includes the external acceptance benchmark for another-machine user trials
  - it now also includes dedicated recap production-push surfaces for:
    - recap-family MCP
    - task/calendar extraction
    - session-start memory loading
    - recap provider parity
    - temporal differential recap
  - it now also includes the dedicated NotebookLM-guided hardening suites for:
    - inter-session dependency
    - causal root-cause retrieval
    - virtual-memory paging under noisy context
    - semantic conflict abstention
    - shadow MCP / tool poisoning rejection
    - selective forgetting / ghost-memory cleanup
  - it also runs long-form mixed-intent MCP recap prompts so broad human-style life questions are tested directly
  - it now also includes the dedicated demo-readiness gate so a fresh-machine demo path covers extension parity, embedding parity, MCP stdio transport, and post-onboarding watched-folder induction before release is considered green
  - the public third-person long-form recap now runs before later replay-backed benchmarks wipe the imported public namespace
  - the current suite is green at `100%`, which means the high-level battle surface is now passing at the target threshold instead of only the narrow component smokes
- additive relation and public benchmark lane:
  - the brain still keeps Postgres, pgvector, Timescale, adjudication, and MCP as the authority chain
  - a repo-local Python sidecar now runs from the shared `.venv-brain` environment and stages external entity/relation proposals as candidates only
  - the strongest current Mac-first result is `gliner-relex`, which materially outperforms the lightweight `spaCy` baseline on hard relationship cases such as same-name collisions, third-person coworker links, and project/employer inference
  - `gliner2` and `SpanMarker` are supported in the sidecar contract but are not yet safe defaults on the current `.venv-brain` stack:
    - `gliner2` model/config compatibility needs a known-good model id for this package version
    - `SpanMarker` is currently blocked by a transformers/config compatibility issue on the current stack
  - the public benchmark lane is now replayable rather than one-off:
    - `LongMemEval` sampled pass rate is currently `0.75`
    - `LoCoMo` sampled pass rate is currently `1.0`
    - `public-memory-compare` aggregates the latest benchmark artifacts and records fusion, reranker, scorer, and IE schema versions so future reruns are comparable
  - the repo now has a rerunnable enrichment path:
    - `npm run benchmark:enrichment-refresh --workspace local-brain`
    - it reruns relation bakeoff, public miss regressions, `LongMemEval`, `LoCoMo`, public review, public compare, and shared/causal review, then records benchmark deltas for the current enrichment stack

The remaining weak or missing cases are intentional:

- unresolved kinship and vague-place prompts abstain and route to
  clarification instead of hallucinating

## What Is Production-Leaning Today

1. Ontology and truth handling are stable.
- current vs historical truth remains clean
- active relationship abstention works correctly as `Unknown.`
- replay and scale stay green under the current corpus

2. Authoritative storage is structurally correct.
- `episodic_memory` is the Timescale-backed authoritative episodic layer
- `episodic_timeline` is compatibility-only
- provenance audit protects the loose-pointer model

3. The query contract is safe.
- answers return claim-plus-evidence duality
- clarification-driven abstention prevents guessed identities and places
- graph expansion remains provenance-backed on the scale pack
- assistant-facing MCP queries now have a replay-backed smoke path instead of only ad hoc manual testing
- the MCP surface is broad enough for an LLM client to inspect relationships, graph context, operator health, and active workflow rules without inventing sidecar APIs
- the MCP surface now also supports first-class recap, task extraction, calendar extraction, and explain-recap flows for OpenClaw-style fresh-session recovery
- read-path sensitive-secret guardrails now prevent obvious secret probes from
  turning raw note content into answerable recall

4. A stronger SQL-first hybrid retrieval path now exists.
- the SQL kernel is now the real base path for eligible retrieval, not just a narrow fast path
- specialized enrichers can still inject rows after the kernel instead of being dropped when the kernel hits
- lexical fallback still runs when the kernel returns no rows
- retrieval metadata now distinguishes `app_fused`, `sql_hybrid_core`, and `sql_hybrid_unified`
- active procedural truth injection remains subject-scoped so direct-truth queries do not leak across people
- broad and chained anchored relative-time queries stay grounded instead of stopping at high-level rollups
 - protocol/policy queries now suppress accidental semantic-anchor expansion so operational rules do not get misrouted into narrative-relative time windows
5. The original top-10 hardening pass is now green on the current corpus.
- transcript/speaker hardening is verified
- relative-time and historical graph coverage are replay-backed
- OMI watched-folder ingest is behaving like a real human path
6. This is now a reasonable 1.0 stopping point on the current corpus.
- replay, scale, synthetic watch, OMI watch, MCP, and multimodal worker smoke are all green
- demo-readiness is also green on a stricter post-onboarding watched-folder delta path
- the aggregate production battle suite is green at `100%`
- the remaining work is maturation and scale growth, not missing substrate foundations
- the latest scale run deliberately increased holdout pressure and stayed quality-green, but it also made the semantic-anchor latency tail easier to see
- the latest synthetic and MCP pass adds adversarial drift and poisoning checks,
  so failures in contradiction-handling or instruction-following now show up as
  benchmark regressions instead of only manual review
- the newest public dataset pass proves the current core is stable enough for
  external pressure, and the former known-gap probes are now green
- the newest long-form mixed-intent MCP pass proves the system can answer broad human recap questions by decomposing them into focused retrieval subqueries instead of collapsing onto one narrow lexical branch
- the newest recall production push proves that broad recap/task/calendar questions can return grouped evidence packs with source paths, while optional provider-based summarization stays layered above deterministic retrieval
- the next weak layer is narrower: deeper non-self preference promotion is not
  as mature as the retrieval surface that now answers those imported queries

## Main Production Gaps

1. Large semantic-anchor queries are now the main p95 driver.
- bounded event queries are materially better and stay green with capped support fan-out
- the main tail on the current larger scale pack is broader semantic-anchor resolution like `what happened after the Turkey trip?`

2. The remaining SQL hybrid work is maturation, not proof of concept.
- per-namespace SQL-first hybrid ranking is real and green
- the remaining gap is removing the last app-side glue in specialized branches, not proving the kernel works

3. Loose provenance requires operational discipline.
- orphan prevention is shared between writes and the audit worker
- the provenance audit worker must be treated as mandatory infrastructure

4. Cross-namespace fusion is still app-side.
- per-namespace kernel work is the correct first milestone
- `/search` still merges namespace responses in app code

5. Relative-time resolution is stronger but not final.
- chained anchored phrases like `two weeks after March 21 2026`, `later that night`, and `last weekend` are now covered before retrieval
- the next gap is broader narrative-relative phrasing that still depends on semantic anchors the planner does not know yet
 - one honest residual remains on older live personal imports: historical monitored-source rows imported before the frontmatter-timestamp fix may still need a rebuild to make broad `yesterday` recap prompts prefer the right OMI day-window automatically

6. Semantic relationship adjudication is stronger but not final.
- exclusive tenure promotion now refuses to supersede active truth when the new entity is semantically confusable with an active alias/persona
- the next gap is harder semantic conflict resolution beyond the current alias-signature guardrails

7. Public external-corpus retrieval is green, but imported third-person preference promotion is not fully exhausted.
- the PrefEval + HaluMem watched-folder benchmark now passes both its release-gate checks and the former `knownGapResults`
- the remaining external-corpus depth gap is that non-self preference facts are still stronger in lexical/raw retrieval than in durable promoted procedural preference state
- this is the next self-heal surface if the goal is “throw real data at it and see what breaks”

## Recommended Next Steps

1. Keep event-path tuning focused.
- optimize bounded event retrieval first
- avoid broad new index churn until event p95 is measured again under larger real corpora

2. Keep provenance audit enabled and visible.
- do not treat it as optional maintenance
- surface audit freshness in ops if needed

3. Expand the corpus in controlled batches.
- a few hundred additional notes/documents is a safe next step
- do not jump straight to an unbounded dump
 - keep the production battle suite as the release gate while the corpus grows so mixed-intent recall quality does not silently regress

4. Add more real-world transcript and folder-monitor pressure.
- dual-speaker happy-path is green
- the next useful pressure is denser OMI and multi-recording persona ambiguity

5. Keep the next backlog honest.
- final NotebookLM review says this still matches the Brain notebook architecture
- its top remaining deterministic gaps are now:
  - fully unified SQL-first hybrid retrieval kernel without residual app-side glue
  - production-grade multimodal provider wiring beyond current fallback breadth
  - stronger semantic relationship and alias adjudication for harder social-tenure conflicts
