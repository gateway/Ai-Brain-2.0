# Supabase Spec Self-Critique

## Overall Rating

Current self-rating:

- `8.2/10`

Confidence after revision:

- `86%`

## What I Think Is Strong

- the hosted architecture is cleanly separated from the local reference path
- Edge Functions, Storage, Postgres, and provider abstraction are assigned to
  the right roles
- the document does not pretend Supabase is identical to the local full brain
- OpenRouter is included as an optional provider layer without being treated as
  the architecture itself

## What Is Still Weaker Than The Local Spec

### 1. Extension parity

This is the biggest weakness.

The local full brain wants:

- TimescaleDB
- `pgvectorscale`
- `pgai`
- advanced BM25 packaging

Supabase official support is much clearer for:

- `pgvector`
- `pg_cron`
- Edge Functions
- Storage

It is much less clear, or not confirmed from official docs, for:

- `pgvectorscale`
- `pgai`
- ParadeDB as a seamless primary-DB BM25 path

### 2. Free-tier expectations

The free tier is fine for prototyping.

It is not a safe assumption for:

- heavy vector indexing
- frequent background summarization
- long-running ingest jobs
- rich media-heavy pipelines

### 3. Edge Function overuse

NotebookLM tends to push a lot of logic into Edge Functions.

That is directionally useful, but risky in practice.

Heavy jobs should move to:

- external workers
- queues
- scheduled processes outside the request path

## Was NotebookLM Queried The Right Way?

Mostly yes.

What worked:

- asking for clear separation between Postgres, Edge Functions, and workers
- asking for critiques of the hosted path instead of only positive designs

What needed correction:

- notebook answers assumed Timescale and `pgvectorscale` too freely in the
  Supabase path
- notebook answers were too optimistic about Edge Functions doing everything

## What Still Needs Verification

- exact official extension availability for the desired hosted stack
- the best hosted BM25 path
- realistic free-tier limits for this workload
- whether MCP should live in Edge Functions or a separate service

## What I Would Do Differently If Starting Again

- verify official Supabase extension support earlier
- separate hosted from local sooner
- push harder on operational constraints instead of just schema design

## Final Judgment

The hosted spec is useful and realistic enough to guide a Supabase prototype.

It is not as mature or as capable as the local full-brain track, and the docs
should continue to say that explicitly.
