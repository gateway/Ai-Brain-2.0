# LoCoMo Remediation Loop - 2026-03-29

## Summary

This document records the post-audit remediation loops after the first-pass LoCoMo failure taxonomy.

Goal:
- push the exact-answer / subject-binding / temporal lanes materially
- measure deltas after each loop
- stop when the lane flattens, then record what still needs deeper architectural work

## Frozen Checkpoint - 2026-03-31

This remediation slice is now frozen at mini LoCoMo `0.825`.

Trusted checkpoint artifact:
- [locomo-2026-03-31T08-04-13-012Z.json](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/locomo-2026-03-31T08-04-13-012Z.json)

Checkpoint metrics:
- `passRate: 0.825`
- `sampleCount: 40`
- `failureBreakdown`:
  - `temporal: 1`
  - `answer_shaping: 6`
  - all other benchmark failure buckets: `0`
- `sufficiencyBreakdown`:
  - `supported: 30`
  - `weak: 1`
  - `missing: 8`
  - `contradicted: 1`

Why this slice is frozen:
- the retrieval substrate materially improved
- the remaining misses are no longer broad retrieval blindness
- several live misses now show `supported` evidence and `readerDecision = resolved`, which means the next gains are in final claim shaping and product hardening, not another open-ended retrieval loop
- the repository is now dirty across retrieval, benchmark tooling, dashboard/operator surfaces, docs, and migrations, so continuing without a checkpoint would make the next phase harder to reason about

Frozen remaining miss families:
1. list-family answer shaping
- `What are Joanna's hobbies?`
- `What pets wouldn't cause any discomfort to Joanna?`
- `Is it likely that Nate has friends besides Joanna?`

2. residual temporal anchoring
- `When did Melanie paint a sunrise?`
- `When did Joanna first watch "Eternal Sunshine of the Spotless Mind?`
- `When did Nate win his first video game tournament?`

3. bounded causal / profile chain shaping
- `What fields would Caroline be likely to pursue in her educaton?`
- `What did Caroline realize after her charity race?`
- `What might John's financial status be?`
- `What sparked John's interest in improving education and infrastructure in the community?`

4. benchmark-normalization / malformed-expectation residue
- these items should not drive product hacks
- the Maria dinner inconsistency remains the clearest example of why benchmark corruption must stay out of product logic

What changed by the end of this slice:
- detached benchmark execution now produces stable final artifacts
- subject-bound event neighborhoods are materially better
- media-title carry-forward is materially better
- social/list-family retrieval is no longer the primary bottleneck
- the remaining Joanna/Nate/pet lane is mostly a late answer-shaping problem rather than a retrieval problem

What should happen next:
- stop this LoCoMo micro-loop here
- recover the protected product lanes
- bring dashboard/operator surfaces into sync with the current truth model
- then reopen the frozen remaining LoCoMo families as a new scoped remediation phase

## Inputs

Baseline audit:
- [LOCOMO_FIRST_PASS_AUDIT_2026-03-29.md](/Users/evilone/Documents/Development/AI-Brain/ai-brain/docs/LOCOMO_FIRST_PASS_AUDIT_2026-03-29.md)

NotebookLM guidance consulted:
- deterministic answer-bearing fragments
- stronger participant binding
- temporal anchoring from structural windows rather than model guesswork
- abstain only after deterministic narrowing fails

## Remediation Loop 1

Code changes:
- prevent reader-selected prompt turns from overwriting exact-detail claims
- widen precise lexical evidence terms for:
  - hobbies
  - martial arts
  - trilogy
  - pets + allergies
- tighten favorite-movie quoted-title extraction to avoid script-title false positives
- fix hobbies extraction for `Besides X, I also enjoy ...`

Artifact:
- [locomo-2026-03-29T07-57-46-444Z.json](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/locomo-2026-03-29T07-57-46-444Z.json)

Result:
- pass rate improved from `0.575` to `0.625`

Bucket movement:
- `answer_shaping`: `8 -> 5`
- `temporal`: `3 -> 3`
- `alias_entity_resolution`: `2 -> 2`
- `abstention`: `3 -> 4`
- `synthesis_commonality`: `1 -> 1`

Observed win:
- `What are Joanna's hobbies?` moved from prompt-turn pollution / abstention into deterministic extraction:
  - returned: `reading, watching movies, and exploring nature`

## Remediation Loop 2

Code changes:
- widen exact-detail routing in `query-signals.ts` for:
  - hobbies
  - martial arts
  - color questions
  - meal companions
  - allergy-safe pet questions
  - trilogy questions

Artifact:
- [locomo-2026-03-29T08-03-43-308Z.json](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/locomo-2026-03-29T08-03-43-308Z.json)

Result:
- pass rate stayed at `0.625`

Bucket movement:
- `answer_shaping`: `5 -> 5`
- `temporal`: `3 -> 3`
- `alias_entity_resolution`: `2 -> 3`
- `abstention`: `4 -> 3`
- `synthesis_commonality`: `1 -> 1`

Interpretation:
- the routing expansion did not materially increase top-line accuracy
- it shifted some misses from abstention into alias/entity resolution
- this suggests the remaining misses are not mostly gate-width problems anymore

## Remediation Loop 3

Code changes:
- atomic multi-value extraction for hobbies:
  - `Besides writing, I also enjoy reading, watching movies, and exploring nature`
  - `Writing and hanging with friends`
- broader structured fallback for safe multi-value exact-detail queries

Artifacts:
- [locomo-2026-03-29T08-28-38-527Z.json](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/locomo-2026-03-29T08-28-38-527Z.json)
- [locomo-2026-03-29T08-33-03-794Z.json](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/locomo-2026-03-29T08-33-03-794Z.json)

Result:
- pass rate stayed at `0.625`

Bucket movement across the last two loops:
- `answer_shaping`: `5 -> 4 -> 4`
- `temporal`: `3 -> 3 -> 3`
- `alias_entity_resolution`: `3 -> 3 -> 3`
- `abstention`: `3 -> 4 -> 4`
- `synthesis_commonality`: `1 -> 1 -> 1`

Interpretation:
- this lane plateaued
- exact-detail shaping is no longer the dominant bottleneck
- the remaining misses are now mostly in the other three architectural buckets plus a smaller exact-answer residue

## What We Learned

### Good news
- the largest easy bug was real and is fixed:
  - exact-detail reader overwrite was corrupting answer shaping
- the system is often close:
  - many misses still have evidence
  - the dominant remaining failures are narrower and more explainable

### Current remaining failure classes

1. `answer_shaping`
- examples:
  - `What martial arts has John done?`
  - `What might John's financial status be?`
  - `What sparked John's interest in improving education and infrastructure in the community?`
  - `What pets wouldn't cause any discomfort to Joanna?`
  - `What are Joanna's hobbies?`
- pattern:
  - evidence exists
  - final answer is partial, over-broad, or uses the wrong answer-bearing unit

2. `temporal`
- examples:
  - `When did Melanie paint a sunrise?`
  - `When is Jon's group performing at a festival?`
  - `When did Joanna first watch "Eternal Sunshine of the Spotless Mind?"`
- pattern:
  - correct neighborhood found
  - wrong year/month or mention-date chosen over event-date

3. `alias_entity_resolution`
- examples:
  - `Who did Maria have dinner with on May 3, 2023?`
  - `Is it likely that Nate has friends besides Joanna?`
- pattern:
  - evidence exists
  - system over-penalizes pronoun or indirect-reference answers

4. `abstention`
- examples:
  - `What did Melanie realize after the charity race?`
  - `What is one of Joanna's favorite movies?`
  - `Which city have both Jean and John visited?`
- pattern:
  - evidence may exist in broader context
  - system still cannot narrow to a deterministic answer-bearing value

5. `synthesis_commonality`
- example:
  - `What kind of interests do Joanna and Nate share?`
- pattern:
  - overlap synthesis is still too brittle when each side contributes different wording

## Architectural Readout

The remaining misses now look more like algorithm / substrate issues than one-off function bugs.

Main remaining architectural needs:

1. multi-window exact-value aggregation
- required for:
  - hobbies
  - martial arts
  - other profile-style enumerations
- current failure:
  - system may retrieve or extract one exact value but not aggregate the full supported set
  - some structured exact-detail queries now show non-zero candidate telemetry but still fail to promote those candidates into the final answer cleanly

2. pronoun-aware subject closure
- required for:
  - `her mother`
  - indirect references to friends / teammates
- current failure:
  - entity safety rules are sometimes too strict after narrowing
  - example: `Who did Maria have dinner with on May 3, 2023?` still collapses to `No authoritative evidence matched the requested person.`

3. event-time vs mention-time separation
- required for temporal questions
- current failure:
  - later recollection rows can outrank the original event anchor
  - example: `When is Jon's group performing at a festival?` still anchors to the wrong year path instead of the expected `February, 2023`

4. commonality overlap synthesis
- required for shared-interest questions
- current failure:
  - overlap still depends too much on literal lexical match instead of structured overlap
  - example: `What kind of interests do Joanna and Nate share?` still returns a broad topic fragment instead of the overlap set

## Recommended Next Remediation Order

1. multi-window exact-value aggregation
2. pronoun-aware subject closure
3. temporal anchor scoring using event-date preference
4. structured overlap synthesis for commonality questions

## Sign-off For This Loop

This loop was worth doing.

Reasons:
- it improved LoCoMo mini from `0.575` to `0.625`
- it removed the easiest answer-shaping corruption path
- it confirmed the plateau after two more surgical passes
- it clarified that the remaining misses need deeper structural work, not more generic routing expansion

This loop should not be repeated as-is.
The next pass should target the four architectural items above, but with effort shifted away from generic exact-detail widening and toward:
1. pronoun-aware subject closure
2. event-time anchoring
3. structured commonality overlap
4. only then any remaining exact-answer residue

## Remediation Loop 4

Code changes:
- add a shared query focus parser for:
  - single-subject questions
  - primary-subject + companion questions such as `besides Joanna`
  - shared / comparison questions such as `both Jean and John`
- use parsed primary subject hints instead of naive entity-name extraction in:
  - answerable-unit retrieval
  - subject isolation
  - exact-answer control
  - service-level subject-bound routing
- ignore companion names when computing foreign-speaker / foreign-participant penalties
- widen cue-term filtering so companion / comparison phrasing is not treated as content-bearing evidence

Artifacts:
- [locomo-2026-03-29T08-49-40-057Z.json](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/locomo-2026-03-29T08-49-40-057Z.json)
- [locomo-2026-03-29T09-01-34-585Z.json](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/locomo-2026-03-29T09-01-34-585Z.json)
- [locomo-2026-03-29T09-10-18-859Z.json](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/locomo-2026-03-29T09-10-18-859Z.json)

Result:
- pass rate stayed at `0.625`

Bucket movement:
- `temporal`: `3 -> 3 -> 3`
- `alias_entity_resolution`: `3 -> 2 -> 2`
- `abstention`: `4 -> 5 -> 5`
- `answer_shaping`: `4 -> 4 -> 4`
- `synthesis_commonality`: `1 -> 1 -> 1`

Interpretation:
- the parser work was still correct and useful, but it did not produce a top-line benchmark lift
- one representative miss moved into the right lane:
  - `Who did Maria have dinner with on May 3, 2023?`
  - changed from `alias_entity_resolution` with no subject isolation to `abstention` with:
    - `subjectIsolationApplied: true`
    - `answerableUnitApplied: true`
    - `readerApplied: true`
    - `readerDecision: abstained_alias_ambiguity`
- the Nate case improved only partially:
  - `Is it likely that Nate has friends besides Joanna?`
  - changed from completely bypassing the subject-aware lane to:
    - `answerableUnitApplied: true`
    - `readerApplied: true`
    - `readerDecision: ambiguous`
  - but it still failed under `alias_entity_resolution`

Important benchmark note:
- the Maria dinner benchmark item appears inconsistent with the source transcript
- question:
  - `Who did Maria have dinner with on May 3, 2023?`
- the benchmark answer key expects:
  - `her mother`
- the conversation text currently says:
  - `have dinner with some friends from the gym`
- this should not be "fixed" by hardcoding toward the benchmark answer key

Why this loop still mattered:
- it proved the current bottleneck is not just missing subject parsing
- it showed that primary-subject + companion parsing can move a live failure into the intended decision path
- it clarified that the next gain probably requires:
  1. relation-aware exclusion / intersection logic for `X besides Y`, `X and Y both`, `between X and Y`
  2. stronger current-state social-evidence reasoning rather than only generic conversation units
  3. keeping benchmark-corrupt items out of the product-fix loop

## Remediation Loop 5

Goal:
- push the next three high-value lanes together:
  - relation-aware exclusion / intersection
  - temporal anchor typed retrieval
  - shared-commonality overlap

NotebookLM guidance used in this pass:
- keep fallback deterministic
- prefer SQL-pruned identity and time narrowing before broad ranking
- treat event time separately from mention time
- only promote reader-selected units into exact answers when the selected unit is actually answer-bearing

Code changes:
- widen shared-commonality routing to pick up:
  - `which city have both ... visited`
  - `what kind of interests ... share`
- add `deriveCompanionExclusionClaimText(...)` for `X besides Y` social/friend questions
- add `getTypedTemporalAnchorResults(...)` to search typed media/person-time rows before broad temporal retrieval
- expand relative-time handling to include:
  - `last month`
  - `last year`
  - `next month`
  - `next year`
  - `N years ago`
- allow reader-resolved fallback to rescue exact-detail answers when the exact lane abstains but the reader has a resolved claim

Artifacts:
- [locomo-2026-03-29T09-33-10-768Z.json](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/locomo-2026-03-29T09-33-10-768Z.json)
- [locomo-2026-03-29T09-38-28-510Z.json](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/locomo-2026-03-29T09-38-28-510Z.json)

Result:
- best mini LoCoMo pass improved to `0.675`
- the immediate follow-up regressed to `0.650`

What improved in the `0.675` run:
- `Which city have both Jean and John visited?`
  - moved from abstention to pass
- `What kind of interests do Joanna and Nate share?`
  - moved from `synthesis_commonality` failure to pass

What regressed in the `0.650` follow-up:
- `What color did Joanna choose for her hair?`
  - reader fallback let a prompt turn behave like answer-bearing content again

Interpretation:
- the structured-overlap and commonality work was real and useful
- the generic reader fallback was too permissive
- this is where the current exact-answer lane stopped being “easy wins” and became answer-bearing-unit hygiene

## Remediation Loop 6

Goal:
- tighten the fallback path instead of widening it
- verify whether the remaining misses are routing bugs or substrate gaps

NotebookLM guidance used in this pass:
- do not promote interrogative turns into truth
- use deterministic fallback only when extracted slot values exist
- for relative time:
  - normalize `around 3 years ago` using the source row timestamp
- preserve a narrow 1-3 sentence answer-bearing unit concept

Code changes:
- block interrogative reader claims from resolving non-temporal exact-detail questions
- widen hobby extraction to capture bare hobby statements such as:
  - `Writing and hanging with friends!`
- support unmatched trailing quotes in temporal title parsing
- add deterministic relative-year normalization in typed temporal media results

Artifacts:
- [locomo-2026-03-29T09-48-21-251Z.json](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/locomo-2026-03-29T09-48-21-251Z.json)
- [locomo-2026-03-29T09-54-01-231Z.json](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/locomo-2026-03-29T09-54-01-231Z.json)

Result:
- both runs plateaued at `0.650`

Important forensic findings:
- `What are Joanna's hobbies?`
  - improved answer-bearing evidence now exists
  - answer snippet contains:
    - `writing, reading, watching movies, exploring nature`
  - but the benchmark still fails because the full supported set is not yet aggregated cleanly enough
- `What color did Joanna choose for her hair?`
  - still fails because the system continues to surface a Joanna prompt turn around Nate's hair change
  - this is still answer-bearing-unit contamination, not a pure extraction miss
- `When did Joanna first watch "Eternal Sunshine of the Spotless Mind?`
  - direct DB audit showed there are currently no typed `media_mentions` or `person_time_facts` rows for that movie in `ai_brain_local`
  - this is a typed extraction coverage gap, not just a retrieval-ranking problem

DB audit note:
- `SELECT ... FROM media_mentions WHERE lower(media_title) LIKE '%eternal sunshine%'`
  - returned no rows
- `SELECT ... FROM person_time_facts WHERE lower(fact_text) LIKE '%eternal sunshine%' OR lower(fact_text) LIKE '%first watched%'`
  - returned no rows

Current plateau buckets at this point:
- `answer_shaping`
- `temporal`
- `alias_entity_resolution`
- `abstention`

What is clearly left:
1. answer-bearing-unit contamination
   - prompt / question turns still survive in some exact-detail lanes
2. typed media/person-time extraction coverage
   - especially title carry-forward across adjacent sentences
3. relation-aware social inference
   - `besides Joanna` / teammate / friend-group logic
4. multi-row value aggregation
   - hobbies / pets / favorite-movie style detail questions

Conclusion from loops 5 and 6:
- we did push the score meaningfully once, from `0.625` to `0.675`
- we then exhausted the low-risk fixes in this lane
- the next lift will require:
  1. answer-bearing-unit contamination control
  2. typed extraction expansion for media/person-time carry-forward
  3. social relation inference for exclusion questions
  4. multi-row aggregation for profile-style exact detail

## Remediation Loop 7

Goal:
- make answerable-unit selection more structural instead of single-claim brittle
- let safe list-style exact-detail queries fan out across multiple owned units
- demote derived temporal summaries behind raw relative-time evidence

NotebookLM guidance used in this pass:
- use bounded episodic neighborhood fan-out for list questions instead of isolated fragments
- keep relative-time anchoring tied to immutable source/event timestamps
- prefer answer-bearing leaf fragments over synthesized "best supported" summaries

Code changes:
- add safe multi-unit aggregation handling in [answerable-unit-reader.ts](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/retrieval/answerable-unit-reader.ts)
  - hobbies
  - martial arts
  - allergy-safe pet questions
- add temporal structural scoring in [service.ts](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/retrieval/service.ts)
  - penalize derived `The best supported ...` temporal snippets
  - reward raw episodic / answerable-unit temporal evidence
  - recognize `Normalized year: YYYY`
- add a regression test for multi-unit reader fan-out in [answerable-unit-review.mjs](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/test/answerable-unit-review.mjs)

Artifacts:
- [locomo-2026-03-29T10-12-22-986Z.json](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/locomo-2026-03-29T10-12-22-986Z.json)
- [locomo-2026-03-29T10-12-22-986Z.md](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/locomo-2026-03-29T10-12-22-986Z.md)

Result:
- pass rate held at `0.650`

What improved internally:
- `What martial arts has John done?`
  - reader now resolved instead of dying in alias ambiguity
- `What are Joanna's hobbies?`
  - evidence count rose and reader selected multiple owned units

Why the score did not move:
- the exact-detail layer still did not synthesize the final multi-value answer cleanly enough
- the temporal festival / sunrise failures were still being carried by a wrong derived temporal claim upstream of final ranking

## Remediation Loop 8

Goal:
- stop prompt turns from winning as the reader anchor when a declarative owned answer exists

NotebookLM + implementation takeaway:
- prompt turns should be treated as retrieval scaffolding, not truth candidates
- once a declarative owned unit exists, interrogative runner-ups should not veto it

Code changes:
- promote the first declarative owned unit when the lexical top hit is only a prompt turn
- suppress ambiguity/alias-abstention triggered only by interrogative runner-ups
- add a regression test for declarative promotion in [answerable-unit-review.mjs](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/test/answerable-unit-review.mjs)

Guardrails:
- `npm run test:answerable-unit-review`
- `npm run test:exact-answer-control`

Artifacts:
- [locomo-2026-03-29T10-17-05-994Z.json](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/locomo-2026-03-29T10-17-05-994Z.json)
- [locomo-2026-03-29T10-17-05-994Z.md](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/locomo-2026-03-29T10-17-05-994Z.md)

Result:
- pass rate still held at `0.650`

What changed in the miss behavior:
- hobby and pet questions pulled more owned evidence than before
- prompt-turn contamination became more localized instead of broadly poisoning the reader
- the remaining misses are now more clearly downstream synthesis / extraction gaps, not just bad reader anchoring

## Remediation Loop 9

Goal:
- verify whether the declarative-promotion changes materially move the live benchmark
- stop the loop honestly if the score remains flat

NotebookLM / research readout:
- the right non-hacky next step is still structural:
  - bounded episodic neighborhood fan-out
  - temporal event anchoring over mention anchoring
  - deterministic answer-bearing-unit gating
- quick web research did not reveal a drop-in "GPT hub" fix; the relevant direction is classic temporal normalization and dialogue-coreference style structure, not another retrieval heuristic

Artifacts:
- [locomo-2026-03-29T10-23-24-734Z.json](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/locomo-2026-03-29T10-23-24-734Z.json)
- [locomo-2026-03-29T10-23-24-734Z.md](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/locomo-2026-03-29T10-23-24-734Z.md)

Result:
- pass rate remained `0.650`
- best confirmed mini LoCoMo score remains `0.675`
  - [locomo-2026-03-29T09-33-10-768Z.json](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/locomo-2026-03-29T09-33-10-768Z.json)

What is now clearly the plateau:
1. multi-row exact-detail synthesis
   - martial arts / hobbies / allergy-safe pets still need a true aggregation layer instead of partial extraction plus rank ordering
2. temporal event anchoring
   - `When ...` questions still sometimes inherit a derived year/date claim instead of the underlying event-relative cue
3. typed extraction coverage
   - Joanna + `Eternal Sunshine` remains a media/person-time coverage miss
4. social exclusion inference
   - `besides Joanna` needs relation-aware evidence synthesis, not just subject isolation

Stop condition for this set of loops:
- the reader layer is no longer the cheapest bottleneck
- further score movement now requires one of:
  - a real exact-detail aggregation function
  - typed media/person-time expansion
  - stronger temporal event anchoring logic
  - exclusion/intersection social inference

## Remediation Loop 10

Goal:
- implement the next two non-hacky substrate moves directly where the data is created and consumed
- verify whether distinct-window aggregation and speaker-aware typed carry-forward can push the plateau

NotebookLM guidance used in this pass:
- exact-detail lists should aggregate distinct evidence windows, not only top-ranked values
- implied media and event-time facts should be carried across bounded same-speaker neighborhoods at ingest time
- event-time remains a substrate problem first, not a prompt-shaping problem

Code changes:
- [exact-answer-control.ts](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/retrieval/exact-answer-control.ts)
  - add distinct-window multi-value aggregation
  - keep hobby-specific filtering so one-off activity mentions do not leak into hobby answers
- [typed-memory/service.ts](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/typed-memory/service.ts)
  - add structured speaker/turn sentence extraction
  - carry speaker identity across adjacent sentences for person-time extraction
  - carry explicit media anchors across adjacent same-speaker sentences when later references use pronouns/favorite/watch-time phrasing
- [service.ts](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/retrieval/service.ts)
  - widen exclusion inference to cover `people outside of my circle`
- [exact-answer-control.mjs](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/test/exact-answer-control.mjs)
  - add regression coverage for multi-window hobby aggregation

Guardrails:
- `npm run test:exact-answer-control` -> pass
- `npm run test:answerable-unit-review` -> pass

Artifacts:
- [locomo-2026-03-29T10-49-55-223Z.json](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/locomo-2026-03-29T10-49-55-223Z.json)
- [locomo-2026-03-29T10-49-55-223Z.md](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/locomo-2026-03-29T10-49-55-223Z.md)

Result:
- mini LoCoMo landed at `0.625`
- this did not beat the current best confirmed `0.675`

What this loop proved:
- the aggregation logic is now cleaner and regression-tested in isolation, but the live John/Joanna exact-detail misses are not solved by aggregation alone
- Jon festival still prefers the wrong temporal answer path, so the next lift is retrieval preference for typed temporal anchors over older derivations
- Nate `besides Joanna` still is not hitting the intended evidence row, so the next gain has to be broader relation-aware retrieval, not just a new answer template
- several conv-42 failures still look weakly grounded or benchmark-inconsistent from the available transcript text, so we should not force them with benchmark-specific logic

Regression readout from this pass:
- two items flipped from previously normalized-passing to failing:
  - `What temporary job did Jon take to cover expenses?`
  - `What color did Joanna choose for her hair?`
- those appear to be benchmark-sensitivity / weak-grounding effects rather than proof that the new substrate is wrong, but they are still real regressions for scorekeeping and need to be tracked

Current best next moves:
1. typed temporal-anchor retrieval preference
2. relation-aware exclusion retrieval
3. broader multi-row profile aggregation

## Remediation Loop 11

Goal:
- pressure-test a narrower temporal-anchor gate and a wider list-family aggregator without changing the benchmark contract
- verify whether the plateau is really in retrieval/support selection rather than another answer-shaping edge case

NotebookLM guidance used in this pass:
- event-time vs mention-time needs stricter structural admission, not more model-side guessing
- list-family questions should aggregate bounded evidence windows, but only after the right support rows are actually retrieved
- if a temporal lane still picks the wrong row after typed rebuild, the bug is in anchor admission or term weighting, not in the final claim formatter

Code changes:
- [typed-memory/service.ts](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/typed-memory/service.ts)
  - normalized temporal query terms more aggressively
  - filtered person-time temporal anchors by explicit term overlap instead of only broad SQL LIKE matching
- [retrieval/service.ts](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/retrieval/service.ts)
  - prefer typed `window_start` / `window_end` provenance when shaping final temporal claims
- [retrieval/answerable-unit-reader.ts](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/retrieval/answerable-unit-reader.ts)
  - widened safe multi-unit aggregation for list-family questions
- [exact-answer-control.ts](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/retrieval/exact-answer-control.ts)
  - widened wide-profile list-family score thresholds for hobbies / martial arts
- [answerable-unit-review.mjs](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/test/answerable-unit-review.mjs)
  - added regression coverage for lower-scored martial-arts aggregation

Guardrails:
- `npm run test:answerable-unit-review` -> pass
- `npm run test:exact-answer-control` -> pass
- `npm run build` -> pass

Artifacts:
- [locomo-2026-03-29T11-14-57-748Z.json](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/locomo-2026-03-29T11-14-57-748Z.json)
- [locomo-2026-03-29T11-14-57-748Z.md](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/locomo-2026-03-29T11-14-57-748Z.md)

Result:
- pass rate stayed at `0.600`
- failure mix stayed flat:
  - `temporal: 4`
  - `answer_shaping: 7`
  - `alias_entity_resolution: 2`
  - `abstention: 3`

What the focused debug namespace proved:
- `When did Maria donate her car?`
  - the typed temporal lane is still admitting a wrong `last year` row because one generic overlap term can still dominate before the real donation row is surfaced
- `What martial arts has John done?`
  - this is no longer a pure answer-shaping miss
  - the system is still failing to retrieve the `taekwondo` source row into the exact-detail support set, so the final claim collapses to `kickboxing`
- `What are Joanna's hobbies?`
  - the list got denser (`writing, reading, watching movies, exploring nature`) but still missed `hanging with friends`
  - that points to support expansion / coverage, not simple abstention

Conclusion:
- this loop exhausted the cheap, principled fixes in the current lane
- the next real gains require a deeper architectural pass on:
  1. temporal anchor admission that distinguishes action terms from generic nouns
  2. exact-detail support expansion so list-family queries pull additional source rows before synthesis
  3. stronger source backfill when top answerable units lose the original `source_uri` trail

## Remediation Loop 12

Goal:
- turn the plateau findings into three substrate changes:
  - answerable-unit exact-detail backfill should rank value-bearing list fragments ahead of generic rows
  - temporal shaping should let event-local relative cues outrank generic window anchors
  - companion queries should keep ambiguous reader evidence alive for later social inference

NotebookLM / research direction used:
- keep retrieval structural:
  - event-local temporal evidence over mention-time summaries
  - bounded exact-detail fan-out from owned units
  - relation queries should preserve evidence even when reader collapse is ambiguous

Code changes:
- [retrieval/answerable-unit-reader.ts](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/retrieval/answerable-unit-reader.ts)
  - ambiguous reader results now retain the selected evidence rows instead of dropping them
- [retrieval/service.ts](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/retrieval/service.ts)
  - answerable-unit exact-detail backfill now ranks value-bearing texts instead of stopping early on the first top-scored texts
  - event-local source snippets now outrank generic `window_start` temporal shaping when they contain a real relative cue
  - companion queries now merge reader evidence when the query is `friends besides X`
  - richer reader exact-detail fallbacks can beat thinner derived list answers
- [test/answerable-unit-review.mjs](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/test/answerable-unit-review.mjs)
  - added coverage for ambiguous companion evidence carry-forward

Guardrails:
- `npm run build` -> pass
- `npm run test:answerable-unit-review` -> pass
- `npm run test:exact-answer-control` -> pass

Artifacts:
- [locomo-2026-03-29T13-37-17-411Z.json](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/locomo-2026-03-29T13-37-17-411Z.json)
- [locomo-2026-03-29T13-37-17-411Z.md](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/locomo-2026-03-29T13-37-17-411Z.md)

Result:
- mini LoCoMo improved from `0.650` to `0.675`
- question-level gain:
  - `When is Jon's group performing at a festival?` -> pass
- no regressions versus the `13:22` baseline

What this loop proved:
- event-local temporal precedence was the right fix for the Jon festival miss
- the remaining exact-detail misses were not solved by shallow backfill alone
- companion evidence is now preserved, but the social inference lane still does not convert that evidence into a final grounded claim

## Remediation Loop 13

Goal:
- push the next smallest substrate moves that could realistically break `.7`:
  - deepen answerable-unit candidate coverage for list-family questions
  - broaden first-person social-evidence recognition for `besides X` relation queries

Code changes:
- [retrieval/answerable-unit-retrieval.ts](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/retrieval/answerable-unit-retrieval.ts)
  - widened non-generic answerable-unit candidate slices, with larger caps for martial arts, hobbies, and allergy-safe pet queries
- [retrieval/service.ts](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/retrieval/service.ts)
  - companion-exclusion reasoning now treats first-person social statements as primary-subject evidence when the content clearly refers to old friends, teammates, or people outside the speaker's circle

Guardrails:
- `npm run build` -> pass
- `npm run test:answerable-unit-review` -> pass
- `npm run test:exact-answer-control` -> pass

Artifacts:
- [locomo-2026-03-29T13-45-23-268Z.json](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/locomo-2026-03-29T13-45-23-268Z.json)
- [locomo-2026-03-29T13-45-23-268Z.md](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/locomo-2026-03-29T13-45-23-268Z.md)

Result:
- mini LoCoMo improved from `0.675` to `0.700`
- question-level gain:
  - `What temporary job did Jon take to cover expenses?` -> pass
- no regressions versus the `13:37` run

Remaining misses after reaching `0.700`:
- `When did Melanie paint a sunrise?` -> temporal
- `Would Caroline still want to pursue counseling as a career if she hadn't received support growing up?` -> conflict_resolution
- `What did Melanie realize after the charity race?` -> abstention
- `What martial arts has John done?` -> answer_shaping
- `Who did Maria have dinner with on May 3, 2023?` -> answer_shaping
- `What might John's financial status be?` -> answer_shaping
- `What sparked John's interest in improving education and infrastructure in the community?` -> answer_shaping
- `What are Joanna's hobbies?` -> answer_shaping
- `When did Joanna first watch "Eternal Sunshine of the Spotless Mind?` -> temporal
- `Is it likely that Nate has friends besides Joanna?` -> answer_shaping
- `What pets wouldn't cause any discomfort to Joanna?` -> answer_shaping
- `What is one of Joanna's favorite movies?` -> abstention

What still looks structural:
- `John martial arts` still truncates to one retrieved support row despite the wider candidate slice
- `Joanna hobbies` and `pets` still need better value-bearing support expansion rather than another answer template tweak
- `Nate besides Joanna` still preserves evidence but does not yet convert it into a stable social-graph claim
- `Joanna favorite movie` and `Eternal Sunshine` remain constrained by weak literal-title grounding in the source corpus

## Remediation Loop 14

Goal:
- push the next structural slice without hacks:
  - tighten the purchase lane so `cover expenses` stops hijacking non-purchase questions
  - try a write-path media sidecar path for image-query/title carry-forward
  - keep the short guardrails green before a benchmark rerun

Code changes:
- [retrieval/query-signals.ts](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/retrieval/query-signals.ts)
  - purchase summary routing now ignores generic `expenses` phrases when the query is actually about a temporary job
- attempted, then rolled back:
  - benchmark metadata sidecars for per-turn media queries
  - typed-memory sidecar parsing for media carry-forward

Guardrails:
- `npm run build` -> pass after a type fix in the sidecar path
- `npm run test:answerable-unit-review` -> pass
- `npm run test:exact-answer-control` -> pass

Artifacts:
- stable pre-experiment baseline:
  - [locomo-2026-03-30T03-16-41-172Z.json](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/locomo-2026-03-30T03-16-41-172Z.json)
- regressed sidecar experiment:
  - [locomo-2026-03-30T03-30-34-871Z.json](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/locomo-2026-03-30T03-30-34-871Z.json)

Result:
- the sidecar experiment regressed mini LoCoMo from `0.700` to `0.650`
- it did not fix the Joanna movie/title misses
- it also introduced unrelated drift in previously green lanes, so it was rolled back

What this loop proved:
- safe write-path sidecars are still the right architectural idea, but this specific benchmark-integration attempt was not yet grounded enough and should not be carried forward
- the purchase-lane tightening was still correct: `temporary job` stopped falling into purchase memory

## Remediation Loop 15

Goal:
- keep the good routing fix from Loop 14
- turn the `temporary job` question into a structured abstention when the role is unspecified
- restore the stable `.700` floor and see whether the narrower fix buys a net gain

Code changes:
- [retrieval/service.ts](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/retrieval/service.ts)
  - `temporary job` extraction now returns `None` when the evidence only says a temp job exists but never names the role
- [test/exact-answer-control.mjs](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/test/exact-answer-control.mjs)
  - added regression coverage for generic `temp job` mentions resolving to structured abstention

Guardrails:
- `npm run build` -> pass
- `npm run test:answerable-unit-review` -> pass
- `npm run test:exact-answer-control` -> pass

Artifacts:
- interrupted long rerun with `39/40` questions complete:
  - [locomo-2026-03-30T03-33-53-706Z.partial.json](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/locomo-2026-03-30T03-33-53-706Z.partial.json)

Result:
- hard floor from the interrupted run: `28/39` passes, which is already `0.700` against the full 40-question denominator
- question-level gain that held:
  - `What temporary job did Jon take to cover expenses?` -> pass
- other previously green lanes recovered:
  - `What is John's main focus in international politics?` -> pass again
  - `What did Caroline realize after her charity race?` -> pass again

Operational note:
- one rerun hit a stale maintenance lock because an older `benchmark:locomo` process tree was still alive in cleanup
- the stale benchmark processes were audited and cleared before the next rerun

What still looks structural after the latest pass:
- `Joanna favorite movie` and `Eternal Sunshine` still need a stronger title/entity grounding path
- `Joanna hobbies` still misses `hanging with friends` despite the exact-answer lane test coverage, which suggests a retrieval/support-set issue rather than a formatter issue
- `Nate besides Joanna` still needs real social-set adjudication
- `Melanie sunrise` and `Melanie realize after the charity race` remain temporal/event-anchor problems

## Remediation Loop 16

Goal:
- push the next structural lift without cheap hacks:
  - make `besides X` queries behave like set aggregation instead of plain ambiguity
  - widen the owned hobby aggregation window a little further
  - keep `temporary job` on structured abstention instead of letting reader fallback leak unrelated text
  - retry a safer multimodal metadata path for typed extraction only

Code changes:
- [retrieval/answerable-unit-reader.ts](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/retrieval/answerable-unit-reader.ts)
  - added `social_exclusion` as a real aggregation family
  - widened hobby aggregation cap from `7` to `10`
  - social companion queries now resolve through aggregated owned evidence instead of defaulting to `ambiguous`
- [retrieval/service.ts](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/retrieval/service.ts)
  - raw reader fallback is now suppressed for `temporary job` and `financial status` inference queries when no true extracted value exists
- [typed-memory/service.ts](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/typed-memory/service.ts)
  - speaker-turn parsing now accepts attached `image_query` / `image_caption` sidecars
  - typed media/person-time extraction can read that metadata without putting it into normal spoken content
- [benchmark/locomo.ts](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/benchmark/locomo.ts)
- [benchmark/public-memory-miss-regressions.ts](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/benchmark/public-memory-miss-regressions.ts)
  - benchmark writers now emit `--- image_query:` and `--- image_caption:` sidecars after multimedia turns
- tests:
  - [test/answerable-unit-review.mjs](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/test/answerable-unit-review.mjs)
  - [test/exact-answer-control.mjs](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/test/exact-answer-control.mjs)

Guardrails:
- `npm run build` -> pass
- `npm run test:answerable-unit-review` -> pass
- `npm run test:exact-answer-control` -> pass

Artifacts:
- latest interrupted rerun:
  - [locomo-2026-03-30T03-39-36-201Z.partial.json](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/locomo-2026-03-30T03-39-36-201Z.partial.json)
- last full stable floor remains:
  - [locomo-2026-03-30T03-16-41-172Z.json](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/locomo-2026-03-30T03-16-41-172Z.json)

Result:
- the long mini rerun was interrupted again by the desktop tool sending `SIGTERM` while streaming the job
- despite that, the observable question-level gain held:
  - `What temporary job did Jon take to cover expenses?` -> pass
- no small-test regressions were introduced by the social-exclusion/hobby changes

What this loop proved:
- the new `social_exclusion` aggregation lane is structurally correct and regression-tested, but it still needs a full uninterrupted mini run to claim benchmark movement
- the safe multimodal sidecar path is cleaner than the previous inline-query experiment because typed extraction can see query metadata without turning it into ordinary prompt text
- the desktop benchmark runner itself is now the main operational blocker for proving the full score, not a product crash or DB lock issue

What still looks structural after this pass:
- `Joanna favorite movie` / `Eternal Sunshine` still need a full uninterrupted rerun to confirm whether the sidecar path actually closes the title gap
- `Joanna hobbies` remains the clearest sign that support-set expansion still has a missing sibling-fact path
- `Nate besides Joanna` is implemented in the reader lane, but still needs full benchmark proof
- `Melanie sunrise` and the remaining charity-race reasoning miss remain event-anchor / causal-inference problems

## Remediation Loop 17

Goal:
- stabilize the benchmark runner and turn the media/title lane into a trustworthy, uninterrupted measurement loop
- verify whether media carry-forward plus temporal-anchor precedence actually moves the benchmark, instead of relying on partial artifacts

Research checkpoint:
- NotebookLM guidance for temporal QA was explicit: if a typed fact already carries a normalized event year, the answer builder should prefer that normalized year over re-applying a relative phrase against the event timestamp. The relative phrase should stay in the evidence bundle, not drive a second temporal calculation.
- This matched the observed bug: the system selected the correct typed temporal media row for Joanna, then re-applied `around 3 years ago` against the already-normalized 2020 anchor and drifted back to `2017`.

Code changes:
- [retrieval/service.ts](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/retrieval/service.ts)
  - `deriveTemporalClaimText()` now prefers `normalized_year` before re-deriving a relative year from a focused snippet
- [test/temporal-anchor-review.mjs](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/test/temporal-anchor-review.mjs)
  - added regression coverage proving that a normalized event year wins over a second relative-time pass

Guardrails:
- `npm run build` -> pass
- `npm run test:temporal-anchor-review` -> pass
- `npm run test:typed-media-review` -> pass
- `npm run test:answerable-unit-review` -> pass

Direct validation:
- scratch namespace `debug_locomo_conv42_focus` was rebuilt
- `What is one of Joanna's favorite movies?` now routes through typed media carry-forward and returns `Eternal Sunshine of the Spotless Mind`
- `When did Joanna first watch "Eternal Sunshine of the Spotless Mind"?` now returns `The best supported year is 2020.`

Artifact:
- first uninterrupted detached mini run after runner hardening:
  - [locomo-2026-03-30T07-03-11-058Z.json](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/locomo-2026-03-30T07-03-11-058Z.json)
  - [locomo-2026-03-30T07-03-11-058Z.md](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/locomo-2026-03-30T07-03-11-058Z.md)

Result:
- mini LoCoMo moved from the prior trusted `0.725` run to `0.750`
- the detached runner completed with a final artifact and no lingering benchmark lock residue
- `What is one of Joanna's favorite movies?` passed in the benchmark
- `When did Joanna first watch "Eternal Sunshine of the Spotless Mind?"` still failed in-benchmark, which meant one more query-shape bug remained

Protected check outcome after the `0.750` move:
- [public-memory-miss-regressions-2026-03-30T07-03-44-556Z.json](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/public-memory-miss-regressions-2026-03-30T07-03-44-556Z.json) -> failed
- [mcp-production-smoke-2026-03-30T07-05-42-010Z.json](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/mcp-production-smoke-2026-03-30T07-05-42-010Z.json) -> failed
- [personal-omi-review-2026-03-30T07-06-39-244Z.json](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/personal-omi-review-2026-03-30T07-06-39-244Z.json) -> `24 pass / 4 warning / 1 fail`

What this loop proved:
- runner hardening worked; the benchmark can now complete cleanly without desktop `SIGTERM` killing the evidence trail
- the temporal precedence fix was correct, but the benchmark still had one malformed-query path that bypassed typed media title recovery
- the structural LoCoMo gains are real, but protected product lanes are still not green enough to call this slice stable

## Remediation Loop 18

Goal:
- close the remaining Joanna temporal benchmark miss without introducing a benchmark-specific hack
- handle malformed or unmatched quoted titles as a robust parser problem, not a special case

Failure pattern:
- the benchmark query is malformed:
  - `When did Joanna first watch "Eternal Sunshine of the Spotless Mind?`
- with a balanced quote, the query routed through typed media anchors and returned `2020`
- with the unmatched opening quote, the query fell back to a generic `temporal_person_time_anchor` row and produced `2017`

Why this is structural:
- real user queries are often malformed or partially quoted
- a media/title carry-forward system should recover a trailing unmatched quote span when the rest of the query strongly signals a title lookup
- this is parser robustness, not benchmark-answer hardcoding

Code changes:
- [typed-memory/service.ts](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/typed-memory/service.ts)
  - `extractQuotedQueryText()` now recovers a trailing unmatched double-quote span and strips terminal punctuation before title lookup
- [test/typed-media-review.mjs](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/test/typed-media-review.mjs)
  - added regression coverage proving that `getTypedMediaResults()` can still recover `Eternal Sunshine of the Spotless Mind` from the malformed query text

Guardrails:
- `npm run build` -> pass
- `npm run test:typed-media-review` -> pass

Direct validation:
- scratch query using the exact malformed benchmark string now returns typed media rows and the claim:
  - `The best supported year is 2020.`

Artifact:
- second uninterrupted detached mini run after the malformed-title fix:
  - [locomo-2026-03-30T07-15-44-107Z.json](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/locomo-2026-03-30T07-15-44-107Z.json)
  - [locomo-2026-03-30T07-15-44-107Z.md](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/locomo-2026-03-30T07-15-44-107Z.md)

Result:
- mini LoCoMo improved again from `0.750` to `0.775`
- the Joanna first-watch temporal miss is now closed

Current remaining miss taxonomy at `0.775`:
- `temporal`
  - `conv-26 / index 3`
- `conflict_resolution`
  - `conv-26 / index 5`
- `abstention`
  - `conv-26 / index 7`
- `answer_shaping`
  - `conv-41 / index 4`
  - `conv-41 / index 7`
  - `conv-42 / index 1`
  - `conv-42 / index 4`
  - `conv-42 / index 5`
  - `conv-42 / index 9`

What this loop proved:
- media title/entity carry-forward is now materially stronger and benchmark-proven
- the next gains are no longer in title parsing or temporal media precedence
- the remaining blockers are concentrated in:
  - residual temporal/event anchoring outside the media-title lane
  - social/conflict reasoning
  - answer-shaping / sibling-fact aggregation for hobbies, pets, and set-style detail

## Remediation Loop 19

Goal:
- turn the remaining low-hanging answer-shaping misses into deterministic read-path behavior:
  - favorite trilogy should abstain instead of leaking a single favorite movie
  - social-set answers should use a shorter normalized phrase instead of verbose scaffolding

Code changes:
- [retrieval/service.ts](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/retrieval/service.ts)
  - favorite-media typed lane now explicitly abstains when a trilogy is requested but only single-title favorites are grounded
  - companion-exclusion claim text was shortened to a normalized teammate form

Guardrails:
- `npm run build` -> pass
- `npm run test:exact-answer-control` -> pass

Direct validation:
- `What is Joanna's favorite movie trilogy?` now returns `None.`
- `Is it likely that Nate has friends besides Joanna?` now returns `Yes, teammates on his video game team.`

Artifact:
- [locomo-2026-03-30T08-39-29-559Z.json](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/locomo-2026-03-30T08-39-29-559Z.json)
  - result: `0.800`

What this loop proved:
- the trilogy leakage was a real product bug and is now closed
- the Nate miss did not clear even after the normalized phrasing change, which strongly suggests the benchmark expectation itself is malformed enough that it does not reward the semantically correct answer

## Remediation Loop 20

Goal:
- confirm whether the Nate normalization issue was really a scorer/expectation artifact or a missed read-path branch

Artifact:
- [locomo-2026-03-30T08-47-26-332Z.json](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/locomo-2026-03-30T08-47-26-332Z.json)
  - result: still `0.800`

Current remaining miss taxonomy at `0.800`:
- `temporal`
  - `When did Melanie paint a sunrise?`
- `conflict_resolution`
  - `Would Caroline still want to pursue counseling as a career if she hadn't received support growing up?`
- `abstention`
  - `What did Melanie realize after the charity race?`
- `answer_shaping`
  - `What might John's financial status be?`
  - `What sparked John's interest in improving education and infrastructure in the community?`
  - `What are Joanna's hobbies?`
  - `Is it likely that Nate has friends besides Joanna?`
  - `What pets wouldn't cause any discomfort to Joanna?`

Why the next point is harder:
- at least some remaining `conv-42` expectations are malformed in a way that punishes semantically correct phrasing after normalization
- the real, non-hacky product gains now sit in:
  - conflict/counterfactual reasoning
  - causal-chain extraction
  - broader sibling-fact aggregation with better exact-answer shaping

Recommendation:
- do not chase `0.825` by emitting malformed strings
- if the goal is a truthful product improvement, the next honest slice is:
  1. conflict/counterfactual evidence chains
  2. causal motive extraction
  3. one more pass on hobbies/pets sibling-fact aggregation

## Remediation Loop 21

Goal:
- implement the Phase 3 structural conflict / causality lane without benchmark-string hacks:
  - counterfactual support-removal
  - realization / motive event-neighborhood routing
  - scratch validation before any new mini benchmark

Code changes:
- [retrieval/service.ts](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/retrieval/service.ts)
  - added `isEventNeighborhoodReasoningQuery(...)` so realization and event-linked motive questions are promoted into bounded event reasoning without widening the base `isEventBoundedQuery(...)` predicate
  - added event-neighborhood episodic fallback retrieval for realization / motive families when `narrative_events` are absent
  - tightened event-bounded evidence terms to carry anchor terms from `after ...` spans and removed overly broad realization-family theme expansion
  - counterfactual / realization / motive derivation paths remain source-backed and deterministic
- [causal-chain-review.mjs](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/test/causal-chain-review.mjs)
  - added regressions proving the service-layer promotion happens without broadening `isEventBoundedQuery(...)`

Guardrails:
- `npm run test:causal-chain-review` -> pass

Scratch validation:
- namespace: `debug_conv26_realization`
- query: `What did Melanie realize after the charity race?`
- result: still `None.`

What this loop proved:
- the Caroline counterfactual lane is structurally stronger and survives the small-test suite
- the Melanie realization miss is no longer blocked by missing family derivation logic
- the remaining blocker is upstream retrieval/fusion selection:
  - the correct session 2 episodic rows exist in the DB
  - direct SQL on `episodic_memory` surfaces the right `charity race` / `thought-provoking` / `self-care` rows
  - `searchMemory(...)` still drops them in favor of later generic Melanie rows from other sessions

Current conclusion:
- the next fix for the Melanie realization miss is not another local claim-text tweak
- it is a deeper fusion / result-selection issue in the final retrieval assembly path
- this lane should be treated as a documented plateau until we explicitly tackle fusion ordering for anchor-first event neighborhoods

## Remediation Loop 22

Goal:
- execute the three research-backed fixes together and verify whether they improve the end-to-end mini benchmark:
  1. hard subject-bound propagation for event-neighborhood reasoning
  2. detached benchmark cleanup/final-artifact reliability
  3. stronger shaping for John/Joanna/Nate by preserving answerable-unit backfill and blocking noisy raw fallback

Research basis:
- NotebookLM convergence stayed the same across the three research notebooks:
  - bind subject before propagation
  - use deterministic set logic instead of generic retrieval for exclusion-style social questions
  - aggregate bounded sibling/evidence-chain support before final shaping
- External patterns stayed aligned:
  - HeidelTime / UnSeenTimeQA for event anchoring
  - multiparty dialogue coreference for subject closure
  - dialogue relation extraction for bounded cross-turn evidence assembly

Code changes:
- [retrieval/service.ts](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/retrieval/service.ts)
  - added speaker-owned provenance parsing helpers and subject-bound realization shaping so event-neighborhood answers do not leak neighboring speakers
  - blocked raw fallback for `financial status`, `hobbies`, `pets`, `besides X`, and `sparked interest` families
  - preserved `answerableUnitExactDetailBackfill` through the late exact-detail recompute path instead of dropping it after the early pass
- [benchmark/public-benchmark-cleanup.ts](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/benchmark/public-benchmark-cleanup.ts)
  - added statement/lock timeout controls and cleanup logging
- [benchmark/locomo.ts](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/benchmark/locomo.ts)
  - made cleanup warning-tolerant so detached runs continue to a final artifact instead of stalling after `40/40`
- [causal-chain-review.mjs](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/test/causal-chain-review.mjs)
  - added the no-speaker-leak regression

Guardrails:
- `npm run build` -> pass
- `npm run test:causal-chain-review` -> pass
- `npm run test:exact-answer-control` -> pass
- `npm run test:answerable-unit-review` -> pass

Artifact:
- [locomo-2026-03-31T03-19-40-712Z.json](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/locomo-2026-03-31T03-19-40-712Z.json)
  - result: `0.825`

What improved:
- mini LoCoMo moved from the trusted `0.800` baseline to `0.825`
- the detached runner completed cleanly and wrote a final artifact after the post-`40/40` cleanup path
- `What did Melanie realize after the charity race?` is now recovered by the anchor-first subject-bound lane
- the old Melanie -> Caroline realization leakage is gone
- `What martial arts has John done?` held as a pass in the new run

What remained / regressed:
- residual structural misses:
  - `When did Melanie paint a sunrise?`
  - `What fields would Caroline be likely to pursue in her educaton?`
  - `What did Caroline realize after her charity race?`
  - `What might John's financial status be?`
  - `What sparked John's interest in improving education and infrastructure in the community?`
  - `What are Joanna's hobbies?`
  - `Is it likely that Nate has friends besides Joanna?`
  - `What pets wouldn't cause any discomfort to Joanna?`
- some prior benchmark-normalization noise is still present on items that are marked `passed=true` but `normalizedPassed=false`

Current conclusion:
- the three fixes were directionally right and produced a real score gain
- the runner hardening is now good enough for trustworthy final artifacts
- the next high-yield product work is narrower:
  1. residual temporal/event-anchor residue for `Melanie sunrise`
  2. causal/profile evidence-chain shaping for John and Caroline
  3. sibling-fact aggregation and deterministic social-set logic for Joanna/Nate

## Remediation Loop 23

Goal:
- push the Joanna / Nate list-family lane forward without benchmark-string hacks by using the same pattern NotebookLM recommended:
  - subject-bound neighborhood expansion
  - deterministic family reduction
  - then a final exact-detail bridge so the reduced output survives late shaping

Research basis:
- Brain notebook answer:
  - root on the subject
  - expand only within the subject-bound provenance neighborhood
  - use deterministic set reduction for exclusion queries
  - preserve provenance-linked evidence bundles rather than relying on one-shot snippet summarization
- This stayed aligned with the external graph-memory patterns already in use as references:
  - Graphiti / GraphZep
  - HippoRAG / GraphRAG
  - dialogue relation extraction work

Code changes:
- [retrieval/answerable-unit-reader.ts](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/retrieval/answerable-unit-reader.ts)
  - added family-aware reduction for:
    - `hobbies`
    - `allergy_safe_pets`
    - `social_exclusion`
  - changed multi-unit aggregation from raw snippet concatenation to deterministic family reduction
  - added explicit social-set phrasing from bounded evidence
- [retrieval/service.ts](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/retrieval/service.ts)
  - added a late fallback bridge so reader-reduced hobbies / pets / social-set outputs can become final exact-detail candidates instead of being dropped by the older sentence-pattern extractor
- [test/answerable-unit-review.mjs](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/test/answerable-unit-review.mjs)
  - added regression coverage for hobby reduction, social exclusion phrasing, and allergy-safe pet reduction

Guardrails:
- `npm run build` -> pass
- `npm run test:answerable-unit-review` -> pass
- `npm run test:exact-answer-control` -> pass
- `npm run test:causal-chain-review` -> pass

Artifacts:
- [locomo-2026-03-31T05-50-51-400Z.json](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/locomo-2026-03-31T05-50-51-400Z.json)
  - first verification after family reduction
  - result: `0.825`
- [locomo-2026-03-31T05-58-52-866Z.json](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/locomo-2026-03-31T05-58-52-866Z.json)
  - second verification after the late exact-detail bridge
  - result: `0.825`

What changed in the failure shape:
- `What are Joanna's hobbies?`
- `Is it likely that Nate has friends besides Joanna?`
- `What pets wouldn't cause any discomfort to Joanna?`

These are no longer failing as retrieval / abstention misses. In the latest run they are:
- `readerDecision = resolved`
- large owned answerable-unit sets are present
- `sufficiency = supported`

That means:
- the structural retrieval work succeeded
- the next blocker is now final claim selection / answer shaping, not neighborhood recall

Important examples:
- Nate now surfaces a grounded social-set sentence:
  - `Yes, teammates on his video game team, friends outside his usual circle from tournaments.`
  - but the benchmark still does not normalize it to a pass
- Joanna hobbies and pet-safety no longer die as `missing`, but the surfaced top snippet is still wrong for normalized scoring

Current conclusion:
- this slice improved the product path even though the mini score held at `0.825`
- the next honest work is no longer more neighborhood expansion
- it is now:
  1. final claim ordering / snippet preference for supported list-family answers
  2. residual temporal residue (`Melanie sunrise`)
  3. Caroline / John causal-profile shaping
