# Life Ontology

This brain uses a fixed life-memory ontology so new notes can be routed into the
same substrate instead of adding one-off extractors for every domain.

## Entity Classes

- `self`: namespace self anchor
- `person`: friends, family, colleagues, partners
- `place`: room, venue, neighborhood, city, region, country
- `org`: companies, teams, communities, venues
- `project`: active and historical projects
- `activity`: hobbies, sports, repeated pursuits, skills-in-practice
- `media`: movies, shows, books, other canonical consumable items
- `skill`: durable capabilities and tools-in-practice grounded in evidence
- `decision`: explicit choices that explain why current truth or system policy exists
- `constraint`: durable operating rules, guardrails, or “always/never” policies
- `routine`: repeated weekly or habitual behaviors derived from repeated event evidence
- `style_spec`: durable response-style or workflow rules grounded in explicit directive-style evidence
- `belief`: durable stance or opinion truth that evolves through superseded historical versions
- `artifact`: source files, transcripts, documents, contracts, media
- `transcript_utterance`: replay-safe spoken evidence derived from transcript/ASR artifacts with speaker hints, timestamps, confidence, and source-artifact provenance
- `concept`: preferences, interests, styles, topics, abstract ideas that do not need stable identity yet

## Predicate Families

### Participation

- `was_with`
- `met_through`
- `visited`
- `mentioned_in`

### Residence And Travel

- `lives_in`: current active residence
- `lived_in`: historical residence
- `currently_in`
- `visited`
- `born_in`
- `moved_to`

### Work And Membership

- `works_at`: active employer or affiliation
- `worked_at`: historical employer
- `works_on`
- `member_of`
- `runs`
- `created_by`
- `project_role`

### Preferences And Lists

- `likes`
- `dislikes`
- `wants_to_watch`
- `watched`
- `supports`
- `supersedes`

### Decisions And Constraints

- `supports`
- `supersedes`
- `caused_by` should be added when decision-to-constraint linking becomes explicit

### Structure

- `contained_in`
- `parent_entity_id` on `entities` is the authoritative hierarchy for `place`
  and eventually `org`

## Memory Layers

- `episodic_memory`: immutable physical evidence and authoritative time-native episodic store
- `relationship_memory`: durable accepted graph edges
- `procedural_memory`: active truth and mutable state
- `semantic_memory`: compacted patterns and stable abstractions
- `state_summary` semantic rows: reconsolidated summaries of active procedural truth, always supersedable and evidence-backed
- `temporal_nodes`: TMT rollups for day/week/month/year summaries
- `artifact_derivations`: durable text derived from binary artifacts like images and PDFs, always linked back to the source artifact observation
- `transcript_utterances`: normalized spoken evidence derived from ASR/transcript artifacts before higher-level claim routing
- `ambiguity_inbox` / identity conflicts: unresolved operator work
- `episodic_timeline`: compatibility view over authoritative episodic storage during the migration off the legacy sidecar mirror
- derived semantic and temporal layers may move through deterministic `hot`, `warm`, and `cold` archival tiers without deleting raw episodic evidence

## Active Truth Rules

- A person should have one most-specific active home.
- Historical residences remain as `lived_in`.
- Current employer uses `works_at`; old employers use `worked_at`.
- Preferences supersede over time but raw source evidence is never deleted.
- Watchlists and other mutable lists live in `procedural_memory`.
- anchor-backed summaries are exempt from decay and archival.
- non-anchor derived summaries may demote to `warm` or archive to `cold` when they are superseded or sufficiently stale.
- `activity` and `media` entities can anchor those states without replacing raw evidence.
- `skill` entities anchor durable capability while specific uses stay in episodic evidence.
- `decision` entities anchor explicit choices and should remain evidence-backed.
- `constraint` entities anchor durable rules and should be queryable as active operational truth.
- recurrence-gated operational heuristics may also promote reusable `constraint` truth when the same machine-enforceable rule survives repeated evidence across distinct weeks and distinct sources.
- `routine` entities anchor repeated habits only after deterministic promotion from multiple weeks of event evidence.
- `style_spec` entities anchor durable response-style or workflow truth such as concise response preferences and ontology-work protocols.
- recurrence-gated operational heuristics may also land in `style_spec` only when they survive repeated evidence across distinct weeks and distinct sources.
- `belief` entities anchor explicit stances or opinions while older versions remain historically queryable through supersession.
- active romantic relationship truth can be mirrored into `procedural_memory` as `current_relationship` while ended tenures remain historical in `relationship_memory`.
- current relationship queries may return a confident `Unknown.` when ended or paused-contact tenure evidence proves there is no active partner.
- reconnect evidence should only reopen a romantic tenure when it is temporally separable from the prior ended tenure; collapsed same-timestamp autobiography should remain historical evidence instead of forcing fake active truth.
- raw episodic evidence remains immutable even when Timescale-native compression is available; storage policy must never supersede or archive authoritative episodic rows.
- authoritative `episodic_memory` is now the real Timescale hypertable in this environment.
- when provenance pointers are intentionally loose to keep the hypertable path viable, orphan prevention becomes a shared responsibility: the application and replay/audit jobs must verify `source_episodic_id` existence explicitly instead of relying on FK enforcement.

## Hierarchy Rules

- `entities.parent_entity_id` is the primary hierarchy for `place`.
- `contained_in` remains as compatibility/supporting graph evidence.
- Query zoom-out should traverse the parent chain, not duplicate current truth.
- exact hierarchy questions may stop on structural parent-chain facts when those rows are sufficient, instead of forcing episodic drill-down.
- archived temporal summaries should disappear from active recall, but their member links must still preserve the path back to the original evidence.
- authoritative episodic queries should read from `episodic_memory`; any remaining `episodic_timeline` use is compatibility-only and should not require write mirroring.
- on moderate corpora, hypertable chunk-management overhead may raise p95 query latency before the dataset is large enough for partition-pruning wins to dominate; that is acceptable if query quality and provenance remain stable and scale audits stay green.
- event-bounded recall should stay capped and sufficiency-gated so hypertable chunk scans remain concentrated on the small set of queries that genuinely need temporal/event context.

## Event Rules

- One note may generate multiple narrative events.
- Each event should capture:
  - participants
  - location
  - time anchor
  - activity kind
  - links back to source fragments
- binary artifacts may also generate `artifact_derivations` first, then become queryable evidence through the same duality contract as text-native memory.
- ASR/transcript artifacts should normalize into `artifact_derivations` plus `transcript_utterances` before claim routing.
- transcript utterances should preserve `speaker_label`, optional `speaker_hint`, utterance timing, and source-artifact provenance even when downstream claims are not promoted.
- speech-derived first-person claims must resolve relative to the speaker hint instead of assuming the namespace self anchor.
- low-confidence proper nouns, uncertain speaker identity, or vague spoken places should route to clarification rather than silently promoting graph truth.
- replay-safe multimodal fixtures should prove the derivation pipeline before live OCR / STT workers are trusted in production.
- live multimodal worker execution should stay deterministic at the queue/state-machine layer even when the provider-backed OCR / ASR / caption step is model-driven.
- episodic and narrative rows may also carry salience annotation such as `salience_labels`, `sentiment_score`, and `surprise_magnitude` without promoting emotion into current truth.

## Clarification Rules

- Low-confidence or contradictory extraction goes to inbox.
- Merge and keep-separate decisions must rebuild:
  - aliases
  - relationship candidates
  - relationship memory
  - procedural truth
  - temporal summaries
- stale semantic summaries that disagree with newer active tenure state should be superseded by deterministic reconsolidation rather than left active.
- operators should be able to inspect temporal containment violations and causal supersession overlays without reading raw SQL.
- operators should also be able to inspect when derived semantic or temporal layers were warmed or archived without losing the underlying evidence trail.
