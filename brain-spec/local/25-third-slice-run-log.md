# Third Slice Run Log

Date: `2026-03-17`

This run log covers the third local runtime slice:

- binary artifact registration
- text-proxy derivations
- derivation-aware retrieval
- stronger evaluation coverage
- live HTTP route verification

## NotebookLM Loop

Three narrow NotebookLM passes were used in this slice:

1. external producer architecture after markdown
2. multimodal/image/PDF staging
3. benchmark suite and pass/fail criteria

One multimodal answer drifted toward direct multimodal embeddings as if they
were already production-safe and fully verified.

Correction applied:

- re-asked NotebookLM with the stricter constraint that the safe path is:
  - raw files on disk
  - text proxies for OCR/captions/extraction
  - stable text embeddings only

That corrected answer aligned well with the actual implementation path.

## What Was Added

- [derivations/service.ts](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/derivations/service.ts)
- [derive-attach-text.ts](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/cli/derive-attach-text.ts)
- [24-text-proxy-and-binary-artifact-slice.md](/Users/evilone/Documents/Development/AI-Brain/ai-brain/brain-spec/local/24-text-proxy-and-binary-artifact-slice.md)

Updated:

- [artifacts/registry.ts](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/artifacts/registry.ts)
- [ingest/worker.ts](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/ingest/worker.ts)
- [retrieval/service.ts](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/retrieval/service.ts)
- [retrieval/types.ts](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/retrieval/types.ts)
- [eval/runner.ts](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/eval/runner.ts)
- [server/http.ts](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/server/http.ts)
- [README.md](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/README.md)
- [QUICKSTART.md](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/QUICKSTART.md)

## What Failed And Fixes

### Failure 1: Idempotency metric was wrong

Problem:

- re-ingesting the same file reported new episodic inserts even though the rows
  were already there

Cause:

- the ingest path counted an existing episodic row as if it had been newly
  inserted

Fix:

- changed the insert result check to use actual `rowCount`

### Failure 2: producer eval query was too loose

Problem:

- webhook ingestion worked, but the evaluation searched for the wrong phrase

Fix:

- tightened the query to the actual webhook content so the test verifies the
  right behavior

### Failure 3: NotebookLM multimodal guidance was too optimistic

Problem:

- the notebook kept leaning toward direct multimodal embedding assumptions

Fix:

- constrained the re-ask and switched the implementation to the safer
  artifact-plus-text-proxy path

## Verified Commands

Type check:

```bash
cd /Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain
npm run check
```

Full local evaluation:

```bash
cd /Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain
npm run eval
```

Observed:

- evaluation passes
- latest report:
  - [latest.json](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/eval-results/latest.json)
  - [latest.md](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/eval-results/latest.md)

Provider smoke checks:

```bash
cd /Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain
npm run provider:smoke -- --provider openrouter --text "provider smoke"
npm run provider:smoke -- --provider gemini --text "provider smoke" --dimensions 1536
```

Observed:

- both return typed `PROVIDER_AUTH` errors with no secrets configured

HTTP runtime checks:

```bash
cd /Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain
npm run serve
curl -s http://127.0.0.1:8787/health
curl -s -X POST http://127.0.0.1:8787/derive/text ...
curl -s "http://127.0.0.1:8787/search?..."
```

Observed:

- `/health` returns `{"ok": true}`
- `/derive/text` inserts a derivation
- `/search` can return `artifact_derivation` results

## Confidence

This slice is strong because it proves:

- binary evidence can enter the brain cleanly
- attached text proxies become searchable
- provenance stays intact
- the eval harness catches real regressions instead of just happy paths
