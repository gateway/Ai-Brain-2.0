import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  artifactNormalizedPassRate,
  artifactPassRate,
  countBy,
  evidenceTelemetryStatus,
  hasMissingSlowTelemetry,
  isTimeoutLike,
  isUnsupportedNoEvidenceSuccess,
  locomoRouteFamily,
  locomoOutputDir,
  type LoCoMoDiagnosticAction,
  observedQuestionCount,
  parseArtifactArg,
  percentile,
  plannedQuestionCount,
  readLoCoMoArtifact,
  resultLatencyMs
} from "./locomo-diagnostics-utils.js";

interface SlowRow {
  readonly sampleId: string;
  readonly questionIndex: number;
  readonly question: string;
  readonly latencyMs: number;
  readonly residualOwner: string;
  readonly queryBehavior: string;
  readonly dominantStage: string | null;
  readonly topStageMs: number | null;
  readonly latencyBudgetFamily: string | null;
  readonly evidenceTelemetryStatus: string;
}

interface ClusterStopReason {
  readonly reason: string;
  readonly owner?: string;
  readonly routeFamily?: string;
  readonly dominantStage?: string;
  readonly count?: number;
  readonly share?: number;
  readonly p95Ms?: number;
  readonly recommendation: LoCoMoDiagnosticAction;
}

interface LoCoMoScaleDiagnosticReport {
  readonly generatedAt: string;
  readonly benchmark: "locomo_scale_diagnostic";
  readonly sourceArtifactPath: string;
  readonly sourceGeneratedAt: string;
  readonly sourceStatus: string;
  readonly observedQuestionCount: number;
  readonly plannedQuestionCount: number;
  readonly completionRate: number;
  readonly projectedRuntimeMs: number | null;
  readonly passRate: number;
  readonly normalizedPassRate: number;
  readonly diagnosticIntegrityPassed: boolean;
  readonly thresholds: {
    readonly slowTelemetryThresholdMs: number;
    readonly timeoutLikeThresholdMs: number;
    readonly ownerClusterCount: number;
    readonly ownerClusterShare: number;
    readonly firstWindowQuestionCount: number;
    readonly firstWindowTimeoutLikeLimit: number;
    readonly p95TargetMs: number;
    readonly maxTargetMs: number;
  };
  readonly latency: {
    readonly p50Ms: number;
    readonly p95Ms: number;
    readonly maxMs: number;
    readonly timeoutLikeCount: number;
    readonly over10sCount: number;
    readonly missingTelemetryOver10sCount: number;
  };
  readonly evidenceTelemetry: {
    readonly breakdown: Readonly<Record<string, number>>;
    readonly unclassifiedCount: number;
    readonly supportPresentCountMissingCount: number;
    readonly unsupportedNoEvidenceSuccessCount: number;
    readonly evidenceZeroSuccessCount: number;
  };
  readonly routeUsage: {
    readonly ownerBreakdown: Readonly<Record<string, number>>;
    readonly queryBehaviorBreakdown: Readonly<Record<string, number>>;
    readonly dominantStageBreakdown: Readonly<Record<string, number>>;
    readonly finalClaimSourceBreakdown: Readonly<Record<string, number>>;
    readonly latencyBudgetFamilyBreakdown: Readonly<Record<string, number>>;
    readonly queryTimeGLiNEROrLLMCallCount: number;
  };
  readonly clusterStop: {
    readonly triggered: boolean;
    readonly reasons: readonly ClusterStopReason[];
  };
  readonly topSlowRows: readonly SlowRow[];
  readonly recommendedTracks: readonly string[];
  readonly failures: readonly string[];
}

function round(value: number): number {
  return Number(value.toFixed(4));
}

function ownerOf(result: { readonly passed?: boolean; readonly residualOwner?: string | null }): string {
  if (result.passed === true) {
    return "pass";
  }
  return result.residualOwner || "unknown";
}

function recommendationForOwner(owner: string): LoCoMoDiagnosticAction {
  switch (owner) {
    case "report_semantics":
      return "inspect_reader_shape";
    case "temporal_rendering":
      return "inspect_temporal_semantics";
    case "route_ranking":
      return "inspect_compiler_coverage";
    case "source_missing":
      return "source_audit";
    case "subject_binding":
      return "inspect_subject_binding";
    case "harness":
      return "inspect_harness_timeout";
    default:
      return "research_required";
  }
}

function routeRecommendation(routeFamily: string): LoCoMoDiagnosticAction {
  switch (routeFamily) {
    case "temporal_event":
    case "temporal_detail":
      return "inspect_temporal_semantics";
    case "profile_inference":
    case "report_semantics":
    case "broad_preference_profile":
    case "sparse_profile_inference":
      return "inspect_reader_shape";
    case "direct_fact":
    case "broad_direct_fact":
    case "bounded_event_detail":
    case "exact_detail_scalar":
      return "inspect_compiler_coverage";
    case "relationship":
    case "relationship_profile":
    case "support_network_reasoned":
      return "inspect_subject_binding";
    default:
      return "inspect_route_budget";
  }
}

function recommendedTracks(ownerBreakdown: Readonly<Record<string, number>>, timeoutLikeCount: number): readonly string[] {
  const tracks: string[] = [];
  if (timeoutLikeCount > 0) {
    tracks.push("inspect route budgets and harness timeout paths before another full run");
  }
  if ((ownerBreakdown.report_semantics ?? 0) > 0) {
    tracks.push("audit report/profile reader shape and source-bound canonical fallback eligibility");
  }
  if ((ownerBreakdown.temporal_rendering ?? 0) > 0) {
    tracks.push("audit temporal semantic compatibility and rendered granularity");
  }
  if ((ownerBreakdown.route_ranking ?? 0) > 0) {
    tracks.push("inspect compiled rows that exist but lose ranking or are blocked by query fit");
  }
  if ((ownerBreakdown.subject_binding ?? 0) > 0) {
    tracks.push("inspect alias/self/pair binding from source turns and compiled observations");
  }
  if ((ownerBreakdown.source_missing ?? 0) > 0) {
    tracks.push("run source coverage audit before compiler or retrieval changes");
  }
  return tracks;
}

function toMarkdown(report: LoCoMoScaleDiagnosticReport): string {
  const lines = [
    "# LoCoMo Scale Diagnostic",
    "",
    `- generatedAt: ${report.generatedAt}`,
    `- sourceArtifactPath: ${report.sourceArtifactPath}`,
    `- sourceStatus: ${report.sourceStatus}`,
    `- observedQuestionCount: ${report.observedQuestionCount}`,
    `- plannedQuestionCount: ${report.plannedQuestionCount}`,
    `- completionRate: ${report.completionRate}`,
    `- passRate: ${report.passRate}`,
    `- normalizedPassRate: ${report.normalizedPassRate}`,
    `- diagnosticIntegrityPassed: ${report.diagnosticIntegrityPassed}`,
    `- projectedRuntimeMs: ${report.projectedRuntimeMs ?? "n/a"}`,
    `- latency: ${JSON.stringify(report.latency)}`,
    `- ownerBreakdown: ${JSON.stringify(report.routeUsage.ownerBreakdown)}`,
    `- evidenceTelemetry: ${JSON.stringify(report.evidenceTelemetry)}`,
    "",
    "## Cluster Stop",
    "",
    `- triggered: ${report.clusterStop.triggered}`,
    ...report.clusterStop.reasons.map(
      (reason) =>
        `- ${reason.reason}${reason.owner ? ` owner=${reason.owner}` : ""}${reason.routeFamily ? ` routeFamily=${reason.routeFamily}` : ""}${reason.dominantStage ? ` dominantStage=${reason.dominantStage}` : ""}${typeof reason.count === "number" ? ` count=${reason.count}` : ""}${typeof reason.share === "number" ? ` share=${reason.share}` : ""}${typeof reason.p95Ms === "number" ? ` p95Ms=${reason.p95Ms}` : ""} recommendation=${reason.recommendation}`
    ),
    "",
    "## Recommended Tracks",
    "",
    ...report.recommendedTracks.map((track) => `- ${track}`),
    "",
    "## Top Slow Rows",
    "",
    ...report.topSlowRows.map(
      (row) =>
        `- ${row.sampleId}#${row.questionIndex} latency=${row.latencyMs} owner=${row.residualOwner} behavior=${row.queryBehavior} dominantStage=${row.dominantStage ?? "n/a"} telemetry=${row.evidenceTelemetryStatus} q=${row.question}`
    ),
    "",
    "## Failures",
    "",
    ...report.failures.map((failure) => `- ${failure}`)
  ];
  return `${lines.join("\n")}\n`;
}

export async function runAndWriteLoCoMoScaleDiagnostic(options?: {
  readonly artifactPath?: string;
}): Promise<{ readonly report: LoCoMoScaleDiagnosticReport; readonly output: { readonly jsonPath: string; readonly markdownPath: string } }> {
  const source = await readLoCoMoArtifact(import.meta.url, options?.artifactPath);
  const results = source.report.results ?? [];
  const observed = observedQuestionCount(source.report);
  const planned = plannedQuestionCount(source.report);
  const latencies = results.map(resultLatencyMs).filter((value) => value > 0);
  const totalObservedRuntimeMs = latencies.reduce((sum, value) => sum + value, 0);
  const projectedRuntimeMs = observed > 0 && planned > observed ? Math.round((totalObservedRuntimeMs / observed) * planned) : null;
  const failedResults = results.filter((result) => result.passed !== true);
  const ownerBreakdown = countBy(failedResults, ownerOf);
  const evidenceStatuses = results.map((result) => ({ result, status: evidenceTelemetryStatus(result) }));
  const evidenceTelemetryBreakdown = countBy(evidenceStatuses, (entry) => entry.status);
  const timeoutLikeCount = results.filter(isTimeoutLike).length;
  const missingTelemetryOver10sCount = results.filter((result) => hasMissingSlowTelemetry(result, 10_000)).length;
  const firstWindow = results.slice(0, 300);
  const firstWindowTimeoutLikeCount = firstWindow.filter(isTimeoutLike).length;
  const slowRowsOver10s = results.filter((result) => resultLatencyMs(result) > 10_000);
  const slowScenarioCount = Math.max(1, slowRowsOver10s.length);
  const ownerScenarioCount = Math.max(1, failedResults.length);
  const clusterReasons: ClusterStopReason[] = [];
  for (const [owner, count] of Object.entries(ownerBreakdown)) {
    const share = round(count / ownerScenarioCount);
    if (count > 20) {
      clusterReasons.push({
        reason: "owner_count_threshold",
        owner,
        count,
        share,
        recommendation: recommendationForOwner(owner)
      });
    }
    if (share >= 0.3) {
      clusterReasons.push({
        reason: "owner_share_threshold",
        owner,
        count,
        share,
        recommendation: recommendationForOwner(owner)
      });
    }
  }
  if (firstWindowTimeoutLikeCount >= 3) {
    clusterReasons.push({
      reason: "first_window_timeout_like_threshold",
      count: firstWindowTimeoutLikeCount,
      recommendation: "inspect_harness_timeout"
    });
  }
  const timeoutLikeMissingTelemetryCount = results.filter(
    (result) => isTimeoutLike(result) && (!result.dominantStage || !result.stageTimingsMs)
  ).length;
  if (timeoutLikeMissingTelemetryCount > 0) {
    clusterReasons.push({
      reason: "timeout_like_missing_stage_telemetry",
      count: timeoutLikeMissingTelemetryCount,
      recommendation: "inspect_harness_timeout"
    });
  }
  const rowsByRouteFamily = new Map<string, typeof results>();
  for (const result of results) {
    const family = locomoRouteFamily(result);
    rowsByRouteFamily.set(family, [...(rowsByRouteFamily.get(family) ?? []), result]);
  }
  for (const [routeFamily, rows] of rowsByRouteFamily.entries()) {
    const p95Ms = percentile(rows.map(resultLatencyMs), 95);
    if (rows.length >= 3 && p95Ms > 10_000) {
      clusterReasons.push({
        reason: "route_family_p95_threshold",
        routeFamily,
        count: rows.length,
        p95Ms,
        recommendation: routeRecommendation(routeFamily)
      });
    }
  }
  const dominantSlowStageBreakdown = countBy(slowRowsOver10s, (result) => result.dominantStage ?? "missing");
  for (const [dominantStage, count] of Object.entries(dominantSlowStageBreakdown)) {
    const share = round(count / slowScenarioCount);
    if (share >= 0.25) {
      clusterReasons.push({
        reason: "dominant_stage_slow_share_threshold",
        dominantStage,
        count,
        share,
        recommendation: dominantStage === "missing" ? "inspect_harness_timeout" : "inspect_route_budget"
      });
    }
  }
  const topSlowRows: SlowRow[] = [...results]
    .sort((left, right) => resultLatencyMs(right) - resultLatencyMs(left))
    .slice(0, 20)
    .map((result) => ({
      sampleId: result.sampleId ?? "unknown",
      questionIndex: result.questionIndex ?? -1,
      question: result.question ?? "",
      latencyMs: resultLatencyMs(result),
      residualOwner: ownerOf(result),
      queryBehavior: result.queryBehavior ?? "unknown",
      dominantStage: result.dominantStage ?? null,
      topStageMs: result.topStageMs ?? null,
      latencyBudgetFamily: result.latencyBudgetFamily ?? null,
      evidenceTelemetryStatus: evidenceTelemetryStatus(result)
    }));
  const unsupportedNoEvidenceSuccessCount = results.filter(isUnsupportedNoEvidenceSuccess).length;
  const evidenceZeroSuccessCount = results.filter((result) => result.passed === true && (result.evidenceCount ?? 0) === 0).length;
  const failures: string[] = [];
  if ((ownerBreakdown.unknown ?? 0) > 0) failures.push("unknown_owner_present");
  if (unsupportedNoEvidenceSuccessCount > 0) failures.push("unsupported_no_evidence_success");
  if (timeoutLikeCount > 0) failures.push("timeout_like_rows_present");
  if (missingTelemetryOver10sCount > 0) failures.push("slow_rows_missing_telemetry");
  if ((evidenceTelemetryBreakdown.unclassified ?? 0) > 0) failures.push("evidence_telemetry_unclassified");
  if (results.some((result) => result.queryTimeGLiNEROrLLMUsed === true)) failures.push("query_time_gliner_or_llm_used");
  const report: LoCoMoScaleDiagnosticReport = {
    generatedAt: new Date().toISOString(),
    benchmark: "locomo_scale_diagnostic",
    sourceArtifactPath: source.path,
    sourceGeneratedAt: source.report.generatedAt ?? "unknown",
    sourceStatus: source.report.status ?? "complete",
    observedQuestionCount: observed,
    plannedQuestionCount: planned,
    completionRate: planned > 0 ? round(observed / planned) : 0,
    projectedRuntimeMs,
    passRate: artifactPassRate(source.report),
    normalizedPassRate: artifactNormalizedPassRate(source.report),
    diagnosticIntegrityPassed: failures.length === 0,
    thresholds: {
      slowTelemetryThresholdMs: 10_000,
      timeoutLikeThresholdMs: 44_000,
      ownerClusterCount: 20,
      ownerClusterShare: 0.3,
      firstWindowQuestionCount: 300,
      firstWindowTimeoutLikeLimit: 3,
      p95TargetMs: 10_000,
      maxTargetMs: 30_000
    },
    latency: {
      p50Ms: percentile(latencies, 50),
      p95Ms: percentile(latencies, 95),
      maxMs: percentile(latencies, 100),
      timeoutLikeCount,
      over10sCount: results.filter((result) => resultLatencyMs(result) > 10_000).length,
      missingTelemetryOver10sCount
    },
    evidenceTelemetry: {
      breakdown: evidenceTelemetryBreakdown,
      unclassifiedCount: evidenceTelemetryBreakdown.unclassified ?? 0,
      supportPresentCountMissingCount: evidenceTelemetryBreakdown.support_present_count_missing ?? 0,
      unsupportedNoEvidenceSuccessCount,
      evidenceZeroSuccessCount
    },
    routeUsage: {
      ownerBreakdown,
      queryBehaviorBreakdown: countBy(results, (result) => result.queryBehavior),
      dominantStageBreakdown: countBy(results, (result) => result.dominantStage ?? "missing"),
      finalClaimSourceBreakdown: countBy(results, (result) => result.finalClaimSource ?? "missing"),
      latencyBudgetFamilyBreakdown: countBy(results, (result) => result.latencyBudgetFamily ?? "missing"),
      queryTimeGLiNEROrLLMCallCount: results.filter((result) => result.queryTimeGLiNEROrLLMUsed === true).length
    },
    clusterStop: {
      triggered: clusterReasons.length > 0,
      reasons: clusterReasons
    },
    topSlowRows,
    recommendedTracks: recommendedTracks(ownerBreakdown, timeoutLikeCount),
    failures
  };
  const dir = locomoOutputDir(import.meta.url);
  await mkdir(dir, { recursive: true });
  const stamp = report.generatedAt.replace(/[:.]/gu, "-");
  const jsonPath = path.join(dir, `scale-locomo-diagnostic-${stamp}.json`);
  const markdownPath = path.join(dir, `scale-locomo-diagnostic-${stamp}.md`);
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, toMarkdown(report), "utf8");
  return { report, output: { jsonPath, markdownPath } };
}

export async function runLoCoMoScaleDiagnosticCli(): Promise<void> {
  const result = await runAndWriteLoCoMoScaleDiagnostic({ artifactPath: parseArtifactArg() });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.report.diagnosticIntegrityPassed) {
    process.exitCode = 1;
  }
}
