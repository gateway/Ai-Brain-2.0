import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { LoCoMoReport } from "./locomo.js";

interface DriftAuditResult {
  readonly key: string;
  readonly sampleId: string;
  readonly questionIndex: number;
  readonly category: number;
  readonly queryBehavior: string;
  readonly question: string;
  readonly baselinePassed: boolean;
  readonly candidatePassed: boolean;
  readonly baselineFailureClass: string;
  readonly candidateFailureClass: string;
  readonly baselineConfidence: string | null;
  readonly candidateConfidence: string | null;
  readonly baselineSufficiency: string | null;
  readonly candidateSufficiency: string | null;
  readonly baselineSubjectMatch: string | null;
  readonly candidateSubjectMatch: string | null;
  readonly baselineSynthesisMode: string | null;
  readonly candidateSynthesisMode: string | null;
  readonly baselineAnswerSnippet: string;
  readonly candidateAnswerSnippet: string;
}

interface DriftAuditReport {
  readonly generatedAt: string;
  readonly benchmark: "locomo_drift_audit";
  readonly baselinePath: string;
  readonly candidatePath: string;
  readonly summary: {
    readonly baselinePassRate: number;
    readonly candidatePassRate: number;
    readonly passRateDelta: number;
    readonly regressions: number;
    readonly recoveries: number;
    readonly unchangedPasses: number;
    readonly unchangedFailures: number;
  };
  readonly metricDelta: {
    readonly retrieval: number;
    readonly temporal: number;
    readonly answer_shaping: number;
    readonly alias_entity_resolution: number;
    readonly abstention: number;
    readonly reflectHelpedRate: number;
    readonly exactDetailPrecision: number;
  };
  readonly regressions: readonly DriftAuditResult[];
  readonly recoveries: readonly DriftAuditResult[];
  readonly changedFailureClass: readonly DriftAuditResult[];
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function outputDir(): string {
  return path.resolve(process.cwd(), "benchmark-results");
}

function resultKey(result: LoCoMoReport["results"][number]): string {
  return `${result.sampleId}#${result.questionIndex}`;
}

async function loadArtifact(artifactPath: string): Promise<LoCoMoReport> {
  return JSON.parse(await readFile(artifactPath, "utf8")) as LoCoMoReport;
}

function toMap(report: LoCoMoReport): Map<string, LoCoMoReport["results"][number]> {
  return new Map(report.results.map((result) => [resultKey(result), result]));
}

function failureCount(report: LoCoMoReport, key: keyof LoCoMoReport["diagnostics"]["failureBreakdown"]): number {
  return report.diagnostics.failureBreakdown[key] ?? 0;
}

function buildDriftRow(
  baseline: LoCoMoReport["results"][number],
  candidate: LoCoMoReport["results"][number]
): DriftAuditResult {
  return {
    key: resultKey(baseline),
    sampleId: baseline.sampleId,
    questionIndex: baseline.questionIndex,
    category: baseline.category,
    queryBehavior: baseline.queryBehavior,
    question: baseline.question,
    baselinePassed: baseline.passed,
    candidatePassed: candidate.passed,
    baselineFailureClass: baseline.failureClass,
    candidateFailureClass: candidate.failureClass,
    baselineConfidence: baseline.confidence,
    candidateConfidence: candidate.confidence,
    baselineSufficiency: baseline.sufficiency,
    candidateSufficiency: candidate.sufficiency,
    baselineSubjectMatch: baseline.subjectMatch,
    candidateSubjectMatch: candidate.subjectMatch,
    baselineSynthesisMode: baseline.synthesisMode,
    candidateSynthesisMode: candidate.synthesisMode,
    baselineAnswerSnippet: baseline.answerSnippet,
    candidateAnswerSnippet: candidate.answerSnippet
  };
}

function toMarkdown(report: DriftAuditReport): string {
  const lines = [
    "# LoCoMo Drift Audit",
    "",
    `- baselinePath: ${report.baselinePath}`,
    `- candidatePath: ${report.candidatePath}`,
    `- baselinePassRate: ${report.summary.baselinePassRate}`,
    `- candidatePassRate: ${report.summary.candidatePassRate}`,
    `- passRateDelta: ${report.summary.passRateDelta}`,
    `- regressions: ${report.summary.regressions}`,
    `- recoveries: ${report.summary.recoveries}`,
    `- unchangedPasses: ${report.summary.unchangedPasses}`,
    `- unchangedFailures: ${report.summary.unchangedFailures}`,
    "",
    "## Metric Delta",
    "",
    `- retrieval: ${report.metricDelta.retrieval}`,
    `- temporal: ${report.metricDelta.temporal}`,
    `- answer_shaping: ${report.metricDelta.answer_shaping}`,
    `- alias_entity_resolution: ${report.metricDelta.alias_entity_resolution}`,
    `- abstention: ${report.metricDelta.abstention}`,
    `- reflectHelpedRate: ${report.metricDelta.reflectHelpedRate}`,
    `- exactDetailPrecision: ${report.metricDelta.exactDetailPrecision}`,
    "",
    "## Regressions",
    ""
  ];

  for (const row of report.regressions) {
    lines.push(
      `- ${row.key}: ${row.baselineFailureClass} -> ${row.candidateFailureClass} | ${row.question}`,
      `  - confidence: ${row.baselineConfidence} -> ${row.candidateConfidence}`,
      `  - sufficiency: ${row.baselineSufficiency} -> ${row.candidateSufficiency}`,
      `  - subjectMatch: ${row.baselineSubjectMatch} -> ${row.candidateSubjectMatch}`,
      `  - synthesisMode: ${row.baselineSynthesisMode} -> ${row.candidateSynthesisMode}`
    );
  }

  lines.push("", "## Recoveries", "");
  for (const row of report.recoveries) {
    lines.push(`- ${row.key}: ${row.baselineFailureClass} -> ${row.candidateFailureClass} | ${row.question}`);
  }

  return lines.join("\n");
}

export async function runLoCoMoDriftAudit(baselinePath: string, candidatePath: string): Promise<{
  readonly report: DriftAuditReport;
  readonly jsonPath: string;
  readonly markdownPath: string;
}> {
  const [baseline, candidate] = await Promise.all([loadArtifact(baselinePath), loadArtifact(candidatePath)]);
  const baselineMap = toMap(baseline);
  const candidateMap = toMap(candidate);

  const regressions: DriftAuditResult[] = [];
  const recoveries: DriftAuditResult[] = [];
  const changedFailureClass: DriftAuditResult[] = [];
  let unchangedPasses = 0;
  let unchangedFailures = 0;

  for (const [key, baselineResult] of baselineMap.entries()) {
    const candidateResult = candidateMap.get(key);
    if (!candidateResult) {
      continue;
    }
    const row = buildDriftRow(baselineResult, candidateResult);
    if (baselineResult.passed && !candidateResult.passed) {
      regressions.push(row);
    } else if (!baselineResult.passed && candidateResult.passed) {
      recoveries.push(row);
    } else if (baselineResult.passed && candidateResult.passed) {
      unchangedPasses += 1;
    } else {
      unchangedFailures += 1;
    }
    if (baselineResult.failureClass !== candidateResult.failureClass) {
      changedFailureClass.push(row);
    }
  }

  regressions.sort((left, right) => left.key.localeCompare(right.key));
  recoveries.sort((left, right) => left.key.localeCompare(right.key));
  changedFailureClass.sort((left, right) => left.key.localeCompare(right.key));

  const report: DriftAuditReport = {
    generatedAt: new Date().toISOString(),
    benchmark: "locomo_drift_audit",
    baselinePath,
    candidatePath,
    summary: {
      baselinePassRate: baseline.passRate,
      candidatePassRate: candidate.passRate,
      passRateDelta: Number((candidate.passRate - baseline.passRate).toFixed(3)),
      regressions: regressions.length,
      recoveries: recoveries.length,
      unchangedPasses,
      unchangedFailures
    },
    metricDelta: {
      retrieval: failureCount(candidate, "retrieval") - failureCount(baseline, "retrieval"),
      temporal: failureCount(candidate, "temporal") - failureCount(baseline, "temporal"),
      answer_shaping: failureCount(candidate, "answer_shaping") - failureCount(baseline, "answer_shaping"),
      alias_entity_resolution:
        failureCount(candidate, "alias_entity_resolution") - failureCount(baseline, "alias_entity_resolution"),
      abstention: failureCount(candidate, "abstention") - failureCount(baseline, "abstention"),
      reflectHelpedRate: Number((candidate.diagnostics.reflectHelpedRate - baseline.diagnostics.reflectHelpedRate).toFixed(3)),
      exactDetailPrecision: Number((candidate.diagnostics.exactDetailPrecision - baseline.diagnostics.exactDetailPrecision).toFixed(3))
    },
    regressions,
    recoveries,
    changedFailureClass
  };

  const dir = outputDir();
  await mkdir(dir, { recursive: true });
  const runStamp = stamp();
  const jsonPath = path.join(dir, `locomo-drift-audit-${runStamp}.json`);
  const markdownPath = path.join(dir, `locomo-drift-audit-${runStamp}.md`);
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, `${toMarkdown(report)}\n`, "utf8");

  return {
    report,
    jsonPath,
    markdownPath
  };
}
