import { spawn } from "node:child_process";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

interface DataQualityUpliftStep {
  readonly id: string;
  readonly phase: string;
  readonly scriptName: string;
  readonly reason: string;
  readonly env?: Readonly<Record<string, string>>;
}

interface PlannedStep {
  readonly id: string;
  readonly phase: string;
  readonly plannedScriptName: string;
  readonly reason: string;
}

interface DataQualityUpliftStepResult extends DataQualityUpliftStep {
  readonly command: readonly string[];
  readonly passed: boolean;
  readonly exitCode: number | null;
  readonly durationMs: number;
  readonly artifactPaths: readonly string[];
  readonly stdoutTail: string;
  readonly stderrTail: string;
}

export interface DataQualityUpliftPackReport {
  readonly generatedAt: string;
  readonly benchmark: "data_quality_uplift_pack";
  readonly artifactSchemaVersion: "data_quality_uplift_pack_v1";
  readonly passed: boolean;
  readonly metrics: {
    readonly totalExecutableSteps: number;
    readonly passedExecutableSteps: number;
    readonly failedExecutableSteps: number;
    readonly plannedMissingBenchmarkCount: number;
    readonly totalDurationMs: number;
    readonly p95StepDurationMs: number;
    readonly maxStepDurationMs: number;
  };
  readonly steps: readonly DataQualityUpliftStepResult[];
  readonly plannedSteps: readonly PlannedStep[];
}

const EXECUTABLE_STEPS: readonly DataQualityUpliftStep[] = [
  {
    id: "ingestion_quality_ledger",
    phase: "phase_1_ingestion_quality_ledger_v2",
    scriptName: "benchmark:ingestion-quality-ledger-pack",
    reason: "Verifies source-quality residual ownership, parser/chunker status, projection counts, embedding status, and source-trail coverage."
  },
  {
    id: "universal_task_event_projection",
    phase: "phase_2_cross_source_task_calendar_v2",
    scriptName: "benchmark:universal-task-event-projection-pack",
    reason: "Verifies the shared source-agnostic task/event projection across source kinds."
  },
  {
    id: "task_event_linking",
    phase: "phase_2_cross_source_task_calendar_v2",
    scriptName: "benchmark:task-event-linking-pack",
    reason: "Verifies task/event linking, source-scope discipline, and no category-label task false positives."
  },
  {
    id: "document_parser_chunking_quality",
    phase: "phase_2_cross_source_task_calendar_v2",
    scriptName: "benchmark:document-parser-chunking-quality-pack",
    reason: "Verifies parser/chunking quality and parent-child source context for document/PDF-style sources."
  },
  {
    id: "entity_disambiguation_inbox",
    phase: "phase_3_entity_project_place_disambiguation_inbox_v2",
    scriptName: "benchmark:entity-disambiguation-inbox-pack",
    reason: "Verifies alias merge candidates, keep-separate decisions, role conflicts, project aliases, place aliases, spelling corrections, replay artifacts, and no silent merges."
  },
  {
    id: "memory_query_plan",
    phase: "phase_4_query_planner_hybrid_retrieval_v2",
    scriptName: "benchmark:memory-query-plan-pack",
    reason: "Verifies deterministic intent, corpus, subject/place/project/time/source-scope planning."
  },
  {
    id: "hybrid_temporal_retrieval",
    phase: "phase_4_query_planner_hybrid_retrieval_v2",
    scriptName: "benchmark:hybrid-temporal-retrieval-pack",
    reason: "Verifies metadata-first filtering and hybrid recall/rerank behavior without vector-authoritative final truth."
  },
  {
    id: "source_audit_cross_family",
    phase: "phase_5_presenter_quality_v2",
    scriptName: "benchmark:source-audit-cross-family-pack",
    reason: "Verifies source-trail and claim-audit coverage across answer families before presenter-quality work claims success."
  },
  {
    id: "natural_language_presenter_quality",
    phase: "phase_5_presenter_quality_v2",
    scriptName: "benchmark:natural-language-presenter-quality-pack",
    reason: "Verifies compact/full natural-language answer quality across MCP human rows, Codex memory rows, and source-audit presenter rows."
  },
  {
    id: "cross_source_project_memory",
    phase: "phase_6_large_scale_audit_self_healing_v2",
    scriptName: "benchmark:cross-source-project-memory-pack",
    reason: "Verifies project memory across Codex, source-topic reports, PDFs, markdown notes, task exports, and calendar exports."
  },
  {
    id: "mcp_human_query_audit_100",
    phase: "phase_6_large_scale_audit_self_healing_v2",
    scriptName: "benchmark:mcp-human-query-audit-100",
    reason: "Runs a broad human-style MCP audit to catch answer-shape and residual-owner drift."
  }
];

const PLANNED_STEPS: readonly PlannedStep[] = [];

function thisDir(): string {
  return path.dirname(fileURLToPath(import.meta.url));
}

function localBrainRoot(): string {
  return path.resolve(thisDir(), "../..");
}

function repoRoot(): string {
  return path.resolve(localBrainRoot(), "..");
}

function outputDir(): string {
  return path.resolve(localBrainRoot(), "benchmark-results");
}

function tail(value: string, maxLength = 4_000): string {
  return value.length <= maxLength ? value : value.slice(value.length - maxLength);
}

function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Number((sorted[index] ?? 0).toFixed(2));
}

function artifactPaths(stdout: string, stderr: string): readonly string[] {
  const combined = `${stdout}\n${stderr}`;
  const matches = combined.match(/(?:\/[^\s'"]+)?benchmark-results\/[^\s'"]+\.json/gu) ?? [];
  return [...new Set(matches.map((entry) => (entry.startsWith("/") ? entry : path.resolve(repoRoot(), entry))))];
}

async function artifactSnapshot(): Promise<ReadonlySet<string>> {
  try {
    const entries = await readdir(outputDir());
    return new Set(entries.filter((entry) => entry.endsWith(".json")));
  } catch {
    return new Set();
  }
}

async function newlyWrittenArtifacts(before: ReadonlySet<string>): Promise<readonly string[]> {
  const entries = await artifactSnapshot();
  return [...entries]
    .filter((entry) => !before.has(entry))
    .map((entry) => path.join(outputDir(), entry))
    .sort();
}

async function runStep(step: DataQualityUpliftStep): Promise<DataQualityUpliftStepResult> {
  const startedAt = performance.now();
  const beforeArtifacts = await artifactSnapshot();
  const command = ["npm", "run", step.scriptName, "--workspace", "local-brain"] as const;
  const child = spawn(command[0], command.slice(1), {
    cwd: repoRoot(),
    env: {
      ...process.env,
      ...(step.env ?? {})
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
    process.stdout.write(chunk);
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
    process.stderr.write(chunk);
  });
  const exitCode = await new Promise<number | null>((resolve) => {
    child.on("error", () => resolve(null));
    child.on("close", (code) => resolve(code));
  });
  const durationMs = Number((performance.now() - startedAt).toFixed(2));
  const artifacts = new Set([...artifactPaths(stdout, stderr), ...(await newlyWrittenArtifacts(beforeArtifacts))]);
  return {
    ...step,
    command,
    passed: exitCode === 0,
    exitCode,
    durationMs,
    artifactPaths: [...artifacts],
    stdoutTail: tail(stdout),
    stderrTail: tail(stderr)
  };
}

function summarize(results: readonly DataQualityUpliftStepResult[]): DataQualityUpliftPackReport["metrics"] {
  const durations = results.map((result) => result.durationMs);
  const passedExecutableSteps = results.filter((result) => result.passed).length;
  return {
    totalExecutableSteps: EXECUTABLE_STEPS.length,
    passedExecutableSteps,
    failedExecutableSteps: results.length - passedExecutableSteps,
    plannedMissingBenchmarkCount: PLANNED_STEPS.length,
    totalDurationMs: Number(results.reduce((sum, result) => sum + result.durationMs, 0).toFixed(2)),
    p95StepDurationMs: percentile(durations, 95),
    maxStepDurationMs: Number(Math.max(0, ...durations).toFixed(2))
  };
}

function toMarkdown(report: DataQualityUpliftPackReport): string {
  const lines = [
    "# Data Quality Uplift Pack",
    "",
    `- generatedAt: ${report.generatedAt}`,
    `- passed: ${report.passed}`,
    `- totalExecutableSteps: ${report.metrics.totalExecutableSteps}`,
    `- passedExecutableSteps: ${report.metrics.passedExecutableSteps}`,
    `- failedExecutableSteps: ${report.metrics.failedExecutableSteps}`,
    `- plannedMissingBenchmarkCount: ${report.metrics.plannedMissingBenchmarkCount}`,
    `- totalDurationMs: ${report.metrics.totalDurationMs}`,
    `- p95StepDurationMs: ${report.metrics.p95StepDurationMs}`,
    `- maxStepDurationMs: ${report.metrics.maxStepDurationMs}`,
    "",
    "## Executable Steps"
  ];
  for (const step of report.steps) {
    lines.push(
      "",
      `### ${step.id}`,
      "",
      `- phase: ${step.phase}`,
      `- scriptName: ${step.scriptName}`,
      `- passed: ${step.passed}`,
      `- exitCode: ${step.exitCode ?? "null"}`,
      `- durationMs: ${step.durationMs}`,
      `- reason: ${step.reason}`,
      `- artifacts: ${step.artifactPaths.length === 0 ? "none detected" : step.artifactPaths.join(", ")}`
    );
  }
  lines.push("", "## Planned Missing Benchmarks");
  for (const step of report.plannedSteps) {
    lines.push(
      "",
      `### ${step.id}`,
      "",
      `- phase: ${step.phase}`,
      `- plannedScriptName: ${step.plannedScriptName}`,
      `- reason: ${step.reason}`
    );
  }
  return `${lines.join("\n")}\n`;
}

export async function runDataQualityUpliftPack(): Promise<DataQualityUpliftPackReport> {
  const results: DataQualityUpliftStepResult[] = [];
  for (const step of EXECUTABLE_STEPS) {
    console.log(`\n[data-quality-uplift-pack] running ${step.scriptName}`);
    const result = await runStep(step);
    results.push(result);
    if (!result.passed) break;
  }
  const report: DataQualityUpliftPackReport = {
    generatedAt: new Date().toISOString(),
    benchmark: "data_quality_uplift_pack",
    artifactSchemaVersion: "data_quality_uplift_pack_v1",
    passed: results.length === EXECUTABLE_STEPS.length && results.every((result) => result.passed),
    metrics: summarize(results),
    steps: results,
    plannedSteps: PLANNED_STEPS
  };
  await mkdir(outputDir(), { recursive: true });
  const stamp = report.generatedAt.replace(/[:.]/gu, "-");
  const jsonPath = path.join(outputDir(), `data-quality-uplift-pack-${stamp}.json`);
  const mdPath = path.join(outputDir(), `data-quality-uplift-pack-${stamp}.md`);
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(mdPath, toMarkdown(report), "utf8");
  console.log(JSON.stringify({ passed: report.passed, metrics: report.metrics, artifactPath: jsonPath }, null, 2));
  return report;
}

export async function runDataQualityUpliftPackCli(): Promise<void> {
  const report = await runDataQualityUpliftPack();
  if (!report.passed) process.exitCode = 1;
}
