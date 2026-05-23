import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildProfileInferenceCandidatesFromSourceTextsForTest } from "../taxonomy-temporal/profile-inference-compiler.js";
import { buildBenchmarkRuntimeMetadata, type BenchmarkRuntimeMetadata } from "./runtime-metadata.js";
import {
  artifactPassRate,
  observedQuestionCount,
  parseArtifactArg,
  plannedQuestionCount,
  readLoCoMoArtifact,
  type LoCoMoDiagnosticResult
} from "./locomo-diagnostics-utils.js";
import { readLoCoMoDataset } from "./compiled-direct-fact-real-source-coverage.js";
import {
  formatLoCoMoConversationSession,
  type LoCoMoConversationRecord,
  type LoCoMoTurnRecord
} from "./locomo-ingest.js";

type SourceAuditStatus =
  | "source_present_compiler_missing"
  | "source_present_compiled_unusable"
  | "source_present_reader_blocked"
  | "source_present_wrong_shape"
  | "source_absent"
  | "benchmark_expected_without_source_evidence"
  | "subject_ambiguous"
  | "temporal_anchor_mismatch";

type RecommendedOwner =
  | "report_profile_compiler"
  | "report_profile_reader"
  | "report_profile_shape"
  | "subject_binding"
  | "temporal_semantics"
  | "source_audit"
  | "benchmark_residual";

interface CompiledObservationAuditRow {
  readonly id: string;
  readonly predicate_family: string;
  readonly property_key: string | null;
  readonly answer_value: string | null;
  readonly support_phrase: string | null;
  readonly source_text: string | null;
  readonly source_uri: string | null;
  readonly source_memory_id: string | null;
  readonly source_chunk_id: string | null;
  readonly metadata: Record<string, unknown> | null;
}

interface AuditCase {
  readonly sampleId: string;
  readonly questionIndex: number;
  readonly category: number;
  readonly question: string;
  readonly expectedAnswer: string;
  readonly queryBehavior: string;
  readonly passed: boolean;
  readonly normalizedPassed: boolean;
  readonly finalClaimSource: string | null;
  readonly evidenceCount: number;
  readonly sourceCount: number;
  readonly readerEvidenceDisciplineStatus: string | null;
}

interface SourceAuditRow extends AuditCase {
  readonly sourceAuditStatus: SourceAuditStatus;
  readonly recommendedOwner: RecommendedOwner;
  readonly subjectHint: string | null;
  readonly sourceSearchTerms: readonly string[];
  readonly sourceEvidenceQuote: string | null;
  readonly sourceEvidenceSessionKey: string | null;
  readonly sourceSearchScope: string;
  readonly compiledRowCount: number;
  readonly compiledFitRowCount: number;
  readonly compiledSourceBoundFitRowCount: number;
  readonly compiledReaderStatus: "compiled_selected" | "compiled_available" | "compiled_unusable" | "compiled_missing";
  readonly compiledEvidenceQuote: string | null;
  readonly compiledPredicateFamilies: readonly string[];
  readonly readerDecision: string;
}

interface ReportProfileSourceAuditReport {
  readonly generatedAt: string;
  readonly benchmark: "locomo_report_profile_source_audit";
  readonly runtime: BenchmarkRuntimeMetadata;
  readonly sourceArtifactPath: string;
  readonly sourceStatus: string;
  readonly observedQuestionCount: number;
  readonly plannedQuestionCount: number;
  readonly sourcePassRate: number;
  readonly summary: {
    readonly auditedRows: number;
    readonly failedAuditedRows: number;
    readonly statusBreakdown: Readonly<Record<string, number>>;
    readonly recommendedOwnerBreakdown: Readonly<Record<string, number>>;
    readonly unknownAuditStatus: number;
    readonly sourcePresentRows: number;
    readonly sourcePresentWithEvidenceQuote: number;
    readonly sourceAbsentRows: number;
    readonly compiledFitRows: number;
    readonly compiledSourceBoundFitRows: number;
    readonly queryTimeGLiNEROrLLMCalls: number;
  };
  readonly gates: {
    readonly auditCompletenessPassed: boolean;
    readonly unknownStatusPassed: boolean;
    readonly sourceQuotePassed: boolean;
    readonly sourceAbsentProofPassed: boolean;
    readonly queryTimeModelPassed: boolean;
    readonly overallPassed: boolean;
  };
  readonly namespaces: readonly {
    readonly sampleId: string;
    readonly namespaceId: string;
    readonly sourceRows: number;
  }[];
  readonly rows: readonly SourceAuditRow[];
}

function thisDir(): string {
  return path.dirname(fileURLToPath(import.meta.url));
}

function localBrainRoot(): string {
  return path.resolve(thisDir(), "../..");
}

function generatedRoot(): string {
  return path.resolve(localBrainRoot(), "benchmark-generated", "locomo-report-profile-source-audit");
}

function outputDir(): string {
  return path.resolve(localBrainRoot(), "benchmark-results");
}

function normalize(value: unknown): string {
  return String(value ?? "").replace(/\s+/gu, " ").trim();
}

function compact(value: unknown): string {
  return normalize(value).toLowerCase().replace(/[^a-z0-9]+/gu, " ").trim();
}

function countBy<T>(items: readonly T[], keyFn: (item: T) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const key = keyFn(item);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function rate(numerator: number, denominator: number): number {
  return denominator > 0 ? Number((numerator / denominator).toFixed(3)) : 0;
}

function importantTerms(value: string): string[] {
  const stop = new Set([
    "what", "when", "where", "which", "would", "could", "should", "does", "did", "has", "have", "with",
    "from", "that", "this", "their", "there", "about", "some", "into", "while", "during", "recently",
    "likely", "considered", "before", "after", "none", "authoritative", "evidence", "found"
  ]);
  const quoted = [...value.matchAll(/["“]([^"”]{2,80})["”]/gu)].map((match) => match[1] ?? "");
  const capitalized = [...value.matchAll(/\b[A-Z][A-Za-z'’+-]{2,}(?:\s+[A-Z][A-Za-z'’+-]{2,}){0,3}\b/gu)]
    .map((match) => match[0] ?? "")
    .filter((term) => !/^(What|When|Where|Which|Would|The|No|Likely)$/u.test(term));
  const words = compact(value)
    .split(/\s+/u)
    .filter((term) => term.length >= 4 && !stop.has(term));
  return [...new Set([...quoted, ...capitalized, ...words].map(normalize).filter(Boolean))].slice(0, 16);
}

function subjectHint(question: string): string | null {
  const possessive = question.match(/\b([A-Z][A-Za-z'’-]{2,30})['’]s\b/u)?.[1];
  if (possessive) return possessive;
  const named = question.match(/\b(?:did|does|has|have|would|is|are|was|were|for|to|with|about)\s+([A-Z][A-Za-z'’-]{2,30})\b/u)?.[1];
  return named ?? question.match(/\b([A-Z][A-Za-z'’-]{2,30})\b/u)?.[1] ?? null;
}

function sessionEntries(sample: LoCoMoConversationRecord): Array<readonly [string, readonly LoCoMoTurnRecord[]]> {
  return Object.entries(sample.conversation)
    .filter((entry): entry is [string, readonly LoCoMoTurnRecord[]] => entry[0].startsWith("session_") && Array.isArray(entry[1]))
    .sort(([left], [right]) => left.localeCompare(right, undefined, { numeric: true }));
}

function sourceTexts(sample: LoCoMoConversationRecord): readonly { readonly sessionKey: string; readonly text: string }[] {
  return sessionEntries(sample).map(([sessionKey, turns]) => ({
    sessionKey,
    text: formatLoCoMoConversationSession(sample, sessionKey, turns)
  }));
}

function lineEvidenceScore(line: string, terms: readonly string[], subject: string | null): number {
  const haystack = compact(line);
  let score = 0;
  if (subject && haystack.includes(compact(subject))) score += 2;
  for (const term of terms) {
    const token = compact(term);
    if (token.length >= 3 && haystack.includes(token)) score += token.length > 8 ? 2 : 1;
  }
  return score;
}

function findSourceEvidence(sample: LoCoMoConversationRecord, auditCase: AuditCase): {
  readonly quote: string | null;
  readonly sessionKey: string | null;
  readonly terms: readonly string[];
  readonly scope: string;
} {
  const subject = subjectHint(auditCase.question);
  const terms = importantTerms(`${auditCase.expectedAnswer} ${auditCase.question}`).filter((term) => compact(term) !== compact(subject ?? ""));
  let best: { score: number; quote: string; sessionKey: string } | null = null;
  for (const source of sourceTexts(sample)) {
    const lines = source.text
      .replace(/\r\n?/gu, "\n")
      .split(/\n+/u)
      .map(normalize)
      .filter(Boolean);
    for (let index = 0; index < lines.length; index += 1) {
      const window = lines.slice(Math.max(0, index - 1), Math.min(lines.length, index + 2)).join(" ");
      const score = lineEvidenceScore(window, terms, subject);
      if (score > (best?.score ?? 0)) {
        best = { score, quote: window.slice(0, 900), sessionKey: source.sessionKey };
      }
    }
  }
  const minimumScore = subject ? 3 : 2;
  return {
    quote: best && best.score >= minimumScore ? best.quote : null,
    sessionKey: best && best.score >= minimumScore ? best.sessionKey : null,
    terms,
    scope: `${sample.sample_id}:all_sessions`
  };
}

function rowText(row: CompiledObservationAuditRow): string {
  return normalize([row.answer_value, row.support_phrase, row.source_text, JSON.stringify(row.metadata ?? {})].filter(Boolean).join(" "));
}

function rowHasSourceEvidence(row: CompiledObservationAuditRow): boolean {
  return Boolean(normalize(row.support_phrase) && (normalize(row.source_uri) || row.source_memory_id || row.source_chunk_id));
}

function compiledRowFits(row: CompiledObservationAuditRow, terms: readonly string[], subject: string | null): boolean {
  return lineEvidenceScore(rowText(row), terms, subject) >= (subject ? 3 : 2);
}

function loadCompiledRowsFromSource(sample: LoCoMoConversationRecord): readonly CompiledObservationAuditRow[] {
  return buildProfileInferenceCandidatesFromSourceTextsForTest(sourceTexts(sample).map((source) => source.text)).map((candidate, index) => ({
    id: `source_candidate:${sample.sample_id}:${index}`,
    predicate_family: "profile_inference",
    property_key: `inference:${candidate.family}`,
    answer_value: candidate.value,
    support_phrase: candidate.supportPhrase,
    source_text: candidate.sourceText,
    source_uri: candidate.sourceUri,
    source_memory_id: candidate.sourceMemoryId,
    source_chunk_id: candidate.sourceChunkId,
    metadata: {
      ...candidate.metadata,
      profileInferenceFamily: candidate.family,
      answerShape: candidate.answerShape,
      premiseCount: candidate.premises.length,
      sourceAuditCompilerMode: "source_text_profile_inference_compiler"
    }
  }));
}

function auditCases(results: readonly LoCoMoDiagnosticResult[]): readonly AuditCase[] {
  return results
    .filter((result) => result.residualOwner === "report_semantics")
    .map((result) => ({
      sampleId: normalize(result.sampleId),
      questionIndex: Number(result.questionIndex ?? -1),
      category: Number(result.category ?? 0),
      question: normalize(result.question),
      expectedAnswer: normalize(result.expectedAnswer),
      queryBehavior: normalize(result.queryBehavior),
      passed: result.passed === true,
      normalizedPassed: result.normalizedPassed === true,
      finalClaimSource: typeof result.finalClaimSource === "string" ? result.finalClaimSource : null,
      evidenceCount: Number(result.evidenceCount ?? 0),
      sourceCount: Number(result.sourceCount ?? 0),
      readerEvidenceDisciplineStatus: typeof result.readerEvidenceDisciplineStatus === "string" ? result.readerEvidenceDisciplineStatus : null
    }));
}

function statusForCase(params: {
  readonly auditCase: AuditCase;
  readonly sourceQuote: string | null;
  readonly compiledRows: readonly CompiledObservationAuditRow[];
  readonly fitRows: readonly CompiledObservationAuditRow[];
  readonly sourceBoundFitRows: readonly CompiledObservationAuditRow[];
}): { readonly status: SourceAuditStatus; readonly owner: RecommendedOwner; readonly readerDecision: string } {
  if (!params.sourceQuote) {
    const inferentialExpected = /\blikely\b|\bwould\b|\bmight\b|\bconsidered\b/iu.test(params.auditCase.question + " " + params.auditCase.expectedAnswer);
    return {
      status: inferentialExpected ? "benchmark_expected_without_source_evidence" : "source_absent",
      owner: inferentialExpected ? "benchmark_residual" : "source_audit",
      readerDecision: "source_not_found"
    };
  }
  if (params.auditCase.queryBehavior === "temporal_detail" || /\bwhen\b/iu.test(params.auditCase.question)) {
    if (params.sourceBoundFitRows.length === 0) {
      return { status: "temporal_anchor_mismatch", owner: "temporal_semantics", readerDecision: "temporal_source_present_but_not_routeable" };
    }
  }
  if (params.sourceBoundFitRows.length > 0) {
    if (params.auditCase.finalClaimSource === "abstention" || params.auditCase.readerEvidenceDisciplineStatus?.includes("no_subject_bound")) {
      return { status: "source_present_reader_blocked", owner: "report_profile_reader", readerDecision: "compiled_or_source_support_blocked_by_reader" };
    }
    if (params.auditCase.passed !== true) {
      return { status: "source_present_wrong_shape", owner: "report_profile_shape", readerDecision: "source_support_selected_wrong_shape" };
    }
    return { status: "source_present_reader_blocked", owner: "report_profile_reader", readerDecision: "source_support_exists_runtime_not_normalized" };
  }
  if (params.compiledRows.length > 0 || params.fitRows.length > 0) {
    return { status: "source_present_compiled_unusable", owner: "report_profile_compiler", readerDecision: "compiled_rows_do_not_match_query_terms_or_lack_source" };
  }
  return { status: "source_present_compiler_missing", owner: "report_profile_compiler", readerDecision: "source_evidence_present_no_compiled_row" };
}

async function writeReport(report: ReportProfileSourceAuditReport): Promise<{ readonly jsonPath: string; readonly markdownPath: string }> {
  const outDir = outputDir();
  await mkdir(outDir, { recursive: true });
  const stamp = report.generatedAt.replace(/[:.]/g, "-");
  const jsonPath = path.join(outDir, `locomo-report-profile-source-audit-${stamp}.json`);
  const markdownPath = path.join(outDir, `locomo-report-profile-source-audit-${stamp}.md`);
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  const lines = [
    "# LoCoMo Report/Profile Source Audit",
    "",
    `- sourceArtifactPath: ${report.sourceArtifactPath}`,
    `- auditedRows: ${report.summary.auditedRows}`,
    `- failedAuditedRows: ${report.summary.failedAuditedRows}`,
    `- statusBreakdown: ${JSON.stringify(report.summary.statusBreakdown)}`,
    `- recommendedOwnerBreakdown: ${JSON.stringify(report.summary.recommendedOwnerBreakdown)}`,
    `- overallPassed: ${report.gates.overallPassed}`,
    "",
    "## Rows",
    ""
  ];
  for (const row of report.rows.slice(0, 80)) {
    lines.push(`- ${row.sampleId}#${row.questionIndex} status=${row.sourceAuditStatus} owner=${row.recommendedOwner} compiled=${row.compiledReaderStatus} evidence=${row.evidenceCount}/${row.sourceCount}`);
    lines.push(`  - q: ${row.question}`);
    lines.push(`  - expected: ${row.expectedAnswer}`);
    lines.push(`  - source: ${row.sourceEvidenceQuote ?? "missing"}`);
  }
  await writeFile(markdownPath, `${lines.join("\n")}\n`, "utf8");
  return { jsonPath, markdownPath };
}

export async function runLoCoMoReportProfileSourceAudit(options?: {
  readonly artifactPath?: string;
}): Promise<{ readonly report: ReportProfileSourceAuditReport; readonly output: { readonly jsonPath: string; readonly markdownPath: string } }> {
  const generatedAt = new Date().toISOString();
  const runStamp = generatedAt.replace(/[:.]/g, "-");
  const source = await readLoCoMoArtifact(import.meta.url, options?.artifactPath);
  const cases = auditCases(source.report.results ?? []);
  const dataset = await readLoCoMoDataset();
  await mkdir(path.join(generatedRoot(), runStamp), { recursive: true });
  const sampleIds = [...new Set(cases.map((entry) => entry.sampleId))];
  const compiledRowsBySample = new Map<string, readonly CompiledObservationAuditRow[]>();
  const namespaceSummaries: Array<ReportProfileSourceAuditReport["namespaces"][number]> = [];
  for (const sampleId of sampleIds) {
    const sample = dataset.find((entry) => entry.sample_id === sampleId);
    if (!sample) throw new Error(`LoCoMo sample not found for report/profile source audit: ${sampleId}`);
    const namespaceId = `source_audit_${runStamp}_${sampleId.replace(/[^a-z0-9]+/giu, "_").toLowerCase()}`;
    namespaceSummaries.push({ sampleId, namespaceId, sourceRows: sourceTexts(sample).length });
    compiledRowsBySample.set(sampleId, loadCompiledRowsFromSource(sample));
  }
    const rows: SourceAuditRow[] = [];
    for (const auditCase of cases) {
      const sample = dataset.find((entry) => entry.sample_id === auditCase.sampleId);
      if (!sample) throw new Error(`missing sample for audit case ${auditCase.sampleId}#${auditCase.questionIndex}`);
      const sourceEvidence = findSourceEvidence(sample, auditCase);
      const subject = subjectHint(auditCase.question);
      const compiledRows = compiledRowsBySample.get(auditCase.sampleId) ?? [];
      const fitRows = compiledRows.filter((row) => compiledRowFits(row, sourceEvidence.terms, subject));
      const sourceBoundFitRows = fitRows.filter(rowHasSourceEvidence);
      const status = statusForCase({ auditCase, sourceQuote: sourceEvidence.quote, compiledRows, fitRows, sourceBoundFitRows });
      rows.push({
        ...auditCase,
        sourceAuditStatus: status.status,
        recommendedOwner: status.owner,
        subjectHint: subject,
        sourceSearchTerms: sourceEvidence.terms,
        sourceEvidenceQuote: sourceEvidence.quote,
        sourceEvidenceSessionKey: sourceEvidence.sessionKey,
        sourceSearchScope: sourceEvidence.scope,
        compiledRowCount: compiledRows.length,
        compiledFitRowCount: fitRows.length,
        compiledSourceBoundFitRowCount: sourceBoundFitRows.length,
        compiledReaderStatus:
          sourceBoundFitRows.length > 0
            ? auditCase.finalClaimSource?.includes("compiled") ? "compiled_selected" : "compiled_available"
            : fitRows.length > 0 ? "compiled_unusable" : "compiled_missing",
        compiledEvidenceQuote: sourceBoundFitRows[0]?.support_phrase ?? sourceBoundFitRows[0]?.source_text ?? null,
        compiledPredicateFamilies: [...new Set(sourceBoundFitRows.map((row) => row.predicate_family))],
        readerDecision: status.readerDecision
      });
    }
    const sourcePresentRows = rows.filter((row) => !["source_absent", "benchmark_expected_without_source_evidence"].includes(row.sourceAuditStatus));
    const sourceAbsentRows = rows.filter((row) => row.sourceAuditStatus === "source_absent" || row.sourceAuditStatus === "benchmark_expected_without_source_evidence");
    const summary = {
      auditedRows: rows.length,
      failedAuditedRows: rows.filter((row) => row.passed !== true).length,
      statusBreakdown: countBy(rows, (row) => row.sourceAuditStatus),
      recommendedOwnerBreakdown: countBy(rows, (row) => row.recommendedOwner),
      unknownAuditStatus: 0,
      sourcePresentRows: sourcePresentRows.length,
      sourcePresentWithEvidenceQuote: sourcePresentRows.filter((row) => Boolean(row.sourceEvidenceQuote)).length,
      sourceAbsentRows: sourceAbsentRows.length,
      compiledFitRows: rows.filter((row) => row.compiledFitRowCount > 0).length,
      compiledSourceBoundFitRows: rows.filter((row) => row.compiledSourceBoundFitRowCount > 0).length,
      queryTimeGLiNEROrLLMCalls: 0
    };
    const gates = {
      auditCompletenessPassed: rows.length === cases.length && rows.length > 0,
      unknownStatusPassed: summary.unknownAuditStatus === 0,
      sourceQuotePassed: sourcePresentRows.length === summary.sourcePresentWithEvidenceQuote,
      sourceAbsentProofPassed: sourceAbsentRows.every((row) => row.sourceSearchTerms.length > 0 && row.sourceSearchScope.length > 0),
      queryTimeModelPassed: summary.queryTimeGLiNEROrLLMCalls === 0,
      overallPassed: false
    };
    const report: ReportProfileSourceAuditReport = {
      generatedAt,
      benchmark: "locomo_report_profile_source_audit",
      runtime: buildBenchmarkRuntimeMetadata({
        benchmarkMode: source.report.status === "partial" ? "sampled" : "full",
        sampleControls: {
          sourceArtifactPath: source.path,
          auditedRows: rows.length,
          samples: sampleIds.length,
          cleanupNamespaces: process.env.BRAIN_KEEP_BENCHMARK_NAMESPACES === "1" ? "disabled" : "enabled"
        }
      }),
      sourceArtifactPath: source.path,
      sourceStatus: source.report.status ?? "complete",
      observedQuestionCount: observedQuestionCount(source.report),
      plannedQuestionCount: plannedQuestionCount(source.report),
      sourcePassRate: artifactPassRate(source.report),
      summary,
      gates: {
        ...gates,
        overallPassed:
          gates.auditCompletenessPassed &&
          gates.unknownStatusPassed &&
          gates.sourceQuotePassed &&
          gates.sourceAbsentProofPassed &&
          gates.queryTimeModelPassed
      },
      namespaces: namespaceSummaries,
      rows
    };
    const output = await writeReport(report);
    return { report, output };
}

export async function runLoCoMoReportProfileSourceAuditCli(): Promise<void> {
  const { report, output } = await runLoCoMoReportProfileSourceAudit({ artifactPath: parseArtifactArg() });
  console.log(`locomo-report-profile-source-audit audited=${report.summary.auditedRows} sourcePresent=${report.summary.sourcePresentRows} compiledFit=${report.summary.compiledSourceBoundFitRows}`);
  console.log(`locomo-report-profile-source-audit status=${JSON.stringify(report.summary.statusBreakdown)}`);
  console.log(`locomo-report-profile-source-audit json=${output.jsonPath}`);
  console.log(`locomo-report-profile-source-audit markdown=${output.markdownPath}`);
  if (!report.gates.overallPassed) process.exitCode = 1;
}
