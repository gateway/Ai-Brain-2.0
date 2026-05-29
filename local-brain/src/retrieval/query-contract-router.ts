import { performance } from "node:perf_hooks";
import { primaryRetrievalDomainForQueryContract, type RetrievalDomain } from "../taxonomy/retrieval-domain-registry.js";
import { canonicalPlaceName } from "./place-aliases.js";
import type { RecallResponse } from "./types.js";

export type QueryContractName =
  | "relationship_chronology"
  | "relationship_map"
  | "shared_social_graph"
  | "current_state"
  | "temporal_event"
  | "list_set"
  | "profile_report"
  | "project_definition"
  | "document_lookup"
  | "codex_session_report"
  | "engineering_memory_packet"
  | "workflow_pattern_report"
  | "codex_source_audit"
  | "task_list"
  | "procedure_lookup"
  | "source_audit"
  | "review_only"
  | "direct_fact"
  | "abstention";

export type QueryContractFamily =
  | "profile_report"
  | "current_state"
  | "project_definition"
  | "document_lookup"
  | "task_ops"
  | "procedural_memory"
  | "source_audit"
  | "temporal_detail"
  | "typed_list_set"
  | "exact_detail"
  | "generic";

export interface QueryContract {
  readonly contractName: QueryContractName;
  readonly contractFamily: QueryContractFamily;
  readonly retrievalDomain: RetrievalDomain;
  readonly answerShape: "scalar" | "list" | "reason" | "report" | "timeline" | "procedure" | "abstention";
  readonly subjectHints: readonly string[];
  readonly pairHints: readonly string[];
  readonly temporalHints: readonly string[];
  readonly targetProjection: string | null;
  readonly allowedReadModels: readonly string[];
  readonly blockedFallbacks: readonly string[];
  readonly confidence: number;
  readonly routingReasons: readonly string[];
  readonly latencyMs: number;
}

const SELF_NAMES = new Set(["me", "myself", "i", "steve", "steve tietze", "you"]);
const AMBIGUOUS_PRONOUNS = new Set(["them", "they", "someone", "somebody", "us", "we"]);
const SUBJECT_LEAD_STOP_WORDS = new Set([
  "the",
  "a",
  "an",
  "my",
  "our",
  "your",
  "his",
  "her",
  "their"
]);

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values.map((value) => normalizeWhitespace(value)).filter(Boolean))];
}

function titleName(value: string): string {
  return normalizeWhitespace(value)
    .split(/\s+/u)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function normalizeSelf(value: string): string {
  const normalized = normalizeWhitespace(value).toLowerCase();
  return SELF_NAMES.has(normalized) ? "Steve Tietze" : titleName(value);
}

function normalizeExplicitSubject(value: string): string {
  const normalized = normalizeWhitespace(value);
  return SELF_NAMES.has(normalized.toLowerCase()) ? "Steve Tietze" : normalized;
}

function extractCapitalizedNames(queryText: string): readonly string[] {
  const matches = queryText.match(/\b[A-Z][A-Za-z.'-]*(?:\s+[A-Z][A-Za-z.'-]*){0,2}\b/gu) ?? [];
  return unique(
    matches
      .map((name) => name.replace(/['’]s$/u, ""))
      .filter((name) => !/^(?:What|When|Where|Why|Who|How|Which|Did|Does|Do|Is|Are|Was|Were|Can|Could|Would|Should|Tell|Give|List|Show|Separate|Break|Summarize|Recap|Overview|Explain|Define|I|I['’]?ve|I['’]?m|I['’]?d|I['’]?ll)$/u.test(name))
  );
}

function looksEntityishToken(token: string, index: number, tokens: readonly string[]): boolean {
  if (/^[A-Z0-9][A-Za-z0-9.&'/-]*$/u.test(token)) {
    return true;
  }
  return /^[a-z]{1,4}$/u.test(token) && /^[A-Z0-9][A-Za-z0-9.&'/-]*$/u.test(tokens[index + 1] ?? "");
}

function looksEntityishPhrase(value: string): boolean {
  const tokens = normalizeWhitespace(value)
    .split(/\s+/u)
    .filter(Boolean);
  if (tokens.length === 0 || tokens.length > 5) {
    return false;
  }
  return tokens.some((token, index) => looksEntityishToken(token, index, tokens));
}

function cleanExplicitSubjectPhrase(value: string): string | null {
  const tokens = normalizeWhitespace(value)
    .replace(/[?.!,;:]+$/u, "")
    .split(/\s+/u)
    .filter(Boolean);
  while (tokens.length > 0 && SUBJECT_LEAD_STOP_WORDS.has(tokens[0]!.toLowerCase())) {
    tokens.shift();
  }
  while (
    tokens.length > 0 &&
    /^(?:for|to|in|on|at|during|around|since|from|lately|recently|professionally|overall|now|today|yesterday)$/iu.test(tokens[tokens.length - 1] ?? "")
  ) {
    tokens.pop();
  }
  while (
    tokens.length >= 2 &&
    /^(?:for|to|with)$/iu.test(tokens[tokens.length - 2] ?? "") &&
    /^(?:me|myself|us|we|you)$/iu.test(tokens[tokens.length - 1] ?? "")
  ) {
    tokens.splice(tokens.length - 2, 2);
  }
  while (
    tokens.length >= 2 &&
    /^(?:in|around|during|about)$/iu.test(tokens[tokens.length - 2] ?? "") &&
    /^(?:my|our|your)$/iu.test(tokens[tokens.length - 1] ?? "")
  ) {
    tokens.splice(tokens.length - 2, 2);
  }
  const normalized = normalizeWhitespace(tokens.join(" "));
  if (!normalized || AMBIGUOUS_PRONOUNS.has(normalized.toLowerCase()) || !looksEntityishPhrase(normalized)) {
    return null;
  }
  return normalizeExplicitSubject(normalized);
}

function extractDelimitedSubjects(fragment: string): readonly string[] {
  const normalized = normalizeWhitespace(fragment);
  if (!normalized) {
    return [];
  }
  return unique(
    normalized
      .split(/\s+(?:and|or)\s+|,\s*/iu)
      .map((part) => cleanExplicitSubjectPhrase(part))
      .filter((value): value is string => Boolean(value))
  );
}

function extractExplicitWorkSubjects(queryText: string): readonly string[] {
  const withMatch = queryText.match(
    /\b(?:what\s+(?:things\s+)?did\s+i\s+do|what\s+work\s+did\s+i\s+do|what\s+did\s+i\s+(?:build|work\s+on|make|ship)|what(?:'s| is)\s+my\s+(?:history|story)|tell\s+me\s+about\s+my\s+(?:history|work))\s+with\s+(.+?)(?:\?|$)/iu
  );
  return extractDelimitedSubjects(withMatch?.[1] ?? "");
}

function extractExplicitAboutSubjects(queryText: string): readonly string[] {
  const aboutMatch =
    queryText.match(/\b(?:tell\s+me\s+everything\s+about|everything\s+about|summarize\s+what\s+you\s+know\s+about|what\s+do\s+we\s+know\s+about|what\s+does\s+(?:the\s+system|the\s+brain)\s+know\s+about|tell\s+me\s+about)\s+(.+?)(?:\?|$)/iu) ??
    queryText.match(/\bwhat\s+is\s+(.+?)(?:\?|$)/iu);
  return extractDelimitedSubjects(aboutMatch?.[1] ?? "");
}

function suppressShadowedNames(names: readonly string[], explicitSubjects: readonly string[]): readonly string[] {
  if (explicitSubjects.length === 0) {
    return names;
  }
  const explicitTokens = explicitSubjects.map((subject) => normalizeWhitespace(subject).toLowerCase().split(/\s+/u));
  return names.filter((name) => {
    const normalized = normalizeWhitespace(name).toLowerCase();
    const tokens = normalized.split(/\s+/u);
    if (tokens.length !== 1) {
      return true;
    }
    return !explicitTokens.some((subjectTokens) => subjectTokens.length > 1 && subjectTokens.includes(tokens[0] ?? ""));
  });
}

function extractBetweenPair(queryText: string): readonly string[] {
  const match = queryText.match(/\bbetween\s+([A-Za-z][A-Za-z.'-]*)\s+and\s+([A-Za-z][A-Za-z.'-]*)\b/u);
  if (!match) {
    return [];
  }
  if (AMBIGUOUS_PRONOUNS.has(String(match[1] ?? "").toLowerCase()) || AMBIGUOUS_PRONOUNS.has(String(match[2] ?? "").toLowerCase())) {
    return [];
  }
  return unique([normalizeSelf(match[1] ?? ""), normalizeSelf(match[2] ?? "")]);
}

function extractNamedSubject(queryText: string): string | null {
  const match =
    queryText.match(/\b([A-Z][A-Za-z.'-]*(?:\s+[A-Z][A-Za-z.'-]*){0,2})(?:'s)?\b/u) ??
    queryText.match(/\b([A-Za-z][A-Za-z.'-]*(?:\s+[A-Za-z][A-Za-z.'-]*){0,2})(?:'s)?\b/u);
  const candidate = normalizeWhitespace((match?.[1] ?? "").replace(/['’]s$/u, ""));
  if (!candidate) {
    return null;
  }
  if (AMBIGUOUS_PRONOUNS.has(candidate.toLowerCase())) {
    return null;
  }
  return normalizeSelf(candidate);
}

function extractSharedSocialPair(queryText: string, names: readonly string[]): readonly string[] {
  const normalized = normalizeWhitespace(queryText);
  const lower = normalized.toLowerCase();

  const betweenPair = extractBetweenPair(normalized);
  if (betweenPair.length === 2) {
    return betweenPair;
  }

  const selfAndNamedPatterns = [
    /\b(?:mine|my|me|i)\s+and\s+([A-Z][A-Za-z.'-]*(?:\s+[A-Z][A-Za-z.'-]*){0,2})(?:'s)?\b/u,
    /\b([A-Z][A-Za-z.'-]*(?:\s+[A-Z][A-Za-z.'-]*){0,2})(?:'s)?\s+and\s+(?:mine|my|me|i)\b/u,
    /\bme\s+and\s+([A-Z][A-Za-z.'-]*(?:\s+[A-Z][A-Za-z.'-]*){0,2})\b/u,
    /\b([A-Z][A-Za-z.'-]*(?:\s+[A-Z][A-Za-z.'-]*){0,2})\s+and\s+me\b/u,
    /\bi\s+and\s+([A-Z][A-Za-z.'-]*(?:\s+[A-Z][A-Za-z.'-]*){0,2})\b/u,
    /\b([A-Z][A-Za-z.'-]*(?:\s+[A-Z][A-Za-z.'-]*){0,2})\s+and\s+i\b/u
  ];
  for (const pattern of selfAndNamedPatterns) {
    const match = normalized.match(pattern);
    const candidate = extractNamedSubject(match?.[1] ?? "");
    if (candidate && !/^steve(?:\s+tietze)?$/iu.test(candidate)) {
      return unique(["Steve Tietze", candidate]);
    }
  }

  const namedPairMatch = normalized.match(
    /\b([A-Z][A-Za-z.'-]*(?:\s+[A-Z][A-Za-z.'-]*){0,2})(?:'s)?\s+and\s+([A-Z][A-Za-z.'-]*(?:\s+[A-Z][A-Za-z.'-]*){0,2})(?:'s)?\b/u
  );
  const left = extractNamedSubject(namedPairMatch?.[1] ?? "");
  const right = extractNamedSubject(namedPairMatch?.[2] ?? "");
  if (left && right && !AMBIGUOUS_PRONOUNS.has(left.toLowerCase()) && !AMBIGUOUS_PRONOUNS.has(right.toLowerCase())) {
    return unique([left, right]);
  }

  if (/\b(?:mine|my|me|i|our)\b/u.test(lower)) {
    const subject = nonSelfSubjects(names)[0];
    if (subject) {
      return unique(["Steve Tietze", subject]);
    }
  }

  return [];
}

function extractFriendSetPlaceScope(queryText: string): string | null {
  const normalized = normalizeWhitespace(queryText);
  if (!/\bfriends?\b/iu.test(normalized)) {
    return null;
  }
  const match = normalized.match(
    /\bfriends?\b[\s\S]{0,80}\b(?:in|from|around|near)\s+([A-Z][A-Za-z.'-]*(?:\s+[A-Z][A-Za-z.'-]*){0,3})\s*(?:\?|$|[,.;:]|\s+(?:that|who|where|with|and)\b)/u
  );
  const place = normalizeWhitespace((match?.[1] ?? "").replace(/[?.!,;:]+$/u, ""));
  if (!place || /^(?:me|my|mine|i|dan|lauren|ben|tim|gumi|gumee|gummi)$/iu.test(place)) {
    return null;
  }
  return canonicalPlaceName(place) ?? place;
}

function nonSelfSubjects(names: readonly string[]): readonly string[] {
  return unique(names.filter((name) => !SELF_NAMES.has(name.toLowerCase()) && !/^steve(?:\s+tietze)?$/iu.test(name)));
}

function temporalHints(queryText: string): readonly string[] {
  const hints: string[] = [];
  const normalized = queryText.toLowerCase();
  if (/\btoday\b/u.test(normalized)) hints.push("today");
  if (/\byesterday\b/u.test(normalized)) hints.push("yesterday");
  if (/\blast\s+(?:week|month|year|weekend)\b/u.test(normalized)) hints.push("relative_past");
  for (const match of queryText.matchAll(/\b(?:19|20)\d{2}\b/gu)) {
    hints.push(match[0]);
  }
  return unique(hints);
}

function extractProjectDefinitionSubject(queryText: string): string | null {
  const normalized = normalizeWhitespace(queryText);
  const direct = normalized.match(/^\s*what\s+is\s+(?:the\s+)?(.+?)(?:\?|$)/iu)?.[1] ?? "";
  const about =
    normalized.match(/^\s*(?:tell\s+me\s+about|tell\s+me\s+everything\s+about|define|explain)\s+(?:the\s+)?(.+?)(?:\?|$)/iu)?.[1] ?? "";
  const candidate = normalizeWhitespace(direct || about)
    .replace(/^(?:my|our)\s+/iu, "")
    .replace(/\s+(?:project|system|company|product|app)$/iu, "")
    .replace(/[?.!,;:]+$/u, "");
  if (!candidate || /\b(?:associated\s+with|relationship|to\s+me|in\s+my\s+life)\b/iu.test(normalized)) {
    return null;
  }
  const knownProjects = [
    "AI Brain",
    "Two Way",
    "2Way",
    "Well Inked",
    "Preset Kitchen",
    "Bumblebee",
    "OpenClaw",
    "Media Studio",
    "FixMyPhoto"
  ];
  const match = knownProjects.find((project) => normalizeWhitespace(project).toLowerCase() === candidate.toLowerCase());
  return match ?? null;
}

function extractUnknownDefinitionReviewSubject(queryText: string): string | null {
  const normalized = normalizeWhitespace(queryText);
  const direct = normalized.match(/^\s*what\s+is\s+(.+?)(?:\?|$)/iu)?.[1] ?? "";
  const about = normalized.match(/^\s*(?:tell\s+me\s+about|define|explain)\s+(.+?)(?:\?|$)/iu)?.[1] ?? "";
  const candidate = normalizeWhitespace(direct || about).replace(/[?.!,;:]+$/u, "");
  if (!candidate) {
    return null;
  }
  if (
    /\b(?:this|the)\s+(?:spec|plan|doc|document)\b/iu.test(candidate) ||
    /\b(?:history|relationship|friends?|to\s+me|in\s+my\s+life|tasks?|action\s+items?|query-time|memory\.search)\b/iu.test(candidate) ||
    /['’]s\b/u.test(candidate) ||
    /\b(?:me|my|our|your|you|i)\b/iu.test(candidate)
  ) {
    return null;
  }
  const tokens = candidate.split(/\s+/u).filter(Boolean);
  if (tokens.length === 0 || tokens.length > 4) {
    return null;
  }
  const looksLikeNamedThing = tokens.every((token) => /^[A-Z0-9][A-Za-z0-9._-]*$/u.test(token));
  return looksLikeNamedThing ? candidate : null;
}

function isBroadProfileSummaryQuery(queryText: string, subjects: readonly string[]): boolean {
  const normalized = normalizeWhitespace(queryText);
  if (subjects.length === 0 && !/\b(?:me|my|i|myself)\b/iu.test(normalized)) {
    return false;
  }
  return (
    /\b(?:summarize|summary|recap|overview|what do we know about|tell me about|tell me everything about|everything about|all the information(?: that you have)? on|full dossier|complete picture|whole story)\b/iu.test(
      normalized
    ) ||
    /\bwhat does (?:the system|the brain) know about\b/iu.test(normalized) ||
    /\b(?:piece together|life looks like(?: right now)?|what .* life looks like|close people|coworkers?|anything solid we know|loose summary|main points)\b/iu.test(
      normalized
    )
  );
}

function hasSelfReference(queryText: string): boolean {
  return /\b(?:me|my|mine|i|myself|steve(?:\s+tietze)?)\b/iu.test(queryText);
}

function isPersonalCareerProjectQuery(queryText: string): boolean {
  return /\b(?:two[- ]way|well\s+inked|ai\s+brain)\b/iu.test(queryText);
}

function isThirdPartyCareerCue(queryText: string, subjects: readonly string[]): boolean {
  const hasThirdPartySubject = subjects.some((subject) => normalizeWhitespace(subject).toLowerCase() !== "steve tietze");
  return (
    hasThirdPartySubject ||
    /\b[A-Z][A-Za-z.'-]+['’]s\b/u.test(queryText) ||
    /\b(?:he|she|his|her|they|their)\b/iu.test(queryText)
  );
}

function isWorkHistoryProfileQuery(queryText: string, subjects: readonly string[]): boolean {
  const normalized = normalizeWhitespace(queryText);
  const selfReferenced = hasSelfReference(normalized);
  const personalProjectReferenced = isPersonalCareerProjectQuery(normalized);
  const thirdPartyCareerCue = isThirdPartyCareerCue(normalized, subjects);
  const publicCareerSportsCue = /\bcareer[- ]high\b|\bbasketball\s+career\b|\bcareer\b[\s\S]{0,80}\bbasketball\b/iu.test(normalized);

  if (publicCareerSportsCue && !selfReferenced) {
    return false;
  }

  if (!selfReferenced && !personalProjectReferenced && thirdPartyCareerCue) {
    return false;
  }

  return (
    /\b(?:work\s+history|career\s+history|professional\s+history|employment\s+history|what\s+have\s+i\s+done\s+in\s+my\s+career|what\s+have\s+i\s+worked\s+on\s+professionally|what\s+have\s+i\s+done\s+professionally|what\s+have\s+i\s+built(?:\s+or\s+worked\s+on)?(?:\s+professionally)?(?:\s+over\s+time)?|what\s+have\s+i\s+built\s+or\s+worked\s+on(?:\s+professionally)?(?:\s+over\s+time)?)\b/iu.test(
      normalized
    ) ||
    /\b(?:tell\s+me\s+about|tell\s+me\s+everything(?:\s+i(?:'|’)ve)?\s+(?:talked\s+about\s+that\s+i(?:'|’)ve)?\s*done\s+in|give\s+me)\b[\s\S]{0,80}\b(?:career|work\s+history|professional\s+history)\b/iu.test(
      normalized
    ) ||
    /\b(?:what|which|list|give\s+me|show\s+me|can\s+you\s+give\s+me)\b[\s\S]{0,100}\b(?:company|companies|employer|employers)\b[\s\S]{0,100}\b(?:worked\s+for|work\s+for|worked\s+at|work\s+at)\b/iu.test(
      normalized
    ) ||
    /\b(?:where|who)\b[\s\S]{0,40}\b(?:have|do)\b[\s\S]{0,20}\bi\b[\s\S]{0,20}\b(?:work|worked)\b(?:[\s\S]{0,20}\b(?:for|at)\b)?/iu.test(
      normalized
    ) ||
    /\b(?:built|worked\s+on)\b[\s\S]{0,40}\b(?:professionally|over\s+time)\b/iu.test(normalized) ||
    /\broles?\b[\s\S]{0,80}\b(?:two-way|two way|well inked|worked|career|job|employment)\b/iu.test(normalized) ||
    /\b(?:employers?|projects?)\b[\s\S]{0,40}\b(?:versus|vs\.?)\b[\s\S]{0,40}\b(?:employers?|projects?)\b/iu.test(normalized) ||
    /\bwhat\s+am\s+i\s+actively\s+building\s+now\b[\s\S]{0,80}\bwhere\s+do\s+i\s+work\b/iu.test(normalized)
  );
}

function isHistoricalWorkSubjectQuery(queryText: string, subjects: readonly string[]): boolean {
  if (subjects.length === 0) {
    return false;
  }
  const normalized = normalizeWhitespace(queryText);
  const selfReferenced = hasSelfReference(normalized);
  const personalHistoricalAnchor = /\b(?:id\s+software|john\s+carmack)\b/iu.test(normalized);
  if (!selfReferenced && !personalHistoricalAnchor) {
    return false;
  }
  return (
    /\bwhat\s+(?:things\s+)?did\s+i\s+do\s+with\b/iu.test(normalized) ||
    /\bwhat\s+work\s+did\s+i\s+do\s+with\b/iu.test(normalized) ||
    /\bwhat\s+did\s+i\s+(?:build|work\s+on|make|ship)\s+with\b/iu.test(normalized) ||
    /\bwhat\s+(?:companies|employers)\b[\s\S]{0,40}\bwith\b/iu.test(normalized) ||
    /\b(?:career|work|professional|employment|game(?:\s+industry)?|project|projects)\b[\s\S]{0,80}\bwith\b/iu.test(normalized) ||
    /\bwhat(?:'s| is)\s+my\s+(?:history|story)\s+with\b/iu.test(normalized)
  );
}

function baseContract(params: {
  readonly contractName: QueryContractName;
  readonly contractFamily: QueryContractFamily;
  readonly answerShape: QueryContract["answerShape"];
  readonly subjectHints?: readonly string[];
  readonly pairHints?: readonly string[];
  readonly temporalHints?: readonly string[];
  readonly targetProjection?: string | null;
  readonly allowedReadModels?: readonly string[];
  readonly blockedFallbacks?: readonly string[];
  readonly confidence: number;
  readonly routingReasons: readonly string[];
  readonly startedAt: number;
}): QueryContract {
  return {
    contractName: params.contractName,
    contractFamily: params.contractFamily,
    retrievalDomain: primaryRetrievalDomainForQueryContract(params.contractName),
    answerShape: params.answerShape,
    subjectHints: unique(params.subjectHints ?? []),
    pairHints: unique(params.pairHints ?? []),
    temporalHints: unique(params.temporalHints ?? []),
    targetProjection: params.targetProjection ?? null,
    allowedReadModels: unique(params.allowedReadModels ?? []),
    blockedFallbacks: unique(params.blockedFallbacks ?? []),
    confidence: params.confidence,
    routingReasons: unique(params.routingReasons),
    latencyMs: Number((performance.now() - params.startedAt).toFixed(3))
  };
}

export function inferQueryContract(queryText: string): QueryContract {
  const startedAt = performance.now();
  const normalized = normalizeWhitespace(queryText);
  const lower = normalized.toLowerCase();
  const explicitSubjects = unique([...extractExplicitWorkSubjects(normalized), ...extractExplicitAboutSubjects(normalized)]);
  const names = unique([...suppressShadowedNames(extractCapitalizedNames(normalized), explicitSubjects), ...explicitSubjects]);
  const pair = extractBetweenPair(normalized);
  const subjects = nonSelfSubjects(pair.length > 0 ? pair : names);
  const times = temporalHints(normalized);
  const projectSubject = extractProjectDefinitionSubject(normalized);
  const unknownDefinitionSubject = extractUnknownDefinitionReviewSubject(normalized);
  const sharedSocialPair = extractSharedSocialPair(normalized, names);
  const friendSetPlaceScope = extractFriendSetPlaceScope(normalized);

  if (projectSubject) {
    return baseContract({
      contractName: "project_definition",
      contractFamily: "project_definition",
      answerShape: "report",
      subjectHints: [projectSubject],
      temporalHints: times,
      targetProjection: "project_definition_projection_v1",
      allowedReadModels: ["project_definition_projection", "compiled_direct_fact", "document_section_projection"],
      blockedFallbacks: ["generic_lexical", "weak_canonical_profile"],
      confidence: 0.94,
      routingReasons: ["project_definition_cue", "known_project_or_org_subject"],
      startedAt
    });
  }

  if (unknownDefinitionSubject) {
    return baseContract({
      contractName: "review_only",
      contractFamily: "generic",
      answerShape: "abstention",
      subjectHints: [unknownDefinitionSubject],
      temporalHints: times,
      allowedReadModels: ["taxonomy_review_items"],
      blockedFallbacks: ["generic_lexical", "weak_canonical_profile"],
      confidence: 0.84,
      routingReasons: ["unknown_definition_cue", "review_unknown_required"],
      startedAt
    });
  }

  if (
    /\b(?:where\s+did\s+(?:that|the)?(?:\s+answer)?\s*come\s+from|where\s+did\b[\s\S]{0,120}\bcome\s+from|show\s+(?:me\s+)?(?:the\s+)?sources?|show\s+me\s+the\s+evidence|why\s+do\s+you\s+think|why\s+does\s+the\s+brain\s+(?:think|believe)|is\s+this\s+source[- ]backed|prove\s+that|source\s+audit)\b/iu.test(
      normalized
    )
  ) {
    return baseContract({
      contractName: "source_audit",
      contractFamily: "source_audit",
      answerShape: "report",
      subjectHints: subjects,
      temporalHints: times,
      allowedReadModels: ["source_audit_index", "artifact_chunks", "direct_source_read_model"],
      blockedFallbacks: ["weak_canonical_profile"],
      confidence: 0.95,
      routingReasons: ["source_audit_cue", "pre_friend_set_binding"],
      startedAt
    });
  }

  if (
    friendSetPlaceScope &&
    /\b(?:who|list|show|which)\b[\s\S]{0,80}\b(?:my|mine|me|i|steve(?:\s+tietze)?)?\s*friends?\b/iu.test(normalized)
  ) {
    return baseContract({
      contractName: "shared_social_graph",
      contractFamily: "typed_list_set",
      answerShape: "list",
      subjectHints: ["Steve Tietze"],
      pairHints: ["Steve Tietze"],
      temporalHints: times,
      targetProjection: "shared_social_graph_v1",
      allowedReadModels: ["shared_social_graph", "relationship_graph_intersection", "support_network"],
      blockedFallbacks: ["relationship_map_projection", "generic_lexical", "weak_canonical_profile"],
      confidence: 0.96,
      routingReasons: ["friend_set_place_scope", "self_subject_binding", "place_filter_required"],
      startedAt
    });
  }

  if (/\b(?:who|which\s+people|people)\b[\s\S]{0,120}\b(?:introduc(?:e|ed)\s+me\s+to|met\s+through\s+[A-Z][A-Za-z.'-]*)\b/iu.test(normalized)) {
    return baseContract({
      contractName: "shared_social_graph",
      contractFamily: "typed_list_set",
      answerShape: "list",
      subjectHints: ["Steve Tietze"],
      pairHints: ["Steve Tietze"],
      temporalHints: times,
      targetProjection: "shared_social_graph_v1",
      allowedReadModels: ["shared_social_graph", "relationship_graph_intersection", "support_network"],
      blockedFallbacks: ["relationship_map_projection", "generic_lexical", "weak_canonical_profile"],
      confidence: 0.94,
      routingReasons: ["introduced_me_friend_set_cue", "self_subject_binding"],
      startedAt
    });
  }

  if (
    sharedSocialPair.length >= 2 &&
    (
      /\b(?:mutual|shared|common)\s+friends?\b/iu.test(normalized) ||
      /\bfriends?\s+in\s+common\b/iu.test(normalized) ||
      /\bwhich\s+friends?\b[\s\S]{0,80}\bin\s+common\b/iu.test(normalized) ||
      /\bwho\s+do\b[\s\S]{0,80}\bboth\s+know\b/iu.test(normalized) ||
      /\bwho\s+are\b[\s\S]{0,80}\bfriends?\b/iu.test(normalized) ||
      /\b(?:social\s+circle|support\s+network|friend\s+group)\b/iu.test(normalized)
    )
  ) {
    return baseContract({
      contractName: "shared_social_graph",
      contractFamily: "typed_list_set",
      answerShape: "list",
      subjectHints: sharedSocialPair,
      pairHints: sharedSocialPair,
      temporalHints: times,
      targetProjection: "shared_social_graph_v1",
      allowedReadModels: ["shared_social_graph", "relationship_graph_intersection", "support_network"],
      blockedFallbacks: ["relationship_map_projection", "generic_lexical", "weak_canonical_profile"],
      confidence: 0.97,
      routingReasons: ["shared_social_graph_cue", "pair_subject_binding"],
      startedAt
    });
  }

  if (
    /\b(?:who|list|show)\b[\s\S]{0,80}\b(?:my|mine|me|dan|[A-Z][A-Za-z.'-]*(?:'s)?)\s+friends?\b/iu.test(normalized) ||
    /\b(?:friend\s+set|friend\s+list|friend\s+group|social\s+circle)\b/iu.test(normalized)
  ) {
    const friendSetSubjects = sharedSocialPair.length > 0
      ? sharedSocialPair
        : /\b(?:my|mine|me|i)\b/iu.test(normalized)
        ? ["Steve Tietze", ...nonSelfSubjects(names)]
        : nonSelfSubjects(names);
    if (friendSetSubjects.length > 0) {
      return baseContract({
        contractName: "shared_social_graph",
        contractFamily: "typed_list_set",
        answerShape: "list",
        subjectHints: unique(friendSetSubjects),
        pairHints: unique(friendSetSubjects),
        temporalHints: times,
        targetProjection: "shared_social_graph_v1",
        allowedReadModels: ["shared_social_graph", "relationship_graph_intersection", "support_network"],
        blockedFallbacks: ["relationship_map_projection", "generic_lexical", "weak_canonical_profile"],
        confidence: 0.94,
        routingReasons: ["friend_set_cue", friendSetSubjects.length >= 2 ? "pair_subject_binding" : "single_subject_friend_set"],
        startedAt
      });
    }
  }

  if (
    subjects.length > 0 &&
    (
      /\bwhat\s+happened\s+between\b/iu.test(normalized) ||
      /\bwhat\s+went\s+on\s+(?:between|with)\b/iu.test(normalized) ||
      /\bour\s+(?:history|story|relationship)\b/iu.test(normalized) ||
      /\bbreakdown\b[\s\S]{0,120}\b(?:relationship|friendship|history|story)\b/iu.test(normalized) ||
      /\b(?:relationship|friendship)\b[\s\S]{0,120}\bbreakdown\b/iu.test(normalized) ||
      /\b(?:history|story|timeline)\s+with\b/iu.test(normalized) ||
      /\brelationship\s+(?:history|timeline|changed?|transition)\b/iu.test(normalized) ||
      /\b(?:reconnect|reconnected)\b/iu.test(normalized) ||
      /\bchanged?\s+in\s+the\s+relationship\b/iu.test(normalized) ||
      /\bhow\s+(?:has|did)\b[\s\S]{0,80}\brelationship\b[\s\S]{0,80}\b(?:change|changed|evolve|evolved)\b/iu.test(normalized)
    )
  ) {
    return baseContract({
      contractName: "relationship_chronology",
      contractFamily: "profile_report",
      answerShape: "timeline",
      subjectHints: subjects,
      pairHints: pair.length > 0 ? pair : ["Steve Tietze", ...subjects],
      temporalHints: times,
      targetProjection: "relationship_chronology_projection_v1",
      allowedReadModels: ["relationship_chronology_projection", "relationship_history_direct_read_model"],
      blockedFallbacks: ["generic_lexical", "weak_canonical_profile"],
      confidence: pair.length > 0 ? 0.98 : 0.9,
      routingReasons: pair.length > 0 ? ["between_pair_phrase", "relationship_chronology_cue"] : ["relationship_chronology_cue"],
      startedAt
    });
  }

  if (
    /\b(?:where\s+did\s+(?:that|the)?(?:\s+answer)?\s*come\s+from|where\s+did\b[\s\S]{0,120}\bcome\s+from|show\s+(?:me\s+)?(?:the\s+)?sources?|show\s+me\s+the\s+evidence|why\s+do\s+you\s+think|why\s+does\s+the\s+brain\s+(?:think|believe)|is\s+this\s+source[- ]backed|prove\s+that|source\s+audit)\b/iu.test(
      normalized
    )
  ) {
    return baseContract({
      contractName: "source_audit",
      contractFamily: "source_audit",
      answerShape: "report",
      subjectHints: subjects,
      temporalHints: times,
      allowedReadModels: ["source_audit_index", "artifact_chunks", "direct_source_read_model"],
      blockedFallbacks: ["weak_canonical_profile"],
      confidence: 0.93,
      routingReasons: ["source_audit_cue"],
      startedAt
    });
  }

  if (isWorkHistoryProfileQuery(normalized, subjects)) {
    const hintedSubjects = subjects.length > 0 ? subjects : ["Steve Tietze"];
    return baseContract({
      contractName: "profile_report",
      contractFamily: "profile_report",
      answerShape: "report",
      subjectHints: hintedSubjects,
      temporalHints: times,
      allowedReadModels: ["work_history_report_direct_read_model", "profile_report_projection", "recap_profile_projection", "compiled_profile_inference"],
      blockedFallbacks: ["weak_canonical_profile", "generic_lexical"],
      confidence: 0.93,
      routingReasons: ["work_history_report_cue", "broad_profile_summary_cue"],
      startedAt
    });
  }

  if (isHistoricalWorkSubjectQuery(normalized, subjects)) {
    return baseContract({
      contractName: "profile_report",
      contractFamily: "profile_report",
      answerShape: "report",
      subjectHints: subjects,
      temporalHints: times,
      allowedReadModels: ["work_history_report_direct_read_model", "entity_dossier", "profile_report_projection", "recap_profile_projection"],
      blockedFallbacks: ["weak_canonical_profile", "generic_lexical"],
      confidence: 0.91,
      routingReasons: ["work_history_subject_query_cue", "subject_bound_history_query"],
      startedAt
    });
  }

  if (isBroadProfileSummaryQuery(normalized, subjects)) {
    return baseContract({
      contractName: "profile_report",
      contractFamily: "profile_report",
      answerShape: "report",
      subjectHints: subjects,
      temporalHints: times,
      allowedReadModels: ["profile_report_projection", "recap_profile_projection", "compiled_profile_inference"],
      blockedFallbacks: ["weak_canonical_profile"],
      confidence: 0.86,
      routingReasons: ["profile_report_cue", "broad_profile_summary_cue"],
      startedAt
    });
  }

  if (
    /\b(?:open\s+tasks?|action\s+items?|due\s+(?:today|this\s+week)|what\s+do\s+i\s+need\s+to\s+do|what\s+should\s+i\s+do|extract\s+(?:the\s+)?tasks?|list\s+(?:the\s+)?(?:remaining\s+)?tasks?|todo|to-do)\b/iu.test(
      normalized
    )
  ) {
    return baseContract({
      contractName: "task_list",
      contractFamily: "task_ops",
      answerShape: "list",
      subjectHints: subjects,
      temporalHints: times,
      allowedReadModels: ["task_projection", "compiled_direct_fact"],
      blockedFallbacks: ["weak_canonical_profile"],
      confidence: 0.9,
      routingReasons: ["task_list_cue"],
      startedAt
    });
  }

  if (
    /\b(?:how\s+do\s+i|how\s+to|steps?\s+to|run\s+production\s+readiness|reset\s+(?:a|the)\s+namespace|procedure)\b/iu.test(normalized) &&
    !/\bhow\s+do\s+i\s+know\b/iu.test(normalized) &&
    !/\b(?:why|who|when|where)\b/iu.test(normalized)
  ) {
    return baseContract({
      contractName: "procedure_lookup",
      contractFamily: "procedural_memory",
      answerShape: "procedure",
      subjectHints: subjects,
      temporalHints: times,
      allowedReadModels: ["procedure_projection", "document_section_projection"],
      blockedFallbacks: ["weak_canonical_profile"],
      confidence: 0.88,
      routingReasons: ["procedure_lookup_cue"],
      startedAt
    });
  }

  if (
    /\b(?:trip|travel)\b[\s\S]{0,120}\b(?:planning|planned|upcoming|going|end\s+of\s+[A-Z][a-z]+|conference|association)\b/iu.test(normalized) ||
    /\bplans?\b[\s\S]{0,80}\bend\s+of\s+[A-Z][a-z]+\b/iu.test(normalized)
  ) {
    return baseContract({
      contractName: "current_state",
      contractFamily: "current_state",
      answerShape: "report",
      subjectHints: subjects,
      temporalHints: times,
      allowedReadModels: ["planned_trip_direct_read_model", "continuity_current_state_projection", "compiled_direct_fact"],
      blockedFallbacks: ["weak_canonical_profile"],
      confidence: 0.88,
      routingReasons: ["planned_trip_current_state_cue"],
      startedAt
    });
  }

  if (
    /\b(?:ingestion|tagging|extraction|source\s+kind|source\s+type|quality\s+issues?|quality\s+ledger|failed\s+to\s+produce|missing\s+(?:task\s+)?projections?|temporal\s+windows?|fix\s+next\s+in\s+ingestion\s+quality)\b/iu.test(normalized) ||
    /\b(?:parser[_\s-]?chunking[_\s-]?quality[_\s-]?defect|parent[_\s-]?child[_\s-]?context[_\s-]?missing|temporal[_\s-]?validity[_\s-]?conflict|task[_\s-]?projection[_\s-]?missing|event[_\s-]?projection[_\s-]?missing)\b/iu.test(normalized) ||
    /\b(?:what\s+does\s+(?:this|the)\s+(?:spec|plan|doc|document)|what\s+changed\s+in\s+this\s+plan|summarize\s+this\s+(?:spec|plan|doc|document)|what\s+does\s+router\s+v2|what\s+does\s+the\s+plan\s+say\s+about|what\s+response\s+fields?\s+must|what\s+must\b[\s\S]{0,80}\bqueries?\s+do)\b/iu.test(
      normalized
    ) ||
    /\b(?:pdfs?|documents?|docs?|papers?|sources?|specs?)\b[\s\S]{0,120}\b(?:saved?|mention|mentions|contain|say|retrieval\s+planning|chunking|source\s+envelope)\b/iu.test(normalized) ||
    /\b(?:what|which)\b[\s\S]{0,80}\b(?:pdfs?|documents?|docs?|papers?|specs?)\b/iu.test(normalized)
  ) {
    return baseContract({
      contractName: "document_lookup",
      contractFamily: "document_lookup",
      answerShape: "report",
      subjectHints: subjects,
      temporalHints: times,
      allowedReadModels: ["document_section_projection", "source_bounded_fallback"],
      blockedFallbacks: ["weak_canonical_profile"],
      confidence: 0.89,
      routingReasons: ["document_lookup_cue"],
      startedAt
    });
  }

  if (
    subjects.length === 0 &&
    /\b(?:what\s+happened\s+between|what\s+went\s+on\s+(?:between|with)|our\s+(?:history|story|relationship)|relationship\s+(?:history|timeline|changed?|transition)|changed?\s+in\s+the\s+relationship)\b/iu.test(normalized)
  ) {
    return baseContract({
      contractName: "abstention",
      contractFamily: "generic",
      answerShape: "abstention",
      temporalHints: times,
      allowedReadModels: [],
      blockedFallbacks: ["generic_lexical", "weak_canonical_profile"],
      confidence: 0.86,
      routingReasons: ["relationship_contract_missing_subject"],
      startedAt
    });
  }

  if (
    subjects.length > 0 &&
    (
      /\bwho\s+(?:is|are)\b[\s\S]{0,80}\b(?:to\s+me|in\s+my\s+life)\b/iu.test(normalized) ||
      /^\s*who\s+(?:is|are)\s+[A-Z][A-Za-z.'-]*(?:\s+[A-Z][A-Za-z.'-]*){0,2}\b/iu.test(normalized) ||
      /\bhow\s+do\s+i\s+know\b/iu.test(lower) ||
      /\bwho\s+(?:is|are)\b[\s\S]{0,80}\bassociated\s+with\b/iu.test(normalized) ||
      /\bwhat\s+is\b[\s\S]{0,80}\bassociated\s+with\b/iu.test(normalized) ||
      /\bwhat\s+is\b[\s\S]{0,80}\brelationship\s+to\s+me\b/iu.test(normalized)
    )
  ) {
    return baseContract({
      contractName: "relationship_map",
      contractFamily: "profile_report",
      answerShape: "report",
      subjectHints: subjects,
      pairHints: ["Steve Tietze", ...subjects],
      temporalHints: times,
      targetProjection: "relationship_map_projection_v1",
      allowedReadModels: ["relationship_map_projection", "relationship_single_fast_path"],
      blockedFallbacks: ["generic_lexical", "weak_canonical_profile"],
      confidence: 0.96,
      routingReasons: ["relationship_map_cue"],
      startedAt
    });
  }

  if (
    /^\s*when\b/iu.test(normalized) ||
    /\bwhat\s+did\b[\s\S]{0,80}\b(?:yesterday|last\s+weekend|earlier\s+this\s+month)\b/iu.test(normalized) ||
    /\b(?:what|where)\s+did\b[\s\S]{0,120}\b(?:on|after|before)\b[\s\S]{0,80}\b(?:19|20)\d{2}\b/iu.test(normalized) ||
    /\b(?:start|started|leave|left|happen|happened|occurred)\b[\s\S]{0,80}\b(?:when|date|day|month|year)\b/iu.test(normalized)
  ) {
    return baseContract({
      contractName: "temporal_event",
      contractFamily: "temporal_detail",
      answerShape: "scalar",
      subjectHints: subjects,
      temporalHints: times,
      allowedReadModels: ["compiled_temporal_facts", "typed_temporal_anchor"],
      blockedFallbacks: ["weak_canonical_profile"],
      confidence: 0.82,
      routingReasons: ["temporal_question_cue"],
      startedAt
    });
  }

  if (
    /\bwhat\b[\s\S]{0,40}\b(?:books?|movies?|films?|people|friends?|items?|things?|activities|places?)\b/iu.test(normalized) ||
    /\bwho\s+(?:is|are)\b[\s\S]{0,40}\bfriends?\b/iu.test(normalized)
  ) {
    return baseContract({
      contractName: "list_set",
      contractFamily: "typed_list_set",
      answerShape: "list",
      subjectHints: subjects,
      temporalHints: times,
      allowedReadModels: ["compiled_list_sets", "typed_list_support"],
      blockedFallbacks: ["weak_canonical_profile"],
      confidence: 0.78,
      routingReasons: ["list_query_cue"],
      startedAt
    });
  }

  if (/\b(?:current|currently|right now|now|working on|focused on|buy|bought|like|prefer|routine|plans?|work with)\b/iu.test(normalized)) {
    return baseContract({
      contractName: "current_state",
      contractFamily: "current_state",
      answerShape: "report",
      subjectHints: subjects,
      temporalHints: times,
      allowedReadModels: ["continuity_current_state_projection", "compiled_direct_fact", "current_state_projection"],
      blockedFallbacks: ["weak_canonical_profile"],
      confidence: 0.76,
      routingReasons: ["current_state_cue"],
      startedAt
    });
  }

  if (/\b(?:summarize|recap|overview|what do we know about|tell me about)\b/iu.test(normalized)) {
    return baseContract({
      contractName: "profile_report",
      contractFamily: "profile_report",
      answerShape: "report",
      subjectHints: subjects,
      temporalHints: times,
      allowedReadModels: ["profile_report_projection", "recap_profile_projection", "compiled_profile_inference"],
      blockedFallbacks: ["weak_canonical_profile"],
      confidence: 0.72,
      routingReasons: ["profile_report_cue"],
      startedAt
    });
  }

  if (/\b(?:what\s+kind\s+of\s+(?:unknown|bucket)|classify\s+this\s+uncategorized|review\s+unknown|other\s+bucket)\b/iu.test(normalized)) {
    return baseContract({
      contractName: "review_only",
      contractFamily: "generic",
      answerShape: "abstention",
      subjectHints: subjects,
      temporalHints: times,
      allowedReadModels: ["taxonomy_review_items"],
      blockedFallbacks: ["generic_lexical", "weak_canonical_profile"],
      confidence: 0.91,
      routingReasons: ["review_unknown_cue"],
      startedAt
    });
  }

  return baseContract({
    contractName: "direct_fact",
    contractFamily: "exact_detail",
    answerShape: "scalar",
    subjectHints: subjects,
    temporalHints: times,
    allowedReadModels: ["compiled_direct_fact", "exact_detail_support"],
    blockedFallbacks: [],
    confidence: 0.55,
    routingReasons: ["default_direct_fact"],
    startedAt
  });
}

export function queryContractTelemetry(
  contract: QueryContract,
  selectedReadModel?: string | null,
  fallbackBlockedReason?: string | null
): Partial<RecallResponse["meta"]> {
  return {
    queryContractRouterTried: true,
    queryContractRouterSucceeded: contract.contractName !== "direct_fact" || contract.confidence >= 0.7,
    queryContractName: contract.contractName,
    queryContractFamily: contract.contractFamily,
    queryContractRetrievalDomain: contract.retrievalDomain,
    queryContractAnswerShape: contract.answerShape,
    queryContractConfidence: contract.confidence,
    queryContractRoutingReasons: contract.routingReasons,
    queryContractBlockedFallbacks: contract.blockedFallbacks,
    queryContractFallbackBlockedReason: fallbackBlockedReason ?? null,
    queryContractSelectedReadModel: selectedReadModel ?? contract.targetProjection ?? null,
    queryContractLatencyMs: contract.latencyMs
  };
}
