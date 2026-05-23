import assert from "node:assert/strict";
import { test } from "node:test";
import { buildSourceEnvelopeAdapterOutput } from "../dist/ingest/source-envelope.js";
import { isBroadSelfPairRelationshipProfileQuery } from "../dist/retrieval/route-locked-fast-paths.js";

test("source envelope adapters preserve provenance and bounded extraction units", () => {
  const fixtures = [
    {
      namespaceId: "test",
      sourceType: "omi",
      sourceUri: "omi://note/1",
      capturedAt: "2026-05-02T00:00:00Z",
      authorHint: "self",
      formatMetadata: {},
      rawText: "I use Spotify and my internet is 500 Mbps."
    },
    {
      namespaceId: "test",
      sourceType: "markdown",
      sourceUri: "openclaw://notes/project.md",
      capturedAt: "2026-05-02T00:00:00Z",
      authorHint: "self",
      formatMetadata: {},
      rawText: "---\ntitle: Project\n---\n# Project\n\nBuild the memory graph with Postgres.\n\n## Tasks\n\n- Keep provenance."
    },
    {
      namespaceId: "test",
      sourceType: "pdf",
      sourceUri: "pdf://upload/sample.pdf",
      capturedAt: "2026-05-02T00:00:00Z",
      authorHint: "import",
      formatMetadata: {},
      rawText: "Page 1\nLauren left on October 18, 2025.\fPage 2\nThe date is exact in the source."
    },
    {
      namespaceId: "test",
      sourceType: "chat",
      sourceUri: "chat://thread/1",
      capturedAt: "2026-05-02T00:00:00Z",
      authorHint: "friend",
      formatMetadata: {},
      rawText: "Lauren: My dog is a Golden Retriever.\nSteve: Not mine."
    },
    {
      namespaceId: "test",
      sourceType: "task_list",
      sourceUri: "tasks://today",
      capturedAt: "2026-05-02T00:00:00Z",
      authorHint: "self",
      formatMetadata: {},
      rawText: "- Review taxonomy.\n- Check embedding health."
    }
  ];

  for (const fixture of fixtures) {
    const output = buildSourceEnvelopeAdapterOutput(fixture);
    assert.ok(output.artifactChunks.length >= 1, fixture.sourceType);
    assert.ok(output.extractionUnits.length >= 1, fixture.sourceType);
    assert.equal(output.metrics.provenanceComplete, true, fixture.sourceType);
    assert.ok(output.metrics.inputTokenMax <= 1800, fixture.sourceType);
    for (const chunk of output.artifactChunks) {
      assert.equal(chunk.sourceUri, fixture.sourceUri);
      assert.equal(chunk.sourceType, fixture.sourceType);
      assert.ok(chunk.textHash.length >= 32);
      assert.ok(chunk.charEnd >= chunk.charStart);
    }
  }
});

test("broad Lauren self-pair questions route to relationship profile/history", () => {
  const positives = [
    "Can you query all the information about Lauren and I?",
    "Give me all the info about Lauren and me.",
    "What is the full picture with Lauren and I?",
    "What is everything you know about Lauren and me?",
    "What is the whole story about Lauren and me?",
    "What is all the relationship info about Lauren and I?",
    "What is the full relationship picture with Lauren?",
    "What is the whole relationship story about Lauren and me?"
  ];
  for (const query of positives) {
    assert.equal(isBroadSelfPairRelationshipProfileQuery(query), true, query);
  }
  assert.equal(isBroadSelfPairRelationshipProfileQuery("What is Lauren's dog breed?"), false);
  assert.equal(isBroadSelfPairRelationshipProfileQuery("What is all the information about Dan and I?"), false);
});
