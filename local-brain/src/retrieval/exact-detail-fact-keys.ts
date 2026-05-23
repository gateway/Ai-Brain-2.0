import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { withTransaction } from "../db/client.js";
import { loadNamespaceSelfProfileForClient } from "../identity/service.js";
import {
  getExactDetailFamilySpec,
  type ExactDetailFamilySpec,
  type ExactDetailQuestionFamily
} from "./exact-detail-question-family.js";

type JsonRecord = Record<string, unknown>;

export type ExactDetailFactTable =
  | "canonical_states"
  | "canonical_facts"
  | "temporal_event_facts"
  | "contract_projection_entries"
  | "narrative_scenes";

export type ExactDetailFactKeyType =
  | "value"
  | "fact"
  | "alias"
  | "event_key"
  | "support_phrase";

export interface ExactDetailFactKeySummary {
  readonly namespaceId: string;
  readonly rows: number;
}

export interface ExactDetailFactKeyLookupRow {
  readonly id: string;
  readonly fact_table: ExactDetailFactTable;
  readonly fact_row_id: string;
  readonly subject_entity_id: string | null;
  readonly exact_detail_family: string;
  readonly property_key: string | null;
  readonly key_type: ExactDetailFactKeyType;
  readonly key_text: string;
  readonly normalized_key_text: string;
  readonly truth_status: "active" | "superseded" | "uncertain";
  readonly valid_from: string | null;
  readonly valid_until: string | null;
  readonly confidence: number | null;
  readonly metadata: JsonRecord | null;
}

interface CanonicalStateKeySourceRow {
  readonly id: string;
  readonly subject_entity_id: string | null;
  readonly predicate_family: string;
  readonly state_value: string | null;
  readonly valid_from: string | null;
  readonly valid_until: string | null;
  readonly confidence: number | null;
  readonly metadata: JsonRecord | null;
}

interface CanonicalFactKeySourceRow {
  readonly id: string;
  readonly subject_entity_id: string | null;
  readonly predicate_family: string;
  readonly object_value: string | null;
  readonly valid_from: string | null;
  readonly valid_until: string | null;
  readonly confidence: number | null;
  readonly metadata: JsonRecord | null;
}

interface TemporalEventKeySourceRow {
  readonly id: string;
  readonly subject_entity_id: string | null;
  readonly predicate_family: string | null;
  readonly event_key: string;
  readonly event_type: string | null;
  readonly object_value: string | null;
  readonly truth_status: "active" | "superseded" | "uncertain";
  readonly valid_from: string | null;
  readonly valid_until: string | null;
  readonly support_count: number;
  readonly metadata: JsonRecord | null;
  readonly support_texts: unknown;
}

interface ProjectionEntryKeySourceRow {
  readonly id: string;
  readonly subject_entity_id: string | null;
  readonly normalized_property_key: string | null;
  readonly display_value: string;
  readonly truth_status: "active" | "superseded" | "uncertain";
  readonly valid_from: string | null;
  readonly valid_until: string | null;
  readonly source_confidence: number | null;
  readonly authoritative_source: string | null;
  readonly query_family: string | null;
  readonly metadata: JsonRecord | null;
}

interface NarrativeSceneKeySourceRow {
  readonly id: string;
  readonly scene_text: string;
  readonly occurred_at: string | null;
  readonly metadata: JsonRecord | null;
}

interface ExactDetailFactKeyInsertRow {
  readonly factTable: ExactDetailFactTable;
  readonly factRowId: string;
  readonly subjectEntityId: string | null;
  readonly family: ExactDetailQuestionFamily;
  readonly propertyKey: string | null;
  readonly keyType: ExactDetailFactKeyType;
  readonly keyText: string;
  readonly truthStatus: "active" | "superseded" | "uncertain";
  readonly validFrom: string | null;
  readonly validUntil: string | null;
  readonly confidence: number | null;
  readonly metadata: JsonRecord;
}

export interface SceneExactDetailPromotionDiagnostic {
  readonly structureKind: "scalar_value_support" | "event_value_support" | "raw_scene_support";
  readonly promotionEligible: boolean;
  readonly promotionRejectedReason:
    | "support_only_mode"
    | "no_structure_support"
    | "weak_ownership_evidence"
    | "family_mismatch"
    | "inadmissible_value_shape"
    | "ambiguous_self_binding"
    | "empty_support_phrase"
    | null;
  readonly ownershipEvidenceStatus:
    | "explicit_ownership_cue"
    | "explicit_self_alias"
    | "scene_self_binding"
    | "ambiguous"
    | "missing";
  readonly familyEvidenceStatus: "property_match" | "predicate_match" | "support_inferred" | "missing";
  readonly valueAdmissibilityStatus: "admissible" | "support_derived" | "inadmissible" | "missing";
  readonly inferredFamily: string | null;
  readonly familyHint: string | null;
  readonly supportPhrase: string | null;
  readonly extractorConfidence: number | null;
}

export interface SceneStructuredExactDetailAnalysis {
  readonly rows: readonly ExactDetailFactKeyInsertRow[];
  readonly diagnostics: readonly SceneExactDetailPromotionDiagnostic[];
}

const EMPTY_SCENE_EXACT_DETAIL_ANALYSIS: SceneStructuredExactDetailAnalysis = {
  rows: [],
  diagnostics: []
};

const TARGET_FAMILIES: readonly ExactDetailQuestionFamily[] = [
  "pet_name",
  "breed",
  "brand",
  "count",
  "service_name",
  "playlist_name",
  "last_name",
  "venue",
  "certification",
  "capacity",
  "speed",
  "time_of_day",
  "duration",
  "role",
  "shop",
  "creative_work",
  "price",
  "stance",
  "purchased_items",
  "food_drink",
  "age_at_event",
  "color"
] as const;

const RAW_SCENE_SELF_OWNED_EXACT_DETAIL_FAMILIES = new Set<ExactDetailQuestionFamily>([
  "brand",
  "food_drink",
  "service_name",
  "playlist_name",
  "pet_name",
  "breed",
  "last_name",
  "capacity",
  "speed",
  "time_of_day",
  "count",
  "creative_work",
  "price",
  "stance",
  "color"
]);

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

function readJsonRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : null;
}

function readJsonArray(value: unknown): unknown[] {
  return Array.isArray(value) ? [...value] : [];
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
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

function classificationValues(value: JsonRecord | null | undefined, key: string): string[] {
  const raw = value?.[key];
  if (Array.isArray(raw)) {
    return raw.map((entry) => normalize(String(entry ?? ""))).filter(Boolean);
  }
  if (typeof raw === "string") {
    const normalized = normalize(raw);
    return normalized ? [normalized] : [];
  }
  return [];
}

function relationIeModeFromExtractor(
  extractor: JsonRecord | null | undefined,
  externalIe: JsonRecord | null | undefined
): "support_only" | "support_and_promote" {
  const extractorMode = normalizeKey(readString(extractor?.relation_ie_mode));
  if (extractorMode === "support_only" || extractorMode === "support_and_promote") {
    return extractorMode;
  }
  const rootMode = normalizeKey(readString(externalIe?.relation_ie_mode));
  if (rootMode === "support_only" || rootMode === "support_and_promote") {
    return rootMode;
  }
  return "support_and_promote";
}

function structureEntries(value: JsonRecord | null | undefined, key: string): JsonRecord[] {
  const raw = value?.[key];
  if (Array.isArray(raw)) {
    return raw
      .map((entry) => readJsonRecord(entry))
      .filter((entry): entry is JsonRecord => Boolean(entry));
  }
  const record = readJsonRecord(raw);
  return record ? [record] : [];
}

function structureConfidence(value: JsonRecord | null | undefined, key: string): number | null {
  const meta = readJsonRecord(value?.__meta);
  const confidenceMap = readJsonRecord(meta?.structure_confidence);
  return readNumber(confidenceMap?.[key]);
}

function hasNonEmptyStructuredFields(entry: JsonRecord): boolean {
  return Object.values(entry).some((value) => {
    if (typeof value === "string") {
      return value.trim().length > 0;
    }
    return value !== null && typeof value !== "undefined";
  });
}

function normalizeNameKey(value: string | null | undefined): string {
  return normalize(value).toLowerCase();
}

function buildUnitValue(answerValue: string | null, valueUnit: string | null): string | null {
  const value = cleanupExtractedClaim(answerValue);
  const unit = cleanupExtractedClaim(valueUnit);
  if (!value) {
    return null;
  }
  if (!unit || normalizeKey(value).includes(normalizeKey(unit))) {
    return value;
  }
  return `${value} ${unit}`;
}

function cleanSnippet(value: string): string {
  return normalize(value).replace(/\s+/gu, " ").slice(0, 220);
}

function cleanupExtractedClaim(value: string | null | undefined): string | null {
  const cleaned = normalize(value)
    .replace(/^[,:;.\-–—\s]+/u, "")
    .replace(/[,:;.\-–—\s]+$/u, "")
    .replace(/^"+|"+$/gu, "")
    .replace(/^'+|'+$/gu, "");
  return cleaned.length > 0 ? cleaned : null;
}

function cleanupStanceClaim(value: string | null | undefined): string | null {
  const cleaned = cleanupExtractedClaim(value)
    ?.replace(/\s*,\s*(?:but|and|while|though|although)\b.*$/iu, "")
    .replace(/\s+\b(?:but|and|while|though|although)\b.*$/iu, "");
  return cleanupExtractedClaim(cleaned);
}

function hasFirstPersonOwnershipCue(value: string | null | undefined): boolean {
  return /\b(?:i|me|my|mine|we|our|ours|myself|first-person)\b/iu.test(String(value ?? ""));
}

function sceneTextHasExplicitSelfOwnedUserCue(value: string | null | undefined): boolean {
  const text = String(value ?? "");
  return (
    /\buser:\s*[\s\S]{0,220}\b(?:i\b|i['’](?:m|ve|d|ll)\b|my\b|me\b|mine\b|we\b|we['’](?:re|ve|d|ll)\b|our\b)/iu.test(text) ||
    /^(?:\[[^\]]+\]\s*)?(?:i\b|i['’](?:m|ve|d|ll)\b|my\b|me\b|mine\b|we\b|we['’](?:re|ve|d|ll)\b|our\b)/iu.test(text)
  );
}

function exactDetailFamilyEvidenceStatus(params: {
  readonly spec: ExactDetailFamilySpec | null;
  readonly propertyKey?: string | null;
  readonly predicateFamily?: string | null;
  readonly supportTexts?: readonly string[];
}): SceneExactDetailPromotionDiagnostic["familyEvidenceStatus"] {
  if (!params.spec) {
    return "missing";
  }
  const propertyKey = normalizeKey(params.propertyKey);
  if (
    propertyKey &&
    (params.spec.scalarPropertyKeys.some((entry) => propertyKey.includes(normalizeKey(entry))) ||
      params.spec.scalarMatchTerms.some((entry) => propertyKey.includes(normalizeKey(entry))))
  ) {
    return "property_match";
  }
  const predicateFamily = normalizeKey(params.predicateFamily);
  if (
    predicateFamily &&
    (params.spec.eventPredicateFamilies.some((entry) => predicateFamily.includes(normalizeKey(entry))) ||
      params.spec.eventMatchTerms.some((entry) => predicateFamily.includes(normalizeKey(entry))))
  ) {
    return "predicate_match";
  }
  const supportText = normalizeKey((params.supportTexts ?? []).join(" "));
  if (supportText) {
    return "support_inferred";
  }
  return "missing";
}

function resolveSceneSelfBindingStatus(params: {
  readonly entries: readonly JsonRecord[];
  readonly normalizedSelfAliases: ReadonlySet<string>;
}): "resolved" | "ambiguous" | "missing" {
  const matched = new Set<string>();
  const competing = new Set<string>();
  let firstPersonSupport = 0;

  for (const entry of params.entries) {
    const candidateSubject = normalizeNameKey(readString(entry.candidate_subject));
    const ownershipCue = readString(entry.ownership_cue);
    if (hasFirstPersonOwnershipCue(ownershipCue)) {
      firstPersonSupport += 1;
    }
    if (candidateSubject) {
      if (params.normalizedSelfAliases.has(candidateSubject)) {
        matched.add(candidateSubject);
      } else {
        competing.add(candidateSubject);
      }
    }
  }

  if (competing.size > 0) {
    return matched.size > 0 || firstPersonSupport > 0 ? "ambiguous" : "missing";
  }
  if (matched.size > 0 || firstPersonSupport > 0) {
    return "resolved";
  }
  return "missing";
}

function evaluateOwnershipEvidence(params: {
  readonly subjectText?: string | null;
  readonly ownershipCue?: string | null;
  readonly normalizedSelfAliases: ReadonlySet<string>;
  readonly selfEntityId?: string | null;
  readonly sceneSelfBindingStatus: "resolved" | "ambiguous" | "missing";
}): {
  readonly subjectEntityId: string | null;
  readonly status: SceneExactDetailPromotionDiagnostic["ownershipEvidenceStatus"];
  readonly rejectedReason: SceneExactDetailPromotionDiagnostic["promotionRejectedReason"];
} {
  const normalizedSubject = normalizeNameKey(params.subjectText);
  if (hasFirstPersonOwnershipCue(params.ownershipCue)) {
    return {
      subjectEntityId: params.selfEntityId ?? null,
      status: "explicit_ownership_cue",
      rejectedReason: params.selfEntityId ? null : "weak_ownership_evidence"
    };
  }
  if (normalizedSubject && params.normalizedSelfAliases.has(normalizedSubject)) {
    return {
      subjectEntityId: params.selfEntityId ?? null,
      status: "explicit_self_alias",
      rejectedReason: params.selfEntityId ? null : "weak_ownership_evidence"
    };
  }
  if (params.sceneSelfBindingStatus === "resolved") {
    return {
      subjectEntityId: params.selfEntityId ?? null,
      status: "scene_self_binding",
      rejectedReason: params.selfEntityId ? null : "weak_ownership_evidence"
    };
  }
  if (params.sceneSelfBindingStatus === "ambiguous") {
    return {
      subjectEntityId: null,
      status: "ambiguous",
      rejectedReason: "ambiguous_self_binding"
    };
  }
  return {
    subjectEntityId: null,
    status: "missing",
    rejectedReason: "weak_ownership_evidence"
  };
}

function extractRegexGroup(text: string, patterns: readonly RegExp[]): string | null {
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    const extracted = cleanupExtractedClaim(match?.[1] ?? null);
    if (extracted) {
      return extracted;
    }
  }
  return null;
}

function looksSentenceLike(text: string): boolean {
  const compact = normalize(text);
  const wordCount = compact.split(/\s+/u).filter(Boolean).length;
  return (
    wordCount >= 8 ||
    /[.!?]\s/u.test(compact) ||
    /\b(?:because|while|although|however|mentioned|talked|likes|prefers|enjoys|currently|lately|usually)\b/iu.test(compact)
  );
}

function familySignalBonus(family: ExactDetailQuestionFamily, normalized: string): number {
  switch (family) {
    case "speed":
      return /\b(?:internet|network|plan)\b/u.test(normalized) && /\b(?:speed|mbps|gbps)\b/u.test(normalized) ? 4 : 0;
    case "brand":
      return /\b(?:brand|running shoes?|sneakers?)\b/u.test(normalized) ? 4 : 0;
    case "breed":
      return /\b(?:breed)\b/u.test(normalized) && /\b(?:dog|cat|pet|puppy)\b/u.test(normalized) ? 4 : 0;
    case "service_name":
      return /\b(?:service|platform|provider|subscription|streaming|music)\b/u.test(normalized) ? 4 : 0;
    case "playlist_name":
      return /\b(?:playlist|spotify|music)\b/u.test(normalized) && /\b(?:name|called|named|created)\b/u.test(normalized) ? 4 : 0;
    case "last_name":
      return /\b(?:last name|surname|maiden|former name|previous name|changed name)\b/u.test(normalized) ? 4 : 0;
    case "venue":
      return /\b(?:venue|campus|school|college|university|study abroad|program|class)\b/u.test(normalized) ? 4 : 0;
    case "certification":
      return /\b(?:certification|certificate|credential|course|program)\b/u.test(normalized) ? 4 : 0;
    case "capacity":
      return /\b(?:ram|storage|capacity|gb|tb)\b/u.test(normalized) ? 4 : 0;
    case "time_of_day":
      return /\b(?:stop|checking)\b/u.test(normalized) && /\b(?:time|emails?|messages?)\b/u.test(normalized) ? 4 : 0;
    case "duration":
      return /\b(?:duration|months?|years?|weeks?|days?)\b/u.test(normalized) ? 4 : 0;
    case "role":
      return /\b(?:role|occupation|job|title|position|worked as)\b/u.test(normalized) ? 4 : 0;
    case "shop":
      return /\b(?:shop|store|retailer|buy|bought|purchase|purchased)\b/u.test(normalized) ? 4 : 0;
    case "purchased_items":
      return /\b(?:buy|bought|purchase|purchased|gift|redeem|redeemed|coupon|thrift|action figure|item)\b/u.test(normalized) ? 4 : 0;
    case "food_drink":
      return /\b(?:food|drink|recipe|cake|rice|cocktail|bake|baked|favorite)\b/u.test(normalized) ? 4 : 0;
    case "creative_work":
      return /\b(?:play|production|performance|recipe|cocktail|book|movie|film|song|title|called|named|attended|watched|read|tried)\b/u.test(normalized) ? 4 : 0;
    case "price":
      return /\b(?:price|cost|spent|paid|purchase|purchased|bought|money|dollars?|handbag|worth)\b/u.test(normalized) ||
        /\$\s?\d[\d,.]*/u.test(normalized)
        ? 4
        : 0;
    case "stance":
      return /\b(?:stance|belief|view|opinion|position|previous|former|used to|atheist|spirituality|religion)\b/u.test(normalized) ? 4 : 0;
    case "age_at_event":
      return /\b(?:age|old|birthday|gave|gift|when)\b/u.test(normalized) ? 4 : 0;
    case "color":
      return /\b(?:color|colour|shade|paint|painted|repaint|repainted|wall|walls|gray|grey)\b/u.test(normalized) ? 4 : 0;
    case "count":
      return /\b(?:count|number|total)\b/u.test(normalized) || (/\bbikes?\b/u.test(normalized) && /\bown\b/u.test(normalized)) ? 4 : 0;
    case "pet_name":
      return (
        (/\b(?:pet|cat|dog|puppy|kitten)\b/u.test(normalized) && /\bname\b/u.test(normalized)) ||
        /\bmy\s+(?:cat|dog|pet|kitten|puppy)\s*,\s*[a-z][a-z'-]{1,30}\b/u.test(normalized)
      )
        ? 4
        : 0;
    default:
      return 0;
  }
}

function hasFamilySpecificSupportEvidence(params: {
  readonly family: ExactDetailQuestionFamily;
  readonly propertyKey?: string | null;
  readonly predicateFamily?: string | null;
  readonly valueText?: string | null;
  readonly supportPhrase?: string | null;
}): boolean {
  const normalized = normalizeKey(
    [params.propertyKey, params.predicateFamily, params.valueText, params.supportPhrase]
      .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      .join(" ")
  ).replace(/[_-]+/gu, " ");
  const evidence = normalizeKey(
    [params.valueText, params.supportPhrase]
      .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      .join(" ")
  ).replace(/[_-]+/gu, " ");
  const propertyContext = normalizeKey([params.propertyKey, params.predicateFamily].filter(Boolean).join(" ")).replace(/[_-]+/gu, " ");
  if (!normalized) {
    return false;
  }
  const hasQuantity = /\b(?:\d[\d,]*|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|eighteen|twenty)\b/u.test(normalized);
  switch (params.family) {
    case "speed":
      return (
        /\b(?:kbps|mbps|gbps|tbps|megabits?|gigabits?)\b/u.test(evidence) &&
        (/\b(?:internet|network|fiber|broadband|plan|speed)\b/u.test(evidence) || /\b(?:internet speed|plan speed|speed)\b/u.test(propertyContext))
      );
    case "capacity":
      return /\b(?:ram|storage|capacity|memory|upgrade|device|laptop|phone|gb|tb|mb)\b/u.test(normalized) && /\b\d[\d,.]*\s*(?:gb|tb|mb)\b/u.test(normalized);
    case "duration":
      return (
        /\b(?:duration|how long|for|spent|stayed|visited|traveled|travelled|collecting|move|moved|took|screen time|averag|per day|commute|each way|japan|instagram|camera)\b/u.test(evidence) &&
        /\b(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|several|a few)\s+(?:years?|months?|weeks?|days?|hours?|minutes?)\b/u.test(evidence)
      );
    case "count":
      return (
        /\b(?:\d[\d,]*|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|eighteen|twenty)\b/u.test(evidence) &&
        /\b(?:count|number|total|own|owned|have|bikes?|copies|albums?|released|caught|catch|fish|bass|packed|shirts?|items?|worldwide)\b/u.test(evidence)
      );
    case "brand":
      return /\b(?:brand|running shoes?|sneakers?|gym shoes?)\b/u.test(evidence);
    case "breed":
      return /\b(?:breed|dog|puppy|cat|kitten|pet|collar|name tag)\b/u.test(evidence);
    case "pet_name":
      return /\b(?:pet|cat|dog|puppy|kitten|name|named|called)\b/u.test(evidence);
    case "service_name":
      return /\b(?:music|streaming|listen|songs?|service|platform|app|using|use|spotify)\b/u.test(evidence);
    case "time_of_day":
      return /\b(?:stop|checking|emails?|messages?|routine|time|pm|am|morning|evening|night)\b/u.test(normalized);
    case "venue":
      return /\b(?:venue|campus|school|college|university|study abroad|program|class|wedding|ballroom|studio|gym|attend|attended|degree|undergrad|ucla|cs)\b/u.test(evidence);
    case "shop":
      return /\b(?:shop|store|retailer|buy|bought|purchase|purchased|ordered|picked up|from|coupon|redeemed?|voucher|downtown|ikea)\b/u.test(evidence);
    case "certification":
      return /\b(?:certification|certificate|credential|course|program|degree|graduated|major|bachelor|master|data science)\b/u.test(evidence);
    case "role":
      return /\b(?:role|occupation|job|title|position|worked|served|specialist|manager|engineer|designer|developer|advisor|adviser|cto)\b/u.test(evidence);
    case "purchased_items":
      return /\b(?:buy|bought|purchase|purchased|got|picked up|gift|present|birthday|thrift|action figure|dress|item)\b/u.test(evidence);
    case "food_drink":
      return /\b(?:food|drink|recipe|cake|rice|cocktail|gin|fizz|bake|baked|made|cooked|favorite|niece|party|blueberry)\b/u.test(evidence);
    case "creative_work":
      return /\b(?:play|production|performance|recipe|cocktail|gin|fizz|book|movie|film|song|title|called|named|attended|watched|read|tried|made)\b/u.test(evidence);
    case "price":
      return (
        (
          /\b(?:spent|paid|cost|price|purchase|purchased|bought|handbag|bag|item|dollars?)\b/u.test(evidence) &&
          (/\$\s?\d[\d,.]*(?:\.\d{2})?\b/u.test(evidence) || /\b\d[\d,.]*(?:\.\d{2})?\s+dollars?\b/u.test(evidence))
        ) ||
        /\bworth\s+(?:double|triple|quadruple|twice|(?:\d+|one|two|three|four|five)\s+times)\s+what\s+i\s+paid(?:\s+for\s+it)?\b/u.test(
          evidence
        )
      );
    case "stance":
      return /\b(?:stance|belief|view|opinion|position|previous|former|used to|spirituality|religion|atheist|agnostic|spiritual|religious)\b/u.test(evidence);
    case "age_at_event":
      return hasQuantity && /\b(?:age|old|birthday|grandma|grandmother|gave|gift|necklace|when)\b/u.test(evidence);
    case "color":
      return /\b(?:color|colour|shade|paint|painted|repaint|repainted|wall|walls|gray|grey|blue|green|yellow|dress)\b/u.test(normalized);
    default:
      return familySignalBonus(params.family, normalized) > 0;
  }
}

export function inferExactDetailFamilyFromSource(params: {
  readonly predicateFamily?: string | null;
  readonly propertyKey?: string | null;
  readonly valueText?: string | null;
  readonly eventKey?: string | null;
  readonly eventType?: string | null;
  readonly supportTexts?: readonly string[];
  readonly metadata?: JsonRecord | null;
}): ExactDetailQuestionFamily | null {
  const text = normalizeKey(
    [
      params.predicateFamily,
      params.propertyKey,
      params.valueText,
      params.eventKey,
      params.eventType,
      readString(params.metadata?.state_key),
      readString(params.metadata?.state_type),
      readString(params.metadata?.canonical_key),
      readString(params.metadata?.scalar_exact_family),
      ...(params.supportTexts ?? [])
    ]
      .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      .join(" ")
  );
  if (!text) {
    return null;
  }
  const explicitPropertyKey = normalizeKey(params.propertyKey);
  const explicitPredicateFamily = normalizeKey(params.predicateFamily);
  const explicitEventType = normalizeKey(params.eventType);
  if (/\b(?:music_service|service_name|subscription_service|provider|platform)\b/u.test(explicitPropertyKey)) {
    return "service_name";
  }
  if (/\b(?:pet_name|cat_name|dog_name|animal_name)\b/u.test(explicitPropertyKey)) {
    return "pet_name";
  }
  if (/\b(?:breed|pet_breed|dog_breed|cat_breed)\b/u.test(explicitPropertyKey)) {
    return "breed";
  }
  if (/\b(?:purchase_source)\b/u.test(explicitPredicateFamily) || explicitEventType === "shop") {
    return "shop";
  }
  if (/\b(?:study_location|class_location|program_location|location_history)\b/u.test(explicitPredicateFamily) || explicitEventType === "venue") {
    return "venue";
  }
  if (/\b(?:credential_completed|course_completion)\b/u.test(explicitPredicateFamily) || explicitEventType === "certification") {
    return "certification";
  }
  if (/\b(?:duration_held|time_spent|stay_duration)\b/u.test(explicitPredicateFamily) || explicitEventType === "duration") {
    return "duration";
  }
  if (/\b(?:purchase_price|amount_spent|money_amount|expense_amount|price|cost)\b/u.test(explicitPropertyKey) || /\b(?:transaction|purchase_price|amount_spent|money_amount|expense_amount)\b/u.test(explicitPredicateFamily) || explicitEventType === "price") {
    return "price";
  }
  if (/\b(?:previous_stance|former_stance|belief_stance|stance|belief|view|opinion|position)\b/u.test(explicitPropertyKey) || /\b(?:belief_history|identity_history|belief_stance)\b/u.test(explicitPredicateFamily) || explicitEventType === "stance") {
    return "stance";
  }
  if (/\b(?:purchased_item|purchase_item|gift_item)\b/u.test(explicitPredicateFamily) || explicitEventType === "item") {
    return "purchased_items";
  }
  if (/\b(?:age_at_event|event_age)\b/u.test(explicitPredicateFamily) || explicitEventType === "age") {
    return "age_at_event";
  }
  if (/\b(?:activity_count|packed_item_count|item_count|trip_count)\b/u.test(explicitPredicateFamily) || explicitEventType === "count") {
    return "count";
  }
  if (/\b(?:work_role|work_history)\b/u.test(explicitPredicateFamily) || explicitEventType === "role") {
    return "role";
  }
  if (/\b(?:creative_work|performance_title|recipe_title|media_title|play_title|cocktail_recipe)\b/u.test(explicitPropertyKey) || explicitEventType === "creative_work") {
    return "creative_work";
  }
  if (
    /\b(?:buy|bought|purchase|purchased|redeem|redeemed|coupon|discount|voucher)\b/u.test(text) &&
    /\b(?:from|at|store|shop|retailer)\b/u.test(text)
  ) {
    return "shop";
  }

  let bestFamily: ExactDetailQuestionFamily | null = null;
  let bestScore = 0;
  for (const family of TARGET_FAMILIES) {
    const spec = getExactDetailFamilySpec(family);
    if (!spec) {
      continue;
    }
    let score = familySignalBonus(family, text);
    for (const key of spec.scalarPropertyKeys) {
      if (text.includes(normalizeKey(key))) {
        score += 3;
      }
    }
    for (const term of spec.scalarMatchTerms) {
      if (text.includes(normalizeKey(term))) {
        score += 1;
      }
    }
    for (const familyKey of spec.eventPredicateFamilies) {
      if (text.includes(normalizeKey(familyKey))) {
        score += 3;
      }
    }
    for (const term of spec.eventMatchTerms) {
      if (text.includes(normalizeKey(term))) {
        score += 1;
      }
    }
    if (score > bestScore) {
      bestFamily = family;
      bestScore = score;
    }
  }

  return bestScore >= 3 ? bestFamily : null;
}

export function deriveExactDetailPropertyKey(spec: ExactDetailFamilySpec, candidates: readonly string[]): string {
  const normalizedCandidates = uniqueStrings(candidates.filter(Boolean));
  for (const candidate of normalizedCandidates) {
    const normalized = normalizeKey(candidate);
    const matchedScalar = spec.scalarPropertyKeys.find((entry) => normalized.includes(normalizeKey(entry)));
    if (matchedScalar) {
      return matchedScalar;
    }
  }
  for (const candidate of normalizedCandidates) {
    const normalized = normalizeKey(candidate);
    const matchedEvent = spec.eventPredicateFamilies.find((entry) => normalized.includes(normalizeKey(entry)));
    if (matchedEvent) {
      return matchedEvent;
    }
  }
  return spec.scalarPropertyKeys[0] ?? spec.eventPredicateFamilies[0] ?? spec.family;
}

function extractShortScalarValue(text: string, maxWords = 6): string | null {
  const cleaned = cleanupExtractedClaim(text);
  if (!cleaned) {
    return null;
  }
  const words = cleaned.split(/\s+/u).filter(Boolean);
  return !looksSentenceLike(cleaned) && words.length <= maxWords ? cleaned : null;
}

function extractTimeOfDayValue(text: string): string | null {
  const timeMatch = text.match(/\b((?:[01]?\d|2[0-3])(?::[0-5]\d)?\s*(?:a\.?m\.?|p\.?m\.?))\b/iu);
  if (timeMatch?.[1]) {
    return cleanupExtractedClaim(timeMatch[1]);
  }
  const labelMatch = text.match(/\b(noon|midnight|morning|afternoon|evening|night)\b/iu);
  return cleanupExtractedClaim(labelMatch?.[1] ?? null);
}

function extractNumericUnit(text: string, units: readonly string[]): string | null {
  const pattern = new RegExp(`\\b(\\d[\\d,.]*\\s*(?:${units.join("|")}))\\b`, "iu");
  const match = pattern.exec(text);
  return cleanupExtractedClaim(match?.[1] ?? null);
}

function trimTrailingTemporalTail(value: string): string {
  return value
    .replace(/\b(?:last|this|next)\s+(?:year|month|week|weekend|night|summer|winter|spring|fall)\b$/iu, "")
    .replace(/\b(?:yesterday|today|tomorrow)\b$/iu, "")
    .trim();
}

function cleanupStoreValue(value: string): string {
  return cleanupExtractedClaim(
    value
      .replace(/\b(?:to\s+see|before\s+buying|before\s+purchasing|and\s+i\b|and\s+i'm\b|which\s+i\b).*$/iu, "")
      .replace(/\s+(?:for|during)\s+\$?\d[\d,.]*.*$/iu, "")
      .trim()
  ) ?? value;
}

function cleanupVenueValue(value: string): string {
  return cleanupExtractedClaim(
    value
      .replace(/\s+\b(?:last|this|next)\s+(?:weekend|week|month|year|summer|spring|fall|winter)\b.*$/iu, "")
      .replace(/\s+\band\b.*$/iu, "")
      .trim()
  ) ?? value;
}

export function extractAtomicExactDetailValue(params: {
  readonly family: ExactDetailQuestionFamily;
  readonly texts: readonly string[];
}): string | null {
  for (const candidate of params.texts.map((value) => normalize(value)).filter(Boolean)) {
    switch (params.family) {
      case "shop": {
        const direct = extractShortScalarValue(candidate, 6);
        if (direct && !/\b(?:purchase|source|event|shop|store|retailer|bought|buy|purchased|from|redeem|redeemed|coupon|discount|voucher)\b/iu.test(direct)) {
          return cleanupStoreValue(direct);
        }
        const extracted = extractRegexGroup(candidate, [
          /\b(?:redeemed?|used)\b.*?\b(?:coupon|discount|voucher)\b.*?\b(?:at|from)\s+([^.;!?\n]+)/iu,
          /\b(?:coupon|discount|voucher)\b.*?\b(?:at|from)\s+([^.;!?\n]+)/iu,
          /\b(?:cartwheel|loyalty)\s+(?:app|card)?[^.;!?\n]{0,120}?\b(?:from|at)\s+(Target|[A-Z][A-Za-z0-9'&.-]+(?:\s+[A-Z][A-Za-z0-9'&.-]+){0,3})\b/iu,
          /\bshop\s+at\s+(Target|[A-Z][A-Za-z0-9'&.-]+(?:\s+[A-Z][A-Za-z0-9'&.-]+){0,3})\b/iu,
          /\b(?:bought|buy|purchased|purchase|ordered|get|got|picked up)\b.*?\bfrom\s+([^.;!?\n]+)/iu,
          /\b(?:new|my)\s+[^.;!?\n]{0,80}?\b(?:is|was|came)\s+from\s+([^.;!?\n]+)/iu,
          /\bfrom\s+([^.;!?\n]+)/iu,
          /\bat\s+([^.;!?\n]+(?:store|shop|market|retail|retailer|outlet)?[^.;!?\n]*)/iu
        ]);
        if (extracted) {
          return cleanupStoreValue(trimTrailingTemporalTail(extracted));
        }
        break;
      }
      case "venue": {
        const direct = extractShortScalarValue(candidate, 8);
        if (direct && /\b(?:university|college|school|studio|gym|ballroom|yoga|ucla|melbourne|serenity)\b/iu.test(direct)) {
          return cleanupVenueValue(direct);
        }
        const extracted = extractRegexGroup(candidate, [
          /\b(?:wedding|ceremony|reception)\b[^.;!?\n]{0,120}?\b(?:at|in)\s+((?:the\s+)?[A-Z][^.;!?\n]{0,80}?(?:Ballroom|Hall|Hotel|Venue|Center|Centre)[^.;!?\n]*)/u,
          /\b(?:undergrad|bachelor'?s?|degree)\b[^.;!?\n]{0,160}?\b(?:from|at)\s+([A-Z][A-Za-z0-9'&.-]+(?:\s+[A-Z][A-Za-z0-9'&.-]+){0,8})\b/u,
          /\b(?:attend(?:ed)?|study(?:ied)? abroad|take|took|go(?:ing)? to|went to|complete(?:d)?|graduated)\b.*?\b(?:at|in)\s+([^.;!?\n]+)/iu,
          /\b(?:at|in|from)\s+([^.;!?\n]+(?:university|college|school|campus|academy|center|centre|institute|hall|ballroom|studio|gym|ucla)[^.;!?\n]*)/iu
        ]);
        if (extracted) {
          return cleanupVenueValue(extracted);
        }
        break;
      }
      case "certification": {
        const extracted = extractRegexGroup(candidate, [
          /\bgraduated\s+with\s+(?:an?\s+)?(?:bachelor'?s?|master'?s?|doctoral|doctorate|associate'?s?)?\s*degree\s+in\s+([^,.;!?\n]+?)(?:,|\s+from\b|\s+at\b|\s+in\s+\d{4}\b|[.;!?\n]|$)/iu,
          /\b(?:completed|complete|earned|received|finished|got)\b\s+(?:an?\s+)?([A-Z][A-Za-z0-9&' -]{1,80}?)(?:\s+last\s+(?:month|week|year)|\s+in\s+\d{4}\b|[.;!?\n]|$)/u,
          /\b(?:completed|complete|earned|received|finished|got)\b\s+(?:an?\s+)?([^.;!?\n]+?(?:certification|certificate|credential|course|program|licen[cs]e|degree))/iu,
          /\b([^.;!?\n]+?(?:certification|certificate|credential|course|program|licen[cs]e|degree))/iu
        ]);
        if (extracted) {
          return extracted;
        }
        const direct = extractShortScalarValue(candidate, 6);
        if (direct && !/\b(?:certification|certificate|credential|course|program|degree|event|completed|complete|earned|received|finished|got)\b/iu.test(direct)) {
          return direct;
        }
        break;
      }
      case "duration": {
        const extracted = extractRegexGroup(candidate, [
          /\b(?:assemble|assembled|assembly|build|built|put together|bookshelf|furniture)\b[^.;!?\n]{0,140}\b(?:took|took\s+me|took\s+us|lasted)\s+(?:around|about|roughly|nearly|almost)?\s*((?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|several|a few)\s+(?:years?|months?|weeks?|days?|hours?|minutes?))\b/iu,
          /\b(?:took|took\s+me|took\s+us|lasted)\s+(?:around|about|roughly|nearly|almost)?\s*((?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|several|a few)\s+(?:years?|months?|weeks?|days?|hours?|minutes?))\b[^.;!?\n]{0,160}\b(?:assemble|assembled|assembly|build|built|put together|bookshelf|furniture)\b/iu,
          /\b(?:took|took\s+me|took\s+us|took\s+me\s+and\s+[^.;!?\n]{1,60})\s+(?:around|about|roughly|nearly|almost)?\s*((?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|several|a few)\s+(?:years?|months?|weeks?|days?|hours?|minutes?))\b[^.;!?\n]{0,120}\b(?:move|moved|apartment)\b/iu,
          /\b(?:screen\s+time|instagram)\b[^.;!?\n]{0,120}\b(?:averag(?:e|ing|ed)?|around|about|roughly)?\s*((?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|several|a few)\s+(?:hours?|minutes?))\b/iu,
          /\b(?:averag(?:e|ing|ed)?|around|about|roughly)\s*((?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|several|a few)\s+(?:hours?|minutes?))\b[^.;!?\n]{0,120}\b(?:screen\s+time|instagram)\b/iu,
          /\bcommute\b[^.;!?\n]{0,100}?\b(?:is|takes?|runs?|averages?)\s+((?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|several|a few)\s+(?:hours?|minutes?)(?:\s+each\s+way)?)/iu,
          /\b((?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|several|a few)\s+(?:hours?|minutes?)(?:\s+each\s+way)?)\b[^.;!?\n]{0,100}\bcommute\b/iu,
          /\b(?:in|around|visited|traveled|travelled|stayed\s+in)\s+(?:Japan|[A-Z][A-Za-z]+)\b[^.;!?\n]{0,120}\bfor\s+((?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|several|a few)\s+(?:years?|months?|weeks?|days?|hours?|minutes?))/iu,
          /\b(?:spent|visited|traveled|travelled)\s+((?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|several|a few)\s+(?:years?|months?|weeks?|days?|hours?|minutes?))\b[^.;!?\n]{0,160}\b(?:in|around|through|japan)\b/iu,
          /\b(?:for|about|around|almost|over|under|roughly|nearly)\s+((?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|several|a few)\s+(?:years?|months?|weeks?|days?|hours?|minutes?))/iu,
          /\b((?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|several|a few)\s+(?:years?|months?|weeks?|days?|hours?|minutes?))/iu
        ]);
        if (extracted) {
          return extracted;
        }
        break;
      }
      case "role": {
        const direct = extractShortScalarValue(candidate, 8);
        if (direct && /\b(?:specialist|manager|engineer|designer|developer|teacher|advisor|adviser|cto|role|occupation|job|title|position)\b/iu.test(direct)) {
          return direct;
        }
        const extracted = extractRegexGroup(candidate, [
          /\bprevious\s+role\s+as\s+(?:an?\s+)?([^.;!?\n]+?)(?:\s+and\b|[.;!?\n]|$)/iu,
          /\b(?:worked|working|served|serving|was|am|been)\s+(?:as|in)\s+(?:an?\s+)?([^.;!?\n]+)/iu,
          /\b(?:occupation|role|job|title|position)\s+(?:was|is)?\s*(?:an?\s+)?([^.;!?\n]+)/iu
        ]);
        if (extracted) {
          return extracted;
        }
        break;
      }
      case "count": {
        const extracted = extractRegexGroup(candidate, [
          /\b(?:packed|bring|brought|taking|took)\s+((?:\d[\d,]*|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve))\s+(?:shirts?|items?|things?)\b/iu,
          /\b((?:\d[\d,]*|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve))\s+shirts?\b[^.;!?\n]{0,120}\b(?:packed|trip|costa\s+rica|travel)\b/iu,
          /\b((?:\d[\d,]*|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|hundred|thousand))\s+copies\b[^.;!?\n]{0,120}\b(?:album|released|worldwide)\b/iu,
          /\b((?:\d[\d,]*|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve))\b/iu
        ]);
        if (extracted) {
          return extracted;
        }
        break;
      }
      case "age_at_event": {
        const extracted = extractRegexGroup(candidate, [
          /\b(?:i\s+was|was\s+i|at\s+age)\s+((?:\d[\d,]*|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty))\b/iu,
          /\b((?:\d[\d,]*|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty))\s+years?\s+old\b/iu,
          /\bon\s+my\s+((?:\d[\d,]*|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)(?:st|nd|rd|th)?)\s+birthday\b/iu,
          /\b(?:grandma|grandmother)\b[^.;!?\n]{0,120}\b(?:necklace|gift)\b[^.;!?\n]{0,120}\b(?:when\s+i\s+was|on\s+my)\s+((?:\d[\d,]*|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)(?:st|nd|rd|th)?)/iu
        ]);
        if (extracted) {
          return extracted.replace(/(?:st|nd|rd|th)$/iu, "");
        }
        break;
      }
      case "speed": {
        const extracted = extractNumericUnit(candidate, ["kbps", "mbps", "gbps", "tbps", "mb\\/s", "gb\\/s", "gigabits?", "megabits?"]);
        if (extracted) {
          return extracted;
        }
        break;
      }
      case "capacity": {
        const extracted = extractNumericUnit(candidate, ["kb", "mb", "gb", "tb"]);
        if (extracted) {
          return extracted;
        }
        break;
      }
      case "time_of_day": {
        const extracted = extractTimeOfDayValue(candidate);
        if (extracted) {
          return extracted;
        }
        break;
      }
      case "color": {
        const extracted = extractRegexGroup(candidate, [
          /\b(?:painted|repainted|paint|repaint)\b[^.;!?\n]{0,120}\b(?:walls?|bedroom)\b[^.;!?\n]{0,80}\b(?:a\s+)?((?:lighter|light|darker|dark|pale|soft|warm|cool|neutral|deep|bright|muted)\s+(?:shade\s+of\s+)?(?:gray|grey|blue|green|white|black|red|yellow|pink|purple|brown|orange))\b/iu,
          /\b(?:walls?|bedroom)\b[^.;!?\n]{0,120}\b(?:painted|repainted|paint|repaint)\b[^.;!?\n]{0,80}\b(?:a\s+)?((?:lighter|light|darker|dark|pale|soft|warm|cool|neutral|deep|bright|muted)\s+(?:shade\s+of\s+)?(?:gray|grey|blue|green|white|black|red|yellow|pink|purple|brown|orange))\b/iu,
          /\b((?:lighter|light|darker|dark|pale|soft|warm|cool|neutral|deep|bright|muted)\s+(?:shade\s+of\s+)?(?:gray|grey|blue|green|white|black|red|yellow|pink|purple|brown|orange))\b/iu,
          /\b(gray|grey|blue|green|white|black|red|yellow|pink|purple|brown|orange)\b/iu
        ]);
        if (extracted) {
          return cleanupExtractedClaim(extracted);
        }
        break;
      }
      case "service_name":
      case "playlist_name":
      case "last_name":
      case "brand":
      case "breed":
      case "pet_name": {
        if (params.family === "brand") {
          const extracted = extractRegexGroup(candidate, [
            /\b(?:favorite\s+)?running\s+shoes?\s+(?:are|is|were|brand\s+is|from|by)\s+([A-Z][A-Za-z0-9'&.-]+(?:\s+[A-Z][A-Za-z0-9'&.-]+){0,2})\b/u,
            /\b(?:favorite\s+)?running\s+shoe\s+brand\s+(?:is|was)\s+([A-Z][A-Za-z0-9'&.-]+(?:\s+[A-Z][A-Za-z0-9'&.-]+){0,2})\b/u,
            /\b(?:my\s+)?([A-Z][A-Za-z0-9'&.-]+(?:\s+[A-Z][A-Za-z0-9'&.-]+){0,2})\s+(?:are\s+)?(?:my\s+)?favorite\s+running\s+shoes?\b/u,
            /\b([A-Z][A-Za-z0-9'&.-]+(?:\s+[A-Z][A-Za-z0-9'&.-]+){0,2})\s+has\s+been\s+my\s+favo(?:u)?rite\s+brand(?:\s+so\s+far)?\s+for\s+running\s+shoes?\b/iu,
            /\bmy\s+favo(?:u)?rite\s+brand(?:\s+so\s+far)?\s+for\s+running\s+shoes?\s+has\s+been\s+([A-Z][A-Za-z0-9'&.-]+(?:\s+[A-Z][A-Za-z0-9'&.-]+){0,2})\b/iu,
            /\bexperience\s+with\s+([A-Z][A-Za-z0-9'&.-]+(?:\s+[A-Z][A-Za-z0-9'&.-]+){0,2})\b[^.;!?\n]{0,120}\b(?:gym|running|workout|training)\s+shoes?\b/u,
            /\b(?:gym|running|workout|training)\s+shoes?\b[^.;!?\n]{0,120}\b(?:experience\s+with|liked|prefer(?:red)?|from|by)\s+([A-Z][A-Za-z0-9'&.-]+(?:\s+[A-Z][A-Za-z0-9'&.-]+){0,2})\b/u
          ]);
          if (extracted) {
            return extractShortScalarValue(extracted, 5) ?? extracted;
          }
        }
        if (params.family === "breed") {
          const extracted = extractRegexGroup(candidate, [
            /\b(?:dog|puppy|cat|kitten)\s+(?:is|was|breed\s+is|is\s+a|was\s+a)\s+(?:an?\s+)?([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+){0,3})\b/u,
            /\b(?:breed\s+of\s+my\s+(?:dog|cat)\s+is)\s+(?:an?\s+)?([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+){0,3})\b/u,
            /\b(?:collar|harness|leash|name\s+tag)\b[^.;!?\n]{0,120}\b(?:suit|fit|for)\s+(?:an?\s+)?([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+){0,3})\s+(?:like|named|called)\b/u,
            /\b(?:my\s+)?(?:dog|puppy|cat|kitten)\s*,?\s+(?:an?\s+)?([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+){0,3})\b/u,
            /\b(?:my\s+)?([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+){0,3})\s+(?:dog|puppy|cat|kitten)\b/u
          ]);
          if (extracted) {
            return extractShortScalarValue(extracted, 5) ?? extracted;
          }
        }
        if (params.family === "playlist_name") {
          const extracted = extractRegexGroup(candidate, [
            /\bplaylist\s+(?:is|was|called|named)\s+["“]?([^.;!?\n"”]+)/iu,
            /\b(?:created|made|built)\s+(?:a\s+)?(?:spotify\s+)?playlist\s+(?:called|named)\s+["“]?([^.;!?\n"”]+)/iu,
            /\bplaylist\s+on\s+spotify\s+that\s+i\s+created,\s+called\s+["“]?([^,.;!?\n"”]+)/iu,
            /\b(?:my|your)\s+([^.;!?\n"”]+?)\s+playlist\b/iu
          ]);
          if (extracted) {
            return extractShortScalarValue(extracted, 6) ?? extracted;
          }
        }
        if (params.family === "last_name") {
          const extracted = extractRegexGroup(candidate, [
            /\b(?:last\s+name|surname)\s+(?:was|used\s+to\s+be|before\s+(?:i\s+)?changed\s+it\s+was)\s+([A-Z][A-Za-z'-]{1,40})\b/u,
            /\bchanged\s+(?:my\s+)?last\s+name\s+from\s+([A-Z][A-Za-z'-]{1,40})\s+to\s+[A-Z][A-Za-z'-]{1,40}\b/u,
            /\bold\s+name\s+was\s+([A-Z][A-Za-z'-]{1,40})\b/u,
            /\bfrom\s+([A-Z][A-Za-z'-]{1,40})\s+to\s+[A-Z][A-Za-z'-]{1,40}\b/u
          ]);
          if (extracted) {
            return extractShortScalarValue(extracted, 3) ?? extracted;
          }
        }
        const extracted = extractRegexGroup(candidate, [
          /\b(?:cat|dog|pet|kitten|puppy)(?:'s)?\s+name\s+(?:is|was)\s+([^.;!?\n]+)/iu,
          /\bmy\s+(?:cat|dog|pet|kitten|puppy)\s*,\s*([A-Z][A-Za-z'-]{1,30})\b/u,
          /\b(?:called|named|name is|service is|platform is|provider is|brand is|breed is)\s+([^.;!?\n]+)/iu,
          /\blisten(?:ing)?\s+to\b[^.;!?\n]{0,120}\bon\s+([^.;!?\n]+)/iu,
          /\b(?:use|using|used|listen(?:ing)? to|stream(?:ing)? on)\s+([^.;!?\n]+)/iu
        ]);
        if (extracted) {
          return extractShortScalarValue(extracted, 5) ?? extracted;
        }
        const direct = extractShortScalarValue(candidate, 5);
        if (direct) {
          return direct;
        }
        break;
      }
      case "purchased_items": {
        const direct = extractShortScalarValue(candidate, 8);
        if (direct && !/\b(?:buy|bought|purchase|purchased|gift|coupon|redeemed?|from|store|shop|thrift)\b/iu.test(direct)) {
          return direct;
        }
        const extracted = extractRegexGroup(candidate, [
          /\b(?:bought|purchased|picked up|got)\s+(?:my\s+)?sister\s+(?:an?\s+|the\s+)?([^.;!?\n]+?)(?:\s+for\s+(?:her\s+)?birthday|\s+as\s+(?:a\s+)?gift|\s+and\b|[.;!?\n]|$)/iu,
          /\b(?:bought|purchased|picked up|got)\s+(?:her\s+|him\s+|them\s+)(?:an?\s+|the\s+)?([^.;!?\n]+?)(?:\s+for\s+(?:her\s+)?birthday|\s+as\s+(?:a\s+)?gift|\s+and\b|[.;!?\n]|$)/iu,
          /\b(?:bought|purchased|picked up|got|found)\s+(?:an?\s+|the\s+|my\s+)?([^.;!?\n]+?)\s+(?:from|at|for|with|last|yesterday|today|tomorrow|on)\b/iu,
          /\b(?:for\s+my\s+[^.;!?\n]{0,40}birthday|birthday\s+gift|gift|present)\b[^.;!?\n]{0,120}\b(?:got|bought|purchased|was|is)\s+(?:her\s+|him\s+|them\s+)?(?:an?\s+|the\s+)?([^.;!?\n]+?)(?:\s+and\b|\s+to\s+match\b|[.;!?\n]|$)/iu,
          /\b(?:birthday|gift|present)\b[^.;!?\n]{0,80}\b(?:was|is|for)\s+(?:an?\s+|the\s+)?([^.;!?\n]+)/iu,
          /\b(?:type|kind)\s+of\s+([^.;!?\n]+?action figure)\b/iu
        ]);
        if (extracted) {
          return extractShortScalarValue(extracted, 8) ?? extracted;
        }
        break;
      }
      case "food_drink": {
        const direct = extractShortScalarValue(candidate, 8);
        if (direct && /\b(?:cake|rice|cocktail|gin|fizz|martini|recipe|blueberry|short-grain)\b/iu.test(direct)) {
          return direct;
        }
        const extracted = extractRegexGroup(candidate, [
          /\b(?:baked|made|tried|cooked)\s+(?:an?\s+|the\s+)?([^.;!?\n]+?cake)\b[^.;!?\n]{0,120}\b(?:niece|birthday|party)\b/iu,
          /\b(?:baked|made|tried|cooked)\s+(?:an?\s+|the\s+)?([^.;!?\n]+?(?:cake|rice|cocktail|recipe|fizz|martini))/iu,
          /\b(?:favorite|preferred)\s+(?:type\s+of\s+)?(?:rice|food|drink)\s+(?:is|was)\s+([^.;!?\n]+)/iu,
          /\bfavorite\s+([^.;!?\n]+?rice)\b/iu,
          /\b(?:type|kind)\s+of\s+(cocktail|rice|cake|[^.;!?\n]+?(?:cocktail|rice|cake))\b/iu
        ]);
        if (extracted) {
          return extractShortScalarValue(extracted, 8) ?? extracted;
        }
        break;
      }
      case "creative_work": {
        const extracted = extractRegexGroup(candidate, [
          /\b(?:production\s+of|performance\s+of|play\s+(?:called|named)?|attended\s+(?:a\s+)?(?:local\s+community\s+theater\s+)?(?:production\s+of\s+)?)\s+["“]?((?:The\s+)?[A-Z][A-Za-z0-9'’&:-]+(?:\s+[A-Z][A-Za-z0-9'’&:-]+){0,6})["”]?\b/u,
          /\b(?:tried|made|saved|mixed)\s+(?:a\s+|the\s+)?([A-Za-z][A-Za-z0-9'’& -]{2,60}?(?:cocktail|fizz|martini|recipe))\b/iu,
          /\b(?:called|named|titled)\s+["“]?([^.;!?\n"”]+)["”]?/iu
        ]);
        if (extracted) {
          return extractShortScalarValue(extracted, 8) ?? extracted;
        }
        break;
      }
      case "price": {
        const extracted = extractRegexGroup(candidate, [
          /\b(?:it'?s\s+actually\s+)?worth\s+((?:double|triple|quadruple|twice|(?:\d+|one|two|three|four|five)\s+times)\s+what\s+i\s+paid(?:\s+for\s+it)?)\b/iu,
          /\b((?:double|triple|quadruple|twice|(?:\d+|one|two|three|four|five)\s+times)\s+what\s+i\s+paid(?:\s+for\s+it)?)\b/iu,
          /\b(?:spent|paid|cost|price\s+was|purchase\s+price\s+was)\b[^.;!?\n]{0,120}\b(\$\s?\d[\d,.]*(?:\.\d{2})?|\d[\d,.]*(?:\.\d{2})?\s+dollars?)\b/iu,
          /(?:^|[^A-Za-z0-9])(\$\s?\d[\d,.]*(?:\.\d{2})?|\d[\d,.]*(?:\.\d{2})?\s+dollars?)\b[^.;!?\n]{0,120}\b(?:spent|paid|cost|buying|bought|purchased|handbag|bag|item|purchase)\b/iu,
          /\b(?:buying|bought|purchased)\b[^.;!?\n]{0,140}\b(?:for|at|pretty\s+penny\s*[-–—:]?)\s*(\$\s?\d[\d,.]*(?:\.\d{2})?|\d[\d,.]*(?:\.\d{2})?\s+dollars?)\b/iu,
          /\b(?:handbag|bag|luxury\s+items?)\b[^.;!?\n]{0,140}\b(?:for|at|pretty\s+penny\s*[-–—:]?)\s*(\$\s?\d[\d,.]*(?:\.\d{2})?|\d[\d,.]*(?:\.\d{2})?\s+dollars?)\b/iu
        ]);
        if (extracted) {
          return extracted.replace(/\$\s+/u, "$");
        }
        break;
      }
      case "stance": {
        const extracted = extractRegexGroup(candidate, [
          /\b(?:previous|former|old)\s+(?:stance|view|belief|opinion|position)\s+(?:on\s+[^.;!?\n]{1,60}\s+)?(?:was|used\s+to\s+be)\s+(?:that\s+i\s+was\s+|that\s+i\s+believed\s+|an?\s+)?([^.;!?\n]+?)(?:\s+before\b|\s+until\b|[.;!?\n]|$)/iu,
          /\b(?:stance|view|belief|opinion|position)\s+(?:on\s+[^.;!?\n]{1,60}\s+)?(?:was|is)\s+(?:that\s+i\s+was\s+|that\s+i\s+believed\s+|an?\s+)?([^.;!?\n]+?)(?:\s+before\b|\s+until\b|[.;!?\n]|$)/iu,
          /\b(?:used\s+to\s+be|formerly\s+was|previously\s+was)\s+(?:an?\s+)?([^.;!?\n]+?(?:atheist|agnostic|spiritual|religious|skeptic|sceptic|believer))\b/iu
        ]);
        if (extracted) {
          return extractShortScalarValue(cleanupStanceClaim(extracted) ?? extracted, 6) ?? cleanupStanceClaim(extracted) ?? extracted;
        }
        break;
      }
      default: {
        const direct = extractShortScalarValue(candidate, 6);
        if (direct) {
          return direct;
        }
      }
    }
  }
  return null;
}

function buildKeyRows(params: {
  readonly factTable: ExactDetailFactTable;
  readonly factRowId: string;
  readonly subjectEntityId: string | null;
  readonly family: ExactDetailQuestionFamily;
  readonly propertyKey: string | null;
  readonly truthStatus: "active" | "superseded" | "uncertain";
  readonly validFrom: string | null;
  readonly validUntil: string | null;
  readonly confidence: number | null;
  readonly valueText: string | null;
  readonly eventKey?: string | null;
  readonly supportTexts?: readonly string[];
  readonly metadata?: JsonRecord | null;
}): ExactDetailFactKeyInsertRow[] {
  const rows: ExactDetailFactKeyInsertRow[] = [];
  const addRow = (keyType: ExactDetailFactKeyType, keyText: string | null | undefined, extra: JsonRecord = {}) => {
    const cleaned = cleanupExtractedClaim(keyText);
    if (!cleaned) {
      return;
    }
    rows.push({
      factTable: params.factTable,
      factRowId: params.factRowId,
      subjectEntityId: params.subjectEntityId,
      family: params.family,
      propertyKey: params.propertyKey,
      keyType,
      keyText: cleaned,
      truthStatus: params.truthStatus,
      validFrom: params.validFrom,
      validUntil: params.validUntil,
      confidence: params.confidence,
      metadata: {
        ...(params.metadata ?? {}),
        ...extra
      }
    });
  };

  addRow("value", params.valueText, { authoritative_value: true });
  addRow("fact", params.propertyKey, { authoritative_value: false });
  addRow("event_key", params.eventKey ?? null, { authoritative_value: false });
  for (const supportText of uniqueStrings((params.supportTexts ?? []).map(cleanSnippet)).slice(0, 2)) {
    addRow("support_phrase", supportText, { authoritative_value: false });
  }
  return rows;
}

async function insertFactKeyRows(
  client: PoolClient,
  namespaceId: string,
  rows: readonly ExactDetailFactKeyInsertRow[]
): Promise<number> {
  let inserted = 0;
  for (const row of rows) {
    await client.query(
      `
        INSERT INTO exact_detail_fact_keys (
          id,
          namespace_id,
          fact_table,
          fact_row_id,
          subject_entity_id,
          exact_detail_family,
          property_key,
          key_type,
          key_text,
          normalized_key_text,
          truth_status,
          valid_from,
          valid_until,
          confidence,
          metadata
        )
        VALUES (
          $1::uuid,
          $2,
          $3,
          $4::uuid,
          $5::uuid,
          $6,
          $7,
          $8,
          $9,
          $10,
          $11,
          $12::timestamptz,
          $13::timestamptz,
          $14,
          $15::jsonb
        )
      `,
      [
        randomUUID(),
        namespaceId,
        row.factTable,
        row.factRowId,
        row.subjectEntityId,
        row.family,
        row.propertyKey,
        row.keyType,
        row.keyText,
        normalizeKey(row.keyText),
        row.truthStatus,
        row.validFrom,
        row.validUntil,
        row.confidence,
        JSON.stringify(row.metadata)
      ]
    );
    inserted += 1;
  }
  return inserted;
}

function truthStatusFromValidUntil(validUntil: string | null | undefined): "active" | "superseded" | "uncertain" {
  return validUntil ? "superseded" : "active";
}

function sourceConfidenceFromSupportCount(supportCount: number): number {
  return Math.min(0.99, 0.6 + Math.max(0, supportCount) * 0.08);
}

export function deriveSceneStructuredExactDetailRows(params: {
  readonly sceneId: string;
  readonly sceneText: string;
  readonly occurredAt: string | null;
  readonly sceneMetadata: JsonRecord | null;
  readonly selfEntityId?: string | null;
  readonly selfAliases?: readonly string[];
}): ExactDetailFactKeyInsertRow[] {
  return analyzeSceneStructuredExactDetailRows(params).rows.slice();
}

export function deriveSceneHeuristicExactDetailRows(params: {
  readonly sceneId: string;
  readonly sceneText: string;
  readonly occurredAt: string | null;
  readonly selfEntityId?: string | null;
  readonly selfAliases?: readonly string[];
}): ExactDetailFactKeyInsertRow[] {
  return analyzeSceneHeuristicExactDetailRows(params).rows.slice();
}

export function analyzeSceneHeuristicExactDetailRows(params: {
  readonly sceneId: string;
  readonly sceneText: string;
  readonly occurredAt: string | null;
  readonly selfEntityId?: string | null;
  readonly selfAliases?: readonly string[];
}): SceneStructuredExactDetailAnalysis {
  const normalizedSelfAliases = new Set((params.selfAliases ?? []).map((value) => normalizeNameKey(value)));
  const family = inferExactDetailFamilyFromSource({
    supportTexts: [params.sceneText]
  });
  const spec = family ? getExactDetailFamilySpec(family) : null;
  const valueText = family
    ? extractAtomicExactDetailValue({
        family,
        texts: [params.sceneText]
      })
    : null;
  const ownershipCue = sceneTextHasExplicitSelfOwnedUserCue(params.sceneText) ? params.sceneText : null;
  const ownershipDecision = evaluateOwnershipEvidence({
    ownershipCue,
    normalizedSelfAliases,
    selfEntityId: params.selfEntityId ?? null,
    sceneSelfBindingStatus: ownershipCue ? "resolved" : "missing"
  });

  const fallbackDiagnostic = (
    promotionRejectedReason: SceneExactDetailPromotionDiagnostic["promotionRejectedReason"],
    familyEvidenceStatus: SceneExactDetailPromotionDiagnostic["familyEvidenceStatus"],
    valueAdmissibilityStatus: SceneExactDetailPromotionDiagnostic["valueAdmissibilityStatus"]
  ): SceneStructuredExactDetailAnalysis => ({
    rows: [],
    diagnostics: [
      {
        structureKind: "raw_scene_support",
        promotionEligible: false,
        promotionRejectedReason,
        ownershipEvidenceStatus: ownershipDecision.status,
        familyEvidenceStatus,
        valueAdmissibilityStatus,
        inferredFamily: family ?? null,
        familyHint: null,
        supportPhrase: cleanSnippet(params.sceneText),
        extractorConfidence: null
      }
    ]
  });

  if (!family || !spec || !spec.selfOwned || !RAW_SCENE_SELF_OWNED_EXACT_DETAIL_FAMILIES.has(family)) {
    return EMPTY_SCENE_EXACT_DETAIL_ANALYSIS;
  }
  const familyEvidenceStatus = exactDetailFamilyEvidenceStatus({
    spec,
    supportTexts: [params.sceneText]
  });
  if (!hasFamilySpecificSupportEvidence({ family, valueText: params.sceneText, supportPhrase: params.sceneText })) {
    return fallbackDiagnostic("family_mismatch", familyEvidenceStatus, valueText ? "admissible" : "missing");
  }
  if (!valueText) {
    return fallbackDiagnostic("inadmissible_value_shape", familyEvidenceStatus, "inadmissible");
  }
  const namespaceScopedSelfOwned =
    !ownershipDecision.subjectEntityId &&
    (ownershipDecision.status === "explicit_ownership_cue" || ownershipDecision.status === "scene_self_binding");
  if (!ownershipDecision.subjectEntityId && !namespaceScopedSelfOwned) {
    return fallbackDiagnostic(ownershipDecision.rejectedReason, familyEvidenceStatus, "admissible");
  }

  return {
    rows: buildKeyRows({
      factTable: "narrative_scenes",
      factRowId: params.sceneId,
      subjectEntityId: ownershipDecision.subjectEntityId,
      family,
      propertyKey: deriveExactDetailPropertyKey(spec, [family]),
      truthStatus: "active",
      validFrom: params.occurredAt,
      validUntil: null,
      confidence: 0.72,
      valueText,
      supportTexts: [params.sceneText],
      metadata: {
        source_table: "narrative_scenes",
        source_scene_id: params.sceneId,
        scene_structure_kind: "raw_scene_support",
        authoritative_source: "active_scene_fact",
        promotion_origin: "raw_scene_heuristic",
        promotionEligible: true,
        promotionRejectedReason: null,
        ownershipEvidenceStatus: ownershipDecision.status,
        familyEvidenceStatus,
        valueAdmissibilityStatus: "admissible"
      }
    }),
    diagnostics: [
      {
        structureKind: "raw_scene_support",
        promotionEligible: true,
        promotionRejectedReason: null,
        ownershipEvidenceStatus: ownershipDecision.status,
        familyEvidenceStatus,
        valueAdmissibilityStatus: "admissible",
        inferredFamily: family,
        familyHint: null,
        supportPhrase: cleanSnippet(params.sceneText),
        extractorConfidence: null
      }
    ]
  };
}

export function analyzeSceneStructuredExactDetailRows(params: {
  readonly sceneId: string;
  readonly sceneText: string;
  readonly occurredAt: string | null;
  readonly sceneMetadata: JsonRecord | null;
  readonly selfEntityId?: string | null;
  readonly selfAliases?: readonly string[];
}): SceneStructuredExactDetailAnalysis {
  const externalIe = readJsonRecord(params.sceneMetadata?.external_relation_ie);
  if (!externalIe) {
    return { rows: [], diagnostics: [] };
  }

  const rows: ExactDetailFactKeyInsertRow[] = [];
  const diagnostics: SceneExactDetailPromotionDiagnostic[] = [];
  const normalizedSelfAliases = new Set((params.selfAliases ?? []).map((value) => normalizeNameKey(value)));
  const extractorEntries = readJsonArray(externalIe.extractors);
  for (const extractorEntry of extractorEntries) {
    const extractor = readJsonRecord(extractorEntry);
    if (!extractor || normalizeKey(readString(extractor.extractor)) !== "gliner2") {
      continue;
    }

    const classifications = readJsonRecord(extractor.classifications);
    const structures = readJsonRecord(extractor.structures);
    const familyHints = classificationValues(classifications, "exact_detail_family").filter((value) => value !== "none");
    const sourceMemoryId = readString(extractor.source_memory_id) ?? readString(externalIe.source_memory_id);
    const sourceChunkId = readString(extractor.source_chunk_id) ?? readString(externalIe.source_chunk_id);
    const extractorName = readString(extractor.extractor) ?? "gliner2";
    const modelId = readString(extractor.model_id);
    const schemaVersion = readString(extractor.schema_version);
    const relationIeMode = relationIeModeFromExtractor(extractor, externalIe);
    const selfBindingEntries = structureEntries(structures, "self_binding_support");
    const sceneSelfBindingStatus = resolveSceneSelfBindingStatus({
      entries: selfBindingEntries,
      normalizedSelfAliases
    });
    const scalarEntries = structureEntries(structures, "scalar_value_support");
    const eventEntries = structureEntries(structures, "event_value_support");

    if (relationIeMode === "support_only") {
      for (const entry of scalarEntries) {
        diagnostics.push({
          structureKind: "scalar_value_support",
          promotionEligible: false,
          promotionRejectedReason: "support_only_mode",
          ownershipEvidenceStatus: "missing",
          familyEvidenceStatus: "missing",
          valueAdmissibilityStatus: hasNonEmptyStructuredFields(entry) ? "inadmissible" : "missing",
          inferredFamily: inferExactDetailFamilyFromSource({
            propertyKey: readString(entry.property_key),
            valueText: buildUnitValue(readString(entry.answer_value), readString(entry.value_unit)),
            supportTexts: [readString(entry.support_phrase) ?? "", params.sceneText]
          }),
          familyHint: familyHints[0] ?? null,
          supportPhrase: readString(entry.support_phrase),
          extractorConfidence: structureConfidence(structures, "scalar_value_support")
        });
      }
      for (const entry of eventEntries) {
        diagnostics.push({
          structureKind: "event_value_support",
          promotionEligible: false,
          promotionRejectedReason: "support_only_mode",
          ownershipEvidenceStatus: "missing",
          familyEvidenceStatus: "missing",
          valueAdmissibilityStatus: hasNonEmptyStructuredFields(entry) ? "inadmissible" : "missing",
          inferredFamily: inferExactDetailFamilyFromSource({
            predicateFamily: readString(entry.predicate_family),
            valueText: readString(entry.object_value),
            eventKey: readString(entry.event_label),
            eventType: readString(entry.object_type),
            supportTexts: [readString(entry.support_phrase) ?? "", params.sceneText]
          }),
          familyHint: familyHints[0] ?? null,
          supportPhrase: readString(entry.support_phrase),
          extractorConfidence: structureConfidence(structures, "event_value_support")
        });
      }
      continue;
    }

    for (const entry of scalarEntries) {
      if (!hasNonEmptyStructuredFields(entry)) {
        diagnostics.push({
          structureKind: "scalar_value_support",
          promotionEligible: false,
          promotionRejectedReason: "no_structure_support",
          ownershipEvidenceStatus: "missing",
          familyEvidenceStatus: "missing",
          valueAdmissibilityStatus: "missing",
          inferredFamily: null,
          familyHint: familyHints[0] ?? null,
          supportPhrase: null,
          extractorConfidence: structureConfidence(structures, "scalar_value_support")
        });
        continue;
      }
      const family = inferExactDetailFamilyFromSource({
        propertyKey: readString(entry.property_key),
        valueText: buildUnitValue(readString(entry.answer_value), readString(entry.value_unit)),
        supportTexts: [readString(entry.support_phrase) ?? "", params.sceneText]
      });
      const spec = family ? getExactDetailFamilySpec(family) : null;
      const familyEvidenceStatus = exactDetailFamilyEvidenceStatus({
        spec,
        propertyKey: readString(entry.property_key),
        supportTexts: [readString(entry.support_phrase) ?? "", params.sceneText]
      });
      const supportPhrase = readString(entry.support_phrase);
      const rawValueText = buildUnitValue(readString(entry.answer_value), readString(entry.value_unit));
      const familySupportCompatible = family
        ? hasFamilySpecificSupportEvidence({
            family,
            propertyKey: readString(entry.property_key),
            valueText: rawValueText,
            supportPhrase
          })
        : false;
      const valueText = extractAtomicExactDetailValue({
        family: family ?? "service_name",
        texts: [rawValueText ?? "", supportPhrase ?? "", params.sceneText]
      });
      const valueAdmissibilityStatus: SceneExactDetailPromotionDiagnostic["valueAdmissibilityStatus"] = rawValueText
        ? valueText
          ? "admissible"
          : "inadmissible"
        : supportPhrase
          ? valueText
            ? "support_derived"
            : "inadmissible"
          : "missing";
      const ownershipDecision = evaluateOwnershipEvidence({
        subjectText: readString(entry.subject),
        ownershipCue: readString(entry.ownership_cue),
        normalizedSelfAliases,
        selfEntityId: params.selfEntityId ?? null,
        sceneSelfBindingStatus
      });

      if (!family || !spec || familyEvidenceStatus === "missing" || !familySupportCompatible) {
        diagnostics.push({
          structureKind: "scalar_value_support",
          promotionEligible: false,
          promotionRejectedReason:
            family && spec && familyEvidenceStatus !== "missing" && valueAdmissibilityStatus === "inadmissible"
              ? "inadmissible_value_shape"
              : "family_mismatch",
          ownershipEvidenceStatus: ownershipDecision.status,
          familyEvidenceStatus,
          valueAdmissibilityStatus,
          inferredFamily: family ?? null,
          familyHint: familyHints[0] ?? null,
          supportPhrase,
          extractorConfidence: structureConfidence(structures, "scalar_value_support")
        });
        continue;
      }
      if (valueAdmissibilityStatus === "missing" && !supportPhrase) {
        diagnostics.push({
          structureKind: "scalar_value_support",
          promotionEligible: false,
          promotionRejectedReason: "empty_support_phrase",
          ownershipEvidenceStatus: ownershipDecision.status,
          familyEvidenceStatus,
          valueAdmissibilityStatus,
          inferredFamily: family,
          familyHint: familyHints[0] ?? null,
          supportPhrase,
          extractorConfidence: structureConfidence(structures, "scalar_value_support")
        });
        continue;
      }
      if (!valueText) {
        diagnostics.push({
          structureKind: "scalar_value_support",
          promotionEligible: false,
          promotionRejectedReason: "inadmissible_value_shape",
          ownershipEvidenceStatus: ownershipDecision.status,
          familyEvidenceStatus,
          valueAdmissibilityStatus,
          inferredFamily: family,
          familyHint: familyHints[0] ?? null,
          supportPhrase,
          extractorConfidence: structureConfidence(structures, "scalar_value_support")
        });
        continue;
      }
      const namespaceScopedSelfOwned =
        !ownershipDecision.subjectEntityId &&
        (ownershipDecision.status === "explicit_ownership_cue" || ownershipDecision.status === "scene_self_binding");
      if (!ownershipDecision.subjectEntityId && !namespaceScopedSelfOwned) {
        diagnostics.push({
          structureKind: "scalar_value_support",
          promotionEligible: false,
          promotionRejectedReason: ownershipDecision.rejectedReason,
          ownershipEvidenceStatus: ownershipDecision.status,
          familyEvidenceStatus,
          valueAdmissibilityStatus,
          inferredFamily: family,
          familyHint: familyHints[0] ?? null,
          supportPhrase,
          extractorConfidence: structureConfidence(structures, "scalar_value_support")
        });
        continue;
      }
      diagnostics.push({
        structureKind: "scalar_value_support",
        promotionEligible: true,
        promotionRejectedReason: null,
        ownershipEvidenceStatus: ownershipDecision.status,
        familyEvidenceStatus,
        valueAdmissibilityStatus,
        inferredFamily: family,
        familyHint: familyHints[0] ?? null,
        supportPhrase,
        extractorConfidence: structureConfidence(structures, "scalar_value_support")
      });
      rows.push(
        ...buildKeyRows({
          factTable: "narrative_scenes",
          factRowId: params.sceneId,
          subjectEntityId: ownershipDecision.subjectEntityId,
          family,
          propertyKey: deriveExactDetailPropertyKey(spec, [readString(entry.property_key) ?? "", family]),
          truthStatus: "active",
          validFrom: params.occurredAt,
          validUntil: null,
          confidence: structureConfidence(structures, "scalar_value_support"),
          valueText,
          supportTexts: [readString(entry.support_phrase) ?? "", params.sceneText],
          metadata: {
            source_table: "narrative_scenes",
            source_scene_id: params.sceneId,
            source_memory_id: sourceMemoryId,
            source_chunk_id: sourceChunkId,
            extractor: extractorName,
            model_id: modelId,
            schema_version: schemaVersion,
            relation_ie_mode: relationIeMode,
            scene_structure_kind: "scalar_value_support",
            authoritative_source: "active_scalar_fact",
            predicate_family: readString(entry.property_key),
            support_phrase: supportPhrase,
            family_hint: familyHints[0] ?? null,
            extractor_confidence: structureConfidence(structures, "scalar_value_support"),
            promotionEligible: true,
            promotionRejectedReason: null,
            ownershipEvidenceStatus: ownershipDecision.status,
            familyEvidenceStatus,
            valueAdmissibilityStatus,
            structure_entry: entry
          }
        })
      );
    }

    for (const entry of eventEntries) {
      if (!hasNonEmptyStructuredFields(entry)) {
        diagnostics.push({
          structureKind: "event_value_support",
          promotionEligible: false,
          promotionRejectedReason: "no_structure_support",
          ownershipEvidenceStatus: "missing",
          familyEvidenceStatus: "missing",
          valueAdmissibilityStatus: "missing",
          inferredFamily: null,
          familyHint: familyHints[0] ?? null,
          supportPhrase: null,
          extractorConfidence: structureConfidence(structures, "event_value_support")
        });
        continue;
      }
      const family = inferExactDetailFamilyFromSource({
        predicateFamily: readString(entry.predicate_family),
        valueText: readString(entry.object_value),
        eventKey: readString(entry.event_label),
        eventType: readString(entry.object_type),
        supportTexts: [readString(entry.support_phrase) ?? "", params.sceneText]
      });
      const spec = family ? getExactDetailFamilySpec(family) : null;
      const familyEvidenceStatus = exactDetailFamilyEvidenceStatus({
        spec,
        predicateFamily: readString(entry.predicate_family),
        supportTexts: [readString(entry.support_phrase) ?? "", params.sceneText]
      });
      const supportPhrase = readString(entry.support_phrase);
      const rawValueText = readString(entry.object_value);
      const familySupportCompatible = family
        ? hasFamilySpecificSupportEvidence({
            family,
            predicateFamily: readString(entry.predicate_family),
            valueText: rawValueText,
            supportPhrase
          })
        : false;
      const valueText = family
        ? extractAtomicExactDetailValue({
            family,
            texts: [rawValueText ?? "", supportPhrase ?? "", params.sceneText]
          })
        : null;
      const valueAdmissibilityStatus: SceneExactDetailPromotionDiagnostic["valueAdmissibilityStatus"] = rawValueText
        ? valueText
          ? "admissible"
          : "inadmissible"
        : supportPhrase
          ? valueText
            ? "support_derived"
            : "inadmissible"
          : "missing";
      const ownershipDecision = evaluateOwnershipEvidence({
        subjectText: readString(entry.subject),
        ownershipCue: readString(entry.ownership_cue),
        normalizedSelfAliases,
        selfEntityId: params.selfEntityId ?? null,
        sceneSelfBindingStatus
      });

      if (!family || !spec || familyEvidenceStatus === "missing" || !familySupportCompatible) {
        diagnostics.push({
          structureKind: "event_value_support",
          promotionEligible: false,
          promotionRejectedReason: "family_mismatch",
          ownershipEvidenceStatus: ownershipDecision.status,
          familyEvidenceStatus,
          valueAdmissibilityStatus,
          inferredFamily: family ?? null,
          familyHint: familyHints[0] ?? null,
          supportPhrase,
          extractorConfidence: structureConfidence(structures, "event_value_support")
        });
        continue;
      }
      if (valueAdmissibilityStatus === "missing" && !supportPhrase) {
        diagnostics.push({
          structureKind: "event_value_support",
          promotionEligible: false,
          promotionRejectedReason: "empty_support_phrase",
          ownershipEvidenceStatus: ownershipDecision.status,
          familyEvidenceStatus,
          valueAdmissibilityStatus,
          inferredFamily: family,
          familyHint: familyHints[0] ?? null,
          supportPhrase,
          extractorConfidence: structureConfidence(structures, "event_value_support")
        });
        continue;
      }
      if (!valueText) {
        diagnostics.push({
          structureKind: "event_value_support",
          promotionEligible: false,
          promotionRejectedReason: "inadmissible_value_shape",
          ownershipEvidenceStatus: ownershipDecision.status,
          familyEvidenceStatus,
          valueAdmissibilityStatus,
          inferredFamily: family,
          familyHint: familyHints[0] ?? null,
          supportPhrase,
          extractorConfidence: structureConfidence(structures, "event_value_support")
        });
        continue;
      }
      const namespaceScopedSelfOwned =
        !ownershipDecision.subjectEntityId &&
        (ownershipDecision.status === "explicit_ownership_cue" || ownershipDecision.status === "scene_self_binding");
      if (!ownershipDecision.subjectEntityId && !namespaceScopedSelfOwned) {
        diagnostics.push({
          structureKind: "event_value_support",
          promotionEligible: false,
          promotionRejectedReason: ownershipDecision.rejectedReason,
          ownershipEvidenceStatus: ownershipDecision.status,
          familyEvidenceStatus,
          valueAdmissibilityStatus,
          inferredFamily: family,
          familyHint: familyHints[0] ?? null,
          supportPhrase,
          extractorConfidence: structureConfidence(structures, "event_value_support")
        });
        continue;
      }
      diagnostics.push({
        structureKind: "event_value_support",
        promotionEligible: true,
        promotionRejectedReason: null,
        ownershipEvidenceStatus: ownershipDecision.status,
        familyEvidenceStatus,
        valueAdmissibilityStatus,
        inferredFamily: family,
        familyHint: familyHints[0] ?? null,
        supportPhrase,
        extractorConfidence: structureConfidence(structures, "event_value_support")
      });
      rows.push(
        ...buildKeyRows({
          factTable: "narrative_scenes",
          factRowId: params.sceneId,
          subjectEntityId: ownershipDecision.subjectEntityId,
          family,
          propertyKey: deriveExactDetailPropertyKey(spec, [readString(entry.predicate_family) ?? "", readString(entry.object_type) ?? "", family]),
          truthStatus: "active",
          validFrom: params.occurredAt,
          validUntil: null,
          confidence: structureConfidence(structures, "event_value_support"),
          valueText,
          eventKey: readString(entry.event_label),
          supportTexts: [readString(entry.support_phrase) ?? "", params.sceneText],
          metadata: {
            source_table: "narrative_scenes",
            source_scene_id: params.sceneId,
            source_memory_id: sourceMemoryId,
            source_chunk_id: sourceChunkId,
            extractor: extractorName,
            model_id: modelId,
            schema_version: schemaVersion,
            relation_ie_mode: relationIeMode,
            scene_structure_kind: "event_value_support",
            authoritative_source: "active_event_fact",
            predicate_family: readString(entry.predicate_family),
            event_key: readString(entry.event_label),
            support_phrase: supportPhrase,
            family_hint: familyHints[0] ?? null,
            extractor_confidence: structureConfidence(structures, "event_value_support"),
            promotionEligible: true,
            promotionRejectedReason: null,
            ownershipEvidenceStatus: ownershipDecision.status,
            familyEvidenceStatus,
            valueAdmissibilityStatus,
            structure_entry: entry
          }
        })
      );
    }
  }

  return {
    rows,
    diagnostics
  };
}

export async function rebuildExactDetailFactKeysNamespaceForClient(
  client: PoolClient,
  namespaceId: string
): Promise<ExactDetailFactKeySummary> {
  await client.query("DELETE FROM exact_detail_fact_keys WHERE namespace_id = $1", [namespaceId]);

  let inserted = 0;
  const selfProfile = await loadNamespaceSelfProfileForClient(client, namespaceId);

  const stateRows = await client.query<CanonicalStateKeySourceRow>(
    `
      SELECT
        id::text,
        subject_entity_id::text,
        predicate_family,
        state_value,
        t_valid_from::text AS valid_from,
        t_valid_until::text AS valid_until,
        confidence,
        metadata
      FROM canonical_states
      WHERE namespace_id = $1
        AND subject_entity_id IS NOT NULL
    `,
    [namespaceId]
  );
  for (const row of stateRows.rows) {
    const family = inferExactDetailFamilyFromSource({
      predicateFamily: row.predicate_family,
      valueText: row.state_value,
      metadata: row.metadata
    });
    const spec = family ? getExactDetailFamilySpec(family) : null;
    if (!family || !spec || !row.subject_entity_id) {
      continue;
    }
    const propertyKey = deriveExactDetailPropertyKey(spec, [
      row.predicate_family,
      readString(row.metadata?.state_key) ?? "",
      readString(row.metadata?.canonical_key) ?? "",
      family
    ]);
    const valueText = extractAtomicExactDetailValue({
      family,
      texts: [row.state_value ?? "", readString(row.metadata?.context_text) ?? ""]
    });
    inserted += await insertFactKeyRows(
      client,
      namespaceId,
      buildKeyRows({
        factTable: "canonical_states",
        factRowId: row.id,
        subjectEntityId: row.subject_entity_id,
        family,
        propertyKey,
        truthStatus: truthStatusFromValidUntil(row.valid_until),
        validFrom: row.valid_from,
        validUntil: row.valid_until,
        confidence: row.confidence,
        valueText,
        metadata: {
          source_table: readString(row.metadata?.source_table) ?? "canonical_states",
          predicate_family: row.predicate_family,
          row_metadata: row.metadata ?? {}
        }
      })
    );
  }

  const factRows = await client.query<CanonicalFactKeySourceRow>(
    `
      SELECT
        id::text,
        subject_entity_id::text,
        predicate_family,
        object_value,
        t_valid_from::text AS valid_from,
        t_valid_until::text AS valid_until,
        CASE support_strength WHEN 'strong' THEN 0.95 WHEN 'moderate' THEN 0.8 ELSE 0.65 END AS confidence,
        metadata
      FROM canonical_facts
      WHERE namespace_id = $1
        AND subject_entity_id IS NOT NULL
        AND object_value IS NOT NULL
    `,
    [namespaceId]
  );
  for (const row of factRows.rows) {
    const family = inferExactDetailFamilyFromSource({
      predicateFamily: row.predicate_family,
      valueText: row.object_value,
      metadata: row.metadata
    });
    const spec = family ? getExactDetailFamilySpec(family) : null;
    if (!family || !spec || !row.subject_entity_id) {
      continue;
    }
    const propertyKey = deriveExactDetailPropertyKey(spec, [
      row.predicate_family,
      readString(row.metadata?.canonical_key) ?? "",
      readString(row.metadata?.state_key) ?? "",
      family
    ]);
    const valueText = extractAtomicExactDetailValue({
      family,
      texts: [row.object_value ?? "", readString(row.metadata?.context_text) ?? ""]
    });
    inserted += await insertFactKeyRows(
      client,
      namespaceId,
      buildKeyRows({
        factTable: "canonical_facts",
        factRowId: row.id,
        subjectEntityId: row.subject_entity_id,
        family,
        propertyKey,
        truthStatus: truthStatusFromValidUntil(row.valid_until),
        validFrom: row.valid_from,
        validUntil: row.valid_until,
        confidence: row.confidence,
        valueText,
        metadata: {
          source_table: "canonical_facts",
          predicate_family: row.predicate_family,
          row_metadata: row.metadata ?? {}
        }
      })
    );
  }

  const temporalRows = await client.query<TemporalEventKeySourceRow>(
    `
      SELECT
        tef.id::text,
        tef.subject_entity_id::text,
        tef.predicate_family,
        tef.event_key,
        tef.event_type,
        tef.object_value,
        tef.truth_status,
        tef.valid_from::text,
        tef.valid_until::text,
        tef.support_count,
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
    `,
    [namespaceId]
  );
  for (const row of temporalRows.rows) {
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
    if (!family || !spec || !row.subject_entity_id) {
      continue;
    }
    const propertyKey = deriveExactDetailPropertyKey(spec, [
      row.predicate_family ?? "",
      row.event_key,
      row.event_type ?? "",
      family
    ]);
    const valueText = extractAtomicExactDetailValue({
      family,
      texts: [row.object_value ?? "", ...supportTexts]
    });
    inserted += await insertFactKeyRows(
      client,
      namespaceId,
      buildKeyRows({
        factTable: "temporal_event_facts",
        factRowId: row.id,
        subjectEntityId: row.subject_entity_id,
        family,
        propertyKey,
        truthStatus: row.truth_status,
        validFrom: row.valid_from,
        validUntil: row.valid_until,
        confidence: sourceConfidenceFromSupportCount(row.support_count),
        valueText,
        eventKey: row.event_key,
        supportTexts,
        metadata: {
          source_table: "temporal_event_facts",
          predicate_family: row.predicate_family,
          event_key: row.event_key,
          event_type: row.event_type,
          support_count: row.support_count,
          row_metadata: row.metadata ?? {}
        }
      })
    );
  }

  const projectionRows = await client.query<ProjectionEntryKeySourceRow>(
    `
      SELECT
        cpe.id::text,
        cph.subject_entity_id::text,
        cpe.normalized_property_key,
        cpe.display_value,
        cpe.truth_status,
        cpe.valid_from::text,
        cpe.valid_until::text,
        cpe.source_confidence,
        cph.authoritative_source,
        cph.query_family,
        cpe.metadata
      FROM contract_projection_entries cpe
      INNER JOIN contract_projection_heads cph
        ON cph.id = cpe.projection_head_id
      WHERE cpe.namespace_id = $1
        AND cph.contract_name = 'value_slot'
        AND cph.projection_kind = 'scalar'
        AND cph.subject_entity_id IS NOT NULL
    `,
    [namespaceId]
  );
  for (const row of projectionRows.rows) {
    const family = inferExactDetailFamilyFromSource({
      propertyKey: row.normalized_property_key,
      valueText: row.display_value,
      metadata: row.metadata
    });
    const spec = family ? getExactDetailFamilySpec(family) : null;
    if (!family || !spec || !row.subject_entity_id) {
      continue;
    }
    const propertyKey = deriveExactDetailPropertyKey(spec, [row.normalized_property_key ?? "", family]);
    const valueText = extractAtomicExactDetailValue({
      family,
      texts: [row.display_value]
    });
    inserted += await insertFactKeyRows(
      client,
      namespaceId,
      buildKeyRows({
        factTable: "contract_projection_entries",
        factRowId: row.id,
        subjectEntityId: row.subject_entity_id,
        family,
        propertyKey,
        truthStatus: row.truth_status,
        validFrom: row.valid_from,
        validUntil: row.valid_until,
        confidence: row.source_confidence,
        valueText,
        metadata: {
          source_table: "contract_projection_entries",
          authoritative_source: row.authoritative_source,
          query_family: row.query_family,
          row_metadata: row.metadata ?? {}
        }
      })
    );
  }

  const sceneRows = await client.query<NarrativeSceneKeySourceRow>(
    `
      SELECT
        id::text,
        scene_text,
        occurred_at::text,
        metadata
      FROM narrative_scenes
      WHERE namespace_id = $1
    `,
    [namespaceId]
  );
  for (const row of sceneRows.rows) {
    const selfAliases = selfProfile ? [selfProfile.canonicalName, ...selfProfile.aliases] : [];
    const structuredAnalysis =
      readJsonRecord(row.metadata?.external_relation_ie) !== null
        ? analyzeSceneStructuredExactDetailRows({
            sceneId: row.id,
            sceneText: row.scene_text,
            occurredAt: row.occurred_at,
            sceneMetadata: row.metadata,
            selfEntityId: selfProfile?.entityId ?? null,
            selfAliases
          })
        : EMPTY_SCENE_EXACT_DETAIL_ANALYSIS;
    const heuristicAnalysis =
      structuredAnalysis.rows.length === 0
        ? analyzeSceneHeuristicExactDetailRows({
            sceneId: row.id,
            sceneText: row.scene_text,
            occurredAt: row.occurred_at,
            selfEntityId: selfProfile?.entityId ?? null,
            selfAliases
          })
        : EMPTY_SCENE_EXACT_DETAIL_ANALYSIS;
    const sceneRowsToInsert = [...structuredAnalysis.rows, ...heuristicAnalysis.rows];
    const sceneDiagnostics = [...structuredAnalysis.diagnostics, ...heuristicAnalysis.diagnostics];
    inserted += await insertFactKeyRows(client, namespaceId, sceneRowsToInsert);
    await client.query(
      `
        UPDATE narrative_scenes
        SET metadata = jsonb_set(
          COALESCE(metadata, '{}'::jsonb),
          '{external_relation_ie,promotion_review}',
          $2::jsonb,
          true
        ),
        updated_at = now()
        WHERE id = $1
      `,
      [
        row.id,
        JSON.stringify({
          updated_at: new Date().toISOString(),
          promoted_row_count: sceneRowsToInsert.length,
          rejected_count: sceneDiagnostics.filter((entry) => !entry.promotionEligible).length,
          diagnostics: sceneDiagnostics
        })
      ]
    );
  }

  return {
    namespaceId,
    rows: inserted
  };
}

export async function rebuildExactDetailFactKeysNamespace(
  namespaceId: string
): Promise<ExactDetailFactKeySummary> {
  return withTransaction((client) => rebuildExactDetailFactKeysNamespaceForClient(client, namespaceId));
}
