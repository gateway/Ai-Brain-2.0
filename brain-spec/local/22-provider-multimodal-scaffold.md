# Provider Slice: OpenRouter + Gemini Scaffolding

Date: `2026-03-17`

## Scope

This slice adds a safe provider abstraction for local Brain 2.0 without
pretending full multimodal extraction is complete.

Implemented:

- provider adapter interface
- OpenRouter text embedding adapter
- Gemini text embedding adapter
- provider registry and config wiring
- smoke CLI for provider path verification

Deferred on purpose:

- provider-backed multimodal derivation execution
- automatic writes into `artifact_derivations`
- model adjudication loops during consolidation

## Why This Shape

1. Keeps credentials and network logic out of ingestion and retrieval services.
2. Makes provider switching explicit (`openrouter` vs `gemini`).
3. Provides typed, testable error handling (`auth`, `timeout`, `rate_limit`,
   `unsupported`).
4. Preserves the future multimodal path using a strict contract and storage hook
   instead of fake implementations.

## Implemented Files

- [/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/providers/types.ts](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/providers/types.ts)
- [/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/providers/http.ts](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/providers/http.ts)
- [/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/providers/openrouter.ts](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/providers/openrouter.ts)
- [/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/providers/gemini.ts](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/providers/gemini.ts)
- [/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/providers/registry.ts](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/providers/registry.ts)
- [/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/cli/provider-smoke.ts](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/cli/provider-smoke.ts)

Updated wiring:

- [/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/config.ts](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/config.ts)
- [/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/index.ts](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/index.ts)
- [/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/package.json](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/package.json)
- [/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/.env.example](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/.env.example)

## NotebookLM Loop

NotebookLM was re-asked narrowly after two timeouts.

Useful signal preserved:

- include provider/model/dimensions/latency metadata in adapter responses
- keep derivation modality and confidence fields explicit
- return provenance fields to support evidence-backed reasoning

Corrections applied:

- no hard-coded universal dimensions
- no fake multimodal extraction calls
- explicit `PROVIDER_UNSUPPORTED` for derivation until the worker layer is wired

## Operational Behavior

- `provider:smoke` with missing keys returns deterministic `PROVIDER_AUTH`.
- network request errors map to typed provider errors.
- adapters are isolated; they do not write DB rows directly.

## Next Step After This Slice

1. Add a derivation worker that reads binary artifact observations and calls the
   selected provider.
2. Persist outputs to `artifact_derivations`.
3. Add retrieval branch for derivation text and optional embeddings.
