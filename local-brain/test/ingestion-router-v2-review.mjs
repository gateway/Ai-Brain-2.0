import assert from "node:assert/strict";
import { test } from "node:test";
import { buildIngestionRouterV2Packet, classifyIngestionSourceRoute } from "../dist/ingest/router-v2.js";

test("explicit and metadata source routing is deterministic", () => {
  assert.deepEqual(classifyIngestionSourceRoute({ sourceType: "markdown", sourceUri: "file:///x.txt" }), {
    sourceRoute: "markdown",
    envelopeSourceType: "markdown"
  });
  assert.deepEqual(classifyIngestionSourceRoute({ sourceType: "text", sourceUri: "file:///x.pdf", mimeType: "application/pdf" }), {
    sourceRoute: "pdf",
    envelopeSourceType: "pdf"
  });
  assert.deepEqual(classifyIngestionSourceRoute({ sourceType: "transcript", sourceUri: "asr://recording/1" }), {
    sourceRoute: "asr",
    envelopeSourceType: "asr"
  });
  assert.deepEqual(classifyIngestionSourceRoute({ sourceType: "text", sourceUri: "tasks://today" }), {
    sourceRoute: "task_list",
    envelopeSourceType: "task_list"
  });
  assert.deepEqual(classifyIngestionSourceRoute({ sourceType: "text", sourceUri: "text://note" }), {
    sourceRoute: "generic_text",
    envelopeSourceType: "generic_text"
  });
});

test("benchmark and watched source routes are preserved without LLM routing", () => {
  assert.equal(
    classifyIngestionSourceRoute({
      sourceType: "markdown",
      sourceUri: "benchmark://locomo/conv-1",
      sourceChannel: "benchmark:locomo",
      metadata: { benchmark_dataset: "locomo" }
    }).sourceRoute,
    "locomo"
  );
  assert.equal(
    classifyIngestionSourceRoute({
      sourceType: "markdown",
      sourceUri: "benchmark://longmem/session-1",
      sourceChannel: "benchmark:longmem",
      metadata: { benchmark_dataset: "longmem" }
    }).sourceRoute,
    "longmem"
  );
  assert.equal(
    classifyIngestionSourceRoute({
      sourceType: "text",
      sourceUri: "file:///watched/note.txt",
      sourceChannel: "bootstrap:openclaw",
      metadata: { monitored_source: true }
    }).sourceRoute,
    "watched_source"
  );
});

test("router packet preserves provenance and token budget", () => {
  const packet = buildIngestionRouterV2Packet({
    namespaceId: "test",
    sourceType: "markdown",
    sourceUri: "file:///notes/project.md",
    capturedAt: "2026-05-14T00:00:00Z",
    rawText: "# Project\n\nBuild source-bound memory.\n\n## Tasks\n\n- Preserve provenance."
  });
  assert.equal(packet.routerVersion, "ingestion_router_v2");
  assert.equal(packet.sourceIntelligenceProfile, "document");
  assert.equal(packet.taxonomyProfile, "document_summary");
  assert.deepEqual(packet.enrichment.taxonomyProfiles, ["document_summary", "direct_fact", "task_ops"]);
  assert.equal(packet.enrichment.candidateBufferKind, "universal_candidate_buffer");
  assert.equal(packet.metrics.provenanceComplete, true);
  assert.ok(packet.metrics.chunkCount >= 1);
  assert.ok(packet.metrics.extractionUnitCount >= 1);
  assert.ok(packet.metrics.inputTokenMax <= 1800);
  assert.equal(packet.enrichment.queryTimeModelCalls, 0);
  for (const chunk of packet.adapter?.artifactChunks ?? []) {
    assert.equal(chunk.sourceUri, "file:///notes/project.md");
    assert.ok(chunk.textHash.length >= 32);
    assert.ok(chunk.charEnd >= chunk.charStart);
  }
});

test("dialogue and review-only routes select safe taxonomy profiles", () => {
  const locomo = buildIngestionRouterV2Packet({
    namespaceId: "test",
    sourceType: "markdown",
    sourceUri: "benchmark://locomo/conv-1",
    sourceChannel: "benchmark:locomo",
    capturedAt: "2026-05-14T00:00:00Z",
    rawText: "Audrey: I prefer chicken.\nCalvin: I bought a Ferrari in June.",
    metadata: { benchmark_dataset: "locomo" }
  });
  assert.equal(locomo.sourceIntelligenceProfile, "dialogue");
  assert.equal(locomo.taxonomyProfile, "direct_fact");
  assert.ok(locomo.enrichment.taxonomyProfiles.includes("relation_event"));
  assert.equal(locomo.enrichment.candidateBufferKind, "relationship_candidates");

  const generic = buildIngestionRouterV2Packet({
    namespaceId: "test",
    sourceType: "text",
    sourceUri: "text://scratch",
    capturedAt: "2026-05-14T00:00:00Z",
    rawText: "Unstructured note without a declared source shape."
  });
  assert.equal(generic.sourceIntelligenceProfile, "generic_text");
  assert.equal(generic.taxonomyProfile, "review_only");
  assert.equal(generic.enrichment.candidateBufferKind, "review_only");
  assert.ok(generic.enrichment.rejectionReasons.includes("review_only_taxonomy_profile"));
  assert.equal(generic.enrichment.queryTimeModelCalls, 0);
});

test("cache signature changes on source hash but not unrelated metadata", () => {
  const base = {
    namespaceId: "test",
    sourceType: "text",
    sourceUri: "text://note",
    capturedAt: "2026-05-14T00:00:00Z",
    rawText: "Audrey prefers chicken."
  };
  const first = buildIngestionRouterV2Packet(base);
  const sourceChanged = buildIngestionRouterV2Packet({ ...base, rawText: "Audrey prefers fish." });
  const metadataChanged = buildIngestionRouterV2Packet({ ...base, metadata: { harmless: "metadata" } });
  assert.notEqual(first.enrichment.cacheIdentity.signature, sourceChanged.enrichment.cacheIdentity.signature);
  assert.equal(first.enrichment.cacheIdentity.signature, metadataChanged.enrichment.cacheIdentity.signature);
});

test("cache signature changes when the same text routes through a different source profile", () => {
  const base = {
    namespaceId: "test",
    sourceType: "text",
    sourceUri: "omi://note",
    sourceChannel: "omi",
    capturedAt: "2026-05-14T00:00:00Z",
    rawText: "I prefer chicken.",
    metadata: { monitored_source_type: "omi" }
  };
  const omi = buildIngestionRouterV2Packet(base);
  const generic = buildIngestionRouterV2Packet({
    ...base,
    sourceUri: "text://note",
    sourceChannel: "generic",
    metadata: {}
  });
  assert.notEqual(omi.sourceRoute, generic.sourceRoute);
  assert.notEqual(omi.enrichment.cacheIdentity.signature, generic.enrichment.cacheIdentity.signature);
});
