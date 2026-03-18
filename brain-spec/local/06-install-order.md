# Local Install Order

## Goal

Bring up the local brain substrate in the least fragile order.

## Recommended Order

1. PostgreSQL 18
2. TimescaleDB
3. `pgvector`
4. `pgvectorscale`
5. `pgai`
6. lexical retrieval path
7. application config
8. migration runner

## Step 1: PostgreSQL 18

### Why first

- everything else depends on the base server
- configuration behavior should be known before extensions are added

### Validate

- server starts cleanly
- `uuidv7()` support path is clear
- macOS config is stable

### Important Mac note

- treat PostgreSQL 18 AIO carefully on macOS
- do not assume Linux-specific `io_uring`

## Step 2: TimescaleDB

### Why second

- episodic hypertables are part of the design, not an afterthought

### Validate

- extension installs cleanly
- hypertable creation works
- compression policy behavior is understood

## Step 3: pgvector

### Why third

- core vector type and operators are foundational

### Validate

- extension loads
- vector columns work
- cosine or inner-product operators behave as expected

## Step 4: pgvectorscale

### Why fourth

- depends on the vector layer conceptually
- should be tested after `pgvector` is stable

### Validate

- extension loads
- DiskANN index creation works
- build-time memory settings are documented
- filtered search behavior is understood

## Step 5: pgai

### Why fifth

- install after the core vector stack is stable
- vectorizer workflows should build on known-good tables

### Validate

- extension or worker requirements are clear
- vectorizer patterns are understood
- embedding synchronization can be introduced incrementally

## Step 6: Lexical Retrieval Path

### Why sixth

- exact-match retrieval is required for names, dates, and terms

### Bring-up rule

Start with the strongest path that is operationally clean.

If BM25 packaging is not ready immediately:

- use native PostgreSQL full-text search first
- preserve the richer lexical target as a follow-on

## Step 7: Application Config

### What to define

- namespaces
- artifact folders
- provider adapters
- worker config
- MCP config

## Step 8: Migration Runner

### Why last in bring-up

- once the substrate is stable, create the schema in a reproducible way

## Definition Of Success

The install layer is complete when:

- all chosen components start cleanly
- migrations can run
- a sample artifact can be ingested
- vector and lexical retrieval both work
