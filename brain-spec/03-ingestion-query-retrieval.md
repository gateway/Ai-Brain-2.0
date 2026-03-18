# Ingestion, Query, And Retrieval

## Ingestion Goals

The system should ingest:

- chat
- voice
- markdown
- PDFs
- images
- project notes
- repositories

It should preserve raw evidence and create machine-usable memory without
dragging entire documents into prompts.

## Ingestion Pipeline

### Step 1: Capture

Accept inputs from:

- chat clients
- voice recorder or dictation flows
- folder drops
- clipboard or paste
- uploads
- imports from external systems

### Step 2: Preserve

Before doing anything smart:

- save the original artifact
- compute a checksum
- assign an `artifact_id`
- write artifact metadata

This guarantees a durable source of truth.

### Step 3: Extract

Perform media-specific extraction.

Text:

- normalize encoding

Audio:

- transcribe
- preserve original audio

PDF:

- extract text
- preserve original PDF

Image:

- OCR or caption only if useful
- preserve original image

### Step 4: Fragment

Split content into `1` to `3` sentence units.

Fragment metadata should include:

- `artifact_id`
- `fragment_index`
- `char_start`
- `char_end`
- `speaker`
- `captured_at`
- `namespace_id`
- `channel`
- `candidate_type`
- `importance_score`

Why this matters:

- lowers token burn
- improves precision
- avoids context poisoning

### Step 5: Enrich

Add:

- entities
- tags
- candidate memory type
- confidence
- embedding request
- provenance pointer

### Step 6: Store

Write:

- episodic rows for all raw event fragments
- candidate semantic or procedural rows when justified

## Provider Choices

Embeddings and lightweight AI cleanup should go through a provider abstraction.

Possible choices:

- OpenAI direct
- OpenRouter
- local models

OpenRouter is a valid option for:

- embeddings
- small cleanup models
- adjudication helpers

Do not bake provider-specific assumptions into the schema.

## Query Loop

### Step 1: Query Analysis

Determine query type:

- factual recall
- timeline recall
- relationship recall
- current-state recall
- mixed recall

### Step 2: Query Planning

Extract:

- keywords
- entities
- time windows
- namespace constraints
- desired memory layers

### Step 3: Candidate Retrieval

Run in parallel:

- lexical retrieval
- vector retrieval
- relationship expansion
- temporal filtering

### Step 4: Ranking

Fuse ranked lists using RRF.

Then apply:

- namespace filters
- time constraints
- active-truth filters
- confidence thresholds

### Step 5: Context Assembly

Return the smallest sufficient context set.

Prefer:

- atomic fragments
- summary nodes
- linked evidence

Avoid:

- full raw files unless explicitly requested

### Step 6: Answer Generation

The reasoning model should:

- answer
- cite evidence
- point to source artifacts
- avoid claiming unsupported facts

## How The AI Should Query The Brain

The AI should not dump all memory into a prompt.

It should use tools like:

- `memory.search`
- `memory.timeline`
- `memory.get_artifact`
- `memory.get_relationships`
- `memory.get_state`

This reduces token burn and improves safety.

## Provenance Rules

Every answerable memory should be able to point back to:

- artifact
- timestamp or source offset
- namespace
- ingestion path

Strong provenance allows:

- citation
- auditing
- rebuilding
- trust

## Token Burn Control

Primary techniques:

- atomic fragments
- hierarchical summaries
- hybrid retrieval before prompting
- namespace scoping
- temporal scoping
- relationship filters
- semantic cache

What not to do:

- inject whole transcripts by default
- keep redundant summary layers in the same context
- let the reasoning model "figure it out" without retrieval planning

## Result Quality Goals

The result should be:

- grounded
- cited
- time-aware
- relationship-aware
- minimal

Example result shape:

- answer text
- confidence or ranking signal
- supporting fragments
- source artifact references
- optional linked relationships
