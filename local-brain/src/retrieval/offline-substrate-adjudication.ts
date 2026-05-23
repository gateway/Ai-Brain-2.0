import type { CompiledFactObservationLookupRow } from "../compiled-memory/service.js";
import { normalizeWhitespace } from "../identity/canonicalization.js";

export type OfflineSubstrateAdjudicationStatus =
  | "renderable"
  | "value_shape_mismatch"
  | "query_shape_mismatch"
  | "missing_source_value"
  | "missing_reader_contract"
  | "weak_list_value"
  | "temporal_anchor_missing"
  | "identity_inference_blocked"
  | "abstention_required";

export interface OfflineSubstrateAdjudicationResult {
  readonly status: OfflineSubstrateAdjudicationStatus;
  readonly renderable: boolean;
  readonly claimText: string | null;
  readonly blockedReason: string | null;
  readonly selectedRowId: string | null;
  readonly sourceDerivedFamily: string | null;
  readonly sourceDerivedValue: string | null;
  readonly queryShape: string | null;
  readonly answerShape: string | null;
  readonly evidenceTriggers: readonly string[];
  readonly premiseQuoteCount: number;
  readonly sourceSessionCount: number;
}

function metadataString(row: CompiledFactObservationLookupRow, key: string): string {
  const value = row.metadata?.[key];
  return typeof value === "string" ? normalizeWhitespace(value) : "";
}

function metadataStrings(row: CompiledFactObservationLookupRow, key: string): readonly string[] {
  const value = row.metadata?.[key];
  return Array.isArray(value) ? value.map((entry) => normalizeWhitespace(entry)).filter(Boolean) : [];
}

function lower(value: string): string {
  return normalizeWhitespace(value).toLowerCase();
}

function hasCausalTrigger(value: string, triggers: readonly string[]): boolean {
  const text = lower([value, ...triggers].join(" "));
  return /\b(?:because|decided?|lost|loved|wanted|inspired?|sparked|motivated|after|due to|reason)\b/u.test(text);
}

function hasSupportActorOrPredicate(value: string, triggers: readonly string[]): boolean {
  const text = normalizeWhitespace(value);
  const joined = lower([value, ...triggers].join(" "));
  return (
    /\b(?:inspired?|supported?|helped?|encouraged?|advised?|mentor(?:ed)?)\b/u.test(joined) ||
    /\b[A-Z][A-Za-z'’-]{1,40}(?:\s+[A-Z][A-Za-z'’-]{1,40}){0,2}\b/u.test(text)
  );
}

function isWhoSupportQuery(query: string): boolean {
  return /\bwho\b/u.test(query) && /\b(?:support|help|advice|encourag|inspir|mentor|volunteering)\b/u.test(query);
}

function isAboutPreferenceQuery(query: string): boolean {
  return /\b(?:favorite|prefer|liked?|enjoy|book|series)\b/u.test(query) && /\babout\b/u.test(query);
}

function isFavoritePreferenceQuery(query: string): boolean {
  return /\b(?:favorite|prefer|liked?|enjoy)\b/u.test(query);
}

function isExplicitListQuery(query: string): boolean {
  return /\b(?:which|what|classes|groups|bands|books?|series|activities|items|names|kinds?)\b/u.test(query);
}

function isDateQuery(query: string): boolean {
  return /\bwhen\b/u.test(query);
}

function isWhyQuery(query: string): boolean {
  return /\bwhy\b/u.test(query);
}

function isInspirationQuery(query: string): boolean {
  return /\b(?:what|who)\b/u.test(query) && /\binspir/u.test(query);
}

function isOriginCausalQuery(query: string): boolean {
  return /\b(?:start|create|open|begin|found|launch)\b/u.test(query);
}

function valueLooksLikeFutureBenefit(value: string): boolean {
  return /\b(?:now i can|can expand|get closer|will be able|allows? me|lets? me|so i can|so we can)\b/u.test(lower(value));
}

function isGenericPreferenceLabel(value: string): boolean {
  const text = lower(value);
  return /^(?:my |their |his |her |our )?favo[u]?rite\s+(?:genre|genres|book|books|series|album|albums|food|kind|type|thing|things)\b/u.test(text);
}

function listMembersAreRenderable(members: readonly string[]): boolean {
  if (members.length === 0) return false;
  return members.every((member) => {
    const text = normalizeWhitespace(member);
    if (!text || text.length > 90) return false;
    if (/\bCaptured:\b/u.test(text) || /[A-Z][A-Za-z'’-]{1,40}:\s/u.test(text)) return false;
    if (text.split(/\s+/u).length > 12) return false;
    return true;
  });
}

function failure(
  row: CompiledFactObservationLookupRow,
  status: OfflineSubstrateAdjudicationStatus,
  blockedReason = status
): OfflineSubstrateAdjudicationResult {
  const triggers = metadataStrings(row, "evidenceTriggers");
  return {
    status,
    renderable: false,
    claimText: null,
    blockedReason,
    selectedRowId: row.id,
    sourceDerivedFamily: metadataString(row, "sourceDerivedFamily") || metadataString(row, "eventFamily") || metadataString(row, "stateFamily") || null,
    sourceDerivedValue: metadataString(row, "sourceDerivedAnswerValue") || null,
    queryShape: metadataString(row, "queryShape") || null,
    answerShape: metadataString(row, "answerShape") || null,
    evidenceTriggers: triggers,
    premiseQuoteCount: metadataStrings(row, "premiseQuotes").length,
    sourceSessionCount: metadataStrings(row, "sourceSessionKeys").length
  };
}

function success(row: CompiledFactObservationLookupRow, claimText: string): OfflineSubstrateAdjudicationResult {
  const triggers = metadataStrings(row, "evidenceTriggers");
  return {
    status: "renderable",
    renderable: true,
    claimText: normalizeWhitespace(claimText),
    blockedReason: null,
    selectedRowId: row.id,
    sourceDerivedFamily: metadataString(row, "sourceDerivedFamily") || metadataString(row, "eventFamily") || metadataString(row, "stateFamily") || null,
    sourceDerivedValue: metadataString(row, "sourceDerivedAnswerValue") || null,
    queryShape: metadataString(row, "queryShape") || null,
    answerShape: metadataString(row, "answerShape") || null,
    evidenceTriggers: triggers,
    premiseQuoteCount: metadataStrings(row, "premiseQuotes").length,
    sourceSessionCount: metadataStrings(row, "sourceSessionKeys").length
  };
}

function sentenceFromList(members: readonly string[]): string {
  return members.length === 1 ? members[0]! : members.join(", ");
}

export function adjudicateOfflineSubstrateRowForQuery(
  queryText: string,
  row: CompiledFactObservationLookupRow
): OfflineSubstrateAdjudicationResult {
  const query = lower(queryText);
  const sourceDerivedFamily = metadataString(row, "sourceDerivedFamily") || metadataString(row, "eventFamily") || metadataString(row, "stateFamily");
  const sourceDerivedValue = metadataString(row, "sourceDerivedAnswerValue") || normalizeWhitespace(row.answer_value ?? "");
  const queryShape = metadataString(row, "queryShape");
  const answerShape = metadataString(row, "answerShape");
  const premiseQuotes = metadataStrings(row, "premiseQuotes");
  const sourceSessionKeys = metadataStrings(row, "sourceSessionKeys");
  const triggers = metadataStrings(row, "evidenceTriggers");
  const listMembers = metadataStrings(row, "listMembers");
  const temporalAnchor = metadataString(row, "temporalAnchor");

  if (row.metadata?.diagnosticOnly !== true || row.metadata?.admissionMode !== "source_independent") {
    return failure(row, "missing_reader_contract");
  }
  if (row.metadata?.expectedAnswerUsedForPromotion === true || row.metadata?.mixedOwner === true) {
    return failure(row, "missing_reader_contract");
  }
  if (row.metadata?.inferredIdentityMembershipFromSupport === true || metadataString(row, "identityClaimType") === "membership") {
    return failure(row, "identity_inference_blocked");
  }
  if (!sourceDerivedFamily || !queryShape || !answerShape || premiseQuotes.length === 0 || sourceSessionKeys.length === 0) {
    return failure(row, "missing_reader_contract");
  }
  if (!sourceDerivedValue && listMembers.length === 0 && !temporalAnchor) {
    return failure(row, "missing_source_value");
  }

  if (isDateQuery(query)) {
    if (sourceDerivedFamily !== "dated_activity_event" && !temporalAnchor) return failure(row, "query_shape_mismatch");
    if (!temporalAnchor) return failure(row, "temporal_anchor_missing");
    return success(row, temporalAnchor);
  }

  if (isWhoSupportQuery(query)) {
    if (sourceDerivedFamily !== "support_reason_event") return failure(row, "query_shape_mismatch");
    if (!hasSupportActorOrPredicate(sourceDerivedValue, triggers)) return failure(row, "value_shape_mismatch");
    return success(row, sourceDerivedValue);
  }

  if (isWhyQuery(query)) {
    if (sourceDerivedFamily !== "causal_reason_event" || queryShape !== "causal_reason") return failure(row, "query_shape_mismatch");
    if (!hasCausalTrigger(sourceDerivedValue, triggers)) return failure(row, "value_shape_mismatch");
    if (isOriginCausalQuery(query) && valueLooksLikeFutureBenefit(sourceDerivedValue)) return failure(row, "missing_reader_contract");
    return success(row, sourceDerivedValue);
  }

  if (isInspirationQuery(query)) {
    return failure(row, "abstention_required");
  }

  if (isAboutPreferenceQuery(query)) {
    if (sourceDerivedFamily !== "favorite_preference_event") return failure(row, "query_shape_mismatch");
    if (!/\babout\b/u.test(lower(sourceDerivedValue))) return failure(row, "missing_reader_contract");
    return success(row, sourceDerivedValue);
  }

  if (isFavoritePreferenceQuery(query)) {
    if (sourceDerivedFamily !== "favorite_preference_event") return failure(row, "query_shape_mismatch");
    if (answerShape !== "preference" && answerShape !== "atomic" && answerShape !== "list") return failure(row, "value_shape_mismatch");
    if (isGenericPreferenceLabel(sourceDerivedValue)) return failure(row, "value_shape_mismatch");
    return success(row, listMembers.length > 0 ? sentenceFromList(listMembers) : sourceDerivedValue);
  }

  if (isExplicitListQuery(query)) {
    if (sourceDerivedFamily !== "explicit_list_event" && sourceDerivedFamily !== "reading_event") {
      return failure(row, "query_shape_mismatch");
    }
    if (!listMembersAreRenderable(listMembers)) return failure(row, "weak_list_value");
    return success(row, sentenceFromList(listMembers));
  }

  return failure(row, "missing_reader_contract");
}

export function offlineSubstrateAdjudicationStatusForTest(
  queryText: string,
  row: CompiledFactObservationLookupRow
): OfflineSubstrateAdjudicationResult {
  return adjudicateOfflineSubstrateRowForQuery(queryText, row);
}
