# LoCoMo 0.7 Execution Plan

## Purpose

This document turns the current LoCoMo recovery work into an execution plan with explicit build slices, schema changes, code ownership surfaces, benchmark gates, and checklists.

This is not a reducer-tuning plan. The goal is to keep moving the system away from snippet-led answering and toward canonical graph serving with narrative/report-first answers for the families that still dominate full unsampled LoCoMo.

## Current State

Current benchmark position on record:

- Last completed full unsampled LoCoMo: `0.407`
- Artifact: `benchmark-results/locomo-2026-04-05T03-19-00-891Z.md`
- Last completed sampled narrative-shadow smoke: `0.93`
- Artifact: `benchmark-results/locomo-2026-04-05T04-24-13-460Z.md`

Current architectural state:

- Canonical subjects, facts, states, temporal facts, and sets are in place.
- Pair graph serving exists and has already improved sampled pair/commonality behavior.
- Canonical narratives and reports now exist in storage and on the read path in shadow mode.
- Narrative cutover is gated by `BRAIN_CANONICAL_NARRATIVE_CUTOVER=1`.
- The primary remaining benchmark bottleneck is still `answer_shaping`, not retrieval.

## Primary Goal

Move full unsampled LoCoMo from the current `0.407` band into the `>= 0.55` band without returning to snippet-patch iteration.

## Non-Goals

- No broad vector DB replacement.
- No new generic snippet reducers as the main strategy.
- No live hosted-model answer generation.
- No benchmark interpretation based only on sampled runs.

## Core Principles

1. Canonical truth must beat snippets.
2. Rebuild-time promotion should carry most of the intelligence.
3. Family cutover should be measured, not guessed.
4. Raw episodic rows remain provenance, not the final answer source.
5. Every new serving family must have its own residual and regression coverage.

## Architecture Target

The serving stack should converge on this order:

1. Subject plan
2. Predicate family plan
3. Canonical fact/state/set/temporal lookup
4. Canonical narrative/report lookup
5. Structured abstention
6. Provenance-only evidence attachment

The system should stop answering from flat mixed snippets for targeted families.

## Workstreams

### Workstream A: Benchmark Truth and Cutover Control

Purpose:
- Stop guessing about whether new layers are helping.

Code surfaces:
- `src/benchmark/locomo.ts`
- `src/benchmark/locomo-full-residual-review.ts`
- `src/benchmark/locomo-drift-audit.ts`
- `src/retrieval/service.ts`
- `src/retrieval/types.ts`

Checklist:

- [ ] Let the current full unsampled narrative-shadow run finish.
- [ ] Freeze the resulting artifact as the baseline for narrative cutover decisions.
- [ ] Review `answer_shaping` deltas against the prior `0.407` full run.
- [ ] Review `narrativePathUsed`, `reportPathUsed`, `narrativeCandidateCount`, and `narrativeShadowDecision`.
- [ ] Identify targeted families where shadow candidates are clearly better than current final answers.
- [ ] Run a full unsampled cutover pass with `BRAIN_CANONICAL_NARRATIVE_CUTOVER=1` only after the shadow artifact supports it.
- [ ] Capture a drift audit between the prior full artifact and the new cutover full artifact.

Acceptance gate:

- Narrative shadow must show real candidate coverage on failing `answer_shaping` questions before cutover.

### Workstream B: Narrative Promotion Quality

Purpose:
- Improve the quality and coverage of promoted canonical narratives and reports so narrative serving can actually replace snippet answers.

Code surfaces:
- `src/canonical-memory/service.ts`
- `src/relationships/narrative.ts`
- `src/jobs/memory-graph.ts`
- `src/retrieval/narrative-adjudication.ts`
- `src/canonical-memory/narrative-reader.ts`

Current narrative kinds in scope:

- `motive`
- `symbolism`
- `realization`
- `career_intent`
- `support_reasoning`
- `family_meaning`
- `art_inspiration`
- `preference_explanation`

Checklist:

- [ ] Audit which narrative kinds are actually being promoted in the latest full shadow artifact.
- [ ] Expand deterministic clustering rules for repeated motive evidence.
- [ ] Expand deterministic clustering rules for symbolic/reminder/meaning evidence.
- [ ] Expand deterministic clustering rules for realization/lesson-learned evidence.
- [ ] Expand deterministic clustering rules for career-intent and future-pursuit evidence.
- [ ] Expand deterministic clustering rules for support/family/community meaning evidence.
- [ ] Ensure every promoted narrative links back to canonical facts/states/sets/temporal rows when available.
- [ ] Ensure provenance count is visible to the ranking path.
- [ ] Add narrative abstention when promotion support is too thin for a targeted family.

Acceptance gate:

- The failing narrative families in the full residual review should increasingly map to promoted canonical narratives instead of `top_snippet` or `fallback_derived`.

### Workstream C: Entity Reports and Pair Reports

Purpose:
- Add higher-order subject and pair summaries similar to GraphRAG-style report layers so high-level answer shaping stops depending on snippets.

Code surfaces:
- `src/canonical-memory/service.ts`
- `src/canonical-memory/narrative-reader.ts`
- `src/canonical-memory/graph-reader.ts`
- `src/retrieval/narrative-adjudication.ts`

Current report kinds in scope:

- `profile_report`
- `career_report`
- `support_report`
- `relationship_report`
- `shared_history_report`
- `creative_work_report`

Checklist:

- [ ] Audit the latest rebuild output to confirm entity reports and pair reports are being populated.
- [ ] Add stronger `profile_report` promotion from canonical state plus narrative evidence.
- [ ] Add stronger `career_report` promotion from goals, plans, and career-intent evidence.
- [ ] Add stronger `support_report` promotion from family, mentor, and community evidence.
- [ ] Add stronger `relationship_report` promotion from pair-history and symbolic shared context.
- [ ] Add stronger `shared_history_report` promotion for pair questions that ask about places, plans, and shared events.
- [ ] Rank reports ahead of raw snippets for profile explanation and pair explanation questions.
- [ ] Keep pair reports subject-bound and exclude foreign participants deterministically.

Acceptance gate:

- Profile explanation and pair explanation misses should move from `answer_shaping` toward either `canonical_report` answers or clean abstentions.

### Workstream D: Subject Binding and Exclusion Control

Purpose:
- Prevent narrative/report answers from drifting to the wrong subject in mixed conversations.

Code surfaces:
- `src/retrieval/query-subjects.ts`
- `src/retrieval/subject-plan.ts`
- `src/retrieval/canonical-subject-binding.ts`
- `src/canonical-memory/narrative-reader.ts`

Checklist:

- [ ] Keep possessive-first binding as the default for explicit `X's ...` queries.
- [ ] Add stronger exclusion logic inside narrative/report readers when multiple named participants exist.
- [ ] Require exact subject or pair alignment before narrative/report candidates are allowed to win.
- [ ] Emit structured ambiguity when a narrative/report candidate is not subject-safe.
- [ ] Add regressions for mixed-subject narrative questions that previously drifted.

Acceptance gate:

- Narrative cutover must not increase `alias_entity_resolution` failures.

### Workstream E: Temporal Validity for Narrative Families

Purpose:
- Make sure narrative and report answers respect event-time and validity windows rather than mention-order accidents.

Code surfaces:
- `src/canonical-memory/service.ts`
- `src/canonical-memory/narrative-reader.ts`
- `src/retrieval/canonical-adjudication.ts`
- `src/retrieval/narrative-adjudication.ts`
- `migrations/048_canonical_bitemporal_graph.sql`

Checklist:

- [ ] Verify promoted narratives and reports persist `mentioned_at`, `t_valid_from`, and `t_valid_until`.
- [ ] Rank active validity windows ahead of stale or superseded narrative candidates.
- [ ] Use temporal compatibility as a ranking input for narrative/report lookup.
- [ ] Add regressions for narrative questions with explicit time anchors.

Acceptance gate:

- Narrative cutover must not reintroduce temporal-shaping regressions.

### Workstream F: Formatter and Claim Source Enforcement

Purpose:
- Ensure targeted families stop falling back to snippet-shaped final claims.

Code surfaces:
- `src/retrieval/narrative-adjudication.ts`
- `src/retrieval/canonical-adjudication.ts`
- `src/retrieval/service.ts`
- `src/retrieval/reasoning-chain.ts`

Checklist:

- [ ] Keep shadow-first behavior until the shadow artifact is reviewed.
- [ ] Enable cutover only for families with good shadow evidence.
- [ ] Block snippet override for targeted cutover families after `supported` or `abstain`.
- [ ] Ensure `finalClaimSource` records `canonical_narrative` or `canonical_report` on cutover wins.
- [ ] Keep raw snippets attached only as evidence for targeted families.
- [ ] Add regressions that fail if a targeted family falls back to `top_snippet` after cutover.

Acceptance gate:

- Full cutover run should show a material increase in canonical narrative/report claim sources and a material drop in `answer_shaping`.

### Workstream G: Bounded Reranking, Only If Needed

Purpose:
- Add a final ranking cleanup layer only after narrative/report serving is measured.

Dependency:
- Do not start this until the first narrative cutover full run completes and plateaus below target.

Candidate tools/patterns:

- BGE reranker
- bounded family-local reranking only

Code surfaces:
- `src/canonical-memory/narrative-reader.ts`
- `src/retrieval/narrative-adjudication.ts`
- new family-local reranker module if needed

Checklist:

- [ ] Confirm narrative/report cutover still stalls below `>= 0.50` or `>= 0.55`.
- [ ] Add reranking only to the top `10-20` narrative/report candidates inside one family.
- [ ] Do not rerank the whole corpus.
- [ ] Keep reranker output diagnostic and measurable.
- [ ] Compare reranked full artifact against non-reranked narrative cutover artifact.

Acceptance gate:

- Reranking is justified only if it improves full unsampled without increasing subject or abstention regressions.

## Schema Plan

Already landed:

- `canonical_narratives`
- `canonical_narrative_provenance`
- `canonical_entity_reports`
- `canonical_pair_reports`

Near-term schema checklist:

- [ ] Validate all benchmark and replay DBs have migrations `048` and `049`.
- [ ] Keep indexes healthy for subject and pair report lookups.
- [ ] Add any missing provenance indexes discovered during the first full narrative cutover run.
- [ ] Avoid new top-level tables until residual evidence says a family cannot be expressed with the current canonical narrative/report schema.

## Benchmark Plan

### Phase 1: Shadow Validation

Checklist:

- [ ] Finish the active full unsampled narrative-shadow run.
- [ ] Run `locomo-full-residual-review` on the resulting artifact.
- [ ] Run `locomo-drift-audit` against the prior `0.407` full artifact.
- [ ] Decide whether the targeted narrative families have enough shadow signal for cutover.

### Phase 2: Targeted Cutover

Families eligible for first cutover:

- `motive`
- `symbolism`
- `realization`
- `career_intent`
- `support_reasoning`
- `art_inspiration`

Checklist:

- [ ] Enable `BRAIN_CANONICAL_NARRATIVE_CUTOVER=1`.
- [ ] Run full unsampled again.
- [ ] Compare `answer_shaping`, `abstention`, `alias_entity_resolution`, and `temporal` against the shadow run.
- [ ] Confirm cutover improved the targeted family residuals.

### Phase 3: Post-Cutover Expansion

Checklist:

- [ ] Expand report promotion only for the residual families the cutover full run still exposes.
- [ ] Add targeted regressions for every newly addressed narrative family.
- [ ] Rerun full unsampled after each meaningful promotion expansion, not after tiny edits.

## Required Regression Suites

Checklist:

- [ ] Canonical memory review covers narrative/report promotion.
- [ ] Canonical adjudication review covers shadow and cutover behavior.
- [ ] Add a focused narrative residual suite for:
  - motive
  - symbolism
  - realization
  - support reasoning
  - art inspiration
  - profile explanation
- [ ] Add a focused pair/profile narrative suite for:
  - family support meaning
  - symbolic object questions
  - “why” questions
  - “would pursue” questions
  - art-show inspiration questions

## Execution Order

1. Finish the current full shadow run.
2. Review shadow telemetry and full residuals.
3. Cut over only the narrative families with good shadow evidence.
4. Run a full unsampled cutover benchmark.
5. Expand report coverage based on the cutover residual artifact.
6. Add bounded reranking only if the cutover narrative layer still plateaus below target.

## Success Criteria

Short-term:

- Full unsampled moves above the current `0.407` baseline.
- `answer_shaping` drops materially.
- `retrieval` remains near zero.
- `alias_entity_resolution` does not increase.

Mid-term:

- Full unsampled reaches `>= 0.50`.
- Narrative/report claim sources meaningfully replace snippet claim sources on targeted families.

Phase target:

- Full unsampled reaches `>= 0.55` before any broad reranking work.

## Explicit Stop Rules

Stop and reassess before building more if any of these happen:

- Narrative cutover does not materially reduce `answer_shaping`.
- Subject binding regresses during narrative cutover.
- Temporal regressions rise sharply after narrative ranking changes.
- The cutover full artifact shows narrative candidates are rarely being promoted or selected.

If one of those happens, the next step is not more heuristic fallback. The next step is a focused audit of promotion coverage and ranking inputs for the failing family.
