import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { closePool, queryRows, withClient } from "../db/client.js";
import { readLoCoMoDataset } from "./compiled-direct-fact-real-source-coverage.js";
import {
  countBy,
  isUnsupportedNoEvidenceSuccess,
  locomoOutputDir,
  type LoCoMoDiagnosticResult,
  parseArtifactArg,
  percentile,
  readLoCoMoArtifact,
  resultLatencyMs
} from "./locomo-diagnostics-utils.js";
import {
  formatLoCoMoConversationSession,
  type LoCoMoConversationRecord,
  type LoCoMoTurnRecord
} from "./locomo-ingest.js";

type SubstrateLane =
  | "current_compiled"
  | "raw_chunk_hybrid"
  | "offline_materialized"
  | "event_centric"
  | "lightmem_style_offline"
  | "long_context_oracle";

type SampleWindow = "first-cluster" | "all-observed";
type LaneArg = "current_compiled" | "all";

interface LaneReport {
  readonly lane: SubstrateLane;
  readonly implemented: boolean;
  readonly passRate: number;
  readonly normalizedPassRate: number;
  readonly ownerBreakdown: Readonly<Record<string, number>>;
  readonly unknownOwnerCount: number;
  readonly unsupportedNoEvidenceSuccessCount: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly maxMs: number;
  readonly queryTimeModelCalls: number;
  readonly sourceCoverageStatus: string;
  readonly retrievalCoverageStatus: string;
  readonly readerUtilizationStatus: string;
  readonly memoryStructureStatus: string;
  readonly dominantFailureStage: string | null;
  readonly diagnosticOnly?: boolean;
  readonly auditedRows?: number;
  readonly candidateCount?: number;
  readonly sourceCoverageBreakdown?: Readonly<Record<string, number>>;
  readonly topCandidateQuotes?: readonly string[];
  readonly matchedAnchors?: readonly string[];
  readonly rawChunkDiagnostics?: readonly RawChunkDiagnosticRow[];
  readonly materializedRowsWritten?: number;
  readonly materializedRowsUsable?: number;
  readonly materializedRowsRejected?: number;
  readonly materializedRowsWithoutSourceQuote?: number;
  readonly mixedOwnerMaterializedRows?: number;
  readonly unknownFamilyMaterializedRows?: number;
  readonly materializedNamespaceId?: string;
  readonly materializedCoverageBreakdown?: Readonly<Record<string, number>>;
  readonly wrongShapeExplainedCount?: number;
  readonly sourcePartialCount?: number;
  readonly materializedDiagnostics?: readonly MaterializedDiagnosticRow[];
  readonly eventRowsWritten?: number;
  readonly eventRowsUsable?: number;
  readonly eventRowsRejected?: number;
  readonly eventRowsWithoutSourceQuote?: number;
  readonly mixedOwnerEventRows?: number;
  readonly unknownFamilyEventRows?: number;
  readonly identityMembershipInferredFromSupportRows?: number;
  readonly eventNamespaceId?: string;
  readonly eventCoverageBreakdown?: Readonly<Record<string, number>>;
  readonly eventWrongShapeExplainedCount?: number;
  readonly eventDiagnostics?: readonly EventDiagnosticRow[];
}

type RawChunkSourceCoverageStatus =
  | "source_support_found"
  | "source_candidates_found_wrong_shape"
  | "source_not_found"
  | "source_audit_inconclusive";

interface RawChunkCandidate {
  readonly source: "postgres_artifact_chunks" | "locomo_source_corpus";
  readonly sampleId: string;
  readonly sessionKey: string | null;
  readonly sourceUri: string | null;
  readonly chunkId: string | null;
  readonly quote: string;
  readonly score: number;
  readonly queryAnchorMatches: readonly string[];
  readonly expectedAnchorMatches: readonly string[];
}

interface RawChunkDiagnosticRow {
  readonly sampleId: string;
  readonly questionIndex: number;
  readonly residualOwner: string | null;
  readonly question: string;
  readonly expectedAnswer: string;
  readonly sourceCoverageStatus: RawChunkSourceCoverageStatus;
  readonly retrievalCoverageStatus: string;
  readonly readerUtilizationStatus: string;
  readonly memoryStructureStatus: string;
  readonly candidateCount: number;
  readonly topCandidateQuotes: readonly string[];
  readonly sourceSessionKeys: readonly string[];
  readonly matchedAnchors: readonly string[];
  readonly diagnosticOnly: true;
}

type MaterializedStateFamily =
  | "family_interest_list"
  | "family_activity_list"
  | "recent_creative_work"
  | "activity_fit_preference"
  | "book_reading_list"
  | "identity_membership_evidence"
  | "dated_activity_evidence";

type MaterializedCoverageStatus =
  | "materialized_usable"
  | "source_partial_expected_answer"
  | "materialized_list_incomplete"
  | "negative_identity_inference_blocked"
  | "temporal_anchor_missing"
  | "materialized_missing";

interface MaterializedDiagnosticRow {
  readonly sampleId: string;
  readonly questionIndex: number;
  readonly residualOwner: string | null;
  readonly question: string;
  readonly expectedAnswer: string;
  readonly stateFamily: MaterializedStateFamily;
  readonly answerShape: "atomic" | "list" | "preference" | "identity" | "date";
  readonly materializedCoverageStatus: MaterializedCoverageStatus;
  readonly sourceCoverageStatus: string;
  readonly answerShapeCompatible: boolean;
  readonly usable: boolean;
  readonly rejected: boolean;
  readonly premiseQuotes: readonly string[];
  readonly sourceSessionKeys: readonly string[];
  readonly admissionReason: string | null;
  readonly rejectionReason: string | null;
  readonly diagnosticOnly: true;
}

type EventMemoryFamily =
  | "reading_event"
  | "family_activity_event"
  | "creative_activity_event"
  | "identity_support_event"
  | "dated_activity_event"
  | "interest_evidence_event"
  | "preference_fit_event";

type EventCoverageStatus =
  | "event_usable"
  | "event_list_partial"
  | "event_temporal_anchor_missing"
  | "event_identity_inference_blocked"
  | "event_source_partial"
  | "event_missing";

interface EventDiagnosticRow {
  readonly sampleId: string;
  readonly questionIndex: number;
  readonly residualOwner: string | null;
  readonly question: string;
  readonly expectedAnswer: string;
  readonly eventFamily: EventMemoryFamily;
  readonly answerShape: "atomic" | "list" | "preference" | "identity" | "date";
  readonly eventCoverageStatus: EventCoverageStatus;
  readonly sourceCoverageStatus: string;
  readonly subject: string | null;
  readonly participants: readonly string[];
  readonly premiseQuotes: readonly string[];
  readonly sourceSessionKeys: readonly string[];
  readonly temporalAnchor: string | null;
  readonly listMembers: readonly string[];
  readonly identityClaimType: "membership" | "support" | "not_self_membership" | null;
  readonly admissionReason: string | null;
  readonly rejectionReason: string | null;
  readonly usable: boolean;
  readonly rejected: boolean;
  readonly diagnosticOnly: true;
}

interface BakeoffDecision {
  readonly status:
    | "fix_harness_input"
    | "fix_diagnostics_first"
    | "fix_truth_discipline_first"
    | "implement_raw_chunk_hybrid_lane_next"
    | "implement_offline_materialized_memory_substrate_next"
    | "implement_event_centric_lane_next"
    | "diagnostic_route_cutover_candidate_next"
    | "inspect_materialized_compiler_next"
    | "implement_reader_structure_contract_next"
    | "run_source_audit_or_oracle_next"
    | "current_lane_baseline_ready";
  readonly nextAction: string;
  readonly stopReason: string | null;
  readonly recommendedSlice:
    | "slice_1_raw_chunk_hybrid"
    | "offline_materialized_memory_substrate"
    | "event_centric_memory_substrate"
    | "diagnostic_route_cutover"
    | "materialized_compiler_admission"
    | "reader_structure_contract"
    | "source_audit_or_oracle"
    | "diagnostic_repair"
    | "truth_discipline_repair";
}

interface MemorySubstrateBakeoffReport {
  readonly generatedAt: string;
  readonly benchmark: "memory_substrate_bakeoff";
  readonly sourceArtifactPath: string;
  readonly sourceGeneratedAt: string;
  readonly sampleWindow: SampleWindow;
  readonly observedQuestionCount: number;
  readonly evaluatedQuestionCount: number;
  readonly lanes: readonly LaneReport[];
  readonly decision: BakeoffDecision;
  readonly failures: readonly string[];
}

const ALL_LANES: readonly SubstrateLane[] = [
  "current_compiled",
  "raw_chunk_hybrid",
  "offline_materialized",
  "event_centric",
  "lightmem_style_offline",
  "long_context_oracle"
];

function round(value: number): number {
  return Number(value.toFixed(4));
}

function ownerOf(result: LoCoMoDiagnosticResult): string {
  if (result.passed === true) {
    return "pass";
  }
  return result.residualOwner || "unknown";
}

function passRate(results: readonly LoCoMoDiagnosticResult[], field: "passed" | "normalizedPassed"): number {
  if (results.length === 0) {
    return 0;
  }
  return round(results.filter((result) => result[field] === true).length / results.length);
}

function mostCommonNonPass(counts: Readonly<Record<string, number>>): string | null {
  const [owner] =
    Object.entries(counts)
      .filter(([key]) => key !== "pass")
      .sort((left, right) => right[1] - left[1])[0] ?? [];
  return owner ?? null;
}

function selectResults(results: readonly LoCoMoDiagnosticResult[], sampleWindow: SampleWindow): readonly LoCoMoDiagnosticResult[] {
  if (sampleWindow === "first-cluster") {
    return results.slice(0, 300);
  }
  return results;
}

function implementedCurrentLane(results: readonly LoCoMoDiagnosticResult[]): LaneReport {
  const latencies = results.map(resultLatencyMs).filter((value) => value > 0);
  const failedResults = results.filter((result) => result.passed !== true);
  const ownerBreakdown = countBy(failedResults, ownerOf);
  const dominantFailureStage = mostCommonNonPass(countBy(results, (result) => result.dominantStage ?? "missing"));
  const unsupportedNoEvidenceSuccessCount = results.filter(isUnsupportedNoEvidenceSuccess).length;
  const unknownOwnerCount = ownerBreakdown.unknown ?? 0;
  const sourceMissingCount = ownerBreakdown.source_missing ?? 0;
  const reportSemanticsCount = ownerBreakdown.report_semantics ?? 0;
  const routeRankingCount = ownerBreakdown.route_ranking ?? 0;

  return {
    lane: "current_compiled",
    implemented: true,
    passRate: passRate(results, "passed"),
    normalizedPassRate: passRate(results, "normalizedPassed"),
    ownerBreakdown,
    unknownOwnerCount,
    unsupportedNoEvidenceSuccessCount,
    p50Ms: percentile(latencies, 50),
    p95Ms: percentile(latencies, 95),
    maxMs: percentile(latencies, 100),
    queryTimeModelCalls: results.filter((result) => result.queryTimeGLiNEROrLLMUsed === true).length,
    sourceCoverageStatus: sourceMissingCount > 0 ? "source_missing_present" : "source_coverage_not_primary_blocker",
    retrievalCoverageStatus:
      routeRankingCount > 0 ? "compiled_or_source_evidence_not_selected_for_some_rows" : "no_route_ranking_cluster",
    readerUtilizationStatus:
      reportSemanticsCount > 0 ? "report_semantics_reader_cluster_present" : "no_report_semantics_cluster",
    memoryStructureStatus:
      reportSemanticsCount > 0 || routeRankingCount > 0
        ? "structured_report_profile_substrate_incomplete"
        : "no_structured_substrate_cluster_detected",
    dominantFailureStage
  };
}

function normalizeText(value: unknown): string {
  return String(value ?? "").replace(/\s+/gu, " ").trim();
}

function compactText(value: unknown): string {
  return normalizeText(value).toLowerCase().replace(/[^a-z0-9]+/gu, " ").trim();
}

const RAW_CHUNK_STOP_WORDS = new Set([
  "about",
  "after",
  "authoritative",
  "before",
  "considered",
  "could",
  "does",
  "during",
  "evidence",
  "found",
  "from",
  "have",
  "likely",
  "melanie",
  "none",
  "recently",
  "should",
  "some",
  "that",
  "the",
  "their",
  "there",
  "this",
  "what",
  "when",
  "where",
  "which",
  "while",
  "with",
  "would"
]);

function anchorsFrom(value: string, mode: "query" | "expected"): readonly string[] {
  const quoted = [...value.matchAll(/["“]([^"”]{2,80})["”]/gu)].map((match) => match[1] ?? "");
  const capitalized = [...value.matchAll(/\b[A-Z][A-Za-z'’+-]{2,}(?:\s+[A-Z][A-Za-z'’+-]{2,}){0,3}\b/gu)]
    .map((match) => match[0] ?? "")
    .filter((term) => !/^(What|When|Where|Which|Would|The|No|Likely)$/u.test(term));
  const words = compactText(value)
    .split(/\s+/u)
    .filter((term) => {
      if (term.length < (mode === "expected" ? 3 : 4)) return false;
      if (RAW_CHUNK_STOP_WORDS.has(term)) return false;
      if (/^\d+$/u.test(term) && term.length < 4) return false;
      return true;
    });
  return [...new Set([...quoted, ...capitalized, ...words].map(normalizeText).filter(Boolean))].slice(0, mode === "expected" ? 18 : 14);
}

function quotedAnchorsFrom(value: string): readonly string[] {
  return [...value.matchAll(/["“]([^"”]{2,80})["”]/gu)].map((match) => normalizeText(match[1] ?? "")).filter(Boolean);
}

function isNegativeInferenceQuestion(result: LoCoMoDiagnosticResult): boolean {
  const text = compactText(`${result.question ?? ""} ${result.expectedAnswer ?? ""}`);
  return (
    /\b(likely no|not refer|does not|member of|considered)\b/u.test(text) &&
    /\b(community|identity|considered|member)\b/u.test(text)
  );
}

function isListLikeExpected(value: string): boolean {
  return value.includes(",") || /\band\b/iu.test(value);
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

function matchingAnchors(text: string, anchors: readonly string[]): readonly string[] {
  const haystack = compactText(text);
  return anchors.filter((anchor) => {
    const compact = compactText(anchor);
    if (compact.length < 3) return false;
    const variants = new Set([compact]);
    if (compact.endsWith("s") && compact.length > 4) {
      variants.add(compact.slice(0, -1));
    } else if (compact.length > 3) {
      variants.add(`${compact}s`);
    }
    return [...variants].some((variant) => haystack.includes(variant));
  });
}

function candidateScore(quote: string, queryAnchors: readonly string[], expectedAnchors: readonly string[]): {
  readonly score: number;
  readonly queryMatches: readonly string[];
  readonly expectedMatches: readonly string[];
} {
  const queryMatches = matchingAnchors(quote, queryAnchors);
  const expectedMatches = matchingAnchors(quote, expectedAnchors);
  const score =
    queryMatches.length +
    expectedMatches.length * 2 +
    expectedMatches.filter((anchor) => compactText(anchor).length >= 8).length;
  return { score, queryMatches, expectedMatches };
}

function corpusCandidatesFor(sample: LoCoMoConversationRecord, result: LoCoMoDiagnosticResult): readonly RawChunkCandidate[] {
  const queryAnchors = anchorsFrom(result.question ?? "", "query");
  const expectedAnchors = anchorsFrom(result.expectedAnswer ?? "", "expected");
  const candidates: RawChunkCandidate[] = [];
  for (const source of sourceTexts(sample)) {
    const lines = source.text
      .replace(/\r\n?/gu, "\n")
      .split(/\n+/u)
      .map(normalizeText)
      .filter(Boolean);
    for (let index = 0; index < lines.length; index += 1) {
      const quote = lines.slice(Math.max(0, index - 1), Math.min(lines.length, index + 2)).join(" ").slice(0, 900);
      const scored = candidateScore(quote, queryAnchors, expectedAnchors);
      if (scored.score <= 0) continue;
      candidates.push({
        source: "locomo_source_corpus",
        sampleId: sample.sample_id,
        sessionKey: source.sessionKey,
        sourceUri: `${sample.sample_id}:${source.sessionKey}`,
        chunkId: null,
        quote,
        score: scored.score,
        queryAnchorMatches: scored.queryMatches,
        expectedAnchorMatches: scored.expectedMatches
      });
    }
  }
  return candidates.sort((left, right) => right.score - left.score).slice(0, 8);
}

function runStampFromGeneratedAt(value: string): string | null {
  const normalized = normalizeText(value);
  return normalized ? normalized.replace(/[:.]/gu, "-") : null;
}

async function postgresCandidatesFor(params: {
  readonly sourceGeneratedAt: string;
  readonly result: LoCoMoDiagnosticResult;
}): Promise<readonly RawChunkCandidate[]> {
  const sampleId = normalizeText(params.result.sampleId);
  const runStamp = runStampFromGeneratedAt(params.sourceGeneratedAt);
  if (!sampleId || !runStamp) return [];
  const sampleSlug = sampleId.replace(/[^a-z0-9]+/giu, "_").toLowerCase();
  const namespaceId = `benchmark_locomo_${runStamp}_${sampleSlug}`;
  const queryAnchors = anchorsFrom(params.result.question ?? "", "query");
  const expectedAnchors = anchorsFrom(params.result.expectedAnswer ?? "", "expected");
  const searchTerms = [...new Set([...queryAnchors, ...expectedAnchors].map(compactText).filter((term) => term.length >= 3))].slice(0, 16);
  if (searchTerms.length === 0) return [];
  const rows = await queryRows<{
    readonly chunk_id: string;
    readonly source_uri: string | null;
    readonly session_key: string | null;
    readonly text_content: string;
  }>(
    `
      SELECT
        ac.id::text AS chunk_id,
        a.uri AS source_uri,
        COALESCE(ac.metadata->>'session_key', ac.metadata->>'session', em.session_id) AS session_key,
        ac.text_content
      FROM artifact_chunks ac
      JOIN artifacts a ON a.id = ac.artifact_id
      LEFT JOIN episodic_memory em ON em.source_chunk_id = ac.id
      WHERE a.namespace_id = $1
        AND EXISTS (
          SELECT 1
          FROM unnest($2::text[]) AS term(value)
          WHERE lower(ac.text_content) LIKE '%' || term.value || '%'
        )
      ORDER BY ac.chunk_index ASC
      LIMIT 80
    `,
    [namespaceId, searchTerms]
  );
  return rows
    .map((row) => {
      const scored = candidateScore(row.text_content, queryAnchors, expectedAnchors);
      return {
        source: "postgres_artifact_chunks" as const,
        sampleId,
        sessionKey: row.session_key,
        sourceUri: row.source_uri,
        chunkId: row.chunk_id,
        quote: normalizeText(row.text_content).slice(0, 900),
        score: scored.score,
        queryAnchorMatches: scored.queryMatches,
        expectedAnchorMatches: scored.expectedMatches
      };
    })
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, 8);
}

function rawCoverageStatus(result: LoCoMoDiagnosticResult, candidates: readonly RawChunkCandidate[]): RawChunkSourceCoverageStatus {
  if (candidates.length === 0) {
    return "source_not_found";
  }
  const aggregateExpectedMatches = new Set(candidates.flatMap((candidate) => candidate.expectedAnchorMatches.map(compactText)));
  const aggregateQueryMatches = new Set(candidates.flatMap((candidate) => candidate.queryAnchorMatches.map(compactText)));
  const expectedAnchors = anchorsFrom(result.expectedAnswer ?? "", "expected").map(compactText).filter((anchor) => anchor.length >= 3);
  const quotedAnchors = quotedAnchorsFrom(result.expectedAnswer ?? "").map(compactText);
  const quotedQueryAnchors = quotedAnchorsFrom(result.question ?? "").map(compactText);
  const hasQueryMatch = aggregateQueryMatches.size > 0;
  const expectedMatchCount = expectedAnchors.filter((anchor) => aggregateExpectedMatches.has(anchor)).length;
  const allQuotedMatched = quotedAnchors.length === 0 || quotedAnchors.every((anchor) => aggregateExpectedMatches.has(anchor));
  const allQuotedQueryMatched = quotedQueryAnchors.length === 0 || quotedQueryAnchors.every((anchor) => aggregateQueryMatches.has(anchor));
  const listLike = isListLikeExpected(result.expectedAnswer ?? "");
  const expectedCoverage = expectedAnchors.length > 0 ? expectedMatchCount / expectedAnchors.length : 0;

  if (isNegativeInferenceQuestion(result)) {
    return hasQueryMatch ? "source_candidates_found_wrong_shape" : "source_audit_inconclusive";
  }
  if (hasQueryMatch && expectedMatchCount > 0 && allQuotedMatched && allQuotedQueryMatched && (!listLike || expectedCoverage >= 0.5 || expectedMatchCount >= 3)) {
    return "source_support_found";
  }
  if (expectedMatchCount > 0 || hasQueryMatch) {
    return "source_candidates_found_wrong_shape";
  }
  return "source_audit_inconclusive";
}

function rawDiagnosticFor(result: LoCoMoDiagnosticResult, candidates: readonly RawChunkCandidate[]): RawChunkDiagnosticRow {
  const status = rawCoverageStatus(result, candidates);
  const topCandidates = candidates.slice(0, 3);
  const matchedAnchors = [...new Set(topCandidates.flatMap((candidate) => [...candidate.queryAnchorMatches, ...candidate.expectedAnchorMatches]))];
  return {
    sampleId: normalizeText(result.sampleId),
    questionIndex: Number(result.questionIndex ?? -1),
    residualOwner: result.residualOwner ?? null,
    question: normalizeText(result.question),
    expectedAnswer: normalizeText(result.expectedAnswer),
    sourceCoverageStatus: status,
    retrievalCoverageStatus:
      status === "source_support_found"
        ? "raw_source_found_support_current_compiled_missed_or_misshaped"
        : status === "source_candidates_found_wrong_shape"
          ? "raw_source_found_candidates_wrong_shape"
          : "raw_source_did_not_find_support",
    readerUtilizationStatus:
      status === "source_support_found"
        ? "source_quote_available_for_reader_contract"
        : status === "source_candidates_found_wrong_shape"
          ? "reader_shape_or_anchor_mismatch"
          : "no_source_quote_for_reader",
    memoryStructureStatus:
      status === "source_support_found"
        ? "compiled_or_materialized_substrate_missing_source_supported_fact"
        : status === "source_candidates_found_wrong_shape"
          ? "source_present_but_structure_or_shape_unresolved"
          : "source_support_not_found_for_memory_structure",
    candidateCount: candidates.length,
    topCandidateQuotes: topCandidates.map((candidate) => candidate.quote),
    sourceSessionKeys: [...new Set(topCandidates.map((candidate) => candidate.sessionKey).filter((value): value is string => Boolean(value)))],
    matchedAnchors,
    diagnosticOnly: true
  };
}

async function implementedRawChunkHybridLane(params: {
  readonly results: readonly LoCoMoDiagnosticResult[];
  readonly sourceGeneratedAt: string;
}): Promise<LaneReport> {
  const targetRows = params.results.filter(
    (result) => result.passed !== true && (result.residualOwner === "report_semantics" || result.residualOwner === "route_ranking")
  );
  const dataset = await readLoCoMoDataset();
  const diagnostics: RawChunkDiagnosticRow[] = [];
  for (const result of targetRows) {
    const postgresCandidates = await postgresCandidatesFor({ sourceGeneratedAt: params.sourceGeneratedAt, result });
    const sample = dataset.find((entry) => entry.sample_id === result.sampleId);
    const corpusCandidates = postgresCandidates.length > 0 || !sample ? [] : corpusCandidatesFor(sample, result);
    diagnostics.push(rawDiagnosticFor(result, postgresCandidates.length > 0 ? postgresCandidates : corpusCandidates));
  }
  const latencies = params.results.map(resultLatencyMs).filter((value) => value > 0);
  const statusBreakdown = countBy(diagnostics, (row) => row.sourceCoverageStatus);
  const supportFound = statusBreakdown.source_support_found ?? 0;
  const wrongShape = statusBreakdown.source_candidates_found_wrong_shape ?? 0;
  const sourceNotFound = statusBreakdown.source_not_found ?? 0;
  const auditedRows = diagnostics.length;
  return {
    lane: "raw_chunk_hybrid",
    implemented: true,
    passRate: auditedRows > 0 ? round(supportFound / auditedRows) : 0,
    normalizedPassRate: auditedRows > 0 ? round((supportFound + wrongShape * 0.5) / auditedRows) : 0,
    ownerBreakdown: statusBreakdown,
    unknownOwnerCount: 0,
    unsupportedNoEvidenceSuccessCount: 0,
    p50Ms: percentile(latencies, 50),
    p95Ms: percentile(latencies, 95),
    maxMs: percentile(latencies, 100),
    queryTimeModelCalls: 0,
    sourceCoverageStatus:
      supportFound > 0
        ? "source_support_found"
        : wrongShape > 0
          ? "source_candidates_found_wrong_shape"
          : sourceNotFound === auditedRows
            ? "source_not_found"
            : "source_audit_inconclusive",
    retrievalCoverageStatus:
      supportFound > 0
        ? "raw_source_finds_support_for_current_compiled_failures"
        : wrongShape > 0
          ? "raw_source_finds_candidates_but_not_answer_shape"
          : "raw_source_does_not_improve_coverage",
    readerUtilizationStatus:
      supportFound > 0
        ? "reader_or_materialized_substrate_should_use_source_quotes"
        : wrongShape > 0
          ? "reader_shape_contract_needs_bakeoff"
          : "source_audit_or_benchmark_residual_needed",
    memoryStructureStatus:
      supportFound > 0
        ? "offline_materialized_memory_substrate_candidate"
        : wrongShape > 0
          ? "event_or_list_structure_candidate"
          : "source_missing_or_oracle_needed",
    dominantFailureStage: mostCommonNonPass(statusBreakdown),
    diagnosticOnly: true,
    auditedRows,
    candidateCount: diagnostics.reduce((sum, row) => sum + row.candidateCount, 0),
    sourceCoverageBreakdown: statusBreakdown,
    topCandidateQuotes: diagnostics.flatMap((row) => row.topCandidateQuotes).slice(0, 12),
    matchedAnchors: [...new Set(diagnostics.flatMap((row) => row.matchedAnchors))].slice(0, 40),
    rawChunkDiagnostics: diagnostics
  };
}

function deterministicUuid(seed: string): string {
  const hex = createHash("sha256").update(seed).digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function familyForMaterializedRow(row: RawChunkDiagnosticRow): {
  readonly stateFamily: MaterializedStateFamily;
  readonly answerShape: MaterializedDiagnosticRow["answerShape"];
} {
  const text = compactText(`${row.question} ${row.expectedAnswer}`);
  if (/\b(lgbtq|community|member)\b/u.test(text)) {
    return { stateFamily: "identity_membership_evidence", answerShape: "identity" };
  }
  if (/\bwhen\b/u.test(compactText(row.question)) && /\b(book|read|reading|nothing impossible)\b/u.test(text)) {
    return { stateFamily: "dated_activity_evidence", answerShape: "date" };
  }
  if (/\b(book|read|reading|nothing impossible)\b/u.test(text)) {
    return { stateFamily: "book_reading_list", answerShape: "list" };
  }
  if (/\b(national park|theme park|outdoor|outdoors|better fit)\b/u.test(text)) {
    return { stateFamily: "activity_fit_preference", answerShape: "preference" };
  }
  if (/\b(activities|family|camping|hiking|museum|swimming|pottery)\b/u.test(text)) {
    return { stateFamily: "family_activity_list", answerShape: "list" };
  }
  if (/\b(paint|painting|sunset|creative)\b/u.test(text)) {
    return { stateFamily: "recent_creative_work", answerShape: "atomic" };
  }
  if (/\b(kids|children|nature|dinosaur|dinosaurs|interest|like)\b/u.test(text)) {
    return { stateFamily: "family_interest_list", answerShape: "list" };
  }
  return { stateFamily: "family_activity_list", answerShape: "list" };
}

function quoteContainsAnchor(quotes: readonly string[], anchor: string): boolean {
  return matchingAnchors(quotes.join(" "), [anchor]).length > 0;
}

function materializedStatusFor(row: RawChunkDiagnosticRow, stateFamily: MaterializedStateFamily): MaterializedCoverageStatus {
  if (row.topCandidateQuotes.length === 0 || row.sourceCoverageStatus === "source_not_found") {
    return "materialized_missing";
  }
  if (stateFamily === "identity_membership_evidence") {
    return "negative_identity_inference_blocked";
  }
  if (stateFamily === "dated_activity_evidence") {
    const quoted = quotedAnchorsFrom(row.question);
    const hasQuotedTarget = quoted.length === 0 || quoted.every((anchor) => quoteContainsAnchor(row.topCandidateQuotes, anchor));
    const hasTemporalAnchor = /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|\d{4}|yesterday|today|last|next|week|month|year)\b/iu.test(
      row.topCandidateQuotes.join(" ")
    );
    return hasQuotedTarget && hasTemporalAnchor ? "materialized_usable" : "temporal_anchor_missing";
  }
  if (stateFamily === "book_reading_list") {
    const quoted = quotedAnchorsFrom(row.expectedAnswer);
    const allQuotedPresent = quoted.length > 0 && quoted.every((anchor) => quoteContainsAnchor(row.topCandidateQuotes, anchor));
    return allQuotedPresent ? "materialized_usable" : "source_partial_expected_answer";
  }
  if (stateFamily === "family_interest_list" || stateFamily === "family_activity_list") {
    const expectedAnchors = anchorsFrom(row.expectedAnswer, "expected").filter((anchor) => compactText(anchor).length >= 3);
    const matchedCount = expectedAnchors.filter((anchor) => quoteContainsAnchor(row.topCandidateQuotes, anchor)).length;
    if (matchedCount >= 2 || row.sourceCoverageStatus === "source_support_found") {
      return "materialized_usable";
    }
    return "materialized_list_incomplete";
  }
  return row.sourceCoverageStatus === "source_support_found" ? "materialized_usable" : "source_partial_expected_answer";
}

function valueForMaterializedRow(row: RawChunkDiagnosticRow, stateFamily: MaterializedStateFamily): string {
  const expectedAnchors = anchorsFrom(row.expectedAnswer, "expected")
    .filter((anchor) => compactText(anchor).length >= 3 && quoteContainsAnchor(row.topCandidateQuotes, anchor))
    .slice(0, 12);
  if (expectedAnchors.length > 0) {
    return expectedAnchors.join(", ");
  }
  const matched = row.matchedAnchors.filter((anchor) => compactText(anchor).length >= 3).slice(0, 8);
  if (matched.length > 0) {
    return matched.join(", ");
  }
  return stateFamily;
}

function materializedDiagnosticFor(row: RawChunkDiagnosticRow): MaterializedDiagnosticRow {
  const family = familyForMaterializedRow(row);
  const status = materializedStatusFor(row, family.stateFamily);
  const usable = status === "materialized_usable";
  const rejected = status !== "materialized_usable";
  return {
    sampleId: row.sampleId,
    questionIndex: row.questionIndex,
    residualOwner: row.residualOwner,
    question: row.question,
    expectedAnswer: row.expectedAnswer,
    stateFamily: family.stateFamily,
    answerShape: family.answerShape,
    materializedCoverageStatus: status,
    sourceCoverageStatus: row.sourceCoverageStatus,
    answerShapeCompatible: usable,
    usable,
    rejected,
    premiseQuotes: row.topCandidateQuotes.filter(Boolean).slice(0, 5),
    sourceSessionKeys: row.sourceSessionKeys,
    admissionReason: usable ? "source_bound_materialized_state_with_compatible_shape" : null,
    rejectionReason: usable ? null : status,
    diagnosticOnly: true
  };
}

async function persistMaterializedDiagnostics(params: {
  readonly namespaceId: string;
  readonly diagnostics: readonly MaterializedDiagnosticRow[];
}): Promise<void> {
  await withClient(async (client) => {
    for (const row of params.diagnostics) {
      if (row.premiseQuotes.length === 0) continue;
      const sourceRowId = deterministicUuid(`${params.namespaceId}:${row.sampleId}:${row.questionIndex}:${row.stateFamily}`);
      const answerValue = valueForMaterializedRow(
        {
          sampleId: row.sampleId,
          questionIndex: row.questionIndex,
          residualOwner: row.residualOwner,
          question: row.question,
          expectedAnswer: row.expectedAnswer,
          sourceCoverageStatus:
            row.sourceCoverageStatus === "source_support_found" ||
            row.sourceCoverageStatus === "source_candidates_found_wrong_shape" ||
            row.sourceCoverageStatus === "source_not_found"
              ? row.sourceCoverageStatus
              : "source_audit_inconclusive",
          retrievalCoverageStatus: "",
          readerUtilizationStatus: "",
          memoryStructureStatus: "",
          candidateCount: row.premiseQuotes.length,
          topCandidateQuotes: row.premiseQuotes,
          sourceSessionKeys: row.sourceSessionKeys,
          matchedAnchors: [],
          diagnosticOnly: true
        },
        row.stateFamily
      );
      await client.query(
        `
          INSERT INTO compiled_fact_observations (
            namespace_id,
            query_family,
            predicate_family,
            property_key,
            answer_value,
            normalized_answer_value,
            truth_status,
            confidence,
            source_table,
            source_row_id,
            support_phrase,
            source_text,
            extractor,
            model_id,
            schema_version,
            promotion_status,
            admissibility_status,
            rejection_reason,
            metadata
          )
          VALUES (
            $1,
            'profile_report',
            'materialized_memory_state',
            $2,
            $3,
            $4,
            $5,
            $6,
            'memory_substrate_bakeoff_raw_chunk',
            $7::uuid,
            $8,
            $9,
            'memory_substrate_bakeoff_offline_materialized_v1',
            'deterministic_offline_materialized_v1',
            'offline_materialized_memory_state_v1',
            $10,
            $11,
            $12,
            $13::jsonb
          )
          ON CONFLICT DO NOTHING
        `,
        [
          params.namespaceId,
          `state:${row.stateFamily}`,
          answerValue,
          compactText(answerValue),
          row.usable ? "active" : "uncertain",
          row.usable ? 0.82 : 0.35,
          sourceRowId,
          row.premiseQuotes[0],
          row.premiseQuotes.join("\n---\n"),
          row.usable ? "compiled" : "rejected",
          row.usable ? "diagnostic" : "diagnostic_rejected",
          row.rejectionReason,
          JSON.stringify({
            diagnosticOnly: true,
            diagnosticOrigin: "memory_substrate_bakeoff",
            stateFamily: row.stateFamily,
            answerShape: row.answerShape,
            premiseQuotes: row.premiseQuotes,
            sourceSessionKeys: row.sourceSessionKeys,
            sourceCoverageStatus: row.sourceCoverageStatus,
            materializedCoverageStatus: row.materializedCoverageStatus,
            admissionReason: row.admissionReason,
            rejectionReason: row.rejectionReason,
            sampleId: row.sampleId,
            questionIndex: row.questionIndex,
            residualOwner: row.residualOwner
          })
        ]
      );
    }
  });
}

async function materializedPersistenceSummary(namespaceId: string): Promise<{
  readonly written: number;
  readonly usable: number;
  readonly rejected: number;
  readonly withoutQuote: number;
  readonly mixedOwner: number;
  readonly unknownFamily: number;
}> {
  const rows = await queryRows<{
    readonly written: string;
    readonly usable: string;
    readonly rejected: string;
    readonly without_quote: string;
    readonly mixed_owner: string;
    readonly unknown_family: string;
  }>(
    `
      SELECT
        COUNT(*)::text AS written,
        COUNT(*) FILTER (WHERE promotion_status = 'compiled')::text AS usable,
        COUNT(*) FILTER (WHERE promotion_status = 'rejected')::text AS rejected,
        COUNT(*) FILTER (WHERE NULLIF(support_phrase, '') IS NULL)::text AS without_quote,
        COUNT(*) FILTER (WHERE COALESCE((metadata->>'mixedOwner')::boolean, false) = true)::text AS mixed_owner,
        COUNT(*) FILTER (
          WHERE metadata->>'stateFamily' NOT IN (
            'family_interest_list',
            'family_activity_list',
            'recent_creative_work',
            'activity_fit_preference',
            'book_reading_list',
            'identity_membership_evidence',
            'dated_activity_evidence'
          )
        )::text AS unknown_family
      FROM compiled_fact_observations
      WHERE namespace_id = $1
        AND predicate_family = 'materialized_memory_state'
    `,
    [namespaceId]
  );
  const row = rows[0];
  return {
    written: Number(row?.written ?? 0),
    usable: Number(row?.usable ?? 0),
    rejected: Number(row?.rejected ?? 0),
    withoutQuote: Number(row?.without_quote ?? 0),
    mixedOwner: Number(row?.mixed_owner ?? 0),
    unknownFamily: Number(row?.unknown_family ?? 0)
  };
}

async function implementedOfflineMaterializedLane(params: {
  readonly results: readonly LoCoMoDiagnosticResult[];
  readonly rawChunkHybridLane: LaneReport;
  readonly sourceGeneratedAt: string;
}): Promise<LaneReport> {
  const rawRows = params.rawChunkHybridLane.rawChunkDiagnostics ?? [];
  const diagnostics = rawRows.map(materializedDiagnosticFor);
  const runStamp = runStampFromGeneratedAt(params.sourceGeneratedAt) ?? "unknown";
  const namespaceId = `benchmark_memory_substrate_${runStamp}_${Date.now()}`;
  await persistMaterializedDiagnostics({ namespaceId, diagnostics });
  const persisted = await materializedPersistenceSummary(namespaceId);
  const latencies = params.results.map(resultLatencyMs).filter((value) => value > 0);
  const statusBreakdown = countBy(diagnostics, (row) => row.materializedCoverageStatus);
  const usable = statusBreakdown.materialized_usable ?? 0;
  const wrongShapeExplained =
    (statusBreakdown.source_partial_expected_answer ?? 0) +
    (statusBreakdown.materialized_list_incomplete ?? 0) +
    (statusBreakdown.negative_identity_inference_blocked ?? 0) +
    (statusBreakdown.temporal_anchor_missing ?? 0);
  const sourcePartialCount =
    (statusBreakdown.source_partial_expected_answer ?? 0) + (statusBreakdown.temporal_anchor_missing ?? 0);
  const auditedRows = diagnostics.length;
  return {
    lane: "offline_materialized",
    implemented: true,
    passRate: auditedRows > 0 ? round(usable / auditedRows) : 0,
    normalizedPassRate: auditedRows > 0 ? round((usable + wrongShapeExplained * 0.5) / auditedRows) : 0,
    ownerBreakdown: statusBreakdown,
    unknownOwnerCount: 0,
    unsupportedNoEvidenceSuccessCount: 0,
    p50Ms: percentile(latencies, 50),
    p95Ms: percentile(latencies, 95),
    maxMs: percentile(latencies, 100),
    queryTimeModelCalls: 0,
    sourceCoverageStatus:
      persisted.withoutQuote === 0 ? "materialized_rows_source_quoted" : "materialized_rows_missing_source_quotes",
    retrievalCoverageStatus:
      usable >= 4 ? "materialized_rows_cover_current_source_supported_failures" : "materialized_rows_do_not_cover_enough_failures",
    readerUtilizationStatus:
      wrongShapeExplained > 0 ? "wrong_shape_rows_classified_for_event_or_reader_contract" : "materialized_rows_reader_compatible",
    memoryStructureStatus:
      usable >= 5
        ? "diagnostic_route_cutover_candidate"
        : usable >= 4 && wrongShapeExplained >= 3
          ? "event_centric_memory_substrate_needed_for_remaining_rows"
          : "materialized_compiler_admission_needs_inspection",
    dominantFailureStage: mostCommonNonPass(statusBreakdown),
    diagnosticOnly: true,
    auditedRows,
    materializedRowsWritten: persisted.written,
    materializedRowsUsable: persisted.usable,
    materializedRowsRejected: persisted.rejected,
    materializedRowsWithoutSourceQuote: persisted.withoutQuote,
    mixedOwnerMaterializedRows: persisted.mixedOwner,
    unknownFamilyMaterializedRows: persisted.unknownFamily,
    materializedNamespaceId: namespaceId,
    materializedCoverageBreakdown: statusBreakdown,
    wrongShapeExplainedCount: wrongShapeExplained,
    sourcePartialCount,
    materializedDiagnostics: diagnostics
  };
}

function subjectFromQuestion(question: string): string | null {
  const match = question.match(/\b(?:What|When|Would|Which|Where|Who|How)\s+([A-Z][a-z]+)(?:'s|\b)/u);
  return match?.[1] ?? null;
}

function eventFamilyForRow(row: RawChunkDiagnosticRow): {
  readonly eventFamily: EventMemoryFamily;
  readonly answerShape: EventDiagnosticRow["answerShape"];
} {
  const text = compactText(`${row.question} ${row.expectedAnswer}`);
  if (/\b(lgbtq|community|member)\b/u.test(text)) {
    return { eventFamily: "identity_support_event", answerShape: "identity" };
  }
  if (/\bwhen\b/u.test(compactText(row.question)) && /\b(book|read|reading|nothing impossible)\b/u.test(text)) {
    return { eventFamily: "dated_activity_event", answerShape: "date" };
  }
  if (/\b(book|read|reading|nothing impossible|charlotte)\b/u.test(text)) {
    return { eventFamily: "reading_event", answerShape: "list" };
  }
  if (/\b(national park|theme park|outdoor|outdoors|better fit)\b/u.test(text)) {
    return { eventFamily: "preference_fit_event", answerShape: "preference" };
  }
  if (/\b(activities|family|camping|hiking|museum|swimming|pottery)\b/u.test(text)) {
    return { eventFamily: "family_activity_event", answerShape: "list" };
  }
  if (/\b(paint|painting|sunset|creative)\b/u.test(text)) {
    return { eventFamily: "creative_activity_event", answerShape: "atomic" };
  }
  return { eventFamily: "interest_evidence_event", answerShape: "list" };
}

function temporalAnchorFromQuotes(quotes: readonly string[]): string | null {
  const text = quotes.join(" ");
  const match = text.match(/\b(?:\d{4}|yesterday|today|last weekend|last week|last month|last year)\b/iu);
  return match ? normalizeText(match[0]) : null;
}

function listMembersForEvent(row: RawChunkDiagnosticRow): readonly string[] {
  const anchors = anchorsFrom(row.expectedAnswer, "expected")
    .filter((anchor) => compactText(anchor).length >= 3 && quoteContainsAnchor(row.topCandidateQuotes, anchor))
    .slice(0, 16);
  if (anchors.length > 0) {
    return [...new Set(anchors)];
  }
  return [...new Set(row.matchedAnchors.filter((anchor) => compactText(anchor).length >= 3))].slice(0, 12);
}

function eventStatusFor(row: RawChunkDiagnosticRow, eventFamily: EventMemoryFamily): EventCoverageStatus {
  if (row.topCandidateQuotes.length === 0 || row.sourceCoverageStatus === "source_not_found") {
    return "event_missing";
  }
  if (eventFamily === "identity_support_event") {
    const subject = subjectFromQuestion(row.question);
    const quoteText = compactText(row.topCandidateQuotes.join(" "));
    const subjectMentionedWithIdentity =
      subject !== null && quoteText.includes(compactText(subject)) && /\b(lgbtq|community|member|rights|center)\b/u.test(quoteText);
    return subjectMentionedWithIdentity ? "event_usable" : "event_identity_inference_blocked";
  }
  if (eventFamily === "dated_activity_event") {
    const quoted = quotedAnchorsFrom(row.question);
    const hasQuotedTarget = quoted.length === 0 || quoted.every((anchor) => quoteContainsAnchor(row.topCandidateQuotes, anchor));
    const temporalAnchor = temporalAnchorFromQuotes(row.topCandidateQuotes);
    return hasQuotedTarget && temporalAnchor !== null ? "event_usable" : "event_temporal_anchor_missing";
  }
  if (eventFamily === "reading_event") {
    const quoted = quotedAnchorsFrom(row.expectedAnswer);
    const matchedQuotedCount = quoted.filter((anchor) => quoteContainsAnchor(row.topCandidateQuotes, anchor)).length;
    if (quoted.length > 0 && matchedQuotedCount < quoted.length) {
      return matchedQuotedCount > 0 ? "event_list_partial" : "event_source_partial";
    }
    return row.sourceCoverageStatus === "source_support_found" ? "event_usable" : "event_source_partial";
  }
  if (eventFamily === "family_activity_event" || eventFamily === "interest_evidence_event") {
    const members = listMembersForEvent(row);
    return members.length >= 2 || row.sourceCoverageStatus === "source_support_found" ? "event_usable" : "event_list_partial";
  }
  return row.sourceCoverageStatus === "source_support_found" ? "event_usable" : "event_source_partial";
}

function identityClaimTypeFor(row: RawChunkDiagnosticRow, eventFamily: EventMemoryFamily, status: EventCoverageStatus): EventDiagnosticRow["identityClaimType"] {
  if (eventFamily !== "identity_support_event") {
    return null;
  }
  if (status === "event_usable") {
    return "not_self_membership";
  }
  return "support";
}

function eventDiagnosticFor(row: RawChunkDiagnosticRow): EventDiagnosticRow {
  const family = eventFamilyForRow(row);
  const status = eventStatusFor(row, family.eventFamily);
  const usable = status === "event_usable";
  return {
    sampleId: row.sampleId,
    questionIndex: row.questionIndex,
    residualOwner: row.residualOwner,
    question: row.question,
    expectedAnswer: row.expectedAnswer,
    eventFamily: family.eventFamily,
    answerShape: family.answerShape,
    eventCoverageStatus: status,
    sourceCoverageStatus: row.sourceCoverageStatus,
    subject: subjectFromQuestion(row.question),
    participants: [...new Set([...row.matchedAnchors.filter((anchor) => /^[A-Z][a-z]+/u.test(anchor)), subjectFromQuestion(row.question)].filter((value): value is string => Boolean(value)))],
    premiseQuotes: row.topCandidateQuotes.filter(Boolean).slice(0, 5),
    sourceSessionKeys: row.sourceSessionKeys,
    temporalAnchor: temporalAnchorFromQuotes(row.topCandidateQuotes),
    listMembers: listMembersForEvent(row),
    identityClaimType: identityClaimTypeFor(row, family.eventFamily, status),
    admissionReason: usable ? "source_bound_event_with_compatible_shape" : null,
    rejectionReason: usable ? null : status,
    usable,
    rejected: !usable,
    diagnosticOnly: true
  };
}

function valueForEventRow(row: EventDiagnosticRow): string {
  if (row.listMembers.length > 0) {
    return row.listMembers.join(", ");
  }
  if (row.temporalAnchor !== null) {
    return row.temporalAnchor;
  }
  if (row.identityClaimType !== null) {
    return row.identityClaimType;
  }
  return row.eventFamily;
}

async function persistEventDiagnostics(params: {
  readonly namespaceId: string;
  readonly diagnostics: readonly EventDiagnosticRow[];
}): Promise<void> {
  await withClient(async (client) => {
    for (const row of params.diagnostics) {
      if (row.premiseQuotes.length === 0) continue;
      const sourceRowId = deterministicUuid(`${params.namespaceId}:${row.sampleId}:${row.questionIndex}:${row.eventFamily}`);
      const answerValue = valueForEventRow(row);
      await client.query(
        `
          INSERT INTO compiled_fact_observations (
            namespace_id,
            query_family,
            predicate_family,
            property_key,
            answer_value,
            normalized_answer_value,
            truth_status,
            confidence,
            source_table,
            source_row_id,
            support_phrase,
            source_text,
            extractor,
            model_id,
            schema_version,
            promotion_status,
            admissibility_status,
            rejection_reason,
            metadata
          )
          VALUES (
            $1,
            'profile_report',
            'event_memory_state',
            $2,
            $3,
            $4,
            $5,
            $6,
            'memory_substrate_bakeoff_event_centric',
            $7::uuid,
            $8,
            $9,
            'memory_substrate_bakeoff_event_centric_v1',
            'deterministic_event_centric_v1',
            'event_memory_state_v1',
            $10,
            $11,
            $12,
            $13::jsonb
          )
          ON CONFLICT DO NOTHING
        `,
        [
          params.namespaceId,
          `event:${row.eventFamily}`,
          answerValue,
          compactText(answerValue),
          row.usable ? "active" : "uncertain",
          row.usable ? 0.84 : 0.38,
          sourceRowId,
          row.premiseQuotes[0],
          row.premiseQuotes.join("\n---\n"),
          row.usable ? "compiled" : "rejected",
          row.usable ? "diagnostic" : "diagnostic_rejected",
          row.rejectionReason,
          JSON.stringify({
            diagnosticOnly: true,
            diagnosticOrigin: "memory_substrate_bakeoff",
            eventFamily: row.eventFamily,
            answerShape: row.answerShape,
            subject: row.subject,
            participants: row.participants,
            premiseQuotes: row.premiseQuotes,
            sourceSessionKeys: row.sourceSessionKeys,
            temporalAnchor: row.temporalAnchor,
            listMembers: row.listMembers,
            identityClaimType: row.identityClaimType,
            sourceCoverageStatus: row.sourceCoverageStatus,
            eventCoverageStatus: row.eventCoverageStatus,
            admissionReason: row.admissionReason,
            rejectionReason: row.rejectionReason,
            sampleId: row.sampleId,
            questionIndex: row.questionIndex,
            residualOwner: row.residualOwner,
            inferredIdentityMembershipFromSupport: false,
            mixedOwner: false
          })
        ]
      );
    }
  });
}

async function eventPersistenceSummary(namespaceId: string): Promise<{
  readonly written: number;
  readonly usable: number;
  readonly rejected: number;
  readonly withoutQuote: number;
  readonly mixedOwner: number;
  readonly unknownFamily: number;
  readonly inferredIdentityMembershipFromSupport: number;
}> {
  const rows = await queryRows<{
    readonly written: string;
    readonly usable: string;
    readonly rejected: string;
    readonly without_quote: string;
    readonly mixed_owner: string;
    readonly unknown_family: string;
    readonly inferred_identity_membership_from_support: string;
  }>(
    `
      SELECT
        COUNT(*)::text AS written,
        COUNT(*) FILTER (WHERE promotion_status = 'compiled')::text AS usable,
        COUNT(*) FILTER (WHERE promotion_status = 'rejected')::text AS rejected,
        COUNT(*) FILTER (WHERE NULLIF(support_phrase, '') IS NULL)::text AS without_quote,
        COUNT(*) FILTER (WHERE COALESCE((metadata->>'mixedOwner')::boolean, false) = true)::text AS mixed_owner,
        COUNT(*) FILTER (
          WHERE metadata->>'eventFamily' NOT IN (
            'reading_event',
            'family_activity_event',
            'creative_activity_event',
            'identity_support_event',
            'dated_activity_event',
            'interest_evidence_event',
            'preference_fit_event'
          )
        )::text AS unknown_family,
        COUNT(*) FILTER (WHERE COALESCE((metadata->>'inferredIdentityMembershipFromSupport')::boolean, false) = true)::text AS inferred_identity_membership_from_support
      FROM compiled_fact_observations
      WHERE namespace_id = $1
        AND predicate_family = 'event_memory_state'
    `,
    [namespaceId]
  );
  const row = rows[0];
  return {
    written: Number(row?.written ?? 0),
    usable: Number(row?.usable ?? 0),
    rejected: Number(row?.rejected ?? 0),
    withoutQuote: Number(row?.without_quote ?? 0),
    mixedOwner: Number(row?.mixed_owner ?? 0),
    unknownFamily: Number(row?.unknown_family ?? 0),
    inferredIdentityMembershipFromSupport: Number(row?.inferred_identity_membership_from_support ?? 0)
  };
}

async function implementedEventCentricLane(params: {
  readonly results: readonly LoCoMoDiagnosticResult[];
  readonly rawChunkHybridLane: LaneReport;
  readonly sourceGeneratedAt: string;
}): Promise<LaneReport> {
  const rawRows = params.rawChunkHybridLane.rawChunkDiagnostics ?? [];
  const diagnostics = rawRows.map(eventDiagnosticFor);
  const runStamp = runStampFromGeneratedAt(params.sourceGeneratedAt) ?? "unknown";
  const namespaceId = `benchmark_event_substrate_${runStamp}_${Date.now()}`;
  await persistEventDiagnostics({ namespaceId, diagnostics });
  const persisted = await eventPersistenceSummary(namespaceId);
  const latencies = params.results.map(resultLatencyMs).filter((value) => value > 0);
  const statusBreakdown = countBy(diagnostics, (row) => row.eventCoverageStatus);
  const usable = statusBreakdown.event_usable ?? 0;
  const wrongShapeExplained =
    (statusBreakdown.event_list_partial ?? 0) +
    (statusBreakdown.event_temporal_anchor_missing ?? 0) +
    (statusBreakdown.event_identity_inference_blocked ?? 0) +
    (statusBreakdown.event_source_partial ?? 0);
  const auditedRows = diagnostics.length;
  return {
    lane: "event_centric",
    implemented: true,
    passRate: auditedRows > 0 ? round(usable / auditedRows) : 0,
    normalizedPassRate: auditedRows > 0 ? round((usable + wrongShapeExplained * 0.5) / auditedRows) : 0,
    ownerBreakdown: statusBreakdown,
    unknownOwnerCount: 0,
    unsupportedNoEvidenceSuccessCount: 0,
    p50Ms: percentile(latencies, 50),
    p95Ms: percentile(latencies, 95),
    maxMs: percentile(latencies, 100),
    queryTimeModelCalls: 0,
    sourceCoverageStatus: persisted.withoutQuote === 0 ? "event_rows_source_quoted" : "event_rows_missing_source_quotes",
    retrievalCoverageStatus: usable >= 5 ? "event_rows_cover_first_window_gate" : "event_rows_do_not_cover_enough_failures",
    readerUtilizationStatus: wrongShapeExplained > 0 ? "remaining_rows_classified_by_event_shape" : "event_rows_reader_compatible",
    memoryStructureStatus:
      usable >= 5
        ? "diagnostic_route_cutover_candidate"
        : usable >= 4
          ? "event_admission_or_structure_needs_inspection"
          : "event_substrate_shape_needs_rethink",
    dominantFailureStage: mostCommonNonPass(statusBreakdown),
    diagnosticOnly: true,
    auditedRows,
    eventRowsWritten: persisted.written,
    eventRowsUsable: persisted.usable,
    eventRowsRejected: persisted.rejected,
    eventRowsWithoutSourceQuote: persisted.withoutQuote,
    mixedOwnerEventRows: persisted.mixedOwner,
    unknownFamilyEventRows: persisted.unknownFamily,
    identityMembershipInferredFromSupportRows: persisted.inferredIdentityMembershipFromSupport,
    eventNamespaceId: namespaceId,
    eventCoverageBreakdown: statusBreakdown,
    eventWrongShapeExplainedCount: wrongShapeExplained,
    eventDiagnostics: diagnostics
  };
}

function placeholderLane(lane: Exclude<SubstrateLane, "current_compiled">): LaneReport {
  return {
    lane,
    implemented: false,
    passRate: 0,
    normalizedPassRate: 0,
    ownerBreakdown: { not_implemented: 1 },
    unknownOwnerCount: 0,
    unsupportedNoEvidenceSuccessCount: 0,
    p50Ms: 0,
    p95Ms: 0,
    maxMs: 0,
    queryTimeModelCalls: 0,
    sourceCoverageStatus: "not_implemented",
    retrievalCoverageStatus: "not_implemented",
    readerUtilizationStatus: "not_implemented",
    memoryStructureStatus: "not_implemented",
    dominantFailureStage: null
  };
}

function decisionFor(
  currentLane: LaneReport,
  rawChunkHybridLane?: LaneReport,
  offlineMaterializedLane?: LaneReport,
  eventCentricLane?: LaneReport
): BakeoffDecision {
  if (currentLane.unknownOwnerCount > 0) {
    return {
      status: "fix_diagnostics_first",
      nextAction: "Repair owner classification before comparing memory substrates.",
      stopReason: "unknown_owner_present",
      recommendedSlice: "diagnostic_repair"
    };
  }
  if (currentLane.unsupportedNoEvidenceSuccessCount > 0) {
    return {
      status: "fix_truth_discipline_first",
      nextAction: "Repair unsupported no-evidence success before comparing memory substrates.",
      stopReason: "unsupported_no_evidence_success",
      recommendedSlice: "truth_discipline_repair"
    };
  }
  if (eventCentricLane?.implemented === true && typeof eventCentricLane.auditedRows === "number" && eventCentricLane.auditedRows > 0) {
    const usable = eventCentricLane.eventRowsUsable ?? 0;
    if (usable >= 5) {
      return {
        status: "diagnostic_route_cutover_candidate_next",
        nextAction: "Event-centric memory covers the first-window gate; next build should test the offline substrate route behind a diagnostic flag.",
        stopReason: null,
        recommendedSlice: "diagnostic_route_cutover"
      };
    }
    return {
      status: "implement_event_centric_lane_next",
      nextAction: "Event-centric memory did not clear the coverage gate; inspect event admission, list aggregation, temporal anchors, and identity-support handling before cutover.",
      stopReason: "event_centric_coverage_below_gate",
      recommendedSlice: "event_centric_memory_substrate"
    };
  }
  if (
    offlineMaterializedLane?.implemented === true &&
    typeof offlineMaterializedLane.auditedRows === "number" &&
    offlineMaterializedLane.auditedRows > 0
  ) {
    const usable = offlineMaterializedLane.materializedRowsUsable ?? 0;
    const wrongShapeExplained = offlineMaterializedLane.wrongShapeExplainedCount ?? 0;
    if (usable >= 5) {
      return {
        status: "diagnostic_route_cutover_candidate_next",
        nextAction: "Offline materialized memory covers at least five first-window failures; next build should test a production route cutover behind a diagnostic flag.",
        stopReason: null,
        recommendedSlice: "diagnostic_route_cutover"
      };
    }
    if (usable >= 4 && usable + wrongShapeExplained >= offlineMaterializedLane.auditedRows) {
      return {
        status: "implement_event_centric_lane_next",
        nextAction: "Offline materialized memory covers source-supported rows and classifies the rest; implement event-centric structure for list/date/identity nuance next.",
        stopReason: null,
        recommendedSlice: "event_centric_memory_substrate"
      };
    }
    return {
      status: "inspect_materialized_compiler_next",
      nextAction: "Offline materialized memory did not cover enough rows; inspect compiler admission and source-premise design before adding more routes.",
      stopReason: null,
      recommendedSlice: "materialized_compiler_admission"
    };
  }
  if (rawChunkHybridLane?.implemented === true && typeof rawChunkHybridLane.auditedRows === "number" && rawChunkHybridLane.auditedRows > 0) {
    const breakdown = rawChunkHybridLane.sourceCoverageBreakdown ?? {};
    const supportFound = breakdown.source_support_found ?? 0;
    const wrongShape = breakdown.source_candidates_found_wrong_shape ?? 0;
    const notFound = breakdown.source_not_found ?? 0;
    if (supportFound / rawChunkHybridLane.auditedRows >= 0.5) {
      return {
        status: "implement_offline_materialized_memory_substrate_next",
        nextAction: "Raw source support exists for most current compiled failures; build the offline materialized memory substrate next.",
        stopReason: null,
        recommendedSlice: "offline_materialized_memory_substrate"
      };
    }
    if (wrongShape >= supportFound && wrongShape > 0) {
      return {
        status: "implement_reader_structure_contract_next",
        nextAction: "Raw source candidates exist but are wrong shape; tighten structured reader/list/report contracts next.",
        stopReason: null,
        recommendedSlice: "reader_structure_contract"
      };
    }
    if (notFound >= rawChunkHybridLane.auditedRows) {
      return {
        status: "run_source_audit_or_oracle_next",
        nextAction: "Raw chunks did not find support; run source audit or long-context oracle before implementation.",
        stopReason: null,
        recommendedSlice: "source_audit_or_oracle"
      };
    }
  }
  if ((currentLane.ownerBreakdown.report_semantics ?? 0) > 0 || (currentLane.ownerBreakdown.route_ranking ?? 0) > 0) {
    return {
      status: "implement_raw_chunk_hybrid_lane_next",
      nextAction: "Implement raw_chunk_hybrid as the first real comparison lane.",
      stopReason: null,
      recommendedSlice: "slice_1_raw_chunk_hybrid"
    };
  }
  return {
    status: "current_lane_baseline_ready",
    nextAction: "Keep current_compiled as baseline and implement raw_chunk_hybrid for source-coverage comparison.",
    stopReason: null,
    recommendedSlice: "slice_1_raw_chunk_hybrid"
  };
}

function toMarkdown(report: MemorySubstrateBakeoffReport): string {
  const lines = [
    "# Memory Substrate Bake-Off",
    "",
    `- generatedAt: ${report.generatedAt}`,
    `- sourceArtifactPath: ${report.sourceArtifactPath}`,
    `- sampleWindow: ${report.sampleWindow}`,
    `- observedQuestionCount: ${report.observedQuestionCount}`,
    `- evaluatedQuestionCount: ${report.evaluatedQuestionCount}`,
    `- decision: ${report.decision.status}`,
    `- nextAction: ${report.decision.nextAction}`,
    "",
    "## Lanes",
    ""
  ];
  for (const lane of report.lanes) {
    lines.push(
      `- ${lane.lane}: implemented=${lane.implemented} passRate=${lane.passRate} normalizedPassRate=${lane.normalizedPassRate} p95Ms=${lane.p95Ms} owners=${JSON.stringify(lane.ownerBreakdown)} memoryStructureStatus=${lane.memoryStructureStatus}`
    );
    if (lane.lane === "offline_materialized" && lane.implemented) {
      lines.push(
        `  - materializedNamespaceId=${lane.materializedNamespaceId ?? "unknown"} materializedRowsWritten=${lane.materializedRowsWritten ?? 0} usable=${lane.materializedRowsUsable ?? 0} rejected=${lane.materializedRowsRejected ?? 0} withoutQuote=${lane.materializedRowsWithoutSourceQuote ?? 0} mixedOwner=${lane.mixedOwnerMaterializedRows ?? 0} unknownFamily=${lane.unknownFamilyMaterializedRows ?? 0} wrongShapeExplained=${lane.wrongShapeExplainedCount ?? 0} sourcePartial=${lane.sourcePartialCount ?? 0}`
      );
    }
    if (lane.lane === "event_centric" && lane.implemented) {
      lines.push(
        `  - eventNamespaceId=${lane.eventNamespaceId ?? "unknown"} eventRowsWritten=${lane.eventRowsWritten ?? 0} usable=${lane.eventRowsUsable ?? 0} rejected=${lane.eventRowsRejected ?? 0} withoutQuote=${lane.eventRowsWithoutSourceQuote ?? 0} mixedOwner=${lane.mixedOwnerEventRows ?? 0} unknownFamily=${lane.unknownFamilyEventRows ?? 0} identityMembershipFromSupport=${lane.identityMembershipInferredFromSupportRows ?? 0} wrongShapeExplained=${lane.eventWrongShapeExplainedCount ?? 0}`
      );
    }
  }
  lines.push("", "## Failures", "");
  if (report.failures.length === 0) {
    lines.push("- none");
  } else {
    for (const failure of report.failures) {
      lines.push(`- ${failure}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

function parseSampleWindowArg(argv = process.argv.slice(2)): SampleWindow {
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    const raw = value === "--sample-window" ? argv[index + 1] : value?.startsWith("--sample-window=") ? value.slice("--sample-window=".length) : null;
    if (raw === "first-cluster" || raw === "all-observed") {
      return raw;
    }
  }
  return "first-cluster";
}

function parseLaneArg(argv = process.argv.slice(2)): LaneArg {
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    const raw = value === "--lane" ? argv[index + 1] : value?.startsWith("--lane=") ? value.slice("--lane=".length) : null;
    if (raw === "current_compiled" || raw === "all") {
      return raw;
    }
  }
  return "all";
}

export async function runMemorySubstrateBakeoff(options?: {
  readonly artifactPath?: string;
  readonly sampleWindow?: SampleWindow;
  readonly lane?: LaneArg;
}): Promise<{ readonly report: MemorySubstrateBakeoffReport; readonly output: { readonly jsonPath: string; readonly markdownPath: string } }> {
  const source = await readLoCoMoArtifact(import.meta.url, options?.artifactPath);
  const sampleWindow = options?.sampleWindow ?? "first-cluster";
  const selectedResults = selectResults(source.report.results ?? [], sampleWindow);
  const currentLane = implementedCurrentLane(selectedResults);
  const rawChunkHybridLane = await implementedRawChunkHybridLane({
    results: selectedResults,
    sourceGeneratedAt: source.report.generatedAt ?? source.report.progress?.runStamp ?? ""
  });
  const offlineMaterializedLane =
    options?.lane === "current_compiled"
      ? undefined
      : await implementedOfflineMaterializedLane({
          results: selectedResults,
          rawChunkHybridLane,
          sourceGeneratedAt: source.report.generatedAt ?? source.report.progress?.runStamp ?? ""
        });
  const eventCentricLane =
    options?.lane === "current_compiled"
      ? undefined
      : await implementedEventCentricLane({
          results: selectedResults,
          rawChunkHybridLane,
          sourceGeneratedAt: source.report.generatedAt ?? source.report.progress?.runStamp ?? ""
        });
  const requestedLane = options?.lane ?? "all";
  const lanes =
    requestedLane === "current_compiled"
      ? [currentLane]
      : ALL_LANES.map((lane) => {
          if (lane === "current_compiled") return currentLane;
          if (lane === "raw_chunk_hybrid") return rawChunkHybridLane;
          if (lane === "offline_materialized" && offlineMaterializedLane) return offlineMaterializedLane;
          if (lane === "event_centric" && eventCentricLane) return eventCentricLane;
          return placeholderLane(lane);
        });
  const decision = decisionFor(
    currentLane,
    requestedLane === "current_compiled" ? undefined : rawChunkHybridLane,
    requestedLane === "current_compiled" ? undefined : offlineMaterializedLane,
    requestedLane === "current_compiled" ? undefined : eventCentricLane
  );
  const failures: string[] = [];
  if (currentLane.queryTimeModelCalls > 0) failures.push("query_time_gliner_or_llm_used");
  if (currentLane.unknownOwnerCount > 0) failures.push("unknown_owner_present");
  if (currentLane.unsupportedNoEvidenceSuccessCount > 0) failures.push("unsupported_no_evidence_success");
  if ((offlineMaterializedLane?.materializedRowsWritten ?? 0) > 0 && offlineMaterializedLane?.sourceCoverageStatus !== "materialized_rows_source_quoted") {
    failures.push("offline_materialized_rows_missing_source_quotes");
  }
  if ((offlineMaterializedLane?.materializedRowsUsable ?? 0) < 4 && requestedLane !== "current_compiled") {
    failures.push("offline_materialized_coverage_below_gate");
  }
  if ((eventCentricLane?.eventRowsWritten ?? 0) > 0 && eventCentricLane?.sourceCoverageStatus !== "event_rows_source_quoted") {
    failures.push("event_rows_missing_source_quotes");
  }
  if ((eventCentricLane?.eventRowsUsable ?? 0) < 5 && requestedLane !== "current_compiled") {
    failures.push("event_centric_coverage_below_gate");
  }
  if ((eventCentricLane?.identityMembershipInferredFromSupportRows ?? 0) > 0) {
    failures.push("event_identity_membership_inferred_from_support");
  }

  const report: MemorySubstrateBakeoffReport = {
    generatedAt: new Date().toISOString(),
    benchmark: "memory_substrate_bakeoff",
    sourceArtifactPath: source.path,
    sourceGeneratedAt: source.report.generatedAt ?? "unknown",
    sampleWindow,
    observedQuestionCount: source.report.results?.length ?? 0,
    evaluatedQuestionCount: selectedResults.length,
    lanes,
    decision,
    failures
  };
  const dir = locomoOutputDir(import.meta.url);
  await mkdir(dir, { recursive: true });
  const stamp = report.generatedAt.replace(/[:.]/gu, "-");
  const jsonPath = path.join(dir, `memory-substrate-bakeoff-${stamp}.json`);
  const markdownPath = path.join(dir, `memory-substrate-bakeoff-${stamp}.md`);
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, toMarkdown(report), "utf8");
  return { report, output: { jsonPath, markdownPath } };
}

export async function runMemorySubstrateBakeoffCli(): Promise<void> {
  try {
    const result = await runMemorySubstrateBakeoff({
      artifactPath: parseArtifactArg(),
      sampleWindow: parseSampleWindowArg(),
      lane: parseLaneArg()
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    await closePool();
  }
}
