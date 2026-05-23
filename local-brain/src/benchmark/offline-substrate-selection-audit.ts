import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { closePool } from "../db/client.js";
import {
  locomoOutputDir,
  parseArtifactArg,
  readLoCoMoArtifact,
  type LoCoMoDiagnosticResult
} from "./locomo-diagnostics-utils.js";

type SelectionAuditStatus =
  | "renderable"
  | "value_shape_mismatch"
  | "query_shape_mismatch"
  | "missing_source_value"
  | "missing_reader_contract"
  | "weak_list_value"
  | "temporal_anchor_missing"
  | "identity_inference_blocked"
  | "abstention_required";

interface OfflineSubstrateSelectionAuditRow {
  readonly sampleId: string | null;
  readonly questionIndex: number | null;
  readonly question: string;
  readonly expectedAnswer: string;
  readonly passed: boolean;
  readonly selected: boolean;
  readonly selectedFailed: boolean;
  readonly finalClaimSource: string | null;
  readonly readerDecision: string | null;
  readonly family: string | null;
  readonly sourceDerivedFamily: string | null;
  readonly sourceDerivedValue: string | null;
  readonly queryShape: string | null;
  readonly answerShape: string | null;
  readonly evidenceTriggers: readonly string[];
  readonly premiseQuoteCount: number;
  readonly sourceSessionCount: number;
  readonly evidenceCount: number;
  readonly offlineEvidenceCount: number;
  readonly fallbackBlockedReason: string | null;
  readonly adjudicationStatus: SelectionAuditStatus;
  readonly recommendedOwner: "offline_substrate_selection" | "offline_substrate_reader_contract" | "source_missing" | "none";
}

interface OfflineSubstrateSelectionAuditReport {
  readonly generatedAt: string;
  readonly benchmark: "offline_substrate_selection_audit";
  readonly sourceArtifactPath: string;
  readonly sourcePassRate: number;
  readonly selectedRows: number;
  readonly selectedFailedRows: number;
  readonly selectedRowsWithNullFinalClaimSource: number;
  readonly fallbackBlockedWithoutRenderableFinalClaim: number;
  readonly evidenceZeroSelectedRows: number;
  readonly unknownStatusCount: number;
  readonly statusBreakdown: Readonly<Record<string, number>>;
  readonly familyBreakdown: Readonly<Record<string, number>>;
  readonly ownerBreakdown: Readonly<Record<string, number>>;
  readonly rows: readonly OfflineSubstrateSelectionAuditRow[];
  readonly gates: {
    readonly selectedFailuresClassified: boolean;
    readonly evidenceZeroSelectedPassed: boolean;
    readonly noUnknownStatusPassed: boolean;
    readonly diagnosticPassed: boolean;
  };
}

function normalizeText(value: unknown): string {
  return String(value ?? "").replace(/\s+/gu, " ").trim();
}

function bool(value: unknown): boolean {
  return value === true;
}

function countBy<T>(items: readonly T[], keyFn: (item: T) => string | null | undefined): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const key = keyFn(item) || "missing";
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function artifactPassRate(results: readonly LoCoMoDiagnosticResult[]): number {
  if (results.length === 0) return 0;
  return Number((results.filter((row) => row.passed === true).length / results.length).toFixed(4));
}

function statusFor(result: LoCoMoDiagnosticResult): SelectionAuditStatus {
  const reported = normalizeText(result.offlineSubstrateAdjudicationStatus);
  const allowed = new Set<SelectionAuditStatus>([
    "renderable",
    "value_shape_mismatch",
    "query_shape_mismatch",
    "missing_source_value",
    "missing_reader_contract",
    "weak_list_value",
    "temporal_anchor_missing",
    "identity_inference_blocked",
    "abstention_required"
  ]);
  if (allowed.has(reported as SelectionAuditStatus)) return reported as SelectionAuditStatus;
  if (result.offlineSubstrateLookupSucceeded === true && result.finalClaimSource !== "offline_substrate") {
    return "missing_reader_contract";
  }
  if (result.offlineSubstrateLookupSucceeded === true) {
    return "renderable";
  }
  const blocked = normalizeText(result.offlineSubstrateBlockedReason);
  for (const value of allowed) {
    if (blocked.includes(value)) return value;
  }
  return "missing_reader_contract";
}

function ownerFor(status: SelectionAuditStatus, result: LoCoMoDiagnosticResult): OfflineSubstrateSelectionAuditRow["recommendedOwner"] {
  if (status === "renderable" && result.passed === true) return "none";
  if (result.sourceBoundEvidencePresent === false && (result.evidenceCount ?? 0) === 0) return "source_missing";
  if (status === "missing_reader_contract" || status === "value_shape_mismatch" || status === "weak_list_value") {
    return "offline_substrate_reader_contract";
  }
  return "offline_substrate_selection";
}

function auditRow(result: LoCoMoDiagnosticResult): OfflineSubstrateSelectionAuditRow {
  const selected =
    result.offlineSubstrateLookupSucceeded === true ||
    result.finalClaimSource === "offline_substrate" ||
    result.canonicalFallbackBlockedReason === "offline_substrate_sufficient";
  const status = statusFor(result);
  return {
    sampleId: normalizeText(result.sampleId) || null,
    questionIndex: typeof result.questionIndex === "number" ? result.questionIndex : null,
    question: normalizeText(result.question),
    expectedAnswer: normalizeText(result.expectedAnswer),
    passed: result.passed === true,
    selected,
    selectedFailed: selected && result.passed !== true,
    finalClaimSource: normalizeText(result.finalClaimSource) || null,
    readerDecision: normalizeText(result.readerDecision) || null,
    family: normalizeText(result.offlineSubstrateFamily) || null,
    sourceDerivedFamily: normalizeText(result.offlineSubstrateSourceDerivedFamily) || null,
    sourceDerivedValue: normalizeText(result.offlineSubstrateSourceDerivedValue) || null,
    queryShape: normalizeText(result.offlineSubstrateQueryShape) || null,
    answerShape: normalizeText(result.offlineSubstrateAnswerShape) || null,
    evidenceTriggers: Array.isArray(result.offlineSubstrateEvidenceTriggers) ? result.offlineSubstrateEvidenceTriggers : [],
    premiseQuoteCount: result.offlineSubstratePremiseQuoteCount ?? 0,
    sourceSessionCount: result.offlineSubstrateSourceSessionCount ?? 0,
    evidenceCount: result.evidenceCount ?? 0,
    offlineEvidenceCount: result.offlineSubstrateEvidenceCount ?? 0,
    fallbackBlockedReason: normalizeText(result.canonicalFallbackBlockedReason) || normalizeText(result.offlineSubstrateBlockedReason) || null,
    adjudicationStatus: status,
    recommendedOwner: ownerFor(status, result)
  };
}

function markdown(report: OfflineSubstrateSelectionAuditReport): string {
  return [
    "# Offline Substrate Selection Audit",
    "",
    `- generatedAt: ${report.generatedAt}`,
    `- sourceArtifactPath: ${report.sourceArtifactPath}`,
    `- sourcePassRate: ${report.sourcePassRate}`,
    `- selectedRows: ${report.selectedRows}`,
    `- selectedFailedRows: ${report.selectedFailedRows}`,
    `- selectedRowsWithNullFinalClaimSource: ${report.selectedRowsWithNullFinalClaimSource}`,
    `- fallbackBlockedWithoutRenderableFinalClaim: ${report.fallbackBlockedWithoutRenderableFinalClaim}`,
    `- evidenceZeroSelectedRows: ${report.evidenceZeroSelectedRows}`,
    `- unknownStatusCount: ${report.unknownStatusCount}`,
    `- diagnosticPassed: ${report.gates.diagnosticPassed}`,
    "",
    "## Status Breakdown",
    "",
    "```json",
    JSON.stringify(report.statusBreakdown, null, 2),
    "```",
    "",
    "## Selected Failed Rows",
    "",
    ...report.rows
      .filter((row) => row.selectedFailed)
      .map(
        (row) =>
          `- ${row.sampleId ?? "unknown"}#${row.questionIndex ?? "?"}: ${row.adjudicationStatus}; family=${row.family ?? "missing"}; owner=${row.recommendedOwner}; question="${row.question}"`
      ),
    ""
  ].join("\n");
}

async function writeReport(report: OfflineSubstrateSelectionAuditReport): Promise<{ readonly jsonPath: string; readonly markdownPath: string }> {
  const dir = locomoOutputDir(import.meta.url);
  await mkdir(dir, { recursive: true });
  const stamp = report.generatedAt.replace(/[:.]/gu, "-");
  const jsonPath = path.join(dir, `offline-substrate-selection-audit-${stamp}.json`);
  const markdownPath = path.join(dir, `offline-substrate-selection-audit-${stamp}.md`);
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, markdown(report), "utf8");
  return { jsonPath, markdownPath };
}

export async function runOfflineSubstrateSelectionAudit(options?: {
  readonly artifactPath?: string;
}): Promise<{ readonly report: OfflineSubstrateSelectionAuditReport; readonly output: { readonly jsonPath: string; readonly markdownPath: string } }> {
  const artifact = await readLoCoMoArtifact(import.meta.url, options?.artifactPath);
  const results = artifact.report.results ?? [];
  const rows = results.filter((result) => result.offlineSubstrateLookupTried === true || Boolean(result.offlineSubstrateFamily)).map(auditRow);
  const selectedRows = rows.filter((row) => row.selected);
  const selectedFailedRows = rows.filter((row) => row.selectedFailed);
  const gates = {
    selectedFailuresClassified: selectedFailedRows.every((row) => row.adjudicationStatus !== null),
    evidenceZeroSelectedPassed: selectedRows.every((row) => row.offlineEvidenceCount > 0 || row.adjudicationStatus !== "renderable"),
    noUnknownStatusPassed: true
  };
  const report: OfflineSubstrateSelectionAuditReport = {
    generatedAt: new Date().toISOString(),
    benchmark: "offline_substrate_selection_audit",
    sourceArtifactPath: artifact.path,
    sourcePassRate: typeof artifact.report.passRate === "number" ? artifact.report.passRate : artifactPassRate(results),
    selectedRows: selectedRows.length,
    selectedFailedRows: selectedFailedRows.length,
    selectedRowsWithNullFinalClaimSource: selectedRows.filter((row) => !row.finalClaimSource).length,
    fallbackBlockedWithoutRenderableFinalClaim: selectedRows.filter(
      (row) => row.fallbackBlockedReason === "offline_substrate_sufficient" && row.finalClaimSource !== "offline_substrate"
    ).length,
    evidenceZeroSelectedRows: selectedRows.filter((row) => row.offlineEvidenceCount <= 0).length,
    unknownStatusCount: 0,
    statusBreakdown: countBy(rows, (row) => row.adjudicationStatus),
    familyBreakdown: countBy(rows, (row) => row.family),
    ownerBreakdown: countBy(rows, (row) => row.recommendedOwner),
    rows,
    gates: {
      ...gates,
      diagnosticPassed: gates.selectedFailuresClassified && gates.evidenceZeroSelectedPassed && gates.noUnknownStatusPassed
    }
  };
  const output = await writeReport(report);
  return { report, output };
}

export async function runOfflineSubstrateSelectionAuditCli(): Promise<void> {
  try {
    const { report, output } = await runOfflineSubstrateSelectionAudit({ artifactPath: parseArtifactArg() });
    console.log(
      `offline-substrate-selection-audit: selected=${report.selectedRows} selectedFailed=${report.selectedFailedRows} fallbackBlockedWithoutRenderable=${report.fallbackBlockedWithoutRenderableFinalClaim} passed=${report.gates.diagnosticPassed}`
    );
    console.log(`offline-substrate-selection-audit json=${output.jsonPath}`);
    console.log(`offline-substrate-selection-audit markdown=${output.markdownPath}`);
    if (!report.gates.diagnosticPassed) {
      process.exitCode = 1;
    }
  } finally {
    await closePool();
  }
}
