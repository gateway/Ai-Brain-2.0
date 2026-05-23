import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { closePool, queryRows, withClient } from "../db/client.js";
import { ingestArtifact } from "../ingest/worker.js";
import { runCandidateConsolidation } from "../jobs/consolidation.js";
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

interface MetadataCountRow {
  readonly count: string;
}

export interface TemporalTruthProductionScenarioResult {
  readonly id: string;
  readonly query: string;
  readonly answer: string;
  readonly evidenceCount: number;
  readonly missingTerms: readonly string[];
  readonly forbiddenHits: readonly string[];
  readonly finalClaimSource: string | null;
  readonly passed: boolean;
}

export interface TemporalTruthProductionPackReport {
  readonly generatedAt: string;
  readonly benchmark: "temporal_truth_production_pack";
  readonly runtime: BenchmarkRuntimeMetadata;
  readonly sampleCount: number;
  readonly truthMetadataCount: number;
  readonly malformedActivePreferenceCount: number;
  readonly passed: boolean;
  readonly results: readonly TemporalTruthProductionScenarioResult[];
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
  return path.resolve(localBrainRoot(), "benchmark-generated", "temporal-truth-production-pack");
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
      body: ["# Food change", "", "I avoid spicy food now.", "I like nachos now."].join("\n")
    },
    {
      relativePath: "2026-01-03-capability-constraint.md",
      sourceType: "markdown",
      capturedAt: "2026-01-03T09:00:00.000Z",
      body: ["# Capability constraint", "", "I avoid heavy lifting now."].join("\n")
    },
    {
      relativePath: "2026-01-04-malformed-food.md",
      sourceType: "markdown",
      capturedAt: "2026-01-04T09:00:00.000Z",
      body: ["# Noisy transcript preference", "", "I like is like, a good steak is always great."].join("\n")
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
      sourceChannel: "benchmark:temporal_truth_production_pack",
      capturedAt: fixture.capturedAt,
      skipNarrativeClaims: true,
      metadata: {
        benchmark: "temporal_truth_production_pack",
        fixture: fixture.relativePath
      }
    });
  }
}

async function seedConsolidationCandidates(namespaceId: string): Promise<void> {
  await withClient(async (client) => {
    await client.query(
      `
        INSERT INTO memory_candidates (namespace_id, candidate_type, content, confidence, metadata, created_at)
        VALUES
          ($1, 'semantic_preference', 'I love spicy food.', 0.92, '{"benchmark":"temporal_truth_production_pack"}'::jsonb, '2024-01-02T09:00:00.000Z'::timestamptz),
          ($1, 'semantic_preference', 'I avoid spicy food now.', 0.92, '{"benchmark":"temporal_truth_production_pack"}'::jsonb, '2026-01-02T09:00:00.000Z'::timestamptz),
          ($1, 'semantic_preference', 'I like is like, a good steak is always great.', 0.92, '{"benchmark":"temporal_truth_production_pack"}'::jsonb, '2026-01-04T09:00:00.000Z'::timestamptz)
      `,
      [namespaceId]
    );
  });
}

function scenarios(): readonly Scenario[] {
  return [
    {
      id: "preference_change_over_time",
      query: "What changed about my food preferences?",
      expectedTerms: ["changed from liking spicy food", "avoiding spicy food"],
      forbiddenTerms: ["good steak", "is like"]
    },
    {
      id: "capability_constraint",
      query: "Should I avoid heavy lifting now?",
      expectedTerms: ["avoid heavy lifting"],
      forbiddenTerms: ["good steak", "is like"]
    },
    {
      id: "current_projection_malformed_suppressed",
      query: "What food do I like now?",
      expectedTerms: ["nachos"],
      forbiddenTerms: ["good steak", "is like"]
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

async function runScenario(namespaceId: string, scenario: Scenario): Promise<TemporalTruthProductionScenarioResult> {
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

async function countTruthMetadata(namespaceId: string): Promise<number> {
  const rows = await queryRows<MetadataCountRow>(
    `
      SELECT count(*)::text AS count
      FROM procedural_memory
      WHERE namespace_id = $1
        AND state_type = 'preference'
        AND state_value ? 'truth_cluster_id'
        AND state_value ? 'truth_kind'
        AND metadata ? 'decay_class'
    `,
    [namespaceId]
  );
  return Number(rows[0]?.count ?? "0");
}

async function countMalformedActivePreferences(namespaceId: string): Promise<number> {
  const rows = await queryRows<MetadataCountRow>(
    `
      SELECT count(*)::text AS count
      FROM procedural_memory
      WHERE namespace_id = $1
        AND state_type = 'preference'
        AND valid_until IS NULL
        AND (
          lower(coalesce(state_value->>'target', '')) ~ '^(is like|like)\\y'
          OR lower(coalesce(state_value->>'target', '')) LIKE '%always great%'
          OR lower(coalesce(state_value->>'target', '')) LIKE '%usually like is%'
        )
    `,
    [namespaceId]
  );
  return Number(rows[0]?.count ?? "0");
}

function toMarkdown(report: TemporalTruthProductionPackReport): string {
  const lines = [
    "# Temporal Truth Production Pack",
    "",
    `- generatedAt: ${report.generatedAt}`,
    `- sampleCount: ${report.sampleCount}`,
    `- truthMetadataCount: ${report.truthMetadataCount}`,
    `- malformedActivePreferenceCount: ${report.malformedActivePreferenceCount}`,
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

export async function runAndWriteTemporalTruthProductionPack(): Promise<{
  readonly report: TemporalTruthProductionPackReport;
  readonly output: { readonly jsonPath: string; readonly markdownPath: string };
}> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const namespaceId = `benchmark_temporal_truth_production_pack_${stamp}`;
  const { rootPath, files } = await writeFixtures(namespaceId);
  await ingestFixtures(namespaceId, rootPath, files);
  await seedConsolidationCandidates(namespaceId);
  await runCandidateConsolidation(namespaceId, 50);
  await rebuildTypedMemoryNamespace(namespaceId, { skipVectorActivation: true });
  const results: TemporalTruthProductionScenarioResult[] = [];
  for (const scenario of scenarios()) {
    results.push(await runScenario(namespaceId, scenario));
  }
  const truthMetadataCount = await countTruthMetadata(namespaceId);
  const malformedActivePreferenceCount = await countMalformedActivePreferences(namespaceId);
  const report: TemporalTruthProductionPackReport = {
    generatedAt: new Date().toISOString(),
    benchmark: "temporal_truth_production_pack",
    runtime: buildBenchmarkRuntimeMetadata({
      benchmarkMode: "full",
      sampleControls: {
        namespaceId,
        queryTimeModelCalls: 0
      }
    }),
    sampleCount: results.length,
    truthMetadataCount,
    malformedActivePreferenceCount,
    passed: results.every((row) => row.passed) && truthMetadataCount > 0 && malformedActivePreferenceCount === 0,
    results
  };
  const stampName = report.generatedAt.replace(/[:.]/g, "-");
  await mkdir(outputDir(), { recursive: true });
  const jsonPath = path.join(outputDir(), `temporal-truth-production-pack-${stampName}.json`);
  const markdownPath = path.join(outputDir(), `temporal-truth-production-pack-${stampName}.md`);
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, toMarkdown(report), "utf8");
  return { report, output: { jsonPath, markdownPath } };
}

export async function runTemporalTruthProductionPackCli(): Promise<void> {
  try {
    const { report, output } = await runAndWriteTemporalTruthProductionPack();
    console.log(JSON.stringify({ passed: report.passed, sampleCount: report.sampleCount, truthMetadataCount: report.truthMetadataCount, malformedActivePreferenceCount: report.malformedActivePreferenceCount, output }, null, 2));
  } finally {
    await closePool();
  }
}
