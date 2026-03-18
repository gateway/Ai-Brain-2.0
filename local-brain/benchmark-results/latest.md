# Lexical Benchmark Report

Generated: 2026-03-18T05:57:39.172Z
Namespace: eval_1773813458765_997c113d
Baseline Eval Passed: true

## Summary

- FTS passed: 14/14
- BM25 passed: 14/14
- BM25 token delta: 83
- BM25 fallback cases: 0
- Recommendation: keep_feature_gated
- Reason: Keep BM25 behind a flag until it clears the expanded lexical stress suite, baseline eval remains clean, and BM25 fallback frequency reaches zero.

## Cases

### japan_exact_temporal (fts)
- Passed: true
- Result count: 5
- Effective lexical provider: fts
- Lexical fallback used: false
- Top memory type: temporal_nodes
- Approx tokens: 135
- Top content: MONTH rollup Sun Jun 01 2025 00:00:00 GMT+0700 (Indochina Time) -> Tue Jul 01 2025 00:00:00 GMT+0700 (Indochina Time). events=2. roles=import:2. top_entities=Ken:2, Kyoto:2, Sarah:2, Japan:1, Steve:1.

### japan_exact_temporal (bm25)
- Passed: true
- Result count: 5
- Effective lexical provider: bm25
- Lexical fallback used: false
- Top memory type: temporal_nodes
- Approx tokens: 131
- Top content: YEAR rollup Wed Jan 01 2025 00:00:00 GMT+0700 (Indochina Time) -> Thu Jan 01 2026 00:00:00 GMT+0700 (Indochina Time). events=4. roles=import:4. top_entities=Ken:2, Kyoto:2, Sarah:2, Japan:1, Steve:1.

### japan_temporal_natural_language (fts)
- Passed: true
- Result count: 5
- Effective lexical provider: fts
- Lexical fallback used: false
- Top memory type: temporal_nodes
- Approx tokens: 135
- Top content: MONTH rollup Sun Jun 01 2025 00:00:00 GMT+0700 (Indochina Time) -> Tue Jul 01 2025 00:00:00 GMT+0700 (Indochina Time). events=2. roles=import:2. top_entities=Ken:2, Kyoto:2, Sarah:2, Japan:1, Steve:1.

### japan_temporal_natural_language (bm25)
- Passed: true
- Result count: 5
- Effective lexical provider: bm25
- Lexical fallback used: false
- Top memory type: temporal_nodes
- Approx tokens: 131
- Top content: YEAR rollup Thu Jan 01 2026 00:00:00 GMT+0700 (Indochina Time) -> Fri Jan 01 2027 00:00:00 GMT+0700 (Indochina Time). events=7. roles=import:7. top_entities=Brain 2.0:1, Japan:1, Osaka:1, Producer Event:1.

### relationship_context_kyoto (fts)
- Passed: true
- Result count: 1
- Effective lexical provider: fts
- Lexical fallback used: false
- Top memory type: episodic_memory
- Approx tokens: 31
- Top content: In June 2025 Steve was in Japan with Sarah and Ken. They spent time in Tokyo and Kyoto together. The trip included shared dinners, transit days, and travel notes worth preserving.

### relationship_context_kyoto (bm25)
- Passed: true
- Result count: 3
- Effective lexical provider: bm25
- Lexical fallback used: false
- Top memory type: episodic_memory
- Approx tokens: 62
- Top content: In June 2025 Steve was in Japan with Sarah and Ken. They spent time in Tokyo and Kyoto together. The trip included shared dinners, transit days, and travel notes worth preserving.

### march_redesign_date (fts)
- Passed: true
- Result count: 5
- Effective lexical provider: fts
- Lexical fallback used: false
- Top memory type: episodic_memory
- Approx tokens: 114
- Top content: On March 12 2025 the redesign notes focused on the dashboard timeline UX and the relationship graph layout for the AI brain.

### march_redesign_date (bm25)
- Passed: true
- Result count: 5
- Effective lexical provider: bm25
- Lexical fallback used: false
- Top memory type: episodic_memory
- Approx tokens: 114
- Top content: On March 12 2025 the redesign notes focused on the dashboard timeline UX and the relationship graph layout for the AI brain.

### coffee_active_truth (fts)
- Passed: true
- Result count: 1
- Effective lexical provider: fts
- Lexical fallback used: false
- Top memory type: procedural_memory
- Approx tokens: 12
- Top content: preference: coffee brew method = {"value": "pour over", "target": "coffee brew method"}

### coffee_active_truth (bm25)
- Passed: true
- Result count: 1
- Effective lexical provider: bm25
- Lexical fallback used: false
- Top memory type: procedural_memory
- Approx tokens: 12
- Top content: preference: coffee brew method = {"value": "pour over", "target": "coffee brew method"}

### spicy_active_truth (fts)
- Passed: true
- Result count: 1
- Effective lexical provider: fts
- Lexical fallback used: false
- Top memory type: procedural_memory
- Approx tokens: 13
- Top content: preference: preference:spicy food = {"target": "spicy food", "polarity": "dislike", "source_memory_id": "019cff85-6792-7a44-b5ae-d2a0d6b11591", "semantic_memory_id": "019cff85-67ef-70f2-b92d-29e411450c09"}

### spicy_active_truth (bm25)
- Passed: true
- Result count: 1
- Effective lexical provider: bm25
- Lexical fallback used: false
- Top memory type: procedural_memory
- Approx tokens: 13
- Top content: preference: preference:spicy food = {"target": "spicy food", "polarity": "dislike", "source_memory_id": "019cff85-6792-7a44-b5ae-d2a0d6b11591", "semantic_memory_id": "019cff85-67ef-70f2-b92d-29e411450c09"}

### sweet_active_truth (fts)
- Passed: true
- Result count: 1
- Effective lexical provider: fts
- Lexical fallback used: false
- Top memory type: procedural_memory
- Approx tokens: 13
- Top content: preference: preference:sweet food = {"target": "sweet food", "polarity": "like", "source_memory_id": "019cff85-6792-7a44-b5ae-d2a0d6b11591", "semantic_memory_id": "019cff85-67f0-7f2e-8448-18410dcc3422"}

### sweet_active_truth (bm25)
- Passed: true
- Result count: 1
- Effective lexical provider: bm25
- Lexical fallback used: false
- Top memory type: procedural_memory
- Approx tokens: 13
- Top content: preference: preference:sweet food = {"target": "sweet food", "polarity": "like", "source_memory_id": "019cff85-6792-7a44-b5ae-d2a0d6b11591", "semantic_memory_id": "019cff85-67f0-7f2e-8448-18410dcc3422"}

### rare_entity_cve (fts)
- Passed: true
- Result count: 1
- Effective lexical provider: fts
- Lexical fallback used: false
- Top memory type: semantic_memory
- Approx tokens: 15
- Top content: CVE-2026-3172 is the tracked buffer overflow in the gateway parser and remains open for hardening.

### rare_entity_cve (bm25)
- Passed: true
- Result count: 2
- Effective lexical provider: bm25
- Lexical fallback used: false
- Top memory type: semantic_memory
- Approx tokens: 29
- Top content: CVE-2026-3172 is the tracked buffer overflow in the gateway parser and remains open for hardening.

### version_precision_pgvector (fts)
- Passed: true
- Result count: 1
- Effective lexical provider: fts
- Lexical fallback used: false
- Top memory type: semantic_memory
- Approx tokens: 15
- Top content: pgvector 0.8.2 release notes mention sparsevec improvements and iterative index scans relevant to hybrid retrieval.

### version_precision_pgvector (bm25)
- Passed: true
- Result count: 1
- Effective lexical provider: bm25
- Lexical fallback used: false
- Top memory type: semantic_memory
- Approx tokens: 15
- Top content: pgvector 0.8.2 release notes mention sparsevec improvements and iterative index scans relevant to hybrid retrieval.

### acronym_precision_sqs_dlq (fts)
- Passed: true
- Result count: 1
- Effective lexical provider: fts
- Lexical fallback used: false
- Top memory type: semantic_memory
- Approx tokens: 14
- Top content: SQS DLQ setup requires a dead-letter queue redrive policy and explicit retry visibility timeouts.

### acronym_precision_sqs_dlq (bm25)
- Passed: true
- Result count: 1
- Effective lexical provider: bm25
- Lexical fallback used: false
- Top memory type: semantic_memory
- Approx tokens: 14
- Top content: SQS DLQ setup requires a dead-letter queue redrive policy and explicit retry visibility timeouts.

### provenance_hash_lookup (fts)
- Passed: true
- Result count: 1
- Effective lexical provider: fts
- Lexical fallback used: false
- Top memory type: artifact_derivation
- Approx tokens: 17
- Top content: Artifact hash c6b7e8 points to the retained March 2025 redesign packet with provenance markers and source tracking.

### provenance_hash_lookup (bm25)
- Passed: true
- Result count: 1
- Effective lexical provider: bm25
- Lexical fallback used: false
- Top memory type: artifact_derivation
- Approx tokens: 17
- Top content: Artifact hash c6b7e8 points to the retained March 2025 redesign packet with provenance markers and source tracking.

### artifact_ocr_port (fts)
- Passed: true
- Result count: 1
- Effective lexical provider: fts
- Lexical fallback used: false
- Top memory type: artifact_derivation
- Approx tokens: 16
- Top content: OCR from the server screenshot shows port 3000 and webhook receiver config for Discord and Slack.

### artifact_ocr_port (bm25)
- Passed: true
- Result count: 1
- Effective lexical provider: bm25
- Lexical fallback used: false
- Top memory type: artifact_derivation
- Approx tokens: 16
- Top content: OCR from the server screenshot shows port 3000 and webhook receiver config for Discord and Slack.

### entity_collision_sara (fts)
- Passed: true
- Result count: 1
- Effective lexical provider: fts
- Lexical fallback used: false
- Top memory type: episodic_memory
- Approx tokens: 16
- Top content: Sara Alvarez joined the Kyoto dinner in April 2025 to discuss itinerary swaps and transit planning.

### entity_collision_sara (bm25)
- Passed: true
- Result count: 3
- Effective lexical provider: bm25
- Lexical fallback used: false
- Top memory type: episodic_memory
- Approx tokens: 62
- Top content: Sara Alvarez joined the Kyoto dinner in April 2025 to discuss itinerary swaps and transit planning.

### abstention_unknown (fts)
- Passed: true
- Result count: 0
- Effective lexical provider: fts
- Lexical fallback used: false
- Top memory type: n/a
- Approx tokens: 0
- Top content: 

### abstention_unknown (bm25)
- Passed: true
- Result count: 0
- Effective lexical provider: bm25
- Lexical fallback used: false
- Top memory type: n/a
- Approx tokens: 0
- Top content: 

