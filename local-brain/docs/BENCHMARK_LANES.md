# Benchmark Lanes

Use two explicit benchmark lanes so local GPU load does not silently skew the benchmark baseline.

## Canonical Lane

Purpose:
- source-of-truth benchmark history
- stable before/after comparisons
- release-gate decisions

Config:
- `BRAIN_BENCHMARK_LANE=canonical-local`
- `BRAIN_EMBEDDING_PROVIDER=external`
- `BRAIN_EMBEDDING_MODEL=Qwen/Qwen3-Embedding-4B`

Commands:
```bash
cd /Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain
npm run benchmark:lane:canonical-local:profile-routing-review
npm run benchmark:lane:canonical-local:mcp-smoke
npm run benchmark:lane:canonical-local:production-battle
```

Use this lane when:
- comparing against prior local artifacts
- deciding whether a retrieval/control change is actually better
- capturing a final gate artifact

## Fast Lane

Purpose:
- faster iteration when the local model runtime is busy
- provider sensitivity checks
- quick regression testing before a canonical rerun

Config:
- `BRAIN_BENCHMARK_LANE=fast-openrouter`
- `BRAIN_EMBEDDING_PROVIDER=openrouter`
- `BRAIN_OPENROUTER_EMBEDDING_MODEL=text-embedding-3-small`

Requirements:
- `OPENROUTER_API_KEY` must be set

Commands:
```bash
cd /Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain
npm run benchmark:lane:fast-openrouter:profile-routing-review
npm run benchmark:lane:fast-openrouter:mcp-smoke
npm run benchmark:lane:fast-openrouter:production-battle
```

Use this lane when:
- the local GPU is busy with other experiments
- you need a faster signal on whether a code change is obviously broken
- you want a provider-parity comparison

## Rules

Do not mix the lanes when interpreting progress.

- `canonical-local` is the benchmark baseline.
- `fast-openrouter` is an experiment lane.
- If a fix looks good in `fast-openrouter`, rerun it in `canonical-local` before treating it as a real benchmark improvement.

Artifacts already record:
- `benchmarkLane`
- `embeddingProvider`
- `embeddingModel`

That metadata must be used when comparing runs.

## Quick Checks

Show the current lane-related env:
```bash
cd /Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain
npm run benchmark:lane:show
```

Run a one-off command in a lane:
```bash
cd /Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain
zsh ./scripts/benchmark-lane-canonical-local.sh npm run benchmark:public-memory-miss-regressions
zsh ./scripts/benchmark-lane-fast-openrouter.sh npm run benchmark:public-memory-miss-regressions
```
