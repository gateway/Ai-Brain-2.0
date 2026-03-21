# Omi Sync And Source Monitor Tools

This document describes the Omi-to-AI-Brain ingestion toolchain in tool-sized sections so another LLM or operator can set it up without reverse engineering the repo.

## System Model

Use this source-of-truth order:

1. Omi conversation payload in the Omi API
2. Local archived raw payload under `data/inbox/omi/raw`
3. Local normalized transcript markdown under `data/inbox/omi/normalized`
4. AI Brain database artifacts, fragments, candidates, and derived memory

The database is intentionally derived state. If the brain is wiped and replayed later, the local Omi archive remains the durable evidence boundary.

## Tool 1: Omi Sync CLI

**What it does**

`tools/omi-sync/sync_omi.py` pulls completed Omi conversations from the Omi Developer API and writes:

- immutable raw JSON payloads
- normalized markdown transcript files that AI Brain can ingest
- a local incremental sync state file so repeated runs only pull what changed

**Where the API key comes from**

In the Omi mobile app, go to:

- `Settings`
- `Developer`
- `Create Key`

Omi docs reference the personal Developer API for fetching conversations. The endpoint used here is:

- `GET https://api.omi.me/v1/dev/user/conversations?include_transcript=true`

**How to use it**

Run directly:

```bash
cd /Users/evilone/Documents/Development/AI-Brain/ai-brain
python3 tools/omi-sync/sync_omi.py --api-key "$OMI_API_KEY"
```

Or use environment variables:

```bash
cd /Users/evilone/Documents/Development/AI-Brain/ai-brain
export OMI_API_KEY=omi_dev_your_key_here
python3 tools/omi-sync/sync_omi.py
```

Useful flags:

- `--full-sync`: backfill all completed conversations
- `--dry-run`: fetch and compare without writing files
- `--limit 100`: batch size per API page
- `--overlap-days 7`: re-check a trailing window so late transcript edits are still caught
- `--output-root <path>`: change the archive root
- `--state-path <path>`: change where sync state is stored

**What setup needs to be done**

Minimum:

1. Have Python 3 available on the Mac.
2. Get an Omi Developer API key from the mobile app.
3. Export `OMI_API_KEY` or pass `--api-key`.

No extra Python packages are required. The script uses only the standard library.

**Where the data is stored**

The default output root is:

```text
/Users/evilone/Documents/Development/AI-Brain/ai-brain/data/inbox/omi
```

Files created:

- `data/inbox/omi/raw/YYYY/MM/DD/<timestamp>__omi__<conversation_id>.json`
- `data/inbox/omi/normalized/YYYY/MM/DD/<timestamp>__omi__<conversation_id>.md`
- `data/inbox/omi/state.json`

**How incremental sync works**

First run:

- paginates through all completed conversations returned by Omi
- writes raw JSON and normalized markdown for each conversation

Later runs:

- uses the most recent synced `started_at` as a cursor
- subtracts a configurable overlap window
- re-queries only that recent slice
- hashes the returned payload and only rewrites files when the payload actually changed

This prevents constant full re-download while still catching late transcript updates.

## Tool 2: Omi Sync Wrapper

**What it does**

`scripts/run_omi_sync.sh` is the local wrapper that:

1. loads `.env`
2. runs the Omi sync CLI
3. optionally triggers an immediate AI Brain monitored-source scan/import for the configured source

This is also exposed as:

```bash
npm run omi:sync
```

**How to use it**

```bash
cd /Users/evilone/Documents/Development/AI-Brain/ai-brain
npm run omi:sync
```

Dry run:

```bash
cd /Users/evilone/Documents/Development/AI-Brain/ai-brain
npm run omi:sync -- --dry-run
```

Full backfill:

```bash
cd /Users/evilone/Documents/Development/AI-Brain/ai-brain
npm run omi:sync -- --full-sync
```

**What setup needs to be done**

Add these to local `.env`:

```bash
OMI_API_KEY=omi_dev_your_key_here
OMI_API_BASE_URL=https://api.omi.me/v1/dev/user/conversations
OMI_SYNC_IMPORT_AFTER_SYNC=false
OMI_SYNC_SOURCE_ID=
```

If `OMI_SYNC_IMPORT_AFTER_SYNC=true`, then `OMI_SYNC_SOURCE_ID` must be set to a valid monitored source UUID in AI Brain.

When that flag is enabled, the wrapper does not wait for the source to become due. It forces:

1. a scan of the configured source
2. an immediate import of any new or changed files

**Where the data is stored**

The wrapper uses the same archive root as the CLI:

- `data/inbox/omi/raw`
- `data/inbox/omi/normalized`
- `data/inbox/omi/state.json`

**Operational note**

This wrapper is the easiest thing to run from cron or `launchd`.

Example daily cron:

```cron
0 21 * * * cd /Users/evilone/Documents/Development/AI-Brain/ai-brain && /usr/bin/env npm run omi:sync >> /tmp/ai-brain-omi-sync.log 2>&1
```

Hourly is a better MVP cadence if you want quicker availability.

## Tool 3: Monitored Source Record

**What it does**

A monitored source record tells AI Brain:

- which folder to watch
- which namespace to ingest into
- whether monitoring is enabled
- what cadence to use

For Omi, the monitored source should point at the normalized transcript folder, not the raw JSON folder.

**Where to point it**

```text
/Users/evilone/Documents/Development/AI-Brain/ai-brain/data/inbox/omi/normalized
```

**Recommended setup**

- label: `Omi Sync`
- source type: `folder`
- namespace: `personal`
- include subfolders: enabled
- monitor enabled: enabled
- scan schedule: `every_30_minutes`
- notes: `Omi transcript sync archive for personal voice notes and journaling.`

**How to create it**

From the app UI:

- open `/sources`
- add a trusted folder
- save the source

From the runtime HTTP API:

```bash
curl -X POST http://127.0.0.1:8787/ops/sources \
  -H 'Content-Type: application/json' \
  -d '{
    "source_type":"folder",
    "namespace_id":"personal",
    "label":"Omi Sync",
    "root_path":"/Users/evilone/Documents/Development/AI-Brain/ai-brain/data/inbox/omi/normalized",
    "include_subfolders":true,
    "monitor_enabled":true,
    "scan_schedule":"every_30_minutes",
    "notes":"Omi transcript sync archive for personal voice notes and journaling.",
    "metadata":{"source_intent":"ongoing_folder_monitor","producer":"omi_sync"}
  }'
```

**Where the monitored-source data is stored**

In Postgres under the ops tables:

- `ops.monitored_sources`
- `ops.monitored_source_files`
- `ops.source_scan_runs`
- `ops.source_import_runs`

Those tables track the folder, discovered files, scan results, import results, and per-file status.

## Tool 4: Source Monitor Worker And Import Path

**What it does**

The source monitor worker scans watched folders for changed `.md` and `.txt` files and imports changed files through the normal brain ingestion path.

This is important:

- the watcher is not a side-channel DB writer
- discovered files still go through the normal artifact ingestion/runtime path

**Available scan schedules**

Current supported cadences are:

- `every_30_minutes`
- `hourly`
- `daily`

The default is `every_30_minutes`.

There are two timing concepts:

1. worker loop interval
   - how often the source-monitor daemon wakes up
   - default runtime value is every `60` seconds
2. source scan cadence
   - how often a given source becomes due
   - per-source values are `every_30_minutes`, `hourly`, or `daily`

**How to use it**

Normal background mode:

- enable the runtime source-monitor worker
- wait for the source to become due

Manual scan:

```bash
curl -X POST http://127.0.0.1:8787/ops/sources/<source_id>/scan \
  -H 'Content-Type: application/json' \
  -d '{}'
```

Manual import:

```bash
curl -X POST http://127.0.0.1:8787/ops/sources/<source_id>/import \
  -H 'Content-Type: application/json' \
  -d '{"trigger_type":"manual"}'
```

Manual worker processing of due sources:

```bash
curl -X POST http://127.0.0.1:8787/ops/sources/process \
  -H 'Content-Type: application/json' \
  -d '{"source_id":"<source_id>"}'
```

Important behavior:

- `POST /ops/sources/process` only processes due sources
- a newly created source may be skipped until it is due
- for immediate smoke tests, use `scan` and then `import`
- the Omi sync wrapper bypasses this delay when `OMI_SYNC_IMPORT_AFTER_SYNC=true`

CLI equivalent:

```bash
cd /Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain
node dist/cli/process-source-monitors.js --source-id <source_id>
```

Immediate scan-and-import CLI:

```bash
cd /Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain
npm run source:import -- --source-id <source_id>
```

**What setup needs to be done**

1. The local-brain runtime must be running.
2. PostgreSQL must be reachable.
3. A monitored source must exist for the Omi normalized folder.
4. The runtime process should be current with the built code.

**Where the imported data ends up**

On successful import, the normalized markdown files become:

- `artifacts`
- `artifact_observations`
- fragment rows
- episodic rows
- staged candidates and narrative claims as applicable

The original raw JSON remains on disk and is not replaced by the database.

## Current Local Omi Setup

This workspace currently has:

- archive root: `/Users/evilone/Documents/Development/AI-Brain/ai-brain/data/inbox/omi`
- normalized ingest root: `/Users/evilone/Documents/Development/AI-Brain/ai-brain/data/inbox/omi/normalized`
- monitored source label: `Omi Sync`
- monitored source id: `019d1036-1c85-78f9-86ef-5e844ae86273`
- monitored source namespace: `personal`
- monitored source schedule: `every_30_minutes`

## Verification Notes

This Omi toolchain has been smoke tested locally:

- Omi API sync pulled completed conversations
- a later sync picked up a new Omi recording without re-importing the unchanged older payloads
- the monitored source scan discovered the normalized markdown files
- the current built import path successfully imported the Omi markdown files into AI Brain

If the HTTP runtime behaves differently from the current CLI build, restart the runtime so it picks up the latest `local-brain` build.

## Notes

- The local archive under `data/inbox/omi` is gitignored.
- The normalized folder may include ignored files like `.DS_Store`; the scan logic ignores them.
- Rotate your Omi API key after testing if you shared it during development.
