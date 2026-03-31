# LoCoMo First-Pass Audit

- Date: 2026-03-29
- Mode: audit only, no fixes
- Primary artifact: `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/locomo-2026-03-29T06-51-37-716Z.json`
- Markdown artifact: `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/locomo-2026-03-29T06-51-37-716Z.md`
- Latest certified baseline for non-LoCoMo protected lanes: `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/certification-98-2026-03-29T04-35-20-409Z.json`

## Scope

This pass was run to identify where the system is breaking, not to repair it.
The goal was to collect:

- failed run evidence
- retrieval misses
- answer misses despite evidence
- likely system-level cause buckets
- runtime / DB / harness observations

No code changes were made as part of this audit.

## Benchmark terminology

- `passRate`: raw percentage of passed benchmark items
- `passed`: whether the whole benchmark cleared its threshold
- `normalizedPassed`: whether the answer passed the normalized scorer; this can fail even when raw `passed` is true
- `failureClass`: benchmark’s primary failure bucket for a miss
- `queryBehavior`: coarse query type the system routed into
- `sufficiency`: whether the system believed the evidence support was `supported`, `weak`, `missing`, or `contradicted`
- `subjectMatch`: whether the selected evidence appears bound to the correct subject (`matched`, `mixed`, `mismatched`, `unknown`)

## Current state

### Protected product lanes

From the last certified run, the protected non-LoCoMo lanes were green:

- repeated component certification passed
- larger validation passed
- dashboard validation passed
- release 98 gate passed

Important nuance:

- that certified run passed the larger validation gate overall
- this fresh single LoCoMo audit run did **not** pass
- so LoCoMo remains the main open public-benchmark diagnosis surface even while the frozen product certification passed

### Fresh LoCoMo result

- `sampleCount`: `100`
- `passRate`: `0.45`
- `passed`: `false`
- `failCount`: `55`
- `normalizedFailCount`: `66`
- `latency.p50Ms`: `1784.17`
- `latency.p95Ms`: `3961.3`

## High-level failure picture

### Failure classes

- `answer_shaping`: `20`
- `alias_entity_resolution`: `16`
- `temporal`: `10`
- `abstention`: `8`
- `synthesis_commonality`: `1`

### Query behaviors among failed items

- `direct_fact`: `34`
- `temporal_detail`: `15`
- `other`: `4`
- `commonality`: `2`

### Category performance

- category `1`: pass rate `0.381`
- category `2`: pass rate `0.381`
- category `3`: pass rate `0.222`
- category `4`: pass rate `0.6`
- category `5`: pass rate `0.65`

Category `3` is the weakest zone in this run.

### Evidence pattern

Among failed items:

- `43/55` had exactly `1` evidence item
- `40/55` still had `sufficiency = supported`
- only `2/55` had zero evidence
- only `12/55` were tagged as `missing`

That means the dominant problem is **not** total retrieval collapse. Most misses occur when the system found something, considered it supported, and still returned the wrong final claim.

## Failure buckets

### 1. Answer shaping failures

This is the biggest bucket.

Pattern:

- evidence exists
- subject usually matches
- final answer text is too broad, too generic, or extracts the wrong local detail from an otherwise related unit

Typical examples:

- `What sparked John's interest in improving education and infrastructure in the community?`
- `What is one of Joanna's favorite movies?`
- `What kind of indoor activities has Andrew pursued with his girlfriend?`
- `What items did Calvin buy in March 2023?`

Observed symptom:

- the selected row is often a topic segment or conversation unit with relevant neighborhood context, but not the precise answer-bearing claim

Likely system cause:

- precision loss between retrieval hit and final claim shaping
- over-reliance on topic segments / derivations instead of narrower answer units

### 2. Alias / entity-resolution failures

This is the second biggest bucket.

Pattern:

- subject binding becomes mixed between two people in the same conversation
- the system surfaces related evidence, but it is not cleanly owned by the asked-about person
- many of these show `subjectMatch = mixed`

Typical examples:

- `Would Caroline still want to pursue counseling as a career if she hadn't received support growing up?`
- `Is it likely that Nate has friends besides Joanna?`
- `Which year did Audrey adopt the first three of her dogs?`
- `Which country do Calvin and Dave want to meet in?`
- `Which bands has Dave enjoyed listening to?`

Likely system cause:

- participant isolation is still too weak in some public benchmark cases
- adjacent-speaker or pairwise-conversation evidence leaks into the wrong subject lane

### 3. Temporal failures

Pattern:

- evidence exists
- the answer often returns the wrong year or wrong anchored date
- the system frequently prefers a nearby explicit date over the correct historical or relative-time interpretation

Typical examples:

- `When did Melanie paint a sunrise?`
- `When is Jon's group performing at a festival?`
- `When was John in Seattle for a game?`
- `When did Deborah's mother pass away?`
- `When did Calvin first travel to Tokyo?`

Diagnostics reinforce this:

- `temporalAnchorHitRate = 0.318`

Likely system cause:

- temporal anchoring / date selection is underperforming even when the correct evidence neighborhood is found
- relative-time and event-time reasoning are weaker than raw retrieval

### 4. Abstention failures

Pattern:

- the system answers `No authoritative evidence found` or `None`
- but the benchmark expected a grounded answer
- some failures are true zero-evidence misses, but many are false abstentions with evidence present

Typical examples:

- `What did Melanie realize after the charity race?`
- `What martial arts has John done?`
- `What are the names of Jolene's snakes?`
- `What kind of car does Evan drive?`

Likely system cause:

- insufficiency gating is too aggressive in some exact-detail cases
- named-list extraction and preference/favorites style facts are not consistently elevated into final claims

### 5. Commonality synthesis failures

Only one item fell into the explicit `synthesis_commonality` class, but commonality still shows weakness in the miss list.

Example:

- `What kind of interests do Joanna and Nate share?`

Likely system cause:

- overlap synthesis is weaker when the two sides are expressed with different wording and need conceptual intersection rather than literal overlap

## Concrete miss inventory

Representative failed questions from this run:

- `When did Melanie paint a sunrise?`
- `Would Caroline still want to pursue counseling as a career if she hadn't received support growing up?`
- `What did Melanie realize after the charity race?`
- `Which city have both Jean and John visited?`
- `When is Jon's group performing at a festival?`
- `What martial arts has John done?`
- `Who did Maria have dinner with on May 3, 2023?`
- `What might John's financial status be?`
- `What kind of interests do Joanna and Nate share?`
- `What are Joanna's hobbies?`
- `What is one of Joanna's favorite movies?`
- `Which team did John sign with on 21 May, 2023?`
- `What is Tim's position on the team he signed with?`
- `What is an indoor activity that Andrew would enjoy doing while make his dog happy?`
- `What are John's suspected health problems?`
- `What did John adopt in April 2022?`
- `What symbolic gifts do Deborah and Jolene have from their mothers?`
- `What are the names of Jolene's snakes?`
- `What kind of car does Evan drive?`
- `What items did Calvin buy in March 2023?`

## Runtime and harness observations

### LoCoMo partial artifacts

Partial files are expected during the run.

Observed partial:

- `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/locomo-2026-03-29T06-43-44-682Z.partial.json`

This is a progress snapshot, not proof of failure by itself.

### Cleanup pauses

The run showed repeated heartbeat gaps during namespace cleanup between samples.
Those pauses were visible, but the run continued and produced a final artifact.

Implication:

- cleanup latency is noticeable
- but this audit found no evidence that cleanup pauses caused the semantic misses

### DB observations

During runtime inspection on the configured DB:

- there was no lock storm
- there was no obvious blocked-session pileup
- lock mix was minimal:
  - `relation|AccessShareLock|t|1`
  - `virtualxid|ExclusiveLock|t|1`

So this pass did **not** surface lock collisions as the likely cause of LoCoMo semantic misses.

## What looks most important to investigate next

### Highest-confidence problem areas

1. answer shaping from a relevant but overly broad evidence unit
2. subject/entity binding in two-person conversations
3. temporal anchoring and year/date choice
4. false abstention on exact-detail questions
5. low conceptual-overlap quality for commonality questions

### What does **not** currently look like the main problem

- global DB lock contention
- ingest failure
- benchmark process crash
- total retrieval emptiness across the board

## Suggested investigation frame for the next pass

Do not fix by benchmark string. Instead inspect each miss through these buckets:

1. Did retrieval find the right neighborhood?
2. Was the evidence unit too broad?
3. Was the subject mixed with another participant?
4. Was the date anchor chosen incorrectly?
5. Did abstention fire even though answer-bearing evidence existed?
6. Did the benchmark expect an intersection/commonality that the system never synthesized?

## Sign-off for this audit

This document is a first-pass failure audit only.

It establishes:

- where the current LoCoMo misses are
- what benchmark terminology means
- which failure buckets dominate
- that semantic misses are the main issue
- that DB locks and harness stoppage do not appear to be the main cause

No fixes were applied in this pass.
