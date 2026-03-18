# Producer Slice: Webhook Ingestion

Date: 2026-03-17

## Scope

This slice adds a safe local-first producer path for external channels without
changing the core memory schema or bypassing provenance:

- input: webhook payloads (`generic`, `slack`, `discord`)
- output: durable local files + normal ingest pipeline writes
- no direct DB writes from producer code

## What It Does

1. Accepts a webhook payload through CLI or HTTP.
2. Normalizes key fields:
   - event id
   - capture time
   - actor
   - channel
   - text body
3. Persists two durable files:
   - raw JSON payload
   - normalized markdown event
4. Calls existing `ingestArtifact(...)` with:
   - `sourceType = chat_turn`
   - metadata including `raw_payload_uri`

This keeps all existing behavior intact:

- `artifacts`, `artifact_observations`, `artifact_chunks`
- `episodic_memory`
- `memory_candidates`
- relationship staging

## Why This Approach

- Reuses the proven file-backed ingestion and avoids duplicate code paths.
- Preserves a source-of-truth raw payload for audits.
- Keeps provider adapters small and deterministic.
- Makes Slack/Discord expansion incremental instead of a new subsystem.

## Implemented Files

- `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/producers/types.ts`
- `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/producers/webhook.ts`
- `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/cli/ingest-webhook.ts`
- `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/server/http.ts` (`POST /producer/webhook`)

## Operational Notes

- default producer inbox root:
  - `BRAIN_PRODUCER_INBOX_ROOT`
  - fallback: `./producer-inbox`
- one payload writes:
  - `<event>.json` raw payload
  - `<event>.md` normalized text for ingestion

## Future Slack/Discord Extension

This slice intentionally does not implement polling or API clients.

Next extension layer:

1. Slack Events API receiver or socket mode consumer.
2. Discord gateway/webhook receiver.
3. Map each inbound event to `ingestWebhookPayload(...)`.
4. Add per-source idempotency checks by native event ID.

## Validation

Validated locally via:

- build/check
- webhook CLI ingest with sample Slack payload
- retrieval check over ingested text

