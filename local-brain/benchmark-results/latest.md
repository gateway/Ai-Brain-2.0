# Lexical Benchmark Report

Generated: 2026-03-18T08:40:25.117Z
Namespace: eval_1773823224691_e2aa57fb
Baseline Eval Passed: false

## Summary

- FTS passed: 12/14
- BM25 passed: 12/14
- BM25 token delta: 15
- BM25 fallback cases: 0
- Recommendation: keep_feature_gated
- Reason: Keep BM25 behind a flag until it clears the expanded lexical stress suite, baseline eval remains clean, and BM25 fallback frequency reaches zero.

## Cases

### japan_exact_temporal (fts)
- Passed: false
- Result count: 2
- Effective lexical provider: fts
- Lexical fallback used: false
- Top memory type: temporal_nodes
- Top overlap: 0.999
- Approx tokens: 53
- Top content: YEAR rollup Wed Jan 01 2025 00:00:00 GMT+0700 (Indochina Time) -> Thu Jan 01 2026 00:00:00 GMT+0700 (Indochina Time). events=4. roles=import:4. top_entities=none.
- Failures: top result missing term: Japan; top result missing term: Sarah

### japan_exact_temporal (bm25)
- Passed: false
- Result count: 3
- Effective lexical provider: bm25
- Lexical fallback used: false
- Top memory type: temporal_nodes
- Top overlap: 0.999
- Approx tokens: 68
- Top content: YEAR rollup Wed Jan 01 2025 00:00:00 GMT+0700 (Indochina Time) -> Thu Jan 01 2026 00:00:00 GMT+0700 (Indochina Time). events=4. roles=import:4. top_entities=none.
- Failures: top result missing term: Japan; top result missing term: Sarah

### japan_temporal_natural_language (fts)
- Passed: false
- Result count: 3
- Effective lexical provider: fts
- Lexical fallback used: false
- Top memory type: temporal_nodes
- Top overlap: 0.999
- Approx tokens: 65
- Top content: YEAR rollup Wed Jan 01 2025 00:00:00 GMT+0700 (Indochina Time) -> Thu Jan 01 2026 00:00:00 GMT+0700 (Indochina Time). events=4. roles=import:4. top_entities=none.
- Failures: top result missing term: Japan

### japan_temporal_natural_language (bm25)
- Passed: false
- Result count: 3
- Effective lexical provider: bm25
- Lexical fallback used: false
- Top memory type: temporal_nodes
- Top overlap: 0.999
- Approx tokens: 65
- Top content: YEAR rollup Wed Jan 01 2025 00:00:00 GMT+0700 (Indochina Time) -> Thu Jan 01 2026 00:00:00 GMT+0700 (Indochina Time). events=4. roles=import:4. top_entities=none.
- Failures: top result missing term: Japan

### relationship_context_kyoto (fts)
- Passed: true
- Result count: 1
- Effective lexical provider: fts
- Lexical fallback used: false
- Top memory type: episodic_memory
- Top overlap: n/a
- Approx tokens: 31
- Top content: In June 2025 Steve was in Japan with Sarah and Ken. They spent time in Tokyo and Kyoto together. The trip included shared dinners, transit days, and travel notes worth preserving.

### relationship_context_kyoto (bm25)
- Passed: true
- Result count: 1
- Effective lexical provider: bm25
- Lexical fallback used: false
- Top memory type: episodic_memory
- Top overlap: n/a
- Approx tokens: 31
- Top content: In June 2025 Steve was in Japan with Sarah and Ken. They spent time in Tokyo and Kyoto together. The trip included shared dinners, transit days, and travel notes worth preserving.

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
- Top content: preference: preference:spicy food = {"target": "spicy food", "polarity": "dislike", "source_memory_id": "019d001a-6bb2-7073-b10f-5265f7ad2abd", "semantic_memory_id": "019d001a-6c06-7d60-86a8-bc5824e89744"}

### spicy_active_truth (bm25)
- Passed: true
- Result count: 1
- Effective lexical provider: bm25
- Lexical fallback used: false
- Top memory type: procedural_memory
- Top overlap: n/a
- Approx tokens: 13
- Top content: preference: preference:spicy food = {"target": "spicy food", "polarity": "dislike", "source_memory_id": "019d001a-6bb2-7073-b10f-5265f7ad2abd", "semantic_memory_id": "019d001a-6c06-7d60-86a8-bc5824e89744"}

### sweet_active_truth (fts)
- Passed: true
- Result count: 1
- Effective lexical provider: fts
- Lexical fallback used: false
- Top memory type: procedural_memory
- Top overlap: n/a
- Approx tokens: 13
- Top content: preference: preference:sweet food = {"target": "sweet food", "polarity": "like", "source_memory_id": "019d001a-6bb2-7073-b10f-5265f7ad2abd", "semantic_memory_id": "019d001a-6c08-7cc2-a8ac-5d2cfcbb049f"}

### sweet_active_truth (bm25)
- Passed: true
- Result count: 1
- Effective lexical provider: bm25
- Lexical fallback used: false
- Top memory type: procedural_memory
- Top overlap: n/a
- Approx tokens: 13
- Top content: preference: preference:sweet food = {"target": "sweet food", "polarity": "like", "source_memory_id": "019d001a-6bb2-7073-b10f-5265f7ad2abd", "semantic_memory_id": "019d001a-6c08-7cc2-a8ac-5d2cfcbb049f"}

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

