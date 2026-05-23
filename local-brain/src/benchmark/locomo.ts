import { mkdir, readFile, writeFile } from "node:fs/promises";
import { execSync, spawn } from "node:child_process";
import { get } from "node:https";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { readConfig } from "../config.js";
import { withClient, withMaintenanceLock } from "../db/client.js";
import { runMigrations } from "../db/migrations.js";
import { runNamespaceVectorActivation } from "../jobs/vector-sync-runtime.js";
import { planRecallQuery } from "../retrieval/planner.js";
import { rebuildTypedMemoryNamespace } from "../typed-memory/service.js";
import {
  isIdentityProfileQuery,
  isPreciseFactDetailQuery,
  isProfileInferenceQuery,
  isSharedCommonalityQuery,
  isTemporalDetailQuery
} from "../retrieval/query-signals.js";
import { cleanupPublicBenchmarkNamespaces, listResidualBenchmarkNamespaces } from "./public-benchmark-cleanup.js";
import { ingestLoCoMoSessionArtifacts } from "./locomo-ingest.js";
import { promoteOfflineSubstrateForLoCoMoQuestions } from "./offline-substrate-promotion.js";
import { buildBenchmarkRuntimeMetadata, resolvePublicBenchmarkMode, resolveRequestedSampleCount, type BenchmarkRuntimeMetadata } from "./runtime-metadata.js";
import {
  buildBenchmarkVectorActivationMetadata,
  createBenchmarkVectorActivationAccumulator,
  mergeBenchmarkVectorActivation
} from "./vector-activation.js";
import { classifyAnswerShapingDiagnosis, type AnswerShapingDiagnosis } from "./answer-shaping-diagnosis.js";
import { buildBenchmarkCatalog, type BenchmarkCatalog } from "./benchmark-catalog.js";

interface TurnRecord {
  readonly speaker: string;
  readonly text?: string;
  readonly blip_caption?: string;
  readonly query?: string;
  readonly dia_id?: string;
  readonly img_url?: readonly string[];
}

interface LocomoConversation {
  readonly sample_id: string;
  readonly conversation: Record<string, string | readonly TurnRecord[]>;
  readonly qa: readonly {
    readonly question: string;
    readonly answer?: string;
    readonly adversarial_answer?: string;
    readonly category: number;
  }[];
}

interface SelectedLoCoMoQuestion {
  readonly qa: LocomoConversation["qa"][number];
  readonly originalIndex: number;
}

type FailureClass =
  | "pass"
  | "retrieval"
  | "temporal"
  | "provenance"
  | "answer_shaping"
  | "synthesis_commonality"
  | "conflict_resolution"
  | "alias_entity_resolution"
  | "abstention";

type SufficiencyGrade = "supported" | "weak" | "missing" | "contradicted" | null;
type SubjectMatch = "matched" | "mixed" | "mismatched" | "unknown" | null;
type SynthesisMode = "recall" | "reflect" | null;
type ReflectOutcome = "helped" | "no_gain" | "harmful" | null;
type QueryBehavior = "exact_detail" | "temporal_detail" | "profile" | "commonality" | "recap" | "causal" | "direct_fact" | "other";
type EvidenceTelemetryStatus =
  | "counted"
  | "source_count_missing"
  | "support_present_count_missing"
  | "abstention_no_evidence_ok"
  | "unsupported_success"
  | "evidence_zero_success_unverified"
  | "failure_no_evidence"
  | "unclassified";
type ResidualOwner =
  | "pass"
  | "report_semantics"
  | "subject_binding"
  | "temporal_rendering"
  | "list_set_rendering"
  | "route_ranking"
  | "source_missing"
  | "compiler_missing"
  | "harness";

interface OwnerEvidence {
  readonly queryBehavior: QueryBehavior;
  readonly finalClaimSource: string | null;
  readonly evidenceCount: number;
  readonly sourceCount: number;
  readonly subjectMatch: SubjectMatch;
  readonly sufficiency: SufficiencyGrade;
  readonly dominantStage: string | null;
  readonly sourceBoundEvidenceRequired: boolean;
  readonly sourceBoundEvidencePresent: boolean;
  readonly readerEvidenceDisciplineStatus: string | null;
}

interface QueryResult {
  readonly sampleId: string;
  readonly questionIndex: number;
  readonly category: number;
  readonly question: string;
  readonly expectedAnswer: string;
  readonly queryBehavior: QueryBehavior;
  readonly passed: boolean;
  readonly normalizedPassed: boolean;
  readonly failureClass: FailureClass;
  readonly confidence: string | null;
  readonly sufficiency: SufficiencyGrade;
  readonly subjectMatch: SubjectMatch;
  readonly synthesisMode: SynthesisMode;
  readonly recursiveReflectApplied: boolean;
  readonly reflectHelped: boolean;
  readonly reflectOutcome: ReflectOutcome;
  readonly adequacyStatus: string | null;
  readonly missingInfoType: string | null;
  readonly exactAnswerWindowCount: number;
  readonly exactAnswerSafeWindowCount: number;
  readonly exactAnswerDiscardedMixedWindowCount: number;
  readonly exactAnswerDiscardedForeignWindowCount: number;
  readonly exactAnswerCandidateCount: number;
  readonly exactAnswerDominantMargin: number | null;
  readonly exactAnswerAbstainedForAmbiguity: boolean;
  readonly answerableUnitApplied: boolean;
  readonly answerableUnitCandidateCount: number;
  readonly answerableUnitOwnedCount: number;
  readonly answerableUnitMixedCount: number;
  readonly answerableUnitForeignCount: number;
  readonly readerApplied: boolean;
  readonly readerDecision: string | null;
  readonly readerSelectedUnitCount: number;
  readonly readerTopUnitType: string | null;
  readonly readerDominantMargin: number | null;
  readonly readerAbstainedAliasAmbiguity: boolean;
  readonly readerAbstainedTemporalGap: boolean;
  readonly readerUsedFallback: boolean;
  readonly resolverApplied: boolean;
  readonly resolverStatus: "resolved" | "ambiguous" | "unresolved" | null;
  readonly resolverTopMargin: number | null;
  readonly ownershipWindowCount: number;
  readonly ownershipOwnedCount: number;
  readonly ownershipMixedCount: number;
  readonly ownershipForeignCount: number;
  readonly fallbackSuppressedCount: number;
  readonly ownedWindowUsedForFinalClaim: boolean;
  readonly subjectIsolationApplied: boolean;
  readonly subjectIsolationOwnedCount: number;
  readonly subjectIsolationDiscardedMixedCount: number;
  readonly subjectIsolationDiscardedForeignCount: number;
  readonly subjectIsolationTopResultOwned: boolean;
  readonly globalQueryRouted: boolean;
  readonly summaryRoutingUsed: boolean;
  readonly branchPruningApplied: boolean;
  readonly prunedBranches: readonly string[];
  readonly stageTimingsMs: Readonly<Record<string, number>> | null;
  readonly dominantStage: string | null;
  readonly topStageMs: number | null;
  readonly neighborExpansionCount: number;
  readonly typedLaneDepth: number;
  readonly recursiveSubqueryCount: number;
  readonly latencyBudgetFamily: string | null;
  readonly routeBudgetEnforced?: boolean;
  readonly routeBudgetExceededStages?: readonly string[];
  readonly routeBudgetDecision?: string | null;
  readonly plannerTargetedBackfillSubqueryLimit?: number | null;
  readonly earlyStopReason: string | null;
  readonly leafTraversalTriggered: boolean;
  readonly descentTriggered: boolean;
  readonly descentStages: readonly string[];
  readonly initialLaneSufficiency: string | null;
  readonly finalLaneSufficiency: string | null;
  readonly reducerFamily: string | null;
  readonly finalClaimSource: string | null;
  readonly profileTraitSourceCoverageStatus?: string | null;
  readonly profileTraitEvidenceSpanCount?: number;
  readonly profileTraitCompilerStatus?: string | null;
  readonly profileTraitRouteStatus?: string | null;
  readonly profileTraitResidualOwner?: string | null;
  readonly canonicalFallbackBlockedReason?: string | null;
  readonly sourceBoundEvidenceRequired?: boolean;
  readonly sourceBoundEvidencePresent?: boolean;
  readonly evidenceTelemetryStatus?: EvidenceTelemetryStatus;
  readonly readerEvidenceDisciplineStatus?: string | null;
  readonly readerResidualOwner?: string | null;
  readonly compiledDirectFactLookupTried?: boolean;
  readonly compiledDirectFactLookupSucceeded?: boolean;
  readonly directFactFamily?: string | null;
  readonly compiledDirectFactCoverageStatus?: string | null;
  readonly compiledProfileInferenceLookupTried?: boolean;
  readonly compiledProfileInferenceLookupSucceeded?: boolean;
  readonly profileInferenceFamily?: string | null;
  readonly premiseCount?: number;
  readonly premiseCoverageStatus?: string | null;
  readonly inferenceConfidence?: number | null;
  readonly inferencePromotionStatus?: string | null;
  readonly inferenceRejectionReason?: string | null;
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
  readonly residualOwner: ResidualOwner;
  readonly ownerEvidence: OwnerEvidence;
  readonly answerOwnerTrace?: {
    readonly family?: string | null;
    readonly winner?: string | null;
    readonly eligibleOwners?: readonly string[];
    readonly suppressedOwners?: readonly { readonly owner: string; readonly reason: string }[];
    readonly candidates?: readonly {
      readonly owner: string;
      readonly family: string;
      readonly eligible: boolean;
      readonly suppressed: boolean;
      readonly suppressionReason?: string | null;
      readonly reasonCodes?: readonly string[];
      readonly subjectBindingStatus?: string | null;
      readonly subjectPlanKind?: string | null;
      readonly sourceTable?: string | null;
    }[];
    readonly reasonCodes?: readonly string[];
    readonly fallbackPath?: readonly string[];
    readonly abstentionReason?: string | null;
    readonly resolvedSubject?: {
      readonly bindingStatus?: string | null;
      readonly subjectPlanKind?: string | null;
      readonly subjectId?: string | null;
      readonly subjectName?: string | null;
    };
  } | null;
  readonly answerShapingTrace?: {
    readonly selectedFamily?: string | null;
    readonly shapingMode?: string | null;
    readonly retrievalPlanFamily?: string | null;
    readonly retrievalPlanLane?: string | null;
    readonly retrievalPlanResolvedSubjectEntityId?: string | null;
    readonly retrievalPlanCandidatePools?: readonly string[];
    readonly retrievalPlanSuppressionPools?: readonly string[];
    readonly retrievalPlanRequiredFields?: readonly string[];
    readonly retrievalPlanTargetedBackfill?: readonly string[];
    readonly retrievalPlanTargetedBackfillRequests?: readonly {
      readonly reason?: string | null;
      readonly requiredFields?: readonly string[];
      readonly candidatePool?: string | null;
      readonly maxPasses?: number | null;
    }[];
    readonly retrievalPlanQueryExpansionTerms?: readonly string[];
    readonly retrievalPlanBannedExpansionTerms?: readonly string[];
    readonly retrievalPlanFamilyConfidence?: number | null;
    readonly retrievalPlanSupportCompletenessTarget?: number | null;
    readonly retrievalPlanRescuePolicy?: string | null;
    readonly ownerEligibilityHints?: readonly string[];
    readonly suppressionHints?: readonly string[];
    readonly typedValueUsed?: boolean;
    readonly generatedProseUsed?: boolean;
    readonly runtimeResynthesisUsed?: boolean;
    readonly supportRowsSelected?: number;
    readonly supportTextsSelected?: number;
    readonly supportSelectionMode?: string | null;
    readonly supportObjectsBuilt?: number;
    readonly supportObjectType?: string | null;
    readonly supportNormalizationFailures?: readonly string[];
    readonly renderContractSelected?: string | null;
    readonly renderContractFallbackReason?: string | null;
    readonly selectedEventKey?: string | null;
    readonly selectedEventType?: string | null;
    readonly selectedTimeGranularity?: string | null;
    readonly typedSetEntryCount?: number;
    readonly typedSetEntryType?: string | null;
    readonly exactDetailSource?: string | null;
  } | null;
  readonly shapingDiagnosis?: AnswerShapingDiagnosis | null;
  readonly fallbackSuppressedReason: string | null;
  readonly canonicalPathUsed?: boolean;
  readonly canonicalPredicateFamily?: string | null;
  readonly canonicalSupportStrength?: string | null;
  readonly canonicalAbstainReason?: string | null;
  readonly canonicalSubjectBindingStatus?: string | null;
  readonly canonicalSubjectId?: string | null;
  readonly canonicalSubjectName?: string | null;
  readonly canonicalStatus?: string | null;
  readonly subjectPlanKind?: string | null;
  readonly pairPlanUsed?: boolean;
  readonly canonicalReadTier?: string | null;
  readonly temporalValiditySource?: string | null;
  readonly chainSerializerUsed?: boolean;
  readonly narrativePathUsed?: boolean;
  readonly narrativeKind?: string | null;
  readonly reportPathUsed?: boolean;
  readonly reportKind?: string | null;
  readonly narrativeSourceTier?: string | null;
  readonly narrativeCandidateCount?: number;
  readonly narrativeShadowDecision?: string | null;
  readonly narrativeCutoverApplied?: boolean;
  readonly renderContract?: string | null;
  readonly retrievalMode?: string | null;
  readonly vectorCandidateCount: number;
  readonly vectorContributedToFinalSupport: boolean;
  readonly latencyMs: number;
  readonly rawEvidenceCount?: number;
  readonly rawSourceCount?: number;
  readonly sourceBoundSupportCount?: number;
  readonly evidenceCount: number;
  readonly sourceCount: number;
  readonly answerSnippet: string;
}

interface LoCoMoProgressState {
  readonly runStamp: string;
  readonly currentSampleId: string | null;
  readonly currentQuestionIndex: number | null;
  readonly totalQuestionsPlanned: number;
  readonly completedQuestions: number;
  readonly lastProgressAt: string;
}

interface PartialLoCoMoArtifact {
  readonly generatedAt: string;
  readonly dataset: string;
  readonly status: "partial";
  readonly runtime: BenchmarkRuntimeMetadata;
  readonly progress: LoCoMoProgressState;
  readonly latencies: readonly number[];
  readonly results: readonly QueryResult[];
  readonly failureReason?: string;
}

export interface LoCoMoReport {
  readonly generatedAt: string;
  readonly dataset: string;
  readonly runtime: BenchmarkRuntimeMetadata;
  readonly sampleCount: number;
  readonly passRate: number;
  readonly latency: {
    readonly p50Ms: number;
    readonly p95Ms: number;
    readonly maxMs: number;
  };
  readonly diagnostics: {
    readonly failureBreakdown: Readonly<Record<FailureClass, number>>;
    readonly sufficiencyBreakdown: Readonly<Record<Exclude<SufficiencyGrade, null>, number>>;
    readonly subjectMatchBreakdown: Readonly<Record<Exclude<SubjectMatch, null>, number>>;
    readonly synthesisModeBreakdown: Readonly<Record<Exclude<SynthesisMode, null>, number>>;
    readonly reflectHelpedRate: number;
    readonly reflectNoGainRate: number;
    readonly reflectHarmRate: number;
    readonly answerShapingPassRate: number;
    readonly aliasEntityResolutionPassRate: number;
    readonly exactDetailPrecision: number;
    readonly temporalAnchorHitRate: number;
    readonly commonalityOverlapPrecision: number;
    readonly nonEmptyAnswerTokenPrecision: number;
    readonly nonEmptyAnswerTokenRecall: number;
    readonly nonEmptyAnswerTokenF1: number;
    readonly shapingDiagnosisBreakdown: Readonly<Record<Exclude<AnswerShapingDiagnosis, "not_applicable">, number>>;
    readonly residualOwnerBreakdown: Readonly<Record<ResidualOwner, number>>;
    readonly unsupportedNoEvidenceSuccessCount: number;
    readonly compiledDirectFactLookupTriedCount?: number;
    readonly compiledDirectFactLookupSucceededCount?: number;
    readonly compiledProfileInferenceLookupTriedCount?: number;
    readonly compiledProfileInferenceLookupSucceededCount?: number;
    readonly sourceBoundFallbackUsedCount?: number;
    readonly queryTimeExtractorUsedCount?: number;
    readonly queryTimeGLiNEROrLLMCallCount?: number;
    readonly offlineSubstrateLookupTriedCount?: number;
    readonly offlineSubstrateLookupSucceededCount?: number;
    readonly offlineSubstrateEvidenceZeroCount?: number;
    readonly mixedSubjectDiscardRate: number;
    readonly exactAnswerWindowCount: number;
    readonly exactAnswerSafeWindowCount: number;
    readonly exactAnswerDiscardedMixedWindowCount: number;
    readonly exactAnswerDiscardedForeignWindowCount: number;
    readonly exactAnswerCandidateCount: number;
    readonly exactAnswerAbstainedForAmbiguityRate: number;
    readonly exactAnswerAverageDominantMargin: number;
    readonly answerableUnitAppliedRate: number;
    readonly readerResolvedRate: number;
    readonly readerAbstainRate: number;
    readonly readerAliasSafeClaimRate: number;
    readonly readerTemporalAnchorHitRate: number;
    readonly resolverAppliedRate: number;
    readonly resolverResolvedRate: number;
    readonly ownershipWindowCount: number;
    readonly ownershipOwnedCount: number;
    readonly ownershipMixedCount: number;
    readonly ownershipForeignCount: number;
    readonly fallbackSuppressedCount: number;
    readonly ownedWindowUsedForFinalClaimRate: number;
    readonly subjectIsolationAppliedRate: number;
    readonly subjectIsolationOwnedCount: number;
    readonly subjectIsolationDiscardedMixedCount: number;
    readonly subjectIsolationDiscardedForeignCount: number;
    readonly subjectIsolationTopResultOwnedRate: number;
    readonly categoryBreakdown: Readonly<Record<string, {
      readonly sampleCount: number;
      readonly passRate: number;
      readonly failureBreakdown: Readonly<Record<FailureClass, number>>;
    }>>;
  };
  readonly catalog: BenchmarkCatalog;
  readonly results: readonly QueryResult[];
  readonly passed: boolean;
}

interface TokenOverlapScore {
  readonly precision: number;
  readonly recall: number;
  readonly f1: number;
}

function shouldSkipPublicBenchmarkCleanup(): boolean {
  return process.env.BRAIN_PUBLIC_BENCHMARK_SKIP_CLEANUP === "1";
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

function benchmarkLog(message: string): void {
  process.stdout.write(`[locomo] ${new Date().toISOString()} ${message}\n`);
}

function resolveBenchmarkTimeoutMs(): number {
  const raw = Number(process.env.BRAIN_BENCHMARK_QUERY_TIMEOUT_MS ?? "");
  if (Number.isFinite(raw) && raw > 0) {
    return Math.max(1_000, Math.floor(raw));
  }
  return 45_000;
}

function resolveHeartbeatMs(): number {
  const raw = Number(process.env.BRAIN_BENCHMARK_HEARTBEAT_MS ?? "");
  if (Number.isFinite(raw) && raw > 0) {
    return Math.max(5_000, Math.floor(raw));
  }
  return 15_000;
}

function resolvePartialFlushEvery(): number {
  const raw = Number(process.env.BRAIN_BENCHMARK_PARTIAL_FLUSH_EVERY ?? "");
  if (Number.isFinite(raw) && raw > 0) {
    return Math.max(1, Math.floor(raw));
  }
  return 5;
}

function resolveOptionalDelayMs(envName: string): number {
  const raw = Number(process.env[envName] ?? "");
  if (Number.isFinite(raw) && raw > 0) {
    return Math.max(0, Math.floor(raw));
  }
  return 0;
}

function sleepMs(delayMs: number): Promise<void> {
  if (!Number.isFinite(delayMs) || delayMs <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function shouldSkipPublicBenchmarkPreflight(): boolean {
  return process.env.BRAIN_PUBLIC_BENCHMARK_SKIP_PREFLIGHT === "1";
}

function resolveBenchmarkNamespacePreflightPrefixes(): readonly string[] {
  const configured = String(process.env.BRAIN_PUBLIC_BENCHMARK_PREFLIGHT_PREFIXES ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (configured.length > 0) {
    return [...new Set(configured)];
  }
  return ["benchmark_locomo_"];
}

function resolveBenchmarkCleanupStatementTimeoutMs(): number {
  const raw = Number(process.env.BRAIN_BENCHMARK_CLEANUP_TIMEOUT_MS ?? "");
  if (Number.isFinite(raw) && raw > 0) {
    return Math.max(5_000, Math.floor(raw));
  }
  return 60_000;
}

async function runBenchmarkNamespacePreflight(logger: (message: string) => void): Promise<void> {
  const prefixes = resolveBenchmarkNamespacePreflightPrefixes();
  const residualNamespaces = await listResidualBenchmarkNamespaces(prefixes);
  if (residualNamespaces.length === 0) {
    logger(`preflight clean benchmark namespaces=0 prefixes=${prefixes.join(",")}`);
    return;
  }
  logger(`preflight residue detected namespaces=${residualNamespaces.length} prefixes=${prefixes.join(",")}`);
  await cleanupPublicBenchmarkNamespaces(residualNamespaces, {
    namespaceChunkSize: 1,
    statementTimeoutMs: resolveBenchmarkCleanupStatementTimeoutMs(),
    lockTimeoutMs: 2_000,
    logger: (message) => logger(`preflight cleanup ${message}`)
  });
  const remaining = await listResidualBenchmarkNamespaces(prefixes);
  if (remaining.length > 0) {
    throw new Error(
      `Benchmark preflight cleanup incomplete; residual benchmark namespaces remain (${remaining.length}) for prefixes ${prefixes.join(",")}.`
    );
  }
  logger(`preflight cleanup complete benchmark namespaces=0 prefixes=${prefixes.join(",")}`);
}

async function runBenchmarkSchemaPreflight(logger: (message: string) => void): Promise<void> {
  await runMigrations();
  const requiredTables = [
    "canonical_narratives",
    "canonical_entity_reports",
    "canonical_pair_reports",
    "canonical_set_entries",
    "canonical_temporal_facts",
    "temporal_event_facts",
    "temporal_event_support",
    "contract_projection_heads",
    "contract_projection_entries"
  ] as const;
  const rows = await withClient(async (client) => {
    const result = await client.query<{ readonly table_name: string; readonly present: string | null }>(
      `
        SELECT
          table_name,
          to_regclass(table_name)::text AS present
        FROM unnest($1::text[]) AS table_name
      `,
      [requiredTables]
    );
    return result.rows;
  });
  const missing = rows.filter((row) => !row.present).map((row) => row.table_name);
  if (missing.length > 0) {
    throw new Error(`Benchmark schema preflight failed; missing tables: ${missing.join(", ")}`);
  }
  logger(`preflight schema ok tables=${requiredTables.length}`);
}

function resolveGitCommit(): string | null {
  try {
    return execSync("git rev-parse HEAD", {
      cwd: localBrainRoot(),
      stdio: ["ignore", "pipe", "ignore"]
    })
      .toString("utf8")
      .trim();
  } catch {
    return null;
  }
}

async function writePartialArtifact(
  runtime: BenchmarkRuntimeMetadata,
  progress: LoCoMoProgressState,
  latencies: readonly number[],
  results: readonly QueryResult[],
  failureReason?: string
): Promise<string> {
  await mkdir(outputDir(), { recursive: true });
  const partialPath = path.join(outputDir(), `locomo-${progress.runStamp}.partial.json`);
  const partial: PartialLoCoMoArtifact = {
    generatedAt: new Date().toISOString(),
    dataset: "locomo10",
    status: "partial",
    runtime,
    progress,
    latencies,
    results,
    failureReason
  };
  await writeFile(partialPath, JSON.stringify(partial, null, 2), "utf8");
  return partialPath;
}

async function withBenchmarkTimeout<T>(
  label: string,
  timeoutMs: number,
  fn: () => Promise<T>
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      fn(),
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${label} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      })
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function generatedRoot(): string {
  return path.resolve(localBrainRoot(), "benchmark-generated", "public-memory-compare");
}

function searchCliPath(): string {
  return path.resolve(localBrainRoot(), "dist", "cli", "search.js");
}

async function executeSearchIsolated(
  label: string,
  namespaceId: string,
  query: string,
  limit: number,
  timeoutMs: number
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [searchCliPath(), "--namespace", namespaceId, "--limit", String(limit), query],
      {
        cwd: localBrainRoot(),
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"]
      }
    );
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill("SIGKILL");
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        const message = stderr.trim() || `isolated memory.search exited with code ${String(code)} signal ${String(signal)}`;
        reject(new Error(message));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        reject(new Error(`Failed to parse isolated memory.search payload: ${message}`));
      }
    });
  });
}

function percentile(values: readonly number[], pct: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((pct / 100) * sorted.length) - 1));
  return Number(sorted[index]!.toFixed(2));
}

function normalize(value: unknown): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function normalizedTokens(value: unknown): string[] {
  return normalize(value)
    .split(" ")
    .map((token) => token.trim())
    .filter((token) => token.length > 1);
}

function tokenOverlapScore(expectedAnswer: string, answerSnippet: string): TokenOverlapScore | null {
  const expected = normalize(expectedAnswer);
  if (!expected || expected === "none") {
    return null;
  }

  const expectedTokens = normalizedTokens(expectedAnswer);
  const answerTokens = normalizedTokens(answerSnippet);
  if (expectedTokens.length === 0) {
    return null;
  }
  if (answerTokens.length === 0) {
    return { precision: 0, recall: 0, f1: 0 };
  }

  const expectedCounts = new Map<string, number>();
  for (const token of expectedTokens) {
    expectedCounts.set(token, (expectedCounts.get(token) ?? 0) + 1);
  }

  let hits = 0;
  for (const token of answerTokens) {
    const remaining = expectedCounts.get(token) ?? 0;
    if (remaining > 0) {
      hits += 1;
      expectedCounts.set(token, remaining - 1);
    }
  }

  const precision = hits / Math.max(1, answerTokens.length);
  const recall = hits / Math.max(1, expectedTokens.length);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return {
    precision: Number(precision.toFixed(3)),
    recall: Number(recall.toFixed(3)),
    f1: Number(f1.toFixed(3))
  };
}

function compactNormalize(value: unknown): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .trim();
}

function extractCompactAnswerItems(value: unknown): string[] {
  return [...new Set(
    String(value ?? "")
      .split(/[,\n;]+/g)
      .map((item) => compactNormalize(item))
      .filter((item) => item.length > 2)
  )];
}

function compactListPass(expectedAnswer: string, compactCandidate: string): boolean {
  const expectedItems = extractCompactAnswerItems(expectedAnswer);
  return expectedItems.length >= 2 && expectedItems.every((item) => compactCandidate.includes(item));
}

function benchmarkExpectedAnswer(qa: { readonly answer?: string | number; readonly category: number }): string {
  if (typeof qa.answer === "string" && qa.answer.trim().length > 0) {
    return qa.answer;
  }
  if (typeof qa.answer === "number" && Number.isFinite(qa.answer)) {
    return String(qa.answer);
  }
  return qa.category === 5 ? "None" : "";
}

function resolveRequestedQuestionCount(rawValue: string | undefined, fallback: number): number | "full" {
  if (!rawValue || !rawValue.trim()) {
    return Math.max(1, Math.floor(fallback));
  }
  const normalized = rawValue.trim().toLowerCase();
  if (normalized === "all" || normalized === "full") {
    return "full";
  }
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return "full";
  }
  return Math.max(1, Math.floor(parsed));
}

function isTruthyEnv(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function resolveOptionalPositiveInt(rawValue: string | undefined): number | null {
  if (!rawValue || !rawValue.trim()) {
    return null;
  }
  const parsed = Number(rawValue.trim());
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return Math.max(1, Math.floor(parsed));
}

function resolveDelimitedEnvValues(rawValue: string | undefined): readonly string[] {
  if (!rawValue || !rawValue.trim()) {
    return [];
  }
  return [...new Set(rawValue.split(",").map((value) => value.trim()).filter((value) => value.length > 0))];
}

function resolveSelectedLoCoMoSampleIds(rawValue: string | undefined): readonly string[] {
  return resolveDelimitedEnvValues(rawValue);
}

function resolveSelectedLoCoMoQuestionKeys(rawValue: string | undefined): ReadonlyMap<string, ReadonlySet<number>> {
  const keys = resolveDelimitedEnvValues(rawValue);
  const grouped = new Map<string, Set<number>>();
  for (const key of keys) {
    const [sampleIdRaw, questionIndexRaw] = key.split("#");
    const sampleId = sampleIdRaw?.trim();
    const questionIndex = Number(questionIndexRaw?.trim());
    if (!sampleId || !Number.isFinite(questionIndex) || questionIndex < 0) {
      continue;
    }
    const indexes = grouped.get(sampleId) ?? new Set<number>();
    indexes.add(Math.floor(questionIndex));
    grouped.set(sampleId, indexes);
  }
  return new Map(
    [...grouped.entries()].map(([sampleId, indexes]) => [sampleId, new Set([...indexes.values()].sort((left, right) => left - right))])
  );
}

function selectLoCoMoQuestions(
  questions: readonly LocomoConversation["qa"][number][],
  requestedCount: number | "full",
  options: {
    readonly stratified: boolean;
    readonly perCategoryLimit: number | null;
  }
): readonly LocomoConversation["qa"][number][] {
  if (requestedCount === "full" || !options.stratified) {
    return requestedCount === "full" ? questions : questions.slice(0, requestedCount);
  }

  const grouped = new Map<number, Array<LocomoConversation["qa"][number]>>();
  for (const question of questions) {
    const bucket = grouped.get(question.category);
    if (bucket) {
      bucket.push(question);
    } else {
      grouped.set(question.category, [question]);
    }
  }

  const categories = [...grouped.keys()].sort((left, right) => left - right);
  if (categories.length === 0) {
    return questions.slice(0, requestedCount);
  }

  const baselinePerCategory = Math.max(1, Math.floor(requestedCount / categories.length));
  const targetPerCategory = options.perCategoryLimit ? Math.max(1, options.perCategoryLimit) : baselinePerCategory;
  const selected: LocomoConversation["qa"][number][] = [];
  const used = new Set<LocomoConversation["qa"][number]>();

  for (const category of categories) {
    const bucket = grouped.get(category) ?? [];
    for (const question of bucket.slice(0, targetPerCategory)) {
      if (selected.length >= requestedCount) {
        break;
      }
      selected.push(question);
      used.add(question);
    }
  }

  if (selected.length >= requestedCount) {
    return selected.slice(0, requestedCount);
  }

  let madeProgress = true;
  while (selected.length < requestedCount && madeProgress) {
    madeProgress = false;
    for (const category of categories) {
      const nextQuestion = (grouped.get(category) ?? []).find((question) => !used.has(question));
      if (!nextQuestion) {
        continue;
      }
      selected.push(nextQuestion);
      used.add(nextQuestion);
      madeProgress = true;
      if (selected.length >= requestedCount) {
        break;
      }
    }
  }

  return selected.slice(0, requestedCount);
}

function toMarkdown(report: LoCoMoReport): string {
  const slowestResults = [...report.results].sort((left, right) => right.latencyMs - left.latencyMs).slice(0, 20);
  const lines = [
    "# LoCoMo Compatibility Report",
    "",
    `- generatedAt: ${report.generatedAt}`,
    `- dataset: ${report.dataset}`,
    `- benchmarkMode: ${report.runtime.benchmarkMode}`,
    `- fastScorerVersion: ${report.runtime.fastScorerVersion}`,
    `- officialishScorerVersion: ${report.runtime.officialishScorerVersion}`,
    `- retrievalFusionVersion: ${report.runtime.retrievalFusionVersion}`,
    `- rerankerVersion: ${report.runtime.rerankerVersion}`,
    `- relationIeSchemaVersion: ${report.runtime.relationIeSchemaVersion}`,
    `- sampleCount: ${report.sampleCount}`,
    `- passRate: ${report.passRate}`,
    `- passed: ${report.passed}`,
    `- latency.p50Ms: ${report.latency.p50Ms}`,
    `- latency.p95Ms: ${report.latency.p95Ms}`,
    `- latency.maxMs: ${report.latency.maxMs}`,
    `- benchmarkModeNote: ${
      report.runtime.benchmarkMode === "sampled"
        ? "sampled locomo10 compatibility run; not the full unsampled corpus"
        : "full unsampled public corpus run"
    }`,
    "",
    "## Diagnostics",
    "",
    `- failureBreakdown: ${JSON.stringify(report.diagnostics.failureBreakdown)}`,
    `- sufficiencyBreakdown: ${JSON.stringify(report.diagnostics.sufficiencyBreakdown)}`,
    `- subjectMatchBreakdown: ${JSON.stringify(report.diagnostics.subjectMatchBreakdown)}`,
    `- synthesisModeBreakdown: ${JSON.stringify(report.diagnostics.synthesisModeBreakdown)}`,
    `- reflectHelpedRate: ${report.diagnostics.reflectHelpedRate}`,
    `- reflectNoGainRate: ${report.diagnostics.reflectNoGainRate}`,
    `- reflectHarmRate: ${report.diagnostics.reflectHarmRate}`,
    `- answerShapingPassRate: ${report.diagnostics.answerShapingPassRate}`,
    `- aliasEntityResolutionPassRate: ${report.diagnostics.aliasEntityResolutionPassRate}`,
    `- exactDetailPrecision: ${report.diagnostics.exactDetailPrecision}`,
    `- temporalAnchorHitRate: ${report.diagnostics.temporalAnchorHitRate}`,
    `- commonalityOverlapPrecision: ${report.diagnostics.commonalityOverlapPrecision}`,
    `- nonEmptyAnswerTokenPrecision: ${report.diagnostics.nonEmptyAnswerTokenPrecision}`,
    `- nonEmptyAnswerTokenRecall: ${report.diagnostics.nonEmptyAnswerTokenRecall}`,
    `- nonEmptyAnswerTokenF1: ${report.diagnostics.nonEmptyAnswerTokenF1}`,
    `- catalog.finalClaimSource: ${JSON.stringify(report.catalog.buckets.finalClaimSource)}`,
    `- shapingDiagnosisBreakdown: ${JSON.stringify(report.diagnostics.shapingDiagnosisBreakdown)}`,
    `- residualOwnerBreakdown: ${JSON.stringify(report.diagnostics.residualOwnerBreakdown)}`,
    `- unsupportedNoEvidenceSuccessCount: ${report.diagnostics.unsupportedNoEvidenceSuccessCount}`,
    `- mixedSubjectDiscardRate: ${report.diagnostics.mixedSubjectDiscardRate}`,
    `- exactAnswerWindowCount: ${report.diagnostics.exactAnswerWindowCount}`,
    `- exactAnswerSafeWindowCount: ${report.diagnostics.exactAnswerSafeWindowCount}`,
    `- exactAnswerDiscardedMixedWindowCount: ${report.diagnostics.exactAnswerDiscardedMixedWindowCount}`,
    `- exactAnswerDiscardedForeignWindowCount: ${report.diagnostics.exactAnswerDiscardedForeignWindowCount}`,
    `- exactAnswerCandidateCount: ${report.diagnostics.exactAnswerCandidateCount}`,
    `- exactAnswerAbstainedForAmbiguityRate: ${report.diagnostics.exactAnswerAbstainedForAmbiguityRate}`,
    `- exactAnswerAverageDominantMargin: ${report.diagnostics.exactAnswerAverageDominantMargin}`,
    `- answerableUnitAppliedRate: ${report.diagnostics.answerableUnitAppliedRate}`,
    `- readerResolvedRate: ${report.diagnostics.readerResolvedRate}`,
    `- readerAbstainRate: ${report.diagnostics.readerAbstainRate}`,
    `- readerAliasSafeClaimRate: ${report.diagnostics.readerAliasSafeClaimRate}`,
    `- readerTemporalAnchorHitRate: ${report.diagnostics.readerTemporalAnchorHitRate}`,
    `- resolverAppliedRate: ${report.diagnostics.resolverAppliedRate}`,
    `- resolverResolvedRate: ${report.diagnostics.resolverResolvedRate}`,
    `- ownershipWindowCount: ${report.diagnostics.ownershipWindowCount}`,
    `- ownershipOwnedCount: ${report.diagnostics.ownershipOwnedCount}`,
    `- ownershipMixedCount: ${report.diagnostics.ownershipMixedCount}`,
    `- ownershipForeignCount: ${report.diagnostics.ownershipForeignCount}`,
    `- fallbackSuppressedCount: ${report.diagnostics.fallbackSuppressedCount}`,
    `- ownedWindowUsedForFinalClaimRate: ${report.diagnostics.ownedWindowUsedForFinalClaimRate}`,
    `- subjectIsolationAppliedRate: ${report.diagnostics.subjectIsolationAppliedRate}`,
    `- subjectIsolationOwnedCount: ${report.diagnostics.subjectIsolationOwnedCount}`,
    `- subjectIsolationDiscardedMixedCount: ${report.diagnostics.subjectIsolationDiscardedMixedCount}`,
    `- subjectIsolationDiscardedForeignCount: ${report.diagnostics.subjectIsolationDiscardedForeignCount}`,
    `- subjectIsolationTopResultOwnedRate: ${report.diagnostics.subjectIsolationTopResultOwnedRate}`,
    `- categoryBreakdown: ${JSON.stringify(report.diagnostics.categoryBreakdown)}`,
    "",
    "## Slowest 20",
    ""
  ];

  for (const result of slowestResults) {
    lines.push(
      `- ${result.sampleId} category=${result.category} latency=${result.latencyMs} behavior=${result.queryBehavior} dominantStage=${result.dominantStage ?? "n/a"} topStageMs=${result.topStageMs ?? "n/a"} finalClaimSource=${result.finalClaimSource ?? "n/a"}`
    );
    lines.push(`  - q: ${result.question}`);
    if (result.descentStages.length > 0) {
      lines.push(`  - descentStages: ${result.descentStages.join(" -> ")}`);
    }
    if (result.reducerFamily) {
      lines.push(`  - reducerFamily: ${result.reducerFamily}`);
    }
    if (result.fallbackSuppressedReason) {
      lines.push(`  - fallbackSuppressedReason: ${result.fallbackSuppressedReason}`);
    }
    if (result.shapingDiagnosis && result.shapingDiagnosis !== "not_applicable") {
      lines.push(`  - shapingDiagnosis: ${result.shapingDiagnosis}`);
    }
    lines.push(`  - residualOwner: ${result.residualOwner}`);
  }

  lines.push(
    "",
    "## Results",
    ""
  );
  for (const result of report.results) {
    lines.push(
      `- ${result.sampleId} category=${result.category}: ${result.passed ? "pass" : "fail"} | normalized=${result.normalizedPassed ? "pass" : "fail"} | confidence=${result.confidence ?? "n/a"} | latency=${result.latencyMs} | evidence=${result.evidenceCount} | sources=${result.sourceCount} | dominantStage=${result.dominantStage ?? "n/a"} | finalClaimSource=${result.finalClaimSource ?? "n/a"} | shapingDiagnosis=${result.shapingDiagnosis ?? "n/a"}`
    );
    lines.push(`  - residualOwner: ${result.residualOwner} | sourceBoundEvidence=${result.sourceBoundEvidencePresent ? "present" : "missing"} | readerDiscipline=${result.readerEvidenceDisciplineStatus ?? "n/a"}`);
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function downloadText(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    get(url, (response) => {
      if (response.statusCode && response.statusCode >= 400) {
        reject(new Error(`request failed for ${url}: ${response.statusCode}`));
        response.resume();
        return;
      }
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
      });
      response.on("end", () => resolve(body));
      response.on("error", reject);
    }).on("error", reject);
  });
}

async function downloadCached(url: string, fileName: string): Promise<string> {
  const destination = path.join(generatedRoot(), "raw", fileName);
  try {
    return await readFile(destination, "utf8");
  } catch {
    await mkdir(path.dirname(destination), { recursive: true });
    const body = await downloadText(url);
    await writeFile(destination, body, "utf8");
    return body;
  }
}

function bestEffortPass(expectedAnswer: string, payload: any): boolean {
  const haystack = normalize(JSON.stringify(payload));
  const expected = normalize(expectedAnswer);
  const compactHaystack = compactNormalize(JSON.stringify(payload));
  const compactExpected = compactNormalize(expectedAnswer);
  if (!expected) {
    return false;
  }
  if (haystack.includes(expected)) {
    return true;
  }
  if (compactExpected && compactHaystack.includes(compactExpected)) {
    return true;
  }
  if (compactListPass(expectedAnswer, compactHaystack)) {
    return true;
  }
  const expectedTokens = expected.split(" ").filter((token) => token.length > 2);
  const hitCount = expectedTokens.filter((token) => haystack.includes(token)).length;
  return expectedTokens.length > 0 && hitCount / expectedTokens.length >= 0.6;
}

function normalizedAnswerPass(expectedAnswer: string, payload: any): boolean {
  const candidates = [
    payload?.duality?.claim?.text,
    payload?.summaryText,
    payload?.claimText,
    payload?.explanation,
    ...(Array.isArray(payload?.duality?.evidence) ? payload.duality.evidence.map((item: any) => item?.snippet) : [])
  ]
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .map((item) => normalize(item));
  const compactCandidates = [
    payload?.duality?.claim?.text,
    payload?.summaryText,
    payload?.claimText,
    payload?.explanation,
    ...(Array.isArray(payload?.duality?.evidence) ? payload.duality.evidence.map((item: any) => item?.snippet) : [])
  ]
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .map((item) => compactNormalize(item));
  const expected = normalize(expectedAnswer);
  const compactExpected = compactNormalize(expectedAnswer);
  if (!expected || candidates.length === 0) {
    return false;
  }
  if (candidates.some((candidate) => candidate.includes(expected))) {
    return true;
  }
  if (compactExpected && compactCandidates.some((candidate) => candidate.includes(compactExpected))) {
    return true;
  }
  if (compactCandidates.some((candidate) => compactListPass(expectedAnswer, candidate))) {
    return true;
  }
  const expectedTokens = expected.split(" ").filter((token) => token.length > 2);
  return candidates.some((candidate) => {
    const hitCount = expectedTokens.filter((token) => candidate.includes(token)).length;
    return expectedTokens.length > 0 && hitCount / expectedTokens.length >= 0.75;
  });
}

function trimLocomoSnippet(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized ? normalized.slice(0, 220) : null;
}

function renderLocomoAnswerSnippet(payload: any): string {
  const candidates = [
    payload?.duality?.claim?.text,
    payload?.summaryText,
    payload?.claimText,
    payload?.explanation,
    payload?.duality?.reason,
    ...(Array.isArray(payload?.duality?.evidence) ? payload.duality.evidence.map((item: any) => item?.snippet) : [])
  ];
  for (const candidate of candidates) {
    const snippet = trimLocomoSnippet(candidate);
    if (snippet) {
      return snippet;
    }
  }
  const claimText = trimLocomoSnippet(payload?.duality?.claim?.text ?? payload?.duality?.claim?.answerValue);
  if (claimText) {
    return claimText;
  }
  return JSON.stringify(payload?.duality?.claim ?? payload).slice(0, 220);
}

function adversarialAbstentionPass(payload: any): boolean {
  const claimText = normalize(payload?.duality?.claim?.text);
  const reasonText = normalize(payload?.duality?.reason ?? payload?.meta?.answerAssessment?.reason);
  const sufficiency = typeof payload?.meta?.answerAssessment?.sufficiency === "string"
    ? normalize(payload.meta.answerAssessment.sufficiency)
    : "";
  if (claimText.includes("none") || claimText.includes("unknown")) {
    return true;
  }
  if (claimText.includes("no authoritative evidence") || claimText.includes("not enough evidence")) {
    return true;
  }
  if (reasonText.includes("abstain")) {
    return true;
  }
  return sufficiency === "missing" || sufficiency === "contradicted";
}

function classifyFailure(
  behavior: QueryBehavior,
  passed: boolean,
  questionText: string,
  sufficiency: SufficiencyGrade,
  subjectMatch: SubjectMatch,
  evidenceCount: number,
  sourceCount: number
): FailureClass {
  if (passed) {
    return "pass";
  }
  if (subjectMatch === "mismatched" || subjectMatch === "mixed") {
    return "alias_entity_resolution";
  }
  if (sourceCount === 0 && evidenceCount > 0) {
    return "provenance";
  }
  if (sufficiency === "missing" || sufficiency === "contradicted") {
    return "abstention";
  }
  if (evidenceCount === 0) {
    return behavior === "temporal_detail" ? "temporal" : "retrieval";
  }
  if (behavior === "temporal_detail") {
    return "temporal";
  }
  if (behavior === "commonality" || behavior === "recap" || /\b(both|common|share|together|similar|difference|compare|lately|overall)\b/.test(questionText.toLowerCase())) {
    return "synthesis_commonality";
  }
  if (behavior === "profile") {
    return "answer_shaping";
  }
  if (/\b(current|currently|now|still|latest|changed|switch|moved|former|previous)\b/.test(questionText.toLowerCase())) {
    return "conflict_resolution";
  }
  return "answer_shaping";
}

function requiresSourceBoundReaderEvidence(params: {
  readonly queryBehavior: QueryBehavior;
  readonly finalClaimSource: string | null;
  readonly questionText: string;
}): boolean {
  const source = params.finalClaimSource ?? "";
  if (!["canonical_report", "canonical_profile", "top_snippet", "fallback_derived"].includes(source)) {
    return false;
  }
  if (params.queryBehavior === "direct_fact" || params.queryBehavior === "profile" || params.queryBehavior === "causal") {
    return true;
  }
  return /\b(?:favorite|prefer|interests?|interested|dreams?|goals?|health|position|role|project|items?|bought|purchased|car|pets?|dogs?|books?|meat|when|why|reason|because|motivated?|motivation|inspired?|symboli[sz]e|symbolic|how\s+(?:long|often|many|much|did|does))\b/iu.test(
    params.questionText
  );
}

function isAbstentionClaim(params: {
  readonly finalClaimSource: string | null;
  readonly answerSnippet: string;
}): boolean {
  const source = normalize(params.finalClaimSource);
  const answer = normalize(params.answerSnippet);
  return (
    source.includes("abstention") ||
    answer === "none" ||
    answer === "none." ||
    answer === "unknown" ||
    answer === "unknown." ||
    answer.includes("not enough evidence") ||
    answer.includes("no authoritative evidence")
  );
}

function isExpectedNoAnswerText(expectedAnswer: string): boolean {
  const normalized = normalize(expectedAnswer);
  return normalized === "none" || normalized === "unknown" || normalized === "no answer";
}

function classifyEvidenceTelemetryStatus(params: {
  readonly passed: boolean;
  readonly evidenceCount: number;
  readonly sourceCount: number;
  readonly sourceBoundEvidenceRequired: boolean;
  readonly sourceBoundEvidencePresent: boolean;
  readonly finalClaimSource: string | null;
  readonly answerSnippet: string;
  readonly expectedAnswer: string;
}): EvidenceTelemetryStatus {
  if (params.evidenceCount > 0 && params.sourceCount > 0) {
    return "counted";
  }
  if (params.evidenceCount > 0 && params.sourceCount === 0) {
    return "source_count_missing";
  }
  if (params.sourceBoundEvidencePresent && params.evidenceCount === 0) {
    return "support_present_count_missing";
  }
  if (params.passed && isAbstentionClaim(params) && params.evidenceCount === 0) {
    return "abstention_no_evidence_ok";
  }
  if (
    params.passed &&
    params.sourceBoundEvidenceRequired &&
    !params.sourceBoundEvidencePresent &&
    !isAbstentionClaim(params) &&
    !isExpectedNoAnswerText(params.expectedAnswer)
  ) {
    return "unsupported_success";
  }
  if (params.passed && params.evidenceCount === 0) {
    return "evidence_zero_success_unverified";
  }
  if (!params.passed && params.evidenceCount === 0) {
    return "failure_no_evidence";
  }
  return "unclassified";
}

function numericMetaValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function sourceBoundSupportCountFromPayload(payload: any): number {
  const meta = payload?.meta;
  const candidateCounts = meta?.candidateCountsByStage && typeof meta.candidateCountsByStage === "object"
    ? meta.candidateCountsByStage
    : {};
  const counts = [
    numericMetaValue(meta?.activeSupportCount),
    numericMetaValue(meta?.boundedEventSupportCount),
    numericMetaValue(meta?.temporalFactCount),
    numericMetaValue(meta?.projectionShadowEntryCount),
    numericMetaValue(meta?.readerSelectedUnitCount),
    numericMetaValue(meta?.premiseCount),
    numericMetaValue(candidateCounts?.evidence),
    numericMetaValue(candidateCounts?.compiled_projection),
    numericMetaValue(candidateCounts?.final_results),
    meta?.compiledDirectFactLookupSucceeded === true ? 1 : 0,
    meta?.compiledProfileInferenceLookupSucceeded === true ? 1 : 0,
    meta?.offlineSubstrateLookupSucceeded === true ? numericMetaValue(meta?.offlineSubstrateEvidenceCount) || 1 : 0,
    meta?.sourceBoundedReadSucceeded === true ? 1 : 0
  ];
  return Math.max(0, ...counts);
}

function normalizeEvidenceTelemetryCounts(params: {
  readonly payload: any;
  readonly rawEvidenceCount: number;
  readonly rawSourceCount: number;
  readonly sourceBoundEvidencePresent: boolean;
  readonly sourceBoundSupportCount?: number;
}): {
  readonly evidenceCount: number;
  readonly sourceCount: number;
  readonly sourceBoundSupportCount: number;
} {
  const sourceBoundSupportCount = params.sourceBoundSupportCount ?? sourceBoundSupportCountFromPayload(params.payload);
  if (params.rawEvidenceCount > 0 && sourceBoundSupportCount > 0) {
    return {
      evidenceCount: params.rawEvidenceCount,
      sourceCount: Math.max(1, params.rawSourceCount),
      sourceBoundSupportCount
    };
  }
  if (!params.sourceBoundEvidencePresent || params.rawEvidenceCount > 0) {
    return {
      evidenceCount: params.rawEvidenceCount,
      sourceCount: params.rawSourceCount,
      sourceBoundSupportCount
    };
  }
  return {
    evidenceCount: Math.max(1, sourceBoundSupportCount),
    sourceCount: Math.max(1, params.rawSourceCount),
    sourceBoundSupportCount
  };
}

function classifyResidualOwner(params: {
  readonly passed: boolean;
  readonly failureClass: FailureClass;
  readonly shapingDiagnosis: AnswerShapingDiagnosis | null;
  readonly queryBehavior: QueryBehavior;
  readonly finalClaimSource: string | null;
  readonly evidenceCount: number;
  readonly sourceCount: number;
  readonly sufficiency: SufficiencyGrade;
  readonly subjectMatch: SubjectMatch;
  readonly sourceBoundEvidenceRequired: boolean;
  readonly sourceBoundEvidencePresent: boolean;
  readonly profileTraitResidualOwner?: string | null;
  readonly benchmarkError?: string | null;
}): ResidualOwner {
  if (params.benchmarkError) {
    return "harness";
  }
  if (params.passed) {
    return "pass";
  }
  if (params.profileTraitResidualOwner === "source_missing") {
    return "source_missing";
  }
  if (params.sourceBoundEvidenceRequired && !params.sourceBoundEvidencePresent) {
    return params.evidenceCount === 0 || params.sourceCount === 0 ? "source_missing" : "route_ranking";
  }
  if (params.subjectMatch === "mixed" || params.subjectMatch === "mismatched" || params.subjectMatch === "unknown") {
    return "subject_binding";
  }
  if (params.sufficiency === "missing" && params.evidenceCount === 0) {
    return "source_missing";
  }
  if (params.failureClass === "temporal" || params.shapingDiagnosis === "temporal_rendering_wrong") {
    return "temporal_rendering";
  }
  if (params.shapingDiagnosis === "list_set_rendering_wrong") {
    return "list_set_rendering";
  }
  if (params.finalClaimSource === "canonical_report" || params.finalClaimSource === "canonical_profile") {
    return "report_semantics";
  }
  if (params.failureClass === "retrieval" || params.failureClass === "abstention") {
    return params.evidenceCount > 0 ? "route_ranking" : "source_missing";
  }
  if (params.failureClass === "alias_entity_resolution") {
    return "subject_binding";
  }
  if (params.failureClass === "answer_shaping") {
    return "report_semantics";
  }
  return "compiler_missing";
}

function isProfileTraitCoverageAuditQuestion(questionText: string): boolean {
  const normalized = questionText.toLowerCase();
  if (/\b(would|could|should|is|are|was|were)\b.+\b(considered|likely|seem|appear|be)\b/.test(normalized)) {
    return true;
  }
  if (/\b(personality|patriotic|religious|spiritual|political|supportive|ally|values?|stance|identity)\b/.test(normalized)) {
    return true;
  }
  if (/\bwhat\b.+\b(financial status|identity|beliefs?|politics?|focus)\b/.test(normalized)) {
    return true;
  }
  return false;
}

function classifyQueryBehavior(questionText: string): QueryBehavior {
  const planner = planRecallQuery({
    query: questionText,
    namespaceId: "benchmark_locomo_probe"
  });
  if (isPreciseFactDetailQuery(questionText)) {
    return "exact_detail";
  }
  if (isTemporalDetailQuery(questionText) || planner.queryClass === "temporal_detail") {
    return "temporal_detail";
  }
  if (isSharedCommonalityQuery(questionText) || /\b(lately|overall|compare|common|share|both|together|difference)\b/i.test(questionText)) {
    return "commonality";
  }
  if (isProfileInferenceQuery(questionText) || isIdentityProfileQuery(questionText)) {
    return "profile";
  }
  if (planner.queryClass === "causal" || /\bwhy\b/i.test(questionText)) {
    return "causal";
  }
  if (/\b(talk about|discuss|conversation|recap|summary|summarize|going on)\b/i.test(questionText)) {
    return "recap";
  }
  if (planner.queryClass === "direct_fact") {
    return "direct_fact";
  }
  return "other";
}

function countBy<T extends string>(values: readonly (T | null | undefined)[], expected: readonly T[]): Readonly<Record<T, number>> {
  const counts = Object.fromEntries(expected.map((value) => [value, 0])) as Record<T, number>;
  for (const value of values) {
    if (value && value in counts) {
      counts[value] += 1;
    }
  }
  return counts;
}

function resolveClusterStopEnabled(): boolean {
  return isTruthyEnv(process.env.BRAIN_LOCOMO_CLUSTER_STOP);
}

function clusterStopReasonForResults(results: readonly QueryResult[]): string | null {
  if (results.length === 0) {
    return null;
  }
  const failures = results.filter((result) => result.passed !== true);
  if (failures.length === 0) {
    return null;
  }
  const ownerCounts = countBy(
    failures.map((result) => result.residualOwner),
    [
      "pass",
      "report_semantics",
      "subject_binding",
      "temporal_rendering",
      "list_set_rendering",
      "route_ranking",
      "source_missing",
      "compiler_missing",
      "harness"
    ]
  );
  for (const [owner, count] of Object.entries(ownerCounts)) {
    if (owner === "pass" || count <= 0) {
      continue;
    }
    const share = count / Math.max(1, failures.length);
    if (count > 20) {
      return `cluster_stop_owner_count_${owner}_${count}`;
    }
    if (share >= 0.3 && count >= 5) {
      return `cluster_stop_owner_share_${owner}_${count}_of_${failures.length}`;
    }
  }
  return null;
}

function rate(numerator: number, denominator: number): number {
  if (denominator <= 0) {
    return 0;
  }
  return Number((numerator / denominator).toFixed(3));
}

async function cleanupBenchmarkNamespace(namespaceId: string): Promise<void> {
  try {
    await cleanupPublicBenchmarkNamespaces([namespaceId], {
      namespaceChunkSize: 1,
      statementTimeoutMs: 15_000,
      lockTimeoutMs: 2_000,
      logger: (message) => benchmarkLog(`cleanup detail namespaceId=${namespaceId} ${message}`)
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    benchmarkLog(`cleanup warning namespaceId=${namespaceId} reason=${JSON.stringify(message)}`);
  }
}

export async function runAndWriteLoCoMoBenchmark(): Promise<{
  readonly report: LoCoMoReport;
  readonly output: { readonly jsonPath: string; readonly markdownPath: string };
}> {
  return withMaintenanceLock("the LoCoMo compatibility benchmark", async () => {
    const runStamp = new Date().toISOString().replace(/[:.]/g, "-");
    const queryTimeoutMs = resolveBenchmarkTimeoutMs();
    const heartbeatMs = resolveHeartbeatMs();
    const partialFlushEvery = resolvePartialFlushEvery();
    const sampleDelayMs = resolveOptionalDelayMs("BRAIN_BENCHMARK_SAMPLE_DELAY_MS");
    const ingestDelayMs = resolveOptionalDelayMs("BRAIN_BENCHMARK_INGEST_DELAY_MS");
    const rebuildDelayMs = resolveOptionalDelayMs("BRAIN_BENCHMARK_REBUILD_DELAY_MS");
    const questionDelayMs = resolveOptionalDelayMs("BRAIN_BENCHMARK_QUESTION_DELAY_MS");
    const gitCommit = resolveGitCommit();
    benchmarkLog(`start runStamp=${runStamp} queryTimeoutMs=${queryTimeoutMs} heartbeatMs=${heartbeatMs} partialFlushEvery=${partialFlushEvery}`);
    benchmarkLog(
      `pacing sampleDelayMs=${sampleDelayMs} ingestDelayMs=${ingestDelayMs} rebuildDelayMs=${rebuildDelayMs} questionDelayMs=${questionDelayMs}`
    );
    const raw = await downloadCached(
      "https://raw.githubusercontent.com/snap-research/locomo/main/data/locomo10.json",
      "locomo10.json"
    );
    const parsed = JSON.parse(raw) as readonly LocomoConversation[];
    const selectedSampleIds = resolveSelectedLoCoMoSampleIds(process.env.BRAIN_LOCOMO_SAMPLE_IDS);
    const selectedQuestionKeys = resolveSelectedLoCoMoQuestionKeys(process.env.BRAIN_LOCOMO_QUESTION_KEYS);
    const conversationCount = resolveRequestedSampleCount(process.env.BRAIN_LOCOMO_SAMPLE_CONVERSATIONS, 2, parsed.length);
    const requestedQuestionCountPerConversation = resolveRequestedQuestionCount(
      process.env.BRAIN_LOCOMO_SAMPLE_QUESTIONS,
      5
    );
    const stratifiedQuestionSampling = isTruthyEnv(process.env.BRAIN_LOCOMO_STRATIFIED);
    const perCategoryQuestionLimit = resolveOptionalPositiveInt(process.env.BRAIN_LOCOMO_CATEGORY_LIMIT);
    const skipCleanup = shouldSkipPublicBenchmarkCleanup();
    const selected =
      selectedSampleIds.length > 0
        ? parsed.filter((sample) => selectedSampleIds.includes(sample.sample_id))
        : parsed.slice(0, conversationCount);
    const selectedWithQuestions = selected.map((sample) => ({
      sample,
      questions: (() => {
        const explicitQuestionIndexes = selectedQuestionKeys.get(sample.sample_id);
        if (explicitQuestionIndexes && explicitQuestionIndexes.size > 0) {
          return sample.qa.flatMap((qa, index) =>
            explicitQuestionIndexes.has(index)
              ? [{
                  qa,
                  originalIndex: index
                } satisfies SelectedLoCoMoQuestion]
              : []
          );
        }
        const selectedQuestions = selectLoCoMoQuestions(sample.qa, requestedQuestionCountPerConversation, {
          stratified: stratifiedQuestionSampling,
          perCategoryLimit: perCategoryQuestionLimit
        });
        return sample.qa.flatMap((qa, index) =>
          selectedQuestions.includes(qa)
            ? [{
                qa,
                originalIndex: index
              } satisfies SelectedLoCoMoQuestion]
            : []
        );
      })()
    }));
    const totalQuestionsPlanned = selectedWithQuestions.reduce((sum, entry) => sum + entry.questions.length, 0);
    const results: QueryResult[] = [];
    const latencies: number[] = [];
    const corpusRoot = path.join(generatedRoot(), "locomo");
    await mkdir(corpusRoot, { recursive: true });
    const benchmarkMode =
      conversationCount >= parsed.length && requestedQuestionCountPerConversation === "full" ? "full" : "sampled";
    const runtimeBase = buildBenchmarkRuntimeMetadata({
      benchmarkMode,
      sampleControls: {
        requestedConversationCount: process.env.BRAIN_LOCOMO_SAMPLE_CONVERSATIONS ?? null,
        resolvedConversationCount: conversationCount,
        requestedQuestionCountPerConversation: process.env.BRAIN_LOCOMO_SAMPLE_QUESTIONS ?? null,
        resolvedQuestionCountPerConversation:
          requestedQuestionCountPerConversation === "full" ? "full" : requestedQuestionCountPerConversation,
        selectedSampleIds: selectedSampleIds.length > 0 ? selectedSampleIds.join(",") : null,
        selectedQuestionKeys:
          selectedQuestionKeys.size > 0
            ? [...selectedQuestionKeys.entries()]
                .flatMap(([sampleId, indexes]) => [...indexes.values()].map((index) => `${sampleId}#${index}`))
                .join(",")
            : null,
        stratifiedQuestionSampling,
        perCategoryQuestionLimit,
        totalConversationCount: parsed.length,
        skipCleanup,
        queryTimeoutMs,
        heartbeatMs,
        partialFlushEvery,
        sampleDelayMs,
        ingestDelayMs,
        rebuildDelayMs,
        questionDelayMs,
        gitCommit
      }
    });
    const config = readConfig();
    let vectorActivation = createBenchmarkVectorActivationAccumulator(
      "benchmark",
      config.benchmarkVectorActivationMode,
      runtimeBase.embeddingProvider,
      runtimeBase.embeddingModel
    );
    const runtime = (): BenchmarkRuntimeMetadata =>
      buildBenchmarkRuntimeMetadata({
        benchmarkMode,
        sampleControls: runtimeBase.sampleControls,
        vectorActivation: buildBenchmarkVectorActivationMetadata(vectorActivation)
      });
    let currentSampleId: string | null = null;
    let currentQuestionIndex: number | null = null;
    let completedQuestions = 0;
    let lastProgressAtMs = Date.now();
    let clusterStopReason: string | null = null;
    const clusterStopEnabled = resolveClusterStopEnabled();

    const currentProgress = (): LoCoMoProgressState => ({
      runStamp,
      currentSampleId,
      currentQuestionIndex,
      totalQuestionsPlanned,
      completedQuestions,
      lastProgressAt: new Date(lastProgressAtMs).toISOString()
    });

    const flushPartial = async (failureReason?: string): Promise<void> => {
      const partialPath = await writePartialArtifact(runtime(), currentProgress(), latencies, results, failureReason);
      benchmarkLog(`partial artifact wrote path=${partialPath} results=${results.length} completed=${completedQuestions}/${totalQuestionsPlanned}${failureReason ? ` reason=${failureReason}` : ""}`);
    };

    const heartbeat = setInterval(() => {
      const ageMs = Date.now() - lastProgressAtMs;
      benchmarkLog(
        `heartbeat completed=${completedQuestions}/${totalQuestionsPlanned} sample=${currentSampleId ?? "none"} questionIndex=${currentQuestionIndex ?? "none"} idleMs=${ageMs}`
      );
    }, heartbeatMs);

    const signalHandler = (signal: NodeJS.Signals): void => {
      benchmarkLog(`received ${signal}; attempting partial artifact flush`);
      void flushPartial(`interrupted_by_${signal.toLowerCase()}`);
    };

    process.once("SIGINT", signalHandler);
    process.once("SIGTERM", signalHandler);

    if (!shouldSkipPublicBenchmarkPreflight()) {
      benchmarkLog("preflight start");
      await runBenchmarkNamespacePreflight(benchmarkLog);
      await runBenchmarkSchemaPreflight(benchmarkLog);
      benchmarkLog("preflight complete");
    } else {
      benchmarkLog("preflight skipped");
    }

    const buildReport = (): LoCoMoReport => {
      const passRate = Number((results.filter((result) => result.passed).length / Math.max(1, results.length)).toFixed(3));
      const exactAnswerDominantMargins = results
        .map((result) => result.exactAnswerDominantMargin)
        .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
      const categoryBreakdown = Object.fromEntries(
        [...new Set(results.map((result) => result.category).sort((left, right) => left - right))].map((category) => {
          const categoryResults = results.filter((result) => result.category === category);
          return [
            String(category),
            {
              sampleCount: categoryResults.length,
              passRate: Number((categoryResults.filter((result) => result.passed).length / Math.max(1, categoryResults.length)).toFixed(3)),
              failureBreakdown: countBy(
                categoryResults.map((result) => result.failureClass),
                [
                  "pass",
                  "retrieval",
                  "temporal",
                  "provenance",
                  "answer_shaping",
                  "synthesis_commonality",
                  "conflict_resolution",
                  "alias_entity_resolution",
                  "abstention"
                ]
              )
            }
          ];
        })
      );
      const reflectedResults = results.filter((result) => result.recursiveReflectApplied);
      const exactDetailResults = results.filter((result) => result.queryBehavior === "exact_detail");
      const temporalResults = results.filter((result) => result.queryBehavior === "temporal_detail");
      const commonalityResults = results.filter((result) => result.queryBehavior === "commonality");
      const aliasTargetResults = results.filter((result) => result.failureClass === "pass" || result.failureClass === "alias_entity_resolution");
      const answerShapingResults = results.filter((result) => result.failureClass === "pass" || result.failureClass === "answer_shaping");
      const mixedOrMismatchedResults = results.filter((result) => result.subjectMatch === "mixed" || result.subjectMatch === "mismatched");
      const nonEmptyTokenScores = results
        .map((result) => tokenOverlapScore(result.expectedAnswer, result.answerSnippet))
        .filter((score): score is TokenOverlapScore => score !== null);
      const avgTokenMetric = (key: keyof TokenOverlapScore): number =>
        nonEmptyTokenScores.length > 0
          ? Number(
              (
                nonEmptyTokenScores.reduce((sum, score) => sum + score[key], 0) /
                Math.max(1, nonEmptyTokenScores.length)
              ).toFixed(3)
            )
          : 0;
      const catalog = buildBenchmarkCatalog(
        results.map((result) => ({
          id: `${result.sampleId}:${result.questionIndex}`,
          passed: result.passed,
          normalizedPassed: result.normalizedPassed,
          failureClass: result.failureClass,
          queryBehavior: result.queryBehavior,
          finalClaimSource: result.finalClaimSource,
          latencyMs: result.latencyMs
        }))
      );
      return {
        generatedAt: new Date().toISOString(),
        dataset: "locomo10",
        runtime: runtime(),
        sampleCount: results.length,
        passRate,
        latency: catalog.latency,
        diagnostics: {
          failureBreakdown: countBy(
            results.map((result) => result.failureClass),
            [
              "pass",
              "retrieval",
              "temporal",
              "provenance",
              "answer_shaping",
              "synthesis_commonality",
              "conflict_resolution",
              "alias_entity_resolution",
              "abstention"
            ]
          ),
          sufficiencyBreakdown: countBy(results.map((result) => result.sufficiency), ["supported", "weak", "missing", "contradicted"]),
          subjectMatchBreakdown: countBy(results.map((result) => result.subjectMatch), ["matched", "mixed", "mismatched", "unknown"]),
          synthesisModeBreakdown: countBy(results.map((result) => result.synthesisMode), ["recall", "reflect"]),
          reflectHelpedRate: rate(reflectedResults.filter((result) => result.reflectHelped).length, reflectedResults.length),
          reflectNoGainRate: rate(reflectedResults.filter((result) => result.reflectOutcome === "no_gain").length, reflectedResults.length),
          reflectHarmRate: rate(reflectedResults.filter((result) => result.reflectOutcome === "harmful").length, reflectedResults.length),
          answerShapingPassRate: rate(answerShapingResults.filter((result) => result.passed).length, answerShapingResults.length),
          aliasEntityResolutionPassRate: rate(aliasTargetResults.filter((result) => result.passed).length, aliasTargetResults.length),
          exactDetailPrecision: rate(exactDetailResults.filter((result) => result.passed).length, exactDetailResults.length),
          temporalAnchorHitRate: rate(temporalResults.filter((result) => result.passed).length, temporalResults.length),
          commonalityOverlapPrecision: rate(commonalityResults.filter((result) => result.passed).length, commonalityResults.length),
          nonEmptyAnswerTokenPrecision: avgTokenMetric("precision"),
          nonEmptyAnswerTokenRecall: avgTokenMetric("recall"),
          nonEmptyAnswerTokenF1: avgTokenMetric("f1"),
          shapingDiagnosisBreakdown: countBy(
            results.map((result) => result.shapingDiagnosis),
            [
              "wrong_owner",
              "right_owner_wrong_shape",
              "right_owner_incomplete_support",
              "temporal_rendering_wrong",
              "report_semantics_wrong",
              "list_set_rendering_wrong",
              "subject_binding_missing",
              "honest_abstention_but_support_missing"
            ]
          ),
          residualOwnerBreakdown: countBy(
            results.map((result) => result.residualOwner),
            [
              "pass",
              "report_semantics",
              "subject_binding",
              "temporal_rendering",
              "list_set_rendering",
              "route_ranking",
              "source_missing",
              "compiler_missing",
              "harness"
            ]
          ),
          unsupportedNoEvidenceSuccessCount: results.filter(
            (result) =>
              result.passed &&
              result.sourceBoundEvidenceRequired &&
              !result.sourceBoundEvidencePresent &&
              !/\babstention\b/iu.test(result.finalClaimSource ?? "") &&
              normalize(result.expectedAnswer) !== "none"
          ).length,
          compiledDirectFactLookupTriedCount: results.filter((result) => result.compiledDirectFactLookupTried === true).length,
          compiledDirectFactLookupSucceededCount: results.filter((result) => result.compiledDirectFactLookupSucceeded === true).length,
          compiledProfileInferenceLookupTriedCount: results.filter((result) => result.compiledProfileInferenceLookupTried === true).length,
          compiledProfileInferenceLookupSucceededCount: results.filter((result) => result.compiledProfileInferenceLookupSucceeded === true).length,
          sourceBoundFallbackUsedCount: results.filter((result) => result.sourceBoundFallbackUsed === true).length,
          queryTimeExtractorUsedCount: results.filter((result) => result.queryTimeExtractorUsed === true).length,
          queryTimeGLiNEROrLLMCallCount: results.filter((result) => result.queryTimeGLiNEROrLLMUsed === true).length,
          offlineSubstrateLookupTriedCount: results.filter((result) => result.offlineSubstrateLookupTried === true).length,
          offlineSubstrateLookupSucceededCount: results.filter((result) => result.offlineSubstrateLookupSucceeded === true).length,
          offlineSubstrateEvidenceZeroCount: results.filter(
            (result) => result.offlineSubstrateLookupSucceeded === true && (result.offlineSubstrateEvidenceCount ?? 0) <= 0
          ).length,
          mixedSubjectDiscardRate: rate(
            mixedOrMismatchedResults.filter((result) => result.sufficiency === "missing" || result.sufficiency === "contradicted").length,
            mixedOrMismatchedResults.length
          ),
          exactAnswerWindowCount: results.reduce((sum, result) => sum + result.exactAnswerWindowCount, 0),
          exactAnswerSafeWindowCount: results.reduce((sum, result) => sum + result.exactAnswerSafeWindowCount, 0),
          exactAnswerDiscardedMixedWindowCount: results.reduce((sum, result) => sum + result.exactAnswerDiscardedMixedWindowCount, 0),
          exactAnswerDiscardedForeignWindowCount: results.reduce((sum, result) => sum + result.exactAnswerDiscardedForeignWindowCount, 0),
          exactAnswerCandidateCount: results.reduce((sum, result) => sum + result.exactAnswerCandidateCount, 0),
          exactAnswerAbstainedForAmbiguityRate: rate(
            results.filter((result) => result.exactAnswerAbstainedForAmbiguity).length,
            results.length
          ),
          exactAnswerAverageDominantMargin:
            exactAnswerDominantMargins.length > 0
              ? Number(
                  (
                    exactAnswerDominantMargins.reduce((sum, value) => sum + value, 0) /
                    Math.max(1, exactAnswerDominantMargins.length)
                  ).toFixed(3)
                )
              : 0,
          answerableUnitAppliedRate: rate(
            results.filter((result) => result.answerableUnitApplied).length,
            results.length
          ),
          readerResolvedRate: rate(
            results.filter((result) => result.readerDecision === "resolved").length,
            results.filter((result) => result.readerApplied).length
          ),
          readerAbstainRate: rate(
            results.filter((result) => result.readerApplied && result.readerDecision !== "resolved").length,
            results.filter((result) => result.readerApplied).length
          ),
          readerAliasSafeClaimRate: rate(
            results.filter((result) => (result.failureClass === "pass" || result.failureClass === "alias_entity_resolution") && result.readerDecision === "resolved" && result.passed).length,
            results.filter((result) => result.failureClass === "pass" || result.failureClass === "alias_entity_resolution").length
          ),
          readerTemporalAnchorHitRate: rate(
            results.filter((result) => result.queryBehavior === "temporal_detail" && result.readerDecision === "resolved" && result.passed).length,
            results.filter((result) => result.queryBehavior === "temporal_detail").length
          ),
          resolverAppliedRate: rate(
            results.filter((result) => result.resolverApplied).length,
            results.length
          ),
          resolverResolvedRate: rate(
            results.filter((result) => result.resolverStatus === "resolved").length,
            results.filter((result) => result.resolverApplied).length
          ),
          ownershipWindowCount: results.reduce((sum, result) => sum + result.ownershipWindowCount, 0),
          ownershipOwnedCount: results.reduce((sum, result) => sum + result.ownershipOwnedCount, 0),
          ownershipMixedCount: results.reduce((sum, result) => sum + result.ownershipMixedCount, 0),
          ownershipForeignCount: results.reduce((sum, result) => sum + result.ownershipForeignCount, 0),
          fallbackSuppressedCount: results.reduce((sum, result) => sum + result.fallbackSuppressedCount, 0),
          ownedWindowUsedForFinalClaimRate: rate(
            results.filter((result) => result.ownedWindowUsedForFinalClaim).length,
            results.filter((result) => result.resolverApplied).length
          ),
          subjectIsolationAppliedRate: rate(
            results.filter((result) => result.subjectIsolationApplied).length,
            results.length
          ),
          subjectIsolationOwnedCount: results.reduce((sum, result) => sum + result.subjectIsolationOwnedCount, 0),
          subjectIsolationDiscardedMixedCount: results.reduce((sum, result) => sum + result.subjectIsolationDiscardedMixedCount, 0),
          subjectIsolationDiscardedForeignCount: results.reduce((sum, result) => sum + result.subjectIsolationDiscardedForeignCount, 0),
          subjectIsolationTopResultOwnedRate: rate(
            results.filter((result) => result.subjectIsolationApplied && result.subjectIsolationTopResultOwned).length,
            results.filter((result) => result.subjectIsolationApplied).length
          ),
          categoryBreakdown
        },
        catalog,
        results,
        passed: passRate >= 0.5
      };
    };

    try {
      for (const entry of selectedWithQuestions) {
        const sample = entry.sample;
        currentSampleId = sample.sample_id;
        currentQuestionIndex = null;
        benchmarkLog(`sample start sampleId=${sample.sample_id} questions=${entry.questions.length}`);
        const namespaceId = `benchmark_locomo_${runStamp}_${sample.sample_id.replace(/[^a-z0-9]+/gi, "_").toLowerCase()}`;
        try {
          const sessionEntries = Object.entries(sample.conversation).filter(
            ([key, value]) => key.startsWith("session_") && Array.isArray(value)
          ) as Array<[string, readonly TurnRecord[]]>;

          for (const [sessionKey, turns] of sessionEntries) {
            benchmarkLog(`ingest start sampleId=${sample.sample_id} session=${sessionKey}`);
            const sessionDeadlineMs = Date.now() + queryTimeoutMs;
            await withBenchmarkTimeout(`ingest ${sample.sample_id}/${sessionKey}`, queryTimeoutMs, async () => {
              const ingestResult = await ingestLoCoMoSessionArtifacts({
                localBrainRoot: localBrainRoot(),
                benchmarkName: "locomo",
                corpusRoot,
                namespaceId,
                sample,
                sessionKey,
                turns,
                sessionDeadlineMs
              });
              if (
                ingestResult.imageArtifactCount > 0 ||
                ingestResult.skippedImageCount > 0 ||
                ingestResult.proxyImageArtifactCount > 0
              ) {
                benchmarkLog(
                  `ingest images sampleId=${sample.sample_id} session=${sessionKey} artifacts=${ingestResult.imageArtifactCount} derived=${ingestResult.derivedImageCount} cacheHits=${ingestResult.imageDerivationCacheHits} skipped=${ingestResult.skippedImageCount} proxies=${ingestResult.proxyImageArtifactCount}`
                );
              }
            });
            benchmarkLog(`ingest complete sampleId=${sample.sample_id} session=${sessionKey}`);
            lastProgressAtMs = Date.now();
            if (ingestDelayMs > 0) {
              await sleepMs(ingestDelayMs);
            }
          }

          benchmarkLog(`typed rebuild start sampleId=${sample.sample_id} namespaceId=${namespaceId}`);
          await withBenchmarkTimeout(`typed rebuild ${sample.sample_id}`, queryTimeoutMs, async () => {
            await rebuildTypedMemoryNamespace(namespaceId);
          });
          benchmarkLog(`typed rebuild complete sampleId=${sample.sample_id} namespaceId=${namespaceId}`);
          const vectorActivationResult = await runNamespaceVectorActivation({
            namespaceId,
            scope: "benchmark",
            reason: "benchmark_locomo"
          });
          vectorActivation = mergeBenchmarkVectorActivation(vectorActivation, vectorActivationResult);
          benchmarkLog(
            `vector activation sampleId=${sample.sample_id} available=${vectorActivationResult.available} semantic=${vectorActivationResult.coverage.semanticEmbedded}/${vectorActivationResult.coverage.semanticTotal} derivations=${vectorActivationResult.coverage.derivationEmbedded}/${vectorActivationResult.coverage.derivationTotal} pending=${vectorActivationResult.remainingPending}`
          );
          lastProgressAtMs = Date.now();
          if (rebuildDelayMs > 0) {
            await sleepMs(rebuildDelayMs);
          }

          if (isTruthyEnv(process.env.BRAIN_ENABLE_OFFLINE_SUBSTRATE_BUILD)) {
            benchmarkLog(`offline substrate build start sampleId=${sample.sample_id} namespaceId=${namespaceId}`);
            const substrateSummary = await withBenchmarkTimeout(`offline substrate build ${sample.sample_id}`, queryTimeoutMs, async () =>
              promoteOfflineSubstrateForLoCoMoQuestions({
                namespaceId,
                sample,
                questions: entry.questions.map(({ qa, originalIndex }) => ({
                  question: qa.question,
                  questionIndex: originalIndex,
                  queryBehavior: classifyQueryBehavior(qa.question),
                  residualOwner: null
                }))
              })
            );
            benchmarkLog(
              `offline substrate build complete sampleId=${sample.sample_id} namespaceId=${namespaceId} materialized=${substrateSummary.materializedRowsUsable}/${substrateSummary.materializedRowsWritten} event=${substrateSummary.eventRowsUsable}/${substrateSummary.eventRowsWritten} withoutQuote=${substrateSummary.rowsWithoutSourceQuote} expectedAnswerPromotionUse=${substrateSummary.expectedAnswerPromotionUseRows} missingSourceDerived=${substrateSummary.missingSourceDerivedMetadataRows} mixedOwner=${substrateSummary.mixedOwnerRows} unknownFamily=${substrateSummary.unknownFamilyRows} identityFromSupport=${substrateSummary.identityMembershipInferredFromSupportRows}`
            );
            lastProgressAtMs = Date.now();
          }

          for (const { qa, originalIndex } of entry.questions) {
            currentQuestionIndex = originalIndex;
            lastProgressAtMs = Date.now();
            const queryBehavior = classifyQueryBehavior(qa.question);
            const questionOrdinal = completedQuestions + 1;
            benchmarkLog(
              `question start ${questionOrdinal}/${totalQuestionsPlanned} sampleId=${sample.sample_id} index=${originalIndex} category=${qa.category} behavior=${queryBehavior} query=${JSON.stringify(qa.question.slice(0, 140))}`
            );
            const startedAt = performance.now();
            let payload: any = null;
            let benchmarkError: string | null = null;
            try {
              payload = await executeSearchIsolated(
                `memory.search ${sample.sample_id}#${originalIndex}`,
                namespaceId,
                qa.question,
                8,
                queryTimeoutMs,
              );
            } catch (error) {
              benchmarkError = error instanceof Error ? error.message : String(error);
              benchmarkLog(
                `question error ${questionOrdinal}/${totalQuestionsPlanned} sampleId=${sample.sample_id} index=${originalIndex} message=${JSON.stringify(benchmarkError)}`
              );
            }

            const latencyMs = Number((performance.now() - startedAt).toFixed(2));
            latencies.push(latencyMs);
            if (benchmarkError) {
              results.push({
                sampleId: sample.sample_id,
                questionIndex: originalIndex,
                category: qa.category,
                question: qa.question,
                expectedAnswer: benchmarkExpectedAnswer(qa),
                queryBehavior,
                passed: false,
                normalizedPassed: false,
                failureClass: queryBehavior === "temporal_detail" ? "temporal" : "retrieval",
                confidence: null,
                sufficiency: "missing",
                subjectMatch: "unknown",
                synthesisMode: null,
                recursiveReflectApplied: false,
                reflectHelped: false,
                reflectOutcome: null,
                adequacyStatus: null,
                missingInfoType: null,
                exactAnswerWindowCount: 0,
                exactAnswerSafeWindowCount: 0,
                exactAnswerDiscardedMixedWindowCount: 0,
                exactAnswerDiscardedForeignWindowCount: 0,
                exactAnswerCandidateCount: 0,
                exactAnswerDominantMargin: null,
                exactAnswerAbstainedForAmbiguity: false,
                answerableUnitApplied: false,
                answerableUnitCandidateCount: 0,
                answerableUnitOwnedCount: 0,
                answerableUnitMixedCount: 0,
                answerableUnitForeignCount: 0,
                readerApplied: false,
                readerDecision: null,
                readerSelectedUnitCount: 0,
                readerTopUnitType: null,
                readerDominantMargin: null,
                readerAbstainedAliasAmbiguity: false,
                readerAbstainedTemporalGap: false,
                readerUsedFallback: false,
                resolverApplied: false,
                resolverStatus: null,
                resolverTopMargin: null,
                ownershipWindowCount: 0,
                ownershipOwnedCount: 0,
                ownershipMixedCount: 0,
                ownershipForeignCount: 0,
                fallbackSuppressedCount: 0,
                ownedWindowUsedForFinalClaim: false,
                subjectIsolationApplied: false,
                subjectIsolationOwnedCount: 0,
                subjectIsolationDiscardedMixedCount: 0,
                subjectIsolationDiscardedForeignCount: 0,
                subjectIsolationTopResultOwned: false,
                globalQueryRouted: false,
                summaryRoutingUsed: false,
                branchPruningApplied: false,
                prunedBranches: [],
                stageTimingsMs: null,
                dominantStage: null,
                topStageMs: null,
                neighborExpansionCount: 0,
                typedLaneDepth: 0,
                recursiveSubqueryCount: 0,
                latencyBudgetFamily: null,
                earlyStopReason: null,
                leafTraversalTriggered: false,
                descentTriggered: false,
                descentStages: [],
                initialLaneSufficiency: null,
                finalLaneSufficiency: null,
                reducerFamily: null,
                finalClaimSource: null,
                sourceBoundEvidenceRequired: false,
                sourceBoundEvidencePresent: false,
                evidenceTelemetryStatus: "failure_no_evidence",
                readerEvidenceDisciplineStatus: "benchmark_transport_error",
                readerResidualOwner: "harness",
                compiledDirectFactLookupTried: false,
                compiledDirectFactLookupSucceeded: false,
                directFactFamily: null,
                compiledDirectFactCoverageStatus: null,
                sourceBoundFallbackUsed: false,
                queryTimeExtractorUsed: false,
                queryTimeGLiNEROrLLMUsed: false,
                residualOwner: "harness",
                ownerEvidence: {
                  queryBehavior,
                  finalClaimSource: null,
                  evidenceCount: 0,
                  sourceCount: 0,
                  subjectMatch: "unknown",
                  sufficiency: "missing",
                  dominantStage: null,
                  sourceBoundEvidenceRequired: false,
                  sourceBoundEvidencePresent: false,
                  readerEvidenceDisciplineStatus: "benchmark_transport_error"
                },
                retrievalMode: null,
                vectorCandidateCount: 0,
                vectorContributedToFinalSupport: false,
                answerShapingTrace: null,
                shapingDiagnosis: "not_applicable",
                fallbackSuppressedReason: null,
                subjectPlanKind: null,
                pairPlanUsed: false,
                canonicalReadTier: null,
                temporalValiditySource: null,
                chainSerializerUsed: false,
                latencyMs,
                evidenceCount: 0,
                sourceCount: 0,
                answerSnippet: `BENCHMARK_ERROR: ${benchmarkError}`.slice(0, 220)
              });
              completedQuestions += 1;
              lastProgressAtMs = Date.now();
              if (completedQuestions % partialFlushEvery === 0) {
                await flushPartial();
              }
              if (clusterStopEnabled) {
                clusterStopReason = clusterStopReasonForResults(results);
                if (clusterStopReason) {
                  benchmarkLog(`cluster stop triggered reason=${clusterStopReason}`);
                  await flushPartial(clusterStopReason);
                  break;
                }
              }
              if (questionDelayMs > 0) {
                await sleepMs(questionDelayMs);
              }
              continue;
            }

            const evidence = Array.isArray(payload?.duality?.evidence) ? payload.duality.evidence : [];
            const answerAssessment = payload?.meta?.answerAssessment ?? payload?.answerAssessment ?? null;
            const rawEvidenceCount = evidence.length;
            const rawSourceCount = evidence.filter(
              (item: any) =>
                typeof item?.artifactId === "string" ||
                typeof item?.sourceUri === "string" ||
                typeof item?.provenance?.source_memory_id === "string" ||
                typeof item?.provenance?.source_chunk_id === "string" ||
                typeof item?.provenance?.source_scene_id === "string"
            ).length;
            const expectedAnswer = benchmarkExpectedAnswer(qa);
            const passed = qa.category === 5 && typeof qa.answer !== "string" && typeof qa.answer !== "number"
              ? adversarialAbstentionPass(payload)
              : bestEffortPass(expectedAnswer, payload);
            const normalizedPassed = qa.category === 5 && typeof qa.answer !== "string" && typeof qa.answer !== "number"
              ? adversarialAbstentionPass(payload)
              : normalizedAnswerPass(expectedAnswer, payload);
            const sufficiency =
              typeof answerAssessment?.sufficiency === "string" ? (answerAssessment.sufficiency as SufficiencyGrade) : null;
            const subjectMatch =
              typeof answerAssessment?.subjectMatch === "string" ? (answerAssessment.subjectMatch as SubjectMatch) : null;
            const synthesisMode =
              typeof payload?.meta?.synthesisMode === "string" ? (payload.meta.synthesisMode as SynthesisMode) : null;
            const recursiveReflectApplied = payload?.meta?.recursiveReflectApplied === true;
            const reflectHelped = payload?.meta?.reflectHelped === true;
            const reflectOutcome =
              typeof payload?.meta?.reflectOutcome === "string" ? (payload.meta.reflectOutcome as ReflectOutcome) : null;
            const adequacyStatus = typeof payload?.meta?.adequacyStatus === "string" ? payload.meta.adequacyStatus : null;
            const missingInfoType = typeof payload?.meta?.missingInfoType === "string" ? payload.meta.missingInfoType : null;
            const exactAnswerWindowCount =
              typeof payload?.meta?.exactAnswerWindowCount === "number" ? payload.meta.exactAnswerWindowCount : 0;
            const exactAnswerSafeWindowCount =
              typeof payload?.meta?.exactAnswerSafeWindowCount === "number" ? payload.meta.exactAnswerSafeWindowCount : 0;
            const exactAnswerDiscardedMixedWindowCount =
              typeof payload?.meta?.exactAnswerDiscardedMixedWindowCount === "number"
                ? payload.meta.exactAnswerDiscardedMixedWindowCount
                : 0;
            const exactAnswerDiscardedForeignWindowCount =
              typeof payload?.meta?.exactAnswerDiscardedForeignWindowCount === "number"
                ? payload.meta.exactAnswerDiscardedForeignWindowCount
                : 0;
            const exactAnswerCandidateCount =
              typeof payload?.meta?.exactAnswerCandidateCount === "number" ? payload.meta.exactAnswerCandidateCount : 0;
            const exactAnswerDominantMargin =
              typeof payload?.meta?.exactAnswerDominantMargin === "number" ? payload.meta.exactAnswerDominantMargin : null;
            const exactAnswerAbstainedForAmbiguity = payload?.meta?.exactAnswerAbstainedForAmbiguity === true;
            const answerableUnitApplied = payload?.meta?.answerableUnitApplied === true;
            const answerableUnitCandidateCount =
              typeof payload?.meta?.answerableUnitCandidateCount === "number" ? payload.meta.answerableUnitCandidateCount : 0;
            const answerableUnitOwnedCount =
              typeof payload?.meta?.answerableUnitOwnedCount === "number" ? payload.meta.answerableUnitOwnedCount : 0;
            const answerableUnitMixedCount =
              typeof payload?.meta?.answerableUnitMixedCount === "number" ? payload.meta.answerableUnitMixedCount : 0;
            const answerableUnitForeignCount =
              typeof payload?.meta?.answerableUnitForeignCount === "number" ? payload.meta.answerableUnitForeignCount : 0;
            const readerApplied = payload?.meta?.readerApplied === true;
            const readerDecision = typeof payload?.meta?.readerDecision === "string" ? payload.meta.readerDecision : null;
            const readerSelectedUnitCount =
              typeof payload?.meta?.readerSelectedUnitCount === "number" ? payload.meta.readerSelectedUnitCount : 0;
            const readerTopUnitType = typeof payload?.meta?.readerTopUnitType === "string" ? payload.meta.readerTopUnitType : null;
            const readerDominantMargin =
              typeof payload?.meta?.readerDominantMargin === "number" ? payload.meta.readerDominantMargin : null;
            const readerAbstainedAliasAmbiguity = payload?.meta?.readerAbstainedAliasAmbiguity === true;
            const readerAbstainedTemporalGap = payload?.meta?.readerAbstainedTemporalGap === true;
            const readerUsedFallback = payload?.meta?.readerUsedFallback === true;
            const resolverApplied = payload?.meta?.resolverApplied === true;
            const resolverStatus =
              typeof payload?.meta?.resolverStatus === "string"
                ? (payload.meta.resolverStatus as "resolved" | "ambiguous" | "unresolved")
                : null;
            const resolverTopMargin =
              typeof payload?.meta?.resolverTopMargin === "number" ? payload.meta.resolverTopMargin : null;
            const ownershipWindowCount =
              typeof payload?.meta?.ownershipWindowCount === "number" ? payload.meta.ownershipWindowCount : 0;
            const ownershipOwnedCount =
              typeof payload?.meta?.ownershipOwnedCount === "number" ? payload.meta.ownershipOwnedCount : 0;
            const ownershipMixedCount =
              typeof payload?.meta?.ownershipMixedCount === "number" ? payload.meta.ownershipMixedCount : 0;
            const ownershipForeignCount =
              typeof payload?.meta?.ownershipForeignCount === "number" ? payload.meta.ownershipForeignCount : 0;
            const fallbackSuppressedCount =
              typeof payload?.meta?.fallbackSuppressedCount === "number" ? payload.meta.fallbackSuppressedCount : 0;
            const ownedWindowUsedForFinalClaim = payload?.meta?.ownedWindowUsedForFinalClaim === true;
            const subjectIsolationApplied = payload?.meta?.subjectIsolationApplied === true;
            const subjectIsolationOwnedCount =
              typeof payload?.meta?.subjectIsolationOwnedCount === "number" ? payload.meta.subjectIsolationOwnedCount : 0;
            const subjectIsolationDiscardedMixedCount =
              typeof payload?.meta?.subjectIsolationDiscardedMixedCount === "number"
                ? payload.meta.subjectIsolationDiscardedMixedCount
                : 0;
            const subjectIsolationDiscardedForeignCount =
              typeof payload?.meta?.subjectIsolationDiscardedForeignCount === "number"
                ? payload.meta.subjectIsolationDiscardedForeignCount
                : 0;
            const subjectIsolationTopResultOwned = payload?.meta?.subjectIsolationTopResultOwned === true;
            const branchPruningApplied = payload?.meta?.branchPruningApplied === true;
            const prunedBranches = Array.isArray(payload?.meta?.prunedBranches)
              ? payload.meta.prunedBranches.filter((value: unknown): value is string => typeof value === "string")
              : [];
            const stageTimingsMs = (() => {
              if (!payload?.meta?.stageTimingsMs || typeof payload.meta.stageTimingsMs !== "object") {
                return null;
              }
              const timings: Record<string, number> = {};
              for (const [key, value] of Object.entries(payload.meta.stageTimingsMs)) {
                if (typeof key === "string" && typeof value === "number") {
                  timings[key] = value;
                }
              }
              return timings;
            })();
            const dominantStage = typeof payload?.meta?.dominantStage === "string" ? payload.meta.dominantStage : null;
            const topStageMs = typeof payload?.meta?.topStageMs === "number" ? payload.meta.topStageMs : null;
            const neighborExpansionCount =
              typeof payload?.meta?.neighborExpansionCount === "number" ? payload.meta.neighborExpansionCount : 0;
            const typedLaneDepth = typeof payload?.meta?.typedLaneDepth === "number" ? payload.meta.typedLaneDepth : 0;
            const recursiveSubqueryCount =
              typeof payload?.meta?.recursiveSubqueryCount === "number" ? payload.meta.recursiveSubqueryCount : 0;
            const latencyBudgetFamily =
              typeof payload?.meta?.latencyBudgetFamily === "string" ? payload.meta.latencyBudgetFamily : null;
            const routeBudgetEnforced = payload?.meta?.routeBudgetEnforced === true;
            const routeBudgetExceededStages = Array.isArray(payload?.meta?.routeBudgetExceededStages)
              ? payload.meta.routeBudgetExceededStages.filter((value: unknown): value is string => typeof value === "string")
              : [];
            const routeBudgetDecision =
              typeof payload?.meta?.routeBudgetDecision === "string" ? payload.meta.routeBudgetDecision : null;
            const plannerTargetedBackfillSubqueryLimit =
              typeof payload?.meta?.plannerTargetedBackfillSubqueryLimit === "number"
                ? payload.meta.plannerTargetedBackfillSubqueryLimit
                : null;
            const earlyStopReason =
              typeof payload?.meta?.earlyStopReason === "string" ? payload.meta.earlyStopReason : null;
            const leafTraversalTriggered = payload?.meta?.leafTraversalTriggered === true;
            const descentTriggered = payload?.meta?.descentTriggered === true;
            const descentStages = Array.isArray(payload?.meta?.descentStages)
              ? payload.meta.descentStages.filter((value: unknown): value is string => typeof value === "string")
              : [];
            const initialLaneSufficiency =
              typeof payload?.meta?.initialLaneSufficiency === "string" ? payload.meta.initialLaneSufficiency : null;
            const finalLaneSufficiency =
              typeof payload?.meta?.finalLaneSufficiency === "string" ? payload.meta.finalLaneSufficiency : null;
            const reducerFamily = typeof payload?.meta?.reducerFamily === "string" ? payload.meta.reducerFamily : null;
            const finalClaimSource =
              typeof payload?.meta?.finalClaimSource === "string" ? payload.meta.finalClaimSource : null;
            const rawProfileTraitSourceCoverageStatus =
              typeof payload?.meta?.profileTraitSourceCoverageStatus === "string"
                ? payload.meta.profileTraitSourceCoverageStatus
                : null;
            const rawProfileTraitEvidenceSpanCount =
              typeof payload?.meta?.profileTraitEvidenceSpanCount === "number"
                ? payload.meta.profileTraitEvidenceSpanCount
                : 0;
            const rawProfileTraitCompilerStatus =
              typeof payload?.meta?.profileTraitCompilerStatus === "string"
                ? payload.meta.profileTraitCompilerStatus
                : null;
            const rawProfileTraitRouteStatus =
              typeof payload?.meta?.profileTraitRouteStatus === "string"
                ? payload.meta.profileTraitRouteStatus
                : null;
            const rawProfileTraitResidualOwner =
              typeof payload?.meta?.profileTraitResidualOwner === "string"
                ? payload.meta.profileTraitResidualOwner
                : null;
            const canonicalFallbackBlockedReason =
              typeof payload?.meta?.canonicalFallbackBlockedReason === "string"
                ? payload.meta.canonicalFallbackBlockedReason
                : null;
            const sourceBoundEvidenceRequired =
              payload?.meta?.sourceBoundEvidenceRequired === true ||
              requiresSourceBoundReaderEvidence({ queryBehavior, finalClaimSource, questionText: qa.question });
            const sourceBoundSupportCount = sourceBoundSupportCountFromPayload(payload);
            const sourceBoundEvidencePresent =
              payload?.meta?.sourceBoundEvidencePresent === true ||
              (sourceBoundSupportCount > 0 && subjectMatch === "matched" && sufficiency === "supported") ||
              (rawSourceCount > 0 && rawEvidenceCount > 0 && subjectMatch === "matched" && sufficiency !== "missing" && sufficiency !== "contradicted");
            const normalizedEvidenceCounts = normalizeEvidenceTelemetryCounts({
              payload,
              rawEvidenceCount,
              rawSourceCount,
              sourceBoundEvidencePresent,
              sourceBoundSupportCount
            });
            const evidenceCount = normalizedEvidenceCounts.evidenceCount;
            const sourceCount = normalizedEvidenceCounts.sourceCount;
            const readerEvidenceDisciplineStatus =
              typeof payload?.meta?.readerEvidenceDisciplineStatus === "string"
                ? payload.meta.readerEvidenceDisciplineStatus
                : sourceBoundEvidenceRequired
                  ? sourceBoundEvidencePresent
                    ? "source_bound_evidence_present"
                    : "source_bound_evidence_missing"
                  : null;
            const readerResidualOwner =
              typeof payload?.meta?.readerResidualOwner === "string"
                ? payload.meta.readerResidualOwner
                : null;
            const compiledDirectFactLookupTried = payload?.meta?.compiledDirectFactLookupTried === true;
            const compiledDirectFactLookupSucceeded = payload?.meta?.compiledDirectFactLookupSucceeded === true;
            const directFactFamily =
              typeof payload?.meta?.directFactFamily === "string" ? payload.meta.directFactFamily : null;
            const compiledDirectFactCoverageStatus =
              typeof payload?.meta?.compiledDirectFactCoverageStatus === "string"
                ? payload.meta.compiledDirectFactCoverageStatus
                : null;
            const compiledProfileInferenceLookupTried = payload?.meta?.compiledProfileInferenceLookupTried === true;
            const compiledProfileInferenceLookupSucceeded = payload?.meta?.compiledProfileInferenceLookupSucceeded === true;
            const profileInferenceFamily =
              typeof payload?.meta?.profileInferenceFamily === "string" ? payload.meta.profileInferenceFamily : null;
            const premiseCount =
              typeof payload?.meta?.premiseCount === "number" ? payload.meta.premiseCount : undefined;
            const premiseCoverageStatus =
              typeof payload?.meta?.premiseCoverageStatus === "string" ? payload.meta.premiseCoverageStatus : null;
            const inferenceConfidence =
              typeof payload?.meta?.inferenceConfidence === "number" ? payload.meta.inferenceConfidence : null;
            const inferencePromotionStatus =
              typeof payload?.meta?.inferencePromotionStatus === "string" ? payload.meta.inferencePromotionStatus : null;
            const inferenceRejectionReason =
              typeof payload?.meta?.inferenceRejectionReason === "string" ? payload.meta.inferenceRejectionReason : null;
            const sourceBoundFallbackUsed = payload?.meta?.sourceBoundFallbackUsed === true;
            const queryTimeExtractorUsed = payload?.meta?.queryTimeExtractorUsed === true;
            const queryTimeGLiNEROrLLMUsed = payload?.meta?.queryTimeGLiNEROrLLMUsed === true;
            const offlineSubstrateLookupTried = payload?.meta?.offlineSubstrateLookupTried === true;
            const offlineSubstrateLookupSucceeded = payload?.meta?.offlineSubstrateLookupSucceeded === true;
            const offlineSubstrateSelectedRowId =
              typeof payload?.meta?.offlineSubstrateSelectedRowId === "string" ? payload.meta.offlineSubstrateSelectedRowId : null;
            const offlineSubstrateFamily =
              typeof payload?.meta?.offlineSubstrateFamily === "string" ? payload.meta.offlineSubstrateFamily : null;
            const offlineSubstrateSourceDerivedFamily =
              typeof payload?.meta?.offlineSubstrateSourceDerivedFamily === "string" ? payload.meta.offlineSubstrateSourceDerivedFamily : null;
            const offlineSubstrateSourceDerivedValue =
              typeof payload?.meta?.offlineSubstrateSourceDerivedValue === "string" ? payload.meta.offlineSubstrateSourceDerivedValue : null;
            const offlineSubstrateQueryShape =
              typeof payload?.meta?.offlineSubstrateQueryShape === "string" ? payload.meta.offlineSubstrateQueryShape : null;
            const offlineSubstrateAnswerShape =
              typeof payload?.meta?.offlineSubstrateAnswerShape === "string" ? payload.meta.offlineSubstrateAnswerShape : null;
            const offlineSubstrateEvidenceTriggers = Array.isArray(payload?.meta?.offlineSubstrateEvidenceTriggers)
              ? payload.meta.offlineSubstrateEvidenceTriggers.filter((value: unknown): value is string => typeof value === "string")
              : [];
            const offlineSubstratePremiseQuoteCount =
              typeof payload?.meta?.offlineSubstratePremiseQuoteCount === "number" ? payload.meta.offlineSubstratePremiseQuoteCount : 0;
            const offlineSubstrateSourceSessionCount =
              typeof payload?.meta?.offlineSubstrateSourceSessionCount === "number" ? payload.meta.offlineSubstrateSourceSessionCount : 0;
            const offlineSubstrateAdjudicationStatus =
              typeof payload?.meta?.offlineSubstrateAdjudicationStatus === "string" ? payload.meta.offlineSubstrateAdjudicationStatus : null;
            const offlineSubstrateRowsScanned =
              typeof payload?.meta?.offlineSubstrateRowsScanned === "number" ? payload.meta.offlineSubstrateRowsScanned : 0;
            const offlineSubstrateEvidenceCount =
              typeof payload?.meta?.offlineSubstrateEvidenceCount === "number" ? payload.meta.offlineSubstrateEvidenceCount : 0;
            const offlineSubstrateBlockedReason =
              typeof payload?.meta?.offlineSubstrateBlockedReason === "string" ? payload.meta.offlineSubstrateBlockedReason : null;
            const offlineSubstrateDiagnosticOnly = payload?.meta?.offlineSubstrateDiagnosticOnly === true;
            const retrievalMode =
              typeof payload?.meta?.retrievalMode === "string" ? payload.meta.retrievalMode : null;
            const vectorCandidateCount =
              typeof payload?.meta?.vectorCandidateCount === "number" ? payload.meta.vectorCandidateCount : 0;
            const vectorContributedToFinalSupport = payload?.meta?.vectorContributedToFinalSupport === true;
            const answerOwnerTrace =
              payload?.meta?.answerOwnerTrace && typeof payload.meta.answerOwnerTrace === "object"
                ? {
                    family:
                      typeof payload.meta.answerOwnerTrace.family === "string"
                        ? payload.meta.answerOwnerTrace.family
                        : null,
                    winner:
                      typeof payload.meta.answerOwnerTrace.winner === "string"
                        ? payload.meta.answerOwnerTrace.winner
                        : null,
                    eligibleOwners: Array.isArray(payload.meta.answerOwnerTrace.eligibleOwners)
                      ? payload.meta.answerOwnerTrace.eligibleOwners.filter((value: unknown): value is string => typeof value === "string")
                      : [],
                    suppressedOwners: Array.isArray(payload.meta.answerOwnerTrace.suppressedOwners)
                      ? payload.meta.answerOwnerTrace.suppressedOwners
                          .filter((value: unknown): value is { readonly owner: string; readonly reason: string } =>
                            typeof value === "object" &&
                            value !== null &&
                            typeof (value as { owner?: unknown }).owner === "string" &&
                            typeof (value as { reason?: unknown }).reason === "string"
                          )
                          .map((value: { readonly owner: string; readonly reason: string }) => ({ owner: value.owner, reason: value.reason }))
                      : [],
                    candidates: Array.isArray(payload.meta.answerOwnerTrace.candidates)
                      ? payload.meta.answerOwnerTrace.candidates
                          .filter((value: unknown): value is {
                            readonly owner: string;
                            readonly family: string;
                            readonly eligible: boolean;
                            readonly suppressed: boolean;
                            readonly suppressionReason?: string;
                            readonly reasonCodes?: readonly string[];
                            readonly subjectBindingStatus?: string;
                            readonly subjectPlanKind?: string;
                            readonly sourceTable?: string | null;
                          } =>
                            typeof value === "object" &&
                            value !== null &&
                            typeof (value as { owner?: unknown }).owner === "string" &&
                            typeof (value as { family?: unknown }).family === "string" &&
                            typeof (value as { eligible?: unknown }).eligible === "boolean" &&
                            typeof (value as { suppressed?: unknown }).suppressed === "boolean"
                          )
                          .map((value: {
                            readonly owner: string;
                            readonly family: string;
                            readonly eligible: boolean;
                            readonly suppressed: boolean;
                            readonly suppressionReason?: string;
                            readonly reasonCodes?: readonly string[];
                            readonly subjectBindingStatus?: string;
                            readonly subjectPlanKind?: string;
                            readonly sourceTable?: string | null;
                          }) => ({
                            owner: value.owner,
                            family: value.family,
                            eligible: value.eligible,
                            suppressed: value.suppressed,
                            suppressionReason: typeof value.suppressionReason === "string" ? value.suppressionReason : null,
                            reasonCodes: Array.isArray(value.reasonCodes)
                              ? value.reasonCodes.filter((code: unknown): code is string => typeof code === "string")
                              : [],
                            subjectBindingStatus: typeof value.subjectBindingStatus === "string" ? value.subjectBindingStatus : null,
                            subjectPlanKind: typeof value.subjectPlanKind === "string" ? value.subjectPlanKind : null,
                            sourceTable: typeof value.sourceTable === "string" ? value.sourceTable : null
                          }))
                      : [],
                    reasonCodes: Array.isArray(payload.meta.answerOwnerTrace.reasonCodes)
                      ? payload.meta.answerOwnerTrace.reasonCodes.filter((value: unknown): value is string => typeof value === "string")
                      : [],
                    fallbackPath: Array.isArray(payload.meta.answerOwnerTrace.fallbackPath)
                      ? payload.meta.answerOwnerTrace.fallbackPath.filter((value: unknown): value is string => typeof value === "string")
                      : [],
                    abstentionReason:
                      typeof payload.meta.answerOwnerTrace.abstentionReason === "string"
                        ? payload.meta.answerOwnerTrace.abstentionReason
                        : null,
                    resolvedSubject:
                      payload.meta.answerOwnerTrace.resolvedSubject && typeof payload.meta.answerOwnerTrace.resolvedSubject === "object"
                        ? {
                            bindingStatus:
                              typeof payload.meta.answerOwnerTrace.resolvedSubject.bindingStatus === "string"
                                ? payload.meta.answerOwnerTrace.resolvedSubject.bindingStatus
                                : null,
                            subjectPlanKind:
                              typeof payload.meta.answerOwnerTrace.resolvedSubject.subjectPlanKind === "string"
                                ? payload.meta.answerOwnerTrace.resolvedSubject.subjectPlanKind
                                : null,
                            subjectId:
                              typeof payload.meta.answerOwnerTrace.resolvedSubject.subjectId === "string"
                                ? payload.meta.answerOwnerTrace.resolvedSubject.subjectId
                                : null,
                            subjectName:
                              typeof payload.meta.answerOwnerTrace.resolvedSubject.subjectName === "string"
                                ? payload.meta.answerOwnerTrace.resolvedSubject.subjectName
                                : null
                          }
                        : undefined
                  }
                : null;
            const answerShapingTrace =
              payload?.meta?.answerShapingTrace && typeof payload.meta.answerShapingTrace === "object"
                ? {
                    selectedFamily:
                      typeof payload.meta.answerShapingTrace.selectedFamily === "string"
                        ? payload.meta.answerShapingTrace.selectedFamily
                        : null,
                    shapingMode:
                      typeof payload.meta.answerShapingTrace.shapingMode === "string"
                        ? payload.meta.answerShapingTrace.shapingMode
                        : null,
                    retrievalPlanFamily:
                      typeof payload.meta.answerShapingTrace.retrievalPlanFamily === "string"
                        ? payload.meta.answerShapingTrace.retrievalPlanFamily
                        : null,
                    retrievalPlanLane:
                      typeof payload.meta.answerShapingTrace.retrievalPlanLane === "string"
                        ? payload.meta.answerShapingTrace.retrievalPlanLane
                        : null,
                    retrievalPlanResolvedSubjectEntityId:
                      typeof payload.meta.answerShapingTrace.retrievalPlanResolvedSubjectEntityId === "string"
                        ? payload.meta.answerShapingTrace.retrievalPlanResolvedSubjectEntityId
                        : null,
                    retrievalPlanCandidatePools: Array.isArray(payload.meta.answerShapingTrace.retrievalPlanCandidatePools)
                      ? payload.meta.answerShapingTrace.retrievalPlanCandidatePools.filter(
                          (value: unknown): value is string => typeof value === "string"
                        )
                      : [],
                    retrievalPlanSuppressionPools: Array.isArray(payload.meta.answerShapingTrace.retrievalPlanSuppressionPools)
                      ? payload.meta.answerShapingTrace.retrievalPlanSuppressionPools.filter(
                          (value: unknown): value is string => typeof value === "string"
                        )
                      : [],
                    retrievalPlanRequiredFields: Array.isArray(payload.meta.answerShapingTrace.retrievalPlanRequiredFields)
                      ? payload.meta.answerShapingTrace.retrievalPlanRequiredFields.filter(
                          (value: unknown): value is string => typeof value === "string"
                        )
                      : [],
                    retrievalPlanTargetedBackfill: Array.isArray(payload.meta.answerShapingTrace.retrievalPlanTargetedBackfill)
                      ? payload.meta.answerShapingTrace.retrievalPlanTargetedBackfill.filter(
                          (value: unknown): value is string => typeof value === "string"
                        )
                      : [],
                    retrievalPlanTargetedBackfillRequests: Array.isArray(payload.meta.answerShapingTrace.retrievalPlanTargetedBackfillRequests)
                      ? payload.meta.answerShapingTrace.retrievalPlanTargetedBackfillRequests.map((request: unknown) => {
                          const value =
                            typeof request === "object" && request !== null
                              ? (request as Record<string, unknown>)
                              : {};
                          return {
                            reason: typeof value.reason === "string" ? value.reason : null,
                            requiredFields: Array.isArray(value.requiredFields)
                              ? value.requiredFields.filter((field: unknown): field is string => typeof field === "string")
                              : [],
                            candidatePool: typeof value.candidatePool === "string" ? value.candidatePool : null,
                            maxPasses: typeof value.maxPasses === "number" ? value.maxPasses : null
                          };
                        })
                      : [],
                    retrievalPlanQueryExpansionTerms: Array.isArray(payload.meta.answerShapingTrace.retrievalPlanQueryExpansionTerms)
                      ? payload.meta.answerShapingTrace.retrievalPlanQueryExpansionTerms.filter(
                          (value: unknown): value is string => typeof value === "string"
                        )
                      : [],
                    retrievalPlanBannedExpansionTerms: Array.isArray(payload.meta.answerShapingTrace.retrievalPlanBannedExpansionTerms)
                      ? payload.meta.answerShapingTrace.retrievalPlanBannedExpansionTerms.filter(
                          (value: unknown): value is string => typeof value === "string"
                        )
                      : [],
                    retrievalPlanFamilyConfidence:
                      typeof payload.meta.answerShapingTrace.retrievalPlanFamilyConfidence === "number"
                        ? payload.meta.answerShapingTrace.retrievalPlanFamilyConfidence
                        : null,
                    retrievalPlanSupportCompletenessTarget:
                      typeof payload.meta.answerShapingTrace.retrievalPlanSupportCompletenessTarget === "number"
                        ? payload.meta.answerShapingTrace.retrievalPlanSupportCompletenessTarget
                        : null,
                    retrievalPlanRescuePolicy:
                      typeof payload.meta.answerShapingTrace.retrievalPlanRescuePolicy === "string"
                        ? payload.meta.answerShapingTrace.retrievalPlanRescuePolicy
                        : null,
                    ownerEligibilityHints: Array.isArray(payload.meta.answerShapingTrace.ownerEligibilityHints)
                      ? payload.meta.answerShapingTrace.ownerEligibilityHints.filter(
                          (value: unknown): value is string => typeof value === "string"
                        )
                      : [],
                    suppressionHints: Array.isArray(payload.meta.answerShapingTrace.suppressionHints)
                      ? payload.meta.answerShapingTrace.suppressionHints.filter(
                          (value: unknown): value is string => typeof value === "string"
                        )
                      : [],
                    shapingPipelineEntered: payload.meta.answerShapingTrace.shapingPipelineEntered === true,
                    supportObjectAttempted: payload.meta.answerShapingTrace.supportObjectAttempted === true,
                    renderContractAttempted: payload.meta.answerShapingTrace.renderContractAttempted === true,
                    bypassReason:
                      typeof payload.meta.answerShapingTrace.bypassReason === "string"
                        ? payload.meta.answerShapingTrace.bypassReason
                        : null,
                    targetedRetrievalAttempted: payload.meta.answerShapingTrace.targetedRetrievalAttempted === true,
                    targetedRetrievalReason:
                      typeof payload.meta.answerShapingTrace.targetedRetrievalReason === "string"
                        ? payload.meta.answerShapingTrace.targetedRetrievalReason
                        : null,
                    targetedFieldsRequested: Array.isArray(payload.meta.answerShapingTrace.targetedFieldsRequested)
                      ? payload.meta.answerShapingTrace.targetedFieldsRequested.filter(
                          (value: unknown): value is string => typeof value === "string"
                        )
                      : [],
                    targetedRetrievalSatisfied: payload.meta.answerShapingTrace.targetedRetrievalSatisfied === true,
                    typedValueUsed: payload.meta.answerShapingTrace.typedValueUsed === true,
                    generatedProseUsed: payload.meta.answerShapingTrace.generatedProseUsed === true,
                    runtimeResynthesisUsed: payload.meta.answerShapingTrace.runtimeResynthesisUsed === true,
                    supportRowsSelected:
                      typeof payload.meta.answerShapingTrace.supportRowsSelected === "number"
                        ? payload.meta.answerShapingTrace.supportRowsSelected
                        : 0,
                    supportTextsSelected:
                      typeof payload.meta.answerShapingTrace.supportTextsSelected === "number"
                        ? payload.meta.answerShapingTrace.supportTextsSelected
                        : 0,
                    supportSelectionMode:
                      typeof payload.meta.answerShapingTrace.supportSelectionMode === "string"
                        ? payload.meta.answerShapingTrace.supportSelectionMode
                        : null,
                    supportObjectsBuilt:
                      typeof payload.meta.answerShapingTrace.supportObjectsBuilt === "number"
                        ? payload.meta.answerShapingTrace.supportObjectsBuilt
                        : 0,
                    supportObjectType:
                      typeof payload.meta.answerShapingTrace.supportObjectType === "string"
                        ? payload.meta.answerShapingTrace.supportObjectType
                        : null,
                    supportNormalizationFailures: Array.isArray(payload.meta.answerShapingTrace.supportNormalizationFailures)
                      ? payload.meta.answerShapingTrace.supportNormalizationFailures.filter(
                          (value: unknown): value is string => typeof value === "string"
                        )
                      : [],
                    renderContractSelected:
                      typeof payload.meta.answerShapingTrace.renderContractSelected === "string"
                        ? payload.meta.answerShapingTrace.renderContractSelected
                        : null,
                    renderContractFallbackReason:
                      typeof payload.meta.answerShapingTrace.renderContractFallbackReason === "string"
                        ? payload.meta.answerShapingTrace.renderContractFallbackReason
                        : null,
                    subjectBindingStatus:
                      typeof payload.meta.answerShapingTrace.subjectBindingStatus === "string"
                        ? payload.meta.answerShapingTrace.subjectBindingStatus
                        : null,
                    subjectBindingReason:
                      typeof payload.meta.answerShapingTrace.subjectBindingReason === "string"
                        ? payload.meta.answerShapingTrace.subjectBindingReason
                        : null,
                    temporalEventIdentityStatus:
                      typeof payload.meta.answerShapingTrace.temporalEventIdentityStatus === "string"
                        ? payload.meta.answerShapingTrace.temporalEventIdentityStatus
                        : null,
                    temporalGranularityStatus:
                      typeof payload.meta.answerShapingTrace.temporalGranularityStatus === "string"
                        ? payload.meta.answerShapingTrace.temporalGranularityStatus
                        : null,
                    selectedEventKey:
                      typeof payload.meta.answerShapingTrace.selectedEventKey === "string"
                        ? payload.meta.answerShapingTrace.selectedEventKey
                        : null,
                    selectedEventType:
                      typeof payload.meta.answerShapingTrace.selectedEventType === "string"
                        ? payload.meta.answerShapingTrace.selectedEventType
                        : null,
                    selectedTimeGranularity:
                      typeof payload.meta.answerShapingTrace.selectedTimeGranularity === "string"
                        ? payload.meta.answerShapingTrace.selectedTimeGranularity
                        : null,
                    typedSetEntryCount:
                      typeof payload.meta.answerShapingTrace.typedSetEntryCount === "number"
                        ? payload.meta.answerShapingTrace.typedSetEntryCount
                        : 0,
                    typedSetEntryType:
                      typeof payload.meta.answerShapingTrace.typedSetEntryType === "string"
                        ? payload.meta.answerShapingTrace.typedSetEntryType
                        : null,
                    exactDetailSource:
                      typeof payload.meta.answerShapingTrace.exactDetailSource === "string"
                        ? payload.meta.answerShapingTrace.exactDetailSource
                        : null
                  }
                : null;
            const renderContract =
              typeof payload?.meta?.answerShapingTrace?.renderContractSelected === "string"
                ? payload.meta.answerShapingTrace.renderContractSelected
                : null;
            const fallbackSuppressedReason =
              typeof payload?.meta?.fallbackSuppressedReason === "string" ? payload.meta.fallbackSuppressedReason : null;
            const canonicalPathUsed = payload?.meta?.canonicalPathUsed === true;
            const canonicalPredicateFamily =
              typeof payload?.meta?.canonicalPredicateFamily === "string" ? payload.meta.canonicalPredicateFamily : null;
            const canonicalSupportStrength =
              typeof payload?.meta?.canonicalSupportStrength === "string" ? payload.meta.canonicalSupportStrength : null;
            const canonicalAbstainReason =
              typeof payload?.meta?.canonicalAbstainReason === "string" ? payload.meta.canonicalAbstainReason : null;
            const canonicalSubjectBindingStatus =
              typeof payload?.meta?.canonicalSubjectBindingStatus === "string" ? payload.meta.canonicalSubjectBindingStatus : null;
            const canonicalSubjectId =
              typeof payload?.meta?.canonicalSubjectId === "string" ? payload.meta.canonicalSubjectId : null;
            const canonicalSubjectName =
              typeof payload?.meta?.canonicalSubjectName === "string" ? payload.meta.canonicalSubjectName : null;
            const canonicalStatus =
              typeof payload?.meta?.canonicalStatus === "string" ? payload.meta.canonicalStatus : null;
            const subjectPlanKind =
              typeof payload?.meta?.subjectPlanKind === "string" ? payload.meta.subjectPlanKind : null;
            const pairPlanUsed = payload?.meta?.pairPlanUsed === true;
            const canonicalReadTier =
              typeof payload?.meta?.canonicalReadTier === "string" ? payload.meta.canonicalReadTier : null;
            const temporalValiditySource =
              typeof payload?.meta?.temporalValiditySource === "string" ? payload.meta.temporalValiditySource : null;
            const chainSerializerUsed = payload?.meta?.chainSerializerUsed === true;
            const narrativePathUsed = payload?.meta?.narrativePathUsed === true;
            const narrativeKind =
              typeof payload?.meta?.narrativeKind === "string" ? payload.meta.narrativeKind : null;
            const reportPathUsed = payload?.meta?.reportPathUsed === true;
            const reportKind =
              typeof payload?.meta?.reportKind === "string" ? payload.meta.reportKind : null;
            const narrativeSourceTier =
              typeof payload?.meta?.narrativeSourceTier === "string" ? payload.meta.narrativeSourceTier : null;
            const narrativeCandidateCount =
              typeof payload?.meta?.narrativeCandidateCount === "number" ? payload.meta.narrativeCandidateCount : 0;
            const narrativeShadowDecision =
              typeof payload?.meta?.narrativeShadowDecision === "string" ? payload.meta.narrativeShadowDecision : null;
            const narrativeCutoverApplied = payload?.meta?.narrativeCutoverApplied === true;
            const failureClass = classifyFailure(queryBehavior, passed, qa.question, sufficiency, subjectMatch, evidenceCount, sourceCount);
            const profileTraitAuditQuestion = isProfileTraitCoverageAuditQuestion(qa.question);
            const profileTraitSourceCoverageStatus =
              rawProfileTraitSourceCoverageStatus ??
              (profileTraitAuditQuestion
                ? evidenceCount > 0
                  ? "source_bounded_trait_evidence_present"
                  : "source_missing"
                : null);
            const profileTraitEvidenceSpanCount = rawProfileTraitEvidenceSpanCount;
            const profileTraitCompilerStatus =
              rawProfileTraitCompilerStatus ??
              (profileTraitAuditQuestion
                ? profileTraitSourceCoverageStatus === "source_missing"
                  ? "not_compiled_source_missing"
                  : "compiler_missing_or_unranked"
                : null);
            const profileTraitRouteStatus =
              rawProfileTraitRouteStatus ??
              (profileTraitAuditQuestion
                ? finalClaimSource === "canonical_report"
                  ? "canonical_fallback_bypassed_trait"
                  : "profile_trait_route_not_used"
                : null);
            const profileTraitResidualOwner =
              rawProfileTraitResidualOwner ??
              (profileTraitAuditQuestion
                ? profileTraitSourceCoverageStatus === "source_missing"
                  ? "source_missing"
                  : profileTraitRouteStatus === "canonical_fallback_bypassed_trait"
                    ? "canonical_fallback_bypassed_trait"
                    : "profile_trait_compiler"
                : null);
            const shapingDiagnosis = classifyAnswerShapingDiagnosis({
              question: qa.question,
              failureClass,
              finalClaimSource,
              answerOwnerTrace,
              answerShapingTrace
            });
            const residualOwner =
              (readerResidualOwner as ResidualOwner | null) ??
              classifyResidualOwner({
                passed,
                failureClass,
                shapingDiagnosis,
                queryBehavior,
                finalClaimSource,
                evidenceCount,
                sourceCount,
                sufficiency,
                subjectMatch,
                sourceBoundEvidenceRequired,
                sourceBoundEvidencePresent,
                profileTraitResidualOwner
              });
            const ownerEvidence: OwnerEvidence = {
              queryBehavior,
              finalClaimSource,
              evidenceCount,
              sourceCount,
              subjectMatch,
              sufficiency,
              dominantStage,
              sourceBoundEvidenceRequired,
              sourceBoundEvidencePresent,
              readerEvidenceDisciplineStatus
            };
            const answerSnippet = renderLocomoAnswerSnippet(payload);
            const evidenceTelemetryStatus = classifyEvidenceTelemetryStatus({
              passed,
              evidenceCount,
              sourceCount,
              sourceBoundEvidenceRequired,
              sourceBoundEvidencePresent,
              finalClaimSource,
              answerSnippet,
              expectedAnswer
            });
            results.push({
              sampleId: sample.sample_id,
              questionIndex: originalIndex,
              category: qa.category,
              question: qa.question,
              expectedAnswer,
              queryBehavior,
              passed,
              normalizedPassed,
              failureClass,
              confidence: typeof payload?.duality?.confidence === "string" ? payload.duality.confidence : null,
              sufficiency,
              subjectMatch,
              synthesisMode,
              recursiveReflectApplied,
              reflectHelped,
              reflectOutcome,
              adequacyStatus,
              missingInfoType,
              exactAnswerWindowCount,
              exactAnswerSafeWindowCount,
              exactAnswerDiscardedMixedWindowCount,
              exactAnswerDiscardedForeignWindowCount,
              exactAnswerCandidateCount,
              exactAnswerDominantMargin,
              exactAnswerAbstainedForAmbiguity,
              answerableUnitApplied,
              answerableUnitCandidateCount,
              answerableUnitOwnedCount,
              answerableUnitMixedCount,
              answerableUnitForeignCount,
              readerApplied,
              readerDecision,
              readerSelectedUnitCount,
              readerTopUnitType,
              readerDominantMargin,
              readerAbstainedAliasAmbiguity,
              readerAbstainedTemporalGap,
              readerUsedFallback,
              resolverApplied,
              resolverStatus,
              resolverTopMargin,
              ownershipWindowCount,
              ownershipOwnedCount,
              ownershipMixedCount,
              ownershipForeignCount,
              fallbackSuppressedCount,
              ownedWindowUsedForFinalClaim,
              subjectIsolationApplied,
              subjectIsolationOwnedCount,
              subjectIsolationDiscardedMixedCount,
              subjectIsolationDiscardedForeignCount,
              subjectIsolationTopResultOwned,
              globalQueryRouted: payload?.meta?.globalQueryRouted === true,
              summaryRoutingUsed: payload?.meta?.summaryRoutingUsed === true,
              branchPruningApplied,
              prunedBranches,
              stageTimingsMs,
              dominantStage,
              topStageMs,
              neighborExpansionCount,
              typedLaneDepth,
              recursiveSubqueryCount,
              latencyBudgetFamily,
              routeBudgetEnforced,
              routeBudgetExceededStages,
              routeBudgetDecision,
              plannerTargetedBackfillSubqueryLimit,
              earlyStopReason,
              leafTraversalTriggered,
              descentTriggered,
              descentStages,
              initialLaneSufficiency,
              finalLaneSufficiency,
              reducerFamily,
              finalClaimSource,
              profileTraitSourceCoverageStatus,
              profileTraitEvidenceSpanCount,
              profileTraitCompilerStatus,
              profileTraitRouteStatus,
              profileTraitResidualOwner,
              canonicalFallbackBlockedReason,
              sourceBoundEvidenceRequired,
              sourceBoundEvidencePresent,
              evidenceTelemetryStatus,
              readerEvidenceDisciplineStatus,
              readerResidualOwner,
              compiledDirectFactLookupTried,
              compiledDirectFactLookupSucceeded,
              directFactFamily,
              compiledDirectFactCoverageStatus,
              compiledProfileInferenceLookupTried,
              compiledProfileInferenceLookupSucceeded,
              profileInferenceFamily,
              premiseCount,
              premiseCoverageStatus,
              inferenceConfidence,
              inferencePromotionStatus,
              inferenceRejectionReason,
              sourceBoundFallbackUsed,
              queryTimeExtractorUsed,
              queryTimeGLiNEROrLLMUsed,
              offlineSubstrateLookupTried,
              offlineSubstrateLookupSucceeded,
              offlineSubstrateSelectedRowId,
              offlineSubstrateFamily,
              offlineSubstrateSourceDerivedFamily,
              offlineSubstrateSourceDerivedValue,
              offlineSubstrateQueryShape,
              offlineSubstrateAnswerShape,
              offlineSubstrateEvidenceTriggers,
              offlineSubstratePremiseQuoteCount,
              offlineSubstrateSourceSessionCount,
              offlineSubstrateAdjudicationStatus,
              offlineSubstrateRowsScanned,
              offlineSubstrateEvidenceCount,
              offlineSubstrateBlockedReason,
              offlineSubstrateDiagnosticOnly,
              residualOwner,
              ownerEvidence,
              retrievalMode,
              vectorCandidateCount,
              vectorContributedToFinalSupport,
              answerOwnerTrace,
              answerShapingTrace,
              shapingDiagnosis,
              fallbackSuppressedReason,
              canonicalPathUsed,
              canonicalPredicateFamily,
              canonicalSupportStrength,
              canonicalAbstainReason,
              canonicalSubjectBindingStatus,
              canonicalSubjectId,
              canonicalSubjectName,
              canonicalStatus,
              subjectPlanKind,
              pairPlanUsed,
              canonicalReadTier,
              temporalValiditySource,
              chainSerializerUsed,
              narrativePathUsed,
              narrativeKind,
              reportPathUsed,
              reportKind,
              narrativeSourceTier,
              narrativeCandidateCount,
              narrativeShadowDecision,
              narrativeCutoverApplied,
              renderContract,
              latencyMs,
              rawEvidenceCount,
              rawSourceCount,
              sourceBoundSupportCount: normalizedEvidenceCounts.sourceBoundSupportCount,
              evidenceCount,
              sourceCount,
              answerSnippet
            });
            completedQuestions += 1;
            lastProgressAtMs = Date.now();
            benchmarkLog(
                `question complete ${completedQuestions}/${totalQuestionsPlanned} sampleId=${sample.sample_id} index=${originalIndex} passed=${passed} normalizedPassed=${normalizedPassed} latencyMs=${latencyMs} evidence=${evidenceCount}`
              );
            if (completedQuestions % partialFlushEvery === 0) {
              await flushPartial();
            }
            if (clusterStopEnabled) {
              clusterStopReason = clusterStopReasonForResults(results);
              if (clusterStopReason) {
                benchmarkLog(`cluster stop triggered reason=${clusterStopReason}`);
                await flushPartial(clusterStopReason);
                break;
              }
            }
            if (questionDelayMs > 0) {
              await sleepMs(questionDelayMs);
            }
          }
        } finally {
          benchmarkLog(`cleanup start sampleId=${sample.sample_id} namespaceId=${namespaceId}`);
          if (!skipCleanup) {
            await cleanupBenchmarkNamespace(namespaceId);
          }
          benchmarkLog(`cleanup complete sampleId=${sample.sample_id} namespaceId=${namespaceId}`);
        }
        if (sampleDelayMs > 0) {
          await sleepMs(sampleDelayMs);
        }
        if (clusterStopReason) {
          break;
        }
      }

      benchmarkLog(`artifact write start results=${results.length}`);
      const report = buildReport();
      const stamp = report.generatedAt.replace(/[:.]/g, "-");
      await mkdir(outputDir(), { recursive: true });
      const jsonPath = path.join(outputDir(), `locomo-${stamp}.json`);
      const markdownPath = path.join(outputDir(), `locomo-${stamp}.md`);
      await writeFile(jsonPath, JSON.stringify(report, null, 2), "utf8");
      await writeFile(markdownPath, toMarkdown(report), "utf8");
      benchmarkLog(`artifact write complete jsonPath=${jsonPath} markdownPath=${markdownPath} passRate=${report.passRate}`);
      return { report, output: { jsonPath, markdownPath } };
    } catch (error) {
      const failureReason = error instanceof Error ? error.message : String(error);
      benchmarkLog(`run failure reason=${JSON.stringify(failureReason)}`);
      await flushPartial(failureReason);
      throw error;
    } finally {
      clearInterval(heartbeat);
      process.removeListener("SIGINT", signalHandler);
      process.removeListener("SIGTERM", signalHandler);
      benchmarkLog(`final summary completed=${completedQuestions}/${totalQuestionsPlanned} results=${results.length}`);
    }
  });
}

export async function runLoCoMoBenchmarkCli(): Promise<void> {
  const { output } = await runAndWriteLoCoMoBenchmark();
  process.stdout.write(`${output.jsonPath}\n${output.markdownPath}\n`);
}
