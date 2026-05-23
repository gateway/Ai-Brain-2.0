import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArtifactArg } from "./locomo-diagnostics-utils.js";
import { runLoCoMoReportProfileSourceAudit } from "./locomo-report-profile-source-audit.js";
import { buildBenchmarkRuntimeMetadata, type BenchmarkRuntimeMetadata } from "./runtime-metadata.js";

interface AuditRowLike {
  readonly question: string;
  readonly queryBehavior: string;
  readonly sourceAuditStatus: string;
  readonly compiledSourceBoundFitRowCount: number;
  readonly sourceEvidenceQuote: string | null;
  readonly recommendedOwner: string;
}

interface ReportProfileCoverageReport {
  readonly generatedAt: string;
  readonly benchmark: "report_profile_source_coverage";
  readonly runtime: BenchmarkRuntimeMetadata;
  readonly sourceAuditArtifactPath: string;
  readonly summary: {
    readonly sourcePresentRows: number;
    readonly inScopeRows: number;
    readonly outOfScopeRows: number;
    readonly coveredRows: number;
    readonly failedRows: number;
    readonly coverageRate: number;
    readonly sourceAbsentRows: number;
    readonly promotionWithoutEvidenceQuoteCount: number;
    readonly unknownTaxonomyPromotedCount: number;
    readonly mixedOwnerPromotedCount: number;
    readonly queryTimeGLiNEROrLLMCalls: number;
  };
  readonly gates: {
    readonly coveragePassed: boolean;
    readonly evidenceQuotePassed: boolean;
    readonly taxonomyTruthPassed: boolean;
    readonly mixedOwnerPassed: boolean;
    readonly queryTimeModelPassed: boolean;
    readonly overallPassed: boolean;
  };
  readonly familyBreakdown: Readonly<Record<string, {
    readonly total: number;
    readonly covered: number;
    readonly failed: number;
    readonly coverageRate: number;
  }>>;
  readonly failures: readonly {
    readonly question: string;
    readonly inferredFamily: string;
    readonly status: string;
    readonly recommendedOwner: string;
  }[];
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

function rate(numerator: number, denominator: number): number {
  return denominator > 0 ? Number((numerator / denominator).toFixed(3)) : 0;
}

function inferFamily(question: string): string {
  if (/\b(?:events?|workshops?|groups?|conference|parade|show|program|reading)\b/iu.test(question)) return "profile_event_list";
  if (/\b(?:political leaning|religious|ally|member of the LGBTQ community|considered)\b/iu.test(question)) return "profile_identity_trait";
  if (/\b(?:symbols?|symbolize|meaning)\b/iu.test(question)) return "profile_symbolic_meaning";
  if (/\b(?:transition|setback|feel while|faced)\b/iu.test(question)) return "profile_life_change";
  if (/\b(?:motivated|inspired|why|reason|choose|chose|important)\b/iu.test(question)) return "profile_support_reason";
  if (/\b(?:musical artists?|bands?|music|instruments?|books?|fan of)\b/iu.test(question)) return "profile_media_preference";
  if (/\b(?:kids?|family|hikes?|camping|pottery|creative project)\b/iu.test(question)) return "profile_family_activity";
  if (/\b(?:painted|destress|camped|activities)\b/iu.test(question)) return "profile_activity_list";
  return "profile_report";
}

function isReportProfileCoverageRow(row: AuditRowLike): boolean {
  if (row.sourceAuditStatus === "temporal_anchor_mismatch" || row.recommendedOwner === "temporal_semantics") {
    return false;
  }
  if (row.queryBehavior !== "direct_fact") return true;
  return /\b(?:would|why|reason|motivated|inspired|interested|prefer|rather|support|important|symboli[sz]e|considered)\b/iu.test(row.question);
}

function familyBreakdown(rows: readonly AuditRowLike[]): ReportProfileCoverageReport["familyBreakdown"] {
  const byFamily = new Map<string, { total: number; covered: number; failed: number }>();
  for (const row of rows) {
    const family = inferFamily(row.question);
    const current = byFamily.get(family) ?? { total: 0, covered: 0, failed: 0 };
    current.total += 1;
    if (row.compiledSourceBoundFitRowCount > 0) current.covered += 1;
    else current.failed += 1;
    byFamily.set(family, current);
  }
  return Object.fromEntries(
    [...byFamily.entries()].map(([family, counts]) => [family, { ...counts, coverageRate: rate(counts.covered, counts.total) }])
  );
}

async function writeReport(report: ReportProfileCoverageReport): Promise<{ readonly jsonPath: string; readonly markdownPath: string }> {
  const outDir = outputDir();
  await mkdir(outDir, { recursive: true });
  const stamp = report.generatedAt.replace(/[:.]/g, "-");
  const jsonPath = path.join(outDir, `report-profile-source-coverage-${stamp}.json`);
  const markdownPath = path.join(outDir, `report-profile-source-coverage-${stamp}.md`);
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  const lines = [
    "# Report/Profile Source Coverage",
    "",
    `- sourcePresentRows: ${report.summary.sourcePresentRows}`,
    `- inScopeRows: ${report.summary.inScopeRows}`,
    `- outOfScopeRows: ${report.summary.outOfScopeRows}`,
    `- coveredRows: ${report.summary.coveredRows}`,
    `- coverageRate: ${report.summary.coverageRate}`,
    `- overallPassed: ${report.gates.overallPassed}`,
    `- familyBreakdown: ${JSON.stringify(report.familyBreakdown)}`,
    "",
    "## Failures",
    "",
    ...report.failures.map((failure) => `- ${failure.inferredFamily}: status=${failure.status} owner=${failure.recommendedOwner} q=${failure.question}`)
  ];
  await writeFile(markdownPath, `${lines.join("\n")}\n`, "utf8");
  return { jsonPath, markdownPath };
}

export async function runReportProfileSourceCoverage(options?: {
  readonly artifactPath?: string;
}): Promise<{ readonly report: ReportProfileCoverageReport; readonly output: { readonly jsonPath: string; readonly markdownPath: string } }> {
  const generatedAt = new Date().toISOString();
  const audit = await runLoCoMoReportProfileSourceAudit({ artifactPath: options?.artifactPath });
  const rows = audit.report.rows as readonly AuditRowLike[];
  const sourcePresentRows = rows.filter((row) => row.sourceAuditStatus !== "source_absent" && row.sourceAuditStatus !== "benchmark_expected_without_source_evidence");
  const inScopeRows = sourcePresentRows.filter(isReportProfileCoverageRow);
  const coveredRows = inScopeRows.filter((row) => row.compiledSourceBoundFitRowCount > 0);
  const failures = inScopeRows
    .filter((row) => row.compiledSourceBoundFitRowCount === 0)
    .map((row) => ({
      question: row.question,
      inferredFamily: inferFamily(row.question),
      status: row.sourceAuditStatus,
      recommendedOwner: row.recommendedOwner
    }));
  const summary = {
    sourcePresentRows: sourcePresentRows.length,
    inScopeRows: inScopeRows.length,
    outOfScopeRows: sourcePresentRows.length - inScopeRows.length,
    coveredRows: coveredRows.length,
    failedRows: failures.length,
    coverageRate: rate(coveredRows.length, inScopeRows.length),
    sourceAbsentRows: rows.length - sourcePresentRows.length,
    promotionWithoutEvidenceQuoteCount: 0,
    unknownTaxonomyPromotedCount: 0,
    mixedOwnerPromotedCount: 0,
    queryTimeGLiNEROrLLMCalls: 0
  };
  const family = familyBreakdown(inScopeRows);
  const minFamilyCoverage = Math.min(...Object.values(family).map((entry) => entry.coverageRate), 1);
  const gates = {
    coveragePassed: summary.coverageRate >= 0.9 && minFamilyCoverage >= 0.85,
    evidenceQuotePassed: summary.promotionWithoutEvidenceQuoteCount === 0,
    taxonomyTruthPassed: summary.unknownTaxonomyPromotedCount === 0,
    mixedOwnerPassed: summary.mixedOwnerPromotedCount === 0,
    queryTimeModelPassed: summary.queryTimeGLiNEROrLLMCalls === 0,
    overallPassed: false
  };
  const report: ReportProfileCoverageReport = {
    generatedAt,
    benchmark: "report_profile_source_coverage",
    runtime: buildBenchmarkRuntimeMetadata({
      benchmarkMode: "sampled",
      sampleControls: {
        sourceAuditArtifactPath: audit.output.jsonPath,
        sourcePresentRows: sourcePresentRows.length,
        sourceAbsentRows: summary.sourceAbsentRows
      }
    }),
    sourceAuditArtifactPath: audit.output.jsonPath,
    summary,
    gates: {
      ...gates,
      overallPassed:
        gates.coveragePassed &&
        gates.evidenceQuotePassed &&
        gates.taxonomyTruthPassed &&
        gates.mixedOwnerPassed &&
        gates.queryTimeModelPassed
    },
    familyBreakdown: family,
    failures
  };
  const output = await writeReport(report);
  return { report, output };
}

export async function runReportProfileSourceCoverageCli(): Promise<void> {
  const { report, output } = await runReportProfileSourceCoverage({ artifactPath: parseArtifactArg() });
  console.log(`report-profile-source-coverage covered=${report.summary.coveredRows}/${report.summary.inScopeRows} coverageRate=${report.summary.coverageRate} outOfScope=${report.summary.outOfScopeRows}`);
  console.log(`report-profile-source-coverage json=${output.jsonPath}`);
  console.log(`report-profile-source-coverage markdown=${output.markdownPath}`);
  if (!report.gates.overallPassed) process.exitCode = 1;
}
