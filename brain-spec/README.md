# Brain Spec

This folder is the working engineering spec for the AI Brain.

Primary documents:

- `00-system-overview.md`
- `01-hierarchy-and-sections.md`
- `02-build-phases.md`
- `03-ingestion-query-retrieval.md`
- `04-memory-lifecycle-conflicts-summaries.md`
- `05-deployment-paths-local-vs-supabase.md`

Design stance:

- build the full smart brain, not a basic RAG app
- preserve raw artifacts as source of truth
- use PostgreSQL as the brain substrate
- prefer local-first, but keep a hosted path available
- use external research as a sanity-check, not as unquestioned truth

Cross-check highlights:

- research strongly supports the tripartite memory model, hybrid retrieval,
  provenance, temporal hierarchy, and consolidation loops
- local Mac target should keep `pgvector`, `pgvectorscale`, `pgai`,
  Timescale hypertables, BM25, RRF, relationships, TMT, and MCP
- on macOS, PostgreSQL 18 AIO should be treated as `io_method = worker`, not
  `io_uring`
- raw transcripts, markdown, audio, PDFs, and imported artifacts should remain
  durable outside the DB
