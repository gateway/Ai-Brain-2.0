# Operations Runtime

This document explains how the AI Brain operator-facing runtime workers are intended to run.

## What runs in the background

There are three important operational loops behind the workbench:

- monitored source scanning and import
- clarification/inbox outbox propagation
- temporal summary generation
- durable worker run ledger and health reporting

These are runtime concerns, not UI concerns.

## Source monitoring

Source monitoring is stored in the app as:

- monitored source records
- `monitor_enabled`
- `scan_schedule`
- source intent metadata

Execution happens in `local-brain`, not in the Next.js UI.

Key files:

- [local-brain/src/ops/source-service.ts](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/ops/source-service.ts)
- [local-brain/src/cli/process-source-monitors.ts](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/cli/process-source-monitors.ts)
- [local-brain/src/server/http.ts](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/server/http.ts)

Control endpoint:

- `POST /ops/sources/process`
- `GET /ops/workers`

## Inbox and outbox propagation

Clarification, alias, and identity-resolution actions are not supposed to mutate truth silently.

The system uses `brain_outbox_events`, then processes them through the clarification service and rebuild logic.

Key files:

- [local-brain/src/clarifications/service.ts](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/clarifications/service.ts)
- [local-brain/src/server/http.ts](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/server/http.ts)

Control endpoint:

- `POST /ops/outbox/process`
- `GET /ops/workers`

## Temporal summaries

Temporal summaries now have two layers:

- deterministic temporal scaffolding
- optional semantic summary overlay driven by a selected LLM provider

The deterministic layer generates `day`, `week`, `month`, and `year` rollups from the underlying episodic and relationship substrate. It remains authoritative.

The semantic layer rewrites the operator-facing summary text for those temporal nodes while preserving provenance and deterministic membership. It is intended to make summaries more readable, not to replace the structural substrate.

Key files:

- [local-brain/src/jobs/temporal-summary.ts](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/jobs/temporal-summary.ts)
- [local-brain/src/server/http.ts](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/server/http.ts)

Control endpoint:

- `POST /ops/temporal/process`
- `GET /ops/workers`

When you pass:

- `strategy: "deterministic_plus_llm"`
- `provider: "external" | "openrouter" | "gemini"`

the runtime will run the deterministic scaffold first, then apply the semantic summary overlay.

The semantic overlay stores metadata such as:

- `semantic_summary_provider`
- `semantic_summary_model`
- `semantic_summary_preset`
- `semantic_summary_updated_at`
- recurring themes and uncertainties extracted from the LLM output

## Worker ledger and health

The runtime now persists background worker runs in `ops.worker_runs`.

That ledger powers compact operator-facing health panels for:

- `source_monitor`
- `outbox`
- `temporal_summary`

The current UI status model is:

- `disabled`
- `never`
- `running`
- `healthy`
- `degraded`
- `failed`
- `stale`

The first compact status panels now live in:

- Dashboard
- Start Here
- Guided Setup import
- Settings
- session timeline views

Each run records:

- worker key
- trigger type
- namespace/source scope
- start and finish timestamps
- duration
- next due time
- attempted / processed / failed / skipped counts
- structured summary JSON
- error class and error message when applicable

Failure summaries may also include:

- `failure_category`
- `retry_guidance`

Current normalized failure categories:

- `provider_auth`
- `provider_timeout`
- `schema_mismatch`
- `source_access`
- `runtime_dependency`
- `unknown`

This lets the operator UI distinguish between things like a bad provider key, a dimension mismatch, and a missing folder path instead of only showing a raw stack trace.

## Combined operations worker

The repo now has a combined runtime worker that can run these loops together:

- [local-brain/src/cli/process-runtime-operations.ts](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/cli/process-runtime-operations.ts)
- [scripts/run_runtime_ops.sh](/Users/evilone/Documents/Development/AI-Brain/ai-brain/scripts/run_runtime_ops.sh)

Root command:

```bash
cd /Users/evilone/Documents/Development/AI-Brain/ai-brain
npm run ops:work
```

Or alongside the full stack:

```bash
cd /Users/evilone/Documents/Development/AI-Brain/ai-brain
BRAIN_RUNTIME_OPS_ENABLED=true npm run dev
```

## Session timeline surface

The workbench now also has a session-scoped timeline view so operators can inspect a single intake run without jumping straight into the global console timeline.

That surface combines:

- the session time window
- session-linked episodic rows
- overlapping temporal summaries
- semantic summary metadata such as provider, model, recurring themes, and uncertainties

Key endpoint:

- `GET /ops/sessions/:sessionId/timeline`

## Why this is not MCP

MCP is the assistant/tool interface.

The always-on worker loop should stay in the runtime layer because it needs:

- durable state
- scheduling
- retry behavior
- process supervision
- queue-like semantics

MCP can expose controls and inspection later, but MCP should not be the daemon.

## Current summary strategy

The settings surface now stores:

- temporal summary cadence
- temporal summary strategy
- summarizer provider
- summarizer model
- summarizer preset
- optional summarizer system prompt

The default semantic-summary prompt is based on the project research pass and is designed to:

- stay grounded in deterministic rollups and source evidence
- avoid inventing facts
- preserve exact names, versions, dates, and relationships
- collapse repetition into higher-signal themes
- explicitly call out uncertainty instead of pretending confidence

Recommended policy:

- keep deterministic summaries as truth
- use the semantic overlay for readability
- prefer smaller/faster models for routine day/week/month/year summarization unless quality demands a larger model
