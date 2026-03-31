# Clean Replay Policy

AI Brain should treat the database as derived state during development and
benchmarking. Canonical truth lives in source artifacts such as OMI exports,
repo-local benchmark fixtures, and future OpenClaw markdown files.

## Default rule

Before any serious validation loop:

1. reset the namespace being tested
2. replay from canonical sources
3. rebuild typed memory
4. run the benchmark or smoke suite

Do not trust benchmark results that were produced on stale derived state.

## Commands

Reset one namespace while keeping monitored-source configuration:

```bash
cd /Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain
npm run namespace:reset -- --namespace-id personal
```

If you explicitly need to wipe owner/self configuration too:

```bash
cd /Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain
npm run namespace:reset -- --namespace-id personal --reset-owner-profile
```

Replay all monitored sources for that namespace:

```bash
cd /Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain
npm run namespace:replay -- --namespace-id personal --force
```

Rebuild typed derived memory and verify namespace state before benchmarks:

```bash
cd /Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain
npm run typed-memory:rebuild -- --namespace-id personal
npm run namespace:check -- --namespace-id personal
```

## What reset does

`namespace:reset` removes derived and imported rows for the namespace from the
main public memory tables and clears monitored-source file/import tracking in
`ops.*` for that namespace's sources.

It keeps:

- monitored source definitions in `ops.monitored_sources`
- owner/self binding by default in `namespace_self_bindings`
- canonical files on disk

It clears:

- imported artifacts and episodic rows
- semantic, procedural, temporal, relationship, entity, graph, and
  answerable-unit/task/project/date-span derived rows
- monitored source file/import/scan state for that namespace

It only clears owner/self binding and orphan identity profiles when
`--reset-owner-profile` is passed. That keeps clean replay focused on derived
memory state instead of wiping namespace configuration that benchmarks still
depend on.

## When to use it

Use clean replay:

- before private-data benchmark runs
- before continuity shadow validation
- after major ingestion or derivation changes
- whenever contamination or stale rows are suspected

## Current development policy

- shadow/test namespaces: reset and replay every serious run
- `personal`: reset and replay whenever retrieval or claim-selection behavior is
  being validated
- full database wipe: reserve for large schema or substrate changes only

## Latest validation note

The `2026-03-27` clean-state full pass confirmed that this policy is the safer
default:

- the Ben `Context Suite` query regressed only after a true clean replay exposed
  an unrelated newer summary row winning retrieval
- the Lauren-history OMI watch query regressed only after a true clean replay
  exposed that the Tahoe/Bend history rows were not being pulled into the answer
  path
- the new `uncle -> Billy Smith / Joe Bob` alias and `Kozimui -> Koh Samui`
  normalization work only proved out because the stale namespace state was
  removed before the benchmarks and MCP checks ran
- the James relationship path only stabilized after clean replay exposed that
  place association rows needed canonical normalization to `Lake Tahoe`

Both fixes were validated from clean state, which is the standard this project
should keep using.
