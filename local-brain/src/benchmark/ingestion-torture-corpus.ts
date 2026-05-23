import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildIngestionRouterV2Packet, type IngestionRouterV2Input, type IngestionRouterV2SourceRoute } from "../ingest/router-v2.js";

interface TortureFixture {
  readonly id: string;
  readonly family: string;
  readonly expectedRoute: IngestionRouterV2SourceRoute;
  readonly input: IngestionRouterV2Input;
}

interface TortureFixtureResult {
  readonly id: string;
  readonly family: string;
  readonly expectedRoute: string;
  readonly observedRoute: string;
  readonly sourceIntelligenceProfile: string;
  readonly taxonomyProfile: string;
  readonly chunkCount: number;
  readonly extractionUnitCount: number;
  readonly provenanceComplete: boolean;
  readonly inputTokenP95: number;
  readonly inputTokenMax: number;
  readonly jsonValid: boolean;
  readonly queryTimeModelCalls: number;
  readonly gliner2CallCount: number;
  readonly relexCallCount: number;
  readonly assistantCallCount: number;
  readonly warmRerunModelCalls: number;
  readonly promotionSafetyViolations: readonly string[];
  readonly failures: readonly string[];
}

export interface IngestionTortureCorpusReport {
  readonly generatedAt: string;
  readonly benchmark: "ingestion_torture_corpus";
  readonly passed: boolean;
  readonly metrics: {
    readonly fixtureCount: number;
    readonly routeMatchRate: number;
    readonly sourceIntelligenceProfileCoverageRate: number;
    readonly taxonomyProfileCoverageRate: number;
    readonly provenanceCompletenessRate: number;
    readonly jsonValidityRate: number;
    readonly extractionUnitInputTokensP95: number;
    readonly extractionUnitInputTokensMax: number;
    readonly queryTimeModelCalls: number;
    readonly warmRerunModelCalls: number;
    readonly promotionSafetyViolationCount: number;
    readonly routerPacketP95Ms: number;
    readonly routerPacketMaxMs: number;
  };
  readonly fixtures: readonly TortureFixtureResult[];
  readonly failures: readonly string[];
}

const LONG_TEXT = Array.from({ length: 120 }, (_, index) => {
  const subject = index % 2 === 0 ? "Avery" : "Blake";
  return `${subject} note ${index + 1}: this sentence is source text for router chunk budget verification and should remain bounded.`;
}).join("\n");

const FIXTURES: readonly TortureFixture[] = [
  {
    id: "omi_noisy_note",
    family: "omi_noisy",
    expectedRoute: "omi",
    input: {
      namespaceId: "benchmark_ingestion_torture",
      sourceType: "text",
      sourceUri: "omi://watch/noisy-note",
      sourceChannel: "omi",
      capturedAt: "2026-05-14T01:00:00Z",
      rawText: "uhhh reminder maybe maybe I prefer biking not running actually biking. [noise] internet is 500 Mbps.",
      metadata: { monitored_source_type: "omi" }
    }
  },
  {
    id: "malformed_markdown",
    family: "malformed_markdown",
    expectedRoute: "markdown",
    input: {
      namespaceId: "benchmark_ingestion_torture",
      sourceType: "markdown",
      sourceUri: "file:///notes/malformed.md",
      capturedAt: "2026-05-14T01:00:00Z",
      rawText: "---\ntitle: Broken\n# Missing close\n\n## Tasks\n- preserve spans\n> nested quote: \"Mia said: I hate climbing\""
    }
  },
  {
    id: "ocr_risk_pdf_text",
    family: "ocr_risk",
    expectedRoute: "pdf",
    input: {
      namespaceId: "benchmark_ingestion_torture",
      sourceType: "text",
      sourceUri: "file:///uploads/ocr-report.txt",
      capturedAt: "2026-05-14T01:00:00Z",
      rawText: "--- Page 1 ---\nJ0rdan bought a kayak because he wanted quiet weekends.\n--- Page 2 ---\nOCR may confuse names and numbers.",
      metadata: { source_type_hint: "pdf", ocr_risk: true }
    }
  },
  {
    id: "asr_timestamps",
    family: "asr_timestamps",
    expectedRoute: "asr",
    input: {
      namespaceId: "benchmark_ingestion_torture",
      sourceType: "transcript",
      sourceUri: "asr://recording/timestamps",
      capturedAt: "2026-05-14T01:00:00Z",
      rawText: "[00:00.000] Sam: I want to open a small repair shop.\n[00:04.100] Sam: It is because I like fixing bikes."
    }
  },
  {
    id: "nested_quote_chat",
    family: "nested_quotes",
    expectedRoute: "chat",
    input: {
      namespaceId: "benchmark_ingestion_torture",
      sourceType: "chat_turn",
      sourceUri: "chat://thread/nested",
      capturedAt: "2026-05-14T01:00:00Z",
      rawText: "Nina: Omar told me \"I love sushi,\" but that is Omar's preference.\nMaya: Right, not yours."
    }
  },
  {
    id: "mixed_owner_trap",
    family: "mixed_owner",
    expectedRoute: "generic_text",
    input: {
      namespaceId: "benchmark_ingestion_torture",
      sourceType: "text",
      sourceUri: "text://traps/mixed-owner",
      capturedAt: "2026-05-14T01:00:00Z",
      rawText: "Alex likes hiking. Priya bought the camera. The system must not merge those facts."
    }
  },
  {
    id: "co_mention_trap",
    family: "co_mention",
    expectedRoute: "generic_text",
    input: {
      namespaceId: "benchmark_ingestion_torture",
      sourceType: "text",
      sourceUri: "text://traps/co-mention",
      capturedAt: "2026-05-14T01:00:00Z",
      rawText: "Dana and Luis were mentioned in the same meeting agenda. No relationship status is stated."
    }
  },
  {
    id: "task_list_messy",
    family: "task_list",
    expectedRoute: "task_list",
    input: {
      namespaceId: "benchmark_ingestion_torture",
      sourceType: "text",
      sourceUri: "tasks://messy",
      capturedAt: "2026-05-14T01:00:00Z",
      rawText: "TODO\n[ ] verify cache identity\n[x] keep source quotes\n- do not promote unknown taxonomy",
      metadata: { source_type_hint: "task_list" }
    }
  },
  {
    id: "long_bounded_generic",
    family: "chunk_budget",
    expectedRoute: "generic_text",
    input: {
      namespaceId: "benchmark_ingestion_torture",
      sourceType: "text",
      sourceUri: "text://large/bounded",
      capturedAt: "2026-05-14T01:00:00Z",
      rawText: LONG_TEXT
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
  return denominator === 0 ? 1 : Number((numerator / denominator).toFixed(4));
}

export function runIngestionTortureCorpus(): IngestionTortureCorpusReport {
  const runtimes: number[] = [];
  const fixtures = FIXTURES.map((fixture) => {
    const started = performance.now();
    const packet = buildIngestionRouterV2Packet(fixture.input);
    runtimes.push(Math.max(0, performance.now() - started));
    const warmPacket = buildIngestionRouterV2Packet(fixture.input);
    const warmRerunModelCalls =
      warmPacket.enrichment.gliner2CallCount + warmPacket.enrichment.relexCallCount + warmPacket.enrichment.assistantCallCount;
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
    if (!packet.metrics.provenanceComplete) {
      failures.push("provenance_incomplete");
    }
    if (packet.metrics.inputTokenMax > 1800) {
      failures.push("input_token_max_exceeded");
    }
    if (packet.metrics.inputTokenP95 > 950) {
      failures.push("input_token_p95_exceeded");
    }
    if (!packet.metrics.jsonValid) {
      failures.push("json_invalid");
    }
    if (packet.enrichment.queryTimeModelCalls !== 0) {
      failures.push("query_time_model_calls_present");
    }
    if (warmRerunModelCalls !== 0) {
      failures.push("warm_rerun_model_calls_present");
    }
    if (packet.metrics.promotionSafetyViolations.length > 0) {
      failures.push("promotion_safety_violation");
    }
    return {
      id: fixture.id,
      family: fixture.family,
      expectedRoute: fixture.expectedRoute,
      observedRoute: packet.sourceRoute,
      sourceIntelligenceProfile: packet.sourceIntelligenceProfile,
      taxonomyProfile: packet.taxonomyProfile,
      chunkCount: packet.metrics.chunkCount,
      extractionUnitCount: packet.metrics.extractionUnitCount,
      provenanceComplete: packet.metrics.provenanceComplete,
      inputTokenP95: packet.metrics.inputTokenP95,
      inputTokenMax: packet.metrics.inputTokenMax,
      jsonValid: packet.metrics.jsonValid,
      queryTimeModelCalls: packet.enrichment.queryTimeModelCalls,
      gliner2CallCount: packet.enrichment.gliner2CallCount,
      relexCallCount: packet.enrichment.relexCallCount,
      assistantCallCount: packet.enrichment.assistantCallCount,
      warmRerunModelCalls,
      promotionSafetyViolations: packet.metrics.promotionSafetyViolations,
      failures
    };
  });
  const failures = fixtures.flatMap((fixture) => fixture.failures.map((failure) => `${fixture.id}:${failure}`));
  const tokenP95Values = fixtures.map((fixture) => fixture.inputTokenP95);
  const tokenMaxValues = fixtures.map((fixture) => fixture.inputTokenMax);
  return {
    generatedAt: new Date().toISOString(),
    benchmark: "ingestion_torture_corpus",
    passed: failures.length === 0,
    metrics: {
      fixtureCount: fixtures.length,
      routeMatchRate: rate(fixtures.filter((fixture) => fixture.observedRoute === fixture.expectedRoute).length, fixtures.length),
      sourceIntelligenceProfileCoverageRate: rate(fixtures.filter((fixture) => Boolean(fixture.sourceIntelligenceProfile)).length, fixtures.length),
      taxonomyProfileCoverageRate: rate(fixtures.filter((fixture) => Boolean(fixture.taxonomyProfile)).length, fixtures.length),
      provenanceCompletenessRate: rate(fixtures.filter((fixture) => fixture.provenanceComplete).length, fixtures.length),
      jsonValidityRate: rate(fixtures.filter((fixture) => fixture.jsonValid).length, fixtures.length),
      extractionUnitInputTokensP95: Math.max(0, ...tokenP95Values),
      extractionUnitInputTokensMax: Math.max(0, ...tokenMaxValues),
      queryTimeModelCalls: fixtures.reduce((sum, fixture) => sum + fixture.queryTimeModelCalls, 0),
      warmRerunModelCalls: fixtures.reduce((sum, fixture) => sum + fixture.warmRerunModelCalls, 0),
      promotionSafetyViolationCount: fixtures.reduce((sum, fixture) => sum + fixture.promotionSafetyViolations.length, 0),
      routerPacketP95Ms: Number(percentile(runtimes, 95).toFixed(3)),
      routerPacketMaxMs: Number(Math.max(0, ...runtimes).toFixed(3))
    },
    fixtures,
    failures
  };
}

function markdownReport(report: IngestionTortureCorpusReport): string {
  const rows = report.fixtures
    .map(
      (fixture) =>
        `| ${fixture.id} | ${fixture.family} | ${fixture.expectedRoute} | ${fixture.observedRoute} | ${fixture.sourceIntelligenceProfile} | ${fixture.taxonomyProfile} | ${fixture.provenanceComplete ? "yes" : "no"} | ${fixture.inputTokenMax} | ${fixture.failures.join(", ") || "none"} |`
    )
    .join("\n");
  return `# Ingestion Torture Corpus

- generatedAt: ${report.generatedAt}
- passed: ${report.passed}
- fixtureCount: ${report.metrics.fixtureCount}
- routeMatchRate: ${report.metrics.routeMatchRate}
- sourceIntelligenceProfileCoverageRate: ${report.metrics.sourceIntelligenceProfileCoverageRate}
- taxonomyProfileCoverageRate: ${report.metrics.taxonomyProfileCoverageRate}
- provenanceCompletenessRate: ${report.metrics.provenanceCompletenessRate}
- inputTokenMax: ${report.metrics.extractionUnitInputTokensMax}
- queryTimeModelCalls: ${report.metrics.queryTimeModelCalls}
- warmRerunModelCalls: ${report.metrics.warmRerunModelCalls}

| fixture | family | expected | observed | source profile | taxonomy profile | provenance | token max | failures |
| --- | --- | --- | --- | --- | --- | --- | ---: | --- |
${rows}
`;
}

export async function runAndWriteIngestionTortureCorpus(): Promise<{
  readonly report: IngestionTortureCorpusReport;
  readonly jsonPath: string;
  readonly markdownPath: string;
}> {
  const report = runIngestionTortureCorpus();
  await mkdir(outputDir(), { recursive: true });
  const stamp = report.generatedAt.replace(/[:.]/gu, "-");
  const jsonPath = path.join(outputDir(), `ingestion-torture-corpus-${stamp}.json`);
  const markdownPath = path.join(outputDir(), `ingestion-torture-corpus-${stamp}.md`);
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, markdownReport(report), "utf8");
  return { report, jsonPath, markdownPath };
}

export async function runIngestionTortureCorpusCli(): Promise<void> {
  const result = await runAndWriteIngestionTortureCorpus();
  console.log(JSON.stringify(result, null, 2));
  if (!result.report.passed) {
    process.exitCode = 1;
  }
}
