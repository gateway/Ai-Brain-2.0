# Lexical Benchmark Report

Generated: 2026-03-18T04:41:52.508Z
Namespace: eval_1773808912240
Baseline Eval Passed: true

## Summary

- FTS passed: 4/4
- BM25 passed: 4/4
- BM25 token delta: 0
- Recommendation: candidate_for_default
- Reason: BM25 matched or exceeded FTS on the current benchmark set without increasing token load.

## Cases

### japan_exact_temporal (fts)
- Passed: true
- Result count: 2
- Top memory type: episodic_memory
- Approx tokens: 62
- Top content: In June 2025 Steve was in Japan with Sarah and Ken. They spent time in Tokyo and Kyoto together. The trip included shared dinners, transit days, and travel notes worth preserving.

### japan_exact_temporal (bm25)
- Passed: true
- Result count: 2
- Top memory type: episodic_memory
- Approx tokens: 62
- Top content: In June 2025 Steve was in Japan with Sarah and Ken. They spent time in Tokyo and Kyoto together. The trip included shared dinners, transit days, and travel notes worth preserving.

### spicy_active_truth (fts)
- Passed: true
- Result count: 4
- Top memory type: procedural_memory
- Approx tokens: 55
- Top content: preference: preference:spicy food = {"target": "spicy food", "polarity": "dislike", "source_memory_id": "019cff40-07ff-79ef-bf8e-2742c8543018", "semantic_memory_id": "019cff40-083d-7ad1-84aa-0e59cc083011"}

### spicy_active_truth (bm25)
- Passed: true
- Result count: 4
- Top memory type: procedural_memory
- Approx tokens: 55
- Top content: preference: preference:spicy food = {"target": "spicy food", "polarity": "dislike", "source_memory_id": "019cff40-07ff-79ef-bf8e-2742c8543018", "semantic_memory_id": "019cff40-083d-7ad1-84aa-0e59cc083011"}

### sweet_active_truth (fts)
- Passed: true
- Result count: 4
- Top memory type: procedural_memory
- Approx tokens: 55
- Top content: preference: preference:sweet food = {"target": "sweet food", "polarity": "like", "source_memory_id": "019cff40-07ff-79ef-bf8e-2742c8543018", "semantic_memory_id": "019cff40-083f-7e56-a6e2-e40136bdba34"}

### sweet_active_truth (bm25)
- Passed: true
- Result count: 4
- Top memory type: procedural_memory
- Approx tokens: 55
- Top content: preference: preference:sweet food = {"target": "sweet food", "polarity": "like", "source_memory_id": "019cff40-07ff-79ef-bf8e-2742c8543018", "semantic_memory_id": "019cff40-083f-7e56-a6e2-e40136bdba34"}

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

