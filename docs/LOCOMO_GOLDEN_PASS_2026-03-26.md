# LoCoMo Golden Pass 2026-03-26

## Checkpoint 1: Current Reality

### What exists in live code

- Retrieval planner is real and live in `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/retrieval/planner.ts`.
  - It already emits `intent`, `queryClass`, temporal focus, depth budgets, branch preference, and lexical terms.
- Query-signal routing is real in `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/retrieval/query-signals.ts`.
  - It already distinguishes exact-detail, temporal-detail, relationship, recap, transcript, preference, goal, plan, belief, and other focus families.
- Hybrid retrieval is real in `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/retrieval/service.ts`.
  - SQL-first lexical plus vector fusion exists.
  - Graph expansion exists as a support lane, not as truth.
  - Topic/community summary boosts already exist.
- Recall vs reflect is real but only partially formalized in `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/retrieval/service.ts`.
  - `synthesisModeForQuery()` exists.
  - Recursive reflect exists through `buildRecursiveReflectSubqueries()`.
  - Reflect entry is still mostly heuristic plus a narrow exact-detail recovery path.
- Exact-answer shaping is already partially implemented in `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/retrieval/service.ts`.
  - `isStructuredExactAnswerQuery()`
  - `inferExactDetailQuestionFamily()`
  - `extractExactDetailValue(s)`
  - `deriveSubjectBoundExactDetailClaim()`
- Subject matching is already partially implemented in `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/retrieval/service.ts`.
  - `assessSubjectBinding()` exists.
  - Some primary-speaker and participant-bound filters already exist.
- Ingest shaping is already stronger than older docs imply in `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/ingest/worker.ts`.
  - lossless conversation units
  - topic segments
  - participant-bound derivations
  - community summaries
- MCP is thin and assistant-facing in `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/mcp/server.ts`.
  - It calls retrieval/ops services; core logic still lives in retrieval/runtime code.
- HTTP runtime is thin in `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/server/http.ts`.
  - It orchestrates ingest, retrieval, runtime workers, and ops; it is not the brain.
- Benchmarks are real and extensive in `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/benchmark`.
  - Honest LoCoMo ladder exists.
  - profile-routing / recursive-reflect / public-memory regressions / production-battle exist.
- Temporal and validity semantics already exist in the schema.
  - `semantic_memory` and `procedural_memory` have validity/supersession support.
  - `relationship_memory` has `valid_from`, `valid_until`, and supersession.
  - `memory_graph_edges` exists.

### What is partial

- Reflect control is partial.
  - `reflect` exists, but there is no explicit adequacy-gate module or closed recovery taxonomy.
- Subject resolution is partial.
  - There is post-hoc `subjectMatch`, but not a clean earlier resolver score that decisively filters mixed-subject exact-detail evidence before final assembly.
- Exact-answer assembly is partial.
  - Structured extraction exists, but it still falls back too often to raw snippet-like top claims or incomplete slot capture.
- Telemetry is partial.
  - LoCoMo captures `synthesisMode`, `sufficiency`, and `subjectMatch`, but there is no first-class `adequacy_status`, `missing_info_type`, or `reflect_helped_rate` in the retrieval response path.

### What is missing

- A formal query-mode hint separate from older heuristic reflect routing.
- A formal adequacy gate after first-pass recall.
- A closed missing-information taxonomy driving reflect.
- A bounded reflect planner keyed off missing-information type instead of mostly broad heuristics.
- A first-class exact-detail resolver score for subject-safe slot extraction.

### What is stale or drifted in docs

- Some docs speak as if recall/reflect and planner gating are already fully formalized. Live code shows they exist, but as embedded heuristics inside `retrieval/service.ts`, not as explicit control modules.
- Some docs read as if MCP is broad enough to imply core-brain ownership. Live code keeps MCP thin, which is the correct posture.
- Some docs imply the retrieval kernel is more fully unified and settled than the code suggests. Live code is strong, but still has app-side routing, pruning, and answer-shaping logic that remains hand-tuned.
- Older open-memory audit notes talk about adding recall vs reflect. Live code already has it; the real gap is upgrading it from heuristics into adequacy-gated recovery.

## Checkpoint 2: Honest benchmark reality before the next patch

- Honest LoCoMo standard lane artifact used for diagnosis:
  - `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/locomo-2026-03-25T16-19-57-169Z.json`
- Current known standard snapshot:
  - passRate: `0.42`
  - failureBreakdown:
    - `answer_shaping`: `25`
    - `alias_entity_resolution`: `15`
    - `temporal`: `11`
    - `abstention`: `6`
  - synthesisModeBreakdown:
    - `recall`: `95`
    - `reflect`: `5`

### Concrete failure pattern

- Many `answer_shaping` failures are already `supported` and `matched`, but the final claim text is still an incomplete exact value or a raw derivation-backed snippet.
- Many `alias_entity_resolution` failures are `mixed` or `mismatched` on direct-fact questions, which means wrong-subject or mixed-subject evidence is still entering exact-detail shaping too late.
- Reflect is too low, but the current evidence does not justify broadening it globally. The safer move is to formalize inadequacy-triggered recovery after first-pass recall.

## Checkpoint 3: Next patch plan

### Files likely to change

- `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/retrieval/types.ts`
- `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/retrieval/service.ts`
- `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/retrieval/query-signals.ts`
- new pure control helper under `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/retrieval/`
- new or updated test under `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/test/`

### Smallest safe slice

1. Add formal recovery-control enums and helper functions:
   - `query_mode_hint`
   - `reflect_eligibility`
   - `adequacy_status`
   - `missing_info_type`
2. Use those helpers in `searchMemory()` to:
   - keep exact-detail recall-first
   - escalate to reflect only on structured inadequacy
3. Tighten exact-detail subject safety:
   - stricter mixed-subject discard
   - stronger subject-bound candidate selection before slot normalization
4. Expose telemetry so the benchmark can tell whether reflect actually helped.

### Rollback criteria

- Any regression in exact-detail precision on targeted regressions
- Reflect count rises but exact-detail or overall LoCoMo standard falls
- `profile-routing-review`, `recursive-reflect-review`, or `public-memory-miss-regressions` regress

## Checkpoint 4: First implementation slice shipped

### What changed

- Added a pure recovery-control module:
  - `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/retrieval/recovery-control.ts`
  - formalized:
    - `queryModeHint`
    - `reflectEligibility`
    - `adequacyStatus`
    - `missingInfoType`
    - `reflectOutcome`
- Extended retrieval meta in:
  - `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/retrieval/types.ts`
  - new meta now exposes:
    - `queryModeHint`
    - `reflectEligibility`
    - `adequacyStatus`
    - `missingInfoType`
    - `preReflectAdequacyStatus`
    - `preReflectMissingInfoType`
    - `reflectHelped`
    - `reflectOutcome`
- Wired recovery control into:
  - `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/retrieval/service.ts`
  - reflect entry is now driven by explicit inadequacy state rather than only the prior heuristic bundle
- Tightened subject-safe exact-detail handling in:
  - `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/retrieval/service.ts`
  - stricter mixed-speaker rejection for `participant_turn`, `conversation_unit`, and `topic_segment` exact-detail candidates
  - added stronger ambiguity abstention when two slot values are too close
- Added focused tests:
  - `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/test/recovery-control.mjs`
- Extended LoCoMo diagnostics in:
  - `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/benchmark/locomo.ts`
  - new metrics:
    - `reflectHelpedRate`
    - `reflectNoGainRate`
    - `reflectHarmRate`
    - `answerShapingPassRate`
    - `aliasEntityResolutionPassRate`
    - `exactDetailPrecision`
    - `temporalAnchorHitRate`
    - `commonalityOverlapPrecision`
    - `mixedSubjectDiscardRate`

### Validation status

- Build: pass
- Recovery-control unit test: pass
- Existing planner test:
  - still has a pre-existing failure on `earlier this month`
  - this patch did not modify planner logic

### Targeted benchmark results after the patch

- public regressions:
  - `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/public-memory-miss-regressions-2026-03-26T01-30-04-811Z.json`
  - `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/public-memory-miss-regressions-2026-03-26T01-40-27-533Z.json`
  - both passed
- profile routing:
  - `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/profile-routing-review-2026-03-26T01-30-44-456Z.json`
  - `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/profile-routing-review-2026-03-26T01-41-16-691Z.json`
  - both passed
- recursive reflect review:
  - `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/recursive-reflect-review-2026-03-26T01-30-57-317Z.json`
  - `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/recursive-reflect-review-2026-03-26T01-41-24-071Z.json`
  - both passed

### Honest LoCoMo results after the patch

- mini:
  - `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/locomo-2026-03-26T01-33-03-386Z.json`
  - `passRate: 0.60`
  - `synthesisModeBreakdown.reflect: 12`
  - `reflectHelpedRate: 0.000`
  - `reflectNoGainRate: 1.000`
- standard first pass:
  - `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/locomo-2026-03-26T01-38-34-441Z.json`
  - `passRate: 0.42`
  - `synthesisModeBreakdown.reflect: 12`
  - `reflectHelpedRate: 0.000`
  - `answer_shaping: 25`
  - `alias_entity_resolution: 15`
- standard rerun after the follow-up subject-safety tightening:
  - `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/locomo-2026-03-26T01-46-41-297Z.json`
  - `passRate: 0.42`
  - `synthesisModeBreakdown.reflect: 9`
  - `reflectHelpedRate: 0.000`
  - `answer_shaping: 25`
  - `alias_entity_resolution: 15`

## Checkpoint 5: What moved and what did not

### What improved

- The retrieval path now exposes real recovery-control telemetry instead of only `synthesisMode`.
- The benchmark now distinguishes:
  - reflect was entered
  - reflect helped

## Checkpoint 6: Answerable-unit subsystem redesign attempt

### What was implemented

- Added a derived answerable-unit table:
  - `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/migrations/042_answerable_units.sql`
- Added deterministic answerable-unit construction:
  - `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/ingest/answerable-units.ts`
- Wired ingest-side construction for new writes:
  - `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/ingest/worker.ts`
- Added offline retrieval/reader helpers and a frozen fixture benchmark:
  - `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/retrieval/answerable-unit-retrieval.ts`
  - `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/retrieval/answerable-unit-reader.ts`
  - `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/benchmark/answerable-unit-fixtures.ts`
  - `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/benchmark/answerable-unit-review.ts`
  - `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/test/answerable-unit-review.mjs`

### What passed

- Build: pass
- Frozen answerable-unit review:
  - `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/answerable-unit-review-2026-03-26T15-00-12-750Z.json`
  - passed
- Existing safety tests:
  - `test:exact-answer-control` pass
  - `test:subject-isolation-control` pass
  - `test:recovery-control` pass

### What failed

- First targeted public regression gate failed with the hot-path reader enabled:
  - `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/public-memory-miss-regressions-2026-03-26T15-00-26-539Z.json`
  - failures included:
    - `locomo_support_group_exact_date`
    - `locomo_sunrise_year`
    - `locomo_jon_job_loss_date`
    - `locomo_causal_motive`
- This showed the new reader path was too aggressive for live temporal/causal controls.

### Keep / rollback decision

- Rolled back the answerable-unit **hot path** from final claim selection in:
  - `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/retrieval/service.ts`
- Kept the derived storage and offline constructor/fixture groundwork in the repo.
- Rationale:
  - targeted suite regression is a hard stop
  - no honest `standard` with the reader enabled was keepable

### Post-rollback validation

- public regressions restored:
  - `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/public-memory-miss-regressions-2026-03-26T15-04-22-503Z.json`
- profile routing restored:
  - `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/profile-routing-review-2026-03-26T15-05-41-935Z.json`
- recursive reflect restored:
  - `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/recursive-reflect-review-2026-03-26T15-05-53-838Z.json`

### Final honest standard after rollback

- `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/locomo-2026-03-26T15-26-33-825Z.json`
- `passRate: 0.42`
- `alias_entity_resolution: 16`
- `answer_shaping: 20`
- `exactDetailPrecision: 1`
- `reflectHelpedRate: 0`
- `answerableUnitAppliedRate: 0`
- `readerResolvedRate: 0`

### Interpretation

- The answerable-unit groundwork is real and testable, but the first production reader integration did **not** move the benchmark safely.
- Because the final honest artifact after rollback has `answerableUnitAppliedRate: 0`, the current degraded `0.42` line should not be attributed to the new reader path itself.
- The likely conclusion is broader repo / lane drift since the earlier `0.45` safe artifact, not a keepable win from this subsystem pass.

## Checkpoint 7: Drift audit between the `0.45` and `0.42` honest artifacts

### New audit tool

- Added a repeatable LoCoMo artifact diff:
  - `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/benchmark/locomo-drift-audit.ts`
  - `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/cli/benchmark-locomo-drift-audit.ts`
- Script:
  - `npm run benchmark:locomo-drift-audit -- --baseline <path> --candidate <path>`

### Audit artifact

- `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/locomo-drift-audit-2026-03-27T01-13-21-293Z.json`
- `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/locomo-drift-audit-2026-03-27T01-13-21-293Z.md`

### What the drift audit proved

- The net honest drop from `0.45` to `0.42` is only **3 regressions**, not a broad alias collapse.
- All 3 net regressions changed from previous `pass` rows to `retrieval` failures caused by query timeout:
  - `conv-30#7` — `What is Jon's favorite style of painting?`
  - `conv-48#8` — `What are the names of Deborah's snakes?`
  - `conv-50#9` — `What advice did Calvin receive from the chef at the music festival?`
- The category deltas are consistent with that:
  - `retrieval: +4`
  - `alias_entity_resolution: +0`
  - `answer_shaping: +0`
  - `temporal: +0`
  - `exactDetailPrecision: +0`
- One additional row changed class without changing pass/fail:
  - `conv-48#7` moved from `abstention` to `retrieval`

### Current conclusion from the audit

- The current blocker after rollback is **not** alias drift.
- The current blocker is **runtime/retrieval reliability drift on a small set of reflect-mediated rows**.
- That means the next smallest justified task is:
  - targeted timeout / retrieval-path audit for those 3 rows
  - not another alias hot-path patch
  - not another answerable-unit reader attempt
  - reflect produced no gain
  - reflect harmed
- Targeted product-facing suites stayed green after the patch.
- Reflect inflation can now be called out honestly instead of mistaken for progress.

### What did not improve

- Honest LoCoMo `standard` did not move beyond `0.42`.
- `answer_shaping` remained `25`.
- `alias_entity_resolution` remained `15`.
- `mixedSubjectDiscardRate` remained `0.000`.
- Reflect activity increased in the first run, then decreased slightly after tightening, but `reflectHelpedRate` stayed `0.000`.

### What the failures now say clearly

- Many `answer_shaping` misses are still not retrieval misses.
  - They are `supported`, `matched`, and `adequate` by current control logic, but the final slot value is still wrong or incomplete.
- Many alias failures still come from derivations whose text is semantically about the target person but whose actual speaking turn or answer-bearing sentence belongs to someone else.
- The current reflect subquery generator can recover some benchmark cases, but the new telemetry shows it is not solving the inadequacy states it enters for.

## Checkpoint 6: Recommended next bounded patch

The next patch should not be “more reflect.”

It should be:

1. Add a stricter exact-answer value scorer that rewards query-aligned context, not just extracted value text.
   - Example problem: favorite-movie questions currently accept a movie mention that is not actually attached to a `favorite` cue.
2. Add turn-level speaker/source alignment checks for participant-turn derivations before exact-answer extraction.
   - Example problem: `Participant-bound turn for Deborah` can still contain `Jolene:` as the actual answer-bearing speaker.
3. Add a dedicated mixed-subject discard path for exact-detail questions before answer shaping.
   - Today those cases are still often marked `supported` with one row and then fail as alias/entity problems.

Do not broaden reflect again until one of these changes lowers:

- `answer_shaping`
- `alias_entity_resolution`
- or raises `mixedSubjectDiscardRate`

## Checkpoint 7: Subject-Safe Exact Answer Pipeline

### Live code reality check for this patch

- The exact-detail claim path was still concentrated in:
  - `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/retrieval/service.ts`
  - specifically around:
    - `buildExactDetailTextCandidates`
    - `deriveSubjectBoundExactDetailClaim`
    - `assessRecallAnswer`
- The benchmark harness in:
  - `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/benchmark/locomo.ts`
  - already consumed retrieval meta and failure classifications, so the safest patch was to add exact-answer telemetry instead of changing benchmark scoring.
- No schema or migration changes were needed for this slice.

### Files changed

- `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/retrieval/exact-answer-control.ts`
- `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/retrieval/service.ts`
- `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/retrieval/types.ts`
- `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/benchmark/locomo.ts`
- `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/test/exact-answer-control.mjs`
- `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/package.json`

### What was built

- Added a focused exact-answer helper:
  - `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/retrieval/exact-answer-control.ts`
- New helper responsibilities:
  - answer-bearing window extraction
  - subject-safe / mixed / foreign window classification
  - speaker alignment scoring
  - query-aligned slot cue scoring
  - candidate aggregation
  - dominance / ambiguity abstention
- Wired the exact-detail live path through the new helper in:
  - `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/retrieval/service.ts`
- Added response-level telemetry:
  - `exactAnswerWindowCount`
  - `exactAnswerSafeWindowCount`
  - `exactAnswerDiscardedMixedWindowCount`
  - `exactAnswerDiscardedForeignWindowCount`
  - `exactAnswerCandidateCount`
  - `exactAnswerDominantMargin`
  - `exactAnswerAbstainedForAmbiguity`
- Extended LoCoMo reporting to surface those metrics.
- Added focused unit coverage for:
  - mixed-subject discard
  - wrong-speaker rejection
  - favorite-cue preference
  - hobby cue preference
  - trilogy adversarial abstention
  - ambiguity abstention
  - multi-value martial arts extraction

### Validation status

- Build: pass
- Recovery-control unit test: pass
  - `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/test/recovery-control.mjs`
- Exact-answer helper unit test: pass
  - `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/test/exact-answer-control.mjs`
- Targeted fast OpenRouter suites: pass
  - `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/public-memory-miss-regressions-2026-03-26T02-47-32-436Z.json`
  - `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/profile-routing-review-2026-03-26T02-48-11-698Z.json`
  - `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/recursive-reflect-review-2026-03-26T02-48-26-800Z.json`

### Benchmark movement

- Honest `standard` LoCoMo:
  - before:
    - `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/locomo-2026-03-26T01-46-41-297Z.json`
    - `passRate: 0.42`
    - `answer_shaping: 25`
    - `alias_entity_resolution: 15`
    - `mixedSubjectDiscardRate: 0`
  - after:
    - `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/locomo-2026-03-26T02-57-27-877Z.json`
    - `passRate: 0.45`
    - `answer_shaping: 20`
    - `alias_entity_resolution: 15`
    - `mixedSubjectDiscardRate: 0`
    - `exactAnswerDiscardedMixedWindowCount: 26`
    - `exactAnswerDiscardedForeignWindowCount: 198`
    - `exactAnswerCandidateCount: 20`
    - `exactAnswerAbstainedForAmbiguityRate: 0.08`

- Honest `release-candidate` LoCoMo:
  - before:
    - `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/locomo-2026-03-25T16-24-17-672Z.json`
    - `passRate: 0.36`
    - `answer_shaping: 54`
    - `alias_entity_resolution: 20`
  - after:
    - `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/locomo-2026-03-26T03-09-21-195Z.json`
    - `passRate: 0.38`
    - `answer_shaping: 49`
    - `alias_entity_resolution: 20`
    - `exactDetailPrecision: 0.667`
    - `mixedSubjectDiscardRate: 0`

### What improved

- `standard` moved from `0.42` to `0.45`.
- `standard` answer-shaping failures dropped from `25` to `20`.
- `release-candidate` moved from `0.36` to `0.38`.
- `release-candidate` answer-shaping failures dropped from `54` to `49`.
- The exact-answer path now produces visible discard telemetry instead of hiding the discard logic inside the service.

### What did not improve

- `alias_entity_resolution` stayed flat:
  - `standard: 15 -> 15`
  - `release-candidate: 20 -> 20`
- `reflectHelpedRate` stayed `0`.
- `mixedSubjectDiscardRate` stayed `0` at the benchmark level even though the new helper is discarding mixed and foreign windows internally.

### What still looks risky

- `release-candidate` surfaced a precision risk:
  - `exactDetailPrecision: 0.667`
- That means the patch improved answer-shaping enough to move the overall line, but exact-detail correctness is still not consistently holding on the larger lane.
- This is the right place to stop the current bounded loop rather than widen scope or touch reflect again.

### Recommended next smallest patch

- Keep the new exact-answer helper.
- Do not broaden reflect.
- Next bounded patch should focus on the still-flat alias path:
  1. add earlier sentence/turn isolation before `subjectMatch` is assessed
  2. make exact-answer extraction discard mixed-subject evidence before fallback narrative rows can become the final claim
  3. add alias-targeted regression cases from the failing `release-candidate` rows before changing scoring again

## 2026-03-26 Alias Isolation Follow-Up

### Live code reality check

- The alias blocker was upstream of the exact-answer helper.
- `release-candidate` alias failures were still bypassing exact-answer extraction entirely.
- `assessSubjectBinding(...)` was too coarse because it treated any single-target query as eligible for strict ownership assessment, while `collectSubjectParticipantSignals(...)` still let mixed rows count as participant matches too easily.
- The safest next slice was earlier recall-side isolation, not broader reflect and not more exact-answer slot scoring.

### What landed

- Added a focused subject-isolation helper:
  - `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/retrieval/subject-isolation-control.ts`
- Wired recall-side isolation telemetry through:
  - `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/retrieval/service.ts`
  - `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/retrieval/types.ts`
  - `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/benchmark/locomo.ts`
- Added focused unit coverage:
  - `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/test/subject-isolation-control.mjs`
- Added script entry:
  - `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/package.json`

### What the helper does

- extracts stricter subject ownership signals from:
  - `subject_name`
  - `speaker_name`
  - `transcript_speaker_name`
  - `participant_names`
  - parsed speaker turns
  - source sentence ownership
- classifies rows as:
  - `subject_owned`
  - `mixed_subject`
  - `foreign_subject`
  - `no_subject_signal`
- demotes or discards mixed/foreign/fallback rows before final recall assessment for exact-detail single-subject queries
- keeps identity/profile/commonality queries out of the strict exact-detail abstention path

### Validation status

- Build: pass
- Subject-isolation unit test: pass
  - `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/test/subject-isolation-control.mjs`
- Recovery-control unit test: pass
  - `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/test/recovery-control.mjs`
- Targeted fast OpenRouter suites:
  - public miss regressions: pass
    - `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/public-memory-miss-regressions-2026-03-26T04-36-18-927Z.json`
  - profile routing review: pass
    - `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/profile-routing-review-2026-03-26T04-34-33-723Z.json`
  - recursive reflect review: pass
    - `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/recursive-reflect-review-2026-03-26T04-34-41-695Z.json`

### What moved

- The new subject-isolation path is active and locally verified.
- Public regression coverage remained green after narrowing the guard so identity/profile prompts are not treated as exact-detail alias cases.

### What did not complete

- Two separate `LoCoMo standard` reruns stalled without producing a fresh artifact.
- The benchmark process stayed idle for multiple minutes with no output and no new `locomo-*.json` file.
- Because of that operational blocker, there is no honest new `standard` artifact yet for the alias-isolation slice, so benchmark movement on `alias_entity_resolution` remains unproven in this pass.

### Recommended next smallest task

- Do not stack another scoring patch until the `LoCoMo standard` runner is stable again.
- Next task should be:
  1. inspect why `benchmark-locomo.js` can stall idle under the fast OpenRouter lane
  2. re-run `standard` from this exact code state
  3. only if alias still stays flat, add one more bounded patch focused on sentence-level ownership for mixed `conversation_unit` and `topic_segment` rows

## 2026-03-26 Honest Benchmark Stability And Alias Gate Attempt

### Operational stabilization that landed

- `local-brain/src/benchmark/locomo.ts` now emits:
  - benchmark start / phase logs
  - question progress logs
  - heartbeat logs during slow rows
  - timeout logs
  - partial artifact writes every 5 completed questions
  - final artifact write-start / write-complete logs
- The runner now records partial results on per-question failure instead of appearing stalled forever.
- A fresh honest `standard` artifact completed successfully:
  - `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/locomo-2026-03-26T07-52-06-445Z.json`

### What the fresh honest run proved

- The benchmark instability was operational opacity plus slow/timeout-prone rows, not silent non-execution.
- The product blocker remained alias/entity isolation:
  - `passRate` held at `0.45`
  - `answer_shaping` held at `20`
  - `alias_entity_resolution` worsened slightly to `16`
  - `mixedSubjectDiscardRate` improved to `0.25`
  - `subjectIsolationAppliedRate` was still only `0.05`
- That meant the existing recall-side isolation was too narrow to reach most alias failures.

### Bounded alias gate attempt and outcome

- I tested one additional bounded memory patch that hardened query-subject parsing for ownership-sensitive prompts and widened strict ownership checks for more single-subject wh/auxiliary queries.
- The patch was safe on local unit tests, but the honest `standard` benchmark regressed:
  - new artifact:
    - `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/locomo-2026-03-26T08-23-58-776Z.json`
  - `passRate`: `0.45 -> 0.43`
  - `alias_entity_resolution`: `16 -> 22`
  - `retrieval` failures: `1 -> 8`
  - `mixedSubjectDiscardRate`: `0.25 -> 0.884`
- This increased aggressive subject-mismatch behavior without improving the real pass line, so the patch was rejected and rolled back.

### Current safe conclusion

- Keep the benchmark stability instrumentation.
- Do not keep the rejected alias gate broadening patch.
- The next smallest justified task is not “more alias heuristics.”
- It is a narrower failure-family pass against the fresh honest artifact:
  1. inspect the 16 alias failures from `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/locomo-2026-03-26T07-52-06-445Z.json`
  2. separate true mixed-subject rows from missing-subject / fallback-derivation rows
  3. build one narrower patch only for the dominant subfamily instead of broadening ownership gating globally

## 2026-03-26 Fallback Alias Subfamily Attempt

### What I tried

- I isolated the 16 safe-state alias failures and tested a narrow subfamily hypothesis:
  - fallback `No authoritative evidence found.` rows were still being marked `mixed` because strict single-target subject binding promoted any lower mixed row into `subjectMatch = mixed`
- I implemented a small fallback-only binding override plus a dedicated fixture pack, then reran the honest `standard` lane.

### Honest result

- New artifact from the experimental patch:
  - `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/locomo-2026-03-26T09-08-34-825Z.json`
- Outcome:
  - `passRate`: `0.45 -> 0.43`
  - `alias_entity_resolution`: stayed `16`
  - `retrieval`: `1 -> 3`
  - `answer_shaping`: stayed `20`
  - `exactDetailPrecision`: stayed `1`
  - `reflectHelpedRate`: stayed `0`

### Decision

- The patch did not move alias failures and it lowered the honest pass line, so it was rolled back.
- The current safe truth remains:
  - `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/locomo-2026-03-26T07-52-06-445Z.json`

### Next smallest task

- Do not retry fallback-only binding overrides.
- Next task should inspect the 16 safe-state alias failures again, but split them more narrowly:
  1. mixed `conversation_unit` / `topic_segment` winners
  2. wrong-speaker `participant_turn` rows
  3. fallback derivations
- Then patch only the largest real subfamily with row-level fixtures before another honest `standard` run.

## 2026-03-26 Mixed Conversation-Unit Claim Carrier Attempt

### What I tried

- I implemented a narrower claim-carrier promotion slice for mixed `conversation_unit` winners.
- The rule was intentionally conservative:
  - apply only to strict single-target alias-sensitive queries
  - only when the top result was a mixed `conversation_unit`
  - only when a lower target-owned `participant_turn` or `source_sentence` already existed in the top recall set
- I added a small fixture benchmark and kept exact-detail queries out of scope.

### Local and targeted validation

- The fixture benchmark passed:
  - `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/claim-carrier-control-2026-03-26T12-36-31-035Z.json`
- After rollback validation, targeted suites were green again:
  - `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/public-memory-miss-regressions-2026-03-26T12-45-15-602Z.json`
  - `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/profile-routing-review-2026-03-26T12-45-15-606Z.json`
  - `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/recursive-reflect-review-2026-03-26T12-45-23-631Z.json`

### Honest result

- Experimental honest artifact:
  - `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/locomo-2026-03-26T12-43-20-130Z.json`
- Compared with the safe baseline `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/locomo-2026-03-26T07-52-06-445Z.json`:
  - `passRate`: `0.45 -> 0.45`
  - `alias_entity_resolution`: `16 -> 16`
  - `answer_shaping`: `20 -> 20`
  - `exactDetailPrecision`: `1 -> 1`
  - `reflectHelpedRate`: `0 -> 0`
- This did not meet the keep criteria because alias did not improve below `16`.

### Decision

- The patch was rolled back.
- Reason:
  - it added hot-path complexity
  - it did not move the benchmark blocker
  - the correct bar for keeping alias work is not “flat overall score,” it is “alias improves without safety regression”

### Updated next smallest task

- Do not retry mixed `conversation_unit` claim-carrier promotion in this exact form.
- The next slice should be even narrower:
  1. take only the surviving safe-baseline `conversation_unit` alias failures
  2. add matched negative temporal/date controls
  3. patch only when a lower owned carrier exists **and** the mixed top row is not the only date-bearing evidence

## 2026-03-27 Drift Audit and Runtime Recovery

### What drifted

- After the answerable-unit hot-path rollback, the honest lane fell from:
  - `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/locomo-2026-03-26T07-52-06-445Z.json`
  - to `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/locomo-2026-03-26T15-26-33-825Z.json`
- That changed the honest pass line from `0.45` to `0.42`.
- I added a row-level diff tool:
  - `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/benchmark/locomo-drift-audit.ts`
  - `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/cli/benchmark-locomo-drift-audit.ts`
- First audit artifact:
  - `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/locomo-drift-audit-2026-03-27T01-13-21-293Z.json`

### What the audit proved

- The `0.45 -> 0.42` drop was not broad semantic regression.
- It was concentrated in three timeout regressions:
  - `conv-30#7` `What is Jon's favorite style of painting?`
  - `conv-48#8` `What are the names of Deborah's snakes?`
  - `conv-50#9` `What advice did Calvin receive from the chef at the music festival?`
- All three baseline rows had been near the benchmark timeout ceiling and then flipped to:
  - `failureClass = retrieval`
  - `BENCHMARK_ERROR: memory.search ... timed out after 45000ms`

### Runtime fix 1: isolate benchmark search

- I changed the LoCoMo runner so each benchmark `memory.search` executes in its own child process instead of inside the benchmark process:
  - `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/benchmark/locomo.ts`
- This makes the timeout real:
  - on timeout, the child search process is killed
  - leaked background `memory.search` work cannot poison later rows

### Result after search isolation

- Honest rerun artifact:
  - `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/locomo-2026-03-27T01-39-19-600Z.json`
- Drift audit vs safe baseline:
  - `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/locomo-drift-audit-2026-03-27T01-39-28-135Z.json`
- Outcome:
  - `passRate`: `0.42 -> 0.44`
  - recovered:
    - `conv-30#7`
    - `conv-50#9`
  - remaining true regression:
    - `conv-48#8`

### Root cause of the remaining regression

- I replayed the `conv-48` namespace directly and timed the two snake-name queries.
- Direct search runtime before the next fix:
  - Jolene snakes: about `76s`
  - Deborah snakes: about `55s`
- The problem was not benchmark orchestration anymore.
- The problem was nested recursive reflect on generated exact-detail reflect subqueries:
  - `what exact detail about Deborah answers this question: ...`
  - `what explicit fact in the source answers: ...`
- Those generated reflect prompts were recursively re-entering reflect again, multiplying latency even when the final outcome was still just abstention / `None`.

### Runtime fix 2: stop reflect-on-reflect for generated exact-detail prompts

- I added a narrow guard in:
  - `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/retrieval/service.ts`
- Rule:
  - if the query is already a generated reflect prompt of the form:
    - `what exact detail about ...`
    - `what explicit fact in the source answers: ...`
  - and we are already inside recursive search depth,
  - do not recurse into another reflect round

### Targeted validation

- Direct replay after the guard:
  - both snake-name queries dropped to about `12s`
  - outcome stayed the same: reflect-driven abstention, not a semantic answer shift
- Targeted suites passed:
  - `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/public-memory-miss-regressions-2026-03-27T01-47-36-896Z.json`
  - `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/profile-routing-review-2026-03-27T01-47-36-850Z.json`
  - `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/recursive-reflect-review-2026-03-27T01-47-46-258Z.json`

### Final honest result

- Honest artifact after both runtime fixes:
  - `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/locomo-2026-03-27T02-07-02-906Z.json`
- Final drift audit vs the original safe baseline:
  - `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/locomo-drift-audit-2026-03-27T02-07-11-144Z.json`
- Outcome:
  - `passRate`: `0.45 -> 0.45`
  - `alias_entity_resolution`: unchanged
  - `answer_shaping`: unchanged
  - `exactDetailPrecision`: unchanged
  - `reflectHelpedRate`: unchanged
  - no regressions

### Decision

- Keep both fixes:
  1. benchmark child-process isolation in `locomo.ts`
  2. generated exact-detail reflect recursion guard in `service.ts`
- These fixes restored the honest lane without changing the semantic benchmark profile.
- They should be treated as runtime/reliability hardening, not as alias-modeling progress.
