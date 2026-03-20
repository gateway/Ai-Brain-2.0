# AI Brain 2.0 Features And Examples

AI Brain 2.0 is designed to feel like a memory system, not just a search box.

The goal is simple:

- ingest evidence from real sources
- extract structured memory candidates
- keep provenance visible
- let an operator review and correct uncertainty
- query the system later in natural language without losing the original source trail

## What the dashboard gives you

The dashboard/workbench is the operator layer that makes the brain usable in practice.

It is where you:

- complete first-run setup
- define the owner/self anchor
- import trusted folders and monitored sources
- run sessions for new intake
- review clarifications and corrections
- inspect the graph and timeline
- test providers, embeddings, and operations settings

The brain substrate is the memory engine.
The dashboard is the control room that makes the engine understandable, reviewable, and safe to operate.

## What the brain can do

### 1. Keep durable evidence, not just model output

What it does:

- stores raw source files and source text as the authority
- keeps transcripts, derivations, and classifications reviewable instead of pretending they are final truth

Example:

- ingest a markdown note, an audio memo, and a PDF
- later inspect exactly which artifact or chunk caused the system to believe a person, place, or project exists

### 2. Build session-scoped intake and review loops

What it does:

- groups intake into sessions
- keeps artifacts, model runs, staged outputs, and clarifications together

Example:

- create a session called `March personal bootstrap`
- ingest owner notes and personal markdown files
- review extracted entities, relationships, claims, and ambiguities in one place

### 3. Extract people, places, projects, relationships, and claims

What it does:

- classifies incoming evidence into structured candidates
- stages ambiguity instead of silently forcing bad edges

Example:

- input: “Steve is living in Chiang Mai and working on Two-Way with Dan.”
- likely outputs:
  - person: `Steve`
  - place: `Chiang Mai`
  - project: `Two-Way`
  - relationship: `Steve works_on Two-Way`
  - relationship: `Steve knows Dan`

### 4. Surface clarifications instead of hiding uncertainty

What it does:

- surfaces unresolved people, places, aliases, kinship labels, and vague references
- lets the operator resolve them through controlled correction workflows

Example:

- source says: “I went to the cabin in the woods with my uncle”
- clarification asks:
  - who is `uncle`?
  - what is `cabin in the woods`?
- operator answers:
  - `uncle = Joe Smith`
  - `cabin in the woods = Lake Tahoe, California`

### 5. Query the brain in natural language

What it does:

- supports lexical and hybrid retrieval
- returns evidence-backed results instead of detached summaries

Example queries:

- `Where was I living in 2025?`
- `Who are my friends in Chiang Mai?`
- `What am I working on right now?`
- `What places do I keep mentioning with Lauren?`

Expected behavior:

- return grounded results
- keep provenance visible
- show the evidence/doc chunks that support the answer

### 6. Explore relationship memory as a graph

What it does:

- shows people, places, projects, and edges as a relationship atlas
- supports rooted exploration instead of a flat list

Example:

- click `Steve`
- expand outward into `Dan`, `Gumee`, `Two-Way`, `Chiang Mai`, and related entities

### 7. Inspect timeline and temporal memory

What it does:

- keeps episodic memory and temporal summaries queryable over time
- supports questions with time windows and historical bias

Example queries:

- `What was I doing in Japan in 2025?`
- `What projects was I touching around March 2026?`

### 8. Keep an operator in control of truth

What it does:

- avoids direct arbitrary database editing as the main truth path
- sends corrections back through controlled runtime endpoints
- preserves evidence and correction history

Example:

- merge two aliases for the same person
- resolve an identity conflict
- re-run processing with the correction applied

### 9. Support local runtime or hosted provider paths

What it does:

- local/private runtime support through `external`
- hosted routing through `openrouter`
- lexical-only fallback through `none`

Example:

- use your own local model box for ASR, LLM classification, and embeddings
- or use OpenRouter for hosted LLM/embedding paths

### 10. Use OpenClaw-style markdown as a bootstrap source

What it does:

- treats existing markdown memory/session files as trusted historical evidence
- makes it easy to bootstrap the brain from a corpus you already have

Recommended use case:

- if you already use OpenClaw or a similar markdown-based memory flow, import that first instead of recreating the data by hand

## How provenance works

The system is designed so that a result can be traced back to its source.

That means:

- source files remain authoritative
- chunks and derivations remain linked to artifacts
- search and verification surfaces can show supporting evidence
- operator review happens with source context intact

This is the difference between “the model said something” and “the system learned something from evidence.”

## How to think about the product

The pitch is not “chat with your files.”

The pitch is closer to:

- a personal or business memory substrate
- an operator-reviewed graph and timeline system
- a brain that can ingest, clarify, connect, and retrieve what matters later

In plain language:

AI Brain 2.0 is meant to help you stop losing context, stop forgetting relationships, and stop treating scattered notes as dead text.
