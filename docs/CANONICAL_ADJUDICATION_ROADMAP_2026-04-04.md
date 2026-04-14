# Canonical Adjudication Roadmap

## Baseline
- Latest full unsampled LoCoMo before this slice: `0.401`
- Dominant failures: `answer_shaping`, `alias_entity_resolution`, `temporal`, `abstention`
- Retrieval failures were already near zero, so the next score movement has to come from the retrieval-to-answer boundary.

## Phase 1
- Add a runtime canonical adjudication layer behind `BRAIN_CANONICAL_ADJUDICATION`.
- Convert mixed recall rows into typed canonical fact/state or abstention decisions before final answer formatting.
- Prefer canonical outputs over `top_snippet` and generic fallback text once a supported family reducer exists.
- Emit benchmark telemetry:
  - `canonicalPathUsed`
  - `canonicalPredicateFamily`
  - `canonicalSupportStrength`
  - `canonicalAbstainReason`

## Phase 2
- Persist resolved canonical facts/states into durable tables:
  - `canonical_facts`
  - `canonical_fact_provenance`
  - `canonical_subject_aliases`
  - `canonical_subject_states`
  - `canonical_temporal_facts`
- Use canonical storage for current truth, alias binding, temporal fact lookup, and ownership/name binding.
- Keep episodic and transcript rows as provenance, not the primary answer source.

## Benchmarks
- `benchmark:locomo-canonical-family-review` replays top full-corpus failures from the latest artifact and measures whether the canonical path is actually being used.
- Keep sampled standard green while iterating on the canonical path.
- Use full unsampled LoCoMo as the real progress gate.
