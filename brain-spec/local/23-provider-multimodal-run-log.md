# Provider Scaffolding Run Log

Date: `2026-03-17`

This run log covers the local-first provider/multimodal scaffolding slice.

## Added

- [providers/types.ts](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/providers/types.ts)
- [providers/http.ts](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/providers/http.ts)
- [providers/openrouter.ts](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/providers/openrouter.ts)
- [providers/gemini.ts](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/providers/gemini.ts)
- [providers/registry.ts](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/providers/registry.ts)
- [cli/provider-smoke.ts](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/cli/provider-smoke.ts)
- [22-provider-multimodal-scaffold.md](/Users/evilone/Documents/Development/AI-Brain/ai-brain/brain-spec/local/22-provider-multimodal-scaffold.md)

Updated:

- [src/config.ts](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/config.ts)
- [src/index.ts](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/index.ts)
- [package.json](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/package.json)
- [README.md](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/README.md)
- [QUICKSTART.md](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/QUICKSTART.md)
- [.env.example](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/.env.example)
- [NOTEBOOKLM-QUERIES.md](/Users/evilone/Documents/Development/AI-Brain/ai-brain/brain-spec/local/implementation/NOTEBOOKLM-QUERIES.md)

## NotebookLM Prompts Used

1. Broad contract prompt for provider interfaces and multimodal derivations.
Result: timed out.

2. Narrow interface prompt with strict bullet limits.
Result: timed out.

3. Very narrow field-list prompt for provider and derivation responses.
Result: completed and used for interface pressure-testing.

## Verified Commands

Type check:

```bash
cd /Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain
npm run check
```

Provider smoke check without keys:

```bash
cd /Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain
npm run provider:smoke -- --provider openrouter --text "provider smoke"
npm run provider:smoke -- --provider gemini --text "provider smoke" --dimensions 1536
```

Expected and observed result:

- both return typed `PROVIDER_AUTH` errors when keys are not present

Regression check:

```bash
cd /Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain
npm run eval
```

Observed:

- evaluation suite still passes after provider scaffolding changes

## What Failed And Fix

Issue:

- first `npm run check` surfaced a missing `ArtifactDetail.derivations` return
  property.

Fix:

- completed `getArtifactDetail(...)` return mapping for derivation rows in
  retrieval service so type shape and runtime behavior are aligned.

## Current Honest Limits

- provider adapters currently implement text embeddings only
- multimodal derivation calls are intentionally returned as
  `PROVIDER_UNSUPPORTED`
- no provider outputs are written into `artifact_derivations` yet
- no secrets are stored in code or docs
