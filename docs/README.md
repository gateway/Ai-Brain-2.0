# AI Brain 2.0 Docs

This folder is the public documentation surface for AI Brain 2.0.

## Current Checkpoints

If you are resuming active engineering work, start with the current phase state before reading older roadmap or benchmark docs:

1. [PHASE_WRAP_HARDENING_PLAN_2026-03-31.md](/Users/evilone/Documents/Development/AI-Brain/ai-brain/docs/PHASE_WRAP_HARDENING_PLAN_2026-03-31.md)
2. [LOCOMO_REMEDIATION_LOOP_2026-03-29.md](/Users/evilone/Documents/Development/AI-Brain/ai-brain/docs/LOCOMO_REMEDIATION_LOOP_2026-03-29.md)
3. [LOCOMO_FIRST_PASS_AUDIT_2026-03-29.md](/Users/evilone/Documents/Development/AI-Brain/ai-brain/docs/LOCOMO_FIRST_PASS_AUDIT_2026-03-29.md)
4. [PRODUCTION_CONFIDENCE_98.md](/Users/evilone/Documents/Development/AI-Brain/ai-brain/docs/PRODUCTION_CONFIDENCE_98.md)

If you are new to the project, start here:

1. [FIRST_RUN_SETUP.md](/Users/evilone/Documents/Development/AI-Brain/ai-brain/docs/FIRST_RUN_SETUP.md)
2. [BRAIN_FEATURES_AND_EXAMPLES.md](/Users/evilone/Documents/Development/AI-Brain/ai-brain/docs/BRAIN_FEATURES_AND_EXAMPLES.md)
3. [OPERATOR_WORKBENCH_GUIDE.md](/Users/evilone/Documents/Development/AI-Brain/ai-brain/docs/OPERATOR_WORKBENCH_GUIDE.md)
4. [API_REFERENCE.md](/Users/evilone/Documents/Development/AI-Brain/ai-brain/docs/API_REFERENCE.md)
5. [MCP_REFERENCE.md](/Users/evilone/Documents/Development/AI-Brain/ai-brain/docs/MCP_REFERENCE.md)
6. [OPERATIONS_RUNTIME.md](/Users/evilone/Documents/Development/AI-Brain/ai-brain/docs/OPERATIONS_RUNTIME.md)
7. [OMI_SYNC.md](/Users/evilone/Documents/Development/AI-Brain/ai-brain/docs/OMI_SYNC.md)

## Core Documents

- [FIRST_RUN_SETUP.md](/Users/evilone/Documents/Development/AI-Brain/ai-brain/docs/FIRST_RUN_SETUP.md)
  - install, prerequisites, bootstrap, doctor, first launch
- [BRAIN_FEATURES_AND_EXAMPLES.md](/Users/evilone/Documents/Development/AI-Brain/ai-brain/docs/BRAIN_FEATURES_AND_EXAMPLES.md)
  - product overview, examples, what the brain can do
- [OPERATOR_WORKBENCH_GUIDE.md](/Users/evilone/Documents/Development/AI-Brain/ai-brain/docs/OPERATOR_WORKBENCH_GUIDE.md)
  - dashboard sections, operator flows, review surfaces
- [API_REFERENCE.md](/Users/evilone/Documents/Development/AI-Brain/ai-brain/docs/API_REFERENCE.md)
  - current HTTP runtime routes grouped by purpose
- [MCP_REFERENCE.md](/Users/evilone/Documents/Development/AI-Brain/ai-brain/docs/MCP_REFERENCE.md)
  - current MCP tools and their inputs
- [OPERATIONS_RUNTIME.md](/Users/evilone/Documents/Development/AI-Brain/ai-brain/docs/OPERATIONS_RUNTIME.md)
  - workers, monitoring, outbox propagation, temporal summary processing
- [OMI_SYNC.md](/Users/evilone/Documents/Development/AI-Brain/ai-brain/docs/OMI_SYNC.md)
  - Omi conversation sync, local archive layout, and monitored-folder ingestion path

## Architecture And Substrate

- [ARCHITECTURE_ONE_APP.md](/Users/evilone/Documents/Development/AI-Brain/ai-brain/docs/ARCHITECTURE_ONE_APP.md)
- [LIFE_ONTOLOGY.md](/Users/evilone/Documents/Development/AI-Brain/ai-brain/docs/LIFE_ONTOLOGY.md)
- [ROUTING_RULES.md](/Users/evilone/Documents/Development/AI-Brain/ai-brain/docs/ROUTING_RULES.md)
- [FRESH_REPLAY_REGRESSION.md](/Users/evilone/Documents/Development/AI-Brain/ai-brain/docs/FRESH_REPLAY_REGRESSION.md)
- [BRAIN_PHASE_ROADMAP.md](/Users/evilone/Documents/Development/AI-Brain/ai-brain/docs/BRAIN_PHASE_ROADMAP.md)

## Current Phase Docs

- [PHASE_WRAP_HARDENING_PLAN_2026-03-31.md](/Users/evilone/Documents/Development/AI-Brain/ai-brain/docs/PHASE_WRAP_HARDENING_PLAN_2026-03-31.md)
- [LOCOMO_REMEDIATION_LOOP_2026-03-29.md](/Users/evilone/Documents/Development/AI-Brain/ai-brain/docs/LOCOMO_REMEDIATION_LOOP_2026-03-29.md)
- [LOCOMO_FIRST_PASS_AUDIT_2026-03-29.md](/Users/evilone/Documents/Development/AI-Brain/ai-brain/docs/LOCOMO_FIRST_PASS_AUDIT_2026-03-29.md)
- [PRODUCTION_CONFIDENCE_98.md](/Users/evilone/Documents/Development/AI-Brain/ai-brain/docs/PRODUCTION_CONFIDENCE_98.md)
- [TEMPORAL_RECAP_PROFILE_PHASE.md](/Users/evilone/Documents/Development/AI-Brain/ai-brain/docs/TEMPORAL_RECAP_PROFILE_PHASE.md)

## Repository And Engineering

- [GITHUB_REPOSITORY_GUIDE.md](/Users/evilone/Documents/Development/AI-Brain/ai-brain/docs/GITHUB_REPOSITORY_GUIDE.md)
- [ENGINEERING_GUARDRAILS.md](/Users/evilone/Documents/Development/AI-Brain/ai-brain/docs/ENGINEERING_GUARDRAILS.md)

## Utility Areas

- `scripts/`
  - bootstrap, doctor, and runtime launch helpers
- `tools/`
  - small standalone utilities that support adjacent workflows without being part of the core runtime
  - currently includes the Omi sync CLI used to archive and normalize Omi conversations before ingestion

Generated review outputs, synced personal data, and workstation-only artifacts should not be treated as public docs.

## Recommended Reading Order

If you want the fast product understanding path:

1. what the system is
2. how to install and launch it
3. what each major section does
4. how the runtime workers keep it alive over time

Use:

1. [README.md](/Users/evilone/Documents/Development/AI-Brain/ai-brain/README.md)
2. [FIRST_RUN_SETUP.md](/Users/evilone/Documents/Development/AI-Brain/ai-brain/docs/FIRST_RUN_SETUP.md)
3. [OPERATOR_WORKBENCH_GUIDE.md](/Users/evilone/Documents/Development/AI-Brain/ai-brain/docs/OPERATOR_WORKBENCH_GUIDE.md)
4. [API_REFERENCE.md](/Users/evilone/Documents/Development/AI-Brain/ai-brain/docs/API_REFERENCE.md)
5. [MCP_REFERENCE.md](/Users/evilone/Documents/Development/AI-Brain/ai-brain/docs/MCP_REFERENCE.md)
6. [OPERATIONS_RUNTIME.md](/Users/evilone/Documents/Development/AI-Brain/ai-brain/docs/OPERATIONS_RUNTIME.md)
7. [OMI_SYNC.md](/Users/evilone/Documents/Development/AI-Brain/ai-brain/docs/OMI_SYNC.md)
