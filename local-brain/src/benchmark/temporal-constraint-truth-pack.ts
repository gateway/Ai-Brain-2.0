import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { closePool } from "../db/client.js";
import { ingestArtifact } from "../ingest/worker.js";
import { executeMcpTool } from "../mcp/server.js";
import { rebuildTypedMemoryNamespace } from "../typed-memory/service.js";
import { buildBenchmarkRuntimeMetadata, type BenchmarkRuntimeMetadata } from "./runtime-metadata.js";

interface FixtureFile {
  readonly relativePath: string;
  readonly sourceType: "markdown" | "text";
  readonly capturedAt: string;
  readonly body: string;
}

interface Scenario {
  readonly id: string;
  readonly query: string;
  readonly expectedTerms: readonly string[];
  readonly forbiddenTerms?: readonly string[];
}

export interface TemporalConstraintTruthScenarioResult {
  readonly id: string;
  readonly query: string;
  readonly answer: string;
  readonly evidenceCount: number;
  readonly missingTerms: readonly string[];
  readonly forbiddenHits: readonly string[];
  readonly finalClaimSource: string | null;
  readonly passed: boolean;
}

export interface TemporalConstraintTruthPackReport {
  readonly generatedAt: string;
  readonly benchmark: "temporal_constraint_truth_pack";
  readonly runtime: BenchmarkRuntimeMetadata;
  readonly sampleCount: number;
  readonly passed: boolean;
  readonly results: readonly TemporalConstraintTruthScenarioResult[];
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
  return path.resolve(localBrainRoot(), "benchmark-generated", "temporal-constraint-truth-pack");
}

function fixtures(): readonly FixtureFile[] {
  return [
    {
      relativePath: "2024-01-02-spicy-history.md",
      sourceType: "markdown",
      capturedAt: "2024-01-02T09:00:00.000Z",
      body: ["# Food preference", "", "I love spicy food."].join("\n")
    },
    {
      relativePath: "2026-01-02-spicy-change.md",
      sourceType: "markdown",
      capturedAt: "2026-01-02T09:00:00.000Z",
      body: [
        "# Food change",
        "",
        "I avoid spicy food now.",
        "I can't have spicy food anymore."
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
      sourceChannel: "benchmark:temporal_constraint_truth_pack",
      capturedAt: fixture.capturedAt,
      skipNarrativeClaims: true,
      metadata: {
        benchmark: "temporal_constraint_truth_pack",
        fixture: fixture.relativePath
      }
    });
  }
}

function scenarios(): readonly Scenario[] {
  return [
    {
      id: "current_spicy_constraint",
      query: "Can I have spicy food now?",
      expectedTerms: ["avoid spicy food"],
      forbiddenTerms: ["love spicy food"]
    },
    {
      id: "historical_spicy_preference",
      query: "Did I use to like spicy food?",
      expectedTerms: ["used to like spicy food"],
      forbiddenTerms: ["avoid spicy food"]
    },
    {
      id: "point_in_time_spicy_preference",
      query: "Did I like spicy food in 2024?",
      expectedTerms: ["2024", "spicy food"],
      forbiddenTerms: ["avoid spicy food"]
    }
  ];
}

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9\s]/gu, " ").replace(/\s+/gu, " ").trim();
}

function missingTerms(text: string, terms: readonly string[]): readonly string[] {
  const normalized = normalizeText(text);
  return terms.filter((term) => !normalized.includes(normalizeText(term)));
}

function forbiddenHits(text: string, terms: readonly string[]): readonly string[] {
  const normalized = normalizeText(text);
  return terms.filter((term) => normalized.includes(normalizeText(term)));
}

async function runScenario(namespaceId: string, scenario: Scenario): Promise<TemporalConstraintTruthScenarioResult> {
  const wrapped = (await executeMcpTool("memory.search", {
    namespace_id: namespaceId,
    query: scenario.query,
    detail_mode: "full"
  })) as { readonly structuredContent?: unknown };
  const payload = wrapped.structuredContent as any;
  const answer = typeof payload?.answer === "string"
    ? payload.answer
    : typeof payload?.humanReadable?.answer === "string"
      ? payload.humanReadable.answer
      : "";
  const missing = missingTerms(answer, scenario.expectedTerms);
  const forbidden = forbiddenHits(answer, scenario.forbiddenTerms ?? []);
  const evidenceCount = typeof payload?.evidenceCount === "number" ? payload.evidenceCount : Array.isArray(payload?.evidence) ? payload.evidence.length : 0;
  return {
    id: scenario.id,
    query: scenario.query,
    answer,
    evidenceCount,
    missingTerms: missing,
    forbiddenHits: forbidden,
    finalClaimSource: typeof payload?.finalClaimSource === "string" ? payload.finalClaimSource : null,
    passed: missing.length === 0 && forbidden.length === 0 && evidenceCount > 0
  };
}

function toMarkdown(report: TemporalConstraintTruthPackReport): string {
  const lines = [
    "# Temporal Constraint Truth Pack",
    "",
    `- generatedAt: ${report.generatedAt}`,
    `- sampleCount: ${report.sampleCount}`,
    `- passed: ${report.passed}`,
    "",
    "## Results",
    ""
  ];
  for (const row of report.results) {
    lines.push(`- ${row.id}: passed=${row.passed} evidence=${row.evidenceCount} claimSource=${row.finalClaimSource ?? "unknown"} answer=${row.answer}`);
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

export async function runAndWriteTemporalConstraintTruthPack(): Promise<{
  readonly report: TemporalConstraintTruthPackReport;
  readonly output: { readonly jsonPath: string; readonly markdownPath: string };
}> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const namespaceId = `benchmark_temporal_constraint_truth_pack_${stamp}`;
  const { rootPath, files } = await writeFixtures(namespaceId);
  await ingestFixtures(namespaceId, rootPath, files);
  await rebuildTypedMemoryNamespace(namespaceId, { skipVectorActivation: true });
  const results: TemporalConstraintTruthScenarioResult[] = [];
  for (const scenario of scenarios()) {
    results.push(await runScenario(namespaceId, scenario));
  }
  const report: TemporalConstraintTruthPackReport = {
    generatedAt: new Date().toISOString(),
    benchmark: "temporal_constraint_truth_pack",
    runtime: buildBenchmarkRuntimeMetadata({
      benchmarkMode: "full",
      sampleControls: {
        namespaceId,
        queryTimeModelCalls: 0
      }
    }),
    sampleCount: results.length,
    passed: results.every((row) => row.passed),
    results
  };
  const stampName = report.generatedAt.replace(/[:.]/g, "-");
  await mkdir(outputDir(), { recursive: true });
  const jsonPath = path.join(outputDir(), `temporal-constraint-truth-pack-${stampName}.json`);
  const markdownPath = path.join(outputDir(), `temporal-constraint-truth-pack-${stampName}.md`);
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, toMarkdown(report), "utf8");
  return { report, output: { jsonPath, markdownPath } };
}

export async function runTemporalConstraintTruthPackCli(): Promise<void> {
  try {
    const { report, output } = await runAndWriteTemporalConstraintTruthPack();
    console.log(JSON.stringify({ passed: report.passed, sampleCount: report.sampleCount, output }, null, 2));
  } finally {
    await closePool();
  }
}
