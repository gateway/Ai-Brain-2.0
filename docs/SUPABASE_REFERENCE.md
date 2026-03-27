# Supabase Reference

This repository does not currently use Supabase as its database or auth platform.

AI Brain 2.0 uses:

- local PostgreSQL
- application-owned migrations
- runtime-owned ingestion, retrieval, and worker services

Why this file exists:

- the master quality-audit workflow expects a database reference document
- for this repo, the correct interpretation is “Supabase not applicable”

If the product later gains a Supabase-backed deployment mode, this document should be replaced with the real reference and policy surface for that stack.
