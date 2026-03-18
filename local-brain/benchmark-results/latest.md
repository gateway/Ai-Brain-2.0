# Lexical Benchmark Report

Generated: 2026-03-18T14:30:32.542Z
Namespace: eval_1773844232007_f409851c
Baseline Eval Passed: true

## Summary

- FTS passed: 15/15
- BM25 passed: 15/15
- BM25 token delta: 22
- BM25 fallback cases: 0
- Recommendation: candidate_for_default
- Reason: BM25 matched or exceeded FTS across the expanded lexical stress suite with zero fallback and only a small acceptable token overhead.

## Cases

### chiang_mai_exact_temporal (fts)
- Passed: true
- Result count: 2
- Effective lexical provider: fts
- Lexical fallback used: false
- Top memory type: temporal_nodes
- Top overlap: 0.999
- Approx tokens: 50
- Top content: YEAR rollup Thu Jan 01 2026 00:00:00 GMT+0700 (Indochina Time) -> Fri Jan 01 2027 00:00:00 GMT+0700 (Indochina Time). events=11. roles=import:11. top_entities=Benjamin Williams:1, Chiang Mai:1, Gumi:1, Iceland:1, Icelandic Air:1.

### chiang_mai_exact_temporal (bm25)
- Passed: true
- Result count: 3
- Effective lexical provider: bm25
- Lexical fallback used: false
- Top memory type: temporal_nodes
- Top overlap: 0.999
- Approx tokens: 76
- Top content: YEAR rollup Thu Jan 01 2026 00:00:00 GMT+0700 (Indochina Time) -> Fri Jan 01 2027 00:00:00 GMT+0700 (Indochina Time). events=11. roles=import:11. top_entities=Benjamin Williams:1, Chiang Mai:1, Gumi:1, Iceland:1, Icelandic Air:1.

### chiang_mai_temporal_natural_language (fts)
- Passed: true
- Result count: 4
- Effective lexical provider: fts
- Lexical fallback used: false
- Top memory type: temporal_nodes
- Top overlap: 0.999
- Approx tokens: 88
- Top content: YEAR rollup Thu Jan 01 2026 00:00:00 GMT+0700 (Indochina Time) -> Fri Jan 01 2027 00:00:00 GMT+0700 (Indochina Time). events=11. roles=import:11. top_entities=Benjamin Williams:1, Chiang Mai:1, Gumi:1, Iceland:1, Icelandic Air:1.

### chiang_mai_temporal_natural_language (bm25)
- Passed: true
- Result count: 4
- Effective lexical provider: bm25
- Lexical fallback used: false
- Top memory type: temporal_nodes
- Top overlap: 0.999
- Approx tokens: 84
- Top content: YEAR rollup Thu Jan 01 2026 00:00:00 GMT+0700 (Indochina Time) -> Fri Jan 01 2027 00:00:00 GMT+0700 (Indochina Time). events=11. roles=import:11. top_entities=Benjamin Williams:1, Chiang Mai:1, Gumi:1, Iceland:1, Icelandic Air:1.

### current_relationship_live_query (fts)
- Passed: true
- Result count: 3
- Effective lexical provider: fts
- Lexical fallback used: false
- Top memory type: relationship_memory
- Top overlap: n/a
- Approx tokens: 14
- Top content: Steve lives in Chiang Mai

### current_relationship_live_query (bm25)
- Passed: true
- Result count: 3
- Effective lexical provider: bm25
- Lexical fallback used: false
- Top memory type: relationship_memory
- Top overlap: n/a
- Approx tokens: 14
- Top content: Steve lives in Chiang Mai

### alias_collision_stephen (fts)
- Passed: true
- Result count: 1
- Effective lexical provider: fts
- Lexical fallback used: false
- Top memory type: episodic_memory
- Top overlap: n/a
- Approx tokens: 19
- Top content: Stephen Park handled the summer home repair plan near Tahoe in August 2026 and coordinated the cabin access list.

### alias_collision_stephen (bm25)
- Passed: true
- Result count: 1
- Effective lexical provider: bm25
- Lexical fallback used: false
- Top memory type: episodic_memory
- Top overlap: n/a
- Approx tokens: 19
- Top content: Stephen Park handled the summer home repair plan near Tahoe in August 2026 and coordinated the cabin access list.

### march_redesign_date (fts)
- Passed: true
- Result count: 2
- Effective lexical provider: fts
- Lexical fallback used: false
- Top memory type: episodic_memory
- Top overlap: 1.000
- Approx tokens: 44
- Top content: On March 12 2025 the redesign notes focused on the dashboard timeline UX and the relationship graph layout for the AI brain.

### march_redesign_date (bm25)
- Passed: true
- Result count: 2
- Effective lexical provider: bm25
- Lexical fallback used: false
- Top memory type: episodic_memory
- Top overlap: 1.000
- Approx tokens: 44
- Top content: On March 12 2025 the redesign notes focused on the dashboard timeline UX and the relationship graph layout for the AI brain.

### coffee_active_truth (fts)
- Passed: true
- Result count: 1
- Effective lexical provider: fts
- Lexical fallback used: false
- Top memory type: procedural_memory
- Top overlap: n/a
- Approx tokens: 12
- Top content: preference: coffee brew method = {"value": "pour over", "target": "coffee brew method"}

### coffee_active_truth (bm25)
- Passed: true
- Result count: 1
- Effective lexical provider: bm25
- Lexical fallback used: false
- Top memory type: procedural_memory
- Top overlap: n/a
- Approx tokens: 12
- Top content: preference: coffee brew method = {"value": "pour over", "target": "coffee brew method"}

### spicy_active_truth (fts)
- Passed: true
- Result count: 1
- Effective lexical provider: fts
- Lexical fallback used: false
- Top memory type: procedural_memory
- Top overlap: n/a
- Approx tokens: 13
- Top content: preference: preference:spicy food = {"target": "spicy food", "polarity": "dislike", "source_memory_id": "019d015a-f78a-7327-a6fd-d7bb59b16ff2", "semantic_memory_id": "019d015a-f83d-7336-bd92-a2db927c904c"}

### spicy_active_truth (bm25)
- Passed: true
- Result count: 1
- Effective lexical provider: bm25
- Lexical fallback used: false
- Top memory type: procedural_memory
- Top overlap: n/a
- Approx tokens: 13
- Top content: preference: preference:spicy food = {"target": "spicy food", "polarity": "dislike", "source_memory_id": "019d015a-f78a-7327-a6fd-d7bb59b16ff2", "semantic_memory_id": "019d015a-f83d-7336-bd92-a2db927c904c"}

### sweet_active_truth (fts)
- Passed: true
- Result count: 1
- Effective lexical provider: fts
- Lexical fallback used: false
- Top memory type: procedural_memory
- Top overlap: n/a
- Approx tokens: 13
- Top content: preference: preference:sweet food = {"target": "sweet food", "polarity": "like", "source_memory_id": "019d015a-f78a-7327-a6fd-d7bb59b16ff2", "semantic_memory_id": "019d015a-f83f-73e5-bb69-d742091d2b62"}

### sweet_active_truth (bm25)
- Passed: true
- Result count: 1
- Effective lexical provider: bm25
- Lexical fallback used: false
- Top memory type: procedural_memory
- Top overlap: n/a
- Approx tokens: 13
- Top content: preference: preference:sweet food = {"target": "sweet food", "polarity": "like", "source_memory_id": "019d015a-f78a-7327-a6fd-d7bb59b16ff2", "semantic_memory_id": "019d015a-f83f-73e5-bb69-d742091d2b62"}

### rare_entity_cve (fts)
- Passed: true
- Result count: 1
- Effective lexical provider: fts
- Lexical fallback used: false
- Top memory type: semantic_memory
- Top overlap: n/a
- Approx tokens: 15
- Top content: CVE-2026-3172 is the tracked buffer overflow in the gateway parser and remains open for hardening.

### rare_entity_cve (bm25)
- Passed: true
- Result count: 1
- Effective lexical provider: bm25
- Lexical fallback used: false
- Top memory type: semantic_memory
- Top overlap: n/a
- Approx tokens: 15
- Top content: CVE-2026-3172 is the tracked buffer overflow in the gateway parser and remains open for hardening.

### version_precision_pgvector (fts)
- Passed: true
- Result count: 1
- Effective lexical provider: fts
- Lexical fallback used: false
- Top memory type: semantic_memory
- Top overlap: n/a
- Approx tokens: 15
- Top content: pgvector 0.8.2 release notes mention sparsevec improvements and iterative index scans relevant to hybrid retrieval.

### version_precision_pgvector (bm25)
- Passed: true
- Result count: 1
- Effective lexical provider: bm25
- Lexical fallback used: false
- Top memory type: semantic_memory
- Top overlap: n/a
- Approx tokens: 15
- Top content: pgvector 0.8.2 release notes mention sparsevec improvements and iterative index scans relevant to hybrid retrieval.

### acronym_precision_sqs_dlq (fts)
- Passed: true
- Result count: 1
- Effective lexical provider: fts
- Lexical fallback used: false
- Top memory type: semantic_memory
- Top overlap: n/a
- Approx tokens: 14
- Top content: SQS DLQ setup requires a dead-letter queue redrive policy and explicit retry visibility timeouts.

### acronym_precision_sqs_dlq (bm25)
- Passed: true
- Result count: 1
- Effective lexical provider: bm25
- Lexical fallback used: false
- Top memory type: semantic_memory
- Top overlap: n/a
- Approx tokens: 14
- Top content: SQS DLQ setup requires a dead-letter queue redrive policy and explicit retry visibility timeouts.

### provenance_hash_lookup (fts)
- Passed: true
- Result count: 1
- Effective lexical provider: fts
- Lexical fallback used: false
- Top memory type: artifact_derivation
- Top overlap: n/a
- Approx tokens: 17
- Top content: Artifact hash c6b7e8 points to the retained March 2025 redesign packet with provenance markers and source tracking.

### provenance_hash_lookup (bm25)
- Passed: true
- Result count: 1
- Effective lexical provider: bm25
- Lexical fallback used: false
- Top memory type: artifact_derivation
- Top overlap: n/a
- Approx tokens: 17
- Top content: Artifact hash c6b7e8 points to the retained March 2025 redesign packet with provenance markers and source tracking.

### artifact_ocr_port (fts)
- Passed: true
- Result count: 1
- Effective lexical provider: fts
- Lexical fallback used: false
- Top memory type: artifact_derivation
- Top overlap: n/a
- Approx tokens: 16
- Top content: OCR from the server screenshot shows port 3000 and webhook receiver config for Discord and Slack.

### artifact_ocr_port (bm25)
- Passed: true
- Result count: 1
- Effective lexical provider: bm25
- Lexical fallback used: false
- Top memory type: artifact_derivation
- Top overlap: n/a
- Approx tokens: 16
- Top content: OCR from the server screenshot shows port 3000 and webhook receiver config for Discord and Slack.

### entity_collision_sara (fts)
- Passed: true
- Result count: 1
- Effective lexical provider: fts
- Lexical fallback used: false
- Top memory type: episodic_memory
- Top overlap: n/a
- Approx tokens: 16
- Top content: Sara Alvarez joined the Kyoto dinner in April 2025 to discuss itinerary swaps and transit planning.

### entity_collision_sara (bm25)
- Passed: true
- Result count: 1
- Effective lexical provider: bm25
- Lexical fallback used: false
- Top memory type: episodic_memory
- Top overlap: n/a
- Approx tokens: 16
- Top content: Sara Alvarez joined the Kyoto dinner in April 2025 to discuss itinerary swaps and transit planning.

### abstention_unknown (fts)
- Passed: true
- Result count: 0
- Effective lexical provider: fts
- Lexical fallback used: false
- Top memory type: n/a
- Top overlap: n/a
- Approx tokens: 0
- Top content: 

### abstention_unknown (bm25)
- Passed: true
- Result count: 0
- Effective lexical provider: bm25
- Lexical fallback used: false
- Top memory type: n/a
- Top overlap: n/a
- Approx tokens: 0
- Top content: 

