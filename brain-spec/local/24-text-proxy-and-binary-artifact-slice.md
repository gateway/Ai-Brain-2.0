# Text-Proxy And Binary Artifact Slice

Date: `2026-03-17`

This slice adds the safe multimodal bridge for the local brain without
pretending full multimodal reasoning already exists.

## What It Does

- allows `image`, `pdf`, and `audio` files to be ingested as durable artifacts
- keeps the raw file as the source of truth on disk
- does not force fake text chunks for binary artifacts
- lets later OCR, captions, or extraction notes be attached as
  `artifact_derivations`
- makes those attached text proxies searchable through the same retrieval
  surface

## Why This Matters

This keeps the local brain honest:

- raw binary evidence is preserved immediately
- searchable meaning arrives through explicit derived text
- provenance remains intact because derivations point back to the exact artifact
  observation

That matches the safe path surfaced by the latest NotebookLM re-ask:

- artifact first
- proxy text second
- embeddings only after provider behavior is verified

## Implemented Behavior

### Binary Artifact Registration

When a file is ingested as `image`, `pdf`, or `audio`:

- the artifact and observation are registered
- checksum/idempotency is based on raw bytes
- `has_text_content` is tracked in metadata
- no episodic fragments are fabricated if the file has no safe local text

### Text-Proxy Derivations

The new derivation path allows attached text such as:

- caption
- OCR
- extracted note
- manual summary

This is written to:

- `artifact_derivations.content_text`

with provenance back to:

- `artifact_observation_id`
- optional `source_chunk_id`
- original `source_uri`

### Retrieval

Search now includes `artifact_derivations` rows with non-empty `content_text`.

That means a query can now retrieve:

- episodic memory
- semantic memory
- procedural memory
- candidate memory
- artifact text proxies

## Example

1. Ingest an image:

```bash
cd /Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain
npm run ingest:file -- /absolute/path/to/photo.png --source-type image --namespace personal
```

2. Attach searchable proxy text:

```bash
cd /Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain
npm run derive:attach-text -- --artifact-id <artifact_uuid> --type caption --text "Kyoto temple map from the June 2025 trip"
```

3. Search:

```bash
cd /Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain
npm run search -- "temple map Kyoto" --namespace personal
```

## Current Honest Boundary

- this is not native multimodal reasoning
- it is a durable evidence plus derived-text architecture
- Gemini/OpenRouter provider adapters exist for text embeddings
- provider-backed multimodal extraction is still deferred

## Confidence

Confidence in this slice is high because it is:

- local-first
- provenance-preserving
- provider-optional
- exercised by the evaluation harness
