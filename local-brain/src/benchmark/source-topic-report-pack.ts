import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { closePool } from "../db/client.js";
import { ingestArtifact } from "../ingest/worker.js";
import { executeMcpTool } from "../mcp/server.js";
import { buildBenchmarkRuntimeMetadata, type BenchmarkRuntimeMetadata } from "./runtime-metadata.js";

interface FixtureFile {
  readonly relativePath: string;
  readonly capturedAt: string;
  readonly body: string;
}

interface Scenario {
  readonly id: string;
  readonly toolName?: "memory.recap" | "memory.search";
  readonly query: string;
  readonly expectedTerms: readonly string[];
  readonly forbiddenTerms?: readonly string[];
}

export interface SourceTopicReportPackRow {
  readonly id: string;
  readonly query: string;
  readonly answer: string;
  readonly evidenceCount: number;
  readonly sourceTrailCount: number;
  readonly missingTerms: readonly string[];
  readonly forbiddenHits: readonly string[];
  readonly passed: boolean;
}

export interface SourceTopicReportPackReport {
  readonly generatedAt: string;
  readonly benchmark: "source_topic_report_pack";
  readonly runtime: BenchmarkRuntimeMetadata;
  readonly sampleCount: number;
  readonly passed: boolean;
  readonly results: readonly SourceTopicReportPackRow[];
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
  return path.resolve(localBrainRoot(), "benchmark-generated", "source-topic-report-pack");
}

function fixtures(): readonly FixtureFile[] {
  return [
    {
      relativePath: "2026-05-19-project-log.md",
      capturedAt: "2026-05-19T15:49:07.000Z",
      body: [
        "# Project Log: Two Way, Memoir Engine, AI Tools, and Travel",
        "",
        "I mentioned several active projects: integrating Discourse into the Two Way system with SSO, category/group access control, and GA4 event tracking; prototyping a memoir engine that turns interview audio into transcribed, speaker-separated, timestamped memoir content with entity extraction and life-graph building; developing a media studio marketplace for image, video, and audio generation models; working on an AI brain that ingests transcripts and supports routing, MCP, and Postgres storage; building a preset kitchen website that generates recipe-style images from simplified prompts."
      ].join("\n")
    },
    {
      relativePath: "2026-05-17-personal-note.md",
      capturedAt: "2026-05-17T09:00:00.000Z",
      body: [
        "# Personal note",
        "",
        "I mentioned a travel planning task about storing a Jeep and getting an RV running. This note should not replace the project-specific answer for Two Way or Memoir Engine."
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
      sourceType: "markdown",
      sourceChannel: "benchmark:source_topic_report_pack",
      capturedAt: fixture.capturedAt,
      skipNarrativeClaims: true,
      metadata: {
        benchmark: "source_topic_report_pack",
        fixture: fixture.relativePath
      }
    });
  }
}

function scenarios(): readonly Scenario[] {
  return [
    {
      id: "named_topic_two_way",
      query: "Summarize what I mentioned about Two Way recently.",
      expectedTerms: ["Discourse", "SSO", "GA4"],
      forbiddenTerms: ["Conversation unit between", "Topic segment about", "Jeep"]
    },
    {
      id: "named_topic_memoir_engine",
      query: "Summarize what I mentioned about Memoir Engine recently.",
      expectedTerms: ["interview audio", "entity extraction", "life-graph"],
      forbiddenTerms: ["Conversation unit between", "Topic segment about", "Jeep"]
    },
    {
      id: "project_inventory",
      query: "What projects have I talked about recently in project notes?",
      expectedTerms: ["Two Way", "memoir engine", "media studio", "AI brain", "preset kitchen"],
      forbiddenTerms: ["Conversation unit between", "Topic segment about"]
    },
    {
      id: "current_project_activity_search",
      toolName: "memory.search",
      query: "What am I actively building now?",
      expectedTerms: ["Two Way", "memoir engine"],
      forbiddenTerms: ["Conversation unit between", "Topic segment about"]
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

function payloadAnswer(payload: any): string {
  return String(payload?.summaryText ?? payload?.humanReadable?.answer ?? payload?.answer ?? "").trim();
}

async function runScenario(namespaceId: string, scenario: Scenario): Promise<SourceTopicReportPackRow> {
  const wrapped = (await executeMcpTool(scenario.toolName ?? "memory.recap", {
    namespace_id: namespaceId,
    query: scenario.query,
    limit: 8,
    detail_mode: "compact"
  })) as { readonly structuredContent?: unknown };
  const payload = wrapped.structuredContent as any;
  const answer = payloadAnswer(payload);
  const missing = missingTerms(answer, scenario.expectedTerms);
  const forbidden = forbiddenHits(answer, scenario.forbiddenTerms ?? []);
  const evidenceCount =
    typeof payload?.evidenceCount === "number"
      ? payload.evidenceCount
      : Array.isArray(payload?.evidence?.items)
        ? payload.evidence.items.length
        : 0;
  const sourceTrailCount = Array.isArray(payload?.sourceTrail) ? payload.sourceTrail.length : 0;
  return {
    id: scenario.id,
    query: scenario.query,
    answer,
    evidenceCount,
    sourceTrailCount,
    missingTerms: missing,
    forbiddenHits: forbidden,
    passed: missing.length === 0 && forbidden.length === 0 && evidenceCount > 0 && sourceTrailCount > 0 && answer.length > 0
  };
}

function toMarkdown(report: SourceTopicReportPackReport): string {
  const lines = [
    "# Source Topic Report Pack",
    "",
    `- generatedAt: ${report.generatedAt}`,
    `- sampleCount: ${report.sampleCount}`,
    `- passed: ${report.passed}`,
    "",
    "## Results",
    ""
  ];
  for (const row of report.results) {
    lines.push(`- ${row.id}: passed=${row.passed} evidence=${row.evidenceCount} sources=${row.sourceTrailCount}`);
    lines.push(`  - answer: ${row.answer}`);
    if (row.missingTerms.length > 0) {
      lines.push(`  - missingTerms: ${row.missingTerms.join(", ")}`);
    }
    if (row.forbiddenHits.length > 0) {
      lines.push(`  - forbiddenHits: ${row.forbiddenHits.join(", ")}`);
    }
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

export async function runAndWriteSourceTopicReportPack(): Promise<{
  readonly report: SourceTopicReportPackReport;
  readonly output: { readonly jsonPath: string; readonly markdownPath: string };
}> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const namespaceId = `benchmark_source_topic_report_pack_${stamp}`;
  const { rootPath, files } = await writeFixtures(namespaceId);
  await ingestFixtures(namespaceId, rootPath, files);
  const results: SourceTopicReportPackRow[] = [];
  for (const scenario of scenarios()) {
    results.push(await runScenario(namespaceId, scenario));
  }
  const report: SourceTopicReportPackReport = {
    generatedAt: new Date().toISOString(),
    benchmark: "source_topic_report_pack",
    runtime: buildBenchmarkRuntimeMetadata({
      benchmarkMode: "sampled",
      sampleControls: {
        scenarioCount: results.length,
        namespaceId
      }
    }),
    sampleCount: results.length,
    passed: results.every((row) => row.passed),
    results
  };
  await mkdir(outputDir(), { recursive: true });
  const jsonPath = path.join(outputDir(), `source-topic-report-pack-${stamp}.json`);
  const markdownPath = path.join(outputDir(), `source-topic-report-pack-${stamp}.md`);
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, toMarkdown(report), "utf8");
  return { report, output: { jsonPath, markdownPath } };
}

export async function runSourceTopicReportPackCli(): Promise<void> {
  try {
    const { output } = await runAndWriteSourceTopicReportPack();
    process.stdout.write(`${output.jsonPath}\n${output.markdownPath}\n`);
  } finally {
    await closePool().catch(() => undefined);
  }
}
