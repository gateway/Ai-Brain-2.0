import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { closePool } from "../db/client.js";
import { executeMcpTool } from "../mcp/server.js";
import { runAndWriteHumanSyntheticWatchBenchmark } from "./human-synthetic-watch.js";

type Confidence = "confident" | "weak" | "missing";

interface Scenario {
  readonly name: string;
  readonly args: Record<string, unknown>;
  readonly expectedTerms: readonly string[];
  readonly expectedConfidence: Confidence;
  readonly minimumEvidence: number;
}

interface ScenarioResult {
  readonly name: string;
  readonly latencyMs: number;
  readonly confidence: Confidence | null;
  readonly evidenceCount: number;
  readonly sourceLinkCount: number;
  readonly passed: boolean;
  readonly failures: readonly string[];
}

export interface TemporalDifferentialBenchmarkReport {
  readonly generatedAt: string;
  readonly namespaceId: string;
  readonly prerequisiteReportPath: string;
  readonly results: readonly ScenarioResult[];
  readonly passed: boolean;
}

function thisDir(): string {
  return path.dirname(fileURLToPath(import.meta.url));
}

function rootDir(): string {
  return path.resolve(thisDir(), "../..");
}

function outputDir(): string {
  return path.resolve(rootDir(), "benchmark-results");
}

function jsonString(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function hasTerm(value: unknown, term: string): boolean {
  return jsonString(value).toLowerCase().includes(term.toLowerCase());
}

function evidenceItems(payload: any): readonly any[] {
  return Array.isArray(payload?.evidence) ? payload.evidence : [];
}

function sourceLinkCount(items: readonly any[]): number {
  let count = 0;
  for (const item of items) {
    if (typeof item?.artifactId === "string" && item.artifactId) {
      count += 1;
      continue;
    }
    if (typeof item?.sourceUri === "string" && item.sourceUri) {
      count += 1;
    }
  }
  return count;
}

function scenarios(namespaceId: string): readonly Scenario[] {
  return [
    {
      name: "project_a_this_week_delta",
      args: {
        namespace_id: namespaceId,
        query: "What changed on Project A this week?",
        reference_now: "2026-03-23T12:00:00Z",
        limit: 8
      },
      expectedTerms: ["red", "green", "deadline", "vendor API"],
      expectedConfidence: "confident",
      minimumEvidence: 2
    },
    {
      name: "project_a_last_two_days_delta",
      args: {
        namespace_id: namespaceId,
        query: "What changed on Project A over the last two days?",
        reference_now: "2026-03-23T12:00:00Z",
        limit: 8
      },
      expectedTerms: ["green", "deadline", "vendor API"],
      expectedConfidence: "confident",
      minimumEvidence: 2
    },
    {
      name: "project_a_deadline_cause",
      args: {
        namespace_id: namespaceId,
        query: "Why did the Project A deadline move this week?",
        reference_now: "2026-03-23T12:00:00Z",
        limit: 8
      },
      expectedTerms: ["vendor API", "Wednesday"],
      expectedConfidence: "confident",
      minimumEvidence: 1
    }
  ];
}

async function runScenario(scenario: Scenario): Promise<ScenarioResult> {
  const started = performance.now();
  const wrapped = (await executeMcpTool("memory.recap", scenario.args)) as { readonly structuredContent?: unknown };
  const payload = wrapped?.structuredContent as any;
  const latencyMs = Number((performance.now() - started).toFixed(2));
  const failures: string[] = [];
  const evidence = evidenceItems(payload);
  const confidence = typeof payload?.confidence === "string" ? (payload.confidence as Confidence) : null;

  for (const term of scenario.expectedTerms) {
    if (!hasTerm(payload, term)) {
      failures.push(`missing term ${term}`);
    }
  }

  if (confidence !== scenario.expectedConfidence) {
    failures.push(`expected confidence ${scenario.expectedConfidence}, got ${confidence ?? "n/a"}`);
  }

  if (evidence.length < scenario.minimumEvidence) {
    failures.push(`expected at least ${scenario.minimumEvidence} evidence rows, got ${evidence.length}`);
  }

  if (sourceLinkCount(evidence) < scenario.minimumEvidence) {
    failures.push("expected source links for temporal-differential evidence");
  }

  return {
    name: scenario.name,
    latencyMs,
    confidence,
    evidenceCount: evidence.length,
    sourceLinkCount: sourceLinkCount(evidence),
    passed: failures.length === 0,
    failures
  };
}

function toMarkdown(report: TemporalDifferentialBenchmarkReport): string {
  const lines = [
    "# Temporal Differential Benchmark",
    "",
    `- generatedAt: ${report.generatedAt}`,
    `- namespaceId: ${report.namespaceId}`,
    `- prerequisiteReportPath: ${report.prerequisiteReportPath}`,
    `- passed: ${report.passed}`,
    "",
    "## Results",
    ""
  ];

  for (const result of report.results) {
    lines.push(
      `- ${result.name}: ${result.passed ? "pass" : "fail"} | confidence=${result.confidence ?? "n/a"} | evidence=${result.evidenceCount} | sourceLinks=${result.sourceLinkCount} | latencyMs=${result.latencyMs}`
    );
    for (const failure of result.failures) {
      lines.push(`  - ${failure}`);
    }
  }

  lines.push("");
  return `${lines.join("\n")}\n`;
}

export async function runAndWriteTemporalDifferentialBenchmark(): Promise<{
  readonly report: TemporalDifferentialBenchmarkReport;
  readonly output: {
    readonly jsonPath: string;
    readonly markdownPath: string;
  };
}> {
  const synthetic = await runAndWriteHumanSyntheticWatchBenchmark();
  const namespaceId = synthetic.report.namespaceId;
  const results: ScenarioResult[] = [];
  for (const scenario of scenarios(namespaceId)) {
    results.push(await runScenario(scenario));
  }

  const report: TemporalDifferentialBenchmarkReport = {
    generatedAt: new Date().toISOString(),
    namespaceId,
    prerequisiteReportPath: synthetic.output.jsonPath,
    results,
    passed: results.every((result) => result.passed)
  };

  const stamp = report.generatedAt.replace(/[:.]/g, "-");
  const outDir = outputDir();
  await mkdir(outDir, { recursive: true });
  const jsonPath = path.join(outDir, `temporal-differential-${stamp}.json`);
  const markdownPath = path.join(outDir, `temporal-differential-${stamp}.md`);
  await writeFile(jsonPath, JSON.stringify(report, null, 2), "utf8");
  await writeFile(markdownPath, toMarkdown(report), "utf8");
  return {
    report,
    output: {
      jsonPath,
      markdownPath
    }
  };
}

export async function runTemporalDifferentialBenchmarkCli(): Promise<void> {
  const { output, report } = await runAndWriteTemporalDifferentialBenchmark();
  process.stdout.write(`${JSON.stringify({ passed: report.passed, jsonPath: output.jsonPath, markdownPath: output.markdownPath }, null, 2)}\n`);
  await closePool();
}
