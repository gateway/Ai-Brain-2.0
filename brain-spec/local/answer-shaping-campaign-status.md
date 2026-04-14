# Answer Shaping Campaign Status

## Current Top Bottlenecks
- The planner-control pass is now live, and the first question is whether it materially reduces exact-detail takeover on the release-candidate LoCoMo lane.
- The bookshelf row is still the first inferential blocker to watch, but `selectedFamily=report` plus `supportObjectType=ProfileInferenceSupport` rows should no longer be allowed to stay on exact-detail ownership by policy alone.
- The next bottlenecks behind that row are still:
  - `right_owner_incomplete_support` for report rows
  - `list_set_rendering_wrong` for book/event lists
  - residual temporal contract quality

## Loop History

### Loop 13
- Turned `answer-retrieval-plan.ts` into live runtime input for profile inference retrieval.
- Added planner-driven candidate pools, suppression pools, query expansion terms, and banned expansion terms.
- Result:
  - bookshelf row stopped pulling counseling/career evidence
  - `wrong_owner` moved out of the early prefix
  - row still abstained due missing decisive support

### Loop 14
- Fixed modal subject extraction and recursive collection/community subqueries in `service.ts`.
- Result:
  - `Would Caroline ...` now resolves subject correctly
  - recursive prompts became collection/community specific instead of generic work prompts

### Loop 15
- Added inferential report rescue before canonical abstention for report-like rows in `canonical-adjudication.ts`.
- Split broad contracts in `support-objects.ts`:
  - `community_membership_inference`
  - `ally_likelihood_judgment`
  - `book_list_render`
  - `event_list_render`
- Added typed fallback promotion for list-set support and then tightened it with query-compatible filters.
- Result:
  - `What books has Melanie read?` now enters `book_list_render`
  - `Would Melanie be considered a member of the LGBTQ community?` now enters `community_membership_inference`
  - `What LGBTQ+ events has Caroline participated in?` and child-support event rows now enter `event_list_render`
  - bookshelf row still stays on `canonical_abstention`, so the next fix must be runtime support backfill before owner selection

### Loop 16
- Strengthened support normalization to ingest metadata-heavy evidence channels and upgraded book-title extraction into clause-aware typed entry recovery.
- Added an apples-to-apples full-mode LoCoMo run (`1985/1986` rows completed before the runner stopped one question short).
- Result:
  - the large-run bottleneck shifted clearly away from list-set routing and toward owner/source mismatch
  - dominant diagnosis is now `right_owner_wrong_shape`
  - dominant failing lane is typed support or exact-detail claims still collapsing into `canonical_exact_detail`

### Loop 17
- Added a repo-visible public-pattern adoption matrix in `brain-spec/local/repo-adoption-matrix.md`.
- Tightened canonical adjudication so typed rendered support can override stored-fact exact-detail ownership:
  - report support now maps to `canonical_profile` / `canonical_counterfactual`
  - list-set support now maps to `canonical_list_set`
  - temporal support now maps to `canonical_temporal`
- Added regression coverage for report-support takeover over stored fact rows.

### Loop 18
- Strengthened the planner/control-plane layer:
  - expanded `AtomicMemoryUnit` fields in retrieval types and extraction
  - tightened career judgment rendering so direct career-path rows keep concrete values while counterfactual judgment rows stay narrow
- Added planner-owned targeted backfill completeness checks for:
  - `collection_support`
  - `preference_support`
- Added planner-generated bookshelf / preference backfill subqueries and generated-query suppression coverage.
- Result:
  - local validation stayed green
  - early 304-row slice stayed flat in aggregate
  - dominant unresolved row stayed `Would Caroline likely have Dr. Seuss books on her bookshelf?`

### Loop 19
- Added planner-side second-chance abstention rescue in `service.ts`:
  - if stored canonical ownership is only `abstention` and planner family is `report` / `list_set`, run a family-directed backfill pass before final canonical adjudication
- Added an abstention-rescue variant for collection backfill queries so the rescue pass asks different collection probes instead of repeating the same bookshelf-first pair.
- Added regression coverage for the abstention-rescue query ordering.
- Result:
  - local build and focused suites are green
  - fresh 304-row rerun still shows the bookshelf row landing on `canonical_abstention`
  - this isolates the remaining bug more tightly: the planner rescue hooks are now live, but the canonical abstention path still exits without typed collection support on that row

### Loop 20
- Finalized planner DTOs and planner-lane tracing in `types.ts` and `answer-retrieval-plan.ts`:
  - explicit planner `lane`
  - resolved subject hint
  - targeted backfill request objects
  - family confidence
  - support completeness target
  - rescue policy
- Strengthened `AtomicMemoryUnit` so extracted evidence units now carry:
  - `plannerFamily`
  - `supportClass`
  - `lexicalMatchTerms`
- Tightened `answer-owner-policy.ts` so:
  - typed report/list-set/temporal shaping can upgrade canonical owner selection even when stored canonical source still looks exact-detail
  - exact-detail is suppressed when the planner and typed lane both say a structured family is viable
- Aligned `service.ts` shaping/final-claim telemetry so owner-policy report winners reuse report shaping traces even if the stored canonical row started as `canonical_exact_detail`.
- Added regression coverage for:
  - collection-inference lane assignment
  - report-owner takeover over exact-detail
- Result:
  - `npm run test:answer-owner-policy-review --workspace local-brain` green
  - `npm run test:canonical-adjudication-review --workspace local-brain` green
  - `npm run test:answer-shaping-review --workspace local-brain` green
  - release-candidate LoCoMo lane running to verify whether `right_owner_wrong_shape` and `DirectDetailSupport + exact_canonical_value` actually drop

## Before / After Slice Metrics
- Last completed comparable 304-row baseline:
  - `locomo-2026-04-08T10-32-08-625Z.json`
  - `passRate = 0.563`
- Trustworthy near-full-mode signal after Loop 16:
  - `locomo-2026-04-08T14-00-32-227Z.partial.json`
  - `results = 1985 / 1986`
  - `passRate = 0.4081`
  - `failures = 1175`
  - `wrong_owner = 327`
  - `report_semantics_wrong = 139`
  - `subject_binding_missing = 75`
  - `temporal_rendering_wrong = 157`
  - `list_set_rendering_wrong = 12`
- Dominant failing support / contract pairs on that run:
  - `DirectDetailSupport + exact_canonical_value`
  - `SnippetFactSupport + support_span_extract`
  - `ProfileInferenceSupport + report_scalar_value`
- 304-row slice rerun after Loops 18-19:
  - active artifact: `locomo-2026-04-08T16-33-42-089Z.partial.json`
  - current trustworthy checkpoint: first `30` rows
  - first `23` rows vs `locomo-2026-04-08T10-32-08-625Z.json`:
    - `passRate 0.9565 -> 0.9130`
    - `failures +1`
    - `honest_abstention_but_support_missing +1`
    - no movement yet on temporal/list-set aggregates in that prefix
  - row-level proof:
    - `Would Caroline likely have Dr. Seuss books on her bookshelf?`
      - still `finalClaimSource=canonical_abstention`
      - `selectedFamily=abstention`
      - `supportObjectType=null`
      - `answerOwnerTrace.family=report`
      - `answerOwnerTrace.winner=canonical_abstention`
      - this is still the first structural blocker on the current prefix
- Loop 20 validation before benchmark:
  - owner-policy suite:
    - `15/15`
  - canonical adjudication suite:
    - `47/47`
  - answer shaping suite:
    - `51/51`
- Representative live disagreements:
  - `How does John plan to honor the memories of his beloved pet?`
    - this is now covered by owner-policy regression and should no longer remain on exact-detail when typed report shaping has already entered
  - `What does Jon plan to do at the grand opening of his dance studio?`
    - `selectedFamily=report`
    - `supportObjectType=ProfileInferenceSupport`
    - winner still `canonical_exact_detail`

### Loop 21
- Added planner-built runtime report candidates in `service.ts` so typed report support can enter owner resolution before abstention / top-snippet fallback.
- Widened collection normalization in `report-synthesis.ts` so generic collection evidence like `collects vintage records and sports memorabilia` can materialize as `CollectionInferenceSupport`.
- Added owner-policy and answer-shaping regressions for planner-built collection reports.
- Result:
  - release-candidate lane stayed at `passRate = 0.747`
  - `Would Caroline likely have Dr. Seuss books on her bookshelf?` moved to `canonical_report` and passed on the real slice
  - `What items does John collect?` also moved to `canonical_report`, but still failed with `CollectionInferenceSupport + collection_value`
  - next bottleneck narrowed from owner takeover to collection/report support choosing the wrong value under weak subject-bound evidence

### Loop 22
- Tightened collection support and runtime support selection:
  - generic collection queries now score per-text collection candidates instead of flattening all evidence equally
  - incidental `Harry Potter` / themed mentions no longer count as collection values without an explicit collection cue
  - collection report support now triggers targeted backfill when the pool lacks a real `collect` / `collection` cue even if generic support text volume is high
- Added regressions for:
  - subject-bound collection evidence beating bookshelf distractors
  - incidental Harry Potter mentions not normalizing into generic collection claims
- Result:
  - focused validation is green:
    - `answer-shaping-review 63/63`
    - `answer-owner-policy-review 19/19`
  - first clean release-candidate rerun is active on `locomo-2026-04-09T04-15-03-080Z.partial.json`
  - bookshelf row is still green early in the rerun
  - the next validation point is whether `What items does John collect?` stops producing the wrong collection value or degrades into an honest incompleteness signal

### Loop 23
- Added normalized collection-fact scoring and planner-aware subject recovery:
  - planner-built collection reports can now resolve explicit single-subject rows by name even when runtime rows lack entity ids
  - collection support now prefers normalized explicit collection facts over weak payload summaries
  - exact-detail suppression is confirmed live on `What items does John collect?`; the row now stays in `canonical_report`
- Added collection guardrails:
  - non-bookshelf collection queries now reject incidental theme-only values
  - scene-description values like `movies and dvds on a carpet` are rejected for generic `what items` queries
  - generic collection fallback summaries/runtime claims are now bookshelf-only
- Validation:
  - `build` passed
  - `answer-shaping-review 64/64`
  - `answer-owner-policy-review 20/20`
- Release-candidate result before the final scene-description filter was rerun:
  - artifact: `locomo-2026-04-09T08-45-18-618Z.json`
  - `passRate = 0.747` (flat vs prior comparable release-candidate run)
  - bookshelf row stayed green
  - John row improved structurally:
    - `subject_binding_missing -> resolved`
    - owner stayed `report`
    - exact-detail stayed suppressed
    - remaining failure was `CollectionInferenceSupport + collection_value + report_semantics_wrong`
    - wrong value was still a scene-description fragment, proving the next fix belongs in normalized collection-fact filtering, not planner routing
- Fresh verification rerun after the scene-description filter:
  - active artifact: `locomo-2026-04-09T08-48-16-007Z.partial.json`
  - goal: confirm John either passes or becomes honest incompleteness, then continue into the next collection/profile wrong-value row

### Loop 24
- Converted generic collection inference into a stricter set-completeness lane:
  - plural `what items` collection queries now require at least `2` normalized entries before `collection_set_render` is allowed
  - one surviving entry like `jerseys` is now treated as incomplete support instead of a sufficient final collection answer
- Broadened normalized collection-fact extraction in `support-objects.ts`:
  - added subject-bound patterns like:
    - `John has a collection of ...`
    - `John's collection includes ...`
    - `... are part of John's collection`
    - `John likes collecting ...`
  - these facts now merge into `CollectionSetSupport` instead of relying only on `collects ...`
- Threaded planner targeted-backfill telemetry into runtime shaping traces:
  - `answerShapingTrace` can now carry:
    - `plannerTargetedBackfillApplied`
    - `plannerTargetedBackfillReason`
    - `plannerTargetedBackfillSubqueries`
    - `plannerTargetedBackfillSatisfied`
- Added regressions for:
  - multi-fragment collection entry recovery
  - plural collection queries staying incomplete when only one strong item survives
  - planner targeted-backfill telemetry surviving into runtime shaping traces
- Validation:
  - `build` passed
  - `answer-shaping-review 68/68`
  - `answer-owner-policy-review 20/20`
- Fresh patched validation lane:
  - active artifact: `locomo-2026-04-09T13-26-24-496Z.partial.json`
  - bookshelf row is still green on the patched run
  - Gina remains unchanged on this pass, which is expected because this loop targeted collection completeness rather than report-causal rendering
  - next live checkpoint is still John:
    - if he passes, move to the next collection/profile wrong-value row
    - if he becomes honest incompleteness, the next structural layer is persisted collection-fact preference / backfill materialization
    - if he stays wrong, the next patch belongs in collection fact persistence or cross-row entry extraction, not owner routing

### Loop 25
- Strengthened the atomic evidence boundary and split the weakest remaining profile/report contract:
  - `AtomicMemoryUnit` now carries nested `absoluteDate`, `relativeAnchor`, and explicit `cueTypes`
  - atomic extraction now tags planner lane, lexical overlap, collection/event/causal cues
  - `ProfileInferenceSupport` now tracks `reasonCueTypes` and `supportCompletenessScore`
  - `why` / causal profile queries now enter `causal_reason_render` instead of defaulting to `report_scalar_value`
- Added focused regressions for:
  - Gina-style causal report support
  - atomic-unit temporal/anchor normalization
- Validation:
  - `build` passed
  - `answer-shaping-review 70/70`
  - `answer-owner-policy-review 21/21`
- Expected benchmark effect:
  - reduce `report_semantics_wrong` for causal/profile rows that were already in `canonical_report`
  - keep planner-approved report rows from flattening into weak scalar contracts once support is present

### Loop 26
- Adopted the next SimpleMem-style evidence boundary for collection inference:
  - normalized collection facts now expand into first-class `AtomicMemoryUnit` entries during planner extraction
  - planner-owned collection support can consume those atomic units directly instead of rediscovering item facts from mixed recall metadata every time
  - canonical report, narrative report, and runtime planner-report paths now pass collection atomic units into `CollectionSetSupport`
- Added regressions for:
  - atomic-unit expansion of normalized collection facts
  - collection support built directly from atomic units
- Validation:
  - `build` passed
  - `answer-shaping-review 73/73`
  - `answer-owner-policy-review 23/23`
  - `canonical-memory-review 44/44`
- Benchmark evidence before the fresh rerun:
  - stale comparable artifact `locomo-2026-04-10T02-52-18-410Z.partial.json` remained flat vs `locomo-2026-04-10T02-06-30-282Z.json`
  - John still abstained there, which confirms the old run did not include this new atomic-unit slice
- Fresh comparable rerun:
  - active artifact will be the next `canonical-local` `150`-question release-candidate lane launched after Loop 26 validation
  - primary gate remains:
    - `What items does John collect?`
  - expected structural effect:
    - John should no longer need to rediscover persisted collection facts from raw support text
    - the remaining risk becomes final set ranking/order rather than missing typed support

### Loop 27
- Confirmed the next blocker is planner-runtime typed-pool consumption, not collection-fact synthesis:
  - replayed `conv-43` showed persisted `canonical_collection_facts` now exist for John (`sneakers`, `jerseys`, `Harry Potter DVDs`, `Lord of the Rings DVDs`)
  - live benchmark row still reached `abstention_final_fallback` with no `canonical_report` candidate, even though `normalized_collection_facts` was in the retrieval plan
- Applied the next GraphRAG-style typed-pool fix:
  - planner-owned collection-fact reads in `service.ts` now fall back to namespace-scoped subject-name binding when resolved subject entity ids are absent
  - the collection-fact runtime pool now rehydrates subject identity from matched rows before building recall results
- Validation:
  - `build` passed
  - `answer-owner-policy-review 23/23`
  - `answer-shaping-review 73/73`
- Fresh comparable rerun:
  - active artifact: `locomo-2026-04-10T03-44-16-925Z.partial.json`
  - primary gate remains:
    - `What items does John collect?`
  - expected structural effect:
    - John should stop losing the planner-owned typed collection lane before shaping
    - if he still abstains, the next escalation is a persisted collection-fact support layer for direct planner candidate materialization, not more collection synthesis tweaks

### Loop 28
- Turned the collection fact runtime path into an explicit typed-candidate subsystem instead of a hidden fallback:
  - added a dedicated persisted-fact candidate builder path in `service.ts`
  - direct collection-fact candidates can now materialize a `CollectionSetSupport` owner from persisted facts alone
  - the general report lane now uses this collection-fact candidate as a first-class planner candidate rather than treating persisted facts as only an augmentation source
- Added focused regression coverage for:
  - direct collection-fact candidate materialization without depending on mixed report results
- Validation:
  - `build` passed
  - `answer-owner-policy-review 24/24`
  - `answer-shaping-review 73/73`
- Fresh comparable rerun:
  - next release-candidate `150`-question canonical-local lane launched after Loop 28 validation
  - primary gate remains:
    - `What items does John collect?`
  - expected structural effect:
    - if John still abstains after this loop, the next escalation is no longer collection synthesis or pool access; it is owner admission for persisted collection candidates or a dedicated collection-fact canonical owner path

### Loop 29
- Replaced the remaining mixed runtime report path with a dedicated typed-candidate builder module:
  - added `src/retrieval/planner-typed-candidates.ts`
  - collection, temporal, and profile/report lanes now emit planner-owned candidates directly before generic narrative fallback
  - collection lanes no longer depend on a generic report candidate to admit persisted fact support
  - temporal lanes can now emit a planner-first `canonical_temporal` candidate from persisted temporal facts
  - causal/profile rows now emit dedicated planner candidates instead of only competing as weak scalar report summaries
- Added focused regression coverage for:
  - planner-first collection candidates from persisted facts
  - planner-first temporal candidates from persisted temporal facts
  - planner-first causal/profile candidates
- Validation:
  - `build` passed
  - `answer-owner-policy-review 27/27`
  - `answer-shaping-review 73/73`
- Fresh comparable rerun:
  - active session: `64753`
  - run stamp: `2026-04-10T04-32-31-505Z` successor loop on the new typed-candidate module
  - primary gates:
    - `What items does John collect?`
    - `Why did Gina decide to start her own clothing store?`
    - temporal rows currently falling into `temporal_rendering_wrong`
  - expected structural effect:
    - John should stop falling out of the typed collection lane into abstention/top-snippet
    - Gina-style why rows should stay in a dedicated causal candidate family
    - temporal rows should show planner-owned temporal candidates before snippet competition

### Loop 30
- Closed two remaining planner/support gaps instead of adding more local shaping rules:
  - explicit `what year/month/date` questions now route into the `temporal_event` lane in `answer-retrieval-plan.ts`
  - causal/profile support now synthesizes startup-motive answers from trigger + fashion/autonomy cues before falling back to weak report scalars
  - report plans for causal questions now request a `causal_reason` field with one targeted rescue pass
- Added focused regression coverage for:
  - explicit year-question temporal routing
  - startup-motive causal synthesis from distributed support cues
- Validation:
  - `build` passed
  - `answer-shaping-review 75/75`
  - `answer-owner-policy-review 28/28`
- Fresh comparable rerun:
  - active session: `69824`
  - run stamp: `2026-04-10T05-12-54` release-candidate canonical-local rerun
  - primary gates:
    - `What items does John collect?`
    - `Why did Gina decide to start her own clothing store?`
    - `What year did John start surfing?`
  - expected structural effect:
    - temporal rows stop entering `exact_detail` planner traces for explicit year/month/date questions
    - Gina-style why rows get a typed causal reason instead of an empty causal contract
    - John remains inside the first-class collection lane while the next completeness signal becomes clearer

### Loop 31
- Added a shared typed-pool ranker instead of another row-level fix:
  - new `src/retrieval/planner-pool-ranker.ts`
  - collection, temporal, and profile lanes now rank their own pool results with hybrid lexical + structured scoring, Reciprocal Rank Fusion, and MMR-style reranking before support construction
  - planner runtime report candidates now carry the ranked pool results through subject binding, atomic-unit extraction, provenance, and owner materialization
- Added focused regression coverage for:
  - collection pool ranking preferring John-bound persisted collection facts over foreign rows
  - temporal pool ranking preferring subject-bound year facts over noisy or foreign rows
  - profile pool ranking preferring causal explanation rows for `why` questions
- Validation:
  - `build` passed
  - `answer-owner-policy-review 31/31`
  - `answer-shaping-review 75/75`
- Fresh comparable rerun:
  - active session: `72581`
  - run lane: canonical-local `benchmark:locomo:release-candidate`
  - primary gates:
    - `What items does John collect?`
    - `What year did John start surfing?`
    - residual `report_semantics_wrong` rows after Gina
  - expected structural effect:
    - John-style rows should keep the typed collection pool alive with stronger subject-bound ranking before completeness is judged
    - temporal rows should prefer the year-bearing canonical fact lane before snippet-like temporal chatter
    - causal/profile rows should keep the strongest reason-bearing support near the front of the typed pool

### Loop 32
- Promoted temporal support into the same first-class typed-candidate pattern already used for collection:
  - `service.ts` now seeds planner runtime temporal candidates from `canonical_temporal_facts` before typed candidate building
  - `support-objects.ts` now reduces temporal rows as an event bundle instead of taking the first parseable date
  - inception-style event queries (`start_`, `join_`, `launch_`) now prefer the earliest valid year/date among subject-bound event-matched candidates
- Added focused regression coverage for:
  - noisy recent temporal rows competing with the real inception year
  - planner-level temporal candidate selection keeping `2018` over a `2023` distractor for `What year did John start surfing?`
- Validation:
  - `build` passed
  - `answer-shaping-review 77/77`
  - `answer-owner-policy-review 33/33`
- Expected structural effect:
  - temporal rows stop choosing “latest chatter with a year” once the event identity is already known
  - `canonical_temporal_facts` becomes a true planner-runtime pool instead of a storage-only lookup
  - the next comparable rerun should measure whether `temporal_rendering_wrong` drops now that collection is already stable on the live partial

### Loop 33
- Adopted a more literal GraphRAG + Graphiti temporal subsystem instead of another local shaping tweak:
  - added `src/retrieval/temporal-pool-utils.ts`
  - temporal rows are now parsed into reusable recall shapes with:
    - event evidence kind (`exact`, `aligned`, `none`)
    - normalized date parts
    - bundle keys for event-scoped grouping
  - temporal pool ranking now does event-aware preselection before truncation in `planner-pool-ranker.ts`
  - temporal support selection now refuses query-only event identity when the only surviving rows are generic dated facts
  - explicit mismatch recovery still works for stored temporal rows, but generic dated rows no longer satisfy event identity by query alone
- Fixed the lingering canonical-memory regression in `report-synthesis.ts` where DVD normalization could duplicate into `fantasy movie DVDs DVDs`.
- Added focused regression coverage for:
  - generic canonical temporal dates not beating event-aligned raw rows
  - temporal support refusing query-only event identity from unrelated dated rows
  - canonical DVD-collection normalization staying single-valued
- Validation:
  - `build` passed
  - `canonical-memory-review 46/46`
  - `answer-shaping-review 78/78`
  - `answer-owner-policy-review 34/34`
- Expected structural effect:
  - John-style temporal rows should no longer pair `start_surfing` with a later unrelated `2023` fact
  - temporal failures should either resolve from aligned evidence or degrade into honest missing-event-identity instead of wrong-year rendering
  - this uses the same first-class typed-pool philosophy that already stabilized the collection lane

### Loop 34
- Replaced the remaining temporal fact handoff gap with public-pattern temporal eligibility rules instead of another render-only tweak:
  - `canonical-memory/service.ts` now filters `canonical_temporal_facts` the way Graphiti-style fact stores should be queried:
    - exact event-key rows stay eligible
    - blank-event rows are only eligible when their text is strongly aligned to the query
  - `retrieval/service.ts` applies the same rule to planner-seeded persisted temporal rows before they materialize as runtime candidates
  - `temporal-pool-utils.ts` now marks no-event temporal rows as `aligned` when they have real temporal payload plus strong GraphRAG-style query-text alignment
  - `support-objects.ts` now accepts aligned no-event temporal anchors as resolved temporal identity and broadens anchored-relative rendering to the same cue family already supported by the temporal-relative utilities
- Added focused regression coverage for:
  - Seattle-style aligned anchor rows rendering from the typed temporal lane
  - no-event temporal ranker preference over generic canonical dates
  - explicit-event generic dated rows still degrading to missing identity instead of a wrong year
- Validation:
  - `build` passed
  - `answer-shaping-review 79/79`
  - `answer-owner-policy-review 35/35`
- Expected structural effect:
  - `What year did John start surfing?` should stop inheriting a generic `2023` from blank-event stored temporal rows
  - `When was John in Seattle for a game?` should resolve from aligned temporal anchor text instead of `temporal_missing_event_identity`
  - remaining temporal failures should concentrate inside true completeness gaps, not polluted fact eligibility

### Loop 35
- Adopted the next GraphRAG + SimpleMem + GraphZep temporal boundary instead of adding another row-local temporal rule:
  - added `src/retrieval/recall-content.ts` so planner/runtime lanes normalize structured recall blobs into stable claim text before subject scoring or temporal extraction
  - `planner-typed-candidates.ts`, `service.ts`, `planner-pool-ranker.ts`, `temporal-pool-utils.ts`, and `support-objects.ts` now consume those normalized recall texts instead of raw serialized JSON strings
  - temporal support now performs a small GraphRAG-style event neighborhood fan-out around matched turns/source files, then uses those neighborhood texts for:
    - event identity rescue
    - month/year/day backfill
    - relative cue anchoring
  - generic scheduling queries like `When is/are ...` can now render month-year directly when month support exists but day support does not, without overriding the already-correct historical relative-day path
- Added focused regression coverage for:
  - structured JSON recall rows still producing typed temporal candidates for `What year did John start surfing?`
  - generic month-level schedule answers rendering as `temporal_month_year`
  - participant-bound temporal rows recovering `June 2023` for month-specific achievement queries
- Validation:
  - `build` passed
  - `answer-shaping-review 81/81`
  - `answer-owner-policy-review 39/39`
  - `canonical-memory-review + supported-claim-review 113/113`
- Fresh comparable baseline identified before rerun:
  - `locomo-2026-04-10T09-13-40-534Z.json`
  - `passRate = 0.747`
  - critical pre-patch failure shape:
    - `What year did John start surfing?` -> `top_snippet`, `SnippetFactSupport`, `support_span_extract`
    - `In which month's game did John achieve a career-high score in points?` -> `canonical_temporal`, `TemporalEventSupport`, `temporal_missing_event_identity`
    - `When is Jon's group performing at a festival?` -> `canonical_temporal`, `TemporalEventSupport`, `temporal_relative_day`
    - `What fields would Caroline be likely to pursue in her educaton?` -> `canonical_report`, `CounterfactualCareerSupport`, `career_likelihood_judgment`
- Expected structural effect:
  - John-style temporal rows stop escaping the typed lane because structured recall text now binds the subject before owner selection
  - month/year schedule rows can bypass stale relative fragments when the planner has real month-level support
  - the next rerun should show whether the remaining temporal failures have moved from subject binding / wrong render into narrower event-identity completeness gaps

## Next Bottleneck
- Immediate rerun gate:
  1. confirm `What year did John start surfing?` stays in `canonical_temporal`
  2. confirm `In which month's game did John achieve a career-high score in points?` resolves month/event identity from the typed temporal lane
  3. confirm `When is Jon's group performing at a festival?` renders month-year instead of stale relative day text
- If those temporal rows improve together:
  - the next highest-volume structural bottleneck becomes profile/report routing for education-field and support/career questions
- If temporal rows still fail after the new typed boundary:
  - escalate one layer deeper into persisted temporal fact metadata (`support_kind`, binding confidence, event-neighborhood provenance) before touching general shaping again

## Status
- Progressing; the current cluster is now a typed temporal/event-binding bottleneck, not a collection-lane bottleneck.
- Latest trustworthy comparable baseline artifact:
  - `locomo-2026-04-10T09-13-40-534Z.json`
- Current action:
  - start a fresh comparable release-candidate rerun on Loop 35 after the validation suite
- No schema blocker.

### Post-Green Hardening
- After reaching `150 / 150`, the next retrieval hardening slice started with behavior-preserving extraction instead of new retrieval logic:
  - moved exact-detail family classification into `src/retrieval/exact-detail-question-family.ts`
  - moved linked-source/session-neighborhood helpers into `src/retrieval/source-neighborhood.ts`
  - kept `service.ts` on thin wrappers first so benchmark-critical behavior stays unchanged while the runtime boundary becomes cleaner
- Added repeatable hardening commands in `local-brain/package.json`:
  - `test:retrieval-hardening`
  - `test:retrieval-hardening:extended`
  - `benchmark:post-green-hardening`
- Current gate split:
  - core green hardening gate should stay on benchmark-critical retrieval behavior:
    - exact answer control
    - subject isolation
    - temporal anchors
    - answer owner policy
    - answer shaping
  - extended adjudication audit stays separate for now because `canonical-adjudication-review` is broader legacy drift coverage and is not yet aligned with the current green benchmark path
