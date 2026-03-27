import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { closePool } from "../db/client.js";
import { executeMcpTool } from "../mcp/server.js";
import { readConfig } from "../config.js";
import { runAndWriteHumanSyntheticWatchBenchmark } from "./human-synthetic-watch.js";

type ProviderMode = "none" | "local" | "openrouter";

interface ProviderScenarioResult {
  readonly provider: ProviderMode;
  readonly attempted: boolean;
  readonly passed: boolean;
  readonly skippedReason?: string;
  readonly evidenceCount: number;
  readonly sourceLinkCount: number;
  readonly summaryTextPresent: boolean;
  readonly failures: readonly string[];
}

export interface RecapProviderParityBenchmarkReport {
  readonly generatedAt: string;
  readonly namespaceId: string;
  readonly prerequisiteReportPath: string;
  readonly results: readonly ProviderScenarioResult[];
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

function toMarkdown(report: RecapProviderParityBenchmarkReport): string {
  const lines = [
    "# Recap Provider Parity Benchmark",
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
      `- ${result.provider}: ${result.passed ? "pass" : "fail"} | attempted=${result.attempted} | evidence=${result.evidenceCount} | sourceLinks=${result.sourceLinkCount} | summaryTextPresent=${result.summaryTextPresent}${result.skippedReason ? ` | skippedReason=${result.skippedReason}` : ""}`
    );
    for (const failure of result.failures) {
      lines.push(`  - ${failure}`);
    }
  }

  lines.push("");
  return `${lines.join("\n")}\n`;
}

export async function runAndWriteRecapProviderParityBenchmark(): Promise<{
  readonly report: RecapProviderParityBenchmarkReport;
  readonly output: {
    readonly jsonPath: string;
    readonly markdownPath: string;
  };
}> {
  const synthetic = await runAndWriteHumanSyntheticWatchBenchmark();
  const namespaceId = synthetic.report.namespaceId;
  const config = readConfig();
  const providers: readonly ProviderMode[] = ["none", "local", "openrouter"];
  const results: ProviderScenarioResult[] = [];

  for (const provider of providers) {
    if (provider === "openrouter" && !config.openRouterApiKey) {
      results.push({
        provider,
        attempted: false,
        passed: true,
        skippedReason: "OPENROUTER_API_KEY is not configured",
        evidenceCount: 0,
        sourceLinkCount: 0,
        summaryTextPresent: false,
        failures: []
      });
      continue;
    }

    const wrapped = (await executeMcpTool("memory.recap", {
      namespace_id: namespaceId,
      query: "Give me an overview of what Steve and Dan said about Project A yesterday.",
      reference_now: "2026-03-21T12:00:00Z",
      provider,
      limit: 8
    })) as { readonly structuredContent?: unknown };
    const payload = wrapped?.structuredContent as any;
    const evidence = evidenceItems(payload);
    const failures: string[] = [];

    if (evidence.length === 0) {
      failures.push("expected evidence pack for provider parity query");
    }
    if (sourceLinkCount(evidence) === 0) {
      failures.push("expected source links for provider parity query");
    }
    if (provider !== "none" && !(typeof payload?.summaryText === "string" && payload.summaryText.trim().length > 0)) {
      failures.push("expected derived summary_text for configured provider");
    }

    results.push({
      provider,
      attempted: true,
      passed: failures.length === 0,
      evidenceCount: evidence.length,
      sourceLinkCount: sourceLinkCount(evidence),
      summaryTextPresent: typeof payload?.summaryText === "string" && payload.summaryText.trim().length > 0,
      failures
    });
  }

  const report: RecapProviderParityBenchmarkReport = {
    generatedAt: new Date().toISOString(),
    namespaceId,
    prerequisiteReportPath: synthetic.output.jsonPath,
    results,
    passed: results.every((result) => result.passed)
  };

  const stamp = report.generatedAt.replace(/[:.]/g, "-");
  const outDir = outputDir();
  await mkdir(outDir, { recursive: true });
  const jsonPath = path.join(outDir, `recap-provider-parity-${stamp}.json`);
  const markdownPath = path.join(outDir, `recap-provider-parity-${stamp}.md`);
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

export async function runRecapProviderParityBenchmarkCli(): Promise<void> {
  const { output, report } = await runAndWriteRecapProviderParityBenchmark();
  process.stdout.write(`${JSON.stringify({ passed: report.passed, jsonPath: output.jsonPath, markdownPath: output.markdownPath }, null, 2)}\n`);
  await closePool();
}
