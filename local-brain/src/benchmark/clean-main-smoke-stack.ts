import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

interface SmokeStackStep {
  readonly id: string;
  readonly scriptName: string;
  readonly reason: string;
  readonly env?: Readonly<Record<string, string>>;
}

interface SmokeStackStepResult {
  readonly id: string;
  readonly scriptName: string;
  readonly reason: string;
  readonly command: readonly string[];
  readonly passed: boolean;
  readonly exitCode: number | null;
  readonly durationMs: number;
  readonly artifactPaths: readonly string[];
  readonly stdoutTail: string;
  readonly stderrTail: string;
}

export interface CleanMainSmokeStackReport {
  readonly generatedAt: string;
  readonly benchmark: "clean_main_smoke_stack";
  readonly artifactSchemaVersion: "clean_main_smoke_stack_v1";
  readonly passed: boolean;
  readonly metrics: {
    readonly totalSteps: number;
    readonly passedSteps: number;
    readonly failedSteps: number;
    readonly totalDurationMs: number;
    readonly p95StepDurationMs: number;
    readonly maxStepDurationMs: number;
  };
  readonly steps: readonly SmokeStackStepResult[];
}

const STACK_STEPS: readonly SmokeStackStep[] = [
  {
    id: "benchmark_reliability_audit",
    scriptName: "benchmark:benchmark-reliability-audit",
    reason: "Proves benchmark scripts are registered or explicitly legacy-covered before trusting the stack."
  },
  {
    id: "mcp_query_taxonomy_gold",
    scriptName: "benchmark:mcp-query-taxonomy-gold",
    reason: "Primary MCP contract, routing, answer-shape, evidence, and query-time-model-call gate.",
    env: {
      PGOPTIONS: "-c timescaledb.max_tuples_decompressed_per_dml_transaction=0"
    }
  },
  {
    id: "source_audit_cross_family_pack",
    scriptName: "benchmark:source-audit-cross-family-pack",
    reason: "Fixture-level source-audit envelope and presenter coverage across answer families."
  },
  {
    id: "temporal_memory_query_audit",
    scriptName: "benchmark:temporal-memory-query-audit",
    reason: "Temporal source scope, event-window scope, fuzzy time, and lifecycle scope gate."
  },
  {
    id: "task_active_pruning_pack",
    scriptName: "benchmark:task-active-pruning-pack",
    reason: "Task lifecycle pruning and stale-open task leakage gate."
  },
  {
    id: "omi_task_calendar_window",
    scriptName: "benchmark:omi-task-calendar-window",
    reason: "OMI task/calendar latest-window behavior and recap diagnostic gate."
  },
  {
    id: "relationship_friend_set_pack",
    scriptName: "benchmark:relationship-friend-set-pack",
    reason: "Relationship friend-set, place filter, and subject-binding gate."
  },
  {
    id: "mcp_correction_propagation_pack",
    scriptName: "benchmark:mcp-correction-propagation-pack",
    reason: "MCP correction inbox, no-silent-merge, audit trail, and projection propagation gate."
  },
  {
    id: "personal_omi_hard_query_audit_30",
    scriptName: "benchmark:personal-omi-hard-query-audit-30",
    reason: "Sequential personal OMI operator smoke with hard human-style questions."
  },
  {
    id: "mcp_human_query_audit_100",
    scriptName: "benchmark:mcp-human-query-audit-100",
    reason: "Broad real MCP 100-query audit over people, places, tasks, docs, PDFs, specs, and timelines."
  }
];

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
  const unique = new Set(matches.map((entry) => (entry.startsWith("/") ? entry : path.resolve(repoRoot(), entry))));
  return [...unique];
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

async function runStep(step: SmokeStackStep): Promise<SmokeStackStepResult> {
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
    id: step.id,
    scriptName: step.scriptName,
    reason: step.reason,
    command,
    passed: exitCode === 0,
    exitCode,
    durationMs,
    artifactPaths: [...artifacts],
    stdoutTail: tail(stdout),
    stderrTail: tail(stderr)
  };
}

function summarize(results: readonly SmokeStackStepResult[]): CleanMainSmokeStackReport["metrics"] {
  const durations = results.map((result) => result.durationMs);
  const passedSteps = results.filter((result) => result.passed).length;
  return {
    totalSteps: results.length,
    passedSteps,
    failedSteps: results.length - passedSteps,
    totalDurationMs: Number(results.reduce((sum, result) => sum + result.durationMs, 0).toFixed(2)),
    p95StepDurationMs: percentile(durations, 95),
    maxStepDurationMs: Number(Math.max(0, ...durations).toFixed(2))
  };
}

function toMarkdown(report: CleanMainSmokeStackReport): string {
  const lines = [
    "# Clean Main Smoke Stack",
    "",
    `- generatedAt: ${report.generatedAt}`,
    `- passed: ${report.passed}`,
    `- totalSteps: ${report.metrics.totalSteps}`,
    `- passedSteps: ${report.metrics.passedSteps}`,
    `- failedSteps: ${report.metrics.failedSteps}`,
    `- totalDurationMs: ${report.metrics.totalDurationMs}`,
    `- p95StepDurationMs: ${report.metrics.p95StepDurationMs}`,
    `- maxStepDurationMs: ${report.metrics.maxStepDurationMs}`,
    "",
    "## Steps"
  ];
  for (const step of report.steps) {
    lines.push(
      "",
      `### ${step.id}`,
      "",
      `- scriptName: ${step.scriptName}`,
      `- passed: ${step.passed}`,
      `- exitCode: ${step.exitCode ?? "null"}`,
      `- durationMs: ${step.durationMs}`,
      `- reason: ${step.reason}`,
      `- artifacts: ${step.artifactPaths.length === 0 ? "none detected" : step.artifactPaths.join(", ")}`
    );
  }
  return `${lines.join("\n")}\n`;
}

export async function runCleanMainSmokeStack(): Promise<CleanMainSmokeStackReport> {
  const results: SmokeStackStepResult[] = [];
  for (const step of STACK_STEPS) {
    console.log(`\n[clean-main-smoke-stack] running ${step.scriptName}`);
    const result = await runStep(step);
    results.push(result);
    if (!result.passed) break;
  }
  const report: CleanMainSmokeStackReport = {
    generatedAt: new Date().toISOString(),
    benchmark: "clean_main_smoke_stack",
    artifactSchemaVersion: "clean_main_smoke_stack_v1",
    passed: results.length === STACK_STEPS.length && results.every((result) => result.passed),
    metrics: summarize(results),
    steps: results
  };
  const dir = outputDir();
  await mkdir(dir, { recursive: true });
  const stamp = report.generatedAt.replace(/[:.]/gu, "-");
  const jsonPath = path.join(dir, `clean-main-smoke-stack-${stamp}.json`);
  const mdPath = path.join(dir, `clean-main-smoke-stack-${stamp}.md`);
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(mdPath, toMarkdown(report));
  console.log(JSON.stringify({ passed: report.passed, metrics: report.metrics, artifactPath: jsonPath }, null, 2));
  return report;
}

export async function runCleanMainSmokeStackCli(): Promise<void> {
  const report = await runCleanMainSmokeStack();
  if (!report.passed) process.exitCode = 1;
}
