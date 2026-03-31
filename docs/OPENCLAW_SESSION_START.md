# OpenClaw Session Start

This document defines the recommended AI Brain startup pattern for OpenClaw-style
agents that lose chat context between terminals or fresh sessions.

The goal is to avoid rescanning large markdown memory trees on every start.
OpenClaw can keep writable markdown memory files, but AI Brain should provide the
retrieval, recap, task, calendar, relationship, and provenance layer behind that
surface.

## Core Principle

- retrieval is deterministic and evidence-first
- summarization is optional and runs only over returned evidence packs
- source links stay attached to confident outputs
- ambiguity must abstain and route to clarification instead of guessing

## Recommended Startup Flow

When a fresh agent session opens:

1. Call `memory.recap` for the relevant window.
- use `yesterday` for normal continuity
- use `last weekend` for longer gaps
- include explicit participants, topics, or projects when known

2. Optionally call `memory.extract_tasks`.
- use when the agent needs pending work items from the prior session window
- keep evidence IDs and source paths attached

3. Optionally call `memory.extract_calendar`.
- use when the agent needs plans, meetings, travel, or commitment-like items
- keep evidence IDs and source paths attached

4. Load only the returned summary plus evidence pointers into the new session context.
- do not dump raw watched-folder markdown or daily memory files into context
- keep the bootstrap pack small and grounded

5. If challenged, call `memory.explain_recap`.
- use for:
  - `why do you think that?`
  - `where did that come from?`
  - `show me the source of truth`

6. If the recap is ambiguous, call `memory.get_clarifications`.
- do not guess when participant, place, or project identity is unclear

## Example Prompts

Use the recap-family tools for questions like:

- `what did Dan and I talk about yesterday?`
- `give me an overview of what we said about Project A on Friday`
- `what movies did I mention I liked last week?`
- `make a task list from what I mentioned yesterday`
- `pull calendar items from last weekend`
- `why do you think that was the right conversation?`

## Suggested MCP Pattern

### Recap

Call:

- `memory.recap`

Expect:

- resolved time window
- participants/topics/projects focus
- grouped evidence rows
- source artifact paths
- confidence
- optional derived summary if a provider is configured

### Tasks

Call:

- `memory.extract_tasks`

Expect:

- task title
- description
- assignee guess
- project
- due hint
- status guess
- evidence IDs

### Calendar

Call:

- `memory.extract_calendar`

Expect:

- title
- participants
- time hint
- location hint
- certainty
- evidence IDs

### Explain

Call:

- `memory.explain_recap`

Expect:

- the evidence bundle used by recap/task/calendar outputs
- enough provenance for an LLM to explain why the answer was returned

## Summarization Guidance

Optional recap summarization may use:

- no provider
- local model
- OpenRouter

Rules:

- retrieval always runs first
- summarizers may only consume the returned evidence pack
- summarizers must not free-search the corpus
- the evidence pack remains the source of truth

## Relationship To OpenClaw Markdown Memory

OpenClaw markdown memory files still matter for:

- durability
- human editing
- workspace-local journaling

AI Brain should handle:

- recall
- recap
- tasks
- calendar extraction
- relationship lookup
- graph expansion
- provenance and clarification

That keeps startup context small and avoids reading large daily/weekly markdown
trees just to answer questions about yesterday or last weekend.

## Current Product Test Loop

The current synthetic continuity benchmark for this startup contract is:

- `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/benchmark/personal-openclaw-review.ts`

It runs against the shadow namespace:

- `personal_continuity_shadow`

And the checked-in OpenClaw-style fixture corpus:

- `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-generated/personal-openclaw-fixtures`
