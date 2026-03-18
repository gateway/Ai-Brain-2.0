# Build Phases

## Philosophy

We are not shrinking the architecture.

We are sequencing the implementation so the full brain can be built in a sane
order.

## Phase 0: Foundations

### What this phase does

Sets up the project structure and basic operational assumptions.

### Deliverables

- artifact folder conventions
- brain schema package
- provider abstraction for embeddings and AI cleanup
- configuration file format
- namespace strategy

### Benefits

- removes ambiguity early

### Risks

- if skipped, the rest becomes inconsistent

## Phase 1: Local Substrate

### What this phase does

Brings up the local database stack.

### Deliverables

- PostgreSQL 18
- TimescaleDB
- `pgvector`
- `pgvectorscale`
- `pgai`
- initial BM25 path

### Benefits

- proves the Mac can host the core substrate

### Risks

- extension packaging may be the first major blocker

## Phase 2: Artifact Registry And Ingestion

### What this phase does

Makes the brain capable of receiving data.

### Deliverables

- artifact registry tables
- ingestion worker
- markdown import
- transcript import
- PDF text extraction
- source-provenance pointers

### Benefits

- gives the brain durable evidence and re-indexability

### Risks

- parsing quality varies by source type

## Phase 3: Episodic Memory

### What this phase does

Builds the append-only event timeline.

### Deliverables

- episodic hypertables
- chunking rules
- time indexes
- session and namespace structure

### Benefits

- supports timeline reconstruction

### Risks

- table growth must be planned from the start

## Phase 4: Semantic And Procedural Memory

### What this phase does

Adds concept memory and active truth.

### Deliverables

- semantic memory tables
- vector indexes
- procedural state tables
- preference and project-state tables

### Benefits

- first true "brain" behavior starts here

### Risks

- schema drift between semantic and procedural layers

## Phase 5: Hybrid Retrieval

### What this phase does

Builds the retrieval engine that the AI actually uses.

### Deliverables

- lexical retrieval
- vector retrieval
- SQL RRF
- metadata filters
- time filters
- namespace filters

### Benefits

- enables useful recall with lower token burn

### Risks

- ranking needs empirical tuning

## Phase 6: Entity And Relationship Layer

### What this phase does

Adds structured relationships across memories.

### Deliverables

- entity tables
- alias resolution
- mention extraction
- relationship joins

### Benefits

- allows relationship-heavy questions

### Risks

- entity extraction and dedupe complexity

## Phase 7: Consolidation And Conflict Resolution

### What this phase does

Turns raw history into coherent long-term memory.

### Deliverables

- candidate-memory queue
- consolidation worker
- contradiction adjudicator
- supersession links
- active-truth updates

### Benefits

- prevents memory junk-drawer behavior

### Risks

- bad adjudication rules can corrupt current truth

## Phase 8: Temporal Hierarchy And Summaries

### What this phase does

Builds daily, weekly, and monthly intelligence.

### Deliverables

- day summaries
- week summaries
- month or profile summaries
- temporal parent-child links
- TMT traversal logic

### Benefits

- scales recall across long time windows

### Risks

- summary drift
- over-aggressive compression

## Phase 9: Forgetting And Memory Temperature

### What this phase does

Introduces smart pruning and compression.

### Deliverables

- importance scoring
- anchor rules
- decay rules
- hot/warm/cold tiers

### Benefits

- performance stability
- lower token burn

### Risks

- important abstractions may decay too quickly

## Phase 10: MCP And User Interfaces

### What this phase does

Makes the brain usable from chat, voice, and other tools.

### Deliverables

- MCP server
- query tools
- timeline tools
- artifact lookup tools
- relationship tools

### Benefits

- usable across Claude, ChatGPT, Cursor, or custom clients

### Risks

- tool contract complexity

## Phase 11: Hosted Path

### What this phase does

Creates the Supabase or hosted deployment variant.

### Deliverables

- hosted schema adaptations
- Edge Functions
- remote workers
- remote MCP bridge

### Benefits

- remote access
- easier sharing and operations

### Risks

- weaker extension parity than local

## Phase 12: Evaluation And Rebuild Loop

### What this phase does

Measures where the brain succeeds and fails.

### Deliverables

- recall test set
- timeline query benchmarks
- preference-change regression tests
- token burn reports
- latency reports

### Benefits

- prevents self-deception

### Risks

- without this phase, architecture claims remain unproven
