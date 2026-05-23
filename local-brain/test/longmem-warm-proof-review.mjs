import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isLongMemAnswerQualityGreen,
  isLongMemWarmProofPassed,
  isLongMemWarmReuseGreen
} from "../dist/benchmark/longmem-warm-proof.js";

function buildRun(overrides = {}) {
  return {
    label: "baseline",
    generatedAt: "2026-05-18T00:00:00.000Z",
    artifactJsonPath: "/tmp/report.json",
    artifactMarkdownPath: "/tmp/report.md",
    sampleCount: 8,
    passRate: 1,
    manifestHitRate: 0,
    sessionManifestHitRate: 0,
    warmSnapshotHitRate: 0,
    coldRebuildCount: 8,
    staleManifestMismatchCount: 0,
    answerParityMismatchCount: 0,
    latency: {
      p50Ms: 10,
      p95Ms: 20,
      maxMs: 25
    },
    manifestDecisionBreakdown: {},
    snapshotDecisionBreakdown: {},
    parityStatusBreakdown: {},
    passed: false,
    ...overrides
  };
}

test("LongMem warm proof baseline quality ignores cold-cache reuse counters", () => {
  const baseline = buildRun();
  assert.equal(isLongMemAnswerQualityGreen(baseline), true);
});

test("LongMem warm proof warm reuse gate requires warm manifest and snapshot hits", () => {
  const warmRun = buildRun({
    label: "same_process_warm",
    manifestHitRate: 1,
    sessionManifestHitRate: 1,
    warmSnapshotHitRate: 1,
    coldRebuildCount: 0,
    passed: true
  });
  assert.equal(isLongMemWarmReuseGreen(warmRun), true);
  assert.equal(isLongMemWarmReuseGreen(buildRun({ label: "same_process_warm", passed: true })), false);
});

test("LongMem warm proof passes with a cold reference baseline and warm reruns", () => {
  const baseline = buildRun();
  const warmRun = buildRun({
    label: "same_process_warm",
    manifestHitRate: 1,
    sessionManifestHitRate: 1,
    warmSnapshotHitRate: 1,
    coldRebuildCount: 0,
    passed: true
  });
  const freshWarmRun = buildRun({
    label: "fresh_process_warm",
    manifestHitRate: 1,
    sessionManifestHitRate: 1,
    warmSnapshotHitRate: 1,
    coldRebuildCount: 0,
    passed: true
  });
  assert.equal(
    isLongMemWarmProofPassed({
      baseline,
      sameProcessWarm: warmRun,
      freshProcessWarm: freshWarmRun,
      sameProcessParityMismatchCount: 0,
      freshProcessParityMismatchCount: 0
    }),
    true
  );
});
