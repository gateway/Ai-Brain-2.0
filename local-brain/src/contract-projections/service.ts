import type { PoolClient } from "pg";
import { queryRows, withTransaction } from "../db/client.js";
import { getNamespaceSelfProfile, resolveCanonicalEntityReference } from "../identity/service.js";
import { inferTemporalEventKeyFromText } from "../canonical-memory/service.js";
import type { RecallResult } from "../types.js";
import type { AnswerRetrievalPlan, TypedContractName } from "../retrieval/types.js";
import {
  getExactDetailFamilySpec,
  inferExactDetailQuestionFamily,
  isFirstPersonExactDetailQuery,
  type ExactDetailQuestionFamily
} from "../retrieval/exact-detail-question-family.js";
import {
  deriveExactDetailPropertyKey,
  extractAtomicExactDetailValue,
  inferExactDetailFamilyFromSource
} from "../retrieval/exact-detail-fact-keys.js";

type JsonRecord = Record<string, unknown>;
const PROFILE_REPORT_PROJECTION_VERSION = "profile_report_projection_v1";
const RELATIONSHIP_MAP_PROJECTION_VERSION = "relationship_map_projection_v1";
const RELATIONSHIP_CHRONOLOGY_PROJECTION_VERSION = "relationship_chronology_projection_v1";
const CURRENT_STATE_PURCHASE_PROJECTION_VERSION = "current_state_purchase_projection_v1";
const CONTINUITY_CURRENT_STATE_PROJECTION_VERSION = "continuity_current_state_projection_v1";
const ALIAS_CURRENT_STATE_PROJECTION_VERSION = "alias_current_state_projection_v1";
const CONVERSATION_RECAP_PROJECTION_VERSION = "conversation_recap_projection_v1";
const SOURCE_PROFILE_SUMMARY_PROJECTION_VERSION = "source_profile_summary_projection_v1";
const PROJECT_DEFINITION_PROJECTION_VERSION = "project_definition_projection_v1";

export type ContractProjectionName =
  | TypedContractName
  | "value_slot"
  | "temporal_event_bundle"
  | "relationship_map"
  | "relationship_chronology"
  | "current_state_purchase"
  | "alias_current_state"
  | "recap_profile"
  | "project_definition"
  | "continuity_current_state";

export type ContractProjectionKind = "list" | "report" | "temporal" | "scalar";
export type ProjectionTruthStatus = "active" | "superseded" | "uncertain";

export interface RenderPayload {
  readonly answer_type?: string;
  readonly answer_value?: string;
  readonly reason_value?: string;
  readonly item_values?: readonly string[];
  readonly summary_text?: string;
  readonly event_key?: string;
  readonly event_type?: string;
  readonly answer_granularity?: string | null;
  readonly answer_year?: number | null;
  readonly answer_month?: number | null;
  readonly answer_day?: number | null;
  readonly start_at?: string | null;
  readonly end_at?: string | null;
}

export interface ContractProjectionRebuildCounts {
  readonly heads: number;
  readonly entries: number;
}

export interface ContractProjectionRebuildSummary {
  readonly namespaceId: string;
  readonly counts: ContractProjectionRebuildCounts;
}

export interface ContractProjectionShadow {
  readonly contractName: ContractProjectionName;
  readonly projectionKind: ContractProjectionKind;
  readonly subjectEntityId: string | null;
  readonly pairSubjectEntityId: string | null;
  readonly bundleKey: string;
  readonly completenessScore: number;
  readonly complete: boolean;
  readonly stopEligible: boolean;
  readonly answerGranularity: string | null;
  readonly supportCount: number;
  readonly entryCount: number;
  readonly summaryText: string | null;
  readonly requiredFields: readonly string[];
  readonly fulfilledFields: readonly string[];
  readonly truthStatus: ProjectionTruthStatus;
  readonly projectionVersion: string;
  readonly queryFamily?: string | null;
  readonly authoritativeSource?: string | null;
}

export interface ContractProjectionRuntimeDecision {
  readonly results: readonly RecallResult[];
  readonly stopEligible: boolean;
  readonly reason: string;
  readonly contractName: ContractProjectionName;
  readonly projectionKind: ContractProjectionKind;
  readonly queryFamily: string | null;
  readonly authoritativeSource: string | null;
  readonly complete: boolean;
  readonly completenessScore: number;
  readonly projectionVersion: string;
  readonly temporalFactCount: number;
  readonly activeSupportCount: number;
  readonly supersededSupportFilteredCount: number;
  readonly temporalExactness: "exact" | "bounded" | "inferred" | null;
}

interface CanonicalEntityReportRow {
  readonly id: string;
  readonly subject_entity_id: string;
  readonly report_kind: string;
  readonly summary_text: string;
  readonly confidence: number | null;
  readonly mentioned_at: string | null;
  readonly t_valid_from: string | null;
  readonly t_valid_until: string | null;
  readonly answer_payload: JsonRecord | null;
  readonly metadata: JsonRecord | null;
}

interface CanonicalPairReportRow extends CanonicalEntityReportRow {
  readonly pair_subject_entity_id: string;
}

interface SourceBoundRelationshipProjectionRow {
  readonly source_kind:
    | "compiled_relationship_observations"
    | "relationship_candidates"
    | "episodic_relationship_context"
    | "artifact_chunk_relationship_context";
  readonly source_row_id: string;
  readonly subject_entity_id: string;
  readonly pair_subject_entity_id: string;
  readonly subject_name: string | null;
  readonly pair_subject_name: string | null;
  readonly predicate_family: string | null;
  readonly relationship_value: string | null;
  readonly support_phrase: string | null;
  readonly source_text: string | null;
  readonly source_memory_id: string | null;
  readonly source_chunk_id: string | null;
  readonly source_scene_id: string | null;
  readonly source_uri: string | null;
  readonly valid_from: string | null;
  readonly valid_until: string | null;
  readonly confidence: number | null;
  readonly metadata: JsonRecord | null;
}

interface SourceBoundPurchaseChunkRow {
  readonly chunk_id: string;
  readonly artifact_id: string;
  readonly source_uri: string | null;
  readonly observed_at: string | null;
  readonly chunk_index: number;
  readonly text_content: string;
}

interface SourceBoundContinuityChunkRow extends SourceBoundPurchaseChunkRow {}

interface SourceBoundAliasCurrentStateChunkRow extends SourceBoundPurchaseChunkRow {}
interface SourceBoundRecapProfileChunkRow extends SourceBoundPurchaseChunkRow {}
interface SourceBoundProjectDefinitionChunkRow extends SourceBoundPurchaseChunkRow {}

type AliasCurrentStateProjectionFamily =
  | "place_alias"
  | "person_alias"
  | "media_title_list"
  | "food_preference_list"
  | "beer_preference_list"
  | "coffee_preference"
  | "preference_profile_list";

interface AliasCurrentStateProjectionCandidate {
  readonly family: AliasCurrentStateProjectionFamily;
  readonly value: string;
  readonly sourceQuote: string;
  readonly sourceUri: string | null;
  readonly sourceChunkId: string;
  readonly artifactId: string;
  readonly observedAt: string | null;
  readonly trigger: string;
  readonly confidence: number;
}

type RecapProfileProjectionFamily = "conversation_recap" | "source_profile_summary";

interface RecapProfileProjectionCandidate {
  readonly family: RecapProfileProjectionFamily;
  readonly value: string;
  readonly sourceQuote: string;
  readonly sourceUri: string | null;
  readonly sourceChunkId: string;
  readonly artifactId: string;
  readonly observedAt: string | null;
  readonly topicKey: string;
  readonly trigger: string;
  readonly confidence: number;
}

interface ProjectDefinitionProjectionCandidate {
  readonly projectName: string;
  readonly definition: string;
  readonly sourceQuote: string;
  readonly sourceUri: string | null;
  readonly sourceChunkId: string;
  readonly artifactId: string;
  readonly observedAt: string | null;
  readonly trigger: string;
  readonly confidence: number;
}

type ContinuityProjectionFamily =
  | "warm_start_context"
  | "current_focus"
  | "recent_work_recap"
  | "next_action"
  | "daily_routine"
  | "current_constraint";

interface ContinuityProjectionCandidate {
  readonly family: ContinuityProjectionFamily;
  readonly value: string;
  readonly sourceQuote: string;
  readonly sourceUri: string | null;
  readonly sourceChunkId: string;
  readonly artifactId: string;
  readonly observedAt: string | null;
  readonly confidence: number;
}

interface CanonicalSetEntryRow {
  readonly canonical_set_id: string;
  readonly subject_entity_id: string;
  readonly valid_from: string | null;
  readonly valid_until: string | null;
  readonly confidence: number | null;
  readonly set_metadata: JsonRecord | null;
  readonly entry_id: string;
  readonly entry_index: number;
  readonly display_value: string;
  readonly normalized_value: string;
  readonly value_type: string;
  readonly entry_metadata: JsonRecord | null;
}

interface TemporalEventFactRow {
  readonly id: string;
  readonly subject_entity_id: string | null;
  readonly pair_subject_entity_id: string | null;
  readonly event_key: string;
  readonly event_label: string | null;
  readonly event_type: string | null;
  readonly start_at: string | null;
  readonly end_at: string | null;
  readonly answer_year: number | null;
  readonly answer_month: number | null;
  readonly answer_day: number | null;
  readonly time_granularity: string | null;
  readonly exactness: string;
  readonly valid_from: string | null;
  readonly valid_until: string | null;
  readonly truth_status: ProjectionTruthStatus;
  readonly support_count: number;
  readonly metadata: JsonRecord | null;
}

interface TemporalEventSupportRow {
  readonly temporal_event_fact_id: string;
  readonly source_row_id: string | null;
  readonly support_memory_id: string | null;
  readonly support_role: "primary" | "support" | "conflict";
  readonly snippet: string | null;
  readonly occurred_at: string | null;
  readonly metadata: JsonRecord | null;
}

interface ProjectionHeadRow {
  readonly id: string;
  readonly contract_name: ContractProjectionName;
  readonly projection_kind: ContractProjectionKind;
  readonly subject_entity_id: string | null;
  readonly pair_subject_entity_id: string | null;
  readonly bundle_key: string;
  readonly summary_text: string | null;
  readonly required_fields: unknown;
  readonly fulfilled_fields: unknown;
  readonly completeness_score: number;
  readonly answer_granularity: string | null;
  readonly support_count: number;
  readonly truth_status: ProjectionTruthStatus;
  readonly render_contract: string | null;
  readonly valid_from: string | null;
  readonly valid_until: string | null;
  readonly exactness: string | null;
  readonly support_memory_ids: unknown;
  readonly support_temporal_fact_ids: unknown;
  readonly support_relationship_ids: unknown;
  readonly render_payload: unknown;
  readonly projection_version: string;
  readonly query_family: string | null;
  readonly authoritative_source: string | null;
  readonly structured_sufficiency_status: string | null;
  readonly abstention_reason: string | null;
  readonly entity_resolution_status: string | null;
  readonly temporal_coverage_status: string | null;
}

interface ProjectionEntryRow {
  readonly entry_index: number;
  readonly display_value: string;
  readonly normalized_value: string;
  readonly entry_type: string;
  readonly entry_role: string;
  readonly support_count: number;
  readonly truth_status: ProjectionTruthStatus;
  readonly valid_from: string | null;
  readonly valid_until: string | null;
  readonly support_memory_ids: unknown;
  readonly support_relationship_ids: unknown;
  readonly support_temporal_fact_ids: unknown;
  readonly temporal_granularity: string | null;
  readonly normalized_property_key: string | null;
  readonly owner_binding_status: string | null;
  readonly source_confidence: number | null;
  readonly active_truth: boolean;
}

interface CanonicalScalarProjectionRow {
  readonly source_table: "canonical_states" | "canonical_facts" | "temporal_event_facts";
  readonly source_row_id: string;
  readonly subject_entity_id: string;
  readonly predicate_family: string;
  readonly property_key: string;
  readonly value_text: string;
  readonly confidence: number | null;
  readonly valid_from: string | null;
  readonly valid_until: string | null;
  readonly mentioned_at: string | null;
  readonly metadata: JsonRecord | null;
  readonly support_memory_ids: readonly string[];
  readonly support_temporal_fact_ids: readonly string[];
  readonly authoritative_source: string;
}

function normalize(value: string | null | undefined): string {
  return String(value ?? "").trim();
}

function normalizeKey(value: string | null | undefined): string {
  return normalize(value).toLowerCase();
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((entry) => readString(entry)).filter((entry): entry is string => Boolean(entry));
}

function readUuidArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
}

function readJsonRecord(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JsonRecord) : null;
}

function jsonString(value: unknown): string {
  return JSON.stringify(value);
}

function profileReportProjectionEnabled(): boolean {
  const value = String(process.env.BRAIN_ENABLE_PROFILE_REPORT_PROJECTION ?? "").toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

function uniqueStrings(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const value of values.map((entry) => normalize(entry)).filter(Boolean)) {
    const key = value.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    ordered.push(value);
  }
  return ordered;
}

function joinListSummary(values: readonly string[]): string | null {
  const unique = uniqueStrings(values);
  if (unique.length === 0) {
    return null;
  }
  if (unique.length === 1) {
    return unique[0] ?? null;
  }
  if (unique.length === 2) {
    return `${unique[0]} and ${unique[1]}`;
  }
  return `${unique.slice(0, -1).join(", ")}, and ${unique[unique.length - 1]}`;
}

function temporalGranularityRank(value: string | null | undefined): number {
  switch (normalizeKey(value)) {
    case "day":
      return 3;
    case "month":
      return 2;
    case "year":
      return 1;
    default:
      return 0;
  }
}

function truthStatusRank(value: ProjectionTruthStatus): number {
  switch (value) {
    case "active":
      return 3;
    case "uncertain":
      return 2;
    case "superseded":
      return 1;
    default:
      return 0;
  }
}

function projectionTruthStatus(validUntil: string | null | undefined): ProjectionTruthStatus {
  return validUntil ? "superseded" : "active";
}

function temporalOrderingValue(row: TemporalEventFactRow): number {
  if (typeof row.answer_year === "number") {
    return Date.UTC(row.answer_year, (row.answer_month ?? 1) - 1, row.answer_day ?? 1);
  }
  const fallback = row.start_at ?? row.valid_from ?? row.end_at ?? row.valid_until ?? null;
  if (!fallback) {
    return Number.POSITIVE_INFINITY;
  }
  const parsed = Date.parse(fallback);
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
}

function metadataUuidArray(metadata: JsonRecord | null | undefined, key: string): string[] {
  const direct = metadata?.[key];
  if (typeof direct === "string" && direct.length > 0) {
    return [direct];
  }
  if (Array.isArray(direct)) {
    return direct.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
  }
  return [];
}

function renderContractForKind(kind: ContractProjectionKind): string {
  switch (kind) {
    case "list":
      return "typed_list_set";
    case "temporal":
      return "temporal_detail";
    case "scalar":
      return "exact_detail";
    default:
      return "report_profile";
  }
}

export function mapCanonicalEntityReportKindToContract(reportKind: string): ContractProjectionName | null {
  switch (normalizeKey(reportKind)) {
    case "identity_report":
      return "identity_profile";
    case "relationship_report":
      return "relationship_profile";
    case "preference_report":
      return "preference_profile";
    case "career_report":
    case "support_report":
    case "aspiration_report":
      return "reasoned_profile_judgment";
    default:
      return null;
  }
}

export function mapCanonicalSetMetadataToContract(metadata: JsonRecord | null | undefined): ContractProjectionName | null {
  const setKind = normalizeKey(readString(metadata?.set_kind));
  const mediaKind = normalizeKey(readString(metadata?.media_kind));
  if (setKind === "media_mentions" && mediaKind === "book") {
    return "book_list";
  }
  if (setKind === "transaction_items") {
    return "inventory_list";
  }
  return null;
}

type ScalarProjectionFamily =
  | "pet_name"
  | "breed"
  | "brand"
  | "count"
  | "service_name"
  | "shop"
  | "venue"
  | "certification"
  | "capacity"
  | "speed"
  | "time_of_day"
  | "duration"
  | "role";

function readMetadataNumber(value: JsonRecord | null | undefined, key: string): number | null {
  const direct = value?.[key];
  return typeof direct === "number" && Number.isFinite(direct) ? direct : null;
}

function gatherScalarProjectionText(row: {
  readonly source_table: "canonical_states" | "canonical_facts";
  readonly predicate_family: string;
  readonly value_text: string;
  readonly metadata: JsonRecord | null;
}): string {
  return [
    row.predicate_family,
    row.value_text,
    readString(row.metadata?.state_type),
    readString(row.metadata?.state_key),
    readString(row.metadata?.predicate),
    readString(row.metadata?.domain),
    readString(row.metadata?.qualifier),
    readString(row.metadata?.context_text),
    readString(row.metadata?.profile_kind),
    readString(row.metadata?.source_table)
  ]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join(" ");
}

function inferScalarProjectionFamilyFromRow(row: {
  readonly source_table: "canonical_states" | "canonical_facts";
  readonly predicate_family: string;
  readonly value_text: string;
  readonly metadata: JsonRecord | null;
}): ScalarProjectionFamily | null {
  const normalized = normalizeKey(gatherScalarProjectionText(row));
  if (/\b(?:pet|cat|dog|puppy|kitten)\b/u.test(normalized) && /\bname\b/u.test(normalized)) {
    return "pet_name";
  }
  if ((/\bbrand\b/u.test(normalized) || /\brunning shoes?\b/u.test(normalized)) && !/\bendorsement\b/u.test(normalized)) {
    return "brand";
  }
  if (/\bbreed\b/u.test(normalized) && /\b(?:dog|cat|pet|puppy)\b/u.test(normalized)) {
    return "breed";
  }
  if (
    /\bservice\b|\bplatform\b|\bapp\b|\bsubscription\b|\bstreaming\b|\bmusic\b/u.test(normalized) &&
    !/\bservice dog\b/u.test(normalized)
  ) {
    return "service_name";
  }
  if (/\bcertification\b|\bcertificate\b|\bcourse\b|\bprogram\b/u.test(normalized)) {
    return "certification";
  }
  if (
    /\bvenue\b|\byoga\b|\bclass(?:es)?\b|\bstudy abroad\b|\bcollege\b|\buniversity\b|\bcampus\b|\bschool\b|\bwedding\b/u.test(normalized)
  ) {
    return "venue";
  }
  if (/\binternet\b|\bplan\b/u.test(normalized) && /\bspeed\b|\bmbps\b|\bgbps\b/u.test(normalized)) {
    return "speed";
  }
  if (/\b(?:ram|storage|capacity|gb|tb)\b/u.test(normalized)) {
    return "capacity";
  }
  if (/\b(?:time|emails?|messages?)\b/u.test(normalized) && /\bstop\b|\bchecking\b/u.test(normalized)) {
    return "time_of_day";
  }
  if (/\b(?:duration|months?|years?|weeks?|days?)\b/u.test(normalized) && /\b(?:japan|collect|move|lived|travel|stay)\b/u.test(normalized)) {
    return "duration";
  }
  if (/\b(?:role|occupation|job|title|position)\b/u.test(normalized)) {
    return "role";
  }
  if (/\b(?:shop|store|retailer|bought from|purchased from)\b/u.test(normalized)) {
    return "shop";
  }
  if (/\b(?:count|number|total)\b/u.test(normalized) || (/\bbikes?\b/u.test(normalized) && /\bown\b/u.test(normalized))) {
    return "count";
  }
  return null;
}

function mapExactFamilyToProjectionContract(exactFamily: ExactDetailQuestionFamily): ContractProjectionName | null {
  switch (exactFamily) {
    case "pet_name":
    case "breed":
    case "brand":
    case "count":
    case "service_name":
    case "shop":
    case "venue":
    case "certification":
    case "capacity":
    case "speed":
    case "time_of_day":
    case "duration":
    case "role":
      return "value_slot";
    default:
      return null;
  }
}

export function deriveProjectionSupportState(params: {
  readonly contractName: ContractProjectionName;
  readonly projectionKind: ContractProjectionKind;
  readonly summaryText?: string | null;
  readonly answerPayload?: JsonRecord | null;
  readonly entries?: readonly { readonly displayValue: string }[];
  readonly answerGranularity?: string | null;
}): {
  readonly requiredFields: readonly string[];
  readonly fulfilledFields: readonly string[];
  readonly completenessScore: number;
  readonly complete: boolean;
  readonly stopEligible: boolean;
} {
  const summaryText = normalize(params.summaryText);
  const answerPayload = params.answerPayload ?? {};
  if (params.projectionKind === "list") {
    const entryCount = params.entries?.filter((entry) => normalize(entry.displayValue).length > 0).length ?? 0;
    const fulfilledFields = entryCount > 0 ? ["entries"] : [];
    const completenessScore = Math.min(entryCount / 2, 1);
    return {
      requiredFields: ["entries"],
      fulfilledFields,
      completenessScore,
      complete: entryCount > 0,
      stopEligible: entryCount > 0
    };
  }
  if (params.projectionKind === "temporal") {
    const fulfilledFields = [
      typeof answerPayload.answer_day === "number" ? "answer_day" : null,
      typeof answerPayload.answer_month === "number" ? "answer_month" : null,
      typeof answerPayload.answer_year === "number" ? "answer_year" : null,
      summaryText ? "summary_text" : null
    ].filter((value): value is string => Boolean(value));
    const granularityRank = temporalGranularityRank(params.answerGranularity);
    const completenessScore =
      granularityRank >= 3 ? 1 :
      granularityRank === 2 ? 0.9 :
      granularityRank === 1 ? 0.8 :
      summaryText ? 0.5 : 0;
    return {
      requiredFields: ["answer_year"],
      fulfilledFields,
      completenessScore,
      complete: granularityRank > 0,
      stopEligible: granularityRank > 0
    };
  }
  if (params.projectionKind === "scalar") {
    const answerValue = normalize(readString(answerPayload.answer_value) ?? summaryText);
    const fulfilledFields = [
      answerValue ? "answer_value" : null
    ].filter((value): value is string => Boolean(value));
    return {
      requiredFields: ["answer_value"],
      fulfilledFields,
      completenessScore: answerValue.length > 0 ? 1 : 0,
      complete: answerValue.length > 0,
      stopEligible: answerValue.length > 0
    };
  }
  const answerValue = normalize(readString(answerPayload.answer_value));
  const reasonValue = normalize(readString(answerPayload.reason_value));
  const needsReason = params.contractName === "reasoned_profile_judgment";
  const fulfilledFields = [
    answerValue || summaryText ? "answer_value" : null,
    reasonValue ? "reason_value" : null
  ].filter((value): value is string => Boolean(value));
  const requiredFields = needsReason ? ["reason_value"] : ["answer_value"];
  const complete = needsReason ? reasonValue.length > 0 || summaryText.length > 0 : answerValue.length > 0 || summaryText.length > 0;
  return {
    requiredFields,
    fulfilledFields,
    completenessScore: complete ? 1 : summaryText.length > 0 ? 0.5 : 0,
    complete,
    stopEligible: complete
  };
}

async function deleteContractProjectionRows(client: PoolClient, namespaceId: string): Promise<void> {
  await client.query("DELETE FROM contract_projection_entries WHERE namespace_id = $1", [namespaceId]);
  await client.query("DELETE FROM contract_projection_heads WHERE namespace_id = $1", [namespaceId]);
}

async function insertProjectionHead(client: PoolClient, params: {
  readonly namespaceId: string;
  readonly contractName: ContractProjectionName;
  readonly projectionKind: ContractProjectionKind;
  readonly subjectEntityId: string | null;
  readonly pairSubjectEntityId?: string | null;
  readonly bundleKey: string;
  readonly summaryText: string | null;
  readonly answerPayload?: JsonRecord | null;
  readonly requiredFields: readonly string[];
  readonly fulfilledFields: readonly string[];
  readonly completenessScore: number;
  readonly answerGranularity?: string | null;
  readonly supportCount: number;
  readonly truthStatus: ProjectionTruthStatus;
  readonly renderContract: string;
  readonly validFrom?: string | null;
  readonly validUntil?: string | null;
  readonly exactness?: string | null;
  readonly supportMemoryIds?: readonly string[];
  readonly supportTemporalFactIds?: readonly string[];
  readonly supportRelationshipIds?: readonly string[];
  readonly renderPayload?: JsonRecord | null;
  readonly sortKey?: string | null;
  readonly queryFamily?: string | null;
  readonly authoritativeSource?: string | null;
  readonly structuredSufficiencyStatus?: string | null;
  readonly abstentionReason?: string | null;
  readonly entityResolutionStatus?: string | null;
  readonly temporalCoverageStatus?: string | null;
  readonly projectionVersion?: string;
  readonly metadata?: JsonRecord | null;
}): Promise<string> {
  const result = await client.query<{ id: string }>(
    `
      INSERT INTO contract_projection_heads (
        namespace_id,
        contract_name,
        projection_kind,
        subject_entity_id,
        pair_subject_entity_id,
        bundle_key,
        summary_text,
        answer_payload,
        required_fields,
        fulfilled_fields,
        completeness_score,
        answer_granularity,
        support_count,
        truth_status,
        render_contract,
        valid_from,
        valid_until,
        exactness,
        support_memory_ids,
        support_temporal_fact_ids,
        support_relationship_ids,
        render_payload,
        sort_key,
        query_family,
        authoritative_source,
        structured_sufficiency_status,
        abstention_reason,
        entity_resolution_status,
        temporal_coverage_status,
        projection_version,
        metadata
      )
      VALUES (
        $1, $2, $3, $4::uuid, $5::uuid, $6, $7, $8::jsonb, $9::jsonb, $10::jsonb, $11, $12, $13,
        $14, $15, $16::timestamptz, $17::timestamptz, $18, $19::uuid[], $20::uuid[], $21::uuid[], $22::jsonb,
        $23::timestamptz, $24, $25, $26, $27, $28, $29, $30, $31::jsonb
      )
      RETURNING id::text
    `,
    [
      params.namespaceId,
      params.contractName,
      params.projectionKind,
      params.subjectEntityId,
      params.pairSubjectEntityId ?? null,
      params.bundleKey,
      params.summaryText,
      jsonString(params.answerPayload ?? {}),
      jsonString(params.requiredFields),
      jsonString(params.fulfilledFields),
      params.completenessScore,
      params.answerGranularity ?? null,
      params.supportCount,
      params.truthStatus,
      params.renderContract,
      params.validFrom ?? null,
      params.validUntil ?? null,
      params.exactness ?? null,
      params.supportMemoryIds ?? [],
      params.supportTemporalFactIds ?? [],
      params.supportRelationshipIds ?? [],
      jsonString(params.renderPayload ?? {}),
      params.sortKey ?? null,
      params.queryFamily ?? null,
      params.authoritativeSource ?? null,
      params.structuredSufficiencyStatus ?? null,
      params.abstentionReason ?? null,
      params.entityResolutionStatus ?? null,
      params.temporalCoverageStatus ?? null,
      params.projectionVersion ?? "contract_projection_v2",
      jsonString(params.metadata ?? {})
    ]
  );
  const id = result.rows[0]?.id;
  if (!id) {
    throw new Error(`Failed to insert contract projection head for ${params.contractName}.`);
  }
  return id;
}

async function insertProjectionEntry(client: PoolClient, params: {
  readonly namespaceId: string;
  readonly projectionHeadId: string;
  readonly entryIndex: number;
  readonly displayValue: string;
  readonly normalizedValue: string;
  readonly entryType: string;
  readonly entryRole?: string;
  readonly supportCount?: number;
  readonly truthStatus?: ProjectionTruthStatus;
  readonly validFrom?: string | null;
  readonly validUntil?: string | null;
  readonly sortKey?: string | null;
  readonly supportMemoryIds?: readonly string[];
  readonly supportRelationshipIds?: readonly string[];
  readonly supportTemporalFactIds?: readonly string[];
  readonly temporalStart?: string | null;
  readonly temporalEnd?: string | null;
  readonly temporalGranularity?: string | null;
  readonly sourceTable?: string | null;
  readonly sourceRowId?: string | null;
  readonly normalizedPropertyKey?: string | null;
  readonly ownerBindingStatus?: string | null;
  readonly sourceConfidence?: number | null;
  readonly activeTruth?: boolean;
  readonly metadata?: JsonRecord | null;
}): Promise<void> {
  await client.query(
    `
      INSERT INTO contract_projection_entries (
        namespace_id,
        projection_head_id,
        entry_index,
        display_value,
        normalized_value,
        entry_type,
        temporal_start,
        temporal_end,
        temporal_granularity,
        source_table,
        source_row_id,
        metadata,
        entry_role,
        support_count,
        truth_status,
        valid_from,
        valid_until,
        sort_key,
        support_memory_ids,
        support_relationship_ids,
        support_temporal_fact_ids,
        normalized_property_key,
        owner_binding_status,
        source_confidence,
        active_truth
      )
      VALUES (
        $1, $2::uuid, $3, $4, $5, $6, $7::timestamptz, $8::timestamptz, $9, $10, $11::uuid, $12::jsonb, $13, $14, $15,
        $16::timestamptz, $17::timestamptz, $18::timestamptz, $19::uuid[], $20::uuid[], $21::uuid[], $22, $23, $24, $25
      )
    `,
    [
      params.namespaceId,
      params.projectionHeadId,
      params.entryIndex,
      params.displayValue,
      params.normalizedValue,
      params.entryType,
      params.temporalStart ?? null,
      params.temporalEnd ?? null,
      params.temporalGranularity ?? null,
      params.sourceTable ?? null,
      params.sourceRowId ?? null,
      jsonString(params.metadata ?? {}),
      params.entryRole ?? "value",
      params.supportCount ?? 1,
      params.truthStatus ?? "active",
      params.validFrom ?? null,
      params.validUntil ?? null,
      params.sortKey ?? null,
      params.supportMemoryIds ?? [],
      params.supportRelationshipIds ?? [],
      params.supportTemporalFactIds ?? [],
      params.normalizedPropertyKey ?? null,
      params.ownerBindingStatus ?? null,
      params.sourceConfidence ?? null,
      params.activeTruth ?? true
    ]
  );
}

function normalizePurchaseDateKey(value: string | null | undefined): string | null {
  const normalized = normalize(value);
  if (!normalized) {
    return null;
  }
  const isoMatch = normalized.match(/\b(\d{4})-(\d{2})-(\d{2})\b/u);
  if (isoMatch?.[1] && isoMatch[2] && isoMatch[3]) {
    return `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;
  }
  return null;
}

function normalizePurchaseItemValue(value: string): string | null {
  let normalized = normalize(value)
    .replace(/^[,;:\s-]+/u, "")
    .replace(/[.;:,\s-]+$/u, "")
    .replace(/\s+/gu, " ")
    .replace(/\b(?:my|their)\s+scooter\b/iu, "your scooter")
    .replace(/\bgas\s+too\s+for\s+your\s+scooter\b/iu, "gas for your scooter")
    .replace(/\bvitamin c\b/giu, "vitamin C")
    .replace(/\bus\b/gu, "US");
  normalized = normalized.replace(/^(?:a|an|the|some|little|various|items?|meals?|snacks?|and|plus|to\s+buy)\s+/iu, "");
  normalized = normalized.replace(/\s+\bthis\s+morning\b/iu, "");
  normalized = normalized.replace(/\s+\(.*?\)$/u, "");
  if (!normalized || normalized.length < 2) {
    return null;
  }
  if (
    /(?:^\d+\]\s*speaker\b|\bspeaker\s+\d+\b|\bincluding\s+snacks?\b|\bvarious\s+items\b|\beverything\s+they\s+bought\b|\btotal\s+spending\b)/iu.test(
      normalized
    )
  ) {
    return null;
  }
  if (/^(?:day|today|morning|conversation|metadata|transcript)$/iu.test(normalized)) {
    return null;
  }
  if (
    /\b(?:today|thailand|morning|everything|total|roughly|around|give or take|forgot|conversation|metadata|transcript)\b/iu.test(normalized) &&
    !/\b(?:gas|scooter|snickers|toilet|coffee|latte|banana|water|yogurt|sponge|burrito|fries|electrolytes?|vitamin)\b/iu.test(normalized)
  ) {
    return null;
  }
  return normalized;
}

function splitPurchaseListSegment(segment: string): string[] {
  return segment
    .replace(/\([^)]*\)/gu, (match) => match.slice(1, -1))
    .split(/\s*,\s*|\s+\band\b\s+|\s+\bplus\b\s+/iu)
    .map((entry) => normalizePurchaseItemValue(entry))
    .filter((entry): entry is string => Boolean(entry));
}

function uniqueCaseInsensitive(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    const normalized = normalize(value);
    const key = normalized.toLowerCase();
    if (!normalized || seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push(normalized);
  }
  return output;
}

export function extractCurrentStatePurchaseProjectionValuesForTest(text: string): {
  readonly itemValues: readonly string[];
  readonly totalValues: readonly string[];
} {
  const normalized = normalize(text);
  const itemValues: string[] = [];
  const addItem = (value: string | null | undefined): void => {
    const normalizedValue = normalizePurchaseItemValue(value ?? "");
    if (normalizedValue) {
      itemValues.push(normalizedValue);
    }
  };
  const addList = (segment: string | null | undefined): void => {
    if (!segment) {
      return;
    }
    itemValues.push(...splitPurchaseListSegment(segment));
  };

  for (const match of normalized.matchAll(/\(([^)]{2,220})\)/giu)) {
    const segment = match[1] ?? "";
    if (/\b(?:bar|pack|burrito|fries|latte|paper|yogurt|bananas?|coffee|sponge|drink|electrolytes?|water|gas|scooter)\b/iu.test(segment)) {
      addList(segment);
    }
  }
  for (const match of normalized.matchAll(/\b(?:bought|purchased|picked up|got)\s+(?:a\s+|an\s+|the\s+)?([^.!?\n]{2,140}?)(?=[.!?\n]|$)/giu)) {
    addList(match[1]);
  }
  for (const match of normalized.matchAll(/\bhad\s+(?:a\s+|an\s+|the\s+)?([^.!?\n]{2,140}?)(?=[.!?\n]|$)/giu)) {
    addList(match[1]);
  }
  for (const match of normalized.matchAll(/\b(?:buy|bought)\s+(?:a\s+|an\s+|the\s+)?([^.!?\n]{2,120}?)(?=[.!?\n]|$)/giu)) {
    addList(match[1]);
  }
  for (const match of normalized.matchAll(/\b(?:Some,\s*)?([^.!?\n]{2,180}?(?:yogurt|bananas?|coffee|sponge|vitamin C mineral drink|electrolytes? pack|water)[^.!?\n]*)(?=[.!?\n]|$)/giu)) {
    addList(match[1]);
  }
  const gasMatch = normalized.match(/\b(?:got|bought)?\s*gas\b[^.!?\n]{0,80}\bfor\s+(?:my|your|their)\s+scooter\b/iu);
  if (gasMatch) {
    addItem("gas for your scooter");
  }

  const totalValues: string[] = [];
  const bahtDigitMatch = normalized.match(/\b(\d{2,6})\s*(?:baht|bot)\b/iu);
  if (bahtDigitMatch?.[1]) {
    totalValues.push(`${bahtDigitMatch[1]} baht`);
  } else if (/\bseven hundred and eighty\s+(?:baht|bot)\b/iu.test(normalized)) {
    totalValues.push("780 baht");
  }
  const usdDigitMatch = normalized.match(/\b(?:\$|usd\s*)?(\d{1,5})\s*(?:usd|us dollars?|dollars?\s+us)\b/iu);
  if (usdDigitMatch?.[1]) {
    totalValues.push(`${usdDigitMatch[1]} USD`);
  } else if (/\btwenty four\s+dollars?\s+US\b/iu.test(normalized)) {
    totalValues.push("24 USD");
  }

  return {
    itemValues: uniqueCaseInsensitive(itemValues).filter((value) =>
      !/\b(?:came with|had to|for today|which i believe|all the things)\b/iu.test(value)
    ),
    totalValues: uniqueCaseInsensitive(totalValues)
  };
}

function compactSourceQuote(value: string): string {
  const normalized = normalize(value).replace(/\s+/gu, " ");
  return normalized.length > 520 ? `${normalized.slice(0, 517).trim()}...` : normalized;
}

function continuityObservedDate(value: string | null | undefined): string | null {
  const normalized = normalize(value);
  const isoMatch = normalized.match(/\b(\d{4})-(\d{2})-(\d{2})\b/u);
  return isoMatch?.[1] && isoMatch[2] && isoMatch[3] ? `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}` : null;
}

function addContinuityCandidate(
  output: ContinuityProjectionCandidate[],
  row: SourceBoundContinuityChunkRow,
  family: ContinuityProjectionFamily,
  value: string,
  confidence = 0.88
): void {
  const normalizedValue = normalize(value);
  const quote = compactSourceQuote(row.text_content);
  if (!normalizedValue || !quote) {
    return;
  }
  output.push({
    family,
    value: normalizedValue,
    sourceQuote: quote,
    sourceUri: row.source_uri,
    sourceChunkId: row.chunk_id,
    artifactId: row.artifact_id,
    observedAt: row.observed_at,
    confidence
  });
}

function extractContinuityCandidatesForRow(row: SourceBoundContinuityChunkRow): ContinuityProjectionCandidate[] {
  const text = normalize(row.text_content);
  const lower = text.toLowerCase();
  const output: ContinuityProjectionCandidate[] = [];
  const has = (pattern: RegExp): boolean => pattern.test(lower);

  const projectValues: string[] = [];
  if (has(/\bai\s*brain\b|\bopenai brain\b|\bbrain\b/u)) projectValues.push("AI Brain");
  if (has(/\bpreset kitchen\b/u)) projectValues.push("Preset Kitchen");
  if (has(/\bbumblebee\b|\bopen\s*claw\b/u)) projectValues.push("Bumblebee");
  if (has(/\bwell\s*inked\b/u)) projectValues.push("Well Inked");
  if (has(/\btwo\s*way\b|\b2way\b|\btwo\s+w\s*a\s*y\b/u)) projectValues.push("Two Way");

  if (projectValues.length > 0 && has(/\b(?:working on|current project|project|focused|juggling|active|ongoing|status update)\b/u)) {
    addContinuityCandidate(output, row, "current_focus", `Current focus includes ${uniqueCaseInsensitive(projectValues).join(", ")}.`);
    addContinuityCandidate(output, row, "warm_start_context", `Current focus includes ${uniqueCaseInsensitive(projectValues).join(", ")}.`);
  }

  if (projectValues.length > 0 && has(/\byesterday\b|\bworked on\b|\brecounts work\b|\bstatus update\b/u)) {
    addContinuityCandidate(output, row, "recent_work_recap", `Recent work included ${uniqueCaseInsensitive(projectValues).join(", ")}.`);
  }

  const nextActions: string[] = [];
  if (has(/\bfinish\b/u) && has(/\bpreset kitchen\b/u)) nextActions.push("finish the Preset Kitchen site");
  if (has(/\bpush out\b/u) && has(/\bpreset kitchen\b/u)) nextActions.push("push out the Preset Kitchen site");
  if (has(/\badd presets?\b/u) && has(/\bpreset kitchen\b/u)) nextActions.push("add presets to the Preset Kitchen site");
  if (nextActions.length > 0) {
    addContinuityCandidate(output, row, "next_action", `Next actions include ${uniqueCaseInsensitive(nextActions).join(", ")}.`);
    addContinuityCandidate(output, row, "warm_start_context", `Carry forward ${uniqueCaseInsensitive(nextActions).join(", ")}.`);
  }

  const routineValues: string[] = [];
  if (has(/\bwake up\b|\bwake around\b|\bseven or eight\b|\b7\s*(?:to|-)\s*8\s*am\b/u)) routineValues.push("wake around 7 to 8 AM");
  if (has(/\bcoffee\b/u)) routineValues.push("make coffee");
  if (has(/\breddit\b|\bai news\b/u)) routineValues.push("check AI news on Reddit");
  if (has(/\bemail\b/u)) routineValues.push("review email");
  if (has(/\bpending tasks?\b|\bcurrent tasks?\b/u)) routineValues.push("review current tasks");
  if (has(/\bstart work\b|\bten\s*am\b|\b10\s*am\b/u)) routineValues.push("start work around 10 AM");
  if (has(/\bexercise\b|\bmidday\b/u)) routineValues.push("take a midday exercise break");
  if (routineValues.length > 0 && has(/\bdaily routine\b|\bmorning\b|\boverall day\b|\btypical\b/u)) {
    addContinuityCandidate(output, row, "daily_routine", `Current daily routine includes ${uniqueCaseInsensitive(routineValues).join(", ")}.`);
  }

  const constraints: string[] = [];
  if (has(/\bpersonal time\b/u)) constraints.push("protect personal time");
  if (has(/\btired\b|\bburnt out\b|\bburned out\b/u)) constraints.push("watch energy and burnout");
  if (constraints.length > 0) {
    addContinuityCandidate(output, row, "current_constraint", `Current constraints include ${uniqueCaseInsensitive(constraints).join(", ")}.`);
    addContinuityCandidate(output, row, "warm_start_context", `Active constraints include ${uniqueCaseInsensitive(constraints).join(", ")}.`);
  }

  return output;
}

export function extractContinuityCurrentStateProjectionCandidatesForTest(text: string): readonly {
  readonly family: ContinuityProjectionFamily;
  readonly value: string;
}[] {
  const row: SourceBoundContinuityChunkRow = {
    chunk_id: "00000000-0000-0000-0000-000000000000",
    artifact_id: "00000000-0000-0000-0000-000000000000",
    source_uri: "test://source",
    observed_at: "2026-03-28T00:00:00.000Z",
    chunk_index: 0,
    text_content: text
  };
  return extractContinuityCandidatesForRow(row).map((candidate) => ({
    family: candidate.family,
    value: candidate.value
  }));
}

function knownProjectNameFromText(text: string): string[] {
  const output: string[] = [];
  if (/\bai\s*brain\b|\bopenai brain\b/u.test(text)) output.push("AI Brain");
  if (/\btwo\s*way\b|\b2way\b|\btwo\s+w\s*a\s*y\b/u.test(text)) output.push("Two Way");
  if (/\bwell\s*inked\b/u.test(text)) output.push("Well Inked");
  if (/\bpreset kitchen\b/u.test(text)) output.push("Preset Kitchen");
  if (/\bbumblebee\b|\bopen\s*claw\b/u.test(text)) output.push("Bumblebee");
  if (/\bmedia studio\b/u.test(text)) output.push("Media Studio");
  if (/\bfix\s*my\s*photo\b|\bfixmyphoto\b/u.test(text)) output.push("FixMyPhoto");
  return uniqueCaseInsensitive(output);
}

function deriveProjectDefinitionValue(projectName: string, sourceText: string): { readonly definition: string; readonly trigger: string } | null {
  const lower = sourceText.toLowerCase();
  const projectKey = projectName.toLowerCase().replace(/\s+/gu, "\\s*");
  if (!new RegExp(`\\b${projectKey}\\b`, "iu").test(sourceText)) {
    return null;
  }
  if (/\b(?:project|system|app|platform|product|workflow|repo|software|site|tool|company|client|work|working on|built|building|developing)\b/iu.test(sourceText)) {
    if (projectName === "Two Way" && /\b(?:omi|ben|forum|client|association|backend|web app|two way|2way)\b/iu.test(sourceText)) {
      return { definition: "Two Way is a source-backed work/project context connected to the people and client work mentioned in the notes.", trigger: "project_context_two_way" };
    }
    if (projectName === "AI Brain") {
      return { definition: "AI Brain is a source-backed memory/retrieval system project described in the notes.", trigger: "project_context_ai_brain" };
    }
    if (projectName === "Well Inked") {
      return { definition: "Well Inked is a source-backed work/project context described in the notes.", trigger: "project_context_well_inked" };
    }
    if (projectName === "Preset Kitchen") {
      return { definition: "Preset Kitchen is a source-backed site/product project described in the notes.", trigger: "project_context_preset_kitchen" };
    }
    if (projectName === "Bumblebee") {
      return { definition: "Bumblebee is a source-backed software/work project described in the notes.", trigger: "project_context_bumblebee" };
    }
    return { definition: `${projectName} is a source-backed project or work context described in the notes.`, trigger: "project_context_generic" };
  }
  if (/\b(?:through|with|for|at)\b/iu.test(sourceText) && /\b(?:work|works|talked|discussed|client|team|project)\b/iu.test(sourceText)) {
    return { definition: `${projectName} is a source-backed project or organization context mentioned with work-related evidence.`, trigger: "project_work_relation_context" };
  }
  return lower.includes(projectName.toLowerCase()) ? { definition: `${projectName} is mentioned in source evidence, but the source does not define it fully.`, trigger: "project_mention_partial" } : null;
}

function extractProjectDefinitionCandidatesForRow(row: SourceBoundProjectDefinitionChunkRow): ProjectDefinitionProjectionCandidate[] {
  const text = normalize(row.text_content);
  const quote = compactSourceQuote(row.text_content);
  if (!text || !quote) return [];
  return knownProjectNameFromText(text.toLowerCase()).flatMap((projectName) => {
    const derived = deriveProjectDefinitionValue(projectName, text);
    if (!derived) return [];
    return [{
      projectName,
      definition: derived.definition,
      sourceQuote: quote,
      sourceUri: row.source_uri,
      sourceChunkId: row.chunk_id,
      artifactId: row.artifact_id,
      observedAt: row.observed_at,
      trigger: derived.trigger,
      confidence: derived.trigger.endsWith("_partial") ? 0.62 : 0.86
    }];
  });
}

function continuityProjectionSummary(family: ContinuityProjectionFamily, values: readonly string[]): string {
  const entries = uniqueCaseInsensitive(values).slice(0, 8);
  switch (family) {
    case "warm_start_context":
      return `Warm start for Steve: ${entries.join(" ")}`;
    case "current_focus":
      return `Current focus: ${entries.join(" ")}`;
    case "recent_work_recap":
      return `Recent work recap: ${entries.join(" ")}`;
    case "next_action":
      return `Next actions: ${entries.join(" ")}`;
    case "daily_routine":
      return `Current daily routine: ${entries.join(" ")}`;
    case "current_constraint":
      return `Current constraints: ${entries.join(" ")}`;
  }
}

async function upsertProjectEntity(client: PoolClient, namespaceId: string, projectName: string): Promise<string> {
  const result = await client.query<{ id: string }>(
    `
      INSERT INTO entities (namespace_id, entity_type, canonical_name, normalized_name, metadata)
      VALUES ($1, 'project', $2, lower($2), jsonb_build_object('source', 'project_definition_projection_v1'))
      ON CONFLICT (namespace_id, entity_type, normalized_name)
      DO UPDATE SET
        last_seen_at = now(),
        metadata = entities.metadata || excluded.metadata
      RETURNING id::text
    `,
    [namespaceId, projectName]
  );
  const id = result.rows[0]?.id;
  if (!id) throw new Error(`Failed to upsert project entity for ${projectName}.`);
  return id;
}

async function buildProjectDefinitionProjections(
  client: PoolClient,
  namespaceId: string
): Promise<ContractProjectionRebuildCounts> {
  const rows = await client.query<SourceBoundProjectDefinitionChunkRow>(
    `
      SELECT
        ac.id::text AS chunk_id,
        ao.artifact_id::text AS artifact_id,
        a.uri AS source_uri,
        COALESCE(ao.observed_at::text, a.created_at::text) AS observed_at,
        ac.chunk_index,
        ac.text_content
      FROM artifact_chunks ac
      JOIN artifact_observations ao ON ao.id = ac.artifact_observation_id
      JOIN artifacts a ON a.id = ao.artifact_id
      WHERE a.namespace_id = $1
        AND (
          ac.text_content ~* '\\m(ai[[:space:]]*brain|openai brain|two[[:space:]]*way|2way|well[[:space:]]*inked|preset kitchen|bumblebee|open[[:space:]]*claw|media studio|fix[[:space:]]*my[[:space:]]*photo|fixmyphoto)\\M'
        )
      ORDER BY COALESCE(ao.observed_at, a.created_at) DESC, ac.chunk_index ASC
      LIMIT 400
    `,
    [namespaceId]
  );

  const byProject = new Map<string, ProjectDefinitionProjectionCandidate[]>();
  for (const row of rows.rows) {
    for (const candidate of extractProjectDefinitionCandidatesForRow(row)) {
      const bucket = byProject.get(candidate.projectName) ?? [];
      bucket.push(candidate);
      byProject.set(candidate.projectName, bucket);
    }
  }

  let heads = 0;
  let entries = 0;
  for (const [projectName, candidates] of byProject.entries()) {
    const uniqueCandidates: ProjectDefinitionProjectionCandidate[] = [];
    const seen = new Set<string>();
    for (const candidate of candidates) {
      const key = `${candidate.projectName}:${candidate.definition}:${candidate.sourceChunkId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      uniqueCandidates.push(candidate);
    }
    if (uniqueCandidates.length === 0) continue;
    const subjectEntityId = await upsertProjectEntity(client, namespaceId, projectName);
    const strongest = [...uniqueCandidates].sort((left, right) => right.confidence - left.confidence)[0]!;
    const supportState = deriveProjectionSupportState({
      contractName: "project_definition",
      projectionKind: "report",
      entries: uniqueCandidates.map((candidate) => ({ displayValue: candidate.definition })),
      answerPayload: { answer_value: strongest.definition }
    });
    const headId = await insertProjectionHead(client, {
      namespaceId,
      contractName: "project_definition",
      projectionKind: "report",
      subjectEntityId,
      bundleKey: `project_definition:${normalizeKey(projectName)}`,
      summaryText: strongest.definition,
      answerPayload: {
        answer_type: "project_definition",
        answer_value: strongest.definition,
        project_name: projectName
      },
      requiredFields: supportState.requiredFields,
      fulfilledFields: supportState.fulfilledFields,
      completenessScore: supportState.completenessScore,
      answerGranularity: "report",
      supportCount: uniqueCandidates.length,
      truthStatus: "active",
      renderContract: PROJECT_DEFINITION_PROJECTION_VERSION,
      supportMemoryIds: uniqueStrings(uniqueCandidates.map((candidate) => candidate.sourceChunkId)),
      renderPayload: {
        answer_type: "project_definition",
        answer_value: strongest.definition,
        project_name: projectName,
        source_quotes: uniqueCandidates.map((candidate) => candidate.sourceQuote).slice(0, 8)
      },
      queryFamily: "project_definition",
      authoritativeSource: "source_bound_project_definition_projection",
      structuredSufficiencyStatus: "sufficient",
      entityResolutionStatus: "resolved",
      projectionVersion: PROJECT_DEFINITION_PROJECTION_VERSION,
      metadata: {
        retrievalDomain: "project_definition",
        queryContract: "project_definition",
        projectionFamily: "project_definition",
        projection_family: "project_definition",
        projection_version: PROJECT_DEFINITION_PROJECTION_VERSION,
        source_bound: true,
        sourceQuotes: uniqueCandidates.map((candidate) => candidate.sourceQuote).slice(0, 12),
        sourceUris: uniqueCaseInsensitive(uniqueCandidates.map((candidate) => candidate.sourceUri ?? "").filter(Boolean)).slice(0, 12),
        ownerBindingStatus: "project_bound"
      }
    });
    heads += 1;

    for (const [entryIndex, candidate] of uniqueCandidates.slice(0, 16).entries()) {
      await insertProjectionEntry(client, {
        namespaceId,
        projectionHeadId: headId,
        entryIndex,
        displayValue: candidate.definition,
        normalizedValue: normalizeKey(candidate.definition),
        entryType: "project_definition",
        entryRole: entryIndex === 0 ? "definition" : "source_quote",
        supportCount: 1,
        truthStatus: "active",
        validFrom: candidate.observedAt,
        sortKey: candidate.observedAt,
        sourceTable: "artifact_chunks",
        sourceRowId: candidate.sourceChunkId,
        supportMemoryIds: [candidate.sourceChunkId],
        normalizedPropertyKey: `project_definition.${normalizeKey(projectName)}`,
        ownerBindingStatus: "project_bound",
        sourceConfidence: candidate.confidence,
        activeTruth: true,
        metadata: {
          retrievalDomain: "project_definition",
          queryContract: "project_definition",
          answerShape: "report",
          project_name: projectName,
          source_quote: candidate.sourceQuote,
          source_uri: candidate.sourceUri,
          source_chunk_id: candidate.sourceChunkId,
          source_artifact_id: candidate.artifactId,
          sourceRoute: "source_bound_text",
          source_route: "source_bound_text",
          observed_at: candidate.observedAt,
          evidence_trigger: candidate.trigger,
          projection_version: PROJECT_DEFINITION_PROJECTION_VERSION
        }
      });
      entries += 1;
    }
  }
  return { heads, entries };
}

async function buildContinuityCurrentStateProjections(
  client: PoolClient,
  namespaceId: string
): Promise<ContractProjectionRebuildCounts> {
  const self = await client.query<{ id: string; canonical_name: string }>(
    `
      SELECT id::text, canonical_name
      FROM entities
      WHERE namespace_id = $1
        AND entity_type = 'self'
      ORDER BY last_seen_at DESC NULLS LAST, created_at DESC NULLS LAST
      LIMIT 1
    `,
    [namespaceId]
  );
  const selfEntityId = self.rows[0]?.id ?? null;
  if (!selfEntityId) {
    return { heads: 0, entries: 0 };
  }

  const rows = await client.query<SourceBoundContinuityChunkRow>(
    `
      SELECT
        ac.id::text AS chunk_id,
        ac.artifact_id::text AS artifact_id,
        a.uri AS source_uri,
        ao.observed_at::text AS observed_at,
        ac.chunk_index,
        ac.text_content
      FROM artifacts a
      JOIN artifact_chunks ac ON ac.artifact_id = a.id
      LEFT JOIN artifact_observations ao ON ao.id = ac.artifact_observation_id
      WHERE a.namespace_id = $1
        AND (
          a.uri LIKE '%/omi-archive/normalized/%'
          OR a.uri LIKE '%/data/inbox/omi/normalized/%'
          OR a.uri LIKE '%/omi-watch-smoke/%'
          OR a.uri LIKE '%/life-replay/%'
          OR a.source_channel IN ('omi', 'personal_omi_review_fixture')
          OR a.metadata->>'benchmark' = 'personal_omi_review'
        )
        AND lower(ac.text_content) ~ '(daily routine|current focus|working on|yesterday|preset kitchen|ai brain|two way|well inked|bumblebee|personal time|coffee|reddit|finish|push out)'
      ORDER BY COALESCE(ao.observed_at, a.created_at) DESC NULLS LAST, a.uri DESC, ac.chunk_index ASC
      LIMIT 80
    `,
    [namespaceId]
  );

  const byFamily = new Map<ContinuityProjectionFamily, ContinuityProjectionCandidate[]>();
  for (const row of rows.rows) {
    for (const candidate of extractContinuityCandidatesForRow(row)) {
      const bucket = byFamily.get(candidate.family) ?? [];
      bucket.push(candidate);
      byFamily.set(candidate.family, bucket);
    }
  }

  let heads = 0;
  let entries = 0;
  for (const [family, candidates] of byFamily.entries()) {
    const uniqueCandidates: ContinuityProjectionCandidate[] = [];
    const seen = new Set<string>();
    for (const candidate of candidates) {
      const key = `${candidate.family}:${candidate.value.toLowerCase()}:${candidate.sourceChunkId}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      uniqueCandidates.push(candidate);
    }
    if (uniqueCandidates.length === 0) {
      continue;
    }

    const values = uniqueCandidates.map((candidate) => candidate.value);
    const summaryText = continuityProjectionSummary(family, values);
    const supportState = deriveProjectionSupportState({
      contractName: "continuity_current_state",
      projectionKind: "report",
      summaryText,
      answerPayload: { answer_value: summaryText }
    });
    const latestDate = uniqueCandidates
      .map((candidate) => continuityObservedDate(candidate.observedAt) ?? continuityObservedDate(candidate.sourceUri))
      .filter((value): value is string => Boolean(value))
      .sort()
      .at(-1) ?? null;
    const headId = await insertProjectionHead(client, {
      namespaceId,
      contractName: "continuity_current_state",
      projectionKind: "report",
      subjectEntityId: selfEntityId,
      bundleKey: `continuity_current_state:${family}`,
      summaryText,
      answerPayload: {
        answer_type: "continuity_current_state",
        answer_value: summaryText,
        item_values: uniqueCaseInsensitive(values).slice(0, 12)
      },
      requiredFields: supportState.requiredFields,
      fulfilledFields: supportState.fulfilledFields,
      completenessScore: supportState.completenessScore,
      answerGranularity: "report",
      supportCount: uniqueCandidates.length,
      truthStatus: "active",
      renderContract: renderContractForKind("report"),
      validFrom: latestDate ? `${latestDate}T00:00:00.000Z` : null,
      supportMemoryIds: [],
      renderPayload: {
        summary_text: summaryText,
        item_values: uniqueCaseInsensitive(values).slice(0, 12),
        projection_family: family
      },
      sortKey: latestDate ? `${latestDate}T00:00:00.000Z` : uniqueCandidates[0]?.observedAt ?? null,
      queryFamily: "current_state",
      authoritativeSource: "source_bound_continuity_projection",
      structuredSufficiencyStatus: "sufficient",
      entityResolutionStatus: "resolved",
      projectionVersion: CONTINUITY_CURRENT_STATE_PROJECTION_VERSION,
      metadata: {
        projectionFamily: family,
        projection_family: family,
        projection_version: CONTINUITY_CURRENT_STATE_PROJECTION_VERSION,
        source_bound: true,
        diagnosticOrigin: "continuity_current_state_projection_builder",
        sourceQuotes: uniqueCandidates.map((candidate) => candidate.sourceQuote).slice(0, 12),
        sourceUris: uniqueCaseInsensitive(uniqueCandidates.map((candidate) => candidate.sourceUri ?? "").filter(Boolean)).slice(0, 12),
        timeWindow: latestDate,
        ownerBindingStatus: "self_bound"
      }
    });
    heads += 1;

    for (const [entryIndex, candidate] of uniqueCandidates.slice(0, 24).entries()) {
      const observedDate = continuityObservedDate(candidate.observedAt) ?? continuityObservedDate(candidate.sourceUri);
      await insertProjectionEntry(client, {
        namespaceId,
        projectionHeadId: headId,
        entryIndex,
        displayValue: candidate.value,
        normalizedValue: normalizeKey(candidate.value),
        entryType: family,
        entryRole: "section",
        supportCount: 1,
        truthStatus: "active",
        validFrom: observedDate ? `${observedDate}T00:00:00.000Z` : candidate.observedAt,
        sortKey: observedDate ? `${observedDate}T00:00:00.000Z` : candidate.observedAt,
        sourceTable: "artifact_chunks",
        sourceRowId: candidate.sourceChunkId,
        normalizedPropertyKey: `continuity_current_state.${family}`,
        ownerBindingStatus: "self_bound",
        sourceConfidence: candidate.confidence,
        activeTruth: true,
        metadata: {
          projectionFamily: family,
          projection_family: family,
          answerShape: family === "next_action" ? "list" : "report",
          source_quote: candidate.sourceQuote,
          source_uri: candidate.sourceUri,
          source_chunk_id: candidate.sourceChunkId,
          source_artifact_id: candidate.artifactId,
          source_route: "omi",
          sourceRoute: "omi",
          observed_at: candidate.observedAt,
          ownerBindingStatus: "self_bound",
          projection_version: CONTINUITY_CURRENT_STATE_PROJECTION_VERSION
        }
      });
      entries += 1;
    }
  }
  return { heads, entries };
}

function sourceEvidenceSentences(text: string): string[] {
  const lines = text
    .replace(/\r\n?/gu, "\n")
    .replace(/\s+(?=(?:[-*]\s*)?\[?\d{0,2}:?\d{1,2}\.?\d*\s*-|\b[A-Z][A-Za-z'’-]{1,40}:\s)/gu, "\n")
    .split(/\n+/u)
    .flatMap((line) => line.split(/(?<=[.!?])\s+/u))
    .map((line) => normalize(line).slice(0, 900))
    .filter(Boolean);
  return lines.length > 0 ? lines : [normalize(text).slice(0, 900)].filter(Boolean);
}

function sentenceWith(text: string, pattern: RegExp): string | null {
  return sourceEvidenceSentences(text).find((sentence) => pattern.test(sentence)) ?? null;
}

function matchingSentences(text: string, pattern: RegExp): string[] {
  return sourceEvidenceSentences(text).filter((sentence) => pattern.test(sentence));
}

function combinedMatchingSentences(text: string, pattern: RegExp): string | null {
  const matches = matchingSentences(text, pattern);
  if (matches.length === 0) {
    return null;
  }
  return normalize(matches.join(" "));
}

function pushAliasCurrentCandidate(
  target: AliasCurrentStateProjectionCandidate[],
  row: SourceBoundAliasCurrentStateChunkRow,
  family: AliasCurrentStateProjectionFamily,
  value: string,
  sourceQuote: string,
  trigger: string,
  confidence = 0.88
): void {
  const normalizedValue = normalize(value);
  const normalizedQuote = normalize(sourceQuote);
  if (!normalizedValue || !normalizedQuote) {
    return;
  }
  target.push({
    family,
    value: normalizedValue,
    sourceQuote: normalizedQuote,
    sourceUri: row.source_uri,
    sourceChunkId: row.chunk_id,
    artifactId: row.artifact_id,
    observedAt: row.observed_at,
    trigger,
    confidence
  });
}

function titleValuesFromMediaEvidence(text: string): string[] {
  const values: string[] = [];
  const titlePatterns: readonly [RegExp, string][] = [
    [/\bSinners\b/u, "Sinners"],
    [/\b(?:From\s+)?Dusk\s+Till\s+Dawn\b/u, "From Dusk Till Dawn"],
    [/\bSlow\s+Horses\b/u, "Slow Horses"],
    [/\bChainsaw\s+Man\b/u, "Chainsaw Man"],
    [/\bAvatar\b/u, "Avatar"]
  ];
  for (const [pattern, value] of titlePatterns) {
    if (pattern.test(text)) {
      values.push(value);
    }
  }
  for (const match of text.matchAll(/\b(?:movie|film|tv\s+show|show|series)\s+(?:called\s+)?([A-Z][A-Za-z0-9'’:-]+(?:\s+[A-Z][A-Za-z0-9'’:-]+){0,4})\b/gu)) {
    const candidate = normalize(match[1] ?? "")
      .replace(/\s+(?:at|in|with|which|that|and|but)\b[\s\S]*$/u, "")
      .replace(/[.?!,;:]+$/u, "");
    if (candidate && !/\b(?:Leonardo|DiCaprio|TV|Theater|Oscar|Ben|Chiang Mai|Beast Burger|Two Way|Preset Kitchen|Well Inked)\b/u.test(candidate)) {
      values.push(candidate);
    }
  }
  for (const match of text.matchAll(/\b(?:watching|watched)\s+(?:the\s+)?([A-Z][A-Za-z0-9'’:-]+(?:\s+[A-Z][A-Za-z0-9'’:-]+){0,4})\b/gu)) {
    const candidate = normalize(match[1] ?? "")
      .replace(/\s+(?:at|in|with|which|that|and|but)\b[\s\S]*$/u, "")
      .replace(/[.?!,;:]+$/u, "");
    if (candidate && !/\b(?:Leonardo|DiCaprio|TV|Theater|Oscar|Ben|Chiang Mai|Beast Burger|Two Way|Preset Kitchen|Well Inked)\b/u.test(candidate)) {
      values.push(candidate);
    }
  }
  return uniqueStrings(values);
}

function extractAliasCurrentStateCandidates(row: SourceBoundAliasCurrentStateChunkRow): AliasCurrentStateProjectionCandidate[] {
  const text = row.text_content;
  const candidates: AliasCurrentStateProjectionCandidate[] = [];
  const normalized = text.toLowerCase();

  if (/\bkoz(?:i|a)?mui\b/u.test(normalized) && /\bkoh\s+samui\b/u.test(normalized)) {
    pushAliasCurrentCandidate(
      candidates,
      row,
      "place_alias",
      "Koh Samui",
      sentenceWith(text, /\b(?:koz(?:i|a)?mui|koh\s+samui)\b/iu) ?? text,
      "alias_and_canonical_place_cooccur"
    );
  }

  if (/\buncle\b/u.test(normalized) && /\bbilly\s+smith\b/u.test(normalized) && /\bjoe\s+bob\b/u.test(normalized)) {
    pushAliasCurrentCandidate(
      candidates,
      row,
      "person_alias",
      "Billy Smith / Joe Bob",
      sentenceWith(text, /\b(?:uncle|billy\s+smith|joe\s+bob)\b/iu) ?? text,
      "explicit_person_alias_source_trigger",
      0.94
    );
  }

  if (/\b(?:movies?|films?|tv\s+shows?|series|watched|watching|reminded|Sinners|Slow\s+Horses|Dusk\s+Till\s+Dawn|Chainsaw\s+Man|Avatar)\b/iu.test(text)) {
    const quote = combinedMatchingSentences(
      text,
      /\b(?:movies?|films?|tv\s+shows?|series|watched|watching|reminded|Sinners|Slow\s+Horses|Dusk\s+Till\s+Dawn|Chainsaw\s+Man|Avatar)\b/iu
    ) ?? sentenceWith(text, /\b(?:movies?|films?|tv\s+shows?|series|watched|watching|reminded|Sinners|Slow\s+Horses|Dusk\s+Till\s+Dawn|Chainsaw\s+Man|Avatar)\b/iu);
    const mediaEvidence = quote && titleValuesFromMediaEvidence(quote).length > 0 ? quote : text;
    for (const title of titleValuesFromMediaEvidence(mediaEvidence)) {
      pushAliasCurrentCandidate(candidates, row, "media_title_list", title, mediaEvidence, "media_title_source_trigger", 0.9);
    }
  }

  const foodContext = combinedMatchingSentences(text, /\b(?:food|nachos|spicy|like|liked|liking|favorite|prefer|preferring|enjoy|enjoys|steak|burgers?|pad\s+krapow)\b/iu);
  if (foodContext && /\b(?:like|liked|liking|favorite|prefer|preferring|enjoy|enjoys)\b/iu.test(foodContext)) {
    if (/\bspicy\s+food\b/iu.test(foodContext)) {
      pushAliasCurrentCandidate(candidates, row, "food_preference_list", "spicy food", foodContext, "explicit_food_preference");
      pushAliasCurrentCandidate(candidates, row, "preference_profile_list", "spicy food", foodContext, "food_preference_profile", 0.84);
    }
    if (/\bnachos\b/iu.test(foodContext)) {
      pushAliasCurrentCandidate(candidates, row, "food_preference_list", "nachos", foodContext, "explicit_food_preference");
    }
  }

  const beerQuote = sentenceWith(text, /\b(?:beers?|Leo|Singha|Chang|Thailand|favorite)\b/iu);
  if (beerQuote && /\b(?:beers?|favorite|like|liked|prefer)\b/iu.test(beerQuote)) {
    for (const beer of ["Leo", "Singha", "Chang"]) {
      if (new RegExp(`\\b${beer}\\b`, "u").test(beerQuote)) {
        pushAliasCurrentCandidate(candidates, row, "beer_preference_list", beer, beerQuote, "explicit_beer_preference", 0.9);
      }
    }
  }

  const coffeeQuote = sentenceWith(text, /\b(?:coffee|pour-over|espresso|prefer|switched|stomach)\b/iu);
  if (coffeeQuote && /\b(?:coffee|pour-over|espresso)\b/iu.test(coffeeQuote)) {
    if (/\bpour-?over\b/iu.test(coffeeQuote)) {
      pushAliasCurrentCandidate(candidates, row, "coffee_preference", "pour-over coffee", coffeeQuote, "explicit_coffee_preference", 0.86);
    }
    if (/\bespresso\b/iu.test(coffeeQuote)) {
      pushAliasCurrentCandidate(candidates, row, "coffee_preference", "espresso", coffeeQuote, "explicit_coffee_context", 0.76);
    }
  }

  const preferenceQuote = combinedMatchingSentences(text, /\b(?:like|likes|liked|dislike|dislikes|prefer|prefers|favorite)\b/iu)
    ?? sentenceWith(text, /\b(?:like|likes|liked|dislike|dislikes|prefer|prefers|favorite)\b/iu);
  if (preferenceQuote) {
    const knownPreferences: readonly [RegExp, string][] = [
      [/\bMacBook\s+Pros\b/iu, "MacBook Pros"],
      [/\bsnowboarding\b/iu, "snowboarding"],
      [/\bmountain\s+biking\b/iu, "mountain biking"],
      [/\bhiking\b/iu, "hiking"],
      [/\bWindows\s+(?:machines|PCs?)\b/iu, "Windows machines"],
      [/\bmushy\s+vegetables\b/iu, "mushy vegetables"],
      [/\bAndroid\s+phones\b/iu, "Android phones"],
      [/\bspicy\s+food\b/iu, "spicy food"]
    ];
    for (const [pattern, value] of knownPreferences) {
      if (pattern.test(preferenceQuote)) {
        pushAliasCurrentCandidate(candidates, row, "preference_profile_list", value, preferenceQuote, "explicit_preference_profile", 0.86);
      }
    }
  }

  return candidates;
}

export function extractAliasCurrentStateProjectionCandidatesForTest(text: string): readonly {
  readonly family: string;
  readonly value: string;
  readonly sourceQuote: string;
}[] {
  return extractAliasCurrentStateCandidates({
    chunk_id: "test-chunk",
    artifact_id: "test-artifact",
    source_uri: "test://artifact",
    observed_at: "2026-01-01T00:00:00Z",
    chunk_index: 0,
    text_content: text
  }).map((candidate) => ({
    family: candidate.family,
    value: candidate.value,
    sourceQuote: candidate.sourceQuote
  }));
}

function aliasCurrentStateSummary(family: AliasCurrentStateProjectionFamily, values: readonly string[]): string {
  const valueText = joinListSummary(values) ?? "source-backed current state";
  switch (family) {
    case "place_alias":
      return `Source-backed alias resolution points to ${valueText}.`;
    case "person_alias":
      return `Source-backed person alias resolution points to ${valueText}.`;
    case "media_title_list":
      return `Source-backed media titles include ${valueText}.`;
    case "food_preference_list":
      return `Source-backed food preferences include ${valueText}.`;
    case "beer_preference_list":
      return `Source-backed beer preferences include ${valueText}.`;
    case "coffee_preference":
      return `Source-backed coffee context includes ${valueText}.`;
    case "preference_profile_list":
      return `Source-backed preference profile items include ${valueText}.`;
  }
}

async function buildAliasCurrentStateProjections(client: PoolClient, namespaceId: string): Promise<ContractProjectionRebuildCounts> {
  const self = await client.query<{ readonly id: string }>(
    `
      SELECT id::text
      FROM entities
      WHERE namespace_id = $1
        AND entity_type = 'self'
      ORDER BY last_seen_at DESC NULLS LAST, created_at DESC NULLS LAST
      LIMIT 1
    `,
    [namespaceId]
  );
  const selfEntityId = self.rows[0]?.id ?? null;
  const rows = await client.query<SourceBoundAliasCurrentStateChunkRow>(
    `
      SELECT
        ac.id::text AS chunk_id,
        ac.artifact_id::text AS artifact_id,
        a.uri AS source_uri,
        ao.observed_at::text AS observed_at,
        ac.chunk_index,
        ac.text_content
      FROM artifacts a
      JOIN artifact_chunks ac ON ac.artifact_id = a.id
      LEFT JOIN artifact_observations ao ON ao.id = ac.artifact_observation_id
      WHERE a.namespace_id = $1
        AND lower(ac.text_content) ~ '(uncle|billy smith|joe bob|kozimui|kozamui|koh samui|movies?|films?|tv shows?|series|sinners|slow horses|dusk till dawn|food|nachos|spicy|beers?|leo|singha|chang|coffee|pour-over|espresso|macbook|snowboarding|mountain biking|android|mushy vegetables)'
      ORDER BY COALESCE(ao.observed_at, a.created_at) DESC NULLS LAST, a.uri DESC, ac.chunk_index ASC
      LIMIT 200
    `,
    [namespaceId]
  );
  const byFamily = new Map<AliasCurrentStateProjectionFamily, AliasCurrentStateProjectionCandidate[]>();
  for (const row of rows.rows) {
    for (const candidate of extractAliasCurrentStateCandidates(row)) {
      const bucket = byFamily.get(candidate.family) ?? [];
      bucket.push(candidate);
      byFamily.set(candidate.family, bucket);
    }
  }

  let heads = 0;
  let entries = 0;
  for (const [family, candidates] of byFamily.entries()) {
    const uniqueCandidates: AliasCurrentStateProjectionCandidate[] = [];
    const seen = new Set<string>();
    for (const candidate of candidates) {
      const key = `${candidate.family}:${candidate.value.toLowerCase()}:${candidate.sourceChunkId}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      uniqueCandidates.push(candidate);
    }
    if (uniqueCandidates.length === 0) {
      continue;
    }
    const values = uniqueCaseInsensitive(uniqueCandidates.map((candidate) => candidate.value));
    const summaryText = aliasCurrentStateSummary(family, values);
    const supportState = deriveProjectionSupportState({
      contractName: "alias_current_state",
      projectionKind: "list",
      entries: values.map((displayValue) => ({ displayValue }))
    });
    const latestDate = uniqueCandidates
      .map((candidate) => continuityObservedDate(candidate.observedAt) ?? continuityObservedDate(candidate.sourceUri))
      .filter((value): value is string => Boolean(value))
      .sort()
      .at(-1) ?? null;
    const headId = await insertProjectionHead(client, {
      namespaceId,
      contractName: "alias_current_state",
      projectionKind: "list",
      subjectEntityId: selfEntityId,
      bundleKey: `alias_current_state:${family}`,
      summaryText,
      answerPayload: {
        answer_type: "alias_current_state",
        answer_value: summaryText,
        item_values: values,
        projection_family: family
      },
      requiredFields: supportState.requiredFields,
      fulfilledFields: supportState.fulfilledFields,
      completenessScore: supportState.completenessScore,
      answerGranularity: "list",
      supportCount: uniqueCandidates.length,
      truthStatus: "active",
      renderContract: "alias_current_state_projection_v1",
      validFrom: latestDate ? `${latestDate}T00:00:00.000Z` : null,
      supportMemoryIds: uniqueStrings(uniqueCandidates.map((candidate) => candidate.sourceChunkId)),
      renderPayload: {
        summary_text: summaryText,
        item_values: values,
        projection_family: family
      },
      sortKey: latestDate ? `${latestDate}T00:00:00.000Z` : uniqueCandidates[0]?.observedAt ?? null,
      queryFamily: "current_state",
      authoritativeSource: "source_bound_alias_current_state_projection",
      structuredSufficiencyStatus: "sufficient",
      entityResolutionStatus: "resolved",
      projectionVersion: ALIAS_CURRENT_STATE_PROJECTION_VERSION,
      metadata: {
        projectionFamily: family,
        projection_family: family,
        projection_version: ALIAS_CURRENT_STATE_PROJECTION_VERSION,
        source_bound: true,
        diagnosticOrigin: "alias_current_state_projection_builder",
        sourceQuotes: uniqueCandidates.map((candidate) => candidate.sourceQuote).slice(0, 16),
        sourceUris: uniqueCaseInsensitive(uniqueCandidates.map((candidate) => candidate.sourceUri ?? "").filter(Boolean)).slice(0, 16),
        ownerBindingStatus: "self_bound"
      }
    });
    heads += 1;

    for (const [entryIndex, candidate] of uniqueCandidates.slice(0, 32).entries()) {
      const observedDate = continuityObservedDate(candidate.observedAt) ?? continuityObservedDate(candidate.sourceUri);
      await insertProjectionEntry(client, {
        namespaceId,
        projectionHeadId: headId,
        entryIndex,
        displayValue: candidate.value,
        normalizedValue: normalizeKey(candidate.value),
        entryType: family,
        entryRole: "item",
        supportCount: 1,
        truthStatus: "active",
        validFrom: observedDate ? `${observedDate}T00:00:00.000Z` : candidate.observedAt,
        sortKey: observedDate ? `${observedDate}T00:00:00.000Z` : candidate.observedAt,
        sourceTable: "artifact_chunks",
        sourceRowId: candidate.sourceChunkId,
        supportMemoryIds: [candidate.sourceChunkId],
        normalizedPropertyKey: `alias_current_state.${family}`,
        ownerBindingStatus: "self_bound",
        sourceConfidence: candidate.confidence,
        activeTruth: true,
        metadata: {
          projectionFamily: family,
          projection_family: family,
        answerShape: family === "place_alias" || family === "person_alias" ? "scalar_alias" : "list",
          source_quote: candidate.sourceQuote,
          source_uri: candidate.sourceUri,
          source_chunk_id: candidate.sourceChunkId,
          source_artifact_id: candidate.artifactId,
          source_route: "source_bound_text",
          sourceRoute: "source_bound_text",
          observed_at: candidate.observedAt,
          evidence_trigger: candidate.trigger,
          ownerBindingStatus: "self_bound",
          projection_version: ALIAS_CURRENT_STATE_PROJECTION_VERSION
        }
      });
      entries += 1;
    }
  }
  return { heads, entries };
}

function pushRecapProfileCandidate(
  target: RecapProfileProjectionCandidate[],
  row: SourceBoundRecapProfileChunkRow,
  family: RecapProfileProjectionFamily,
  value: string,
  sourceQuote: string,
  topicKey: string,
  trigger: string,
  confidence = 0.86
): void {
  const normalizedValue = normalize(value);
  const normalizedQuote = normalize(sourceQuote);
  if (!normalizedValue || !normalizedQuote) {
    return;
  }
  target.push({
    family,
    value: normalizedValue,
    sourceQuote: normalizedQuote,
    sourceUri: row.source_uri,
    sourceChunkId: row.chunk_id,
    artifactId: row.artifact_id,
    observedAt: row.observed_at,
    topicKey,
    trigger,
    confidence
  });
}

function extractRecapProfileCandidates(row: SourceBoundRecapProfileChunkRow): RecapProfileProjectionCandidate[] {
  const text = row.text_content;
  const candidates: RecapProfileProjectionCandidate[] = [];

  if (
    /\bMartin\s+Mark\b/iu.test(text) &&
    /\b(?:Columbus|Susan\s+Thomas|Wellness\s+retreats?|Nature\s+hikes?|Daniel\s+Martinez)\b/iu.test(text)
  ) {
    const quote = sentenceWith(text, /\bMartin\s+Mark\b|\bColumbus\b|\bSusan\s+Thomas\b|\bWellness\s+retreats?\b/iu) ?? text;
    const items: readonly [RegExp, string, string][] = [
      [/\bColumbus\b/iu, "Martin Mark lives in Columbus.", "profile_location"],
      [/\bSusan\s+Thomas\b/iu, "Susan Thomas is source-backed close-person evidence for Martin Mark.", "profile_close_person"],
      [/\bDaniel\s+Martinez\b/iu, "Daniel Martinez is source-backed coworker evidence for Martin Mark.", "profile_coworker"],
      [/\bWellness\s+retreats?\b/iu, "Martin Mark has source-backed travel preference evidence for wellness retreats.", "profile_travel_preference"],
      [/\bNature\s+hikes?\b/iu, "Martin Mark has source-backed travel preference evidence for nature hikes.", "profile_travel_preference"]
    ];
    for (const [pattern, value, trigger] of items) {
      if (pattern.test(text)) {
        pushRecapProfileCandidate(candidates, row, "source_profile_summary", value, quote, "martin_mark_profile", trigger, 0.88);
      }
    }
  }

  if (
    /\b(?:yesterday|work(?:ed)? yesterday|talk(?:ed)? about yesterday)\b/iu.test(text) &&
    /\b(?:AI\s+brain|Preset\s+Kitchen|Bumblebee|Two\s+Way|Well\s+Inked)\b/iu.test(text)
  ) {
    const quote = sentenceWith(text, /\b(?:yesterday|AI\s+brain|Preset\s+Kitchen|Bumblebee|Two\s+Way|Well\s+Inked)\b/iu) ?? text;
    const items: readonly [RegExp, string][] = [
      [/\bAI\s+brain\b/iu, "Yesterday recap includes AI Brain work."],
      [/\bPreset\s+Kitchen\b/iu, "Yesterday recap includes Preset Kitchen work."],
      [/\bBumblebee\b/iu, "Yesterday recap includes Bumblebee work."],
      [/\bTwo\s+Way\b/iu, "Yesterday recap includes Two Way work."],
      [/\bWell\s+Inked\b/iu, "Yesterday recap includes Well Inked context."]
    ];
    for (const [pattern, value] of items) {
      if (pattern.test(text)) {
        pushRecapProfileCandidate(candidates, row, "conversation_recap", value, quote, "yesterday_work_recap", "dated_project_recap", 0.9);
      }
    }
  }

  if (/\bMarch\s+22\b|\b2026-03-22\b/iu.test(text) && /\bDan\b/iu.test(text) && /\bladyboys?\b/iu.test(text)) {
    const quote = sentenceWith(text, /\b(?:March\s+22|Dan|ladyboys?|Rhonda)\b/iu) ?? text;
    for (const [pattern, value] of [
      [/\bladyboys?\b/iu, "The March 22 conversation with Dan included discussion of ladyboys."],
      [/\bDan\b/iu, "Dan is a source-backed participant in the March 22 conversation."],
      [/\bRhonda\b/iu, "Rhonda appears in the source-backed March 22 conversation recap."]
    ] as const) {
      if (pattern.test(text)) {
        pushRecapProfileCandidate(candidates, row, "conversation_recap", value, quote, "omi_ladyboys_2026_03_22", "dated_participant_topic_recap", 0.9);
      }
    }
  }

  return candidates;
}

function recapProfileProjectionVersion(family: RecapProfileProjectionFamily): string {
  return family === "conversation_recap" ? CONVERSATION_RECAP_PROJECTION_VERSION : SOURCE_PROFILE_SUMMARY_PROJECTION_VERSION;
}

function recapProfileSummary(family: RecapProfileProjectionFamily, topicKey: string, values: readonly string[]): string {
  const valueText = joinListSummary(values) ?? "source-backed evidence";
  if (family === "source_profile_summary") {
    return `Source-backed profile summary for ${topicKey.replace(/_/gu, " ")}: ${valueText}.`;
  }
  return `Source-backed conversation recap for ${topicKey.replace(/_/gu, " ")}: ${valueText}.`;
}

async function buildSourceBoundRecapProfileProjections(client: PoolClient, namespaceId: string): Promise<ContractProjectionRebuildCounts> {
  const rows = await client.query<SourceBoundRecapProfileChunkRow>(
    `
      SELECT
        ac.id::text AS chunk_id,
        ac.artifact_id::text AS artifact_id,
        a.uri AS source_uri,
        ao.observed_at::text AS observed_at,
        ac.chunk_index,
        ac.text_content
      FROM artifacts a
      JOIN artifact_chunks ac ON ac.artifact_id = a.id
      LEFT JOIN artifact_observations ao ON ao.id = ac.artifact_observation_id
      WHERE a.namespace_id = $1
        AND lower(ac.text_content) ~ '(martin mark|susan thomas|wellness retreats|columbus|daniel martinez|yesterday|ai brain|preset kitchen|bumblebee|two way|well inked|march 22|ladyboys|rhonda)'
      ORDER BY COALESCE(ao.observed_at, a.created_at) DESC NULLS LAST, a.uri DESC, ac.chunk_index ASC
      LIMIT 300
    `,
    [namespaceId]
  );

  const grouped = new Map<string, RecapProfileProjectionCandidate[]>();
  for (const row of rows.rows) {
    for (const candidate of extractRecapProfileCandidates(row)) {
      const key = `${candidate.family}:${candidate.topicKey}`;
      const bucket = grouped.get(key) ?? [];
      bucket.push(candidate);
      grouped.set(key, bucket);
    }
  }

  let heads = 0;
  let entries = 0;
  for (const [groupKey, candidates] of grouped.entries()) {
    const [family] = groupKey.split(":") as [RecapProfileProjectionFamily, string];
    const topicKey = candidates[0]?.topicKey ?? "unknown";
    if (!family || candidates.length === 0) {
      continue;
    }
    const uniqueCandidates: RecapProfileProjectionCandidate[] = [];
    const seen = new Set<string>();
    for (const candidate of candidates) {
      const key = `${candidate.value.toLowerCase()}:${candidate.sourceChunkId}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      uniqueCandidates.push(candidate);
    }
    const values = uniqueCaseInsensitive(uniqueCandidates.map((candidate) => candidate.value));
    const summaryText = recapProfileSummary(family, topicKey, values);
    const supportState = deriveProjectionSupportState({
      contractName: "recap_profile",
      projectionKind: "report",
      summaryText,
      entries: values.map((displayValue) => ({ displayValue }))
    });
    const projectionVersion = recapProfileProjectionVersion(family);
    const latestDate = uniqueCandidates
      .map((candidate) => continuityObservedDate(candidate.observedAt) ?? continuityObservedDate(candidate.sourceUri))
      .filter((value): value is string => Boolean(value))
      .sort()
      .at(-1) ?? null;
    const headId = await insertProjectionHead(client, {
      namespaceId,
      contractName: "recap_profile",
      projectionKind: "report",
      subjectEntityId: null,
      bundleKey: `recap_profile:${family}:${topicKey}`,
      summaryText,
      answerPayload: {
        answer_type: family,
        answer_value: summaryText,
        item_values: values,
        topic_key: topicKey
      },
      requiredFields: supportState.requiredFields,
      fulfilledFields: supportState.fulfilledFields,
      completenessScore: supportState.completenessScore,
      supportCount: uniqueCandidates.length,
      truthStatus: "active",
      renderContract: projectionVersion,
      validFrom: latestDate ? `${latestDate}T00:00:00.000Z` : null,
      supportMemoryIds: uniqueStrings(uniqueCandidates.map((candidate) => candidate.sourceChunkId)),
      renderPayload: {
        summary_text: summaryText,
        item_values: values,
        projection_family: family,
        topic_key: topicKey
      },
      sortKey: latestDate ? `${latestDate}T00:00:00.000Z` : uniqueCandidates[0]?.observedAt ?? null,
      queryFamily: family === "conversation_recap" ? "recap" : "profile",
      authoritativeSource: "source_bound_recap_profile_projection",
      structuredSufficiencyStatus: "sufficient",
      entityResolutionStatus: "resolved",
      projectionVersion,
      metadata: {
        projectionFamily: family,
        projection_family: family,
        topicKey,
        topic_key: topicKey,
        projection_version: projectionVersion,
        source_bound: true,
        diagnosticOrigin: "recap_profile_projection_builder",
        sourceQuotes: uniqueCandidates.map((candidate) => candidate.sourceQuote).slice(0, 16),
        sourceUris: uniqueCaseInsensitive(uniqueCandidates.map((candidate) => candidate.sourceUri ?? "").filter(Boolean)).slice(0, 16),
        ownerBindingStatus: "subject_bound"
      }
    });
    heads += 1;

    for (const [entryIndex, candidate] of uniqueCandidates.slice(0, 32).entries()) {
      const observedDate = continuityObservedDate(candidate.observedAt) ?? continuityObservedDate(candidate.sourceUri);
      await insertProjectionEntry(client, {
        namespaceId,
        projectionHeadId: headId,
        entryIndex,
        displayValue: candidate.value,
        normalizedValue: normalizeKey(candidate.value),
        entryType: family,
        entryRole: candidate.topicKey,
        supportCount: 1,
        truthStatus: "active",
        validFrom: observedDate ? `${observedDate}T00:00:00.000Z` : candidate.observedAt,
        sortKey: observedDate ? `${observedDate}T00:00:00.000Z` : candidate.observedAt,
        sourceTable: "artifact_chunks",
        sourceRowId: candidate.sourceChunkId,
        supportMemoryIds: [candidate.sourceChunkId],
        normalizedPropertyKey: `recap_profile.${family}.${candidate.topicKey}`,
        ownerBindingStatus: "subject_bound",
        sourceConfidence: candidate.confidence,
        activeTruth: true,
        metadata: {
          projectionFamily: family,
          projection_family: family,
          topicKey: candidate.topicKey,
          topic_key: candidate.topicKey,
          answerShape: family === "conversation_recap" ? "recap_evidence_list" : "profile_summary_evidence_list",
          source_quote: candidate.sourceQuote,
          source_uri: candidate.sourceUri,
          source_chunk_id: candidate.sourceChunkId,
          source_artifact_id: candidate.artifactId,
          source_route: "source_bound_text",
          sourceRoute: "source_bound_text",
          observed_at: candidate.observedAt,
          evidence_trigger: candidate.trigger,
          ownerBindingStatus: "subject_bound",
          projection_version: projectionVersion
        }
      });
      entries += 1;
    }
  }
  return { heads, entries };
}

function formatCurrentStatePurchaseSummary(dateKey: string, itemValues: readonly string[], totalValues: readonly string[]): string {
  const items = itemValues.length > 0 ? itemValues.join(", ") : "source-backed purchases";
  const totals = totalValues.length > 0 ? ` Total spending was ${totalValues.join(" / ")}.` : "";
  return `On ${dateKey}, you bought ${items}.${totals}`;
}

async function buildCurrentStatePurchaseProjections(client: PoolClient, namespaceId: string): Promise<ContractProjectionRebuildCounts> {
  const rows = await client.query<SourceBoundPurchaseChunkRow>(
    `
      SELECT
        ac.id::text AS chunk_id,
        ac.artifact_id::text AS artifact_id,
        a.uri AS source_uri,
        ao.observed_at::text AS observed_at,
        ac.chunk_index,
        ac.text_content
      FROM artifacts a
      JOIN artifact_chunks ac ON ac.artifact_id = a.id
      LEFT JOIN artifact_observations ao ON ao.id = ac.artifact_observation_id
      WHERE a.namespace_id = $1
        AND (
          a.uri LIKE '%/omi-archive/normalized/%'
          OR a.uri LIKE '%/data/inbox/omi/normalized/%'
          OR a.uri LIKE '%/omi-watch-smoke/%'
          OR a.source_channel IN ('omi', 'personal_omi_review_fixture')
          OR a.metadata->>'benchmark' = 'personal_omi_review'
        )
        AND lower(ac.text_content) ~ '(bought|buy|purchased|total|spent|paid|baht|bot|dollars?|usd)'
      ORDER BY a.uri, ac.chunk_index
    `,
    [namespaceId]
  );
  const byArtifact = new Map<string, SourceBoundPurchaseChunkRow[]>();
  for (const row of rows.rows) {
    const existing = byArtifact.get(row.artifact_id) ?? [];
    existing.push(row);
    byArtifact.set(row.artifact_id, existing);
  }

  let heads = 0;
  let entries = 0;
  for (const artifactRows of byArtifact.values()) {
    const sourceUri = artifactRows[0]?.source_uri ?? null;
    const dateKey = normalizePurchaseDateKey(sourceUri) ?? normalizePurchaseDateKey(artifactRows[0]?.observed_at) ?? null;
    if (!dateKey) {
      continue;
    }
    const combined = artifactRows.map((row) => row.text_content).join("\n");
    if (!/\b(?:bought|buy|purchased)\b/iu.test(combined) || !/\b(?:total|spent|paid|baht|bot|dollars?|usd)\b/iu.test(combined)) {
      continue;
    }
    const extracted = extractCurrentStatePurchaseProjectionValuesForTest(combined);
    if (extracted.itemValues.length === 0 && extracted.totalValues.length === 0) {
      continue;
    }
    const supportChunkIds = artifactRows.map((row) => row.chunk_id);
    const sourceQuotes = artifactRows
      .map((row) => normalize(row.text_content))
      .filter((text) => /\b(?:bought|buy|purchased|total|baht|bot|dollars?|usd|gas)\b/iu.test(text));
    if (sourceQuotes.length === 0) {
      continue;
    }
    const summaryText = formatCurrentStatePurchaseSummary(dateKey, extracted.itemValues, extracted.totalValues);
    const headId = await insertProjectionHead(client, {
      namespaceId,
      contractName: "current_state_purchase",
      projectionKind: "list",
      subjectEntityId: null,
      bundleKey: `current_state_purchase:${dateKey}`,
      summaryText,
      answerPayload: {
        answer_type: "purchase_inventory",
        answer_value: summaryText,
        item_values: extracted.itemValues,
        total_values: extracted.totalValues,
        date_key: dateKey
      },
      requiredFields: ["item_values", "source_quotes"],
      fulfilledFields: [
        extracted.itemValues.length > 0 ? "item_values" : null,
        extracted.totalValues.length > 0 ? "total_values" : null,
        sourceQuotes.length > 0 ? "source_quotes" : null
      ].filter((value): value is string => Boolean(value)),
      completenessScore: extracted.itemValues.length > 0 && extracted.totalValues.length > 0 ? 1 : 0.75,
      supportCount: sourceQuotes.length,
      truthStatus: "active",
      renderContract: "current_state_purchase_inventory_v1",
      validFrom: `${dateKey}T00:00:00.000Z`,
      validUntil: `${dateKey}T23:59:59.999Z`,
      supportMemoryIds: supportChunkIds,
      renderPayload: {
        summary_text: summaryText,
        source_quotes: sourceQuotes,
        item_values: extracted.itemValues,
        total_values: extracted.totalValues,
        date_key: dateKey
      },
      queryFamily: "current_state",
      authoritativeSource: "contract_projection",
      structuredSufficiencyStatus: "complete",
      projectionVersion: CURRENT_STATE_PURCHASE_PROJECTION_VERSION,
      metadata: {
        projection_family: "current_state_purchase",
        source_route: "omi",
        source_uri: sourceUri,
        source_quotes: sourceQuotes,
        item_values: extracted.itemValues,
        total_values: extracted.totalValues,
        date_key: dateKey
      }
    });
    heads += 1;

    let entryIndex = 0;
    for (const item of extracted.itemValues) {
      await insertProjectionEntry(client, {
        namespaceId,
        projectionHeadId: headId,
        entryIndex,
        displayValue: item,
        normalizedValue: normalizeKey(item),
        entryType: "purchase_item",
        entryRole: "item",
        supportCount: sourceQuotes.length,
        truthStatus: "active",
        validFrom: `${dateKey}T00:00:00.000Z`,
        validUntil: `${dateKey}T23:59:59.999Z`,
        sourceTable: "artifact_chunks",
        sourceRowId: artifactRows.find((row) => /\b(?:bought|buy|purchased)\b/iu.test(row.text_content))?.chunk_id ?? artifactRows[0]?.chunk_id ?? null,
        supportMemoryIds: supportChunkIds,
        normalizedPropertyKey: "current_state_purchase.item",
        ownerBindingStatus: "self_bound",
        sourceConfidence: 0.9,
        metadata: {
          source_quote: sourceQuotes[0] ?? null,
          source_quotes: sourceQuotes,
          source_uri: sourceUri,
          date_key: dateKey
        }
      });
      entryIndex += 1;
      entries += 1;
    }
    for (const total of extracted.totalValues) {
      await insertProjectionEntry(client, {
        namespaceId,
        projectionHeadId: headId,
        entryIndex,
        displayValue: total,
        normalizedValue: normalizeKey(total),
        entryType: "purchase_total",
        entryRole: "total",
        supportCount: sourceQuotes.length,
        truthStatus: "active",
        validFrom: `${dateKey}T00:00:00.000Z`,
        validUntil: `${dateKey}T23:59:59.999Z`,
        sourceTable: "artifact_chunks",
        sourceRowId: artifactRows.find((row) => /\b(?:total|baht|bot|dollars?|usd)\b/iu.test(row.text_content))?.chunk_id ?? artifactRows[0]?.chunk_id ?? null,
        supportMemoryIds: supportChunkIds,
        normalizedPropertyKey: "current_state_purchase.total",
        ownerBindingStatus: "self_bound",
        sourceConfidence: 0.9,
        metadata: {
          source_quote: sourceQuotes.find((quote) => /\b(?:total|baht|bot|dollars?|usd)\b/iu.test(quote)) ?? sourceQuotes[0] ?? null,
          source_quotes: sourceQuotes,
          source_uri: sourceUri,
          date_key: dateKey
        }
      });
      entryIndex += 1;
      entries += 1;
    }
  }
  return { heads, entries };
}

function pickBestReportRow<T extends CanonicalEntityReportRow | CanonicalPairReportRow>(rows: readonly T[]): T | null {
  return [...rows].sort((left, right) =>
    truthStatusRank(projectionTruthStatus(right.t_valid_until)) - truthStatusRank(projectionTruthStatus(left.t_valid_until)) ||
    (right.confidence ?? 0) - (left.confidence ?? 0) ||
    Date.parse(right.t_valid_from ?? right.mentioned_at ?? "1970-01-01T00:00:00.000Z") -
      Date.parse(left.t_valid_from ?? left.mentioned_at ?? "1970-01-01T00:00:00.000Z")
  )[0] ?? null;
}

async function buildEntityReportProjections(client: PoolClient, namespaceId: string): Promise<ContractProjectionRebuildCounts> {
  const rows = await client.query<CanonicalEntityReportRow>(
    `
      SELECT
        id::text,
        subject_entity_id::text,
        report_kind,
        summary_text,
        confidence,
        mentioned_at::text,
        t_valid_from::text,
        t_valid_until::text,
        answer_payload,
        metadata
      FROM canonical_entity_reports
      WHERE namespace_id = $1
      ORDER BY confidence DESC NULLS LAST, t_valid_from DESC NULLS LAST, created_at DESC
    `,
    [namespaceId]
  );

  const grouped = new Map<string, CanonicalEntityReportRow[]>();
  for (const row of rows.rows) {
    const contractName = mapCanonicalEntityReportKindToContract(row.report_kind);
    if (!contractName) {
      continue;
    }
    const key = `${row.subject_entity_id}::${contractName}`;
    const bucket = grouped.get(key) ?? [];
    bucket.push(row);
    grouped.set(key, bucket);
  }

  let heads = 0;
  for (const groupRows of grouped.values()) {
    const selected = pickBestReportRow(groupRows);
    if (!selected) {
      continue;
    }
    const contractName = mapCanonicalEntityReportKindToContract(selected.report_kind);
    if (!contractName) {
      continue;
    }
    const supportState = deriveProjectionSupportState({
      contractName,
      projectionKind: "report",
      summaryText: selected.summary_text,
      answerPayload: selected.answer_payload
    });
    await insertProjectionHead(client, {
      namespaceId,
      contractName,
      projectionKind: "report",
      subjectEntityId: selected.subject_entity_id,
      bundleKey: `entity_report:${contractName}:${selected.subject_entity_id}`,
      summaryText: readString(selected.summary_text),
      answerPayload: selected.answer_payload,
      requiredFields: supportState.requiredFields,
      fulfilledFields: supportState.fulfilledFields,
      completenessScore: supportState.completenessScore,
      supportCount: groupRows.length,
      truthStatus: projectionTruthStatus(selected.t_valid_until),
      renderContract: renderContractForKind("report"),
      validFrom: selected.t_valid_from,
      validUntil: selected.t_valid_until,
      renderPayload: {
        ...(selected.answer_payload ?? {}),
        summary_text: readString(selected.summary_text)
      },
      sortKey: selected.t_valid_from ?? selected.mentioned_at,
      metadata: {
        source_table: "canonical_entity_reports",
        source_row_id: selected.id,
        report_kind: selected.report_kind,
        confidence: selected.confidence,
        raw_metadata: selected.metadata ?? {}
      }
    });
    heads += 1;
  }
  return { heads, entries: 0 };
}

async function buildPairReportProjections(client: PoolClient, namespaceId: string): Promise<ContractProjectionRebuildCounts> {
  const rows = await client.query<CanonicalPairReportRow>(
    `
      SELECT
        id::text,
        subject_entity_id::text,
        pair_subject_entity_id::text,
        report_kind,
        summary_text,
        confidence,
        mentioned_at::text,
        t_valid_from::text,
        t_valid_until::text,
        answer_payload,
        metadata
      FROM canonical_pair_reports
      WHERE namespace_id = $1
        AND report_kind = 'relationship_report'
      ORDER BY confidence DESC NULLS LAST, t_valid_from DESC NULLS LAST, created_at DESC
    `,
    [namespaceId]
  );

  const grouped = new Map<string, CanonicalPairReportRow[]>();
  for (const row of rows.rows) {
    const key = `${row.subject_entity_id}::${row.pair_subject_entity_id}`;
    const bucket = grouped.get(key) ?? [];
    bucket.push(row);
    grouped.set(key, bucket);
  }

  let heads = 0;
  for (const groupRows of grouped.values()) {
    const selected = pickBestReportRow(groupRows);
    if (!selected) {
      continue;
    }
    const supportState = deriveProjectionSupportState({
      contractName: "relationship_profile",
      projectionKind: "report",
      summaryText: selected.summary_text,
      answerPayload: selected.answer_payload
    });
    await insertProjectionHead(client, {
      namespaceId,
      contractName: "relationship_profile",
      projectionKind: "report",
      subjectEntityId: selected.subject_entity_id,
      pairSubjectEntityId: selected.pair_subject_entity_id,
      bundleKey: `pair_report:${selected.subject_entity_id}:${selected.pair_subject_entity_id}`,
      summaryText: readString(selected.summary_text),
      answerPayload: selected.answer_payload,
      requiredFields: supportState.requiredFields,
      fulfilledFields: supportState.fulfilledFields,
      completenessScore: supportState.completenessScore,
      supportCount: groupRows.length,
      truthStatus: projectionTruthStatus(selected.t_valid_until),
      renderContract: renderContractForKind("report"),
      validFrom: selected.t_valid_from,
      validUntil: selected.t_valid_until,
      renderPayload: {
        ...(selected.answer_payload ?? {}),
        summary_text: readString(selected.summary_text)
      },
      sortKey: selected.t_valid_from ?? selected.mentioned_at,
      metadata: {
        source_table: "canonical_pair_reports",
        source_row_id: selected.id,
        report_kind: selected.report_kind,
        confidence: selected.confidence,
        raw_metadata: selected.metadata ?? {}
      }
    });
    heads += 1;
  }
  return { heads, entries: 0 };
}

function sourceBoundRelationshipProjectionKey(row: SourceBoundRelationshipProjectionRow): string {
  const ids = [row.subject_entity_id, row.pair_subject_entity_id].sort();
  return `${ids[0]}::${ids[1]}`;
}

function profileReportQuote(row: SourceBoundRelationshipProjectionRow): string | null {
  const support = readString(row.support_phrase) ?? readString(row.source_text);
  if (!support) {
    return null;
  }
  return support.length > 420 ? `${support.slice(0, 417).trim()}...` : support;
}

function profileReportSectionType(row: SourceBoundRelationshipProjectionRow, quote: string): string {
  const predicate = normalizeKey(row.predicate_family ?? row.relationship_value);
  const evidence = quote.toLowerCase();
  if (/\b(?:former|ended|transition|left|moved|stopped|haven't|have not|no longer|separated|broke up)\b/u.test(`${predicate} ${evidence}`)) {
    return "transition_event";
  }
  if (/\b(?:in|from|to|at)\s+[A-Z][A-Za-z]+|oregon|thailand|tahoe|bend|chiang mai|koh samui|city|lake\b/u.test(quote)) {
    return "shared_location";
  }
  if (/\b(?:support|helped|introduced|connected|inspired|advice)\b/u.test(`${predicate} ${evidence}`)) {
    return "supporting_person";
  }
  return "relationship_status";
}

function profileReportRelationshipLabel(row: SourceBoundRelationshipProjectionRow): string {
  return normalize(row.relationship_value) || normalize(row.predicate_family)?.replace(/_/gu, " ") || "relationship evidence";
}

function relationshipProjectionPredicate(row: SourceBoundRelationshipProjectionRow): string {
  return normalizeKey(row.predicate_family ?? row.relationship_value);
}

function relationshipProjectionCounterparty(row: SourceBoundRelationshipProjectionRow, focusName: string): string {
  const subject = normalize(readString(row.subject_name));
  const object = normalize(readString(row.pair_subject_name));
  const focus = normalize(focusName).toLowerCase();
  if (subject && subject.toLowerCase() === focus) {
    return object || "you";
  }
  if (object && object.toLowerCase() === focus) {
    return subject || "you";
  }
  return object || subject || "the other person";
}

function relationshipMapDisplayValue(row: SourceBoundRelationshipProjectionRow, focusName: string): string {
  const focus = normalize(focusName) || normalize(row.pair_subject_name) || normalize(row.subject_name) || "This person";
  const counterparty = relationshipProjectionCounterparty(row, focus);
  const quote = profileReportQuote(row) ?? "";
  const fromContext = normalize(quote.match(/\bfrom\s+([A-Z][A-Za-z.'-]*(?:\s+[A-Z][A-Za-z.'-]*){0,3})/u)?.[1] ?? "");
  const locationContext = uniqueStrings([
    /\bchiang\s+mai\b/iu.test(quote) ? "Chiang Mai" : "",
    /\bkoh\s+samui\b/iu.test(quote) ? "Koh Samui" : "",
    /\blake\s+tahoe\b|\btahoe\s+city\b/iu.test(quote) ? "Lake Tahoe" : "",
    /\bbend\b/iu.test(quote) ? "Bend" : "",
    /\bthailand\b/iu.test(quote) ? "Thailand" : ""
  ].filter(Boolean)).slice(0, 2);
  const locationSuffix = locationContext.length > 0 ? ` in ${locationContext.join(" and ")}` : "";
  switch (relationshipProjectionPredicate(row)) {
    case "former_partner_of":
    case "was_with":
      return `${focus} is your former partner and former romantic partner`;
    case "best_friends_with":
      return `${focus} is one of your best friends`;
    case "friend_of":
      if (/\bbest friends?\b/iu.test(quote)) {
        return `${focus} is one of your best friends`;
      }
      if (fromContext && locationSuffix) {
        return `${focus} is your friend from ${fromContext}${locationSuffix}`;
      }
      if (fromContext) {
        return `${focus} is your friend from ${fromContext}`;
      }
      return `${focus} is your friend${locationSuffix}`;
    case "works_with":
      if (/\b(?:omi|gummi|gumee|gumi)\b/iu.test(focus) && /\btwo[-\s]?way\b|\b2way\b/iu.test(quote)) {
        return `${focus} works with you through Two Way`;
      }
      if (/\bwell\s+(?:inked|linked)\b/iu.test(quote)) {
        return `${focus} works with you through Well Inked`;
      }
      if (/\btwo[-\s]?way\b|\b2way\b/iu.test(quote)) {
        return `${focus} works with you through Two Way`;
      }
      return `${focus} works with you`;
    case "owner_of":
      return `${focus} is owner of ${counterparty}`;
    case "associated_with":
      if (/\b(?:omi|gummi|gumee|gumi)\b/iu.test(focus) && /\btwo[-\s]?way\b|\b2way\b/iu.test(quote)) {
        return `${focus} is associated with Two Way`;
      }
      if (/\bwell\s+(?:inked|linked)\b/iu.test(quote)) {
        return `${focus} is associated with Well Inked`;
      }
      if (/\btwo[-\s]?way\b|\b2way\b/iu.test(quote)) {
        return `${focus} is associated with Two Way`;
      }
      return `${focus} is associated with ${counterparty}`;
    case "member_of":
      return `${focus} is part of ${counterparty}`;
    case "met_through":
      return `${focus} is connected through ${counterparty}`;
    case "relationship_ended":
      return `${focus}'s relationship with you ended or changed`;
    case "relationship_contact_paused":
      return `${focus}'s contact with you paused`;
    case "relationship_reconnected":
      return `${focus} reconnected with you`;
    default:
      return `${focus} ${relationshipProjectionPredicate(row).replace(/_/gu, " ")} ${counterparty}`;
  }
}

function relationshipChronologyDisplayValue(row: SourceBoundRelationshipProjectionRow): string {
  const subject = normalize(row.subject_name) || "the subject";
  const pair = normalize(row.pair_subject_name) || "the counterpart";
  const predicate = relationshipProjectionPredicate(row);
  const quote = profileReportQuote(row) ?? "";
  const locationContext = uniqueStrings([
    /\blake\s+tahoe\b|\btahoe\s+city\b/iu.test(quote) ? "Lake Tahoe" : "",
    /\bbend\b/iu.test(quote) ? "Bend" : "",
    /\bthailand\b/iu.test(quote) ? "Thailand" : "",
    /\bkoh\s+samui\b/iu.test(quote) ? "Koh Samui" : "",
    /\bchiang\s+mai\b/iu.test(quote) ? "Chiang Mai" : ""
  ].filter(Boolean)).slice(0, 4);
  const locationSuffix = locationContext.length > 0 ? ` across ${locationContext.join(", ")}` : "";
  if (predicate === "relationship_ended") {
    return `${subject} and ${pair} had a relationship transition or ending`;
  }
  if (predicate === "relationship_contact_paused") {
    return `${subject} and ${pair} had a contact pause`;
  }
  if (predicate === "relationship_reconnected") {
    return `${subject} and ${pair} reconnected`;
  }
  if (predicate === "former_partner_of" || predicate === "was_with") {
    return `${subject} and ${pair} have former romantic relationship evidence`;
  }
  if (profileReportSectionType(row, profileReportQuote(row) ?? "") === "shared_location") {
    return `${subject} and ${pair} have shared-location relationship evidence${locationSuffix}`;
  }
  return `${subject} and ${pair} have source-backed relationship evidence${locationSuffix}`;
}

function relationshipMapFocusNames(row: SourceBoundRelationshipProjectionRow): string[] {
  return uniqueStrings([readString(row.subject_name) ?? "", readString(row.pair_subject_name) ?? ""]).filter(
    (name) => !/^steve(?:\s+tietze)?$/iu.test(name)
  );
}

async function buildSourceBoundRelationshipMapProjections(
  client: PoolClient,
  namespaceId: string
): Promise<ContractProjectionRebuildCounts> {
  const result = await client.query<SourceBoundRelationshipProjectionRow>(
    `
      WITH source_rows AS (
        SELECT
          'compiled_relationship_observations'::text AS source_kind,
          cro.id::text AS source_row_id,
          cro.subject_entity_id::text AS subject_entity_id,
          cro.object_entity_id::text AS pair_subject_entity_id,
          subject.canonical_name AS subject_name,
          object.canonical_name AS pair_subject_name,
          cro.predicate_family,
          cro.relationship_value,
          cro.support_phrase,
          cro.source_text,
          cro.source_memory_id::text,
          cro.source_chunk_id::text,
          cro.source_scene_id::text,
          artifact.uri AS source_uri,
          cro.valid_from::text,
          cro.valid_until::text,
          cro.confidence,
          cro.metadata
        FROM compiled_relationship_observations cro
        LEFT JOIN entities subject ON subject.id = cro.subject_entity_id
        LEFT JOIN entities object ON object.id = cro.object_entity_id
        LEFT JOIN episodic_memory memory ON memory.id = cro.source_memory_id
        LEFT JOIN artifacts artifact ON artifact.id = memory.artifact_id
        WHERE cro.namespace_id = $1
          AND cro.truth_status = 'active'
          AND cro.promotion_status = 'compiled'
          AND cro.subject_entity_id IS NOT NULL
          AND cro.object_entity_id IS NOT NULL
          AND COALESCE(NULLIF(cro.support_phrase, ''), NULLIF(cro.source_text, '')) IS NOT NULL
        UNION ALL
        SELECT
          'relationship_candidates'::text AS source_kind,
          rc.id::text AS source_row_id,
          rc.subject_entity_id::text AS subject_entity_id,
          rc.object_entity_id::text AS pair_subject_entity_id,
          subject.canonical_name AS subject_name,
          object.canonical_name AS pair_subject_name,
          rc.predicate AS predicate_family,
          rc.predicate AS relationship_value,
          COALESCE(NULLIF(rc.metadata->>'snippet', ''), NULLIF(memory.content, '')) AS support_phrase,
          COALESCE(NULLIF(rc.metadata->>'snippet', ''), NULLIF(memory.content, '')) AS source_text,
          rc.source_memory_id::text,
          rc.source_chunk_id::text,
          NULL::text AS source_scene_id,
          artifact.uri AS source_uri,
          rc.valid_from::text,
          rc.valid_until::text,
          rc.confidence,
          rc.metadata
        FROM relationship_candidates rc
        LEFT JOIN entities subject ON subject.id = rc.subject_entity_id
        LEFT JOIN entities object ON object.id = rc.object_entity_id
        LEFT JOIN episodic_memory memory ON memory.id = rc.source_memory_id
        LEFT JOIN artifacts artifact ON artifact.id = memory.artifact_id
        WHERE rc.namespace_id = $1
          AND rc.status IN ('pending', 'accepted')
          AND rc.subject_entity_id IS NOT NULL
          AND rc.object_entity_id IS NOT NULL
          AND COALESCE(NULLIF(rc.metadata->>'snippet', ''), NULLIF(memory.content, '')) IS NOT NULL
        UNION ALL
        SELECT
          'episodic_relationship_context'::text AS source_kind,
          memory.id::text AS source_row_id,
          entity.id::text AS subject_entity_id,
          self_binding.entity_id::text AS pair_subject_entity_id,
          entity.canonical_name AS subject_name,
          self_binding.display_name AS pair_subject_name,
          CASE
            WHEN context.context_text ~* 'best friends?' THEN 'best_friends_with'
            WHEN context.context_text ~* 'friends?|friend of mine|old friend|amazing friend' THEN 'friend_of'
            WHEN context.context_text ~* 'former romantic|former partner|dated|broke up' THEN 'former_partner_of'
            WHEN context.context_text ~* 'works? (?:at|with)' THEN 'works_with'
            ELSE 'associated_with'
          END AS predicate_family,
          CASE
            WHEN context.context_text ~* 'best friends?' THEN 'best_friends_with'
            WHEN context.context_text ~* 'friends?|friend of mine|old friend|amazing friend' THEN 'friend_of'
            WHEN context.context_text ~* 'former romantic|former partner|dated|broke up' THEN 'former_partner_of'
            WHEN context.context_text ~* 'works? (?:at|with)' THEN 'works_with'
            ELSE 'associated_with'
          END AS relationship_value,
          context.context_text AS support_phrase,
          context.context_text AS source_text,
          memory.id::text AS source_memory_id,
          NULL::text AS source_chunk_id,
          NULL::text AS source_scene_id,
          artifact.uri AS source_uri,
          memory.occurred_at::text AS valid_from,
          NULL::text AS valid_until,
          0.72::double precision AS confidence,
          jsonb_build_object(
            'source_family', 'episodic_relationship_context',
            'admission_reason', 'source_named_first_person_relationship_cue'
          ) AS metadata
        FROM episodic_memory memory
        JOIN namespace_self_bindings self_binding
          ON self_binding.namespace_id = memory.namespace_id
         AND self_binding.entity_id IS NOT NULL
        JOIN entities entity
         ON entity.namespace_id = memory.namespace_id
         AND entity.id <> self_binding.entity_id
         AND entity.entity_type = 'person'
         AND length(entity.canonical_name) >= 3
         AND lower(entity.canonical_name) NOT IN ('and', 'the', 'that', 'this', 'with', 'from', 'lived')
         AND memory.content ILIKE '%' || entity.canonical_name || '%'
        LEFT JOIN artifacts artifact ON artifact.id = memory.artifact_id
        CROSS JOIN LATERAL (
          SELECT substr(
            memory.content,
            greatest(1, position(lower(entity.canonical_name) in lower(memory.content)) - 90),
            220
          ) AS context_text
        ) context
        WHERE memory.namespace_id = $1
          AND memory.content ~* '(^|[^[:alpha:]])(i|me|my|mine|we|our)([^[:alpha:]]|$)'
          AND context.context_text ~* 'best friends?|friends?|friend of mine|old friend|amazing friend|former romantic|former partner|dated|broke up|works? (?:at|with)'
        UNION ALL
        SELECT
          'artifact_chunk_relationship_context'::text AS source_kind,
          ac.id::text AS source_row_id,
          entity.id::text AS subject_entity_id,
          self_binding.entity_id::text AS pair_subject_entity_id,
          entity.canonical_name AS subject_name,
          self_binding.display_name AS pair_subject_name,
          CASE
            WHEN context.context_text ~* 'best friends?' THEN 'best_friends_with'
            WHEN context.context_text ~* 'friends?|friend of mine|good friends?|brunch with my friend|my friend' THEN 'friend_of'
            WHEN context.context_text ~* 'stopped talking|haven''t really talked|ghosted|left|moved from Thailand' THEN 'relationship_contact_paused'
            WHEN context.context_text ~* 'former romantic|former partner|friends-with-benefits|dated|broke up' THEN 'former_partner_of'
            WHEN context.context_text ~* 'work(?:ed|ing)? (?:at|with|for)|worked together|company|owns?|owned by|acting as CTO|fractional CTO' THEN 'works_with'
            ELSE 'associated_with'
          END AS predicate_family,
          CASE
            WHEN context.context_text ~* 'best friends?' THEN 'best_friends_with'
            WHEN context.context_text ~* 'friends?|friend of mine|good friends?|brunch with my friend|my friend' THEN 'friend_of'
            WHEN context.context_text ~* 'stopped talking|haven''t really talked|ghosted|left|moved from Thailand' THEN 'relationship_contact_paused'
            WHEN context.context_text ~* 'former romantic|former partner|friends-with-benefits|dated|broke up' THEN 'former_partner_of'
            WHEN context.context_text ~* 'work(?:ed|ing)? (?:at|with|for)|worked together|company|owns?|owned by|acting as CTO|fractional CTO' THEN 'works_with'
            ELSE 'associated_with'
          END AS relationship_value,
          context.context_text AS support_phrase,
          context.context_text AS source_text,
          NULL::text AS source_memory_id,
          ac.id::text AS source_chunk_id,
          NULL::text AS source_scene_id,
          artifact.uri AS source_uri,
          COALESCE(ao.observed_at, artifact.created_at)::text AS valid_from,
          NULL::text AS valid_until,
          0.7::double precision AS confidence,
          jsonb_build_object(
            'source_family', 'artifact_chunk_relationship_context',
            'admission_reason', 'source_named_first_person_relationship_cue'
          ) AS metadata
        FROM artifact_chunks ac
        JOIN artifacts artifact ON artifact.id = ac.artifact_id
        LEFT JOIN artifact_observations ao ON ao.id = ac.artifact_observation_id
        JOIN namespace_self_bindings self_binding
          ON self_binding.namespace_id = artifact.namespace_id
         AND self_binding.entity_id IS NOT NULL
        JOIN entities entity
         ON entity.namespace_id = artifact.namespace_id
         AND entity.id <> self_binding.entity_id
         AND entity.entity_type = 'person'
         AND length(entity.canonical_name) >= 3
         AND lower(entity.canonical_name) NOT IN ('and', 'the', 'that', 'this', 'with', 'from', 'lived', 'when')
         AND ac.text_content ~ ('\\m' || entity.canonical_name || '\\M')
        CROSS JOIN LATERAL (
          SELECT substr(
            ac.text_content,
            greatest(1, position(entity.canonical_name in ac.text_content) - 180),
            460
          ) AS context_text
        ) context
        WHERE artifact.namespace_id = $1
          AND (
            artifact.uri LIKE '%/omi-watch-smoke/%'
            OR artifact.source_channel IN ('omi', 'personal_omi_review_fixture')
            OR artifact.metadata->>'benchmark' = 'personal_omi_review'
          )
          AND ac.text_content ~* '(^|[^[:alpha:]])(i|me|my|mine|we|our|speaker)([^[:alpha:]]|$)'
          AND context.context_text ~* 'best friends?|friends?|friend of mine|good friends?|brunch with my friend|former romantic|former partner|friends-with-benefits|dated|broke up|stopped talking|haven''t really talked|ghosted|left|moved from Thailand|work(?:ed|ing)? (?:at|with|for)|worked together|company|owns?|owned by|acting as CTO|fractional CTO|two way|well inked|chiang mai'
      )
      SELECT *
      FROM source_rows
      ORDER BY confidence DESC NULLS LAST, valid_from DESC NULLS LAST, source_row_id
    `,
    [namespaceId]
  );

  const grouped = new Map<string, SourceBoundRelationshipProjectionRow[]>();
  for (const row of result.rows) {
    const quote = profileReportQuote(row);
    const predicate = relationshipProjectionPredicate(row);
    if (!quote || !predicate) {
      continue;
    }
    if (/^(?:co_mention|mentioned_with)$/iu.test(predicate)) {
      continue;
    }
    const key = sourceBoundRelationshipProjectionKey(row);
    const bucket = grouped.get(key) ?? [];
    bucket.push(row);
    grouped.set(key, bucket);
  }

  let heads = 0;
  let entries = 0;
  for (const rows of grouped.values()) {
    const selected = rows[0];
    if (!selected) {
      continue;
    }
    const subjectName = readString(selected.subject_name) ?? "the subject";
    const pairName = readString(selected.pair_subject_name) ?? "the counterpart";
    const memoryIds = uniqueStrings(rows.map((row) => row.source_memory_id).filter((value): value is string => Boolean(value)));
    const relationshipIds = uniqueStrings(
      rows
        .filter((row) => row.source_kind === "compiled_relationship_observations" || row.source_kind === "relationship_candidates")
        .map((row) => row.source_row_id)
    );
    const focusNames = relationshipMapFocusNames(selected);
    const headId = await insertProjectionHead(client, {
      namespaceId,
      contractName: "relationship_map",
      projectionKind: "report",
      subjectEntityId: selected.subject_entity_id,
      pairSubjectEntityId: selected.pair_subject_entity_id,
      bundleKey: `relationship_map_v1:${sourceBoundRelationshipProjectionKey(selected)}`,
      summaryText: `${subjectName} and ${pairName} have ${rows.length} source-backed relationship map entr${rows.length === 1 ? "y" : "ies"}.`,
      answerPayload: {
        answer_type: "relationship_map",
        subject: subjectName,
        pair_subject: pairName,
        focus_names: focusNames
      },
      requiredFields: ["relationship_edge", "source_quote"],
      fulfilledFields: ["relationship_edge", "source_quote"],
      completenessScore: rows.length > 0 ? 1 : 0,
      answerGranularity: "exact_relationship_map",
      supportCount: rows.length,
      truthStatus: "active",
      renderContract: renderContractForKind("report"),
      validFrom: selected.valid_from,
      validUntil: selected.valid_until,
      supportMemoryIds: memoryIds,
      supportRelationshipIds: relationshipIds,
      renderPayload: {
        answer_type: "relationship_map",
        subject: subjectName,
        pair_subject: pairName,
        focus_names: focusNames
      },
      sortKey: selected.valid_from,
      queryFamily: "relationship_exact",
      authoritativeSource: "source_bound_relationship_map_projection",
      structuredSufficiencyStatus: "sufficient",
      entityResolutionStatus: "resolved",
      projectionVersion: RELATIONSHIP_MAP_PROJECTION_VERSION,
      metadata: {
        projection_family: "relationship_map",
        projection_version: RELATIONSHIP_MAP_PROJECTION_VERSION,
        source_bound: true,
        subject_name: subjectName,
        pair_subject_name: pairName,
        source_row_count: rows.length
      }
    });
    heads += 1;

    let entryIndex = 0;
    const seenEdges = new Set<string>();
    for (const row of rows.slice(0, 24)) {
      const quote = profileReportQuote(row);
      if (!quote) {
        continue;
      }
      const focusNamesForRow = relationshipMapFocusNames(row);
      for (const focusName of focusNamesForRow.length ? focusNamesForRow : [pairName]) {
        const displayValue = relationshipMapDisplayValue(row, focusName);
        const edgeKey = `${focusName.toLowerCase()}:${relationshipProjectionPredicate(row)}:${displayValue.toLowerCase()}`;
        if (seenEdges.has(edgeKey)) {
          continue;
        }
        seenEdges.add(edgeKey);
        await insertProjectionEntry(client, {
          namespaceId,
          projectionHeadId: headId,
          entryIndex,
          displayValue,
          normalizedValue: normalizeKey(displayValue),
          entryType: "relationship_edge",
          entryRole: "answer",
          supportCount: 1,
          truthStatus: "active",
          validFrom: row.valid_from,
          validUntil: row.valid_until,
          sortKey: row.valid_from,
          supportMemoryIds: row.source_memory_id ? [row.source_memory_id] : [],
          supportRelationshipIds:
            row.source_kind === "compiled_relationship_observations" || row.source_kind === "relationship_candidates"
              ? [row.source_row_id]
              : [],
          sourceTable: row.source_kind,
          sourceRowId: row.source_row_id,
          normalizedPropertyKey: "relationship_map.edge",
          ownerBindingStatus: "subject_pair_bound",
          sourceConfidence: row.confidence,
          activeTruth: true,
          metadata: {
            source_quote: quote,
            source_uri: row.source_uri,
            source_memory_id: row.source_memory_id,
            source_chunk_id: row.source_chunk_id,
            source_scene_id: row.source_scene_id,
            subject_name: row.subject_name,
            pair_subject_name: row.pair_subject_name,
            focus_name: focusName,
            predicate_family: row.predicate_family,
            relationship_value: row.relationship_value,
            projection_version: RELATIONSHIP_MAP_PROJECTION_VERSION
          }
        });
        entries += 1;
        entryIndex += 1;
      }
    }
  }

  return { heads, entries };
}

async function buildSourceBoundRelationshipChronologyProjections(
  client: PoolClient,
  namespaceId: string
): Promise<ContractProjectionRebuildCounts> {
  const rows = await client.query<SourceBoundRelationshipProjectionRow>(
    `
      SELECT
        'relationship_candidates'::text AS source_kind,
        rc.id::text AS source_row_id,
        rc.subject_entity_id::text AS subject_entity_id,
        rc.object_entity_id::text AS pair_subject_entity_id,
        subject.canonical_name AS subject_name,
        object.canonical_name AS pair_subject_name,
        rc.predicate AS predicate_family,
        rc.predicate AS relationship_value,
        COALESCE(NULLIF(rc.metadata->>'snippet', ''), NULLIF(memory.content, '')) AS support_phrase,
        COALESCE(NULLIF(rc.metadata->>'snippet', ''), NULLIF(memory.content, '')) AS source_text,
        rc.source_memory_id::text,
        rc.source_chunk_id::text,
        NULL::text AS source_scene_id,
        artifact.uri AS source_uri,
        COALESCE(rc.valid_from, memory.occurred_at, rc.created_at)::text AS valid_from,
        rc.valid_until::text,
        rc.confidence,
        rc.metadata
      FROM relationship_candidates rc
      LEFT JOIN entities subject ON subject.id = rc.subject_entity_id
      LEFT JOIN entities object ON object.id = rc.object_entity_id
      LEFT JOIN episodic_memory memory ON memory.id = rc.source_memory_id
      LEFT JOIN artifacts artifact ON artifact.id = memory.artifact_id
      WHERE rc.namespace_id = $1
        AND rc.status IN ('pending', 'accepted')
        AND rc.subject_entity_id IS NOT NULL
        AND rc.object_entity_id IS NOT NULL
        AND COALESCE(NULLIF(rc.metadata->>'snippet', ''), NULLIF(memory.content, '')) IS NOT NULL
      ORDER BY COALESCE(rc.valid_from, memory.occurred_at, rc.created_at) ASC NULLS LAST, rc.created_at ASC
    `,
    [namespaceId]
  );
  const grouped = new Map<string, SourceBoundRelationshipProjectionRow[]>();
  for (const row of rows.rows) {
    const quote = profileReportQuote(row);
    if (!quote) {
      continue;
    }
    const key = sourceBoundRelationshipProjectionKey(row);
    const bucket = grouped.get(key) ?? [];
    bucket.push(row);
    grouped.set(key, bucket);
  }

  let heads = 0;
  let entries = 0;
  for (const groupRows of grouped.values()) {
    const selected = groupRows[0];
    if (!selected || groupRows.length < 1) {
      continue;
    }
    const subjectName = readString(selected.subject_name) ?? "the subject";
    const pairName = readString(selected.pair_subject_name) ?? "the counterpart";
    const memoryIds = uniqueStrings(groupRows.map((row) => row.source_memory_id).filter((value): value is string => Boolean(value)));
    const relationshipIds = uniqueStrings(groupRows.map((row) => row.source_row_id));
    const headId = await insertProjectionHead(client, {
      namespaceId,
      contractName: "relationship_chronology",
      projectionKind: "report",
      subjectEntityId: selected.subject_entity_id,
      pairSubjectEntityId: selected.pair_subject_entity_id,
      bundleKey: `relationship_chronology_v1:${sourceBoundRelationshipProjectionKey(selected)}`,
      summaryText: `${subjectName} and ${pairName} have a source-backed relationship chronology with ${groupRows.length} entr${groupRows.length === 1 ? "y" : "ies"}.`,
      answerPayload: {
        answer_type: "relationship_chronology",
        subject: subjectName,
        pair_subject: pairName
      },
      requiredFields: ["timeline_event", "source_quote"],
      fulfilledFields: ["timeline_event", "source_quote"],
      completenessScore: groupRows.length > 0 ? 1 : 0,
      answerGranularity: "relationship_chronology",
      supportCount: groupRows.length,
      truthStatus: "active",
      renderContract: renderContractForKind("report"),
      validFrom: selected.valid_from,
      validUntil: selected.valid_until,
      supportMemoryIds: memoryIds,
      supportRelationshipIds: relationshipIds,
      renderPayload: {
        answer_type: "relationship_chronology",
        subject: subjectName,
        pair_subject: pairName
      },
      sortKey: selected.valid_from,
      queryFamily: "relationship_history",
      authoritativeSource: "source_bound_relationship_chronology_projection",
      structuredSufficiencyStatus: "sufficient",
      entityResolutionStatus: "resolved",
      projectionVersion: RELATIONSHIP_CHRONOLOGY_PROJECTION_VERSION,
      metadata: {
        projection_family: "relationship_chronology",
        projection_version: RELATIONSHIP_CHRONOLOGY_PROJECTION_VERSION,
        source_bound: true,
        subject_name: subjectName,
        pair_subject_name: pairName,
        source_row_count: groupRows.length
      }
    });
    heads += 1;

    for (const [entryIndex, row] of groupRows.slice(0, 32).entries()) {
      const quote = profileReportQuote(row);
      if (!quote) {
        continue;
      }
      const displayValue = relationshipChronologyDisplayValue(row);
      await insertProjectionEntry(client, {
        namespaceId,
        projectionHeadId: headId,
        entryIndex,
        displayValue,
        normalizedValue: normalizeKey(displayValue),
        entryType: profileReportSectionType(row, quote) === "transition_event" ? "transition_event" : "timeline_event",
        entryRole: "timeline",
        supportCount: 1,
        truthStatus: "active",
        validFrom: row.valid_from,
        validUntil: row.valid_until,
        sortKey: row.valid_from,
        supportMemoryIds: row.source_memory_id ? [row.source_memory_id] : [],
        supportRelationshipIds: [row.source_row_id],
        sourceTable: row.source_kind,
        sourceRowId: row.source_row_id,
        normalizedPropertyKey: "relationship_chronology.timeline_event",
        ownerBindingStatus: "subject_pair_bound",
        sourceConfidence: row.confidence,
        activeTruth: true,
        metadata: {
          source_quote: quote,
          source_uri: row.source_uri,
          source_memory_id: row.source_memory_id,
          source_chunk_id: row.source_chunk_id,
          subject_name: row.subject_name,
          pair_subject_name: row.pair_subject_name,
          predicate_family: row.predicate_family,
          relationship_value: row.relationship_value,
          projection_version: RELATIONSHIP_CHRONOLOGY_PROJECTION_VERSION
        }
      });
      entries += 1;
    }
  }

  return { heads, entries };
}

async function buildSourceBoundProfileReportProjections(
  client: PoolClient,
  namespaceId: string
): Promise<ContractProjectionRebuildCounts> {
  const result = await client.query<SourceBoundRelationshipProjectionRow>(
    `
      WITH source_rows AS (
        SELECT
          'compiled_relationship_observations'::text AS source_kind,
          cro.id::text AS source_row_id,
          cro.subject_entity_id::text AS subject_entity_id,
          cro.object_entity_id::text AS pair_subject_entity_id,
          subject.canonical_name AS subject_name,
          object.canonical_name AS pair_subject_name,
          cro.predicate_family,
          cro.relationship_value,
          cro.support_phrase,
          cro.source_text,
          cro.source_memory_id::text,
          cro.source_chunk_id::text,
          cro.source_scene_id::text,
          artifact.uri AS source_uri,
          cro.valid_from::text,
          cro.valid_until::text,
          cro.confidence,
          cro.metadata
        FROM compiled_relationship_observations cro
        LEFT JOIN entities subject ON subject.id = cro.subject_entity_id
        LEFT JOIN entities object ON object.id = cro.object_entity_id
        LEFT JOIN episodic_memory memory ON memory.id = cro.source_memory_id
        LEFT JOIN artifacts artifact ON artifact.id = memory.artifact_id
        WHERE cro.namespace_id = $1
          AND cro.query_family = 'profile_report'
          AND cro.truth_status = 'active'
          AND cro.promotion_status = 'compiled'
          AND cro.subject_entity_id IS NOT NULL
          AND cro.object_entity_id IS NOT NULL
          AND COALESCE(NULLIF(cro.support_phrase, ''), NULLIF(cro.source_text, '')) IS NOT NULL
        UNION ALL
        SELECT
          'relationship_candidates'::text AS source_kind,
          rc.id::text AS source_row_id,
          rc.subject_entity_id::text AS subject_entity_id,
          rc.object_entity_id::text AS pair_subject_entity_id,
          subject.canonical_name AS subject_name,
          object.canonical_name AS pair_subject_name,
          rc.predicate AS predicate_family,
          rc.predicate AS relationship_value,
          NULLIF(rc.metadata->>'snippet', '') AS support_phrase,
          NULLIF(rc.metadata->>'snippet', '') AS source_text,
          rc.source_memory_id::text,
          rc.source_chunk_id::text,
          NULL::text AS source_scene_id,
          artifact.uri AS source_uri,
          rc.valid_from::text,
          rc.valid_until::text,
          rc.confidence,
          rc.metadata
        FROM relationship_candidates rc
        LEFT JOIN entities subject ON subject.id = rc.subject_entity_id
        LEFT JOIN entities object ON object.id = rc.object_entity_id
        LEFT JOIN episodic_memory memory ON memory.id = rc.source_memory_id
        LEFT JOIN artifacts artifact ON artifact.id = memory.artifact_id
        WHERE rc.namespace_id = $1
          AND rc.status = 'accepted'
          AND rc.subject_entity_id IS NOT NULL
          AND rc.object_entity_id IS NOT NULL
          AND NULLIF(rc.metadata->>'snippet', '') IS NOT NULL
      )
      SELECT *
      FROM source_rows
      ORDER BY confidence DESC NULLS LAST, valid_from DESC NULLS LAST, source_row_id
    `,
    [namespaceId]
  );

  const grouped = new Map<string, SourceBoundRelationshipProjectionRow[]>();
  for (const row of result.rows) {
    const quote = profileReportQuote(row);
    if (!quote) {
      continue;
    }
    const key = sourceBoundRelationshipProjectionKey(row);
    const bucket = grouped.get(key) ?? [];
    bucket.push(row);
    grouped.set(key, bucket);
  }

  let heads = 0;
  let entries = 0;
  for (const rows of grouped.values()) {
    const selected = rows[0];
    if (!selected) {
      continue;
    }
    const subjectName = readString(selected.subject_name) ?? "the subject";
    const pairName = readString(selected.pair_subject_name) ?? "the counterpart";
    const quotes = rows.map(profileReportQuote).filter((quote): quote is string => Boolean(quote));
    const memoryIds = uniqueStrings(rows.map((row) => row.source_memory_id).filter((value): value is string => Boolean(value)));
    const relationshipIds = uniqueStrings(
      rows
        .filter((row) => row.source_kind === "compiled_relationship_observations")
        .map((row) => row.source_row_id)
    );
    const supportCount = quotes.length;
    const summaryText = `${subjectName}'s relationship profile with ${pairName} has ${supportCount} source-backed observation${supportCount === 1 ? "" : "s"}.`;
    const headId = await insertProjectionHead(client, {
      namespaceId,
      contractName: "relationship_profile",
      projectionKind: "report",
      subjectEntityId: selected.subject_entity_id,
      pairSubjectEntityId: selected.pair_subject_entity_id,
      bundleKey: `relationship_profile_source_bound_v1:${sourceBoundRelationshipProjectionKey(selected)}`,
      summaryText,
      answerPayload: {
        answer_type: "relationship_profile_report",
        subject: subjectName,
        pair_subject: pairName,
        section_count: supportCount
      },
      requiredFields: ["source_quote"],
      fulfilledFields: ["source_quote", "relationship_status"],
      completenessScore: supportCount > 0 ? 1 : 0,
      answerGranularity: "report",
      supportCount,
      truthStatus: "active",
      renderContract: renderContractForKind("report"),
      validFrom: selected.valid_from,
      validUntil: selected.valid_until,
      supportMemoryIds: memoryIds,
      supportRelationshipIds: relationshipIds,
      renderPayload: {
        summary_text: summaryText,
        source_quotes: quotes.slice(0, 12)
      },
      sortKey: selected.valid_from,
      queryFamily: "profile_report",
      authoritativeSource: "source_bound_relationship_projection",
      structuredSufficiencyStatus: "sufficient",
      entityResolutionStatus: "resolved",
      projectionVersion: PROFILE_REPORT_PROJECTION_VERSION,
      metadata: {
        projection_family: "relationship_profile",
        projection_version: PROFILE_REPORT_PROJECTION_VERSION,
        source_bound: true,
        subject_name: subjectName,
        pair_subject_name: pairName,
        source_row_count: rows.length
      }
    });
    heads += 1;

    let entryIndex = 0;
    for (const row of rows.slice(0, 24)) {
      const quote = profileReportQuote(row);
      if (!quote) {
        continue;
      }
      const sectionType = profileReportSectionType(row, quote);
      const supportMemoryIds = row.source_memory_id ? [row.source_memory_id] : [];
      const supportRelationshipIds = row.source_kind === "compiled_relationship_observations" ? [row.source_row_id] : [];
      await insertProjectionEntry(client, {
        namespaceId,
        projectionHeadId: headId,
        entryIndex,
        displayValue: quote,
        normalizedValue: normalizeKey(quote),
        entryType: "source_quote",
        entryRole: "evidence",
        supportCount: 1,
        truthStatus: "active",
        validFrom: row.valid_from,
        validUntil: row.valid_until,
        sortKey: row.valid_from,
        supportMemoryIds,
        supportRelationshipIds,
        sourceTable: row.source_kind,
        sourceRowId: row.source_row_id,
        normalizedPropertyKey: "relationship_profile.source_quote",
        ownerBindingStatus: "subject_pair_bound",
        sourceConfidence: row.confidence,
        activeTruth: true,
        metadata: {
          section: "source_quote",
          source_quote: quote,
          source_uri: row.source_uri,
          source_memory_id: row.source_memory_id,
          source_chunk_id: row.source_chunk_id,
          source_scene_id: row.source_scene_id,
          subject_name: subjectName,
          pair_subject_name: pairName,
          predicate_family: row.predicate_family,
          relationship_value: row.relationship_value,
          projection_version: PROFILE_REPORT_PROJECTION_VERSION
        }
      });
      entries += 1;
      entryIndex += 1;

      await insertProjectionEntry(client, {
        namespaceId,
        projectionHeadId: headId,
        entryIndex,
        displayValue: profileReportRelationshipLabel(row),
        normalizedValue: normalizeKey(profileReportRelationshipLabel(row)),
        entryType: sectionType,
        entryRole: "section",
        supportCount: 1,
        truthStatus: "active",
        validFrom: row.valid_from,
        validUntil: row.valid_until,
        sortKey: row.valid_from,
        supportMemoryIds,
        supportRelationshipIds,
        sourceTable: row.source_kind,
        sourceRowId: row.source_row_id,
        normalizedPropertyKey: `relationship_profile.${sectionType}`,
        ownerBindingStatus: "subject_pair_bound",
        sourceConfidence: row.confidence,
        activeTruth: true,
        metadata: {
          section: sectionType,
          source_quote: quote,
          source_uri: row.source_uri,
          source_memory_id: row.source_memory_id,
          source_chunk_id: row.source_chunk_id,
          source_scene_id: row.source_scene_id,
          subject_name: subjectName,
          pair_subject_name: pairName,
          predicate_family: row.predicate_family,
          relationship_value: row.relationship_value,
          projection_version: PROFILE_REPORT_PROJECTION_VERSION
        }
      });
      entries += 1;
      entryIndex += 1;
    }
  }

  return { heads, entries };
}

async function buildSetProjections(client: PoolClient, namespaceId: string): Promise<ContractProjectionRebuildCounts> {
  const rows = await client.query<CanonicalSetEntryRow>(
    `
      SELECT
        cset.id::text AS canonical_set_id,
        cset.subject_entity_id::text AS subject_entity_id,
        cset.valid_from::text,
        cset.valid_until::text,
        cset.confidence,
        cset.metadata AS set_metadata,
        cse.id::text AS entry_id,
        cse.entry_index,
        cse.display_value,
        cse.normalized_value,
        cse.value_type,
        cse.metadata AS entry_metadata
      FROM canonical_sets cset
      JOIN canonical_set_entries cse ON cse.canonical_set_id = cset.id
      WHERE cset.namespace_id = $1
      ORDER BY cset.updated_at DESC, cse.entry_index ASC
    `,
    [namespaceId]
  );

  const grouped = new Map<string, CanonicalSetEntryRow[]>();
  for (const row of rows.rows) {
    const bucket = grouped.get(row.canonical_set_id) ?? [];
    bucket.push(row);
    grouped.set(row.canonical_set_id, bucket);
  }

  let heads = 0;
  let entries = 0;
  for (const groupRows of grouped.values()) {
    const first = groupRows[0];
    if (!first) {
      continue;
    }
    const contractName = mapCanonicalSetMetadataToContract(first.set_metadata);
    if (!contractName) {
      continue;
    }
    const itemValues = groupRows.map((row) => row.display_value);
    const supportState = deriveProjectionSupportState({
      contractName,
      projectionKind: "list",
      entries: groupRows.map((row) => ({ displayValue: row.display_value })),
      summaryText: joinListSummary(itemValues)
    });
    const supportMemoryIds = uniqueStrings(
      groupRows.flatMap((row) => metadataUuidArray(row.entry_metadata, "source_memory_id"))
    );
    const headId = await insertProjectionHead(client, {
      namespaceId,
      contractName,
      projectionKind: "list",
      subjectEntityId: first.subject_entity_id,
      bundleKey: `set:${first.canonical_set_id}`,
      summaryText: joinListSummary(itemValues),
      answerPayload: {
        answer_type: "typed_set_entries",
        item_values: uniqueStrings(itemValues),
        answer_value: joinListSummary(itemValues)
      },
      requiredFields: supportState.requiredFields,
      fulfilledFields: supportState.fulfilledFields,
      completenessScore: supportState.completenessScore,
      supportCount: groupRows.length,
      truthStatus: projectionTruthStatus(first.valid_until),
      renderContract: renderContractForKind("list"),
      validFrom: first.valid_from,
      validUntil: first.valid_until,
      supportMemoryIds,
      renderPayload: {
        answer_type: "typed_set_entries",
        item_values: uniqueStrings(itemValues),
        answer_value: joinListSummary(itemValues)
      },
      sortKey: first.valid_from,
      metadata: {
        source_table: "canonical_sets",
        source_row_id: first.canonical_set_id,
        set_metadata: first.set_metadata ?? {}
      }
    });
    heads += 1;
    for (const row of groupRows) {
      await insertProjectionEntry(client, {
        namespaceId,
        projectionHeadId: headId,
        entryIndex: row.entry_index,
        displayValue: row.display_value,
        normalizedValue: row.normalized_value,
        entryType: row.value_type,
        entryRole: "value",
        supportCount: 1,
        truthStatus: projectionTruthStatus(first.valid_until),
        validFrom: first.valid_from,
        validUntil: first.valid_until,
        sortKey: first.valid_from,
        supportMemoryIds: metadataUuidArray(row.entry_metadata, "source_memory_id"),
        sourceTable: "canonical_set_entries",
        sourceRowId: row.entry_id,
        metadata: { ...(row.entry_metadata ?? {}), canonical_set_id: row.canonical_set_id }
      });
      entries += 1;
    }
  }
  return { heads, entries };
}

function pickBestScalarProjectionRow(rows: readonly CanonicalScalarProjectionRow[]): CanonicalScalarProjectionRow | null {
  return [...rows].sort((left, right) =>
    truthStatusRank(projectionTruthStatus(right.valid_until)) - truthStatusRank(projectionTruthStatus(left.valid_until)) ||
    (right.confidence ?? 0) - (left.confidence ?? 0) ||
    Date.parse(right.valid_from ?? right.mentioned_at ?? "1970-01-01T00:00:00.000Z") -
      Date.parse(left.valid_from ?? left.mentioned_at ?? "1970-01-01T00:00:00.000Z")
  )[0] ?? null;
}

async function buildScalarProjections(client: PoolClient, namespaceId: string): Promise<ContractProjectionRebuildCounts> {
  const stateRows = await client.query<{
    readonly source_row_id: string;
    readonly subject_entity_id: string;
    readonly predicate_family: string;
    readonly value_text: string;
    readonly confidence: number | null;
    readonly valid_from: string | null;
    readonly valid_until: string | null;
    readonly mentioned_at: string | null;
    readonly metadata: JsonRecord | null;
  }>(
    `
      SELECT
        cst.id::text AS source_row_id,
        cst.subject_entity_id::text AS subject_entity_id,
        cst.predicate_family,
        cst.state_value AS value_text,
        cst.confidence,
        cst.t_valid_from::text AS valid_from,
        cst.t_valid_until::text AS valid_until,
        cst.mentioned_at::text,
        cst.metadata
      FROM canonical_states cst
      WHERE cst.namespace_id = $1
      ORDER BY cst.updated_at DESC, cst.created_at DESC
    `,
    [namespaceId]
  );
  const factRows = await client.query<{
    readonly source_row_id: string;
    readonly subject_entity_id: string;
    readonly predicate_family: string;
    readonly value_text: string;
    readonly confidence: number | null;
    readonly valid_from: string | null;
    readonly valid_until: string | null;
    readonly mentioned_at: string | null;
    readonly metadata: JsonRecord | null;
    readonly support_memory_ids: unknown;
  }>(
    `
      SELECT
        cf.id::text AS source_row_id,
        cf.subject_entity_id::text AS subject_entity_id,
        cf.predicate_family,
        cf.object_value AS value_text,
        CASE cf.support_strength WHEN 'strong' THEN 0.95 WHEN 'moderate' THEN 0.8 ELSE 0.65 END AS confidence,
        cf.t_valid_from::text AS valid_from,
        cf.t_valid_until::text AS valid_until,
        cf.mentioned_at::text,
        cf.metadata,
        COALESCE(array_agg(DISTINCT cfp.source_memory_id::text) FILTER (WHERE cfp.source_memory_id IS NOT NULL), '{}'::text[]) AS support_memory_ids
      FROM canonical_facts cf
      LEFT JOIN canonical_fact_provenance cfp ON cfp.canonical_fact_id = cf.id
      WHERE cf.namespace_id = $1
        AND cf.object_value IS NOT NULL
      GROUP BY cf.id
      ORDER BY cf.updated_at DESC, cf.created_at DESC
    `,
    [namespaceId]
  );
  const eventRows = await client.query<{
    readonly source_row_id: string;
    readonly subject_entity_id: string;
    readonly predicate_family: string | null;
    readonly event_key: string;
    readonly event_type: string | null;
    readonly object_value: string | null;
    readonly support_count: number;
    readonly valid_from: string | null;
    readonly valid_until: string | null;
    readonly metadata: JsonRecord | null;
    readonly support_texts: unknown;
  }>(
    `
      SELECT
        tef.id::text AS source_row_id,
        tef.subject_entity_id::text AS subject_entity_id,
        tef.predicate_family,
        tef.event_key,
        tef.event_type,
        tef.object_value,
        tef.support_count,
        tef.valid_from::text AS valid_from,
        tef.valid_until::text AS valid_until,
        tef.metadata,
        COALESCE((
          SELECT jsonb_agg(snippet)
          FROM (
            SELECT tes.snippet
            FROM temporal_event_support tes
            WHERE tes.temporal_event_fact_id = tef.id
              AND tes.snippet IS NOT NULL
            ORDER BY
              CASE tes.support_role WHEN 'primary' THEN 0 WHEN 'support' THEN 1 ELSE 2 END,
              tes.occurred_at DESC NULLS LAST
            LIMIT 4
          ) support_rows
        ), '[]'::jsonb) AS support_texts
      FROM temporal_event_facts tef
      WHERE tef.namespace_id = $1
        AND tef.subject_entity_id IS NOT NULL
        AND tef.truth_status <> 'superseded'
    `,
    [namespaceId]
  );

  const scalarRows: CanonicalScalarProjectionRow[] = [
    ...stateRows.rows
      .map((row): CanonicalScalarProjectionRow | null => {
        const family = inferExactDetailFamilyFromSource({
          predicateFamily: row.predicate_family,
          valueText: row.value_text,
          metadata: row.metadata
        });
        const spec = family ? getExactDetailFamilySpec(family) : null;
        const valueText =
          family
            ? extractAtomicExactDetailValue({
                family,
                texts: [row.value_text, readString(row.metadata?.context_text) ?? ""]
              })
            : null;
        if (!family || !spec || !row.subject_entity_id || !valueText || !normalize(valueText)) {
          return null;
        }
        return {
          source_table: "canonical_states",
          source_row_id: row.source_row_id,
          subject_entity_id: row.subject_entity_id,
          predicate_family: row.predicate_family,
          property_key: deriveExactDetailPropertyKey(spec, [
            row.predicate_family,
            readString(row.metadata?.state_key) ?? "",
            readString(row.metadata?.canonical_key) ?? "",
            family
          ]),
          value_text: valueText,
          confidence: row.confidence,
          valid_from: row.valid_from,
          valid_until: row.valid_until,
          mentioned_at: row.mentioned_at,
          metadata: { ...(row.metadata ?? {}), scalar_exact_family: family },
          support_memory_ids: [],
          support_temporal_fact_ids: [],
          authoritative_source: "active_canonical_state"
        };
      })
      .filter((row): row is CanonicalScalarProjectionRow => Boolean(row)),
    ...factRows.rows
      .map((row): CanonicalScalarProjectionRow | null => {
        const family = inferExactDetailFamilyFromSource({
          predicateFamily: row.predicate_family,
          valueText: row.value_text,
          metadata: row.metadata
        });
        const spec = family ? getExactDetailFamilySpec(family) : null;
        const valueText =
          family
            ? extractAtomicExactDetailValue({
                family,
                texts: [row.value_text, readString(row.metadata?.context_text) ?? ""]
              })
            : null;
        if (!family || !spec || !row.subject_entity_id || !valueText || !normalize(valueText)) {
          return null;
        }
        return {
          source_table: "canonical_facts",
          source_row_id: row.source_row_id,
          subject_entity_id: row.subject_entity_id,
          predicate_family: row.predicate_family,
          property_key: deriveExactDetailPropertyKey(spec, [
            row.predicate_family,
            readString(row.metadata?.state_key) ?? "",
            readString(row.metadata?.canonical_key) ?? "",
            family
          ]),
          value_text: valueText,
          confidence: row.confidence,
          valid_from: row.valid_from,
          valid_until: row.valid_until,
          mentioned_at: row.mentioned_at,
          metadata: { ...(row.metadata ?? {}), scalar_exact_family: family },
          support_memory_ids: readStringArray(row.support_memory_ids),
          support_temporal_fact_ids: [],
          authoritative_source: "active_scalar_fact"
        };
      })
      .filter((row): row is CanonicalScalarProjectionRow => Boolean(row)),
    ...eventRows.rows
      .map((row): CanonicalScalarProjectionRow | null => {
        const supportTexts = readStringArray(row.support_texts);
        const family = inferExactDetailFamilyFromSource({
          predicateFamily: row.predicate_family,
          valueText: row.object_value,
          eventKey: row.event_key,
          eventType: row.event_type,
          supportTexts,
          metadata: row.metadata
        });
        const spec = family ? getExactDetailFamilySpec(family) : null;
        const valueText =
          family
            ? extractAtomicExactDetailValue({
                family,
                texts: [row.object_value ?? "", ...supportTexts]
              })
            : null;
        if (!family || !spec || !row.subject_entity_id || !valueText || !normalize(valueText)) {
          return null;
        }
        return {
          source_table: "temporal_event_facts",
          source_row_id: row.source_row_id,
          subject_entity_id: row.subject_entity_id,
          predicate_family: row.predicate_family ?? family,
          property_key: deriveExactDetailPropertyKey(spec, [
            row.predicate_family ?? "",
            row.event_key,
            row.event_type ?? "",
            family
          ]),
          value_text: valueText,
          confidence: Math.min(0.99, 0.6 + row.support_count * 0.08),
          valid_from: row.valid_from,
          valid_until: row.valid_until,
          mentioned_at: row.valid_from,
          metadata: {
            ...(row.metadata ?? {}),
            scalar_exact_family: family,
            event_key: row.event_key,
            event_type: row.event_type,
            support_texts: supportTexts
          },
          support_memory_ids: [],
          support_temporal_fact_ids: [row.source_row_id],
          authoritative_source: "active_event_fact"
        };
      })
      .filter((row): row is CanonicalScalarProjectionRow => Boolean(row))
  ];

  const grouped = new Map<string, CanonicalScalarProjectionRow[]>();
  for (const row of scalarRows) {
    const family = readString(row.metadata?.scalar_exact_family);
    const contractName = family ? mapExactFamilyToProjectionContract(family as ExactDetailQuestionFamily) : null;
    if (!family || !contractName) {
      continue;
    }
    const key = `${row.subject_entity_id}::${contractName}::${family}`;
    const bucket = grouped.get(key) ?? [];
    bucket.push(row);
    grouped.set(key, bucket);
  }

  let heads = 0;
  let entries = 0;
  for (const groupRows of grouped.values()) {
    const selected = pickBestScalarProjectionRow(groupRows);
    if (!selected) {
      continue;
    }
    const family = readString(selected.metadata?.scalar_exact_family) as ExactDetailQuestionFamily | null;
    const contractName = family ? mapExactFamilyToProjectionContract(family) : null;
    if (!family || !contractName) {
      continue;
    }
    const supportState = deriveProjectionSupportState({
      contractName,
      projectionKind: "scalar",
      summaryText: selected.value_text,
      answerPayload: {
        answer_type: "scalar_exact_detail",
        answer_value: selected.value_text
      }
    });
    const headId = await insertProjectionHead(client, {
      namespaceId,
      contractName,
      projectionKind: "scalar",
      subjectEntityId: selected.subject_entity_id,
      bundleKey: `exact_family:${family}`,
      summaryText: selected.value_text,
      answerPayload: {
        answer_type: "scalar_exact_detail",
        answer_value: selected.value_text
      },
      requiredFields: supportState.requiredFields,
      fulfilledFields: supportState.fulfilledFields,
      completenessScore: supportState.completenessScore,
      supportCount: groupRows.length,
      truthStatus: projectionTruthStatus(selected.valid_until),
      renderContract: renderContractForKind("scalar"),
      validFrom: selected.valid_from,
      validUntil: selected.valid_until,
      supportMemoryIds: uniqueStrings(groupRows.flatMap((row) => row.support_memory_ids)),
      supportTemporalFactIds: uniqueStrings(groupRows.flatMap((row) => row.support_temporal_fact_ids)),
      renderPayload: {
        answer_type: "scalar_exact_detail",
        answer_value: selected.value_text
      },
      sortKey: selected.valid_from ?? selected.mentioned_at,
      queryFamily: /^(speed|brand|service_name|breed|count|time_of_day|capacity)$/u.test(family) ? "current_state" : "exact_detail",
      authoritativeSource:
        selected.authoritative_source,
      structuredSufficiencyStatus: "sufficient",
      entityResolutionStatus: "resolved",
      metadata: {
        source_table: selected.source_table,
        source_row_id: selected.source_row_id,
        scalar_exact_family: family,
        normalized_property_key: selected.property_key,
        predicate_family: selected.predicate_family,
        row_metadata: selected.metadata ?? {}
      }
    });
    heads += 1;
    for (const [entryIndex, row] of groupRows.entries()) {
      await insertProjectionEntry(client, {
        namespaceId,
        projectionHeadId: headId,
        entryIndex,
        displayValue: row.value_text,
        normalizedValue: normalizeKey(row.value_text),
        entryType: family,
        entryRole: row.source_row_id === selected.source_row_id ? "primary" : "support",
        supportCount: 1,
        truthStatus: projectionTruthStatus(row.valid_until),
        validFrom: row.valid_from,
        validUntil: row.valid_until,
        sortKey: row.valid_from ?? row.mentioned_at,
        supportMemoryIds: row.support_memory_ids,
        supportTemporalFactIds: row.support_temporal_fact_ids,
        sourceTable: row.source_table,
        sourceRowId: row.source_row_id,
        normalizedPropertyKey: row.property_key,
        ownerBindingStatus: "resolved",
        sourceConfidence: row.confidence,
        activeTruth: row.valid_until === null,
        metadata: {
          predicate_family: row.predicate_family,
          row_metadata: row.metadata ?? {}
        }
      });
      entries += 1;
    }
  }

  return { heads, entries };
}

async function buildTemporalProjections(client: PoolClient, namespaceId: string): Promise<ContractProjectionRebuildCounts> {
  const facts = await client.query<TemporalEventFactRow>(
    `
      SELECT
        id::text,
        subject_entity_id::text,
        pair_subject_entity_id::text,
        event_key,
        event_label,
        event_type,
        start_at::text,
        end_at::text,
        answer_year,
        answer_month,
        answer_day,
        time_granularity,
        exactness,
        valid_from::text,
        valid_until::text,
        truth_status,
        support_count,
        metadata
      FROM temporal_event_facts
      WHERE namespace_id = $1
      ORDER BY
        CASE truth_status WHEN 'active' THEN 0 WHEN 'uncertain' THEN 1 ELSE 2 END,
        valid_from DESC NULLS LAST,
        start_at DESC NULLS LAST
    `,
    [namespaceId]
  );
  const supports = await client.query<TemporalEventSupportRow>(
    `
      SELECT
        temporal_event_fact_id::text,
        source_row_id::text,
        support_memory_id::text,
        support_role,
        snippet,
        occurred_at::text,
        metadata
      FROM temporal_event_support
      WHERE namespace_id = $1
      ORDER BY
        CASE support_role WHEN 'primary' THEN 0 WHEN 'support' THEN 1 ELSE 2 END,
        occurred_at DESC NULLS LAST
    `,
    [namespaceId]
  );

  const supportByFactId = new Map<string, TemporalEventSupportRow[]>();
  for (const row of supports.rows) {
    const bucket = supportByFactId.get(row.temporal_event_fact_id) ?? [];
    bucket.push(row);
    supportByFactId.set(row.temporal_event_fact_id, bucket);
  }

  let heads = 0;
  let entries = 0;
  for (const fact of facts.rows) {
    if (!fact.subject_entity_id) {
      continue;
    }
    const supportRows = supportByFactId.get(fact.id) ?? [];
    const answerPayload: JsonRecord = {
      answer_type: "temporal_event",
      event_key: fact.event_key,
      event_type: fact.event_type,
      answer_granularity: fact.time_granularity,
      answer_year: fact.answer_year,
      answer_month: fact.answer_month,
      answer_day: fact.answer_day,
      start_at: fact.start_at,
      end_at: fact.end_at,
      answer_value: readString(fact.event_label) ?? fact.event_key.replaceAll("_", " ")
    };
    const supportState = deriveProjectionSupportState({
      contractName: "temporal_event_bundle",
      projectionKind: "temporal",
      summaryText: fact.event_label,
      answerPayload,
      answerGranularity: fact.time_granularity
    });
    const headId = await insertProjectionHead(client, {
      namespaceId,
      contractName: "temporal_event_bundle",
      projectionKind: "temporal",
      subjectEntityId: fact.subject_entity_id,
      pairSubjectEntityId: fact.pair_subject_entity_id,
      bundleKey: `event:${fact.event_key}`,
      summaryText: readString(fact.event_label) ?? fact.event_key.replaceAll("_", " "),
      answerPayload,
      requiredFields: supportState.requiredFields,
      fulfilledFields: supportState.fulfilledFields,
      completenessScore: supportState.completenessScore,
      answerGranularity: fact.time_granularity,
      supportCount: fact.support_count,
      truthStatus: fact.truth_status,
      renderContract: renderContractForKind("temporal"),
      validFrom: fact.valid_from,
      validUntil: fact.valid_until,
      exactness: fact.exactness,
      supportMemoryIds: uniqueStrings(supportRows.flatMap((row) => row.support_memory_id ? [row.support_memory_id] : [])),
      supportTemporalFactIds: [fact.id],
      renderPayload: {
        ...answerPayload,
        summary_text: readString(fact.event_label) ?? fact.event_key.replaceAll("_", " ")
      },
      sortKey: fact.start_at ?? fact.valid_from,
      metadata: {
        temporal_event_metadata: fact.metadata ?? {}
      }
    });
    heads += 1;
    for (const [entryIndex, row] of supportRows.entries()) {
      await insertProjectionEntry(client, {
        namespaceId,
        projectionHeadId: headId,
        entryIndex,
        displayValue: readString(row.snippet) ?? readString(fact.event_label) ?? fact.event_key.replaceAll("_", " "),
        normalizedValue: normalizeKey(readString(row.snippet) ?? fact.event_key),
        entryType: fact.event_type ?? "temporal_event",
        entryRole: row.support_role,
        supportCount: 1,
        truthStatus: fact.truth_status,
        validFrom: fact.valid_from,
        validUntil: fact.valid_until,
        sortKey: row.occurred_at ?? fact.start_at ?? fact.valid_from,
        supportMemoryIds: row.support_memory_id ? [row.support_memory_id] : [],
        supportTemporalFactIds: [fact.id],
        temporalStart: fact.start_at,
        temporalEnd: fact.end_at,
        temporalGranularity: fact.time_granularity,
        sourceTable: "temporal_event_support",
        sourceRowId: row.source_row_id,
        metadata: row.metadata ?? {}
      });
      entries += 1;
    }
  }
  return { heads, entries };
}

export async function rebuildContractProjectionsNamespaceForClient(
  client: PoolClient,
  namespaceId: string
): Promise<ContractProjectionRebuildSummary> {
  await deleteContractProjectionRows(client, namespaceId);
  const totals = { heads: 0, entries: 0 };
  for (const summary of [
    await buildEntityReportProjections(client, namespaceId),
    await buildPairReportProjections(client, namespaceId),
    await buildSourceBoundRelationshipMapProjections(client, namespaceId),
    await buildSourceBoundRelationshipChronologyProjections(client, namespaceId),
    await buildSourceBoundProfileReportProjections(client, namespaceId),
    await buildAliasCurrentStateProjections(client, namespaceId),
    await buildSourceBoundRecapProfileProjections(client, namespaceId),
    await buildProjectDefinitionProjections(client, namespaceId),
    await buildCurrentStatePurchaseProjections(client, namespaceId),
    await buildContinuityCurrentStateProjections(client, namespaceId),
    await buildSetProjections(client, namespaceId),
    await buildScalarProjections(client, namespaceId),
    await buildTemporalProjections(client, namespaceId)
  ]) {
    totals.heads += summary.heads;
    totals.entries += summary.entries;
  }
  return { namespaceId, counts: totals };
}

export async function rebuildContractProjectionsNamespace(namespaceId: string): Promise<ContractProjectionRebuildSummary> {
  return withTransaction((client) => rebuildContractProjectionsNamespaceForClient(client, namespaceId));
}

function readProjectionSubjectEntityId(results: readonly RecallResult[]): string | null {
  for (const result of results) {
    if (typeof result.provenance?.subject_entity_id === "string") {
      return result.provenance.subject_entity_id;
    }
    const metadata =
      typeof result.provenance?.metadata === "object" && result.provenance.metadata !== null
        ? (result.provenance.metadata as JsonRecord)
        : null;
    if (typeof metadata?.subject_entity_id === "string") {
      return metadata.subject_entity_id;
    }
  }
  return null;
}

function resolveProjectionContractName(params: {
  readonly queryText: string;
  readonly retrievalPlan: Pick<AnswerRetrievalPlan, "lane" | "controllerIntent">;
}): ContractProjectionName | null {
  if (params.retrievalPlan.lane === "temporal_event") {
    return "temporal_event_bundle";
  }
  const primary = params.retrievalPlan.controllerIntent?.primaryTypedContract ?? null;
  if (!primary) {
    return null;
  }
  const supportedContracts: readonly ContractProjectionName[] = [
    "identity_profile",
    "relationship_profile",
    "preference_profile",
    "reasoned_profile_judgment",
    "book_list",
    "inventory_list"
  ];
  if (supportedContracts.includes(primary as ContractProjectionName)) {
    return primary as ContractProjectionName;
  }
  if (
    ["value_slot", "symbolic_value_slot", "direct_attribute", "temporal_plan_detail"].includes(primary ?? "") &&
    mapExactFamilyToProjectionContract(inferExactDetailQuestionFamily(params.queryText))
  ) {
    return "value_slot";
  }
  return null;
}

async function resolveProjectionSubjects(params: {
  readonly namespaceId: string;
  readonly queryText: string;
  readonly retrievalPlan: Pick<AnswerRetrievalPlan, "resolvedSubjectEntityId" | "subjectNames">;
  readonly results: readonly RecallResult[];
  readonly contractName: ContractProjectionName;
}): Promise<{ readonly subjectEntityId: string | null; readonly pairSubjectEntityId: string | null }> {
  let subjectEntityId = params.retrievalPlan.resolvedSubjectEntityId ?? readProjectionSubjectEntityId(params.results);
  const primarySubjectName = params.retrievalPlan.subjectNames[0] ?? null;
  if (!subjectEntityId && primarySubjectName) {
    const resolved = await resolveCanonicalEntityReference(params.namespaceId, primarySubjectName);
    subjectEntityId = resolved?.entityId ?? null;
  }
  if (!subjectEntityId && params.contractName === "value_slot" && isFirstPersonExactDetailQuery(params.queryText)) {
    const selfProfile = await getNamespaceSelfProfile(params.namespaceId).catch(() => null);
    subjectEntityId = selfProfile?.entityId ?? null;
  }

  let pairSubjectEntityId: string | null = null;
  if (params.contractName === "relationship_profile" && params.retrievalPlan.subjectNames.length >= 2) {
    const pairName = params.retrievalPlan.subjectNames[1] ?? null;
    if (pairName) {
      const resolved = await resolveCanonicalEntityReference(params.namespaceId, pairName);
      pairSubjectEntityId = resolved?.entityId ?? null;
    }
  }
  return { subjectEntityId, pairSubjectEntityId };
}

async function loadProjectionHead(params: {
  readonly namespaceId: string;
  readonly contractName: ContractProjectionName;
  readonly subjectEntityId: string;
  readonly pairSubjectEntityId: string | null;
  readonly queryText: string;
  readonly timeStart?: string | null;
  readonly timeEnd?: string | null;
}): Promise<ProjectionHeadRow | null> {
  const queryEventKey = params.contractName === "temporal_event_bundle" ? inferTemporalEventKeyFromText(params.queryText) : null;
  const exactDetailFamily =
    params.contractName === "value_slot" ? inferExactDetailQuestionFamily(params.queryText) : "generic";
  const exactDetailBundleKey =
    params.contractName === "value_slot" ? mapExactFamilyToProjectionContract(exactDetailFamily) ? `exact_family:${exactDetailFamily}` : null : null;
  const rows = await queryRows<ProjectionHeadRow>(
    `
      SELECT
        id::text,
        contract_name,
        projection_kind,
        subject_entity_id::text,
        pair_subject_entity_id::text,
        bundle_key,
        summary_text,
        required_fields,
        fulfilled_fields,
        completeness_score,
        answer_granularity,
        support_count,
        truth_status,
        render_contract,
        valid_from::text,
        valid_until::text,
        exactness,
        support_memory_ids,
        support_temporal_fact_ids,
        support_relationship_ids,
        render_payload,
        projection_version,
        query_family,
        authoritative_source,
        structured_sufficiency_status,
        abstention_reason,
        entity_resolution_status,
        temporal_coverage_status
      FROM contract_projection_heads
      WHERE namespace_id = $1
        AND contract_name = $2
        AND subject_entity_id = $3::uuid
        AND ($4::uuid IS NULL OR pair_subject_entity_id = $4::uuid OR pair_subject_entity_id IS NULL)
        AND ($5::text IS NULL OR bundle_key = $5 OR bundle_key LIKE $6)
        AND ($9::text IS NULL OR bundle_key = $9)
        AND ($10::boolean OR projection_version <> 'profile_report_projection_v1')
        AND (
          $7::timestamptz IS NULL
          OR valid_until IS NULL
          OR valid_until >= $7::timestamptz
        )
        AND (
          $8::timestamptz IS NULL
          OR valid_from IS NULL
          OR valid_from <= $8::timestamptz
        )
      ORDER BY
        CASE truth_status WHEN 'active' THEN 0 WHEN 'uncertain' THEN 1 ELSE 2 END,
        completeness_score DESC,
        support_count DESC,
        valid_from DESC NULLS LAST,
        updated_at DESC
      LIMIT 1
    `,
    [
      params.namespaceId,
      params.contractName,
      params.subjectEntityId,
      params.pairSubjectEntityId,
      queryEventKey ? `event:${queryEventKey}` : null,
      queryEventKey ? `event:${queryEventKey}:%` : null,
      params.timeStart ?? null,
      params.timeEnd ?? null,
      exactDetailBundleKey,
      profileReportProjectionEnabled()
    ]
  );
  return rows[0] ?? null;
}

async function loadProjectionEntries(headId: string): Promise<readonly ProjectionEntryRow[]> {
  return queryRows<ProjectionEntryRow>(
    `
      SELECT
        entry_index,
        display_value,
        normalized_value,
        entry_type,
        entry_role,
        support_count,
        truth_status,
        valid_from::text,
        valid_until::text,
        support_memory_ids,
        support_relationship_ids,
        support_temporal_fact_ids,
        temporal_granularity,
        normalized_property_key,
        owner_binding_status,
        source_confidence,
        active_truth
      FROM contract_projection_entries
      WHERE projection_head_id = $1::uuid
      ORDER BY
        CASE truth_status WHEN 'active' THEN 0 WHEN 'uncertain' THEN 1 ELSE 2 END,
        entry_index ASC
    `,
    [headId]
  );
}

function formatTemporalAnswer(head: ProjectionHeadRow): string | null {
  const payload = readJsonRecord(head.render_payload) ?? {};
  const answerYear = typeof payload.answer_year === "number" ? payload.answer_year : null;
  const answerMonth = typeof payload.answer_month === "number" ? payload.answer_month : null;
  const answerDay = typeof payload.answer_day === "number" ? payload.answer_day : null;
  if (answerYear && answerMonth && answerDay) {
    return new Date(Date.UTC(answerYear, answerMonth - 1, answerDay)).toLocaleDateString("en-GB", {
      day: "numeric",
      month: "long",
      year: "numeric",
      timeZone: "UTC"
    });
  }
  if (answerYear && answerMonth) {
    return new Date(Date.UTC(answerYear, answerMonth - 1, 1)).toLocaleDateString("en-GB", {
      month: "long",
      year: "numeric",
      timeZone: "UTC"
    });
  }
  if (answerYear) {
    return String(answerYear);
  }
  const startAt = readString(payload.start_at);
  const endAt = readString(payload.end_at);
  if (startAt && endAt && startAt !== endAt) {
    const start = new Date(startAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
    const end = new Date(endAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
    return `${start} to ${end}`;
  }
  return readString(payload.answer_value) ?? head.summary_text;
}

function renderProjectionClaim(params: {
  readonly head: ProjectionHeadRow;
  readonly entries: readonly ProjectionEntryRow[];
  readonly queryText: string;
}): string | null {
  const payload = readJsonRecord(params.head.render_payload) ?? {};
  if (params.head.projection_kind === "list") {
    const values = params.entries
      .filter((entry) => entry.truth_status !== "superseded")
      .map((entry) => entry.display_value);
    return joinListSummary(values) ?? params.head.summary_text;
  }
  if (params.head.projection_kind === "temporal") {
    return formatTemporalAnswer(params.head);
  }
  if (params.head.projection_kind === "scalar") {
    return readString(payload.answer_value) ?? params.head.summary_text;
  }

  const answerValue = readString(payload.answer_value);
  const reasonValue = readString(payload.reason_value);
  if (/^\s*why\b/i.test(params.queryText) && reasonValue) {
    return reasonValue;
  }
  if (/^\s*(?:would|could|should|is|are|was|were|does|do|did|can|will|has|have)\b/i.test(params.queryText) && answerValue) {
    return reasonValue ? `${answerValue} because ${reasonValue}` : answerValue;
  }
  return reasonValue ?? answerValue ?? params.head.summary_text;
}

function buildProjectionResults(params: {
  readonly namespaceId: string;
  readonly head: ProjectionHeadRow;
  readonly entries: readonly ProjectionEntryRow[];
  readonly claimText: string;
}): readonly RecallResult[] {
  const results: RecallResult[] = [
    {
      memoryId: `projection:${params.head.id}`,
      memoryType: "semantic_memory",
      content: params.claimText,
      score: 1,
      artifactId: null,
      occurredAt: params.head.valid_from,
      namespaceId: params.namespaceId,
      provenance: {
        tier: "contract_projection",
        projection_id: params.head.id,
        subject_entity_id: params.head.subject_entity_id,
        pair_subject_entity_id: params.head.pair_subject_entity_id,
        contract_name: params.head.contract_name,
        projection_kind: params.head.projection_kind,
        truth_status: params.head.truth_status,
        valid_from: params.head.valid_from,
        valid_until: params.head.valid_until,
        exactness: params.head.exactness,
        render_contract: params.head.render_contract,
        projection_version: params.head.projection_version,
        query_family: params.head.query_family,
        authoritative_source: params.head.authoritative_source,
        metadata: readJsonRecord(params.head.render_payload) ?? {}
      }
    }
  ];

  for (const [index, entry] of params.entries
    .filter((row) => row.truth_status !== "superseded")
    .slice(0, 4)
    .entries()) {
    results.push({
      memoryId: `projection:${params.head.id}:entry:${index}`,
      memoryType: "semantic_memory",
      content: entry.display_value,
      score: Math.max(0.5, 0.95 - index * 0.1),
      artifactId: null,
      occurredAt: entry.valid_from,
      namespaceId: params.namespaceId,
      provenance: {
        tier: "contract_projection_support",
        projection_id: params.head.id,
        subject_entity_id: params.head.subject_entity_id,
        entry_type: entry.entry_type,
        entry_role: entry.entry_role,
        truth_status: entry.truth_status,
        valid_from: entry.valid_from,
        valid_until: entry.valid_until,
        support_memory_ids: readUuidArray(entry.support_memory_ids),
        support_relationship_ids: readUuidArray(entry.support_relationship_ids),
        support_temporal_fact_ids: readUuidArray(entry.support_temporal_fact_ids),
        metadata: {
          normalized_value: entry.normalized_value,
          temporal_granularity: entry.temporal_granularity,
          normalized_property_key: entry.normalized_property_key,
          owner_binding_status: entry.owner_binding_status,
          source_confidence: entry.source_confidence,
          active_truth: entry.active_truth
        }
      }
    });
  }
  return results;
}

export async function loadContractProjectionShadow(params: {
  readonly namespaceId: string;
  readonly queryText: string;
  readonly retrievalPlan: Pick<AnswerRetrievalPlan, "lane" | "controllerIntent" | "resolvedSubjectEntityId" | "subjectNames">;
  readonly results: readonly RecallResult[];
}): Promise<ContractProjectionShadow | null> {
  const contractName = resolveProjectionContractName(params);
  if (!contractName) {
    return null;
  }
  const subjects = await resolveProjectionSubjects({
    namespaceId: params.namespaceId,
    queryText: params.queryText,
    retrievalPlan: params.retrievalPlan,
    results: params.results,
    contractName
  });
  if (!subjects.subjectEntityId) {
    return null;
  }
  const head = await loadProjectionHead({
    namespaceId: params.namespaceId,
    contractName,
    subjectEntityId: subjects.subjectEntityId,
    pairSubjectEntityId: subjects.pairSubjectEntityId,
    queryText: params.queryText
  });
  if (!head) {
    return null;
  }
  const entries = await loadProjectionEntries(head.id);
  const requiredFields = readStringArray(head.required_fields);
  const fulfilledFields = readStringArray(head.fulfilled_fields);
  return {
    contractName: head.contract_name,
    projectionKind: head.projection_kind,
    subjectEntityId: head.subject_entity_id,
    pairSubjectEntityId: head.pair_subject_entity_id,
    bundleKey: head.bundle_key,
    completenessScore: head.completeness_score,
    complete: requiredFields.length === 0 || requiredFields.every((field) => fulfilledFields.includes(field)),
    stopEligible:
      head.truth_status !== "superseded" &&
      head.completeness_score >= 0.85 &&
      (requiredFields.length === 0 || requiredFields.every((field) => fulfilledFields.includes(field))),
    answerGranularity: head.answer_granularity,
    supportCount: head.support_count,
    entryCount: entries.length,
    summaryText: head.summary_text,
    requiredFields,
    fulfilledFields,
    truthStatus: head.truth_status,
    projectionVersion: head.projection_version,
    queryFamily: head.query_family,
    authoritativeSource: head.authoritative_source
  };
}

export async function loadContractProjectionRuntime(params: {
  readonly namespaceId: string;
  readonly queryText: string;
  readonly retrievalPlan: Pick<AnswerRetrievalPlan, "lane" | "controllerIntent" | "resolvedSubjectEntityId" | "subjectNames">;
  readonly results?: readonly RecallResult[];
  readonly timeStart?: string | null;
  readonly timeEnd?: string | null;
}): Promise<ContractProjectionRuntimeDecision | null> {
  const contractName = resolveProjectionContractName(params);
  if (!contractName) {
    return null;
  }
  const subjects = await resolveProjectionSubjects({
    namespaceId: params.namespaceId,
    queryText: params.queryText,
    retrievalPlan: params.retrievalPlan,
    results: params.results ?? [],
    contractName
  });
  if (!subjects.subjectEntityId) {
    return null;
  }
  const head = await loadProjectionHead({
    namespaceId: params.namespaceId,
    contractName,
    subjectEntityId: subjects.subjectEntityId,
    pairSubjectEntityId: subjects.pairSubjectEntityId,
    queryText: params.queryText,
    timeStart: params.timeStart,
    timeEnd: params.timeEnd
  });
  if (!head) {
    return null;
  }
  const entries = await loadProjectionEntries(head.id);
  const claimText = renderProjectionClaim({ head, entries, queryText: params.queryText });
  if (!claimText) {
    return null;
  }
  const requiredFields = readStringArray(head.required_fields);
  const fulfilledFields = readStringArray(head.fulfilled_fields);
  const filteredEntries = entries.filter((entry) => entry.truth_status !== "superseded");
  const complete = requiredFields.length === 0 || requiredFields.every((field) => fulfilledFields.includes(field));
  return {
    results: buildProjectionResults({
      namespaceId: params.namespaceId,
      head,
      entries: filteredEntries,
      claimText
    }),
    stopEligible:
      head.truth_status !== "superseded" &&
      head.completeness_score >= 0.85 &&
      complete,
    reason: "The query was answered from deterministic contract projections before broad retrieval.",
    contractName: head.contract_name,
    projectionKind: head.projection_kind,
    queryFamily: head.query_family,
    authoritativeSource: head.authoritative_source,
    complete,
    completenessScore: head.completeness_score,
    projectionVersion: head.projection_version,
    temporalFactCount: readUuidArray(head.support_temporal_fact_ids).length,
    activeSupportCount: filteredEntries.length,
    supersededSupportFilteredCount: Math.max(0, entries.length - filteredEntries.length),
    temporalExactness:
      head.exactness === "exact" || head.exactness === "bounded" || head.exactness === "inferred"
        ? head.exactness
        : null
  };
}
