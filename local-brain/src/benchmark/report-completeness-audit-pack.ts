import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scoreReportCompleteness } from "../retrieval/report-completeness-score.js";

const CAREER_REQUIRED = ["employment_history", "advisory_roles", "ventures_projects", "historical_work_context", "gaps", "source_trail"] as const;
const DOSSIER_REQUIRED = ["identity", "timeline", "work_projects", "relationships", "places", "preferences", "uncertainty_gaps", "source_trail"] as const;

const SCENARIOS = [
  {
    id: "career_complete",
    requiredSections: CAREER_REQUIRED,
    sections: CAREER_REQUIRED.map((id) => ({ id, title: id, text: `${id} section`, evidenceCount: 1, sourceTrailCount: 1 })),
    threshold: 0.9
  },
  {
    id: "dossier_complete",
    requiredSections: DOSSIER_REQUIRED,
    sections: DOSSIER_REQUIRED.map((id) => ({ id, title: id, text: `${id} section`, evidenceCount: 1, sourceTrailCount: 1 })),
    threshold: 0.9
  },
  {
    id: "career_incomplete_detected",
    requiredSections: CAREER_REQUIRED,
    sections: CAREER_REQUIRED.filter((id) => id !== "gaps").map((id) => ({ id, title: id, text: `${id} section`, evidenceCount: 1, sourceTrailCount: 1 })),
    threshold: 0.9,
    expectIncomplete: true
  }
];

function outputDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../benchmark-results");
}

export async function runAndWriteReportCompletenessAuditPack(): Promise<{ readonly report: any; readonly output: { readonly jsonPath: string; readonly markdownPath: string } }> {
  const rows = SCENARIOS.map((scenario) => {
    const score = scoreReportCompleteness({ requiredSections: scenario.requiredSections, sections: scenario.sections });
    const passed = scenario.expectIncomplete === true ? score.score < scenario.threshold && score.missingSections.length > 0 : score.score >= scenario.threshold;
    return { ...scenario, score, passed };
  });
  const completeRows = rows.filter((row) => row.expectIncomplete !== true);
  const metrics = {
    careerCompletenessRate: rows.find((row) => row.id === "career_complete")?.score.requiredSectionCoverageRate ?? 0,
    dossierSectionCoverageRate: rows.find((row) => row.id === "dossier_complete")?.score.requiredSectionCoverageRate ?? 0,
    reportCompletenessScore: Number((completeRows.reduce((sum, row) => sum + row.score.score, 0) / completeRows.length).toFixed(4)),
    incompleteReportDetectedCount: rows.filter((row) => row.expectIncomplete === true && row.passed).length
  };
  const generatedAt = new Date().toISOString();
  const report = {
    generatedAt,
    benchmark: "report_completeness_audit_pack",
    passed:
      rows.every((row) => row.passed) &&
      metrics.careerCompletenessRate >= 0.9 &&
      metrics.dossierSectionCoverageRate >= 0.9 &&
      metrics.incompleteReportDetectedCount === 1,
    metrics,
    results: rows
  };
  await mkdir(outputDir(), { recursive: true });
  const stamp = generatedAt.replace(/[:.]/gu, "-");
  const jsonPath = path.join(outputDir(), `report-completeness-audit-pack-${stamp}.json`);
  const markdownPath = path.join(outputDir(), `report-completeness-audit-pack-${stamp}.md`);
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, `# Report Completeness Audit Pack\n\n- passed: ${report.passed}\n- careerCompletenessRate: ${metrics.careerCompletenessRate}\n- dossierSectionCoverageRate: ${metrics.dossierSectionCoverageRate}\n`, "utf8");
  return { report, output: { jsonPath, markdownPath } };
}

export async function runReportCompletenessAuditPackCli(): Promise<void> {
  const { report, output } = await runAndWriteReportCompletenessAuditPack();
  process.stdout.write(`${output.jsonPath}\n${output.markdownPath}\n${JSON.stringify({ passed: report.passed, metrics: report.metrics }, null, 2)}\n`);
}
