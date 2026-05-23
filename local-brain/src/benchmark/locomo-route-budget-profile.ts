import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  countBy,
  hasMissingSlowTelemetry,
  isTimeoutLike,
  locomoOutputDir,
  locomoRouteFamily,
  parseArtifactArg,
  percentile,
  readLoCoMoArtifact,
  resultLatencyMs
} from "./locomo-diagnostics-utils.js";

interface RouteBudget {
  readonly p95TargetMs: number;
  readonly hardMaxMs: number;
}

interface RouteBudgetRow {
  readonly routeFamily: string;
  readonly count: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly maxMs: number;
  readonly overP95TargetCount: number;
  readonly overHardMaxCount: number;
  readonly timeoutLikeCount: number;
  readonly missingTelemetryOver10sCount: number;
  readonly passed: boolean;
}

interface SlowRouteScenario {
  readonly sampleId: string;
  readonly questionIndex: number;
  readonly question: string;
  readonly routeFamily: string;
  readonly latencyMs: number;
  readonly dominantStage: string | null;
  readonly topStageMs: number | null;
  readonly routeBudgetEnforced: boolean;
  readonly routeBudgetDecision: string | null;
  readonly residualOwner: string | null;
  readonly queryBehavior: string | null;
  readonly finalClaimSource: string | null;
}

interface LoCoMoRouteBudgetProfile {
  readonly generatedAt: string;
  readonly benchmark: "locomo_route_budget_profile";
  readonly sourceArtifactPath: string;
  readonly sourceStatus: string;
  readonly passed: boolean;
  readonly defaultBudget: RouteBudget;
  readonly routeBudgets: Readonly<Record<string, RouteBudget>>;
  readonly rows: readonly RouteBudgetRow[];
  readonly slowScenarios: readonly SlowRouteScenario[];
  readonly dominantStageBreakdownForSlowRows: Readonly<Record<string, number>>;
  readonly failures: readonly string[];
}

const DEFAULT_BUDGET: RouteBudget = {
  p95TargetMs: 10_000,
  hardMaxMs: 30_000
};

const ROUTE_BUDGETS: Readonly<Record<string, RouteBudget>> = {
  direct_fact: DEFAULT_BUDGET,
  profile_inference: DEFAULT_BUDGET,
  temporal_detail: DEFAULT_BUDGET,
  report_semantics: DEFAULT_BUDGET,
  commonality: DEFAULT_BUDGET,
  list_set: DEFAULT_BUDGET,
  causal: DEFAULT_BUDGET,
  relationship: DEFAULT_BUDGET
};

function budgetFor(family: string): RouteBudget {
  return ROUTE_BUDGETS[family] ?? DEFAULT_BUDGET;
}

function toMarkdown(report: LoCoMoRouteBudgetProfile): string {
  const lines = [
    "# LoCoMo Route Budget Profile",
    "",
    `- generatedAt: ${report.generatedAt}`,
    `- sourceArtifactPath: ${report.sourceArtifactPath}`,
    `- sourceStatus: ${report.sourceStatus}`,
    `- passed: ${report.passed}`,
    `- failures: ${JSON.stringify(report.failures)}`,
    "",
    "## Route Rows",
    "",
    ...report.rows.map(
      (row) =>
        `- ${row.routeFamily}: count=${row.count} p50=${row.p50Ms} p95=${row.p95Ms} max=${row.maxMs} overTarget=${row.overP95TargetCount} overHard=${row.overHardMaxCount} timeouts=${row.timeoutLikeCount} missingTelemetry=${row.missingTelemetryOver10sCount} passed=${row.passed}`
    ),
    "",
    "## Slow Scenarios",
    "",
    ...report.slowScenarios.slice(0, 80).map(
      (row) =>
        `- ${row.sampleId}#${row.questionIndex} family=${row.routeFamily} latency=${row.latencyMs} dominantStage=${row.dominantStage ?? "n/a"} budgetEnforced=${row.routeBudgetEnforced} budgetDecision=${row.routeBudgetDecision ?? "n/a"} owner=${row.residualOwner ?? "n/a"} final=${row.finalClaimSource ?? "n/a"} q=${row.question}`
    )
  ];
  return `${lines.join("\n")}\n`;
}

export async function runAndWriteLoCoMoRouteBudgetProfile(options?: {
  readonly artifactPath?: string;
}): Promise<{ readonly report: LoCoMoRouteBudgetProfile; readonly output: { readonly jsonPath: string; readonly markdownPath: string } }> {
  const source = await readLoCoMoArtifact(import.meta.url, options?.artifactPath);
  const results = source.report.results ?? [];
  const families = new Map<string, typeof results>();
  for (const result of results) {
    const family = locomoRouteFamily(result);
    families.set(family, [...(families.get(family) ?? []), result]);
  }
  const rows: RouteBudgetRow[] = [];
  const slowScenarios: SlowRouteScenario[] = [];
  const failures: string[] = [];
  for (const [family, familyRows] of [...families.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const latencies = familyRows.map(resultLatencyMs);
    const budget = budgetFor(family);
    const overP95TargetRows = familyRows.filter((result) => resultLatencyMs(result) > budget.p95TargetMs);
    const overHardMaxRows = familyRows.filter((result) => resultLatencyMs(result) > budget.hardMaxMs);
    const timeoutLikeRows = familyRows.filter(isTimeoutLike);
    const missingTelemetryRows = familyRows.filter((result) => hasMissingSlowTelemetry(result, 10_000));
    const row: RouteBudgetRow = {
      routeFamily: family,
      count: familyRows.length,
      p50Ms: percentile(latencies, 50),
      p95Ms: percentile(latencies, 95),
      maxMs: percentile(latencies, 100),
      overP95TargetCount: overP95TargetRows.length,
      overHardMaxCount: overHardMaxRows.length,
      timeoutLikeCount: timeoutLikeRows.length,
      missingTelemetryOver10sCount: missingTelemetryRows.length,
      passed:
        percentile(latencies, 95) <= budget.p95TargetMs &&
        percentile(latencies, 100) <= budget.hardMaxMs &&
        timeoutLikeRows.length === 0 &&
        missingTelemetryRows.length === 0
    };
    if (!row.passed) {
      failures.push(`route_budget_failed:${family}`);
    }
    rows.push(row);
    for (const result of [...overP95TargetRows, ...overHardMaxRows, ...timeoutLikeRows, ...missingTelemetryRows]) {
      slowScenarios.push({
        sampleId: result.sampleId ?? "unknown",
        questionIndex: typeof result.questionIndex === "number" ? result.questionIndex : -1,
        question: result.question ?? "",
        routeFamily: family,
        latencyMs: resultLatencyMs(result),
        dominantStage: result.dominantStage ?? null,
        topStageMs: result.topStageMs ?? null,
        routeBudgetEnforced: result.routeBudgetEnforced === true,
        routeBudgetDecision: result.routeBudgetDecision ?? null,
        residualOwner: result.residualOwner ?? null,
        queryBehavior: result.queryBehavior ?? null,
        finalClaimSource: result.finalClaimSource ?? null
      });
    }
  }
  const dedupedSlowScenarios = [...new Map(slowScenarios.map((row) => [`${row.sampleId}:${row.questionIndex}:${row.routeFamily}`, row])).values()]
    .sort((left, right) => right.latencyMs - left.latencyMs);
  const report: LoCoMoRouteBudgetProfile = {
    generatedAt: new Date().toISOString(),
    benchmark: "locomo_route_budget_profile",
    sourceArtifactPath: source.path,
    sourceStatus: source.report.status ?? "complete",
    passed: failures.length === 0,
    defaultBudget: DEFAULT_BUDGET,
    routeBudgets: ROUTE_BUDGETS,
    rows,
    slowScenarios: dedupedSlowScenarios,
    dominantStageBreakdownForSlowRows: countBy(dedupedSlowScenarios, (row) => row.dominantStage ?? "missing"),
    failures
  };
  const dir = locomoOutputDir(import.meta.url);
  await mkdir(dir, { recursive: true });
  const stamp = report.generatedAt.replace(/[:.]/gu, "-");
  const jsonPath = path.join(dir, `route-budget-locomo-profile-${stamp}.json`);
  const markdownPath = path.join(dir, `route-budget-locomo-profile-${stamp}.md`);
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, toMarkdown(report), "utf8");
  return { report, output: { jsonPath, markdownPath } };
}

export async function runLoCoMoRouteBudgetProfileCli(): Promise<void> {
  const result = await runAndWriteLoCoMoRouteBudgetProfile({ artifactPath: parseArtifactArg() });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.report.passed) {
    process.exitCode = 1;
  }
}
