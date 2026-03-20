# NotebookLM Repo Status Slide Deck Prompt

Create a slide deck artifact for this project using only the uploaded repository
documents.

Project:

- `AI Brain 2.0`
- local-first Brain 2.0 running on an Apple Silicon Mac

Audience:

- founder / owner
- technical collaborators
- future implementation partners

Primary goal:

- explain what has actually been built in this repository
- show what is verified as working now
- explain how the system thinks during ingestion, retrieval, ranking, memory
  updates, and recall
- show the strongest use cases for the system in its current state
- make the deck technically credible, implementation-grounded, and honest

Important framing:

- this is not a basic RAG app
- this is a PostgreSQL-centered cognitive substrate
- raw artifacts are preserved and remain the durable source of truth
- every durable memory row should point back to evidence
- retrieval is hybrid, not vector-only
- time and relationships are first-class
- current truth and historical truth are handled separately
- the reasoning model is replaceable; the brain is not

Important accuracy rule:

- do not present roadmap items as already complete
- do not overstate the hosted or Supabase path
- keep the deck focused on the verified local brain track
- if something is implemented but not final, say so clearly
- if something is deferred, say so clearly

The deck should answer these questions:

1. What is this local brain?
2. What is already built and working?
3. How does it think and retrieve?
4. What evidence proves that it works?
5. What can someone use it for right now?
6. What is still not final?

Required sections:

1. Vision and positioning
   - explain why this is not basic RAG
   - explain why the architecture is local-first and evidence-centered

2. What exists today
   - local PostgreSQL 18 runtime
   - `pgvector`
   - `timescaledb`
   - `pgvectorscale` / DiskANN
   - `pgai` as an optional controlled sidecar layer
   - artifact registry and provenance
   - markdown / text / transcript ingestion
   - webhook ingestion
   - live Slack event receiver
   - live Discord relay receiver
   - binary artifact registration for image / pdf / audio
   - text-proxy derivations
   - provider-backed derivation route
   - vector sync worker
   - MCP server
   - operator console

3. Memory architecture
   - episodic memory
   - semantic memory
   - procedural memory / active truth
   - relationship memory
   - temporal hierarchy / TMT groundwork
   - why these are separate and what each one is for

4. How the system thinks
   - ingestion preserves raw artifacts first
   - fragments and writes candidate memory rows
   - retrieval planner classifies temporal and historical intent
   - retrieval combines lexical and vector branches
   - BM25 is now the default lexical provider
   - native PostgreSQL FTS remains as fallback and procedural bridge
   - fusion currently happens with app-side RRF
   - conflict resolution uses supersession and active-truth logic
   - forgetting applies to derived memory before source evidence
   - temporal recall uses parent-linked temporal nodes, ancestor budgeting, and
     bounded descendant support

5. Runtime proof and benchmark evidence
   - show that the local substrate is real and running
   - include the benchmark story clearly:
     - BM25 passed `14/14`
     - FTS passed `14/14`
     - BM25 fallback cases `0`
     - BM25 token delta `-17`
     - BM25 is the runtime default on the local track
   - mention evaluation and run-log evidence
   - show that BM25 defaulting was a reasoned decision, not a speculative one

6. Operator and developer visibility
   - show the local operator console
   - explain the current pages and why they matter:
     - overview
     - query
     - eval
     - benchmark
     - jobs
     - artifact detail
   - explain that the console exposes runtime health, provenance, benchmark
     results, and planner behavior

7. Practical use cases
   - historical timeline reconstruction
   - relationship-aware recall
   - preference and active-truth updates over time
   - cross-channel memory from Slack, Discord, markdown, transcripts, and files
   - provenance-based artifact lookup
   - assistant/tool access through MCP
   - operator debugging of retrieval and memory behavior

8. What is strong but not final
   - hybrid retrieval still uses app-side RRF instead of the final SQL-first
     fused kernel
   - real OCR / STT / caption execution is not fully wired to the final live
     backend path
   - the safe multimodal path is still binary artifact plus text proxy, or
     provider-backed derivation
   - TMT is materially improved but not the final full hierarchical descent
     stack
   - broader noisy holdout benchmarks are still pending
   - richer graph visualization is still deferred

9. Why local-first matters
   - local ownership of memory and artifacts
   - durable provenance
   - provider independence
   - reproducibility
   - a brain substrate that can outlive any single model vendor

Style requirements:

- technical, precise, and visually clear
- concise per slide, but not shallow
- architecture-first and implementation-aware
- prefer diagrams, flows, tables, and stacks where helpful
- avoid hype language
- avoid vague claims
- present current truth, not wishful future truth

Closing requirement:

- end with a concise summary of the current value:
  - the local brain substrate is real
  - the main memory classes exist
  - benchmark evidence exists
  - the operator surface exists
  - the remaining work is refinement, deeper multimodal execution, and broader
    validation rather than “core memory is missing”
