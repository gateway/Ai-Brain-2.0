# LLM Classifier Runner Sidecar

Date: 2026-03-18

## Purpose

Use a small LLM as an ingestion-side classifier that turns derived text into structured candidate data before promotion into the brain.

This is not a second memory system.

It is a sidecar runner that helps the existing brain decide:

- who is in the content
- what places, orgs, projects, and things are mentioned
- what events/times are implied
- what should stay episodic
- what is a semantic candidate
- what may become current procedural truth
- what is ambiguous and should go to the inbox

## Position In The Pipeline

The correct placement is:

1. artifact arrives
2. raw artifact is stored as the source of truth
3. OCR / STT / caption / text derivation creates a text proxy
4. the classifier runner reads that proxy
5. the classifier runner emits candidate packets
6. existing scene/claim extraction, clarification, and consolidation decide what becomes memory

So the flow is:

`artifact -> derivation -> classifier runner -> claim candidates / ambiguity / consolidation -> memory`

## Why This Is The Right Shape

This keeps the current brain architecture intact:

- raw markdown/files/audio/images remain the truth
- Postgres remains the brain substrate
- the small LLM helps organize candidate structure
- it does not get to write final truth directly

That means:

- fewer hallucinated active facts
- better handling of freeform narrative
- better support for people, places, things, times, and events
- less token burn than asking a large model to reason over everything later

## Tripartite Memory Mapping

Yes, this aligns with the tripartite system we are already using:

- `episodic`
  - raw fragments, scenes, event mentions, source evidence
- `semantic`
  - distilled facts and stable learned patterns
- `procedural`
  - current truth, specs, active roles, preferences, project state

The classifier runner should not directly decide final truth.

It should only produce:

- `episodic candidates`
- `semantic candidates`
- `procedural candidates`
- `ambiguity flags`

Then the existing consolidation/adjudication path decides what gets promoted.

## Inputs

The runner should accept:

- `namespace_id`
- `artifact_id`
- `artifact_observation_id`
- `source_chunk_id` or derived-text segment id
- `captured_at`
- `summary_text` or text proxy
- optional:
  - modality hint (`text`, `image`, `pdf`, `audio`, `chat`)
  - current scene context
  - known namespace entities/aliases
  - prior temporal anchor

## Outputs

The runner should return a structured packet like:

```json
{
  "namespace_id": "personal",
  "artifact_id": "uuid",
  "artifact_observation_id": "uuid",
  "source_chunk_id": "uuid",
  "summary_text": "string",
  "entities": [
    {
      "name": "Gumi",
      "entity_type": "person",
      "aliases": ["Gumi"],
      "confidence": 0.94
    }
  ],
  "times": [
    {
      "raw_text": "last Friday",
      "occurred_at": "2026-03-13T00:00:00Z",
      "anchor_basis": "captured_at",
      "confidence": 0.82
    }
  ],
  "events": [
    {
      "event_kind": "meeting",
      "label": "Met Gumi in Chiang Mai",
      "confidence": 0.79
    }
  ],
  "claims": [
    {
      "subject": "Steve",
      "predicate": "friend_of",
      "object": "Gumi",
      "confidence": 0.88
    }
  ],
  "promotion_plan": [
    {
      "target": "episodic",
      "reason": "source evidence"
    },
    {
      "target": "semantic",
      "reason": "durable relationship candidate"
    }
  ],
  "ambiguities": [
    {
      "type": "alias_collision",
      "raw_text": "Ben",
      "reason": "could be Benjamin Williams"
    }
  ]
}
```

## Recommended Runtime Shape

The best practical implementation is:

- small Node worker or queue consumer
- called from the derivation queue after text proxy creation
- optionally uses:
  - a small OpenRouter model
  - a local API endpoint
  - a local lightweight model

It should be:

- deterministic in output schema
- low-token
- candidate-first
- easy to replay

## Where It Hooks Into The Current System

Existing integration points:

- derivation queue:
  - [/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/jobs/derivation-queue.ts](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/jobs/derivation-queue.ts)
- narrative scene/claim staging:
  - [/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/relationships/narrative.ts](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/relationships/narrative.ts)
- clarifications / inbox / outbox:
  - [/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/clarifications/service.ts](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/clarifications/service.ts)
- consolidation:
  - [/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/jobs/consolidation.ts](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/jobs/consolidation.ts)
- relationship adjudication:
  - [/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/jobs/relationship-adjudication.ts](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/jobs/relationship-adjudication.ts)

## Smaller LLM First

Yes, a smaller LLM is the right first stage.

Use it for:

- categorization
- entity typing
- relation candidate extraction
- time normalization hints
- ambiguity detection
- promotion suggestions

Do not use it as final truth.

The existing brain should cross-reference the result against:

- `entities`
- `entity_aliases`
- `relationship_priors`
- `claim_candidates`
- `procedural_memory`
- `semantic_memory`

Then:

- if confidence is high and history agrees, promote
- if confidence is mixed, keep staged
- if confidence is low or conflicts exist, send to inbox

## Best Practices

- raw artifact remains canonical
- classifier output is replayable
- all output is provenance-linked
- do not bypass candidate tables
- do not write directly into active procedural truth
- ambiguities must abstain, not invent

## Risks

- over-classification of vague nouns into fake people/places
- writing directly to semantic/procedural memory too early
- creating a second shadow extraction system that disagrees with narrative staging

## Recommendation

Build this as a sidecar runner, not a replacement pipeline.

The correct implementation is:

- `small model -> structured candidate packet -> cross-reference -> stage -> clarify/adjudicate -> promote`

That gives us better people/places/things/time/event extraction without breaking the current brain model.
