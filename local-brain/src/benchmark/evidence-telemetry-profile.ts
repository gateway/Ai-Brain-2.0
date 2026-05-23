import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  countBy,
  evidenceTelemetryStatus,
  locomoOutputDir,
  parseArtifactArg,
  readLoCoMoArtifact
} from "./locomo-diagnostics-utils.js";

interface EvidenceTelemetryRow {
  readonly sampleId: string;
  readonly questionIndex: number;
  readonly status: string;
  readonly passed: boolean;
  readonly queryBehavior: string;
  readonly finalClaimSource: string | null;
  readonly rawEvidenceCount: number | null;
  readonly rawSourceCount: number | null;
  readonly sourceBoundSupportCount: number | null;
  readonly evidenceCount: number;
  readonly sourceCount: number;
  readonly sourceBoundEvidenceRequired: boolean;
  readonly sourceBoundEvidencePresent: boolean;
  readonly residualOwner: string | null;
  readonly question: string;
}

interface EvidenceTelemetryProfile {
  readonly generatedAt: string;
  readonly benchmark: "evidence_telemetry_profile";
  readonly sourceArtifactPath: string;
  readonly sourceStatus: string;
  readonly passed: boolean;
  readonly breakdown: Readonly<Record<string, number>>;
  readonly failureCounts: {
    readonly unsupportedSuccess: number;
    readonly supportPresentCountMissing: number;
    readonly evidenceZeroSuccessUnverified: number;
    readonly sourceCountMissing: number;
    readonly unclassified: number;
  };
  readonly rowsNeedingRepair: readonly EvidenceTelemetryRow[];
}

function toRow(result: any, status: string): EvidenceTelemetryRow {
  return {
    sampleId: result.sampleId ?? "unknown",
    questionIndex: typeof result.questionIndex === "number" ? result.questionIndex : -1,
    status,
    passed: result.passed === true,
    queryBehavior: result.queryBehavior ?? "unknown",
    finalClaimSource: result.finalClaimSource ?? null,
    rawEvidenceCount: typeof result.rawEvidenceCount === "number" ? result.rawEvidenceCount : null,
    rawSourceCount: typeof result.rawSourceCount === "number" ? result.rawSourceCount : null,
    sourceBoundSupportCount: typeof result.sourceBoundSupportCount === "number" ? result.sourceBoundSupportCount : null,
    evidenceCount: typeof result.evidenceCount === "number" ? result.evidenceCount : 0,
    sourceCount: typeof result.sourceCount === "number" ? result.sourceCount : 0,
    sourceBoundEvidenceRequired: result.sourceBoundEvidenceRequired === true,
    sourceBoundEvidencePresent: result.sourceBoundEvidencePresent === true,
    residualOwner: result.residualOwner ?? null,
    question: result.question ?? ""
  };
}

function toMarkdown(report: EvidenceTelemetryProfile): string {
  const lines = [
    "# Evidence Telemetry Profile",
    "",
    `- generatedAt: ${report.generatedAt}`,
    `- sourceArtifactPath: ${report.sourceArtifactPath}`,
    `- sourceStatus: ${report.sourceStatus}`,
    `- passed: ${report.passed}`,
    `- breakdown: ${JSON.stringify(report.breakdown)}`,
    `- failureCounts: ${JSON.stringify(report.failureCounts)}`,
    "",
    "## Rows Needing Repair",
    "",
    ...report.rowsNeedingRepair.slice(0, 80).map(
      (row) =>
        `- ${row.sampleId}#${row.questionIndex} status=${row.status} passed=${row.passed} behavior=${row.queryBehavior} final=${row.finalClaimSource ?? "n/a"} evidence=${row.evidenceCount}/${row.sourceCount} raw=${row.rawEvidenceCount ?? "n/a"}/${row.rawSourceCount ?? "n/a"} sourceBoundSupport=${row.sourceBoundSupportCount ?? "n/a"} sourceBound=${row.sourceBoundEvidencePresent}/${row.sourceBoundEvidenceRequired} owner=${row.residualOwner ?? "n/a"} q=${row.question}`
    )
  ];
  return `${lines.join("\n")}\n`;
}

export async function runAndWriteEvidenceTelemetryProfile(options?: {
  readonly artifactPath?: string;
}): Promise<{ readonly report: EvidenceTelemetryProfile; readonly output: { readonly jsonPath: string; readonly markdownPath: string } }> {
  const source = await readLoCoMoArtifact(import.meta.url, options?.artifactPath);
  const results = source.report.results ?? [];
  const statuses = results.map((result) => ({ result, status: evidenceTelemetryStatus(result) }));
  const breakdown = countBy(statuses, (entry) => entry.status);
  const repairStatuses = new Set([
    "unsupported_success",
    "support_present_count_missing",
    "evidence_zero_success_unverified",
    "source_count_missing",
    "unclassified"
  ]);
  const rowsNeedingRepair = statuses
    .filter((entry) => repairStatuses.has(entry.status))
    .map((entry) => toRow(entry.result, entry.status));
  const failureCounts = {
    unsupportedSuccess: breakdown.unsupported_success ?? 0,
    supportPresentCountMissing: breakdown.support_present_count_missing ?? 0,
    evidenceZeroSuccessUnverified: breakdown.evidence_zero_success_unverified ?? 0,
    sourceCountMissing: breakdown.source_count_missing ?? 0,
    unclassified: breakdown.unclassified ?? 0
  };
  const report: EvidenceTelemetryProfile = {
    generatedAt: new Date().toISOString(),
    benchmark: "evidence_telemetry_profile",
    sourceArtifactPath: source.path,
    sourceStatus: source.report.status ?? "complete",
    passed: Object.values(failureCounts).every((count) => count === 0),
    breakdown,
    failureCounts,
    rowsNeedingRepair
  };
  const dir = locomoOutputDir(import.meta.url);
  await mkdir(dir, { recursive: true });
  const stamp = report.generatedAt.replace(/[:.]/gu, "-");
  const jsonPath = path.join(dir, `evidence-telemetry-profile-${stamp}.json`);
  const markdownPath = path.join(dir, `evidence-telemetry-profile-${stamp}.md`);
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, toMarkdown(report), "utf8");
  return { report, output: { jsonPath, markdownPath } };
}

export async function runEvidenceTelemetryProfileCli(): Promise<void> {
  const result = await runAndWriteEvidenceTelemetryProfile({ artifactPath: parseArtifactArg() });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.report.passed) {
    process.exitCode = 1;
  }
}
