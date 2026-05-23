import { access, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface LoCoMoDiagnosticResult {
  readonly sampleId?: string;
  readonly questionIndex?: number;
  readonly category?: number;
  readonly question?: string;
  readonly expectedAnswer?: string;
  readonly answerSnippet?: string;
  readonly passed?: boolean;
  readonly normalizedPassed?: boolean;
  readonly failureClass?: string;
  readonly queryBehavior?: string;
  readonly finalClaimSource?: string | null;
  readonly renderContract?: string | null;
  readonly readerDecision?: string | null;
  readonly shapingDiagnosis?: string | null;
  readonly residualOwner?: string | null;
  readonly rawEvidenceCount?: number;
  readonly rawSourceCount?: number;
  readonly sourceBoundSupportCount?: number;
  readonly evidenceCount?: number;
  readonly sourceCount?: number;
  readonly sufficiency?: string | null;
  readonly subjectMatch?: string | null;
  readonly dominantStage?: string | null;
  readonly stageTimingsMs?: Readonly<Record<string, number>> | null;
  readonly topStageMs?: number | null;
  readonly latencyBudgetFamily?: string | null;
  readonly routeBudgetEnforced?: boolean;
  readonly routeBudgetExceededStages?: readonly string[];
  readonly routeBudgetDecision?: string | null;
  readonly plannerTargetedBackfillSubqueryLimit?: number | null;
  readonly sourceBoundEvidenceRequired?: boolean;
  readonly sourceBoundEvidencePresent?: boolean;
  readonly readerEvidenceDisciplineStatus?: string | null;
  readonly canonicalFallbackBlockedReason?: string | null;
  readonly compiledDirectFactLookupTried?: boolean;
  readonly compiledDirectFactLookupSucceeded?: boolean;
  readonly directFactFamily?: string | null;
  readonly compiledDirectFactCoverageStatus?: string | null;
  readonly compiledProfileInferenceLookupTried?: boolean;
  readonly compiledProfileInferenceLookupSucceeded?: boolean;
  readonly profileInferenceFamily?: string | null;
  readonly premiseCoverageStatus?: string | null;
  readonly sourceBoundFallbackUsed?: boolean;
  readonly queryTimeExtractorUsed?: boolean;
  readonly queryTimeGLiNEROrLLMUsed?: boolean;
  readonly offlineSubstrateLookupTried?: boolean;
  readonly offlineSubstrateLookupSucceeded?: boolean;
  readonly offlineSubstrateSelectedRowId?: string | null;
  readonly offlineSubstrateFamily?: string | null;
  readonly offlineSubstrateSourceDerivedFamily?: string | null;
  readonly offlineSubstrateSourceDerivedValue?: string | null;
  readonly offlineSubstrateQueryShape?: string | null;
  readonly offlineSubstrateAnswerShape?: string | null;
  readonly offlineSubstrateEvidenceTriggers?: readonly string[];
  readonly offlineSubstratePremiseQuoteCount?: number;
  readonly offlineSubstrateSourceSessionCount?: number;
  readonly offlineSubstrateAdjudicationStatus?: string | null;
  readonly offlineSubstrateRowsScanned?: number;
  readonly offlineSubstrateEvidenceCount?: number;
  readonly offlineSubstrateBlockedReason?: string | null;
  readonly offlineSubstrateDiagnosticOnly?: boolean;
  readonly latencyMs?: number;
}

export interface LoCoMoDiagnosticArtifact {
  readonly generatedAt?: string;
  readonly dataset?: string;
  readonly status?: "partial" | string;
  readonly sampleCount?: number;
  readonly passRate?: number;
  readonly latency?: {
    readonly p50Ms?: number;
    readonly p95Ms?: number;
    readonly maxMs?: number;
  };
  readonly progress?: {
    readonly runStamp?: string;
    readonly totalQuestionsPlanned?: number;
    readonly completedQuestions?: number;
    readonly lastProgressAt?: string;
  };
  readonly diagnostics?: {
    readonly residualOwnerBreakdown?: Record<string, number>;
    readonly unsupportedNoEvidenceSuccessCount?: number;
  };
  readonly results?: readonly LoCoMoDiagnosticResult[];
  readonly failureReason?: string;
}

export interface LoCoMoArtifactRef {
  readonly path: string;
  readonly report: LoCoMoDiagnosticArtifact;
}

export type EvidenceTelemetryStatus =
  | "counted"
  | "source_count_missing"
  | "support_present_count_missing"
  | "abstention_no_evidence_ok"
  | "unsupported_success"
  | "evidence_zero_success_unverified"
  | "failure_no_evidence"
  | "unclassified";

export type LoCoMoDiagnosticAction =
  | "inspect_reader_shape"
  | "inspect_route_budget"
  | "inspect_compiler_coverage"
  | "inspect_subject_binding"
  | "inspect_temporal_semantics"
  | "source_audit"
  | "inspect_harness_timeout"
  | "research_required";

export function benchmarkRootFromModule(metaUrl: string): string {
  return path.resolve(path.dirname(fileURLToPath(metaUrl)), "../..");
}

export function locomoOutputDir(metaUrl: string): string {
  return path.resolve(benchmarkRootFromModule(metaUrl), "benchmark-results");
}

export function normalizeDiagnosticText(value: unknown): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, " ")
    .trim()
    .replace(/\s+/gu, " ");
}

export function countBy<T>(items: readonly T[], keyFn: (item: T) => string | null | undefined): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const key = keyFn(item) ?? "missing";
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

export function percentile(values: readonly number[], percentileRank: number): number {
  const finite = values.filter((value) => Number.isFinite(value)).sort((left, right) => left - right);
  if (finite.length === 0) {
    return 0;
  }
  const index = Math.min(finite.length - 1, Math.max(0, Math.ceil((percentileRank / 100) * finite.length) - 1));
  return Number(finite[index]!.toFixed(2));
}

export function observedQuestionCount(artifact: LoCoMoDiagnosticArtifact): number {
  return artifact.results?.length ?? 0;
}

export function plannedQuestionCount(artifact: LoCoMoDiagnosticArtifact): number {
  return artifact.progress?.totalQuestionsPlanned ?? artifact.sampleCount ?? observedQuestionCount(artifact);
}

export function artifactPassRate(artifact: LoCoMoDiagnosticArtifact): number {
  if (typeof artifact.passRate === "number" && Number.isFinite(artifact.passRate)) {
    return artifact.passRate;
  }
  const results = artifact.results ?? [];
  if (results.length === 0) {
    return 0;
  }
  return Number((results.filter((result) => result.passed === true).length / results.length).toFixed(4));
}

export function artifactNormalizedPassRate(artifact: LoCoMoDiagnosticArtifact): number {
  const results = artifact.results ?? [];
  if (results.length === 0) {
    return 0;
  }
  return Number((results.filter((result) => result.normalizedPassed === true).length / results.length).toFixed(4));
}

export function resultLatencyMs(result: LoCoMoDiagnosticResult): number {
  return typeof result.latencyMs === "number" && Number.isFinite(result.latencyMs) ? result.latencyMs : 0;
}

export function locomoRouteFamily(result: LoCoMoDiagnosticResult): string {
  if (result.compiledProfileInferenceLookupTried === true) {
    return "profile_inference";
  }
  if (typeof result.latencyBudgetFamily === "string" && result.latencyBudgetFamily.length > 0) {
    return result.latencyBudgetFamily;
  }
  if (typeof result.queryBehavior === "string" && result.queryBehavior.length > 0) {
    if (result.queryBehavior === "profile" || result.queryBehavior === "recap") {
      return "report_semantics";
    }
    return result.queryBehavior;
  }
  return "unknown";
}

export function isAbstentionLike(result: LoCoMoDiagnosticResult): boolean {
  const source = normalizeDiagnosticText(result.finalClaimSource);
  const answer = normalizeDiagnosticText(result.answerSnippet);
  return (
    source.includes("abstention") ||
    answer === "none" ||
    answer === "unknown" ||
    answer === "no answer" ||
    answer.includes("not enough evidence") ||
    answer.includes("no authoritative evidence")
  );
}

export function isExpectedNoAnswer(result: LoCoMoDiagnosticResult): boolean {
  const expected = normalizeDiagnosticText(result.expectedAnswer);
  return expected === "none" || expected === "unknown" || expected === "no answer";
}

export function isUnsupportedNoEvidenceSuccess(result: LoCoMoDiagnosticResult): boolean {
  return (
    result.passed === true &&
    result.sourceBoundEvidenceRequired === true &&
    result.sourceBoundEvidencePresent !== true &&
    !isAbstentionLike(result) &&
    !isExpectedNoAnswer(result)
  );
}

export function evidenceTelemetryStatus(result: LoCoMoDiagnosticResult): EvidenceTelemetryStatus {
  const evidenceCount = result.evidenceCount ?? 0;
  const sourceCount = result.sourceCount ?? 0;
  if (evidenceCount > 0 && sourceCount > 0) {
    return "counted";
  }
  if (evidenceCount > 0 && sourceCount === 0) {
    return "source_count_missing";
  }
  if (result.sourceBoundEvidencePresent === true && evidenceCount === 0) {
    return "support_present_count_missing";
  }
  if (result.passed === true && isAbstentionLike(result) && evidenceCount === 0) {
    return "abstention_no_evidence_ok";
  }
  if (isUnsupportedNoEvidenceSuccess(result)) {
    return "unsupported_success";
  }
  if (result.passed === true && evidenceCount === 0) {
    return "evidence_zero_success_unverified";
  }
  if (result.passed !== true && evidenceCount === 0) {
    return "failure_no_evidence";
  }
  return "unclassified";
}

export function isTimeoutLike(result: LoCoMoDiagnosticResult): boolean {
  return resultLatencyMs(result) >= 44_000 || result.dominantStage === "query_timeout" || result.failureClass === "query_timeout";
}

export function hasMissingSlowTelemetry(result: LoCoMoDiagnosticResult, thresholdMs = 10_000): boolean {
  return resultLatencyMs(result) > thresholdMs && (!result.dominantStage || !result.stageTimingsMs);
}

export async function readLoCoMoArtifact(metaUrl: string, artifactPath?: string): Promise<LoCoMoArtifactRef> {
  const resolvedPath = artifactPath
    ? await resolveArtifactPath(metaUrl, artifactPath)
    : await latestLoCoMoArtifactPath(metaUrl, { includePartial: false });
  return {
    path: resolvedPath,
    report: JSON.parse(await readFile(resolvedPath, "utf8")) as LoCoMoDiagnosticArtifact
  };
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await access(candidate);
    return true;
  } catch {
    return false;
  }
}

async function resolveArtifactPath(metaUrl: string, artifactPath: string): Promise<string> {
  if (path.isAbsolute(artifactPath)) {
    return artifactPath;
  }
  const localBrainRoot = benchmarkRootFromModule(metaUrl);
  const candidates = [
    path.resolve(process.cwd(), artifactPath),
    artifactPath.startsWith("local-brain/")
      ? path.resolve(localBrainRoot, artifactPath.slice("local-brain/".length))
      : path.resolve(localBrainRoot, artifactPath),
    path.resolve(localBrainRoot, "..", artifactPath)
  ];
  for (const candidate of candidates) {
    if (await pathExists(candidate)) {
      return candidate;
    }
  }
  return candidates[0]!;
}

export async function latestLoCoMoArtifactPath(
  metaUrl: string,
  options: { readonly includePartial: boolean }
): Promise<string> {
  const dir = locomoOutputDir(metaUrl);
  const files = (await readdir(dir))
    .filter((file) => {
      if (!/^locomo-\d{4}-\d{2}-\d{2}T.*(?:\.partial)?\.json$/u.test(file)) {
        return false;
      }
      if (!options.includePartial && file.endsWith(".partial.json")) {
        return false;
      }
      return true;
    })
    .sort();
  const latest = files.at(-1);
  if (!latest) {
    throw new Error(options.includePartial ? "No LoCoMo artifact found" : "No completed LoCoMo artifact found");
  }
  return path.join(dir, latest);
}

export function parseArtifactArg(argv = process.argv.slice(2)): string | undefined {
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--artifact") {
      return argv[index + 1];
    }
    if (value?.startsWith("--artifact=")) {
      return value.slice("--artifact=".length);
    }
  }
  return undefined;
}
