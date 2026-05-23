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
  readonly expectedLifecycleStatuses?: readonly string[];
  readonly forbiddenLifecycleStatuses?: readonly string[];
  readonly expectedStatusGuesses?: readonly string[];
  readonly forbiddenStatusGuesses?: readonly string[];
}

export interface TaskActivePruningScenarioResult {
  readonly id: string;
  readonly query: string;
  readonly evidenceCount: number;
  readonly titles: readonly string[];
  readonly statusGuesses: readonly string[];
  readonly lifecycleStatuses: readonly string[];
  readonly sourceTrailCount: number;
  readonly missingTerms: readonly string[];
  readonly forbiddenHits: readonly string[];
  readonly missingStatusGuesses: readonly string[];
  readonly missingLifecycleStatuses: readonly string[];
  readonly forbiddenStatusGuesses: readonly string[];
  readonly forbiddenLifecycleStatuses: readonly string[];
  readonly passed: boolean;
}

export interface TaskActivePruningPackReport {
  readonly generatedAt: string;
  readonly benchmark: "task_active_pruning_pack";
  readonly runtime: BenchmarkRuntimeMetadata;
  readonly sampleCount: number;
  readonly passed: boolean;
  readonly metrics: {
    readonly taskScopeLeakCount: number;
    readonly taskLifecyclePassRate: number;
    readonly staleOpenFalsePositiveCount: number;
    readonly completedTaskStillOpenCount: number;
    readonly supportedEmptySourceTrailCount: number;
  };
  readonly results: readonly TaskActivePruningScenarioResult[];
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
  return path.resolve(localBrainRoot(), "benchmark-generated", "task-active-pruning-pack");
}

function fixtures(): readonly FixtureFile[] {
  return [
    {
      relativePath: "2026-03-01-stale-open.md",
      sourceType: "markdown",
      capturedAt: "2026-03-01T09:00:00.000Z",
      body: [
        "# Old open work",
        "",
        "I need to tell Omi to find an alternative approach for the new web design.",
        "I need to track times for all upcoming video conference calls."
      ].join("\n")
    },
    {
      relativePath: "2026-04-21-overdue-open.md",
      sourceType: "markdown",
      capturedAt: "2026-04-21T09:00:00.000Z",
      body: [
        "# Travel logistics",
        "",
        "I need to attend the Istanbul conference by April 23.",
        "I need to fly back to Chiang Mai by April 26."
      ].join("\n")
    },
    {
      relativePath: "2026-05-16-current-open.md",
      sourceType: "markdown",
      capturedAt: "2026-05-16T11:00:00.000Z",
      body: [
        "# Current tasks",
        "",
        "I need to renew my driver's license.",
        "I need to get the RV running.",
        "I completed booking the Tahoe hotel."
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
      sourceChannel: "benchmark:task_active_pruning_pack",
      capturedAt: fixture.capturedAt,
      skipNarrativeClaims: true,
      metadata: {
        benchmark: "task_active_pruning_pack",
        fixture: fixture.relativePath
      }
    });
  }
}

function scenarios(): readonly Scenario[] {
  return [
    {
      id: "active_open_default",
      query: "What open tasks do I have?",
      expectedTerms: ["driver's license", "RV running"],
      forbiddenTerms: [
        "alternative approach for the new web design",
        "video conference calls",
        "Istanbul conference",
        "Fly back to Chiang Mai",
        "Tahoe hotel"
      ],
      expectedStatusGuesses: ["open"],
      expectedLifecycleStatuses: ["open"],
      forbiddenStatusGuesses: ["completed", "canceled", "superseded"],
      forbiddenLifecycleStatuses: ["stale_open", "recently_closed"]
    },
    {
      id: "all_open_override",
      query: "Show me all open tasks including older ones.",
      expectedTerms: ["driver's license", "Istanbul conference", "alternative approach for the new web design"],
      expectedStatusGuesses: ["open"],
      expectedLifecycleStatuses: ["open", "stale_open"],
      forbiddenStatusGuesses: ["completed", "canceled", "superseded"]
    },
    {
      id: "completed_not_open",
      query: "What tasks did I complete recently?",
      expectedTerms: ["Tahoe hotel"],
      forbiddenTerms: ["driver's license", "RV running", "Istanbul conference"],
      expectedStatusGuesses: ["completed"],
      expectedLifecycleStatuses: ["recently_closed"],
      forbiddenStatusGuesses: ["open", "blocked", "canceled"]
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

async function runScenario(namespaceId: string, scenario: Scenario): Promise<TaskActivePruningScenarioResult> {
  const wrapped = (await executeMcpTool("memory.extract_tasks", {
    namespace_id: namespaceId,
    query: scenario.query,
    detail_mode: "full",
    reference_now: "2026-05-22T00:00:00.000Z"
  })) as { readonly structuredContent?: unknown };
  const payload = wrapped.structuredContent as any;
  const tasks = Array.isArray(payload?.tasks) ? payload.tasks : [];
  const titles = Array.isArray(payload?.tasks)
    ? payload.tasks
        .map((task: any) => (typeof task?.title === "string" ? task.title.trim() : ""))
        .filter((value: string) => value.length > 0)
    : [];
  const statusGuesses = tasks.map((task: any) => (typeof task?.statusGuess === "string" ? task.statusGuess : "")).filter(Boolean);
  const lifecycleStatuses = tasks.map((task: any) => (typeof task?.lifecycleStatus === "string" ? task.lifecycleStatus : "")).filter(Boolean);
  const sourceTrailCount =
    (Array.isArray(payload?.sourceTrail) ? payload.sourceTrail.length : 0) +
    tasks.reduce((count: number, task: any) => count + (Array.isArray(task?.sourceTrail) ? task.sourceTrail.length : 0), 0);
  const joined = titles.join("; ");
  const missing = missingTerms(joined, scenario.expectedTerms);
  const forbidden = forbiddenHits(joined, scenario.forbiddenTerms ?? []);
  const missingStatusGuesses = (scenario.expectedStatusGuesses ?? []).filter((status) => !statusGuesses.includes(status));
  const missingLifecycleStatuses = (scenario.expectedLifecycleStatuses ?? []).filter((status) => !lifecycleStatuses.includes(status));
  const forbiddenStatusGuesses = (scenario.forbiddenStatusGuesses ?? []).filter((status) => statusGuesses.includes(status));
  const forbiddenLifecycleStatuses = (scenario.forbiddenLifecycleStatuses ?? []).filter((status) => lifecycleStatuses.includes(status));
  return {
    id: scenario.id,
    query: scenario.query,
    evidenceCount: Array.isArray(payload?.evidence) ? payload.evidence.length : 0,
    titles,
    statusGuesses,
    lifecycleStatuses,
    sourceTrailCount,
    missingTerms: missing,
    forbiddenHits: forbidden,
    missingStatusGuesses,
    missingLifecycleStatuses,
    forbiddenStatusGuesses,
    forbiddenLifecycleStatuses,
    passed:
      missing.length === 0 &&
      forbidden.length === 0 &&
      missingStatusGuesses.length === 0 &&
      missingLifecycleStatuses.length === 0 &&
      forbiddenStatusGuesses.length === 0 &&
      forbiddenLifecycleStatuses.length === 0 &&
      titles.length > 0 &&
      sourceTrailCount > 0
  };
}

function buildMetrics(results: readonly TaskActivePruningScenarioResult[]): TaskActivePruningPackReport["metrics"] {
  const openRows = results.filter((row) => /\bopen\b/iu.test(row.query));
  return {
    taskScopeLeakCount: results.reduce((count, row) => count + row.forbiddenHits.length, 0),
    taskLifecyclePassRate: results.length === 0 ? 0 : results.filter((row) => row.passed).length / results.length,
    staleOpenFalsePositiveCount: openRows
      .filter((row) => !/\b(?:all|older)\b/iu.test(row.query))
      .reduce((count, row) => count + row.lifecycleStatuses.filter((status) => status === "stale_open").length, 0),
    completedTaskStillOpenCount: openRows.reduce(
      (count, row) => count + row.statusGuesses.filter((status) => ["completed", "canceled", "superseded"].includes(status)).length,
      0
    ),
    supportedEmptySourceTrailCount: results.filter((row) => row.evidenceCount > 0 && row.sourceTrailCount === 0).length
  };
}

function toMarkdown(report: TaskActivePruningPackReport): string {
  const lines = [
    "# Task Active Pruning Pack",
    "",
    `- generatedAt: ${report.generatedAt}`,
    `- sampleCount: ${report.sampleCount}`,
    `- passed: ${report.passed}`,
    "",
    "## Results",
    ""
  ];
  for (const row of report.results) {
    lines.push(
      `- ${row.id}: passed=${row.passed} evidence=${row.evidenceCount} sourceTrail=${row.sourceTrailCount} statuses=${row.statusGuesses.join(",")} lifecycle=${row.lifecycleStatuses.join(",")} titles=${row.titles.join(" | ")}`
    );
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

export async function runAndWriteTaskActivePruningPack(): Promise<{
  readonly report: TaskActivePruningPackReport;
  readonly output: { readonly jsonPath: string; readonly markdownPath: string };
}> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const namespaceId = `benchmark_task_active_pruning_pack_${stamp}`;
  const { rootPath, files } = await writeFixtures(namespaceId);
  await ingestFixtures(namespaceId, rootPath, files);
  await rebuildTypedMemoryNamespace(namespaceId, { skipVectorActivation: true });
  const results: TaskActivePruningScenarioResult[] = [];
  for (const scenario of scenarios()) {
    results.push(await runScenario(namespaceId, scenario));
  }
  const metrics = buildMetrics(results);
  const report: TaskActivePruningPackReport = {
    generatedAt: new Date().toISOString(),
    benchmark: "task_active_pruning_pack",
    runtime: buildBenchmarkRuntimeMetadata({
      benchmarkMode: "sampled",
      sampleControls: {
        scenarioCount: results.length,
        namespaceId
      }
    }),
    sampleCount: results.length,
    passed:
      results.every((row) => row.passed) &&
      metrics.taskScopeLeakCount === 0 &&
      metrics.taskLifecyclePassRate === 1 &&
      metrics.staleOpenFalsePositiveCount === 0 &&
      metrics.completedTaskStillOpenCount === 0 &&
      metrics.supportedEmptySourceTrailCount === 0,
    metrics,
    results
  };
  await mkdir(outputDir(), { recursive: true });
  const jsonPath = path.join(outputDir(), `task-active-pruning-pack-${stamp}.json`);
  const markdownPath = path.join(outputDir(), `task-active-pruning-pack-${stamp}.md`);
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, toMarkdown(report), "utf8");
  return { report, output: { jsonPath, markdownPath } };
}

export async function runTaskActivePruningPackCli(): Promise<void> {
  try {
    const { output } = await runAndWriteTaskActivePruningPack();
    process.stdout.write(`${output.jsonPath}\n${output.markdownPath}\n`);
  } finally {
    await closePool().catch(() => undefined);
  }
}
