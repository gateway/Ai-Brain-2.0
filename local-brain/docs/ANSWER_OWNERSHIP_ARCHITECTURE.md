# Answer Ownership Architecture

## Problem

The system was no longer failing because typed canonical structures were missing.
It was failing because the wrong owner still won too often:

- `canonical_report`
- `canonical_temporal`
- `canonical_list_set`
- `canonical_exact_detail`
- `top_snippet`
- `canonical_abstention`

This caused split-brain behavior:

- the correct typed candidate existed
- but subject binding, generic exact detail, snippet fallback, or early abstention blocked it
- benchmark quality lagged the architecture

## Final Routing Model

Answer ownership now follows a first-class policy instead of scattered fallback heuristics.

Flow:

1. subject binding
2. family classification
3. family candidate assembly
4. owner resolution
5. final rendering
6. benchmark trace capture

The owner-policy implementation lives in:

- [answer-owner-policy.ts](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/retrieval/answer-owner-policy.ts)

## Owner Families

The resolver classifies each query into one owner family before picking a winner:

- `report`
- `temporal`
- `list_set`
- `exact_detail`
- `abstention`
- `generic`

Family examples:

- report:
  - favorite / preference / likely / would / bookshelf / degree / dreams / goals
- temporal:
  - when / which year / which month / start / join / launch / begin / first
- list_set:
  - commonality / country / shared / gifts / planned meeting places

## Owner Precedence

The resolver only lets lower-quality owners compete when stronger typed owners are not eligible.

### Report family

Winner order:

1. `canonical_report`
2. `canonical_narrative`
3. `canonical_exact_detail`
4. `canonical_list_set`
5. `canonical_temporal`
6. `canonical_abstention`
7. `top_snippet`

Suppression rules:

- if a typed report owner is eligible, suppress:
  - `canonical_exact_detail`
  - `canonical_abstention`
  - `top_snippet`

### Temporal family

Winner order:

1. `canonical_temporal`
2. `canonical_exact_detail`
3. `canonical_abstention`
4. `top_snippet`

Suppression rules:

- if an event-keyed temporal owner is eligible, suppress:
  - `canonical_exact_detail`
  - `canonical_abstention`
  - `top_snippet`

### List / set family

Winner order:

1. `canonical_list_set`
2. `canonical_exact_detail`
3. `canonical_abstention`
4. `top_snippet`

Suppression rules:

- if a typed list/set owner is eligible, suppress:
  - `canonical_exact_detail`
  - `canonical_abstention`
  - `top_snippet`

### Abstention

`canonical_abstention` is only allowed to win after typed and generic eligible owners are exhausted.

`top_snippet` never suppresses abstention.

## Subject Binding Rules

The resolver now treats explicit subject anchors as authoritative before abstention:

- possessive anchors still force single-subject plans
- explicit primary names now also force single-subject plans
- canonical adjudication now uses the subject plan when deciding whether subject binding is truly missing

That means:

- explicit-name queries no longer abstain just because retrieval stayed mixed
- subject-plan resolution can keep the query on a typed owner path even if canonical binding status is not fully `resolved`

Key files:

- [canonical-subject-binding.ts](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/retrieval/canonical-subject-binding.ts)
- [subject-plan.ts](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/retrieval/subject-plan.ts)
- [canonical-adjudication.ts](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/retrieval/canonical-adjudication.ts)

## Typed Owners

### Reports

Reports use typed payloads such as:

- `bookshelf_inference`
- `preference_value`

This avoids rendering from dirty freeform summaries.

Reports also support runtime evidence-backed re-synthesis when the stored canonical
row is structurally correct but its persisted summary text is degraded.

That runtime layer now:

1. filters recall results to the explicit named subject when present
2. collects report support text from:
   - recall result content
   - provenance sentence / turn text
   - subject-bound source backfill from `source_uri`
   - full source backfill when needed
3. derives a family-specific report answer from that support pool
4. keeps the typed report owner in control instead of falling back to generic owners

This is how `profile_report` now answers financial-status questions from real
same-subject evidence even when the stored canonical summary is polluted.

Key files:

- [service.ts](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/canonical-memory/service.ts)
- [narrative-reader.ts](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/canonical-memory/narrative-reader.ts)
- [narrative-adjudication.ts](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/retrieval/narrative-adjudication.ts)
- [report-runtime.ts](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/retrieval/report-runtime.ts)

### Temporal

Temporal answers use typed event identity:

- `event_key`
- `event_type`
- `time_granularity`
- `answer_year`
- `answer_month`
- `answer_day`

Selection prefers event identity before generic date text similarity.

### List / set

List and pair answers use `canonical_set_entries` with typed values:

- `country`
- `city`
- `gift`
- `venue`
- other typed values as available

Pair lookups already intersect typed entries.
Single-subject list/set lookups now also prefer typed entry values when the query requests:

- country
- symbolic gift
- meeting place / venue

## Tracing

Each response can now expose `answerOwnerTrace` through response metadata.

Answer shaping is now traced separately through `answerShapingTrace` so wrong
winners can be separated from right-owner / wrong-shape failures.

Trace shape:

```json
{
  "family": "report",
  "reasonCodes": ["family:report", "explicit_subject_query"],
  "resolvedSubject": {
    "bindingStatus": "resolved",
    "subjectPlanKind": "single_subject",
    "subjectId": "person:caroline",
    "subjectName": "Caroline"
  },
  "eligibleOwners": ["canonical_report"],
  "suppressedOwners": [
    {
      "owner": "top_snippet",
      "reason": "structured_owner_precedence"
    }
  ],
  "winner": "canonical_report",
  "fallbackPath": ["canonical_report", "top_snippet"]
}
```

This trace is now carried through benchmark parsing in:

- [locomo.ts](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/benchmark/locomo.ts)

### Shaping Trace

Representative shape:

```json
{
  "mode": "runtime_report_resynthesis",
  "selectedFamily": "report",
  "typedValueUsed": false,
  "runtimeResynthesisUsed": true,
  "supportRowsSelected": 3,
  "supportSelectionMode": "explicit_subject_filtered",
  "supportTextsSelected": [
    "Caroline filled a room with classic children's books.",
    "The library corner for kids kept growing every month."
  ]
}
```

Current shaping modes:

- `typed_report_payload`
- `runtime_report_resynthesis`
- `stored_report_summary`
- `typed_temporal_event`
- `temporal_text_fallback`
- `typed_set_entries`
- `mixed_string_set`
- `stored_canonical_fact`
- `support_span_extraction`
- `snippet_fallback`
- `abstention`

## Answer Shaping Stabilization

The next wall after owner-policy work was answer shaping:

- support rows were selected correctly often enough
- but renderers still converted rows or summaries straight into freeform answer prose
- typed payloads were present in parts of the system, but were weakened back into strings before the final renderer

The shaping gap was:

1. retrieved rows
2. ad hoc support text extraction
3. family-local string logic
4. final answer text

That made it hard to tell whether a failure was:

- wrong owner
- right owner with missing support normalization
- right owner with a weak render contract

### Support Object Layer

This pass introduced a shared support-object layer in:

- [support-objects.ts](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/retrieval/support-objects.ts)

Current support objects:

- `CollectionInferenceSupport`
- `ProfileInferenceSupport`
- `TemporalEventSupport`
- `ListSetSupport`
- `DirectDetailSupport`

These normalize family-specific support before rendering.

Pipeline now:

1. retrieved rows or stored canonical value
2. support-object builder
3. family render contract
4. constrained final answer renderer

### Render Contracts

#### `canonical_report`

Report rendering now prefers:

1. typed payloads
2. normalized support objects
3. stored summary fallback only when needed

Implemented report contracts include:

- `collection_yes_since_collects`
- `collection_value`
- `collection_summary_fallback`
- `report_scalar_value`
- `preference_value`

This keeps bookshelf / preference / financial-status answers from drifting into freeform prose.

#### `canonical_temporal`

Temporal rendering now uses a `TemporalEventSupport` object and renders from one event identity.

Contracts:

- `temporal_year`
- `temporal_month`
- `temporal_day`
- `temporal_fallback`

If `answer_year` is present and the question asks for a year, the renderer emits the year directly instead of replaying a noisier stored sentence.

#### `canonical_list_set`

List/set rendering now uses `ListSetSupport` when typed entries exist.

Contracts:

- `typed_set_join`
- `mixed_set_join`

Typed-entry rendering enforces:

- typed values over mixed strings
- dedupe
- stable ordering

Untyped set families that already have stronger domain formatting remain on their existing formatter.

#### `canonical_exact_detail`

Exact-detail shaping now has a direct support object path:

- `DirectDetailSupport`

Contract:

- `exact_support_span`
- `exact_canonical_value`

This is for tight support-span answers, not paraphrase generation.

### New Shaping Trace Fields

`answerShapingTrace` now includes:

- `supportObjectsBuilt`
- `supportObjectType`
- `supportNormalizationFailures`
- `renderContractSelected`
- `renderContractFallbackReason`
- existing typed flags:
  - `typedValueUsed`
  - `generatedProseUsed`
  - `runtimeResynthesisUsed`

Representative shape:

```json
{
  "selectedFamily": "report",
  "shapingMode": "typed_report_payload",
  "supportObjectsBuilt": 1,
  "supportObjectType": "CollectionInferenceSupport",
  "supportNormalizationFailures": [],
  "renderContractSelected": "collection_yes_since_collects",
  "renderContractFallbackReason": null,
  "typedValueUsed": true,
  "generatedProseUsed": true,
  "runtimeResynthesisUsed": false,
  "supportRowsSelected": 2,
  "supportTextsSelected": 4,
  "supportSelectionMode": "explicit_subject_filtered"
}
```

### What This Pass Fixed

- strict bookshelf queries now route through profile/report support instead of `current_state`
- collection inference can normalize classics-heavy children’s-book evidence without literal bookshelf wording
- report rendering uses normalized support objects instead of family-local freeform string assembly
- temporal rendering can emit year/month/day directly from typed event identity
- typed list/set answers now expose render-contract and support-object traces
- exact-detail support-span shaping is now explicitly represented in the support-object layer

### Debugging Remaining Shaping Families

When a shaping failure remains:

1. inspect `answerOwnerTrace` to confirm the owner family is correct
2. inspect `answerShapingTrace.supportObjectType`
3. inspect `supportNormalizationFailures`
4. inspect `renderContractSelected`
5. inspect `renderContractFallbackReason`

Use that to decide whether the next fix is:

- support normalization
- render contract tightening
- runtime support assembly
- or owner-policy suppression
- `stored_report_summary`
- `typed_temporal_event`
- `temporal_text_fallback`
- `typed_set_entries`
- `mixed_string_set`
- `stored_canonical_fact`
- `support_span_extraction`
- `snippet_fallback`
- `abstention`

These fields let us distinguish:

- wrong owner
- right owner, wrong shape
- right owner, incomplete support
- temporal rendering mistakes
- report semantics mistakes
- list/set rendering mistakes
- honest abstention with insufficient support

### Shaping Diagnosis

LoCoMo artifacts now include `shapingDiagnosisBreakdown` and per-result
`shapingDiagnosis`.

Current diagnosis classes:

- `wrong_owner`
- `right_owner_wrong_shape`
- `right_owner_incomplete_support`
- `temporal_rendering_wrong`
- `report_semantics_wrong`
- `list_set_rendering_wrong`
- `subject_binding_missing`
- `honest_abstention_but_support_missing`
- `not_applicable`

When debugging a wrong report winner, also inspect:

1. `reportKind`
2. `narrativeSourceTier`
3. `narrativeCandidateCount`
4. `canonicalSubjectBindingStatus`
5. the winning `answerSnippet`
6. whether the final text came from typed payload or runtime report re-synthesis

Representative fixed case:

- query: `What might John's financial status be?`
- winner: `canonical_report`
- suppressed:
  - `canonical_exact_detail` via `typed_report_owner_precedence`
  - `top_snippet` via `structured_owner_precedence`
- final text: `Middle-class or wealthy`

When debugging the current shaping campaign, use this checklist:

1. inspect `answerOwnerTrace.family`
2. inspect `answerShapingTrace.mode`
3. inspect `shapingDiagnosis`
4. inspect whether a typed value was available
5. inspect whether runtime re-synthesis was used
6. inspect support-row counts and support-selection mode
7. inspect temporal identity fields or typed set entries if the family is temporal or list/set

## Benchmark Hardening

LoCoMo benchmark preflight now validates:

1. benchmark namespace residue cleanup
2. required canonical tables exist:
   - `canonical_narratives`
   - `canonical_entity_reports`
   - `canonical_pair_reports`
   - `canonical_set_entries`
   - `canonical_temporal_facts`

This is meant to stop false benchmark failures caused by DB/schema drift.

## Commands

Core verification:

```bash
cd /Users/evilone/Documents/Development/AI-Brain/ai-brain
npm run build --workspace local-brain
npm run test:canonical-memory-review --workspace local-brain
npm run test:canonical-adjudication-review --workspace local-brain
npm run test:answer-owner-policy-review --workspace local-brain
npm run test:answer-shaping-review --workspace local-brain
```

LoCoMo lane:

```bash
cd /Users/evilone/Documents/Development/AI-Brain/ai-brain
npm run build --workspace local-brain
npm run benchmark:locomo:mini --workspace local-brain
```

## Shaping Campaign Status

This pass introduced:

- first-class `answerShapingTrace`
- benchmark-side `shapingDiagnosisBreakdown`
- family-specific shaping micro-suite coverage
- richer subject-bound report support assembly for report-family shaping
- stricter bookshelf / collection synthesis from real support phrasing such as:
  - `kids' books`
  - `classics`
  - `educational books`
- profile-inference routing for strict bookshelf queries so they no longer stay in
  `current_state` mode and prune the branches needed to recover the supporting
  session evidence

The current remaining frontier is no longer only owner precedence. It is:

- report support assembly and report semantics
- temporal event rendering
- list/set rendering completeness
- exact-detail span compression quality

Use the new shaping traces first before touching owner precedence again.

Most recent ownership stabilization checkpoint:

- mini LoCoMo artifact:
  - [locomo-2026-04-06T11-12-32-755Z.md](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/locomo-2026-04-06T11-12-32-755Z.md)
- pass rate:
  - `1.0`

Most recent shaping verification checkpoint:

- test suite:
  - `npm run test:answer-shaping-review --workspace local-brain`
- status:
  - green

Latest shaping-family regression added in this pass:

- `Would Caroline likely have Dr. Seuss books on her bookshelf?`
  - now must route as `broad_profile` in the recovery layer
  - collection synthesis must recognize indirect support text like
    `kids' books`, `classics`, and `educational books`
  - live benchmark confirmation still depends on rerunning the benchmark slice
    after the currently active benchmark lane releases the benchmark DB lock

## Noise Cut

The routing model now explicitly suppresses generic-owner drift:

- `top_snippet` is fallback-only when any structured owner is eligible
- `canonical_exact_detail` no longer beats report/temporal/list-set owners just because it exists
- abstention is last, not early

This is the core production rule:

Typed owners do not just exist in the graph.
They must win when they are eligible.
## Shaping Pipeline Coverage

The shaping layer is now traced as a first-class coverage surface, not just a rendering detail.

Every answer shaping trace can now expose:

- `shapingPipelineEntered`
- `supportObjectAttempted`
- `renderContractAttempted`
- `bypassReason`

Current high-signal bypass reasons include:

- `direct_detail_contract_not_entered`
- `report_render_contract_not_entered`
- `temporal_support_contract_not_entered`
- `list_set_support_contract_not_entered`
- `generic_snippet_fallback`
- `abstention_final_fallback`

The largest live bypass path found during the full-corpus campaign was `canonical_exact_detail` rows that stayed on `stored_canonical_fact` and never entered `DirectDetailSupport`. That path is now wired through direct-detail normalization even when the stored canonical fact is strong.
