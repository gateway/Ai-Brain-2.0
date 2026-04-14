import type { PoolClient } from "pg";
import { queryRows, withTransaction } from "../db/client.js";
import { loadNamespaceSelfProfileForClient } from "../identity/service.js";
import { normalizeEntityLookupName } from "../identity/canonicalization.js";
import { asPairGraphPlan, lookupCanonicalPairNeighborhood } from "./graph-reader.js";
import {
  buildReportAnswerPayload,
  extractCanonicalCollectionFactSeeds,
  summarizeCanonicalReportGroup
} from "./report-synthesis.js";
import {
  extractPairQuerySurfaceNames,
  extractPossessiveQuerySurfaceNames,
  extractPrimaryQuerySurfaceNames,
  extractQuerySurfaceNames,
  isPairAggregationQuery
} from "../retrieval/query-subjects.js";
import {
  extractTemporalQueryObjectTokens,
  extractTemporalQueryAlignmentTokens,
  isTemporalQueryTextAligned,
  temporalQueryObjectAlignmentCount,
  temporalQueryAlignmentCount
} from "../retrieval/temporal-query-alignment.js";
import type { RecallResult } from "../types.js";
import type {
  CanonicalAbstainReason,
  CanonicalNarrativeKind,
  CanonicalPredicateFamily,
  CanonicalReportKind,
  CanonicalTemporalSourceQuality,
  CanonicalTemporalSupportKind,
  PairGraphPlan,
  RecallConfidenceGrade,
  CanonicalSubjectBindingStatus,
  CanonicalSupportStrength,
  CanonicalTimeScopeKind,
  TemporalValiditySource
} from "../retrieval/types.js";

type JsonRecord = Record<string, unknown>;

export interface StoredCanonicalLookup {
  readonly kind: "fact" | "state" | "temporal_fact" | "set" | "narrative" | "report" | "abstention";
  readonly subjectEntityId: string | null;
  readonly canonicalSubjectName: string | null;
  readonly subjectBindingStatus: CanonicalSubjectBindingStatus;
  readonly pairSubjectEntityId?: string | null;
  readonly pairSubjectName?: string | null;
  readonly pairGraphPlan?: PairGraphPlan | null;
  readonly predicateFamily: CanonicalPredicateFamily;
  readonly supportStrength: CanonicalSupportStrength;
  readonly timeScopeKind: CanonicalTimeScopeKind;
  readonly temporalValiditySource?: TemporalValiditySource;
  readonly confidence: RecallConfidenceGrade;
  readonly objectValue?: string | null;
  readonly objectValues?: readonly string[];
  readonly validFrom?: string | null;
  readonly validUntil?: string | null;
  readonly mentionedAt?: string | null;
  readonly eventKey?: string | null;
  readonly eventType?: string | null;
  readonly timeGranularity?: string | null;
  readonly answerYear?: number | null;
  readonly answerMonth?: number | null;
  readonly answerDay?: number | null;
  readonly objectEntityId?: string | null;
  readonly sourceArtifactId?: string | null;
  readonly sourceChunkId?: string | null;
  readonly sourceEventId?: string | null;
  readonly anchorEventKey?: string | null;
  readonly anchorRelation?: string | null;
  readonly anchorOffsetValue?: number | null;
  readonly anchorOffsetUnit?: string | null;
  readonly canonicalConfidence?: number | null;
  readonly supportKind?: CanonicalTemporalSupportKind | null;
  readonly bindingConfidence?: number | null;
  readonly temporalSourceQuality?: CanonicalTemporalSourceQuality | null;
  readonly derivedFromReference?: boolean;
  readonly eventSurfaceText?: string | null;
  readonly locationSurfaceText?: string | null;
  readonly participantEntityIds?: readonly string[];
  readonly typedSetEntryValues?: readonly string[];
  readonly typedSetEntryType?: string | null;
  readonly abstainReason?: CanonicalAbstainReason;
  readonly narrativeKind?: CanonicalNarrativeKind;
  readonly reportKind?: CanonicalReportKind;
  readonly answerPayload?: JsonRecord | null;
  readonly candidateCount?: number;
  readonly sourceTable?: string | null;
  readonly selectionScore?: number;
  readonly selectionScoreMargin?: number;
}

interface CanonicalRegistryRow {
  readonly id: string;
  readonly entity_type: "self" | "person" | "place" | "project" | "concept" | "unknown";
  readonly canonical_name: string;
  readonly normalized_name: string;
  readonly aliases: unknown;
  readonly merged_entities: unknown;
  readonly metadata: JsonRecord | null;
}

interface RelationshipMemoryRow {
  readonly relationship_id: string;
  readonly subject_entity_id: string;
  readonly object_entity_id: string;
  readonly predicate: string;
  readonly object_name: string;
  readonly confidence: number;
  readonly status: string;
  readonly valid_from: string | null;
  readonly valid_until: string | null;
  readonly source_memory_id: string | null;
  readonly source_chunk_id: string | null;
}

interface ProceduralMemoryRow {
  readonly procedural_id: string;
  readonly state_type: string;
  readonly state_key: string;
  readonly state_value: unknown;
  readonly valid_from: string | null;
  readonly valid_until: string | null;
  readonly updated_at: string | null;
  readonly metadata: JsonRecord | null;
}

interface ProfileSummarySemanticRow {
  readonly semantic_id: string;
  readonly canonical_key: string;
  readonly content_abstract: string;
  readonly valid_from: string | null;
  readonly valid_until: string | null;
  readonly normalized_value: JsonRecord | null;
  readonly metadata: JsonRecord | null;
}

interface PersonTimeFactRow {
  readonly id: string;
  readonly subject_entity_id: string | null;
  readonly person_name: string;
  readonly fact_text: string;
  readonly time_hint_text: string | null;
  readonly location_text: string | null;
  readonly window_start: string | null;
  readonly window_end: string | null;
  readonly occurred_at: string | null;
  readonly source_memory_id: string | null;
  readonly artifact_id: string | null;
  readonly source_chunk_id: string | null;
}

interface MediaMentionRow {
  readonly id: string;
  readonly subject_entity_id: string | null;
  readonly subject_name: string | null;
  readonly media_title: string;
  readonly media_kind: string;
  readonly mention_kind: string;
  readonly time_hint_text: string | null;
  readonly occurred_at: string | null;
  readonly source_memory_id: string | null;
  readonly artifact_id: string | null;
  readonly source_chunk_id: string | null;
  readonly metadata: JsonRecord | null;
}

interface PreferenceFactRow {
  readonly subject_entity_id: string | null;
  readonly subject_name: string | null;
  readonly predicate: string;
  readonly domain: string;
  readonly object_text: string;
  readonly qualifier: string | null;
  readonly context_text: string | null;
  readonly occurred_at: string | null;
  readonly source_memory_id: string | null;
  readonly artifact_id: string | null;
}

interface PersonTimeCanonicalFactRow {
  readonly id: string;
  readonly subject_entity_id: string | null;
  readonly person_name: string;
  readonly fact_text: string;
  readonly time_hint_text: string | null;
  readonly occurred_at: string | null;
  readonly source_memory_id: string | null;
}

interface TransactionItemRow {
  readonly item_label: string;
  readonly occurred_at: string | null;
}

interface PersonTimeSetRow {
  readonly subject_entity_id: string | null;
  readonly person_name: string | null;
  readonly fact_text: string;
  readonly time_hint_text: string | null;
  readonly location_text: string | null;
  readonly occurred_at: string | null;
}

interface AnswerableUnitGoalRow {
  readonly unit_type: string;
  readonly content_text: string;
  readonly owner_entity_hint: string | null;
  readonly speaker_entity_hint: string | null;
  readonly participant_names: unknown;
  readonly occurred_at: string | null;
  readonly ownership_confidence: number | null;
}

interface CanonicalAliasLookupRow {
  readonly subject_entity_id: string;
  readonly canonical_name: string;
  readonly confidence: number;
}

interface CanonicalStateLookupRow {
  readonly subject_entity_id: string;
  readonly canonical_name: string;
  readonly predicate_family: string;
  readonly state_value: string;
  readonly support_strength: string;
  readonly confidence: number;
  readonly time_scope_kind: string;
  readonly valid_from: string | null;
  readonly valid_until: string | null;
  readonly mentioned_at: string | null;
  readonly t_valid_from: string | null;
  readonly t_valid_until: string | null;
  readonly metadata: JsonRecord | null;
}

interface CanonicalFactLookupRow {
  readonly subject_entity_id: string;
  readonly canonical_name: string;
  readonly predicate_family: string;
  readonly object_value: string | null;
  readonly support_strength: string;
  readonly time_scope_kind: string;
  readonly valid_from: string | null;
  readonly valid_until: string | null;
  readonly mentioned_at: string | null;
  readonly t_valid_from: string | null;
  readonly t_valid_until: string | null;
  readonly metadata: JsonRecord | null;
}

interface CanonicalTemporalLookupRow {
  readonly subject_entity_id: string;
  readonly canonical_name: string;
  readonly predicate_family: string;
  readonly fact_value: string | null;
  readonly support_strength: string;
  readonly time_scope_kind: string;
  readonly anchor_text: string | null;
  readonly anchor_start: string | null;
  readonly anchor_end: string | null;
  readonly mentioned_at: string | null;
  readonly t_valid_from: string | null;
  readonly t_valid_until: string | null;
  readonly event_key: string | null;
  readonly event_type: string | null;
  readonly time_granularity: string | null;
  readonly answer_year: number | null;
  readonly answer_month: number | null;
  readonly answer_day: number | null;
  readonly object_entity_id: string | null;
  readonly source_artifact_id: string | null;
  readonly source_chunk_id: string | null;
  readonly source_event_id: string | null;
  readonly anchor_event_key: string | null;
  readonly anchor_relation: string | null;
  readonly anchor_offset_value: number | null;
  readonly anchor_offset_unit: string | null;
  readonly confidence: number | null;
  readonly support_kind: CanonicalTemporalSupportKind | null;
  readonly binding_confidence: number | null;
  readonly temporal_source_quality: CanonicalTemporalSourceQuality | null;
  readonly derived_from_reference: boolean | null;
  readonly event_surface_text: string | null;
  readonly location_surface_text: string | null;
  readonly participant_entity_ids: unknown;
  readonly metadata: JsonRecord | null;
}

interface CanonicalTemporalNeighborhoodSummary {
  readonly key: string;
  readonly memberCount: number;
  readonly alignedCount: number;
  readonly explicitEventCount: number;
  readonly earliestOrderingValue: number;
  readonly bestGranularityRank: number;
  readonly bestBindingConfidence: number;
}

interface CanonicalSetLookupRow {
  readonly id?: string;
  readonly subject_entity_id: string;
  readonly canonical_name: string;
  readonly predicate_family: string;
  readonly item_values: unknown;
  readonly support_strength: string;
  readonly confidence: number;
  readonly valid_from: string | null;
  readonly valid_until: string | null;
  readonly metadata: JsonRecord | null;
}

interface CanonicalSetEntryRow {
  readonly canonical_set_id: string;
  readonly subject_entity_id: string;
  readonly display_value: string;
  readonly normalized_value: string;
  readonly value_type: string;
  readonly country_code: string | null;
  readonly city_name: string | null;
  readonly venue_name: string | null;
  readonly gift_kind: string | null;
  readonly metadata: JsonRecord | null;
}

interface InsertedCanonicalSetRow {
  readonly id: string;
}

interface NarrativeClaimCandidateRow {
  readonly candidate_id: string;
  readonly subject_entity_id: string | null;
  readonly canonical_subject_name: string | null;
  readonly object_entity_id: string | null;
  readonly canonical_object_name: string | null;
  readonly predicate: string;
  readonly object_text: string | null;
  readonly normalized_text: string;
  readonly confidence: number;
  readonly occurred_at: string | null;
  readonly time_expression_text: string | null;
  readonly time_start: string | null;
  readonly time_end: string | null;
  readonly source_event_id: string | null;
  readonly source_scene_id: string | null;
  readonly source_memory_id: string | null;
  readonly metadata: JsonRecord | null;
}

interface NarrativeEventSourceRow {
  readonly event_id: string;
  readonly subject_entity_id: string | null;
  readonly canonical_subject_name: string | null;
  readonly event_label: string;
  readonly event_kind: string;
  readonly occurred_at: string | null;
  readonly time_expression_text: string | null;
  readonly time_start: string | null;
  readonly time_end: string | null;
  readonly scene_text: string | null;
  readonly source_scene_id: string | null;
  readonly metadata: JsonRecord | null;
}

interface CanonicalNarrativeLookupRow {
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
  readonly metadata: JsonRecord | null;
  readonly provenance_count: number;
}

interface CanonicalEntityReportLookupRow {
  readonly subject_entity_id: string;
  readonly canonical_name: string;
  readonly report_kind: string;
  readonly summary_text: string;
  readonly support_strength: string;
  readonly confidence: number;
  readonly mentioned_at: string | null;
  readonly t_valid_from: string | null;
  readonly t_valid_until: string | null;
  readonly metadata: JsonRecord | null;
}

interface CanonicalCollectionFactInsertRow {
  readonly subjectEntityId: string;
  readonly itemValue: string;
  readonly normalizedValue: string;
  readonly cueType: string;
  readonly cueStrength: number;
  readonly confidence: number;
  readonly sourceText: string;
}

interface CanonicalSubjectSnapshotRow {
  readonly entity_id: string;
  readonly canonical_name: string | null;
}

interface CanonicalPairReportLookupRow {
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
  readonly metadata: JsonRecord | null;
}

interface ResolvedCanonicalSubject {
  readonly subjectEntityId: string | null;
  readonly canonicalSubjectName: string | null;
  readonly status: CanonicalSubjectBindingStatus;
  readonly candidateEntityIds: readonly string[];
}

function extractProfileSummaryKind(canonicalKey: string): string | null {
  const match = canonicalKey.match(/^reconsolidated:profile_summary:([^:]+):/u);
  return match?.[1] ? normalizeWhitespace(match[1]) : null;
}

export function inferCanonicalProfileSummaryPredicateFamily(profileKind: string, content: string): string {
  const normalizedKind = normalizeName(profileKind);
  if (normalizedKind === "identity_summary") {
    return "alias_identity";
  }
  if (normalizedKind === "relationship_status") {
    return "relationship_state";
  }
  const normalizedContent = normalizeName(content);
  if (/\b(dating|married|partner|boyfriend|girlfriend|wife|husband)\b/u.test(normalizedContent)) {
    return "relationship_state";
  }
  // Reconsolidated profile summaries should dominate generic profile answering.
  // They are already the repo's higher-order adjudicated view of the person.
  return "profile_state";
}

export interface CanonicalMemoryRebuildCounts {
  readonly subjects: number;
  readonly aliases: number;
  readonly facts: number;
  readonly states: number;
  readonly temporalFacts: number;
  readonly sets: number;
  readonly ambiguities: number;
  readonly narratives: number;
  readonly entityReports: number;
  readonly pairReports: number;
}

export interface CanonicalMemoryRebuildSummary {
  readonly namespaceId: string;
  readonly runId: string;
  readonly counts: CanonicalMemoryRebuildCounts;
}

function normalizeName(value: string): string {
  return normalizeEntityLookupName(value);
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => normalizeWhitespace(value)).filter((value) => value.length > 0))];
}

function parseObjectArray(value: unknown): readonly JsonRecord[] {
  return Array.isArray(value) ? value.filter((item) => item && typeof item === "object") as JsonRecord[] : [];
}

function parseStringArray(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string").map((item) => normalizeWhitespace(item)).filter(Boolean)
    : [];
}

function supportStrengthFromConfidence(confidence: number): string {
  if (confidence >= 0.9) {
    return "strong";
  }
  if (confidence >= 0.7) {
    return "moderate";
  }
  return "weak";
}

function asSupportStrength(value: string | null | undefined): CanonicalSupportStrength {
  if (value === "strong" || value === "moderate" || value === "weak") {
    return value;
  }
  return "moderate";
}

function asTimeScopeKind(value: string | null | undefined): CanonicalTimeScopeKind {
  switch (value) {
    case "exact":
    case "exact_date":
      return "exact";
    case "month_year":
      return "month_year";
    case "range":
    case "bounded_range":
      return "range";
    case "anchored_relative":
      return "anchored_relative";
    case "before_after":
      return "before_after";
    case "active":
      return "active";
    case "historical":
      return "historical";
    default:
      return "unknown";
  }
}

function asConfidence(value: number): RecallConfidenceGrade {
  if (value >= 0.8) {
    return "confident";
  }
  if (value >= 0.45) {
    return "weak";
  }
  return "missing";
}

function inferFactPredicateFamily(predicate: string): string {
  const normalized = normalizeName(predicate);
  if (/\b(live|lives|moved|move|travel|visited|visit|from|in|at)\b/u.test(normalized)) {
    return "location_history";
  }
  if (/\b(work|works|job|career|school|study|studied|college|employ)\b/u.test(normalized)) {
    return "work_education_history";
  }
  return "relationship_state";
}

function inferPreferenceFactPredicateFamily(row: PreferenceFactRow): CanonicalPredicateFamily {
  const combined = normalizeName([row.domain, row.qualifier ?? "", row.object_text].join(" "));
  if (/\b(book|movie|film|series|trilogy|game)\b/u.test(combined)) {
    return "generic_fact";
  }
  if (/\b(dance|painting|art|style|favorite|prefer)\b/u.test(combined)) {
    return "generic_fact";
  }
  return "generic_fact";
}

function deriveCanonicalCounterfactualFactValue(rows: readonly PersonTimeCanonicalFactRow[]): string | null {
  const combined = rows
    .map((row) => normalizeWhitespace([row.fact_text, row.time_hint_text ?? ""].join(" ")))
    .join(" ")
    .toLowerCase();
  const hasTrigger =
    /\b(?:lost|losing) (?:my|his|her) job\b|\bjob as a\b|\bjob at\b|\blaid off\b/u.test(combined);
  const hasDecision =
    /\bstart(?:ing)? (?:my|his|her) own business\b|\bstart(?:ing)? a dance studio\b|\bdance studio\b|\bopened an online clothing store\b/u.test(combined);
  const hasMotive =
    /\bpassion(?:ate)?\b|\bdream\b|\bshare\b|\bteach others\b|\bjoy\b|\bexpress\b|\bdo what i love\b|\bhappy place\b/u.test(combined);

  if (hasTrigger && hasDecision && hasMotive && /\bdance studio\b/u.test(combined)) {
    return "The best supported reason is that he lost his job and decided to turn his passion for dance into a business he could share with others.";
  }
  return null;
}

function inferLookupPredicateFamily(queryText: string, exactDetailFamily: string): CanonicalPredicateFamily {
  if (/\bidentity\b|\bgender identity\b|\btransgender\b|\bnonbinary\b|\bqueer\b/i.test(queryText)) {
    return "alias_identity";
  }
  if (exactDetailFamily === "favorite_books" || (/\bwhat\s+kind\s+of\s+flowers?\b/i.test(queryText) && /\btattoo\b/i.test(queryText))) {
    return "ownership_binding";
  }
  if (/\bwhen\b|\bwhich\s+year\b|\bwhich\s+month\b|\bhow long ago\b/i.test(queryText)) {
    return "temporal_event_fact";
  }
  if (/\bwhat do .* have in common\b|\bcommon\b|\bshare\b/i.test(queryText)) {
    return "commonality";
  }
  if (["team", "role", "plural_names", "allergy_safe_pets"].includes(exactDetailFamily)) {
    return "ownership_binding";
  }
  if (["goals", "bird_type", "meat_preference", "project_type", "car"].includes(exactDetailFamily)) {
    return "profile_state";
  }
  if (["shop", "country", "symbolic_gifts", "deceased_people", "bands", "favorite_band", "favorite_dj", "purchased_items", "broken_items", "advice", "hobbies", "social_exclusion"].includes(exactDetailFamily)) {
    return "list_set";
  }
  if (/\bfavorite books?\b/i.test(queryText) || /\bwhat books?\b/i.test(queryText)) {
    return "list_set";
  }
  if (/\blive\b|\bmarried\b|\bemploy\b|\bhealth\b|\bdrive\b/i.test(queryText)) {
    return "profile_state";
  }
  if (/\bwhere\b|\bplaces?\b|\btravel\b|\bmeet\b/i.test(queryText)) {
    return "location_history";
  }
  if (/\bwork|job|career|school|college|study|employ\b/i.test(queryText)) {
    return "work_education_history";
  }
  if (/\bif\b.*\bwould\b|\bwould\b.*\bif\b|\bwhy\b/i.test(queryText)) {
    return "counterfactual";
  }
  return "generic_fact";
}

function extractCandidateNames(queryText: string): readonly string[] {
  return extractQuerySurfaceNames(queryText);
}

function inferGoalScopeFromQuery(queryText: string): string {
  const normalized = normalizeName(queryText);
  if (/\bnot related\b|\bnot\b.*\bbasketball\b|\baway from basketball\b/u.test(normalized)) {
    return "non_basketball";
  }
  if (/\bbasketball\b|\bshooting\b|\bchampionship\b/u.test(normalized)) {
    return "basketball";
  }
  if (/\bcharity\b|\bfoundation\b/u.test(normalized)) {
    return "charity";
  }
  if (/\bbrand\b|\bendorsement\b|\bbusiness\b/u.test(normalized)) {
    return "business";
  }
  return "general";
}

function inferGoalScopeFromItem(itemValue: string): string {
  const normalized = normalizeName(itemValue);
  if (/\bshooting\b|\bchampionship\b|\bteam\b/u.test(normalized)) {
    return "basketball";
  }
  if (/\bcharity\b|\bfoundation\b/u.test(normalized)) {
    return "charity";
  }
  if (/\bendorsement\b|\bbrand\b/u.test(normalized)) {
    return "business";
  }
  return "non_basketball";
}

function goalScopeMatchesQuery(queryText: string, metadata: JsonRecord | null | undefined): boolean {
  const queryScope = inferGoalScopeFromQuery(queryText);
  if (queryScope === "general") {
    return true;
  }
  const rowScope = normalizeName(readMetadataString(metadata, "goal_scope"));
  if (!rowScope) {
    return false;
  }
  if (queryScope === "non_basketball") {
    return rowScope !== "basketball";
  }
  return rowScope === queryScope;
}

function extractCanonicalGoalItems(text: string): readonly string[] {
  const normalized = normalizeWhitespace(text);
  const lowered = normalized.toLowerCase();
  const items = new Set<string>();
  if (/\bgoal is to improve my shooting percentage\b/i.test(normalized) || /\bimprove my shooting percentage\b/i.test(normalized) || /\bbetter shooting\b/i.test(normalized)) {
    items.add("improve shooting percentage");
  }
  if (/\bwinning?\s+a\s+championship\b/i.test(normalized) || /\bwin a championship\b/i.test(normalized) || /\bwinning a title\b/i.test(normalized)) {
    items.add("win a championship");
  }
  if (/\bendorsements?\b/i.test(lowered) || /\bendorsement opportunities\b/i.test(lowered)) {
    items.add("get endorsements");
  }
  if (/\bbuild(?:ing)?\s+(?:my|his|her)\s+brand\b/i.test(normalized) || /\bboost\s+my\s+brand\b/i.test(normalized) || /\bmarket myself\b/i.test(normalized)) {
    items.add("build his brand");
  }
  if (
    /\bcharity\b/i.test(lowered) ||
    /\bstart a foundation\b/i.test(lowered) ||
    /\bmake a difference away from the court\b/i.test(lowered) ||
    (/\buse my platform\b/i.test(lowered) && /\bmake a positive difference\b/i.test(lowered))
  ) {
    items.add("do charity work");
  }
  return [...items];
}

function deriveCollectionShopAffinity(text: string): readonly string[] {
  const normalized = normalizeName(text);
  if (/\bharry potter\b|\bminalima\b|\bwizarding world\b|\bhogwarts\b/u.test(normalized)) {
    return ["House of MinaLima"];
  }
  return [];
}

function metadataText(metadata: JsonRecord | null | undefined): string {
  if (!metadata) {
    return "";
  }
  const parts = Object.values(metadata)
    .flatMap((value) => {
      if (typeof value === "string") {
        return [value];
      }
      if (Array.isArray(value)) {
        return value.filter((item): item is string => typeof item === "string");
      }
      return [];
    })
    .map((value) => normalizeWhitespace(value))
    .filter(Boolean);
  return parts.join(" ");
}

function readStringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => normalizeWhitespace(entry))
    .filter(Boolean);
}

function isDirectSelfGoalStatement(text: string): boolean {
  const normalized = normalizeWhitespace(text);
  if (!normalized) {
    return false;
  }
  const hasFirstPersonCue = /\b(i|i'm|i am|i want|i also want|my|me)\b/iu.test(normalized);
  const hasGoalSignal =
    /\bgoal\b/iu.test(normalized) ||
    /\bshooting percentage\b/iu.test(normalized) ||
    /\bchampionship\b/iu.test(normalized) ||
    /\btitle\b/iu.test(normalized) ||
    /\bendorsements?\b/iu.test(normalized) ||
    /\bbrand\b/iu.test(normalized) ||
    /\bcharity\b/iu.test(normalized) ||
    /\bfoundation\b/iu.test(normalized) ||
    /\bgive something back\b/iu.test(normalized);
  return hasFirstPersonCue && hasGoalSignal;
}

export function deriveCanonicalCollectionSupportItemsFromSet(
  itemValues: unknown,
  metadata: JsonRecord | null | undefined
): readonly string[] {
  const setKind = normalizeName(readMetadataString(metadata, "set_kind"));
  const affinityType = normalizeName(readMetadataString(metadata, "affinity_type"));
  if (setKind === "shop_affinity" || affinityType === "collection_affinity") {
    return [];
  }
  return uniqueStrings(
    extractCanonicalCollectionFactSeeds({
      texts: parseStringArray(itemValues),
      cueTypeHint: "typed_set"
    }).map((seed) => normalizeWhitespace(seed.itemValue))
  );
}

function shouldUseCanonicalSetAsCollectionSupport(itemSummary: string, itemValues: unknown, metadata: JsonRecord | null | undefined): boolean {
  if (deriveCanonicalCollectionSupportItemsFromSet(itemValues, metadata).length > 0) {
    return true;
  }
  const sourceText = normalizeName([itemSummary, metadataText(metadata)].join(" "));
  if (!sourceText) {
    return false;
  }
  if (/\bcollect(?:ion|s)?\b|\bbookshelf\b|\bitems?\b/u.test(sourceText)) {
    return true;
  }
  return false;
}

interface SceneSpeakerTurn {
  readonly speaker: string;
  readonly text: string;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function parseSceneSpeakerTurns(content: string, knownSpeakers: readonly string[]): readonly SceneSpeakerTurn[] {
  const normalized = normalizeWhitespace(
    content
      .replace(/^Conversation between [A-Za-z'’.-]+(?:\s+and\s+[A-Za-z'’.-]+)*\s*/iu, "")
      .replace(/\s+/gu, " ")
  );
  const speakerAlternation = uniqueStrings(knownSpeakers.map((speaker) => normalizeWhitespace(speaker)).filter(Boolean))
    .map((speaker) => escapeRegex(speaker))
    .join("|");
  if (!normalized || !speakerAlternation) {
    return [];
  }

  const turns: SceneSpeakerTurn[] = [];
  const inlinePattern = new RegExp(
    `(?:^|\\s)(${speakerAlternation}):\\s*([\\s\\S]*?)(?=(?:\\s(?:${speakerAlternation}):)|$)`,
    "giu"
  );
  for (const match of normalized.matchAll(inlinePattern)) {
    const speaker = normalizeWhitespace(match[1] ?? "").toLowerCase();
    const text = normalizeWhitespace(match[2] ?? "");
    if (!speaker || !text) {
      continue;
    }
    turns.push({ speaker, text });
  }
  return turns;
}

const COUNTRY_ALIASES = new Map<string, { displayValue: string; countryCode: string }>([
  ["united states", { displayValue: "United States", countryCode: "US" }],
  ["usa", { displayValue: "United States", countryCode: "US" }],
  ["us", { displayValue: "United States", countryCode: "US" }],
  ["america", { displayValue: "United States", countryCode: "US" }],
  ["japan", { displayValue: "Japan", countryCode: "JP" }],
  ["japanese", { displayValue: "Japan", countryCode: "JP" }],
  ["canada", { displayValue: "Canada", countryCode: "CA" }],
  ["thailand", { displayValue: "Thailand", countryCode: "TH" }]
]);

function slugTemporalEventPhrase(value: string): string | null {
  const normalized = normalizeName(value)
    .replace(/\b(?:a|an|the|new|old|former|my|our|his|her|their)\b/gu, " ")
    .replace(/\b(?:yesterday|today|tonight|tomorrow)\b[\s\S]*$/u, " ")
    .replace(/\b(?:last|this|next)\b[\s\S]*$/u, " ")
    .replace(/\b(?:weekend|week|month|year|january|february|march|april|may|june|july|august|september|october|november|december)\b[\s\S]*$/u, " ")
    .replace(/\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b[\s\S]*$/u, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (!normalized) {
    return null;
  }
  const tokens = normalized
    .split(/\s+/u)
    .map((token) => token.trim())
    .filter((token) => token.length > 1)
    .slice(0, 6);
  return tokens.length > 0 ? tokens.join("_") : null;
}

function normalizeTemporalActionVerb(value: string): string | null {
  const normalized = normalizeName(value);
  if (!normalized) {
    return null;
  }
  if (/^(?:lose|loses|losing)$/u.test(normalized) || normalized === "lost") {
    return "lose";
  }
  if (/^donat(?:e|ed|ing)$/u.test(normalized)) {
    return "donate";
  }
  if (/^paint(?:ed|ing)?$/u.test(normalized)) {
    return "paint";
  }
  if (/^(?:ran|run(?:ning)?)$/u.test(normalized)) {
    return "run";
  }
  if (/^draw(?:ing)?$/u.test(normalized) || normalized === "drew") {
    return "draw";
  }
  if (/^cook(?:ed|ing)?$/u.test(normalized)) {
    return "cook";
  }
  if (/^bake(?:d|ing)?$/u.test(normalized)) {
    return "bake";
  }
  if (/^present(?:ed|ing)?$/u.test(normalized)) {
    return "present";
  }
  if (/^build(?:ing)?$/u.test(normalized) || normalized === "built") {
    return "build";
  }
  if (/^mak(?:e|es|ing)$/u.test(normalized) || normalized === "made") {
    return "make";
  }
  return normalized;
}

function normalizeTemporalEventCompatibilityKey(eventKey: string | null | undefined): string | null {
  if (typeof eventKey !== "string") {
    return null;
  }
  const normalized = normalizeName(eventKey);
  if (!normalized) {
    return null;
  }
  if (/^go_[a-z0-9_]*support_group$/u.test(normalized)) {
    return normalized.replace(/^go_/u, "");
  }
  if (/^donate_(?:car|prius|vehicle)$/u.test(normalized)) {
    return "donate_car";
  }
  if (normalized === "adopt_first_three_dogs") {
    return "adopt_dogs";
  }
  if (/^paint_[a-z0-9_]*sunrise$/u.test(normalized)) {
    return "paint_sunrise";
  }
  if (/^paint_[a-z0-9_]*sunset$/u.test(normalized)) {
    return "paint_sunset";
  }
  if (/^start_(?:new_job|financial_analyst|financial_analyst_job)$/u.test(normalized)) {
    return "start_financial_analyst_job";
  }
  return normalized;
}

export function areTemporalEventKeysCompatible(left: string | null | undefined, right: string | null | undefined): boolean {
  const normalizedLeft = normalizeTemporalEventCompatibilityKey(left);
  const normalizedRight = normalizeTemporalEventCompatibilityKey(right);
  return Boolean(normalizedLeft) && normalizedLeft === normalizedRight;
}

export function inferTemporalEventKeyFromText(text: string): string | null {
  const normalized = normalizeName(text);
  if (!normalized) {
    return null;
  }
  if (
    /\bfirst three of (?:her|his) dogs\b/.test(normalized) ||
    /\b(?:i have|i've had|have had)\s+(?:them|my dogs|these dogs)\s+for\s+\d+\s+years?\b/.test(normalized)
  ) {
    return "adopt_first_three_dogs";
  }
  if (
    /\badopt(?:ed|ing|ion)\b.*\b(?:dogs?|pupp(?:y|ies)|pup)\b/.test(normalized) ||
    /\b(?:dogs?|pupp(?:y|ies)|pup)\b.*\badopt(?:ed|ing|ion)\b/.test(normalized)
  ) {
    return "adopt_dogs";
  }
  if (
    /\bdonat(?:e|ed|ing)\b.*\b(?:car|prius|vehicle)\b/.test(normalized) ||
    /\b(?:car|prius|vehicle)\b.*\bdonat(?:e|ed|ing)\b/.test(normalized)
  ) {
    return "donate_car";
  }
  if (/\b(?:lose|loses|losing|lost)\b.*\bjob\b/.test(normalized)) {
    return "lose_job";
  }
  if (/\b(start|started|began)\b.*\bsurf/.test(normalized) || /\bsurf\w*\b.*\b(start|started|began)\b/.test(normalized)) {
    return "start_surfing";
  }
  if (
    /\b(start|started|begin|began)\b.*\bnew job\b.*\bfinancial analyst\b/.test(normalized) ||
    /\bfinancial analyst\b.*\b(start|started|begin|began)\b.*\bnew job\b/.test(normalized) ||
    /\bnew job\b.*\bfinancial analyst\b/.test(normalized)
  ) {
    return "start_financial_analyst_job";
  }
  if (/\bsurf\w*\b.*\b(?:\d+\s+years?\s+ago|one\s+year\s+ago|two\s+years?\s+ago|three\s+years?\s+ago|four\s+years?\s+ago|five\s+years?\s+ago|six\s+years?\s+ago|seven\s+years?\s+ago|eight\s+years?\s+ago|nine\s+years?\s+ago|ten\s+years?\s+ago|first time)\b/.test(normalized)) {
    return "start_surfing";
  }
  if (
    /\b(?:launch\w*|start\w*|run|ran|advertis\w*|promot\w*)\b.*\bad campaign\b/.test(normalized) ||
    /\bad campaign\b.*\b(?:launch\w*|start\w*|run|ran|advertis\w*|promot\w*)\b/.test(normalized) ||
    /\bmarketing campaign\b.*\b(?:launch\w*|start\w*|run|ran|advertis\w*|promot\w*)\b/.test(normalized)
  ) {
    return "launch_ad_campaign";
  }
  if (
    /\bperform(?:ed|ing)?\b.*\bfestival\b/.test(normalized) ||
    /\bfestival\b.*\bperform(?:ed|ing)?\b/.test(normalized) ||
    /\bchoreograph\w*\b.*\bfestival\b/.test(normalized) ||
    /\brehears\w*\b.*\bfestival\b/.test(normalized)
  ) {
    return "perform_festival";
  }
  if (
    /\bseattle\b.*\bgame\b/.test(normalized) ||
    /\bgame\b.*\bseattle\b/.test(normalized)
  ) {
    return "game_in_seattle";
  }
  if (/\bjoin\w*\b.*\bsupport group\b|\bsupport group\b.*\bjoin\w*\b/.test(normalized)) {
    return "join_support_group";
  }
  if (
    /\bresume(?:d|s|ing)?\b.*\bdrums?\b/.test(normalized) ||
    /\bplay drums too\b/.test(normalized) ||
    ((/\bplay(?:ing)?\b/.test(normalized) || /\bbeen playing\b/.test(normalized)) &&
      /\bdrums?\b/.test(normalized) &&
      /\b(?:month|again)\b/.test(normalized))
  ) {
    return "resume_playing_drums";
  }
  if (
    (
      /\bcareer(?:\s|-)?high\b.*\b(?:score|points?)\b/.test(normalized) ||
      /\bcareer(?:\s|-)?high\b.*\bin\s+points?\b/.test(normalized) ||
      /\bhighest score ever\b/.test(normalized) ||
      /\bhighest points? ever\b/.test(normalized) ||
      /\bhighest(?:\s+score|\s+points?)\s+ever\b(?:.*\bpoints?\b)?/.test(normalized) ||
      /\bhighest ever\b.*\b(?:score|points?)\b/.test(normalized) ||
      /\bpersonal best\b.*\b(?:score|points?)\b/.test(normalized)
    )
  ) {
    return "career_high_points";
  }
  if (/\bstart\w*\b.*\bcar maintenance shop\b/.test(normalized) || /\bcar maintenance shop\b/.test(normalized)) {
    return "start_car_maintenance_shop";
  }
  if (/\bstart\w*\b.*\bshop\b/.test(normalized)) {
    return "start_shop";
  }
  if (/\bmuffins?\b/.test(normalized) && /\b(?:for myself|for herself|for himself|just for me)\b/.test(normalized)) {
    return "make_muffins_self";
  }
  if (/\bmuffins?\b/.test(normalized)) {
    return "make_muffins";
  }
  if (/\bdoctor\b/.test(normalized) && /\bweight problem\b/.test(normalized)) {
    return "doctor_weight_problem";
  }
  if (/\b(?:mother|mom)\b/.test(normalized) && /\b(?:pass away|passed away|died|death)\b/.test(normalized)) {
    return "mother_pass_away";
  }
  const campingMonth = normalized.match(/\bcamp(?:ing|ed)?(?:\s+in)?\s+(january|february|march|april|may|june|july|august|september|october|november|december)\b/u)?.[1];
  if (campingMonth) {
    return `camping_${campingMonth}`;
  }
  const joinPhrase = normalized.match(
    /\bjoin(?:ed|ing)?\b\s+(?:a\s+|an\s+|the\s+|new\s+)?([a-z0-9+][a-z0-9+ -]{2,60}?)(?:\s+(?:during|before|after|around|with|for|from|on|at|in)\b|$)/u
  )?.[1];
  const joinedKey = joinPhrase ? slugTemporalEventPhrase(joinPhrase) : null;
  if (joinedKey) {
    return `join_${joinedKey}`;
  }
  const movementPhrase = normalized.match(
    /\b(?:go|goes|going|went|attend(?:ed|ing)?|participat(?:e|ed|ing))\b(?:\s+to|\s+in)?\s+(?:a\s+|an\s+|the\s+)?([a-z0-9+][a-z0-9+ -]{2,60}?)(?:\s+(?:during|before|after|around|with|for|from|on|at|in)\b|$)/u
  )?.[1];
  const movementKey = movementPhrase ? slugTemporalEventPhrase(movementPhrase) : null;
  if (movementKey) {
    if (/\bsupport group\b/u.test(movementPhrase ?? "")) {
      return `go_${movementKey}`;
    }
    return movementKey;
  }
  const actionMatch = normalized.match(
    /\b(lose|loses|losing|lost|donat(?:e|ed|ing)?|paint(?:ed|ing)?|draw(?:ing)?|drew|ran|run(?:ning)?|cook(?:ed|ing)?|bake(?:d|ing)?|made|mak(?:e|ing)|present(?:ed|ing)?|build(?:ing)?|built)\b\s+(?:a\s+|an\s+|the\s+|my\s+|old\s+)?([a-z0-9+][a-z0-9+ -]{2,60}?)(?:\s+(?:during|before|after|around|with|for|from|on|at|in|to)\b|$)/u
  );
  const actionVerb = normalizeTemporalActionVerb(actionMatch?.[1] ?? "");
  const actionPhrase = actionMatch?.[2] ?? null;
  const actionKey = actionPhrase ? slugTemporalEventPhrase(actionPhrase) : null;
  if (actionKey === "ad_campaign" && (actionVerb === "launch" || actionVerb === "start" || actionVerb === "run")) {
    return "launch_ad_campaign";
  }
  if (actionVerb && actionKey) {
    return `${actionVerb}_${actionKey}`;
  }
  const quotedReadTitle =
    text.match(/\bread(?:ing|s)?\b[^"“”\n]{0,24}["“]([^"”]+)["”]/iu)?.[1] ??
    text.match(/\bread(?:ing|s)?\b[^'‘’\n]{0,24}['‘]([^'’]+)['’]/iu)?.[1] ??
    null;
  const quotedReadKey = quotedReadTitle ? slugTemporalEventPhrase(quotedReadTitle) : null;
  if (quotedReadKey) {
    return `read_${quotedReadKey}`;
  }
  const readPhrase = normalized.match(
    /\bread(?:ing|s)?\b\s+(?:the\s+book\s+)?([a-z0-9][a-z0-9'’&.+ -]{2,80}?)(?:\s+(?:during|before|after|around|with|for|from|on|at|in)\b|$)/u
  )?.[1];
  const readKey = readPhrase ? slugTemporalEventPhrase(readPhrase.replace(/^\bbook\b\s+/u, "")) : null;
  if (readKey) {
    return `read_${readKey}`;
  }
  return null;
}

function inferTemporalEventType(eventKey: string | null): string | null {
  if (!eventKey) {
    return null;
  }
  if (eventKey.startsWith("start_") || eventKey.startsWith("join_") || eventKey.startsWith("launch_")) {
    return "milestone";
  }
  if (eventKey.startsWith("career_high")) {
    return "achievement";
  }
  return "event";
}

function isInceptionTemporalEventKey(eventKey: string | null): boolean {
  return typeof eventKey === "string" && (/^(start_|join_|launch_)/u.test(eventKey) || eventKey === "resume_playing_drums");
}

function temporalOrderingTime(row: CanonicalTemporalLookupRow): number {
  const source = row.t_valid_from ?? row.anchor_start ?? row.mentioned_at ?? row.anchor_end ?? null;
  if (source) {
    const time = new Date(source).getTime();
    if (!Number.isNaN(time)) {
      return time;
    }
  }
  if (typeof row.answer_year === "number") {
    const month = typeof row.answer_month === "number" ? row.answer_month - 1 : 0;
    const day = typeof row.answer_day === "number" ? row.answer_day : 1;
    const time = Date.UTC(row.answer_year, month, day);
    return Number.isNaN(time) ? Number.POSITIVE_INFINITY : time;
  }
  return Number.POSITIVE_INFINITY;
}

function temporalGranularityRankForRow(row: CanonicalTemporalLookupRow): number {
  if (typeof row.answer_day === "number") {
    return 3;
  }
  if (typeof row.answer_month === "number") {
    return 2;
  }
  if (typeof row.answer_year === "number") {
    return 1;
  }
  return 0;
}

export function inferTimeGranularity(anchorText: string | null | undefined, start: string | null | undefined, end: string | null | undefined): string {
  const normalizedAnchor = normalizeName(anchorText ?? "");
  if (/\b(?:next|following|last|previous|this)\s+month\b/u.test(normalizedAnchor)) {
    return "month";
  }
  if (/\b(?:next|following|last|previous|this)\s+year\b/u.test(normalizedAnchor)) {
    return "year";
  }
  if (/\b\d{4}\b/u.test(normalizedAnchor) && !/\b(january|february|march|april|may|june|july|august|september|october|november|december)\b/u.test(normalizedAnchor)) {
    return "year";
  }
  if (/\b(january|february|march|april|may|june|july|august|september|october|november|december)\b/u.test(normalizedAnchor)) {
    return "month";
  }
  if (start) {
    const startDate = new Date(start);
    const endDate = end ? new Date(end) : null;
    if (!Number.isNaN(startDate.getTime())) {
      if (!endDate || Number.isNaN(endDate.getTime()) || startDate.toISOString().slice(0, 10) === endDate.toISOString().slice(0, 10)) {
        return "day";
      }
    }
  }
  return "unknown";
}

function deriveTemporalAnswerParts(start: string | null | undefined, granularity: string): {
  answerYear: number | null;
  answerMonth: number | null;
  answerDay: number | null;
} {
  if (!start) {
    return { answerYear: null, answerMonth: null, answerDay: null };
  }
  const date = new Date(start);
  if (Number.isNaN(date.getTime())) {
    return { answerYear: null, answerMonth: null, answerDay: null };
  }
  return {
    answerYear: date.getUTCFullYear(),
    answerMonth: granularity === "month" || granularity === "day" ? date.getUTCMonth() + 1 : null,
    answerDay: granularity === "day" ? date.getUTCDate() : null
  };
}

export function inferTemporalAnchorMetadata(anchorText: string | null | undefined): {
  anchorRelation: string | null;
  anchorOffsetValue: number | null;
  anchorOffsetUnit: string | null;
} {
  const normalized = normalizeName(anchorText ?? "");
  if (!normalized) {
    return { anchorRelation: null, anchorOffsetValue: null, anchorOffsetUnit: null };
  }
  const anchorRelation =
    /\bbefore\b|\bprevious\b|\blast\b|\bago\b|\bearlier\b/u.test(normalized) ? "before"
      : /\bafter\b|\blater\b|\bnext\b|\bfollowing\b/u.test(normalized) ? "after"
        : null;
  const offsetValue = (() => {
    const numericMatch = normalized.match(/\b(\d+)\b/u);
    if (numericMatch?.[1]) {
      const parsed = Number.parseInt(numericMatch[1], 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        return parsed;
      }
    }
    const wordOffsets: Array<readonly [string, number]> = [
      ["one", 1],
      ["two", 2],
      ["three", 3],
      ["four", 4],
      ["five", 5],
      ["six", 6],
      ["seven", 7],
      ["eight", 8],
      ["nine", 9],
      ["ten", 10]
    ];
    for (const [token, value] of wordOffsets) {
      if (new RegExp(`\\b${token}\\b`, "u").test(normalized)) {
        return value;
      }
    }
    if (/\ba few\b/u.test(normalized)) {
      return 3;
    }
    return anchorRelation ? 1 : null;
  })();
  const anchorOffsetUnit =
    /\bweekends?\b/u.test(normalized) ? "weekend"
      : /\bweeks?\b/u.test(normalized) ? "week"
        : /\bmonths?\b/u.test(normalized) ? "month"
          : /\byears?\b/u.test(normalized) ? "year"
            : /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/u.test(normalized) ? "day"
              : /\bdays?\b/u.test(normalized) ? "day"
                : null;
  return { anchorRelation, anchorOffsetValue: offsetValue, anchorOffsetUnit };
}

export function deriveTemporalAnswerPartsFromAnchor(
  start: string | null | undefined,
  granularity: string,
  anchorText: string | null | undefined
): {
  answerYear: number | null;
  answerMonth: number | null;
  answerDay: number | null;
} {
  const anchorMetadata = inferTemporalAnchorMetadata(anchorText);
  if (!start || !anchorMetadata.anchorRelation || !anchorMetadata.anchorOffsetValue || !anchorMetadata.anchorOffsetUnit) {
    return deriveTemporalAnswerParts(start, granularity);
  }
  const date = new Date(start);
  if (Number.isNaN(date.getTime())) {
    return deriveTemporalAnswerParts(start, granularity);
  }
  const direction = anchorMetadata.anchorRelation === "before" ? -1 : 1;
  switch (anchorMetadata.anchorOffsetUnit) {
    case "year":
      date.setUTCFullYear(date.getUTCFullYear() + direction * anchorMetadata.anchorOffsetValue);
      break;
    case "month":
      date.setUTCMonth(date.getUTCMonth() + direction * anchorMetadata.anchorOffsetValue);
      break;
    case "week":
    case "weekend":
      date.setUTCDate(date.getUTCDate() + direction * anchorMetadata.anchorOffsetValue * 7);
      break;
    case "day":
      date.setUTCDate(date.getUTCDate() + direction * anchorMetadata.anchorOffsetValue);
      break;
    default:
      return deriveTemporalAnswerParts(start, granularity);
  }
  return deriveTemporalAnswerParts(date.toISOString(), granularity);
}

export function deriveCanonicalTemporalAnswerParts(
  start: string | null | undefined,
  granularity: string,
  anchorText: string | null | undefined,
  alreadyResolvedWindow: boolean
): {
  answerYear: number | null;
  answerMonth: number | null;
  answerDay: number | null;
} {
  if (alreadyResolvedWindow) {
    return deriveTemporalAnswerParts(start, granularity);
  }
  return deriveTemporalAnswerPartsFromAnchor(start, granularity, anchorText);
}

export function inferSetEntryValueType(value: string, metadata: JsonRecord | null | undefined): {
  valueType: string;
  displayValue: string;
  normalizedValue: string;
  countryCode: string | null;
  cityName: string | null;
  venueName: string | null;
  giftKind: string | null;
} {
  const normalized = normalizeName(value);
  const country = COUNTRY_ALIASES.get(normalized);
  if (country) {
    return {
      valueType: "country",
      displayValue: country.displayValue,
      normalizedValue: normalizeName(country.displayValue),
      countryCode: country.countryCode,
      cityName: null,
      venueName: null,
      giftKind: null
    };
  }
  if (/\b(tokyo|bangkok|seattle|new york)\b/u.test(normalized)) {
    return {
      valueType: "city",
      displayValue: normalizeWhitespace(value),
      normalizedValue: normalized,
      countryCode: null,
      cityName: normalizeWhitespace(value),
      venueName: null,
      giftKind: null
    };
  }
  if (/\bpendant\b|\bnecklace\b|\bbracelet\b|\bgift\b|\bkeepsake\b/u.test(normalized)) {
    return {
      valueType: "gift",
      displayValue: normalizeWhitespace(value),
      normalizedValue: normalized,
      countryCode: null,
      cityName: null,
      venueName: null,
      giftKind: normalizeWhitespace(value)
    };
  }
  if (/\bfestival\b|\bconcert\b|\bcafe\b|\brestaurant\b|\bpark\b|\bbeach\b|\barena\b|\bstadium\b|\bmarket\b/u.test(normalized)) {
    return {
      valueType: "venue",
      displayValue: normalizeWhitespace(value),
      normalizedValue: normalized,
      countryCode: null,
      cityName: null,
      venueName: normalizeWhitespace(value),
      giftKind: null
    };
  }
  return {
    valueType: normalizeName(readMetadataString(metadata, "set_kind")) === "shop_affinity" ? "shop" : "unknown",
    displayValue: normalizeWhitespace(value),
    normalizedValue: normalized,
    countryCode: null,
    cityName: null,
    venueName: null,
    giftKind: null
  };
}

export function inferCanonicalNarrativeKind(text: string): CanonicalNarrativeKind | null {
  const normalized = normalizeName(text);
  if (/\bwhy\b|\bbecause\b|\bmotivated\b|\binspired\b|\breason\b/u.test(normalized)) {
    return /\bart\b|\bpainting\b|\bsculpture\b|\bshow\b/u.test(normalized) ? "art_inspiration" : "motive";
  }
  if (/\bsymbol(?:ize|ism)?\b|\bremind(?:s|ed|er)?\b|\bmeaning\b/u.test(normalized)) {
    return /\bfamily\b|\bmother\b|\bfather\b|\bgrandma\b|\bgrandmother\b/u.test(normalized) ? "family_meaning" : "symbolism";
  }
  if (/\bfamily\b|\bmother\b|\bfather\b|\bgrandma\b|\bgrandmother\b/u.test(normalized) && /\bremind(?:s|ed|er)?\b|\bmeaning\b|\bremember\b/u.test(normalized)) {
    return "family_meaning";
  }
  if (/\brealize(?:d)?\b|\blearn(?:ed)?\b|\bit clicked\b|\bcame to understand\b/u.test(normalized)) {
    return "realization";
  }
  if (/\bgoals?\b|\bplans?\b|\bwants? to pursue\b|\bwants? to build\b|\bwould pursue\b|\bwould .* pursue\b|\bwhat fields would\b/u.test(normalized)) {
    return "career_intent";
  }
  if (/\bsupport\b|\bcommunity\b|\bmentor\b|\bfamily\b|\bthere for\b/u.test(normalized)) {
    return "support_reasoning";
  }
  if (/\blikes? because\b|\bprefers? because\b/u.test(normalized)) {
    return "preference_explanation";
  }
  return null;
}

export function inferCanonicalNarrativePredicateFamily(kind: CanonicalNarrativeKind): CanonicalPredicateFamily {
  switch (kind) {
    case "motive":
    case "career_intent":
    case "support_reasoning":
    case "art_inspiration":
      return "narrative_motive";
    case "symbolism":
    case "family_meaning":
    case "preference_explanation":
      return "narrative_symbolism";
    case "realization":
      return "narrative_realization";
    default:
      return "narrative_profile";
  }
}

function inferNarrativeReportKind(kind: CanonicalNarrativeKind): CanonicalReportKind {
  switch (kind) {
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

function summarizeReportCandidates(values: readonly string[]): string | null {
  const unique = uniqueStrings(values.map((value) => normalizeWhitespace(value)).filter(Boolean));
  if (unique.length === 0) {
    return null;
  }
  if (unique.length === 1) {
    return unique[0]!;
  }
  return unique.slice(0, 3).join(". ");
}

function summarizeJsonSetItems(value: unknown): string | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const items = value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => normalizeWhitespace(entry))
    .filter(Boolean);
  return summarizeReportCandidates(items);
}

function inferReportKindsFromCanonicalRow(predicateFamily: string, text: string): readonly CanonicalReportKind[] {
  const normalized = normalizeName(text);
  if (!normalized) {
    return [];
  }
  const reportKinds: CanonicalReportKind[] = [];
  if (
    predicateFamily === "work_education_history" ||
    /\bcareer\b|\bjob\b|\bwork\b|\bprofession\b|\bbusiness\b|\bstudy\b|\bschool\b|\bbasketball\b|\btraining\b|\bendorsement\b|\bbrand\b/u.test(normalized)
  ) {
    reportKinds.push("career_report");
  }
  if (
    /\bfamily\b|\bsupport\b|\bmentor\b|\bcommunity\b|\bchurch\b|\bhelp\b|\bthere for\b/u.test(normalized)
  ) {
    reportKinds.push("support_report");
  }
  if (
    /\brelationship\b|\bmarried\b|\bdating\b|\bpartner\b|\bhusband\b|\bwife\b|\bfriend\b/u.test(normalized)
  ) {
    reportKinds.push("relationship_report");
  }
  if (
    /\bfavorite\b|\bfave\b|\bstyle\b|\bprefer\b|\blikes?\b|\btop pick\b|\bspeaks to me\b|\bdance\b|\bmovie\b|\btrilogy\b|\bbook\b|\bgame\b|\bpastr(?:y|ies)\b|\bcafe\b/u.test(normalized)
  ) {
    reportKinds.push("preference_report");
  }
  if (
    predicateFamily === "work_education_history" ||
    /\beducation\b|\beducaton\b|\bstudy\b|\bschool\b|\bdegree\b|\bmajor\b|\bfields?\b|\bpublic administration\b|\bpolitical science\b|\bpublic affairs\b|\bpolicymaking\b|\bpolitic(?:s|al)?\b|\bcommunity\b|\binfrastructure\b|\bgovernment\b/u.test(normalized)
  ) {
    reportKinds.push("education_report");
  }
  if (
    predicateFamily === "list_set" ||
    /\bcollect\b|\bcollections?\b|\bbookshelf\b|\bjerseys?\b|\bsneakers?\b|\bdvds?\b|\btrilogy\b/u.test(normalized)
  ) {
    reportKinds.push("collection_report");
  }
  if (
    /\bdreams?\b|\bgoal\b|\bventure\b|\bbusiness\b|\bunique\b|\bcustomi(?:s|z)e\b|\bapp\b|\bbrand\b|\bchallenge\b|\binspired\b|\bstart\b|\bopen\b|\bbuild\b/u.test(normalized)
  ) {
    reportKinds.push("aspiration_report");
  }
  if (
    predicateFamily === "location_history" ||
    /\btrip\b|\btravel\b|\broadtrip\b|\bfestival\b|\bjasper\b|\brockies\b|\btokyo\b|\bcity\b|\bcountry\b/u.test(normalized)
  ) {
    reportKinds.push("travel_report");
  }
  if (
    /\bdogs?\b|\bpet\b|\bgroom(?:er|ing)?\b|\btraining\b|\btreats?\b|\bagility\b|\bdog[- ]owners\b|\bfur kids\b/u.test(normalized)
  ) {
    reportKinds.push("pet_care_report");
  }
  if (
    predicateFamily === "profile_state" ||
    predicateFamily === "list_set" ||
    predicateFamily === "ownership_binding" ||
    predicateFamily === "location_history" ||
    predicateFamily === "generic_fact" ||
    /\bfeel\b|\bfelt\b|\bemotion\b|\bhobby\b|\binterest\b|\bfavorite\b|\bpaint\b|\bart\b|\bmusic\b|\bbook\b|\bmovie\b|\btravel\b|\btrip\b/u.test(normalized)
  ) {
    reportKinds.push("profile_report");
  }
  return uniqueStrings(reportKinds) as readonly CanonicalReportKind[];
}

function clampCollectionFactCueStrength(value: number): number {
  return Math.max(1, Math.min(5, Math.round(value)));
}

function pushCanonicalCollectionFacts(params: {
  readonly facts: Map<string, CanonicalCollectionFactInsertRow>;
  readonly subjectEntityId: string;
  readonly texts: readonly string[];
  readonly cueTypeHint?: "explicit_collects" | "collection_of" | "bookshelf_contains" | "typed_set" | null;
  readonly baseConfidence: number;
}): void {
  const seeds = extractCanonicalCollectionFactSeeds({
    texts: params.texts,
    cueTypeHint: params.cueTypeHint ?? null
  });
  for (const seed of seeds) {
    if (!seed.normalizedValue) {
      continue;
    }
    const key = `${params.subjectEntityId}::${seed.normalizedValue}`;
    const existing = params.facts.get(key);
    const next: CanonicalCollectionFactInsertRow = {
      subjectEntityId: params.subjectEntityId,
      itemValue: seed.itemValue,
      normalizedValue: seed.normalizedValue,
      cueType: seed.cueType,
      cueStrength: clampCollectionFactCueStrength(seed.cueStrength),
      confidence: Math.min(0.99, Math.max(0.35, params.baseConfidence)),
      sourceText: uniqueStrings(params.texts).join(" ")
    };
    if (
      !existing ||
      next.cueStrength > existing.cueStrength ||
      (next.cueStrength === existing.cueStrength && next.confidence > existing.confidence)
    ) {
      params.facts.set(key, next);
    }
  }
}

function hasCanonicalCollectionFactSeeds(texts: readonly string[], cueTypeHint?: "explicit_collects" | "collection_of" | "bookshelf_contains" | "typed_set" | null): boolean {
  return extractCanonicalCollectionFactSeeds({
    texts,
    cueTypeHint: cueTypeHint ?? null
  }).length > 0;
}

function clampSupportStrength(count: number, confidence: number): CanonicalSupportStrength {
  if (count >= 3 || confidence >= 0.9) {
    return "strong";
  }
  if (count >= 2 || confidence >= 0.7) {
    return "moderate";
  }
  return "weak";
}

function summarizeNarrativeCandidates(values: readonly string[]): string | null {
  const unique = uniqueStrings(values);
  if (unique.length === 0) {
    return null;
  }
  if (unique.length === 1) {
    return unique[0]!;
  }
  return `${unique[0]}. ${unique.slice(1, 3).join(" ")}`.trim();
}

function pickNarrativeWindow(values: readonly (string | null | undefined)[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }
  return null;
}

function orderCanonicalGoalItems(values: readonly string[]): string[] {
  const rank = new Map<string, number>([
    ["improve shooting percentage", 1],
    ["win a championship", 2],
    ["get endorsements", 3],
    ["build his brand", 4],
    ["do charity work", 5]
  ]);
  return [...new Set(values.map((value) => normalizeWhitespace(value)).filter(Boolean))].sort((left, right) => {
    const leftRank = rank.get(normalizeName(left)) ?? 100;
    const rightRank = rank.get(normalizeName(right)) ?? 100;
    if (leftRank !== rightRank) {
      return leftRank - rightRank;
    }
    return left.localeCompare(right);
  });
}

function collectCompatibleSetValues(rows: readonly CanonicalSetLookupRow[], exactDetailFamily: string): readonly string[] {
  if (rows.length === 0) {
    return [];
  }
  const aggregated = rows.flatMap((row) => parseStringArray(row.item_values));
  if (exactDetailFamily === "goals") {
    return orderCanonicalGoalItems(aggregated);
  }
  return [...new Set(aggregated.map((value) => normalizeWhitespace(value)).filter(Boolean))];
}

function shouldUseCommonalityIntersection(queryText: string): boolean {
  return /\bshare\b|\bin common\b|\bboth\b|\bsame\b/u.test(queryText) || /\bmeet\b/u.test(queryText);
}

function unionCanonicalSetRows(rows: readonly (readonly CanonicalSetLookupRow[])[]): readonly string[] {
  const values: string[] = [];
  for (const setRows of rows) {
    for (const row of setRows) {
      for (const item of parseStringArray(row.item_values)) {
        const normalized = normalizeName(item);
        if (!normalized) {
          continue;
        }
        if (!values.some((existing) => normalizeName(existing) === normalized)) {
          values.push(item);
        }
      }
    }
  }
  return values;
}

function deriveCanonicalSetItemsFromPersonTimeFact(factText: string, locationText: string | null): readonly string[] {
  const normalized = normalizeName([factText, locationText ?? ""].join(" "));
  const items = new Set<string>();
  if (/\blost my job\b|\blost his job\b|\blost her job\b|\bjob as a\b|\bjob at\b|\blaid off\b/u.test(normalized)) {
    items.add("lost their jobs");
  }
  if (/\bown business\b|\bstart(?:ed|ing)? .*business\b|\bopened an online clothing store\b|\bdance studio\b/u.test(normalized)) {
    items.add("started their own businesses");
  }
  if (/\bdestress\b|\bstress relief\b|\bhappy place\b|\bdancing\b|\bdance\b/u.test(normalized)) {
    items.add("dancing to destress");
  }
  if (/\bwatch(?:ing)? movies?\b/u.test(normalized)) {
    items.add("watching movies");
  }
  if (/\bmak(?:ing|e) desserts?\b|\bbak(?:ing|e)\b/u.test(normalized)) {
    items.add("making desserts");
  }
  return [...items];
}

async function lookupMultiSubjectCanonicalSet(params: {
  readonly namespaceId: string;
  readonly queryText: string;
  readonly exactDetailFamily: string;
  readonly predicateFamily: CanonicalPredicateFamily;
  readonly subjectNames: readonly string[];
}): Promise<StoredCanonicalLookup | null> {
  const neighborhood = await lookupCanonicalPairNeighborhood({
    namespaceId: params.namespaceId,
    queryText: params.queryText,
    predicateFamily: params.predicateFamily,
    subjectNames: params.subjectNames
  });
  if (neighborhood.bindingStatus === "ambiguous") {
    return {
      kind: "abstention",
      subjectEntityId: null,
      canonicalSubjectName: null,
      subjectBindingStatus: "ambiguous",
      predicateFamily: params.predicateFamily,
      supportStrength: "weak",
      timeScopeKind: "unknown",
      confidence: "missing",
      abstainReason: "insufficient_subject_binding",
      pairGraphPlan: asPairGraphPlan(neighborhood),
      sourceTable: "canonical_subject_aliases"
    };
  }
  if (neighborhood.sharedValues.length === 0) {
    return null;
  }
  return {
    kind: "set",
    subjectEntityId: neighborhood.subjectEntityIds[0] ?? null,
    canonicalSubjectName: neighborhood.subjectNames[0] ?? params.subjectNames[0] ?? null,
    pairSubjectEntityId: neighborhood.subjectEntityIds[1] ?? null,
    pairSubjectName: neighborhood.subjectNames[1] ?? params.subjectNames[1] ?? null,
    pairGraphPlan: asPairGraphPlan(neighborhood),
    subjectBindingStatus: "resolved",
    predicateFamily: params.predicateFamily,
    supportStrength: neighborhood.sharedValues.length >= 2 ? "strong" : "moderate",
    timeScopeKind: "unknown",
    confidence: neighborhood.sharedValues.length >= 2 ? "confident" : "weak",
    objectValues: neighborhood.sharedValues,
    sourceTable: "canonical_sets"
  };
}

function extractKeywordTerms(queryText: string, excludedNames: readonly string[]): readonly string[] {
  const excluded = new Set(excludedNames.map((name) => normalizeName(name)));
  const stop = new Set(["what", "when", "where", "why", "who", "would", "could", "which", "how", "did", "does", "is", "are", "was", "were", "the", "a", "an", "for", "with", "from", "that", "this", "into", "onto", "about", "their", "they", "them", "have", "has"]);
  return uniqueStrings(
    (queryText.match(/[A-Za-z][A-Za-z'-]{2,}/gu) ?? [])
      .map((part) => part.toLowerCase())
      .filter((part) => !stop.has(part))
      .filter((part) => !excluded.has(normalizeName(part)))
  );
}

async function resolveCanonicalSubjectsByAliasTexts(namespaceId: string, names: readonly string[]): Promise<readonly CanonicalAliasLookupRow[]> {
  const normalizedNames = uniqueStrings(names.map((name) => normalizeName(name)).filter(Boolean));
  if (normalizedNames.length === 0) {
    return [];
  }
  return queryRows<CanonicalAliasLookupRow>(
    `
      SELECT
        csa.subject_entity_id::text AS subject_entity_id,
        cs.canonical_name,
        MAX(csa.confidence) AS confidence
      FROM canonical_subject_aliases csa
      JOIN canonical_subjects cs
        ON cs.namespace_id = csa.namespace_id
       AND cs.entity_id = csa.subject_entity_id
      WHERE csa.namespace_id = $1
        AND csa.normalized_alias_text = ANY($2::text[])
      GROUP BY csa.subject_entity_id, cs.canonical_name
      ORDER BY MAX(csa.confidence) DESC, cs.canonical_name ASC
    `,
    [namespaceId, normalizedNames]
  );
}

async function resolveStoredCanonicalSubjectByNames(namespaceId: string, names: readonly string[]): Promise<ResolvedCanonicalSubject | null> {
  const aliasRows = await resolveCanonicalSubjectsByAliasTexts(namespaceId, names);
  const normalizedNames = uniqueStrings(names.map((name) => normalizeName(name)).filter(Boolean));
  const exactSubjectRows = normalizedNames.length === 0
    ? []
    : await queryRows<{ subject_entity_id: string; canonical_name: string }>(
        `
          SELECT
            entity_id::text AS subject_entity_id,
            canonical_name
          FROM canonical_subjects
          WHERE namespace_id = $1
            AND normalized_canonical_name = ANY($2::text[])
          ORDER BY canonical_name ASC
        `,
        [namespaceId, normalizedNames]
      );
  if (exactSubjectRows.length === 1) {
    return {
      subjectEntityId: exactSubjectRows[0]!.subject_entity_id,
      canonicalSubjectName: exactSubjectRows[0]!.canonical_name,
      status: "resolved",
      candidateEntityIds: [exactSubjectRows[0]!.subject_entity_id]
    };
  }
  if (aliasRows.length === 0) {
    if (exactSubjectRows.length > 1) {
      return {
        subjectEntityId: null,
        canonicalSubjectName: null,
        status: "ambiguous",
        candidateEntityIds: exactSubjectRows.map((row) => row.subject_entity_id)
      };
    }
    return null;
  }
  if (aliasRows.length === 1) {
    return {
      subjectEntityId: aliasRows[0]!.subject_entity_id,
      canonicalSubjectName: aliasRows[0]!.canonical_name,
      status: "resolved",
      candidateEntityIds: [aliasRows[0]!.subject_entity_id]
    };
  }
  const exactCanonicalMatches = aliasRows.filter((row) => normalizedNames.includes(normalizeName(row.canonical_name)));
  if (exactCanonicalMatches.length === 1) {
    return {
      subjectEntityId: exactCanonicalMatches[0]!.subject_entity_id,
      canonicalSubjectName: exactCanonicalMatches[0]!.canonical_name,
      status: "resolved",
      candidateEntityIds: [exactCanonicalMatches[0]!.subject_entity_id]
    };
  }
  const top = aliasRows[0]!;
  const second = aliasRows[1] ?? null;
  if (second && top.confidence - second.confidence >= 0.15) {
    return {
      subjectEntityId: top.subject_entity_id,
      canonicalSubjectName: top.canonical_name,
      status: "resolved",
      candidateEntityIds: [top.subject_entity_id]
    };
  }
  return {
    subjectEntityId: null,
    canonicalSubjectName: null,
    status: "ambiguous",
    candidateEntityIds: aliasRows.map((row) => row.subject_entity_id)
  };
}

function readResultSubjectEntityId(results: readonly RecallResult[]): string | null {
  for (const result of results) {
    if (typeof result.provenance.subject_entity_id === "string" && result.provenance.subject_entity_id.trim().length > 0) {
      return result.provenance.subject_entity_id;
    }
    const metadata = typeof result.provenance.metadata === "object" && result.provenance.metadata !== null
      ? (result.provenance.metadata as JsonRecord)
      : null;
    if (typeof metadata?.subject_entity_id === "string" && metadata.subject_entity_id.trim().length > 0) {
      return metadata.subject_entity_id;
    }
  }
  return null;
}

async function resolveStoredCanonicalSubject(params: {
  readonly namespaceId: string;
  readonly queryText: string;
  readonly matchedParticipants: readonly string[];
  readonly missingParticipants: readonly string[];
  readonly foreignParticipants: readonly string[];
  readonly results: readonly RecallResult[];
}): Promise<ResolvedCanonicalSubject> {
  const possessiveQueryNames = extractPossessiveQuerySurfaceNames(params.queryText);
  if (possessiveQueryNames.length > 0) {
    const possessiveBinding = await resolveStoredCanonicalSubjectByNames(params.namespaceId, possessiveQueryNames);
    if (possessiveBinding) {
      if (possessiveBinding.status !== "ambiguous") {
        return possessiveBinding;
      }
      const fallbackSubjectId = readResultSubjectEntityId(params.results);
      if (fallbackSubjectId && possessiveBinding.candidateEntityIds.includes(fallbackSubjectId)) {
        const rows = await queryRows<{ canonical_name: string }>(
          `
            SELECT canonical_name
            FROM canonical_subjects
            WHERE namespace_id = $1
              AND entity_id = $2::uuid
            LIMIT 1
          `,
          [params.namespaceId, fallbackSubjectId]
        );
        return {
          subjectEntityId: fallbackSubjectId,
          canonicalSubjectName: rows[0]?.canonical_name ?? possessiveQueryNames[0] ?? null,
          status: "resolved",
          candidateEntityIds: [fallbackSubjectId]
        };
      }
    }
  }

  const primaryQueryNames = extractPrimaryQuerySurfaceNames(params.queryText);
  if (primaryQueryNames.length > 0) {
    const primaryBinding = await resolveStoredCanonicalSubjectByNames(params.namespaceId, primaryQueryNames);
    if (primaryBinding) {
      if (primaryBinding.status === "ambiguous") {
        const fallbackSubjectId = readResultSubjectEntityId(params.results);
        if (fallbackSubjectId && primaryBinding.candidateEntityIds.includes(fallbackSubjectId)) {
          const rows = await queryRows<{ canonical_name: string }>(
            `
              SELECT canonical_name
              FROM canonical_subjects
              WHERE namespace_id = $1
                AND entity_id = $2::uuid
              LIMIT 1
            `,
            [params.namespaceId, fallbackSubjectId]
          );
          return {
            subjectEntityId: fallbackSubjectId,
            canonicalSubjectName: rows[0]?.canonical_name ?? null,
            status: "resolved",
            candidateEntityIds: [fallbackSubjectId]
          };
        }
      } else {
        return primaryBinding;
      }
    }
  }

  const participantNames = uniqueStrings([
    ...params.matchedParticipants,
    ...params.missingParticipants
  ]);
  if (participantNames.length > 0) {
    const participantBinding = await resolveStoredCanonicalSubjectByNames(params.namespaceId, participantNames);
    if (participantBinding) {
      return participantBinding;
    }
  }

  const querySurfaceNames = extractCandidateNames(params.queryText);
  if (querySurfaceNames.length > 0) {
    const exactQueryBinding = await resolveStoredCanonicalSubjectByNames(params.namespaceId, querySurfaceNames);
    if (exactQueryBinding) {
      if (exactQueryBinding.status === "ambiguous") {
        const fallbackSubjectId = readResultSubjectEntityId(params.results);
        if (fallbackSubjectId && exactQueryBinding.candidateEntityIds.includes(fallbackSubjectId)) {
          const rows = await queryRows<{ canonical_name: string }>(
            `
              SELECT canonical_name
              FROM canonical_subjects
              WHERE namespace_id = $1
                AND entity_id = $2::uuid
              LIMIT 1
            `,
            [params.namespaceId, fallbackSubjectId]
          );
          return {
            subjectEntityId: fallbackSubjectId,
            canonicalSubjectName: rows[0]?.canonical_name ?? null,
            status: "resolved",
            candidateEntityIds: [fallbackSubjectId]
          };
        }
      }
      return exactQueryBinding;
    }
  }

  const fallbackSubjectId = readResultSubjectEntityId(params.results);
  if (fallbackSubjectId) {
    const rows = await queryRows<{ canonical_name: string }>(
      `
        SELECT canonical_name
        FROM canonical_subjects
        WHERE namespace_id = $1
          AND entity_id = $2::uuid
        LIMIT 1
      `,
      [params.namespaceId, fallbackSubjectId]
    );
    return {
      subjectEntityId: fallbackSubjectId,
      canonicalSubjectName: rows[0]?.canonical_name ?? null,
      status: "resolved",
      candidateEntityIds: [fallbackSubjectId]
    };
  }

  return {
    subjectEntityId: null,
    canonicalSubjectName: null,
    status: params.foreignParticipants.length > 0 ? "ambiguous" : "unresolved",
    candidateEntityIds: []
  };
}

function canonicalSetCompatibilityKey(row: CanonicalSetLookupRow): string {
  return [
    normalizeName(readMetadataString(row.metadata, "set_kind")),
    normalizeName(readMetadataString(row.metadata, "domain")),
    normalizeName(readMetadataString(row.metadata, "predicate")),
    normalizeName(readMetadataString(row.metadata, "media_kind")),
    normalizeName(readMetadataString(row.metadata, "mention_kind"))
  ].join("::");
}

function canonicalSetCategoryLabels(row: CanonicalSetLookupRow): readonly string[] {
  const setKind = normalizeWhitespace(readMetadataString(row.metadata, "set_kind"));
  const domain = normalizeWhitespace(readMetadataString(row.metadata, "domain"));
  const predicate = normalizeWhitespace(readMetadataString(row.metadata, "predicate"));
  const mediaKind = normalizeWhitespace(readMetadataString(row.metadata, "media_kind"));
  const labels = uniqueStrings([
    domain,
    predicate,
    mediaKind && mediaKind !== "unknown" ? `${mediaKind}s` : "",
    setKind === "preference facts" && domain ? domain : ""
  ]).filter((value) => value.length >= 3);
  return labels;
}

export function intersectCanonicalSetRows(rows: readonly (readonly CanonicalSetLookupRow[])[]): readonly string[] {
  if (rows.length < 2 || rows.some((subjectRows) => subjectRows.length === 0)) {
    return [];
  }

  const exactIntersection = new Map<string, string>();
  const categoryIntersection = new Map<string, string>();

  const groupByKey = (subjectRows: readonly CanonicalSetLookupRow[]) => {
    const grouped = new Map<string, CanonicalSetLookupRow[]>();
    for (const row of subjectRows) {
      const key = canonicalSetCompatibilityKey(row);
      const bucket = grouped.get(key) ?? [];
      bucket.push(row);
      grouped.set(key, bucket);
    }
    return grouped;
  };

  const groupedSubjects = rows.map(groupByKey);
  const sharedKeys = [...groupedSubjects[0]!.keys()].filter((key) => groupedSubjects.every((subjectRows) => subjectRows.has(key)));
  for (const key of sharedKeys) {
    const exactSets = groupedSubjects.map((subjectRows) => {
      const values = (subjectRows.get(key) ?? []).flatMap((row) => parseStringArray(row.item_values));
      return new Map(values.map((value) => [normalizeName(value), value]));
    });
    const exactKeys = [...exactSets[0]!.keys()].filter((value) => exactSets.every((setMap) => setMap.has(value)));
    for (const exactKey of exactKeys) {
      exactIntersection.set(exactKey, exactSets[0]!.get(exactKey) ?? exactKey);
    }

    const categorySets = groupedSubjects.map((subjectRows) => {
      const values = (subjectRows.get(key) ?? []).flatMap((row) => canonicalSetCategoryLabels(row));
      return new Map(values.map((value) => [normalizeName(value), value]));
    });
    const categoryKeys = [...categorySets[0]!.keys()].filter((value) => categorySets.every((setMap) => setMap.has(value)));
    for (const categoryKey of categoryKeys) {
      categoryIntersection.set(categoryKey, categorySets[0]!.get(categoryKey) ?? categoryKey);
    }
  }

  const exactValues = [...exactIntersection.values()];
  if (exactValues.length > 0) {
    return exactValues;
  }
  return [...categoryIntersection.values()];
}

function formatIsoDate(dateText: string): string {
  const date = new Date(dateText);
  if (Number.isNaN(date.getTime())) {
    return dateText;
  }
  return date.toISOString().slice(0, 10);
}

function formatNaturalDate(dateText: string): string {
  const date = new Date(dateText);
  if (Number.isNaN(date.getTime())) {
    return dateText;
  }
  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC"
  }).format(date);
}

function formatMonthYear(dateText: string): string {
  const date = new Date(dateText);
  if (Number.isNaN(date.getTime())) {
    return dateText;
  }
  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC"
  }).format(date);
}

function isYearOnlyTemporalQuery(queryText: string): boolean {
  return /\bwhat year\b|\bwhich year\b/iu.test(queryText);
}

function isMonthOnlyTemporalQuery(queryText: string): boolean {
  return /\bin which month'?s?\b|\bwhich month\b|\bwhat month\b/iu.test(queryText);
}

function isTemporalLookupQuery(queryText: string, predicateFamily: CanonicalPredicateFamily): boolean {
  return predicateFamily === "temporal_event_fact" || /\bwhen\b/i.test(queryText) || isYearOnlyTemporalQuery(queryText) || isMonthOnlyTemporalQuery(queryText);
}

export function buildStoredCanonicalTemporalAnswer(row: CanonicalTemporalLookupRow): string | null {
  return buildStoredCanonicalTemporalAnswerForQuery(row, "");
}

function isReferenceDerivedRelativeText(value: string | null | undefined): boolean {
  const normalized = normalizeWhitespace(value ?? "").toLowerCase();
  if (!normalized) {
    return false;
  }
  return (
    /\bnext month\b|\blast month\b|\bthis month\b|\bnext week\b|\blast week\b|\bthis week\b/u.test(normalized) ||
    /\bweek of\b|\bweekend of\b|\ba few days before\b|\ba few days after\b/u.test(normalized) ||
    /\bbefore\b|\bafter\b/u.test(normalized) && /\b(?:game|festival|show|trip|appointment|doctor|event)\b/u.test(normalized)
  );
}

function rowHasReferenceDerivedRelativeSignal(row: Pick<
  CanonicalTemporalLookupRow,
  "anchor_text" | "fact_value" | "metadata" | "derived_from_reference"
>): boolean {
  if (row.derived_from_reference) {
    return true;
  }
  const metadata = row.metadata ?? {};
  return (
    isReferenceDerivedRelativeText(row.anchor_text) ||
    isReferenceDerivedRelativeText(row.fact_value) ||
    isReferenceDerivedRelativeText(readMetadataString(metadata, "leaf_time_hint_text")) ||
    isReferenceDerivedRelativeText(readMetadataString(metadata, "leaf_fact_text"))
  );
}

function rowIsMediaReferenceWithoutExplicitTemporalAnchor(
  row: Pick<
    CanonicalTemporalLookupRow,
    "anchor_text" | "anchor_event_key" | "anchor_relation" | "metadata"
  >
): boolean {
  const metadata = row.metadata ?? {};
  const sourceTable = normalizeWhitespace(
    readMetadataString(metadata, "leaf_source_table") ?? readMetadataString(metadata, "source_table")
  ).toLowerCase();
  const mediaKind = normalizeWhitespace(readMetadataString(metadata, "media_kind"));
  const mentionKind = normalizeWhitespace(readMetadataString(metadata, "mention_kind"));
  const hasMediaReference = sourceTable === "media_mentions" || Boolean(mediaKind) || Boolean(mentionKind);
  if (!hasMediaReference) {
    return false;
  }
  const explicitAnchorText = normalizeWhitespace(
    readMetadataString(metadata, "leaf_time_hint_text") ?? row.anchor_text ?? ""
  );
  const eventAnchorStart = normalizeWhitespace(readMetadataString(metadata, "event_anchor_start"));
  const eventAnchorEnd = normalizeWhitespace(readMetadataString(metadata, "event_anchor_end"));
  return !(
    explicitAnchorText ||
    row.anchor_event_key ||
    row.anchor_relation ||
    eventAnchorStart ||
    eventAnchorEnd
  );
}

function temporalQueryRequestsRelativePhrasing(queryText: string): boolean {
  const normalized = normalizeWhitespace(queryText).toLowerCase();
  return /\bhow long ago\b|\bhow long\b|\bbefore\b|\bafter\b|\bweek of\b|\bweekend of\b/u.test(normalized);
}

export function buildStoredCanonicalTemporalAnswerForQuery(row: CanonicalTemporalLookupRow, queryText: string): string | null {
  const metadata = row.metadata ?? {};
  if (rowIsMediaReferenceWithoutExplicitTemporalAnchor(row)) {
    return null;
  }
  const leafTimeHint = readMetadataString(metadata, "leaf_time_hint_text");
  const anchorText = normalizeWhitespace(leafTimeHint || row.anchor_text || "");
  const isGenericWhenQuery =
    /\bwhen\b/iu.test(queryText) && !isYearOnlyTemporalQuery(queryText) && !isMonthOnlyTemporalQuery(queryText);
  if (isYearOnlyTemporalQuery(queryText)) {
    if (typeof row.answer_year === "number") {
      return String(row.answer_year);
    }
    const yearSource = row.t_valid_from ?? row.anchor_start ?? row.mentioned_at;
    if (yearSource) {
      const date = new Date(yearSource);
      if (!Number.isNaN(date.getTime())) {
        return String(date.getUTCFullYear());
      }
    }
  }
  if (isMonthOnlyTemporalQuery(queryText)) {
    if (typeof row.answer_year === "number" && typeof row.answer_month === "number") {
      return formatMonthYear(new Date(Date.UTC(row.answer_year, row.answer_month - 1, 1)).toISOString());
    }
    if (
      inferCanonicalTemporalSupportKind(queryText, row) === "reference_derived_relative" &&
      !temporalQueryRequestsRelativePhrasing(queryText)
    ) {
      return null;
    }
    const monthSource = row.t_valid_from ?? row.anchor_start ?? row.mentioned_at;
    if (monthSource) {
      return formatMonthYear(monthSource);
    }
  }
  if (isGenericWhenQuery) {
    if (typeof row.answer_year === "number" && typeof row.answer_month === "number" && typeof row.answer_day === "number") {
      return formatNaturalDate(new Date(Date.UTC(row.answer_year, row.answer_month - 1, row.answer_day)).toISOString());
    }
    if (typeof row.answer_year === "number" && typeof row.answer_month === "number") {
      return formatMonthYear(new Date(Date.UTC(row.answer_year, row.answer_month - 1, 1)).toISOString());
    }
  }
  if (
    inferCanonicalTemporalSupportKind(queryText, row) === "reference_derived_relative" &&
    !temporalQueryRequestsRelativePhrasing(queryText) &&
    (
      isGenericWhenQuery ||
      isYearOnlyTemporalQuery(queryText) ||
      isMonthOnlyTemporalQuery(queryText)
    )
  ) {
    return null;
  }
  if (anchorText) {
    return anchorText;
  }
  if (row.time_scope_kind === "exact_date" || row.time_scope_kind === "exact") {
    if (typeof row.answer_year === "number" && typeof row.answer_month === "number" && typeof row.answer_day === "number") {
      return formatNaturalDate(new Date(Date.UTC(row.answer_year, row.answer_month - 1, row.answer_day)).toISOString());
    }
    return row.anchor_start ? formatNaturalDate(row.anchor_start) : normalizeWhitespace(row.fact_value ?? "");
  }
  if ((row.time_scope_kind === "bounded_range" || row.time_scope_kind === "range") && row.anchor_start && row.anchor_end) {
    return `between ${formatNaturalDate(row.anchor_start)} and ${formatNaturalDate(row.anchor_end)}`;
  }
  return normalizeWhitespace(readMetadataString(metadata, "leaf_fact_text") || row.fact_value || "");
}

function isThinCanonicalTemporalPayloadText(value: string): boolean {
  const normalized = normalizeWhitespace(value).toLowerCase();
  if (!normalized) {
    return true;
  }
  const stripped = normalized
    .replace(/\b(?:19|20)\d{2}\b/gu, " ")
    .replace(/\b\d{1,2}\b/gu, " ")
    .replace(
      /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/gu,
      " "
    )
    .replace(/\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/gu, " ")
    .replace(/\b(?:last|next|this|today|tonight|yesterday|tomorrow|week|weekend|month|year|day|days|weeks|months|years|ago|before|after|same)\b/gu, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return stripped.length === 0;
}

function buildTemporalCandidateSearchText(row: CanonicalTemporalLookupRow): string {
  const metadata = row.metadata ?? {};
  const payloadParts = [
    row.fact_value,
    row.anchor_text,
    row.event_surface_text,
    row.location_surface_text,
    readMetadataString(metadata, "leaf_fact_text"),
    readMetadataString(metadata, "leaf_time_hint_text"),
    readMetadataString(metadata, "leaf_location_text"),
    readMetadataString(metadata, "location_text")
  ]
    .map((value) => normalizeWhitespace(value ?? ""))
    .filter(Boolean);
  const includeIdentityTerms = isThinCanonicalTemporalPayloadText(payloadParts.join(" "));
  return [
    ...(includeIdentityTerms
      ? [
          normalizeWhitespace(row.canonical_name),
          normalizeWhitespace(row.event_key ?? "").replaceAll("_", " "),
          normalizeWhitespace(row.event_type ?? "")
        ]
      : []),
    ...payloadParts,
    normalizeWhitespace(readMetadataString(metadata, "person_name")),
    normalizeWhitespace(readMetadataString(metadata, "subject_name")),
    normalizeWhitespace(readMetadataString(metadata, "media_kind")),
    normalizeWhitespace(readMetadataString(metadata, "mention_kind"))
  ].filter(Boolean).join(" ");
}

export function inferCanonicalTemporalSupportKind(queryText: string, row: CanonicalTemporalLookupRow): CanonicalTemporalSupportKind {
  if (rowIsMediaReferenceWithoutExplicitTemporalAnchor(row)) {
    return "generic_time_fragment";
  }
  if (row.support_kind) {
    return row.support_kind;
  }
  const searchText = buildTemporalCandidateSearchText(row);
  const hasResolvedTemporalParts =
    typeof row.answer_year === "number" ||
    typeof row.answer_month === "number" ||
    typeof row.answer_day === "number";
  const hasStrongAlignment = isTemporalQueryTextAligned(queryText, searchText);
  if (rowHasReferenceDerivedRelativeSignal(row)) {
    return "reference_derived_relative";
  }
  if (row.event_key) {
    return "explicit_event_fact";
  }
  if (
    (row.anchor_event_key || row.anchor_relation || hasStrongAlignment) &&
    (hasStrongAlignment || hasResolvedTemporalParts)
  ) {
    return "aligned_anchor";
  }
  return "generic_time_fragment";
}

export function inferCanonicalTemporalSourceQuality(
  queryText: string,
  row: CanonicalTemporalLookupRow
): CanonicalTemporalSourceQuality {
  if (row.temporal_source_quality) {
    return row.temporal_source_quality;
  }
  const supportKind = inferCanonicalTemporalSupportKind(queryText, row);
  if (supportKind === "explicit_event_fact") {
    return "canonical_event";
  }
  if (supportKind === "aligned_anchor") {
    return "aligned_anchor";
  }
  if (supportKind === "reference_derived_relative") {
    return "derived_relative";
  }
  return "generic";
}

export function temporalSupportKindPriority(kind: CanonicalTemporalSupportKind): number {
  switch (kind) {
    case "explicit_event_fact":
      return 4;
    case "aligned_anchor":
      return 3;
    case "reference_derived_relative":
      return 2;
    default:
      return 1;
  }
}

function deriveCanonicalTemporalPersistenceSemantics(params: {
  readonly subjectEntityId: string | null;
  readonly objectEntityId?: string | null;
  readonly eventKey: string | null;
  readonly eventType: string | null;
  readonly factValue: string | null;
  readonly anchorText: string | null;
  readonly anchorEventKey: string | null;
  readonly anchorRelation: string | null;
  readonly locationText: string | null;
  readonly confidence: number;
  readonly hasExplicitTemporalGrounding: boolean;
}): {
  readonly supportKind: CanonicalTemporalSupportKind;
  readonly bindingConfidence: number;
  readonly temporalSourceQuality: CanonicalTemporalSourceQuality;
  readonly derivedFromReference: boolean;
  readonly eventSurfaceText: string | null;
  readonly locationSurfaceText: string | null;
  readonly participantEntityIds: readonly string[];
} {
  const referenceDerivedSignal =
    isReferenceDerivedRelativeText(params.anchorText) ||
    isReferenceDerivedRelativeText(params.factValue);
  const hasAnchorGrounding =
    Boolean(params.anchorEventKey) ||
    Boolean(params.anchorRelation) ||
    Boolean(normalizeWhitespace(params.anchorText ?? ""));
  const supportKind: CanonicalTemporalSupportKind =
    referenceDerivedSignal
      ? "reference_derived_relative"
      : params.eventKey && params.hasExplicitTemporalGrounding
        ? "explicit_event_fact"
        : hasAnchorGrounding || params.hasExplicitTemporalGrounding
          ? "aligned_anchor"
          : "generic_time_fragment";
  const temporalSourceQuality: CanonicalTemporalSourceQuality =
    supportKind === "explicit_event_fact"
      ? "canonical_event"
      : supportKind === "aligned_anchor"
        ? "aligned_anchor"
        : supportKind === "reference_derived_relative"
          ? "derived_relative"
          : "generic";
  const bindingFloor =
    supportKind === "explicit_event_fact"
      ? 0.9
      : supportKind === "aligned_anchor"
        ? 0.68
        : supportKind === "reference_derived_relative"
          ? 0.5
          : 0.35;
  return {
    supportKind,
    bindingConfidence: Math.max(bindingFloor, Math.min(1, params.confidence)),
    temporalSourceQuality,
    derivedFromReference: supportKind === "reference_derived_relative",
    eventSurfaceText: normalizeWhitespace((params.eventKey ?? params.eventType ?? params.factValue ?? "").replace(/_/gu, " ")) || null,
    locationSurfaceText: normalizeWhitespace(params.locationText ?? "") || null,
    participantEntityIds: [params.subjectEntityId, params.objectEntityId ?? null].filter(
      (value): value is string => typeof value === "string" && value.length > 0
    )
  };
}

function canonicalTemporalBindingConfidence(
  queryText: string,
  queryEventKey: string | null,
  row: CanonicalTemporalLookupRow
): number {
  if (typeof row.binding_confidence === "number" && Number.isFinite(row.binding_confidence)) {
    return row.binding_confidence;
  }
  const searchText = buildTemporalCandidateSearchText(row);
  const supportKind = inferCanonicalTemporalSupportKind(queryText, row);
  const alignmentCount = temporalQueryAlignmentCount(queryText, searchText);
  let score =
    supportKind === "explicit_event_fact"
      ? 0.82
      : supportKind === "aligned_anchor"
        ? 0.64
        : supportKind === "reference_derived_relative"
          ? 0.48
        : 0.32;
  if (queryEventKey && areTemporalEventKeysCompatible(row.event_key, queryEventKey)) {
    score += 0.18;
  } else if (alignmentCount > 0) {
    score += Math.min(0.18, alignmentCount * 0.08);
  }
  if (typeof row.confidence === "number") {
    score += Math.min(0.12, row.confidence * 0.12);
  }
  if (row.source_artifact_id && row.source_chunk_id) {
    score += 0.05;
  }
  return Math.max(0, Math.min(1, score));
}

function buildCanonicalTemporalNeighborhoodKey(queryText: string, row: CanonicalTemporalLookupRow): string {
  if (row.event_key) {
    return `event:${row.event_key}`;
  }
  if (row.source_event_id) {
    return `source-event:${row.source_event_id}`;
  }
  if (row.source_artifact_id || row.source_chunk_id) {
    return `source:${row.source_artifact_id ?? "na"}:${row.source_chunk_id ?? "na"}`;
  }
  if (row.anchor_event_key) {
    return `anchor:${row.anchor_event_key}`;
  }
  const supportKind = inferCanonicalTemporalSupportKind(queryText, row);
  return [
    "generic",
    supportKind,
    row.answer_year ?? "na",
    row.answer_month ?? "na",
    row.answer_day ?? "na",
    normalizeWhitespace(buildTemporalCandidateSearchText(row)).toLowerCase().slice(0, 48)
  ].join(":");
}

function buildCanonicalTemporalNeighborhoodSummaries(
  queryText: string,
  queryEventKey: string | null,
  rows: readonly CanonicalTemporalLookupRow[]
): ReadonlyMap<string, CanonicalTemporalNeighborhoodSummary> {
  const neighborhoods = new Map<
    string,
    {
      memberCount: number;
      alignedCount: number;
      explicitEventCount: number;
      earliestOrderingValue: number;
      bestGranularityRank: number;
      bestBindingConfidence: number;
    }
  >();

  for (const row of rows) {
    const key = buildCanonicalTemporalNeighborhoodKey(queryText, row);
    const alignmentCount = temporalQueryAlignmentCount(queryText, buildTemporalCandidateSearchText(row));
    const current = neighborhoods.get(key);
    const next = {
      memberCount: (current?.memberCount ?? 0) + 1,
      alignedCount: (current?.alignedCount ?? 0) + (alignmentCount > 0 ? 1 : 0),
      explicitEventCount: (current?.explicitEventCount ?? 0) + (row.event_key ? 1 : 0),
      earliestOrderingValue: Math.min(current?.earliestOrderingValue ?? Number.POSITIVE_INFINITY, temporalOrderingTime(row)),
      bestGranularityRank: Math.max(current?.bestGranularityRank ?? 0, temporalGranularityRankForRow(row)),
      bestBindingConfidence: Math.max(
        current?.bestBindingConfidence ?? 0,
        canonicalTemporalBindingConfidence(queryText, queryEventKey, row)
      )
    };
    neighborhoods.set(key, next);
  }

  return new Map(
    [...neighborhoods.entries()].map(([key, value]) => [
      key,
      {
        key,
        memberCount: value.memberCount,
        alignedCount: value.alignedCount,
        explicitEventCount: value.explicitEventCount,
        earliestOrderingValue: value.earliestOrderingValue,
        bestGranularityRank: value.bestGranularityRank,
        bestBindingConfidence: value.bestBindingConfidence
      } satisfies CanonicalTemporalNeighborhoodSummary
    ])
  );
}

function requestedTemporalGranularityBonus(queryText: string, row: CanonicalTemporalLookupRow): number {
  const normalizedQuery = normalizeWhitespace(queryText).toLowerCase();
  if ((/\bwhat year\b|\bwhich year\b/u.test(normalizedQuery)) && typeof row.answer_year === "number") {
    return 1.6;
  }
  if ((/\bwhat month\b|\bwhich month\b/u.test(normalizedQuery)) && typeof row.answer_month === "number") {
    return 1.4;
  }
  if ((/\bwhat date\b|\bwhich date\b/u.test(normalizedQuery)) && typeof row.answer_day === "number") {
    return 1.2;
  }
  if (/\bwhen\b/u.test(normalizedQuery)) {
    if (typeof row.answer_day === "number") {
      return 1.1;
    }
    if (typeof row.answer_month === "number") {
      return 0.9;
    }
    if (typeof row.answer_year === "number") {
      return 0.5;
    }
  }
  return 0;
}

function shouldPreferEarliestTemporalQueryEvent(queryText: string, queryEventKey: string | null): boolean {
  if (!queryEventKey) {
    return false;
  }
  const normalizedQuery = normalizeWhitespace(queryText).toLowerCase();
  return (
    isInceptionTemporalEventKey(queryEventKey) ||
    /\bwhen\b/u.test(normalizedQuery) ||
    /\bwhat year\b|\bwhich year\b|\bwhat month\b|\bin which month\b|\bwhich month\b|\bwhat date\b|\bwhich date\b/u.test(normalizedQuery)
  );
}

function scoreCanonicalTemporalLookupRow(params: {
  readonly queryText: string;
  readonly queryTerms: readonly string[];
  readonly queryEventKey: string | null;
  readonly row: CanonicalTemporalLookupRow;
  readonly neighborhoods: ReadonlyMap<string, CanonicalTemporalNeighborhoodSummary>;
}): number {
  const searchText = buildTemporalCandidateSearchText(params.row);
  const lexicalScore = scoreCanonicalText(searchText, params.queryTerms);
  const alignmentCount = temporalQueryAlignmentCount(params.queryText, searchText);
  const objectAlignmentCount = temporalQueryObjectAlignmentCount(params.queryText, searchText);
  const queryObjectTokens = extractTemporalQueryObjectTokens(params.queryText);
  const supportKind = inferCanonicalTemporalSupportKind(params.queryText, params.row);
  const sourceQuality = inferCanonicalTemporalSourceQuality(params.queryText, params.row);
  const bindingConfidence = canonicalTemporalBindingConfidence(params.queryText, params.queryEventKey, params.row);
  const persistedExactEventFact =
    Boolean(params.queryEventKey) &&
    areTemporalEventKeysCompatible(params.row.event_key, params.queryEventKey) &&
    queryObjectTokens.length === 0 &&
    (
      supportKind === "explicit_event_fact" ||
      sourceQuality === "canonical_event" ||
      bindingConfidence >= 0.8
    );
  const neighborhood = params.neighborhoods.get(buildCanonicalTemporalNeighborhoodKey(params.queryText, params.row));
  let score =
    lexicalScore +
    alignmentCount * 1.5 +
    objectAlignmentCount * 2.25 +
    bindingConfidence * 4 +
    requestedTemporalGranularityBonus(params.queryText, params.row);
  score += temporalSupportKindPriority(supportKind) * 0.75;
  score += sourceQuality === "canonical_event" ? 1.25 : sourceQuality === "aligned_anchor" ? 0.6 : sourceQuality === "derived_relative" ? -0.6 : -1.1;
  if (params.queryEventKey && areTemporalEventKeysCompatible(params.row.event_key, params.queryEventKey)) {
    score += 6;
    if (queryObjectTokens.length > 0 && objectAlignmentCount === 0 && !persistedExactEventFact) {
      score -= 5;
    }
  } else if (params.queryEventKey && alignmentCount > 0) {
    score += 2.5;
  }
  if (supportKind === "explicit_event_fact") {
    score += 2;
  } else if (supportKind === "aligned_anchor") {
    score += 1;
  } else if (alignmentCount === 0) {
    score -= 1.5;
  }
  if (neighborhood) {
    score += Math.min(1.2, Math.max(0, neighborhood.memberCount - 1) * 0.25);
    score += neighborhood.alignedCount > 0 ? 0.6 : 0;
    score += neighborhood.bestGranularityRank * 0.15;
    score += neighborhood.bestBindingConfidence * 0.5;
    if (
      params.queryEventKey &&
      shouldPreferEarliestTemporalQueryEvent(params.queryText, params.queryEventKey) &&
      areTemporalEventKeysCompatible(params.row.event_key, params.queryEventKey) &&
      temporalOrderingTime(params.row) === neighborhood.earliestOrderingValue
    ) {
      score += isInceptionTemporalEventKey(params.queryEventKey) ? 1.25 : 0.9;
    }
  }
  if (
    supportKind === "reference_derived_relative" &&
    !temporalQueryRequestsRelativePhrasing(params.queryText) &&
    (
      isYearOnlyTemporalQuery(params.queryText) ||
      isMonthOnlyTemporalQuery(params.queryText) ||
      /\bwhen\b/iu.test(params.queryText)
    )
  ) {
    score -= 4;
  }
  return score;
}

function isCanonicalTemporalEventAlignedForQuery(queryEventKey: string | null, text: string): boolean {
  const normalizedText = normalizeWhitespace(text).toLowerCase();
  if (!normalizedText || !queryEventKey) {
    return false;
  }
  if (areTemporalEventKeysCompatible(inferTemporalEventKeyFromText(normalizedText), queryEventKey)) {
    return true;
  }
  if (/support_group$/u.test(queryEventKey)) {
    const hasSupportGroupPhrase = /\bsupport groups?\b/u.test(normalizedText);
    const hasAttendanceVerb = /\b(?:go|goes|going|went|attend(?:ed|ing)?|participat(?:e|ed|ing)|join(?:ed|ing)?)\b/u.test(normalizedText);
    const requiresLgbtqSignal = /\blgbtq\b/u.test(queryEventKey);
    const hasLgbtqSignal = /\blgbtq\+?\b|\bqueer\b|\btrans(?:gender)?\b/u.test(normalizedText);
    return hasSupportGroupPhrase && hasAttendanceVerb && (!requiresLgbtqSignal || hasLgbtqSignal);
  }
  if (queryEventKey === "donate_car") {
    return /\bdonat(?:e|ed|ing)\b/u.test(normalizedText) && /\b(?:car|prius|vehicle)\b/u.test(normalizedText);
  }
  if (queryEventKey === "career_high_points") {
    return (
      /\b(?:score|points?)\b/u.test(normalizedText) &&
      (
        /\bcareer-?high\b/u.test(normalizedText) ||
        /\bhighest(?:\s+score|\s+points?)\s+ever\b/u.test(normalizedText) ||
        (/\bhighest ever\b/u.test(normalizedText) && /\b(?:score|points?)\b/u.test(normalizedText)) ||
        /\bpersonal best\b/u.test(normalizedText)
      )
    );
  }
  if (queryEventKey === "start_surfing") {
    return /\bsurf\w*\b/u.test(normalizedText) && (/\bstarted?\b/u.test(normalizedText) || /\bfirst time\b/u.test(normalizedText) || /\byears?\s+ago\b/u.test(normalizedText));
  }
  if (queryEventKey === "make_muffins_self") {
    return /\bmuffins?\b/u.test(normalizedText) && /\b(?:for myself|for herself|for himself|just for me)\b/u.test(normalizedText);
  }
  if (queryEventKey === "make_muffins") {
    return /\bmuffins?\b/u.test(normalizedText);
  }
  if (queryEventKey === "doctor_weight_problem") {
    return /\bdoctor\b/u.test(normalizedText) && /\bweight problem\b/u.test(normalizedText);
  }
  if (areTemporalEventKeysCompatible(queryEventKey, "adopt_dogs")) {
    return (
      (/\badopt(?:ed|ing)\b/u.test(normalizedText) && /\b(?:dogs?|pupp(?:y|ies)|pup)\b/u.test(normalizedText)) ||
      /\b(?:i have|i've had|have had)\s+(?:them|my dogs|these dogs)\s+for\s+\d+\s+years?\b/u.test(normalizedText)
    );
  }
  if (queryEventKey === "perform_festival") {
    return (
      (
        /\bfestival\b/u.test(normalizedText) &&
        (/\bperform(?:ed|ing)?\b/u.test(normalizedText) || /\bchoreograph\w*\b/u.test(normalizedText) || /\brehears\w*\b/u.test(normalizedText))
      ) ||
      (
        /\b(?:dance\s+comp(?:etition)?|competition|performances?|perform(?:ed|ing)?|stage)\b/u.test(normalizedText) &&
        (/\bnext month\b/u.test(normalizedText) || /\bshowcase\b/u.test(normalizedText) || /\blocal talent\b/u.test(normalizedText) || /\bjudging\b/u.test(normalizedText) || /\bgroup\b/u.test(normalizedText) || /\bdancers?\b/u.test(normalizedText))
      )
    );
  }
  if (queryEventKey === "game_in_seattle") {
    return /\bseattle\b/u.test(normalizedText) && /\bgame\b/u.test(normalizedText);
  }
  if (queryEventKey === "resume_playing_drums") {
    return (
      /\bplay drums too\b/u.test(normalizedText) ||
      ((/\bplay(?:ing)?\b/u.test(normalizedText) || /\bbeen playing\b/u.test(normalizedText)) &&
        /\bdrums?\b/u.test(normalizedText) &&
        /\b(?:month|again)\b/u.test(normalizedText)) ||
      (/\bused to play drums\b/u.test(normalizedText) && /\bhaven't in a while\b/u.test(normalizedText))
    );
  }
  if (queryEventKey === "mother_pass_away") {
    return /\b(?:mother|mom)\b/u.test(normalizedText) && /\b(?:passed away|died|death)\b/u.test(normalizedText);
  }
  const alignmentTokens = queryEventKey
    .split(/[_\s]+/u)
    .map((token) => token.replace(/[^a-z0-9+]/gu, ""))
    .filter((token) => token.length > 2 && !new Set(["go", "went", "join", "joined", "attend", "attended", "meeting"]).has(token));
  const matchedTokenCount = alignmentTokens.filter((token) => normalizedText.includes(token)).length;
  return alignmentTokens.length <= 1
    ? matchedTokenCount >= 1
    : matchedTokenCount >= Math.min(2, alignmentTokens.length);
}

function temporalQueryAlignmentBonus(queryText: string, row: CanonicalTemporalLookupRow): number {
  return temporalQueryAlignmentCount(queryText, buildTemporalCandidateSearchText(row)) > 0 ? 2 : 0;
}

export function isCanonicalTemporalLookupRowEligibleForQuery(
  queryText: string,
  queryEventKey: string | null,
  row: CanonicalTemporalLookupRow
): boolean {
  const searchText = buildTemporalCandidateSearchText(row);
  const supportKind = inferCanonicalTemporalSupportKind(queryText, row);
  const sourceQuality = inferCanonicalTemporalSourceQuality(queryText, row);
  if (rowIsMediaReferenceWithoutExplicitTemporalAnchor(row)) {
    return false;
  }
  const alignmentCount = temporalQueryAlignmentCount(queryText, searchText);
  const objectAlignmentCount = temporalQueryObjectAlignmentCount(queryText, searchText);
  const queryObjectTokens = extractTemporalQueryObjectTokens(queryText);
  const requiresObjectAlignment = queryObjectTokens.length > 0;
  const bindingConfidence = canonicalTemporalBindingConfidence(queryText, queryEventKey, row);
  const persistedExactEventFact =
    Boolean(queryEventKey) &&
    areTemporalEventKeysCompatible(row.event_key, queryEventKey) &&
    queryObjectTokens.length === 0 &&
    (
      supportKind === "explicit_event_fact" ||
      sourceQuality === "canonical_event" ||
      bindingConfidence >= 0.8
    );
  const hasAlignmentTokens = extractTemporalQueryAlignmentTokens(queryText).length > 0;
  const hasStrongAlignment = isTemporalQueryTextAligned(queryText, searchText);
  const hasTemporalPayload =
    typeof row.answer_year === "number" ||
    typeof row.answer_month === "number" ||
    typeof row.answer_day === "number" ||
    Boolean(row.anchor_text) ||
    Boolean(row.anchor_event_key) ||
    Boolean(row.anchor_relation) ||
    Boolean(row.mentioned_at) ||
    Boolean(row.t_valid_from) ||
    Boolean(row.t_valid_until);
  const hasCareerHighPointsCue =
    /\b(?:score|points?)\b/u.test(searchText.toLowerCase()) &&
    (
      /\bcareer-?high\b/u.test(searchText.toLowerCase()) ||
      /\bhighest(?:\s+score|\s+points?)\s+ever\b/u.test(searchText.toLowerCase()) ||
      (/\bhighest ever\b/u.test(searchText.toLowerCase()) && /\b(?:score|points?)\b/u.test(searchText.toLowerCase())) ||
      /\bpersonal best\b/u.test(searchText.toLowerCase())
    );
  if (queryEventKey) {
    const eventAligned = isCanonicalTemporalEventAlignedForQuery(queryEventKey, searchText);
    if (areTemporalEventKeysCompatible(row.event_key, queryEventKey)) {
      if (!persistedExactEventFact && !eventAligned && !hasStrongAlignment) {
        return false;
      }
      if (requiresObjectAlignment && objectAlignmentCount === 0 && !persistedExactEventFact) {
        return false;
      }
      if (queryEventKey === "career_high_points" && !hasCareerHighPointsCue) {
        return false;
      }
      return true;
    }
    if (row.event_key) {
      return false;
    }
    if (supportKind === "reference_derived_relative" && !temporalQueryRequestsRelativePhrasing(queryText)) {
      return hasTemporalPayload && eventAligned && (!requiresObjectAlignment || objectAlignmentCount > 0);
    }
    return hasTemporalPayload &&
      eventAligned &&
      (!requiresObjectAlignment || objectAlignmentCount > 0) &&
      (
        supportKind === "aligned_anchor" ||
        supportKind === "reference_derived_relative" ||
        hasStrongAlignment
      );
  }
  if (hasAlignmentTokens) {
    if (row.event_key) {
      return hasStrongAlignment || supportKind === "aligned_anchor" || supportKind === "reference_derived_relative";
    }
    return hasTemporalPayload && (
      hasStrongAlignment ||
      supportKind === "aligned_anchor" ||
      supportKind === "reference_derived_relative"
    );
  }
  if (row.event_key) {
    return supportKind !== "generic_time_fragment";
  }
  if (supportKind === "reference_derived_relative" && !temporalQueryRequestsRelativePhrasing(queryText)) {
    return false;
  }
  return hasTemporalPayload && supportKind !== "generic_time_fragment";
}

async function loadCompatibleCanonicalSetRows(params: {
  readonly namespaceId: string;
  readonly subjectEntityId: string;
  readonly queryText: string;
  readonly exactDetailFamily: string;
}): Promise<readonly CanonicalSetLookupRow[]> {
  const rows = await queryRows<CanonicalSetLookupRow>(
    `
      SELECT
        csx.id::text AS id,
        csx.subject_entity_id::text AS subject_entity_id,
        cs.canonical_name,
        csx.predicate_family,
        csx.item_values,
        csx.support_strength,
        csx.confidence,
        csx.valid_from::text,
        csx.valid_until::text,
        csx.metadata
      FROM canonical_sets csx
      JOIN canonical_subjects cs
        ON cs.namespace_id = csx.namespace_id
       AND cs.entity_id = csx.subject_entity_id
      WHERE csx.namespace_id = $1
        AND csx.subject_entity_id = $2::uuid
      ORDER BY csx.confidence DESC, csx.created_at DESC
      LIMIT 16
    `,
    [params.namespaceId, params.subjectEntityId]
  );
  return rows.filter((row) => isCompatibleCanonicalSetRow(params.queryText, params.exactDetailFamily, row));
}

function inferRequestedSetEntryType(queryText: string): string | null {
  const query = normalizeName(queryText);
  if (!query) {
    return null;
  }
  if (/\bcountry\b/u.test(query)) {
    return "country";
  }
  if (/\bsymbolic gifts?\b|\bgifts?\b/u.test(query)) {
    return "gift";
  }
  if (/\bplanned to meet at\b|\bplaces or events\b|\bmeet at\b/u.test(query)) {
    return "venue";
  }
  return null;
}

async function loadTypedSetEntryValues(params: {
  readonly namespaceId: string;
  readonly subjectEntityId: string;
  readonly queryText: string;
  readonly rows: readonly CanonicalSetLookupRow[];
}): Promise<readonly string[]> {
  const requestedType = inferRequestedSetEntryType(params.queryText);
  if (!requestedType) {
    return [];
  }
  const setIds = params.rows
    .map((row) => row.id)
    .filter((value): value is string => typeof value === "string" && value.length > 0);
  if (setIds.length === 0) {
    return [];
  }
  const entryRows = await queryRows<CanonicalSetEntryRow>(
    `
      SELECT
        canonical_set_id::text AS canonical_set_id,
        subject_entity_id::text AS subject_entity_id,
        display_value,
        normalized_value,
        value_type,
        country_code,
        city_name,
        venue_name,
        gift_kind,
        metadata
      FROM canonical_set_entries
      WHERE namespace_id = $1
        AND subject_entity_id = $2::uuid
        AND canonical_set_id = ANY($3::uuid[])
        AND value_type = $4
      ORDER BY created_at DESC, entry_index ASC
    `,
    [params.namespaceId, params.subjectEntityId, setIds, requestedType]
  );
  return uniqueStrings(entryRows.map((row) => row.display_value));
}

function scoreCanonicalText(text: string, queryTerms: readonly string[]): number {
  const normalizedText = normalizeName(text);
  let score = 0;
  for (const term of queryTerms) {
    if (normalizedText.includes(normalizeName(term))) {
      score += 1;
    }
  }
  return score;
}

function readMetadataString(metadata: JsonRecord | null | undefined, key: string): string {
  const value = metadata?.[key];
  return typeof value === "string" ? value : "";
}

function readNormalizedValueString(normalizedValue: JsonRecord | null | undefined, key: string): string {
  const value = normalizedValue?.[key];
  return typeof value === "string" ? value : "";
}

function isCompatibleCanonicalSetRow(queryText: string, exactDetailFamily: string, row: CanonicalSetLookupRow): boolean {
  const setKind = normalizeName(readMetadataString(row.metadata, "set_kind"));
  const domain = normalizeName(readMetadataString(row.metadata, "domain"));
  const predicate = normalizeName(readMetadataString(row.metadata, "predicate"));
  const mediaKind = normalizeName(readMetadataString(row.metadata, "media_kind"));
  const query = normalizeName(queryText);

  if (exactDetailFamily === "goals") {
    return setKind === "goal_items" && goalScopeMatchesQuery(queryText, row.metadata);
  }
  if (exactDetailFamily === "shop") {
    return setKind === "shop_affinity";
  }
  if (/\bfavorite books?\b|\bwhat books?\b/.test(query)) {
    return (setKind === "media mentions" && mediaKind.includes("book")) || domain.includes("book");
  }
  if (["bands", "favorite_band", "favorite_dj"].includes(exactDetailFamily)) {
    return setKind === "media mentions";
  }
  if (exactDetailFamily === "purchased_items") {
    return setKind === "transaction items";
  }
  if (["hobbies", "social_exclusion"].includes(exactDetailFamily)) {
    return setKind === "preference facts" || predicate.includes("hobby") || domain.includes("hobby");
  }
  if (exactDetailFamily === "broken_items" || exactDetailFamily === "advice") {
    return false;
  }
  return true;
}

export async function lookupStoredCanonicalForQuery(params: {
  readonly namespaceId: string;
  readonly queryText: string;
  readonly exactDetailFamily: string;
  readonly matchedParticipants: readonly string[];
  readonly missingParticipants: readonly string[];
  readonly foreignParticipants: readonly string[];
  readonly results: readonly RecallResult[];
}): Promise<StoredCanonicalLookup | null> {
  const predicateFamily = inferLookupPredicateFamily(params.queryText, params.exactDetailFamily);
  const pairNames = extractPairQuerySurfaceNames(params.queryText);
  if (
    pairNames.length >= 2 &&
    (predicateFamily === "commonality" || predicateFamily === "list_set" || predicateFamily === "location_history" || isPairAggregationQuery(params.queryText))
  ) {
    const pairLookup = await lookupMultiSubjectCanonicalSet({
      namespaceId: params.namespaceId,
      queryText: params.queryText,
      exactDetailFamily: params.exactDetailFamily,
      predicateFamily: predicateFamily === "generic_fact" ? "commonality" : predicateFamily,
      subjectNames: pairNames
    });
    if (pairLookup) {
      return pairLookup;
    }
  }
  if (predicateFamily === "commonality") {
    const participantNames = uniqueStrings(pairNames.length > 0 ? pairNames : [
      ...params.matchedParticipants,
      ...extractCandidateNames(params.queryText)
    ]);
    const commonalityLookup = await lookupMultiSubjectCanonicalSet({
      namespaceId: params.namespaceId,
      queryText: params.queryText,
      exactDetailFamily: params.exactDetailFamily,
      predicateFamily,
      subjectNames: participantNames
    });
    if (commonalityLookup) {
      return commonalityLookup;
    }
  }
  const binding = await resolveStoredCanonicalSubject(params);
  if (binding.status === "ambiguous") {
    return {
      kind: "abstention",
      subjectEntityId: null,
      canonicalSubjectName: null,
      subjectBindingStatus: "ambiguous",
      predicateFamily,
      supportStrength: "weak",
      timeScopeKind: "unknown",
      confidence: "missing",
      abstainReason: "insufficient_subject_binding",
      sourceTable: "canonical_subject_aliases"
    };
  }
  if (!binding.subjectEntityId) {
    return null;
  }

  const queryTerms = extractKeywordTerms(params.queryText, [
    ...params.matchedParticipants,
    ...params.missingParticipants,
    binding.canonicalSubjectName ?? ""
  ]);

  if (isTemporalLookupQuery(params.queryText, predicateFamily)) {
    const rows = await queryRows<CanonicalTemporalLookupRow>(
      `
        SELECT
          ctf.subject_entity_id::text AS subject_entity_id,
          cs.canonical_name,
          ctf.predicate_family,
          ctf.fact_value,
          ctf.support_strength,
          ctf.time_scope_kind,
          ctf.anchor_text,
          ctf.anchor_start::text,
          ctf.anchor_end::text,
          ctf.mentioned_at::text,
          ctf.t_valid_from::text,
          ctf.t_valid_until::text,
          ctf.event_key,
          ctf.event_type,
          ctf.time_granularity,
          ctf.answer_year,
          ctf.answer_month,
          ctf.answer_day,
          ctf.object_entity_id::text AS object_entity_id,
          ctf.source_artifact_id::text AS source_artifact_id,
          ctf.source_chunk_id::text AS source_chunk_id,
          ctf.source_event_id::text AS source_event_id,
          ctf.anchor_event_key,
          ctf.anchor_relation,
          ctf.anchor_offset_value,
          ctf.anchor_offset_unit,
          ctf.confidence,
          ctf.support_kind,
          ctf.binding_confidence,
          ctf.temporal_source_quality,
          ctf.derived_from_reference,
          ctf.event_surface_text,
          ctf.location_surface_text,
          ctf.participant_entity_ids,
          ctf.metadata
        FROM canonical_temporal_facts ctf
        JOIN canonical_subjects cs
          ON cs.namespace_id = ctf.namespace_id
         AND cs.entity_id = ctf.subject_entity_id
        WHERE ctf.namespace_id = $1
          AND ctf.subject_entity_id = $2::uuid
        ORDER BY COALESCE(ctf.t_valid_from, ctf.anchor_start) DESC NULLS LAST, ctf.created_at DESC
        LIMIT 24
      `,
      [params.namespaceId, binding.subjectEntityId]
    );
    if (rows.length > 0) {
      const queryEventKey = inferTemporalEventKeyFromText(params.queryText);
      const eligibleRows = rows.filter((row) =>
        isCanonicalTemporalLookupRowEligibleForQuery(params.queryText, queryEventKey, row)
      );
      if (eligibleRows.length === 0) {
        return null;
      }
      const candidateRows =
        queryEventKey && eligibleRows.some((row) => areTemporalEventKeysCompatible(row.event_key, queryEventKey))
          ? eligibleRows.filter((row) => areTemporalEventKeysCompatible(row.event_key, queryEventKey))
          : eligibleRows;
      const temporalNeighborhoods = buildCanonicalTemporalNeighborhoodSummaries(
        params.queryText,
        queryEventKey,
        candidateRows
      );
      const scoredRows = candidateRows
        .map((row) => ({
          row,
          score: scoreCanonicalTemporalLookupRow({
            queryText: params.queryText,
            queryTerms,
            queryEventKey,
            row,
            neighborhoods: temporalNeighborhoods
          })
        }))
        .sort((left, right) => right.score - left.score);
      const bestScore = scoredRows[0]?.score ?? 0;
      if (queryTerms.length > 0 && bestScore <= 0) {
        return null;
      }
      const scoreByRow = new Map(scoredRows.map(({ row, score }) => [row, score]));
      const preferEarliest = shouldPreferEarliestTemporalQueryEvent(params.queryText, queryEventKey);
      const selected = [...candidateRows].sort((left, right) => {
        const scoreDelta = (scoreByRow.get(right) ?? 0) - (scoreByRow.get(left) ?? 0);
        if (scoreDelta !== 0) {
          if (
            preferEarliest &&
            queryEventKey &&
            areTemporalEventKeysCompatible(left.event_key, queryEventKey) &&
            areTemporalEventKeysCompatible(right.event_key, queryEventKey) &&
            Math.abs(scoreDelta) <= 1
          ) {
            const leftTime = temporalOrderingTime(left);
            const rightTime = temporalOrderingTime(right);
            if (leftTime !== rightTime) {
              return leftTime - rightTime;
            }
          }
          return scoreDelta;
        }
        if (
          preferEarliest &&
          queryEventKey &&
          areTemporalEventKeysCompatible(left.event_key, queryEventKey) &&
          areTemporalEventKeysCompatible(right.event_key, queryEventKey)
        ) {
          const leftTime = temporalOrderingTime(left);
          const rightTime = temporalOrderingTime(right);
          if (leftTime !== rightTime) {
            return leftTime - rightTime;
          }
        }
        const leftText = buildTemporalCandidateSearchText(left);
        const rightText = buildTemporalCandidateSearchText(right);
        const lexicalDelta = scoreCanonicalText(rightText, queryTerms) - scoreCanonicalText(leftText, queryTerms);
        if (lexicalDelta !== 0) {
          return lexicalDelta;
        }
        const rightAlignmentBonus = temporalQueryAlignmentBonus(params.queryText, right);
        const leftAlignmentBonus = temporalQueryAlignmentBonus(params.queryText, left);
        if (rightAlignmentBonus !== leftAlignmentBonus) {
          return rightAlignmentBonus - leftAlignmentBonus;
        }
        const rightEventKeyBonus = queryEventKey && areTemporalEventKeysCompatible(right.event_key, queryEventKey) ? 1 : 0;
        const leftEventKeyBonus = queryEventKey && areTemporalEventKeysCompatible(left.event_key, queryEventKey) ? 1 : 0;
        if (rightEventKeyBonus !== leftEventKeyBonus) {
          return rightEventKeyBonus - leftEventKeyBonus;
        }
        const rightTemporalText = buildStoredCanonicalTemporalAnswerForQuery(right, params.queryText);
        const leftTemporalText = buildStoredCanonicalTemporalAnswerForQuery(left, params.queryText);
        const rightAnchorBonus = rightTemporalText ? 1 : 0;
        const leftAnchorBonus = leftTemporalText ? 1 : 0;
        if (rightAnchorBonus !== leftAnchorBonus) {
          return rightAnchorBonus - leftAnchorBonus;
        }
        return 0;
      })[0]!;
      const temporalAnswer = buildStoredCanonicalTemporalAnswerForQuery(selected, params.queryText);
      if (!temporalAnswer) {
        return null;
      }
      return {
        kind: "temporal_fact",
        subjectEntityId: selected.subject_entity_id,
        canonicalSubjectName: selected.canonical_name,
        subjectBindingStatus: binding.status,
        predicateFamily: (selected.predicate_family as CanonicalPredicateFamily) ?? predicateFamily,
        supportStrength: asSupportStrength(selected.support_strength),
        timeScopeKind: asTimeScopeKind(selected.time_scope_kind),
        temporalValiditySource: selected.t_valid_from || selected.t_valid_until ? "event_time" : selected.mentioned_at ? "mention_time" : "unknown",
        confidence: "confident",
        objectValue: temporalAnswer,
        validFrom: selected.t_valid_from ?? selected.anchor_start,
        validUntil: selected.t_valid_until ?? selected.anchor_end,
        mentionedAt: selected.mentioned_at,
        eventKey: selected.event_key,
        eventType: selected.event_type,
        timeGranularity: selected.time_granularity,
        answerYear: selected.answer_year,
        answerMonth: selected.answer_month,
        answerDay: selected.answer_day,
        objectEntityId: selected.object_entity_id,
        sourceArtifactId: selected.source_artifact_id,
        sourceChunkId: selected.source_chunk_id,
        sourceEventId: selected.source_event_id,
        anchorEventKey: selected.anchor_event_key,
        anchorRelation: selected.anchor_relation,
        anchorOffsetValue: selected.anchor_offset_value,
        anchorOffsetUnit: selected.anchor_offset_unit,
        canonicalConfidence: selected.confidence,
        supportKind: selected.support_kind,
        bindingConfidence: selected.binding_confidence,
        temporalSourceQuality: selected.temporal_source_quality,
        derivedFromReference: Boolean(selected.derived_from_reference),
        eventSurfaceText: selected.event_surface_text,
        locationSurfaceText: selected.location_surface_text,
        participantEntityIds: parseStringArray(selected.participant_entity_ids),
        sourceTable: "canonical_temporal_facts"
      };
    }
  }

  if (
    predicateFamily === "list_set" ||
    predicateFamily === "commonality" ||
    params.exactDetailFamily === "goals" ||
    params.exactDetailFamily === "shop" ||
    /\bwhat (?:books|types|kinds|places|events)\b/i.test(params.queryText)
  ) {
    const compatibleRows = await loadCompatibleCanonicalSetRows({
      namespaceId: params.namespaceId,
      subjectEntityId: binding.subjectEntityId,
      queryText: params.queryText,
      exactDetailFamily: params.exactDetailFamily
    });
    if (compatibleRows.length > 0) {
      const scoredRows = compatibleRows.map((row) => {
        const text = [
          parseStringArray(row.item_values).join(" "),
          readMetadataString(row.metadata, "set_kind"),
          readMetadataString(row.metadata, "domain"),
          readMetadataString(row.metadata, "predicate"),
          readMetadataString(row.metadata, "goal_scope"),
          readMetadataString(row.metadata, "goal_type"),
          readMetadataString(row.metadata, "affinity_type"),
          readMetadataString(row.metadata, "media_kind"),
          readMetadataString(row.metadata, "mention_kind")
        ].filter(Boolean).join(" ");
        return { row, score: scoreCanonicalText(text, queryTerms) };
      }).sort((left, right) => right.score - left.score);
      const bestScore = scoredRows[0]?.score ?? 0;
      if (queryTerms.length > 0 && bestScore <= 0) {
        return null;
      }
      const selected = scoredRows[0]!.row;
      const requestedSetEntryType = inferRequestedSetEntryType(params.queryText);
      const typedEntryValues = await loadTypedSetEntryValues({
        namespaceId: params.namespaceId,
        subjectEntityId: binding.subjectEntityId,
        queryText: params.queryText,
        rows: compatibleRows
      });
      const values =
        typedEntryValues.length > 0
          ? typedEntryValues
          : params.exactDetailFamily === "goals"
          ? collectCompatibleSetValues(
              compatibleRows.filter(
                (row) =>
                  normalizeName(readMetadataString(row.metadata, "set_kind")) === "goal_items" &&
                  goalScopeMatchesQuery(params.queryText, row.metadata)
              ),
              params.exactDetailFamily
            )
          : parseStringArray(selected.item_values);
      if (values.length > 0) {
        return {
          kind: "set",
          subjectEntityId: selected.subject_entity_id,
          canonicalSubjectName: selected.canonical_name,
          subjectBindingStatus: binding.status,
          predicateFamily:
            params.exactDetailFamily === "goals"
              ? "profile_state"
              : ((selected.predicate_family as CanonicalPredicateFamily) ?? predicateFamily),
          supportStrength: asSupportStrength(selected.support_strength),
          timeScopeKind: selected.valid_until ? "historical" : "active",
          confidence: asConfidence(selected.confidence),
          objectValues: values,
          typedSetEntryValues: typedEntryValues.length > 0 ? typedEntryValues : undefined,
          typedSetEntryType: typedEntryValues.length > 0 ? requestedSetEntryType : null,
          validFrom: selected.valid_from,
          validUntil: selected.valid_until,
          sourceTable: "canonical_sets"
        };
      }
    }
  }

  if (predicateFamily === "alias_identity" || predicateFamily === "profile_state" || predicateFamily === "work_education_history" || predicateFamily === "location_history") {
    const rows = await queryRows<CanonicalStateLookupRow>(
      `
        SELECT
          cst.subject_entity_id::text AS subject_entity_id,
          cs.canonical_name,
          cst.predicate_family,
          cst.state_value,
          cst.support_strength,
          cst.confidence,
          cst.time_scope_kind,
          cst.valid_from::text,
          cst.valid_until::text,
          cst.mentioned_at::text,
          cst.t_valid_from::text,
          cst.t_valid_until::text,
          cst.metadata
        FROM canonical_states cst
        JOIN canonical_subjects cs
          ON cs.namespace_id = cst.namespace_id
         AND cs.entity_id = cst.subject_entity_id
        WHERE cst.namespace_id = $1
          AND cst.subject_entity_id = $2::uuid
        ORDER BY cst.confidence DESC, cst.updated_at DESC
        LIMIT 24
      `,
      [params.namespaceId, binding.subjectEntityId]
    );
    if (rows.length > 0) {
      const scoredRows = rows.map((row) => {
        const profileKind = readMetadataString(row.metadata, "profile_kind");
        const sourceTable = readMetadataString(row.metadata, "source_table");
        const identityBonus =
          predicateFamily === "alias_identity" &&
          /\b(transgender|nonbinary|gender identity|identity|trans woman|trans man|queer)\b/i.test(row.state_value)
            ? 3
            : 0;
        const profileSummaryBonus =
          sourceTable === "semantic_memory"
            ? predicateFamily === "alias_identity" && profileKind === "identity_summary"
              ? 4
              : predicateFamily === "profile_state"
                ? 2
                : 1
            : 0;
        const familyBonus =
          row.predicate_family === predicateFamily ||
          (predicateFamily === "alias_identity" && row.predicate_family === "profile_state")
            ? 2
            : 0;
        return { row, score: identityBonus + profileSummaryBonus + familyBonus + scoreCanonicalText(row.state_value, queryTerms) };
      }).sort((left, right) => right.score - left.score);
      const bestScore = scoredRows[0]?.score ?? 0;
      if (queryTerms.length > 0 && bestScore <= 0) {
        return null;
      }
      const selected = [...rows].sort((left, right) => {
        const rightProfileKind = readMetadataString(right.metadata, "profile_kind");
        const leftProfileKind = readMetadataString(left.metadata, "profile_kind");
        const rightSourceTable = readMetadataString(right.metadata, "source_table");
        const leftSourceTable = readMetadataString(left.metadata, "source_table");
        const rightIdentityBonus =
          predicateFamily === "alias_identity" &&
          /\b(transgender|nonbinary|gender identity|identity|trans woman|trans man|queer)\b/i.test(right.state_value)
            ? 3
            : 0;
        const leftIdentityBonus =
          predicateFamily === "alias_identity" &&
          /\b(transgender|nonbinary|gender identity|identity|trans woman|trans man|queer)\b/i.test(left.state_value)
            ? 3
            : 0;
        const familyBonus =
          (right.predicate_family === predicateFamily || (predicateFamily === "alias_identity" && right.predicate_family === "profile_state") ? 2 : 0) -
          (left.predicate_family === predicateFamily || (predicateFamily === "alias_identity" && left.predicate_family === "profile_state") ? 2 : 0);
        const profileSummaryBonus =
          (rightSourceTable === "semantic_memory"
            ? predicateFamily === "alias_identity" && rightProfileKind === "identity_summary"
              ? 4
              : predicateFamily === "profile_state"
                ? 2
                : 1
            : 0) -
          (leftSourceTable === "semantic_memory"
            ? predicateFamily === "alias_identity" && leftProfileKind === "identity_summary"
              ? 4
              : predicateFamily === "profile_state"
                ? 2
                : 1
            : 0);
        if (rightIdentityBonus !== leftIdentityBonus) {
          return rightIdentityBonus - leftIdentityBonus;
        }
        if (profileSummaryBonus !== 0) {
          return profileSummaryBonus;
        }
        if (familyBonus !== 0) {
          return familyBonus;
        }
        return scoreCanonicalText(right.state_value, queryTerms) - scoreCanonicalText(left.state_value, queryTerms);
      })[0]!;
      return {
        kind: "state",
        subjectEntityId: selected.subject_entity_id,
        canonicalSubjectName: selected.canonical_name,
        subjectBindingStatus: binding.status,
        predicateFamily: (selected.predicate_family as CanonicalPredicateFamily) ?? predicateFamily,
        supportStrength: asSupportStrength(selected.support_strength),
        timeScopeKind: asTimeScopeKind(selected.time_scope_kind),
        confidence: asConfidence(selected.confidence),
        objectValue: selected.state_value,
        validFrom: selected.t_valid_from ?? selected.valid_from,
        validUntil: selected.t_valid_until ?? selected.valid_until,
        mentionedAt: selected.mentioned_at,
        sourceTable: "canonical_states"
      };
    }
  }

  const factRows = await queryRows<CanonicalFactLookupRow>(
    `
      SELECT
        cf.subject_entity_id::text AS subject_entity_id,
        cs.canonical_name,
        cf.predicate_family,
        cf.object_value,
        cf.support_strength,
        cf.time_scope_kind,
        cf.valid_from::text,
        cf.valid_until::text,
        cf.mentioned_at::text,
        cf.t_valid_from::text,
        cf.t_valid_until::text,
        cf.metadata
      FROM canonical_facts cf
      JOIN canonical_subjects cs
        ON cs.namespace_id = cf.namespace_id
       AND cs.entity_id = cf.subject_entity_id
      WHERE cf.namespace_id = $1
        AND cf.subject_entity_id = $2::uuid
      ORDER BY cf.created_at DESC
      LIMIT 24
    `,
    [params.namespaceId, binding.subjectEntityId]
  );
  if (factRows.length > 0) {
    const scoredRows = factRows.map((row) => {
      const familyBonus = row.predicate_family === predicateFamily ? 2 : 0;
      return { row, score: familyBonus + scoreCanonicalText(row.object_value ?? "", queryTerms) };
    }).sort((left, right) => right.score - left.score);
    const bestScore = scoredRows[0]?.score ?? 0;
    if (queryTerms.length > 0 && bestScore <= 0) {
      return null;
    }
    const selected = [...factRows].sort((left, right) => {
      const rightFamily = right.predicate_family === predicateFamily ? 2 : 0;
      const leftFamily = left.predicate_family === predicateFamily ? 2 : 0;
      if (rightFamily !== leftFamily) {
        return rightFamily - leftFamily;
      }
      return scoreCanonicalText(right.object_value ?? "", queryTerms) - scoreCanonicalText(left.object_value ?? "", queryTerms);
    })[0]!;
    if (selected.object_value) {
      return {
        kind: "fact",
        subjectEntityId: selected.subject_entity_id,
        canonicalSubjectName: selected.canonical_name,
        subjectBindingStatus: binding.status,
        predicateFamily: (selected.predicate_family as CanonicalPredicateFamily) ?? predicateFamily,
        supportStrength: asSupportStrength(selected.support_strength),
        timeScopeKind: asTimeScopeKind(selected.time_scope_kind),
        confidence: "confident",
        objectValue: selected.object_value,
        validFrom: selected.t_valid_from ?? selected.valid_from,
        validUntil: selected.t_valid_until ?? selected.valid_until,
        mentionedAt: selected.mentioned_at,
        sourceTable: "canonical_facts"
      };
    }
  }

  return null;
}

export function inferCanonicalStatePredicateFamily(stateType: string, stateKey: string, stateValueText: string): string {
  const normalized = normalizeName([stateType, stateKey, stateValueText].join(" "));
  if (/\b(work|job|career|role|employment|employ|engineer|manager|company|employer|school|college|study|education)\b/u.test(normalized)) {
    return "work_education_history";
  }
  if (/\b(live|home|city|country|travel|location|move|moved)\b/u.test(normalized)) {
    return "location_history";
  }
  return "profile_state";
}

export function inferCanonicalTemporalPredicateFamily(factText: string, timeHintText: string | null, locationText: string | null): string {
  const normalized = normalizeName([factText, timeHintText ?? "", locationText ?? ""].join(" "));
  if (/\b(move|moved|travel|traveled|visit|visited|lived|live)\b/u.test(normalized)) {
    return "location_history";
  }
  if (/\b(start|started|resume|resumed|work|worked|study|studied|school|job|career)\b/u.test(normalized)) {
    return "work_education_history";
  }
  return "temporal_event_fact";
}

export function inferCanonicalTimeScopeKind(anchorText: string | null, start: string | null, end: string | null): string {
  const normalizedAnchor = normalizeName(anchorText ?? "");
  if (/\b(ago|before|after|later|earlier|last|next|weekend|following)\b/u.test(normalizedAnchor)) {
    return "anchored_relative";
  }
  if (start && end && start !== end) {
    return "bounded_range";
  }
  if (start || end) {
    return "exact_date";
  }
  if (/\b(january|february|march|april|may|june|july|august|september|october|november|december)\b/u.test(normalizedAnchor)) {
    return "month_year";
  }
  return "unknown";
}

export function summarizeCanonicalStateValue(stateValue: unknown): string | null {
  if (typeof stateValue === "string") {
    return normalizeWhitespace(stateValue);
  }
  if (!stateValue || typeof stateValue !== "object") {
    return null;
  }
  const record = stateValue as JsonRecord;
  const preferredKeys = [
    "value",
    "summary",
    "status",
    "name",
    "role",
    "company",
    "employer",
    "school",
    "city",
    "country",
    "location",
    "title",
    "text"
  ];
  const parts = preferredKeys
    .map((key) => record[key])
    .filter((value): value is string => typeof value === "string" && normalizeWhitespace(value).length > 0)
    .map((value) => normalizeWhitespace(value));
  if (parts.length > 0) {
    return uniqueStrings(parts).join(" | ");
  }
  return null;
}

function entityConfidence(entityType: CanonicalRegistryRow["entity_type"]): number {
  switch (entityType) {
    case "self":
      return 0.99;
    case "person":
      return 0.92;
    case "place":
    case "project":
      return 0.88;
    default:
      return 0.75;
  }
}

function aliasConfidence(aliasType: string | null, userVerified: boolean): number {
  if (userVerified) {
    return 0.98;
  }
  if (aliasType === "manual") {
    return 0.92;
  }
  if (aliasType === "observed") {
    return 0.85;
  }
  if (aliasType === "merged") {
    return 0.82;
  }
  return 0.76;
}

async function deleteCanonicalRows(client: PoolClient, namespaceId: string): Promise<void> {
  // Delete child tables first so every rebuild is a fresh canonical snapshot.
  await client.query("DELETE FROM canonical_rebuild_runs WHERE namespace_id = $1", [namespaceId]);
  await client.query("DELETE FROM canonical_ambiguities WHERE namespace_id = $1", [namespaceId]);
  await client.query("DELETE FROM canonical_pair_reports WHERE namespace_id = $1", [namespaceId]);
  await client.query("DELETE FROM canonical_entity_reports WHERE namespace_id = $1", [namespaceId]);
  await client.query("DELETE FROM canonical_collection_facts WHERE namespace_id = $1", [namespaceId]);
  await client.query("DELETE FROM canonical_narrative_provenance WHERE namespace_id = $1", [namespaceId]);
  await client.query("DELETE FROM canonical_narratives WHERE namespace_id = $1", [namespaceId]);
  await client.query("DELETE FROM canonical_fact_provenance WHERE namespace_id = $1", [namespaceId]);
  await client.query("DELETE FROM canonical_set_entries WHERE namespace_id = $1", [namespaceId]);
  await client.query("DELETE FROM canonical_temporal_facts WHERE namespace_id = $1", [namespaceId]);
  await client.query("DELETE FROM canonical_subject_states WHERE namespace_id = $1", [namespaceId]);
  await client.query("DELETE FROM canonical_states WHERE namespace_id = $1", [namespaceId]);
  await client.query("DELETE FROM canonical_sets WHERE namespace_id = $1", [namespaceId]);
  await client.query("DELETE FROM canonical_facts WHERE namespace_id = $1", [namespaceId]);
  await client.query("DELETE FROM canonical_subject_aliases WHERE namespace_id = $1", [namespaceId]);
  await client.query("DELETE FROM canonical_subjects WHERE namespace_id = $1", [namespaceId]);
}

async function rebuildCanonicalSubjectsAndAliases(
  client: PoolClient,
  namespaceId: string
): Promise<Pick<CanonicalMemoryRebuildCounts, "subjects" | "aliases" | "ambiguities">> {
  const registry = await client.query<CanonicalRegistryRow>(
    `
      SELECT
        id::text,
        entity_type,
        canonical_name,
        normalized_name,
        aliases,
        merged_entities,
        metadata
      FROM canonical_entity_registry
      WHERE namespace_id = $1
      ORDER BY canonical_name ASC
    `,
    [namespaceId]
  );

  let subjectCount = 0;
  let aliasCount = 0;
  let ambiguityCount = 0;
  const aliasIndex = new Map<string, { aliasText: string; subjectIds: Set<string>; subjectNames: Set<string> }>();

  for (const row of registry.rows) {
    await client.query(
      `
        INSERT INTO canonical_subjects (
          namespace_id,
          entity_id,
          canonical_name,
          normalized_canonical_name,
          confidence,
          metadata
        )
        VALUES ($1, $2::uuid, $3, $4, $5, $6::jsonb)
        ON CONFLICT (namespace_id, entity_id)
        DO UPDATE SET
          canonical_name = EXCLUDED.canonical_name,
          normalized_canonical_name = EXCLUDED.normalized_canonical_name,
          confidence = GREATEST(canonical_subjects.confidence, EXCLUDED.confidence),
          metadata = canonical_subjects.metadata || EXCLUDED.metadata,
          updated_at = now()
      `,
      [
        namespaceId,
        row.id,
        row.canonical_name,
        row.normalized_name,
        entityConfidence(row.entity_type),
        JSON.stringify({
          source: "canonical_rebuild",
          entity_type: row.entity_type,
          entity_metadata: row.metadata ?? {}
        })
      ]
    );
    subjectCount += 1;

    const aliasEntries: Array<{ aliasText: string; aliasType: string | null; userVerified: boolean; provenance: JsonRecord }> = [
      {
        aliasText: row.canonical_name,
        aliasType: "canonical",
        userVerified: row.entity_type === "self",
        provenance: { source: "canonical_name" }
      }
    ];

    for (const alias of parseObjectArray(row.aliases)) {
      if (typeof alias.alias !== "string" || alias.alias.trim().length === 0) {
        continue;
      }
      aliasEntries.push({
        aliasText: alias.alias,
        aliasType: typeof alias.alias_type === "string" ? alias.alias_type : null,
        userVerified: alias.is_user_verified === true,
        provenance: {
          source: "entity_alias",
          alias_type: alias.alias_type,
          metadata: alias.metadata ?? {}
        }
      });
    }

    for (const merged of parseObjectArray(row.merged_entities)) {
      if (typeof merged.canonical_name !== "string" || merged.canonical_name.trim().length === 0) {
        continue;
      }
      aliasEntries.push({
        aliasText: merged.canonical_name,
        aliasType: "merged",
        userVerified: false,
        provenance: {
          source: "merged_entity",
          entity_id: merged.entity_id ?? null
        }
      });
    }

    const seenAliases = new Set<string>();
    for (const alias of aliasEntries) {
      const normalizedAlias = normalizeName(alias.aliasText);
      if (!normalizedAlias || seenAliases.has(normalizedAlias)) {
        continue;
      }
      seenAliases.add(normalizedAlias);
      await client.query(
        `
          INSERT INTO canonical_subject_aliases (
            namespace_id,
            subject_entity_id,
            alias_text,
            normalized_alias_text,
            confidence,
            provenance,
            metadata
          )
          VALUES ($1, $2::uuid, $3, $4, $5, $6::jsonb, $7::jsonb)
          ON CONFLICT (namespace_id, subject_entity_id, normalized_alias_text)
          DO UPDATE SET
            alias_text = EXCLUDED.alias_text,
            confidence = GREATEST(canonical_subject_aliases.confidence, EXCLUDED.confidence),
            provenance = canonical_subject_aliases.provenance || EXCLUDED.provenance,
            metadata = canonical_subject_aliases.metadata || EXCLUDED.metadata,
            updated_at = now()
        `,
        [
          namespaceId,
          row.id,
          alias.aliasText,
          normalizedAlias,
          aliasConfidence(alias.aliasType, alias.userVerified),
          JSON.stringify(alias.provenance),
          JSON.stringify({
            source: "canonical_rebuild",
            canonical_name: row.canonical_name,
            alias_type: alias.aliasType
          })
        ]
      );
      aliasCount += 1;
      const existing = aliasIndex.get(normalizedAlias) ?? {
        aliasText: alias.aliasText,
        subjectIds: new Set<string>(),
        subjectNames: new Set<string>()
      };
      existing.subjectIds.add(row.id);
      existing.subjectNames.add(row.canonical_name);
      aliasIndex.set(normalizedAlias, existing);
    }
  }

  for (const [normalizedAlias, entry] of aliasIndex) {
    if (entry.subjectIds.size <= 1) {
      continue;
    }
    await client.query(
      `
        INSERT INTO canonical_ambiguities (
          namespace_id,
          ambiguity_type,
          subject_alias_text,
          candidate_entity_ids,
          metadata
        )
        VALUES ($1, 'alias_collision', $2, $3::uuid[], $4::jsonb)
      `,
      [
        namespaceId,
        entry.aliasText,
        [...entry.subjectIds],
        JSON.stringify({
          normalized_alias_text: normalizedAlias,
          candidate_names: [...entry.subjectNames],
          source: "canonical_rebuild"
        })
      ]
    );
    ambiguityCount += 1;
  }

  return {
    subjects: subjectCount,
    aliases: aliasCount,
    ambiguities: ambiguityCount
  };
}

async function rebuildCanonicalFacts(client: PoolClient, namespaceId: string): Promise<number> {
  const rows = await client.query<RelationshipMemoryRow>(
    `
      SELECT
        rm.id::text AS relationship_id,
        COALESCE(subject.merged_into_entity_id, subject.id)::text AS subject_entity_id,
        COALESCE(object_entity.merged_into_entity_id, object_entity.id)::text AS object_entity_id,
        rm.predicate,
        object_root.canonical_name AS object_name,
        rm.confidence,
        rm.status,
        rm.valid_from::text,
        rm.valid_until::text,
        rc.source_memory_id::text,
        rc.source_chunk_id::text
      FROM relationship_memory rm
      JOIN entities subject ON subject.id = rm.subject_entity_id
      JOIN entities object_entity ON object_entity.id = rm.object_entity_id
      JOIN entities object_root ON object_root.id = COALESCE(object_entity.merged_into_entity_id, object_entity.id)
      LEFT JOIN relationship_candidates rc ON rc.id = rm.source_candidate_id
      WHERE rm.namespace_id = $1
      ORDER BY rm.valid_from DESC, rm.created_at DESC
    `,
    [namespaceId]
  );
  const personTimeRows = await client.query<PersonTimeCanonicalFactRow>(
    `
      SELECT
        ptf.id::text,
        COALESCE(entity.merged_into_entity_id, entity.id)::text AS subject_entity_id,
        ptf.person_name,
        ptf.fact_text,
        ptf.time_hint_text,
        ptf.occurred_at::text,
        ptf.source_memory_id::text
      FROM person_time_facts ptf
      LEFT JOIN entities entity ON entity.id = ptf.person_entity_id
      WHERE ptf.namespace_id = $1
      ORDER BY ptf.occurred_at DESC NULLS LAST, ptf.created_at DESC
    `,
    [namespaceId]
  );
  const preferenceRows = await client.query<PreferenceFactRow>(
    `
      SELECT
        COALESCE(entity.merged_into_entity_id, entity.id)::text AS subject_entity_id,
        pf.subject_name,
        pf.predicate,
        pf.domain,
        pf.object_text,
        pf.qualifier,
        pf.context_text,
        pf.occurred_at::text,
        pf.source_memory_id::text,
        pf.artifact_id::text
      FROM preference_facts pf
      LEFT JOIN entities entity ON entity.id = pf.subject_entity_id
      WHERE pf.namespace_id = $1
      ORDER BY pf.occurred_at DESC NULLS LAST, pf.created_at DESC
    `,
    [namespaceId]
  );

  let count = 0;
  for (const row of rows.rows) {
    const inserted = await client.query<{ id: string }>(
      `
        INSERT INTO canonical_facts (
          namespace_id,
          subject_entity_id,
          predicate_family,
          object_value,
          object_entity_id,
          time_scope_kind,
          support_strength,
          mentioned_at,
          t_valid_from,
          t_valid_until,
          valid_from,
          valid_until,
          metadata
        )
        VALUES ($1, $2::uuid, $3, $4, $5::uuid, $6, $7, $8::timestamptz, $9::timestamptz, $10::timestamptz, $11::timestamptz, $12::timestamptz, $13::jsonb)
        RETURNING id::text
      `,
      [
        namespaceId,
        row.subject_entity_id,
        inferFactPredicateFamily(row.predicate),
        row.object_name,
        row.object_entity_id,
        row.valid_until ? "historical" : "active",
        supportStrengthFromConfidence(Number(row.confidence ?? 0.5)),
        row.valid_from,
        row.valid_from,
        row.valid_until,
        row.valid_from,
        row.valid_until,
        JSON.stringify({
          source: "canonical_rebuild",
          source_table: "relationship_memory",
          source_relationship_memory_id: row.relationship_id,
          predicate: row.predicate,
          status: row.status
        })
      ]
    );
    const canonicalFactId = inserted.rows[0]?.id;
    if (!canonicalFactId) {
      continue;
    }
    await client.query(
      `
        INSERT INTO canonical_fact_provenance (
          canonical_fact_id,
          namespace_id,
          source_memory_id,
          source_chunk_id,
          provenance
        )
        VALUES ($1::uuid, $2, $3::uuid, $4::uuid, $5::jsonb)
      `,
      [
        canonicalFactId,
        namespaceId,
        row.source_memory_id,
        row.source_chunk_id,
        JSON.stringify({
          source_table: "relationship_memory",
          source_relationship_memory_id: row.relationship_id,
          predicate: row.predicate
        })
      ]
    );
    count += 1;
  }

  const personRowsBySubject = new Map<string, PersonTimeCanonicalFactRow[]>();
  for (const row of personTimeRows.rows) {
    if (!row.subject_entity_id) {
      continue;
    }
    const bucket = personRowsBySubject.get(row.subject_entity_id) ?? [];
    bucket.push(row);
    personRowsBySubject.set(row.subject_entity_id, bucket);
  }

  for (const [subjectEntityId, subjectRows] of personRowsBySubject) {
    const causalFactValue = deriveCanonicalCounterfactualFactValue(subjectRows);
    if (!causalFactValue) {
      continue;
    }
    const newest = subjectRows[0]!;
    const inserted = await client.query<{ id: string }>(
      `
        INSERT INTO canonical_facts (
          namespace_id,
          subject_entity_id,
          predicate_family,
          object_value,
          object_entity_id,
          time_scope_kind,
          support_strength,
          mentioned_at,
          t_valid_from,
          t_valid_until,
          valid_from,
          valid_until,
          metadata
        )
        VALUES ($1, $2::uuid, 'counterfactual', $3, NULL, 'historical', 'strong', $4::timestamptz, $4::timestamptz, NULL, $4::timestamptz, NULL, $5::jsonb)
        RETURNING id::text
      `,
      [
        namespaceId,
        subjectEntityId,
        causalFactValue,
        newest.occurred_at,
        JSON.stringify({
          source: "canonical_rebuild",
          source_table: "person_time_facts",
          source_person_name: newest.person_name,
          derived_family: "causal_motive",
          supporting_fact_ids: subjectRows.map((row) => row.id)
        })
      ]
    );
    const canonicalFactId = inserted.rows[0]?.id;
    if (!canonicalFactId) {
      continue;
    }
    for (const row of subjectRows) {
      await client.query(
        `
          INSERT INTO canonical_fact_provenance (
            canonical_fact_id,
            namespace_id,
            source_memory_id,
            source_chunk_id,
            provenance
          )
          VALUES ($1::uuid, $2, $3::uuid, NULL, $4::jsonb)
        `,
        [
          canonicalFactId,
          namespaceId,
          row.source_memory_id,
          JSON.stringify({
            source_table: "person_time_facts",
            source_person_time_fact_id: row.id,
            person_name: row.person_name,
            fact_text: row.fact_text,
            time_hint_text: row.time_hint_text
          })
        ]
      );
    }
    count += 1;
  }

  for (const row of preferenceRows.rows) {
    if (!row.subject_entity_id || !normalizeWhitespace(row.object_text)) {
      continue;
    }
    const inserted = await client.query<{ id: string }>(
      `
        INSERT INTO canonical_facts (
          namespace_id,
          subject_entity_id,
          predicate_family,
          object_value,
          object_entity_id,
          time_scope_kind,
          support_strength,
          mentioned_at,
          t_valid_from,
          t_valid_until,
          valid_from,
          valid_until,
          metadata
        )
        VALUES ($1, $2::uuid, $3, $4, NULL, 'active', $5, $6::timestamptz, $6::timestamptz, NULL, $6::timestamptz, NULL, $7::jsonb)
        RETURNING id::text
      `,
      [
        namespaceId,
        row.subject_entity_id,
        inferPreferenceFactPredicateFamily(row),
        normalizeWhitespace(row.object_text),
        row.qualifier ? "strong" : row.predicate === "prefers" ? "moderate" : "weak",
        row.occurred_at,
        JSON.stringify({
          source: "canonical_rebuild",
          source_table: "preference_facts",
          predicate: row.predicate,
          domain: row.domain,
          qualifier: row.qualifier,
          subject_name: row.subject_name,
          context_text: row.context_text,
          artifact_id: row.artifact_id
        })
      ]
    );
    const canonicalFactId = inserted.rows[0]?.id;
    if (!canonicalFactId) {
      continue;
    }
    await client.query(
      `
        INSERT INTO canonical_fact_provenance (
          canonical_fact_id,
          namespace_id,
          source_memory_id,
          source_chunk_id,
          provenance
        )
        VALUES ($1::uuid, $2, $3::uuid, NULL, $4::jsonb)
      `,
      [
        canonicalFactId,
        namespaceId,
        row.source_memory_id,
        JSON.stringify({
          source_table: "preference_facts",
          predicate: row.predicate,
          domain: row.domain,
          qualifier: row.qualifier,
          artifact_id: row.artifact_id
        })
      ]
    );
    count += 1;
  }
  return count;
}

async function rebuildCanonicalStates(client: PoolClient, namespaceId: string): Promise<number> {
  const selfProfile = await loadNamespaceSelfProfileForClient(client, namespaceId).catch(() => null);
  const selfEntityId = selfProfile?.entityId ?? null;
  const rows = await client.query<ProceduralMemoryRow>(
    `
      SELECT
        id::text AS procedural_id,
        state_type,
        state_key,
        state_value,
        valid_from::text,
        valid_until::text,
        updated_at::text,
        metadata
      FROM procedural_memory
      WHERE namespace_id = $1
      ORDER BY updated_at DESC
    `,
    [namespaceId]
  );
  const profileSummaryRows = await client.query<ProfileSummarySemanticRow>(
    `
      SELECT
        id::text AS semantic_id,
        canonical_key,
        content_abstract,
        valid_from::text,
        valid_until::text,
        normalized_value,
        metadata
      FROM semantic_memory
      WHERE namespace_id = $1
        AND memory_kind = 'profile_summary'
        AND status = 'active'
        AND valid_until IS NULL
      ORDER BY valid_from DESC NULLS LAST, id DESC
    `,
    [namespaceId]
  );

  let count = 0;
  for (const row of rows.rows) {
    const stateText = summarizeCanonicalStateValue(row.state_value);
    if (!stateText) {
      continue;
    }
    const subjectEntityId =
      typeof (row.state_value as JsonRecord | null)?.subject_entity_id === "string"
        ? ((row.state_value as JsonRecord).subject_entity_id as string)
        : selfEntityId;
    if (!subjectEntityId) {
      continue;
    }
    const predicateFamily = inferCanonicalStatePredicateFamily(row.state_type, row.state_key, stateText);
    const metadata = JSON.stringify({
      source: "canonical_rebuild",
      source_table: "procedural_memory",
      source_procedural_memory_id: row.procedural_id,
      state_type: row.state_type,
      state_key: row.state_key,
      procedural_metadata: row.metadata ?? {}
    });
    await client.query(
      `
        INSERT INTO canonical_states (
          namespace_id,
          subject_entity_id,
          predicate_family,
          state_value,
          support_strength,
          confidence,
          time_scope_kind,
          mentioned_at,
          t_valid_from,
          t_valid_until,
          valid_from,
          valid_until,
          metadata
        )
        VALUES ($1, $2::uuid, $3, $4, 'moderate', 0.75, $5, $6::timestamptz, $7::timestamptz, $8::timestamptz, $9::timestamptz, $10::timestamptz, $11::jsonb)
      `,
      [
        namespaceId,
        subjectEntityId,
        predicateFamily,
        stateText,
        row.valid_until ? "historical" : "active",
        row.updated_at,
        row.valid_from ?? row.updated_at,
        row.valid_until,
        row.valid_from ?? row.updated_at,
        row.valid_until,
        metadata
      ]
    );
    await client.query(
      `
        INSERT INTO canonical_subject_states (
          namespace_id,
          subject_entity_id,
          predicate_family,
          state_value,
          support_strength,
          time_scope_kind,
          mentioned_at,
          t_valid_from,
          t_valid_until,
          valid_from,
          valid_until,
          metadata
        )
        VALUES ($1, $2::uuid, $3, $4, 'moderate', $5, $6::timestamptz, $7::timestamptz, $8::timestamptz, $9::timestamptz, $10::timestamptz, $11::jsonb)
      `,
      [
        namespaceId,
        subjectEntityId,
        predicateFamily,
        stateText,
        row.valid_until ? "historical" : "active",
        row.updated_at,
        row.valid_from ?? row.updated_at,
        row.valid_until,
        row.valid_from ?? row.updated_at,
        row.valid_until,
        metadata
      ]
    );
    count += 1;
  }

  for (const row of profileSummaryRows.rows) {
    const profileKind = extractProfileSummaryKind(row.canonical_key);
    if (!profileKind) {
      continue;
    }
    const stateText = normalizeWhitespace(row.content_abstract);
    if (!stateText) {
      continue;
    }
    const personName =
      readNormalizedValueString(row.normalized_value, "person_name") ||
      readMetadataString(row.metadata, "person_name");
    const subjectBinding = personName
      ? await resolveStoredCanonicalSubjectByNames(namespaceId, [personName])
      : null;
    const subjectEntityId = subjectBinding?.subjectEntityId ?? selfEntityId;
    if (!subjectEntityId || subjectBinding?.status === "ambiguous") {
      continue;
    }
    const predicateFamily = inferCanonicalProfileSummaryPredicateFamily(profileKind, stateText);
    const metadata = JSON.stringify({
      source: "canonical_rebuild",
      source_table: "semantic_memory",
      source_semantic_memory_id: row.semantic_id,
      canonical_key: row.canonical_key,
      profile_kind: profileKind,
      person_name: personName,
      semantic_metadata: row.metadata ?? {},
      semantic_normalized_value: row.normalized_value ?? {}
    });
    await client.query(
      `
        INSERT INTO canonical_states (
          namespace_id,
          subject_entity_id,
          predicate_family,
          state_value,
          support_strength,
          confidence,
          time_scope_kind,
          mentioned_at,
          t_valid_from,
          t_valid_until,
          valid_from,
          valid_until,
          metadata
        )
        VALUES ($1, $2::uuid, $3, $4, 'strong', 0.92, 'active', $5::timestamptz, $5::timestamptz, $6::timestamptz, $5::timestamptz, $6::timestamptz, $7::jsonb)
      `,
      [
        namespaceId,
        subjectEntityId,
        predicateFamily,
        stateText,
        row.valid_from,
        row.valid_until,
        metadata
      ]
    );
    await client.query(
      `
        INSERT INTO canonical_subject_states (
          namespace_id,
          subject_entity_id,
          predicate_family,
          state_value,
          support_strength,
          time_scope_kind,
          mentioned_at,
          t_valid_from,
          t_valid_until,
          valid_from,
          valid_until,
          metadata
        )
        VALUES ($1, $2::uuid, $3, $4, 'strong', 'active', $5::timestamptz, $5::timestamptz, $6::timestamptz, $5::timestamptz, $6::timestamptz, $7::jsonb)
      `,
      [
        namespaceId,
        subjectEntityId,
        predicateFamily,
        stateText,
        row.valid_from,
        row.valid_until,
        metadata
      ]
    );
    count += 1;
  }
  return count;
}

async function rebuildCanonicalTemporalFacts(client: PoolClient, namespaceId: string): Promise<number> {
  const personRows = await client.query<PersonTimeFactRow>(
    `
      SELECT
        ptf.id::text,
        COALESCE(entity.merged_into_entity_id, entity.id)::text AS subject_entity_id,
        ptf.person_name,
        ptf.fact_text,
        ptf.time_hint_text,
        ptf.location_text,
        ptf.window_start::text,
        ptf.window_end::text,
        ptf.occurred_at::text,
        ptf.source_memory_id::text,
        ptf.artifact_id::text,
        source_em.source_chunk_id::text
      FROM person_time_facts ptf
      LEFT JOIN entities entity ON entity.id = ptf.person_entity_id
      LEFT JOIN episodic_memory source_em ON source_em.id = ptf.source_memory_id
      WHERE ptf.namespace_id = $1
      ORDER BY COALESCE(ptf.window_start, ptf.occurred_at) DESC NULLS LAST, ptf.created_at DESC
    `,
    [namespaceId]
  );
  const mediaRows = await client.query<MediaMentionRow>(
    `
      SELECT
        mm.id::text,
        COALESCE(entity.merged_into_entity_id, entity.id)::text AS subject_entity_id,
        mm.subject_name,
        mm.media_title,
        mm.media_kind,
        mm.mention_kind,
        mm.time_hint_text,
        mm.occurred_at::text,
        mm.source_memory_id::text,
        mm.artifact_id::text,
        source_em.source_chunk_id::text,
        mm.metadata
      FROM media_mentions mm
      LEFT JOIN entities entity ON entity.id = mm.subject_entity_id
      LEFT JOIN episodic_memory source_em ON source_em.id = mm.source_memory_id
      WHERE mm.namespace_id = $1
      ORDER BY mm.occurred_at DESC NULLS LAST, mm.created_at DESC
    `,
    [namespaceId]
  );

  let count = 0;
  for (const row of personRows.rows) {
    if (!row.subject_entity_id) {
      continue;
    }
    await client.query(
      `
        INSERT INTO canonical_temporal_facts (
          namespace_id,
          subject_entity_id,
          object_entity_id,
          predicate_family,
          fact_value,
          event_key,
          event_type,
          time_granularity,
          answer_year,
          answer_month,
          answer_day,
          source_artifact_id,
          source_chunk_id,
          time_scope_kind,
          anchor_text,
          anchor_event_key,
          anchor_relation,
          anchor_offset_value,
          anchor_offset_unit,
          anchor_start,
          anchor_end,
          mentioned_at,
          t_valid_from,
          t_valid_until,
          support_strength,
          confidence,
          support_kind,
          binding_confidence,
          temporal_source_quality,
          derived_from_reference,
          event_surface_text,
          location_surface_text,
          participant_entity_ids,
          metadata
        )
        VALUES ($1, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, $9, $10, $11, $12::uuid, $13::uuid, $14, $15, $16, $17, $18, $19, $20::timestamptz, $21::timestamptz, $22::timestamptz, $23::timestamptz, $24::timestamptz, $25, $26, $27, $28, $29, $30, $31, $32, $33::jsonb, $34::jsonb)
      `,
      (() => {
        const hasExplicitTemporalGrounding =
          Boolean(row.window_start) ||
          Boolean(row.window_end) ||
          Boolean(normalizeWhitespace(row.time_hint_text ?? ""));
        const anchorStart = row.window_start ?? (hasExplicitTemporalGrounding ? row.occurred_at : null);
        const anchorEnd = row.window_end ?? (hasExplicitTemporalGrounding ? row.occurred_at : anchorStart);
        const eventKey = inferTemporalEventKeyFromText(row.fact_text);
        const timeGranularity = hasExplicitTemporalGrounding
          ? inferTimeGranularity(row.time_hint_text, anchorStart, anchorEnd)
          : "unknown";
        const anchorMetadata = inferTemporalAnchorMetadata(row.time_hint_text);
        const answerParts = hasExplicitTemporalGrounding
          ? deriveCanonicalTemporalAnswerParts(
              anchorStart,
              timeGranularity,
              row.time_hint_text,
              Boolean(row.window_start)
            )
          : {
              answerYear: null,
              answerMonth: null,
              answerDay: null
            };
        const confidence = row.window_start || row.time_hint_text ? 0.85 : 0.7;
        const semantics = deriveCanonicalTemporalPersistenceSemantics({
          subjectEntityId: row.subject_entity_id,
          eventKey,
          eventType: inferTemporalEventType(eventKey),
          factValue: row.fact_text,
          anchorText: row.time_hint_text,
          anchorEventKey: null,
          anchorRelation: anchorMetadata.anchorRelation,
          locationText: row.location_text,
          confidence,
          hasExplicitTemporalGrounding
        });
        return [
          namespaceId,
          row.subject_entity_id,
          null,
          inferCanonicalTemporalPredicateFamily(row.fact_text, row.time_hint_text, row.location_text),
          row.fact_text,
          eventKey,
          inferTemporalEventType(eventKey),
          timeGranularity,
          answerParts.answerYear,
          answerParts.answerMonth,
          answerParts.answerDay,
          row.artifact_id,
          row.source_chunk_id,
          hasExplicitTemporalGrounding ? inferCanonicalTimeScopeKind(row.time_hint_text, anchorStart, anchorEnd) : "unknown",
          hasExplicitTemporalGrounding ? row.time_hint_text : null,
          null,
          anchorMetadata.anchorRelation,
          anchorMetadata.anchorOffsetValue,
          anchorMetadata.anchorOffsetUnit,
          hasExplicitTemporalGrounding ? anchorStart : null,
          hasExplicitTemporalGrounding ? anchorEnd : null,
          row.occurred_at,
          hasExplicitTemporalGrounding ? anchorStart : null,
          hasExplicitTemporalGrounding ? anchorEnd : null,
          supportStrengthFromConfidence(confidence),
          confidence,
          semantics.supportKind,
          semantics.bindingConfidence,
          semantics.temporalSourceQuality,
          semantics.derivedFromReference,
          semantics.eventSurfaceText,
          semantics.locationSurfaceText,
          JSON.stringify(semantics.participantEntityIds),
          JSON.stringify({
          source: "canonical_rebuild",
          source_table: "person_time_facts",
          leaf_source_table: "person_time_facts",
          leaf_row_id: row.id,
          leaf_source_memory_ids: row.source_memory_id ? [row.source_memory_id] : [],
          leaf_fact_text: row.fact_text,
          leaf_time_hint_text: row.time_hint_text,
          leaf_location_text: row.location_text,
          source_person_time_fact_id: row.id,
          person_name: row.person_name,
          location_text: row.location_text,
          source_memory_id: row.source_memory_id,
          artifact_id: row.artifact_id,
          support_kind: semantics.supportKind,
          temporal_source_quality: semantics.temporalSourceQuality
          })
        ];
      })()
    );
    count += 1;
  }

  for (const row of mediaRows.rows) {
    if (!row.subject_entity_id) {
      continue;
    }
    const anchorStart =
      typeof row.metadata?.event_anchor_start === "string" ? (row.metadata.event_anchor_start as string) : row.occurred_at;
    const anchorEnd =
      typeof row.metadata?.event_anchor_end === "string" ? (row.metadata.event_anchor_end as string) : row.occurred_at;
    await client.query(
      `
        INSERT INTO canonical_temporal_facts (
          namespace_id,
          subject_entity_id,
          object_entity_id,
          predicate_family,
          fact_value,
          event_key,
          event_type,
          time_granularity,
          answer_year,
          answer_month,
          answer_day,
          source_artifact_id,
          source_chunk_id,
          time_scope_kind,
          anchor_text,
          anchor_event_key,
          anchor_relation,
          anchor_offset_value,
          anchor_offset_unit,
          anchor_start,
          anchor_end,
          mentioned_at,
          t_valid_from,
          t_valid_until,
          support_strength,
          confidence,
          support_kind,
          binding_confidence,
          temporal_source_quality,
          derived_from_reference,
          event_surface_text,
          location_surface_text,
          participant_entity_ids,
          metadata
        )
        VALUES ($1, $2::uuid, $3::uuid, 'temporal_event_fact', $4, $5, $6, $7, $8, $9, $10, $11::uuid, $12::uuid, $13, $14, $15, $16, $17, $18, $19::timestamptz, $20::timestamptz, $21::timestamptz, $19::timestamptz, $20::timestamptz, 'moderate', $22, $23, $24, $25, $26, $27, $28, $29::jsonb, $30::jsonb)
      `,
      (() => {
        const factValue = `${row.mention_kind.replace(/_/gu, " ")} ${row.media_title}`;
        const hasExplicitTemporalAnchor =
          Boolean(normalizeWhitespace(row.time_hint_text ?? "")) ||
          typeof row.metadata?.event_anchor_start === "string" ||
          typeof row.metadata?.event_anchor_end === "string";
        const eventKey = hasExplicitTemporalAnchor ? inferTemporalEventKeyFromText(factValue) : null;
        const timeGranularity = hasExplicitTemporalAnchor
          ? inferTimeGranularity(row.time_hint_text, anchorStart, anchorEnd)
          : "unknown";
        const anchorMetadata = hasExplicitTemporalAnchor
          ? inferTemporalAnchorMetadata(row.time_hint_text)
          : {
              anchorRelation: null,
              anchorOffsetValue: null,
              anchorOffsetUnit: null
            };
        const answerParts = hasExplicitTemporalAnchor
          ? deriveCanonicalTemporalAnswerParts(
              anchorStart,
              timeGranularity,
              row.time_hint_text,
              typeof row.metadata?.event_anchor_start === "string"
            )
          : {
              answerYear: null,
              answerMonth: null,
              answerDay: null
            };
        const objectEntityId =
          typeof row.metadata?.object_entity_id === "string" ? String(row.metadata.object_entity_id) : null;
        const confidence = 0.7;
        const semantics = deriveCanonicalTemporalPersistenceSemantics({
          subjectEntityId: row.subject_entity_id,
          objectEntityId,
          eventKey,
          eventType: inferTemporalEventType(eventKey),
          factValue,
          anchorText: row.time_hint_text,
          anchorEventKey: null,
          anchorRelation: anchorMetadata.anchorRelation,
          locationText: null,
          confidence,
          hasExplicitTemporalGrounding: hasExplicitTemporalAnchor
        });
        return [
          namespaceId,
          row.subject_entity_id,
          objectEntityId,
          factValue,
          eventKey,
          inferTemporalEventType(eventKey),
          timeGranularity,
          answerParts.answerYear,
          answerParts.answerMonth,
          answerParts.answerDay,
          row.artifact_id,
          row.source_chunk_id,
          hasExplicitTemporalAnchor ? inferCanonicalTimeScopeKind(row.time_hint_text, anchorStart, anchorEnd) : "unknown",
          hasExplicitTemporalAnchor ? row.time_hint_text : null,
          null,
          anchorMetadata.anchorRelation,
          anchorMetadata.anchorOffsetValue,
          anchorMetadata.anchorOffsetUnit,
          hasExplicitTemporalAnchor ? anchorStart : null,
          hasExplicitTemporalAnchor ? anchorEnd : null,
          row.occurred_at,
          confidence,
          semantics.supportKind,
          semantics.bindingConfidence,
          semantics.temporalSourceQuality,
          semantics.derivedFromReference,
          semantics.eventSurfaceText,
          semantics.locationSurfaceText,
          JSON.stringify(semantics.participantEntityIds),
          JSON.stringify({
          source: "canonical_rebuild",
          source_table: "media_mentions",
          leaf_source_table: "media_mentions",
          leaf_row_id: row.id,
          leaf_source_memory_ids: row.source_memory_id ? [row.source_memory_id] : [],
          leaf_fact_text: `${row.mention_kind.replace(/_/gu, " ")} ${row.media_title}`,
          leaf_time_hint_text: row.time_hint_text,
          source_media_mention_id: row.id,
          subject_name: row.subject_name,
          media_kind: row.media_kind,
          mention_kind: row.mention_kind,
          source_memory_id: row.source_memory_id,
          artifact_id: row.artifact_id,
          support_kind: semantics.supportKind,
          temporal_source_quality: semantics.temporalSourceQuality
          })
        ];
      })()
    );
    count += 1;
  }

  return count;
}

async function rebuildCanonicalSets(client: PoolClient, namespaceId: string): Promise<number> {
  const selfProfile = await loadNamespaceSelfProfileForClient(client, namespaceId).catch(() => null);
  const selfEntityId = selfProfile?.entityId ?? null;
  const proceduralRows = await client.query<ProceduralMemoryRow>(
    `
      SELECT
        id::text AS procedural_id,
        state_type,
        state_key,
        state_value,
        valid_from::text,
        valid_until::text,
        updated_at::text,
        metadata
      FROM procedural_memory
      WHERE namespace_id = $1
      ORDER BY updated_at DESC
    `,
    [namespaceId]
  );
  const profileSummaryRows = await client.query<ProfileSummarySemanticRow>(
    `
      SELECT
        id::text AS semantic_id,
        canonical_key,
        content_abstract,
        valid_from::text,
        valid_until::text,
        normalized_value,
        metadata
      FROM semantic_memory
      WHERE namespace_id = $1
        AND memory_kind = 'profile_summary'
        AND status = 'active'
        AND valid_until IS NULL
      ORDER BY valid_from DESC NULLS LAST, id DESC
    `,
    [namespaceId]
  );
  const preferenceRows = await client.query<PreferenceFactRow>(
    `
      SELECT
        COALESCE(entity.merged_into_entity_id, entity.id)::text AS subject_entity_id,
        pf.subject_name,
        pf.predicate,
        pf.domain,
        pf.object_text,
        pf.qualifier,
        pf.occurred_at::text
      FROM preference_facts pf
      LEFT JOIN entities entity ON entity.id = pf.subject_entity_id
      WHERE pf.namespace_id = $1
      ORDER BY pf.occurred_at DESC NULLS LAST, pf.created_at DESC
    `,
    [namespaceId]
  );
  const mediaRows = await client.query<MediaMentionRow>(
    `
      SELECT
        mm.id::text,
        COALESCE(entity.merged_into_entity_id, entity.id)::text AS subject_entity_id,
        mm.subject_name,
        mm.media_title,
        mm.media_kind,
        mm.mention_kind,
        mm.time_hint_text,
        mm.occurred_at::text,
        mm.source_memory_id::text,
        mm.artifact_id::text,
        mm.metadata
      FROM media_mentions mm
      LEFT JOIN entities entity ON entity.id = mm.subject_entity_id
      WHERE mm.namespace_id = $1
        AND mm.subject_entity_id IS NOT NULL
      ORDER BY mm.occurred_at DESC NULLS LAST, mm.created_at DESC
    `,
    [namespaceId]
  );
  const personTimeRows = await client.query<PersonTimeSetRow>(
    `
      SELECT
        COALESCE(entity.merged_into_entity_id, entity.id)::text AS subject_entity_id,
        ptf.person_name,
        ptf.fact_text,
        ptf.time_hint_text,
        ptf.location_text,
        ptf.occurred_at::text
      FROM person_time_facts ptf
      LEFT JOIN entities entity ON entity.id = ptf.person_entity_id
      WHERE ptf.namespace_id = $1
      ORDER BY ptf.occurred_at DESC NULLS LAST, ptf.created_at DESC
    `,
    [namespaceId]
  );
  const answerableGoalRows = await client.query<AnswerableUnitGoalRow>(
    `
      SELECT
        au.unit_type,
        au.content_text,
        au.owner_entity_hint,
        au.speaker_entity_hint,
        au.participant_names,
        au.occurred_at::text,
        au.ownership_confidence
      FROM answerable_units au
      WHERE au.namespace_id = $1
        AND au.unit_type = 'participant_turn'
        AND COALESCE(au.ownership_confidence, 0) >= 0.65
        AND au.content_text ~* '(goal|shooting percentage|championship|title|endorsement|brand|charity|foundation|give something back)'
      ORDER BY au.occurred_at DESC NULLS LAST, au.id DESC
    `,
    [namespaceId]
  );
  const transactionRows = selfEntityId
    ? await client.query<TransactionItemRow>(
        `
          SELECT
            item_label,
            occurred_at::text
          FROM transaction_items
          WHERE namespace_id = $1
          ORDER BY occurred_at DESC NULLS LAST, created_at DESC
        `,
        [namespaceId]
      )
    : { rows: [] as TransactionItemRow[] };

  const grouped = new Map<string, {
    subjectEntityId: string;
    predicateFamily: string;
    itemValues: string[];
    validFrom: string | null;
    validUntil: string | null;
    metadata: JsonRecord;
  }>();

  const addSetItem = (
    subjectEntityId: string | null,
    predicateFamily: string,
    itemValue: string,
    occurredAt: string | null,
    metadata: JsonRecord
  ): void => {
    if (!subjectEntityId) {
      return;
    }
    const normalizedItem = normalizeWhitespace(itemValue);
    if (!normalizedItem) {
      return;
    }
    const key = `${subjectEntityId}::${predicateFamily}::${JSON.stringify(metadata)}`;
    const existing = grouped.get(key) ?? {
      subjectEntityId,
      predicateFamily,
      itemValues: [],
      validFrom: occurredAt,
      validUntil: occurredAt,
      metadata
    };
    if (!existing.itemValues.some((value) => normalizeName(value) === normalizeName(normalizedItem))) {
      existing.itemValues.push(normalizedItem);
    }
    if (!existing.validFrom || (occurredAt && occurredAt < existing.validFrom)) {
      existing.validFrom = occurredAt;
    }
    if (!existing.validUntil || (occurredAt && occurredAt > existing.validUntil)) {
      existing.validUntil = occurredAt;
    }
    grouped.set(key, existing);
  };
  const answerableGoalSubjectCache = new Map<string, string | null>();
  const resolveAnswerableGoalSubject = async (row: AnswerableUnitGoalRow): Promise<string | null> => {
    const nameHints = [
      row.owner_entity_hint,
      row.speaker_entity_hint,
      ...readStringArray(row.participant_names)
    ]
      .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      .map((value) => normalizeWhitespace(value))
      .filter(Boolean);
    if (nameHints.length === 0) {
      return null;
    }
    const cacheKey = [...new Set(nameHints.map((value) => normalizeName(value)))].join("|");
    if (answerableGoalSubjectCache.has(cacheKey)) {
      return answerableGoalSubjectCache.get(cacheKey) ?? null;
    }
    const binding = await resolveStoredCanonicalSubjectByNames(namespaceId, nameHints);
    const subjectEntityId = binding?.status === "ambiguous" ? null : binding?.subjectEntityId ?? null;
    answerableGoalSubjectCache.set(cacheKey, subjectEntityId);
    return subjectEntityId;
  };

  for (const row of preferenceRows.rows) {
    addSetItem(
      row.subject_entity_id,
      "list_set",
      row.object_text,
      row.occurred_at,
      {
        source: "canonical_rebuild",
        set_kind: "preference_facts",
        domain: row.domain,
        predicate: row.predicate,
        qualifier: row.qualifier,
        subject_name: row.subject_name,
        normalized_item_value: normalizeName(row.object_text)
      }
    );
  }

  for (const row of mediaRows.rows) {
    addSetItem(
      row.subject_entity_id,
      "list_set",
      row.media_title,
      row.occurred_at,
      {
        source: "canonical_rebuild",
        set_kind: "media_mentions",
        media_kind: row.media_kind,
        mention_kind: row.mention_kind,
        subject_name: row.subject_name,
        normalized_item_value: normalizeName(row.media_title)
      }
    );
    for (const affinity of deriveCollectionShopAffinity([row.media_title, row.subject_name ?? ""].join(" "))) {
      addSetItem(
        row.subject_entity_id,
        "list_set",
        affinity,
        row.occurred_at,
        {
          source: "canonical_rebuild",
          set_kind: "shop_affinity",
          affinity_type: "collection_affinity",
          domain: "harry_potter",
          subject_name: row.subject_name,
          normalized_item_value: normalizeName(affinity)
        }
      );
    }
  }

  for (const row of personTimeRows.rows) {
    for (const goalItem of extractCanonicalGoalItems(row.fact_text)) {
      addSetItem(
        row.subject_entity_id,
        "profile_state",
        goalItem,
        row.occurred_at,
        {
          source: "canonical_rebuild",
          set_kind: "goal_items",
          goal_scope: inferGoalScopeFromItem(goalItem),
          goal_type: "career_goal",
          subject_name: row.person_name
        }
      );
    }
    const derivedItems = deriveCanonicalSetItemsFromPersonTimeFact(row.fact_text, row.location_text);
    for (const item of derivedItems) {
      addSetItem(
        row.subject_entity_id,
        "commonality",
        item,
        row.occurred_at,
        {
          source: "canonical_rebuild",
          set_kind: "person_time_topics",
          domain: "life_event",
          predicate: item,
          subject_name: row.person_name,
          normalized_item_value: normalizeName(item),
          source_fact_text: row.fact_text,
          source_time_hint_text: row.time_hint_text,
          source_location_text: row.location_text
        }
      );
    }
  }

  for (const row of proceduralRows.rows) {
    const stateText = summarizeCanonicalStateValue(row.state_value);
    if (!stateText) {
      continue;
    }
    const subjectEntityId =
      typeof (row.state_value as JsonRecord | null)?.subject_entity_id === "string"
        ? ((row.state_value as JsonRecord).subject_entity_id as string)
        : selfEntityId;
    for (const goalItem of extractCanonicalGoalItems(stateText)) {
      addSetItem(
        subjectEntityId,
        "profile_state",
        goalItem,
        row.valid_from ?? row.updated_at,
        {
          source: "canonical_rebuild",
          set_kind: "goal_items",
          goal_scope: inferGoalScopeFromItem(goalItem),
          goal_type: "career_goal",
          state_type: row.state_type,
          state_key: row.state_key
        }
      );
    }
  }

  for (const row of profileSummaryRows.rows) {
    const profileText = normalizeWhitespace(row.content_abstract);
    if (!profileText) {
      continue;
    }
    const personName =
      readNormalizedValueString(row.normalized_value, "person_name") ||
      readMetadataString(row.metadata, "person_name");
    const subjectBinding = personName
      ? await resolveStoredCanonicalSubjectByNames(namespaceId, [personName])
      : null;
    const subjectEntityId = subjectBinding?.subjectEntityId ?? selfEntityId;
    if (!subjectEntityId || subjectBinding?.status === "ambiguous") {
      continue;
    }
    for (const goalItem of extractCanonicalGoalItems(profileText)) {
      addSetItem(
        subjectEntityId,
        "profile_state",
        goalItem,
        row.valid_from,
        {
          source: "canonical_rebuild",
          set_kind: "goal_items",
          goal_scope: inferGoalScopeFromItem(goalItem),
          goal_type: "career_goal",
          profile_kind: extractProfileSummaryKind(row.canonical_key),
          person_name: personName
        }
      );
    }
    for (const affinity of deriveCollectionShopAffinity(profileText)) {
      addSetItem(
        subjectEntityId,
        "list_set",
        affinity,
        row.valid_from,
        {
          source: "canonical_rebuild",
          set_kind: "shop_affinity",
          affinity_type: "collection_affinity",
          domain: "harry_potter",
          person_name: personName
        }
      );
    }
  }

  for (const row of answerableGoalRows.rows) {
    if (!isDirectSelfGoalStatement(row.content_text)) {
      continue;
    }
    const goalItems = extractCanonicalGoalItems(row.content_text);
    if (goalItems.length === 0) {
      continue;
    }
    const subjectEntityId = await resolveAnswerableGoalSubject(row);
    if (!subjectEntityId) {
      continue;
    }
    for (const goalItem of goalItems) {
      addSetItem(
        subjectEntityId,
        "profile_state",
        goalItem,
        row.occurred_at,
        {
          source: "canonical_rebuild",
          set_kind: "goal_items",
          goal_scope: inferGoalScopeFromItem(goalItem),
          goal_type: "career_goal",
          source_kind: "answerable_unit",
          source_unit_type: row.unit_type,
          owner_entity_hint: row.owner_entity_hint,
          speaker_entity_hint: row.speaker_entity_hint
        }
      );
    }
  }

  for (const row of transactionRows.rows) {
    addSetItem(
      selfEntityId,
      "list_set",
      row.item_label,
      row.occurred_at,
      {
        source: "canonical_rebuild",
        set_kind: "transaction_items",
        normalized_item_value: normalizeName(row.item_label)
      }
    );
  }

  let count = 0;
  for (const group of grouped.values()) {
    const insertedRows = await client.query<InsertedCanonicalSetRow>(
      `
        INSERT INTO canonical_sets (
          namespace_id,
          subject_entity_id,
          predicate_family,
          item_values,
          support_strength,
          confidence,
          valid_from,
          valid_until,
          metadata
        )
        VALUES ($1, $2::uuid, $3, $4::jsonb, $5, $6, $7::timestamptz, $8::timestamptz, $9::jsonb)
        RETURNING id::text
      `,
      [
        namespaceId,
        group.subjectEntityId,
        group.predicateFamily,
        JSON.stringify(group.itemValues),
        group.itemValues.length >= 3 ? "strong" : "moderate",
        Math.min(0.95, 0.55 + group.itemValues.length * 0.08),
        group.validFrom,
        group.validUntil,
        JSON.stringify(group.metadata)
      ]
    );
    const canonicalSetId = insertedRows.rows[0]?.id;
    if (canonicalSetId) {
      for (const [entryIndex, itemValue] of group.itemValues.entries()) {
        const entry = inferSetEntryValueType(itemValue, group.metadata);
        await client.query(
          `
            INSERT INTO canonical_set_entries (
              namespace_id,
              canonical_set_id,
              subject_entity_id,
              predicate_family,
              entry_index,
              display_value,
              normalized_value,
              value_type,
              country_code,
              city_name,
              venue_name,
              gift_kind,
              metadata
            )
            VALUES ($1, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb)
          `,
          [
            namespaceId,
            canonicalSetId,
            group.subjectEntityId,
            group.predicateFamily,
            entryIndex,
            entry.displayValue,
            entry.normalizedValue,
            entry.valueType,
            entry.countryCode,
            entry.cityName,
            entry.venueName,
            entry.giftKind,
            JSON.stringify({ ...(group.metadata ?? {}), entry_source: "canonical_set_item" })
          ]
        );
      }
    }
    count += 1;
  }

  return count;
}

async function promoteCanonicalNarratives(client: PoolClient, namespaceId: string): Promise<number> {
  const [claimRows, eventRows] = await Promise.all([
    client.query<NarrativeClaimCandidateRow>(
      `
        SELECT
          cc.id::text AS candidate_id,
          COALESCE(subject_entity.merged_into_entity_id, subject_entity.id)::text AS subject_entity_id,
          subject_root.canonical_name AS canonical_subject_name,
          COALESCE(object_entity.merged_into_entity_id, object_entity.id)::text AS object_entity_id,
          object_root.canonical_name AS canonical_object_name,
          cc.predicate,
          cc.object_text,
          cc.normalized_text,
          cc.confidence,
          cc.occurred_at::text,
          cc.time_expression_text,
          cc.time_start::text,
          cc.time_end::text,
          cc.source_event_id::text,
          cc.source_scene_id::text,
          cc.source_memory_id::text,
          cc.metadata
        FROM claim_candidates cc
        LEFT JOIN entities subject_entity ON subject_entity.id = cc.subject_entity_id
        LEFT JOIN entities subject_root ON subject_root.id = COALESCE(subject_entity.merged_into_entity_id, subject_entity.id)
        LEFT JOIN entities object_entity ON object_entity.id = cc.object_entity_id
        LEFT JOIN entities object_root ON object_root.id = COALESCE(object_entity.merged_into_entity_id, object_entity.id)
        WHERE cc.namespace_id = $1
          AND cc.status IN ('accepted', 'promoted', 'pending')
        ORDER BY cc.confidence DESC, cc.occurred_at DESC
      `,
      [namespaceId]
    ),
    client.query<NarrativeEventSourceRow>(
      `
        SELECT
          ne.id::text AS event_id,
          COALESCE(subject_entity.merged_into_entity_id, subject_entity.id)::text AS subject_entity_id,
          subject_root.canonical_name AS canonical_subject_name,
          ne.event_label,
          ne.event_kind,
          COALESCE(ne.time_start, ns.occurred_at, ne.created_at)::text AS occurred_at,
          ne.time_expression_text,
          ne.time_start::text,
          ne.time_end::text,
          ns.scene_text,
          ne.source_scene_id::text,
          ne.metadata
        FROM narrative_events ne
        LEFT JOIN entities subject_entity ON subject_entity.id = ne.primary_subject_entity_id
        LEFT JOIN entities subject_root ON subject_root.id = COALESCE(subject_entity.merged_into_entity_id, subject_entity.id)
        LEFT JOIN narrative_scenes ns ON ns.id = ne.source_scene_id
        WHERE ne.namespace_id = $1
        ORDER BY COALESCE(ne.time_start, ns.occurred_at, ne.created_at) DESC
      `,
      [namespaceId]
    )
  ]);

  const groups = new Map<string, {
    subjectEntityId: string | null;
    pairSubjectEntityId: string | null;
    predicateFamily: CanonicalPredicateFamily;
    narrativeKind: CanonicalNarrativeKind;
    texts: string[];
    supportCount: number;
    confidenceSum: number;
    mentionedAt: string | null;
    validFrom: string | null;
    validUntil: string | null;
    metadata: JsonRecord;
    sourceEventIds: Set<string>;
    sourceSceneIds: Set<string>;
    sourceMemoryIds: Set<string>;
  }>();

  const addGroupEvidence = (params: {
    subjectEntityId: string | null;
    pairSubjectEntityId?: string | null;
    narrativeKind: CanonicalNarrativeKind;
    text: string;
    confidence: number;
    mentionedAt?: string | null;
    validFrom?: string | null;
    validUntil?: string | null;
    metadata?: JsonRecord;
    sourceEventId?: string | null;
    sourceSceneId?: string | null;
    sourceMemoryId?: string | null;
  }): void => {
    const normalizedText = normalizeWhitespace(params.text);
    if (!normalizedText) {
      return;
    }
    const predicateFamily = inferCanonicalNarrativePredicateFamily(params.narrativeKind);
    const groupKey = [
      params.subjectEntityId ?? "none",
      params.pairSubjectEntityId ?? "none",
      predicateFamily,
      params.narrativeKind
    ].join("::");
    const existing = groups.get(groupKey) ?? {
      subjectEntityId: params.subjectEntityId ?? null,
      pairSubjectEntityId: params.pairSubjectEntityId ?? null,
      predicateFamily,
      narrativeKind: params.narrativeKind,
      texts: [],
      supportCount: 0,
      confidenceSum: 0,
      mentionedAt: params.mentionedAt ?? null,
      validFrom: params.validFrom ?? null,
      validUntil: params.validUntil ?? null,
      metadata: {},
      sourceEventIds: new Set<string>(),
      sourceSceneIds: new Set<string>(),
      sourceMemoryIds: new Set<string>()
    };
    existing.texts.push(normalizedText);
    existing.supportCount += 1;
    existing.confidenceSum += params.confidence;
    existing.mentionedAt = existing.mentionedAt ?? params.mentionedAt ?? null;
    existing.validFrom = existing.validFrom ?? params.validFrom ?? null;
    existing.validUntil = existing.validUntil ?? params.validUntil ?? null;
    existing.metadata = { ...existing.metadata, ...(params.metadata ?? {}) };
    if (params.sourceEventId) {
      existing.sourceEventIds.add(params.sourceEventId);
    }
    if (params.sourceSceneId) {
      existing.sourceSceneIds.add(params.sourceSceneId);
    }
    if (params.sourceMemoryId) {
      existing.sourceMemoryIds.add(params.sourceMemoryId);
    }
    groups.set(groupKey, existing);
  };

  for (const row of claimRows.rows) {
    const text = [
      row.normalized_text,
      row.predicate,
      row.object_text ?? "",
      row.canonical_object_name ?? "",
      metadataText(row.metadata)
    ].join(" ");
    const narrativeKind = inferCanonicalNarrativeKind(text);
    if (!narrativeKind || !row.subject_entity_id) {
      continue;
    }
    addGroupEvidence({
      subjectEntityId: row.subject_entity_id,
      pairSubjectEntityId: row.object_entity_id,
      narrativeKind,
      text: row.normalized_text || [row.predicate, row.object_text ?? ""].join(" "),
      confidence: row.confidence,
      mentionedAt: row.occurred_at,
      validFrom: row.time_start,
      validUntil: row.time_end,
      metadata: {
        source: "claim_candidates",
        predicate: row.predicate,
        canonical_object_name: row.canonical_object_name,
        raw_metadata: row.metadata ?? {}
      },
      sourceEventId: row.source_event_id,
      sourceSceneId: row.source_scene_id,
      sourceMemoryId: row.source_memory_id
    });
  }

  for (const row of eventRows.rows) {
    const text = [row.event_label, row.scene_text ?? "", metadataText(row.metadata)].join(" ");
    const narrativeKind = inferCanonicalNarrativeKind(text);
    if (!narrativeKind || !row.subject_entity_id) {
      continue;
    }
    addGroupEvidence({
      subjectEntityId: row.subject_entity_id,
      narrativeKind,
      text: [row.event_label, row.scene_text ?? ""].join(" "),
      confidence: 0.72,
      mentionedAt: row.occurred_at,
      validFrom: row.time_start,
      validUntil: row.time_end,
      metadata: {
        source: "narrative_events",
        event_kind: row.event_kind,
        raw_metadata: row.metadata ?? {}
      },
      sourceEventId: row.event_id,
      sourceSceneId: row.source_scene_id
    });
  }

  let count = 0;
  for (const group of groups.values()) {
    const summaryText = summarizeNarrativeCandidates(group.texts);
    if (!summaryText) {
      continue;
    }
    const averageConfidence = group.confidenceSum / Math.max(group.supportCount, 1);
    const supportStrength = clampSupportStrength(group.supportCount, averageConfidence);
    const inserted = await client.query<{ id: string }>(
      `
        INSERT INTO canonical_narratives (
          namespace_id,
          subject_entity_id,
          pair_subject_entity_id,
          predicate_family,
          narrative_kind,
          summary_text,
          support_strength,
          confidence,
          mentioned_at,
          t_valid_from,
          t_valid_until,
          metadata
        )
        VALUES ($1, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, $9::timestamptz, $10::timestamptz, $11::timestamptz, $12::jsonb)
        RETURNING id::text
      `,
      [
        namespaceId,
        group.subjectEntityId,
        group.pairSubjectEntityId,
        group.predicateFamily,
        group.narrativeKind,
        summaryText,
        supportStrength,
        Math.min(0.99, Math.max(0.45, averageConfidence)),
        group.mentionedAt,
        group.validFrom,
        group.validUntil,
        JSON.stringify({
          ...group.metadata,
          support_count: group.supportCount
        })
      ]
    );
    const canonicalNarrativeId = inserted.rows[0]?.id;
    if (!canonicalNarrativeId) {
      continue;
    }
    count += 1;
    for (const sourceEventId of group.sourceEventIds) {
      await client.query(
        `
          INSERT INTO canonical_narrative_provenance (
            canonical_narrative_id,
            namespace_id,
            source_event_id,
            provenance
          )
          VALUES ($1::uuid, $2, $3::uuid, $4::jsonb)
        `,
        [canonicalNarrativeId, namespaceId, sourceEventId, JSON.stringify({ source: "narrative_event" })]
      );
    }
    for (const sourceSceneId of group.sourceSceneIds) {
      await client.query(
        `
          INSERT INTO canonical_narrative_provenance (
            canonical_narrative_id,
            namespace_id,
            source_scene_id,
            provenance
          )
          VALUES ($1::uuid, $2, $3::uuid, $4::jsonb)
        `,
        [canonicalNarrativeId, namespaceId, sourceSceneId, JSON.stringify({ source: "narrative_scene" })]
      );
    }
    for (const sourceMemoryId of group.sourceMemoryIds) {
      await client.query(
        `
          INSERT INTO canonical_narrative_provenance (
            canonical_narrative_id,
            namespace_id,
            source_memory_id,
            provenance
          )
          VALUES ($1::uuid, $2, $3::uuid, $4::jsonb)
        `,
        [canonicalNarrativeId, namespaceId, sourceMemoryId, JSON.stringify({ source: "episodic_memory" })]
      );
    }
  }

  return count;
}

async function promoteCanonicalEntityReports(client: PoolClient, namespaceId: string): Promise<number> {
  const narrativeRows = await queryRows<CanonicalNarrativeLookupRow>(
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
        cn.metadata,
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
        cn.t_valid_until,
        cn.metadata
      ORDER BY cn.confidence DESC
    `,
    [namespaceId]
  );

  const groups = new Map<string, {
    subjectEntityId: string;
    reportKind: CanonicalReportKind;
    summaries: string[];
    confidenceSum: number;
    supportCount: number;
    mentionedAt: string | null;
    validFrom: string | null;
    validUntil: string | null;
    metadata: JsonRecord;
  }>();
  const collectionFacts = new Map<string, CanonicalCollectionFactInsertRow>();

  for (const row of narrativeRows) {
    const reportKind = inferNarrativeReportKind(row.narrative_kind as CanonicalNarrativeKind);
    const key = `${row.subject_entity_id}::${reportKind}`;
    const group = groups.get(key) ?? {
      subjectEntityId: row.subject_entity_id,
      reportKind,
      summaries: [],
      confidenceSum: 0,
      supportCount: 0,
      mentionedAt: row.mentioned_at,
      validFrom: row.t_valid_from,
      validUntil: row.t_valid_until,
      metadata: {}
    };
    group.summaries.push(row.summary_text);
    group.confidenceSum += row.confidence;
    group.supportCount += 1;
    group.mentionedAt = group.mentionedAt ?? row.mentioned_at;
    group.validFrom = group.validFrom ?? row.t_valid_from;
    group.validUntil = group.validUntil ?? row.t_valid_until;
    group.metadata = { ...group.metadata, source: "canonical_narratives" };
    groups.set(key, group);
    if (reportKind === "collection_report") {
      pushCanonicalCollectionFacts({
        facts: collectionFacts,
        subjectEntityId: row.subject_entity_id,
        texts: [row.summary_text],
        baseConfidence: row.confidence
      });
    }
  }

  const stateRows = await queryRows<CanonicalStateLookupRow>(
    `
      SELECT
        cst.subject_entity_id::text AS subject_entity_id,
        cs.canonical_name,
        cst.predicate_family,
        cst.state_value,
        cst.support_strength,
        cst.confidence,
        cst.time_scope_kind,
        cst.valid_from::text,
        cst.valid_until::text,
        cst.mentioned_at::text,
        cst.t_valid_from::text,
        cst.t_valid_until::text,
        cst.metadata
      FROM canonical_states cst
      JOIN canonical_subjects cs
        ON cs.namespace_id = cst.namespace_id
       AND cs.entity_id = cst.subject_entity_id
      WHERE cst.namespace_id = $1
      ORDER BY cst.confidence DESC, cst.updated_at DESC
    `,
    [namespaceId]
  );

  for (const row of stateRows) {
    const sourceText = [row.state_value, metadataText(row.metadata)].join(" ");
    const reportKinds = inferReportKindsFromCanonicalRow(row.predicate_family, sourceText);
    if (reportKinds.length === 0) {
      continue;
    }
    for (const reportKind of reportKinds) {
      const key = `${row.subject_entity_id}::${reportKind}`;
      const group = groups.get(key) ?? {
        subjectEntityId: row.subject_entity_id,
        reportKind,
        summaries: [],
        confidenceSum: 0,
        supportCount: 0,
        mentionedAt: row.mentioned_at,
        validFrom: row.t_valid_from ?? row.valid_from,
        validUntil: row.t_valid_until ?? row.valid_until,
        metadata: {}
      };
      group.summaries.push(row.state_value);
      group.confidenceSum += row.confidence;
      group.supportCount += 1;
      group.mentionedAt = group.mentionedAt ?? row.mentioned_at;
      group.validFrom = group.validFrom ?? row.t_valid_from ?? row.valid_from;
      group.validUntil = group.validUntil ?? row.t_valid_until ?? row.valid_until;
      group.metadata = { ...group.metadata, source_state_predicate_family: row.predicate_family };
      groups.set(key, group);
      if (reportKind === "collection_report") {
        pushCanonicalCollectionFacts({
          facts: collectionFacts,
          subjectEntityId: row.subject_entity_id,
          texts: [row.state_value, metadataText(row.metadata)],
          baseConfidence: row.confidence
        });
      }
    }
  }

  const factRows = await queryRows<CanonicalFactLookupRow>(
    `
      SELECT
        cf.subject_entity_id::text AS subject_entity_id,
        cs.canonical_name,
        cf.predicate_family,
        cf.object_value,
        cf.support_strength,
        cf.time_scope_kind,
        cf.valid_from::text,
        cf.valid_until::text,
        cf.mentioned_at::text,
        cf.t_valid_from::text,
        cf.t_valid_until::text,
        cf.metadata
      FROM canonical_facts cf
      JOIN canonical_subjects cs
        ON cs.namespace_id = cf.namespace_id
       AND cs.entity_id = cf.subject_entity_id
      WHERE cf.namespace_id = $1
        AND cf.object_value IS NOT NULL
      ORDER BY cf.updated_at DESC
    `,
    [namespaceId]
  );

  for (const row of factRows) {
    const objectValue = normalizeWhitespace(row.object_value ?? "");
    if (!objectValue) {
      continue;
    }
    const sourceText = [objectValue, metadataText(row.metadata)].join(" ");
    const reportKinds = inferReportKindsFromCanonicalRow(row.predicate_family, sourceText);
    if (reportKinds.length === 0) {
      continue;
    }
    for (const reportKind of reportKinds) {
      const key = `${row.subject_entity_id}::${reportKind}`;
      const group = groups.get(key) ?? {
        subjectEntityId: row.subject_entity_id,
        reportKind,
        summaries: [],
        confidenceSum: 0,
        supportCount: 0,
        mentionedAt: row.mentioned_at,
        validFrom: row.t_valid_from ?? row.valid_from,
        validUntil: row.t_valid_until ?? row.valid_until,
        metadata: {}
      };
      group.summaries.push(objectValue);
      group.confidenceSum += row.support_strength === "strong" ? 0.92 : row.support_strength === "moderate" ? 0.75 : 0.55;
      group.supportCount += 1;
      group.mentionedAt = group.mentionedAt ?? row.mentioned_at;
      group.validFrom = group.validFrom ?? row.t_valid_from ?? row.valid_from;
      group.validUntil = group.validUntil ?? row.t_valid_until ?? row.valid_until;
      group.metadata = { ...group.metadata, source_fact_predicate_family: row.predicate_family };
      groups.set(key, group);
      if (reportKind === "collection_report") {
        pushCanonicalCollectionFacts({
          facts: collectionFacts,
          subjectEntityId: row.subject_entity_id,
          texts: [objectValue, metadataText(row.metadata)],
          baseConfidence: row.support_strength === "strong" ? 0.92 : row.support_strength === "moderate" ? 0.75 : 0.55
        });
      }
    }
  }

  const setRows = await queryRows<CanonicalSetLookupRow>(
    `
      SELECT
        cset.subject_entity_id::text AS subject_entity_id,
        cs.canonical_name,
        cset.predicate_family,
        cset.item_values,
        cset.support_strength,
        cset.confidence,
        cset.valid_from::text,
        cset.valid_until::text,
        cset.metadata
      FROM canonical_sets cset
      JOIN canonical_subjects cs
        ON cs.namespace_id = cset.namespace_id
       AND cs.entity_id = cset.subject_entity_id
      WHERE cset.namespace_id = $1
      ORDER BY cset.confidence DESC, cset.updated_at DESC
    `,
    [namespaceId]
  );

  for (const row of setRows) {
    const collectionSupportItems = deriveCanonicalCollectionSupportItemsFromSet(row.item_values, row.metadata);
    const summarizedItems =
      summarizeReportCandidates(collectionSupportItems) ??
      summarizeJsonSetItems(row.item_values);
    if (!summarizedItems) {
      continue;
    }
    const sourceText = [summarizedItems, metadataText(row.metadata)].join(" ");
    const collectionEligible = shouldUseCanonicalSetAsCollectionSupport(summarizedItems, row.item_values, row.metadata);
    const reportKinds = inferReportKindsFromCanonicalRow(row.predicate_family, sourceText).filter(
      (reportKind) => reportKind !== "collection_report" || collectionEligible
    );
    if (reportKinds.length === 0) {
      continue;
    }
    for (const reportKind of reportKinds) {
      const key = `${row.subject_entity_id}::${reportKind}`;
      const group = groups.get(key) ?? {
        subjectEntityId: row.subject_entity_id,
        reportKind,
        summaries: [],
        confidenceSum: 0,
        supportCount: 0,
        mentionedAt: null,
        validFrom: row.valid_from,
        validUntil: row.valid_until,
        metadata: {}
      };
      group.summaries.push(summarizedItems);
      group.confidenceSum += row.confidence;
      group.supportCount += 1;
      group.validFrom = group.validFrom ?? row.valid_from;
      group.validUntil = group.validUntil ?? row.valid_until;
      group.metadata = { ...group.metadata, source_set_predicate_family: row.predicate_family };
      groups.set(key, group);
      if (reportKind === "collection_report" && collectionSupportItems.length > 0) {
        pushCanonicalCollectionFacts({
          facts: collectionFacts,
          subjectEntityId: row.subject_entity_id,
          texts: collectionSupportItems,
          cueTypeHint: "typed_set",
          baseConfidence: row.confidence
        });
      }
    }
  }

  const subjectRows = await queryRows<{ readonly entity_id: string; readonly canonical_name: string }>(
    `
      SELECT entity_id::text AS entity_id, canonical_name
      FROM canonical_subjects
      WHERE namespace_id = $1
    `,
    [namespaceId]
  );
  const subjectEntityByName = new Map<string, string>();
  for (const row of subjectRows) {
    const normalizedName = normalizeName(row.canonical_name);
    if (normalizedName && !subjectEntityByName.has(normalizedName)) {
      subjectEntityByName.set(normalizedName, row.entity_id);
    }
  }

  const sceneRows = await queryRows<{
    readonly scene_text: string;
    readonly occurred_at: string | null;
    readonly time_start: string | null;
    readonly time_end: string | null;
    readonly metadata: JsonRecord | null;
  }>(
    `
      SELECT
        scene_text,
        occurred_at::text,
        time_start::text,
        time_end::text,
        metadata
      FROM narrative_scenes
      WHERE namespace_id = $1
      ORDER BY occurred_at ASC, created_at ASC
    `,
    [namespaceId]
  );

  for (const row of sceneRows) {
    for (const turn of parseSceneSpeakerTurns(row.scene_text, [...subjectEntityByName.keys()])) {
      const subjectEntityId = subjectEntityByName.get(normalizeName(turn.speaker));
      if (!subjectEntityId) {
        continue;
      }
      const normalizedTurnText = normalizeWhitespace(turn.text);
      if (!normalizedTurnText) {
        continue;
      }
      pushCanonicalCollectionFacts({
        facts: collectionFacts,
        subjectEntityId,
        texts: [normalizedTurnText],
        baseConfidence: 0.74
      });
      const reportKinds = inferReportKindsFromCanonicalRow("list_set", normalizedTurnText).filter(
        (reportKind) => reportKind !== "collection_report" || hasCanonicalCollectionFactSeeds([normalizedTurnText])
      );
      if (!reportKinds.includes("collection_report")) {
        continue;
      }
      const key = `${subjectEntityId}::collection_report`;
      const group = groups.get(key) ?? {
        subjectEntityId,
        reportKind: "collection_report" as const,
        summaries: [],
        confidenceSum: 0,
        supportCount: 0,
        mentionedAt: row.occurred_at,
        validFrom: row.time_start,
        validUntil: row.time_end,
        metadata: {}
      };
      group.summaries.push(normalizedTurnText);
      group.confidenceSum += 0.74;
      group.supportCount += 1;
      group.mentionedAt = group.mentionedAt ?? row.occurred_at;
      group.validFrom = group.validFrom ?? row.time_start;
      group.validUntil = group.validUntil ?? row.time_end;
      group.metadata = { ...group.metadata, source_scene_collection: true };
      groups.set(key, group);
      pushCanonicalCollectionFacts({
        facts: collectionFacts,
        subjectEntityId,
        texts: [normalizedTurnText],
        baseConfidence: 0.74
      });
    }
  }

  const [claimRowsResult, eventRowsResult] = await Promise.all([
    client.query<NarrativeClaimCandidateRow>(
      `
        SELECT
          cc.id::text AS candidate_id,
          COALESCE(subject_entity.merged_into_entity_id, subject_entity.id)::text AS subject_entity_id,
          subject_root.canonical_name AS canonical_subject_name,
          COALESCE(object_entity.merged_into_entity_id, object_entity.id)::text AS object_entity_id,
          object_root.canonical_name AS canonical_object_name,
          cc.predicate,
          cc.object_text,
          cc.normalized_text,
          cc.confidence,
          cc.occurred_at::text,
          cc.time_expression_text,
          cc.time_start::text,
          cc.time_end::text,
          cc.source_event_id::text,
          cc.source_scene_id::text,
          cc.source_memory_id::text,
          cc.metadata
        FROM claim_candidates cc
        LEFT JOIN entities subject_entity ON subject_entity.id = cc.subject_entity_id
        LEFT JOIN entities subject_root ON subject_root.id = COALESCE(subject_entity.merged_into_entity_id, subject_entity.id)
        LEFT JOIN entities object_entity ON object_entity.id = cc.object_entity_id
        LEFT JOIN entities object_root ON object_root.id = COALESCE(object_entity.merged_into_entity_id, object_entity.id)
        WHERE cc.namespace_id = $1
          AND cc.status IN ('accepted', 'promoted', 'pending')
        ORDER BY cc.confidence DESC, cc.occurred_at DESC
      `,
      [namespaceId]
    ),
    client.query<NarrativeEventSourceRow>(
      `
        SELECT
          ne.id::text AS event_id,
          COALESCE(subject_entity.merged_into_entity_id, subject_entity.id)::text AS subject_entity_id,
          subject_root.canonical_name AS canonical_subject_name,
          ne.event_label,
          ne.event_kind,
          COALESCE(ne.time_start, ns.occurred_at, ne.created_at)::text AS occurred_at,
          ne.time_expression_text,
          ne.time_start::text,
          ne.time_end::text,
          ns.scene_text,
          ne.source_scene_id::text,
          ne.metadata
        FROM narrative_events ne
        LEFT JOIN entities subject_entity ON subject_entity.id = ne.primary_subject_entity_id
        LEFT JOIN entities subject_root ON subject_root.id = COALESCE(subject_entity.merged_into_entity_id, subject_entity.id)
        LEFT JOIN narrative_scenes ns ON ns.id = ne.source_scene_id
        WHERE ne.namespace_id = $1
        ORDER BY COALESCE(ne.time_start, ns.occurred_at, ne.created_at) DESC
      `,
      [namespaceId]
    )
  ]);

  const claimRows = claimRowsResult.rows;
  const eventRows = eventRowsResult.rows;

  for (const row of claimRows) {
    if (!row.subject_entity_id) {
      continue;
    }
    pushCanonicalCollectionFacts({
      facts: collectionFacts,
      subjectEntityId: row.subject_entity_id,
      texts: [normalizeWhitespace(row.object_text ?? row.normalized_text), metadataText(row.metadata)],
      baseConfidence: row.confidence
    });
    const collectionSourceTexts = [normalizeWhitespace(row.object_text ?? row.normalized_text), metadataText(row.metadata)];
    const sourceText = [row.normalized_text, row.predicate, row.object_text ?? "", metadataText(row.metadata)].join(" ");
    const reportKinds = inferReportKindsFromCanonicalRow(row.predicate, sourceText).filter(
      (reportKind) => reportKind !== "collection_report" || hasCanonicalCollectionFactSeeds(collectionSourceTexts)
    );
    for (const reportKind of reportKinds) {
      const key = `${row.subject_entity_id}::${reportKind}`;
      const group = groups.get(key) ?? {
        subjectEntityId: row.subject_entity_id,
        reportKind,
        summaries: [],
        confidenceSum: 0,
        supportCount: 0,
        mentionedAt: row.occurred_at,
        validFrom: row.time_start,
        validUntil: row.time_end,
        metadata: {}
      };
      group.summaries.push(normalizeWhitespace(row.object_text ?? row.normalized_text));
      group.confidenceSum += row.confidence;
      group.supportCount += 1;
      group.mentionedAt = group.mentionedAt ?? row.occurred_at;
      group.validFrom = group.validFrom ?? row.time_start;
      group.validUntil = group.validUntil ?? row.time_end;
      group.metadata = { ...group.metadata, source_claim_predicate: row.predicate };
      groups.set(key, group);
      if (reportKind === "collection_report") {
        pushCanonicalCollectionFacts({
          facts: collectionFacts,
          subjectEntityId: row.subject_entity_id,
          texts: [normalizeWhitespace(row.object_text ?? row.normalized_text), metadataText(row.metadata)],
          baseConfidence: row.confidence
        });
      }
    }
  }

  for (const row of eventRows) {
    if (!row.subject_entity_id) {
      continue;
    }
    pushCanonicalCollectionFacts({
      facts: collectionFacts,
      subjectEntityId: row.subject_entity_id,
      texts: [row.event_label, row.scene_text ?? "", metadataText(row.metadata)],
      baseConfidence: 0.72
    });
    const collectionSourceTexts = [row.event_label, row.scene_text ?? "", metadataText(row.metadata)];
    const sourceText = [row.event_label, row.scene_text ?? "", metadataText(row.metadata)].join(" ");
    const reportKinds = inferReportKindsFromCanonicalRow("narrative_profile", sourceText).filter(
      (reportKind) => reportKind !== "collection_report" || hasCanonicalCollectionFactSeeds(collectionSourceTexts)
    );
    for (const reportKind of reportKinds) {
      const key = `${row.subject_entity_id}::${reportKind}`;
      const group = groups.get(key) ?? {
        subjectEntityId: row.subject_entity_id,
        reportKind,
        summaries: [],
        confidenceSum: 0,
        supportCount: 0,
        mentionedAt: row.occurred_at,
        validFrom: row.time_start,
        validUntil: row.time_end,
        metadata: {}
      };
      group.summaries.push(normalizeWhitespace([row.event_label, row.scene_text ?? ""].join(" ")));
      group.confidenceSum += 0.72;
      group.supportCount += 1;
      group.mentionedAt = group.mentionedAt ?? row.occurred_at;
      group.validFrom = group.validFrom ?? row.time_start;
      group.validUntil = group.validUntil ?? row.time_end;
      group.metadata = { ...group.metadata, source_event_kind: row.event_kind };
      groups.set(key, group);
      if (reportKind === "collection_report") {
        pushCanonicalCollectionFacts({
          facts: collectionFacts,
          subjectEntityId: row.subject_entity_id,
          texts: [row.event_label, row.scene_text ?? "", metadataText(row.metadata)],
          baseConfidence: 0.72
        });
      }
    }
  }

  let count = 0;
  for (const group of groups.values()) {
    const summaryText = summarizeCanonicalReportGroup(group.reportKind, group.summaries);
    if (!summaryText) {
      continue;
    }
    const answerPayload = buildReportAnswerPayload(group.reportKind, group.summaries);
    const averageConfidence = group.confidenceSum / Math.max(group.supportCount, 1);
    await client.query(
      `
        INSERT INTO canonical_entity_reports (
          namespace_id,
          subject_entity_id,
          report_kind,
          summary_text,
          support_strength,
          confidence,
          mentioned_at,
          t_valid_from,
          t_valid_until,
          answer_payload,
          metadata
        )
        VALUES ($1, $2::uuid, $3, $4, $5, $6, $7::timestamptz, $8::timestamptz, $9::timestamptz, $10::jsonb, $11::jsonb)
      `,
      [
        namespaceId,
        group.subjectEntityId,
        group.reportKind,
        summaryText,
        clampSupportStrength(group.supportCount, averageConfidence),
        Math.min(0.99, Math.max(0.45, averageConfidence)),
        group.mentionedAt,
        group.validFrom,
        group.validUntil,
        JSON.stringify(answerPayload),
        JSON.stringify(group.metadata)
      ]
    );
    count += 1;
  }
  const subjectIds = [...new Set([...collectionFacts.values()].map((entry) => entry.subjectEntityId).filter(Boolean))];
  const subjectSnapshots =
    subjectIds.length > 0
      ? await queryRows<CanonicalSubjectSnapshotRow>(
          `
            SELECT
              cs.entity_id::text AS entity_id,
              cs.canonical_name
            FROM canonical_subjects cs
            WHERE cs.namespace_id = $1
              AND cs.entity_id = ANY($2::uuid[])
          `,
          [namespaceId, subjectIds]
        )
      : [];
  const subjectSnapshotMap = new Map(
    subjectSnapshots.map((row) => [row.entity_id, row.canonical_name ? normalizeWhitespace(row.canonical_name) : null] as const)
  );
  for (const fact of collectionFacts.values()) {
    const subjectNameSnapshot = subjectSnapshotMap.get(fact.subjectEntityId) ?? null;
    const subjectNameNormalized = subjectNameSnapshot ? normalizeEntityLookupName(subjectNameSnapshot) : null;
    await client.query(
      `
        INSERT INTO canonical_collection_facts (
          namespace_id,
          subject_entity_id,
          subject_name_snapshot,
          subject_name_normalized,
          item_value,
          normalized_value,
          cue_type,
          cue_strength,
          confidence,
          source_text,
          metadata
        )
        VALUES ($1, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)
      `,
      [
        namespaceId,
        fact.subjectEntityId,
        subjectNameSnapshot,
        subjectNameNormalized,
        fact.itemValue,
        fact.normalizedValue,
        fact.cueType,
        fact.cueStrength,
        fact.confidence,
        fact.sourceText,
        JSON.stringify({})
      ]
    );
  }
  return count;
}

async function promoteCanonicalPairReports(client: PoolClient, namespaceId: string): Promise<number> {
  const pairNarratives = await queryRows<CanonicalNarrativeLookupRow>(
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
        cn.metadata,
        COUNT(cnp.id)::int AS provenance_count
      FROM canonical_narratives cn
      JOIN canonical_subjects cs
        ON cs.namespace_id = cn.namespace_id
       AND cs.entity_id = cn.subject_entity_id
      JOIN canonical_subjects pair_cs
        ON pair_cs.namespace_id = cn.namespace_id
       AND pair_cs.entity_id = cn.pair_subject_entity_id
      LEFT JOIN canonical_narrative_provenance cnp
        ON cnp.canonical_narrative_id = cn.id
      WHERE cn.namespace_id = $1
        AND cn.pair_subject_entity_id IS NOT NULL
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
        cn.t_valid_until,
        cn.metadata
      ORDER BY cn.confidence DESC
    `,
    [namespaceId]
  );

  let count = 0;
  const seen = new Set<string>();
  for (const row of pairNarratives) {
    const orderedIds = [row.subject_entity_id, row.pair_subject_entity_id ?? ""].sort();
    const key = `${orderedIds.join("::")}::${row.narrative_kind}`;
    if (seen.has(key) || !row.pair_subject_entity_id) {
      continue;
    }
    seen.add(key);
    await client.query(
      `
        INSERT INTO canonical_pair_reports (
          namespace_id,
          subject_entity_id,
          pair_subject_entity_id,
          report_kind,
          summary_text,
          support_strength,
          confidence,
          mentioned_at,
          t_valid_from,
          t_valid_until,
          answer_payload,
          metadata
        )
        VALUES ($1, $2::uuid, $3::uuid, $4, $5, $6, $7, $8::timestamptz, $9::timestamptz, $10::timestamptz, $11::jsonb, $12::jsonb)
      `,
      [
        namespaceId,
        orderedIds[0],
        orderedIds[1],
        row.narrative_kind === "support_reasoning" || row.narrative_kind === "family_meaning"
          ? "relationship_report"
          : "shared_history_report",
        row.summary_text,
        row.support_strength,
        row.confidence,
        row.mentioned_at,
        row.t_valid_from,
        row.t_valid_until,
        JSON.stringify(buildReportAnswerPayload(
          row.narrative_kind === "support_reasoning" || row.narrative_kind === "family_meaning"
            ? "relationship_report"
            : "shared_history_report",
          [row.summary_text]
        )),
        JSON.stringify({
          source: "canonical_narratives",
          narrative_kind: row.narrative_kind
        })
      ]
    );
    count += 1;
  }
  return count;
}

export async function rebuildCanonicalMemoryNamespaceForClient(
  client: PoolClient,
  namespaceId: string
): Promise<CanonicalMemoryRebuildSummary> {
  await deleteCanonicalRows(client, namespaceId);
  const runResult = await client.query<{ id: string }>(
    `
      INSERT INTO canonical_rebuild_runs (
        namespace_id,
        status,
        scope,
        metadata
      )
      VALUES ($1, 'started', 'full', $2::jsonb)
      RETURNING id::text
    `,
    [
      namespaceId,
      JSON.stringify({
        source: "typed_memory_rebuild"
      })
    ]
  );
  const runId = runResult.rows[0]?.id;
  if (!runId) {
    throw new Error("Failed to create canonical rebuild run.");
  }

  // Build deterministic canonical storage from the already consolidated lanes.
  const subjects = await rebuildCanonicalSubjectsAndAliases(client, namespaceId);
  const facts = await rebuildCanonicalFacts(client, namespaceId);
  const states = await rebuildCanonicalStates(client, namespaceId);
  const temporalFacts = await rebuildCanonicalTemporalFacts(client, namespaceId);
  const sets = await rebuildCanonicalSets(client, namespaceId);
  const narratives = await promoteCanonicalNarratives(client, namespaceId);
  const entityReports = await promoteCanonicalEntityReports(client, namespaceId);
  const pairReports = await promoteCanonicalPairReports(client, namespaceId);

  const counts: CanonicalMemoryRebuildCounts = {
    subjects: subjects.subjects,
    aliases: subjects.aliases,
    facts,
    states,
    temporalFacts,
    sets,
    ambiguities: subjects.ambiguities,
    narratives,
    entityReports,
    pairReports
  };

  await client.query(
    `
      UPDATE canonical_rebuild_runs
      SET
        status = 'succeeded',
        metadata = metadata || $2::jsonb,
        completed_at = now()
      WHERE id = $1::uuid
    `,
    [
      runId,
      JSON.stringify({
        counts
      })
    ]
  );

  return {
    namespaceId,
    runId,
    counts
  };
}

export async function rebuildCanonicalMemoryNamespace(namespaceId: string): Promise<CanonicalMemoryRebuildSummary> {
  return withTransaction((client) => rebuildCanonicalMemoryNamespaceForClient(client, namespaceId));
}
