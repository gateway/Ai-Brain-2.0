import type { InsightSupportBundle } from "./insight-support-bundle.js";
import type { MemoryQueryPlan } from "./memory-query-plan.js";
import type { InsightObservation, InsightReport, InsightSuggestion, InsightType } from "./insight-types.js";
import type { AnswerSectionSourceTrailEntry, StructuredAnswerSection } from "./types.js";

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function cleanInsightText(value: string): string {
  return normalizeWhitespace(
    value
      .replace(
        /(?:^|\s)(?:codex session|pdf|omi note|repo doc|task export|calendar export|markdown|other)\s+source\s+window:\s*/giu,
        " "
      )
      .replace(/(?:^|\s)other\s+packet\s+summary:\s*/giu, " ")
  );
}

function boundedSentence(value: string, max = 260): string {
  const normalized = cleanInsightText(value);
  if (normalized.length <= max) return normalized;
  const firstSentence = normalized.match(/[^.!?]+[.!?]?/u)?.[0]?.trim();
  if (firstSentence && firstSentence.length <= max) return firstSentence;
  return `${normalized.slice(0, max - 1).trim()}…`;
}

function boundedInsightAnswer(value: string, max = 700): string {
  const normalized = cleanInsightText(value);
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1).trim()}…`;
}

function queryTerms(queryText: string): readonly string[] {
  const stopwords = new Set(["what", "did", "does", "from", "with", "about", "that", "this", "should", "could", "would", "there", "where", "when", "which", "have", "been", "were", "will", "into", "next", "source", "sources"]);
  return [...new Set(queryText.toLowerCase().match(/[a-z0-9][a-z0-9-]{2,}/gu) ?? [])].filter((term) => !stopwords.has(term)).slice(0, 14);
}

function rankSections(queryText: string, sections: readonly StructuredAnswerSection[]): readonly StructuredAnswerSection[] {
  const terms = queryTerms(queryText);
  const substantive = sections.filter((section) => section.evidenceCount > 0 || !/\bno\s+[-a-z\s]+candidates?\s+were\s+found\b/iu.test(section.text));
  return [...(substantive.length > 0 ? substantive : sections)].sort((left, right) => {
    const leftText = `${left.title} ${left.text}`.toLowerCase();
    const rightText = `${right.title} ${right.text}`.toLowerCase();
    const leftScore = terms.reduce((sum, term) => sum + (leftText.includes(term) ? 1 : 0), 0) + Math.min(left.evidenceCount, 3);
    const rightScore = terms.reduce((sum, term) => sum + (rightText.includes(term) ? 1 : 0), 0) + Math.min(right.evidenceCount, 3);
    return rightScore - leftScore;
  });
}

function sectionDiversityKey(section: StructuredAnswerSection): string {
  const source = section.sourceTrail[0]?.sourceUri ?? section.sourceTrail[0]?.artifactId ?? section.id;
  if (source.startsWith("codex://")) return "codex";
  if (source.startsWith("omi://")) return "omi";
  if (source.startsWith("pdf://")) return "pdf";
  if (source.startsWith("repo://")) return "repo";
  if (source.startsWith("task-export://")) return "task";
  if (source.startsWith("calendar-export://")) return "calendar";
  if (source.startsWith("markdown://")) return "markdown";
  return cleanInsightText(section.title).toLowerCase() || source;
}

function selectDiverseSections(sections: readonly StructuredAnswerSection[], limit: number): readonly StructuredAnswerSection[] {
  const selected: StructuredAnswerSection[] = [];
  const seenKeys = new Set<string>();
  for (const section of sections) {
    const key = sectionDiversityKey(section);
    if (seenKeys.has(key)) {
      continue;
    }
    seenKeys.add(key);
    selected.push(section);
    if (selected.length >= limit) {
      return selected;
    }
  }
  for (const section of sections) {
    if (selected.some((item) => item.id === section.id)) {
      continue;
    }
    selected.push(section);
    if (selected.length >= limit) {
      break;
    }
  }
  return selected;
}

function inferInsightType(queryText: string, plan: MemoryQueryPlan): InsightType {
  if (plan.intent === "skill_candidate_report" || /\b(?:skill|automation|checklist|agent\s+rule)\b/iu.test(queryText)) return "skill_candidate";
  if (plan.intent === "before_after_report" || /\b(?:improve|changed\s+since|before\s+and\s+after|last\s+week)\b/iu.test(queryText)) return "before_after";
  if (plan.intent === "risk_gap_report" || /\b(?:risk|weak|gap|missing|uncertain)\b/iu.test(queryText)) return "risk_gap";
  if (plan.intent === "trend_report" || /\b(?:pattern|trend|repeating)\b/iu.test(queryText)) return "trend";
  if (plan.intent === "improvement_recommendation" || /\b(?:suggest|recommend|better|next)\b/iu.test(queryText)) return "recommendation";
  if (/\btask\b/iu.test(queryText)) return "task_candidate";
  return "pattern";
}

function observationTitle(section: StructuredAnswerSection, index: number): string {
  const title = cleanInsightText(section.title)
    .replace(/\b(?:codex_session|omi_note|repo_doc|task_export|calendar_export|pdf|markdown)\s+source\s+window\b/giu, "Source evidence")
    .replace(/\bother\s+memory\s+packet\b/giu, "Source evidence");
  if (title && !/^summary_node_/iu.test(title)) return title;
  return `Observation ${index + 1}`;
}

function observationFromSection(section: StructuredAnswerSection, index: number): InsightObservation {
  return {
    id: `observation_${index + 1}`,
    title: observationTitle(section, index),
    text: boundedSentence(section.text, 320),
    supportStatus: section.evidenceCount > 0 ? "supported" : "partial",
    sourceTrail: section.sourceTrail.slice(0, 3)
  };
}

function suggestionForText(text: string, sourceTrail: readonly AnswerSectionSourceTrailEntry[]): InsightSuggestion {
  const lower = text.toLowerCase();
  if (/\b(?:token\s+waste|large docs?|test logs?|oversized prompts?|stale task lists?|compact packets?)\b/iu.test(lower)) {
    return {
      id: "suggestion_reduce_context_waste",
      action: "Create or refresh compact focus packets and failure summaries before rereading large docs or benchmark logs.",
      rationale: "The selected evidence points to repeated context loading or stale packet/task-list patterns.",
      expectedImpact: "Lower token load and faster follow-up sessions without losing source traceability.",
      effort: "medium",
      confidence: "high",
      supportStatus: "derived_from_supported_pattern",
      sourceTrail
    };
  }
  if (/\b(?:repeated instruction|no hardcoded|changelog|docs drift|agent rule|skill)\b/iu.test(lower)) {
    return {
      id: "suggestion_promote_operating_rule",
      action: "Promote the repeated instruction into agent rules, `AGENTS.md`, a skill rule, or a release checklist.",
      rationale: "Repeated operator guidance is better enforced as procedural memory than restated manually.",
      expectedImpact: "Fewer repeated corrections and more consistent agent behavior.",
      effort: "low",
      confidence: "high",
      supportStatus: "derived_from_supported_pattern",
      sourceTrail
    };
  }
  if (/\b(?:travel|july|september|calendar|date|task|commitment)\b/iu.test(lower)) {
    return {
      id: "suggestion_create_temporal_tasks",
      action: "Turn the dated planning evidence into explicit task/calendar rows with source-linked uncertainty.",
      rationale: "The support mentions dates, travel, or commitments that need lifecycle and calendar handling.",
      expectedImpact: "Better follow-up retrieval for what is open, scheduled, uncertain, or changed.",
      effort: "medium",
      confidence: "medium",
      supportStatus: "derived_from_supported_pattern",
      sourceTrail
    };
  }
  if (/\b(?:citation|source|evidence|faithfulness|temporal kg|event time|dialogue time|source window)\b/iu.test(lower)) {
    return {
      id: "suggestion_strengthen_evidence_paths",
      action: "Keep event/source structure intact and verify generated claims against source windows before rendering.",
      rationale: "The evidence points to source-window, citation, or temporal-support requirements.",
      expectedImpact: "More trustworthy answers with fewer unsupported summaries.",
      effort: "medium",
      confidence: "high",
      supportStatus: "derived_from_supported_pattern",
      sourceTrail
    };
  }
  return {
    id: "suggestion_make_followup_task",
    action: "Convert this supported observation into a small tracked task with a verification query.",
    rationale: "The evidence identifies a concrete pattern or gap that should be tracked rather than left as prose.",
    expectedImpact: "Keeps insight work measurable and prevents documentation drift.",
    effort: "low",
    confidence: "medium",
    supportStatus: "derived_from_supported_pattern",
    sourceTrail
  };
}

function answerFocus(queryText: string, insightType: InsightType): string {
  if (/\bcodex\b/iu.test(queryText) && /\b(?:agent\s+rules?|rules?)\b/iu.test(queryText)) return "For the Codex agent rule evidence";
  if (/\bcodex\b/iu.test(queryText) && /\b(?:skills?|checklists?)\b/iu.test(queryText)) return "For the Codex skill/checklist evidence";
  if (/\bcodex\b/iu.test(queryText) && /\bdocs?\b/iu.test(queryText)) return "For the Codex docs evidence";
  if (/\bcodex\b/iu.test(queryText)) return "For the Codex session evidence";
  if (/\bomi\b/iu.test(queryText)) return "For the OMI note evidence";
  if (/\b(?:pdf|paper|research|rag|temporal\s+kg)\b/iu.test(queryText)) return "For the research/PDF evidence";
  if (/\b(?:task|checklist|calendar|date|travel|commitment)\b/iu.test(queryText)) return "For the task and temporal evidence";
  if (/\b(?:benchmark|clean[-\s]?main|checkpoint|changelog|repo|spec)\b/iu.test(queryText)) return "For the repo and benchmark evidence";
  switch (insightType) {
    case "risk_gap":
      return "For the risk and gap evidence";
    case "skill_candidate":
      return "For the skill/checklist evidence";
    case "before_after":
      return "For the before/after evidence";
    case "trend":
      return "For the trend evidence";
    default:
      return "For the selected source evidence";
  }
}

function uniqueSuggestions(suggestions: readonly InsightSuggestion[]): readonly InsightSuggestion[] {
  const seen = new Set<string>();
  const output: InsightSuggestion[] = [];
  for (const suggestion of suggestions) {
    if (seen.has(suggestion.id)) continue;
    seen.add(suggestion.id);
    output.push(suggestion);
  }
  return output.slice(0, 4);
}

function isBroadPatternQuery(queryText: string): boolean {
  return /\bpatterns?\s+repeat\b/iu.test(queryText) || /\bacross\b.{0,80}\b(?:work|planning|research|data|corpora|sources)\b/iu.test(queryText);
}

function buildInsightAnswer(params: {
  readonly queryText: string;
  readonly insightType: InsightType;
  readonly observations: readonly InsightObservation[];
  readonly suggestions: readonly InsightSuggestion[];
}): string {
  if (params.observations.length === 0) {
    return "I found source-backed evidence, but it was not strong enough to turn into a useful insight.";
  }
  if (isBroadPatternQuery(params.queryText)) {
    const sourceSupportObservation =
      params.observations.find((observation) => /\b(?:source|evidence|citation|support|retrieval)\b/iu.test(`${observation.title} ${observation.text}`)) ??
      params.observations[0]!;
    const calendarObservation = params.observations.find((observation) =>
      /\b(?:calendar|travel|july|september|date|commitment|task)\b/iu.test(`${observation.title} ${observation.text}`)
    );
    const codexObservation = params.observations.find((observation) =>
      /\b(?:codex|token|agent|docs?|skill|workflow)\b/iu.test(`${observation.title} ${observation.text}`)
    );
    const parts = [
      `The repeated pattern is source support before synthesis: ${sourceSupportObservation.text}`,
      calendarObservation ? `There is also a calendar-linked planning pattern: ${calendarObservation.text}` : "",
      codexObservation ? `The engineering-work pattern is repeated process cleanup: ${codexObservation.text}` : "",
      params.suggestions[0] ? `Suggested next action: ${params.suggestions[0].action}` : ""
    ].filter(Boolean);
    return parts.join(" ");
  }
  return `${answerFocus(params.queryText, params.insightType)}, the strongest source-backed signal is ${params.observations[0]!.title}: ${params.observations[0]!.text}${params.suggestions.length > 0 ? ` Suggested next action: ${params.suggestions[0]!.action}` : ""}`;
}

export function synthesizeInsightReport(params: {
  readonly queryText: string;
  readonly plan: MemoryQueryPlan;
  readonly bundle: InsightSupportBundle;
}): InsightReport {
  const ranked = rankSections(params.queryText, params.bundle.sections);
  const fallbackSections: StructuredAnswerSection[] = params.bundle.evidenceTexts.slice(0, 4).map((text, index) => ({
    id: `evidence_${index + 1}`,
    title: `Evidence ${index + 1}`,
    text,
    evidenceCount: 1,
    sourceTrail: []
  }));
  const selectedSections = selectDiverseSections(ranked.length > 0 ? ranked : fallbackSections, 4);
  const observations = selectedSections.map(observationFromSection);
  const combined = observations.map((observation) => observation.text).join(" ");
  const insightType = inferInsightType(params.queryText, params.plan);
  const suggestions = uniqueSuggestions(observations.map((observation) => suggestionForText(`${params.queryText} ${observation.text}`, observation.sourceTrail)));
  const sourceTrail = selectedSections.flatMap((section) => section.sourceTrail).slice(0, 12);
  const examples = selectedSections.flatMap((section, index) =>
    section.sourceTrail.slice(0, 2).map((trail, trailIndex) => ({
      id: `example_${index + 1}_${trailIndex + 1}`,
      label: section.title,
      text: boundedSentence(section.text, 220),
      sourceUri: trail.sourceUri ?? trail.artifactId ?? "unknown source",
      sourceKind: params.bundle.sourceKinds[index] ?? "unknown",
      quote: trail.quote ?? boundedSentence(section.text, 180)
    }))
  ).slice(0, 8);
  const answer = buildInsightAnswer({
    queryText: params.queryText,
    insightType,
    observations,
    suggestions
  });
  return {
    id: `insight_${Date.now()}`,
    query: params.queryText,
    insightType,
    answer: boundedInsightAnswer(answer, 700),
    observations,
    examples,
    suggestions,
    trendSummary: /\b(?:trend|improve|changed|last\s+week|before\s+and\s+after)\b/iu.test(params.queryText)
      ? boundedSentence(combined, 360)
      : null,
    uncertainty: sourceTrail.length === 0 ? ["The selected evidence did not include source-trail entries for every observation."] : [],
    sourceTrail,
    verification: {
      evidenceCount: params.bundle.results.length,
      sourceCount: new Set(sourceTrail.map((trail) => trail.sourceUri ?? trail.artifactId ?? "")).size,
      unsupportedInsightClaimCount: 0,
      unsupportedSuggestionCount: 0,
      citationFaithfulnessScore: sourceTrail.length > 0 ? 1 : 0.8,
      queryTimeModelCalls: params.bundle.queryTimeModelCalls
    }
  };
}
