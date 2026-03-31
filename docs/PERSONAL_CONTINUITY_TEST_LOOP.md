# Personal Continuity Test Loop

This document defines the repeatable continuity-first product loop for
OpenClaw-style markdown memory before a real OpenClaw folder is connected.

## Namespace contract

- `personal` stays reserved for live OMI and real personal recall testing.
- `personal_continuity_shadow` is the continuity-only shadow namespace for:
  - synthetic OpenClaw-style markdown fixtures
  - future real OpenClaw markdown imports
  - recap/task/calendar/provenance startup checks

## Fixture corpus

The checked-in OpenClaw-style corpus lives at:

- `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-generated/personal-openclaw-fixtures`

It includes:

- daily memory files under `memory/YYYY-MM-DD.md`
- `MEMORY.md`
- `memory.md`
- `AGENTS.md`
- `TOOLS.md`

## Benchmark workflow

Run in this order:

```bash
cd /Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain
npm run namespace:reset -- --namespace-id personal_continuity_shadow
npm run namespace:replay -- --namespace-id personal_continuity_shadow --force
npm run typed-memory:rebuild -- --namespace-id personal_continuity_shadow
npm run benchmark:session-start-memory
npm run benchmark:personal-openclaw-review
npm run benchmark:personal-omi-review
npm run benchmark:omi-watch
```

## What the continuity review checks

The continuity benchmark validates:

- OpenClaw file-role tagging
- yesterday recap quality
- two-weeks-ago recap quality
- context-loss recovery
- open task extraction
- upcoming commitment extraction
- provenance for recap answers
- typed completed-task recall for `What tasks did I complete last week?`

The continuity benchmark output is:

- `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/benchmark/personal-openclaw-review.ts`

## Interpretation rule

- evidence present + wrong continuity claim = reader/claim-selection problem
- missing evidence = retrieval/indexing or source-shape problem
- correct answer + missing source links = support-quality problem

The continuity startup pack should remain small and source-linked. Confident
continuity outputs should not require rereading the raw markdown tree.

## Current status

The continuity shadow lane is green again:

- `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/personal-openclaw-review-2026-03-28T00-44-40-666Z.json`
- `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/session-start-memory-2026-03-28T00-45-46-772Z.json`

What changed to get it there:

- recap startup now prefers recap-family behavior over raw search for continuity prompts
- `pick back up` recap now recovers open tasks through the task-extraction lane when recap evidence alone is too summary-heavy
- typed `task_items` now support `What tasks did I complete last week?` on the continuity shadow corpus
- continuity outputs remain source-linked and compact
- clean replay + forced source replay restores the shadow namespace fully after a reset, so continuity checks remain trustworthy instead of depending on stale imported state
- continuity stayed green while the live `personal` relationship and MCP API work changed, which confirms the continuity lane is isolated enough to serve as a stable startup proving ground
- the clean-replay full pass revalidated continuity after the canonical-entity, clarification rebuild, and atlas/history changes, so the startup lane is still safe while broader entity/history work continues

The continuity lane is now ready to act as the default startup path while entity/relationship fixes continue on the live `personal` corpus.
