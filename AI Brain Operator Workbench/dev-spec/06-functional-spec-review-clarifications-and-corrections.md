# 06 — Functional Spec: Review, Clarifications, and Corrections

## Goal

Define how the app displays what the brain inferred and how operators fix uncertainty.

## Review page purpose

The review page is the operator’s first look at what the system produced from a session.

It should show:
- source summary
- transcript/extracted text summary
- entity candidates
- relationship candidates
- claim candidates
- summaries or notes if generated
- confidence values
- unresolved or suspicious items
- model provenance

## Review page sections

### 1. Source context
- source list
- source snippets
- transcript/extracted text snippets
- chunk counts

### 2. Entity candidates
Each entity card should show:
- temporary or permanent id
- display label
- entity type
- source evidence count
- aliases if any
- confidence
- status
- quick actions

### 3. Relationship candidates
Each relationship card should show:
- subject
- predicate/edge type
- object
- confidence
- supporting evidence
- source references
- status
- quick actions

### 4. Claims or derived fact candidates
Each claim card should show:
- normalized text
- target memory layer if known
- source evidence
- confidence
- review status

### 5. Unresolved items
These include:
- unknown person references
- possible duplicates
- alias collisions
- weak relationships
- conflicts across spellings or facts
- missing labels for kinship references

## Clarification item types

Recommended review item kinds:
- `alias_conflict`
- `possible_duplicate_entity`
- `kinship_placeholder`
- `unknown_person_reference`
- `unknown_place_reference`
- `relationship_conflict`
- `fact_conflict`
- `low_confidence_link`
- `requires_operator_confirmation`

## Clarification page behaviors

Each clarification item must provide:
- a clear title
- explanation of why it exists
- supporting evidence/snippets
- confidence score or uncertainty indicator
- proposed candidate matches if any
- operator actions
- current status
- history of prior decisions or retries

## Required operator actions

### Action 1 — Link to existing entity
Use when the item refers to a known person/place/etc.

Inputs:
- target entity id
- optional rationale note

### Action 2 — Create new entity
Use when no good match exists.

Inputs:
- entity type
- canonical label
- optional aliases
- optional notes

### Action 3 — Mark as alias
Use when two names refer to same entity.

Inputs:
- alias string
- canonical entity id

### Action 4 — Reject proposed match
Use when the system suggested a bad merge or link.

Inputs:
- rejection reason optional

### Action 5 — Fill in missing label
Use for references like “uncle” or “my boss” when operator knows the real identity.

Inputs:
- canonical label
- entity type
- optional relation note

### Action 6 — Merge candidates
Use when two candidate entities should resolve to one canonical entity.

Inputs:
- survivor entity id
- merged entity id
- optional alias mapping choices

### Action 7 — Defer
Use when operator cannot resolve yet.

Inputs:
- defer reason
- optional note

## Correction model

### Key rule
Corrections are **not ad hoc truth table edits**.

They are explicit review actions that the brain can consume and use to:
- stage corrections
- update alias maps
- queue reprocessing
- rerun relationship adjudication
- rerender graph/search results

## Resolution states

Suggested statuses:
- `open`
- `in_review`
- `resolved`
- `rejected`
- `deferred`
- `queued_for_reprocessing`
- `reprocessed`

## Required evidence display

For every clarification item, show:
- one or more source snippets
- artifact/transcript reference
- session id
- model run provenance if item came from model output
- current related entities if any

## Confidence handling

The UI should not pretend confidence is absolute, but should make it legible.

Recommended display:
- numeric confidence if available
- badge:
  - High
  - Medium
  - Low
- optional explanation tooltip

## Bulk operations

MVP bulk operations may be limited, but should at least consider:
- bulk reject obvious duplicate bad suggestions
- bulk mark as deferred
- bulk save notes

## Audit requirements

Every correction action must record:
- operator id
- session id
- item id
- action type
- before snapshot
- after payload
- submitted at
- resulting job id if any

## Reprocessing requirements

When a correction requires rerun:
1. app submits correction action
2. brain returns new item state and possibly queued job id
3. app displays pending reprocessing state
4. on completion, app refreshes session pages
5. operator can inspect differences

## Acceptance criteria

### Clarification usability
- operator can understand why an item is unresolved
- operator can choose a resolution action without guesswork

### Correction persistence
- submitted corrections are persisted and auditable

### Reprocessing
- system can enqueue and track follow-up processing where relevant

### Visibility
- resolved items move out of the main open queue or clearly show resolved status

## Edge cases

- a clarification item becomes obsolete because another action resolved it
- a merge candidate disappears after reprocessing
- model returned invalid or incomplete candidate shape
- operator submits a resolution against stale state
- two operators try to resolve same item at nearly same time

Suggested handling:
- optimistic concurrency on review item version or updated_at
- stale item warning
- forced refresh after successful mutation

## Nice-to-have enhancements

- side-by-side diff before/after correction
- “show me all evidence” mode
- confidence explanation sourced from model metadata
- queue of “most impactful unresolved items”
