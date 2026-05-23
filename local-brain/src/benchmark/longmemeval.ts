import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { get } from "node:https";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { withClient, withMaintenanceLock } from "../db/client.js";
import { cleanupPublicBenchmarkNamespaces } from "./public-benchmark-cleanup.js";
import { normalizeBenchmarkCapturedAt } from "./public-memory-date-utils.js";
import { buildBenchmarkRuntimeMetadata, resolvePublicBenchmarkMode, resolveRequestedSampleCount, type BenchmarkRuntimeMetadata } from "./runtime-metadata.js";
import { buildBenchmarkCatalog, type BenchmarkCatalog } from "./benchmark-catalog.js";
import { ASSISTANT_PROMPT_VERSION } from "../taxonomy-temporal/assistant.js";
import { inferExactDetailQuestionFamily } from "../retrieval/exact-detail-question-family.js";
import {
  isConversationAboutPersonDirectQuery,
  isDecisionWaitDurationDirectQuery,
  isPreferredRatioDirectQuery,
  isTravelDestinationDirectQuery
} from "../retrieval/route-locked-fast-paths.js";

interface LongMemEvalEntry {
  readonly question_id: string;
  readonly question: string;
  readonly answer: string;
  readonly question_type: string;
  readonly haystack_sessions: readonly (readonly { readonly role: string; readonly content: string }[])[];
  readonly haystack_dates?: readonly string[];
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
type JsonRecord = Record<string, unknown>;
type LongMemManifestDecision = "cold_build" | "warm_manifest_hit" | "manifest_invalidated";
type LongMemManifestInvalidationReason =
  | "missing_manifest"
  | "source_hash_changed"
  | "compiler_version_changed"
  | "manifest_read_model_missing";
type LongMemSnapshotDecision = "cold_rebuild" | "warm_snapshot_hit" | "snapshot_invalidated";
type LongMemSnapshotInvalidationReason =
  | "artifact_signature_mismatch"
  | "candidate_read_model_empty"
  | "no_compatible_snapshot";
type LongMemReuseStage =
  | "cold_rebuild"
  | "pre_ingest_manifest"
  | "pre_rebuild_snapshot"
  | "post_timeout_snapshot";
type LongMemParityStatus = "not_applicable" | "matched" | "mismatch";

interface QueryResult {
  readonly questionId: string;
  readonly questionType: string;
  readonly question: string;
  readonly expectedAnswer: string;
  readonly passed: boolean;
  readonly normalizedPassed: boolean;
  readonly failureClass: FailureClass;
  readonly confidence: string | null;
  readonly sufficiency: SufficiencyGrade;
  readonly subjectMatch: SubjectMatch;
  readonly synthesisMode: SynthesisMode;
  readonly globalQueryRouted: boolean;
  readonly summaryRoutingUsed: boolean;
  readonly queryBehavior: string | null;
  readonly finalClaimSource: string | null;
  readonly retrievalMode: string | null;
  readonly dominantStage: string | null;
  readonly topStageMs: number | null;
  readonly stageTimingsMs: Readonly<Record<string, number>> | null;
  readonly candidateCountsByStage: Readonly<Record<string, number>> | null;
  readonly rowsScannedByStage: Readonly<Record<string, number>> | null;
  readonly compiledLookupTried: boolean | null;
  readonly relationshipFastPathTried?: boolean | null;
  readonly relationshipFastPathSucceeded?: boolean | null;
  readonly sourceBoundedReadTried?: boolean | null;
  readonly sourceBoundedReadSucceeded?: boolean | null;
  readonly finalRouteFamily?: string | null;
  readonly semanticFallbackUsed: boolean | null;
  readonly sqlHybridUsed: boolean | null;
  readonly typedLaneDescentTriggered: boolean | null;
  readonly plannerBackfillTriggered: boolean | null;
  readonly graphExpansionTriggered: boolean | null;
  readonly earlyStopReason: string | null;
  readonly supportBundleFamily: string | null;
  readonly authoritativeSource: string | null;
  readonly abstentionReason: string | null;
  readonly entityResolutionStatus: string | null;
  readonly temporalCoverageStatus: string | null;
  readonly structuredSufficiencyStatus: string | null;
  readonly fallbackUsed: boolean | null;
  readonly fallbackReason: string | null;
  readonly scalarTruthTried: boolean | null;
  readonly eventTruthTried: boolean | null;
  readonly backfillBlockedReason: string | null;
  readonly selfBindingRecoveredFrom: string | null;
  readonly claimAdmissibilityStatus: string | null;
  readonly authoritativeClaimRejectedReason: string | null;
  readonly factKeyLookupUsed: boolean | null;
  readonly factKeyHitType: string | null;
  readonly factRowSource: string | null;
  readonly relationIeStage: string | null;
  readonly relationIeSceneCount: number | null;
  readonly relationIePromotedRows: number | null;
  readonly relationIeRejectedRows: number | null;
  readonly relationIeWarnings: number | null;
  readonly relationIeCacheHits: number | null;
  readonly relationIeCacheMisses: number | null;
  readonly gliner2JobsSkipped: number | null;
  readonly exactDetailFactKeyRows: number | null;
  readonly namespaceSnapshotStatus?: string | null;
  readonly namespaceSnapshotSource?: string | null;
  readonly snapshotVersionKey?: string | null;
  readonly snapshotInvalidationReason?: string | null;
  readonly manifestStatus?: "cold_build" | "warm_manifest_hit" | "manifest_invalidated" | null;
  readonly manifestDecision?: LongMemManifestDecision | null;
  readonly manifestInvalidationReasonNormalized?: LongMemManifestInvalidationReason | null;
  readonly snapshotDecision?: LongMemSnapshotDecision | null;
  readonly snapshotInvalidationReasonNormalized?: LongMemSnapshotInvalidationReason | null;
  readonly reuseStage?: LongMemReuseStage | null;
  readonly parityStatus?: LongMemParityStatus | null;
  readonly ingestManifestKey?: string | null;
  readonly manifestInvalidationReason?: string | null;
  readonly sessionsSkipped?: number | null;
  readonly sessionsIngested?: number | null;
  readonly answerParityMismatch?: boolean | null;
  readonly staleManifestMismatch?: boolean | null;
  readonly renderContract?: string | null;
  readonly benchmarkStage: "ingest" | "rebuild" | "query" | "complete";
  readonly stageFailureReason: string | null;
  readonly latencyMs: number;
  readonly stageEnvelopeLatencyMs: number | null;
  readonly evidenceCount: number;
  readonly sourceCount: number;
  readonly answerSnippet: string;
}

interface LongMemEvalProgressState {
  readonly runStamp: string;
  readonly currentQuestionId: string | null;
  readonly currentQuestionIndex: number | null;
  readonly currentStage: "ingest" | "rebuild" | "query" | null;
  readonly currentStageSessionIndex: number | null;
  readonly totalQuestionsPlanned: number;
  readonly completedQuestions: number;
  readonly lastProgressAt: string;
}

interface PartialLongMemEvalArtifact {
  readonly generatedAt: string;
  readonly dataset: string;
  readonly status: "partial";
  readonly runtime: BenchmarkRuntimeMetadata;
  readonly progress: LongMemEvalProgressState;
  readonly latencies: readonly number[];
  readonly results: readonly QueryResult[];
  readonly failureReason?: string;
}

export interface LongMemEvalReport {
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
  };
  readonly catalog: BenchmarkCatalog;
  readonly productionReadiness: {
    readonly correctness: {
      readonly longmem50PassRate: number;
    };
    readonly latency: {
      readonly longmemP50Ms: number;
      readonly longmemP95Ms: number;
      readonly longmemMaxMs: number;
    };
    readonly cache: {
      readonly manifestHitRate: number;
      readonly sessionManifestHitRate?: number;
      readonly warmSnapshotHitRate: number;
      readonly coldRebuildCount: number;
      readonly manifestDecisionBreakdown?: Readonly<Record<LongMemManifestDecision, number>>;
      readonly snapshotDecisionBreakdown?: Readonly<Record<LongMemSnapshotDecision, number>>;
      readonly parityStatusBreakdown?: Readonly<Record<LongMemParityStatus, number>>;
      readonly staleCacheMismatchCount: number;
      readonly staleManifestMismatchCount?: number;
      readonly sessionsSkipped?: number;
      readonly sessionsIngested?: number;
      readonly sessionManifestInvalidationReasons?: Readonly<Record<string, number>>;
      readonly answerParityMismatchCount?: number;
      readonly warmTotalRuntimeMs?: number;
      readonly gliner2JobsSkipped: number;
      readonly assistantJobsSkipped: number;
    };
    readonly routePurity: {
      readonly fallbackDerivedSuccessCount: number;
      readonly broadFallbackAfterSufficientTypedSupportCount: number;
      readonly directRouteSuccessCountByFamily: Readonly<Record<string, number>>;
    };
  };
  readonly results: readonly QueryResult[];
  readonly passed: boolean;
}

function shouldForceLongMemEvalCleanup(): boolean {
  return process.env.BRAIN_LONGMEMEVAL_FORCE_CLEANUP === "1";
}

function shouldSkipPublicBenchmarkCleanup(): boolean {
  return process.env.BRAIN_PUBLIC_BENCHMARK_SKIP_CLEANUP === "1";
}

function isSoftCleanupFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return (
    message.includes("statement timeout") ||
    message.includes("canceling statement due to statement timeout") ||
    message.includes("lock timeout") ||
    message.includes("canceling statement due to lock timeout")
  );
}

function thisDir(): string {
  return path.dirname(fileURLToPath(import.meta.url));
}

function localBrainRoot(): string {
  return path.resolve(thisDir(), "../..");
}

function stageWorkerPath(): string {
  return path.resolve(localBrainRoot(), "dist/cli/benchmark-longmemeval-stage-worker.js");
}

function outputDir(): string {
  return path.resolve(localBrainRoot(), "benchmark-results");
}

function stageWorkerResultPath(stage: "ingest" | "rebuild" | "query"): string {
  return path.join(outputDir(), `.longmemeval-stage-${stage}-${process.pid}-${Date.now()}-${randomUUID()}.json`);
}

function benchmarkLog(message: string): void {
  process.stdout.write(`[longmemeval] ${new Date().toISOString()} ${message}\n`);
}

function resolveBenchmarkTimeoutMs(): number {
  const raw = Number(process.env.BRAIN_BENCHMARK_QUERY_TIMEOUT_MS ?? "");
  if (Number.isFinite(raw) && raw > 0) {
    return Math.max(1_000, Math.floor(raw));
  }
  return 45_000;
}

function resolveIngestTimeoutMs(): number {
  const raw = Number(process.env.BRAIN_BENCHMARK_INGEST_TIMEOUT_MS ?? "");
  if (Number.isFinite(raw) && raw > 0) {
    return Math.max(1_000, Math.floor(raw));
  }
  return 20_000;
}

function resolveRebuildTimeoutMs(): number {
  const raw = Number(process.env.BRAIN_BENCHMARK_REBUILD_TIMEOUT_MS ?? "");
  if (Number.isFinite(raw) && raw > 0) {
    return Math.max(1_000, Math.floor(raw));
  }
  return 120_000;
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

function shouldForceLongMemRelationIePromotion(query: string): boolean {
  const exactDetailFamily = inferExactDetailQuestionFamily(query);
  if (exactDetailFamily === "price") {
    return false;
  }
  const normalized = query.toLowerCase();
  return /\b(?:degree|graduat|major|certification|certificate|course|class|study|abroad|venue|wedding|ballroom|yoga|where\s+did\s+.*(?:redeem|buy|bought|purchase|shop|store|attend|complete)|redeem|redeemed|coupon|discount|voucher|creamer|speed|internet|network|mbps|gbps|brand|shoe|shoes|sneaker|gym\s+shoe|breed|dog|cat|pet|name|named|called|playlist|service|music|spotify|platform|app|time|email|checking|stop|screen\s+time|instagram|how many|count|bike|bikes|copies|album|released|caught|bass|fish|capacity|ram|storage|gb|tb|duration|how long|commute|japan|apartment|move|collecting|camera|assemble|assembled|assembly|bookshelf|furniture|put together|last name|surname|maiden|role|occupation|job|worked|position|price|cost|spent|paid|dollars|handbag|stance|belief|view|opinion|spirituality|atheist|gift|birthday|present|thrift|action\s+figure|cocktail|recipe|rice|cake|bake|baked|play|production|performance|movie|film|book|title|grandma|grandmother|necklace|how old|shelter|fundraising|volunteer|valentine|color|colour|shade|paint|painted|repaint|gray|grey)\b/u.test(
    normalized
  );
}

export function shouldForceLongMemRelationIePromotionForTest(query: string): boolean {
  return shouldForceLongMemRelationIePromotion(query);
}

function generatedRoot(): string {
  return path.resolve(localBrainRoot(), "benchmark-generated", "public-memory-compare");
}

function normalize(value: unknown): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function percentile(values: readonly number[], pct: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((pct / 100) * sorted.length) - 1));
  return Number(sorted[index]!.toFixed(2));
}

function toMarkdown(report: LongMemEvalReport): string {
  const lines = [
    "# LongMemEval Compatibility Report",
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
    "",
    "## Diagnostics",
    "",
    `- failureBreakdown: ${JSON.stringify(report.diagnostics.failureBreakdown)}`,
    `- sufficiencyBreakdown: ${JSON.stringify(report.diagnostics.sufficiencyBreakdown)}`,
    `- subjectMatchBreakdown: ${JSON.stringify(report.diagnostics.subjectMatchBreakdown)}`,
    `- synthesisModeBreakdown: ${JSON.stringify(report.diagnostics.synthesisModeBreakdown)}`,
    `- catalog.counts: ${JSON.stringify(report.catalog.counts)}`,
    `- catalog.finalClaimSource: ${JSON.stringify(report.catalog.buckets.finalClaimSource)}`,
    "",
    "## Production Readiness",
    "",
    `- manifestHitRate: ${report.productionReadiness.cache.manifestHitRate}`,
    `- sessionManifestHitRate: ${report.productionReadiness.cache.sessionManifestHitRate ?? report.productionReadiness.cache.manifestHitRate}`,
    `- warmSnapshotHitRate: ${report.productionReadiness.cache.warmSnapshotHitRate}`,
    `- coldRebuildCount: ${report.productionReadiness.cache.coldRebuildCount}`,
    `- sessionsSkipped: ${report.productionReadiness.cache.sessionsSkipped ?? 0}`,
    `- sessionsIngested: ${report.productionReadiness.cache.sessionsIngested ?? 0}`,
    `- staleManifestMismatchCount: ${report.productionReadiness.cache.staleManifestMismatchCount ?? report.productionReadiness.cache.staleCacheMismatchCount}`,
    `- answerParityMismatchCount: ${report.productionReadiness.cache.answerParityMismatchCount ?? 0}`,
    `- fallbackDerivedSuccessCount: ${report.productionReadiness.routePurity.fallbackDerivedSuccessCount}`,
    `- directRouteSuccessCountByFamily: ${JSON.stringify(report.productionReadiness.routePurity.directRouteSuccessCountByFamily)}`,
    "",
    "## Results",
    ""
  ];
    for (const result of report.results) {
    lines.push(
      `- ${result.questionId} (${result.questionType}): ${result.passed ? "pass" : "fail"} | normalized=${result.normalizedPassed ? "pass" : "fail"} | confidence=${result.confidence ?? "n/a"} | latency=${result.latencyMs} | evidence=${result.evidenceCount} | sources=${result.sourceCount}`
    );
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function downloadText(url: string, redirectCount = 0): Promise<string> {
  return new Promise((resolve, reject) => {
    get(url, (response) => {
      const location = response.headers.location;
      if (
        location &&
        response.statusCode &&
        response.statusCode >= 300 &&
        response.statusCode < 400
      ) {
        if (redirectCount >= 5) {
          reject(new Error(`too many redirects while fetching ${url}`));
          response.resume();
          return;
        }
        response.resume();
        const nextUrl = new URL(location, url).toString();
        downloadText(nextUrl, redirectCount + 1).then(resolve, reject);
        return;
      }
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
  const looksLikeJson = (value: string): boolean => {
    const trimmed = value.trim();
    return trimmed.startsWith("{") || trimmed.startsWith("[");
  };
  try {
    const cached = await readFile(destination, "utf8");
    if (looksLikeJson(cached)) {
      return cached;
    }
  } catch {
    // fall through to fresh download
  }

  await mkdir(path.dirname(destination), { recursive: true });
  const body = await downloadText(url);
  await writeFile(destination, body, "utf8");
  return body;
}

function formatSession(turns: readonly { readonly role: string; readonly content: string }[], date: string | undefined): string {
  const lines: string[] = [];
  if (date) {
    lines.push(`[${date}]`);
  }
  for (const turn of turns) {
    lines.push(`${turn.role}: ${turn.content}`);
  }
  return lines.join("\n");
}

function bestEffortPass(expectedAnswer: string, payload: any): boolean {
  const haystack = normalize(JSON.stringify(payload));
  const expected = normalize(expectedAnswer);
  if (!expected) {
    return false;
  }
  if (haystack.includes(expected)) {
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
  const expected = normalize(expectedAnswer);
  if (!expected || candidates.length === 0) {
    return false;
  }
  if (candidates.some((candidate) => candidate.includes(expected))) {
    return true;
  }
  const expectedTokens = expected.split(" ").filter((token) => token.length > 2);
  return candidates.some((candidate) => {
    const hitCount = expectedTokens.filter((token) => candidate.includes(token)).length;
    return expectedTokens.length > 0 && hitCount / expectedTokens.length >= 0.75;
  });
}

function readPayloadText(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    if (!/^[{\[]/u.test(trimmed)) {
      return trimmed;
    }
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      return readPayloadText(parsed);
    } catch {
      return trimmed;
    }
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const text = readPayloadText(entry);
      if (text) {
        return text;
      }
    }
    return null;
  }
  if (value && typeof value === "object") {
    const record = value as JsonRecord;
    for (const key of ["answer_value", "value", "text", "claim", "summary", "content"]) {
      const text = readPayloadText(record[key]);
      if (text) {
        return text;
      }
    }
  }
  return null;
}

export function renderLongMemAnswerSnippetForTest(payload: any, timedOut = false): string {
  if (timedOut) {
    return "query_timeout";
  }
  const text =
    readPayloadText(payload?.duality?.claim?.text) ??
    readPayloadText(payload?.summaryText) ??
    readPayloadText(payload?.claimText) ??
    readPayloadText(payload?.explanation) ??
    readPayloadText(payload?.duality?.claim) ??
    readPayloadText(payload);
  return (text ?? "None.").slice(0, 220);
}

function classifyFailure(
  entry: LongMemEvalEntry,
  passed: boolean,
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
    return entry.question_type.toLowerCase().includes("time") ? "temporal" : "retrieval";
  }
  const questionText = entry.question.toLowerCase();
  const questionType = entry.question_type.toLowerCase();
  if (questionType.includes("time") || questionText.includes("before") || questionText.includes("after")) {
    return "temporal";
  }
  if (
    /\b(both|common|share|together|similar|difference|compare)\b/.test(questionText) ||
    questionType.includes("multi")
  ) {
    return "synthesis_commonality";
  }
  if (/\b(current|currently|now|still|latest|changed|switch|moved|former|previous)\b/.test(questionText)) {
    return "conflict_resolution";
  }
  return "answer_shaping";
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

function readNumberRecord(value: unknown): Readonly<Record<string, number>> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter((entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1]));
  return entries.length > 0 ? Object.fromEntries(entries) : null;
}

function rate(numerator: number, denominator: number): number {
  if (denominator <= 0) {
    return 1;
  }
  return Number((numerator / denominator).toFixed(4));
}

function countStringValues(values: readonly (string | null | undefined)[]): Readonly<Record<string, number>> {
  const counts = new Map<string, number>();
  for (const value of values) {
    if (!value) {
      continue;
    }
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return Object.fromEntries([...counts.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

function buildStageFailureResult(params: {
  readonly entry: LongMemEvalEntry;
  readonly stage: "ingest" | "rebuild" | "query";
  readonly stageFailureReason: string;
  readonly latencyMs: number;
  readonly relationIeStage?: QueryResult["relationIeStage"];
  readonly relationIeSceneCount?: number;
  readonly relationIePromotedRows?: number;
  readonly relationIeRejectedRows?: number;
  readonly relationIeWarnings?: number;
  readonly relationIeCacheHits?: number;
  readonly relationIeCacheMisses?: number;
  readonly gliner2JobsSkipped?: number;
  readonly exactDetailFactKeyRows?: number;
}): QueryResult {
  const timedOut = params.stageFailureReason.includes("timed out after");
  const transportFailed = /\b(?:transport|invalid json|result file|result envelope|missing result_path)\b/i.test(params.stageFailureReason);
  const finalClaimSource =
    params.stage === "ingest"
      ? transportFailed
        ? "ingest_transport_error"
        : timedOut
        ? "ingest_timeout"
        : "ingest_error"
      : params.stage === "rebuild"
        ? transportFailed
          ? "rebuild_transport_error"
          : timedOut
          ? "rebuild_timeout"
          : "rebuild_error"
        : transportFailed
          ? "query_transport_error"
          : timedOut
          ? "query_timeout"
          : "query_error";
  return {
    questionId: params.entry.question_id,
    questionType: params.entry.question_type,
    question: params.entry.question,
    expectedAnswer: params.entry.answer,
    passed: false,
    normalizedPassed: false,
    failureClass: "retrieval",
    confidence: null,
    sufficiency: null,
    subjectMatch: null,
    synthesisMode: null,
    globalQueryRouted: false,
    summaryRoutingUsed: false,
    queryBehavior: params.entry.question_type.toLowerCase().includes("time") ? "temporal_detail" : null,
    finalClaimSource,
    retrievalMode: null,
    dominantStage: finalClaimSource,
    topStageMs: null,
    stageTimingsMs: null,
    candidateCountsByStage: null,
    rowsScannedByStage: null,
    compiledLookupTried: null,
    relationshipFastPathTried: null,
    relationshipFastPathSucceeded: null,
    sourceBoundedReadTried: null,
    sourceBoundedReadSucceeded: null,
    finalRouteFamily: null,
    semanticFallbackUsed: null,
    sqlHybridUsed: null,
    typedLaneDescentTriggered: null,
    plannerBackfillTriggered: null,
    graphExpansionTriggered: null,
    earlyStopReason: null,
    supportBundleFamily: null,
    authoritativeSource: null,
    abstentionReason: "insufficient_active_truth",
    entityResolutionStatus: null,
    temporalCoverageStatus: null,
    structuredSufficiencyStatus: null,
    fallbackUsed: null,
    fallbackReason: null,
    scalarTruthTried: null,
    eventTruthTried: null,
    backfillBlockedReason: null,
    selfBindingRecoveredFrom: null,
    claimAdmissibilityStatus: null,
    authoritativeClaimRejectedReason: null,
    factKeyLookupUsed: null,
    factKeyHitType: null,
    factRowSource: null,
    relationIeStage: params.relationIeStage ?? null,
    relationIeSceneCount: params.relationIeSceneCount ?? null,
    relationIePromotedRows: params.relationIePromotedRows ?? null,
    relationIeRejectedRows: params.relationIeRejectedRows ?? null,
    relationIeWarnings: params.relationIeWarnings ?? null,
    relationIeCacheHits: params.relationIeCacheHits ?? null,
    relationIeCacheMisses: params.relationIeCacheMisses ?? null,
    gliner2JobsSkipped: params.gliner2JobsSkipped ?? null,
    exactDetailFactKeyRows: params.exactDetailFactKeyRows ?? null,
    manifestStatus: null,
    ingestManifestKey: null,
    manifestInvalidationReason: null,
    sessionsSkipped: null,
    sessionsIngested: null,
    answerParityMismatch: null,
    staleManifestMismatch: null,
    benchmarkStage: params.stage,
    stageFailureReason: params.stageFailureReason,
    latencyMs: params.latencyMs,
    stageEnvelopeLatencyMs: params.latencyMs,
    evidenceCount: 0,
    sourceCount: 0,
    answerSnippet: finalClaimSource
  };
}

async function cleanupBenchmarkNamespaces(namespaceIds: readonly string[]): Promise<boolean> {
  try {
    await cleanupPublicBenchmarkNamespaces(namespaceIds, {
      logger: (message) => {
        process.stderr.write(`[longmemeval] ${message}\n`);
      }
    });
    return false;
  } catch (error) {
    if (isSoftCleanupFailure(error)) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`[longmemeval] cleanup soft-failed, continuing with per-run namespaces: ${message}\n`);
      return true;
    }
    throw error;
  }
}

interface ReusableLongMemNamespaceSnapshot {
  readonly namespaceId: string;
  readonly compiledRows: number;
  readonly exactDetailFactKeyRows: number;
  readonly artifactOnly: boolean;
  readonly snapshotVersionKey: string;
}

interface ReusableLongMemNamespaceSnapshotLookup {
  readonly snapshot: ReusableLongMemNamespaceSnapshot | null;
  readonly snapshotVersionKey: string | null;
  readonly snapshotInvalidationReason: string | null;
}

const LONGMEM_SNAPSHOT_CACHE_VERSION = "longmem_namespace_snapshot_v2";
const LONGMEM_SESSION_MANIFEST_VERSION = "longmem_session_manifest_v1";
const LONGMEM_RELATION_IE_CACHE_SCHEMA_VERSION = "external_relation_ie_scene_cache_v2";
const LONGMEM_TAXONOMY_TEMPORAL_SCHEMA_VERSION = "taxonomy_temporal_assistant_output_v1";
const LONGMEM_TEMPORAL_SEMANTIC_VERSION = "temporal_semantic_v1";
const LONGMEM_RETRIEVAL_ROUTE_VERSION = "route_complete_retrieval_v4";
const LONGMEM_READER_DISCIPLINE_VERSION = "source_bound_reader_discipline_v1";
const LONGMEM_GLINER2_MODEL_ID = "fastino/gliner2-base-v1";
const LONGMEM_ASSISTANT_MODEL_ID = "openai/gpt-5.4-mini";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

interface LongMemSourceSignatureEntry {
  readonly uri: string;
  readonly checksumSha256: string;
  readonly capturedAt: string;
  readonly byteSize: number;
}

interface LongMemCompilerSignature {
  readonly version: string;
  readonly relationIeMode: string | null;
  readonly relationIeCacheSchemaVersion: string;
  readonly taxonomyTemporalSchemaVersion: string;
  readonly taxonomyTemporalPromptVersion: string;
  readonly temporalSemanticVersion: string;
  readonly retrievalRouteVersion: string;
  readonly readerDisciplineVersion: string;
  readonly gliner2ModelId: string;
  readonly assistantModelId: string;
}

interface LongMemManifestIdentity {
  readonly datasetKey: string;
  readonly sampleId: string;
  readonly manifestKey: string;
  readonly sourceSignature: readonly LongMemSourceSignatureEntry[];
  readonly compilerSignature: LongMemCompilerSignature;
}

interface NamespaceReadModelCounts {
  readonly artifactCount: number;
  readonly chunkCount: number;
  readonly extractionUnitCount: number;
  readonly compiledFactRows: number;
  readonly compiledEventRows: number;
  readonly exactDetailFactKeyRows: number;
  readonly temporalEventRows: number;
  readonly readModelCount: number;
  readonly sourceSignature: readonly string[];
}

interface LongMemSessionManifestLookup {
  readonly namespaceId: string | null;
  readonly status: "cold_build" | "warm_manifest_hit" | "manifest_invalidated";
  readonly manifestKey: string;
  readonly invalidationReason: string | null;
  readonly counts: NamespaceReadModelCounts | null;
  readonly previousAnswerSnippet: string | null;
  readonly previousPassed: boolean | null;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableJson(entry)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function allowsArtifactOnlyLongMemReadModel(queryText: string): boolean {
  return (
    isConversationAboutPersonDirectQuery(queryText) ||
    isDecisionWaitDurationDirectQuery(queryText) ||
    isPreferredRatioDirectQuery(queryText) ||
    isTravelDestinationDirectQuery(queryText)
  );
}

function normalizeLongMemManifestInvalidationReason(
  reason: string | null | undefined
): LongMemManifestInvalidationReason | null {
  switch (reason) {
    case "source_hash_changed":
    case "compiler_version_changed":
    case "manifest_read_model_missing":
      return reason;
    case "missing_manifest":
    case "manifest_table_missing":
      return "missing_manifest";
    default:
      return null;
  }
}

function normalizeLongMemSnapshotInvalidationReason(
  reason: string | null | undefined
): LongMemSnapshotInvalidationReason | null {
  switch (reason) {
    case "artifact_signature_mismatch":
    case "candidate_read_model_empty":
    case "no_compatible_snapshot":
      return reason;
    case "current_artifact_signature_missing":
    case "no_candidate_snapshots":
    case "snapshot_miss_after_rebuild_timeout":
    case "snapshot_not_used_rebuild_error":
      return "no_compatible_snapshot";
    default:
      return null;
  }
}

function deriveLongMemManifestDecision(status: QueryResult["manifestStatus"]): LongMemManifestDecision {
  return status === "warm_manifest_hit" || status === "manifest_invalidated" ? status : "cold_build";
}

function deriveLongMemSnapshotDecision(
  snapshotStatus: string | null | undefined,
  snapshotInvalidationReason: string | null | undefined
): LongMemSnapshotDecision {
  if (snapshotStatus?.startsWith("warm_snapshot_hit")) {
    return "warm_snapshot_hit";
  }
  if (normalizeLongMemSnapshotInvalidationReason(snapshotInvalidationReason)) {
    return "snapshot_invalidated";
  }
  return "cold_rebuild";
}

function deriveLongMemReuseStage(snapshotStatus: string | null | undefined): LongMemReuseStage {
  switch (snapshotStatus) {
    case "warm_snapshot_hit_before_ingest":
      return "pre_ingest_manifest";
    case "warm_snapshot_hit_before_rebuild":
      return "pre_rebuild_snapshot";
    case "warm_snapshot_hit_after_rebuild_timeout":
      return "post_timeout_snapshot";
    default:
      return "cold_rebuild";
  }
}

function deriveLongMemParityStatus(params: {
  readonly manifestDecision: LongMemManifestDecision;
  readonly answerParityMismatch: boolean;
  readonly staleManifestMismatch: boolean;
}): LongMemParityStatus {
  if (params.manifestDecision !== "warm_manifest_hit") {
    return "not_applicable";
  }
  return params.answerParityMismatch || params.staleManifestMismatch ? "mismatch" : "matched";
}

function buildLongMemCompilerSignature(relationIeMode: string | null): LongMemCompilerSignature {
  return {
    version: LONGMEM_SESSION_MANIFEST_VERSION,
    relationIeMode,
    relationIeCacheSchemaVersion: LONGMEM_RELATION_IE_CACHE_SCHEMA_VERSION,
    taxonomyTemporalSchemaVersion: LONGMEM_TAXONOMY_TEMPORAL_SCHEMA_VERSION,
    taxonomyTemporalPromptVersion: ASSISTANT_PROMPT_VERSION,
    temporalSemanticVersion: LONGMEM_TEMPORAL_SEMANTIC_VERSION,
    retrievalRouteVersion: LONGMEM_RETRIEVAL_ROUTE_VERSION,
    readerDisciplineVersion: process.env.BRAIN_LONGMEM_READER_DISCIPLINE_VERSION ?? LONGMEM_READER_DISCIPLINE_VERSION,
    gliner2ModelId: process.env.BRAIN_RELATION_IE_GLINER2_MODEL ?? LONGMEM_GLINER2_MODEL_ID,
    assistantModelId: process.env.BRAIN_EXTRACTION_ASSISTANT_MODEL ?? LONGMEM_ASSISTANT_MODEL_ID
  };
}

export function buildLongMemSessionManifestIdentity(params: {
  readonly datasetKey: string;
  readonly sampleId: string;
  readonly sourceSignature: readonly LongMemSourceSignatureEntry[];
  readonly relationIeMode: string | null;
}): LongMemManifestIdentity {
  const compilerSignature = buildLongMemCompilerSignature(params.relationIeMode);
  const manifestKey = sha256(
    stableJson({
      datasetKey: params.datasetKey,
      sampleId: params.sampleId,
      sourceSignature: params.sourceSignature,
      compilerSignature
    })
  );
  return {
    datasetKey: params.datasetKey,
    sampleId: params.sampleId,
    manifestKey,
    sourceSignature: params.sourceSignature,
    compilerSignature
  };
}

function longMemSessionPath(corpusRoot: string, questionId: string, sessionIndex: number): string {
  return path.join(corpusRoot, `${questionId}-session-${sessionIndex + 1}.md`);
}

function buildLongMemEntrySourceSignature(params: {
  readonly entry: LongMemEvalEntry;
  readonly entryIndex: number;
  readonly corpusRoot: string;
}): readonly LongMemSourceSignatureEntry[] {
  return params.entry.haystack_sessions.map((session, sessionIndex) => {
    const text = formatSession(session, params.entry.haystack_dates?.[sessionIndex]);
    const fallbackCapturedAt = new Date(
      Date.UTC(2024, 0, 1, 0, 0, 0, 0) + params.entryIndex * 60_000 + sessionIndex * 1_000
    ).toISOString();
    return {
      uri: longMemSessionPath(params.corpusRoot, params.entry.question_id, sessionIndex),
      checksumSha256: sha256(text),
      capturedAt: normalizeBenchmarkCapturedAt(params.entry.haystack_dates?.[sessionIndex], fallbackCapturedAt),
      byteSize: Buffer.byteLength(text, "utf8")
    };
  });
}

export function artifactSignatureFromSourceSignature(
  sourceSignature: readonly LongMemSourceSignatureEntry[]
): readonly string[] {
  return sourceSignature.map((entry) => `${entry.uri}:${entry.checksumSha256}`).sort();
}

function buildLongMemSnapshotVersionKey(params: {
  readonly artifactSignature: readonly string[];
  readonly relationIeMode: string | null;
}): string {
  return sha256(
    JSON.stringify({
      version: LONGMEM_SNAPSHOT_CACHE_VERSION,
      sourceSignature: params.artifactSignature,
      relationIeMode: params.relationIeMode,
      relationIeCacheSchemaVersion: LONGMEM_RELATION_IE_CACHE_SCHEMA_VERSION,
      taxonomyTemporalSchemaVersion: LONGMEM_TAXONOMY_TEMPORAL_SCHEMA_VERSION,
      temporalSemanticVersion: LONGMEM_TEMPORAL_SEMANTIC_VERSION,
      retrievalRouteVersion: LONGMEM_RETRIEVAL_ROUTE_VERSION,
      readerDisciplineVersion: process.env.BRAIN_LONGMEM_READER_DISCIPLINE_VERSION ?? LONGMEM_READER_DISCIPLINE_VERSION,
      gliner2ModelId: process.env.BRAIN_RELATION_IE_GLINER2_MODEL ?? LONGMEM_GLINER2_MODEL_ID,
      assistantModelId: process.env.BRAIN_EXTRACTION_ASSISTANT_MODEL ?? LONGMEM_ASSISTANT_MODEL_ID
    })
  );
}

async function findReusableLongMemNamespaceSnapshot(params: {
  readonly questionId: string;
  readonly queryText: string;
  readonly currentNamespaceId: string;
  readonly relationIeMode: string | null;
  readonly artifactSignature?: readonly string[] | null;
}): Promise<ReusableLongMemNamespaceSnapshotLookup> {
  return withClient(async (client) => {
    const providedSignature = Array.isArray(params.artifactSignature)
      ? params.artifactSignature.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      : [];
    const currentSignature =
      providedSignature.length > 0
        ? providedSignature
        : (
            await client.query<{ readonly signature: string[] | null }>(
              `
                SELECT array_agg(uri || ':' || latest_checksum_sha256 ORDER BY uri) AS signature
                FROM artifacts
                WHERE namespace_id = $1
              `,
              [params.currentNamespaceId]
            )
          ).rows[0]?.signature ?? [];
    if (currentSignature.length === 0) {
      return {
        snapshot: null,
        snapshotVersionKey: null,
        snapshotInvalidationReason: "current_artifact_signature_missing"
      };
    }
    const snapshotVersionKey = buildLongMemSnapshotVersionKey({
      artifactSignature: currentSignature,
      relationIeMode: params.relationIeMode
    });
    const candidates = await client.query<{
      readonly namespace_id: string;
      readonly signature: string[] | null;
      readonly exact_detail_fact_key_rows: number;
      readonly compiled_fact_rows: number;
      readonly compiled_event_rows: number;
      readonly temporal_event_rows: number;
      readonly latest_created_at: string;
    }>(
      `
        SELECT
          artifacts.namespace_id,
          array_agg(artifacts.uri || ':' || artifacts.latest_checksum_sha256 ORDER BY artifacts.uri) AS signature,
          (
            SELECT COUNT(*)::int
            FROM exact_detail_fact_keys fact_keys
            WHERE fact_keys.namespace_id = artifacts.namespace_id
          ) AS exact_detail_fact_key_rows,
          (
            SELECT COUNT(*)::int
            FROM compiled_fact_observations compiled_facts
            WHERE compiled_facts.namespace_id = artifacts.namespace_id
          ) AS compiled_fact_rows,
          (
            SELECT COUNT(*)::int
            FROM compiled_event_observations compiled_events
            WHERE compiled_events.namespace_id = artifacts.namespace_id
          ) AS compiled_event_rows,
          (
            SELECT COUNT(*)::int
            FROM temporal_event_facts temporal_events
            WHERE temporal_events.namespace_id = artifacts.namespace_id
          ) AS temporal_event_rows,
          MAX(artifacts.created_at)::text AS latest_created_at
        FROM artifacts
        WHERE artifacts.metadata->>'question_id' = $1
          AND artifacts.namespace_id <> $2
          AND artifacts.namespace_id LIKE 'benchmark_longmemeval_%'
        GROUP BY artifacts.namespace_id
        ORDER BY MAX(artifacts.created_at) DESC
        LIMIT 50
      `,
      [params.questionId, params.currentNamespaceId]
    );
    if (candidates.rows.length === 0) {
      return {
        snapshot: null,
        snapshotVersionKey,
        snapshotInvalidationReason: "no_candidate_snapshots"
      };
    }
    const currentKey = JSON.stringify(currentSignature);
    let sawSignatureMismatch = false;
    let sawEmptyReadModel = false;
    const allowArtifactOnlySnapshot = allowsArtifactOnlyLongMemReadModel(params.queryText);
    for (const candidate of candidates.rows) {
      const candidateSignature = candidate.signature ?? [];
      if (JSON.stringify(candidateSignature) !== currentKey) {
        sawSignatureMismatch = true;
        continue;
      }
      const compiledRows = Number(candidate.compiled_fact_rows ?? 0) + Number(candidate.compiled_event_rows ?? 0);
      const exactRows = Number(candidate.exact_detail_fact_key_rows ?? 0);
      const temporalRows = Number(candidate.temporal_event_rows ?? 0);
      const artifactOnly = compiledRows + exactRows + temporalRows <= 0;
      if (artifactOnly && !allowArtifactOnlySnapshot) {
        sawEmptyReadModel = true;
        continue;
      }
      return {
        snapshot: {
          namespaceId: candidate.namespace_id,
          compiledRows,
          exactDetailFactKeyRows: exactRows,
          artifactOnly,
          snapshotVersionKey
        },
        snapshotVersionKey,
        snapshotInvalidationReason: null
      };
    }
    return {
      snapshot: null,
      snapshotVersionKey,
      snapshotInvalidationReason: sawSignatureMismatch
        ? "artifact_signature_mismatch"
        : sawEmptyReadModel
          ? "candidate_read_model_empty"
          : "no_compatible_snapshot"
    };
  });
}

async function loadNamespaceReadModelCounts(namespaceId: string): Promise<NamespaceReadModelCounts> {
  return withClient(async (client) => {
    const rows = await client.query<{
      readonly artifact_count: number;
      readonly chunk_count: number;
      readonly extraction_unit_count: number;
      readonly compiled_fact_rows: number;
      readonly compiled_event_rows: number;
      readonly exact_detail_fact_key_rows: number;
      readonly temporal_event_rows: number;
      readonly signature: string[] | null;
    }>(
      `
        SELECT
          (
            SELECT COUNT(*)::int
            FROM artifacts
            WHERE namespace_id = $1
          ) AS artifact_count,
          (
            SELECT COUNT(*)::int
            FROM artifact_chunks chunks
            JOIN artifacts artifacts_for_chunks ON artifacts_for_chunks.id = chunks.artifact_id
            WHERE artifacts_for_chunks.namespace_id = $1
          ) AS chunk_count,
          (
            SELECT COUNT(*)::int
            FROM extraction_units
            WHERE namespace_id = $1
          ) AS extraction_unit_count,
          (
            SELECT COUNT(*)::int
            FROM compiled_fact_observations
            WHERE namespace_id = $1
          ) AS compiled_fact_rows,
          (
            SELECT COUNT(*)::int
            FROM compiled_event_observations
            WHERE namespace_id = $1
          ) AS compiled_event_rows,
          (
            SELECT COUNT(*)::int
            FROM exact_detail_fact_keys
            WHERE namespace_id = $1
          ) AS exact_detail_fact_key_rows,
          (
            SELECT COUNT(*)::int
            FROM temporal_event_facts
            WHERE namespace_id = $1
          ) AS temporal_event_rows,
          (
            SELECT array_agg(uri || ':' || latest_checksum_sha256 ORDER BY uri)
            FROM artifacts
            WHERE namespace_id = $1
          ) AS signature
      `,
      [namespaceId]
    );
    const row = rows.rows[0];
    const compiledFactRows = Number(row?.compiled_fact_rows ?? 0);
    const compiledEventRows = Number(row?.compiled_event_rows ?? 0);
    const exactDetailFactKeyRows = Number(row?.exact_detail_fact_key_rows ?? 0);
    const temporalEventRows = Number(row?.temporal_event_rows ?? 0);
    return {
      artifactCount: Number(row?.artifact_count ?? 0),
      chunkCount: Number(row?.chunk_count ?? 0),
      extractionUnitCount: Number(row?.extraction_unit_count ?? 0),
      compiledFactRows,
      compiledEventRows,
      exactDetailFactKeyRows,
      temporalEventRows,
      readModelCount: compiledFactRows + compiledEventRows + exactDetailFactKeyRows + temporalEventRows,
      sourceSignature: row?.signature ?? []
    };
  });
}

function isUndefinedTableError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "42P01";
}

async function invalidateLongMemSessionManifest(manifestId: string, reason: string): Promise<void> {
  await withClient(async (client) => {
    await client.query(
      `
        UPDATE dataset_session_manifests
        SET
          manifest_status = 'manifest_invalidated',
          invalidated_at = now(),
          invalidation_reason = $2
        WHERE id = $1
      `,
      [manifestId, reason]
    );
  });
}

async function findReusableLongMemSessionManifest(params: {
  readonly identity: LongMemManifestIdentity;
  readonly queryText: string;
}): Promise<LongMemSessionManifestLookup> {
  try {
    return await withClient(async (client) => {
      const rows = await client.query<{
        readonly id: string;
        readonly namespace_id: string;
        readonly manifest_payload: JsonRecord;
        readonly source_signature: unknown;
        readonly compiler_signature: unknown;
        readonly artifact_count: number;
        readonly chunk_count: number;
        readonly extraction_unit_count: number;
        readonly read_model_count: number;
      }>(
        `
          SELECT
            id,
            namespace_id,
            manifest_payload,
            source_signature,
            compiler_signature,
            artifact_count,
            chunk_count,
            extraction_unit_count,
            read_model_count
          FROM dataset_session_manifests
          WHERE dataset_key = $1
            AND sample_id = $2
            AND manifest_key = $3
            AND manifest_status <> 'manifest_invalidated'
          ORDER BY last_used_at DESC NULLS LAST, created_at DESC
          LIMIT 1
        `,
        [params.identity.datasetKey, params.identity.sampleId, params.identity.manifestKey]
      );
      const manifest = rows.rows[0];
      if (!manifest) {
        return {
          namespaceId: null,
          status: "cold_build",
          manifestKey: params.identity.manifestKey,
          invalidationReason: "missing_manifest",
          counts: null,
          previousAnswerSnippet: null,
          previousPassed: null
        };
      }
      if (stableJson(manifest.source_signature) !== stableJson(params.identity.sourceSignature)) {
        await invalidateLongMemSessionManifest(manifest.id, "source_hash_changed");
        return {
          namespaceId: null,
          status: "manifest_invalidated",
          manifestKey: params.identity.manifestKey,
          invalidationReason: "source_hash_changed",
          counts: null,
          previousAnswerSnippet: null,
          previousPassed: null
        };
      }
      if (stableJson(manifest.compiler_signature) !== stableJson(params.identity.compilerSignature)) {
        await invalidateLongMemSessionManifest(manifest.id, "compiler_version_changed");
        return {
          namespaceId: null,
          status: "manifest_invalidated",
          manifestKey: params.identity.manifestKey,
          invalidationReason: "compiler_version_changed",
          counts: null,
          previousAnswerSnippet: null,
          previousPassed: null
        };
      }
      const counts = await loadNamespaceReadModelCounts(manifest.namespace_id);
      const expectedSignature = artifactSignatureFromSourceSignature(params.identity.sourceSignature);
      if (stableJson(counts.sourceSignature) !== stableJson(expectedSignature)) {
        await invalidateLongMemSessionManifest(manifest.id, "source_hash_changed");
        return {
          namespaceId: null,
          status: "manifest_invalidated",
          manifestKey: params.identity.manifestKey,
          invalidationReason: "source_hash_changed",
          counts,
          previousAnswerSnippet: null,
          previousPassed: null
        };
      }
      const allowArtifactOnlySnapshot = allowsArtifactOnlyLongMemReadModel(params.queryText);
      if (counts.artifactCount <= 0 || counts.chunkCount <= 0 || (counts.readModelCount <= 0 && !allowArtifactOnlySnapshot)) {
        await invalidateLongMemSessionManifest(manifest.id, "manifest_read_model_missing");
        return {
          namespaceId: null,
          status: "manifest_invalidated",
          manifestKey: params.identity.manifestKey,
          invalidationReason: "manifest_read_model_missing",
          counts,
          previousAnswerSnippet: null,
          previousPassed: null
        };
      }
      await client.query(
        `
          UPDATE dataset_session_manifests
          SET
            manifest_status = 'warm_manifest_hit',
            hit_count = hit_count + 1,
            last_used_at = now(),
            artifact_count = $2,
            chunk_count = $3,
            extraction_unit_count = $4,
            read_model_count = $5,
            invalidated_at = NULL,
            invalidation_reason = NULL
          WHERE id = $1
        `,
        [manifest.id, counts.artifactCount, counts.chunkCount, counts.extractionUnitCount, counts.readModelCount]
      );
      return {
        namespaceId: manifest.namespace_id,
        status: "warm_manifest_hit",
        manifestKey: params.identity.manifestKey,
        invalidationReason: null,
        counts,
        previousAnswerSnippet:
          typeof manifest.manifest_payload?.lastAnswerSnippet === "string" ? manifest.manifest_payload.lastAnswerSnippet : null,
        previousPassed: typeof manifest.manifest_payload?.lastPassed === "boolean" ? manifest.manifest_payload.lastPassed : null
      };
    });
  } catch (error) {
    if (isUndefinedTableError(error)) {
      return {
        namespaceId: null,
        status: "manifest_invalidated",
        manifestKey: params.identity.manifestKey,
        invalidationReason: "manifest_table_missing",
        counts: null,
        previousAnswerSnippet: null,
        previousPassed: null
      };
    }
    throw error;
  }
}

async function upsertLongMemSessionManifest(params: {
  readonly identity: LongMemManifestIdentity;
  readonly namespaceId: string;
  readonly counts: NamespaceReadModelCounts;
  readonly snapshotVersionKey: string | null;
  readonly lastPassed: boolean;
  readonly lastAnswerSnippet: string;
}): Promise<void> {
  try {
    await withClient(async (client) => {
      await client.query(
        `
          INSERT INTO dataset_session_manifests (
            namespace_id,
            dataset_key,
            sample_id,
            manifest_key,
            manifest_status,
            manifest_payload,
            source_signature,
            compiler_signature,
            artifact_count,
            chunk_count,
            extraction_unit_count,
            read_model_count,
            last_used_at
          )
          VALUES ($1, $2, $3, $4, 'cold_build', $5::jsonb, $6::jsonb, $7::jsonb, $8, $9, $10, $11, now())
          ON CONFLICT (dataset_key, sample_id, manifest_key)
          DO UPDATE SET
            namespace_id = EXCLUDED.namespace_id,
            manifest_status = 'cold_build',
            manifest_payload = EXCLUDED.manifest_payload,
            source_signature = EXCLUDED.source_signature,
            compiler_signature = EXCLUDED.compiler_signature,
            artifact_count = EXCLUDED.artifact_count,
            chunk_count = EXCLUDED.chunk_count,
            extraction_unit_count = EXCLUDED.extraction_unit_count,
            read_model_count = EXCLUDED.read_model_count,
            last_used_at = now(),
            invalidated_at = NULL,
            invalidation_reason = NULL
        `,
        [
          params.namespaceId,
          params.identity.datasetKey,
          params.identity.sampleId,
          params.identity.manifestKey,
          JSON.stringify({
            namespaceId: params.namespaceId,
            snapshotVersionKey: params.snapshotVersionKey,
            lastPassed: params.lastPassed,
            lastAnswerSnippet: params.lastAnswerSnippet,
            updatedAt: new Date().toISOString()
          }),
          JSON.stringify(params.identity.sourceSignature),
          JSON.stringify(params.identity.compilerSignature),
          params.counts.artifactCount,
          params.counts.chunkCount,
          params.counts.extractionUnitCount,
          params.counts.readModelCount
        ]
      );
    });
  } catch (error) {
    if (!isUndefinedTableError(error)) {
      throw error;
    }
  }
}

async function writePartialArtifact(
  runtime: BenchmarkRuntimeMetadata,
  progress: LongMemEvalProgressState,
  latencies: readonly number[],
  results: readonly QueryResult[],
  failureReason?: string
): Promise<string> {
  await mkdir(outputDir(), { recursive: true });
  const partialPath = path.join(outputDir(), `longmemeval-${progress.runStamp}.partial.json`);
  const partial: PartialLongMemEvalArtifact = {
    generatedAt: new Date().toISOString(),
    dataset: "longmemeval_s_cleaned",
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

function killChildProcessTree(childPid: number | undefined): void {
  if (!childPid) {
    return;
  }
  if (process.platform === "win32") {
    try {
      spawn("taskkill", ["/pid", String(childPid), "/T", "/F"], { stdio: "ignore" });
    } catch {
      // best effort
    }
    return;
  }
  try {
    process.kill(-childPid, "SIGKILL");
    return;
  } catch {
    // fall through to single pid kill
  }
  try {
    process.kill(childPid, "SIGKILL");
  } catch {
    // Child already exited.
  }
}

async function runLongMemStageWorker<T>(
  label: string,
  timeoutMs: number,
  envelope: {
    readonly stage: "ingest" | "rebuild" | "query";
    readonly payload: Record<string, unknown>;
  }
): Promise<T> {
  await mkdir(outputDir(), { recursive: true });
  const resultPath = stageWorkerResultPath(envelope.stage);
  const child = spawn(process.execPath, [stageWorkerPath()], {
    cwd: localBrainRoot(),
    detached: process.platform !== "win32",
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      PGAPPNAME: `brain-longmemeval-stage:${envelope.stage}`
    }
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  const started = child.stdin.write(JSON.stringify({ ...envelope, resultPath }));
  if (started) {
    child.stdin.end();
  } else {
    await new Promise<void>((resolve, reject) => {
      child.stdin.once("drain", () => {
        child.stdin.end();
        resolve();
      });
      child.stdin.once("error", (error) => {
        reject(error);
      });
    });
  }

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutHandle);
      fn();
    };
    const timeoutHandle = setTimeout(() => {
      killChildProcessTree(child.pid);
      finish(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)));
    }, timeoutMs);
    child.once("error", (error) => {
      finish(() => reject(error instanceof Error ? error : new Error(String(error))));
    });
    child.once("close", (code) => {
      finish(() => {
        if (code !== 0) {
          const diagnostic = stderr.trim() || stdout.trim();
          reject(new Error(`${label} failed with exit code ${code}${diagnostic ? `: ${diagnostic}` : ""}`));
          return;
        }
        try {
          const parsed = JSON.parse(stdout) as { readonly ok?: boolean; readonly result?: T; readonly resultPath?: string; readonly error?: string };
          if (parsed.ok !== true) {
            reject(new Error(parsed.error ?? `${label} failed`));
            return;
          }
          const resolvedResultPath = typeof parsed.resultPath === "string" && parsed.resultPath.trim() ? parsed.resultPath : resultPath;
          readFile(resolvedResultPath, "utf8")
            .then((raw) => {
              const resultEnvelope = JSON.parse(raw) as { readonly ok?: boolean; readonly result?: T; readonly error?: string };
              if (resultEnvelope.ok !== true) {
                throw new Error(resultEnvelope.error ?? `${label} result file reported failure`);
              }
              resolve(resultEnvelope.result as T);
            })
            .catch((error: unknown) => {
              reject(new Error(`${label} result transport failed: ${error instanceof Error ? error.message : String(error)}`));
            })
            .finally(() => {
              void unlink(resolvedResultPath).catch(() => undefined);
            });
        } catch (error) {
          reject(new Error(`${label} returned invalid result envelope JSON: ${String(error)}\n${stdout}`));
        }
      });
    });
  });
}

export async function runAndWriteLongMemEvalBenchmark(): Promise<{
  readonly report: LongMemEvalReport;
  readonly output: { readonly jsonPath: string; readonly markdownPath: string };
}> {
  return withMaintenanceLock("the LongMemEval compatibility benchmark", async () => {
    process.env.BRAIN_TIMESCALE_MAX_TUPLES_DECOMPRESSED_PER_DML_TRANSACTION ??= "0";
    const runStartedAt = performance.now();
    const runStamp = new Date().toISOString().replace(/[:.]/g, "-");
    const queryTimeoutMs = resolveBenchmarkTimeoutMs();
    const ingestTimeoutMs = resolveIngestTimeoutMs();
    const rebuildTimeoutMs = resolveRebuildTimeoutMs();
    const heartbeatMs = resolveHeartbeatMs();
    const partialFlushEvery = resolvePartialFlushEvery();
    const raw = await downloadCached(
      "https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_s_cleaned.json",
      "longmemeval_s_cleaned.json"
    );
    const parsed = JSON.parse(raw) as readonly LongMemEvalEntry[];
    const sampleCount = resolveRequestedSampleCount(process.env.BRAIN_LONGMEMEVAL_SAMPLE_COUNT, 8, parsed.length);
    const namespaceBatchSize = resolveRequestedSampleCount(process.env.BRAIN_LONGMEMEVAL_NAMESPACE_BATCH_SIZE, 25, sampleCount);
    const performInlineCleanup = shouldForceLongMemEvalCleanup() && !shouldSkipPublicBenchmarkCleanup();
    let cleanupSoftFailures = 0;
    const entries = parsed.slice(0, sampleCount);
    const results: QueryResult[] = [];
    const latencies: number[] = [];
    const activeNamespaceIds: string[] = [];
    let cleanupDisabledAfterSoftFailure = false;
    const corpusRoot = path.join(generatedRoot(), "longmemeval");
    let completedQuestions = 0;
    let currentQuestionId: string | null = null;
    let currentQuestionIndex: number | null = null;
    let currentStage: "ingest" | "rebuild" | "query" | null = null;
    let currentStageSessionIndex: number | null = null;
    let lastProgressAt = new Date().toISOString();
    const benchmarkMode = resolvePublicBenchmarkMode(sampleCount, parsed.length);
    const runtime = buildBenchmarkRuntimeMetadata({
      benchmarkMode,
      sampleControls: {
        requestedSampleCount: process.env.BRAIN_LONGMEMEVAL_SAMPLE_COUNT ?? null,
        resolvedSampleCount: sampleCount,
        totalDatasetCount: parsed.length,
        skipCleanup: !performInlineCleanup,
        cleanupStrategy: performInlineCleanup ? "inline" : "per_run_namespace_only",
        cleanupSoftFailures,
        cleanupDisabledAfterSoftFailure,
        ingestTimeoutMs,
        rebuildTimeoutMs,
        queryTimeoutMs,
        heartbeatMs,
        partialFlushEvery
      }
    });
    const progressState = (): LongMemEvalProgressState => ({
      runStamp,
      currentQuestionId,
      currentQuestionIndex,
      currentStage,
      currentStageSessionIndex,
      totalQuestionsPlanned: entries.length,
      completedQuestions,
      lastProgressAt
    });
    const flushPartial = async (failureReason?: string): Promise<void> => {
      const partialPath = await writePartialArtifact(runtime, progressState(), latencies, results, failureReason);
      benchmarkLog(
        `partial artifact wrote path=${partialPath} results=${results.length} completed=${completedQuestions}/${entries.length}${failureReason ? ` reason=${failureReason}` : ""}`
      );
    };
    benchmarkLog(
      `start runStamp=${runStamp} sampleCount=${sampleCount} ingestTimeoutMs=${ingestTimeoutMs} rebuildTimeoutMs=${rebuildTimeoutMs} queryTimeoutMs=${queryTimeoutMs} heartbeatMs=${heartbeatMs} partialFlushEvery=${partialFlushEvery}`
    );
    const heartbeat = setInterval(() => {
      const idleMs = Date.now() - Date.parse(lastProgressAt);
      benchmarkLog(
        `heartbeat completed=${completedQuestions}/${entries.length} questionId=${currentQuestionId ?? "none"} questionIndex=${currentQuestionIndex ?? "none"} stage=${currentStage ?? "none"} session=${currentStageSessionIndex ?? "none"} idleMs=${idleMs}`
      );
    }, heartbeatMs);
    const signalHandler = (signal: NodeJS.Signals): void => {
      benchmarkLog(`received ${signal}; attempting partial artifact flush`);
      void flushPartial(`interrupted_by_${signal.toLowerCase()}`);
    };
    process.on("SIGINT", signalHandler);
    process.on("SIGTERM", signalHandler);
    await mkdir(corpusRoot, { recursive: true });

    try {
      for (const [index, entry] of entries.entries()) {
        currentQuestionId = entry.question_id;
        currentQuestionIndex = index;
        const namespaceId = `benchmark_longmemeval_${runStamp}_${index}`;
        let queryNamespaceId = namespaceId;
        let namespaceSnapshotStatus: string | null = "cold_rebuild";
        let namespaceSnapshotSource: string | null = null;
        let snapshotVersionKey: string | null = null;
        let snapshotInvalidationReason: string | null = null;
        let manifestStatus: "cold_build" | "warm_manifest_hit" | "manifest_invalidated" | null = "cold_build";
        let ingestManifestKey: string | null = null;
        let manifestInvalidationReason: string | null = null;
        let sessionsSkipped = 0;
        let sessionsIngested = 0;
        let answerParityMismatch = false;
        let staleManifestMismatch = false;
        let previousManifestAnswerSnippet: string | null = null;
        let previousManifestPassed: boolean | null = null;
        const questionStartedAt = performance.now();
        let stageFailure: { stage: "ingest" | "rebuild" | "query"; reason: string } | null = null;
        let relationIeStage: string | null = null;
        let relationIeSceneCount = 0;
        let relationIePromotedRows = 0;
        let relationIeRejectedRows = 0;
        let relationIeWarnings = 0;
        let relationIeCacheHits = 0;
        let relationIeCacheMisses = 0;
        let gliner2JobsSkipped = 0;
        let exactDetailFactKeyRows = 0;
        const forceRelationIePromotion = shouldForceLongMemRelationIePromotion(entry.question);
        const relationIeMode = forceRelationIePromotion ? "support_and_promote" : null;
        const sourceSignature = buildLongMemEntrySourceSignature({
          entry,
          entryIndex: index,
          corpusRoot
        });
        const sourceArtifactSignature = artifactSignatureFromSourceSignature(sourceSignature);
        const manifestIdentity = buildLongMemSessionManifestIdentity({
          datasetKey: "longmemeval_s_cleaned",
          sampleId: entry.question_id,
          sourceSignature,
          relationIeMode
        });
        ingestManifestKey = manifestIdentity.manifestKey;
        currentStage = "ingest";
        currentStageSessionIndex = 0;
        lastProgressAt = new Date().toISOString();
        try {
          const manifestLookup = await findReusableLongMemSessionManifest({
            identity: manifestIdentity,
            queryText: entry.question
          });
          manifestStatus = manifestLookup.status;
          manifestInvalidationReason = manifestLookup.invalidationReason;
          if (manifestLookup.namespaceId) {
            queryNamespaceId = manifestLookup.namespaceId;
            namespaceSnapshotStatus = "warm_snapshot_hit_before_ingest";
            namespaceSnapshotSource = manifestLookup.namespaceId;
            snapshotVersionKey = buildLongMemSnapshotVersionKey({
              artifactSignature: sourceArtifactSignature,
              relationIeMode
            });
            snapshotInvalidationReason = null;
            exactDetailFactKeyRows = Math.max(exactDetailFactKeyRows, manifestLookup.counts?.exactDetailFactKeyRows ?? 0);
            sessionsSkipped = entry.haystack_sessions.length;
            previousManifestAnswerSnippet = manifestLookup.previousAnswerSnippet;
            previousManifestPassed = manifestLookup.previousPassed;
            benchmarkLog(
              `questionId=${entry.question_id} ingest skipped with session manifest namespace=${manifestLookup.namespaceId} manifestKey=${manifestLookup.manifestKey} readModelRows=${manifestLookup.counts?.readModelCount ?? 0}`
            );
          } else {
            for (const [sessionIndex, session] of entry.haystack_sessions.entries()) {
              currentStageSessionIndex = sessionIndex + 1;
              lastProgressAt = new Date().toISOString();
              benchmarkLog(`questionId=${entry.question_id} ingest start session=${sessionIndex + 1}/${entry.haystack_sessions.length}`);
              const sessionPath = longMemSessionPath(corpusRoot, entry.question_id, sessionIndex);
              await writeFile(sessionPath, formatSession(session, entry.haystack_dates?.[sessionIndex]), "utf8");
              const ingestStageResult = await runLongMemStageWorker<any>(
                `LongMemEval ingest ${entry.question_id} session ${sessionIndex + 1}`,
                ingestTimeoutMs,
                {
                  stage: "ingest",
                  payload: {
                    namespaceId,
                    sessionPath,
                    capturedAt: sourceSignature[sessionIndex]?.capturedAt,
                    questionId: entry.question_id,
                    questionType: entry.question_type
                  }
                }
              );
              sessionsIngested += 1;
              if (ingestStageResult?.relationIeTelemetry) {
                relationIeStage = ingestStageResult.relationIeTelemetry.relationIeStage ?? relationIeStage;
                relationIeSceneCount = Math.max(relationIeSceneCount, Number(ingestStageResult.relationIeTelemetry.relationIeSceneCount ?? 0));
                relationIeWarnings = Math.max(relationIeWarnings, Number(ingestStageResult.relationIeTelemetry.relationIeWarnings ?? 0));
                relationIeCacheHits = Math.max(relationIeCacheHits, Number(ingestStageResult.relationIeTelemetry.relationIeCacheHits ?? 0));
                relationIeCacheMisses = Math.max(relationIeCacheMisses, Number(ingestStageResult.relationIeTelemetry.relationIeCacheMisses ?? 0));
                gliner2JobsSkipped = Math.max(gliner2JobsSkipped, Number(ingestStageResult.relationIeTelemetry.gliner2JobsSkipped ?? 0));
              }
            }
          }
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          benchmarkLog(`questionId=${entry.question_id} ingest timed out or failed reason=${reason}`);
          stageFailure = { stage: "ingest", reason };
        }
        if (!stageFailure) {
          currentStage = "rebuild";
          currentStageSessionIndex = null;
          lastProgressAt = new Date().toISOString();
          const preRebuildSnapshotLookup =
            queryNamespaceId === namespaceId
              ? await findReusableLongMemNamespaceSnapshot({
                  questionId: entry.question_id,
                  queryText: entry.question,
                  currentNamespaceId: namespaceId,
                  relationIeMode,
                  artifactSignature: sourceArtifactSignature
                })
              : {
                  snapshot: null,
                  snapshotVersionKey,
                  snapshotInvalidationReason: null
                };
          snapshotVersionKey = preRebuildSnapshotLookup.snapshotVersionKey;
          snapshotInvalidationReason = preRebuildSnapshotLookup.snapshotInvalidationReason;
          const preRebuildSnapshot = preRebuildSnapshotLookup.snapshot;
          if (queryNamespaceId !== namespaceId) {
            namespaceSnapshotStatus = "warm_snapshot_hit_before_ingest";
            snapshotInvalidationReason = null;
            benchmarkLog(
              `questionId=${entry.question_id} rebuild skipped after pre-ingest manifest namespace=${queryNamespaceId} snapshotVersionKey=${snapshotVersionKey ?? "none"}`
            );
          } else if (preRebuildSnapshot) {
            queryNamespaceId = preRebuildSnapshot.namespaceId;
            namespaceSnapshotStatus = "warm_snapshot_hit_before_rebuild";
            namespaceSnapshotSource = preRebuildSnapshot.namespaceId;
            snapshotVersionKey = preRebuildSnapshot.snapshotVersionKey;
            snapshotInvalidationReason = null;
            exactDetailFactKeyRows = Math.max(exactDetailFactKeyRows, preRebuildSnapshot.exactDetailFactKeyRows);
            benchmarkLog(
              `questionId=${entry.question_id} rebuild skipped with namespace snapshot=${preRebuildSnapshot.namespaceId} compiledRows=${preRebuildSnapshot.compiledRows} factKeys=${preRebuildSnapshot.exactDetailFactKeyRows} artifactOnly=${preRebuildSnapshot.artifactOnly} snapshotVersionKey=${preRebuildSnapshot.snapshotVersionKey}`
            );
          } else {
            benchmarkLog(
              `questionId=${entry.question_id} rebuild start snapshotInvalidationReason=${snapshotInvalidationReason ?? "snapshot_miss"} snapshotVersionKey=${snapshotVersionKey ?? "none"}`
            );
            try {
              const rebuildStageResult = await runLongMemStageWorker<any>(`LongMemEval rebuild ${entry.question_id}`, rebuildTimeoutMs, {
                stage: "rebuild",
                payload: {
                  namespaceId,
                  query: entry.question,
                  forceRelationIe: forceRelationIePromotion,
                  relationIeMode: forceRelationIePromotion ? "support_and_promote" : undefined,
                  relationIeExtractors: forceRelationIePromotion ? ["gliner2"] : undefined
                }
              });
              if (rebuildStageResult?.relationIeTelemetry) {
                relationIeStage = rebuildStageResult.relationIeTelemetry.relationIeStage ?? relationIeStage;
                relationIeSceneCount = Number(rebuildStageResult.relationIeTelemetry.relationIeSceneCount ?? relationIeSceneCount);
                relationIePromotedRows = Number(rebuildStageResult.relationIeTelemetry.relationIePromotedRows ?? 0);
                relationIeRejectedRows = Number(rebuildStageResult.relationIeTelemetry.relationIeRejectedRows ?? 0);
                relationIeWarnings = Number(rebuildStageResult.relationIeTelemetry.relationIeWarnings ?? relationIeWarnings);
                relationIeCacheHits = Number(rebuildStageResult.relationIeTelemetry.relationIeCacheHits ?? relationIeCacheHits);
                relationIeCacheMisses = Number(rebuildStageResult.relationIeTelemetry.relationIeCacheMisses ?? relationIeCacheMisses);
                gliner2JobsSkipped = Number(rebuildStageResult.relationIeTelemetry.gliner2JobsSkipped ?? gliner2JobsSkipped);
                exactDetailFactKeyRows = Number(rebuildStageResult.relationIeTelemetry.exactDetailFactKeyRows ?? 0);
              }
            } catch (error) {
              const reason = error instanceof Error ? error.message : String(error);
              benchmarkLog(`questionId=${entry.question_id} rebuild timed out or failed reason=${reason}`);
              if (reason.includes("timed out after")) {
                const reusableSnapshotLookup = await findReusableLongMemNamespaceSnapshot({
                  questionId: entry.question_id,
                  queryText: entry.question,
                  currentNamespaceId: namespaceId,
                  relationIeMode,
                  artifactSignature: sourceArtifactSignature
                });
                snapshotVersionKey = reusableSnapshotLookup.snapshotVersionKey;
                snapshotInvalidationReason = reusableSnapshotLookup.snapshotInvalidationReason;
                const reusableSnapshot = reusableSnapshotLookup.snapshot;
                if (reusableSnapshot) {
                  queryNamespaceId = reusableSnapshot.namespaceId;
                  namespaceSnapshotStatus = "warm_snapshot_hit_after_rebuild_timeout";
                  namespaceSnapshotSource = reusableSnapshot.namespaceId;
                  snapshotVersionKey = reusableSnapshot.snapshotVersionKey;
                  snapshotInvalidationReason = null;
                  exactDetailFactKeyRows = Math.max(exactDetailFactKeyRows, reusableSnapshot.exactDetailFactKeyRows);
                  benchmarkLog(
                    `questionId=${entry.question_id} rebuild timeout recovered with namespace snapshot=${reusableSnapshot.namespaceId} compiledRows=${reusableSnapshot.compiledRows} factKeys=${reusableSnapshot.exactDetailFactKeyRows} snapshotVersionKey=${reusableSnapshot.snapshotVersionKey}`
                  );
                } else {
                  namespaceSnapshotStatus = "snapshot_miss_after_rebuild_timeout";
                  stageFailure = { stage: "rebuild", reason };
                }
              } else {
                namespaceSnapshotStatus = "snapshot_not_used_rebuild_error";
                stageFailure = { stage: "rebuild", reason };
              }
            }
          }
        }

        const startedAt = performance.now();
        let payload: any = null;
        let timedOut = false;
        if (!stageFailure) {
          currentStage = "query";
          currentStageSessionIndex = null;
          lastProgressAt = new Date().toISOString();
          benchmarkLog(`questionId=${entry.question_id} query start`);
          try {
            payload = await runLongMemStageWorker<any>(`LongMemEval query ${entry.question_id}`, queryTimeoutMs, {
              stage: "query",
              payload: {
                namespaceId: queryNamespaceId,
                query: entry.question,
                limit: 8
              }
            });
          } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            if (reason.includes("timed out after")) {
              timedOut = true;
              benchmarkLog(`questionId=${entry.question_id} query timed out reason=${reason}`);
            } else {
              benchmarkLog(`questionId=${entry.question_id} query failed reason=${reason}`);
            }
            stageFailure = { stage: "query", reason };
          }
        }
        const stageEnvelopeLatencyMs = Number(
          ((stageFailure && stageFailure.stage !== "query" ? performance.now() - questionStartedAt : performance.now() - startedAt)).toFixed(2)
        );
        if (stageFailure) {
          latencies.push(stageEnvelopeLatencyMs);
          results.push(
            buildStageFailureResult({
              entry,
              stage: stageFailure.stage,
              stageFailureReason: stageFailure.reason,
              latencyMs: stageEnvelopeLatencyMs,
              relationIeStage,
              relationIeSceneCount,
              relationIePromotedRows,
              relationIeRejectedRows,
              relationIeWarnings,
              relationIeCacheHits,
              relationIeCacheMisses,
              gliner2JobsSkipped,
              exactDetailFactKeyRows
            })
          );
          activeNamespaceIds.push(namespaceId);
          completedQuestions += 1;
          currentStage = null;
          currentStageSessionIndex = null;
          lastProgressAt = new Date().toISOString();
          if (completedQuestions % partialFlushEvery === 0) {
            await flushPartial();
          }
          if (performInlineCleanup && !cleanupDisabledAfterSoftFailure && activeNamespaceIds.length >= namespaceBatchSize) {
            const softFailed = await cleanupBenchmarkNamespaces(activeNamespaceIds.splice(0, activeNamespaceIds.length));
            cleanupSoftFailures += softFailed ? 1 : 0;
            if (softFailed) {
              cleanupDisabledAfterSoftFailure = true;
              activeNamespaceIds.length = 0;
            }
          }
          continue;
        }
        const evidence = timedOut ? [] : Array.isArray(payload?.duality?.evidence) ? payload.duality.evidence : [];
        const answerAssessment = timedOut ? null : payload?.meta?.answerAssessment ?? payload?.answerAssessment ?? null;
        const sourceCount = evidence.filter(
          (item: any) => typeof item?.artifactId === "string" || typeof item?.sourceUri === "string"
        ).length;
        const passed = timedOut ? false : bestEffortPass(entry.answer, payload);
        const answerSnippet = renderLongMemAnswerSnippetForTest(payload, timedOut);
        if (manifestStatus === "warm_manifest_hit") {
          answerParityMismatch =
            previousManifestPassed !== null && previousManifestPassed !== passed
              ? true
              : previousManifestAnswerSnippet !== null && previousManifestAnswerSnippet !== answerSnippet;
          staleManifestMismatch = answerParityMismatch;
        }
        const normalizedPassed = timedOut ? false : normalizedAnswerPass(entry.answer, payload);
        const sufficiency =
          !timedOut && typeof answerAssessment?.sufficiency === "string" ? (answerAssessment.sufficiency as SufficiencyGrade) : null;
        const subjectMatch =
          !timedOut && typeof answerAssessment?.subjectMatch === "string" ? (answerAssessment.subjectMatch as SubjectMatch) : null;
        const synthesisMode =
          !timedOut && typeof payload?.meta?.synthesisMode === "string" ? (payload.meta.synthesisMode as SynthesisMode) : null;
        const meta: JsonRecord | null =
          !timedOut && payload?.meta && typeof payload.meta === "object" && !Array.isArray(payload.meta)
            ? (payload.meta as JsonRecord)
            : null;
        const answerShapingTrace =
          meta?.answerShapingTrace && typeof meta.answerShapingTrace === "object" && !Array.isArray(meta.answerShapingTrace)
            ? (meta.answerShapingTrace as JsonRecord)
            : null;
        const renderContract =
          typeof answerShapingTrace?.renderContractSelected === "string" ? answerShapingTrace.renderContractSelected : null;
        const stageTimingsMs = readNumberRecord(meta?.stageTimingsMs);
        const serviceLatencyMs =
          stageTimingsMs && typeof stageTimingsMs.total === "number" && Number.isFinite(stageTimingsMs.total)
            ? Number(stageTimingsMs.total.toFixed(2))
            : stageEnvelopeLatencyMs;
        latencies.push(serviceLatencyMs);
        const queryBehavior =
          !timedOut && typeof payload?.meta?.queryModeHint === "string"
            ? payload.meta.queryModeHint
            : entry.question_type.toLowerCase().includes("time")
              ? "temporal_detail"
              : null;

        results.push({
          questionId: entry.question_id,
          questionType: entry.question_type,
          question: entry.question,
          expectedAnswer: entry.answer,
          passed,
          normalizedPassed,
          failureClass: timedOut ? "retrieval" : classifyFailure(entry, passed, sufficiency, subjectMatch, evidence.length, sourceCount),
          confidence: !timedOut && typeof payload?.duality?.confidence === "string" ? payload.duality.confidence : null,
          sufficiency,
          subjectMatch,
          synthesisMode,
          globalQueryRouted: timedOut ? false : payload?.meta?.globalQueryRouted === true,
          summaryRoutingUsed: timedOut ? false : payload?.meta?.summaryRoutingUsed === true,
          queryBehavior,
          finalClaimSource: !timedOut && typeof payload?.meta?.finalClaimSource === "string" ? payload.meta.finalClaimSource : timedOut ? "query_timeout" : null,
          retrievalMode: !timedOut && typeof payload?.meta?.retrievalMode === "string" ? payload.meta.retrievalMode : null,
          dominantStage: !timedOut && typeof payload?.meta?.dominantStage === "string" ? payload.meta.dominantStage : timedOut ? "query_timeout" : null,
          topStageMs: !timedOut && typeof meta?.topStageMs === "number" && Number.isFinite(meta.topStageMs) ? meta.topStageMs : null,
          stageTimingsMs,
          candidateCountsByStage: readNumberRecord(meta?.candidateCountsByStage),
          rowsScannedByStage: readNumberRecord(meta?.rowsScannedByStage),
          compiledLookupTried: !timedOut && typeof meta?.compiledLookupTried === "boolean" ? meta.compiledLookupTried : null,
          relationshipFastPathTried:
            !timedOut && typeof meta?.relationshipFastPathTried === "boolean" ? meta.relationshipFastPathTried : null,
          relationshipFastPathSucceeded:
            !timedOut && typeof meta?.relationshipFastPathSucceeded === "boolean" ? meta.relationshipFastPathSucceeded : null,
          sourceBoundedReadTried:
            !timedOut && typeof meta?.sourceBoundedReadTried === "boolean" ? meta.sourceBoundedReadTried : null,
          sourceBoundedReadSucceeded:
            !timedOut && typeof meta?.sourceBoundedReadSucceeded === "boolean" ? meta.sourceBoundedReadSucceeded : null,
          finalRouteFamily: !timedOut && typeof meta?.finalRouteFamily === "string" ? meta.finalRouteFamily : null,
          semanticFallbackUsed: !timedOut && typeof meta?.semanticFallbackUsed === "boolean" ? meta.semanticFallbackUsed : null,
          sqlHybridUsed: !timedOut && typeof meta?.sqlHybridUsed === "boolean" ? meta.sqlHybridUsed : null,
          typedLaneDescentTriggered:
            !timedOut && typeof meta?.typedLaneDescentTriggered === "boolean" ? meta.typedLaneDescentTriggered : null,
          plannerBackfillTriggered:
            !timedOut && typeof meta?.plannerBackfillTriggered === "boolean" ? meta.plannerBackfillTriggered : null,
          graphExpansionTriggered:
            !timedOut && typeof meta?.graphExpansionTriggered === "boolean" ? meta.graphExpansionTriggered : null,
          earlyStopReason: !timedOut && typeof meta?.earlyStopReason === "string" ? meta.earlyStopReason : null,
          supportBundleFamily: !timedOut && typeof payload?.meta?.supportBundleFamily === "string" ? payload.meta.supportBundleFamily : null,
          authoritativeSource: !timedOut && typeof payload?.meta?.authoritativeSource === "string" ? payload.meta.authoritativeSource : null,
          abstentionReason: !timedOut && typeof payload?.meta?.abstentionReason === "string" ? payload.meta.abstentionReason : timedOut ? "temporal_gap" : null,
          entityResolutionStatus:
            !timedOut && typeof payload?.meta?.entityResolutionStatus === "string" ? payload.meta.entityResolutionStatus : null,
          temporalCoverageStatus:
            !timedOut && typeof payload?.meta?.temporalCoverageStatus === "string" ? payload.meta.temporalCoverageStatus : null,
          structuredSufficiencyStatus:
            !timedOut && typeof payload?.meta?.structuredSufficiencyStatus === "string"
              ? payload.meta.structuredSufficiencyStatus
              : null,
          fallbackUsed: !timedOut && typeof payload?.meta?.fallbackUsed === "boolean" ? payload.meta.fallbackUsed : null,
          fallbackReason: !timedOut && typeof payload?.meta?.fallbackReason === "string" ? payload.meta.fallbackReason : null,
          scalarTruthTried: !timedOut && typeof payload?.meta?.scalarTruthTried === "boolean" ? payload.meta.scalarTruthTried : null,
          eventTruthTried: !timedOut && typeof payload?.meta?.eventTruthTried === "boolean" ? payload.meta.eventTruthTried : null,
          backfillBlockedReason:
            !timedOut && typeof payload?.meta?.backfillBlockedReason === "string" ? payload.meta.backfillBlockedReason : null,
          selfBindingRecoveredFrom:
            !timedOut && typeof payload?.meta?.selfBindingRecoveredFrom === "string"
              ? payload.meta.selfBindingRecoveredFrom
              : null,
          claimAdmissibilityStatus:
            !timedOut && typeof payload?.meta?.claimAdmissibilityStatus === "string"
              ? payload.meta.claimAdmissibilityStatus
              : null,
          authoritativeClaimRejectedReason:
            !timedOut && typeof payload?.meta?.authoritativeClaimRejectedReason === "string"
              ? payload.meta.authoritativeClaimRejectedReason
              : null,
          factKeyLookupUsed: !timedOut && typeof payload?.meta?.factKeyLookupUsed === "boolean" ? payload.meta.factKeyLookupUsed : null,
          factKeyHitType: !timedOut && typeof payload?.meta?.factKeyHitType === "string" ? payload.meta.factKeyHitType : null,
          factRowSource: !timedOut && typeof payload?.meta?.factRowSource === "string" ? payload.meta.factRowSource : null,
          relationIeStage,
          relationIeSceneCount,
          relationIePromotedRows,
          relationIeRejectedRows,
          relationIeWarnings,
          relationIeCacheHits,
          relationIeCacheMisses,
          gliner2JobsSkipped,
          exactDetailFactKeyRows,
          namespaceSnapshotStatus,
          namespaceSnapshotSource,
          snapshotVersionKey,
          snapshotInvalidationReason,
          manifestStatus,
          manifestDecision: deriveLongMemManifestDecision(manifestStatus),
          manifestInvalidationReasonNormalized: normalizeLongMemManifestInvalidationReason(manifestInvalidationReason),
          snapshotDecision: deriveLongMemSnapshotDecision(namespaceSnapshotStatus, snapshotInvalidationReason),
          snapshotInvalidationReasonNormalized: normalizeLongMemSnapshotInvalidationReason(snapshotInvalidationReason),
          reuseStage: deriveLongMemReuseStage(namespaceSnapshotStatus),
          parityStatus: deriveLongMemParityStatus({
            manifestDecision: deriveLongMemManifestDecision(manifestStatus),
            answerParityMismatch,
            staleManifestMismatch
          }),
          ingestManifestKey,
          manifestInvalidationReason,
          sessionsSkipped,
          sessionsIngested,
          answerParityMismatch,
          staleManifestMismatch,
          renderContract,
          benchmarkStage: "complete",
          stageFailureReason: null,
          latencyMs: serviceLatencyMs,
          stageEnvelopeLatencyMs,
          evidenceCount: evidence.length,
          sourceCount,
          answerSnippet
        });
        if (!stageFailure && !timedOut) {
          const manifestNamespaceId = queryNamespaceId !== namespaceId ? queryNamespaceId : namespaceId;
          const counts = await loadNamespaceReadModelCounts(manifestNamespaceId);
          if (counts.readModelCount > 0 || allowsArtifactOnlyLongMemReadModel(entry.question)) {
            await upsertLongMemSessionManifest({
              identity: manifestIdentity,
              namespaceId: manifestNamespaceId,
              counts,
              snapshotVersionKey,
              lastPassed: passed,
              lastAnswerSnippet: answerSnippet
            });
          }
        }

        activeNamespaceIds.push(namespaceId);
        completedQuestions += 1;
        currentStage = null;
        currentStageSessionIndex = null;
        lastProgressAt = new Date().toISOString();
        if (completedQuestions % partialFlushEvery === 0) {
          await flushPartial();
        }
        if (performInlineCleanup && !cleanupDisabledAfterSoftFailure && activeNamespaceIds.length >= namespaceBatchSize) {
          const softFailed = await cleanupBenchmarkNamespaces(activeNamespaceIds.splice(0, activeNamespaceIds.length));
          cleanupSoftFailures += softFailed ? 1 : 0;
          if (softFailed) {
            cleanupDisabledAfterSoftFailure = true;
            activeNamespaceIds.length = 0;
          }
        }
      }

      if (performInlineCleanup && !cleanupDisabledAfterSoftFailure && activeNamespaceIds.length > 0) {
        const softFailed = await cleanupBenchmarkNamespaces(activeNamespaceIds.splice(0, activeNamespaceIds.length));
        cleanupSoftFailures += softFailed ? 1 : 0;
        if (softFailed) {
          cleanupDisabledAfterSoftFailure = true;
          activeNamespaceIds.length = 0;
        }
      }

      const passRate = Number((results.filter((result) => result.passed).length / Math.max(1, results.length)).toFixed(3));
      const catalog = buildBenchmarkCatalog(
        results.map((result) => ({
          id: result.questionId,
          passed: result.passed,
          normalizedPassed: result.normalizedPassed,
          failureClass: result.failureClass,
          queryBehavior: result.queryBehavior,
          finalClaimSource: result.finalClaimSource,
          latencyMs: result.latencyMs
        }))
      );
      const warmSnapshotHits = results.filter((result) => result.namespaceSnapshotStatus?.startsWith("warm_snapshot_hit")).length;
      const warmManifestHits = results.filter((result) => result.manifestStatus === "warm_manifest_hit").length;
      const preIngestManifestHits = results.filter((result) => result.namespaceSnapshotStatus === "warm_snapshot_hit_before_ingest").length;
      const coldRebuildCount = results.filter((result) => result.namespaceSnapshotStatus === "cold_rebuild").length;
      const sessionsSkippedTotal = results.reduce((sum, result) => sum + Number(result.sessionsSkipped ?? 0), 0);
      const sessionsIngestedTotal = results.reduce((sum, result) => sum + Number(result.sessionsIngested ?? 0), 0);
      const staleManifestMismatchCount = results.filter((result) => result.staleManifestMismatch === true).length;
      const answerParityMismatchCount = results.filter((result) => result.answerParityMismatch === true).length;
      const sessionManifestInvalidationReasons = countStringValues(
        results
          .filter((result) => result.manifestStatus === "manifest_invalidated" || result.manifestInvalidationReason)
          .map((result) => result.manifestInvalidationReasonNormalized ?? result.manifestInvalidationReason)
      );
      const manifestDecisionBreakdown = countStringValues(results.map((result) => result.manifestDecision));
      const snapshotDecisionBreakdown = countStringValues(results.map((result) => result.snapshotDecision));
      const parityStatusBreakdown = countStringValues(results.map((result) => result.parityStatus));
      const fallbackDerivedSuccessCount = results.filter(
        (result) => result.passed && result.finalClaimSource === "fallback_derived"
      ).length;
      const broadFallbackAfterSufficientTypedSupportCount = results.filter(
        (result) =>
          result.passed &&
          result.finalClaimSource === "fallback_derived" &&
          (result.compiledLookupTried === true || result.sourceBoundedReadSucceeded === true)
      ).length;
      const report: LongMemEvalReport = {
        generatedAt: new Date().toISOString(),
        dataset: "longmemeval_s_cleaned",
        runtime: buildBenchmarkRuntimeMetadata({
          benchmarkMode,
          sampleControls: {
            requestedSampleCount: process.env.BRAIN_LONGMEMEVAL_SAMPLE_COUNT ?? null,
            resolvedSampleCount: sampleCount,
            totalDatasetCount: parsed.length,
            skipCleanup: !performInlineCleanup,
            cleanupStrategy: performInlineCleanup ? "inline" : "per_run_namespace_only",
            cleanupSoftFailures,
            cleanupDisabledAfterSoftFailure,
            ingestTimeoutMs,
            rebuildTimeoutMs,
            queryTimeoutMs,
            heartbeatMs,
            partialFlushEvery
          }
        }),
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
          synthesisModeBreakdown: countBy(results.map((result) => result.synthesisMode), ["recall", "reflect"])
        },
        catalog,
        productionReadiness: {
          correctness: {
            longmem50PassRate: passRate
          },
          latency: {
            longmemP50Ms: catalog.latency.p50Ms,
            longmemP95Ms: catalog.latency.p95Ms,
            longmemMaxMs: catalog.latency.maxMs
          },
          cache: {
            manifestHitRate: rate(warmManifestHits, results.length),
            sessionManifestHitRate: rate(preIngestManifestHits, results.length),
            warmSnapshotHitRate: rate(warmSnapshotHits, results.length),
            coldRebuildCount,
            manifestDecisionBreakdown,
            snapshotDecisionBreakdown,
            parityStatusBreakdown,
            staleCacheMismatchCount: staleManifestMismatchCount,
            staleManifestMismatchCount,
            sessionsSkipped: sessionsSkippedTotal,
            sessionsIngested: sessionsIngestedTotal,
            sessionManifestInvalidationReasons,
            answerParityMismatchCount,
            warmTotalRuntimeMs: Number((performance.now() - runStartedAt).toFixed(2)),
            gliner2JobsSkipped: results.reduce((sum, result) => sum + Number(result.gliner2JobsSkipped ?? 0), 0),
            assistantJobsSkipped: sessionsSkippedTotal
          },
          routePurity: {
            fallbackDerivedSuccessCount,
            broadFallbackAfterSufficientTypedSupportCount,
            directRouteSuccessCountByFamily: countStringValues(
              results.filter((result) => result.passed && result.sourceBoundedReadSucceeded === true).map((result) => result.finalRouteFamily)
            )
          }
        },
        results,
        passed:
          passRate >= 1 &&
          catalog.latency.p95Ms <= 5000 &&
          catalog.latency.maxMs <= 6000 &&
          coldRebuildCount <= 0 &&
          staleManifestMismatchCount === 0 &&
          answerParityMismatchCount === 0 &&
          broadFallbackAfterSufficientTypedSupportCount === 0
      };

      const stamp = report.generatedAt.replace(/[:.]/g, "-");
      await mkdir(outputDir(), { recursive: true });
      const jsonPath = path.join(outputDir(), `longmemeval-${stamp}.json`);
      const markdownPath = path.join(outputDir(), `longmemeval-${stamp}.md`);
      await writeFile(jsonPath, JSON.stringify(report, null, 2), "utf8");
      await writeFile(markdownPath, toMarkdown(report), "utf8");
      return { report, output: { jsonPath, markdownPath } };
    } catch (error) {
      const failureReason = error instanceof Error ? error.message : String(error);
      await flushPartial(failureReason);
      throw error;
    } finally {
      clearInterval(heartbeat);
      process.off("SIGINT", signalHandler);
      process.off("SIGTERM", signalHandler);
    }
  });
}

export async function runLongMemEvalBenchmarkCli(): Promise<void> {
  const { output } = await runAndWriteLongMemEvalBenchmark();
  process.stdout.write(`${output.jsonPath}\n${output.markdownPath}\n`);
}
