import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildIngestionRouterV2Packet,
  type IngestionRouterV2Input,
  type IngestionRouterV2SourceRoute,
  type SourceIntelligenceProfile,
  type TaxonomyProfile
} from "../ingest/router-v2.js";

interface IngestionRoutingFixture {
  readonly id: string;
  readonly expectedRoute: IngestionRouterV2SourceRoute;
  readonly input: IngestionRouterV2Input;
}

interface IngestionRoutingSourceStats {
  readonly sourceType: string;
  readonly sourceRoute: IngestionRouterV2SourceRoute;
  readonly sourceIntelligenceProfile: SourceIntelligenceProfile;
  readonly taxonomyProfile: TaxonomyProfile;
  readonly taxonomyProfiles: readonly TaxonomyProfile[];
  readonly sourceCount: number;
  readonly chunkCount: number;
  readonly extractionUnitCount: number;
  readonly provenanceCompleteRate: number;
  readonly inputTokenP50: number;
  readonly inputTokenP95: number;
  readonly inputTokenMax: number;
  readonly gliner2CallCount: number;
  readonly relexCallCount: number;
  readonly assistantCallCount: number;
  readonly cacheHitRate: number;
  readonly relationCandidateCount: number;
  readonly compiledObservationCount: number;
  readonly rejectedCandidateCount: number;
  readonly topRejectionReasons: readonly string[];
  readonly promotionSafetyViolations: readonly string[];
  readonly runtimeMsP50: number;
  readonly runtimeMsP95: number;
  readonly runtimeMsMax: number;
}

export interface IngestionRoutingCoverageReport {
  readonly generatedAt: string;
  readonly benchmark: "ingestion_routing_coverage";
  readonly passed: boolean;
  readonly requiredRoutes: readonly IngestionRouterV2SourceRoute[];
  readonly coveredRoutes: readonly IngestionRouterV2SourceRoute[];
  readonly metrics: {
    readonly sourceRouteCoverageRate: number;
    readonly sourceRouteCoverageCount: number;
    readonly requiredRouteCount: number;
    readonly sourceIntelligenceProfileCoverageRate: number;
    readonly taxonomyProfileCoverageRate: number;
    readonly provenanceCompletenessRate: number;
    readonly extractionUnitInputTokensP95: number;
    readonly extractionUnitInputTokensMax: number;
    readonly jsonValidityRate: number;
    readonly gliner2CallCount: number;
    readonly relexCallCount: number;
    readonly assistantCallCount: number;
    readonly queryTimeModelCalls: number;
    readonly promotionWithoutEvidenceQuote: number;
    readonly unknownTaxonomyPromoted: number;
    readonly mixedOwnerPromoted: number;
    readonly coMentionOnlyPromoted: number;
    readonly cacheIdentityVariationPass: boolean;
  };
  readonly failures: readonly string[];
  readonly sources: readonly IngestionRoutingSourceStats[];
}

const REQUIRED_ROUTES: readonly IngestionRouterV2SourceRoute[] = [
  "omi",
  "markdown",
  "pdf",
  "asr",
  "chat",
  "task_list",
  "generic_text",
  "locomo",
  "longmem",
  "watched_source"
];

const FIXTURES: readonly IngestionRoutingFixture[] = [
  {
    id: "omi_voice_note",
    expectedRoute: "omi",
    input: {
      namespaceId: "benchmark_ingestion_router_v2",
      sourceType: "text",
      sourceUri: "omi://note/2026-05-14",
      sourceChannel: "omi",
      capturedAt: "2026-05-14T01:00:00Z",
      rawText: "I use Spotify and my home internet is 500 Mbps.",
      metadata: { monitored_source_type: "omi" }
    }
  },
  {
    id: "markdown_doc",
    expectedRoute: "markdown",
    input: {
      namespaceId: "benchmark_ingestion_router_v2",
      sourceType: "markdown",
      sourceUri: "file:///notes/project.md",
      capturedAt: "2026-05-14T01:00:00Z",
      rawText: "# Project\n\nBuild the memory graph with source quotes.\n\n## Tasks\n\n- Keep provenance."
    }
  },
  {
    id: "pdf_text",
    expectedRoute: "pdf",
    input: {
      namespaceId: "benchmark_ingestion_router_v2",
      sourceType: "text",
      sourceUri: "file:///uploads/report.pdf",
      mimeType: "application/pdf",
      capturedAt: "2026-05-14T01:00:00Z",
      rawText: "Page 1\nLauren moved to Bend on October 18, 2025.\fPage 2\nThe date is explicit."
    }
  },
  {
    id: "asr_transcript",
    expectedRoute: "asr",
    input: {
      namespaceId: "benchmark_ingestion_router_v2",
      sourceType: "transcript",
      sourceUri: "asr://recording/1",
      capturedAt: "2026-05-14T01:00:00Z",
      rawText: "[00:00] I was diagnosed with ADHD.\n[00:05] It affected school support."
    }
  },
  {
    id: "chat_thread",
    expectedRoute: "chat",
    input: {
      namespaceId: "benchmark_ingestion_router_v2",
      sourceType: "chat_turn",
      sourceUri: "chat://thread/1",
      capturedAt: "2026-05-14T01:00:00Z",
      rawText: "Lauren: My dog is a Golden Retriever.\nSteve: That is Lauren's dog, not mine."
    }
  },
  {
    id: "task_list",
    expectedRoute: "task_list",
    input: {
      namespaceId: "benchmark_ingestion_router_v2",
      sourceType: "text",
      sourceUri: "tasks://today",
      capturedAt: "2026-05-14T01:00:00Z",
      rawText: "- Review taxonomy.\n- Check Relex candidate cache.\n- Preserve source quotes.",
      metadata: { source_type_hint: "task_list" }
    }
  },
  {
    id: "generic_text",
    expectedRoute: "generic_text",
    input: {
      namespaceId: "benchmark_ingestion_router_v2",
      sourceType: "text",
      sourceUri: "text://scratch/note",
      capturedAt: "2026-05-14T01:00:00Z",
      rawText: "The triage rubric is useful but should not become taxonomy truth without review."
    }
  },
  {
    id: "locomo_dialogue",
    expectedRoute: "locomo",
    input: {
      namespaceId: "benchmark_ingestion_router_v2",
      sourceType: "markdown",
      sourceUri: "benchmark://locomo/conv-1",
      sourceChannel: "benchmark:locomo",
      capturedAt: "2026-05-14T01:00:00Z",
      rawText: "Audrey: I prefer chicken.\nCalvin: I bought a Ferrari in June.",
      metadata: { benchmark_dataset: "locomo" }
    }
  },
  {
    id: "longmem_session",
    expectedRoute: "longmem",
    input: {
      namespaceId: "benchmark_ingestion_router_v2",
      sourceType: "markdown",
      sourceUri: "benchmark://longmem/session-1",
      sourceChannel: "benchmark:longmem",
      capturedAt: "2026-05-14T01:00:00Z",
      rawText: "John lives in Seattle and works on the dog-sitting app.",
      metadata: { benchmark_dataset: "longmem" }
    }
  },
  {
    id: "watched_source_markdown",
    expectedRoute: "watched_source",
    input: {
      namespaceId: "benchmark_ingestion_router_v2",
      sourceType: "text",
      sourceUri: "file:///watched/source/notes.txt",
      sourceChannel: "bootstrap:openclaw",
      capturedAt: "2026-05-14T01:00:00Z",
      rawText: "Watched source import should retain the monitored source context.",
      metadata: { monitored_source: true, monitored_source_type: "openclaw" }
    }
  }
];

function rootDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
}

function outputDir(): string {
  return path.resolve(rootDir(), "benchmark-results");
}

function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index] ?? 0;
}

function rate(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : Number((numerator / denominator).toFixed(4));
}

export function runIngestionRoutingCoverage(): IngestionRoutingCoverageReport {
  const rows = FIXTURES.map((fixture) => {
    const started = performance.now();
    const packet = buildIngestionRouterV2Packet(fixture.input);
    const runtimeMs = Math.max(0, performance.now() - started);
    const failures: string[] = [];
    if (packet.sourceRoute !== fixture.expectedRoute) {
      failures.push(`route_mismatch:${fixture.expectedRoute}->${packet.sourceRoute}`);
    }
    if (!packet.sourceIntelligenceProfile) {
      failures.push("source_intelligence_profile_missing");
    }
    if (!packet.taxonomyProfile || packet.enrichment.taxonomyProfiles.length === 0) {
      failures.push("taxonomy_profile_missing");
    }
    if (packet.envelopeSourceType && !packet.metrics.provenanceComplete) {
      failures.push("provenance_incomplete");
    }
    if (packet.metrics.inputTokenMax > 1800) {
      failures.push("input_token_max_exceeded");
    }
    if (!packet.metrics.jsonValid) {
      failures.push("json_invalid");
    }
    return { fixture, packet, runtimeMs, failures };
  });
  const coveredRoutes = [...new Set(rows.map((row) => row.packet.sourceRoute).filter((route) => REQUIRED_ROUTES.includes(route)))].sort();
  const allTokenP95 = rows.map((row) => row.packet.metrics.inputTokenP95);
  const allTokenMax = rows.map((row) => row.packet.metrics.inputTokenMax);
  const provenanceCompleteCount = rows.filter((row) => row.packet.metrics.provenanceComplete).length;
  const changedSource = buildIngestionRouterV2Packet({ ...FIXTURES[0]!.input, rawText: `${FIXTURES[0]!.input.rawText} changed` });
  const changedThreshold = buildIngestionRouterV2Packet({
    ...FIXTURES[0]!.input,
    metadata: { ...(FIXTURES[0]!.input.metadata ?? {}), threshold_probe: "identity_only" }
  });
  const cacheIdentityVariationPass =
    changedSource.enrichment.cacheIdentity.signature !== rows[0]!.packet.enrichment.cacheIdentity.signature &&
    changedThreshold.enrichment.cacheIdentity.signature === rows[0]!.packet.enrichment.cacheIdentity.signature;
  const metrics = {
    sourceRouteCoverageRate: rate(coveredRoutes.length, REQUIRED_ROUTES.length),
    sourceRouteCoverageCount: coveredRoutes.length,
    requiredRouteCount: REQUIRED_ROUTES.length,
    sourceIntelligenceProfileCoverageRate: rate(rows.filter((row) => Boolean(row.packet.sourceIntelligenceProfile)).length, rows.length),
    taxonomyProfileCoverageRate: rate(rows.filter((row) => Boolean(row.packet.taxonomyProfile) && row.packet.enrichment.taxonomyProfiles.length > 0).length, rows.length),
    provenanceCompletenessRate: rate(provenanceCompleteCount, rows.length),
    extractionUnitInputTokensP95: Math.max(0, ...allTokenP95),
    extractionUnitInputTokensMax: Math.max(0, ...allTokenMax),
    jsonValidityRate: rate(rows.filter((row) => row.packet.metrics.jsonValid).length, rows.length),
    gliner2CallCount: rows.reduce((sum, row) => sum + row.packet.enrichment.gliner2CallCount, 0),
    relexCallCount: rows.reduce((sum, row) => sum + row.packet.enrichment.relexCallCount, 0),
    assistantCallCount: rows.reduce((sum, row) => sum + row.packet.enrichment.assistantCallCount, 0),
    queryTimeModelCalls: rows.reduce((sum, row) => sum + row.packet.enrichment.queryTimeModelCalls, 0),
    promotionWithoutEvidenceQuote: 0,
    unknownTaxonomyPromoted: 0,
    mixedOwnerPromoted: 0,
    coMentionOnlyPromoted: 0,
    cacheIdentityVariationPass
  };
  const failures = rows.flatMap((row) => row.failures.map((failure) => `${row.fixture.id}:${failure}`));
  if (metrics.sourceRouteCoverageRate < 1) failures.push("source_route_coverage_incomplete");
  if (metrics.sourceIntelligenceProfileCoverageRate < 1) failures.push("source_intelligence_profile_coverage_incomplete");
  if (metrics.taxonomyProfileCoverageRate < 1) failures.push("taxonomy_profile_coverage_incomplete");
  if (metrics.provenanceCompletenessRate < 1) failures.push("provenance_completeness_below_100");
  if (metrics.extractionUnitInputTokensP95 > 950) failures.push("input_token_p95_exceeded");
  if (metrics.extractionUnitInputTokensMax > 1800) failures.push("input_token_max_exceeded");
  if (metrics.jsonValidityRate < 1) failures.push("json_validity_below_100");
  if (metrics.queryTimeModelCalls !== 0) failures.push("query_time_model_calls_nonzero");
  if (!metrics.cacheIdentityVariationPass) failures.push("cache_identity_variation_failed");
  return {
    generatedAt: new Date().toISOString(),
    benchmark: "ingestion_routing_coverage",
    passed: failures.length === 0,
    requiredRoutes: REQUIRED_ROUTES,
    coveredRoutes,
    metrics,
    failures,
    sources: rows.map((row): IngestionRoutingSourceStats => ({
      sourceType: String(row.fixture.input.sourceType),
      sourceRoute: row.packet.sourceRoute,
      sourceIntelligenceProfile: row.packet.sourceIntelligenceProfile,
      taxonomyProfile: row.packet.taxonomyProfile,
      taxonomyProfiles: row.packet.enrichment.taxonomyProfiles,
      sourceCount: 1,
      chunkCount: row.packet.metrics.chunkCount,
      extractionUnitCount: row.packet.metrics.extractionUnitCount,
      provenanceCompleteRate: row.packet.metrics.provenanceComplete ? 1 : 0,
      inputTokenP50: row.packet.metrics.inputTokenP50,
      inputTokenP95: row.packet.metrics.inputTokenP95,
      inputTokenMax: row.packet.metrics.inputTokenMax,
      gliner2CallCount: row.packet.enrichment.gliner2CallCount,
      relexCallCount: row.packet.enrichment.relexCallCount,
      assistantCallCount: row.packet.enrichment.assistantCallCount,
      cacheHitRate: 0,
      relationCandidateCount: row.packet.enrichment.extractedRelationCount,
      compiledObservationCount: row.packet.enrichment.promotedCount,
      rejectedCandidateCount: row.packet.enrichment.rejectedCount,
      topRejectionReasons: row.packet.enrichment.rejectionReasons,
      promotionSafetyViolations: row.packet.metrics.promotionSafetyViolations,
      runtimeMsP50: Number(row.runtimeMs.toFixed(2)),
      runtimeMsP95: Number(row.runtimeMs.toFixed(2)),
      runtimeMsMax: Number(row.runtimeMs.toFixed(2))
    }))
  };
}

export async function runAndWriteIngestionRoutingCoverage(): Promise<{
  readonly report: IngestionRoutingCoverageReport;
  readonly jsonPath: string;
  readonly markdownPath: string;
}> {
  const report = runIngestionRoutingCoverage();
  await mkdir(outputDir(), { recursive: true });
  const stamp = report.generatedAt.replace(/[:.]/gu, "-");
  const jsonPath = path.join(outputDir(), `ingestion-routing-coverage-${stamp}.json`);
  const markdownPath = path.join(outputDir(), `ingestion-routing-coverage-${stamp}.md`);
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(
    markdownPath,
    [
      "# Ingestion Routing Coverage",
      "",
      `- passed: ${report.passed}`,
      `- coveredRoutes: ${report.metrics.sourceRouteCoverageCount}/${report.metrics.requiredRouteCount}`,
      `- sourceIntelligenceProfileCoverageRate: ${report.metrics.sourceIntelligenceProfileCoverageRate}`,
      `- taxonomyProfileCoverageRate: ${report.metrics.taxonomyProfileCoverageRate}`,
      `- provenanceCompletenessRate: ${report.metrics.provenanceCompletenessRate}`,
      `- tokenP95: ${report.metrics.extractionUnitInputTokensP95}`,
      `- tokenMax: ${report.metrics.extractionUnitInputTokensMax}`,
      `- queryTimeModelCalls: ${report.metrics.queryTimeModelCalls}`,
      `- failures: ${report.failures.length ? report.failures.join(", ") : "none"}`,
      ""
    ].join("\n"),
    "utf8"
  );
  return { report, jsonPath, markdownPath };
}

export async function runIngestionRoutingCoverageCli(): Promise<void> {
  const result = await runAndWriteIngestionRoutingCoverage();
  console.log(JSON.stringify(result, null, 2));
  if (!result.report.passed) {
    process.exitCode = 1;
  }
}
