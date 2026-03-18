# NotebookLM Validation And Self-Heal Pass

## Purpose

This pass re-validated the local Brain 2.0 spec against fresh NotebookLM
queries and then updated the master spec where the prior wording was still too
soft, too ambiguous, or too easy to misread as a reduced architecture.

NotebookLM was used as a pressure-test, not as an unquestioned authority.

## Notebook And Method

- notebook: `The Digital Brain`
- notebook id: `3fd8e35e-5115-4fb4-a81c-b28b69db002a`
- method:
  - ask one section-specific question at a time
  - reject vague or bloated answers
  - re-ask with tighter prompts when needed
  - keep only the parts that survive engineering scrutiny

## Queries Run

### 1. Ingestion architecture

Prompt intent:

- define the concrete ingestion flow for:
  - chat
  - markdown
  - voice dictation
  - transcripts
  - PDFs
  - images
  - project files
- require provenance rules
- require rules for episodic vs semantic vs procedural writes

Notebook result:

- reinforced raw artifacts on disk as source truth
- reinforced 1 to 3 sentence fragment units
- reinforced text-first reasoning for most facts
- reinforced multimodal embeddings as additive, not universal

Spec changes applied:

- made re-segmentation an explicit consolidation rule
- strengthened provenance with content hash and artifact-version fields
- clarified that image and PDF ingestion must preserve artifact references even
  when text extraction stays primary

### 2. Relationship and temporal recall

Prompt intent:

- explain exactly how the system answers:
  - `Who was I with in Japan in 2025?`
- require a build-oriented answer covering memory layers, relationships, time
  filters, temporal hierarchy, hybrid retrieval, RRF, and provenance

Notebook result:

- strongly reinforced:
  - recall planner
  - relationship joins
  - time-bounded search
  - TMT expansion
  - provenance-backed answers

Spec changes applied:

- added an explicit retrieval planner rule
- clarified current-truth vs historical-truth routing
- expanded validation gates for relationship recall and temporal containment

### 3. Conflict resolution and forgetting

Prompt intent:

- use:
  - January: `I like spicy food`
  - April: `I hate spicy food`
- require concrete treatment across episodic, semantic, procedural, summaries,
  and forgetting

Notebook result:

- reinforced active truth vs historical truth
- reinforced superseded durable facts instead of deletion
- reinforced decay of low-value derived memory, not raw evidence
- reinforced summaries that capture change over time

Spec changes applied:

- added explicit durable fields:
  - `valid_from`
  - `valid_until`
  - `status`
  - `superseded_by`
  - `confidence`
- clarified that summaries must preserve preference drift instead of flattening
  contradictions
- clarified the allowed forgetting order

### 4. Local extension and data stack

Prompt intent:

- separate:
  - target local stack
  - safe first baseline
  - macOS cautions
- cover PostgreSQL 18, TimescaleDB, pgvector, pgvectorscale, pgai, BM25-grade
  lexical retrieval, RRF, MCP, and raw artifact storage

Notebook result:

- reinforced the target stack:
  - PostgreSQL 18
  - TimescaleDB
  - pgvector
  - pgvectorscale
  - pgai
  - BM25-grade lexical retrieval
  - RRF
  - MCP
- correctly surfaced `io_method = worker` as the safer macOS framing

Spec changes applied:

- no architecture reduction
- kept the target stack intact
- preserved the current baseline distinction only as implementation sequencing

### 5. Hostile critique

Prompt intent:

- ask NotebookLM to attack the design and identify where systems like this
  usually fail

Notebook result:

- useful risks:
  - one-shot segmentation is insufficient for every long or noisy input
  - byte offsets alone are brittle provenance
  - relationship graphs stay empty unless extraction is mandatory
  - retrieval tuning can leak if session state is changed globally
  - evaluation drift is easy to ignore
- less useful or overconfident items:
  - some extension and model details were stated too absolutely

Spec changes applied:

- added provenance durability rule
- added operator validation and `SET LOCAL` guidance
- added evaluation validation and drift detection expectations
- added relationship extraction as its own implementation phase

## Where NotebookLM Was Right

- local-first Postgres substrate
- raw artifacts as source truth
- tripartite memory
- relationship-aware recall
- TMT-style temporal hierarchy
- conflict-aware consolidation
- selective forgetting of derived memory
- MCP as the interface layer

## Where NotebookLM Needed Correction

- it still tends to speak as if target architecture equals proven local bring-up
- it can overstate extension readiness or packaging simplicity
- it can drift into overly absolute implementation claims when a safer baseline
  is still the honest first step

## External Cross-Checks

NotebookLM was not the only source of truth used in this pass.

The following current primary sources remain part of the engineering check:

- PostgreSQL 18 release and AIO docs
- pgvectorscale official documentation and repository
- pgai official documentation and repository
- ParadeDB documentation for BM25 inside PostgreSQL

These are especially important anywhere NotebookLM drifts from:

- local packaging reality
- macOS behavior
- extension support assumptions

## Documentation Self-Heal Actions

The following docs were updated during this pass:

- [14-master-local-brain-spec.md](/Users/evilone/Documents/Development/AI-Brain/ai-brain/brain-spec/local/14-master-local-brain-spec.md)
- [13-feature-preservation-matrix.md](/Users/evilone/Documents/Development/AI-Brain/ai-brain/brain-spec/local/13-feature-preservation-matrix.md)
- [implementation/NOTEBOOKLM-QUERIES.md](/Users/evilone/Documents/Development/AI-Brain/ai-brain/brain-spec/local/implementation/NOTEBOOKLM-QUERIES.md)

Main self-heal themes:

- make the target brain harder to misread as a simplified MVP
- make provenance more durable
- make graph extraction mandatory rather than optional
- make evaluation explicit
- make DB operator hygiene explicit

## Current Read

The local spec is now materially stronger than the previous pass.

It still does not claim that every extension is already proven on this machine.

What it now claims more clearly is:

- the full target behavior
- the safe current baseline
- the upgrade path
- the failure modes that must be engineered around

## Self-Rating

### Documentation quality after this pass

- clarity of the local target architecture: `9/10`
- honesty about implementation readiness: `9/10`
- protection against accidental feature loss: `9/10`
- confidence that the current local spec is the right build direction: `~93%`

### Why it is not higher yet

- extension bring-up on this actual Mac is still not fully proven
- retrieval and consolidation quality still need real data validation
- the relationship graph and TMT behavior still need runtime code, not only spec
