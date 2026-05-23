import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { closePool } from "../db/client.js";
import { ingestArtifact } from "../ingest/worker.js";
import { executeMcpTool } from "../mcp/server.js";
import { rebuildTypedMemoryNamespace } from "../typed-memory/service.js";
import { buildBenchmarkRuntimeMetadata, type BenchmarkRuntimeMetadata } from "./runtime-metadata.js";
import { answerTextFromPayload, payloadEvidenceCount, queryTimeModelCallsFromPayload } from "./query-benchmark-utils.js";

type TemporalAuditTool = "memory.recap" | "memory.extract_tasks" | "memory.extract_calendar";

interface FixtureFile {
  readonly relativePath: string;
  readonly sourceType: "markdown" | "text";
  readonly capturedAt: string;
  readonly body: string;
}

interface TemporalAuditScenario {
  readonly id: string;
  readonly tool: TemporalAuditTool;
  readonly query: string;
  readonly timeStart?: string;
  readonly timeEnd?: string;
  readonly referenceNow?: string;
  readonly scopeModeExpected: "source_scope" | "event_window_scope" | "lifecycle_scope";
  readonly expectedSourceRelativePaths: readonly string[];
  readonly expectedTerms: readonly string[];
  readonly forbiddenTerms?: readonly string[];
  readonly fuzzyTemporal?: boolean;
  readonly exactTokenTerms?: readonly string[];
}

export interface TemporalMemoryAuditRow {
  readonly id: string;
  readonly tool: TemporalAuditTool;
  readonly query: string;
  readonly scopeModeExpected: "source_scope" | "event_window_scope" | "lifecycle_scope";
  readonly scopeModeSelected: string | null;
  readonly expectedSourceUris: readonly string[];
  readonly actualSourceUris: readonly string[];
  readonly expectedTerms: readonly string[];
  readonly missingTerms: readonly string[];
  readonly wrongScope: boolean;
  readonly usedEventWindow: boolean;
  readonly usedCapturedAtOnly: boolean;
  readonly evidenceCount: number;
  readonly supportPathCount: number;
  readonly eventMemoryUnitCount: number;
  readonly queryTimeModelCalls: number;
  readonly passed: boolean;
  readonly notes: string;
}

export interface TemporalMemoryAuditReport {
  readonly generatedAt: string;
  readonly benchmark: "temporal_memory_query_audit";
  readonly runtime: BenchmarkRuntimeMetadata;
  readonly sampleCount: number;
  readonly eventWindowScopePassRate: number;
  readonly latestNoteScopePassRate: number;
  readonly fuzzyTemporalPassRate: number;
  readonly temporalExactTokenPreservationRate: number;
  readonly usedCapturedAtOnlyWhenEventWindowExists: number;
  readonly temporalSupportPathCoverageRate: number;
  readonly eventMemoryUnitCoverageRate: number;
  readonly wrongScopeCount: number;
  readonly supportedZeroEvidenceCount: number;
  readonly queryTimeModelCalls: number;
  readonly passed: boolean;
  readonly results: readonly TemporalMemoryAuditRow[];
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
  return path.resolve(localBrainRoot(), "benchmark-generated", "temporal-memory-query-audit");
}

function fixtures(): readonly FixtureFile[] {
  return [
    {
      relativePath: "2026-05-10-travel-note.md",
      sourceType: "markdown",
      capturedAt: "2026-05-10T08:00:00.000Z",
      body: [
        "# Travel Planning",
        "",
        "I need to fly to San Francisco in mid to late July and stay for three weeks.",
        "I want to visit Tahoe the second weekend after I land.",
        "I need to book my outbound flight."
      ].join("\n")
    },
    {
      relativePath: "2026-05-12-ops-note.txt",
      sourceType: "text",
      capturedAt: "2026-05-12T10:00:00.000Z",
      body: [
        "I renewed my driver's license today.",
        "I need to call Tink about storing the Jeep.",
        "The passport appointment is blocked on the embassy site."
      ].join("\n")
    },
    {
      relativePath: "2026-05-14-latest-note.md",
      sourceType: "markdown",
      capturedAt: "2026-05-14T14:00:00.000Z",
      body: [
        "# Latest planning note",
        "",
        "I want to go to Iceland in early September for a week.",
        "I need to sell the RV after Burning Man.",
        "I need to store the Jeep with Tink before I leave.",
        "Lauren left Thailand on October 18, 2025."
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
      sourceChannel: "benchmark:temporal_memory_query_audit",
      capturedAt: fixture.capturedAt,
      skipNarrativeClaims: true,
      metadata: {
        benchmark: "temporal_memory_query_audit",
        fixture: fixture.relativePath
      }
    });
  }
}

function buildScenarios(rootPath: string): readonly TemporalAuditScenario[] {
  const latestPath = path.join(rootPath, "2026-05-14-latest-note.md");
  const julyPath = path.join(rootPath, "2026-05-10-travel-note.md");
  return [
    {
      id: "latest_note_recap",
      tool: "memory.recap",
      query: "What trips, dates, or commitments did I mention in my most recent note?",
      scopeModeExpected: "source_scope",
      expectedSourceRelativePaths: [latestPath],
      expectedTerms: ["Iceland", "RV", "Jeep"],
      forbiddenTerms: ["San Francisco", "license", "passport"]
    },
    {
      id: "latest_note_tasks",
      tool: "memory.extract_tasks",
      query: "What tasks did I mention in my most recent note?",
      scopeModeExpected: "source_scope",
      expectedSourceRelativePaths: [latestPath],
      expectedTerms: ["sell the RV", "store the Jeep"],
      forbiddenTerms: ["license", "passport", "outbound flight"]
    },
    {
      id: "july_explicit_window",
      tool: "memory.extract_calendar",
      query: "What trips did I mention for July 2026?",
      timeStart: "2026-07-01T00:00:00.000Z",
      timeEnd: "2026-07-31T23:59:59.999Z",
      referenceNow: "2026-05-19T00:00:00.000Z",
      scopeModeExpected: "event_window_scope",
      expectedSourceRelativePaths: [julyPath],
      expectedTerms: ["San Francisco"],
      forbiddenTerms: ["Iceland", "license", "passport"]
    },
    {
      id: "july_fuzzy_window",
      tool: "memory.extract_calendar",
      query: "What trips did I mention for mid to late July?",
      referenceNow: "2026-05-19T00:00:00.000Z",
      scopeModeExpected: "event_window_scope",
      expectedSourceRelativePaths: [julyPath],
      expectedTerms: ["San Francisco"],
      forbiddenTerms: ["Iceland", "license", "passport"],
      fuzzyTemporal: true
    },
    {
      id: "summer_window",
      tool: "memory.extract_calendar",
      query: "What did I mention this summer?",
      referenceNow: "2026-05-19T00:00:00.000Z",
      scopeModeExpected: "event_window_scope",
      expectedSourceRelativePaths: [julyPath],
      expectedTerms: ["San Francisco"],
      forbiddenTerms: ["Iceland", "license", "passport"],
      fuzzyTemporal: true
    },
    {
      id: "september_window",
      tool: "memory.extract_calendar",
      query: "What trips did I mention for early September?",
      referenceNow: "2026-05-19T00:00:00.000Z",
      scopeModeExpected: "event_window_scope",
      expectedSourceRelativePaths: [latestPath],
      expectedTerms: ["Iceland"],
      forbiddenTerms: ["San Francisco", "license", "passport"],
      fuzzyTemporal: true
    },
    {
      id: "after_burning_man",
      tool: "memory.extract_calendar",
      query: "What was I planning after Burning Man?",
      referenceNow: "2026-05-19T00:00:00.000Z",
      scopeModeExpected: "event_window_scope",
      expectedSourceRelativePaths: [latestPath],
      expectedTerms: ["sell the RV"],
      forbiddenTerms: ["San Francisco", "license", "passport"],
      fuzzyTemporal: true
    },
    {
      id: "exact_date_preservation",
      tool: "memory.extract_calendar",
      query: "When did Lauren leave Thailand?",
      referenceNow: "2026-05-19T00:00:00.000Z",
      scopeModeExpected: "event_window_scope",
      expectedSourceRelativePaths: [latestPath],
      expectedTerms: ["Lauren", "October 18, 2025"],
      forbiddenTerms: ["San Francisco", "license", "passport"],
      exactTokenTerms: ["October 18, 2025"]
    }
  ];
}

function sourceUrisFromPayload(payload: any): readonly string[] {
  const sourceTrail = Array.isArray(payload?.sourceTrail) ? payload.sourceTrail : [];
  const direct: string[] = sourceTrail
    .map((entry: any) => (typeof entry?.sourceUri === "string" ? entry.sourceUri.trim() : ""))
    .filter((value: string) => value.length > 0);
  if (direct.length > 0) {
    return [...new Set(direct)];
  }
  const evidence = Array.isArray(payload?.evidence) ? payload.evidence : Array.isArray(payload?.duality?.evidence) ? payload.duality.evidence : [];
  const fallback: string[] = evidence
    .map((entry: any) => (typeof entry?.sourceUri === "string" ? entry.sourceUri.trim() : ""))
    .filter((value: string) => value.length > 0);
  return [...new Set(fallback)];
}

function missingTerms(text: string, terms: readonly string[]): readonly string[] {
  const lowered = text.toLowerCase();
  return terms.filter((term) => !lowered.includes(term.toLowerCase()));
}

function forbiddenHits(text: string, terms: readonly string[]): readonly string[] {
  const lowered = text.toLowerCase();
  return terms.filter((term) => lowered.includes(term.toLowerCase()));
}

async function runScenario(namespaceId: string, scenario: TemporalAuditScenario): Promise<TemporalMemoryAuditRow> {
  const wrapped = (await executeMcpTool(scenario.tool, {
    namespace_id: namespaceId,
    query: scenario.query,
    time_start: scenario.timeStart,
    time_end: scenario.timeEnd,
    reference_now: scenario.referenceNow,
    detail_mode: "full"
  })) as { readonly structuredContent?: unknown };
  const payload = wrapped.structuredContent as any;
  const actualSourceUris = sourceUrisFromPayload(payload);
  const answerText =
    scenario.tool === "memory.extract_calendar"
      ? Array.isArray(payload?.commitments)
        ? payload.commitments
            .map((item: any) => `${String(item?.title ?? "")} ${String(item?.timeHint ?? "")}`)
            .join("; ")
        : ""
      : answerTextFromPayload(payload, scenario.tool);
  const notes = [`sources=${actualSourceUris.length}`];
  const selectedScope = typeof payload?.retrievalPlan?.scopeMode === "string" ? payload.retrievalPlan.scopeMode : null;
  const expectedSourceUris = scenario.expectedSourceRelativePaths;
  const missing = missingTerms(answerText, scenario.expectedTerms);
  const exactMissing = scenario.exactTokenTerms ? missingTerms(answerText, scenario.exactTokenTerms) : [];
  const forbidden = forbiddenHits(answerText, scenario.forbiddenTerms ?? []);
  const wrongScope = selectedScope !== scenario.scopeModeExpected;
  const supportPathCount = Array.isArray(payload?.retrievalPlan?.temporalSupportPaths) ? payload.retrievalPlan.temporalSupportPaths.length : 0;
  const eventMemoryUnitCount = Array.isArray(payload?.eventMemoryUnits) ? payload.eventMemoryUnits.length : 0;
  const eventScopeMustUseEventWindow = scenario.scopeModeExpected === "event_window_scope";
  const passed =
    !wrongScope &&
    missing.length === 0 &&
    exactMissing.length === 0 &&
    forbidden.length === 0 &&
    (!eventScopeMustUseEventWindow || payload?.retrievalPlan?.usedEventWindow === true) &&
    (!eventScopeMustUseEventWindow || payload?.retrievalPlan?.usedCapturedAtOnly !== true) &&
    (!eventScopeMustUseEventWindow || supportPathCount > 0) &&
    (!eventScopeMustUseEventWindow || eventMemoryUnitCount > 0) &&
    actualSourceUris.length > 0 &&
    actualSourceUris.every((uri) => expectedSourceUris.includes(uri)) &&
    queryTimeModelCallsFromPayload(payload) === 0 &&
    payloadEvidenceCount(payload) > 0;
  notes.push(`expected=${scenario.scopeModeExpected}`);
  notes.push(`actual=${selectedScope ?? "missing"}`);
  if (missing.length > 0) {
    notes.push(`missing=${missing.join("|")}`);
  }
  if (exactMissing.length > 0) {
    notes.push(`exactMissing=${exactMissing.join("|")}`);
  }
  if (forbidden.length > 0) {
    notes.push(`forbidden=${forbidden.join("|")}`);
  }
  return {
    id: scenario.id,
    tool: scenario.tool,
    query: scenario.query,
    scopeModeExpected: scenario.scopeModeExpected,
    scopeModeSelected: selectedScope,
    expectedSourceUris,
    actualSourceUris,
    expectedTerms: scenario.expectedTerms,
    missingTerms: missing,
    wrongScope,
    usedEventWindow: payload?.retrievalPlan?.usedEventWindow === true,
    usedCapturedAtOnly: payload?.retrievalPlan?.usedCapturedAtOnly === true,
    evidenceCount: payloadEvidenceCount(payload),
    supportPathCount,
    eventMemoryUnitCount,
    queryTimeModelCalls: queryTimeModelCallsFromPayload(payload),
    passed,
    notes: notes.join(" ")
  };
}

function toMarkdown(report: TemporalMemoryAuditReport): string {
  const lines = [
    "# Temporal Memory Query Audit",
    "",
    `- generatedAt: ${report.generatedAt}`,
    `- sampleCount: ${report.sampleCount}`,
    `- eventWindowScopePassRate: ${report.eventWindowScopePassRate}`,
    `- latestNoteScopePassRate: ${report.latestNoteScopePassRate}`,
    `- fuzzyTemporalPassRate: ${report.fuzzyTemporalPassRate}`,
    `- temporalExactTokenPreservationRate: ${report.temporalExactTokenPreservationRate}`,
    `- usedCapturedAtOnlyWhenEventWindowExists: ${report.usedCapturedAtOnlyWhenEventWindowExists}`,
    `- temporalSupportPathCoverageRate: ${report.temporalSupportPathCoverageRate}`,
    `- eventMemoryUnitCoverageRate: ${report.eventMemoryUnitCoverageRate}`,
    `- wrongScopeCount: ${report.wrongScopeCount}`,
    `- supportedZeroEvidenceCount: ${report.supportedZeroEvidenceCount}`,
    `- queryTimeModelCalls: ${report.queryTimeModelCalls}`,
    `- passed: ${report.passed}`,
    "",
    "## Results",
    ""
  ];
  for (const row of report.results) {
    lines.push(`- ${row.id}: passed=${row.passed} scope=${row.scopeModeSelected ?? "missing"} evidence=${row.evidenceCount}`);
    lines.push(`  - notes: ${row.notes}`);
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function rate(numerator: number, denominator: number): number {
  return denominator === 0 ? 1 : Number((numerator / denominator).toFixed(4));
}

export async function runAndWriteTemporalMemoryQueryAudit(): Promise<{
  readonly report: TemporalMemoryAuditReport;
  readonly output: { readonly jsonPath: string; readonly markdownPath: string };
}> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const namespaceId = `benchmark_temporal_memory_query_audit_${stamp}`;
  const { rootPath, files } = await writeFixtures(namespaceId);
  await ingestFixtures(namespaceId, rootPath, files);
  await rebuildTypedMemoryNamespace(namespaceId, { skipVectorActivation: true });
  const scenarios = buildScenarios(rootPath);
  const results: TemporalMemoryAuditRow[] = [];
  for (const scenario of scenarios) {
    results.push(await runScenario(namespaceId, scenario));
  }
  const eventWindowRows = results.filter((row) => row.scopeModeExpected === "event_window_scope");
  const latestNoteRows = results.filter((row) => row.scopeModeExpected === "source_scope");
  const fuzzyIds = new Set(scenarios.filter((scenario) => scenario.fuzzyTemporal).map((scenario) => scenario.id));
  const fuzzyRows = results.filter((row) => fuzzyIds.has(row.id));
  const exactIds = new Set(scenarios.filter((scenario) => (scenario.exactTokenTerms?.length ?? 0) > 0).map((scenario) => scenario.id));
  const exactRows = results.filter((row) => exactIds.has(row.id));
  const report: TemporalMemoryAuditReport = {
    generatedAt: new Date().toISOString(),
    benchmark: "temporal_memory_query_audit",
    runtime: buildBenchmarkRuntimeMetadata({
      benchmarkMode: "sampled",
      sampleControls: {
        scenarioCount: results.length,
        namespaceId
      }
    }),
    sampleCount: results.length,
    eventWindowScopePassRate: rate(eventWindowRows.filter((row) => row.passed && row.usedEventWindow && !row.usedCapturedAtOnly).length, eventWindowRows.length),
    latestNoteScopePassRate: rate(latestNoteRows.filter((row) => row.passed && row.usedCapturedAtOnly).length, latestNoteRows.length),
    fuzzyTemporalPassRate: rate(fuzzyRows.filter((row) => row.passed && row.usedEventWindow).length, fuzzyRows.length),
    temporalExactTokenPreservationRate: rate(exactRows.filter((row) => row.passed).length, exactRows.length),
    usedCapturedAtOnlyWhenEventWindowExists: eventWindowRows.filter((row) => row.usedCapturedAtOnly).length,
    temporalSupportPathCoverageRate: rate(eventWindowRows.filter((row) => row.supportPathCount > 0).length, eventWindowRows.length),
    eventMemoryUnitCoverageRate: rate(eventWindowRows.filter((row) => row.eventMemoryUnitCount > 0).length, eventWindowRows.length),
    wrongScopeCount: results.filter((row) => row.wrongScope).length,
    supportedZeroEvidenceCount: results.filter((row) => row.evidenceCount <= 0).length,
    queryTimeModelCalls: results.reduce((sum, row) => sum + row.queryTimeModelCalls, 0),
    passed:
      results.every((row) => row.passed) &&
      eventWindowRows.every((row) => row.usedEventWindow && !row.usedCapturedAtOnly) &&
      latestNoteRows.every((row) => row.usedCapturedAtOnly) &&
      eventWindowRows.every((row) => row.supportPathCount > 0 && row.eventMemoryUnitCount > 0),
    results
  };
  await mkdir(outputDir(), { recursive: true });
  const jsonPath = path.join(outputDir(), `temporal-memory-query-audit-${stamp}.json`);
  const markdownPath = path.join(outputDir(), `temporal-memory-query-audit-${stamp}.md`);
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, toMarkdown(report), "utf8");
  return { report, output: { jsonPath, markdownPath } };
}

export async function runTemporalMemoryQueryAuditCli(): Promise<void> {
  try {
    const { output } = await runAndWriteTemporalMemoryQueryAudit();
    process.stdout.write(`${output.jsonPath}\n${output.markdownPath}\n`);
  } finally {
    await closePool().catch(() => undefined);
  }
}
