# NotebookLM For Codex

**Status:** Local workspace integration
**Source:** Adapted from `notebooklm-py` v0.3.4 skill and agent guidance

## Purpose

Use NotebookLM from this workspace through the isolated virtual environment at
`/Users/evilone/Documents/Development/AI-Brain/ai-brain/.venv-notebooklm`.

Codex should use these instructions when the user explicitly mentions NotebookLM
or asks to:

- list or inspect notebooks
- add sources to a notebook
- query notebook content
- run NotebookLM chat or research flows
- generate NotebookLM artifacts such as audio, video, quizzes, reports, mind maps, or flashcards

## Environment

Always enter the local environment before running NotebookLM commands:

```bash
cd /Users/evilone/Documents/Development/AI-Brain/ai-brain
source ./use_notebooklm_env.sh
```

This sets:

- `python` to the local venv interpreter
- `NOTEBOOKLM_HOME` to `/Users/evilone/.notebooklm` by default

Do not install or use another Python environment for NotebookLM in this repo.
Do not set a workspace-local `PLAYWRIGHT_BROWSERS_PATH`; use the shared system Playwright browser cache.

## Local Paths

- Helper script: `/Users/evilone/Documents/Development/AI-Brain/ai-brain/use_notebooklm_env.sh`
- NotebookLM checkout: `/Users/evilone/Documents/Development/AI-Brain/ai-brain/notebooklm-py`
- Shared auth/config home: `/Users/evilone/.notebooklm`
- Project skill files:
  - `/Users/evilone/Documents/Development/AI-Brain/ai-brain/.claude/skills/notebooklm/SKILL.md`
  - `/Users/evilone/Documents/Development/AI-Brain/ai-brain/.agents/skills/notebooklm/SKILL.md`

## Verification

Before running real NotebookLM work, verify the CLI from this workspace:

```bash
cd /Users/evilone/Documents/Development/AI-Brain/ai-brain
source ./use_notebooklm_env.sh
python --version
notebooklm auth check
notebooklm list --json
```

If auth is missing or expired, run:

```bash
cd /Users/evilone/Documents/Development/AI-Brain/ai-brain
source ./use_notebooklm_env.sh
notebooklm login
```

## Operating Rules

- Prefer `notebooklm` CLI commands over ad hoc scripts for standard notebook operations.
- Prefer `--json` when Codex needs to parse IDs or structured results.
- Prefer explicit notebook IDs over `notebooklm use` when a workflow may become parallel or automated.
- Treat `NOTEBOOKLM_HOME` contents as sensitive because they include Google session cookies.
- Keep NotebookLM auth in `/Users/evilone/.notebooklm` rather than this repo.
- Ask before destructive commands such as notebook deletion, source deletion, or artifact deletion.
- Ask before long-running generation or download commands unless the user has clearly requested them.

## Common Commands

```bash
source ./use_notebooklm_env.sh
notebooklm list
notebooklm list --json
notebooklm create "AI Brain Research"
notebooklm source add "https://example.com" --notebook <notebook_id>
notebooklm ask "Summarize the core ideas" --notebook <notebook_id>
notebooklm ask "Summarize the core ideas" --notebook <notebook_id> --json
notebooklm source list --notebook <notebook_id>
notebooklm generate report --format briefing-doc --notebook <notebook_id>
notebooklm download report ./report.md -n <notebook_id>
```

## Parallel Safety

When multiple agents or automations may run at once:

- pass `--notebook <full_uuid>` where supported
- use `-n <full_uuid>` for wait and download commands
- avoid relying on shared notebook context files
- prefer full UUIDs over partial IDs

## Notes For Codex

Codex should treat this repository root `AGENTS.md` as the local NotebookLM integration guide.
The upstream repository at `/Users/evilone/Documents/Development/AI-Brain/ai-brain/notebooklm-py`
contains the original package source, but NotebookLM commands for this workspace should run through
the local helper script and venv first.
