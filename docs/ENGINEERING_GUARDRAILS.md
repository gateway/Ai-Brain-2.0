# Engineering Guardrails

## One App, Two Runtime Surfaces

This repository now operates as one product at the repo root:

- `brain-console`: operator-facing Next.js shell
- `local-brain`: runtime, ingestion, memory, and graph service

The operator workbench is one app operationally, even though the UI and runtime stay separated at the code boundary.

## Non-Negotiables

- UI code must not import database drivers directly.
- Operator mutation flows must go through the runtime boundary.
- PDF and image ingestion must stay explicitly adapter-gated until OCR/vision is real.
- Read-only query/debug capability must stay read-only.
- Raw artifacts remain authoritative over derived graph state.
- Replay and scale benchmarks must hold the maintenance advisory lock before destructive reset/rebuild work.
- Runtime worker entry points must honor maintenance mode before mutating the database.
- Source retry actions must still flow through the monitored-source ingestion path, not a side-channel patch to stored graph state.

## Root Commands

- `npm run dev`: start the full app stack locally
- `npm run serve`: start the production-style local stack
- `npm run quality:gates`: run the shared repo quality gates
- `npm run smoke:graph`: run the graph smoke harness

## Immediate Quality Focus

- preserve truth-state across intake and review
- prevent UI state from implying background work that cannot happen
- keep graph interactions stable under zoom, selection, and re-rooting
- harden upload validation beyond extension-only checks

## Audit Notes

### 2026-03-21

- Added maintenance-mode enforcement for direct runtime worker entry points after the master audit found the HTTP layer was protected but direct CLI worker calls could still mutate during replay benchmarks.
- Validation: `npm run check --workspace local-brain`, `npm run quality:gates`, and live maintenance smoke returning `503` on mutating routes.
