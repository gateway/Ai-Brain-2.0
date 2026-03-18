# Brain Architecture Research Prompt

Use this prompt with NotebookLM or another research assistant.

## Prompt

You are helping design an advanced local-first AI Brain 2.0 for 2026.

The goal is to define a practical architecture for a durable personal AI brain that can run on an Apple Silicon MacBook or Mac mini, starting at roughly M4-class hardware with 16 GB RAM minimum, and that can also be deployed on Supabase or plain hosted PostgreSQL without changing the core memory model.

The design must avoid vendor lock-in as much as possible.

This is not a generic chatbot memory system. It should behave more like a persistent cognitive substrate with multiple memory types, belief updates, temporal recall, and controlled forgetting.

Design the architecture as an opinionated build plan.

The system must support:

- episodic memory
- semantic memory
- procedural memory
- project memory
- personal memory
- skill and agent memory
- retrieval across people, places, time ranges, projects, instructions, and preferences
- questions like "Where was Steve in Japan in 2025?"
- questions like "What changed about my food preferences over the last month?"
- the ability to reason across notes, chats, markdown files, repos, documents, transcripts, and project instructions

The system should also handle memory change over time:

- if a user says they like spicy food, store that belief
- if the user later says they no longer like spicy food, update the active belief while preserving the historical record
- distinguish active beliefs from outdated beliefs
- support recency, importance, confidence, contradiction detection, and selective forgetting or decay

Please provide a structured outline that covers:

1. Hardware assumptions and realistic local constraints for Apple Silicon machines
2. Which parts should run fully locally versus which can optionally use remote APIs
3. The recommended database architecture
4. Whether PostgreSQL 18 should be the primary memory substrate
5. Which PostgreSQL extensions should be used
6. Whether `pgvector`, `pgvectorscale`, BM25, full-text search, graph-style relationships, and background job tooling should be included
7. A concrete memory model for episodic, semantic, procedural, project, and personal memory
8. How to store provenance, confidence, recency, and contradiction state
9. How to support temporal recall and questions over long time spans
10. Whether a temporal tree or hierarchical recall strategy should be used
11. The best retrieval architecture, including hybrid search, reranking, and temporal filtering
12. How to separate private personal data from project data while still allowing controlled cross-query reasoning
13. How to ingest markdown files, notes, repos, chats, web pages, PDFs, transcripts, and local documents
14. How to represent skills, tools, and agent instructions as procedural memory
15. How background consolidation, promotion, deduplication, and forgetting should work
16. Security, privacy, and local-first design requirements
17. How to avoid vendor lock-in in models, embeddings, database choices, and orchestration
18. What the MVP should be
19. What an advanced V2 should be
20. What the biggest architectural risks are

Also include:

- a recommended component stack
- a recommended schema outline
- a recommended ingestion and consolidation pipeline
- a migration path between local deployment and hosted PostgreSQL or Supabase
- explicit tradeoffs, not just benefits

Be concrete. Do not give a generic essay. Give a buildable outline with named components, data flows, and implementation recommendations.
