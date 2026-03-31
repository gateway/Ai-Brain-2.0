# Personal OMI Test Loop

This document captures the current repeatable loop for testing AI Brain against
live personal OMI data instead of only public benchmarks.

## Current workflow

1. Sync the latest OMI conversations into the repo-local archive:

```bash
cd /Users/evilone/Documents/Development/AI-Brain/ai-brain
npm run omi:sync
```

2. Reset `personal` before a serious validation run:

```bash
cd /Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain
npm run namespace:reset -- --namespace-id personal
```

This reset now preserves the namespace owner/self binding by default so clean
replay wipes derived memory state without silently dropping `Steve`-anchored
relationship expectations.

3. Confirm the monitored source for the `personal` namespace points at:

```text
/Users/evilone/Documents/Development/AI-Brain/ai-brain/data/inbox/omi/normalized
```

4. Replay all configured sources for `personal`:

```bash
cd /Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain
npm run namespace:replay -- --namespace-id personal --force
```

5. Rebuild typed memory for `personal`:

```bash
cd /Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain
npm run typed-memory:rebuild -- --namespace-id personal
```

6. Force an import into `personal` when needed:

```bash
cd /Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain
npm run source:import -- --source-id 019d1036-1c85-78f9-86ef-5e844ae86273
```

7. Run the repo-normalized OMI smoke benchmark:

```bash
cd /Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain
npm run benchmark:omi-watch
```

8. Run the personal review benchmark:

```bash
cd /Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain
npm run benchmark:personal-omi-review
```

## What the personal review is checking

The current review pack is still product-focused, but it now also probes:

- alias-heavy relationship identity
- multi-person relationship summaries
- clarification-driven alias resolution
- canonical place/entity alias collapse
- temporal exact-detail
- relationship change + timing
- relationship history current vs historical truth
- current active project recall
- person + relative time + fact recall
- project idea recall
- yesterday recap / yesterday talk recap
- warm-start startup pack recall

The benchmark file is:

- `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/benchmark/personal-omi-review.ts`

The continuity companion benchmark is:

- `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/benchmark/personal-openclaw-review.ts`

## Current findings

Fresh synced OMI data is reaching the `personal` namespace correctly, and the
current live personal review is green after clean replay + typed rebuild:

- `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/personal-omi-review-2026-03-28T15-27-04-303Z.json`
- summary: `29 pass / 0 warning / 0 fail`

What improved in the latest slice:

- relationship identity queries are now grounded in trusted OMI rows
- `Who is Uncle?` now resolves through explicit alias evidence to `Billy Smith`, with `Joe Bob` preserved as a nickname alias
- Lauren departure timing resolves to `October 18, 2025`
- current active projects resolve to `Well Inked`, `Two Way`, `Preset Kitchen`, and `AI Brain`
- the relationship-change query now returns the supported Lauren change and date instead of abstaining
- `What movie did Dan mention two weeks ago, and where did he mention it?` now returns `Sinners` plus an inferred absolute date (`13 March 2026`) and the Korean barbecue context in Thailand
- `What project idea did Ben and I discuss, and what was the idea exactly?` now returns the latest OMI-backed `Context Suite` memoir-engine answer instead of a weak community-summary fallback
- the clean replay caught a real regression where a newer unrelated OMI summary row stole the Ben query; the fix was a narrow typed project-idea support loader, and the benchmark only turned green again after the exact query returned the compact `Context Suite` claim from clean state
- `memory.get_relationships` now returns usable typed OMI-backed relationship rows for `Dan`, `John`, `Lauren`, and `James` after clean replay
- `memory.get_relationships("James")` now preserves the real place association as `Lake Tahoe` after canonical normalization
- `memory.get_relationships("Ben")` now stays on Ben-local evidence and returns a compact friend/Well Inked/Burning Man profile instead of inheriting other people’s places
- `memory.get_relationships("Omi")` now returns a usable friend + `Two Way` relationship bundle without noisy fake object nodes from ASR fragments
- direct John relationship checks now normalize the place/object side to `Samui Experience` and `Koh Samui` instead of leaving a `Kozimui` split in the live result
- `memory.get_graph("Kozimui")` now resolves the requested entity back to the canonical `Koh Samui` graph node instead of leaving the atlas split
- exact alias recall is now source-backed for `What is Kozimui?`, not just correct by string normalization
- clarification-driven canonical identity work now keeps `uncle`, `Billy Smith`, and `Joe Bob` anchored to one person after clean replay
- relationship-history queries now expose current vs historical truth more cleanly instead of flattening everything into a single timeless profile
- direct atlas/graph payloads now include historical status and validity windows so the dashboard can distinguish active vs historical edges
- the latest OMI note about yesterday's work is now live in `personal`, and `What did I do yesterday?` returns a shaped recap grounded in that note instead of `## Metadata`
- the daily recap path now surfaces work on `AI Brain`, `Preset Kitchen`, `Bumblebee`, `Well Inked`, and `Two Way` from the new note
- `What did I talk about yesterday?` now returns a shaped recap grounded in the same note instead of collapsing onto transcript headings
- `What should you know about me to start today?` now returns a warm-start pack with current focus plus recent recap context instead of being routed into the purchase lane
- James relationship queries now keep both `Burning Man` and `Lake Tahoe` in the supported answer from clean replay
- `What did I buy today and what were the prices?` now returns a typed, source-backed item list plus the honest total when only the total is grounded
- `What movies have I talked about?` now returns grounded titles from the typed media lane instead of generic transcript sludge
- the new OMI food/beer note is now live in `personal`, and typed preference extraction
  preserves grounded food-only facts plus ranked Thai beer preferences from it
- `What food did I like?` now returns `spicy food` and `Nachos`
- `What are my favorite beers in Thailand?` now returns `Leo, Singha, Chang`
  in ranked order from the same note
- `What do I like and dislike?` now uses typed self-bound preference facts from
  multiple recent OMI notes and returns a compact cross-note profile including
  `spicy food`, `Nachos`, `hiking`, `MacBook Pros`, `snowboarding`,
  `Windows machines`, `mushy vegetables`, and `Android phones`
- `What is my current daily routine?` now returns a shaped routine answer from
  the latest OMI note instead of a raw transcript chunk
- `What changed with Lauren, and when?` now routes through typed
  `person_time_facts` and returns the `October 18, 2025` change plus
  `stopped talking after that`
- direct single-person relationship questions now use a narrow typed temporal
  relationship lane:
  - `Who is Dan in my life right now, exactly?`
  - returns a compact current-state answer without regressing broader profile
    questions
- after looping on regressions, the temporal relationship lane is now settled:
  - direct typed routing is only for current/profile questions about one person
  - history/change questions stay on the broader evidence path because those
    answers need richer timeline support than compact relationship rows alone
  - `former_partner_of` is treated as current-profile truth, which is why
    `Who is Lauren in my life right now, exactly?` now stays correct after
    clean replay
- `What is Steve's history with Lauren?` stays broad and historical, and still
  returns the ordered Tahoe -> Bend -> Thailand -> October 18, 2025 history
  chain after the new direct relationship routing was added
- `When did Steve and Lauren stop talking?` now stays stable from clean replay
  and returns the same `October 18, 2025` transition date as the broader
  Lauren-change question
- daily recap synthesis now leads with readable temporal-summary text before
  descending to leaf notes when more detail is required
- `What should you know about me to start today?` now includes current routine
  and stable preferences in addition to current focus and recent recap context
- monitored-source imports now rebuild typed memory, rerun relationship consolidation/adjudication, and refresh temporal summaries automatically, which is why the OMI watch graph stays green after a clean replay
- metadata-like OMI front matter is now filtered before typed extraction, which
  stopped `source:`, `conversation id`, `category`, and similar lines from
  polluting `person_time_facts`, `media_mentions`, and `preference_facts`
- `What habits or constraints matter right now?` now routes through a typed
  routine/constraint lane and returns the current daily routine plus the
  protect-personal-time constraint
- `What do I like and dislike?` now includes `mountain biking` in the stable
  typed profile after widening positive preference coverage
- `What changed with Lauren, and when?` now keeps the stronger supported
  relationship-transition wording:
  - `stopped talking after that and haven't really talked since`
- `What important relationship transition should I know about right now?` now
  returns the same supported Lauren transition from a startup-focused query
  lane instead of forcing that context to be inferred from broader history

The remaining product work is no longer this first OMI review pack. The next
loop should focus on widening the gold questions while keeping this pack green.

## Current artifacts

Current review outputs:

- `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/omi-watch-smoke-2026-03-28T03-00-43-499Z.json`
- `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/omi-watch-smoke-2026-03-28T15-32-13-991Z.json`
- `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/personal-omi-review-2026-03-28T15-27-04-303Z.json`
- `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/mcp-production-smoke-2026-03-28T15-28-13-695Z.json`
- `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/canonical-identity-review-2026-03-28T15-30-49-517Z.json`
- `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/personal-openclaw-review-2026-03-28T15-29-48-285Z.json`
- `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/session-start-memory-2026-03-28T15-30-49-013Z.json`
- `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/profile-routing-review-2026-03-28T15-32-14-132Z.json`
- `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/recursive-reflect-review-2026-03-28T15-32-30-902Z.json`
- `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/public-memory-miss-regressions-2026-03-28T15-32-31-064Z.json`

## Interpretation rule

Treat the personal review pack as the real product signal.

- If evidence is present but the claim is wrong, that is a reader/claim-selection problem.
- If both evidence and claim are missing, that is a retrieval/indexing problem.
- If the claim is correct but confidence or provenance is weak, that is a support-quality problem.

## Certification status

As of `2026-03-29`, this loop is no longer just an exploratory product signal.
It is part of the frozen `98%` certification gate.

Final certification artifact:

- `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/certification-98-2026-03-29T04-35-20-409Z.json`
- `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/certification-98-2026-03-29T04-35-20-409Z.md`

Important note:

- the purchase benchmark was stabilized to an absolute-date query
  (`March 28, 2026`) so certification does not drift when the calendar day
  changes
- the sign-off signal is the full certification harness, not a standalone
  rerun after larger-validation benchmarks have injected noisy life-scale/life-replay
  artifacts into `personal`
