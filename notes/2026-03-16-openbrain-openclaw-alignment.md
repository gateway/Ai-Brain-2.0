# Open Brain and OpenClaw Alignment

## Sources

- OpenClaw repository:
  - https://github.com/openclaw/openclaw
- Open Brain guide:
  - https://promptkit.natebjones.com/20260224_uq1_guide_main
- Gemini embeddings documentation:
  - https://ai.google.dev/gemini-api/docs/embeddings

## Why These Matter

We are not designing the brain in a vacuum.

We are trying to understand:

- what Open Brain 1.0 is actually doing well
- where Open Brain is too basic for the memory model we want
- how OpenClaw thinks about channels, sessions, tools, workspace, and memory
- how Gemini Embedding 2 might change the multimodal ingestion path

## What Open Brain 1.0 Actually Is

The Open Brain guide is not a full cognitive architecture.

Its current shape is:

- capture interface:
  - Slack
- logic:
  - Edge Functions
- database:
  - Supabase / PostgreSQL
- retrieval:
  - semantic search
- connection pattern:
  - MCP

High-value takeaway:

- it is a strong `capture + retrieval` starter system
- it is not yet a full multi-layer brain

Important details from the guide:

- the build path is `Slack -> Edge Function -> Supabase`
- retrieval is exposed to AI tools through an MCP server
- the baseline cost model uses `text-embedding-3-small` for embeddings
- metadata extraction is done with `gpt-4o-mini`

## What OpenClaw Adds

OpenClaw is not primarily a brain database.

It is a local-first assistant runtime and gateway with:

- many channel integrations
- local workspace and skill structure
- session tools
- MCP bridge support
- pluggable memory

Important current signals:

- OpenClaw is designed as a personal assistant that runs on your own devices
- it exposes a local workspace model
- it includes session history tools for transcript retrieval
- memory is treated as a plugin slot, and only one memory plugin is active at a time
- MCP support is intentionally decoupled from core runtime

Why this matters:

- OpenClaw is a strong candidate for the `assistant and orchestration shell`
- our Brain 2.0 is likely the `memory substrate` that could sit behind it

## New Hard Requirement: Durable Transcript Source of Truth

This is now one of the most important design constraints.

The database is not the only source of truth.

We want a durable file-level source of truth for raw transcripts and raw notes:

- markdown conversations
- dictation transcripts
- audio transcript outputs
- imported notes

Desired pattern:

- raw source artifact lives on disk
- database stores:
  - normalized memory entries
  - embeddings
  - metadata
  - links back to the original raw file

This means:

- never lose transcripts
- never reduce the system to embedding-only memory
- the database is the machine memory layer
- the file system preserves raw historical evidence

## Recommended Split

### File System Layer

Use the local file system for raw evidence:

- markdown files
- transcript files
- raw note captures
- imported documents
- audio files where needed

### Database Layer

Use PostgreSQL for:

- episodic records
- semantic abstractions
- procedural state
- retrieval indexes
- namespace boundaries
- relationship links
- provenance back to source files

## What Gemini Embedding 2 Changes

Gemini Embedding 2 is relevant because it supports:

- text
- image
- video
- audio
- PDF

And it places those inputs into a unified embedding space.

That matters for:

- screenshots
- whiteboards
- PDFs
- voice note related artifacts
- multimodal project materials

But this does not mean it belongs everywhere on day one.

Practical interpretation:

- text-first with durable transcript capture is still the safest first build
- Gemini Embedding 2 becomes important when multimodal retrieval is genuinely
  needed, not just because it exists

## Working Interpretation

The likely architecture direction is now clearer:

- Open Brain gives us a simple ingest and retrieval baseline
- OpenClaw gives us a local-first assistant shell and session model
- our Brain 2.0 should become the durable PostgreSQL memory substrate
- raw transcripts and markdown files must remain preserved on disk
- the database must always reference the raw source artifact

## Immediate Research Focus

The next notebook question should focus on ingestion and provenance:

- what should be captured as raw durable files
- what should be transformed into episodic memory rows
- what should be promoted into semantic or procedural memory
- how file references and transcript references should be modeled in PostgreSQL
