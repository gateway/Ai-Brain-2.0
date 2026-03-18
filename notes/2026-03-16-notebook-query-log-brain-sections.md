# NotebookLM Query Log: Brain Sections

Notebook:

- `The Digital Brain`
- notebook id: `3fd8e35e-5115-4fb4-a81c-b28b69db002a`

## Query 1: Memory model

Question focus:

- define episodic, semantic, and procedural memory for the first build

Answer signal:

- episodic should be append-only and answer historical questions
- semantic should hold distilled facts and stable patterns
- procedural should hold current truth, project state, and agent skills
- contradiction handling should preserve history while updating active truth

## Query 2: Retrieval

Question focus:

- define the retrieval layer using PostgreSQL only

Answer signal:

- hybrid retrieval is the correct default
- use lexical search for exact terms
- use vector search for conceptual recall
- use reciprocal rank fusion to merge the ranked lists
- use metadata and timestamp filters
- Temporal Memory Tree is not required in the first build

## Query 3: Local Mac runtime

Question focus:

- define what must run locally on an Apple Silicon Mac

Answer signal:

- PostgreSQL 18 is the core substrate
- tripartite memory remains the model
- raw artifacts stay on disk
- ingestion worker, MCP server, and consolidation loop are required
- notebook answers strongly favored `pgvectorscale` and ParadeDB, but those
  were later narrowed by external verification

## Query 4: Supabase mapping

Question focus:

- map the same architecture into a hosted Supabase deployment

Answer signal:

- keep the schema and memory model the same
- keep retrieval logic in SQL where possible
- use Edge Functions for ingest and hosted APIs
- use RLS for namespace isolation
- keep the MCP surface stable between local and hosted deployments

## Query 5: Ingestion and provenance

Question focus:

- define how transcripts, markdown, PDFs, and project notes should be ingested

Answer signal:

- canonical source artifacts should remain outside the memory tables
- ingest atomic fragments rather than whole documents
- attach provenance for every fragment
- stage agent-generated memory candidates before promoting them

## Query 6: Consolidation and belief updates

Question focus:

- define deduplication, contradiction handling, and forgetting

Answer signal:

- use a two-phase flow:
  - session-time extraction
  - asynchronous consolidation
- deduplicate semantically
- update active truth by recency
- never erase historical evidence
- session-specific noise should not automatically become long-term memory

## Most Important Result

The notebook is directionally strongest on:

- tripartite memory
- hybrid retrieval
- provenance
- consolidation
- MCP

The notebook is less reliable on:

- multimodal Gemini embeddings as a current production assumption
- assuming the same extension stack exists cleanly in Supabase
- pushing temporal hierarchies too early
