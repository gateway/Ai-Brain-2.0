# NotebookLM Slide Deck Prompt

Create a slide deck for the project:

- `AI Brain 2.0`
- local-first full brain on an Apple Silicon Mac

Audience:

- founder / architect
- technical collaborators
- future implementation partners

Goal:

- explain the full local Brain 2.0 architecture clearly
- make it obvious this is not a basic RAG app
- show the hierarchy, phases, and engineering rationale
- present the target local architecture first
- include a short note that a hosted Supabase path exists, but do not make the
  deck about Supabase

Deck style:

- technical but visually clear
- concise text per slide
- architecture-first
- implementation-aware
- include diagrams, flows, and decision framing where helpful

Required sections:

1. Vision
2. Why this is not basic RAG
3. Core design rules
4. Full local stack:
   - PostgreSQL 18
   - TimescaleDB hypertables
   - pgvector
   - pgvectorscale
   - pgai
   - BM25 lexical retrieval
   - SQL RRF
   - MCP
5. System hierarchy:
   - raw artifacts
   - ingestion
   - episodic memory
   - semantic memory
   - procedural state
   - relationship memory
   - temporal hierarchy / TMT
   - retrieval
   - consolidation
   - forgetting
   - interface layer
6. Ingestion and provenance:
   - chat
   - voice
   - markdown
   - PDFs
   - images
   - project files
   - source-of-truth artifact pointers
7. Query flow:
   - how the AI queries the brain
   - timeline queries
   - relationship queries
   - evidence citation
   - token-burn control
8. Temporal memory:
   - day, week, month summaries
   - TMT zoom-in behavior
   - example query:
     - "What was I doing in Japan in 2005, and who was I with?"
9. Conflict resolution:
   - active truth vs historical truth
   - recency wins
   - superseded memories
10. Build phases
11. Major risks and what must be validated first
12. Short closing slide on why local-first matters

Important framing:

- preserve raw artifacts outside the DB
- every durable memory row should point back to evidence
- retrieval should be hybrid, not vector-only
- time and relationships are first-class
- the reasoning model is replaceable; the brain is not

Important accuracy note:

- do not present `io_uring` as the default Mac configuration
- if PostgreSQL 18 AIO is mentioned for macOS, describe it carefully and avoid
  Linux-specific assumptions
