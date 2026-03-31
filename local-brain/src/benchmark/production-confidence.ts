import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { closePool, queryRows } from "../db/client.js";
import { runMigrations } from "../db/migrations.js";
import { runAndWriteLoCoMoBenchmark } from "./locomo.js";
import { runAndWriteMcpProductionSmokeBenchmark } from "./mcp-production-smoke.js";
import { runAndWriteMcpSmokeBenchmark } from "./mcp-smoke.js";
import { runAndWriteOmiWatchSmokeBenchmark } from "./omi-watch-smoke.js";
import { runAndWritePersonalOmiReview } from "./personal-omi-review.js";
import { runAndWritePersonalOpenClawReviewBenchmark } from "./personal-openclaw-review.js";
import { countFailureCategories, normalizeScore, weightedProductionScore, type ProductionFailureCategory } from "./production-confidence-shared.js";
import { runAndWriteProfileRoutingReviewBenchmark } from "./profile-routing-review.js";
import { runAndWritePublicMemoryMissRegressionsBenchmark } from "./public-memory-miss-regressions.js";
import { runAndWriteRecursiveReflectReviewBenchmark } from "./recursive-reflect-review.js";
import { runAndWriteSessionStartMemoryBenchmark } from "./session-start-memory.js";

interface DbRuntimeCheck {
  readonly name: string;
  readonly passed: boolean;
  readonly detail: string;
}

interface GateArtifact {
  readonly name: string;
  readonly passed: boolean;
  readonly artifactPath: string;
}

export interface ProductionConfidenceReport {
  readonly generatedAt: string;
  readonly targetScore: number;
  readonly weightedScore: number;
  readonly releaseGatePassed: boolean;
  readonly scores: {
    readonly continuity: number;
    readonly personalRecall: number;
    readonly mcpQuality: number;
    readonly dbRuntime: number;
    readonly benchmarkSafety: number;
  };
  readonly gates: {
    readonly continuity: readonly GateArtifact[];
    readonly personalRecall: readonly GateArtifact[];
    readonly mcpQuality: readonly GateArtifact[];
    readonly benchmarkSafety: readonly GateArtifact[];
  };
  readonly dbRuntimeChecks: readonly DbRuntimeCheck[];
  readonly failureCategoryCounts: Record<ProductionFailureCategory, number>;
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

function boolPassRate(items: readonly { readonly passed: boolean }[]): number {
  return normalizeScore(items.filter((item) => item.passed).length, items.length);
}

async function runDbRuntimeChecks(): Promise<readonly DbRuntimeCheck[]> {
  const firstApplied = await runMigrations();
  const secondApplied = await runMigrations();
  const monitoredSourceOverlapRows = await queryRows<{ root_path: string; namespace_count: number }>(
    `
      SELECT root_path, COUNT(DISTINCT namespace_id)::int AS namespace_count
      FROM ops.monitored_sources
      WHERE monitor_enabled = true
      GROUP BY root_path
      HAVING COUNT(DISTINCT namespace_id) > 1
    `
  );
  const personalContaminationRows = await queryRows<{ total: number }>(
    `
      SELECT COUNT(*)::int AS total
      FROM artifacts
      WHERE namespace_id = 'personal'
        AND (
          uri ILIKE '%benchmark-generated%'
          OR uri ILIKE '%examples-private/life-replay%'
          OR uri ILIKE '%life-replay%'
        )
    `
  );
  const answerableUnitTableRows = await queryRows<{ exists: boolean }>(
    `SELECT to_regclass('public.answerable_units') IS NOT NULL AS exists`
  );

  return [
    {
      name: "migration_idempotency",
      passed: secondApplied.length === 0,
      detail: secondApplied.length === 0 ? `ok (first=${firstApplied.length}, second=0)` : `second pass applied ${secondApplied.join(", ")}`
    },
    {
      name: "monitored_source_root_overlap",
      passed: monitoredSourceOverlapRows.length === 0,
      detail:
        monitoredSourceOverlapRows.length === 0
          ? "ok"
          : monitoredSourceOverlapRows.map((row) => `${row.root_path}:${row.namespace_count}`).join(" | ")
    },
    {
      name: "personal_source_contamination",
      passed: (personalContaminationRows[0]?.total ?? 0) === 0,
      detail: `personal contamination rows=${personalContaminationRows[0]?.total ?? 0}`
    },
    {
      name: "answerable_unit_table_present",
      passed: answerableUnitTableRows[0]?.exists === true,
      detail: answerableUnitTableRows[0]?.exists === true ? "present" : "missing"
    }
  ];
}

function toMarkdown(report: ProductionConfidenceReport): string {
  const lines = [
    "# Production Confidence 98",
    "",
    `- generatedAt: ${report.generatedAt}`,
    `- targetScore: ${report.targetScore}`,
    `- weightedScore: ${report.weightedScore}`,
    `- releaseGatePassed: ${report.releaseGatePassed}`,
    "",
    "## Scores",
    "",
    `- continuity: ${report.scores.continuity}`,
    `- personalRecall: ${report.scores.personalRecall}`,
    `- mcpQuality: ${report.scores.mcpQuality}`,
    `- dbRuntime: ${report.scores.dbRuntime}`,
    `- benchmarkSafety: ${report.scores.benchmarkSafety}`,
    "",
    `- failureCategoryCounts: ${JSON.stringify(report.failureCategoryCounts)}`,
    "",
    "## DB Runtime",
    ""
  ];

  for (const check of report.dbRuntimeChecks) {
    lines.push(`- ${check.name}: ${check.passed ? "pass" : "fail"} | ${check.detail}`);
  }

  const sections: Array<keyof ProductionConfidenceReport["gates"]> = ["continuity", "personalRecall", "mcpQuality", "benchmarkSafety"];
  for (const section of sections) {
    lines.push("");
    lines.push(`## ${section}`);
    lines.push("");
    for (const gate of report.gates[section]) {
      lines.push(`- ${gate.name}: ${gate.passed ? "pass" : "fail"} | ${gate.artifactPath}`);
    }
  }

  lines.push("");
  return `${lines.join("\n")}\n`;
}

export async function runAndWriteProductionConfidenceBenchmark(): Promise<{
  readonly report: ProductionConfidenceReport;
  readonly output: {
    readonly jsonPath: string;
    readonly markdownPath: string;
  };
}> {
  const sessionStart = await runAndWriteSessionStartMemoryBenchmark();
  const personalOpenclaw = await runAndWritePersonalOpenClawReviewBenchmark();
  const personalOmi = await runAndWritePersonalOmiReview();
  const mcpProduction = await runAndWriteMcpProductionSmokeBenchmark();
  const mcpSmoke = await runAndWriteMcpSmokeBenchmark();
  const omiWatch = await runAndWriteOmiWatchSmokeBenchmark();
  const profileRouting = await runAndWriteProfileRoutingReviewBenchmark();
  const recursiveReflect = await runAndWriteRecursiveReflectReviewBenchmark();
  const publicMisses = await runAndWritePublicMemoryMissRegressionsBenchmark();

  process.env.BRAIN_LOCOMO_SAMPLE_CONVERSATIONS = "10";
  process.env.BRAIN_LOCOMO_SAMPLE_QUESTIONS = "10";
  process.env.BRAIN_LOCOMO_STRATIFIED = "1";
  process.env.BRAIN_LOCOMO_CATEGORY_LIMIT = "2";
  const locomo = await runAndWriteLoCoMoBenchmark();

  const dbRuntimeChecks = await runDbRuntimeChecks();
  const continuityGates: GateArtifact[] = [
    { name: "session_start_memory", passed: sessionStart.report.passed, artifactPath: sessionStart.output.jsonPath },
    {
      name: "personal_openclaw_review",
      passed: personalOpenclaw.report.summary.fail === 0 && personalOpenclaw.report.sourceShape.passed,
      artifactPath: personalOpenclaw.output.jsonPath
    },
    { name: "omi_watch", passed: omiWatch.report.passed, artifactPath: omiWatch.output.jsonPath }
  ];
  const personalRecallGates: GateArtifact[] = [
    {
      name: "personal_omi_review",
      passed: personalOmi.report.summary.fail === 0 && personalOmi.report.summary.warning === 0,
      artifactPath: personalOmi.jsonPath
    }
  ];
  const mcpGates: GateArtifact[] = [
    { name: "mcp_production_smoke", passed: mcpProduction.report.passed, artifactPath: mcpProduction.output.jsonPath },
    { name: "mcp_smoke", passed: mcpSmoke.report.passed, artifactPath: mcpSmoke.output.jsonPath }
  ];
  const benchmarkSafetyGates: GateArtifact[] = [
    {
      name: "profile_routing_review",
      passed: profileRouting.report.summary.fail === 0,
      artifactPath: profileRouting.output.jsonPath
    },
    {
      name: "recursive_reflect_review",
      passed: recursiveReflect.report.summary.fail === 0,
      artifactPath: recursiveReflect.output.jsonPath
    },
    {
      name: "public_memory_miss_regressions",
      passed: publicMisses.report.passed,
      artifactPath: publicMisses.output.jsonPath
    },
    {
      name: "locomo_standard",
      passed: locomo.report.passRate >= 0.45,
      artifactPath: locomo.output.jsonPath
    }
  ];

  const continuityScore = Number((((sessionStart.report.passed ? 100 : 0) + normalizeScore(personalOpenclaw.report.summary.pass, personalOpenclaw.report.scenarios.length) + (omiWatch.report.passed ? 100 : 0)) / 3).toFixed(2));
  const personalRecallScore = Number((((personalOmi.report.summary.pass + personalOmi.report.summary.warning * 0.5) / personalOmi.report.scenarios.length) * 100).toFixed(2));
  const mcpQualityScore = Number((((boolPassRate(mcpGates) + normalizeScore(mcpProduction.report.summary.pass, mcpProduction.report.results.length)) / 2)).toFixed(2));
  const dbRuntimeScore = boolPassRate(dbRuntimeChecks);
  const benchmarkSafetyScore = boolPassRate(benchmarkSafetyGates);
  const weightedScore = weightedProductionScore({
    continuity: continuityScore,
    personalRecall: personalRecallScore,
    mcpQuality: mcpQualityScore,
    dbRuntime: dbRuntimeScore,
    benchmarkSafety: benchmarkSafetyScore
  });

  const failureCategoryCounts = countFailureCategories([
    ...personalOmi.report.scenarios,
    ...personalOpenclaw.report.scenarios,
    ...mcpProduction.report.results
  ]);

  const report: ProductionConfidenceReport = {
    generatedAt: new Date().toISOString(),
    targetScore: 98,
    weightedScore,
    releaseGatePassed:
      weightedScore >= 98 &&
      continuityScore >= 98 &&
      personalRecallScore >= 95 &&
      mcpQualityScore >= 98 &&
      dbRuntimeScore === 100 &&
      benchmarkSafetyScore === 100,
    scores: {
      continuity: continuityScore,
      personalRecall: personalRecallScore,
      mcpQuality: mcpQualityScore,
      dbRuntime: dbRuntimeScore,
      benchmarkSafety: benchmarkSafetyScore
    },
    gates: {
      continuity: continuityGates,
      personalRecall: personalRecallGates,
      mcpQuality: mcpGates,
      benchmarkSafety: benchmarkSafetyGates
    },
    dbRuntimeChecks,
    failureCategoryCounts
  };

  const dir = outputDir();
  await mkdir(dir, { recursive: true });
  const stamp = report.generatedAt.replace(/[:.]/g, "-");
  const jsonPath = path.join(dir, `production-confidence-${stamp}.json`);
  const markdownPath = path.join(dir, `production-confidence-${stamp}.md`);
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, toMarkdown(report), "utf8");
  return {
    report,
    output: {
      jsonPath,
      markdownPath
    }
  };
}

export async function runProductionConfidenceBenchmarkCli(): Promise<void> {
  try {
    const result = await runAndWriteProductionConfidenceBenchmark();
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    await closePool();
  }
}
