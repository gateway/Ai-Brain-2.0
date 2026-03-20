# GitHub Repository Guide

This repository is intended to publish the product and engineering surface of AI Brain 2.0, not the local research workstation state used while building it.

## What belongs in GitHub

- product code in `brain-console`
- runtime code in `local-brain`
- stable setup and operator docs in `docs`
- architecture and run-log material in `brain-spec`
- scripts required to bootstrap, verify, and run the app
- representative examples that explain how the brain works

## What stays local

The following should remain local-only and should not be part of the public repository:

- local `.env` files and secrets
- local Python virtual environments
- NotebookLM auth state, browser profiles, and mirrored exports
- Playwright logs, screenshots, and scratch output
- generated benchmark and eval outputs
- personal-only artifacts and inbox files
- Codex or Claude local skill wiring that only exists to operate this workspace

## Public repo posture

The public-facing repository should make these things clear:

1. What AI Brain 2.0 is
2. What it can do
3. How to install it on a new machine
4. How to run the dashboard and runtime
5. How local runtime vs OpenRouter works
6. How OpenClaw-style markdown sources can be imported
7. Where to look next for operator docs, architecture docs, and runtime docs

## Recommended repo entry points

- [README.md](/Users/evilone/Documents/Development/AI-Brain/ai-brain/README.md)
- [docs/FIRST_RUN_SETUP.md](/Users/evilone/Documents/Development/AI-Brain/ai-brain/docs/FIRST_RUN_SETUP.md)
- [docs/BRAIN_FEATURES_AND_EXAMPLES.md](/Users/evilone/Documents/Development/AI-Brain/ai-brain/docs/BRAIN_FEATURES_AND_EXAMPLES.md)
- [docs/OPERATOR_WORKBENCH_GUIDE.md](/Users/evilone/Documents/Development/AI-Brain/ai-brain/docs/OPERATOR_WORKBENCH_GUIDE.md)
- [docs/OPERATIONS_RUNTIME.md](/Users/evilone/Documents/Development/AI-Brain/ai-brain/docs/OPERATIONS_RUNTIME.md)

## Repository organization

- `brain-console`
  - Next.js operator-facing application
- `local-brain`
  - runtime, ingestion, retrieval, graph, clarification, and worker services
- `docs`
  - install, operator, runtime, ontology, and routing documentation
- `brain-spec`
  - deep architecture notes and run logs
- `scripts`
  - bootstrap, doctor, dev, serve, quality, and operations helpers

## Release intent

The goal is for a new contributor to be able to:

1. clone the repo
2. read the top-level README
3. run the Mac bootstrap script
4. run the doctor
5. launch the app
6. complete first-run setup in the dashboard

If the repo does not make that path obvious, the repo still needs cleanup.
