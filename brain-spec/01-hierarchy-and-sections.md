# Hierarchy And Sections

## Section Template

Each section below defines:

- what it does
- how it works
- why it exists
- benefits
- tradeoffs

## 1. Raw Artifact Layer

### What it does

Stores the durable source-of-truth files.

Examples:

- markdown files
- chat exports
- audio recordings
- speech transcripts
- PDFs
- screenshots
- project files

### How it works

Artifacts live in a filesystem or object-storage structure and are registered in
the database.

Suggested metadata:

- `artifact_id`
- `artifact_type`
- `uri`
- `checksum`
- `mime_type`
- `created_at`
- `source_channel`
- `owner_namespace`

### Why it exists

- prevents memory collapse if the DB is corrupted
- enables provenance
- allows re-processing with better models later

### Benefits

- durable evidence
- reproducibility
- lower lock-in

### Tradeoffs

- more storage to manage
- more ingestion plumbing

## 2. Ingestion And Normalization

### What it does

Converts artifacts and live inputs into structured memory candidates.

### How it works

Pipeline:

1. detect input
2. extract text
3. split into atomic fragments
4. attach metadata
5. generate embeddings
6. classify candidate type
7. insert into episodic memory
8. stage semantic or procedural candidates

### Why it exists

- the brain is only as good as its ingestion
- whole-document storage causes context poisoning

### Benefits

- precise retrieval
- lower token burn
- cleaner summaries

### Tradeoffs

- more preprocessing work
- fragment boundaries matter

## 3. Episodic Memory

### What it does

Stores immutable event history.

### How it works

Use append-only rows with timestamps and provenance links.

Good fields:

- `id`
- `namespace_id`
- `session_id`
- `role`
- `content`
- `occurred_at`
- `captured_at`
- `artifact_id`
- `source_offset`
- `metadata`

### Why it exists

- supports time-travel queries
- preserves the audit trail
- keeps raw reality separate from summaries

### Benefits

- historical integrity
- evidence for later reasoning

### Tradeoffs

- grows quickly
- requires summarization and chunk pruning logic

## 4. Semantic Memory

### What it does

Stores distilled facts and reusable concepts.

### How it works

Semantic rows are derived from episodic evidence and linked back to it.

Good fields:

- `id`
- `namespace_id`
- `content_abstract`
- `embedding`
- `importance_score`
- `valid_from`
- `valid_until`
- `is_anchor`
- `derived_from_ids`
- `metadata`

### Why it exists

- enables concept-level recall
- captures stable patterns without dragging entire transcripts into context

### Benefits

- better semantic search
- lower retrieval payload

### Tradeoffs

- requires consolidation
- can drift if not anchored to provenance

## 5. Procedural State

### What it does

Stores mutable current truth.

Examples:

- active preferences
- project specs
- agent skills
- runbooks
- tool configs

### How it works

Use relational tables and JSONB where flexibility is useful.

### Why it exists

- current truth should not be reconstructed from raw history every time

### Benefits

- fast current-state queries
- clear override behavior

### Tradeoffs

- must be updated carefully
- can drift from history if consolidation is weak

## 6. Relationship Memory

### What it does

Stores entities and links between them.

### How it works

Use relational tables:

- `entities`
- `entity_aliases`
- `memory_entity_mentions`
- `entity_relationships`

Entity types:

- person
- place
- project
- organization
- artifact
- skill

### Why it exists

- vector search alone is not enough to answer relationship-heavy questions

### Benefits

- better "who/where/with whom" answers
- stronger joins across memory layers

### Tradeoffs

- entity resolution is hard
- aliases and duplicates require cleanup

## 7. Temporal Hierarchy

### What it does

Organizes memory across long horizons.

### How it works

Use Temporal Memory Tree logic:

- segment
- session
- day
- week
- month or profile
- optionally year

Store parent-child links and summary nodes.

### Why it exists

- answers year-scale questions efficiently
- reduces retrieval payload
- keeps time as a first-class dimension

### Benefits

- scalable long-term recall
- better timeline reconstruction

### Tradeoffs

- more complex background jobs
- summary quality matters

## 8. Retrieval Engine

### What it does

Finds the most relevant evidence for a query.

### How it works

Combine:

- BM25 / lexical retrieval
- vector similarity
- metadata filters
- relationship filters
- time filters
- RRF fusion

### Why it exists

- exact names and dates matter
- semantic meaning matters
- neither retrieval method alone is enough

### Benefits

- high precision
- better recall quality

### Tradeoffs

- more moving parts
- ranking must be tuned

## 9. Consolidation Layer

### What it does

Promotes useful memory and resolves contradictions.

### How it works

For each candidate:

1. retrieve similar memory
2. compare meaning
3. classify action:
   - `ADD`
   - `UPDATE`
   - `SUPERSEDE`
   - `IGNORE`
4. write the result

### Why it exists

- avoids memory bloat
- keeps current truth coherent

### Benefits

- cleaner long-term memory
- better preference management

### Tradeoffs

- requires good prompts or rules
- false merges can be damaging

## 10. Forgetting And Compression

### What it does

Prevents the brain from retaining low-value derived clutter forever.

### How it works

Use:

- importance scores
- anchor flags
- hot/warm/cold tiers
- access frequency
- semantic decay

### Why it exists

- keeps performance bounded
- lowers token burn

### Benefits

- more stable retrieval quality
- better storage discipline

### Tradeoffs

- poorly tuned decay can remove useful abstractions

## 11. Interface Layer

### What it does

Exposes the brain to external clients and models.

### How it works

Use MCP tools such as:

- `memory.search`
- `memory.timeline`
- `memory.get_artifact`
- `memory.get_relationships`
- `memory.save_candidate`
- `memory.upsert_state`

### Why it exists

- separates the reasoning model from the memory substrate
- keeps the system provider-agnostic

### Benefits

- reusable across clients
- easier tool governance

### Tradeoffs

- requires clear contracts

## 12. Reasoning Layer

### What it does

Uses the retrieved context to plan, answer, and act.

### How it works

The reasoning engine should:

- decide what to query
- gather minimal relevant context
- answer with citations
- optionally write new candidates back

### Why it exists

- memory alone does not produce intelligence

### Benefits

- coherent user-facing behavior

### Tradeoffs

- strong reasoning still depends on model quality
