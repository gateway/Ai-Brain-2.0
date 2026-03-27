# Codex Handoff

Use this file as the fastest sync point for other Codex threads working on the
AI Brain repo. It complements, but does not replace:

- `/Users/evilone/Documents/Development/AI-Brain/ai-brain/docs/BRAIN_PHASE_ROADMAP.md`
- `/Users/evilone/Documents/Development/AI-Brain/ai-brain/docs/BRAIN_TIGHTENING_BACKLOG.md`
- `/Users/evilone/Documents/Development/AI-Brain/ai-brain/docs/PRODUCTION_READINESS_PASS.md`
- `/Users/evilone/Documents/Development/AI-Brain/ai-brain/docs/FRESH_REPLAY_REGRESSION.md`

## Current Baseline

- `local-brain` replay is green on the current corpus.
- the current top-10 hardening pass is materially complete on the current corpus.
- the post-top-10 six-task pressure pass is materially complete on the current corpus.
- the five remaining 1.0 hardening items are materially complete on the current corpus:
  - unified SQL-first hybrid retrieval is battle-tested on replay, scale, MCP, synthetic watch, OMI watch, and multimodal smoke
  - production multimodal derivation worker wiring is green on the worker smoke path
  - broader relative-time resolution is green on replay, scale holdout, synthetic watch, and MCP
  - richer archival-tier policy is still green under replay and scale
  - harder alias / tenure conflict adjudication remains green on replay and transcript-scale pressure
- Timescale-backed `episodic_memory` is authoritative.
- onboarding and watched-folder setup are part of the real validation loop.
- clarification-driven abstention is required for unresolved kinship and vague
  places.
- transcript/ASR ingest is supported as a normalized evidence lane, not a
  parallel memory system.

## Current Validation Surfaces

- clean replay:
  - `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/life-replay-2026-03-23T12-20-34-514Z.json`
- recap-family benchmark:
  - `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/recap-family-2026-03-23T12-22-33-695Z.json`
- task/calendar extraction benchmark:
  - `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/task-calendar-extraction-2026-03-23T12-22-46-640Z.json`
- session-start memory benchmark:
  - `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/session-start-memory-2026-03-23T12-23-01-569Z.json`
- recap provider parity benchmark:
  - `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/recap-provider-parity-2026-03-23T12-23-21-209Z.json`
- temporal differential benchmark:
  - `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/temporal-differential-2026-03-23T13-54-52-193Z.json`
  - current status: differential recap for `this week`, `over the last two days`, and direct deadline-cause prompts is now green with grouped evidence
- natural query review benchmark:
  - `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/natural-query-review-2026-03-23T13-23-59-180Z.json`
  - `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/natural-query-review-2026-03-23T13-23-59-180Z.md`
  - current status: `9 pass / 1 warning / 0 fail`, with the lone warning being the intentional `Uncle` ambiguity case for human review
- demo-readiness:
  - `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/demo-readiness-2026-03-23T12-21-45-469Z.json`
  - current status: extension parity, embedding dimension/provider parity, MCP stdio wiring, and post-onboarding watched-folder delta induction are green
- external-user acceptance:
  - `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/external-acceptance-2026-03-23T12-21-49-817Z.json`
  - current status: generic-role abstention, alias collision hardening, exact-detail descent, relationship/graph surfacing, and natural beverage prompt invariance are green on a fresh watched-folder namespace
- synthetic watched-folder smoke:
  - `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/human-synthetic-watch-2026-03-23T12-21-57-600Z.json`
- OMI watched-folder smoke:
  - `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/omi-watch-smoke-2026-03-23T12-24-29-232Z.json`
  - current status: monitored-source imports now preserve embedded/frontmatter timestamps for markdown inputs, so recap/day-window queries align to OMI conversation dates instead of file mtime
- scale replay:
  - `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/life-scale-2026-03-23T12-21-42-590Z.json`
- MCP assistant eval:
  - `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/mcp-smoke-2026-03-23T12-24-23-565Z.json`
  - current status: read-only assistant tool surface is green across replay, synthetic watch, and OMI watched-folder corpora, including grounded OMI recap checks
- multimodal worker smoke:
  - `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/multimodal-worker-smoke-2026-03-23T12-24-35-299Z.json`
- public dataset watched-folder pressure:
  - `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/public-dataset-watch-2026-03-23T12-22-08-385Z.json`
  - release-gate queries and former `knownGapResults` are now green on the external public-corpus pack
- NotebookLM six-suite hardening benchmark:
  - `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/hardening-suites-2026-03-23T12-22-01-510Z.json`
  - current status: all six suites are green on the current corpus:
    - inter-session dependency
    - causal root-cause retrieval
    - virtual-memory paging under noisy context
    - semantic conflict abstention
    - shadow MCP / tool poisoning rejection
    - selective forgetting / ghost-memory cleanup
- aggregate production battle suite:
  - `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/production-battle-2026-03-24T04-58-30-722Z.json`
  - current status: `100%` pass rate with replay, scale, demo-readiness, external acceptance, synthetic watch, public data watch, recap-family, task/calendar extraction, session-start memory, provider parity, MCP, OMI watch, multimodal worker smoke, and long-form mixed-intent MCP recap prompts all green
  - operator note: a stale benchmark runner can hold the advisory maintenance lock even after the parent shell exits; `withMaintenanceLock` now waits briefly before failing, but a truly orphaned benchmark process still needs to be cleared before rerunning the full aggregate gate
- relation extraction bakeoff:
  - `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/relation-bakeoff-2026-03-24T04-35-03-851Z.json`
  - current status: additive external extraction is now wired in shadow mode through `.venv-brain`
  - current Mac stack ranking:
    - `gliner-relex`: best current candidate generator
    - `spaCy`: useful lightweight fallback
    - `gliner2`: sidecar contract exists, current model id not yet package-compatible
    - `SpanMarker`: sidecar contract exists, current stack has a transformers/config incompatibility
- public memory compare:
  - `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/public-memory-compare-2026-03-24T04-51-48-413Z.json`
  - supporting artifacts:
    - `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/longmemeval-2026-03-24T04-49-44-851Z.json`
    - `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/locomo-2026-03-24T04-49-48-494Z.json`
  - current status: first public benchmark lane is operational and should now be treated as an external pressure signal beside the internal production gate, not a replacement for it
- latest public-memory compare:
  - `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/public-memory-compare-2026-03-24T08-11-56-986Z.json`
  - current status:
    - `LongMemEval` sampled pass rate: `0.75`
    - `LoCoMo` sampled pass rate: `1.0`
    - artifacts now carry fusion/reranker/scorer/IE schema versions for replayable comparison
- latest public miss regressions:
  - `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/public-memory-miss-regressions-2026-03-24T08-10-26-205Z.json`
  - current status: green after fixing commute duration, support-group exact date, and Jon causal-motive wording
- latest shared/causal review:
  - `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/shared-causal-review-2026-03-24T08-11-56-987Z.json`
  - current status: `3 pass / 2 warning / 0 fail`
- latest rerunnable enrichment refresh:
  - `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/enrichment-refresh-2026-03-24T08-12-00-860Z.json`
  - current status: green
- latest MCP assistant eval:
  - `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/mcp-smoke-2026-03-24T08-13-29-355Z.json`
  - current status: `35 / 35` green

## Latest Pass

- completed and re-verified the next practical maturation slices on the current corpus:
  - deeper complexity-aware TMT sufficiency gating now respects semantic-anchor windows and avoids low-information embedding work where the planner already has a temporal focus
  - broader multimodal derivation worker breadth is green with honest fallback completion for unavailable audio/video extraction instead of retry drift
  - richer hot/warm/cold archival policy now accounts for transcript density and source-channel diversity
  - bigger noisy holdout corpora now include denser persona pressure and longer transcript correction chains
  - the scale pack now runs at `254` generated artifacts instead of the earlier moderate pack, including additional narrative-anchor, transcript-pressure, and clarification-pressure holdouts
  - bounded event-heavy queries stay green with tighter support fan-out, though they remain the main latency tail
  - harder semantic-anchor resolution is stronger, and protocol/policy queries now suppress false narrative-anchor expansion, but broad `after the trip`-style queries remain the dominant p95 tail at larger scale
- assistant-facing MCP surface now includes read-only graph, clarification, protocol, and system-health inspection that stays green under the replay-backed MCP smoke harness
- additive external extraction now exists as a candidate-only lane:
  - Python sidecar path: `/Users/evilone/Documents/Development/AI-Brain/ai-brain/tools/relation-ie/extract_relations.py`
  - Node integration path: `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/relationships/external-ie.ts`
  - current hook point: `stageNarrativeClaims(...)` in `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/relationships/narrative.ts`
  - authority rule remains unchanged: external extractors can only stage candidates; adjudication and clarification still own truth promotion
- synthetic watched-folder and MCP smoke now include NotebookLM-guided adversarial coverage:
    - scripted preference drift
    - unresolved-ambiguity pressure
    - sensitive-secret query rejection
    - poisoned-rule rejection
- finalized an external public-benchmark watched-folder surface using:
  - PrefEval explicit preferences
  - HaluMem profile/relationship/preference slices
- it is now production-usable as a release gate on the monitored import path:
  - release-gate queries and the former known-gap probes now pass for public-profile location recall, diet recall, non-self relationship lookup, and harder imported aversion/preference phrasing
- the remaining honest residual on this surface is deeper than query coverage:
  - imported third-person preferences are still stronger on lexical/raw retrieval than on promoted procedural preference state
- replay, scale, synthetic watched-folder smoke, OMI watched-folder smoke, MCP assistant eval, and multimodal worker smoke were rerun to a green state on the latest code path
- added a production battle suite as the release gate for this phase:
  - runs replay, scale, synthetic watch, public-data watch, MCP, OMI watch, and multimodal worker smoke in one serial pass
  - adds long-form mixed-intent MCP prompts that simulate how a human or assistant actually asks for life recall
  - now also covers a broad imported third-person public-profile recap, not just personal and synthetic Steve recaps
  - current long-form coverage is green for both:
    - broad imported public-profile recap
    - broad personal 2025 life recap
    - broad synthetic recent-life recap
- current release-gate result is `100%` and `releaseGatePassed: true`
- added a stricter demo-readiness suite for the real demo-machine path:
  - validates required Postgres extensions and embedding-dimension parity on the active provider
  - validates MCP stdio tool wiring directly against `dist/cli/mcp.js`
  - validates a real post-onboarding watched-folder delta instead of only the first import
  - the scheduled monitor path must import a newly written file and make its new fact queryable after consolidation/adjudication
- added an external-user acceptance benchmark for another-machine trials:
  - imports a fresh watched-folder corpus with unresolved role references, distinct same-first-name people, exact factual detail, and natural beverage preference prompts
  - release checks now prove:
    - `who is the doctor?` abstains and routes to clarification
    - `Sarah Kim` and `Sarah Tietze` stay distinct in search, relationship MCP, and graph MCP
    - exact-detail receipt questions descend to the leaf evidence row
    - natural paraphrases like `what does Steve usually drink in the evening now?` still retrieve `sencha`
- mixed-intent life-recap prompts now decompose into focused subqueries instead of collapsing onto one narrow lexical thread
- MCP smoke now covers `34 / 34` assistant-style scenarios across `who / what / where / when / why`, including broader natural prompts for karaoke companions, Lauren’s 2025 change, spicy-food provenance, and movie comparison
- retrieval/runtime versioning is now attached to the public benchmark lane:
  - `retrievalFusionVersion`
  - `rerankerVersion`
  - `fastScorerVersion`
  - `officialishScorerVersion`
  - `relationIeSchemaVersion`
- rerunnable enrichment maintenance is now a first-class path:
  - `npm run benchmark:enrichment-refresh --workspace local-brain`
  - `npm run refresh:retrieval-enrichment --workspace local-brain`
- shared/causal review is now a first-class benchmark surface:
  - `npm run benchmark:shared-causal-review --workspace local-brain`
- MCP smoke now covers `35 / 35` assistant-style scenarios across `who / what / where / when / why`
- final NotebookLM review agreed the direction still matches the Brain notebook architecture
- NotebookLM’s top remaining deterministic gaps for a conservative next pass are:
  - fully official-style public benchmark execution beyond sampled mode
  - remaining sampled `LongMemEval` retrieval misses
  - stronger semantic relationship and alias adjudication for harder social-tenure conflicts

## Human-Path Test Loop

For fresh-data or onboarding-related work, validate in this order:

1. start at `/setup`
2. go through `/bootstrap`
3. configure intelligence routing
4. ground the owner/self profile
5. add a watched source through the UI
6. scan, preview, and import
7. verify the source on `/sources`
8. inspect `/knowledge`, graph behavior, and clarifications
9. run natural-language query smoke checks
10. wipe/replay only after the human-path validation is understood

## What Is Already Built

- current vs historical truth separation
- temporal summaries and derived archival
- graph traversal with provenance-backed edges
- OMI watched-folder ingest through the monitored-source path
- SQL-first per-namespace hybrid kernel
- MCP assistant query eval coverage
- first-class recap/task/calendar/explain MCP tools:
  - `memory.recap`
  - `memory.extract_tasks`
  - `memory.extract_calendar`
  - `memory.explain_recap`
- human-review natural query report:
  - prompt
  - resolved window
  - focus
  - LLM-style answer preview
  - evidence rows
  - source paths
  - automated verdict plus manual review placeholders
- temporal-differential recap support:
  - rolling differential windows for `this week` and `over the last N days`
  - cleaned topic extraction so recap focus no longer leaks temporal fragments such as `Project A this`
- read-only MCP graph, health, and protocol tooling for real assistant workflows
- ASR/transcript normalization for external transcript payloads
- synthetic watched-folder corpus pressure testing with human-like ambiguity
- read-path guardrails for obviously sensitive secret queries
- external public-dataset watched-folder pressure using transformed PrefEval and HaluMem slices

## Do Not Re-Do These

- do not invent a second onboarding path outside `/setup` and `/bootstrap`
- do not bypass monitored-source ingestion when testing watched folders
- do not promote unresolved transcript speakers into the self anchor
- do not weaken clarification-driven abstention for kinship or vague places
- do not revert unrelated dirty-worktree changes

## Top-10 Status

- verified done on the current corpus:
  - live embedding provider activation
  - dual-speaker transcript fixtures
  - transcript edit propagation
  - persona/nickname disambiguation across recordings
  - historical graph traversal coverage in replay and graph smoke
  - relative-time anchoring coverage in replay
  - leaf-grounded or planner-approved day/session recall coverage in replay
  - relationship transition and history modeling
  - larger controlled corpus passes through OMI watched-folder smoke
  - MCP assistant smoke coverage
- still watch closely:
  - bounded event queries are still the main p95 latency tail on the scale pack
  - larger real corpora may expose additional recall misses even though the current top-10 pass is green

## Post-Top-10 Status

- verified done on the current corpus:
  - human-like synthetic corpus generation
  - synthetic watched-folder import through the monitored-source path
- assistant-style MCP natural-query eval
- aggregate production battle suite with long-form mixed-intent MCP recap coverage
- clarification-loop follow-up eval through MCP
- rerun scale/latency validation after the new synthetic pressure pass
- failure categorization and self-heal loop for synthetic recall/graph/clarification misses
  - adversarial drift/poison tests through watched-folder ingest and MCP
- still watch closely:
  - the current synthetic corpus is now materially larger, but still not a huge real-world dump
  - the dominant p95 tail has shifted from bounded event support to broad semantic-anchor questions like `what happened after the Turkey trip?`
- the next real pressure should be denser mixed-history transcripts and more real holdout folders
- the latest narrower NotebookLM pass says the most likely remaining under-tested categories are:
  - causal root-cause retrieval
  - adversarial memory poisoning
  - selective forgetting / ghost-memory audits
- the public-dataset benchmark should now be treated this way:
  - `queryResults` and `knownGapResults` should both stay green
  - if external public-corpus regressions return, inspect person-name ambiguity and preference-query lexical rewrites first
  - use a fresh namespace per run to avoid stale benchmark contamination

## 1.0 Status

- battle-tested green on the current corpus:
  - replay
  - scale
  - synthetic watched-folder
  - OMI watched-folder
  - MCP assistant eval
  - multimodal worker smoke
- current replay baseline:
  - `70 confident / 0 weak / 1 missing`
  - the one missing case is the intentional clarification abstention for `who is Uncle?`
- current scale baseline:
  - `254 generated artifacts`
  - `p50 604.82ms`
  - `p95 2582.16ms`
  - `Steve focus graph: 53 nodes / 67 edges`

## OMI Notes

- use the normalized watched-folder path:
  - `/Users/evilone/Documents/Development/AI-Brain/ai-brain/data/inbox/omi/normalized`
- ignore `.DS_Store`
- treat `raw` as archive/provenance input, not the watched ingest root
- current watched-folder smoke covers six OMI markdown files and keeps graph and
  clarification checks green

## If Starting A New Slice

1. check NotebookLM first
2. patch conservatively
3. validate the human path if onboarding/source monitoring is touched
4. rerun the relevant replay/smoke benchmark
5. rerun `benchmark:life` if retrieval/ontology behavior changed
6. update this handoff doc if the verified baseline moved
