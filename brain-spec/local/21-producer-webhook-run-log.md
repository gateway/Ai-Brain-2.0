# Producer Webhook Slice Run Log

Date: `2026-03-17`

This run log covers the local-first producer slice that bridges webhook payloads
into the existing artifact registry and ingest flow.

## Added

- [local-brain/src/producers/types.ts](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/producers/types.ts)
- [local-brain/src/producers/webhook.ts](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/producers/webhook.ts)
- [local-brain/src/cli/ingest-webhook.ts](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/cli/ingest-webhook.ts)
- [local-brain/examples/webhook/slack-message.json](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/examples/webhook/slack-message.json)
- [brain-spec/local/20-producer-webhook-slice.md](/Users/evilone/Documents/Development/AI-Brain/ai-brain/brain-spec/local/20-producer-webhook-slice.md)

Updated:

- [local-brain/src/server/http.ts](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/server/http.ts) (`POST /producer/webhook`)
- [local-brain/src/config.ts](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/config.ts) (`BRAIN_PRODUCER_INBOX_ROOT`)
- [local-brain/package.json](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/package.json) (`ingest:webhook`)
- [local-brain/README.md](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/README.md)
- [local-brain/QUICKSTART.md](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/QUICKSTART.md)
- [local-brain/.env.example](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/.env.example)
- [brain-spec/local/README.md](/Users/evilone/Documents/Development/AI-Brain/ai-brain/brain-spec/local/README.md)
- [.gitignore](/Users/evilone/Documents/Development/AI-Brain/ai-brain/.gitignore)

## What It Does

1. Accepts payloads from CLI or HTTP (`generic`, `slack`, `discord`).
2. Persists:
   - raw payload JSON
   - normalized markdown event
3. Calls `ingestArtifact(...)` on the normalized markdown.
4. Preserves provenance by storing `raw_payload_uri` in metadata.

## Verified Commands

Type check:

```bash
cd /Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain
npm run check
```

CLI webhook ingestion:

```bash
cd /Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain
npm run ingest:webhook -- ./examples/webhook/slack-message.json --provider slack --namespace producer_slice_test --source-channel slack:dm
```

Search result verification:

```bash
cd /Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain
npm run search -- "Kyoto Sarah Ken" --namespace producer_slice_test --time-start 2025-01-01T00:00:00Z --time-end 2026-12-31T23:59:59Z
```

HTTP producer verification:

```bash
cd /Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain
npm run serve
curl -s -X POST http://127.0.0.1:8787/producer/webhook -H 'Content-Type: application/json' -d '{...}'
```

Then checked retrieval:

```bash
cd /Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain
npm run search -- "Tokyo Aki 2025" --namespace producer_http_test --time-start 2025-01-01T00:00:00Z --time-end 2026-12-31T23:59:59Z
```

## What Worked

- CLI producer ingest wrote inbox files and inserted memory rows.
- HTTP endpoint `/producer/webhook` worked with Discord-style payload.
- Ingested content was queryable with provenance:
  - `source_uri` points to normalized markdown file
  - metadata includes `raw_payload_uri`
- Existing entity and candidate staging executed through normal ingest.

## What Failed And Fix

Issue:

- Initial patch to `.env.example` failed because file content had changed from
  earlier assumptions.

Fix:

- Read current file and patched against actual content.

## Current Limits

- No live Slack/Discord API pull yet (webhook normalization only).
- No provider-side signature verification yet.
- Producer path still uses lexical-first retrieval stack.

