# Protected Lane Recovery 2026-03-31

This document records the protected-lane hardening checkpoint after the `0.825`
LoCoMo freeze.

## Outcome

The product-facing protected lane is materially recovered.

- `mcp-production-smoke` is now fully green:
  - `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/mcp-production-smoke-2026-03-31T10-01-47-511Z.json`
- `personal-omi-review` now has no failing scenarios and only two residual warnings:
  - `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/personal-omi-review-2026-03-31T10-02-45-710Z.json`
- `public-memory-miss-regressions` still fails, but on the previously frozen public-memory residue rather than the product-lane regressions repaired in this phase:
  - `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/public-memory-miss-regressions-2026-03-31T10-02-58-660Z.json`

## What Was Fixed

### Relationship/profile retrieval

- broad profile search queries now preserve a stable role fact plus a stable
  place/association fact instead of collapsing into `met_through` noise
- Dan profile search now correctly surfaces:
  - `friend`
  - `associated with Chiang Mai`
- Lauren and transition history queries remain grounded and confident

### Clarification/inbox handling

- canonically-resolved kinship clarification noise is suppressed from the ops
  inbox summary
- `Who is Uncle?` now resolves through the canonical alias lane instead of noisy
  transcript retrieval

### Continuity shadow bootstrap

- `mcp-production-smoke` now primes and rebuilds the
  `personal_continuity_shadow` namespace before recap/task scenarios run
- recap, explain-recap, and task extraction no longer fail because of an empty
  benchmark namespace

## Residual Warnings

### `personal-omi-review`

1. `lauren_current_relationship_exact`
- evidence is present, but the current-profile claim still prefers
  `friend + Chiang Mai` over `former partner`

2. `media_titles_exact`
- movie-title retrieval still picks up `Uncle` alias/clarification noise and
  misses `From Dusk Till Dawn`

These are real answer-shaping issues, but they are no longer release-blocking
product smoke failures.

## Residual Public-Memory Failures

The remaining `public-memory-miss-regressions` failures are in the known frozen
public benchmark residue:

- `longmemeval_commute_duration`
- `longmemeval_play_title`
- `locomo_support_group_exact_date`
- `locomo_sunrise_year`
- `locomo_jon_job_loss_date`
- `locomo_gina_job_loss_month`
- `locomo_career_profile_inference`
- `locomo_identity_profile`
- `locomo_shared_destress`
- `locomo_shared_commonality`
- `locomo_causal_motive`

These should be treated as the next retrieval/benchmark slice, not as evidence
that the product-facing protected lane is still broken.

## Next Slice

The next clean slice should be:

1. relationship current-profile answer shaping
2. media-title noise isolation around alias/clarification overlap
3. reopen the frozen public-memory / LoCoMo residue from the now-stable product
   baseline
