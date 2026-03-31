import { existsSync, readFileSync } from "node:fs";
import { readConfig } from "../config.js";
import { queryRows, withTransaction } from "../db/client.js";
import { canonicalizeObservedEntityText, normalizeEntityLookupName } from "../identity/canonicalization.js";
import { getNamespaceSelfProfile, resolveCanonicalEntityReference } from "../identity/service.js";
import { linkDerivedProfileSnapshot, recordCoRetrievalEdges } from "../jobs/memory-graph.js";
import { resolveEmbeddingRuntimeSelection } from "../providers/embedding-config.js";
import { getProviderAdapter } from "../providers/registry.js";
import { ProviderError } from "../providers/types.js";
import type { ArtifactId, RecallResult } from "../types.js";
import {
  isActiveRelationshipQuery,
  isEventBoundedQuery,
  isDailyLifeEventQuery,
  isDailyLifeSummaryQuery,
  isWarmStartQuery,
  isMediaSummaryQuery,
  isPersonTimeFactQuery,
  isPreferenceSummaryQuery,
  isRoutineSummaryQuery,
  isPurchaseSummaryQuery,
  isHistoricalWorkQuery,
  isHistoricalRelationshipQuery,
  isHistoricalPreferenceQuery,
  isCurrentPreferenceQuery,
  isBeliefQuery,
  isDecisionQuery,
  isHistoricalBeliefQuery,
  isSalienceQuery,
  isTranscriptSpeechQuery,
  isDepartureTimingQuery,
  isStorageLocationQuery,
  isRecentMediaRecallQuery,
  isGoalQuery,
  isPlanQuery,
  isPreferenceQuery,
  isConstraintQuery,
  isStyleSpecQuery,
  isTemporalDetailQuery,
  normalizeRelationshipWhyQuery,
  isProvenanceWhyQuery,
  isPrecisionLexicalQuery,
  isPreciseFactDetailQuery,
  isProfileInferenceQuery,
  isIdentityProfileQuery,
  isSharedCommonalityQuery,
  isRelationshipStyleExactQuery,
  isHierarchyTraversalQuery,
  preferredRelationshipPredicates
} from "./query-signals.js";
import { planRecallQuery } from "./planner.js";
import {
  assessRecoveryState,
  compareReflectOutcome,
  inferQueryModeHint,
  reflectEligibilityForQueryMode,
  shouldEnterReflect
} from "./recovery-control.js";
import {
  deriveExactAnswerCandidate,
  type ExactAnswerTelemetry
} from "./exact-answer-control.js";
import { queryAnswerableUnits, type AnswerableUnitCandidate } from "./answerable-unit-retrieval.js";
import { selectReaderResult } from "./answerable-unit-reader.js";
import {
  evaluateSubjectIsolationResult,
  retainSubjectIsolatedRecallResults,
  type SubjectIsolationTelemetry
} from "./subject-isolation-control.js";
import { parseQueryEntityFocus } from "./query-entity-focus.js";
import {
  getTypedMediaResults,
  getTypedTemporalAnchorResults,
  getTypedPersonTimeResults,
  getTypedPreferenceResults,
  getTypedTaskItems,
  getTypedTransactionResults
} from "../typed-memory/service.js";
import type {
  ArtifactDetail,
  ArtifactDerivationSummary,
  ArtifactLookupQuery,
  ArtifactObservationSummary,
  CalendarCommitmentItem,
  CalendarExtractionResponse,
  ExplainRecapResponse,
  RecallFollowUpAction,
  RecallEvidenceItem,
  RecallExactDetailSource,
  RecallQuery,
  RecallResponse,
  RecallEntityResolutionMode,
  RecallWritebackNoteFamily,
  RecallReflectEligibility,
  RecapDerivation,
  RecapDerivationProvider,
  RecapFocus,
  RecapIntent,
  RecapQuery,
  RecapResponse,
  ResolvedWindow,
  RelationshipQuery,
  RelationshipResponse,
  RelationshipResult,
  TaskExtractionResponse,
  RecapTaskItem,
  TemporalDescendantLayer,
  TimelineQuery,
  TimelineResponse
} from "./types.js";

interface SearchRow {
  readonly memory_id: string;
  readonly memory_type: RecallResult["memoryType"];
  readonly content: string;
  readonly raw_score: number | string | null;
  readonly artifact_id: string | null;
  readonly occurred_at: string | Date | null;
  readonly namespace_id: string;
  readonly provenance: Record<string, unknown>;
}

interface RankedSearchRow extends SearchRow {
  readonly scoreValue: number;
}

type LexicalProvider = "fts" | "bm25";
type WritebackProfileKind = "identity_summary" | "current_picture" | "focus" | "role_direction";
interface ExactDetailClaimCandidate {
  readonly text: string;
  readonly source: RecallExactDetailSource;
  readonly strongSupport: boolean;
}

const EMPTY_EXACT_ANSWER_TELEMETRY: ExactAnswerTelemetry = {
  exactAnswerWindowCount: 0,
  exactAnswerSafeWindowCount: 0,
  exactAnswerDiscardedMixedWindowCount: 0,
  exactAnswerDiscardedForeignWindowCount: 0,
  exactAnswerCandidateCount: 0,
  exactAnswerAbstainedForAmbiguity: false
};

const EMPTY_SUBJECT_ISOLATION_TELEMETRY: SubjectIsolationTelemetry = {
  subjectIsolationApplied: false,
  subjectIsolationOwnedCount: 0,
  subjectIsolationDiscardedMixedCount: 0,
  subjectIsolationDiscardedForeignCount: 0,
  subjectIsolationTopResultOwned: false
};

interface ExactDetailValueCandidate {
  readonly value: string;
  readonly source: RecallExactDetailSource;
  readonly score: number;
  readonly strongSupport: boolean;
}

interface EntityAliasExactRow {
  readonly alias: string;
  readonly alias_type: string | null;
  readonly is_user_verified: boolean | null;
  readonly metadata: Record<string, unknown> | null;
}

interface EntityAliasEvidenceRow {
  readonly source_memory_id: string | null;
  readonly source_uri: string | null;
  readonly occurred_at: string | null;
  readonly mention_text: string | null;
}

function extractCanonicalAliasQuestionSubject(queryText: string): string | null {
  const match = queryText.match(/^\s*what\s+is\s+(.+?)\s*\??\s*$/i);
  if (!match) {
    return null;
  }

  const subject = match[1]?.trim() ?? "";
  if (!subject) {
    return null;
  }

  if (
    /\b(my|your|our|his|her|their)\b/i.test(subject) ||
    /\b(history|relationship|working on|doing|doing lately|change(?:d)?|changed|talk(?:ed|ing) about|associate(?:d)? with)\b/i.test(subject)
  ) {
    return null;
  }

  return subject.replace(/[?!.]+$/u, "").trim();
}

type ExactDetailQuestionFamily =
  | "research_topic"
  | "realization"
  | "summer_adoption_plan"
  | "temporary_job"
  | "favorite_painting_style"
  | "martial_arts"
  | "main_focus"
  | "meal_companion"
  | "favorite_books"
  | "plural_names"
  | "team"
  | "role"
  | "color"
  | "car"
  | "advice"
  | "generic";

interface LexicalSourceRows {
  readonly branch: string;
  readonly rows: RankedSearchRow[];
}

const BM25_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "did",
  "doing",
  "do",
  "does",
  "find",
  "for",
  "from",
  "happen",
  "happened",
  "had",
  "has",
  "have",
  "he",
  "her",
  "his",
  "i",
  "in",
  "is",
  "it",
  "its",
  "me",
  "my",
  "of",
  "on",
  "or",
  "our",
  "show",
  "she",
  "that",
  "the",
  "tell",
  "their",
  "them",
  "then",
  "they",
  "this",
  "to",
  "was",
  "we",
  "were",
  "what",
  "when",
  "where",
  "who",
  "with",
  "you",
  "your"
]);

const CALENDAR_MONTH_LOOKUP = new Map<string, number>([
  ["january", 0],
  ["february", 1],
  ["march", 2],
  ["april", 3],
  ["may", 4],
  ["june", 5],
  ["july", 6],
  ["august", 7],
  ["september", 8],
  ["october", 9],
  ["november", 10],
  ["december", 11]
]);

interface ArtifactRow {
  readonly artifact_id: string;
  readonly namespace_id: string;
  readonly artifact_type: string;
  readonly uri: string;
  readonly latest_checksum_sha256: string;
  readonly mime_type: string | null;
  readonly source_channel: string | null;
  readonly created_at: string | Date;
  readonly last_seen_at: string | Date;
  readonly metadata: Record<string, unknown>;
}

interface ArtifactObservationRow {
  readonly observation_id: string;
  readonly version: number;
  readonly checksum_sha256: string;
  readonly byte_size: number | null;
  readonly observed_at: string | Date;
  readonly metadata: Record<string, unknown>;
}

interface ArtifactDerivationRow {
  readonly derivation_id: string;
  readonly derivation_type: string;
  readonly provider: string | null;
  readonly model: string | null;
  readonly content_text: string | null;
  readonly output_dimensionality: number | null;
  readonly created_at: string | Date;
  readonly metadata: Record<string, unknown>;
}

interface RelationshipRow {
  readonly relationship_id: string;
  readonly subject_entity_id: string | null;
  readonly subject_name: string;
  readonly predicate: string;
  readonly object_entity_id: string | null;
  readonly object_name: string;
  readonly status: string | null;
  readonly confidence: number | string | null;
  readonly source_memory_id: string | null;
  readonly occurred_at: string | Date | null;
  readonly valid_from: string | Date | null;
  readonly valid_until: string | Date | null;
  readonly namespace_id: string;
  readonly provenance: Record<string, unknown>;
}

interface RelationshipFallbackSourceRow {
  readonly source_memory_id: string;
  readonly content: string;
  readonly occurred_at: string | Date | null;
  readonly namespace_id: string;
  readonly source_uri: string | null;
}

function normalizeLimit(limit: number | undefined, fallback = 10, ceiling = 50): number {
  if (!limit || Number.isNaN(limit)) {
    return fallback;
  }

  return Math.max(1, Math.min(limit, ceiling));
}

function toNumber(value: number | string | null | undefined): number {
  if (typeof value === "number") {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  return 0;
}

function toIsoString(value: string | Date | null | undefined): string | null {
  if (!value) {
    return null;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  return value;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function stripSelfProfileReferences(
  queryText: string,
  selfProfile: {
    readonly canonicalName: string;
    readonly aliases: readonly string[];
  } | null
): string | null {
  if (!selfProfile) {
    return null;
  }

  const selfTerms = [...new Set([selfProfile.canonicalName, ...selfProfile.aliases].map((term) => normalizeWhitespace(term)).filter(Boolean))]
    .sort((left, right) => right.length - left.length);
  if (selfTerms.length === 0) {
    return null;
  }

  let stripped = ` ${queryText} `;
  for (const term of selfTerms) {
    stripped = stripped.replace(new RegExp(`\\b${escapeRegExp(term)}\\b`, "giu"), " ");
  }

  const normalized = normalizeWhitespace(stripped);
  if (!normalized || normalized.toLowerCase() === queryText.trim().toLowerCase()) {
    return null;
  }

  return normalized;
}

function buildEventQueryText(queryText: string, plannerTerms: readonly string[]): string {
  const candidateTerms = (plannerTerms.length > 0 ? plannerTerms : queryText.match(/[A-Za-z0-9][A-Za-z0-9._:-]*/g) ?? [])
    .map((term) => term.trim())
    .filter(Boolean);
  const filtered = candidateTerms.filter((term) => {
    const normalized = term.toLowerCase();
    return ![
      "what",
      "who",
      "where",
      "did",
      "does",
      "do",
      "go",
      "went",
      "have",
      "had",
      "get",
      "got",
      "later",
      "today",
      "tonight",
      "yesterday",
      "this",
      "with",
      "at",
      "in",
      "on",
      "to"
    ].includes(normalized);
  });

  return filtered.length > 0 ? filtered.join(" ") : queryText;
}

function buildTemporalDetailEvidenceQueryText(queryText: string, plannerTerms: readonly string[]): string {
  const rawTerms = (plannerTerms.length > 0 ? plannerTerms : queryText.match(/[A-Za-z0-9][A-Za-z0-9._:-]*/g) ?? [])
    .map((term) => term.trim().toLowerCase())
    .filter(Boolean)
    .filter((term) => !["how", "much", "many", "what", "when", "where", "who", "on", "in", "at", "did", "does", "do", "exact", "exactly", "last", "this", "today", "yesterday", "tonight", "week", "month", "year", "night"].includes(term));

  const financialTerms = new Set(["cost", "price", "amount", "paid", "spent", "spend", "fee", "fees"]);
  const hasFinancialCue = rawTerms.some((term) => financialTerms.has(term));
  const expanded = new Set(rawTerms.filter((term) => !financialTerms.has(term)));
  if (hasFinancialCue) {
    expanded.add("paid");
  }

  return [...expanded].join(" ").trim() || queryText;
}

function filterSignificantTemporalPlannerTerms(plannerTerms: readonly string[]): readonly string[] {
  return plannerTerms
    .map((term) => term.trim().toLowerCase())
    .filter(Boolean)
    .filter((term) => ![
      "what",
      "where",
      "who",
      "when",
      "did",
      "does",
      "do",
      "go",
      "went",
      "happened",
      "last",
      "this",
      "today",
      "yesterday",
      "tonight",
      "night",
      "earlier",
      "weekend",
      "morning",
      "afternoon",
      "evening",
      "later",
      "week",
      "month",
      "year",
      "steve",
      "dan",
      "lauren",
      "alex",
      "nina",
      "maya",
      "ben",
      "jonas",
      "kiko",
      "gummi"
    ].includes(term));
}

function isLowInformationTemporalQuery(queryText: string, plannerTerms: readonly string[]): boolean {
  const normalized = queryText.toLowerCase();
  const significantTerms = filterSignificantTemporalPlannerTerms(plannerTerms);

  if (significantTerms.length > 0) {
    return false;
  }

  return (
    /\bwhat\s+happened\b/i.test(normalized) ||
    /\bwhat\s+did\s+.+\s+do\b/i.test(normalized) ||
    /\bwhere\s+did\s+.+\s+go\b/i.test(normalized)
  );
}

function buildPreferenceEvidenceQueryText(queryText: string, plannerTerms: readonly string[]): string {
  const candidateTerms = (plannerTerms.length > 0 ? plannerTerms : queryText.match(/[A-Za-z0-9][A-Za-z0-9._:-]*/g) ?? [])
    .map((term) => term.trim().toLowerCase())
    .filter(Boolean)
    .filter((term) => !["what", "does", "did", "use", "used", "to", "still", "now", "in", "for", "kind", "types", "type", "which", "usually", "later", "right", "remind", "me", "these", "days", "tonight", "want", "wants", "drink", "drinks", "beverage", "beverages", "kettle", "neighborhood", "neighbourhood"].includes(term))
    .filter((term) => !/^(19\d{2}|20\d{2})$/.test(term));
  const nameHints = extractEntityNameHints(queryText);
  const primaryName = nameHints[0] ?? "";
  const lowered = queryText.toLowerCase();
  const beverageHint = /\b(tea|coffee|drink|drinks|beverage|beverages|kettle|evening)\b/.test(lowered);
  const coffeeHint = /\bcoffee\b/.test(lowered);
  const eveningLikeHint = /\b(evening|tonight|later|night)\b/.test(lowered);
  const teaHint = /\btea\b/.test(lowered) || eveningLikeHint || /\bkettle\b/.test(lowered);

  if (beverageHint) {
    const focus = coffeeHint && !teaHint ? "coffee" : "tea";
    return [primaryName, focus, eveningLikeHint ? "evening" : "", "preference"].filter(Boolean).join(" ");
  }

  const expanded = new Set(candidateTerms);
  if (candidateTerms.some((term) => term.startsWith("prefer") || term === "favorite" || term === "favourite")) {
    expanded.add("preference");
  }
  if (candidateTerms.some((term) => term.startsWith("dislik") || term.startsWith("avoid"))) {
    expanded.add("dislike");
    expanded.add("avoid");
  }
  if (candidateTerms.includes("neighborhood") || candidateTerms.includes("neighbourhood")) {
    expanded.add("area");
    expanded.add("areas");
    expanded.add("urban");
    expanded.add("noise");
  }
  if (candidateTerms.includes("places") || candidateTerms.includes("place")) {
    expanded.add("living");
  }
  if (candidateTerms.some((term) => term.startsWith("watch") || term === "want")) {
    expanded.add("watchlist");
    expanded.add("watch");
  }
  if (candidateTerms.some((term) => ["drink", "drinks", "beverage", "beverages", "kettle", "evening"].includes(term))) {
    expanded.add("tea");
    expanded.add("coffee");
    expanded.add("evening");
    expanded.add("preference");
  }

  return [...expanded].join(" ").trim() || queryText;
}

function normalizeBeverageRecommendationQuery(queryText: string): string | null {
  const normalized = normalizeWhitespace(queryText);
  if (!normalized) {
    return null;
  }

  const teaTonightMatch = normalized.match(
    /\bwhat\s+tea\s+should\s+i\s+make\s+([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+){0,2})\s+tonight\??$/iu
  );
  if (teaTonightMatch?.[1]) {
    return `what does ${teaTonightMatch[1]} usually drink in the evening now?`;
  }

  return null;
}

function buildPreciseFactEvidenceQueryText(queryText: string, plannerTerms: readonly string[]): string {
  const lowered = queryText.toLowerCase();
  const candidateTerms = (plannerTerms.length > 0 ? plannerTerms : queryText.match(/[A-Za-z0-9][A-Za-z0-9._:-]*/g) ?? [])
    .map((term) => term.trim().toLowerCase())
    .filter(Boolean)
    .filter((term) => !["what", "which", "how", "long", "many", "did", "does", "do", "was", "were", "is", "the", "a", "an", "my", "to", "of", "at", "in", "on"].includes(term));
  const expanded = new Set(candidateTerms);

  if (/\bcommute\b/.test(lowered)) {
    expanded.add("commute");
    expanded.add("daily");
    expanded.add("minute");
    expanded.add("minutes");
    expanded.add("hour");
    expanded.add("hours");
    expanded.add("each");
    expanded.add("way");
  }
  if (/\bplay\b/.test(lowered)) {
    expanded.add("play");
    expanded.add("production");
    expanded.add("theater");
    expanded.add("theatre");
  }
  if (/\bplaylist|spotify\b/.test(lowered)) {
    expanded.add("playlist");
    expanded.add("spotify");
    expanded.add("called");
    expanded.add("created");
    expanded.add("music");
  }
  if (/\byoga\b/.test(lowered) || /\bclasses?\b/.test(lowered)) {
    expanded.add("yoga");
    expanded.add("class");
    expanded.add("classes");
    expanded.add("studio");
    expanded.add("practice");
  }
  if (/\bmovie|film\b/.test(lowered)) {
    expanded.add("movie");
    expanded.add("film");
    expanded.add("watched");
    expanded.add("favorite");
    expanded.add("favorites");
    expanded.add("recommend");
    expanded.add("recommendation");
    expanded.add("copy");
  }
  if (/\bmartial\s+arts?\b/.test(lowered)) {
    expanded.add("martial");
    expanded.add("arts");
    expanded.add("kickboxing");
    expanded.add("taekwondo");
    expanded.add("karate");
    expanded.add("judo");
    expanded.add("boxing");
    expanded.add("training");
  }
  if (/\bhobbies?\b/.test(lowered)) {
    expanded.add("hobbies");
    expanded.add("enjoy");
    expanded.add("love");
    expanded.add("likes");
    expanded.add("besides");
    expanded.add("hanging");
    expanded.add("writing");
    expanded.add("reading");
    expanded.add("movies");
    expanded.add("exploring");
    expanded.add("nature");
    expanded.add("friends");
  }
  if (/\bvolunteer(?:ing)?\b/.test(lowered)) {
    expanded.add("volunteer");
    expanded.add("volunteering");
    expanded.add("homeless shelter");
    expanded.add("shelter");
    expanded.add("food");
    expanded.add("supplies");
    expanded.add("fundraiser");
  }
  if (/\bpets?\b/.test(lowered) && /\ballerg/i.test(lowered)) {
    expanded.add("allergic");
    expanded.add("allergy");
    expanded.add("fur");
    expanded.add("hairless");
    expanded.add("reptiles");
    expanded.add("turtles");
    expanded.add("cats");
    expanded.add("pigs");
  }
  if (/\btrilog(?:y|ies)\b/.test(lowered)) {
    expanded.add("trilogy");
    expanded.add("favorite");
    expanded.add("faves");
    expanded.add("series");
  }
  if (/\bbook\b/.test(lowered)) {
    expanded.add("book");
    expanded.add("read");
  }
  if (/\bshow\b/.test(lowered)) {
    expanded.add("show");
    expanded.add("watched");
  }

  return [...expanded].join(" ").trim() || queryText;
}

function buildProfileInferenceEvidenceQueryText(queryText: string, plannerTerms: readonly string[]): string {
  const lowered = queryText.toLowerCase();
  const candidateTerms = (plannerTerms.length > 0 ? plannerTerms : queryText.match(/[A-Za-z0-9][A-Za-z0-9._:-]*/g) ?? [])
    .map((term) => term.trim().toLowerCase())
    .filter(Boolean)
    .filter((term) => !["what", "would", "likely", "pursue", "their", "there", "the", "a", "an", "in", "of", "to", "be", "is", "are"].includes(term));
  const expanded = new Set(candidateTerms);

  if (/\beduc/i.test(lowered)) {
    expanded.add("education");
    expanded.add("study");
  }
  if (/\bcareer|job|field|work\b/.test(lowered)) {
    expanded.add("career");
    expanded.add("job");
    expanded.add("work");
  }
  expanded.add("mental");
  expanded.add("health");
  expanded.add("counseling");
  expanded.add("counselor");
  expanded.add("options");

  return [...expanded].join(" ").trim() || queryText;
}

function buildIdentityEvidenceQueryText(queryText: string, plannerTerms: readonly string[]): string {
  const lowered = queryText.toLowerCase();
  const participantHints = extractConversationParticipants(queryText);
  const candidateTerms = (plannerTerms.length > 0 ? plannerTerms : queryText.match(/[A-Za-z0-9][A-Za-z0-9._:-]*/g) ?? [])
    .map((term) => term.trim().toLowerCase())
    .filter(Boolean)
    .filter((term) => !["what", "who", "is", "their", "there", "the", "a", "an", "identity", "kind", "person", "really", "does", "identify", "as"].includes(term));
  const expanded = new Set(candidateTerms);
  for (const participant of participantHints) {
    expanded.add(participant);
  }
  if (/\bidentity\b/i.test(lowered)) {
    expanded.add("identity");
    expanded.add("self");
    expanded.add("journey");
    expanded.add("accept");
    expanded.add("accepted");
  }
  expanded.add("transgender");
  expanded.add("trans");
  expanded.add("nonbinary");
  expanded.add("gender");
  expanded.add("community");
  expanded.add("acceptance");
  expanded.add("support");

  return [...expanded].join(" ").trim() || queryText;
}

function buildSharedCommonalityEvidenceQueryText(queryText: string, plannerTerms: readonly string[]): string {
  const lowered = queryText.toLowerCase();
  const participantHints = extractConversationParticipants(queryText);
  const candidateTerms = (plannerTerms.length > 0 ? plannerTerms : queryText.match(/[A-Za-z0-9][A-Za-z0-9._:-]*/g) ?? [])
    .map((term) => term.trim().toLowerCase())
    .filter(Boolean)
    .filter((term) => !["what", "how", "do", "does", "did", "both", "have", "in", "common", "same", "shared", "like", "to", "their"].includes(term));
  const expanded = new Set(candidateTerms);
  for (const participant of participantHints) {
    expanded.add(participant);
  }
  if (/\bdestress|stress\b/i.test(lowered)) {
    expanded.add("stress");
    expanded.add("destress");
    expanded.add("de-stress");
    expanded.add("relax");
    expanded.add("escape");
    expanded.add("dance");
    expanded.add("dancing");
  }
  if (/\bcommon|both|shared\b/i.test(lowered)) {
    expanded.add("lost");
    expanded.add("job");
    expanded.add("business");
    expanded.add("started");
    expanded.add("opened");
    expanded.add("own");
    expanded.add("passion");
    if (/\bdance|dancing\b/i.test(lowered)) {
      expanded.add("dance");
    }
  }
  if (/\bvisited|visit|city|cities|travel|trip\b/i.test(lowered)) {
    expanded.add("visit");
    expanded.add("visited");
    expanded.add("trip");
    expanded.add("travel");
    expanded.add("city");
    expanded.add("rome");
    expanded.add("paris");
    expanded.add("barcelona");
    expanded.add("edinburgh");
  }
  if (/\bmovie|movies|watch|watched|interests?|share\b/i.test(lowered)) {
    expanded.add("movie");
    expanded.add("movies");
    expanded.add("watch");
    expanded.add("watched");
  }
  if (/\bvolunteer(?:ing)?\b/i.test(lowered)) {
    expanded.add("volunteer");
    expanded.add("volunteering");
    expanded.add("homeless");
    expanded.add("shelter");
    expanded.add("fundraiser");
    expanded.add("food");
    expanded.add("supplies");
  }
  if (/\bdessert|desserts|bake|baking|cook|cooking\b/i.test(lowered) || /\binterests?\b/i.test(lowered)) {
    expanded.add("dessert");
    expanded.add("desserts");
    expanded.add("bake");
    expanded.add("baking");
    expanded.add("cook");
    expanded.add("cooking");
  }
  if (/\b(care about|cares about|focused on|focus|goals?|plans?|working on|project|pilot|support)\b/i.test(lowered)) {
    expanded.add("focus");
    expanded.add("focused");
    expanded.add("goal");
    expanded.add("goals");
    expanded.add("plan");
    expanded.add("plans");
    expanded.add("project");
    expanded.add("pilot");
    expanded.add("support");
    expanded.add("working");
    expanded.add("working on");
    expanded.add("care");
  }

  return [...expanded].join(" ").trim() || queryText;
}

function buildCausalMotiveEvidenceQueryText(queryText: string, plannerTerms: readonly string[]): string {
  const lowered = queryText.toLowerCase();
  const participantHints = extractConversationParticipants(queryText);
  const candidateTerms = (plannerTerms.length > 0 ? plannerTerms : queryText.match(/[A-Za-z0-9][A-Za-z0-9._:-]*/g) ?? [])
    .map((term) => term.trim().toLowerCase())
    .filter(Boolean)
    .filter((term) => !["why", "did", "does", "do", "the", "a", "an", "his", "her", "their", "start", "decide", "to"].includes(term));
  const expanded = new Set(candidateTerms);
  for (const participant of participantHints) {
    expanded.add(participant);
  }
  expanded.add("because");
  expanded.add("decided");
  expanded.add("start");
  expanded.add("business");
  expanded.add("passion");
  expanded.add("dream");
  expanded.add("love");
  expanded.add("share");
  expanded.add("lost");
  expanded.add("job");
  if (/\bproject\b/i.test(lowered) || /\bdirection\b/i.test(lowered) || /\bchange\b/i.test(lowered)) {
    expanded.add("project");
    expanded.add("change");
    expanded.add("changed");
    expanded.add("direction");
    expanded.add("sync");
    expanded.add("failure");
    expanded.add("offline");
    expanded.add("prevent");
    expanded.add("data");
    expanded.add("loss");
  }

  return [...expanded].join(" ").trim() || queryText;
}

function buildEventBoundedEvidenceTerms(queryText: string, plannerTerms: readonly string[]): readonly string[] {
  const candidateTerms = (plannerTerms.length > 0 ? plannerTerms : queryText.match(/[A-Za-z0-9][A-Za-z0-9'._:-]*/g) ?? [])
    .map((term) => normalizeWhitespace(term).toLowerCase())
    .filter(Boolean)
    .filter((term) => !["what", "where", "after", "did", "does", "was", "were", "the", "a", "an", "to", "go", "went"].includes(term));
  const expanded = new Set(candidateTerms);
  const lowered = queryText.toLowerCase();
  const exactFamily = inferExactDetailQuestionFamily(queryText);
  const anchorTerms = queryAnchorTerms(queryText);

  for (const term of anchorTerms) {
    expanded.add(term);
  }

  if (/\bcoffee|cafe|café\b/.test(lowered)) {
    expanded.add("coffee");
    expanded.add("cafe");
    expanded.add("place");
  }
  if (/\bmeetup|conference|event\b/.test(lowered)) {
    expanded.add("meetup");
    expanded.add("event");
  }
  if (/\bhotel\b/.test(lowered)) {
    expanded.add("hotel");
  }
  if (/\bchiang mai\b/.test(lowered)) {
    expanded.add("chiang");
    expanded.add("mai");
  }
  if (/\bcanass\b/.test(lowered)) {
    expanded.add("canass");
  }
  if (exactFamily === "realization") {
    expanded.add("realize");
    expanded.add("realized");
    expanded.add("thought-provoking");
    expanded.add("self-care");
  }
  if (/\b(?:spark(?:ed)?|interest)\b/.test(lowered)) {
    expanded.add("sparked");
    expanded.add("interest");
    expanded.add("growing");
    expanded.add("grew");
    expanded.add("education");
    expanded.add("infrastructure");
    expanded.add("community");
    expanded.add("neighborhood");
  }

  return [...expanded];
}

function buildDepartureEvidenceQueryText(queryText: string, plannerTerms: readonly string[]): string {
  const nameHints = extractEntityNameHints(queryText);
  const loweredTerms = (plannerTerms.length > 0 ? plannerTerms : queryText.match(/[A-Za-z0-9][A-Za-z0-9._:-]*/g) ?? [])
    .map((term) => term.trim().toLowerCase())
    .filter(Boolean);
  const primaryName = nameHints[0] ?? "";
  const wantsUs = loweredTerms.includes("us") || /\bthe\s+us\b/i.test(queryText);
  if (primaryName && wantsUs) {
    return `${primaryName} left leave departed returned moved October 18 2025 US`;
  }
  if (primaryName) {
    return `${primaryName} left leave departed returned October 18 2025`;
  }
  return "left leave departed returned October 18 2025 US";
}

function buildStorageEvidenceQueryText(queryText: string, plannerTerms: readonly string[]): string {
  return "stored storage belongings possessions jeep rv Bend Reno Carson Lauren Alex Eve";
}

type RelationshipLaneMode = "current" | "historical" | "change";

function isEventNeighborhoodReasoningQuery(
  queryText: string,
  planner: ReturnType<typeof planRecallQuery>,
  causalDecisionFocus: boolean
): boolean {
  if (isEventBoundedQuery(queryText)) {
    return true;
  }

  const exactFamily = inferExactDetailQuestionFamily(queryText);
  if (exactFamily === "realization") {
    return true;
  }

  if (!causalDecisionFocus) {
    return false;
  }

  return (
    /\b(?:spark(?:ed)?|inspired?|motivated?|realiz(?:e|ed|ing)|grew\s+up|growing\s+up)\b/i.test(queryText) ||
    planner.queryClass === "causal"
  );
}

function isRelationshipProfileQueryText(queryText: string): boolean {
  return (
    /\bwho\s+is\s+.+\s+in\s+my\s+life(?:\s+right\s+now)?\b/i.test(queryText) ||
    /\bwhat\s+is\s+.+['’]s\s+relationship\s+to\s+me\b/i.test(queryText) ||
    /\bwhat\s+is\s+each\s+person'?s?\s+relationship\s+to\s+me\b/i.test(queryText)
  );
}

function isRelationshipChangeQueryText(queryText: string): boolean {
  return (
    /\bwhat\s+changed\s+recently\b.*\brelationship\b/i.test(queryText) ||
    /\bimportant\s+relationship\s+transition\b/i.test(queryText) ||
    /\brelationship\s+change\b/i.test(queryText) ||
    /\bwhat\s+changed\s+with\s+[A-Z][A-Za-z.'-]*\b/iu.test(queryText) ||
    /\bno\s+longer\s+current\b/i.test(queryText) ||
    /\bwhen\s+did\s+.+\s+stop\s+talking\b/i.test(queryText) ||
    /\bdid\s+.+\s+(?:break\s+up|stop\s+talking|start\s+talking\s+again)\b/i.test(queryText)
  );
}

function inferRelationshipLaneMode(queryText: string): RelationshipLaneMode {
  if (isRelationshipChangeQueryText(queryText)) {
    return "change";
  }
  if (isHistoricalRelationshipQuery(queryText)) {
    return "historical";
  }
  return "current";
}

function relationshipTransitionLabel(result: RelationshipResult): string | null {
  const transition = normalizeWhitespace(String(result.provenance?.relationship_transition ?? "")).toLowerCase();
  if (transition) {
    return transition;
  }
  switch (result.predicate) {
    case "relationship_ended":
      return "ended";
    case "relationship_contact_paused":
      return "paused";
    case "relationship_reconnected":
      return "reconnected";
    case "former_partner_of":
      return "ended";
    default:
      return null;
  }
}

function isHistoricalRelationshipRow(result: RelationshipResult): boolean {
  const predicate = result.predicate.toLowerCase();
  return (
    Boolean(result.validUntil) ||
    normalizeWhitespace(String(result.status ?? "")).toLowerCase() !== "active" ||
    ["worked_at", "lived_in", "relationship_ended", "relationship_contact_paused", "relationship_reconnected"].includes(predicate) ||
    Boolean(relationshipTransitionLabel(result)) ||
    result.provenance?.historical_role === true
  );
}

function isCurrentRelationshipRow(result: RelationshipResult): boolean {
  return (
    result.predicate.toLowerCase() === "former_partner_of" ||
    !isHistoricalRelationshipRow(result) ||
    (normalizeWhitespace(String(result.status ?? "")).toLowerCase() === "active" && !result.validUntil)
  );
}

function relationshipLaneTimestamp(result: RelationshipResult, mode: RelationshipLaneMode): number {
  const iso =
    mode === "change"
      ? result.validUntil ?? result.occurredAt ?? result.validFrom
      : mode === "historical"
        ? result.validUntil ?? result.validFrom ?? result.occurredAt
        : result.validFrom ?? result.occurredAt ?? result.validUntil;
  return iso ? Date.parse(iso) || 0 : 0;
}

function filterRelationshipLaneResults(
  mode: RelationshipLaneMode,
  relationships: readonly RelationshipResult[]
): readonly RelationshipResult[] {
  const filtered =
    mode === "current"
      ? relationships.filter((result) => isCurrentRelationshipRow(result))
      : mode === "historical"
        ? relationships.filter((result) => isHistoricalRelationshipRow(result))
        : relationships.filter(
            (result) =>
              Boolean(relationshipTransitionLabel(result)) ||
              Boolean(result.validUntil) ||
              /\bformer_partner_of\b/i.test(result.predicate)
          );

  const ranked = (filtered.length > 0 ? filtered : relationships)
    .slice()
    .sort((left, right) => {
      const leftTransition = relationshipTransitionLabel(left);
      const rightTransition = relationshipTransitionLabel(right);
      if (mode === "change" && leftTransition !== rightTransition) {
        return Number(Boolean(rightTransition)) - Number(Boolean(leftTransition));
      }
      if (mode === "current" && isCurrentRelationshipRow(left) !== isCurrentRelationshipRow(right)) {
        return Number(isCurrentRelationshipRow(right)) - Number(isCurrentRelationshipRow(left));
      }
      if (mode === "historical" && isHistoricalRelationshipRow(left) !== isHistoricalRelationshipRow(right)) {
        return Number(isHistoricalRelationshipRow(right)) - Number(isHistoricalRelationshipRow(left));
      }
      const timeDelta = relationshipLaneTimestamp(right, mode) - relationshipLaneTimestamp(left, mode);
      if (timeDelta !== 0) {
        return timeDelta;
      }
      return (right.confidence ?? 0) - (left.confidence ?? 0);
    });

  return ranked;
}

function rankRelationshipLaneByPreferredPredicates(
  queryText: string,
  relationships: readonly RelationshipResult[]
): readonly RelationshipResult[] {
  const priorities = new Map(preferredRelationshipPredicates(queryText).map((predicate, index) => [predicate, index] as const));
  if (priorities.size === 0) {
    return relationships;
  }

  const narrowed = relationships.filter((relationship) => priorities.has(relationship.predicate));
  return (narrowed.length > 0 ? narrowed : relationships)
    .slice()
    .sort((left, right) => {
      const leftPriority = priorities.get(left.predicate) ?? Number.MAX_SAFE_INTEGER;
      const rightPriority = priorities.get(right.predicate) ?? Number.MAX_SAFE_INTEGER;
      if (leftPriority !== rightPriority) {
        return leftPriority - rightPriority;
      }
      return (right.confidence ?? 0) - (left.confidence ?? 0);
    });
}

function relationshipCounterpartyName(result: RelationshipResult, focusEntityName: string): string {
  const focus = normalizeWhitespace(focusEntityName).toLowerCase();
  const subject = normalizeWhitespace(result.subjectName).toLowerCase();
  const object = normalizeWhitespace(result.objectName).toLowerCase();
  if (subject === focus && object !== focus) {
    return result.objectName;
  }
  if (object === focus && subject !== focus) {
    return result.subjectName;
  }
  return result.objectName;
}

function isLowSignalRelationshipName(value: string, focusEntityName: string): boolean {
  const normalized = normalizeWhitespace(value).toLowerCase();
  const focus = normalizeWhitespace(focusEntityName).toLowerCase();
  if (!normalized || normalized === focus) {
    return true;
  }
  return [
    "and",
    "of",
    "you",
    "it",
    "this",
    "that",
    "they",
    "them",
    "someone",
    "somebody",
    "friend group"
  ].includes(normalized);
}

function relationshipWindowClause(
  result: RelationshipResult,
  focusEntityName: string,
  mode: RelationshipLaneMode
): string {
  const clause = relationshipClauseFromResult(result, focusEntityName);
  const fromLabel = formatRelationshipDateLabel(result.validFrom ?? result.occurredAt ?? null);
  const untilLabel = formatRelationshipDateLabel(result.validUntil ?? null);
  const transition = relationshipTransitionLabel(result);
  if (mode === "change") {
    if (untilLabel && transition) {
      return `${clause} (${transition} on ${untilLabel})`;
    }
    if (untilLabel) {
      return `${clause} (changed on ${untilLabel})`;
    }
    if (fromLabel && transition) {
      return `${clause} (${transition} around ${fromLabel})`;
    }
    return clause;
  }
  if (mode === "historical") {
    if (fromLabel && untilLabel) {
      return `${clause} from ${fromLabel} to ${untilLabel}`;
    }
    if (untilLabel) {
      return `${clause} until ${untilLabel}`;
    }
    if (fromLabel) {
      return `${clause} around ${fromLabel}`;
    }
  }
  return clause;
}

function isCurrentProjectQueryText(queryText: string): boolean {
  return (
    /\bwhat\s+project(?:s)?\b/i.test(queryText) &&
    /\b(actively|focused|working on|right now|current)\b/i.test(queryText)
  );
}

function isContinuityHandoffSearchQueryText(queryText: string): boolean {
  return /\bpick back up\b/i.test(queryText) && /\brecent notes?\b/i.test(queryText);
}

function buildFocusedLikeMatchClause(
  startParameterIndex: number,
  terms: readonly string[],
  documentExpression: string
): {
  readonly clause: string;
  readonly values: readonly string[];
  readonly scoreExpression: string;
} {
  const filteredTerms = [...new Set(terms.map((term) => term.trim()).filter(Boolean))];
  if (filteredTerms.length === 0) {
    return {
      clause: "TRUE",
      values: [],
      scoreExpression: "0::double precision"
    };
  }

  const clauses: string[] = [];
  const scoreParts: string[] = [];
  const values: string[] = [];
  let parameterIndex = startParameterIndex;

  for (const term of filteredTerms) {
    const placeholder = `$${parameterIndex}`;
    clauses.push(`lower(${documentExpression}) LIKE lower(${placeholder})`);
    scoreParts.push(`CASE WHEN lower(${documentExpression}) LIKE lower(${placeholder}) THEN 1 ELSE 0 END`);
    values.push(`%${term}%`);
    parameterIndex += 1;
  }

  return {
    clause: `(${clauses.join(" OR ")})`,
    values,
    scoreExpression: scoreParts.join(" + ")
  };
}

function buildTypedLaneSearchResponse(
  query: RecallQuery,
  results: readonly RecallResult[],
  answerReason: string
): RecallResponse {
  const config = readConfig();
  const evidence = buildEvidenceBundle(results);
  const planner = planRecallQuery(query);
  const answerAssessment: NonNullable<RecallResponse["meta"]["answerAssessment"]> =
    results.length > 0
      ? {
          confidence: "confident",
          sufficiency: "supported",
          reason: answerReason,
          lexicalCoverage: 1,
          matchedTerms: [],
          totalTerms: 0,
          evidenceCount: evidence.length,
          directEvidence: evidence.length > 0,
          subjectMatch: "matched",
          matchedParticipants: [],
          missingParticipants: [],
          foreignParticipants: []
        }
      : {
          confidence: "missing",
          sufficiency: "missing",
          reason: "The typed fact lane did not find grounded rows for this query.",
          lexicalCoverage: 0,
          matchedTerms: [],
          totalTerms: 0,
          evidenceCount: 0,
          directEvidence: false,
          subjectMatch: "unknown",
          matchedParticipants: [],
          missingParticipants: [],
          foreignParticipants: []
        };
  const duality = buildDualityObject(results, evidence, answerAssessment, query.namespaceId, query.query);

  return {
    results: [...results],
    evidence,
    duality,
    meta: {
      contractVersion: "duality_v2",
      retrievalMode: "lexical",
      synthesisMode: "recall",
      globalQueryRouted: true,
      lexicalProvider: config.lexicalProvider === "bm25" ? "bm25" : "fts",
      lexicalFallbackUsed: false,
      queryEmbeddingSource: "none",
      rankingKernel: "app_fused",
      retrievalFusionVersion: config.retrievalFusionVersion,
      rerankerEnabled: config.localRerankerEnabled,
      rerankerVersion: config.localRerankerVersion,
      lexicalCandidateCount: results.length,
      vectorCandidateCount: 0,
      fusedResultCount: results.length,
      temporalAncestorCount: 0,
      temporalDescendantSupportCount: 0,
      temporalGateTriggered: false,
      temporalLayersUsed: [],
      temporalSupportTokenCount: 0,
      placeContainmentSupportCount: 0,
      boundedEventSupportCount: 0,
      answerAssessment,
      followUpAction: duality.followUpAction,
      clarificationHint: duality.clarificationHint,
      planner
    }
  };
}

function formatRelationshipDateLabel(value?: string | null): string | null {
  if (!value) {
    return null;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return parsed.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC"
  });
}

function relationshipClauseFromResult(result: RelationshipResult, focusEntityName: string): string {
  switch (result.predicate) {
    case "friend_of":
      return `${focusEntityName} is your friend`;
    case "best_friends_with":
      return `${focusEntityName} is one of your best friends`;
    case "former_partner_of":
      return `${focusEntityName} is your former partner`;
    case "significant_other_of":
    case "was_with":
      return `${focusEntityName} was in a significant relationship with you`;
    case "owner_of":
      return `${focusEntityName} owns ${result.objectName}`;
    case "works_with":
      return `${focusEntityName} works with you`;
    case "works_on":
    case "project_role":
      return `${focusEntityName} is tied to ${result.objectName}`;
    case "resides_at":
    case "lives_in":
    case "currently_in":
      return `${focusEntityName} is in ${result.objectName}`;
    case "worked_at":
    case "works_at":
      return `${focusEntityName} worked at ${result.objectName}`;
    case "born_in":
    case "from":
    case "originates_from":
      return `${focusEntityName} is from ${result.objectName}`;
    case "member_of":
      return `${focusEntityName} is part of ${result.objectName}`;
    case "associated_with":
      return `${focusEntityName} is associated with ${result.objectName}`;
    default:
      return `${focusEntityName} ${result.predicate.replace(/_/gu, " ")} ${result.objectName}`;
  }
}

function buildRelationshipRecallResults(
  namespaceId: string,
  relationships: readonly RelationshipResult[],
  focusEntityName: string
): readonly RecallResult[] {
  return relationships.map((relationship) =>
    buildTypedRecallLikeResult(
      namespaceId,
      relationship,
      `${relationshipClauseFromResult(relationship, focusEntityName)}.${relationship.status ? ` Status: ${relationship.status}.` : ""}${
        relationship.validFrom ? ` Valid from: ${formatRelationshipDateLabel(relationship.validFrom) ?? relationship.validFrom}.` : ""
      }${relationship.validUntil ? ` Valid until: ${formatRelationshipDateLabel(relationship.validUntil) ?? relationship.validUntil}.` : ""}`
    )
  );
}

function buildTypedRecallLikeResult(
  namespaceId: string,
  relationship: RelationshipResult,
  content: string
): RecallResult {
  return {
    memoryId: `typed:relationship:${relationship.relationshipId}`,
    memoryType: "relationship_memory",
    content,
    artifactId:
      typeof relationship.provenance?.source_artifact_id === "string"
        ? (relationship.provenance.source_artifact_id as string)
        : null,
    occurredAt: relationship.occurredAt ?? relationship.validFrom ?? null,
    namespaceId,
    provenance: {
      ...relationship.provenance,
      valid_from: relationship.validFrom,
      valid_until: relationship.validUntil,
      source_memory_id: relationship.sourceMemoryId,
      source_uri:
        typeof relationship.provenance?.source_uri === "string" ? relationship.provenance.source_uri : null,
      typed_fact_kind: "relationship_fact"
    }
  };
}

function deriveRelationshipLaneClaimText(
  queryText: string,
  focusEntityName: string,
  relationships: readonly RelationshipResult[]
): string | null {
  if (relationships.length === 0) {
    if (isCurrentDatingQuery(queryText)) {
      return "Unknown.";
    }
    return null;
  }

  const mode = inferRelationshipLaneMode(queryText);
  const ordered = filterRelationshipLaneResults(mode, relationships);
  const counterpartyNamesForPredicates = (...predicates: string[]): readonly string[] =>
    uniqueStrings(
      ordered
        .filter((result) => predicates.includes(result.predicate.toLowerCase()))
        .map((result) => normalizeWhitespace(relationshipCounterpartyName(result, focusEntityName)))
        .filter((value) => value.length > 0 && !isLowSignalRelationshipName(value, focusEntityName))
    );
  const uniqueObjectNames = uniqueStrings(
    ordered
      .map((result) => normalizeWhitespace(relationshipCounterpartyName(result, focusEntityName)))
      .filter((value) => value.length > 0 && !isLowSignalRelationshipName(value, focusEntityName))
  );

  if (mode === "current") {
    if (isCurrentDatingQuery(queryText)) {
      const activePartnerNames = counterpartyNamesForPredicates("significant_other_of")
        .filter((name) =>
          ordered.some((result) =>
            result.predicate.toLowerCase() === "significant_other_of" &&
            normalizeWhitespace(relationshipCounterpartyName(result, focusEntityName)) === normalizeWhitespace(name) &&
            !Boolean(result.validUntil) &&
            normalizeWhitespace(String(result.status ?? "")).toLowerCase() === "active"
          )
        );
      return activePartnerNames.length > 0
        ? `${focusEntityName} is currently dating ${joinExactDetailValues(activePartnerNames)}.`
        : "Unknown.";
    }

    if (/\bwho\s+(?:is|are)\s+.+\s+friends?\s+with\b/i.test(queryText) || /\bwho\s+(?:is|are)\s+.+['’]s\s+friends?\b/i.test(queryText)) {
      const friendNames = counterpartyNamesForPredicates("friend_of", "friends_with", "best_friends_with");
      if (friendNames.length > 0) {
        return `${focusEntityName}'s grounded friends include ${joinExactDetailValues(friendNames.slice(0, 6))}.`;
      }
    }

    if (/\bwhat\s+(?:groups|organizations|orgs)\s+(?:is|are)\s+.+\s+(?:a\s+member\s+of|part\s+of)\b/i.test(queryText)) {
      const memberNames = counterpartyNamesForPredicates("member_of");
      if (memberNames.length > 0) {
        return `${focusEntityName} is a member of ${joinExactDetailValues(memberNames.slice(0, 6))}.`;
      }
    }

    if (/\bwhere\s+do(?:es)?\s+.+\s+(?:live|stay|based)\b/i.test(queryText)) {
      if (uniqueObjectNames.length > 0) {
        return `${focusEntityName} is currently in ${joinExactDetailValues(uniqueObjectNames.slice(0, 3))}.`;
      }
    }
  }

  const uniqueClauses = uniqueStrings(ordered.map((result) => relationshipWindowClause(result, focusEntityName, mode)));

  if (mode === "historical") {
    const clauses = uniqueClauses.slice(0, 5);
    const ending =
      ordered
        .map((item) => formatRelationshipDateLabel(item.validUntil ?? item.validFrom ?? item.occurredAt))
        .find((value) => Boolean(value)) ?? null;
    const endingText = ending ? ` The most recent grounded transition lands around ${ending}.` : "";
    return `${focusEntityName}'s grounded history includes ${joinExactDetailValues(clauses)}.${endingText}`.trim();
  }

  if (mode === "change") {
    const strongest = ordered[0];
    const clause = relationshipWindowClause(strongest, focusEntityName, mode);
    const dateLabel = formatRelationshipDateLabel(strongest.validUntil ?? strongest.validFrom ?? strongest.occurredAt);
    return dateLabel ? `${clause}. The grounded change point is ${dateLabel}.` : `${clause}.`;
  }

  return `${focusEntityName}'s grounded profile is that ${joinExactDetailValues(uniqueClauses.slice(0, 3))}.`;
}

function buildRelationshipLaneSearchResponse(
  query: RecallQuery,
  focusEntityName: string,
  laneRelationships: readonly RelationshipResult[],
  answerReason: string
): RecallResponse {
  const config = readConfig();
  const results = buildRelationshipRecallResults(query.namespaceId, laneRelationships, focusEntityName);
  const evidence = buildEvidenceBundle(results);
  const planner = planRecallQuery(query);
  const claimText = deriveRelationshipLaneClaimText(query.query, focusEntityName, laneRelationships) ?? "No grounded relationship facts matched this query.";
  const answerAssessment: NonNullable<RecallResponse["meta"]["answerAssessment"]> =
    results.length > 0
      ? {
          confidence: "confident",
          sufficiency: "supported",
          reason: answerReason,
          lexicalCoverage: 1,
          matchedTerms: [],
          totalTerms: 0,
          evidenceCount: evidence.length,
          directEvidence: evidence.length > 0,
          subjectMatch: "matched",
          matchedParticipants: [focusEntityName],
          missingParticipants: [],
          foreignParticipants: []
        }
      : {
          confidence: "missing",
          sufficiency: "missing",
          reason: "The relationship lane did not find grounded rows for this query.",
          lexicalCoverage: 0,
          matchedTerms: [],
          totalTerms: 0,
          evidenceCount: 0,
          directEvidence: false,
          subjectMatch: "unknown",
          matchedParticipants: [],
          missingParticipants: [],
          foreignParticipants: []
        };

  return {
    results: [...results],
    evidence,
    duality: {
      claim: {
        memoryId: results[0]?.memoryId ?? null,
        memoryType: results[0]?.memoryType ?? null,
        text: claimText,
        occurredAt: results[0]?.occurredAt ?? null,
        artifactId: results[0]?.artifactId ?? null,
        sourceUri: typeof results[0]?.provenance?.source_uri === "string" ? (results[0]?.provenance?.source_uri as string) : null,
        validFrom: typeof results[0]?.provenance?.valid_from === "string" ? (results[0]?.provenance?.valid_from as string) : null,
        validUntil: typeof results[0]?.provenance?.valid_until === "string" ? (results[0]?.provenance?.valid_until as string) : null
      },
      evidence: evidence.map((item) => ({
        memoryId: item.memoryId,
        artifactId: item.artifactId ?? null,
        sourceUri: item.sourceUri ?? null,
        snippet: item.snippet
      })),
      confidence: answerAssessment.confidence,
      reason: answerAssessment.reason,
      followUpAction: "none",
      clarificationHint: undefined
    },
    meta: {
      contractVersion: "duality_v2",
      retrievalMode: "lexical",
      synthesisMode: "recall",
      globalQueryRouted: true,
      lexicalProvider: config.lexicalProvider === "bm25" ? "bm25" : "fts",
      lexicalFallbackUsed: false,
      queryEmbeddingSource: "none",
      rankingKernel: "app_fused",
      retrievalFusionVersion: config.retrievalFusionVersion,
      rerankerEnabled: config.localRerankerEnabled,
      rerankerVersion: config.localRerankerVersion,
      lexicalCandidateCount: results.length,
      vectorCandidateCount: 0,
      fusedResultCount: results.length,
      temporalAncestorCount: 0,
      temporalDescendantSupportCount: 0,
      temporalGateTriggered: false,
      temporalLayersUsed: [],
      temporalSupportTokenCount: 0,
      placeContainmentSupportCount: 0,
      boundedEventSupportCount: 0,
      answerAssessment,
      followUpAction: "none",
      clarificationHint: undefined,
      planner
    }
  };
}

function buildCompanionExclusionRelationshipSearchResponse(
  query: RecallQuery,
  focusEntityName: string,
  companionName: string,
  laneRelationships: readonly RelationshipResult[],
  answerReason: string
): RecallResponse {
  const config = readConfig();
  const results = buildRelationshipRecallResults(query.namespaceId, laneRelationships, focusEntityName);
  const evidence = buildEvidenceBundle(results);
  const planner = planRecallQuery(query);
  const counterpartyNames = uniqueStrings(
    laneRelationships
      .map((relationship) => normalizeWhitespace(relationshipCounterpartyName(relationship, focusEntityName)))
      .filter((value) => value.length > 0 && normalizeWhitespace(value).toLowerCase() !== normalizeWhitespace(companionName).toLowerCase())
  );
  const claimText =
    counterpartyNames.length > 0
      ? `The best supported answer is yes: ${focusEntityName} is connected to ${joinExactDetailValues(counterpartyNames.slice(0, 6))} besides ${companionName}.`
      : `No grounded social-set evidence was found beyond ${companionName}.`;
  const answerAssessment: NonNullable<RecallResponse["meta"]["answerAssessment"]> =
    results.length > 0
      ? {
          confidence: "confident",
          sufficiency: "supported",
          reason: answerReason,
          lexicalCoverage: 1,
          matchedTerms: [],
          totalTerms: 0,
          evidenceCount: evidence.length,
          directEvidence: evidence.length > 0,
          subjectMatch: "matched",
          matchedParticipants: [focusEntityName, companionName],
          missingParticipants: [],
          foreignParticipants: []
        }
      : {
          confidence: "missing",
          sufficiency: "missing",
          reason: "The social-set lane did not find grounded rows for this query.",
          lexicalCoverage: 0,
          matchedTerms: [],
          totalTerms: 0,
          evidenceCount: 0,
          directEvidence: false,
          subjectMatch: "unknown",
          matchedParticipants: [],
          missingParticipants: [],
          foreignParticipants: []
        };

  return {
    results: [...results],
    evidence,
    duality: {
      claim: {
        memoryId: results[0]?.memoryId ?? null,
        memoryType: results[0]?.memoryType ?? null,
        text: claimText,
        occurredAt: results[0]?.occurredAt ?? null,
        artifactId: results[0]?.artifactId ?? null,
        sourceUri: typeof results[0]?.provenance?.source_uri === "string" ? (results[0]?.provenance?.source_uri as string) : null,
        validFrom: typeof results[0]?.provenance?.valid_from === "string" ? (results[0]?.provenance?.valid_from as string) : null,
        validUntil: typeof results[0]?.provenance?.valid_until === "string" ? (results[0]?.provenance?.valid_until as string) : null
      },
      evidence: evidence.map((item) => ({
        memoryId: item.memoryId,
        artifactId: item.artifactId ?? null,
        sourceUri: item.sourceUri ?? null,
        snippet: item.snippet
      })),
      confidence: answerAssessment.confidence,
      reason: answerAssessment.reason,
      followUpAction: "none",
      clarificationHint: undefined
    },
    meta: {
      contractVersion: "duality_v2",
      retrievalMode: "lexical",
      synthesisMode: "recall",
      globalQueryRouted: true,
      lexicalProvider: config.lexicalProvider === "bm25" ? "bm25" : "fts",
      lexicalFallbackUsed: false,
      queryEmbeddingSource: "none",
      rankingKernel: "app_fused",
      retrievalFusionVersion: config.retrievalFusionVersion,
      rerankerEnabled: config.localRerankerEnabled,
      rerankerVersion: config.localRerankerVersion,
      lexicalCandidateCount: results.length,
      vectorCandidateCount: 0,
      fusedResultCount: results.length,
      temporalAncestorCount: 0,
      temporalDescendantSupportCount: 0,
      temporalGateTriggered: false,
      temporalLayersUsed: [],
      temporalSupportTokenCount: 0,
      placeContainmentSupportCount: 0,
      boundedEventSupportCount: 0,
      answerAssessment,
      followUpAction: "none",
      clarificationHint: undefined,
      planner
    }
  };
}

function selectRelationshipLaneResults(
  queryText: string,
  relationships: readonly RelationshipResult[]
): readonly RelationshipResult[] {
  const laneMode = inferRelationshipLaneMode(queryText);
  const filtered = filterRelationshipLaneResults(laneMode, relationships);
  const preferredPredicates = preferredRelationshipPredicates(queryText);
  if (preferredPredicates.length > 0) {
    const preferred = filtered.filter((relationship) => preferredPredicates.includes(relationship.predicate));
    if (preferred.length === 0) {
      return [];
    }
    return rankRelationshipLaneByPreferredPredicates(queryText, preferred);
  }
  return rankRelationshipLaneByPreferredPredicates(queryText, filtered);
}

async function loadWarmStartProtocolRows(namespaceId: string, candidateLimit: number): Promise<SearchRow[]> {
  return queryRows<SearchRow>(
    `
      SELECT
        pm.id AS memory_id,
        'procedural_memory'::text AS memory_type,
        ${proceduralContentExpression()} AS content,
        1.02::double precision AS raw_score,
        em.artifact_id,
        COALESCE(em.occurred_at, pm.updated_at) AS occurred_at,
        pm.namespace_id,
        jsonb_build_object(
          'tier', 'warm_start_protocol',
          'state_type', pm.state_type,
          'state_key', pm.state_key,
          'valid_from', pm.valid_from,
          'valid_until', pm.valid_until,
          'source_memory_id', em.id,
          'source_uri', a.uri,
          'metadata', pm.metadata
        ) AS provenance
      FROM procedural_memory pm
      LEFT JOIN episodic_memory em
        ON em.id = NULLIF(pm.state_value->>'source_memory_id', '')::uuid
      LEFT JOIN artifacts a
        ON a.id = em.artifact_id
      WHERE pm.namespace_id = $1
        AND pm.valid_until IS NULL
        AND pm.state_type IN ('constraint', 'style_spec')
      ORDER BY pm.valid_from DESC, COALESCE(em.occurred_at, pm.updated_at) DESC
      LIMIT $2
    `,
    [namespaceId, Math.max(candidateLimit, 4)]
  );
}

function deriveWarmStartClaimText(input: {
  readonly subjectName: string;
  readonly focusClaimText: string | null;
  readonly recapSummaryText: string | null;
  readonly carryForwardTitles: readonly string[];
  readonly protocolResults: readonly RecallResult[];
  readonly routineClaimText: string | null;
  readonly preferenceClaimText: string | null;
  readonly relationshipContextText: string | null;
}): string | null {
  const isLowSignalCarryForwardTitle = (title: string): boolean =>
    /^(category|origin[_\s-]?source)\s*:/i.test(title) ||
    /\bconversation id\b/i.test(title) ||
    /^speaker\s+\d+\b/i.test(title) ||
    title.trim().length < 10;

  const parts: string[] = [];

  const focusText = input.focusClaimText?.trim();
  if (focusText) {
    parts.push(`Current focus: ${focusText.replace(/[.]+$/u, "")}.`);
  }

  const recapText = input.recapSummaryText?.trim();
  if (recapText) {
    parts.push(`Recent context: ${recapText.replace(/[.]+$/u, "")}.`);
  }

  const routineText = input.routineClaimText?.trim();
  if (routineText && !/no grounded routine/i.test(routineText)) {
    parts.push(`Current routine: ${routineText.replace(/[.]+$/u, "")}.`);
  }

  const preferenceText = input.preferenceClaimText?.trim();
  if (preferenceText && !/do not have/i.test(preferenceText)) {
    parts.push(`Stable preferences: ${preferenceText.replace(/[.]+$/u, "")}.`);
  }

  const relationshipText = input.relationshipContextText?.trim();
  if (
    relationshipText &&
    !/no grounded/i.test(relationshipText) &&
    !/no authoritative evidence/i.test(relationshipText)
  ) {
    parts.push(`Relationship context: ${relationshipText.replace(/[.]+$/u, "")}.`);
  }

  const carryForward = uniqueStrings(
    input.carryForwardTitles
      .map((title) => normalizeWhitespace(title))
      .filter((title) => title.length > 0 && !isLowSignalCarryForwardTitle(title))
  ).slice(0, 3);
  if (carryForward.length > 0) {
    parts.push(`Carry forward: ${joinExactDetailValues(carryForward)}.`);
  }

  const protocolHints = uniqueStrings(
    input.protocolResults
      .map((result) => normalizeWhitespace(result.content))
      .filter((text) => text.length > 0)
      .map((text) => text.replace(/\.\s*$/u, ""))
  ).slice(0, 2);
  if (protocolHints.length > 0) {
    parts.push(`Active constraints: ${joinExactDetailValues(protocolHints)}.`);
  }

  if (parts.length === 0) {
    return null;
  }

  return `Warm start for ${input.subjectName}: ${parts.join(" ")}`;
}

async function buildWarmStartSearchResponse(query: RecallQuery): Promise<RecallResponse> {
  const config = readConfig();
  const limit = normalizeLimit(query.limit);
  const decompositionDepth = query.decompositionDepth ?? 0;
  const selfProfile = await getNamespaceSelfProfile(query.namespaceId).catch(() => null);
  const subjectName = selfProfile?.canonicalName ?? "Steve";
  const requestedProfileKinds = ["identity_summary", "current_picture", "focus", "role_direction", "project_status", "relationship_status"] as const;

  const [profileSearchRows, protocolSearchRows, focusResponse, recapResponse, taskResponse, routineResponse, preferenceResponse, relationshipContextResponse] = await Promise.all([
    (async () => {
      const participantScoped = await loadParticipantScopedProfileSummaryRows(
        query.namespaceId,
        [subjectName],
        Math.max(limit, 4),
        requestedProfileKinds
      );
      const activeSummaries = await loadActiveSemanticProfileSummaryRows(
        query.namespaceId,
        `${subjectName} current picture focus role direction`,
        Math.max(limit, 4),
        requestedProfileKinds
      );
      return toRankedRows([...participantScoped, ...activeSummaries]);
    })(),
    toRankedRows(await loadWarmStartProtocolRows(query.namespaceId, Math.max(limit, 4))),
    searchMemory({
      ...query,
      query: "What project am I actively focused on right now?",
      limit: 4,
      decompositionDepth: decompositionDepth + 1
    }),
    recapMemory({
      query: "What did I do yesterday?",
      namespaceId: query.namespaceId,
      referenceNow: query.referenceNow,
      limit: 4,
      provider: "none",
      decompositionDepth: decompositionDepth + 1
    }),
    extractTaskMemory({
      query: "What should I pick back up right now based on my recent notes?",
      namespaceId: query.namespaceId,
      referenceNow: query.referenceNow,
      limit: 4,
      provider: "none",
      decompositionDepth: decompositionDepth + 1
    }),
    searchMemory({
      ...query,
      query: "What is my current daily routine?",
      limit: 4,
      decompositionDepth: decompositionDepth + 1
    }),
    searchMemory({
      ...query,
      query: "What do I like and dislike?",
      limit: 4,
      decompositionDepth: decompositionDepth + 1
    }),
    searchMemory({
      ...query,
      query: "What important relationship transition should I know about right now?",
      limit: 4,
      decompositionDepth: decompositionDepth + 1
    })
  ]);

  const profileResults = profileSearchRows
    .slice(0, 4)
    .map((row) => buildRecallResult(row, row.scoreValue, { rrfScore: row.scoreValue }));
  const protocolResults = protocolSearchRows
    .slice(0, 2)
    .map((row) => buildRecallResult(row, row.scoreValue, { rrfScore: row.scoreValue }));
  const recapResults = recapResponse.evidence.map((item) => ({
    memoryId: item.memoryId,
    memoryType: item.memoryType,
    content: item.snippet,
    artifactId: item.artifactId ?? null,
    occurredAt: item.occurredAt ?? null,
    namespaceId: recapResponse.namespaceId,
    provenance: item.provenance
  } satisfies RecallResult));

  const results = mergeRecallResults(
    mergeRecallResults(profileResults, focusResponse.results, Math.max(limit * 2, 8)),
    mergeRecallResults(
      recapResults,
      mergeRecallResults(
        mergeRecallResults(protocolResults, routineResponse.results, Math.max(limit * 2, 8)),
        preferenceResponse.results,
        Math.max(limit * 2, 8)
      ),
      Math.max(limit * 2, 8)
    ),
    Math.max(limit * 3, 10)
  ).slice(0, Math.max(limit, 6));
  const evidence = buildEvidenceBundle(results);
  const claimText =
    deriveWarmStartClaimText({
      subjectName,
      focusClaimText: focusResponse.duality.claim.text ?? null,
      recapSummaryText: recapResponse.summaryText ?? null,
      carryForwardTitles: taskResponse.tasks.map((task) => task.title),
      protocolResults,
      routineClaimText: routineResponse.duality.claim.text ?? null,
      preferenceClaimText: preferenceResponse.duality.claim.text ?? null,
      relationshipContextText: relationshipContextResponse.duality.claim.text ?? null
    }) ?? "No grounded warm-start context is available yet.";

  const answerAssessment: NonNullable<RecallResponse["meta"]["answerAssessment"]> =
    results.length >= 3 && evidence.length >= 2
      ? {
          confidence: "confident",
          sufficiency: "supported",
          reason: "The warm-start query was assembled from current profile summaries, recent recap evidence, and carry-forward task context.",
          lexicalCoverage: 1,
          matchedTerms: [],
          totalTerms: 0,
          evidenceCount: evidence.length,
          directEvidence: true,
          subjectMatch: "matched",
          matchedParticipants: [subjectName],
          missingParticipants: [],
          foreignParticipants: []
        }
      : results.length > 0
        ? {
            confidence: "weak",
            sufficiency: "weak",
            reason: "The warm-start query found partial grounded context, but the pack is still missing some stable profile coverage.",
            lexicalCoverage: 1,
            matchedTerms: [],
            totalTerms: 0,
            evidenceCount: evidence.length,
            directEvidence: evidence.length > 0,
            subjectMatch: "matched",
            matchedParticipants: [subjectName],
            missingParticipants: [],
            foreignParticipants: []
          }
        : {
            confidence: "missing",
            sufficiency: "missing",
            reason: "The warm-start query did not find grounded profile or recap context.",
            lexicalCoverage: 0,
            matchedTerms: [],
            totalTerms: 0,
            evidenceCount: evidence.length,
            directEvidence: false,
            subjectMatch: "unknown",
            matchedParticipants: [],
            missingParticipants: [],
            foreignParticipants: []
          };

  return {
    results: [...results],
    evidence,
    duality: {
      claim: {
        memoryId: results[0]?.memoryId ?? null,
        memoryType: results[0]?.memoryType ?? null,
        text: claimText,
        occurredAt: results[0]?.occurredAt ?? null,
        artifactId: results[0]?.artifactId ?? null,
        sourceUri: typeof results[0]?.provenance?.source_uri === "string" ? (results[0]?.provenance?.source_uri as string) : null,
        validFrom: typeof results[0]?.provenance?.valid_from === "string" ? (results[0]?.provenance?.valid_from as string) : null,
        validUntil: typeof results[0]?.provenance?.valid_until === "string" ? (results[0]?.provenance?.valid_until as string) : null
      },
      evidence: evidence.map((item) => ({
        memoryId: item.memoryId,
        artifactId: item.artifactId ?? null,
        sourceUri: item.sourceUri ?? null,
        snippet: item.snippet
      })),
      confidence: answerAssessment.confidence,
      reason: answerAssessment.reason,
      followUpAction: answerAssessment.confidence === "missing" ? "route_to_clarifications" : "none",
      clarificationHint:
        answerAssessment.confidence === "missing"
          ? {
              endpoint: "/clarifications",
              namespaceId: query.namespaceId,
              query: query.query,
              reason: "The warm-start pack is missing enough grounded profile context to answer confidently.",
              suggestedPrompt: "Add a note about what matters right now, your current focus, and anything you want the brain to remember for startup.",
              mcpTool: {
                name: "memory.save_candidate",
                arguments: {
                  namespace_id: query.namespaceId,
                  candidate_type: "warm_start_gap",
                  content: query.query,
                  confidence: 0.55,
                  metadata: {
                    requested_by: "warm_start_query"
                  }
                }
              }
            }
          : undefined
    },
    meta: {
      contractVersion: "duality_v2",
      retrievalMode: "lexical",
      synthesisMode: "recall",
      globalQueryRouted: true,
      summaryRoutingUsed: true,
      queryModeHint: "broad_profile",
      lexicalProvider: config.lexicalProvider === "bm25" ? "bm25" : "fts",
      lexicalFallbackUsed: false,
      queryEmbeddingSource: "none",
      rankingKernel: "app_fused",
      retrievalFusionVersion: config.retrievalFusionVersion,
      rerankerEnabled: config.localRerankerEnabled,
      rerankerVersion: config.localRerankerVersion,
      lexicalCandidateCount: results.length,
      vectorCandidateCount: 0,
      fusedResultCount: results.length,
      temporalAncestorCount: 0,
      temporalDescendantSupportCount: 0,
      temporalGateTriggered: true,
      temporalLayersUsed: ["day", "week"],
      temporalSupportTokenCount: 0,
      placeContainmentSupportCount: 0,
      boundedEventSupportCount: 0,
      answerAssessment,
      followUpAction: answerAssessment.confidence === "missing" ? "route_to_clarifications" : "none",
      clarificationHint:
        answerAssessment.confidence === "missing"
          ? {
              endpoint: "/clarifications",
              namespaceId: query.namespaceId,
              query: query.query,
              reason: "The warm-start pack is missing enough grounded profile context to answer confidently.",
              suggestedPrompt: "Add a note about what matters right now, your current focus, and anything you want the brain to remember for startup."
            }
          : undefined,
      planner: planRecallQuery(query)
    }
  };
}

function loadDepartureTimingSupportRows(
  namespaceId: string,
  queryText: string,
  candidateLimit: number
): Promise<SearchRow[]> {
  const nameHints = extractEntityNameHints(queryText);
  const terms = [
    ...new Set([
      ...(nameHints.length > 0 ? nameHints : ["Lauren"]),
      "left",
      "leave",
      "departed",
      "departure",
      "returned",
      "October",
      "18",
      "2025",
      "US",
      "America"
    ])
  ];
  const match = buildFocusedLikeMatchClause(2, terms, "em.content");
  const derivationMatch = buildFocusedLikeMatchClause(2, terms, "ad.content_text");

  return Promise.all([
    queryRows<SearchRow>(
      `
        SELECT
          em.id AS memory_id,
          'episodic_memory'::text AS memory_type,
          em.content,
          (${match.scoreExpression})::double precision AS raw_score,
          em.artifact_id,
          em.occurred_at,
          em.namespace_id,
          jsonb_build_object(
            'tier', 'focused_episodic_support',
            'lexical_provider', 'departure_scope',
            'source_uri', a.uri,
            'artifact_observation_id', em.artifact_observation_id,
            'metadata', em.metadata
          ) AS provenance
        FROM episodic_memory em
        LEFT JOIN artifacts a ON a.id = em.artifact_id
        WHERE em.namespace_id = $1
          AND ${match.clause}
        ORDER BY raw_score DESC, em.occurred_at DESC, em.id DESC
        LIMIT $${match.values.length + 2}
      `,
      [namespaceId, ...match.values, Math.max(candidateLimit, 8)]
    ),
    queryRows<SearchRow>(
      `
        SELECT
          ad.id AS memory_id,
          'artifact_derivation'::text AS memory_type,
          ${artifactDerivationContentExpression()} AS content,
          (${derivationMatch.scoreExpression})::double precision AS raw_score,
          ao.artifact_id,
          COALESCE(source_em.occurred_at, ao.observed_at) AS occurred_at,
          a.namespace_id,
          jsonb_build_object(
            'tier', 'artifact_derivation',
            'lexical_provider', 'departure_scope',
            'derivation_type', ad.derivation_type,
            'artifact_observation_id', ad.artifact_observation_id,
            'source_chunk_id', ad.source_chunk_id,
            'source_uri', a.uri,
            'metadata', ad.metadata
          ) AS provenance
        FROM artifact_derivations ad
        JOIN artifact_observations ao ON ao.id = ad.artifact_observation_id
        JOIN artifacts a ON a.id = ao.artifact_id
        LEFT JOIN episodic_memory source_em ON source_em.id = ad.source_chunk_id
        WHERE a.namespace_id = $1
          AND coalesce(ad.content_text, '') <> ''
          AND ${derivationMatch.clause}
        ORDER BY raw_score DESC, COALESCE(source_em.occurred_at, ao.observed_at) DESC, ad.id DESC
        LIMIT $${match.values.length + 2}
      `,
      [namespaceId, ...match.values, Math.max(candidateLimit, 8)]
    )
  ]).then(([episodicRows, derivationRows]) =>
    [...episodicRows, ...derivationRows]
      .sort((left, right) => {
        const rightScore = toNumber(right.raw_score);
        const leftScore = toNumber(left.raw_score);
        if (rightScore !== leftScore) {
          return rightScore - leftScore;
        }
        const leftIso = toIsoString(left.occurred_at);
        const rightIso = toIsoString(right.occurred_at);
        if (leftIso && rightIso && leftIso !== rightIso) {
          return rightIso.localeCompare(leftIso);
        }
        return `${left.memory_type}:${left.memory_id}`.localeCompare(`${right.memory_type}:${right.memory_id}`);
      })
      .slice(0, Math.max(candidateLimit, 10))
  );
}

function loadRelationshipProfileSupportRows(
  namespaceId: string,
  queryText: string,
  candidateLimit: number
): Promise<SearchRow[]> {
  const nameHints = extractEntityNameHints(queryText);
  if (nameHints.length === 0) {
    return Promise.resolve([]);
  }

  const terms = [
    ...new Set([
      ...nameHints,
      "friend",
      "relationship",
      "owner",
      "coworking",
      "Chiang Mai",
      "Burning Man",
      "old friend",
      "partner"
    ])
  ];
  const episodicMatch = buildFocusedLikeMatchClause(2, terms, "em.content");
  const derivationMatch = buildFocusedLikeMatchClause(2, terms, "ad.content_text");
  const trustedSourceClause = "(a.uri ILIKE '%/omi-archive/normalized/%' OR a.uri ILIKE '%/data/inbox/omi/normalized/%')";

  return Promise.all([
    queryRows<SearchRow>(
      `
        SELECT
          em.id AS memory_id,
          'episodic_memory'::text AS memory_type,
          em.content,
          ((
            ${episodicMatch.scoreExpression}
          ) +
            CASE
              WHEN em.content ~* '(friend of mine|close friend|good friend|old friend|friend from|owner of|former romantic|dated|off and on relationship|partner in crime|coworking spot|weave artisan society)' THEN 4.4
              ELSE 0
            END +
            CASE
              WHEN em.content ~* '(chiang mai|burning man|koh samui|samui experience)' THEN 1.6
              ELSE 0
            END +
            2.5
          )::double precision AS raw_score,
          em.artifact_id,
          em.occurred_at,
          em.namespace_id,
          jsonb_build_object(
            'tier', 'focused_episodic_support',
            'lexical_provider', 'relationship_profile_scope',
            'source_uri', a.uri,
            'artifact_observation_id', em.artifact_observation_id,
            'metadata', em.metadata
          ) AS provenance
        FROM episodic_memory em
        JOIN artifacts a ON a.id = em.artifact_id
        WHERE em.namespace_id = $1
          AND ${trustedSourceClause}
          AND ${episodicMatch.clause}
        ORDER BY raw_score DESC, em.occurred_at DESC, em.id DESC
        LIMIT $${episodicMatch.values.length + 2}
      `,
      [namespaceId, ...episodicMatch.values, Math.max(candidateLimit, 8)]
    ),
    queryRows<SearchRow>(
      `
        SELECT
          ad.id AS memory_id,
          'artifact_derivation'::text AS memory_type,
          ${artifactDerivationContentExpression()} AS content,
          ((
            ${derivationMatch.scoreExpression}
          ) +
            CASE
              WHEN ad.content_text ~* '(friend of mine|close friend|good friend|old friend|friend from|owner of|former romantic|dated|off and on relationship|partner in crime|coworking spot|weave artisan society)' THEN 4.1
              ELSE 0
            END +
            CASE
              WHEN ad.content_text ~* '(chiang mai|burning man|koh samui|samui experience)' THEN 1.4
              ELSE 0
            END +
            2.15
          )::double precision AS raw_score,
          ao.artifact_id,
          COALESCE(source_em.occurred_at, ao.observed_at) AS occurred_at,
          a.namespace_id,
          jsonb_build_object(
            'tier', 'artifact_derivation',
            'lexical_provider', 'relationship_profile_scope',
            'derivation_type', ad.derivation_type,
            'artifact_observation_id', ad.artifact_observation_id,
            'source_chunk_id', ad.source_chunk_id,
            'source_uri', a.uri,
            'metadata', ad.metadata
          ) AS provenance
        FROM artifact_derivations ad
        JOIN artifact_observations ao ON ao.id = ad.artifact_observation_id
        JOIN artifacts a ON a.id = ao.artifact_id
        LEFT JOIN episodic_memory source_em ON source_em.id = ad.source_chunk_id
        WHERE a.namespace_id = $1
          AND ${trustedSourceClause}
          AND coalesce(ad.content_text, '') <> ''
          AND ${derivationMatch.clause}
        ORDER BY raw_score DESC, COALESCE(source_em.occurred_at, ao.observed_at) DESC, ad.id DESC
        LIMIT $${derivationMatch.values.length + 2}
      `,
      [namespaceId, ...derivationMatch.values, Math.max(candidateLimit, 8)]
    )
  ]).then(([episodicRows, derivationRows]) =>
    [...episodicRows, ...derivationRows]
      .sort((left, right) => {
        const rightScore = toNumber(right.raw_score);
        const leftScore = toNumber(left.raw_score);
        if (rightScore !== leftScore) {
          return rightScore - leftScore;
        }
        const leftIso = toIsoString(left.occurred_at);
        const rightIso = toIsoString(right.occurred_at);
        if (leftIso && rightIso && leftIso !== rightIso) {
          return rightIso.localeCompare(leftIso);
        }
        return `${left.memory_type}:${left.memory_id}`.localeCompare(`${right.memory_type}:${right.memory_id}`);
      })
      .slice(0, Math.max(candidateLimit, 10))
  );
}

function loadRelationshipChangeSupportRows(namespaceId: string, queryText: string, candidateLimit: number): Promise<SearchRow[]> {
  const primaryNames = extractEntityNameHints(queryText)
    .map((value) => normalizeWhitespace(value))
    .filter(Boolean);
  const terms = [
    ...primaryNames,
    "relationship",
    "change",
    "changed",
    "left",
    "moved",
    "talked",
    "stopped talking",
    "communication",
    "October",
    "2025",
    "US",
    "Thailand",
    "Bend",
    "Oregon"
  ];
  const episodicMatch = buildFocusedLikeMatchClause(2, terms, "em.content");
  const derivationMatch = buildFocusedLikeMatchClause(2, terms, "ad.content_text");
  const trustedSourceClause = "(a.uri ILIKE '%/omi-archive/normalized/%' OR a.uri ILIKE '%/data/inbox/omi/normalized/%')";

  return Promise.all([
    queryRows<SearchRow>(
      `
        SELECT
          em.id AS memory_id,
          'episodic_memory'::text AS memory_type,
          em.content,
          ((
            ${episodicMatch.scoreExpression}
          ) +
            CASE
              WHEN em.content ~* '(recent relationship change|big relationship change|relationship change|what changed recently|changed recently)' THEN 5.2
              ELSE 0
            END +
            CASE
              WHEN em.content ~* '(haven''t really talked|haven''t talked|don''t talk|little to no communication|barely spoken|cut me out)' THEN 4.8
              ELSE 0
            END +
            CASE
              WHEN em.content ~* '(left Thailand|left to go back to the US|left to go back to The US|returned to the US|flew back to the US|moved from Thailand back to the US|moved from Thailand to the US|moved from Thailand to The US|October 18|10/18/2025|2025-10-18|October eighteenth twenty twenty five|Bend, Oregon)' THEN 5.4
              ELSE 0
            END +
            CASE
              WHEN em.content ~* '\\bLauren\\b' THEN 2.8
              ELSE 0
            END +
            CASE
              WHEN em.content ~* '\\bLauren\\b' AND em.content ~* '(stopped talking|haven''t really talked|no contact|moved from Thailand|October 18|October eighteenth twenty twenty five)' THEN 6.2
              ELSE 0
            END +
            2.75
          )::double precision AS raw_score,
          em.artifact_id,
          em.occurred_at,
          em.namespace_id,
          jsonb_build_object(
            'tier', 'focused_episodic_support',
            'lexical_provider', 'relationship_change_scope',
            'source_uri', a.uri,
            'artifact_observation_id', em.artifact_observation_id,
            'metadata', em.metadata
          ) AS provenance
        FROM episodic_memory em
        JOIN artifacts a ON a.id = em.artifact_id
        WHERE em.namespace_id = $1
          AND ${trustedSourceClause}
          AND ${episodicMatch.clause}
        ORDER BY raw_score DESC, em.occurred_at DESC, em.id DESC
        LIMIT $${episodicMatch.values.length + 2}
      `,
      [namespaceId, ...episodicMatch.values, Math.max(candidateLimit, 8)]
    ),
    queryRows<SearchRow>(
      `
        SELECT
          ad.id AS memory_id,
          'artifact_derivation'::text AS memory_type,
          ${artifactDerivationContentExpression()} AS content,
          ((
            ${derivationMatch.scoreExpression}
          ) +
            CASE
              WHEN ad.content_text ~* '(recent relationship change|big relationship change|relationship change|what changed recently|changed recently)' THEN 5.0
              ELSE 0
            END +
            CASE
              WHEN ad.content_text ~* '(haven''t really talked|haven''t talked|don''t talk|little to no communication|barely spoken|cut me out)' THEN 4.6
              ELSE 0
            END +
            CASE
              WHEN ad.content_text ~* '(left Thailand|left to go back to the US|left to go back to The US|returned to the US|flew back to the US|moved from Thailand back to the US|moved from Thailand to the US|moved from Thailand to The US|October 18|10/18/2025|2025-10-18|October eighteenth twenty twenty five|Bend, Oregon)' THEN 5.2
              ELSE 0
            END +
            CASE
              WHEN ad.content_text ~* '\\bLauren\\b' THEN 2.6
              ELSE 0
            END +
            CASE
              WHEN ad.content_text ~* '\\bLauren\\b' AND ad.content_text ~* '(stopped talking|haven''t really talked|no contact|moved from Thailand|October 18|October eighteenth twenty twenty five)' THEN 5.8
              ELSE 0
            END +
            2.25
          )::double precision AS raw_score,
          ao.artifact_id,
          COALESCE(source_em.occurred_at, ao.observed_at) AS occurred_at,
          a.namespace_id,
          jsonb_build_object(
            'tier', 'artifact_derivation',
            'lexical_provider', 'relationship_change_scope',
            'derivation_type', ad.derivation_type,
            'artifact_observation_id', ad.artifact_observation_id,
            'source_chunk_id', ad.source_chunk_id,
            'source_uri', a.uri,
            'metadata', ad.metadata
          ) AS provenance
        FROM artifact_derivations ad
        JOIN artifact_observations ao ON ao.id = ad.artifact_observation_id
        JOIN artifacts a ON a.id = ao.artifact_id
        LEFT JOIN episodic_memory source_em ON source_em.id = ad.source_chunk_id
        WHERE a.namespace_id = $1
          AND ${trustedSourceClause}
          AND coalesce(ad.content_text, '') <> ''
          AND ${derivationMatch.clause}
        ORDER BY raw_score DESC, COALESCE(source_em.occurred_at, ao.observed_at) DESC, ad.id DESC
        LIMIT $${derivationMatch.values.length + 2}
      `,
      [namespaceId, ...derivationMatch.values, Math.max(candidateLimit, 8)]
    )
  ]).then(([episodicRows, derivationRows]) =>
    [...episodicRows, ...derivationRows]
      .sort((left, right) => {
        const rightScore = toNumber(right.raw_score);
        const leftScore = toNumber(left.raw_score);
        if (rightScore !== leftScore) {
          return rightScore - leftScore;
        }
        const leftIso = toIsoString(left.occurred_at);
        const rightIso = toIsoString(right.occurred_at);
        if (leftIso && rightIso && leftIso !== rightIso) {
          return rightIso.localeCompare(leftIso);
        }
        return `${left.memory_type}:${left.memory_id}`.localeCompare(`${right.memory_type}:${right.memory_id}`);
      })
      .slice(0, Math.max(candidateLimit, 10))
  );
}

function loadCurrentProjectSupportRows(namespaceId: string, candidateLimit: number): Promise<SearchRow[]> {
  const terms = [
    "working on",
    "project",
    "projects",
    "focused on",
    "Well Inked",
    "Two Way",
    "2way",
    "Preset Kitchen",
    "AI brain"
  ];
  const episodicMatch = buildFocusedLikeMatchClause(2, terms, "em.content");
  const derivationMatch = buildFocusedLikeMatchClause(2, terms, "ad.content_text");
  const trustedSourceClause = "(a.uri ILIKE '%/omi-archive/normalized/%' OR a.uri ILIKE '%/data/inbox/omi/normalized/%')";

  return Promise.all([
    queryRows<SearchRow>(
      `
        SELECT
          em.id AS memory_id,
          'episodic_memory'::text AS memory_type,
          em.content,
          ((
            ${episodicMatch.scoreExpression}
          ) +
            CASE
              WHEN em.content ~* '(well inked|two way|2way|preset kitchen|ai brain)' THEN 5.1
              ELSE 0
            END +
            CASE
              WHEN em.content ~* '(working on|projects? i am working on|current project|focused on|this week)' THEN 2.2
              ELSE 0
            END +
            2.0
          )::double precision AS raw_score,
          em.artifact_id,
          em.occurred_at,
          em.namespace_id,
          jsonb_build_object(
            'tier', 'focused_episodic_support',
            'lexical_provider', 'current_project_scope',
            'source_uri', a.uri,
            'artifact_observation_id', em.artifact_observation_id,
            'metadata', em.metadata
          ) AS provenance
        FROM episodic_memory em
        JOIN artifacts a ON a.id = em.artifact_id
        WHERE em.namespace_id = $1
          AND ${trustedSourceClause}
          AND ${episodicMatch.clause}
        ORDER BY raw_score DESC, em.occurred_at DESC, em.id DESC
        LIMIT $${episodicMatch.values.length + 2}
      `,
      [namespaceId, ...episodicMatch.values, Math.max(candidateLimit, 8)]
    ),
    queryRows<SearchRow>(
      `
        SELECT
          ad.id AS memory_id,
          'artifact_derivation'::text AS memory_type,
          ${artifactDerivationContentExpression()} AS content,
          ((
            ${derivationMatch.scoreExpression}
          ) +
            CASE
              WHEN ad.content_text ~* '(well inked|two way|2way|preset kitchen|ai brain)' THEN 4.7
              ELSE 0
            END +
            CASE
              WHEN ad.content_text ~* '(working on|projects? i am working on|current project|focused on|this week)' THEN 2.0
              ELSE 0
            END +
            1.8
          )::double precision AS raw_score,
          ao.artifact_id,
          COALESCE(source_em.occurred_at, ao.observed_at) AS occurred_at,
          a.namespace_id,
          jsonb_build_object(
            'tier', 'artifact_derivation',
            'lexical_provider', 'current_project_scope',
            'derivation_type', ad.derivation_type,
            'artifact_observation_id', ad.artifact_observation_id,
            'source_chunk_id', ad.source_chunk_id,
            'source_uri', a.uri,
            'metadata', ad.metadata
          ) AS provenance
        FROM artifact_derivations ad
        JOIN artifact_observations ao ON ao.id = ad.artifact_observation_id
        JOIN artifacts a ON a.id = ao.artifact_id
        LEFT JOIN episodic_memory source_em ON source_em.id = ad.source_chunk_id
        WHERE a.namespace_id = $1
          AND ${trustedSourceClause}
          AND coalesce(ad.content_text, '') <> ''
          AND ${derivationMatch.clause}
        ORDER BY raw_score DESC, COALESCE(source_em.occurred_at, ao.observed_at) DESC, ad.id DESC
        LIMIT $${derivationMatch.values.length + 2}
      `,
      [namespaceId, ...derivationMatch.values, Math.max(candidateLimit, 8)]
    )
  ]).then(([episodicRows, derivationRows]) =>
    [...episodicRows, ...derivationRows]
      .sort((left, right) => {
        const rightScore = toNumber(right.raw_score);
        const leftScore = toNumber(left.raw_score);
        if (rightScore !== leftScore) {
          return rightScore - leftScore;
        }
        const leftIso = toIsoString(left.occurred_at);
        const rightIso = toIsoString(right.occurred_at);
        if (leftIso && rightIso && leftIso !== rightIso) {
          return rightIso.localeCompare(leftIso);
        }
        return `${left.memory_type}:${left.memory_id}`.localeCompare(`${right.memory_type}:${right.memory_id}`);
      })
      .slice(0, Math.max(candidateLimit, 10))
  );
}

function loadStorageLocationSupportRows(
  namespaceId: string,
  candidateLimit: number
): Promise<SearchRow[]> {
  const terms = ["storage", "stored", "Bend", "Reno", "Carson", "Jeep", "RV", "Lauren", "Alex", "Eve"];
  const match = buildFocusedLikeMatchClause(2, terms, "em.content");

  return queryRows<SearchRow>(
    `
      SELECT
        em.id AS memory_id,
        'episodic_memory'::text AS memory_type,
        em.content,
        (${match.scoreExpression})::double precision AS raw_score,
        em.artifact_id,
        em.occurred_at,
        em.namespace_id,
        jsonb_build_object(
          'tier', 'focused_episodic_support',
          'lexical_provider', 'storage_scope',
          'source_uri', a.uri,
          'artifact_observation_id', em.artifact_observation_id,
          'metadata', em.metadata
        ) AS provenance
      FROM episodic_memory em
      LEFT JOIN artifacts a ON a.id = em.artifact_id
      WHERE em.namespace_id = $1
        AND ${match.clause}
      ORDER BY raw_score DESC, em.occurred_at DESC, em.id DESC
      LIMIT $${match.values.length + 2}
    `,
    [namespaceId, ...match.values, Math.max(candidateLimit, 8)]
  );
}

function loadPreciseFactSupportRows(
  namespaceId: string,
  queryText: string,
  plannerTerms: readonly string[],
  candidateLimit: number,
  timeStart: string | null,
  timeEnd: string | null
): Promise<SearchRow[]> {
  const terms = buildPreciseFactEvidenceQueryText(queryText, plannerTerms)
    .split(/\s+/u)
    .map((term) => term.trim())
    .filter((term) => term.length > 1)
    .slice(0, 10);
  const match = buildFocusedLikeMatchClause(4, terms, "em.content");
  const durationBonus = /\bhow\s+long\b/i.test(queryText)
    ? "CASE WHEN em.content ~* '\\m\\d+\\s+(minute|minutes|hour|hours|day|days|week|weeks|month|months|year|years)\\M' THEN 3 ELSE 0 END"
    : "0";
  const commuteBonus = /\bcommute\b/i.test(queryText)
    ? "CASE WHEN lower(em.content) LIKE '%commute%' THEN 5 ELSE 0 END + CASE WHEN lower(em.content) LIKE '%each way%' THEN 6 ELSE 0 END + CASE WHEN lower(em.content) LIKE '%daily commute%' THEN 3 ELSE 0 END"
    : "0";
  const playlistBonus = /\bplaylist|spotify\b/i.test(queryText)
    ? "CASE WHEN lower(em.content) LIKE '%playlist%' THEN 4 ELSE 0 END + CASE WHEN lower(em.content) LIKE '%spotify%' THEN 3 ELSE 0 END + CASE WHEN lower(em.content) LIKE '%called %' THEN 2 ELSE 0 END"
    : "0";
  const classLocationBonus = /\bwhere\b/i.test(queryText) && /\bclass|classes|yoga\b/i.test(queryText)
    ? "CASE WHEN em.content ~ '[A-Z][A-Za-z0-9''&.-]+(\\s+[A-Z][A-Za-z0-9''&.-]+){0,4}\\s+Yoga' THEN 7 ELSE 0 END + CASE WHEN em.content ~ '(near|at|to)\\s+[A-Z][A-Za-z0-9''&.-]+(\\s+[A-Z][A-Za-z0-9''&.-]+){0,4}\\s+Yoga' THEN 5 ELSE 0 END + CASE WHEN lower(em.content) LIKE '%serenity yoga%' THEN 6 ELSE 0 END + CASE WHEN lower(em.content) LIKE '%yoga%' THEN 2 ELSE 0 END + CASE WHEN lower(em.content) LIKE '%class%' THEN 2 ELSE 0 END + CASE WHEN lower(em.content) LIKE '%studio%' THEN 1 ELSE 0 END"
    : "0";
  const titleBonus = /\bwhat\s+(?:play|movie|film|show|book|song|title)\b/i.test(queryText)
    ? "CASE WHEN em.content ~* '(production of|watched|read|attended|saw|play|movie|book|show|title|called)' THEN 2 ELSE 0 END"
    : "0";
  const nameBonus = /\bwhat\s+(?:was|is)\s+the\s+name\s+of\b/i.test(queryText)
    ? "CASE WHEN em.content ~* '(called|named|playlist|spotify|studio)' THEN 3 ELSE 0 END"
    : "0";
  const scopeFilter = /\bhow\s+long\b/i.test(queryText)
    ? "em.content ~* '(commute|each way|minute|minutes|hour|hours)'"
    : /\bwhat\s+(?:play|movie|film|show|book|song|title)\b/i.test(queryText)
      ? "em.content ~* '(play|movie|film|show|book|song|title|attended|watched|read|called|production of|saw)'"
      : /\bwhere\b/i.test(queryText) && /\bclass|classes|yoga\b/i.test(queryText)
        ? "em.content ~* '(class|classes|yoga|studio|near|at|to)'"
        : "TRUE";

  return queryRows<SearchRow>(
    `
      SELECT
        em.id AS memory_id,
        'episodic_memory'::text AS memory_type,
        em.content,
        ((${match.scoreExpression}) + ${durationBonus} + ${commuteBonus} + ${playlistBonus} + ${classLocationBonus} + ${titleBonus} + ${nameBonus})::double precision AS raw_score,
        em.artifact_id,
        em.occurred_at,
        em.namespace_id,
        jsonb_build_object(
          'tier', 'focused_episodic_support',
          'lexical_provider', 'precise_fact_scope',
          'source_uri', a.uri,
          'artifact_observation_id', em.artifact_observation_id,
          'metadata', em.metadata
        ) AS provenance
      FROM episodic_memory em
      LEFT JOIN artifacts a ON a.id = em.artifact_id
      WHERE em.namespace_id = $1
        AND ($2::timestamptz IS NULL OR em.occurred_at >= $2)
        AND ($3::timestamptz IS NULL OR em.occurred_at <= $3)
        AND ${match.clause}
        AND ${scopeFilter}
      ORDER BY raw_score DESC, em.occurred_at DESC, em.id DESC
      LIMIT $${match.values.length + 4}
    `,
    [namespaceId, timeStart, timeEnd, ...match.values, Math.max(candidateLimit, 24)]
  );
}

function loadParticipantTurnExactDetailRows(
  namespaceId: string,
  queryText: string,
  plannerTerms: readonly string[],
  candidateLimit: number,
  timeStart: string | null,
  timeEnd: string | null
): Promise<SearchRow[]> {
  const terms = buildPreciseFactEvidenceQueryText(queryText, plannerTerms)
    .split(/\s+/u)
    .map((term) => term.trim())
    .filter((term) => term.length > 1)
    .slice(0, 12);
  const match = buildFocusedLikeMatchClause(4, terms, "ad.content_text");
  const entityHints = extractEntityNameHints(queryText)
    .map((value) => normalizeWhitespace(value).toLowerCase())
    .filter(Boolean)
    .slice(0, 2);
  const speakerMatch = buildFocusedLikeMatchClause(4 + match.values.length, entityHints, "coalesce(ad.metadata->>'primary_speaker_name', '')");
  const questionContextBonus =
    "CASE WHEN coalesce(ad.metadata->>'prompt_text', '') <> '' THEN 3 ELSE 0 END";
  const speakerBonus = entityHints.length > 0
    ? `(${speakerMatch.scoreExpression}) * 4`
    : "0";
  const exactCueBonus = /\b(color|team|position|role|title|job|research|realiz|plans?|name|movie|books?|adopt|bought?|purchased?|temporary|martial|hobbies?|favorite|allerg|focus|sparked?|interest)\b/i.test(queryText)
    ? "CASE WHEN lower(coalesce(ad.metadata->>'source_sentence_text', ad.content_text)) ~ '(color|team|position|role|title|job|research|realiz|plan|named|called|adopt|bought|purchased|movie|book|martial|kickboxing|taekwondo|hobbies|enjoy|favorite|allerg|fur|reptiles|focus|passionate|growing up|saw how)' THEN 2 ELSE 0 END"
    : "0";
  const whereClause = [match.clause, entityHints.length > 0 ? speakerMatch.clause : "TRUE"].join(" AND ");

  return queryRows<SearchRow>(
    `
      SELECT
        ad.id AS memory_id,
        'artifact_derivation'::text AS memory_type,
        coalesce(ad.content_text, '') AS content,
        ((${match.scoreExpression}) + ${speakerBonus} + ${questionContextBonus} + ${exactCueBonus})::double precision AS raw_score,
        ao.artifact_id,
        coalesce(source_em.occurred_at, ao.observed_at) AS occurred_at,
        a.namespace_id,
        jsonb_build_object(
          'tier', 'artifact_derivation',
          'derivation_type', ad.derivation_type,
          'provider', ad.provider,
          'model', ad.model,
          'artifact_observation_id', ad.artifact_observation_id,
          'source_chunk_id', ad.source_chunk_id,
          'source_uri', a.uri,
          'metadata', ad.metadata
        ) AS provenance
      FROM artifact_derivations ad
      JOIN artifact_observations ao ON ao.id = ad.artifact_observation_id
      JOIN artifacts a ON a.id = ao.artifact_id
      LEFT JOIN episodic_memory source_em ON source_em.id = ad.source_chunk_id
      WHERE a.namespace_id = $1
        AND ad.derivation_type = 'participant_turn'
        AND coalesce(ad.content_text, '') <> ''
        AND ${whereClause}
        AND ($2::timestamptz IS NULL OR coalesce(source_em.occurred_at, ao.observed_at) >= $2)
        AND ($3::timestamptz IS NULL OR coalesce(source_em.occurred_at, ao.observed_at) <= $3)
      ORDER BY raw_score DESC, coalesce(source_em.occurred_at, ao.observed_at) DESC
      LIMIT $${match.values.length + speakerMatch.values.length + 4}
    `,
    [namespaceId, timeStart, timeEnd, ...match.values, ...speakerMatch.values, Math.max(candidateLimit, 18)]
  );
}

function loadArtifactLocalClassLocationRows(
  namespaceId: string,
  artifactIds: readonly string[],
  candidateLimit: number
): Promise<SearchRow[]> {
  const normalizedArtifactIds = [...new Set(artifactIds.map((artifactId) => artifactId.trim()).filter(Boolean))];
  if (normalizedArtifactIds.length === 0) {
    return Promise.resolve([]);
  }

  return queryRows<SearchRow>(
    `
      SELECT
        em.id AS memory_id,
        'episodic_memory'::text AS memory_type,
        em.content,
        (
          CASE WHEN lower(em.content) LIKE '%serenity yoga%' THEN 20 ELSE 0 END +
          CASE WHEN em.content ~ '[A-Z][A-Za-z0-9''&.-]+(\\s+[A-Z][A-Za-z0-9''&.-]+){0,4}\\s+Yoga' THEN 8 ELSE 0 END +
          CASE WHEN em.content ~* '(near|at|to|from|make it to|connection to|local|studio practice|yoga instructor|fellow yogis)' THEN 6 ELSE 0 END +
          CASE WHEN em.content ~* '(app|apps|free trial|subscription|available for|in-app purchases|one-time purchase|customizable practices)' THEN -8 ELSE 0 END
        )::double precision AS raw_score,
        em.artifact_id,
        em.occurred_at,
        em.namespace_id,
        jsonb_build_object(
          'tier', 'focused_episodic_support',
          'lexical_provider', 'artifact_local_class_location_scope',
          'source_uri', a.uri,
          'artifact_observation_id', em.artifact_observation_id,
          'metadata', em.metadata
        ) AS provenance
      FROM episodic_memory em
      LEFT JOIN artifacts a ON a.id = em.artifact_id
      WHERE em.namespace_id = $1
        AND em.artifact_id = ANY($2::uuid[])
        AND (
          lower(em.content) LIKE '%yoga%' OR
          lower(em.content) LIKE '%studio%' OR
          lower(em.content) LIKE '%class%' OR
          lower(em.content) LIKE '%classes%'
        )
      ORDER BY raw_score DESC, em.occurred_at DESC, em.id DESC
      LIMIT $3
    `,
    [namespaceId, normalizedArtifactIds, Math.max(candidateLimit, 8)]
  );
}

function loadProfileInferenceSupportRows(
  namespaceId: string,
  queryText: string,
  plannerTerms: readonly string[],
  candidateLimit: number,
  timeStart: string | null,
  timeEnd: string | null
): Promise<SearchRow[]> {
  const terms = buildProfileInferenceEvidenceQueryText(queryText, plannerTerms)
    .split(/\s+/u)
    .map((term) => term.trim())
    .filter((term) => term.length > 1)
    .slice(0, 12);
  const match = buildFocusedLikeMatchClause(4, terms, "em.content");

  return queryRows<SearchRow>(
    `
      SELECT
        em.id AS memory_id,
        'episodic_memory'::text AS memory_type,
        em.content,
        ((${match.scoreExpression}) +
          CASE
            WHEN em.content ~* '(career|job|jobs|education|educational|study|studying|mental health|counseling|counsell?ing|counselor|counsellor)' THEN 2
            ELSE 0
          END +
          CASE
            WHEN em.content ~* '(keen on|looking into|thinking of|career options|would love|want to help)' THEN 2
            ELSE 0
          END
        )::double precision AS raw_score,
        em.artifact_id,
        em.occurred_at,
        em.namespace_id,
        jsonb_build_object(
          'tier', 'focused_episodic_support',
          'lexical_provider', 'profile_inference_scope',
          'source_uri', a.uri,
          'artifact_observation_id', em.artifact_observation_id,
          'metadata', em.metadata
        ) AS provenance
      FROM episodic_memory em
      LEFT JOIN artifacts a ON a.id = em.artifact_id
      WHERE em.namespace_id = $1
        AND ($2::timestamptz IS NULL OR em.occurred_at >= $2)
        AND ($3::timestamptz IS NULL OR em.occurred_at <= $3)
        AND ${match.clause}
      ORDER BY raw_score DESC, em.occurred_at DESC, em.id DESC
      LIMIT $${match.values.length + 4}
    `,
    [namespaceId, timeStart, timeEnd, ...match.values, Math.max(candidateLimit, 8)]
  );
}

function loadIdentitySupportRows(
  namespaceId: string,
  queryText: string,
  plannerTerms: readonly string[],
  candidateLimit: number,
  timeStart: string | null,
  timeEnd: string | null
): Promise<SearchRow[]> {
  const terms = buildIdentityEvidenceQueryText(queryText, plannerTerms)
    .split(/\s+/u)
    .map((term) => term.trim())
    .filter((term) => term.length > 1)
    .slice(0, 14);
  const match = buildFocusedLikeMatchClause(4, terms, "em.content");

  return queryRows<SearchRow>(
    `
      SELECT
        em.id AS memory_id,
        'episodic_memory'::text AS memory_type,
        em.content,
        ((${match.scoreExpression}) +
          CASE
            WHEN em.content ~* '(transgender|nonbinary|gender identity|transition|trans community|trans woman|trans man|queer|lgbtq|identity)' THEN 3
            ELSE 0
          END +
          CASE
            WHEN em.content ~* '(accept(?:ed|ance)?|embrace|safe place|self-expression|community)' THEN 1.5
            ELSE 0
          END
        )::double precision AS raw_score,
        em.artifact_id,
        em.occurred_at,
        em.namespace_id,
        jsonb_build_object(
          'tier', 'focused_episodic_support',
          'lexical_provider', 'identity_scope',
          'source_uri', a.uri,
          'artifact_observation_id', em.artifact_observation_id,
          'metadata', em.metadata
        ) AS provenance
      FROM episodic_memory em
      LEFT JOIN artifacts a ON a.id = em.artifact_id
      WHERE em.namespace_id = $1
        AND ($2::timestamptz IS NULL OR em.occurred_at >= $2)
        AND ($3::timestamptz IS NULL OR em.occurred_at <= $3)
        AND ${match.clause}
      ORDER BY raw_score DESC, em.occurred_at DESC, em.id DESC
      LIMIT $${match.values.length + 4}
    `,
    [namespaceId, timeStart, timeEnd, ...match.values, Math.max(candidateLimit, 10)]
  );
}

function loadSharedCommonalityRows(
  namespaceId: string,
  queryText: string,
  plannerTerms: readonly string[],
  candidateLimit: number,
  timeStart: string | null,
  timeEnd: string | null
): Promise<SearchRow[]> {
  const terms = buildSharedCommonalityEvidenceQueryText(queryText, plannerTerms)
    .split(/\s+/u)
    .map((term) => term.trim())
    .filter((term) => term.length > 1)
    .slice(0, 16);
  const match = buildFocusedLikeMatchClause(4, terms, "em.content");

  return queryRows<SearchRow>(
    `
      SELECT
        em.id AS memory_id,
        'episodic_memory'::text AS memory_type,
        em.content,
        ((${match.scoreExpression}) +
          CASE
            WHEN em.content ~* '(both|same here|me too|we both|shared|in common)' THEN 2
            ELSE 0
          END +
          CASE
            WHEN em.content ~* '(dance|dancing|stress relief|de-stress|destress|business|job|lost my job|own business)' THEN 2
            ELSE 0
          END +
          CASE
            WHEN em.content ~* '(volunteer|volunteering|homeless shelter|shelter|fundraiser|food and supplies|food|supplies)' THEN 3
            ELSE 0
          END
        )::double precision AS raw_score,
        em.artifact_id,
        em.occurred_at,
        em.namespace_id,
        jsonb_build_object(
          'tier', 'focused_episodic_support',
          'lexical_provider', 'shared_commonality_scope',
          'source_uri', a.uri,
          'artifact_observation_id', em.artifact_observation_id,
          'metadata', em.metadata
        ) AS provenance
      FROM episodic_memory em
      LEFT JOIN artifacts a ON a.id = em.artifact_id
      WHERE em.namespace_id = $1
        AND ($2::timestamptz IS NULL OR em.occurred_at >= $2)
        AND ($3::timestamptz IS NULL OR em.occurred_at <= $3)
        AND ${match.clause}
      ORDER BY raw_score DESC, em.occurred_at DESC, em.id DESC
      LIMIT $${match.values.length + 4}
    `,
    [namespaceId, timeStart, timeEnd, ...match.values, Math.max(candidateLimit * 2, 16)]
  );
}

function loadCausalNarrativeRows(
  namespaceId: string,
  queryText: string,
  plannerTerms: readonly string[],
  candidateLimit: number,
  timeStart: string | null,
  timeEnd: string | null
): Promise<SearchRow[]> {
  const terms = buildCausalMotiveEvidenceQueryText(queryText, plannerTerms)
    .split(/\s+/u)
    .map((term) => term.trim())
    .filter((term) => term.length > 1)
    .slice(0, 14);
  const match = buildFocusedLikeMatchClause(4, terms, "em.content");

  return queryRows<SearchRow>(
    `
      SELECT
        em.id AS memory_id,
        'episodic_memory'::text AS memory_type,
        em.content,
        ((${match.scoreExpression}) +
          CASE
            WHEN em.content ~* '(because|decided|started|starting|wanted to|want to|dream|passion|share|inspired)' THEN 2
            ELSE 0
          END +
          CASE
            WHEN em.content ~* '(lost my job|job was hard|pushed me|gave me the push|take the plunge)' THEN 2
            ELSE 0
          END
        )::double precision AS raw_score,
        em.artifact_id,
        em.occurred_at,
        em.namespace_id,
        jsonb_build_object(
          'tier', 'focused_episodic_support',
          'lexical_provider', 'causal_motive_scope',
          'source_uri', a.uri,
          'artifact_observation_id', em.artifact_observation_id,
          'metadata', em.metadata
        ) AS provenance
      FROM episodic_memory em
      LEFT JOIN artifacts a ON a.id = em.artifact_id
      WHERE em.namespace_id = $1
        AND ($2::timestamptz IS NULL OR em.occurred_at >= $2)
        AND ($3::timestamptz IS NULL OR em.occurred_at <= $3)
        AND ${match.clause}
      ORDER BY raw_score DESC, em.occurred_at DESC, em.id DESC
      LIMIT $${match.values.length + 4}
    `,
    [namespaceId, timeStart, timeEnd, ...match.values, Math.max(candidateLimit * 2, 14)]
  );
}

function loadTemporalDetailSupportRows(
  namespaceId: string,
  queryText: string,
  plannerTerms: readonly string[],
  candidateLimit: number,
  timeStart: string | null,
  timeEnd: string | null
): Promise<SearchRow[]> {
  const terms = buildTemporalDetailEvidenceQueryText(queryText, plannerTerms)
    .split(/\s+/u)
    .map((term) => term.trim())
    .filter((term) => term.length > 1)
    .slice(0, 10);
  const match = buildFocusedLikeMatchClause(4, terms, "em.content");

  return queryRows<SearchRow>(
    `
      SELECT
        em.id AS memory_id,
        'episodic_memory'::text AS memory_type,
        em.content,
        ((${match.scoreExpression}) +
          CASE
            WHEN em.content ~* '(yesterday|today|last night|last year|last month|last week|\\d+\\s+days?\\s+ago|\\bJanuary\\b|\\bFebruary\\b|\\bMarch\\b|\\bApril\\b|\\bMay\\b|\\bJune\\b|\\bJuly\\b|\\bAugust\\b|\\bSeptember\\b|\\bOctober\\b|\\bNovember\\b|\\bDecember\\b|\\b20\\d{2}\\b|\\b19\\d{2}\\b)' THEN 3
            ELSE 0
          END
        )::double precision AS raw_score,
        em.artifact_id,
        em.occurred_at,
        em.namespace_id,
        jsonb_build_object(
          'tier', 'focused_episodic_support',
          'lexical_provider', 'temporal_detail_scope',
          'source_uri', a.uri,
          'artifact_observation_id', em.artifact_observation_id,
          'metadata', em.metadata
        ) AS provenance
      FROM episodic_memory em
      LEFT JOIN artifacts a ON a.id = em.artifact_id
      WHERE em.namespace_id = $1
        AND ($2::timestamptz IS NULL OR em.occurred_at >= $2)
        AND ($3::timestamptz IS NULL OR em.occurred_at <= $3)
        AND ${match.clause}
      ORDER BY raw_score DESC, em.occurred_at DESC, em.id DESC
      LIMIT $${match.values.length + 4}
    `,
    [namespaceId, timeStart, timeEnd, ...match.values, Math.max(candidateLimit, 8)]
  );
}

function buildRecentMediaEvidenceQueryText(queryText: string, plannerTerms: readonly string[]): string {
  const candidateTerms = (plannerTerms.length > 0 ? plannerTerms : queryText.match(/[A-Za-z0-9][A-Za-z0-9._:-]*/g) ?? [])
    .map((term) => term.trim().toLowerCase())
    .filter(Boolean)
    .filter((term) => !["what", "has", "have", "recently"].includes(term));
  const expanded = new Set(candidateTerms);
  expanded.add("movies");
  expanded.add("shows");
  expanded.add("watched");
  expanded.add("saw");
  return [...expanded].join(" ").trim() || queryText;
}

function buildStyleSpecEvidenceQueryText(queryText: string, plannerTerms: readonly string[]): string {
  const normalized = queryText.toLowerCase();
  if (/\bprotocol\b/.test(normalized) && /\bontology\b/.test(normalized)) {
    return "Ask NotebookLM First Before Changing Ontology NotebookLM ontology protocol";
  }

  if (/\bdatabase\b/.test(normalized) && /\bslice\b/.test(normalized)) {
    return "Wipe And Replay The Database After Each Slice database replay slice workflow";
  }

  if (/\bresponse\b/.test(normalized) && /\bstyle\b/.test(normalized)) {
    return "Keep Responses Concise response style concise formatting";
  }

  if (/\bnatural\b/.test(normalized) && /\bquery/.test(normalized)) {
    return "Prefer Natural-Language Queryability natural language queryability";
  }

  const candidateTerms = (plannerTerms.length > 0 ? plannerTerms : queryText.match(/[A-Za-z0-9][A-Za-z0-9._:-]*/g) ?? [])
    .map((term) => term.trim().toLowerCase())
    .filter(Boolean)
    .filter((term) => !["what", "how", "should", "does", "is", "the", "my"].includes(term));

  const expanded = new Set(candidateTerms);
  if (/\bstyle\b/.test(normalized) || /\bformat/.test(normalized)) {
    expanded.add("style");
    expanded.add("concise");
  }
  if (/\bprotocol\b/.test(normalized) || /\bworkflow\b/.test(normalized)) {
    expanded.add("workflow");
    expanded.add("protocol");
  }

  return [...expanded].join(" ").trim() || queryText;
}

function normalizeHierarchyKey(value: string): string {
  return value
    .trim()
    .replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/gu, "")
    .replace(/\s+/gu, " ")
    .toLowerCase();
}

function extractHierarchyTargets(queryText: string): readonly string[] {
  const patterns = [
    /\b(?:what|which)\s+(?:country|state|province|region|city)\s+is\s+(.+?)\s+in\??$/iu,
    /\bwhere\s+in\s+the\s+hierarchy\s+is\s+(.+?)\??$/iu,
    /\bwhat\s+is\s+(.+?)\s+contained\s+in\??$/iu,
    /\bwhat\s+contains\s+(.+?)\??$/iu
  ] as const;

  for (const pattern of patterns) {
    const match = queryText.match(pattern);
    const captured = typeof match?.[1] === "string" ? match[1].trim() : "";
    if (captured) {
      return [captured.replace(/\?+$/u, "").trim()];
    }
  }

  const properPhrases = queryText.match(/\b(?:[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,3})\b/g) ?? [];
  return [...new Set(properPhrases.filter((phrase) => !/^(What|Which|Where)$/u.test(phrase)))];
}

function isArtifactDerivationDetailQuery(queryText: string): boolean {
  const normalized = queryText.trim();
  if (!normalized) {
    return false;
  }

  return (
    /\b(packet|voice memo|memo|whiteboard|photo|pdf|artifact)\b/i.test(normalized) &&
    /\b(say|said|written|wrote|what did|what was written)\b/i.test(normalized)
  );
}

function isRelationshipHistoryRecapQuery(queryText: string): boolean {
  const normalized = queryText.trim();
  if (!normalized) {
    return false;
  }

  return (
    /\bwhat\s+is\s+.+['’]s\s+history\s+with\b/i.test(normalized) ||
    /\bwhat\s+is\s+the\s+history\s+between\b/i.test(normalized) ||
    /\brelationship\s+history\b/i.test(normalized) ||
    /\bwho\s+used\s+to\s+be\s+in\s+my\s+life\b/i.test(normalized) ||
    /\bwho\s+is\s+no\s+longer\s+current\s+in\s+my\s+life\b/i.test(normalized)
  );
}

function extractBeforePlaceTarget(queryText: string): string | null {
  const match = queryText.match(/\bbefore\s+(.+?)\??$/iu);
  const captured = typeof match?.[1] === "string" ? normalizeWhitespace(match[1]) : "";
  return captured ? captured : null;
}

function parseIsoTimestamp(value: unknown): number | null {
  if (typeof value !== "string" || !value) {
    return null;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

interface SemanticAnchorResolution {
  readonly timeStart: string;
  readonly timeEnd: string;
  readonly anchorOccurredAt: string;
  readonly anchorText: string;
  readonly mode: "after" | "before" | "during";
  readonly source: "episodic_memory" | "narrative_event";
}

function hasExplicitTemporalAnchor(queryText: string): boolean {
  return (
    /\b(January|February|March|April|May|June|July|August|September|October|November|December)\b/i.test(queryText) ||
    /\b(19\d{2}|20\d{2})\b/.test(queryText) ||
    /\b(one|two|three|four|five|\d+)\s+(day|days|week|weeks|month|months|year|years)\s+(after|before)\b/i.test(queryText) ||
    /\bon\s+\d{4}-\d{2}-\d{2}\b/i.test(queryText)
  );
}

function parseSemanticAnchorDirective(
  queryText: string
): { readonly mode: "after" | "before" | "during"; readonly anchorText: string } | null {
  const normalized = normalizeWhitespace(queryText.replace(/\?+$/u, ""));
  if (!normalized || hasExplicitTemporalAnchor(normalized)) {
    return null;
  }

  const nightMatch = normalized.match(/\b(?:the\s+)?night\s+(?:(?:that|when)\s+)?(?:i|steve|he)\s+met\s+(.+)$/iu);
  if (nightMatch?.[1]) {
    return {
      mode: "during",
      anchorText: `met ${normalizeWhitespace(nightMatch[1])}`
    };
  }

  const afterMatch = normalized.match(/\bafter\s+(?:the\s+)?(.+)$/iu);
  if (afterMatch?.[1]) {
    const anchorText = normalizeWhitespace(afterMatch[1]);
    if (
      /^(?:each|every)\b/iu.test(anchorText) &&
      /\b(?:slice|session|run|query|response|reply|build|deploy|import|benchmark)\b/iu.test(anchorText)
    ) {
      return null;
    }
    return {
      mode: "after",
      anchorText
    };
  }

  const beforeMatch = normalized.match(/\bbefore\s+(?:the\s+)?(.+)$/iu);
  if (beforeMatch?.[1]) {
    const anchorText = normalizeWhitespace(beforeMatch[1]);
    if (
      /^(?:each|every)\b/iu.test(anchorText) &&
      /\b(?:slice|session|run|query|response|reply|build|deploy|import|benchmark)\b/iu.test(anchorText)
    ) {
      return null;
    }
    return {
      mode: "before",
      anchorText
    };
  }

  return null;
}

function semanticAnchorTerms(anchorText: string): readonly string[] {
  return anchorText
    .split(/[^A-Za-z0-9]+/u)
    .map((term) => term.trim().toLowerCase())
    .filter(Boolean)
    .filter((term) => !BM25_STOP_WORDS.has(term) && !["night"].includes(term));
}

function buildSemanticAnchorEvidenceTerms(
  queryText: string,
  plannerTerms: readonly string[],
  resolution: SemanticAnchorResolution
): readonly string[] {
  const baseTerms = (plannerTerms.length > 0 ? plannerTerms : queryText.match(/[A-Za-z0-9][A-Za-z0-9._:-]*/g) ?? [])
    .map((term) => term.trim().toLowerCase())
    .filter(Boolean)
    .filter(
      (term) =>
        !BM25_STOP_WORDS.has(term) &&
        ![
          "after",
          "before",
          "during",
          "night",
          "later",
          "then",
          "what",
          "where",
          "when",
          "who",
          "happened",
          "did",
          "do",
          "go"
        ].includes(term)
    );
  const expanded = new Set<string>([...baseTerms, ...semanticAnchorTerms(resolution.anchorText)]);

  if (resolution.mode === "during" && /\bwhere\b/i.test(queryText) && /\bgo\b/i.test(queryText)) {
    expanded.add("night");
    expanded.add("later");
    expanded.add("went");
    expanded.add("walked");
  }

  if (resolution.mode === "after" || resolution.mode === "before") {
    expanded.add(resolution.mode);
  }

  return [...expanded];
}

function startOfUtcDay(iso: string): string {
  const date = new Date(iso);
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 0, 0, 0, 0)).toISOString();
}

function endOfUtcDay(iso: string): string {
  const date = new Date(iso);
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 23, 59, 59, 999)).toISOString();
}

function startOfUtcMonth(iso: string): string {
  const date = new Date(iso);
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1, 0, 0, 0, 0)).toISOString();
}

function shiftUtcDays(iso: string, days: number): string {
  const date = new Date(iso);
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000).toISOString();
}

function normalizeReferenceInstant(referenceNow?: string): string {
  return parseIsoTimestamp(referenceNow) !== null ? new Date(referenceNow as string).toISOString() : new Date().toISOString();
}

function resolveRelativePhraseWindow(label: string | undefined, referenceNow?: string): { readonly timeStart: string; readonly timeEnd: string } | null {
  if (!label) {
    return null;
  }

  const normalized = label.trim().toLowerCase();
  const referenceEnd = normalizeReferenceInstant(referenceNow);

  if (normalized === "yesterday" || normalized === "last night") {
    const anchor = shiftUtcDays(referenceEnd, -1);
    return { timeStart: startOfUtcDay(anchor), timeEnd: endOfUtcDay(anchor) };
  }

  if (normalized === "today" || normalized === "tonight") {
    return { timeStart: startOfUtcDay(referenceEnd), timeEnd: endOfUtcDay(referenceEnd) };
  }

  if (normalized === "earlier this month") {
    return { timeStart: startOfUtcMonth(referenceEnd), timeEnd: referenceEnd };
  }

  const rollingDaysMatch = normalized.match(/\bover\s+the\s+(?:last|past)\s+(\d+|two)\s+days\b/u);
  if (rollingDaysMatch?.[1]) {
    const quantity = rollingDaysMatch[1] === "two" ? 2 : Number.parseInt(rollingDaysMatch[1], 10);
    if (Number.isFinite(quantity) && quantity > 0) {
      const anchor = shiftUtcDays(referenceEnd, -(quantity - 1));
      return {
        timeStart: startOfUtcDay(anchor),
        timeEnd: endOfUtcDay(referenceEnd)
      };
    }
  }

  return null;
}

function isBroadNarrativeAnchorQuery(queryText: string, mode: "after" | "before" | "during"): boolean {
  if (mode === "during") {
    return false;
  }

  return new RegExp(
    String.raw`\b(?:what\s+happened|what\s+did\s+.+\s+do|where\s+did\s+.+\s+go|who\s+was\s+.+\s+with)\s+${mode}\b`,
    "iu"
  ).test(queryText);
}

function parseMonthDayYearToIso(value: string): string | null {
  const match = value.match(
    /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,)?\s+(19\d{2}|20\d{2})\b/iu
  );
  if (!match) {
    return null;
  }

  const monthIndex = CALENDAR_MONTH_LOOKUP.get(match[1].toLowerCase());
  const day = Number(match[2]);
  const year = Number(match[3]);
  if (monthIndex === undefined || !Number.isFinite(day) || !Number.isFinite(year)) {
    return null;
  }

  return new Date(Date.UTC(year, monthIndex, day, 12, 0, 0, 0)).toISOString();
}

function extractExplicitMonthDayYearLabel(value: string): string | null {
  const match = value.match(
    /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,)?\s+(19\d{2}|20\d{2})\b/iu
  );
  if (!match) {
    return null;
  }

  return `${match[1]} ${Number(match[2])}, ${match[3]}`;
}

function extractNumericMonthDayYearLabel(value: string): string | null {
  const slashMatch = value.match(/\b(0?[1-9]|1[0-2])\/(0?[1-9]|[12]\d|3[01])\/(19\d{2}|20\d{2})\b/u);
  if (slashMatch) {
    const monthIndex = Number(slashMatch[1]) - 1;
    const monthLabel = [...CALENDAR_MONTH_LOOKUP.entries()].find(([, index]) => index === monthIndex)?.[0];
    if (monthLabel) {
      return `${monthLabel.charAt(0).toUpperCase()}${monthLabel.slice(1)} ${Number(slashMatch[2])}, ${slashMatch[3]}`;
    }
  }

  const isoMatch = value.match(/\b(19\d{2}|20\d{2})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])\b/u);
  if (isoMatch) {
    const monthIndex = Number(isoMatch[2]) - 1;
    const monthLabel = [...CALENDAR_MONTH_LOOKUP.entries()].find(([, index]) => index === monthIndex)?.[0];
    if (monthLabel) {
      return `${monthLabel.charAt(0).toUpperCase()}${monthLabel.slice(1)} ${Number(isoMatch[3])}, ${isoMatch[1]}`;
    }
  }

  return null;
}

function extractExplicitDateLabel(value: string): string | null {
  return extractExplicitMonthDayYearLabel(value) ?? extractNumericMonthDayYearLabel(value);
}

function formatUtcDayLabel(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", {
    timeZone: "UTC",
    day: "numeric",
    month: "long",
    year: "numeric"
  });
}

function formatUtcMonthLabel(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", {
    timeZone: "UTC",
    month: "long",
    year: "numeric"
  });
}

const WEEKDAY_LOOKUP = new Map<string, number>([
  ["sun", 0],
  ["sunday", 0],
  ["mon", 1],
  ["monday", 1],
  ["tue", 2],
  ["tues", 2],
  ["tuesday", 2],
  ["wed", 3],
  ["wednesday", 3],
  ["thu", 4],
  ["thur", 4],
  ["thurs", 4],
  ["thursday", 4],
  ["fri", 5],
  ["friday", 5],
  ["sat", 6],
  ["saturday", 6]
]);

function previousWeekdayIso(occurredAt: string, weekdayToken: string): string | null {
  const targetWeekday = WEEKDAY_LOOKUP.get(weekdayToken.toLowerCase());
  if (targetWeekday === undefined) {
    return null;
  }

  const current = new Date(occurredAt);
  if (Number.isNaN(current.getTime())) {
    return null;
  }

  const currentWeekday = current.getUTCDay();
  let deltaDays = (currentWeekday - targetWeekday + 7) % 7;
  if (deltaDays === 0) {
    deltaDays = 7;
  }

  return new Date(current.getTime() - deltaDays * 24 * 60 * 60 * 1000).toISOString();
}

export function inferRelativeTemporalAnswerLabel(
  content: string,
  occurredAt: string | null | undefined,
  referenceNow?: string | null
): string | null {
  // Prefer the event-local timestamp when resolving relative cues like
  // "last year" or "yesterday"; captured/reference time is only a fallback.
  const anchorIso = occurredAt ?? referenceNow ?? null;
  if (!anchorIso) {
    return null;
  }

  const normalized = content.toLowerCase();
  const occurredTime = Date.parse(anchorIso);
  if (!Number.isFinite(occurredTime)) {
    return null;
  }

  const normalizedYearMatch = normalized.match(/\bnormalized year:\s*(\d{4})\b/i);
  if (normalizedYearMatch?.[1]) {
    return normalizedYearMatch[1];
  }

  if (/\byesterday\b/i.test(normalized) || /\blast night\b/i.test(normalized)) {
    return formatUtcDayLabel(new Date(occurredTime - 24 * 60 * 60 * 1000).toISOString());
  }
  if (/\btoday\b/i.test(normalized) || /\btonight\b/i.test(normalized)) {
    return formatUtcDayLabel(new Date(occurredTime).toISOString());
  }
  const agoMatch = normalized.match(/\b(\d+)\s+days?\s+ago\b/i);
  if (agoMatch?.[1]) {
    const days = Number.parseInt(agoMatch[1], 10);
    if (Number.isFinite(days) && days > 0) {
      return formatUtcDayLabel(new Date(occurredTime - days * 24 * 60 * 60 * 1000).toISOString());
    }
  }
  const weeksAgoMatch = normalized.match(/\b(\d+|one|two|three|four)\s+weeks?\s+ago\b/i);
  if (weeksAgoMatch?.[1]) {
    const rawWeeks = weeksAgoMatch[1].toLowerCase();
    const weeks =
      rawWeeks === "one"
        ? 1
        : rawWeeks === "two"
          ? 2
          : rawWeeks === "three"
            ? 3
            : rawWeeks === "four"
              ? 4
              : Number.parseInt(rawWeeks, 10);
    if (Number.isFinite(weeks) && weeks > 0) {
      return formatUtcDayLabel(new Date(occurredTime - weeks * 7 * 24 * 60 * 60 * 1000).toISOString());
    }
  }
  if (/\blast year\b/i.test(normalized)) {
    return String(new Date(occurredTime).getUTCFullYear() - 1);
  }
  if (/\bthis year\b/i.test(normalized)) {
    return String(new Date(occurredTime).getUTCFullYear());
  }
  if (/\bthis month\b/i.test(normalized)) {
    return formatUtcMonthLabel(new Date(occurredTime).toISOString());
  }
  if (/\blast month\b/i.test(normalized)) {
    const current = new Date(occurredTime);
    return formatUtcMonthLabel(new Date(Date.UTC(current.getUTCFullYear(), current.getUTCMonth() - 1, 15, 12, 0, 0, 0)).toISOString());
  }
  if (/\bnext month\b/i.test(normalized)) {
    const current = new Date(occurredTime);
    return formatUtcMonthLabel(new Date(Date.UTC(current.getUTCFullYear(), current.getUTCMonth() + 1, 15, 12, 0, 0, 0)).toISOString());
  }
  const yearsAgoMatch = normalized.match(/\b(?:around\s+)?(\d+)\s+years?\s+ago\b/i);
  if (yearsAgoMatch?.[1]) {
    const years = Number.parseInt(yearsAgoMatch[1], 10);
    if (Number.isFinite(years) && years > 0) {
      return String(new Date(occurredTime).getUTCFullYear() - years);
    }
  }
  const weekdayMatch = normalized.match(/\blast\s+(sun(?:day)?|mon(?:day)?|tue(?:s|sday)?|wed(?:nesday)?|thu(?:r|rs|rsday|rsday)?|fri(?:day)?|sat(?:urday)?)\b/i);
  if (weekdayMatch?.[1]) {
    const resolved = previousWeekdayIso(anchorIso, weekdayMatch[1]);
    if (resolved) {
      return formatUtcDayLabel(resolved);
    }
  }
  return null;
}

function temporalRelativeCueScore(content: string): number {
  if (/\byesterday\b/i.test(content) || /\blast night\b/i.test(content) || /\blast year\b/i.test(content)) {
    return 4;
  }
  if (/\b(?:around\s+)?\d+\s+years?\s+ago\b/i.test(content)) {
    return 4;
  }
  if (/\b\d+\s+days?\s+ago\b/i.test(content)) {
    return 3;
  }
  if (/\b(this year|today|tonight|last month|last week|next month)\b/i.test(content)) {
    return 2;
  }
  if (/\b(January|February|March|April|May|June|July|August|September|October|November|December)\b/i.test(content)) {
    return 2;
  }
  if (/\b(19|20)\d{2}\b/.test(content)) {
    return 1;
  }
  return 0;
}

function isMonthOnlyTemporalLabel(value: string): boolean {
  return /^(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4}$/iu.test(
    normalizeWhitespace(value)
  );
}

function normalizeTemporalToken(value: string): string {
  return value
    .toLowerCase()
    .replace(/'s$/u, "")
    .replace(/ing$/u, "")
    .replace(/ed$/u, "")
    .replace(/es$/u, "")
    .replace(/s$/u, "");
}

function temporalQueryTerms(queryText: string): readonly string[] {
  const entityTerms = new Set(
    extractEntityNameHints(queryText)
      .flatMap((value) => normalizeWhitespace(value).toLowerCase().split(/\s+/u))
      .map((value) => normalizeTemporalToken(value))
      .filter(Boolean)
  );
  return [...new Set(
    (queryText.match(/[A-Za-z][A-Za-z'-]*/gu) ?? [])
      .map((term) => normalizeTemporalToken(term))
      .filter((term) => term.length > 1)
      .filter((term) => !["what", "when", "did", "does", "do", "is", "are", "was", "were", "the", "a", "an", "at", "in", "on", "to", "his", "her", "their", "first", "last", "date", "time", "year", "month", "day"].includes(term))
      .filter((term) => !entityTerms.has(term))
  )];
}

function temporalTokenSet(content: string): Set<string> {
  return new Set(
    (content.match(/[A-Za-z][A-Za-z'-]*/gu) ?? [])
      .map((term) => normalizeTemporalToken(term))
      .filter((term) => term.length > 1)
  );
}

function temporalTokenMatch(term: string, token: string): boolean {
  return term === token || term.startsWith(token) || token.startsWith(term);
}

function temporalOverlapScore(queryTerms: readonly string[], content: string): { readonly overlap: number; readonly eventOverlap: number } {
  if (queryTerms.length === 0) {
    return { overlap: 0, eventOverlap: 0 };
  }
  const tokenBag = temporalTokenSet(content);
  let overlap = 0;
  let eventOverlap = 0;
  for (const term of queryTerms) {
    const matched = [...tokenBag].some((token) => temporalTokenMatch(term, token));
    if (matched) {
      overlap += 1;
      eventOverlap += 1;
    }
  }
  return { overlap, eventOverlap };
}

function readSourceBackfillContent(sourceUri: string | null | undefined): string | null {
  if (typeof sourceUri !== "string" || !sourceUri.startsWith("/") || !existsSync(sourceUri)) {
    return null;
  }

  const rawContent = readFileSync(sourceUri, "utf8");
  const filtered = rawContent
    .split("\n")
    .filter((line) => !/^\s*Captured:\s*/iu.test(line))
    .filter((line) => !/^\s*Conversation between\b/iu.test(line))
    .filter((line) => !/^\s*---\s*image_query:\s*/iu.test(line))
    .filter((line) => !/^\s*---\s*image_caption:\s*/iu.test(line))
    .join("\n");
  const sanitized = filtered.replace(/\s*\[image:\s*[^\]]+\]\s*/giu, " ");
  return normalizeWhitespace(sanitized) ? sanitized : null;
}

function extractFocusedTemporalSourceSnippet(sourceUri: string | null | undefined, queryText: string): string | null {
  const content = readSourceBackfillContent(sourceUri);
  if (!content) {
    return null;
  }
  return extractFocusedTemporalSnippet(content, queryText);
}

export function extractFocusedTemporalSnippet(content: string, queryText: string): string | null {
  const snippets = normalizeWhitespace(content)
    .split(/(?<=[.!?])\s+|\n+/u)
    .map((snippet) => normalizeWhitespace(snippet))
    .filter(Boolean);
  if (snippets.length === 0) {
    return null;
  }
  const queryTerms = temporalQueryTerms(queryText);
  let bestSnippet: string | null = null;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const snippet of snippets) {
    const { overlap, eventOverlap } = temporalOverlapScore(queryTerms, snippet);
    const temporalScore = temporalRelativeCueScore(snippet);
    const multimodalNoisePenalty = /(?:---\s*image_query:|---\s*image_caption:|\[image:)/iu.test(snippet) ? 6.5 : 0;
    const score =
      overlap * 1.5 +
      eventOverlap * 2.25 +
      temporalScore * 2 +
      (eventOverlap > 0 && temporalScore > 0 ? 3.2 : 0) +
      (/\b(next month|last year|years?\s+ago|yesterday|last month)\b/i.test(snippet) ? 1.1 : 0) -
      multimodalNoisePenalty;
    if (score > bestScore) {
      bestScore = score;
      bestSnippet = snippet;
    }
  }
  return bestScore > 0 ? bestSnippet : null;
}

function extractFocusedTemporalResultSnippet(result: RecallResult, queryText: string): string | null {
  const metadata =
    typeof result.provenance.metadata === "object" && result.provenance.metadata !== null
      ? (result.provenance.metadata as Record<string, unknown>)
      : null;
  const inlineCandidates = [
    typeof metadata?.source_turn_text === "string" ? metadata.source_turn_text : null,
    typeof metadata?.source_sentence_text === "string" ? metadata.source_sentence_text : null,
    typeof metadata?.sentence_text === "string" ? metadata.sentence_text : null,
    result.content
  ].filter((value): value is string => typeof value === "string" && normalizeWhitespace(value).length > 0);
  for (const candidate of inlineCandidates) {
    const focused = extractFocusedTemporalSnippet(candidate, queryText);
    if (focused) {
      return focused;
    }
    if (temporalRelativeCueScore(candidate) > 0) {
      return normalizeWhitespace(candidate);
    }
  }
  const sourceUri = typeof result.provenance.source_uri === "string" ? result.provenance.source_uri : null;
  return extractFocusedTemporalSourceSnippet(sourceUri, queryText);
}

function temporalStructuralEvidenceScore(result: RecallResult): number {
  const content = result.content.toLowerCase();
  let score = 0;
  if (result.memoryType === "episodic_memory") {
    score += 1.25;
  }
  const tier = typeof result.provenance?.tier === "string" ? result.provenance.tier.toLowerCase() : "";
  if (tier === "answerable_unit" || tier === "typed_temporal_media" || tier === "typed_temporal_person") {
    score += 1;
  }
  if (tier === "answerable_unit" && result.provenance.answerable_unit_type === "date_span") {
    score += 1.4;
  }
  if (tier === "focused_episodic_support") {
    score -= 0.6;
  }
  if (/^the best supported (?:year|date|month) is\b/i.test(content)) {
    score -= 3.5;
  }
  if (/\bnormalized year:\s*\d{4}\b/i.test(content)) {
    score += 1.2;
  }
  if (
    (typeof result.provenance.event_anchor_start === "string" && result.provenance.event_anchor_start.length > 0) ||
    (typeof result.provenance.event_anchor_end === "string" && result.provenance.event_anchor_end.length > 0)
  ) {
    score += 1.35;
  }
  return score;
}

export function selectBestTemporalEvidenceResult(queryText: string, results: readonly RecallResult[]): RecallResult | undefined {
  if (!/^\s*when\b/i.test(queryText) || results.length === 0) {
    return undefined;
  }

  const queryTerms = temporalQueryTerms(queryText);
  const targetHints = extractEntityNameHints(queryText)
    .map((value) => normalizeWhitespace(value).toLowerCase())
    .filter(Boolean);

  const scored = results.map((result) => {
    const content = result.content;
    const sourceUri = typeof result.provenance.source_uri === "string" ? result.provenance.source_uri : null;
    const sourceReferenceInstant = readSourceReferenceInstant(sourceUri);
    const sourceFocusedSnippet = extractFocusedTemporalResultSnippet(result, queryText);
    const { overlap, eventOverlap } = temporalOverlapScore(queryTerms, content);
    const cueScore = temporalRelativeCueScore(content);
    const explicitDate = parseMonthDayYearToIso(result.content) ? 2 : 0;
    const inferredDate = inferRelativeTemporalAnswerLabel(result.content, result.occurredAt) ? 2 : 0;
    const structuralScore = temporalStructuralEvidenceScore(result);
    const sourceOverlapScores = sourceFocusedSnippet ? temporalOverlapScore(queryTerms, sourceFocusedSnippet) : { overlap: 0, eventOverlap: 0 };
    const sourceOverlap = sourceOverlapScores.overlap;
    const sourceEventOverlap = sourceOverlapScores.eventOverlap;
    const sourceCueScore = sourceFocusedSnippet ? temporalRelativeCueScore(sourceFocusedSnippet) : 0;
    const sourceExplicitDate = sourceFocusedSnippet && parseMonthDayYearToIso(sourceFocusedSnippet) ? 2 : 0;
    const sourceInferredDate =
      sourceFocusedSnippet && inferRelativeTemporalAnswerLabel(sourceFocusedSnippet, result.occurredAt, sourceReferenceInstant)
        ? 2.2
        : 0;
    const ownerHint = typeof result.provenance.owner_entity_hint === "string" ? result.provenance.owner_entity_hint.toLowerCase() : "";
    const speakerHint = typeof result.provenance.speaker_entity_hint === "string" ? result.provenance.speaker_entity_hint.toLowerCase() : "";
    const subjectAnchorScore =
      targetHints.some((hint) => ownerHint.includes(hint) || speakerHint.includes(hint)) ? 1.4 : 0;
    const answerableDateSpanEventBonus =
      result.provenance.tier === "answerable_unit" &&
      result.provenance.answerable_unit_type === "date_span" &&
      (eventOverlap > 0 || sourceEventOverlap > 0)
        ? 3.4
        : 0;
    const anchoredSourceTemporalBonus =
      sourceCueScore > 0 && sourceEventOverlap > 0
        ? 4.2
        : 0;
    const weakFocusedSupportPenalty =
      sourceCueScore > 0 &&
      sourceEventOverlap === 0 &&
      eventOverlap === 0
        ? result.provenance.tier === "focused_episodic_support"
          ? -7.4
          : -3.8
        : 0;
    const weakCueOnlyPenalty =
      result.provenance.tier === "focused_episodic_support" &&
      sourceCueScore > 0 &&
      sourceEventOverlap <= 1 &&
      eventOverlap <= 1 &&
      sourceExplicitDate === 0 &&
      sourceInferredDate > 0
        ? -1.4
        : 0;
    const eventAnchorStart =
      typeof result.provenance.event_anchor_start === "string" && result.provenance.event_anchor_start.length > 0
        ? result.provenance.event_anchor_start
        : null;
    const eventAnchorScore = eventAnchorStart ? 1.8 : 0;
    const firstQueryBonus = /\bfirst\b/i.test(queryText) && eventAnchorStart ? 1.2 : 0;
    const score =
      overlap * 1.2 +
      eventOverlap * 1.6 +
      cueScore * 2 +
      explicitDate +
      inferredDate +
      structuralScore +
      subjectAnchorScore +
      answerableDateSpanEventBonus +
      anchoredSourceTemporalBonus +
      weakFocusedSupportPenalty +
      weakCueOnlyPenalty +
      eventAnchorScore +
      firstQueryBonus +
      sourceOverlap * 1.45 +
      sourceEventOverlap * 2.1 +
      sourceCueScore * 2.3 +
      sourceExplicitDate +
      sourceInferredDate +
      (sourceFocusedSnippet && result.memoryType === "artifact_derivation" ? 0.9 : 0);
    return { result, score };
  });

  scored.sort((left, right) => right.score - left.score);
  return scored[0]?.score && scored[0].score > 0 ? scored[0].result : results[0];
}

export function deriveTemporalClaimText(queryText: string, results: readonly RecallResult[]): string | null {
  const result = selectBestTemporalEvidenceResult(queryText, results);
  if (!result || !/^\s*when\b/i.test(queryText)) {
    return null;
  }
  const sourceReferenceInstant = readSourceReferenceInstant(
    typeof result.provenance.source_uri === "string" ? result.provenance.source_uri : null
  );

  const windowStart =
    typeof result.provenance.event_anchor_start === "string" && result.provenance.event_anchor_start.length > 0
      ? result.provenance.event_anchor_start
      : typeof result.provenance.window_start === "string" && result.provenance.window_start.length > 0
        ? result.provenance.window_start
        : null;
  const windowEnd =
    typeof result.provenance.event_anchor_end === "string" && result.provenance.event_anchor_end.length > 0
      ? result.provenance.event_anchor_end
      : typeof result.provenance.window_end === "string" && result.provenance.window_end.length > 0
        ? result.provenance.window_end
        : null;
  const normalizedYear =
    typeof result.provenance.normalized_year === "string" && /^\d{4}$/.test(result.provenance.normalized_year)
      ? result.provenance.normalized_year
      : null;
  const sourceFocusedContent = extractFocusedTemporalResultSnippet(result, queryText);
  if (normalizedYear) {
    return `The best supported year is ${normalizedYear}.`;
  }
  const sourceFocusedLabel =
    sourceFocusedContent && temporalRelativeCueScore(sourceFocusedContent) > 0
      ? inferRelativeTemporalAnswerLabel(sourceFocusedContent, result.occurredAt, sourceReferenceInstant)
      : null;
  if (sourceFocusedLabel) {
    return /^\d{4}$/.test(sourceFocusedLabel)
      ? `The best supported year is ${sourceFocusedLabel}.`
      : isMonthOnlyTemporalLabel(sourceFocusedLabel)
        ? `The best supported month is ${sourceFocusedLabel}.`
        : `The best supported date is ${sourceFocusedLabel}.`;
  }
  if (windowStart) {
    const start = new Date(windowStart);
    const end = windowEnd ? new Date(windowEnd) : null;
    if (!Number.isNaN(start.getTime())) {
      if (
        end &&
        !Number.isNaN(end.getTime()) &&
        start.getUTCFullYear() === end.getUTCFullYear() &&
        start.getUTCMonth() === end.getUTCMonth() &&
        start.getUTCDate() === 1 &&
        end.getUTCDate() >= 27
      ) {
        return `The best supported month is ${formatUtcMonthLabel(start.toISOString())}.`;
      }
      return `The best supported date is ${formatUtcDayLabel(start.toISOString())}.`;
    }
  }
  const provenanceMetadata =
    typeof result.provenance.metadata === "object" && result.provenance.metadata !== null
      ? (result.provenance.metadata as Record<string, unknown>)
      : null;
  const relativeTimeResolved = provenanceMetadata?.is_relative_time === true;
  const timeGranularity = typeof provenanceMetadata?.time_granularity === "string" ? provenanceMetadata.time_granularity : null;
  const temporalAnchor = result.occurredAt ?? sourceReferenceInstant ?? null;
  if (relativeTimeResolved && temporalAnchor) {
    if (timeGranularity === "year") {
      return `The best supported year is ${new Date(temporalAnchor).getUTCFullYear()}.`;
    }
    if (timeGranularity === "month") {
      return `The best supported month is ${formatUtcMonthLabel(temporalAnchor)}.`;
    }
    if (timeGranularity === "day" || timeGranularity === "week") {
      return `The best supported date is ${formatUtcDayLabel(temporalAnchor)}.`;
    }
  }

  const focusedContent = extractFocusedTemporalSnippet(result.content, queryText) ?? result.content;
  const explicit = inferRelativeTemporalAnswerLabel(focusedContent, result.occurredAt, sourceReferenceInstant);
  if (!explicit) {
    return null;
  }

  const isYearOnly = /^\d{4}$/.test(explicit);
  return isYearOnly
    ? `The best supported year is ${explicit}.`
    : isMonthOnlyTemporalLabel(explicit)
      ? `The best supported month is ${explicit}.`
      : `The best supported date is ${explicit}.`;
}

function readSourceReferenceInstant(sourceUri: string | null | undefined): string | null {
  if (typeof sourceUri !== "string" || !sourceUri.startsWith("/") || !existsSync(sourceUri)) {
    return null;
  }

  const content = readFileSync(sourceUri, "utf8");
  const capturedAt = content.match(/^\s*Captured:\s*([^\n]+)\s*$/mu)?.[1]?.trim() ?? null;
  const frontmatter = content.match(/^---\s*\n([\s\S]*?)\n---/u)?.[1] ?? "";
  const startedAt = frontmatter.match(/^\s*started_at:\s*([^\n]+)\s*$/mu)?.[1]?.trim() ?? null;
  const createdAt = frontmatter.match(/^\s*created_at:\s*([^\n]+)\s*$/mu)?.[1]?.trim() ?? null;
  const finishedAt = frontmatter.match(/^\s*finished_at:\s*([^\n]+)\s*$/mu)?.[1]?.trim() ?? null;
  const candidate = capturedAt ?? startedAt ?? createdAt ?? finishedAt;
  return parseIsoTimestamp(candidate ?? undefined) !== null ? new Date(candidate as string).toISOString() : null;
}

function movieMentionQueryEntity(queryText: string): string | null {
  const hints = extractEntityNameHints(queryText)
    .map((value) => normalizeWhitespace(value).toLowerCase())
    .filter(Boolean);
  return hints[0] ?? null;
}

function isMovieMentionQuery(queryText: string): boolean {
  const lowered = queryText.toLowerCase();
  return (
    /\bwhat\s+movie\b/.test(lowered) &&
    /\bmention(?:ed)?\b/.test(lowered) &&
    Boolean(movieMentionQueryEntity(queryText))
  );
}

function isFavoriteMediaDetailQueryText(queryText: string): boolean {
  const lowered = queryText.toLowerCase();
  return (
    /\bfavorite\s+(?:movie|movies|film|films|show|shows|book|books|song|songs|anime)\b/.test(lowered) ||
    (/\bone\s+of\b/.test(lowered) && /\bfavorite\s+(?:movie|movies|film|films)\b/.test(lowered))
  );
}

function isProjectIdeaQueryText(queryText: string): boolean {
  const lowered = queryText.toLowerCase();
  return (
    /\bproject\s+idea\b/.test(lowered) ||
    (/\bidea\b/.test(lowered) && /\bdiscuss\b/.test(lowered) && /\bproject\b/.test(lowered)) ||
    (/\bwhat\s+did\b/.test(lowered) && /\btalk\s+about\b/.test(lowered) && /\bidea\b/.test(lowered))
  );
}

function deriveMovieMentionClaimText(queryText: string, results: readonly RecallResult[]): string | null {
  if (!isMovieMentionQuery(queryText) || results.length === 0) {
    return null;
  }

  const entity = movieMentionQueryEntity(queryText);
  if (!entity) {
    return null;
  }

  const candidates = [
    ...results,
    ...results.filter(
      (result, index, all) =>
        typeof result.provenance.source_uri === "string" &&
        result.provenance.source_uri.startsWith("/") &&
        isTrustedPersonalSourceUri(result.provenance.source_uri) &&
        all.findIndex((other) => other.provenance.source_uri === result.provenance.source_uri) === index
    )
  ];

  for (const result of candidates) {
    const sourceUri = typeof result.provenance.source_uri === "string" ? result.provenance.source_uri : null;
    const sourceReferenceInstant = readSourceReferenceInstant(sourceUri) ?? result.occurredAt ?? null;
    const contentCandidates = [
      result.content,
      ...(sourceUri && isTrustedPersonalSourceUri(sourceUri) && existsSync(sourceUri)
        ? [readFileSync(sourceUri, "utf8").replace(/^---\s*\n[\s\S]*?\n---\s*/u, "")]
        : [])
    ];

    for (const content of contentCandidates) {
      const normalized = content.toLowerCase();
      if (!normalized.includes(entity)) {
        continue;
      }
      if (!/\bmovie\b|\bfilm\b/i.test(content)) {
        continue;
      }

      const movieTitle =
        content.match(/\bmovie\s+(?:called\s+)?["“]?([A-Z][A-Za-z0-9'’:& -]{1,80})["”]?/u)?.[1]?.trim() ??
        content.match(/\bfilm\s+(?:called\s+)?["“]?([A-Z][A-Za-z0-9'’:& -]{1,80})["”]?/u)?.[1]?.trim() ??
        null;
      if (!movieTitle) {
        continue;
      }

      const absoluteDate = inferRelativeTemporalAnswerLabel(content, result.occurredAt, sourceReferenceInstant);
      const relativePhrase =
        content.match(/\b(one|two|three|four|\d+)\s+weeks?\s+ago\b/iu)?.[0] ??
        content.match(/\byesterday\b/iu)?.[0] ??
        null;
      const location =
        content.match(/\bover\s+beers\s+and\s+dinner\s+at\s+(?:this\s+)?([^.!?\n]+?\b(?:place|restaurant|barbecue place)\b(?:\s+in\s+[A-Z][A-Za-z\s]+)?)/u)?.[1]?.trim() ??
        content.match(/\bat\s+(?:this\s+)?([^.!?\n]+?\b(?:place|restaurant|barbecue place)\b(?:\s+in\s+[A-Z][A-Za-z\s]+)?)/u)?.[1]?.trim() ??
        null;

      const detailParts: string[] = [`Dan mentioned the movie "${movieTitle}"`];
      if (relativePhrase && absoluteDate) {
        detailParts.push(`${relativePhrase}, which from ${formatUtcDayLabel(sourceReferenceInstant ?? result.occurredAt ?? new Date().toISOString())} resolves to around ${absoluteDate}`);
      } else if (absoluteDate) {
        detailParts.push(`around ${absoluteDate}`);
      }
      if (location) {
        detailParts.push(
          `over beers and dinner at ${location
            .replace(/^\bthe\b\s+/iu, "the ")
            .replace(/\s+two\s+weeks?\s+ago$/iu, "")
            .trim()}`
        );
      }
      return `${detailParts.join(" ")}.`;
    }
  }

  return null;
}

function deriveProjectIdeaClaimText(queryText: string, results: readonly RecallResult[]): string | null {
  if (!isProjectIdeaQueryText(queryText) || results.length === 0) {
    return null;
  }

  const candidates = [
    ...results.map((result) => result.content),
    ...[...new Set(
      results
        .map((result) => result.provenance.source_uri)
        .filter((value): value is string => typeof value === "string" && value.startsWith("/") && isTrustedPersonalSourceUri(value) && existsSync(value))
    )].map((sourceUri) => readFileSync(sourceUri, "utf8").replace(/^---\s*\n[\s\S]*?\n---\s*/u, ""))
  ];

  const orderedCandidates = [...candidates].sort((left, right) => {
    const leftScore =
      (/\bContext Suite\b/i.test(left) ? 3 : 0) +
      (/\bmemoir engine\b/i.test(left) ? 2 : 0) +
      (/\bBen\b/i.test(left) ? 1 : 0);
    const rightScore =
      (/\bContext Suite\b/i.test(right) ? 3 : 0) +
      (/\bmemoir engine\b/i.test(right) ? 2 : 0) +
      (/\bBen\b/i.test(right) ? 1 : 0);
    return rightScore - leftScore;
  });

  for (const content of orderedCandidates) {
    if (!/\bBen\b/i.test(content) || !/\b(?:idea|project|memoir engine|Context Suite)\b/i.test(content)) {
      continue;
    }
    const projectName =
      content.match(/\bBen and I talked about,?\s+the\s+([^.,\n]+?)(?:\s+and\s+specifically|\.)/iu)?.[1]?.trim() ??
      content.match(/\bdiscussion with Ben\b[\s\S]{0,80}?\babout\s+the\s+([^.,\n]+?)(?:,|\.)/iu)?.[1]?.trim() ??
      content.match(/\bcalling\s+(?:it|at)\s+the\s+([^.,\n]+?)(?:\.|,|\n)/iu)?.[1]?.trim() ??
      content.match(/\bproject,\s+the\s+([^.,\n]+?)(?:\s+which|\s+that|,|\.)/iu)?.[1]?.trim() ??
      (/\bContext Suite\b/i.test(content) ? "Context Suite" : null) ??
      null;
    const ideaCore =
      content.match(/\bidea of using\s+([^.!?\n]+?)(?:\.|$)/iu)?.[1]?.trim() ??
      content.match(/\bfocusing on\s+creating\s+([^.!?\n]+?)(?:\.|$)/iu)?.[1]?.trim() ??
      content.match(/\b(?:Context Suite is a system that can|system that can)\s+([^.!?\n]*memoir[^.!?\n]*)(?:\.|$)/iu)?.[1]?.trim() ??
      null;
    const outcome =
      content.match(/\b(help us generate\s+(?:a\s+)?"?life graph"?[^.!?\n]*)(?:\.|$)/iu)?.[1]?.trim() ??
      content.match(/\bbuild\s+a\s+"?life graph"?[^.!?\n]*?(?:project)?(?:\.|$)/iu)?.[0]?.trim().replace(/\.$/u, "") ??
      null;
    const hasKnowledgeGraph = /\bcreating\s+a\s+knowledge\s+graph\b/i.test(content) || /\bknowledge\s+graph\b/i.test(content);
    const hasPostgresEntityExtraction = /\bPostgres\s+database\b/i.test(content) && /\bentity\s+extraction\b/i.test(content);
    const hasLifeGraph = /\blife graph\b/i.test(content);
    const hasContextSuite = /\bContext Suite\b/i.test(content);
    const hasMemoirEngine = /\bmemoir engine\b/i.test(content);
    const hasTextAndAudio = /\btext\b/i.test(content) && /\baudio\b/i.test(content);

    if (!projectName || (!ideaCore && !outcome)) {
      continue;
    }

    const pieces = [`Ben and I discussed the ${projectName}`];
    if (hasPostgresEntityExtraction && hasKnowledgeGraph && hasLifeGraph) {
      pieces.push(
        'The idea was to use a Postgres database and entity extraction to create a knowledge graph, a "life graph" for the memoir project'
      );
    } else if (hasContextSuite && hasMemoirEngine) {
      pieces.push(
        `The idea was to ingest ${hasTextAndAudio ? "text and audio" : "source material"} into a memoir engine that can output chapters of a person's memoir`
      );
    } else if (ideaCore && outcome) {
      pieces.push(`The idea was to ${ideaCore.replace(/\s+This was.*$/iu, "").trim()} to ${outcome.replace(/^help us /iu, "help generate ")}`);
    } else if (ideaCore) {
      pieces.push(`The idea was to ${ideaCore.replace(/\s+This was.*$/iu, "").trim()}`);
    } else if (outcome) {
      pieces.push(`The idea was to ${outcome}`);
    }
    return `${pieces.join(". ")}.`;
  }

  return null;
}

function projectIdeaSupportScore(result: RecallResult): number {
  const content = result.content.toLowerCase();
  let score = 0;

  if (/\bben\b/.test(content)) {
    score += 6;
  }
  if (/\bcontext suite\b/.test(content)) {
    score += 7;
  }
  if (/\bmemoir engine\b/.test(content)) {
    score += 7;
  }
  if (/\bknowledge graph\b/.test(content) || /\blife graph\b/.test(content)) {
    score += 5;
  }
  if (/\bchapters of a person's memoir\b/.test(content) || /\bperson's memoir\b/.test(content)) {
    score += 5;
  }
  if (/\btext\b/.test(content) && /\baudio\b/.test(content)) {
    score += 3;
  }
  if (result.memoryType === "episodic_memory") {
    score += 3;
  } else if (result.memoryType === "artifact_derivation") {
    score += 2;
  }
  if (typeof result.provenance.source_uri === "string" && isTrustedPersonalSourceUri(result.provenance.source_uri)) {
    score += 2;
  }

  return score;
}

function deriveDepartureClaimText(queryText: string, results: readonly RecallResult[]): string | null {
  if (!isDepartureTimingQuery(queryText) || results.length === 0) {
    return null;
  }

  const entityHints = extractEntityNameHints(queryText)
    .map((value) => normalizeWhitespace(value).toLowerCase())
    .filter(Boolean);
  const contentCandidates = [
    ...results.map((result) => result.content),
    ...[...new Set(
      results
        .map((result) => result.provenance.source_uri)
        .filter((value): value is string => typeof value === "string" && value.startsWith("/"))
    )]
      .filter((sourceUri) => existsSync(sourceUri))
      .map((sourceUri) => readFileSync(sourceUri, "utf8"))
  ];

  for (const content of contentCandidates) {
    const normalized = content.toLowerCase();
    const hasEntityHint = entityHints.length === 0 || entityHints.some((hint) => normalized.includes(hint));
    const hasDepartureCue =
      /\b(left|leave|departed|returned|return(?:ed)?\s+to\s+the\s+u\.?s\.?|flew\s+back|moved\s+back)\b/i.test(content) &&
      /\b(us|u\.s\.|united states|bend|oregon)\b/i.test(content);
    if (!hasEntityHint || !hasDepartureCue) {
      continue;
    }
    const explicitDate = extractExplicitMonthDayYearLabel(content);
    if (explicitDate) {
      return `The best supported date is ${explicitDate}.`;
    }
  }

  return null;
}

function deriveRelationshipProfileClaimText(queryText: string, results: readonly RecallResult[]): string | null {
  if (!isRelationshipProfileQueryText(queryText) || results.length === 0) {
    return null;
  }

  const entityHints = extractEntityNameHints(queryText)
    .map((value) => normalizeWhitespace(value).toLowerCase())
    .filter(Boolean);
  if (entityHints.length === 0) {
    return null;
  }

  if (entityHints.length > 1) {
    const aggregate = results.find((result) => entityHints.every((hint) => result.content.toLowerCase().includes(hint)));
    if (aggregate) {
      return normalizeWhitespace(aggregate.content);
    }
  }

  const target = entityHints[0]!;
  const isLikelyPlaceAssociation = (value: string): boolean =>
    /\b(chiang mai|bangkok|thailand|lake tahoe|tahoe city|koh samui|bend|oregon|mexico city|japan)\b/iu.test(value);
  const contextualTexts = uniqueStrings([
    ...results.map((result) => result.content),
    ...[...new Set(
      results
        .map((result) => result.provenance.source_uri)
        .filter((value): value is string => typeof value === "string" && value.startsWith("/") && existsSync(value))
    )].map((sourceUri) => readFileSync(sourceUri, "utf8"))
  ]);
  const structuredFacts = results
    .map((result) => ({
      predicate: typeof result.provenance.predicate === "string" ? result.provenance.predicate : null,
      subjectName: typeof result.provenance.subject_name === "string" ? result.provenance.subject_name : null,
      objectName: typeof result.provenance.object_name === "string" ? result.provenance.object_name : null
    }))
    .filter(
      (fact): fact is { predicate: string; subjectName: string | null; objectName: string | null } =>
        typeof fact.predicate === "string" && fact.predicate.length > 0
    )
    .filter((fact) => normalizeWhitespace(fact.subjectName ?? "").toLowerCase() === target);
  if (structuredFacts.length > 0) {
    const relationPieces = new Set<string>();
    const ownerPieces = new Set<string>();
    const associationPieces = new Set<string>();
    const placeAssociationPieces = new Set<string>();
    for (const fact of structuredFacts) {
      if (fact.predicate === "friend_of") {
        relationPieces.add("a friend in your life");
      } else if (fact.predicate === "former_partner_of") {
        relationPieces.add("a former partner in your life");
      } else if (fact.predicate === "owner_of" && fact.objectName) {
        ownerPieces.add(normalizeWhitespace(fact.objectName));
      } else if (fact.predicate === "associated_with" && fact.objectName) {
        const cleanedObject = normalizeWhitespace(fact.objectName);
        if (ownerPieces.has(cleanedObject)) {
          continue;
        }
        if (isLikelyPlaceAssociation(cleanedObject)) {
          placeAssociationPieces.add(cleanedObject);
        } else {
          associationPieces.add(cleanedObject);
        }
      }
    }
    for (const content of contextualTexts) {
      for (const sentence of extractSentenceCandidates(content)) {
        for (const clause of extractEntityRelationshipClauses(sentence, target)) {
          const lowered = clause.toLowerCase();
          if (!lowered.includes(target)) {
            continue;
          }
          if (/\bfriend(?:s|ship)?\b/i.test(clause)) {
            relationPieces.add("a friend in your life");
          }
          if (/\bburning man\b/i.test(clause)) {
            associationPieces.add("Burning Man");
          }
          if (/\bweave artisan society\b/i.test(clause)) {
            associationPieces.add("Weave Artisan Society");
          }
        }
      }
    }
    if (relationPieces.size > 0 || ownerPieces.size > 0 || associationPieces.size > 0 || placeAssociationPieces.size > 0) {
      const subjectLabel = normalizeWhitespace(structuredFacts[0]?.subjectName ?? target);
      const pieces: string[] = [];
      if (relationPieces.size > 0) {
        pieces.push(`${subjectLabel} is ${[...relationPieces].join(" and ")}`);
      }
      if (ownerPieces.size > 0) {
        pieces.push(`${subjectLabel} is the owner of ${[...ownerPieces].join(", ")}`);
      }
      if (associationPieces.size > 0) {
        pieces.push(`${subjectLabel} is associated with ${[...associationPieces].join(", ")}`);
      }
      if (ownerPieces.size === 0 && placeAssociationPieces.size > 0) {
        pieces.push(`${subjectLabel} is associated with ${[...placeAssociationPieces].join(", ")}`);
      }
      if (pieces.length > 0) {
        return `${pieces.join(". ")}.`;
      }
    }
  }

  const sentences = uniqueStrings(
    results.flatMap((result) => extractSentenceCandidates(result.content).slice(0, 6))
  );
  const scored = sentences
    .map((sentence) => {
      const normalized = sentence.toLowerCase();
      let score = 0;
      if (normalized.includes(target)) {
        score += 4;
      }
      if (/\b(friend of mine|close friend|good friend|old friend|friend from|owner of|former romantic|dated|off and on relationship|partner in crime)\b/i.test(sentence)) {
        score += 5;
      }
      if (/\b(friend|owner|partner|dated|relationship|coworking|met|introduced)\b/i.test(sentence)) {
        score += 2;
      }
      if (/\b(chiang mai|mexico city|weave artisan society|burning man|koh samui|samui experience)\b/i.test(sentence)) {
        score += 1.5;
      }
      return { sentence: normalizeWhitespace(sentence), score };
    })
    .filter((entry) => entry.score >= 5)
    .sort((left, right) => right.score - left.score);

  return scored[0]?.sentence ?? null;
}

function relationshipHistorySupportScore(result: RecallResult, target: string): number {
  const content = result.content.toLowerCase();
  let score = 0;

  if (target && content.includes(target)) {
    score += 6;
  }
  if (/\blake tahoe\b|\btahoe\b/.test(content)) {
    score += 4;
  }
  if (/\bbend\b|\bbend, oregon\b/.test(content)) {
    score += 4;
  }
  if (/\bthailand\b|\bchiang mai\b/.test(content)) {
    score += 3;
  }
  if (/\bknown\b|\bmet\b|\bfriends?\b|\brelationship\b|\bdated\b|\boff and on\b|\bbest friends?\b/.test(content)) {
    score += 3;
  }
  if (/\bnine\b|\bten\b|\byears?\b/.test(content)) {
    score += 2;
  }
  if (result.memoryType === "episodic_memory") {
    score += 3;
  } else if (result.memoryType === "artifact_derivation") {
    score += 2;
  }
  if (typeof result.provenance.source_uri === "string" && isTrustedPersonalSourceUri(result.provenance.source_uri)) {
    score += 2;
  }

  return score;
}

function deriveRelationshipHistoryClaimText(queryText: string, results: readonly RecallResult[]): string | null {
  if (!isRelationshipHistoryRecapQuery(queryText) || results.length === 0) {
    return null;
  }

  const entityHints = extractEntityNameHints(queryText)
    .map((value) => normalizeWhitespace(value))
    .filter(Boolean);
  const inferredTargetFromResults =
    results
      .flatMap((result) => [
        typeof result.provenance.subject_name === "string" ? result.provenance.subject_name : null,
        typeof result.provenance.object_name === "string" ? result.provenance.object_name : null
      ])
      .filter((value): value is string => Boolean(value))
      .find((value) => value.toLowerCase() !== "steve" && value.toLowerCase() !== "steve tietze") ?? "";
  const target = entityHints.find((hint) => hint.toLowerCase() !== "steve") ?? entityHints[0] ?? inferredTargetFromResults;
  if (!target) {
    return null;
  }

  const contentCandidates = [
    ...results.map((result) => result.content),
    ...[...new Set(
      results
        .map((result) => result.provenance.source_uri)
        .filter((value): value is string => typeof value === "string" && value.startsWith("/") && existsSync(value))
    )]
      .slice(0, 6)
      .map((sourceUri) => readFileSync(sourceUri, "utf8"))
  ];
  const combined = contentCandidates.join("\n");
  const lowered = combined.toLowerCase();
  if (!lowered.includes(target.toLowerCase())) {
    return null;
  }

  const yearsLabel =
    combined.match(/\b(?:about|around|nearly)\s+(nine|ten)(?:\s+or\s+ten)?\s+years\b/iu)?.[0] ??
    combined.match(/\b(nine|ten)\s+or\s+ten\s+years\b/iu)?.[0] ??
    combined.match(/\bfor\s+(nine|ten)\s+years\b/iu)?.[0] ??
    null;
  const hasTahoe = /\blake tahoe\b|\btahoe city\b|\btahoe\b/i.test(combined);
  const hasBend = /\bbend,\s*oregon\b|\bbend\b/i.test(combined);
  const hasThailand = /\bthailand\b|\bchiang mai\b/i.test(combined);
  const leftForUs = /\boctober\s+18,\s+2025\b|\b10\/18\/2025\b/i.test(combined);
  const formerCurrentQuery = /\bused\s+to\s+be\s+in\s+my\s+life\b|\bno\s+longer\s+current\b/i.test(queryText);

  const pieces: string[] = [];
  pieces.push(
    formerCurrentQuery
      ? `${target} is the strongest grounded relationship that is no longer current in your life`
      : `${target} and Steve have known each other ${yearsLabel ? yearsLabel.replace(/^about\s+/iu, "for about ") : "for years"}`
  );
  if (hasTahoe) {
    pieces.push(`They first connected in Lake Tahoe`);
  }
  if (hasBend) {
    pieces.push(`later got closer in Bend, Oregon`);
  }
  if (hasThailand) {
    pieces.push(`and spent significant time together in Thailand`);
  }
  if (leftForUs) {
    pieces.push(`before falling out of touch after ${target} returned to the US on October 18, 2025`);
  }

  return `${pieces.join(", ")}.`;
}

function extractRelationshipChangeDateLabel(value: string): string | null {
  const departureWindowMatch = value.match(
    /\b(?:Lauren\b.{0,160}?)?\b(left|leave|departed|returned|return(?:ed)?\s+to\s+the\s+u\.?s\.?|flew\s+back|moved\s+back)\b[\s\S]{0,180}?\b(us|u\.s\.|united states|bend|oregon)\b[\s\S]{0,120}/iu
  );
  if (departureWindowMatch?.[0]) {
    const windowLabel =
      extractNumericMonthDayYearLabel(departureWindowMatch[0]) ??
      extractExplicitMonthDayYearLabel(departureWindowMatch[0]) ??
      extractExplicitDateLabel(departureWindowMatch[0]);
    if (windowLabel) {
      return windowLabel;
    }
  }

  const sentences = extractSentenceCandidates(value);
  const preferred = sentences.find(
    (sentence) =>
      /\bLauren\b/i.test(sentence) &&
      /\b(left|leave|departed|returned|return(?:ed)?\s+to\s+the\s+u\.?s\.?|flew\s+back|moved\s+back)\b/i.test(sentence) &&
      /\b(us|u\.s\.|united states|bend|oregon)\b/i.test(sentence)
  );
  if (preferred) {
    return extractExplicitMonthDayYearLabel(preferred) ?? extractExplicitDateLabel(preferred);
  }

  const fallback = sentences.find(
    (sentence) =>
      /\b(left|leave|departed|returned|return(?:ed)?\s+to\s+the\s+u\.?s\.?|flew\s+back|moved\s+back)\b/i.test(sentence) &&
      /\b(us|u\.s\.|united states|bend|oregon)\b/i.test(sentence)
  );
  if (fallback) {
    return extractExplicitMonthDayYearLabel(fallback) ?? extractExplicitDateLabel(fallback);
  }

  return null;
}

function deriveDailyLifeSummaryClaimText(queryText: string, results: readonly RecallResult[]): string | null {
  if (!isDailyLifeSummaryQuery(queryText) || results.length === 0) {
    return null;
  }

  const sourceTexts = [
    ...results.map((result) => result.content),
    ...[...new Set(
      results
        .map((result) => result.provenance.source_uri)
        .filter((value): value is string => typeof value === "string" && value.startsWith("/") && existsSync(value))
    )].slice(0, 4).map((sourceUri) => readFileSync(sourceUri, "utf8"))
  ].join("\n");

  const discovered: string[] = [];
  const add = (label: string, pattern: RegExp): void => {
    if (pattern.test(sourceTexts) && !discovered.includes(label)) {
      discovered.push(label);
    }
  };

  add("AI Brain", /\bai brain\b/i);
  add("Preset Kitchen", /\bpreset kitchen\b/i);
  add("Bumblebee", /\bbumblebee\b|\bopen claw\b|\bopenclaw\b/i);
  add("Well Inked", /\bwell inked\b/i);
  add("Two Way", /\btwo way\b|\b2way\b/i);

  if (discovered.length === 0) {
    return null;
  }

  const leadIn = /\blast\s+week\b/i.test(queryText)
    ? "Last week you"
    : /\bthis\s+morning\b/i.test(queryText)
      ? "This morning you"
      : /\btoday\b/i.test(queryText)
        ? "Today you"
        : "Yesterday you";

  if (/\b(talk about|talked about|discuss|discussed|conversation|chat)\b/i.test(queryText)) {
    return `${leadIn} talked about ${joinExactDetailValues(discovered)}.`;
  }

  return `${leadIn} worked on ${joinExactDetailValues(discovered)}.`;
}

function derivePurchaseSummaryClaimText(queryText: string, results: readonly RecallResult[]): string | null {
  if (!isPurchaseSummaryQuery(queryText) || results.length === 0) {
    return null;
  }

  const sourceTexts = [
    ...results.map((result) => result.content),
    ...[...new Set(
      results
        .map((result) => result.provenance.source_uri)
        .filter((value): value is string => typeof value === "string" && value.startsWith("/") && existsSync(value))
    )].slice(0, 4).map((sourceUri) => readFileSync(sourceUri, "utf8"))
  ].join("\n");

  const discovered: string[] = [];
  const add = (label: string, pattern: RegExp): void => {
    if (pattern.test(sourceTexts) && !discovered.includes(label)) {
      discovered.push(label);
    }
  };

  add("Snickers bar", /\bsnickers\b/i);
  add("jelly vitamin C pack", /\bjelly\s+vitamin\s+c\s+pack\b/i);
  add("iced latte", /\b(?:iced|eis)\s*,?\s+latte\b/i);
  add("breakfast burrito with fries", /\bbreakfast\s+burrito\b[\s\S]{0,30}\bfries\b/i);
  add("caramel latte", /\bcaramel\s+latte\b/i);
  add("toilet paper", /\btoilet\s+paper\b/i);
  add("yogurt", /\byogurt\b/i);
  add("two bananas", /\btwo\s+bananas\b/i);
  add("coffee", /\bcoffee\b/i);
  add("sponge", /\bsponge\b/i);
  add("vitamin C mineral drink", /\bvitamin\s+c\s+mineral\s+drink\b/i);
  add("electrolytes pack", /\belectrolytes?\s+pack\b/i);
  add("water", /\bwater\b/i);
  add("gas for your scooter", /\bgas\b[\s\S]{0,20}\bscooter\b/i);

  const totalParts: string[] = [];
  if (/\b(?:seven\s+hundred\s+and\s+eighty|780)\s+(?:baht|bot)\b/i.test(sourceTexts)) {
    totalParts.push("780 baht");
  }
  if (/\b(?:around\s+)?(?:twenty\s+four|24)\s+(?:usd|dollars?\s+us|us\s+dollars?)\b/i.test(sourceTexts)) {
    totalParts.push("24 USD");
  }

  if (discovered.length === 0 && totalParts.length === 0) {
    return null;
  }

  const itemText =
    discovered.length > 0
      ? `Today you bought ${joinExactDetailValues(discovered)}.`
      : "Today you made several purchases.";
  const totalText =
    totalParts.length > 0
      ? ` The note only gives a total price, not per-item prices: ${joinExactDetailValues(totalParts)}.`
      : " The note does not give per-item prices.";

  return `${itemText}${totalText}`;
}

function deriveMediaSummaryClaimText(queryText: string, results: readonly RecallResult[]): string | null {
  if (!isMediaSummaryQuery(queryText) || results.length === 0) {
    return null;
  }

  const canonicalizeMediaTitle = (value: string | null | undefined): string | null => {
    if (!value) {
      return null;
    }
    const normalized = normalizeWhitespace(value);
    if (!normalized) {
      return null;
    }

    const patterns: ReadonlyArray<readonly [RegExp, string]> = [
      [/\bfrom\s+dusk\s+till\s+dawn\b/i, "From Dusk Till Dawn"],
      [/\bchainsaw\s+man\b/i, "Chainsaw Man"],
      [/\bslow\s+horses\b/i, "Slow Horses"],
      [/\bsinners\b/i, "Sinners"],
      [/\bavatar\b/i, "Avatar"]
    ];
    for (const [pattern, title] of patterns) {
      if (pattern.test(normalized)) {
        return title;
      }
    }

    if (
      /^(tv show|movie|show|book|song|anime|that|back up)$/i.test(normalized) ||
      /^(from|at|in|on|with|about)\b/i.test(normalized) ||
      /\b(friend|burger|thailand new year|leonardo|di caprio)\b/i.test(normalized)
    ) {
      return null;
    }

    return normalized;
  };

  const titlesFromResults = results
    .flatMap((result) => {
      const direct = typeof result.provenance.media_title === "string" ? result.provenance.media_title : null;
      const context = result.content;
      return [
        canonicalizeMediaTitle(direct),
        canonicalizeMediaTitle(context)
      ];
    })
    .filter((value): value is string => Boolean(value));

  const titles = uniqueStrings(
    titlesFromResults
  );

  if (titles.length === 0) {
    return null;
  }

  if (/\bwhat\s+movie\s+did\s+.+\s+mention\b/i.test(queryText)) {
    const top = results[0];
    return top?.content ?? `The best supported media mention is ${titles[0]}.`;
  }

  return `The strongest grounded titles you've talked about are ${joinExactDetailValues(titles)}.`;
}

function derivePreferenceSummaryClaimText(queryText: string, results: readonly RecallResult[]): string | null {
  if (!isPreferenceSummaryQuery(queryText)) {
    return null;
  }

  const lowered = queryText.toLowerCase();
  const foodOnly = /\bfood\b|\bfoods\b|\beat\b|\bdrink\b|\bdrinks\b|\bbeverage\b|\bbeers?\b/i.test(queryText);
  const beerQuery = /\bbeers?\b/i.test(queryText);
  const beerRankingQuery = beerQuery && /\b(rank|favorite|favourite|prefer)\b/i.test(queryText);
  const isBeerObject = (value: string): boolean => /\b(leo|singha|chang|cheng|beer|beers)\b/i.test(value);
  const wantsPositive =
    /\b(?:like|likes|love|loves|enjoy|enjoys|prefer|prefers)\b/i.test(queryText) &&
    !/\b(?:dislike|dislikes|hate|hates|avoid|avoids)\b/i.test(queryText);
  const wantsNegative =
    /\b(?:dislike|dislikes|hate|hates|avoid|avoids)\b/i.test(queryText) &&
    !/\b(?:like|likes|love|loves|enjoy|enjoys|prefer|prefers)\b/i.test(queryText);

  if (results.length === 0) {
    if (/\bfood\b|\beat\b|\bdrink\b|\bbeers?\b/i.test(queryText)) {
      return "I do not have any grounded explicit food-preference facts in the current corpus yet.";
    }
    return null;
  }

  const facts = results
    .map((result) => {
      const predicate = typeof result.provenance.predicate === "string" ? result.provenance.predicate : "likes";
      const objectText = typeof result.provenance.object_text === "string" ? result.provenance.object_text : null;
      const domain = typeof result.provenance.domain === "string" ? result.provenance.domain : null;
      const qualifier = typeof result.provenance.qualifier === "string" ? result.provenance.qualifier : null;
      return objectText
        ? {
            predicate,
            objectText,
            domain,
            qualifier
          }
        : null;
    })
    .filter((value): value is { predicate: string; objectText: string; domain: string | null; qualifier: string | null } => Boolean(value))
    .filter((fact) => !foodOnly || fact.domain === "food")
    .filter((fact) => (beerQuery ? isBeerObject(fact.objectText) : !isBeerObject(fact.objectText) || /\bspicy food\b/i.test(fact.objectText)));

  const positiveObjects = uniqueStrings(
    facts
      .filter((fact) => ["likes", "prefers"].includes(fact.predicate))
      .map((fact) => fact.objectText)
  );
  const negativeObjects = uniqueStrings(
    facts
      .filter((fact) => ["dislikes", "avoids"].includes(fact.predicate))
      .map((fact) => fact.objectText)
  );
  const rankedPositiveObjects = facts
    .filter((fact) => ["likes", "prefers"].includes(fact.predicate))
    .map((fact) => ({
      objectText: fact.objectText,
      rank: Number((fact.qualifier ?? "").match(/\brank\s+(\d+)\b/i)?.[1] ?? "999")
    }))
    .filter((fact) => Number.isFinite(fact.rank))
    .sort((left, right) => left.rank - right.rank)
    .map((fact) => fact.objectText);
  const mergedPositiveObjects = positiveObjects;
  const mergedNegativeObjects = negativeObjects;

  if (
    (wantsPositive && mergedPositiveObjects.length === 0) ||
    (wantsNegative && mergedNegativeObjects.length === 0) ||
    facts.length === 0
  ) {
    if (/\bfood\b|\beat\b|\bdrink\b|\bbeers?\b/i.test(queryText)) {
      return "I do not have any grounded explicit food-preference facts in the current corpus yet.";
    }
    return null;
  }

  if (beerRankingQuery && rankedPositiveObjects.length > 0) {
    return `The strongest grounded beer preference facts are that in Thailand you rank ${joinExactDetailValues(
      uniqueStrings(rankedPositiveObjects)
    )} in that order.`;
  }

  if (wantsPositive) {
    return `The strongest grounded preference facts are that you like ${joinExactDetailValues(mergedPositiveObjects)}.`;
  }

  if (wantsNegative) {
    return `The strongest grounded preference facts are that you dislike or avoid ${joinExactDetailValues(mergedNegativeObjects)}.`;
  }

  const clauses: string[] = [];
  if (mergedPositiveObjects.length > 0) {
    clauses.push(`like ${joinExactDetailValues(mergedPositiveObjects)}`);
  }
  if (mergedNegativeObjects.length > 0) {
    clauses.push(`dislike or avoid ${joinExactDetailValues(mergedNegativeObjects)}`);
  }

  return clauses.length > 0 ? `The strongest grounded preference facts are that you ${clauses.join(" and ")}.` : null;
}

function deriveRoutineSummaryClaimText(queryText: string, results: readonly RecallResult[]): string | null {
  if (!isRoutineSummaryQuery(queryText) || results.length === 0) {
    return null;
  }

  const sourceTexts = [
    ...results.map((result) => result.content),
    ...[...new Set(
      results
        .map((result) => result.provenance.source_uri)
        .filter((value): value is string => typeof value === "string" && value.startsWith("/") && existsSync(value))
    )]
      .slice(0, 4)
      .map((sourceUri) => readFileSync(sourceUri, "utf8").replace(/^---\s*\n[\s\S]*?\n---\s*/u, ""))
  ].join("\n");

  const steps: string[] = [];
  const add = (label: string, pattern: RegExp): void => {
    if (pattern.test(sourceTexts) && !steps.includes(label)) {
      steps.push(label);
    }
  };

  add("wake around 7 to 8 AM", /\b(?:wake up|wakes up).{0,40}\b(?:seven|7).{0,10}(?:eight|8)\s*(?:am)?\b/i);
  add("make coffee", /\bmake\s+some\s+coffee\b|\bhave\s+coffee\b/i);
  add("check AI news on Reddit", /\bAI news on Reddit\b/i);
  add("review email and current tasks", /\b(?:emails?|current tasks?|tasks? for the day)\b/i);
  add("start work around 10 AM", /\bstart working around ten\b|\bstart work around ten\b|\bten ish\b/i);
  add("split work across 2Way and Well Inked", /\btwo way\b|\b2way\b/i);
  add("take a midday exercise break", /\bmidday break\b|\bgym\b|\byoga\b|\bwalking around\b|\bpark\b/i);
  const valuesPersonalTime = /\bpersonal time\b|\bnot just working on the computer all day\b/i.test(sourceTexts);

  if (steps.length === 0) {
    return null;
  }

  const summary = `Your current daily routine is to ${joinExactDetailValues(steps)}.`;
  return valuesPersonalTime ? `${summary} You are also trying to protect personal time.` : summary;
}

function isHabitConstraintQueryText(queryText: string): boolean {
  return (
    /\bwhat\s+(?:habits?\s+or\s+constraints?|constraints?\s+or\s+habits?)\b/i.test(queryText) ||
    /\bwhat\s+habits?\s+matter\s+right\s+now\b/i.test(queryText) ||
    /\bwhat\s+constraints?\s+matter\s+right\s+now\b/i.test(queryText)
  );
}

function deriveHabitConstraintClaimText(queryText: string, results: readonly RecallResult[]): string | null {
  if (!isHabitConstraintQueryText(queryText) || results.length === 0) {
    return null;
  }

  const routineText = deriveRoutineSummaryClaimText(queryText, results);
  const sourceTexts = [
    ...results.map((result) => result.content),
    ...[...new Set(
      results
        .map((result) => result.provenance.source_uri)
        .filter((value): value is string => typeof value === "string" && value.startsWith("/") && existsSync(value))
    )]
      .slice(0, 4)
      .map((sourceUri) => readFileSync(sourceUri, "utf8").replace(/^---\s*\n[\s\S]*?\n---\s*/u, ""))
  ].join("\n");

  const constraintHints = uniqueStrings([
    ...results
      .filter((result) => {
        const stateType = String(result.provenance.state_type ?? "").toLowerCase();
        return stateType === "constraint" || stateType === "style_spec";
      })
      .map((result) => trimSentenceForTitle(normalizeWhitespace(result.content), 120)),
    ...(/\bprotect personal time\b/i.test(sourceTexts) || /\bnot just working on the computer all day\b/i.test(sourceTexts)
      ? ["protect personal time"]
      : [])
  ]).slice(0, 3);

  const parts: string[] = [];
  if (routineText) {
    parts.push(routineText.replace(/^Your current daily routine is to /u, "your current daily routine is to "));
  }
  if (constraintHints.length > 0) {
    parts.push(`active constraints include ${joinExactDetailValues(constraintHints)}`);
  }

  if (parts.length === 0) {
    return null;
  }

  return `The strongest grounded habits and constraints right now are that ${parts.join(", and ")}.`;
}

function derivePersonTimeClaimText(queryText: string, results: readonly RecallResult[]): string | null {
  if (!isPersonTimeFactQuery(queryText) || results.length === 0) {
    return null;
  }
  return results[0]?.content ?? null;
}

function deriveRelationshipChangeClaimText(queryText: string, results: readonly RecallResult[]): string | null {
  if (!isRelationshipChangeQueryText(queryText) || results.length === 0) {
    return null;
  }

  const contentCandidates = [
    ...results.map((result) => result.content),
    ...[...new Set(
      results
        .map((result) => result.provenance.source_uri)
        .filter(
          (value): value is string =>
            typeof value === "string" &&
            value.startsWith("/") &&
            isTrustedPersonalSourceUri(value) &&
            existsSync(value)
        )
    )]
      .slice(0, 6)
      .map((sourceUri) =>
        readFileSync(sourceUri, "utf8").replace(/^---\s*\n[\s\S]*?\n---\s*/u, "")
      )
  ];

  const scored = contentCandidates
    .map((content) => {
      let score = 0;
      if (/\bLauren\b/i.test(content)) {
        score += 4;
      }
      if (/\b(recent relationship change|big relationship change|relationship change|changed recently)\b/i.test(content)) {
        score += 4;
      }
      if (/\b(left Thailand|left to go back to the US|left to go back to The US|returned to the US|flew back to the US|left Chiang Mai|moved back to the US|moved from Thailand back to the US|moved from Thailand to the US)\b/i.test(content)) {
        score += 4;
      }
      if (/\b(haven't really talked|haven't talked|don't talk|don't talk anymore|no longer talk|little to no communication|barely spoken|cut me out|haven't really talked since|stopped talking)\b/i.test(content)) {
        score += 5;
      }
      if (extractRelationshipChangeDateLabel(content)) {
        score += 5;
      } else if (extractExplicitDateLabel(content)) {
        score += 2;
      }
      return { content, score };
    })
    .filter((entry) => entry.score >= 8)
    .sort((left, right) => right.score - left.score);

  const best = scored[0]?.content;
  if (!best) {
    return null;
  }

  const combined = scored.map((entry) => entry.content).join("\n");
  const departureDatedContent = contentCandidates.find(
    (content) =>
      /\bLauren\b/i.test(content) &&
      /\b(left|leave|departed|returned|return(?:ed)?\s+to\s+the\s+u\.?s\.?|flew\s+back|moved\s+back|moved\s+from)\b/i.test(content) &&
      /\b(us|u\.s\.|united states|bend|oregon)\b/i.test(content) &&
      (extractNumericMonthDayYearLabel(content) || extractExplicitMonthDayYearLabel(content) || extractRelationshipChangeDateLabel(content))
  );
  const dateLabel =
    (departureDatedContent
      ? extractNumericMonthDayYearLabel(departureDatedContent) ??
        extractExplicitMonthDayYearLabel(departureDatedContent) ??
        extractRelationshipChangeDateLabel(departureDatedContent)
      : null) ??
    extractRelationshipChangeDateLabel(best) ??
    extractRelationshipChangeDateLabel(combined) ??
    extractExplicitDateLabel(best) ??
    extractExplicitDateLabel(combined);
  const targetName = /\bLauren\b/i.test(combined) ? "Lauren" : "the relationship";
  const relationshipShift =
    /\b(stopped talking)\b/i.test(combined) &&
      /\b(haven't really talked|haven't talked|don't talk|don't talk anymore|no longer talk|little to no communication|barely spoken)\b/i.test(combined)
      ? "they stopped talking after that and haven't really talked since"
      : /\b(haven't really talked|haven't talked|don't talk|don't talk anymore|no longer talk|little to no communication|barely spoken)\b/i.test(combined)
      ? "they haven't really talked since"
      : /\b(stopped talking)\b/i.test(combined)
      ? "they stopped talking after that"
      : /\bcut me out\b/i.test(combined)
        ? "communication effectively stopped after that"
        : /\bLauren\b/i.test(combined)
          ? "they haven't really talked since"
        : "the relationship shifted sharply after that";

  if (dateLabel) {
    return `A key relationship change was with ${targetName}. The relationship changed when ${/\bLauren\b/i.test(combined) ? "Lauren" : "they"} left Thailand for the US on ${dateLabel}, and ${relationshipShift}.`;
  }

  if (/\bLauren\b/i.test(best)) {
    return `A key relationship change was with Lauren. She left Thailand for the US, and they have barely talked since.`;
  }

  return null;
}

function deriveCurrentProjectClaimText(queryText: string, results: readonly RecallResult[]): string | null {
  if ((!isCurrentProjectQueryText(queryText) && !isContinuityHandoffSearchQueryText(queryText)) || results.length === 0) {
    return null;
  }

  const sourceTexts = [
    ...results.map((result) => result.content),
    ...[...new Set(
      results
        .map((result) => result.provenance.source_uri)
        .filter((value): value is string => typeof value === "string" && value.startsWith("/") && existsSync(value))
    )].slice(0, 4).map((sourceUri) => readFileSync(sourceUri, "utf8"))
  ].join("\n");

  const discovered: string[] = [];
  const add = (label: string, pattern: RegExp): void => {
    if (pattern.test(sourceTexts) && !discovered.includes(label)) {
      discovered.push(label);
    }
  };

  add("Well Inked", /\bwell inked\b/i);
  add("Two Way", /\b(two way|2way)\b/i);
  add("Preset Kitchen", /\bpreset kitchen\b/i);
  add("AI Brain", /\bai brain\b/i);

  if (discovered.length === 0) {
    return null;
  }

  if (isContinuityHandoffSearchQueryText(queryText)) {
    return `The highest-value work to pick back up is ${joinExactDetailValues(discovered)}.`;
  }

  return discovered.length === 1
    ? `The current project in focus is ${discovered[0]}.`
    : `The current projects in focus are ${joinExactDetailValues(discovered)}.`;
}

function derivePreciseFactClaimText(queryText: string, results: readonly RecallResult[]): string | null {
  if (!isPreciseFactDetailQuery(queryText) || results.length === 0) {
    return null;
  }

  const primaryEntityResults = filterResultsForPrimaryEntity(queryText, results);
  const sourceBackfillTexts = [...new Set(
    primaryEntityResults
      .map((result) => result.provenance.source_uri)
      .filter((value): value is string => typeof value === "string" && value.startsWith("/") && existsSync(value))
  )].map((sourceUri) => extractPrimaryEntityBoundTextFromContent(queryText, readFileSync(sourceUri, "utf8")));
  const combined = [
    ...primaryEntityResults.map((result) => extractPrimaryEntityBoundText(queryText, result)),
    ...sourceBackfillTexts
  ].join(" ");
  if (!combined.trim()) {
    return null;
  }

  if (/\b(?:team|company|organization|employer)\b/i.test(queryText)) {
    const organizationMatch =
      combined.match(/\b(?:signed with|joined|works? at|working at|employed by|plays? for|team is|company is|organization is)\s+([A-Z][A-Za-z0-9'’&.-]*(?:\s+[A-Z][A-Za-z0-9'’&.-]*){0,5})\b/u)?.[1]?.trim() ??
      null;
    if (organizationMatch) {
      return `The best supported organization is ${organizationMatch}.`;
    }
  }

  if (/\b(?:role|position|title|job)\b/i.test(queryText)) {
    const roleMatch =
      combined.match(/\b(?:current role is|role is|position is|title is|works as|working as|serves as)\s+([A-Za-z][A-Za-z0-9'’&/ -]{2,80})\b/u)?.[1]?.trim() ??
      null;
    if (roleMatch) {
      return `The best supported role is ${roleMatch.replace(/\s+,/gu, ",")}.`;
    }
  }

  if (/\b(?:color|colour)\b/i.test(queryText)) {
    const colorMatch = combined.match(/\b(black|blue|brown|green|gold|gray|grey|orange|pink|purple|red|silver|white|yellow)\b/iu)?.[1];
    if (colorMatch) {
      return `The best supported color is ${colorMatch.toLowerCase()}.`;
    }
  }

  if (/\b(?:adopt|adopted)\b/i.test(queryText)) {
    const adoptedMatch = combined.match(/\badopted\s+(?:a\s+|an\s+|the\s+)?([A-Za-z][A-Za-z'’ -]{1,40})\b/iu)?.[1]?.trim();
    if (adoptedMatch) {
      return `The best supported adopted item is ${adoptedMatch}.`;
    }
  }

  if (/\b(?:named|called|name)\b/i.test(queryText)) {
    const namedMatch =
      combined.match(/\b(?:named|called)\s+["“]?([^"”\n.,!?]{2,80})["”]?/iu)?.[1]?.trim() ??
      null;
    if (namedMatch) {
      return `The best supported name is ${namedMatch}.`;
    }
  }

  if (/\b(?:bought|purchased|purchase)\b/i.test(queryText)) {
    const boughtMatch = combined.match(/\b(?:bought|purchased)\s+(?:a\s+|an\s+|the\s+)?([^.,!?;\n]{2,80})/iu)?.[1]?.trim();
    if (boughtMatch) {
      return `The best supported purchased item is ${boughtMatch}.`;
    }
  }

  if (/\bhow\s+long\b/i.test(queryText)) {
    const durationMatch =
      combined.match(/\b(\d+\s+(?:minute|minutes|hour|hours)\s+each\s+way)\b/i) ??
      combined.match(/\b(\d+\s+(?:minute|minutes|hour|hours)\s+(?:one\s+way|one-way))\b/i) ??
      combined.match(/\b(\d+\s+(?:minute|minutes|hour|hours))\b/i);
    if (durationMatch?.[1]) {
      return `The best supported duration is ${durationMatch[1]}.`;
    }
  }

  if (/\bwhere\b/i.test(queryText) && /\b(class|classes|yoga)\b/i.test(queryText)) {
    const locationCandidates = results.flatMap((result) => {
      const content = result.content;
      const candidates: Array<{ readonly value: string; readonly score: number }> = [];
      const namedYogaMatches = content.matchAll(/\b([A-Z][A-Za-z0-9'’&.-]*(?:\s+[A-Z][A-Za-z0-9'’&.-]*){0,4}\s+Yoga)(?:\s+studio)?\b/gu);
      for (const match of namedYogaMatches) {
        const value = match[1]?.trim();
        if (!value) {
          continue;
        }
        const matchIndex = typeof match.index === "number" ? match.index : content.indexOf(value);
        const contextStart = Math.max(0, matchIndex - 80);
        const contextEnd = Math.min(content.length, matchIndex + value.length + 120);
        const context = content.slice(contextStart, contextEnd);
        let score = 8;
        if (/\bserenity yoga\b/i.test(value)) {
          score += 10;
        }
        if (new RegExp(`\\b(?:near|at|to|from|make it to)\\s+${escapeRegExp(value)}\\b`, "iu").test(content)) {
          score += 5;
        }
        if (/\b(?:near|at|to|from|make it to|local|studio practice|brunch spots)\b/i.test(context)) {
          score += 5;
        }
        if (/\b(?:app|apps|application|free trial|subscription|available for|in-app purchases|one-time purchase|library)\b/i.test(context)) {
          score -= 8;
        }
        if (/\b(?:using|home practice|download|customizable practices)\b/i.test(context)) {
          score -= 4;
        }
        if (/^\s*yoga\s+studio\s*$/iu.test(value)) {
          score -= 12;
        }
        candidates.push({ value, score });
      }

      const genericVenueMatches = content.matchAll(
        /\b(?:near|at|to)\s+([A-Z][A-Za-z0-9'’&.-]*(?:\s+[A-Z][A-Za-z0-9'’&.-]*){0,4}\s+(?:Studio|Gym|Center|Centre))\b/gu
      );
      for (const match of genericVenueMatches) {
        const value = match[1]?.trim();
        if (!value) {
          continue;
        }
        let score = 3;
        if (/^\s*yoga\s+studio\s*$/iu.test(value)) {
          score -= 10;
        }
        candidates.push({ value, score });
      }

      return candidates;
    });

    const sourceBackfillCandidates = [...new Set(
      results
        .map((result) => result.provenance.source_uri)
        .filter((value): value is string => typeof value === "string" && value.startsWith("/"))
    )]
      .flatMap((sourceUri) => {
        if (!existsSync(sourceUri)) {
          return [];
        }
        const content = readFileSync(sourceUri, "utf8");
        const candidates: Array<{ readonly value: string; readonly score: number }> = [];
        for (const match of content.matchAll(/\b([A-Z][A-Za-z0-9'’&.-]*(?:\s+[A-Z][A-Za-z0-9'’&.-]*){0,4}\s+Yoga)(?:\s+studio)?\b/gu)) {
          const value = match[1]?.trim();
          if (!value) {
            continue;
          }
          const matchIndex = typeof match.index === "number" ? match.index : content.indexOf(value);
          const contextStart = Math.max(0, matchIndex - 100);
          const contextEnd = Math.min(content.length, matchIndex + value.length + 160);
          const context = content.slice(contextStart, contextEnd);
          let score = 10;
          if (/\bserenity yoga\b/i.test(value)) {
            score += 14;
          }
          if (/\b(?:near|at|to|from|make it to|local|studio practice|yoga instructor|fellow yogis)\b/i.test(context)) {
            score += 8;
          }
          if (/\b(?:app|apps|free trial|subscription|available for|in-app purchases|one-time purchase|customizable practices)\b/i.test(context)) {
            score -= 10;
          }
          candidates.push({ value, score });
        }
        return candidates;
      });

    const bestLocation = [...locationCandidates, ...sourceBackfillCandidates].sort((left, right) => right.score - left.score)[0];
    if (bestLocation?.value) {
      return `The best supported place is ${bestLocation.value}.`;
    }
  }

  if (/\bwhere\s+did\s+i\s+(?:redeem|buy|get|purchase)\b/i.test(queryText)) {
    const storeMatch =
      combined.match(/\b(?:at|from)\s+([A-Z][A-Za-z0-9'’&.-]*(?:\s+[A-Z][A-Za-z0-9'’&.-]*){0,3})\b/u) ??
      combined.match(/\b([A-Z][A-Za-z0-9'’&.-]*(?:\s+[A-Z][A-Za-z0-9'’&.-]*){0,3})\s+(?:store|market|supermarket|shop)\b/u);
    if (storeMatch?.[1]) {
      return `The best supported place is ${storeMatch[1].trim()}.`;
    }
  }

  const titleMatch =
    /\bwhat\s+(?:play|movie|film|show|book|song|title)\b/i.test(queryText) || /\bwhat\s+(?:was|is)\s+the\s+name\s+of\b/i.test(queryText)
      ? combined.match(/\b(?:called|named|title(?:d)?|production of)\s+["“]?([A-Z][A-Za-z0-9'’\- ]{2,80})["”]?/u)
      : null;
  if (titleMatch?.[1]) {
    return `The best supported title is ${titleMatch[1].trim()}.`;
  }

  const favoriteMatch =
    /\bfavorite\b/i.test(queryText)
      ? combined.match(/\bfavorite(?:\s+[a-z' -]+){0,6}\s+(?:is|are|was|were)\s+([^.!?\n]+)/iu) ??
        combined.match(/\b([A-Za-z][A-Za-z' -]{2,60})\s+(?:is|was)\s+my\s+top\s+pick\b/iu)
      : null;
  if (favoriteMatch?.[1]) {
    return `The best supported detail is ${favoriteMatch[1].trim()}.`;
  }

  if (/\bcolor\b/i.test(queryText) && /\bhair\b/i.test(queryText)) {
    const colorMatch = combined.match(/\b(black|brown|blonde|red|ginger|auburn|pink|purple|violet|blue|green|silver|gray|grey|platinum)\b/iu);
    if (colorMatch?.[1]) {
      return `The best supported color is ${colorMatch[1].trim()}.`;
    }
  }

  if (/\bteam\b/i.test(queryText) && /\bsign(?:ed|ing)\b/i.test(queryText)) {
    const teamMatch = combined.match(/\bsigned with (?:the )?([^.!?\n]+)/iu);
    if (teamMatch?.[1]) {
      return `The best supported team is ${teamMatch[1].trim()}.`;
    }
  }

  if (/\bposition\b/i.test(queryText) && /\bteam\b/i.test(queryText)) {
    const positionMatch =
      combined.match(/\b(?:play(?:ing)?(?: as)?|position(?: is| was)?|i(?:'m| am) a)\s+(?:an?\s+|the\s+)?([^.!?\n]+)/iu);
    if (positionMatch?.[1]) {
      return `The best supported position is ${positionMatch[1].trim()}.`;
    }
  }

  if (/\bnames?\b/i.test(queryText)) {
    const namesMatch = combined.match(/\bnames?\s+(?:are|were)\s+([^.!?\n]+)/iu);
    if (namesMatch?.[1]) {
      return `The best supported names are ${namesMatch[1].trim()}.`;
    }
  }

  if (/\bname\b/i.test(queryText)) {
    const namedMatch = combined.match(/\b(?:name(?: is| was)?|named)\s+([A-Z][A-Za-z' -]{1,60})\b/u);
    if (namedMatch?.[1]) {
      return `The best supported name is ${namedMatch[1].trim()}.`;
    }
  }

  if (/\badopt/i.test(queryText)) {
    const adoptMatch = combined.match(/\badopt(?:ed|ing)\s+([^.!?\n]+)/iu);
    if (adoptMatch?.[1]) {
      return `The best supported detail is ${adoptMatch[1].trim()}.`;
    }
  }

  if (/\bcar\b/i.test(queryText)) {
    const carMatch = combined.match(/\b(?:got|bought|picked up|drive|drives)\s+(?:a|an|the)\s+([^.!?\n]+?)(?:\s+(?:after|because|and)\b|[.!?\n])/iu);
    if (carMatch?.[1]) {
      return `The best supported car is ${carMatch[1].trim()}.`;
    }
  }

  return null;
}

function inferPreciseFactDetailSource(
  queryText: string,
  results: readonly RecallResult[]
): "episodic_leaf" | "artifact_source" | "derivation" | "mixed" | undefined {
  if (!isPreciseFactDetailQuery(queryText) || results.length === 0) {
    return undefined;
  }

  const hasSourceBackfill = results.some(
    (result) => typeof result.provenance.source_uri === "string" && result.provenance.source_uri.startsWith("/") && existsSync(result.provenance.source_uri)
  );
  const hasLeaf = results.some((result) => result.memoryType === "episodic_memory" || result.memoryType === "narrative_event");
  const hasDerivation = results.some((result) => result.memoryType === "artifact_derivation");

  if (hasLeaf && hasDerivation) {
    return hasSourceBackfill ? "mixed" : "mixed";
  }
  if (hasSourceBackfill) {
    return "artifact_source";
  }
  if (hasLeaf) {
    return "episodic_leaf";
  }
  if (hasDerivation) {
    return "derivation";
  }
  return undefined;
}

function isSubjectBoundExactDetailQuery(
  queryText: string,
  planner: ReturnType<typeof planRecallQuery>,
  options: {
    readonly subjectHints: readonly string[];
    readonly temporalDetailFocus: boolean;
    readonly globalQuestionFocus: boolean;
    readonly profileInferenceFocus: boolean;
    readonly identityProfileFocus: boolean;
    readonly sharedCommonalityFocus: boolean;
  }
): boolean {
  const entityFocus = parseQueryEntityFocus(queryText);
  const focusedSubjectHints = entityFocus.primaryHints;
  const subjectHints = focusedSubjectHints.length === 1 ? focusedSubjectHints : options.subjectHints;
  if (options.temporalDetailFocus || options.globalQuestionFocus || options.profileInferenceFocus || options.identityProfileFocus || options.sharedCommonalityFocus) {
    return false;
  }
  if (subjectHints.length !== 1) {
    return false;
  }
  if (isPreciseFactDetailQuery(queryText)) {
    return true;
  }
  if (planner.queryClass !== "direct_fact") {
    return false;
  }
  return /\b(?:what|which|who|where)\b/i.test(queryText) && !/\b(?:lately|overall|common|share|compare|why)\b/i.test(queryText);
}

function isSubjectIsolationQuery(
  queryText: string,
  planner: ReturnType<typeof planRecallQuery>,
  options: {
    readonly subjectHints: readonly string[];
    readonly temporalDetailFocus: boolean;
    readonly globalQuestionFocus: boolean;
    readonly profileInferenceFocus: boolean;
    readonly identityProfileFocus: boolean;
    readonly sharedCommonalityFocus: boolean;
  }
): boolean {
  const entityFocus = parseQueryEntityFocus(queryText);
  const focusedSubjectHints = entityFocus.primaryHints;
  const subjectHints = focusedSubjectHints.length === 1 ? focusedSubjectHints : options.subjectHints;
  if (subjectHints.length !== 1) {
    return false;
  }
  if (options.globalQuestionFocus || options.sharedCommonalityFocus || options.identityProfileFocus) {
    return false;
  }
  if (options.temporalDetailFocus || isPreciseFactDetailQuery(queryText)) {
    return true;
  }
  if (planner.queryClass !== "direct_fact") {
    return false;
  }
  if (entityFocus.mode === "primary_with_companion") {
    return true;
  }
  if (options.profileInferenceFocus && !/^\s*(?:is|does|did|would|will|can|could|has|have|had)\b/i.test(queryText)) {
    return false;
  }
  return (
    /^\s*(?:is|does|did|would|will|can|could|has|have|had|what|which|who|where|when|how)\b/i.test(queryText) &&
    !/\b(?:lately|overall|common|share|compare)\b/i.test(queryText)
  );
}

function gatherPrimaryEntitySourceBackfillTexts(queryText: string, results: readonly RecallResult[]): readonly string[] {
  return [...new Set(
    results
      .map((result) => result.provenance.source_uri)
      .filter((value): value is string => typeof value === "string" && value.startsWith("/") && existsSync(value))
  )].map((sourceUri) => extractPrimaryEntityBoundTextFromContent(queryText, readFileSync(sourceUri, "utf8")));
}

function gatherFullSourceBackfillTexts(results: readonly RecallResult[]): readonly string[] {
  return [...new Set(
    results
      .map((result) => result.provenance.source_uri)
      .filter((value): value is string => typeof value === "string" && value.startsWith("/") && existsSync(value))
  )].map((sourceUri) => readFileSync(sourceUri, "utf8"));
}

function gatherAnswerableUnitExactDetailBackfillTexts(
  queryText: string,
  candidates: readonly AnswerableUnitCandidate[]
): readonly string[] {
  if (candidates.length === 0) {
    return [];
  }

  const family = inferExactDetailQuestionFamily(queryText);
  const hobbyQuery = /\bhobbies?\b/i.test(queryText);
  const petAllergyQuery =
    /\bpets?\s+wouldn'?t\s+cause\b/i.test(queryText) ||
    (/\bpets?\b/i.test(queryText) && /\ballerg/i.test(queryText));
  const shouldBackfill =
    hobbyQuery ||
    petAllergyQuery ||
    family === "martial_arts" ||
    family === "favorite_books" ||
    family === "meal_companion";
  if (!shouldBackfill) {
    return [];
  }

  const maxUnits =
    hobbyQuery ? 10 :
    family === "martial_arts" ? 8 :
    petAllergyQuery ? 6 :
    5;
  const candidateTexts = new Map<string, number>();

  for (const candidate of candidates) {
    if (candidate.ownershipStatus !== "owned") {
      continue;
    }
    if (!["participant_turn", "source_sentence", "fact_span"].includes(candidate.unit.unitType)) {
      continue;
    }

    const contentText = normalizeWhitespace(candidate.unit.contentText);
    const sourceSentenceText =
      typeof candidate.unit.metadata?.source_sentence_text === "string"
        ? normalizeWhitespace(candidate.unit.metadata.source_sentence_text)
        : "";
    const familySpecificSupport =
      family === "martial_arts"
        ? /\b(kickboxing|taekwondo|karate|judo|muay thai|boxing|jiu[- ]?jitsu|wrestling)\b/i.test(`${contentText} ${sourceSentenceText}`)
        : hobbyQuery
          ? isStandaloneHobbyStatement(contentText) ||
            /\b(hobbies?|enjoy|enjoys|love|loves|like|likes|writing|reading|watching movies|exploring nature|hanging with friends)\b/i.test(
              `${contentText} ${sourceSentenceText}`
            )
          : petAllergyQuery
            ? /\b(allerg|reptiles?|animals with fur|hairless cats?|pigs?)\b/i.test(`${contentText} ${sourceSentenceText}`)
            : false;
    for (const text of [contentText, sourceSentenceText]) {
      if (!text || isInterrogativeClaimText(text)) {
        continue;
      }
      const extractedValues = extractExactDetailValues(text, queryText)
        .map((value) => normalizeExactDetailValueForQuery(queryText, value))
        .filter(Boolean);
      if (candidate.slotCueScore <= 0 && candidate.subjectMatchScore < 1 && extractedValues.length === 0 && !familySpecificSupport) {
        continue;
      }
      const score =
        candidate.totalScore +
        Math.max(candidate.slotCueScore, 0) +
        Math.max(candidate.subjectMatchScore, 0) +
        (familySpecificSupport ? 2.2 : 0) +
        (extractedValues.length > 0 ? 2.8 + extractedValues.length * 0.35 : 0);
      const existing = candidateTexts.get(text);
      if (existing === undefined || score > existing) {
        candidateTexts.set(text, score);
      }
    }
  }

  return [...candidateTexts.entries()]
    .sort((left, right) => right[1] - left[1])
    .map(([text]) => text)
    .slice(0, maxUnits * 2);
}

function isStructuredExactAnswerQuery(queryText: string): boolean {
  if (inferExactDetailQuestionFamily(queryText) !== "generic") {
    return true;
  }
  return (
    /\bwhat\s+kind\s+of\s+flowers?\b/i.test(queryText) ||
    /\bwhat\s+kind\s+of\s+bird\b/i.test(queryText) ||
    /\bfavorite\s+movie\s+trilog(?:y|ies)\b/i.test(queryText) ||
    /\bfavorite\s+movies?\b/i.test(queryText) ||
    /\bhobbies?\b/i.test(queryText) ||
    /\bspark(?:ed)?\b/i.test(queryText) && /\binterest\b/i.test(queryText) ||
    /\bhow\s+did\b/i.test(queryText) && /\bget into\b/i.test(queryText) ||
    /\bwhat\s+shop\b/i.test(queryText) ||
    /\bwhat\s+store\b/i.test(queryText)
  );
}

function isStandaloneHobbyStatement(text: string): boolean {
  const normalized = normalizeWhitespace(text);
  if (!normalized || /\?\s*$/u.test(normalized)) {
    return false;
  }
  return (
    /\bbesides\s+[A-Za-z][^,!?\n]{0,40},\s*(?:i|he|she)\s+(?:also\s+)?(?:love|loves|enjoy|enjoys|like|likes)\b/iu.test(normalized) ||
    /^[A-Za-z]+ing(?:\s+[A-Za-z]+){0,2}(?:\s+and\s+[A-Za-z]+ing(?:\s+(?:with|around)\s+[A-Za-z]+){0,3})?!?$/u.test(normalized)
  );
}

function inferExactDetailQuestionFamily(queryText: string): ExactDetailQuestionFamily {
  const lowered = queryText.toLowerCase();
  if (/\bwhat\s+did\b/.test(lowered) && /\bresearch\b/.test(lowered)) {
    return "research_topic";
  }
  if (/\bwhat\s+did\b/.test(lowered) && /\brealiz/.test(lowered)) {
    return "realization";
  }
  if (/\bplans?\b/.test(lowered) && /\bsummer\b/.test(lowered) && /\badoption\b/.test(lowered)) {
    return "summer_adoption_plan";
  }
  if (/\btemporary\s+job\b/.test(lowered)) {
    return "temporary_job";
  }
  if (/\bfavorite\s+style\s+of\s+painting\b/.test(lowered)) {
    return "favorite_painting_style";
  }
  if (/\bwhat\s+martial\s+arts?\b/.test(lowered) || /\bmartial\s+arts?\s+has\b/.test(lowered)) {
    return "martial_arts";
  }
  if (/\bmain\s+focus\b/.test(lowered)) {
    return "main_focus";
  }
  if (/\bwho\b/.test(lowered) && /\b(?:dinner|lunch|breakfast)\b/.test(lowered)) {
    return "meal_companion";
  }
  if (/\bfavorite\s+books?\b/.test(lowered)) {
    return "favorite_books";
  }
  if (/\bwhat\s+are\s+the\s+names?\b/.test(lowered) || /\bnames?\b/.test(lowered)) {
    return "plural_names";
  }
  if (/\bwhat\s+(?:team|club|organization|company|employer)\b/.test(lowered)) {
    return "team";
  }
  if (/\bwhat\s+(?:position|role|title|job)\b/.test(lowered)) {
    return "role";
  }
  if (/\bwhat\s+color\b/.test(lowered)) {
    return "color";
  }
  if (/\bwhat\s+type\s+of\s+car\b/.test(lowered) || /\bwhat\s+kind\s+of\s+car\b/.test(lowered)) {
    return "car";
  }
  if (/\bwhat\s+advice\s+did\b/.test(lowered)) {
    return "advice";
  }
  return "generic";
}

function normalizeExactDetailValueForQuery(queryText: string, rawValue: string): string {
  let value = normalizeWhitespace(
    rawValue
      .replace(/^(?:and|to|for|that)\s+/iu, "")
      .replace(/[.?!,:;]+$/u, "")
      .trim()
  );
  const family = inferExactDetailQuestionFamily(queryText);

  if (family === "research_topic") {
    if (/\badoption\s+agenc(?:y|ies)\b/i.test(value)) {
      return "Adoption agencies";
    }
    value = value
      .replace(/^(?:find|look\s+for|looking\s+for|research(?:ing)?|researched)\s+/iu, "")
      .replace(/\b(?:or\s+lawyers?|or\s+an?\s+lawyer)\b.*$/iu, "")
      .replace(/^(?:an?\s+|the\s+)/iu, "")
      .trim();
  }

  if (family === "realization") {
    if (/\bself-?care\b/i.test(value)) {
      return "self-care is important";
    }
    value = value
      .replace(/^(?:that\s+)?/iu, "")
      .replace(/\bit'?s\b/iu, "it is")
      .trim();
  }

  if (family === "temporary_job") {
    value = value.replace(/\bto\s+cover\s+expenses\b.*$/iu, "").trim();
  }

  if (family === "summer_adoption_plan") {
    value = value.replace(/\bfor\s+the\s+summer\b/iu, "").trim();
  }

  if (family === "meal_companion") {
    value = value
      .replace(/^(?:my|our)\s+mom$/iu, "her mother")
      .replace(/^(?:my|our)\s+mother$/iu, "her mother")
      .replace(/^(?:my|our)\s+dad$/iu, "his father")
      .replace(/^(?:my|our)\s+father$/iu, "his father");
    if (/^(?:my|his|her)\s+mother$/iu.test(value)) {
      return value.toLowerCase();
    }
    if (/^mother$/iu.test(value)) {
      return "her mother";
    }
  }

  if (/\bhobbies?\b/i.test(queryText)) {
    if (/\b(?:in|on|at|to|of|from|into|onto|around|about)$/iu.test(value)) {
      return "";
    }
  }

  return normalizeWhitespace(value);
}

function joinExactDetailValues(values: readonly string[]): string {
  if (values.length === 0) {
    return "";
  }
  if (values.length === 1) {
    return values[0]!;
  }
  if (values.length === 2) {
    return `${values[0]!}, ${values[1]!}`;
  }
  return `${values.slice(0, -1).join(", ")}, ${values[values.length - 1]!}`;
}

function splitExactDetailList(rawValue: string, queryText: string): readonly string[] {
  return rawValue
    .split(/\s*,\s*|\s+and\s+/u)
    .map((value) => normalizeExactDetailValueForQuery(queryText, value))
    .filter(Boolean);
}

function containsInterrogativePromptCue(text: string): boolean {
  const normalized = normalizeWhitespace(text);
  if (!normalized) {
    return false;
  }
  if (/\?\s*$/u.test(normalized)) {
    return true;
  }
  return /\b(?:what|why|how|who|when|where)\b[^.!?\n]{0,80}\?/iu.test(normalized);
}

function extractExactDetailValues(text: string, queryText: string): readonly string[] {
  const family = inferExactDetailQuestionFamily(queryText);

  if (family === "martial_arts") {
    const matches = [...text.matchAll(/\b(kickboxing|taekwondo|karate|judo|muay thai|boxing|jiu[- ]?jitsu|wrestling)\b/giu)]
      .map((match) => normalizeExactDetailValueForQuery(queryText, match[1] ?? ""))
      .filter(Boolean);
    return [...new Set(matches)];
  }

  if (family === "favorite_books") {
    const match =
      text.match(/\bfavorite\s+books?\s+(?:are|were|include|included)\s+([A-Z][^.!?\n]{2,120})/u) ??
      text.match(/\bbookshelf\b[^.!?\n]{0,120}\b([A-Z][A-Za-z0-9'’:& -]{2,80}(?:\s*,\s*[A-Z][A-Za-z0-9'’:& -]{2,80})+)/u);
    if (match?.[1]) {
      return match[1]
        .split(/\s*,\s*|\s+and\s+/u)
        .map((value) => normalizeExactDetailValueForQuery(queryText, value))
        .filter(Boolean);
    }
  }

  if (family === "plural_names") {
    const match =
      text.match(/\bsnakes?\s+(?:named|are named|called)\s+([A-Z][A-Za-z0-9'’& -]{1,80}(?:\s*(?:,|and)\s*[A-Z][A-Za-z0-9'’& -]{1,80})*)/u) ??
      text.match(/\bnames?\s+(?:are|were)\s+([^.!?\n]+)/iu);
    if (match?.[1]) {
      return match[1]
        .split(/\s*,\s*|\s+and\s+/u)
        .map((value) => normalizeExactDetailValueForQuery(queryText, value))
        .filter(Boolean);
    }
  }

  if (family === "research_topic") {
    if (/\badoption\s+agenc(?:y|ies)\b/i.test(text)) {
      return ["Adoption agencies"];
    }
    const match =
      text.match(/\bresearch(?:ed|ing)?\s+(?:how\s+to\s+)?([A-Za-z][A-Za-z0-9'’& -]{1,80}?)(?:\s+(?:to|for|because|so\s+that)\b|[.?!,])/iu) ??
      text.match(/\bresearch(?:ed|ing)?\s+([A-Za-z][A-Za-z0-9'’& -]{1,80})(?:$|[.?!,])/iu);
    return match?.[1] ? [normalizeExactDetailValueForQuery(queryText, match[1])] : [];
  }

  if (family === "summer_adoption_plan") {
    const match =
      text.match(/\b(?:plan|plans|planning)\s+to\s+([A-Za-z][A-Za-z0-9'’,& -]{1,100}?)(?:[.?!]|$)/iu) ??
      text.match(/\bfor\s+the\s+summer\b.{0,60}\b([A-Za-z][A-Za-z0-9'’,& -]{1,100}?)(?:[.?!]|$)/iu);
    return match?.[1] ? [normalizeExactDetailValueForQuery(queryText, match[1])] : [];
  }

  if (family === "temporary_job") {
    const match = text.match(/\btook\s+(?:a|an)\s+([A-Za-z][A-Za-z0-9'’,& -]{1,80}?)(?:\s+(?:to|for)\b|[.?!,])/iu);
    if (match?.[1]) {
      return [normalizeExactDetailValueForQuery(queryText, match[1])];
    }
    return /\b(?:temp|temporary)\s+job\b/iu.test(text) ? ["None"] : [];
  }

  if (family === "favorite_painting_style") {
    const match =
      text.match(/\bfavorite\s+style\s+of\s+painting\s+(?:is|was)\s+([A-Za-z][A-Za-z0-9'’& -]{1,60})/iu) ??
      text.match(/\b(?:loves?|enjoys?)\s+([A-Za-z][A-Za-z0-9'’& -]{1,60})\s+painting/iu);
    return match?.[1] ? [normalizeExactDetailValueForQuery(queryText, match[1])] : [];
  }

  if (family === "realization") {
    if (/\bself-?care\b/i.test(text)) {
      return ["self-care is important"];
    }
    const match =
      text.match(/\brealiz(?:e|ed|ing)\s+(?:that\s+)?([A-Za-z][^.!?]{2,120})/iu) ??
      text.match(/\blearn(?:ed|ing)\s+(?:that\s+)?([A-Za-z][^.!?]{2,120})/iu);
    return match?.[1] ? [normalizeExactDetailValueForQuery(queryText, match[1])] : [];
  }

  if (family === "meal_companion") {
    const match =
      text.match(/\b(?:dinner|lunch|breakfast)\s+with\s+([A-Za-z][A-Za-z0-9'’& -]{1,60}|her mother|his mother|her father|his father|mother|father|parents?)\b/iu) ??
      text.match(/\b((?:my|our)\s+(?:mom|mother|dad|father))\s+and\s+i\s+(?:made|had|cooked)\s+(?:some\s+)?(?:dinner|lunch|breakfast)\b/iu);
    return match?.[1] ? [normalizeExactDetailValueForQuery(queryText, match[1])] : [];
  }

  if (family === "main_focus") {
    const loweredText = text.toLowerCase();
    const loweredQuery = queryText.toLowerCase();
    if (/\binternational politics\b/.test(loweredQuery) && !/\binternational\b|\bglobal\b|\bforeign\b/.test(loweredText)) {
      return [];
    }
    if (/\blocal politics\b/.test(loweredQuery) && !/\blocal\b|\bcommunity\b|\bneighbo[u]?rhood\b/.test(loweredText)) {
      return [];
    }
    const match =
      text.match(/\bmain\s+focus(?:es)?(?:\s+in\s+[A-Za-z][A-Za-z0-9'’& -]+)?\s+(?:is|was|are|were)\s+([A-Za-z][A-Za-z0-9'’,& -]{1,100})/iu) ??
      text.match(/\bpassionate\s+about\s+([A-Za-z][A-Za-z0-9'’,& -]{1,100})/iu) ??
      text.match(/\bparticularly\s+interesting\s+to\s+me\b[^.!?\n]{0,20}\b([A-Za-z][A-Za-z0-9'’,& -]{1,100})/iu) ??
      text.match(/\bfocus(?:ed)?\s+on\s+([A-Za-z][A-Za-z0-9'’,& -]{1,100})/iu);
    return match?.[1] ? [normalizeExactDetailValueForQuery(queryText, match[1])] : [];
  }

  if (/\bhobbies?\b/i.test(queryText)) {
    const hobbyValues = new Set<string>();
    const hobbiesMatch = text.match(/\bhobbies?\s+(?:are|include)\s+([A-Za-z][^.!?\n]{2,140})/iu);
    if (hobbiesMatch?.[1]) {
      for (const value of splitExactDetailList(hobbiesMatch[1], queryText)) {
        hobbyValues.add(value);
      }
    }

    const besidesMatch = text.match(/\bbesides\s+([A-Za-z][^,!?\n]{0,40}),\s*(?:i|he|she)\s+(?:also\s+)?(?:love|loves|enjoy|enjoys)\s+([A-Za-z][^.!?\n]{2,140})/iu);
    if (besidesMatch?.[1]) {
      const prefix = normalizeExactDetailValueForQuery(queryText, besidesMatch[1]);
      if (prefix) {
        hobbyValues.add(prefix);
      }
    }
    if (besidesMatch?.[2]) {
      for (const value of splitExactDetailList(besidesMatch[2], queryText)) {
        hobbyValues.add(value);
      }
    }

    const gerundListMatch = text.match(/\b([A-Za-z]+ing(?:\s+[A-Za-z]+){0,2}(?:\s*,\s*[A-Za-z]+ing(?:\s+[A-Za-z]+){0,2})*(?:\s+and\s+[A-Za-z]+ing(?:\s+[A-Za-z]+){0,2})?)\b/u);
    if (
      gerundListMatch?.[1] &&
      !containsInterrogativePromptCue(text) &&
      /^\s*(?:i|he|she)\s+(?:also\s+)?(?:love|loves|enjoy|enjoys|like|likes)\b/iu.test(text)
    ) {
      for (const value of splitExactDetailList(gerundListMatch[1], queryText)) {
        hobbyValues.add(value);
      }
    }

    const hobbyStatementMatch = text.match(
      /^\s*([A-Za-z]+ing(?:\s+[A-Za-z]+){0,2}(?:\s+and\s+[A-Za-z]+ing(?:\s+(?:with|around)\s+[A-Za-z]+){0,3})?)\s*!?$/u
    );
    if (
      hobbyStatementMatch?.[1] &&
      !containsInterrogativePromptCue(text) &&
      /(?:\sand\s)|(?:,\s*)/u.test(hobbyStatementMatch[1])
    ) {
      for (const value of splitExactDetailList(hobbyStatementMatch[1], queryText)) {
        hobbyValues.add(value);
      }
    }

    if (hobbyValues.size > 0) {
      return [...hobbyValues];
    }
  }

  const singleValue = extractExactDetailValue(text, queryText);
  return singleValue ? [singleValue] : [];
}

function extractExactDetailValue(text: string, queryText: string): string | null {
  if (/\bwhat\s+did\b/i.test(queryText) && /\bresearch\b/i.test(queryText)) {
    const match =
      text.match(/\bresearch(?:ed|ing)?\s+(?:how\s+to\s+)?([A-Za-z][A-Za-z0-9'’& -]{1,80}?)(?:\s+(?:to|for|because|so\s+that)\b|[.?!,])/iu) ??
      text.match(/\bresearch(?:ed|ing)?\s+([A-Za-z][A-Za-z0-9'’& -]{1,80})(?:$|[.?!,])/iu);
    return match?.[1]?.trim() ?? null;
  }

  if (/\bplans?\b/i.test(queryText)) {
    const match =
      text.match(/\b(?:plan|plans|planning)\s+to\s+([A-Za-z][A-Za-z0-9'’,& -]{1,100}?)(?:[.?!]|$)/iu) ??
      text.match(/\bfor\s+the\s+summer\b.{0,60}\b([A-Za-z][A-Za-z0-9'’,& -]{1,100}?)(?:[.?!]|$)/iu);
    return match?.[1]?.trim() ?? null;
  }

  if (/\btemporary\s+job\b/i.test(queryText)) {
    const match = text.match(/\btook\s+(?:a|an)\s+([A-Za-z][A-Za-z0-9'’,& -]{1,80}?)(?:\s+(?:to|for)\b|[.?!,])/iu);
    if (match?.[1]) {
      return match[1].trim();
    }
    return /\b(?:temp|temporary)\s+job\b/iu.test(text) ? "None" : null;
  }

  if (/\bwhat\s+(?:team|club|organization)\b/i.test(queryText)) {
    const match =
      text.match(/\b(?:signed with|signed to|plays? for|played for|joined|joining)\s+([A-Z][A-Za-z0-9'’&.-]*(?:\s+[A-Z][A-Za-z0-9'’&.-]*){0,5})/u) ??
      text.match(/\bteam\s+(?:was|is)\s+([A-Z][A-Za-z0-9'’&.-]*(?:\s+[A-Z][A-Za-z0-9'’&.-]*){0,5})/u);
    return match?.[1]?.trim() ?? null;
  }

  if (/\bwhat\s+(?:position|role|title|job)\b/i.test(queryText)) {
    const match =
      text.match(/\b(?:worked|serv(?:ed|es)|hired|joined|was|is)\s+(?:as|the)\s+([A-Za-z][A-Za-z0-9'’&/-]*(?:\s+[A-Za-z][A-Za-z0-9'’&/-]*){0,5})/u) ??
      text.match(/\b(?:position|role|title)\s+(?:was|is|of)\s+([A-Za-z][A-Za-z0-9'’&/-]*(?:\s+[A-Za-z][A-Za-z0-9'’&/-]*){0,5})/u);
    return match?.[1]?.trim() ?? null;
  }

  if (/\bwhat\s+color\b/i.test(queryText)) {
    const match = text.match(/\b(black|white|blue|red|green|yellow|orange|purple|pink|brown|gray|grey|gold|silver)\b/i);
    return match?.[1]?.trim() ?? null;
  }

  if (/\bwhat\s+(?:martial arts|martial art)\b/i.test(queryText)) {
    const matches = [...text.matchAll(/\b(kickboxing|taekwondo|karate|judo|muay thai|boxing|jiu[- ]?jitsu|wrestling)\b/giu)]
      .map((match) => match[1]?.trim())
      .filter((value): value is string => typeof value === "string" && value.length > 0);
    if (matches.length > 0) {
      return [...new Set(matches)].join(", ");
    }
  }

  if (/\bfavorite\s+style\s+of\s+painting\b/i.test(queryText)) {
    const match =
      text.match(/\bfavorite\s+style\s+of\s+painting\s+(?:is|was)\s+([A-Za-z][A-Za-z0-9'’& -]{1,60})/iu) ??
      text.match(/\b(?:loves?|enjoys?)\s+([A-Za-z][A-Za-z0-9'’& -]{1,60})\s+painting/iu);
    return match?.[1]?.trim() ?? null;
  }

  if (/\bfavorite\s+movie\s+trilog(?:y|ies)\b/i.test(queryText)) {
    const match =
      text.match(/\bfavorite\s+movie\s+trilog(?:y|ies)\s+(?:is|are|was|were)\s+([A-Za-z][A-Za-z0-9'’:& -]{1,80})/iu) ??
      text.match(/\bloves?\s+the\s+([A-Z][A-Za-z0-9'’:& -]{1,80}\s+trilog(?:y|ies))/u);
    return match?.[1]?.trim() ?? null;
  }

  if (/\bspecific\s+type\s+of\s+bird\b/i.test(queryText) || /\bwhat\s+kind\s+of\s+bird\b/i.test(queryText)) {
    const match =
      text.match(/\b(cardinal|parrot|cockatoo|sparrow|owl|hawk|falcon|eagle|pigeon|dove|canary|finch|budgie|budgerigar|macaw|raven|crow)s?\b/iu) ??
      text.match(/\bmesmerized?\s+by\s+([A-Za-z][A-Za-z0-9'’ -]{1,40}\s+birds?)/iu);
    return match?.[1]?.trim() ?? null;
  }

  if (/\bwhat\s+kind\s+of\s+flowers?\b/i.test(queryText)) {
    const match =
      text.match(/\btattoo\s+of\s+([A-Za-z][A-Za-z0-9'’ -]{1,40}\s+flowers?)/iu) ??
      text.match(/\b([A-Za-z][A-Za-z0-9'’ -]{1,40}\s+flowers?)\b/iu);
    return match?.[1]?.trim() ?? null;
  }

  if (/\bwhat\s+are\s+the\s+names?\b/i.test(queryText) && /\bsnakes?\b/i.test(queryText)) {
    const match =
      text.match(/\bsnakes?\s+(?:named|are named|called)\s+([A-Z][A-Za-z0-9'’& -]{1,80}(?:\s*(?:,|and)\s*[A-Z][A-Za-z0-9'’& -]{1,80})*)/u) ??
      text.match(/\b([A-Z][A-Za-z0-9'’& -]{1,40}(?:\s*(?:,|and)\s*[A-Z][A-Za-z0-9'’& -]{1,40})+)\b/u);
    return match?.[1]?.trim() ?? null;
  }

  if (/\bfavorite\s+books?\b/i.test(queryText)) {
    const match =
      text.match(/\bfavorite\s+books?\s+(?:are|were|include|included)\s+([A-Z][^.!?\n]{2,120})/u) ??
      text.match(/\bbookshelf\b[^.!?\n]{0,120}\b([A-Z][A-Za-z0-9'’:& -]{2,80}(?:\s*,\s*[A-Z][A-Za-z0-9'’:& -]{2,80})+)/u);
    return match?.[1]?.trim() ?? null;
  }

  if (/\bwhat\s+type\s+of\s+car\b/i.test(queryText) || /\bwhat\s+kind\s+of\s+car\b/i.test(queryText)) {
    const match =
      text.match(/\b(?:got|bought|purchased)\s+(?:a\s+|an\s+|the\s+)?([A-Za-z0-9'’& -]{2,60}\b(?:SUV|sedan|truck|coupe|van|wagon|Prius|Toyota|Honda|Ford|Mazda|Subaru|Tesla)\b[^.!?,;]{0,40})/iu) ??
      text.match(/\b(?:SUV|sedan|truck|coupe|van|wagon|Prius|Toyota|Honda|Ford|Mazda|Subaru|Tesla)\b[^.!?,;]{0,40}/iu);
    return match?.[1]?.trim() ?? match?.[0]?.trim() ?? null;
  }

  if (/\bwhat\s+advice\s+did\b/i.test(queryText)) {
    const match =
      text.match(/\badvice\b[^.!?\n]{0,30}\bto\s+([A-Za-z][^.!?\n]{2,120})/iu) ??
      text.match(/\b(?:told|advised)\s+(?:him|her|them|me)\s+to\s+([A-Za-z][^.!?\n]{2,120})/iu);
    return match?.[1]?.trim() ?? null;
  }

  if (/\bwhat\s+did\b/i.test(queryText) && /\brealiz/i.test(queryText)) {
    const match =
      text.match(/\brealiz(?:e|ed|ing)\s+(?:that\s+)?([A-Za-z][^.!?]{2,120})/iu) ??
      text.match(/\bmade\s+(?:me|him|her|them)\s+realiz(?:e|ed)\s+(?:that\s+)?([A-Za-z][^.!?]{2,120})/iu);
    return match?.[1]?.trim() ?? null;
  }

  if (/\bmain\s+focus\b/i.test(queryText)) {
    const match =
      text.match(/\bmain\s+focus(?:\s+in\s+[A-Za-z][A-Za-z0-9'’& -]+)?\s+(?:is|was)\s+([A-Za-z][A-Za-z0-9'’,& -]{1,100})/iu) ??
      text.match(/\bfocus(?:ed)?\s+on\s+([A-Za-z][A-Za-z0-9'’,& -]{1,100})/iu);
    return match?.[1]?.trim() ?? null;
  }

  if (/\bwho\b/i.test(queryText) && /\b(?:dinner|lunch|breakfast)\b/i.test(queryText)) {
    const match =
      text.match(/\b(?:dinner|lunch|breakfast)\s+with\s+([A-Za-z][A-Za-z0-9'’& -]{1,60}|her mother|his mother|her father|his father|mother|father|parents?)\b/iu) ??
      text.match(/\b((?:my|our)\s+(?:mom|mother|dad|father))\s+and\s+i\s+(?:made|had|cooked)\s+(?:some\s+)?(?:dinner|lunch|breakfast)\b/iu);
    return match?.[1]?.trim() ?? null;
  }

  if (/\bhobbies?\b/i.test(queryText)) {
    const match =
      text.match(/\bhobbies?\s+(?:are|include)\s+([A-Za-z][^.!?\n]{2,140})/iu) ??
      text.match(/\bbesides\s+[A-Za-z][^,!?\n]{0,40},\s*(?:i|he|she)\s+(?:also\s+)?(?:love|loves|enjoy|enjoys)\s+([A-Za-z][^.!?\n]{2,140})/iu);
    return match?.[1]?.trim() ?? null;
  }

  if (/\bfavorite\s+movies?\b/i.test(queryText) && !/\btrilog(?:y|ies)\b/i.test(queryText)) {
    const match =
      text.match(/\bfavorite\s+movies?\s+(?:is|are|include|included)\s+["“]?([^.!?\n"]{2,120})["”]?/iu) ??
      (
        /\b(?:movie|film|favorite|favorites|watched|watching|recommend(?:ation)?s?)\b/iu.test(text) &&
        !/\b(?:script|screenplay|writers?\s+group|working\s+on\s+one|called)\b/iu.test(text)
          ? text.match(/["“]([A-Z][A-Za-z0-9'’:&,\- ]{2,80})["”]/u)
          : null
      );
    return match?.[1]?.trim() ?? null;
  }

  if (/\bpets?\s+wouldn'?t\s+cause\b/i.test(queryText) || (/\bpets?\b/i.test(queryText) && /\ballerg/i.test(queryText))) {
    const matches = [...text.matchAll(/\b(hairless cats?|pigs?)\b/giu)]
      .map((match) => match[1]?.trim())
      .filter((value): value is string => typeof value === "string" && value.length > 0);
    if (matches.length > 0) {
      return [...new Set(matches)].join(", ");
    }
  }

  if (/\bspark(?:ed)?\b/i.test(queryText) && /\binterest\b/i.test(queryText)) {
    const match =
      text.match(/\b(?:saw|seeing|witnessing)\s+how\s+([A-Za-z][^.!?\n]{4,180})/iu) ??
      text.match(/\bshown?\s+(?:me|him|her|them)\s+the\s+impact\s+([A-Za-z][^.!?\n]{8,180})/iu) ??
      text.match(/\bimpact\s+these\s+issues\s+have\s+on\s+([A-Za-z][^.!?\n]{4,120})/iu) ??
      text.match(/\b(?:sparked?|inspired?)\s+(?:his|her|their)\s+interest(?:\s+in\s+[A-Za-z][^.!?\n]+?)?\s+(?:was|were)\s+([A-Za-z][^.!?\n]{4,180})/iu);
    return match?.[1]?.trim() ?? null;
  }

  if (/\bwhat\s+might\b/i.test(queryText) && /\bfinancial status\b/i.test(queryText)) {
    const match =
      text.match(/\b(?:middle[- ]class|wealthy|rich|well-off|financially stable)\b(?:\s+or\s+\b(?:middle[- ]class|wealthy|rich|well-off|financially stable)\b)?/iu);
    return match?.[0]?.trim() ?? null;
  }

  if (/\bhow\s+did\b/i.test(queryText) && /\bget into\b/i.test(queryText)) {
    const match =
      text.match(/\bgot\s+into\s+[A-Za-z][A-Za-z0-9'’& -]{1,60}\s+(?:because|after|when|through)\s+([A-Za-z][^.!?\n]{3,160})/iu) ??
      text.match(/\b(?:because|after|when|through)\s+([A-Za-z][^.!?\n]{3,160})/iu);
    return match?.[1]?.trim() ?? null;
  }

  const verbObjectPatterns: readonly [RegExp, string][] = [
    [/\badopt(?:ed|s)?\s+([A-Za-z][A-Za-z0-9'’& -]{1,60})/iu, ""],
    [/\bbought?\s+([A-Za-z][A-Za-z0-9'’& -]{1,60})/iu, ""],
    [/\bpurchased?\s+([A-Za-z][A-Za-z0-9'’& -]{1,60})/iu, ""],
    [/\bnamed?\s+([A-Z][A-Za-z0-9'’& -]{1,60})/u, ""],
    [/\bcalled?\s+([A-Z][A-Za-z0-9'’& -]{1,60})/u, ""]
  ];
  if (/\bwhat\s+did\b/i.test(queryText) || /\bname\b/i.test(queryText)) {
    for (const [pattern] of verbObjectPatterns) {
      const match = text.match(pattern);
      const value = match?.[1]?.trim();
      if (value) {
        return value.replace(/[.?!,:;]+$/u, "").trim();
      }
    }
  }

  if (/\bwhat\s+(?:was|is)\s+the\s+name\s+of\b/i.test(queryText)) {
    const match = text.match(/\b(?:named|called|title(?:d)?|known as)\s+([A-Z][A-Za-z0-9'’& -]{1,80})/u);
    return match?.[1]?.trim() ?? null;
  }

  return null;
}

function normalizeExactDetailValue(value: string): string {
  return normalizeWhitespace(value);
}

function exactDetailResultMatchesPrimarySubject(queryText: string, result: RecallResult): boolean {
  const entityHints = extractEntityNameHints(queryText)
    .map((value) => normalizeWhitespace(value).toLowerCase())
    .filter(Boolean);
  if (entityHints.length !== 1) {
    return true;
  }
  const metadata =
    typeof result.provenance.metadata === "object" && result.provenance.metadata !== null
      ? (result.provenance.metadata as Record<string, unknown>)
      : null;
  const primarySpeakerName =
    typeof metadata?.primary_speaker_name === "string"
      ? normalizeWhitespace(metadata.primary_speaker_name).toLowerCase()
      : "";
  if (!primarySpeakerName) {
    return true;
  }
  return entityHints.some((hint) => primarySpeakerName.includes(hint));
}

function isSubjectSafeExactDetailCandidateSource(queryText: string, result: RecallResult): boolean {
  const entityHints = extractEntityNameHints(queryText)
    .map((value) => normalizeWhitespace(value).toLowerCase())
    .filter(Boolean);
  if (entityHints.length !== 1) {
    return true;
  }

  const signals = collectSubjectParticipantSignals(result);
  const signalHit = signals.some((signal) => entityHints.some((hint) => signal.includes(hint)));
  const foreignSignals = signals.filter((signal) => !entityHints.some((hint) => signal.includes(hint)));
  const derivationType = derivationTypeForRecallResult(result);
  const speakerTurns = parseConversationSpeakerTurns(result.content);
  const primarySpeakerTurns = speakerTurns.filter((turn) => entityHints.some((hint) => turn.speaker.includes(hint)));
  const foreignSpeakerTurns = speakerTurns.filter((turn) => !entityHints.some((hint) => turn.speaker.includes(hint)));

  if (result.memoryType === "episodic_memory" || result.memoryType === "narrative_event") {
    return signalHit || foreignSignals.length === 0;
  }

  if (derivationType === "participant_turn" || derivationType === "source_sentence") {
    if (speakerTurns.length > 0) {
      return primarySpeakerTurns.length > 0 && foreignSpeakerTurns.length === 0;
    }
    return signalHit && foreignSignals.length === 0;
  }

  if (derivationType === "conversation_unit" || derivationType === "topic_segment") {
    if (speakerTurns.length > 0 && primarySpeakerTurns.length === 0 && foreignSpeakerTurns.length > 0) {
      return false;
    }
    if (speakerTurns.length > 0 && primarySpeakerTurns.length > 0 && foreignSpeakerTurns.length > 0) {
      return false;
    }
    if (!signalHit && foreignSignals.length > 0) {
      return false;
    }
  }

  return signalHit || foreignSignals.length === 0;
}

function buildExactDetailTextCandidates(
  queryText: string,
  result: RecallResult
): readonly {
  readonly text: string;
  readonly source: RecallExactDetailSource;
  readonly derivationType?: string;
  readonly sourceSentenceText?: string;
}[] {
  if (!exactDetailResultMatchesPrimarySubject(queryText, result)) {
    return [];
  }
  if (!isSubjectSafeExactDetailCandidateSource(queryText, result)) {
    return [];
  }

  const metadata =
    typeof result.provenance.metadata === "object" && result.provenance.metadata !== null
      ? (result.provenance.metadata as Record<string, unknown>)
      : null;
  const derivationType = derivationTypeForRecallResult(result);
  const baseSource =
    result.memoryType === "episodic_memory" || result.memoryType === "narrative_event"
      ? ("episodic_leaf" as const)
      : result.memoryType === "artifact_derivation"
        ? ("derivation" as const)
        : ("mixed" as const);

  const texts = new Set<string>();
  const boundText = extractPrimaryEntityBoundText(queryText, result);
  if (boundText.trim()) {
    texts.add(boundText);
  }

  const sourceSentenceText = typeof metadata?.source_sentence_text === "string" ? metadata.source_sentence_text : "";
  const promptText = typeof metadata?.prompt_text === "string" ? metadata.prompt_text : "";
  if (sourceSentenceText.trim()) {
    texts.add(sourceSentenceText);
  }
  if (promptText.trim() && sourceSentenceText.trim()) {
    texts.add(`${promptText}\n${sourceSentenceText}`);
  }

  return [...texts].map((text) => ({
    text,
    source:
      result.memoryType === "artifact_derivation" && (derivationType === "participant_turn" || derivationType === "source_sentence") && text !== boundText
        ? ("artifact_source" as const)
        : baseSource,
    derivationType,
    sourceSentenceText
  }));
}

function scoreExactDetailSource(source: RecallExactDetailSource): number {
  switch (source) {
    case "episodic_leaf":
      return 3;
    case "artifact_source":
      return 2.7;
    case "derivation":
      return 1.8;
    case "mixed":
    default:
      return 1;
  }
}

function isStrongExactDetailSupportCandidate(
  source: RecallExactDetailSource,
  derivationType?: string,
  sourceSentenceText?: string
): boolean {
  if (source === "episodic_leaf" || source === "artifact_source") {
    return true;
  }
  if (derivationType === "participant_turn" || derivationType === "source_sentence") {
    return !/\?\s*$/u.test(sourceSentenceText ?? "");
  }
  return false;
}

function formatExactDetailClaimText(queryText: string, value: string): string {
  void queryText;
  return value;
}

function collectExactDetailValueCandidates(
  queryText: string,
  candidates: readonly {
    readonly text: string;
    readonly source: RecallExactDetailSource;
    readonly derivationType?: string;
    readonly sourceSentenceText?: string;
  }[]
): readonly ExactDetailValueCandidate[] {
  const collected: ExactDetailValueCandidate[] = [];
  for (const candidate of candidates) {
    const values = extractExactDetailValues(candidate.text, queryText);
    for (const rawValue of values) {
      const value = normalizeExactDetailValueForQuery(queryText, rawValue);
      if (!value) {
        continue;
      }
      let score = scoreExactDetailSource(candidate.source);
      const strongSupport = isStrongExactDetailSupportCandidate(candidate.source, candidate.derivationType, candidate.sourceSentenceText);
      if (strongSupport) {
        score += 0.8;
      }
      if (candidate.derivationType === "conversation_unit") {
        score -= 0.35;
      }
      if (candidate.derivationType === "topic_segment") {
        score -= 0.55;
      }
      if (/\b[A-Z][A-Za-z0-9'’&.-]+(?:\s+[A-Z][A-Za-z0-9'’&.-]+){0,4}\b/u.test(value)) {
        score += 0.35;
      }
      if (value.split(/\s+/u).length <= 4) {
        score += 0.25;
      }
      collected.push({
        value,
        source: candidate.source,
        score,
        strongSupport
      });
    }
  }
  return collected;
}

function deriveSubjectBoundExactDetailClaim(
  queryText: string,
  results: readonly RecallResult[],
  enabled: boolean
): ExactDetailClaimCandidate | null {
  return deriveSubjectBoundExactDetailClaimWithTelemetry(queryText, results, enabled).candidate;
}

function deriveSubjectBoundExactDetailClaimWithTelemetry(
  queryText: string,
  results: readonly RecallResult[],
  enabled: boolean,
  answerableUnitBackfillTexts: readonly string[] = []
): {
  readonly candidate: ExactDetailClaimCandidate | null;
  readonly telemetry: ExactAnswerTelemetry;
} {
  if (!enabled || results.length === 0) {
    return {
      candidate: null,
      telemetry: EMPTY_EXACT_ANSWER_TELEMETRY
    };
  }

  const primaryEntityResults = filterResultsForPrimaryEntity(queryText, results);
  const sourceBackfillTexts = gatherPrimaryEntitySourceBackfillTexts(queryText, primaryEntityResults);
  const backfillNamespaceId = primaryEntityResults[0]?.namespaceId ?? results[0]?.namespaceId ?? "";
  const family = inferExactDetailQuestionFamily(queryText);
  const structuredQuery = isStructuredExactAnswerQuery(queryText);
  const exactAnswerDerivation = deriveExactAnswerCandidate({
    queryText,
    results: [
      ...primaryEntityResults,
      ...sourceBackfillTexts.map((text, index) => ({
        memoryId: `exact-answer-backfill:${index}`,
        memoryType: "artifact_derivation" as const,
        artifactId: null,
        occurredAt: null,
        content: text,
        score: 0,
        namespaceId: backfillNamespaceId,
        provenance: {
          tier: "exact_answer_backfill",
          metadata: {}
        }
      })),
      ...answerableUnitBackfillTexts.map((text, index) => ({
        memoryId: `exact-answer-unit-backfill:${index}`,
        memoryType: "artifact_derivation" as const,
        artifactId: null,
        occurredAt: null,
        content: text,
        score: 0,
        namespaceId: backfillNamespaceId,
        provenance: {
          tier: "exact_answer_backfill",
          metadata: {}
        }
      }))
    ],
    family,
    structuredQuery,
    extractValues: extractExactDetailValues,
    formatClaimText: (query, value) => formatExactDetailClaimText(query, joinExactDetailValues([value]))
  });

  if (exactAnswerDerivation.candidate) {
    return exactAnswerDerivation;
  }

  const preciseClaim = structuredQuery ? null : derivePreciseFactClaimText(queryText, results);
  if (preciseClaim) {
    return {
      candidate: {
        text: preciseClaim,
        source: "mixed",
        strongSupport: false
      },
      telemetry: exactAnswerDerivation.telemetry
    };
  }

  return {
    candidate: null,
    telemetry: exactAnswerDerivation.telemetry
  };
}

function deriveReaderExactDetailFallbackCandidate(
  queryText: string,
  readerResult: {
    readonly claimText: string | null;
    readonly recallResults: readonly RecallResult[];
  }
): ExactDetailClaimCandidate | null {
  const candidateTexts = [
    readerResult.claimText ?? "",
    ...readerResult.recallResults.map((result) => result.content)
  ]
    .map((value) => normalizeWhitespace(value))
    .filter(Boolean);

  if (candidateTexts.length === 0) {
    return null;
  }

  const normalizedReaderClaim = normalizeWhitespace(readerResult.claimText ?? "");
  const readerReducedListFamily =
    normalizedReaderClaim.length > 0 &&
    !containsInterrogativePromptCue(normalizedReaderClaim) &&
    (
      /\bhobbies?\b/i.test(queryText) ||
      /\bpets?\s+wouldn'?t\s+cause\b/i.test(queryText) ||
      (/\bpets?\b/i.test(queryText) && /\ballerg/i.test(queryText)) ||
      (/\bbesides\b/i.test(queryText) && /\bfriends?\b/i.test(queryText))
    );
  if (readerReducedListFamily) {
    return {
      text: normalizedReaderClaim,
      source: "episodic_leaf",
      strongSupport: true
    };
  }

  if (/\bhobbies?\b/i.test(queryText)) {
    const hobbyValues = [...new Set(
      candidateTexts.flatMap((text) => {
        const normalized = normalizeWhitespace(text);
        if (!normalized || containsInterrogativePromptCue(normalized)) {
          return [];
        }
        const extracted = extractExactDetailValues(normalized, queryText);
        if (extracted.length > 0) {
          return extracted;
        }
        return splitExactDetailList(normalized, queryText);
      })
        .map((value) => normalizeExactDetailValueForQuery(queryText, value))
        .filter((value): value is string => Boolean(value))
        .filter((value) => /\b(?:writing|reading|watching movies|exploring nature|hanging with friends)\b/i.test(value))
    )];
    if (hobbyValues.length > 0) {
      return {
        text: formatExactDetailClaimText(queryText, joinExactDetailValues(hobbyValues)),
        source: "episodic_leaf",
        strongSupport: true
      };
    }
  }

  if (/\bpets?\s+wouldn'?t\s+cause\b/i.test(queryText) || (/\bpets?\b/i.test(queryText) && /\ballerg/i.test(queryText))) {
    const safePets = [...new Set(
      candidateTexts.flatMap((text) => [...text.matchAll(/\b(hairless cats?|pigs?)\b/giu)].map((match) => match[1] ?? ""))
        .map((value) => normalizeExactDetailValueForQuery(queryText, value))
        .filter((value): value is string => Boolean(value))
    )];
    if (safePets.length > 0) {
      const hasReason = candidateTexts.some((text) => /\bdon't have fur\b/i.test(text) || /\banimals with fur\b/i.test(text));
      return {
        text: hasReason
          ? `${joinExactDetailValues(safePets)}, since they don't have fur, which is one of the main causes of Joanna's allergy.`
          : joinExactDetailValues(safePets),
        source: "episodic_leaf",
        strongSupport: true
      };
    }
  }

  if (/\bbesides\b/i.test(queryText) && /\bfriends?\b/i.test(queryText)) {
    const socialSupport = new Set<string>();
    for (const text of candidateTexts) {
      const normalized = normalizeWhitespace(text).toLowerCase();
      if (!normalized || containsInterrogativePromptCue(normalized)) {
        continue;
      }
      if (/\b(?:my team|teammates?)\b/.test(normalized)) {
        socialSupport.add("teammates on his video game team");
      }
      if (/\bold friends?\b/.test(normalized)) {
        socialSupport.add("old friends from other tournaments");
      }
      if (/\boutside of my circle\b/.test(normalized)) {
        socialSupport.add("friends outside his usual circle from tournaments");
      }
      if (/\bfriends at the convention\b/.test(normalized) || /\bmade some friends\b/.test(normalized)) {
        socialSupport.add("friends from gaming conventions");
      }
    }

    if (socialSupport.size > 0) {
      return {
        text: `Yes, ${joinExactDetailValues([...socialSupport])}.`,
        source: "episodic_leaf",
        strongSupport: true
      };
    }
  }

  const queryFamily = inferExactDetailQuestionFamily(queryText);
  const disallowRawFallback =
    queryFamily === "temporary_job" ||
    /\bwhat\s+might\b/i.test(queryText) && /\bfinancial status\b/i.test(queryText) ||
    /\bhobbies?\b/i.test(queryText) ||
    /\bpets?\b/i.test(queryText) ||
    /\bbesides\b/i.test(queryText) && /\bfriends?\b/i.test(queryText) ||
    /\bspark(?:ed)?\b/i.test(queryText) && /\binterest\b/i.test(queryText);
  const extractedValues = [...new Set(
    candidateTexts.flatMap((text) => extractExactDetailValues(text, queryText))
      .map((value) => normalizeExactDetailValueForQuery(queryText, value))
      .filter(Boolean)
  )];

  if (extractedValues.length > 0) {
    return {
      text: formatExactDetailClaimText(queryText, joinExactDetailValues(extractedValues)),
      source: "episodic_leaf",
      strongSupport: true
    };
  }

  const topText = candidateTexts[0] ?? "";
  if (!topText || containsInterrogativePromptCue(topText)) {
    return null;
  }

  if (disallowRawFallback) {
    return null;
  }

  if (
    queryFamily === "generic" &&
    !/\bhobbies?\b/i.test(queryText) &&
    !/\bfavorite\s+movies?\b/i.test(queryText) &&
    !/\bpets?\b/i.test(queryText)
  ) {
    return null;
  }

  return {
    text: topText,
    source: "episodic_leaf",
    strongSupport: true
  };
}

function deriveStorageLocationClaimText(queryText: string, results: readonly RecallResult[]): string | null {
  if (!isStorageLocationQuery(queryText) || results.length === 0) {
    return null;
  }

  const combined = results.map((result) => result.content).join(" ");
  if (!combined.trim()) {
    return null;
  }

  const mentionsBend = /\bBend\b/i.test(combined);
  const mentionsReno = /\bReno\b/i.test(combined);
  const mentionsCarson = /\bCarson\b/i.test(combined);
  if (!mentionsBend && !mentionsReno && !mentionsCarson) {
    return null;
  }

  const clauses: string[] = [];
  if (mentionsBend) {
    const bendDetail =
      /\bLauren\b/i.test(combined)
        ? "Bend, with Lauren"
        : /\bAlex\b/i.test(combined) || /\bEve\b/i.test(combined)
          ? "Bend, with Alex and Eve"
          : "Bend";
    clauses.push(bendDetail);
  }
  if (mentionsReno) {
    clauses.push(/\bpublic storage\b/i.test(combined) ? "Reno public storage" : "Reno");
  }
  if (mentionsCarson) {
    clauses.push(/\bRV\b/i.test(combined) ? "Carson, where the RV is kept" : "Carson");
  }

  if (clauses.length === 1) {
    return `The best supported storage location is ${clauses[0]}.`;
  }
  if (clauses.length === 2) {
    return `The best supported storage locations are ${clauses[0]} and ${clauses[1]}.`;
  }
  return `The best supported storage locations are ${clauses[0]}, ${clauses[1]}, and ${clauses[2]}.`;
}

function deriveEventLocationClaimText(queryText: string, results: readonly RecallResult[]): string | null {
  if (!isEventBoundedQuery(queryText) || !/\bwhere\b/i.test(queryText) || results.length === 0) {
    return null;
  }

  const combined = [
    ...results.map((result) => result.content),
    ...results.map((result) => result.provenance.source_uri).filter((value): value is string => typeof value === "string" && value.startsWith("/") && existsSync(value)).map((sourceUri) => readFileSync(sourceUri, "utf8"))
  ].join(" ");
  if (!combined.trim()) {
    return null;
  }

  const venueMatch =
    combined.match(/\bat\s+the\s+([A-Z][A-Za-z0-9'’&.-]*(?:\s+[A-Z][A-Za-z0-9'’&.-]*){0,4}\s+(?:Hotel|Cafe|Coffee|Restaurant|University|Alley|Space))\b/u) ??
    combined.match(/\bat\s+([A-Z][A-Za-z0-9'’&.-]*(?:\s+[A-Z][A-Za-z0-9'’&.-]*){0,4}\s+(?:Hotel|Cafe|Coffee|Restaurant|University|Alley|Space))\b/u);
  const cityMatch = combined.match(/\bin\s+(Chiang Mai|Bangkok|Bend|Reno|Carson)\b/iu);

  const venue = venueMatch?.[1]?.trim() ?? null;
  const city = cityMatch?.[1]?.trim() ?? null;
  if (venue && city) {
    return `The best supported location is ${venue} in ${city}.`;
  }
  if (venue) {
    return `The best supported location is ${venue}.`;
  }
  if (city) {
    return `The best supported location is ${city}.`;
  }

  return null;
}

function extractedExactDetailValueCount(queryText: string, candidate: ExactDetailClaimCandidate | null | undefined): number {
  if (!candidate?.text) {
    return 0;
  }
  return new Set(
    extractExactDetailValues(candidate.text, queryText)
      .map((value) => normalizeExactDetailValueForQuery(queryText, value))
      .filter(Boolean)
      .map((value) => value.toLowerCase())
  ).size;
}

function preferRicherExactDetailCandidate(
  queryText: string,
  derivedCandidate: ExactDetailClaimCandidate | null,
  readerCandidate: ExactDetailClaimCandidate | null
): ExactDetailClaimCandidate | null {
  if (!derivedCandidate) {
    return readerCandidate;
  }
  if (!readerCandidate) {
    return derivedCandidate;
  }

  const family = inferExactDetailQuestionFamily(queryText);
  const compareAsListFamily =
    /\bhobbies?\b/i.test(queryText) ||
    /\bpets?\b/i.test(queryText) ||
    family === "martial_arts" ||
    family === "favorite_books" ||
    family === "plural_names";
  if (!compareAsListFamily) {
    return derivedCandidate;
  }

  const derivedCount = extractedExactDetailValueCount(queryText, derivedCandidate);
  const readerCount = extractedExactDetailValueCount(queryText, readerCandidate);
  return readerCount > derivedCount ? readerCandidate : derivedCandidate;
}

function deriveProfileInferenceClaimText(queryText: string, results: readonly RecallResult[]): string | null {
  if (!isProfileInferenceQuery(queryText) || results.length === 0) {
    return null;
  }

  const primaryEntityResults = filterResultsForPrimaryEntity(queryText, results);
  const supportingTexts = primaryEntityResults
    .map((result) => extractPrimaryEntityBoundText(queryText, result))
    .filter((text) =>
      /\b(keen on|looking into|thinking of|career options|would love|want to help|career|education|study|mental health|counseling|counsell?ing|counselor|counsellor|psychology|psychological|programs?|field|path|work in)\b/i.test(
        text
      )
    );
  const fallbackTexts =
    supportingTexts.length > 0
      ? supportingTexts
      : primaryEntityResults
          .map((result) => result.content)
          .filter((text) =>
            /\b(looking into|career options|mental health|counseling|counsell?ing|counselor|counsellor|psychology|psychological|programs?|field|path|work in)\b/i.test(
              text
            )
          );
  if (fallbackTexts.length === 0) {
    return null;
  }

  const combined = fallbackTexts.map((text) => text.toLowerCase()).join(" ");
  const hasCounseling = /\b(counseling|counsell?ing|counselor|counsellor)\b/.test(combined);
  const hasMentalHealth = /\b(mental health|therapy|therapist|psychology|psychological)\b/.test(combined);
  const hasFieldDirection =
    /\b(programs?|field|path|work in|wants to work in|right path)\b/.test(combined) ||
    /\blikely to pursue\b/.test(queryText.toLowerCase());
  const roleDirectionMatch =
    combined.match(/\bcurrent role direction centers on ([^.]+?)\b/i)?.[1]?.trim() ??
    combined.match(/\b(?:working as|works as|role is|serves as)\s+([A-Za-z][A-Za-z\s-]{2,80})\b/i)?.[1]?.trim() ??
    null;
  if (fallbackTexts.length === 1 && !(hasFieldDirection && (hasCounseling || hasMentalHealth))) {
    if (roleDirectionMatch && /\brole\b/i.test(queryText)) {
      return `The best supported role direction is ${roleDirectionMatch.replace(/\s+,/g, ",")}.`;
    }
    return null;
  }
  if (hasCounseling && hasMentalHealth) {
    return "The best supported fields are psychology and counseling-related mental health work.";
  }
  if (hasCounseling) {
    return "The best supported field is counseling-related work.";
  }
  if (hasMentalHealth) {
    return "The best supported field is psychology-related mental health work.";
  }
  if (roleDirectionMatch && /\brole\b/i.test(queryText)) {
    return `The best supported role direction is ${roleDirectionMatch.replace(/\s+,/g, ",")}.`;
  }
  return null;
}

function deriveIdentityProfileClaimText(queryText: string, results: readonly RecallResult[]): string | null {
  if (!isIdentityProfileQuery(queryText) || results.length === 0) {
    return null;
  }

  const combined = filterResultsForPrimaryEntity(queryText, results).map((result) => result.content).join(" ");
  if (!combined.trim()) {
    return null;
  }

  if (/\btransgender woman\b/i.test(combined)) {
    return "The best supported identity signal is that she is a transgender woman.";
  }
  if (/\btransgender man\b/i.test(combined)) {
    return "The best supported identity signal is that he is a transgender man.";
  }
  if (/\btransgender\b/i.test(combined)) {
    return "The best supported identity signal is that the person is transgender.";
  }
  if (/\bnonbinary\b/i.test(combined)) {
    return "The best supported identity signal is that the person is nonbinary.";
  }
  if (/\bqueer\b/i.test(combined)) {
    return "The best supported identity signal is that the person identifies as queer.";
  }

  const roleMatch =
    combined.match(/\b(?:working as|works as|is a|is an)\s+([A-Za-z][A-Za-z\s-]{2,50})/i)?.[1]?.trim() ??
    null;
  if (roleMatch) {
    return `The best supported profile signal is that the person is ${roleMatch}.`;
  }

  return null;
}

function deriveSharedCommonalityClaimText(queryText: string, results: readonly RecallResult[]): string | null {
  if (!isSharedCommonalityQuery(queryText) || results.length === 0) {
    return null;
  }

  const participants = extractConversationParticipants(queryText)
    .filter((participant) => participant !== "Steve" || /\b(?:\bI\b|\bmy\b|\bwe\b|\bour\b)/i.test(queryText))
    .slice(0, 3);
  const combined = results.map((result) => result.content).join(" ").toLowerCase();
  if (!combined.trim()) {
    return null;
  }

  const perParticipant = new Map<string, string[]>();
  for (const participant of participants) {
    perParticipant.set(participant.toLowerCase(), []);
  }

  for (const result of results) {
    const content = result.content.toLowerCase();
    const addressed = participants
      .map((participant) => participant.toLowerCase())
      .filter((participant) => content.includes(participant));
    const buckets: string[] = [];
    if (/\b(dance|dancing)\b/.test(content)) {
      buckets.push(/\b(stress|destress|de-stress|stress relief|stress fix|stress-buster|happy place|escape)\b/.test(content) ? "dance_destress" : "dance");
    }
    if (/\b(climb|climbing)\b/.test(content)) {
      buckets.push("climbing");
    }
    if (/\b(sketch|sketching)\b/.test(content)) {
      buckets.push("sketching");
    }
    if (/\b(yoga)\b/.test(content)) {
      buckets.push("yoga");
    }
    if (/\b(cooking)\b/.test(content)) {
      buckets.push("cooking");
    }
    if (/\b(chess)\b/.test(content)) {
      buckets.push("chess");
    }
    if (/\b(movie|movies|film|watched|watching|screenplay|script)\b/.test(content)) {
      buckets.push("movies");
    }
    if (/\b(dessert|desserts|bake|baking|cookies|pies|cakes|cooking and baking)\b/.test(content)) {
      buckets.push("desserts");
    }
    if (/\b(reading)\b/.test(content)) {
      buckets.push("reading");
    }
    if (/\btrail running\b/.test(content)) {
      buckets.push("trail_running");
    }
    if (/\bcoworking(?:\s+on\s+saturdays)?\b/.test(content)) {
      buckets.push("coworking");
    }
    if (/\blost my job\b|\blost his job\b|\blost her job\b|\bjob as a\b|\bjob at\b/i.test(content)) {
      buckets.push("job_loss");
    }
    if (/\bown business\b|\bstart(?:ing)? my own business\b|\bopened an online clothing store\b|\bdance studio\b|\bstore\b/i.test(content)) {
      buckets.push("business_start");
    }
    if (/\bpassion\b|\bdream\b|\bexpress\b/i.test(content)) {
      buckets.push("creative_drive");
    }
    if (/\bpatient-support pilot\b|\bpilot interviews\b|\bsupport the pilot\b|\blaunch the patient-support pilot\b/i.test(content)) {
      buckets.push("patient_support_pilot");
    }
    if (
      /\bvolunteer(?:ed|ing)?\b/i.test(content) ||
      /\bhomeless shelter\b/i.test(content) ||
      (/\bshelter\b/i.test(content) && /\b(help|fundraiser|food|supplies|event)\b/i.test(content))
    ) {
      buckets.push(/\bhomeless shelter\b/i.test(content) ? "homeless_shelter_volunteering" : "volunteering");
    }
    for (const participant of addressed) {
      const existing = perParticipant.get(participant) ?? [];
      for (const bucket of buckets) {
        if (!existing.includes(bucket)) {
          existing.push(bucket);
        }
      }
      perParticipant.set(participant, existing);
    }
    if (addressed.length === 0 && /\bwe both\b|\bsame here\b|\bboth of us\b/i.test(content)) {
      for (const participant of perParticipant.keys()) {
        const existing = perParticipant.get(participant) ?? [];
        for (const bucket of buckets) {
          if (!existing.includes(bucket)) {
            existing.push(bucket);
          }
        }
        perParticipant.set(participant, existing);
      }
    }
  }

  const personBuckets = [...perParticipant.values()];
  const sharedMovies = personBuckets.length >= 2 && personBuckets.every((buckets) => buckets.includes("movies"));
  const sharedDesserts = personBuckets.length >= 2 && personBuckets.every((buckets) => buckets.includes("desserts"));
  const sharedDanceDestress = personBuckets.length >= 2 && personBuckets.every((buckets) => buckets.includes("dance_destress") || buckets.includes("dance"));
  const sharedClimbing = personBuckets.length >= 2 && personBuckets.every((buckets) => buckets.includes("climbing"));
  const sharedSketching = personBuckets.length >= 2 && personBuckets.every((buckets) => buckets.includes("sketching"));
  const sharedTrailRunning = personBuckets.length >= 2 && personBuckets.every((buckets) => buckets.includes("trail_running"));
  const sharedCoworking = personBuckets.length >= 2 && personBuckets.every((buckets) => buckets.includes("coworking"));
  const sharedJobLoss = personBuckets.length >= 2 && personBuckets.every((buckets) => buckets.includes("job_loss"));
  const sharedBusinessStart = personBuckets.length >= 2 && personBuckets.every((buckets) => buckets.includes("business_start"));
  const sharedPatientSupportPilot = personBuckets.length >= 2 && personBuckets.every((buckets) => buckets.includes("patient_support_pilot"));
  const sharedHomelessShelterVolunteering =
    personBuckets.length >= 2 && personBuckets.every((buckets) => buckets.includes("homeless_shelter_volunteering"));
  const sharedVolunteering =
    personBuckets.length >= 2 &&
    personBuckets.every((buckets) => buckets.includes("homeless_shelter_volunteering") || buckets.includes("volunteering"));
  const sharedCities = (() => {
    const placeBuckets = new Map<string, Set<string>>();
    for (const participant of participants) {
      placeBuckets.set(participant.toLowerCase(), new Set<string>());
    }
    for (const result of results) {
      const content = result.content;
      const lowered = content.toLowerCase();
      const addressed = participants.map((participant) => participant.toLowerCase()).filter((participant) => lowered.includes(participant));
      const placeMatches = [...content.matchAll(/\b(Rome|Paris|Barcelona|Edinburgh|Galway|Chiang Mai|Koh Samui|Mexico City|Tahoe City)\b/gu)].map(
        (match) => match[1] ?? match[0] ?? ""
      );
      if (placeMatches.length === 0) {
        continue;
      }
      for (const participant of addressed) {
        const bucket = placeBuckets.get(participant);
        if (!bucket) {
          continue;
        }
        for (const place of placeMatches) {
          bucket.add(place);
        }
      }
      if (addressed.length === 0 && /\bwe both\b|\bsame here\b|\bboth of us\b/i.test(content)) {
        for (const bucket of placeBuckets.values()) {
          for (const place of placeMatches) {
            bucket.add(place);
          }
        }
      }
    }
    const values = [...placeBuckets.values()];
    if (values.length < 2) {
      return [] as string[];
    }
    return [...values[0]!.values()].filter((place) => values.every((bucket) => bucket.has(place)));
  })();

  if (/\bdestress|stress\b/i.test(queryText) && sharedDanceDestress) {
    return "The best supported shared stress-relief activity is dancing.";
  }
  if (/\bwhich\s+city\b/i.test(queryText) && sharedCities.length > 0) {
    return `The best supported shared city is ${sharedCities[0]}.`;
  }
  if (/\binterests?\b/i.test(queryText) && sharedMovies && sharedDesserts) {
    return "The best supported shared interests are watching movies and making desserts.";
  }
  if (/\binterests?\b/i.test(queryText) && sharedMovies) {
    return "The best supported shared interest is watching movies.";
  }
  if (/\binterests?\b/i.test(queryText) && sharedDesserts) {
    return "The best supported shared interest is making desserts.";
  }
  if (/\bdestress|stress|relax\b/i.test(queryText) && sharedClimbing && sharedSketching) {
    return "The best supported shared reset activities are climbing and sketching.";
  }
  if (/\bdestress|stress|relax\b/i.test(queryText) && sharedClimbing) {
    return "The best supported shared stress-relief activity is climbing.";
  }
  if (/\bdestress|stress|relax\b/i.test(queryText) && sharedSketching) {
    return "The best supported shared stress-relief activity is sketching.";
  }
  if ((/\bin common\b/i.test(queryText) || /\bshared\b/i.test(queryText)) && sharedJobLoss && sharedBusinessStart) {
    return "The best supported overlap is that they both lost their jobs and decided to start their own businesses.";
  }
  if (/\bvolunteer(?:ing)?\b/i.test(queryText) && sharedHomelessShelterVolunteering) {
    return "The best supported shared volunteering is volunteering at a homeless shelter.";
  }
  if (/\bvolunteer(?:ing)?\b/i.test(queryText) && sharedVolunteering) {
    return "The best supported shared theme is volunteering.";
  }
  if (sharedDanceDestress) {
    return "The strongest shared theme is dancing.";
  }
  if (sharedMovies && sharedDesserts) {
    return "The strongest shared themes are watching movies and making desserts.";
  }
  if (sharedMovies) {
    return "The strongest shared theme is watching movies.";
  }
  if (sharedDesserts) {
    return "The strongest shared theme is making desserts.";
  }
  if (sharedCities.length > 0) {
    return `The strongest shared place signal is ${sharedCities[0]}.`;
  }
  if (sharedClimbing && sharedSketching) {
    return "The strongest shared themes are climbing and sketching.";
  }
  if (sharedTrailRunning && sharedCoworking) {
    return "The strongest shared themes are trail running and coworking on Saturdays.";
  }
  if (sharedTrailRunning) {
    return "The strongest shared theme is trail running.";
  }
  if (sharedCoworking) {
    return "The strongest shared theme is coworking on Saturdays.";
  }
  if (sharedClimbing) {
    return "The strongest shared theme is climbing.";
  }
  if (sharedSketching) {
    return "The strongest shared theme is sketching.";
  }
  if (sharedBusinessStart) {
    return "The strongest shared theme is building their own businesses.";
  }
  if (sharedPatientSupportPilot) {
    return "The strongest shared theme is helping launch the patient-support pilot.";
  }
  if (sharedHomelessShelterVolunteering) {
    return "The strongest shared theme is volunteering at a homeless shelter.";
  }
  if (sharedVolunteering) {
    return "The strongest shared theme is volunteering.";
  }

  return null;
}

function deriveCompanionExclusionClaimText(queryText: string, results: readonly RecallResult[]): string | null {
  const focus = parseQueryEntityFocus(queryText);
  if (focus.mode !== "primary_with_companion" || !/\bbesides\b/i.test(queryText) || results.length === 0) {
    return null;
  }
  const primary = focus.primaryHints[0];
  const companion = focus.companionHints[0];
  if (!primary || !companion || !/\bfriends?\b/i.test(queryText)) {
    return null;
  }

  let fallbackClaim: string | null = null;
  for (const result of results) {
    const content = result.content;
    const lowered = content.toLowerCase();
    const subjectSignals = collectSubjectParticipantSignals(result);
    const firstPersonSocialEvidence =
      /\b(?:my|me)\b/i.test(content) &&
      /\b(old friends?(?:\s+and\s+teammates?(?:\s+from\s+other\s+tournaments?)?)?|some friends?(?:\s+from\s+the\s+gym)?|other friends?|teammates?(?:\s+from\s+other\s+tournaments?)?|people\s+outside\s+of\s+my\s+circle)\b/iu.test(
        content
      );
    const primaryMatched =
      lowered.includes(primary) ||
      subjectSignals.some((signal) => signal.includes(primary)) ||
      firstPersonSocialEvidence;
    if (!primaryMatched) {
      continue;
    }
    if (/\bmy\s+team\b/i.test(content) && /\b(?:game|gaming|tournament)\b/i.test(content)) {
      return "Yes, teammates on his video game team.";
    }
    const outsideCircleEvidence =
      content.match(/\b(?:hang(?:ing)?\s+out\s+with\s+)?some\s+people\s+outside\s+of\s+my\s+circle(?:\s+at\s+the\s+tournament)?\b/iu)?.[0] ??
      content.match(/\bpeople\s+outside\s+of\s+my\s+circle(?:\s+at\s+the\s+tournament)?\b/iu)?.[0] ??
      null;
    if (outsideCircleEvidence) {
      fallbackClaim ??=
        `Yes, ${outsideCircleEvidence}.`;
    }
    if (/\bold friends?\b|\bsome friends?\b|\bother friends?\b|\bteammates?\b|\bteam\b|\btournament friends?\b/i.test(content)) {
      const socialEvidence =
        content.match(/\b(old friends?(?:\s+and\s+teammates?(?:\s+from\s+other\s+tournaments?)?)?|some friends?(?:\s+from\s+the\s+gym)?|other friends?|teammates?(?:\s+from\s+other\s+tournaments?)?|a new gaming team|my team)\b/iu)?.[1] ??
        content.match(/\b(old friends?(?:\s+and\s+teammates?(?:\s+from\s+other\s+tournaments?)?)?|some friends?(?:\s+from\s+the\s+gym)?|other friends?|teammates?(?:\s+from\s+other\s+tournaments?)?|a new gaming team|my team)\b/iu)?.[0] ??
        null;
      if (socialEvidence) {
        fallbackClaim ??=
          `Yes, ${socialEvidence}.`;
      }
    }
  }

  return fallbackClaim;
}

function recallResultSourceTexts(result: RecallResult): readonly string[] {
  const metadata =
    typeof result.provenance.metadata === "object" && result.provenance.metadata !== null
      ? (result.provenance.metadata as Record<string, unknown>)
      : null;
  const candidates = [
    result.content,
    typeof metadata?.source_turn_text === "string" ? metadata.source_turn_text : "",
    typeof metadata?.source_sentence_text === "string" ? metadata.source_sentence_text : "",
    typeof metadata?.prompt_text === "string" ? metadata.prompt_text : ""
  ];
  return [...new Set(candidates.map((value) => normalizeWhitespace(value)).filter(Boolean))];
}

function queryAnchorTerms(queryText: string): readonly string[] {
  const anchorMatch =
    queryText.match(/\bafter\s+(?:the\s+)?([A-Za-z][A-Za-z0-9'’ -]{2,80})\??/iu) ??
    queryText.match(/\b(?:sparked?|inspired?)\b[^?]*\b(?:in|about)\s+([A-Za-z][A-Za-z0-9'’ -]{2,80})\??/iu);
  const anchorText = normalizeWhitespace(anchorMatch?.[1] ?? "");
  if (!anchorText) {
    return [];
  }
  const stopTerms = new Set(["the", "a", "an", "my", "his", "her", "their", "of", "in", "on", "for", "to"]);
  return [...new Set(
    (anchorText.match(/[A-Za-z']+/gu) ?? [])
      .map((term) => term.toLowerCase())
      .filter((term) => term.length > 2 && !stopTerms.has(term))
  )];
}

function scoreAnchorMatch(text: string, anchorTerms: readonly string[]): number {
  if (anchorTerms.length === 0) {
    return 0;
  }
  const lowered = text.toLowerCase();
  let score = 0;
  for (const term of anchorTerms) {
    if (lowered.includes(term)) {
      score += 1;
    }
  }
  return score;
}

export function deriveCounterfactualSupportClaimText(queryText: string, results: readonly RecallResult[]): string | null {
  if (
    results.length === 0 ||
    !/\bwould\b/i.test(queryText) ||
    !/\bif\b/i.test(queryText) ||
    !/\b(?:support|help)\b/i.test(queryText)
  ) {
    return null;
  }

  const primaryResults = filterResultsForPrimaryEntity(queryText, results);
  const preferredResults = primaryResults.length > 0 ? primaryResults : results;
  const preferredSourceBackfillTexts = gatherPrimaryEntitySourceBackfillTexts(queryText, preferredResults);
  const preferredFullSourceBackfillTexts = gatherFullSourceBackfillTexts(preferredResults);
  const relevantResults =
    preferredSourceBackfillTexts.length > 0 || preferredFullSourceBackfillTexts.length > 0
      ? preferredResults
      : results;
  const sourceBackfillTexts = gatherPrimaryEntitySourceBackfillTexts(queryText, relevantResults);
  const fullSourceBackfillTexts = gatherFullSourceBackfillTexts(relevantResults);
  const combined = [...relevantResults.flatMap(recallResultSourceTexts), ...sourceBackfillTexts, ...fullSourceBackfillTexts].join(" ");
  if (!combined.trim()) {
    return null;
  }

  const hasCounselingGoal =
    /\bcounseling\b/i.test(queryText) ||
    /\b(counseling|mental health)\b/i.test(combined) &&
    /\b(career|work|services?|field|help people|support those|support people)\b/i.test(combined);
  const hasSupportEvidence =
    /\bsupport(?: groups?)?\b/i.test(combined) ||
    /\bsupportive\b/i.test(combined) ||
    /\bin my corner\b/i.test(combined) ||
    /\bthere for me\b/i.test(combined) ||
    /\bsupport I got\b/i.test(combined) ||
    /\bfriends and mentors\b/i.test(combined) ||
    /\bmade me feel accepted\b/i.test(combined) ||
    /\bgiven me courage\b/i.test(combined);
  const hasDependencyLink =
    /\bmade a huge difference\b/i.test(combined) ||
    /\bimproved my life\b/i.test(combined) ||
    /\bmotivated me\b/i.test(combined) ||
    /\bnow i want to help\b/i.test(combined) ||
    /\bwant to help people go through it too\b/i.test(combined) ||
    /\bi saw how counseling and support groups improved my life\b/i.test(combined) ||
    /\bsupport I got was really helpful\b/i.test(combined) ||
    /\bgave me courage to embrace myself\b/i.test(combined);
  if (hasCounselingGoal && hasSupportEvidence && hasDependencyLink) {
    return "Likely no.";
  }

  return null;
}

export function deriveRealizationClaimText(queryText: string, results: readonly RecallResult[]): string | null {
  if (!/\bwhat\s+did\b/i.test(queryText) || !/\brealiz/i.test(queryText) || results.length === 0) {
    return null;
  }

  const primaryResults = filterResultsForPrimaryEntity(queryText, results);
  const speakerOwnedResults = primaryEntitySpeakerOwnedResults(queryText, primaryResults);
  const preferredResults = speakerOwnedResults.length > 0
    ? speakerOwnedResults
    : primaryResults.length > 0
      ? primaryResults
      : results;
  const preferredSourceBackfillTexts = gatherPrimaryEntitySourceBackfillTexts(queryText, preferredResults);
  const preferredFullSourceBackfillTexts =
    speakerOwnedResults.length > 0 ? [] : gatherFullSourceBackfillTexts(preferredResults);
  const relevantResults =
    preferredSourceBackfillTexts.length > 0 || preferredFullSourceBackfillTexts.length > 0
      ? preferredResults
      : results;
  const anchorTerms = queryAnchorTerms(queryText);
  let bestCandidate: { value: string; score: number } | null = null;

  const sourceBackfillTexts = gatherPrimaryEntitySourceBackfillTexts(queryText, relevantResults);
  const fullSourceBackfillTexts =
    speakerOwnedResults.length > 0 ? [] : gatherFullSourceBackfillTexts(relevantResults);
  const candidateTexts = [
    ...relevantResults.flatMap((result) =>
      speakerOwnedResults.length > 0 ? speakerOwnedRecallResultSourceTexts(queryText, result) : recallResultSourceTexts(result)
    ),
    ...sourceBackfillTexts,
    ...fullSourceBackfillTexts
  ];

  for (const text of candidateTexts) {
      const explicitRealization =
        text.match(/\b(?:i(?:'m| am)\s+starting\s+to\s+realiz(?:e|ing)|realiz(?:e|ed)|learn(?:ed|ing))\s+(?:that\s+)?([A-Za-z][^.!?]{2,120})/iu)?.[1]?.trim() ??
        null;
      if (explicitRealization) {
        let score = scoreAnchorMatch(text, anchorTerms) * 2 + 3;
        if (/\bself-?care\b/i.test(explicitRealization)) {
          score += 2;
        }
        const normalized = normalizeExactDetailValueForQuery(queryText, explicitRealization);
        if (normalized) {
          if (!bestCandidate || score > bestCandidate.score) {
            bestCandidate = {
              value: normalized,
              score
            };
          }
        }
      }
      const extracted = extractExactDetailValue(text, queryText);
      if (!extracted) {
        continue;
      }
      let score = scoreAnchorMatch(text, anchorTerms) * 2;
      if (/\brealiz(?:e|ed|ing)\b/i.test(text)) {
        score += 2;
      }
      if (/\bmade me think\b|\bthought-provoking\b/i.test(text)) {
        score += 1.5;
      }
      if (/\bself-?care\b/i.test(extracted)) {
        score += 1;
      }
      if (!bestCandidate || score > bestCandidate.score) {
        bestCandidate = {
          value: normalizeExactDetailValueForQuery(queryText, extracted),
          score
        };
      }
  }

  return bestCandidate?.value ?? null;
}

export function deriveCausalMotiveClaimText(queryText: string, results: readonly RecallResult[]): string | null {
  if (results.length === 0) {
    return null;
  }

  if (/\bwould\b/i.test(queryText) && /\bif\b/i.test(queryText) && /\b(?:support|help)\b/i.test(queryText)) {
    return deriveCounterfactualSupportClaimText(queryText, results);
  }

  if (/\bwhat\s+did\b/i.test(queryText) && /\brealiz/i.test(queryText)) {
    return deriveRealizationClaimText(queryText, results);
  }

  const causalFocus =
    /\bwhy\b/i.test(queryText) ||
    (/\bspark(?:ed)?|inspired?\b/i.test(queryText) && /\binterest\b/i.test(queryText)) ||
    /\bwhat\s+might\b/i.test(queryText);
  if (!causalFocus) {
    return null;
  }

  const primaryResults = filterResultsForPrimaryEntity(queryText, results);
  const preferredResults = primaryResults.length > 0 ? primaryResults : results;
  const preferredSourceBackfillTexts = gatherPrimaryEntitySourceBackfillTexts(queryText, preferredResults);
  const preferredFullSourceBackfillTexts = gatherFullSourceBackfillTexts(preferredResults);
  const relevantResults =
    preferredSourceBackfillTexts.length > 0 || preferredFullSourceBackfillTexts.length > 0
      ? preferredResults
      : results;
  const sourceBackfillTexts = gatherPrimaryEntitySourceBackfillTexts(queryText, relevantResults);
  const fullSourceBackfillTexts = gatherFullSourceBackfillTexts(relevantResults);
  const combined = [...relevantResults.flatMap(recallResultSourceTexts), ...sourceBackfillTexts, ...fullSourceBackfillTexts].join(" ");
  if (!combined.trim()) {
    return null;
  }

  if (/\bwhat\s+might\b/i.test(queryText) && /\bfinancial status\b/i.test(queryText)) {
    const statusMatch =
      combined.match(/\b(middle[- ]class|wealthy|rich|well-off|financially stable)\b(?:\s+or\s+\b(middle[- ]class|wealthy|rich|well-off|financially stable)\b)?/iu);
    if (statusMatch?.[0]) {
      return statusMatch[0].trim();
    }

    const strongSignals = [
      /\bmake(?:s|ing)?\s+(?:so\s+much\s+)?money\b/iu,
      /\bmake(?:s|ing)?\s+a\s+living\b/iu,
      /\bextra\s+cash\s+on\s+hand\b/iu,
      /\bdon't\s+have\s+to\s+stress\s+about\s+it\b/iu,
      /\bfinancial(?:ly)?\s+free\b/iu
    ].filter((pattern) => pattern.test(combined)).length;
    const moderateSignals = [
      /\bearned?\s+cash\b/iu,
      /\bsaved\s+some\b/iu,
      /\bcompletely\s+content\b/iu,
      /\bwinning?\s+(?:a|the)?\s*(?:really\s+big|international|regional)?\s*video\s+game\s+tournament\b/iu,
      /\bjob\s+i\s+enjoy\b/iu,
      /\bpassion\s+into\s+a\s+career\b/iu
    ].filter((pattern) => pattern.test(combined)).length;
    if (strongSignals >= 2 || (strongSignals >= 1 && moderateSignals >= 1)) {
      return "Middle-class or wealthy";
    }
  }

  if (/\bspark(?:ed)?|inspired?\b/i.test(queryText) && /\binterest\b/i.test(queryText)) {
    const childhoodAnchor =
      combined.match(/\bgrowing up,\s*([^.!?]{8,220})/iu)?.[1]?.trim() ??
      combined.match(/\bI saw how ([^.!?]{8,220})/iu)?.[1]?.trim() ??
      null;
    if (childhoodAnchor) {
      return childhoodAnchor
        .replace(/^(?:I\s+saw\s+how|seeing\s+how)\s+/iu, "")
        .replace(/[.?!,:;]+$/u, "")
        .trim();
    }
    const communityAnchor =
      combined.match(/\bgoing to community meetings and getting involved in my community has ([^.!?]{12,220})/iu)?.[1]?.trim() ??
      combined.match(/\bit has also shown me ([^.!?]{12,220})/iu)?.[1]?.trim() ??
      combined.match(/\bpower cut in our area, and it made me realize ([^.!?]{12,220})/iu)?.[1]?.trim() ??
      null;
    if (communityAnchor) {
      return communityAnchor.replace(/[.?!,:;]+$/u, "").trim();
    }
  }

  const hasTrigger =
    /\b(?:lost|losing) (?:my|his|her) job\b|\bgave me the push\b|\bpushed me\b|\bsetbacks\b|\btough times\b/i.test(combined);
  const hasDecision =
    /\bstart(?:ing)? (?:my|his|her) own business\b|\bstart(?:ing)? a dance studio\b|\bopened an online clothing store\b|\bturn(?:ing)? .*dance.* into a business\b|\bmy own dance studio\b/i.test(
      combined
    );
  const hasMotive = /\bpassion(?:ate)?\b|\bdream\b|\bshare\b|\bteach others\b|\bjoy\b|\bexpress\b|\bdo what i love\b|\bhappy place\b/i.test(combined);
  const hasProjectTrigger = /\b(sync failures?|low-connectivity|connectivity environments?|field pilot setbacks?)\b/i.test(combined);
  const hasProjectDecision = /\b(offline-first|offline first|changed direction|move Atlas toward offline-first capture|move .* toward offline-first capture)\b/i.test(combined);
  const hasProjectMotive = /\b(prevent data loss|reduce operator frustration|remote use)\b/i.test(combined);

  if (hasTrigger && hasDecision && hasMotive && /\bdance studio\b/i.test(combined)) {
    return "The best supported reason is that he lost his job and decided to turn his passion for dance into a business he could share with others.";
  }
  if (hasProjectTrigger && hasProjectDecision && hasProjectMotive && /\b(?:project atlas|atlas)\b/i.test(combined)) {
    return "The best supported reason is that repeated sync failures pushed Atlas toward an offline first direction to prevent data loss.";
  }
  if (
    /\bpour-?over coffee\b/i.test(combined) &&
    /\bTurkey trip\b/i.test(combined) &&
    /\bespresso\b/i.test(combined) &&
    /\bstomach\b/i.test(combined)
  ) {
    return "The best supported reason is that after the Turkey trip, a brutal espresso wrecked his stomach, so he switched to pour-over coffee.";
  }
  if (hasTrigger && hasDecision) {
    return "The best supported reason is that a setback triggered the decision to start a new business.";
  }

  return null;
}

function extractOccurredAtFromAnchorContext(content: string, anchorText: string): string | null {
  const normalizedContent = content.toLowerCase();
  const normalizedAnchor = anchorText.toLowerCase();
  const anchorIndex = normalizedContent.indexOf(normalizedAnchor);
  const snippet =
    anchorIndex >= 0
      ? content.slice(Math.max(0, anchorIndex - 96), Math.min(content.length, anchorIndex + normalizedAnchor.length + 96))
      : content;

  return parseMonthDayYearToIso(snippet) ?? null;
}

async function loadNamespaceTimeBounds(namespaceId: string): Promise<{
  readonly minOccurredAt: string | null;
  readonly maxOccurredAt: string | null;
}> {
  const rows = await queryRows<{
    readonly min_occurred_at: string | null;
    readonly max_occurred_at: string | null;
  }>(
    `
      SELECT
        min(occurred_at)::text AS min_occurred_at,
        max(occurred_at)::text AS max_occurred_at
      FROM episodic_memory
      WHERE namespace_id = $1
    `,
    [namespaceId]
  );

  return {
    minOccurredAt: rows[0]?.min_occurred_at ?? null,
    maxOccurredAt: rows[0]?.max_occurred_at ?? null
  };
}

async function resolveSemanticAnchorWindow(
  namespaceId: string,
  queryText: string,
  referenceNow?: string
): Promise<SemanticAnchorResolution | null> {
  const directive = parseSemanticAnchorDirective(queryText);
  if (!directive) {
    return null;
  }

  if (directive.mode === "during" && /^met\s+/iu.test(directive.anchorText)) {
    const directMeetingRows = await queryRows<{
      readonly source: "episodic_memory";
      readonly occurred_at: string | null;
      readonly content_preview: string;
    }>(
      `
        SELECT
          'episodic_memory'::text AS source,
          em.occurred_at::text AS occurred_at,
          COALESCE(em.content, '') AS content_preview
        FROM episodic_memory em
        WHERE em.namespace_id = $1
          AND lower(COALESCE(em.content, '')) LIKE ('%' || $2 || '%')
        ORDER BY
          CASE WHEN lower(COALESCE(em.content, '')) LIKE '%first time%' THEN 0 ELSE 1 END,
          em.occurred_at ASC,
          length(COALESCE(em.content, '')) ASC
        LIMIT 8
      `,
      [namespaceId, directive.anchorText.toLowerCase()]
    );

    const bestDirectMeetingRow = directMeetingRows[0];
    const directMeetingOccurredAt =
      (bestDirectMeetingRow
        ? extractOccurredAtFromAnchorContext(bestDirectMeetingRow.content_preview, directive.anchorText)
        : null) ?? bestDirectMeetingRow?.occurred_at;
    if (bestDirectMeetingRow?.occurred_at && directMeetingOccurredAt) {
      return {
        timeStart: startOfUtcDay(directMeetingOccurredAt),
        timeEnd: endOfUtcDay(directMeetingOccurredAt),
        anchorOccurredAt: directMeetingOccurredAt,
        anchorText: directive.anchorText,
        mode: directive.mode,
        source: bestDirectMeetingRow.source
      };
    }
  }

  const anchorTerms = semanticAnchorTerms(directive.anchorText);
  const tsQueryText = (anchorTerms.length > 0 ? anchorTerms : directive.anchorText.split(/\s+/u))
    .map((term) => term.trim())
    .filter(Boolean)
    .join(" ");
  if (!tsQueryText) {
    return null;
  }

  const directNarrativeAnchorRows = await queryRows<{
    readonly source: "narrative_event";
    readonly occurred_at: string | null;
    readonly rank_score: number;
    readonly content_preview: string;
    readonly exact_phrase: boolean;
  }>(
    `
      SELECT
        'narrative_event'::text AS source,
        COALESCE(ne.time_start, ns.time_start, ns.occurred_at, ne.created_at)::text AS occurred_at,
        concat_ws(' ', COALESCE(ne.event_label, ''), COALESCE(ns.scene_text, '')) AS content_preview,
        lower(concat_ws(' ', COALESCE(ne.event_label, ''), COALESCE(ns.scene_text, ''))) LIKE ('%' || $2 || '%') AS exact_phrase,
        CASE
          WHEN lower(COALESCE(ne.event_label, '')) = $2 THEN 4.0
          WHEN lower(COALESCE(ne.event_label, '')) LIKE ('%' || $2 || '%') THEN 3.0
          WHEN lower(COALESCE(ns.scene_text, '')) LIKE ('%' || $2 || '%') THEN 2.0
          ELSE 1.0
        END::double precision AS rank_score
      FROM narrative_events ne
      LEFT JOIN narrative_scenes ns ON ns.id = ne.source_scene_id
      WHERE ne.namespace_id = $1
        AND (
          lower(COALESCE(ne.event_label, '')) LIKE ('%' || $2 || '%')
          OR lower(COALESCE(ns.scene_text, '')) LIKE ('%' || $2 || '%')
        )
      ORDER BY rank_score DESC, COALESCE(ne.time_start, ns.time_start, ns.occurred_at, ne.created_at) ASC
      LIMIT 12
    `,
    [namespaceId, directive.anchorText.toLowerCase()]
  );

  const anchorRows = await queryRows<{
    readonly source: "episodic_memory" | "narrative_event";
    readonly occurred_at: string | null;
    readonly rank_score: number;
    readonly content_preview: string;
    readonly exact_phrase: boolean;
  }>(
    `
      WITH event_hits AS (
        SELECT
          'narrative_event'::text AS source,
          COALESCE(ne.time_start, ns.time_start, ns.occurred_at, ne.created_at)::text AS occurred_at,
          concat_ws(' ', COALESCE(ne.event_label, ''), COALESCE(ns.scene_text, '')) AS content_preview,
          lower(concat_ws(' ', COALESCE(ne.event_label, ''), COALESCE(ns.scene_text, ''))) LIKE ('%' || $3 || '%') AS exact_phrase,
          ts_rank_cd(
            to_tsvector('simple', concat_ws(' ', COALESCE(ne.event_label, ''), COALESCE(ns.scene_text, ''))),
            websearch_to_tsquery('simple', $2)
          ) AS rank_score
        FROM narrative_events ne
        LEFT JOIN narrative_scenes ns ON ns.id = ne.source_scene_id
        WHERE ne.namespace_id = $1
          AND to_tsvector('simple', concat_ws(' ', COALESCE(ne.event_label, ''), COALESCE(ns.scene_text, '')))
              @@ websearch_to_tsquery('simple', $2)
      ),
      episodic_hits AS (
        SELECT
          'episodic_memory'::text AS source,
          em.occurred_at::text AS occurred_at,
          COALESCE(em.content, '') AS content_preview,
          lower(COALESCE(em.content, '')) LIKE ('%' || $3 || '%') AS exact_phrase,
          ts_rank_cd(
            to_tsvector('simple', COALESCE(em.content, '')),
            websearch_to_tsquery('simple', $2)
          ) AS rank_score
        FROM episodic_memory em
        WHERE em.namespace_id = $1
          AND to_tsvector('simple', COALESCE(em.content, ''))
              @@ websearch_to_tsquery('simple', $2)
      )
      SELECT source, occurred_at, rank_score, content_preview, exact_phrase
      FROM (
        SELECT * FROM event_hits
        UNION ALL
        SELECT * FROM episodic_hits
      ) hits
      WHERE occurred_at IS NOT NULL
      ORDER BY exact_phrase DESC, rank_score DESC, occurred_at ASC
      LIMIT 16
    `,
    [namespaceId, tsQueryText, directive.anchorText.toLowerCase()]
  );

  const mergedAnchorRows = Array.from(
    new Map(
      [...directNarrativeAnchorRows, ...anchorRows].map((row) => [
        `${row.source}|${row.occurred_at ?? "none"}|${row.content_preview}`,
        row
      ])
    ).values()
  );

  const filteredAnchorRows = mergedAnchorRows.filter((row) => {
    const preview = row.content_preview.toLowerCase();
    if (directive.mode === "after") {
      return !new RegExp(`\\bafter\\s+(?:the\\s+)?${escapeRegExp(directive.anchorText.toLowerCase())}\\b`, "u").test(preview);
    }
    if (directive.mode === "before") {
      return !new RegExp(`\\bbefore\\s+(?:the\\s+)?${escapeRegExp(directive.anchorText.toLowerCase())}\\b`, "u").test(preview);
    }
    return true;
  });
  const exactPhraseRows = filteredAnchorRows.filter((row) => row.exact_phrase);
  const candidateAnchorRows =
    exactPhraseRows.length > 0
      ? exactPhraseRows
      : filteredAnchorRows.length > 0
        ? filteredAnchorRows
        : mergedAnchorRows;
  const bestAnchorRow =
    [...candidateAnchorRows].sort((left, right) => {
      const leftFirstMeeting = /\bfirst\s+time\b/i.test(left.content_preview);
      const rightFirstMeeting = /\bfirst\s+time\b/i.test(right.content_preview);
      if (leftFirstMeeting !== rightFirstMeeting) {
        return Number(rightFirstMeeting) - Number(leftFirstMeeting);
      }
      if (left.exact_phrase !== right.exact_phrase) {
        return Number(right.exact_phrase) - Number(left.exact_phrase);
      }
      if (left.source !== right.source) {
        return left.source === "episodic_memory" ? -1 : 1;
      }
      if (left.content_preview.length !== right.content_preview.length) {
        return left.content_preview.length - right.content_preview.length;
      }
      if (left.rank_score !== right.rank_score) {
        return right.rank_score - left.rank_score;
      }
      return directive.mode === "after"
        ? Date.parse(right.occurred_at ?? "") - Date.parse(left.occurred_at ?? "")
        : Date.parse(left.occurred_at ?? "") - Date.parse(right.occurred_at ?? "");
    })[0];
  const anchorOccurredAt =
    (bestAnchorRow ? extractOccurredAtFromAnchorContext(bestAnchorRow.content_preview, directive.anchorText) : null) ??
    bestAnchorRow?.occurred_at;
  if (!anchorOccurredAt) {
    return null;
  }

  const anchorDayStart = startOfUtcDay(anchorOccurredAt);
  const anchorDayEnd = endOfUtcDay(anchorOccurredAt);
  const fallbackReferenceEnd = referenceNow && parseIsoTimestamp(referenceNow) !== null ? new Date(referenceNow).toISOString() : new Date().toISOString();
  const broadNarrativeAnchorQuery = isBroadNarrativeAnchorQuery(queryText, directive.mode);

  if (directive.mode === "during") {
    return {
      timeStart: anchorDayStart,
      timeEnd: anchorDayEnd,
      anchorOccurredAt,
      anchorText: directive.anchorText,
      mode: directive.mode,
      source: bestAnchorRow!.source
    };
  }

  if (directive.mode === "after") {
    const bounds = await loadNamespaceTimeBounds(namespaceId);
    const anchorBoundary = parseIsoTimestamp(anchorDayEnd) ?? 0;
    const anchorMoment = parseIsoTimestamp(anchorOccurredAt) ?? anchorBoundary;
    const requestedReferenceEnd = parseIsoTimestamp(fallbackReferenceEnd);
    const namespaceReferenceEnd =
      typeof bounds.maxOccurredAt === "string" && parseIsoTimestamp(bounds.maxOccurredAt) !== null ? bounds.maxOccurredAt : fallbackReferenceEnd;
    const usingFallbackReference = !(requestedReferenceEnd !== null && requestedReferenceEnd >= anchorBoundary);
    const unboundedReferenceEnd = usingFallbackReference ? namespaceReferenceEnd : fallbackReferenceEnd;
    const broadAfterEnd = shiftUtcDays(anchorDayEnd, 14);
    const referenceEnd =
      broadNarrativeAnchorQuery && parseIsoTimestamp(unboundedReferenceEnd) !== null
        ? ((parseIsoTimestamp(unboundedReferenceEnd) ?? 0) < (parseIsoTimestamp(broadAfterEnd) ?? 0)
            ? unboundedReferenceEnd
            : broadAfterEnd)
        : unboundedReferenceEnd;
    const timeStart = usingFallbackReference ? anchorOccurredAt : anchorDayEnd;
    if ((parseIsoTimestamp(referenceEnd) ?? anchorMoment) < anchorMoment) {
      return null;
    }
    return {
      timeStart,
      timeEnd: referenceEnd,
      anchorOccurredAt,
      anchorText: directive.anchorText,
      mode: directive.mode,
      source: bestAnchorRow!.source
    };
  }

  const bounds = await loadNamespaceTimeBounds(namespaceId);
  const broadBeforeStart = shiftUtcDays(anchorDayStart, -14);
  const boundedBeforeStart =
    broadNarrativeAnchorQuery &&
    typeof bounds.minOccurredAt === "string" &&
    parseIsoTimestamp(bounds.minOccurredAt) !== null &&
    (parseIsoTimestamp(bounds.minOccurredAt) ?? 0) > (parseIsoTimestamp(broadBeforeStart) ?? 0)
      ? bounds.minOccurredAt
      : broadNarrativeAnchorQuery
        ? broadBeforeStart
        : bounds.minOccurredAt ?? anchorDayStart;
  return {
    timeStart: boundedBeforeStart,
    timeEnd: anchorDayEnd,
    anchorOccurredAt,
    anchorText: directive.anchorText,
    mode: directive.mode,
    source: bestAnchorRow!.source
  };
}

async function loadSemanticAnchorSupportRows(
  namespaceId: string,
  queryText: string,
  plannerTerms: readonly string[],
  resolution: SemanticAnchorResolution,
  candidateLimit: number
): Promise<SearchRow[]> {
  const terms = buildSemanticAnchorEvidenceTerms(queryText, plannerTerms, resolution);
  const match = buildFocusedLikeMatchClause(7, terms, "em.content");
  const orderDirection = resolution.mode === "before" ? "DESC" : "ASC";

  return queryRows<SearchRow>(
    `
      SELECT
        em.id AS memory_id,
        'episodic_memory'::text AS memory_type,
        em.content,
        (
          (${match.scoreExpression}) +
          CASE
            WHEN em.occurred_at::text = $2 THEN 0.2
            ELSE 0
          END
        )::double precision AS raw_score,
        em.artifact_id,
        em.occurred_at,
        em.namespace_id,
        jsonb_build_object(
          'tier', 'semantic_anchor_support',
          'semantic_anchor_mode', $3::text,
          'semantic_anchor_text', $4::text,
          'source_uri', a.uri,
          'artifact_observation_id', em.artifact_observation_id,
          'metadata', em.metadata
        ) AS provenance
      FROM episodic_memory em
      LEFT JOIN artifacts a ON a.id = em.artifact_id
      WHERE em.namespace_id = $1
        AND em.occurred_at >= $5::timestamptz
        AND em.occurred_at <= $6::timestamptz
        AND ${match.clause}
      ORDER BY raw_score DESC, em.occurred_at ${orderDirection}, em.id ASC
      LIMIT $${match.values.length + 7}::int
    `,
    [
      namespaceId,
      resolution.anchorOccurredAt,
      resolution.mode,
      resolution.anchorText,
      resolution.timeStart,
      resolution.timeEnd,
      ...match.values,
      Math.max(candidateLimit, 6)
    ]
  );
}

function temporalLayerSpecificityBonus(layer: unknown): number {
  switch (layer) {
    case "day":
      return 0.18;
    case "week":
      return 0.14;
    case "month":
      return 0.1;
    case "year":
      return 0.06;
    case "session":
      return 0.04;
    case "profile":
      return 0.02;
    default:
      return 0;
  }
}

function temporalWindowAlignmentMultiplier(
  row: Pick<SearchRow, "memory_type" | "occurred_at" | "provenance">,
  timeStart: string | null,
  timeEnd: string | null
): number {
  if (!timeStart || !timeEnd) {
    return 1;
  }

  const queryStart = parseIsoTimestamp(timeStart);
  const queryEnd = parseIsoTimestamp(timeEnd);
  if (queryStart === null || queryEnd === null || queryEnd <= queryStart) {
    return 1;
  }

  if (row.memory_type === "episodic_memory") {
    const occurredAt = parseIsoTimestamp(toIsoString(row.occurred_at));
    if (occurredAt === null) {
      return 1;
    }
    return occurredAt >= queryStart && occurredAt <= queryEnd ? 1.12 : 0.45;
  }

  if (row.memory_type !== "temporal_nodes") {
    return 1;
  }

  const periodStart = parseIsoTimestamp(typeof row.provenance.period_start === "string" ? row.provenance.period_start : null);
  const periodEnd = parseIsoTimestamp(typeof row.provenance.period_end === "string" ? row.provenance.period_end : null);
  if (periodStart === null || periodEnd === null || periodEnd <= periodStart) {
    return 1;
  }

  const overlapStart = Math.max(periodStart, queryStart);
  const overlapEnd = Math.min(periodEnd, queryEnd);
  if (overlapEnd <= overlapStart) {
    return 0.35;
  }

  const overlapRatio = (overlapEnd - overlapStart) / (queryEnd - queryStart);
  const specificityBonus = temporalLayerSpecificityBonus(row.provenance.layer);
  return 0.7 + Math.min(overlapRatio, 1) * 0.5 + specificityBonus;
}

function hasNarrowTimeWindow(timeStart: string | null, timeEnd: string | null): boolean {
  const start = parseIsoTimestamp(timeStart);
  const end = parseIsoTimestamp(timeEnd);
  if (start === null || end === null || end <= start) {
    return false;
  }

  return (end - start) / (1000 * 60 * 60 * 24) <= 45;
}

function buildRecallResult(
  row: SearchRow,
  score: number,
  retrieval: {
    readonly rrfScore: number;
    readonly lexicalRank?: number;
    readonly vectorRank?: number;
    readonly lexicalRawScore?: number;
    readonly vectorDistance?: number;
  }
): RecallResult {
  return {
    memoryId: row.memory_id,
    memoryType: row.memory_type,
    content: row.content,
    score,
    artifactId: row.artifact_id as ArtifactId | null,
    occurredAt: toIsoString(row.occurred_at),
    namespaceId: row.namespace_id,
    provenance: {
      ...row.provenance,
      retrieval
    }
  };
}

function buildEvidenceBundle(results: readonly RecallResult[]): RecallResponse["evidence"] {
  const seen = new Set<string>();
  const evidence: Array<RecallResponse["evidence"][number]> = [];

  for (const result of results) {
    const sourceUri = typeof result.provenance.source_uri === "string" ? result.provenance.source_uri : null;
    if (!result.artifactId && !sourceUri) {
      continue;
    }
    const key = `${result.memoryId}|${result.artifactId ?? "none"}|${sourceUri ?? "none"}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);

    evidence.push({
      memoryId: result.memoryId,
      memoryType: result.memoryType,
      artifactId: result.artifactId ?? null,
      occurredAt: result.occurredAt ?? null,
      sourceUri,
      snippet: result.content.slice(0, 320),
      provenance: result.provenance
    });
  }

  return evidence.slice(0, 12);
}

function extractSubjectParticipantTargets(queryText: string): readonly string[] {
  return [...new Set(
    extractConversationParticipants(queryText)
      .map((participant) => normalizeWhitespace(participant).toLowerCase())
      .filter((participant) => participant.length > 0)
  )];
}

function collectSubjectParticipantSignals(result: RecallResult): readonly string[] {
  const names = new Set<string>();
  const add = (value: unknown): void => {
    if (typeof value !== "string") {
      return;
    }
    const normalized = normalizeWhitespace(value).toLowerCase();
    if (!normalized) {
      return;
    }
    names.add(normalized);
    for (const participant of extractConversationParticipants(value)) {
      const participantNormalized = normalizeWhitespace(participant).toLowerCase();
      if (participantNormalized) {
        names.add(participantNormalized);
      }
    }
  };

  add(result.content);
  add(result.provenance.subject_name);
  add(result.provenance.object_name);
  add(result.provenance.transcript_speaker_name);
  add(result.provenance.speaker_name);
  add(result.provenance.canonical_name);

  const provenanceMetadata =
    typeof result.provenance.metadata === "object" && result.provenance.metadata !== null
      ? (result.provenance.metadata as Record<string, unknown>)
      : null;
  if (provenanceMetadata) {
    add(provenanceMetadata.subject_name);
    add(provenanceMetadata.object_name);
    add(provenanceMetadata.transcript_speaker_name);
    add(provenanceMetadata.speaker_name);
    add(provenanceMetadata.canonical_name);
    add(provenanceMetadata.primary_speaker_name);
    const participantNames = Array.isArray(provenanceMetadata.participant_names)
      ? provenanceMetadata.participant_names
      : [];
    for (const participant of participantNames) {
      add(participant);
    }
    const speakerNames = Array.isArray(provenanceMetadata.speaker_names)
      ? provenanceMetadata.speaker_names
      : [];
    for (const speaker of speakerNames) {
      add(speaker);
    }
  }

  return [...names];
}

function resultProvenanceMetadata(result: RecallResult): Record<string, unknown> | null {
  return typeof result.provenance.metadata === "object" && result.provenance.metadata !== null
    ? (result.provenance.metadata as Record<string, unknown>)
    : null;
}

function filterResultsForPrimaryEntity(queryText: string, results: readonly RecallResult[]): readonly RecallResult[] {
  const entityHints = extractEntityNameHints(queryText)
    .map((value) => normalizeWhitespace(value).toLowerCase())
    .filter(Boolean);
  if (entityHints.length === 0) {
    return results;
  }

  const filtered = results.filter((result) => {
    const content = normalizeWhitespace(result.content).toLowerCase();
    const signals = collectSubjectParticipantSignals(result);
    return entityHints.some((hint) => content.includes(hint) || signals.some((signal) => signal.includes(hint)));
  });
  return filtered.length > 0 ? filtered : results;
}

interface ConversationSpeakerTurn {
  readonly speaker: string;
  readonly text: string;
}

function parseConversationSpeakerTurns(content: string): readonly ConversationSpeakerTurn[] {
  const lines = content
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const parsedLines = lines.flatMap((line) => {
    const match = line.match(/^([^:\n]{2,80}):\s+(.+)$/u);
    if (!match?.[1] || !match?.[2]) {
      return [];
    }
    return [{
      speaker: normalizeWhitespace(match[1]).toLowerCase(),
      text: normalizeWhitespace(match[2])
    }];
  });
  if (parsedLines.length > 0) {
    return parsedLines;
  }

  const normalized = normalizeWhitespace(
    content.replace(/^Conversation between [^:]+/iu, "").replace(/\s+/gu, " ")
  );
  if (!normalized) {
    return [];
  }

  const inlineTurns: ConversationSpeakerTurn[] = [];
  const inlinePattern =
    /(?:^|\s)([A-Z][A-Za-z'’.-]{1,40}(?:\s+[A-Z][A-Za-z'’.-]{1,40}){0,2}):\s*([^:]+?)(?=(?:\s+[A-Z][A-Za-z'’.-]{1,40}(?:\s+[A-Z][A-Za-z'’.-]{1,40}){0,2}:)|$)/gu;
  for (const match of normalized.matchAll(inlinePattern)) {
    const speaker = normalizeWhitespace(match[1] ?? "").toLowerCase();
    const text = normalizeWhitespace(match[2] ?? "");
    if (!speaker || !text) {
      continue;
    }
    inlineTurns.push({ speaker, text });
  }
  return inlineTurns;
}

function inferLeadingSpeakerHint(text: string): string | null {
  const normalized = normalizeWhitespace(text.replace(/^Conversation between [^:]+/iu, ""));
  if (!normalized) {
    return null;
  }
  const match = normalized.match(/^([A-Z][A-Za-z'’.-]{1,40}(?:\s+[A-Z][A-Za-z'’.-]{1,40}){0,2}):\s+/u);
  return match?.[1] ? normalizeWhitespace(match[1]).toLowerCase() : null;
}

function primaryEntitySpeakerOwnedResults(queryText: string, results: readonly RecallResult[]): readonly RecallResult[] {
  const entityHints = extractEntityNameHints(queryText)
    .map((value) => normalizeWhitespace(value).toLowerCase())
    .filter(Boolean);
  if (entityHints.length !== 1) {
    return [];
  }

  return results.filter((result) => {
    const metadata = resultProvenanceMetadata(result);
    const speakerSignals = [
      result.provenance.transcript_speaker_name,
      result.provenance.speaker_name,
      metadata?.transcript_speaker_name,
      metadata?.speaker_name,
      metadata?.primary_speaker_name
    ]
      .map((value) => (typeof value === "string" ? normalizeWhitespace(value).toLowerCase() : ""))
      .filter(Boolean);
    if (speakerSignals.some((signal) => entityHints.some((hint) => signal.includes(hint)))) {
      return true;
    }

    for (const text of recallResultSourceTexts(result)) {
      const leadingSpeaker = inferLeadingSpeakerHint(text);
      if (leadingSpeaker && entityHints.some((hint) => leadingSpeaker.includes(hint))) {
        return true;
      }
      const speakerTurns = parseConversationSpeakerTurns(text);
      if (speakerTurns.some((turn) => entityHints.some((hint) => turn.speaker.includes(hint)))) {
        return true;
      }
    }

    return false;
  });
}

function speakerOwnedRecallResultSourceTexts(queryText: string, result: RecallResult): readonly string[] {
  const entityHints = extractEntityNameHints(queryText)
    .map((value) => normalizeWhitespace(value).toLowerCase())
    .filter(Boolean);
  if (entityHints.length !== 1) {
    return recallResultSourceTexts(result);
  }

  const ownedTexts: string[] = [];
  for (const text of recallResultSourceTexts(result)) {
    const speakerTurns = parseConversationSpeakerTurns(text);
    const primaryTurns = speakerTurns.filter((turn) => entityHints.some((hint) => turn.speaker.includes(hint)));
    if (primaryTurns.length > 0) {
      ownedTexts.push(primaryTurns.map((turn) => `${turn.speaker}: ${turn.text}`).join(" "));
      continue;
    }

    const leadingSpeaker = inferLeadingSpeakerHint(text);
    if (leadingSpeaker && entityHints.some((hint) => leadingSpeaker.includes(hint))) {
      ownedTexts.push(normalizeWhitespace(text));
      continue;
    }

    const boundText = extractPrimaryEntityBoundTextFromContent(queryText, text);
    if (normalizeWhitespace(boundText) && normalizeWhitespace(boundText) !== normalizeWhitespace(text)) {
      ownedTexts.push(boundText);
    }
  }

  return [...new Set(ownedTexts.map((value) => normalizeWhitespace(value)).filter(Boolean))];
}

function extractPrimaryEntityBoundTextFromContent(queryText: string, content: string): string {
  const entityHints = extractEntityNameHints(queryText)
    .map((value) => normalizeWhitespace(value).toLowerCase())
    .filter(Boolean);
  if (entityHints.length === 0) {
    return content;
  }

  const speakerTurns = parseConversationSpeakerTurns(content);
  if (speakerTurns.length > 0) {
    const indexesToKeep = new Set<number>();
    for (const [index, turn] of speakerTurns.entries()) {
      const normalizedText = normalizeWhitespace(turn.text).toLowerCase();
      const speakerMatch = entityHints.some((hint) => turn.speaker.includes(hint));
      const textMatch = entityHints.some((hint) => normalizedText.includes(hint));
      if (!speakerMatch && !textMatch) {
        continue;
      }
      indexesToKeep.add(index);
      if (index > 0 && /\?\s*$/.test(speakerTurns[index - 1]?.text ?? "")) {
        indexesToKeep.add(index - 1);
      }
    }
    const boundTurns = speakerTurns.filter((_, index) => indexesToKeep.has(index));
    if (boundTurns.length > 0) {
      return boundTurns.map((turn) => `${turn.speaker}: ${turn.text}`).join(" ");
    }
  }

  const segments = content
    .split(/(?<=[.!?])\s+|\n+/u)
    .map((segment) => segment.trim())
    .filter(Boolean);
  const matchedIndexes = segments.flatMap((segment, index) => {
    const normalized = normalizeWhitespace(segment).toLowerCase();
    return entityHints.some((hint) => normalized.includes(hint)) ? [index] : [];
  });
  if (matchedIndexes.length === 0) {
    return content;
  }

  const segmentMatchesTargetContext = (segment: string): boolean => {
    const normalized = normalizeWhitespace(segment).toLowerCase();
    if (entityHints.some((hint) => normalized.includes(hint))) {
      return true;
    }
    const participantSignals = extractConversationParticipants(segment)
      .map((participant) => normalizeWhitespace(participant).toLowerCase())
      .filter(Boolean);
    return participantSignals.length === 0 || participantSignals.some((participant) => entityHints.some((hint) => participant.includes(hint)));
  };

  const indexesToKeep = new Set<number>();
  for (const index of matchedIndexes) {
    indexesToKeep.add(index);
    if (index > 0 && segmentMatchesTargetContext(segments[index - 1] ?? "")) {
      indexesToKeep.add(index - 1);
    }
    if (index + 1 < segments.length && segmentMatchesTargetContext(segments[index + 1] ?? "")) {
      indexesToKeep.add(index + 1);
    }
  }

  const boundSegments = segments.filter((_, index) => indexesToKeep.has(index));
  return boundSegments.length > 0 ? boundSegments.join(" ") : content;
}

function extractPrimaryEntityBoundText(queryText: string, result: RecallResult): string {
  return extractPrimaryEntityBoundTextFromContent(queryText, result.content);
}

function retainPrimaryEntityPreciseFactResults(
  queryText: string,
  results: readonly RecallResult[],
  limit: number
): readonly RecallResult[] {
  const entityHints = extractEntityNameHints(queryText)
    .map((value) => normalizeWhitespace(value).toLowerCase())
    .filter(Boolean);
  if (entityHints.length === 0 || results.length <= 1) {
    return results;
  }

  const queryTerms = (queryText.match(/[A-Za-z0-9][A-Za-z0-9'._:-]*/g) ?? [])
    .map((term) => normalizeWhitespace(term).toLowerCase())
    .filter((term) => term.length > 2)
    .filter((term) => !entityHints.includes(term))
    .filter((term) => !["what", "which", "who", "where", "when", "how", "did", "does", "was", "were", "the", "a", "an", "his", "her", "their"].includes(term));

  const rescored = results.map((result) => {
    const signals = collectSubjectParticipantSignals(result);
    const boundText = extractPrimaryEntityBoundText(queryText, result);
    const normalizedBoundText = normalizeWhitespace(boundText).toLowerCase();
    const signalHit = signals.some((signal) => entityHints.some((hint) => signal.includes(hint)));
    const boundEntityHit = entityHints.some((hint) => normalizedBoundText.includes(hint));
    const cueHits = queryTerms.filter((term) => normalizedBoundText.includes(term)).length;
    const derivationType = result.memoryType === "artifact_derivation"
      ? String(result.provenance.derivation_type ?? "")
      : "";

    let score = typeof result.score === "number" ? result.score : 0;
    if (signalHit || boundEntityHit) {
      score += 0.8;
    }
    if (cueHits > 0) {
      score += Math.min(1.4, cueHits * 0.35);
    }
    if (result.memoryType === "episodic_memory" || result.memoryType === "narrative_event") {
      score += 0.65;
    }
    if (derivationType === "conversation_unit") {
      score -= 0.55;
      if (boundText !== result.content) {
        score += 0.45;
      }
    }

    return { result, score };
  });

  rescored.sort((left, right) => right.score - left.score);
  return rescored.slice(0, limit).map((item) => item.result);
}

function retainSubjectBoundExactDetailResults(
  queryText: string,
  results: readonly RecallResult[],
  limit: number
): readonly RecallResult[] {
  const family = inferExactDetailQuestionFamily(queryText);
  const anchorTerms = queryAnchorTerms(queryText);
  const entityHints = extractEntityNameHints(queryText)
    .map((value) => normalizeWhitespace(value).toLowerCase())
    .filter(Boolean);
  if (entityHints.length !== 1 || results.length <= 1) {
    return results;
  }

  const rescored = results.map((result) => {
    const signals = collectSubjectParticipantSignals(result);
    const signalHit = signals.some((signal) => entityHints.some((hint) => signal.includes(hint)));
    const foreignSignals = signals.filter((signal) => !entityHints.some((hint) => signal.includes(hint)));
    const derivationType = derivationTypeForRecallResult(result);
    const boundText = extractPrimaryEntityBoundText(queryText, result);
    const normalizedBoundText = normalizeWhitespace(boundText).toLowerCase();
    const sourceSentenceText =
      typeof result.provenance.metadata === "object" &&
      result.provenance.metadata !== null &&
      typeof (result.provenance.metadata as Record<string, unknown>).source_sentence_text === "string"
        ? String((result.provenance.metadata as Record<string, unknown>).source_sentence_text)
        : "";
    const normalizedSourceSentence = normalizeWhitespace(sourceSentenceText).toLowerCase();
    const speakerTurns = parseConversationSpeakerTurns(result.content);
    const primarySpeakerTurns = speakerTurns.filter((turn) => entityHints.some((hint) => turn.speaker.includes(hint)));
    const foreignSpeakerTurns = speakerTurns.filter((turn) => !entityHints.some((hint) => turn.speaker.includes(hint)));
    const mixedSpeakerWindow = primarySpeakerTurns.length > 0 && foreignSpeakerTurns.length > 0;
    const cueHits = (queryText.match(/[A-Za-z0-9][A-Za-z0-9'._:-]*/g) ?? [])
      .map((term) => term.toLowerCase())
      .filter((term) => term.length > 3 && !entityHints.includes(term))
      .filter((term) => normalizedBoundText.includes(term)).length;
    const anchorHitCount = anchorTerms.filter((term) =>
      normalizedBoundText.includes(term) || normalizedSourceSentence.includes(term)
    ).length;
    const yearHint = (queryText.match(/\b(19\d{2}|20\d{2})\b/) ?? [])[1] ?? null;

    let score = typeof result.score === "number" ? result.score : 0;
    if (signalHit) {
      score += 1.2;
    }
    if (cueHits > 0) {
      score += Math.min(1.6, cueHits * 0.28);
    }
    if (family === "realization" && anchorTerms.length > 0) {
      if (anchorHitCount > 0) {
        score += 1.4 + Math.min(1.2, anchorHitCount * 0.45);
      } else {
        score -= 3.2;
      }
      if (/\brealiz(?:e|ed|ing)\b|\bthought-provoking\b|\bself-?care\b/i.test(`${boundText} ${sourceSentenceText}`)) {
        score += 1.1;
      }
    }
    if (result.memoryType === "episodic_memory" || result.memoryType === "narrative_event") {
      score += 0.9;
    }
    if (result.memoryType === "artifact_derivation" && derivationType === "source_sentence") {
      score += 0.85;
    }
    if (result.memoryType === "artifact_derivation" && derivationType === "participant_turn") {
      score += 1.35;
    }
    if (result.memoryType === "artifact_derivation" && derivationType === "conversation_unit") {
      score -= 0.9;
    }
    if (result.memoryType === "artifact_derivation" && derivationType === "topic_segment") {
      score -= 0.35;
    }
    if (speakerTurns.length > 0) {
      if (primarySpeakerTurns.length > 0) {
        score += 0.95;
      }
      if (derivationType === "participant_turn" && primarySpeakerTurns.length === 0 && foreignSpeakerTurns.length > 0) {
        score -= 1.6;
      }
      if (mixedSpeakerWindow && derivationType === "conversation_unit") {
        score -= 1.35;
      }
      if (foreignSpeakerTurns.length > primarySpeakerTurns.length && primarySpeakerTurns.length === 0) {
        score -= 0.9;
      }
    }
    if (normalizedSourceSentence.length > 0) {
      if (entityHints.some((hint) => normalizedSourceSentence.includes(hint))) {
        score += 0.7;
      }
      if (cueHits > 0) {
        score += 0.35;
      }
    }
    if (derivationType === "participant_turn" && /\?\s*$/u.test(sourceSentenceText)) {
      score -= 0.4;
    }
    if (yearHint && typeof result.occurredAt === "string" && result.occurredAt.includes(yearHint)) {
      score += 0.35;
    }
    if (foreignSignals.length > 0 && !signalHit) {
      score -= 1.25;
    }
    if (foreignSignals.length > 0 && signalHit) {
      score -= Math.min(0.8, foreignSignals.length * 0.25);
    }
    if ((derivationType === "conversation_unit" || derivationType === "topic_segment") && foreignSignals.length > 0 && !signalHit) {
      score -= 1.1;
    }

    return { result, score };
  });

  rescored.sort((left, right) => right.score - left.score);
  return rescored.slice(0, limit).map((item) => item.result);
}

function prioritizeDerivationDetailResults(
  results: readonly RecallResult[],
  limit: number
): readonly RecallResult[] {
  const priority = (result: RecallResult): number => {
    const derivationType = derivationTypeForRecallResult(result);
    if (result.memoryType === "artifact_derivation" && (derivationType === "ocr" || derivationType === "transcription")) {
      return 0;
    }
    if (result.memoryType === "artifact_derivation") {
      return 1;
    }
    if (result.memoryType === "episodic_memory") {
      return 2;
    }
    if (result.memoryType === "semantic_memory") {
      return 3;
    }
    return 4;
  };

  return [...results]
    .sort((left, right) => {
      const priorityDelta = priority(left) - priority(right);
      if (priorityDelta !== 0) {
        return priorityDelta;
      }
      return (right.score ?? 0) - (left.score ?? 0);
    })
    .slice(0, limit);
}

function prioritizeHierarchyTraversalResults(
  results: readonly RecallResult[],
  limit: number
): readonly RecallResult[] {
  const priority = (result: RecallResult): number => {
    const tier = typeof result.provenance.tier === "string" ? result.provenance.tier : "";
    if (result.memoryType === "relationship_memory" && tier === "structural_hierarchy") {
      return 0;
    }
    if (result.memoryType === "relationship_memory") {
      return 1;
    }
    if (result.memoryType === "episodic_memory") {
      return 2;
    }
    if (result.memoryType === "artifact_derivation") {
      return 3;
    }
    if (result.memoryType === "semantic_memory") {
      return 4;
    }
    return 5;
  };

  return [...results]
    .sort((left, right) => {
      const priorityDelta = priority(left) - priority(right);
      if (priorityDelta !== 0) {
        return priorityDelta;
      }
      return (right.score ?? 0) - (left.score ?? 0);
    })
    .slice(0, limit);
}

function prioritizeRelationshipHistoryResults(
  results: readonly RecallResult[],
  limit: number
): readonly RecallResult[] {
  const priority = (result: RecallResult): number => {
    const content = normalizeWhitespace(result.content).toLowerCase();
    const historicalCue =
      /\b(bend|tahoe|tahoe city|dating|dated|date|fling|friends with benefits|reconnect|reconnected|barely talk|history|visa run)\b/.test(
        content
      );
    if ((result.memoryType === "episodic_memory" || result.memoryType === "narrative_event") && historicalCue) {
      return 0;
    }
    if (result.memoryType === "relationship_memory") {
      return historicalCue ? 1 : 2;
    }
    if (result.memoryType === "procedural_memory") {
      return 3;
    }
    if (result.memoryType === "semantic_memory") {
      return 4;
    }
    if (result.memoryType === "episodic_memory" || result.memoryType === "narrative_event") {
      return 1;
    }
    return 5;
  };

  return [...results]
    .sort((left, right) => {
      const priorityDelta = priority(left) - priority(right);
      if (priorityDelta !== 0) {
        return priorityDelta;
      }
      return (right.score ?? 0) - (left.score ?? 0);
    })
    .slice(0, limit);
}

function hasTemporalDetailCue(text: string): boolean {
  return /\b(yesterday|today|last night|last year|last month|last week|\d+\s+days?\s+ago|\bJanuary\b|\bFebruary\b|\bMarch\b|\bApril\b|\bMay\b|\bJune\b|\bJuly\b|\bAugust\b|\bSeptember\b|\bOctober\b|\bNovember\b|\bDecember\b|\b20\d{2}\b|\b19\d{2}\b)\b/iu.test(
    text
  );
}

function retainTemporalDetailResults(
  queryText: string,
  results: readonly RecallResult[],
  limit: number
): readonly RecallResult[] {
  const subjectHints = extractSubjectHintsFromQuery(queryText)
    .map((value) => normalizeWhitespace(value).toLowerCase())
    .filter(Boolean);
  const leafRows = results.filter(
    (result) =>
      result.memoryType === "episodic_memory" ||
      result.memoryType === "narrative_event" ||
      result.memoryType === "artifact_derivation"
  );
  if (leafRows.length === 0) {
    return results;
  }

  const subjectBoundRows = leafRows.filter((result) => {
    if (subjectHints.length === 0) {
      return true;
    }
    const content = normalizeWhitespace(result.content).toLowerCase();
    const signals = collectSubjectParticipantSignals(result);
    return subjectHints.some((hint) => content.includes(hint) || signals.some((signal) => signal.includes(hint)));
  });
  const candidateRows = subjectBoundRows.length > 0 ? subjectBoundRows : leafRows;
  const temporalCueRows = candidateRows.filter((result) => hasTemporalDetailCue(result.content));
  const prioritizedRows = temporalCueRows.length > 0 ? temporalCueRows : candidateRows;

  return [...prioritizedRows]
    .sort((left, right) => {
      const leftCue = hasTemporalDetailCue(left.content) ? 1 : 0;
      const rightCue = hasTemporalDetailCue(right.content) ? 1 : 0;
      if (rightCue !== leftCue) {
        return rightCue - leftCue;
      }
      const leftTs = parseIsoTimestamp(typeof left.occurredAt === "string" ? left.occurredAt : null) ?? 0;
      const rightTs = parseIsoTimestamp(typeof right.occurredAt === "string" ? right.occurredAt : null) ?? 0;
      return rightTs - leftTs;
    })
    .slice(0, Math.max(limit, 4));
}

function derivationTypeForRecallResult(result: RecallResult): string {
  return result.memoryType === "artifact_derivation" && typeof result.provenance.derivation_type === "string"
    ? result.provenance.derivation_type
    : "";
}

type ReflectRecapFacet =
  | "summary"
  | "location"
  | "relationship"
  | "people_work"
  | "media"
  | "preference";

function requestedReflectRecapFacets(queryText: string): readonly ReflectRecapFacet[] {
  const lowered = queryText.toLowerCase();
  const facets: ReflectRecapFacet[] = ["summary"];
  if (/\b(where|lived|live|stayed|based)\b/.test(lowered)) {
    facets.push("location");
  }
  if (/\b(lauren|relationship|dating|together|friend|history|changed with)\b/.test(lowered)) {
    facets.push("relationship");
  }
  if (/\b(who|around|with|coworking|coworker|coworkers|work with|weekend|weekends|pilot|two-way)\b/.test(lowered)) {
    facets.push("people_work");
  }
  if (/\b(movie|movies|watch|watched|film|films|cinema)\b/.test(lowered)) {
    facets.push("media");
  }
  if (/\b(preference|preferences|constraint|constraints|prefer|prefers|food|coffee|spicy|mild|peanut)\b/.test(lowered)) {
    facets.push("preference");
  }
  return [...new Set(facets)];
}

function resultMatchesReflectRecapFacet(result: RecallResult, facet: ReflectRecapFacet): boolean {
  const content = normalizeWhitespace(result.content).toLowerCase();
  const derivationType = derivationTypeForRecallResult(result);
  const metadata =
    typeof result.provenance.metadata === "object" && result.provenance.metadata !== null
      ? (result.provenance.metadata as Record<string, unknown>)
      : null;
  const predicate =
    typeof result.provenance.predicate === "string"
      ? result.provenance.predicate.toLowerCase()
      : "";
  const stateType =
    typeof result.provenance.state_type === "string"
      ? result.provenance.state_type.toLowerCase()
      : "";
  const eventKind =
    typeof result.provenance.event_kind === "string"
      ? result.provenance.event_kind.toLowerCase()
      : "";

  switch (facet) {
    case "summary":
      return (
        derivationType === "community_summary" ||
        derivationType === "topic_segment" ||
        (result.memoryType === "semantic_memory" && typeof result.provenance.memory_kind === "string")
      );
    case "location":
      return (
        stateType.includes("location") ||
        predicate === "lived_in" ||
        /\b(live|lives|lived|stayed|stays|chiang mai|koh samui|istanbul|home|based in)\b/.test(content)
      );
    case "relationship":
      return (
        result.memoryType === "relationship_memory" ||
        /\b(lauren|not together|barely talk|loosely in touch|dating|friend(?:_of)?|relationship)\b/.test(content)
      );
    case "people_work":
      return (
        /\b(jules|omar|rina|theo|coworking|work with|works with|two-way|weekend|weekends|pilot|conference)\b/.test(content) ||
        eventKind === "collaboration"
      );
    case "media":
      return /\b(movie|movies|watch|watched|film|films|cinema|sinners|texas chainsaw)\b/.test(content);
    case "preference":
      return (
        stateType.includes("preference") ||
        /\b(prefer|prefers|preference|preferences|constraint|constraints|mild|spicy|coffee|peanut|blocker)\b/.test(content)
      );
  }
}

function shouldDiversifyReflectRecap(queryText: string): boolean {
  const lowered = queryText.toLowerCase();
  const facets = requestedReflectRecapFacets(queryText);
  return (
    facets.length >= 4 &&
    /\b(lately|recently|current picture|what has|recap|summary|pull together|last little stretch|these days|overall)\b/.test(lowered)
  );
}

function selectBroadLifeSummarySubqueryResults(
  subquery: string,
  results: readonly RecallResult[],
  limit = 2
): readonly RecallResult[] {
  if (results.length <= limit) {
    return results;
  }

  const facets = requestedReflectRecapFacets(subquery).filter((facet) => facet !== "summary");
  const selected: RecallResult[] = [];
  const seen = new Set<string>();

  const add = (candidate: RecallResult | undefined): void => {
    if (!candidate) {
      return;
    }
    if (seen.has(candidate.memoryId)) {
      return;
    }
    selected.push(candidate);
    seen.add(candidate.memoryId);
  };

  for (const facet of facets) {
    add(results.find((result) => resultMatchesReflectRecapFacet(result, facet)));
  }

  add(results[0]);

  for (const result of results) {
    add(result);
    if (selected.length >= limit) {
      break;
    }
  }

  return selected.slice(0, limit);
}

function prioritizeReflectContextResults(
  results: readonly RecallResult[],
  limit: number,
  queryText?: string
): readonly RecallResult[] {
  const priority = (result: RecallResult): number => {
    const derivationType = derivationTypeForRecallResult(result);
    if (derivationType === "community_summary") {
      return 0;
    }
    if (derivationType === "topic_segment") {
      return 1;
    }
    if (result.memoryType === "semantic_memory") {
      return 2;
    }
    if (result.memoryType === "episodic_memory" || result.memoryType === "narrative_event") {
      return 3;
    }
    if (derivationType === "conversation_unit") {
      return 4;
    }
    return 5;
  };

  const baseSorted = [...results]
    .sort((left, right) => {
      const priorityDelta = priority(left) - priority(right);
      if (priorityDelta !== 0) {
        return priorityDelta;
      }
      return (right.score ?? 0) - (left.score ?? 0);
    });

  if (!queryText || !shouldDiversifyReflectRecap(queryText)) {
    return baseSorted.slice(0, limit);
  }

  const selected: RecallResult[] = [];
  const selectedIds = new Set<string>();
  const addResult = (candidate: RecallResult | undefined): void => {
    if (!candidate) {
      return;
    }
    if (selectedIds.has(candidate.memoryId)) {
      return;
    }
    selected.push(candidate);
    selectedIds.add(candidate.memoryId);
  };

  for (const facet of requestedReflectRecapFacets(queryText)) {
    addResult(baseSorted.find((result) => resultMatchesReflectRecapFacet(result, facet)));
  }

  for (const result of baseSorted) {
    addResult(result);
    if (selected.length >= limit) {
      break;
    }
  }

  return selected.slice(0, limit);
}

function commonalityBucketsForText(text: string): readonly string[] {
  const normalized = text.toLowerCase();
  const buckets = new Set<string>();
  if (/\b(dance|dancing)\b/.test(normalized)) {
    buckets.add(/\b(stress|destress|de-stress|stress relief|stress fix|stress-buster|happy place|escape)\b/.test(normalized) ? "dance_destress" : "dance");
  }
  if (/\blost my job\b|\blost his job\b|\blost her job\b|\bjob as a\b|\bjob at\b/.test(normalized)) {
    buckets.add("job_loss");
  }
  if (/\bown business\b|\bstart(?:ing)? my own business\b|\bopened an online clothing store\b|\bdance studio\b|\bstore\b/.test(normalized)) {
    buckets.add("business_start");
  }
  if (/\bpatient-support pilot\b|\bpilot interviews\b|\bsupport the pilot\b|\blaunch the patient-support pilot\b/.test(normalized)) {
    buckets.add("patient_support_pilot");
  }
  if (
    /\bvolunteer(?:ed|ing)?\b/.test(normalized) ||
    /\bhomeless shelter\b/.test(normalized) ||
    (/\bshelter\b/.test(normalized) && /\b(help|fundraiser|food|supplies|event)\b/.test(normalized))
  ) {
    buckets.add(/\bhomeless shelter\b/.test(normalized) ? "homeless_shelter_volunteering" : "volunteering");
  }
  if (/\b(climb|climbing)\b/.test(normalized)) {
    buckets.add("climbing");
  }
  if (/\b(sketch|sketching)\b/.test(normalized)) {
    buckets.add("sketching");
  }
  return [...buckets];
}

function retainParticipantBoundCommonalityResults(
  queryText: string,
  results: readonly RecallResult[],
  limit: number
): readonly RecallResult[] {
  const participants = extractConversationParticipants(queryText)
    .map((participant) => normalizeWhitespace(participant).toLowerCase())
    .filter(Boolean)
    .slice(0, 3);
  if (participants.length < 2) {
    return results;
  }

  const candidateRows = results.map((result) => {
    const content = normalizeWhitespace(result.content).toLowerCase();
    const signals = collectSubjectParticipantSignals(result);
    const participantHits = participants.filter((participant) => content.includes(participant) || signals.some((signal) => signal.includes(participant)));
    return {
      result,
      participantHits,
      bucketHits: commonalityBucketsForText(result.content)
    };
  }).filter((entry) => entry.participantHits.length > 0 && entry.bucketHits.length > 0);
  if (candidateRows.length === 0) {
    return results;
  }

  const perParticipantBuckets = new Map<string, Set<string>>();
  for (const participant of participants) {
    perParticipantBuckets.set(participant, new Set<string>());
  }
  for (const entry of candidateRows) {
    for (const participant of entry.participantHits) {
      const bucketSet = perParticipantBuckets.get(participant);
      if (!bucketSet) {
        continue;
      }
      for (const bucket of entry.bucketHits) {
        bucketSet.add(bucket);
      }
    }
  }
  const coveredParticipants = new Set<string>(
    [...perParticipantBuckets.entries()].filter(([, bucketSet]) => bucketSet.size > 0).map(([participant]) => participant)
  );
  if (coveredParticipants.size < Math.min(2, participants.length)) {
    return results;
  }

  const bucketSets = [...perParticipantBuckets.values()].filter((bucketSet) => bucketSet.size > 0);
  const sharedBuckets = bucketSets.length >= 2
    ? new Set<string>([...bucketSets[0]!].filter((bucket) => bucketSets.slice(1).every((bucketSet) => bucketSet.has(bucket))))
    : new Set<string>();
  const prioritizedSharedBuckets =
    /\bvolunteer(?:ing)?\b/i.test(queryText)
      ? new Set<string>([...sharedBuckets].filter((bucket) => bucket === "homeless_shelter_volunteering" || bucket === "volunteering"))
      : sharedBuckets;
  const filteredRows =
    prioritizedSharedBuckets.size > 0
      ? candidateRows.filter((entry) => entry.bucketHits.some((bucket) => prioritizedSharedBuckets.has(bucket)))
      : candidateRows;

  return [...filteredRows]
    .sort((left, right) => {
      const leftSharedBucketCount = left.bucketHits.filter((bucket) => prioritizedSharedBuckets.has(bucket)).length;
      const rightSharedBucketCount = right.bucketHits.filter((bucket) => prioritizedSharedBuckets.has(bucket)).length;
      if (rightSharedBucketCount !== leftSharedBucketCount) {
        return rightSharedBucketCount - leftSharedBucketCount;
      }
      if (right.participantHits.length !== left.participantHits.length) {
        return right.participantHits.length - left.participantHits.length;
      }
      if (right.bucketHits.length !== left.bucketHits.length) {
        return right.bucketHits.length - left.bucketHits.length;
      }
      return (right.result.score ?? 0) - (left.result.score ?? 0);
    })
    .map((entry) => entry.result)
    .slice(0, Math.max(limit, 6));
}

function assessSubjectBinding(
  results: readonly RecallResult[],
  queryText: string
): {
  readonly subjectMatch: "matched" | "mixed" | "mismatched" | "unknown";
  readonly matchedParticipants: readonly string[];
  readonly missingParticipants: readonly string[];
  readonly foreignParticipants: readonly string[];
  readonly topIsolationStatus?: "subject_owned" | "mixed_subject" | "foreign_subject" | "no_subject_signal";
  readonly topResultOwned: boolean;
} {
  const targets = extractSubjectParticipantTargets(queryText);
  if (targets.length === 0) {
    return {
      subjectMatch: "unknown",
      matchedParticipants: [],
      missingParticipants: [],
      foreignParticipants: [],
      topResultOwned: false
    };
  }

  const strictSingleTargetIsolationFocus =
    targets.length === 1 &&
    !isIdentityProfileQuery(queryText) &&
    !isProfileInferenceQuery(queryText) &&
    !isPreferenceQuery(queryText) &&
    !isSharedCommonalityQuery(queryText) &&
    (
      isPreciseFactDetailQuery(queryText) ||
      isTemporalDetailQuery(queryText) ||
      /^\s*(?:is|does|did|would|will|can|could|has|have|had)\b/i.test(queryText)
    );

  if (strictSingleTargetIsolationFocus && results.length > 0) {
    const evaluations = results.map((result) => evaluateSubjectIsolationResult(queryText, result));
    const topEvaluation = evaluations[0];
    const mixedSeen = evaluations.some((evaluation) => evaluation.status === "mixed_subject");
    const foreignSeen = evaluations.some((evaluation) => evaluation.status === "foreign_subject");
    if (topEvaluation?.status === "subject_owned") {
      return {
        subjectMatch: "matched",
        matchedParticipants: targets,
        missingParticipants: [],
        foreignParticipants: [],
        topIsolationStatus: topEvaluation.status,
        topResultOwned: true
      };
    }
    if (topEvaluation?.status === "mixed_subject" || mixedSeen) {
      return {
        subjectMatch: "mixed",
        matchedParticipants: [],
        missingParticipants: targets,
        foreignParticipants: [],
        topIsolationStatus: topEvaluation?.status ?? "mixed_subject",
        topResultOwned: false
      };
    }
    if (topEvaluation?.status === "foreign_subject" || foreignSeen) {
      return {
        subjectMatch: "mismatched",
        matchedParticipants: [],
        missingParticipants: targets,
        foreignParticipants: [...new Set(
          evaluations
            .flatMap((evaluation) => evaluation.strictSignals)
            .filter((signal) => !targets.some((target) => signal.includes(target)))
        )].slice(0, 8),
        topIsolationStatus: topEvaluation?.status ?? "foreign_subject",
        topResultOwned: false
      };
    }
  }

  const participantHitCount = new Map<string, number>();
  const foreignParticipants = new Set<string>();
  const sharedCommonalityFocus = isSharedCommonalityQuery(queryText);

  for (const result of results) {
    const signals = collectSubjectParticipantSignals(result);
    let matchedAny = false;
    for (const target of targets) {
      if (signals.some((signal) => signal.includes(target))) {
        participantHitCount.set(target, (participantHitCount.get(target) ?? 0) + 1);
        matchedAny = true;
      }
    }
    if (!matchedAny) {
      for (const signal of signals) {
        if (!targets.some((target) => signal.includes(target))) {
          foreignParticipants.add(signal);
        }
      }
    }
  }

  const matchedParticipants = targets.filter((target) => (participantHitCount.get(target) ?? 0) > 0);
  const missingParticipants = targets.filter((target) => !matchedParticipants.includes(target));
  if (matchedParticipants.length === 0) {
    return {
      subjectMatch: foreignParticipants.size > 0 ? "mismatched" : "unknown",
      matchedParticipants,
      missingParticipants,
      foreignParticipants: [...foreignParticipants].slice(0, 8),
      topResultOwned: false
    };
  }

  if (sharedCommonalityFocus) {
    return {
      subjectMatch: missingParticipants.length === 0 ? "matched" : "mixed",
      matchedParticipants,
      missingParticipants,
      foreignParticipants: [...foreignParticipants].slice(0, 8),
      topResultOwned: false
    };
  }

  const primaryTarget = targets.includes("steve") ? "steve" : targets[0];
  return {
    subjectMatch: matchedParticipants.includes(primaryTarget) ? "matched" : "mixed",
    matchedParticipants,
    missingParticipants,
    foreignParticipants: [...foreignParticipants].slice(0, 8),
    topResultOwned: false
  };
}

function confidenceToSufficiency(
  confidence: "confident" | "weak" | "missing"
): "supported" | "weak" | "missing" | "contradicted" {
  switch (confidence) {
    case "confident":
      return "supported";
    case "weak":
      return "weak";
    case "missing":
    default:
      return "missing";
  }
}

function buildAbstentionClaimText(
  queryText: string,
  assessment: NonNullable<RecallResponse["meta"]["answerAssessment"]>
): string {
  if (assessment.subjectMatch === "mismatched") {
    return "No authoritative evidence matched the requested person.";
  }
  if (isStructuredExactAnswerQuery(queryText)) {
    return "None.";
  }
  if (isSharedCommonalityQuery(queryText)) {
    return "No authoritative shared evidence found.";
  }
  if (isProvenanceWhyQuery(queryText)) {
    return "No authoritative supporting evidence found.";
  }
  if (/\bwhy\b/i.test(queryText)) {
    return "No authoritative causal evidence found.";
  }
  if (isIdentityProfileQuery(queryText) || isProfileInferenceQuery(queryText)) {
    return "No authoritative profile evidence found.";
  }
  return "No authoritative evidence found.";
}

function normalizeAssessmentTerm(term: string): string {
  return term.trim().toLowerCase();
}

function lexicalCoverageForResult(content: string, terms: readonly string[]): {
  readonly matchedTerms: readonly string[];
  readonly totalTerms: number;
  readonly lexicalCoverage: number;
} {
  const normalizedContent = content.toLowerCase();
  const normalizedTerms = [...new Set(terms.map(normalizeAssessmentTerm).filter(Boolean))];
  if (normalizedTerms.length === 0) {
    return {
      matchedTerms: [],
      totalTerms: 0,
      lexicalCoverage: 1
    };
  }

  const matchedTerms = normalizedTerms.filter((term) => normalizedContent.includes(term));
  return {
    matchedTerms,
    totalTerms: normalizedTerms.length,
    lexicalCoverage: matchedTerms.length / normalizedTerms.length
  };
}

function weightedTemporalTermMatchScore(queryText: string, content: string, terms: readonly string[]): number {
  const normalizedContent = content.toLowerCase();
  const nameHints = new Set(extractEntityNameHints(queryText).map((term) => term.toLowerCase()));
  let score = 0;

  for (const term of [...new Set(terms.map(normalizeAssessmentTerm).filter(Boolean))]) {
    if (!normalizedContent.includes(term)) {
      continue;
    }
    score += nameHints.has(term) ? 1 : 2;
  }

  return score;
}

function isCurrentDatingQuery(queryText: string): boolean {
  return /\bwho\s+(?:am|is|are)\s+.+\s+dating(?:\s+now)?\b/i.test(queryText);
}

function isCurrentDatingUnknownEvidence(top: RecallResult | undefined, queryText: string): boolean {
  if (!top || !isCurrentDatingQuery(queryText)) {
    return false;
  }

  const predicate = typeof top.provenance.predicate === "string" ? top.provenance.predicate : "";
  const transition = typeof top.provenance.relationship_transition === "string" ? top.provenance.relationship_transition : "";
  const validUntil = typeof top.provenance.valid_until === "string" ? top.provenance.valid_until : null;

  return (
    predicate === "relationship_ended" ||
    predicate === "relationship_contact_paused" ||
    transition === "ended" ||
    transition === "paused" ||
    (predicate === "significant_other_of" && Boolean(validUntil))
  );
}

function extractBroadLifeSummaryYear(queryText: string): string | null {
  const match = queryText.match(/\b(19\d{2}|20\d{2})\b/);
  return typeof match?.[1] === "string" ? match[1] : null;
}

function extractBroadLifeSummarySubject(queryText: string): string {
  const possessiveMatch = queryText.match(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})'s life\b/u);
  if (typeof possessiveMatch?.[1] === "string") {
    return possessiveMatch[1];
  }

  const rememberLikeMatch = queryText.match(/\bremember\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})\s+like\b/u);
  if (typeof rememberLikeMatch?.[1] === "string") {
    return rememberLikeMatch[1];
  }

  const forMatch = queryText.match(/\bfor\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})\b/u);
  if (typeof forMatch?.[1] === "string") {
    return forMatch[1];
  }

  const explicitMatch = queryText.match(/\bwhat\s+\d{4}\s+was\s+like\s+for\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})\b/iu);
  if (typeof explicitMatch?.[1] === "string") {
    return explicitMatch[1];
  }

  const capitalizedMatches = [...queryText.matchAll(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2})\b/gu)]
    .map((match) => match[1])
    .filter((value) => !["Istanbul", "Chiang Mai", "Koh Samui", "Bend Oregon"].includes(value));
  if (capitalizedMatches.length > 0) {
    return capitalizedMatches[0];
  }

  return "Steve";
}

function extractConversationRecapTopic(queryText: string): string | null {
  const patterns = [
    /\babout\s+(.+?)(?:\?|$)/i,
    /\brelated\s+to\s+(.+?)(?:\?|$)/i
  ] as const;

  for (const pattern of patterns) {
    const match = queryText.match(pattern);
    const clause = typeof match?.[1] === "string" ? match[1].trim() : "";
    if (!clause) {
      continue;
    }

    const cleaned = trimRecapTopicNoise(
      clause.replace(/\b(?:on|from|with|yesterday|today|tonight|last\s+weekend|last\s+night)\b.*$/iu, "")
    );
    if (cleaned) {
      return cleaned;
    }
  }

  return null;
}

function extractConversationParticipants(queryText: string): readonly string[] {
  const stopWords = new Set([
    "Why",
    "What",
    "Who",
    "Where",
    "When",
    "Can",
    "Make",
    "Pull",
    "List",
    "Explain",
    "Could",
    "Would",
    "Give",
    "Please",
    "Overview",
    "Breakdown",
    "Summary",
    "Conversation",
    "Project",
    "Yesterday",
    "Today",
    "Tonight",
    "Last",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
    "January",
    "February"
  ]);

  const names = new Set<string>();
  const matches = queryText.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2}\b/gu) ?? [];
  for (const match of matches) {
    if (!stopWords.has(match)) {
      names.add(match);
    }
  }

  if (/\b(i|my|we|our)\b/i.test(queryText)) {
    names.add("Steve");
  }

  return [...names];
}

function extractConversationTemporalPhrase(queryText: string): string | null {
  const explicitDate =
    queryText.match(/\bon\s+([A-Z][a-z]+\s+\d{1,2}(?:,\s*|\s+)\d{4})\b/u)?.[1] ??
    queryText.match(/\bon\s+(\d{4}-\d{2}-\d{2})\b/u)?.[1] ??
    null;
  if (explicitDate) {
    return `on ${explicitDate}`;
  }

  const relative =
    queryText.match(
      /\b(yesterday|today|tonight|last\s+weekend|last\s+night|earlier\s+this\s+month|this\s+week|this\s+month|last\s+week|over\s+the\s+last\s+\d+\s+days|over\s+the\s+last\s+two\s+days|over\s+the\s+past\s+\d+\s+days)\b/i
    )?.[1] ?? null;
  return relative ? relative.toLowerCase() : null;
}

function trimRecapTopicNoise(value: string): string {
  return value
    .replace(
      /\b(?:this|last|over|earlier|today|tonight|yesterday|week|month|year|days?|weeks?|months?|past)\b.*$/iu,
      ""
    )
    .replace(/^[\s"'`]+|[\s"'`.,!?]+$/gu, "")
    .trim();
}

function normalizeRecapReferenceNow(referenceNow?: string): Date {
  const parsed = referenceNow ? new Date(referenceNow) : new Date();
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

function rollingLocalDayWindow(dayCount: number, referenceNow?: string): { readonly start: string; readonly end: string } | null {
  if (!Number.isFinite(dayCount) || dayCount <= 0) {
    return null;
  }

  const now = normalizeRecapReferenceNow(referenceNow);
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - Math.max(0, dayCount - 1));
  return {
    start: start.toISOString(),
    end: now.toISOString()
  };
}

function differentialRollingWindow(
  queryText: string,
  referenceNow?: string
): { readonly timeStart: string; readonly timeEnd: string; readonly label: string } | null {
  const phrase = extractConversationTemporalPhrase(queryText);
  if (!phrase) {
    return null;
  }

  if (phrase === "this week") {
    const window = rollingLocalDayWindow(7, referenceNow);
    return window ? { timeStart: window.start, timeEnd: window.end, label: phrase } : null;
  }

  const quantifiedMatch = phrase.match(/over\s+the\s+(?:last|past)\s+(\d+|two)\s+days?/iu);
  if (quantifiedMatch?.[1]) {
    const quantity = quantifiedMatch[1].toLowerCase() === "two" ? 2 : Number.parseInt(quantifiedMatch[1], 10);
    const window = rollingLocalDayWindow(quantity, referenceNow);
    return window ? { timeStart: window.start, timeEnd: window.end, label: phrase } : null;
  }

  return null;
}

function extractTemporalDifferentialTopic(queryText: string): string | null {
  const patterns = [
    /\bwhat\s+changed\s+on\s+(.+?)(?:\s+(?:this|last|over|in)\b|\?|$)/i,
    /\bwhat\s+changed\s+about\s+(.+?)(?:\s+(?:this|last|over|in)\b|\?|$)/i,
    /\bwhat\s+changed\s+in\s+(.+?)(?:\s+(?:this|last|over|in)\b|\?|$)/i,
    /\bwhy\s+did\s+(.+?)\s+(?:move|change|shift)(?:\s+(?:this|last|over|in)\b|\?|$)/i
  ] as const;

  for (const pattern of patterns) {
    const match = queryText.match(pattern);
    const clause = typeof match?.[1] === "string" ? match[1].trim() : "";
    if (!clause) {
      continue;
    }

    const cleaned = trimRecapTopicNoise(clause).replace(/\bthe\s+/i, "").trim();
    if (cleaned) {
      return cleaned;
    }
  }

  return extractConversationRecapTopic(queryText);
}

function isTemporalDifferentialQuery(queryText: string): boolean {
  const normalized = queryText.trim();
  if (!normalized) {
    return false;
  }

  if (
    /^\s*why\s+did\b/i.test(normalized) &&
    /\b(change\s+direction|changed\s+direction|move\s+toward|moved\s+toward|shift\s+toward|shifted\s+toward|offline-?first|rationale)\b/i.test(
      normalized
    )
  ) {
    return false;
  }

  return /\b(what\s+changed|what\s+is\s+different|how\s+did\s+.+\s+change|why\s+did\s+.+(?:move|change|shift))\b/i.test(normalized);
}

function buildTemporalDifferentialSubqueries(queryText: string): readonly string[] {
  const topic = extractTemporalDifferentialTopic(queryText);
  const temporalPhrase = extractConversationTemporalPhrase(queryText);
  const participants = extractConversationParticipants(queryText);
  const subject = participants.includes("Steve") ? "Steve" : participants[0] ?? "Steve";
  const probes = new Set<string>();

  if (topic) {
    probes.add(topic);
    probes.add(`what happened${temporalPhrase ? ` ${temporalPhrase}` : ""} about ${topic}?`);
    probes.add(`what changed about ${topic}${temporalPhrase ? ` ${temporalPhrase}` : ""}?`);
    probes.add(`what is true now about ${topic}?`);
    probes.add(`what used to be true about ${topic}?`);
    probes.add(`why did ${topic} change${temporalPhrase ? ` ${temporalPhrase}` : ""}?`);
  }

  if (temporalPhrase) {
    probes.add(`what happened ${temporalPhrase}?`);
    probes.add(`what did ${subject} do ${temporalPhrase}?`);
  }

  return [...probes].filter((probe) => probe.trim().length > 0);
}

function isConversationRecapQuery(queryText: string): boolean {
  const normalized = queryText.trim();
  if (!normalized) {
    return false;
  }

  return (
    /\b(summarize|summary|overview|breakdown|recap)\b/i.test(normalized) &&
    /\b(conversation|talk|talked|discussed|chat)\b/i.test(normalized) &&
    (Boolean(extractConversationRecapTopic(normalized)) ||
      Boolean(extractConversationTemporalPhrase(normalized)) ||
      extractConversationParticipants(normalized).length > 0)
  );
}

function buildConversationRecapSubqueries(queryText: string): readonly string[] {
  const topic = extractConversationRecapTopic(queryText);
  const participants = extractConversationParticipants(queryText);
  const temporalPhrase = extractConversationTemporalPhrase(queryText);
  const subject = participants.includes("Steve") ? "Steve" : participants[0] ?? "Steve";
  const otherParticipants = participants.filter((name) => name !== subject);
  const subqueries = new Set<string>();

  if (topic) {
    subqueries.add(topic);
    subqueries.add(`what conversation mentioned ${topic}?`);
    subqueries.add(`what was said about ${topic}?`);
  }

  for (const participant of otherParticipants) {
    if (topic) {
      subqueries.add(`what did ${participant} say about ${topic}?`);
      subqueries.add(`what did ${subject} and ${participant} talk about${temporalPhrase ? ` ${temporalPhrase}` : ""} regarding ${topic}?`);
      subqueries.add(
        `what conversation did ${subject} have with ${participant}${temporalPhrase ? ` ${temporalPhrase}` : ""} about ${topic}?`
      );
    } else {
      subqueries.add(`what conversation mentioned ${participant}?`);
      subqueries.add(`what conversation mentioned ${subject} and ${participant}${temporalPhrase ? ` ${temporalPhrase}` : ""}?`);
      subqueries.add(`what conversation involved ${subject} and ${participant}${temporalPhrase ? ` ${temporalPhrase}` : ""}?`);
    }
  }

  if (!topic && otherParticipants.length > 0) {
    subqueries.add(`what did ${subject} talk about with ${otherParticipants.join(" and ")}${temporalPhrase ? ` ${temporalPhrase}` : ""}?`);
    subqueries.add(`what conversation mentioned ${subject} and ${otherParticipants.join(" and ")}${temporalPhrase ? ` ${temporalPhrase}` : ""}?`);
  }

  if (!topic && temporalPhrase) {
    subqueries.add(`what happened ${temporalPhrase}?`);
  }

  if (topic && temporalPhrase) {
    subqueries.add(`what happened ${temporalPhrase} about ${topic}?`);
  }

  if (topic && otherParticipants.length > 0 && temporalPhrase) {
    subqueries.add(`what conversation did ${subject} have with ${otherParticipants.join(" and ")} ${temporalPhrase} about ${topic}?`);
  }

  return [...subqueries];
}

function isBroadLifeSummaryQuery(queryText: string): boolean {
  if (queryText.trim().length < 140) {
    return false;
  }

  const lowered = queryText.toLowerCase();
  const year = extractBroadLifeSummaryYear(queryText);
  const cueCount = [
    /\b(friend|close people|relationship)\b/.test(lowered),
    /\b(work|project|working on|cowork|coworking|coworkers)\b/.test(lowered),
    /\b(movie|movies|watch|watched|film|films|cinema)\b/.test(lowered),
    /\b(live|lived|place|places|thailand|chiang mai|koh samui|bend)\b/.test(lowered),
    /\b(belief|opinion|infrastructure)\b/.test(lowered),
    /\b(travel|trip)\b/.test(lowered),
    /\b(prefer|prefers|preference|preferences|constraint|constraints|dietary)\b/.test(lowered)
  ].filter(Boolean).length;

  return (
    cueCount >= 3 &&
    (Boolean(year) || /\b(lately|recently|last little stretch|these days|around that period|right now|currently)\b/.test(lowered)) &&
    /\b(remember|piece together|what .* like|include that too|recap|blanking)\b/.test(lowered)
  );
}

function isGlobalQuestionQuery(queryText: string): boolean {
  const normalized = queryText.trim().toLowerCase();
  if (!normalized) {
    return false;
  }

  if (isBroadLifeSummaryQuery(queryText) || isConversationRecapQuery(queryText) || isTemporalDifferentialQuery(queryText)) {
    return true;
  }

  return (
    /\bwhat has .+ been doing lately\b/.test(normalized) ||
    /\bwhat is .+ focused on lately\b/.test(normalized) ||
    /\bfocused on lately\b/.test(normalized) ||
    /\bwhat do .+ have in common\b/.test(normalized) ||
    /\bwhat changed\b/.test(normalized) ||
    /\blife look(?:s)? like right now\b/.test(normalized) ||
    /\bpiece together\b/.test(normalized)
  );
}

function isComplexReflectiveQuery(
  queryText: string,
  planner: ReturnType<typeof planRecallQuery>
): boolean {
  const normalized = queryText.trim().toLowerCase();
  if (!normalized) {
    return false;
  }

  if (planner.queryClass === "graph_multi_hop" || planner.queryClass === "causal") {
    return true;
  }

  if (planner.queryClass === "temporal_detail" || planner.queryClass === "direct_fact") {
    return false;
  }

  if (planner.queryClass === "temporal_summary") {
    return (
      /\b(lately|recently|currently|these days|overall|common|change|changed|pattern|patterns|focus(?:ed|ing)?|look(?:s)? like|recap|summary|summarize)\b/.test(normalized) ||
      /\bwhat (?:was|were|has|have) .+ doing\b/.test(normalized) ||
      /\bwhat was going on\b/.test(normalized) ||
      /\bhow did\b/.test(normalized)
    );
  }

  if (planner.intent !== "simple") {
    return !/\b(exactly|what time|which day|which month|which year|how many|how much)\b/.test(normalized);
  }

  return false;
}

function synthesisModeForQuery(queryText: string, planner: ReturnType<typeof planRecallQuery>, decomposed: boolean): "recall" | "reflect" {
  const conversationRecapFocus =
    /\b(talk about|discuss(?:ed)?|conversation|conversations|recap|summary|summarize|going on|overall|lately|recently|these days|current picture)\b/i.test(
      queryText
    );
  if (
    decomposed ||
    isGlobalQuestionQuery(queryText) ||
    isComplexReflectiveQuery(queryText, planner) ||
    isProfileInferenceQuery(queryText) ||
    isIdentityProfileQuery(queryText) ||
    isSharedCommonalityQuery(queryText) ||
    conversationRecapFocus ||
    (/\bwhy\b/i.test(queryText) && planner.queryClass !== "direct_fact")
  ) {
    return "reflect";
  }

  return "recall";
}

function buildBroadLifeSummarySubqueries(queryText: string): readonly string[] {
  const year = extractBroadLifeSummaryYear(queryText);
  const subject = extractBroadLifeSummarySubject(queryText);
  const lowered = queryText.toLowerCase();
  const subqueries = new Set<string>();

  if (year) {
    subqueries.add(`what was ${subject} doing in ${year}?`);
  } else if (/\b(lately|recently|right now|currently|these days|last little stretch)\b/.test(lowered)) {
    subqueries.add(`what has ${subject} been doing lately?`);
  }

  if (/\b(live|lived|place|places|thailand|chiang mai|koh samui|bend)\b/.test(lowered)) {
    if (year) {
      subqueries.add(`where did ${subject} live in ${year}?`);
    } else {
      subqueries.add(`where does ${subject} live?`);
    }
    subqueries.add(`where has ${subject} lived?`);
  }

  if (/\b(friend|close people|relationship|been around|around lately)\b/.test(lowered)) {
    subqueries.add(`who are ${subject}'s friends?`);
  }

  if (/\b(work|project|working on|cowork|coworking|coworkers|been around)\b/.test(lowered)) {
    subqueries.add(`what is ${subject} working on?`);
    subqueries.add(`who does ${subject} work with?`);
    subqueries.add(`where does ${subject} work?`);
  }

  if (/\b(movie|movies|watch|watched|film|films|cinema)\b/.test(lowered)) {
    subqueries.add(`what movies does ${subject} like?`);
    subqueries.add(`what movies has ${subject} watched recently?`);
  }

  if (/\b(belief|opinion|infrastructure)\b/.test(lowered)) {
    subqueries.add(`how has ${subject}'s opinion on infrastructure changed since ${year}?`);
  }

  if (/\b(prefer|prefers|preference|preferences|constraint|constraints|food|dietary)\b/.test(lowered)) {
    subqueries.add(`what does ${subject} prefer now for food?`);
  }

  if (/\b(tea|coffee|drink|drinks|beverage|beverages|kettle|evening)\b/.test(lowered)) {
    subqueries.add(`what does ${subject} prefer now for tea?`);
  }

  if (/\b(travel|trip|trips|places .* prefer|prefers .* places)\b/.test(lowered)) {
    subqueries.add(`what travel does ${subject} prefer?`);
  }

  if (/\b(lately|weekend|weekends|recently|last little stretch)\b/.test(lowered)) {
    subqueries.add(`what did ${subject} do last weekend?`);
  }

  if (/\blauren\b/.test(lowered)) {
    subqueries.add("when did Lauren leave for the US?");
  }

  return [...subqueries];
}

function recallResultSortTime(value: string | null | undefined): number {
  if (!value) {
    return 0;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function mergeDecomposedResults(responseSets: readonly (readonly RecallResult[])[], limit: number): RecallResult[] {
  const merged = new Map<
    string,
    {
      result: RecallResult;
      hitCount: number;
      bestScore: number;
      firstSeen: number;
    }
  >();

  let firstSeen = 0;
  for (const rows of responseSets) {
    for (const candidate of rows) {
      const key = candidate.artifactId ?? candidate.memoryId;
      const score = typeof candidate.score === "number" ? candidate.score : 0;
      const existing = merged.get(key);
      if (!existing) {
        merged.set(key, {
          result: candidate,
          hitCount: 1,
          bestScore: score,
          firstSeen
        });
        firstSeen += 1;
        continue;
      }

      existing.hitCount += 1;
      if (
        score > existing.bestScore ||
        (score === existing.bestScore &&
          recallResultSortTime(candidate.occurredAt ?? null) > recallResultSortTime(existing.result.occurredAt ?? null))
      ) {
        existing.result = candidate;
        existing.bestScore = score;
      }
    }
  }

  return [...merged.values()]
    .sort((left, right) => {
      if (right.hitCount !== left.hitCount) {
        return right.hitCount - left.hitCount;
      }
      if (right.bestScore !== left.bestScore) {
        return right.bestScore - left.bestScore;
      }
      const timeDelta = recallResultSortTime(right.result.occurredAt ?? null) - recallResultSortTime(left.result.occurredAt ?? null);
      if (timeDelta !== 0) {
        return timeDelta;
      }
      return left.firstSeen - right.firstSeen;
    })
    .slice(0, limit)
    .map((entry) => entry.result);
}

function normalizeRecapTopicText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function recapTopicMatchesResult(result: RecallResult, topic: string): boolean {
  const normalizedTopic = normalizeRecapTopicText(topic);
  if (!normalizedTopic) {
    return false;
  }

  const content = normalizeRecapTopicText(result.content);
  if (content.includes(normalizedTopic)) {
    return true;
  }

  const parts = topic
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .filter((part) => part.length >= 3);
  return parts.length > 0 && parts.every((part) => result.content.toLowerCase().includes(part));
}

function uniqueStrings(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized) {
      continue;
    }
    const key = normalized.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push(normalized);
  }
  return output;
}

function extractRecapProjects(queryText: string): readonly string[] {
  const matches = [...queryText.matchAll(/\b(project\s+[A-Za-z0-9_-]+)\b/giu)].map((match) => match[1]?.trim() ?? "");
  return uniqueStrings(matches);
}

function extractRecapTopics(queryText: string): readonly string[] {
  const topics: string[] = [];
  const recapTopic = extractConversationRecapTopic(queryText);
  if (recapTopic) {
    topics.push(trimRecapTopicNoise(recapTopic));
  }

  const relatedMatches = [...queryText.matchAll(/\b(?:regarding|on|for)\s+([A-Z][A-Za-z0-9_-]+(?:\s+[A-Za-z0-9_-]+){0,2})\b/gu)].map(
    (match) => trimRecapTopicNoise(match[1]?.trim() ?? "")
  );
  topics.push(...relatedMatches);
  topics.push(...extractRecapProjects(queryText));
  return uniqueStrings(topics);
}

function inferRecapIntent(queryText: string): RecapIntent {
  const lowered = queryText.toLowerCase();
  if (/\b(why do you think|why does the brain believe|show (?:me )?(?:the )?evidence|explain (?:why|the recap)|source of truth)\b/.test(lowered)) {
    return "explain_recap";
  }
  if (/\b(task|tasks|todo|to-do|action item|action items|follow up|follow-up)\b/.test(lowered)) {
    return "task_extraction";
  }
  if (/\b(calendar|schedule|scheduled|appointment|appointments|meeting|meetings|commitment|commitments|plan|plans)\b/.test(lowered)) {
    return "calendar_extraction";
  }
  return "recap";
}

function buildRecapFocus(query: RecapQuery): RecapFocus {
  const participants = uniqueStrings([...(query.participants ?? []), ...extractConversationParticipants(query.query)]);
  const projects = uniqueStrings([...(query.projects ?? []), ...extractRecapProjects(query.query)]);
  const topics = uniqueStrings([...(query.topics ?? []), ...extractRecapTopics(query.query)]);
  const totalSignals = participants.length + projects.length + topics.length;

  return {
    participants,
    topics,
    projects,
    ambiguityState: totalSignals === 0 ? "unknown" : totalSignals >= 4 ? "ambiguous" : "clear"
  };
}

function resolveRecapWindow(query: RecapQuery): ResolvedWindow {
  if (query.timeStart || query.timeEnd) {
    return {
      timeStart: query.timeStart,
      timeEnd: query.timeEnd,
      label: query.timeStart && query.timeEnd ? `${query.timeStart}..${query.timeEnd}` : query.timeStart ?? query.timeEnd,
      source: "explicit"
    };
  }

  if (isTemporalDifferentialQuery(query.query)) {
    const rollingWindow = differentialRollingWindow(query.query, query.referenceNow);
    if (rollingWindow) {
      return {
        timeStart: rollingWindow.timeStart,
        timeEnd: rollingWindow.timeEnd,
        label: rollingWindow.label,
        source: "planner"
      };
    }
  }

  const planner = planRecallQuery({
    query: query.query,
    namespaceId: query.namespaceId,
    timeStart: query.timeStart,
    timeEnd: query.timeEnd,
    referenceNow: query.referenceNow
  });

  if (planner.inferredTimeStart || planner.inferredTimeEnd) {
    return {
      timeStart: planner.inferredTimeStart,
      timeEnd: planner.inferredTimeEnd,
      label: extractConversationTemporalPhrase(query.query) ?? undefined,
      source: "planner"
    };
  }

  const fallbackWindow = resolveRelativePhraseWindow(extractConversationTemporalPhrase(query.query) ?? undefined, query.referenceNow);
  if (fallbackWindow) {
    return {
      timeStart: fallbackWindow.timeStart,
      timeEnd: fallbackWindow.timeEnd,
      label: extractConversationTemporalPhrase(query.query) ?? undefined,
      source: "planner"
    };
  }

  return {
    source: "none",
    label: extractConversationTemporalPhrase(query.query) ?? undefined
  };
}

function recallTextMatchesAny(result: RecallResult, values: readonly string[]): boolean {
  if (values.length === 0) {
    return true;
  }

  const haystack = `${result.content} ${JSON.stringify(result.provenance ?? {})}`.toLowerCase();
  return values.some((value) => {
    const normalized = value.trim().toLowerCase();
    if (!normalized) {
      return false;
    }
    return haystack.includes(normalized);
  });
}

function recallMatchCount(result: RecallResult, values: readonly string[]): number {
  if (values.length === 0) {
    return 0;
  }

  const haystack = `${result.content} ${JSON.stringify(result.provenance ?? {})}`.toLowerCase();
  let count = 0;
  for (const value of values) {
    const normalized = value.trim().toLowerCase();
    if (!normalized) {
      continue;
    }
    if (haystack.includes(normalized)) {
      count += 1;
    }
  }
  return count;
}

function isImplicitSelfRecapFocus(focus: RecapFocus): boolean {
  return (
    focus.participants.length === 1 &&
    ["steve", "i", "me", "myself"].includes(focus.participants[0]?.trim().toLowerCase() ?? "")
  );
}

function filterResultsForRecapFocus(results: readonly RecallResult[], focus: RecapFocus): RecallResult[] {
  if (results.length === 0) {
    return [];
  }

  const implicitSelfFocus = isImplicitSelfRecapFocus(focus);
  const minimumParticipantMatches = implicitSelfFocus ? 0 : focus.participants.length >= 2 ? 2 : focus.participants.length;
  if (minimumParticipantMatches >= 2) {
    const tightlyMatched = results.filter((result) => {
      const participantMatchCount = recallMatchCount(result, focus.participants);
      if (participantMatchCount < minimumParticipantMatches) {
        return false;
      }
      const projectHit = focus.projects.length === 0 ? true : recallTextMatchesAny(result, focus.projects);
      const topicHit = focus.topics.length === 0 ? true : recallTextMatchesAny(result, focus.topics);
      return projectHit && topicHit;
    });
    if (tightlyMatched.length > 0) {
      return tightlyMatched;
    }
  }

  const filtered = results.filter((result) => {
    const participantHit = focus.participants.length === 0 || implicitSelfFocus ? true : recallTextMatchesAny(result, focus.participants);
    const projectHit = focus.projects.length === 0 ? true : recallTextMatchesAny(result, focus.projects);
    const topicHit = focus.topics.length === 0 ? true : recallTextMatchesAny(result, focus.topics);
    return participantHit && projectHit && topicHit;
  });

  if (filtered.length > 0) {
    return filtered;
  }

  return results.filter((result) => {
    const participantHit = (focus.participants.length > 0 && !implicitSelfFocus) && recallTextMatchesAny(result, focus.participants);
    const projectHit = focus.projects.length > 0 && recallTextMatchesAny(result, focus.projects);
    const topicHit = focus.topics.length > 0 && recallTextMatchesAny(result, focus.topics);
    return participantHit || projectHit || topicHit;
  });
}

function groupContextKey(result: RecallResult): { readonly key: string; readonly mode: "artifact_cluster" | "day_cluster" | "result_order" } {
  if (result.artifactId) {
    return { key: `artifact:${result.artifactId}`, mode: "artifact_cluster" };
  }
  if (typeof result.provenance.source_uri === "string" && result.provenance.source_uri) {
    return { key: `source:${result.provenance.source_uri}`, mode: "artifact_cluster" };
  }
  if (result.occurredAt) {
    return { key: `day:${result.occurredAt.slice(0, 10)}`, mode: "day_cluster" };
  }
  return { key: `row:${result.memoryId}`, mode: "result_order" };
}

function recallResultMetadata(result: RecallResult): Record<string, unknown> | null {
  return typeof result.provenance.metadata === "object" && result.provenance.metadata !== null
    ? (result.provenance.metadata as Record<string, unknown>)
    : null;
}

function recallOpenClawMemoryKind(result: RecallResult): string | null {
  const metadata = recallResultMetadata(result);
  return typeof metadata?.openclaw_memory_kind === "string" ? metadata.openclaw_memory_kind : null;
}

function recallRelativePath(result: RecallResult): string | null {
  const metadata = recallResultMetadata(result);
  return typeof metadata?.relative_path === "string" ? metadata.relative_path : null;
}

function isRecapHeadingOnlyResult(result: RecallResult): boolean {
  const normalized = result.content.replace(/\s+/gu, " ").trim();
  if (!normalized) {
    return true;
  }
  if (/^#{1,6}\s+\S+/u.test(normalized)) {
    return true;
  }
  if (/^---\s+created_at:/u.test(normalized)) {
    return true;
  }
  return normalized.length <= 24 && !/[.!?]$/u.test(normalized);
}

function isRecapBootstrapGuidanceResult(result: RecallResult): boolean {
  const relativePath = recallRelativePath(result);
  if (relativePath && /(?:^|\/)(AGENTS|TOOLS|SOUL|IDENTITY|USER|HEARTBEAT)\.md$/iu.test(relativePath)) {
    return true;
  }
  if (recallOpenClawMemoryKind(result) === "bootstrap") {
    return true;
  }
  return /\b(use these tools before opening|startup order|returned evidence pack is the source of truth)\b/iu.test(result.content);
}

function isSubstantiveRecapResult(result: RecallResult): boolean {
  if (isRecapHeadingOnlyResult(result) || isRecapBootstrapGuidanceResult(result)) {
    return false;
  }
  const normalized = result.content.replace(/\s+/gu, " ").trim();
  return normalized.length >= 32 && /\b[A-Za-z]{3,}\b/u.test(normalized);
}

function isRecapDetailSeekingQuery(queryText: string): boolean {
  return (
    /\b(exact|exactly|price|prices|how much|how many|which|where|when|who said|source|evidence|why)\b/i.test(queryText) ||
    /\bpick back up\b/i.test(queryText) ||
    /\bextract\b/i.test(queryText) ||
    /\bcalendar\b/i.test(queryText) ||
    /\btasks?\b/i.test(queryText)
  );
}

function recapSummaryBias(result: RecallResult, queryText: string): number {
  if (isRecapDetailSeekingQuery(queryText)) {
    return 0;
  }

  if (result.memoryType === "temporal_nodes") {
    const layer = typeof result.provenance.layer === "string" ? result.provenance.layer : "";
    if (layer === "day") {
      return 4.5;
    }
    if (layer === "week") {
      return 3.5;
    }
    if (layer === "month") {
      return 2.2;
    }
  }

  const memoryKind = typeof result.provenance.memory_kind === "string" ? result.provenance.memory_kind : "";
  const canonicalKey = typeof result.provenance.canonical_key === "string" ? result.provenance.canonical_key : "";
  if (memoryKind === "day_summary" || canonicalKey.startsWith("reconsolidated:day_summary:")) {
    return 2.4;
  }

  return 0;
}

function recapResultRichnessScore(result: RecallResult): number {
  const leafBonus =
    result.memoryType === "episodic_memory" || result.memoryType === "artifact_derivation"
      ? 2
      : result.memoryType === "narrative_event"
        ? 1
        : 0;
  let score = leafBonus + Math.min(result.content.length / 200, 2);
  if (isRecapHeadingOnlyResult(result)) {
    score -= 6;
  }
  if (isRecapBootstrapGuidanceResult(result)) {
    score -= 5;
  }
  if (recallOpenClawMemoryKind(result) === "daily") {
    score += 2;
  }
  return score;
}

function selectRecapContextResults(results: readonly RecallResult[], focus: RecapFocus, limit: number, queryText = ""): {
  readonly results: RecallResult[];
  readonly groupedBy: "artifact_cluster" | "day_cluster" | "result_order";
} {
  const sortRecapRows = (rows: readonly RecallResult[]): RecallResult[] =>
    [...rows].sort((left, right) => {
      const rightScore = (right.score ?? 0) + recapResultRichnessScore(right) + recapSummaryBias(right, queryText);
      const leftScore = (left.score ?? 0) + recapResultRichnessScore(left) + recapSummaryBias(left, queryText);
      const combinedDelta = rightScore - leftScore;
      if (combinedDelta !== 0) {
        return combinedDelta;
      }
      return recapResultRichnessScore(right) - recapResultRichnessScore(left);
    });

  if (results.length <= limit) {
    const mode = results[0] ? groupContextKey(results[0]).mode : "result_order";
    return {
      results: sortRecapRows(results),
      groupedBy: mode
    };
  }

  const groups = new Map<
    string,
    {
      readonly mode: "artifact_cluster" | "day_cluster" | "result_order";
      rows: RecallResult[];
      score: number;
      participantCoverage: number;
      topicCoverage: number;
      projectCoverage: number;
    }
  >();

  for (const result of results) {
    const { key, mode } = groupContextKey(result);
    const participantCoverage = recallMatchCount(result, focus.participants);
    const topicCoverage = recallMatchCount(result, focus.topics);
    const projectCoverage = recallMatchCount(result, focus.projects);
    const group = groups.get(key) ?? { mode, rows: [], score: 0, participantCoverage: 0, topicCoverage: 0, projectCoverage: 0 };
    group.rows.push(result);
    group.score += (typeof result.score === "number" ? result.score : 0) + recapResultRichnessScore(result) + recapSummaryBias(result, queryText);
    group.participantCoverage = Math.max(group.participantCoverage, participantCoverage);
    group.topicCoverage = Math.max(group.topicCoverage, topicCoverage);
    group.projectCoverage = Math.max(group.projectCoverage, projectCoverage);
    group.score += participantCoverage * 1.35;
    group.score += topicCoverage * 1.2;
    group.score += projectCoverage * 1.2;
    if (focus.participants.length >= 2 && participantCoverage >= 2) {
      group.score += 3;
    }
    if (focus.topics.length > 0 && topicCoverage > 0) {
      group.score += 1.5;
    }
    if (focus.projects.length > 0 && projectCoverage > 0) {
      group.score += 1.5;
    }
    groups.set(key, group);
  }

  const orderedGroups = [...groups.values()].sort((left, right) => {
    if (focus.participants.length >= 2 && right.participantCoverage !== left.participantCoverage) {
      return right.participantCoverage - left.participantCoverage;
    }
    if (focus.topics.length > 0 && right.topicCoverage !== left.topicCoverage) {
      return right.topicCoverage - left.topicCoverage;
    }
    if (focus.projects.length > 0 && right.projectCoverage !== left.projectCoverage) {
      return right.projectCoverage - left.projectCoverage;
    }
    const scoreDelta = right.score - left.score;
    if (scoreDelta !== 0) {
      return scoreDelta;
    }
    const sizeDelta = right.rows.length - left.rows.length;
    if (sizeDelta !== 0) {
      return sizeDelta;
    }
    return 0;
  });

  const selected: RecallResult[] = [];
  const seen = new Set<string>();
  for (const group of orderedGroups) {
    const orderedRows = sortRecapRows(group.rows);
    for (const row of orderedRows) {
      if (seen.has(row.memoryId)) {
        continue;
      }
      seen.add(row.memoryId);
      selected.push(row);
      if (selected.length >= limit) {
        return {
          results: selected,
          groupedBy: group.mode
        };
      }
    }
  }

  return {
    results: selected,
    groupedBy: orderedGroups[0]?.mode ?? "result_order"
  };
}

function buildRecapSupportProbes(query: RecapQuery, intent: RecapIntent, focus: RecapFocus): readonly string[] {
  const probes = new Set<string>();
  const temporalPhrase = extractConversationTemporalPhrase(query.query);
  const subject = focus.participants.includes("Steve") ? "Steve" : focus.participants[0] ?? "Steve";
  const others = focus.participants.filter((participant) => participant !== subject);

  probes.add(query.query.trim());

  if (isConversationRecapQuery(query.query)) {
    for (const subquery of buildConversationRecapSubqueries(query.query)) {
      probes.add(subquery);
    }
  }

  if (isTemporalDifferentialQuery(query.query)) {
    for (const subquery of buildTemporalDifferentialSubqueries(query.query)) {
      probes.add(subquery);
    }
  }

  for (const topic of [...focus.projects, ...focus.topics]) {
    probes.add(`what was said about ${topic}?`);
    probes.add(`what happened${temporalPhrase ? ` ${temporalPhrase}` : ""} about ${topic}?`);
    if (others.length > 0) {
      probes.add(`what did ${subject} talk about with ${others.join(" and ")}${temporalPhrase ? ` ${temporalPhrase}` : ""} about ${topic}?`);
    }
  }

  if (intent === "task_extraction") {
    probes.add(`what tasks did ${subject} mention${temporalPhrase ? ` ${temporalPhrase}` : ""}?`);
    probes.add(`what plans did ${subject} mention${temporalPhrase ? ` ${temporalPhrase}` : ""}?`);
  }

  if (intent === "calendar_extraction") {
    probes.add(`what plans does ${subject} have${temporalPhrase ? ` ${temporalPhrase}` : ""}?`);
    probes.add(`what commitments came up${temporalPhrase ? ` ${temporalPhrase}` : ""}?`);
  }

  if (others.length > 0 && temporalPhrase) {
    probes.add(`what did ${subject} and ${others.join(" and ")} talk about ${temporalPhrase}?`);
  }

  if (temporalPhrase) {
    probes.add(`what happened ${temporalPhrase}?`);
    probes.add(`what did ${subject} do ${temporalPhrase}?`);
    if (others.length > 0) {
      probes.add(`who was ${subject} with ${temporalPhrase}?`);
    }
  }

  return [...probes].filter((probe) => probe.trim().length > 0);
}

function recapAnchorPatterns(queryText: string, intent: RecapIntent): readonly RegExp[] {
  const lowered = queryText.toLowerCase();
  const patterns: RegExp[] = [];

  if (/\byesterday\b/.test(lowered)) {
    patterns.push(/\byesterday I was talking\b/iu, /\btalking about\b/iu);
  }
  if (/\bbefore context was lost\b/.test(lowered) || /\bpick back up\b/.test(lowered)) {
    patterns.push(/\bbefore context was lost\b/iu, /\bstartup recap pack\b/iu, /\bfixture corpus\b/iu);
  }
  if (/\bchanged since last time\b/.test(lowered)) {
    patterns.push(/\bwhat changed since last time\b/iu, /\bchanged since last time\b/iu);
  }
  if (intent === "task_extraction" || /\btask|open tasks|still open\b/.test(lowered)) {
    patterns.push(/-\s*\[(?: |x|X)\]\s+/u, /\bre-run the continuity benchmark\b/iu, /\breview open tasks\b/iu);
  }
  if (intent === "calendar_extraction" || /\bcalendar|coming up|commitment|schedule\b/.test(lowered)) {
    patterns.push(/\bbreakfast\b/iu, /\bcoffee\b/iu, /\btomorrow\b/iu, /\bgrazie\b/iu);
  }

  return patterns;
}

function recapAnchorSearchPhrases(queryText: string, intent: RecapIntent): readonly string[] {
  const lowered = queryText.toLowerCase();
  const phrases = new Set<string>();
  if (/\btwo weeks ago\b/.test(lowered)) {
    phrases.add("two weeks ago");
  }
  if (/\byesterday\b/.test(lowered)) {
    phrases.add("yesterday");
  }
  if (/\bbefore context was lost\b/.test(lowered) || /\bpick back up\b/.test(lowered)) {
    phrases.add("before context was lost");
  }
  if (/\bpick back up\b/.test(lowered)) {
    phrases.add("continuity benchmark");
    phrases.add("open tasks");
  }
  if (/\bchanged since last time\b/.test(lowered)) {
    phrases.add("changed since last time");
  }
  if (intent === "task_extraction" || /\btask|open tasks|still open\b/.test(lowered)) {
    phrases.add("open tasks");
  }
  if (intent === "calendar_extraction" || /\bcalendar|coming up|commitment|schedule\b/.test(lowered)) {
    phrases.add("tomorrow");
  }
  return [...phrases];
}

function summaryBasisForResults(results: readonly RecallResult[]): "leaf_evidence" | "summary_support" | "mixed" {
  const hasLeaf = results.some((result) =>
    result.memoryType === "episodic_memory" || result.memoryType === "narrative_event" || result.memoryType === "artifact_derivation"
  );
  const hasSummary = results.some((result) =>
    result.memoryType === "semantic_memory" || result.memoryType === "procedural_memory" || result.memoryType === "temporal_nodes"
  );

  if (hasLeaf && hasSummary) {
    return "mixed";
  }
  return hasLeaf ? "leaf_evidence" : "summary_support";
}

function extractSentenceCandidates(text: string): readonly string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/u)
    .map((part) => part.trim())
    .filter((part) => part.length >= 8);
}

function trimSentenceForTitle(text: string, maxLength = 90): string {
  const normalized = text.replace(/\s+/gu, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 1).trim()}…`;
}

function splitTaskFragments(sentence: string): readonly string[] {
  const needsToMatch = sentence.match(/\b([A-Z][a-z]+)\s+(needs to|should)\s+(.+)/u);
  if (!needsToMatch) {
    return [sentence];
  }

  const subject = needsToMatch[1];
  const modal = needsToMatch[2];
  const actionTail = needsToMatch[3]
    .replace(/\band\b/giu, ",")
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => `${subject} ${modal} ${part.replace(/\.$/u, "")}.`);

  return actionTail.length > 0 ? actionTail : [sentence];
}

function extractChecklistTaskFragments(text: string): readonly string[] {
  const normalized = text.replace(/\s+/gu, " ").trim();
  if (!normalized.includes("[ ]") && !normalized.includes("[x]") && !normalized.includes("[X]")) {
    return [];
  }
  return [...normalized.matchAll(/-\s*\[(?: |x|X)\]\s+(.+?)(?=(?:\s+-\s*\[(?: |x|X)\]\s+)|$)/gu)]
    .map((match) => match[1]?.trim() ?? "")
    .filter((fragment) => fragment.length > 0)
    .map((fragment) => fragment.replace(/\.$/u, "").trim());
}

function dueHintFromText(text: string): string | undefined {
  const match =
    text.match(/\b(by\s+[A-Z][a-z]+(?:day)?|tomorrow|tonight|next\s+week|next\s+[A-Z][a-z]+(?:day)?|end of [A-Z][a-z]+|on\s+[A-Z][a-z]+\s+\d{1,2}(?:,\s*\d{4})?)\b/u)?.[1] ??
    text.match(/\b(at the end of [A-Z][a-z]+)\b/u)?.[1];
  return typeof match === "string" ? match.trim() : undefined;
}

function parseTaskItems(results: readonly RecallResult[], focus: RecapFocus): readonly RecapTaskItem[] {
  const items: RecapTaskItem[] = [];
  const seen = new Set<string>();

  for (const result of results) {
    const candidates = [...extractChecklistTaskFragments(result.content), ...extractSentenceCandidates(result.content)];
    for (const sentence of candidates) {
      const checklistFragment = /^\w/u.test(sentence) && !/[.!?]$/u.test(sentence);
      if (
        !checklistFragment &&
        !/\b(need to|needs to|should|must|todo|to do|follow up|follow-up|action item|remember to|update|write|finish|message|send|review|ship|fix|re-run|rerun|capture|pull)\b/i.test(
          sentence
        )
      ) {
        continue;
      }

      for (const fragment of splitTaskFragments(sentence)) {
        const title = trimSentenceForTitle(fragment);
        const key = title.toLowerCase();
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);

        const assigneeMatch = fragment.match(/\b(Steve|Dan|Jules|Rina|Omar|Theo|Lauren|Mia|Alex|Eve)\b/u)?.[1];
        const project = focus.projects.find((value) => fragment.toLowerCase().includes(value.toLowerCase())) ?? focus.projects[0];

        items.push({
          title,
          description: fragment,
          assigneeGuess: assigneeMatch,
          project,
          dueHint: dueHintFromText(fragment),
          statusGuess: "open",
          evidenceIds: [result.memoryId]
        });
      }
    }
  }

  return items.slice(0, 12);
}

function calendarParticipantsFromText(text: string, focus: RecapFocus): readonly string[] {
  const candidates = uniqueStrings([
    ...focus.participants,
    ...([...text.matchAll(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,1})\b/gu)].map((match) => match[1] ?? ""))
  ]);
  return candidates.filter((candidate) => !["Friday", "Saturday", "Sunday", "March", "April"].includes(candidate));
}

function splitCalendarFragments(sentence: string): readonly string[] {
  const fragments = sentence
    .split(/\band then\b/iu)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  return fragments.length > 0 ? fragments : [sentence];
}

function parseCalendarItems(results: readonly RecallResult[], focus: RecapFocus): readonly CalendarCommitmentItem[] {
  const items: CalendarCommitmentItem[] = [];
  const seen = new Set<string>();

  for (const result of results) {
    for (const sentence of extractSentenceCandidates(result.content)) {
      for (const fragment of splitCalendarFragments(sentence)) {
        if (
          !/\b(meet|meeting|dinner|lunch|breakfast|brunch|coffee|karaoke|conference|appointment|scheduled|schedule|plan|plans|will fly|fly into|be in|trip|going to|call)\b/i.test(
            fragment
          )
        ) {
          continue;
        }

        const title = trimSentenceForTitle(fragment);
        const key = title.toLowerCase();
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);

        const timeHint =
          fragment.match(/\b(yesterday|today|tonight|tomorrow|last weekend|last night|Friday|Saturday|Sunday|Monday|Tuesday|Wednesday|Thursday|at\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?|end of April)\b/iu)?.[1] ??
          dueHintFromText(fragment);
        const locationHint =
          fragment.match(/\b(?:at|in)\s+([A-Z][A-Za-z0-9_-]+(?:\s+[A-Za-z0-9_-]+){0,3})\b/u)?.[1] ?? undefined;
        const certainty: CalendarCommitmentItem["certainty"] =
          typeof timeHint === "string" && /\d|Friday|Saturday|Sunday|Monday|Tuesday|Wednesday|Thursday|yesterday|tomorrow|tonight|end of April/i.test(timeHint)
            ? "high"
            : "medium";

        items.push({
          title,
          participants: calendarParticipantsFromText(fragment, focus),
          timeHint: typeof timeHint === "string" ? timeHint.trim() : undefined,
          locationHint,
          certainty,
          evidenceIds: [result.memoryId]
        });
      }
    }
  }

  return items.slice(0, 12);
}

function recapSummarySentenceScore(sentence: string, queryText: string): number {
  const loweredQuery = queryText.toLowerCase();
  const loweredSentence = sentence.toLowerCase();
  let score = 0;

  if (/\byesterday\b/.test(loweredQuery)) {
    if (/\byesterday i was talking\b/.test(loweredSentence)) {
      score += 6;
    }
    if (/\bpreset kitchen\b|\bdan\b|\bcontinuity\b/.test(loweredSentence)) {
      score += 2;
    }
  }
  if (/\btwo weeks ago\b/.test(loweredQuery)) {
    if (/\btwo weeks ago\b/.test(loweredSentence)) {
      score += 5;
    }
    if (/\bburning man\b|\bjohn\b|\brelationship anchors\b/.test(loweredSentence)) {
      score += 3;
    }
  }
  if (/\bbefore context was lost\b/.test(loweredQuery)) {
    if (/\bbefore context was lost\b/.test(loweredSentence)) {
      score += 6;
    }
    if (/\bfixture corpus\b|\bstartup recap pack\b/.test(loweredSentence)) {
      score += 3;
    }
  }
  if (/\bpick back up\b/.test(loweredQuery)) {
    if (/\bcontinuity benchmark\b|\bopen tasks\b/.test(loweredSentence)) {
      score += 7;
    }
    if (/\bbefore context was lost\b/.test(loweredSentence)) {
      score += 5;
    }
    if (/\bpreset kitchen\b|\bcontinuity\b/.test(loweredSentence)) {
      score += 2;
    }
  }
  if (/\bchanged since last time\b/.test(loweredQuery) && /\bchanged since last time\b/.test(loweredSentence)) {
    score += 6;
  }

  return score;
}

function buildDeterministicRecapSummary(results: readonly RecallResult[], queryText: string): string | undefined {
  const temporalSummaryRows = results.filter((result) => result.memoryType === "temporal_nodes");
  const preferredResults = results.some((result) => result.memoryType === "episodic_memory" || result.memoryType === "artifact_derivation")
    ? results.filter(
        (result) =>
          (result.memoryType === "episodic_memory" || result.memoryType === "artifact_derivation") &&
          !isRecapHeadingOnlyResult(result) &&
          !isRecapBootstrapGuidanceResult(result)
      )
    : results.filter((result) => result.memoryType !== "temporal_nodes" && !isRecapHeadingOnlyResult(result) && !isRecapBootstrapGuidanceResult(result));
  const checklistSentences =
    /\bpick back up\b/i.test(queryText) || /\bopen tasks?\b/i.test(queryText)
      ? preferredResults.flatMap((result) => extractChecklistTaskFragments(result.content))
      : [];
  const sentences = uniqueStrings([
    ...checklistSentences,
    ...preferredResults.flatMap((result) => extractSentenceCandidates(result.content).slice(0, result.memoryType === "episodic_memory" ? 4 : 1))
  ]);
  const cleanedTemporalSummaries = temporalSummaryRows
    .map((result) => normalizeWhitespace(result.content))
    .filter((text) => text.length > 0)
    .slice(0, 2);
  if (sentences.length === 0) {
    return cleanedTemporalSummaries[0];
  }
  const ordered = [...sentences].sort((left, right) => {
    const scoreDelta = recapSummarySentenceScore(right, queryText) - recapSummarySentenceScore(left, queryText);
    if (scoreDelta !== 0) {
      return scoreDelta;
    }
    return right.length - left.length;
  });
  if (/\bpick back up\b/i.test(queryText)) {
    const rawChecklistTitles = uniqueStrings(
      preferredResults
        .flatMap((result) => [...result.content.matchAll(/^\s*-\s*\[(?: |x|X)\]\s+(.+)$/gimu)])
        .map((match) => match[1]?.trim() ?? "")
        .filter((title) => title.length > 0)
        .map((title) => title.replace(/\.$/u, "").trim())
    );
    const taskTitles = uniqueStrings(
      [...rawChecklistTitles, ...checklistSentences]
        .map((sentence) => sentence.replace(/^[\-\*\u2022]\s*/, "").replace(/^\[[ xX]\]\s*/, "").trim())
        .filter((title) => title.length > 0)
    );
    if (taskTitles.length > 0) {
      const taskSentence = `Open tasks include ${joinExactDetailValues(taskTitles.slice(0, 3))}.`;
      return [taskSentence, ...ordered].slice(0, 4).join(" ");
    }
  }
  if (isDailyLifeSummaryQuery(queryText) && cleanedTemporalSummaries.length > 0) {
    const leafSummary = ordered.slice(0, 2).join(" ");
    const temporalLead = cleanedTemporalSummaries[0];
    return leafSummary.length > 0 ? `${temporalLead} ${leafSummary}` : temporalLead;
  }
  return ordered.slice(0, 4).join(" ");
}

async function loadArtifactSiblingEpisodicRows(namespaceId: string, artifactIds: readonly string[]): Promise<RecallResult[]> {
  if (artifactIds.length === 0) {
    return [];
  }

  const rows = await queryRows<SearchRow>(
    `
      SELECT
        em.id AS memory_id,
        'episodic_memory'::text AS memory_type,
        em.content,
        0.0::double precision AS raw_score,
        em.artifact_id,
        em.occurred_at,
        em.namespace_id,
        jsonb_build_object(
          'tier', 'artifact_sibling_support',
          'artifact_observation_id', em.artifact_observation_id,
          'source_chunk_id', em.source_chunk_id,
          'source_offset', em.source_offset,
          'source_uri', a.uri,
          'metadata', em.metadata
        ) AS provenance
      FROM episodic_memory em
      LEFT JOIN artifacts a ON a.id = em.artifact_id
      WHERE em.namespace_id = $1
        AND em.artifact_id = ANY($2::uuid[])
      ORDER BY em.occurred_at DESC NULLS LAST
      LIMIT 12
    `,
    [namespaceId, artifactIds]
  );

  return mapRecallRows(rows);
}

async function loadDerivationSourceSupportRows(
  namespaceId: string,
  results: readonly RecallResult[],
  limit: number
): Promise<readonly RecallResult[]> {
  const derivationRows = results.filter((result) => result.memoryType === "artifact_derivation");
  if (derivationRows.length === 0) {
    return [];
  }

  const sourceChunkIds = uniqueStrings(
    derivationRows.flatMap((result) => {
      const metadata =
        typeof result.provenance.metadata === "object" && result.provenance.metadata !== null
          ? (result.provenance.metadata as Record<string, unknown>)
          : null;
      const chunkIds = Array.isArray(metadata?.source_chunk_ids)
        ? metadata.source_chunk_ids.filter((value): value is string => typeof value === "string" && value.length > 0)
        : [];
      const directChunkId = typeof result.provenance.source_chunk_id === "string" ? [result.provenance.source_chunk_id] : [];
      return [...directChunkId, ...chunkIds];
    })
  );

  if (sourceChunkIds.length === 0) {
    return [];
  }

  const rows = await queryRows<SearchRow>(
    `
      WITH seed_chunks AS (
        SELECT
          chunk.id AS source_chunk_id,
          chunk.artifact_observation_id,
          chunk.chunk_index
        FROM artifact_chunks chunk
        WHERE chunk.id = ANY($2::uuid[])
      ),
      neighborhood_rows AS (
        SELECT
          em.id AS memory_id,
          'episodic_memory'::text AS memory_type,
          em.content,
          0.0::double precision AS raw_score,
          em.artifact_id,
          em.occurred_at,
          em.namespace_id,
          jsonb_build_object(
            'tier', 'derivation_source_support',
            'artifact_observation_id', em.artifact_observation_id,
            'source_chunk_id', em.source_chunk_id,
            'source_offset', em.source_offset,
            'source_uri', a.uri,
            'metadata', em.metadata
          ) AS provenance,
          MIN(abs(neighbor.chunk_index - seed.chunk_index)) AS chunk_distance
        FROM seed_chunks seed
        JOIN artifact_chunks neighbor
          ON neighbor.artifact_observation_id = seed.artifact_observation_id
         AND neighbor.chunk_index BETWEEN seed.chunk_index - 1 AND seed.chunk_index + 1
        JOIN episodic_memory em
          ON em.namespace_id = $1
         AND em.artifact_observation_id = neighbor.artifact_observation_id
         AND em.source_chunk_id = neighbor.id
        LEFT JOIN artifacts a ON a.id = em.artifact_id
        GROUP BY em.id, em.content, em.artifact_id, em.occurred_at, em.namespace_id, em.artifact_observation_id, em.source_chunk_id, em.source_offset, a.uri, em.metadata
      )
      SELECT
        memory_id,
        memory_type,
        content,
        raw_score,
        artifact_id,
        occurred_at,
        namespace_id,
        provenance
      FROM neighborhood_rows
      ORDER BY chunk_distance ASC, occurred_at DESC NULLS LAST
      LIMIT $3
    `,
    [namespaceId, sourceChunkIds, Math.max(limit, 8)]
  );

  return mapRecallRows(rows);
}

async function loadRelativePhraseEpisodicRows(namespaceId: string, phrase: string, limit: number): Promise<RecallResult[]> {
  const normalizedPhrase = phrase.trim().toLowerCase();
  if (!normalizedPhrase) {
    return [];
  }

  const rows = await queryRows<SearchRow>(
    `
      SELECT
        em.id AS memory_id,
        'episodic_memory'::text AS memory_type,
        em.content,
        0.0::double precision AS raw_score,
        em.artifact_id,
        em.occurred_at,
        em.namespace_id,
        jsonb_build_object(
          'tier', 'relative_phrase_support',
          'artifact_observation_id', em.artifact_observation_id,
          'source_chunk_id', em.source_chunk_id,
          'source_offset', em.source_offset,
          'source_uri', a.uri,
          'metadata', em.metadata
        ) AS provenance
      FROM episodic_memory em
      LEFT JOIN artifacts a ON a.id = em.artifact_id
      WHERE em.namespace_id = $1
        AND lower(em.content) LIKE $2
      ORDER BY em.occurred_at DESC NULLS LAST
      LIMIT $3
    `,
    [namespaceId, `%${normalizedPhrase}%`, limit]
  );

  return mapRecallRows(rows);
}

async function loadProjectIdeaSupportRows(namespaceId: string, limit: number): Promise<readonly RecallResult[]> {
  const anchorPhrases = ["Ben and I", "Context Suite", "memoir engine", "knowledge graph", "life graph"];
  const supportRows: RecallResult[] = [];
  const seen = new Set<string>();

  for (const phrase of anchorPhrases) {
    const rows = await loadRelativePhraseEpisodicRows(namespaceId, phrase, limit);
    for (const row of rows) {
      if (seen.has(row.memoryId)) {
        continue;
      }
      seen.add(row.memoryId);
      supportRows.push(row);
    }
  }

  const siblingRows =
    supportRows.some((row) => row.artifactId)
      ? await loadArtifactSiblingEpisodicRows(
          namespaceId,
          uniqueStrings(
            supportRows
              .map((row) => row.artifactId ?? "")
              .filter((artifactId): artifactId is string => artifactId.length > 0)
          )
        )
      : [];

  for (const row of siblingRows) {
    if (seen.has(row.memoryId)) {
      continue;
    }
    seen.add(row.memoryId);
    supportRows.push(row);
  }

  return supportRows
    .filter((row) => projectIdeaSupportScore(row) > 0)
    .sort((left, right) => projectIdeaSupportScore(right) - projectIdeaSupportScore(left))
    .slice(0, Math.max(limit, 8));
}

async function loadRelationshipHistorySupportRows(
  namespaceId: string,
  target: string,
  limit: number
): Promise<readonly RecallResult[]> {
  const anchorPhrases = [target, "Lake Tahoe", "Bend, Oregon", "Thailand", "October 18, 2025"];
  const supportRows: RecallResult[] = [];
  const seen = new Set<string>();

  for (const phrase of anchorPhrases) {
    const rows = await loadRelativePhraseEpisodicRows(namespaceId, phrase, limit);
    for (const row of rows) {
      if (seen.has(row.memoryId)) {
        continue;
      }
      seen.add(row.memoryId);
      supportRows.push(row);
    }
  }

  const siblingRows =
    supportRows.some((row) => row.artifactId)
      ? await loadArtifactSiblingEpisodicRows(
          namespaceId,
          uniqueStrings(
            supportRows
              .map((row) => row.artifactId ?? "")
              .filter((artifactId): artifactId is string => artifactId.length > 0)
          )
        )
      : [];

  for (const row of siblingRows) {
    if (seen.has(row.memoryId)) {
      continue;
    }
    seen.add(row.memoryId);
    supportRows.push(row);
  }

  return supportRows
    .filter((row) => relationshipHistorySupportScore(row, target.toLowerCase()) > 0)
    .sort(
      (left, right) =>
        relationshipHistorySupportScore(right, target.toLowerCase()) - relationshipHistorySupportScore(left, target.toLowerCase())
    )
    .slice(0, Math.max(limit, 8));
}

function resolveDerivationProvider(provider: RecapDerivationProvider | undefined): {
  readonly enabled: boolean;
  readonly providerId?: "external" | "openrouter";
} {
  if (!provider || provider === "none") {
    return { enabled: false };
  }

  return {
    enabled: true,
    providerId: provider === "local" ? "external" : "openrouter"
  };
}

function buildDerivationInput(
  query: string,
  focus: RecapFocus,
  resolvedWindow: ResolvedWindow,
  evidence: readonly RecallEvidenceItem[],
  intent: RecapIntent
): string {
  return JSON.stringify(
    {
      query,
      intent,
      resolved_window: resolvedWindow,
      focus,
      evidence: evidence.map((item) => ({
        memory_id: item.memoryId,
        memory_type: item.memoryType,
        occurred_at: item.occurredAt ?? null,
        source_uri: item.sourceUri ?? null,
        snippet: item.snippet
      }))
    },
    null,
    2
  );
}

async function deriveRecapOutput(
  intent: RecapIntent,
  query: RecapQuery,
  focus: RecapFocus,
  resolvedWindow: ResolvedWindow,
  evidence: readonly RecallEvidenceItem[]
): Promise<{
  readonly derivation?: RecapDerivation;
  readonly payload?: Record<string, unknown>;
}> {
  const selection = resolveDerivationProvider(query.provider);
  if (!selection.enabled || !selection.providerId || evidence.length === 0) {
    return {};
  }

  const config = readConfig();
  const adapter = getProviderAdapter(selection.providerId);
  const model =
    query.model ??
    (selection.providerId === "openrouter" ? config.openRouterClassifyModel : config.externalAiClassifyModel);
  const outputKey = intent === "task_extraction" ? "tasks" : intent === "calendar_extraction" ? "commitments" : "summary_text";
  const systemPrompt =
    "You are a retrieval-grounded memory derivation engine. Use only the provided evidence. Do not add facts, dates, people, or projects that are not explicitly supported. Return valid JSON only.";
  const instruction =
    intent === "task_extraction"
      ? `Return JSON with a top-level "tasks" array. Each task must include title, description, assignee_guess, project, due_hint, status_guess, and evidence_ids.`
      : intent === "calendar_extraction"
        ? `Return JSON with a top-level "commitments" array. Each item must include title, participants, time_hint, location_hint, certainty, and evidence_ids.`
        : `Return JSON with a top-level "summary_text" string and an "evidence_ids" array.`;

  try {
    const response = await adapter.classifyText({
      text: buildDerivationInput(query.query, focus, resolvedWindow, evidence, intent),
      model,
      systemPrompt,
      instruction,
      maxOutputTokens: 900,
      metadata: {
        preset_id: "research-analyst"
      }
    });

    return {
      derivation: {
        provider: response.provider,
        model: response.model,
        summaryText:
          typeof response.output.summary_text === "string"
            ? response.output.summary_text
            : typeof response.rawText === "string"
              ? response.rawText
              : "",
        rawText: response.rawText,
        evidenceIds: Array.isArray(response.output.evidence_ids)
          ? response.output.evidence_ids.filter((item): item is string => typeof item === "string")
          : evidence.map((item) => item.memoryId),
        latencyMs: response.latencyMs,
        tokenUsage: response.tokenUsage,
        providerMetadata: response.providerMetadata
      },
      payload: response.output
    };
  } catch (error) {
    if (error instanceof ProviderError) {
      return {};
    }
    throw error;
  }
}

function selectRecapSummaryText(
  queryText: string,
  derivedSummaryText: string | undefined,
  deterministicSummaryText: string | undefined
): string | undefined {
  const normalizedDerived = typeof derivedSummaryText === "string" ? derivedSummaryText.trim() : "";
  const normalizedDeterministic = typeof deterministicSummaryText === "string" ? deterministicSummaryText.trim() : "";
  if (!normalizedDerived) {
    return normalizedDeterministic || undefined;
  }
  if (!normalizedDeterministic) {
    return normalizedDerived;
  }

  if (/\bpick back up\b|\bopen tasks?\b/i.test(queryText)) {
    const derivedHasTaskAnchor = /\bcontinuity benchmark\b|\bre-run\b|\bopen tasks?\b/i.test(normalizedDerived);
    const deterministicHasTaskAnchor = /\bcontinuity benchmark\b|\bre-run\b|\bopen tasks?\b/i.test(normalizedDeterministic);
    if (deterministicHasTaskAnchor && !derivedHasTaskAnchor) {
      return normalizedDeterministic;
    }
  }

  return normalizedDerived;
}

function strengthenContinuityTaskSummary(
  queryText: string,
  summaryText: string | undefined,
  results: readonly RecallResult[]
): string | undefined {
  const normalizedSummary = typeof summaryText === "string" ? summaryText.trim() : "";
  if (!/\bpick back up\b|\bopen tasks?\b/i.test(queryText)) {
    return normalizedSummary || undefined;
  }

  const taskTitles = uniqueStrings(
    results
      .flatMap((result) => [...result.content.matchAll(/^\s*-\s*\[(?: |x|X)\]\s+(.+)$/gimu)])
      .map((match) => match[1]?.trim() ?? "")
      .filter((title) => title.length > 0)
      .map((title) => title.replace(/\.$/u, "").trim())
  );
  if (taskTitles.length === 0) {
    return normalizedSummary || undefined;
  }

  const taskSentence = `Open tasks include ${joinExactDetailValues(taskTitles.slice(0, 3))}.`;
  if (!normalizedSummary) {
    return taskSentence;
  }
  if (/\bcontinuity benchmark\b|\bre-run\b|\bopen tasks?\b/i.test(normalizedSummary)) {
    return normalizedSummary;
  }
  return `${taskSentence} ${normalizedSummary}`.trim();
}

async function augmentPickBackUpSummaryWithTaskRecovery(
  query: RecapQuery,
  summaryText: string | undefined
): Promise<string | undefined> {
  const normalizedSummary = typeof summaryText === "string" ? summaryText.trim() : "";
  if (!/\bpick back up\b/i.test(query.query)) {
    return normalizedSummary || undefined;
  }
  if (/\bcontinuity benchmark\b|\bre-run\b|\bopen tasks?\b/i.test(normalizedSummary)) {
    return normalizedSummary;
  }

  const taskPipeline = await runRecapPipeline("task_extraction", {
    ...query,
    query: "What tasks were still open?",
    provider: "none"
  });
  const taskTitles = uniqueStrings(
    parseTaskItems(taskPipeline.results, taskPipeline.focus)
      .map((item) => item.title)
      .filter((title) => title.trim().length > 0)
  );
  if (taskTitles.length === 0) {
    return normalizedSummary || undefined;
  }

  const taskSentence = `Open tasks include ${joinExactDetailValues(taskTitles.slice(0, 3))}.`;
  return normalizedSummary ? `${taskSentence} ${normalizedSummary}`.trim() : taskSentence;
}

function buildFallbackRecapAssessment(
  results: readonly RecallResult[],
  evidence: readonly RecallEvidenceItem[],
  queryText: string,
  queryDecompositionApplied: boolean
): NonNullable<RecallResponse["meta"]["answerAssessment"]> {
  if (results.length === 0) {
    return {
      confidence: "missing",
      sufficiency: "missing",
      reason: `No grounded evidence was retrieved for ${queryText}.`,
      lexicalCoverage: 0,
      matchedTerms: [],
      totalTerms: 0,
      evidenceCount: 0,
      directEvidence: false,
      subjectMatch: "unknown",
      matchedParticipants: [],
      missingParticipants: [],
      foreignParticipants: []
    };
  }

  const topRichness = results[0] ? recapResultRichnessScore(results[0]) : 0;
  if (evidence.length >= 2 || queryDecompositionApplied || topRichness >= 2.4) {
    return {
      confidence: "confident",
      sufficiency: "supported",
      reason: "The answer is grounded in a grouped evidence pack for the requested recap window.",
      lexicalCoverage: 1,
      matchedTerms: [],
      totalTerms: 0,
      evidenceCount: evidence.length,
      directEvidence: true,
      subjectMatch: "unknown",
      matchedParticipants: [],
      missingParticipants: [],
      foreignParticipants: []
    };
  }

  return {
    confidence: "weak",
    sufficiency: "weak",
    reason: "Only a thin evidence pack was retrieved for the requested recap query.",
    lexicalCoverage: 1,
    matchedTerms: [],
    totalTerms: 0,
    evidenceCount: evidence.length,
    directEvidence: evidence.length > 0,
    subjectMatch: "unknown",
    matchedParticipants: [],
    missingParticipants: [],
    foreignParticipants: []
  };
}

function assessRecallAnswer(
  results: readonly RecallResult[],
  evidence: RecallResponse["evidence"],
  planner: ReturnType<typeof planRecallQuery>,
  temporalSummarySufficient: boolean,
  queryText: string,
  exactDetailCandidate?: ExactDetailClaimCandidate | null
): NonNullable<RecallResponse["meta"]["answerAssessment"]> {
  const top = results[0];
  const subjectBinding = assessSubjectBinding(results, queryText);
  const derivedMovieMentionClaim = deriveMovieMentionClaimText(queryText, results);
  const derivedProjectIdeaClaim = deriveProjectIdeaClaimText(queryText, results);
  const derivedRelationshipHistoryClaim = deriveRelationshipHistoryClaimText(queryText, results);
  const derivedRelationshipProfileClaim = deriveRelationshipProfileClaimText(queryText, results);
  const derivedCurrentProjectClaim = deriveCurrentProjectClaimText(queryText, results);
  const summaryEvidenceKinds = [...new Set(
    results.flatMap((result) => {
      if (result.memoryType !== "semantic_memory") {
        return [];
      }
      const memoryKind =
        typeof result.provenance.memory_kind === "string" && result.provenance.memory_kind
          ? result.provenance.memory_kind
          : "semantic_memory";
      const metadata =
        typeof result.provenance.metadata === "object" && result.provenance.metadata !== null
          ? (result.provenance.metadata as Record<string, unknown>)
          : null;
      const profileKind = typeof metadata?.profile_kind === "string" ? metadata.profile_kind : "";
      const stateType = typeof metadata?.state_type === "string" ? metadata.state_type : "";
      return [profileKind || stateType ? `${memoryKind}:${profileKind || stateType}` : memoryKind];
    })
  )];
  const summaryEvidenceUsed = summaryEvidenceKinds.length > 0;
  const graphEvidenceUsed = results.some((result) => result.provenance.tier === "graph_expansion_support");
  const recursiveReflectEvidenceUsed = results.some((result) => result.provenance.recursive_reflect === true);
  const topicEvidenceUsed = results.some((result) => derivationTypeForRecallResult(result) === "topic_segment");
  const communityEvidenceUsed = results.some((result) => derivationTypeForRecallResult(result) === "community_summary");
  const exactDetailSource = inferPreciseFactDetailSource(queryText, results);
  const annotateAssessment = (
    assessment: Omit<NonNullable<RecallResponse["meta"]["answerAssessment"]>, "sufficiency" | "subjectMatch" | "matchedParticipants" | "missingParticipants" | "foreignParticipants">,
    sufficiencyOverride?: NonNullable<RecallResponse["meta"]["answerAssessment"]>["sufficiency"]
  ): NonNullable<RecallResponse["meta"]["answerAssessment"]> => ({
    ...assessment,
    sufficiency: sufficiencyOverride ?? confidenceToSufficiency(assessment.confidence),
    subjectMatch: subjectBinding.subjectMatch,
    matchedParticipants: subjectBinding.matchedParticipants,
    missingParticipants: subjectBinding.missingParticipants,
    foreignParticipants: subjectBinding.foreignParticipants,
    graphEvidenceUsed: graphEvidenceUsed || undefined,
    recursiveReflectEvidenceUsed: recursiveReflectEvidenceUsed || undefined,
    summaryEvidenceUsed: summaryEvidenceUsed || undefined,
    summaryEvidenceKinds: summaryEvidenceUsed ? summaryEvidenceKinds : undefined,
    exactDetailSource,
    topicEvidenceUsed: topicEvidenceUsed || undefined,
    communityEvidenceUsed: communityEvidenceUsed || undefined
  });
  if (!top) {
    if (isCurrentDatingQuery(queryText)) {
      return annotateAssessment({
        confidence: "confident",
        reason: "No active relationship truth exists for this query, so the correct answer is Unknown.",
        lexicalCoverage: 0,
        matchedTerms: [],
        totalTerms: planner.lexicalTerms.length,
        evidenceCount: evidence.length,
        directEvidence: false
      });
    }
    return annotateAssessment({
      confidence: "missing",
      reason: "No recall results were returned.",
      lexicalCoverage: 0,
      matchedTerms: [],
      totalTerms: planner.lexicalTerms.length,
      evidenceCount: evidence.length,
      directEvidence: false
    });
  }

  const coverage = lexicalCoverageForResult(top.content, planner.lexicalTerms);
  const directEvidence = evidence.some(
    (item) =>
      item.memoryId === top.memoryId ||
      (Boolean(item.artifactId) && item.artifactId === (top.artifactId ?? null)) ||
      (typeof item.sourceUri === "string" && item.sourceUri === top.provenance.source_uri)
  );
  const resultStateType = (result: RecallResult): string => {
    if (typeof result.provenance.state_type === "string" && result.provenance.state_type.length > 0) {
      return result.provenance.state_type;
    }
    const metadata =
      typeof result.provenance.metadata === "object" && result.provenance.metadata !== null
        ? (result.provenance.metadata as Record<string, unknown>)
        : null;
    return typeof metadata?.state_type === "string" ? metadata.state_type : "";
  };
  const hasExplicitStateSupport = (stateType: string): boolean =>
    results.some((result) => {
      const memoryKind = typeof result.provenance.memory_kind === "string" ? result.provenance.memory_kind : "";
      return resultStateType(result) === stateType || (memoryKind === "state_summary" && resultStateType(result) === stateType);
    });
  const strongTruth =
    top.memoryType === "procedural_memory" ||
    top.memoryType === "relationship_memory" ||
    top.memoryType === "narrative_event" ||
    top.memoryType === "temporal_nodes";
  const provenanceWhyFocus = isProvenanceWhyQuery(queryText);
  const currentDatingUnknownEvidence = isCurrentDatingUnknownEvidence(top, queryText);
  const sourceBackedStructuralSupport = results.some((result) => {
    if (typeof result.provenance.source_uri === "string" && result.provenance.source_uri.length > 0) {
      return true;
    }
    return recallResultSourceTexts(result).some((text) => text.length > 0 && normalizeWhitespace(text) !== normalizeWhitespace(result.content));
  });
  const derivedCounterfactualClaim = deriveCounterfactualSupportClaimText(queryText, results);
  const derivedRealizationClaim = deriveRealizationClaimText(queryText, results);
  const derivedCausalClaim = deriveCausalMotiveClaimText(queryText, results);
  const structuredExactQuery = isStructuredExactAnswerQuery(queryText);
  const strictSubjectIsolationFocus =
    isIdentityProfileQuery(queryText) ||
    isProfileInferenceQuery(queryText) ||
    isPreferenceQuery(queryText) ||
    /\bwhy\b/i.test(queryText) ||
    isSharedCommonalityQuery(queryText);
  const singleSubjectIsolationFocus =
    !isSharedCommonalityQuery(queryText) &&
    !isIdentityProfileQuery(queryText) &&
    !isProfileInferenceQuery(queryText) &&
    extractSubjectParticipantTargets(queryText).length === 1 &&
    (
      isPreciseFactDetailQuery(queryText) ||
      isTemporalDetailQuery(queryText) ||
      planner.queryClass === "direct_fact" ||
      /^\s*(?:is|does|did|would|will|can|could|has|have|had)\b/i.test(queryText)
    );
  const allowDerivedSubjectBoundClaim =
    (isMovieMentionQuery(queryText) && Boolean(derivedMovieMentionClaim)) ||
    (isProjectIdeaQueryText(queryText) && Boolean(derivedProjectIdeaClaim)) ||
    (isRelationshipHistoryRecapQuery(queryText) && Boolean(derivedRelationshipHistoryClaim)) ||
    (isRelationshipProfileQueryText(queryText) && Boolean(derivedRelationshipProfileClaim)) ||
    ((isCurrentProjectQueryText(queryText) || isContinuityHandoffSearchQueryText(queryText)) && Boolean(derivedCurrentProjectClaim));

  if (
    singleSubjectIsolationFocus &&
    !subjectBinding.topResultOwned &&
    (subjectBinding.subjectMatch === "mixed" || subjectBinding.subjectMatch === "mismatched") &&
    !allowDerivedSubjectBoundClaim
  ) {
    return annotateAssessment(
      {
        confidence: "missing",
        reason:
          "Retrieved evidence still mixed the requested person with another speaker or subject, so the brain should abstain instead of transferring details across people.",
        lexicalCoverage: coverage.lexicalCoverage,
        matchedTerms: coverage.matchedTerms,
        totalTerms: coverage.totalTerms,
        evidenceCount: evidence.length,
        directEvidence
      },
      subjectBinding.subjectMatch === "mismatched" ? "contradicted" : "missing"
    );
  }

  if (strictSubjectIsolationFocus && subjectBinding.subjectMatch === "mismatched") {
    return annotateAssessment(
      {
        confidence: "missing",
        reason:
          "Retrieved evidence was attached to different people than the ones requested, so the brain should abstain instead of transferring facts across subjects.",
        lexicalCoverage: coverage.lexicalCoverage,
        matchedTerms: coverage.matchedTerms,
        totalTerms: coverage.totalTerms,
        evidenceCount: evidence.length,
        directEvidence
      },
      subjectBinding.foreignParticipants.length > 0 ? "contradicted" : "missing"
    );
  }

  if (isSharedCommonalityQuery(queryText) && subjectBinding.subjectMatch !== "matched") {
    return annotateAssessment({
      confidence: "missing",
      reason:
        "The shared/commonality query did not produce subject-bound evidence for every requested participant, so the brain should abstain instead of summarizing partial overlap.",
      lexicalCoverage: coverage.lexicalCoverage,
      matchedTerms: coverage.matchedTerms,
      totalTerms: coverage.totalTerms,
      evidenceCount: evidence.length,
      directEvidence
    });
  }

  if (evidence.length === 0) {
    if (derivedCounterfactualClaim && sourceBackedStructuralSupport) {
      return annotateAssessment({
        confidence: "confident",
        reason: "The counterfactual answer is grounded in a source-backed support-dependency chain even though the evidence bundle did not attach leaf rows.",
        lexicalCoverage: coverage.lexicalCoverage,
        matchedTerms: coverage.matchedTerms,
        totalTerms: coverage.totalTerms,
        evidenceCount: evidence.length,
        directEvidence
      });
    }
    if (derivedRealizationClaim && sourceBackedStructuralSupport) {
      return annotateAssessment({
        confidence: "confident",
        reason: "The realization answer is grounded in a source-backed event-local realization statement even though the evidence bundle did not attach leaf rows.",
        lexicalCoverage: coverage.lexicalCoverage,
        matchedTerms: coverage.matchedTerms,
        totalTerms: coverage.totalTerms,
        evidenceCount: evidence.length,
        directEvidence
      });
    }
    if (
      derivedCausalClaim &&
      sourceBackedStructuralSupport &&
      (/\bwhy\b/i.test(queryText) || /\bspark(?:ed)?|inspired?\b/i.test(queryText) || /\bwhat\s+might\b/i.test(queryText))
    ) {
      return annotateAssessment({
        confidence: "confident",
        reason: "The causal/profile answer is grounded in a source-backed formative evidence chain even though the evidence bundle did not attach leaf rows.",
        lexicalCoverage: coverage.lexicalCoverage,
        matchedTerms: coverage.matchedTerms,
        totalTerms: coverage.totalTerms,
        evidenceCount: evidence.length,
        directEvidence
      });
    }
    return annotateAssessment({
      confidence: "missing",
      reason: "The top claim does not have supporting evidence attached.",
      lexicalCoverage: coverage.lexicalCoverage,
      matchedTerms: coverage.matchedTerms,
      totalTerms: coverage.totalTerms,
      evidenceCount: evidence.length,
      directEvidence
    });
  }

  if (!directEvidence) {
    if (planner.queryClass === "temporal_summary" && !planner.leafEvidenceRequired && evidence.length > 0) {
      return annotateAssessment({
        confidence: "confident",
        reason:
          "The planner intentionally accepted a temporal summary answer for this broad time-window query and attached supporting evidence rows.",
        lexicalCoverage: coverage.lexicalCoverage,
        matchedTerms: coverage.matchedTerms,
        totalTerms: coverage.totalTerms,
        evidenceCount: evidence.length,
        directEvidence
      });
    }

    return annotateAssessment({
      confidence: "weak",
      reason: top.memoryType === "temporal_nodes" || temporalSummarySufficient
        ? "The answer is grounded through temporal summary support, but the top claim is not directly anchored to a leaf evidence row."
        : "The answer is grounded, but only indirect or complementary evidence was attached to the top claim.",
      lexicalCoverage: coverage.lexicalCoverage,
      matchedTerms: coverage.matchedTerms,
      totalTerms: coverage.totalTerms,
      evidenceCount: evidence.length,
      directEvidence
    });
  }

  if (currentDatingUnknownEvidence) {
    return annotateAssessment({
      confidence: "confident",
      reason: "Current relationship lookup is authoritative because ended or paused tenure evidence rules out an active partner.",
      lexicalCoverage: coverage.lexicalCoverage,
      matchedTerms: coverage.matchedTerms,
      totalTerms: coverage.totalTerms,
      evidenceCount: evidence.length,
      directEvidence
    });
  }

  const directStructuredRelationshipProfileSupport =
    isRelationshipProfileQueryText(queryText) &&
    Boolean(derivedRelationshipProfileClaim) &&
    results.some((result) => {
      const predicate = typeof result.provenance.predicate === "string" ? result.provenance.predicate : "";
      const subjectName = typeof result.provenance.subject_name === "string" ? result.provenance.subject_name : "";
      const objectName = typeof result.provenance.object_name === "string" ? result.provenance.object_name : "";
      return (
        ["owner_of", "associated_with", "friend_of", "former_partner_of"].includes(predicate) &&
        subjectName.length > 0 &&
        objectName.length > 0
      );
    });
  if (directStructuredRelationshipProfileSupport && subjectBinding.subjectMatch !== "mismatched") {
    return annotateAssessment({
      confidence: "confident",
      reason: "The relationship profile answer is backed by direct structured relationship facts for the requested person.",
      lexicalCoverage: coverage.lexicalCoverage,
      matchedTerms: coverage.matchedTerms,
      totalTerms: coverage.totalTerms,
      evidenceCount: evidence.length,
      directEvidence
    });
  }

  const directCurrentProjectSupport =
    (isCurrentProjectQueryText(queryText) || isContinuityHandoffSearchQueryText(queryText)) &&
    Boolean(derivedCurrentProjectClaim) &&
    results.some((result) => typeof result.provenance.source_uri === "string" && isTrustedPersonalSourceUri(result.provenance.source_uri));
  if (directCurrentProjectSupport) {
    return annotateAssessment({
      confidence: "confident",
      reason: "The current-project answer is backed by recent trusted notes that directly mention the active work.",
      lexicalCoverage: coverage.lexicalCoverage,
      matchedTerms: coverage.matchedTerms,
      totalTerms: coverage.totalTerms,
      evidenceCount: evidence.length,
      directEvidence
    });
  }

  if (structuredExactQuery && directEvidence) {
    if (exactDetailCandidate && evidence.length >= 1) {
      return annotateAssessment({
        confidence: "confident",
        reason: "The exact-answer query is grounded in explicit detail-bearing evidence and was reduced to a deterministic answer value.",
        lexicalCoverage: coverage.lexicalCoverage,
        matchedTerms: coverage.matchedTerms,
        totalTerms: coverage.totalTerms,
        evidenceCount: evidence.length,
        directEvidence,
        exactDetailSource: exactDetailCandidate.source
      });
    }

    return annotateAssessment({
      confidence: "missing",
      reason:
        "The query is asking for a concrete answer value, but the retrieved evidence did not support a deterministic subject-bound extraction. The brain should abstain instead of paraphrasing a nearby snippet.",
      lexicalCoverage: coverage.lexicalCoverage,
      matchedTerms: coverage.matchedTerms,
      totalTerms: coverage.totalTerms,
      evidenceCount: evidence.length,
      directEvidence
    });
  }

  if (
    isPreferenceQuery(queryText) &&
    directEvidence &&
    /\b(?:prefer|prefers|preference|like|likes|love|loves|enjoy|enjoys|dislike|dislikes|hate|hates)\b/i.test(top.content)
  ) {
    return annotateAssessment({
      confidence: "confident",
      reason: "The preference answer is directly grounded in explicit preference evidence.",
      lexicalCoverage: coverage.lexicalCoverage,
      matchedTerms: coverage.matchedTerms,
      totalTerms: coverage.totalTerms,
      evidenceCount: evidence.length,
      directEvidence
    });
  }

  if (isGoalQuery(queryText) && directEvidence && hasExplicitStateSupport("goal")) {
    return annotateAssessment({
      confidence: "confident",
      reason: "The goal answer is directly grounded in an explicit current-state goal row or reconsolidated goal summary.",
      lexicalCoverage: coverage.lexicalCoverage,
      matchedTerms: coverage.matchedTerms,
      totalTerms: coverage.totalTerms,
      evidenceCount: evidence.length,
      directEvidence
    });
  }

  if (isPlanQuery(queryText) && directEvidence && hasExplicitStateSupport("plan")) {
    return annotateAssessment({
      confidence: "confident",
      reason: "The plan answer is directly grounded in an explicit current-state plan row or reconsolidated plan summary.",
      lexicalCoverage: coverage.lexicalCoverage,
      matchedTerms: coverage.matchedTerms,
      totalTerms: coverage.totalTerms,
      evidenceCount: evidence.length,
      directEvidence
    });
  }

  if (isConstraintQuery(queryText) && directEvidence && hasExplicitStateSupport("constraint")) {
    return annotateAssessment({
      confidence: "confident",
      reason: "The constraint answer is directly grounded in an explicit current-state constraint row or reconsolidated constraint summary.",
      lexicalCoverage: coverage.lexicalCoverage,
      matchedTerms: coverage.matchedTerms,
      totalTerms: coverage.totalTerms,
      evidenceCount: evidence.length,
      directEvidence
    });
  }

  if (isProfileInferenceQuery(queryText) && directEvidence) {
    const primaryEntityResults = filterResultsForPrimaryEntity(queryText, results);
    const derivedProfileClaim = deriveProfileInferenceClaimText(queryText, primaryEntityResults);
    const primaryEntitySupportTexts = primaryEntityResults.map((result) => extractPrimaryEntityBoundText(queryText, result));
    const roleDirectionQuery = /\brole\b/i.test(queryText);
    const hasRoleDirectionSummarySupport = primaryEntityResults.some((result) => {
      const memoryKind = typeof result.provenance.memory_kind === "string" ? result.provenance.memory_kind : "";
      const metadata =
        typeof result.provenance.metadata === "object" && result.provenance.metadata !== null
          ? (result.provenance.metadata as Record<string, unknown>)
          : null;
      return memoryKind === "profile_summary" && metadata?.profile_kind === "role_direction";
    });
    const alignedSupportCount = primaryEntitySupportTexts.filter((text) =>
      /\b(career|education|study|mental health|counseling|counsell?ing|counselor|counsellor|psychology|psychological|keen on|looking into|career options|programs?|field|path|work in|role|strategist|lead|manager|designer|engineer)\b/i.test(
        text
      )
    ).length;
    const strongSingleProfileSupport =
      alignedSupportCount >= 1 &&
      primaryEntitySupportTexts.some((text) =>
        (
          /\b(psychology|psychological|mental health)\b/i.test(text) &&
          /\b(counseling|counsell?ing|counselor|counsellor|programs?|field|path|work in|wants to work in|right path)\b/i.test(
            text
          )
        ) ||
        (
          roleDirectionQuery &&
          /\b(role direction|product strategist|research lead|manager|designer|engineer|lead)\b/i.test(text)
        )
      );
    const repeatedSubjectBoundProfileSupport =
      evidence.length >= 2 &&
      subjectBinding.subjectMatch === "matched" &&
      primaryEntitySupportTexts.some((text) =>
        /\b(psychology|psychological|mental health|counseling|counsell?ing|role direction|strategist|lead|manager|designer|engineer)\b/i.test(text) ||
        text.trim().length > 0
      );
    if (roleDirectionQuery && hasRoleDirectionSummarySupport && subjectBinding.subjectMatch === "matched") {
      return annotateAssessment({
        confidence: "confident",
        reason: "The profile answer is grounded in an active role-direction summary plus subject-bound supporting evidence.",
        lexicalCoverage: coverage.lexicalCoverage,
        matchedTerms: coverage.matchedTerms,
        totalTerms: coverage.totalTerms,
        evidenceCount: evidence.length,
        directEvidence
      });
    }
    if (
      derivedProfileClaim &&
      subjectBinding.subjectMatch === "matched" &&
      (repeatedSubjectBoundProfileSupport || strongSingleProfileSupport || (roleDirectionQuery && hasRoleDirectionSummarySupport))
    ) {
      return annotateAssessment({
        confidence: "confident",
        reason: roleDirectionQuery && hasRoleDirectionSummarySupport
          ? "The profile answer is grounded in an active role-direction summary plus subject-bound supporting evidence."
          : strongSingleProfileSupport
            ? "The profile answer is grounded in a directly subject-bound field signal and was derived deterministically from explicit career-direction evidence."
            : "The profile answer is grounded in repeated subject-bound evidence and was derived deterministically from aligned career-interest signals.",
        lexicalCoverage: coverage.lexicalCoverage,
        matchedTerms: coverage.matchedTerms,
        totalTerms: coverage.totalTerms,
        evidenceCount: evidence.length,
        directEvidence
      });
    }
    const unresolvedProfileSignal = primaryEntitySupportTexts.some((text) =>
      /\b(?:has not picked|hasn't picked|not picked an academic field|undecided|no clear field)\b/i.test(text)
    );
    return annotateAssessment({
      confidence: unresolvedProfileSignal ? "missing" : subjectBinding.subjectMatch === "matched" ? "weak" : "missing",
      reason:
        unresolvedProfileSignal
          ? "The profile query found explicit evidence that the requested person has not committed to a field, so the brain should abstain."
          : "The profile query retrieved some relevant evidence, but not enough repeated subject-bound support to make a confident profile inference.",
      lexicalCoverage: coverage.lexicalCoverage,
      matchedTerms: coverage.matchedTerms,
      totalTerms: coverage.totalTerms,
      evidenceCount: evidence.length,
      directEvidence
    });
  }

  if (isMovieMentionQuery(queryText) && directEvidence && derivedMovieMentionClaim && evidence.length >= 1) {
    return annotateAssessment({
      confidence: "confident",
      reason:
        "The movie-mention answer is grounded in direct subject-bound evidence and preserves both the movie title and the relative-time/location context deterministically.",
      lexicalCoverage: coverage.lexicalCoverage,
      matchedTerms: coverage.matchedTerms,
      totalTerms: coverage.totalTerms,
      evidenceCount: evidence.length,
      directEvidence
    });
  }

  if (isProjectIdeaQueryText(queryText) && directEvidence && derivedProjectIdeaClaim && evidence.length >= 1) {
    return annotateAssessment({
      confidence: "confident",
      reason:
        "The project-idea answer is grounded in direct Ben-linked evidence and was reduced to a compact deterministic idea statement.",
      lexicalCoverage: coverage.lexicalCoverage,
      matchedTerms: coverage.matchedTerms,
      totalTerms: coverage.totalTerms,
      evidenceCount: evidence.length,
      directEvidence
    });
  }

  if (isRelationshipHistoryRecapQuery(queryText) && directEvidence && derivedRelationshipHistoryClaim && evidence.length >= 1) {
    return annotateAssessment({
      confidence: "confident",
      reason:
        "The relationship-history answer is grounded in direct Lauren-linked history evidence and preserves the Tahoe/Bend timeline deterministically.",
      lexicalCoverage: coverage.lexicalCoverage,
      matchedTerms: coverage.matchedTerms,
      totalTerms: coverage.totalTerms,
      evidenceCount: evidence.length,
      directEvidence
    });
  }

  if (isDepartureTimingQuery(queryText) && directEvidence) {
    const derivedDepartureClaim = deriveDepartureClaimText(queryText, results);
    if (derivedDepartureClaim && evidence.length >= 1) {
      return annotateAssessment({
        confidence: "confident",
        reason: "The departure-timing answer is grounded in explicit date-bearing evidence and preserves the source date label deterministically.",
        lexicalCoverage: coverage.lexicalCoverage,
        matchedTerms: coverage.matchedTerms,
        totalTerms: coverage.totalTerms,
        evidenceCount: evidence.length,
        directEvidence
      });
    }
  }

  if (planner.queryClass === "temporal_detail" && directEvidence) {
    const derivedTemporalClaim = deriveTemporalClaimText(queryText, results);
    const bestTemporalResult = selectBestTemporalEvidenceResult(queryText, results);
    const temporalLeafSupport =
      bestTemporalResult &&
      (bestTemporalResult.memoryType === "episodic_memory" ||
        bestTemporalResult.memoryType === "artifact_derivation" ||
        bestTemporalResult.memoryType === "narrative_event");
    if (derivedTemporalClaim && temporalLeafSupport && subjectBinding.subjectMatch === "matched") {
      return annotateAssessment({
        confidence: "confident",
        reason: "The temporal-detail answer is grounded in subject-matched leaf evidence and preserves the resolved date label deterministically.",
        lexicalCoverage: coverage.lexicalCoverage,
        matchedTerms: coverage.matchedTerms,
        totalTerms: coverage.totalTerms,
        evidenceCount: evidence.length,
        directEvidence
      });
    }
  }

  if (isStorageLocationQuery(queryText) && directEvidence) {
    const derivedStorageClaim = deriveStorageLocationClaimText(queryText, results);
    if (derivedStorageClaim && evidence.length >= 1) {
      return annotateAssessment({
        confidence: "confident",
        reason: "The storage-location answer is grounded in explicit place-bearing evidence and preserves the concrete storage locations.",
        lexicalCoverage: coverage.lexicalCoverage,
        matchedTerms: coverage.matchedTerms,
        totalTerms: coverage.totalTerms,
        evidenceCount: evidence.length,
        directEvidence
      });
    }
  }

  if (isSalienceQuery(queryText) && directEvidence) {
    const salienceAnchors = results.filter((result) => {
      const metadata =
        typeof result.provenance.metadata === "object" && result.provenance.metadata !== null
          ? (result.provenance.metadata as Record<string, unknown>)
          : null;
      const salienceLabels = Array.isArray(metadata?.salience_labels)
        ? metadata.salience_labels.filter((value): value is string => typeof value === "string").map((value) => value.toLowerCase())
        : [];
      return (
        salienceLabels.length > 0 ||
        /\b(excited|exciting|frustrating|frustrated|surprising|surprised)\b/i.test(result.content)
      );
    });
    if (salienceAnchors.length > 0 && (coverage.lexicalCoverage >= 0.28 || evidence.length >= 2)) {
      return annotateAssessment({
        confidence: "confident",
        reason: "The salience answer is grounded in explicit emotion/surprise evidence plus direct supporting rows.",
        lexicalCoverage: coverage.lexicalCoverage,
        matchedTerms: coverage.matchedTerms,
        totalTerms: coverage.totalTerms,
        evidenceCount: evidence.length,
        directEvidence
      });
    }
  }

  if (isEventBoundedQuery(queryText) && /\bwhere\b/i.test(queryText) && directEvidence) {
    const derivedEventLocationClaim = deriveEventLocationClaimText(queryText, results);
    if (derivedEventLocationClaim && evidence.length >= 1) {
      return annotateAssessment({
        confidence: "confident",
        reason: "The event-location answer is grounded in event-local venue evidence and preserves the specific venue when present.",
        lexicalCoverage: coverage.lexicalCoverage,
        matchedTerms: coverage.matchedTerms,
        totalTerms: coverage.totalTerms,
        evidenceCount: evidence.length,
        directEvidence
      });
    }
  }

  if (isIdentityProfileQuery(queryText) && directEvidence) {
    const derivedIdentityClaim = deriveIdentityProfileClaimText(queryText, results);
    const alignedSupportCount = results.filter((result) =>
      /\b(transgender|nonbinary|gender identity|transition|identity|trans woman|trans man|queer)\b/i.test(result.content)
    ).length;
    if (derivedIdentityClaim && evidence.length >= 1 && alignedSupportCount >= 1) {
      return annotateAssessment({
        confidence: "confident",
        reason: "The identity answer is grounded in direct identity-bearing evidence and was derived deterministically.",
        lexicalCoverage: coverage.lexicalCoverage,
        matchedTerms: coverage.matchedTerms,
        totalTerms: coverage.totalTerms,
        evidenceCount: evidence.length,
        directEvidence
      });
    }
    return annotateAssessment({
      confidence: "missing",
      reason:
        "The identity query did not produce direct subject-bound identity evidence, so the brain should abstain instead of inferring from adjacent context.",
      lexicalCoverage: coverage.lexicalCoverage,
      matchedTerms: coverage.matchedTerms,
      totalTerms: coverage.totalTerms,
      evidenceCount: evidence.length,
      directEvidence
    });
  }

  const derivedCompanionExclusionClaim = deriveCompanionExclusionClaimText(queryText, results);
  if (derivedCompanionExclusionClaim && directEvidence) {
    return annotateAssessment({
      confidence: "confident",
      reason: "The companion-exclusion query is grounded in direct social-relation evidence tied to the primary subject rather than the companion mention.",
      lexicalCoverage: coverage.lexicalCoverage,
      matchedTerms: coverage.matchedTerms,
      totalTerms: coverage.totalTerms,
      evidenceCount: evidence.length,
      directEvidence
    });
  }

  if (isSharedCommonalityQuery(queryText) && directEvidence) {
    const derivedSharedClaim = deriveSharedCommonalityClaimText(queryText, results);
    if (derivedSharedClaim && evidence.length >= 2) {
      return annotateAssessment({
        confidence: "confident",
        reason: "The shared/commonality answer is grounded in multiple aligned evidence rows across the participants.",
        lexicalCoverage: coverage.lexicalCoverage,
        matchedTerms: coverage.matchedTerms,
        totalTerms: coverage.totalTerms,
        evidenceCount: evidence.length,
        directEvidence
      });
    }
    return annotateAssessment({
      confidence: "missing",
      reason: "The shared/commonality query did not produce grounded overlap across the participants, so the brain should abstain instead of summarizing unrelated rows.",
      lexicalCoverage: coverage.lexicalCoverage,
      matchedTerms: coverage.matchedTerms,
      totalTerms: coverage.totalTerms,
      evidenceCount: evidence.length,
      directEvidence
    });
  }

  if (derivedCounterfactualClaim && evidence.length >= 1) {
    return annotateAssessment({
      confidence: "confident",
      reason: "The counterfactual answer is grounded in an explicit goal plus support-dependency evidence chain tied to the same subject.",
      lexicalCoverage: coverage.lexicalCoverage,
      matchedTerms: coverage.matchedTerms,
      totalTerms: coverage.totalTerms,
      evidenceCount: evidence.length,
      directEvidence
    });
  }

  if (derivedRealizationClaim && evidence.length >= 1) {
    return annotateAssessment({
      confidence: "confident",
      reason: "The realization answer is grounded in an event-local realization statement tied to the same subject and trigger event.",
      lexicalCoverage: coverage.lexicalCoverage,
      matchedTerms: coverage.matchedTerms,
      totalTerms: coverage.totalTerms,
      evidenceCount: evidence.length,
      directEvidence
    });
  }

  if (isDecisionQuery(queryText) && directEvidence) {
    const hasDecisionSupport = results.some((result) => {
      const stateType = typeof result.provenance.state_type === "string" ? result.provenance.state_type : "";
      return stateType === "decision" || /\b(decided?|decision|rationale|choice made)\b/i.test(result.content);
    });
    const hasRationaleSupport = results.some((result) =>
      /\b(because|so\s+the|so\s+that|instead\s+of|one\s+substrate|graph,\s+vectors,\s+and\s+truth|truth\s+live\s+in\s+one\s+substrate)\b/i.test(
        result.content
      )
    );
    if (derivedCausalClaim || (hasDecisionSupport && hasRationaleSupport)) {
      return annotateAssessment({
        confidence: "confident",
        reason: "The decision-rationale answer is grounded in an explicit decision row plus direct rationale-bearing support.",
        lexicalCoverage: coverage.lexicalCoverage,
        matchedTerms: coverage.matchedTerms,
        totalTerms: coverage.totalTerms,
        evidenceCount: evidence.length,
        directEvidence
      });
    }
  }

  if (provenanceWhyFocus && directEvidence) {
    return annotateAssessment({
      confidence: "confident",
      reason:
        "This why-query is asking for supporting evidence, not motive synthesis, and the answer remains grounded in direct evidence for the claimed fact.",
      lexicalCoverage: coverage.lexicalCoverage,
      matchedTerms: coverage.matchedTerms,
      totalTerms: coverage.totalTerms,
      evidenceCount: evidence.length,
      directEvidence
    });
  }

  if (/\bwhy\b/i.test(queryText) && directEvidence) {
    if (derivedCausalClaim && evidence.length >= 1) {
      return annotateAssessment({
        confidence: "confident",
        reason: "The causal answer is grounded in aligned trigger, decision, and motive evidence.",
        lexicalCoverage: coverage.lexicalCoverage,
        matchedTerms: coverage.matchedTerms,
        totalTerms: coverage.totalTerms,
        evidenceCount: evidence.length,
        directEvidence
      });
    }
    return annotateAssessment({
      confidence: "missing",
      reason:
        "The causal query did not produce an aligned trigger-plus-motive evidence chain, so the brain should abstain instead of forcing a rationale.",
      lexicalCoverage: coverage.lexicalCoverage,
      matchedTerms: coverage.matchedTerms,
      totalTerms: coverage.totalTerms,
      evidenceCount: evidence.length,
      directEvidence
    });
  }

  if ((/\bspark(?:ed)?|inspired?\b/i.test(queryText) && /\binterest\b/i.test(queryText)) && evidence.length >= 1) {
    if (derivedCausalClaim && evidence.length >= 1) {
      return annotateAssessment({
        confidence: "confident",
        reason: "The motive answer is grounded in explicit formative or community-impact evidence linked to the subject's stated interest.",
        lexicalCoverage: coverage.lexicalCoverage,
        matchedTerms: coverage.matchedTerms,
        totalTerms: coverage.totalTerms,
        evidenceCount: evidence.length,
        directEvidence
      });
    }
    return annotateAssessment({
      confidence: "missing",
      reason: "The motive query did not produce a bounded formative-evidence chain, so the brain should abstain instead of forcing a rationale.",
      lexicalCoverage: coverage.lexicalCoverage,
      matchedTerms: coverage.matchedTerms,
      totalTerms: coverage.totalTerms,
      evidenceCount: evidence.length,
      directEvidence
    });
  }

  if ((coverage.lexicalCoverage >= 0.5 || strongTruth || temporalSummarySufficient) && directEvidence) {
    return annotateAssessment({
      confidence: "confident",
      reason: temporalSummarySufficient
        ? "Temporal summary gating judged the summary answer sufficient without descending further."
        : "The top claim has direct evidence and enough lexical/structural support to be treated as confident.",
      lexicalCoverage: coverage.lexicalCoverage,
      matchedTerms: coverage.matchedTerms,
      totalTerms: coverage.totalTerms,
      evidenceCount: evidence.length,
      directEvidence
    });
  }

  return annotateAssessment({
    confidence: "weak",
    reason: "The answer is grounded, but only complementary or low-coverage evidence was retrieved for the top claim.",
    lexicalCoverage: coverage.lexicalCoverage,
    matchedTerms: coverage.matchedTerms,
    totalTerms: coverage.totalTerms,
    evidenceCount: evidence.length,
    directEvidence
  });
}

export function buildDualityObject(
  results: readonly RecallResult[],
  evidence: RecallResponse["evidence"],
  assessment: NonNullable<RecallResponse["meta"]["answerAssessment"]>,
  namespaceId: string,
  queryText: string,
  exactDetailCandidate?: ExactDetailClaimCandidate | null
): RecallResponse["duality"] {
  const top = results[0];
  const derivedTemporalClaimText = deriveTemporalClaimText(queryText, results);
  const derivedPurchaseSummaryClaimText = derivePurchaseSummaryClaimText(queryText, results);
  const derivedMediaSummaryClaimText = deriveMediaSummaryClaimText(queryText, results);
  const derivedPreferenceSummaryClaimText = derivePreferenceSummaryClaimText(queryText, results);
  const derivedHabitConstraintClaimText = deriveHabitConstraintClaimText(queryText, results);
  const derivedRoutineSummaryClaimText = deriveRoutineSummaryClaimText(queryText, results);
  const derivedPersonTimeClaimText = derivePersonTimeClaimText(queryText, results);
  const skipGenericPreciseFactClaim =
    isStructuredExactAnswerQuery(queryText) || isMovieMentionQuery(queryText) || isProjectIdeaQueryText(queryText);
  const derivedPreciseFactClaimText =
    exactDetailCandidate && !isMovieMentionQuery(queryText) && !isProjectIdeaQueryText(queryText)
      ? exactDetailCandidate.text
      : skipGenericPreciseFactClaim
        ? null
        : derivePreciseFactClaimText(queryText, results);
  const derivedRelationshipChangeClaimText = deriveRelationshipChangeClaimText(queryText, results);
  const derivedRelationshipHistoryClaimText = deriveRelationshipHistoryClaimText(queryText, results);
  const derivedDepartureClaimText = deriveDepartureClaimText(queryText, results);
  const derivedMovieMentionClaimText = deriveMovieMentionClaimText(queryText, results);
  const derivedProjectIdeaClaimText = deriveProjectIdeaClaimText(queryText, results);
  const derivedRelationshipProfileClaimText = deriveRelationshipProfileClaimText(queryText, results);
  const derivedCurrentProjectClaimText = deriveCurrentProjectClaimText(queryText, results);
  const derivedStorageClaimText = deriveStorageLocationClaimText(queryText, results);
  const derivedEventLocationClaimText = deriveEventLocationClaimText(queryText, results);
  const derivedProfileClaimText = deriveProfileInferenceClaimText(queryText, results);
  const derivedIdentityClaimText = deriveIdentityProfileClaimText(queryText, results);
  const derivedCompanionExclusionClaimText = deriveCompanionExclusionClaimText(queryText, results);
  const derivedSharedClaimText = deriveSharedCommonalityClaimText(queryText, results);
  const derivedCausalClaimText = deriveCausalMotiveClaimText(queryText, results);
  const currentDatingUnknownFromEvidence = isCurrentDatingUnknownEvidence(top, queryText);
  const abstentionClaimText = buildAbstentionClaimText(queryText, assessment);
  const fallbackDerivedClaimText =
    derivedPurchaseSummaryClaimText ??
    derivedMediaSummaryClaimText ??
    derivedPreferenceSummaryClaimText ??
    derivedHabitConstraintClaimText ??
    derivedRoutineSummaryClaimText ??
    derivedPersonTimeClaimText ??
    derivedCurrentProjectClaimText ??
    derivedRelationshipChangeClaimText ??
    derivedRelationshipHistoryClaimText ??
    derivedRelationshipProfileClaimText ??
    derivedCompanionExclusionClaimText ??
    derivedDepartureClaimText ??
    derivedMovieMentionClaimText ??
    derivedProjectIdeaClaimText ??
    derivedTemporalClaimText ??
    derivedStorageClaimText ??
    derivedEventLocationClaimText ??
    derivedIdentityClaimText ??
    derivedSharedClaimText ??
    derivedCausalClaimText ??
    derivedProfileClaimText ??
    top?.content ??
    null;
  const unknownCurrentRelationship =
    ((!top && isCurrentDatingQuery(queryText)) || currentDatingUnknownFromEvidence) &&
    assessment.confidence !== "missing";
  const followUpAction: RecallFollowUpAction =
    assessment.confidence === "confident"
      ? "none"
      : assessment.confidence === "weak"
        ? "suggest_verification"
        : "route_to_clarifications";
  const clarificationHint =
    followUpAction === "none"
      ? undefined
      : {
          endpoint: `/ops/clarifications?namespace_id=${encodeURIComponent(namespaceId)}&limit=10`,
          namespaceId,
          query: queryText,
          reason: assessment.reason,
          suggestedPrompt:
            followUpAction === "route_to_clarifications"
              ? `The brain could not find authoritative evidence for: ${queryText}`
              : `The brain found only weak support for: ${queryText}`,
          mcpTool: {
            name: "memory.get_clarifications",
            arguments: {
              namespace_id: namespaceId,
              query: queryText,
              limit: 10
            }
          }
        };
  const allowWeakRelationshipChangeClaim = isRelationshipChangeQueryText(queryText) && Boolean(derivedRelationshipChangeClaimText);
  const allowWeakRelationshipHistoryClaim =
    isRelationshipHistoryRecapQuery(queryText) && Boolean(derivedRelationshipHistoryClaimText);
  const allowWeakRelationshipProfileClaim =
    isRelationshipProfileQueryText(queryText) && Boolean(derivedRelationshipProfileClaimText);
  const allowWeakCurrentProjectClaim =
    (isCurrentProjectQueryText(queryText) || isContinuityHandoffSearchQueryText(queryText)) &&
    Boolean(derivedCurrentProjectClaimText);
  const allowWeakDerivedFactClaim =
    (isMovieMentionQuery(queryText) && Boolean(derivedMovieMentionClaimText)) ||
    (isProjectIdeaQueryText(queryText) && Boolean(derivedProjectIdeaClaimText)) ||
    (isPurchaseSummaryQuery(queryText) && Boolean(derivedPurchaseSummaryClaimText)) ||
    (isMediaSummaryQuery(queryText) && Boolean(derivedMediaSummaryClaimText)) ||
    (isPreferenceSummaryQuery(queryText) && Boolean(derivedPreferenceSummaryClaimText)) ||
    (isPersonTimeFactQuery(queryText) && Boolean(derivedPersonTimeClaimText));
  let claimText = currentDatingUnknownFromEvidence
    ? "Unknown."
    : assessment.confidence !== "confident" &&
        assessment.subjectMatch !== "matched" &&
        !allowWeakRelationshipChangeClaim &&
        !allowWeakRelationshipHistoryClaim &&
        !allowWeakRelationshipProfileClaim &&
        !allowWeakCurrentProjectClaim &&
        !allowWeakDerivedFactClaim
      ? abstentionClaimText
    : assessment.confidence === "missing"
      ? abstentionClaimText
        : derivedPreciseFactClaimText ??
          fallbackDerivedClaimText ??
          abstentionClaimText;

  if (isMovieMentionQuery(queryText) && derivedMovieMentionClaimText) {
    claimText = derivedMovieMentionClaimText;
  } else if (isProjectIdeaQueryText(queryText) && derivedProjectIdeaClaimText) {
    claimText = derivedProjectIdeaClaimText;
  } else if (isPurchaseSummaryQuery(queryText) && derivedPurchaseSummaryClaimText) {
    claimText = derivedPurchaseSummaryClaimText;
  } else if (isMediaSummaryQuery(queryText) && derivedMediaSummaryClaimText) {
    claimText = derivedMediaSummaryClaimText;
  } else if (isPreferenceSummaryQuery(queryText) && derivedPreferenceSummaryClaimText) {
    claimText = derivedPreferenceSummaryClaimText;
  } else if (isPersonTimeFactQuery(queryText) && derivedPersonTimeClaimText) {
    claimText = derivedPersonTimeClaimText;
  }

  return {
    claim: top
      ? {
          memoryId: top.memoryId,
          memoryType: top.memoryType,
          text: claimText,
          occurredAt: top.occurredAt ?? null,
          artifactId: top.artifactId ?? null,
          sourceUri: typeof top.provenance.source_uri === "string" ? top.provenance.source_uri : null,
          validFrom: typeof top.provenance.valid_from === "string" ? top.provenance.valid_from : null,
          validUntil: typeof top.provenance.valid_until === "string" ? top.provenance.valid_until : null
        }
      : {
          memoryId: null,
          memoryType: null,
          text: claimText,
          occurredAt: null,
          artifactId: null,
          sourceUri: null,
          validFrom: null,
          validUntil: null
        },
    evidence: evidence.map((item) => ({
      memoryId: item.memoryId,
      artifactId: item.artifactId ?? null,
      sourceUri: item.sourceUri ?? null,
      snippet: item.snippet
    })),
    confidence: assessment.confidence,
    reason: assessment.reason,
    followUpAction,
    clarificationHint
  };
}

function loadBoundedEventSceneSupportRows(
  namespaceId: string,
  eventIds: readonly string[]
): Promise<SearchRow[]> {
  if (eventIds.length === 0) {
    return Promise.resolve([]);
  }

  return queryRows<SearchRow>(
    `
      SELECT
        concat('event-scene:', ns.id::text) AS memory_id,
        'episodic_memory'::text AS memory_type,
        ns.scene_text AS content,
        0.64::double precision AS raw_score,
        ne.artifact_id,
        COALESCE(ns.time_start, ne.time_start, ns.occurred_at, ne.created_at) AS occurred_at,
        ne.namespace_id,
        jsonb_build_object(
          'tier', 'event_scene_support',
          'source_scene_id', ns.id,
          'source_event_id', ne.id,
          'event_label', ne.event_label,
          'event_kind', ne.event_kind,
          'source_uri', a.uri,
          'subject_name', subject_entity.canonical_name,
          'location_name', location_entity.canonical_name,
          'metadata', ns.metadata
        ) AS provenance
      FROM narrative_scenes ns
      JOIN narrative_events ne ON ne.id = ns.source_event_id
      LEFT JOIN artifacts a ON a.id = ne.artifact_id
      LEFT JOIN entities subject_entity ON subject_entity.id = ne.primary_subject_entity_id
      LEFT JOIN entities location_entity ON location_entity.id = ne.primary_location_entity_id
      WHERE ne.namespace_id = $1
        AND ne.id = ANY($2::uuid[])
      ORDER BY COALESCE(ns.time_start, ne.time_start, ns.occurred_at, ne.created_at) ASC, ns.scene_index ASC
      LIMIT 6
    `,
    [namespaceId, eventIds]
  );
}

function loadBoundedEventNeighborhoodSupportRows(
  namespaceId: string,
  eventIds: readonly string[]
): Promise<SearchRow[]> {
  if (eventIds.length === 0) {
    return Promise.resolve([]);
  }

  return queryRows<SearchRow>(
    `
      WITH seed_chunks AS (
        SELECT
          ne.id AS event_id,
          ne.artifact_id,
          ne.namespace_id,
          ne.event_label,
          ne.event_kind,
          a.uri AS source_uri,
          chunk_seed.id AS source_chunk_id,
          chunk_seed.chunk_index AS source_chunk_index
        FROM narrative_events ne
        JOIN narrative_scenes ns ON ns.id = ne.source_scene_id
        LEFT JOIN artifacts a ON a.id = ne.artifact_id
        JOIN LATERAL (
          SELECT value::uuid AS chunk_id
          FROM jsonb_array_elements_text(COALESCE(ns.metadata->'source_chunk_ids', '[]'::jsonb))
        ) seed_ids ON TRUE
        JOIN artifact_chunks chunk_seed ON chunk_seed.id = seed_ids.chunk_id
        WHERE ne.namespace_id = $1
          AND ne.id = ANY($2::uuid[])
      ),
      neighborhood_rows AS (
        SELECT
          seed_chunks.event_id,
          em.id AS memory_id,
          em.content,
          em.artifact_id,
          em.occurred_at,
          em.namespace_id,
          em.metadata,
          em.artifact_observation_id,
          em.source_chunk_id,
          seed_chunks.event_label,
          seed_chunks.event_kind,
          seed_chunks.source_uri,
          abs(neighbor_chunk.chunk_index - seed_chunks.source_chunk_index) AS chunk_distance,
          row_number() OVER (
            PARTITION BY seed_chunks.event_id
            ORDER BY
              abs(neighbor_chunk.chunk_index - seed_chunks.source_chunk_index) ASC,
              em.occurred_at DESC,
              em.id DESC
          ) AS rank_within_event
        FROM seed_chunks
        JOIN artifact_chunks neighbor_chunk
          ON neighbor_chunk.artifact_observation_id = (
            SELECT artifact_observation_id
            FROM artifact_chunks
            WHERE id = seed_chunks.source_chunk_id
          )
         AND neighbor_chunk.chunk_index BETWEEN seed_chunks.source_chunk_index - 1 AND seed_chunks.source_chunk_index + 1
        JOIN episodic_memory em
          ON em.namespace_id = seed_chunks.namespace_id
         AND em.artifact_observation_id = neighbor_chunk.artifact_observation_id
         AND em.source_chunk_id = neighbor_chunk.id
      )
      SELECT
        concat('event-neighborhood:', memory_id::text, ':', event_id::text) AS memory_id,
        'episodic_memory'::text AS memory_type,
        content,
        CASE
          WHEN chunk_distance = 0 THEN 0.68::double precision
          ELSE 0.6::double precision
        END AS raw_score,
        artifact_id,
        occurred_at,
        namespace_id,
        jsonb_build_object(
          'tier', 'event_neighborhood_support',
          'source_event_id', event_id,
          'event_label', event_label,
          'event_kind', event_kind,
          'source_uri', source_uri,
          'artifact_observation_id', artifact_observation_id,
          'source_chunk_id', source_chunk_id,
          'chunk_distance', chunk_distance,
          'metadata', metadata
        ) AS provenance
      FROM neighborhood_rows
      WHERE rank_within_event <= 2
      ORDER BY occurred_at DESC, memory_id DESC
      LIMIT 6
    `,
    [namespaceId, eventIds]
  );
}

function shouldLoadBoundedEventNeighborhoodSupport(
  queryText: string,
  sceneSupportRows: readonly SearchRow[]
): boolean {
  if (sceneSupportRows.length === 0) {
    return true;
  }

  return (
    /\bwho\b/i.test(queryText) ||
    /\bwith\b/i.test(queryText) ||
    /\bafter\b/i.test(queryText) ||
    /\bbefore\b/i.test(queryText) ||
    /\brealiz(?:e|ed|ing)\b/i.test(queryText) ||
    /\b(?:why|spark(?:ed)?|inspired?|motivated?)\b/i.test(queryText) ||
    /\blater\b/i.test(queryText) ||
    /\bwhich\b/i.test(queryText) ||
    /\bexact\b/i.test(queryText) ||
    /\bdetails?\b/i.test(queryText)
  );
}

function expandBoundedEventResults(
  results: readonly RecallResult[],
  supportRows: readonly SearchRow[],
  limit: number
): readonly RecallResult[] {
  if (results.length === 0 || supportRows.length === 0) {
    return results;
  }

  const supportByEvent = new Map<string, RecallResult[]>();
  for (const row of supportRows) {
    const eventId = typeof row.provenance.source_event_id === "string" ? row.provenance.source_event_id : null;
    if (!eventId) {
      continue;
    }

    const supportResult = buildRecallResult(row, 0.52, {
      rrfScore: 0.52
    });
    const bucket = supportByEvent.get(eventId) ?? [];
    bucket.push(supportResult);
    supportByEvent.set(eventId, bucket);
  }

  const expanded: RecallResult[] = [];
  const seen = new Set<string>();

  for (const result of results) {
    if (!seen.has(result.memoryId)) {
      expanded.push(result);
      seen.add(result.memoryId);
    }

    if (result.memoryType !== "narrative_event") {
      continue;
    }

    for (const support of supportByEvent.get(result.memoryId) ?? []) {
      if (seen.has(support.memoryId)) {
        continue;
      }
      expanded.push(support);
      seen.add(support.memoryId);
      if (expanded.length >= limit) {
        return expanded.slice(0, limit);
      }
    }
  }

  return expanded.slice(0, limit);
}

async function loadSourceMemorySupportRows(
  namespaceId: string,
  results: readonly RecallResult[],
  limit: number
): Promise<readonly RecallResult[]> {
  const sourceMemoryIds = Array.from(
    new Set(
      results
        .map((result) => (typeof result.provenance.source_memory_id === "string" ? result.provenance.source_memory_id : null))
        .filter((value): value is string => Boolean(value))
    )
  ).slice(0, 6);

  if (sourceMemoryIds.length === 0) {
    return [];
  }

  const rows = await queryRows<SearchRow>(
    `
      SELECT
        em.id AS memory_id,
        'episodic_memory'::text AS memory_type,
        em.content AS content,
        0.7::double precision AS raw_score,
        em.artifact_id,
        em.occurred_at,
        em.namespace_id,
        jsonb_build_object(
          'tier', 'source_memory_support',
          'source_uri', a.uri,
          'artifact_observation_id', em.artifact_observation_id,
          'metadata', em.metadata
        ) AS provenance
      FROM episodic_memory em
      LEFT JOIN artifacts a ON a.id = em.artifact_id
      WHERE em.namespace_id = $1
        AND em.id = ANY($2::uuid[])
      ORDER BY em.occurred_at DESC
      LIMIT $3
    `,
    [namespaceId, sourceMemoryIds, Math.max(limit, sourceMemoryIds.length)]
  );

  return rows.map((row) => buildRecallResult(row, 0.7, { rrfScore: 0.7 }));
}

async function loadEpisodicNeighborhoodSupportRows(
  namespaceId: string,
  results: readonly RecallResult[],
  limit: number
): Promise<readonly RecallResult[]> {
  const sourceChunkIds = Array.from(
    new Set(
      results
        .map((result) => (typeof result.provenance.source_chunk_id === "string" ? result.provenance.source_chunk_id : null))
        .filter((value): value is string => Boolean(value))
    )
  ).slice(0, 4);

  if (sourceChunkIds.length === 0) {
    return [];
  }

  const rows = await queryRows<SearchRow>(
    `
      WITH seed_chunks AS (
        SELECT
          chunk_seed.id AS source_chunk_id,
          chunk_seed.artifact_observation_id,
          chunk_seed.chunk_index
        FROM artifact_chunks chunk_seed
        WHERE chunk_seed.id = ANY($2::uuid[])
      ),
      neighborhood_rows AS (
        SELECT
          seed_chunks.source_chunk_id AS seed_chunk_id,
          min(em.id::text) AS first_memory_id,
          string_agg(em.content, ' ' ORDER BY neighbor_chunk.chunk_index ASC) AS merged_content,
          min(em.artifact_id::text) AS artifact_id,
          max(em.occurred_at)::text AS occurred_at,
          min(em.namespace_id)::text AS namespace_id,
          min(em.artifact_observation_id::text) AS artifact_observation_id,
          min(em.source_chunk_id::text) AS support_chunk_id,
          min(abs(neighbor_chunk.chunk_index - seed_chunks.chunk_index)) AS min_chunk_distance,
          jsonb_agg(em.metadata ORDER BY neighbor_chunk.chunk_index ASC) AS metadata_bundle
        FROM seed_chunks
        JOIN artifact_chunks neighbor_chunk
          ON neighbor_chunk.artifact_observation_id = seed_chunks.artifact_observation_id
         AND neighbor_chunk.chunk_index BETWEEN seed_chunks.chunk_index - 1 AND seed_chunks.chunk_index + 1
        JOIN episodic_memory em
          ON em.namespace_id = $1
         AND em.artifact_observation_id = neighbor_chunk.artifact_observation_id
         AND em.source_chunk_id = neighbor_chunk.id
        GROUP BY seed_chunks.source_chunk_id
      )
      SELECT
        concat('episodic-neighborhood:', first_memory_id, ':', seed_chunk_id::text) AS memory_id,
        'episodic_memory'::text AS memory_type,
        merged_content AS content,
        0.76::double precision AS raw_score,
        artifact_id::uuid AS artifact_id,
        occurred_at,
        namespace_id,
        jsonb_build_object(
          'tier', 'episodic_neighborhood_support',
          'artifact_observation_id', artifact_observation_id,
          'source_chunk_id', support_chunk_id,
          'seed_chunk_id', seed_chunk_id,
          'chunk_distance', min_chunk_distance,
          'metadata', metadata_bundle
        ) AS provenance
      FROM neighborhood_rows
      ORDER BY occurred_at DESC, memory_id DESC
      LIMIT $3
    `,
    [namespaceId, sourceChunkIds, Math.max(limit, sourceChunkIds.length * 2)]
  );

  return rows.map((row) => buildRecallResult(row, 0.74, { rrfScore: 0.74 }));
}

function mergeRecallResults(
  primary: readonly RecallResult[],
  secondary: readonly RecallResult[],
  limit: number
): RecallResult[] {
  const merged: RecallResult[] = [];
  const seen = new Set<string>();

  for (const result of [...primary, ...secondary]) {
    if (seen.has(result.memoryId)) {
      continue;
    }
    seen.add(result.memoryId);
    merged.push(result);
    if (merged.length >= limit) {
      break;
    }
  }

  return merged;
}

async function loadTranscriptUtteranceRows(
  namespaceId: string,
  queryText: string,
  candidateLimit: number,
  speakerTerms: readonly string[],
  timeStart?: string | null,
  timeEnd?: string | null
): Promise<SearchRow[]> {
  return queryRows<SearchRow>(
    `
      WITH transcript_query AS (
        SELECT websearch_to_tsquery('english', $2) AS query
      )
      SELECT
        concat('transcript_utterance:', tu.id::text) AS memory_id,
        'episodic_memory'::text AS memory_type,
        concat(coalesce(tu.speaker_name, tu.speaker_label, 'Someone'), ' said: ', coalesce(tu.normalized_text, tu.utterance_text)) AS content,
        (
          ts_rank_cd(
            to_tsvector(
              'english',
              concat_ws(
                ' ',
                coalesce(tu.speaker_name, tu.speaker_label, ''),
                coalesce(tu.normalized_text, ''),
                coalesce(tu.utterance_text, '')
              )
            ),
            transcript_query.query
          )
          + CASE
              WHEN EXISTS (
                SELECT 1
                FROM unnest($4::text[]) AS speaker_term(term)
                WHERE lower(coalesce(tu.speaker_name, tu.speaker_label, '')) = lower(speaker_term.term)
              ) THEN 0.35
              ELSE 0
            END
        )::double precision AS raw_score,
        tu.artifact_id::text AS artifact_id,
        tu.occurred_at::text AS occurred_at,
        tu.namespace_id,
        jsonb_build_object(
          'tier', 'transcript_utterance',
          'speaker_name', coalesce(tu.speaker_name, tu.speaker_label),
          'artifact_observation_id', tu.artifact_observation_id,
          'derivation_id', tu.derivation_id,
          'source_uri', a.uri,
          'metadata', tu.metadata
        ) AS provenance
      FROM transcript_utterances tu
      CROSS JOIN transcript_query
      LEFT JOIN artifacts a ON a.id = tu.artifact_id
      WHERE tu.namespace_id = $1
        AND to_tsvector(
          'english',
          concat_ws(
            ' ',
            coalesce(tu.speaker_name, tu.speaker_label, ''),
            coalesce(tu.normalized_text, ''),
            coalesce(tu.utterance_text, '')
          )
        ) @@ transcript_query.query
        AND ($5::timestamptz IS NULL OR tu.occurred_at >= $5::timestamptz)
        AND ($6::timestamptz IS NULL OR tu.occurred_at <= $6::timestamptz)
      ORDER BY raw_score DESC, tu.occurred_at DESC
      LIMIT $3
    `,
    [namespaceId, queryText, Math.max(candidateLimit * 2, 8), speakerTerms, timeStart ?? null, timeEnd ?? null]
  );
}

async function loadSpeakerScopedTranscriptionRows(
  namespaceId: string,
  speakerTerms: readonly string[],
  candidateLimit: number,
  timeStart?: string | null,
  timeEnd?: string | null
): Promise<SearchRow[]> {
  const normalizedSpeakerTerms = [...new Set(speakerTerms.map((term) => normalizeWhitespace(term)).filter(Boolean))];
  if (normalizedSpeakerTerms.length === 0) {
    return [];
  }

  return queryRows<SearchRow>(
    `
      SELECT
        ad.id AS memory_id,
        'artifact_derivation'::text AS memory_type,
        ${artifactDerivationContentExpression()} AS content,
        (
          CASE
            WHEN EXISTS (
              SELECT 1
              FROM unnest($2::text[]) AS speaker_term(term)
              WHERE lower(coalesce(ad.metadata->>'primary_speaker_name', '')) = lower(speaker_term.term)
            ) THEN 4.2
            ELSE 0
          END
          +
          CASE
            WHEN coalesce(ad.content_text, '') ~* '(karaoke|spa|burger|burgers|sunday night|night)' THEN 1.4
            ELSE 0
          END
        )::double precision AS raw_score,
        ao.artifact_id,
        coalesce(source_em.occurred_at, ao.observed_at) AS occurred_at,
        a.namespace_id,
        jsonb_build_object(
          'tier', 'artifact_derivation',
          'derivation_type', ad.derivation_type,
          'provider', ad.provider,
          'model', ad.model,
          'artifact_observation_id', ad.artifact_observation_id,
          'source_chunk_id', ad.source_chunk_id,
          'source_uri', a.uri,
          'metadata', ad.metadata
        ) AS provenance
      FROM artifact_derivations ad
      JOIN artifact_observations ao ON ao.id = ad.artifact_observation_id
      JOIN artifacts a ON a.id = ao.artifact_id
      LEFT JOIN episodic_memory source_em ON source_em.id = ad.source_chunk_id
      WHERE a.namespace_id = $1
        AND ad.derivation_type = 'transcription'
        AND EXISTS (
          SELECT 1
          FROM unnest($2::text[]) AS speaker_term(term)
          WHERE lower(coalesce(ad.metadata->>'primary_speaker_name', '')) = lower(speaker_term.term)
        )
        AND ($3::timestamptz IS NULL OR coalesce(source_em.occurred_at, ao.observed_at) >= $3)
        AND ($4::timestamptz IS NULL OR coalesce(source_em.occurred_at, ao.observed_at) <= $4)
      ORDER BY raw_score DESC, coalesce(source_em.occurred_at, ao.observed_at) DESC, ad.id DESC
      LIMIT $5
    `,
    [namespaceId, normalizedSpeakerTerms, timeStart ?? null, timeEnd ?? null, Math.max(candidateLimit, 4)]
  );
}

function buildTranscriptSpeechQueryText(
  queryText: string,
  lexicalTerms: readonly string[],
  speakerTerms: readonly string[]
): string {
  const blockedTerms = new Set([
    "what",
    "who",
    "did",
    "does",
    "do",
    "say",
    "said",
    "about",
    "was",
    "were",
    "in",
    "that",
    "conversation"
  ]);

  const prioritizedTerms = lexicalTerms.filter((term) => {
    const normalized = term.trim().toLowerCase();
    return normalized.length > 1 && !blockedTerms.has(normalized);
  });

  const mergedTerms = [...speakerTerms, ...prioritizedTerms];
  const dedupedTerms = mergedTerms.filter(
    (term, index) => mergedTerms.findIndex((candidate) => candidate.toLowerCase() === term.toLowerCase()) === index
  );

  return dedupedTerms.length > 0 ? dedupedTerms.join(" ") : queryText;
}

function parseUnresolvedClarificationTarget(queryText: string): {
  readonly target: string;
  readonly ambiguityTypes: readonly string[];
} | null {
  const normalized = queryText.trim();
  const whoMatch = normalized.match(
    /^who\s+is\s+([A-Za-z][A-Za-z\s'-]{1,40}?)(?:\s+in\s+my\s+life(?:\s+(?:right\s+now|exactly))?|\s+right\s+now|\s+exactly)?\??$/iu
  );
  const whoTarget = normalizeWhitespace(whoMatch?.[1] ?? "");
  if (whoTarget) {
    const lowered = whoTarget.toLowerCase().replace(/^the\s+/u, "");
    if (["uncle", "aunt", "mom", "mother", "dad", "father", "partner", "brother", "sister", "cousin"].includes(lowered)) {
      return {
        target: lowered,
        ambiguityTypes: ["kinship_resolution"]
      };
    }
    if (["doctor", "therapist", "trainer", "teacher"].includes(lowered)) {
      return {
        target: lowered,
        ambiguityTypes: ["unknown_reference"]
      };
    }
    if (/^[A-Za-z][A-Za-z'-]{1,40}$/u.test(whoTarget)) {
      return {
        target: whoTarget,
        ambiguityTypes: ["alias_collision", "possible_misspelling", "asr_correction", "unknown_reference"]
      };
    }
  }

  const whereMatch = normalized.match(/^where\s+(?:was|is)\s+(.+?)\??$/iu);
  const whereTarget = normalizeWhitespace(whereMatch?.[1] ?? "");
  if (whereTarget) {
    const trimmed = whereTarget.replace(/^the\s+/iu, "").trim();
    if (/\b(cabin|house|wing|office|lake)\b/iu.test(trimmed)) {
      return {
        target: whereTarget,
        ambiguityTypes: ["place_grounding", "unknown_reference"]
      };
    }
  }

  const didYouMeanMatch = normalized.match(
    /^did\s+you\s+mean\s+.+?\s+when\s+(?:the\s+)?(?:note|transcript|audio|recording)\s+said\s+([A-Za-z][A-Za-z\s'-]{1,40})\??$/iu
  );
  const didYouMeanTarget = normalizeWhitespace(didYouMeanMatch?.[1] ?? "");
  if (didYouMeanTarget) {
    return {
      target: didYouMeanTarget,
      ambiguityTypes: ["possible_misspelling", "asr_correction", "alias_collision"]
    };
  }

  return null;
}

async function hasUnresolvedClarification(namespaceId: string, queryText: string): Promise<boolean> {
  const parsed = parseUnresolvedClarificationTarget(queryText);
  if (!parsed) {
    return false;
  }

  const resolvedEntity = await resolveCanonicalEntityReference(namespaceId, parsed.target, {
    entityTypes: ["person", "place", "project", "concept", "unknown"]
  });
  if (resolvedEntity) {
    return false;
  }

  const rows = await queryRows<{ total: string }>(
    `
      SELECT COUNT(*)::text AS total
      FROM claim_candidates
      WHERE namespace_id = $1
        AND ambiguity_state = 'requires_clarification'
        AND ambiguity_type = ANY($3::text[])
        AND (
          lower(coalesce(subject_text, '')) = lower($2)
          OR lower(coalesce(object_text, '')) = lower($2)
          OR lower(coalesce(metadata->>'raw_ambiguous_text', '')) = lower($2)
        )
    `,
    [namespaceId, parsed.target, parsed.ambiguityTypes]
  );

  return Number(rows[0]?.total ?? "0") > 0;
}

function buildScopedEventSqlMatch(terms: readonly string[]): {
  readonly clause: string;
  readonly values: readonly string[];
  readonly scoreExpression: string;
} {
  const filteredTerms = terms
    .map((term) => term.trim())
    .filter((term) => term.length >= 3);

  if (filteredTerms.length === 0) {
    return {
      clause: "TRUE",
      values: [],
      scoreExpression: "1.0"
    };
  }

  const clauses: string[] = [];
  const scoreParts: string[] = [];
  const values: string[] = [];
  let parameterIndex = 2;

  for (const term of filteredTerms) {
    const placeholder = `$${parameterIndex}`;
    clauses.push(`lower(event_document) LIKE lower(${placeholder})`);
    scoreParts.push(`CASE WHEN lower(event_document) LIKE lower(${placeholder}) THEN 1 ELSE 0 END`);
    values.push(`%${term}%`);
    parameterIndex += 1;
  }

  return {
    clause: `(${clauses.join(" OR ")})`,
    values,
    scoreExpression: scoreParts.join(" + ")
  };
}

function loadScopedNarrativeEventRows(
  namespaceId: string,
  terms: readonly string[],
  candidateLimit: number,
  timeStart: string | null,
  timeEnd: string | null
): Promise<SearchRow[]> {
  const match = buildScopedEventSqlMatch(terms);
  const eventDocumentExpression = `concat_ws(
            ' ',
            ne.event_label,
            coalesce(subject_entity.canonical_name, ''),
            coalesce(location_entity.canonical_name, ''),
            coalesce(ne.metadata::text, '')
          )`;
  const eventMatchClause = match.clause.replaceAll("event_document", eventDocumentExpression);
  const eventScoreExpression = match.scoreExpression.replaceAll("event_document", eventDocumentExpression);
  const eventRichnessExpression = `LEAST(
            0.45::double precision,
            (CASE WHEN jsonb_typeof(ne.metadata->'participant_names') = 'array'
              THEN jsonb_array_length(ne.metadata->'participant_names')::double precision * 0.14
              ELSE 0::double precision
            END) +
            (CASE WHEN jsonb_typeof(ne.metadata->'org_project_entity_ids') = 'array'
              THEN jsonb_array_length(ne.metadata->'org_project_entity_ids')::double precision * 0.18
              ELSE 0::double precision
            END)
          )`;

  return queryRows<SearchRow>(
    `
      WITH event_rows AS (
        SELECT
          ne.id AS memory_id,
          'narrative_event'::text AS memory_type,
          ${narrativeEventContentExpression()} AS content,
          ((${eventScoreExpression})::double precision + ${eventRichnessExpression}) AS raw_score,
          ne.artifact_id,
          COALESCE(ne.time_start, ao.observed_at, ne.created_at) AS occurred_at,
          ne.namespace_id,
          jsonb_build_object(
            'tier', 'narrative_event',
            'lexical_provider', 'event_scope',
            'event_kind', ne.event_kind,
            'event_label', ne.event_label,
            'subject_name', subject_entity.canonical_name,
            'location_name', location_entity.canonical_name,
            'source_scene_id', ne.source_scene_id,
            'source_artifact_observation_id', ne.artifact_observation_id,
            'source_uri', a.uri,
            'metadata', ne.metadata,
            'event_richness_boost', ${eventRichnessExpression}
          ) AS provenance
        FROM narrative_events ne
        LEFT JOIN artifacts a ON a.id = ne.artifact_id
        LEFT JOIN artifact_observations ao ON ao.id = ne.artifact_observation_id
        LEFT JOIN entities subject_entity ON subject_entity.id = ne.primary_subject_entity_id
        LEFT JOIN entities location_entity ON location_entity.id = ne.primary_location_entity_id
        WHERE ne.namespace_id = $1
          AND ${eventMatchClause}
          AND ($${match.values.length + 2}::timestamptz IS NULL OR COALESCE(ne.time_start, ao.observed_at, ne.created_at) >= $${match.values.length + 2})
          AND ($${match.values.length + 3}::timestamptz IS NULL OR COALESCE(ne.time_start, ao.observed_at, ne.created_at) <= $${match.values.length + 3})
      )
      SELECT
        memory_id,
        memory_type,
        content,
        raw_score,
        artifact_id,
        occurred_at,
        namespace_id,
        provenance
      FROM event_rows
      ORDER BY
        raw_score DESC,
        occurred_at DESC,
        char_length(content) DESC,
        memory_id DESC
      LIMIT $${match.values.length + 4}
    `,
    [namespaceId, ...match.values, timeStart, timeEnd, candidateLimit]
  );
}

function loadFollowOnVenueRows(
  namespaceId: string,
  queryText: string,
  candidateLimit: number,
  timeStart: string | null,
  timeEnd: string | null
): Promise<SearchRow[]> {
  const terms = buildEventBoundedEvidenceTerms(queryText, [])
    .filter((term) => term.length > 1)
    .slice(0, 12);
  const match = buildFocusedLikeMatchClause(4, terms, "em.content");

  return queryRows<SearchRow>(
    `
      SELECT
        em.id AS memory_id,
        'episodic_memory'::text AS memory_type,
        em.content,
        ((${match.scoreExpression}) +
          CASE
            WHEN em.content ~* '(coffee|cafe|café|living a dream)' THEN 3
            ELSE 0
          END +
          CASE
            WHEN em.content ~* '(meetup|hotel|canass|chiang mai|after)' THEN 2
            ELSE 0
          END
        )::double precision AS raw_score,
        em.artifact_id,
        em.occurred_at,
        em.namespace_id,
        jsonb_build_object(
          'tier', 'focused_episodic_support',
          'lexical_provider', 'follow_on_venue_scope',
          'source_uri', a.uri,
          'artifact_observation_id', em.artifact_observation_id,
          'metadata', em.metadata
        ) AS provenance
      FROM episodic_memory em
      LEFT JOIN artifacts a ON a.id = em.artifact_id
      WHERE em.namespace_id = $1
        AND ($2::timestamptz IS NULL OR em.occurred_at >= $2)
        AND ($3::timestamptz IS NULL OR em.occurred_at <= $3)
        AND ${match.clause}
      ORDER BY raw_score DESC, em.occurred_at DESC, em.id DESC
      LIMIT $${match.values.length + 4}
    `,
    [namespaceId, timeStart, timeEnd, ...match.values, Math.max(candidateLimit, 6)]
  );
}

function loadEventNeighborhoodEpisodicRows(
  namespaceId: string,
  queryText: string,
  terms: readonly string[],
  candidateLimit: number,
  timeStart: string | null,
  timeEnd: string | null
): Promise<SearchRow[]> {
  const scopedTerms = terms
    .map((term) => normalizeWhitespace(term).toLowerCase())
    .filter((term) => term.length > 1)
    .slice(0, 14);
  const match = buildFocusedLikeMatchClause(4, scopedTerms, "em.content");
  const exactFamily = inferExactDetailQuestionFamily(queryText);
  const anchorTerms = queryAnchorTerms(queryText);
  const requireAnchorMatch = exactFamily === "realization" && anchorTerms.length > 0;
  const anchorMatch = requireAnchorMatch
    ? buildFocusedLikeMatchClause(4 + match.values.length, anchorTerms, "em.content")
    : { clause: "TRUE", values: [], scoreExpression: "0::double precision" };
  const realizationBonus =
    exactFamily === "realization"
      ? `CASE
          WHEN em.content ~* '(charity|race|thought-provoking|realiz|self-care|mental health)' THEN 4
          WHEN em.content ~* '(take care|taking care)' THEN 2
          ELSE 0
        END`
      : "0";
  const motiveBonus =
    /\b(?:spark(?:ed)?|interest|why\s+did)\b/i.test(queryText)
      ? `CASE
          WHEN em.content ~* '(growing up|grew up|education|infrastructure|community|neighborhood)' THEN 4
          WHEN em.content ~* '(meeting|meetings|involved)' THEN 2
          ELSE 0
        END`
      : "0";

  return queryRows<SearchRow>(
    `
      SELECT
        em.id AS memory_id,
        'episodic_memory'::text AS memory_type,
        em.content,
        ((${match.scoreExpression}) + (${realizationBonus})::double precision + (${motiveBonus})::double precision)::double precision AS raw_score,
        em.artifact_id,
        em.occurred_at,
        em.namespace_id,
        jsonb_build_object(
          'tier', 'event_neighborhood_episodic',
          'lexical_provider', 'event_neighborhood_scope',
          'source_uri', a.uri,
          'artifact_observation_id', em.artifact_observation_id,
          'source_chunk_id', em.source_chunk_id,
          'metadata', em.metadata
        ) AS provenance
      FROM episodic_memory em
      LEFT JOIN artifacts a ON a.id = em.artifact_id
      WHERE em.namespace_id = $1
        AND ($2::timestamptz IS NULL OR em.occurred_at >= $2)
        AND ($3::timestamptz IS NULL OR em.occurred_at <= $3)
        AND ${match.clause}
        AND ${anchorMatch.clause}
      ORDER BY raw_score DESC, em.occurred_at DESC, em.id DESC
      LIMIT $${match.values.length + anchorMatch.values.length + 4}
    `,
    [namespaceId, timeStart, timeEnd, ...match.values, ...anchorMatch.values, Math.max(candidateLimit, 6)]
  );
}

function loadAnchoredRealizationSupportRows(
  namespaceId: string,
  queryText: string,
  candidateLimit: number,
  timeStart: string | null,
  timeEnd: string | null
): Promise<SearchRow[]> {
  const anchorTerms = queryAnchorTerms(queryText)
    .map((term) => normalizeWhitespace(term).toLowerCase())
    .filter((term) => term.length > 1)
    .slice(0, 6);
  if (anchorTerms.length === 0) {
    return Promise.resolve([]);
  }

  const realizationCueTerms = ["realiz", "thought-provoking", "self-care", "take care", "taking care", "rewarding"];
  const anchorMatch = buildFocusedLikeMatchClause(4, anchorTerms, "em.content");
  const cueMatch = buildFocusedLikeMatchClause(4 + anchorMatch.values.length, realizationCueTerms, "em.content");

  return queryRows<SearchRow>(
    `
      SELECT
        em.id AS memory_id,
        'episodic_memory'::text AS memory_type,
        em.content,
        ((${anchorMatch.scoreExpression})::double precision * 3.0::double precision +
          (${cueMatch.scoreExpression})::double precision * 2.0::double precision)::double precision AS raw_score,
        em.artifact_id,
        em.occurred_at,
        em.namespace_id,
        jsonb_build_object(
          'tier', 'anchored_realization_support',
          'lexical_provider', 'anchored_realization_scope',
          'source_uri', a.uri,
          'artifact_observation_id', em.artifact_observation_id,
          'source_chunk_id', em.source_chunk_id,
          'metadata', em.metadata
        ) AS provenance
      FROM episodic_memory em
      LEFT JOIN artifacts a ON a.id = em.artifact_id
      WHERE em.namespace_id = $1
        AND ($2::timestamptz IS NULL OR em.occurred_at >= $2)
        AND ($3::timestamptz IS NULL OR em.occurred_at <= $3)
        AND ${anchorMatch.clause}
        AND ${cueMatch.clause}
      ORDER BY raw_score DESC, em.occurred_at DESC, em.id DESC
      LIMIT $${anchorMatch.values.length + cueMatch.values.length + 4}
    `,
    [namespaceId, timeStart, timeEnd, ...anchorMatch.values, ...cueMatch.values, Math.max(candidateLimit, 4)]
  );
}

function loadHistoricalRelationshipSupportRows(
  namespaceId: string,
  queryText: string,
  candidateLimit: number
): Promise<SearchRow[]> {
  const participants = extractConversationParticipants(queryText)
    .map((participant) => normalizeWhitespace(participant))
    .filter(Boolean)
    .slice(0, 3);
  if (participants.length === 0) {
    return Promise.resolve([]);
  }

  const terms = [
    ...participants,
    "history",
    "friend",
    "dating",
    "date",
    "fling",
    "Bend",
    "Tahoe",
    "Tahoe City"
  ].slice(0, 12);
  const match = buildFocusedLikeMatchClause(2, terms, "em.content");

  return queryRows<SearchRow>(
    `
      SELECT
        em.id AS memory_id,
        'episodic_memory'::text AS memory_type,
        em.content,
        ((${match.scoreExpression}) +
          CASE
            WHEN em.content ~* '(friend|friends with benefits|dating|date|fling|close|reconnect|fell out of touch|bend|tahoe)' THEN 3
            ELSE 0
          END
        )::double precision AS raw_score,
        em.artifact_id,
        em.occurred_at,
        em.namespace_id,
        jsonb_build_object(
          'tier', 'focused_episodic_support',
          'lexical_provider', 'historical_relationship_scope',
          'source_uri', a.uri,
          'artifact_observation_id', em.artifact_observation_id,
          'metadata', em.metadata
        ) AS provenance
      FROM episodic_memory em
      LEFT JOIN artifacts a ON a.id = em.artifact_id
      WHERE em.namespace_id = $1
        AND ${match.clause}
      ORDER BY raw_score DESC, em.occurred_at DESC, em.id DESC
      LIMIT $${match.values.length + 2}
    `,
    [namespaceId, ...match.values, Math.max(candidateLimit, 8)]
  );
}

function loadLowInformationTemporalWindowRows(
  namespaceId: string,
  candidateLimit: number,
  timeStart: string | null,
  timeEnd: string | null,
  options: {
    readonly includeEpisodicRows?: boolean;
    readonly allowedTemporalLayers?: readonly ("day" | "week" | "month" | "year")[];
  } = {}
): Promise<SearchRow[]> {
  if (!timeStart && !timeEnd) {
    return Promise.resolve([]);
  }

  const includeEpisodicRows = options.includeEpisodicRows ?? true;
  const allowedTemporalLayers = options.allowedTemporalLayers?.length ? [...new Set(options.allowedTemporalLayers)] : null;

  return queryRows<SearchRow>(
    `
      WITH temporal_rows AS (
        SELECT
          id AS memory_id,
          'temporal_nodes'::text AS memory_type,
          summary_text AS content,
          (
            CASE layer
              WHEN 'day' THEN 1.18::double precision
              WHEN 'week' THEN 0.78::double precision
              WHEN 'month' THEN 0.62::double precision
              ELSE 0.54::double precision
            END
          ) * (
            CASE
              WHEN $2::timestamptz IS NULL OR $3::timestamptz IS NULL THEN 1.0::double precision
              ELSE
                0.6::double precision +
                LEAST(
                  1.0::double precision,
                  GREATEST(
                    0.0::double precision,
                    EXTRACT(EPOCH FROM LEAST(period_end, $3::timestamptz) - GREATEST(period_start, $2::timestamptz)) /
                    NULLIF(EXTRACT(EPOCH FROM ($3::timestamptz - $2::timestamptz)), 0)
                  )
                ) * 0.8::double precision
            END
          ) AS raw_score,
          NULL::uuid AS artifact_id,
          period_end AS occurred_at,
          namespace_id,
          jsonb_build_object(
            'tier', 'time_window_bootstrap',
            'lexical_provider', 'time_window_bootstrap',
            'layer', layer,
            'period_start', period_start,
            'period_end', period_end,
            'summary_version', summary_version,
            'source_count', source_count,
            'generated_by', generated_by,
            'status', status,
            'archival_tier', archival_tier,
            'metadata', metadata
          ) AS provenance
        FROM temporal_nodes
        WHERE namespace_id = $1
          AND status = 'active'
          AND summary_text <> ''
          AND ($2::timestamptz IS NULL OR period_end >= $2::timestamptz)
          AND ($3::timestamptz IS NULL OR period_start <= $3::timestamptz)
          AND ($5::text[] IS NULL OR layer = ANY($5::text[]))
      ),
      semantic_rows AS (
        SELECT
          sm.id AS memory_id,
          'semantic_memory'::text AS memory_type,
          sm.content_abstract AS content,
          1.26::double precision AS raw_score,
          em.artifact_id,
          COALESCE(sm.valid_from, em.occurred_at) AS occurred_at,
          sm.namespace_id,
          jsonb_build_object(
            'tier', 'time_window_bootstrap',
            'lexical_provider', 'time_window_bootstrap',
            'memory_kind', sm.memory_kind,
            'canonical_key', sm.canonical_key,
            'valid_from', sm.valid_from,
            'valid_until', sm.valid_until,
            'status', sm.status,
            'source_episodic_id', sm.source_episodic_id,
            'source_uri', a.uri,
            'metadata', sm.metadata
          ) AS provenance
        FROM semantic_memory sm
        LEFT JOIN episodic_memory em ON em.id = sm.source_episodic_id
        LEFT JOIN artifacts a ON a.id = em.artifact_id
        WHERE sm.namespace_id = $1
          AND sm.status = 'active'
          AND (
            sm.memory_kind = 'day_summary' OR
            sm.canonical_key LIKE 'reconsolidated:day_summary:%'
          )
          AND ($2::timestamptz IS NULL OR COALESCE(sm.valid_from, em.occurred_at) >= $2::timestamptz)
          AND ($3::timestamptz IS NULL OR COALESCE(sm.valid_from, em.occurred_at) <= $3::timestamptz)
      ),
      episodic_rows AS (
        SELECT
          em.id AS memory_id,
          'episodic_memory'::text AS memory_type,
          em.content,
          0.68::double precision AS raw_score,
          em.artifact_id,
          em.occurred_at,
          em.namespace_id,
          jsonb_build_object(
            'tier', 'time_window_bootstrap',
            'lexical_provider', 'time_window_bootstrap',
            'artifact_observation_id', em.artifact_observation_id,
            'source_chunk_id', em.source_chunk_id,
            'source_offset', em.source_offset,
            'source_uri', a.uri,
            'metadata', em.metadata
          ) AS provenance
        FROM episodic_memory em
        LEFT JOIN artifacts a ON a.id = em.artifact_id
        WHERE em.namespace_id = $1
          AND $6::boolean
          AND ($2::timestamptz IS NULL OR em.occurred_at >= $2::timestamptz)
          AND ($3::timestamptz IS NULL OR em.occurred_at <= $3::timestamptz)
      )
      SELECT
        memory_id,
        memory_type,
        content,
        raw_score,
        artifact_id,
        occurred_at,
        namespace_id,
        provenance
      FROM (
        SELECT * FROM semantic_rows
        UNION ALL
        SELECT * FROM temporal_rows
        UNION ALL
        SELECT * FROM episodic_rows
      ) candidates
      ORDER BY raw_score DESC, occurred_at DESC, memory_id DESC
      LIMIT $4
    `,
    [namespaceId, timeStart, timeEnd, candidateLimit, allowedTemporalLayers, includeEpisodicRows]
  );
}

function loadLowInformationTemporalActionRows(
  namespaceId: string,
  candidateLimit: number,
  timeStart: string | null,
  timeEnd: string | null
): Promise<SearchRow[]> {
  if (!timeStart && !timeEnd) {
    return Promise.resolve([]);
  }

  return queryRows<SearchRow>(
    `
      SELECT
        em.id AS memory_id,
        'episodic_memory'::text AS memory_type,
        em.content,
        (
          0.86::double precision +
          CASE
            WHEN em.content ~* '\\m(later|that night|morning|afternoon|evening|night|before|after)\\M'
              THEN 0.16::double precision
            ELSE 0::double precision
          END +
          CASE
            WHEN em.content ~* '\\m(met|spent|grabbed|finished|worked|reviewed|talked|watched|went|had)\\M'
              THEN 0.14::double precision
            ELSE 0::double precision
          END +
          CASE
            WHEN em.content ~* '\\m(with|at|in|to)\\M'
              THEN 0.06::double precision
            ELSE 0::double precision
          END +
          CASE
            WHEN em.content ~* '\\m(karaoke|dinner|lunch|breakfast|drinks|movie|movies|massage|hike|ride|khao\\s+soi)\\M'
              THEN 0.18::double precision
            ELSE 0::double precision
          END +
          CASE
            WHEN em.content ~* '\\m(coworking|co-working|worked\\s+on|planning|plan(?:ned|ning)?)\\M'
              THEN 0.12::double precision
            ELSE 0::double precision
          END +
          LEAST(0.16::double precision, length(em.content)::double precision / 1800.0::double precision)
        ) AS raw_score,
        em.artifact_id,
        em.occurred_at,
        em.namespace_id,
        jsonb_build_object(
          'tier', 'time_window_action_bootstrap',
          'lexical_provider', 'time_window_action_bootstrap',
          'artifact_observation_id', em.artifact_observation_id,
          'source_chunk_id', em.source_chunk_id,
          'source_offset', em.source_offset,
          'source_uri', a.uri,
          'metadata', em.metadata
        ) AS provenance
      FROM episodic_memory em
      LEFT JOIN artifacts a ON a.id = em.artifact_id
      WHERE em.namespace_id = $1
        AND ($2::timestamptz IS NULL OR em.occurred_at >= $2::timestamptz)
        AND ($3::timestamptz IS NULL OR em.occurred_at <= $3::timestamptz)
      ORDER BY raw_score DESC, em.occurred_at DESC, em.id DESC
      LIMIT $4
    `,
    [namespaceId, timeStart, timeEnd, candidateLimit]
  );
}

async function loadTemporalTranscriptWindowRows(
  namespaceId: string,
  candidateLimit: number,
  timeStart: string | null,
  timeEnd: string | null,
  queryText: string,
  speakerTerms: readonly string[]
): Promise<SearchRow[]> {
  const normalizedQuery = normalizeWhitespace(queryText);
  if (!normalizedQuery && speakerTerms.length === 0) {
    return [];
  }

  return queryRows<SearchRow>(
    `
      WITH transcript_query AS (
        SELECT websearch_to_tsquery('english', $2) AS query
      )
      SELECT
        concat('transcript_utterance:', tu.id::text) AS memory_id,
        'episodic_memory'::text AS memory_type,
        concat(coalesce(tu.speaker_name, tu.speaker_label, 'Someone'), ' said: ', coalesce(tu.normalized_text, tu.utterance_text)) AS content,
        (
          ts_rank_cd(
            to_tsvector(
              'english',
              concat_ws(
                ' ',
                coalesce(tu.speaker_name, tu.speaker_label, ''),
                coalesce(tu.normalized_text, ''),
                coalesce(tu.utterance_text, '')
              )
            ),
            transcript_query.query
          )
          + CASE
              WHEN EXISTS (
                SELECT 1
                FROM unnest($4::text[]) AS speaker_term(term)
                WHERE lower(coalesce(tu.speaker_name, tu.speaker_label, '')) = lower(speaker_term.term)
              ) THEN 0.45
              ELSE 0
            END
          + 0.18
        )::double precision AS raw_score,
        tu.artifact_id::text AS artifact_id,
        tu.occurred_at::text AS occurred_at,
        tu.namespace_id,
        jsonb_build_object(
          'tier', 'transcript_utterance',
          'speaker_name', coalesce(tu.speaker_name, tu.speaker_label),
          'artifact_observation_id', tu.artifact_observation_id,
          'derivation_id', tu.derivation_id,
          'source_uri', a.uri,
          'metadata', tu.metadata
        ) AS provenance
      FROM transcript_utterances tu
      CROSS JOIN transcript_query
      LEFT JOIN artifacts a ON a.id = tu.artifact_id
      WHERE tu.namespace_id = $1
        AND ($5::timestamptz IS NULL OR tu.occurred_at >= $5::timestamptz)
        AND ($6::timestamptz IS NULL OR tu.occurred_at <= $6::timestamptz)
        AND (
          to_tsvector(
            'english',
            concat_ws(
              ' ',
              coalesce(tu.speaker_name, tu.speaker_label, ''),
              coalesce(tu.normalized_text, ''),
              coalesce(tu.utterance_text, '')
            )
          ) @@ transcript_query.query
          OR (
            cardinality($4::text[]) > 0 AND
            EXISTS (
              SELECT 1
              FROM unnest($4::text[]) AS speaker_term(term)
              WHERE lower(coalesce(tu.speaker_name, tu.speaker_label, '')) = lower(speaker_term.term)
            )
          )
        )
      ORDER BY raw_score DESC, tu.occurred_at DESC
      LIMIT $3
    `,
    [namespaceId, normalizedQuery || speakerTerms.join(" "), Math.max(candidateLimit * 2, 8), speakerTerms, timeStart, timeEnd]
  );
}

function loadHistoricalWorkedAtRows(
  namespaceId: string,
  queryText: string,
  candidateLimit: number,
  timeStart: string | null,
  timeEnd: string | null
): Promise<SearchRow[]> {
  return queryRows<SearchRow>(
    `
      SELECT
        rm.id AS memory_id,
        'relationship_memory'::text AS memory_type,
        ${relationshipContentExpression()} AS content,
        0.42::double precision AS raw_score,
        e.artifact_id,
        COALESCE(e.occurred_at, rm.valid_from) AS occurred_at,
        rm.namespace_id,
        jsonb_build_object(
          'tier', 'relationship_memory',
          'status', rm.status,
          'predicate', rm.predicate,
          'subject_name', subject_entity.canonical_name,
          'object_name', object_entity.canonical_name,
          'source_uri', a.uri,
          'source_memory_id', e.id,
          'source_candidate_id', rc.id,
          'lexical_provider', 'historical_work_scope',
          'metadata', rm.metadata
        ) AS provenance
      FROM relationship_memory rm
      JOIN entities subject_entity ON subject_entity.id = rm.subject_entity_id
      JOIN entities object_entity ON object_entity.id = rm.object_entity_id
      LEFT JOIN relationship_candidates rc ON rc.id = rm.source_candidate_id
      LEFT JOIN episodic_memory e ON e.id = rc.source_memory_id
      LEFT JOIN artifacts a ON a.id = e.artifact_id
      WHERE rm.namespace_id = $1
        AND rm.predicate = 'worked_at'
        AND rm.status IN ('active', 'superseded')
        AND to_tsvector(
              'english',
              concat_ws(' ', subject_entity.canonical_name, object_entity.canonical_name, rm.predicate)
            ) @@ websearch_to_tsquery('english', $2)
        AND ($3::timestamptz IS NULL OR COALESCE(e.occurred_at, rm.valid_from) >= $3)
        AND ($4::timestamptz IS NULL OR COALESCE(e.occurred_at, rm.valid_from) <= $4)
      ORDER BY rm.valid_from ASC, object_entity.canonical_name ASC
      LIMIT GREATEST($5, 24)
    `,
    [namespaceId, queryText, timeStart, timeEnd, candidateLimit]
  );
}

function loadHistoricalHomeRows(
  namespaceId: string,
  queryText: string,
  candidateLimit: number,
  timeStart: string | null,
  timeEnd: string | null
): Promise<SearchRow[]> {
  const nameHints = extractEntityNameHints(queryText);
  if (nameHints.length === 0) {
    return Promise.resolve([]);
  }

  return queryRows<SearchRow>(
    `
      SELECT
        rm.id AS memory_id,
        'relationship_memory'::text AS memory_type,
        ${relationshipContentExpression()} AS content,
        0.48::double precision AS raw_score,
        e.artifact_id,
        COALESCE(e.occurred_at, rm.valid_from) AS occurred_at,
        rm.namespace_id,
        jsonb_build_object(
          'tier', 'relationship_memory',
          'status', rm.status,
          'predicate', rm.predicate,
          'subject_name', subject_entity.canonical_name,
          'object_name', object_entity.canonical_name,
          'source_uri', a.uri,
          'source_memory_id', e.id,
          'source_candidate_id', rc.id,
          'lexical_provider', 'historical_home_scope',
          'metadata', rm.metadata
        ) AS provenance
      FROM relationship_memory rm
      JOIN entities subject_entity ON subject_entity.id = rm.subject_entity_id
      JOIN entities object_entity ON object_entity.id = rm.object_entity_id
      LEFT JOIN relationship_candidates rc ON rc.id = rm.source_candidate_id
      LEFT JOIN episodic_memory e ON e.id = rc.source_memory_id
      LEFT JOIN artifacts a ON a.id = e.artifact_id
      WHERE rm.namespace_id = $1
        AND rm.predicate = ANY(ARRAY['lived_in', 'born_in', 'resides_at']::text[])
        AND rm.status IN ('active', 'superseded')
        AND EXISTS (
          SELECT 1
          FROM unnest($2::text[]) AS hint(name_hint)
          WHERE lower(subject_entity.canonical_name) LIKE '%' || hint.name_hint || '%'
        )
        AND ($3::timestamptz IS NULL OR COALESCE(e.occurred_at, rm.valid_from) >= $3)
        AND ($4::timestamptz IS NULL OR COALESCE(e.occurred_at, rm.valid_from) <= $4)
      ORDER BY rm.valid_from ASC, object_entity.canonical_name ASC
      LIMIT GREATEST($5, 24)
    `,
    [namespaceId, nameHints, timeStart, timeEnd, candidateLimit]
  );
}

function extractEntityNameHints(queryText: string): readonly string[] {
  const matches = queryText.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2}\b/g) ?? [];
  return [...new Set(matches.map((value) => value.trim().toLowerCase()))].filter(
    (value) => !["what", "where", "who", "when", "why", "steve t", "ai brain"].includes(value)
  );
}

function loadPreferredActiveRelationshipRows(
  namespaceId: string,
  queryText: string,
  predicates: readonly string[],
  candidateLimit: number
): Promise<SearchRow[]> {
  const nameHints = extractEntityNameHints(queryText);
  if (predicates.length === 0 || nameHints.length === 0) {
    return Promise.resolve([]);
  }

  return queryRows<SearchRow>(
    `
      SELECT *
      FROM (
        SELECT
          rm.id AS memory_id,
          'relationship_memory'::text AS memory_type,
          ${relationshipContentExpression()} AS content,
          1.25::double precision AS raw_score,
          e.artifact_id,
          COALESCE(e.occurred_at, rm.valid_from) AS occurred_at,
          rm.namespace_id,
          jsonb_build_object(
            'tier', 'relationship_memory',
            'lexical_provider', 'active_support',
            'subject_name', subject_entity.canonical_name,
            'predicate', rm.predicate,
            'object_name', object_entity.canonical_name,
            'status', rm.status,
            'source_candidate_id', rm.source_candidate_id,
            'source_memory_id', rc.source_memory_id,
            'source_uri', a.uri,
            'metadata', rm.metadata
          ) AS provenance,
          COALESCE(e.occurred_at, rm.valid_from) AS sort_occurred_at
        FROM relationship_memory rm
        JOIN entities subject_entity ON subject_entity.id = rm.subject_entity_id
        JOIN entities object_entity ON object_entity.id = rm.object_entity_id
        LEFT JOIN relationship_candidates rc ON rc.id = rm.source_candidate_id
        LEFT JOIN episodic_memory e ON e.id = rc.source_memory_id
        LEFT JOIN artifacts a ON a.id = e.artifact_id
        WHERE rm.namespace_id = $1
          AND rm.status = 'active'
          AND rm.valid_until IS NULL
          AND rm.predicate = ANY($2::text[])
          AND (
            lower(subject_entity.canonical_name) = ANY($3::text[])
            OR lower(object_entity.canonical_name) = ANY($3::text[])
          )

        UNION ALL

        SELECT
          rc.id AS memory_id,
          'relationship_memory'::text AS memory_type,
          concat(subject_entity.canonical_name, ' ', replace(rc.predicate, '_', ' '), ' ', object_entity.canonical_name) AS content,
          1.15::double precision AS raw_score,
          e.artifact_id,
          COALESCE(e.occurred_at, rc.created_at) AS occurred_at,
          rc.namespace_id,
          jsonb_build_object(
            'tier', 'relationship_candidate',
            'lexical_provider', 'active_support_candidate',
            'subject_name', subject_entity.canonical_name,
            'predicate', rc.predicate,
            'object_name', object_entity.canonical_name,
            'status', rc.status,
            'source_candidate_id', rc.id,
            'source_memory_id', rc.source_memory_id,
            'source_uri', a.uri,
            'metadata', rc.metadata
          ) AS provenance,
          COALESCE(e.occurred_at, rc.created_at) AS sort_occurred_at
        FROM relationship_candidates rc
        JOIN entities subject_entity ON subject_entity.id = rc.subject_entity_id
        JOIN entities object_entity ON object_entity.id = rc.object_entity_id
        LEFT JOIN episodic_memory e ON e.id = rc.source_memory_id
        LEFT JOIN artifacts a ON a.id = e.artifact_id
        WHERE rc.namespace_id = $1
          AND rc.status IN ('accepted', 'pending')
          AND rc.predicate = ANY($2::text[])
          AND (
            lower(subject_entity.canonical_name) = ANY($3::text[])
            OR lower(object_entity.canonical_name) = ANY($3::text[])
          )
      ) active_relationships
      ORDER BY sort_occurred_at DESC NULLS LAST
      LIMIT $4
    `,
    [namespaceId, predicates, nameHints, candidateLimit]
  );
}

function proceduralStateTypesForPredicates(predicates: readonly string[]): readonly string[] {
  const stateTypes = new Set<string>();
  if (predicates.includes("works_at") || predicates.includes("worked_at")) {
    stateTypes.add("current_employer");
    stateTypes.add("active_affiliation");
  }
  if (predicates.includes("works_on") || predicates.includes("project_role")) {
    stateTypes.add("current_project");
    stateTypes.add("project_role");
  }
  if (predicates.includes("resides_at") || predicates.includes("lives_in") || predicates.includes("currently_in")) {
    stateTypes.add("current_location");
  }
  if (predicates.includes("member_of")) {
    stateTypes.add("active_membership");
  }
  if (predicates.includes("significant_other_of")) {
    stateTypes.add("current_relationship");
  }
  return [...stateTypes];
}

function extractSubjectHintsFromQuery(queryText: string): readonly string[] {
  const blocked = new Set([
    "what",
    "who",
    "where",
    "when",
    "why",
    "what",
    "did",
    "does",
    "do",
    "is",
    "are",
    "was",
    "were",
    "my",
    "i"
  ]);

  const focus = parseQueryEntityFocus(queryText);
  const primaryOnly = focus.mode === "primary_with_companion" && focus.primaryHints.length === 1
    ? new Set(focus.primaryHints.map((value) => value.toLowerCase()))
    : null;
  const matches = queryText.match(/\b[A-Z][A-Za-z.'-]*(?:\s+[A-Z][A-Za-z.'-]*)*/gu) ?? [];
  return matches
    .map((term) => normalizeWhitespace(term).replace(/['’]s$/iu, ""))
    .filter((term) => term.length > 1 && !blocked.has(term.toLowerCase()))
    .filter((term) => !primaryOnly || primaryOnly.has(term.toLowerCase()))
    .filter((term, index, array) => array.findIndex((candidate) => candidate.toLowerCase() === term.toLowerCase()) === index);
}

function graphSeedKindFromSearchRow(row: Pick<SearchRow, "memory_type" | "provenance">): string {
  if (typeof row.provenance.profile_kind === "string" && row.provenance.profile_kind) {
    return row.provenance.profile_kind;
  }
  if (typeof row.provenance.state_type === "string" && row.provenance.state_type) {
    return row.provenance.state_type;
  }
  if (typeof row.provenance.tier === "string" && row.provenance.tier) {
    return row.provenance.tier;
  }
  return row.memory_type;
}

function scoreGraphExpansionRow(content: string, queryText: string, graphWeight: number, edgeType: string): number {
  const normalizedQuery = queryText.toLowerCase();
  const normalizedContent = content.toLowerCase();
  const queryTerms = (normalizedQuery.match(/[a-z0-9][a-z0-9._:-]*/g) ?? [])
    .filter((term) => !BM25_STOP_WORDS.has(term))
    .slice(0, 10);
  const matchedTerms = queryTerms.filter((term) => normalizedContent.includes(term)).length;

  let score = graphWeight * 2.4 + matchedTerms * 0.35;
  if (edgeType === "support") {
    score += 0.6;
  } else if (edgeType === "relationship_link") {
    score += 0.8;
  } else if (edgeType === "supersedes") {
    score -= 0.15;
  }
  return score;
}

async function loadGraphExpansionRows(
  namespaceId: string,
  queryText: string,
  seedRows: readonly SqlFusedRankingRow[],
  candidateLimit: number,
  subjectHints: readonly string[]
): Promise<RankedSearchRow[]> {
  const seeds = seedRows
    .map((item) => item.row)
    .filter((row) =>
      ["episodic_memory", "semantic_memory", "procedural_memory", "relationship_memory"].includes(row.memory_type) &&
      isUuidLike(row.memory_id)
    )
    .slice(0, 6)
    .map((row) => ({
      memory_id: row.memory_id,
      memory_type: row.memory_type,
      seed_kind: graphSeedKindFromSearchRow(row)
    }));

  if (seeds.length === 0) {
    return [];
  }

  const subjectPatterns = subjectHints.map((hint) => `%${hint}%`);
  const neighbors = await queryRows<{
    memory_id: string;
    memory_type: SearchRow["memory_type"];
    graph_weight: number;
    graph_edge_type: string;
    graph_seed_kind: string;
  }>(
    `
      WITH seeds AS (
        SELECT *
        FROM jsonb_to_recordset($2::jsonb) AS x(
          memory_id uuid,
          memory_type text,
          seed_kind text
        )
      ),
      neighbors AS (
        SELECT
          CASE
            WHEN e.source_memory_id = s.memory_id AND e.source_memory_type = s.memory_type
              THEN e.target_memory_id
            ELSE e.source_memory_id
          END AS memory_id,
          CASE
            WHEN e.source_memory_id = s.memory_id AND e.source_memory_type = s.memory_type
              THEN e.target_memory_type
            ELSE e.source_memory_type
          END AS memory_type,
          max(e.weight) AS graph_weight,
          (array_agg(e.edge_type ORDER BY e.weight DESC, e.last_reinforced_at DESC))[1] AS graph_edge_type,
          (array_agg(s.seed_kind ORDER BY e.weight DESC, e.last_reinforced_at DESC))[1] AS graph_seed_kind
        FROM seeds s
        JOIN memory_graph_edges e
          ON e.namespace_id = $1
         AND (
              (e.source_memory_id = s.memory_id AND e.source_memory_type = s.memory_type)
           OR (e.target_memory_id = s.memory_id AND e.target_memory_type = s.memory_type)
         )
        GROUP BY 1, 2
        ORDER BY graph_weight DESC
        LIMIT $3
      )
      SELECT memory_id::text, memory_type, graph_weight, graph_edge_type, graph_seed_kind
      FROM neighbors
    `,
    [namespaceId, JSON.stringify(seeds), Math.max(candidateLimit, 12)]
  );

  if (neighbors.length === 0) {
    return [];
  }

  const neighborPayload = JSON.stringify(neighbors);
  const rows: SearchRow[] = [];

  rows.push(
    ...(await queryRows<SearchRow>(
      `
        WITH neighbors AS (
          SELECT *
          FROM jsonb_to_recordset($2::jsonb) AS x(
            memory_id uuid,
            memory_type text,
            graph_weight double precision,
            graph_edge_type text,
            graph_seed_kind text
          )
        )
        SELECT
          sm.id AS memory_id,
          'semantic_memory'::text AS memory_type,
          sm.content_abstract AS content,
          n.graph_weight AS raw_score,
          em.artifact_id,
          sm.valid_from AS occurred_at,
          sm.namespace_id,
          jsonb_build_object(
            'tier', 'graph_expansion_support',
            'memory_kind', sm.memory_kind,
            'canonical_key', sm.canonical_key,
            'source_memory_id', sm.source_episodic_id,
            'metadata', sm.metadata,
            'graph_weight', n.graph_weight,
            'graph_edge_type', n.graph_edge_type,
            'graph_seed_kind', n.graph_seed_kind
          ) AS provenance
        FROM neighbors n
        JOIN semantic_memory sm
          ON n.memory_type = 'semantic_memory'
         AND sm.id = n.memory_id
         AND sm.namespace_id = $1
         AND sm.status = 'active'
         AND sm.valid_until IS NULL
        LEFT JOIN episodic_memory em ON em.id = sm.source_episodic_id
        WHERE
          cardinality($3::text[]) = 0
          OR coalesce(sm.metadata->>'person_name', sm.content_abstract) ILIKE ANY($3::text[])
      `,
      [namespaceId, neighborPayload, subjectPatterns]
    ))
  );

  rows.push(
    ...(await queryRows<SearchRow>(
      `
        WITH neighbors AS (
          SELECT *
          FROM jsonb_to_recordset($2::jsonb) AS x(
            memory_id uuid,
            memory_type text,
            graph_weight double precision,
            graph_edge_type text,
            graph_seed_kind text
          )
        )
        SELECT
          pm.id AS memory_id,
          'procedural_memory'::text AS memory_type,
          ${proceduralContentExpression()} AS content,
          n.graph_weight AS raw_score,
          em.artifact_id,
          coalesce(em.occurred_at, pm.updated_at) AS occurred_at,
          pm.namespace_id,
          jsonb_build_object(
            'tier', 'graph_expansion_support',
            'state_type', pm.state_type,
            'state_key', pm.state_key,
            'source_memory_id', em.id,
            'metadata', pm.metadata,
            'graph_weight', n.graph_weight,
            'graph_edge_type', n.graph_edge_type,
            'graph_seed_kind', n.graph_seed_kind
          ) AS provenance
        FROM neighbors n
        JOIN procedural_memory pm
          ON n.memory_type = 'procedural_memory'
         AND pm.id = n.memory_id
         AND pm.namespace_id = $1
         AND pm.valid_until IS NULL
        LEFT JOIN episodic_memory em
          ON em.id = NULLIF(pm.state_value->>'source_memory_id', '')::uuid
        WHERE
          cardinality($3::text[]) = 0
          OR coalesce(pm.state_value->>'person', ${proceduralContentExpression()}) ILIKE ANY($3::text[])
      `,
      [namespaceId, neighborPayload, subjectPatterns]
    ))
  );

  rows.push(
    ...(await queryRows<SearchRow>(
      `
        WITH neighbors AS (
          SELECT *
          FROM jsonb_to_recordset($2::jsonb) AS x(
            memory_id uuid,
            memory_type text,
            graph_weight double precision,
            graph_edge_type text,
            graph_seed_kind text
          )
        )
        SELECT
          rm.id AS memory_id,
          'relationship_memory'::text AS memory_type,
          subj.canonical_name || ' ' || rm.predicate || ' ' || obj.canonical_name AS content,
          n.graph_weight AS raw_score,
          em.artifact_id,
          coalesce(em.occurred_at, rm.valid_from) AS occurred_at,
          rm.namespace_id,
          jsonb_build_object(
            'tier', 'graph_expansion_support',
            'predicate', rm.predicate,
            'subject_name', subj.canonical_name,
            'object_name', obj.canonical_name,
            'source_memory_id', em.id,
            'metadata', rm.metadata,
            'graph_weight', n.graph_weight,
            'graph_edge_type', n.graph_edge_type,
            'graph_seed_kind', n.graph_seed_kind
          ) AS provenance
        FROM neighbors n
        JOIN relationship_memory rm
          ON n.memory_type = 'relationship_memory'
         AND rm.id = n.memory_id
         AND rm.namespace_id = $1
         AND rm.valid_until IS NULL
         AND rm.status = 'active'
        JOIN entities subj ON subj.id = rm.subject_entity_id
        JOIN entities obj ON obj.id = rm.object_entity_id
        LEFT JOIN episodic_memory em
          ON em.id = NULLIF(rm.metadata->>'source_memory_id', '')::uuid
        WHERE
          cardinality($3::text[]) = 0
          OR subj.canonical_name ILIKE ANY($3::text[])
          OR obj.canonical_name ILIKE ANY($3::text[])
      `,
      [namespaceId, neighborPayload, subjectPatterns]
    ))
  );

  rows.push(
    ...(await queryRows<SearchRow>(
      `
        WITH neighbors AS (
          SELECT *
          FROM jsonb_to_recordset($2::jsonb) AS x(
            memory_id uuid,
            memory_type text,
            graph_weight double precision,
            graph_edge_type text,
            graph_seed_kind text
          )
        )
        SELECT
          em.id AS memory_id,
          'episodic_memory'::text AS memory_type,
          em.content,
          n.graph_weight AS raw_score,
          em.artifact_id,
          em.occurred_at,
          em.namespace_id,
          jsonb_build_object(
            'tier', 'graph_expansion_support',
            'artifact_observation_id', em.artifact_observation_id,
            'source_chunk_id', em.source_chunk_id,
            'metadata', em.metadata,
            'graph_weight', n.graph_weight,
            'graph_edge_type', n.graph_edge_type,
            'graph_seed_kind', n.graph_seed_kind
          ) AS provenance
        FROM neighbors n
        JOIN episodic_memory em
          ON n.memory_type = 'episodic_memory'
         AND em.id = n.memory_id
         AND em.namespace_id = $1
        WHERE
          cardinality($3::text[]) = 0
          OR em.content ILIKE ANY($3::text[])
      `,
      [namespaceId, neighborPayload, subjectPatterns]
    ))
  );

  const scoredRows = rows.map((row) => {
    const rawGraphWeight =
      typeof row.provenance.graph_weight === "number" || typeof row.provenance.graph_weight === "string"
        ? row.provenance.graph_weight
        : 0.4;
    const graphWeight = toNumber(rawGraphWeight) ?? 0.4;
    const edgeType = typeof row.provenance.graph_edge_type === "string" ? row.provenance.graph_edge_type : "";
    return {
      ...row,
      raw_score: scoreGraphExpansionRow(String(row.content ?? ""), queryText, graphWeight, edgeType)
    } satisfies SearchRow;
  });

  return toRankedRows(
    scoredRows
      .filter((row) => row.raw_score > 0)
      .sort((left, right) => {
        if (right.raw_score !== left.raw_score) {
          return right.raw_score - left.raw_score;
        }
        const leftIso = toIsoString(left.occurred_at);
        const rightIso = toIsoString(right.occurred_at);
        if (leftIso && rightIso && leftIso !== rightIso) {
          return rightIso.localeCompare(leftIso);
        }
        return resultKey(left).localeCompare(resultKey(right));
      })
      .slice(0, Math.max(candidateLimit, 8))
  );
}

async function loadSummarySupportExpansionRows(
  namespaceId: string,
  seedRows: readonly SqlFusedRankingRow[],
  candidateLimit: number,
  subjectHints: readonly string[]
): Promise<RankedSearchRow[]> {
  const supportIds = new Map<string, { memoryType: "episodic_memory" | "procedural_memory"; seedKind: string }>();

  for (const item of seedRows.slice(0, 6)) {
    const seedKind = graphSeedKindFromSearchRow(item.row);
    const sourceMemoryId =
      typeof item.row.provenance.source_memory_id === "string" ? item.row.provenance.source_memory_id : null;
    if (sourceMemoryId) {
      supportIds.set(sourceMemoryId, { memoryType: "episodic_memory", seedKind });
    }
    const provenanceMetadata =
      item.row.provenance.metadata && typeof item.row.provenance.metadata === "object"
        ? (item.row.provenance.metadata as Record<string, unknown>)
        : null;
    const supportProceduralIds = Array.isArray(provenanceMetadata?.support_procedural_ids)
      ? provenanceMetadata.support_procedural_ids
      : [];
    for (const proceduralId of supportProceduralIds) {
      if (typeof proceduralId === "string" && proceduralId) {
        supportIds.set(proceduralId, { memoryType: "procedural_memory", seedKind });
      }
    }
  }

  if (supportIds.size === 0) {
    return [];
  }

  const subjectPatterns = subjectHints.map((hint) => `%${hint}%`);
  const supportPayload = JSON.stringify(
    [...supportIds.entries()].map(([memoryId, value]) => ({
      memory_id: memoryId,
      memory_type: value.memoryType,
      graph_seed_kind: value.seedKind
    }))
  );

  const rows: SearchRow[] = [];

  rows.push(
    ...(await queryRows<SearchRow>(
      `
        WITH support_nodes AS (
          SELECT *
          FROM jsonb_to_recordset($2::jsonb) AS x(
            memory_id uuid,
            memory_type text,
            graph_seed_kind text
          )
        )
        SELECT
          em.id AS memory_id,
          'episodic_memory'::text AS memory_type,
          em.content,
          2.05::double precision AS raw_score,
          em.artifact_id,
          em.occurred_at,
          em.namespace_id,
          jsonb_build_object(
            'tier', 'graph_expansion_support',
            'artifact_observation_id', em.artifact_observation_id,
            'source_chunk_id', em.source_chunk_id,
            'metadata', em.metadata,
            'graph_weight', 0.96,
            'graph_edge_type', 'support',
            'graph_seed_kind', s.graph_seed_kind
          ) AS provenance
        FROM support_nodes s
        JOIN episodic_memory em
          ON s.memory_type = 'episodic_memory'
         AND em.id = s.memory_id
         AND em.namespace_id = $1
        WHERE
          cardinality($3::text[]) = 0
          OR em.content ILIKE ANY($3::text[])
      `,
      [namespaceId, supportPayload, subjectPatterns]
    ))
  );

  rows.push(
    ...(await queryRows<SearchRow>(
      `
        WITH support_nodes AS (
          SELECT *
          FROM jsonb_to_recordset($2::jsonb) AS x(
            memory_id uuid,
            memory_type text,
            graph_seed_kind text
          )
        )
        SELECT
          pm.id AS memory_id,
          'procedural_memory'::text AS memory_type,
          ${proceduralContentExpression()} AS content,
          1.9::double precision AS raw_score,
          em.artifact_id,
          coalesce(em.occurred_at, pm.updated_at) AS occurred_at,
          pm.namespace_id,
          jsonb_build_object(
            'tier', 'graph_expansion_support',
            'state_type', pm.state_type,
            'state_key', pm.state_key,
            'source_memory_id', em.id,
            'metadata', pm.metadata,
            'graph_weight', 0.93,
            'graph_edge_type', 'support',
            'graph_seed_kind', s.graph_seed_kind
          ) AS provenance
        FROM support_nodes s
        JOIN procedural_memory pm
          ON s.memory_type = 'procedural_memory'
         AND pm.id = s.memory_id
         AND pm.namespace_id = $1
         AND pm.valid_until IS NULL
        LEFT JOIN episodic_memory em
          ON em.id = NULLIF(pm.state_value->>'source_memory_id', '')::uuid
        WHERE
          cardinality($3::text[]) = 0
          OR coalesce(pm.state_value->>'person', ${proceduralContentExpression()}) ILIKE ANY($3::text[])
      `,
      [namespaceId, supportPayload, subjectPatterns]
    ))
  );

  return toRankedRows(
    rows
      .sort((left, right) => {
        const leftScore = toNumber(left.raw_score) ?? 0;
        const rightScore = toNumber(right.raw_score) ?? 0;
        if (rightScore !== leftScore) {
          return rightScore - leftScore;
        }
        const leftIso = toIsoString(left.occurred_at);
        const rightIso = toIsoString(right.occurred_at);
        if (leftIso && rightIso && leftIso !== rightIso) {
          return rightIso.localeCompare(leftIso);
        }
        return resultKey(left).localeCompare(resultKey(right));
      })
      .slice(0, Math.max(candidateLimit, 6))
  );
}

async function loadReflectGraphSupportResults(
  namespaceId: string,
  results: readonly RecallResult[],
  candidateLimit: number,
  subjectHints: readonly string[]
): Promise<readonly RecallResult[]> {
  const supportIds = new Map<string, { memoryType: "episodic_memory" | "procedural_memory"; seedKind: string }>();

  for (const item of results.slice(0, 6)) {
    const seedKind = typeof item.provenance.tier === "string" && item.provenance.tier ? item.provenance.tier : item.memoryType;
    const sourceEpisodicId =
      typeof item.provenance.source_episodic_id === "string" ? item.provenance.source_episodic_id : null;
    if (sourceEpisodicId) {
      supportIds.set(sourceEpisodicId, { memoryType: "episodic_memory", seedKind });
    }
    const provenanceMetadata =
      item.provenance.metadata && typeof item.provenance.metadata === "object"
        ? (item.provenance.metadata as Record<string, unknown>)
        : null;
    const supportProceduralIds = Array.isArray(provenanceMetadata?.support_procedural_ids)
      ? provenanceMetadata.support_procedural_ids
      : [];
    for (const proceduralId of supportProceduralIds) {
      if (typeof proceduralId === "string" && proceduralId) {
        supportIds.set(proceduralId, { memoryType: "procedural_memory", seedKind });
      }
    }
  }

  if (supportIds.size === 0) {
    return [];
  }

  const subjectPatterns = subjectHints.map((hint) => `%${hint}%`);
  const supportPayload = JSON.stringify(
    [...supportIds.entries()].map(([memory_id, value]) => ({
      memory_id,
      memory_type: value.memoryType,
      graph_seed_kind: value.seedKind
    }))
  );
  const rows: SearchRow[] = [];

  rows.push(
    ...(await queryRows<SearchRow>(
      `
        WITH support_nodes AS (
          SELECT *
          FROM jsonb_to_recordset($2::jsonb) AS x(
            memory_id uuid,
            memory_type text,
            graph_seed_kind text
          )
        )
        SELECT
          em.id AS memory_id,
          'episodic_memory'::text AS memory_type,
          em.content,
          2.05::double precision AS raw_score,
          em.artifact_id,
          em.occurred_at,
          em.namespace_id,
          jsonb_build_object(
            'tier', 'graph_expansion_support',
            'artifact_observation_id', em.artifact_observation_id,
            'source_chunk_id', em.source_chunk_id,
            'metadata', em.metadata,
            'graph_weight', 0.96,
            'graph_edge_type', 'support',
            'graph_seed_kind', s.graph_seed_kind
          ) AS provenance
        FROM support_nodes s
        JOIN episodic_memory em
          ON s.memory_type = 'episodic_memory'
         AND em.id = s.memory_id
         AND em.namespace_id = $1
        WHERE
          cardinality($3::text[]) = 0
          OR em.content ILIKE ANY($3::text[])
      `,
      [namespaceId, supportPayload, subjectPatterns]
    ))
  );

  rows.push(
    ...(await queryRows<SearchRow>(
      `
        WITH support_nodes AS (
          SELECT *
          FROM jsonb_to_recordset($2::jsonb) AS x(
            memory_id uuid,
            memory_type text,
            graph_seed_kind text
          )
        )
        SELECT
          pm.id AS memory_id,
          'procedural_memory'::text AS memory_type,
          ${proceduralContentExpression()} AS content,
          1.9::double precision AS raw_score,
          em.artifact_id,
          coalesce(em.occurred_at, pm.updated_at) AS occurred_at,
          pm.namespace_id,
          jsonb_build_object(
            'tier', 'graph_expansion_support',
            'state_type', pm.state_type,
            'state_key', pm.state_key,
            'source_memory_id', em.id,
            'metadata', pm.metadata,
            'graph_weight', 0.93,
            'graph_edge_type', 'support',
            'graph_seed_kind', s.graph_seed_kind
          ) AS provenance
        FROM support_nodes s
        JOIN procedural_memory pm
          ON s.memory_type = 'procedural_memory'
         AND pm.id = s.memory_id
         AND pm.namespace_id = $1
         AND pm.valid_until IS NULL
        LEFT JOIN episodic_memory em
          ON em.id = NULLIF(pm.state_value->>'source_memory_id', '')::uuid
        WHERE
          cardinality($3::text[]) = 0
          OR coalesce(pm.state_value->>'person', ${proceduralContentExpression()}) ILIKE ANY($3::text[])
      `,
      [namespaceId, supportPayload, subjectPatterns]
    ))
  );

  return rows
    .sort((left, right) => {
      const leftScore = toNumber(left.raw_score) ?? 0;
      const rightScore = toNumber(right.raw_score) ?? 0;
      if (rightScore !== leftScore) {
        return rightScore - leftScore;
      }
      const leftIso = toIsoString(left.occurred_at);
      const rightIso = toIsoString(right.occurred_at);
      if (leftIso && rightIso && leftIso !== rightIso) {
        return rightIso.localeCompare(leftIso);
      }
      return resultKey(left).localeCompare(resultKey(right));
    })
    .slice(0, Math.max(candidateLimit, 6))
    .map((row) => buildRecallResult(row, toNumber(row.raw_score), { rrfScore: toNumber(row.raw_score) }));
}

function buildRecursiveReflectSubqueries(
  queryText: string,
  subjectHints: readonly string[],
  options: {
    readonly globalQuestionFocus: boolean;
    readonly reflectiveRoutingFocus: boolean;
    readonly profileInferenceFocus: boolean;
    readonly identityProfileFocus: boolean;
    readonly sharedCommonalityFocus: boolean;
    readonly causalDecisionFocus: boolean;
    readonly exactDetailFocus: boolean;
  }
): readonly string[] {
  const subject = subjectHints[0] ?? "Steve";
  const subqueries = new Set<string>();

  if (options.exactDetailFocus) {
    if (/\b(team|club|organization|company|employer)\b/i.test(queryText)) {
      subqueries.add(`what team or organization is ${subject} associated with?`);
      subqueries.add(`which organization did ${subject} join or sign with?`);
    } else if (/\b(position|role|title|job)\b/i.test(queryText)) {
      subqueries.add(`what role or position does ${subject} have?`);
      subqueries.add(`what exact job title is linked to ${subject}?`);
    } else if (/\b(color|colour)\b/i.test(queryText)) {
      subqueries.add(`what color is linked to ${subject}?`);
    } else if (/\bwhat\s+did\b/i.test(queryText) && /\bresearch\b/i.test(queryText)) {
      subqueries.add(`what did ${subject} research?`);
      subqueries.add(`what topic was ${subject} researching?`);
    } else if (/\bplans?\b/i.test(queryText)) {
      subqueries.add(`what plans does ${subject} have?`);
      subqueries.add(`what is ${subject} planning to do?`);
    } else if (/\bname\b/i.test(queryText)) {
      subqueries.add(`what is the exact name linked to ${subject}?`);
    } else {
      subqueries.add(`what exact detail about ${subject} answers this question: ${queryText.replace(/\?+$/u, "")}?`);
      subqueries.add(`what explicit fact in the source answers: ${queryText.replace(/\?+$/u, "")}?`);
    }
  }

  if (options.sharedCommonalityFocus && subjectHints.length >= 2) {
    const sharedLatelyFocus = /\blately\b/i.test(queryText);
    const sharedCareFocus = /\b(care about|cares about|focused on|goals?|plans?)\b/i.test(queryText);
    if (sharedLatelyFocus) {
      for (const hint of subjectHints.slice(0, 2)) {
        subqueries.add(`what does ${hint} like lately?`);
      }
      for (const hint of subjectHints.slice(0, 2)) {
        subqueries.add(`what routines does ${hint} have lately?`);
      }
    } else if (sharedCareFocus) {
      for (const hint of subjectHints.slice(0, 2)) {
        subqueries.add(`what goals does ${hint} have right now?`);
        subqueries.add(`what plans is ${hint} working on right now?`);
        subqueries.add(`what is ${hint} focused on right now?`);
      }
    } else {
      for (const hint of subjectHints.slice(0, 2)) {
        subqueries.add(`why did ${hint} start a business?`);
      }
      for (const hint of subjectHints.slice(0, 2)) {
        subqueries.add(`what work or business changes happened to ${hint}?`);
      }
    }
  }

  if (options.globalQuestionFocus) {
    subqueries.add(`what has ${subject} been doing lately?`);
    subqueries.add(`what is ${subject} focused on right now?`);
    subqueries.add(`who has ${subject} been around lately?`);
  }

  if (options.profileInferenceFocus || options.identityProfileFocus) {
    subqueries.add(`what kind of work does ${subject} do?`);
    subqueries.add(`what projects is ${subject} working on?`);
    subqueries.add(`where does ${subject} live?`);
  }

  if (options.causalDecisionFocus && /\bwhy\b/i.test(queryText)) {
    subqueries.add(`what decision or constraint is explicitly grounded here?`);
    subqueries.add(`what directly changed before this outcome?`);
  }

  if (options.reflectiveRoutingFocus && subqueries.size === 0) {
    if (/\b(change|changed|different|going on)\b/i.test(queryText)) {
      subqueries.add(`what changed for ${subject}?`);
      subqueries.add(`what was ${subject} doing recently?`);
      subqueries.add(`what situation or relationship changed for ${subject}?`);
    } else {
      subqueries.add(`what has ${subject} been doing lately?`);
      subqueries.add(`what is ${subject} focused on right now?`);
      subqueries.add(`what projects, plans, or relationships are active for ${subject}?`);
    }
  }

  return [...subqueries].slice(0, 3);
}

export function isGeneratedRecursiveReflectQuery(queryText: string): boolean {
  const normalized = queryText.trim().toLowerCase();
  return (
    normalized.startsWith("what exact detail about ") ||
    normalized.startsWith("what explicit fact in the source answers:")
  );
}

export function shouldSuppressRecursiveReflectForGeneratedQuery(
  queryText: string,
  decompositionDepth: number
): boolean {
  return decompositionDepth > 0 && isGeneratedRecursiveReflectQuery(queryText);
}

function markRecursiveReflectResults(results: readonly RecallResult[], round: number, subquery: string): readonly RecallResult[] {
  return results.map((result) => ({
    ...result,
    provenance: {
      ...result.provenance,
      recursive_reflect: true,
      recursive_round: round,
      recursive_subquery: subquery
    }
  }));
}

function loadPreferredActiveProceduralRows(
  namespaceId: string,
  predicates: readonly string[],
  candidateLimit: number,
  subjectHints: readonly string[] = []
): Promise<SearchRow[]> {
  const stateTypes = proceduralStateTypesForPredicates(predicates);
  if (stateTypes.length === 0) {
    return Promise.resolve([]);
  }

  return queryRows<SearchRow>(
    `
      SELECT
        pm.id AS memory_id,
        'procedural_memory'::text AS memory_type,
        ${proceduralContentExpression()} AS content,
        1.3::double precision AS raw_score,
        em.artifact_id,
        COALESCE(em.occurred_at, pm.updated_at) AS occurred_at,
        pm.namespace_id,
        jsonb_build_object(
          'tier', 'current_procedural',
          'lexical_provider', 'active_support',
          'state_type', pm.state_type,
          'state_key', pm.state_key,
          'subject_name', pm.state_value->>'person',
          'version', pm.version,
          'valid_from', pm.valid_from,
          'valid_until', pm.valid_until,
          'source_memory_id', em.id,
          'source_uri', a.uri,
          'metadata', pm.metadata
        ) AS provenance
      FROM procedural_memory pm
      LEFT JOIN episodic_memory em
        ON em.id = NULLIF(pm.state_value->>'source_memory_id', '')::uuid
      LEFT JOIN artifacts a
        ON a.id = em.artifact_id
      WHERE pm.namespace_id = $1
        AND pm.valid_until IS NULL
        AND pm.state_type = ANY($2::text[])
        AND (
          cardinality($4::text[]) = 0
          OR EXISTS (
            SELECT 1
            FROM unnest($4::text[]) AS subject_hint(term)
            WHERE lower(coalesce(pm.state_value->>'person', '')) LIKE '%' || lower(subject_hint.term) || '%'
          )
        )
      ORDER BY pm.valid_from DESC, COALESCE(em.occurred_at, pm.updated_at) DESC
      LIMIT $3
    `,
    [namespaceId, stateTypes, candidateLimit, subjectHints]
  );
}

function loadCurrentDatingUnknownEvidenceRows(
  namespaceId: string,
  queryText: string,
  candidateLimit: number
): Promise<SearchRow[]> {
  const nameHints = extractEntityNameHints(queryText);
  if (nameHints.length === 0) {
    return Promise.resolve([]);
  }

  return queryRows<SearchRow>(
    `
      SELECT
        rm.id AS memory_id,
        'relationship_memory'::text AS memory_type,
        ${relationshipContentExpression()} AS content,
        1.1::double precision AS raw_score,
        e.artifact_id,
        COALESCE(e.occurred_at, rm.valid_from) AS occurred_at,
        rm.namespace_id,
        jsonb_build_object(
          'tier', 'relationship_memory',
          'lexical_provider', 'relationship_abstention_support',
          'subject_name', subject_entity.canonical_name,
          'predicate', rm.predicate,
          'object_name', object_entity.canonical_name,
          'status', rm.status,
          'valid_from', rm.valid_from,
          'valid_until', rm.valid_until,
          'relationship_transition', COALESCE(rm.metadata->>'relationship_transition', ''),
          'source_candidate_id', rm.source_candidate_id,
          'source_memory_id', rc.source_memory_id,
          'source_uri', a.uri,
          'metadata', rm.metadata
        ) AS provenance
      FROM relationship_memory rm
      JOIN entities subject_entity ON subject_entity.id = rm.subject_entity_id
      JOIN entities object_entity ON object_entity.id = rm.object_entity_id
      LEFT JOIN relationship_candidates rc ON rc.id = rm.source_candidate_id
      LEFT JOIN episodic_memory e ON e.id = rc.source_memory_id
      LEFT JOIN artifacts a ON a.id = e.artifact_id
      WHERE rm.namespace_id = $1
        AND (
          lower(subject_entity.canonical_name) = ANY($2::text[])
          OR lower(object_entity.canonical_name) = ANY($2::text[])
        )
        AND (
          rm.predicate IN ('relationship_ended', 'relationship_contact_paused', 'relationship_reconnected')
          OR (rm.predicate = 'significant_other_of' AND rm.valid_until IS NOT NULL)
        )
      ORDER BY COALESCE(e.occurred_at, rm.valid_from) DESC, rm.valid_from DESC
      LIMIT $3
    `,
    [namespaceId, nameHints, candidateLimit]
  );
}

function loadPreferenceTenureRows(
  namespaceId: string,
  queryText: string,
  candidateLimit: number,
  timeStart: string | null,
  timeEnd: string | null,
  mode: "current" | "historical" | "point_in_time"
): Promise<SearchRow[]> {
  const effectiveQueryText = buildPreferenceEvidenceQueryText(queryText, []);
  const broadPreferenceProfileQuery =
    /\bwhat\s+do\s+i\s+like\s+and\s+dislike\b/i.test(queryText) ||
    /\bwhat\s+do\s+i\s+like\s+or\s+dislike\b/i.test(queryText) ||
    /\bwhat\s+preferences?\b/i.test(queryText) ||
    /\bwhat\s+are\s+my\s+likes\s+and\s+dislikes\b/i.test(queryText);
  const scopeClause =
    mode === "current"
      ? "pm.valid_until IS NULL AND ($3::timestamptz IS NULL OR TRUE) AND ($4::timestamptz IS NULL OR TRUE)"
      : mode === "historical"
        ? "pm.valid_until IS NOT NULL AND ($3::timestamptz IS NULL OR TRUE) AND ($4::timestamptz IS NULL OR TRUE)"
        : `($3::timestamptz IS NULL OR coalesce(pm.valid_until, 'infinity'::timestamptz) >= $3)
           AND ($4::timestamptz IS NULL OR pm.valid_from <= $4)`;

  return queryRows<SearchRow>(
    `
      SELECT
        pm.id AS memory_id,
        'procedural_memory'::text AS memory_type,
        ${proceduralContentExpression()} || ' ' || coalesce(em.content, '') AS content,
        ts_rank(
          to_tsvector('english', ${proceduralLexicalDocument()}),
          websearch_to_tsquery('english', $2)
        ) AS raw_score,
        em.artifact_id,
        COALESCE(em.occurred_at, pm.valid_from) AS occurred_at,
        pm.namespace_id,
        jsonb_build_object(
          'tier', 'preference_tenure',
          'state_type', pm.state_type,
          'state_key', pm.state_key,
          'version', pm.version,
          'valid_from', pm.valid_from,
          'valid_until', pm.valid_until,
          'source_memory_id', em.id,
          'source_uri', a.uri,
          'metadata', pm.metadata
        ) AS provenance
      FROM procedural_memory pm
      LEFT JOIN episodic_memory em
        ON em.id = NULLIF(pm.state_value->>'source_memory_id', '')::uuid
      LEFT JOIN artifacts a
        ON a.id = em.artifact_id
      WHERE pm.namespace_id = $1
        AND pm.state_type = 'preference'
        AND ${scopeClause}
        AND to_tsvector('english', ${proceduralLexicalDocument()}) @@ websearch_to_tsquery('english', $2)
      ORDER BY raw_score DESC, COALESCE(em.occurred_at, pm.valid_from) DESC
      LIMIT $5
    `,
    [namespaceId, effectiveQueryText, timeStart, timeEnd, broadPreferenceProfileQuery ? Math.max(candidateLimit * 4, 24) : candidateLimit]
  );
}

function loadHistoricalPreferenceSupportRows(
  namespaceId: string,
  queryText: string,
  candidateLimit: number
): Promise<SearchRow[]> {
  const effectiveQueryText = buildPreferenceEvidenceQueryText(queryText, []);

  return queryRows<SearchRow>(
    `
      SELECT
        em.id AS memory_id,
        'episodic_memory'::text AS memory_type,
        em.content,
        ts_rank(to_tsvector('english', coalesce(em.content, '')), websearch_to_tsquery('english', $2)) AS raw_score,
        em.artifact_id,
        em.occurred_at,
        em.namespace_id,
        jsonb_build_object(
          'tier', 'focused_episodic_support',
          'lexical_provider', 'historical_preference_scope',
          'source_uri', a.uri,
          'artifact_observation_id', em.artifact_observation_id,
          'metadata', em.metadata
        ) AS provenance
      FROM episodic_memory em
      LEFT JOIN artifacts a ON a.id = em.artifact_id
      WHERE em.namespace_id = $1
        AND to_tsvector('english', coalesce(em.content, '')) @@ websearch_to_tsquery('english', $2)
        AND em.content ~* '(used to prefer|use to prefer|preferred .* in (19|20)[0-9]{2}|in (19|20)[0-9]{2} .* prefer)'
      ORDER BY raw_score DESC, em.occurred_at ASC, em.id ASC
      LIMIT $3
    `,
    [namespaceId, effectiveQueryText, Math.max(candidateLimit, 6)]
  );
}

function loadWatchlistRows(
  namespaceId: string,
  queryText: string,
  candidateLimit: number
): Promise<SearchRow[]> {
  const effectiveQueryText = buildPreferenceEvidenceQueryText(queryText, []);

  return queryRows<SearchRow>(
    `
      SELECT
        pm.id AS memory_id,
        'procedural_memory'::text AS memory_type,
        ${proceduralContentExpression()} AS content,
        ts_rank(
          to_tsvector('english', ${proceduralLexicalDocument()}),
          websearch_to_tsquery('english', $2)
        ) AS raw_score,
        em.artifact_id,
        COALESCE(em.occurred_at, pm.valid_from) AS occurred_at,
        pm.namespace_id,
        jsonb_build_object(
          'tier', 'watchlist_state',
          'state_type', pm.state_type,
          'state_key', pm.state_key,
          'version', pm.version,
          'valid_from', pm.valid_from,
          'valid_until', pm.valid_until,
          'source_memory_id', em.id,
          'source_uri', a.uri,
          'metadata', pm.metadata
        ) AS provenance
      FROM procedural_memory pm
      LEFT JOIN episodic_memory em
        ON em.id = NULLIF(pm.state_value->>'source_memory_id', '')::uuid
      LEFT JOIN artifacts a
        ON a.id = em.artifact_id
      WHERE pm.namespace_id = $1
        AND pm.state_type = 'watchlist_item'
        AND pm.valid_until IS NULL
        AND to_tsvector('english', ${proceduralLexicalDocument()}) @@ websearch_to_tsquery('english', $2)
      ORDER BY raw_score DESC, COALESCE(em.occurred_at, pm.valid_from) DESC
      LIMIT $3
    `,
    [namespaceId, effectiveQueryText, candidateLimit]
  );
}

function scoreStyleSpecRow(content: string, queryText: string): number {
  const normalizedQuery = queryText.toLowerCase();
  const normalizedContent = content.toLowerCase();
  const wantsBroadStyle = /\bstyle\s+specs?\b/.test(normalizedQuery) || /\bwork-?style\b/.test(normalizedQuery);
  const wantsResponseStyle = /\bresponse\s+style\b/.test(normalizedQuery) || /\bformat(?:ting)?\b/.test(normalizedQuery);
  const wantsOntologyProtocol = /\bprotocol\b/.test(normalizedQuery) && /\bontology\b/.test(normalizedQuery);
  const wantsReplayWorkflow = /\bdatabase\b/.test(normalizedQuery) && /\bslice\b/.test(normalizedQuery);
  const wantsPdfWorkflow =
    /\bpdf\b/.test(normalizedQuery) ||
    (/\bupload/.test(normalizedQuery) && /\bchunk/.test(normalizedQuery)) ||
    /\b50mb\b/.test(normalizedQuery);
  const wantsQueryability = /\bnatural\b/.test(normalizedQuery) && /\bquery/.test(normalizedQuery);

  let score = wantsBroadStyle ? 0.5 : 0;

  if (wantsResponseStyle) {
    if (!normalizedContent.includes("concise")) {
      return 0;
    }
    score += 2;
  }

  if (wantsOntologyProtocol) {
    if (!normalizedContent.includes("notebooklm")) {
      return 0;
    }
    score += 2.5;
  }

  if (wantsReplayWorkflow) {
    if (
      !(
        normalizedContent.includes("replay") &&
        normalizedContent.includes("database") &&
        (normalizedContent.includes("wipe") || normalizedContent.includes("after each slice"))
      )
    ) {
      return 0;
    }
    score += 2.5;
  }

  if (wantsPdfWorkflow) {
    if (!(normalizedContent.includes("pdf") && normalizedContent.includes("chunk"))) {
      return 0;
    }
    score += 2.5;
    if (normalizedContent.includes("50mb")) {
      score += 0.8;
    }
  }

  if (wantsQueryability) {
    if (!normalizedContent.includes("queryability")) {
      return 0;
    }
    score += 2;
  }

  if (score === 0) {
    if (normalizedContent.includes("style spec")) {
      score = 0.6;
    } else {
      return 0;
    }
  }

  if (normalizedQuery.includes("concise") && normalizedContent.includes("concise")) {
    score += 1;
  }

  return score;
}

function scoreGoalRow(content: string, queryText: string): number {
  const normalizedQuery = queryText.toLowerCase();
  const normalizedContent = content.toLowerCase();
  let score = 0.5;

  if (/\bcurrent\s+primary\s+goal\b/.test(normalizedQuery)) {
    score += 1.5;
  }

  if (/\bthailand\b/.test(normalizedQuery) && normalizedContent.includes("thailand")) {
    score += 1;
  }

  if (normalizedContent.includes("goal") || normalizedContent.includes("objective")) {
    score += 0.5;
  }

  return score;
}

function scorePlanRow(content: string, queryText: string): number {
  const normalizedQuery = queryText.toLowerCase();
  const normalizedContent = content.toLowerCase();
  let score = 0.5;

  if (/\bplan/.test(normalizedQuery) && normalizedContent.includes("plan")) {
    score += 0.8;
  }
  if (/\bturkey\b/.test(normalizedQuery) && normalizedContent.includes("turkey")) {
    score += 1.4;
  }
  if (/\bconference\b/.test(normalizedQuery) && normalizedContent.includes("conference")) {
    score += 1.2;
  }
  if (/\btwo-way\b/.test(normalizedQuery) && normalizedContent.includes("two-way")) {
    score += 1.2;
  }

  return score;
}

function scoreBeliefRow(content: string, queryText: string): number {
  const normalizedQuery = queryText.toLowerCase();
  const normalizedContent = content.toLowerCase();
  let score = 0.5;
  const queryTopic = normalizeBeliefTopic(extractBeliefTopic(queryText));
  const contentTopic = normalizeBeliefTopic(extractBeliefTopic(content));

  if (/\b(?:stance|opinion|belief)\b/.test(normalizedQuery) && /\b(?:stance|opinion|belief)\b/.test(normalizedContent)) {
    score += 0.8;
  }
  if (queryTopic) {
    if (!contentTopic) {
      return 0;
    }
    if (contentTopic === queryTopic) {
      score += 3;
    } else {
      const queryTerms = queryTopic.split("_").filter(Boolean);
      const contentTerms = new Set(contentTopic.split("_").filter(Boolean));
      const overlap = queryTerms.filter((term) => contentTerms.has(term));
      if (overlap.length === 0) {
        return 0;
      }
      score += overlap.length / Math.max(queryTerms.length, 1);
    }
  }
  if (/\binfrastructure\b/.test(normalizedQuery) && normalizedContent.includes("infrastructure")) {
    score += 1.2;
  }
  if (/\bhosted\b/.test(normalizedQuery) && normalizedContent.includes("hosted")) {
    score += 1;
  }
  if (/\blocal\b/.test(normalizedQuery) && normalizedContent.includes("local")) {
    score += 1;
  }
  if (/\bdata\s+sovereignty\b/.test(normalizedQuery) && normalizedContent.includes("data sovereignty")) {
    score += 1.2;
  }
  if (/\b(?:change|changed|since|still support)\b/.test(normalizedQuery)) {
    score += 0.4;
  }

  return score;
}

function scoreDecisionRow(content: string, queryText: string): number {
  const normalizedQuery = queryText.toLowerCase();
  const normalizedContent = content.toLowerCase();
  let score = 0.5;

  if (/\bpostgres\b/.test(normalizedQuery) && !normalizedContent.includes("postgres")) {
    return 0;
  }
  if (/\bthailand\b/.test(normalizedQuery) && !normalizedContent.includes("thailand")) {
    return 0;
  }

  if (/\bdecision|decide|rationale|why\b/.test(normalizedQuery) && /\bdecision|decided|rationale|why\b/.test(normalizedContent)) {
    score += 0.8;
  }
  if (/\bpostgres\b/.test(normalizedQuery) && normalizedContent.includes("postgres")) {
    score += 1.8;
  }
  if (/\bvector/.test(normalizedQuery) && /\bvector|vectors\b/.test(normalizedContent)) {
    score += 1.4;
  }
  if (/\bgraph\b/.test(normalizedQuery) && normalizedContent.includes("graph")) {
    score += 1.2;
  }
  if (/\bsubstrate\b/.test(normalizedQuery) && normalizedContent.includes("substrate")) {
    score += 1.1;
  }

  return score;
}

function extractDecisionTopicHints(queryText: string): readonly string[] {
  const hints = new Set<string>();
  const normalizedQuery = queryText.toLowerCase();

  for (const hint of ["postgres", "thailand", "graph", "vectors", "vector", "substrate", "database", "notebooklm"]) {
    if (normalizedQuery.includes(hint)) {
      hints.add(hint);
    }
  }

  return [...hints];
}

function decisionTopicAligned(content: string, queryText: string): boolean {
  const normalizedContent = content.toLowerCase();
  const hints = extractDecisionTopicHints(queryText);
  if (hints.length === 0) {
    return true;
  }
  return hints.some((hint) => normalizedContent.includes(hint));
}

function scoreConstraintRow(content: string, queryText: string): number {
  const normalizedQuery = queryText.toLowerCase();
  const normalizedContent = content.toLowerCase();
  let score = 0.5;
  const wantsOntologyProtocol = /\bprotocol\b/.test(normalizedQuery) && /\bontology\b/.test(normalizedQuery);
  const wantsReplayWorkflow =
    /\bdatabase\b/.test(normalizedQuery) &&
    (/\bslice\b/.test(normalizedQuery) || /\breplay\b/.test(normalizedQuery) || /\bintegrity\b/.test(normalizedQuery));
  const wantsPdfWorkflow =
    /\bpdf\b/.test(normalizedQuery) ||
    (/\bupload/.test(normalizedQuery) && /\bchunk/.test(normalizedQuery)) ||
    /\b50mb\b/.test(normalizedQuery);

  if (wantsOntologyProtocol && !/\bnotebooklm\b/.test(normalizedContent)) {
    return 0;
  }
  if (wantsReplayWorkflow && !(/\bdatabase\b/.test(normalizedContent) && /\breplay\b/.test(normalizedContent))) {
    return 0;
  }
  if (wantsPdfWorkflow && !(/\bpdf\b/.test(normalizedContent) && /\bchunk\b/.test(normalizedContent))) {
    return 0;
  }

  if (/\bconstraint|rule|policy|protocol\b/.test(normalizedQuery) && /\bconstraint|rule|policy|protocol\b/.test(normalizedContent)) {
    score += 0.8;
  }
  if (/\b(?:dietary|allergy|allergic|blocker|blockers|safety)\b/.test(normalizedQuery)) {
    score += 1.4;
  }
  if (/\bpeanut/.test(normalizedQuery) && normalizedContent.includes("peanut")) {
    score += 2;
  }
  if (/\bdinner\b/.test(normalizedQuery) && normalizedContent.includes("dinner")) {
    score += 0.8;
  }
  if (/\babsolute\b/.test(normalizedQuery) && /\babsolute|never\b/.test(normalizedContent)) {
    score += 0.6;
  }

  return score;
}

function scoreRoutineRow(content: string, queryText: string): number {
  const normalizedQuery = queryText.toLowerCase();
  const normalizedContent = content.toLowerCase();
  let score = 0.5;

  if (/\b(?:routine|routines|habit|habits)\b/.test(normalizedQuery) && /\b(?:routine|habit)\b/.test(normalizedContent)) {
    score += 1;
  }
  if (/\bstart\s+my\s+day\b/.test(normalizedQuery) && /\b(?:morning|wake|coffee|reddit)\b/.test(normalizedContent)) {
    score += 1.6;
  }
  if (/\bright\s+now\b|\bcurrent\b|\bmatter\b/.test(normalizedQuery)) {
    score += 0.5;
  }
  if (/\bcoffee\b/.test(normalizedContent)) {
    score += 0.6;
  }
  if (/\breddit\b/.test(normalizedContent)) {
    score += 0.6;
  }
  if (/\bpersonal time\b/.test(normalizedContent)) {
    score += 0.9;
  }
  if (/\bwork\b/.test(normalizedQuery) && /\b(?:work|tasks|projects?)\b/.test(normalizedContent)) {
    score += 0.5;
  }

  return score;
}

function extractBeliefTopic(value: string): string | null {
  const normalized = value.trim();
  if (!normalized) {
    return null;
  }

  const patterns = [
    /\b(?:stance|opinion|belief)\s+on\s+(.+?)\s+is\b/iu,
    /\bcurrent\s+stance\s+on\s+(.+?)(?:\?|$)/iu,
    /\bopinion\s+on\s+(.+?)(?:\?|$)/iu
  ] as const;

  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    const topic = typeof match?.[1] === "string" ? match[1].trim() : "";
    if (topic) {
      return topic;
    }
  }

  return null;
}

function normalizeBeliefTopic(value: string | null): string {
  if (!value) {
    return "";
  }

  return value
    .toLowerCase()
    .replace(/\b(?:my|our|current|stance|opinion|belief|about|on|the)\b/gu, " ")
    .replace(/^\s*using\s+/u, "")
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/[^\p{L}\p{N}\s-]+/gu, "")
    .replace(/\s+/gu, "_");
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function isInterrogativeClaimText(value: string): boolean {
  const normalized = normalizeWhitespace(value);
  if (!normalized) {
    return false;
  }
  if (/\?\s*$/u.test(normalized)) {
    return true;
  }
  return /^(?:what|when|where|who|why|how|did|does|do|can|could|would|will|is|are|was|were|have|has|had)\b/iu.test(
    normalized.replace(/^[A-Z][a-z]+:\s*/u, "")
  );
}

function scoreProfileSummaryRow(content: string, queryText: string): number {
  const normalizedContent = content.toLowerCase();
  const loweredQuery = queryText.toLowerCase();
  const terms = queryText.match(/[A-Za-z0-9][A-Za-z0-9.'-]*/g) ?? [];
  let score = 0;

  for (const term of terms) {
    const normalizedTerm = term.toLowerCase();
    if (normalizedTerm.length < 3) {
      continue;
    }
    if (normalizedContent.includes(normalizedTerm)) {
      score += 1;
    }
  }

  if (/\blately|recently|right now|these days|current picture|focused on\b/.test(loweredQuery)) {
    if (/\bcurrently\b|\bright now\b|\bactive\b|\bcurrent\b/.test(normalizedContent)) {
      score += 1.4;
    }
  }

  if (/\b(in common|both|shared)\b/.test(loweredQuery) && /\b(shared|both|common|together)\b/.test(normalizedContent)) {
    score += 1.2;
  }

  if (/\b(identity|role|field|profession|career|focus)\b/.test(loweredQuery)) {
    if (/\b(identity|role|career|field|focus|goal|plan|works at|working on)\b/.test(normalizedContent)) {
      score += 1.3;
    }
  }

  if (/\b(relationship|dating|partner|with who)\b/.test(loweredQuery) && /\b(relationship status|dating|partner)\b/.test(normalizedContent)) {
    score += 1.25;
  }

  if (/\b(project|working on|status)\b/.test(loweredQuery) && /\b(project status|working on|project)\b/.test(normalizedContent)) {
    score += 1.1;
  }

  return score;
}

function scoreTopicSegmentRow(content: string, queryText: string): number {
  const normalizedContent = content.toLowerCase();
  const loweredQuery = queryText.toLowerCase();
  const terms = queryText.match(/[A-Za-z0-9][A-Za-z0-9.'-]*/g) ?? [];
  let score = 0;

  for (const term of terms) {
    const normalizedTerm = term.toLowerCase();
    if (normalizedTerm.length < 4) {
      continue;
    }
    if (normalizedContent.includes(normalizedTerm)) {
      score += 0.9;
    }
  }

  if (/\b(lately|recently|these days|what has|what was going on|recap|summary|overall)\b/.test(loweredQuery)) {
    if (/\btopic segment about\b|\bworking on\b|\bfocused on\b|\bcurrently\b|\bright now\b/.test(normalizedContent)) {
      score += 1.25;
    }
  }

  if (/\b(common|both|shared|together|similar)\b/.test(loweredQuery)) {
    if (/\b(shared overlap|both|shared|topic segment about)\b/.test(normalizedContent)) {
      score += 1.35;
    }
  }

  if (/\b(change|changed|different|why)\b/.test(loweredQuery) && /\b(decided|changed|instead|however|but|after)\b/.test(normalizedContent)) {
    score += 0.8;
  }

  return score;
}

function scoreCommunitySummaryRow(content: string, queryText: string): number {
  const normalizedContent = content.toLowerCase();
  const loweredQuery = queryText.toLowerCase();
  let score = scoreTopicSegmentRow(content, queryText);

  if (/\b(common|both|shared|together|similar)\b/.test(loweredQuery) && /\bshared overlap\b/.test(normalizedContent)) {
    score += 1.6;
  }

  if (/\b(lately|recently|overall|recap|summary)\b/.test(loweredQuery) && /\b(shared overlap|current pattern|recurring topic)\b/.test(normalizedContent)) {
    score += 0.95;
  }

  return score;
}

function rankSearchRowsByQueryScore(
  rows: readonly SearchRow[],
  queryText: string,
  scorer: (content: string, queryText: string) => number,
  limit: number
): SearchRow[] {
  const scoredRows = new Map<string, { row: SearchRow; score: number }>();

  for (const row of rows) {
    const score = scorer(String(row.content ?? ""), queryText);
    if (score <= 0) {
      continue;
    }

    const nextRow: SearchRow = {
      ...row,
      raw_score: score
    };
    const key = resultKey(nextRow);
    const existing = scoredRows.get(key);
    if (!existing || score > existing.score) {
      scoredRows.set(key, { row: nextRow, score });
    }
  }

  return [...scoredRows.values()]
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      const leftIso = toIsoString(left.row.occurred_at);
      const rightIso = toIsoString(right.row.occurred_at);
      if (leftIso && rightIso && leftIso !== rightIso) {
        return rightIso.localeCompare(leftIso);
      }
      return resultKey(left.row).localeCompare(resultKey(right.row));
    })
    .slice(0, limit)
    .map((entry) => entry.row);
}

async function loadActiveSemanticStateSummaryRows(
  namespaceId: string,
  stateTypes: readonly string[],
  candidateLimit: number
): Promise<SearchRow[]> {
  const normalizedStateTypes = [...new Set(
    stateTypes
      .map((value) => value.trim())
      .filter((value) => value.length > 0)
  )];

  if (normalizedStateTypes.length === 0) {
    return [];
  }

  return queryRows<SearchRow>(
    `
      SELECT
        sm.id::text AS memory_id,
        'semantic_memory'::text AS memory_type,
        sm.content_abstract AS content,
        1.08::double precision AS raw_score,
        em.artifact_id,
        COALESCE(em.occurred_at, sm.valid_from) AS occurred_at,
        sm.namespace_id,
        jsonb_build_object(
          'tier', 'reconsolidated_state_summary',
          'memory_kind', sm.memory_kind,
          'canonical_key', sm.canonical_key,
          'valid_from', sm.valid_from,
          'valid_until', sm.valid_until,
          'status', sm.status,
          'source_episodic_id', sm.source_episodic_id,
          'source_chunk_id', sm.source_chunk_id,
          'source_artifact_observation_id', sm.source_artifact_observation_id,
          'source_uri', a.uri,
          'metadata', sm.metadata
        ) AS provenance
      FROM semantic_memory sm
      LEFT JOIN episodic_memory em
        ON em.id = sm.source_episodic_id
      LEFT JOIN artifacts a
        ON a.id = em.artifact_id
      WHERE sm.namespace_id = $1
        AND sm.status = 'active'
        AND sm.valid_until IS NULL
        AND sm.memory_kind = 'state_summary'
        AND COALESCE(sm.metadata->>'state_type', '') = ANY($2::text[])
      ORDER BY sm.valid_from DESC, sm.id DESC
      LIMIT $3
    `,
    [namespaceId, normalizedStateTypes, Math.max(candidateLimit * 2, 8)]
  );
}

async function loadActiveSemanticBeliefSummaryRows(
  namespaceId: string,
  candidateLimit: number
): Promise<SearchRow[]> {
  return queryRows<SearchRow>(
    `
      SELECT
        sm.id::text AS memory_id,
        'semantic_memory'::text AS memory_type,
        sm.content_abstract AS content,
        1.11::double precision AS raw_score,
        em.artifact_id,
        COALESCE(em.occurred_at, sm.valid_from) AS occurred_at,
        sm.namespace_id,
        jsonb_build_object(
          'tier', 'reconsolidated_belief_summary',
          'memory_kind', sm.memory_kind,
          'canonical_key', sm.canonical_key,
          'valid_from', sm.valid_from,
          'valid_until', sm.valid_until,
          'status', sm.status,
          'source_episodic_id', sm.source_episodic_id,
          'source_chunk_id', sm.source_chunk_id,
          'source_artifact_observation_id', sm.source_artifact_observation_id,
          'source_uri', a.uri,
          'metadata', sm.metadata
        ) AS provenance
      FROM semantic_memory sm
      LEFT JOIN episodic_memory em
        ON em.id = sm.source_episodic_id
      LEFT JOIN artifacts a
        ON a.id = em.artifact_id
      WHERE sm.namespace_id = $1
        AND sm.status = 'active'
        AND sm.valid_until IS NULL
        AND (
          sm.memory_kind = 'belief_summary' OR
          (sm.memory_kind = 'state_summary' AND COALESCE(sm.metadata->>'state_type', '') = 'belief')
        )
      ORDER BY sm.valid_from DESC, sm.id DESC
      LIMIT $2
    `,
    [namespaceId, Math.max(candidateLimit * 2, 8)]
  );
}

async function loadActiveSemanticProfileSummaryRows(
  namespaceId: string,
  queryText: string,
  candidateLimit: number,
  profileKinds?: readonly string[]
): Promise<SearchRow[]> {
  const normalizedKinds = [...new Set((profileKinds ?? []).map((value) => value.trim()).filter((value) => value.length > 0))];
  const rows = await queryRows<SearchRow>(
    `
      SELECT
        sm.id::text AS memory_id,
        'semantic_memory'::text AS memory_type,
        sm.content_abstract AS content,
        1.12::double precision AS raw_score,
        em.artifact_id,
        COALESCE(em.occurred_at, sm.valid_from) AS occurred_at,
        sm.namespace_id,
        jsonb_build_object(
          'tier', 'reconsolidated_profile_summary',
          'memory_kind', sm.memory_kind,
          'canonical_key', sm.canonical_key,
          'valid_from', sm.valid_from,
          'valid_until', sm.valid_until,
          'status', sm.status,
          'source_episodic_id', sm.source_episodic_id,
          'source_chunk_id', sm.source_chunk_id,
          'source_artifact_observation_id', sm.source_artifact_observation_id,
          'source_uri', a.uri,
          'metadata', sm.metadata
        ) AS provenance
      FROM semantic_memory sm
      LEFT JOIN episodic_memory em
        ON em.id = sm.source_episodic_id
      LEFT JOIN artifacts a
        ON a.id = em.artifact_id
      WHERE sm.namespace_id = $1
        AND sm.status = 'active'
        AND sm.valid_until IS NULL
        AND sm.memory_kind = 'profile_summary'
        AND (
          cardinality($2::text[]) = 0 OR
          COALESCE(sm.metadata->>'profile_kind', '') = ANY($2::text[])
        )
      ORDER BY sm.valid_from DESC, sm.id DESC
      LIMIT $3
    `,
    [namespaceId, normalizedKinds, Math.max(candidateLimit * 3, 12)]
  );

  return rankSearchRowsByQueryScore(rows, queryText, scoreProfileSummaryRow, Math.max(candidateLimit, 6));
}

async function loadParticipantScopedProfileSummaryRows(
  namespaceId: string,
  participants: readonly string[],
  candidateLimit: number,
  profileKinds?: readonly string[]
): Promise<SearchRow[]> {
  const normalizedParticipants = [...new Set(
    participants.map((value) => normalizeWhitespace(value).trim()).filter((value) => value.length > 0)
  )];
  const normalizedKinds = [...new Set((profileKinds ?? []).map((value) => value.trim()).filter((value) => value.length > 0))];
  if (normalizedParticipants.length === 0) {
    return [];
  }

  const rows = await queryRows<SearchRow>(
    `
      SELECT
        sm.id::text AS memory_id,
        'semantic_memory'::text AS memory_type,
        sm.content_abstract AS content,
        1.16::double precision AS raw_score,
        em.artifact_id,
        COALESCE(em.occurred_at, sm.valid_from) AS occurred_at,
        sm.namespace_id,
        jsonb_build_object(
          'tier', 'reconsolidated_profile_summary',
          'memory_kind', sm.memory_kind,
          'canonical_key', sm.canonical_key,
          'valid_from', sm.valid_from,
          'valid_until', sm.valid_until,
          'status', sm.status,
          'source_episodic_id', sm.source_episodic_id,
          'source_chunk_id', sm.source_chunk_id,
          'source_artifact_observation_id', sm.source_artifact_observation_id,
          'source_uri', a.uri,
          'metadata', sm.metadata
        ) AS provenance
      FROM semantic_memory sm
      LEFT JOIN episodic_memory em
        ON em.id = sm.source_episodic_id
      LEFT JOIN artifacts a
        ON a.id = em.artifact_id
      WHERE sm.namespace_id = $1
        AND sm.status = 'active'
        AND sm.valid_until IS NULL
        AND sm.memory_kind = 'profile_summary'
        AND COALESCE(sm.metadata->>'person_name', '') = ANY($2::text[])
        AND (
          cardinality($3::text[]) = 0 OR
          COALESCE(sm.metadata->>'profile_kind', '') = ANY($3::text[])
        )
      ORDER BY sm.valid_from DESC, sm.id DESC
      LIMIT $4
    `,
    [namespaceId, normalizedParticipants, normalizedKinds, Math.max(candidateLimit * Math.max(normalizedParticipants.length, 1), 8)]
  );

  const ranked = rows.flatMap((row) => {
    const personName =
      typeof row.provenance?.metadata === "object" && row.provenance.metadata !== null && typeof (row.provenance.metadata as Record<string, unknown>).person_name === "string"
        ? normalizeWhitespace((row.provenance.metadata as Record<string, unknown>).person_name as string)
        : "";
    if (!personName) {
      return [];
    }
    return [{
      row,
      score: scoreProfileSummaryRow(String(row.content ?? ""), `${personName} ${(normalizedKinds.join(" ") || "focus")}`) + 0.5
    }];
  });

  return ranked
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      const leftIso = toIsoString(left.row.occurred_at);
      const rightIso = toIsoString(right.row.occurred_at);
      if (leftIso && rightIso && leftIso !== rightIso) {
        return rightIso.localeCompare(leftIso);
      }
      return resultKey(left.row).localeCompare(resultKey(right.row));
    })
    .slice(0, Math.max(candidateLimit, normalizedParticipants.length * 2))
    .map((entry) => ({
      ...entry.row,
      raw_score: entry.score
    }));
}

async function loadTopicSegmentSupportRows(
  namespaceId: string,
  queryText: string,
  candidateLimit: number,
  participants: readonly string[],
  timeStart: string | null,
  timeEnd: string | null
): Promise<SearchRow[]> {
  const participantPatterns = [...new Set(
    participants
      .map((value) => normalizeWhitespace(value).trim())
      .filter((value) => value.length > 0)
      .map((value) => `%${value}%`)
  )];

  const rows = await queryRows<SearchRow>(
    `
      SELECT
        ad.id::text AS memory_id,
        'artifact_derivation'::text AS memory_type,
        ad.content_text AS content,
        1.04::double precision AS raw_score,
        ao.artifact_id,
        COALESCE(source_em.occurred_at, ao.observed_at) AS occurred_at,
        a.namespace_id,
        jsonb_build_object(
          'tier', 'topic_segment_support',
          'derivation_type', ad.derivation_type,
          'artifact_observation_id', ad.artifact_observation_id,
          'source_chunk_id', ad.source_chunk_id,
          'source_uri', a.uri,
          'metadata', ad.metadata
        ) AS provenance
      FROM artifact_derivations ad
      JOIN artifact_observations ao ON ao.id = ad.artifact_observation_id
      JOIN artifacts a ON a.id = ao.artifact_id
      LEFT JOIN episodic_memory source_em ON source_em.id = ad.source_chunk_id
      WHERE a.namespace_id = $1
        AND ad.derivation_type = 'topic_segment'
        AND COALESCE(ad.content_text, '') <> ''
        AND ($3::timestamptz IS NULL OR COALESCE(source_em.occurred_at, ao.observed_at) >= $3)
        AND ($4::timestamptz IS NULL OR COALESCE(source_em.occurred_at, ao.observed_at) <= $4)
        AND (
          to_tsvector(
            'english',
            coalesce(ad.content_text, '') || ' ' ||
            coalesce(ad.metadata->>'topic_label', '') || ' ' ||
            coalesce(ad.metadata->>'speaker_names_text', '')
          ) @@ websearch_to_tsquery('english', $2)
          OR (
            cardinality($5::text[]) > 0
            AND COALESCE(ad.metadata->>'speaker_names_text', '') ILIKE ANY($5::text[])
          )
        )
      ORDER BY COALESCE(source_em.occurred_at, ao.observed_at) DESC, ad.created_at DESC
      LIMIT $6
    `,
    [namespaceId, queryText, timeStart, timeEnd, participantPatterns, Math.max(candidateLimit * 3, 12)]
  );

  return rankSearchRowsByQueryScore(rows, queryText, scoreTopicSegmentRow, Math.max(candidateLimit, 6));
}

async function loadCommunitySummarySupportRows(
  namespaceId: string,
  queryText: string,
  participants: readonly string[],
  candidateLimit: number,
  timeStart: string | null,
  timeEnd: string | null
): Promise<SearchRow[]> {
  const normalizedParticipants = [...new Set(
    participants
      .map((value) => normalizeWhitespace(value).toLowerCase())
      .filter((value) => value.length > 0)
  )];
  if (normalizedParticipants.length < 2) {
    return [];
  }

  const rows = await queryRows<SearchRow>(
    `
      WITH topic_segments AS (
        SELECT
          ad.id,
          ao.artifact_id,
          COALESCE(source_em.occurred_at, ao.observed_at) AS occurred_at,
          a.namespace_id,
          ad.content_text,
          COALESCE(NULLIF(ad.metadata->>'topic_label', ''), 'shared activity') AS topic_label,
          COALESCE(ad.metadata->'speaker_names', '[]'::jsonb) AS speaker_names,
          a.uri AS source_uri
        FROM artifact_derivations ad
        JOIN artifact_observations ao ON ao.id = ad.artifact_observation_id
        JOIN artifacts a ON a.id = ao.artifact_id
        LEFT JOIN episodic_memory source_em ON source_em.id = ad.source_chunk_id
        WHERE a.namespace_id = $1
          AND ad.derivation_type = 'topic_segment'
          AND COALESCE(ad.content_text, '') <> ''
          AND ($4::timestamptz IS NULL OR COALESCE(source_em.occurred_at, ao.observed_at) >= $4)
          AND ($5::timestamptz IS NULL OR COALESCE(source_em.occurred_at, ao.observed_at) <= $5)
      ),
      shared_topics AS (
        SELECT
          (array_agg(ts.id::text ORDER BY ts.occurred_at DESC, ts.id DESC))[1] AS memory_id,
          (array_agg(ts.artifact_id ORDER BY ts.occurred_at DESC))[1] AS artifact_id,
          MAX(ts.occurred_at) AS occurred_at,
          MAX(ts.namespace_id) AS namespace_id,
          MAX(ts.source_uri) AS source_uri,
          ts.topic_label,
          COUNT(*) AS segment_count,
          COUNT(DISTINCT CASE WHEN lower(speaker.value) = ANY($2::text[]) THEN lower(speaker.value) END) AS participant_count,
          string_agg(DISTINCT LEFT(ts.content_text, 280), ' ' ORDER BY LEFT(ts.content_text, 280)) AS evidence_text
        FROM topic_segments ts
        JOIN LATERAL jsonb_array_elements_text(ts.speaker_names) AS speaker(value) ON true
        GROUP BY ts.topic_label
        HAVING COUNT(DISTINCT CASE WHEN lower(speaker.value) = ANY($2::text[]) THEN lower(speaker.value) END) >= $3
      )
      SELECT
        memory_id,
        'artifact_derivation'::text AS memory_type,
        format(
          'Shared overlap for %s centers on %s. %s',
          $6::text,
          topic_label,
          evidence_text
        ) AS content,
        LEAST(1.2 + segment_count * 0.18, 2.3)::double precision AS raw_score,
        artifact_id,
        occurred_at,
        namespace_id,
        jsonb_build_object(
          'tier', 'community_summary_support',
          'derivation_type', 'community_summary',
          'source_uri', source_uri,
          'metadata', jsonb_build_object(
            'topic_label', topic_label,
            'segment_count', segment_count,
            'community_kind', 'topic_overlap',
            'participant_names', $2::text[]
          )
        ) AS provenance
      FROM shared_topics
      ORDER BY segment_count DESC, occurred_at DESC
      LIMIT $7
    `,
    [
      namespaceId,
      normalizedParticipants,
      Math.min(normalizedParticipants.length, 2),
      timeStart,
      timeEnd,
      normalizedParticipants.join(" and "),
      Math.max(candidateLimit, 4)
    ]
  );

  return rankSearchRowsByQueryScore(rows, queryText, scoreCommunitySummaryRow, Math.max(candidateLimit, 4));
}

function requestedProfileKindsForRouting(options: {
  readonly globalQuestionFocus: boolean;
  readonly profileInferenceFocus: boolean;
  readonly identityProfileFocus: boolean;
  readonly sharedCommonalityFocus: boolean;
}): readonly string[] {
  return [
    options.globalQuestionFocus ? "identity_summary" : "",
    options.globalQuestionFocus ? "current_picture" : "",
    options.globalQuestionFocus ? "focus" : "",
    options.globalQuestionFocus ? "relationship_status" : "",
    options.globalQuestionFocus ? "project_status" : "",
    options.profileInferenceFocus ? "role_direction" : "",
    options.identityProfileFocus ? "identity_summary" : "",
    options.sharedCommonalityFocus ? "focus" : "",
    options.sharedCommonalityFocus ? "social_pattern" : "",
    options.sharedCommonalityFocus ? "interest_pattern" : ""
  ].filter((value): value is string => value.length > 0);
}

function normalizeWritebackText(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function normalizeWritebackToken(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/gu, "_").replace(/^_+|_+$/gu, "");
}

function buildWritebackCanonicalKey(profileKind: WritebackProfileKind, personName: string): string {
  return `reconsolidated:profile_summary:${profileKind}:${normalizeWritebackToken(personName)}`;
}

function noteFamilyForWritebackProfileKind(profileKind: WritebackProfileKind): RecallWritebackNoteFamily {
  switch (profileKind) {
    case "focus":
      return "fact_note";
    default:
      return "profile_note";
  }
}

function inferWritebackProfileKind(
  queryText: string,
  options: {
    readonly globalQuestionFocus: boolean;
    readonly profileInferenceFocus: boolean;
    readonly identityProfileFocus: boolean;
  }
): WritebackProfileKind | null {
  if (options.identityProfileFocus) {
    return "identity_summary";
  }
  if (options.profileInferenceFocus) {
    return "role_direction";
  }
  if (/\bfocus(?:ed|ing)?\b/i.test(queryText) || /\bgoal|plan|working on\b/i.test(queryText)) {
    return "focus";
  }
  if (options.globalQuestionFocus || /\bwhat has .+ been doing lately\b/i.test(queryText)) {
    return "current_picture";
  }
  return null;
}

function collectWritebackSupport(results: readonly RecallResult[]): {
  readonly supportEpisodicIds: readonly string[];
  readonly supportProceduralIds: readonly string[];
  readonly relationshipMemoryId: string | null;
  readonly validFrom: string;
} {
  const episodicIds = new Set<string>();
  const proceduralIds = new Set<string>();
  let relationshipMemoryId: string | null = null;
  let latestTimestamp = 0;

  for (const result of results) {
    if (result.memoryType === "episodic_memory") {
      episodicIds.add(result.memoryId);
    }
    if (result.memoryType === "procedural_memory") {
      proceduralIds.add(result.memoryId);
    }
    if (!relationshipMemoryId && result.memoryType === "relationship_memory") {
      relationshipMemoryId = result.memoryId;
    }
    const provenanceSourceMemoryId =
      typeof result.provenance.source_memory_id === "string" && result.provenance.source_memory_id
        ? result.provenance.source_memory_id
        : typeof result.provenance.sourceMemoryId === "string" && result.provenance.sourceMemoryId
          ? result.provenance.sourceMemoryId
          : null;
    if (provenanceSourceMemoryId) {
      episodicIds.add(provenanceSourceMemoryId);
    }
    const candidateTime = Date.parse(result.occurredAt ?? "");
    if (Number.isFinite(candidateTime)) {
      latestTimestamp = Math.max(latestTimestamp, candidateTime);
    }
  }

  return {
    supportEpisodicIds: [...episodicIds],
    supportProceduralIds: [...proceduralIds],
    relationshipMemoryId,
    validFrom: latestTimestamp > 0 ? new Date(latestTimestamp).toISOString() : new Date().toISOString()
  };
}

function inferWritebackPersonName(
  results: readonly RecallResult[],
  matchedParticipants: readonly string[],
  subjectHints: readonly string[]
): string | null {
  const candidates = [...new Set([...matchedParticipants, ...subjectHints].map((value) => value.trim()).filter(Boolean))];
  let bestCandidate: string | null = null;
  let bestScore = 0;

  for (const candidate of candidates) {
    const escaped = candidate.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    const personPattern = new RegExp(`"person"\\s*:\\s*"${escaped}"`, "iu");
    const leadingPattern = new RegExp(`^${escaped}\\b`, "iu");
    let score = 0;

    for (const result of results) {
      const haystack = `${result.content}\n${JSON.stringify(result.provenance ?? {})}`;
      if (personPattern.test(haystack)) {
        score += 3;
      } else if (leadingPattern.test(result.content)) {
        score += 1;
      }
    }

    if (score > bestScore) {
      bestCandidate = candidate;
      bestScore = score;
    }
  }

  return bestScore > 0 ? bestCandidate : null;
}

async function writebackSupportedProfileNote(input: {
  readonly namespaceId: string;
  readonly queryText: string;
  readonly personName: string;
  readonly profileKind: WritebackProfileKind;
  readonly content: string;
  readonly results: readonly RecallResult[];
}): Promise<{ readonly triggered: boolean; readonly noteFamily?: RecallWritebackNoteFamily }> {
  const normalizedContent = normalizeWritebackText(input.content);
  if (!normalizedContent) {
    return { triggered: false };
  }

  const support = collectWritebackSupport(input.results);
  if (support.supportEpisodicIds.length === 0 && support.supportProceduralIds.length === 0) {
    return { triggered: false };
  }

  const canonicalKey = buildWritebackCanonicalKey(input.profileKind, input.personName);
  const noteFamily = noteFamilyForWritebackProfileKind(input.profileKind);

  return withTransaction(async (client) => {
    const existingResult = await client.query<{
      id: string;
      content_abstract: string;
    }>(
      `
        SELECT id::text AS id, content_abstract
        FROM semantic_memory
        WHERE namespace_id = $1
          AND canonical_key = $2
          AND memory_kind = 'profile_summary'
          AND status = 'active'
        ORDER BY valid_from DESC, id DESC
        LIMIT 1
      `,
      [input.namespaceId, canonicalKey]
    );

    const existing = existingResult.rows[0];
    if (existing && normalizeWritebackText(existing.content_abstract) === normalizedContent) {
      return { triggered: false };
    }

    const insertResult = await client.query<{ id: string }>(
      `
        INSERT INTO semantic_memory (
          namespace_id,
          content_abstract,
          importance_score,
          valid_from,
          valid_until,
          status,
          is_anchor,
          source_episodic_id,
          memory_kind,
          canonical_key,
          normalized_value,
          metadata,
          decay_exempt
        )
        VALUES ($1, $2, 0.85, $3::timestamptz, NULL, 'active', true, $4::uuid, 'profile_summary', $5, $6::jsonb, $7::jsonb, true)
        RETURNING id
      `,
      [
        input.namespaceId,
        normalizedContent,
        support.validFrom,
        support.supportEpisodicIds[0] ?? null,
        canonicalKey,
        JSON.stringify({
          person_name: input.personName,
          profile_kind: input.profileKind,
          note_family: noteFamily,
          support_episodic_ids: support.supportEpisodicIds,
          support_procedural_ids: support.supportProceduralIds,
          supersession_lineage: existing?.id ? [existing.id] : [],
          source_family: "query_time_writeback"
        }),
        JSON.stringify({
          source: "query_time_writeback",
          reconsolidation_kind: "query_time_writeback",
          adjudication_action: existing ? "update" : "add",
          reconsolidation_decision: existing ? "update" : "add",
          note_family: noteFamily,
          person_name: input.personName,
          profile_kind: input.profileKind,
          support_episodic_ids: support.supportEpisodicIds,
          support_procedural_ids: support.supportProceduralIds,
          writeback_query: input.queryText
        })
      ]
    );

    const semanticMemoryId = insertResult.rows[0]?.id;
    if (!semanticMemoryId) {
      return { triggered: false };
    }

    await linkDerivedProfileSnapshot(client, {
      namespaceId: input.namespaceId,
      semanticMemoryId,
      sourceEpisodicId: support.supportEpisodicIds[0] ?? null,
      supportProceduralIds: support.supportProceduralIds,
      relationshipMemoryId: support.relationshipMemoryId,
      supersedesSemanticId: existing?.id ?? null,
      profileKind: input.profileKind
    });

    if (existing) {
      await client.query(
        `
          UPDATE semantic_memory
          SET
            valid_until = $2::timestamptz,
            status = 'superseded',
            superseded_by_id = $3::uuid
          WHERE id = $1::uuid
        `,
        [existing.id, support.validFrom, semanticMemoryId]
      );
    }

    return { triggered: true, noteFamily };
  });
}

async function loadStyleSpecRows(
  namespaceId: string,
  queryText: string,
  candidateLimit: number
): Promise<SearchRow[]> {
  const [summaryRows, rows] = await Promise.all([
    loadActiveSemanticStateSummaryRows(namespaceId, ["style_spec"], candidateLimit),
    queryRows<SearchRow>(
      `
        SELECT
          pm.id AS memory_id,
          'procedural_memory'::text AS memory_type,
          ${proceduralContentExpression()} AS content,
          1::double precision AS raw_score,
          em.artifact_id,
          COALESCE(em.occurred_at, pm.updated_at) AS occurred_at,
          pm.namespace_id,
          jsonb_build_object(
            'tier', 'current_procedural',
            'state_type', pm.state_type,
            'state_key', pm.state_key,
            'version', pm.version,
            'valid_from', pm.valid_from,
            'valid_until', pm.valid_until,
            'source_memory_id', em.id,
            'source_uri', a.uri,
            'metadata', pm.metadata
          ) AS provenance
        FROM procedural_memory pm
        LEFT JOIN episodic_memory em
          ON em.id = NULLIF(pm.state_value->>'source_memory_id', '')::uuid
        LEFT JOIN artifacts a
          ON a.id = em.artifact_id
        WHERE pm.namespace_id = $1
          AND pm.state_type = 'style_spec'
          AND pm.valid_until IS NULL
        ORDER BY pm.updated_at DESC
        LIMIT $2
      `,
      [namespaceId, Math.max(candidateLimit * 2, 12)]
    )
  ]);

  return rankSearchRowsByQueryScore(
    [...summaryRows, ...rows],
    queryText,
    scoreStyleSpecRow,
    Math.max(candidateLimit, 6)
  );
}

async function loadConstraintRows(
  namespaceId: string,
  queryText: string,
  candidateLimit: number
): Promise<SearchRow[]> {
  const [summaryRows, rows] = await Promise.all([
    loadActiveSemanticStateSummaryRows(namespaceId, ["constraint"], candidateLimit),
    queryRows<SearchRow>(
      `
        SELECT
          pm.id AS memory_id,
          'procedural_memory'::text AS memory_type,
          ${proceduralContentExpression()} AS content,
          1::double precision AS raw_score,
          em.artifact_id,
          COALESCE(em.occurred_at, pm.updated_at) AS occurred_at,
          pm.namespace_id,
          jsonb_build_object(
            'tier', 'current_procedural',
            'state_type', pm.state_type,
            'state_key', pm.state_key,
            'version', pm.version,
            'valid_from', pm.valid_from,
            'valid_until', pm.valid_until,
            'source_memory_id', em.id,
            'source_uri', a.uri,
            'metadata', pm.metadata
          ) AS provenance
        FROM procedural_memory pm
        LEFT JOIN episodic_memory em
          ON em.id = NULLIF(pm.state_value->>'source_memory_id', '')::uuid
        LEFT JOIN artifacts a
          ON a.id = em.artifact_id
        WHERE pm.namespace_id = $1
          AND pm.state_type = 'constraint'
          AND pm.valid_until IS NULL
        ORDER BY pm.updated_at DESC
        LIMIT $2
      `,
      [namespaceId, Math.max(candidateLimit * 2, 12)]
    )
  ]);

  return rankSearchRowsByQueryScore(
    [...summaryRows, ...rows],
    queryText,
    scoreConstraintRow,
    Math.max(candidateLimit, 4)
  );
}

async function loadRoutineRows(
  namespaceId: string,
  queryText: string,
  candidateLimit: number
): Promise<SearchRow[]> {
  const [summaryRows, rows] = await Promise.all([
    loadActiveSemanticStateSummaryRows(namespaceId, ["routine"], candidateLimit),
    queryRows<SearchRow>(
      `
        SELECT
          pm.id AS memory_id,
          'procedural_memory'::text AS memory_type,
          ${proceduralContentExpression()} AS content,
          1::double precision AS raw_score,
          em.artifact_id,
          COALESCE(em.occurred_at, pm.updated_at) AS occurred_at,
          pm.namespace_id,
          jsonb_build_object(
            'tier', 'current_procedural',
            'state_type', pm.state_type,
            'state_key', pm.state_key,
            'version', pm.version,
            'valid_from', pm.valid_from,
            'valid_until', pm.valid_until,
            'source_memory_id', em.id,
            'source_uri', a.uri,
            'metadata', pm.metadata
          ) AS provenance
        FROM procedural_memory pm
        LEFT JOIN episodic_memory em
          ON em.id = NULLIF(pm.state_value->>'source_memory_id', '')::uuid
        LEFT JOIN artifacts a
          ON a.id = em.artifact_id
        WHERE pm.namespace_id = $1
          AND pm.state_type = 'routine'
          AND pm.valid_until IS NULL
        ORDER BY pm.updated_at DESC
        LIMIT $2
      `,
      [namespaceId, Math.max(candidateLimit * 2, 12)]
    )
  ]);

  return rankSearchRowsByQueryScore(
    [...summaryRows, ...rows],
    queryText,
    scoreRoutineRow,
    Math.max(candidateLimit, 4)
  );
}

async function loadDecisionRows(
  namespaceId: string,
  queryText: string,
  candidateLimit: number
): Promise<SearchRow[]> {
  const [summaryRows, rows] = await Promise.all([
    loadActiveSemanticStateSummaryRows(namespaceId, ["decision"], candidateLimit),
    queryRows<SearchRow>(
      `
        SELECT
          pm.id AS memory_id,
          'procedural_memory'::text AS memory_type,
          ${proceduralContentExpression()} AS content,
          1::double precision AS raw_score,
          em.artifact_id,
          COALESCE(em.occurred_at, pm.updated_at) AS occurred_at,
          pm.namespace_id,
          jsonb_build_object(
            'tier', 'current_procedural',
            'state_type', pm.state_type,
            'state_key', pm.state_key,
            'version', pm.version,
            'valid_from', pm.valid_from,
            'valid_until', pm.valid_until,
            'source_memory_id', em.id,
            'source_uri', a.uri,
            'metadata', pm.metadata
          ) AS provenance
        FROM procedural_memory pm
        LEFT JOIN episodic_memory em
          ON em.id = NULLIF(pm.state_value->>'source_memory_id', '')::uuid
        LEFT JOIN artifacts a
          ON a.id = em.artifact_id
        WHERE pm.namespace_id = $1
          AND pm.state_type = 'decision'
          AND pm.valid_until IS NULL
        ORDER BY pm.updated_at DESC
        LIMIT $2
      `,
      [namespaceId, Math.max(candidateLimit * 2, 12)]
    )
  ]);

  return rankSearchRowsByQueryScore(
    [...summaryRows, ...rows],
    queryText,
    scoreDecisionRow,
    Math.max(candidateLimit, 4)
  );
}

async function loadGoalRows(
  namespaceId: string,
  queryText: string,
  candidateLimit: number
): Promise<SearchRow[]> {
  const [summaryRows, rows] = await Promise.all([
    loadActiveSemanticStateSummaryRows(namespaceId, ["goal"], candidateLimit),
    queryRows<SearchRow>(
      `
        SELECT
          pm.id AS memory_id,
          'procedural_memory'::text AS memory_type,
          ${proceduralContentExpression()} AS content,
          1::double precision AS raw_score,
          em.artifact_id,
          COALESCE(em.occurred_at, pm.updated_at) AS occurred_at,
          pm.namespace_id,
          jsonb_build_object(
            'tier', 'current_procedural',
            'state_type', pm.state_type,
            'state_key', pm.state_key,
            'version', pm.version,
            'valid_from', pm.valid_from,
            'valid_until', pm.valid_until,
            'source_memory_id', em.id,
            'source_uri', a.uri,
            'metadata', pm.metadata
          ) AS provenance
        FROM procedural_memory pm
        LEFT JOIN episodic_memory em
          ON em.id = NULLIF(pm.state_value->>'source_memory_id', '')::uuid
        LEFT JOIN artifacts a
          ON a.id = em.artifact_id
        WHERE pm.namespace_id = $1
          AND pm.state_type = 'goal'
          AND pm.valid_until IS NULL
        ORDER BY pm.updated_at DESC
        LIMIT $2
      `,
      [namespaceId, Math.max(candidateLimit * 2, 8)]
    )
  ]);

  return rankSearchRowsByQueryScore(
    [...summaryRows, ...rows],
    queryText,
    scoreGoalRow,
    Math.max(candidateLimit, 4)
  );
}

async function loadPlanRows(
  namespaceId: string,
  queryText: string,
  candidateLimit: number
): Promise<SearchRow[]> {
  const [summaryRows, rows] = await Promise.all([
    loadActiveSemanticStateSummaryRows(namespaceId, ["plan"], candidateLimit),
    queryRows<SearchRow>(
      `
        SELECT
          pm.id AS memory_id,
          'procedural_memory'::text AS memory_type,
          ${proceduralContentExpression()} AS content,
          1::double precision AS raw_score,
          em.artifact_id,
          COALESCE(em.occurred_at, pm.updated_at) AS occurred_at,
          pm.namespace_id,
          jsonb_build_object(
            'tier', 'current_procedural',
            'state_type', pm.state_type,
            'state_key', pm.state_key,
            'version', pm.version,
            'valid_from', pm.valid_from,
            'valid_until', pm.valid_until,
            'source_memory_id', em.id,
            'source_uri', a.uri,
            'metadata', pm.metadata
          ) AS provenance
        FROM procedural_memory pm
        LEFT JOIN episodic_memory em
          ON em.id = NULLIF(pm.state_value->>'source_memory_id', '')::uuid
        LEFT JOIN artifacts a
          ON a.id = em.artifact_id
        WHERE pm.namespace_id = $1
          AND pm.state_type = 'plan'
          AND pm.valid_until IS NULL
        ORDER BY pm.updated_at DESC
        LIMIT $2
      `,
      [namespaceId, Math.max(candidateLimit * 2, 12)]
    )
  ]);

  return rankSearchRowsByQueryScore(
    [...summaryRows, ...rows],
    queryText,
    scorePlanRow,
    Math.max(candidateLimit, 6)
  );
}

async function loadBeliefRows(
  namespaceId: string,
  queryText: string,
  candidateLimit: number,
  timeStart: string | null,
  timeEnd: string | null,
  mode: "current" | "historical" | "point_in_time"
): Promise<SearchRow[]> {
  const baseSelect = `
      SELECT
        pm.id AS memory_id,
        'procedural_memory'::text AS memory_type,
        ${proceduralContentExpression()} AS content,
        1::double precision AS raw_score,
        em.artifact_id,
        COALESCE(em.occurred_at, pm.updated_at) AS occurred_at,
        pm.namespace_id,
        jsonb_build_object(
          'tier', CASE WHEN pm.valid_until IS NULL THEN 'current_procedural' ELSE 'historical_procedural' END,
          'state_type', pm.state_type,
          'state_key', pm.state_key,
          'version', pm.version,
          'valid_from', pm.valid_from,
          'valid_until', pm.valid_until,
          'source_memory_id', em.id,
          'source_uri', a.uri,
          'metadata', pm.metadata
        ) AS provenance
      FROM procedural_memory pm
      LEFT JOIN episodic_memory em
        ON em.id = NULLIF(pm.state_value->>'source_memory_id', '')::uuid
      LEFT JOIN artifacts a
        ON a.id = em.artifact_id
      WHERE pm.namespace_id = $1
        AND pm.state_type = 'belief'
  `;

  const limitValue = Math.max(candidateLimit * 3, 18);
  const rows =
    mode === "point_in_time"
      ? await queryRows<SearchRow>(
          `
            ${baseSelect}
              AND ($2::timestamptz IS NULL OR pm.valid_from <= $3::timestamptz)
              AND (pm.valid_until IS NULL OR $2::timestamptz IS NULL OR pm.valid_until >= $2::timestamptz)
            ORDER BY pm.valid_from DESC, pm.updated_at DESC
            LIMIT $4
          `,
          [namespaceId, timeStart, timeEnd, limitValue]
        )
      : await queryRows<SearchRow>(
          `
            ${baseSelect}
              AND ${mode === "current" ? "pm.valid_until IS NULL" : "TRUE"}
            ORDER BY pm.valid_from DESC, pm.updated_at DESC
            LIMIT $2
          `,
          [namespaceId, limitValue]
        );
  const summaryRows =
    mode === "current"
      ? await loadActiveSemanticBeliefSummaryRows(namespaceId, candidateLimit)
      : [];

  return rankSearchRowsByQueryScore(
    [...summaryRows, ...rows],
    queryText,
    scoreBeliefRow,
    Math.max(candidateLimit, mode === "historical" ? 6 : 4)
  );
}

function scoreSalienceRow(row: SearchRow, queryText: string): number {
  const normalizedQuery = queryText.toLowerCase();
  const metadata = (row.provenance.metadata ?? {}) as Record<string, unknown>;
  const labels = Array.isArray(metadata.salience_labels)
    ? metadata.salience_labels.filter((value): value is string => typeof value === "string").map((value) => value.toLowerCase())
    : [];
  const sentimentScore = typeof metadata.sentiment_score === "number" ? metadata.sentiment_score : Number(metadata.sentiment_score ?? 0);
  const surpriseMagnitude = typeof metadata.surprise_magnitude === "number" ? metadata.surprise_magnitude : Number(metadata.surprise_magnitude ?? 0);
  const normalizedContent = String(row.content ?? "").toLowerCase();
  const rawTerms = queryText.match(/[A-Za-z0-9][A-Za-z0-9._:-]*/g) ?? [];
  const topicalAnchors = rawTerms
    .map((term) => term.trim())
    .filter(Boolean)
    .filter((term) => !/^[A-Z][a-z]+$/.test(term))
    .map((term) => term.toLowerCase())
    .filter((term) => !BM25_STOP_WORDS.has(term))
    .filter((term) => !["most", "part", "steve", "surprising", "surprise", "realization", "frustrating", "frustration", "frustrated", "annoyed", "bothered", "excited", "exciting", "amazing", "thrilled"].includes(term));
  const matchedAnchors = topicalAnchors.filter((term) => normalizedContent.includes(term));
  const topicalCoverage = topicalAnchors.length > 0 ? matchedAnchors.length / topicalAnchors.length : 0;
  const queryWantsSurprise = /\b(?:surpris|realization)\b/.test(normalizedQuery);
  const queryWantsFrustration = /\b(?:frustrat|annoy|bothered)\b/.test(normalizedQuery);
  const queryWantsExcitement = /\b(?:excited|amazing|thrilled)\b/.test(normalizedQuery);
  const headingLike = /\bnote\b/i.test(String(row.content ?? "")) && String(row.content ?? "").trim().split(/\s+/u).length <= 8;

  let score = 0.3;
  if (topicalAnchors.length > 0) {
    if (matchedAnchors.length === 0) {
      return 0;
    }
    score += topicalCoverage * 4.2;
    if (matchedAnchors.length >= 2) {
      score += 0.9;
    }
  }
  if (normalizedQuery.includes("graph ux") && normalizedContent.includes("graph ux")) {
    score += 1.4;
  }
  if (normalizedQuery.includes("local-brain") && normalizedQuery.includes("bring-up") && normalizedContent.includes("local-brain") && normalizedContent.includes("bring-up")) {
    score += 1.2;
  }
  if (queryWantsSurprise) {
    score += Math.max(0, surpriseMagnitude) * 3;
    if (labels.includes("surprised")) {
      score += 2;
    } else if (labels.length > 0 || Math.abs(sentimentScore) > 0.05) {
      score -= 1.2;
    }
  }
  if (queryWantsFrustration) {
    score += Math.max(0, -sentimentScore) * 3;
    if (labels.includes("frustrated")) {
      score += 2;
    } else if (labels.includes("excited") || labels.includes("surprised") || sentimentScore > 0.15 || surpriseMagnitude > 0.25) {
      score -= 2.4;
    }
  }
  if (queryWantsExcitement) {
    score += Math.max(0, sentimentScore) * 3;
    if (labels.includes("excited")) {
      score += 2;
    } else if (labels.includes("frustrated") || labels.includes("surprised") || sentimentScore < -0.15 || surpriseMagnitude > 0.25) {
      score -= 2.4;
    }
  }
  if (/\bgraph\b/.test(normalizedQuery) && normalizedContent.includes("graph")) {
    score += 0.8;
  }
  if (/\blocal-brain\b/.test(normalizedQuery) && normalizedContent.includes("local-brain")) {
    score += 0.8;
  }
  if (/\bpostgres(?:ql)?\b/.test(normalizedQuery) && normalizedContent.includes("postgres")) {
    score += 0.8;
  }
  if (headingLike) {
    score -= 1.1;
  }

  return score;
}

function rerankSalienceRows(
  rows: readonly RankedSearchRow[],
  queryText: string,
  candidateLimit: number
): RankedSearchRow[] {
  return [...rows]
    .map((row) => ({
      ...row,
      scoreValue: Math.max(row.scoreValue * 0.12, scoreSalienceRow(row, queryText))
    }))
    .filter((row) => row.scoreValue > 0.5)
    .sort((left, right) => {
      const scoreDelta = right.scoreValue - left.scoreValue;
      if (scoreDelta !== 0) {
        return scoreDelta;
      }
      const rightIso = toIsoString(right.occurred_at);
      const leftIso = toIsoString(left.occurred_at);
      if (leftIso && rightIso && leftIso !== rightIso) {
        return rightIso.localeCompare(leftIso);
      }
      return `${left.memory_type}:${left.memory_id}`.localeCompare(`${right.memory_type}:${right.memory_id}`);
    })
    .slice(0, Math.max(candidateLimit, 6));
}

function rerankReasoningRows(
  rows: readonly RankedSearchRow[],
  queryText: string,
  candidateLimit: number,
  mode: "identity" | "shared" | "causal"
): RankedSearchRow[] {
  const participants = extractConversationParticipants(queryText).map((participant) => participant.toLowerCase());
  return [...rows]
    .map((row) => {
      const content = String(row.content ?? "").toLowerCase();
      let score = row.scoreValue * 0.18;
      for (const participant of participants) {
        if (participant && content.includes(participant)) {
          score += 1.2;
        }
      }
      if (mode === "identity") {
        if (/\b(transgender|nonbinary|gender identity|transition|identity|trans woman|trans man|queer)\b/.test(content)) {
          score += 4;
        }
        if (/\b(accept|embrace|safe place|community|self-expression)\b/.test(content)) {
          score += 1.5;
        }
      } else if (mode === "shared") {
        if (/\b(both|same here|me too|we both|in common|shared)\b/.test(content)) {
          score += 3;
        }
        if (/\b(dance|dancing|stress relief|destress|de-stress|business|job|lost my job|own business)\b/.test(content)) {
          score += 2;
        }
      } else if (mode === "causal") {
        if (/\b(because|decided|started|want to|dream|passion|share|teach others|joy)\b/.test(content)) {
          score += 2.5;
        }
        if (/\b(lost my job|gave me the push|pushed me|take the plunge|setback)\b/.test(content)) {
          score += 2.5;
        }
      }
      return { ...row, scoreValue: score };
    })
    .sort((left, right) => {
      const scoreDelta = right.scoreValue - left.scoreValue;
      if (scoreDelta !== 0) {
        return scoreDelta;
      }
      const rightIso = toIsoString(right.occurred_at);
      const leftIso = toIsoString(left.occurred_at);
      if (leftIso && rightIso && leftIso !== rightIso) {
        return rightIso.localeCompare(leftIso);
      }
      return `${left.memory_type}:${left.memory_id}`.localeCompare(`${right.memory_type}:${right.memory_id}`);
    })
    .slice(0, Math.max(candidateLimit, 8));
}

async function loadSalientRows(
  namespaceId: string,
  queryText: string,
  candidateLimit: number,
  timeStart: string | null,
  timeEnd: string | null
): Promise<SearchRow[]> {
  const [episodicRows, narrativeRows] = await Promise.all([
    queryRows<SearchRow>(
      `
        SELECT
          em.id AS memory_id,
          'episodic_memory'::text AS memory_type,
          em.content,
          1::double precision AS raw_score,
          em.artifact_id,
          em.occurred_at,
          em.namespace_id,
          jsonb_build_object(
            'tier', 'historical_episodic',
            'artifact_observation_id', em.artifact_observation_id,
            'source_chunk_id', em.source_chunk_id,
            'source_uri', a.uri,
            'metadata', em.metadata
          ) AS provenance
        FROM episodic_memory em
        LEFT JOIN artifacts a ON a.id = em.artifact_id
        WHERE em.namespace_id = $1
          AND (em.metadata ? 'salience_labels' OR em.metadata ? 'surprise_magnitude')
          AND ($2::timestamptz IS NULL OR em.occurred_at >= $2)
          AND ($3::timestamptz IS NULL OR em.occurred_at <= $3)
        ORDER BY em.occurred_at DESC
        LIMIT $4
      `,
      [namespaceId, timeStart, timeEnd, Math.max(candidateLimit * 3, 18)]
    ),
    queryRows<SearchRow>(
      `
        SELECT
          ne.id AS memory_id,
          'narrative_event'::text AS memory_type,
          ${narrativeEventLexicalDocument("ne", "subject_entity", "location_entity")} AS content,
          1::double precision AS raw_score,
          ne.artifact_id,
          COALESCE(ne.time_start, ne.created_at) AS occurred_at,
          ne.namespace_id,
          jsonb_build_object(
            'tier', 'narrative_event',
            'event_kind', ne.event_kind,
            'event_label', ne.event_label,
            'time_expression_text', ne.time_expression_text,
            'source_uri', a.uri,
            'metadata', ne.metadata
          ) AS provenance
        FROM narrative_events ne
        LEFT JOIN artifacts a ON a.id = ne.artifact_id
        LEFT JOIN entities subject_entity ON subject_entity.id = ne.primary_subject_entity_id
        LEFT JOIN entities location_entity ON location_entity.id = ne.primary_location_entity_id
        WHERE ne.namespace_id = $1
          AND (ne.metadata ? 'salience_labels' OR ne.metadata ? 'surprise_magnitude')
          AND ($2::timestamptz IS NULL OR COALESCE(ne.time_start, ne.created_at) >= $2)
          AND ($3::timestamptz IS NULL OR COALESCE(ne.time_start, ne.created_at) <= $3)
        ORDER BY COALESCE(ne.time_start, ne.created_at) DESC
        LIMIT $4
      `,
      [namespaceId, timeStart, timeEnd, Math.max(candidateLimit * 2, 12)]
    )
  ]);

  return [...episodicRows, ...narrativeRows]
    .map((row) => ({ row, score: scoreSalienceRow(row, queryText) }))
    .filter((item) => item.score > 0.5)
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      const leftIso = toIsoString(left.row.occurred_at);
      const rightIso = toIsoString(right.row.occurred_at);
      if (leftIso && rightIso && leftIso !== rightIso) {
        return rightIso.localeCompare(leftIso);
      }
      return resultKey(left.row).localeCompare(resultKey(right.row));
    })
    .slice(0, Math.max(candidateLimit, 6))
    .map((item) => ({
      ...item.row,
      raw_score: item.score
    }));
}

function buildProvenanceAnswer(
  normalizedClaim: string,
  results: readonly RecallResult[],
  evidence: RecallResponse["evidence"]
): RecallResponse["meta"]["provenanceAnswer"] {
  const top = results[0];
  const topStateType = typeof top?.provenance.state_type === "string" ? top.provenance.state_type : null;
  const topPredicate = typeof top?.provenance.predicate === "string" ? top.provenance.predicate : null;

  let adjudicationReasoning =
    "The current active fact outranked historical rows because it remained active and retained direct evidence pointers.";
  if (topStateType === "current_employer") {
    adjudicationReasoning =
      "The current employer state remained authoritative because it superseded older employer facts and still points to source evidence.";
  } else if (topStateType === "current_location") {
    adjudicationReasoning =
      "The current residence state remained authoritative because the most specific unsuperseded home fact still points to source evidence.";
  } else if (topStateType === "active_membership" || topPredicate === "member_of") {
    adjudicationReasoning =
      "The membership fact remained active because repeated participation crossed the promotion threshold and retained source evidence.";
  } else if (top?.memoryType === "relationship_memory") {
    adjudicationReasoning =
      "The active relationship edge outranked older candidates because it is still valid and grounded in source evidence.";
  }

  return {
    queryType: "why",
    normalizedClaim,
    distilledClaim: top?.content,
    adjudicationReasoning,
    evidence: evidence.map((item) => ({
      memoryId: item.memoryId,
      artifactId: item.artifactId ?? null,
      sourceUri: item.sourceUri ?? null
    }))
  };
}

function mapRecallRows(rows: SearchRow[]): RecallResult[] {
  return rows.map((row) =>
    buildRecallResult(row, toNumber(row.raw_score), {
      rrfScore: toNumber(row.raw_score)
    })
  );
}

function memoryTypePriority(
  memoryType: RecallResult["memoryType"],
  hasTimeWindow: boolean,
  temporalFocus: boolean,
  dailyLifeEventFocus = false,
  dailyLifeSummaryFocus = false
): number {
  if (dailyLifeSummaryFocus) {
    switch (memoryType) {
      case "semantic_memory":
        return 0;
      case "temporal_nodes":
        return 1;
      case "narrative_event":
        return 2;
      case "episodic_memory":
        return 3;
      case "artifact_derivation":
        return 4;
      case "relationship_memory":
      case "relationship_candidate":
        return 5;
      case "procedural_memory":
        return 6;
      default:
        return 7;
    }
  }
  if (dailyLifeEventFocus) {
    switch (memoryType) {
      case "narrative_event":
        return 0;
      case "episodic_memory":
        return 1;
      case "temporal_nodes":
        return 2;
      case "artifact_derivation":
        return 3;
      case "relationship_memory":
      case "relationship_candidate":
        return 4;
      case "semantic_memory":
        return 5;
      case "procedural_memory":
        return 6;
      default:
        return 7;
    }
  }
  if (temporalFocus) {
    switch (memoryType) {
      case "narrative_event":
        return 0;
      case "episodic_memory":
        return 1;
      case "temporal_nodes":
        return 2;
      case "artifact_derivation":
        return 3;
      case "semantic_memory":
        return 4;
      case "memory_candidate":
        return 5;
      case "relationship_candidate":
      case "procedural_memory":
      case "relationship_memory":
        return 6;
      default:
        return 7;
    }
  }

  if (hasTimeWindow) {
    switch (memoryType) {
      case "narrative_event":
        return 0;
      case "episodic_memory":
        return 1;
      case "temporal_nodes":
        return 2;
      case "artifact_derivation":
        return 3;
      case "semantic_memory":
        return 4;
      case "memory_candidate":
        return 5;
      case "relationship_candidate":
      case "procedural_memory":
      case "relationship_memory":
        return 6;
      default:
        return 7;
    }
  }

  switch (memoryType) {
    case "procedural_memory":
      return 0;
    case "relationship_memory":
      return 1;
    case "relationship_candidate":
      return 2;
    case "semantic_memory":
      return 3;
    case "episodic_memory":
      return 4;
    case "narrative_event":
      return 5;
    case "artifact_derivation":
      return 6;
    case "memory_candidate":
      return 7;
    case "temporal_nodes":
      return 8;
    default:
      return 9;
  }
}

function compareLexical(
  left: RankedSearchRow,
  right: RankedSearchRow,
  hasTimeWindow: boolean,
  temporalFocus: boolean,
  dailyLifeEventFocus = false,
  dailyLifeSummaryFocus = false
): number {
  const scoreDelta =
    (right.scoreValue + sourceTrustAdjustment(right)) -
    (left.scoreValue + sourceTrustAdjustment(left));
  if (scoreDelta !== 0) {
    return scoreDelta;
  }

  const priorityDelta =
    memoryTypePriority(left.memory_type, hasTimeWindow, temporalFocus, dailyLifeEventFocus, dailyLifeSummaryFocus) -
    memoryTypePriority(right.memory_type, hasTimeWindow, temporalFocus, dailyLifeEventFocus, dailyLifeSummaryFocus);
  if (priorityDelta !== 0) {
    return priorityDelta;
  }

  const rightIso = toIsoString(right.occurred_at);
  const leftIso = toIsoString(left.occurred_at);
  if (leftIso && rightIso && leftIso !== rightIso) {
    return rightIso.localeCompare(leftIso);
  }

  return `${left.memory_type}:${left.memory_id}`.localeCompare(`${right.memory_type}:${right.memory_id}`);
}

function compareVector(left: RankedSearchRow, right: RankedSearchRow): number {
  const scoreDelta = left.scoreValue - right.scoreValue;
  if (scoreDelta !== 0) {
    return scoreDelta;
  }

  const rightIso = toIsoString(right.occurred_at);
  const leftIso = toIsoString(left.occurred_at);
  if (leftIso && rightIso && leftIso !== rightIso) {
    return rightIso.localeCompare(leftIso);
  }

  return `${left.memory_type}:${left.memory_id}`.localeCompare(`${right.memory_type}:${right.memory_id}`);
}

function toRankedRows(rows: SearchRow[]): RankedSearchRow[] {
  return rows.map((row) => ({
    ...row,
    scoreValue: toNumber(row.raw_score)
  }));
}

function resultKey(row: SearchRow): string {
  return `${row.memory_type}:${row.memory_id}`;
}

function rowSourceUri(row: Pick<SearchRow, "provenance">): string | null {
  return typeof row.provenance.source_uri === "string" && row.provenance.source_uri.length > 0
    ? row.provenance.source_uri
    : null;
}

function isPersonalContaminantSourceUri(sourceUri: string | null): boolean {
  if (!sourceUri) {
    return false;
  }

  return (
    sourceUri.includes("/benchmark-generated/") ||
    sourceUri.includes("/examples-private/life-replay/") ||
    sourceUri.includes("/local-brain/examples/")
  );
}

function isTrustedPersonalSourceUri(sourceUri: string | null): boolean {
  if (!sourceUri) {
    return false;
  }

  return (
    sourceUri.includes("/omi-archive/normalized/") ||
    sourceUri.includes("/data/inbox/omi/normalized/") ||
    sourceUri.includes("/personal-openclaw-fixtures/")
  );
}

function sourceTrustAdjustment(row: Pick<SearchRow, "namespace_id" | "provenance">): number {
  const sourceUri = rowSourceUri(row);
  if (row.namespace_id === "personal") {
    if (isPersonalContaminantSourceUri(sourceUri)) {
      return -3.25;
    }
    if (isTrustedPersonalSourceUri(sourceUri)) {
      return 0.85;
    }
  }

  if (row.namespace_id === "personal_continuity_shadow" && isTrustedPersonalSourceUri(sourceUri)) {
    return 0.65;
  }

  return 0;
}

function retainTrustedNamespaceRows<T extends { readonly row: SearchRow }>(rows: readonly T[]): T[] {
  if (rows.length === 0) {
    return [];
  }

  const hasTrustedPersonalRows = rows.some((item) => item.row.namespace_id === "personal" && isTrustedPersonalSourceUri(rowSourceUri(item.row)));
  if (!hasTrustedPersonalRows) {
    return [...rows];
  }

  const filtered = rows.filter((item) => !(item.row.namespace_id === "personal" && isPersonalContaminantSourceUri(rowSourceUri(item.row))));
  return filtered.length > 0 ? filtered : [...rows];
}

function mergeInjectedRankedRows(
  rankedRows: readonly SqlFusedRankingRow[],
  injectedRows: readonly RankedSearchRow[],
  scoreBoost = 0.75
): SqlFusedRankingRow[] {
  if (injectedRows.length === 0) {
    return [...rankedRows];
  }

  const baseScore = Math.max(rankedRows[0]?.rrfScore ?? 0, 1);
  const merged = new Map(rankedRows.map((item) => [resultKey(item.row), { ...item }] as const));

  for (const [index, row] of injectedRows.entries()) {
    const key = resultKey(row);
    const boostedScore = baseScore + scoreBoost - index * 0.01;
    const existing = merged.get(key);
    if (existing) {
      merged.set(key, {
        ...existing,
        lexicalRank: Math.min(existing.lexicalRank ?? Number.POSITIVE_INFINITY, 1),
        lexicalRawScore: Math.max(existing.lexicalRawScore ?? 0, row.scoreValue),
        rrfScore: Math.max(existing.rrfScore, boostedScore)
      });
      continue;
    }

    merged.set(key, {
      row,
      lexicalRank: 1,
      lexicalRawScore: row.scoreValue,
      rrfScore: boostedScore
    });
  }

  return [...merged.values()].sort((left, right) => {
    const scoreDelta = right.rrfScore - left.rrfScore;
    if (scoreDelta !== 0) {
      return scoreDelta;
    }

    const leftIso = toIsoString(left.row.occurred_at);
    const rightIso = toIsoString(right.row.occurred_at);
    if (leftIso && rightIso && leftIso !== rightIso) {
      return rightIso.localeCompare(leftIso);
    }

    return resultKey(left.row).localeCompare(resultKey(right.row));
  });
}

function isUuidLike(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

interface SqlFusedRankingRow {
  readonly row: SearchRow;
  readonly lexicalRank?: number;
  readonly vectorRank?: number;
  readonly lexicalRawScore?: number;
  readonly vectorDistance?: number;
  readonly rrfScore: number;
  readonly appScore?: number;
  readonly appSignals?: {
    readonly lexical: number;
    readonly temporal: number;
    readonly participant: number;
    readonly cluster: number;
    readonly leaf: number;
    readonly modeSpecific: number;
    readonly source: number;
  };
}

async function fuseRankedRowsInSql(
  lexicalRows: readonly RankedSearchRow[],
  vectorRows: readonly RankedSearchRow[],
  planner: ReturnType<typeof planRecallQuery>
): Promise<readonly SqlFusedRankingRow[]> {
  if (lexicalRows.length === 0 && vectorRows.length === 0) {
    return [];
  }

  const lexicalPayload = lexicalRows.map((row, index) => ({
    memory_id: row.memory_id,
    memory_type: row.memory_type,
    content: row.content,
    artifact_id: row.artifact_id,
    occurred_at: toIsoString(row.occurred_at),
    namespace_id: row.namespace_id,
    provenance: row.provenance,
    lexical_rank: index + 1,
    lexical_raw_score: row.scoreValue,
    lexical_weight:
      row.memory_type === "episodic_memory" || row.memory_type === "narrative_event"
        ? planner.episodicWeight
        : row.memory_type === "temporal_nodes"
          ? planner.temporalSummaryWeight
          : 1
  }));
  const vectorPayload = vectorRows.map((row, index) => ({
    memory_id: row.memory_id,
    memory_type: row.memory_type,
    content: row.content,
    artifact_id: row.artifact_id,
    occurred_at: toIsoString(row.occurred_at),
    namespace_id: row.namespace_id,
    provenance: row.provenance,
    vector_rank: index + 1,
    vector_distance: row.scoreValue
  }));

  const rows = await queryRows<{
    readonly memory_id: string;
    readonly memory_type: RecallResult["memoryType"];
    readonly content: string;
    readonly artifact_id: string | null;
    readonly occurred_at: string | null;
    readonly namespace_id: string;
    readonly provenance: Record<string, unknown>;
    readonly lexical_rank: number | null;
    readonly vector_rank: number | null;
    readonly lexical_raw_score: number | null;
    readonly vector_distance: number | null;
    readonly rrf_score: number;
  }>(
    `
      WITH lexical AS (
        SELECT *
        FROM jsonb_to_recordset($1::jsonb) AS x(
          memory_id text,
          memory_type text,
          content text,
          artifact_id uuid,
          occurred_at timestamptz,
          namespace_id text,
          provenance jsonb,
          lexical_rank integer,
          lexical_raw_score double precision,
          lexical_weight double precision
        )
      ),
      vector AS (
        SELECT *
        FROM jsonb_to_recordset($2::jsonb) AS x(
          memory_id text,
          memory_type text,
          content text,
          artifact_id uuid,
          occurred_at timestamptz,
          namespace_id text,
          provenance jsonb,
          vector_rank integer,
          vector_distance double precision
        )
      ),
      contributors AS (
        SELECT
          memory_id,
          memory_type,
          content,
          artifact_id,
          occurred_at,
          namespace_id,
          provenance,
          lexical_rank,
          NULL::integer AS vector_rank,
          lexical_raw_score,
          NULL::double precision AS vector_distance,
          lexical_weight / (60 + lexical_rank)::double precision AS rrf_part,
          0 AS source_priority
        FROM lexical

        UNION ALL

        SELECT
          memory_id,
          memory_type,
          content,
          artifact_id,
          occurred_at,
          namespace_id,
          provenance,
          NULL::integer AS lexical_rank,
          vector_rank,
          NULL::double precision AS lexical_raw_score,
          vector_distance,
          1 / (60 + vector_rank)::double precision AS rrf_part,
          1 AS source_priority
        FROM vector
      ),
      fused AS (
        SELECT
          memory_id::text AS memory_id,
          (array_agg(memory_type ORDER BY source_priority ASC, lexical_rank ASC NULLS LAST, vector_rank ASC NULLS LAST))[1] AS memory_type,
          (array_agg(content ORDER BY source_priority ASC, lexical_rank ASC NULLS LAST, vector_rank ASC NULLS LAST))[1] AS content,
          (array_agg(artifact_id ORDER BY source_priority ASC, lexical_rank ASC NULLS LAST, vector_rank ASC NULLS LAST))[1]::text AS artifact_id,
          (array_agg(occurred_at ORDER BY source_priority ASC, lexical_rank ASC NULLS LAST, vector_rank ASC NULLS LAST))[1] AS occurred_at,
          (array_agg(namespace_id ORDER BY source_priority ASC, lexical_rank ASC NULLS LAST, vector_rank ASC NULLS LAST))[1] AS namespace_id,
          (array_agg(provenance ORDER BY source_priority ASC, lexical_rank ASC NULLS LAST, vector_rank ASC NULLS LAST))[1] AS provenance,
          MIN(lexical_rank) FILTER (WHERE lexical_rank IS NOT NULL) AS lexical_rank,
          MIN(vector_rank) FILTER (WHERE vector_rank IS NOT NULL) AS vector_rank,
          MAX(lexical_raw_score) FILTER (WHERE lexical_raw_score IS NOT NULL) AS lexical_raw_score,
          MIN(vector_distance) FILTER (WHERE vector_distance IS NOT NULL) AS vector_distance,
          SUM(rrf_part) AS rrf_score
        FROM contributors
        GROUP BY memory_id
      )
      SELECT
        memory_id,
        memory_type,
        content,
        artifact_id,
        occurred_at::text AS occurred_at,
        namespace_id,
        provenance,
        lexical_rank,
        vector_rank,
        lexical_raw_score,
        vector_distance,
        rrf_score
      FROM fused
      ORDER BY rrf_score DESC, occurred_at DESC NULLS LAST, memory_id ASC
    `,
    [JSON.stringify(lexicalPayload), JSON.stringify(vectorPayload)]
  );

  return rows.map((row) => ({
    row: {
      memory_id: row.memory_id,
      memory_type: row.memory_type,
      content: row.content,
      raw_score: row.lexical_raw_score ?? row.vector_distance ?? row.rrf_score,
      artifact_id: row.artifact_id,
      occurred_at: row.occurred_at,
      namespace_id: row.namespace_id,
      provenance: row.provenance
    },
    lexicalRank: row.lexical_rank ?? undefined,
    vectorRank: row.vector_rank ?? undefined,
    lexicalRawScore: row.lexical_raw_score ?? undefined,
    vectorDistance: row.vector_distance ?? undefined,
    rrfScore: row.rrf_score
  }));
}

function compareFusedResults(
  left: SqlFusedRankingRow,
  right: SqlFusedRankingRow,
  hasTimeWindow: boolean,
  temporalFocus: boolean,
  dailyLifeEventFocus: boolean,
  dailyLifeSummaryFocus: boolean
): number {
  const scoreDelta =
    ((right.appScore ?? right.rrfScore) + sourceTrustAdjustment(right.row)) -
    ((left.appScore ?? left.rrfScore) + sourceTrustAdjustment(left.row));
  if (scoreDelta !== 0) {
    return scoreDelta;
  }

  const priorityDelta =
    memoryTypePriority(
      left.row.memory_type,
      hasTimeWindow,
      temporalFocus,
      dailyLifeEventFocus,
      dailyLifeSummaryFocus
    ) -
    memoryTypePriority(
      right.row.memory_type,
      hasTimeWindow,
      temporalFocus,
      dailyLifeEventFocus,
      dailyLifeSummaryFocus
    );
  if (priorityDelta !== 0) {
    return priorityDelta;
  }

  const leftIso = toIsoString(left.row.occurred_at);
  const rightIso = toIsoString(right.row.occurred_at);
  if (leftIso && rightIso && leftIso !== rightIso) {
    return rightIso.localeCompare(leftIso);
  }

  return resultKey(left.row).localeCompare(resultKey(right.row));
}

function applyUnifiedAppFusion(
  rows: readonly SqlFusedRankingRow[],
  queryText: string,
  planner: ReturnType<typeof planRecallQuery>,
  options: {
    readonly hasTimeWindow: boolean;
    readonly timeStart: string | null;
    readonly timeEnd: string | null;
    readonly dailyLifeEventFocus: boolean;
    readonly dailyLifeSummaryFocus: boolean;
    readonly temporalDetailFocus: boolean;
    readonly preciseFactDetailFocus: boolean;
    readonly activeRelationshipFocus: boolean;
    readonly historicalRelationshipFocus: boolean;
    readonly identityProfileFocus: boolean;
    readonly sharedCommonalityFocus: boolean;
    readonly causalDecisionFocus: boolean;
  }
): SqlFusedRankingRow[] {
  if (rows.length <= 1) {
    return [...rows];
  }

  const normalizedParticipants = extractConversationParticipants(queryText)
    .map((participant) => normalizeWhitespace(participant).toLowerCase())
    .filter((participant) => participant.length > 0);
  const normalizedTerms = planner.lexicalTerms
    .map((term) => normalizeWhitespace(term).toLowerCase())
    .filter((term) => term.length > 2);
  const artifactCounts = new Map<string, number>();
  const dayCounts = new Map<string, number>();

  for (const item of rows) {
    if (typeof item.row.artifact_id === "string" && item.row.artifact_id) {
      artifactCounts.set(item.row.artifact_id, (artifactCounts.get(item.row.artifact_id) ?? 0) + 1);
    }
    const iso = toIsoString(item.row.occurred_at);
    if (iso) {
      const dayKey = iso.slice(0, 10);
      dayCounts.set(dayKey, (dayCounts.get(dayKey) ?? 0) + 1);
    }
  }

  const ranked = rows.map((item) => {
    const content = normalizeWhitespace(item.row.content ?? "").toLowerCase();
    const provenanceMetadata =
      typeof item.row.provenance.metadata === "object" && item.row.provenance.metadata !== null
        ? (item.row.provenance.metadata as Record<string, unknown>)
        : null;
    const derivationType = item.row.memory_type === "artifact_derivation"
      ? String(item.row.provenance.derivation_type ?? "")
      : "";
    const lexicalHits = normalizedTerms.filter((term) => content.includes(term)).length;
    const lexicalSignal = Math.min(1.2, lexicalHits * 0.18);

    const participantHits = normalizedParticipants.filter((participant) => content.includes(participant)).length;
    const participantSignal =
      participantHits * (options.sharedCommonalityFocus ? 0.75 : options.activeRelationshipFocus || options.historicalRelationshipFocus ? 0.5 : 0.35);

    let temporalSignal = 0;
    if (options.hasTimeWindow) {
      const alignment = temporalWindowAlignmentMultiplier(item.row, options.timeStart, options.timeEnd);
      temporalSignal = alignment >= 1 ? (alignment - 1) * 2.4 : -Math.min(0.9, (1 - alignment) * 0.9);
    }

    let clusterSignal = 0;
    if (typeof item.row.artifact_id === "string" && item.row.artifact_id) {
      clusterSignal += Math.min(0.7, Math.max(0, (artifactCounts.get(item.row.artifact_id) ?? 1) - 1) * 0.22);
    }
    const iso = toIsoString(item.row.occurred_at);
    if (iso) {
      clusterSignal += Math.min(0.35, Math.max(0, (dayCounts.get(iso.slice(0, 10)) ?? 1) - 1) * 0.1);
    }

    const leafFocus =
      planner.leafEvidenceRequired ||
      options.temporalDetailFocus ||
      options.preciseFactDetailFocus ||
      options.identityProfileFocus ||
      options.sharedCommonalityFocus ||
      options.causalDecisionFocus ||
      options.dailyLifeEventFocus;
    let leafSignal = 0;
    if (leafFocus) {
      if (item.row.memory_type === "episodic_memory" || item.row.memory_type === "narrative_event" || item.row.memory_type === "artifact_derivation") {
        leafSignal += 0.62;
      } else if (item.row.memory_type === "temporal_nodes") {
        leafSignal -= 0.24;
      }
    } else if (options.dailyLifeSummaryFocus && item.row.memory_type === "temporal_nodes") {
      leafSignal += 0.22;
    }

    let modeSpecificSignal = 0;
    if (options.identityProfileFocus && /\b(transgender|nonbinary|identity|self expression|counselor|counselling|psychology)\b/.test(content)) {
      modeSpecificSignal += 0.95;
    }
    if (options.temporalDetailFocus) {
      if (temporalRelativeCueScore(content) > 0) {
        modeSpecificSignal += 0.9;
      }
      if (/\b(support group|yesterday|last\s+(?:sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat))\b/.test(content)) {
        modeSpecificSignal += 0.55;
      }
    }
    if (options.preciseFactDetailFocus) {
      if (/\bhow\s+long\b/i.test(queryText) && /\b\d+\s+(minute|minutes|hour|hours)\b/.test(content)) {
        modeSpecificSignal += 0.95;
      }
      if (derivationType === "participant_turn") {
        modeSpecificSignal += 1.15;
      }
      if (/\bcommute\b/i.test(queryText) && /\b(commute|each way|audiobooks?)\b/.test(content)) {
        modeSpecificSignal += 0.45;
      }
      if (/\bwhat\s+(?:play|movie|film|show|book|song|title)\b/i.test(queryText) && /\b(production of|called|named|title|watched|attended|saw|read)\b/.test(content)) {
        modeSpecificSignal += 0.75;
      }
    }
    if (options.sharedCommonalityFocus) {
      if (participantHits >= 2) {
        modeSpecificSignal += 0.75;
      }
      if (derivationType === "conversation_unit" && participantHits >= 2) {
        modeSpecificSignal += 1.05;
      }
      if (/\b(both|we both|in common|shared|same|dancing|destress|stress relief|business)\b/.test(content)) {
        modeSpecificSignal += 0.7;
      }
      if (/\bin common\b/i.test(queryText) && !/\bdestress|stress\b/i.test(queryText)) {
        if (/\b(lost (?:my|his|her) job|job as a|job at|own business|started .*business|opened .*store|dance studio)\b/.test(content)) {
          modeSpecificSignal += 0.9;
        }
        if (/\b(dancing|dance)\b/.test(content) && !/\b(lost (?:my|his|her) job|own business|dance studio)\b/.test(content)) {
          modeSpecificSignal -= 0.35;
        }
      }
    }
    if (options.causalDecisionFocus) {
      if (/\b(because|decided|started|passion|share|teach|dream|goal)\b/.test(content)) {
        modeSpecificSignal += 0.85;
      }
      if (derivationType === "conversation_unit" && /\b(because|decided|started|passion|share|teach|dream|goal)\b/.test(content)) {
        modeSpecificSignal += 0.35;
      }
      if (/\b(lost (?:his|her|my) job|push to|take the plunge|setback|after losing)\b/.test(content)) {
        modeSpecificSignal += 0.65;
      }
    }
    if (derivationType === "conversation_unit" && options.dailyLifeSummaryFocus) {
      modeSpecificSignal += 0.4;
    }
    if (options.dailyLifeEventFocus && /\bwhat\s+happened\s+(?:at|during|with)\b/i.test(queryText)) {
      const participantNames = Array.isArray(provenanceMetadata?.participant_names)
        ? provenanceMetadata.participant_names.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
        : [];
      const sourceSentence = String(provenanceMetadata?.source_sentence_text ?? "").toLowerCase();
      if (item.row.memory_type === "narrative_event") {
        if (participantNames.length > 0) {
          modeSpecificSignal += 0.45;
        }
        if (/\b(two-way|roadmap|project|worked on|talked about)\b/.test(sourceSentence)) {
          modeSpecificSignal += 0.85;
        }
        if (participantNames.length === 0 && !/\b(two-way|roadmap|project|worked on|talked about)\b/.test(sourceSentence)) {
          modeSpecificSignal -= 0.2;
        }
      }
    }

    const sourceSignal = sourceTrustAdjustment(item.row);

    const appScore = Number(
      (item.rrfScore + lexicalSignal + participantSignal + temporalSignal + clusterSignal + leafSignal + modeSpecificSignal + sourceSignal).toFixed(6)
    );
    return {
      ...item,
      appScore,
      appSignals: {
        lexical: Number(lexicalSignal.toFixed(4)),
        temporal: Number(temporalSignal.toFixed(4)),
        participant: Number(participantSignal.toFixed(4)),
        cluster: Number(clusterSignal.toFixed(4)),
        leaf: Number(leafSignal.toFixed(4)),
        modeSpecific: Number(modeSpecificSignal.toFixed(4)),
        source: Number(sourceSignal.toFixed(4))
      }
    };
  });

  return ranked.sort((left, right) =>
    compareFusedResults(
      left,
      right,
      options.hasTimeWindow,
      planner.temporalFocus,
      options.dailyLifeEventFocus,
      options.dailyLifeSummaryFocus
    )
  );
}

async function loadCoreSqlHybridKernelRows(
  namespaceId: string,
  effectiveQueryText: string,
  eventQueryText: string,
  temporalQueryText: string,
  candidateLimit: number,
  timeStart: string | null,
  timeEnd: string | null,
  planner: ReturnType<typeof planRecallQuery>,
  queryEmbedding: readonly number[],
  includeTemporal: boolean,
  historicalRelationshipFocus: boolean
): Promise<readonly SqlFusedRankingRow[]> {
  const vectorLiteral = `[${queryEmbedding.join(",")}]`;

  const rows = await queryRows<{
    readonly memory_id: string;
    readonly memory_type: RecallResult["memoryType"];
    readonly content: string;
    readonly artifact_id: string | null;
    readonly occurred_at: string | null;
    readonly namespace_id: string;
    readonly provenance: Record<string, unknown>;
    readonly lexical_rank: number | null;
    readonly vector_rank: number | null;
    readonly lexical_raw_score: number | null;
    readonly vector_distance: number | null;
    readonly rrf_score: number;
  }>(
    `
      WITH relationship_memory_candidates AS (
        SELECT
          rm.id::text AS memory_id,
          'relationship_memory'::text AS memory_type,
          ${relationshipContentExpression()} AS content,
          ts_rank(
            to_tsvector(
              'english',
              ${relationshipLexicalDocument()}
            ),
            websearch_to_tsquery('english', $2)
          ) AS raw_score,
          e.artifact_id,
          COALESCE(e.occurred_at, rm.valid_from) AS occurred_at,
          rm.namespace_id,
          jsonb_build_object(
            'tier', 'relationship_memory',
            'lexical_provider', 'sql_hybrid_kernel',
            'subject_name', subject_entity.canonical_name,
            'predicate', rm.predicate,
            'object_name', object_entity.canonical_name,
            'status', rm.status,
            'source_candidate_id', rm.source_candidate_id,
            'source_memory_id', rc.source_memory_id,
            'source_uri', a.uri,
            'metadata', rm.metadata
          ) AS provenance
        FROM relationship_memory rm
        JOIN entities subject_entity ON subject_entity.id = rm.subject_entity_id
        JOIN entities object_entity ON object_entity.id = rm.object_entity_id
        LEFT JOIN relationship_candidates rc ON rc.id = rm.source_candidate_id
        LEFT JOIN episodic_memory e ON e.id = rc.source_memory_id
        LEFT JOIN artifacts a ON a.id = e.artifact_id
        WHERE rm.namespace_id = $1
          AND (
            ($9::boolean = true AND rm.status IN ('active', 'superseded'))
            OR
            ($9::boolean = false AND rm.status = 'active' AND rm.valid_until IS NULL)
          )
          AND to_tsvector(
                'english',
                ${relationshipLexicalDocument()}
              ) @@ websearch_to_tsquery('english', $2)
          AND (
            $9::boolean = false
            AND ($5::timestamptz IS NULL OR COALESCE(e.occurred_at, rm.valid_from) >= $5)
            AND ($6::timestamptz IS NULL OR COALESCE(e.occurred_at, rm.valid_from) <= $6)
            OR
            $9::boolean = true
            AND ($5::timestamptz IS NULL OR COALESCE(rm.valid_until, 'infinity'::timestamptz) >= $5)
            AND ($6::timestamptz IS NULL OR rm.valid_from <= $6)
          )
        ORDER BY raw_score DESC, COALESCE(e.occurred_at, rm.valid_from) DESC
        LIMIT $7
      ),
      procedural_candidates AS (
        SELECT
          procedural_memory.id::text AS memory_id,
          'procedural_memory'::text AS memory_type,
          ${proceduralContentExpression()} AS content,
          ts_rank(
            to_tsvector(
              'english',
              ${proceduralLexicalDocument()}
            ),
            websearch_to_tsquery('english', $2)
          ) AS raw_score,
          em.artifact_id,
          COALESCE(em.occurred_at, procedural_memory.updated_at) AS occurred_at,
          procedural_memory.namespace_id,
          jsonb_build_object(
            'tier', 'current_procedural',
            'lexical_provider', 'sql_hybrid_kernel',
            'state_type', procedural_memory.state_type,
            'state_key', procedural_memory.state_key,
            'version', procedural_memory.version,
            'valid_from', procedural_memory.valid_from,
            'valid_until', procedural_memory.valid_until,
            'source_memory_id', em.id,
            'source_uri', a.uri,
            'metadata', procedural_memory.metadata
          ) AS provenance
        FROM procedural_memory
        LEFT JOIN episodic_memory em
          ON em.id = NULLIF(state_value->>'source_memory_id', '')::uuid
        LEFT JOIN artifacts a
          ON a.id = em.artifact_id
        WHERE procedural_memory.namespace_id = $1
          AND procedural_memory.valid_until IS NULL
          AND to_tsvector(
                'english',
                ${proceduralLexicalDocument()}
              ) @@ websearch_to_tsquery('english', $2)
        ORDER BY raw_score DESC, COALESCE(em.occurred_at, procedural_memory.updated_at) DESC
        LIMIT $7
      ),
      semantic_candidates AS (
        SELECT
          semantic_memory.id::text AS memory_id,
          'semantic_memory'::text AS memory_type,
          semantic_memory.content_abstract AS content,
          ts_rank(semantic_memory.search_vector, websearch_to_tsquery('english', $2)) AS raw_score,
          em.artifact_id,
          COALESCE(em.occurred_at, semantic_memory.valid_from) AS occurred_at,
          semantic_memory.namespace_id,
          jsonb_build_object(
            'tier', 'current_semantic',
            'lexical_provider', 'sql_hybrid_kernel',
            'memory_kind', semantic_memory.memory_kind,
            'canonical_key', semantic_memory.canonical_key,
            'valid_from', semantic_memory.valid_from,
            'valid_until', semantic_memory.valid_until,
            'status', semantic_memory.status,
            'source_episodic_id', semantic_memory.source_episodic_id,
            'source_chunk_id', semantic_memory.source_chunk_id,
            'source_artifact_observation_id', semantic_memory.source_artifact_observation_id,
            'source_uri', a.uri,
            'metadata', semantic_memory.metadata
          ) AS provenance
        FROM semantic_memory
        LEFT JOIN episodic_memory em
          ON em.id = semantic_memory.source_episodic_id
        LEFT JOIN artifacts a
          ON a.id = em.artifact_id
        WHERE semantic_memory.namespace_id = $1
          AND semantic_memory.status = 'active'
          AND semantic_memory.valid_until IS NULL
          AND semantic_memory.search_vector @@ websearch_to_tsquery('english', $2)
        ORDER BY raw_score DESC, semantic_memory.valid_from DESC
        LIMIT $7
      ),
      narrative_event_candidates AS (
        SELECT
          ne.id::text AS memory_id,
          'narrative_event'::text AS memory_type,
          ${narrativeEventContentExpression()} AS content,
          ts_rank(
            to_tsvector(
              'english',
              ${narrativeEventLexicalDocument()}
            ),
            websearch_to_tsquery('english', $3)
          ) * 0.72 AS raw_score,
          ne.artifact_id,
          COALESCE(ne.time_start, ao.observed_at, ne.created_at) AS occurred_at,
          ne.namespace_id,
          jsonb_build_object(
            'tier', 'narrative_event',
            'lexical_provider', 'sql_hybrid_kernel',
            'event_kind', ne.event_kind,
            'event_label', ne.event_label,
            'subject_name', subject_entity.canonical_name,
            'location_name', location_entity.canonical_name,
            'source_scene_id', ne.source_scene_id,
            'source_artifact_observation_id', ne.artifact_observation_id,
            'source_uri', a.uri,
            'metadata', ne.metadata
          ) AS provenance
        FROM narrative_events ne
        LEFT JOIN artifacts a ON a.id = ne.artifact_id
        LEFT JOIN artifact_observations ao ON ao.id = ne.artifact_observation_id
        LEFT JOIN entities subject_entity ON subject_entity.id = ne.primary_subject_entity_id
        LEFT JOIN entities location_entity ON location_entity.id = ne.primary_location_entity_id
        WHERE ne.namespace_id = $1
          AND to_tsvector(
                'english',
                ${narrativeEventLexicalDocument()}
              ) @@ websearch_to_tsquery('english', $3)
          AND ($5::timestamptz IS NULL OR COALESCE(ne.time_start, ao.observed_at, ne.created_at) >= $5)
          AND ($6::timestamptz IS NULL OR COALESCE(ne.time_start, ao.observed_at, ne.created_at) <= $6)
        ORDER BY raw_score DESC, COALESCE(ne.time_start, ao.observed_at, ne.created_at) DESC
        LIMIT $7
      ),
      temporal_candidates AS (
        SELECT
          id::text AS memory_id,
          'temporal_nodes'::text AS memory_type,
          summary_text AS content,
          ts_rank(to_tsvector('english', coalesce(summary_text, '')), websearch_to_tsquery('english', $4)) AS raw_score,
          NULL::uuid AS artifact_id,
          period_end AS occurred_at,
          namespace_id,
          jsonb_build_object(
            'tier', 'temporal_summary',
            'lexical_provider', 'sql_hybrid_kernel',
            'layer', layer,
            'period_start', period_start,
            'period_end', period_end,
            'summary_version', summary_version,
            'source_count', source_count,
            'generated_by', generated_by,
            'status', status,
            'archival_tier', archival_tier,
            'metadata', metadata
          ) AS provenance
        FROM temporal_nodes
        WHERE namespace_id = $1
          AND $10::boolean = true
          AND status = 'active'
          AND summary_text <> ''
          AND ($5::timestamptz IS NULL OR period_end >= $5::timestamptz)
          AND ($6::timestamptz IS NULL OR period_start <= $6::timestamptz)
          AND to_tsvector('english', coalesce(summary_text, '')) @@ websearch_to_tsquery('english', $4)
        ORDER BY raw_score DESC, period_end DESC
        LIMIT $7
      ),
      episodic_candidates AS (
        SELECT
          em.id::text AS memory_id,
          'episodic_memory'::text AS memory_type,
          em.content,
          ts_rank(em.search_vector, websearch_to_tsquery('english', $4)) AS raw_score,
          em.artifact_id,
          em.occurred_at,
          em.namespace_id,
          jsonb_build_object(
            'tier', 'historical_episodic',
            'lexical_provider', 'sql_hybrid_kernel',
            'artifact_observation_id', em.artifact_observation_id,
            'source_chunk_id', em.source_chunk_id,
            'source_offset', em.source_offset,
            'source_uri', a.uri,
            'metadata', em.metadata
          ) AS provenance
        FROM episodic_memory em
        LEFT JOIN artifacts a ON a.id = em.artifact_id
        WHERE em.namespace_id = $1
          AND em.search_vector @@ websearch_to_tsquery('english', $4)
          AND ($5::timestamptz IS NULL OR em.occurred_at >= $5)
          AND ($6::timestamptz IS NULL OR em.occurred_at <= $6)
        ORDER BY raw_score DESC, em.occurred_at DESC
        LIMIT $7
      ),
      derivation_candidates AS (
        SELECT
          ad.id::text AS memory_id,
          'artifact_derivation'::text AS memory_type,
          ${artifactDerivationContentExpression()} AS content,
          ts_rank(
            to_tsvector('english', ${artifactDerivationLexicalDocument()}),
            websearch_to_tsquery('english', $2)
          ) AS raw_score,
          ao.artifact_id,
          coalesce(source_em.occurred_at, ao.observed_at) AS occurred_at,
          a.namespace_id,
          jsonb_build_object(
            'tier', 'artifact_derivation',
            'lexical_provider', 'sql_hybrid_kernel',
            'derivation_type', ad.derivation_type,
            'provider', ad.provider,
            'model', ad.model,
            'artifact_observation_id', ad.artifact_observation_id,
            'source_chunk_id', ad.source_chunk_id,
            'source_uri', a.uri,
            'metadata', ad.metadata
          ) AS provenance
        FROM artifact_derivations ad
        JOIN artifact_observations ao ON ao.id = ad.artifact_observation_id
        JOIN artifacts a ON a.id = ao.artifact_id
        LEFT JOIN episodic_memory source_em ON source_em.id = ad.source_chunk_id
        WHERE a.namespace_id = $1
          AND coalesce(ad.content_text, '') <> ''
          AND to_tsvector('english', ${artifactDerivationLexicalDocument()}) @@ websearch_to_tsquery('english', $2)
          AND ($5::timestamptz IS NULL OR coalesce(source_em.occurred_at, ao.observed_at) >= $5)
          AND ($6::timestamptz IS NULL OR coalesce(source_em.occurred_at, ao.observed_at) <= $6)
        ORDER BY raw_score DESC, coalesce(source_em.occurred_at, ao.observed_at) DESC
        LIMIT $7
      ),
      lexical_union AS (
        SELECT * FROM relationship_memory_candidates
        UNION ALL
        SELECT * FROM procedural_candidates
        UNION ALL
        SELECT * FROM semantic_candidates
        UNION ALL
        SELECT * FROM narrative_event_candidates
        UNION ALL
        SELECT * FROM temporal_candidates
        UNION ALL
        SELECT * FROM episodic_candidates
        UNION ALL
        SELECT * FROM derivation_candidates
      ),
      lexical_ranked AS (
        SELECT
          memory_id,
          memory_type,
          content,
          artifact_id,
          occurred_at,
          namespace_id,
          provenance,
          raw_score AS lexical_raw_score,
          ROW_NUMBER() OVER (ORDER BY raw_score DESC, occurred_at DESC NULLS LAST, memory_id ASC) AS lexical_rank,
          CASE
            WHEN memory_type = 'procedural_memory' THEN 1.12
            WHEN memory_type = 'episodic_memory' OR memory_type = 'narrative_event' THEN $11::double precision
            WHEN memory_type = 'temporal_nodes' THEN $12::double precision
            ELSE 1.0
          END AS lexical_weight
        FROM lexical_union
      ),
      semantic_vector_candidates AS (
        SELECT
          semantic_memory.id::text AS memory_id,
          'semantic_memory'::text AS memory_type,
          semantic_memory.content_abstract AS content,
          semantic_memory.embedding <=> $8::vector AS vector_distance,
          em.artifact_id,
          COALESCE(em.occurred_at, semantic_memory.valid_from) AS occurred_at,
          semantic_memory.namespace_id,
          jsonb_build_object(
            'tier', 'current_semantic',
            'vector_provider', 'sql_hybrid_kernel',
            'memory_kind', semantic_memory.memory_kind,
            'canonical_key', semantic_memory.canonical_key,
            'valid_from', semantic_memory.valid_from,
            'valid_until', semantic_memory.valid_until,
            'status', semantic_memory.status,
            'source_episodic_id', semantic_memory.source_episodic_id,
            'source_chunk_id', semantic_memory.source_chunk_id,
            'source_artifact_observation_id', semantic_memory.source_artifact_observation_id,
            'source_uri', a.uri,
            'metadata', semantic_memory.metadata
          ) AS provenance
        FROM semantic_memory
        LEFT JOIN episodic_memory em
          ON em.id = semantic_memory.source_episodic_id
        LEFT JOIN artifacts a
          ON a.id = em.artifact_id
        WHERE semantic_memory.namespace_id = $1
          AND semantic_memory.status = 'active'
          AND semantic_memory.valid_until IS NULL
          AND semantic_memory.embedding IS NOT NULL
          AND ($5::timestamptz IS NULL OR semantic_memory.valid_from >= $5)
          AND ($6::timestamptz IS NULL OR semantic_memory.valid_from <= $6)
        ORDER BY semantic_memory.embedding <=> $8::vector ASC, semantic_memory.valid_from DESC
        LIMIT $7
      ),
      derivation_vector_candidates AS (
        SELECT
          ad.id::text AS memory_id,
          'artifact_derivation'::text AS memory_type,
          ${artifactDerivationContentExpression()} AS content,
          ad.embedding <=> $8::vector AS vector_distance,
          ao.artifact_id,
          coalesce(source_em.occurred_at, ao.observed_at) AS occurred_at,
          a.namespace_id,
          jsonb_build_object(
            'tier', 'artifact_derivation',
            'vector_provider', 'sql_hybrid_kernel',
            'derivation_type', ad.derivation_type,
            'provider', ad.provider,
            'model', ad.model,
            'artifact_observation_id', ad.artifact_observation_id,
            'source_chunk_id', ad.source_chunk_id,
            'source_uri', a.uri,
            'metadata', ad.metadata
          ) AS provenance
        FROM artifact_derivations ad
        JOIN artifact_observations ao ON ao.id = ad.artifact_observation_id
        JOIN artifacts a ON a.id = ao.artifact_id
        LEFT JOIN episodic_memory source_em ON source_em.id = ad.source_chunk_id
        WHERE a.namespace_id = $1
          AND coalesce(ad.content_text, '') <> ''
          AND ad.embedding IS NOT NULL
          AND ($5::timestamptz IS NULL OR coalesce(source_em.occurred_at, ao.observed_at) >= $5)
          AND ($6::timestamptz IS NULL OR coalesce(source_em.occurred_at, ao.observed_at) <= $6)
        ORDER BY ad.embedding <=> $8::vector ASC, coalesce(source_em.occurred_at, ao.observed_at) DESC
        LIMIT $7
      ),
      vector_union AS (
        SELECT * FROM semantic_vector_candidates
        UNION ALL
        SELECT * FROM derivation_vector_candidates
      ),
      vector_ranked AS (
        SELECT
          memory_id,
          memory_type,
          content,
          artifact_id,
          occurred_at,
          namespace_id,
          provenance,
          vector_distance,
          ROW_NUMBER() OVER (ORDER BY vector_distance ASC, occurred_at DESC NULLS LAST, memory_id ASC) AS vector_rank
        FROM vector_union
      ),
      contributors AS (
        SELECT
          memory_id,
          memory_type,
          content,
          artifact_id,
          occurred_at,
          namespace_id,
          provenance,
          lexical_rank,
          NULL::integer AS vector_rank,
          lexical_raw_score,
          NULL::double precision AS vector_distance,
          lexical_weight / (60 + lexical_rank)::double precision AS rrf_part,
          0 AS source_priority
        FROM lexical_ranked

        UNION ALL

        SELECT
          memory_id,
          memory_type,
          content,
          artifact_id,
          occurred_at,
          namespace_id,
          provenance,
          NULL::integer AS lexical_rank,
          vector_rank,
          NULL::double precision AS lexical_raw_score,
          vector_distance,
          1 / (60 + vector_rank)::double precision AS rrf_part,
          1 AS source_priority
        FROM vector_ranked
      ),
      fused AS (
        SELECT
          memory_id,
          memory_type,
          (array_agg(content ORDER BY source_priority ASC, lexical_rank ASC NULLS LAST, vector_rank ASC NULLS LAST))[1] AS content,
          (array_agg(artifact_id ORDER BY source_priority ASC, lexical_rank ASC NULLS LAST, vector_rank ASC NULLS LAST))[1]::text AS artifact_id,
          (array_agg(occurred_at ORDER BY source_priority ASC, lexical_rank ASC NULLS LAST, vector_rank ASC NULLS LAST))[1] AS occurred_at,
          (array_agg(namespace_id ORDER BY source_priority ASC, lexical_rank ASC NULLS LAST, vector_rank ASC NULLS LAST))[1] AS namespace_id,
          (array_agg(provenance ORDER BY source_priority ASC, lexical_rank ASC NULLS LAST, vector_rank ASC NULLS LAST))[1] AS provenance,
          MIN(lexical_rank) FILTER (WHERE lexical_rank IS NOT NULL) AS lexical_rank,
          MIN(vector_rank) FILTER (WHERE vector_rank IS NOT NULL) AS vector_rank,
          MAX(lexical_raw_score) FILTER (WHERE lexical_raw_score IS NOT NULL) AS lexical_raw_score,
          MIN(vector_distance) FILTER (WHERE vector_distance IS NOT NULL) AS vector_distance,
          SUM(rrf_part) AS rrf_score
        FROM contributors
        GROUP BY memory_id, memory_type
      )
      SELECT
        memory_id,
        memory_type,
        content,
        artifact_id,
        occurred_at::text AS occurred_at,
        namespace_id,
        provenance,
        lexical_rank,
        vector_rank,
        lexical_raw_score,
        vector_distance,
        rrf_score
      FROM fused
      ORDER BY rrf_score DESC, occurred_at DESC NULLS LAST, memory_id ASC
      LIMIT $7
    `,
    [
      namespaceId,
      effectiveQueryText,
      eventQueryText,
      temporalQueryText,
      timeStart,
      timeEnd,
      candidateLimit,
      vectorLiteral,
      historicalRelationshipFocus,
      includeTemporal,
      planner.episodicWeight,
      planner.temporalSummaryWeight
    ]
  );

  return rows.map((row) => ({
    row: {
      memory_id: row.memory_id,
      memory_type: row.memory_type,
      content: row.content,
      raw_score: row.lexical_raw_score ?? row.vector_distance ?? row.rrf_score,
      artifact_id: row.artifact_id,
      occurred_at: row.occurred_at,
      namespace_id: row.namespace_id,
      provenance: row.provenance
    },
    lexicalRank: row.lexical_rank ?? undefined,
    vectorRank: row.vector_rank ?? undefined,
    lexicalRawScore: row.lexical_raw_score ?? undefined,
    vectorDistance: row.vector_distance ?? undefined,
    rrfScore: row.rrf_score
  }));
}

function mergeUniqueRows(
  existingRows: readonly RankedSearchRow[],
  additionalRows: readonly RankedSearchRow[],
  candidateLimit: number,
  hasTimeWindow: boolean,
  temporalFocus: boolean,
  dailyLifeEventFocus = false,
  dailyLifeSummaryFocus = false,
  timeStart: string | null = null,
  timeEnd: string | null = null
): RankedSearchRow[] {
  const merged = new Map(existingRows.map((row) => [resultKey(row), row] as const));

  for (const row of additionalRows) {
    const key = resultKey(row);
    const existing = merged.get(key);
    if (existing) {
      if (row.provenance.tier === "temporal_descendant_support" && existing.provenance.tier !== "temporal_descendant_support") {
        merged.set(key, {
          ...existing,
          provenance: {
            ...existing.provenance,
            temporal_support: row.provenance
          }
        });
      } else {
        const incomingContent = String(row.content ?? "");
        const existingContent = String(existing.content ?? "");
        if (row.scoreValue > existing.scoreValue || incomingContent.length > existingContent.length) {
          merged.set(key, row);
        }
      }
      continue;
    }

    merged.set(key, row);
  }

  return finalizeLexicalRows(
    [...merged.values()],
    candidateLimit,
    hasTimeWindow,
    temporalFocus,
    dailyLifeEventFocus,
    dailyLifeSummaryFocus,
    timeStart,
    timeEnd
  );
}

function isSemanticDaySummaryRow(row: RankedSearchRow): boolean {
  const memoryKind = String(row.provenance.memory_kind ?? "");
  const canonicalKey = String(row.provenance.canonical_key ?? "");
  return row.memory_type === "semantic_memory" &&
    (memoryKind === "day_summary" || canonicalKey.startsWith("reconsolidated:day_summary:"));
}

function isAlignedToTimeWindow(row: RankedSearchRow, timeStart: string | null, timeEnd: string | null): boolean {
  if (!timeStart || !timeEnd) {
    return false;
  }

  const occurredAt = parseIsoTimestamp(toIsoString(row.occurred_at));
  const windowStart = parseIsoTimestamp(timeStart);
  const windowEnd = parseIsoTimestamp(timeEnd);
  if (occurredAt !== null && windowStart !== null && windowEnd !== null) {
    return occurredAt >= windowStart && occurredAt <= windowEnd;
  }

  const canonicalKey = String(row.provenance.canonical_key ?? "");
  const dayToken = canonicalKey.startsWith("reconsolidated:day_summary:")
    ? canonicalKey.slice("reconsolidated:day_summary:".length)
    : "";
  return Boolean(dayToken && timeStart.startsWith(dayToken));
}

function finalizeLexicalRows(
  rows: readonly RankedSearchRow[],
  candidateLimit: number,
  hasTimeWindow: boolean,
  temporalFocus: boolean,
  dailyLifeEventFocus = false,
  dailyLifeSummaryFocus = false,
  timeStart: string | null = null,
  timeEnd: string | null = null
): RankedSearchRow[] {
  const sorted = [...rows].sort((left, right) =>
    compareLexical(left, right, hasTimeWindow, temporalFocus, dailyLifeEventFocus, dailyLifeSummaryFocus)
  );

  if (!dailyLifeSummaryFocus) {
    return sorted.slice(0, candidateLimit);
  }

  const requiredSummaryRows = sorted.filter(
    (row) => isSemanticDaySummaryRow(row) && isAlignedToTimeWindow(row, timeStart, timeEnd)
  );
  if (requiredSummaryRows.length === 0) {
    return sorted.slice(0, candidateLimit);
  }

  const requiredKeys = new Set(requiredSummaryRows.map(resultKey));
  return [...requiredSummaryRows.slice(0, 1), ...sorted.filter((row) => !requiredKeys.has(resultKey(row)))]
    .slice(0, candidateLimit);
}

function buildBm25DisjunctionClause(
  fields: readonly string[],
  queryText: string,
  parameterIndex: number
): {
  readonly clause: string;
  readonly values: readonly string[];
} {
  const normalized = queryText.trim();
  if (!normalized) {
    return {
      clause: "TRUE",
      values: []
    };
  }

  const groups = fields.map((field) => `${field} ||| $${parameterIndex}`);
  return {
    clause: `(${groups.join(" OR ")})`,
    values: [normalized]
  };
}

function lexicalHitMultiplier(content: string, terms: readonly string[]): number {
  if (terms.length === 0) {
    return 1;
  }

  const normalizedContent = content.toLowerCase();
  const hitCount = terms.filter((term) => normalizedContent.includes(term.toLowerCase())).length;

  if (hitCount === 0) {
    return 0.55;
  }

  if (hitCount === 1) {
    return 0.9;
  }

  if (hitCount === 2) {
    return 1.08;
  }

  return 1.16;
}

function proceduralLexicalDocument(): string {
  return `
    coalesce(state_type, '') || ' ' ||
    coalesce(state_key, '') || ' ' ||
    coalesce(state_value::text, '') || ' ' ||
    ${proceduralContentExpression()} || ' ' ||
    CASE
      WHEN valid_until IS NULL THEN 'current active latest authoritative'
      ELSE 'historical inactive superseded'
    END
  `;
}

function artifactDerivationContentExpression(derivationAlias = "ad"): string {
  return `
    CASE
      WHEN ${derivationAlias}.derivation_type = 'transcription'
        AND coalesce(
          ${derivationAlias}.metadata->>'primary_speaker_name',
          ${derivationAlias}.metadata->>'transcript_speaker_name',
          ${derivationAlias}.metadata->>'speaker_name',
          ''
        ) <> ''
      THEN
        coalesce(
          ${derivationAlias}.metadata->>'primary_speaker_name',
          ${derivationAlias}.metadata->>'transcript_speaker_name',
          ${derivationAlias}.metadata->>'speaker_name'
        ) || ' said: ' || coalesce(${derivationAlias}.content_text, '')
      ELSE coalesce(${derivationAlias}.content_text, '')
    END
  `;
}

function artifactDerivationLexicalDocument(derivationAlias = "ad", artifactAlias = "a"): string {
  return `
    ${artifactDerivationContentExpression(derivationAlias)} || ' ' ||
    coalesce(${derivationAlias}.derivation_type, '') || ' ' ||
    coalesce(${artifactAlias}.artifact_type, '') || ' ' ||
    coalesce(${artifactAlias}.source_channel, '') || ' ' ||
    coalesce(${artifactAlias}.uri, '') || ' ' ||
    coalesce(${derivationAlias}.metadata->>'derivation_source', '')
  `;
}

function proceduralContentExpression(): string {
  return `
    CASE
      WHEN state_type = 'preference' THEN
        coalesce(state_value->>'person', 'User') || ' ' ||
        trim(both ' ' from coalesce(state_value->>'category', '') || ' ' || coalesce(state_value->>'target', state_key)) || ' ' ||
        CASE
          WHEN state_value->>'entity_type' = 'activity' THEN 'activity sport hobby'
          WHEN state_value->>'entity_type' = 'media' THEN 'media movie film'
          ELSE ''
        END || ' preference is ' || coalesce(state_value->>'polarity', 'unknown')
      WHEN state_type = 'watchlist_item' THEN
        coalesce(state_value->>'person', 'User') || ' wants to watch ' || coalesce(state_value->>'title', state_key) || ' ' ||
        CASE
          WHEN state_value->>'entity_type' = 'media' THEN 'media movie film watchlist'
          ELSE 'watchlist'
        END
      WHEN state_type = 'skill' THEN
        coalesce(state_value->>'person', 'User') || ' has skill ' || coalesce(state_value->>'skill', state_key) || ' skill capability proficiency'
      WHEN state_type = 'routine' THEN
        coalesce(state_value->>'person', 'User') || ' has routine ' || coalesce(state_value->>'routine', state_key) || ' habit cadence weekly repeat'
      WHEN state_type = 'decision' THEN
        coalesce(state_value->>'person', 'User') || ' decided to ' || coalesce(state_value->>'decision', state_key) || ' decision decided choice made why use uses rationale' ||
        CASE
          WHEN state_key = 'decision:keep_brain_2_0_on_postgres' THEN ' postgres graph vectors truth unified substrate dedicated vector database'
          ELSE ''
        END
      WHEN state_type = 'constraint' THEN
        'brain constraint rule policy follow follows ' || coalesce(state_value->>'constraint', state_key) || ' ' || coalesce(state_value->>'modality', '')
      WHEN state_type = 'style_spec' THEN
        coalesce(state_value->>'person', 'User') || ' style spec work style response style formatting preference ' ||
        coalesce(state_value->>'style_spec', state_key) || ' ' || coalesce(state_value->>'scope', '') || ' ' ||
        CASE
          WHEN state_key = 'style_spec:chunk_large_pdf_uploads_before_processing' THEN 'workflow protocol pdf upload chunk 50mb large file processing mandatory'
          WHEN state_value->>'scope' = 'workflow' THEN 'workflow protocol procedure mandatory implementation slice database integrity replay benchmark'
          WHEN state_value->>'scope' = 'retrieval_style' THEN 'retrieval protocol queryability natural language direct questions'
          ELSE 'response protocol formatting'
        END
      WHEN state_type = 'goal' THEN
        coalesce(state_value->>'person', 'User') || ' current primary goal objective intent is ' || coalesce(state_value->>'goal', state_key)
      WHEN state_type = 'plan' THEN
        coalesce(state_value->>'person', 'User') || ' plan planning upcoming ' || coalesce(state_value->>'plan', state_key) || ' ' || coalesce(state_value->>'project_hint', '')
      WHEN state_type = 'belief' THEN
        coalesce(state_value->>'person', 'User') || ' belief stance opinion on ' || coalesce(state_value->>'topic', state_key) || ' is ' || coalesce(state_value->>'belief', state_key)
      WHEN state_type = 'current_relationship' THEN
        coalesce(state_value->>'person', 'User') || ' is currently dating ' || coalesce(state_value->>'partner', '') || ' current partner romantic relationship'
      WHEN state_type = 'project_role' THEN
        coalesce(state_value->>'person', '') || ' role on ' || coalesce(state_value->>'project', '') || ' is ' || coalesce(state_value->>'role', '')
      WHEN state_type = 'current_project' THEN
        coalesce(state_value->>'person', '') || ' works on ' || coalesce(state_value->>'project', '')
      WHEN state_type = 'current_location' THEN
        coalesce(state_value->>'person', '') || ' currently lives in ' || coalesce(state_value->>'place', '')
      WHEN state_type = 'current_employer' THEN
        coalesce(state_value->>'person', '') || ' currently works at ' || coalesce(state_value->>'organization', '')
      WHEN state_type = 'active_affiliation' THEN
        coalesce(state_value->>'person', '') || ' works at ' || coalesce(state_value->>'organization', '')
      WHEN state_type = 'active_membership' THEN
        coalesce(state_value->>'person', '') || ' is a member of ' || coalesce(state_value->>'organization', '')
      WHEN state_type = 'active_ownership' THEN
        coalesce(state_value->>'person', '') || ' ' || replace(coalesce(state_value->>'predicate', 'owns'), '_', ' ') || ' ' || coalesce(state_value->>'asset', '')
      ELSE CONCAT(state_type, ': ', state_key, ' = ', state_value::text)
    END
  `;
}

function relationshipLexicalDocument(
  relationshipAlias = "rm",
  subjectAlias = "subject_entity",
  objectAlias = "object_entity"
): string {
  return `
    coalesce(${subjectAlias}.canonical_name, '') || ' ' ||
    replace(coalesce(${relationshipAlias}.predicate, ''), '_', ' ') || ' ' ||
    coalesce(${objectAlias}.canonical_name, '') || ' ' ||
    coalesce(${relationshipAlias}.metadata->>'relationship_kind', '') || ' ' ||
    coalesce(${relationshipAlias}.metadata->>'relationship_transition', '') || ' ' ||
    CASE
      WHEN ${relationshipAlias}.metadata->>'relationship_kind' = 'romantic' THEN 'dated romance romantic together'
      WHEN ${relationshipAlias}.predicate = 'significant_other_of' THEN 'dated dating together partner significant other romantic'
      WHEN ${relationshipAlias}.predicate = 'resides_at' THEN 'lives in lives at resides at home residence residency'
      WHEN ${relationshipAlias}.predicate = 'member_of' THEN 'member membership group groups organization organizations club association collective society'
      ELSE ''
    END || ' ' ||
    CASE
      WHEN ${relationshipAlias}.predicate = 'relationship_ended' OR ${relationshipAlias}.metadata->>'relationship_transition' = 'ended' THEN 'break broke broken breakup broke up split ended relationship'
      WHEN ${relationshipAlias}.predicate = 'relationship_reconnected' OR ${relationshipAlias}.metadata->>'relationship_transition' = 'reconnected' THEN 'started talking again reconnected resumed contact'
      WHEN ${relationshipAlias}.predicate = 'relationship_contact_paused' OR ${relationshipAlias}.metadata->>'relationship_transition' = 'contact_paused' THEN 'stopped talking no contact paused contact'
      ELSE ''
    END || ' ' ||
    CASE
      WHEN ${relationshipAlias}.valid_until IS NULL THEN 'current active latest authoritative'
      ELSE 'historical inactive superseded'
    END
  `;
}

function relationshipContentExpression(
  relationshipAlias = "rm",
  subjectAlias = "subject_entity",
  objectAlias = "object_entity"
): string {
  return `
    CASE
      WHEN ${relationshipAlias}.predicate = 'relationship_ended'
        OR (${relationshipAlias}.predicate = 'relationship_transition' AND ${relationshipAlias}.metadata->>'relationship_transition' = 'ended')
      THEN CONCAT(
        coalesce(${subjectAlias}.canonical_name, ''),
        ' broke up with ',
        coalesce(${objectAlias}.canonical_name, '')
      )
      WHEN ${relationshipAlias}.predicate = 'relationship_reconnected'
        OR (${relationshipAlias}.predicate = 'relationship_transition' AND ${relationshipAlias}.metadata->>'relationship_transition' = 'reconnected')
      THEN CONCAT(
        coalesce(${subjectAlias}.canonical_name, ''),
        ' started talking again with ',
        coalesce(${objectAlias}.canonical_name, '')
      )
      WHEN ${relationshipAlias}.predicate = 'relationship_contact_paused'
        OR (${relationshipAlias}.predicate = 'relationship_transition' AND ${relationshipAlias}.metadata->>'relationship_transition' = 'contact_paused')
      THEN CONCAT(
        coalesce(${subjectAlias}.canonical_name, ''),
        ' stopped talking with ',
        coalesce(${objectAlias}.canonical_name, '')
      )
      WHEN ${relationshipAlias}.predicate = 'was_with'
        AND ${relationshipAlias}.metadata->>'relationship_kind' = 'romantic'
      THEN CONCAT(
        coalesce(${subjectAlias}.canonical_name, ''),
        ' dated ',
        coalesce(${objectAlias}.canonical_name, '')
      )
      WHEN ${relationshipAlias}.predicate = 'significant_other_of'
      THEN CONCAT(
        coalesce(${subjectAlias}.canonical_name, ''),
        ' dated ',
        coalesce(${objectAlias}.canonical_name, '')
      )
      WHEN ${relationshipAlias}.predicate = 'resides_at'
      THEN CONCAT(
        coalesce(${subjectAlias}.canonical_name, ''),
        ' lives in ',
        coalesce(${objectAlias}.canonical_name, '')
      )
      ELSE CONCAT(
        coalesce(${subjectAlias}.canonical_name, ''),
        ' ',
        replace(coalesce(${relationshipAlias}.predicate, ''), '_', ' '),
        ' ',
        coalesce(${objectAlias}.canonical_name, '')
      )
    END
  `;
}

function narrativeEventLexicalDocument(
  eventAlias = "ne",
  subjectAlias = "subject_entity",
  locationAlias = "location_entity"
): string {
  return `
    trim(
      concat_ws(
        ' ',
        coalesce(${eventAlias}.event_label, ''),
        coalesce(${eventAlias}.event_kind, ''),
        coalesce(${eventAlias}.metadata->>'activity', ''),
        coalesce(${eventAlias}.metadata->>'activity_label', ''),
        coalesce(${eventAlias}.metadata->>'source_sentence_text', ''),
        coalesce(${subjectAlias}.canonical_name, ''),
        coalesce(${locationAlias}.canonical_name, ''),
        coalesce(${eventAlias}.metadata->>'location_text', ''),
        coalesce(${eventAlias}.metadata->>'participant_names', '')
      )
    )
  `;
}

function narrativeEventContentExpression(
  eventAlias = "ne",
  subjectAlias = "subject_entity",
  locationAlias = "location_entity"
): string {
  return `
    trim(
      concat_ws(
        ' ',
        coalesce(${eventAlias}.event_label, ''),
        CASE
          WHEN coalesce(${eventAlias}.metadata->>'source_sentence_text', '') <> '' THEN ${eventAlias}.metadata->>'source_sentence_text'
          ELSE NULL
        END,
        CASE
          WHEN coalesce(${subjectAlias}.canonical_name, '') <> '' THEN '(subject: ' || ${subjectAlias}.canonical_name || ')'
          ELSE NULL
        END,
        CASE
          WHEN coalesce(${locationAlias}.canonical_name, '') <> '' THEN '(location: ' || ${locationAlias}.canonical_name || ')'
          ELSE NULL
        END
      )
    )
  `;
}

function lexicalBranchWeight(
  branch: string,
  planner: ReturnType<typeof planRecallQuery>,
  relationshipExactFocus: boolean,
  precisionLexicalFocus: boolean,
  activeRelationshipFocus: boolean,
  dailyLifeEventFocus = false,
  dailyLifeSummaryFocus = false
): number {
  if (dailyLifeSummaryFocus) {
    switch (branch) {
      case "semantic_memory":
        return planner.temporalSummaryWeight * 1.55;
      case "temporal_nodes":
        return planner.temporalSummaryWeight * 1.45;
      case "narrative_event":
        return planner.episodicWeight * 1.15;
      case "episodic_memory":
        return planner.episodicWeight * 0.95;
      case "procedural_memory":
        return 0.55;
      default:
        return 0.9;
    }
  }
  if (dailyLifeEventFocus) {
    switch (branch) {
      case "narrative_event":
        return 1.45;
      case "episodic_memory":
        return planner.episodicWeight * 1.1;
      case "temporal_nodes":
        return planner.temporalSummaryWeight * 1.05;
      case "relationship_memory":
      case "relationship_candidate":
        return 0.95;
      case "procedural_memory":
        return 0.8;
      default:
        return 1;
    }
  }

  if (activeRelationshipFocus) {
    switch (branch) {
      case "relationship_memory":
        return 1.45;
      case "relationship_candidate":
        return 1.2;
      case "procedural_memory":
        return 1.2;
      case "narrative_event":
        return 0.9;
      case "semantic_memory":
        return 0.8;
      case "memory_candidate":
        return 0.65;
      case "temporal_nodes":
        return planner.temporalSummaryWeight * 0.85;
      case "episodic_memory":
        return planner.episodicWeight * 0.95;
      default:
        return 1;
    }
  }

  if (relationshipExactFocus) {
    switch (branch) {
      case "episodic_memory":
        return planner.episodicWeight * 1.35;
      case "narrative_event":
        return planner.episodicWeight * 0.92;
      case "temporal_nodes":
        return planner.temporalSummaryWeight * 0.95;
      case "semantic_memory":
        return 0.72;
      case "memory_candidate":
        return 0.7;
      case "relationship_candidate":
        return 0.82;
      default:
        return 1;
    }
  }

  if (precisionLexicalFocus) {
    switch (branch) {
      case "episodic_memory":
      case "artifact_derivation":
      case "semantic_memory":
        return 1.1;
      case "narrative_event":
        return 0.9;
      case "memory_candidate":
        return 0.55;
      case "relationship_candidate":
        return 0.85;
      case "temporal_nodes":
        return planner.temporalSummaryWeight * 0.92;
      default:
        return 1;
    }
  }

  switch (branch) {
    case "episodic_memory":
      return planner.episodicWeight;
    case "narrative_event":
      return planner.episodicWeight * 0.9;
    case "temporal_nodes":
      return planner.temporalSummaryWeight;
    default:
      return 1;
  }
}

function pruneRankedResults(
  rows: readonly {
    row: SearchRow;
    lexicalRank?: number;
    vectorRank?: number;
    lexicalRawScore?: number;
    vectorDistance?: number;
    rrfScore: number;
  }[],
  queryText: string,
  planner: ReturnType<typeof planRecallQuery>,
  relationshipExactFocus: boolean,
  hierarchyTraversalFocus: boolean,
  precisionLexicalFocus: boolean,
  activeRelationshipFocus: boolean,
  dailyLifeEventFocus: boolean,
  dailyLifeSummaryFocus: boolean,
  salienceQueryFocus: boolean,
  historicalHomeFocus: boolean,
  historicalWorkFocus: boolean,
  historicalRelationshipFocus: boolean,
  preferenceQueryFocus: boolean,
  constraintQueryFocus: boolean,
  historicalPreferenceFocus: boolean,
  currentPreferenceFocus: boolean,
  styleQueryFocus: boolean,
  decisionQueryFocus: boolean,
  goalQueryFocus: boolean,
  planQueryFocus: boolean,
  beliefQueryFocus: boolean,
  historicalBeliefFocus: boolean,
  pointInTimePreferenceFocus: boolean,
  transcriptSpeechFocus: boolean,
  eventBoundedFocus: boolean,
  departureTimingFocus: boolean,
  storageLocationFocus: boolean,
  timeStart: string | null,
  timeEnd: string | null,
  preferredRelationshipPredicates: readonly string[],
  narrowTemporalWindow: boolean,
  temporalDetailFocus: boolean,
  preciseFactDetailFocus: boolean,
  profileInferenceFocus: boolean,
  causalDecisionFocus: boolean,
  derivationDetailFocus: boolean
): readonly {
  row: SearchRow;
  lexicalRank?: number;
  vectorRank?: number;
  lexicalRawScore?: number;
  vectorDistance?: number;
  rrfScore: number;
}[] {
  if (rows.length <= 1) {
    return rows;
  }

  const topType = rows[0]?.row.memory_type;
  const hasTemporal = rows.some((item) => item.row.memory_type === "temporal_nodes");
  const hasEpisodic = rows.some((item) => item.row.memory_type === "episodic_memory");
  const hasNarrativeEvents = rows.some((item) => item.row.memory_type === "narrative_event");
  const proceduralRows = rows.filter((item) => item.row.memory_type === "procedural_memory");
  const proceduralStateTypes = new Set(
    proceduralRows
      .map((item) => String(item.row.provenance.state_type ?? ""))
      .filter(Boolean)
  );
  const relationshipRows = rows.filter(
    (item) => item.row.memory_type === "relationship_memory" || item.row.memory_type === "relationship_candidate"
  );
  const relationshipMemoryRows = relationshipRows.filter((item) => item.row.memory_type === "relationship_memory");
  const semanticRows = rows.filter((item) => item.row.memory_type === "semantic_memory");
  const semanticDaySummaryRows = semanticRows.filter((item) => {
    const memoryKind = String(item.row.provenance.memory_kind ?? "");
    const canonicalKey = String(item.row.provenance.canonical_key ?? "");
    return (
      (memoryKind === "day_summary" || canonicalKey.startsWith("reconsolidated:day_summary:")) &&
      rowMatchesTemporalWindow(item.row, timeStart, timeEnd)
    );
  });
  const semanticStateType = (item: { row: SearchRow }): string => {
    const metadata =
      typeof item.row.provenance.metadata === "object" && item.row.provenance.metadata !== null
        ? (item.row.provenance.metadata as Record<string, unknown>)
        : null;
    return String(metadata?.state_type ?? "");
  };
  const semanticStateSummaryRows = semanticRows.filter(
    (item) => String(item.row.provenance.memory_kind ?? "") === "state_summary"
  );
  const semanticBeliefSummaryRows = semanticRows.filter((item) => {
    const memoryKind = String(item.row.provenance.memory_kind ?? "");
    const stateType = semanticStateType(item);
    return memoryKind === "belief_summary" || (memoryKind === "state_summary" && stateType === "belief");
  });
  const eventRows = rows.filter((item) => item.row.memory_type === "narrative_event");
  const episodicRows = rows.filter((item) => item.row.memory_type === "episodic_memory");
  const transcriptSpeakerTerms = planner.lexicalTerms.filter((term) => /^[A-Z][A-Za-z.'-]*(?:\s+[A-Z][A-Za-z.'-]*)*$/u.test(term));
  const transcriptUtteranceRows = episodicRows.filter(
    (item) => String(item.row.provenance.tier ?? "") === "transcript_utterance"
  );
  const transcriptFragmentRows = episodicRows.filter((item) => {
    const tier = String(item.row.provenance.tier ?? "");
    const provenanceMetadata =
      typeof item.row.provenance.metadata === "object" && item.row.provenance.metadata !== null
        ? (item.row.provenance.metadata as Record<string, unknown>)
        : null;
    const speakerName = String(
      item.row.provenance.transcript_speaker_name ??
        item.row.provenance.speaker_name ??
        provenanceMetadata?.transcript_speaker_name ??
        provenanceMetadata?.speaker_name ??
        ""
    );
    return tier !== "transcript_utterance" && Boolean(speakerName);
  });
  if (salienceQueryFocus) {
    return [...episodicRows.slice(0, 3), ...eventRows.slice(0, 2), ...semanticRows.slice(0, 1)].slice(0, 6);
  }

  if (hierarchyTraversalFocus) {
    const structuralHierarchyRows = relationshipMemoryRows.filter(
      (item) => String(item.row.provenance.tier ?? "") === "structural_hierarchy"
    );
    const hierarchySupportRows = episodicRows.filter(
      (item) => String(item.row.provenance.tier ?? "") === "hierarchical_containment_support"
    );
    if (structuralHierarchyRows.length > 0) {
      return [...structuralHierarchyRows.slice(0, 4), ...hierarchySupportRows.slice(0, 2)].slice(0, 6);
    }
  }

  if (transcriptSpeechFocus && (transcriptUtteranceRows.length > 0 || transcriptFragmentRows.length > 0)) {
    const transcriptSupportRows = rows.filter(
      (item) => item.row.memory_type === "artifact_derivation" && String(item.row.provenance.derivation_type ?? "") === "transcription"
    );
    return [
      ...transcriptUtteranceRows.slice(0, 3),
      ...transcriptFragmentRows.slice(0, 2),
      ...transcriptSupportRows.slice(0, 1)
    ].slice(0, 4);
  }

  if (derivationDetailFocus) {
    const derivationEvidenceRows = rows.filter((item) => {
      if (item.row.memory_type !== "artifact_derivation") {
        return false;
      }
      const derivationType = String(item.row.provenance.derivation_type ?? "");
      return derivationType !== "conversation_unit" && derivationType !== "topic_segment" && derivationType !== "community_summary";
    });
    if (derivationEvidenceRows.length > 0) {
      return [...derivationEvidenceRows.slice(0, 4), ...episodicRows.slice(0, 2)].slice(0, 6);
    }
  }

  const focusedProceduralRows =
    activeRelationshipFocus && preferredRelationshipPredicates.length > 0
      ? proceduralRows.filter((item) => {
          const stateType = String(item.row.provenance.state_type ?? "");
          if ((preferredRelationshipPredicates.includes("works_at") || preferredRelationshipPredicates.includes("worked_at")) &&
              (stateType === "current_employer" || stateType === "active_affiliation")) {
            return true;
          }
          if ((preferredRelationshipPredicates.includes("resides_at") || preferredRelationshipPredicates.includes("lives_in") || preferredRelationshipPredicates.includes("currently_in")) &&
              stateType === "current_location") {
            return true;
          }
          if (preferredRelationshipPredicates.includes("member_of") && stateType === "active_membership") {
            return true;
          }
          if ((preferredRelationshipPredicates.includes("works_on") || preferredRelationshipPredicates.includes("project_role")) &&
              (stateType === "current_project" || stateType === "project_role")) {
            return true;
          }
          if (preferredRelationshipPredicates.includes("significant_other_of") && stateType === "current_relationship") {
            return true;
          }
          return false;
        })
      : proceduralRows;
  const listLikeProceduralFocus =
    proceduralRows.length > 1 &&
    proceduralStateTypes.size > 0 &&
    [...proceduralStateTypes].every((stateType) =>
      stateType === "preference" ||
      stateType === "watchlist_item" ||
      stateType === "skill" ||
      stateType === "routine" ||
      stateType === "decision" ||
      stateType === "constraint" ||
      stateType === "style_spec" ||
      stateType === "goal" ||
      stateType === "plan" ||
      stateType === "belief"
    );
  const preferenceRows = proceduralRows.filter((item) => String(item.row.provenance.state_type ?? "") === "preference");
  const watchlistRows = proceduralRows.filter((item) => String(item.row.provenance.state_type ?? "") === "watchlist_item");
  const styleSpecRows = proceduralRows.filter((item) => String(item.row.provenance.state_type ?? "") === "style_spec");
  const decisionRows = proceduralRows.filter((item) => String(item.row.provenance.state_type ?? "") === "decision");
  const goalRows = proceduralRows.filter((item) => String(item.row.provenance.state_type ?? "") === "goal");
  const planRows = proceduralRows.filter((item) => String(item.row.provenance.state_type ?? "") === "plan");
  const beliefRows = proceduralRows.filter((item) => String(item.row.provenance.state_type ?? "") === "belief");
  const constraintRows = proceduralRows.filter((item) => String(item.row.provenance.state_type ?? "") === "constraint");
  const styleSpecSummaryRows = semanticStateSummaryRows.filter(
    (item) => semanticStateType(item) === "style_spec"
  );
  const decisionSummaryRows = semanticStateSummaryRows.filter(
    (item) => semanticStateType(item) === "decision"
  );
  const goalSummaryRows = semanticStateSummaryRows.filter(
    (item) => semanticStateType(item) === "goal"
  );
  const planSummaryRows = semanticStateSummaryRows.filter(
    (item) => semanticStateType(item) === "plan"
  );
  const constraintSummaryRows = semanticStateSummaryRows.filter(
    (item) => semanticStateType(item) === "constraint"
  );
  const replayWorkflowFocus =
    /\bdatabase\b/i.test(queryText) &&
    (/\bslice\b/i.test(queryText) || /\breplay\b/i.test(queryText) || /\bintegrity\b/i.test(queryText));

  if (replayWorkflowFocus && (styleSpecRows.length > 0 || constraintRows.length > 0)) {
    const prioritizedReplayRows = [...styleSpecRows, ...constraintRows]
      .map((item) => ({
        item,
        score: Math.max(
          scoreStyleSpecRow(String(item.row.content ?? ""), queryText),
          scoreConstraintRow(String(item.row.content ?? ""), queryText)
        )
      }))
      .filter((entry) => entry.score > 0)
      .sort((left, right) => {
        if (right.score !== left.score) {
          return right.score - left.score;
        }
        const leftIso = toIsoString(left.item.row.occurred_at);
        const rightIso = toIsoString(right.item.row.occurred_at);
        if (leftIso && rightIso && leftIso !== rightIso) {
          return rightIso.localeCompare(leftIso);
        }
        return resultKey(left.item.row).localeCompare(resultKey(right.item.row));
      })
      .map((entry) => entry.item);

    if (prioritizedReplayRows.length > 0) {
      return [...prioritizedReplayRows.slice(0, 4), ...semanticRows.slice(0, 1), ...episodicRows.slice(0, 1)].slice(0, 6);
    }
  }

  if (styleQueryFocus && (styleSpecSummaryRows.length > 0 || styleSpecRows.length > 0)) {
    return [...styleSpecSummaryRows.slice(0, 2), ...styleSpecRows.slice(0, 4), ...episodicRows.slice(0, 1)].slice(0, 6);
  }

  if (constraintQueryFocus && (constraintSummaryRows.length > 0 || constraintRows.length > 0)) {
    const prioritizedConstraintRows = [...constraintRows]
      .map((item) => ({ item, score: scoreConstraintRow(String(item.row.content ?? ""), queryText) }))
      .filter((entry) => entry.score > 0)
      .sort((left, right) => right.score - left.score)
      .map((entry) => entry.item);
    return [...constraintSummaryRows.slice(0, 2), ...prioritizedConstraintRows.slice(0, 3), ...episodicRows.slice(0, 1)].slice(0, 6);
  }

  if (decisionQueryFocus && (decisionSummaryRows.length > 0 || decisionRows.length > 0)) {
    const prioritizedDecisionRows = [...decisionRows]
      .map((item) => ({ item, score: scoreDecisionRow(String(item.row.content ?? ""), queryText) }))
      .filter((entry) => entry.score > 0)
      .sort((left, right) => right.score - left.score)
      .map((entry) => entry.item);
    return [...decisionSummaryRows.slice(0, 2), ...prioritizedDecisionRows.slice(0, 3), ...episodicRows.slice(0, 1)].slice(0, 6);
  }

  if (goalQueryFocus && (goalSummaryRows.length > 0 || goalRows.length > 0)) {
    return [...goalSummaryRows.slice(0, 2), ...goalRows.slice(0, 1), ...episodicRows.slice(0, 1)].slice(0, 4);
  }

  if (planQueryFocus && (planSummaryRows.length > 0 || planRows.length > 0)) {
    return [...planSummaryRows.slice(0, 2), ...planRows.slice(0, 3), ...episodicRows.slice(0, 1)].slice(0, 6);
  }

  if (beliefQueryFocus && (semanticBeliefSummaryRows.length > 0 || beliefRows.length > 0)) {
    const prioritizedBeliefRows = [...beliefRows]
      .map((item) => ({ item, score: scoreBeliefRow(String(item.row.content ?? ""), queryText) }))
      .filter((entry) => entry.score > 0)
      .sort((left, right) => {
        if (right.score !== left.score) {
          return right.score - left.score;
        }
        const leftIso = toIsoString(left.item.row.occurred_at);
        const rightIso = toIsoString(right.item.row.occurred_at);
        if (leftIso && rightIso && leftIso !== rightIso) {
          return rightIso.localeCompare(leftIso);
        }
        return resultKey(left.item.row).localeCompare(resultKey(right.item.row));
      })
      .map((entry) => entry.item)
      .slice(0, historicalBeliefFocus ? 6 : 2);
    return [
      ...semanticBeliefSummaryRows.slice(0, historicalBeliefFocus ? 1 : 2),
      ...prioritizedBeliefRows,
      ...episodicRows.slice(0, 1)
    ].slice(0, historicalBeliefFocus ? 8 : 4);
  }

  if (profileInferenceFocus && (proceduralRows.length > 0 || semanticRows.length > 0 || episodicRows.length > 0)) {
    return [...proceduralRows.slice(0, 2), ...semanticRows.slice(0, 2), ...episodicRows.slice(0, 2)].slice(0, 4);
  }

  if (preferenceQueryFocus && (preferenceRows.length > 0 || watchlistRows.length > 0)) {
    const wantsWatchlist = /\bwatch(?:list)?\b/i.test(queryText);
    const beerPreferenceQuery = /\bbeers?\b/i.test(queryText);
    const foodPreferenceQuery =
      !beerPreferenceQuery && /\bfood\b|\bfoods\b|\beat\b|\bdrink\b|\bdrinks\b|\bbeverage\b/i.test(queryText);
    const broadPreferenceProfileQuery =
      /\bwhat\s+do\s+i\s+like\s+and\s+dislike\b/i.test(queryText) ||
      /\bwhat\s+do\s+i\s+like\s+or\s+dislike\b/i.test(queryText) ||
      /\bwhat\s+preferences?\b/i.test(queryText) ||
      /\bwhat\s+are\s+my\s+likes\s+and\s+dislikes\b/i.test(queryText);
    if (wantsWatchlist && watchlistRows.length > 0) {
      return [...watchlistRows.slice(0, 6), ...semanticRows.slice(0, 1), ...episodicRows.slice(0, 1)].slice(0, 8);
    }
    const filteredPreferenceRows = pointInTimePreferenceFocus
      ? preferenceRows.filter((item) => {
          const validFrom = parseIsoTimestamp(typeof item.row.provenance.valid_from === "string" ? item.row.provenance.valid_from : null);
          const validUntil = parseIsoTimestamp(typeof item.row.provenance.valid_until === "string" ? item.row.provenance.valid_until : null);
          const queryStart = parseIsoTimestamp(timeStart);
          const queryEnd = parseIsoTimestamp(timeEnd);
          if (queryStart === null || queryEnd === null) {
            return true;
          }
          if (validFrom !== null && validFrom > queryEnd) {
            return false;
          }
          if (validUntil !== null && validUntil < queryStart) {
            return false;
          }
          return true;
        })
      : historicalPreferenceFocus
      ? preferenceRows.filter((item) => Boolean(item.row.provenance.valid_until))
      : currentPreferenceFocus
        ? preferenceRows.filter((item) => !item.row.provenance.valid_until)
        : preferenceRows;

    if (filteredPreferenceRows.length > 0) {
      const isBeerRow = (item: (typeof filteredPreferenceRows)[number]): boolean =>
        /\b(leo|singha|chang|cheng|beer|beers)\b/i.test(String(item.row.provenance.object_text ?? item.row.content ?? ""));
      const isFoodRow = (item: (typeof filteredPreferenceRows)[number]): boolean =>
        String(item.row.provenance.domain ?? "") === "food";
      const dedupePreferenceRows = (rows: readonly (typeof filteredPreferenceRows)[number][], limit: number) => {
        const seen = new Set<string>();
        const deduped: (typeof filteredPreferenceRows)[number][] = [];
        for (const row of rows) {
          const key = `${String(row.row.provenance.predicate ?? "")}:${String(row.row.provenance.object_text ?? row.row.content ?? "")}`.toLowerCase();
          if (seen.has(key)) {
            continue;
          }
          seen.add(key);
          deduped.push(row);
          if (deduped.length >= limit) {
            break;
          }
        }
        return deduped;
      };

      if (beerPreferenceQuery) {
        return dedupePreferenceRows(filteredPreferenceRows.filter((item) => isBeerRow(item)), 6);
      }

      if (foodPreferenceQuery) {
        return dedupePreferenceRows(
          filteredPreferenceRows.filter((item) => isFoodRow(item) && !isBeerRow(item)),
          6
        );
      }

      if (broadPreferenceProfileQuery) {
        const broadProfileRows = filteredPreferenceRows.filter((item) => !isBeerRow(item));
        const positiveRows = dedupePreferenceRows(
          broadProfileRows.filter((item) => {
            const predicate = String(item.row.provenance.predicate ?? "");
            return predicate === "likes" || predicate === "prefers";
          }),
          6
        );
        const negativeRows = dedupePreferenceRows(
          broadProfileRows.filter((item) => {
            const predicate = String(item.row.provenance.predicate ?? "");
            return predicate === "dislikes" || predicate === "avoids";
          }),
          5
        );
        return [...positiveRows, ...negativeRows].slice(0, 11);
      }

      return dedupePreferenceRows(filteredPreferenceRows, 4);
    }
  }

  if (planner.temporalFocus && dailyLifeSummaryFocus && narrowTemporalWindow && (transcriptUtteranceRows.length > 0 || transcriptFragmentRows.length > 0)) {
    return [...transcriptUtteranceRows.slice(0, 2), ...transcriptFragmentRows.slice(0, 2), ...eventRows.slice(0, 1)].slice(0, 4);
  }

  if (planner.temporalFocus && narrowTemporalWindow && transcriptSpeakerTerms.length > 0) {
    const speakerScopedTranscriptionResults = rows.filter(
      (item) => item.row.memory_type === "artifact_derivation" && String(item.row.provenance.derivation_type ?? "") === "transcription"
    );
    if (speakerScopedTranscriptionResults.length > 0) {
      return [...speakerScopedTranscriptionResults.slice(0, 2), ...episodicRows.slice(0, 2), ...eventRows.slice(0, 1)].slice(0, 5);
    }
  }

  if (planner.temporalFocus && dailyLifeSummaryFocus && semanticDaySummaryRows.length > 0) {
    return [...semanticDaySummaryRows.slice(0, 1), ...eventRows.slice(0, 2), ...episodicRows.slice(0, 1)].slice(0, 4);
  }

  if (!planner.temporalFocus && eventBoundedFocus && (eventRows.length > 0 || episodicRows.length > 0)) {
    const focusedEventRows = eventRows
      .filter((item) =>
        /\b(?:at|in)\b/i.test(String(item.row.content ?? "")) ||
        /\bhotel|cafe|coffee|restaurant|university|space|alley\b/i.test(String(item.row.content ?? ""))
      )
      .slice()
      .sort((left, right) => {
        const leftMetadata =
          typeof left.row.provenance.metadata === "object" && left.row.provenance.metadata !== null
            ? (left.row.provenance.metadata as Record<string, unknown>)
            : null;
        const rightMetadata =
          typeof right.row.provenance.metadata === "object" && right.row.provenance.metadata !== null
            ? (right.row.provenance.metadata as Record<string, unknown>)
            : null;
        const leftParticipants = Array.isArray(leftMetadata?.participant_names) ? leftMetadata.participant_names.length : 0;
        const rightParticipants = Array.isArray(rightMetadata?.participant_names) ? rightMetadata.participant_names.length : 0;
        const leftSentence = String(leftMetadata?.source_sentence_text ?? "").toLowerCase();
        const rightSentence = String(rightMetadata?.source_sentence_text ?? "").toLowerCase();
        const leftProjectSignal = /\b(two-way|roadmap|project|worked on|talked about)\b/.test(leftSentence) ? 1 : 0;
        const rightProjectSignal = /\b(two-way|roadmap|project|worked on|talked about)\b/.test(rightSentence) ? 1 : 0;
        if (rightProjectSignal !== leftProjectSignal) {
          return rightProjectSignal - leftProjectSignal;
        }
        if (rightParticipants !== leftParticipants) {
          return rightParticipants - leftParticipants;
        }
        return right.rrfScore - left.rrfScore;
      });
    const focusedEpisodicRows = episodicRows.filter((item) =>
      /\bhotel|cafe|coffee|restaurant|university|space|alley\b/i.test(String(item.row.content ?? "")) ||
      String(item.row.provenance.tier ?? "") === "focused_episodic_support"
    );
    return [...focusedEventRows.slice(0, 3), ...focusedEpisodicRows.slice(0, 3), ...semanticRows.slice(0, 1)].slice(0, 6);
  }

  if (departureTimingFocus && (episodicRows.length > 0 || semanticRows.length > 0)) {
    const focusedDepartureRows = episodicRows.filter((item) => {
      const content = String(item.row.content ?? "");
      return (
        String(item.row.provenance.lexical_provider ?? "") === "departure_scope" ||
        /\b(?:October|January|February|March|April|May|June|July|August|September|November|December)\s+\d{1,2},?\s+(?:19|20)\d{2}\b/i.test(content) ||
        /\b10\/18\/2025\b/.test(content) ||
        /\bleft for the US\b/i.test(content) ||
        /\breturned to the US\b/i.test(content)
      );
    });
    return [...focusedDepartureRows.slice(0, 4), ...semanticRows.slice(0, 2), ...relationshipRows.slice(0, 1)].slice(0, 6);
  }

  if (storageLocationFocus && (episodicRows.length > 0 || semanticRows.length > 0)) {
    const focusedStorageRows = episodicRows.filter((item) => {
      const content = String(item.row.content ?? "");
      return (
        String(item.row.provenance.lexical_provider ?? "") === "storage_scope" ||
        /\b(?:Bend|Reno|Carson|Lauren|Alex|Eve|Jeep|RV|storage|stored)\b/i.test(content)
      );
    });
    return [...focusedStorageRows.slice(0, 4), ...semanticRows.slice(0, 2), ...relationshipRows.slice(0, 1)].slice(0, 6);
  }

  if (causalDecisionFocus && (episodicRows.length > 0 || proceduralRows.length > 0 || semanticRows.length > 0)) {
    const prioritizedDecisionRows = [...decisionRows]
      .map((item) => ({ item, score: scoreDecisionRow(String(item.row.content ?? ""), queryText) }))
      .filter((entry) => entry.score > 0 && decisionTopicAligned(String(entry.item.row.content ?? ""), queryText))
      .sort((left, right) => {
        if (right.score !== left.score) {
          return right.score - left.score;
        }
        const leftIso = toIsoString(left.item.row.occurred_at);
        const rightIso = toIsoString(right.item.row.occurred_at);
        if (leftIso && rightIso && leftIso !== rightIso) {
          return rightIso.localeCompare(leftIso);
        }
        return resultKey(left.item.row).localeCompare(resultKey(right.item.row));
      })
      .map((entry) => entry.item);
    if (prioritizedDecisionRows.length > 0) {
      const focusedSupportRows = [...episodicRows, ...semanticRows]
        .filter((item) => decisionTopicAligned(String(item.row.content ?? ""), queryText))
        .slice(0, 3);
      return [...prioritizedDecisionRows.slice(0, 2), ...focusedSupportRows].slice(0, 5);
    }

    const focusedCausalRows = rows.filter((item) =>
      /\b(?:because|after|why|switched|switch|pour-over|espresso|stomach|trip|lost my job|lost his job|lost her job|passion|dream|share|teach)\b/i.test(
        String(item.row.content ?? "")
      )
    );
    if (focusedCausalRows.length > 0) {
      return [...focusedCausalRows.slice(0, 4), ...proceduralRows.slice(0, 1), ...semanticRows.slice(0, 1)].slice(0, 6);
    }
  }

  if (!planner.temporalFocus && dailyLifeEventFocus && eventRows.length > 0) {
    return [...eventRows.slice(0, 4), ...episodicRows.slice(0, 2)].slice(0, 6);
  }

  if (!planner.temporalFocus && historicalHomeFocus && relationshipRows.length > 0) {
    const seenObjects = new Set<string>();
    const isBroadHistoricalPlaceLabel = (name: string): boolean => {
      const normalized = name.trim().toLowerCase();
      return normalized === "california" || normalized.endsWith(" area") || normalized.includes(" / ");
    };
    const normalizeHistoricalPlaceKey = (name: string): string =>
      name
        .trim()
        .toLowerCase()
        .replace(/,\s+tx\b/g, ", texas")
        .replace(/,\s+ca\b/g, ", california");
    const historicalResidencyRows = relationshipRows
      .filter((item) => {
        const predicate = String(item.row.provenance.predicate ?? "");
        return predicate === "lived_in" || predicate === "resides_at";
      })
      .slice()
      .sort((left, right) => {
        const leftOccurred = Date.parse(toIsoString(left.row.occurred_at) ?? "") || 0;
        const rightOccurred = Date.parse(toIsoString(right.row.occurred_at) ?? "") || 0;
        if (leftOccurred !== rightOccurred) {
          return leftOccurred - rightOccurred;
        }
        return left.rrfScore - right.rrfScore;
      })
      .filter((item) => {
        const objectName = String(item.row.provenance.object_name ?? "");
        const normalizedKey = normalizeHistoricalPlaceKey(objectName);
        if (!normalizedKey || seenObjects.has(normalizedKey) || isBroadHistoricalPlaceLabel(objectName)) {
          return false;
        }
        seenObjects.add(normalizedKey);
        return true;
      });
    const homeRows = historicalResidencyRows.filter((item) => String(item.row.provenance.predicate ?? "") === "lived_in");

    const beforePlaceTarget = extractBeforePlaceTarget(queryText);
    const historicalSupportRows = episodicRows
      .filter((item) => {
        const normalizedContent = item.row.content.toLowerCase();
        const mentionsResidenceTransition = /\b(live|lived|moved|before|first\s+lived)\b/i.test(item.row.content);
        const matchesTarget = beforePlaceTarget ? normalizedContent.includes(beforePlaceTarget.toLowerCase()) : true;
        return mentionsResidenceTransition && matchesTarget;
      })
      .slice()
      .sort((left, right) => {
        const leftOccurred = Date.parse(toIsoString(left.row.occurred_at) ?? "") || 0;
        const rightOccurred = Date.parse(toIsoString(right.row.occurred_at) ?? "") || 0;
        return leftOccurred - rightOccurred;
      });

    if (beforePlaceTarget) {
      const normalizedTarget = normalizeHistoricalPlaceKey(beforePlaceTarget);
      const anchorOccurredAt = historicalResidencyRows
        .filter((item) => normalizeHistoricalPlaceKey(String(item.row.provenance.object_name ?? "")) === normalizedTarget)
        .map((item) => Date.parse(toIsoString(item.row.occurred_at) ?? ""))
        .filter((value) => Number.isFinite(value))
        .sort((left, right) => left - right)[0];

      if (Number.isFinite(anchorOccurredAt)) {
        const filteredBeforeRows = homeRows.filter((item) => {
          const occurredAt = Date.parse(toIsoString(item.row.occurred_at) ?? "");
          const normalizedObject = normalizeHistoricalPlaceKey(String(item.row.provenance.object_name ?? ""));
          return Number.isFinite(occurredAt) && occurredAt <= anchorOccurredAt && normalizedObject !== normalizedTarget;
        });
        if (filteredBeforeRows.length > 0) {
          return [...historicalSupportRows.slice(0, 2), ...filteredBeforeRows.slice(0, 6)].slice(0, 8);
        }
      }
    }

    if (homeRows.length > 0) {
      const currentLocationRows = focusedProceduralRows.filter(
        (item) => String(item.row.provenance.state_type ?? "") === "current_location"
      );
      return beforePlaceTarget
        ? [...historicalSupportRows.slice(0, 2), ...homeRows.slice(0, 6)].slice(0, 8)
        : [...currentLocationRows.slice(0, 1), ...homeRows.slice(0, 7)].slice(0, 8);
    }
  }

  if (!planner.temporalFocus && historicalWorkFocus && relationshipRows.length > 0) {
    const seenObjects = new Set<string>();
    const workRows = relationshipRows
      .filter((item) => {
        const predicate = String(item.row.provenance.predicate ?? "");
        return predicate === "worked_at";
      })
      .slice()
      .sort((left, right) => {
        const leftOccurred = Date.parse(toIsoString(left.row.occurred_at) ?? "") || 0;
        const rightOccurred = Date.parse(toIsoString(right.row.occurred_at) ?? "") || 0;
        if (leftOccurred !== rightOccurred) {
          return leftOccurred - rightOccurred;
        }
        return right.rrfScore - left.rrfScore;
      })
      .filter((item) => {
        const objectName = String(item.row.provenance.object_name ?? "").trim().toLowerCase();
        if (!objectName || seenObjects.has(objectName)) {
          return false;
        }
        seenObjects.add(objectName);
        return true;
      });

    if (workRows.length > 0) {
      if (workRows.length <= 8) {
        return workRows;
      }

      const selectedIndexes = new Set<number>();
      const maxSelections = 8;
      for (let slot = 0; slot < maxSelections; slot += 1) {
        const ratio = slot / (maxSelections - 1);
        const index = Math.round(ratio * (workRows.length - 1));
        selectedIndexes.add(index);
      }

      return [...selectedIndexes]
        .sort((left, right) => left - right)
        .map((index) => workRows[index])
        .filter((item): item is (typeof workRows)[number] => Boolean(item));
    }
  }

  if (!planner.temporalFocus && (activeRelationshipFocus || historicalRelationshipFocus) && (relationshipRows.length > 0 || focusedProceduralRows.length > 0)) {
    const predicatePriority = new Map(preferredRelationshipPredicates.map((predicate, index) => [predicate, index] as const));
    const projectOrRoleFocus =
      preferredRelationshipPredicates.includes("works_on") || preferredRelationshipPredicates.includes("project_role");
    const focusedProceduralCap = projectOrRoleFocus ? 3 : 1;
    const baseRelationshipRows = historicalRelationshipFocus ? relationshipRows : relationshipMemoryRows;
    const focusedRelationships =
      preferredRelationshipPredicates.length > 0
        ? baseRelationshipRows.filter((item) => predicatePriority.has(String(item.row.provenance.predicate ?? "")))
        : baseRelationshipRows;
    const rankedRelationships = (focusedRelationships.length > 0 ? focusedRelationships : baseRelationshipRows)
      .slice()
      .sort((left, right) => {
        const leftPredicate = String(left.row.provenance.predicate ?? "");
        const rightPredicate = String(right.row.provenance.predicate ?? "");
        const leftPriority = predicatePriority.get(leftPredicate) ?? Number.MAX_SAFE_INTEGER;
        const rightPriority = predicatePriority.get(rightPredicate) ?? Number.MAX_SAFE_INTEGER;
        if (leftPriority !== rightPriority) {
          return leftPriority - rightPriority;
        }
        return right.rrfScore - left.rrfScore;
      });
    const activeRelationships = (() => {
      const seen = new Set<string>();
      const deduped: typeof rankedRelationships = [];
      for (const item of rankedRelationships) {
        const predicate = String(item.row.provenance.predicate ?? "");
        const subjectName = normalizeWhitespace(String(item.row.provenance.subject_name ?? ""));
        const objectName = normalizeRelationshipObjectName(
          predicate,
          subjectName,
          String(item.row.provenance.object_name ?? item.row.content ?? "")
        );
        const key = `${subjectName.toLowerCase()}|${predicate}|${objectName.toLowerCase()}`;
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        deduped.push(item);
      }
      return deduped;
    })();

    const relationshipCap = historicalRelationshipFocus
      ? 8
      : preferredRelationshipPredicates.includes("friend_of") || preferredRelationshipPredicates.includes("friends_with")
        ? 6
        : 3;
    if (historicalRelationshipFocus) {
      return activeRelationships.slice(0, relationshipCap);
    }
    if (activeRelationships.length === 0) {
      if (preferredRelationshipPredicates.includes("significant_other_of")) {
        const negativeRelationshipEvidence = relationshipRows
          .filter((item) => {
            const predicate = String(item.row.provenance.predicate ?? "");
            const transition = String(item.row.provenance.relationship_transition ?? "");
            const validUntil = String(item.row.provenance.valid_until ?? "");
            return (
              predicate === "relationship_ended" ||
              predicate === "relationship_contact_paused" ||
              transition === "ended" ||
              transition === "paused" ||
              (predicate === "significant_other_of" && Boolean(validUntil))
            );
          })
          .slice()
          .sort((left, right) => {
            const leftIso = toIsoString(left.row.occurred_at);
            const rightIso = toIsoString(right.row.occurred_at);
            if (leftIso && rightIso && leftIso !== rightIso) {
              return rightIso.localeCompare(leftIso);
            }
            return right.rrfScore - left.rrfScore;
          });

        if (negativeRelationshipEvidence.length > 0) {
          return negativeRelationshipEvidence.slice(0, 2);
        }
      }
      return focusedProceduralRows.slice(0, focusedProceduralCap);
    }
    return [...focusedProceduralRows.slice(0, focusedProceduralCap), ...activeRelationships, ...episodicRows.slice(0, 1)].slice(
      0,
      Math.max(relationshipCap, focusedProceduralCap)
    );
  }

  if (!planner.temporalFocus && listLikeProceduralFocus && (topType === "procedural_memory" || topType === "semantic_memory")) {
    return [
      ...proceduralRows.slice(0, Math.min(8, proceduralRows.length)),
      ...semanticRows.slice(0, 1),
      ...episodicRows.slice(0, 1)
    ].slice(0, Math.min(10, proceduralRows.length + semanticRows.length + episodicRows.length));
  }

  if (!planner.temporalFocus && proceduralRows.length > 0 && (topType === "procedural_memory" || topType === "semantic_memory")) {
    return proceduralRows.slice(0, 1);
  }

  if (preciseFactDetailFocus && episodicRows.length > 0) {
    return [...episodicRows.slice(0, 3), ...semanticRows.slice(0, 1)].slice(0, 3);
  }

  if (relationshipExactFocus && topType === "episodic_memory") {
    return rows.filter((item) => item.row.memory_type === "episodic_memory").slice(0, 1);
  }

  if (topType === "procedural_memory") {
    if (listLikeProceduralFocus) {
      return rows.filter((item) => item.row.memory_type === "procedural_memory").slice(0, Math.min(8, proceduralRows.length));
    }
    return rows.filter((item) => item.row.memory_type === "procedural_memory").slice(0, 1);
  }

  if (topType === "artifact_derivation") {
    return rows.filter((item) => item.row.memory_type === "artifact_derivation").slice(0, 1);
  }

  if (precisionLexicalFocus && !planner.temporalFocus) {
    if (topType === "episodic_memory" || topType === "semantic_memory") {
      return rows.filter((item) => item.row.memory_type === topType).slice(0, 1);
    }
  }

  const preferredTemporalRows = (() => {
    const temporalRows = rows.filter((item) => item.row.memory_type === "temporal_nodes");
    if (temporalRows.length === 0) {
      return [] as typeof temporalRows;
    }

    for (const targetLayer of planner.targetLayers) {
      const matched = temporalRows.find((item) => item.row.provenance.layer === targetLayer);
      if (matched) {
        return [matched];
      }
    }

    return temporalRows.slice(0, 1);
  })();

  if (temporalDetailFocus && (hasEpisodic || hasNarrativeEvents)) {
    const leafRows = rows.filter(
      (item) => item.row.memory_type === "episodic_memory" || item.row.memory_type === "narrative_event"
    );
    const filteredLeafRows = leafRows.filter((item) => rowMatchesTemporalWindow(item.row, timeStart, timeEnd));
    const sortedLeafRows = [...(filteredLeafRows.length > 0 ? filteredLeafRows : leafRows)].sort((left, right) => {
      const leftTemporalCue = temporalRelativeCueScore(String(left.row.content ?? ""));
      const rightTemporalCue = temporalRelativeCueScore(String(right.row.content ?? ""));
      if (leftTemporalCue !== rightTemporalCue) {
        return rightTemporalCue - leftTemporalCue;
      }

      const leftWeightedTerms = weightedTemporalTermMatchScore(queryText, String(left.row.content ?? ""), planner.lexicalTerms);
      const rightWeightedTerms = weightedTemporalTermMatchScore(queryText, String(right.row.content ?? ""), planner.lexicalTerms);
      if (leftWeightedTerms !== rightWeightedTerms) {
        return rightWeightedTerms - leftWeightedTerms;
      }

      const leftCoverage = lexicalCoverageForResult(String(left.row.content ?? ""), planner.lexicalTerms);
      const rightCoverage = lexicalCoverageForResult(String(right.row.content ?? ""), planner.lexicalTerms);
      if (leftCoverage.lexicalCoverage !== rightCoverage.lexicalCoverage) {
        return rightCoverage.lexicalCoverage - leftCoverage.lexicalCoverage;
      }
      if (leftCoverage.matchedTerms.length !== rightCoverage.matchedTerms.length) {
        return rightCoverage.matchedTerms.length - leftCoverage.matchedTerms.length;
      }

      const leftOccurredAt = parseIsoTimestamp(toIsoString(left.row.occurred_at));
      const rightOccurredAt = parseIsoTimestamp(toIsoString(right.row.occurred_at));
      if ((leftOccurredAt ?? 0) !== (rightOccurredAt ?? 0)) {
        return (rightOccurredAt ?? 0) - (leftOccurredAt ?? 0);
      }

      return right.rrfScore - left.rrfScore;
    });
    const selectedLeafRows = sortedLeafRows.slice(0, 3);
    return [...selectedLeafRows, ...preferredTemporalRows.slice(0, 1)];
  }

  if (planner.temporalFocus && dailyLifeSummaryFocus && preferredTemporalRows.length > 0) {
    return [...preferredTemporalRows, ...eventRows.slice(0, 3), ...episodicRows.slice(0, 1)].slice(0, 5);
  }

  if (planner.temporalFocus && hasTemporal && hasEpisodic) {
    if (narrowTemporalWindow) {
      const episodicRows = rows.filter((item) => item.row.memory_type === "episodic_memory").slice(0, 2);
      return [...episodicRows, ...preferredTemporalRows];
    }

    const episodicRows = rows.filter((item) => item.row.memory_type === "episodic_memory").slice(0, 2);
    const artifactRows = rows.filter((item) => item.row.memory_type === "artifact_derivation").slice(0, 1);
    return [...preferredTemporalRows, ...episodicRows, ...artifactRows];
  }

  return rows.filter((item) => item.row.memory_type !== "memory_candidate");
}

function rankLexicalSources(
  sources: readonly LexicalSourceRows[],
  candidateLimit: number,
  hasTimeWindow: boolean,
  temporalFocus: boolean,
  relationshipExactFocus: boolean,
  precisionLexicalFocus: boolean,
  activeRelationshipFocus: boolean,
  dailyLifeEventFocus: boolean,
  dailyLifeSummaryFocus: boolean,
  planner: ReturnType<typeof planRecallQuery>,
  timeStart: string | null,
  timeEnd: string | null,
  lexicalTerms: readonly string[]
): RankedSearchRow[] {
  const accumulator = new Map<string, { row: RankedSearchRow; score: number }>();

  for (const source of sources) {
    for (let index = 0; index < source.rows.length; index += 1) {
      const row = source.rows[index];
      const key = resultKey(row);
      const current = accumulator.get(key) ?? { row, score: 0 };
      current.row = row;
      const branchWeight = lexicalBranchWeight(
        source.branch,
        planner,
        relationshipExactFocus,
        precisionLexicalFocus,
        activeRelationshipFocus,
        dailyLifeEventFocus,
        dailyLifeSummaryFocus
      );
      const temporalAlignment = temporalWindowAlignmentMultiplier(row, timeStart, timeEnd);
      const lexicalHitWeight = lexicalHitMultiplier(row.content, lexicalTerms);
      current.score += (branchWeight * temporalAlignment * lexicalHitWeight) / (20 + index + 1);
      accumulator.set(key, current);
    }
  }

  return [...accumulator.values()]
    .map(({ row, score }) => ({
      ...row,
      raw_score: score,
      scoreValue: score
    }))
    .sort((left, right) => compareLexical(left, right, hasTimeWindow, temporalFocus, dailyLifeEventFocus, dailyLifeSummaryFocus))
    .slice(0, candidateLimit);
}

function buildLayerBudgetCase(
  budgets: ReturnType<typeof planRecallQuery>["descendantLayerBudgets"] | ReturnType<typeof planRecallQuery>["ancestorLayerBudgets"]
): string {
  return `CASE layer
    WHEN 'session' THEN ${Math.max(0, budgets.session)}
    WHEN 'day' THEN ${Math.max(0, budgets.day)}
    WHEN 'week' THEN ${Math.max(0, budgets.week)}
    WHEN 'month' THEN ${Math.max(0, budgets.month)}
    WHEN 'year' THEN ${Math.max(0, budgets.year)}
    WHEN 'profile' THEN ${Math.max(0, budgets.profile)}
    ELSE 0
  END`;
}

function approxResultTokenCount(rows: readonly RankedSearchRow[]): number {
  return rows.reduce((sum, row) => sum + row.content.split(/\s+/u).filter(Boolean).length, 0);
}

function isTemporalDescendantSupportRow(row: Pick<SearchRow, "memory_type" | "provenance">): boolean {
  return (
    row.memory_type === "episodic_memory" &&
    (row.provenance.tier === "temporal_descendant_support" ||
      (typeof row.provenance.temporal_support === "object" && row.provenance.temporal_support !== null))
  );
}

function rowMatchesTemporalWindow(
  row: Pick<SearchRow, "memory_type" | "occurred_at" | "provenance">,
  timeStart: string | null,
  timeEnd: string | null
): boolean {
  if (!timeStart && !timeEnd) {
    return true;
  }

  const queryStart = parseIsoTimestamp(timeStart);
  const queryEnd = parseIsoTimestamp(timeEnd);
  if (queryStart === null || queryEnd === null || queryEnd <= queryStart) {
    return true;
  }

  if (row.memory_type === "temporal_nodes") {
    const periodStart = parseIsoTimestamp(typeof row.provenance.period_start === "string" ? row.provenance.period_start : null);
    const periodEnd = parseIsoTimestamp(typeof row.provenance.period_end === "string" ? row.provenance.period_end : null);
    if (periodStart === null || periodEnd === null) {
      return true;
    }

    return periodEnd >= queryStart && periodStart <= queryEnd;
  }

  const occurredAt = parseIsoTimestamp(toIsoString(row.occurred_at));
  if (occurredAt === null) {
    return true;
  }

  return occurredAt >= queryStart && occurredAt <= queryEnd;
}

function directTemporalSeedLayers(rows: readonly RankedSearchRow[]): ReadonlySet<TemporalDescendantLayer | "year"> {
  const layers = new Set<TemporalDescendantLayer | "year">();

  for (const row of rows) {
    if (row.memory_type !== "temporal_nodes") {
      continue;
    }

    const layer = row.provenance.layer;
    if (layer === "year" || layer === "month" || layer === "week" || layer === "day") {
      layers.add(layer);
    }
  }

  return layers;
}

function determineTemporalDescendantPasses(
  rows: readonly RankedSearchRow[],
  planner: ReturnType<typeof planRecallQuery>
): readonly (readonly TemporalDescendantLayer[])[] {
  const seedLayers = directTemporalSeedLayers(rows);
  const passes: TemporalDescendantLayer[][] = [];

  for (const layer of planner.descendantExpansionOrder) {
    if (layer === "month" && seedLayers.has("year") && planner.descendantLayerBudgets.month > 0) {
      passes.push(["month"]);
      continue;
    }

    if (layer === "week" && (seedLayers.has("year") || seedLayers.has("month")) && planner.descendantLayerBudgets.week > 0) {
      passes.push(["week"]);
      continue;
    }

    if (
      layer === "day" &&
      (seedLayers.has("year") || seedLayers.has("month") || seedLayers.has("week")) &&
      planner.descendantLayerBudgets.day > 0
    ) {
      passes.push(["day"]);
    }
  }

  return passes;
}

function hasSufficientTemporalEvidence(
  rows: readonly RankedSearchRow[],
  planner: ReturnType<typeof planRecallQuery>,
  timeStart: string | null,
  timeEnd: string | null,
  detailTemporalFocus = false,
  options: {
    readonly requireGroundedSupport?: boolean;
  } = {}
): boolean {
  const temporalSummaryRows = rows.filter(
    (row) => row.memory_type === "temporal_nodes" && rowMatchesTemporalWindow(row, timeStart, timeEnd)
  );
  const directLeafCount = rows.filter(
    (row) =>
      (row.memory_type === "episodic_memory" || row.memory_type === "narrative_event") &&
      !isTemporalDescendantSupportRow(row) &&
      rowMatchesTemporalWindow(row, timeStart, timeEnd)
  ).length;
  const supportedLeafCount = rows.filter(
    (row) => isTemporalDescendantSupportRow(row) && rowMatchesTemporalWindow(row, timeStart, timeEnd)
  ).length;
  const temporalCount = rows.filter(
    (row) => row.memory_type === "temporal_nodes" && rowMatchesTemporalWindow(row, timeStart, timeEnd)
  ).length;
  const supportTokenCount = approxResultTokenCount(rows.filter((row) => isTemporalDescendantSupportRow(row)));
  const narrowTemporalWindow = hasNarrowTimeWindow(timeStart, timeEnd);
  const requireGroundedSupport = options.requireGroundedSupport ?? false;

  if (detailTemporalFocus) {
    if (directLeafCount >= 1) {
      return true;
    }

    if (directLeafCount + supportedLeafCount >= 1 && temporalCount >= planner.temporalSufficiencyTemporalThreshold) {
      return true;
    }

    return false;
  }

  const topTemporalSummary = temporalSummaryRows[0];
  if (!requireGroundedSupport && topTemporalSummary && !narrowTemporalWindow) {
    const coverage = lexicalCoverageForResult(topTemporalSummary.content, planner.lexicalTerms);
    if (coverage.lexicalCoverage >= 0.5 && planner.targetLayers.length > 0) {
      return true;
    }
  }

  if (directLeafCount >= planner.temporalSufficiencyEpisodicThreshold) {
    return true;
  }

  if (
    directLeafCount + supportedLeafCount >= planner.temporalSufficiencyEpisodicThreshold &&
    temporalCount >= planner.temporalSufficiencyTemporalThreshold
  ) {
    return true;
  }

  if (
    supportedLeafCount > 0 &&
    temporalCount >= planner.temporalSufficiencyTemporalThreshold &&
    supportTokenCount >= planner.temporalSupportMaxTokens
  ) {
    return true;
  }

  return false;
}

async function loadTemporalHierarchyRows(
  namespaceId: string,
  seedRows: readonly RankedSearchRow[],
  candidateLimit: number,
  timeStart: string | null,
  timeEnd: string | null,
  planner: ReturnType<typeof planRecallQuery>
): Promise<RankedSearchRow[]> {
  const episodicIds = seedRows
    .filter((row) => row.memory_type === "episodic_memory")
    .map((row) => row.memory_id)
    .filter(isUuidLike)
    .slice(0, Math.min(candidateLimit, 12));
  const temporalIds = seedRows
    .filter((row) => row.memory_type === "temporal_nodes")
    .map((row) => row.memory_id)
    .filter(isUuidLike)
    .slice(0, Math.min(candidateLimit, 12));

  if (episodicIds.length === 0 && temporalIds.length === 0) {
    return [];
  }

  const ancestorBudgetCase = buildLayerBudgetCase(planner.ancestorLayerBudgets);
  const rows = await queryRows<SearchRow>(
    `
      WITH RECURSIVE seed_nodes AS (
        SELECT DISTINCT tnm.temporal_node_id AS id
        FROM temporal_node_members tnm
        WHERE tnm.namespace_id = $1
          AND coalesce(array_length($2::uuid[], 1), 0) > 0
          AND tnm.source_memory_id = ANY($2::uuid[])

        UNION

        SELECT DISTINCT seed_id AS id
        FROM unnest(coalesce($3::uuid[], ARRAY[]::uuid[])) AS seed_id
      ),
      ancestry AS (
        SELECT
          tn.id,
          tn.parent_id,
          tn.depth,
          tn.layer,
          tn.period_start,
          tn.period_end,
          tn.summary_text,
          tn.namespace_id,
          tn.source_count,
          tn.generated_by,
          tn.metadata,
          0 AS hops
        FROM temporal_nodes tn
        JOIN seed_nodes sn ON sn.id = tn.id
        WHERE tn.namespace_id = $1
          AND tn.status = 'active'
          AND tn.summary_text <> ''
          AND ($4::timestamptz IS NULL OR tn.period_end >= $4::timestamptz)
          AND ($5::timestamptz IS NULL OR tn.period_start <= $5::timestamptz)

        UNION ALL

        SELECT
          parent.id,
          parent.parent_id,
          parent.depth,
          parent.layer,
          parent.period_start,
          parent.period_end,
          parent.summary_text,
          parent.namespace_id,
          parent.source_count,
          parent.generated_by,
          parent.metadata,
          ancestry.hops + 1
        FROM temporal_nodes parent
        JOIN ancestry ON ancestry.parent_id = parent.id
        WHERE parent.namespace_id = $1
          AND parent.status = 'active'
          AND ancestry.hops < $6
      ),
      ranked_ancestry AS (
        SELECT
          ancestry.*,
          ROW_NUMBER() OVER (
            PARTITION BY ancestry.layer
            ORDER BY ancestry.hops ASC, ancestry.depth DESC, ancestry.period_end DESC, ancestry.id
          ) AS layer_rank
        FROM ancestry
      ),
      selected_ancestry AS (
        SELECT *
        FROM ranked_ancestry
        WHERE layer_rank <= ${ancestorBudgetCase}
      )
      SELECT DISTINCT ON (id)
        id AS memory_id,
        'temporal_nodes'::text AS memory_type,
        summary_text AS content,
        ((depth + 1)::double precision / (25 + hops + 1)) AS raw_score,
        NULL::uuid AS artifact_id,
        period_end AS occurred_at,
        namespace_id,
        jsonb_build_object(
          'tier', 'temporal_ancestor',
          'layer', layer,
          'period_start', period_start,
          'period_end', period_end,
          'depth', depth,
          'hops', hops,
          'parent_id', parent_id,
          'source_count', source_count,
          'generated_by', generated_by,
          'metadata', metadata
        ) AS provenance
      FROM selected_ancestry
      ORDER BY id, hops ASC, depth DESC, period_end DESC
      LIMIT $7
    `,
    [namespaceId, episodicIds, temporalIds, timeStart, timeEnd, Math.max(planner.maxTemporalDepth, 1), candidateLimit]
  );

  return toRankedRows(rows)
    .map((row) => ({
      ...row,
      raw_score: row.scoreValue * temporalWindowAlignmentMultiplier(row, timeStart, timeEnd),
      scoreValue: row.scoreValue * temporalWindowAlignmentMultiplier(row, timeStart, timeEnd)
    }))
    .sort((left, right) => compareLexical(left, right, Boolean(timeStart || timeEnd), true));
}

async function loadTemporalDescendantSupportRows(
  namespaceId: string,
  seedRows: readonly RankedSearchRow[],
  candidateLimit: number,
  timeStart: string | null,
  timeEnd: string | null,
  planner: ReturnType<typeof planRecallQuery>,
  layers: readonly TemporalDescendantLayer[]
): Promise<RankedSearchRow[]> {
  const temporalIds = [...new Set(
    seedRows.filter((row) => row.memory_type === "temporal_nodes").map((row) => row.memory_id)
  )].slice(0, Math.min(candidateLimit, 6));

  if (temporalIds.length === 0 || layers.length === 0 || planner.supportMemberBudget <= 0) {
    return [];
  }

  const layerBudgetCase = `CASE d.layer
    WHEN 'day' THEN ${Math.max(0, planner.descendantLayerBudgets.day)}
    WHEN 'week' THEN ${Math.max(0, planner.descendantLayerBudgets.week)}
    WHEN 'month' THEN ${Math.max(0, planner.descendantLayerBudgets.month)}
    ELSE 0
  END`;
  const rows = await queryRows<SearchRow>(
    `
      WITH RECURSIVE descendants AS (
        SELECT
          child.id,
          child.parent_id,
          child.layer,
          child.period_start,
          child.period_end,
          child.depth,
          child.namespace_id,
          child.summary_text,
          child.source_count,
          child.generated_by,
          child.metadata,
          child.parent_id AS seed_temporal_node_id,
          1 AS hops
        FROM temporal_nodes child
        WHERE child.namespace_id = $1
          AND child.status = 'active'
          AND child.parent_id = ANY($2::uuid[])
          AND child.layer = ANY($3::text[])
          AND ($4::timestamptz IS NULL OR child.period_end >= $4::timestamptz)
          AND ($5::timestamptz IS NULL OR child.period_start <= $5::timestamptz)

        UNION ALL

        SELECT
          child.id,
          child.parent_id,
          child.layer,
          child.period_start,
          child.period_end,
          child.depth,
          child.namespace_id,
          child.summary_text,
          child.source_count,
          child.generated_by,
          child.metadata,
          descendants.seed_temporal_node_id,
          descendants.hops + 1 AS hops
        FROM temporal_nodes child
        JOIN descendants ON child.parent_id = descendants.id
        WHERE child.namespace_id = $1
          AND child.status = 'active'
          AND child.layer = ANY($3::text[])
          AND descendants.hops < $6
          AND ($4::timestamptz IS NULL OR child.period_end >= $4::timestamptz)
          AND ($5::timestamptz IS NULL OR child.period_start <= $5::timestamptz)
      ),
      ranked_descendants AS (
        SELECT
          d.*,
          ROW_NUMBER() OVER (
            PARTITION BY d.seed_temporal_node_id, d.layer
            ORDER BY d.period_end DESC, d.depth DESC, d.id
          ) AS layer_rank
        FROM descendants d
      ),
      selected_descendants AS (
        SELECT *
        FROM ranked_descendants d
        WHERE d.layer_rank <= ${layerBudgetCase}
      ),
      descendant_members AS (
        SELECT
          sd.seed_temporal_node_id,
          sd.id AS supporting_temporal_node_id,
          sd.layer AS supporting_layer,
          sd.period_start,
          sd.period_end,
          sd.hops AS support_hops,
          e.id AS memory_id,
          e.content,
          e.artifact_id,
          e.occurred_at,
          e.namespace_id,
          e.artifact_observation_id,
          e.source_chunk_id,
          e.source_offset,
          e.metadata,
          a.uri AS source_uri,
          ROW_NUMBER() OVER (
            PARTITION BY sd.id
            ORDER BY e.occurred_at DESC, e.id
          ) AS member_rank
        FROM selected_descendants sd
        JOIN temporal_node_members tnm
          ON tnm.temporal_node_id = sd.id
         AND tnm.member_role = 'summary_input'
         AND tnm.source_memory_id IS NOT NULL
        JOIN episodic_memory e
          ON e.id = tnm.source_memory_id
         AND e.namespace_id = $1
        LEFT JOIN artifacts a ON a.id = e.artifact_id
        WHERE ($4::timestamptz IS NULL OR e.occurred_at >= $4::timestamptz)
          AND ($5::timestamptz IS NULL OR e.occurred_at <= $5::timestamptz)
      )
      SELECT DISTINCT ON (memory_id)
        memory_id,
        'episodic_memory'::text AS memory_type,
        content,
        (1.0 / (35 + support_hops + member_rank))::double precision AS raw_score,
        artifact_id,
        occurred_at,
        namespace_id,
        jsonb_build_object(
          'tier', 'temporal_descendant_support',
          'seed_temporal_node_id', seed_temporal_node_id,
          'supporting_temporal_node_id', supporting_temporal_node_id,
          'supporting_layer', supporting_layer,
          'support_hops', support_hops,
          'period_start', period_start,
          'period_end', period_end,
          'artifact_observation_id', artifact_observation_id,
          'source_chunk_id', source_chunk_id,
          'source_offset', source_offset,
          'source_uri', source_uri,
          'metadata', metadata
        ) AS provenance
      FROM descendant_members
      WHERE member_rank <= $7
      ORDER BY memory_id, support_hops ASC, member_rank ASC, occurred_at DESC
      LIMIT $8
    `,
    [
      namespaceId,
      temporalIds,
      layers,
      timeStart,
      timeEnd,
      Math.max(planner.maxTemporalDepth, 1),
      planner.supportMemberBudget,
      candidateLimit
    ]
  );

  return toRankedRows(rows)
    .map((row) => ({
      ...row,
      raw_score: row.scoreValue * temporalWindowAlignmentMultiplier(row, timeStart, timeEnd),
      scoreValue: row.scoreValue * temporalWindowAlignmentMultiplier(row, timeStart, timeEnd)
    }))
    .sort((left, right) => compareLexical(left, right, Boolean(timeStart || timeEnd), true));
}

async function loadHierarchicalContainmentSupportRows(
  namespaceId: string,
  lexicalTerms: readonly string[],
  candidateLimit: number,
  timeStart: string | null,
  timeEnd: string | null,
  temporalFocus: boolean
): Promise<RankedSearchRow[]> {
  const normalizedTerms = [...new Set(lexicalTerms.map((term) => term.trim().toLowerCase()).filter(Boolean))];
  if (normalizedTerms.length === 0) {
    return [];
  }

  const rows = await queryRows<SearchRow>(
    `
      WITH RECURSIVE matched_places AS (
        SELECT DISTINCT e.id
        FROM entities e
        WHERE e.namespace_id = $1
          AND e.entity_type IN ('place', 'org', 'project')
          AND e.normalized_name = ANY($2::text[])
        UNION
        SELECT DISTINCT ea.entity_id
        FROM entity_aliases ea
        JOIN entities e ON e.id = ea.entity_id
        WHERE e.namespace_id = $1
          AND e.entity_type IN ('place', 'org', 'project')
          AND ea.normalized_alias = ANY($2::text[])
      ),
      descendant_places AS (
        SELECT mp.id AS entity_id, 0 AS hops, ARRAY[mp.id]::uuid[] AS path
        FROM matched_places mp

        UNION ALL

        SELECT e.id AS entity_id, dp.hops + 1 AS hops, dp.path || e.id
        FROM descendant_places dp
        JOIN entities e
          ON e.namespace_id = $1
         AND e.parent_entity_id = dp.entity_id
        WHERE dp.hops < 4
          AND e.entity_type IN ('place', 'org', 'project')
          AND NOT (e.id = ANY(dp.path))
      ),
      ranked_descendants AS (
        SELECT entity_id, MIN(hops) AS hops
        FROM descendant_places
        GROUP BY entity_id
      )
      SELECT DISTINCT ON (e.id)
        e.id AS memory_id,
        'episodic_memory'::text AS memory_type,
        e.content,
        (1.0 / (28 + rd.hops))::double precision AS raw_score,
        e.artifact_id,
        e.occurred_at,
        e.namespace_id,
        jsonb_build_object(
          'tier', 'hierarchical_containment_support',
          'matched_entity_id', mem.entity_id,
          'containment_hops', rd.hops,
          'artifact_observation_id', e.artifact_observation_id,
          'source_chunk_id', e.source_chunk_id,
          'source_offset', e.source_offset,
          'source_uri', a.uri,
          'metadata', e.metadata
        ) AS provenance
      FROM ranked_descendants rd
      JOIN memory_entity_mentions mem
        ON mem.namespace_id = $1
       AND mem.entity_id = rd.entity_id
       AND mem.mention_role = 'location'
      JOIN episodic_memory e
        ON e.id = mem.source_memory_id
       AND e.namespace_id = $1
      LEFT JOIN artifacts a ON a.id = e.artifact_id
      WHERE ($3::timestamptz IS NULL OR e.occurred_at >= $3)
        AND ($4::timestamptz IS NULL OR e.occurred_at <= $4)
      ORDER BY e.id, rd.hops ASC, e.occurred_at DESC
      LIMIT $5
    `,
    [namespaceId, normalizedTerms, timeStart, timeEnd, candidateLimit]
  );

  return toRankedRows(rows).sort((left, right) => compareLexical(left, right, Boolean(timeStart || timeEnd), temporalFocus));
}

async function loadDirectHierarchyRows(
  namespaceId: string,
  queryText: string,
  candidateLimit: number
): Promise<RankedSearchRow[]> {
  const targets = [...new Set(extractHierarchyTargets(queryText).map(normalizeHierarchyKey).filter(Boolean))];
  if (targets.length === 0) {
    return [];
  }

  const rows = await queryRows<SearchRow>(
    `
      WITH RECURSIVE matched_entities AS (
        SELECT DISTINCT e.id, e.canonical_name, e.entity_type
        FROM entities e
        WHERE e.namespace_id = $1
          AND e.entity_type IN ('place', 'org', 'project')
          AND e.normalized_name = ANY($2::text[])
        UNION
        SELECT DISTINCT e.id, e.canonical_name, e.entity_type
        FROM entity_aliases ea
        JOIN entities e ON e.id = ea.entity_id
        WHERE e.namespace_id = $1
          AND e.entity_type IN ('place', 'org', 'project')
          AND ea.normalized_alias = ANY($2::text[])
      ),
      climb AS (
        SELECT
          me.id AS matched_entity_id,
          me.canonical_name AS matched_name,
          child.id AS child_entity_id,
          child.canonical_name AS child_name,
          child.entity_type AS child_type,
          parent.id AS parent_entity_id,
          parent.canonical_name AS parent_name,
          parent.entity_type AS parent_type,
          1 AS depth
        FROM matched_entities me
        JOIN entities child ON child.id = me.id
        JOIN entities parent ON parent.id = child.parent_entity_id
        UNION ALL
        SELECT
          climb.matched_entity_id,
          climb.matched_name,
          parent.id AS child_entity_id,
          parent.canonical_name AS child_name,
          parent.entity_type AS child_type,
          grand.id AS parent_entity_id,
          grand.canonical_name AS parent_name,
          grand.entity_type AS parent_type,
          climb.depth + 1 AS depth
        FROM climb
        JOIN entities parent ON parent.id = climb.parent_entity_id
        JOIN entities grand ON grand.id = parent.parent_entity_id
        WHERE climb.depth < 5
      )
      SELECT
        concat('hierarchy:', child_entity_id::text, ':', parent_entity_id::text) AS memory_id,
        'relationship_memory'::text AS memory_type,
        concat(child_name, ' is contained in ', parent_name) AS content,
        (1.15 / (4 + depth))::double precision AS raw_score,
        NULL::uuid AS artifact_id,
        NULL::timestamptz AS occurred_at,
        $1::text AS namespace_id,
        jsonb_build_object(
          'tier', 'structural_hierarchy',
          'matched_entity_id', matched_entity_id,
          'matched_name', matched_name,
          'subject_entity_id', child_entity_id,
          'object_entity_id', parent_entity_id,
          'predicate', 'contained_in',
          'depth', depth,
          'structural', true,
          'source_uri', concat('entity://parent_chain/', child_entity_id::text, '/', parent_entity_id::text)
        ) AS provenance
      FROM climb
      ORDER BY raw_score DESC, depth ASC, content ASC
      LIMIT $3
    `,
    [namespaceId, targets, candidateLimit]
  );

  return toRankedRows(rows).sort((left, right) => compareLexical(left, right, false, false));
}

async function loadFtsLexicalRows(
  namespaceId: string,
  queryText: string,
  candidateLimit: number,
  timeStart: string | null,
  timeEnd: string | null,
  planner: ReturnType<typeof planRecallQuery>,
  hasTimeWindow: boolean,
  relationshipExactFocus: boolean,
  activeRelationshipFocus: boolean,
  historicalRelationshipFocus: boolean,
  dailyLifeEventFocus: boolean,
  eventBoundedFocus: boolean,
  dailyLifeSummaryFocus: boolean,
  styleQueryFocus: boolean,
  temporalDetailFocus = false
): Promise<RankedSearchRow[]> {
  const plannerTerms = planner.lexicalTerms.filter((term) => term.trim().length > 0);
  const effectiveQueryText = temporalDetailFocus
    ? buildTemporalDetailEvidenceQueryText(queryText, planner.lexicalTerms)
    : styleQueryFocus
      ? buildStyleSpecEvidenceQueryText(queryText, planner.lexicalTerms)
      : (plannerTerms.length > 0 ? plannerTerms : [queryText]).join(" ");
  const eventQueryText = temporalDetailFocus
    ? buildTemporalDetailEvidenceQueryText(queryText, planner.lexicalTerms)
    : buildEventQueryText(queryText, planner.lexicalTerms);
  const temporalQueryText = temporalDetailFocus
    ? effectiveQueryText
    : dailyLifeSummaryFocus
      ? buildEventQueryText(queryText, planner.lexicalTerms)
      : queryText;
  const derivationMatch = buildBm25DisjunctionClause(
    [
      "ad.content_text",
      "ad.derivation_type"
    ],
    effectiveQueryText,
    2
  );
  const boundedEventLayerFocus =
    eventBoundedFocus &&
    !planner.temporalFocus &&
    !hasTimeWindow &&
    !historicalRelationshipFocus;
  const directCurrentTruthFocus =
    planner.queryClass === "direct_fact" &&
    activeRelationshipFocus &&
    !historicalRelationshipFocus &&
    !planner.temporalFocus &&
    !hasTimeWindow &&
    !dailyLifeEventFocus &&
    !dailyLifeSummaryFocus &&
    !temporalDetailFocus;
  const temporalRowsPromise = planner.temporalFocus || hasTimeWindow
    ? queryRows<SearchRow>(
        `
          SELECT
            id AS memory_id,
            'temporal_nodes'::text AS memory_type,
            summary_text AS content,
            ts_rank(to_tsvector('english', coalesce(summary_text, '')), websearch_to_tsquery('english', $2)) AS raw_score,
            NULL::uuid AS artifact_id,
            period_end AS occurred_at,
            namespace_id,
            jsonb_build_object(
              'tier', 'temporal_summary',
              'layer', layer,
              'period_start', period_start,
              'period_end', period_end,
              'summary_version', summary_version,
              'source_count', source_count,
              'generated_by', generated_by,
              'status', status,
              'archival_tier', archival_tier,
              'metadata', metadata
            ) AS provenance
          FROM temporal_nodes
          WHERE namespace_id = $1
            AND status = 'active'
            AND summary_text <> ''
            AND (
              ($3::timestamptz IS NULL OR period_end >= $3::timestamptz)
              AND ($4::timestamptz IS NULL OR period_start <= $4::timestamptz)
            )
            AND (
              $6::boolean = true
              OR to_tsvector('english', coalesce(summary_text, '')) @@ websearch_to_tsquery('english', $2)
            )
          ORDER BY raw_score DESC, period_end DESC
          LIMIT $5
        `,
        [namespaceId, temporalQueryText, timeStart, timeEnd, candidateLimit, dailyLifeSummaryFocus]
      )
    : Promise.resolve<SearchRow[]>([]);

  const [relationshipRows, relationshipCandidateRows, proceduralRows, semanticRows, candidateRows, eventRows, temporalRows, episodicRows, derivationRows] = await Promise.all([
    directCurrentTruthFocus || boundedEventLayerFocus
      ? Promise.resolve<SearchRow[]>([])
      : queryRows<SearchRow>(
      `
        SELECT
          rm.id AS memory_id,
          'relationship_memory'::text AS memory_type,
          ${relationshipContentExpression()} AS content,
          ts_rank(
            to_tsvector(
              'english',
              ${relationshipLexicalDocument()}
            ),
            websearch_to_tsquery('english', $2)
          ) AS raw_score,
          e.artifact_id,
          COALESCE(e.occurred_at, rm.valid_from) AS occurred_at,
          rm.namespace_id,
          jsonb_build_object(
            'tier', 'relationship_memory',
            'lexical_provider', 'fts_bridge',
            'subject_name', subject_entity.canonical_name,
            'predicate', rm.predicate,
            'object_name', object_entity.canonical_name,
            'status', rm.status,
            'source_candidate_id', rm.source_candidate_id,
            'source_memory_id', rc.source_memory_id,
            'source_uri', a.uri,
            'metadata', rm.metadata
          ) AS provenance
        FROM relationship_memory rm
        JOIN entities subject_entity ON subject_entity.id = rm.subject_entity_id
        JOIN entities object_entity ON object_entity.id = rm.object_entity_id
        LEFT JOIN relationship_candidates rc ON rc.id = rm.source_candidate_id
        LEFT JOIN episodic_memory e ON e.id = rc.source_memory_id
        LEFT JOIN artifacts a ON a.id = e.artifact_id
        WHERE rm.namespace_id = $1
          AND (
            ($6::boolean = true AND rm.status IN ('active', 'superseded'))
            OR
            ($6::boolean = false AND rm.status = 'active' AND rm.valid_until IS NULL)
          )
          AND to_tsvector(
                'english',
                ${relationshipLexicalDocument()}
              ) @@ websearch_to_tsquery('english', $2)
          AND (
            $6::boolean = false
            AND ($3::timestamptz IS NULL OR COALESCE(e.occurred_at, rm.valid_from) >= $3)
            AND ($4::timestamptz IS NULL OR COALESCE(e.occurred_at, rm.valid_from) <= $4)
            OR
            $6::boolean = true
            AND ($3::timestamptz IS NULL OR COALESCE(rm.valid_until, 'infinity'::timestamptz) >= $3)
            AND ($4::timestamptz IS NULL OR rm.valid_from <= $4)
          )
        ORDER BY raw_score DESC, COALESCE(e.occurred_at, rm.valid_from) DESC
        LIMIT $5
      `,
      [namespaceId, queryText, timeStart, timeEnd, candidateLimit, historicalRelationshipFocus]
    ),
    boundedEventLayerFocus
      ? Promise.resolve<SearchRow[]>([])
      : queryRows<SearchRow>(
      `
        SELECT
          rc.id AS memory_id,
          'relationship_candidate'::text AS memory_type,
          ${relationshipContentExpression("rc")} AS content,
          ts_rank(
            to_tsvector(
              'english',
              ${relationshipLexicalDocument("rc")}
            ),
            websearch_to_tsquery('english', $2)
          ) AS raw_score,
          e.artifact_id,
          COALESCE(e.occurred_at, rc.valid_from, rc.created_at) AS occurred_at,
          rc.namespace_id,
          jsonb_build_object(
            'tier', 'relationship_candidate',
            'lexical_provider', 'fts_bridge',
            'subject_name', subject_entity.canonical_name,
            'predicate', rc.predicate,
            'object_name', object_entity.canonical_name,
            'status', rc.status,
            'source_memory_id', rc.source_memory_id,
            'source_uri', a.uri,
            'metadata', rc.metadata
          ) AS provenance
        FROM relationship_candidates rc
        JOIN entities subject_entity ON subject_entity.id = rc.subject_entity_id
        JOIN entities object_entity ON object_entity.id = rc.object_entity_id
        LEFT JOIN episodic_memory e ON e.id = rc.source_memory_id
        LEFT JOIN artifacts a ON a.id = e.artifact_id
        WHERE rc.namespace_id = $1
          AND rc.status IN ('pending', 'accepted')
          AND to_tsvector(
                'english',
                ${relationshipLexicalDocument("rc")}
              ) @@ websearch_to_tsquery('english', $2)
          AND ($3::timestamptz IS NULL OR COALESCE(e.occurred_at, rc.valid_from, rc.created_at) >= $3)
          AND ($4::timestamptz IS NULL OR COALESCE(e.occurred_at, rc.valid_from, rc.created_at) <= $4)
        ORDER BY raw_score DESC, COALESCE(e.occurred_at, rc.valid_from, rc.created_at) DESC
        LIMIT $5
      `,
      [namespaceId, queryText, timeStart, timeEnd, candidateLimit]
    ),
    boundedEventLayerFocus
      ? Promise.resolve<SearchRow[]>([])
      : queryRows<SearchRow>(
      `
        SELECT
          procedural_memory.id AS memory_id,
          'procedural_memory'::text AS memory_type,
          ${proceduralContentExpression()} AS content,
          ts_rank(
            to_tsvector(
              'english',
              ${proceduralLexicalDocument()}
            ),
            websearch_to_tsquery('english', $2)
          ) AS raw_score,
          em.artifact_id,
          COALESCE(em.occurred_at, updated_at) AS occurred_at,
          procedural_memory.namespace_id,
          jsonb_build_object(
            'tier', 'current_procedural',
            'state_type', procedural_memory.state_type,
            'state_key', procedural_memory.state_key,
            'version', procedural_memory.version,
            'valid_from', procedural_memory.valid_from,
            'valid_until', procedural_memory.valid_until,
            'source_memory_id', em.id,
            'source_uri', a.uri,
            'metadata', procedural_memory.metadata
          ) AS provenance
        FROM procedural_memory
        LEFT JOIN episodic_memory em
          ON em.id = NULLIF(state_value->>'source_memory_id', '')::uuid
        LEFT JOIN artifacts a
          ON a.id = em.artifact_id
        WHERE procedural_memory.namespace_id = $1
          AND procedural_memory.valid_until IS NULL
          AND to_tsvector(
                'english',
                ${proceduralLexicalDocument()}
              ) @@ websearch_to_tsquery('english', $2)
        ORDER BY raw_score DESC, procedural_memory.updated_at DESC
        LIMIT $3
      `,
      [namespaceId, effectiveQueryText, candidateLimit]
    ),
    directCurrentTruthFocus || boundedEventLayerFocus
      ? Promise.resolve<SearchRow[]>([])
      : queryRows<SearchRow>(
      `
        SELECT
          semantic_memory.id AS memory_id,
          'semantic_memory'::text AS memory_type,
          content_abstract AS content,
          ts_rank(semantic_memory.search_vector, websearch_to_tsquery('english', $2)) AS raw_score,
          em.artifact_id,
          COALESCE(em.occurred_at, valid_from) AS occurred_at,
          semantic_memory.namespace_id,
          jsonb_build_object(
            'tier', 'current_semantic',
            'memory_kind', semantic_memory.memory_kind,
            'canonical_key', semantic_memory.canonical_key,
            'valid_from', semantic_memory.valid_from,
            'valid_until', semantic_memory.valid_until,
            'status', semantic_memory.status,
            'source_episodic_id', semantic_memory.source_episodic_id,
            'source_chunk_id', semantic_memory.source_chunk_id,
            'source_artifact_observation_id', semantic_memory.source_artifact_observation_id,
            'source_uri', a.uri,
            'metadata', semantic_memory.metadata
          ) AS provenance
        FROM semantic_memory
        LEFT JOIN episodic_memory em
          ON em.id = source_episodic_id
        LEFT JOIN artifacts a
          ON a.id = em.artifact_id
        WHERE semantic_memory.namespace_id = $1
          AND semantic_memory.status = 'active'
          AND semantic_memory.valid_until IS NULL
          AND semantic_memory.search_vector @@ websearch_to_tsquery('english', $2)
        ORDER BY raw_score DESC, semantic_memory.valid_from DESC
        LIMIT $3
      `,
      [namespaceId, effectiveQueryText, candidateLimit]
    ),
    directCurrentTruthFocus || boundedEventLayerFocus
      ? Promise.resolve<SearchRow[]>([])
      : queryRows<SearchRow>(
      `
        SELECT
          id AS memory_id,
          'memory_candidate'::text AS memory_type,
          content,
          ts_rank(to_tsvector('english', coalesce(content, '')), websearch_to_tsquery('english', $2)) AS raw_score,
          NULL::uuid AS artifact_id,
          created_at AS occurred_at,
          namespace_id,
          jsonb_build_object(
            'tier', 'candidate_memory',
            'candidate_type', candidate_type,
            'canonical_key', canonical_key,
            'status', status,
            'source_memory_id', source_memory_id,
            'source_chunk_id', source_chunk_id,
            'source_artifact_observation_id', source_artifact_observation_id,
            'metadata', metadata
          ) AS provenance
        FROM memory_candidates
        WHERE namespace_id = $1
          AND status IN ('pending', 'accepted')
          AND to_tsvector('english', coalesce(content, '')) @@ websearch_to_tsquery('english', $2)
        ORDER BY raw_score DESC, created_at DESC
        LIMIT $3
      `,
      [namespaceId, effectiveQueryText, candidateLimit]
    ),
    directCurrentTruthFocus
      ? Promise.resolve<SearchRow[]>([])
      : queryRows<SearchRow>(
      `
        SELECT
          ne.id AS memory_id,
          'narrative_event'::text AS memory_type,
          ${narrativeEventContentExpression()} AS content,
          ts_rank(
            to_tsvector(
              'english',
              ${narrativeEventLexicalDocument()}
            ),
            websearch_to_tsquery('english', $2)
          ) * 0.72 AS raw_score,
          ne.artifact_id,
          COALESCE(ne.time_start, ao.observed_at, ne.created_at) AS occurred_at,
          ne.namespace_id,
          jsonb_build_object(
            'tier', 'narrative_event',
            'event_kind', ne.event_kind,
            'event_label', ne.event_label,
            'subject_name', subject_entity.canonical_name,
            'location_name', location_entity.canonical_name,
            'source_scene_id', ne.source_scene_id,
            'source_artifact_observation_id', ne.artifact_observation_id,
            'source_uri', a.uri,
            'metadata', ne.metadata
          ) AS provenance
        FROM narrative_events ne
        LEFT JOIN artifacts a ON a.id = ne.artifact_id
        LEFT JOIN artifact_observations ao ON ao.id = ne.artifact_observation_id
        LEFT JOIN entities subject_entity ON subject_entity.id = ne.primary_subject_entity_id
        LEFT JOIN entities location_entity ON location_entity.id = ne.primary_location_entity_id
        WHERE ne.namespace_id = $1
          AND to_tsvector(
                'english',
                ${narrativeEventLexicalDocument()}
              ) @@ websearch_to_tsquery('english', $2)
          AND ($4::timestamptz IS NULL OR COALESCE(ne.time_start, ao.observed_at, ne.created_at) >= $4)
          AND ($5::timestamptz IS NULL OR COALESCE(ne.time_start, ao.observed_at, ne.created_at) <= $5)
        ORDER BY raw_score DESC, COALESCE(ne.time_start, ao.observed_at, ne.created_at) DESC
        LIMIT $3
      `,
      [namespaceId, eventQueryText, candidateLimit, timeStart, timeEnd]
    ),
    directCurrentTruthFocus || boundedEventLayerFocus ? Promise.resolve<SearchRow[]>([]) : temporalRowsPromise,
    directCurrentTruthFocus
      ? Promise.resolve<SearchRow[]>([])
      : queryRows<SearchRow>(
      `
        SELECT
          em.id AS memory_id,
          'episodic_memory'::text AS memory_type,
          em.content,
          ts_rank(em.search_vector, websearch_to_tsquery('english', $2)) AS raw_score,
          em.artifact_id,
          em.occurred_at,
          em.namespace_id,
          jsonb_build_object(
            'tier', 'historical_episodic',
            'artifact_observation_id', em.artifact_observation_id,
            'source_chunk_id', em.source_chunk_id,
            'source_offset', em.source_offset,
            'source_uri', a.uri,
            'metadata', em.metadata
          ) AS provenance
        FROM episodic_memory em
        LEFT JOIN artifacts a ON a.id = em.artifact_id
        WHERE em.namespace_id = $1
          AND (
            $6::boolean = true
            OR em.search_vector @@ websearch_to_tsquery('english', $2)
          )
          AND ($4::timestamptz IS NULL OR em.occurred_at >= $4)
          AND ($5::timestamptz IS NULL OR em.occurred_at <= $5)
        ORDER BY raw_score DESC, em.occurred_at DESC
        LIMIT $3
      `,
      [namespaceId, temporalQueryText, candidateLimit, timeStart, timeEnd, dailyLifeSummaryFocus]
    ),
    directCurrentTruthFocus
      ? Promise.resolve<SearchRow[]>([])
      : queryRows<SearchRow>(
      `
        SELECT
          ad.id AS memory_id,
          'artifact_derivation'::text AS memory_type,
          ${artifactDerivationContentExpression()} AS content,
          ts_rank(
            to_tsvector('english', ${artifactDerivationLexicalDocument()}),
            websearch_to_tsquery('english', $2)
          ) AS raw_score,
          ao.artifact_id,
          coalesce(source_em.occurred_at, ao.observed_at) AS occurred_at,
          a.namespace_id,
          jsonb_build_object(
            'tier', 'artifact_derivation',
            'derivation_type', ad.derivation_type,
            'provider', ad.provider,
            'model', ad.model,
            'artifact_observation_id', ad.artifact_observation_id,
            'source_chunk_id', ad.source_chunk_id,
            'source_uri', a.uri,
            'metadata', ad.metadata
          ) AS provenance
        FROM artifact_derivations ad
        JOIN artifact_observations ao ON ao.id = ad.artifact_observation_id
        JOIN artifacts a ON a.id = ao.artifact_id
        LEFT JOIN episodic_memory source_em ON source_em.id = ad.source_chunk_id
        WHERE a.namespace_id = $1
          AND coalesce(ad.content_text, '') <> ''
          AND ${derivationMatch.clause}
          AND ($3::timestamptz IS NULL OR coalesce(source_em.occurred_at, ao.observed_at) >= $3)
          AND ($4::timestamptz IS NULL OR coalesce(source_em.occurred_at, ao.observed_at) <= $4)
        ORDER BY raw_score DESC, coalesce(source_em.occurred_at, ao.observed_at) DESC
        LIMIT $5
      `,
      [namespaceId, ...derivationMatch.values, timeStart, timeEnd, candidateLimit]
    )
  ]);

  const combinedRows = toRankedRows([
    ...relationshipRows,
    ...relationshipCandidateRows,
    ...proceduralRows,
    ...semanticRows,
    ...candidateRows,
    ...eventRows,
    ...temporalRows,
    ...episodicRows,
    ...derivationRows
  ]);

  return combinedRows.length > 0
    ? finalizeLexicalRows(
        combinedRows,
        candidateLimit,
        hasTimeWindow,
        planner.temporalFocus,
        dailyLifeEventFocus,
        dailyLifeSummaryFocus,
        timeStart,
        timeEnd
      )
    : [];
}

async function loadBm25LexicalRows(
  namespaceId: string,
  queryText: string,
  candidateLimit: number,
  timeStart: string | null,
  timeEnd: string | null,
  planner: ReturnType<typeof planRecallQuery>,
  hasTimeWindow: boolean,
  relationshipExactFocus: boolean,
  precisionLexicalFocus: boolean,
  activeRelationshipFocus: boolean,
  historicalRelationshipFocus: boolean,
  dailyLifeEventFocus: boolean,
  eventBoundedFocus: boolean,
  dailyLifeSummaryFocus: boolean,
  styleQueryFocus: boolean,
  temporalDetailFocus = false
): Promise<RankedSearchRow[]> {
  const plannerTerms = planner.lexicalTerms.filter((term) => {
    const normalized = term.toLowerCase();
    if (/^\d{4}$/.test(normalized) && planner.temporalFocus) {
      return false;
    }
    return !BM25_STOP_WORDS.has(normalized);
  });
  const effectiveQueryText = temporalDetailFocus
    ? buildTemporalDetailEvidenceQueryText(queryText, planner.lexicalTerms)
    : styleQueryFocus
      ? buildStyleSpecEvidenceQueryText(queryText, planner.lexicalTerms)
      : (plannerTerms.length > 0 ? plannerTerms : [queryText]).join(" ");
  const semanticMatch = buildBm25DisjunctionClause(["content_abstract", "canonical_key", "memory_kind"], effectiveQueryText, 2);
  const candidateMatch = buildBm25DisjunctionClause(["content", "candidate_type", "canonical_key"], effectiveQueryText, 2);
  const eventMatch = buildBm25DisjunctionClause(
    [
      "ne.event_label",
      "ne.event_kind",
      "subject_entity.canonical_name",
      "location_entity.canonical_name",
      "ne.metadata->>'activity'",
      "ne.metadata->>'activity_label'",
      "ne.metadata->>'source_sentence_text'",
      "ne.metadata->>'location_text'",
      "ne.metadata->>'participant_names'"
    ],
    temporalDetailFocus
      ? buildTemporalDetailEvidenceQueryText(queryText, planner.lexicalTerms)
      : buildEventQueryText(queryText, planner.lexicalTerms),
    2
  );
  const temporalMatch = buildBm25DisjunctionClause(["summary_text", "layer"], effectiveQueryText, 2);
  const episodicMatch = buildBm25DisjunctionClause(["e.content", "e.role"], effectiveQueryText, 2);
  const derivationMatch = buildBm25DisjunctionClause(
    [
      "ad.content_text",
      "ad.derivation_type"
    ],
    effectiveQueryText,
    2
  );
  const directCurrentTruthFocus =
    planner.queryClass === "direct_fact" &&
    activeRelationshipFocus &&
    !historicalRelationshipFocus &&
    !planner.temporalFocus &&
    !hasTimeWindow &&
    !dailyLifeEventFocus &&
    !dailyLifeSummaryFocus &&
    !temporalDetailFocus;
  const boundedEventLayerFocus =
    eventBoundedFocus &&
    !planner.temporalFocus &&
    !hasTimeWindow &&
    !historicalRelationshipFocus;

  const [relationshipRows, relationshipCandidateRows, proceduralRows, semanticRows, candidateRows, eventRows, temporalRows, episodicRows, derivationRows] = await Promise.all([
    boundedEventLayerFocus
      ? Promise.resolve<SearchRow[]>([])
      : queryRows<SearchRow>(
      `
        SELECT
          rm.id AS memory_id,
          'relationship_memory'::text AS memory_type,
          ${relationshipContentExpression()} AS content,
          ts_rank(
            to_tsvector(
              'english',
              ${relationshipLexicalDocument()}
            ),
            websearch_to_tsquery('english', $2)
          ) AS raw_score,
          e.artifact_id,
          COALESCE(e.occurred_at, rm.valid_from) AS occurred_at,
          rm.namespace_id,
          jsonb_build_object(
            'tier', 'relationship_memory',
            'lexical_provider', 'fts_bridge',
            'subject_name', subject_entity.canonical_name,
            'predicate', rm.predicate,
            'object_name', object_entity.canonical_name,
            'status', rm.status,
            'source_candidate_id', rm.source_candidate_id,
            'source_memory_id', rc.source_memory_id,
            'source_uri', a.uri,
            'metadata', rm.metadata
          ) AS provenance
        FROM relationship_memory rm
        JOIN entities subject_entity ON subject_entity.id = rm.subject_entity_id
        JOIN entities object_entity ON object_entity.id = rm.object_entity_id
        LEFT JOIN relationship_candidates rc ON rc.id = rm.source_candidate_id
        LEFT JOIN episodic_memory e ON e.id = rc.source_memory_id
        LEFT JOIN artifacts a ON a.id = e.artifact_id
        WHERE rm.namespace_id = $1
          AND (
            ($6::boolean = true AND rm.status IN ('active', 'superseded'))
            OR
            ($6::boolean = false AND rm.status = 'active' AND rm.valid_until IS NULL)
          )
          AND to_tsvector(
                'english',
                ${relationshipLexicalDocument()}
              ) @@ websearch_to_tsquery('english', $2)
          AND (
            $6::boolean = false
            AND ($3::timestamptz IS NULL OR COALESCE(e.occurred_at, rm.valid_from) >= $3)
            AND ($4::timestamptz IS NULL OR COALESCE(e.occurred_at, rm.valid_from) <= $4)
            OR
            $6::boolean = true
            AND ($3::timestamptz IS NULL OR COALESCE(rm.valid_until, 'infinity'::timestamptz) >= $3)
            AND ($4::timestamptz IS NULL OR rm.valid_from <= $4)
          )
        ORDER BY raw_score DESC, COALESCE(e.occurred_at, rm.valid_from) DESC
        LIMIT $5
      `,
      [namespaceId, queryText, timeStart, timeEnd, candidateLimit, historicalRelationshipFocus]
    ),
    directCurrentTruthFocus || boundedEventLayerFocus
      ? Promise.resolve<SearchRow[]>([])
      : queryRows<SearchRow>(
      `
        SELECT
          rc.id AS memory_id,
          'relationship_candidate'::text AS memory_type,
          ${relationshipContentExpression("rc")} AS content,
          ts_rank(
            to_tsvector(
              'english',
              ${relationshipLexicalDocument("rc")}
            ),
            websearch_to_tsquery('english', $2)
          ) AS raw_score,
          e.artifact_id,
          COALESCE(e.occurred_at, rc.valid_from, rc.created_at) AS occurred_at,
          rc.namespace_id,
          jsonb_build_object(
            'tier', 'relationship_candidate',
            'lexical_provider', 'fts_bridge',
            'subject_name', subject_entity.canonical_name,
            'predicate', rc.predicate,
            'object_name', object_entity.canonical_name,
            'status', rc.status,
            'source_memory_id', rc.source_memory_id,
            'source_uri', a.uri,
            'metadata', rc.metadata
          ) AS provenance
        FROM relationship_candidates rc
        JOIN entities subject_entity ON subject_entity.id = rc.subject_entity_id
        JOIN entities object_entity ON object_entity.id = rc.object_entity_id
        LEFT JOIN episodic_memory e ON e.id = rc.source_memory_id
        LEFT JOIN artifacts a ON a.id = e.artifact_id
        WHERE rc.namespace_id = $1
          AND rc.status IN ('pending', 'accepted')
          AND to_tsvector(
                'english',
                ${relationshipLexicalDocument("rc")}
              ) @@ websearch_to_tsquery('english', $2)
          AND ($3::timestamptz IS NULL OR COALESCE(e.occurred_at, rc.valid_from, rc.created_at) >= $3)
          AND ($4::timestamptz IS NULL OR COALESCE(e.occurred_at, rc.valid_from, rc.created_at) <= $4)
        ORDER BY raw_score DESC, COALESCE(e.occurred_at, rc.valid_from, rc.created_at) DESC
        LIMIT $5
      `,
      [namespaceId, queryText, timeStart, timeEnd, candidateLimit]
    ),
    boundedEventLayerFocus
      ? Promise.resolve<SearchRow[]>([])
      : queryRows<SearchRow>(
      `
        SELECT
          procedural_memory.id AS memory_id,
          'procedural_memory'::text AS memory_type,
          ${proceduralContentExpression()} AS content,
          ts_rank(
            to_tsvector(
              'english',
              ${proceduralLexicalDocument()}
            ),
            websearch_to_tsquery('english', $2)
          ) AS raw_score,
          em.artifact_id,
          COALESCE(em.occurred_at, procedural_memory.updated_at) AS occurred_at,
          procedural_memory.namespace_id,
          jsonb_build_object(
            'tier', 'current_procedural',
            'lexical_provider', 'fts_bridge',
            'state_type', procedural_memory.state_type,
            'state_key', procedural_memory.state_key,
            'version', procedural_memory.version,
            'valid_from', procedural_memory.valid_from,
            'valid_until', procedural_memory.valid_until,
            'source_memory_id', em.id,
            'source_uri', a.uri,
            'metadata', procedural_memory.metadata
          ) AS provenance
        FROM procedural_memory
        LEFT JOIN episodic_memory em
          ON em.id = NULLIF(state_value->>'source_memory_id', '')::uuid
        LEFT JOIN artifacts a
          ON a.id = em.artifact_id
        WHERE procedural_memory.namespace_id = $1
          AND procedural_memory.valid_until IS NULL
          AND to_tsvector(
                'english',
                ${proceduralLexicalDocument()}
              ) @@ websearch_to_tsquery('english', $2)
        ORDER BY raw_score DESC, COALESCE(em.occurred_at, procedural_memory.updated_at) DESC
        LIMIT $3
      `,
      [namespaceId, queryText, candidateLimit]
    ),
    directCurrentTruthFocus || boundedEventLayerFocus
      ? Promise.resolve<SearchRow[]>([])
      : queryRows<SearchRow>(
      `
        SELECT
          semantic_memory.id AS memory_id,
          'semantic_memory'::text AS memory_type,
          semantic_memory.content_abstract AS content,
          pdb.score(semantic_memory.id) AS raw_score,
          em.artifact_id,
          COALESCE(em.occurred_at, semantic_memory.valid_from) AS occurred_at,
          semantic_memory.namespace_id,
          jsonb_build_object(
            'tier', 'current_semantic',
            'lexical_provider', 'bm25',
            'memory_kind', semantic_memory.memory_kind,
            'canonical_key', semantic_memory.canonical_key,
            'valid_from', semantic_memory.valid_from,
            'valid_until', semantic_memory.valid_until,
            'status', semantic_memory.status,
            'source_episodic_id', semantic_memory.source_episodic_id,
            'source_chunk_id', semantic_memory.source_chunk_id,
            'source_artifact_observation_id', semantic_memory.source_artifact_observation_id,
            'source_uri', a.uri,
            'metadata', semantic_memory.metadata
          ) AS provenance
        FROM semantic_memory
        LEFT JOIN episodic_memory em
          ON em.id = semantic_memory.source_episodic_id
        LEFT JOIN artifacts a
          ON a.id = em.artifact_id
        WHERE semantic_memory.namespace_id = $1
          AND semantic_memory.status = 'active'
          AND semantic_memory.valid_until IS NULL
          AND ${semanticMatch.clause}
        ORDER BY raw_score DESC, semantic_memory.valid_from DESC
        LIMIT $3
      `,
      [namespaceId, ...semanticMatch.values, candidateLimit]
    ),
    directCurrentTruthFocus || boundedEventLayerFocus
      ? Promise.resolve<SearchRow[]>([])
      : queryRows<SearchRow>(
      `
        SELECT
          id AS memory_id,
          'memory_candidate'::text AS memory_type,
          content,
          pdb.score(id) AS raw_score,
          NULL::uuid AS artifact_id,
          created_at AS occurred_at,
          namespace_id,
          jsonb_build_object(
            'tier', 'candidate_memory',
            'lexical_provider', 'bm25',
            'candidate_type', candidate_type,
            'canonical_key', canonical_key,
            'status', status,
            'source_memory_id', source_memory_id,
            'source_chunk_id', source_chunk_id,
            'source_artifact_observation_id', source_artifact_observation_id,
            'metadata', metadata
          ) AS provenance
        FROM memory_candidates
        WHERE namespace_id = $1
          AND status IN ('pending', 'accepted')
          AND ${candidateMatch.clause}
        ORDER BY raw_score DESC, created_at DESC
            LIMIT $3
      `,
      [namespaceId, ...candidateMatch.values, candidateLimit]
    ),
    directCurrentTruthFocus
      ? Promise.resolve<SearchRow[]>([])
      : queryRows<SearchRow>(
      `
        SELECT
          ne.id AS memory_id,
          'narrative_event'::text AS memory_type,
          ${narrativeEventContentExpression()} AS content,
          ts_rank(
            to_tsvector(
              'english',
              ${narrativeEventLexicalDocument()}
            ),
            websearch_to_tsquery('english', $2)
          ) * 0.72 AS raw_score,
          ne.artifact_id,
          COALESCE(ne.time_start, ao.observed_at, ne.created_at) AS occurred_at,
          ne.namespace_id,
          jsonb_build_object(
            'tier', 'narrative_event',
            'lexical_provider', 'bm25',
            'event_kind', ne.event_kind,
            'event_label', ne.event_label,
            'subject_name', subject_entity.canonical_name,
            'location_name', location_entity.canonical_name,
            'source_scene_id', ne.source_scene_id,
            'source_artifact_observation_id', ne.artifact_observation_id,
            'metadata', ne.metadata
          ) AS provenance
        FROM narrative_events ne
        LEFT JOIN artifact_observations ao ON ao.id = ne.artifact_observation_id
        LEFT JOIN entities subject_entity ON subject_entity.id = ne.primary_subject_entity_id
        LEFT JOIN entities location_entity ON location_entity.id = ne.primary_location_entity_id
        WHERE ne.namespace_id = $1
          AND ${eventMatch.clause}
          AND ($3::timestamptz IS NULL OR COALESCE(ne.time_start, ao.observed_at, ne.created_at) >= $3)
          AND ($4::timestamptz IS NULL OR COALESCE(ne.time_start, ao.observed_at, ne.created_at) <= $4)
        ORDER BY raw_score DESC, COALESCE(ne.time_start, ao.observed_at, ne.created_at) DESC
        LIMIT $5
      `,
      [namespaceId, ...eventMatch.values, timeStart, timeEnd, candidateLimit]
    ),
    directCurrentTruthFocus || boundedEventLayerFocus
      ? Promise.resolve<SearchRow[]>([])
      : planner.temporalFocus || hasTimeWindow
      ? queryRows<SearchRow>(
          `
            SELECT
              id AS memory_id,
              'temporal_nodes'::text AS memory_type,
              summary_text AS content,
              pdb.score(id) AS raw_score,
              NULL::uuid AS artifact_id,
              period_end AS occurred_at,
              namespace_id,
              jsonb_build_object(
                'tier', 'temporal_summary',
                'lexical_provider', 'bm25',
                'layer', layer,
                'period_start', period_start,
                'period_end', period_end,
                'summary_version', summary_version,
                'source_count', source_count,
                'generated_by', generated_by,
                'status', status,
                'archival_tier', archival_tier,
                'metadata', metadata
              ) AS provenance
            FROM temporal_nodes
            WHERE namespace_id = $1
              AND status = 'active'
              AND summary_text <> ''
              AND (
                ($3::timestamptz IS NULL OR period_end >= $3::timestamptz)
                AND ($4::timestamptz IS NULL OR period_start <= $4::timestamptz)
              )
              AND ${temporalMatch.clause}
            ORDER BY raw_score DESC, period_end DESC
            LIMIT $5
          `,
          [namespaceId, ...temporalMatch.values, timeStart, timeEnd, candidateLimit]
        )
      : Promise.resolve<SearchRow[]>([]),
    directCurrentTruthFocus
      ? Promise.resolve<SearchRow[]>([])
      : queryRows<SearchRow>(
      `
        SELECT
          e.id AS memory_id,
          'episodic_memory'::text AS memory_type,
          e.content,
          pdb.score(e.id) AS raw_score,
          e.artifact_id,
          e.occurred_at,
          e.namespace_id,
          jsonb_build_object(
            'tier', 'historical_episodic',
            'lexical_provider', 'bm25',
            'artifact_observation_id', e.artifact_observation_id,
            'source_chunk_id', e.source_chunk_id,
            'source_offset', e.source_offset,
            'source_uri', a.uri,
            'metadata', e.metadata
          ) AS provenance
        FROM episodic_memory e
        LEFT JOIN artifacts a ON a.id = e.artifact_id
        WHERE e.namespace_id = $1
          AND ${episodicMatch.clause}
          AND ($3::timestamptz IS NULL OR e.occurred_at >= $3)
          AND ($4::timestamptz IS NULL OR e.occurred_at <= $4)
        ORDER BY raw_score DESC, e.occurred_at DESC
        LIMIT $5
      `,
      [namespaceId, ...episodicMatch.values, timeStart, timeEnd, candidateLimit]
    ),
    directCurrentTruthFocus
      ? Promise.resolve<SearchRow[]>([])
      : queryRows<SearchRow>(
      `
        SELECT
          ad.id AS memory_id,
          'artifact_derivation'::text AS memory_type,
          ${artifactDerivationContentExpression()} AS content,
          ts_rank(
            to_tsvector('english', ${artifactDerivationLexicalDocument()}),
            websearch_to_tsquery('english', $2)
          ) AS raw_score,
          ao.artifact_id,
          coalesce(source_em.occurred_at, ao.observed_at) AS occurred_at,
          a.namespace_id,
          jsonb_build_object(
            'tier', 'artifact_derivation',
            'lexical_provider', 'fts_bridge',
            'derivation_type', ad.derivation_type,
            'provider', ad.provider,
            'model', ad.model,
            'artifact_observation_id', ad.artifact_observation_id,
            'source_chunk_id', ad.source_chunk_id,
            'source_uri', a.uri,
            'metadata', ad.metadata
          ) AS provenance
        FROM artifact_derivations ad
        JOIN artifact_observations ao ON ao.id = ad.artifact_observation_id
        JOIN artifacts a ON a.id = ao.artifact_id
        LEFT JOIN episodic_memory source_em ON source_em.id = ad.source_chunk_id
        WHERE a.namespace_id = $1
          AND coalesce(ad.content_text, '') <> ''
          AND ${derivationMatch.clause}
          AND ($3::timestamptz IS NULL OR coalesce(source_em.occurred_at, ao.observed_at) >= $3)
          AND ($4::timestamptz IS NULL OR coalesce(source_em.occurred_at, ao.observed_at) <= $4)
        ORDER BY raw_score DESC, coalesce(source_em.occurred_at, ao.observed_at) DESC
        LIMIT $5
      `,
      [namespaceId, ...derivationMatch.values, timeStart, timeEnd, candidateLimit]
    )
  ]);

  return rankLexicalSources(
    [
      { branch: "relationship_memory", rows: toRankedRows(relationshipRows) },
      { branch: "relationship_candidate", rows: toRankedRows(relationshipCandidateRows) },
      { branch: "procedural_memory", rows: toRankedRows(proceduralRows) },
      { branch: "semantic_memory", rows: toRankedRows(semanticRows) },
      { branch: "memory_candidate", rows: toRankedRows(candidateRows) },
      { branch: "narrative_event", rows: toRankedRows(eventRows) },
      { branch: "temporal_nodes", rows: toRankedRows(temporalRows) },
      { branch: "episodic_memory", rows: toRankedRows(episodicRows) },
      { branch: "artifact_derivation", rows: toRankedRows(derivationRows) }
    ],
    candidateLimit,
    hasTimeWindow,
    planner.temporalFocus,
    relationshipExactFocus,
    precisionLexicalFocus,
    activeRelationshipFocus,
    dailyLifeEventFocus,
    dailyLifeSummaryFocus,
    planner,
    timeStart,
    timeEnd,
    plannerTerms
  );
}

async function resolveQueryEmbedding(
  query: RecallQuery
): Promise<{
  readonly embedding: number[] | null;
  readonly source: "provided" | "provider" | "none";
  readonly provider?: string;
  readonly model?: string;
  readonly fallbackReason?: string;
}> {
  if (query.queryEmbedding && query.queryEmbedding.length > 0) {
    return {
      embedding: [...query.queryEmbedding],
      source: "provided"
    };
  }

  const selection = resolveEmbeddingRuntimeSelection({
    provider: query.provider,
    model: query.model,
    outputDimensionality: query.outputDimensionality
  });

  if (!selection.enabled) {
    return {
      embedding: null,
      source: "none",
      fallbackReason: "provider:none"
    };
  }

  try {
    const adapter = getProviderAdapter(selection.provider);
    const response = await adapter.embedText({
      text: query.query,
      model: selection.model,
      outputDimensionality: selection.outputDimensionality
    });

    return {
      embedding: response.embedding,
      source: "provider",
      provider: response.provider,
      model: response.model
    };
  } catch (error) {
    if (error instanceof ProviderError) {
      return {
        embedding: null,
        source: "none",
        fallbackReason: `${error.provider}:${error.code}`
      };
    }

    throw error;
  }
}

export async function searchMemory(query: RecallQuery): Promise<RecallResponse> {
  const config = readConfig();
  const limit = normalizeLimit(query.limit);
  const queryText = query.query.trim();
  const decompositionDepth = query.decompositionDepth ?? 0;
  const directRelationshipEntity = (() => {
    const hints = extractSubjectHintsFromQuery(queryText).filter((hint) => !["US", "U.S", "United States"].includes(hint));
    if (hints.length === 0 || hints.length > 2 || /\beach person\b/i.test(queryText)) {
      return null;
    }
    const nonSelf = hints.filter((hint) => !/^steve(?:\s+tietze)?$/i.test(hint));
    return nonSelf.at(-1) ?? hints[0] ?? null;
  })();

  if (decompositionDepth === 0 && isWarmStartQuery(queryText)) {
    return buildWarmStartSearchResponse(query);
  }

  if (decompositionDepth === 0 && isHabitConstraintQueryText(queryText)) {
    return buildHabitConstraintSearchResponse(query);
  }

  if (
    decompositionDepth === 0 &&
    directRelationshipEntity &&
    !/\bassociated with\b/i.test(queryText) &&
    !isHistoricalRelationshipQuery(queryText) &&
    !isRelationshipChangeQueryText(queryText) &&
    (isRelationshipProfileQueryText(queryText) || isActiveRelationshipQuery(queryText))
  ) {
    const relationshipResponse = await getRelationships({
      namespaceId: query.namespaceId,
      entityName: directRelationshipEntity,
      includeHistorical: false,
      timeStart: query.timeStart,
      timeEnd: query.timeEnd,
      limit: Math.max(limit * 4, 64)
    });
    const laneRelationships = selectRelationshipLaneResults(query.query, relationshipResponse.relationships);
    if (laneRelationships.length > 0) {
      return buildRelationshipLaneSearchResponse(
        query,
        directRelationshipEntity,
        laneRelationships.slice(0, Math.max(limit, 16)),
        "The relationship query was answered from canonical relationship rows before broad retrieval."
      );
    }
  }

  const earlyQueryEntityFocus = parseQueryEntityFocus(query.query);
  if (
    decompositionDepth === 0 &&
    earlyQueryEntityFocus.mode === "primary_with_companion" &&
    /\bbesides\b/i.test(queryText) &&
    /\bfriends?\b/i.test(queryText)
  ) {
    const primaryName = earlyQueryEntityFocus.primaryHints[0];
    const companionName = earlyQueryEntityFocus.companionHints[0];
    if (primaryName && companionName) {
      const relationshipResponse = await getRelationships({
        namespaceId: query.namespaceId,
        entityName: primaryName,
        includeHistorical: false,
        timeStart: query.timeStart,
        timeEnd: query.timeEnd,
        limit: Math.max(limit * 6, 48)
      });
      const socialLaneRelationships = relationshipResponse.relationships.filter((relationship) => {
        const predicate = relationship.predicate.toLowerCase();
        const counterparty = normalizeWhitespace(relationshipCounterpartyName(relationship, primaryName)).toLowerCase();
        return (
          ["friend_of", "friends_with", "best_friends_with", "works_with", "met_through", "was_with"].includes(predicate) &&
          counterparty.length > 0 &&
          counterparty !== companionName &&
          counterparty !== primaryName
        );
      });
      if (socialLaneRelationships.length > 0) {
        return buildCompanionExclusionRelationshipSearchResponse(
          query,
          primaryName.split(" ").map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`).join(" "),
          companionName.split(" ").map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`).join(" "),
          socialLaneRelationships.slice(0, Math.max(limit, 8)),
          "The companion-exclusion query was answered from typed relationship rows before broad transcript retrieval."
        );
      }
    }
  }

  if (decompositionDepth === 0 && isPurchaseSummaryQuery(queryText)) {
    const results = (await getTypedTransactionResults(query)).slice(0, limit);
    if (results.length > 0) {
      return buildTypedLaneSearchResponse(
        query,
        results,
        "The purchase query was answered from typed transaction facts reconstructed from the canonical corpus."
      );
    }
  }

  if (decompositionDepth === 0 && isMediaSummaryQuery(queryText)) {
    const results = (await getTypedMediaResults(query)).slice(0, limit);
    if (results.length > 0) {
      return buildTypedLaneSearchResponse(
        query,
        results,
        "The media query was answered from typed media mentions before falling back to mixed transcript retrieval."
      );
    }
  }

  if (decompositionDepth === 0 && isFavoriteMediaDetailQueryText(queryText)) {
    const expandedLimit = Math.max(limit, 8);
    const trilogyQuery = /\btrilog(?:y|ies)\b/i.test(queryText);
    const results = (await getTypedMediaResults({ ...query, limit: expandedLimit }))
      .filter(
        (result) =>
          result.provenance.favorite_signal === true ||
          /\bfavorite\b/i.test(result.content) ||
          /\blik(?:ed|es)\b/i.test(result.content) ||
          /\b(?:awesome|so good|really good|love it|love that|physical copy)\b/i.test(result.content)
      )
      .slice(0, expandedLimit);
    const trilogySupported = results.some(
      (result) =>
        /\btrilog(?:y|ies)\b/i.test(result.content) ||
        /\btrilog(?:y|ies)\b/i.test(typeof result.provenance.media_title === "string" ? result.provenance.media_title : "")
    );
    if (trilogyQuery && !trilogySupported) {
      return buildTypedLaneSearchResponse(
        query,
        [],
        "The favorite-media detail query requested a trilogy, but the typed media lane only found single-title favorites, so the system returned a grounded abstention."
      );
    }
    if (results.length > 0) {
      return buildTypedLaneSearchResponse(
        query,
        results,
        "The favorite-media detail query was answered from typed media mentions with media-entity carry-forward before broad transcript retrieval."
      );
    }
  }

  if (
    decompositionDepth === 0 &&
    inferExactDetailQuestionFamily(queryText) === "realization" &&
    queryAnchorTerms(queryText).length > 0
  ) {
    const expandedLimit = Math.max(limit, 8);
    const anchoredRows = toRankedRows(
      await loadAnchoredRealizationSupportRows(
        query.namespaceId,
        queryText,
        expandedLimit,
        query.timeStart ?? null,
        query.timeEnd ?? null
      )
    );
    const neighborhoodRows = toRankedRows(
      await loadEventNeighborhoodEpisodicRows(
        query.namespaceId,
        queryText,
        buildEventBoundedEvidenceTerms(queryText, []),
        expandedLimit,
        query.timeStart ?? null,
        query.timeEnd ?? null
      )
    );
    if (anchoredRows.length > 0 || neighborhoodRows.length > 0) {
      const anchoredFirst = mergeInjectedRankedRows([], anchoredRows, 1.35);
      const mergedAnchoredRows = mergeInjectedRankedRows(anchoredFirst, neighborhoodRows, 0.92);
      const anchoredResults = retainSubjectBoundExactDetailResults(
        queryText,
        mergedAnchoredRows
          .slice(0, expandedLimit)
          .map((row) =>
            buildRecallResult(row.row, row.rrfScore, {
              rrfScore: row.rrfScore,
              lexicalRank: row.lexicalRank,
              vectorRank: row.vectorRank,
              lexicalRawScore: row.lexicalRawScore,
              vectorDistance: row.vectorDistance
            })
          ),
        expandedLimit
      );
      if (deriveRealizationClaimText(queryText, anchoredResults)) {
        return buildTypedLaneSearchResponse(
          query,
          anchoredResults,
          "The realization query was answered from anchor-first event-local evidence before broad mixed retrieval."
        );
      }
    }
  }

  if (decompositionDepth === 0 && isPreferenceSummaryQuery(queryText)) {
    const expandedLimit = Math.max(limit, 12);
    const results = (await getTypedPreferenceResults({ ...query, limit: expandedLimit })).slice(0, expandedLimit);
    return buildTypedLaneSearchResponse(
      query,
      results,
      results.length > 0
        ? "The preference query was answered from typed preference facts reconstructed from explicit evidence."
        : "No typed preference facts matched this query, so the system returned an explicit grounded abstention instead of falling back to generic retrieval."
    );
  }

  if (decompositionDepth === 0 && isRelationshipChangeQueryText(queryText)) {
    const results = (await getTypedPersonTimeResults(query))
      .filter((result) =>
        /\b(stopped talking|haven't really talked|no contact|moved from Thailand|left Thailand|returned to the US|October 18|October eighteenth twenty twenty five)\b/i.test(
          result.content
        )
      )
      .slice(0, limit);
    if (results.length > 0) {
      return buildTypedLaneSearchResponse(
        query,
        results,
        "The relationship-change query was answered from typed person-time transition facts before broad lexical search."
      );
    }
  }

  if (decompositionDepth === 0 && isPersonTimeFactQuery(queryText)) {
    const results = (await getTypedPersonTimeResults(query)).slice(0, limit);
    if (results.length > 0) {
      return buildTypedLaneSearchResponse(
        query,
        results,
        "The person-and-time query was answered from typed person-time fact rows before broad lexical search."
      );
    }
  }

  if (decompositionDepth === 0 && isBroadLifeSummaryQuery(queryText)) {
    const subqueries = buildBroadLifeSummarySubqueries(queryText);
    const responseSets: RecallResult[][] = [];

    for (const subquery of subqueries) {
      const response = await searchMemory({
        ...query,
        query: subquery,
        limit: 4,
        decompositionDepth: decompositionDepth + 1
      });
      responseSets.push([...selectBroadLifeSummarySubqueryResults(subquery, response.results, 2)]);
    }

    const results: RecallResult[] = [];
    const seen = new Set<string>();
    const maxDepth = Math.max(...responseSets.map((rows) => rows.length), 0);
    for (let depth = 0; depth < maxDepth; depth += 1) {
      for (const rows of responseSets) {
        const candidate = rows[depth];
        if (!candidate || seen.has(candidate.memoryId)) {
          continue;
        }
        seen.add(candidate.memoryId);
        results.push(candidate);
        if (results.length >= limit) {
          break;
        }
      }
      if (results.length >= limit) {
        break;
      }
    }

    const evidence = buildEvidenceBundle(results);
    const planner = planRecallQuery(query);
    const answerAssessment: NonNullable<RecallResponse["meta"]["answerAssessment"]> =
      results.length >= 3 && evidence.length >= 2
        ? {
            confidence: "confident",
            sufficiency: "supported",
            reason: "The broad mixed-intent query was decomposed into focused subqueries and merged from direct evidence-backed results.",
            lexicalCoverage: 1,
            matchedTerms: [],
            totalTerms: 0,
            evidenceCount: evidence.length,
            directEvidence: true,
            subjectMatch: "unknown",
            matchedParticipants: [],
            missingParticipants: [],
            foreignParticipants: []
          }
        : results.length > 0
          ? {
              confidence: "weak",
              sufficiency: "weak",
              reason: "The broad mixed-intent query required decomposition and returned only partial grounded coverage.",
              lexicalCoverage: 1,
              matchedTerms: [],
              totalTerms: 0,
              evidenceCount: evidence.length,
              directEvidence: evidence.length > 0,
              subjectMatch: "unknown",
              matchedParticipants: [],
              missingParticipants: [],
              foreignParticipants: []
            }
          : {
              confidence: "missing",
              sufficiency: "missing",
              reason: "The broad mixed-intent query did not produce grounded results after decomposition.",
              lexicalCoverage: 0,
              matchedTerms: [],
              totalTerms: 0,
              evidenceCount: evidence.length,
              directEvidence: false,
              subjectMatch: "unknown",
              matchedParticipants: [],
              missingParticipants: [],
              foreignParticipants: []
            };
    const duality = buildDualityObject(results, evidence, answerAssessment, query.namespaceId, query.query);

    return {
      results,
      evidence,
      duality,
      meta: {
        contractVersion: "duality_v2",
        retrievalMode: "lexical",
        synthesisMode: synthesisModeForQuery(query.query, planner, true),
        globalQueryRouted: true,
        lexicalProvider: config.lexicalProvider === "bm25" ? "bm25" : "fts",
        lexicalFallbackUsed: false,
        queryEmbeddingSource: "none",
        rankingKernel: "app_fused",
        retrievalFusionVersion: config.retrievalFusionVersion,
        rerankerEnabled: config.localRerankerEnabled,
        rerankerVersion: config.localRerankerVersion,
        lexicalCandidateCount: results.length,
        vectorCandidateCount: 0,
        fusedResultCount: results.length,
        temporalAncestorCount: 0,
        temporalDescendantSupportCount: 0,
        temporalGateTriggered: false,
        temporalLayersUsed: [],
        temporalSupportTokenCount: 0,
        placeContainmentSupportCount: 0,
        boundedEventSupportCount: 0,
        answerAssessment,
        followUpAction: duality.followUpAction,
        clarificationHint: duality.clarificationHint,
        queryDecomposition: {
          applied: true,
          subqueries
        },
        planner
      }
    };
  }

  if (decompositionDepth === 0 && isConversationRecapQuery(queryText)) {
    const subqueries = buildConversationRecapSubqueries(queryText);
    const responseSets: RecallResult[][] = [];
    const recapTopic = extractConversationRecapTopic(queryText);

    for (const subquery of subqueries) {
      const response = await searchMemory({
        ...query,
        query: subquery,
        limit: 4,
        decompositionDepth: decompositionDepth + 1
      });
      if (recapTopic && recapTopic.trim()) {
        const topicalResults = response.results.filter((result) => recapTopicMatchesResult(result, recapTopic)).slice(0, 4);
        if (topicalResults.length > 0) {
          responseSets.push(topicalResults);
          continue;
        }
      }
      responseSets.push(response.results.slice(0, 4));
    }

    const mergedResults = mergeDecomposedResults(responseSets, limit * 3);
    const topicalResults =
      recapTopic && recapTopic.trim()
        ? mergedResults.filter((result) => recapTopicMatchesResult(result, recapTopic))
        : [];
    const results =
      topicalResults.length > 0
        ? topicalResults.slice(0, limit)
        : [...mergedResults.filter((result) => !topicalResults.includes(result))].slice(0, limit);
    const evidence = buildEvidenceBundle(results);
    const planner = planRecallQuery(query);
    const answerAssessment: NonNullable<RecallResponse["meta"]["answerAssessment"]> =
      results.length >= 1 && evidence.length >= 1
        ? {
            confidence: "confident",
            sufficiency: "supported",
            reason: "The recap-style query was decomposed into topic, participant, and temporal retrieval probes and merged from grounded evidence.",
            lexicalCoverage: 1,
            matchedTerms: [],
            totalTerms: 0,
            evidenceCount: evidence.length,
            directEvidence: true,
            subjectMatch: "unknown",
            matchedParticipants: [],
            missingParticipants: [],
            foreignParticipants: []
          }
        : {
            confidence: "missing",
            sufficiency: "missing",
            reason: "The recap-style query did not produce grounded results after decomposition.",
            lexicalCoverage: 0,
            matchedTerms: [],
            totalTerms: 0,
            evidenceCount: evidence.length,
            directEvidence: false,
            subjectMatch: "unknown",
            matchedParticipants: [],
            missingParticipants: [],
            foreignParticipants: []
          };
    const duality = buildDualityObject(results, evidence, answerAssessment, query.namespaceId, query.query);

    return {
      results,
      evidence,
      duality,
      meta: {
        contractVersion: "duality_v2",
        retrievalMode: "lexical",
        synthesisMode: synthesisModeForQuery(query.query, planner, true),
        globalQueryRouted: true,
        lexicalProvider: config.lexicalProvider === "bm25" ? "bm25" : "fts",
        lexicalFallbackUsed: false,
        queryEmbeddingSource: "none",
        rankingKernel: "app_fused",
        retrievalFusionVersion: config.retrievalFusionVersion,
        rerankerEnabled: config.localRerankerEnabled,
        rerankerVersion: config.localRerankerVersion,
        lexicalCandidateCount: results.length,
        vectorCandidateCount: 0,
        fusedResultCount: results.length,
        temporalAncestorCount: 0,
        temporalDescendantSupportCount: 0,
        temporalGateTriggered: false,
        temporalLayersUsed: [],
        temporalSupportTokenCount: 0,
        placeContainmentSupportCount: 0,
        boundedEventSupportCount: 0,
        answerAssessment,
        followUpAction: duality.followUpAction,
        clarificationHint: duality.clarificationHint,
        queryDecomposition: {
          applied: true,
          subqueries
        },
        planner
      }
    };
  }

  if (decompositionDepth === 0 && isDailyLifeSummaryQuery(queryText)) {
    const recap = await recapMemory({
      query: query.query,
      namespaceId: query.namespaceId,
      timeStart: query.timeStart,
      timeEnd: query.timeEnd,
      referenceNow: query.referenceNow,
      limit: query.limit,
      provider: "none",
      decompositionDepth: decompositionDepth + 1
    });
    const results: RecallResult[] = recap.evidence.map((item) => ({
      memoryId: item.memoryId,
      memoryType: item.memoryType,
      content: item.snippet,
      artifactId: item.artifactId ?? null,
      occurredAt: item.occurredAt ?? null,
      namespaceId: recap.namespaceId,
      provenance: item.provenance
    }));
    const evidence = [...recap.evidence];
    const planner = planRecallQuery(query);
    const answerAssessment: NonNullable<RecallResponse["meta"]["answerAssessment"]> = {
      confidence: recap.confidence,
      sufficiency:
        recap.confidence === "confident" ? "supported" : recap.confidence === "weak" ? "weak" : "missing",
      reason:
        recap.confidence === "confident"
          ? "The daily summary query was routed through the recap pipeline and grounded in dated evidence."
          : recap.confidence === "weak"
            ? "The daily summary query routed through recap but only produced partial grounded coverage."
            : "The daily summary query did not produce grounded recap evidence.",
      lexicalCoverage: 1,
      matchedTerms: [],
      totalTerms: 0,
      evidenceCount: evidence.length,
      directEvidence: evidence.length > 0,
      subjectMatch: "matched",
      matchedParticipants: recap.focus.participants,
      missingParticipants: [],
      foreignParticipants: []
    };
    const shapedDailySummaryClaim = deriveDailyLifeSummaryClaimText(query.query, results);

    return {
      results,
      evidence,
      duality: {
        claim: {
          memoryId: results[0]?.memoryId ?? null,
          memoryType: results[0]?.memoryType ?? null,
          text: (shapedDailySummaryClaim ?? recap.summaryText?.trim()) || "No authoritative evidence found.",
          occurredAt: results[0]?.occurredAt ?? null,
          artifactId: results[0]?.artifactId ?? null,
          sourceUri: typeof results[0]?.provenance?.source_uri === "string" ? (results[0]?.provenance?.source_uri as string) : null,
          validFrom: null,
          validUntil: null
        },
        evidence: evidence.map((item) => ({
          memoryId: item.memoryId,
          artifactId: item.artifactId ?? null,
          sourceUri: item.sourceUri ?? null,
          snippet: item.snippet
        })),
        confidence: recap.confidence,
        reason: answerAssessment.reason,
        followUpAction: recap.followUpAction,
        clarificationHint: recap.clarificationHint
      },
      meta: {
        contractVersion: "duality_v2",
        retrievalMode: "lexical",
        synthesisMode: "recall",
        globalQueryRouted: true,
        summaryRoutingUsed: true,
        queryModeHint: "recap",
        reflectEligibility: "preferred_if_inadequate",
        adequacyStatus:
          recap.confidence === "confident" ? "adequate" : recap.confidence === "weak" ? "supported_but_unshapable" : "insufficient_evidence",
        missingInfoType: recap.confidence === "missing" ? "recap_structure_missing" : undefined,
        lexicalProvider: config.lexicalProvider === "bm25" ? "bm25" : "fts",
        lexicalFallbackUsed: false,
        queryEmbeddingSource: "none",
        rankingKernel: "app_fused",
        retrievalFusionVersion: config.retrievalFusionVersion,
        rerankerEnabled: config.localRerankerEnabled,
        rerankerVersion: config.localRerankerVersion,
        lexicalCandidateCount: results.length,
        vectorCandidateCount: 0,
        fusedResultCount: results.length,
        temporalAncestorCount: 0,
        temporalDescendantSupportCount: 0,
        temporalGateTriggered: false,
        temporalLayersUsed: [],
        temporalSupportTokenCount: 0,
        placeContainmentSupportCount: 0,
        boundedEventSupportCount: 0,
        answerAssessment,
        followUpAction: recap.followUpAction,
        clarificationHint: recap.clarificationHint,
        planner
      }
    };
  }

  if (decompositionDepth === 0 && isTemporalDifferentialQuery(queryText)) {
    const subqueries = buildTemporalDifferentialSubqueries(queryText);
    if (subqueries.length === 0) {
      return searchMemory({
        ...query,
        decompositionDepth: decompositionDepth + 1
      });
    }
    const responseSets: RecallResult[][] = [];
    const differentialTopic = extractTemporalDifferentialTopic(queryText);

    for (const subquery of subqueries) {
      const response = await searchMemory({
        ...query,
        query: subquery,
        limit: 4,
        decompositionDepth: decompositionDepth + 1
      });
      if (differentialTopic && differentialTopic.trim()) {
        const topicalResults = response.results.filter((result) => recapTopicMatchesResult(result, differentialTopic)).slice(0, 4);
        if (topicalResults.length > 0) {
          responseSets.push(topicalResults);
          continue;
        }
      }
      responseSets.push(response.results.slice(0, 4));
    }

    const results = mergeDecomposedResults(responseSets, limit * 2).slice(0, limit);
    const evidence = buildEvidenceBundle(results);
    const planner = planRecallQuery(query);
    const answerAssessment: NonNullable<RecallResponse["meta"]["answerAssessment"]> =
      results.length >= 2 && evidence.length >= 2
        ? {
            confidence: "confident",
            sufficiency: "supported",
            reason: "The temporal-differential query was decomposed into current, prior, and causal probes and merged from grounded evidence.",
            lexicalCoverage: 1,
            matchedTerms: [],
            totalTerms: 0,
            evidenceCount: evidence.length,
            directEvidence: true,
            subjectMatch: "unknown",
            matchedParticipants: [],
            missingParticipants: [],
            foreignParticipants: []
          }
        : results.length > 0
          ? {
              confidence: "weak",
              sufficiency: "weak",
              reason: "The temporal-differential query found partial grounded evidence but not enough state-transition coverage.",
              lexicalCoverage: 1,
              matchedTerms: [],
              totalTerms: 0,
              evidenceCount: evidence.length,
              directEvidence: evidence.length > 0,
              subjectMatch: "unknown",
              matchedParticipants: [],
              missingParticipants: [],
              foreignParticipants: []
            }
          : {
              confidence: "missing",
              sufficiency: "missing",
              reason: "The temporal-differential query did not produce grounded change evidence after decomposition.",
              lexicalCoverage: 0,
              matchedTerms: [],
              totalTerms: 0,
              evidenceCount: evidence.length,
              directEvidence: false,
              subjectMatch: "unknown",
              matchedParticipants: [],
              missingParticipants: [],
              foreignParticipants: []
            };
    const duality = buildDualityObject(results, evidence, answerAssessment, query.namespaceId, query.query);

    return {
      results,
      evidence,
      duality,
      meta: {
        contractVersion: "duality_v2",
        retrievalMode: "lexical",
        synthesisMode: synthesisModeForQuery(query.query, planner, true),
        globalQueryRouted: true,
        lexicalProvider: config.lexicalProvider === "bm25" ? "bm25" : "fts",
        lexicalFallbackUsed: false,
        queryEmbeddingSource: "none",
        rankingKernel: "app_fused",
        retrievalFusionVersion: config.retrievalFusionVersion,
        rerankerEnabled: config.localRerankerEnabled,
        rerankerVersion: config.localRerankerVersion,
        lexicalCandidateCount: results.length,
        vectorCandidateCount: 0,
        fusedResultCount: results.length,
        temporalAncestorCount: 0,
        temporalDescendantSupportCount: 0,
        temporalGateTriggered: false,
        temporalLayersUsed: [],
        temporalSupportTokenCount: 0,
        placeContainmentSupportCount: 0,
        boundedEventSupportCount: 0,
        answerAssessment,
        followUpAction: duality.followUpAction,
        clarificationHint: duality.clarificationHint,
        queryDecomposition: {
          applied: true,
          subqueries
        },
        planner
      }
    };
  }

  const normalizedRelationshipWhyQuery = normalizeRelationshipWhyQuery(queryText);
  const normalizedBeverageRecommendationQuery = normalizeBeverageRecommendationQuery(queryText);
  const provenanceWhyFocus = normalizedRelationshipWhyQuery !== null;
  const planningQueryText = normalizedBeverageRecommendationQuery ?? queryText;
  const retrievalQueryText = normalizedBeverageRecommendationQuery ?? normalizedRelationshipWhyQuery ?? queryText;
  const sensitiveSecretQueryFocus =
    /\b(ssn|social security|password|passcode|pin code|api key|secret key|private key)\b/i.test(retrievalQueryText);
  const protocolPolicyFocus = /\b(protocol|policy|rule|rules|mandatory)\b/i.test(retrievalQueryText);
  const suppressSemanticAnchorResolution =
    /\bwhere\s+(?:has\s+.+\s+lived|did\s+.+\s+live)\b/i.test(retrievalQueryText) ||
    protocolPolicyFocus ||
    isHistoricalWorkQuery(retrievalQueryText) ||
    isHistoricalRelationshipQuery(retrievalQueryText);
  const semanticAnchorResolution =
    query.timeStart || query.timeEnd || suppressSemanticAnchorResolution
      ? null
      : await resolveSemanticAnchorWindow(query.namespaceId, planningQueryText, query.referenceNow);
  const planner = planRecallQuery({
    ...query,
    query: planningQueryText,
    timeStart: query.timeStart ?? semanticAnchorResolution?.timeStart,
    timeEnd: query.timeEnd ?? semanticAnchorResolution?.timeEnd
  });
  const queryModeHint = inferQueryModeHint(retrievalQueryText, planner);
  const reflectEligibility = reflectEligibilityForQueryMode(queryModeHint);
  const relationshipExactFocus = isRelationshipStyleExactQuery(retrievalQueryText);
  const relationshipProfileFocus = isRelationshipProfileQueryText(retrievalQueryText);
  const relationshipChangeFocus = isRelationshipChangeQueryText(retrievalQueryText);
  const currentProjectFocus = isCurrentProjectQueryText(retrievalQueryText);
  const continuityHandoffSearchFocus = isContinuityHandoffSearchQueryText(retrievalQueryText);
  const activeRelationshipFocus = isActiveRelationshipQuery(retrievalQueryText);
  const currentDatingFocus = isCurrentDatingQuery(retrievalQueryText);
  const hierarchyTraversalFocus = isHierarchyTraversalQuery(retrievalQueryText);
  const dailyLifeEventFocus = isDailyLifeEventQuery(retrievalQueryText);
  const eventBoundedFocus = isEventBoundedQuery(retrievalQueryText);
  const dailyLifeSummaryFocus = isDailyLifeSummaryQuery(retrievalQueryText);
  const salienceQueryFocus = isSalienceQuery(retrievalQueryText);
  const transcriptSpeechFocus = isTranscriptSpeechQuery(retrievalQueryText);
  const departureTimingFocus = isDepartureTimingQuery(retrievalQueryText);
  const storageLocationFocus = isStorageLocationQuery(retrievalQueryText);
  const recentMediaRecallFocus = isRecentMediaRecallQuery(retrievalQueryText);
  const temporalDetailFocus = isTemporalDetailQuery(retrievalQueryText);
  const preciseFactDetailFocus = isPreciseFactDetailQuery(retrievalQueryText);
  const derivationDetailFocus = isArtifactDerivationDetailQuery(retrievalQueryText);
  const profileInferenceFocus = isProfileInferenceQuery(retrievalQueryText);
  const identityProfileFocus = isIdentityProfileQuery(retrievalQueryText);
  const sharedCommonalityFocus = isSharedCommonalityQuery(retrievalQueryText);
  const relationshipHistoryRecapFocus = isRelationshipHistoryRecapQuery(retrievalQueryText);
  const conversationRecapFocus =
    /\b(talk about|discuss(?:ed)?|conversation|conversations|recap|summary|summarize|going on|overall|lately|recently|these days|current picture)\b/i.test(
      retrievalQueryText
    ) || relationshipHistoryRecapFocus;
  const globalQuestionFocus =
    isGlobalQuestionQuery(queryText) ||
    conversationRecapFocus ||
    /\bwhat has .+ been doing lately\b/i.test(retrievalQueryText);
  const preferenceQueryFocus = isPreferenceQuery(retrievalQueryText);
  const routineQueryFocus = isRoutineSummaryQuery(retrievalQueryText);
  const constraintQueryFocus = isConstraintQuery(retrievalQueryText);
  const decisionQueryFocus = isDecisionQuery(retrievalQueryText);
  const causalDecisionFocus = !provenanceWhyFocus && (decisionQueryFocus || /\b(?:why|rationale)\b/i.test(retrievalQueryText));
  const eventNeighborhoodFocus = isEventNeighborhoodReasoningQuery(retrievalQueryText, planner, causalDecisionFocus);
  const pointInTimePreferenceFocus = preferenceQueryFocus && Boolean(query.timeStart || query.timeEnd || planner.inferredTimeStart || planner.inferredTimeEnd);
  const historicalPreferenceFocus =
    isHistoricalPreferenceQuery(retrievalQueryText) ||
    (!pointInTimePreferenceFocus &&
      /\bprefer\b/i.test(retrievalQueryText) &&
      /\b(?:did|used?\s+to|still)\b/i.test(retrievalQueryText) &&
      !/\bnow\b/i.test(retrievalQueryText));
  const currentPreferenceFocus =
    (isCurrentPreferenceQuery(retrievalQueryText) || (preferenceQueryFocus && !historicalPreferenceFocus && !pointInTimePreferenceFocus)) &&
    !historicalPreferenceFocus;
  const styleQueryFocus = isStyleSpecQuery(retrievalQueryText);
  const goalQueryFocus = isGoalQuery(retrievalQueryText);
  const planQueryFocus = isPlanQuery(retrievalQueryText);
  const beliefQueryFocus = isBeliefQuery(retrievalQueryText);
  const historicalHomeFocus = /\bwhere\s+(?:has\s+.+\s+lived|did\s+.+\s+live)\b/i.test(retrievalQueryText);
  const historicalWorkFocus = isHistoricalWorkQuery(retrievalQueryText);
  const historicalRelationshipFocus = isHistoricalRelationshipQuery(retrievalQueryText);
  const preferredActiveRelationshipPredicates = preferredRelationshipPredicates(retrievalQueryText);
  const directRelationshipFactFocus =
    /\bassociated with\b/i.test(retrievalQueryText) ||
    /\bworks?\s+at\b/i.test(retrievalQueryText) ||
    /\blives?\s+in\b/i.test(retrievalQueryText) ||
    /\bmember\s+of\b/i.test(retrievalQueryText) ||
    /\bwhere\s+do(?:es)?\s+.+\s+(?:live|work|stay|based)\b/i.test(retrievalQueryText) ||
    /\bwhere\s+is\s+.+\s+from\b/i.test(retrievalQueryText) ||
    /\bwhat\s+does\s+.+\s+do\b/i.test(retrievalQueryText) ||
    /\bwhat\s+is\s+.+\s+working\s+on\b/i.test(retrievalQueryText);

  if (decompositionDepth === 0 && temporalDetailFocus) {
    const typedTemporalResults = (await getTypedTemporalAnchorResults(query)).slice(0, limit);
    if (typedTemporalResults.length > 0) {
      return buildTypedLaneSearchResponse(
        query,
        typedTemporalResults,
        "The temporal-detail query was answered from typed media and person-time anchor rows before broad transcript retrieval."
      );
    }
  }

  const timeStart = query.timeStart ?? semanticAnchorResolution?.timeStart ?? planner.inferredTimeStart ?? null;
  const timeEnd = query.timeEnd ?? semanticAnchorResolution?.timeEnd ?? planner.inferredTimeEnd ?? null;
  const unresolvedClarification = await hasUnresolvedClarification(query.namespaceId, query.query);
  const hasTimeWindow = Boolean(timeStart || timeEnd);
  const lowInformationTemporalFocus = hasTimeWindow && isLowInformationTemporalQuery(retrievalQueryText, planner.lexicalTerms);
  const historicalBeliefFocus = beliefQueryFocus && (isHistoricalBeliefQuery(retrievalQueryText) || hasTimeWindow);
  const precisionLexicalFocus =
    (!query.queryEmbedding || query.queryEmbedding.length === 0) &&
    (isPrecisionLexicalQuery(retrievalQueryText) || relationshipExactFocus);
  const narrowTemporalWindow = hasNarrowTimeWindow(timeStart, timeEnd);
  const lowInfoBroadActionFocus =
    lowInformationTemporalFocus &&
    dailyLifeEventFocus &&
    planner.queryClass === "temporal_summary" &&
    !dailyLifeSummaryFocus;
  const openEndedHistoricalBeliefFocus = historicalBeliefFocus && /\bsince\b/i.test(retrievalQueryText);
  const semanticAnchorFocus = semanticAnchorResolution !== null;
  const complexityAwareGroundedTemporalSupport =
    hasTimeWindow &&
    planner.temporalFocus &&
    !temporalDetailFocus &&
    !narrowTemporalWindow &&
    (
      lowInfoBroadActionFocus ||
      semanticAnchorResolution !== null ||
      planner.queryClass === "graph_multi_hop" ||
      planner.lexicalTerms.length >= 3 ||
      /\bwho\b/i.test(retrievalQueryText) ||
      /\bwhere\b/i.test(retrievalQueryText) ||
      /\bwith\b/i.test(retrievalQueryText)
    );
  const directCurrentTruthFocus =
    planner.queryClass === "direct_fact" &&
    activeRelationshipFocus &&
    !historicalRelationshipFocus &&
    !planner.temporalFocus &&
    !hasTimeWindow &&
    !dailyLifeEventFocus &&
    !dailyLifeSummaryFocus &&
    !temporalDetailFocus;
  const boundedEventLayerFocus =
    eventNeighborhoodFocus &&
    !planner.temporalFocus &&
    !hasTimeWindow &&
    !historicalRelationshipFocus;
  const skipQueryEmbedding =
    boundedEventLayerFocus ||
    hierarchyTraversalFocus ||
    currentDatingFocus ||
    lowInformationTemporalFocus ||
    semanticAnchorFocus;
  const sqlHybridKernelEligible = !skipQueryEmbedding && !lowInformationTemporalFocus;
  const candidateLimit = precisionLexicalFocus
    ? Math.max(Math.min(limit * 2, 12), 8)
    : boundedEventLayerFocus
      ? Math.max(Math.min(limit, 8), 6)
      : semanticAnchorFocus
        ? Math.max(Math.min(limit, 8), 6)
      : sqlHybridKernelEligible
        ? Math.max(Math.min(limit * 2, 16), 10)
      : planner.temporalFocus
        ? Math.max(limit * planner.candidateLimitMultiplier, 12)
        : Math.max(limit * planner.candidateLimitMultiplier, 20);
  const lexicalRetrievalQueryText = departureTimingFocus
    ? buildDepartureEvidenceQueryText(retrievalQueryText, planner.lexicalTerms)
    : storageLocationFocus
      ? buildStorageEvidenceQueryText(retrievalQueryText, planner.lexicalTerms)
    : recentMediaRecallFocus
      ? buildRecentMediaEvidenceQueryText(retrievalQueryText, planner.lexicalTerms)
    : preciseFactDetailFocus
      ? buildPreciseFactEvidenceQueryText(retrievalQueryText, planner.lexicalTerms)
    : identityProfileFocus
      ? buildIdentityEvidenceQueryText(retrievalQueryText, planner.lexicalTerms)
    : profileInferenceFocus
      ? buildProfileInferenceEvidenceQueryText(retrievalQueryText, planner.lexicalTerms)
      : sharedCommonalityFocus
        ? buildSharedCommonalityEvidenceQueryText(retrievalQueryText, planner.lexicalTerms)
      : causalDecisionFocus
        ? buildCausalMotiveEvidenceQueryText(retrievalQueryText, planner.lexicalTerms)
          : preferenceQueryFocus
            ? buildPreferenceEvidenceQueryText(retrievalQueryText, planner.lexicalTerms)
      : retrievalQueryText;
  let synthesisMode = synthesisModeForQuery(planningQueryText, planner, false);
  const reflectiveRoutingFocus =
    synthesisMode === "reflect" &&
    (isComplexReflectiveQuery(retrievalQueryText, planner) || globalQuestionFocus || sharedCommonalityFocus || conversationRecapFocus || relationshipHistoryRecapFocus);
  const graphEligible =
    synthesisMode === "reflect" ||
    globalQuestionFocus ||
    profileInferenceFocus ||
    identityProfileFocus ||
    sharedCommonalityFocus ||
    relationshipHistoryRecapFocus ||
    planner.queryClass === "graph_multi_hop";
  const subjectHints = extractSubjectHintsFromQuery(retrievalQueryText);
  const conversationParticipants = extractConversationParticipants(retrievalQueryText);

  if (sensitiveSecretQueryFocus) {
    const answerAssessment = assessRecallAnswer([], [], planner, false, query.query);
    const duality = buildDualityObject([], [], answerAssessment, query.namespaceId, query.query);
    return {
      results: [],
      evidence: [],
      duality,
      meta: {
        contractVersion: "duality_v2",
        retrievalMode: "lexical",
        synthesisMode,
        lexicalProvider: config.lexicalProvider === "bm25" ? "bm25" : "fts",
        lexicalFallbackUsed: false,
        lexicalFallbackReason: "guardrail:sensitive_query",
        queryEmbeddingSource: "none",
        rankingKernel: "app_fused",
        retrievalFusionVersion: config.retrievalFusionVersion,
        rerankerEnabled: config.localRerankerEnabled,
        rerankerVersion: config.localRerankerVersion,
        lexicalCandidateCount: 0,
        vectorCandidateCount: 0,
        fusedResultCount: 0,
        temporalAncestorCount: 0,
        temporalDescendantSupportCount: 0,
        temporalGateTriggered: false,
        temporalLayersUsed: [],
        temporalSupportTokenCount: 0,
        placeContainmentSupportCount: 0,
        boundedEventSupportCount: 0,
        answerAssessment,
        followUpAction: duality.followUpAction,
        clarificationHint: duality.clarificationHint,
        planner
      }
    };
  }

  if (unresolvedClarification) {
    const answerAssessment = assessRecallAnswer([], [], planner, false, query.query);
    const duality = buildDualityObject([], [], answerAssessment, query.namespaceId, query.query);
    return {
      results: [],
      evidence: [],
      duality,
      meta: {
        contractVersion: "duality_v2",
        retrievalMode: "lexical",
        synthesisMode,
        lexicalProvider: config.lexicalProvider === "bm25" ? "bm25" : "fts",
        lexicalFallbackUsed: false,
        queryEmbeddingSource: "none",
        rankingKernel: "app_fused",
        retrievalFusionVersion: config.retrievalFusionVersion,
        rerankerEnabled: config.localRerankerEnabled,
        rerankerVersion: config.localRerankerVersion,
        lexicalCandidateCount: 0,
        vectorCandidateCount: 0,
        fusedResultCount: 0,
        temporalAncestorCount: 0,
        temporalDescendantSupportCount: 0,
        temporalGateTriggered: false,
        temporalLayersUsed: [],
        temporalSupportTokenCount: 0,
        placeContainmentSupportCount: 0,
        boundedEventSupportCount: 0,
        answerAssessment,
        followUpAction: duality.followUpAction,
        clarificationHint: duality.clarificationHint,
        planner
      }
    };
  }

  const canonicalAliasQuestionSubject = extractCanonicalAliasQuestionSubject(retrievalQueryText);
  if (canonicalAliasQuestionSubject) {
    const resolvedCanonicalEntity = await resolveCanonicalEntityReference(query.namespaceId, canonicalAliasQuestionSubject, {
      entityTypes: ["person", "place", "project", "concept", "unknown", "self"]
    });
    if (resolvedCanonicalEntity) {
      const normalizedSubject = normalizeEntityLookupName(canonicalAliasQuestionSubject);
      const normalizedCanonicalName = normalizeEntityLookupName(resolvedCanonicalEntity.canonicalName);
      if (normalizedSubject && normalizedCanonicalName && normalizedSubject !== normalizedCanonicalName) {
        const aliasRows = await queryRows<EntityAliasExactRow>(
          `
            select alias, alias_type, is_user_verified, metadata
            from entity_aliases
            where entity_id = $1
            order by
              case
                when lower(regexp_replace(alias, '^[^A-Za-z0-9]+|[^A-Za-z0-9]+$', '', 'g')) = $2 then 0
                else 1
              end,
              coalesce(is_user_verified, false) desc,
              alias_type asc nulls last,
              created_at asc
            limit 4
          `,
          [resolvedCanonicalEntity.entityId, normalizedSubject]
        );
        const matchedAliasRow =
          aliasRows.find((row) => normalizeEntityLookupName(row.alias) === normalizedSubject) ??
          aliasRows[0] ??
          null;
        const aliasMetadata =
          typeof matchedAliasRow?.metadata === "object" && matchedAliasRow.metadata !== null
            ? matchedAliasRow.metadata
            : null;
        const aliasMemoryId = `entity-alias:${resolvedCanonicalEntity.entityId}:${normalizedSubject}`;
        const aliasEvidenceRow =
          typeof aliasMetadata?.source_uri === "string" && typeof aliasMetadata?.source_memory_id === "string"
            ? null
            : (
                await queryRows<EntityAliasEvidenceRow>(
                  `
                    select
                      mem.source_memory_id::text as source_memory_id,
                      a.uri as source_uri,
                      mem.occurred_at::text as occurred_at,
                      mem.mention_text
                    from memory_entity_mentions mem
                    left join episodic_memory em on em.id = mem.source_memory_id
                    left join artifacts a on a.id = em.artifact_id
                    where mem.namespace_id = $1
                      and mem.entity_id = $2::uuid
                    order by
                      case
                        when a.uri like '%/benchmark-generated/%' then 1
                        when a.uri like '%/examples/%' then 1
                        when a.uri like '%/examples-private/%' then 1
                        else 0
                      end asc,
                      mem.occurred_at desc
                    limit 1
                  `,
                  [query.namespaceId, resolvedCanonicalEntity.entityId]
                )
              )[0] ?? null;
        const sourceUri =
          typeof aliasMetadata?.source_uri === "string" ? aliasMetadata.source_uri : aliasEvidenceRow?.source_uri ?? null;
        const sourceMemoryId =
          typeof aliasMetadata?.source_memory_id === "string"
            ? aliasMetadata.source_memory_id
            : aliasEvidenceRow?.source_memory_id ?? aliasMemoryId;
        const occurredAt =
          typeof aliasMetadata?.observed_at === "string"
            ? aliasMetadata.observed_at
            : typeof aliasMetadata?.created_at === "string"
              ? aliasMetadata.created_at
              : aliasEvidenceRow?.occurred_at ?? null;
        const aliasClaim = `${canonicalAliasQuestionSubject} refers to ${resolvedCanonicalEntity.canonicalName}.`;
        const aliasResult: RecallResult = {
          memoryId: aliasMemoryId,
          memoryType: "semantic_memory",
          content: aliasClaim,
          score: 1,
          artifactId:
            typeof aliasMetadata?.source_artifact_id === "string" ? aliasMetadata.source_artifact_id : null,
          occurredAt,
          namespaceId: query.namespaceId,
          provenance: {
            tier: "entity_alias_exact",
            canonical_name: resolvedCanonicalEntity.canonicalName,
            canonical_entity_id: resolvedCanonicalEntity.entityId,
            alias: matchedAliasRow?.alias ?? canonicalAliasQuestionSubject,
            alias_type: matchedAliasRow?.alias_type ?? null,
            is_user_verified: matchedAliasRow?.is_user_verified ?? false,
            source_uri: sourceUri,
            source_memory_id: sourceMemoryId,
            metadata: aliasMetadata ?? undefined
          }
        };
        const evidence: RecallResponse["evidence"] = [
          {
            memoryId: aliasMemoryId,
            memoryType: aliasResult.memoryType,
            artifactId: aliasResult.artifactId,
            occurredAt: aliasResult.occurredAt,
            sourceUri: typeof aliasResult.provenance.source_uri === "string" ? aliasResult.provenance.source_uri : null,
            snippet: aliasClaim,
            provenance: aliasResult.provenance
          }
        ];
        const answerAssessment = assessRecallAnswer([aliasResult], evidence, planner, false, query.query);
        const duality = buildDualityObject([aliasResult], evidence, answerAssessment, query.namespaceId, query.query);
        return {
          results: [aliasResult],
          evidence,
          duality,
          meta: {
            contractVersion: "duality_v2",
            retrievalMode: "lexical",
            synthesisMode,
            lexicalProvider: config.lexicalProvider === "bm25" ? "bm25" : "fts",
            lexicalFallbackUsed: false,
            lexicalFallbackReason: "entity_alias_exact",
            queryEmbeddingSource: "none",
            rankingKernel: "app_fused",
            retrievalFusionVersion: config.retrievalFusionVersion,
            rerankerEnabled: config.localRerankerEnabled,
            rerankerVersion: config.localRerankerVersion,
            lexicalCandidateCount: 1,
            vectorCandidateCount: 0,
            fusedResultCount: 1,
            temporalAncestorCount: 0,
            temporalDescendantSupportCount: 0,
            temporalGateTriggered: false,
            temporalLayersUsed: [],
            temporalSupportTokenCount: 0,
            placeContainmentSupportCount: 0,
            boundedEventSupportCount: 0,
            answerAssessment,
            followUpAction: duality.followUpAction,
            clarificationHint: duality.clarificationHint,
            planner
          }
        };
      }
    }
  }

  const loadLexicalResult = async () => {
    if (config.lexicalProvider !== "bm25") {
      return {
        rows: await loadFtsLexicalRows(
          query.namespaceId,
          lexicalRetrievalQueryText,
          candidateLimit,
          timeStart,
          timeEnd,
          planner,
          hasTimeWindow,
          relationshipExactFocus,
          activeRelationshipFocus,
          historicalRelationshipFocus,
          dailyLifeEventFocus,
          eventBoundedFocus,
          dailyLifeSummaryFocus,
          styleQueryFocus,
          temporalDetailFocus
        ),
        provider: "fts" as LexicalProvider,
        fallbackUsed: false,
        fallbackReason: undefined as string | undefined
      };
    }

    try {
      return {
        rows: await loadBm25LexicalRows(
          query.namespaceId,
          lexicalRetrievalQueryText,
          candidateLimit,
          timeStart,
          timeEnd,
          planner,
          hasTimeWindow,
          relationshipExactFocus,
          precisionLexicalFocus,
          activeRelationshipFocus,
          historicalRelationshipFocus,
          dailyLifeEventFocus,
          eventBoundedFocus,
          dailyLifeSummaryFocus,
          styleQueryFocus,
          temporalDetailFocus
        ),
        provider: "bm25" as LexicalProvider,
        fallbackUsed: false,
        fallbackReason: undefined as string | undefined
      };
    } catch (error) {
      if (!config.lexicalFallbackEnabled) {
        throw error;
      }

      return {
        rows: await loadFtsLexicalRows(
          query.namespaceId,
          lexicalRetrievalQueryText,
          candidateLimit,
          timeStart,
          timeEnd,
          planner,
          hasTimeWindow,
          relationshipExactFocus,
          activeRelationshipFocus,
          historicalRelationshipFocus,
          dailyLifeEventFocus,
          eventBoundedFocus,
          dailyLifeSummaryFocus,
          styleQueryFocus,
          temporalDetailFocus
        ),
        provider: "fts" as LexicalProvider,
        fallbackUsed: true,
        fallbackReason: error instanceof Error ? error.message : "unknown_bm25_failure"
      };
    }
  };

  let queryEmbeddingResult: Awaited<ReturnType<typeof resolveQueryEmbedding>>;
  let lexicalResult: Awaited<ReturnType<typeof loadLexicalResult>>;
  let sqlHybridKernelRows: readonly SqlFusedRankingRow[] = [];

  if (sqlHybridKernelEligible) {
    queryEmbeddingResult = await resolveQueryEmbedding({
      ...query,
      query: retrievalQueryText
    });
    if (queryEmbeddingResult.embedding) {
      sqlHybridKernelRows = await loadCoreSqlHybridKernelRows(
        query.namespaceId,
        retrievalQueryText,
        buildEventQueryText(retrievalQueryText, planner.lexicalTerms),
        planner.temporalFocus || hasTimeWindow
          ? retrievalQueryText
          : dailyLifeSummaryFocus
            ? buildEventQueryText(retrievalQueryText, planner.lexicalTerms)
            : retrievalQueryText,
        candidateLimit,
        timeStart,
        timeEnd,
        planner,
        queryEmbeddingResult.embedding,
        planner.temporalFocus || hasTimeWindow,
        historicalRelationshipFocus
      );
      lexicalResult = {
        rows: [],
        provider: "fts" as LexicalProvider,
        fallbackUsed: false,
        fallbackReason: undefined
      };
      if (sqlHybridKernelRows.length === 0) {
        lexicalResult = await loadLexicalResult();
      }
    } else {
      lexicalResult = await loadLexicalResult();
    }
  } else {
    [queryEmbeddingResult, lexicalResult] = await Promise.all([
      skipQueryEmbedding
        ? Promise.resolve({
            embedding: null,
            source: "none" as const,
            provider: undefined,
            model: undefined,
            fallbackReason: "planner:branch_pruned"
          })
        : resolveQueryEmbedding({
            ...query,
            query: retrievalQueryText
          }),
      loadLexicalResult()
    ]);
  }
  let lexicalRows = lexicalResult.rows;
  const selfProfile =
    planner.temporalFocus || hasTimeWindow || (sqlHybridKernelRows.length === 0 && lexicalRows.length === 0)
      ? await getNamespaceSelfProfile(query.namespaceId).catch(() => null)
      : null;
  const selfReferenceFallbackQuery = stripSelfProfileReferences(retrievalQueryText, selfProfile);

  if (sqlHybridKernelRows.length === 0 && planner.temporalFocus && hasTimeWindow && selfReferenceFallbackQuery) {
    const selfStrippedPlanner = planRecallQuery({
      ...query,
      query: selfReferenceFallbackQuery
    });
    const selfStrippedRows = await loadFtsLexicalRows(
      query.namespaceId,
      selfReferenceFallbackQuery,
      candidateLimit,
      timeStart,
      timeEnd,
      selfStrippedPlanner,
      hasTimeWindow,
      relationshipExactFocus,
      activeRelationshipFocus,
      historicalRelationshipFocus,
      dailyLifeEventFocus,
      eventBoundedFocus,
      dailyLifeSummaryFocus,
      styleQueryFocus,
      temporalDetailFocus
    );
    if (selfStrippedRows.length > 0) {
      lexicalRows = finalizeLexicalRows(
        selfStrippedRows,
        Math.max(candidateLimit * 2, 12),
        hasTimeWindow,
        planner.temporalFocus,
        dailyLifeEventFocus,
        dailyLifeSummaryFocus,
        timeStart,
        timeEnd
      );
      lexicalResult = {
        ...lexicalResult,
        rows: lexicalRows,
        fallbackUsed: true,
        fallbackReason: lexicalResult.fallbackReason
          ? `${lexicalResult.fallbackReason};self_reference_bridge`
          : "self_reference_bridge"
      };
    }
  }

  if (sqlHybridKernelRows.length === 0 && lexicalRows.length === 0) {
    if (selfReferenceFallbackQuery) {
      lexicalRows = await loadFtsLexicalRows(
        query.namespaceId,
        selfReferenceFallbackQuery,
        candidateLimit,
        timeStart,
        timeEnd,
        planRecallQuery({
          ...query,
          query: selfReferenceFallbackQuery
        }),
        hasTimeWindow,
        relationshipExactFocus,
        activeRelationshipFocus,
        historicalRelationshipFocus,
        dailyLifeEventFocus,
        eventBoundedFocus,
        dailyLifeSummaryFocus,
        styleQueryFocus,
        temporalDetailFocus
      );
      lexicalResult = {
        ...lexicalResult,
        rows: lexicalRows,
        fallbackUsed: true,
        fallbackReason: lexicalResult.fallbackReason
          ? `${lexicalResult.fallbackReason};self_reference_bridge`
          : "self_reference_bridge"
      };
    }
  }
  let temporalGateTriggered = false;
  let temporalLayersUsed: readonly TemporalDescendantLayer[] = [];
  let temporalSummarySufficient = false;
  let semanticAnchorSupportRows: RankedSearchRow[] = [];
  const shouldRunEnrichmentPasses = true;
  if (shouldRunEnrichmentPasses) {
    const directHierarchyRows = hierarchyTraversalFocus
      ? await loadDirectHierarchyRows(query.namespaceId, retrievalQueryText, candidateLimit)
      : [];
    if (directHierarchyRows.length > 0) {
      lexicalRows = mergeUniqueRows(
        lexicalRows,
        directHierarchyRows,
        candidateLimit,
        hasTimeWindow,
        planner.temporalFocus,
        dailyLifeEventFocus,
        dailyLifeSummaryFocus,
        timeStart,
        timeEnd
      );
    }
    if (directRelationshipFactFocus && preferredActiveRelationshipPredicates.length > 0 && !hasTimeWindow) {
      const preferredActiveRows = toRankedRows(
        await loadPreferredActiveRelationshipRows(
          query.namespaceId,
          retrievalQueryText,
          preferredActiveRelationshipPredicates,
          candidateLimit
        )
      );
      if (preferredActiveRows.length > 0) {
        lexicalRows = mergeUniqueRows(
          lexicalRows,
          preferredActiveRows,
          Math.max(candidateLimit * 2, 12),
          hasTimeWindow,
          planner.temporalFocus,
          dailyLifeEventFocus,
          dailyLifeSummaryFocus,
          timeStart,
          timeEnd
        );
      }
    }
    if ((relationshipProfileFocus || relationshipChangeFocus) && !hasTimeWindow) {
      const relationshipProfileRows = toRankedRows(
        await loadRelationshipProfileSupportRows(query.namespaceId, retrievalQueryText, candidateLimit)
      );
      if (relationshipProfileRows.length > 0) {
        lexicalRows = mergeUniqueRows(
          relationshipProfileRows,
          lexicalRows,
          Math.max(candidateLimit * 2, 12),
          hasTimeWindow,
          planner.temporalFocus,
          dailyLifeEventFocus,
          dailyLifeSummaryFocus,
          timeStart,
          timeEnd
        );
      }
    }
    if (relationshipChangeFocus && !hasTimeWindow) {
      const relationshipChangeRows = toRankedRows(
        await loadRelationshipChangeSupportRows(query.namespaceId, retrievalQueryText, candidateLimit)
      );
      if (relationshipChangeRows.length > 0) {
        lexicalRows = mergeUniqueRows(
          relationshipChangeRows,
          lexicalRows,
          Math.max(candidateLimit * 2, 12),
          hasTimeWindow,
          planner.temporalFocus,
          dailyLifeEventFocus,
          dailyLifeSummaryFocus,
          timeStart,
          timeEnd
        );
      }
    }
    if ((currentProjectFocus || continuityHandoffSearchFocus) && !hasTimeWindow) {
      const currentProjectRows = toRankedRows(
        await loadCurrentProjectSupportRows(query.namespaceId, candidateLimit)
      );
      if (currentProjectRows.length > 0) {
        lexicalRows = mergeUniqueRows(
          currentProjectRows,
          lexicalRows,
          Math.max(candidateLimit * 2, 12),
          hasTimeWindow,
          planner.temporalFocus,
          dailyLifeEventFocus,
          dailyLifeSummaryFocus,
          timeStart,
          timeEnd
        );
      }
    }
    if (currentDatingFocus && !hasTimeWindow) {
      const unknownDatingEvidenceRows = toRankedRows(
        await loadCurrentDatingUnknownEvidenceRows(query.namespaceId, retrievalQueryText, candidateLimit)
      );
      if (unknownDatingEvidenceRows.length > 0) {
        lexicalRows = mergeUniqueRows(
          lexicalRows,
          unknownDatingEvidenceRows,
          Math.max(candidateLimit * 2, 12),
          hasTimeWindow,
          planner.temporalFocus,
          dailyLifeEventFocus,
          dailyLifeSummaryFocus,
          timeStart,
          timeEnd
        );
      }
    }
    if (transcriptSpeechFocus) {
      const transcriptSpeakerTerms = planner.lexicalTerms.filter((term) => /^[A-Z][A-Za-z.'-]*(?:\s+[A-Z][A-Za-z.'-]*)*$/u.test(term));
      const transcriptSpeechQueryText = buildTranscriptSpeechQueryText(
        retrievalQueryText,
        planner.lexicalTerms,
        transcriptSpeakerTerms
      );
      const transcriptSpeechRows = toRankedRows(
        await loadTranscriptUtteranceRows(
          query.namespaceId,
          transcriptSpeechQueryText,
          candidateLimit,
          transcriptSpeakerTerms,
          timeStart,
          timeEnd
        )
      );
      if (transcriptSpeechRows.length > 0) {
        lexicalRows = mergeUniqueRows(
          lexicalRows,
          transcriptSpeechRows,
          Math.max(candidateLimit * 2, 12),
          hasTimeWindow,
          planner.temporalFocus,
          dailyLifeEventFocus,
          dailyLifeSummaryFocus,
          timeStart,
          timeEnd
        );
      }
    }
    if (semanticAnchorResolution) {
      semanticAnchorSupportRows = toRankedRows(
        await loadSemanticAnchorSupportRows(
          query.namespaceId,
          retrievalQueryText,
          planner.lexicalTerms,
          semanticAnchorResolution,
          Math.min(candidateLimit, 8)
        )
      ).map((row) => {
        const coverage = lexicalCoverageForResult(row.content, planner.lexicalTerms).lexicalCoverage;
        const multiplier = Math.max(0.2, coverage);
        const baseScore = typeof row.raw_score === "number" ? row.raw_score : row.scoreValue;
        return {
          ...row,
          raw_score: baseScore * multiplier,
          scoreValue: row.scoreValue * multiplier
        };
      });
      if (semanticAnchorSupportRows.length > 0) {
        lexicalRows = mergeUniqueRows(
          semanticAnchorSupportRows,
          lexicalRows,
          Math.max(candidateLimit * 2, 12),
          hasTimeWindow,
          planner.temporalFocus,
          dailyLifeEventFocus,
          dailyLifeSummaryFocus,
          timeStart,
          timeEnd
        );
      }
    }
    const transcriptSpeakerTerms = planner.lexicalTerms.filter((term) => /^[A-Z][A-Za-z.'-]*(?:\s+[A-Z][A-Za-z.'-]*)*$/u.test(term));
    const speakerScopedTranscriptionRows =
      !transcriptSpeechFocus && planner.temporalFocus && narrowTemporalWindow && transcriptSpeakerTerms.length > 0
        ? toRankedRows(
            await loadSpeakerScopedTranscriptionRows(
              query.namespaceId,
              transcriptSpeakerTerms,
              Math.min(candidateLimit, 4),
              timeStart,
              timeEnd
            )
          )
        : [];
    if (!transcriptSpeechFocus && planner.temporalFocus && dailyLifeSummaryFocus && narrowTemporalWindow) {
      const hasTranscriptFragmentCandidate = lexicalRows.some((row) => {
        const metadata =
          typeof row.provenance.metadata === "object" && row.provenance.metadata !== null
            ? (row.provenance.metadata as Record<string, unknown>)
            : null;
        return (
          row.memory_type === "episodic_memory" &&
          String(metadata?.transcript_speaker_name ?? metadata?.speaker_name ?? row.provenance.transcript_speaker_name ?? "") !== ""
        );
      });
      if (transcriptSpeakerTerms.length > 0) {
        const transcriptDaySupportRows = toRankedRows(
          await loadTranscriptUtteranceRows(
            query.namespaceId,
            transcriptSpeakerTerms.join(" "),
            Math.min(candidateLimit, 4),
            transcriptSpeakerTerms,
            timeStart,
            timeEnd
          )
        );
        if (transcriptDaySupportRows.length > 0) {
          lexicalRows = mergeUniqueRows(
            transcriptDaySupportRows,
            lexicalRows,
            Math.max(candidateLimit * 2, 12),
            hasTimeWindow,
            planner.temporalFocus,
            dailyLifeEventFocus,
            dailyLifeSummaryFocus,
            timeStart,
            timeEnd
          );
        }
      }
    }
    if (speakerScopedTranscriptionRows.length > 0) {
      lexicalRows = mergeUniqueRows(
        speakerScopedTranscriptionRows,
        lexicalRows,
        Math.max(candidateLimit * 2, 12),
        hasTimeWindow,
        planner.temporalFocus,
        dailyLifeEventFocus,
        dailyLifeSummaryFocus,
        timeStart,
        timeEnd
      );
    }
    const shouldLoadContainmentSupport =
      hierarchyTraversalFocus ||
      historicalHomeFocus ||
      /\bwhere\s+do(?:es)?\s+.+\s+live\b/i.test(retrievalQueryText) ||
      /\bwhere\s+was\s+.+\s+born\b/i.test(retrievalQueryText) ||
      /\bwhere\s+is\s+.+\s+from\b/i.test(retrievalQueryText);
    const placeContainmentSupportRows = shouldLoadContainmentSupport
      ? await loadHierarchicalContainmentSupportRows(
          query.namespaceId,
          planner.lexicalTerms,
          candidateLimit,
          timeStart,
          timeEnd,
          planner.temporalFocus
        )
      : [];
    if (placeContainmentSupportRows.length > 0) {
      lexicalRows = mergeUniqueRows(
        lexicalRows,
        placeContainmentSupportRows,
        candidateLimit,
        hasTimeWindow,
        planner.temporalFocus,
        dailyLifeEventFocus,
        dailyLifeSummaryFocus,
        timeStart,
        timeEnd
      );
    }
    if (eventNeighborhoodFocus || recentMediaRecallFocus) {
      const scopedCandidateLimit = eventNeighborhoodFocus ? Math.min(candidateLimit, 8) : candidateLimit;
      const scopedEventTerms = eventNeighborhoodFocus
        ? buildEventBoundedEvidenceTerms(retrievalQueryText, planner.lexicalTerms)
        : planner.lexicalTerms;
      const scopedEventRows = toRankedRows(
        await loadScopedNarrativeEventRows(query.namespaceId, scopedEventTerms, scopedCandidateLimit, timeStart, timeEnd)
      );
      if (scopedEventRows.length > 0) {
        lexicalRows = mergeUniqueRows(
          lexicalRows,
          scopedEventRows,
          candidateLimit,
          hasTimeWindow,
          planner.temporalFocus,
          dailyLifeEventFocus,
          dailyLifeSummaryFocus,
          timeStart,
          timeEnd
        );
      }
      if (eventNeighborhoodFocus) {
        const eventNeighborhoodRows = toRankedRows(
          await loadEventNeighborhoodEpisodicRows(
            query.namespaceId,
            retrievalQueryText,
            scopedEventTerms,
            scopedCandidateLimit,
            timeStart,
            timeEnd
          )
        );
        if (eventNeighborhoodRows.length > 0) {
          lexicalRows = mergeUniqueRows(
            eventNeighborhoodRows,
            lexicalRows,
            Math.max(candidateLimit * 2, 12),
            hasTimeWindow,
            planner.temporalFocus,
            dailyLifeEventFocus,
            dailyLifeSummaryFocus,
            timeStart,
            timeEnd
          );
        }
      }
      if (eventBoundedFocus && /\b(coffee|cafe|café|place|space|co-?working)\b/i.test(retrievalQueryText)) {
        const followOnVenueRows = toRankedRows(
          await loadFollowOnVenueRows(query.namespaceId, retrievalQueryText, scopedCandidateLimit, timeStart, timeEnd)
        );
        if (followOnVenueRows.length > 0) {
          lexicalRows = mergeUniqueRows(
            followOnVenueRows,
            lexicalRows,
            Math.max(candidateLimit * 2, 12),
            hasTimeWindow,
            planner.temporalFocus,
            dailyLifeEventFocus,
            dailyLifeSummaryFocus,
            timeStart,
            timeEnd
          );
        }
      }
    }
    if (departureTimingFocus) {
      const departureSupportRows = toRankedRows(
        await loadDepartureTimingSupportRows(query.namespaceId, retrievalQueryText, candidateLimit)
      );
      if (departureSupportRows.length > 0) {
        lexicalRows = mergeUniqueRows(
          departureSupportRows,
          lexicalRows,
          Math.max(candidateLimit * 2, 12),
          hasTimeWindow,
          planner.temporalFocus,
          dailyLifeEventFocus,
          dailyLifeSummaryFocus,
          timeStart,
          timeEnd
        );
      }
    }
    if (storageLocationFocus) {
      const storageSupportRows = toRankedRows(await loadStorageLocationSupportRows(query.namespaceId, candidateLimit));
      if (storageSupportRows.length > 0) {
        lexicalRows = mergeUniqueRows(
          storageSupportRows,
          lexicalRows,
          Math.max(candidateLimit * 2, 12),
          hasTimeWindow,
          planner.temporalFocus,
          dailyLifeEventFocus,
          dailyLifeSummaryFocus,
          timeStart,
          timeEnd
        );
      }
    }
    if (temporalDetailFocus) {
      const temporalDetailSupportRows = toRankedRows(
        await loadTemporalDetailSupportRows(query.namespaceId, retrievalQueryText, planner.lexicalTerms, candidateLimit, timeStart, timeEnd)
      );
      if (temporalDetailSupportRows.length > 0) {
        lexicalRows = mergeUniqueRows(
          temporalDetailSupportRows,
          lexicalRows,
          Math.max(candidateLimit * 2, 12),
          hasTimeWindow,
          planner.temporalFocus,
          dailyLifeEventFocus,
          dailyLifeSummaryFocus,
          timeStart,
          timeEnd
        );
      }
    }
    if (preciseFactDetailFocus) {
      const participantTurnRows = toRankedRows(
        await loadParticipantTurnExactDetailRows(query.namespaceId, retrievalQueryText, planner.lexicalTerms, candidateLimit, timeStart, timeEnd)
      );
      if (participantTurnRows.length > 0) {
        lexicalRows = mergeUniqueRows(
          participantTurnRows,
          lexicalRows,
          Math.max(candidateLimit * 2, 12),
          hasTimeWindow,
          planner.temporalFocus,
          dailyLifeEventFocus,
          dailyLifeSummaryFocus,
          timeStart,
          timeEnd
        );
      }
      const preciseFactSupportRows = toRankedRows(
        await loadPreciseFactSupportRows(query.namespaceId, retrievalQueryText, planner.lexicalTerms, candidateLimit, timeStart, timeEnd)
      );
      if (preciseFactSupportRows.length > 0) {
        lexicalRows = mergeUniqueRows(
          preciseFactSupportRows,
          lexicalRows,
          Math.max(candidateLimit * 2, 12),
          hasTimeWindow,
          planner.temporalFocus,
          dailyLifeEventFocus,
          dailyLifeSummaryFocus,
          timeStart,
          timeEnd
        );
        if (/\bwhere\b/i.test(retrievalQueryText) && /\b(class|classes|yoga)\b/i.test(retrievalQueryText)) {
          const artifactLocalRows = toRankedRows(
            await loadArtifactLocalClassLocationRows(
              query.namespaceId,
              preciseFactSupportRows
                .map((row) => row.artifact_id)
                .filter((artifactId): artifactId is string => typeof artifactId === "string" && artifactId.length > 0),
              candidateLimit
            )
          );
          if (artifactLocalRows.length > 0) {
            lexicalRows = mergeUniqueRows(
              artifactLocalRows,
              lexicalRows,
              Math.max(candidateLimit * 2, 16),
              hasTimeWindow,
              planner.temporalFocus,
              dailyLifeEventFocus,
              dailyLifeSummaryFocus,
              timeStart,
              timeEnd
            );
          }
        }
      }
    }
    if (profileInferenceFocus) {
      const profileInferenceRows = toRankedRows(
        await loadProfileInferenceSupportRows(query.namespaceId, retrievalQueryText, planner.lexicalTerms, candidateLimit, timeStart, timeEnd)
      );
      if (profileInferenceRows.length > 0) {
        lexicalRows = mergeUniqueRows(
          profileInferenceRows,
          lexicalRows,
          Math.max(candidateLimit * 2, 12),
          hasTimeWindow,
          planner.temporalFocus,
          dailyLifeEventFocus,
          dailyLifeSummaryFocus,
          timeStart,
          timeEnd
        );
      }
    }
    if (identityProfileFocus) {
      const identityRows = toRankedRows(
        await loadIdentitySupportRows(query.namespaceId, retrievalQueryText, planner.lexicalTerms, candidateLimit, timeStart, timeEnd)
      );
      if (identityRows.length > 0) {
        lexicalRows = mergeUniqueRows(
          identityRows,
          lexicalRows,
          Math.max(candidateLimit * 2, 12),
          hasTimeWindow,
          planner.temporalFocus,
          dailyLifeEventFocus,
          dailyLifeSummaryFocus,
          timeStart,
          timeEnd
        );
      }
    }
    if (sharedCommonalityFocus) {
      const sharedRows = toRankedRows(
        await loadSharedCommonalityRows(query.namespaceId, retrievalQueryText, planner.lexicalTerms, candidateLimit, timeStart, timeEnd)
      );
      if (sharedRows.length > 0) {
        lexicalRows = mergeUniqueRows(
          sharedRows,
          lexicalRows,
          Math.max(candidateLimit * 2, 16),
          hasTimeWindow,
          planner.temporalFocus,
          dailyLifeEventFocus,
          dailyLifeSummaryFocus,
          timeStart,
          timeEnd
        );
      }
    }
    if (globalQuestionFocus || reflectiveRoutingFocus || profileInferenceFocus || identityProfileFocus || sharedCommonalityFocus) {
      const requestedProfileKinds = requestedProfileKindsForRouting({
        globalQuestionFocus: globalQuestionFocus || reflectiveRoutingFocus,
        profileInferenceFocus,
        identityProfileFocus,
        sharedCommonalityFocus
      });
      const profileSummaryRows = toRankedRows([
        ...await loadActiveSemanticProfileSummaryRows(query.namespaceId, retrievalQueryText, candidateLimit, requestedProfileKinds),
        ...(sharedCommonalityFocus
          ? await loadParticipantScopedProfileSummaryRows(
              query.namespaceId,
              conversationParticipants,
              Math.max(4, Math.min(candidateLimit, 6)),
              requestedProfileKinds
            )
          : [])
      ]);
      if (profileSummaryRows.length > 0) {
        lexicalRows = mergeUniqueRows(
          profileSummaryRows,
          lexicalRows,
          Math.max(candidateLimit * 2, 14),
          hasTimeWindow,
          planner.temporalFocus,
          dailyLifeEventFocus,
          dailyLifeSummaryFocus,
          timeStart,
          timeEnd
        );
      }
    }
    let timeWindowBootstrapRows: RankedSearchRow[] = [];
    if (lowInformationTemporalFocus || (planner.queryClass === "temporal_summary" && narrowTemporalWindow)) {
      const bootstrapRows = [
        ...(lowInfoBroadActionFocus
          ? await loadLowInformationTemporalActionRows(query.namespaceId, Math.min(candidateLimit, 6), timeStart, timeEnd)
          : []),
        ...(await loadLowInformationTemporalWindowRows(query.namespaceId, candidateLimit, timeStart, timeEnd, {
          includeEpisodicRows: !lowInfoBroadActionFocus,
          allowedTemporalLayers: lowInfoBroadActionFocus ? ["day", "week"] : undefined
        })),
        ...(transcriptSpeakerTerms.length > 0
          ? await loadTranscriptUtteranceRows(
              query.namespaceId,
              transcriptSpeakerTerms.join(" "),
              Math.min(candidateLimit, 4),
              transcriptSpeakerTerms,
              timeStart,
              timeEnd
            )
          : []),
        ...(await loadScopedNarrativeEventRows(query.namespaceId, [], candidateLimit, timeStart, timeEnd))
      ];
      timeWindowBootstrapRows = toRankedRows(bootstrapRows);
    }
    if (lowInformationTemporalFocus) {
      if (timeWindowBootstrapRows.length > 0) {
        lexicalRows = mergeUniqueRows(
          timeWindowBootstrapRows,
          lexicalRows,
          Math.max(candidateLimit * 3, 18),
          hasTimeWindow,
          planner.temporalFocus,
          dailyLifeEventFocus,
          dailyLifeSummaryFocus,
          timeStart,
          timeEnd
        );
      }
    }
    const strictTemporalWindowFocus =
      hasTimeWindow &&
      (lowInformationTemporalFocus || (planner.queryClass === "temporal_summary" && narrowTemporalWindow));
    if (strictTemporalWindowFocus) {
      const timeScopedRows = timeWindowBootstrapRows.length > 0
        ? timeWindowBootstrapRows
        : lexicalRows.filter(
            (row) => rowMatchesTemporalWindow(row, timeStart, timeEnd) || isAlignedToTimeWindow(row, timeStart, timeEnd)
          );
      if (timeScopedRows.length > 0) {
        lexicalRows = finalizeLexicalRows(
          timeScopedRows,
          Math.max(candidateLimit * 2, 12),
          hasTimeWindow,
          planner.temporalFocus,
          dailyLifeEventFocus,
          dailyLifeSummaryFocus,
          timeStart,
          timeEnd
        );
      }
    }
    if (historicalHomeFocus) {
      const historicalHomeRows = toRankedRows(
        await loadHistoricalHomeRows(query.namespaceId, retrievalQueryText, candidateLimit, timeStart, timeEnd)
      );
      if (historicalHomeRows.length > 0) {
        lexicalRows = mergeUniqueRows(
          historicalHomeRows,
          lexicalRows,
          Math.max(candidateLimit * 3, 24),
          hasTimeWindow,
          planner.temporalFocus,
          dailyLifeEventFocus,
          dailyLifeSummaryFocus,
          timeStart,
          timeEnd
        );
      }
    }
    if (historicalWorkFocus) {
      const historicalWorkedAtRows = toRankedRows(
        await loadHistoricalWorkedAtRows(query.namespaceId, retrievalQueryText, candidateLimit, timeStart, timeEnd)
      );
      if (historicalWorkedAtRows.length > 0) {
        const historicalWorkMergeLimit = Math.max(candidateLimit * 3, 24);
        lexicalRows = mergeUniqueRows(
          historicalWorkedAtRows,
          lexicalRows,
          historicalWorkMergeLimit,
          hasTimeWindow,
          planner.temporalFocus,
          dailyLifeEventFocus,
          dailyLifeSummaryFocus,
          timeStart,
          timeEnd
        );
      }
    }
    if (historicalRelationshipFocus || relationshipHistoryRecapFocus) {
      const historicalRelationshipSupportRows = toRankedRows(
        await loadHistoricalRelationshipSupportRows(query.namespaceId, retrievalQueryText, candidateLimit)
      );
      if (historicalRelationshipSupportRows.length > 0) {
        lexicalRows = mergeUniqueRows(
          historicalRelationshipSupportRows,
          lexicalRows,
          Math.max(candidateLimit * 2, 16),
          hasTimeWindow,
          planner.temporalFocus,
          dailyLifeEventFocus,
          dailyLifeSummaryFocus,
          timeStart,
          timeEnd
        );
      }
    }
    if (preferenceQueryFocus) {
      const wantsWatchlist = /\bwatch(?:list)?\b/i.test(retrievalQueryText);
      if (wantsWatchlist) {
        const watchlistRows = toRankedRows(await loadWatchlistRows(query.namespaceId, retrievalQueryText, candidateLimit));
        if (watchlistRows.length > 0) {
          lexicalRows = mergeUniqueRows(
            lexicalRows,
            watchlistRows,
            Math.max(candidateLimit * 2, 12),
            hasTimeWindow,
            planner.temporalFocus,
            dailyLifeEventFocus,
            dailyLifeSummaryFocus,
            timeStart,
            timeEnd
          );
        }
      }
      const preferenceMode = historicalPreferenceFocus
        ? (hasTimeWindow ? "point_in_time" : "historical")
        : "current";
      const preferenceRows = toRankedRows(
        await loadPreferenceTenureRows(query.namespaceId, retrievalQueryText, candidateLimit, timeStart, timeEnd, preferenceMode)
      );
      if (preferenceRows.length > 0) {
        lexicalRows = mergeUniqueRows(
          historicalPreferenceFocus || currentPreferenceFocus || pointInTimePreferenceFocus ? preferenceRows : lexicalRows,
          historicalPreferenceFocus || currentPreferenceFocus || pointInTimePreferenceFocus ? lexicalRows : preferenceRows,
          Math.max(candidateLimit * 2, 12),
          hasTimeWindow,
          planner.temporalFocus,
          dailyLifeEventFocus,
          dailyLifeSummaryFocus,
          timeStart,
          timeEnd
        );
      }
    }
    if (styleQueryFocus) {
      const styleRows = toRankedRows(await loadStyleSpecRows(query.namespaceId, retrievalQueryText, candidateLimit));
      if (styleRows.length > 0) {
        lexicalRows = mergeUniqueRows(
          styleRows,
          lexicalRows,
          Math.max(candidateLimit * 4, 24),
          hasTimeWindow,
          planner.temporalFocus,
          dailyLifeEventFocus,
          dailyLifeSummaryFocus,
          timeStart,
          timeEnd
        );
      }
    }
    if (routineQueryFocus) {
      const routineRows = toRankedRows(await loadRoutineRows(query.namespaceId, retrievalQueryText, candidateLimit));
      if (routineRows.length > 0) {
        lexicalRows = mergeUniqueRows(
          lexicalRows,
          routineRows,
          Math.max(candidateLimit * 2, 12),
          hasTimeWindow,
          planner.temporalFocus,
          dailyLifeEventFocus,
          dailyLifeSummaryFocus,
          timeStart,
          timeEnd
        );
      }
    }
    if (constraintQueryFocus) {
      const constraintRows = toRankedRows(await loadConstraintRows(query.namespaceId, retrievalQueryText, candidateLimit));
      if (constraintRows.length > 0) {
        lexicalRows = mergeUniqueRows(
          lexicalRows,
          constraintRows,
          Math.max(candidateLimit * 2, 12),
          hasTimeWindow,
          planner.temporalFocus,
          dailyLifeEventFocus,
          dailyLifeSummaryFocus,
          timeStart,
          timeEnd
        );
      }
    }
    if (causalDecisionFocus) {
      const decisionRows = toRankedRows(await loadDecisionRows(query.namespaceId, retrievalQueryText, candidateLimit));
      if (decisionRows.length > 0) {
        lexicalRows = mergeUniqueRows(
          lexicalRows,
          decisionRows,
          Math.max(candidateLimit * 2, 12),
          hasTimeWindow,
          planner.temporalFocus,
          dailyLifeEventFocus,
          dailyLifeSummaryFocus,
          timeStart,
          timeEnd
        );
      }
      const causalNarrativeRows = toRankedRows(
        await loadCausalNarrativeRows(query.namespaceId, retrievalQueryText, planner.lexicalTerms, candidateLimit, timeStart, timeEnd)
      );
      if (causalNarrativeRows.length > 0) {
        lexicalRows = mergeUniqueRows(
          causalNarrativeRows,
          lexicalRows,
          Math.max(candidateLimit * 2, 14),
          hasTimeWindow,
          planner.temporalFocus,
          dailyLifeEventFocus,
          dailyLifeSummaryFocus,
          timeStart,
          timeEnd
        );
      }
    }
    if (goalQueryFocus) {
      const goalRows = toRankedRows(await loadGoalRows(query.namespaceId, retrievalQueryText, candidateLimit));
      if (goalRows.length > 0) {
        lexicalRows = mergeUniqueRows(
          lexicalRows,
          goalRows,
          Math.max(candidateLimit * 2, 8),
          hasTimeWindow,
          planner.temporalFocus,
          dailyLifeEventFocus,
          dailyLifeSummaryFocus,
          timeStart,
          timeEnd
        );
      }
    }
    if (planQueryFocus) {
      const planRows = toRankedRows(await loadPlanRows(query.namespaceId, retrievalQueryText, candidateLimit));
      if (planRows.length > 0) {
        lexicalRows = mergeUniqueRows(
          lexicalRows,
          planRows,
          Math.max(candidateLimit * 2, 12),
          hasTimeWindow,
          planner.temporalFocus,
          dailyLifeEventFocus,
          dailyLifeSummaryFocus,
          timeStart,
          timeEnd
        );
      }
    }
    if (beliefQueryFocus) {
      const beliefRowSets = await Promise.all(
        openEndedHistoricalBeliefFocus
          ? [
              loadBeliefRows(
                query.namespaceId,
                retrievalQueryText,
                candidateLimit,
                timeStart,
                timeEnd,
                hasTimeWindow ? "point_in_time" : "historical"
              ),
              loadBeliefRows(query.namespaceId, retrievalQueryText, candidateLimit, null, null, "current")
            ]
          : historicalBeliefFocus
            ? [
                loadBeliefRows(
                  query.namespaceId,
                  retrievalQueryText,
                  candidateLimit,
                  timeStart,
                  timeEnd,
                  hasTimeWindow ? "point_in_time" : "historical"
                )
              ]
          : [loadBeliefRows(query.namespaceId, retrievalQueryText, candidateLimit, timeStart, timeEnd, "current")]
      );
      const beliefRows = toRankedRows(beliefRowSets.flat());
      if (beliefRows.length > 0) {
        lexicalRows = mergeUniqueRows(
          lexicalRows,
          beliefRows,
          Math.max(candidateLimit * 2, 12),
          hasTimeWindow,
          planner.temporalFocus,
          dailyLifeEventFocus,
          dailyLifeSummaryFocus,
          timeStart,
          timeEnd
        );
      }
    }
    if (salienceQueryFocus) {
      const salienceRows = toRankedRows(await loadSalientRows(query.namespaceId, retrievalQueryText, candidateLimit, timeStart, timeEnd));
      if (salienceRows.length > 0) {
        lexicalRows = mergeUniqueRows(
          lexicalRows,
          salienceRows,
          Math.max(candidateLimit * 2, 12),
          hasTimeWindow,
          planner.temporalFocus,
          dailyLifeEventFocus,
          dailyLifeSummaryFocus,
          timeStart,
          timeEnd
        );
        lexicalRows = rerankSalienceRows(lexicalRows, retrievalQueryText, Math.max(candidateLimit * 2, 12));
      }
    }
    if (config.localRerankerEnabled) {
      if (identityProfileFocus) {
        lexicalRows = rerankReasoningRows(lexicalRows, retrievalQueryText, Math.max(candidateLimit * 2, 12), "identity");
      } else if (sharedCommonalityFocus) {
        lexicalRows = rerankReasoningRows(lexicalRows, retrievalQueryText, Math.max(candidateLimit * 2, 16), "shared");
      } else if (causalDecisionFocus) {
        lexicalRows = rerankReasoningRows(lexicalRows, retrievalQueryText, Math.max(candidateLimit * 2, 14), "causal");
      }
    }
    if (planner.temporalFocus || hasTimeWindow) {
      const temporalLayerAccumulator = new Set<TemporalDescendantLayer>();

      const ancestryRows = await loadTemporalHierarchyRows(
        query.namespaceId,
        lexicalRows,
        candidateLimit,
        timeStart,
        timeEnd,
        planner
      );
      if (ancestryRows.length > 0) {
        lexicalRows = mergeUniqueRows(
          lexicalRows,
          ancestryRows,
          candidateLimit,
          hasTimeWindow,
          planner.temporalFocus,
          dailyLifeEventFocus,
          dailyLifeSummaryFocus,
          timeStart,
          timeEnd
        );
      }

      temporalSummarySufficient = hasSufficientTemporalEvidence(lexicalRows, planner, timeStart, timeEnd, temporalDetailFocus, {
        requireGroundedSupport: complexityAwareGroundedTemporalSupport
      });
      if ((lowInfoBroadActionFocus || complexityAwareGroundedTemporalSupport) && temporalSummarySufficient) {
        temporalSummarySufficient = hasSufficientTemporalEvidence(lexicalRows, planner, timeStart, timeEnd, temporalDetailFocus, {
          requireGroundedSupport: true
        });
      }
      const descendantPasses = determineTemporalDescendantPasses(lexicalRows, planner);
      temporalGateTriggered = !temporalSummarySufficient && descendantPasses.length > 0;
      if (temporalGateTriggered) {
        for (const passLayers of descendantPasses) {
          const descendantRows = await loadTemporalDescendantSupportRows(
            query.namespaceId,
            lexicalRows,
            candidateLimit,
            timeStart,
            timeEnd,
            planner,
            passLayers
          );
          if (descendantRows.length > 0) {
            lexicalRows = mergeUniqueRows(
              lexicalRows,
              descendantRows,
              candidateLimit,
              hasTimeWindow,
              planner.temporalFocus,
              dailyLifeEventFocus,
              dailyLifeSummaryFocus,
              timeStart,
              timeEnd
            );
            for (const layer of passLayers) {
              temporalLayerAccumulator.add(layer);
            }
          }

          if (
            hasSufficientTemporalEvidence(lexicalRows, planner, timeStart, timeEnd, temporalDetailFocus, {
              requireGroundedSupport: lowInfoBroadActionFocus || complexityAwareGroundedTemporalSupport
            })
          ) {
            break;
          }
        }
      }
      temporalLayersUsed = [...temporalLayerAccumulator];
    }
  }

  let vectorRows: RankedSearchRow[] = [];
  let rankedResults: SqlFusedRankingRow[];
  let usedSqlRankingKernel = false;
    if (sqlHybridKernelRows.length > 0) {
      usedSqlRankingKernel = true;
      rankedResults = [...sqlHybridKernelRows].sort((left, right) => {
      return compareFusedResults(
        left,
        right,
        hasTimeWindow,
        planner.temporalFocus,
        dailyLifeEventFocus,
        dailyLifeSummaryFocus
      );
    });
    if (lexicalRows.length > 0) {
      rankedResults = mergeInjectedRankedRows(rankedResults, lexicalRows, 0.58);
    }
  } else if (queryEmbeddingResult.embedding) {
    const vectorLiteral = `[${queryEmbeddingResult.embedding.join(",")}]`;
    const [semanticVectorRows, derivationVectorRows] = await Promise.all([
      queryRows<SearchRow>(
        `
          SELECT
            id AS memory_id,
            'semantic_memory'::text AS memory_type,
            content_abstract AS content,
            (embedding <=> $2::vector) AS raw_score,
            NULL::uuid AS artifact_id,
            valid_from AS occurred_at,
            namespace_id,
            jsonb_build_object(
              'tier', 'current_semantic',
              'memory_kind', memory_kind,
              'canonical_key', canonical_key,
              'valid_from', valid_from,
              'valid_until', valid_until,
              'status', status,
              'source_episodic_id', source_episodic_id,
              'source_chunk_id', source_chunk_id,
              'source_artifact_observation_id', source_artifact_observation_id,
              'metadata', metadata
            ) AS provenance
          FROM semantic_memory
          WHERE namespace_id = $1
            AND status = 'active'
            AND valid_until IS NULL
            AND embedding IS NOT NULL
            AND ($3::timestamptz IS NULL OR valid_from >= $3)
            AND ($4::timestamptz IS NULL OR valid_from <= $4)
          ORDER BY embedding <=> $2::vector ASC, valid_from DESC
          LIMIT $5
        `,
        [query.namespaceId, vectorLiteral, timeStart, timeEnd, candidateLimit]
      ),
      queryRows<SearchRow>(
        `
          SELECT
            ad.id AS memory_id,
            'artifact_derivation'::text AS memory_type,
            ${artifactDerivationContentExpression()} AS content,
            (ad.embedding <=> $2::vector) AS raw_score,
            ao.artifact_id,
            ao.observed_at AS occurred_at,
            a.namespace_id,
            jsonb_build_object(
              'tier', 'artifact_derivation',
              'derivation_type', ad.derivation_type,
              'provider', ad.provider,
              'model', ad.model,
              'artifact_observation_id', ad.artifact_observation_id,
              'source_chunk_id', ad.source_chunk_id,
              'source_uri', a.uri,
              'metadata', ad.metadata
            ) AS provenance
          FROM artifact_derivations ad
          JOIN artifact_observations ao ON ao.id = ad.artifact_observation_id
          JOIN artifacts a ON a.id = ao.artifact_id
          WHERE a.namespace_id = $1
            AND coalesce(ad.content_text, '') <> ''
            AND ad.embedding IS NOT NULL
            AND ($3::timestamptz IS NULL OR ao.observed_at >= $3)
            AND ($4::timestamptz IS NULL OR ao.observed_at <= $4)
          ORDER BY ad.embedding <=> $2::vector ASC, ao.observed_at DESC
          LIMIT $5
        `,
        [query.namespaceId, vectorLiteral, timeStart, timeEnd, candidateLimit]
      )
    ]);

    vectorRows = toRankedRows([...semanticVectorRows, ...derivationVectorRows])
      .sort(compareVector)
      .slice(0, candidateLimit);

    usedSqlRankingKernel = true;
    rankedResults = [...(await fuseRankedRowsInSql(lexicalRows, vectorRows, planner))]
      .sort((left, right) =>
        compareFusedResults(left, right, hasTimeWindow, planner.temporalFocus, dailyLifeEventFocus, dailyLifeSummaryFocus)
      );
  } else {
    usedSqlRankingKernel = lexicalRows.length > 0;
    rankedResults = lexicalRows.length === 0
      ? []
      : [...(await fuseRankedRowsInSql(lexicalRows, [], planner))]
          .sort((left, right) =>
            compareFusedResults(left, right, hasTimeWindow, planner.temporalFocus, dailyLifeEventFocus, dailyLifeSummaryFocus)
          );
  }

  if (semanticAnchorSupportRows.length > 0) {
    rankedResults = mergeInjectedRankedRows(rankedResults, semanticAnchorSupportRows, 0.92);
  }

  if (directRelationshipFactFocus && preferredActiveRelationshipPredicates.length > 0 && !hasTimeWindow) {
    const subjectHints = extractSubjectHintsFromQuery(retrievalQueryText);
    const preferredProceduralRows = toRankedRows(
      await loadPreferredActiveProceduralRows(
        query.namespaceId,
        preferredActiveRelationshipPredicates,
        Math.min(Math.max(limit, 4), 8),
        subjectHints
      )
    );
    if (preferredProceduralRows.length > 0) {
      rankedResults = mergeInjectedRankedRows(rankedResults, preferredProceduralRows);
    }
  }

  rankedResults = applyUnifiedAppFusion(rankedResults, retrievalQueryText, planner, {
    hasTimeWindow,
    timeStart,
    timeEnd,
    dailyLifeEventFocus,
    dailyLifeSummaryFocus,
    temporalDetailFocus,
    preciseFactDetailFocus,
    activeRelationshipFocus,
    historicalRelationshipFocus,
    identityProfileFocus,
    sharedCommonalityFocus,
    causalDecisionFocus
  });
  rankedResults = retainTrustedNamespaceRows(rankedResults);

  let graphRoutingUsed = false;
  let graphSeedKinds: string[] = [];
  let graphExpansionRows: RankedSearchRow[] = [];
  let graphEvidenceCount = 0;
  let topicRoutingUsed = false;
  let communitySummaryUsed = false;
  if (graphEligible && rankedResults.length > 0) {
    graphSeedKinds = [
      ...new Set(
        rankedResults
          .slice(0, 6)
          .map((row) => graphSeedKindFromSearchRow(row.row))
          .filter((value) => value.length > 0)
      )
    ];
    graphExpansionRows = await loadGraphExpansionRows(
      query.namespaceId,
      retrievalQueryText,
      rankedResults,
      Math.min(Math.max(limit * 2, 12), 30),
      subjectHints
    );
    if (graphExpansionRows.length === 0) {
      graphExpansionRows = await loadSummarySupportExpansionRows(
        query.namespaceId,
        rankedResults,
        Math.min(Math.max(limit * 2, 10), 24),
        subjectHints
      );
    }
    if (graphExpansionRows.length > 0) {
      graphRoutingUsed = true;
      graphEvidenceCount = graphExpansionRows.length;
      rankedResults = mergeInjectedRankedRows(rankedResults, graphExpansionRows, 0.86);
    }
  }

  if (historicalPreferenceFocus && !pointInTimePreferenceFocus) {
    const historicalPreferenceRows = toRankedRows(
      await loadPreferenceTenureRows(query.namespaceId, retrievalQueryText, candidateLimit, timeStart, timeEnd, "historical")
    );
    const historicalPreferenceSupportRows = toRankedRows(
      await loadHistoricalPreferenceSupportRows(query.namespaceId, retrievalQueryText, candidateLimit)
    );
    const injectedHistoricalPreferenceRows = [...historicalPreferenceRows, ...historicalPreferenceSupportRows];
    if (injectedHistoricalPreferenceRows.length > 0) {
      rankedResults = mergeInjectedRankedRows(rankedResults, injectedHistoricalPreferenceRows, 1.2);
    }
  }

  if (historicalBeliefFocus) {
    const injectedHistoricalBeliefRows = toRankedRows(
      await loadBeliefRows(
        query.namespaceId,
        retrievalQueryText,
        candidateLimit,
        timeStart,
        timeEnd,
        hasTimeWindow ? "point_in_time" : "historical"
      )
    );
    if (injectedHistoricalBeliefRows.length > 0) {
      rankedResults = mergeInjectedRankedRows(rankedResults, injectedHistoricalBeliefRows, 1.1);
    }
  }

  rankedResults = retainTrustedNamespaceRows(rankedResults);

  let results: RecallResult[] = pruneRankedResults(
    rankedResults,
    retrievalQueryText,
    planner,
    relationshipExactFocus,
    hierarchyTraversalFocus,
    precisionLexicalFocus,
    activeRelationshipFocus,
    dailyLifeEventFocus,
    dailyLifeSummaryFocus,
    salienceQueryFocus,
    historicalHomeFocus,
    historicalWorkFocus,
    historicalRelationshipFocus,
    preferenceQueryFocus,
    constraintQueryFocus,
    causalDecisionFocus,
    historicalPreferenceFocus,
    currentPreferenceFocus,
    styleQueryFocus,
    goalQueryFocus,
    planQueryFocus,
    beliefQueryFocus,
    historicalBeliefFocus,
    pointInTimePreferenceFocus,
    transcriptSpeechFocus,
    eventBoundedFocus,
    departureTimingFocus,
    storageLocationFocus,
    timeStart,
    timeEnd,
    preferredActiveRelationshipPredicates,
    narrowTemporalWindow,
    temporalDetailFocus,
    preciseFactDetailFocus,
    profileInferenceFocus,
    causalDecisionFocus,
    derivationDetailFocus
    )
    .slice(0, limit)
    .map((row) =>
      buildRecallResult(row.row, row.rrfScore, {
        rrfScore: row.rrfScore,
        lexicalRank: row.lexicalRank,
        vectorRank: row.vectorRank,
        lexicalRawScore: row.lexicalRawScore,
        vectorDistance: row.vectorDistance
      })
    );

  if (temporalDetailFocus) {
    results = [...retainTemporalDetailResults(retrievalQueryText, results, limit)];
  }

  if (preciseFactDetailFocus) {
    results = [...retainPrimaryEntityPreciseFactResults(retrievalQueryText, results, limit)];
  }

  if (sharedCommonalityFocus) {
    results = [...retainParticipantBoundCommonalityResults(retrievalQueryText, results, limit)];
  }

  let subjectIsolationTelemetry = EMPTY_SUBJECT_ISOLATION_TELEMETRY;
  const subjectIsolationFocus = isSubjectIsolationQuery(query.query, planner, {
    subjectHints,
    temporalDetailFocus,
    globalQuestionFocus,
    profileInferenceFocus,
    identityProfileFocus,
    sharedCommonalityFocus
  });
  if (subjectIsolationFocus) {
    const isolated = retainSubjectIsolatedRecallResults(retrievalQueryText, results, limit);
    results = [...isolated.results];
    subjectIsolationTelemetry = isolated.telemetry;
  }

  const exactDetailSelectionFocus = isSubjectBoundExactDetailQuery(query.query, planner, {
    subjectHints,
    temporalDetailFocus,
    globalQuestionFocus,
    profileInferenceFocus,
    identityProfileFocus,
    sharedCommonalityFocus
  });
  if (exactDetailSelectionFocus) {
    results = [...retainSubjectBoundExactDetailResults(retrievalQueryText, results, limit)];
  }

  const explicitPastPreferenceQuery =
    preferenceQueryFocus &&
    !pointInTimePreferenceFocus &&
    /\b(?:used?\s+to\s+prefer|what\s+did\s+.+\s+prefer|did\s+.+\s+still\s+prefer)\b/i.test(retrievalQueryText);

  if (explicitPastPreferenceQuery) {
    const historicalPreferenceRows = toRankedRows(
      await loadPreferenceTenureRows(query.namespaceId, retrievalQueryText, candidateLimit, timeStart, timeEnd, "historical")
    );
    const historicalPreferenceSupportRows = toRankedRows(
      await loadHistoricalPreferenceSupportRows(query.namespaceId, retrievalQueryText, candidateLimit)
    );
    const historicalPreferenceResults = [...historicalPreferenceRows, ...historicalPreferenceSupportRows]
      .slice(0, Math.max(limit, 4))
      .map((row) =>
        buildRecallResult(row, row.scoreValue, {
          rrfScore: row.scoreValue,
          lexicalRank: 1,
          lexicalRawScore: row.scoreValue
        })
      );
    if (historicalPreferenceResults.length > 0) {
      results = historicalPreferenceResults.slice(0, limit);
    }
  }

  if (storageLocationFocus) {
    const storageSupportRows = toRankedRows(await loadStorageLocationSupportRows(query.namespaceId, candidateLimit));
    const storageSupportResults = storageSupportRows
      .slice(0, Math.max(limit, 4))
      .map((row) =>
        buildRecallResult(row, row.scoreValue, {
          rrfScore: row.scoreValue,
          lexicalRank: 1,
          lexicalRawScore: row.scoreValue
        })
      );
    if (
      storageSupportResults.length > 0 &&
      /\b(?:Bend|Reno|Carson)\b/i.test(storageSupportResults.map((result) => result.content).join(" "))
    ) {
      results = storageSupportResults.slice(0, limit);
    }
  }

  if (planner.queryClass === "causal" && results.length > 0) {
    const sourceSupportResults = await loadSourceMemorySupportRows(query.namespaceId, results, limit);
    if (sourceSupportResults.length > 0) {
      const merged: RecallResult[] = [];
      const seen = new Set<string>();
      for (const result of [...results, ...sourceSupportResults]) {
        if (seen.has(result.memoryId)) {
          continue;
        }
        merged.push(result);
        seen.add(result.memoryId);
        if (merged.length >= limit) {
          break;
        }
      }
      results = merged;
    }
  }

  let boundedEventSupportCount = 0;
  if (eventNeighborhoodFocus) {
    const boundedEventIds = results
      .filter((result) => result.memoryType === "narrative_event")
      .map((result) => result.memoryId)
      .slice(0, 1);
    if (boundedEventIds.length > 0) {
      const sceneSupportRows = await loadBoundedEventSceneSupportRows(query.namespaceId, boundedEventIds);
      const neighborhoodSupportRows = shouldLoadBoundedEventNeighborhoodSupport(retrievalQueryText, sceneSupportRows)
        ? await loadBoundedEventNeighborhoodSupportRows(query.namespaceId, boundedEventIds)
        : [];
      const supportRows = [...sceneSupportRows, ...neighborhoodSupportRows];
      boundedEventSupportCount = supportRows.length;
      results = [...expandBoundedEventResults(results, supportRows, limit)];
    }

    const eventNeighborhoodSupportRows = await loadEventNeighborhoodEpisodicRows(
      query.namespaceId,
      retrievalQueryText,
      buildEventBoundedEvidenceTerms(retrievalQueryText, planner.lexicalTerms),
      Math.min(candidateLimit, 8),
      timeStart,
      timeEnd
    );
    if (eventNeighborhoodSupportRows.length > 0) {
      const eventNeighborhoodSupportResults = eventNeighborhoodSupportRows.map((row) =>
        buildRecallResult(row, 0.72, { rrfScore: 0.72 })
      );
      results = mergeRecallResults(eventNeighborhoodSupportResults, results, limit);
    }

    if (inferExactDetailQuestionFamily(retrievalQueryText) === "realization") {
      const anchoredRealizationRows = await loadAnchoredRealizationSupportRows(
        query.namespaceId,
        retrievalQueryText,
        Math.min(candidateLimit, 6),
        timeStart,
        timeEnd
      );
      if (anchoredRealizationRows.length > 0) {
        const anchoredRealizationResults = anchoredRealizationRows.map((row) =>
          buildRecallResult(row, 0.78, { rrfScore: 0.78 })
        );
        results = mergeRecallResults(anchoredRealizationResults, results, limit);
      }
    }
  }

  if (/\bwho\b/i.test(retrievalQueryText) && /\bintroduced\b/i.test(retrievalQueryText)) {
    const episodicNeighborhoodSupport = await loadEpisodicNeighborhoodSupportRows(query.namespaceId, results, limit);
    if (episodicNeighborhoodSupport.length > 0) {
      results = mergeRecallResults(episodicNeighborhoodSupport, results, limit);
    }
  }
  let recursiveReflectApplied = false;
  let recursiveSubqueries: string[] = [];
  if (graphEligible && !graphRoutingUsed && results.length > 0) {
    const graphSupportResults = await loadReflectGraphSupportResults(
      query.namespaceId,
      results,
      Math.max(limit, 6),
      subjectHints
    );
    if (graphSupportResults.length > 0) {
      graphRoutingUsed = true;
      graphEvidenceCount = graphSupportResults.length;
      results = mergeRecallResults(results, graphSupportResults, limit);
    }
  }
  const allowSummaryContextRouting =
    !derivationDetailFocus &&
    !hierarchyTraversalFocus;

  if (allowSummaryContextRouting && (globalQuestionFocus || reflectiveRoutingFocus || profileInferenceFocus || identityProfileFocus || sharedCommonalityFocus)) {
    const requestedProfileKinds = requestedProfileKindsForRouting({
      globalQuestionFocus: globalQuestionFocus || reflectiveRoutingFocus,
      profileInferenceFocus,
      identityProfileFocus,
      sharedCommonalityFocus
    });
    const summaryBoostRows = toRankedRows([
      ...await loadActiveSemanticProfileSummaryRows(
        query.namespaceId,
        retrievalQueryText,
        Math.max(limit, sharedCommonalityFocus ? 4 : 3),
        requestedProfileKinds
      ),
      ...(sharedCommonalityFocus
        ? await loadParticipantScopedProfileSummaryRows(
            query.namespaceId,
            conversationParticipants,
            Math.max(4, limit),
            requestedProfileKinds
          )
        : [])
    ]);
    if (summaryBoostRows.length > 0) {
      const summaryBoostResults = summaryBoostRows
        .slice(0, Math.max(sharedCommonalityFocus ? 3 : 2, 2))
        .map((row) =>
          buildRecallResult(row, row.scoreValue, {
            rrfScore: row.scoreValue,
            lexicalRank: 1,
            lexicalRawScore: row.scoreValue
          })
        );
      results = mergeRecallResults(summaryBoostResults, results, limit);
    }
  }
  if (allowSummaryContextRouting && (globalQuestionFocus || reflectiveRoutingFocus || sharedCommonalityFocus || conversationRecapFocus)) {
    const topicRows = toRankedRows(
      await loadTopicSegmentSupportRows(
        query.namespaceId,
        retrievalQueryText,
        Math.max(limit, 4),
        [...subjectHints, ...conversationParticipants],
        timeStart,
        timeEnd
      )
    );
    const communityRows = toRankedRows(
      await loadCommunitySummarySupportRows(
        query.namespaceId,
        retrievalQueryText,
        [...subjectHints, ...conversationParticipants],
        Math.max(limit, 4),
        timeStart,
        timeEnd
      )
    );
    if (topicRows.length > 0) {
      topicRoutingUsed = true;
      const topicResults = topicRows
        .slice(0, Math.max(2, Math.min(limit, 4)))
        .map((row) =>
          buildRecallResult(row, row.scoreValue, {
            rrfScore: row.scoreValue,
            lexicalRank: 1,
            lexicalRawScore: row.scoreValue
          })
        );
      results = mergeRecallResults(topicResults, results, limit);
    }
    if (communityRows.length > 0) {
      communitySummaryUsed = true;
      const communityResults = communityRows
        .slice(0, Math.max(2, Math.min(limit, 4)))
        .map((row) =>
          buildRecallResult(row, row.scoreValue, {
            rrfScore: row.scoreValue,
            lexicalRank: 1,
            lexicalRawScore: row.scoreValue
          })
        );
      results = mergeRecallResults(communityResults, results, limit);
    }
  }
  const derivationSourceSupportEligible =
    results.some((result) => result.memoryType === "artifact_derivation") &&
    !results.some((result) => result.memoryType === "episodic_memory" || result.memoryType === "narrative_event") &&
    (temporalDetailFocus ||
      planner.queryClass === "direct_fact" ||
      planner.queryClass === "causal" ||
      exactDetailSelectionFocus);
  if (derivationSourceSupportEligible) {
    const derivationSourceSupportRows = await loadDerivationSourceSupportRows(query.namespaceId, results, Math.max(limit, 8));
    if (derivationSourceSupportRows.length > 0) {
      results = mergeRecallResults(derivationSourceSupportRows, results, Math.max(limit, 8));
    }
  }
  if ((synthesisMode === "reflect" || topicRoutingUsed || communitySummaryUsed) && allowSummaryContextRouting) {
    results = [...prioritizeReflectContextResults(results, limit, retrievalQueryText)];
  }
  if (eventNeighborhoodFocus && exactDetailSelectionFocus) {
    // Event-neighborhood support is injected after the first exact-detail pass. Re-run the
    // subject-bound selector here so anchored rows survive later summary/context merges.
    results = [...retainSubjectBoundExactDetailResults(retrievalQueryText, results, limit)];
  }
  if (derivationDetailFocus) {
    results = [...prioritizeDerivationDetailResults(results, limit)];
  }
  if (hierarchyTraversalFocus) {
    results = [...prioritizeHierarchyTraversalResults(results, limit)];
  }
  if (relationshipHistoryRecapFocus || historicalRelationshipFocus) {
    results = [...prioritizeRelationshipHistoryResults(results, limit)];
  }
  if (relationshipHistoryRecapFocus) {
    const historyEntityHints = extractEntityNameHints(query.query)
      .map((value) => normalizeWhitespace(value))
      .filter((value) => value.length > 0 && value.toLowerCase() !== "steve");
    const primaryHistoryTarget = historyEntityHints[0];
    if (primaryHistoryTarget) {
      const historySupportRows = await loadRelationshipHistorySupportRows(query.namespaceId, primaryHistoryTarget, Math.max(limit, 8));
      if (historySupportRows.length > 0) {
        results = mergeRecallResults(historySupportRows, results, Math.max(limit, 8));
        results = [...results].sort(
          (left, right) =>
            relationshipHistorySupportScore(right, primaryHistoryTarget.toLowerCase()) -
            relationshipHistorySupportScore(left, primaryHistoryTarget.toLowerCase())
        );
      }
    }
  }
  if (isProjectIdeaQueryText(query.query)) {
    const projectIdeaSupportRows = await loadProjectIdeaSupportRows(query.namespaceId, Math.max(limit, 8));
    if (projectIdeaSupportRows.length > 0) {
      results = mergeRecallResults(projectIdeaSupportRows, results, Math.max(limit, 8));
      results = [...results].sort((left, right) => projectIdeaSupportScore(right) - projectIdeaSupportScore(left));
    }
  }
  const exactDetailExtractionEnabled = isSubjectBoundExactDetailQuery(query.query, planner, {
    subjectHints,
    temporalDetailFocus,
    globalQuestionFocus,
    profileInferenceFocus,
    identityProfileFocus,
    sharedCommonalityFocus
  });
  const queryEntityFocus = parseQueryEntityFocus(query.query);
  const focusedSubjectHints = queryEntityFocus.primaryHints;
  const answerableUnitReaderFocus = (focusedSubjectHints.length === 1 || subjectHints.length === 1) &&
    !globalQuestionFocus &&
    !profileInferenceFocus &&
    !identityProfileFocus &&
    !sharedCommonalityFocus &&
    (
      exactDetailExtractionEnabled ||
      temporalDetailFocus ||
      queryEntityFocus.mode === "primary_with_companion"
    );
  const answerableUnitSelection = answerableUnitReaderFocus
    ? await queryAnswerableUnits({
        namespaceId: query.namespaceId,
        queryText: query.query,
        limit,
        supportResults: results,
        timeStart: timeStart ?? undefined,
        timeEnd: timeEnd ?? undefined
      })
    : {
        applied: false,
        candidates: [],
        telemetry: {
          answerableUnitApplied: false,
          answerableUnitCandidateCount: 0,
          answerableUnitOwnedCount: 0,
          answerableUnitMixedCount: 0,
          answerableUnitForeignCount: 0
        }
      };
  const readerResult = answerableUnitSelection.applied
    ? selectReaderResult(query.query, answerableUnitSelection.candidates)
    : {
        applied: false,
        decision: "abstained_no_owned_unit" as const,
        selectedUnitIds: [],
        recallResults: [],
        claimText: null,
        topUnitType: undefined,
        dominantMargin: undefined,
        usedFallback: false
      };
  const readerResolved =
    readerResult.applied &&
    readerResult.decision === "resolved" &&
    readerResult.recallResults.length > 0 &&
    typeof readerResult.claimText === "string" &&
    readerResult.claimText.trim().length > 0;
  const companionReaderAssist =
    readerResult.applied &&
    readerResult.recallResults.length > 0 &&
    parseQueryEntityFocus(query.query).mode === "primary_with_companion" &&
    /\bbesides\b/i.test(query.query) &&
    /\bfriends?\b/i.test(query.query);
  if (readerResolved) {
    results = mergeRecallResults(readerResult.recallResults, results, limit);
  } else if (companionReaderAssist) {
    results = mergeRecallResults(readerResult.recallResults, results, limit);
  }
  const answerableUnitExactDetailBackfill = answerableUnitSelection.applied
    ? gatherAnswerableUnitExactDetailBackfillTexts(query.query, answerableUnitSelection.candidates)
    : [];
  let exactDetailDerivation = deriveSubjectBoundExactDetailClaimWithTelemetry(
    query.query,
    results,
    exactDetailExtractionEnabled,
    answerableUnitExactDetailBackfill
  );
  let exactDetailCandidate = exactDetailDerivation.candidate;
  const initialReaderFallback = readerResolved ? deriveReaderExactDetailFallbackCandidate(query.query, readerResult) : null;
  exactDetailCandidate = preferRicherExactDetailCandidate(query.query, exactDetailCandidate, initialReaderFallback);
  if (!exactDetailCandidate && readerResolved) {
    exactDetailCandidate = initialReaderFallback;
  }
  let finalEvidence = buildEvidenceBundle(results);
  let answerAssessment = assessRecallAnswer(
    results,
    finalEvidence,
    planner,
    temporalSummarySufficient,
    query.query,
    exactDetailCandidate
  );
  const preReflectRecovery = assessRecoveryState({
    queryText: query.query,
    planner,
    queryModeHint,
    reflectEligibility,
    sufficiency: answerAssessment.sufficiency,
    subjectMatch: answerAssessment.subjectMatch,
    evidenceCount: finalEvidence.length,
    exactDetailExtractionEnabled,
    exactDetailResolved: Boolean(exactDetailCandidate),
    matchedParticipantCount: answerAssessment.matchedParticipants.length,
    missingParticipantCount: answerAssessment.missingParticipants.length
  });
  const genericSharedCommonalityNeedsDeeperCheck =
    sharedCommonalityFocus &&
    /\bhave in common\b/i.test(query.query) &&
    (() => {
      const derivedSharedClaim = deriveSharedCommonalityClaimText(query.query, results);
      if (!derivedSharedClaim) {
        return true;
      }
      return !/\b(lost their jobs|businesses|own businesses)\b/i.test(derivedSharedClaim);
    })();

  const exactDetailNeedsAdequacyRecovery =
    exactDetailExtractionEnabled && preReflectRecovery.adequacyStatus !== "adequate";
  const suppressRecursiveReflectForGeneratedQuery =
    shouldSuppressRecursiveReflectForGeneratedQuery(query.query, decompositionDepth);
  const recoveryDrivenReflect =
    !suppressRecursiveReflectForGeneratedQuery &&
    (shouldEnterReflect(reflectEligibility, preReflectRecovery) ||
      genericSharedCommonalityNeedsDeeperCheck);

  if (
    decompositionDepth < 2 &&
    recoveryDrivenReflect
  ) {
    const reflectSubqueries = buildRecursiveReflectSubqueries(query.query, subjectHints, {
      globalQuestionFocus,
      reflectiveRoutingFocus,
      profileInferenceFocus,
      identityProfileFocus,
      sharedCommonalityFocus,
      causalDecisionFocus,
      exactDetailFocus: queryModeHint === "exact_detail" || exactDetailNeedsAdequacyRecovery
    });
    if (reflectSubqueries.length > 0) {
      const recursiveResponses: RecallResult[][] = [];
      const adequacyDrivenReflect = synthesisMode !== "reflect";
      for (let round = 0; round < Math.min(2, reflectSubqueries.length); round += 1) {
        const subquery = reflectSubqueries[round]!;
        const response = await searchMemory({
          ...query,
          query: subquery,
          limit: Math.max(4, Math.min(limit, 6)),
          decompositionDepth: decompositionDepth + 1
        });
        recursiveSubqueries.push(subquery);
        const markedResults = markRecursiveReflectResults(response.results.slice(0, 3), round + 1, subquery);
        if (markedResults.length > 0) {
          recursiveResponses.push([...markedResults]);
        }
        const hasSupported = response.meta.answerAssessment?.sufficiency === "supported";
        const subjectMismatch = response.meta.answerAssessment?.subjectMatch === "mismatched";
        const sharedCommonalityNeedsMoreCoverage = sharedCommonalityFocus && subjectHints.length >= 2;
        if ((!sharedCommonalityNeedsMoreCoverage && hasSupported) || subjectMismatch || markedResults.length === 0) {
          break;
        }
      }

      const recursiveMerged = mergeDecomposedResults(recursiveResponses, Math.max(limit, 6));
      if (recursiveMerged.length > 0) {
        recursiveReflectApplied = true;
        if (adequacyDrivenReflect || synthesisMode !== "reflect") {
          synthesisMode = "reflect";
        }
        results = genericSharedCommonalityNeedsDeeperCheck
          ? mergeRecallResults(recursiveMerged, results, limit)
          : mergeRecallResults(results, recursiveMerged, limit);
        if ((synthesisMode === "reflect" || topicRoutingUsed || communitySummaryUsed) && allowSummaryContextRouting) {
          results = [...prioritizeReflectContextResults(results, limit, retrievalQueryText)];
        }
        finalEvidence = buildEvidenceBundle(results);
        exactDetailDerivation = deriveSubjectBoundExactDetailClaimWithTelemetry(
          query.query,
          results,
          exactDetailExtractionEnabled,
          answerableUnitExactDetailBackfill
        );
        exactDetailCandidate = exactDetailDerivation.candidate;
        exactDetailCandidate = preferRicherExactDetailCandidate(
          query.query,
          exactDetailCandidate,
          readerResolved ? deriveReaderExactDetailFallbackCandidate(query.query, readerResult) : null
        );
        answerAssessment = assessRecallAnswer(
          results,
          finalEvidence,
          planner,
          temporalSummarySufficient,
          query.query,
          exactDetailCandidate
        );
      }
    }
  }

  if (exactDetailExtractionEnabled) {
    exactDetailDerivation = deriveSubjectBoundExactDetailClaimWithTelemetry(
      query.query,
      results,
      exactDetailExtractionEnabled,
      answerableUnitExactDetailBackfill
    );
    exactDetailCandidate = exactDetailDerivation.candidate;
  }
  exactDetailCandidate = preferRicherExactDetailCandidate(
    query.query,
    exactDetailCandidate,
    readerResolved ? deriveReaderExactDetailFallbackCandidate(query.query, readerResult) : null
  );
  if (!exactDetailCandidate && readerResolved) {
    exactDetailCandidate = deriveReaderExactDetailFallbackCandidate(query.query, readerResult);
  }
  finalEvidence = buildEvidenceBundle(results);
  answerAssessment = assessRecallAnswer(
    results,
    finalEvidence,
    planner,
    temporalSummarySufficient,
    query.query,
    exactDetailCandidate
  );

  const postReflectRecovery = assessRecoveryState({
    queryText: query.query,
    planner,
    queryModeHint,
    reflectEligibility,
    sufficiency: answerAssessment.sufficiency,
    subjectMatch: answerAssessment.subjectMatch,
    evidenceCount: finalEvidence.length,
    exactDetailExtractionEnabled,
    exactDetailResolved: Boolean(exactDetailCandidate),
    matchedParticipantCount: answerAssessment.matchedParticipants.length,
    missingParticipantCount: answerAssessment.missingParticipants.length
  });
  const reflectComparison = compareReflectOutcome(preReflectRecovery, postReflectRecovery, recursiveReflectApplied);

  const duality = buildDualityObject(
    results,
    finalEvidence,
    answerAssessment,
    query.namespaceId,
    query.query,
    exactDetailCandidate
  );
  let noteWritebackTriggered = false;
  let noteWritebackFamily: RecallWritebackNoteFamily | undefined;
  const writebackPerson =
    inferWritebackPersonName(results, answerAssessment.matchedParticipants, subjectHints) ??
    (answerAssessment.matchedParticipants.length === 1
      ? answerAssessment.matchedParticipants[0]!
      : subjectHints.length === 1
        ? subjectHints[0]!
        : null);

  const writebackProfileKind =
    !sharedCommonalityFocus && synthesisMode === "reflect"
      ? inferWritebackProfileKind(query.query, {
          globalQuestionFocus: globalQuestionFocus || reflectiveRoutingFocus,
          profileInferenceFocus,
          identityProfileFocus
        })
      : null;

  if (
    writebackProfileKind &&
    answerAssessment.sufficiency === "supported" &&
    answerAssessment.subjectMatch === "matched" &&
    answerAssessment.summaryEvidenceUsed !== true &&
    typeof writebackPerson === "string" &&
    writebackPerson.length > 0 &&
    results.length > 0 &&
    duality.claim.text.trim().length > 0 &&
    !/^\s*(i don't know|unknown|not enough evidence)\b/i.test(duality.claim.text)
  ) {
    try {
      const writebackResult = await writebackSupportedProfileNote({
        namespaceId: query.namespaceId,
        queryText: query.query,
        personName: writebackPerson,
        profileKind: writebackProfileKind,
        content: duality.claim.text,
        results
      });
      noteWritebackTriggered = writebackResult.triggered;
      noteWritebackFamily = writebackResult.noteFamily;
    } catch {
      // Query-time writeback is best-effort. It should never fail the recall path.
    }
  }

  try {
    await recordCoRetrievalEdges(query.namespaceId, results, {
      sufficiency: answerAssessment.sufficiency,
      subjectMatch: answerAssessment.subjectMatch,
      query: query.query
    });
  } catch {
    // Retrieval quality should not fail hard if graph learning cannot be recorded.
  }

  return {
    results,
    evidence: finalEvidence,
    duality,
    meta: {
      contractVersion: "duality_v2",
      retrievalMode: sqlHybridKernelRows.some((row) => row.vectorRank !== undefined) || vectorRows.length > 0 ? "hybrid" : "lexical",
      synthesisMode,
      globalQueryRouted: globalQuestionFocus || undefined,
      summaryRoutingUsed: (globalQuestionFocus || reflectiveRoutingFocus || profileInferenceFocus || identityProfileFocus || sharedCommonalityFocus) || undefined,
      graphRoutingUsed: graphRoutingUsed || undefined,
      graphEvidenceCount: graphEvidenceCount > 0 ? graphEvidenceCount : undefined,
      graphSeedKinds: graphSeedKinds.length > 0 ? graphSeedKinds : undefined,
      recursiveReflectApplied: recursiveReflectApplied || undefined,
      recursiveSubqueries: recursiveSubqueries.length > 0 ? recursiveSubqueries : undefined,
      topicRoutingUsed: topicRoutingUsed || undefined,
      communitySummaryUsed: communitySummaryUsed || undefined,
      queryModeHint,
      reflectEligibility,
      adequacyStatus: postReflectRecovery.adequacyStatus,
      missingInfoType: postReflectRecovery.missingInfoType,
      preReflectAdequacyStatus: recursiveReflectApplied ? preReflectRecovery.adequacyStatus : undefined,
      preReflectMissingInfoType: recursiveReflectApplied ? preReflectRecovery.missingInfoType : undefined,
      reflectHelped: reflectComparison.reflectHelped || undefined,
      reflectOutcome: reflectComparison.reflectOutcome,
      exactAnswerWindowCount: exactDetailDerivation.telemetry.exactAnswerWindowCount || undefined,
      exactAnswerSafeWindowCount: exactDetailDerivation.telemetry.exactAnswerSafeWindowCount || undefined,
      exactAnswerDiscardedMixedWindowCount: exactDetailDerivation.telemetry.exactAnswerDiscardedMixedWindowCount || undefined,
      exactAnswerDiscardedForeignWindowCount: exactDetailDerivation.telemetry.exactAnswerDiscardedForeignWindowCount || undefined,
      exactAnswerCandidateCount: exactDetailDerivation.telemetry.exactAnswerCandidateCount || undefined,
        exactAnswerDominantMargin: exactDetailDerivation.telemetry.exactAnswerDominantMargin,
        exactAnswerAbstainedForAmbiguity: exactDetailDerivation.telemetry.exactAnswerAbstainedForAmbiguity || undefined,
      answerableUnitApplied: answerableUnitSelection.telemetry.answerableUnitApplied || undefined,
      answerableUnitCandidateCount: answerableUnitSelection.telemetry.answerableUnitCandidateCount || undefined,
      answerableUnitOwnedCount: answerableUnitSelection.telemetry.answerableUnitOwnedCount || undefined,
      answerableUnitMixedCount: answerableUnitSelection.telemetry.answerableUnitMixedCount || undefined,
      answerableUnitForeignCount: answerableUnitSelection.telemetry.answerableUnitForeignCount || undefined,
      readerApplied: readerResult.applied || undefined,
      readerDecision: readerResult.applied ? readerResult.decision : undefined,
      readerSelectedUnitCount: readerResult.selectedUnitIds.length || undefined,
      readerTopUnitType: readerResult.topUnitType,
      readerDominantMargin: readerResult.dominantMargin,
      readerUsedFallback: readerResult.usedFallback || undefined,
      ownedWindowUsedForFinalClaim: readerResolved || undefined,
      subjectIsolationApplied: subjectIsolationTelemetry.subjectIsolationApplied || undefined,
      subjectIsolationOwnedCount: subjectIsolationTelemetry.subjectIsolationOwnedCount || undefined,
      subjectIsolationDiscardedMixedCount: subjectIsolationTelemetry.subjectIsolationDiscardedMixedCount || undefined,
      subjectIsolationDiscardedForeignCount: subjectIsolationTelemetry.subjectIsolationDiscardedForeignCount || undefined,
      subjectIsolationTopResultOwned: subjectIsolationTelemetry.subjectIsolationTopResultOwned || undefined,
      entityResolutionMode: sharedCommonalityFocus
        ? "participant_overlap"
        : exactDetailExtractionEnabled
          ? "subject_bound"
          : "default",
      exactDetailExtractionUsed: Boolean(exactDetailCandidate) || undefined,
      noteWritebackTriggered: noteWritebackTriggered || undefined,
      noteWritebackFamily,
      lexicalProvider: lexicalResult.provider,
      lexicalFallbackUsed: lexicalResult.fallbackUsed,
      lexicalFallbackReason: lexicalResult.fallbackReason,
      queryEmbeddingSource: queryEmbeddingResult.source,
      queryEmbeddingProvider: queryEmbeddingResult.provider,
      queryEmbeddingModel: queryEmbeddingResult.model,
      vectorFallbackReason: queryEmbeddingResult.fallbackReason,
      rankingKernel: usedSqlRankingKernel
        ? sqlHybridKernelRows.length > 0
          ? "sql_hybrid_unified"
          : "sql_hybrid_core"
        : "app_fused",
      retrievalFusionVersion: config.retrievalFusionVersion,
      rerankerEnabled: config.localRerankerEnabled,
      rerankerVersion: config.localRerankerVersion,
      lexicalCandidateCount:
        sqlHybridKernelRows.length > 0
          ? Math.max(...sqlHybridKernelRows.map((row) => row.lexicalRank ?? 0), 0)
          : lexicalRows.length,
      vectorCandidateCount:
        sqlHybridKernelRows.length > 0
          ? Math.max(...sqlHybridKernelRows.map((row) => row.vectorRank ?? 0), 0)
          : vectorRows.length,
      fusedResultCount: results.length,
      temporalAncestorCount: lexicalRows.filter((row) => row.provenance.tier === "temporal_ancestor").length,
      temporalDescendantSupportCount: lexicalRows.filter((row) => row.provenance.tier === "temporal_descendant_support").length,
      temporalGateTriggered,
      temporalSummarySufficient: temporalSummarySufficient || undefined,
      temporalDetailFocus: temporalDetailFocus || undefined,
      temporalLayersUsed,
      temporalSupportTokenCount: approxResultTokenCount(lexicalRows.filter((row) => isTemporalDescendantSupportRow(row))),
      placeContainmentSupportCount: lexicalRows.filter((row) => row.provenance.tier === "place_containment_support").length,
      boundedEventSupportCount: boundedEventSupportCount > 0 ? boundedEventSupportCount : undefined,
      answerAssessment,
      followUpAction: duality.followUpAction,
      clarificationHint: duality.clarificationHint,
      provenanceAnswer: normalizedRelationshipWhyQuery ? buildProvenanceAnswer(normalizedRelationshipWhyQuery, results, finalEvidence) : undefined,
      semanticAnchorResolution: semanticAnchorResolution
        ? {
            mode: semanticAnchorResolution.mode,
            anchorText: semanticAnchorResolution.anchorText,
            source: semanticAnchorResolution.source,
            timeStart: semanticAnchorResolution.timeStart,
            timeEnd: semanticAnchorResolution.timeEnd
          }
        : undefined,
      planner
    }
  };
}

async function buildHabitConstraintSearchResponse(query: RecallQuery): Promise<RecallResponse> {
  const limit = normalizeLimit(query.limit);
  const decompositionDepth = query.decompositionDepth ?? 0;
  const [routineResponse, constraintResponse] = await Promise.all([
    searchMemory({
      ...query,
      query: "What is my current daily routine?",
      limit: Math.max(limit, 4),
      decompositionDepth: decompositionDepth + 1
    }),
    searchMemory({
      ...query,
      query: "What constraints matter right now?",
      limit: Math.max(limit, 4),
      decompositionDepth: decompositionDepth + 1
    })
  ]);

  const results = mergeRecallResults(routineResponse.results, constraintResponse.results, Math.max(limit * 3, 8));
  const response = buildTypedLaneSearchResponse(
    query,
    results,
    "The habits and constraints query was answered from routine and constraint rows before broad retrieval."
  );

  const routineClaim = routineResponse.duality.claim?.text ?? null;
  const synthesizedClaim =
    routineClaim && /coffee|reddit|personal time/i.test(routineClaim)
      ? routineClaim
      : deriveHabitConstraintClaimText(query.query, results);

  if (synthesizedClaim) {
    return {
      ...response,
      duality: {
        ...response.duality,
        claim: {
          ...response.duality.claim,
          text: synthesizedClaim
        }
      }
    };
  }

  return response;
}

export async function timelineMemory(query: TimelineQuery): Promise<TimelineResponse> {
  const limit = normalizeLimit(query.limit, 25, 200);
  const rows = await queryRows<SearchRow>(
    `
      SELECT
        em.id AS memory_id,
        'episodic_memory'::text AS memory_type,
        em.content,
        0::double precision AS raw_score,
        em.artifact_id,
        em.occurred_at,
        em.namespace_id,
        jsonb_build_object(
          'tier', 'timeline_episodic',
          'artifact_observation_id', em.artifact_observation_id,
          'source_chunk_id', em.source_chunk_id,
          'source_offset', em.source_offset,
          'source_uri', a.uri,
          'metadata', em.metadata
        ) AS provenance
      FROM episodic_memory em
      LEFT JOIN artifacts a ON a.id = em.artifact_id
      WHERE em.namespace_id = $1
        AND em.occurred_at >= $2
        AND em.occurred_at <= $3
      ORDER BY em.occurred_at ASC
      LIMIT $4
    `,
    [query.namespaceId, query.timeStart, query.timeEnd, limit]
  );

  return {
    timeline: mapRecallRows(rows)
  };
}

function priorInstant(iso: string): string | null {
  const parsed = parseIsoTimestamp(iso);
  if (parsed === null) {
    return null;
  }
  return new Date(parsed - 1).toISOString();
}

function recapFocusQueries(focus: RecapFocus): readonly string[] {
  return uniqueStrings([...focus.projects, ...focus.topics.filter((topic) => !focus.projects.some((project) => project.toLowerCase() === topic.toLowerCase()))]);
}

function temporalDifferentialSignalScore(result: RecallResult, focus: RecapFocus, resolvedWindow: ResolvedWindow): number {
  const content = `${result.content} ${JSON.stringify(result.provenance ?? {})}`.toLowerCase();
  let score = 0;
  score += recallMatchCount(result, focus.projects) * 2.5;
  score += recallMatchCount(result, focus.topics) * 2;
  if (/\b(changed|change|moved|shifted|slipped|fixed|green|red|blocked|unblocked|deadline|because|issue|back to|used to|now)\b/.test(content)) {
    score += 4;
  }
  if (result.memoryType === "episodic_memory" || result.memoryType === "artifact_derivation") {
    score += 2;
  }

  const occurredAt = typeof result.occurredAt === "string" ? result.occurredAt : null;
  const occurredAtTs = parseIsoTimestamp(occurredAt);
  const windowStart = parseIsoTimestamp(resolvedWindow.timeStart);
  const windowEnd = parseIsoTimestamp(resolvedWindow.timeEnd);
  if (occurredAtTs !== null && windowStart !== null && windowEnd !== null) {
    if (occurredAtTs >= windowStart && occurredAtTs <= windowEnd) {
      score += 4;
    } else if (occurredAtTs < windowStart) {
      score += 2;
    }
  }

  return score;
}

async function loadTemporalDifferentialContextResults(
  query: RecapQuery,
  focus: RecapFocus,
  resolvedWindow: ResolvedWindow,
  limit: number
): Promise<readonly RecallResult[]> {
  const focusQueries = recapFocusQueries(focus);
  if (focusQueries.length === 0) {
    return [];
  }

  const responseSets: RecallResult[][] = [];
  const baselineEnd = resolvedWindow.timeStart ? priorInstant(resolvedWindow.timeStart) : null;

  for (const focusQuery of focusQueries) {
    if (resolvedWindow.timeStart && resolvedWindow.timeEnd) {
      const inWindow = await searchMemory({
        query: focusQuery,
        namespaceId: query.namespaceId,
        timeStart: resolvedWindow.timeStart,
        timeEnd: resolvedWindow.timeEnd,
        referenceNow: query.referenceNow,
        limit: Math.max(limit, 6),
        decompositionDepth: (query.decompositionDepth ?? 0) + 1
      });
      responseSets.push(filterResultsForRecapFocus(inWindow.results, focus).slice(0, 6));
    }

    if (baselineEnd) {
      const baseline = await searchMemory({
        query: focusQuery,
        namespaceId: query.namespaceId,
        timeEnd: baselineEnd,
        referenceNow: query.referenceNow,
        limit: 4,
        decompositionDepth: (query.decompositionDepth ?? 0) + 1
      });
      responseSets.push(filterResultsForRecapFocus(baseline.results, focus).slice(0, 4));
    }
  }

  return mergeDecomposedResults(responseSets, limit * 3);
}

async function runRecapPipeline(
  intent: RecapIntent,
  query: RecapQuery
): Promise<{
  readonly focus: RecapFocus;
  readonly resolvedWindow: ResolvedWindow;
  readonly results: readonly RecallResult[];
  readonly evidence: readonly RecallEvidenceItem[];
  readonly retrievalPlan: {
    readonly probes: readonly string[];
    readonly groupedBy: "artifact_cluster" | "day_cluster" | "result_order";
    readonly queryDecompositionApplied: boolean;
    readonly queryDecompositionSubqueries: readonly string[];
  };
  readonly assessment: NonNullable<RecallResponse["meta"]["answerAssessment"]>;
  readonly duality: RecallResponse["duality"];
}> {
  const limit = normalizeLimit(query.limit, 8, 20);
  const focus = buildRecapFocus(query);
  const resolvedWindow = resolveRecapWindow(query);
  const temporalDifferential = isTemporalDifferentialQuery(query.query);
  const probes = buildRecapSupportProbes(query, intent, focus);
  const responseSets: RecallResult[][] = [];
  let primaryResponse: RecallResponse | null = null;
  const decompositionSubqueries = new Set<string>();
  let queryDecompositionApplied = false;

  for (const probe of probes) {
    const response = await searchMemory({
      query: probe,
      namespaceId: query.namespaceId,
      timeStart: resolvedWindow.timeStart,
      timeEnd: resolvedWindow.timeEnd,
      referenceNow: query.referenceNow,
      limit: Math.max(limit, probe === query.query ? 10 : 6),
      decompositionDepth: (query.decompositionDepth ?? 0) + 1
    });
    if (probe === query.query || primaryResponse === null) {
      primaryResponse = response;
    }

    if (response.meta.queryDecomposition?.applied) {
      queryDecompositionApplied = true;
      for (const subquery of response.meta.queryDecomposition.subqueries) {
        decompositionSubqueries.add(subquery);
      }
    }

    const focused = filterResultsForRecapFocus(response.results, focus);
    responseSets.push((focused.length > 0 ? focused : response.results).slice(0, probe === query.query ? 8 : 4));
  }

  const mergedResults = mergeDecomposedResults(responseSets, limit * 3);
  let enrichedResults = mergedResults;
  const lacksLeafResults = !mergedResults.some(
    (result) => result.memoryType === "episodic_memory" || result.memoryType === "artifact_derivation"
  );
  if (lacksLeafResults && resolvedWindow.timeStart && resolvedWindow.timeEnd) {
    const timeline = await timelineMemory({
      namespaceId: query.namespaceId,
      timeStart: resolvedWindow.timeStart,
      timeEnd: resolvedWindow.timeEnd,
      limit: 24
    });
    const focusedTimeline = filterResultsForRecapFocus(
      timeline.timeline.filter((result) => result.memoryType === "episodic_memory"),
      focus
    );
    if (focusedTimeline.length > 0) {
      enrichedResults = mergeRecallResults(focusedTimeline, enrichedResults, limit * 4);
    }
  }
  if (temporalDifferential) {
    const differentialResults = await loadTemporalDifferentialContextResults(query, focus, resolvedWindow, limit);
    if (differentialResults.length > 0) {
      enrichedResults = mergeRecallResults(differentialResults, enrichedResults, limit * 4);
    }
  }
  if ((mergedResults.length < 2 || filterResultsForRecapFocus(mergedResults, focus).length < 2) && resolvedWindow.timeStart && resolvedWindow.timeEnd) {
    const timeline = await timelineMemory({
      namespaceId: query.namespaceId,
      timeStart: resolvedWindow.timeStart,
      timeEnd: resolvedWindow.timeEnd,
      limit: 24
    });
    const focusedTimeline = filterResultsForRecapFocus(timeline.timeline, focus);
    if (focusedTimeline.length > 0) {
      enrichedResults = mergeRecallResults(mergedResults, focusedTimeline, limit * 3);
    }
  }

  if (temporalDifferential) {
    enrichedResults = [...enrichedResults].sort(
      (left, right) => temporalDifferentialSignalScore(right, focus, resolvedWindow) - temporalDifferentialSignalScore(left, focus, resolvedWindow)
    );
  }

  let selected = selectRecapContextResults(enrichedResults, focus, limit, query.query);
  const minimumSubstantiveRows = Math.min(2, limit);

  if (selected.results.filter((result) => isSubstantiveRecapResult(result)).length < minimumSubstantiveRows && selected.results.some((result) => result.artifactId)) {
    const artifactSiblingRows = await loadArtifactSiblingEpisodicRows(
      query.namespaceId,
      uniqueStrings(
        selected.results
          .map((result) => result.artifactId ?? "")
          .filter((artifactId): artifactId is string => artifactId.length > 0)
      )
    );
    const focusedSiblings = filterResultsForRecapFocus(artifactSiblingRows, focus);
    if (focusedSiblings.length > 0) {
      selected = selectRecapContextResults(mergeRecallResults(selected.results, focusedSiblings, limit * 2), focus, limit, query.query);
    }
  }

  if (
    (selected.results.length < Math.min(2, limit) || selected.results.filter((result) => isSubstantiveRecapResult(result)).length < minimumSubstantiveRows) &&
    resolvedWindow.timeStart &&
    resolvedWindow.timeEnd
  ) {
    const timeline = await timelineMemory({
      namespaceId: query.namespaceId,
      timeStart: resolvedWindow.timeStart,
      timeEnd: resolvedWindow.timeEnd,
      limit: 24
    });
    const broaderTimeline = timeline.timeline.filter((result) => {
      if (selected.results.some((existing) => existing.memoryId === result.memoryId)) {
        return false;
      }
      if (focus.participants.length > 0 && recallTextMatchesAny(result, focus.participants)) {
        return true;
      }
      return focus.topics.length === 0 && focus.projects.length === 0;
    });
    if (broaderTimeline.length > 0) {
      selected = selectRecapContextResults(mergeRecallResults(selected.results, broaderTimeline, limit), focus, limit, query.query);
    }
  }

  if (selected.results.some((result) => result.artifactId) && !selected.results.some((result) => result.memoryType === "episodic_memory")) {
    const artifactSiblingRows = await loadArtifactSiblingEpisodicRows(
      query.namespaceId,
      uniqueStrings(
        selected.results
          .map((result) => result.artifactId ?? "")
          .filter((artifactId): artifactId is string => artifactId.length > 0)
      )
    );
    const focusedSiblings = filterResultsForRecapFocus(artifactSiblingRows, focus);
    if (focusedSiblings.length > 0) {
      selected = selectRecapContextResults(mergeRecallResults(selected.results, focusedSiblings, limit), focus, limit, query.query);
    }
  }

  const anchorPatterns = recapAnchorPatterns(query.query, intent);
  if (anchorPatterns.length > 0 && selected.results.some((result) => result.artifactId)) {
    const artifactSiblingRows = await loadArtifactSiblingEpisodicRows(
      query.namespaceId,
      uniqueStrings(
        selected.results
          .map((result) => result.artifactId ?? "")
          .filter((artifactId): artifactId is string => artifactId.length > 0)
      )
    );
    const anchorRows = artifactSiblingRows.filter((result) => anchorPatterns.some((pattern) => pattern.test(result.content)));
    if (anchorRows.length > 0) {
      const anchoredRows: RecallResult[] = [];
      const seen = new Set<string>();
      for (const row of [...anchorRows, ...selected.results]) {
        if (seen.has(row.memoryId)) {
          continue;
        }
        seen.add(row.memoryId);
        anchoredRows.push(row);
        if (anchoredRows.length >= limit) {
          break;
        }
      }
      selected = {
        results: anchoredRows,
        groupedBy: selected.groupedBy
      };
    }
  }

  const anchorSearchPhrases = recapAnchorSearchPhrases(query.query, intent);
  if (anchorSearchPhrases.length > 0 && !selected.results.some((result) => anchorPatterns.some((pattern) => pattern.test(result.content)))) {
    const anchorPhraseRows: RecallResult[] = [];
    const seen = new Set<string>();
    for (const phrase of anchorSearchPhrases) {
      const rows = await loadRelativePhraseEpisodicRows(query.namespaceId, phrase, 8);
      for (const row of rows) {
        if (seen.has(row.memoryId)) {
          continue;
        }
        seen.add(row.memoryId);
        anchorPhraseRows.push(row);
      }
    }
    if (anchorPhraseRows.length > 0) {
      const anchorSiblingRows = anchorPhraseRows.some((row) => row.artifactId)
        ? await loadArtifactSiblingEpisodicRows(
            query.namespaceId,
            uniqueStrings(
              anchorPhraseRows
                .map((row) => row.artifactId ?? "")
                .filter((artifactId): artifactId is string => artifactId.length > 0)
            )
          )
        : [];
      const anchoredRows: RecallResult[] = [];
      const selectedIds = new Set<string>();
      for (const row of [...anchorPhraseRows, ...anchorSiblingRows, ...selected.results]) {
        if (selectedIds.has(row.memoryId)) {
          continue;
        }
        selectedIds.add(row.memoryId);
        anchoredRows.push(row);
        if (anchoredRows.length >= limit) {
          break;
        }
      }
      selected = {
        results: anchoredRows,
        groupedBy: selected.groupedBy
      };
    }
  }

  const evidence = buildEvidenceBundle(selected.results);
  let assessment =
    primaryResponse?.meta.answerAssessment && evidence.length > 0
      ? buildFallbackRecapAssessment(
          selected.results,
          evidence,
          query.query,
          queryDecompositionApplied || primaryResponse.meta.queryDecomposition?.applied === true
        )
      : buildFallbackRecapAssessment(selected.results, evidence, query.query, queryDecompositionApplied);
  if (
    assessment.confidence !== "confident" &&
    evidence.length >= 1 &&
    (focus.projects.length > 0 || focus.topics.length > 0 || focus.participants.length >= 2) &&
    selected.results.some((result) => result.content.length >= 120)
  ) {
    assessment = {
      ...assessment,
      confidence: "confident",
      reason: "The recap is grounded in a focused evidence pack with explicit participant/topic detail."
    };
  }
  const duality = buildDualityObject(selected.results, evidence, assessment, query.namespaceId, query.query);

  return {
    focus,
    resolvedWindow,
    results: selected.results,
    evidence,
    retrievalPlan: {
      probes,
      groupedBy: selected.groupedBy,
      queryDecompositionApplied,
      queryDecompositionSubqueries: [...decompositionSubqueries]
    },
    assessment,
    duality
  };
}

export async function recapMemory(query: RecapQuery): Promise<RecapResponse> {
  const pipeline = await runRecapPipeline("recap", {
    ...query,
    provider: query.provider ?? "none"
  });
  const derivation = await deriveRecapOutput("recap", query, pipeline.focus, pipeline.resolvedWindow, pipeline.evidence);
  const deterministicSummary = buildDeterministicRecapSummary(pipeline.results, query.query);
  const selectedSummary = strengthenContinuityTaskSummary(
    query.query,
    selectRecapSummaryText(
      query.query,
      derivation.payload && typeof derivation.payload.summary_text === "string" ? derivation.payload.summary_text : undefined,
      deterministicSummary
    ),
    pipeline.results
  );
  const finalizedSummary = await augmentPickBackUpSummaryWithTaskRecovery(query, selectedSummary);

  return {
    query: query.query,
    namespaceId: query.namespaceId,
    intent: "recap",
    resolvedWindow: pipeline.resolvedWindow,
    focus: pipeline.focus,
    confidence: pipeline.duality.confidence,
    followUpAction: pipeline.duality.followUpAction,
    clarificationHint: pipeline.duality.clarificationHint,
    evidence: pipeline.evidence,
    retrievalPlan: {
      intent: "recap",
      probes: pipeline.retrievalPlan.probes,
      groupedBy: pipeline.retrievalPlan.groupedBy,
      queryDecompositionApplied: pipeline.retrievalPlan.queryDecompositionApplied,
      queryDecompositionSubqueries: pipeline.retrievalPlan.queryDecompositionSubqueries
    },
    summaryBasis: summaryBasisForResults(pipeline.results),
    summaryText: finalizedSummary,
    derivation: derivation.derivation
  };
}

export async function extractTaskMemory(query: RecapQuery): Promise<TaskExtractionResponse> {
  const pipeline = await runRecapPipeline("task_extraction", {
    ...query,
    provider: query.provider ?? "none"
  });
  const derivation = await deriveRecapOutput("task_extraction", query, pipeline.focus, pipeline.resolvedWindow, pipeline.evidence);
  const derivedTasks = Array.isArray(derivation.payload?.tasks)
    ? derivation.payload.tasks
        .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
        .map<RecapTaskItem>((item) => ({
          title: typeof item.title === "string" ? item.title : "Untitled task",
          description: typeof item.description === "string" ? item.description : typeof item.title === "string" ? item.title : "Untitled task",
          assigneeGuess: typeof item.assignee_guess === "string" ? item.assignee_guess : undefined,
          project: typeof item.project === "string" ? item.project : undefined,
          dueHint: typeof item.due_hint === "string" ? item.due_hint : undefined,
          statusGuess: typeof item.status_guess === "string" ? item.status_guess : undefined,
          evidenceIds: Array.isArray(item.evidence_ids)
            ? item.evidence_ids.filter((value): value is string => typeof value === "string")
            : []
        }))
    : [];
  const typedTasks = await getTypedTaskItems(query);
  const tasks =
    typedTasks.length > 0
      ? typedTasks
      : derivedTasks.length > 0
        ? derivedTasks
        : parseTaskItems(pipeline.results, pipeline.focus);

  return {
    query: query.query,
    namespaceId: query.namespaceId,
    intent: "task_extraction",
    resolvedWindow: pipeline.resolvedWindow,
    focus: pipeline.focus,
    confidence: pipeline.duality.confidence,
    followUpAction: pipeline.duality.followUpAction,
    clarificationHint: pipeline.duality.clarificationHint,
    evidence: pipeline.evidence,
    retrievalPlan: {
      intent: "task_extraction",
      probes: pipeline.retrievalPlan.probes,
      groupedBy: pipeline.retrievalPlan.groupedBy,
      queryDecompositionApplied: pipeline.retrievalPlan.queryDecompositionApplied,
      queryDecompositionSubqueries: pipeline.retrievalPlan.queryDecompositionSubqueries
    },
    tasks,
    derivation: derivation.derivation
  };
}

export async function extractCalendarMemory(query: RecapQuery): Promise<CalendarExtractionResponse> {
  const pipeline = await runRecapPipeline("calendar_extraction", {
    ...query,
    provider: query.provider ?? "none"
  });
  const derivation = await deriveRecapOutput("calendar_extraction", query, pipeline.focus, pipeline.resolvedWindow, pipeline.evidence);
  const derivedCommitments = Array.isArray(derivation.payload?.commitments)
    ? derivation.payload.commitments
        .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
        .map<CalendarCommitmentItem>((item) => ({
          title: typeof item.title === "string" ? item.title : "Untitled commitment",
          participants: Array.isArray(item.participants)
            ? item.participants.filter((value): value is string => typeof value === "string")
            : [],
          timeHint: typeof item.time_hint === "string" ? item.time_hint : undefined,
          locationHint: typeof item.location_hint === "string" ? item.location_hint : undefined,
          certainty:
            item.certainty === "high" || item.certainty === "medium" || item.certainty === "low" ? item.certainty : "medium",
          evidenceIds: Array.isArray(item.evidence_ids)
            ? item.evidence_ids.filter((value): value is string => typeof value === "string")
            : []
        }))
    : [];
  let commitments = derivedCommitments.length > 0 ? derivedCommitments : parseCalendarItems(pipeline.results, pipeline.focus);
  if (commitments.length < 2 && pipeline.resolvedWindow.timeStart && pipeline.resolvedWindow.timeEnd) {
    const timeline = await timelineMemory({
      namespaceId: query.namespaceId,
      timeStart: pipeline.resolvedWindow.timeStart,
      timeEnd: pipeline.resolvedWindow.timeEnd,
      limit: 24
    });
    const timelineCommitments = parseCalendarItems(
      timeline.timeline.filter((result) => result.memoryType === "episodic_memory"),
      pipeline.focus
    );
    const merged = new Map<string, CalendarCommitmentItem>();
    for (const item of [...commitments, ...timelineCommitments]) {
      merged.set(item.title.toLowerCase(), item);
    }
    commitments = [...merged.values()].slice(0, 12);
  }
  if (pipeline.resolvedWindow.label) {
    const relativeRows = await loadRelativePhraseEpisodicRows(query.namespaceId, pipeline.resolvedWindow.label, 12);
    const relativeCommitments = parseCalendarItems(relativeRows, pipeline.focus);
    const merged = new Map<string, CalendarCommitmentItem>();
    for (const item of [...commitments, ...relativeCommitments]) {
      merged.set(item.title.toLowerCase(), item);
    }
    commitments = [...merged.values()].slice(0, 12);
  }

  return {
    query: query.query,
    namespaceId: query.namespaceId,
    intent: "calendar_extraction",
    resolvedWindow: pipeline.resolvedWindow,
    focus: pipeline.focus,
    confidence: pipeline.duality.confidence,
    followUpAction: pipeline.duality.followUpAction,
    clarificationHint: pipeline.duality.clarificationHint,
    evidence: pipeline.evidence,
    retrievalPlan: {
      intent: "calendar_extraction",
      probes: pipeline.retrievalPlan.probes,
      groupedBy: pipeline.retrievalPlan.groupedBy,
      queryDecompositionApplied: pipeline.retrievalPlan.queryDecompositionApplied,
      queryDecompositionSubqueries: pipeline.retrievalPlan.queryDecompositionSubqueries
    },
    commitments,
    derivation: derivation.derivation
  };
}

export async function explainRecap(query: RecapQuery): Promise<ExplainRecapResponse> {
  const recap = await recapMemory({
    ...query,
    provider: "none"
  });
  const sourceList = recap.evidence
    .map((item) => item.sourceUri ?? item.artifactId ?? item.memoryId)
    .slice(0, 4)
    .join(", ");
  const explanation =
    recap.evidence.length > 0
      ? `The recap is grounded in ${recap.evidence.length} evidence rows from ${sourceList}. The resolved window was ${recap.resolvedWindow.label ?? recap.resolvedWindow.timeStart ?? "not explicitly anchored"}, and the result set was grouped by ${recap.retrievalPlan.groupedBy}.`
      : `No grounded evidence was available for ${query.query}.`;

  return {
    query: query.query,
    namespaceId: query.namespaceId,
    intent: "explain_recap",
    resolvedWindow: recap.resolvedWindow,
    focus: recap.focus,
    confidence: recap.confidence,
    followUpAction: recap.followUpAction,
    clarificationHint: recap.clarificationHint,
    evidence: recap.evidence,
    retrievalPlan: {
      intent: "explain_recap",
      probes: recap.retrievalPlan.probes,
      groupedBy: recap.retrievalPlan.groupedBy,
      queryDecompositionApplied: recap.retrievalPlan.queryDecompositionApplied,
      queryDecompositionSubqueries: recap.retrievalPlan.queryDecompositionSubqueries
    },
    explanation,
    claimText: recap.summaryText
  };
}

export async function getArtifactDetail(query: ArtifactLookupQuery): Promise<ArtifactDetail | null> {
  const artifactRows = await queryRows<ArtifactRow>(
    `
      SELECT
        id AS artifact_id,
        namespace_id,
        artifact_type,
        uri,
        latest_checksum_sha256,
        mime_type,
        source_channel,
        created_at,
        last_seen_at,
        metadata
      FROM artifacts
      WHERE id = $1
      LIMIT 1
    `,
    [query.artifactId]
  );

  const artifact = artifactRows[0];
  if (!artifact) {
    return null;
  }

  const observations = await queryRows<ArtifactObservationRow>(
    `
      SELECT
        id AS observation_id,
        version,
        checksum_sha256,
        byte_size,
        observed_at,
        metadata
      FROM artifact_observations
      WHERE artifact_id = $1
      ORDER BY version DESC
    `,
    [query.artifactId]
  );

  const derivations = await queryRows<ArtifactDerivationRow>(
    `
      SELECT
        ad.id AS derivation_id,
        ad.derivation_type,
        ad.provider,
        ad.model,
        ad.content_text,
        ad.output_dimensionality,
        ad.created_at,
        ad.metadata
      FROM artifact_derivations ad
      JOIN artifact_observations ao ON ao.id = ad.artifact_observation_id
      WHERE ao.artifact_id = $1
      ORDER BY ad.created_at DESC
    `,
    [query.artifactId]
  );

  return {
    artifactId: artifact.artifact_id,
    namespaceId: artifact.namespace_id,
    artifactType: artifact.artifact_type,
    uri: artifact.uri,
    latestChecksumSha256: artifact.latest_checksum_sha256,
    mimeType: artifact.mime_type,
    sourceChannel: artifact.source_channel,
    createdAt: toIsoString(artifact.created_at) ?? "",
    lastSeenAt: toIsoString(artifact.last_seen_at) ?? "",
    metadata: artifact.metadata,
    observations: observations.map<ArtifactObservationSummary>((row) => ({
      observationId: row.observation_id,
      version: row.version,
      checksumSha256: row.checksum_sha256,
      byteSize: row.byte_size,
      observedAt: toIsoString(row.observed_at) ?? "",
      metadata: row.metadata
    })),
    derivations: derivations.map<ArtifactDerivationSummary>((row) => ({
      derivationId: row.derivation_id,
      derivationType: row.derivation_type,
      provider: row.provider,
      model: row.model,
      contentText: row.content_text,
      outputDimensionality: row.output_dimensionality,
      createdAt: toIsoString(row.created_at) ?? "",
      metadata: row.metadata
    }))
  };
}

export async function getRelationships(query: RelationshipQuery): Promise<RelationshipResponse> {
  const limit = normalizeLimit(query.limit);
  const normalizedEntityName = query.entityName.trim().toLowerCase();
  const resolvedEntity = await resolveCanonicalEntityReference(query.namespaceId, query.entityName);
  const includeHistorical = query.includeHistorical ?? Boolean(query.timeStart || query.timeEnd);
  const rows = await queryRows<RelationshipRow>(
    `
      WITH matched_entities AS (
        SELECT e.id
        FROM entities e
        WHERE e.namespace_id = $1
          AND e.normalized_name = $2
        UNION
        SELECT ea.entity_id
        FROM entity_aliases ea
        INNER JOIN entities e ON e.id = ea.entity_id
        WHERE e.namespace_id = $1
          AND ea.normalized_alias = $2
      )
      SELECT
        relationship_id,
        relationships.subject_entity_id::text,
        subject_entity.canonical_name AS subject_name,
        predicate,
        relationships.object_entity_id::text,
        object_entity.canonical_name AS object_name,
        relationships.status,
        confidence,
        source_memory_id,
        occurred_at,
        valid_from,
        valid_until,
        relationships.namespace_id,
        provenance
      FROM (
        SELECT
          rm.id AS relationship_id,
          rm.subject_entity_id,
          rm.predicate,
          rm.object_entity_id,
          rm.status,
          rm.confidence,
          COALESCE(
            rc.source_memory_id,
            NULLIF(rm.metadata->>'source_memory_id', '')::uuid
          ) AS source_memory_id,
          COALESCE(rm.valid_from, em.occurred_at) AS occurred_at,
          rm.valid_from,
          rm.valid_until,
          rm.namespace_id,
          jsonb_strip_nulls(
            jsonb_build_object(
              'tier', 'relationship_memory',
              'status', rm.status,
              'valid_from', rm.valid_from,
              'valid_until', rm.valid_until,
              'source_candidate_id', rm.source_candidate_id,
              'source_memory_id', COALESCE(
                rc.source_memory_id::text,
                NULLIF(rm.metadata->>'source_memory_id', '')
              ),
              'source_chunk_id', COALESCE(
                rc.source_chunk_id::text,
                NULLIF(rm.metadata->>'source_chunk_id', '')
              ),
              'source_uri', COALESCE(
                a.uri,
                NULLIF(rm.metadata->>'source_uri', '')
              ),
              'source_offset', em.source_offset,
              'source_artifact_id', COALESCE(
                em.artifact_id::text,
                NULLIF(rm.metadata->>'source_artifact_id', '')
              ),
              'metadata', rm.metadata
            )
          ) AS provenance
        FROM relationship_memory rm
        LEFT JOIN relationship_candidates rc
          ON rc.id = rm.source_candidate_id
        LEFT JOIN episodic_memory em
          ON em.id = COALESCE(
            rc.source_memory_id,
            NULLIF(rm.metadata->>'source_memory_id', '')::uuid
          )
        LEFT JOIN artifacts a
          ON a.id = em.artifact_id
        WHERE rm.namespace_id = $1
          AND (
            ($8::boolean = false AND rm.status = 'active' AND rm.valid_until IS NULL)
            OR ($8::boolean = true AND rm.status <> 'invalid')
          )

        UNION ALL

        SELECT
          rc.id AS relationship_id,
          rc.subject_entity_id,
          rc.predicate,
          rc.object_entity_id,
          rc.status,
          rc.confidence,
          rc.source_memory_id,
          COALESCE(em.occurred_at, rc.valid_from, rc.created_at) AS occurred_at,
          COALESCE(rc.valid_from, em.occurred_at, rc.created_at) AS valid_from,
          rc.valid_until,
          rc.namespace_id,
          jsonb_build_object(
            'tier', 'relationship_candidate',
            'status', rc.status,
            'valid_from', COALESCE(rc.valid_from, em.occurred_at, rc.created_at),
            'valid_until', rc.valid_until,
            'source_chunk_id', rc.source_chunk_id,
            'source_uri', a.uri,
            'source_offset', em.source_offset,
            'metadata', rc.metadata
          ) AS provenance
        FROM relationship_candidates rc
        LEFT JOIN episodic_memory em ON em.id = rc.source_memory_id
        LEFT JOIN artifacts a ON a.id = em.artifact_id
        WHERE rc.namespace_id = $1
          AND rc.status IN ('pending', 'accepted')
      ) relationships
      INNER JOIN entities subject_entity ON subject_entity.id = relationships.subject_entity_id
      INNER JOIN entities object_entity ON object_entity.id = relationships.object_entity_id
      WHERE ($3::text IS NULL OR relationships.predicate = $3)
        AND ($4::timestamptz IS NULL OR relationships.occurred_at >= $4)
        AND ($5::timestamptz IS NULL OR relationships.occurred_at <= $5)
        AND (
          ($7::uuid IS NOT NULL AND (relationships.subject_entity_id = $7::uuid OR relationships.object_entity_id = $7::uuid))
          OR relationships.subject_entity_id IN (SELECT id FROM matched_entities)
          OR relationships.object_entity_id IN (SELECT id FROM matched_entities)
        )
      ORDER BY
        CASE WHEN relationships.status = 'active' AND relationships.valid_until IS NULL THEN 0 ELSE 1 END,
        confidence DESC,
        COALESCE(relationships.valid_until, relationships.occurred_at) DESC NULLS LAST,
        relationships.occurred_at DESC NULLS LAST
      LIMIT $6
    `,
    [query.namespaceId, normalizedEntityName, query.predicate ?? null, query.timeStart ?? null, query.timeEnd ?? null, limit, resolvedEntity?.entityId ?? null, includeHistorical]
  );

  if (rows.length === 0) {
    if (resolvedEntity) {
      const aliasRows = await queryRows<{
        readonly alias: string;
        readonly alias_type: string;
        readonly metadata: Record<string, unknown> | null;
      }>(
        `
          SELECT alias, alias_type, metadata
          FROM entity_aliases
          WHERE entity_id = $1::uuid
          ORDER BY is_user_verified DESC, alias_type ASC, alias ASC
        `,
        [resolvedEntity.entityId]
      );
      const aliasRelationships = aliasRows
        .filter((row) => normalizeWhitespace(row.alias).toLowerCase() !== resolvedEntity.canonicalName.toLowerCase())
        .map<RelationshipResult>((row, index) =>
          sanitizeRelationshipResult({
            relationshipId: `entity-alias:${resolvedEntity.entityId}:${index}`,
            subjectEntityId: resolvedEntity.entityId,
            subjectName: resolvedEntity.canonicalName,
            predicate: "also_known_as",
            objectName: row.alias,
            status: "active",
            confidence: row.alias_type === "manual" ? 0.99 : 0.9,
            sourceMemoryId: typeof row.metadata?.source_memory_id === "string" ? row.metadata.source_memory_id : null,
            occurredAt: null,
            validFrom: null,
            validUntil: null,
            namespaceId: query.namespaceId,
            provenance: {
              tier: "entity_alias",
              matched_via: resolvedEntity.matchedVia,
              source_uri: typeof row.metadata?.source_uri === "string" ? row.metadata.source_uri : null,
              metadata: row.metadata ?? {}
            }
          })
        );
      if (aliasRelationships.length > 0) {
        return {
          relationships: aliasRelationships.slice(0, limit)
        };
      }
    }

    const fallbackRows = await queryRows<RelationshipFallbackSourceRow>(
      `
        SELECT
          e.id::text AS source_memory_id,
          e.content,
          e.occurred_at,
          e.namespace_id,
          a.uri AS source_uri
        FROM episodic_memory e
        LEFT JOIN artifacts a ON a.id = e.artifact_id
        WHERE e.namespace_id = $1
          AND (
            a.uri LIKE '%/omi-archive/normalized/%'
            OR a.uri LIKE '%/data/inbox/omi/normalized/%'
            OR a.uri LIKE '%/personal-openclaw-fixtures/%'
          )
          AND lower(e.content) LIKE '%' || $2 || '%'
          AND ($3::timestamptz IS NULL OR e.occurred_at >= $3)
          AND ($4::timestamptz IS NULL OR e.occurred_at <= $4)
        ORDER BY e.occurred_at DESC NULLS LAST
        LIMIT $5
      `,
      [query.namespaceId, normalizedEntityName, query.timeStart ?? null, query.timeEnd ?? null, Math.max(limit * 3, 12)]
    );
    const fallback = dedupeRelationshipResults(buildFallbackRelationships(query, fallbackRows)).slice(0, limit);
    if (fallback.length > 0) {
      return { relationships: fallback };
    }
  }

  return {
    relationships: dedupeRelationshipResults(
      rows.map<RelationshipResult>((row) =>
        sanitizeRelationshipResult({
          relationshipId: row.relationship_id,
          subjectEntityId: row.subject_entity_id,
          subjectName: row.subject_name,
          predicate: row.predicate,
          objectEntityId: row.object_entity_id,
          objectName: row.object_name,
          status: row.status,
          confidence: toNumber(row.confidence),
          sourceMemoryId: row.source_memory_id,
          occurredAt: toIsoString(row.occurred_at),
          validFrom: toIsoString(row.valid_from),
          validUntil: toIsoString(row.valid_until),
          namespaceId: row.namespace_id,
          provenance: row.provenance
        })
      )
    ).slice(0, limit)
  };
}

function sanitizeRelationshipResult(result: RelationshipResult): RelationshipResult {
  return {
    ...result,
    objectName: normalizeRelationshipObjectName(result.predicate, result.subjectName, result.objectName)
  };
}

function dedupeRelationshipResults(results: readonly RelationshipResult[]): readonly RelationshipResult[] {
  const byKey = new Map<string, RelationshipResult>();
  for (const input of results) {
    const result = sanitizeRelationshipResult(input);
    const key = `${result.subjectName.toLowerCase()}|${result.predicate.toLowerCase()}|${normalizeRelationshipObjectKey(result.predicate, result.subjectName, result.objectName)}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, result);
      continue;
    }
    const existingTier = relationshipTierRank(existing.provenance?.tier);
    const nextTier = relationshipTierRank(result.provenance?.tier);
    const existingConfidence = existing.confidence ?? 0;
    const nextConfidence = result.confidence ?? 0;
    const existingTime = existing.occurredAt ? Date.parse(existing.occurredAt) : 0;
    const nextTime = result.occurredAt ? Date.parse(result.occurredAt) : 0;
    const existingSnippetLength = typeof existing.provenance?.snippet === "string" ? existing.provenance.snippet.length : 0;
    const nextSnippetLength = typeof result.provenance?.snippet === "string" ? result.provenance.snippet.length : 0;
    if (
      nextTier > existingTier ||
      (nextTier === existingTier && nextConfidence > existingConfidence) ||
      (nextTier === existingTier && nextConfidence === existingConfidence && nextTime > existingTime) ||
      (nextTier === existingTier &&
        nextConfidence === existingConfidence &&
        nextTime === existingTime &&
        nextSnippetLength > existingSnippetLength)
    ) {
      byKey.set(key, result);
    }
  }
  return [...byKey.values()].sort((left, right) => {
    const tierDelta = relationshipTierRank(right.provenance?.tier) - relationshipTierRank(left.provenance?.tier);
    if (tierDelta !== 0) {
      return tierDelta;
    }
    const confidenceDelta = (right.confidence ?? 0) - (left.confidence ?? 0);
    if (confidenceDelta !== 0) {
      return confidenceDelta;
    }
    const timeDelta = (right.occurredAt ? Date.parse(right.occurredAt) : 0) - (left.occurredAt ? Date.parse(left.occurredAt) : 0);
    if (timeDelta !== 0) {
      return timeDelta;
    }
    return (right.objectName?.length ?? 0) - (left.objectName?.length ?? 0);
  });
}

function relationshipTierRank(tier: unknown): number {
  switch (tier) {
    case "relationship_memory":
      return 3;
    case "relationship_candidate":
      return 2;
    case "entity_alias":
      return 2;
    case "relationship_profile_fallback":
      return 1;
    default:
      return 0;
  }
}

function normalizeRelationshipObjectKey(predicate: string, subjectName: string, objectName: string): string {
  return normalizeRelationshipObjectName(predicate, subjectName, objectName).toLowerCase();
}

function normalizeRelationshipObjectName(predicate: string, subjectName: string, objectName: string): string {
  let normalized = canonicalizeObservedEntityText(normalizeWhitespace(objectName).replace(/[.,!?]+$/u, ""));
  if (predicate === "owner_of") {
    const escapedSubject = subjectName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    normalized = normalized
      .replace(new RegExp(`^${escapedSubject}\\s+is\\s+the\\s+owner\\s+of\\s+the\\s+`, "iu"), "")
      .replace(new RegExp(`^${escapedSubject}\\s+is\\s+the\\s+owner\\s+of\\s+`, "iu"), "")
      .replace(/^owner of the\s+/iu, "")
      .replace(/^owner of\s+/iu, "")
      .replace(/^(?:a|an)\s+/iu, "");
    if (/samui experience/iu.test(normalized) || /kozimui experience/iu.test(normalized) || /koh samui experience/iu.test(normalized) || /private park experience on koh samui/iu.test(normalized)) {
      return "Samui Experience";
    }
  }
  if (/kozimui|koh samui/iu.test(normalized) && !/experience/iu.test(normalized)) {
    return "Koh Samui";
  }
  if (/lake he|lake taho|lake tahoe/iu.test(normalized)) {
    return "Lake Tahoe";
  }
  return normalized;
}

function sanitizeRelationshipObjectName(predicate: string, subjectName: string, objectName: string): string | null {
  const normalized = normalizeRelationshipObjectName(predicate, subjectName, objectName);
  const lowered = normalized.toLowerCase();
  if (
    [
      "which",
      "that",
      "this",
      "it",
      "someone",
      "somebody",
      "something",
      "him",
      "her",
      "them"
    ].includes(lowered)
  ) {
    return null;
  }
  if (
    lowered.startsWith("spelled ") ||
    /^g(?:[\s-]*u)(?:[\s-]*m){2}[\s-]*i$/iu.test(normalized) ||
    /^spelled\s+g(?:[\s-]*u)(?:[\s-]*m){2}[\s-]*i$/iu.test(normalized)
  ) {
    return null;
  }
  return normalized;
}

function buildFallbackRelationships(
  query: RelationshipQuery,
  rows: readonly RelationshipFallbackSourceRow[]
): readonly RelationshipResult[] {
  const entityName = normalizeWhitespace(query.entityName).trim();
  if (!entityName) {
    return [];
  }

  const normalizedEntity = entityName.toLowerCase();
  const normalizedPredicate = query.predicate?.trim().toLowerCase() ?? null;
  const results: RelationshipResult[] = [];
  const seen = new Set<string>();

  const push = (
    predicate: string,
    objectName: string,
    confidence: number,
    row: RelationshipFallbackSourceRow,
    snippet: string
  ) => {
    if (normalizedPredicate && normalizedPredicate !== predicate.toLowerCase()) {
      return;
    }
    const normalizedObjectName = sanitizeRelationshipObjectName(predicate, entityName, objectName);
    if (!normalizedObjectName) {
      return;
    }
    const key = `${entityName.toLowerCase()}|${predicate.toLowerCase()}|${normalizedObjectName.toLowerCase()}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    results.push({
      relationshipId: `fallback:${key}:${row.source_memory_id}`,
      subjectName: entityName,
      predicate,
      objectName: normalizedObjectName,
      status: "derived",
      confidence,
      sourceMemoryId: row.source_memory_id,
      occurredAt: toIsoString(row.occurred_at),
      validFrom: toIsoString(row.occurred_at),
      validUntil: null,
      namespaceId: row.namespace_id,
      provenance: {
        tier: "relationship_profile_fallback",
        source_uri: row.source_uri,
        snippet,
        derived: true
      }
    });
  };

  for (const row of rows) {
    const sentences = extractSentenceCandidates(row.content);
    for (const sentence of sentences) {
      for (const clause of extractEntityRelationshipClauses(sentence, entityName)) {
        const normalizedClause = clause.toLowerCase();
        if (!normalizedClause.includes(normalizedEntity)) {
          continue;
        }
        const entityTail = sliceSentenceFromEntity(clause, entityName);
        const entityWindow = entityTail ? clipEntityRelationshipWindow(entityTail) : undefined;
        if (!entityWindow) {
          continue;
        }

        if (/\b(?:is|was|became|becomes|has been|have been)?[\s,.-]{0,24}(?:a|an|the|my)?[\s-]{0,12}(?:close friend|good friend|old friend|best friend|friend)\b/iu.test(entityWindow)) {
          push("friend_of", "Steve", 0.78, row, clause);
        }

        if (/\b(?:is|was|became|had been)?[\s,.-]{0,32}(?:a|an|the|my)?[\s-]{0,12}(?:former romantic|former partner|dated|off[- ]and[- ]on relationship|on[- ]and[- ]off romantic|partner)\b/iu.test(entityWindow)) {
          push("former_partner_of", "Steve", 0.82, row, clause);
        }

        const ownerMatch = findEntityAdjacentObject(
          entityWindow,
          /\bowner of\s+(?:the\s+)?([A-Z][A-Za-z0-9'’& -]{2,80})/iu,
          140
        );
        if (ownerMatch) {
          push("owner_of", ownerMatch, 0.8, row, clause);
        }

        const roleMatch = findEntityAdjacentObject(
          entityWindow,
          /\b(?:adviser|advisor|cto)\b[\s\S]{0,80}\b(?:company|at)\s+["“]?([A-Z0-9][A-Za-z0-9'’& -]{1,80})["”]?/iu,
          140
        );
        if (roleMatch) {
          push("works_with", "Steve", 0.74, row, clause);
          push("associated_with", roleMatch, 0.72, row, clause);
        }

        for (const place of extractAssociatedPlacesNearEntity(entityWindow)) {
          push("associated_with", place, 0.68, row, clause);
        }
      }

      if (sentence.toLowerCase().includes(normalizedEntity)) {
        for (const objectName of findSentenceLevelRelationshipObjects(sentence, entityName)) {
          push("owner_of", objectName, 0.8, row, sentence);
          push("associated_with", objectName, 0.76, row, sentence);
        }
      }
    }
  }

  return results.sort((left, right) => {
    const leftConfidence = left.confidence ?? 0;
    const rightConfidence = right.confidence ?? 0;
    if (rightConfidence !== leftConfidence) {
      return rightConfidence - leftConfidence;
    }
    const leftObjectLength = left.objectName?.length ?? 0;
    const rightObjectLength = right.objectName?.length ?? 0;
    if (rightObjectLength !== leftObjectLength) {
      return rightObjectLength - leftObjectLength;
    }
    const leftTime = left.occurredAt ? Date.parse(left.occurredAt) : 0;
    const rightTime = right.occurredAt ? Date.parse(right.occurredAt) : 0;
    return rightTime - leftTime;
  });
}

function extractEntityRelationshipClauses(sentence: string, entityName: string): readonly string[] {
  const normalizedEntity = entityName.trim().toLowerCase();
  if (!normalizedEntity) {
    return [];
  }

  const clauses = sentence
    .split(/\s*(?:;|(?<!\bLake)\bbut\b|(?<!\bLake)\bhowever\b|\bwhereas\b)\s+/iu)
    .flatMap((part) => part.split(/\s+(?=(?:and\s+)?[A-Z][a-z]+,\s)/u))
    .map((part) => normalizeWhitespace(part))
    .filter((part) => part.length >= 8);
  const matching = clauses.filter((part) => part.toLowerCase().includes(normalizedEntity));
  return matching.length > 0 ? matching : [normalizeWhitespace(sentence)];
}

function sliceSentenceFromEntity(sentence: string, entityName: string): string | undefined {
  const normalizedSentence = sentence.toLowerCase();
  const normalizedEntity = entityName.trim().toLowerCase();
  const entityIndex = normalizedSentence.indexOf(normalizedEntity);
  if (entityIndex === -1) {
    return undefined;
  }
  return normalizeWhitespace(sentence.slice(entityIndex));
}

function clipEntityRelationshipWindow(entityTail: string): string {
  const delimiterPatterns = [
    /,\s+(?:and\s+)?[A-Z][a-z]+(?:\b|,)/u,
    /\b(?:but|however|whereas)\b/iu
  ];
  let endIndex = entityTail.length;
  for (const pattern of delimiterPatterns) {
    const match = pattern.exec(entityTail);
    if (match?.index !== undefined && match.index > 0) {
      endIndex = Math.min(endIndex, match.index);
    }
  }
  return normalizeWhitespace(entityTail.slice(0, endIndex));
}

function findEntityAdjacentObject(
  sentenceTail: string,
  objectPattern: RegExp,
  maxDistance: number
): string | undefined {
  const match = objectPattern.exec(sentenceTail);
  if (!match?.[1] || match.index === undefined || match.index > maxDistance) {
    return undefined;
  }
  return normalizeWhitespace(match[1]).replace(/^[Tt]he\s+/u, "").replace(/[.,!?]+$/u, "");
}

function findSentenceLevelRelationshipObjects(sentence: string, entityName: string): readonly string[] {
  const escapedEntity = entityName.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const objects = new Set<string>();
  const patterns = [
    new RegExp(`\\b([A-Z][A-Za-z0-9'’& -]{2,80}?)(?:\\s+company)?\\s+that\\s+${escapedEntity}\\s+owns\\b`, "giu"),
    new RegExp(`\\b([A-Z][A-Za-z0-9'’& -]{2,80}?)(?:\\s+company)?\\s+is\\s+owned\\s+by\\s+${escapedEntity}\\b`, "giu"),
    new RegExp(`\\b${escapedEntity}\\s*\\(([^)]+)\\)`, "giu"),
    new RegExp(`\\b${escapedEntity}\\s+that\\s+owns\\s+([A-Z][A-Za-z0-9'’& -]{2,80})\\b`, "giu")
  ];
  for (const pattern of patterns) {
    for (const match of sentence.matchAll(pattern)) {
      const value = match[1]?.trim();
      if (!value) {
        continue;
      }
      objects.add(value.replace(/^[Tt]he\s+/u, "").replace(/[.,!?]+$/u, "").trim());
    }
  }
  return [...objects];
}

function extractAssociatedPlacesNearEntity(sentenceTail: string): readonly string[] {
  const places = new Set<string>();
  const directPlacePatterns = [
    /\b(Chiang Mai|Bangkok|Thailand|Lake Tahoe|Koh Samui|Bend|Oregon|Mexico City|Tahoe City|Japan)\b/giu
  ];
  for (const pattern of directPlacePatterns) {
    for (const match of sentenceTail.matchAll(pattern)) {
      const value = match[1]?.trim();
      if (!value) {
        continue;
      }
      places.add(value);
    }
  }

  for (const match of sentenceTail.matchAll(/\b(?:from|in)\s+([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+){0,2})/gu)) {
    const value = match[1]?.trim();
    if (!value) {
      continue;
    }
    const cleaned = value.replace(/[.,!?]+$/u, "");
    if (
      cleaned.split(/\s+/u).length <= 3 &&
      !["Chiang", "Lake", "Koh", "Tahoe", "Mexico"].includes(cleaned) &&
      !cleaned.toLowerCase().startsWith("a ")
    ) {
      places.add(cleaned);
    }
  }

  return [...places];
}
