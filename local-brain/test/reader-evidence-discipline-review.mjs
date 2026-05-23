import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluateSourceBoundReaderEvidenceDisciplineForTest } from "../dist/retrieval/reader-evidence-discipline.js";

test("reader evidence discipline blocks canonical report answers without a typed render contract", () => {
  const result = evaluateSourceBoundReaderEvidenceDisciplineForTest({
    queryText: "Why did Jon decide to start his dance studio?",
    ownerFamily: "report",
    winner: "canonical_report",
    sufficiency: "supported",
    subjectMatch: "matched",
    evidenceCount: 2,
    resultCount: 2,
    renderContractSelected: null,
    supportObjectType: null
  });
  assert.equal(result.required, true);
  assert.equal(result.present, false);
  assert.equal(result.blocked, true);
});

test("reader evidence discipline allows canonical report answers with a typed render contract", () => {
  const result = evaluateSourceBoundReaderEvidenceDisciplineForTest({
    queryText: "Why did Jon decide to start his dance studio?",
    ownerFamily: "report",
    winner: "canonical_report",
    sufficiency: "supported",
    subjectMatch: "matched",
    evidenceCount: 2,
    resultCount: 2,
    renderContractSelected: "causal_reason_render",
    supportObjectType: "ProfileInferenceSupport"
  });
  assert.equal(result.required, true);
  assert.equal(result.present, true);
  assert.equal(result.blocked, false);
});

test("reader evidence discipline allows typed temporal relative-day answers even when subject match downgrades", () => {
  const result = evaluateSourceBoundReaderEvidenceDisciplineForTest({
    queryText: "When did Caroline meet up with her friends, family, and mentors?",
    ownerFamily: "temporal",
    winner: "canonical_temporal",
    sufficiency: "contradicted",
    subjectMatch: "mismatched",
    evidenceCount: 1,
    resultCount: 1,
    renderContractSelected: "temporal_relative_day",
    supportObjectType: "TemporalEventSupport"
  });
  assert.equal(result.required, true);
  assert.equal(result.present, true);
  assert.equal(result.blocked, false);
});
