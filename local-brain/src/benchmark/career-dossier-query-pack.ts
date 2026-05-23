import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { closePool } from "../db/client.js";
import { LIVE_PERSONAL_QUERY_CASES } from "./live-personal-query-fixtures.js";
import { benchmarkOutputDir } from "./query-benchmark-utils.js";
import { runLivePersonalQueryPackBenchmark, type LivePersonalQueryPackReport } from "./live-personal-query-pack.js";

const CAREER_DOSSIER_CASE_IDS = new Set([
  "career_work_history",
  "employment_company_list",
  "career_full_work_history",
  "employment_vs_projects",
  "two_way_well_inked_roles",
  "active_build_vs_work",
  "john_carmack_game_era_story"
]);

interface CareerDossierPhase7Metrics {
  readonly careerSectionCoverageRate: number;
  readonly employerProjectMixupCount: number;
  readonly unknownDateExplicitRate: number;
  readonly workHistoryDirectReadModelRate: number;
}

type CareerDossierQueryPackReport = LivePersonalQueryPackReport & {
  readonly phase7Metrics: CareerDossierPhase7Metrics;
};

function rate(numerator: number, denominator: number): number {
  return denominator === 0 ? 1 : Number((numerator / denominator).toFixed(4));
}

function phase7Metrics(report: LivePersonalQueryPackReport): CareerDossierPhase7Metrics {
  const sectionRequirements: Record<string, readonly string[]> = {
    career_work_history: ["Employment history", "Ventures / projects", "Uncertainty / gaps"],
    career_full_work_history: ["Employment history", "Ventures / projects", "Uncertainty / gaps"],
    employment_vs_projects: ["Employment history", "Ventures / projects"],
    two_way_well_inked_roles: ["Employment history", "Historical work context"],
    active_build_vs_work: ["Employment history", "Ventures / projects"],
    john_carmack_game_era_story: ["Employment history", "Historical work context"]
  };
  const requiredChecks = report.results.flatMap((result) =>
    (sectionRequirements[result.id] ?? []).map((section) => result.answerText.includes(section))
  );
  const employerList = report.results.find((result) => result.id === "employment_company_list")?.answerText ?? "";
  const employerProjectMixupCount = ["AI Brain", "Preset Kitchen", "Bumblebee", "Memoir Engine", "Stripe", "Burning Man"].filter((term) =>
    employerList.toLowerCase().includes(term.toLowerCase())
  ).length;
  const unknownDateRows = report.results.filter((result) =>
    ["career_work_history", "career_full_work_history", "employment_vs_projects", "two_way_well_inked_roles", "active_build_vs_work", "john_carmack_game_era_story"].includes(result.id)
  );
  return {
    careerSectionCoverageRate: rate(requiredChecks.filter(Boolean).length, requiredChecks.length),
    employerProjectMixupCount,
    unknownDateExplicitRate: rate(unknownDateRows.filter((result) => /\bdate unknown\b/iu.test(result.answerText)).length, unknownDateRows.length),
    workHistoryDirectReadModelRate: rate(
      report.results.filter((result) => result.finalClaimSource === "work_history_report_direct_read_model").length,
      report.results.length
    )
  };
}

export async function runCareerDossierQueryPackBenchmark(): Promise<CareerDossierQueryPackReport> {
  const report = await runLivePersonalQueryPackBenchmark({
    benchmarkName: "career_dossier_query_pack",
    cases: LIVE_PERSONAL_QUERY_CASES.filter((testCase) => CAREER_DOSSIER_CASE_IDS.has(testCase.id))
  });
  const metrics = phase7Metrics(report);
  const phase7Failures = [
    metrics.careerSectionCoverageRate < 0.95 ? "phase7:career_section_coverage_below_threshold" : "",
    metrics.employerProjectMixupCount > 0 ? "phase7:employer_project_mixup" : "",
    metrics.unknownDateExplicitRate < 1 ? "phase7:unknown_dates_not_explicit" : "",
    metrics.workHistoryDirectReadModelRate < 1 ? "phase7:wrong_work_history_read_model_rate" : ""
  ].filter(Boolean);
  return {
    ...report,
    passed: report.passed && phase7Failures.length === 0,
    failures: [...report.failures, ...phase7Failures],
    phase7Metrics: metrics
  };
}

export async function runAndWriteCareerDossierQueryPackBenchmark(): Promise<LivePersonalQueryPackReport> {
  const report = await runCareerDossierQueryPackBenchmark();
  const dir = benchmarkOutputDir();
  await mkdir(dir, { recursive: true });
  const stamp = report.generatedAt.replace(/[:.]/gu, "-");
  await writeFile(path.join(dir, `career-dossier-query-pack-${stamp}.json`), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(
    path.join(dir, `career-dossier-query-pack-${stamp}.md`),
    `# Career Dossier Query Pack\n\n${JSON.stringify(report.metrics, null, 2)}\n\n## Phase 7 Metrics\n\n${JSON.stringify(report.phase7Metrics, null, 2)}\n`
  );
  await closePool();
  if (!report.passed) {
    throw new Error(`career-dossier-query-pack failed: ${report.failures.join(", ")}`);
  }
  return report;
}

export async function runCareerDossierQueryPackCli(): Promise<void> {
  const report = await runAndWriteCareerDossierQueryPackBenchmark();
  console.log(JSON.stringify({ passed: report.passed, metrics: report.metrics }, null, 2));
}
