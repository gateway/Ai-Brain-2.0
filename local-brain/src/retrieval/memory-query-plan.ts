import {
  primaryRetrievalDomainForQueryContract,
  type QueryContractNameForRegistry,
  type RegistryAnswerShape,
  type RetrievalDomain
} from "../taxonomy/retrieval-domain-registry.js";
import { normalizeWhitespace } from "../identity/canonicalization.js";
import { extractPlaceScopes } from "./place-aliases.js";
import { canonicalCodexProjectLabel, codexProjectLabelFromText, knownCodexProjectLabels } from "./codex-project-aliases.js";
import type { QueryContract } from "./query-contract-router.js";
import type { RecallResponse } from "./types.js";

export type MemoryQueryPlanIntent =
  | "relationship_friend_set"
  | "relationship_map"
  | "source_audit"
  | "multi_entity_synthesis"
  | "multi_entity_work_context"
  | "task_list"
  | "project_task_scope"
  | "temporal_change"
  | "temporal_event"
  | "source_topic_report"
  | "work_history"
  | "career_history"
  | "document_lookup"
  | "document_spec"
  | "procedure_command"
  | "repo_doc_lookup"
  | "codex_session_report"
  | "engineering_memory_packet"
  | "workflow_pattern_report"
  | "codex_source_audit"
  | "codex_project_detail_report"
  | "corpus_unsupported"
  | "direct_fact"
  | "unknown";

export type MemoryQueryPlanSourceScope = "latest_omi_note" | "recent_notes" | "source_audit_target" | "none";
export type MemoryQueryPlanTaskScope = "active" | "latest_source" | "travel" | "all" | "none";
export type CorpusCapability =
  | "omi_personal_note"
  | "repo_docs"
  | "package_scripts"
  | "task_items"
  | "career_projection"
  | "source_topic_report"
  | "relationship_graph"
  | "temporal_events"
  | "codex_sessions"
  | "unknown";

export interface MemoryQueryPlanTimeWindow {
  readonly rawText: string | null;
  readonly start: string | null;
  readonly end: string | null;
  readonly granularity: "day" | "month" | "season" | "year" | "unknown";
  readonly relation: "explicit" | "relative" | "change" | "none";
}

export interface MemoryQueryPlanTemporalCandidateWindow {
  readonly label: string;
  readonly start: string | null;
  readonly end: string | null;
  readonly granularity: MemoryQueryPlanTimeWindow["granularity"];
}

export interface MemoryQueryPlanTemporalDecomposition {
  readonly subjectTerms: readonly string[];
  readonly objectTerms: readonly string[];
  readonly placeTerms: readonly string[];
  readonly projectTerms: readonly string[];
  readonly timeText: string | null;
  readonly intent: MemoryQueryPlanIntent;
  readonly answerShape: RegistryAnswerShape;
}

export interface MemoryQueryPlanTemporalConstraint {
  readonly field: "time_text" | "time_window" | "time_granularity" | "time_relation" | "temporal_clarification";
  readonly value: string;
  readonly source: "query_text" | "reference_now" | "planner";
}

export interface MemoryQueryPlanSourceAuditTarget {
  readonly family: "friend_set" | "temporal_event" | "task_list" | "source_topic" | "career" | "unknown";
  readonly names: readonly string[];
  readonly places: readonly string[];
  readonly projects: readonly string[];
}

export interface MemoryQueryPlanFilterTraceEntry {
  readonly field: string;
  readonly value: string;
  readonly reason: string;
}

export interface MemoryQueryPlan {
  readonly version: "memory_query_plan_v1";
  readonly intent: MemoryQueryPlanIntent;
  readonly retrievalDomain: RetrievalDomain;
  readonly queryContract: QueryContractNameForRegistry;
  readonly answerShape: RegistryAnswerShape;
  readonly subjects: readonly string[];
  readonly objects: readonly string[];
  readonly places: readonly string[];
  readonly projects: readonly string[];
  readonly timeWindow: MemoryQueryPlanTimeWindow | null;
  readonly temporalClarificationRequired: boolean;
  readonly temporalAmbiguityReason: string | null;
  readonly temporalCandidateWindows: readonly MemoryQueryPlanTemporalCandidateWindow[];
  readonly selectedTemporalAssumption: string | null;
  readonly temporalDecomposition: MemoryQueryPlanTemporalDecomposition;
  readonly temporalConstraintSet: readonly MemoryQueryPlanTemporalConstraint[];
  readonly timeNodeGranularity: MemoryQueryPlanTimeWindow["granularity"] | null;
  readonly sourceScope: MemoryQueryPlanSourceScope;
  readonly taskScope: MemoryQueryPlanTaskScope;
  readonly sourceAuditTarget: MemoryQueryPlanSourceAuditTarget | null;
  readonly exclusions: readonly string[];
  readonly requiresSynthesis: boolean;
  readonly recallChannels: readonly ("typed_read_model" | "source_topic_report" | "relationship_graph" | "temporal_event" | "task_projection" | "lexical" | "vector")[];
  readonly rerankDecision: "not_needed" | "metadata_first" | "after_filter" | "blocked";
  readonly filterTrace: readonly MemoryQueryPlanFilterTraceEntry[];
  readonly finalSelectionReason: string;
  readonly selectedCorpusCapability: CorpusCapability;
  readonly routeArbitrationDecision: "enforce_trusted_reader" | "allow_standard_routes" | "abstain_if_unsupported";
  readonly routeArbitrationReason: string;
  readonly blockedEarlyRoutes: readonly string[];
  readonly selectedReader: string | null;
  readonly plannerEnforced: boolean;
}

const SELF_NAME = "Steve Tietze";
const QUESTION_WORDS = new Set([
  "What",
  "When",
  "Where",
  "Why",
  "Who",
  "How",
  "Which",
  "Did",
  "Does",
  "Do",
  "Is",
  "Are",
  "Was",
  "Were",
  "Can",
  "Could",
  "Would",
  "Should",
  "Tell",
  "Give",
  "List",
  "Show",
  "Separate",
  "Break",
  "Summarize",
  "Recap",
  "Overview",
  "Explain",
  "Define",
  "I"
]);

const KNOWN_PROJECTS = [
  "Two Way",
  "Two-Way",
  "Well Inked",
  ...knownCodexProjectLabels(),
  "OpenClaw",
  "ComfyUI",
  "KIE API",
  "Preset Kitchen",
  "Bumblebee",
  "Query Contract",
  "Hybrid Temporal Memory Retrieval",
  "Temporal Memory",
  "MemoryQueryPlan"
];

const MONTHS: Readonly<Record<string, number>> = {
  january: 1,
  february: 2,
  march: 3,
  april: 4,
  may: 5,
  june: 6,
  july: 7,
  august: 8,
  september: 9,
  october: 10,
  november: 11,
  december: 12
};

const MONTH_NAME_PATTERN = "january|february|march|april|may|june|july|august|september|october|november|december";

interface MemoryQueryPlanOptions {
  readonly referenceNow?: string;
}

function uniqueStrings(values: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    const normalized = normalizeWhitespace(value);
    const key = normalized.toLowerCase();
    if (!normalized || seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push(normalized);
  }
  return output;
}

function titleName(value: string): string {
  return normalizeWhitespace(value)
    .split(/\s+/u)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function extractCapitalizedEntities(queryText: string): readonly string[] {
  const matches = queryText.match(/\b[A-Z][A-Za-z.'-]*(?:\s+[A-Z][A-Za-z.'-]*){0,3}\b/gu) ?? [];
  return uniqueStrings(
    matches
      .map((value) => value.replace(/['’]s$/u, ""))
      .filter((value) => !QUESTION_WORDS.has(value))
      .filter((value) => !/^(?:OMI|MCP|LM|RAG)$/u.test(value))
  );
}

function isSelfReference(queryText: string): boolean {
  return /\b(?:my|mine|me|i|myself|steve(?:\s+tietze)?)\b/iu.test(queryText);
}

function extractPeople(queryText: string, places: readonly string[], projects: readonly string[]): readonly string[] {
  const placeKeys = new Set(places.map((place) => place.toLowerCase()));
  const projectKeys = new Set(projects.map((project) => project.toLowerCase()));
  const entities = extractCapitalizedEntities(queryText).filter((entity) => {
    const key = entity.toLowerCase();
    if (placeKeys.has(key) || projectKeys.has(key)) return false;
    if (/^(?:July|September|Summer|Winter|Spring|Fall|Burning Man|OMI|MCP|Query Contract)$/iu.test(entity)) return false;
    return true;
  });
  return uniqueStrings([...(isSelfReference(queryText) ? [SELF_NAME] : []), ...entities.map(titleName)]);
}

function extractProjects(queryText: string): readonly string[] {
  const normalized = normalizeWhitespace(queryText).toLowerCase();
  const projects = KNOWN_PROJECTS.filter((project) => normalized.includes(project.toLowerCase()));
  const codexProject = codexProjectLabelFromText(queryText);
  if (codexProject) projects.push(codexProject);
  if (/\b(?:patterns?|mistakes?|instructions?|standards?|task\s+lists?|changelogs?|docs?|prior\s+work|what\s+did\s+we\s+do|last\s+time|sessions?|agent|codex|workflow|skill\s+candidates?|token\s+waste)\b/iu.test(queryText)) {
    for (const match of normalized.matchAll(/\b(?:for|on|in|about)\s+(?:the\s+)?([a-z0-9][a-z0-9-]*(?:\s+[a-z0-9][a-z0-9-]*){0,3})(?=\s+(?:project|repo|app|work|sessions?|that|from|last|this|where|when|what|which|who|$)|[?.!,]|$)/giu)) {
      const phrase = normalizeWhitespace(match[1] ?? "")
        .replace(/^(?:my|our)\s+/iu, "")
        .replace(/\s+(?:work|project|repo|app|sessions?)$/iu, "");
      if (!phrase || /^(?:last\s+week|this\s+week|my\s+codex|codex\s+sessions?|the\s+project|the\s+repo|the\s+app)$/iu.test(phrase)) continue;
      if (projects.some((project) => phrase.includes(project.toLowerCase()) || project.toLowerCase().includes(phrase))) continue;
      projects.push(canonicalCodexProjectLabel(phrase));
    }
  }
  if (/\bquery\s+contract\b/iu.test(queryText)) {
    projects.push("Query Contract");
  }
  return uniqueStrings(projects);
}

function detectSourceScope(queryText: string): MemoryQueryPlanSourceScope {
  if (/\b(?:most\s+recent|latest|last)\s+(?:omi\s+)?note\b/iu.test(queryText)) return "latest_omi_note";
  if (/\brecent\b[\s\S]{0,80}\bnotes?\b/iu.test(queryText)) return "recent_notes";
  if (isSourceAuditQuery(queryText)) return "source_audit_target";
  return "none";
}

function detectTaskScope(queryText: string): MemoryQueryPlanTaskScope {
  if (!/\b(?:task|tasks|todo|to[- ]?do|action\s+items?|need\s+to\s+do|should\s+i\s+do|open|blocked|done|completed)\b/iu.test(queryText)) {
    return "none";
  }
  if (/\b(?:most\s+recent|latest|last)\s+(?:omi\s+)?note\b/iu.test(queryText)) return "latest_source";
  if (/\b(?:travel|trip|trips|planning|flight|hotel|july|september|summer|istanbul|thailand)\b/iu.test(queryText)) return "travel";
  if (/\b(?:open|still|active|remaining)\b/iu.test(queryText)) return "active";
  return "all";
}

function isProjectScopedTaskQuery(queryText: string, projects: readonly string[]): boolean {
  if (!/\b(?:task|tasks|todo|to[- ]?do|action\s+items?|need\s+to\s+do|should\s+i\s+do|open|remaining)\b/iu.test(queryText)) {
    return false;
  }
  const scopedProjects = projects.filter((project) => !/^query\s+contract$/iu.test(project));
  return scopedProjects.length > 0 || /\b(?:hybrid\s+temporal\s+memory\s+retrieval|query\s+plan|source\s+audit|mcp\s+gold|temporal\s+truth|memoryqueryplan)\b/iu.test(queryText);
}

function isCodexProjectDetailQuery(queryText: string, projects: readonly string[]): boolean {
  if (projects.length === 0) return false;
  return /\b(?:architecture|target\s+design|implementation\s+plan|standalone\s+implementation|design\s+decision|decid(?:e|ed)|decisions?|what\s+broke|went\s+wrong|how\s+was\s+it\s+fixed|fixed|proof|prove|proved|proving|verified|verification|tests?|gates?|risks?|follow[- ]?ups?|workspace\s+confusion|repo\s+confusion|wrong\s+repo|what\s+changed|changed\s+between|before\s+and\s+after|source\s+support|sources?\s+for|establish(?:ed|es|ing)?|discuss(?:ed|es|ing)?|what\s+happened)\b/iu.test(queryText);
}

function isCareerHistoryIntentQuery(queryText: string, projects: readonly string[]): boolean {
  const selfReferenced = isSelfReference(queryText);
  const nonCareerCommuteCue = /\b(?:commute|travel\s+time|each\s+way)\b/iu.test(queryText) &&
    !/\b(?:career|work\s+history|employment\s+history|roles?\s+and\s+dates|employers?|companies\s+(?:have\s+i\s+)?worked)\b/iu.test(queryText);
  if (nonCareerCommuteCue) {
    return false;
  }
  const personalCareerProjectReferenced = projects.some((project) => /\b(?:two[- ]way|well\s+inked|ai\s+brain)\b/iu.test(project));
  const knownHistoricalCareerAnchor = /\bid\s+software\b|\bjohn\s+carmack\b/iu.test(queryText);
  const workHistoryCue = /\b(?:work\s+history|career\s+history|employment|employers?|companies\s+(?:have\s+i\s+)?worked\s+(?:for|at)|roles?\s+and\s+dates)\b/iu.test(
    queryText
  );
  const firstPersonWorkCue = /\b(?:did\s+i\s+do|have\s+i\s+done|i\s+worked|worked\s+(?:with|at|for)|my\s+(?:career|work|roles?|employers?))\b/iu.test(
    queryText
  );
  const firstPersonRoleCue = /\b(?:what\s+)?roles?\s+have\s+i\s+had\b/iu.test(queryText);
  const activeBuildVsWorkCue = /\bwhat\s+am\s+i\s+actively\s+building\s+now\b[\s\S]{0,100}\b(?:where\s+do\s+i\s+work|where\s+i\s+work|work)\b/iu.test(queryText);
  const relativeDailyRecapCue =
    /\bwhat\s+did\s+(?:i|we|you|.+?)\s+(?:do|talk(?:\s+about)?|discuss)\s+(?:today|yesterday|tonight|this\s+morning|last\s+week)\b/iu.test(
      queryText
    ) ||
    /\bwhat\s+happened\s+(?:today|yesterday|tonight|this\s+morning|last\s+week)\b/iu.test(queryText);
  const publicCareerSportsCue = /\bcareer[- ]high\b|\bbasketball\s+career\b|\bcareer\b[\s\S]{0,80}\bbasketball\b/iu.test(queryText);

  if (publicCareerSportsCue && !selfReferenced) {
    return false;
  }

  if (relativeDailyRecapCue && !knownHistoricalCareerAnchor && !workHistoryCue) {
    return false;
  }

  if (knownHistoricalCareerAnchor) {
    return selfReferenced || firstPersonWorkCue;
  }

  if (activeBuildVsWorkCue) {
    return true;
  }

  if (workHistoryCue || firstPersonRoleCue) {
    return selfReferenced || personalCareerProjectReferenced || !/\b[A-Z][a-z]+['’]s\b/u.test(queryText);
  }

  if (firstPersonWorkCue) {
    return selfReferenced || personalCareerProjectReferenced;
  }

  return false;
}

function inferredReferenceYear(referenceNow?: string): number {
  const parsed = referenceNow ? new Date(referenceNow) : new Date();
  if (Number.isFinite(parsed.getTime())) {
    return parsed.getUTCFullYear();
  }
  return new Date().getUTCFullYear();
}

function daysInMonth(year: number, monthNumber: number): number {
  return new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
}

function monthRange(year: number, monthName: string, modifier?: string | null): { readonly start: string; readonly end: string } {
  const monthNumber = MONTHS[monthName.toLowerCase()] ?? 1;
  const finalDay = daysInMonth(year, monthNumber);
  const normalizedModifier = normalizeWhitespace(modifier ?? "").toLowerCase();
  let startDay = 1;
  let endDay = finalDay;
  if (normalizedModifier === "early") {
    endDay = Math.min(10, finalDay);
  } else if (normalizedModifier === "mid") {
    startDay = Math.min(11, finalDay);
    endDay = Math.min(20, finalDay);
  } else if (normalizedModifier === "late") {
    startDay = Math.min(21, finalDay);
  } else if (normalizedModifier === "mid to late") {
    startDay = Math.min(11, finalDay);
  }
  const month = String(monthNumber).padStart(2, "0");
  return {
    start: `${year}-${month}-${String(startDay).padStart(2, "0")}`,
    end: `${year}-${month}-${String(endDay).padStart(2, "0")}`
  };
}

function detectTimeWindow(queryText: string, options: MemoryQueryPlanOptions = {}): MemoryQueryPlanTimeWindow | null {
  const normalized = normalizeWhitespace(queryText);
  if (/\bchanged?\b|\bwhat\s+changed\b/iu.test(normalized)) {
    return { rawText: "change", start: null, end: null, granularity: "unknown", relation: "change" };
  }
  const monthYear = normalized.match(
    new RegExp(`\\b(early|mid|late|mid\\s+to\\s+late)?\\s*(${MONTH_NAME_PATTERN})\\s+(20\\d{2}|19\\d{2})\\b`, "iu")
  );
  if (monthYear) {
    const modifier = monthYear[1] ? normalizeWhitespace(monthYear[1]) : null;
    const monthName = String(monthYear[2]);
    const year = Number(monthYear[3]);
    const range = monthRange(year, monthName, modifier);
    return {
      rawText: normalizeWhitespace(monthYear[0]),
      start: range.start,
      end: range.end,
      granularity: "month",
      relation: "explicit"
    };
  }
  const year = normalized.match(/\b(20\d{2}|19\d{2})\b/u)?.[1] ?? null;
  if (year) {
    return { rawText: year, start: `${year}-01-01`, end: `${year}-12-31`, granularity: "year", relation: "explicit" };
  }
  if (/\blast\s+week\b/iu.test(normalized)) {
    return { rawText: "last week", start: null, end: null, granularity: "unknown", relation: "relative" };
  }
  if (/\bthis\s+week\b/iu.test(normalized)) {
    return { rawText: "this week", start: null, end: null, granularity: "unknown", relation: "relative" };
  }
  const relativeMonth = normalized.match(new RegExp(`\\b(this|next|upcoming)\\s+(${MONTH_NAME_PATTERN})\\b`, "iu"));
  if (relativeMonth) {
    const year = inferredReferenceYear(options.referenceNow);
    const monthName = String(relativeMonth[2]);
    const range = monthRange(year, monthName);
    return { rawText: normalizeWhitespace(relativeMonth[0]), start: range.start, end: range.end, granularity: "month", relation: "relative" };
  }
  const month = normalized.match(new RegExp(`\\b(early|mid|late|mid\\s+to\\s+late)?\\s*(${MONTH_NAME_PATTERN})\\b`, "iu"));
  if (month) {
    const modifier = month[1] ? normalizeWhitespace(month[1]) : null;
    if (modifier) {
      const year = inferredReferenceYear(options.referenceNow);
      const monthName = String(month[2]);
      const range = monthRange(year, monthName, modifier);
      return { rawText: normalizeWhitespace(month[0]), start: range.start, end: range.end, granularity: "month", relation: "relative" };
    }
    return { rawText: normalizeWhitespace(month[0]), start: null, end: null, granularity: "month", relation: "explicit" };
  }
  const season = normalized.match(/\b(?:this|next|late|early|mid)?\s*(summer|winter|spring|fall|autumn)\b/iu);
  if (season) {
    return { rawText: normalizeWhitespace(season[0]), start: null, end: null, granularity: "season", relation: "relative" };
  }
  return null;
}

function temporalClarificationCandidate(params: {
  readonly queryText: string;
  readonly timeWindow: MemoryQueryPlanTimeWindow | null;
  readonly intent: MemoryQueryPlanIntent;
  readonly referenceNow?: string;
}): {
  readonly required: boolean;
  readonly reason: string | null;
  readonly candidateWindows: readonly MemoryQueryPlanTemporalCandidateWindow[];
  readonly selectedAssumption: string | null;
} {
  const { queryText, timeWindow, intent, referenceNow } = params;
  if (!timeWindow || timeWindow.granularity !== "month" || timeWindow.relation !== "explicit" || timeWindow.start || timeWindow.end) {
    return {
      required: false,
      reason: null,
      candidateWindows: [],
      selectedAssumption:
        timeWindow?.granularity === "month" && timeWindow?.relation === "relative"
          ? "relative_or_fuzzy_month_resolved_against_reference_now"
          : null
    };
  }
  const relevantIntent = new Set<MemoryQueryPlanIntent>(["task_list", "project_task_scope", "temporal_event", "temporal_change"]);
  if (!relevantIntent.has(intent)) {
    return { required: false, reason: null, candidateWindows: [], selectedAssumption: null };
  }
  if (intent === "temporal_change" || /\b(?:changed?|compare|difference|before\s+and\s+after)\b/iu.test(queryText)) {
    return { required: false, reason: null, candidateWindows: [], selectedAssumption: "change_query_decomposes_month_mentions_without_scalar_month_assumption" };
  }
  if (/\b(?:all|every|any)\s+(?:january|february|march|april|may|june|july|august|september|october|november|december)\b/iu.test(queryText)) {
    return { required: false, reason: null, candidateWindows: [], selectedAssumption: "all_month_mentions_requested_explicitly" };
  }
  const monthName = normalizeWhitespace(timeWindow.rawText ?? "");
  const year = inferredReferenceYear(referenceNow);
  const range = monthRange(year, monthName);
  return {
    required: true,
    reason: "month_without_year_or_modifier",
    candidateWindows: [
      { label: `${titleName(monthName)} ${year}`, start: range.start, end: range.end, granularity: "month" },
      { label: `another ${titleName(monthName)}`, start: null, end: null, granularity: "month" },
      { label: `all ${titleName(monthName)} mentions`, start: null, end: null, granularity: "month" }
    ],
    selectedAssumption: null
  };
}

function isSourceAuditQuery(queryText: string): boolean {
  return (
    /\b(?:where\s+did\s+(?:that|the)?(?:\s+answer)?\s*come\s+from|come\s+from|came\s+from|provenance|show\s+(?:me\s+)?(?:the\s+)?sources?|list\s+(?:the\s+)?sources?|source\s+trail|evidence\s+for|audit\s+that\s+answer)\b/iu.test(queryText) ||
    /\b(?:sources|evidence)\b[\s\S]{0,60}\b(?:answer|claim|section|where|came|from)\b/iu.test(queryText)
  );
}

function detectSourceAuditTarget(queryText: string, people: readonly string[], places: readonly string[], projects: readonly string[]): MemoryQueryPlanSourceAuditTarget | null {
  if (!isSourceAuditQuery(queryText)) {
    return null;
  }
  let family: MemoryQueryPlanSourceAuditTarget["family"] = "unknown";
  if (/\bfriends?\b|\b(?:gummi|gumi|tim|ben|dan)\b/iu.test(queryText)) family = "friend_set";
  else if (/\b(?:task|tasks|action\s+items?)\b/iu.test(queryText)) family = "task_list";
  else if (/\b(?:trip|travel|july|september|summer|calendar|commitment)\b/iu.test(queryText)) family = "temporal_event";
  else if (/\b(?:work\s+history|roles?|employers?|career|two[- ]way|well\s+inked)\b/iu.test(queryText)) family = "career";
  else if (projects.length > 0) family = "source_topic";
  return { family, names: people, places, projects };
}

function detectIntent(params: {
  readonly queryText: string;
  readonly contractName: QueryContractNameForRegistry;
  readonly people: readonly string[];
  readonly places: readonly string[];
  readonly projects: readonly string[];
  readonly sourceAuditTarget: MemoryQueryPlanSourceAuditTarget | null;
}): MemoryQueryPlanIntent {
  const { queryText, contractName, people, places, projects, sourceAuditTarget } = params;
  if (
    /\b(?:codex|agent\s+session|coding\s+session)\b/iu.test(queryText) &&
    /\b(?:tasks?|todo|to[- ]?do|action\s+items?|need\s+to\s+do|should\s+i\s+do|open|remaining)\b/iu.test(queryText)
  ) {
    return "task_list";
  }
  if (isCodexProjectDetailQuery(queryText, projects)) return "codex_project_detail_report";
  if (
    projects.length > 0 &&
    /\b(?:patterns?|mistakes?|instructions?|standards?|task\s+lists?|changelogs?|docs?|prior\s+work|what\s+did\s+we\s+do|last\s+time|sessions?|agent|workflow|skill\s+candidates?|token\s+waste|commonly\s+came\s+up)\b/iu.test(queryText)
  ) {
    if (/\b(?:where\s+did|source|sources|evidence|come\s+from|provenance)\b/iu.test(queryText)) return "codex_source_audit";
    if (/\b(?:agent\s+memory\s+packet|memory\s+packet|future\s+agents?\s+preload|preload\s+before\s+working)\b/iu.test(queryText)) return "engineering_memory_packet";
    return "workflow_pattern_report";
  }
  if (/\b(?:codex|agent\s+memory|memory\s+packet|last\s+time\s+on\s+this\s+repo|stack\s+and\s+standards|standards\s+usually\s+apply|standards\s+should\s+i\s+follow[\s\S]{0,60}\brepo|before\s+editing\s+this\s+repo|future\s+agents?\s+(?:follow|preload)|mistakes\s+should\s+codex|skill\s+candidates?|skills?\s+should|create\s+.*skills?|docs\s+drift|repeated\s+instructions?|promoted\s+truth|candidate\s+memories|memories\s+are\s+candidates|token\s+waste|workflow\s+patterns?|architecture\s+decisions?\s+did\s+we\s+make|decisions?\s+did\s+we\s+make|operator\s+workbench)\b/iu.test(queryText)) {
    if (/\b(?:where\s+did|source|sources|evidence|come\s+from|provenance)\b/iu.test(queryText)) return "codex_source_audit";
    if (/\b(?:agent\s+memory\s+packet|memory\s+packet|generate\s+.*packet|future\s+agents?\s+preload|preload\s+before\s+working)\b/iu.test(queryText)) return "engineering_memory_packet";
    if (/\b(?:mistakes?|avoid|repeated\s+instructions?|skill\s+candidates?|skills?\s+should|create\s+.*skills?|docs\s+drift|pattern|patterns|token\s+waste)\b/iu.test(queryText)) return "workflow_pattern_report";
    return "codex_session_report";
  }
  if (sourceAuditTarget) return "source_audit";
  if (
    /\b(?:silent(?:ly)?\s+merge|merge\s+them|correction|alias|spelling|omi\s+gummi|gummi)\b/iu.test(queryText) &&
    /\b(?:should|policy|multiple|candidate|merge|separate|audit)\b/iu.test(queryText)
  ) {
    return "document_spec";
  }
  if (
    /\b(?:private\s+source|source\s+privacy|raw\s+source|blocked|redact|retention|audit\s+trail|deleted|delete)\b/iu.test(queryText) &&
    /\b(?:should|policy|retained|retain|deleted|delete|audit|blocked)\b/iu.test(queryText)
  ) {
    return "document_spec";
  }
  if (/\bhow\s+do\s+i\s+run\b|\b(?:command|benchmark|npm\s+run|script|cli)\b/iu.test(queryText)) return "procedure_command";
  if (
    /\b(?:current\s+)?(?:spec|plan|checkpoint|task\s+list|changelog|implementation\s+plan|engineering\s+plan)\b/iu.test(queryText) &&
    /\b(?:hybrid\s+temporal\s+memory\s+retrieval|query\s+plan\s+enforcement|source\s+audit|temporal\s+truth|fidelity\s+lockdown|universal\s+source\s+audit|phase\s+\d+|latency|product-proof|repo\s+doc|procedure)\b/iu.test(queryText)
  ) {
    return /\b(?:run|command|benchmark|npm\s+run)\b/iu.test(queryText) ? "procedure_command" : "document_spec";
  }
  if (
    /\b(?:ingestion|tagging|extraction|source\s+kind|source\s+type|quality\s+issues?|quality\s+ledger|failed\s+to\s+produce|missing\s+(?:task\s+)?projections?|temporal\s+windows?|fix\s+next\s+in\s+ingestion\s+quality)\b/iu.test(queryText) ||
    /\b(?:parser[_\s-]?chunking[_\s-]?quality[_\s-]?defect|parent[_\s-]?child[_\s-]?context[_\s-]?missing|temporal[_\s-]?validity[_\s-]?conflict|task[_\s-]?projection[_\s-]?missing|event[_\s-]?projection[_\s-]?missing)\b/iu.test(queryText)
  ) {
    return "document_lookup";
  }
  if (
    /\b(?:pdfs?|documents?|docs?|papers?|specs?)\b[\s\S]{0,120}\b(?:saved?|mention|mentions|contain|say|retrieval\s+planning|chunking|source\s+envelope)\b/iu.test(queryText) ||
    /\b(?:what|which)\b[\s\S]{0,80}\b(?:pdfs?|documents?|docs?|papers?|specs?)\b/iu.test(queryText)
  ) {
    return "document_lookup";
  }
  if (isCareerHistoryIntentQuery(queryText, projects)) return "career_history";
  if (/\bwhat\s+changed\b|\bchanged?\b[\s\S]{0,80}\b(?:plans?|trip|travel|july|september)\b/iu.test(queryText)) return "temporal_change";
  if (
    /\b(?:after|before)\b/iu.test(queryText) &&
    /\b(?:planning|plans?|trip|travel|burning\s+man|leave|land|arriv(?:e|ed|ing)|commitments?)\b/iu.test(queryText)
  ) {
    return "temporal_event";
  }
  if (/\bfriends?\b|\bintroduc(?:e|ed|tion)\b/iu.test(queryText) && (contractName === "shared_social_graph" || places.length > 0 || people.length > 1)) return "relationship_friend_set";
  if (isProjectScopedTaskQuery(queryText, projects)) return "project_task_scope";
  if (/\b(?:task|tasks|todo|action\s+items?|need\s+to\s+do|should\s+i\s+do)\b/iu.test(queryText)) return "task_list";
  if (
    projects.length > 0 &&
    /\b(?:what\s+work|work\s+am\s+i\s+doing|my\s+role|doing\s+there|working\s+on)\b/iu.test(queryText)
  ) {
    return "multi_entity_work_context";
  }
  if (
    projects.length > 0 &&
    /\b(?:what\s+have\s+i\s+said|what\s+did\s+i\s+say|summarize|summary|recap|breakdown|mentioned|talked\s+about|discussed)\b/iu.test(queryText) &&
    /\b(?:about|recently|lately|notes?|sources?)\b/iu.test(queryText)
  ) {
    return "source_topic_report";
  }
  if (people.length + places.length + projects.length >= 3 && /\bwhat\s+do\s+i\s+know\b|\btell\s+me\b|\bsummarize\b/iu.test(queryText)) return "multi_entity_synthesis";
  if (/\b(?:trip|travel|when|date|july|september|summer)\b/iu.test(queryText)) return "temporal_event";
  if (contractName === "relationship_map" || contractName === "relationship_chronology") return "relationship_map";
  if (contractName === "project_definition" || contractName === "profile_report") return "source_topic_report";
  if (contractName === "direct_fact" || contractName === "current_state") return "direct_fact";
  return "unknown";
}

function recallChannelsForIntent(intent: MemoryQueryPlanIntent): MemoryQueryPlan["recallChannels"] {
  switch (intent) {
    case "relationship_friend_set":
      return ["relationship_graph", "lexical", "vector"];
    case "source_audit":
      return ["source_topic_report", "relationship_graph", "temporal_event", "task_projection", "lexical", "vector"];
    case "task_list":
    case "project_task_scope":
      return ["task_projection", "typed_read_model", "lexical"];
    case "temporal_change":
    case "temporal_event":
      return ["temporal_event", "typed_read_model", "lexical", "vector"];
    case "multi_entity_synthesis":
    case "multi_entity_work_context":
      return ["source_topic_report", "relationship_graph", "temporal_event", "task_projection", "lexical", "vector"];
    case "document_spec":
    case "document_lookup":
    case "procedure_command":
    case "repo_doc_lookup":
    case "codex_session_report":
    case "engineering_memory_packet":
    case "workflow_pattern_report":
    case "codex_source_audit":
    case "codex_project_detail_report":
      return ["lexical"];
    case "career_history":
      return ["typed_read_model", "source_topic_report", "lexical", "vector"];
    default:
      return ["typed_read_model", "lexical", "vector"];
  }
}

export function corpusCapabilityForIntent(intent: MemoryQueryPlanIntent): CorpusCapability {
  switch (intent) {
    case "relationship_friend_set":
    case "relationship_map":
      return "relationship_graph";
    case "source_audit":
      return "source_topic_report";
    case "project_task_scope":
    case "task_list":
      return "task_items";
    case "temporal_change":
    case "temporal_event":
      return "temporal_events";
    case "multi_entity_synthesis":
    case "multi_entity_work_context":
    case "source_topic_report":
      return "source_topic_report";
    case "career_history":
    case "work_history":
      return "career_projection";
    case "document_spec":
    case "repo_doc_lookup":
      return "repo_docs";
    case "document_lookup":
      return "source_topic_report";
    case "procedure_command":
      return "package_scripts";
    case "codex_session_report":
    case "engineering_memory_packet":
    case "workflow_pattern_report":
    case "codex_source_audit":
    case "codex_project_detail_report":
      return "codex_sessions";
    case "corpus_unsupported":
      return "unknown";
    default:
      return "omi_personal_note";
  }
}

function selectedReaderForIntent(intent: MemoryQueryPlanIntent): string | null {
  switch (intent) {
    case "career_history":
      return "career_history_trusted_reader";
    case "document_spec":
    case "repo_doc_lookup":
      return "repo_doc_trusted_reader";
    case "procedure_command":
      return "package_script_trusted_reader";
    case "project_task_scope":
      return "project_scoped_task_reader";
    case "multi_entity_work_context":
      return "multi_lane_project_work_reader";
    case "source_topic_report":
      return "source_topic_report_reader";
    case "codex_session_report":
    case "engineering_memory_packet":
    case "workflow_pattern_report":
    case "codex_source_audit":
    case "codex_project_detail_report":
      return "codex_memory_reader";
    default:
      return null;
  }
}

function blockedEarlyRoutesForIntent(intent: MemoryQueryPlanIntent): readonly string[] {
  switch (intent) {
    case "career_history":
    case "document_spec":
    case "procedure_command":
    case "repo_doc_lookup":
    case "project_task_scope":
    case "multi_entity_work_context":
    case "source_topic_report":
    case "codex_session_report":
    case "engineering_memory_packet":
    case "workflow_pattern_report":
    case "codex_source_audit":
    case "codex_project_detail_report":
      return ["warm_start", "alias_current_state_projection", "recap_profile_projection", "continuity_current_state_projection", "generic_fallback"];
    default:
      return [];
  }
}

export function buildMemoryQueryPlan(queryText: string, queryContract?: QueryContract | null, options: MemoryQueryPlanOptions = {}): MemoryQueryPlan {
  const contractName = (queryContract?.contractName ?? "direct_fact") as QueryContractNameForRegistry;
  const answerShape = (queryContract?.answerShape ?? "scalar") as RegistryAnswerShape;
  const projects = extractProjects(queryText);
  const places = extractPlaceScopes(queryText);
  const people = extractPeople(queryText, places, projects);
  const sourceScope = detectSourceScope(queryText);
  const taskScope = detectTaskScope(queryText);
  const timeWindow = detectTimeWindow(queryText, options);
  const sourceAuditTarget = detectSourceAuditTarget(queryText, people, places, projects);
  const intent = detectIntent({ queryText, contractName, people, places, projects, sourceAuditTarget });
  const temporalClarification = temporalClarificationCandidate({ queryText, timeWindow, intent, referenceNow: options.referenceNow });
  const selectedCorpusCapability = corpusCapabilityForIntent(intent);
  const selectedReader = selectedReaderForIntent(intent);
  const blockedEarlyRoutes = blockedEarlyRoutesForIntent(intent);
  const plannerEnforced = selectedReader !== null;
  const effectiveContractName: QueryContractNameForRegistry =
    intent === "task_list" || intent === "project_task_scope"
      ? "task_list"
      : intent === "codex_session_report"
        ? "codex_session_report"
      : intent === "engineering_memory_packet"
        ? "engineering_memory_packet"
      : intent === "workflow_pattern_report"
        ? "workflow_pattern_report"
      : intent === "codex_source_audit"
        ? "codex_source_audit"
      : intent === "codex_project_detail_report"
        ? "codex_session_report"
      : intent === "temporal_change" || intent === "temporal_event"
        ? "temporal_event"
        : intent === "career_history"
          ? "profile_report"
          : intent === "document_lookup"
            ? "document_lookup"
          : intent === "source_topic_report"
            ? "profile_report"
          : contractName;
  const effectiveAnswerShape: RegistryAnswerShape =
    intent === "task_list" || intent === "project_task_scope"
      ? "list"
      : intent === "codex_session_report" || intent === "engineering_memory_packet" || intent === "workflow_pattern_report" || intent === "codex_source_audit"
        || intent === "codex_project_detail_report"
        ? "report"
      : intent === "temporal_change" || intent === "temporal_event"
        ? "timeline"
        : intent === "document_lookup" || intent === "document_spec" || intent === "multi_entity_work_context" || intent === "career_history" || intent === "source_topic_report"
          ? "report"
          : answerShape;
  const retrievalDomain =
    intent === "source_audit"
      ? "source_audit"
      : intent === "task_list" || intent === "project_task_scope"
        ? "task_ops"
      : intent === "codex_session_report" || intent === "engineering_memory_packet" || intent === "workflow_pattern_report" || intent === "codex_source_audit" || intent === "codex_project_detail_report"
        ? "engineering_specs"
      : intent === "temporal_change"
          ? "temporal_history"
          : intent === "document_lookup"
            ? "document_knowledge"
          : intent === "multi_entity_synthesis" || intent === "multi_entity_work_context" || intent === "document_spec" || intent === "procedure_command"
            ? "personal_memory"
            : intent === "career_history"
              ? "personal_memory"
            : primaryRetrievalDomainForQueryContract(effectiveContractName);
  const filterTrace: MemoryQueryPlanFilterTraceEntry[] = [];
  for (const subject of people) filterTrace.push({ field: "subject", value: subject, reason: "deterministic_entity_role" });
  for (const place of places) filterTrace.push({ field: "place", value: place, reason: "place_alias_substrate" });
  for (const project of projects) filterTrace.push({ field: "project", value: project, reason: "known_project_alias" });
  if (sourceScope !== "none") filterTrace.push({ field: "sourceScope", value: sourceScope, reason: "source_scope_phrase" });
  if (taskScope !== "none") filterTrace.push({ field: "taskScope", value: taskScope, reason: "task_lifecycle_phrase" });
  if (timeWindow) filterTrace.push({ field: "timeWindow", value: timeWindow.rawText ?? timeWindow.relation, reason: "temporal_phrase" });
  if (temporalClarification.required) {
    filterTrace.push({ field: "timeWindow", value: timeWindow?.rawText ?? "ambiguous_month", reason: "temporal_clarification_required" });
  }
  const temporalConstraintSet: MemoryQueryPlanTemporalConstraint[] = [];
  if (timeWindow?.rawText) {
    temporalConstraintSet.push({ field: "time_text", value: timeWindow.rawText, source: "query_text" });
  }
  if (timeWindow?.start || timeWindow?.end) {
    temporalConstraintSet.push({ field: "time_window", value: `${timeWindow.start ?? "open"}..${timeWindow.end ?? "open"}`, source: "planner" });
  }
  if (timeWindow?.granularity) {
    temporalConstraintSet.push({ field: "time_granularity", value: timeWindow.granularity, source: "planner" });
  }
  if (timeWindow?.relation) {
    temporalConstraintSet.push({ field: "time_relation", value: timeWindow.relation, source: "planner" });
  }
  if (temporalClarification.required && temporalClarification.reason) {
    temporalConstraintSet.push({ field: "temporal_clarification", value: temporalClarification.reason, source: "planner" });
  }

  return {
    version: "memory_query_plan_v1",
    intent,
    retrievalDomain,
    queryContract: effectiveContractName,
    answerShape: effectiveAnswerShape,
    subjects: people,
    objects: [],
    places,
    projects,
    timeWindow,
    temporalClarificationRequired: temporalClarification.required,
    temporalAmbiguityReason: temporalClarification.reason,
    temporalCandidateWindows: temporalClarification.candidateWindows,
    selectedTemporalAssumption: temporalClarification.selectedAssumption,
    temporalDecomposition: {
      subjectTerms: people,
      objectTerms: [],
      placeTerms: places,
      projectTerms: projects,
      timeText: timeWindow?.rawText ?? null,
      intent,
      answerShape: effectiveAnswerShape
    },
    temporalConstraintSet,
    timeNodeGranularity: timeWindow?.granularity ?? null,
    sourceScope,
    taskScope,
    sourceAuditTarget,
    exclusions: /\bexclud(?:e|ing)\b/iu.test(queryText) ? ["older unrelated"] : [],
    requiresSynthesis: intent === "multi_entity_synthesis" || people.length + places.length + projects.length >= 3,
    recallChannels: recallChannelsForIntent(intent),
    rerankDecision: filterTrace.length > 0 ? "metadata_first" : "not_needed",
    filterTrace,
    finalSelectionReason: filterTrace.length > 0 ? "metadata filters must apply before vector-supported final selection" : "no structured constraints detected",
    selectedCorpusCapability,
    routeArbitrationDecision: plannerEnforced ? "enforce_trusted_reader" : "allow_standard_routes",
    routeArbitrationReason: plannerEnforced
      ? `${intent} requires ${selectedCorpusCapability} before warm-start/current-state/fallback`
      : temporalClarification.required
        ? "ambiguous temporal month requires clarification before retrieval"
      : "no trusted-reader intent selected",
    blockedEarlyRoutes,
    selectedReader,
    plannerEnforced
  };
}

export function memoryQueryPlanTelemetry(plan: MemoryQueryPlan): Partial<RecallResponse["meta"]> {
  return {
    memoryQueryPlanVersion: plan.version,
    memoryQueryPlanIntent: plan.intent,
    memoryQueryPlanRetrievalDomain: plan.retrievalDomain,
    memoryQueryPlanQueryContract: plan.queryContract,
    memoryQueryPlanAnswerShape: plan.answerShape,
    memoryQueryPlanSubjects: plan.subjects,
    memoryQueryPlanObjects: plan.objects,
    memoryQueryPlanPlaces: plan.places,
    memoryQueryPlanProjects: plan.projects,
    memoryQueryPlanTimeWindow: plan.timeWindow ? { ...plan.timeWindow } : null,
    temporalClarificationRequired: plan.temporalClarificationRequired,
    temporalAmbiguityReason: plan.temporalAmbiguityReason,
    temporalCandidateWindows: plan.temporalCandidateWindows.map((entry) => ({ ...entry })),
    selectedTemporalAssumption: plan.selectedTemporalAssumption,
    temporalDecomposition: { ...plan.temporalDecomposition },
    temporalConstraintSet: plan.temporalConstraintSet.map((entry) => ({ ...entry })),
    timeNodeGranularity: plan.timeNodeGranularity,
    memoryQueryPlanSourceScope: plan.sourceScope,
    memoryQueryPlanTaskScope: plan.taskScope,
    memoryQueryPlanSourceAuditTarget: plan.sourceAuditTarget ? { ...plan.sourceAuditTarget } : null,
    memoryQueryPlanRequiresSynthesis: plan.requiresSynthesis,
    recallChannels: plan.recallChannels,
    rerankDecision: plan.rerankDecision,
    filterTrace: plan.filterTrace.map((entry) => ({ ...entry })),
    finalSelectionReason: plan.finalSelectionReason,
    selectedCorpusCapability: plan.selectedCorpusCapability,
    routeArbitrationDecision: plan.routeArbitrationDecision,
    routeArbitrationReason: plan.routeArbitrationReason,
    blockedEarlyRoutes: plan.blockedEarlyRoutes,
    selectedReader: plan.selectedReader,
    plannerEnforced: plan.plannerEnforced
  };
}
