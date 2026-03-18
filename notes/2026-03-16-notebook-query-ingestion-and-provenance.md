# Notebook Query: Ingestion and Provenance

## Purpose

This is the next focused NotebookLM query to ask before moving into schema
design.

It is intentionally narrower than a full architecture prompt.

## Prompt

Using the selected sources, define the ingestion and provenance architecture for
our Brain 2.0.

Context:

- We want to build a local-first AI brain for Apple Silicon Macs, with optional
  Supabase use during testing or transition.
- PostgreSQL must remain the core memory substrate.
- We want to avoid multi-database sprawl and vendor lock-in.
- Open Brain 1.0 is useful as a baseline, but it is too simple for the memory
  model we want.
- OpenClaw is relevant as a local-first assistant shell, channel runtime, and
  session/transcript environment.

New hard requirement:

- We never want to lose transcripts.
- Raw transcripts, markdown notes, and other captured source material must
  remain preserved on disk as durable source-of-truth artifacts.
- The database must store memory entries and references back to the original raw
  files.

We expect inputs from:

- direct chat
- markdown files
- local notes
- project repositories
- audio dictation
- audio transcripts
- PDFs
- web pages
- images
- optional video transcripts
- agent-generated memory candidates

Answer as a practical engineering design, not a generic essay.

Please structure the answer into these sections:

1. What should count as a raw source artifact
2. What should live on disk versus what should live in PostgreSQL
3. What the canonical source of truth should be for transcripts, markdown, and imported documents
4. How ingestion should differ for chat, markdown, dictation, transcript files, PDFs, web pages, and images
5. Whether agent-generated memory candidates should be stored automatically, reviewed, or treated differently
6. How to model provenance and references back to original files
7. A recommended PostgreSQL schema for source artifacts, episodic captures, extracted memory candidates, and promoted memories
8. How Open Brain 1.0 handles ingestion today and where that is too limited
9. How OpenClaw session or transcript concepts should influence the design
10. Whether Gemini Embedding 2 should be used in MVP for images and PDFs, or deferred until later
11. What the minimum viable ingestion pipeline should be for the first build
12. Biggest failure modes to avoid

Additional constraints:

- Prefer boring, durable engineering over complexity.
- Do not assume every input deserves semantic promotion.
- Preserve raw historical evidence.
- Make explicit recommendations for what should be append-only versus mutable.
- Call out anything that seems speculative or over-engineered.
