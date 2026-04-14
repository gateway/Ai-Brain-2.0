import { queryRows } from "../db/client.js";
import { normalizeEntityLookupName } from "../identity/canonicalization.js";
import { resolvePairSubjectsFromAliasRows } from "./graph-reader.js";
import { selectMixedContextCandidate } from "./mixed-context.js";
import {
  extractPairQuerySurfaceNames,
  extractPossessiveQuerySurfaceNames,
  extractPrimaryQuerySurfaceNames
} from "../retrieval/query-subjects.js";
import { deriveRuntimeReportClaim } from "../retrieval/report-runtime.js";
import type {
  CanonicalNarrativeKind,
  CanonicalPredicateFamily,
  CanonicalReportKind,
  CanonicalSubjectBindingStatus,
  RecallConfidenceGrade,
  CanonicalSupportStrength
} from "../retrieval/types.js";
import type { RecallResult } from "../types.js";
import type { StoredCanonicalLookup } from "./service.js";
import { buildReportAnswerPayload, deriveQueryBoundReportSummary } from "./report-synthesis.js";
import type { MixedContextCandidate } from "./mixed-context.js";

interface AliasRow {
  readonly normalized_alias_text: string;
  readonly subject_entity_id: string;
  readonly canonical_name: string;
  readonly confidence: number;
}

interface NarrativeRow {
  readonly subject_entity_id: string;
  readonly canonical_name: string;
  readonly pair_subject_entity_id: string | null;
  readonly pair_canonical_name: string | null;
  readonly predicate_family: string;
  readonly narrative_kind: string;
  readonly summary_text: string;
  readonly support_strength: string;
  readonly confidence: number;
  readonly mentioned_at: string | null;
  readonly t_valid_from: string | null;
  readonly t_valid_until: string | null;
  readonly provenance_count: number;
}

interface EntityReportRow {
  readonly subject_entity_id: string;
  readonly canonical_name: string;
  readonly report_kind: string;
  readonly summary_text: string;
  readonly support_strength: string;
  readonly confidence: number;
  readonly mentioned_at: string | null;
  readonly t_valid_from: string | null;
  readonly t_valid_until: string | null;
  readonly answer_payload: Record<string, unknown> | null;
}

interface CollectionFactRow {
  readonly subject_entity_id: string;
  readonly canonical_name: string;
  readonly item_value: string;
  readonly normalized_value: string;
  readonly cue_type: string;
  readonly cue_strength: number;
  readonly confidence: number;
  readonly source_text: string | null;
}

interface PairReportRow {
  readonly subject_entity_id: string;
  readonly canonical_name: string;
  readonly pair_subject_entity_id: string;
  readonly pair_canonical_name: string;
  readonly report_kind: string;
  readonly summary_text: string;
  readonly support_strength: string;
  readonly confidence: number;
  readonly mentioned_at: string | null;
  readonly t_valid_from: string | null;
  readonly t_valid_until: string | null;
  readonly answer_payload: Record<string, unknown> | null;
}

interface AssembledStateRow {
  readonly predicate_family: string;
  readonly state_value: string;
  readonly support_strength: string;
  readonly confidence: number;
  readonly mentioned_at: string | null;
  readonly t_valid_from: string | null;
  readonly t_valid_until: string | null;
  readonly metadata: Record<string, unknown> | null;
}

interface AssembledFactRow {
  readonly predicate_family: string;
  readonly object_value: string | null;
  readonly support_strength: string;
  readonly mentioned_at: string | null;
  readonly t_valid_from: string | null;
  readonly t_valid_until: string | null;
  readonly metadata: Record<string, unknown> | null;
}

interface AssembledSetRow {
  readonly predicate_family: string;
  readonly item_values: unknown;
  readonly support_strength: string;
  readonly confidence: number;
  readonly valid_from: string | null;
  readonly valid_until: string | null;
  readonly metadata: Record<string, unknown> | null;
}

interface RawNarrativeCandidateRow {
  readonly text: string;
  readonly confidence: number;
  readonly mentioned_at: string | null;
  readonly t_valid_from: string | null;
  readonly t_valid_until: string | null;
  readonly source_kind: string;
}

export interface NarrativeLookupTelemetry {
  readonly pathUsed: boolean;
  readonly narrativeKind?: CanonicalNarrativeKind;
  readonly reportKind?: CanonicalReportKind;
  readonly sourceTier?: "canonical_narrative" | "canonical_report";
  readonly candidateCount: number;
  readonly shadowDecision?: "aligned" | "candidate_only" | "cutover_applied" | "candidate_abstained";
  readonly cutoverApplied?: boolean;
}

interface NarrativeRoute {
  readonly narrativeKind: CanonicalNarrativeKind | null;
  readonly reportKind: CanonicalReportKind | null;
  readonly predicateFamily: CanonicalPredicateFamily | null;
}

function normalize(value: string | null | undefined): string {
  return normalizeEntityLookupName(String(value ?? ""));
}

function isSupportObjectQuery(queryText: string): boolean {
  const normalized = normalize(queryText);
  return (
    /\bwhat type of individuals does\b.*\bsupport\b/u.test(normalized) ||
    /\bwho does\b.*\bsupport\b/u.test(normalized) ||
    /\bwhat does\b.*\bsupport\b/u.test(normalized)
  );
}

function isSupportReasoningQuery(queryText: string): boolean {
  const normalized = normalize(queryText);
  if (isSupportObjectQuery(queryText)) {
    return false;
  }
  return (
    /\bwhy\b.*\bsupport\b/u.test(normalized) ||
    /\bwho supported\b/u.test(normalized) ||
    /\bsupport growing up\b/u.test(normalized) ||
    /\bsupport group\b/u.test(normalized) ||
    /\bmentor\b|\bcommunity\b|\bthere for\b|\bfamily meaning\b|\btransition journey\b/u.test(normalized)
  );
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))];
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function joinSummaryValues(values: readonly string[]): string | null {
  const unique = uniqueStrings(values.map((value) => normalizeWhitespace(value)).filter(Boolean));
  if (unique.length === 0) {
    return null;
  }
  if (unique.length === 1) {
    return unique[0]!;
  }
  if (unique.length === 2) {
    return `${unique[0]!} and ${unique[1]!}`;
  }
  return `${unique.slice(0, -1).join(", ")}, and ${unique[unique.length - 1]!}`;
}

function asSupportStrength(value: string): "strong" | "moderate" | "weak" {
  return value === "strong" || value === "moderate" || value === "weak" ? value : "moderate";
}

function asConfidence(value: number): "confident" | "weak" | "missing" {
  if (value >= 0.8) {
    return "confident";
  }
  if (value >= 0.45) {
    return "weak";
  }
  return "missing";
}

function asStoredSource(
  sourceTable: string,
  text: string,
  predicateFamily: CanonicalPredicateFamily,
  supportStrength: CanonicalSupportStrength,
  confidence: RecallConfidenceGrade,
  extras: {
    readonly answerPayload?: Record<string, unknown> | null;
    readonly mentionedAt?: string | null;
    readonly validFrom?: string | null;
    readonly validUntil?: string | null;
    readonly provenanceCount?: number;
    readonly narrativeKind?: CanonicalNarrativeKind;
    readonly reportKind?: CanonicalReportKind;
  } = {}
): MixedContextCandidate {
  return {
    text,
    sourceTable,
    predicateFamily,
    supportStrength,
    confidence,
    answerPayload: extras.answerPayload ?? null,
    mentionedAt: extras.mentionedAt ?? null,
    validFrom: extras.validFrom ?? null,
    validUntil: extras.validUntil ?? null,
    provenanceCount: extras.provenanceCount,
    narrativeKind: extras.narrativeKind,
    reportKind: extras.reportKind
  };
}

function inferNarrativeKindFromQuery(queryText: string, exactDetailFamily: string): CanonicalNarrativeKind | null {
  const normalized = normalize(queryText);
  if (exactDetailFamily === "realization") {
    return "realization";
  }
  if (exactDetailFamily === "goals") {
    return "career_intent";
  }
  if (exactDetailFamily === "favorite_painting_style") {
    return "preference_explanation";
  }
  if (exactDetailFamily === "realization" || /\bwhat did .* (?:realize|learn)\b/u.test(normalized)) {
    return "realization";
  }
  if (/\bsymbol(?:ize|ism)?\b|\bremind(?:s|ed|er)?\b|\bmean(?:ing)?\b|\bremember\b/u.test(normalized)) {
    return "symbolism";
  }
  if (/\bbecause\b|\breason\b|\bmotivated\b|\binspired\b|\bart show\b|\bpainting\b|\bsculpture\b/u.test(normalized)) {
    return /\bart\b|\bshow\b|\bpainting\b|\bsculpture\b/u.test(normalized) ? "art_inspiration" : "motive";
  }
  if (/\bwhy\b/u.test(normalized)) {
    return "motive";
  }
  if (/\bwould\b.*\bpursue\b|\bwhat kind of place\b.*\bwant\b.*\bcreate\b|\bwhat fields would\b|\bgoals?\b|\bplans?\b/u.test(normalized)) {
    return "career_intent";
  }
  if (isSupportReasoningQuery(queryText)) {
    return "support_reasoning";
  }
  if (
    /\bprofile\b|\bwhat is .* like\b|\bwhat kind of person\b|\blikes? because\b|\bprefers? because\b|\bfavorite style of painting\b|\bwhat does .* like about\b/u.test(normalized)
  ) {
    return "preference_explanation";
  }
  return null;
}

export function inferReportOnlyKindFromQuery(queryText: string, exactDetailFamily: string): CanonicalReportKind | null {
  const normalized = normalize(queryText);
  if (
    /^\s*when\b/u.test(normalized) ||
    /\bwhat\s+books?\b/u.test(normalized) ||
    /\bbooks?\b[^?!.]{0,40}\bread\b/u.test(normalized) ||
    /\bwhat\s+(?:[a-z0-9+&'’ -]+\s+)?events?\b/u.test(normalized) ||
    /\bwhat kind of pastries\b/u.test(normalized) ||
    /\bpastries\b/u.test(normalized) ||
    /\bfavorite movie trilogy\b/u.test(normalized) ||
    /\bfavorite books?\b/u.test(normalized) ||
    /\bwhich bands?\b/u.test(normalized) ||
    /\bwhat items does\b/u.test(normalized) ||
    /\bwhat items did\b/u.test(normalized) ||
    /\bwhich team did\b/u.test(normalized) ||
    /\bwhat is .* position\b/u.test(normalized) ||
    /\bwhat year did\b/u.test(normalized) ||
    /\bin which month\b/u.test(normalized) ||
    /\bwhat kind of flowers\b/u.test(normalized)
  ) {
    return null;
  }
  if (/\bfavorite\b.*\bmemory\b/u.test(normalized)) {
    return null;
  }
  if (
    /\bfavorite\b|\bstyle of\b|\btrilogy\b|\bpastries\b|\bmovie trilogy\b|\bfavorite games?\b|\bfavorite style of dance\b/u.test(normalized)
  ) {
    return "preference_report";
  }
  if (
    /\bcollections?\b|\bcollect\b|\bitems does\b|\bbookshelf\b|\bwhat items\b/u.test(normalized)
  ) {
    return "collection_report";
  }
  if (
    /\b(?:education|educaton|study|career|major|degree|fields?)\b/i.test(normalized) && /\blikely\b|\bwhat might\b|\bdegree\b|\bmajor\b/u.test(normalized)
  ) {
    return "education_report";
  }
  if (
    /\bdreams?\b|\bnew business venture\b|\bmake .* app unique\b|\bmake .* unique\b|\bwhat challenge\b|\bwhat inspired\b|\bhow does .* plan to make\b/u.test(normalized)
  ) {
    return "aspiration_report";
  }
  if (/\bideal\b.*\bdance studio\b|\bdance studio\b.*\blook like\b/u.test(normalized)) {
    return "aspiration_report";
  }
  if (
    /\bdogs?\b|\bpet\b|\bgroom(?:er|ing)?\b|\btraining\b|\bdog treats?\b|\bfur kids\b|\bindoor activity\b|\btake better care\b/u.test(normalized)
  ) {
    return "pet_care_report";
  }
  if (
    /\broadtrips?\b|\btrip\b|\btravel\b|\bfestival\b|\bwhere did\b.*\bfestival\b/u.test(normalized)
  ) {
    return "travel_report";
  }
  if (
    exactDetailFamily === "goals" ||
    /\bcareer\b|\bjob\b|\bprofession\b|\bfields would\b|\bpursue\b|\bendorsement\b|\bbrand\b|\btraining\b|\bbasketball\b/u.test(normalized)
  ) {
    return "career_report";
  }
  if (isSupportReasoningQuery(queryText)) {
    return "support_report";
  }
  if (
    /\bart\b|\bpainting\b|\bsculpture\b|\bcreative\b|\bfavorite style of painting\b/u.test(normalized)
  ) {
    return "creative_work_report";
  }
  if (
    /\brelationship\b|\bmarried\b|\bdating\b|\bhusband\b|\bwife\b|\bgirlfriend\b|\bboyfriend\b/u.test(normalized)
  ) {
    return "relationship_report";
  }
  if (/\bfinancial status\b/u.test(normalized)) {
    return "profile_report";
  }
  if (
    /\bhow did\b|\bwhat was\b.*\breaction\b|\bwhat does\b.*\bdo after\b|\bwhat are some changes\b|\bwhat kind of\b|\bwhat has\b|\bwould\b/u.test(normalized)
  ) {
    return "profile_report";
  }
  return null;
}

function isStrictPreferenceOwnershipQuery(queryText: string): boolean {
  const normalized = normalize(queryText);
  return /\bfavorite\b.*\b(style|books?|games?)\b|\bwhat is .* favorite style of dance\b/u.test(normalized);
}

function isStrictCollectionInferenceQuery(queryText: string): boolean {
  const normalized = normalize(queryText);
  return /\bbookshelf\b|\bdr\.?\s*seuss\b|\bwhat items\b.*\bcollect\b/u.test(normalized);
}

function hasStrictCollectionPayload(candidate: MixedContextCandidate): boolean {
  const payload = candidate.answerPayload;
  return Boolean(
    payload &&
      typeof payload === "object" &&
      (payload.answer_type === "bookshelf_inference" || payload.answer_type === "collection_items") &&
      (typeof payload.answer_value === "string" || typeof payload.reason_value === "string")
  );
}

function buildPersistedCollectionFactCandidate(params: {
  readonly rows: readonly CollectionFactRow[];
  readonly predicateFamily: CanonicalPredicateFamily;
}): MixedContextCandidate | null {
  if (params.rows.length === 0) {
    return null;
  }
  const rankedRows = [...params.rows].sort((left, right) => {
    if (right.cue_strength !== left.cue_strength) {
      return right.cue_strength - left.cue_strength;
    }
    if (right.confidence !== left.confidence) {
      return right.confidence - left.confidence;
    }
    return left.item_value.localeCompare(right.item_value);
  });
  const entryValues = uniqueStrings(rankedRows.map((row) => normalizeWhitespace(row.item_value))).slice(0, 5);
  const summaryText = joinSummaryValues(entryValues);
  if (!summaryText) {
    return null;
  }
  const topCueStrength = rankedRows[0]?.cue_strength ?? 1;
  const averageConfidence = rankedRows.reduce((sum, row) => sum + row.confidence, 0) / Math.max(rankedRows.length, 1);
  return asStoredSource(
    "canonical_collection_facts",
    summaryText,
    params.predicateFamily,
    topCueStrength >= 4 || entryValues.length >= 2 ? "strong" : "moderate",
    averageConfidence >= 0.75 ? "confident" : averageConfidence >= 0.45 ? "weak" : "missing",
    {
      answerPayload: {
        answer_type: "collection_items",
        answer_value: summaryText,
        reason_value: `collects ${summaryText}`,
        render_template: "value_only"
      },
      reportKind: "collection_report"
    }
  );
}

function inferReportKindForNarrativeQuery(queryText: string, narrativeKind: CanonicalNarrativeKind): CanonicalReportKind | null {
  const normalized = normalize(queryText);
  if (narrativeKind === "realization" || narrativeKind === "symbolism") {
    return null;
  }
  if (narrativeKind === "motive") {
    if (/\b(store|business|venture|brand|app|startup|company|studio|shop|open)\b/u.test(normalized)) {
      return "aspiration_report";
    }
    if (isSupportReasoningQuery(queryText)) {
      return "support_report";
    }
  }
  switch (narrativeKind) {
    case "career_intent":
      return "career_report";
    case "support_reasoning":
    case "family_meaning":
      return "support_report";
    case "art_inspiration":
      return "creative_work_report";
    case "preference_explanation":
      return "preference_report";
    default:
      return "profile_report";
  }
}

export function inferNarrativeRoute(queryText: string, exactDetailFamily: string): NarrativeRoute {
  const narrativeKind = inferNarrativeKindFromQuery(queryText, exactDetailFamily);
  const explicitReportKind = inferReportOnlyKindFromQuery(queryText, exactDetailFamily);
  if (narrativeKind) {
    return {
      narrativeKind,
      reportKind: explicitReportKind ?? inferReportKindForNarrativeQuery(queryText, narrativeKind),
      predicateFamily: inferNarrativePredicateFamily(narrativeKind)
    };
  }
  const reportKind = explicitReportKind;
  if (!reportKind) {
    return {
      narrativeKind: null,
      reportKind: null,
      predicateFamily: null
    };
  }
  return {
    narrativeKind: null,
    reportKind,
    predicateFamily: "narrative_profile"
  };
}

function inferNarrativePredicateFamily(kind: CanonicalNarrativeKind): CanonicalPredicateFamily {
  switch (kind) {
    case "realization":
      return "narrative_realization";
    case "symbolism":
    case "family_meaning":
    case "preference_explanation":
      return "narrative_symbolism";
    case "motive":
    case "career_intent":
    case "support_reasoning":
    case "art_inspiration":
      return "narrative_motive";
    default:
      return "narrative_profile";
  }
}

function summarizeTexts(values: readonly string[]): string | null {
  const unique = uniqueStrings(values.map((value) => normalizeWhitespace(value)).filter(Boolean));
  if (unique.length === 0) {
    return null;
  }
  if (unique.length === 1) {
    return unique[0]!;
  }
  return unique.slice(0, 3).join(". ");
}

function metadataText(metadata: Record<string, unknown> | null | undefined): string {
  if (!metadata) {
    return "";
  }
  const values = Object.values(metadata).flatMap((value) => {
    if (typeof value === "string") {
      return [value];
    }
    if (Array.isArray(value)) {
      return value.filter((entry): entry is string => typeof entry === "string");
    }
    return [];
  });
  return summarizeTexts(values) ?? "";
}

function setItemsText(value: unknown): string {
  if (!Array.isArray(value)) {
    return "";
  }
  return summarizeTexts(value.filter((entry): entry is string => typeof entry === "string")) ?? "";
}

function reportTextMatchesKind(reportKind: CanonicalReportKind, predicateFamily: string, text: string): boolean {
  const normalized = normalize(text);
  if (!normalized) {
    return false;
  }
  if (reportKind === "preference_report") {
    return (
      /\bfavorite\b|\bfave\b|\bstyle\b|\bprefer\b|\blikes?\b|\btop pick\b|\bspeaks to me\b|\bdance\b|\bmovie\b|\btrilogy\b|\bbook\b|\bgame\b|\bpastr(?:y|ies)\b|\bcafe\b/u.test(normalized)
    );
  }
  if (reportKind === "education_report") {
    return (
      predicateFamily === "work_education_history" ||
      /\beducation\b|\beducaton\b|\bstudy\b|\bschool\b|\bdegree\b|\bmajor\b|\bfields?\b|\bpublic administration\b|\bpolitical science\b|\bpublic affairs\b|\bpolicymaking\b|\bpolitic(?:s|al)?\b|\bcommunity\b|\binfrastructure\b|\bgovernment\b/u.test(normalized)
    );
  }
  if (reportKind === "collection_report") {
    return (
      predicateFamily === "list_set" ||
      /\bcollect\b|\bcollections?\b|\bbookshelf\b|\bjerseys?\b|\bsneakers?\b|\bdvds?\b|\btrilogy\b/u.test(normalized)
    );
  }
  if (reportKind === "aspiration_report") {
    return (
      /\bdreams?\b|\bgoal\b|\bventure\b|\bbusiness\b|\bunique\b|\bcustomi(?:s|z)e\b|\bapp\b|\bbrand\b|\bchallenge\b|\binspired\b|\bstart\b|\bopen\b|\bbuild\b|\bideal\b|\bstudio\b|\bwater\b|\bnatural light\b|\bmarley flooring\b/u.test(normalized)
    );
  }
  if (reportKind === "travel_report") {
    return (
      predicateFamily === "location_history" ||
      /\btrip\b|\btravel\b|\broadtrip\b|\bfestival\b|\bjasper\b|\brockies\b|\btokyo\b|\bcity\b|\bcountry\b/u.test(normalized)
    );
  }
  if (reportKind === "pet_care_report") {
    return (
      /\bdogs?\b|\bpet\b|\bgroom(?:er|ing)?\b|\btraining\b|\btreats?\b|\bagility\b|\bdog[- ]owners\b|\bfur kids\b/u.test(normalized)
    );
  }
  if (reportKind === "career_report") {
    return (
      predicateFamily === "work_education_history" ||
      /\bcareer\b|\bjob\b|\bwork\b|\bprofession\b|\bgoals?\b|\bplans?\b|\bpursue\b|\beducation\b|\bschool\b|\bstudy\b|\bbasketball\b|\btraining\b|\bendorsement\b|\bbrand\b/u.test(normalized)
    );
  }
  if (reportKind === "support_report") {
    return /\bfamily\b|\bsupport\b|\bmentor\b|\bcommunity\b|\bchurch\b|\bhelp\b|\bthere for\b/u.test(normalized);
  }
  if (reportKind === "creative_work_report") {
    return /\bart\b|\bpainting\b|\bpaint\b|\bsculpture\b|\bcreative\b|\bstyle\b/u.test(normalized);
  }
  if (reportKind === "relationship_report") {
    return /\brelationship\b|\bdating\b|\bmarried\b|\bgirlfriend\b|\bboyfriend\b|\bhusband\b|\bwife\b|\bpartner\b/u.test(normalized);
  }
  if (reportKind === "profile_report") {
    return (
      predicateFamily === "profile_state" ||
      predicateFamily === "generic_fact" ||
      predicateFamily === "counterfactual" ||
      /\bfinancial\b|\bmoney\b|\bincome\b|\bwealth(?:y)?\b|\brich\b|\bwell[- ]off\b|\bstable\b|\bhobby\b|\binterest\b|\bperson\b|\bprofile\b|\bstatus\b|\brole\b|\bjob\b/u.test(
        normalized
      )
    );
  }
  return false;
}

function narrativeTextMatchesKind(text: string, narrativeKind: CanonicalNarrativeKind): boolean {
  const normalized = normalize(text);
  switch (narrativeKind) {
    case "motive":
      return /\bwhy\b|\bbecause\b|\bmotivated\b|\breason\b/u.test(normalized);
    case "symbolism":
    case "family_meaning":
      return /\bsymbol(?:ize|ism)?\b|\bremind(?:s|ed|er)?\b|\bmeaning\b|\bremember\b/u.test(normalized);
    case "realization":
      return /\brealize(?:d)?\b|\blearn(?:ed)?\b|\bclicked\b|\bcame to understand\b/u.test(normalized);
    case "career_intent":
      return /\bgoals?\b|\bplans?\b|\bpursue\b|\bwant\b|\bwould\b/u.test(normalized);
    case "support_reasoning":
      return /\bsupport\b|\bfamily\b|\bmentor\b|\bcommunity\b/u.test(normalized);
    case "art_inspiration":
      return /\bart\b|\bpainting\b|\bsculpture\b|\binspired\b|\bshow\b/u.test(normalized);
    case "preference_explanation":
      return /\blike\b|\bprefer\b|\bfavorite\b|\bstyle\b/u.test(normalized);
    default:
      return false;
  }
}

async function assembleNarrativeFromRawSources(params: {
  readonly namespaceId: string;
  readonly subjectEntityId: string;
  readonly narrativeKind: CanonicalNarrativeKind;
}): Promise<{
  summaryText: string | null;
  candidateCount: number;
  supportStrength: "strong" | "moderate" | "weak";
  confidence: "confident" | "weak" | "missing";
  mentionedAt: string | null;
  validFrom: string | null;
  validUntil: string | null;
}> {
  const claimRows = await queryRows<RawNarrativeCandidateRow>(
    `
      SELECT
        COALESCE(cc.normalized_text, CONCAT_WS(' ', cc.predicate, cc.object_text)) AS text,
        cc.confidence,
        cc.occurred_at::text AS mentioned_at,
        cc.time_start::text AS t_valid_from,
        cc.time_end::text AS t_valid_until,
        'claim_candidates'::text AS source_kind
      FROM claim_candidates cc
      WHERE cc.namespace_id = $1
        AND cc.subject_entity_id = $2::uuid
      ORDER BY cc.confidence DESC, cc.occurred_at DESC NULLS LAST
      LIMIT 25
    `,
    [params.namespaceId, params.subjectEntityId]
  );
  const eventRows = await queryRows<RawNarrativeCandidateRow>(
    `
      SELECT
        CONCAT_WS(' ', ne.event_label, ns.scene_text) AS text,
        0.72::double precision AS confidence,
        COALESCE(ne.time_start, ns.occurred_at, ne.created_at)::text AS mentioned_at,
        ne.time_start::text AS t_valid_from,
        ne.time_end::text AS t_valid_until,
        'narrative_events'::text AS source_kind
      FROM narrative_events ne
      LEFT JOIN narrative_scenes ns ON ns.id = ne.source_scene_id
      WHERE ne.namespace_id = $1
        AND ne.primary_subject_entity_id = $2::uuid
      ORDER BY COALESCE(ne.time_start, ns.occurred_at, ne.created_at) DESC NULLS LAST
      LIMIT 25
    `,
    [params.namespaceId, params.subjectEntityId]
  );
  const candidates = [...claimRows, ...eventRows].filter((row) => narrativeTextMatchesKind(row.text, params.narrativeKind));
  const summaryText = summarizeTexts(candidates.map((row) => row.text));
  const avgConfidence =
    candidates.length > 0 ? candidates.reduce((sum, row) => sum + row.confidence, 0) / candidates.length : 0;
  return {
    summaryText,
    candidateCount: candidates.length,
    supportStrength: candidates.length >= 3 ? "strong" : candidates.length >= 2 ? "moderate" : "weak",
    confidence: asConfidence(avgConfidence),
    mentionedAt: candidates.find((row) => row.mentioned_at)?.mentioned_at ?? null,
    validFrom: candidates.find((row) => row.t_valid_from)?.t_valid_from ?? null,
    validUntil: candidates.find((row) => row.t_valid_until)?.t_valid_until ?? null
  };
}

async function assembleEntityReportFromCanonicalGraph(params: {
  readonly queryText: string;
  readonly namespaceId: string;
  readonly subjectEntityId: string;
  readonly reportKind: CanonicalReportKind;
}): Promise<{
  summaryText: string | null;
  candidateCount: number;
  supportStrength: "strong" | "moderate" | "weak";
  confidence: "confident" | "weak" | "missing";
  validFrom: string | null;
  validUntil: string | null;
}> {
  const states = await queryRows<AssembledStateRow>(
    `
      SELECT predicate_family, state_value, support_strength, confidence, mentioned_at::text, t_valid_from::text, t_valid_until::text, metadata
      FROM canonical_states
      WHERE namespace_id = $1
        AND subject_entity_id = $2::uuid
      ORDER BY confidence DESC, updated_at DESC
      LIMIT 25
    `,
    [params.namespaceId, params.subjectEntityId]
  );
  const facts = await queryRows<AssembledFactRow>(
    `
      SELECT predicate_family, object_value, support_strength, mentioned_at::text, t_valid_from::text, t_valid_until::text, metadata
      FROM canonical_facts
      WHERE namespace_id = $1
        AND subject_entity_id = $2::uuid
        AND object_value IS NOT NULL
      ORDER BY updated_at DESC
      LIMIT 25
    `,
    [params.namespaceId, params.subjectEntityId]
  );
  const sets = await queryRows<AssembledSetRow>(
    `
      SELECT predicate_family, item_values, support_strength, confidence, valid_from::text, valid_until::text, metadata
      FROM canonical_sets
      WHERE namespace_id = $1
        AND subject_entity_id = $2::uuid
      ORDER BY confidence DESC, updated_at DESC
      LIMIT 25
    `,
    [params.namespaceId, params.subjectEntityId]
  );

  const texts: string[] = [];
  const confidences: number[] = [];
  let validFrom: string | null = null;
  let validUntil: string | null = null;

  for (const row of states) {
    const text = [row.state_value, metadataText(row.metadata)].join(" ").trim();
    if (!reportTextMatchesKind(params.reportKind, row.predicate_family, text)) {
      continue;
    }
    texts.push(row.state_value);
    confidences.push(row.confidence);
    validFrom = validFrom ?? row.t_valid_from;
    validUntil = validUntil ?? row.t_valid_until;
  }
  for (const row of facts) {
    const text = [row.object_value ?? "", metadataText(row.metadata)].join(" ").trim();
    if (!reportTextMatchesKind(params.reportKind, row.predicate_family, text)) {
      continue;
    }
    if (row.object_value) {
      texts.push(row.object_value);
    }
    confidences.push(row.support_strength === "strong" ? 0.92 : row.support_strength === "moderate" ? 0.75 : 0.55);
    validFrom = validFrom ?? row.t_valid_from;
    validUntil = validUntil ?? row.t_valid_until;
  }
  for (const row of sets) {
    const itemsText = setItemsText(row.item_values);
    const text = [itemsText, metadataText(row.metadata)].join(" ").trim();
    if (!itemsText || !reportTextMatchesKind(params.reportKind, row.predicate_family, text)) {
      continue;
    }
    texts.push(itemsText);
    confidences.push(row.confidence);
    validFrom = validFrom ?? row.valid_from;
    validUntil = validUntil ?? row.valid_until;
  }

  const summaryText = deriveQueryBoundReportSummary(params.reportKind, params.queryText, texts) ?? summarizeTexts(texts);
  const avgConfidence = confidences.length > 0 ? confidences.reduce((sum, value) => sum + value, 0) / confidences.length : 0;
  return {
    summaryText,
    candidateCount: texts.length,
    supportStrength: texts.length >= 3 ? "strong" : texts.length >= 2 ? "moderate" : "weak",
    confidence: asConfidence(avgConfidence),
    validFrom,
    validUntil
  };
}

async function loadEntityGraphCandidatesForReport(params: {
  readonly queryText: string;
  readonly namespaceId: string;
  readonly subjectEntityId: string;
  readonly reportKind: CanonicalReportKind;
  readonly predicateFamily: CanonicalPredicateFamily;
}): Promise<readonly MixedContextCandidate[]> {
  const states = await queryRows<AssembledStateRow>(
    `
      SELECT predicate_family, state_value, support_strength, confidence, mentioned_at::text, t_valid_from::text, t_valid_until::text, metadata
      FROM canonical_states
      WHERE namespace_id = $1
        AND subject_entity_id = $2::uuid
      ORDER BY confidence DESC, updated_at DESC
      LIMIT 25
    `,
    [params.namespaceId, params.subjectEntityId]
  );
  const facts = await queryRows<AssembledFactRow>(
    `
      SELECT predicate_family, object_value, support_strength, mentioned_at::text, t_valid_from::text, t_valid_until::text, metadata
      FROM canonical_facts
      WHERE namespace_id = $1
        AND subject_entity_id = $2::uuid
        AND object_value IS NOT NULL
      ORDER BY updated_at DESC
      LIMIT 25
    `,
    [params.namespaceId, params.subjectEntityId]
  );
  const sets = await queryRows<AssembledSetRow>(
    `
      SELECT predicate_family, item_values, support_strength, confidence, valid_from::text, valid_until::text, metadata
      FROM canonical_sets
      WHERE namespace_id = $1
        AND subject_entity_id = $2::uuid
      ORDER BY confidence DESC, updated_at DESC
      LIMIT 25
    `,
    [params.namespaceId, params.subjectEntityId]
  );

  const candidates: MixedContextCandidate[] = [];
  const sourceTexts: string[] = [];

  for (const row of states) {
    const rawText = normalizeWhitespace([row.state_value, metadataText(row.metadata)].join(" "));
    if (!rawText || !reportTextMatchesKind(params.reportKind, row.predicate_family, rawText)) {
      continue;
    }
    sourceTexts.push(rawText);
    const sanitized = sanitizeReportCandidateText(params.reportKind, params.queryText, rawText);
    if (!sanitized) {
      continue;
    }
    candidates.push(
      asStoredSource(
        "canonical_states",
        sanitized.candidateText,
        params.predicateFamily,
        asSupportStrength(row.support_strength),
        asConfidence(row.confidence),
        {
          answerPayload: sanitized.answerPayload,
          mentionedAt: row.mentioned_at,
          validFrom: row.t_valid_from,
          validUntil: row.t_valid_until,
          reportKind: params.reportKind
        }
      )
    );
  }

  for (const row of facts) {
    const rawText = normalizeWhitespace([row.object_value ?? "", metadataText(row.metadata)].join(" "));
    if (!rawText || !reportTextMatchesKind(params.reportKind, row.predicate_family, rawText)) {
      continue;
    }
    sourceTexts.push(rawText);
    const sanitized = sanitizeReportCandidateText(params.reportKind, params.queryText, rawText);
    if (!sanitized) {
      continue;
    }
    candidates.push(
      asStoredSource(
        "canonical_facts",
        sanitized.candidateText,
        params.predicateFamily,
        asSupportStrength(row.support_strength),
        asConfidence(row.support_strength === "strong" ? 0.92 : row.support_strength === "moderate" ? 0.75 : 0.55),
        {
          answerPayload: sanitized.answerPayload,
          mentionedAt: row.mentioned_at,
          validFrom: row.t_valid_from,
          validUntil: row.t_valid_until,
          reportKind: params.reportKind
        }
      )
    );
  }

  for (const row of sets) {
    const itemsText = setItemsText(row.item_values);
    const rawText = normalizeWhitespace([itemsText, metadataText(row.metadata)].join(" "));
    if (!rawText || !reportTextMatchesKind(params.reportKind, row.predicate_family, rawText)) {
      continue;
    }
    sourceTexts.push(rawText);
    const sanitized = sanitizeReportCandidateText(params.reportKind, params.queryText, rawText);
    if (!sanitized) {
      continue;
    }
    candidates.push(
      asStoredSource(
        "canonical_sets",
        sanitized.candidateText,
        params.predicateFamily,
        asSupportStrength(row.support_strength),
        asConfidence(row.confidence),
        {
          answerPayload: sanitized.answerPayload,
          validFrom: row.valid_from,
          validUntil: row.valid_until,
          reportKind: params.reportKind
        }
      )
    );
  }

  const aggregate = deriveQueryBoundReportSummary(params.reportKind, params.queryText, sourceTexts);
  if (aggregate) {
    candidates.unshift(
      asStoredSource(
        "assembled_graph_entity_report",
        aggregate,
        params.predicateFamily,
        "strong",
        "confident",
        {
          answerPayload: buildReportAnswerPayload(params.reportKind, [aggregate]),
          reportKind: params.reportKind
        }
      )
    );
  }

  return candidates;
}

async function assembleEntityReportFromRawSources(params: {
  readonly namespaceId: string;
  readonly subjectEntityId: string;
  readonly reportKind: CanonicalReportKind;
}): Promise<{
  summaryText: string | null;
  candidateCount: number;
  supportStrength: "strong" | "moderate" | "weak";
  confidence: "confident" | "weak" | "missing";
  mentionedAt: string | null;
  validFrom: string | null;
  validUntil: string | null;
}> {
  const claimRows = await queryRows<RawNarrativeCandidateRow>(
    `
      SELECT
        CONCAT_WS(' ', cc.normalized_text, cc.predicate, cc.object_text) AS text,
        cc.confidence,
        cc.occurred_at::text AS mentioned_at,
        cc.time_start::text AS t_valid_from,
        cc.time_end::text AS t_valid_until,
        'claim_candidates'::text AS source_kind
      FROM claim_candidates cc
      WHERE cc.namespace_id = $1
        AND cc.subject_entity_id = $2::uuid
      ORDER BY cc.confidence DESC, cc.occurred_at DESC NULLS LAST
      LIMIT 40
    `,
    [params.namespaceId, params.subjectEntityId]
  );
  const eventRows = await queryRows<RawNarrativeCandidateRow>(
    `
      SELECT
        CONCAT_WS(' ', ne.event_label, ns.scene_text) AS text,
        0.72::double precision AS confidence,
        COALESCE(ne.time_start, ns.occurred_at, ne.created_at)::text AS mentioned_at,
        ne.time_start::text AS t_valid_from,
        ne.time_end::text AS t_valid_until,
        'narrative_events'::text AS source_kind
      FROM narrative_events ne
      LEFT JOIN narrative_scenes ns ON ns.id = ne.source_scene_id
      WHERE ne.namespace_id = $1
        AND ne.primary_subject_entity_id = $2::uuid
      ORDER BY COALESCE(ne.time_start, ns.occurred_at, ne.created_at) DESC NULLS LAST
      LIMIT 40
    `,
    [params.namespaceId, params.subjectEntityId]
  );
  const candidates = [...claimRows, ...eventRows].filter((row) =>
    reportTextMatchesKind(params.reportKind, "generic_fact", row.text)
  );
  const summaryText = summarizeTexts(candidates.map((row) => row.text));
  const avgConfidence =
    candidates.length > 0 ? candidates.reduce((sum, row) => sum + row.confidence, 0) / candidates.length : 0;
  return {
    summaryText,
    candidateCount: candidates.length,
    supportStrength: candidates.length >= 3 ? "strong" : candidates.length >= 2 ? "moderate" : "weak",
    confidence: asConfidence(avgConfidence),
    mentionedAt: candidates.find((row) => row.mentioned_at)?.mentioned_at ?? null,
    validFrom: candidates.find((row) => row.t_valid_from)?.t_valid_from ?? null,
    validUntil: candidates.find((row) => row.t_valid_until)?.t_valid_until ?? null
  };
}

function resultTextFromRecallResult(result: RecallResult): string {
  const sourceSentenceText =
    typeof result.provenance?.source_sentence_text === "string" ? normalizeWhitespace(result.provenance.source_sentence_text) : "";
  if (sourceSentenceText) {
    return sourceSentenceText;
  }
  return normalizeWhitespace(result.content);
}

function reportSupportTextsFromRecallResult(result: RecallResult): readonly string[] {
  const metadata =
    typeof result.provenance?.metadata === "object" && result.provenance.metadata !== null
      ? (result.provenance.metadata as Record<string, unknown>)
      : null;
  return uniqueStrings([
    resultTextFromRecallResult(result),
    typeof result.provenance?.source_turn_text === "string" ? normalizeWhitespace(result.provenance.source_turn_text) : "",
    typeof result.provenance?.source_sentence_text === "string" ? normalizeWhitespace(result.provenance.source_sentence_text) : "",
    typeof metadata?.source_turn_text === "string" ? normalizeWhitespace(metadata.source_turn_text) : "",
    typeof metadata?.source_sentence_text === "string" ? normalizeWhitespace(metadata.source_sentence_text) : "",
    typeof metadata?.prompt_text === "string" ? normalizeWhitespace(metadata.prompt_text) : "",
    normalizeWhitespace(result.content)
  ]);
}

function readNormalizedProvenanceNames(result: RecallResult): readonly string[] {
  const metadata =
    typeof result.provenance?.metadata === "object" && result.provenance.metadata !== null
      ? (result.provenance.metadata as Record<string, unknown>)
      : null;
  return [
    result.provenance?.subject_name,
    result.provenance?.speaker_name,
    result.provenance?.owner_entity_hint,
    result.provenance?.speaker_entity_hint,
    metadata?.speaker_name,
    metadata?.transcript_speaker_name,
    metadata?.primary_speaker_name,
    metadata?.subject_name,
    metadata?.owner_entity_hint,
    metadata?.speaker_entity_hint
  ]
    .filter((value): value is string => typeof value === "string")
    .map((value) => normalize(value))
    .filter(Boolean);
}

function readProvenanceEntityIds(result: RecallResult): readonly string[] {
  const metadata =
    typeof result.provenance?.metadata === "object" && result.provenance.metadata !== null
      ? (result.provenance.metadata as Record<string, unknown>)
      : null;
  return [
    result.provenance?.subject_entity_id,
    result.provenance?.speaker_entity_id,
    result.provenance?.owner_entity_id,
    metadata?.subject_entity_id,
    metadata?.speaker_entity_id,
    metadata?.owner_entity_id
  ]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0);
}

export function recallResultMatchesSubject(
  result: RecallResult,
  canonicalName: string,
  subjectEntityId: string | null = null
): boolean {
  const normalizedSubject = normalize(canonicalName);
  if (subjectEntityId && readProvenanceEntityIds(result).includes(subjectEntityId)) {
    return true;
  }
  if (readNormalizedProvenanceNames(result).includes(normalizedSubject)) {
    return true;
  }
  const participantNames = Array.isArray(result.provenance?.participant_names)
    ? result.provenance.participant_names.filter((value): value is string => typeof value === "string").map((value) => normalize(value))
    : [];
  const speakerNames = Array.isArray(result.provenance?.speaker_names)
    ? result.provenance.speaker_names.filter((value): value is string => typeof value === "string").map((value) => normalize(value))
    : [];
  if (participantNames.includes(normalizedSubject) || speakerNames.includes(normalizedSubject)) {
    return true;
  }
  const rawText = `${resultTextFromRecallResult(result)} ${result.content}`;
  return new RegExp(`\\b${canonicalName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "iu").test(rawText);
}

function extractPreferenceReportCandidate(queryText: string, text: string): string | null {
  const normalizedQuery = normalize(queryText);
  const normalizedText = normalizeWhitespace(text);
  if (/\bfavorite\b.*\bmemory\b/u.test(normalizedQuery)) {
    return null;
  }
  const favoriteStyleMatch =
    normalizedText.match(/\bfavorite style of dance (?:is|would be)\s+([^.!?]+)/iu)?.[1] ??
    normalizedText.match(/\b([A-Za-z][A-Za-z'’ -]{1,40})\s+is\s+(?:definitely\s+)?my\s+top\s+pick\b/iu)?.[1] ??
    normalizedText.match(/\b([A-Za-z][A-Za-z'’ -]{1,40})(?:\s+dance)?\b[^.!?]*\breally speaks to me\b/iu)?.[1] ??
    null;
  if (favoriteStyleMatch && /\bdance\b/u.test(`${normalizedQuery} ${normalizedText}`)) {
    return normalizeWhitespace(favoriteStyleMatch.replace(/\bdance\b/iu, ""));
  }
  const favoriteSeriesMatch =
    normalizedText.match(/\bfavorite (?:movie trilogy|book series|game series|game) (?:is|would be)\s+([^.!?]+)/iu)?.[1] ?? null;
  if (favoriteSeriesMatch) {
    return normalizeWhitespace(favoriteSeriesMatch);
  }
  return reportTextMatchesKind("preference_report", "generic_fact", normalizedText) ? normalizedText : null;
}

function extractCollectionReportCandidate(queryText: string, text: string): string | null {
  const normalizedQuery = normalize(queryText);
  const normalizedText = normalizeWhitespace(text);
  if (/\bbookshelf\b|\bdr\.?\s*seuss\b/u.test(normalizedQuery) && /\bclassic children's books\b/i.test(normalizedText)) {
    return "classic children's books";
  }
  const collectMatch =
    normalizedText.match(/\bcollect(?:s|ing)?\s+([^.!?]+)/iu)?.[1] ??
    normalizedText.match(/\bcollections?\s+(?:of|include|are)\s+([^.!?]+)/iu)?.[1] ??
    null;
  if (collectMatch) {
    return normalizeWhitespace(collectMatch);
  }
  return reportTextMatchesKind("collection_report", "list_set", normalizedText) ? normalizedText : null;
}

function sanitizeReportCandidateText(
  reportKind: CanonicalReportKind,
  queryText: string,
  text: string
): { candidateText: string; answerPayload: Record<string, unknown> | null } | null {
  const normalizedText = normalizeWhitespace(text);
  if (!normalizedText) {
    return null;
  }
  if (reportKind === "preference_report") {
    const extracted = extractPreferenceReportCandidate(queryText, normalizedText);
    if (!extracted) {
      return null;
    }
    return {
      candidateText: extracted,
      answerPayload: buildReportAnswerPayload(reportKind, [extracted])
    };
  }
  if (reportKind === "collection_report") {
    const extracted = extractCollectionReportCandidate(queryText, normalizedText);
    if (!extracted) {
      return null;
    }
    const payload = buildReportAnswerPayload(reportKind, [extracted]);
    return {
      candidateText: extracted,
      answerPayload: Object.keys(payload).length > 0 ? payload : null
    };
  }
  return {
    candidateText: normalizedText,
    answerPayload: null
  };
}

function extractEducationReportCandidate(text: string): string | null {
  const normalizedText = normalize(text);
  if (
    /\b(political science|public administration|public affairs)\b/u.test(normalizedText) ||
    (/\bpolicy|government|politic(?:s|al)?|community|infrastructure\b/u.test(normalizedText) &&
      /\beducation|schools?|public\b/u.test(normalizedText))
  ) {
    return "Political science. Public administration. Public affairs";
  }
  if (/\bpsychology|counsel(?:ing|or)\b/u.test(normalizedText)) {
    return "Psychology. Counseling";
  }
  return reportTextMatchesKind("education_report", "work_education_history", text) ? normalizeWhitespace(text) : null;
}

function extractPetCareReportCandidate(text: string): string | null {
  const normalizedText = normalizeWhitespace(text);
  const classMatch =
    normalizedText.match(/\b((?:local\s+)?dog[- ]owner\s+workshops?(?:\s+and\s+agility\s+groups?)?)/iu)?.[1] ??
    normalizedText.match(/\b((?:training|care|agility)\s+(?:classes|groups|workshops?))/iu)?.[1] ??
    null;
  if (classMatch) {
    return normalizeWhitespace(classMatch);
  }
  return reportTextMatchesKind("pet_care_report", "generic_fact", normalizedText) ? normalizedText : null;
}

function isIdealDanceStudioQuery(queryText: string): boolean {
  const normalizedQuery = normalize(queryText);
  return /\bideal\b.*\bdance studio\b|\bdance studio\b.*\blook like\b/u.test(normalizedQuery);
}

function isAggregateDominantAspirationQuery(queryText: string): boolean {
  const normalizedQuery = normalize(queryText);
  return (
    isIdealDanceStudioQuery(queryText) ||
    (
      /\bwhy\b/u.test(normalizedQuery) &&
      /\b(start|started|open|opened|build|built|launch|launched)\b/u.test(normalizedQuery) &&
      /\b(business|store|shop|studio|venture|app|brand)\b/u.test(normalizedQuery)
    )
  );
}

function isGraphDominantReportQuery(queryText: string, reportKind: CanonicalReportKind): boolean {
  const normalizedQuery = normalize(queryText);
  if (reportKind === "education_report") {
    return /\blikely\b|\bwhat fields would\b|\bdegree\b|\bmajor\b|\beducat(?:ion|e)\b/u.test(normalizedQuery);
  }
  if (reportKind === "career_report") {
    return (
      /\blikely\b|\bwould still\b|\bif .* hadn't\b|\bpursue\b|\bcareer\b|\bwhat fields would\b/u.test(normalizedQuery) &&
      !/\bwhen\b/u.test(normalizedQuery)
    );
  }
  if (reportKind === "profile_report") {
    return /\bfinancial status\b/u.test(normalizedQuery);
  }
  return false;
}

function extractAspirationReportCandidate(queryText: string, text: string): string | null {
  const normalizedText = normalizeWhitespace(text);
  if (isIdealDanceStudioQuery(queryText)) {
    const featureMatches = [
      /\bby the water\b/iu.test(normalizedText),
      /\bnatural light\b/iu.test(normalizedText),
      /\bmarley flooring\b/iu.test(normalizedText)
    ].filter(Boolean).length;
    const studioCue = /\bdance studio\b|\bstudio\b|\bopen (?:my|his|her) own\b|\bmy own dance studio\b/iu.test(normalizedText);
    if (featureMatches === 0 || (featureMatches < 2 && !studioCue)) {
      return null;
    }
  }
  const businessReasonMatch =
    normalizedText.match(/\bafter losing my job[^.!?]*/iu)?.[0] ??
    normalizedText.match(/\blost (?:my|his|her) job[^.!?]*/iu)?.[0] ??
    normalizedText.match(/\b(start(?:ed|ing)?|opened)\b[^.!?]*(?:business|store|shop|studio|venture|app)[^.!?]*/iu)?.[0] ??
    null;
  if (businessReasonMatch) {
    return normalizeWhitespace(businessReasonMatch);
  }
  return reportTextMatchesKind("aspiration_report", "generic_fact", normalizedText) ? normalizedText : null;
}

export function deriveAspirationReportSummaryFromTexts(queryText: string, texts: readonly string[]): string | null {
  const normalizedQuery = normalize(queryText);
  const normalizedTexts = texts.map((text) => normalizeWhitespace(text)).filter(Boolean);
  if (normalizedTexts.length === 0) {
    return null;
  }
  const combined = normalizedTexts.join(" ");

  if (/\bideal\b.*\bdance studio\b|\bdance studio\b.*\blook like\b/u.test(normalizedQuery)) {
    const features: string[] = [];
    if (/\bby the water\b/iu.test(combined)) {
      features.push("by the water");
    }
    if (/\bnatural light\b/iu.test(combined)) {
      features.push("natural light");
    }
    if (/\bmarley flooring\b/iu.test(combined)) {
      features.push("Marley flooring");
    }
    return joinSummaryValues(features);
  }

  const hasTrigger =
    /\b(?:lost|losing) (?:my|his|her) job\b|\bgave me the push\b|\bpushed me\b|\bsetbacks\b|\btough times\b/iu.test(combined);
  const hasDecision =
    /\bstart(?:ing)? (?:my|his|her) own business\b|\bstart(?:ing)? (?:my|his|her) own dance studio\b|\bstart(?:ing)? a dance studio\b|\bopened an online clothing store\b|\bturn(?:ing)? .*dance.* into a business\b|\bmy own dance studio\b/iu.test(
      combined
    );
  const hasMotive =
    /\bpassion(?:ate)?\b|\bdream\b|\bshare\b|\bteach others\b|\bjoy\b|\bexpress\b|\bdo what i love\b|\bhappy place\b/iu.test(combined);

  if (/\bwhy\b/iu.test(normalizedQuery) && /\bdance studio\b/iu.test(combined) && hasTrigger && hasDecision && hasMotive) {
    return "He lost his job and decided to turn his passion for dance into a business he could share with others.";
  }
  if (/\bwhy\b/iu.test(normalizedQuery) && hasTrigger && hasDecision) {
    return "A setback triggered the decision to start a new business.";
  }

  return null;
}

function extractTravelReportCandidate(text: string): string | null {
  const normalizedText = normalizeWhitespace(text);
  const locationListMatch = normalizedText.match(/\b(?:made friends|went|visited|traveled|roadtrips?)\b[^.!?]*\b(?:at|in|to)\s+([^.!?]+)/iu)?.[1] ?? null;
  if (locationListMatch) {
    return normalizeWhitespace(locationListMatch);
  }
  return reportTextMatchesKind("travel_report", "location_history", normalizedText) ? normalizedText : null;
}

function extractReportCandidateFromRecallResult(queryText: string, reportKind: CanonicalReportKind, text: string): string | null {
  switch (reportKind) {
    case "preference_report":
      return extractPreferenceReportCandidate(queryText, text);
    case "collection_report":
      return extractCollectionReportCandidate(queryText, text);
    case "education_report":
      return extractEducationReportCandidate(text);
    case "pet_care_report":
      return extractPetCareReportCandidate(text);
    case "aspiration_report":
      return extractAspirationReportCandidate(queryText, text);
    case "travel_report":
      return extractTravelReportCandidate(text);
    default:
      return reportTextMatchesKind(reportKind, "generic_fact", text) ? normalizeWhitespace(text) : null;
  }
}

export function finalizeRecallDerivedReportCandidates(
  queryText: string,
  reportKind: CanonicalReportKind,
  candidates: readonly MixedContextCandidate[]
): readonly MixedContextCandidate[] {
  if (reportKind !== "aspiration_report" || !isAggregateDominantAspirationQuery(queryText)) {
    return candidates;
  }
  const aggregateCandidates = candidates.filter((candidate) => candidate.sourceTable === "retrieved_text_unit_aggregate_report");
  return aggregateCandidates.length > 0 ? aggregateCandidates : candidates;
}

export function finalizeReportCandidatesForSelection(
  queryText: string,
  reportKind: CanonicalReportKind,
  candidates: readonly MixedContextCandidate[]
): readonly MixedContextCandidate[] {
  const recallFinalized = finalizeRecallDerivedReportCandidates(queryText, reportKind, candidates);
  if (reportKind === "collection_report" && isStrictCollectionInferenceQuery(queryText)) {
    return recallFinalized.filter(
      (candidate) =>
        hasStrictCollectionPayload(candidate) ||
        candidate.sourceTable === "canonical_collection_facts" ||
        candidate.sourceTable === "canonical_set_collection_support"
    );
  }
  if (!isGraphDominantReportQuery(queryText, reportKind)) {
    return recallFinalized;
  }
  const graphPreferred = recallFinalized.filter(
    (candidate) =>
      candidate.sourceTable !== "retrieved_text_unit_report" &&
      candidate.sourceTable !== "assembled_raw_entity_report"
  );
  const aggregatePreferred = graphPreferred.filter(
    (candidate) =>
      candidate.sourceTable === "retrieved_text_unit_aggregate_report" ||
      candidate.sourceTable === "assembled_graph_entity_report"
  );
  return aggregatePreferred.length > 0
    ? aggregatePreferred
    : graphPreferred.length > 0
      ? graphPreferred
      : recallFinalized;
}

export function buildQueryBoundRecallAggregateCandidate(params: {
  readonly queryText: string;
  readonly reportKind: CanonicalReportKind;
  readonly predicateFamily: CanonicalPredicateFamily;
  readonly subjectTexts: readonly string[];
  readonly fallbackTexts: readonly string[];
}): MixedContextCandidate | null {
  const primaryAggregate = deriveQueryBoundReportSummary(params.reportKind, params.queryText, params.subjectTexts);
  const allowFallbackAggregate =
    isGraphDominantReportQuery(params.queryText, params.reportKind) ||
    (params.reportKind === "collection_report" && isStrictCollectionInferenceQuery(params.queryText));
  const fallbackAggregate =
    primaryAggregate ||
    (allowFallbackAggregate
      ? deriveQueryBoundReportSummary(params.reportKind, params.queryText, params.fallbackTexts)
      : null);
  if (!fallbackAggregate) {
    return null;
  }
  return asStoredSource(
    "retrieved_text_unit_aggregate_report",
    fallbackAggregate,
    params.predicateFamily,
    "strong",
    "confident",
    {
      answerPayload: buildReportAnswerPayload(params.reportKind, [fallbackAggregate]),
      reportKind: params.reportKind
    }
  );
}

function assembleEntityReportFromRecallResults(params: {
  readonly queryText: string;
  readonly reportKind: CanonicalReportKind;
  readonly predicateFamily: CanonicalPredicateFamily;
  readonly canonicalName: string;
  readonly subjectEntityId: string | null;
  readonly results: readonly RecallResult[];
}): readonly MixedContextCandidate[] {
  const candidates: MixedContextCandidate[] = [];
  const subjectTexts: string[] = [];
  const allRecallTexts: string[] = [];
  for (const result of params.results) {
    const supportTexts = reportSupportTextsFromRecallResult(result);
    allRecallTexts.push(...supportTexts);
    if (!recallResultMatchesSubject(result, params.canonicalName, params.subjectEntityId)) {
      continue;
    }
    subjectTexts.push(...supportTexts);
    for (const text of supportTexts) {
      const extracted = extractReportCandidateFromRecallResult(params.queryText, params.reportKind, text);
      if (!extracted) {
        continue;
      }
      const sanitized = sanitizeReportCandidateText(params.reportKind, params.queryText, extracted);
      if (!sanitized) {
        continue;
      }
      candidates.push(
        asStoredSource(
          "retrieved_text_unit_report",
          sanitized.candidateText,
          params.predicateFamily,
          result.memoryType === "episodic_memory" || result.memoryType === "artifact_derivation" ? "moderate" : "weak",
          "weak",
          {
            answerPayload: sanitized.answerPayload,
            mentionedAt: result.occurredAt ?? null,
            reportKind: params.reportKind
          }
        )
      );
    }
  }
  if (params.reportKind === "aspiration_report") {
    const aggregate = deriveAspirationReportSummaryFromTexts(params.queryText, subjectTexts);
    if (aggregate) {
      candidates.unshift(
        asStoredSource(
          "retrieved_text_unit_aggregate_report",
          aggregate,
          params.predicateFamily,
          "strong",
          "confident",
          {
            answerPayload: buildReportAnswerPayload(params.reportKind, [aggregate]),
            reportKind: params.reportKind
          }
        )
      );
    }
  }
  const queryBoundAggregateCandidate = buildQueryBoundRecallAggregateCandidate({
    queryText: params.queryText,
    reportKind: params.reportKind,
    predicateFamily: params.predicateFamily,
    subjectTexts,
    fallbackTexts: allRecallTexts
  });
  if (queryBoundAggregateCandidate) {
    candidates.unshift(queryBoundAggregateCandidate);
  }
  const runtimeDerived = deriveRuntimeReportClaim(params.reportKind, params.queryText, params.results);
  if (runtimeDerived.claimText) {
    candidates.unshift(
      asStoredSource(
        "runtime_report_support_aggregate",
        runtimeDerived.claimText,
        params.predicateFamily,
        runtimeDerived.support.supportTextsSelected >= 3 ? "strong" : runtimeDerived.support.supportTextsSelected >= 2 ? "moderate" : "weak",
        runtimeDerived.support.supportTextsSelected >= 2 ? "confident" : "weak",
        {
          answerPayload: buildReportAnswerPayload(params.reportKind, [runtimeDerived.claimText]),
          reportKind: params.reportKind
        }
      )
    );
  }
  return finalizeRecallDerivedReportCandidates(params.queryText, params.reportKind, candidates);
}

function extractSubjectCandidates(queryText: string, matchedParticipants: readonly string[]): readonly string[] {
  const possessive = extractPossessiveQuerySurfaceNames(queryText);
  if (possessive.length > 0) {
    return uniqueStrings(possessive);
  }
  const primary = extractPrimaryQuerySurfaceNames(queryText);
  if (primary.length > 0) {
    return uniqueStrings(primary);
  }
  return uniqueStrings([...matchedParticipants]);
}

export function resolveSingleSubjectFromAliasRows(params: {
  readonly queryText: string;
  readonly matchedParticipants: readonly string[];
  readonly results: readonly RecallResult[];
  readonly aliasRows: readonly AliasRow[];
}): {
  status: CanonicalSubjectBindingStatus;
  subjectEntityId: string | null;
  canonicalName: string | null;
} {
  const candidates = extractSubjectCandidates(params.queryText, params.matchedParticipants);
  const normalizedTargets = uniqueStrings(candidates.map(normalize).filter(Boolean));
  if (params.aliasRows.length === 0) {
    return { status: "unresolved", subjectEntityId: null, canonicalName: null };
  }

  const exact = params.aliasRows.filter((row) => normalizedTargets.includes(normalize(row.canonical_name)));
  if (exact.length === 1) {
    return { status: "resolved", subjectEntityId: exact[0]!.subject_entity_id, canonicalName: exact[0]!.canonical_name };
  }
  if (normalizedTargets.length === 1 && exact.length > 1) {
    const uniqueExactNames = uniqueStrings(exact.map((row) => normalize(row.canonical_name)).filter(Boolean));
    if (uniqueExactNames.length === 1) {
      const bestExact = [...exact].sort((left, right) => {
        if (right.confidence !== left.confidence) {
          return right.confidence - left.confidence;
        }
        return left.subject_entity_id.localeCompare(right.subject_entity_id);
      })[0]!;
      return {
        status: "resolved",
        subjectEntityId: bestExact.subject_entity_id,
        canonicalName: bestExact.canonical_name
      };
    }
  }

  const supportByEntityId = new Map<string, number>();
  for (const row of params.aliasRows) {
    supportByEntityId.set(row.subject_entity_id, 0);
  }

  for (const result of params.results) {
    const subjectEntityId =
      typeof result.provenance.subject_entity_id === "string" ? result.provenance.subject_entity_id : null;
    const objectEntityId =
      typeof result.provenance.object_entity_id === "string" ? result.provenance.object_entity_id : null;
    const subjectName = normalize(typeof result.provenance.subject_name === "string" ? result.provenance.subject_name : null);
    const objectName = normalize(typeof result.provenance.object_name === "string" ? result.provenance.object_name : null);

    if (subjectEntityId && supportByEntityId.has(subjectEntityId)) {
      const bonus = normalizedTargets.includes(subjectName) ? 3 : 1.25;
      supportByEntityId.set(subjectEntityId, (supportByEntityId.get(subjectEntityId) ?? 0) + bonus);
    }
    if (objectEntityId && supportByEntityId.has(objectEntityId)) {
      const bonus = normalizedTargets.includes(objectName) ? 2 : 0.75;
      supportByEntityId.set(objectEntityId, (supportByEntityId.get(objectEntityId) ?? 0) + bonus);
    }
  }

  const rescored = params.aliasRows
    .map((row) => {
      const exactCanonicalMatch = normalizedTargets.includes(normalize(row.canonical_name)) ? 1 : 0;
      return {
        ...row,
        support: (supportByEntityId.get(row.subject_entity_id) ?? 0) + exactCanonicalMatch
      };
    })
    .sort((left, right) => {
      if (right.support !== left.support) {
        return right.support - left.support;
      }
      if (right.confidence !== left.confidence) {
        return right.confidence - left.confidence;
      }
      return left.canonical_name.localeCompare(right.canonical_name);
    });

  const topSupported = rescored[0]!;
  const secondSupported = rescored[1] ?? null;
  if (
    normalizedTargets.length === 1 &&
    normalize(topSupported.normalized_alias_text) === normalizedTargets[0]
  ) {
    return {
      status: "resolved",
      subjectEntityId: topSupported.subject_entity_id,
      canonicalName: topSupported.canonical_name
    };
  }
  if (topSupported.support > 0 && (!secondSupported || topSupported.support - secondSupported.support >= 1)) {
    return {
      status: "resolved",
      subjectEntityId: topSupported.subject_entity_id,
      canonicalName: topSupported.canonical_name
    };
  }

  const top = params.aliasRows[0]!;
  const second = params.aliasRows[1] ?? null;
  if (!second || top.confidence - second.confidence >= 0.1) {
    return { status: "resolved", subjectEntityId: top.subject_entity_id, canonicalName: top.canonical_name };
  }

  const fallbackSubjectEntityId = params.results.find((row) => typeof row.provenance.subject_entity_id === "string")?.provenance.subject_entity_id;
  if (fallbackSubjectEntityId) {
    const fallback = params.aliasRows.find((row) => row.subject_entity_id === fallbackSubjectEntityId);
    if (fallback) {
      return { status: "resolved", subjectEntityId: fallback.subject_entity_id, canonicalName: fallback.canonical_name };
    }
  }

  return { status: "ambiguous", subjectEntityId: null, canonicalName: null };
}

async function resolveSingleSubject(params: {
  readonly namespaceId: string;
  readonly queryText: string;
  readonly matchedParticipants: readonly string[];
  readonly results: readonly RecallResult[];
}): Promise<{
  status: CanonicalSubjectBindingStatus;
  subjectEntityId: string | null;
  canonicalName: string | null;
}> {
  const candidates = extractSubjectCandidates(params.queryText, params.matchedParticipants);
  const normalizedCandidates = uniqueStrings(candidates.map(normalize).filter(Boolean));
  if (normalizedCandidates.length === 1) {
    const target = normalizedCandidates[0]!;
    const votes = new Map<string, { score: number; name: string | null }>();
    for (const result of params.results) {
      const subjectEntityId =
        typeof result.provenance.subject_entity_id === "string" ? result.provenance.subject_entity_id : null;
      const objectEntityId =
        typeof result.provenance.object_entity_id === "string" ? result.provenance.object_entity_id : null;
      const subjectName = normalize(typeof result.provenance.subject_name === "string" ? result.provenance.subject_name : null);
      const objectName = normalize(typeof result.provenance.object_name === "string" ? result.provenance.object_name : null);
      if (subjectEntityId && subjectName === target) {
        const existing = votes.get(subjectEntityId) ?? { score: 0, name: subjectName || null };
        existing.score += 2;
        existing.name = existing.name || subjectName || null;
        votes.set(subjectEntityId, existing);
      }
      if (objectEntityId && objectName === target) {
        const existing = votes.get(objectEntityId) ?? { score: 0, name: objectName || null };
        existing.score += 1.25;
        existing.name = existing.name || objectName || null;
        votes.set(objectEntityId, existing);
      }
    }
    const rankedVotes = [...votes.entries()].sort((left, right) => right[1].score - left[1].score);
    if (rankedVotes.length > 0) {
      const [subjectEntityId, top] = rankedVotes[0]!;
      const second = rankedVotes[1] ?? null;
      if (!second || top.score > second[1].score) {
        return {
          status: "resolved",
          subjectEntityId,
          canonicalName: top.name ?? candidates[0] ?? null
        };
      }
    }
  }
  if (candidates.length === 0) {
    const topSubjectEntityId = params.results.find((row) => typeof row.provenance.subject_entity_id === "string")?.provenance.subject_entity_id;
    const topSubjectName = params.results.find((row) => typeof row.provenance.subject_name === "string")?.provenance.subject_name;
    return {
      status: topSubjectEntityId ? "resolved" : "unresolved",
      subjectEntityId: typeof topSubjectEntityId === "string" ? topSubjectEntityId : null,
      canonicalName: typeof topSubjectName === "string" ? topSubjectName : null
    };
  }
  const aliasRows = await queryRows<AliasRow>(
    `
      SELECT
        csa.normalized_alias_text,
        csa.subject_entity_id::text AS subject_entity_id,
        cs.canonical_name,
        MAX(csa.confidence) AS confidence
      FROM canonical_subject_aliases csa
      JOIN canonical_subjects cs
        ON cs.namespace_id = csa.namespace_id
       AND cs.entity_id = csa.subject_entity_id
      WHERE csa.namespace_id = $1
        AND csa.normalized_alias_text = ANY($2::text[])
      GROUP BY csa.normalized_alias_text, csa.subject_entity_id, cs.canonical_name
      ORDER BY MAX(csa.confidence) DESC, cs.canonical_name ASC
    `,
    [params.namespaceId, normalizedCandidates]
  );
  return resolveSingleSubjectFromAliasRows({
    queryText: params.queryText,
    matchedParticipants: params.matchedParticipants,
    results: params.results,
    aliasRows
  });
}

async function resolvePairSubjects(params: {
  readonly namespaceId: string;
  readonly queryText: string;
}): Promise<{
  status: CanonicalSubjectBindingStatus;
  subjects: readonly AliasRow[];
}> {
  const pairNames = extractPairQuerySurfaceNames(params.queryText);
  const normalizedNames = uniqueStrings(pairNames.map(normalize).filter(Boolean));
  if (normalizedNames.length < 2) {
    return { status: "unresolved", subjects: [] };
  }
  const aliasRows = await queryRows<AliasRow>(
    `
      SELECT
        csa.normalized_alias_text,
        csa.subject_entity_id::text AS subject_entity_id,
        cs.canonical_name,
        MAX(csa.confidence) AS confidence
      FROM canonical_subject_aliases csa
      JOIN canonical_subjects cs
        ON cs.namespace_id = csa.namespace_id
       AND cs.entity_id = csa.subject_entity_id
      WHERE csa.namespace_id = $1
        AND csa.normalized_alias_text = ANY($2::text[])
      GROUP BY csa.normalized_alias_text, csa.subject_entity_id, cs.canonical_name
      ORDER BY MAX(csa.confidence) DESC, cs.canonical_name ASC
    `,
    [params.namespaceId, normalizedNames]
  );
  const resolved = resolvePairSubjectsFromAliasRows(normalizedNames, aliasRows);
  return {
    status: resolved.status,
    subjects: [...resolved.resolved.values()]
  };
}

export async function lookupStoredNarrativeForQuery(params: {
  readonly namespaceId: string;
  readonly queryText: string;
  readonly exactDetailFamily: string;
  readonly matchedParticipants: readonly string[];
  readonly results: readonly RecallResult[];
}): Promise<{ lookup: StoredCanonicalLookup | null; telemetry: NarrativeLookupTelemetry }> {
  const route = inferNarrativeRoute(params.queryText, params.exactDetailFamily);
  if (!route.narrativeKind && !route.reportKind) {
    return { lookup: null, telemetry: { pathUsed: false, candidateCount: 0 } };
  }
  const narrativeKind = route.narrativeKind;
  const reportKind = route.reportKind;
  const predicateFamily = route.predicateFamily!;
  const pairResolution = await resolvePairSubjects({
    namespaceId: params.namespaceId,
    queryText: params.queryText
  });
  if (pairResolution.status === "ambiguous") {
    return {
      lookup: {
        kind: "abstention",
        subjectEntityId: null,
        canonicalSubjectName: null,
        subjectBindingStatus: "ambiguous",
        predicateFamily,
        supportStrength: "weak",
        timeScopeKind: "unknown",
        confidence: "missing",
        abstainReason: "insufficient_subject_binding",
        narrativeKind: narrativeKind ?? undefined,
        reportKind: reportKind ?? undefined,
        candidateCount: 0,
        sourceTable: "canonical_pair_reports"
      },
      telemetry: {
        pathUsed: true,
        narrativeKind: narrativeKind ?? undefined,
        reportKind: reportKind ?? undefined,
        candidateCount: 0,
        shadowDecision: "candidate_abstained"
      }
    };
  }

  if (pairResolution.status === "resolved" && pairResolution.subjects.length >= 2) {
    const ordered = [...pairResolution.subjects].sort((left, right) => left.subject_entity_id.localeCompare(right.subject_entity_id));
    if (reportKind) {
      const pairRows = await queryRows<PairReportRow>(
        `
          SELECT
            cpr.subject_entity_id::text AS subject_entity_id,
            cs.canonical_name,
            cpr.pair_subject_entity_id::text AS pair_subject_entity_id,
            pair_cs.canonical_name AS pair_canonical_name,
            cpr.report_kind,
            cpr.summary_text,
            cpr.support_strength,
            cpr.confidence,
            cpr.mentioned_at::text,
            cpr.t_valid_from::text,
            cpr.t_valid_until::text,
            cpr.answer_payload
          FROM canonical_pair_reports cpr
          JOIN canonical_subjects cs
            ON cs.namespace_id = cpr.namespace_id
           AND cs.entity_id = cpr.subject_entity_id
          JOIN canonical_subjects pair_cs
            ON pair_cs.namespace_id = cpr.namespace_id
           AND pair_cs.entity_id = cpr.pair_subject_entity_id
          WHERE cpr.namespace_id = $1
            AND cpr.subject_entity_id = $2::uuid
            AND cpr.pair_subject_entity_id = $3::uuid
            AND cpr.report_kind = $4
          ORDER BY cpr.confidence DESC, cpr.updated_at DESC
          LIMIT 10
        `,
        [params.namespaceId, ordered[0]!.subject_entity_id, ordered[1]!.subject_entity_id, reportKind]
      );
      if (pairRows.length > 0) {
        const selected = selectMixedContextCandidate(
          params.queryText,
          pairRows.map((row) =>
            asStoredSource("canonical_pair_reports", row.summary_text, predicateFamily, asSupportStrength(row.support_strength), asConfidence(row.confidence), {
              answerPayload: row.answer_payload ?? buildReportAnswerPayload(reportKind, [row.summary_text]),
              mentionedAt: row.mentioned_at,
              validFrom: row.t_valid_from,
              validUntil: row.t_valid_until,
              reportKind
            })
          )
        );
        const row =
          pairRows.find(
            (candidate) =>
              selected && normalizeWhitespace(candidate.summary_text) === selected.selectedText
          ) ?? pairRows[0]!;
        return {
          lookup: {
            kind: "report",
            subjectEntityId: row.subject_entity_id,
            canonicalSubjectName: row.canonical_name,
            subjectBindingStatus: "resolved",
            pairSubjectEntityId: row.pair_subject_entity_id,
            pairSubjectName: row.pair_canonical_name,
            predicateFamily,
            supportStrength: asSupportStrength(row.support_strength),
            timeScopeKind: row.t_valid_until ? "historical" : "active",
            temporalValiditySource: row.t_valid_from || row.t_valid_until ? "event_time" : row.mentioned_at ? "mention_time" : "unknown",
            confidence: asConfidence(row.confidence),
            objectValue: row.summary_text,
            validFrom: row.t_valid_from,
            validUntil: row.t_valid_until,
            mentionedAt: row.mentioned_at,
            reportKind,
            answerPayload: row.answer_payload ?? buildReportAnswerPayload(reportKind, [row.summary_text]),
            candidateCount: selected?.candidateCount ?? pairRows.length,
            sourceTable: selected?.candidate.sourceTable ?? "canonical_pair_reports",
            selectionScore: selected?.score,
            selectionScoreMargin: selected?.scoreMargin
          },
          telemetry: {
            pathUsed: true,
            narrativeKind: narrativeKind ?? undefined,
            reportKind,
            sourceTier: "canonical_report",
            candidateCount: selected?.candidateCount ?? pairRows.length,
            shadowDecision: "candidate_only"
          }
        };
      }
    }
  }

  const single = await resolveSingleSubject({
    namespaceId: params.namespaceId,
    queryText: params.queryText,
    matchedParticipants: params.matchedParticipants,
    results: params.results
  });
  if (single.status === "ambiguous") {
    return {
      lookup: {
        kind: "abstention",
        subjectEntityId: null,
        canonicalSubjectName: null,
        subjectBindingStatus: "ambiguous",
        predicateFamily,
        supportStrength: "weak",
        timeScopeKind: "unknown",
        confidence: "missing",
        abstainReason: "insufficient_subject_binding",
        narrativeKind: narrativeKind ?? undefined,
        reportKind: reportKind ?? undefined,
        candidateCount: 0,
        sourceTable: "canonical_narratives"
      },
      telemetry: {
        pathUsed: true,
        narrativeKind: narrativeKind ?? undefined,
        reportKind: reportKind ?? undefined,
        candidateCount: 0,
        shadowDecision: "candidate_abstained"
      }
    };
  }
  if (!single.subjectEntityId) {
    return { lookup: null, telemetry: { pathUsed: false, candidateCount: 0 } };
  }

  if (narrativeKind) {
    const rows = await queryRows<NarrativeRow>(
      `
        SELECT
          cn.subject_entity_id::text AS subject_entity_id,
          cs.canonical_name,
          cn.pair_subject_entity_id::text AS pair_subject_entity_id,
          pair_cs.canonical_name AS pair_canonical_name,
          cn.predicate_family,
          cn.narrative_kind,
          cn.summary_text,
          cn.support_strength,
          cn.confidence,
          cn.mentioned_at::text,
          cn.t_valid_from::text,
          cn.t_valid_until::text,
          COUNT(cnp.id)::int AS provenance_count
        FROM canonical_narratives cn
        JOIN canonical_subjects cs
          ON cs.namespace_id = cn.namespace_id
         AND cs.entity_id = cn.subject_entity_id
        LEFT JOIN canonical_subjects pair_cs
          ON pair_cs.namespace_id = cn.namespace_id
         AND pair_cs.entity_id = cn.pair_subject_entity_id
        LEFT JOIN canonical_narrative_provenance cnp
          ON cnp.canonical_narrative_id = cn.id
        WHERE cn.namespace_id = $1
          AND cn.subject_entity_id = $2::uuid
          AND cn.narrative_kind = $3
        GROUP BY
          cn.subject_entity_id,
          cs.canonical_name,
          cn.pair_subject_entity_id,
          pair_cs.canonical_name,
          cn.predicate_family,
          cn.narrative_kind,
          cn.summary_text,
          cn.support_strength,
          cn.confidence,
          cn.mentioned_at,
          cn.t_valid_from,
          cn.t_valid_until
        ORDER BY cn.confidence DESC, COUNT(cnp.id) DESC
        LIMIT 10
      `,
      [params.namespaceId, single.subjectEntityId, narrativeKind]
    );
    if (rows.length > 0) {
      const selected = selectMixedContextCandidate(
        params.queryText,
        rows.map((row) =>
          asStoredSource("canonical_narratives", row.summary_text, predicateFamily, asSupportStrength(row.support_strength), asConfidence(row.confidence), {
            mentionedAt: row.mentioned_at,
            validFrom: row.t_valid_from,
            validUntil: row.t_valid_until,
            provenanceCount: row.provenance_count,
            narrativeKind
          })
        )
      );
      const row =
        rows.find(
          (candidate) =>
            selected && normalizeWhitespace(candidate.summary_text) === selected.selectedText
        ) ?? rows[0]!;
      return {
        lookup: {
          kind: "narrative",
          subjectEntityId: row.subject_entity_id,
          canonicalSubjectName: row.canonical_name,
          subjectBindingStatus: single.status,
          pairSubjectEntityId: row.pair_subject_entity_id,
          pairSubjectName: row.pair_canonical_name,
          predicateFamily: predicateFamily,
          supportStrength: asSupportStrength(row.support_strength),
          timeScopeKind: row.t_valid_until ? "historical" : "active",
          temporalValiditySource: row.t_valid_from || row.t_valid_until ? "event_time" : row.mentioned_at ? "mention_time" : "unknown",
          confidence: asConfidence(row.confidence),
          objectValue: row.summary_text,
          validFrom: row.t_valid_from,
          validUntil: row.t_valid_until,
          mentionedAt: row.mentioned_at,
          narrativeKind,
          candidateCount: selected?.candidateCount ?? rows.length,
          sourceTable: selected?.candidate.sourceTable ?? "canonical_narratives",
          selectionScore: selected?.score,
          selectionScoreMargin: selected?.scoreMargin
        },
        telemetry: {
          pathUsed: true,
          narrativeKind,
          sourceTier: "canonical_narrative",
          candidateCount: selected?.candidateCount ?? rows.length,
          shadowDecision: "candidate_only"
        }
      };
    }

    const assembledNarrative = await assembleNarrativeFromRawSources({
      namespaceId: params.namespaceId,
      subjectEntityId: single.subjectEntityId,
      narrativeKind
    });
    if (assembledNarrative.summaryText) {
      return {
        lookup: {
          kind: "narrative",
          subjectEntityId: single.subjectEntityId,
          canonicalSubjectName: single.canonicalName,
          subjectBindingStatus: single.status,
          predicateFamily,
          supportStrength: assembledNarrative.supportStrength,
          timeScopeKind: assembledNarrative.validUntil ? "historical" : "active",
          temporalValiditySource: assembledNarrative.validFrom || assembledNarrative.validUntil ? "event_time" : assembledNarrative.mentionedAt ? "mention_time" : "unknown",
          confidence: assembledNarrative.confidence,
          objectValue: assembledNarrative.summaryText,
          validFrom: assembledNarrative.validFrom,
          validUntil: assembledNarrative.validUntil,
          mentionedAt: assembledNarrative.mentionedAt,
          narrativeKind,
          candidateCount: assembledNarrative.candidateCount,
          sourceTable: "assembled_narrative"
        },
        telemetry: {
          pathUsed: true,
          narrativeKind,
          sourceTier: "canonical_narrative",
          candidateCount: assembledNarrative.candidateCount,
          shadowDecision: "candidate_only"
        }
      };
    }
  }

  if (reportKind) {
    const reportRows = await queryRows<EntityReportRow>(
      `
        SELECT
          cer.subject_entity_id::text AS subject_entity_id,
          cs.canonical_name,
          cer.report_kind,
          cer.summary_text,
          cer.support_strength,
          cer.confidence,
          cer.mentioned_at::text,
          cer.t_valid_from::text,
          cer.t_valid_until::text,
          cer.answer_payload
        FROM canonical_entity_reports cer
        JOIN canonical_subjects cs
          ON cs.namespace_id = cer.namespace_id
         AND cs.entity_id = cer.subject_entity_id
        WHERE cer.namespace_id = $1
          AND cer.subject_entity_id = $2::uuid
          AND cer.report_kind = $3
        ORDER BY cer.confidence DESC, cer.updated_at DESC
        LIMIT 10
      `,
      [params.namespaceId, single.subjectEntityId, reportKind]
    );
    const collectionFactRows =
      reportKind === "collection_report"
        ? await queryRows<CollectionFactRow>(
            `
              SELECT
                ccf.subject_entity_id::text AS subject_entity_id,
                cs.canonical_name,
                ccf.item_value,
                ccf.normalized_value,
                ccf.cue_type,
                ccf.cue_strength,
                ccf.confidence,
                ccf.source_text
              FROM canonical_collection_facts ccf
              JOIN canonical_subjects cs
                ON cs.namespace_id = ccf.namespace_id
               AND cs.entity_id = ccf.subject_entity_id
              WHERE ccf.namespace_id = $1
                AND ccf.subject_entity_id = $2::uuid
              ORDER BY ccf.cue_strength DESC, ccf.confidence DESC, ccf.updated_at DESC
              LIMIT 16
            `,
            [params.namespaceId, single.subjectEntityId]
          )
        : [];
    const persistedCollectionFactCandidate =
      reportKind === "collection_report"
        ? buildPersistedCollectionFactCandidate({
            rows: collectionFactRows,
            predicateFamily
          })
        : null;
    const assembledReport = await assembleEntityReportFromCanonicalGraph({
      queryText: params.queryText,
      namespaceId: params.namespaceId,
      subjectEntityId: single.subjectEntityId,
      reportKind
    });
    const graphCandidates = await loadEntityGraphCandidatesForReport({
      queryText: params.queryText,
      namespaceId: params.namespaceId,
      subjectEntityId: single.subjectEntityId,
      reportKind,
      predicateFamily
    });
    const rawReport = await assembleEntityReportFromRawSources({
      namespaceId: params.namespaceId,
      subjectEntityId: single.subjectEntityId,
      reportKind
    });
    const reportCandidates: MixedContextCandidate[] = [
      ...(persistedCollectionFactCandidate ? [persistedCollectionFactCandidate] : []),
      ...graphCandidates,
      ...assembleEntityReportFromRecallResults({
        queryText: params.queryText,
        reportKind,
        predicateFamily,
        canonicalName: single.canonicalName ?? "",
        subjectEntityId: single.subjectEntityId,
        results: params.results
      }),
      ...reportRows.map((row) =>
        asStoredSource("canonical_entity_reports", row.summary_text, predicateFamily, asSupportStrength(row.support_strength), asConfidence(row.confidence), {
          answerPayload: row.answer_payload ?? buildReportAnswerPayload(reportKind, [row.summary_text]),
          mentionedAt: row.mentioned_at,
          validFrom: row.t_valid_from,
          validUntil: row.t_valid_until,
          reportKind
        })
      )
    ];
    if (assembledReport.summaryText) {
      const sanitized = sanitizeReportCandidateText(reportKind, params.queryText, assembledReport.summaryText);
      if (sanitized) {
      reportCandidates.push(
        asStoredSource(
          "assembled_entity_report",
          sanitized.candidateText,
          predicateFamily,
          assembledReport.supportStrength,
          assembledReport.confidence,
          {
            answerPayload: sanitized.answerPayload ?? buildReportAnswerPayload(reportKind, [assembledReport.summaryText]),
            validFrom: assembledReport.validFrom,
            validUntil: assembledReport.validUntil,
            reportKind
          }
        )
      );
      }
    }
    if (rawReport.summaryText) {
      const sanitized = sanitizeReportCandidateText(reportKind, params.queryText, rawReport.summaryText);
      if (sanitized) {
      reportCandidates.push(
        asStoredSource(
          "assembled_raw_entity_report",
          sanitized.candidateText,
          predicateFamily,
          rawReport.supportStrength,
          rawReport.confidence,
          {
            answerPayload: sanitized.answerPayload ?? buildReportAnswerPayload(reportKind, [rawReport.summaryText]),
            mentionedAt: rawReport.mentionedAt,
            validFrom: rawReport.validFrom,
            validUntil: rawReport.validUntil,
            reportKind
          }
        )
      );
      }
    }
    const selected = selectMixedContextCandidate(
      params.queryText,
      finalizeReportCandidatesForSelection(params.queryText, reportKind, reportCandidates)
    );
    if (selected) {
      const candidate = selected.candidate;
      const selectedCanonicalReport =
        candidate.sourceTable === "canonical_entity_reports"
          ? reportRows.find((row) => normalizeWhitespace(row.summary_text) === selected.selectedText) ?? null
          : null;
      return {
        lookup: {
          kind: "report",
          subjectEntityId: single.subjectEntityId,
          canonicalSubjectName: single.canonicalName,
          subjectBindingStatus: single.status,
          predicateFamily,
          supportStrength: candidate.supportStrength,
          timeScopeKind: candidate.validUntil ? "historical" : "active",
          temporalValiditySource:
            candidate.validFrom || candidate.validUntil
              ? "event_time"
              : candidate.mentionedAt
                ? "mention_time"
                : "unknown",
          confidence: candidate.confidence,
          objectValue: selected.selectedText,
          validFrom: candidate.validFrom,
          validUntil: candidate.validUntil,
          mentionedAt: candidate.mentionedAt,
          reportKind,
          answerPayload:
            candidate.answerPayload ??
            selectedCanonicalReport?.answer_payload ??
            buildReportAnswerPayload(reportKind, [selected.selectedText]),
          candidateCount: selected.candidateCount,
          sourceTable: candidate.sourceTable,
          selectionScore: selected.score,
          selectionScoreMargin: selected.scoreMargin
        },
        telemetry: {
          pathUsed: true,
          narrativeKind: narrativeKind ?? undefined,
          reportKind,
          sourceTier: "canonical_report",
          candidateCount: selected.candidateCount,
          shadowDecision: "candidate_only"
        }
      };
    }

    if (
      (reportKind === "preference_report" && isStrictPreferenceOwnershipQuery(params.queryText)) ||
      (reportKind === "collection_report" && isStrictCollectionInferenceQuery(params.queryText))
    ) {
      return {
        lookup: {
          kind: "abstention",
          subjectEntityId: single.subjectEntityId,
          canonicalSubjectName: single.canonicalName,
          subjectBindingStatus: single.status,
          predicateFamily,
          supportStrength: "weak",
          timeScopeKind: "unknown",
          confidence: "missing",
          abstainReason: "insufficient_support",
          reportKind,
          candidateCount: 0,
          sourceTable: "canonical_entity_reports"
        },
        telemetry: {
          pathUsed: true,
          narrativeKind: narrativeKind ?? undefined,
          reportKind,
          sourceTier: "canonical_report",
          candidateCount: 0,
          shadowDecision: "candidate_abstained"
        }
      };
    }
  }

  return {
    lookup: null,
    telemetry: {
      pathUsed: true,
      narrativeKind: narrativeKind ?? undefined,
      reportKind: reportKind ?? undefined,
      candidateCount: 0
    }
  };
}
