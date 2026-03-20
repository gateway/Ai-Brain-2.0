# 12 — Security, Config, and Non-Functional Requirements

## Goal

Define production-minded requirements that keep the app safe and operable.

## Auth and access

MVP auth can be simple, but there must be some gate if the app exposes:
- session data
- model runtime controls
- SQL workbench
- raw artifacts

Recommended minimum:
- app-level login or network restriction
- role gating for query/model/audit/settings pages

Suggested roles:
- `viewer`
- `operator`
- `engineer`
- `admin`

## Secrets and endpoints

The app should not hardcode secrets in client bundles.

Use server-side env/config for:
- brain runtime base URL
- model runtime base URL
- API keys if enabled
- feature flags

Example env values:
- `BRAIN_BASE_URL`
- `MODEL_RUNTIME_BASE_URL`
- `MODEL_RUNTIME_API_KEY`
- `ENABLE_SQL_WORKBENCH`
- `ENABLE_DIRECT_MODEL_LAB`
- `ENABLE_PDF_IMAGE_DERIVATION`

## Network considerations

The model runtime is on TailScale.

Implications:
- the app host must be able to reach `100.99.84.124:8000`
- if browser-to-runtime direct calls are used, CORS and network reachability must be handled
- safer default is server-side proxying through the operator app backend

## Query safety

SQL mode must be read-only.

Minimum protections:
- allow only `SELECT`/safe CTEs
- reject write keywords
- enforce row limit
- enforce execution timeout
- log all executions

Prefer querying safe views instead of raw sensitive tables when possible.

## File upload constraints

Define and enforce:
- allowed mime types
- max file size
- max files per batch
- storage location
- naming strategy
- virus scanning if the environment requires it later

## Logging and audit

The app must log:
- session creation
- uploads
- model runs triggered
- correction actions
- query executions
- load/unload actions
- failures

Logs should distinguish:
- operator action
- app error
- brain runtime error
- provider runtime error

## Performance requirements

### Session list
Should load quickly with pagination.

### Intake submit
Must show immediate feedback even for long-running downstream work.

### Graph page
Should render initial session graph without requiring full global graph fetch.

### Query page
Should cap rows and avoid huge browser renders.

## Reliability requirements

- failed jobs should be retryable where safe
- partial session success should be allowed
- app should remain usable when one file in a batch fails
- provider runtime outages should not corrupt session state

## Observability

Recommended observability:
- request ids
- correlation ids across app → brain → model runtime
- per-run timing
- error classification
- health indicators on dashboard

## Configuration requirements

The app should support configurable:
- default models/presets
- graph max nodes
- SQL row limit
- upload limits
- enabled page/modules
- provider timeout values

## Security requirements

- sanitize file names for storage/display
- validate all mutation input
- protect prompt/query editors against accidental leakage through client logs
- prevent reflected raw HTML rendering from uploaded content
- ensure artifact download/preview routes are permission aware

## Data retention

Retain:
- session records
- operator actions
- model run metadata
- artifacts and derivations according to brain policy

Allow archival, not destructive deletion, in MVP unless business rules require delete.

## Non-functional acceptance criteria

- app can be configured without code edits
- all unsafe query attempts are blocked
- failures are observable
- operator actions are auditable
- app remains responsive during long-running jobs
- session data is not lost on refresh or navigation
