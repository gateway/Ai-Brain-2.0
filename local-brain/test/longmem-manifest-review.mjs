import assert from "node:assert/strict";
import { test } from "node:test";
import { buildLongMemSessionManifestIdentity } from "../dist/benchmark/longmemeval.js";

const baseSourceSignature = [
  {
    uri: "/tmp/longmem/question/session-1.md",
    checksumSha256: "a".repeat(64),
    capturedAt: "2026-01-01T00:00:00.000Z",
    byteSize: 128
  }
];

test("LongMem session manifest key is stable for identical source and compiler inputs", () => {
  const left = buildLongMemSessionManifestIdentity({
    datasetKey: "longmemeval_s_cleaned",
    sampleId: "q1",
    sourceSignature: baseSourceSignature,
    relationIeMode: "support_and_promote"
  });
  const right = buildLongMemSessionManifestIdentity({
    datasetKey: "longmemeval_s_cleaned",
    sampleId: "q1",
    sourceSignature: baseSourceSignature,
    relationIeMode: "support_and_promote"
  });
  assert.equal(left.manifestKey, right.manifestKey);
});

test("LongMem session manifest key changes when source hash changes", () => {
  const original = buildLongMemSessionManifestIdentity({
    datasetKey: "longmemeval_s_cleaned",
    sampleId: "q1",
    sourceSignature: baseSourceSignature,
    relationIeMode: "support_and_promote"
  });
  const changed = buildLongMemSessionManifestIdentity({
    datasetKey: "longmemeval_s_cleaned",
    sampleId: "q1",
    sourceSignature: [{ ...baseSourceSignature[0], checksumSha256: "b".repeat(64) }],
    relationIeMode: "support_and_promote"
  });
  assert.notEqual(original.manifestKey, changed.manifestKey);
});

test("LongMem session manifest key changes when relation IE mode changes", () => {
  const promote = buildLongMemSessionManifestIdentity({
    datasetKey: "longmemeval_s_cleaned",
    sampleId: "q1",
    sourceSignature: baseSourceSignature,
    relationIeMode: "support_and_promote"
  });
  const supportOnly = buildLongMemSessionManifestIdentity({
    datasetKey: "longmemeval_s_cleaned",
    sampleId: "q1",
    sourceSignature: baseSourceSignature,
    relationIeMode: null
  });
  assert.notEqual(promote.manifestKey, supportOnly.manifestKey);
});

test("LongMem session manifest key changes when extractor model signature changes", () => {
  const previousModel = process.env.BRAIN_EXTRACTION_ASSISTANT_MODEL;
  try {
    process.env.BRAIN_EXTRACTION_ASSISTANT_MODEL = "openai/gpt-5.4-mini";
    const first = buildLongMemSessionManifestIdentity({
      datasetKey: "longmemeval_s_cleaned",
      sampleId: "q1",
      sourceSignature: baseSourceSignature,
      relationIeMode: "support_and_promote"
    });
    process.env.BRAIN_EXTRACTION_ASSISTANT_MODEL = "openai/gpt-5.4-mini-next";
    const second = buildLongMemSessionManifestIdentity({
      datasetKey: "longmemeval_s_cleaned",
      sampleId: "q1",
      sourceSignature: baseSourceSignature,
      relationIeMode: "support_and_promote"
    });
    assert.notEqual(first.manifestKey, second.manifestKey);
  } finally {
    if (previousModel === undefined) {
      delete process.env.BRAIN_EXTRACTION_ASSISTANT_MODEL;
    } else {
      process.env.BRAIN_EXTRACTION_ASSISTANT_MODEL = previousModel;
    }
  }
});

test("LongMem session manifest key changes when reader discipline signature changes", () => {
  const previousVersion = process.env.BRAIN_LONGMEM_READER_DISCIPLINE_VERSION;
  try {
    process.env.BRAIN_LONGMEM_READER_DISCIPLINE_VERSION = "source_bound_reader_discipline_v1";
    const first = buildLongMemSessionManifestIdentity({
      datasetKey: "longmemeval_s_cleaned",
      sampleId: "q1",
      sourceSignature: baseSourceSignature,
      relationIeMode: "support_and_promote"
    });
    process.env.BRAIN_LONGMEM_READER_DISCIPLINE_VERSION = "source_bound_reader_discipline_v2";
    const second = buildLongMemSessionManifestIdentity({
      datasetKey: "longmemeval_s_cleaned",
      sampleId: "q1",
      sourceSignature: baseSourceSignature,
      relationIeMode: "support_and_promote"
    });
    assert.notEqual(first.manifestKey, second.manifestKey);
  } finally {
    if (previousVersion === undefined) {
      delete process.env.BRAIN_LONGMEM_READER_DISCIPLINE_VERSION;
    } else {
      process.env.BRAIN_LONGMEM_READER_DISCIPLINE_VERSION = previousVersion;
    }
  }
});
