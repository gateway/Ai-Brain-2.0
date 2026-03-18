# Memory Lifecycle, Conflicts, And Summaries

## Lifecycle Overview

Memory moves through these stages:

1. raw artifact
2. extracted fragment
3. episodic memory
4. candidate memory
5. semantic or procedural memory
6. summary nodes
7. decay or archival

## Candidate Memory

Not everything should become durable memory.

Candidates should be staged first.

Examples:

- possible durable preference
- possible project fact
- possible relationship update
- possible status change

## Consolidation Loop

### Purpose

Integrate new evidence with existing memory.

### Main actions

- `ADD`
- `UPDATE`
- `SUPERSEDE`
- `IGNORE`

### Core process

1. find semantically similar memory
2. compare meaning and timestamps
3. apply a decision
4. write links and state changes

## Conflict Resolution

### Main rule

Use:

- latest durable evidence for active truth

while preserving:

- historical truth in episodic memory

### Example

Old:

- "I like sour foods."

New:

- "I prefer sweet foods now."

System behavior:

- keep both statements in episodic history
- mark the old durable preference as superseded or inactive
- make the new preference active in semantic or procedural memory

## Active Truth Vs Historical Truth

### Historical truth

What was said or happened at the time.

Stored in:

- episodic memory

### Active truth

What the system should believe now.

Stored in:

- procedural memory
- active semantic rows

This split is mandatory if the brain is going to handle change correctly.

## Day, Week, And Month Summaries

### Why they exist

- reduce token burn
- support long-horizon recall
- detect repeated themes

### Suggested levels

- day summary
- week summary
- month summary
- profile summary

### What each one should contain

Day:

- major events
- decisions
- people
- places
- active tasks

Week:

- recurring patterns
- evolving preferences
- project progress
- relationships seen repeatedly

Month or profile:

- stable identity traits
- long-term project trajectories
- durable preference changes

## TMT Role

These summaries should be connected as a temporal hierarchy.

That hierarchy should let the system:

- zoom into a year
- descend into months and days
- pull supporting leaf evidence

## Forgetting Strategy

### What should not be forgotten first

- raw artifacts
- critical anchors
- high-value episodic evidence

### What can decay

- low-value semantic abstractions
- stale non-anchor summaries
- repetitive ephemeral candidates

### Useful controls

- importance score
- anchor flag
- last accessed
- support count
- contradiction status

## Benefits

- lower storage pressure
- lower token burn
- better retrieval quality

## Risks

- over-aggressive decay can hide useful abstractions
- weak summary quality can create false beliefs

## Recommended Scheduling

Near-real-time:

- capture episodic fragments
- stage candidate memories

End of session:

- candidate consolidation
- contradiction checks

Daily:

- day summary generation

Weekly:

- week summary generation
- pattern extraction

Monthly:

- profile refresh
- decay review

## Prompting Rules For Adjudication

The adjudication model should follow strict rules:

- do not invent facts
- compare only supplied evidence
- distinguish contradiction from extension
- prefer newest durable evidence for active truth
- keep output structured

Recommended output shape:

- `action`
- `reason`
- `confidence`
- `supersedes_id`
- `promote_to`
