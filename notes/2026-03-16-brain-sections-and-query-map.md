# Brain Sections and Query Map

## Purpose

Before asking NotebookLM for another full architecture answer, break the brain
down into concrete sections.

This keeps the research focused and prevents the next prompt from collapsing
into generic "AI brain" language.

## Guiding Principle

Do not think in terms of `V2` as a distant fantasy system.

Think in terms of:

- build the first real version
- test it
- break it
- learn from the failures
- rebuild from the evidence

That means each section below should be researched as a practical subsystem.

## Section 1: Ingestion

### What this section answers

- what counts as a memory input
- how memory enters the system
- what is stored raw vs transformed
- which ingestion paths exist in the first build

### Input types to evaluate

- direct chat message
- markdown file
- note file
- project file
- PDF
- webpage
- transcript
- image
- audio or video summary
- LLM-generated reflection or extracted memory candidate

### Important design question

Not every input should become a durable memory automatically.

We need to decide:

- what gets stored as raw episode
- what gets promoted into semantic memory
- what gets turned into procedural state
- whether agent-generated memories are allowed by default or must be reviewed

### Candidate technologies

- local watcher for markdown or folder changes
- CLI capture
- MCP write tool
- chat capture endpoint
- file parser and chunker
- transcript pipeline

## Section 2: Memory Model

### What this section answers

- what the memory layers are
- what each layer stores
- what is mutable vs immutable
- how active truth differs from historical record

### Core sub-sections

- episodic memory
- semantic memory
- procedural memory
- namespace or domain memory
- relationship memory

### Questions to answer

- what belongs in episodic only
- what gets abstracted into semantic memory
- what is authoritative procedural state
- how skills and agent instructions are represented

## Section 3: Retrieval

### What this section answers

- how the system finds the right memory
- how exact facts and semantic meaning are combined
- how time and namespace affect retrieval

### Terms that need clear understanding

- RAG
- hybrid retrieval
- BM25
- vector search
- RRF
- reranking
- temporal retrieval
- top-k retrieval

### Questions to answer

- what is the minimum retrieval stack for the first build
- what retrieval path is used for personal factual queries
- what retrieval path is used for project spec queries
- how should temporal filtering work

## Section 4: Consolidation and Memory Change

### What this section answers

- how memory evolves
- how contradictions are handled
- how stale knowledge is marked
- how the system avoids becoming a giant append-only mess

### Questions to answer

- when does consolidation run
- what is deduplicated
- what gets merged
- how does "recency wins" work
- how is historical truth preserved
- when does a semantic memory become invalid or superseded

### Example behavior

- user once liked spicy food
- user later says they do not like spicy food
- old claim remains part of history
- new claim becomes active state

## Section 5: Temporal Memory

### What this section answers

- how the system handles time-based queries
- whether timestamps are enough for the first build
- when hierarchical temporal structures are worth adding

### Questions to answer

- do we need simple timestamp filters first
- do we need a Temporal Memory Tree immediately
- what is the simplest way to answer:
  - `Where was Steve in Japan in 2025?`

## Section 6: Multimodal Memory

### What this section answers

- whether images, PDFs, audio, and video should be first-class memory inputs
- what belongs in the first build vs later

### Questions to answer

- is text-only enough to validate the architecture
- when do multimodal embeddings become worth the complexity
- should PDFs be parsed as text first
- should images remain references until retrieval proves the need for embedding

## Section 7: Interfaces and Agent Access

### What this section answers

- how humans and agents interact with the brain
- what the write and read surfaces are
- how Open Brain 1.0 and future Open Claw style systems fit in

### Candidate interfaces

- markdown files
- local CLI
- local app or chat window
- MCP tools
- API
- repo or workspace sync

### Questions to answer

- what should be the primary human interface
- what should be the primary agent interface
- what does Open Brain already solve here
- where is Open Brain too basic for the memory model we want

## Section 8: Hosting and Deployment

### What this section answers

- what runs locally
- what can run on Supabase during testing
- what remains portable between both

### Deployment modes to compare

- local MacBook or Mac mini
- Supabase prototype
- hybrid mode

### Questions to answer

- which technologies work in both environments
- which extensions are required
- what is hard to port later
- how to avoid cloud lock-in

## Section 9: Security and Boundaries

### What this section answers

- how personal memory is protected
- how project memory is isolated
- how tool permissions are scoped

### Questions to answer

- how do namespaces work
- when do we need RLS
- what should agents be allowed to read
- what should agents be allowed to write

## Section 10: Performance and Speed

### What this section answers

- what performance claims actually matter
- what is benchmark hype vs useful engineering
- what matters on a local Mac

### Topics to evaluate

- pgvector vs pgvectorscale
- HNSW vs DiskANN
- in-memory vs SSD-backed behavior
- local retrieval latency
- hybrid search cost
- consolidation job cost

### Important framing

The question is not:

- what is the biggest benchmark number

The real questions are:

- what is fast enough for a personal brain
- what fits on a Mac with 16 GB or more RAM
- what reduces complexity while preserving capability

## Section 11: Evaluation and Failure Modes

### What this section answers

- how we know the system is working
- how we know the system is failing
- what to test before adding complexity

### Questions to answer

- does it answer temporal queries correctly
- does it preserve history correctly
- does it update active beliefs correctly
- does it return exact project instructions without hallucination
- does it stay usable without huge token burn

## Best Next Query Strategy

Instead of one giant notebook question, ask one section at a time.

Recommended order:

1. Ingestion
2. Memory model
3. Retrieval
4. Consolidation and contradiction handling
5. Temporal memory
6. Hosting and portability
7. Performance and extension choices

## Immediate Follow-Up

We still need the Open Brain or Open Claw URL from the user so we can compare:

- what Open Brain 1.0 is actually doing
- what memory it has today
- what its limits are
- what we are changing in our first build
