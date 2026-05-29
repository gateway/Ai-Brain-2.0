import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { closePool } from "../db/client.js";
import { ingestArtifact } from "../ingest/worker.js";
import { executeMcpTool } from "../mcp/server.js";
import { rebuildTypedMemoryNamespace } from "../typed-memory/service.js";
import { answerTextFromPayload, payloadEvidenceCount, queryTimeModelCallsFromPayload } from "./query-benchmark-utils.js";
import { buildBenchmarkRuntimeMetadata, type BenchmarkRuntimeMetadata } from "./runtime-metadata.js";

type ToolName = "memory.extract_tasks" | "memory.extract_calendar";
type ExpectedBehavior = "clarify" | "explicit_window" | "fuzzy_window" | "anchored_task" | "anchored_event" | "change_decomposition";

interface FixtureFile {
  readonly relativePath: string;
  readonly sourceType: "markdown" | "text";
  readonly capturedAt: string;
  readonly body: string;
}

interface Scenario {
  readonly id: string;
  readonly toolName: ToolName;
  readonly query: string;
  readonly referenceNow?: string;
  readonly expectedBehavior: ExpectedBehavior;
  readonly expectedTerms?: readonly string[];
  readonly forbiddenTerms?: readonly string[];
}

interface TemporalClarificationRow {
  readonly id: string;
  readonly toolName: ToolName;
  readonly query: string;
  readonly expectedBehavior: ExpectedBehavior;
  readonly expectedAnswerShape: "list";
  readonly queryContract: string | null;
  readonly retrievalDomain: string | null;
  readonly finalClaimSource: string | null;
  readonly answer: string;
  readonly followUpAction: string | null;
  readonly clarificationPrompt: string | null;
  readonly temporalClarificationRequired: boolean;
  readonly temporalAmbiguityReason: string | null;
  readonly temporalCandidateWindows: readonly string[];
  readonly selectedTemporalAssumption: string | null;
  readonly usedEventWindow: boolean;
  readonly usedCapturedAtOnly: boolean;
  readonly queryDecompositionApplied: boolean;
  readonly evidenceCount: number;
  readonly sourceTrailCount: number;
  readonly claimAuditCount: number;
  readonly queryTimeModelCalls: number;
  readonly missingTerms: readonly string[];
  readonly forbiddenTermsReturned: readonly string[];
  readonly latencyMs: number;
  readonly residualOwner: string | null;
  readonly passed: boolean;
}

interface TemporalClarificationReport {
  readonly generatedAt: string;
  readonly benchmark: "temporal_clarification_pack";
  readonly runtime: BenchmarkRuntimeMetadata;
  readonly sampleCount: number;
  readonly passed: boolean;
  readonly metrics: {
    readonly monthOnlyWrongScopeCount: number;
    readonly monthOnlyBroadFallbackCount: number;
    readonly explicitYearWindowSelectionRate: number;
    readonly fuzzyWindowSelectionRate: number;
    readonly anchoredQueryPassRate: number;
    readonly temporalDecompositionCoverageRate: number;
    readonly clarificationRowsHavePrompt: number;
    readonly supportedEmptySourceTrailCount: number;
    readonly queryTimeModelCalls: number;
    readonly p95LatencyMs: number;
    readonly maxLatencyMs: number;
  };
  readonly results: readonly TemporalClarificationRow[];
}

function thisDir(): string {
  return path.dirname(fileURLToPath(import.meta.url));
}

function localBrainRoot(): string {
  return path.resolve(thisDir(), "../..");
}

function outputDir(): string {
  return path.resolve(localBrainRoot(), "benchmark-results");
}

function generatedRoot(): string {
  return path.resolve(localBrainRoot(), "benchmark-generated", "temporal-clarification-pack");
}

function fixtures(): readonly FixtureFile[] {
  return [
    {
      relativePath: "2025-07-archive-note.md",
      sourceType: "markdown",
      capturedAt: "2025-07-12T09:00:00.000Z",
      body: [
        "# Old July Archive",
        "",
        "In July 2025 I reviewed an old storage plan and cleaned up unrelated archive notes.",
        "This was not part of the 2026 US travel plan."
      ].join("\n")
    },
    {
      relativePath: "2026-05-18-travel-note.md",
      sourceType: "markdown",
      capturedAt: "2026-05-18T15:00:00.000Z",
      body: [
        "# Travel Planning",
        "",
        "I need to fly from Chiang Mai to San Francisco in mid to late July 2026.",
        "I should book the outbound flight, store the Jeep, and arrange the RV plan before I leave.",
        "I also mentioned a possible Iceland trip in early September 2026 after Burning Man."
      ].join("\n")
    }
  ];
}

async function writeFixtures(namespaceId: string): Promise<{ readonly rootPath: string; readonly files: readonly FixtureFile[] }> {
  const rootPath = path.join(generatedRoot(), namespaceId);
  await rm(rootPath, { recursive: true, force: true });
  for (const fixture of fixtures()) {
    const filePath = path.join(rootPath, fixture.relativePath);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, fixture.body, "utf8");
  }
  return { rootPath, files: fixtures() };
}

async function ingestFixtures(namespaceId: string, rootPath: string, files: readonly FixtureFile[]): Promise<void> {
  for (const fixture of files) {
    await ingestArtifact({
      namespaceId,
      inputUri: path.join(rootPath, fixture.relativePath),
      sourceType: fixture.sourceType,
      sourceChannel: "benchmark:temporal_clarification_pack",
      capturedAt: fixture.capturedAt,
      skipNarrativeClaims: true,
      metadata: {
        benchmark: "temporal_clarification_pack",
        fixture: fixture.relativePath
      }
    });
  }
}

function scenarios(): readonly Scenario[] {
  return [
    {
      id: "ambiguous_july_tasks",
      toolName: "memory.extract_tasks",
      query: "What things do I need to do in July?",
      referenceNow: "2026-05-29T00:00:00.000Z",
      expectedBehavior: "clarify"
    },
    {
      id: "ambiguous_july_calendar",
      toolName: "memory.extract_calendar",
      query: "What dates or commitments did I mention for July?",
      referenceNow: "2026-05-29T00:00:00.000Z",
      expectedBehavior: "clarify"
    },
    {
      id: "explicit_july_2026_calendar",
      toolName: "memory.extract_calendar",
      query: "What things do I need to do in July 2026?",
      referenceNow: "2026-05-29T00:00:00.000Z",
      expectedBehavior: "explicit_window",
      expectedTerms: ["San Francisco", "July 2026"],
      forbiddenTerms: ["July 2025", "archive"]
    },
    {
      id: "fuzzy_mid_late_july_calendar",
      toolName: "memory.extract_calendar",
      query: "What trips did I mention for mid to late July?",
      referenceNow: "2026-05-29T00:00:00.000Z",
      expectedBehavior: "fuzzy_window",
      expectedTerms: ["San Francisco"],
      forbiddenTerms: ["July 2025", "archive"]
    },
    {
      id: "fuzzy_summer_calendar",
      toolName: "memory.extract_calendar",
      query: "What did I mention for this summer?",
      referenceNow: "2026-05-29T00:00:00.000Z",
      expectedBehavior: "fuzzy_window",
      expectedTerms: ["San Francisco"],
      forbiddenTerms: ["July 2025", "archive"]
    },
    {
      id: "anchored_before_leave_tasks",
      toolName: "memory.extract_tasks",
      query: "What should I do before I leave?",
      referenceNow: "2026-05-29T00:00:00.000Z",
      expectedBehavior: "anchored_task",
      expectedTerms: ["San Francisco"],
      forbiddenTerms: ["July 2025", "archive"]
    },
    {
      id: "anchored_after_burning_man_calendar",
      toolName: "memory.extract_calendar",
      query: "What plans did I mention after Burning Man?",
      referenceNow: "2026-05-29T00:00:00.000Z",
      expectedBehavior: "anchored_event",
      expectedTerms: ["Iceland", "September"]
    },
    {
      id: "change_july_september_calendar",
      toolName: "memory.extract_calendar",
      query: "What changed about my July and September travel plans?",
      referenceNow: "2026-05-29T00:00:00.000Z",
      expectedBehavior: "change_decomposition",
      expectedTerms: ["San Francisco", "September"]
    }
  ];
}

function outputText(payload: any): string {
  return JSON.stringify(payload).toLowerCase();
}

function hasTerm(payload: any, term: string): boolean {
  return outputText(payload).includes(term.toLowerCase());
}

function latencyPercentile(values: readonly number[], percentile: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil((percentile / 100) * sorted.length) - 1);
  return Number(sorted[index]?.toFixed(2) ?? 0);
}

function candidateWindowLabels(payload: any): readonly string[] {
  const windows = Array.isArray(payload?.retrievalPlan?.temporalCandidateWindows)
    ? payload.retrievalPlan.temporalCandidateWindows
    : Array.isArray(payload?.meta?.temporalCandidateWindows)
      ? payload.meta.temporalCandidateWindows
      : [];
  return windows
    .map((item: any) => (typeof item?.label === "string" ? item.label : null))
    .filter((item: string | null): item is string => Boolean(item));
}

function residualOwnerForRow(row: Omit<TemporalClarificationRow, "residualOwner" | "passed">): string | null {
  if (row.queryTimeModelCalls !== 0) return "query_time_model_call";
  if (row.expectedBehavior === "clarify") {
    if (!row.temporalClarificationRequired || row.followUpAction !== "route_to_clarifications") return "month_only_clarification_missing";
    if (!row.clarificationPrompt) return "clarification_prompt_missing";
    if (row.evidenceCount > 0 || row.usedEventWindow || row.usedCapturedAtOnly) return "month_only_broad_fallback";
  } else {
    if (row.temporalClarificationRequired || row.followUpAction === "route_to_clarifications") return "over_clarification";
    if (row.expectedBehavior !== "anchored_task" && !row.usedEventWindow) return "event_window_not_selected";
    if (row.missingTerms.length > 0) return "expected_terms_missing";
    if (row.forbiddenTermsReturned.length > 0) return "scope_leak";
    if (row.evidenceCount === 0) return "source_missing";
    if (!row.finalClaimSource) return "final_claim_source_missing";
    if (row.evidenceCount > 0 && row.sourceTrailCount === 0) return "source_trail_missing";
  }
  return null;
}

async function runScenario(namespaceId: string, scenario: Scenario): Promise<TemporalClarificationRow> {
  const startedAt = performance.now();
  const wrapped = (await executeMcpTool(scenario.toolName, {
    namespace_id: namespaceId,
    query: scenario.query,
    referenceNow: scenario.referenceNow,
    detailMode: "compact",
    limit: 8
  })) as { readonly structuredContent?: any };
  const payload = wrapped.structuredContent ?? {};
  const retrievalPlan = payload.retrievalPlan ?? {};
  const expectedTerms = scenario.expectedTerms ?? [];
  const forbiddenTerms = scenario.forbiddenTerms ?? [];
  const rowBase = {
    id: scenario.id,
    toolName: scenario.toolName,
    query: scenario.query,
    expectedBehavior: scenario.expectedBehavior,
    expectedAnswerShape: "list" as const,
    queryContract: typeof payload.queryContract === "string" ? payload.queryContract : null,
    retrievalDomain: typeof payload.retrievalDomain === "string" ? payload.retrievalDomain : null,
    finalClaimSource: typeof payload.finalClaimSource === "string" ? payload.finalClaimSource : null,
    answer: typeof payload.answer === "string" ? payload.answer : answerTextFromPayload(payload),
    followUpAction: typeof payload.followUpAction === "string" ? payload.followUpAction : null,
    clarificationPrompt: typeof payload.clarificationHint?.suggestedPrompt === "string" ? payload.clarificationHint.suggestedPrompt : null,
    temporalClarificationRequired: retrievalPlan.temporalClarificationRequired === true || payload.meta?.temporalClarificationRequired === true,
    temporalAmbiguityReason:
      typeof retrievalPlan.temporalAmbiguityReason === "string"
        ? retrievalPlan.temporalAmbiguityReason
        : typeof payload.meta?.temporalAmbiguityReason === "string"
          ? payload.meta.temporalAmbiguityReason
          : null,
    temporalCandidateWindows: candidateWindowLabels(payload),
    selectedTemporalAssumption:
      typeof retrievalPlan.selectedTemporalAssumption === "string"
        ? retrievalPlan.selectedTemporalAssumption
        : typeof payload.meta?.selectedTemporalAssumption === "string"
          ? payload.meta.selectedTemporalAssumption
          : null,
    usedEventWindow: retrievalPlan.usedEventWindow === true,
    usedCapturedAtOnly: retrievalPlan.usedCapturedAtOnly === true,
    queryDecompositionApplied: retrievalPlan.queryDecompositionApplied === true,
    evidenceCount: payloadEvidenceCount(payload),
    sourceTrailCount: Array.isArray(payload.sourceTrail) ? payload.sourceTrail.length : 0,
    claimAuditCount: Array.isArray(payload.claimAudit) ? payload.claimAudit.length : 0,
    queryTimeModelCalls: queryTimeModelCallsFromPayload(payload),
    missingTerms: expectedTerms.filter((term) => !hasTerm(payload, term)),
    forbiddenTermsReturned: forbiddenTerms.filter((term) => hasTerm(payload, term)),
    latencyMs: Number((performance.now() - startedAt).toFixed(2))
  };
  const residualOwner = residualOwnerForRow(rowBase);
  return {
    ...rowBase,
    residualOwner,
    passed: residualOwner === null
  };
}

function markdownReport(report: TemporalClarificationReport): string {
  const lines = [
    "# Temporal Clarification Pack",
    "",
    `- generatedAt: ${report.generatedAt}`,
    `- passed: ${report.passed}`,
    `- monthOnlyWrongScopeCount: ${report.metrics.monthOnlyWrongScopeCount}`,
    `- monthOnlyBroadFallbackCount: ${report.metrics.monthOnlyBroadFallbackCount}`,
    `- explicitYearWindowSelectionRate: ${report.metrics.explicitYearWindowSelectionRate}`,
    `- fuzzyWindowSelectionRate: ${report.metrics.fuzzyWindowSelectionRate}`,
    `- anchoredQueryPassRate: ${report.metrics.anchoredQueryPassRate}`,
    `- temporalDecompositionCoverageRate: ${report.metrics.temporalDecompositionCoverageRate}`,
    `- queryTimeModelCalls: ${report.metrics.queryTimeModelCalls}`,
    "",
    "## Rows",
    "",
    "| id | expected | passed | residualOwner | evidence | sourceTrail | answer |",
    "| --- | --- | --- | --- | ---: | ---: | --- |",
    ...report.results.map((row) =>
      `| ${row.id} | ${row.expectedBehavior} | ${row.passed} | ${row.residualOwner ?? ""} | ${row.evidenceCount} | ${row.sourceTrailCount} | ${row.answer.replace(/\|/gu, "\\|").slice(0, 180)} |`
    )
  ];
  return `${lines.join("\n")}\n`;
}

export async function runAndWriteTemporalClarificationPack(): Promise<{
  readonly report: TemporalClarificationReport;
  readonly output: { readonly jsonPath: string; readonly markdownPath: string };
}> {
  const generatedAt = new Date().toISOString();
  const namespaceId = `benchmark_temporal_clarification_${generatedAt.replace(/[^0-9A-Za-z]/gu, "_")}`;
  const { rootPath, files } = await writeFixtures(namespaceId);
  await ingestFixtures(namespaceId, rootPath, files);
  await rebuildTypedMemoryNamespace(namespaceId);
  const results: TemporalClarificationRow[] = [];
  for (const scenario of scenarios()) {
    results.push(await runScenario(namespaceId, scenario));
  }
  const clarifyRows = results.filter((row) => row.expectedBehavior === "clarify");
  const explicitRows = results.filter((row) => row.expectedBehavior === "explicit_window");
  const fuzzyRows = results.filter((row) => row.expectedBehavior === "fuzzy_window");
  const anchoredRows = results.filter((row) => row.expectedBehavior === "anchored_task" || row.expectedBehavior === "anchored_event");
  const decompositionRows = results.filter((row) => row.expectedBehavior === "change_decomposition");
  const latencies = results.map((row) => row.latencyMs);
  const metrics = {
    monthOnlyWrongScopeCount: clarifyRows.filter((row) => !row.temporalClarificationRequired || row.followUpAction !== "route_to_clarifications").length,
    monthOnlyBroadFallbackCount: clarifyRows.filter((row) => row.evidenceCount > 0 || row.usedEventWindow || row.usedCapturedAtOnly).length,
    explicitYearWindowSelectionRate: explicitRows.filter((row) => row.usedEventWindow && row.passed).length / Math.max(1, explicitRows.length),
    fuzzyWindowSelectionRate: fuzzyRows.filter((row) => row.usedEventWindow && row.passed).length / Math.max(1, fuzzyRows.length),
    anchoredQueryPassRate: anchoredRows.filter((row) => row.passed).length / Math.max(1, anchoredRows.length),
    temporalDecompositionCoverageRate: decompositionRows.filter((row) => row.queryDecompositionApplied && row.usedEventWindow && row.passed).length / Math.max(1, decompositionRows.length),
    clarificationRowsHavePrompt: clarifyRows.filter((row) => row.clarificationPrompt && row.temporalCandidateWindows.length > 0).length,
    supportedEmptySourceTrailCount: results.filter((row) => row.evidenceCount > 0 && row.sourceTrailCount === 0).length,
    queryTimeModelCalls: results.reduce((sum, row) => sum + row.queryTimeModelCalls, 0),
    p95LatencyMs: latencyPercentile(latencies, 95),
    maxLatencyMs: Number(Math.max(0, ...latencies).toFixed(2))
  };
  const report: TemporalClarificationReport = {
    generatedAt,
    benchmark: "temporal_clarification_pack",
    runtime: buildBenchmarkRuntimeMetadata({
      benchmarkMode: "full",
      sampleControls: {
        namespaceId,
        scenarioCount: results.length
      }
    }),
    sampleCount: results.length,
    passed:
      results.every((row) => row.passed) &&
      metrics.monthOnlyWrongScopeCount === 0 &&
      metrics.monthOnlyBroadFallbackCount === 0 &&
      metrics.explicitYearWindowSelectionRate === 1 &&
      metrics.fuzzyWindowSelectionRate === 1 &&
      metrics.anchoredQueryPassRate === 1 &&
      metrics.temporalDecompositionCoverageRate === 1 &&
      metrics.clarificationRowsHavePrompt === clarifyRows.length &&
      metrics.supportedEmptySourceTrailCount === 0 &&
      metrics.queryTimeModelCalls === 0,
    metrics,
    results
  };
  await mkdir(outputDir(), { recursive: true });
  const stamp = generatedAt.replace(/[:.]/gu, "-");
  const jsonPath = path.join(outputDir(), `temporal-clarification-pack-${stamp}.json`);
  const markdownPath = path.join(outputDir(), `temporal-clarification-pack-${stamp}.md`);
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, markdownReport(report), "utf8");
  return { report, output: { jsonPath, markdownPath } };
}

export async function runTemporalClarificationPackCli(): Promise<void> {
  try {
    const { report, output } = await runAndWriteTemporalClarificationPack();
    process.stdout.write(`${output.jsonPath}\n${output.markdownPath}\n${JSON.stringify({ passed: report.passed, metrics: report.metrics }, null, 2)}\n`);
  } finally {
    await closePool();
  }
}
