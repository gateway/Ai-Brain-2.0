# AI Brain Operator App — Programmer Spec Pack

This folder is the implementation handoff for a new operator-facing app that sits on top of **AI Brain 2.0**.

The app is **not** a lightweight demo. It is an **intake, review, correction, and graph-exploration workbench** for the brain.

## What this pack is for

Give this pack to an engineer or engineering team so they can build the app with minimal ambiguity.

It defines:

- product goals
- system boundaries
- routes and pages
- major user workflows
- data model additions
- API contracts
- external model-runtime integration
- UI/UX requirements
- security and operational constraints
- testing and definition of done
- milestone plan

## Naming

Working names for the app:

- **AI Brain Intake Studio**
- **AI Brain Operator Workbench**
- **AI Brain Session Lab**

This spec uses **AI Brain Operator App** as the neutral working title.

## Core decision

The app should talk to the **AI Brain HTTP runtime** for core ingest, derivation, classification, consolidation, retrieval, and relationship operations.

The app should **not** write directly into core brain memory tables for normal workflows.

Direct SQL access is allowed only in a guarded **read-only query workbench**.

## Folder contents

- `01-product-overview.md` — what we are building and why
- `02-scope-users-success.md` — users, goals, non-goals, success criteria
- `03-system-context-and-architecture.md` — how the app fits into AI Brain
- `04-routes-pages-and-user-flows.md` — app IA, routes, and primary flows
- `05-functional-spec-intake-and-sessions.md` — intake/session behavior in detail
- `06-functional-spec-review-clarifications-and-corrections.md` — ambiguity/conflict handling
- `07-functional-spec-graph-query-and-inspection.md` — graph explorer, timeline, query
- `08-external-model-runtime-integration.md` — ASR, LLM, embeddings integration
- `09-data-model-and-state-management.md` — proposed tables, client state, job state
- `10-api-contracts.md` — request/response contracts and orchestration patterns
- `11-ui-ux-and-component-spec.md` — interaction details, components, edge states
- `12-security-config-and-non-functional-requirements.md` — auth, performance, ops
- `13-testing-qa-and-definition-of-done.md` — QA plan and acceptance
- `14-implementation-plan-and-open-questions.md` — milestone plan and unresolved items

## Assumptions

These assumptions are baked into the spec unless changed later:

1. **AI Brain 2.0 is already running** and remains the primary cognitive substrate.
2. The operator app is a **new app** or a substantial new surface, not a tiny patch to the existing console.
3. The app can reach the external model runtime at:

   `http://100.99.84.124:8000/`

4. The model runtime currently supports:
   - ASR
   - LLM chat/completions
   - embeddings
   - model discovery
   - model load/unload

5. The model runtime does **not yet expose a fully generic PDF/image OCR derive endpoint** in the same shape as audio ASR.
6. The app must support **session-based intake and review**.
7. The app must allow **operator correction** of uncertain identity/relationship issues.
8. The app must provide a **graph explorer** and **read-only query view**.

## Recommended stack

- Next.js App Router
- React
- TypeScript
- Tailwind CSS
- shadcn/ui
- TanStack Query
- React Hook Form + Zod
- Cytoscape.js for graph visualization
- Monaco for prompt/query editors
- WaveSurfer or equivalent for audio playback
- Server actions or API routes only where useful; prefer clean browser-to-runtime fetch wrappers through the app server if auth/secrets are involved

## Recommended deployment posture

Two acceptable deployment shapes:

### Option A — separate app
A new standalone operator app, deployed beside the existing brain runtime and console.

### Option B — new surface inside brain-console
A new section added to the existing console codebase if that codebase is already well-structured.

This spec is written so either path works.

## Recommended first milestone

Build the minimum complete operator loop:

1. create session
2. paste text or upload/record audio
3. run ingest
4. run ASR if needed
5. run optional LLM classification
6. review generated candidates and clarifications
7. submit corrections
8. trigger reprocessing/consolidation
9. inspect graph and query results

That loop proves the product.

## Important constraints

- raw evidence must remain durable
- LLM output must not become truth automatically
- corrections should go back into the brain as controlled staged inputs or review actions
- graph rendering should start **per session**, not global-first
- SQL mode must be **read-only**
- PDF/image OCR may require an adapter or secondary worker before full completion

## Deliverables

At the end of implementation, the team should deliver:

- a working operator app
- documented env/config
- tested intake workflows
- tested session review workflows
- tested clarification/correction workflows
- tested graph explorer
- tested query workbench
- tested model-runtime integration
- a short runbook for operators and developers
