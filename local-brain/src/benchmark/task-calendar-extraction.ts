import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { closePool } from "../db/client.js";
import { executeMcpTool } from "../mcp/server.js";
import { runAndWriteHumanSyntheticWatchBenchmark } from "./human-synthetic-watch.js";

type ToolName = "memory.extract_tasks" | "memory.extract_calendar";

interface Scenario {
  readonly name: string;
  readonly tool: ToolName;
  readonly args: Record<string, unknown>;
  readonly expectedTerms: readonly string[];
  readonly minimumItems: number;
}

interface ScenarioResult {
  readonly name: string;
  readonly tool: ToolName;
  readonly latencyMs: number;
  readonly itemCount: number;
  readonly evidenceCount: number;
  readonly passed: boolean;
  readonly failures: readonly string[];
}

export interface TaskCalendarExtractionBenchmarkReport {
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

function itemCount(tool: ToolName, payload: any): number {
  return tool === "memory.extract_tasks"
    ? Array.isArray(payload?.tasks)
      ? payload.tasks.length
      : 0
    : Array.isArray(payload?.commitments)
      ? payload.commitments.length
      : 0;
}

function scenarios(namespaceId: string): readonly Scenario[] {
  return [
    {
      name: "project_a_tasks",
      tool: "memory.extract_tasks",
      args: {
        namespace_id: namespaceId,
        query: "Make a task list from what Steve mentioned yesterday about Project A.",
        reference_now: "2026-03-21T12:00:00Z",
        limit: 8
      },
      expectedTerms: ["Project A", "retrieval planner", "demo outline", "Mia"],
      minimumItems: 3
    },
    {
      name: "last_weekend_calendar",
      tool: "memory.extract_calendar",
      args: {
        namespace_id: namespaceId,
        query: "Pull calendar items from last weekend.",
        reference_now: "2026-03-23T12:00:00Z",
        limit: 8
      },
      expectedTerms: ["Punspace", "Khao House", "Monday morning"],
      minimumItems: 2
    }
  ];
}

async function runScenario(scenario: Scenario): Promise<ScenarioResult> {
  const started = performance.now();
  const wrapped = (await executeMcpTool(scenario.tool, scenario.args)) as { readonly structuredContent?: unknown };
  const payload = wrapped?.structuredContent as any;
  const latencyMs = Number((performance.now() - started).toFixed(2));
  const failures: string[] = [];

  for (const term of scenario.expectedTerms) {
    if (!hasTerm(payload, term)) {
      failures.push(`missing term ${term}`);
    }
  }

  const totalItems = itemCount(scenario.tool, payload);
  if (totalItems < scenario.minimumItems) {
    failures.push(`expected at least ${scenario.minimumItems} extracted items, got ${totalItems}`);
  }

  if (evidenceItems(payload).length === 0) {
    failures.push("expected grounded evidence for extracted output");
  }

  return {
    name: scenario.name,
    tool: scenario.tool,
    latencyMs,
    itemCount: totalItems,
    evidenceCount: evidenceItems(payload).length,
    passed: failures.length === 0,
    failures
  };
}

function toMarkdown(report: TaskCalendarExtractionBenchmarkReport): string {
  const lines = [
    "# Task Calendar Extraction Benchmark",
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
      `- ${result.name}: ${result.passed ? "pass" : "fail"} | tool=${result.tool} | items=${result.itemCount} | evidence=${result.evidenceCount} | latencyMs=${result.latencyMs}`
    );
    for (const failure of result.failures) {
      lines.push(`  - ${failure}`);
    }
  }

  lines.push("");
  return `${lines.join("\n")}\n`;
}

export async function runAndWriteTaskCalendarExtractionBenchmark(): Promise<{
  readonly report: TaskCalendarExtractionBenchmarkReport;
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

  const report: TaskCalendarExtractionBenchmarkReport = {
    generatedAt: new Date().toISOString(),
    namespaceId,
    prerequisiteReportPath: synthetic.output.jsonPath,
    results,
    passed: results.every((result) => result.passed)
  };

  const stamp = report.generatedAt.replace(/[:.]/g, "-");
  const outDir = outputDir();
  await mkdir(outDir, { recursive: true });
  const jsonPath = path.join(outDir, `task-calendar-extraction-${stamp}.json`);
  const markdownPath = path.join(outDir, `task-calendar-extraction-${stamp}.md`);
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

export async function runTaskCalendarExtractionBenchmarkCli(): Promise<void> {
  const { output, report } = await runAndWriteTaskCalendarExtractionBenchmark();
  process.stdout.write(`${JSON.stringify({ passed: report.passed, jsonPath: output.jsonPath, markdownPath: output.markdownPath }, null, 2)}\n`);
  await closePool();
}
