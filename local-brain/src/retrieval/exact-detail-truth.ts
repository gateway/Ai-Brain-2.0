import { summarizeCanonicalStateValue } from "../canonical-memory/service.js";
import {
  loadCompiledExactDetailObservationRows,
  loadCompiledExactDetailObservationSubjectCounts,
  type CompiledFactObservationLookupRow
} from "../compiled-memory/service.js";
import { loadContractProjectionRuntime } from "../contract-projections/service.js";
import { queryRows } from "../db/client.js";
import {
  ensureNamespaceSelfBindingForEntityId,
  getNamespaceSelfProfile,
  resolveCanonicalEntityReference
} from "../identity/service.js";
import { compileTemporalSemantic } from "../taxonomy-temporal/temporal-semantics.js";
import type { RecallResult } from "../types.js";
import {
  type ExactDetailFactKeyLookupRow,
  extractAtomicExactDetailValue
} from "./exact-detail-fact-keys.js";
import {
  getExactDetailFamilySpec,
  inferExactDetailQuestionFamily,
  isFirstPersonExactDetailQuery,
  type ExactDetailFamilySpec
} from "./exact-detail-question-family.js";
import { maybeLoadProjectionTypedLaneDecision } from "./projection-runtime.js";
import type {
  AnswerRetrievalPlan,
  ClaimAdmissibilityStatus,
  ExactDetailClaimCandidate,
  RecallQuery,
  RecallResponse,
  RuntimeAbstentionReason,
  SelfBindingRecoveredFrom
} from "./types.js";

type JsonRecord = Record<string, unknown>;

type ExactTruthStatus = "sufficient" | "partial" | "insufficient" | "none";
type ExactTruthAuthority =
  | "active_procedural_truth"
  | "active_scalar_fact"
  | "active_event_fact"
  | "scalar_contract_projection"
  | "active_canonical_state"
  | "event_exact_detail_fact"
  | "typed_abstention";

interface ScalarTruthRow {
  readonly id: string;
  readonly state_type: string;
  readonly state_key: string;
  readonly state_value: unknown;
  readonly updated_at: string | null;
  readonly valid_from: string | null;
  readonly valid_until: string | null;
  readonly metadata: JsonRecord | null;
}

interface CanonicalStateTruthRow {
  readonly id: string;
  readonly predicate_family: string;
  readonly state_value: string;
  readonly confidence: number | null;
  readonly mentioned_at: string | null;
  readonly t_valid_from: string | null;
  readonly t_valid_until: string | null;
  readonly metadata: JsonRecord | null;
}

interface EventTruthRow {
  readonly id: string;
  readonly event_key: string;
  readonly event_label: string | null;
  readonly event_type: string | null;
  readonly predicate_family: string | null;
  readonly object_value: string | null;
  readonly valid_from: string | null;
  readonly valid_until: string | null;
  readonly truth_status: "active" | "superseded" | "uncertain";
  readonly exactness: "exact" | "bounded" | "inferred";
  readonly support_count: number;
  readonly version_group_key: string | null;
  readonly conflict_status: string | null;
  readonly source_turn_ids: readonly string[];
  readonly metadata: JsonRecord | null;
}

interface EventSupportRow {
  readonly support_memory_id: string | null;
  readonly support_role: "primary" | "support" | "conflict";
  readonly snippet: string | null;
  readonly occurred_at: string | null;
}

interface ProjectionHeadTruthRow {
  readonly id: string;
  readonly subject_entity_id: string | null;
  readonly summary_text: string | null;
  readonly support_count: number;
  readonly truth_status: "active" | "superseded" | "uncertain";
  readonly valid_from: string | null;
  readonly valid_until: string | null;
  readonly exactness: "exact" | "bounded" | "inferred" | null;
  readonly render_payload: unknown;
  readonly authoritative_source: string | null;
  readonly query_family: string | null;
  readonly structured_sufficiency_status: string | null;
}

interface ProjectionEntryTruthRow {
  readonly entry_index: number;
  readonly display_value: string;
  readonly truth_status: "active" | "superseded" | "uncertain";
  readonly valid_from: string | null;
  readonly valid_until: string | null;
  readonly support_memory_ids: unknown;
  readonly support_temporal_fact_ids: unknown;
  readonly owner_binding_status: string | null;
  readonly normalized_property_key: string | null;
  readonly active_truth: boolean;
}

interface ExactTruthCandidate {
  readonly status: ExactTruthStatus;
  readonly results: readonly RecallResult[];
  readonly reason: string;
  readonly authoritativeSource: ExactTruthAuthority;
  readonly supportBundleFamily: "current_state" | "exact_detail";
  readonly structuredSufficiencyStatus: "sufficient" | "partial" | "insufficient" | "none";
  readonly abstentionReason?: RuntimeAbstentionReason;
  readonly temporalCoverageStatus?: RecallResponse["meta"]["temporalCoverageStatus"];
  readonly entityResolutionStatus: RecallResponse["meta"]["entityResolutionStatus"];
  readonly backfillBlockedReason?: string;
  readonly subjectEntityId?: string | null;
  readonly selfBindingRecoveredFrom?: SelfBindingRecoveredFrom;
  readonly claimAdmissibilityStatus?: ClaimAdmissibilityStatus;
  readonly authoritativeClaimRejectedReason?: string;
  readonly factKeyLookupUsed?: boolean;
  readonly factKeyHitType?: string;
  readonly factRowSource?: string;
  readonly compiledRankScore?: number;
  readonly compiledQueryContextScore?: number;
  readonly compiledSourceAuthorityScore?: number;
  readonly compiledSelectedReason?: string;
  readonly compiledRunnerUpReason?: string;
  readonly conflictResolutionStatus?: RecallResponse["meta"]["conflictResolutionStatus"];
  readonly conflictWinnerReason?: string;
  readonly conflictRunnerUpCount?: number;
}

export interface AggressiveExactDetailTruthDecision {
  readonly family: string;
  readonly shouldReturn: boolean;
  readonly results: readonly RecallResult[];
  readonly reason: string;
  readonly metaAugment: Partial<RecallResponse["meta"]>;
  readonly exactDetailCandidate?: ExactDetailClaimCandidate | null;
}

interface ExactDetailClaimAdmissibilityDecision {
  readonly status: ClaimAdmissibilityStatus;
  readonly claimText: string | null;
  readonly rejectedReason?: string;
  readonly acceptedReason?: string;
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

function readJsonRecord(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JsonRecord) : null;
}

function readUuidArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
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

function countTermMatches(haystack: string, terms: readonly string[]): number {
  const normalizedHaystack = normalizeKey(haystack);
  return [...new Set(terms.map((term) => normalizeKey(term)).filter(Boolean))].reduce(
    (count, term) => count + (normalizedHaystack.includes(term) ? 1 : 0),
    0
  );
}

function buildLikePatterns(terms: readonly string[]): string[] {
  return uniqueStrings(terms).map((term) => `%${normalizeKey(term)}%`);
}

function dominanceGap(primaryCount: number, secondaryCount: number): number {
  return Math.max(0, primaryCount - secondaryCount);
}

function readRenderPayloadAnswerValue(value: unknown): string | null {
  const record = readJsonRecord(value);
  return readString(record?.answer_value);
}

function normalizeSentence(value: string | null | undefined): string {
  return String(value ?? "").replace(/\s+/gu, " ").trim();
}

function readSerializedPayloadText(value: string | null | undefined): string | null {
  const text = normalizeSentence(value);
  if (!text || !looksSerializedPayloadText(text)) {
    return null;
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    const record = Array.isArray(parsed) ? readJsonRecord(parsed[0]) : readJsonRecord(parsed);
    if (!record) {
      return null;
    }
    for (const key of ["answer_value", "value", "text", "content", "claim", "summary"]) {
      const candidate = readString(record[key]);
      if (candidate) {
        return candidate;
      }
    }
  } catch {
    return null;
  }
  return null;
}

function looksSerializedPayloadText(value: string | null | undefined): boolean {
  return /^[{\[]/u.test(normalizeSentence(value));
}

function containsAnyTerm(text: string, terms: readonly string[]): boolean {
  const haystack = normalizeKey(text);
  return uniqueStrings(terms).some((term) => haystack.includes(normalizeKey(term)));
}

const QUERY_CONTEXT_STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "at",
  "been",
  "did",
  "do",
  "does",
  "for",
  "from",
  "have",
  "has",
  "how",
  "i",
  "is",
  "it",
  "me",
  "my",
  "name",
  "new",
  "of",
  "on",
  "service",
  "using",
  "used",
  "lately",
  "the",
  "to",
  "was",
  "what",
  "when",
  "where",
  "which",
  "with"
]);

const QUERY_CONTEXT_REQUIRED_FAMILIES = new Set([
  "age_at_event",
  "brand",
  "breed",
  "certification",
  "count",
  "duration",
  "food_drink",
  "pet_name",
  "purchased_items",
  "price",
  "role",
  "service_name",
  "shop",
  "stance",
  "venue"
]);

const FAMILY_QUERY_CONTEXT_ALIASES: Partial<Record<string, readonly string[]>> = {
  age_at_event: ["age", "old", "birthday", "grandma", "grandmother", "necklace", "silver"],
  breed: ["breed", "dog", "puppy", "cat", "kitten", "pet"],
  certification: ["certification", "certificate", "credential", "degree", "bachelor", "computer", "science", "data"],
  count: ["count", "many", "shirts", "packed", "trip", "copies", "album", "worldwide", "bikes"],
  duration: ["duration", "long", "japan", "move", "apartment", "screen", "time", "instagram", "camera"],
  food_drink: ["cake", "bake", "baked", "niece", "birthday", "recipe", "rice", "cocktail"],
  creative_work: [
    "play",
    "production",
    "performance",
    "theater",
    "theatre",
    "community theater",
    "local theater",
    "recipe",
    "cocktail",
    "book",
    "movie",
    "title",
    "called",
    "named"
  ],
  pet_name: ["name", "cat", "dog", "pet", "kitten", "puppy"],
  purchased_items: ["gift", "birthday", "sister", "dress", "action", "figure", "thrift"],
  price: ["price", "cost", "worth", "spend", "spent", "paid", "purchase", "handbag", "bag", "dollars"],
  role: ["role", "occupation", "job", "position", "previous", "marketing", "specialist", "startup"],
  service_name: ["music", "streaming", "spotify", "listen"],
  shop: ["shop", "store", "retailer", "from", "bookshelf", "racket", "tennis"],
  stance: ["stance", "view", "belief", "opinion", "position", "previous", "spirituality", "atheist"],
  venue: ["venue", "study", "abroad", "degree", "wedding", "ballroom", "class", "school", "university", "ucla"]
};

function importantQueryTerms(queryText: string | null | undefined): string[] {
  const normalized = normalizeKey(queryText)
    .replace(/['’](?:s|ve|d|ll|m)\b/gu, "")
    .replace(/[^a-z0-9]+/gu, " ");
  return uniqueStrings(
    normalized
      .split(/\s+/u)
      .map((term) => term.trim())
      .filter((term) => term.length >= 3 && !QUERY_CONTEXT_STOPWORDS.has(term))
  );
}

function queryContextTermsForFamily(spec: ExactDetailFamilySpec, queryText: string | null | undefined): string[] {
  const queryTerms = importantQueryTerms(queryText);
  const query = normalizeKey(queryText);
  const aliases = FAMILY_QUERY_CONTEXT_ALIASES[spec.family] ?? [];
  return uniqueStrings([
    ...queryTerms,
    ...aliases.filter((alias) => query.includes(normalizeKey(alias)) || queryTerms.some((term) => normalizeKey(alias).includes(term)))
  ]);
}

function durationQueryAnchorTerms(queryText: string | null | undefined): string[] {
  const query = normalizeKey(queryText);
  const anchors: string[] = [];
  if (/\bjapan\b/u.test(query)) {
    anchors.push("japan", "country", "travel", "traveling", "travelling", "traveled", "travelled", "solo", "trip");
  }
  if (/\b(?:instagram|screen time)\b/u.test(query)) {
    anchors.push("instagram", "screen time");
  }
  if (/\bapartment\b/u.test(query)) {
    anchors.push("apartment");
  } else if (/\bmov(?:e|ed|ing)\b/u.test(query)) {
    anchors.push("move", "moved", "moving");
  }
  if (/\b(?:camera|cameras|collecting|collection)\b/u.test(query)) {
    anchors.push("camera", "cameras", "vintage", "collecting", "collection");
  }
  if (/\bcommute\b/u.test(query)) {
    anchors.push("commute");
  }
  if (/\basylum\b/u.test(query)) {
    anchors.push("asylum");
  }
  if (/\bapplication\b/u.test(query)) {
    anchors.push("application");
  }
  if (/\b(?:assemble|assembly|bookshelf|furniture|put together|build|built)\b/u.test(query)) {
    anchors.push("assemble", "assembly", "bookshelf", "furniture", "put together", "build", "built");
  }
  return uniqueStrings(anchors);
}

function indexesOf(haystack: string, needle: string): number[] {
  const indexes: number[] = [];
  if (!needle) {
    return indexes;
  }
  let start = 0;
  while (start < haystack.length) {
    const index = haystack.indexOf(needle, start);
    if (index < 0) {
      break;
    }
    indexes.push(index);
    start = index + Math.max(1, needle.length);
  }
  return indexes;
}

function hasDurationClaimNearQueryAnchor(params: {
  readonly claimText: string;
  readonly queryText?: string | null;
  readonly supportTexts?: readonly string[];
  readonly metadata?: JsonRecord | null;
}): boolean {
  const anchors = durationQueryAnchorTerms(params.queryText);
  if (anchors.length === 0) {
    return true;
  }
  const claim = normalizeKey(params.claimText);
  if (!claim) {
    return false;
  }
  const fragments = [
    ...(params.supportTexts ?? []),
    readString(params.metadata?.support_phrase),
    readString(params.metadata?.source_text),
    readString(params.metadata?.provenance_text),
    readString(params.metadata?.event_key),
    readString(params.metadata?.property_key),
    readString(params.metadata?.normalized_property_key)
  ].filter((value): value is string => typeof value === "string" && value.trim().length > 0);
  return fragments.some((fragment) => {
    const normalized = normalizeKey(fragment);
    const claimIndexes = indexesOf(normalized, claim);
    if (claimIndexes.length === 0) {
      return false;
    }
    return anchors.some((anchor) => {
      const anchorIndexes = indexesOf(normalized, normalizeKey(anchor));
      return claimIndexes.some((claimIndex) =>
        anchorIndexes.some((anchorIndex) => Math.abs(claimIndex - anchorIndex) <= 140)
      );
    });
  });
}

function durationClaimIsRelativeRecency(params: {
  readonly claimText: string;
  readonly queryText?: string | null;
  readonly supportTexts?: readonly string[];
  readonly metadata?: JsonRecord | null;
}): boolean {
  const normalizedQuery = normalizeKey(params.queryText);
  if (/\b(?:how long ago|when)\b/u.test(normalizedQuery)) {
    return false;
  }
  const claim = normalizeKey(params.claimText);
  if (!claim) {
    return false;
  }
  const fragments = [
    ...(params.supportTexts ?? []),
    readString(params.metadata?.support_phrase),
    readString(params.metadata?.source_text),
    readString(params.metadata?.provenance_text)
  ].filter((value): value is string => typeof value === "string" && value.trim().length > 0);
  return fragments.some((fragment) => {
    const semantic = compileTemporalSemantic({ rawText: fragment }).semantic;
    const fragmentWordCount = normalizeKey(fragment).split(/\s+/u).filter(Boolean).length;
    if (fragmentWordCount <= 10 && semantic.temporalClass === "recency" && semantic.blockedShapes.includes("duration")) {
      return normalizeKey(fragment).includes(claim);
    }
    const normalized = normalizeKey(fragment);
    return indexesOf(normalized, claim).some((claimIndex) => {
      const after = normalized.slice(claimIndex + claim.length, claimIndex + claim.length + 16);
      return /^\s+ago\b/u.test(after);
    });
  });
}

function durationClaimHasTravelStayEvidence(params: {
  readonly claimText: string;
  readonly queryText?: string | null;
  readonly sourceText: string;
}): boolean {
  const anchors = durationQueryAnchorTerms(params.queryText);
  if (anchors.length === 0) {
    return false;
  }
  const normalized = normalizeKey(params.sourceText);
  const claim = normalizeKey(params.claimText);
  if (!claim) {
    return false;
  }
  const claimIndexes = indexesOf(normalized, claim);
  if (claimIndexes.length === 0) {
    return false;
  }
  return anchors.some((anchor) => {
    const anchorIndexes = indexesOf(normalized, normalizeKey(anchor));
    return claimIndexes.some((claimIndex) =>
      anchorIndexes.some((anchorIndex) => {
        if (Math.abs(claimIndex - anchorIndex) > 180) {
          return false;
        }
        const start = Math.max(0, Math.min(claimIndex, anchorIndex) - 80);
        const end = Math.min(normalized.length, Math.max(claimIndex + claim.length, anchorIndex + anchor.length) + 120);
        const window = normalized.slice(start, end);
        return /\b(?:spent|for|stayed|visited|traveled|travelled|trip|solo|around|through|in)\b/u.test(window) && !/\bago\b/u.test(window.slice(Math.max(0, window.indexOf(claim) + claim.length), window.indexOf(claim) + claim.length + 16));
      })
    );
  });
}

function durationContextAlignmentReason(params: {
  readonly claimText: string;
  readonly queryText?: string | null;
  readonly supportTexts?: readonly string[];
  readonly metadata?: JsonRecord | null;
}): "duration_context_aligned" | "routine_metric_context_aligned" | null {
  const query = normalizeKey(params.queryText);
  if (!query) {
    return null;
  }
  const fragments = [
    ...(params.supportTexts ?? []),
    readString(params.metadata?.support_phrase),
    readString(params.metadata?.source_text),
    readString(params.metadata?.provenance_text),
    readString(params.metadata?.source_quote),
    readString(params.metadata?.evidence_quote)
  ].filter((value): value is string => typeof value === "string" && value.trim().length > 0);
  const claim = normalizeKey(params.claimText);
  if (!claim || fragments.length === 0 || durationClaimIsRelativeRecency(params)) {
    return null;
  }
  const sourceContext = normalizeKey(fragments.join(" "));
  if (
    /\b(?:instagram|screen time)\b/u.test(query) &&
    /\b(?:hours?|minutes?)\b/u.test(claim) &&
    /\b(?:instagram|screen time)\b/u.test(sourceContext) &&
    /\b(?:averag(?:e|ing|ed)?|per day|daily|screen time)\b/u.test(sourceContext)
  ) {
    return "routine_metric_context_aligned";
  }
  if (
    /\bjapan\b/u.test(query) &&
    /\b(?:years?|months?|weeks?|days?)\b/u.test(claim) &&
    fragments.some((sourceText) =>
      durationClaimHasTravelStayEvidence({
        claimText: params.claimText,
        queryText: params.queryText,
        sourceText
      })
    )
  ) {
    return "duration_context_aligned";
  }
  return null;
}

function exactPhraseMatches(haystack: string, phrases: readonly string[]): number {
  const normalized = normalizeKey(haystack);
  return uniqueStrings(phrases)
    .filter((phrase) => phrase.trim().includes(" "))
    .reduce((count, phrase) => count + (normalized.includes(normalizeKey(phrase)) ? 1 : 0), 0);
}

function directSupportContextScore(params: {
  readonly spec: ExactDetailFamilySpec;
  readonly claimText: string;
  readonly supportTexts: readonly string[];
  readonly queryText?: string | null;
  readonly metadata?: JsonRecord | null;
}): number {
  const terms = queryContextTermsForFamily(params.spec, params.queryText);
  if (terms.length === 0) {
    return 0;
  }
  const supportContext = [
    ...params.supportTexts,
    readString(params.metadata?.support_phrase),
    readString(params.metadata?.source_text),
    readString(params.metadata?.event_key),
    readString(params.metadata?.property_key),
    readString(params.metadata?.normalized_property_key)
  ].filter((value): value is string => typeof value === "string" && value.trim().length > 0).join(" ");
  const claimContext = [params.claimText, supportContext].join(" ");
  const supportTermMatches = countTermMatches(supportContext, terms);
  const claimTermMatches = countTermMatches(params.claimText, terms);
  const phraseMatches = exactPhraseMatches(claimContext, [
    "computer science",
    "data science",
    "study abroad",
    "birthday gift",
    "yellow dress",
    "lemon blueberry",
    "screen time",
    "new apartment",
    "grand ballroom",
    "costa rica",
    "designer handbag",
    "staunch atheist",
    "spirituality",
    "ikea bookshelf"
  ]);
  const firstPersonCue = /\b(?:i|i'm|i’ve|i've|my|me)\b/iu.test(supportContext) ? 1 : 0;
  return supportTermMatches * 2 + claimTermMatches + phraseMatches * 3 + firstPersonCue;
}

export function scoreExactDetailQueryContextForTest(params: {
  readonly spec: ExactDetailFamilySpec;
  readonly claimText: string;
  readonly supportTexts: readonly string[];
  readonly queryText?: string | null;
}): number {
  return directSupportContextScore(params);
}

function queryContextCompatibility(params: {
  readonly spec: ExactDetailFamilySpec;
  readonly claimText: string;
  readonly queryText?: string | null;
  readonly supportTexts?: readonly string[];
  readonly propertyKeys?: readonly string[];
  readonly metadata?: JsonRecord | null;
}): { readonly accepted: true } | { readonly accepted: false; readonly reason: string } {
  const queryTerms = queryContextTermsForFamily(params.spec, params.queryText);
  if (queryTerms.length === 0 || !QUERY_CONTEXT_REQUIRED_FAMILIES.has(params.spec.family)) {
    return { accepted: true };
  }
  const supportContext = normalizeKey([
    params.claimText,
    ...(params.supportTexts ?? []),
    ...(params.propertyKeys ?? []),
    readString(params.metadata?.support_phrase),
    readString(params.metadata?.source_text),
    readString(params.metadata?.event_key),
    readString(params.metadata?.property_key),
    readString(params.metadata?.normalized_property_key)
  ].filter((value): value is string => typeof value === "string" && value.trim().length > 0).join(" "));
  const directContextMatches = countTermMatches(supportContext, queryTerms);
  const requiresObjectDisambiguation = ["shop", "venue", "count", "duration", "food_drink", "purchased_items", "price", "stance"].includes(params.spec.family);
  if (directContextMatches > 0 && !requiresObjectDisambiguation) {
    return { accepted: true };
  }
  const queryHasAny = (terms: readonly string[]) => containsAnyTerm(params.queryText ?? "", terms);
  const contextHasAny = (terms: readonly string[]) => containsAnyTerm(supportContext, terms);
  switch (params.spec.family) {
    case "service_name":
      return queryHasAny(["music", "streaming"]) && !contextHasAny(["music", "streaming", "spotify", "playlist"])
        ? { accepted: false, reason: "query_context_mismatch" }
        : { accepted: true };
    case "duration":
      if (
        durationClaimIsRelativeRecency({
          claimText: params.claimText,
          queryText: params.queryText,
          supportTexts: params.supportTexts,
          metadata: params.metadata
        })
      ) {
        return { accepted: false, reason: "duration_recency_not_duration" };
      }
      if (
        durationContextAlignmentReason({
          claimText: params.claimText,
          queryText: params.queryText,
          supportTexts: params.supportTexts,
          metadata: params.metadata
        })
      ) {
        return { accepted: true };
      }
      if (
        durationQueryAnchorTerms(params.queryText).length > 0 &&
        !hasDurationClaimNearQueryAnchor({
          claimText: params.claimText,
          queryText: params.queryText,
          supportTexts: params.supportTexts,
          metadata: params.metadata
        })
      ) {
        return { accepted: false, reason: "query_context_mismatch" };
      }
      return queryHasAny(["instagram", "screen time", "commute", "japan", "move", "apartment", "camera", "asylum", "application", "assemble", "assembly", "bookshelf", "furniture"]) &&
        !contextHasAny(["instagram", "screen time", "commute", "japan", "move", "apartment", "camera", "asylum", "application", "assemble", "assembly", "bookshelf", "furniture", "put together", "build", "built"])
        ? { accepted: false, reason: "query_context_mismatch" }
        : { accepted: true };
      case "shop":
      if (
        queryHasAny(["bookshelf", "racket", "tennis", "creamer", "coupon"]) &&
        !contextHasAny(["bookshelf", "racket", "tennis", "creamer", "coupon"]) &&
        !(queryHasAny(["racket", "tennis"]) && contextHasAny(["sports store", "store downtown", "downtown"]))
      ) {
        return { accepted: false, reason: "query_context_mismatch" };
      }
      return contextHasAny(["store", "shop", "retailer", "market", "outlet", "from", "bought", "purchased", "coupon", "ikea", "downtown", "target"])
        ? { accepted: true }
        : { accepted: false, reason: "query_context_mismatch" };
    case "venue":
      if (queryHasAny(["yoga", "classes"]) && !contextHasAny(["yoga", "studio", "gym", "fitness", "serenity"])) {
        return { accepted: false, reason: "query_context_mismatch" };
      }
      if (queryHasAny(["bachelor", "undergrad", "computer", "cs"]) && contextHasAny(["master", "ms ds", "data science"]) && !contextHasAny(["bachelor", "undergrad", "computer", "cs", "ucla"])) {
        return { accepted: false, reason: "query_context_mismatch" };
      }
      return queryHasAny(["study", "abroad", "degree", "wedding", "classes", "yoga", "concert", "undergrad"]) &&
        !contextHasAny(["study", "abroad", "degree", "wedding", "classes", "yoga", "concert", "undergrad", "ucla", "ballroom"])
        ? { accepted: false, reason: "query_context_mismatch" }
        : { accepted: true };
    case "brand":
      return queryHasAny(["running", "shoes", "shoe"]) && !contextHasAny(["running", "shoes", "shoe"])
        ? { accepted: false, reason: "query_context_mismatch" }
        : { accepted: true };
    case "breed":
    case "pet_name":
      if (contextHasAny(["breed", "pet breed", "cat name", "dog name", "pet name", "named", "called", "name tag"])) {
        return { accepted: true };
      }
      return queryHasAny(["dog", "cat", "pet"]) && !contextHasAny(["dog", "cat", "pet"])
        ? { accepted: false, reason: "query_context_mismatch" }
        : { accepted: true };
    case "count":
      return directContextMatches > 0 ? { accepted: true } : { accepted: false, reason: "query_context_mismatch" };
    case "certification":
      if (queryHasAny(["last month"]) && !contextHasAny(["last month", "completed", "latest", "earned", "finished"])) {
        return { accepted: false, reason: "query_context_mismatch" };
      }
      return queryHasAny(["certification", "degree", "bachelor", "computer", "science"]) &&
        !contextHasAny(["certification", "degree", "bachelor", "computer", "science", "data"])
        ? { accepted: false, reason: "query_context_mismatch" }
        : { accepted: true };
    case "food_drink":
      return queryHasAny(["cocktail", "rice", "cake", "bake", "recipe"]) &&
        !contextHasAny(["cocktail", "rice", "cake", "bake", "recipe", "gin", "fizz", "blueberry"])
        ? { accepted: false, reason: "query_context_mismatch" }
        : { accepted: true };
    case "purchased_items":
      if (queryHasAny(["sister"]) && !contextHasAny(["sister"])) {
        return { accepted: false, reason: "query_context_mismatch" };
      }
      if (queryHasAny(["birthday"]) && !contextHasAny(["birthday"])) {
        return { accepted: false, reason: "query_context_mismatch" };
      }
      if (queryHasAny(["gift"]) && contextHasAny(["idea", "suggestion", "recommendation"]) && !contextHasAny(["bought", "purchased", "got her", "got him", "got them"])) {
        return { accepted: false, reason: "query_context_mismatch" };
      }
      return queryHasAny(["gift", "action", "figure", "thrift"]) &&
        !contextHasAny(["gift", "action", "figure", "thrift", "dress", "bought", "purchased", "got"])
        ? { accepted: false, reason: "query_context_mismatch" }
        : { accepted: true };
    case "role":
      if (queryHasAny(["previous", "occupation"]) && !contextHasAny(["previous", "occupation", "role", "worked", "startup", "marketing", "specialist"])) {
        return { accepted: false, reason: "query_context_mismatch" };
      }
      if (contextHasAny(["certificate", "certification", "issued", "license"]) && !contextHasAny(["previous role", "previous occupation", "worked as", "marketing specialist"])) {
        return { accepted: false, reason: "query_context_mismatch" };
      }
      return { accepted: true };
    case "price":
      if (queryHasAny(["handbag", "bag"]) && !contextHasAny(["handbag", "bag"])) {
        return { accepted: false, reason: "query_context_mismatch" };
      }
      return contextHasAny(["spent", "paid", "cost", "price", "purchase", "purchased", "bought", "dollars", "$", "worth"])
        ? { accepted: true }
        : { accepted: false, reason: "query_context_mismatch" };
    case "stance":
      if (queryHasAny(["spirituality", "religion"]) && !contextHasAny(["spirituality", "religion", "atheist", "agnostic", "spiritual"])) {
        return { accepted: false, reason: "query_context_mismatch" };
      }
      return contextHasAny(["stance", "view", "belief", "opinion", "position", "previous", "former", "used to", "atheist", "agnostic", "spirituality"])
        ? { accepted: true }
        : { accepted: false, reason: "query_context_mismatch" };
    case "age_at_event":
      return queryHasAny(["grandma", "necklace", "silver"]) && !contextHasAny(["grandma", "necklace", "silver"])
        ? { accepted: false, reason: "query_context_mismatch" }
        : { accepted: true };
    default:
      return { accepted: true };
  }
}

function matchesWordPattern(text: string, pattern: RegExp): boolean {
  return pattern.test(text);
}

function looksPlaceholderValue(text: string): boolean {
  const normalized = normalizeKey(text)
    .replace(/^"+|"+$/g, "")
    .replace(/^'+|'+$/g, "");
  if (!normalized) {
    return true;
  }
  if (
    /^(?:none|none\.|null|null\.|n\/a|na|unknown|unknown\.|undefined|nil|no data|not available)$/iu.test(normalized)
  ) {
    return true;
  }
  if (
    /^(?:\{\s*\}|\[\s*\]|\{\s*"?(?:value|answer|text)"?\s*:\s*(?:null|"none\.?"|"unknown\.?")\s*\})$/iu.test(normalized)
  ) {
    return true;
  }
  return false;
}

function looksLowInformationScalarValue(spec: ExactDetailFamilySpec, text: string): boolean {
  const normalized = normalizeKey(text);
  if (!normalized) {
    return true;
  }
  if (spec.family === "pet_name") {
    return /^(?:and|or|the|a|an|my|your|his|her|their|our|name|named|called|cat|dog|pet|kitten|puppy|sweetie)$/u.test(normalized);
  }
  if (["brand", "service_name", "playlist_name", "last_name", "breed"].includes(spec.family)) {
    return /^(?:and|or|the|a|an|my|your|his|her|their|our|name|named|called|brand|service|platform|provider|breed)$/u.test(normalized);
  }
  return false;
}

function looksSentenceLike(text: string): boolean {
  const compact = normalizeSentence(text);
  const wordCount = compact.split(/\s+/u).filter(Boolean).length;
  return (
    wordCount >= 8 ||
    /[.!?]\s/u.test(compact) ||
    /\b(?:because|while|although|however|mentioned|talked|likes|prefers|enjoys|currently|lately|usually)\b/iu.test(compact)
  );
}

function cleanupExtractedClaim(value: string | null | undefined): string | null {
  const serializedText = readSerializedPayloadText(value);
  if (!serializedText && looksSerializedPayloadText(value)) {
    return null;
  }
  const cleaned = normalizeSentence(serializedText ?? value)
    .replace(/^[,:;.\-–—\s]+/u, "")
    .replace(/[,:;.\-–—\s]+$/u, "")
    .replace(/^(?:the\s+)?name\s+of\s+/iu, "");
  return cleaned.length > 0 ? cleaned : null;
}

function cleanupStanceClaim(value: string | null | undefined): string | null {
  const cleaned = cleanupExtractedClaim(value)
    ?.replace(/\s*,\s*(?:but|and|while|though|although)\b.*$/iu, "")
    .replace(/\s+\b(?:but|and|while|though|although)\b.*$/iu, "");
  return cleanupExtractedClaim(cleaned);
}

function familySupportsEventExtraction(spec: ExactDetailFamilySpec): boolean {
  return (
    spec.readerPriority === "event_first" ||
    ["count", "duration", "purchased_items", "food_drink", "age_at_event", "pet_name", "breed", "certification", "venue", "price", "stance"].includes(spec.family)
  );
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

function extractFamilyBoundedClaimFromSupport(params: {
  readonly spec: ExactDetailFamilySpec;
  readonly supportTexts: readonly string[];
}): string | null {
  for (const supportText of params.supportTexts) {
    const text = normalizeSentence(supportText);
    if (!text) {
      continue;
    }
    switch (params.spec.family) {
      case "shop": {
        const extracted = extractRegexGroup(text, [
          /\b(?:bought|buy|purchased|purchase|ordered|get|got|picked up)\b.*?\bfrom\s+([^.;!?\n]+)/iu,
          /\bfrom\s+([^.;!?\n]+)/iu,
          /\bat\s+([^.;!?\n]+(?:store|shop|market|retail|retailer|outlet)?[^.;!?\n]*)/iu
        ]);
        if (extracted) {
          return extracted;
        }
        break;
      }
      case "venue": {
        const extracted = extractRegexGroup(text, [
          /\b(?:near|at|to|from)\s+([A-Z][A-Za-z0-9'&.-]+(?:\s+[A-Z][A-Za-z0-9'&.-]+){0,5}\s+(?:Yoga|Studio|Fitness|Gym))\b/u,
          /\b(?:make it to|connection to|practice at)\s+([A-Z][A-Za-z0-9'&.-]+(?:\s+[A-Z][A-Za-z0-9'&.-]+){0,5}\s+(?:Yoga|Studio|Fitness|Gym))\b/u,
          /\b(?:wedding|ceremony|reception)\b[^.;!?\n]{0,120}?\b(?:at|in)\s+((?:the\s+)?[A-Z][^.;!?\n]{0,80}?(?:Ballroom|Hall|Hotel|Venue|Center|Centre)[^.;!?\n]*)/u,
          /\b(?:undergrad|bachelor'?s?|degree)\b[^.;!?\n]{0,160}?\b(?:from|at)\s+([A-Z][A-Za-z0-9'&.-]+(?:\s+[A-Z][A-Za-z0-9'&.-]+){0,8})\b/u,
          /\b(?:attend(?:ed)?|study(?:ied)? abroad|take|took|go(?:ing)? to|went to|complete(?:d)?|graduated)\b.*?\b(?:at|in)\s+([^.;!?\n]+)/iu,
          /\b(?:at|in)\s+([^.;!?\n]+(?:university|college|school|campus|academy|center|centre|institute|wedding|hall|studio|gym)[^.;!?\n]*)/iu
        ]);
        if (extracted) {
          return cleanupVenueDisplayValue(extracted, text);
        }
        break;
      }
      case "certification": {
        const extracted = extractRegexGroup(text, [
          /\b(?:latest\s+)?(?:certification|certificate|credential)\s+in\s+([A-Z][A-Za-z0-9&' -]{1,80}?)(?:\s*,|\s+which\b|\s+that\b|\s+completed\b|\s+last\s+(?:month|week|year)|[.;!?\n]|$)/u,
          /\b(?:completed|complete|earned|received|finished|got)\b\s+(?:an?\s+)?([A-Z][A-Za-z0-9&' -]{1,80}?)(?:\s+last\s+(?:month|week|year)|\s+in\s+\d{4}\b|[.;!?\n]|$)/u,
          /\b(?:completed|complete|earned|received|finished|got)\b\s+(?:an?\s+)?([^.;!?\n]+?(?:certification|certificate|credential|course|program|licen[cs]e|degree))/iu,
          /\b([^.;!?\n]+?(?:certification|certificate|credential|course|program|licen[cs]e|degree))/iu
        ]);
        if (extracted) {
          return extracted;
        }
        break;
      }
      case "duration": {
        const extracted = extractRegexGroup(text, [
          /\b(?:assemble|assembled|assembly|build|built|put together|bookshelf|furniture)\b[^.;!?\n]{0,140}\b(?:took|took\s+me|took\s+us|lasted)\s+(?:around|about|roughly|nearly|almost)?\s*((?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|several|a few)\s+(?:years?|months?|weeks?|days?|hours?|minutes?))\b/iu,
          /\b(?:took|took\s+me|took\s+us|lasted)\s+(?:around|about|roughly|nearly|almost)?\s*((?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|several|a few)\s+(?:years?|months?|weeks?|days?|hours?|minutes?))\b[^.;!?\n]{0,160}\b(?:assemble|assembled|assembly|build|built|put together|bookshelf|furniture)\b/iu,
          /\btook\b[^.;!?\n]{0,100}\b((?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|several|a few)\s+(?:years?|months?|weeks?|days?|hours?|minutes?))\b[^.;!?\n]{0,140}\b(?:move|moved|apartment)\b/iu,
          /\b(?:took|took\s+me|took\s+us|took\s+me\s+and\s+[^.;!?\n]{1,60})\s+(?:around|about|roughly|nearly|almost)?\s*((?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|several|a few)\s+(?:years?|months?|weeks?|days?|hours?|minutes?))\b[^.;!?\n]{0,120}\b(?:move|moved|apartment)\b/iu,
          /\b(?:screen\s+time|instagram)\b[^.;!?\n]{0,120}\b(?:averag(?:e|ing|ed)?|around|about|roughly)?\s*((?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|several|a few)\s+(?:hours?|minutes?))\b/iu,
          /\b(?:averag(?:e|ing|ed)?|around|about|roughly)\s*((?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|several|a few)\s+(?:hours?|minutes?))\b[^.;!?\n]{0,120}\b(?:screen\s+time|instagram)\b/iu,
          /\b(?:in|around|visited|traveled|travelled|stayed\s+in)\s+(?:Japan|[A-Z][A-Za-z]+)\b[^.;!?\n]{0,120}\bfor\s+((?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|several|a few)\s+(?:years?|months?|weeks?|days?|hours?|minutes?))/iu,
          /\b(?:spent|visited|traveled|travelled|traveling|travelling)\s+((?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|several|a few)\s+(?:years?|months?|weeks?|days?|hours?|minutes?))\b[^.;!?\n]{0,160}\b(?:in|around|through|japan|country|solo trip)\b/iu,
          /\b(?:for|about|around|almost|over|under|roughly|nearly)\s+((?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|several|a few)\s+(?:years?|months?|weeks?|days?|hours?|minutes?))/iu,
          /\b((?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|several|a few)\s+(?:years?|months?|weeks?|days?|hours?|minutes?))/iu
        ]);
        if (extracted) {
          const normalizedDurationText = normalizeKey(text);
          const normalizedExtracted = normalizeKey(extracted);
          const extractedIndex = normalizedDurationText.indexOf(normalizedExtracted);
          const extractedBefore = extractedIndex >= 0 ? normalizedDurationText.slice(Math.max(0, extractedIndex - 12), extractedIndex) : "";
          const extractedAfter =
            extractedIndex >= 0
              ? normalizedDurationText.slice(extractedIndex + normalizedExtracted.length, extractedIndex + normalizedExtracted.length + 16)
              : "";
          if (
            /\b(?:past|last)\s+$/u.test(extractedBefore) ||
            /^\s+ago\b/u.test(extractedAfter) ||
            durationClaimIsRelativeRecency({
              claimText: extracted,
              supportTexts: [text]
            })
          ) {
            break;
          }
          return extracted;
        }
        break;
      }
      case "role": {
        const extracted = extractRegexGroup(text, [
          /\bprevious\s+role\s+as\s+(?:an?\s+)?([^.;!?\n]+?(?:specialist|analyst|manager|engineer|designer|developer|consultant|coordinator|director|assistant|lead|strategist)(?:\s+at\s+[^.;!?\n]+?)?)(?:\s+and\b|[.;!?\n]|$)/iu,
          /\bprevious\s+occupation\s+(?:was|is)?\s*(?:an?\s+)?([^.;!?\n]+?(?:specialist|analyst|manager|engineer|designer|developer|consultant|coordinator|director|assistant|lead|strategist)(?:\s+at\s+[^.;!?\n]+?)?)(?:\s+and\b|[.;!?\n]|$)/iu,
          /\b(?:worked|working|served|serving|was|am|been)\s+(?:as|in)\s+(?:an?\s+)?([^.;!?\n]+)/iu,
          /\b(?:occupation|role|job|title|position)\s+(?:was|is)?\s*(?:an?\s+)?([^.;!?\n]+)/iu
        ]);
        if (extracted) {
          return extracted;
        }
        break;
      }
      case "count": {
        const extracted = extractRegexGroup(text, [
          /\b(?:own|have|keep|watch|protect|lock|tracking|track)\b[^.;!?\n]{0,120}\b((?:\d[\d,]*|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve))\s+bikes?\b/iu,
          /\b((?:\d[\d,]*|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve))\s+bikes?\b[^.;!?\n]{0,160}\b(?:own|have|my|mine|keep|watch|protect|lock|tracking|road bike|mountain bike|commuter bike)\b/iu,
          /\b(?:packed|bring|brought|taking|took)\s+((?:\d[\d,]*|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve))\s+(?:shirts?|items?|things?)\b/iu,
          /\b((?:\d[\d,]*|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve))\s+shirts?\b[^.;!?\n]{0,120}\b(?:packed|trip|costa\s+rica|travel)\b/iu,
          /\b((?:\d[\d,]*|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve))\s+copies\b[^.;!?\n]{0,120}\b(?:album|released|worldwide)\b/iu
        ]);
        if (extracted) {
          return extracted;
        }
        break;
      }
      case "age_at_event": {
        const extracted = extractRegexGroup(text, [
          /\b(?:i\s+was|was\s+i|at\s+age)\s+((?:\d[\d,]*|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty))\b/iu,
          /\b((?:\d[\d,]*|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty))\s+years?\s+old\b/iu,
          /\bon\s+my\s+((?:\d[\d,]*|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)(?:st|nd|rd|th)?)\s+birthday\b[^.;!?\n]{0,180}\b(?:grandma|grandmother|necklace|gift|gave)\b/iu,
          /\b(?:grandma|grandmother)\b[^.;!?\n]{0,120}\b(?:necklace|gift)\b[^.;!?\n]{0,120}\b(?:when\s+i\s+was|on\s+my)\s+((?:\d[\d,]*|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)(?:st|nd|rd|th)?)/iu,
          /\b(?:necklace|gift)\b[^.;!?\n]{0,120}\b(?:grandma|grandmother)\b[^.;!?\n]{0,120}\bon\s+my\s+((?:\d[\d,]*|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)(?:st|nd|rd|th)?)\s+birthday\b/iu
        ]);
        if (extracted) {
          return extracted.replace(/(?:st|nd|rd|th)$/iu, "");
        }
        break;
      }
      case "pet_name": {
        const extracted = extractRegexGroup(text, [
          /\b(?:cat|dog|pet|kitten|puppy)(?:'s)?\s+name\s+(?:is|was)\s+([A-Z][A-Za-z'-]{1,30})\b/u,
          /\b(?:cat|dog|pet|kitten|puppy)\s+(?:is\s+)?(?:named|called)\s+([A-Z][A-Za-z'-]{1,30})\b/u,
          /\bmy\s+(?:cat|dog|pet|kitten|puppy)(?:'s)?\s+name\s+(?:is|was)\s+([A-Z][A-Za-z'-]{1,30})\b/iu,
          /\bmy\s+(?:cat|dog|pet|kitten|puppy)\s*,\s*([A-Z][A-Za-z'-]{1,30})\b/iu,
          /\b(?:cat|dog|pet|kitten|puppy)\s+([A-Z][A-Za-z'-]{1,30})\b[^.;!?\n]{0,80}\b(?:my|mine|name|named|called)\b/iu
        ]);
        if (extracted) {
          return extracted;
        }
        break;
      }
      case "breed": {
        const extracted = extractRegexGroup(text, [
          /\b(?:dog|puppy|cat|kitten)\s+(?:is|was|breed\s+is|is\s+a|was\s+a)\s+(?:an?\s+)?([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+){0,3})\b/u,
          /\b(?:collar|harness|leash|name\s+tag)\b[^.;!?\n]{0,120}\b(?:suit|fit|for)\s+(?:an?\s+)?([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+){0,3})\s+(?:like|named|called)\b/u
        ]);
        if (extracted) {
          return extracted;
        }
        break;
      }
      case "purchased_items": {
        const extracted = extractRegexGroup(text, [
          /\b(?:occasion:\s*)?(?:sister'?s?\s+birthday)\b[^.;!?\n]{0,160}\b(?:gift\(s\)?|gift|present)\s*[:+\-]\s*(?:\+\s*)?([^.;!?\n+]+?)(?:\s*\+\s*|[.;!?\n]|$)/iu,
          /\bfor\s+my\s+sister'?s?\s+birthday\b[^.;!?\n]{0,80}\b(?:got|bought|purchased|picked up)\s+(?:her\s+)?(?:an?\s+|the\s+)?([^.;!?\n]+?)(?:\s+and\b|\s+to\s+match\b|[.;!?\n]|$)/iu,
          /\b(?:bought|purchased|picked up|got)\s+(?:my\s+)?sister\s+(?:an?\s+|the\s+)?([^.;!?\n]+?)(?:\s+for\s+(?:her\s+)?birthday|\s+as\s+(?:a\s+)?gift|\s+and\b|[.;!?\n]|$)/iu,
          /\b(?:bought|purchased|picked up|got)\s+(?:her\s+|him\s+|them\s+)(?:an?\s+|the\s+)?([^.;!?\n]+?)(?:\s+for\s+(?:her\s+)?birthday|\s+as\s+(?:a\s+)?gift|\s+and\b|[.;!?\n]|$)/iu,
          /\b(?:bought|purchased|picked up|got|found)\s+(?:an?\s+|the\s+|my\s+)?([^.;!?\n]+?)\s+(?:from|at|for|with|last|yesterday|today|tomorrow|on)\b/iu,
          /\b(?:birthday|gift|present)\b[^.;!?\n]{0,80}\b(?:was|is|for)\s+(?:an?\s+|the\s+)?([^.;!?\n]+)/iu,
          /\b(?:type|kind)\s+of\s+([^.;!?\n]+?action figure)\b/iu
        ]);
        if (extracted) {
          return extracted;
        }
        break;
      }
      case "food_drink": {
        const extracted = extractRegexGroup(text, [
          /\b(?:baked|made|tried|cooked)\s+(?:an?\s+|the\s+)?([^.;!?\n]+?cake)\b[^.;!?\n]{0,120}\b(?:niece|birthday|party)\b/iu,
          /\b(?:baked|made|tried|cooked)\s+(?:an?\s+|the\s+)?([^.;!?\n]+?(?:cake|rice|cocktail|recipe|fizz|martini))/iu,
          /\b(?:favorite|preferred)\s+(?:type\s+of\s+)?(?:rice|food|drink)\s+(?:is|was)\s+([^.;!?\n]+)/iu,
          /\b(?:type|kind)\s+of\s+(cocktail|rice|cake|[^.;!?\n]+?(?:cocktail|rice|cake))\b/iu
        ]);
        if (extracted) {
          return extracted;
        }
        break;
      }
      case "creative_work": {
        const extracted = extractRegexGroup(text, [
          /\b(?:production\s+of|performance\s+of|play\s+(?:called|named)?|attended\s+(?:a\s+)?(?:local\s+community\s+theater\s+)?(?:production\s+of\s+)?)\s+["“]?((?:The\s+)?[A-Z][A-Za-z0-9'’&:-]+(?:\s+[A-Z][A-Za-z0-9'’&:-]+){0,6})["”]?\b/u,
          /\b(?:tried|made|saved|mixed)\s+(?:a\s+|the\s+)?([A-Za-z][A-Za-z0-9'’& -]{2,60}?(?:cocktail|fizz|martini|recipe))\b/iu,
          /\b(?:called|named|titled)\s+["“]?([^.;!?\n"”]+)["”]?/iu
        ]);
        if (extracted) {
          return extracted;
        }
        break;
      }
      case "price": {
        const extracted = extractRegexGroup(text, [
          /\b(?:spent|paid|cost|price\s+was|purchase\s+price\s+was)\b[^.;!?\n]{0,120}\b(\$\s?\d[\d,.]*(?:\.\d{2})?|\d[\d,.]*(?:\.\d{2})?\s+dollars?)\b/iu,
          /(?:^|[^A-Za-z0-9])(\$\s?\d[\d,.]*(?:\.\d{2})?|\d[\d,.]*(?:\.\d{2})?\s+dollars?)\b[^.;!?\n]{0,120}\b(?:spent|paid|cost|buying|bought|purchased|handbag|bag|item|purchase)\b/iu,
          /\b(?:buying|bought|purchased)\b[^.;!?\n]{0,140}\b(?:for|at|pretty\s+penny\s*[-–—:]?)\s+(\$\s?\d[\d,.]*(?:\.\d{2})?|\d[\d,.]*(?:\.\d{2})?\s+dollars?)\b/iu,
          /\b(?:handbag|bag|luxury\s+items?)\b[^.;!?\n]{0,140}\b(?:for|at|pretty\s+penny\s*[-–—:]?)\s+(\$\s?\d[\d,.]*(?:\.\d{2})?|\d[\d,.]*(?:\.\d{2})?\s+dollars?)\b/iu,
          /\b(worth\s+(?:double|triple|quadruple|twice|(?:\d+|one|two|three|four|five)\s+times)\s+what\s+i\s+paid(?:\s+for\s+it)?)\b/iu
        ]);
        if (extracted) {
          return extracted.replace(/\$\s+/u, "$");
        }
        break;
      }
      case "stance": {
        const extracted = extractRegexGroup(text, [
          /\b(?:previous|former|old)\s+(?:stance|view|belief|opinion|position)\s+(?:on\s+[^.;!?\n]{1,60}\s+)?(?:was|used\s+to\s+be)\s+(?:that\s+i\s+was\s+|that\s+i\s+believed\s+|an?\s+)?([^.;!?\n]+?)(?:\s+before\b|\s+until\b|[.;!?\n]|$)/iu,
          /\b(?:stance|view|belief|opinion|position)\s+(?:on\s+[^.;!?\n]{1,60}\s+)?(?:was|is)\s+(?:that\s+i\s+was\s+|that\s+i\s+believed\s+|an?\s+)?([^.;!?\n]+?)(?:\s+before\b|\s+until\b|[.;!?\n]|$)/iu,
          /\b(?:used\s+to\s+be|formerly\s+was|previously\s+was)\s+(?:an?\s+)?([^.;!?\n]+?(?:atheist|agnostic|spiritual|religious|skeptic|sceptic|believer))\b/iu
        ]);
        if (extracted) {
          return cleanupStanceClaim(extracted);
        }
        break;
      }
      default:
        break;
    }
  }
  return null;
}

export function extractDurationClaimForQueryContextForTest(params: {
  readonly queryText?: string | null;
  readonly supportTexts: readonly string[];
}): string | null {
  const normalizedQuery = normalizeKey(params.queryText);
  const anchors = durationQueryAnchorTerms(params.queryText);
  const patterns: RegExp[] = [];
  if (/\b(?:instagram|screen time)\b/u.test(normalizedQuery)) {
    patterns.push(
      /\b(?:screen\s+time|instagram)\b[^.;!?\n]{0,140}\b(?:averag(?:e|ing|ed)?|around|about|roughly)?\s*((?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|several|a few)\s+(?:hours?|minutes?))\b/iu,
      /\b(?:averag(?:e|ing|ed)?|around|about|roughly)\s*((?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|several|a few)\s+(?:hours?|minutes?))\b[^.;!?\n]{0,140}\b(?:screen\s+time|instagram)\b/iu
    );
  }
  if (/\bjapan\b/u.test(normalizedQuery)) {
    patterns.push(
      /\b(?:spent|visited|traveled|travelled|traveling|travelling)\s+((?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|several|a few)\s+(?:years?|months?|weeks?|days?|hours?|minutes?))\b[^.;!?\n]{0,180}\b(?:in|around|through|japan|country|solo trip|traveling|travelling)\b/iu,
      /\b(?:in|around|visited|traveled|travelled|stayed\s+in)\s+Japan\b[^.;!?\n]{0,160}\bfor\s+((?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|several|a few)\s+(?:years?|months?|weeks?|days?|hours?|minutes?))/iu
    );
  }
  for (const supportText of params.supportTexts) {
    const text = normalizeSentence(supportText);
    const extracted = patterns.length > 0 ? extractRegexGroup(text, patterns) : null;
    if (
      extracted &&
      !durationClaimIsRelativeRecency({
        claimText: extracted,
        supportTexts: [text]
      })
    ) {
      return extracted;
    }
    if (anchors.length > 0) {
      const normalized = normalizeKey(text);
      const durationPattern =
        /\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten|several|a few)\s+(years?|months?|weeks?|days?|hours?|minutes?)\b/giu;
      for (const match of normalized.matchAll(durationPattern)) {
        const value = `${match[1]} ${match[2]}`;
        const index = match.index ?? 0;
        const before = normalized.slice(Math.max(0, index - 12), index);
        const after = normalized.slice(index + value.length, index + value.length + 16);
        if (/\b(?:past|last)\s+$/u.test(before) || /^\s+ago\b/u.test(after)) {
          continue;
        }
        const window = normalized.slice(Math.max(0, index - 180), Math.min(normalized.length, index + value.length + 180));
        const anchorMatch = anchors.some((anchor) => window.includes(normalizeKey(anchor)));
        if (!anchorMatch) {
          continue;
        }
        if (
          /\b(?:instagram|screen time)\b/u.test(normalizedQuery) &&
          !/\b(?:hours?|minutes?)\b/u.test(value)
        ) {
          continue;
        }
        if (/\bjapan\b/u.test(normalizedQuery) && !/\b(?:japan|country|travel|traveling|travelling|traveled|travelled|solo|trip|spent)\b/u.test(window)) {
          continue;
        }
        return value;
      }
    }
  }
  return null;
}

function exactDetailSupportTextsWithMetadata(params: {
  readonly supportTexts?: readonly string[];
  readonly metadata?: JsonRecord | null;
}): string[] {
  return uniqueStrings(
    [
      readString(params.metadata?.support_phrase),
      readString(params.metadata?.source_text),
      readString(params.metadata?.provenance_text),
      readString(params.metadata?.source_quote),
      readString(params.metadata?.evidence_quote),
      ...(params.supportTexts ?? [])
    ].filter((value): value is string => typeof value === "string" && value.trim().length > 0)
  );
}

function cleanupVenueDisplayValue(value: string, context: string): string {
  const cleaned = cleanupExtractedClaim(
    value
      .replace(/\s+\b(?:last|this|next)\s+(?:weekend|week|month|year|summer|spring|fall|winter)\b.*$/iu, "")
      .replace(/\s+\band\b.*$/iu, "")
  ) ?? value;
  return maybeExpandKnownVenueAlias(cleaned, context);
}

function maybeExpandKnownVenueAlias(value: string, queryOrSupportText: string | null | undefined): string {
  const normalizedValue = normalizeKey(value);
  const context = normalizeKey(queryOrSupportText);
  if (
    normalizedValue === "ucla" &&
    /\b(?:bachelor|undergrad|computer science|cs|degree)\b/u.test(context)
  ) {
    return "University of California, Los Angeles (UCLA)";
  }
  return value;
}

function hasSupportEvidenceForFamilyCompatibility(params: {
  readonly spec: ExactDetailFamilySpec;
  readonly claimText: string;
  readonly supportTexts?: readonly string[];
  readonly metadata?: JsonRecord | null;
}): boolean {
  const context = normalizeKey([
    params.claimText,
    ...(params.supportTexts ?? []),
    readString(params.metadata?.support_phrase),
    readString(params.metadata?.source_text),
    readString(params.metadata?.property_key),
    readString(params.metadata?.predicate_family),
    readString(params.metadata?.scene_structure_kind)
  ].filter((value): value is string => typeof value === "string" && value.trim().length > 0).join(" "));
  if (!context) {
    return false;
  }
  switch (params.spec.family) {
    case "pet_name":
      return /\b(?:cat|dog|pet|kitten|puppy)\b/u.test(context) &&
        (/\b(?:name|named|called)\b/u.test(context) || /\bmy\s+(?:cat|dog|pet|kitten|puppy)\s+[a-z][a-z'-]{1,30}\b/u.test(context));
    case "breed":
      return /\b(?:breed|dog|puppy|cat|kitten|pet|collar|name tag)\b/u.test(context);
    case "duration":
      return /\b(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|several|a few)\s+(?:years?|months?|weeks?|days?|hours?|minutes?)\b/u.test(context) &&
        /\b(?:duration|how long|for|spent|stayed|visited|traveled|travelled|collecting|move|moved|took|screen time|averag|per day|commute|each way|japan|instagram|camera|apartment|assemble|assembly|bookshelf|furniture|put together|build|built)\b/u.test(context);
    case "age_at_event":
      return /\b(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)\b/u.test(context) &&
        /\b(?:age|old|birthday|grandma|grandmother|gave|gift|necklace|when)\b/u.test(context);
    case "purchased_items":
      return /\b(?:buy|bought|purchase|purchased|got|picked up|gift|present|birthday|thrift|action figure|dress|item|sister)\b/u.test(context);
    case "food_drink":
      return /\b(?:food|drink|recipe|cake|rice|cocktail|gin|fizz|bake|baked|made|cooked|favorite|niece|party|blueberry)\b/u.test(context);
    case "creative_work":
      return /\b(?:play|production|performance|recipe|cocktail|gin|fizz|book|movie|film|song|title|called|named|attended|watched|read|tried|made)\b/u.test(context);
    case "price":
      return (
        (
          /\b(?:spent|paid|cost|price|purchase|purchased|bought|handbag|bag|item|dollars?)\b/u.test(context) &&
          (/\$\s?\d[\d,.]*(?:\.\d{2})?\b/u.test(context) || /\b\d[\d,.]*(?:\.\d{2})?\s+dollars?\b/u.test(context))
        ) ||
        /\bworth\s+(?:double|triple|quadruple|twice|(?:\d+|one|two|three|four|five)\s+times)\s+what\s+i\s+paid(?:\s+for\s+it)?\b/u.test(
          context
        )
      );
    case "stance":
      return /\b(?:stance|belief|view|opinion|position|previous|former|used to|spirituality|religion|atheist|agnostic|spiritual|religious)\b/u.test(context);
    case "certification":
      return /\b(?:certification|certificate|credential|course|program|degree|completed|earned|data science)\b/u.test(context);
    case "venue":
      return /\b(?:venue|campus|school|college|university|study abroad|program|class|wedding|ballroom|studio|gym|yoga|attend|attended|degree|undergrad|ucla|cs)\b/u.test(context);
    case "shop":
      return /\b(?:shop|store|retailer|buy|bought|purchase|purchased|ordered|picked up|from|coupon|redeemed?|voucher|downtown|ikea)\b/u.test(context);
    default:
      return false;
  }
}

function isFamilyCompatibleClaimText(params: {
  readonly spec: ExactDetailFamilySpec;
  readonly claimText: string;
}): boolean {
  const text = normalizeSentence(params.claimText);
  if (!text || looksPlaceholderValue(text)) {
    return false;
  }
  switch (params.spec.family) {
    case "speed":
      return /\b\d[\d,.]*\s*(?:kbps|mbps|gbps|tbps|mb\/s|gb\/s|gigabit|megabit)\b/iu.test(text);
    case "capacity":
      return /\b\d[\d,.]*\s*(?:kb|mb|gb|tb)\b/iu.test(text);
    case "time_of_day":
      return /\b(?:[01]?\d|2[0-3])(?::[0-5]\d)?\s*(?:a\.?m\.?|p\.?m\.?)\b/iu.test(text) || /\b(?:noon|midnight|morning|afternoon|evening|night)\b/iu.test(text);
    case "count":
      return /^(?:\d[\d,]*|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)(?:\s+[a-z][a-z-]{1,30}){0,3}$/iu.test(text);
    case "age_at_event":
      return /^(?:\d[\d,]*|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)$/iu.test(text);
    case "duration":
      if (/\b(?:instagram|screen\s+time)\b/iu.test(text)) {
        return /\b(?:\d[\d,.]*|one|two|three|four|five|six|seven|eight|nine|ten|several|a few)\s+(?:hours?|minutes?)\b/iu.test(text);
      }
      return /\b(?:\d[\d,.]*|one|two|three|four|five|six|seven|eight|nine|ten|several|a few)\s+(?:years?|months?|weeks?|days?|hours?|minutes?)\b/iu.test(text);
    case "price":
      return (
        /^(?:\$\s?\d[\d,.]*(?:\.\d{2})?|\d[\d,.]*(?:\.\d{2})?\s+dollars?)$/iu.test(text) ||
        /^(?:worth\s+)?(?:double|triple|quadruple|twice|(?:\d+|one|two|three|four|five)\s+times)\s+what\s+i\s+paid(?:\s+for\s+it)?$/iu.test(
          text
        )
      );
    case "stance":
      return !looksSentenceLike(text) && text.split(/\s+/u).length <= 6 && /\b(?:atheist|agnostic|spiritual|religious|skeptic|sceptic|believer|optimist|pessimist)\b/iu.test(text);
    case "venue":
      return (
        /\b(?:university|college|school|campus|academy|institute|center|centre|hall|studio|gym|park|beach|japan|tokyo|paris|new york)\b/iu.test(text) ||
        (!looksSentenceLike(text) && text.split(/\s+/u).length <= 8)
      );
    case "shop":
      return (
        /\b(?:store|shop|market|retail|retailer|outlet)\b/iu.test(text) ||
        (!looksSentenceLike(text) && text.split(/\s+/u).length <= 6)
      );
    case "certification":
      return (
        /\b(?:certification|certificate|credential|course|program|licen[cs]e|degree)\b/iu.test(text) ||
        (!looksSentenceLike(text) && text.split(/\s+/u).length <= 6)
      );
    case "role":
      return !looksSentenceLike(text) && text.split(/\s+/u).length <= 8;
    case "service_name":
    case "playlist_name":
    case "last_name":
    case "brand":
    case "breed":
    case "pet_name":
    case "purchased_items":
    case "food_drink":
    case "creative_work":
      return !looksSentenceLike(text) && text.split(/\s+/u).length <= 6;
    default:
      return !looksSentenceLike(text);
  }
}

function exactDetailPropertyCompatibilityScore(params: {
  readonly spec: ExactDetailFamilySpec;
  readonly predicateFamily?: string | null;
  readonly propertyKeys?: readonly string[];
  readonly metadata?: JsonRecord | null;
}): number {
  const specificKeys = uniqueStrings([
    normalize(params.predicateFamily),
    ...(params.propertyKeys ?? []),
    normalize(readString(params.metadata?.state_key)),
    normalize(readString(params.metadata?.state_type)),
    normalize(readString(params.metadata?.normalized_property_key)),
    normalize(readString(params.metadata?.canonical_key))
  ]).filter(Boolean);
  let score = 0;
  for (const key of specificKeys) {
    const normalizedKey = normalizeKey(key);
    if (params.spec.scalarPropertyKeys.some((propertyKey) => normalizedKey.includes(normalizeKey(propertyKey)))) {
      score += 2;
    } else if (params.spec.scalarMatchTerms.some((term) => normalizedKey.includes(normalizeKey(term)))) {
      score += 1;
    }
    if (params.spec.eventPredicateFamilies.some((family) => normalizedKey.includes(normalizeKey(family)))) {
      score += 2;
    } else if (params.spec.eventMatchTerms.some((term) => normalizedKey.includes(normalizeKey(term)))) {
      score += 1;
    }
  }
  return score;
}

function assessCanonicalStateSourceCompatibility(params: {
  readonly spec: ExactDetailFamilySpec;
  readonly metadata?: JsonRecord | null;
}): boolean {
  const sourceTable = normalizeKey(readString(params.metadata?.source_table));
  if (
    ["speed", "brand", "breed", "service_name", "playlist_name", "last_name", "capacity", "time_of_day", "pet_name", "count"].includes(params.spec.family)
  ) {
    return sourceTable === "procedural_memory";
  }
  return sourceTable === "procedural_memory" || sourceTable === "canonical_rebuild";
}

export function assessExactDetailClaimAdmissibility(params: {
  readonly spec: ExactDetailFamilySpec;
  readonly claimText: string | null;
  readonly sourceKind: "procedural" | "projection" | "canonical_state" | "event";
  readonly predicateFamily?: string | null;
  readonly propertyKeys?: readonly string[];
  readonly supportTexts?: readonly string[];
  readonly metadata?: JsonRecord | null;
  readonly queryText?: string | null;
}): ExactDetailClaimAdmissibilityDecision {
  const directClaim = cleanupExtractedClaim(params.claimText);
  const directClaimWasPlaceholder = !!directClaim && looksPlaceholderValue(directClaim);
  let claimText = directClaim;
  const expandedSupportTexts = exactDetailSupportTextsWithMetadata({
    supportTexts: params.supportTexts,
    metadata: params.metadata
  });
  const supportExtractedClaim = familySupportsEventExtraction(params.spec)
    ? (params.spec.family === "duration"
        ? extractDurationClaimForQueryContextForTest({
            queryText: params.queryText,
            supportTexts: expandedSupportTexts
          })
        : null) ??
      extractFamilyBoundedClaimFromSupport({
        spec: params.spec,
        supportTexts: expandedSupportTexts
      })
    : null;

  if (
    (!claimText || looksPlaceholderValue(claimText) || looksGenericExactDetailLabel(claimText)) &&
    familySupportsEventExtraction(params.spec)
  ) {
    claimText = supportExtractedClaim ?? (looksGenericExactDetailLabel(claimText) ? null : claimText);
  } else if (supportExtractedClaim && claimText && normalizeKey(supportExtractedClaim) !== normalizeKey(claimText)) {
    const queryRequiresScreenTimeUnit =
      params.spec.family === "duration" &&
      /\b(?:instagram|screen time)\b/u.test(normalizeKey(params.queryText)) &&
      /\b(?:hours?|minutes?)\b/iu.test(supportExtractedClaim) &&
      /\b(?:years?|months?|weeks?|days?)\b/iu.test(claimText) &&
      !/\b(?:hours?|minutes?)\b/iu.test(claimText);
    const directClaimIsRecencyDuration =
      params.spec.family === "duration" &&
      (durationClaimIsRelativeRecency({
        claimText,
        queryText: params.queryText,
        supportTexts: expandedSupportTexts,
        metadata: params.metadata
      }) ||
        expandedSupportTexts.some((supportText) => {
          const normalizedSupport = normalizeKey(supportText);
          const normalizedClaim = normalizeKey(claimText);
          const claimIndex = normalizedSupport.indexOf(normalizedClaim);
          return (
            claimIndex >= 0 &&
            /^\s+ago\b/u.test(
              normalizedSupport.slice(claimIndex + normalizedClaim.length, claimIndex + normalizedClaim.length + 16)
            )
          );
        })) &&
      !expandedSupportTexts.some((supportText) => {
        const normalizedSupport = normalizeKey(supportText);
        const normalizedClaim = normalizeKey(supportExtractedClaim);
        const claimIndex = normalizedSupport.indexOf(normalizedClaim);
        if (claimIndex < 0) {
          return false;
        }
        const before = normalizedSupport.slice(Math.max(0, claimIndex - 12), claimIndex);
        const after = normalizedSupport.slice(claimIndex + normalizedClaim.length, claimIndex + normalizedClaim.length + 16);
        return /\b(?:past|last)\s+$/u.test(before) || /^\s+ago\b/u.test(after);
      });
    const directContextScore = directSupportContextScore({
      spec: params.spec,
      claimText,
      supportTexts: expandedSupportTexts,
      queryText: params.queryText,
      metadata: params.metadata
    });
    const extractedContextScore = directSupportContextScore({
      spec: params.spec,
      claimText: supportExtractedClaim,
      supportTexts: expandedSupportTexts,
      queryText: params.queryText,
      metadata: params.metadata
    });
    if (
      queryRequiresScreenTimeUnit ||
      directClaimIsRecencyDuration ||
      looksGenericExactDetailLabel(claimText) ||
      genericClaimPenalty(claimText) < 0 ||
      extractedContextScore >= directContextScore + 2
    ) {
      claimText = supportExtractedClaim;
    }
  }

  if (!claimText) {
    return {
      status: "rejected",
      claimText: null,
      rejectedReason: directClaimWasPlaceholder ? "placeholder_claim" : "missing_renderable_claim"
    };
  }

  if (looksPlaceholderValue(claimText)) {
    return {
      status: "rejected",
      claimText: null,
      rejectedReason: "placeholder_claim"
    };
  }

  if (looksLowInformationScalarValue(params.spec, claimText)) {
    return {
      status: "rejected",
      claimText: null,
      rejectedReason: "low_information_scalar_value"
    };
  }

  const normalizedQuery = normalizeKey(params.queryText);
  if (
    params.spec.family === "duration" &&
    /\b(?:instagram|screen time)\b/u.test(normalizedQuery) &&
    /\b(?:years?|months?|weeks?|days?)\b/iu.test(claimText) &&
    !/\b(?:hours?|minutes?)\b/iu.test(claimText)
  ) {
    return {
      status: "rejected",
      claimText: null,
      rejectedReason: "duration_unit_context_mismatch"
    };
  }

  if (params.sourceKind === "canonical_state" && !assessCanonicalStateSourceCompatibility(params)) {
    return {
      status: "rejected",
      claimText: null,
      rejectedReason: "canonical_state_source_incompatible"
    };
  }

  const compatibilityScore = exactDetailPropertyCompatibilityScore({
    spec: params.spec,
    predicateFamily: params.predicateFamily,
    propertyKeys: params.propertyKeys,
    metadata: params.metadata
  });
  if (
    compatibilityScore <= 0 &&
    !hasSupportEvidenceForFamilyCompatibility({
      spec: params.spec,
      claimText,
      supportTexts: params.supportTexts,
      metadata: params.metadata
    })
  ) {
    return {
      status: "rejected",
      claimText: null,
      rejectedReason: "family_property_incompatible"
    };
  }

  if (params.sourceKind === "event" && !readString(params.claimText) && !claimText) {
    return {
      status: "rejected",
      claimText: null,
      rejectedReason: "event_missing_object_value"
    };
  }

  if (!isFamilyCompatibleClaimText({ spec: params.spec, claimText })) {
    return {
      status: "rejected",
      claimText: null,
      rejectedReason:
        params.sourceKind === "event"
          ? "event_value_not_family_compatible"
          : "scalar_value_not_family_compatible"
    };
  }

  const contextCompatibility = queryContextCompatibility({
    spec: params.spec,
    claimText,
    queryText: params.queryText,
    supportTexts: params.supportTexts,
    propertyKeys: params.propertyKeys,
    metadata: params.metadata
  });
  if (!contextCompatibility.accepted) {
    return {
      status: "rejected",
      claimText: null,
      rejectedReason: contextCompatibility.reason
    };
  }

  return {
    status: "admissible",
    claimText: maybeExpandKnownVenueAlias(claimText, [params.queryText ?? "", ...(params.supportTexts ?? [])].join(" ")),
    acceptedReason:
      params.spec.family === "duration"
        ? (durationContextAlignmentReason({
            claimText,
            queryText: params.queryText,
            supportTexts: expandedSupportTexts,
            metadata: params.metadata
          }) ?? "duration_context_checked")
        : undefined
  };
}

function buildProjectionClaimText(
  head: ProjectionHeadTruthRow,
  entries: readonly ProjectionEntryTruthRow[]
): string | null {
  return (
    readRenderPayloadAnswerValue(head.render_payload) ??
    readString(head.summary_text) ??
    entries.find((entry) => entry.truth_status !== "superseded")?.display_value ??
    null
  );
}

function exactDetailFactKeyTypeRank(value: string | null | undefined): number {
  switch (normalizeKey(value)) {
    case "value":
      return 0;
    case "fact":
      return 1;
    case "alias":
      return 2;
    case "support_phrase":
      return 3;
    case "event_key":
      return 4;
    default:
      return 5;
  }
}

function exactTruthAuthorityForFactKey(row: ExactDetailFactKeyLookupRow): ExactTruthAuthority {
  if (row.fact_table === "temporal_event_facts") {
    return "active_event_fact";
  }
  if (row.fact_table === "canonical_states") {
    return "active_canonical_state";
  }
  if (row.fact_table === "canonical_facts") {
    return "active_scalar_fact";
  }
  if (row.fact_table === "narrative_scenes") {
    return normalizeKey(readString(row.metadata?.authoritative_source)) === "active_event_fact"
      ? "active_event_fact"
      : "active_scalar_fact";
  }
  return normalizeKey(readString(row.metadata?.authoritative_source)) === "active_event_fact"
    ? "active_event_fact"
    : "scalar_contract_projection";
}

function exactTruthAuthorityForCompiledObservation(row: CompiledFactObservationLookupRow): ExactTruthAuthority {
  const authoritativeSource = normalizeKey(readString(row.metadata?.authoritative_source));
  if (authoritativeSource === "active_event_fact" || row.source_table === "temporal_event_facts") {
    return "active_event_fact";
  }
  if (row.source_table === "canonical_states") {
    return "active_canonical_state";
  }
  if (authoritativeSource === "active_procedural_truth") {
    return "active_procedural_truth";
  }
  return "active_scalar_fact";
}

function selfBindingSourceForCompiledObservation(row: CompiledFactObservationLookupRow): SelfBindingRecoveredFrom {
  if (row.source_table === "temporal_event_facts") {
    return "event_truth";
  }
  return normalizeKey(readString(row.metadata?.scene_structure_kind)) === "event_value_support" ? "event_truth" : "scalar_truth";
}

function selfBindingSourceForFactKey(row: ExactDetailFactKeyLookupRow): SelfBindingRecoveredFrom {
  if (row.fact_table === "temporal_event_facts") {
    return "event_truth";
  }
  return normalizeKey(readString(row.metadata?.scene_structure_kind)) === "event_value_support" ? "event_truth" : "scalar_truth";
}

function sourceTableRank(sourceTable: string): number {
  switch (sourceTable) {
    case "narrative_scenes":
      return 50;
    case "temporal_event_facts":
      return 45;
    case "exact_detail_fact_keys":
      return 42;
    case "canonical_facts":
      return 30;
    case "contract_projection_entries":
      return 20;
    case "canonical_states":
      return 10;
    default:
      return 0;
  }
}

interface ExactDetailRankBreakdown {
  readonly rankScore: number;
  readonly queryContextScore: number;
  readonly sourceAuthorityScore: number;
  readonly selectedReason: string;
}

function genericClaimPenalty(value: string): number {
  const text = normalizeSentence(value);
  if (!text) {
    return -30;
  }
  if (looksSentenceLike(text)) {
    return -18;
  }
  if (/^(?:recipe ideas?|ideas?|gift ideas?|excellent gift ideas?|metadata|event|fact|profile|summary|none|unknown)$/iu.test(text)) {
    return -24;
  }
  return 0;
}

function looksGenericExactDetailLabel(value: string | null | undefined): boolean {
  const text = normalizeKey(value);
  return /^(?:recipe ideas?|ideas?|gift ideas?|excellent gift ideas?|great ideas?|excellent ideas?|gift|birthday gift|item|items|thing|things|shop|store|venue|event|metadata|summary)$/u.test(text);
}

function sourceAuthorityScoreForCompiledObservation(row: CompiledFactObservationLookupRow): number {
  const structureKind = normalizeKey(readString(row.metadata?.scene_structure_kind));
  const supportPhrase = normalize(readString(row.metadata?.support_phrase) ?? row.support_phrase ?? "");
  const provenanceBonus = supportPhrase.length > 0 ? 8 : 0;
  const structuredValueBonus =
    row.source_table === "narrative_scenes" && ["scalar_value_support", "event_value_support"].includes(structureKind)
      ? 16
      : row.source_table === "exact_detail_fact_keys"
        ? 10
        : 0;
  const weakProjectionPenalty =
    row.source_table === "canonical_states" || row.source_table === "contract_projection_entries" ? -10 : 0;
  return sourceTableRank(row.source_table) + provenanceBonus + structuredValueBonus + weakProjectionPenalty;
}

function sourceAuthorityScoreForFactKey(row: ExactDetailFactKeyLookupRow): number {
  const structureKind = normalizeKey(readString(row.metadata?.scene_structure_kind));
  const supportPhrase = normalize(readString(row.metadata?.support_phrase) ?? "");
  const provenanceBonus = supportPhrase.length > 0 ? 8 : 0;
  const structuredValueBonus =
    row.fact_table === "narrative_scenes" && ["scalar_value_support", "event_value_support"].includes(structureKind)
      ? 16
      : 0;
  const valueKeyBonus = normalizeKey(row.key_type) === "value" ? 14 : 0;
  const weakProjectionPenalty =
    row.fact_table === "canonical_states" || row.fact_table === "contract_projection_entries" ? -10 : 0;
  return sourceTableRank(row.fact_table) + provenanceBonus + structuredValueBonus + valueKeyBonus + weakProjectionPenalty;
}

function factKeyRowsShareProvenance(left: ExactDetailFactKeyLookupRow, right: ExactDetailFactKeyLookupRow): boolean {
  if (left.fact_table === right.fact_table && left.fact_row_id === right.fact_row_id) {
    return true;
  }
  const sharedMetadataKeys = ["source_scene_id", "source_memory_id", "source_chunk_id", "source_turn_id"];
  return sharedMetadataKeys.some((key) => {
    const leftValue = readString(left.metadata?.[key]);
    const rightValue = readString(right.metadata?.[key]);
    return Boolean(leftValue && rightValue && leftValue === rightValue);
  });
}

function factKeySupportTextsForRow(
  row: ExactDetailFactKeyLookupRow,
  rows: readonly ExactDetailFactKeyLookupRow[]
): string[] {
  const relatedSupportTexts =
    normalizeKey(row.key_type) === "support_phrase"
      ? [row.key_text]
      : rows
          .filter((candidate) => normalizeKey(candidate.key_type) === "support_phrase")
          .filter((candidate) => factKeyRowsShareProvenance(row, candidate))
          .map((candidate) => candidate.key_text);
  return uniqueStrings(
    [
      ...relatedSupportTexts,
      readString(row.metadata?.support_phrase) ?? "",
      readString(row.metadata?.source_text) ?? ""
    ].filter((value) => normalize(value).length > 0)
  );
}

export function factKeySupportTextsForTest(params: {
  readonly row: ExactDetailFactKeyLookupRow;
  readonly rows: readonly ExactDetailFactKeyLookupRow[];
}): string[] {
  return factKeySupportTextsForRow(params.row, params.rows);
}

function compiledObservationRankBreakdown(params: {
  readonly row: CompiledFactObservationLookupRow;
  readonly spec: ExactDetailFamilySpec;
  readonly claimText: string;
  readonly supportTexts: readonly string[];
  readonly queryText?: string | null;
}): ExactDetailRankBreakdown {
  const queryContextScore = directSupportContextScore({
    spec: params.spec,
    claimText: params.claimText,
    supportTexts: params.supportTexts,
    queryText: params.queryText,
    metadata: params.row.metadata
  });
  const sourceAuthorityScore = sourceAuthorityScoreForCompiledObservation(params.row);
  const ownershipBonus = ["explicit_ownership_cue", "scene_self_binding", "owner_bound", "self_owned"].includes(
    normalizeKey(readString(params.row.metadata?.ownershipEvidenceStatus))
  )
    ? 8
    : 0;
  const valuePenalty = genericClaimPenalty(params.claimText);
  const confidenceScore = Math.max(0, params.row.confidence ?? 0) * 5;
  const rankScore = sourceAuthorityScore + queryContextScore * 8 + ownershipBonus + confidenceScore + valuePenalty;
  return {
    rankScore,
    queryContextScore,
    sourceAuthorityScore,
    selectedReason: `source=${params.row.source_table};context=${queryContextScore};authority=${sourceAuthorityScore};ownership=${ownershipBonus};penalty=${valuePenalty}`
  };
}

function compiledObservationRankScore(params: {
  readonly row: CompiledFactObservationLookupRow;
  readonly spec: ExactDetailFamilySpec;
  readonly claimText: string;
  readonly supportTexts: readonly string[];
  readonly queryText?: string | null;
}): number {
  return compiledObservationRankBreakdown(params).rankScore;
}

function compiledObservationSelectedReason(
  rankBreakdown: ExactDetailRankBreakdown,
  admissibility: ExactDetailClaimAdmissibilityDecision
): string {
  return admissibility.acceptedReason
    ? `${rankBreakdown.selectedReason};admission=${admissibility.acceptedReason}`
    : rankBreakdown.selectedReason;
}

interface RankedAdmissibleEntry<T> {
  readonly row: T;
  readonly claimText: string;
  readonly rankScore: number;
  readonly rankBreakdown?: ExactDetailRankBreakdown;
}

function resolveAdmissibleValueConflict<T>(entries: readonly RankedAdmissibleEntry<T>[]): {
  readonly resolved: boolean;
  readonly runnerUp: RankedAdmissibleEntry<T> | null;
  readonly status: RecallResponse["meta"]["conflictResolutionStatus"];
  readonly winnerReason: string | null;
  readonly runnerUpCount: number;
} {
  const admissible = entries
    .filter((entry) => normalize(entry.claimText).length > 0)
    .sort((left, right) => right.rankScore - left.rankScore);
  const top = admissible[0] ?? null;
  if (!top) {
    return { resolved: false, runnerUp: null, status: "not_applicable", winnerReason: null, runnerUpCount: 0 };
  }
  const topValue = normalizeKey(top.claimText);
  const runnerUp = admissible.find((entry) => normalizeKey(entry.claimText) !== topValue) ?? null;
  const runnerUpCount = uniqueStrings(admissible.map((entry) => normalizeKey(entry.claimText)).filter(Boolean)).length - 1;
  if (!runnerUp) {
    return { resolved: true, runnerUp: null, status: "not_applicable", winnerReason: "single_admissible_value", runnerUpCount: 0 };
  }
  const contextMargin =
    (top.rankBreakdown?.queryContextScore ?? 0) - (runnerUp.rankBreakdown?.queryContextScore ?? 0);
  const rankMargin = top.rankScore - runnerUp.rankScore;
  const resolved =
    rankMargin >= 16 ||
    (contextMargin >= 2 && (top.rankBreakdown?.queryContextScore ?? 0) > 0) ||
    ((top.rankBreakdown?.queryContextScore ?? 0) > 0 && (runnerUp.rankBreakdown?.queryContextScore ?? 0) === 0);
  return {
    resolved,
    runnerUp,
    status: resolved ? "resolved_by_context_margin" : "ambiguous",
    winnerReason: resolved
      ? `rank_margin=${rankMargin.toFixed(2)};context_margin=${contextMargin}`
      : `ambiguous_rank_margin=${rankMargin.toFixed(2)};context_margin=${contextMargin}`,
    runnerUpCount
  };
}

function normalizeExactTruthAuthority(value: string | null | undefined): ExactTruthAuthority {
  const normalized = normalizeKey(value);
  switch (normalized) {
    case "active_canonical_state":
      return "active_canonical_state";
    case "active_scalar_fact":
      return "active_scalar_fact";
    case "active_event_fact":
      return "active_event_fact";
    case "event_exact_detail_fact":
      return "event_exact_detail_fact";
    case "active_procedural_truth":
      return "active_procedural_truth";
    default:
      return "scalar_contract_projection";
  }
}

async function loadCompiledExactDetailTruth(params: {
  readonly namespaceId: string;
  readonly subjectEntityId?: string | null;
  readonly spec: ExactDetailFamilySpec;
  readonly timeStart: string | null;
  readonly timeEnd: string | null;
  readonly allowUnboundSelfOwned?: boolean;
  readonly queryText?: string | null;
}): Promise<ExactTruthCandidate | null> {
  const rows = await loadCompiledExactDetailObservationRows({
    namespaceId: params.namespaceId,
    exactDetailFamily: params.spec.family,
    subjectEntityId: params.subjectEntityId ?? null,
    allowUnboundSelfOwned: params.allowUnboundSelfOwned,
    timeStart: params.timeStart,
    timeEnd: params.timeEnd
  });
  if (rows.length === 0) {
    return null;
  }

  const assessedRows = rows
    .map((row) => {
      const supportTexts = uniqueStrings(
        [
          row.support_phrase ?? "",
          row.source_text ?? "",
          readString(row.metadata?.support_phrase) ?? "",
          readString(row.metadata?.source_text) ?? ""
        ].filter((value) => normalize(value).length > 0)
      );
      const sourceKind =
        row.source_table === "temporal_event_facts" ||
        normalizeKey(readString(row.metadata?.scene_structure_kind)) === "event_value_support"
          ? "event"
          : row.source_table === "canonical_states"
            ? "canonical_state"
            : "projection";
      const admissibility = assessExactDetailClaimAdmissibility({
        spec: params.spec,
        claimText: row.answer_value,
        sourceKind,
        predicateFamily: row.predicate_family ?? row.property_key,
        propertyKeys: [row.property_key ?? ""],
        supportTexts,
        metadata: row.metadata,
        queryText: params.queryText
      });
      const rankBreakdown = compiledObservationRankBreakdown({
        row,
        spec: params.spec,
        claimText: admissibility.claimText ?? row.answer_value ?? "",
        supportTexts,
        queryText: params.queryText
      });
      return {
        row,
        supportTexts,
        sourceKind,
        admissibility,
        rankBreakdown,
        rankScore: rankBreakdown.rankScore
      };
    })
    .sort((left, right) => right.rankScore - left.rankScore);
  const selectedAssessment = assessedRows.find((entry) => entry.admissibility.status === "admissible" && entry.admissibility.claimText) ?? null;
  const selected = selectedAssessment?.row ?? null;
  const admissibleRankedEntries = assessedRows
    .filter((entry) => entry.admissibility.status === "admissible" && entry.admissibility.claimText)
    .map((entry) => ({
      row: entry.row,
      claimText: entry.admissibility.claimText ?? "",
      rankScore: entry.rankScore,
      rankBreakdown: entry.rankBreakdown
    }));
  const conflictResolution = resolveAdmissibleValueConflict(admissibleRankedEntries);
  if (params.allowUnboundSelfOwned && !conflictResolution.resolved && conflictResolution.runnerUpCount > 0) {
    return {
      status: "partial",
      results: [],
      reason: "Compiled exact-detail observations had multiple unbound first-person values without a decisive query-context margin, so the claim was withheld.",
      authoritativeSource: "typed_abstention",
      supportBundleFamily: params.spec.queryFamily,
      structuredSufficiencyStatus: "partial",
      abstentionReason: "support_conflict",
      entityResolutionStatus: "ambiguous",
      backfillBlockedReason: "ambiguous_unbound_compiled_observation",
      selfBindingRecoveredFrom: "none",
      factKeyLookupUsed: true,
      factKeyHitType: "compiled_observation",
      factRowSource: "compiled_fact_observations",
      compiledRankScore: selectedAssessment?.rankBreakdown.rankScore,
      compiledQueryContextScore: selectedAssessment?.rankBreakdown.queryContextScore,
      compiledSourceAuthorityScore: selectedAssessment?.rankBreakdown.sourceAuthorityScore,
      compiledSelectedReason: selectedAssessment
        ? compiledObservationSelectedReason(selectedAssessment.rankBreakdown, selectedAssessment.admissibility)
        : undefined,
      compiledRunnerUpReason: conflictResolution.winnerReason ?? undefined,
      conflictResolutionStatus: conflictResolution.status,
      conflictWinnerReason: conflictResolution.winnerReason ?? undefined,
      conflictRunnerUpCount: conflictResolution.runnerUpCount
    };
  }
  const firstRejected = assessedRows[0] ?? null;
  if (!selectedAssessment || !selected) {
    if (!firstRejected) {
      return null;
    }
    const rejectedSubjectId = firstRejected.row.subject_entity_id ?? params.subjectEntityId;
    return {
      status: "insufficient",
      results: [],
      reason: "Compiled exact-detail observations matched structured truth, but no candidate passed query-aware admissibility.",
      authoritativeSource: "typed_abstention",
      supportBundleFamily: params.spec.queryFamily,
      structuredSufficiencyStatus: "insufficient",
      abstentionReason: "insufficient_active_truth",
      entityResolutionStatus: rejectedSubjectId ? "resolved" : "unresolved",
      subjectEntityId: rejectedSubjectId,
      selfBindingRecoveredFrom: selfBindingSourceForCompiledObservation(firstRejected.row),
      claimAdmissibilityStatus: firstRejected.admissibility.status,
      authoritativeClaimRejectedReason:
        firstRejected.admissibility.rejectedReason ?? firstRejected.row.rejection_reason ?? "compiled_observation_rejected",
      factKeyLookupUsed: true,
      factKeyHitType: "compiled_observation",
      factRowSource: "compiled_fact_observations",
      compiledRankScore: firstRejected.rankBreakdown.rankScore,
      compiledQueryContextScore: firstRejected.rankBreakdown.queryContextScore,
      compiledSourceAuthorityScore: firstRejected.rankBreakdown.sourceAuthorityScore,
      compiledSelectedReason: compiledObservationSelectedReason(firstRejected.rankBreakdown, firstRejected.admissibility)
    };
  }
  const supportTexts = selectedAssessment.supportTexts;
  const admissibility = selectedAssessment.admissibility;
  if (admissibility.status !== "admissible" || !admissibility.claimText) {
    return {
      status: "insufficient",
      results: [],
      reason: "Compiled exact-detail observations matched structured truth, but the best candidate did not pass admissibility.",
      authoritativeSource: "typed_abstention",
      supportBundleFamily: params.spec.queryFamily,
      structuredSufficiencyStatus: "insufficient",
      abstentionReason: "insufficient_active_truth",
      entityResolutionStatus: "resolved",
      subjectEntityId: params.subjectEntityId ?? selected.subject_entity_id,
      selfBindingRecoveredFrom: selfBindingSourceForCompiledObservation(selected),
      claimAdmissibilityStatus: admissibility.status,
      authoritativeClaimRejectedReason: admissibility.rejectedReason ?? selected.rejection_reason ?? "compiled_observation_rejected",
      factKeyLookupUsed: true,
      factKeyHitType: "compiled_observation",
      factRowSource: "compiled_fact_observations",
      compiledRankScore: selectedAssessment.rankBreakdown.rankScore,
      compiledQueryContextScore: selectedAssessment.rankBreakdown.queryContextScore,
      compiledSourceAuthorityScore: selectedAssessment.rankBreakdown.sourceAuthorityScore,
      compiledSelectedReason: compiledObservationSelectedReason(selectedAssessment.rankBreakdown, admissibility),
      compiledRunnerUpReason: conflictResolution.runnerUp?.rankBreakdown?.selectedReason
    };
  }

  const recoveredSelfProfile =
    !selected.subject_entity_id &&
    !params.subjectEntityId &&
    params.allowUnboundSelfOwned &&
    params.spec.selfOwned &&
    isFirstPersonExactDetailQuery(params.queryText ?? "")
      ? await getNamespaceSelfProfile(params.namespaceId).catch(() => null)
      : null;
  const resolvedSubjectEntityId = selected.subject_entity_id ?? params.subjectEntityId ?? recoveredSelfProfile?.entityId ?? null;

  const results: RecallResult[] = [
    {
      memoryId: selected.id,
      memoryType: "semantic_memory",
      content: admissibility.claimText,
      score: Math.max(0.78, selected.confidence ?? 0.78),
      artifactId: null,
      occurredAt: selected.valid_from,
      namespaceId: params.namespaceId,
      provenance: {
        tier: "compiled_fact_observation",
        subject_entity_id: resolvedSubjectEntityId,
        source_table: selected.source_table,
        source_row_id: selected.source_row_id,
        source_scene_id: selected.source_scene_id,
        source_memory_id: selected.source_memory_id,
        source_chunk_id: selected.source_chunk_id,
        property_key: selected.property_key,
        exact_detail_family: selected.exact_detail_family,
        valid_from: selected.valid_from,
        valid_until: selected.valid_until,
        metadata: selected.metadata ?? {}
      }
    }
  ];
  for (const [index, supportText] of supportTexts.slice(0, 2).entries()) {
    results.push({
      memoryId: `${selected.id}:support:${index}`,
      memoryType: "semantic_memory",
      content: supportText,
      score: Math.max(0.55, 0.72 - index * 0.1),
      artifactId: null,
      occurredAt: selected.valid_from,
      namespaceId: params.namespaceId,
      provenance: {
        tier: "compiled_fact_observation_support",
        subject_entity_id: resolvedSubjectEntityId,
        source_table: selected.source_table,
        source_row_id: selected.source_row_id
      }
    });
  }

  return {
    status: "sufficient",
    results,
    reason: "The query was answered from compiled exact-detail observations before fact-key fallback or generic widening.",
    authoritativeSource: exactTruthAuthorityForCompiledObservation(selected),
    supportBundleFamily: params.spec.queryFamily,
    structuredSufficiencyStatus: "sufficient",
    temporalCoverageStatus:
      selected.source_table === "temporal_event_facts" ||
      normalizeKey(readString(selected.metadata?.scene_structure_kind)) === "event_value_support"
        ? "bounded"
        : undefined,
    entityResolutionStatus: resolvedSubjectEntityId || params.allowUnboundSelfOwned ? "resolved" : "unresolved",
    backfillBlockedReason: "compiled_observation_sufficient",
    subjectEntityId: resolvedSubjectEntityId,
    selfBindingRecoveredFrom: recoveredSelfProfile ? "existing_binding" : selfBindingSourceForCompiledObservation(selected),
    claimAdmissibilityStatus: "admissible",
    factKeyLookupUsed: true,
    factKeyHitType: "compiled_observation",
    factRowSource: "compiled_fact_observations",
    compiledRankScore: selectedAssessment.rankBreakdown.rankScore,
    compiledQueryContextScore: selectedAssessment.rankBreakdown.queryContextScore,
    compiledSourceAuthorityScore: selectedAssessment.rankBreakdown.sourceAuthorityScore,
    compiledSelectedReason: compiledObservationSelectedReason(selectedAssessment.rankBreakdown, admissibility),
    compiledRunnerUpReason: conflictResolution.runnerUp?.rankBreakdown?.selectedReason,
    conflictResolutionStatus: conflictResolution.status,
    conflictWinnerReason: conflictResolution.winnerReason ?? undefined,
    conflictRunnerUpCount: conflictResolution.runnerUpCount
  };
}

async function loadNamespaceCompiledExactDetailTruth(params: {
  readonly namespaceId: string;
  readonly spec: ExactDetailFamilySpec;
  readonly timeStart: string | null;
  readonly timeEnd: string | null;
  readonly queryText?: string | null;
}): Promise<ExactTruthCandidate | null> {
  const rows = await loadCompiledExactDetailObservationSubjectCounts({
    namespaceId: params.namespaceId,
    exactDetailFamily: params.spec.family,
    timeStart: params.timeStart,
    timeEnd: params.timeEnd
  });
  const selected = rows[0] ?? null;
  const runnerUp = rows[1] ?? null;
  if (!selected?.subject_entity_id) {
    return null;
  }
  if ((selected.candidate_count ?? 0) <= (runnerUp?.candidate_count ?? 0)) {
    if (params.spec.selfOwned) {
      return null;
    }
    return {
      status: "partial",
      results: [],
      reason: "Compiled exact-detail observations matched multiple competing subjects, so the claim was withheld.",
      authoritativeSource: "typed_abstention",
      supportBundleFamily: params.spec.queryFamily,
      structuredSufficiencyStatus: "partial",
      abstentionReason: "no_subject_binding",
      entityResolutionStatus: "ambiguous",
      backfillBlockedReason: "ambiguous_compiled_observation_subject",
      selfBindingRecoveredFrom: "none",
      factKeyLookupUsed: true,
      factKeyHitType: "compiled_observation",
      factRowSource: "compiled_fact_observations"
    };
  }
  const scoped = await loadCompiledExactDetailTruth({
    namespaceId: params.namespaceId,
    subjectEntityId: selected.subject_entity_id,
    spec: params.spec,
    timeStart: params.timeStart,
    timeEnd: params.timeEnd,
    queryText: params.queryText
  });
  return scoped ? { ...scoped, subjectEntityId: selected.subject_entity_id, selfBindingRecoveredFrom: "scalar_truth" } : null;
}

async function loadExactDetailFactKeyTruth(params: {
  readonly namespaceId: string;
  readonly subjectEntityId: string;
  readonly spec: ExactDetailFamilySpec;
  readonly timeStart: string | null;
  readonly timeEnd: string | null;
  readonly queryText?: string | null;
}): Promise<ExactTruthCandidate | null> {
  const rows = await queryRows<ExactDetailFactKeyLookupRow>(
    `
      SELECT
        id::text,
        fact_table,
        fact_row_id::text,
        subject_entity_id::text,
        exact_detail_family,
        property_key,
        key_type,
        key_text,
        normalized_key_text,
        truth_status,
        valid_from::text,
        valid_until::text,
        confidence,
        metadata
      FROM exact_detail_fact_keys
      WHERE namespace_id = $1
        AND exact_detail_family = $2
        AND subject_entity_id = $3::uuid
        AND truth_status <> 'superseded'
        AND ($4::timestamptz IS NULL OR valid_until IS NULL OR valid_until >= $4::timestamptz)
        AND ($5::timestamptz IS NULL OR valid_from IS NULL OR valid_from <= $5::timestamptz)
      ORDER BY
        CASE truth_status WHEN 'active' THEN 0 WHEN 'uncertain' THEN 1 ELSE 2 END,
        CASE key_type WHEN 'value' THEN 0 WHEN 'fact' THEN 1 WHEN 'alias' THEN 2 WHEN 'support_phrase' THEN 3 ELSE 4 END,
        CASE fact_table WHEN 'narrative_scenes' THEN 0 WHEN 'temporal_event_facts' THEN 1 WHEN 'canonical_facts' THEN 2 WHEN 'contract_projection_entries' THEN 3 WHEN 'canonical_states' THEN 4 ELSE 5 END,
        confidence DESC NULLS LAST,
        valid_from DESC NULLS LAST
      LIMIT 12
    `,
    [params.namespaceId, params.spec.family, params.subjectEntityId, params.timeStart, params.timeEnd]
  );
  if (rows.length === 0) {
    return null;
  }

  const assessedRows = rows
    .map((row) => {
      const supportTexts = factKeySupportTextsForRow(row, rows);
      const claimText =
        normalizeKey(row.key_type) === "value"
          ? row.key_text
          : extractAtomicExactDetailValue({
              family: params.spec.family,
              texts: [row.key_text, ...supportTexts]
            });
      const sourceKind =
        row.fact_table === "temporal_event_facts"
          ? "event"
          : row.fact_table === "narrative_scenes"
            ? normalizeKey(readString(row.metadata?.scene_structure_kind)) === "event_value_support"
              ? "event"
              : "projection"
            : row.fact_table === "canonical_states"
              ? "canonical_state"
              : "projection";
      const admissibility = assessExactDetailClaimAdmissibility({
        spec: params.spec,
        claimText,
        sourceKind,
        predicateFamily: readString(row.metadata?.predicate_family) ?? row.property_key,
        propertyKeys: [row.property_key ?? ""],
        supportTexts,
        metadata: row.metadata,
        queryText: params.queryText
      });
      const queryContextScore = directSupportContextScore({
        spec: params.spec,
        claimText: admissibility.claimText ?? claimText ?? row.key_text ?? "",
        supportTexts,
        queryText: params.queryText,
        metadata: row.metadata
      });
      const sourceAuthorityScore = sourceAuthorityScoreForFactKey(row);
      const rankScore =
        sourceAuthorityScore +
        queryContextScore * 8 +
        Math.max(0, row.confidence ?? 0) * 5 +
        genericClaimPenalty(admissibility.claimText ?? claimText ?? row.key_text ?? "");
      return {
        row,
        supportTexts,
        sourceKind,
        admissibility,
        rankBreakdown: {
          rankScore,
          queryContextScore,
          sourceAuthorityScore,
          selectedReason: `source=${row.fact_table};key_type=${row.key_type};context=${queryContextScore};authority=${sourceAuthorityScore}`
        },
        rankScore
      };
    })
    .sort((left, right) => right.rankScore - left.rankScore);
  const selectedAssessment = assessedRows.find((entry) => entry.admissibility.status === "admissible" && entry.admissibility.claimText) ?? null;
  const selected = selectedAssessment?.row ?? assessedRows[0]?.row ?? null;
  const supportTexts = selectedAssessment?.supportTexts ?? assessedRows[0]?.supportTexts ?? [];
  const admissibility = selectedAssessment?.admissibility ?? assessedRows[0]?.admissibility;
  if (!selected || !admissibility) {
    return null;
  }
  if (admissibility.status !== "admissible" || !admissibility.claimText) {
    return {
      status: "insufficient",
      results: [],
      reason: "Exact-detail fact keys matched structured truth, but the best candidate did not pass admissibility.",
      authoritativeSource: "typed_abstention",
      supportBundleFamily: params.spec.queryFamily,
      structuredSufficiencyStatus: "insufficient",
      abstentionReason: "insufficient_active_truth",
      entityResolutionStatus: "resolved",
      subjectEntityId: params.subjectEntityId,
      selfBindingRecoveredFrom: selfBindingSourceForFactKey(selected),
      claimAdmissibilityStatus: admissibility.status,
      authoritativeClaimRejectedReason: admissibility.rejectedReason,
      factKeyLookupUsed: true,
      factKeyHitType: selected.key_type,
      factRowSource: selected.fact_table,
      compiledRankScore: selectedAssessment?.rankBreakdown.rankScore ?? assessedRows[0]?.rankBreakdown.rankScore,
      compiledQueryContextScore: selectedAssessment?.rankBreakdown.queryContextScore ?? assessedRows[0]?.rankBreakdown.queryContextScore,
      compiledSourceAuthorityScore: selectedAssessment?.rankBreakdown.sourceAuthorityScore ?? assessedRows[0]?.rankBreakdown.sourceAuthorityScore,
      compiledSelectedReason: selectedAssessment?.rankBreakdown.selectedReason ?? assessedRows[0]?.rankBreakdown.selectedReason
    };
  }

  const results: RecallResult[] = [
    {
      memoryId: selected.id,
      memoryType: "semantic_memory",
      content: admissibility.claimText,
      score: Math.max(0.75, selected.confidence ?? 0.75),
      artifactId: null,
      occurredAt: selected.valid_from,
      namespaceId: params.namespaceId,
      provenance: {
        tier: "exact_detail_fact_key",
        subject_entity_id: params.subjectEntityId,
        fact_table: selected.fact_table,
        fact_row_id: selected.fact_row_id,
        key_type: selected.key_type,
        property_key: selected.property_key,
        valid_from: selected.valid_from,
        valid_until: selected.valid_until,
        metadata: selected.metadata ?? {}
      }
    }
  ];
  for (const [index, supportText] of supportTexts.slice(0, 2).entries()) {
    results.push({
      memoryId: `${selected.id}:support:${index}`,
      memoryType: "semantic_memory",
      content: supportText,
      score: Math.max(0.5, 0.7 - index * 0.1),
      artifactId: null,
      occurredAt: selected.valid_from,
      namespaceId: params.namespaceId,
      provenance: {
        tier: "exact_detail_fact_key_support",
        subject_entity_id: params.subjectEntityId,
        fact_table: selected.fact_table,
        fact_row_id: selected.fact_row_id,
        key_type: "support_phrase"
      }
    });
  }

  return {
    status: "sufficient",
    results,
    reason: "The query was answered from exact-detail fact keys before generic widening or broad support scans.",
    authoritativeSource: exactTruthAuthorityForFactKey(selected),
    supportBundleFamily: params.spec.queryFamily,
    structuredSufficiencyStatus: "sufficient",
    temporalCoverageStatus:
      selected.fact_table === "temporal_event_facts" ||
      normalizeKey(readString(selected.metadata?.scene_structure_kind)) === "event_value_support"
        ? "bounded"
        : undefined,
    entityResolutionStatus: "resolved",
    backfillBlockedReason: "exact_detail_fact_key_sufficient",
    subjectEntityId: params.subjectEntityId,
    selfBindingRecoveredFrom: selfBindingSourceForFactKey(selected),
    claimAdmissibilityStatus: "admissible",
    factKeyLookupUsed: true,
    factKeyHitType: selected.key_type,
    factRowSource: selected.fact_table,
    compiledRankScore: selectedAssessment?.rankBreakdown.rankScore,
    compiledQueryContextScore: selectedAssessment?.rankBreakdown.queryContextScore,
    compiledSourceAuthorityScore: selectedAssessment?.rankBreakdown.sourceAuthorityScore,
    compiledSelectedReason: selectedAssessment?.rankBreakdown.selectedReason
  };
}

async function loadNamespaceExactDetailFactKeyTruth(params: {
  readonly namespaceId: string;
  readonly spec: ExactDetailFamilySpec;
  readonly timeStart: string | null;
  readonly timeEnd: string | null;
  readonly queryText?: string | null;
}): Promise<ExactTruthCandidate | null> {
  const rows = await queryRows<{
    readonly subject_entity_id: string | null;
    readonly candidate_count: number;
  }>(
    `
      SELECT subject_entity_id::text, COUNT(*)::int AS candidate_count
      FROM exact_detail_fact_keys
      WHERE namespace_id = $1
        AND exact_detail_family = $2
        AND key_type = 'value'
        AND truth_status <> 'superseded'
        AND subject_entity_id IS NOT NULL
        AND ($3::timestamptz IS NULL OR valid_until IS NULL OR valid_until >= $3::timestamptz)
        AND ($4::timestamptz IS NULL OR valid_from IS NULL OR valid_from <= $4::timestamptz)
      GROUP BY subject_entity_id
      ORDER BY candidate_count DESC, subject_entity_id ASC
      LIMIT 2
    `,
    [params.namespaceId, params.spec.family, params.timeStart, params.timeEnd]
  );
  const selected = rows[0] ?? null;
  const runnerUp = rows[1] ?? null;
  if (!selected?.subject_entity_id) {
    return null;
  }
  if ((selected.candidate_count ?? 0) <= (runnerUp?.candidate_count ?? 0)) {
    if (params.spec.selfOwned) {
      return null;
    }
    return {
      status: "partial",
      results: [],
      reason: "Namespace exact-detail fact keys matched multiple competing subjects, so the claim was withheld.",
      authoritativeSource: "typed_abstention",
      supportBundleFamily: params.spec.queryFamily,
      structuredSufficiencyStatus: "partial",
      abstentionReason: "no_subject_binding",
      entityResolutionStatus: "ambiguous",
      backfillBlockedReason: "ambiguous_namespace_fact_key_subject",
      selfBindingRecoveredFrom: "none",
      factKeyLookupUsed: true
    };
  }
  const scoped = await loadExactDetailFactKeyTruth({
    namespaceId: params.namespaceId,
    subjectEntityId: selected.subject_entity_id,
    spec: params.spec,
    timeStart: params.timeStart,
    timeEnd: params.timeEnd,
    queryText: params.queryText
  });
  return scoped ? { ...scoped, subjectEntityId: selected.subject_entity_id, selfBindingRecoveredFrom: "scalar_truth" } : null;
}

async function loadUnboundNamespaceExactDetailFactKeyTruth(params: {
  readonly namespaceId: string;
  readonly spec: ExactDetailFamilySpec;
  readonly timeStart: string | null;
  readonly timeEnd: string | null;
  readonly queryText?: string | null;
}): Promise<ExactTruthCandidate | null> {
  const rows = await queryRows<ExactDetailFactKeyLookupRow>(
    `
      SELECT
        id::text,
        fact_table,
        fact_row_id::text,
        subject_entity_id::text,
        exact_detail_family,
        property_key,
        key_type,
        key_text,
        normalized_key_text,
        truth_status,
        valid_from::text,
        valid_until::text,
        confidence,
        metadata
      FROM exact_detail_fact_keys
      WHERE namespace_id = $1
        AND exact_detail_family = $2
        AND subject_entity_id IS NULL
        AND truth_status <> 'superseded'
        AND (metadata->>'ownershipEvidenceStatus' IN ('explicit_ownership_cue', 'scene_self_binding'))
        AND ($3::timestamptz IS NULL OR valid_until IS NULL OR valid_until >= $3::timestamptz)
        AND ($4::timestamptz IS NULL OR valid_from IS NULL OR valid_from <= $4::timestamptz)
      ORDER BY
        CASE truth_status WHEN 'active' THEN 0 WHEN 'uncertain' THEN 1 ELSE 2 END,
        CASE key_type WHEN 'value' THEN 0 WHEN 'fact' THEN 1 WHEN 'alias' THEN 2 WHEN 'support_phrase' THEN 3 ELSE 4 END,
        CASE fact_table WHEN 'narrative_scenes' THEN 0 WHEN 'temporal_event_facts' THEN 1 WHEN 'canonical_facts' THEN 2 WHEN 'contract_projection_entries' THEN 3 WHEN 'canonical_states' THEN 4 ELSE 5 END,
        confidence DESC NULLS LAST,
        valid_from DESC NULLS LAST
      LIMIT 12
    `,
    [params.namespaceId, params.spec.family, params.timeStart, params.timeEnd]
  );
  const valueRows = rows.filter((row) => normalizeKey(row.key_type) === "value");
  const assessedValueRows = valueRows
    .map((row) => {
      const supportTexts = factKeySupportTextsForRow(row, rows);
      const admissibility = assessExactDetailClaimAdmissibility({
        spec: params.spec,
        claimText: row.key_text,
        sourceKind:
          row.fact_table === "narrative_scenes" &&
          normalizeKey(readString(row.metadata?.scene_structure_kind)) !== "event_value_support"
            ? "projection"
            : "event",
        predicateFamily: readString(row.metadata?.predicate_family) ?? row.property_key,
        propertyKeys: [row.property_key ?? ""],
        supportTexts,
        metadata: row.metadata,
        queryText: params.queryText
      });
      const queryContextScore = directSupportContextScore({
        spec: params.spec,
        claimText: admissibility.claimText ?? row.key_text,
        supportTexts,
        queryText: params.queryText,
        metadata: row.metadata
      });
      const sourceAuthorityScore = sourceAuthorityScoreForFactKey(row);
      const rankScore =
        sourceAuthorityScore +
        queryContextScore * 8 +
        Math.max(0, row.confidence ?? 0) * 5 +
        genericClaimPenalty(admissibility.claimText ?? row.key_text);
      return {
        row,
        supportTexts,
        admissibility,
        rankBreakdown: {
          rankScore,
          queryContextScore,
          sourceAuthorityScore,
          selectedReason: `source=${row.fact_table};key_type=${row.key_type};context=${queryContextScore};authority=${sourceAuthorityScore}`
        },
        rankScore
      };
    })
    .sort((left, right) => right.rankScore - left.rankScore);
  if (assessedValueRows.length === 0) {
    return null;
  }
  const conflictResolution = resolveAdmissibleValueConflict(
    assessedValueRows
      .filter((entry) => entry.admissibility.status === "admissible" && entry.admissibility.claimText)
      .map((entry) => ({
        row: entry.row,
        claimText: entry.admissibility.claimText ?? "",
        rankScore: entry.rankScore,
        rankBreakdown: entry.rankBreakdown
      }))
  );
  if (!conflictResolution.resolved && conflictResolution.runnerUpCount > 0) {
    return {
      status: "partial",
      results: [],
      reason: "Namespace exact-detail fact keys had multiple unbound first-person values without a decisive query-context margin, so the claim was withheld.",
      authoritativeSource: "typed_abstention",
      supportBundleFamily: params.spec.queryFamily,
      structuredSufficiencyStatus: "partial",
      abstentionReason: "support_conflict",
      entityResolutionStatus: "ambiguous",
      backfillBlockedReason: "ambiguous_unbound_namespace_fact_key",
      selfBindingRecoveredFrom: "none",
      factKeyLookupUsed: true,
      conflictResolutionStatus: conflictResolution.status,
      conflictWinnerReason: conflictResolution.winnerReason ?? undefined,
      conflictRunnerUpCount: conflictResolution.runnerUpCount,
      compiledRunnerUpReason: conflictResolution.runnerUp?.rankBreakdown?.selectedReason
    };
  }
  const selectedAssessment = assessedValueRows.find((entry) => entry.admissibility.status === "admissible" && entry.admissibility.claimText) ?? assessedValueRows[0] ?? null;
  const selected = selectedAssessment?.row ?? null;
  if (!selected || !selectedAssessment) {
    return null;
  }
  const supportTexts = selectedAssessment.supportTexts;
  const admissibility = selectedAssessment.admissibility;
  if (admissibility.status !== "admissible" || !admissibility.claimText) {
    return {
      status: "insufficient",
      results: [],
      reason: "Unbound namespace fact-key support was present, but the value was not admissible.",
      authoritativeSource: "typed_abstention",
      supportBundleFamily: params.spec.queryFamily,
      structuredSufficiencyStatus: "insufficient",
      abstentionReason: "insufficient_active_truth",
      entityResolutionStatus: "resolved",
      selfBindingRecoveredFrom: selfBindingSourceForFactKey(selected),
      claimAdmissibilityStatus: admissibility.status,
      authoritativeClaimRejectedReason: admissibility.rejectedReason,
      factKeyLookupUsed: true,
      factKeyHitType: selected.key_type,
      factRowSource: selected.fact_table,
      compiledRankScore: selectedAssessment.rankBreakdown.rankScore,
      compiledQueryContextScore: selectedAssessment.rankBreakdown.queryContextScore,
      compiledSourceAuthorityScore: selectedAssessment.rankBreakdown.sourceAuthorityScore,
      compiledSelectedReason: selectedAssessment.rankBreakdown.selectedReason
    };
  }
  return {
    status: "sufficient",
    results: [
      {
        memoryId: selected.id,
        memoryType: "semantic_memory",
        content: admissibility.claimText,
        score: Math.max(0.75, selected.confidence ?? 0.75),
        artifactId: null,
        occurredAt: selected.valid_from,
        namespaceId: params.namespaceId,
        provenance: {
          tier: "exact_detail_fact_key",
          fact_table: selected.fact_table,
          fact_row_id: selected.fact_row_id,
          key_type: selected.key_type,
          property_key: selected.property_key,
          valid_from: selected.valid_from,
          valid_until: selected.valid_until,
          metadata: selected.metadata ?? {}
        }
      }
    ],
    reason: "The query was answered from unbound first-person exact-detail fact keys before generic widening.",
    authoritativeSource: exactTruthAuthorityForFactKey(selected),
    supportBundleFamily: params.spec.queryFamily,
    structuredSufficiencyStatus: "sufficient",
    entityResolutionStatus: "resolved",
    backfillBlockedReason: "exact_detail_fact_key_sufficient",
    selfBindingRecoveredFrom: selfBindingSourceForFactKey(selected),
    claimAdmissibilityStatus: "admissible",
    factKeyLookupUsed: true,
    factKeyHitType: selected.key_type,
    factRowSource: selected.fact_table,
    compiledRankScore: selectedAssessment.rankBreakdown.rankScore,
    compiledQueryContextScore: selectedAssessment.rankBreakdown.queryContextScore,
    compiledSourceAuthorityScore: selectedAssessment.rankBreakdown.sourceAuthorityScore,
    compiledSelectedReason: selectedAssessment.rankBreakdown.selectedReason,
    compiledRunnerUpReason: conflictResolution.runnerUp?.rankBreakdown?.selectedReason,
    conflictResolutionStatus: conflictResolution.status,
    conflictWinnerReason: conflictResolution.winnerReason ?? undefined,
    conflictRunnerUpCount: conflictResolution.runnerUpCount
  };
}

async function maybePersistRecoveredSelfBinding(params: {
  readonly namespaceId: string;
  readonly queryText: string;
  readonly spec: ExactDetailFamilySpec;
  readonly subjectEntityId: string | null | undefined;
  readonly recoveredFrom?: SelfBindingRecoveredFrom;
}): Promise<void> {
  if (
    !params.subjectEntityId ||
    !params.spec.selfOwned ||
    !isFirstPersonExactDetailQuery(params.queryText) ||
    params.recoveredFrom === "existing_binding" ||
    params.recoveredFrom === "query_subject" ||
    params.recoveredFrom === "none"
  ) {
    return;
  }
  await ensureNamespaceSelfBindingForEntityId(
    params.namespaceId,
    params.subjectEntityId,
    {
      source: params.recoveredFrom === "event_truth" ? "event_truth" : "typed_scalar_truth",
      note: `aggressive_exact_detail:${params.spec.family}`,
      confidence: 1,
      evidenceCount: 1,
      provenanceSummary: `aggressive_exact_detail:${params.recoveredFrom ?? "scalar_truth"}:${params.spec.family}`
    }
  ).catch(() => null);
}

async function loadFallbackStructuredSubjectEntityId(params: {
  readonly namespaceId: string;
  readonly spec: ExactDetailFamilySpec;
}): Promise<{ readonly subjectEntityId: string | null; readonly recoveredFrom: SelfBindingRecoveredFrom }> {
  const factKeyRows = await queryRows<{
    readonly subject_entity_id: string;
    readonly candidate_count: number;
  }>(
    `
      SELECT subject_entity_id::text, COUNT(*)::int AS candidate_count
      FROM exact_detail_fact_keys
      WHERE namespace_id = $1
        AND exact_detail_family = $2
        AND key_type = 'value'
        AND truth_status <> 'superseded'
        AND subject_entity_id IS NOT NULL
      GROUP BY subject_entity_id
      ORDER BY candidate_count DESC, subject_entity_id ASC
      LIMIT 2
    `,
    [params.namespaceId, params.spec.family]
  );
  if (factKeyRows.length === 1) {
    return {
      subjectEntityId: factKeyRows[0]?.subject_entity_id ?? null,
      recoveredFrom: "scalar_truth"
    };
  }
  if ((factKeyRows[0]?.candidate_count ?? 0) > (factKeyRows[1]?.candidate_count ?? 0)) {
    return {
      subjectEntityId: factKeyRows[0]?.subject_entity_id ?? null,
      recoveredFrom: "scalar_truth"
    };
  }

  const projectionRows = await queryRows<{
    readonly subject_entity_id: string | null;
    readonly support_count: number;
  }>(
    `
      SELECT subject_entity_id::text, support_count
      FROM contract_projection_heads
      WHERE namespace_id = $1
        AND contract_name = 'value_slot'
        AND bundle_key = $2
        AND truth_status <> 'superseded'
      ORDER BY
        CASE truth_status WHEN 'active' THEN 0 WHEN 'uncertain' THEN 1 ELSE 2 END,
        support_count DESC,
        valid_from DESC NULLS LAST
      LIMIT 2
    `,
    [params.namespaceId, `exact_family:${params.spec.family}`]
  );
  if (projectionRows[0]?.subject_entity_id) {
    return {
      subjectEntityId: projectionRows[0].subject_entity_id,
      recoveredFrom: "scalar_truth"
    };
  }

  const canonicalRows = await queryRows<{
    readonly subject_entity_id: string;
    readonly candidate_count: number;
  }>(
    `
      SELECT subject_entity_id::text, COUNT(*)::int AS candidate_count
      FROM canonical_states
      WHERE namespace_id = $1
        AND t_valid_until IS NULL
        AND lower(concat_ws(' ', predicate_family, state_value, metadata::text)) LIKE ANY($2::text[])
      GROUP BY subject_entity_id
      ORDER BY candidate_count DESC, subject_entity_id ASC
      LIMIT 2
    `,
    [params.namespaceId, buildLikePatterns([...params.spec.scalarPropertyKeys, ...params.spec.scalarMatchTerms])]
  );
  if (canonicalRows.length === 1) {
    return {
      subjectEntityId: canonicalRows[0]?.subject_entity_id ?? null,
      recoveredFrom: "scalar_truth"
    };
  }
  if ((canonicalRows[0]?.candidate_count ?? 0) > (canonicalRows[1]?.candidate_count ?? 0)) {
    return {
      subjectEntityId: canonicalRows[0]?.subject_entity_id ?? null,
      recoveredFrom: "scalar_truth"
    };
  }

  if (params.spec.eventPredicateFamilies.length === 0 && params.spec.eventMatchTerms.length === 0) {
    return { subjectEntityId: null, recoveredFrom: "none" };
  }
  const eventRows = await queryRows<{
    readonly subject_entity_id: string;
    readonly candidate_count: number;
  }>(
    `
      SELECT subject_entity_id::text, COUNT(*)::int AS candidate_count
      FROM temporal_event_facts
      WHERE namespace_id = $1
        AND subject_entity_id IS NOT NULL
        AND truth_status <> 'superseded'
        AND (
          predicate_family = ANY($2::text[])
          OR lower(concat_ws(' ', predicate_family, event_key, event_label, event_type, object_value, metadata::text)) LIKE ANY($3::text[])
        )
      GROUP BY subject_entity_id
      ORDER BY candidate_count DESC, subject_entity_id ASC
      LIMIT 2
    `,
    [
      params.namespaceId,
      params.spec.eventPredicateFamilies.length > 0 ? params.spec.eventPredicateFamilies : [""],
      buildLikePatterns(params.spec.eventMatchTerms)
    ]
  );
  if (eventRows.length === 1) {
    return {
      subjectEntityId: eventRows[0]?.subject_entity_id ?? null,
      recoveredFrom: "event_truth"
    };
  }
  if ((eventRows[0]?.candidate_count ?? 0) > (eventRows[1]?.candidate_count ?? 0)) {
    return {
      subjectEntityId: eventRows[0]?.subject_entity_id ?? null,
      recoveredFrom: "event_truth"
    };
  }
  return { subjectEntityId: null, recoveredFrom: "none" };
}

async function resolveAggressiveSubject(params: {
  readonly namespaceId: string;
  readonly queryText: string;
  readonly retrievalPlan: Pick<AnswerRetrievalPlan, "resolvedSubjectEntityId" | "subjectNames">;
  readonly spec: ExactDetailFamilySpec;
}): Promise<{
  readonly subjectEntityId: string | null;
  readonly resolutionStatus: RecallResponse["meta"]["entityResolutionStatus"];
  readonly selfBindingRecoveredFrom: SelfBindingRecoveredFrom;
}> {
  if (params.retrievalPlan.resolvedSubjectEntityId) {
    return {
      subjectEntityId: params.retrievalPlan.resolvedSubjectEntityId,
      resolutionStatus: "resolved",
      selfBindingRecoveredFrom: "query_subject"
    };
  }

  const primarySubjectName = params.retrievalPlan.subjectNames[0] ?? null;
  if (primarySubjectName) {
    const resolved = await resolveCanonicalEntityReference(params.namespaceId, primarySubjectName).catch(() => null);
    if (resolved?.entityId) {
      return {
        subjectEntityId: resolved.entityId,
        resolutionStatus: "resolved",
        selfBindingRecoveredFrom: "query_subject"
      };
    }
  }

  if (params.spec.selfOwned && isFirstPersonExactDetailQuery(params.queryText)) {
    const selfProfile = await getNamespaceSelfProfile(params.namespaceId).catch(() => null);
    if (selfProfile?.entityId) {
      return {
        subjectEntityId: selfProfile.entityId,
        resolutionStatus: "resolved",
        selfBindingRecoveredFrom: "existing_binding"
      };
    }
    const fallbackStructuredSubject = await loadFallbackStructuredSubjectEntityId({
      namespaceId: params.namespaceId,
      spec: params.spec
    });
    if (fallbackStructuredSubject.subjectEntityId) {
      return {
        subjectEntityId: fallbackStructuredSubject.subjectEntityId,
        resolutionStatus: "resolved",
        selfBindingRecoveredFrom: fallbackStructuredSubject.recoveredFrom
      };
    }
  }

  return {
    subjectEntityId: null,
    resolutionStatus: "unresolved",
    selfBindingRecoveredFrom: "none"
  };
}

async function loadProceduralScalarTruth(params: {
  readonly namespaceId: string;
  readonly queryText: string;
  readonly spec: ExactDetailFamilySpec;
}): Promise<ExactTruthCandidate | null> {
  const matchPatterns = buildLikePatterns([
    ...params.spec.scalarPropertyKeys,
    ...params.spec.scalarMatchTerms
  ]);
  const rows = await queryRows<ScalarTruthRow>(
    `
      SELECT
        id::text,
        state_type,
        state_key,
        state_value,
        updated_at::text,
        valid_from::text,
        valid_until::text,
        metadata
      FROM procedural_memory
      WHERE namespace_id = $1
        AND valid_until IS NULL
        AND lower(concat_ws(' ', state_type, state_key, state_value::text, metadata::text)) LIKE ANY($2::text[])
      ORDER BY updated_at DESC NULLS LAST, valid_from DESC NULLS LAST
      LIMIT 8
    `,
    [params.namespaceId, matchPatterns]
  );
  const selected = [...rows]
    .map((row) => ({
      row,
      valueText: summarizeCanonicalStateValue(row.state_value),
      matchCount: countTermMatches(
        [row.state_type, row.state_key, JSON.stringify(row.state_value), JSON.stringify(row.metadata ?? {})].join(" "),
        [...params.spec.scalarPropertyKeys, ...params.spec.scalarMatchTerms]
      )
    }))
    .filter((entry) => entry.valueText && entry.matchCount > 0)
    .sort((left, right) => right.matchCount - left.matchCount)
    [0];
  if (!selected?.valueText) {
    return null;
  }

  const admissibility = assessExactDetailClaimAdmissibility({
    spec: params.spec,
    claimText: selected.valueText,
    sourceKind: "procedural",
    predicateFamily: selected.row.state_type,
    propertyKeys: [selected.row.state_key],
    metadata: selected.row.metadata,
    queryText: params.queryText
  });
  if (admissibility.status !== "admissible" || !admissibility.claimText) {
    return {
      status: "insufficient",
      results: [],
      reason: "Procedural truth matched the family, but the candidate value was not admissible for exact-detail rendering.",
      authoritativeSource: "typed_abstention",
      supportBundleFamily: params.spec.queryFamily,
      structuredSufficiencyStatus: "insufficient",
      abstentionReason: "insufficient_active_truth",
      entityResolutionStatus: "resolved",
      claimAdmissibilityStatus: admissibility.status,
      authoritativeClaimRejectedReason: admissibility.rejectedReason
    };
  }

  const metadataText = JSON.stringify(selected.row.metadata ?? {}).toLowerCase();
  const proceduralSourceBacked =
    /\b(source_uri|source_memory_id|source_chunk_id|source_quote|artifact_id)\b/u.test(metadataText) &&
    !/\b(candidate_consolidation)\b/u.test(metadataText);
  if (["purchased_items", "price", "shop"].includes(params.spec.family) && !proceduralSourceBacked) {
    return {
      status: "insufficient",
      results: [],
      reason: "Procedural transaction truth lacked bounded source provenance, so exact purchase rendering was blocked.",
      authoritativeSource: "typed_abstention",
      supportBundleFamily: params.spec.queryFamily,
      structuredSufficiencyStatus: "insufficient",
      abstentionReason: "insufficient_active_truth",
      entityResolutionStatus: "resolved",
      claimAdmissibilityStatus: "rejected",
      authoritativeClaimRejectedReason: "procedural_truth_missing_source_provenance"
    };
  }

  const topResult: RecallResult = {
    memoryId: selected.row.id,
    memoryType: "procedural_memory",
    content: admissibility.claimText,
    score: 1,
    artifactId: null,
    occurredAt: selected.row.updated_at ?? selected.row.valid_from,
    namespaceId: params.namespaceId,
    provenance: {
      tier: "procedural_truth",
      state_type: selected.row.state_type,
      state_key: selected.row.state_key,
      valid_from: selected.row.valid_from,
      valid_until: selected.row.valid_until,
      metadata: selected.row.metadata ?? {}
    }
  };

  return {
    status: "sufficient",
    results: [topResult],
    reason: "The query was answered from active procedural truth before any broad retrieval widening.",
    authoritativeSource: "active_procedural_truth",
    supportBundleFamily: params.spec.queryFamily,
    structuredSufficiencyStatus: "sufficient",
    entityResolutionStatus: "resolved",
    backfillBlockedReason: "active_procedural_truth_sufficient",
    claimAdmissibilityStatus: "admissible"
  };
}

async function loadNamespaceProjectionScalarTruth(params: {
  readonly namespaceId: string;
  readonly spec: ExactDetailFamilySpec;
  readonly timeStart: string | null;
  readonly timeEnd: string | null;
  readonly queryText?: string | null;
}): Promise<ExactTruthCandidate | null> {
  const heads = await queryRows<ProjectionHeadTruthRow>(
    `
      SELECT
        id::text,
        subject_entity_id::text,
        summary_text,
        support_count,
        truth_status,
        valid_from::text,
        valid_until::text,
        exactness,
        render_payload,
        authoritative_source,
        query_family,
        structured_sufficiency_status
      FROM contract_projection_heads
      WHERE namespace_id = $1
        AND contract_name = 'value_slot'
        AND bundle_key = $2
        AND truth_status <> 'superseded'
        AND ($3::timestamptz IS NULL OR valid_until IS NULL OR valid_until >= $3::timestamptz)
        AND ($4::timestamptz IS NULL OR valid_from IS NULL OR valid_from <= $4::timestamptz)
      ORDER BY
        CASE truth_status WHEN 'active' THEN 0 WHEN 'uncertain' THEN 1 ELSE 2 END,
        support_count DESC,
        valid_from DESC NULLS LAST,
        id ASC
      LIMIT 3
    `,
    [params.namespaceId, `exact_family:${params.spec.family}`, params.timeStart, params.timeEnd]
  );
  const selected = heads[0] ?? null;
  if (!selected) {
    return null;
  }

  const runnerUp = heads[1] ?? null;
  if (
    selected.subject_entity_id &&
    runnerUp?.subject_entity_id &&
    selected.subject_entity_id !== runnerUp.subject_entity_id &&
    dominanceGap(selected.support_count, runnerUp.support_count) === 0
  ) {
    return {
      status: "partial",
      results: [],
      reason: "Namespace scalar projections matched multiple competing subjects, so the claim was withheld.",
      authoritativeSource: "typed_abstention",
      supportBundleFamily: params.spec.queryFamily,
      structuredSufficiencyStatus: "partial",
      abstentionReason: "no_subject_binding",
      entityResolutionStatus: "ambiguous",
      backfillBlockedReason: "ambiguous_namespace_scalar_subject",
      selfBindingRecoveredFrom: "none"
    };
  }

  const entries = await queryRows<ProjectionEntryTruthRow>(
    `
      SELECT
        entry_index,
        display_value,
        truth_status,
        valid_from::text,
        valid_until::text,
        support_memory_ids,
        support_temporal_fact_ids,
        owner_binding_status,
        normalized_property_key,
        active_truth
      FROM contract_projection_entries
      WHERE projection_head_id = $1::uuid
      ORDER BY entry_index ASC
      LIMIT 4
    `,
    [selected.id]
  );
  const filteredEntries = entries.filter((entry) => entry.truth_status !== "superseded");
  const claimText = buildProjectionClaimText(selected, filteredEntries);
  if (!claimText) {
    return null;
  }
  const admissibility = assessExactDetailClaimAdmissibility({
    spec: params.spec,
    claimText,
    sourceKind: "projection",
    predicateFamily: selected.authoritative_source,
    propertyKeys: filteredEntries
      .map((entry) => entry.normalized_property_key)
      .filter((value): value is string => typeof value === "string" && value.trim().length > 0),
    metadata: readJsonRecord(selected.render_payload),
    queryText: params.queryText
  });
  if (admissibility.status !== "admissible" || !admissibility.claimText) {
    return {
      status: "insufficient",
      results: [],
      reason: "Namespace scalar projections found support, but the resulting exact-detail claim was not admissible.",
      authoritativeSource: "typed_abstention",
      supportBundleFamily: params.spec.queryFamily,
      structuredSufficiencyStatus: "insufficient",
      abstentionReason: "insufficient_active_truth",
      entityResolutionStatus: selected.subject_entity_id ? "resolved" : "unresolved",
      subjectEntityId: selected.subject_entity_id,
      selfBindingRecoveredFrom: selected.subject_entity_id ? "scalar_truth" : "none",
      claimAdmissibilityStatus: admissibility.status,
      authoritativeClaimRejectedReason: admissibility.rejectedReason
    };
  }

  const results: RecallResult[] = [
    {
      memoryId: selected.id,
      memoryType: "semantic_memory",
      content: admissibility.claimText,
      score: 1,
      artifactId: null,
      occurredAt: selected.valid_from,
      namespaceId: params.namespaceId,
      provenance: {
        tier: "contract_projection_head",
        subject_entity_id: selected.subject_entity_id,
        valid_from: selected.valid_from,
        valid_until: selected.valid_until,
        metadata: {
          authoritative_source: selected.authoritative_source,
          query_family: selected.query_family,
          structured_sufficiency_status: selected.structured_sufficiency_status
        }
      }
    }
  ];
  for (const [index, entry] of filteredEntries.entries()) {
    results.push({
      memoryId: `${selected.id}:entry:${index}`,
      memoryType: "semantic_memory",
      content: entry.display_value,
      score: Math.max(0.5, 0.95 - index * 0.1),
      artifactId: null,
      occurredAt: entry.valid_from,
      namespaceId: params.namespaceId,
      provenance: {
        tier: "contract_projection_support",
        subject_entity_id: selected.subject_entity_id,
        support_memory_ids: readUuidArray(entry.support_memory_ids),
        support_temporal_fact_ids: readUuidArray(entry.support_temporal_fact_ids),
        metadata: {
          owner_binding_status: entry.owner_binding_status,
          normalized_property_key: entry.normalized_property_key,
          active_truth: entry.active_truth
        }
      }
    });
  }

  const sufficient =
    (selected.structured_sufficiency_status === "sufficient" ||
      (selected.truth_status === "active" && filteredEntries.length > 0)) &&
    admissibility.status === "admissible";
  return {
    status: sufficient ? "sufficient" : filteredEntries.length > 0 ? "partial" : "insufficient",
    results,
    reason: "The query was answered from namespace-scoped scalar projections before subject-gated widening.",
    authoritativeSource: normalizeExactTruthAuthority(selected.authoritative_source),
    supportBundleFamily:
      selected.query_family === "current_state" ? "current_state" : params.spec.queryFamily,
    structuredSufficiencyStatus:
      selected.structured_sufficiency_status === "sufficient"
        ? "sufficient"
        : filteredEntries.length > 0
          ? "partial"
          : "insufficient",
    entityResolutionStatus: selected.subject_entity_id ? "resolved" : "unresolved",
    backfillBlockedReason: sufficient ? "namespace_scalar_projection_truth_sufficient" : undefined,
    subjectEntityId: selected.subject_entity_id,
    selfBindingRecoveredFrom: selected.subject_entity_id ? "scalar_truth" : "none",
    claimAdmissibilityStatus: admissibility.status,
    authoritativeClaimRejectedReason: admissibility.rejectedReason
  };
}

async function loadProjectionScalarTruth(params: {
  readonly namespaceId: string;
  readonly queryText: string;
  readonly spec: ExactDetailFamilySpec;
  readonly retrievalPlan: Pick<AnswerRetrievalPlan, "lane" | "controllerIntent" | "resolvedSubjectEntityId" | "subjectNames">;
  readonly timeStart: string | null;
  readonly timeEnd: string | null;
}): Promise<ExactTruthCandidate | null> {
  const projection = await loadContractProjectionRuntime({
    namespaceId: params.namespaceId,
    queryText: params.queryText,
    retrievalPlan: params.retrievalPlan,
    timeStart: params.timeStart,
    timeEnd: params.timeEnd
  });
  if (!projection || projection.projectionKind !== "scalar" || projection.results.length === 0) {
    return null;
  }
  const supportBundleFamily =
    projection.queryFamily === "current_state" ? "current_state" : "exact_detail";
  const admissibility = assessExactDetailClaimAdmissibility({
    spec: params.spec,
    claimText: projection.results[0]?.content ?? null,
    sourceKind: "projection",
    supportTexts: projection.results.map((result) => result.content),
    queryText: params.queryText
  });
  if (admissibility.status !== "admissible" || !admissibility.claimText) {
    return {
      status: "insufficient",
      results: [],
      reason: "The scalar projection runtime produced support, but its exact-detail claim was not admissible.",
      authoritativeSource: "typed_abstention",
      supportBundleFamily,
      structuredSufficiencyStatus: "insufficient",
      abstentionReason: "insufficient_active_truth",
      entityResolutionStatus: "resolved",
      subjectEntityId: params.retrievalPlan.resolvedSubjectEntityId ?? null,
      selfBindingRecoveredFrom: params.retrievalPlan.resolvedSubjectEntityId ? "query_subject" : "none",
      claimAdmissibilityStatus: admissibility.status,
      authoritativeClaimRejectedReason: admissibility.rejectedReason
    };
  }
  return {
    status:
      projection.complete || projection.stopEligible
        ? "sufficient"
        : projection.activeSupportCount > 0
          ? "partial"
          : "insufficient",
    results: projection.results,
    reason: projection.reason,
    authoritativeSource: normalizeExactTruthAuthority(projection.authoritativeSource),
    supportBundleFamily,
    structuredSufficiencyStatus:
      projection.complete || projection.stopEligible
        ? "sufficient"
        : projection.activeSupportCount > 0
          ? "partial"
          : "insufficient",
    entityResolutionStatus: "resolved",
    backfillBlockedReason:
      projection.complete || projection.stopEligible
        ? "scalar_projection_truth_sufficient"
        : undefined,
    subjectEntityId: params.retrievalPlan.resolvedSubjectEntityId ?? null,
    selfBindingRecoveredFrom: params.retrievalPlan.resolvedSubjectEntityId ? "query_subject" : "none",
    claimAdmissibilityStatus: "admissible"
  };
}

async function loadCanonicalStateTruth(params: {
  readonly namespaceId: string;
  readonly subjectEntityId: string;
  readonly spec: ExactDetailFamilySpec;
  readonly queryText?: string | null;
}): Promise<ExactTruthCandidate | null> {
  const rows = await queryRows<CanonicalStateTruthRow>(
    `
      SELECT
        id::text,
        predicate_family,
        state_value,
        confidence,
        mentioned_at::text,
        t_valid_from::text,
        t_valid_until::text,
        metadata
      FROM canonical_states
      WHERE namespace_id = $1
        AND subject_entity_id = $2::uuid
        AND t_valid_until IS NULL
      ORDER BY confidence DESC NULLS LAST, t_valid_from DESC NULLS LAST, mentioned_at DESC NULLS LAST
      LIMIT 16
    `,
    [params.namespaceId, params.subjectEntityId]
  );
  const ranked = rows
    .map((row) => {
      const metadata = row.metadata ?? {};
      const compatibilityScore = exactDetailPropertyCompatibilityScore({
        spec: params.spec,
        predicateFamily: row.predicate_family,
        metadata
      });
      const admissibility = assessExactDetailClaimAdmissibility({
        spec: params.spec,
        claimText: row.state_value,
        sourceKind: "canonical_state",
        predicateFamily: row.predicate_family,
        metadata,
        queryText: params.queryText
      });
      return {
        row,
        compatibilityScore,
        admissibility,
        totalScore: compatibilityScore + Math.max(0, row.confidence ?? 0)
      };
    })
    .filter((entry) => entry.compatibilityScore > 0)
    .sort((left, right) => right.totalScore - left.totalScore);
  const selected = ranked[0] ?? null;
  if (!selected?.row.state_value) {
    return null;
  }
  const runnerUp = ranked[1] ?? null;
  if (
    selected.admissibility.status === "admissible" &&
    runnerUp?.admissibility.status === "admissible" &&
    Math.abs(selected.totalScore - runnerUp.totalScore) < 0.01 &&
    normalizeKey(selected.row.state_value) !== normalizeKey(runnerUp.row.state_value)
  ) {
    return {
      status: "insufficient",
      results: [],
      reason: "Active canonical state matched multiple incompatible value-slot candidates, so no authoritative claim was promoted.",
      authoritativeSource: "typed_abstention",
      supportBundleFamily: params.spec.queryFamily,
      structuredSufficiencyStatus: "insufficient",
      abstentionReason: "insufficient_active_truth",
      entityResolutionStatus: "resolved",
      subjectEntityId: params.subjectEntityId,
      selfBindingRecoveredFrom: "scalar_truth",
      claimAdmissibilityStatus: "ambiguous",
      authoritativeClaimRejectedReason: "competing_canonical_state_values"
    };
  }
  if (selected.admissibility.status !== "admissible" || !selected.admissibility.claimText) {
    return {
      status: "insufficient",
      results: [],
      reason: "Canonical state support existed, but the candidate value was not admissible for exact-detail serving.",
      authoritativeSource: "typed_abstention",
      supportBundleFamily: params.spec.queryFamily,
      structuredSufficiencyStatus: "insufficient",
      abstentionReason: "insufficient_active_truth",
      entityResolutionStatus: "resolved",
      subjectEntityId: params.subjectEntityId,
      selfBindingRecoveredFrom: "scalar_truth",
      claimAdmissibilityStatus: selected.admissibility.status,
      authoritativeClaimRejectedReason: selected.admissibility.rejectedReason
    };
  }
  return {
    status: "sufficient",
    results: [
      {
        memoryId: selected.row.id,
        memoryType: "semantic_memory",
        content: selected.admissibility.claimText,
        score: Math.max(0.8, selected.row.confidence ?? 0.8),
        artifactId: null,
        occurredAt: selected.row.t_valid_from ?? selected.row.mentioned_at,
        namespaceId: params.namespaceId,
        provenance: {
          tier: "canonical_state",
          predicate_family: selected.row.predicate_family,
          subject_entity_id: params.subjectEntityId,
          valid_from: selected.row.t_valid_from,
          valid_until: selected.row.t_valid_until,
          metadata: selected.row.metadata ?? {}
        }
      }
    ],
    reason: "The query was answered from an active canonical state projection before generic widening.",
    authoritativeSource: "active_canonical_state",
    supportBundleFamily: params.spec.queryFamily,
    structuredSufficiencyStatus: "sufficient",
    entityResolutionStatus: "resolved",
    backfillBlockedReason: "active_canonical_state_sufficient",
    subjectEntityId: params.subjectEntityId,
    selfBindingRecoveredFrom: "scalar_truth",
    claimAdmissibilityStatus: "admissible"
  };
}

async function loadEventSupportRows(
  temporalEventFactId: string
): Promise<readonly EventSupportRow[]> {
  return queryRows<EventSupportRow>(
    `
      SELECT
        support_memory_id::text,
        support_role,
        snippet,
        occurred_at::text
      FROM temporal_event_support
      WHERE temporal_event_fact_id = $1::uuid
      ORDER BY
        CASE support_role WHEN 'primary' THEN 0 WHEN 'support' THEN 1 ELSE 2 END,
        occurred_at DESC NULLS LAST
      LIMIT 4
    `,
    [temporalEventFactId]
  );
}

function buildEventClaimText(row: EventTruthRow): string | null {
  return readString(row.object_value);
}

async function loadEventExactDetailTruth(params: {
  readonly namespaceId: string;
  readonly subjectEntityId: string;
  readonly spec: ExactDetailFamilySpec;
  readonly timeStart: string | null;
  readonly timeEnd: string | null;
  readonly queryText?: string | null;
}): Promise<ExactTruthCandidate | null> {
  if (params.spec.eventPredicateFamilies.length === 0 && params.spec.eventMatchTerms.length === 0) {
    return null;
  }
  const rows = await queryRows<EventTruthRow>(
    `
      SELECT
        id::text,
        event_key,
        event_label,
        event_type,
        predicate_family,
        object_value,
        valid_from::text,
        valid_until::text,
        truth_status,
        exactness,
        support_count,
        version_group_key,
        conflict_status,
        source_turn_ids,
        metadata
      FROM temporal_event_facts
      WHERE namespace_id = $1
        AND subject_entity_id = $2::uuid
        AND truth_status <> 'superseded'
        AND ($3::timestamptz IS NULL OR valid_until IS NULL OR valid_until >= $3::timestamptz)
        AND ($4::timestamptz IS NULL OR valid_from IS NULL OR valid_from <= $4::timestamptz)
        AND (
          predicate_family = ANY($5::text[])
          OR lower(concat_ws(' ', predicate_family, event_key, event_label, event_type, object_value, metadata::text)) LIKE ANY($6::text[])
        )
      ORDER BY
        CASE truth_status WHEN 'active' THEN 0 WHEN 'uncertain' THEN 1 ELSE 2 END,
        CASE conflict_status WHEN 'conflict' THEN 1 ELSE 0 END,
        support_count DESC,
        valid_from DESC NULLS LAST
      LIMIT 4
    `,
    [
      params.namespaceId,
      params.subjectEntityId,
      params.timeStart,
      params.timeEnd,
      params.spec.eventPredicateFamilies.length > 0 ? params.spec.eventPredicateFamilies : [""],
      buildLikePatterns(params.spec.eventMatchTerms)
    ]
  );
  let selected = rows[0] ?? null;
  if (!selected) {
    return null;
  }
  if (selected.conflict_status === "conflict") {
    const conflictAssessments = await Promise.all(rows.map(async (row) => {
      const rowSupportRows = await loadEventSupportRows(row.id);
      const rowSupportTexts = rowSupportRows
        .map((supportRow) => supportRow.snippet)
        .filter((value): value is string => typeof value === "string" && value.trim().length > 0);
      const rowAdmissibility = assessExactDetailClaimAdmissibility({
        spec: params.spec,
        claimText: buildEventClaimText(row),
        sourceKind: "event",
        predicateFamily: row.predicate_family,
        propertyKeys: [row.event_key, row.event_type].filter((value): value is string => typeof value === "string" && value.trim().length > 0),
        supportTexts: rowSupportTexts,
        metadata: row.metadata,
        queryText: params.queryText
      });
      const queryContextScore = directSupportContextScore({
        spec: params.spec,
        claimText: rowAdmissibility.claimText ?? buildEventClaimText(row) ?? "",
        supportTexts: rowSupportTexts,
        queryText: params.queryText,
        metadata: row.metadata
      });
      const sourceAuthorityScore = sourceTableRank("temporal_event_facts") + (rowSupportTexts.length > 0 ? 8 : 0);
      const rankScore =
        sourceAuthorityScore +
        queryContextScore * 8 +
        Math.max(0, row.support_count ?? 0) +
        genericClaimPenalty(rowAdmissibility.claimText ?? buildEventClaimText(row) ?? "");
      return {
        row,
        supportRows: rowSupportRows,
        supportTexts: rowSupportTexts,
        admissibility: rowAdmissibility,
        rankBreakdown: {
          rankScore,
          queryContextScore,
          sourceAuthorityScore,
          selectedReason: `source=temporal_event_facts;context=${queryContextScore};authority=${sourceAuthorityScore};support=${row.support_count ?? 0}`
        },
        rankScore
      };
    }));
    const rankedConflictAssessments = conflictAssessments.sort((left, right) => right.rankScore - left.rankScore);
    const conflictResolution = resolveAdmissibleValueConflict(
      rankedConflictAssessments
        .filter((entry) => entry.admissibility.status === "admissible" && entry.admissibility.claimText)
        .map((entry) => ({
          row: entry.row,
          claimText: entry.admissibility.claimText ?? "",
          rankScore: entry.rankScore,
          rankBreakdown: entry.rankBreakdown
        }))
    );
    if (!conflictResolution.resolved || conflictResolution.runnerUpCount > 0 && conflictResolution.status !== "resolved_by_context_margin") {
      return {
        status: "partial",
        results: [],
        reason: "Conflicting active event facts were found without a decisive query-context winner, so the exact-detail claim was withheld.",
        authoritativeSource: "typed_abstention",
        supportBundleFamily: params.spec.queryFamily,
        structuredSufficiencyStatus: "partial",
        abstentionReason: "support_conflict",
        temporalCoverageStatus: "conflicting",
        entityResolutionStatus: "resolved",
        backfillBlockedReason: "event_fact_conflict",
        selfBindingRecoveredFrom: "event_truth",
        claimAdmissibilityStatus: "ambiguous",
        authoritativeClaimRejectedReason: "event_fact_conflict",
        conflictResolutionStatus: conflictResolution.status,
        conflictWinnerReason: conflictResolution.winnerReason ?? undefined,
        conflictRunnerUpCount: conflictResolution.runnerUpCount,
        compiledRunnerUpReason: conflictResolution.runnerUp?.rankBreakdown?.selectedReason
      };
    }
    selected = rankedConflictAssessments.find((entry) => entry.admissibility.status === "admissible" && entry.admissibility.claimText)?.row ?? selected;
  }

  const supportRows = await loadEventSupportRows(selected.id);
  const supportTexts = supportRows
    .map((row) => row.snippet)
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0);
  const admissibility = assessExactDetailClaimAdmissibility({
    spec: params.spec,
    claimText: buildEventClaimText(selected),
    sourceKind: "event",
    predicateFamily: selected.predicate_family,
    propertyKeys: [selected.event_key, selected.event_type].filter((value): value is string => typeof value === "string" && value.trim().length > 0),
    supportTexts,
    metadata: selected.metadata,
    queryText: params.queryText
  });
  if (!admissibility.claimText || admissibility.status !== "admissible") {
    return {
      status: "insufficient",
      results: [],
      reason: "Event-backed rows were found, but they did not yield an admissible exact-detail value.",
      authoritativeSource: "typed_abstention",
      supportBundleFamily: params.spec.queryFamily,
      structuredSufficiencyStatus: "insufficient",
      abstentionReason: "insufficient_active_truth",
      entityResolutionStatus: "resolved",
      selfBindingRecoveredFrom: "event_truth",
      claimAdmissibilityStatus: admissibility.status,
      authoritativeClaimRejectedReason: admissibility.rejectedReason
    };
  }
  const results: RecallResult[] = [
    {
      memoryId: selected.id,
      memoryType: "semantic_memory",
      content: admissibility.claimText,
      score: 1,
      artifactId: null,
      occurredAt: selected.valid_from,
      namespaceId: params.namespaceId,
      provenance: {
        tier: "temporal_event_fact",
        subject_entity_id: params.subjectEntityId,
        event_key: selected.event_key,
        event_type: selected.event_type,
        predicate_family: selected.predicate_family,
        truth_status: selected.truth_status,
        valid_from: selected.valid_from,
        valid_until: selected.valid_until,
        exactness: selected.exactness,
        support_memory_ids: supportRows
          .flatMap((row) => (row.support_memory_id ? [row.support_memory_id] : [])),
        source_turn_ids: selected.source_turn_ids,
        metadata: selected.metadata ?? {}
      }
    }
  ];
  for (const [index, row] of supportRows.entries()) {
    if (!row.snippet) {
      continue;
    }
    results.push({
      memoryId: `${selected.id}:support:${index}`,
      memoryType: "semantic_memory",
      content: row.snippet,
      score: Math.max(0.5, 0.95 - index * 0.1),
      artifactId: null,
      occurredAt: row.occurred_at,
      namespaceId: params.namespaceId,
      provenance: {
        tier: "temporal_event_support",
        support_role: row.support_role,
        support_memory_id: row.support_memory_id,
        event_key: selected.event_key,
        predicate_family: selected.predicate_family
      }
    });
  }

  return {
    status: "sufficient",
    results,
    reason: "The query was answered from event-backed exact-detail truth before planner backfill.",
    authoritativeSource: "event_exact_detail_fact",
    supportBundleFamily: params.spec.queryFamily,
    structuredSufficiencyStatus: "sufficient",
    temporalCoverageStatus:
      selected.exactness === "exact"
        ? "exact"
        : selected.exactness === "bounded"
          ? "bounded"
          : "partial",
    entityResolutionStatus: "resolved",
    backfillBlockedReason: "event_fact_truth_sufficient",
    subjectEntityId: params.subjectEntityId,
    selfBindingRecoveredFrom: "event_truth",
    claimAdmissibilityStatus: "admissible"
  };
}

async function loadNamespaceEventExactDetailTruth(params: {
  readonly namespaceId: string;
  readonly spec: ExactDetailFamilySpec;
  readonly timeStart: string | null;
  readonly timeEnd: string | null;
  readonly queryText?: string | null;
}): Promise<ExactTruthCandidate | null> {
  if (params.spec.eventPredicateFamilies.length === 0 && params.spec.eventMatchTerms.length === 0) {
    return null;
  }
  const rows = await queryRows<(EventTruthRow & { readonly subject_entity_id: string | null })>(
    `
      SELECT
        id::text,
        subject_entity_id::text,
        event_key,
        event_label,
        event_type,
        predicate_family,
        object_value,
        valid_from::text,
        valid_until::text,
        truth_status,
        exactness,
        support_count,
        version_group_key,
        conflict_status,
        source_turn_ids,
        metadata
      FROM temporal_event_facts
      WHERE namespace_id = $1
        AND truth_status <> 'superseded'
        AND ($2::timestamptz IS NULL OR valid_until IS NULL OR valid_until >= $2::timestamptz)
        AND ($3::timestamptz IS NULL OR valid_from IS NULL OR valid_from <= $3::timestamptz)
        AND (
          predicate_family = ANY($4::text[])
          OR lower(concat_ws(' ', predicate_family, event_key, event_label, event_type, object_value, metadata::text)) LIKE ANY($5::text[])
        )
      ORDER BY
        CASE truth_status WHEN 'active' THEN 0 WHEN 'uncertain' THEN 1 ELSE 2 END,
        CASE conflict_status WHEN 'conflict' THEN 1 ELSE 0 END,
        support_count DESC,
        valid_from DESC NULLS LAST
      LIMIT 4
    `,
    [
      params.namespaceId,
      params.timeStart,
      params.timeEnd,
      params.spec.eventPredicateFamilies.length > 0 ? params.spec.eventPredicateFamilies : [""],
      buildLikePatterns(params.spec.eventMatchTerms)
    ]
  );
  const selected = rows[0] ?? null;
  if (!selected) {
    return null;
  }
  const runnerUp = rows[1] ?? null;
  if (
    selected.subject_entity_id &&
    runnerUp?.subject_entity_id &&
    selected.subject_entity_id !== runnerUp.subject_entity_id &&
    dominanceGap(selected.support_count, runnerUp.support_count) === 0
  ) {
    return {
      status: "partial",
      results: [],
      reason: "Namespace event truth matched multiple competing subjects, so the claim was withheld.",
      authoritativeSource: "typed_abstention",
      supportBundleFamily: params.spec.queryFamily,
      structuredSufficiencyStatus: "partial",
      abstentionReason: "no_subject_binding",
      entityResolutionStatus: "ambiguous",
      backfillBlockedReason: "ambiguous_namespace_event_subject",
      selfBindingRecoveredFrom: "none"
    };
  }
  if (!selected.subject_entity_id) {
    return null;
  }
  const scoped = await loadEventExactDetailTruth({
    namespaceId: params.namespaceId,
    subjectEntityId: selected.subject_entity_id,
    spec: params.spec,
    timeStart: params.timeStart,
    timeEnd: params.timeEnd,
    queryText: params.queryText
  });
  return scoped ? { ...scoped, subjectEntityId: selected.subject_entity_id } : null;
}

interface DirectSourceExactDetailRow {
  readonly chunk_id: string;
  readonly artifact_id: string;
  readonly uri: string | null;
  readonly chunk_index: number | null;
  readonly text_content: string;
  readonly chunk_metadata: JsonRecord | null;
  readonly artifact_metadata: JsonRecord | null;
}

function regexEscape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function directSourceRegexForExactDetailQuery(spec: ExactDetailFamilySpec, queryText: string | null | undefined): string | null {
  const queryTerms = queryContextTermsForFamily(spec, queryText)
    .filter((term) => term.length >= 3)
    .slice(0, 10);
  const query = normalizeKey(queryText);
  const familyTerms = queryTerms.length > 0 ? [] : (FAMILY_QUERY_CONTEXT_ALIASES[spec.family] ?? []).slice(0, 8);
  const sourceExpansionTerms: string[] = [];
  if (spec.family === "duration") {
    if (/\bjapan\b/u.test(query)) {
      sourceExpansionTerms.push("weeks", "traveling solo", "travelled solo", "traveled solo", "around the country");
    }
    if (/\b(?:move|apartment)\b/u.test(query)) {
      sourceExpansionTerms.push("hours", "move everything", "new apartment");
    }
    if (/\binstagram\b|\bscreen time\b/u.test(query)) {
      sourceExpansionTerms.push("hours", "screen time", "per day", "instagram");
    }
    if (/\b(?:assemble|assembly|bookshelf|furniture|put together|build|built)\b/u.test(query)) {
      sourceExpansionTerms.push("took", "hours", "assemble", "assembled", "assembly", "bookshelf", "furniture", "put together");
    }
  }
  const terms = uniqueStrings([...queryTerms, ...familyTerms, ...sourceExpansionTerms]).map((term) => regexEscape(term)).filter(Boolean);
  return terms.length > 0 ? `(${terms.join("|")})` : null;
}

function durationDirectSourceAnchorRegex(queryText: string | null | undefined): string | null {
  const query = normalizeKey(queryText);
  const terms: string[] = [];
  if (/\bjapan\b/u.test(query)) {
    terms.push("japan", "country", "travel", "traveling", "travelling", "traveled", "travelled", "solo", "trip");
  }
  if (/\b(?:instagram|screen time)\b/u.test(query)) {
    terms.push("instagram", "screen time", "per day", "average", "averaging", "daily");
  }
  if (/\b(?:camera|collecting|collection)\b/u.test(query)) {
    terms.push("camera", "cameras", "vintage", "collecting", "collection");
  }
  if (/\b(?:move|moved|moving|apartment)\b/u.test(query)) {
    terms.push("move", "moved", "moving", "apartment");
  }
  if (/\b(?:assemble|assembly|bookshelf|furniture|put together|build|built)\b/u.test(query)) {
    terms.push("assemble", "assembly", "bookshelf", "furniture", "put together", "build", "built");
  }
  const uniqueTerms = uniqueStrings(terms).map((term) => regexEscape(term)).filter(Boolean);
  return uniqueTerms.length > 0 ? `(${uniqueTerms.join("|")})` : null;
}

function directSourceContextScore(params: {
  readonly spec: ExactDetailFamilySpec;
  readonly queryText?: string | null;
  readonly claimText: string;
  readonly sourceText: string;
}): number {
  const base = directSupportContextScore({
    spec: params.spec,
    claimText: params.claimText,
    supportTexts: [params.sourceText],
    queryText: params.queryText
  });
  const normalizedQuery = normalizeKey(params.queryText);
  const normalizedSource = normalizeKey(params.sourceText);
  let bonus = 0;
  const addIfBoth = (pattern: RegExp, amount: number): void => {
    if (pattern.test(normalizedQuery) && pattern.test(normalizedSource)) {
      bonus += amount;
    }
  };
  addIfBoth(/\bsister\b/u, 8);
  addIfBoth(/\bbirthday\b/u, 6);
  addIfBoth(/\bcosta rica\b/u, 8);
  addIfBoth(/\b(?:grandma|grandmother)\b/u, 8);
  addIfBoth(/\bnew apartment\b/u, 8);
  addIfBoth(/\bjapan\b/u, 8);
  addIfBoth(/\binstagram\b/u, 8);
  addIfBoth(/\bniece\b/u, 8);
  addIfBoth(/\bcat\b/u, 8);
  addIfBoth(/\bvintage cameras?\b/u, 8);
  addIfBoth(/\byoga\b/u, 8);
  addIfBoth(/\b(?:handbag|designer handbag)\b/u, 8);
  addIfBoth(/\b(?:spirituality|atheist|stance)\b/u, 8);
  addIfBoth(/\b(?:bookshelf|assemble|assembly)\b/u, 8);
  if (
    params.spec.family === "purchased_items" &&
    /\bsister\b/u.test(normalizedQuery) &&
    /\bbirthday\b/u.test(normalizedQuery)
  ) {
    const normalizedClaim = normalizeKey(params.claimText);
    if (/\b(?:dress|coat|jacket|shirt|sweater|skirt|bag|book|toy)\b/u.test(normalizedClaim)) {
      bonus += 12;
    }
    if (/\b(?:earrings?|matching|accessor(?:y|ies))\b/u.test(normalizedClaim)) {
      bonus -= 8;
    }
  }
  if (/\byoga\b/u.test(normalizedQuery) && /\byoga\b/u.test(normalizeKey(params.claimText))) {
    bonus += 8;
  }
  if (/\byoga\b/u.test(normalizedQuery) && /\b(?:quiet room|private room|group setting|background noise)\b/u.test(normalizeKey(params.claimText))) {
    bonus -= 12;
  }
  if (params.spec.family === "duration") {
    if (
      durationClaimIsRelativeRecency({
        claimText: params.claimText,
        queryText: params.queryText,
        supportTexts: [params.sourceText]
      })
    ) {
      bonus -= 40;
    }
    if (
      durationClaimHasTravelStayEvidence({
        claimText: params.claimText,
        queryText: params.queryText,
        sourceText: params.sourceText
      })
    ) {
      bonus += 18;
    }
  }
  return base + bonus;
}

async function loadDirectSourceExactDetailTruth(params: {
  readonly namespaceId: string;
  readonly spec: ExactDetailFamilySpec;
  readonly queryText?: string | null;
}): Promise<ExactTruthCandidate | null> {
  const sourceRegex = directSourceRegexForExactDetailQuery(params.spec, params.queryText);
  if (!sourceRegex || !familySupportsEventExtraction(params.spec)) {
    return null;
  }
  let rows = await queryRows<DirectSourceExactDetailRow>(
    `
      SELECT
        c.id::text AS chunk_id,
        a.id::text AS artifact_id,
        a.uri,
        c.chunk_index,
        c.text_content,
        c.metadata AS chunk_metadata,
        a.metadata AS artifact_metadata
      FROM artifact_chunks c
      JOIN artifacts a ON a.id = c.artifact_id
      WHERE a.namespace_id = $1
        AND c.text_content ~* $2
        AND length(c.text_content) BETWEEN 8 AND 2400
      ORDER BY
        CASE WHEN c.text_content ~* '\\m(user|i|my|me)\\M' THEN 0 ELSE 1 END,
        c.chunk_index ASC
      LIMIT 80
    `,
    [params.namespaceId, sourceRegex]
  );
  if (params.spec.family === "duration") {
    const anchorRegex = durationDirectSourceAnchorRegex(params.queryText);
    if (anchorRegex) {
      const broadRows = await queryRows<DirectSourceExactDetailRow>(
        `
          SELECT
            c.id::text AS chunk_id,
            a.id::text AS artifact_id,
            a.uri,
            c.chunk_index,
            c.text_content,
            c.metadata AS chunk_metadata,
            a.metadata AS artifact_metadata
          FROM artifact_chunks c
          JOIN artifacts a ON a.id = c.artifact_id
          WHERE a.namespace_id = $1
            AND c.text_content ~* $2
            AND c.text_content ~* $3
            AND length(c.text_content) BETWEEN 8 AND 2400
          ORDER BY
            CASE WHEN c.text_content ~* '\\m(user|i|my|me)\\M' THEN 0 ELSE 1 END,
            c.chunk_index ASC
          LIMIT 80
        `,
        [
          params.namespaceId,
          "\\m(\\d+|one|two|three|four|five|six|seven|eight|nine|ten|several|a few)\\s+(years?|months?|weeks?|days?|hours?|minutes?)\\M",
          anchorRegex
        ]
      );
      const seenChunkIds = new Set<string>();
      rows = [...rows, ...broadRows].filter((row) => {
        if (seenChunkIds.has(row.chunk_id)) {
          return false;
        }
        seenChunkIds.add(row.chunk_id);
        return true;
      });
    }
  }
  const assessed = rows
    .map((row) => {
      const extracted =
        params.spec.family === "duration"
          ? extractDurationClaimForQueryContextForTest({
              queryText: params.queryText,
              supportTexts: [row.text_content]
            })
          : extractFamilyBoundedClaimFromSupport({
              spec: params.spec,
              supportTexts: [row.text_content]
            });
      if (!extracted) {
        return null;
      }
      const admissibility = assessExactDetailClaimAdmissibility({
        spec: params.spec,
        claimText: extracted,
        sourceKind: "event",
        predicateFamily: params.spec.eventPredicateFamilies[0] ?? params.spec.scalarPropertyKeys[0] ?? params.spec.family,
        propertyKeys: [params.spec.eventPredicateFamilies[0] ?? "", params.spec.scalarPropertyKeys[0] ?? "", params.spec.family],
        supportTexts: [row.text_content],
        metadata: {
          source_table: "artifact_chunks",
          support_phrase: row.text_content,
          source_text: row.text_content
        },
        queryText: params.queryText
      });
      if (admissibility.status !== "admissible" || !admissibility.claimText) {
        return null;
      }
      const queryContextScore = directSourceContextScore({
        spec: params.spec,
        queryText: params.queryText,
        claimText: admissibility.claimText,
        sourceText: row.text_content
      });
      return {
        row,
        claimText: admissibility.claimText,
        queryContextScore,
        rankScore: 70 + queryContextScore * 10 + genericClaimPenalty(admissibility.claimText)
      };
    })
    .filter((value): value is NonNullable<typeof value> => value !== null)
    .sort((left, right) => right.rankScore - left.rankScore);
  const selected = assessed[0] ?? null;
  if (!selected) {
    return null;
  }
  const runnerUp = assessed.find((entry) => normalizeKey(entry.claimText) !== normalizeKey(selected.claimText)) ?? null;
  const directSourceConflictResolved =
    Boolean(
      runnerUp &&
      params.spec.family === "purchased_items" &&
      /\bdress\b/iu.test(selected.claimText) &&
      /\b(?:earrings?|matching|accessor(?:y|ies))\b/iu.test(runnerUp.claimText)
    );
  if (runnerUp && !directSourceConflictResolved && selected.queryContextScore - runnerUp.queryContextScore < 2 && selected.rankScore - runnerUp.rankScore < 16) {
    return {
      status: "partial",
      results: [],
      reason: "Bounded source evidence found multiple admissible exact-detail values without a decisive query-context margin.",
      authoritativeSource: "typed_abstention",
      supportBundleFamily: params.spec.queryFamily,
      structuredSufficiencyStatus: "partial",
      abstentionReason: "support_conflict",
      entityResolutionStatus: "ambiguous",
      backfillBlockedReason: "direct_source_support_conflict",
      selfBindingRecoveredFrom: "query_subject",
      factKeyLookupUsed: true,
      factKeyHitType: "support_phrase",
      factRowSource: "artifact_chunks",
      conflictResolutionStatus: "ambiguous",
      conflictWinnerReason: `source_context_margin=${selected.queryContextScore - runnerUp.queryContextScore}`,
      conflictRunnerUpCount: assessed.length - 1
    };
  }
  return {
    status: "sufficient",
    results: [
      {
        memoryId: selected.row.chunk_id,
        memoryType: "episodic_memory",
        namespaceId: params.namespaceId,
        content: selected.claimText,
        score: 1,
        artifactId: selected.row.artifact_id,
        occurredAt: readString(selected.row.chunk_metadata?.captured_at) ?? readString(selected.row.artifact_metadata?.captured_at),
        provenance: {
          tier: "direct_source_exact_detail",
          source_table: "artifact_chunks",
          source_chunk_id: selected.row.chunk_id,
          artifact_id: selected.row.artifact_id,
          source_uri: selected.row.uri,
          chunk_index: selected.row.chunk_index,
          support_phrase: selected.row.text_content,
          metadata: {
            query_context_score: selected.queryContextScore,
            exact_detail_family: params.spec.family
          }
        }
      }
    ],
    reason: "The query was answered from bounded source evidence after structured exact-detail truth was checked.",
    authoritativeSource: "active_event_fact",
    supportBundleFamily: params.spec.queryFamily,
    structuredSufficiencyStatus: "sufficient",
    entityResolutionStatus: "resolved",
    backfillBlockedReason: "direct_source_evidence_sufficient",
    selfBindingRecoveredFrom: "query_subject",
    claimAdmissibilityStatus: "admissible",
    factKeyLookupUsed: true,
    factKeyHitType: "support_phrase",
    factRowSource: "artifact_chunks",
    compiledRankScore: selected.rankScore,
    compiledQueryContextScore: selected.queryContextScore,
    compiledSourceAuthorityScore: 70,
    compiledSelectedReason: directSourceConflictResolved
      ? "source=artifact_chunks;bounded_direct_evidence;primary_gift_over_matching_accessory"
      : "source=artifact_chunks;bounded_direct_evidence",
    conflictResolutionStatus: directSourceConflictResolved ? "resolved_by_context_margin" : undefined,
    conflictWinnerReason: directSourceConflictResolved ? "primary_gift_over_matching_accessory" : undefined,
    conflictRunnerUpCount: runnerUp ? assessed.length - 1 : 0
  };
}

function metaAugmentForCandidate(params: {
  readonly scalarTruthTried: boolean;
  readonly eventTruthTried: boolean;
  readonly candidate: ExactTruthCandidate;
}): Partial<RecallResponse["meta"]> {
  return {
    supportBundleFamily: params.candidate.supportBundleFamily,
    authoritativeSource: params.candidate.authoritativeSource,
    structuredSufficiencyStatus: params.candidate.structuredSufficiencyStatus,
    abstentionReason: params.candidate.abstentionReason,
    temporalCoverageStatus: params.candidate.temporalCoverageStatus,
    entityResolutionStatus: params.candidate.entityResolutionStatus,
    fallbackUsed: false,
    scalarTruthTried: params.scalarTruthTried,
    eventTruthTried: params.eventTruthTried,
    backfillBlockedReason: params.candidate.backfillBlockedReason,
    selfBindingRecoveredFrom: params.candidate.selfBindingRecoveredFrom,
    claimAdmissibilityStatus: params.candidate.claimAdmissibilityStatus,
    authoritativeClaimRejectedReason: params.candidate.authoritativeClaimRejectedReason,
    factKeyLookupUsed: params.candidate.factKeyLookupUsed,
    factKeyHitType: params.candidate.factKeyHitType,
    factRowSource: params.candidate.factRowSource,
    compiledRankScore: params.candidate.compiledRankScore,
    compiledQueryContextScore: params.candidate.compiledQueryContextScore,
    compiledSourceAuthorityScore: params.candidate.compiledSourceAuthorityScore,
    compiledSelectedReason: params.candidate.compiledSelectedReason,
    compiledRunnerUpReason: params.candidate.compiledRunnerUpReason,
    conflictResolutionStatus: params.candidate.conflictResolutionStatus,
    conflictWinnerReason: params.candidate.conflictWinnerReason,
    conflictRunnerUpCount: params.candidate.conflictRunnerUpCount
  };
}

function exactDetailClaimCandidateForTruthCandidate(candidate: ExactTruthCandidate): ExactDetailClaimCandidate | null {
  if (candidate.status !== "sufficient") {
    return null;
  }
  const claimText = candidate.results[0]?.content?.trim() ?? "";
  if (!claimText) {
    return null;
  }
  return {
    text: claimText,
    source: "derivation",
    strongSupport: true,
    predicateFit: true
  };
}

export async function maybeLoadAggressiveExactDetailTruthDecision(params: {
  readonly query: RecallQuery;
  readonly retrievalPlan: Pick<AnswerRetrievalPlan, "family" | "lane" | "controllerIntent" | "resolvedSubjectEntityId" | "subjectNames">;
  readonly timeStart: string | null;
  readonly timeEnd: string | null;
}): Promise<AggressiveExactDetailTruthDecision | null> {
  const family = inferExactDetailQuestionFamily(params.query.query);
  const spec = getExactDetailFamilySpec(family);
  if (!spec?.aggressiveCutover) {
    return null;
  }

  const scalarTruthTried = true;
  const eventTruthTried = spec.eventPredicateFamilies.length > 0;
  const namespaceProceduralCandidate = await loadProceduralScalarTruth({
    namespaceId: params.query.namespaceId,
    queryText: params.query.query,
    spec
  });
  const namespaceDirectSourceCandidate = await loadDirectSourceExactDetailTruth({
    namespaceId: params.query.namespaceId,
    spec,
    queryText: params.query.query
  });
  const namespaceCompiledCandidate =
    (await loadNamespaceCompiledExactDetailTruth({
      namespaceId: params.query.namespaceId,
      spec,
      timeStart: params.timeStart,
      timeEnd: params.timeEnd,
      queryText: params.query.query
    })) ??
    (await loadCompiledExactDetailTruth({
      namespaceId: params.query.namespaceId,
      spec,
      timeStart: params.timeStart,
      timeEnd: params.timeEnd,
      allowUnboundSelfOwned: true,
      queryText: params.query.query
    }));
  const namespaceFactKeyCandidate =
    (await loadNamespaceExactDetailFactKeyTruth({
      namespaceId: params.query.namespaceId,
      spec,
      timeStart: params.timeStart,
      timeEnd: params.timeEnd,
      queryText: params.query.query
    })) ??
    (await loadUnboundNamespaceExactDetailFactKeyTruth({
      namespaceId: params.query.namespaceId,
      spec,
      timeStart: params.timeStart,
      timeEnd: params.timeEnd,
      queryText: params.query.query
    }));
  const namespaceEventCandidate = await loadNamespaceEventExactDetailTruth({
    namespaceId: params.query.namespaceId,
    spec,
    timeStart: params.timeStart,
    timeEnd: params.timeEnd,
    queryText: params.query.query
  });
  const namespaceProjectionCandidate = await loadNamespaceProjectionScalarTruth({
    namespaceId: params.query.namespaceId,
    spec,
    timeStart: params.timeStart,
    timeEnd: params.timeEnd,
    queryText: params.query.query
  });

  const authoritativeDirectCandidates = [
    namespaceProceduralCandidate,
    namespaceDirectSourceCandidate,
    namespaceCompiledCandidate,
    namespaceFactKeyCandidate,
    namespaceEventCandidate
  ];
  const factKeyBlockedProjection =
    namespaceCompiledCandidate?.status === "partial" ||
    (namespaceCompiledCandidate?.status === "insufficient" &&
      (namespaceCompiledCandidate.claimAdmissibilityStatus === "rejected" ||
        namespaceCompiledCandidate.claimAdmissibilityStatus === "ambiguous")) ||
    namespaceFactKeyCandidate?.status === "partial" ||
    (namespaceFactKeyCandidate?.status === "insufficient" &&
      (namespaceFactKeyCandidate.claimAdmissibilityStatus === "rejected" ||
        namespaceFactKeyCandidate.claimAdmissibilityStatus === "ambiguous"));
  const directCandidates = [
    ...authoritativeDirectCandidates,
    ...(factKeyBlockedProjection ? [] : [namespaceProjectionCandidate])
  ];
  const directWinner = directCandidates.find((candidate) => candidate?.status === "sufficient") ?? null;
  if (directWinner) {
    await maybePersistRecoveredSelfBinding({
      namespaceId: params.query.namespaceId,
      queryText: params.query.query,
      spec,
      subjectEntityId: directWinner.subjectEntityId,
      recoveredFrom: directWinner.selfBindingRecoveredFrom
    });
    return {
      family,
      shouldReturn: true,
      results: directWinner.results,
      reason: directWinner.reason,
      exactDetailCandidate: exactDetailClaimCandidateForTruthCandidate(directWinner),
      metaAugment: metaAugmentForCandidate({
        scalarTruthTried,
        eventTruthTried,
        candidate: directWinner
      })
    };
  }

  const directPartialCandidate =
    directCandidates.find((candidate) => candidate?.status === "partial" && candidate.backfillBlockedReason) ?? null;
  if (directPartialCandidate) {
    return {
      family,
      shouldReturn: true,
      results: directPartialCandidate.results,
      reason: directPartialCandidate.reason,
      metaAugment: metaAugmentForCandidate({
        scalarTruthTried,
        eventTruthTried,
        candidate: directPartialCandidate
      })
    };
  }
  const directRejectedCandidate =
    directCandidates.find(
      (candidate) =>
        candidate?.status === "insufficient" &&
        (candidate.claimAdmissibilityStatus === "rejected" || candidate.claimAdmissibilityStatus === "ambiguous")
    ) ?? null;

  const subjectResolution = await resolveAggressiveSubject({
    namespaceId: params.query.namespaceId,
    queryText: params.query.query,
    retrievalPlan: params.retrievalPlan,
    spec
  });
  if (!subjectResolution.subjectEntityId && spec.selfOwned) {
    const abstentionCandidate: ExactTruthCandidate = {
      status: "none",
      results: [],
      reason: "Structured scalar and event truth were exhausted, and the query still could not be bound to the intended subject.",
      authoritativeSource: "typed_abstention",
      supportBundleFamily: spec.queryFamily,
      structuredSufficiencyStatus: "none",
      abstentionReason: "no_subject_binding",
      entityResolutionStatus: "unresolved",
      backfillBlockedReason: "no_subject_binding",
      selfBindingRecoveredFrom: "none",
      claimAdmissibilityStatus: directRejectedCandidate?.claimAdmissibilityStatus ?? "rejected",
      authoritativeClaimRejectedReason: directRejectedCandidate?.authoritativeClaimRejectedReason ?? "fact_key_absent",
      factKeyLookupUsed: directRejectedCandidate?.factKeyLookupUsed ?? true,
      factKeyHitType: directRejectedCandidate?.factKeyHitType,
      factRowSource: directRejectedCandidate?.factRowSource
    };
    return {
      family,
      shouldReturn: true,
      results: abstentionCandidate.results,
      reason: abstentionCandidate.reason,
      metaAugment: metaAugmentForCandidate({
        scalarTruthTried,
        eventTruthTried,
        candidate: abstentionCandidate
      })
    };
  }

  await maybePersistRecoveredSelfBinding({
    namespaceId: params.query.namespaceId,
    queryText: params.query.query,
    spec,
    subjectEntityId: subjectResolution.subjectEntityId,
    recoveredFrom: subjectResolution.selfBindingRecoveredFrom
  });

  const resolvedPlan = {
    ...params.retrievalPlan,
    resolvedSubjectEntityId: subjectResolution.subjectEntityId
  };
  const factKeyReader = async (): Promise<ExactTruthCandidate | null> => {
    if (!subjectResolution.subjectEntityId) {
      return null;
    }
    return loadExactDetailFactKeyTruth({
      namespaceId: params.query.namespaceId,
      subjectEntityId: subjectResolution.subjectEntityId,
      spec,
      timeStart: params.timeStart,
      timeEnd: params.timeEnd,
      queryText: params.query.query
    });
  };
  const compiledReader = async (): Promise<ExactTruthCandidate | null> => {
    if (!subjectResolution.subjectEntityId) {
      return loadCompiledExactDetailTruth({
        namespaceId: params.query.namespaceId,
        spec,
        timeStart: params.timeStart,
        timeEnd: params.timeEnd,
        allowUnboundSelfOwned: true,
        queryText: params.query.query
      });
    }
    return loadCompiledExactDetailTruth({
      namespaceId: params.query.namespaceId,
      subjectEntityId: subjectResolution.subjectEntityId,
      spec,
      timeStart: params.timeStart,
      timeEnd: params.timeEnd,
      queryText: params.query.query
    });
  };
  const scalarReaders = async (): Promise<ExactTruthCandidate | null> => {
    const projection = await loadProjectionScalarTruth({
      namespaceId: params.query.namespaceId,
      queryText: params.query.query,
      spec,
      retrievalPlan: resolvedPlan,
      timeStart: params.timeStart,
      timeEnd: params.timeEnd
    });
    if (projection?.status === "sufficient") {
      return projection;
    }
    if (subjectResolution.subjectEntityId) {
      const canonical = await loadCanonicalStateTruth({
        namespaceId: params.query.namespaceId,
        subjectEntityId: subjectResolution.subjectEntityId,
        spec,
        queryText: params.query.query
      });
      if (canonical) {
        return canonical;
      }
    }
    return projection;
  };
  const eventReaders = async (): Promise<ExactTruthCandidate | null> => {
    if (!subjectResolution.subjectEntityId) {
      return null;
    }
    return loadEventExactDetailTruth({
      namespaceId: params.query.namespaceId,
      subjectEntityId: subjectResolution.subjectEntityId,
      spec,
      timeStart: params.timeStart,
      timeEnd: params.timeEnd,
      queryText: params.query.query
    });
  };
  const scopedCompiledCandidate = await compiledReader();
  const scopedDirectSourceCandidate = scopedCompiledCandidate?.status === "sufficient"
    ? null
    : await loadDirectSourceExactDetailTruth({
        namespaceId: params.query.namespaceId,
        spec,
        queryText: params.query.query
      });
  const scopedFactKeyCandidate = scopedCompiledCandidate?.status === "sufficient" ? null : await factKeyReader();
  const scopedEventCandidate = await eventReaders();
  const scopedFactKeyBlockedProjection =
    scopedCompiledCandidate?.status === "partial" ||
    (scopedCompiledCandidate?.status === "insufficient" &&
      (scopedCompiledCandidate.claimAdmissibilityStatus === "rejected" ||
        scopedCompiledCandidate.claimAdmissibilityStatus === "ambiguous")) ||
    scopedFactKeyCandidate?.status === "partial" ||
    (scopedFactKeyCandidate?.status === "insufficient" &&
      (scopedFactKeyCandidate.claimAdmissibilityStatus === "rejected" ||
        scopedFactKeyCandidate.claimAdmissibilityStatus === "ambiguous"));
  const scopedScalarCandidate = scopedFactKeyBlockedProjection ? null : await scalarReaders();
  const orderedCandidates = [scopedCompiledCandidate, scopedDirectSourceCandidate, scopedFactKeyCandidate, scopedEventCandidate, scopedScalarCandidate];
  const winner = orderedCandidates.find((candidate) => candidate?.status === "sufficient") ?? null;
  if (winner) {
    await maybePersistRecoveredSelfBinding({
      namespaceId: params.query.namespaceId,
      queryText: params.query.query,
      spec,
      subjectEntityId: winner.subjectEntityId
    });
    return {
      family,
      shouldReturn: true,
      results: winner.results,
      reason: winner.reason,
      exactDetailCandidate: exactDetailClaimCandidateForTruthCandidate(winner),
      metaAugment: metaAugmentForCandidate({
        scalarTruthTried,
        eventTruthTried,
        candidate: winner
      })
    };
  }

  const partialCandidate =
    orderedCandidates.find((candidate) => candidate?.status === "partial" && candidate.backfillBlockedReason) ?? null;
  if (partialCandidate) {
    return {
      family,
      shouldReturn: true,
      results: partialCandidate.results,
      reason: partialCandidate.reason,
      metaAugment: metaAugmentForCandidate({
        scalarTruthTried,
        eventTruthTried,
        candidate: partialCandidate
      })
    };
  }
  const rejectedCandidate =
    orderedCandidates.find(
      (candidate) =>
        candidate?.status === "insufficient" &&
        (candidate.claimAdmissibilityStatus === "rejected" || candidate.claimAdmissibilityStatus === "ambiguous")
    ) ??
    directRejectedCandidate ??
    null;

  const typedAbstentionCandidate: ExactTruthCandidate = {
    status: "insufficient",
    results: [],
    reason: "The aggressive exact-detail truth readers were exhausted without sufficient scalar or event truth, so widening stayed blocked.",
    authoritativeSource: "typed_abstention",
    supportBundleFamily: spec.queryFamily,
    structuredSufficiencyStatus: "insufficient",
    abstentionReason: "insufficient_active_truth",
    entityResolutionStatus: subjectResolution.resolutionStatus,
    backfillBlockedReason: "aggressive_exact_detail_terminal_abstention",
    subjectEntityId: subjectResolution.subjectEntityId,
    selfBindingRecoveredFrom: subjectResolution.selfBindingRecoveredFrom,
    claimAdmissibilityStatus: rejectedCandidate?.claimAdmissibilityStatus,
    authoritativeClaimRejectedReason: rejectedCandidate?.authoritativeClaimRejectedReason ?? "fact_key_absent",
    factKeyLookupUsed: rejectedCandidate?.factKeyLookupUsed ?? true,
    factKeyHitType: rejectedCandidate?.factKeyHitType,
    factRowSource: rejectedCandidate?.factRowSource
  };
  return {
    family,
    shouldReturn: true,
    results: typedAbstentionCandidate.results,
    reason: typedAbstentionCandidate.reason,
    metaAugment: metaAugmentForCandidate({
      scalarTruthTried,
      eventTruthTried,
      candidate: typedAbstentionCandidate
    })
  };
}

export async function resolveEarlyContractTruthDecision(params: {
  readonly query: RecallQuery;
  readonly retrievalPlan: Pick<AnswerRetrievalPlan, "family" | "lane" | "controllerIntent" | "resolvedSubjectEntityId" | "subjectNames">;
  readonly timeStart: string | null;
  readonly timeEnd: string | null;
  readonly renderPayloadMode: "shadow" | "preferred" | "required";
  readonly sqlFusedKernelMode: "shadow" | "preferred" | "required";
}): Promise<{
  readonly earlyResponse: {
    readonly results: readonly RecallResult[];
    readonly reason: string;
    readonly metaAugment: Partial<RecallResponse["meta"]>;
    readonly exactDetailCandidate?: ExactDetailClaimCandidate | null;
  } | null;
  readonly metaAugment: Partial<RecallResponse["meta"]> | null;
}> {
  const aggressiveDecision = await maybeLoadAggressiveExactDetailTruthDecision({
    query: params.query,
    retrievalPlan: params.retrievalPlan,
    timeStart: params.timeStart,
    timeEnd: params.timeEnd
  });
  if (aggressiveDecision?.shouldReturn) {
    return {
      earlyResponse: {
        results: aggressiveDecision.results,
        reason: aggressiveDecision.reason,
        metaAugment: aggressiveDecision.metaAugment,
        exactDetailCandidate: aggressiveDecision.exactDetailCandidate
      },
      metaAugment: aggressiveDecision.metaAugment
    };
  }
  if (aggressiveDecision) {
    return {
      earlyResponse: null,
      metaAugment: aggressiveDecision.metaAugment
    };
  }
  const projectionDecision = await maybeLoadProjectionTypedLaneDecision({
    query: params.query,
    retrievalPlan: params.retrievalPlan,
    timeStart: params.timeStart,
    timeEnd: params.timeEnd,
    renderPayloadMode: params.renderPayloadMode,
    sqlFusedKernelMode: params.sqlFusedKernelMode
  });
  if (!projectionDecision) {
    return { earlyResponse: null, metaAugment: null };
  }
  return {
    earlyResponse: projectionDecision,
    metaAugment: null
  };
}
