import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { closePool } from "../db/client.js";
import { executeMcpTool } from "../mcp/server.js";
import { runAndWriteHumanSyntheticWatchBenchmark } from "./human-synthetic-watch.js";

export interface SessionStartMemoryBenchmarkReport {
  readonly generatedAt: string;
  readonly namespaceId: string;
  readonly prerequisiteReportPath: string;
  readonly recap: {
    readonly passed: boolean;
    readonly summaryTextPresent: boolean;
    readonly evidenceCount: number;
    readonly sourceLinkCount: number;
  };
  readonly tasks: {
    readonly passed: boolean;
    readonly itemCount: number;
  };
  readonly calendar: {
    readonly passed: boolean;
    readonly itemCount: number;
  };
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

function toMarkdown(report: SessionStartMemoryBenchmarkReport): string {
  const lines = [
    "# Session Start Memory Benchmark",
    "",
    `- generatedAt: ${report.generatedAt}`,
    `- namespaceId: ${report.namespaceId}`,
    `- prerequisiteReportPath: ${report.prerequisiteReportPath}`,
    `- passed: ${report.passed}`,
    "",
    "## Session Start",
    "",
    `- recap: ${report.recap.passed ? "pass" : "fail"} | summaryTextPresent=${report.recap.summaryTextPresent} | evidence=${report.recap.evidenceCount} | sourceLinks=${report.recap.sourceLinkCount}`,
    `- tasks: ${report.tasks.passed ? "pass" : "fail"} | items=${report.tasks.itemCount}`,
    `- calendar: ${report.calendar.passed ? "pass" : "fail"} | items=${report.calendar.itemCount}`,
    ""
  ];
  return `${lines.join("\n")}\n`;
}

export async function runAndWriteSessionStartMemoryBenchmark(): Promise<{
  readonly report: SessionStartMemoryBenchmarkReport;
  readonly output: {
    readonly jsonPath: string;
    readonly markdownPath: string;
  };
}> {
  const synthetic = await runAndWriteHumanSyntheticWatchBenchmark();
  const namespaceId = synthetic.report.namespaceId;

  const recapWrapped = (await executeMcpTool("memory.recap", {
    namespace_id: namespaceId,
    query: "Give me a recap of what Steve did last weekend with Jules and Rina.",
    reference_now: "2026-03-23T12:00:00Z",
    limit: 8
  })) as { readonly structuredContent?: unknown };
  const recap = recapWrapped.structuredContent as any;

  const taskWrapped = (await executeMcpTool("memory.extract_tasks", {
    namespace_id: namespaceId,
    query: "Make a task list from what Steve mentioned yesterday about Project A.",
    reference_now: "2026-03-21T12:00:00Z",
    limit: 8
  })) as { readonly structuredContent?: unknown };
  const tasks = taskWrapped.structuredContent as any;

  const calendarWrapped = (await executeMcpTool("memory.extract_calendar", {
    namespace_id: namespaceId,
    query: "Pull calendar items from last weekend.",
    reference_now: "2026-03-23T12:00:00Z",
    limit: 8
  })) as { readonly structuredContent?: unknown };
  const calendar = calendarWrapped.structuredContent as any;

  const recapPassed =
    typeof recap?.confidence === "string" &&
    recap.confidence === "confident" &&
    evidenceItems(recap).length >= 2 &&
    sourceLinkCount(evidenceItems(recap)) >= 2;
  const tasksPassed = Array.isArray(tasks?.tasks) && tasks.tasks.length >= 3;
  const calendarPassed = Array.isArray(calendar?.commitments) && calendar.commitments.length >= 2;

  const report: SessionStartMemoryBenchmarkReport = {
    generatedAt: new Date().toISOString(),
    namespaceId,
    prerequisiteReportPath: synthetic.output.jsonPath,
    recap: {
      passed: recapPassed,
      summaryTextPresent: typeof recap?.summaryText === "string" && recap.summaryText.trim().length > 0,
      evidenceCount: evidenceItems(recap).length,
      sourceLinkCount: sourceLinkCount(evidenceItems(recap))
    },
    tasks: {
      passed: tasksPassed,
      itemCount: Array.isArray(tasks?.tasks) ? tasks.tasks.length : 0
    },
    calendar: {
      passed: calendarPassed,
      itemCount: Array.isArray(calendar?.commitments) ? calendar.commitments.length : 0
    },
    passed: recapPassed && tasksPassed && calendarPassed
  };

  const stamp = report.generatedAt.replace(/[:.]/g, "-");
  const outDir = outputDir();
  await mkdir(outDir, { recursive: true });
  const jsonPath = path.join(outDir, `session-start-memory-${stamp}.json`);
  const markdownPath = path.join(outDir, `session-start-memory-${stamp}.md`);
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

export async function runSessionStartMemoryBenchmarkCli(): Promise<void> {
  const { output, report } = await runAndWriteSessionStartMemoryBenchmark();
  process.stdout.write(`${JSON.stringify({ passed: report.passed, jsonPath: output.jsonPath, markdownPath: output.markdownPath }, null, 2)}\n`);
  await closePool();
}
