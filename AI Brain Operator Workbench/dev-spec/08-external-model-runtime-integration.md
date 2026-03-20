# 08 — External Model Runtime Integration

## Goal

Define how the operator app and/or brain runtime integrate with the external model service available on TailScale.

Base URL:

`http://100.99.84.124:8000/`

## Supported runtime capabilities

The external runtime currently supports:

- model discovery
- model registry inspection
- model load/unload
- ASR transcription
- LLM chat/completions
- embeddings

## Main endpoints

### Discovery
- `GET /v1/models`
- `GET /api/model-registry`
- `GET /api/model-registry/{family}`
- `GET /api/model-registry/{family}/{model_id}`

### Load / unload
- `POST /v1/models/load`
- `POST /v1/models/unload`

### ASR
- `POST /asr/transcribe`

### LLM
- `GET /v1/llm/presets`
- `POST /v1/chat/completions`

### Embeddings
- `POST /v1/embeddings`

## Integration posture

### Default production posture
Operator app → Brain runtime → Model runtime

This is preferred because the brain should remain the orchestrator of ingest/derive/classify/consolidate.

### Direct lab/testing posture
Operator app → Model runtime

This is allowed on the `/models` page for:
- testing prompts
- inspecting model availability
- testing ASR output
- testing embeddings
- load/unload actions

## ASR integration spec

### Endpoint
`POST /asr/transcribe`

### Request
Multipart form-data:
- `file` required
- `model_id` optional
- `response_format` optional, default `json`

### Supported response formats
- `json`
- `text`
- `srt`
- `vtt`

### Required app/brain behavior
For standard session ingestion, use `response_format=json` so timing and metadata are retained.

Store or reference:
- transcript text
- language
- duration
- segments
- words if provided
- model used
- metadata block

### Recommended stored artifacts from ASR
- raw audio artifact
- transcript derivation text artifact or linked text record
- optional subtitle derivations for SRT/VTT if useful
- raw ASR JSON in run metadata or derivation metadata

### UI requirements for ASR
Show:
- transcript text
- segment count
- speaker count if any
- timing metadata
- duration
- language

## LLM integration spec

### Presets endpoint
`GET /v1/llm/presets`

Use this to populate preset selectors and preset preview cards.

### Chat endpoint
`POST /v1/chat/completions`

### Recommended use cases
- classification of transcript/text into candidates
- extraction of entities/relationships
- summarization for session overview
- explanation text for operators in advanced/debug mode

### Required request behavior
For classification:
- `stream: false`
- `response_format: "json"`
- `enable_thinking: false` unless explicitly needed for research mode
- use a strict system prompt instructing the model to emit **valid JSON only** inside assistant content
- validate content before staging

### Important nuance
The endpoint returns an OpenAI-style JSON envelope. Structured classification output is expected to be inside:

`choices[0].message.content`

That means the client or brain must parse the content as JSON and validate it.

### Recommended classification payload design
Send:
- session id
- source ids or artifact ids
- text or transcript chunk(s)
- target schema version
- operator-selected preset or system prompt
- optional classification mode

### LLM response storage
Record:
- model
- preset
- system prompt used
- full request metadata
- full response envelope
- parsed content
- parse success/failure
- usage and metrics

## Embeddings integration spec

### Endpoint
`POST /v1/embeddings`

### Recommended use cases
- retrieval indexing for chunks
- “similar memories” hints
- duplicate candidate hints
- related source suggestions

### Not recommended as primary operator workflow
Embeddings should generally support retrieval and hints, not create truth directly.

### Recommended request defaults
- `model`: `Qwen/Qwen3-Embedding-4B`
- `input_type`: `document`
- `instruction`: `Represent each memory fragment for retrieval and duplicate detection.`
- `dimensions`: `256`
- `normalize`: `true`

### Input shape
- a single string or list of strings
- use chunked text, not giant raw documents

### Recommended chunking
Use ingest fragments of roughly 1–3 sentences or similarly meaningful memory chunks.

## Model load/unload behaviors

### Load
Use before heavy operations if the runtime requires explicit loading.

Example shape:
```json
{
  "family": "llm",
  "model": "unsloth/Qwen3.5-35B-A3B-GGUF",
  "context_length": 100000
}
```

### Unload
Use to free memory when appropriate.

### UI recommendations
On `/models`, show:
- current loaded models
- current context length
- load/unload controls
- warnings before unloading active model needed by a session run

## Current gap: PDF/image derivation

The current model runtime contract does not yet expose a generic OCR/vision derive endpoint equivalent to the audio ASR flow.

Implications:
- PDF/image upload UI can exist now
- PDF/image derivation needs:
  - a new adapter endpoint in the model runtime, or
  - a separate OCR/vision service, or
  - a brain-side processor that handles these file types

### Required app behavior for this gap
If PDF/image is uploaded and no derive path exists:
- store raw artifact
- mark status as pending/awaiting adapter
- do not claim ingest is complete
- allow later retry when adapter is available

## Error handling requirements

Show and record:
- runtime unavailable
- model not loaded
- unsupported model id
- invalid response format
- parse failure
- timeout
- oversized input
- auth failure if auth is enabled

## Acceptance criteria

### ASR
- audio can be sent to runtime
- transcript JSON is stored or attached
- transcript is visible in app

### LLM
- prompts can be selected or edited
- runtime response is stored
- classification parse is validated
- results can be staged/reviewed

### Embeddings
- app or brain can request embeddings for chunk lists
- returned vectors are stored or consumed appropriately
- embeddings are optional for MVP-facing UI

### Models page
- model discovery works
- load/unload works
- presets list works
