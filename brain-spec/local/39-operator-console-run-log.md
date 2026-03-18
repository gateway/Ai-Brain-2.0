# Operator Console Run Log

Date: 2026-03-18

## Goal

Implement the first local operator console for Brain 2.0 using:

- `Next.js`
- `Tailwind CSS`
- `shadcn/ui`

This should remain a read-first dashboard for:

- query/debug
- evaluation
- lexical benchmark visibility
- queue/memory health
- artifact provenance

## NotebookLM Loop

NotebookLM was asked:

- what a local Brain 2.0 operator console should expose first
- how to keep BM25 vs vector vs fused retrieval observable
- how to show TMT status and provenance without overbuilding the UI

Useful output kept:

- expose hybrid search diagnostics first
- make TMT/temporal layer counts visible
- show relationship memory and supersession status
- expose jobs/consolidation health
- keep provenance auditable
- keep evaluation/benchmark drift visible

Corrections applied locally:

- no attempt was made to build the full RRF trace UI in the first slice
- no graph-heavy JS view was built yet
- eval and benchmark artifacts are read directly from disk instead of inventing a duplicate report API
- one small read-only runtime endpoint was added instead of a broader admin surface

## What Was Implemented

### Local Brain Runtime

Added:

- `GET /ops/overview`

Source:

- `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/ops/service.ts`
- `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/server/http.ts`

Current payload includes:

- lexical provider and fallback mode
- derivation queue status counts
- vector sync queue status counts
- temporal node count
- pending relationship candidate count
- active relationship memory count
- semantic decay event count

### No-JS Operator Actions

Added:

- `POST /console/eval/run`
- `POST /console/benchmark/run`

These routes execute the local-brain CLI commands server-side and redirect back
to the operator pages with status query params.

### Console App

Created:

- `/Users/evilone/Documents/Development/AI-Brain/ai-brain/brain-console`

First pages:

- `/console`
- `/console/query`
- `/console/eval`
- `/console/benchmark`
- `/console/jobs`
- `/console/artifacts/[id]`

Key implementation files:

- `/Users/evilone/Documents/Development/AI-Brain/ai-brain/brain-console/src/lib/brain-runtime.ts`
- `/Users/evilone/Documents/Development/AI-Brain/ai-brain/brain-console/src/components/console-shell.tsx`
- `/Users/evilone/Documents/Development/AI-Brain/ai-brain/brain-console/src/components/metric-card.tsx`
- `/Users/evilone/Documents/Development/AI-Brain/ai-brain/brain-console/src/app/console/page.tsx`
- `/Users/evilone/Documents/Development/AI-Brain/ai-brain/brain-console/src/app/console/query/page.tsx`
- `/Users/evilone/Documents/Development/AI-Brain/ai-brain/brain-console/src/app/console/eval/page.tsx`
- `/Users/evilone/Documents/Development/AI-Brain/ai-brain/brain-console/src/app/console/benchmark/page.tsx`
- `/Users/evilone/Documents/Development/AI-Brain/ai-brain/brain-console/src/app/console/jobs/page.tsx`
- `/Users/evilone/Documents/Development/AI-Brain/ai-brain/brain-console/src/app/console/artifacts/[id]/page.tsx`

## Verification

Build and typecheck:

- `cd /Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain && npm run check`
- `cd /Users/evilone/Documents/Development/AI-Brain/ai-brain/brain-console && npm run lint`
- `cd /Users/evilone/Documents/Development/AI-Brain/ai-brain/brain-console && npm run build`

Runtime proof:

- `GET /ops/overview` returned live queue and memory counts
- `/console` rendered against the live runtime
- `/console/query` returned a real seeded Japan 2025 search result
- `POST /console/eval/run` returned `303` to `/console/eval?status=ok`
- `POST /console/benchmark/run` returned `303` to `/console/benchmark?status=ok`

## Honest Current Limits

- BM25/FTS observability is present, but not yet a full per-candidate RRF diagnostic table
- the console is intentionally server-rendered and graph-light
- timeline and relationship explorer pages are still deferred
- the console assumes the local brain runtime is already running
- eval/benchmark pages read the latest report artifacts from disk rather than launching jobs from the UI

## Review

What went well:

- the operator console fits the actual backend instead of inventing a parallel system
- the read-only runtime endpoint stayed minimal
- the first slice already makes the main brain health questions visible
- eval and benchmark can now be launched from the console without client-side JS

What is still pending:

- timeline and relationship operator pages
- optional static graph panel
- richer BM25 vs FTS candidate diagnostics
