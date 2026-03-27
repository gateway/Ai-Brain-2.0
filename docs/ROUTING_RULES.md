# Routing Rules

The ingestion worker must route every fragment into deterministic buckets before
promotion. The model may suggest classifications, but it does not own truth.

## Always

- Register the raw artifact and observation.
- Split into 1 to 3 sentence fragments.
- Write immutable evidence into `episodic_memory`.
- Keep provenance pointers to artifact, chunk, and offsets.

## Relationship Routing

Route into `relationship_candidates` when the fragment expresses:

- social links
- co-participation
- place containment
- work or org relationships
- project ownership or membership
- residence or travel history

Promotion target:

- `relationship_memory` once adjudication accepts the candidate

## Procedural Routing

Route into `memory_candidates` and then `procedural_memory` for active truth:

- current residence
- active employer or affiliation
- active project
- active role
- active preference
- active watchlist or commitment

Rules:

- current truth must supersede prior active truth
- historical facts remain in graph or episodic layers
- mutable state must include `valid_from` and `valid_until`

## Semantic Routing

Route into `semantic_memory` for compacted or repeated patterns:

- repeated preferences
- stable summaries
- enduring identity facts
- watchlist or media preferences that benefit from abstraction

Rules:

- semantic summaries are derived
- semantic summaries may decay
- raw source evidence does not decay

## Ambiguity Routing

Route to inbox instead of promotion when:

- entity identity is unclear
- two active truths conflict
- a place or org cannot be grounded
- the extraction confidence is below the threshold
- the fragment implies a merge/rename decision

## Query Return Contract

Every answer should include:

- `results`: ranked structured rows
- `evidence`: de-duplicated supporting snippets with source provenance
- `meta`: retrieval mode, planner, fallback reasons, counts, and the active ranking kernel when relevant

The LLM or UI may use the top structured row directly, or inspect the evidence
bundle and source artifact when more certainty is needed.
