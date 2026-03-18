# Artifact Synthesis: The Digital Brain

## Scope

This note is a first-pass synthesis of the local NotebookLM artifact mirror for
`The Digital Brain`.

Most important artifacts reviewed:

- `Open Brain 2.0 Architecture`
- `Architecting Open Brain 2.0`
- `The Multimodal Substrate`
- `The Cognitive Substrate`

The slides are not perfectly consistent with one another, so the goal here is
to extract the stable architecture signal rather than treat any single deck as
canonical.

## The Common Signal

Across the decks, the architecture repeatedly converges on this shape:

### 1. PostgreSQL is the memory substrate

The brain should not be a pile of markdown files, a flat vector store, or a
multi-database sprawl.

The consistent recommendation is:

- PostgreSQL as the single durable substrate
- vector search inside Postgres
- relational state inside Postgres
- time-series or partitioned episodic memory inside Postgres
- one query surface and one source of truth

### 2. Memory must be split into three layers

The strongest recurring concept is a tripartite memory model:

- `episodic`
  - immutable, timestamped event logs
  - supports temporal recall and auditability
- `semantic`
  - extracted facts, concepts, embeddings, relationships
  - supports meaning-based recall
- `procedural`
  - current preferences, rules, instructions, operative state
  - authoritative for agent behavior

This is one of the clearest stable ideas across the entire corpus.

### 3. Retrieval must be hybrid, not vector-only

The decks strongly reject pure semantic retrieval as the whole solution.

Repeated pattern:

- lexical or BM25 search for exact terms
- vector search for conceptual similarity
- `RRF` to fuse the ranking results

This is presented as the way to avoid the precision ceiling of vector-only
search.

### 4. Time matters structurally

The architecture wants more than timestamps on rows.

The repeated direction is:

- episodic logs must preserve chronology
- temporal filtering should be part of recall
- long-term memory should be organized hierarchically
- `Temporal Memory Trees` or similar temporal abstractions help answer
  long-horizon questions without flooding context

### 5. The brain should be multimodal

Several decks argue that a 2026 brain should not remain text-only.

Expected modalities:

- text
- images
- PDFs
- audio
- video

The stable idea is a unified semantic layer across modalities, even if the
exact embedding provider changes later.

### 6. The brain needs active consolidation

The system should not just append and search forever.

Repeated consolidation ideas:

- cluster similar memories
- detect conflicts
- demote stale claims
- keep historical evidence
- update active beliefs
- use links like `superseded_by` or temporal validity fields

This directly matches the requirement that a user can change a preference and
the system should update the current belief without losing history.

### 7. Open protocol access matters

The decks repeatedly use `MCP` as the open interface between agents and the
memory substrate.

Stable role of MCP:

- agent does not ingest the whole database
- agent calls targeted retrieval tools
- the brain stays as shared infrastructure instead of a vendor-specific feature

### 8. Separation of domains is required

The architecture consistently points toward logical separation between:

- personal memory
- work or project memory
- other contexts

Mechanisms mentioned:

- `RLS`
- namespaces
- `context_id`
- explicit containment constraints in retrieval

## The Most Important Contradictions

These artifacts are directionally aligned, but they are not fully coherent.

### 1. Local-first vs Supabase-first

Some decks are clearly framed as:

- `Supabase + Edge Functions + Slack + MCP`

Others shift to:

- local Apple Silicon
- local Postgres
- local inference
- zero data retention

Interpretation:

- Supabase is being used as an implementation path or transitional hosted path
- local-first is the more complete sovereignty end state

### 2. Model stack inconsistency

The decks mention combinations of:

- Gemini embeddings
- Gemini Flash
- OpenAI
- OpenRouter
- Ollama
- `llama.cpp`

Interpretation:

- the memory architecture is more stable than the model choice
- model providers should remain replaceable
- this strengthens the vendor-lock avoidance requirement

### 3. Indexing inconsistency

Different decks mention:

- `HNSW`
- `DiskANN`
- `StreamingDiskANN`

Interpretation:

- the stable principle is approximate nearest-neighbor search inside Postgres
- the exact index strategy should depend on scale and local hardware limits
- for a local Mac-first design, DiskANN-style approaches appear more aligned
  with the artifact direction than HNSW-only

### 4. Interface inconsistency

Different decks assume different capture interfaces:

- Slack
- markdown
- MCP-first retrieval
- direct API ingest

Interpretation:

- these are front doors, not the core architecture
- the durable substrate matters more than the capture interface

## Current Best Reading Of The Architecture

If we compress the strongest common signal down to one draft architecture, it
looks like this:

- local-first PostgreSQL brain
- one unified substrate for relational, temporal, and vector memory
- tripartite memory model
- hybrid retrieval with lexical + vector + RRF
- multimodal ingestion
- temporal recall and memory hierarchies
- procedural state as authoritative behavior memory
- consolidation loop for contradiction handling and belief revision
- MCP as the open retrieval and action interface
- optional hosted deployment path through Supabase without changing the core
  schema model

## Working Conclusion

The artifacts do not yet define a perfect final architecture, but they are
strongly converging on a real pattern:

- `markdown` is useful as a human interface
- `PostgreSQL` is the machine memory substrate
- `MCP` is the agent connection layer
- `tripartite memory + hybrid retrieval + consolidation` is the core of the
  actual brain

## What To Do Next

The next design step should be:

- turn this artifact synthesis into a concrete system blueprint
- decide what must be local in MVP
- decide what can remain optionally hosted
- define the schema for episodic, semantic, and procedural memory
- define the consolidation and contradiction-resolution rules
