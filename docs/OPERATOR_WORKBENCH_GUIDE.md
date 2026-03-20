# Operator Workbench Guide

This guide explains what each major area of the AI Brain 2.0 app is for and how to use the system after install.

If you need installation and first-run setup instructions, start with:

- [docs/FIRST_RUN_SETUP.md](/Users/evilone/Documents/Development/AI-Brain/ai-brain/docs/FIRST_RUN_SETUP.md)

## Product shape

There are two operator-facing surfaces in this repo:

- `Operator Workbench`
  - the primary guided app
  - session-centric intake, review, setup, and provider controls
- `Legacy Console`
  - the advanced exploration surface
  - query, relationship graph, timeline, benchmark, eval, and inbox tools

The Workbench is the main entry point.
The Legacy Console is secondary and more technical.

## The recommended order for a new install

1. `Start Here`
2. `Guided Setup`
3. `Settings`
4. `Sessions`
5. `Legacy Console` after setup is complete

## Main sections

### Dashboard

The operator home screen.

Use it to:

- see whether setup is complete
- check runtime health
- review trusted-source state
- jump into the right next action
- return to active sessions

### Start Here

The first-run checklist.

Use it to:

- verify runtime reachability
- confirm setup progress
- inspect background worker health
- know exactly what step comes next
- avoid jumping into operator work too early

### Guided Setup

The onboarding flow that grounds the system before daily use.

It covers:

- brain purpose
- owner/self setup
- trusted source import
- verification smoke checks

This is the correct place to bootstrap the system, not the session list.

### Purpose

This sets the operational lane for the brain.

Supported modes:

- `personal`
- `business`
- `creative`
- `hybrid`

Purpose is not just display text. It influences namespace defaults and the framing of the setup path.

### Owner Setup

This is where the brain learns who the owner is in a controlled way.

Use it to:

- create the self anchor
- save canonical self profile data
- ingest typed narrative, markdown, and audio as evidence
- review what the brain learned
- resolve clarifications

This is where the first trusted personal evidence should go.

### Trusted Source Import

This is for monitored or historical source import.

Supported source intents include:

- owner bootstrap
- ongoing folder monitor
- historical archive
- project source

Monitoring strategy in the current app:

- the dashboard stores source intent, `monitor_enabled`, and `scan_schedule`
- `local-brain` owns the actual scan/import work
- scheduled folder monitoring runs through the runtime worker, not through the UI directly
- when monitoring is enabled, changed files are fingerprinted and only changed files are re-imported

This keeps source monitoring aligned with the same evidence-first ingestion contract used everywhere else.

The import surface now also shows the current source-monitor worker state, last run, next due time, and retry guidance when the latest background run failed or degraded.

### When OpenClaw is recommended

If you already have OpenClaw-style markdown memory/session files, this is the recommended import path.

Why:

- it already matches the evidence-first ingestion posture
- it preserves raw source files
- it aligns with the monitored-source flow already implemented in the app

OpenClaw-style import is the best historical bootstrap option when you have an existing markdown corpus.

### Verify The Brain

This is the smoke-check surface.

Use it to make sure the system can:

- resolve the self anchor
- return search results with evidence
- show clarifications honestly
- prove that retrieval is actually working before normal use

### Sessions

Sessions are the main ongoing operator workflow after setup.

A session groups:

- intake inputs
- uploaded artifacts
- transcripts and text
- model runs
- staged outputs
- clarifications
- graph and timeline views

Session timelines now show:

- evidence linked to that session
- overlapping day/week/month/year summaries
- semantic summary metadata when the LLM overlay is enabled

Use sessions when you are actively ingesting or reviewing a discrete batch of material.

### Models

The runtime and model lab surface.

Use it to:

- inspect loaded model families
- see runtime state
- load and unload models
- inspect OpenRouter discovery results

This is not the main setup flow, but it is useful for runtime debugging and verification.

### Settings

The provider and embeddings routing surface.

Use it to:

- choose embeddings provider
- choose model and dimensions
- test embeddings
- rebuild namespace vectors
- save preferred OpenRouter defaults
- tune source monitor, inbox/outbox, and temporal summary operations
- inspect runtime worker health and retry guidance

Current provider meanings:

- `none`: lexical-only retrieval
- `external`: your own local/private runtime
- `openrouter`: hosted models and embeddings
- `gemini`: future/optional provider path

### Audit

The operator-facing quality and readiness surface.

Use it for:

- validation visibility
- health review
- operator-safe audit context

### Legacy Console

The advanced exploration surface.

Use it when you need:

- query debugging
- graph inspection
- timeline exploration
- eval and benchmark posture
- inbox-level ambiguity or conflict work

It is intentionally more technical than the main Workbench.

## How to think about evidence and truth

The app is not designed as a direct database editor.

The operating model is:

- raw evidence is authoritative
- transcripts, derivations, and staged outputs remain reviewable
- clarifications flow back into the brain through controlled endpoints
- session scope matters
- graph and memory inspection should always preserve provenance

## Current known caveat

`Qwen/Qwen3-Embedding-4B` works on the provider test path and returns valid vectors, but it returns `2560` dimensions.

The current pgvector columns are still fixed at `1536`, so:

- provider test: works
- full namespace re-embed: blocked until schema upgrade

Today, the most complete end-to-end hybrid retrieval path is still a `1536`-dimension model such as OpenRouter with `text-embedding-3-small`.

## Related docs

- [README.md](/Users/evilone/Documents/Development/AI-Brain/ai-brain/README.md)
- [docs/FIRST_RUN_SETUP.md](/Users/evilone/Documents/Development/AI-Brain/ai-brain/docs/FIRST_RUN_SETUP.md)
- [local-brain/QUICKSTART.md](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/QUICKSTART.md)
- [docs/LIFE_ONTOLOGY.md](/Users/evilone/Documents/Development/AI-Brain/ai-brain/docs/LIFE_ONTOLOGY.md)
- [docs/ROUTING_RULES.md](/Users/evilone/Documents/Development/AI-Brain/ai-brain/docs/ROUTING_RULES.md)
