# Supabase Confidence And Validation

## Confidence Rating

Current confidence:

- `86%`

## Why Confidence Is Lower Than Local

- extension support is less certain
- operational limits matter more
- the free tier is not representative of the full target brain

## What Must Be Validated First

### 1. Official extension reality

Confirm:

- what Supabase officially supports today
- what must be simulated with baseline Postgres features

### 2. Worker split

Confirm:

- which jobs fit in Edge Functions
- which jobs need external workers

### 3. Retrieval quality

Test:

- native full-text plus `pgvector`
- SQL RRF
- namespace filters
- time-bounded queries

### 4. Cost and latency

Measure:

- cold starts
- retrieval latency
- background job cost
- embedding and adjudication cost through chosen providers

### 5. Hosted query quality

Test:

- timeline questions
- preference-change questions
- relationship questions
- provenance-rich answers

## Acceptance Signals

The Supabase path is viable when it can:

- preserve raw artifacts
- stage and consolidate memory correctly
- answer scoped queries with provenance
- keep latency and cost acceptable
- avoid turning Edge Functions into a bottleneck
