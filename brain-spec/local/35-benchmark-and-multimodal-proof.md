# Benchmark And Multimodal Proof

Date: 2026-03-18

## Scope

This slice did two things:

1. Added and ran a reproducible lexical benchmark to compare native PostgreSQL FTS and ParadeDB BM25.
2. Proved the external multimodal derivation path locally using a mock provider and a real user PDF.

## BM25 Benchmark

Command:

```bash
cd /Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain
npm run benchmark:lexical
```

Artifacts:

- [benchmark latest JSON](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/latest.json)
- [benchmark latest Markdown](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/latest.md)

What it benchmarks today:

- `Japan 2025 Sarah`
- `spicy food`
- `sweet food`
- unknown-query abstention

Current result:

- baseline eval passed
- FTS passed `4/4`
- BM25 passed `4/4`
- token delta `0`
- current harness recommendation: `candidate_for_default`

Important caution:

- this is a useful benchmark, not the final lexical gate
- a stronger stress set still needs acronym/code-heavy queries like `CVE-2026-3172`, `SQS DLQ`, and `pgai vector backfill`

## Real PDF Ingest

User PDF:

- [/Users/evilone/Downloads/Local_Cognitive_Architecture.pdf](/Users/evilone/Downloads/Local_Cognitive_Architecture.pdf)

Local artifact registration succeeded:

- artifact id: `019cff39-9f4c-7834-a787-a7478ff466bc`
- observation id: `019cff39-9f52-7336-86ba-46ecaaf75786`
- namespace: `personal`
- source type: `pdf`

At ingest time, as expected:

- raw artifact was preserved
- no fake text fragments were created
- no candidates were written yet

## Mock External Multimodal Proof

Mock server:

```bash
cd /Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain
npm run mock:external -- --port 8090
```

Brain runtime pointed at mock provider:

```bash
cd /Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain
BRAIN_EXTERNAL_AI_BASE_URL=http://127.0.0.1:8090 npm run serve
```

Provider-backed derivation call:

```bash
curl -sS -X POST http://127.0.0.1:8787/derive/provider \
  -H 'content-type: application/json' \
  -d '{"artifact_id":"019cff39-9f4c-7834-a787-a7478ff466bc","provider":"external","derivation_type":"mock_pdf_summary","embed":false}'
```

Result:

- derivation id: `019cff3c-2e9e-75eb-a0f5-2fe3ea134982`
- derivation type: `mock_pdf_summary`
- searchable text proxy persisted into `artifact_derivations`

Verified retrieval:

```bash
cd /Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain
BRAIN_EXTERNAL_AI_BASE_URL=http://127.0.0.1:8090 npm run search -- "pgvectorscale temporal memory hierarchy" --namespace personal
```

Top result was the derived PDF summary linked back to the original artifact URI.

## What Worked

- benchmark harness is runnable and writes reports
- BM25 and FTS can now be compared on the same seeded namespace
- provider-backed derivation endpoint works locally
- a real PDF can be ingested, derived, and made searchable
- provenance is preserved through artifact, observation, and derivation metadata

## What Is Still Missing

- real OCR/STT/caption quality from an actual model backend
- stronger lexical stress cases before flipping BM25 as the default
- queued derivation proof against the same mock provider, not just synchronous `/derive/provider`
- automatic embedding sync after successful multimodal derivation for this PDF path

## Current Assessment

The local brain is in a strong state.

- BM25: implemented, benchmarked, still prudently feature-gated
- multimodal: queue and provider contract exist, synchronous provider derivation now proven locally
- confidence: high enough to keep building on this path without reworking the core substrate
