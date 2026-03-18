# Local Implementation Artifacts

This folder contains the first concrete local implementation artifacts derived
from the local brain spec.

Contents:

- `NOTEBOOKLM-QUERIES.md`
- `migrations/`
- `contracts/`
- `jobs/`

Guiding rule:

- use implementation-safe PostgreSQL and contract shapes first
- keep explicit upgrade hooks for the richer local target stack

Why this matters:

- the architecture wants `pgvectorscale`, `pgai`, TimescaleDB, TMT, and strong
  lexical retrieval
- the concrete artifacts should be able to start from stable primitives and
  evolve upward without rewriting the entire model

Do not read the current baseline artifacts as feature reduction.

Read them as:

- an implementation-safe starting point

The preserved target behavior is documented in:

- [13-feature-preservation-matrix.md](/Users/evilone/Documents/Development/AI-Brain/ai-brain/brain-spec/local/13-feature-preservation-matrix.md)
