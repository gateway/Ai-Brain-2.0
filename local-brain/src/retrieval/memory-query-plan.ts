import {
  primaryRetrievalDomainForQueryContract,
  type QueryContractNameForRegistry,
  type RegistryAnswerShape,
  type RetrievalDomain
} from "../taxonomy/retrieval-domain-registry.js";
import { normalizeWhitespace } from "../identity/canonicalization.js";
import { extractPlaceScopes } from "./place-aliases.js";
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
  | "unknown";

export interface MemoryQueryPlanTimeWindow {
  readonly rawText: string | null;
  readonly start: string | null;
  readonly end: string | null;
  readonly granularity: "day" | "month" | "season" | "year" | "unknown";
  readonly relation: "explicit" | "relative" | "change" | "none";
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
  "AI Brain",
  "Preset Kitchen",
  "Bumblebee",
  "Query Contract",
  "Hybrid Temporal Memory Retrieval",
  "Temporal Memory",
  "MemoryQueryPlan"
];

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

function isCareerHistoryIntentQuery(queryText: string, projects: readonly string[]): boolean {
  const selfReferenced = isSelfReference(queryText);
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

function detectTimeWindow(queryText: string): MemoryQueryPlanTimeWindow | null {
  const normalized = normalizeWhitespace(queryText);
  if (/\bchanged?\b|\bwhat\s+changed\b/iu.test(normalized)) {
    return { rawText: "change", start: null, end: null, granularity: "unknown", relation: "change" };
  }
  const year = normalized.match(/\b(20\d{2}|19\d{2})\b/u)?.[1] ?? null;
  if (year) {
    return { rawText: year, start: `${year}-01-01`, end: `${year}-12-31`, granularity: "year", relation: "explicit" };
  }
  const month = normalized.match(/\b(early|mid|late|mid\s+to\s+late)?\s*(january|february|march|april|may|june|july|august|september|october|november|december)\b/iu);
  if (month) {
    return { rawText: normalizeWhitespace(month[0]), start: null, end: null, granularity: "month", relation: "explicit" };
  }
  const season = normalized.match(/\b(?:this|next|late|early|mid)?\s*(summer|winter|spring|fall|autumn)\b/iu);
  if (season) {
    return { rawText: normalizeWhitespace(season[0]), start: null, end: null, granularity: "season", relation: "relative" };
  }
  return null;
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
  if (sourceAuditTarget) return "source_audit";
  if (/\bhow\s+do\s+i\s+run\b|\b(?:command|benchmark|npm\s+run|script|cli)\b/iu.test(queryText)) return "procedure_command";
  if (
    /\b(?:current\s+)?(?:spec|plan|checkpoint|task\s+list|changelog|implementation\s+plan|engineering\s+plan)\b/iu.test(queryText) &&
    /\b(?:hybrid\s+temporal\s+memory\s+retrieval|query\s+plan\s+enforcement|source\s+audit|temporal\s+truth|fidelity\s+lockdown|universal\s+source\s+audit|phase\s+\d+|latency|product-proof|repo\s+doc|procedure)\b/iu.test(queryText)
  ) {
    return /\b(?:run|command|benchmark|npm\s+run)\b/iu.test(queryText) ? "procedure_command" : "document_spec";
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
      return ["warm_start", "alias_current_state_projection", "recap_profile_projection", "continuity_current_state_projection", "generic_fallback"];
    default:
      return [];
  }
}

export function buildMemoryQueryPlan(queryText: string, queryContract?: QueryContract | null): MemoryQueryPlan {
  const contractName = (queryContract?.contractName ?? "direct_fact") as QueryContractNameForRegistry;
  const answerShape = (queryContract?.answerShape ?? "scalar") as RegistryAnswerShape;
  const projects = extractProjects(queryText);
  const places = extractPlaceScopes(queryText);
  const people = extractPeople(queryText, places, projects);
  const sourceScope = detectSourceScope(queryText);
  const taskScope = detectTaskScope(queryText);
  const timeWindow = detectTimeWindow(queryText);
  const sourceAuditTarget = detectSourceAuditTarget(queryText, people, places, projects);
  const intent = detectIntent({ queryText, contractName, people, places, projects, sourceAuditTarget });
  const selectedCorpusCapability = corpusCapabilityForIntent(intent);
  const selectedReader = selectedReaderForIntent(intent);
  const blockedEarlyRoutes = blockedEarlyRoutesForIntent(intent);
  const plannerEnforced = selectedReader !== null;
  const effectiveContractName: QueryContractNameForRegistry =
    intent === "task_list" || intent === "project_task_scope"
      ? "task_list"
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
