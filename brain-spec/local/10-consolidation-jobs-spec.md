# Consolidation Jobs Spec

## Purpose

Define the background jobs that turn raw history into stable memory.

## Core Jobs

### Candidate consolidation

Purpose:

- adjudicate new candidate memories

Actions:

- `ADD`
- `UPDATE`
- `SUPERSEDE`
- `IGNORE`

### Daily summary generation

Purpose:

- create day-level nodes

### Weekly summary generation

Purpose:

- roll daily memory into weekly patterns

### Monthly or profile summary generation

Purpose:

- maintain durable long-horizon summaries

### Decay and cleanup

Purpose:

- reduce low-value derived memory

## Job Inputs

- recent episodic fragments
- candidate memory rows
- existing semantic memory
- procedural state
- entity and relationship links

## Job Outputs

- updated semantic memory
- updated procedural state
- temporal summary nodes
- supersession links
- decay actions

## Conflict Rules

1. history remains in episodic memory
2. active truth updates by newer durable evidence
3. temporary overrides should not automatically become global truth

## Scheduling

Near real time:

- stage candidate memories

End of session:

- candidate consolidation

Daily:

- day summary

Weekly:

- week summary

Monthly:

- profile summary
- decay review

## Required Audit Data

Each job run should log:

- job type
- start time
- end time
- counts of actions taken
- errors
- affected rows or identifiers
