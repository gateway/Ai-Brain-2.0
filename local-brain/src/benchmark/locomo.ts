import { mkdir, readFile, writeFile } from "node:fs/promises";
import { execSync, spawn } from "node:child_process";
import { get } from "node:https";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { withClient, withMaintenanceLock } from "../db/client.js";
import { ingestArtifact } from "../ingest/worker.js";
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
import { parseLoCoMoSessionDateTimeToIso } from "./public-memory-date-utils.js";
import { buildBenchmarkRuntimeMetadata, resolvePublicBenchmarkMode, resolveRequestedSampleCount, type BenchmarkRuntimeMetadata } from "./runtime-metadata.js";
import { classifyAnswerShapingDiagnosis, type AnswerShapingDiagnosis } from "./answer-shaping-diagnosis.js";

interface TurnRecord {
  readonly speaker: string;
  readonly text?: string;
  readonly blip_caption?: string;
  readonly query?: string;
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
  readonly leafTraversalTriggered: boolean;
  readonly descentTriggered: boolean;
  readonly descentStages: readonly string[];
  readonly initialLaneSufficiency: string | null;
  readonly finalLaneSufficiency: string | null;
  readonly reducerFamily: string | null;
  readonly finalClaimSource: string | null;
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
  readonly latencyMs: number;
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

function resolveBenchmarkCleanupStatementTimeoutMs(): number {
  const raw = Number(process.env.BRAIN_BENCHMARK_CLEANUP_TIMEOUT_MS ?? "");
  if (Number.isFinite(raw) && raw > 0) {
    return Math.max(5_000, Math.floor(raw));
  }
  return 60_000;
}

async function runBenchmarkNamespacePreflight(logger: (message: string) => void): Promise<void> {
  const residualNamespaces = await listResidualBenchmarkNamespaces("benchmark_");
  if (residualNamespaces.length === 0) {
    logger("preflight clean benchmark namespaces=0");
    return;
  }
  logger(`preflight residue detected namespaces=${residualNamespaces.length}`);
  await cleanupPublicBenchmarkNamespaces(residualNamespaces, {
    namespaceChunkSize: 1,
    statementTimeoutMs: resolveBenchmarkCleanupStatementTimeoutMs(),
    lockTimeoutMs: 2_000,
    logger: (message) => logger(`preflight cleanup ${message}`)
  });
  const remaining = await listResidualBenchmarkNamespaces("benchmark_");
  if (remaining.length > 0) {
    throw new Error(
      `Benchmark preflight cleanup incomplete; residual benchmark namespaces remain (${remaining.length}).`
    );
  }
  logger("preflight cleanup complete benchmark namespaces=0");
}

async function runBenchmarkSchemaPreflight(logger: (message: string) => void): Promise<void> {
  const requiredTables = [
    "canonical_narratives",
    "canonical_entity_reports",
    "canonical_pair_reports",
    "canonical_set_entries",
    "canonical_temporal_facts"
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
    `- shapingDiagnosisBreakdown: ${JSON.stringify(report.diagnostics.shapingDiagnosisBreakdown)}`,
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

function formatConversationSession(sample: LocomoConversation, sessionKey: string, turns: readonly TurnRecord[]): string {
  const dateTime = typeof sample.conversation[`${sessionKey}_date_time`] === "string" ? sample.conversation[`${sessionKey}_date_time`] : "";
  const canonicalCapturedAt = typeof dateTime === "string" && dateTime ? parseLoCoMoSessionDateTimeToIso(dateTime) : null;
  const speakerA = typeof sample.conversation.speaker_a === "string" ? sample.conversation.speaker_a : "Speaker A";
  const speakerB = typeof sample.conversation.speaker_b === "string" ? sample.conversation.speaker_b : "Speaker B";
  const lines: string[] = [];
  if (canonicalCapturedAt) {
    lines.push(`Captured: ${canonicalCapturedAt}`);
    lines.push("");
  } else if (dateTime) {
    lines.push(`Captured: ${dateTime}`);
    lines.push("");
  }
  lines.push(`Conversation between ${speakerA} and ${speakerB}`);
  for (const turn of turns) {
    const caption = typeof turn.blip_caption === "string" && turn.blip_caption.trim().length > 0 ? ` [image: ${turn.blip_caption.trim()}]` : "";
    lines.push(`${turn.speaker}: ${(turn.text ?? "").trim()}${caption}`);
    if (typeof turn.query === "string" && turn.query.trim().length > 0) {
      lines.push(`--- image_query: ${turn.query.trim()}`);
    }
    if (typeof turn.blip_caption === "string" && turn.blip_caption.trim().length > 0) {
      lines.push(`--- image_caption: ${turn.blip_caption.trim()}`);
    }
  }
  return lines.join("\n");
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
    const conversationCount = resolveRequestedSampleCount(process.env.BRAIN_LOCOMO_SAMPLE_CONVERSATIONS, 2, parsed.length);
    const requestedQuestionCountPerConversation = resolveRequestedQuestionCount(
      process.env.BRAIN_LOCOMO_SAMPLE_QUESTIONS,
      5
    );
    const stratifiedQuestionSampling = isTruthyEnv(process.env.BRAIN_LOCOMO_STRATIFIED);
    const perCategoryQuestionLimit = resolveOptionalPositiveInt(process.env.BRAIN_LOCOMO_CATEGORY_LIMIT);
    const skipCleanup = shouldSkipPublicBenchmarkCleanup();
    const selected = parsed.slice(0, conversationCount);
    const selectedWithQuestions = selected.map((sample) => ({
      sample,
      questions: selectLoCoMoQuestions(sample.qa, requestedQuestionCountPerConversation, {
        stratified: stratifiedQuestionSampling,
        perCategoryLimit: perCategoryQuestionLimit
      })
    }));
    const totalQuestionsPlanned = selectedWithQuestions.reduce((sum, entry) => sum + entry.questions.length, 0);
    const results: QueryResult[] = [];
    const latencies: number[] = [];
    const corpusRoot = path.join(generatedRoot(), "locomo");
    await mkdir(corpusRoot, { recursive: true });
    const benchmarkMode =
      conversationCount >= parsed.length && requestedQuestionCountPerConversation === "full" ? "full" : "sampled";
    const runtime = buildBenchmarkRuntimeMetadata({
      benchmarkMode,
      sampleControls: {
        requestedConversationCount: process.env.BRAIN_LOCOMO_SAMPLE_CONVERSATIONS ?? null,
        resolvedConversationCount: conversationCount,
        requestedQuestionCountPerConversation: process.env.BRAIN_LOCOMO_SAMPLE_QUESTIONS ?? null,
        resolvedQuestionCountPerConversation:
          requestedQuestionCountPerConversation === "full" ? "full" : requestedQuestionCountPerConversation,
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
    let currentSampleId: string | null = null;
    let currentQuestionIndex: number | null = null;
    let completedQuestions = 0;
    let lastProgressAtMs = Date.now();

    const currentProgress = (): LoCoMoProgressState => ({
      runStamp,
      currentSampleId,
      currentQuestionIndex,
      totalQuestionsPlanned,
      completedQuestions,
      lastProgressAt: new Date(lastProgressAtMs).toISOString()
    });

    const flushPartial = async (failureReason?: string): Promise<void> => {
      const partialPath = await writePartialArtifact(runtime, currentProgress(), latencies, results, failureReason);
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
      return {
        generatedAt: new Date().toISOString(),
        dataset: "locomo10",
        runtime,
        sampleCount: results.length,
        passRate,
        latency: {
          p50Ms: percentile(latencies, 50),
          p95Ms: percentile(latencies, 95)
        },
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
            const sessionPath = path.join(corpusRoot, `${sample.sample_id}-${sessionKey}.md`);
            const sessionDateTime =
              typeof sample.conversation[`${sessionKey}_date_time`] === "string"
                ? parseLoCoMoSessionDateTimeToIso(sample.conversation[`${sessionKey}_date_time`] as string)
                : null;
            benchmarkLog(`ingest start sampleId=${sample.sample_id} session=${sessionKey}`);
            await withBenchmarkTimeout(`ingest ${sample.sample_id}/${sessionKey}`, queryTimeoutMs, async () => {
              await writeFile(sessionPath, formatConversationSession(sample, sessionKey, turns), "utf8");
              await ingestArtifact({
                namespaceId,
                sourceType: "markdown",
                inputUri: sessionPath,
                capturedAt: sessionDateTime ?? new Date().toISOString(),
              metadata: {
                benchmark: "locomo",
                sample_id: sample.sample_id,
                session_key: sessionKey
              },
                sourceChannel: "benchmark:locomo"
              });
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
          lastProgressAtMs = Date.now();
          if (rebuildDelayMs > 0) {
            await sleepMs(rebuildDelayMs);
          }

          for (const [questionIndex, qa] of entry.questions.entries()) {
            currentQuestionIndex = questionIndex;
            lastProgressAtMs = Date.now();
            const queryBehavior = classifyQueryBehavior(qa.question);
            const questionOrdinal = completedQuestions + 1;
            benchmarkLog(
              `question start ${questionOrdinal}/${totalQuestionsPlanned} sampleId=${sample.sample_id} index=${questionIndex} category=${qa.category} behavior=${queryBehavior} query=${JSON.stringify(qa.question.slice(0, 140))}`
            );
            const startedAt = performance.now();
            let payload: any = null;
            let benchmarkError: string | null = null;
            try {
              payload = await executeSearchIsolated(
                `memory.search ${sample.sample_id}#${questionIndex}`,
                namespaceId,
                qa.question,
                8,
                queryTimeoutMs,
              );
            } catch (error) {
              benchmarkError = error instanceof Error ? error.message : String(error);
              benchmarkLog(
                `question error ${questionOrdinal}/${totalQuestionsPlanned} sampleId=${sample.sample_id} index=${questionIndex} message=${JSON.stringify(benchmarkError)}`
              );
            }

            const latencyMs = Number((performance.now() - startedAt).toFixed(2));
            latencies.push(latencyMs);
            if (benchmarkError) {
              results.push({
                sampleId: sample.sample_id,
                questionIndex,
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
                leafTraversalTriggered: false,
                descentTriggered: false,
                descentStages: [],
                initialLaneSufficiency: null,
                finalLaneSufficiency: null,
                reducerFamily: null,
                finalClaimSource: null,
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
              if (questionDelayMs > 0) {
                await sleepMs(questionDelayMs);
              }
              continue;
            }

            const evidence = Array.isArray(payload?.duality?.evidence) ? payload.duality.evidence : [];
            const answerAssessment = payload?.meta?.answerAssessment ?? payload?.answerAssessment ?? null;
            const sourceCount = evidence.filter(
              (item: any) => typeof item?.artifactId === "string" || typeof item?.sourceUri === "string"
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
            const failureClass = classifyFailure(queryBehavior, passed, qa.question, sufficiency, subjectMatch, evidence.length, sourceCount);
            results.push({
              sampleId: sample.sample_id,
              questionIndex,
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
              leafTraversalTriggered,
              descentTriggered,
              descentStages,
              initialLaneSufficiency,
              finalLaneSufficiency,
              reducerFamily,
              finalClaimSource,
              answerOwnerTrace,
              answerShapingTrace,
              shapingDiagnosis: classifyAnswerShapingDiagnosis({
                question: qa.question,
                failureClass,
                finalClaimSource,
                answerOwnerTrace,
                answerShapingTrace
              }),
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
              latencyMs,
              evidenceCount: evidence.length,
              sourceCount,
              answerSnippet: JSON.stringify(payload?.duality?.claim ?? payload).slice(0, 220)
            });
            completedQuestions += 1;
            lastProgressAtMs = Date.now();
            benchmarkLog(
              `question complete ${completedQuestions}/${totalQuestionsPlanned} sampleId=${sample.sample_id} index=${questionIndex} passed=${passed} normalizedPassed=${normalizedPassed} latencyMs=${latencyMs} evidence=${evidence.length}`
            );
            if (completedQuestions % partialFlushEvery === 0) {
              await flushPartial();
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
