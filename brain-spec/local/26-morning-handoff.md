# Morning Handoff

Date: `2026-03-18`

## Current State

The local Brain 2.0 scaffold is now a working Postgres-centered runtime, not
just a design doc.

Verified working:

- native PostgreSQL 18 local DB
- artifact registry and versioned observations
- markdown/text/transcript ingestion
- OpenClaw-style folder reconciliation
- webhook ingestion for `generic`, `slack`, and `discord` payload shapes
- entity and relationship staging
- hybrid recall with lexical fallback
- timeline recall
- relationship lookup
- deterministic preference supersession
- binary artifact registration for `image`, `pdf`, and `audio`
- attached text-proxy derivations for captions/OCR/manual extraction
- HTTP runtime
- reproducible evaluation harness
- hybrid retrieval with lexical fallback
- deterministic relationship adjudication
- deterministic temporal summary scaffolding
- deterministic semantic decay / forgetting

## What To Read First

- [Local runtime README](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/README.md)
- [Local quickstart](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/QUICKSTART.md)
- [Full local build spec](/Users/evilone/Documents/Development/AI-Brain/ai-brain/brain-spec/local/17-full-local-brain-build-spec.md)
- [Hybrid retrieval and runtime proof](/Users/evilone/Documents/Development/AI-Brain/ai-brain/brain-spec/local/28-hybrid-retrieval-and-runtime-proof.md)
- [Runtime proof and next data collection](/Users/evilone/Documents/Development/AI-Brain/ai-brain/brain-spec/local/29-runtime-proof-and-next-data-collection.md)
- [Latest evaluation report](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/eval-results/latest.md)

## Verified Commands

```bash
cd /Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain
npm run check
npm run migrate
npm run eval
```

Webhook ingestion:

```bash
cd /Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain
npm run ingest:webhook -- ./examples/webhook/slack-message.json --provider slack --namespace personal --source-channel slack:dm
```

Directory ingestion:

```bash
cd /Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain
npm run reconcile:dir -- /absolute/path/to/folder --namespace personal --source-type markdown_session --source-channel openclaw
```

Binary artifact plus text proxy:

```bash
cd /Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain
npm run ingest:file -- /absolute/path/to/file.pdf --source-type pdf --namespace personal
npm run derive:attach-text -- --artifact-id <artifact_uuid> --type caption --text "Architecture diagram showing episodic semantic and procedural memory"
```

## What The Benchmarks Prove Right Now

The current evaluation harness proves:

- ingest fragments are written
- re-ingesting the same file is idempotent
- Japan 2025 recall works
- relationship lookup works
- preference supersession works
- provenance is returned
- abstention works for unknown lexical queries
- webhook payloads become searchable evidence
- binary artifacts can be registered without fake text
- attached text proxies become searchable
- hybrid vector search can activate when a query embedding is provided
- relationship adjudication produces accepted relationship rows
- temporal summary scaffolding writes summary nodes
- semantic decay writes audit events
- token burn stays controlled on the sample recall path

## How To Start Collecting Real Data

Best first collection paths:

1. point `reconcile:dir` at your markdown/session folder
2. send chat or bot payloads into `POST /producer/webhook`
3. ingest images/PDFs as binary artifacts
4. attach OCR/caption/proxy text to those artifacts

That gives you one brain with:

- one artifact registry
- one episodic timeline
- one relationship staging layer
- one consolidation path

## Good Next Integrations

- Slack app posting events to `POST /producer/webhook`
- Discord bot posting messages to `POST /producer/webhook`
- dictation/transcript pipeline writing markdown or transcript files
- OCR/caption helper that calls `derive:attach-text`
- later: provider-backed embedding writes into `artifact_derivations`

## Honest Remaining Gaps

- hybrid retrieval is real, but the fused kernel is still app-side and the
  lexical branch is PostgreSQL FTS rather than ParadeDB BM25
- relationship memory is now adjudicated deterministically, but it is not yet
  LLM-refined graph truth
- provider adapters are wired, but live provider execution is not verified on
  this machine because keys are not configured
- provider-backed multimodal extraction is still deferred
- Timescale hypertables, `pgvectorscale`, `pgai`, and final TMT jobs are not
  live yet
- relative-time understanding is still limited

## Confidence

Confidence is high that the local direction is correct and the current runtime
works for the verified slice.

Confidence is not yet at final-production level for:

- live vector retrieval quality
- live multimodal provider execution
- long-horizon TMT behavior
- real-world producer volume and noise
