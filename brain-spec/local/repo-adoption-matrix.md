# Repo Adoption Matrix

| Source Repo | Source Area | License | Problem Here | Decision | Why | Destination In This Repo |
| --- | --- | --- | --- | --- | --- | --- |
| `aiming-lab/SimpleMem` | README pipeline and `test_locomo10.py` evaluation shape | MIT | Evidence still arrives too raw and support completeness is uneven | Adapt | The repo already has support objects and planner scaffolding; we need stronger atomic units, synthesis, and missing-field-aware backfill, not a second store | `local-brain/src/retrieval/types.ts`, `local-brain/src/retrieval/answer-retrieval-plan.ts`, `local-brain/src/retrieval/support-objects.ts`, `local-brain/src/retrieval/service.ts` |
| `microsoft/graphrag` | local-search docs/notebooks around entity extraction, text units, and community reports | MIT | Wrong-pool and exact-detail takeover still beat typed family routing | Adapt | Candidate-pool and suppression-pool ideas fit the current owner-policy pipeline without replacing indexing/storage | `local-brain/src/retrieval/answer-retrieval-plan.ts`, `local-brain/src/retrieval/answer-owner-policy.ts`, `local-brain/src/retrieval/service.ts` |
| `getzep/graphiti` | `graphiti_core/graphiti.py`, `nodes.py`, `edges.py`, `search/`, `server/graph_service/`, `mcp_server/graphiti_mcp_server.py` | Apache-2.0 | Temporal rows still degrade into snippet gravity and event identity loss | Adapt | The repo already stores temporal facts; the missing step is making them a first-class planner pool and support source with validity/provenance carried forward | `local-brain/src/canonical-memory/service.ts`, `local-brain/migrations/051_canonical_temporal_fact_support.sql`, `local-brain/src/retrieval/support-objects.ts`, `local-brain/src/retrieval/answer-retrieval-plan.ts` |
| `aexy-io/graphzep` | `src/zep/memory.ts`, `src/zep/session.ts`, `src/zep/retrieval.ts`, `src/zep/types.ts`, `server/src/dto`, `mcp_server/src/graphzep-mcp-server.ts` | Apache-2.0 | Planner, retrieval, and memory DTO boundaries are still too soft | Adopt pattern | The module split and TS DTO style map directly to this codebase and improve maintainability without importing graph storage | `local-brain/src/retrieval/types.ts`, `local-brain/src/retrieval/answer-retrieval-plan.ts`, `local-brain/src/retrieval/service.ts`, `local-brain/test/*review.mjs` |

## Reject / Do Not Import

| Source Repo | Reject Scope | Why |
| --- | --- | --- |
| `aiming-lab/SimpleMem` | full runtime and storage stack | This repo already has a Postgres-centered substrate and canonical tables |
| `microsoft/graphrag` | full indexing / graph build pipeline | Too heavy for the current failure mode; we need runtime planner control, not a parallel indexing system |
| `getzep/graphiti` | graph DB runtime | Temporal fact modeling is useful; replacing persistence/runtime is not |
| `aexy-io/graphzep` | full memory graph storage layer | Useful for TS organization, not as a drop-in substrate |

## Immediate Adoption Slice

1. Make `answer-retrieval-plan.ts` the runtime control plane for family, pools, suppression, and targeted backfill.
2. Strengthen `AtomicMemoryUnit` so evidence-to-support normalization carries chunk/provenance and temporal hooks.
3. Let rendered typed support override stored-fact exact-detail ownership when planner/report/list-set lanes are already active.
4. Promote persisted temporal facts into planner candidate pools instead of leaving them as storage-only support.

## Adopted In Current Loop

| Pattern | Applied Change | Notes |
| --- | --- | --- |
| SimpleMem atomic unit boundary | `AtomicMemoryUnit` now carries planner family, support class, lexical match terms, and richer targeted backfill DTOs | Keeps evidence normalization reusable before shaping |
| GraphRAG typed pool planning | Retrieval plan now carries explicit lane, candidate pools, suppression pools, rescue policy, and family confidence | Used directly by owner policy and shaping traces |
| GraphRAG owner suppression | Planner-family suppression now demotes exact-detail when a typed lane is already viable | Prevents report/list-set rows from collapsing back into exact-detail |
| GraphZep DTO discipline | Shared retrieval plan fields were promoted into `types.ts` and traced end-to-end | Keeps planner/service/adjudication boundaries explicit |
| SimpleMem support synthesis before rendering | `service.ts` now builds a runtime `canonical_report` candidate from normalized support objects before owner selection | Lets typed report support compete before abstention or snippet fallback |
| SimpleMem missing-field-aware rescue | Collection support now forces one targeted rescue when support text volume is high but explicit collection cues are missing | Prevents dense but irrelevant evidence pools from faking collection completeness |
| GraphRAG deterministic pool filtering | Generic collection queries now reject incidental theme mentions without explicit collection cues | Tightens runtime pool selection without introducing a second store |
| SimpleMem compact fact normalization | Collection support now normalizes explicit `collects` evidence into scored per-value facts with cue strength, subject match, and item-count preference | Gives report shaping a typed fact boundary instead of flat payload fallback competition |
| GraphRAG typed pool preference | Planner-confirmed collection rows now keep exact-detail suppressed while typed collection facts compete by score | Confirms the remaining John-style failures are inside typed value selection, not owner routing |
| SimpleMem missing-field-aware completeness | Generic collection set renders now require a minimum entry threshold for plural item queries | Prevents one-item partial answers from masquerading as complete collection support |
| SimpleMem support synthesis | Subject-bound collection fragments can now merge across multiple compatible cues (`collection includes`, `has a collection of`, `likes collecting`) before rendering | Moves collection inference closer to atomic entry synthesis rather than single-scalar selection |
| GraphZep trace discipline | Planner targeted-backfill telemetry now threads into `answerShapingTrace` instead of living only in top-level benchmark metadata | Makes the next bottleneck measurable at the shaping layer |
| SimpleMem atomic support-unit boundary | `AtomicMemoryUnit` now carries nested `absoluteDate`, `relativeAnchor`, and explicit `cueTypes` at extraction time | Keeps evidence compact and typed before support shaping or diagnostics |
| SimpleMem atomic support-unit boundary | Normalized collection facts now expand into first-class `AtomicMemoryUnit` entries before report shaping | Stops persisted collection facts from being rediscovered only through mixed raw recall text |
| SimpleMem semantic synthesis | Causal/profile support now synthesizes deterministic reason text from explicit causal clauses before falling back to generic scalar rendering | Splits Gina-style `why` rows out of `report_scalar_value` |
| GraphRAG family-aware filtering | Planner-confirmed report lanes now preserve typed causal/profile shaping instead of treating every profile row as one scalar contract | Keeps report family contract choice aligned with query intent |
| GraphRAG typed pool consumption | Planner-owned collection lanes now feed normalized collection-fact atomic units directly into `CollectionSetSupport` completeness scoring | Makes candidate-pool choice materially affect support construction rather than only traces |
| GraphRAG entity-first pool access | Planner-owned collection fact reads now fall back to namespace-scoped subject-name binding when entity-id resolution is absent | Keeps the `normalized_collection_facts` pool live for explicit-subject collection rows instead of silently dropping back to abstention |
| GraphRAG typed candidate-builder pattern | Collection inference now has a dedicated persisted-fact candidate builder instead of depending only on the mixed report-results lane | Makes `normalized_collection_facts` a first-class runtime candidate family rather than a helper input |
| GraphZep retrieval/service boundary | Added `planner-typed-candidates.ts` so collection, temporal, and profile candidates are built in a dedicated runtime module instead of a monolithic service path | Makes typed candidate families explicit and testable before owner resolution |
| GraphRAG typed candidate families | Runtime now emits planner-owned collection, temporal, and profile candidates before generic narrative fallback | Stops typed facts from being treated as mere support inputs and moves them into direct owner competition |
| Graphiti temporal fact promotion | Persisted temporal facts can now materialize a planner-first `canonical_temporal` candidate instead of waiting for later generic adjudication | Makes `canonical_temporal_facts` act like a true planner lane |
| Graphiti temporal lookup routing | Runtime planner now classifies explicit `what year/month/date` queries into the temporal lane instead of leaving them in exact-detail | Aligns temporal fact pools with the same question patterns already recognized by canonical memory |
| Graphiti identity-first temporal reduction | Temporal support now reduces event-scoped candidate bundles and prefers earliest valid inception dates before rendering | Stops `start_/join_/launch_` queries from collapsing onto the first or latest parseable year in mixed temporal evidence |
| Graphiti fact-bundle validation | Added `temporal-pool-utils.ts` so temporal rows are grouped into event bundles, scored by evidence kind, and penalized when a query-supplied event key would otherwise attach to a generic dated row | Stops explicit event queries from pairing the right subject with the wrong year just because a canonical date exists |
| GraphRAG typed-pool seeding | `service.ts` now seeds planner runtime temporal results from `canonical_temporal_facts` the same way collection lanes are seeded from persisted collection facts | Makes typed temporal facts compete as first-class candidates before narrative/snippet fallback |
| Graphiti temporal fact eligibility | Stored and persisted temporal rows without an event key are now filtered by query-text alignment before they can act like first-class event facts | Prevents blank-event generic time fragments from outranking real event-aligned evidence in the temporal lane |
| GraphRAG aligned text-unit fallback | No-event temporal queries can now treat strongly aligned anchor text as a typed temporal candidate even when no canonical `event_key` exists | Lets Seattle-style location/activity anchors survive as first-class temporal evidence instead of dying as missing identity |
| SimpleMem missing-field causal synthesis | Causal/profile support now synthesizes startup-motive answers from trigger plus motive cues before generic scalar fallback | Moves Gina-style `why` rows toward typed causal support instead of weak report scalar summaries |
| GraphZep hybrid retrieval + Graphiti reranking | Added `planner-pool-ranker.ts` with hybrid pool scoring, Reciprocal Rank Fusion, and MMR-style reranking for collection, temporal, and profile lanes | Makes typed planner pools rank subject-bound, high-cue, diverse facts before support construction instead of treating all pool rows as equivalent |
| GraphRAG preselection before final ranking | Temporal pool ranking now preselects on event evidence + subject binding before truncation instead of slicing the incoming mixed result order | Prevents generic seeded canonical rows from crowding out later event-aligned raw rows |
| GraphRAG prioritized candidate pools | Planner/runtime candidates now carry the ranked pool results through support synthesis and owner materialization instead of reranking only for traces | Turns candidate-pool choice into runtime behavior rather than advisory metadata |
| SimpleMem atomic unit normalization | Added `recall-content.ts` so structured recall blobs are normalized into stable claim text before subject scoring, temporal extraction, or lexical ranking | Replaces the last raw JSON seam that was keeping typed temporal candidates from materializing in live benchmark rows |
| GraphRAG event-neighborhood binding | Temporal support now performs a bounded same-observation fan-out around aligned turns/source files and uses those neighborhood texts for event identity and date-part rescue | Gives temporal lanes a typed neighborhood context instead of relying on flat snippet competition |
| Graphiti temporal granularity fidelity | Generic schedule queries (`when is/are`) now render month-year directly when month-level support exists but day support does not | Prevents stale relative fragments from outranking better month-level temporal facts in scheduling rows |

## NotebookLM-Retained Heuristics

| Source | Prompt Focus | Retained Idea | Applied In Repo |
| --- | --- | --- | --- |
| `Enhancing AI Reasoning` notebook | deterministic ranking and rescue for planner-approved report lanes | Use hard lane floors/ceilings plus one rescue-before-fallback rule instead of soft generic recall competition | `local-brain/src/retrieval/service.ts`, `local-brain/src/retrieval/answer-owner-policy.ts` |
| `Enhancing AI Reasoning` notebook | generic collection/report failure under loose evidence selection | Require explicit collection cues and subject-bound scoring before accepting a collection value | `local-brain/src/retrieval/support-objects.ts`, `local-brain/src/retrieval/report-runtime.ts`, `local-brain/src/canonical-memory/report-synthesis.ts` |
| `Enhancing AI Reasoning` notebook | typed lane selected but support still under-completes | Prefer subject-scoped normalized facts as first-class units, then allow only one rescue-before-fallback pass | `local-brain/src/retrieval/answer-retrieval-plan.ts`, `local-brain/src/retrieval/support-objects.ts`, `local-brain/src/retrieval/service.ts` |
| `AI Brain 2.0 Local Brain Repo Deck 2026-03-18` notebook | collection/profile wrong-value rows after planner suppression already works | Prefer explicit multi-item collection facts over weak scalar summaries; treat scene-description fragments as incompatible unless the query is explicitly bookshelf-scoped | `local-brain/src/retrieval/support-objects.ts` |
