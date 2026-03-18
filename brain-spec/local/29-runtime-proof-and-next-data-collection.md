# Runtime Proof And Next Data Collection

Date: `2026-03-18`

This note records the latest local runtime proof pass after the hybrid retrieval
slice and turns it into a practical "what to connect next" guide.

## What Was Re-Verified Live

### Evaluation harness

Verified command:

```bash
cd /Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain
npm run eval
```

Observed output:

- [latest.json](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/eval-results/latest.json)
- [latest.md](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/eval-results/latest.md)

Observed checks passed:

- ingest fragment writes
- ingest idempotency
- Japan 2025 recall
- relationship recall
- preference supersession
- provenance presence
- abstention on unknown query
- webhook producer ingestion
- binary artifact registration
- text-proxy artifact search
- hybrid vector branch activation
- relationship adjudication
- weekly temporal summary scaffolding
- semantic decay event recording
- token-burn control on the sample recall path

### HTTP runtime

Verified command:

```bash
cd /Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain
npm run serve
```

Observed live checks:

```bash
curl -s http://127.0.0.1:8787/health
curl -sG http://127.0.0.1:8787/search \
  --data-urlencode 'namespace_id=eval_1773802595659' \
  --data-urlencode 'query=Japan 2025 Sarah' \
  --data-urlencode 'time_start=2025-01-01T00:00:00Z' \
  --data-urlencode 'time_end=2025-12-31T23:59:59Z' \
  --data-urlencode 'limit=3'
curl -sG http://127.0.0.1:8787/relationships \
  --data-urlencode 'namespace_id=eval_1773802595659' \
  --data-urlencode 'entity_name=Japan' \
  --data-urlencode 'predicate=with' \
  --data-urlencode 'time_start=2025-01-01T00:00:00Z' \
  --data-urlencode 'time_end=2025-12-31T23:59:59Z' \
  --data-urlencode 'limit=10'
```

Observed:

- `/health` returned `{"ok": true}`
- `/search` returned the June 2025 Japan episodic fragment with provenance
- `/relationships` returned accepted `Steve -> Sarah` and `Steve -> Ken`

### Provider smoke behavior

Verified commands:

```bash
cd /Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain
npm run provider:smoke -- --provider openrouter --text "provider smoke"
npm run provider:smoke -- --provider gemini --text "provider smoke" --dimensions 1536
```

Observed:

- OpenRouter returns typed `PROVIDER_AUTH`
- Gemini returns typed `PROVIDER_AUTH`

That is the correct behavior for the current machine state because API keys are
not configured. The provider layer is wired, but not falsely marked "verified"
for live external execution.

## NotebookLM Sanity Check

NotebookLM was queried again for the next real-world ingestion paths after the
current local runtime:

- OpenClaw markdown folders
- Slack/Discord bots or webhooks
- voice dictation/transcripts
- image/PDF drop folders

The useful guidance matched the current implementation direction:

- safe now:
  - OpenClaw markdown folder reconciliation
  - Slack/Discord-style webhook capture into durable files plus normalized text
  - watched-folder artifact registration
- should go through a staging worker:
  - voice dictation and transcript cleanup
  - image/PDF OCR or caption extraction into text proxies
  - bulk chat export normalization
- future work:
  - direct multimodal derivation over raw artifacts
  - more autonomous hierarchy evolution

Where NotebookLM drifted:

- it leaned too hard toward treating OpenClaw markdown as candidate-only
- it leaned too hard toward direct multimodal model use

Correction applied:

- the current repo keeps one unified path:
  - artifact registration
  - chunks when text exists
  - episodic memory as historical evidence
  - candidate staging for later promotion
- binary artifacts stay source-of-truth on disk and gain searchability through
  text proxies first

## Practical Next Data Collection Paths

### 1. OpenClaw markdown folders

Use now.

What it does:

- ingests markdown/session files as durable artifacts
- fragments them into episodic evidence
- stages semantic/procedural candidates

How:

```bash
cd /Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain
npm run reconcile:dir -- /absolute/path/to/openclaw/folder --namespace personal --source-type markdown_session --source-channel openclaw
```

Why this is first:

- strongest provenance
- lowest operational risk
- directly compatible with how OpenClaw writes memory today

### 2. Slack / Discord capture

Use next.

What it does:

- turns message payloads into durable raw JSON plus normalized markdown/text
- keeps chat evidence searchable by the same brain

How:

- post into `POST /producer/webhook`
- or use the file-based CLI for exports and replay

Why this is good now:

- the producer adapter is already implemented
- it keeps the same artifact and episodic path
- it is flexible enough for webhook, export replay, or later live bot capture

### 3. Voice dictation

Stage next.

What it does:

- keeps audio as physical evidence
- stores transcripts as searchable text
- lets consolidation decide what becomes durable belief or project truth

How to do it safely:

- keep audio files on disk
- write transcript files into a watched folder or direct ingest path
- optionally add a cleanup worker before ingest for filler removal or speaker tags

Why not fully direct yet:

- transcript normalization quality matters
- relative-time phrasing and spoken disfluencies still need care

### 4. Image / PDF drop folders

Use with the current safe path.

What it does:

- registers raw images/PDFs as durable evidence
- attaches caption/OCR/extraction text as searchable derivations

How:

```bash
cd /Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain
npm run ingest:file -- /absolute/path/to/file.pdf --source-type pdf --namespace personal
npm run derive:attach-text -- --artifact-id <artifact_uuid> --type ocr --text "Extracted text or caption here"
```

Why this is the right current path:

- it preserves provenance
- it does not fake local multimodal understanding
- it prepares the schema for later provider-backed derivations

## Self-Critique

What was missing in earlier docs:

- some handoff notes still described retrieval as lexical-first
- some handoff notes still described relationship memory as only staged
- provider support was easy to over-read as "implemented" rather than "wired"

What this pass corrected:

- hybrid retrieval is now documented as real but still transitional
- relationship adjudication, temporal summaries, and semantic decay are
  documented as live verified behaviors
- provider-backed multimodal work is kept clearly in the "not yet proven" lane

Current confidence:

- local runtime proof: about `94%`
- external provider execution: about `60%` until keys are configured and tested
- multimodal-native derivation: still future work, not claimed

## Clean Next Steps

1. Point `reconcile:dir` at a real OpenClaw or notes folder.
2. Add a lightweight Slack or Discord collector that posts to
   `POST /producer/webhook`.
3. Add a dictation pipeline that writes transcript markdown into the same
   artifact flow.
4. Add a helper that turns image/PDF OCR or captions into
   `POST /derive/text` or `derive:attach-text`.
5. Only after that, verify live embedding providers and move more retrieval
   traffic onto the vector branch.
