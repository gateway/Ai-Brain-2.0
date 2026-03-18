# Lexical Benchmark Report

Generated: 2026-03-18T05:22:42.513Z
Namespace: eval_1773811362221_c4d0d053
Baseline Eval Passed: true

## Summary

- FTS passed: 12/13
- BM25 passed: 12/13
- BM25 token delta: 0
- Recommendation: keep_feature_gated
- Reason: Keep BM25 behind a flag until it clears the expanded lexical stress suite and baseline eval remains clean.

## Cases

### japan_exact_temporal (fts)
- Passed: true
- Result count: 5
- Top memory type: temporal_nodes
- Approx tokens: 135
- Top content: MONTH rollup Sun Jun 01 2025 00:00:00 GMT+0700 (Indochina Time) -> Tue Jul 01 2025 00:00:00 GMT+0700 (Indochina Time). events=2. roles=import:2. top_entities=Ken:2, Kyoto:2, Sarah:2, Japan:1, Steve:1.

### japan_exact_temporal (bm25)
- Passed: true
- Result count: 5
- Top memory type: temporal_nodes
- Approx tokens: 135
- Top content: MONTH rollup Sun Jun 01 2025 00:00:00 GMT+0700 (Indochina Time) -> Tue Jul 01 2025 00:00:00 GMT+0700 (Indochina Time). events=2. roles=import:2. top_entities=Ken:2, Kyoto:2, Sarah:2, Japan:1, Steve:1.

### relationship_context_kyoto (fts)
- Passed: false
- Result count: 2
- Top memory type: memory_candidate
- Approx tokens: 62
- Top content: In June 2025 Steve was in Japan with Sarah and Ken. They spent time in Tokyo and Kyoto together. The trip included shared dinners, transit days, and travel notes worth preserving.
- Failures: expected top memory type episodic_memory, got memory_candidate

### relationship_context_kyoto (bm25)
- Passed: false
- Result count: 2
- Top memory type: memory_candidate
- Approx tokens: 62
- Top content: In June 2025 Steve was in Japan with Sarah and Ken. They spent time in Tokyo and Kyoto together. The trip included shared dinners, transit days, and travel notes worth preserving.
- Failures: expected top memory type episodic_memory, got memory_candidate

### march_redesign_date (fts)
- Passed: true
- Result count: 5
- Top memory type: episodic_memory
- Approx tokens: 114
- Top content: On March 12 2025 the redesign notes focused on the dashboard timeline UX and the relationship graph layout for the AI brain.

### march_redesign_date (bm25)
- Passed: true
- Result count: 5
- Top memory type: episodic_memory
- Approx tokens: 114
- Top content: On March 12 2025 the redesign notes focused on the dashboard timeline UX and the relationship graph layout for the AI brain.

### coffee_active_truth (fts)
- Passed: true
- Result count: 1
- Top memory type: procedural_memory
- Approx tokens: 12
- Top content: preference: coffee brew method = {"value": "pour over", "target": "coffee brew method"}

### coffee_active_truth (bm25)
- Passed: true
- Result count: 1
- Top memory type: procedural_memory
- Approx tokens: 12
- Top content: preference: coffee brew method = {"value": "pour over", "target": "coffee brew method"}

### spicy_active_truth (fts)
- Passed: true
- Result count: 4
- Top memory type: procedural_memory
- Approx tokens: 55
- Top content: preference: preference:spicy food = {"target": "spicy food", "polarity": "dislike", "source_memory_id": "019cff65-6a23-743c-893a-a8d89d74b252", "semantic_memory_id": "019cff65-6a63-7140-9f4f-2178c0e6087b"}

### spicy_active_truth (bm25)
- Passed: true
- Result count: 4
- Top memory type: procedural_memory
- Approx tokens: 55
- Top content: preference: preference:spicy food = {"target": "spicy food", "polarity": "dislike", "source_memory_id": "019cff65-6a23-743c-893a-a8d89d74b252", "semantic_memory_id": "019cff65-6a63-7140-9f4f-2178c0e6087b"}

### sweet_active_truth (fts)
- Passed: true
- Result count: 4
- Top memory type: procedural_memory
- Approx tokens: 55
- Top content: preference: preference:sweet food = {"target": "sweet food", "polarity": "like", "source_memory_id": "019cff65-6a23-743c-893a-a8d89d74b252", "semantic_memory_id": "019cff65-6a65-7143-8651-5b88dff4af2c"}

### sweet_active_truth (bm25)
- Passed: true
- Result count: 4
- Top memory type: procedural_memory
- Approx tokens: 55
- Top content: preference: preference:sweet food = {"target": "sweet food", "polarity": "like", "source_memory_id": "019cff65-6a23-743c-893a-a8d89d74b252", "semantic_memory_id": "019cff65-6a65-7143-8651-5b88dff4af2c"}

### rare_entity_cve (fts)
- Passed: true
- Result count: 1
- Top memory type: semantic_memory
- Approx tokens: 15
- Top content: CVE-2026-3172 is the tracked buffer overflow in the gateway parser and remains open for hardening.

### rare_entity_cve (bm25)
- Passed: true
- Result count: 1
- Top memory type: semantic_memory
- Approx tokens: 15
- Top content: CVE-2026-3172 is the tracked buffer overflow in the gateway parser and remains open for hardening.

### version_precision_pgvector (fts)
- Passed: true
- Result count: 1
- Top memory type: semantic_memory
- Approx tokens: 15
- Top content: pgvector 0.8.2 release notes mention sparsevec improvements and iterative index scans relevant to hybrid retrieval.

### version_precision_pgvector (bm25)
- Passed: true
- Result count: 1
- Top memory type: semantic_memory
- Approx tokens: 15
- Top content: pgvector 0.8.2 release notes mention sparsevec improvements and iterative index scans relevant to hybrid retrieval.

### acronym_precision_sqs_dlq (fts)
- Passed: true
- Result count: 1
- Top memory type: semantic_memory
- Approx tokens: 14
- Top content: SQS DLQ setup requires a dead-letter queue redrive policy and explicit retry visibility timeouts.

### acronym_precision_sqs_dlq (bm25)
- Passed: true
- Result count: 1
- Top memory type: semantic_memory
- Approx tokens: 14
- Top content: SQS DLQ setup requires a dead-letter queue redrive policy and explicit retry visibility timeouts.

### provenance_hash_lookup (fts)
- Passed: true
- Result count: 1
- Top memory type: artifact_derivation
- Approx tokens: 17
- Top content: Artifact hash c6b7e8 points to the retained March 2025 redesign packet with provenance markers and source tracking.

### provenance_hash_lookup (bm25)
- Passed: true
- Result count: 1
- Top memory type: artifact_derivation
- Approx tokens: 17
- Top content: Artifact hash c6b7e8 points to the retained March 2025 redesign packet with provenance markers and source tracking.

### artifact_ocr_port (fts)
- Passed: true
- Result count: 1
- Top memory type: artifact_derivation
- Approx tokens: 16
- Top content: OCR from the server screenshot shows port 3000 and webhook receiver config for Discord and Slack.

### artifact_ocr_port (bm25)
- Passed: true
- Result count: 1
- Top memory type: artifact_derivation
- Approx tokens: 16
- Top content: OCR from the server screenshot shows port 3000 and webhook receiver config for Discord and Slack.

### entity_collision_sara (fts)
- Passed: true
- Result count: 1
- Top memory type: episodic_memory
- Approx tokens: 16
- Top content: Sara Alvarez joined the Kyoto dinner in April 2025 to discuss itinerary swaps and transit planning.

### entity_collision_sara (bm25)
- Passed: true
- Result count: 1
- Top memory type: episodic_memory
- Approx tokens: 16
- Top content: Sara Alvarez joined the Kyoto dinner in April 2025 to discuss itinerary swaps and transit planning.

### abstention_unknown (fts)
- Passed: true
- Result count: 0
- Top memory type: n/a
- Approx tokens: 0
- Top content: 

### abstention_unknown (bm25)
- Passed: true
- Result count: 0
- Top memory type: n/a
- Approx tokens: 0
- Top content: 

