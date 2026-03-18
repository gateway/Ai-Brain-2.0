# Notebook Answer: Ingestion and Provenance

## Purpose

This note summarizes the NotebookLM answer to the focused ingestion and
provenance query.

The query emphasized:

- local-first Apple Silicon deployment
- PostgreSQL as the memory substrate
- optional Supabase transition path
- no multi-database sprawl
- durable raw transcripts and markdown as source-of-truth artifacts

## Best Parts of the Notebook Answer

### 1. Raw artifacts should stay on disk

The strongest part of the answer is that it clearly separates:

- raw source artifacts on disk
- machine memory in PostgreSQL

This matches the requirement exactly.

Good recommendation:

- keep original audio, video, markdown, PDFs, notes, and imported files on disk
- store extracted fragments, embeddings, metadata, and provenance in PostgreSQL
- preserve enough file reference information that the brain can always point back
  to the original artifact

This is the right direction.

### 2. PostgreSQL should store fragments, not giant source blobs

The notebook recommends storing atomic memory fragments in PostgreSQL instead of
trying to make the database the file archive.

That is sensible.

The durable split should look like:

- disk:
  - original transcript files
  - markdown
  - imported documents
  - audio or video source files
- database:
  - normalized source records
  - episodic fragments
  - embeddings
  - memory candidates
  - promoted semantic or procedural entries

### 3. Agent-generated memory should not auto-promote

The answer explicitly says agent-generated memory candidates should be staged,
not blindly inserted into long-term memory.

That is a good safeguard.

Practical interpretation:

- agent-generated memory belongs in a candidate or session table first
- promotion should happen through explicit consolidation logic
- not every extraction deserves to become durable semantic memory

### 4. MVP should stay text-first

The notebook recommended deferring multimodal embeddings for MVP.

This is probably right.

Reason:

- the transcript and markdown durability problem matters more than proving image
  embeddings immediately
- text-first is enough to validate provenance, retrieval, and memory update
  behavior

## What the Notebook Proposed

The answer suggested this general ingestion design:

### Raw source artifact layer

Examples:

- audio files
- video files
- PDFs
- markdown files
- chat logs
- images
- repo snapshots or extracted project files

### Database layer

Suggested tables:

- `source_artifacts`
- `episodic_memory`
- `semantic_memory`
- `procedural_state`

Suggested provenance fields:

- source artifact ID
- file URI or file path
- byte offset, line range, page pointer, or timestamp pointer
- ingestion context

This is a solid foundation.

## Where the Answer Still Needs Human Judgment

### 1. It still over-reaches toward multimodal specifics

The answer discussed Gemini Embedding 2 for PDFs and images.

That is useful, but it should not distort the first implementation.

Current best reading:

- keep the architecture compatible with multimodal later
- do not require multimodal embeddings for the first working brain

### 2. It assumes 1-3 sentence fragments too quickly

That might be right for some ingestion paths, but not all.

We likely need multiple fragment strategies:

- short event fragments for chat and dictation
- section-level chunks for markdown and docs
- transcript segments tied to timestamps for audio

So the exact chunking rules still need design work.

### 3. It is a bit too eager to mention TMT again

Even in the ingestion answer, the notebook drifted back toward Temporal Memory
Tree language.

That is a sign the source set is biased toward advanced temporal systems.

Current safer stance:

- preserve precise timestamps now
- design provenance so a temporal hierarchy can be added later
- do not force TMT into the first build unless simple timestamp filtering proves
  insufficient

## Current Working Interpretation

The strongest usable design from this answer is:

- raw sources stay on disk
- PostgreSQL stores machine memory and provenance
- append-only episodic capture is the starting point
- semantic and procedural memory are downstream products of consolidation
- agent-generated memory must be staged before promotion
- text-first MVP is the safest path

## Practical First-Version Ingestion Model

If we translate the notebook answer into a first-build stance, it looks like
this:

### On Disk

- markdown conversation files
- transcript files
- imported PDFs
- raw audio files when needed
- images and screenshots
- scraped or normalized web captures

### In PostgreSQL

- `source_artifacts`
  - what the raw file is
  - where it lives
  - checksum
  - modality
- `episodic_entries`
  - append-only event or transcript fragments
  - timestamps
  - source references
- `memory_candidates`
  - extracted possible facts or preferences
  - confidence
  - extraction reason
- `semantic_memory`
  - promoted, governed knowledge
- `procedural_memory`
  - current preferences, rules, skills, and project instructions

## Best Next Design Question

The next notebook question should probably be:

- given this disk-plus-Postgres ingestion model, what exact schema and
  provenance fields should we use for transcripts, markdown files, and project
  artifacts in the MVP
