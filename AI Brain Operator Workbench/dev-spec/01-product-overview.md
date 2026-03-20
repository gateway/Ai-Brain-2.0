# 01 — Product Overview

## Product summary

Build an operator-facing app that lets a human user:

- create an intake session
- submit source material into AI Brain
- run derivation/classification workflows
- inspect what the brain inferred
- review ambiguity, conflicts, aliases, and unresolved references
- correct or clarify uncertain items
- trigger reprocessing or consolidation
- explore the resulting relationship graph and session memory state
- inspect the database through safe, read-only query tooling

## Why this app exists

AI Brain 2.0 already acts as a memory substrate with ingestion, candidates, relationships, time-aware memory, and retrieval.

What is missing is a dedicated **operator workbench** that makes these flows easy and inspectable for humans, especially during:

- data onboarding
- debugging
- relationship/identity cleanup
- session-based research ingestion
- demoing the system credibly
- proving how evidence becomes memory

## What problem this solves

Without this app, the system is harder to trust because:

- ingest paths are fragmented
- session state is not first-class enough for review
- operator corrections are not easy to make
- ambiguity handling is hidden in tables or logs
- graph exploration is not centered on the intake session
- model-runtime testing is disconnected from the actual memory workflow

This app provides a visible path from:

**source material → derivation → staged candidates → operator review → corrections → consolidation → graphable memory**

## Product positioning

This is:

- an **operator tool**
- a **memory review tool**
- a **session-based ingestion surface**
- a **graph and provenance inspector**

This is not:

- a consumer chat UI
- a generic file uploader
- a replacement for the AI Brain runtime
- a free-form DB admin console
- an MCP client

## Product principles

### 1. Evidence first
Raw evidence remains durable and inspectable.

### 2. Brain-first, not UI-first
The app should use the brain runtime as the core service boundary.

### 3. Candidate-first, not truth-first
Model outputs should stage candidates and review items, not silently become truth.

### 4. Session-centered trust
Operators should be able to understand what happened in one session before expanding globally.

### 5. Corrections are controlled events
Operator edits should become explicit clarification or correction actions, not hidden table edits.

### 6. Graph should be explorable
Entities and relationships should be inspectable through an interactive graph with provenance.

### 7. Debuggability matters
The app should show request payloads, statuses, model run outputs, and job history where appropriate.

## Primary jobs-to-be-done

### Job 1 — ingest real-world material
“As an operator, I want to paste text, upload files, or record audio so that I can get it into the brain as a reviewable session.”

### Job 2 — see what the brain understood
“As an operator, I want to see the transcript, extracted text, candidate entities, relationships, and summaries so I can judge system quality.”

### Job 3 — fix ambiguity
“As an operator, I want to resolve things like alias collisions, uncertain family references, and possible duplicates so the graph becomes more trustworthy.”

### Job 4 — inspect the graph
“As an operator, I want to click through people, places, projects, and relationships in a graph view to understand what the session created.”

### Job 5 — inspect data and debug
“As an operator, I want a safe way to search, inspect timeline results, and run read-only SQL to verify what is in the brain.”

### Job 6 — test provider pipelines
“As an operator or engineer, I want to test ASR, prompts, models, and embeddings against the same system so I can tune ingestion quality.”

## Product boundaries

### In scope
- session creation
- text intake
- audio upload and browser recording
- file upload for PDF/image/audio/text
- brain ingest integration
- ASR integration
- LLM classification integration
- session review UI
- clarification/conflict review UI
- graph explorer
- timeline view
- query workbench
- model lab page
- audit and job history per session

### Out of scope for MVP
- consumer-grade polished mobile experience
- full global graph exploration of all memory by default
- collaborative multi-user editing with locking
- write-capable SQL console
- broad OCR/vision pipeline if no provider adapter exists yet
- real-time streaming LLM UI
- full workflow automation engine inside the app

## High-level success criteria

The product succeeds if an operator can:

1. create a session
2. submit text or audio
3. get derivation/classification results back
4. see what the system inferred
5. fix at least one ambiguous relationship or alias issue
6. trigger a re-run
7. see the corrected graph and session state
8. verify the memory state in search/timeline/query views

## Product risks

- direct DB edits bypassing the brain
- unclear session ownership of artifacts and review items
- weak PDF/image handling if OCR derive path is missing
- graph overload if rendered globally too early
- fragile prompt/classification contracts
- overexposing low-level debug details to normal operators

## Product recommendation

Treat this app as an **operator-grade memory intake and review system** and design it with:

- strong provenance
- strong error visibility
- explicit session scoping
- clear correction workflows
- safe data boundaries
