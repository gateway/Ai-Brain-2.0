# External Inference Provider Pass

Date: 2026-03-18

## Summary

This slice wired an optional external inference provider into the local brain as a staged classification path.

NotebookLM guidance matched the implementation direction:

- keep the brain as the durable memory/graph/orchestration layer
- keep providers as replaceable inference backends
- stage model output as candidates and ambiguities
- do not let provider output write final truth directly

## What Was Added

- provider adapter support for structured text classification
- external adapter support for OpenAI-style `POST /v1/chat/completions`
- OpenRouter adapter support for the same `classifyText` contract
- classifier staging service that writes:
  - `entities`
  - `relationship_candidates`
  - `claim_candidates`
  - `memory_candidates`
  - clarification rows
- CLI:
  - `npm run classify:text`
- HTTP:
  - `POST /classify/text`
  - `POST /classify/derivation`

## Why This Is The Right Split

- the brain owns:
  - Postgres state
  - BM25 / vector retrieval
  - TMT / temporal memory
  - inbox / outbox
  - promotion into semantic/procedural truth
- the provider owns:
  - embeddings
  - OCR / STT / captions
  - structured extraction / classification
  - optional final chat reasoning

That makes local Qwen, OpenRouter, and future providers interchangeable without changing the brain schema.

## Validation

Validated locally with the mock external provider:

- `npm run provider:smoke -- --provider external --mode classify --preset research-analyst`
- `npm run classify:text -- --namespace external_classify_test --provider external --preset research-analyst --text "..."`
- `POST /classify/text` against a live runtime pointed at the mock external provider

Verified staged DB output:

- `relationship_candidates`: 5 rows
- `claim_candidates`: 3 rows
- `memory_candidates`: 3 rows

Example relationships staged:

- `Steve -> friend_of -> Gummi`
- `Steve -> works_on -> Two-Way`
- `Gummi -> member_of -> Pilot Association`
- `Dan -> from -> Mexico City`
- `Chiang Mai -> contained_in -> Thailand`

Example ambiguity staged:

- `Gumee` -> `possible_misspelling`

## Issue Found And Fixed

This slice exposed a real schema bug:

- `memory_candidates` dedupe was global across namespaces
- result: one namespace could update another namespace’s candidate hints

Fix:

- added namespaced uniqueness in migration `021_memory_candidates_namespace_dedup.sql`
- updated all relevant `memory_candidates` upserts to target the new constraint by name

## Current Limits

- the external classification path assumes an OpenAI-style chat surface
- the first live implementation stages claims and relationships well, but it is still only one extraction contract
- automatic queue-follow-up classification after derivation is not yet enabled by default; classification is currently explicit via CLI/HTTP
- real quality still depends on the actual provider/model you point the brain at

## Recommended Production Shape

For the user’s Qwen runtime:

- point `BRAIN_EXTERNAL_AI_BASE_URL` at the remote machine
- set:
  - `BRAIN_EXTERNAL_AI_CLASSIFY_PATH=/v1/chat/completions`
  - `BRAIN_EXTERNAL_AI_CLASSIFY_MODEL=unsloth/Qwen3.5-35B-A3B-GGUF`
  - `BRAIN_EXTERNAL_AI_CLASSIFY_PRESET_ID=research-analyst`
- keep embeddings and classification under the provider boundary
- keep all durable state in the brain’s Postgres stack
