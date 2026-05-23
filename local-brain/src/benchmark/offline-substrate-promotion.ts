import { createHash } from "node:crypto";
import { withClient, queryRows } from "../db/client.js";
import {
  formatLoCoMoConversationSession,
  type LoCoMoConversationRecord,
  type LoCoMoTurnRecord
} from "./locomo-ingest.js";

type SubstratePredicateFamily = "materialized_memory_state" | "event_memory_state";

export type MaterializedStateFamily =
  | "family_interest_list"
  | "family_activity_list"
  | "recent_creative_work"
  | "activity_fit_preference"
  | "book_reading_list"
  | "identity_membership_evidence"
  | "dated_activity_evidence";

export type EventMemoryFamily =
  | "causal_reason_event"
  | "support_reason_event"
  | "favorite_preference_event"
  | "explicit_list_event"
  | "reading_event"
  | "family_activity_event"
  | "creative_activity_event"
  | "identity_support_event"
  | "dated_activity_event"
  | "interest_evidence_event"
  | "preference_fit_event";

type RawChunkSourceCoverageStatus =
  | "source_support_found"
  | "source_candidates_found_wrong_shape"
  | "source_not_found"
  | "source_audit_inconclusive";

type AnswerShape = "atomic" | "list" | "preference" | "identity" | "date" | "reason" | "support";

type SourceDerivedQueryShape =
  | "causal_reason"
  | "support_reason"
  | "favorite_preference"
  | "explicit_list"
  | "date_activity"
  | "identity_support"
  | "reading"
  | "activity_fit"
  | "creative_activity"
  | "interest_evidence";

type MaterializedCoverageStatus =
  | "materialized_usable"
  | "source_partial_expected_answer"
  | "materialized_list_incomplete"
  | "negative_identity_inference_blocked"
  | "temporal_anchor_missing"
  | "materialized_missing";

type EventCoverageStatus =
  | "event_usable"
  | "event_list_partial"
  | "event_temporal_anchor_missing"
  | "event_identity_inference_blocked"
  | "event_source_partial"
  | "event_missing";

export interface OfflineSubstrateQuestion {
  readonly question: string;
  /**
   * Benchmark scoring/reporting only. Source-independent admission must never
   * read this value to choose families, values, list members, or coverage.
   */
  readonly expectedAnswer?: string;
  readonly questionIndex: number;
  readonly queryBehavior?: string | null;
  readonly residualOwner?: string | null;
}

interface RawChunkDiagnosticRow {
  readonly sampleId: string;
  readonly questionIndex: number;
  readonly residualOwner: string | null;
  readonly question: string;
  readonly queryBehavior: string | null;
  readonly queryShape: SourceDerivedQueryShape;
  readonly sourceDerivedFamily: EventMemoryFamily;
  readonly sourceDerivedAnswerValue: string | null;
  readonly evidenceTriggers: readonly string[];
  readonly sourceCoverageStatus: RawChunkSourceCoverageStatus;
  readonly candidateCount: number;
  readonly topCandidateQuotes: readonly string[];
  readonly sourceSessionKeys: readonly string[];
  readonly matchedAnchors: readonly string[];
}

interface MaterializedDiagnosticRow {
  readonly sampleId: string;
  readonly questionIndex: number;
  readonly residualOwner: string | null;
  readonly question: string;
  readonly queryBehavior: string | null;
  readonly queryShape: SourceDerivedQueryShape;
  readonly sourceDerivedFamily: MaterializedStateFamily;
  readonly sourceDerivedAnswerValue: string;
  readonly evidenceTriggers: readonly string[];
  readonly stateFamily: MaterializedStateFamily;
  readonly answerShape: AnswerShape;
  readonly materializedCoverageStatus: MaterializedCoverageStatus;
  readonly sourceCoverageStatus: RawChunkSourceCoverageStatus;
  readonly usable: boolean;
  readonly premiseQuotes: readonly string[];
  readonly sourceSessionKeys: readonly string[];
  readonly admissionReason: string | null;
  readonly rejectionReason: string | null;
}

interface EventDiagnosticRow {
  readonly sampleId: string;
  readonly questionIndex: number;
  readonly residualOwner: string | null;
  readonly question: string;
  readonly queryBehavior: string | null;
  readonly queryShape: SourceDerivedQueryShape;
  readonly sourceDerivedFamily: EventMemoryFamily;
  readonly sourceDerivedAnswerValue: string;
  readonly evidenceTriggers: readonly string[];
  readonly eventFamily: EventMemoryFamily;
  readonly answerShape: AnswerShape;
  readonly eventCoverageStatus: EventCoverageStatus;
  readonly sourceCoverageStatus: RawChunkSourceCoverageStatus;
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
}

export interface OfflineSubstratePromotionSummary {
  readonly namespaceId: string;
  readonly sampleId: string;
  readonly questionCount: number;
  readonly rawRowsAudited: number;
  readonly materializedRowsWritten: number;
  readonly materializedRowsUsable: number;
  readonly materializedRowsRejected: number;
  readonly eventRowsWritten: number;
  readonly eventRowsUsable: number;
  readonly eventRowsRejected: number;
  readonly rowsWithoutSourceQuote: number;
  readonly expectedAnswerPromotionUseRows: number;
  readonly missingSourceDerivedMetadataRows: number;
  readonly sourceIndependentRows: number;
  readonly mixedOwnerRows: number;
  readonly unknownFamilyRows: number;
  readonly identityMembershipInferredFromSupportRows: number;
  readonly sourceCoverageBreakdown: Readonly<Record<string, number>>;
  readonly materializedCoverageBreakdown: Readonly<Record<string, number>>;
  readonly eventCoverageBreakdown: Readonly<Record<string, number>>;
}

const STOP_WORDS = new Set([
  "about",
  "after",
  "before",
  "considered",
  "could",
  "does",
  "during",
  "from",
  "have",
  "likely",
  "none",
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

function normalizeText(value: unknown): string {
  return String(value ?? "").replace(/\s+/gu, " ").trim();
}

function compactText(value: unknown): string {
  return normalizeText(value).toLowerCase().replace(/[^a-z0-9]+/gu, " ").trim();
}

function countBy<T>(values: readonly T[], selector: (value: T) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) {
    const key = selector(value);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function deterministicUuid(seed: string): string {
  const hex = createHash("sha256").update(seed).digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function anchorsFrom(value: string, mode: "query" | "expected"): readonly string[] {
  const quoted = [...value.matchAll(/[""]([^""]{2,80})[""]/gu)].map((match) => match[1] ?? "");
  const capitalized = [...value.matchAll(/\b[A-Z][A-Za-z'’+-]{2,}(?:\s+[A-Z][A-Za-z'’+-]{2,}){0,3}\b/gu)]
    .map((match) => match[0] ?? "")
    .filter((term) => !/^(?:What|When|Where|Which|Would|The|No|Likely)$/u.test(term));
  const words = compactText(value)
    .split(/\s+/u)
    .filter((term) => {
      if (term.length < (mode === "expected" ? 3 : 4)) return false;
      if (STOP_WORDS.has(term)) return false;
      if (/^\d+$/u.test(term) && term.length < 4) return false;
      return true;
    });
  return [...new Set([...quoted, ...capitalized, ...words].map(normalizeText).filter(Boolean))].slice(0, mode === "expected" ? 18 : 14);
}

function quotedAnchorsFrom(value: string): readonly string[] {
  return [...value.matchAll(/[""]([^""]{2,80})[""]/gu)].map((match) => normalizeText(match[1] ?? "")).filter(Boolean);
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

function quoteContainsAnchor(quotes: readonly string[], anchor: string): boolean {
  return matchingAnchors(quotes.join(" "), [anchor]).length > 0;
}

function queryShapeForQuestion(question: string, queryBehavior?: string | null): SourceDerivedQueryShape {
  const query = compactText(question);
  if (/\b(?:why|reason|because|decid(?:e|ed)|motivated?|inspir(?:e|ed)|spark(?:ed)?|cause|caused)\b/u.test(query)) {
    return "causal_reason";
  }
  if (/\b(?:who|what|which)\b/u.test(query) && /\b(?:support|help|advice|encourag(?:e|ed)|inspir(?:e|ed)|mentor)\b/u.test(query)) {
    return "support_reason";
  }
  if (/\b(?:favorite|prefer|prefers|liked?|likes|enjoy(?:s|ed)?|loved|about)\b/u.test(query)) {
    return "favorite_preference";
  }
  if (/\b(?:which|what)\b/u.test(query) && /\b(?:classes|groups|bands|books?|series|activities|items|names|things|places)\b/u.test(query)) {
    return "explicit_list";
  }
  if (/\bwhen\b/u.test(query)) return "date_activity";
  if (/\b(?:lgbtq|community|member|identity|considered|refer)\b/u.test(query)) return "identity_support";
  if (/\b(?:book|read|reading|novel|series)\b/u.test(query)) return "reading";
  if (/\b(?:national park|theme park|outdoor|outdoors|better fit|fit)\b/u.test(query)) return "activity_fit";
  if (/\b(?:paint|painting|creative|art|drawing)\b/u.test(query)) return "creative_activity";
  if (queryBehavior === "causal") return "causal_reason";
  if (queryBehavior === "temporal_detail") return "date_activity";
  return "interest_evidence";
}

function eventFamilyForQueryShape(shape: SourceDerivedQueryShape): EventMemoryFamily {
  if (shape === "causal_reason") return "causal_reason_event";
  if (shape === "support_reason") return "support_reason_event";
  if (shape === "favorite_preference") return "favorite_preference_event";
  if (shape === "explicit_list") return "explicit_list_event";
  if (shape === "date_activity") return "dated_activity_event";
  if (shape === "identity_support") return "identity_support_event";
  if (shape === "reading") return "reading_event";
  if (shape === "activity_fit") return "preference_fit_event";
  if (shape === "creative_activity") return "creative_activity_event";
  return "interest_evidence_event";
}

function answerShapeForQueryShape(shape: SourceDerivedQueryShape): AnswerShape {
  if (shape === "causal_reason") return "reason";
  if (shape === "support_reason") return "support";
  if (shape === "favorite_preference") return "preference";
  if (shape === "explicit_list" || shape === "reading" || shape === "interest_evidence") return "list";
  if (shape === "date_activity") return "date";
  if (shape === "identity_support") return "identity";
  return "atomic";
}

const SHAPE_TRIGGER_PATTERNS: Record<SourceDerivedQueryShape, readonly RegExp[]> = {
  causal_reason: [
    /\bbecause\b/iu,
    /\bdecid(?:e|ed|ing)\b/iu,
    /\blost\b/iu,
    /\bloved?\b/iu,
    /\bwanted?\b/iu,
    /\binspir(?:e|ed|ing|ation)\b/iu,
    /\bspark(?:ed)?\b/iu,
    /\breason\b/iu,
    /\bso\b/iu
  ],
  support_reason: [
    /\bsupport(?:ed|s|ing)?\b/iu,
    /\bhelp(?:ed|s|ing)?\b/iu,
    /\badvi[cs](?:e|ed|ing)?\b/iu,
    /\bencourag(?:e|ed|ing)\b/iu,
    /\binspir(?:e|ed|ing|ation)\b/iu,
    /\bmentor(?:ed|ing)?\b/iu
  ],
  favorite_preference: [
    /\bfavo[u]?rite\b/iu,
    /\bprefer(?:s|red|ring)?\b/iu,
    /\blikes?\b/iu,
    /\benjoy(?:s|ed|ing)?\b/iu,
    /\bloved?\b/iu
  ],
  explicit_list: [
    /,/u,
    /\band\b/iu,
    /\b(?:both|including|such as|like)\b/iu
  ],
  date_activity: [
    /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/iu,
    /\b\d{4}\b/u,
    /\b(?:yesterday|today|last|next|weekend|week|month|year)\b/iu
  ],
  identity_support: [
    /\b(?:lgbtq|community|member|support|rights|center|ally)\b/iu
  ],
  reading: [
    /\b(?:book|read|reading|novel|series|chapter)\b/iu
  ],
  activity_fit: [
    /\b(?:outdoor|outdoors|national park|theme park|fit|nature|hiking|camping)\b/iu
  ],
  creative_activity: [
    /\b(?:paint|painting|creative|art|drawing|sunset)\b/iu
  ],
  interest_evidence: [
    /\b(?:interest|interested|like|likes|enjoy|enjoys|activity|activities)\b/iu
  ]
};

function evidenceTriggersForShape(quote: string, shape: SourceDerivedQueryShape): readonly string[] {
  return SHAPE_TRIGGER_PATTERNS[shape]
    .filter((pattern) => pattern.test(quote))
    .map((pattern) => pattern.source.replace(/\\b|\\|[()?:]/gu, "").slice(0, 64));
}

function isNegativeInferenceQuestion(row: OfflineSubstrateQuestion): boolean {
  const text = compactText(row.question);
  return (
    /\b(not refer|does not|member of|considered)\b/u.test(text) &&
    /\b(community|identity|considered|member)\b/u.test(text)
  );
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

function candidateScore(quote: string, queryAnchors: readonly string[], queryShape: SourceDerivedQueryShape): {
  readonly score: number;
  readonly queryMatches: readonly string[];
  readonly evidenceTriggers: readonly string[];
} {
  const queryMatches = matchingAnchors(quote, queryAnchors);
  const evidenceTriggers = evidenceTriggersForShape(quote, queryShape);
  const score =
    queryMatches.length +
    evidenceTriggers.length * 3 +
    queryMatches.filter((anchor) => compactText(anchor).length >= 8).length;
  return { score, queryMatches, evidenceTriggers };
}

function corpusCandidatesFor(sample: LoCoMoConversationRecord, row: OfflineSubstrateQuestion): readonly {
  readonly sessionKey: string;
  readonly quote: string;
  readonly score: number;
  readonly queryAnchorMatches: readonly string[];
  readonly evidenceTriggers: readonly string[];
}[] {
  const queryAnchors = anchorsFrom(row.question, "query");
  const queryShape = queryShapeForQuestion(row.question, row.queryBehavior);
  const candidates: Array<{
    readonly sessionKey: string;
    readonly quote: string;
    readonly score: number;
    readonly queryAnchorMatches: readonly string[];
    readonly evidenceTriggers: readonly string[];
  }> = [];
  for (const source of sourceTexts(sample)) {
    const lines = source.text
      .replace(/\r\n?/gu, "\n")
      .split(/\n+/u)
      .map(normalizeText)
      .filter(Boolean);
    for (let index = 0; index < lines.length; index += 1) {
      const quote = lines.slice(Math.max(0, index - 1), Math.min(lines.length, index + 2)).join(" ").slice(0, 900);
      const scored = candidateScore(quote, queryAnchors, queryShape);
      if (scored.score <= 0) continue;
      candidates.push({
        sessionKey: source.sessionKey,
        quote,
        score: scored.score,
        queryAnchorMatches: scored.queryMatches,
        evidenceTriggers: scored.evidenceTriggers
      });
    }
  }
  return candidates.sort((left, right) => right.score - left.score).slice(0, 8);
}

function rawCoverageStatus(row: OfflineSubstrateQuestion, candidates: readonly {
  readonly queryAnchorMatches: readonly string[];
  readonly evidenceTriggers: readonly string[];
}[]): RawChunkSourceCoverageStatus {
  if (candidates.length === 0) return "source_not_found";
  const aggregateQueryMatches = new Set(candidates.flatMap((candidate) => candidate.queryAnchorMatches.map(compactText)));
  const aggregateTriggers = new Set(candidates.flatMap((candidate) => candidate.evidenceTriggers.map(compactText)));
  const quotedQueryAnchors = quotedAnchorsFrom(row.question).map(compactText);
  const hasQueryMatch = aggregateQueryMatches.size > 0;
  const allQuotedQueryMatched = quotedQueryAnchors.length === 0 || quotedQueryAnchors.every((anchor) => aggregateQueryMatches.has(anchor));
  const hasFamilyTrigger = aggregateTriggers.size > 0;

  if (isNegativeInferenceQuestion(row)) return hasQueryMatch ? "source_candidates_found_wrong_shape" : "source_audit_inconclusive";
  if (hasQueryMatch && hasFamilyTrigger && allQuotedQueryMatched) {
    return "source_support_found";
  }
  if (hasFamilyTrigger || hasQueryMatch) return "source_candidates_found_wrong_shape";
  return "source_audit_inconclusive";
}

function rawDiagnosticFor(sample: LoCoMoConversationRecord, row: OfflineSubstrateQuestion): RawChunkDiagnosticRow {
  const candidates = corpusCandidatesFor(sample, row);
  const status = rawCoverageStatus(row, candidates);
  const topCandidates = candidates.slice(0, 3);
  const queryShape = queryShapeForQuestion(row.question, row.queryBehavior);
  const sourceDerivedFamily = eventFamilyForQueryShape(queryShape);
  const evidenceTriggers = [...new Set(topCandidates.flatMap((candidate) => candidate.evidenceTriggers))];
  const matchedAnchors = [...new Set(topCandidates.flatMap((candidate) => candidate.queryAnchorMatches))];
  const sourceDerivedAnswerValue = sourceDerivedValueFromQuotes(topCandidates.map((candidate) => candidate.quote), queryShape);
  return {
    sampleId: sample.sample_id,
    questionIndex: row.questionIndex,
    residualOwner: row.residualOwner ?? null,
    question: normalizeText(row.question),
    queryBehavior: row.queryBehavior ?? null,
    queryShape,
    sourceDerivedFamily,
    sourceDerivedAnswerValue,
    evidenceTriggers,
    sourceCoverageStatus: status,
    candidateCount: candidates.length,
    topCandidateQuotes: topCandidates.map((candidate) => candidate.quote),
    sourceSessionKeys: [...new Set(topCandidates.map((candidate) => candidate.sessionKey).filter(Boolean))],
    matchedAnchors
  };
}

function splitListMembersFromText(value: string): readonly string[] {
  const trimmed = normalizeText(value);
  const candidate = trimmed
    .replace(/\b(?:including|such as|like)\b/giu, ",")
    .replace(/\b(?:and|or)\b/giu, ",");
  return [...new Set(candidate
    .split(/[,;]/u)
    .map((part) => normalizeText(part).replace(/^[.:"'’\s-]+|[.:"'’\s-]+$/gu, ""))
    .filter((part) => part.length >= 3 && part.length <= 80 && !/^(?:i|me|my|the|a|an|to|for|with)$/iu.test(part))
    .slice(0, 16))];
}

function clauseAfterTrigger(quote: string, patterns: readonly RegExp[]): string | null {
  const normalized = normalizeText(quote);
  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (!match || match.index === undefined) continue;
    const start = Math.max(0, match.index);
    const clause = normalizeText(normalized.slice(start).split(/(?:[.!?]\s+|\n)/u)[0] ?? "");
    if (clause.length >= 8) return clause.slice(0, 240);
  }
  return null;
}

function sourceDerivedValueFromQuotes(quotes: readonly string[], shape: SourceDerivedQueryShape): string | null {
  const joined = normalizeText(quotes.join(" "));
  if (!joined) return null;
  if (shape === "causal_reason") {
    return clauseAfterTrigger(joined, SHAPE_TRIGGER_PATTERNS.causal_reason);
  }
  if (shape === "support_reason") {
    return clauseAfterTrigger(joined, SHAPE_TRIGGER_PATTERNS.support_reason);
  }
  if (shape === "favorite_preference") {
    return clauseAfterTrigger(joined, SHAPE_TRIGGER_PATTERNS.favorite_preference);
  }
  if (shape === "explicit_list" || shape === "reading" || shape === "interest_evidence") {
    const members = splitListMembersFromText(joined)
      .filter((member) => matchingAnchors(joined, [member]).length > 0)
      .slice(0, 12);
    return members.length > 0 ? members.join(", ") : null;
  }
  if (shape === "date_activity") {
    return temporalAnchorFromQuotes(quotes);
  }
  if (shape === "identity_support") {
    return evidenceTriggersForShape(joined, shape).length > 0 ? "not_self_membership" : null;
  }
  return joined.slice(0, 240);
}

function familyForMaterializedRow(row: RawChunkDiagnosticRow): {
  readonly stateFamily: MaterializedStateFamily;
  readonly answerShape: AnswerShape;
} {
  const text = compactText(row.question);
  if (row.queryShape === "identity_support") return { stateFamily: "identity_membership_evidence", answerShape: "identity" };
  if (row.queryShape === "date_activity") {
    return { stateFamily: "dated_activity_evidence", answerShape: "date" };
  }
  if (row.queryShape === "reading" || /\b(book|read|reading)\b/u.test(text)) return { stateFamily: "book_reading_list", answerShape: "list" };
  if (row.queryShape === "activity_fit" || row.queryShape === "favorite_preference") return { stateFamily: "activity_fit_preference", answerShape: "preference" };
  if (row.queryShape === "explicit_list") return { stateFamily: "family_activity_list", answerShape: "list" };
  if (row.queryShape === "creative_activity") return { stateFamily: "recent_creative_work", answerShape: "atomic" };
  if (row.queryShape === "causal_reason" || row.queryShape === "support_reason") return { stateFamily: "activity_fit_preference", answerShape: answerShapeForQueryShape(row.queryShape) };
  return { stateFamily: "family_activity_list", answerShape: "list" };
}

function materializedStatusFor(row: RawChunkDiagnosticRow, stateFamily: MaterializedStateFamily): MaterializedCoverageStatus {
  if (row.topCandidateQuotes.length === 0 || row.sourceCoverageStatus === "source_not_found") return "materialized_missing";
  if (stateFamily === "identity_membership_evidence") return "negative_identity_inference_blocked";
  if (stateFamily === "dated_activity_evidence") {
    const quoted = quotedAnchorsFrom(row.question);
    const hasQuotedTarget = quoted.length === 0 || quoted.every((anchor) => quoteContainsAnchor(row.topCandidateQuotes, anchor));
    const hasTemporalAnchor = /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|\d{4}|yesterday|today|last|next|week|month|year)\b/iu.test(row.topCandidateQuotes.join(" "));
    return hasQuotedTarget && hasTemporalAnchor ? "materialized_usable" : "temporal_anchor_missing";
  }
  if (stateFamily === "book_reading_list") {
    const members = sourceDerivedListMembersForRow(row);
    return members.length > 0 ? "materialized_usable" : "source_partial_expected_answer";
  }
  if (stateFamily === "family_interest_list" || stateFamily === "family_activity_list") {
    const members = sourceDerivedListMembersForRow(row);
    if (members.length >= 2 || row.sourceCoverageStatus === "source_support_found") return "materialized_usable";
    return "materialized_list_incomplete";
  }
  return row.sourceCoverageStatus === "source_support_found" ? "materialized_usable" : "source_partial_expected_answer";
}

function valueForMaterializedRow(row: MaterializedDiagnosticRow): string {
  if (row.sourceDerivedAnswerValue) return row.sourceDerivedAnswerValue;
  return row.stateFamily;
}

function materializedDiagnosticFor(row: RawChunkDiagnosticRow): MaterializedDiagnosticRow {
  const family = familyForMaterializedRow(row);
  const status = materializedStatusFor(row, family.stateFamily);
  const usable = status === "materialized_usable";
  return {
    sampleId: row.sampleId,
    questionIndex: row.questionIndex,
    residualOwner: row.residualOwner,
    question: row.question,
    queryBehavior: row.queryBehavior,
    queryShape: row.queryShape,
    sourceDerivedFamily: family.stateFamily,
    sourceDerivedAnswerValue: row.sourceDerivedAnswerValue ?? family.stateFamily,
    evidenceTriggers: row.evidenceTriggers,
    stateFamily: family.stateFamily,
    answerShape: family.answerShape,
    materializedCoverageStatus: status,
    sourceCoverageStatus: row.sourceCoverageStatus,
    usable,
    premiseQuotes: row.topCandidateQuotes.filter(Boolean).slice(0, 5),
    sourceSessionKeys: row.sourceSessionKeys,
    admissionReason: usable ? "source_bound_materialized_state_with_compatible_shape" : null,
    rejectionReason: usable ? null : status
  };
}

function subjectFromQuestion(question: string): string | null {
  const match = question.match(/\b(?:What|When|Would|Which|Where|Who|How)\s+([A-Z][a-z]+)(?:'s|\b)/u);
  return match?.[1] ?? null;
}

function sourceDerivedListMembersForRow(row: RawChunkDiagnosticRow): readonly string[] {
  const valueMembers = splitListMembersFromText(row.sourceDerivedAnswerValue ?? "");
  if (valueMembers.length > 0) return valueMembers;
  const quoteText = row.topCandidateQuotes.join(" ");
  const capitalized = [...quoteText.matchAll(/\b[A-Z][A-Za-z'’+-]{2,}(?:\s+[A-Z][A-Za-z'’+-]{2,}){0,3}\b/gu)]
    .map((match) => normalizeText(match[0] ?? ""))
    .filter((term) => !/^(?:What|When|Where|Which|Would|The|No|Likely|I|We)$/u.test(term));
  const queryAnchors = row.matchedAnchors.filter((anchor) => compactText(anchor).length >= 3);
  return [...new Set([...capitalized, ...queryAnchors])].slice(0, 12);
}

function eventFamilyForRow(row: RawChunkDiagnosticRow): {
  readonly eventFamily: EventMemoryFamily;
  readonly answerShape: AnswerShape;
} {
  return { eventFamily: row.sourceDerivedFamily, answerShape: answerShapeForQueryShape(row.queryShape) };
}

function temporalAnchorFromQuotes(quotes: readonly string[]): string | null {
  const match = quotes.join(" ").match(/\b(?:\d{4}|yesterday|today|last weekend|last week|last month|last year)\b/iu);
  return match ? normalizeText(match[0]) : null;
}

function listMembersForEvent(row: RawChunkDiagnosticRow): readonly string[] {
  return sourceDerivedListMembersForRow(row);
}

function eventStatusFor(row: RawChunkDiagnosticRow, eventFamily: EventMemoryFamily): EventCoverageStatus {
  if (row.topCandidateQuotes.length === 0 || row.sourceCoverageStatus === "source_not_found") return "event_missing";
  if (row.evidenceTriggers.length === 0 && row.sourceCoverageStatus !== "source_support_found") return "event_source_partial";
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
    return listMembersForEvent(row).length > 0 ? "event_usable" : "event_source_partial";
  }
  if (eventFamily === "family_activity_event" || eventFamily === "interest_evidence_event" || eventFamily === "explicit_list_event") {
    const members = listMembersForEvent(row);
    return members.length >= 2 || row.sourceCoverageStatus === "source_support_found" ? "event_usable" : "event_list_partial";
  }
  if (eventFamily === "causal_reason_event" || eventFamily === "support_reason_event" || eventFamily === "favorite_preference_event") {
    return row.sourceDerivedAnswerValue !== null && row.evidenceTriggers.length > 0 ? "event_usable" : "event_source_partial";
  }
  return row.sourceCoverageStatus === "source_support_found" ? "event_usable" : "event_source_partial";
}

function identityClaimTypeFor(eventFamily: EventMemoryFamily, status: EventCoverageStatus): EventDiagnosticRow["identityClaimType"] {
  if (eventFamily !== "identity_support_event") return null;
  return status === "event_usable" ? "not_self_membership" : "support";
}

function eventDiagnosticFor(row: RawChunkDiagnosticRow): EventDiagnosticRow {
  const family = eventFamilyForRow(row);
  const status = eventStatusFor(row, family.eventFamily);
  const usable = status === "event_usable";
  const subject = subjectFromQuestion(row.question);
  return {
    sampleId: row.sampleId,
    questionIndex: row.questionIndex,
    residualOwner: row.residualOwner,
    question: row.question,
    queryBehavior: row.queryBehavior,
    queryShape: row.queryShape,
    sourceDerivedFamily: family.eventFamily,
    sourceDerivedAnswerValue: row.sourceDerivedAnswerValue ?? family.eventFamily,
    evidenceTriggers: row.evidenceTriggers,
    eventFamily: family.eventFamily,
    answerShape: family.answerShape,
    eventCoverageStatus: status,
    sourceCoverageStatus: row.sourceCoverageStatus,
    subject,
    participants: [...new Set([...row.matchedAnchors.filter((anchor) => /^[A-Z][a-z]+/u.test(anchor)), subject].filter((value): value is string => Boolean(value)))],
    premiseQuotes: row.topCandidateQuotes.filter(Boolean).slice(0, 5),
    sourceSessionKeys: row.sourceSessionKeys,
    temporalAnchor: temporalAnchorFromQuotes(row.topCandidateQuotes),
    listMembers: listMembersForEvent(row),
    identityClaimType: identityClaimTypeFor(family.eventFamily, status),
    admissionReason: usable ? "source_bound_event_with_compatible_shape" : null,
    rejectionReason: usable ? null : status,
    usable
  };
}

function valueForEventRow(row: EventDiagnosticRow): string {
  if (row.sourceDerivedAnswerValue) return row.sourceDerivedAnswerValue;
  if (row.listMembers.length > 0) return row.listMembers.join(", ");
  if (row.temporalAnchor !== null) return row.temporalAnchor;
  if (row.identityClaimType !== null) return row.identityClaimType;
  return row.eventFamily;
}

async function persistMaterializedRows(namespaceId: string, rows: readonly MaterializedDiagnosticRow[]): Promise<void> {
  await withClient(async (client) => {
    for (const row of rows) {
      if (row.premiseQuotes.length === 0) continue;
      const sourceRowId = deterministicUuid(`${namespaceId}:materialized:${row.sampleId}:${row.questionIndex}:${row.stateFamily}`);
      const answerValue = valueForMaterializedRow(row);
      await client.query(
        `
          INSERT INTO compiled_fact_observations (
            namespace_id, query_family, predicate_family, property_key, answer_value, normalized_answer_value,
            truth_status, confidence, source_table, source_row_id, support_phrase, source_text, extractor, model_id,
            schema_version, promotion_status, admissibility_status, rejection_reason, metadata
          )
          VALUES (
            $1, 'profile_report', 'materialized_memory_state', $2, $3, $4, $5, $6,
            'namespace_local_offline_substrate', $7::uuid, $8, $9,
            'namespace_local_offline_materialized_v1', 'deterministic_offline_materialized_v1',
            'offline_materialized_memory_state_v1', $10, $11, $12, $13::jsonb
          )
          ON CONFLICT DO NOTHING
        `,
        [
          namespaceId,
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
            diagnosticOrigin: "namespace_local_offline_substrate",
            admissionMode: "source_independent",
            expectedAnswerUsedForPromotion: false,
            stateFamily: row.stateFamily,
            family: row.stateFamily,
            answerShape: row.answerShape,
            queryShape: row.queryShape,
            sourceDerivedFamily: row.sourceDerivedFamily,
            sourceDerivedAnswerValue: row.sourceDerivedAnswerValue,
            evidenceTriggers: row.evidenceTriggers,
            premiseQuotes: row.premiseQuotes,
            sourceSessionKeys: row.sourceSessionKeys,
            sourceCoverageStatus: row.sourceCoverageStatus,
            materializedCoverageStatus: row.materializedCoverageStatus,
            admissionReason: row.admissionReason,
            rejectionReason: row.rejectionReason,
            sampleId: row.sampleId,
            questionIndex: row.questionIndex,
            residualOwner: row.residualOwner,
            mixedOwner: false
          })
        ]
      );
    }
  });
}

async function persistEventRows(namespaceId: string, rows: readonly EventDiagnosticRow[]): Promise<void> {
  await withClient(async (client) => {
    for (const row of rows) {
      if (row.premiseQuotes.length === 0) continue;
      const sourceRowId = deterministicUuid(`${namespaceId}:event:${row.sampleId}:${row.questionIndex}:${row.eventFamily}`);
      const answerValue = valueForEventRow(row);
      await client.query(
        `
          INSERT INTO compiled_fact_observations (
            namespace_id, query_family, predicate_family, property_key, answer_value, normalized_answer_value,
            truth_status, confidence, source_table, source_row_id, support_phrase, source_text, extractor, model_id,
            schema_version, promotion_status, admissibility_status, rejection_reason, metadata
          )
          VALUES (
            $1, 'profile_report', 'event_memory_state', $2, $3, $4, $5, $6,
            'namespace_local_offline_substrate', $7::uuid, $8, $9,
            'namespace_local_event_centric_v1', 'deterministic_event_centric_v1',
            'event_memory_state_v1', $10, $11, $12, $13::jsonb
          )
          ON CONFLICT DO NOTHING
        `,
        [
          namespaceId,
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
            diagnosticOrigin: "namespace_local_offline_substrate",
            admissionMode: "source_independent",
            expectedAnswerUsedForPromotion: false,
            eventFamily: row.eventFamily,
            family: row.eventFamily,
            answerShape: row.answerShape,
            queryShape: row.queryShape,
            sourceDerivedFamily: row.sourceDerivedFamily,
            sourceDerivedAnswerValue: row.sourceDerivedAnswerValue,
            evidenceTriggers: row.evidenceTriggers,
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

async function substratePersistenceSummary(namespaceId: string): Promise<{
  readonly predicateFamily: SubstratePredicateFamily;
  readonly written: number;
  readonly usable: number;
  readonly rejected: number;
  readonly withoutQuote: number;
  readonly expectedAnswerPromotionUse: number;
  readonly missingSourceDerivedMetadata: number;
  readonly sourceIndependent: number;
  readonly mixedOwner: number;
  readonly unknownFamily: number;
  readonly inferredIdentityMembershipFromSupport: number;
}[]> {
  return queryRows(
    `
      SELECT
        predicate_family AS "predicateFamily",
        COUNT(*)::int AS written,
        COUNT(*) FILTER (WHERE promotion_status = 'compiled')::int AS usable,
        COUNT(*) FILTER (WHERE promotion_status = 'rejected')::int AS rejected,
        COUNT(*) FILTER (WHERE NULLIF(support_phrase, '') IS NULL)::int AS "withoutQuote",
        COUNT(*) FILTER (WHERE COALESCE((metadata->>'expectedAnswerUsedForPromotion')::boolean, false) = true)::int AS "expectedAnswerPromotionUse",
        COUNT(*) FILTER (
          WHERE metadata->>'admissionMode' <> 'source_independent'
             OR metadata->>'sourceDerivedFamily' IS NULL
             OR metadata->>'sourceDerivedAnswerValue' IS NULL
             OR metadata->>'queryShape' IS NULL
             OR metadata->'evidenceTriggers' IS NULL
             OR metadata->'premiseQuotes' IS NULL
             OR metadata->'sourceSessionKeys' IS NULL
        )::int AS "missingSourceDerivedMetadata",
        COUNT(*) FILTER (WHERE metadata->>'admissionMode' = 'source_independent')::int AS "sourceIndependent",
        COUNT(*) FILTER (WHERE COALESCE((metadata->>'mixedOwner')::boolean, false) = true)::int AS "mixedOwner",
        COUNT(*) FILTER (
          WHERE (
            predicate_family = 'materialized_memory_state'
            AND metadata->>'stateFamily' NOT IN (
              'family_interest_list', 'family_activity_list', 'recent_creative_work', 'activity_fit_preference',
              'book_reading_list', 'identity_membership_evidence', 'dated_activity_evidence'
            )
          ) OR (
            predicate_family = 'event_memory_state'
            AND metadata->>'eventFamily' NOT IN (
              'causal_reason_event', 'support_reason_event', 'favorite_preference_event', 'explicit_list_event',
              'reading_event', 'family_activity_event', 'creative_activity_event', 'identity_support_event',
              'dated_activity_event', 'interest_evidence_event', 'preference_fit_event'
            )
          )
        )::int AS "unknownFamily",
        COUNT(*) FILTER (WHERE COALESCE((metadata->>'inferredIdentityMembershipFromSupport')::boolean, false) = true)::int AS "inferredIdentityMembershipFromSupport"
      FROM compiled_fact_observations
      WHERE namespace_id = $1
        AND predicate_family IN ('materialized_memory_state', 'event_memory_state')
      GROUP BY predicate_family
    `,
    [namespaceId]
  );
}

async function deleteExistingOfflineSubstrateRows(namespaceId: string): Promise<void> {
  await queryRows(
    `
      DELETE FROM compiled_fact_observations
      WHERE namespace_id = $1
        AND predicate_family IN ('materialized_memory_state', 'event_memory_state')
        AND source_table = 'namespace_local_offline_substrate'
    `,
    [namespaceId]
  );
}

export async function promoteOfflineSubstrateForLoCoMoQuestions(params: {
  readonly namespaceId: string;
  readonly sample: LoCoMoConversationRecord;
  readonly questions: readonly OfflineSubstrateQuestion[];
}): Promise<OfflineSubstratePromotionSummary> {
  const rawRows = params.questions.map((question) => rawDiagnosticFor(params.sample, question));
  const materializedRows = rawRows.map(materializedDiagnosticFor);
  const eventRows = rawRows.map(eventDiagnosticFor);
  await deleteExistingOfflineSubstrateRows(params.namespaceId);
  await persistMaterializedRows(params.namespaceId, materializedRows);
  await persistEventRows(params.namespaceId, eventRows);
  const persisted = await substratePersistenceSummary(params.namespaceId);
  const materialized = persisted.find((row) => row.predicateFamily === "materialized_memory_state");
  const event = persisted.find((row) => row.predicateFamily === "event_memory_state");
  return {
    namespaceId: params.namespaceId,
    sampleId: params.sample.sample_id,
    questionCount: params.questions.length,
    rawRowsAudited: rawRows.length,
    materializedRowsWritten: materialized?.written ?? 0,
    materializedRowsUsable: materialized?.usable ?? 0,
    materializedRowsRejected: materialized?.rejected ?? 0,
    eventRowsWritten: event?.written ?? 0,
    eventRowsUsable: event?.usable ?? 0,
    eventRowsRejected: event?.rejected ?? 0,
    rowsWithoutSourceQuote: (materialized?.withoutQuote ?? 0) + (event?.withoutQuote ?? 0),
    expectedAnswerPromotionUseRows:
      (materialized?.expectedAnswerPromotionUse ?? 0) + (event?.expectedAnswerPromotionUse ?? 0),
    missingSourceDerivedMetadataRows:
      (materialized?.missingSourceDerivedMetadata ?? 0) + (event?.missingSourceDerivedMetadata ?? 0),
    sourceIndependentRows:
      (materialized?.sourceIndependent ?? 0) + (event?.sourceIndependent ?? 0),
    mixedOwnerRows: (materialized?.mixedOwner ?? 0) + (event?.mixedOwner ?? 0),
    unknownFamilyRows: (materialized?.unknownFamily ?? 0) + (event?.unknownFamily ?? 0),
    identityMembershipInferredFromSupportRows:
      (materialized?.inferredIdentityMembershipFromSupport ?? 0) + (event?.inferredIdentityMembershipFromSupport ?? 0),
    sourceCoverageBreakdown: countBy(rawRows, (row) => row.sourceCoverageStatus),
    materializedCoverageBreakdown: countBy(materializedRows, (row) => row.materializedCoverageStatus),
    eventCoverageBreakdown: countBy(eventRows, (row) => row.eventCoverageStatus)
  };
}
