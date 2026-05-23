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

interface SourceIntelligenceFixture {
  readonly id: string;
  readonly expectedRoute: IngestionRouterV2SourceRoute;
  readonly expectedSourceProfile: SourceIntelligenceProfile;
  readonly expectedTaxonomyProfile: TaxonomyProfile;
  readonly expectedTaxonomyProfiles: readonly TaxonomyProfile[];
  readonly expectedCandidateBufferKind: "universal_candidate_buffer" | "relationship_candidates" | "review_only" | "none";
  readonly input: IngestionRouterV2Input;
}

interface SourceIntelligenceFixtureResult {
  readonly id: string;
  readonly sourceRoute: IngestionRouterV2SourceRoute;
  readonly sourceIntelligenceProfile: SourceIntelligenceProfile;
  readonly taxonomyProfile: TaxonomyProfile;
  readonly taxonomyProfiles: readonly TaxonomyProfile[];
  readonly primaryRetrievalDomain: string;
  readonly retrievalDomainCandidates: readonly string[];
  readonly candidateBufferKind: string;
  readonly rejectionReasons: readonly string[];
  readonly queryTimeModelCalls: number;
  readonly warmRerunModelCalls: number;
  readonly cacheSignatureStableOnWarmRun: boolean;
  readonly failures: readonly string[];
}

export interface SourceIntelligenceTaxonomyRoutingReport {
  readonly generatedAt: string;
  readonly benchmark: "source_intelligence_taxonomy_routing";
  readonly passed: boolean;
  readonly metrics: {
    readonly fixtureCount: number;
    readonly routeMatrixPassRate: number;
    readonly sourceIntelligenceProfileCoverageRate: number;
    readonly taxonomyProfileCoverageRate: number;
    readonly retrievalDomainCoverageRate: number;
    readonly reviewUnknownRoutingPass: boolean;
    readonly candidateBufferContractCoverageRate: number;
    readonly reviewOnlyRejectionReasonCoverageRate: number;
    readonly queryTimeModelCalls: number;
    readonly warmRerunModelCalls: number;
    readonly cacheIdentitySourceHashVariationPass: boolean;
    readonly cacheIdentitySourceRouteVariationPass: boolean;
  };
  readonly fixtures: readonly SourceIntelligenceFixtureResult[];
  readonly failures: readonly string[];
}

const FIXTURES: readonly SourceIntelligenceFixture[] = [
  {
    id: "omi_direct_fact_profile",
    expectedRoute: "omi",
    expectedSourceProfile: "semi_structured",
    expectedTaxonomyProfile: "direct_fact",
    expectedTaxonomyProfiles: ["direct_fact", "temporal_event", "relation_event"],
    expectedCandidateBufferKind: "universal_candidate_buffer",
    input: {
      namespaceId: "benchmark_source_intelligence",
      sourceType: "text",
      sourceUri: "omi://note/source-intelligence",
      sourceChannel: "omi",
      capturedAt: "2026-05-15T00:00:00Z",
      rawText: "I prefer hiking and my internet is 500 Mbps.",
      metadata: { monitored_source_type: "omi" }
    }
  },
  {
    id: "markdown_document_profile",
    expectedRoute: "markdown",
    expectedSourceProfile: "document",
    expectedTaxonomyProfile: "document_summary",
    expectedTaxonomyProfiles: ["document_summary", "direct_fact", "task_ops"],
    expectedCandidateBufferKind: "universal_candidate_buffer",
    input: {
      namespaceId: "benchmark_source_intelligence",
      sourceType: "markdown",
      sourceUri: "file:///notes/router.md",
      capturedAt: "2026-05-15T00:00:00Z",
      rawText: "# Router\n\nPreserve source-bound sections.\n\n## Tasks\n\n- Route by source shape."
    }
  },
  {
    id: "pdf_document_profile",
    expectedRoute: "pdf",
    expectedSourceProfile: "document",
    expectedTaxonomyProfile: "document_summary",
    expectedTaxonomyProfiles: ["document_summary", "direct_fact", "temporal_event"],
    expectedCandidateBufferKind: "universal_candidate_buffer",
    input: {
      namespaceId: "benchmark_source_intelligence",
      sourceType: "text",
      sourceUri: "file:///reports/router.pdf",
      mimeType: "application/pdf",
      capturedAt: "2026-05-15T00:00:00Z",
      rawText: "Page 1\nThe report says Mira bought a kayak in April."
    }
  },
  {
    id: "asr_transcript_profile",
    expectedRoute: "asr",
    expectedSourceProfile: "transcript",
    expectedTaxonomyProfile: "relation_event",
    expectedTaxonomyProfiles: ["relation_event", "direct_fact", "temporal_event", "profile_report"],
    expectedCandidateBufferKind: "relationship_candidates",
    input: {
      namespaceId: "benchmark_source_intelligence",
      sourceType: "transcript",
      sourceUri: "asr://recording/source-intelligence",
      capturedAt: "2026-05-15T00:00:00Z",
      rawText: "[00:00] Riley: I started a ceramics class because I wanted a quiet hobby."
    }
  },
  {
    id: "chat_dialogue_profile",
    expectedRoute: "chat",
    expectedSourceProfile: "dialogue",
    expectedTaxonomyProfile: "relation_event",
    expectedTaxonomyProfiles: ["relation_event", "direct_fact", "temporal_event", "profile_report"],
    expectedCandidateBufferKind: "relationship_candidates",
    input: {
      namespaceId: "benchmark_source_intelligence",
      sourceType: "chat_turn",
      sourceUri: "chat://thread/source-intelligence",
      capturedAt: "2026-05-15T00:00:00Z",
      rawText: "Riley: My favorite book is Dune.\nMara: That is Riley's favorite, not mine."
    }
  },
  {
    id: "task_list_profile",
    expectedRoute: "task_list",
    expectedSourceProfile: "task_list",
    expectedTaxonomyProfile: "task_ops",
    expectedTaxonomyProfiles: ["task_ops", "direct_fact", "temporal_event"],
    expectedCandidateBufferKind: "universal_candidate_buffer",
    input: {
      namespaceId: "benchmark_source_intelligence",
      sourceType: "text",
      sourceUri: "tasks://source-intelligence",
      capturedAt: "2026-05-15T00:00:00Z",
      rawText: "- Add Router v2 profile metrics.\n- Keep query-time model calls at zero.",
      metadata: { source_type_hint: "task_list" }
    }
  },
  {
    id: "calendar_export_profile",
    expectedRoute: "calendar",
    expectedSourceProfile: "structured",
    expectedTaxonomyProfile: "temporal_event",
    expectedTaxonomyProfiles: ["temporal_event", "direct_fact", "task_ops"],
    expectedCandidateBufferKind: "universal_candidate_buffer",
    input: {
      namespaceId: "benchmark_source_intelligence",
      sourceType: "calendar_export",
      sourceUri: "file:///calendar/export.ics",
      mimeType: "text/calendar",
      capturedAt: "2026-05-15T00:00:00Z",
      rawText: "BEGIN:VCALENDAR\nBEGIN:VEVENT\nDTSTART;VALUE=DATE:20260615\nSUMMARY:AI model review\nEND:VEVENT\nEND:VCALENDAR",
      metadata: { source_type_hint: "calendar_export" }
    }
  },
  {
    id: "locomo_dialogue_direct_profile",
    expectedRoute: "locomo",
    expectedSourceProfile: "dialogue",
    expectedTaxonomyProfile: "direct_fact",
    expectedTaxonomyProfiles: ["direct_fact", "relation_event", "temporal_event", "profile_report"],
    expectedCandidateBufferKind: "relationship_candidates",
    input: {
      namespaceId: "benchmark_source_intelligence",
      sourceType: "markdown",
      sourceUri: "benchmark://locomo/source-intelligence",
      sourceChannel: "benchmark:locomo",
      capturedAt: "2026-05-15T00:00:00Z",
      rawText: "Audrey: I prefer chicken.\nCalvin: I bought a Ferrari in June.",
      metadata: { benchmark_dataset: "locomo" }
    }
  },
  {
    id: "longmem_dialogue_direct_profile",
    expectedRoute: "longmem",
    expectedSourceProfile: "dialogue",
    expectedTaxonomyProfile: "direct_fact",
    expectedTaxonomyProfiles: ["direct_fact", "relation_event", "temporal_event"],
    expectedCandidateBufferKind: "relationship_candidates",
    input: {
      namespaceId: "benchmark_source_intelligence",
      sourceType: "markdown",
      sourceUri: "benchmark://longmem/source-intelligence",
      sourceChannel: "benchmark:longmem",
      capturedAt: "2026-05-15T00:00:00Z",
      rawText: "Jordan lives in Seattle and works on a tutoring app.",
      metadata: { benchmark_dataset: "longmem" }
    }
  },
  {
    id: "watched_document_profile",
    expectedRoute: "watched_source",
    expectedSourceProfile: "document",
    expectedTaxonomyProfile: "document_summary",
    expectedTaxonomyProfiles: ["document_summary", "direct_fact", "task_ops", "profile_report"],
    expectedCandidateBufferKind: "universal_candidate_buffer",
    input: {
      namespaceId: "benchmark_source_intelligence",
      sourceType: "text",
      sourceUri: "file:///watched/source-intelligence.txt",
      sourceChannel: "bootstrap:openclaw",
      capturedAt: "2026-05-15T00:00:00Z",
      rawText: "Watched source import should preserve monitored source context.",
      metadata: { monitored_source: true, monitored_source_type: "openclaw" }
    }
  },
  {
    id: "generic_review_only_profile",
    expectedRoute: "generic_text",
    expectedSourceProfile: "generic_text",
    expectedTaxonomyProfile: "review_only",
    expectedTaxonomyProfiles: ["review_only", "direct_fact"],
    expectedCandidateBufferKind: "review_only",
    input: {
      namespaceId: "benchmark_source_intelligence",
      sourceType: "text",
      sourceUri: "text://scratch/source-intelligence",
      capturedAt: "2026-05-15T00:00:00Z",
      rawText: "This is a generic note with no declared source shape."
    }
  },
  {
    id: "unsupported_binary_review_only",
    expectedRoute: "unsupported_binary",
    expectedSourceProfile: "unsupported_binary",
    expectedTaxonomyProfile: "review_only",
    expectedTaxonomyProfiles: ["review_only"],
    expectedCandidateBufferKind: "none",
    input: {
      namespaceId: "benchmark_source_intelligence",
      sourceType: "image",
      sourceUri: "file:///uploads/photo.png",
      capturedAt: "2026-05-15T00:00:00Z",
      rawText: ""
    }
  }
];

function rootDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
}

function outputDir(): string {
  return path.resolve(rootDir(), "benchmark-results");
}

function rate(numerator: number, denominator: number): number {
  return denominator === 0 ? 1 : Number((numerator / denominator).toFixed(4));
}

function includesAll<T extends string>(observed: readonly T[], expected: readonly T[]): boolean {
  return expected.every((value) => observed.includes(value));
}

export function runSourceIntelligenceTaxonomyRouting(): SourceIntelligenceTaxonomyRoutingReport {
  const fixtures = FIXTURES.map((fixture): SourceIntelligenceFixtureResult => {
    const packet = buildIngestionRouterV2Packet(fixture.input);
    const warmPacket = buildIngestionRouterV2Packet(fixture.input);
    const failures: string[] = [];
    if (packet.sourceRoute !== fixture.expectedRoute) {
      failures.push(`route_mismatch:${fixture.expectedRoute}->${packet.sourceRoute}`);
    }
    if (packet.sourceIntelligenceProfile !== fixture.expectedSourceProfile) {
      failures.push(`source_profile_mismatch:${fixture.expectedSourceProfile}->${packet.sourceIntelligenceProfile}`);
    }
    if (packet.taxonomyProfile !== fixture.expectedTaxonomyProfile) {
      failures.push(`taxonomy_profile_mismatch:${fixture.expectedTaxonomyProfile}->${packet.taxonomyProfile}`);
    }
    if (!includesAll(packet.enrichment.taxonomyProfiles, fixture.expectedTaxonomyProfiles)) {
      failures.push("taxonomy_profile_matrix_incomplete");
    }
    if (packet.enrichment.candidateBufferKind !== fixture.expectedCandidateBufferKind) {
      failures.push(`candidate_buffer_mismatch:${fixture.expectedCandidateBufferKind}->${packet.enrichment.candidateBufferKind}`);
    }
    if (packet.enrichment.queryTimeModelCalls !== 0) {
      failures.push("query_time_model_calls_present");
    }
    const warmRerunModelCalls =
      warmPacket.enrichment.gliner2CallCount + warmPacket.enrichment.relexCallCount + warmPacket.enrichment.assistantCallCount;
    if (warmRerunModelCalls !== 0) {
      failures.push("warm_rerun_model_calls_present");
    }
    if (packet.taxonomyProfile === "review_only" && packet.enrichment.rejectionReasons.length === 0) {
      failures.push("review_only_rejection_reason_missing");
    }
    return {
      id: fixture.id,
      sourceRoute: packet.sourceRoute,
      sourceIntelligenceProfile: packet.sourceIntelligenceProfile,
      taxonomyProfile: packet.taxonomyProfile,
      taxonomyProfiles: packet.enrichment.taxonomyProfiles,
      primaryRetrievalDomain: packet.primaryRetrievalDomain,
      retrievalDomainCandidates: packet.retrievalDomainCandidates,
      candidateBufferKind: packet.enrichment.candidateBufferKind,
      rejectionReasons: packet.enrichment.rejectionReasons,
      queryTimeModelCalls: packet.enrichment.queryTimeModelCalls,
      warmRerunModelCalls,
      cacheSignatureStableOnWarmRun: packet.enrichment.cacheIdentity.signature === warmPacket.enrichment.cacheIdentity.signature,
      failures
    };
  });
  const sourceHashChanged = buildIngestionRouterV2Packet({
    ...FIXTURES[0]!.input,
    rawText: `${FIXTURES[0]!.input.rawText} changed`
  });
  const sourceRouteChanged = buildIngestionRouterV2Packet({
    ...FIXTURES[0]!.input,
    sourceUri: "text://same-content-different-route",
    sourceChannel: "generic",
    metadata: {},
    rawText: FIXTURES[0]!.input.rawText
  });
  const baseline = buildIngestionRouterV2Packet(FIXTURES[0]!.input);
  const cacheIdentitySourceHashVariationPass = sourceHashChanged.enrichment.cacheIdentity.signature !== baseline.enrichment.cacheIdentity.signature;
  const cacheIdentitySourceRouteVariationPass = sourceRouteChanged.enrichment.cacheIdentity.signature !== baseline.enrichment.cacheIdentity.signature;
  const failures = fixtures.flatMap((fixture) => fixture.failures.map((failure) => `${fixture.id}:${failure}`));
  const metrics = {
    fixtureCount: fixtures.length,
    routeMatrixPassRate: rate(fixtures.filter((fixture) => fixture.failures.length === 0).length, fixtures.length),
    sourceIntelligenceProfileCoverageRate: rate(fixtures.filter((fixture) => Boolean(fixture.sourceIntelligenceProfile)).length, fixtures.length),
    taxonomyProfileCoverageRate: rate(fixtures.filter((fixture) => Boolean(fixture.taxonomyProfile) && fixture.taxonomyProfiles.length > 0).length, fixtures.length),
    retrievalDomainCoverageRate: rate(fixtures.filter((fixture) => Boolean(fixture.primaryRetrievalDomain) && fixture.retrievalDomainCandidates.length > 0).length, fixtures.length),
    reviewUnknownRoutingPass: fixtures
      .filter((fixture) => fixture.taxonomyProfile === "review_only")
      .every((fixture) => fixture.primaryRetrievalDomain === "review_unknown"),
    candidateBufferContractCoverageRate: rate(fixtures.filter((fixture) => Boolean(fixture.candidateBufferKind)).length, fixtures.length),
    reviewOnlyRejectionReasonCoverageRate: rate(
      fixtures.filter((fixture) => fixture.taxonomyProfile !== "review_only" || fixture.rejectionReasons.length > 0).length,
      fixtures.length
    ),
    queryTimeModelCalls: fixtures.reduce((sum, fixture) => sum + fixture.queryTimeModelCalls, 0),
    warmRerunModelCalls: fixtures.reduce((sum, fixture) => sum + fixture.warmRerunModelCalls, 0),
    cacheIdentitySourceHashVariationPass,
    cacheIdentitySourceRouteVariationPass
  };
  if (!cacheIdentitySourceHashVariationPass) failures.push("cache_identity_source_hash_variation_failed");
  if (!cacheIdentitySourceRouteVariationPass) failures.push("cache_identity_source_route_variation_failed");
  if (metrics.sourceIntelligenceProfileCoverageRate < 1) failures.push("source_intelligence_profile_coverage_incomplete");
  if (metrics.taxonomyProfileCoverageRate < 1) failures.push("taxonomy_profile_coverage_incomplete");
  if (metrics.retrievalDomainCoverageRate < 1) failures.push("retrieval_domain_coverage_incomplete");
  if (!metrics.reviewUnknownRoutingPass) failures.push("review_unknown_routing_failed");
  if (metrics.candidateBufferContractCoverageRate < 1) failures.push("candidate_buffer_contract_incomplete");
  if (metrics.reviewOnlyRejectionReasonCoverageRate < 1) failures.push("review_only_rejection_reason_missing");
  if (metrics.queryTimeModelCalls !== 0) failures.push("query_time_model_calls_present");
  if (metrics.warmRerunModelCalls !== 0) failures.push("warm_rerun_model_calls_present");
  return {
    generatedAt: new Date().toISOString(),
    benchmark: "source_intelligence_taxonomy_routing",
    passed: failures.length === 0,
    metrics,
    fixtures,
    failures
  };
}

function markdownReport(report: SourceIntelligenceTaxonomyRoutingReport): string {
  const rows = report.fixtures
    .map(
      (fixture) =>
        `| ${fixture.id} | ${fixture.sourceRoute} | ${fixture.sourceIntelligenceProfile} | ${fixture.taxonomyProfile} | ${fixture.candidateBufferKind} | ${fixture.failures.join(", ") || "none"} |`
    )
    .join("\n");
  return `# Source Intelligence Taxonomy Routing

- generatedAt: ${report.generatedAt}
- passed: ${report.passed}
- routeMatrixPassRate: ${report.metrics.routeMatrixPassRate}
- sourceIntelligenceProfileCoverageRate: ${report.metrics.sourceIntelligenceProfileCoverageRate}
- taxonomyProfileCoverageRate: ${report.metrics.taxonomyProfileCoverageRate}
- retrievalDomainCoverageRate: ${report.metrics.retrievalDomainCoverageRate}
- reviewUnknownRoutingPass: ${report.metrics.reviewUnknownRoutingPass}
- candidateBufferContractCoverageRate: ${report.metrics.candidateBufferContractCoverageRate}
- queryTimeModelCalls: ${report.metrics.queryTimeModelCalls}
- warmRerunModelCalls: ${report.metrics.warmRerunModelCalls}
- failures: ${report.failures.length ? report.failures.join(", ") : "none"}

| fixture | route | source profile | taxonomy profile | candidate buffer | failures |
| --- | --- | --- | --- | --- | --- |
${rows}
`;
}

export async function runAndWriteSourceIntelligenceTaxonomyRouting(): Promise<{
  readonly report: SourceIntelligenceTaxonomyRoutingReport;
  readonly jsonPath: string;
  readonly markdownPath: string;
}> {
  const report = runSourceIntelligenceTaxonomyRouting();
  await mkdir(outputDir(), { recursive: true });
  const stamp = report.generatedAt.replace(/[:.]/gu, "-");
  const jsonPath = path.join(outputDir(), `source-intelligence-taxonomy-routing-${stamp}.json`);
  const markdownPath = path.join(outputDir(), `source-intelligence-taxonomy-routing-${stamp}.md`);
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, markdownReport(report), "utf8");
  return { report, jsonPath, markdownPath };
}

export async function runSourceIntelligenceTaxonomyRoutingCli(): Promise<void> {
  const result = await runAndWriteSourceIntelligenceTaxonomyRouting();
  console.log(JSON.stringify(result, null, 2));
  if (!result.report.passed) {
    process.exitCode = 1;
  }
}
