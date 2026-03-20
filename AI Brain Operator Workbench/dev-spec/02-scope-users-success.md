# 02 — Scope, Users, Success, and Non-Goals

## Primary users

### 1. Operator
The main user.

Needs to:
- create sessions
- upload/paste source material
- run ingest/classify pipelines
- review clarifications
- inspect graph and memory outputs

### 2. Engineer / developer
Needs to:
- inspect request/response payloads
- tune prompts and provider models
- debug failures
- verify state in the brain and model runtime

### 3. Researcher / curator
Needs to:
- organize source material into sessions
- verify extracted relationships
- confirm quality of graph output
- enrich unresolved entities

## Secondary users

### 4. Stakeholder / demo audience
May view the app to understand what the system does, but should not necessarily have access to query/admin powers.

## User capabilities matrix

| Capability | Operator | Engineer | Researcher | Viewer |
|---|---:|---:|---:|---:|
| Create session | Yes | Yes | Yes | No |
| Upload text/audio/files | Yes | Yes | Yes | No |
| Run ASR/classification | Yes | Yes | Maybe | No |
| Load/unload provider models | No or limited | Yes | No | No |
| Review clarifications | Yes | Yes | Yes | No |
| Submit corrections | Yes | Yes | Yes | No |
| View graph | Yes | Yes | Yes | Yes maybe |
| Run read-only SQL | Limited | Yes | No or limited | No |
| View raw request/response payloads | Limited | Yes | Maybe | No |

## MVP scope

### Must have
- session creation and listing
- text intake
- audio upload
- browser audio recording
- file upload surface for PDF/image/audio/text
- per-session detail page
- derivation/classification status
- candidate and review item display
- clarification/correction editor
- per-session graph explorer
- read-only search/timeline/query workbench
- model runtime connectivity page
- job/status/error visibility
- audit trail for operator actions

### Should have
- drag-and-drop multi-file upload
- prompt presets
- request/response viewers
- saved queries
- graph filters
- provenance side panel
- session notes/title/tags

### Could have
- side-by-side before/after reprocessing diff
- batch merge review screen
- semantic similarity view using embeddings
- keyboard shortcuts
- session export

### Won’t have in MVP
- collaborative editing presence
- full role/permission admin system beyond simple gating
- automatic OCR/vision if no backend support exists
- global graph analytics dashboard
- unrestricted DB write access

## Non-goals

These are explicitly not goals for this project:

- replacing the AI Brain runtime with app logic
- turning the app into a generic DB management tool
- allowing operators to “fake memory” by manually editing truth tables directly
- building a public-facing ingestion portal
- exposing MCP as the main transport for the app

## Success metrics

### Product metrics
- session creation succeeds reliably
- ingest completion rate for supported types is high
- operators can resolve ambiguity without engineering help
- graph view loads quickly enough for practical use
- reprocessing updates are visible and attributable

### Technical metrics
- no unauthorized direct write path into core truth tables from the app
- API failures are visible and recoverable
- model runtime integration is observable
- job states are queryable and attached to session history
- read-only query restrictions are enforced

### UX metrics
- an operator can complete the main workflow without external documentation
- operators can explain why a relationship exists by using provenance in the UI
- ambiguity items feel actionable rather than mysterious

## Acceptance framing

The system is considered **useful** when an operator can ingest a real source set and tell a coherent story of:

- what was uploaded
- what text/transcript was derived
- what entities/relationships were detected
- where the system was uncertain
- what they corrected
- how the graph changed after correction

## Constraints

### Functional constraints
- the brain already exists and should remain authoritative
- model runtime is reachable on TailScale
- OCR/image derive path may be incomplete
- sessions must be made first-class

### Team constraints
- the spec should be implementable incrementally
- engineers should not need to guess the intended flow
- the UI should be useful before every provider is perfect

## What “done” means at a product level

At product level, the app is done for MVP when:

1. a human can create and manage sessions
2. text and audio can flow from source to review
3. classification outputs show up as reviewable items
4. corrections can be applied and reprocessed
5. session graph and query screens are usable
6. failures are understandable
7. the app feels like a real operational surface, not a mockup
