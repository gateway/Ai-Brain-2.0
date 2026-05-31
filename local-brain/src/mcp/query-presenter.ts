import type { QueryFocusMode } from "../retrieval/types.js";

interface HumanReadableAnswerSection {
  readonly id: string;
  readonly title: string;
  readonly text: string;
  readonly evidenceCount: number;
  readonly sourceTrail: readonly string[];
  readonly claimAudit: readonly Record<string, unknown>[];
  readonly focusModes: readonly QueryFocusMode[];
}

function evidenceItems(payload: any): readonly any[] {
  if (Array.isArray(payload?.duality?.evidence)) return payload.duality.evidence;
  if (Array.isArray(payload?.evidence)) return payload.evidence;
  if (Array.isArray(payload?.tasks)) return payload.tasks;
  if (Array.isArray(payload?.commitments)) return payload.commitments;
  return [];
}

function normalizeSnippet(value: unknown, max = 180): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (!normalized) {
    return null;
  }
  return normalized.length > max ? `${normalized.slice(0, max - 1)}…` : normalized;
}

function uniqueStrings(values: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    output.push(normalized);
  }
  return output;
}

function answerFromPayload(payload: any): string {
  if (typeof payload?.answer === "string" && payload.answer.trim()) {
    return payload.answer.trim();
  }
  if (typeof payload?.duality?.claim?.text === "string" && payload.duality.claim.text.trim()) {
    return payload.duality.claim.text.trim();
  }
  if (typeof payload?.summaryText === "string" && payload.summaryText.trim()) {
    return payload.summaryText.trim();
  }
  if (payload?.followUpAction === "route_to_clarifications" && typeof payload?.clarificationHint?.suggestedPrompt === "string") {
    return payload.clarificationHint.suggestedPrompt.trim();
  }
  if (Array.isArray(payload?.tasks)) {
    return payload.tasks
      .map((task: any) => (typeof task?.title === "string" ? task.title : typeof task?.text === "string" ? task.text : ""))
      .filter(Boolean)
      .join("; ");
  }
  if (Array.isArray(payload?.commitments)) {
    return payload.commitments
      .map((commitment: any) => (typeof commitment?.title === "string" ? commitment.title : typeof commitment?.text === "string" ? commitment.text : ""))
      .filter(Boolean)
      .join("; ");
  }
  return "";
}

function isSourceAuditQuestion(query: string, payload: any): boolean {
  const normalized = query.toLowerCase();
  return (
    payload?.queryContract === "source_audit" ||
    /\b(?:where did|where was).{0,80}\b(?:come from|source|evidence)\b/u.test(normalized) ||
    /\b(?:show|list).{0,40}\bsources?\b/u.test(normalized) ||
    /\b(?:source trail|provenance|evidence for|why do you think|why does)\b/u.test(normalized)
  );
}

function trailLine(item: any, sourceMax = 160, quoteMax = 180): string | null {
  const source = normalizeSnippet(item?.sourceUri ?? item?.artifactId ?? item?.sourceMemoryIds?.[0] ?? "unknown source", sourceMax);
  const quote = normalizeSnippet(item?.quote, quoteMax);
  if (!source) {
    return null;
  }
  return quote ? `${source} -> ${quote}` : source;
}

function claimAuditSourceLines(payload: any, maxItems: number): readonly string[] {
  const audit = Array.isArray(payload?.claimAudit) ? payload.claimAudit : [];
  const lines: string[] = [];
  for (const entry of audit) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const record = entry as Record<string, any>;
    const supportStatus = typeof record.supportStatus === "string" ? record.supportStatus : "unsupported";
    if (supportStatus === "unsupported") {
      continue;
    }
    const claim = normalizeSnippet(record.claimText, 120);
    const trail = Array.isArray(record.sourceTrail) ? record.sourceTrail : [];
    const firstTrail = trailLine(trail[0], 120, 160);
    if (supportStatus === "abstained") {
      const reason = claim ?? normalizeSnippet(payload?.abstentionReason, 160) ?? "No authoritative source-backed claim was selected";
      lines.push(`Abstention: ${reason}`);
    } else if (firstTrail) {
      lines.push(claim ? `${claim} -> ${firstTrail}` : firstTrail);
    }
    if (lines.length >= maxItems) {
      break;
    }
  }
  return uniqueStrings(lines);
}

function sourceAuditAnswer(payload: any, maxItems: number): string {
  const auditLines = claimAuditSourceLines(payload, maxItems);
  if (auditLines.length > 0) {
    return `Source trail: ${auditLines.join("; ")}.`;
  }
  const trail = Array.isArray(payload?.sourceTrail) ? payload.sourceTrail : [];
  const items = trail
    .slice(0, maxItems)
    .map((item: any) => trailLine(item))
    .filter((item: string | null): item is string => typeof item === "string" && item.length > 0);
  if (items.length === 0) {
    return "";
  }
  return `Source trail: ${items.join("; ")}.`;
}

function compactAnswerLimit(query: string, payload: any): number {
  if (payload?.finalClaimSource === "codex_project_detail_report") {
    return 560;
  }
  if (payload?.finalClaimSource === "workflow_pattern_report" || payload?.finalClaimSource === "engineering_memory_packet") {
    return 420;
  }
  if (
    payload?.finalClaimSource === "source_topic_report" ||
    /\b(?:projects?|actively building|working on|current(?:ly)? building)\b/iu.test(query)
  ) {
    return 700;
  }
  return 240;
}

function compactAnswer(value: string, max = 240): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (!normalized) {
    return "";
  }
  if (normalized.length <= max) {
    return normalized;
  }
  const sentences = normalized.match(/[^.!?]+(?:[.!?]+|$)/gu)?.map((sentence) => sentence.trim()).filter(Boolean) ?? [];
  let compact = "";
  for (const sentence of sentences) {
    const candidate = compact ? `${compact} ${sentence}` : sentence;
    if (candidate.length > max) {
      break;
    }
    compact = candidate;
  }
  if (compact) {
    return compact;
  }
  return normalized.length > max ? `${normalized.slice(0, max - 1)}…` : normalized;
}

function summarizeEvidence(payload: any): readonly string[] {
  return evidenceItems(payload)
    .slice(0, 3)
    .map((item: any) => normalizeSnippet(item?.snippet ?? item?.content ?? item?.text))
    .filter((item: string | null): item is string => typeof item === "string" && item.length > 0);
}

function uncertaintyLine(payload: any): string | null {
  if (payload?.evidenceCount === 0) {
    return typeof payload?.abstentionReason === "string" ? payload.abstentionReason : "No authoritative evidence was returned.";
  }
  if (typeof payload?.vectorBlockedReason === "string" && payload.vectorBlockedReason) {
    return `Vector recall was constrained: ${payload.vectorBlockedReason}.`;
  }
  return null;
}

function suggestedNextQuery(payload: any, originalQuery: string): string | null {
  if (payload?.evidenceCount === 0) {
    return "Try a narrower version with a named person, project, or time window.";
  }
  switch (payload?.queryContract) {
    case "relationship_chronology":
      return "Ask who that person is to you for a current relationship map.";
    case "relationship_map":
      return "Ask what happened between you and that person for a chronology.";
    case "current_state":
      return "Ask why the brain believes that answer if you want the source trail.";
    case "source_audit":
      return "Ask the direct fact again if you want the current value instead of the provenance.";
    case "procedure_lookup":
      return "Ask for the exact command sequence if you want the procedure broken into steps.";
    case "project_definition":
      return "Ask what changed recently if you want current state instead of the definition.";
    default:
      return originalQuery ? "Ask for evidence if you want the source trail." : null;
  }
}

function insightHumanAnswer(payload: any, detailMode: "compact" | "full"): string | null {
  const report = payload?.insightReport && typeof payload.insightReport === "object" ? payload.insightReport : null;
  if (!report) {
    return null;
  }
  const answer = typeof report.answer === "string" ? report.answer.trim() : "";
  const observations = Array.isArray(report.observations) ? report.observations : [];
  const suggestions = Array.isArray(report.suggestions) ? report.suggestions : [];
  const examples = Array.isArray(report.examples) ? report.examples : [];
  const uncertainty = Array.isArray(report.uncertainty) ? report.uncertainty.filter((value: unknown): value is string => typeof value === "string" && value.trim().length > 0) : [];
  const observationLines = observations
    .slice(0, detailMode === "compact" ? 2 : 4)
    .map((item: any) => {
      const title = typeof item?.title === "string" ? item.title.trim() : "Observation";
      const text = typeof item?.text === "string" ? item.text.trim() : "";
      return text ? `- ${title}: ${text}` : "";
    })
    .filter(Boolean);
  const suggestionLines = suggestions
    .slice(0, detailMode === "compact" ? 2 : 4)
    .map((item: any) => {
      const action = typeof item?.action === "string" ? item.action.trim() : "";
      const impact = typeof item?.expectedImpact === "string" ? item.expectedImpact.trim() : "";
      return action ? `- ${action}${impact && detailMode === "full" ? ` Impact: ${impact}` : ""}` : "";
    })
    .filter(Boolean);
  const exampleLines = examples
    .slice(0, detailMode === "compact" ? 0 : 4)
    .map((item: any) => {
      const source = normalizeSnippet(item?.sourceUri, 120);
      const quote = normalizeSnippet(item?.quote, 160);
      return source && quote ? `- ${source}: ${quote}` : "";
    })
    .filter(Boolean);
  return [
    answer ? `Answer\n${answer}` : "",
    observationLines.length > 0 ? `What I’m seeing\n${observationLines.join("\n")}` : "",
    exampleLines.length > 0 ? `Examples\n${exampleLines.join("\n")}` : "",
    suggestionLines.length > 0 ? `Suggested next actions\n${suggestionLines.join("\n")}` : "",
    uncertainty.length > 0 ? `Uncertainty\n${uncertainty.map((item: string) => `- ${item}`).join("\n")}` : ""
  ].filter(Boolean).join("\n\n") || null;
}

function summarizeSourceTrail(payload: any, maxItems: number): readonly string[] {
  const trail = Array.isArray(payload?.sourceTrail) ? payload.sourceTrail : [];
  return trail
    .slice(0, maxItems)
    .map((item: any) => {
      const source = normalizeSnippet(item?.sourceUri ?? item?.artifactId ?? item?.sourceMemoryIds?.[0] ?? "unknown source", 120);
      const quote = normalizeSnippet(item?.quote, 140);
      if (!source) {
        return null;
      }
      return quote ? `${source}: ${quote}` : source;
    })
    .filter((item: string | null): item is string => typeof item === "string" && item.length > 0);
}

function normalizedAnswerSections(payload: any): readonly HumanReadableAnswerSection[] {
  if (!Array.isArray(payload?.answerSections)) {
    return [];
  }
  return payload.answerSections
    .map((item: any) => {
      const id = typeof item?.id === "string" ? item.id.trim() : "";
      const title = typeof item?.title === "string" ? item.title.trim() : "";
      const text = typeof item?.text === "string" ? item.text.trim() : "";
      if (!id || !title || !text) {
        return null;
      }
      const sourceTrail = summarizeSourceTrail({ sourceTrail: item?.sourceTrail }, 3);
      const claimAudit = Array.isArray(item?.claimAudit) ? item.claimAudit.filter((entry: unknown): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object") : [];
      const focusModes = Array.isArray(item?.focusModes)
        ? item.focusModes.filter((value: unknown): value is QueryFocusMode => typeof value === "string")
        : [];
      return {
        id,
        title,
        text,
        evidenceCount: typeof item?.evidenceCount === "number" ? item.evidenceCount : 0,
        sourceTrail,
        claimAudit,
        focusModes
      };
    })
    .filter((item: HumanReadableAnswerSection | null): item is HumanReadableAnswerSection => Boolean(item));
}

function filteredAnswerSections(payload: any, focusMode?: QueryFocusMode): readonly HumanReadableAnswerSection[] {
  const sections = normalizedAnswerSections(payload);
  if (!focusMode) {
    return sections;
  }
  const filtered = sections.filter((section) => section.focusModes.includes(focusMode));
  return filtered.length > 0 ? filtered : sections;
}

function whyThisAnswer(payload: any): string {
  const contract = typeof payload?.queryContract === "string" ? payload.queryContract : "unknown_contract";
  const source = typeof payload?.finalClaimSource === "string" ? payload.finalClaimSource : "unknown_source";
  const evidenceCount = typeof payload?.evidenceCount === "number" ? payload.evidenceCount : evidenceItems(payload).length;
  const selectionTrace = Array.isArray(payload?.selectionTrace) ? payload.selectionTrace : [];
  const selectedSections = Array.isArray(selectionTrace[0]?.selectedSections)
    ? selectionTrace[0].selectedSections.filter((value: unknown): value is string => typeof value === "string" && value.trim().length > 0)
    : [];
  const sectionText = selectedSections.length > 0 ? ` It prioritized ${selectedSections.join(", ")}.` : "";
  const claimAuditCount = Array.isArray(payload?.claimAudit) ? payload.claimAudit.length : 0;
  const auditText = claimAuditCount > 0 ? ` It produced ${claimAuditCount} claim-audit entr${claimAuditCount === 1 ? "y" : "ies"}.` : "";
  return `The result routed through ${contract} and returned ${source} with ${evidenceCount} evidence item${evidenceCount === 1 ? "" : "s"}.${sectionText}${auditText}`;
}

export interface HumanReadableQueryPresentation {
  readonly answer: string;
  readonly whyThisAnswer: string;
  readonly evidenceSummary: readonly string[];
  readonly answerSections: readonly Omit<HumanReadableAnswerSection, "focusModes">[];
  readonly sourceTrail: readonly string[];
  readonly uncertainty: string | null;
  readonly suggestedNextQuery: string | null;
}

export function presentHumanReadableQueryResult(params: {
  readonly query: string;
  readonly payload: Record<string, any>;
  readonly detailMode?: "compact" | "full";
  readonly focusMode?: QueryFocusMode;
}): HumanReadableQueryPresentation {
  const detailMode = params.detailMode ?? "full";
  const insightAnswer = insightHumanAnswer(params.payload, detailMode);
  const sections = filteredAnswerSections(params.payload, params.focusMode);
  const sectionAnswer =
    sections.length > 0
      ? (detailMode === "compact"
          ? sections[0]?.text ?? ""
          : sections.map((section) => `${section.title}: ${section.text}`).join(" "))
      : "";
  const answer = sectionAnswer || answerFromPayload(params.payload);
  const auditAnswer = isSourceAuditQuestion(params.query, params.payload)
    ? sourceAuditAnswer(params.payload, detailMode === "compact" ? 1 : 3)
    : "";
  const compactLimit = compactAnswerLimit(params.query, params.payload);
  const filteredSourceTrail = uniqueStrings(
    sections.flatMap((section) => section.sourceTrail)
  );
  return {
    answer: insightAnswer || auditAnswer || (detailMode === "compact" ? compactAnswer(answer, compactLimit) : answer),
    whyThisAnswer: whyThisAnswer(params.payload),
    evidenceSummary: summarizeEvidence(params.payload).slice(0, detailMode === "compact" ? 1 : 3),
    answerSections: sections.map((section) => ({
      id: section.id,
      title: section.title,
      text: detailMode === "compact" ? compactAnswer(section.text, 180) : section.text,
      evidenceCount: section.evidenceCount,
      sourceTrail: detailMode === "compact" ? section.sourceTrail.slice(0, 1) : section.sourceTrail.slice(0, 3),
      claimAudit: detailMode === "compact" ? section.claimAudit.slice(0, 1) : section.claimAudit.slice(0, 3)
    })),
    sourceTrail:
      filteredSourceTrail.length > 0
        ? filteredSourceTrail.slice(0, detailMode === "compact" ? 1 : 3)
        : summarizeSourceTrail(params.payload, detailMode === "compact" ? 1 : 3),
    uncertainty: uncertaintyLine(params.payload),
    suggestedNextQuery: suggestedNextQuery(params.payload, params.query)
  };
}
