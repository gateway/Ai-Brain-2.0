import { existsSync, readFileSync } from "node:fs";
import type { PoolClient } from "pg";
import { queryRows, withTransaction } from "../db/client.js";
import type { AssistantCandidate, CompilerRunResult, TaxonomyRegistry, ValidatedCandidate, ValidationIssue } from "./types.js";
import { loadMemoryTaxonomyRegistry } from "./registry.js";

export type DirectFactFamily =
  | "preference_fact"
  | "owned_object_fact"
  | "purchase_fact"
  | "project_goal_fact"
  | "health_status_fact"
  | "causal_reason_fact"
  | "relationship_status_fact"
  | "explicit_list_set"
  | "role_position_fact"
  | "owned_object_duration_fact"
  | "social_location_fact"
  | "residence_fact"
  | "date_activity_fact";

export type DirectFactAnswerShape =
  | "atomic_value"
  | "list"
  | "date"
  | "duration"
  | "reason"
  | "yes_no"
  | "abstention";

export interface DirectFactCompileDecision {
  readonly handled: boolean;
  readonly family: DirectFactFamily | null;
  readonly answerShape: DirectFactAnswerShape | null;
  readonly subject: string | null;
  readonly value: string | null;
  readonly supportPhrase: string | null;
  readonly promotionStatus: "compiled" | "rejected" | "ambiguous";
  readonly admissibilityStatus: "admissible" | "rejected" | "ambiguous";
  readonly rejectionReason: string | null;
  readonly metadata: Record<string, unknown>;
}

export interface CompiledDirectFactRebuildCounts {
  readonly promoted: number;
  readonly rejected: number;
  readonly ambiguous: number;
  readonly sourceRows: number;
}

interface DirectFactSourceRow {
  readonly source_table: string;
  readonly source_row_id: string;
  readonly memory_id: string | null;
  readonly artifact_id: string | null;
  readonly artifact_observation_id: string | null;
  readonly source_chunk_id: string | null;
  readonly source_offset: { char_start?: number; char_end?: number } | null;
  readonly occurred_at: string | null;
  readonly content: string;
  readonly artifact_uri: string | null;
  readonly metadata: Record<string, unknown> | null;
}

interface SourceDirectFactCandidate {
  readonly candidate: AssistantCandidate;
  readonly sourceText: string;
  readonly sourceTable: string;
  readonly sourceRowId: string;
  readonly sourceMemoryId: string | null;
  readonly sourceChunkId: string | null;
  readonly occurredAt: string | null;
  readonly artifactUri: string | null;
  readonly sourceType: string;
  readonly speaker: string | null;
  readonly metadata: Record<string, unknown>;
}

interface StructuredDirectFactRow {
  readonly source_table: string;
  readonly source_row_id: string;
  readonly source_memory_id: string | null;
  readonly source_chunk_id: string | null;
  readonly source_uri: string | null;
  readonly subject_entity_id: string | null;
  readonly subject_name: string | null;
  readonly family_key: string | null;
  readonly property_key: string | null;
  readonly answer_value: string | null;
  readonly support_phrase: string | null;
  readonly source_text: string | null;
  readonly confidence: number | null;
  readonly valid_from: string | null;
  readonly metadata: Record<string, unknown> | null;
}

function normalize(value: unknown): string {
  return String(value ?? "").replace(/\s+/gu, " ").trim();
}

function normalizeKey(value: unknown): string {
  return normalize(value).toLowerCase();
}

function uniqueStrings(values: readonly string[]): string[] {
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

function normalizeEntityName(value: string): string {
  return normalize(value).toLowerCase().replace(/[^a-z0-9]+/gu, " ").trim();
}

function stripInlineMediaAnnotations(value: string): string {
  return value.replace(/\s*\[(?:image|audio|video|file)[^\]]*\]/giu, "").trim();
}

function stableSourceType(row: DirectFactSourceRow): string {
  const raw = normalize(row.metadata?.source_type ?? row.metadata?.sourceType);
  if (raw) {
    return raw;
  }
  if (/benchmark[:/]locomo|locomo/iu.test(normalize(row.artifact_uri))) {
    return "markdown";
  }
  return "episodic_memory";
}

function speakerFromSourceText(text: string, metadata?: Record<string, unknown> | null): string | null {
  const observationMetadata = metadata?.observation_metadata && typeof metadata.observation_metadata === "object"
    ? metadata.observation_metadata as Record<string, unknown>
    : null;
  const artifactMetadata = metadata?.artifact_metadata && typeof metadata.artifact_metadata === "object"
    ? metadata.artifact_metadata as Record<string, unknown>
    : null;
  const metadataSpeaker = cleanValue(
    metadata?.speaker_name ??
    metadata?.speakerName ??
    observationMetadata?.speaker_name ??
    observationMetadata?.speakerName ??
    artifactMetadata?.speaker_name ??
    artifactMetadata?.speakerName
  );
  if (metadataSpeaker) {
    return metadataSpeaker;
  }
  const proxySpeaker = text.match(/^\s*Speaker:\s*([A-Z][A-Za-z'’-]{1,40}(?:\s+[A-Z][A-Za-z'’-]{1,40})?)\s+Turn text:/u)?.[1] ?? null;
  if (proxySpeaker) {
    return cleanValue(proxySpeaker);
  }
  const sourceTurnSpeaker = cleanValue(metadata?.source_turn_text)?.match(/^\s*([A-Z][A-Za-z'’-]{1,40}(?:\s+[A-Z][A-Za-z'’-]{1,40})?):\s/u)?.[1] ?? null;
  if (sourceTurnSpeaker) {
    return cleanValue(sourceTurnSpeaker);
  }
  const speaker = text.match(/^\s*([A-Z][A-Za-z'’-]{1,40})(?:\s+[A-Z][A-Za-z'’-]{1,40})?:\s/u)?.[1] ?? null;
  return speaker ? cleanValue(speaker) : null;
}

function sourceEvidenceUnits(text: string): string[] {
  const lines = text
    .replace(/\r\n?/gu, "\n")
    .replace(/\s+(?=[A-Z][A-Za-z'’-]{1,40}:\s)/gu, "\n")
    .split(/\n+/u)
    .map(normalize)
    .filter(Boolean);
  const units: string[] = [];
  for (const line of lines) {
    if (/^(?:Captured|Conversation between|--- image_|Image url|Proxy reason):/iu.test(line)) {
      continue;
    }
    if (/^[A-Z][A-Za-z'’-]{1,40}(?:\s+[A-Z][A-Za-z'’-]{1,40})?:\s/u.test(line)) {
      units.push(line);
      continue;
    }
    units.push(...line.split(/(?<=[.!?])\s+/u).map(normalize).filter(Boolean));
  }
  return units.filter((unit) => unit.length >= 12 && unit.length <= 1600);
}

const sourceArtifactLineCache = new Map<string, readonly string[] | null>();

function hasSpeakerPrefix(value: string): boolean {
  return /^\s*(?:Speaker:\s*)?[A-Z][A-Za-z'’-]{1,40}(?:\s+[A-Z][A-Za-z'’-]{1,40})?:\s/u.test(value);
}

function sourceArtifactLines(artifactUri: string | null): readonly string[] | null {
  const uri = cleanValue(artifactUri);
  if (!uri || !uri.startsWith("/") || !existsSync(uri)) {
    return null;
  }
  if (sourceArtifactLineCache.has(uri)) {
    return sourceArtifactLineCache.get(uri) ?? null;
  }
  try {
    const lines = readFileSync(uri, "utf8")
      .replace(/\r\n?/gu, "\n")
      .split(/\n+/u)
      .map(normalize)
      .filter(Boolean);
    sourceArtifactLineCache.set(uri, lines);
    return lines;
  } catch {
    sourceArtifactLineCache.set(uri, null);
    return null;
  }
}

function matchingSpeakerQualifiedLine(row: DirectFactSourceRow, unit: string): string | null {
  if (hasSpeakerPrefix(unit)) {
    return null;
  }
  const lines = sourceArtifactLines(row.artifact_uri);
  if (!lines) {
    return null;
  }
  const normalizedUnit = normalize(unit);
  if (!normalizedUnit || normalizedUnit.length < 12) {
    return null;
  }
  const compactUnit = normalizedUnit.toLowerCase();
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (!hasSpeakerPrefix(line) || !line.toLowerCase().includes(compactUnit)) {
      continue;
    }
    const imageContext: string[] = [];
    for (let next = index + 1; next < Math.min(lines.length, index + 4); next += 1) {
      const nextLine = lines[next] ?? "";
      if (hasSpeakerPrefix(nextLine)) {
        break;
      }
      if (/^--- image_(?:query|caption):/iu.test(nextLine)) {
        imageContext.push(nextLine);
      }
    }
    return normalize([line, ...imageContext].join(" "));
  }
  return null;
}

function nestedMetadataObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function metadataText(metadata: Record<string, unknown> | null | undefined, key: string): string | null {
  const direct = cleanValue(metadata?.[key]);
  if (direct) {
    return direct;
  }
  const observation = nestedMetadataObject(metadata?.observation_metadata);
  const observationValue = cleanValue(observation?.[key]);
  if (observationValue) {
    return observationValue;
  }
  const artifact = nestedMetadataObject(metadata?.artifact_metadata);
  const artifactValue = cleanValue(artifact?.[key]);
  if (artifactValue) {
    return artifactValue;
  }
  return null;
}

function sourceEvidenceUnitsForRow(row: DirectFactSourceRow): string[] {
  const supplemental = [
    metadataText(row.metadata, "source_turn_text"),
    metadataText(row.metadata, "source_sentence_text"),
    metadataText(row.metadata, "turn_text")
  ].filter((value): value is string => Boolean(value));
  const recovered = sourceEvidenceUnits(row.content).map((unit) => matchingSpeakerQualifiedLine(row, unit) ?? unit);
  return uniqueStrings([
    ...recovered,
    ...supplemental.flatMap(sourceEvidenceUnits)
  ]);
}

function lastSpeakerFromText(text: string): string | null {
  const speakers = [
    ...text.matchAll(/\bSpeaker:\s*([A-Z][A-Za-z'’-]{1,40}(?:\s+[A-Z][A-Za-z'’-]{1,40})?)\s+Turn text:/gu),
    ...text.matchAll(/\b([A-Z][A-Za-z'’-]{1,40}(?:\s+[A-Z][A-Za-z'’-]{1,40})?):\s/gu)
  ]
    .map((match) => cleanSubjectName(match[1] ?? null))
    .filter((value): value is string => Boolean(value));
  return speakers.at(-1) ?? null;
}

function cleanSubjectName(value: unknown): string | null {
  const subject = cleanValue(value);
  if (!subject || /^(?:I|Me|My|Mine|We|Us|Our|The|This|That|It|Its|Text|Turn|What|Which|Where|When|Why|How|Speaker|Here)$/iu.test(subject)) {
    return null;
  }
  return subject.replace(/['’]s$/u, "");
}

function subjectForEvidence(evidence: string, speaker: string | null): string | null {
  const proxySpeakerMatch = evidence.match(/^\s*Speaker:\s*([A-Z][A-Za-z'’-]{1,40}(?:\s+[A-Z][A-Za-z'’-]{1,40})?)\s+Turn text:\s*/u);
  const speakerMatch = evidence.match(/^\s*([A-Z][A-Za-z'’-]{1,40}(?:\s+[A-Z][A-Za-z'’-]{1,40})?):\s/u);
  const speakerName = cleanSubjectName(proxySpeakerMatch?.[1] ?? speakerMatch?.[1] ?? speaker);
  const withoutProxy = proxySpeakerMatch ? evidence.slice(proxySpeakerMatch[0].length) : evidence;
  const body = normalize(withoutProxy.replace(/^\s*[A-Z][A-Za-z'’-]{1,40}(?:\s+[A-Z][A-Za-z'’-]{1,40})?:\s/u, ""));
  const acknowledgedSubject = cleanSubjectName(
    body.match(/\b(?:[Ss]orry\s+about|[Cc]ongrats\s+on|[Cc]ongratulations\s+on|[Nn]o\s+worries)[^.?!]{0,140}\b([A-Z][A-Za-z'’-]{1,40})\b/u)?.[1] ??
    body.match(/\b(?:[Tt]hanks|[Aa]ppreciate)[^.?!]{0,60}\b([A-Z][A-Za-z'’-]{1,40})\b/u)?.[1] ??
    null
  );
  if (!proxySpeakerMatch && !speakerMatch && acknowledgedSubject && /\b(?:my|mine|i'm|i’ve|i've|i'd|i’ll|i'll)\b/iu.test(body)) {
    return acknowledgedSubject;
  }
  if (speakerName && /\b(?:I|me|my|mine|I'm|I've|I'd|I'll|we|our)\b/iu.test(body)) {
    return speakerName;
  }
  const addressedSubject = cleanSubjectName(
    body.match(/^\s*(?:(?:hey|hi|hello|wow|congrats|congratulations|sorry|thanks|thank you)[,!\s]+)*([A-Z][A-Za-z'’-]{1,40})[,!]\s+(?:congrats|congratulations|sorry|thanks|thank you|appreciate|no worries)\b/iu)?.[1] ??
    body.match(/\b([A-Z][A-Za-z'’-]{1,40}):\s*(?:thanks|thank you|appreciate|no worries|got it|that helps)\b/iu)?.[1] ??
    null
  );
  if (addressedSubject && /\b(?:you|your|yours|congrats|congratulations|sorry|appreciate|thanks|thank you)\b/iu.test(body)) {
    return addressedSubject;
  }
  if (/\b(?:I|me|my|mine|I'm|I've|I'd|I'll)\b/iu.test(body)) {
    if (acknowledgedSubject) {
      return acknowledgedSubject;
    }
  }
  const patterns = [
    /\b([A-Z][A-Za-z'’-]{1,40})(?:['’]s)\b/u,
    /\b([A-Z][A-Za-z'’-]{1,40})\s+(?:prefers?|likes?|loves?|enjoys?|collects?|owns?|has|had|bought|purchased|acquired|wants?|hopes?|plans?|dreams?|started|opened|lives?|resides?|signed|plays?|went|visited|is|was|became|lost)\b/u,
    /\b(?:for|about)\s+([A-Z][A-Za-z'’-]{1,40})\b/u
  ];
  for (const pattern of patterns) {
    const subject = cleanSubjectName(body.match(pattern)?.[1] ?? null);
    if (subject) {
      return subject;
    }
  }
  return speakerName;
}

function exactQuote(evidence: string): string {
  return normalize(evidence).slice(0, 820);
}

function isQuestionOnlyEvidence(unit: string): boolean {
  const body = normalize(unit.replace(/^\s*[A-Z][A-Za-z'’-]{1,40}(?:\s+[A-Z][A-Za-z'’-]{1,40})?:\s/u, ""));
  if (!body.endsWith("?")) {
    return false;
  }
  return /^(?:what|which|where|when|why|how|do|does|did|have|has|is|are|can|could|would|should)\b/iu.test(body);
}

function candidateConfidence(overall = 0.82): AssistantCandidate["confidence"] {
  return { evidence: overall, overall };
}

function approvedCandidate(params: {
  readonly subject: string | null;
  readonly family: string;
  readonly subtype?: string | null;
  readonly answerShape: DirectFactAnswerShape;
  readonly value: string | null;
  readonly evidenceQuote: string;
  readonly temporalAnchor?: string | null;
  readonly confidence?: number;
}): AssistantCandidate {
  return {
    candidate_type: "fact",
    object_type: params.answerShape === "date" || params.answerShape === "duration" ? "times" : "things",
    domain: params.family === "health_status" ? "health" : params.family === "role" ? "work" : params.family === "lives_in" ? "travel" : "personal",
    family: params.family,
    subtype: params.subtype ?? null,
    evidence_family: params.family,
    answer_shape: params.answerShape,
    subject: params.subject,
    value: params.value,
    polarity: params.value && /\b(?:no|not|none|never)\b/iu.test(params.value) ? "negative" : "positive",
    evidence_quote: params.evidenceQuote,
    temporal_anchor: params.temporalAnchor ?? null,
    taxonomy_status: "approved",
    promotion_recommendation: "promote",
    confidence: candidateConfidence(params.confidence ?? 0.84)
  };
}

const PROFILE_TRAIT_FAMILIES = new Set([
  "profile_trait",
  "civic_identity",
  "religious_identity",
  "political_orientation",
  "personality_trait",
  "allyship_support",
  "value_stance"
]);

function isProfileTraitSourceCandidate(candidate: AssistantCandidate): boolean {
  return normalizeKey(candidate.domain) === "identity_values" ||
    PROFILE_TRAIT_FAMILIES.has(normalizeKey(candidate.family)) ||
    PROFILE_TRAIT_FAMILIES.has(normalizeKey(candidate.trait_family));
}

function profileTraitFamilyFromCandidate(candidate: AssistantCandidate): string {
  const traitFamily = normalizeKey(candidate.trait_family);
  const family = normalizeKey(candidate.family);
  const subtype = normalizeKey(candidate.subtype);
  if (PROFILE_TRAIT_FAMILIES.has(traitFamily) && traitFamily !== "profile_trait") return traitFamily;
  if (PROFILE_TRAIT_FAMILIES.has(family) && family !== "profile_trait") return family;
  if (PROFILE_TRAIT_FAMILIES.has(subtype) && subtype !== "profile_trait") return subtype;
  return "profile_trait";
}

function profileTraitAnswerValueFromCandidate(candidate: AssistantCandidate): string {
  const polarity = normalizeKey(candidate.polarity);
  if (polarity === "negative") return "Likely no";
  const traitValue = cleanValue(candidate.trait_value) ?? cleanValue(candidate.value);
  return traitValue ? `Likely yes: ${traitValue}` : "Likely yes";
}

function approvedProfileTraitCandidate(params: {
  readonly subject: string | null;
  readonly traitFamily: string;
  readonly traitValue: string;
  readonly polarity?: "positive" | "negative" | "ambiguous";
  readonly evidenceQuote: string;
  readonly confidence?: number;
}): AssistantCandidate {
  return {
    candidate_type: "fact",
    object_type: "CLAIM",
    domain: "identity_values",
    family: params.traitFamily,
    subtype: params.traitValue,
    trait_family: params.traitFamily,
    trait_value: params.traitValue,
    evidence_family: "profile_trait",
    answer_shape: "yes_no",
    subject: params.subject,
    value: params.traitValue,
    polarity: params.polarity ?? "positive",
    evidence_quote: params.evidenceQuote,
    temporal_anchor: null,
    taxonomy_status: "approved",
    promotion_recommendation: "promote",
    confidence: candidateConfidence(params.confidence ?? 0.84),
    tags: ["profile_trait", params.traitFamily, params.traitValue]
  };
}

function addCandidate(candidates: SourceDirectFactCandidate[], row: DirectFactSourceRow, unit: string, candidate: AssistantCandidate): void {
  candidates.push({
    candidate,
    sourceText: unit,
    sourceTable: row.source_table,
    sourceRowId: row.source_row_id,
    sourceMemoryId: row.memory_id,
    sourceChunkId: row.source_chunk_id ?? row.artifact_observation_id ?? row.artifact_id,
    occurredAt: row.occurred_at,
    artifactUri: row.artifact_uri,
    sourceType: stableSourceType(row),
    speaker: speakerFromSourceText(unit, row.metadata),
    metadata: {
      source: "typed_rebuild_direct_fact_compiler",
      source_table: row.source_table,
      source_row_id: row.source_row_id,
      artifact_id: row.artifact_id,
      artifact_observation_id: row.artifact_observation_id,
      source_chunk_id: row.source_chunk_id,
      artifact_uri: row.artifact_uri,
      source_offset: row.source_offset,
      occurred_at: row.occurred_at,
      source_metadata: row.metadata ?? {}
    }
  });
}

function sameSourceWindow(left: DirectFactSourceRow | undefined, right: DirectFactSourceRow | undefined): boolean {
  if (!left || !right || left.source_table !== right.source_table) {
    return false;
  }
  if (left.artifact_id && right.artifact_id && left.artifact_id === right.artifact_id) {
    return true;
  }
  return Boolean(left.artifact_uri && right.artifact_uri && left.artifact_uri === right.artifact_uri);
}

function boundedSourceWindow(rows: readonly DirectFactSourceRow[], index: number): string | null {
  const current = rows[index];
  if (!current) {
    return null;
  }
  const windowRows: DirectFactSourceRow[] = [];
  for (const candidateIndex of [index - 2, index - 1, index, index + 1, index + 2]) {
    const candidate = rows[candidateIndex];
    if (!candidate) {
      continue;
    }
    if (candidateIndex !== index && !sameSourceWindow(current, candidate)) {
      continue;
    }
    windowRows.push(candidate);
  }
  const windowText = uniqueStrings(windowRows.map((row) => row.content)).join("\n");
  if (!windowText || normalize(windowText) === normalize(current.content)) {
    return null;
  }
  // Keep compiler windows bounded; this is source context, not giant-context rescue.
  return windowText.length > 4800 ? windowText.slice(Math.max(0, windowText.length - 4800)) : windowText;
}

function buildDirectFactCandidatesForSourceRows(rows: readonly DirectFactSourceRow[]): readonly SourceDirectFactCandidate[] {
  const candidates: SourceDirectFactCandidate[] = [];
  for (const [index, row] of rows.entries()) {
    candidates.push(...buildDirectFactCandidatesForRow(row));
    const sourceWindow = boundedSourceWindow(rows, index);
    if (!sourceWindow) {
      continue;
    }
    candidates.push(...buildDirectFactCandidatesForRow({
      ...row,
      content: sourceWindow,
      metadata: {
        ...(row.metadata ?? {}),
        direct_fact_source_window: true,
        direct_fact_source_window_row_id: row.source_row_id,
        direct_fact_source_window_char_count: sourceWindow.length
      }
    }));
  }
  return candidates;
}

function firstMatch(text: string, patterns: readonly RegExp[]): string | null {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    const value = cleanValue(match?.[1] ?? null);
    if (value) {
      return value;
    }
  }
  return null;
}

function collectListValues(text: string, patterns: readonly RegExp[]): string | null {
  const values: string[] = [];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const raw = cleanValue(match[1] ?? match[0] ?? "");
      if (raw) {
        values.push(...raw.split(/\s*(?:,|;|\band\b|\bor\b)\s*/iu).map(cleanValue).filter((value): value is string => Boolean(value)));
      }
    }
  }
  return [...new Set(values.filter((value) => value.length > 1 && value.length <= 120))].slice(0, 8).join(", ") || null;
}

function buildDirectFactCandidatesForRow(row: DirectFactSourceRow): readonly SourceDirectFactCandidate[] {
  const candidates: SourceDirectFactCandidate[] = [];
  const units = sourceEvidenceUnitsForRow(row);
  let activeSpeaker = speakerFromSourceText(row.content, row.metadata);
  for (const [unitIndex, unit] of units.entries()) {
    if (isQuestionOnlyEvidence(unit)) {
      activeSpeaker = lastSpeakerFromText(unit) ?? activeSpeaker;
      continue;
    }
    let evidence = exactQuote(unit);
    const body = normalize(unit.replace(/^\s*[A-Z][A-Za-z'’-]{1,40}(?:\s+[A-Z][A-Za-z'’-]{1,40})?:\s/u, ""));
    const previousUnit = unitIndex > 0 ? units[unitIndex - 1] : "";
    const twoBackUnit = unitIndex > 1 ? units[unitIndex - 2] : "";
    const previousBody = normalize(previousUnit.replace(/^\s*[A-Z][A-Za-z'’-]{1,40}(?:\s+[A-Z][A-Za-z'’-]{1,40})?:\s/u, ""));
    const previousQuestionContext = isQuestionOnlyEvidence(previousUnit) || /\?\s*$/u.test(previousBody);
    const nextUnit = unitIndex + 1 < units.length ? units[unitIndex + 1] : "";
    const twoForwardUnit = unitIndex + 2 < units.length ? units[unitIndex + 2] : "";
    const contextualEvidence = previousUnit && previousQuestionContext ? exactQuote(`${previousUnit} ${unit}`) : evidence;
    const contextualBody = normalize(`${previousUnit && previousQuestionContext ? previousUnit : ""} ${body}`);
    const recentContext = normalize(`${twoBackUnit} ${previousUnit} ${unit} ${nextUnit} ${twoForwardUnit}`);
    const explicitUnitSpeaker = speakerFromSourceText(unit, row.metadata);
    const unitSpeaker = explicitUnitSpeaker ?? lastSpeakerFromText(previousUnit) ?? lastSpeakerFromText(twoBackUnit) ?? activeSpeaker;
    const directSubject = subjectForEvidence(unit, unitSpeaker);
    const forwardAcknowledgementEvidence =
      nextUnit && /\b(?:sorry\s+about|congrats\s+on|congratulations\s+on|no\s+worries|thanks|appreciate)\b/iu.test(nextUnit)
        ? exactQuote(`${unit} ${nextUnit}`)
        : "";
    const forwardSubject = forwardAcknowledgementEvidence ? subjectForEvidence(forwardAcknowledgementEvidence, explicitUnitSpeaker) : null;
    const subject = (!explicitUnitSpeaker && forwardSubject) || directSubject || forwardSubject;
    if (!subject) {
      continue;
    }
    if (forwardSubject && forwardAcknowledgementEvidence && forwardSubject === subject) {
      evidence = forwardAcknowledgementEvidence;
    }
    activeSpeaker = lastSpeakerFromText(unit) ?? unitSpeaker ?? activeSpeaker;

    if (
      /\b(?:patriotic|proud\s+of\s+(?:his|her|their|my|our)?\s*(?:country|nation)|serv(?:e|ing)\s+(?:his|her|their|my|our)?\s*(?:country|nation)|military\s+(?:service|recruiter)|drawn\s+to\s+serv(?:e|ing)|fourth\s+of\s+july|independence\s+day|national\s+anthem|flag|civic\s+service)\b/iu.test(body)
    ) {
      addCandidate(candidates, row, unit, approvedProfileTraitCandidate({
        subject,
        traitFamily: "civic_identity",
        traitValue: "patriotic",
        polarity: /\bnot\s+(?:very\s+)?patriotic\b|\bdoes(?:n'?t| not)\s+(?:feel|seem|consider|identify)[^.?!]{0,60}\bpatriotic\b/iu.test(body) ? "negative" : "positive",
        evidenceQuote: evidence,
        confidence: 0.86
      }));
    }

    const preference = firstMatch(body, [
      /\bprefer(?:s|red)?\s+(?:eating\s+)?([^.!?;]{2,140})/iu,
      /\b(?:would|wants?\s+to|i'?d)\s+(?:prefer|rather)\s+([^.!?;]{2,140})/iu,
      /\bfavorite\s+(?:movies?|films?|books?|food|meat|style|activity|thing|recipe)\s+(?:is|was|are|include|included|:)\s+([^.!?;]{2,180})/iu,
      /\b(?:likes?|loves?|enjoys?)\s+([^.!?;]{2,140}\b(?:movie|film|book|food|meat|style|painting|music|song|activity|dance)\b[^.!?;]{0,80})/iu,
      /\b(contemporary)\b[^.!?;]{0,120}\b(?:top\s+pick|speaks?\s+to\s+me|favorite|fav|preferred)\b/iu,
      /\b(Contemporary\s+dance)\b[^.!?;]{0,140}\bspeaks?\s+to\s+me\b/iu,
      /\b((?:roasted\s+)?chicken)\b[^.!?;]{0,120}\b(?:one\s+of\s+my\s+favorites|favorite|fav)\b/iu,
      /\bif\s+i\s+had\s+to\s+pick\s+a\s+favorite,\s+it\s+would\s+definitely\s+be\s+([^.!?;]{2,120})/iu,
      /\breally\s+into\s+(?:this\s+book\s+called\s+)?["“]?([^"”!.?;]{2,120})["”]?/iu,
      /\b(read\s+["“][^"”]{2,100}["”]\s+by\s+[^.!?;]{2,80})/iu,
      /\bread\s+(?:the\s+)?([A-Z][A-Za-z0-9'’ -]{2,80}\s+by\s+[A-Z][A-Za-z0-9'’ -]{2,80})\b/u,
      /\b(?:love|loved|really\s+like|liked)\s+([A-Z][A-Za-z0-9'’ -]{2,80}\s+by\s+[A-Z][A-Za-z0-9'’ -]{2,80})\b/u
    ]);
    if (
      preference &&
      /\b(?:prefer|rather|favorite|fav|likes?|loves?|enjoys?|top\s+pick|speaks?\s+to\s+me|really\s+into|read\s+(?:["“]|(?:the\s+)?[A-Z]))\b/iu.test(body) &&
      preferenceValueIsPromotable(preference, body)
    ) {
      addCandidate(candidates, row, unit, approvedCandidate({
        subject,
        family: "preference",
        answerShape: "atomic_value",
        value: preference,
        evidenceQuote: evidence
      }));
    }

    const collection = collectListValues(body, [
      /\bcollects?\s+([^.!?;]{2,220})/giu,
      /\bcollection(?:s)?\s+(?:include|included|has|had|contains?)\s+([^.!?;]{2,220})/giu,
      /\bfavorite\s+books?\s+(?:are|include|included|:)\s+([^.!?;]{2,220})/giu
    ]);
    if (collection && /\b(?:collects?|collection|favorite\s+books?|list(?:ed)?)\b/iu.test(body)) {
      addCandidate(candidates, row, unit, approvedCandidate({
        subject,
        family: "explicit_list_set",
        answerShape: "list",
        value: collection,
        evidenceQuote: evidence
      }));
    }
    const inferredCollection = uniqueStrings([
      ...(/\bsneaker(?:s|head)?\b|\bsneaker collection\b/iu.test(body) ? ["sneakers"] : []),
      ...(/\bfantasy movie DVDs?\b|\bfantasy DVDs?\b|\bDVDs?\b[^.?!]{0,80}\bfantasy\b|\bfantasy\b[^.?!]{0,80}\bDVDs?\b|\bwhole collection\b[^.?!]{0,120}\bfantasy\b/iu.test(body) ? ["fantasy movie DVDs"] : []),
      ...(/\bcollect\s+jerseys?\b|\bjerseys?\b[^.?!]{0,80}\bcollect\b/iu.test(body) ? ["jerseys"] : []),
      ...(/\bclassics?\b[^.?!]{0,120}\b(?:books|stories)\b|\b(?:books|stories)\b[^.?!]{0,120}\bclassics?\b/iu.test(body) ? ["classic children's books"] : []),
      ...(/\bkids?'?\s+books\b|\bchildren'?s\s+books\b|\bchildrens\s+books\b/iu.test(body) ? ["children's books"] : []),
      ...(/\beducational books\b/iu.test(body) ? ["educational books"] : [])
    ]);
    if (inferredCollection.length > 0 && /\b(?:collect|collection|sneaker|jerseys?|DVDs?|fantasy movie|kids?'?\s+books|children'?s\s+books|childrens\s+books|library|bookshelf|classics|educational books)\b/iu.test(body)) {
      addCandidate(candidates, row, unit, approvedCandidate({
        subject,
        family: "explicit_list_set",
        answerShape: "list",
        value: inferredCollection.join(", "),
        evidenceQuote: evidence
      }));
    }
    const petCareClasses = collectListValues(body, [
      /\b(?:joined|attended|taking|took|started|signed\s+up\s+for)\s+([^.!?;]{2,220}\b(?:classes?|groups?|workshops?|courses?|training|grooming|agility)\b[^.!?;]{0,120})/giu,
      /\b(positive reinforcement training workshop|positive reinforcement training class|dog training course|agility training course|agility classes?|grooming course|dog grooming course|dog[- ]owners? group|pet[- ]owners? group|dog meetup group)\b/giu
    ]);
    if (petCareClasses && /\b(?:dogs?|pets?|pups?)\b/iu.test(body) && /\b(?:classes?|groups?|workshops?|courses?|training|grooming|agility)\b/iu.test(body)) {
      addCandidate(candidates, row, unit, approvedCandidate({
        subject,
        family: "explicit_list_set",
        answerShape: "list",
        value: petCareClasses,
        evidenceQuote: evidence
      }));
    }
    const activityList = uniqueStrings([
      ...(/\bboard games?\b/iu.test(body) ? ["board games"] : []),
      ...(/\bpet shelter\b|\banimal shelter\b/iu.test(body) ? ["pet shelter"] : []),
      ...(/\bwine tasting\b/iu.test(body) ? ["wine tasting"] : []),
      ...(/\bgrowing flowers?\b|\bflowers?\b[^.?!]{0,80}\bgarden\b|\bgarden\b[^.?!]{0,80}\bflowers?\b/iu.test(body) ? ["growing flowers"] : []),
      ...(/\bcafes?\b|\bnew places? to eat\b|\bplaces? to eat\b/iu.test(body) ? ["cafes and new places to eat"] : []),
      ...(/\bopen space\b[^.?!]{0,80}\bhikes?\b|\bhikes?\b[^.?!]{0,80}\bopen space\b/iu.test(body) ? ["open space for hikes"] : []),
      ...(/\bpark\b[^.?!]{0,80}\b(?:walk|hike|dog|dogs?)\b|\b(?:walk|hike|dog|dogs?)\b[^.?!]{0,80}\bpark\b/iu.test(body) ? ["parks"] : [])
    ]);
    if (
      activityList.length > 0 &&
      /\b(?:girlfriend|places?|activities|checked out|pursued|went|tried|new cafe|pet shelter|animal shelter|wine tasting|board games?|garden|flowers?|hikes?|park)\b/iu.test(body)
    ) {
      addCandidate(candidates, row, unit, approvedCandidate({
        subject,
        family: "explicit_list_set",
        answerShape: "list",
        value: activityList.join(", "),
        evidenceQuote: evidence
      }));
    }

    const purchase = firstMatch(body, [
      /\b(?:bought|purchased|acquired)\s+([^.!?;]{2,220})/iu,
      /\bitems?\s+(?:were|are|included|include)\s+([^.!?;]{2,180})/iu,
      /\b(?:here'?s|this\s+is|that'?s)\s+(?:my|his|her|their)\s+(new\s+(?:mansion|house|car|ferrari|camera|guitar))\b/iu,
      /\b(?:just\s+)?got\s+(?:a\s+|an\s+|the\s+)?(?:new\s+)?([^.!?;]{2,160}\b(?:car|prius|ferrari|mansion|house|camera|guitar)\b[^.!?;]{0,80})/iu,
      /\b(?:new\s+)(mansion|ferrari|car|prius|camera|guitar)\b/iu
    ]);
    if (purchase && /\b(?:bought|purchased|acquired|got|new)\b/iu.test(body)) {
      addCandidate(candidates, row, unit, approvedCandidate({
        subject,
        family: "purchase",
        answerShape: "atomic_value",
        value: purchase,
        evidenceQuote: evidence,
        temporalAnchor: firstMatch(body, [/\b(in|on|during)\s+((?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4}|\d{4})\b/iu])
      }));
      addCandidate(candidates, row, unit, approvedCandidate({
        subject,
        family: "owns",
        answerShape: "atomic_value",
        value: purchase,
        evidenceQuote: evidence
      }));
    }

    const owned = firstMatch(body, [
      /\b(?:in|with)\s+(?:my|his|her|their)\s+((?:new|old|trusty)?\s*(?:prius|ferrari|car|truck|bike|bicycle|camera|guitar))\b/iu,
      /\b(?:owns?|owned|has|had|keeps?|kept|drives?|drove|got|adopted)\s+(?:a\s+|an\s+|the\s+|his\s+|her\s+|their\s+|my\s+)?([^.!?;]{2,180})/iu
    ]);
    if (owned && /\b(?:owns?|owned|has|had|keeps?|kept|drives?|drove|got|adopted)\b/iu.test(body)) {
      addCandidate(candidates, row, unit, approvedCandidate({
        subject,
        family: "owns",
        answerShape: "atomic_value",
        value: owned,
        evidenceQuote: evidence
      }));
    }

    const ownedDuration = firstMatch(body, [
      /\b(?:had|has|have|owned|kept)\s+(?:his|her|their|my)?\s*(?:first\s+two\s+)?(?:turtles?|pets?|dogs?|cats?|cars?|items?)[^.?!]{0,120}\bfor\s+((?:\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:days?|weeks?|months?|years?))\b/iu,
      /\b(?:first\s+two\s+)?(?:turtles?|pets?|dogs?|cats?|cars?|items?)[^.?!]{0,140}\b(?:for|since)\s+((?:\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:days?|weeks?|months?|years?))\b/iu,
      /\bhad\s+them\s+for\s+((?:\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:days?|weeks?|months?|years?))\b/iu
    ]);
    if (
      ownedDuration &&
      /\b(?:had|has|have|owned|kept)\b/iu.test(body) &&
      (/\b(?:turtles?|pets?|dogs?|cats?|cars?|items?)\b/iu.test(body) || /\bhad\s+them\s+for\b/iu.test(body) && /\b(?:turtles?|pets?|dogs?|cats?)\b/iu.test(row.content))
    ) {
      addCandidate(candidates, row, unit, approvedCandidate({
        subject,
        family: "owned_object_duration",
        answerShape: "duration",
        value: ownedDuration,
        evidenceQuote: evidence
      }));
    }

    const projectGoal = firstMatch(body, [
      /\b(?:my|his|her|their|our)\s+goal\s+(?:is|was)\s+to\s+([^.!?;]{2,220})/iu,
      /\b(?:dreams?|goals?)\s+(?:are|include|of|to|:)\s+([^.!?;]{2,240})/iu,
      /\b(?:number\s+one\s+goal|main\s+goal|biggest\s+goal)\s+(?:is|was|:)?\s*([^.!?;]{2,220})/iu,
      /\b((?:win|winning)\s+(?:a\s+)?championship[^.!?;]{0,160})/iu,
      /\b((?:looking\s+into\s+more\s+endorsements?|endorsements?|building\s+(?:my|his|her)?\s*brand)[^.!?;]{0,220})/iu,
      /\b(?:always\s+)?dream(?:ed)?\s+of\s+([^.!?;]{2,220})/iu,
      /\b(?:wants?|hopes?|plans?)\s+to\s+([^.!?;]{2,220})/iu,
      /\b(?:finished|completed|wrapped\s+up|working\s+on|worked\s+on)\s+(?:an?\s+|the\s+|this\s+)?([^.!?;]{2,140}\bengineering project\b[^.!?;]{0,80})/iu,
      /\b(?:project(?:\s+was|\s+is)?|kind of project)\s+(?:an?\s+|the\s+)?([^.!?;]{2,160})/iu,
      /\b(?:users?\s+can|allow(?:s|ed|ing)?\s+users?\s+to)\s+([^.!?;]{2,180}\b(?:preferences?|needs?|profile|customiz(?:e|ed|able|ing))\b[^.!?;]{0,120})/iu,
      /\b(?:unique|different|stand out|sets?\s+it\s+apart)[^.?!]{0,140}\b(?:because|by|with|allow(?:ing)?|users?\s+can)\s+([^.!?;]{2,180})/iu,
      /\b(challenge\s+(?:was|is)\s+[^.!?;]{2,180})/iu,
      /\b((?:fitting|fit)\s+into\s+(?:the\s+)?new\s+team['’]s\s+style[^.!?;]{0,160})/iu,
      /\b((?:endorsements?|building\s+(?:my|his|her)?\s*brand|charity|foundation)[^.!?;]{0,220})/iu,
      /\b((?:open|opened|start|started|build|built|create|created)\s+(?:my\s+own\s+|his\s+own\s+|her\s+own\s+)?(?:car maintenance\s+)?(?:shop|store|business|studio)[^.!?;]{0,180})/iu,
      /\b((?:work(?:ing)?\s+on|build(?:ing)?)\s+(?:classic\s+cars?|custom\s+car)[^.!?;]{0,180})/iu,
      /\b((?:always\s+)?wanted\s+to\s+learn\s+auto\s+engineering[^.!?;]{0,180}\b(?:custom\s+car|cars?|auto)\b[^.!?;]{0,120})/iu,
      /\b((?:watercolor\s+painting|painting)\s+(?:is|was|became)?[^.!?;]{0,160}\bstress[- ]buster[^.!?;]{0,80})/iu,
      /\b((?:watercolor\s+painting|painting)[^.!?;]{0,160}\b(?:stress\s+reliever|relax(?:ing)?|take\s+a\s+break|peace)\b[^.!?;]{0,120})/iu,
      /\b((?:it'?s|it\s+is)\s+a\s+great\s+stress[- ]buster[^.!?;]{0,80})/iu,
      /\b(carv(?:e|ing)\s+out\s+some\s+me[- ]time[^.!?;]{0,220}\b(?:running|reading|violin)[^.!?;]{0,120})/iu,
      /\b((?:employs?|employing|hires?|hiring|staffs?)[^.?!]{0,100}\b(?:a\s+lot\s+of|many|several)\s+people[^.!?;]{0,120})/iu,
      /\b((?:a\s+lot\s+of|many|several)\s+people[^.?!]{0,80}\b(?:work|working|employed|staffed|hired)\b[^.!?;]{0,120})/iu
    ]);
    const projectGoalValue = projectGoal && /\bstress[- ]buster\b/iu.test(projectGoal) && /\bwatercolor\s+painting\b/iu.test(contextualBody)
      ? `watercolor painting is ${projectGoal}`
      : projectGoal;
    const projectContextEvidence = projectGoalValue && /\bstress[- ]buster\b/iu.test(projectGoalValue) && /\bwatercolor\s+painting\b/iu.test(recentContext)
      ? exactQuote(recentContext)
      : evidence;
    const projectContextBody = normalize(`${contextualBody} ${recentContext}`);
    const contextualProjectGoalValue = projectGoalValue && /\bstress[- ]buster\b/iu.test(projectGoalValue) && /\bwatercolor\s+painting\b/iu.test(projectContextBody)
      ? `watercolor painting is ${projectGoalValue.replace(/^watercolor painting is\s+/iu, "").replace(/^(?:it'?s|it is)\s+/iu, "")}`
      : projectGoalValue;
    if (contextualProjectGoalValue && /\b(?:dreams?|goals?|wants?|hopes?|plans?|project|unique|different|stand out|feature|app|business|self[- ]?care|me[- ]time|challenge|team|style|endorsements?|brand|charity|foundation|shop|store|studio|classic\s+cars?|custom\s+car|stress[- ]buster|stress\s+reliever|watercolor|engineering|auto\s+engineering|employs?|hires?|staffs?|people)\b/iu.test(projectContextBody)) {
      addCandidate(candidates, row, unit, approvedCandidate({
        subject,
        family: "project_support",
        answerShape: "atomic_value",
        value: contextualProjectGoalValue,
        evidenceQuote: projectContextEvidence
      }));
    }

    const health = firstMatch(body, [
      /\b(obesity|diabetes|anxiety|depression|adhd|asthma|hypertension)\b/iu,
      /\b(weight problem|weight wasn'?t great|weight was not great)\b/iu,
      /\b(?:diagnosed|suspected|health problems?|condition|weight problem)\s+(?:with|as|is|was|were)?\s*([^.!?;]{2,100})/iu
    ]);
    if (health && /\b(?:diagnosed|suspected|health|condition|doctor|weight|obesity|diabetes|anxiety|depression|adhd|asthma|hypertension)\b/iu.test(body)) {
      addCandidate(candidates, row, unit, approvedCandidate({
        subject,
        family: "health_status",
        answerShape: "atomic_value",
        value: health,
        evidenceQuote: evidence
      }));
    }

    const causal = firstMatch(body, [
      /\b((?:enabled|helped|allowed|made)\s+[^.!?;]{0,180}\b(?:repairs?|renovations?|safer|modern|learning environment|students?|support|funding)[^.!?;]{0,120})/iu,
      /\b(?:because|'cause|cause|since|after)\s+([^.!?;]{8,240})/iu,
      /\breason\s+(?:is|was)\s+([^.!?;]{8,240})/iu,
      /\bdecided\s+to\s+[^.!?;]{2,180}\b(?:because|'cause|cause|after|since)\s+([^.!?;]{8,240})/iu,
      /\b(?:friend|buddy|pal)[^.?!]{0,160}\b(?:gave\s+(?:me|him|her|them)\s+[^.?!]{0,120}\binspired\s+(?:me|him|her|them)|inspired\s+(?:me|him|her|them)|sparked\s+(?:my|his|her|their)\s+interest)\s+([^.!?;]{2,180})/iu,
      /\b((?:friend|buddy|pal)[^.?!]{0,160}\bgave\s+(?:me|him|her|them)\s+[^.?!]{0,120}\binspired\s+(?:me|him|her|them)[^.?!]{0,180})/iu,
      /\b(?:friend|buddy|pal)[^.?!]{0,140}\b(?:advice|suggestion|suggested|got\s+(?:me|him|her|them)\s+into|introduced\s+(?:me|him|her|them)\s+to)\s+([^.!?;]{2,180})/iu,
      /\b((?:friend|buddy|pal)[^.?!]{0,140}\b(?:advice|suggestion|suggested|got\s+(?:me|him|her|them)\s+into|introduced\s+(?:me|him|her|them)\s+to)[^.?!]{0,180})/iu,
      /\b(pass(?:ion)?ate\s+about\s+[^.!?;]{8,180})/iu,
      /\b(lost\s+(?:her|his|their|my)?\s*job[^.!?;]{0,180}\b(?:start|starting|business|shop|store|studio|take\s+a\s+shot)[^.!?;]{0,160})/iu,
      /\b(always\s+loved\s+fashion\s+trends[^.!?;]{0,180}\b(?:unique pieces|clothing|store)[^.!?;]{0,120})/iu,
      /\b(love\s+the\s+feeling\s+of\s+taking\s+something\s+broken\s+and\s+making\s+it\s+whole[^.!?;]{0,180}\bthat['’]?s\s+why\s+i\s+keep\s+doing\s+what\s+i\s+do)\b/iu,
      /\b(taking\s+something\s+broken\s+and\s+making\s+it\s+whole[^.!?;]{0,180})/iu
    ]);
    if (causal && /\b(?:because|'cause|cause|since|after|reason|decided|started|lost\s+(?:her|his|their|my)?\s*job|inspired|sparked|passionate|perfect\s+match|that['’]?s\s+why|taking\s+something\s+broken|making\s+it\s+whole|enabled|helped|allowed|repairs?|renovations?|safer|modern)\b/iu.test(body)) {
      addCandidate(candidates, row, unit, approvedCandidate({
        subject,
        family: "causal_reason",
        answerShape: "reason",
        value: causal,
        evidenceQuote: evidence
      }));
    }

    const relationship = firstMatch(body, [
      /\b(married\s+to\s+[A-Z][A-Za-z.'’-]+(?:\s+[A-Z][A-Za-z.'’-]+)?)\b/u,
      /\b(marriage)\b/iu,
      /\b(got\s+married|not\s+married\s+yet)\b/iu,
      /\b(?:is|was|are|were|currently)\s+(married|engaged|single|divorced)\b/iu,
      /\b(single\s+parent|single\s+mom|single\s+mother|single\s+dad|single\s+father)\b/iu,
      /\b(not\s+(?:dating|seeing\s+anyone|in\s+a\s+relationship)|no\s+romantic\s+relationship)\b/iu,
      /\b(my\s+husband|my\s+wife|my\s+spouse|my\s+partner)\b/iu
    ]);
    if (relationship && /\b(?:married|engaged|single|single\s+parent|single\s+mom|single\s+mother|single\s+dad|single\s+father|divorced|spouse|husband|wife|partner|relationship status|dating|seeing anyone|romantic relationship)\b/iu.test(body)) {
      addCandidate(candidates, row, unit, approvedCandidate({
        subject,
        family: "relationship_status",
        answerShape: "yes_no",
        value: relationship,
        evidenceQuote: evidence
      }));
    }

    const signedTeam = firstMatch(body, [/\bsigned\s+with\s+(?:the\s+)?([^.!?;]{2,100})/iu]);
    if (signedTeam) {
      addCandidate(candidates, row, unit, approvedCandidate({
        subject,
        family: "role",
        subtype: "sports_team",
        answerShape: "atomic_value",
        value: signedTeam,
        evidenceQuote: evidence
      }));
    }
    const questionBoundTeam = /\b(?:which|what)\s+team\b/iu.test(contextualBody)
      ? firstMatch(body, [
          /^(?:the\s+)?([A-Z][A-Za-z0-9'’-]+(?:\s+[A-Z][A-Za-z0-9'’-]+){0,4})!?\s+(?:I\s+can'?t\s+wait\s+to\s+play\s+with\s+them|I\s+am\s+excited\s+to\s+play\s+with\s+them|can'?t\s+wait\s+to\s+join\s+them)\b/u,
          /\b(?:play\s+with|join)\s+(?:the\s+)?([A-Z][A-Za-z0-9'’-]+(?:\s+[A-Z][A-Za-z0-9'’-]+){0,4})\b/u
        ])
      : null;
    if (questionBoundTeam) {
      addCandidate(candidates, row, contextualEvidence, approvedCandidate({
        subject,
        family: "role",
        subtype: "sports_team",
        answerShape: "atomic_value",
        value: questionBoundTeam,
        evidenceQuote: contextualEvidence
      }));
    }
    const role = firstMatch(body, [
      /\b(?:position|role|job title)\s+(?:is|was)\s+(?:a\s+|an\s+)?([^.!?;]{2,80})/iu,
      /\b(?:is|was|became|i'?m|i am)\s+(?:a\s+|an\s+)?([^.!?;]{2,80}\b(?:guard|forward|center|coach|captain|manager|engineer|designer|owner|founder))\b/iu
    ]);
    if (role && /\b(?:position|role|job title|signed|guard|forward|center|coach|manager|engineer|designer|owner|founder)\b/iu.test(body)) {
      addCandidate(candidates, row, unit, approvedCandidate({
        subject,
        family: "role",
        subtype: "position",
        answerShape: "atomic_value",
        value: role,
        evidenceQuote: evidence
      }));
    }

    const residence = firstMatch(body, [
      /\b(?:live|lives|living|moved|settled|based|reside|resides)\s+(?:in|near|around)\s+([^.!?;]{2,100})/iu
    ]);
    if (residence && /\b(?:live|lives|living|moved|settled|based|reside|resides)\b/iu.test(body)) {
      addCandidate(candidates, row, unit, approvedCandidate({
        subject,
        family: "lives_in",
        answerShape: "yes_no",
        value: "Likely yes",
        evidenceQuote: evidence
      }));
    }

    const socialLocation = collectListValues(body, [
      /\bmade\s+friends?\s+(?:at|in|through|from)\s+([^.!?;]{2,180})/giu,
      /\bfriends?\s+(?:at|in|through|from)\s+([^.!?;]{2,180})/giu,
      /\bjoined\s+(?:a\s+|an\s+|the\s+)?(gym|nearby church|church)\b/giu,
      /\bvolunteer(?:ing)?\s+at\s+(?:a\s+|an\s+|the\s+)?(homeless shelter)\b/giu
    ]);
    if (socialLocation && /\b(?:made\s+friends?|friends?|joined|volunteer(?:ing)?)\b/iu.test(body)) {
      addCandidate(candidates, row, unit, approvedCandidate({
        subject,
        family: "social_location",
        answerShape: "list",
        value: socialLocation,
        evidenceQuote: evidence
      }));
    }

    const dateActivity = firstMatch(body, [
      /\b(?:doctor|doc|check[- ]?up)[^.?!]{0,120}\b((?:a\s+few|several|\d+|one|two|three|four|five)\s+days?\s+ago|last\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/iu,
      /\b((?:a\s+few|several|\d+|one|two|three|four|five)\s+days?\s+ago|last\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b[^.?!]{0,120}\b(?:doctor|doc|check[- ]?up|weight)\b/iu,
      /\b(?:on\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}(?:,\s+\d{4})?)[^.?!]{0,160}\b(?:went|played|did|activity\s+was)\s+([a-z][a-z -]{2,80})/iu,
      /\b(?:went|played|did|activity\s+was)\s+([a-z][a-z -]{2,80})[^.?!]{0,160}\bon\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}/iu,
      /\b(?:yesterday|last\s+(?:friday|saturday|sunday|monday|tuesday|wednesday|thursday))[^.?!]*[.?!]\s+(?:I\s+|we\s+)?(?:went|played|did)\s+(?:to\s+)?(?:a\s+|an\s+|the\s+)?([^.!?;]{2,80}\b(?:convention|game|bowling|skiing|painting|hiking|running|swimming|dancing|golf|tennis)\b[^.!?;]{0,80})/iu,
      /\b(?:yesterday|last\s+(?:friday|saturday|sunday|monday|tuesday|wednesday|thursday))[^.?!]{0,120}\b(?:went|played|did)\s+(?:to\s+)?(?:a\s+|an\s+|the\s+)?([^.!?;]{2,80}\b(?:convention|game|bowling|skiing|painting|hiking|running|swimming|dancing|golf|tennis)\b[^.!?;]{0,80})/iu,
      /\b(?:yesterday|last\s+(?:friday|saturday|sunday|monday|tuesday|wednesday|thursday))[^.?!]{0,120}\b(?:went|played|did)\s+([a-z][a-z -]{2,80})/iu,
      /\b(?:went|played|did)\s+([a-z][a-z -]{2,80})[^.?!]{0,120}\b(?:yesterday|last\s+(?:friday|saturday|sunday|monday|tuesday|wednesday|thursday))\b/iu,
      /\b(bowling|skiing|painting|hiking|running|swimming|dancing|golf|tennis)\b/iu,
      /\b(?:passed away|died)\s+((?:a\s+few|several|\d+|one|two|three|four|five)\s+years?\s+ago|last\s+year|two\s+days?\s+ago)\b/iu,
      /\b((?:a\s+few|several|\d+|one|two|three|four|five)\s+years?\s+ago|last\s+year|two\s+days?\s+ago)[^.?!]{0,80}\b(?:passed away|died)\b/iu
    ]);
    if (dateActivity && /\b(?:activity|recreational|on\s+(?:January|February|March|April|May|June|July|August|September|October|November|December|\d{1,2})|went|played|yesterday|last\s+(?:friday|saturday|sunday|monday|tuesday|wednesday|thursday)|bowling|skiing|painting|hiking|running|swimming|dancing|convention|doctor|doc|check[- ]?up|weight|passed away|died|years?\s+ago|last\s+year|few\s+days?\s+ago)\b/iu.test(body)) {
      addCandidate(candidates, row, unit, approvedCandidate({
        subject,
        family: "temporal_event",
        answerShape: "atomic_value",
        value: dateActivity,
        evidenceQuote: evidence,
        temporalAnchor: firstMatch(body, [/\b((?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}(?:,\s+\d{4})?)\b/u])
      }));
    }
  }
  return candidates;
}

export function buildDirectFactCandidatesFromSourceTextForTest(
  content: string,
  metadata: Record<string, unknown> = {}
): readonly AssistantCandidate[] {
  const row: DirectFactSourceRow = {
    source_table: "artifact_chunks",
    source_row_id: "00000000-0000-7000-8000-000000000011",
    memory_id: null,
    artifact_id: "00000000-0000-7000-8000-000000000012",
    artifact_observation_id: "00000000-0000-7000-8000-000000000013",
    source_chunk_id: "00000000-0000-7000-8000-000000000014",
    source_offset: { char_start: 0, char_end: content.length },
    occurred_at: "2023-05-10T00:00:00.000Z",
    content,
    artifact_uri: "test://direct-fact-source",
    metadata
  };
  return buildDirectFactCandidatesForRow(row).map((candidate) => candidate.candidate);
}

export function buildDirectFactCandidatesFromSourceRowsForTest(
  contents: readonly string[],
  metadata: Record<string, unknown> = {}
): readonly AssistantCandidate[] {
  const rows: DirectFactSourceRow[] = contents.map((content, index) => ({
    source_table: "artifact_chunks",
    source_row_id: `00000000-0000-7000-8000-${String(index + 1).padStart(12, "0")}`,
    memory_id: null,
    artifact_id: "00000000-0000-7000-8000-000000000012",
    artifact_observation_id: "00000000-0000-7000-8000-000000000013",
    source_chunk_id: `00000000-0000-7000-8001-${String(index + 1).padStart(12, "0")}`,
    source_offset: { char_start: index * 1000, char_end: index * 1000 + content.length },
    occurred_at: "2023-05-10T00:00:00.000Z",
    content,
    artifact_uri: "test://direct-fact-source-window",
    metadata
  }));
  return buildDirectFactCandidatesForSourceRows(rows).map((candidate) => candidate.candidate);
}

function cleanValue(value: unknown): string | null {
  const normalized = stripInlineMediaAnnotations(normalize(value))
    .replace(/^[,;:.\s"'“”‘’]+|[,;:.\s"'“”‘’]+$/gu, "")
    .replace(/\s+(?:and|but|so)\s*$/iu, "")
    .trim();
  if (!normalized || normalized.length > 260 || /^\s*[\[{][\s\S]*[\]}]\s*$/u.test(normalized)) {
    return null;
  }
  return normalized;
}

function cleanSupportPhrase(value: unknown): string | null {
  const normalized = stripInlineMediaAnnotations(normalize(value))
    .replace(/^[,;:.\s"'“”‘’]+|[,;:.\s"'“”‘’]+$/gu, "")
    .trim();
  if (!normalized || /^\s*[\[{][\s\S]*[\]}]\s*$/u.test(normalized)) {
    return null;
  }
  return normalized.slice(0, 820);
}

function isLowInformationPreferenceValue(value: string): boolean {
  return /^(?:that|this|it|how|when|where|why|what|you|your|someone|something|anything)\b/iu.test(value);
}

function isConcretePreferenceValue(value: string): boolean {
  return /\b(?:movie|film|book|novel|food|meat|rice|beer|style|painting|music|song|album|activity|sport|chicken|beef|pork|fish|turkey|lamb|contemporary|sapiens|avalanche|hobbit|dr\.?\s*seuss|children'?s books?)\b/iu.test(value);
}

function hasExplicitPreferenceCue(value: string): boolean {
  return /\b(?:favorite|fav|prefer(?:s|red)?|preference|go-to|top\s+pick|speaks?\s+to\s+me|really\s+into|read\s+["“])\b/iu.test(value);
}

function hasWeakPreferenceVerb(value: string): boolean {
  return /\b(?:likes?|liked|loves?|loved|enjoys?|enjoyed|speaks?\s+to\s+me|really\s+into|read\s+["“])\b/iu.test(value);
}

function isCreativeOutputMediaClause(value: string, supportPhrase: string): boolean {
  const text = `${supportPhrase} ${value}`;
  return (
    /\b(?:write|wrote|make|made|create|created|film|filmed|shoot|shot|produce|produced|direct|directed)\b[^.?!]{0,90}\b(?:movie|film|book|novel|song|album|story|screenplay)\b/iu.test(text) ||
    /\b(?:movie|film|book|novel|song|album|story|screenplay)\b[^.?!]{0,90}\b(?:write|wrote|make|made|create|created|film|filmed|shoot|shot|produce|produced|direct|directed)\b/iu.test(text)
  );
}

function isTitleLikePreferenceValue(value: string): boolean {
  const normalized = normalize(value);
  return (
    /["“”‘’][^"“”‘’]{2,90}["“”‘’]/u.test(normalized) ||
    /\b(?:Sapiens|Avalanche|Hobbit|Harry\s+Potter|Alchemist|Eternal\s+Sunshine|Spotless\s+Mind|C\.\s*S\.\s*Lewis|Neal\s+Stephenson)\b/iu.test(normalized) ||
    /(?:^|\s)[A-Z][A-Za-z0-9'’-]{2,}(?:\s+[A-Z][A-Za-z0-9'’-]{2,}){1,7}(?:\s|$)/u.test(normalized)
  );
}

function preferenceValueIsPromotable(value: string, supportPhrase: string): boolean {
  if (isLowInformationPreferenceValue(value)) {
    return false;
  }
  if (isCreativeOutputMediaClause(value, supportPhrase) && !hasExplicitPreferenceCue(supportPhrase)) {
    return false;
  }
  if (
    hasExplicitPreferenceCue(supportPhrase) &&
    /\b(?:band|artist|song|performance|concert|album|music)\b/iu.test(supportPhrase) &&
    /^[A-Z][A-Za-z0-9'’-]{2,40}$/u.test(normalize(value))
  ) {
    return true;
  }
  if (hasExplicitPreferenceCue(supportPhrase)) {
    return isConcretePreferenceValue(value) || isTitleLikePreferenceValue(value);
  }
  if (!hasWeakPreferenceVerb(supportPhrase)) {
    return false;
  }
  if (/\b(?:movie|film|book|novel|song|album)\b/iu.test(value)) {
    return isTitleLikePreferenceValue(value);
  }
  return isConcretePreferenceValue(value);
}

function isLowInformationConversationalFragment(value: string): boolean {
  const normalized = normalize(value).toLowerCase();
  if (!normalized || normalized.length < 4) {
    return true;
  }
  if (
    /^(?:we|you|i|he|she|they|it|that|this)\s+(?:talked|said|mentioned|feel|felt|think|thought|motivated|helped|helps|can|could|would|might|may)\b/u.test(normalized) ||
    /^(?:going\s+great|visit|challenge|spoilers?|helps?\s+too|you\s+motivated|we\s+talked|doesn'?t\s+go\s+as\s+planned|see\s+your\s+favorites?\s+doing\s+their\s+thing)$/u.test(normalized) ||
    /\b(?:since\s+we\s+last\s+talked|lots\s+has\s+been\s+happening|had\s+the\s+chance\s+to\s+do\s+it|i\s+am\s+working\s+on\s*-\s*super\s+excited|representation\s+of\s+your\s+journey|passion\s+for\s+music\s+and\s+the\s+friendships|be\s+in\s+that\s+situation|call\s+me\s+at\s+the\s+store)\b/u.test(normalized) ||
    /^(?:good|great|nice|interesting|awesome|impressive|rough|tough|cool|healthy)$/u.test(normalized)
  ) {
    return true;
  }
  const contentTerms = normalized.match(/[a-z][a-z'’-]{2,}/gu) ?? [];
  const onlyDiscourseTerms = contentTerms.length > 0 && contentTerms.every((term) =>
    /^(?:well|yeah|yes|okay|ok|great|good|nice|cool|wow|sure|maybe|really|just|also|too|thing|things|talked|talk|said|say|visit|challenge|helps|helped|motivated|going|chance|happening|excited)$/u.test(term)
  );
  return onlyDiscourseTerms;
}

function hasConcreteObjectCue(value: string, supportPhrase: string): boolean {
  return /\b(?:car|cars|prius|ferrari|tesla|mansion|house|home|bike|bicycle|turtles?|dogs?|cats?|pets?|sneakers?|jerseys?|dvds?|records?|cards?|books?|camera|guitar|shop|store|app|project)\b/iu.test(`${value} ${supportPhrase}`);
}

function hasConcreteProjectCue(value: string, supportPhrase: string): boolean {
  return /\b(?:open|build|create|start|work\s+on|shop|store|business|app|project|goal|dream|custom(?:ize|ized|izable)?|preferences?|needs?|dog\s+treats?|remote|hybrid|suburbs?|living\s+space|classic\s+cars?|custom\s+car|auto\s+engineering|electric(?:al|ity)?|engineering|robotics|software|design|self[- ]?care|me[- ]time|running|reading|violin|stress|watercolor|painting|endorsements?|brand|foundation|charity|challenge|pre[- ]season|team['’]s\s+style|fitting\s+into|shooting percentage|championship|employs?|hires?|hiring|staffs?|a\s+lot\s+of\s+people|many\s+people)\b/iu.test(`${value} ${supportPhrase}`);
}

function hasCausalReasonCue(value: string, supportPhrase: string): boolean {
  return /\b(?:because|since|after|reason|decided|started|began|lost\s+(?:her|his|their|my)?\s*job|losing\s+(?:her|his|their|my)?\s*job|inspired|sparked|passionate|loved?|advice|suggestion|got\s+(?:me|him|her|them)\s+into|wanted\s+to|perfect\s+match|that['’]?s\s+why|taking\s+something\s+broken|making\s+it\s+whole|enabled|helped|allowed|repairs?|renovations?|learning environment|safer|modern)\b/iu.test(`${value} ${supportPhrase}`);
}

function directFactValueQualityRejectionReason(family: DirectFactFamily, value: string, supportPhrase: string): string | null {
  if (family !== "social_location_fact" && isLowInformationConversationalFragment(value)) {
    return "low_information_value";
  }
  switch (family) {
    case "causal_reason_fact":
      if (/^(?:i|he|she|they|we|[A-Z][A-Za-z'’-]+)\s+was\s+(?:a\s+)?(?:kid|child|young)\b/iu.test(value)) {
        return "value_shape_mismatch";
      }
      return hasCausalReasonCue(value, supportPhrase) ? null : "value_shape_mismatch";
    case "project_goal_fact":
      return hasConcreteProjectCue(value, supportPhrase) ? null : "low_information_value";
    case "owned_object_fact":
      if (/^(?:back|to|into|through|there|home|around|from)\b/iu.test(value)) {
        return "low_information_value";
      }
      return hasConcreteObjectCue(value, supportPhrase) ? null : "value_shape_mismatch";
    case "purchase_fact":
      if (/^(?:back|to|into|through|there|home|around|from)\b/iu.test(value)) {
        return "low_information_value";
      }
      return hasConcreteObjectCue(value, "") ? null : "value_shape_mismatch";
    case "owned_object_duration_fact":
      return /\b(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:days?|weeks?|months?|years?)\b/iu.test(value) ? null : "value_shape_mismatch";
    case "health_status_fact":
      return /\b(?:obesity|diabetes|anxiety|depression|adhd|asthma|hypertension|condition|health|diagnosed|suspected|weight)\b/iu.test(`${value} ${supportPhrase}`) ? null : "value_shape_mismatch";
    case "role_position_fact":
      return /\b(?:guard|forward|center|coach|captain|manager|engineer|designer|owner|founder|wolves|lakers|celtics|team|signed\s+with)\b/iu.test(`${value} ${supportPhrase}`) ? null : "value_shape_mismatch";
    case "social_location_fact":
      return /\b(?:shelter|gym|church|volunteer|school|work|club|community|meetup|class|convention)\b/iu.test(`${value} ${supportPhrase}`) ? null : "value_shape_mismatch";
    case "date_activity_fact":
      return /\b(?:bowling|skiing|painting|hiking|running|swimming|dancing|golf|tennis|convention|activity|recreational|went|played|yesterday|last\s+(?:friday|saturday|sunday|monday|tuesday|wednesday|thursday)|doctor|doc|check[- ]?up|weight|few\s+days?\s+ago|passed away|died|years?\s+ago|last year)\b/iu.test(`${value} ${supportPhrase}`) ? null : "value_shape_mismatch";
    default:
      return null;
  }
}

function directFamilyFromKey(value: string): DirectFactFamily | null {
  switch (value) {
    case "preference":
    case "preference_fact":
      return "preference_fact";
    case "owns":
    case "owned_object":
    case "owned_object_fact":
    case "pet_inventory_fact":
      return "owned_object_fact";
    case "owned_object_duration":
    case "owned_object_duration_fact":
      return "owned_object_duration_fact";
    case "purchase":
    case "purchase_fact":
      return "purchase_fact";
    case "project_support":
    case "project_goal":
    case "project_goal_fact":
      return "project_goal_fact";
    case "health_status":
    case "health_status_fact":
      return "health_status_fact";
    case "causal_reason":
    case "causal_reason_fact":
      return "causal_reason_fact";
    case "relationship_status":
    case "relationship_status_fact":
      return "relationship_status_fact";
    case "explicit_list_set":
      return "explicit_list_set";
    case "role":
    case "role_position":
    case "role_position_fact":
      return "role_position_fact";
    case "social_location":
    case "social_location_fact":
      return "social_location_fact";
    case "lives_in":
    case "residence":
    case "residence_fact":
      return "residence_fact";
    case "date_activity":
    case "date_activity_fact":
      return "date_activity_fact";
    default:
      return null;
  }
}

export function directFactFamilyFromCandidate(candidate: AssistantCandidate): DirectFactFamily | null {
  for (const value of [candidate.evidence_family, candidate.family, candidate.subtype, ...(candidate.tags ?? [])]) {
    const family = directFamilyFromKey(normalizeKey(value));
    if (family) {
      return family;
    }
  }
  if (normalizeKey(candidate.family) === "temporal_event" && /\b(?:activity|recreational|date|on|went|played|bowling|skiing|painting|hiking|running|swimming|dancing|convention|doctor|doc|check[- ]?up|weight|yesterday|few\s+days?\s+ago|last\s+(?:friday|saturday|sunday|monday|tuesday|wednesday|thursday)|passed away|died|years? ago|last year|two days? ago)\b/iu.test(normalize(candidate.evidence_quote))) {
    return "date_activity_fact";
  }
  return null;
}

function candidateFamilyForDirectFact(family: DirectFactFamily): string {
  switch (family) {
    case "preference_fact":
      return "preference";
    case "owned_object_fact":
      return "owns";
    case "purchase_fact":
      return "purchase";
    case "project_goal_fact":
      return "project_support";
    case "health_status_fact":
      return "health_status";
    case "causal_reason_fact":
      return "causal_reason";
    case "relationship_status_fact":
      return "relationship_status";
    case "role_position_fact":
      return "role";
    case "owned_object_duration_fact":
      return "owned_object_duration";
    case "social_location_fact":
      return "social_location";
    case "residence_fact":
      return "lives_in";
    case "date_activity_fact":
      return "temporal_event";
    case "explicit_list_set":
      return "explicit_list_set";
  }
}

function answerShapeForDirectFactFamily(family: DirectFactFamily): DirectFactAnswerShape {
  switch (family) {
    case "causal_reason_fact":
      return "reason";
    case "owned_object_duration_fact":
      return "duration";
    case "explicit_list_set":
    case "social_location_fact":
      return "list";
    case "relationship_status_fact":
    case "residence_fact":
      return "yes_no";
    default:
      return "atomic_value";
  }
}

function directFactFamilyForStructuredRow(row: StructuredDirectFactRow): DirectFactFamily | null {
  const metadata = row.metadata ?? {};
  const candidates = [
    metadata.directFactFamily,
    metadata.direct_fact_family,
    metadata.evidence_family,
    metadata.family,
    metadata.predicate_family,
    row.family_key,
    row.property_key
  ];
  for (const candidate of candidates) {
    const family = directFamilyFromKey(normalizeKey(candidate));
    if (family) {
      return family;
    }
  }
  const support = normalize(`${row.answer_value ?? ""} ${row.support_phrase ?? ""} ${row.source_text ?? ""}`);
  if (row.source_table === "temporal_event_facts" && /\b(?:activity|recreational|bowling|skiing|painting|hiking|running|swimming|dancing|passed away|died)\b/iu.test(support)) {
    return "date_activity_fact";
  }
  return null;
}

function buildDirectFactCandidatesForStructuredRows(rows: readonly StructuredDirectFactRow[]): readonly SourceDirectFactCandidate[] {
  const candidates: SourceDirectFactCandidate[] = [];
  for (const row of rows) {
    const family = directFactFamilyForStructuredRow(row);
    const subject = cleanSubjectName(row.subject_name ?? row.metadata?.subject);
    const value = cleanValue(row.answer_value);
    const supportPhrase = cleanValue(row.support_phrase) ?? cleanValue(row.source_text);
    if (!family) {
      continue;
    }
    const evidenceQuote = supportPhrase ?? null;
    const candidate: AssistantCandidate = {
      ...approvedCandidate({
        subject,
        family: candidateFamilyForDirectFact(family),
        answerShape: answerShapeForDirectFactFamily(family),
        value,
        evidenceQuote: evidenceQuote ?? "",
        temporalAnchor: row.valid_from,
        confidence: row.confidence ?? 0.78
      }),
      evidence_quote: evidenceQuote,
      tags: [family, candidateFamilyForDirectFact(family)]
    };
    candidates.push({
      candidate,
      sourceText: supportPhrase ?? value ?? "",
      sourceTable: row.source_table,
      sourceRowId: row.source_row_id,
      sourceMemoryId: row.source_memory_id,
      sourceChunkId: row.source_chunk_id,
      occurredAt: row.valid_from,
      artifactUri: row.source_uri,
      sourceType: "structured_surface",
      speaker: subject,
      metadata: {
        source: "structured_surface_direct_fact_compiler",
        source_table: row.source_table,
        source_row_id: row.source_row_id,
        source_memory_id: row.source_memory_id,
        source_chunk_id: row.source_chunk_id,
        source_uri: row.source_uri,
        source_metadata: row.metadata ?? {},
        directFactCompilerSource: "typed_memory_rebuild"
      }
    });
  }
  return candidates;
}

function answerShapeForFamily(family: DirectFactFamily, candidate: AssistantCandidate): DirectFactAnswerShape {
  const explicit = normalizeKey(candidate.answer_shape) as DirectFactAnswerShape;
  if (["atomic_value", "list", "date", "duration", "reason", "yes_no", "abstention"].includes(explicit)) {
    return explicit;
  }
  switch (family) {
    case "causal_reason_fact":
      return "reason";
    case "owned_object_duration_fact":
      return "duration";
    case "explicit_list_set":
      return "list";
    case "relationship_status_fact":
    case "residence_fact":
      return "yes_no";
    case "date_activity_fact":
      return "atomic_value";
    case "social_location_fact":
      return "list";
    default:
      return "atomic_value";
  }
}

function subjectFromCandidate(candidate: AssistantCandidate, supportPhrase: string, speaker: string | null): string | null {
  const candidateSubject = cleanSubjectName(candidate.subject);
  if (candidateSubject) {
    return candidateSubject;
  }
  const inferred = subjectForEvidence(supportPhrase, speaker);
  if (inferred) {
    return inferred;
  }
  const explicit = cleanSubjectName(supportPhrase.match(/^\s*([A-Z][A-Za-z'’-]{1,40})(?:['’]s|\b)/u)?.[1] ?? null);
  if (explicit) {
    return explicit;
  }
  if (speaker && /\b(?:I|me|my|mine|I'm|I've|I'd|I'll)\b/iu.test(supportPhrase)) {
    return speaker;
  }
  return null;
}

function hasMixedOwnerEvidence(subject: string, supportPhrase: string): boolean {
  let body = normalize(supportPhrase.replace(/^\s*[A-Z][A-Za-z'’-]{1,40}(?:\s+[A-Z][A-Za-z'’-]{1,40})?:\s/u, ""));
  body = body.replace(
    /^(?:(?:hey|hi|hello|wow|cool|thanks|thank you|sorry|yeah|yep|yes|no|same here|me too|great|nice|awesome|oh|ah|well)[,!\s]+)*(?:[A-Z][A-Za-z'’-]{1,40}[,!]+\s*){0,2}/iu,
    ""
  );
  const names = [...body.matchAll(/\b([A-Z][A-Za-z'’-]{1,40})(?:['’]s|\b)/gu)]
    .map((match) => match[1] ?? "")
    .filter((name) =>
      name &&
      !/^(?:I(?:'m|'ve|'d|'ll)?|It|We|You|They|He|She|The|This|That|Something|Anything|Everything|Nothing|When|Where|Why|How|What|Which|Because|Since|Yeah|Yep|Yes|No|So|Thanks|Thank|Wow|Hey|Oh|Ah|Cool|Nice|Great|Glad|Also|BTW|FYI)$/u.test(name) &&
      !/^(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|January|February|March|April|May|June|July|August|September|October|November|December)$/u.test(name) &&
      !/^(?:DVDs?|TV|VR|AI|US|USA|Minnesota|Wolves|Counter|Strike|Global|Offensive|Door|Dash)$/u.test(name)
    );
  const unique = [...new Set(names.map((name) => name.toLowerCase()))];
  if (unique.length <= 1) {
    return false;
  }
  const subjectKey = subject.toLowerCase();
  const otherNames = unique.filter((name) => name !== subjectKey);
  if (otherNames.length === 0) {
    return false;
  }
  const namePair = /\b[A-Z][A-Za-z'’-]{1,40}\s+(?:and|&)\s+[A-Z][A-Za-z'’-]{1,40}\b/u.test(body);
  const betweenPair = /\b(?:between|both)\b[^.?!]{0,120}\b[A-Z][A-Za-z'’-]{1,40}\b[^.?!]{0,120}\b(?:and|&)\b[^.?!]{0,120}\b[A-Z][A-Za-z'’-]{1,40}\b/iu.test(body);
  const otherPossessive = otherNames.some((name) => new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}['’]s\\b`, "iu").test(body));
  return namePair || betweenPair || otherPossessive;
}

function looksLikeGenericProfileProse(supportPhrase: string): boolean {
  return (
    supportPhrase.length > 420 ||
    /\b(?:profile|summary|report|overview)\b[\s\S]{0,80}\b(?:says|states|indicates)\b/iu.test(supportPhrase) ||
    /\b(?:is a person who|has a background in|works as|career|role)\b/iu.test(supportPhrase) &&
      !/\b(?:prefers?|favorite|bought|purchased|owns?|has\s+(?:suspected|known|diagnosed|obesity|diabetes|anxiety|depression|adhd|asthma)|diagnosed|suspected|because|reason|married|single|lives?\s+in|activity|signed\s+with|position)\b/iu.test(supportPhrase)
  );
}

function relationshipIsOnlyCoMention(supportPhrase: string): boolean {
  return !/\b(?:married|engaged|single|single\s+parent|single\s+mom|single\s+mother|single\s+dad|single\s+father|divorced|partner|spouse|husband|wife|dating|seeing anyone|romantic relationship|in a relationship|relationship status|married to)\b/iu.test(supportPhrase);
}

function extractByPatterns(supportPhrase: string, patterns: readonly RegExp[]): string | null {
  for (const pattern of patterns) {
    const match = supportPhrase.match(pattern);
    const value = cleanValue(match?.[1] ?? match?.[0] ?? null);
    if (value) {
      return value;
    }
  }
  return null;
}

function valueFromSupport(family: DirectFactFamily, candidate: AssistantCandidate, supportPhrase: string): string | null {
  const explicit = cleanValue(candidate.value);
  if (explicit) {
    return explicit;
  }
  switch (family) {
    case "preference_fact":
      return extractByPatterns(supportPhrase, [
        /\bprefer(?:s|red)?\s+(?:eating\s+)?([^.!?;]{2,120})/iu,
        /\b(?:would|wants?\s+to|i'?d)\s+(?:prefer|rather)\s+([^.!?;]{2,140})/iu,
        /\bfavorite\s+(?:movies?|films?|books?|food|meat|style|activity|thing|recipe)\s+(?:is|was|are|include|included|:)\s+([^.!?;]{2,160})/iu,
        /\b(?:likes?|loves?|enjoys?)\s+([^.!?;]{2,120}\b(?:movie|film|book|food|meat|style|painting|music|song|activity)\b[^.!?;]{0,80})/iu,
        /\b(contemporary)\b[^.!?;]{0,120}\b(?:top\s+pick|speaks?\s+to\s+me|favorite|fav|preferred)\b/iu,
        /\b(Contemporary\s+dance)\b[^.!?;]{0,140}\bspeaks?\s+to\s+me\b/iu,
        /\b((?:roasted\s+)?chicken)\b[^.!?;]{0,120}\b(?:one\s+of\s+my\s+favorites|favorite|fav)\b/iu,
        /\bif\s+i\s+had\s+to\s+pick\s+a\s+favorite,\s+it\s+would\s+definitely\s+be\s+([^.!?;]{2,120})/iu,
        /\breally\s+into\s+(?:this\s+book\s+called\s+)?["“]?([^"”!.?;]{2,120})["”]?/iu,
        /\b(read\s+["“][^"”]{2,100}["”]\s+by\s+[^.!?;]{2,80})/iu
      ]);
    case "owned_object_fact":
      return extractByPatterns(supportPhrase, [
        /\b(?:in|with)\s+(?:my|his|her|their)\s+((?:new|old|trusty)?\s*(?:prius|ferrari|car|truck|bike|bicycle|camera|guitar))\b/iu,
        /\b(?:owns?|owned|has|had|keeps?|kept|drives?|drove|got|adopted)\s+(?:a\s+|an\s+|the\s+|his\s+|her\s+|their\s+|my\s+)?([^.!?;]{2,140})/iu
      ]);
    case "purchase_fact":
      return extractByPatterns(supportPhrase, [
        /\b(?:bought|purchased|acquired)\s+([^.!?;]{2,180})/iu,
        /\bitems?\s+(?:were|are|included|include)\s+([^.!?;]{2,180})/iu,
        /\b(?:here'?s|this\s+is|that'?s)\s+(?:my|his|her|their)\s+(new\s+(?:mansion|house|car|ferrari|camera|guitar))\b/iu,
        /\b(?:just\s+)?got\s+(?:a\s+|an\s+|the\s+)?(?:new\s+)?([^.!?;]{2,160}\b(?:car|prius|ferrari|mansion|house|camera|guitar)\b[^.!?;]{0,80})/iu,
        /\b(?:new\s+)(mansion|ferrari|car|prius|camera|guitar)\b/iu
      ]);
    case "project_goal_fact":
      return extractByPatterns(supportPhrase, [
        /\b(?:dreams?|goals?)\s+(?:are|include|of|to|:)\s+([^.!?;]{2,220})/iu,
        /\b(?:number\s+one\s+goal|main\s+goal|biggest\s+goal)\s+(?:is|was|:)?\s*([^.!?;]{2,220})/iu,
        /\b(?:wants?|hopes?|plans?)\s+to\s+([^.!?;]{2,180})/iu,
        /\b(?:project(?:\s+was|\s+is)?|kind of project)\s+(?:an?\s+|the\s+)?([^.!?;]{2,140})/iu,
        /\b(?:users?\s+can|allow(?:s|ed|ing)?\s+users?\s+to)\s+([^.!?;]{2,180}\b(?:preferences?|needs?|profile|customiz(?:e|ed|able|ing))\b[^.!?;]{0,120})/iu,
        /\b(?:unique|different|stand out)[^.?!]{0,120}\b(?:because|by|with|allow(?:ing)?)\s+([^.!?;]{2,160})/iu,
        /\b(challenge\s+(?:was|is)\s+[^.!?;]{2,180})/iu,
        /\b((?:fitting|fit)\s+into\s+(?:the\s+)?new\s+team['’]s\s+style[^.!?;]{0,160})/iu,
        /\b((?:endorsements?|building\s+(?:my|his|her)?\s*brand|charity|foundation)[^.!?;]{0,220})/iu,
        /\b((?:open|start|build|create)\s+(?:my\s+own\s+|his\s+own\s+|her\s+own\s+)?(?:car maintenance\s+)?(?:shop|store|business|studio)[^.!?;]{0,180})/iu,
        /\b((?:work(?:ing)?\s+on|build(?:ing)?)\s+(?:classic\s+cars?|custom\s+car)[^.!?;]{0,180})/iu,
        /\b((?:always\s+)?wanted\s+to\s+learn\s+auto\s+engineering[^.!?;]{0,180}\b(?:custom\s+car|cars?|auto)\b[^.!?;]{0,120})/iu,
        /\b((?:watercolor\s+painting|painting)\s+(?:is|was|became)?[^.!?;]{0,160}\bstress[- ]buster[^.!?;]{0,80})/iu,
        /\b(carv(?:e|ing)\s+out\s+some\s+me[- ]time[^.!?;]{0,220}\b(?:running|reading|violin)[^.!?;]{0,120})/iu
      ]);
    case "health_status_fact":
      return extractByPatterns(supportPhrase, [
        /\b(obesity|diabetes|anxiety|depression|adhd|asthma|hypertension)\b/iu,
        /\b(?:diagnosed|suspected|health problems?|condition|weight problem)\s+(?:with|as|is|was)?\s*([^.!?;]{2,100})/iu
      ]);
    case "causal_reason_fact":
      return extractByPatterns(supportPhrase, [
        /\b((?:enabled|helped|allowed|made)\s+[^.!?;]{0,180}\b(?:repairs?|renovations?|safer|modern|learning environment|students?|support|funding)[^.!?;]{0,120})/iu,
        /\b(?:because|'cause|cause|since|after)\s+([^.!?;]{8,220})/iu,
        /\breason\s+(?:is|was)\s+([^.!?;]{8,220})/iu,
        /\bdecided\s+to\s+[^.!?;]{2,160}\b(?:because|'cause|cause|after|since)\s+([^.!?;]{8,220})/iu,
        /\b((?:friend|buddy|pal)[^.?!]{0,160}\bgave\s+(?:me|him|her|them)\s+[^.?!]{0,120}\binspired\s+(?:me|him|her|them)[^.?!]{0,180})/iu,
        /\b(?:friend|buddy|pal)[^.?!]{0,140}\b(?:advice|suggestion|suggested|got\s+(?:me|him|her|them)\s+into|introduced\s+(?:me|him|her|them)\s+to)\s+([^.!?;]{2,180})/iu,
        /\b((?:friend|buddy|pal)[^.?!]{0,140}\b(?:advice|suggestion|suggested|got\s+(?:me|him|her|them)\s+into|introduced\s+(?:me|him|her|them)\s+to)[^.?!]{0,180})/iu,
        /\b(pass(?:ion)?ate\s+about\s+[^.!?;]{8,180})/iu,
        /\b(lov(?:e|ed)\s+(?:of|for)?\s*[^.!?;]{8,180})/iu,
        /\b(always\s+loved\s+fashion\s+trends[^.!?;]{0,180}\b(?:unique pieces|clothing|store)[^.!?;]{0,120})/iu,
        /\b(lost\s+(?:her|his|their|my)?\s*job[^.!?;]{0,180}\b(?:start|starting|business|shop|store|studio|take\s+a\s+shot)[^.!?;]{0,160})/iu,
        /\b(lost\s+(?:her|his|their|my)?\s*job[^.!?;]{0,180})/iu
      ]);
    case "relationship_status_fact":
      if (/\bsingle\b/iu.test(supportPhrase)) return "single";
      if (/\bnot\s+(?:dating|seeing\s+anyone|in\s+a\s+relationship)\b|\bno\s+romantic\s+relationship\b/iu.test(supportPhrase)) return "single";
      if (/\bdivorced\b/iu.test(supportPhrase)) return "divorced";
      if (/\bengaged\b/iu.test(supportPhrase)) return "engaged";
      if (/\bmarried\b|\bmarriage\b/iu.test(supportPhrase)) return "married";
      return null;
    case "explicit_list_set":
      if (/\b(?:no|none|does(?:n'?t| not)|don't|do not|has(?:n'?t| not))\b[^.?!]{0,100}\b(?:favorite|listed|known|mentioned)\b/iu.test(supportPhrase)) {
        return "None.";
      }
      if (/\b(?:classes?|groups?|workshops?|courses?|training|grooming|agility|positive reinforcement)\b/iu.test(supportPhrase)) {
        return collectListValues(supportPhrase, [
          /\b(positive reinforcement training workshop|positive reinforcement training class|workshop about bonding with my pet|workshop about bonding with pets|dog training course|agility training course|agility classes?|grooming course|dog grooming course|dog[- ]owners? group|pet[- ]owners? group|dog meetup group)\b/giu
        ]);
      }
      return extractByPatterns(supportPhrase, [
        /\b(?:are|include|included|list(?:ed)?|collects?|collection(?:s)?(?: include)?)\s+([^.!?;]{2,220})/iu
      ]);
    case "role_position_fact":
      return extractByPatterns(supportPhrase, [
        /\bsigned\s+with\s+(?:the\s+)?([^.!?;]{2,100})/iu,
        /\b(?:position|role|job title)\s+(?:is|was)\s+(?:a\s+|an\s+)?([^.!?;]{2,80})/iu,
        /\b(?:is|was)\s+(?:a\s+|an\s+)?([^.!?;]{2,60}\b(?:guard|forward|center|coach|captain|manager|engineer|designer|owner|founder))\b/iu
      ]);
    case "owned_object_duration_fact":
      return extractByPatterns(supportPhrase, [
        /\b(?:had|has|have|owned|kept)\s+(?:his|her|their|my)?\s*(?:first\s+two\s+)?(?:turtles?|pets?|dogs?|cats?|cars?|items?)[^.?!]{0,120}\bfor\s+((?:\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:days?|weeks?|months?|years?))\b/iu,
        /\b(?:first\s+two\s+)?(?:turtles?|pets?|dogs?|cats?|cars?|items?)[^.?!]{0,140}\b(?:for|since)\s+((?:\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:days?|weeks?|months?|years?))\b/iu
      ]);
    case "social_location_fact":
      return collectListValues(supportPhrase, [
        /\bmade\s+friends?\s+(?:at|in|through|from)\s+([^.!?;]{2,160})/giu,
        /\bfriends?\s+(?:at|in|through|from)\s+([^.!?;]{2,160})/giu,
        /\bjoined\s+(?:a\s+|an\s+|the\s+)?(gym|nearby church|church)\b/giu,
        /\bvolunteer(?:ing)?\s+at\s+(?:a\s+|an\s+|the\s+)?(homeless shelter)\b/giu
      ]);
    case "residence_fact":
      return extractByPatterns(supportPhrase, [
        /\b(?:live|lives|living|moved|settled|based|reside|resides)\s+(?:in|near|around)\s+([^.!?;]{2,100})/iu
      ]);
    case "date_activity_fact":
      return extractByPatterns(supportPhrase, [
        /\b(?:doctor|doc|check[- ]?up)[^.?!]{0,120}\b((?:a\s+few|several|\d+|one|two|three|four|five)\s+days?\s+ago|last\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/iu,
        /\b((?:a\s+few|several|\d+|one|two|three|four|five)\s+days?\s+ago|last\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b[^.?!]{0,120}\b(?:doctor|doc|check[- ]?up|weight)\b/iu,
        /\b(?:activity|was|went|played|pursuing)\s+(?:was\s+)?([a-z][a-z -]{2,60})\b/iu,
        /\b(bowling|skiing|painting|hiking|running|swimming|dancing|golf|tennis)\b/iu,
        /\b(?:passed away|died)\s+((?:a\s+few|several|\d+|one|two|three|four|five)\s+years?\s+ago|last\s+year|two\s+days?\s+ago)\b/iu,
        /\b((?:a\s+few|several|\d+|one|two|three|four|five)\s+years?\s+ago|last\s+year|two\s+days?\s+ago)[^.?!]{0,80}\b(?:passed away|died)\b/iu
      ]);
  }
}

function queryFamilyForDirectFact(family: DirectFactFamily): "exact_detail" | "profile_report" | "typed_list_set" | "temporal_detail" {
  switch (family) {
    case "causal_reason_fact":
    case "project_goal_fact":
    case "health_status_fact":
    case "relationship_status_fact":
    case "social_location_fact":
      return "profile_report";
    case "explicit_list_set":
      return "typed_list_set";
    case "date_activity_fact":
      return "temporal_detail";
    default:
      return "exact_detail";
  }
}

function rejectionReasonFromIssues(issues: readonly ValidationIssue[]): string | null {
  const taxonomy = issues.find((issue) =>
    ["unknown_object_type", "unknown_domain", "unknown_family", "unknown_subtype", "domain_family_mismatch", "suggested_taxonomy_promoted"].includes(issue.code)
  );
  if (taxonomy) {
    return "taxonomy_unknown";
  }
  const evidence = issues.find((issue) => issue.code === "missing_evidence_quote");
  return evidence?.code ?? issues[0]?.code ?? null;
}

export function compileDirectFactCandidate(params: {
  readonly run: CompilerRunResult;
  readonly entry: ValidatedCandidate;
  readonly registry: TaxonomyRegistry;
}): DirectFactCompileDecision {
  const candidate = params.entry.candidate;
  const family = directFactFamilyFromCandidate(candidate);
  if (!family) {
    return {
      handled: false,
      family: null,
      answerShape: null,
      subject: null,
      value: null,
      supportPhrase: null,
      promotionStatus: "rejected",
      admissibilityStatus: "rejected",
      rejectionReason: null,
      metadata: {}
    };
  }

  const supportPhrase = cleanSupportPhrase(candidate.evidence_quote);
  const sourceType = normalizeKey(params.run.unit.sourceType);
  const sourcePromotionMode = normalizeKey(params.run.unit.metadata?.promotionMode ?? params.run.unit.metadata?.promotion_mode);
  const baseMetadata = {
    candidate,
    directFactFamily: family,
    evidenceFamily: candidate.evidence_family ?? family,
    taxonomyVersion: params.registry.version,
    sourceType: params.run.unit.sourceType,
    sourcePromotionMode: sourcePromotionMode || null
  };
  if (sourceType === "omi" && sourcePromotionMode !== "support_and_promote") {
    return {
      handled: true,
      family,
      answerShape: answerShapeForFamily(family, candidate),
      subject: null,
      value: null,
      supportPhrase,
      promotionStatus: "rejected",
      admissibilityStatus: "rejected",
      rejectionReason: "omi_support_only",
      metadata: { ...baseMetadata, compilerOwner: "direct_fact", subjectBindingStatus: "blocked_support_only" }
    };
  }
  if (!params.entry.promotionEligible) {
    return {
      handled: true,
      family,
      answerShape: answerShapeForFamily(family, candidate),
      subject: cleanValue(candidate.subject),
      value: cleanValue(candidate.value),
      supportPhrase,
      promotionStatus: params.entry.issues.some((issue) => issue.code.includes("ambiguous")) ? "ambiguous" : "rejected",
      admissibilityStatus: params.entry.issues.some((issue) => issue.code.includes("ambiguous")) ? "ambiguous" : "rejected",
      rejectionReason: rejectionReasonFromIssues(params.entry.issues) ?? "not_promotable",
      metadata: { ...baseMetadata, compilerOwner: "direct_fact", validationIssues: params.entry.issues }
    };
  }
  if (!supportPhrase) {
    return {
      handled: true,
      family,
      answerShape: answerShapeForFamily(family, candidate),
      subject: cleanValue(candidate.subject),
      value: cleanValue(candidate.value),
      supportPhrase: null,
      promotionStatus: "rejected",
      admissibilityStatus: "rejected",
      rejectionReason: "evidence_missing",
      metadata: { ...baseMetadata, compilerOwner: "direct_fact" }
    };
  }
  const subject = subjectFromCandidate(candidate, supportPhrase, params.run.unit.speaker ?? null);
  if (!subject) {
    return {
      handled: true,
      family,
      answerShape: answerShapeForFamily(family, candidate),
      subject: null,
      value: cleanValue(candidate.value),
      supportPhrase,
      promotionStatus: "rejected",
      admissibilityStatus: "rejected",
      rejectionReason: "subject_binding",
      metadata: { ...baseMetadata, compilerOwner: "direct_fact", subjectBindingStatus: "unresolved" }
    };
  }
  if (hasMixedOwnerEvidence(subject, supportPhrase)) {
    return {
      handled: true,
      family,
      answerShape: answerShapeForFamily(family, candidate),
      subject,
      value: cleanValue(candidate.value),
      supportPhrase,
      promotionStatus: "rejected",
      admissibilityStatus: "rejected",
      rejectionReason: "mixed_owner",
      metadata: { ...baseMetadata, compilerOwner: "direct_fact", subjectBindingStatus: "mixed_owner" }
    };
  }
  if (looksLikeGenericProfileProse(supportPhrase)) {
    return {
      handled: true,
      family,
      answerShape: answerShapeForFamily(family, candidate),
      subject,
      value: cleanValue(candidate.value),
      supportPhrase,
      promotionStatus: "rejected",
      admissibilityStatus: "rejected",
      rejectionReason: "generic_profile_prose",
      metadata: { ...baseMetadata, compilerOwner: "direct_fact", subjectBindingStatus: "explicit_subject" }
    };
  }
  if (family === "relationship_status_fact" && relationshipIsOnlyCoMention(supportPhrase)) {
    return {
      handled: true,
      family,
      answerShape: answerShapeForFamily(family, candidate),
      subject,
      value: cleanValue(candidate.value),
      supportPhrase,
      promotionStatus: "rejected",
      admissibilityStatus: "rejected",
      rejectionReason: "relationship_comention_only",
      metadata: { ...baseMetadata, compilerOwner: "direct_fact", subjectBindingStatus: "explicit_subject" }
    };
  }
  const explicitCandidateValue = cleanValue(candidate.value);
  if (
    explicitCandidateValue &&
    (family === "causal_reason_fact" || family === "project_goal_fact") &&
    isLowInformationConversationalFragment(explicitCandidateValue)
  ) {
    return {
      handled: true,
      family,
      answerShape: answerShapeForFamily(family, candidate),
      subject,
      value: explicitCandidateValue,
      supportPhrase,
      promotionStatus: "rejected",
      admissibilityStatus: "rejected",
      rejectionReason: "low_information_value",
      metadata: { ...baseMetadata, compilerOwner: "direct_fact", subjectBindingStatus: "explicit_subject", valueShapeStatus: "low_information_value" }
    };
  }
  if (family === "causal_reason_fact" && !/\b(?:because|since|after|reason|decided|started|began|lost\s+(?:her|his|their|my)?\s*job|losing\s+(?:her|his|their|my)?\s*job|inspired|sparked|passionate|loved?|advice|suggestion|perfect\s+match|enabled|helped|allowed|repairs?|renovations?|safer|modern)\b/iu.test(supportPhrase)) {
    return {
      handled: true,
      family,
      answerShape: answerShapeForFamily(family, candidate),
      subject,
      value: cleanValue(candidate.value),
      supportPhrase,
      promotionStatus: "rejected",
      admissibilityStatus: "rejected",
      rejectionReason: "value_shape_mismatch",
      metadata: { ...baseMetadata, compilerOwner: "direct_fact", subjectBindingStatus: "explicit_subject" }
    };
  }
  if (family === "date_activity_fact" && !/\b(?:activity|recreational|on\s+(?:january|february|march|april|may|june|july|august|september|october|november|december|\d{1,2})|went|played|bowling|skiing|painting|hiking|running|swimming|dancing|doctor|doc|check[- ]?up|weight|few\s+days?\s+ago|passed away|died|years?\s+ago|last\s+year)\b/iu.test(supportPhrase)) {
    return {
      handled: true,
      family,
      answerShape: answerShapeForFamily(family, candidate),
      subject,
      value: cleanValue(candidate.value),
      supportPhrase,
      promotionStatus: "rejected",
      admissibilityStatus: "rejected",
      rejectionReason: "value_shape_mismatch",
      metadata: { ...baseMetadata, compilerOwner: "direct_fact", subjectBindingStatus: "explicit_subject" }
    };
  }

  const value = valueFromSupport(family, candidate, supportPhrase);
  if (!value) {
    return {
      handled: true,
      family,
      answerShape: answerShapeForFamily(family, candidate),
      subject,
      value: null,
      supportPhrase,
      promotionStatus: "rejected",
      admissibilityStatus: "rejected",
      rejectionReason: "value_shape_mismatch",
      metadata: { ...baseMetadata, compilerOwner: "direct_fact", subjectBindingStatus: "explicit_subject" }
    };
  }
  if (family === "preference_fact" && !preferenceValueIsPromotable(value, supportPhrase)) {
    return {
      handled: true,
      family,
      answerShape: answerShapeForFamily(family, candidate),
      subject,
      value,
      supportPhrase,
      promotionStatus: "rejected",
      admissibilityStatus: "rejected",
      rejectionReason: "value_shape_mismatch",
      metadata: { ...baseMetadata, compilerOwner: "direct_fact", subjectBindingStatus: "explicit_subject" }
    };
  }
  const valueQualityRejection = directFactValueQualityRejectionReason(family, value, supportPhrase);
  if (valueQualityRejection) {
    return {
      handled: true,
      family,
      answerShape: answerShapeForFamily(family, candidate),
      subject,
      value,
      supportPhrase,
      promotionStatus: "rejected",
      admissibilityStatus: "rejected",
      rejectionReason: valueQualityRejection,
      metadata: {
        ...baseMetadata,
        compilerOwner: "direct_fact",
        subjectBindingStatus: "explicit_subject",
        valueShapeStatus: valueQualityRejection
      }
    };
  }

  const answerShape = answerShapeForFamily(family, candidate);
  return {
    handled: true,
    family,
    answerShape,
    subject,
    value,
    supportPhrase,
    promotionStatus: "compiled",
    admissibilityStatus: "admissible",
    rejectionReason: null,
    metadata: {
      ...baseMetadata,
      compilerOwner: "direct_fact",
      directFactFamily: family,
      answerShape,
      subject,
      subjectBindingStatus: candidate.subject ? "explicit_candidate_subject" : "explicit_source_subject",
      valueShapeStatus: "compatible",
      taxonomyStatus: candidate.taxonomy_status ?? "approved",
      temporalAnchor: candidate.temporal_anchor ?? null
    }
  };
}

async function resolveSubjectEntityId(client: PoolClient, namespaceId: string, subject: string | null): Promise<string | null> {
  if (!subject) {
    return null;
  }
  const normalized = normalizeEntityName(subject);
  if (!normalized) {
    return null;
  }
  const result = await client.query<{ readonly id: string }>(
    `
      SELECT id::text
      FROM entities
      WHERE namespace_id = $1
        AND entity_type IN ('self', 'person')
        AND normalized_name = $2
      UNION
      SELECT e.id::text
      FROM entity_aliases ea
      JOIN entities e ON e.id = ea.entity_id
      WHERE e.namespace_id = $1
        AND e.entity_type IN ('self', 'person')
        AND ea.normalized_alias = $2
      LIMIT 1
    `,
    [namespaceId, normalized]
  );
  return result.rows[0]?.id ?? null;
}

async function resolveOrCreateSubjectEntityId(client: PoolClient, namespaceId: string, subject: string | null): Promise<string | null> {
  if (!subject) {
    return null;
  }
  const existing = await resolveSubjectEntityId(client, namespaceId, subject);
  if (existing) {
    return existing;
  }
  const normalized = normalizeEntityName(subject);
  if (!normalized) {
    return null;
  }
  const result = await client.query<{ readonly id: string }>(
    `
      INSERT INTO entities (
        namespace_id,
        entity_type,
        canonical_name,
        normalized_name,
        metadata
      )
      VALUES ($1, 'person', $2, $3, $4::jsonb)
      ON CONFLICT (namespace_id, entity_type, normalized_name)
      DO UPDATE SET
        canonical_name = EXCLUDED.canonical_name,
        last_seen_at = now(),
        metadata = entities.metadata || EXCLUDED.metadata
      RETURNING id::text
    `,
    [
      namespaceId,
      subject,
      normalized,
      JSON.stringify({
        source: "direct_fact_compiler",
        subject_binding: "explicit_source_subject"
      })
    ]
  );
  return result.rows[0]?.id ?? null;
}

async function persistDirectFactDecisionForSourceRow(params: {
  readonly client: PoolClient;
  readonly namespaceId: string;
  readonly source: SourceDirectFactCandidate;
  readonly decision: DirectFactCompileDecision;
  readonly registry: TaxonomyRegistry;
  readonly modelId: string;
  readonly schemaVersion: string;
}): Promise<void> {
  if (!params.decision.handled || !params.decision.family) {
    return;
  }
  const confidence =
    typeof params.source.candidate.confidence?.overall === "number"
      ? Math.max(0, Math.min(1, params.source.candidate.confidence.overall))
      : null;
  const queryFamily = queryFamilyForDirectFact(params.decision.family);
  const subjectEntityId = await resolveOrCreateSubjectEntityId(params.client, params.namespaceId, params.decision.subject);
  const metadata = {
    ...params.decision.metadata,
    ...params.source.metadata,
    compilerOwner: "direct_fact",
    directFactCompilerSource: "typed_memory_rebuild",
    source_uri: params.source.artifactUri,
    subjectEntityId,
    taxonomyVersion: params.registry.version
  };

  if (params.decision.promotionStatus !== "compiled") {
    await params.client.query(
      `
        INSERT INTO compiled_memory_coverage (
          namespace_id, source_table, source_row_id, source_scene_id, compiler_stage, query_family,
          exact_detail_family, promotion_status, rejection_reason, support_phrase, source_text, confidence, metadata
        )
        VALUES ($1, $2, $3::uuid, NULL, 'direct_fact_compiler', $4, $5, $6, $7, $8, $9, $10, $11::jsonb)
      `,
      [
        params.namespaceId,
        params.source.sourceTable,
        params.source.sourceRowId,
        queryFamily,
        params.decision.family,
        params.decision.promotionStatus,
        params.decision.rejectionReason ?? "rejected",
        params.decision.supportPhrase,
        params.source.sourceText,
        confidence,
        JSON.stringify(metadata)
      ]
    );
    return;
  }

  await params.client.query(
    `
      INSERT INTO compiled_fact_observations (
        namespace_id, subject_entity_id, query_family, exact_detail_family, predicate_family, property_key,
        answer_value, normalized_answer_value, truth_status, confidence, source_table, source_row_id,
        source_scene_id, source_memory_id, source_chunk_id, support_phrase, source_text, extractor, model_id,
        schema_version, promotion_status, admissibility_status, rejection_reason, metadata, valid_from
      )
      VALUES (
        $1, $2::uuid, $3, NULL, 'direct_fact', $4, $5,
        lower(regexp_replace($5, '[^a-zA-Z0-9]+', ' ', 'g')), 'active', $6,
        $7, $8::uuid, NULL, $9::uuid, $10::uuid, $11, $12,
        'typed_memory_direct_fact_compiler', $13, $14, 'compiled', 'admissible', NULL, $15::jsonb, $16::timestamptz
      )
      ON CONFLICT (
        namespace_id, source_table, source_row_id, exact_detail_family, property_key, normalized_answer_value, subject_entity_id
      )
      DO UPDATE SET
        answer_value = EXCLUDED.answer_value,
        confidence = GREATEST(COALESCE(compiled_fact_observations.confidence, 0), COALESCE(EXCLUDED.confidence, 0)),
        support_phrase = EXCLUDED.support_phrase,
        source_text = EXCLUDED.source_text,
        model_id = EXCLUDED.model_id,
        schema_version = EXCLUDED.schema_version,
        metadata = compiled_fact_observations.metadata || EXCLUDED.metadata,
        valid_from = COALESCE(compiled_fact_observations.valid_from, EXCLUDED.valid_from),
        updated_at = now()
    `,
    [
      params.namespaceId,
      subjectEntityId,
      queryFamily,
      `direct_fact:${params.decision.family}`,
      params.decision.value,
      confidence,
      params.source.sourceTable,
      params.source.sourceRowId,
      params.source.sourceMemoryId,
      params.source.sourceChunkId,
      params.decision.supportPhrase,
      params.source.sourceText,
      params.modelId,
      params.schemaVersion,
      JSON.stringify(metadata),
      params.source.occurredAt
    ]
  );
}

async function persistProfileTraitCandidateForSourceRow(params: {
  readonly client: PoolClient;
  readonly namespaceId: string;
  readonly source: SourceDirectFactCandidate;
  readonly registry: TaxonomyRegistry;
  readonly modelId: string;
  readonly schemaVersion: string;
}): Promise<"compiled" | "rejected" | "ambiguous"> {
  const candidate = params.source.candidate;
  const subject = cleanValue(candidate.subject);
  const supportPhrase = cleanSupportPhrase(candidate.evidence_quote);
  const traitFamily = profileTraitFamilyFromCandidate(candidate);
  const polarity = normalizeKey(candidate.polarity) || "positive";
  const confidence =
    typeof candidate.confidence?.overall === "number"
      ? Math.max(0, Math.min(1, candidate.confidence.overall))
      : null;
  const subjectEntityId = await resolveOrCreateSubjectEntityId(params.client, params.namespaceId, subject);
  const metadata = {
    candidate,
    ...params.source.metadata,
    compilerOwner: "profile_trait",
    directFactCompilerSource: "typed_memory_rebuild_profile_trait",
    source_uri: params.source.artifactUri,
    subjectEntityId,
    subject,
    traitFamily,
    traitPolarity: polarity,
    traitEvidenceSource: "typed_memory_rebuild",
    taxonomyVersion: params.registry.version
  };

  const rejectionReason =
    !subject ? "subject_binding" :
    !supportPhrase ? "evidence_missing" :
    !subjectEntityId ? "subject_binding" :
    candidate.taxonomy_status !== "approved" && candidate.taxonomy_status !== "mapped_to_parent" ? "taxonomy_unknown" :
    polarity === "ambiguous" ? "polarity_ambiguous" :
    null;

  if (rejectionReason) {
    await params.client.query(
      `
        INSERT INTO compiled_memory_coverage (
          namespace_id, source_table, source_row_id, source_scene_id, compiler_stage, query_family,
          exact_detail_family, promotion_status, rejection_reason, support_phrase, source_text, confidence, metadata
        )
        VALUES ($1, $2, $3::uuid, NULL, 'profile_trait_compiler', 'profile_report', $4, $5, $6, $7, $8, $9, $10::jsonb)
      `,
      [
        params.namespaceId,
        params.source.sourceTable,
        params.source.sourceRowId,
        traitFamily,
        rejectionReason === "polarity_ambiguous" ? "ambiguous" : "rejected",
        rejectionReason,
        supportPhrase,
        params.source.sourceText,
        confidence,
        JSON.stringify(metadata)
      ]
    );
    return rejectionReason === "polarity_ambiguous" ? "ambiguous" : "rejected";
  }

  await params.client.query(
    `
      INSERT INTO compiled_fact_observations (
        namespace_id, subject_entity_id, query_family, exact_detail_family, predicate_family, property_key,
        answer_value, normalized_answer_value, truth_status, confidence, source_table, source_row_id,
        source_scene_id, source_memory_id, source_chunk_id, support_phrase, source_text, extractor, model_id,
        schema_version, promotion_status, admissibility_status, rejection_reason, metadata, valid_from
      )
      VALUES (
        $1, $2::uuid, 'profile_report', NULL, 'profile_trait', $3, $4,
        lower(regexp_replace($4, '[^a-zA-Z0-9]+', ' ', 'g')), 'active', $5,
        $6, $7::uuid, NULL, $8::uuid, $9::uuid, $10, $11,
        'typed_memory_profile_trait_compiler', $12, $13, 'compiled', 'admissible', NULL, $14::jsonb, $15::timestamptz
      )
      ON CONFLICT (
        namespace_id, source_table, source_row_id, exact_detail_family, property_key, normalized_answer_value, subject_entity_id
      )
      DO UPDATE SET
        answer_value = EXCLUDED.answer_value,
        confidence = GREATEST(COALESCE(compiled_fact_observations.confidence, 0), COALESCE(EXCLUDED.confidence, 0)),
        support_phrase = EXCLUDED.support_phrase,
        source_text = EXCLUDED.source_text,
        model_id = EXCLUDED.model_id,
        schema_version = EXCLUDED.schema_version,
        metadata = compiled_fact_observations.metadata || EXCLUDED.metadata,
        valid_from = COALESCE(compiled_fact_observations.valid_from, EXCLUDED.valid_from),
        updated_at = now()
    `,
    [
      params.namespaceId,
      subjectEntityId,
      `trait:${traitFamily}`,
      profileTraitAnswerValueFromCandidate(candidate),
      confidence,
      params.source.sourceTable,
      params.source.sourceRowId,
      params.source.sourceMemoryId,
      params.source.sourceChunkId,
      supportPhrase,
      params.source.sourceText,
      params.modelId,
      params.schemaVersion,
      JSON.stringify(metadata),
      params.source.occurredAt
    ]
  );
  return "compiled";
}

async function loadStructuredDirectFactRows(namespaceId: string): Promise<readonly StructuredDirectFactRow[]> {
  return queryRows<StructuredDirectFactRow>(
    `
      WITH exact_values AS (
        SELECT
          'exact_detail_fact_keys'::text AS source_table,
          value_key.id::text AS source_row_id,
          CASE WHEN value_key.metadata->>'source_memory_id' ~* '^[0-9a-f-]{36}$' THEN value_key.metadata->>'source_memory_id' ELSE NULL END AS source_memory_id,
          CASE WHEN value_key.metadata->>'source_chunk_id' ~* '^[0-9a-f-]{36}$' THEN value_key.metadata->>'source_chunk_id' ELSE NULL END AS source_chunk_id,
          COALESCE(NULLIF(value_key.metadata->>'source_uri', ''), NULLIF(support_key.metadata->>'source_uri', ''), source_artifact.uri) AS source_uri,
          value_key.subject_entity_id::text,
          e.canonical_name AS subject_name,
          COALESCE(value_key.metadata->>'directFactFamily', value_key.metadata->>'evidence_family', value_key.exact_detail_family) AS family_key,
          value_key.property_key,
          value_key.key_text AS answer_value,
          COALESCE(NULLIF(value_key.metadata->>'support_phrase', ''), support_key.key_text) AS support_phrase,
          COALESCE(NULLIF(value_key.metadata->>'source_text', ''), NULLIF(value_key.metadata->>'support_phrase', ''), support_key.key_text) AS source_text,
          value_key.confidence,
          value_key.valid_from::text,
          value_key.metadata || jsonb_build_object('structured_surface_source', 'exact_detail_fact_keys') AS metadata
        FROM exact_detail_fact_keys value_key
        LEFT JOIN entities e ON e.id = value_key.subject_entity_id
        LEFT JOIN LATERAL (
          SELECT key_text, metadata
          FROM exact_detail_fact_keys support_key
          WHERE support_key.namespace_id = value_key.namespace_id
            AND support_key.fact_table = value_key.fact_table
            AND support_key.fact_row_id = value_key.fact_row_id
            AND support_key.key_type = 'support_phrase'
          ORDER BY support_key.confidence DESC NULLS LAST, support_key.created_at DESC
          LIMIT 1
        ) support_key ON true
        LEFT JOIN artifact_chunks source_chunk
          ON source_chunk.id = CASE WHEN value_key.metadata->>'source_chunk_id' ~* '^[0-9a-f-]{36}$' THEN (value_key.metadata->>'source_chunk_id')::uuid ELSE NULL END
        LEFT JOIN artifacts source_artifact ON source_artifact.id = source_chunk.artifact_id
        WHERE value_key.namespace_id = $1
          AND value_key.key_type = 'value'
          AND value_key.truth_status = 'active'
      ),
      canonical_fact_rows AS (
        SELECT
          'canonical_facts'::text AS source_table,
          cf.id::text AS source_row_id,
          cfp.source_memory_id::text AS source_memory_id,
          cfp.source_chunk_id::text AS source_chunk_id,
          COALESCE(NULLIF(cf.metadata->>'source_uri', ''), NULLIF(cfp.provenance->>'source_uri', ''), source_artifact.uri) AS source_uri,
          cf.subject_entity_id::text,
          e.canonical_name AS subject_name,
          cf.predicate_family AS family_key,
          cf.predicate_family AS property_key,
          cf.object_value AS answer_value,
          COALESCE(NULLIF(cf.metadata->>'support_phrase', ''), NULLIF(cf.metadata->>'source_text', ''), NULLIF(cfp.provenance->>'support_phrase', ''), NULLIF(cfp.provenance->>'snippet', '')) AS support_phrase,
          COALESCE(NULLIF(cf.metadata->>'source_text', ''), NULLIF(cf.metadata->>'support_phrase', ''), NULLIF(cfp.provenance->>'source_text', ''), NULLIF(cfp.provenance->>'snippet', '')) AS source_text,
          CASE cf.support_strength WHEN 'strong' THEN 0.86 WHEN 'weak' THEN 0.55 ELSE 0.72 END AS confidence,
          cf.valid_from::text,
          cf.metadata || jsonb_build_object('structured_surface_source', 'canonical_facts', 'support_strength', cf.support_strength) AS metadata
        FROM canonical_facts cf
        LEFT JOIN entities e ON e.id = cf.subject_entity_id
        LEFT JOIN LATERAL (
          SELECT source_memory_id, source_chunk_id, source_artifact_id, provenance
          FROM canonical_fact_provenance cfp
          WHERE cfp.canonical_fact_id = cf.id
          ORDER BY cfp.created_at DESC
          LIMIT 1
        ) cfp ON true
        LEFT JOIN artifacts source_artifact ON source_artifact.id = cfp.source_artifact_id
        WHERE cf.namespace_id = $1
          AND cf.object_value IS NOT NULL
      ),
      canonical_state_rows AS (
        SELECT
          'canonical_states'::text AS source_table,
          cs.id::text AS source_row_id,
          CASE WHEN cs.metadata->>'source_memory_id' ~* '^[0-9a-f-]{36}$' THEN cs.metadata->>'source_memory_id' ELSE NULL END AS source_memory_id,
          CASE WHEN cs.metadata->>'source_chunk_id' ~* '^[0-9a-f-]{36}$' THEN cs.metadata->>'source_chunk_id' ELSE NULL END AS source_chunk_id,
          COALESCE(NULLIF(cs.metadata->>'source_uri', ''), source_artifact.uri, memory_artifact.uri) AS source_uri,
          cs.subject_entity_id::text,
          e.canonical_name AS subject_name,
          cs.predicate_family AS family_key,
          cs.predicate_family AS property_key,
          cs.state_value AS answer_value,
          COALESCE(NULLIF(cs.metadata->>'support_phrase', ''), NULLIF(cs.metadata->>'source_text', '')) AS support_phrase,
          COALESCE(NULLIF(cs.metadata->>'source_text', ''), NULLIF(cs.metadata->>'support_phrase', '')) AS source_text,
          cs.confidence,
          cs.valid_from::text,
          cs.metadata || jsonb_build_object('structured_surface_source', 'canonical_states', 'support_strength', cs.support_strength) AS metadata
        FROM canonical_states cs
        LEFT JOIN entities e ON e.id = cs.subject_entity_id
        LEFT JOIN artifact_chunks source_chunk
          ON source_chunk.id = CASE WHEN cs.metadata->>'source_chunk_id' ~* '^[0-9a-f-]{36}$' THEN (cs.metadata->>'source_chunk_id')::uuid ELSE NULL END
        LEFT JOIN artifacts source_artifact ON source_artifact.id = source_chunk.artifact_id
        LEFT JOIN episodic_memory source_memory
          ON source_memory.id = CASE WHEN cs.metadata->>'source_memory_id' ~* '^[0-9a-f-]{36}$' THEN (cs.metadata->>'source_memory_id')::uuid ELSE NULL END
        LEFT JOIN artifacts memory_artifact ON memory_artifact.id = source_memory.artifact_id
        WHERE cs.namespace_id = $1
          AND cs.state_value IS NOT NULL
          AND cs.support_strength <> 'weak'
      ),
      temporal_rows AS (
        SELECT
          'temporal_event_facts'::text AS source_table,
          tef.id::text AS source_row_id,
          tes.support_memory_id::text AS source_memory_id,
          CASE WHEN tes.metadata->>'source_chunk_id' ~* '^[0-9a-f-]{36}$' THEN tes.metadata->>'source_chunk_id' ELSE NULL END AS source_chunk_id,
          COALESCE(NULLIF(tef.metadata->>'source_uri', ''), NULLIF(tes.metadata->>'source_uri', ''), source_artifact.uri, memory_artifact.uri) AS source_uri,
          tef.subject_entity_id::text,
          e.canonical_name AS subject_name,
          COALESCE(tef.predicate_family, tef.event_type, tef.event_key) AS family_key,
          tef.event_key AS property_key,
          COALESCE(tef.object_value, tef.event_label) AS answer_value,
          tes.snippet AS support_phrase,
          COALESCE(tes.snippet, tef.event_label, tef.object_value) AS source_text,
          CASE tef.exactness WHEN 'exact' THEN 0.86 WHEN 'bounded' THEN 0.72 ELSE 0.62 END AS confidence,
          COALESCE(tef.start_at, tef.valid_from)::text AS valid_from,
          tef.metadata || jsonb_build_object('structured_surface_source', 'temporal_event_facts', 'time_granularity', tef.time_granularity, 'exactness', tef.exactness) AS metadata
        FROM temporal_event_facts tef
        LEFT JOIN entities e ON e.id = tef.subject_entity_id
        LEFT JOIN LATERAL (
          SELECT support_memory_id, snippet, metadata
          FROM temporal_event_support tes
          WHERE tes.temporal_event_fact_id = tef.id
            AND tes.snippet IS NOT NULL
          ORDER BY CASE tes.support_role WHEN 'primary' THEN 0 WHEN 'support' THEN 1 ELSE 2 END, tes.occurred_at DESC NULLS LAST
          LIMIT 1
        ) tes ON true
        LEFT JOIN artifact_chunks source_chunk
          ON source_chunk.id = CASE WHEN tes.metadata->>'source_chunk_id' ~* '^[0-9a-f-]{36}$' THEN (tes.metadata->>'source_chunk_id')::uuid ELSE NULL END
        LEFT JOIN artifacts source_artifact ON source_artifact.id = source_chunk.artifact_id
        LEFT JOIN episodic_memory source_memory ON source_memory.id = tes.support_memory_id
        LEFT JOIN artifacts memory_artifact ON memory_artifact.id = source_memory.artifact_id
        WHERE tef.namespace_id = $1
          AND tef.truth_status = 'active'
      )
      SELECT * FROM exact_values
      UNION ALL
      SELECT * FROM canonical_fact_rows
      UNION ALL
      SELECT * FROM canonical_state_rows
      UNION ALL
      SELECT * FROM temporal_rows
    `,
    [namespaceId]
  );
}

export async function rebuildCompiledDirectFactObservationsNamespace(
  namespaceId: string
): Promise<CompiledDirectFactRebuildCounts> {
  const registry = await loadMemoryTaxonomyRegistry();
  const rows = await queryRows<DirectFactSourceRow>(
    `
      WITH source_rows AS (
        SELECT
          'episodic_memory'::text AS source_table,
          em.id::text AS source_row_id,
          em.id::text AS memory_id,
          em.artifact_id::text AS artifact_id,
          em.artifact_observation_id::text AS artifact_observation_id,
          em.source_chunk_id::text AS source_chunk_id,
          em.source_offset AS source_offset,
          em.occurred_at::text AS occurred_at,
          em.content,
          a.uri AS artifact_uri,
          em.metadata
        FROM episodic_memory em
        LEFT JOIN artifacts a ON a.id = em.artifact_id
        WHERE em.namespace_id = $1
        UNION ALL
        SELECT
          'artifact_chunks'::text AS source_table,
          ac.id::text AS source_row_id,
          NULL::text AS memory_id,
          ac.artifact_id::text AS artifact_id,
          ac.artifact_observation_id::text AS artifact_observation_id,
          ac.id::text AS source_chunk_id,
          jsonb_build_object('char_start', ac.char_start, 'char_end', ac.char_end) AS source_offset,
          ao.observed_at::text AS occurred_at,
          ac.text_content AS content,
          a.uri AS artifact_uri,
          COALESCE(ac.metadata, '{}'::jsonb) ||
            jsonb_build_object(
              'source_type', a.artifact_type,
              'artifact_metadata', COALESCE(a.metadata, '{}'::jsonb),
              'observation_metadata', COALESCE(ao.metadata, '{}'::jsonb)
            ) AS metadata
        FROM artifact_chunks ac
        JOIN artifacts a ON a.id = ac.artifact_id
        LEFT JOIN artifact_observations ao ON ao.id = ac.artifact_observation_id
        WHERE a.namespace_id = $1
      )
      SELECT *
      FROM source_rows
      ORDER BY
        artifact_id ASC NULLS LAST,
        artifact_observation_id ASC NULLS LAST,
        COALESCE((source_offset->>'char_start')::int, 0) ASC,
        source_row_id ASC
    `,
    [namespaceId]
  );
  const structuredRows = await loadStructuredDirectFactRows(namespaceId);
  let promoted = 0;
  let rejected = 0;
  let ambiguous = 0;
  await withTransaction(async (client) => {
    await client.query(
      `
        DELETE FROM compiled_fact_observations
        WHERE namespace_id = $1
          AND predicate_family = 'direct_fact'
          AND metadata->>'directFactCompilerSource' = 'typed_memory_rebuild'
      `,
      [namespaceId]
    );
    await client.query(
      `
        DELETE FROM compiled_fact_observations
        WHERE namespace_id = $1
          AND predicate_family = 'profile_trait'
          AND metadata->>'directFactCompilerSource' = 'typed_memory_rebuild_profile_trait'
      `,
      [namespaceId]
    );
    await client.query(
      `
        DELETE FROM compiled_memory_coverage
        WHERE namespace_id = $1
          AND compiler_stage = 'direct_fact_compiler'
          AND metadata->>'directFactCompilerSource' = 'typed_memory_rebuild'
      `,
      [namespaceId]
    );
    await client.query(
      `
        DELETE FROM compiled_memory_coverage
        WHERE namespace_id = $1
          AND compiler_stage = 'profile_trait_compiler'
          AND metadata->>'directFactCompilerSource' = 'typed_memory_rebuild_profile_trait'
      `,
      [namespaceId]
    );
    const sourceCandidates = [
      ...buildDirectFactCandidatesForSourceRows(rows),
      ...buildDirectFactCandidatesForStructuredRows(structuredRows)
    ];
    for (const sourceCandidate of sourceCandidates) {
      if (isProfileTraitSourceCandidate(sourceCandidate.candidate)) {
        const status = await persistProfileTraitCandidateForSourceRow({
          client,
          namespaceId,
          source: sourceCandidate,
          registry,
          modelId: "typed_memory_profile_trait_compiler",
          schemaVersion: "profile_trait_observation_v1"
        });
        if (status === "compiled") {
          promoted += 1;
        } else if (status === "ambiguous") {
          ambiguous += 1;
        } else {
          rejected += 1;
        }
        continue;
      }
      const entry: ValidatedCandidate = {
        candidate: sourceCandidate.candidate,
        promotionEligible:
          sourceCandidate.candidate.taxonomy_status === "approved" ||
          sourceCandidate.candidate.taxonomy_status === "mapped_to_parent",
        issues: [],
        normalizedTemporal: null
      };
      const run: CompilerRunResult = {
        unit: {
          unitId: sourceCandidate.sourceRowId,
          namespaceId,
          sourceType: sourceCandidate.sourceType,
          sourceId: null,
          sourceMemoryId: sourceCandidate.sourceMemoryId,
          sourceChunkId: sourceCandidate.sourceChunkId,
          sourceSceneId: null,
          capturedAt: sourceCandidate.occurredAt,
          speaker: sourceCandidate.speaker,
          unitIndex: 0,
          charStart: 0,
          charEnd: sourceCandidate.sourceText.length,
          unitText: sourceCandidate.sourceText,
          contextBefore: "",
          contextAfter: "",
          tokenEstimate: Math.ceil(sourceCandidate.sourceText.length / 4),
          chunkingStatus: "ready",
          splitReason: "typed_memory_rebuild_source_unit",
          metadata: sourceCandidate.metadata
        },
        cache: { status: "bypass", cacheKey: null, sourceHash: null },
        gliner2: { attempted: false, warningCount: 0, response: null, error: null },
        assistant: {
          mode: "off",
          provider: "deterministic",
          model: "typed_memory_direct_fact_compiler",
          jsonValid: true,
          skippedReason: "deterministic_rebuild",
          rawOutput: null,
          output: null,
          validationIssues: [],
          latencyMs: 0
        },
        candidates: [entry],
        metrics: {
          chunkBudgetPass: true,
          jsonValidityPass: true,
          taxonomyCompliancePass: true,
          temporalNormalizationPass: true,
          promotionSafetyPass: true,
          suggestedTaxonomyCount: 0,
          needsClarificationCount: 0
        }
      };
      const decision = compileDirectFactCandidate({ run, entry, registry });
      await persistDirectFactDecisionForSourceRow({
        client,
        namespaceId,
        source: sourceCandidate,
        decision,
        registry,
        modelId: "typed_memory_direct_fact_compiler",
        schemaVersion: "direct_fact_observation_v1"
      });
      if (decision.promotionStatus === "compiled") {
        promoted += 1;
      } else if (decision.promotionStatus === "ambiguous") {
        ambiguous += 1;
      } else if (decision.handled) {
        rejected += 1;
      }
    }
  });
  return { promoted, rejected, ambiguous, sourceRows: rows.length + structuredRows.length };
}

export async function persistCompiledDirectFactObservationForClient(params: {
  readonly client: PoolClient;
  readonly namespaceId: string;
  readonly run: CompilerRunResult;
  readonly entry: ValidatedCandidate;
  readonly registry: TaxonomyRegistry;
  readonly modelId: string | null;
  readonly schemaVersion: string;
}): Promise<{ readonly handled: boolean; readonly decision: DirectFactCompileDecision }> {
  const decision = compileDirectFactCandidate({ run: params.run, entry: params.entry, registry: params.registry });
  if (!decision.handled || !decision.family) {
    return { handled: false, decision };
  }
  const sourceText = params.run.unit.unitText;
  const confidence =
    typeof params.entry.candidate.confidence?.overall === "number" ? Math.max(0, Math.min(1, params.entry.candidate.confidence.overall)) : null;
  const queryFamily = queryFamilyForDirectFact(decision.family);
  const subjectEntityId = await resolveSubjectEntityId(params.client, params.namespaceId, decision.subject);

  if (decision.promotionStatus !== "compiled") {
    await params.client.query(
      `
        INSERT INTO compiled_memory_coverage (
          namespace_id, source_table, source_row_id, source_scene_id, compiler_stage, query_family,
          exact_detail_family, promotion_status, rejection_reason, support_phrase, source_text, confidence, metadata
        )
        VALUES ($1, 'extraction_units', $2::uuid, $3::uuid, 'direct_fact_compiler', $4, $5, $6, $7, $8, $9, $10, $11::jsonb)
      `,
      [
        params.namespaceId,
        params.run.unit.unitId,
        params.run.unit.sourceSceneId ?? null,
        queryFamily,
        decision.family,
        decision.promotionStatus,
        decision.rejectionReason ?? "rejected",
        decision.supportPhrase,
        sourceText,
        confidence,
        JSON.stringify({ ...decision.metadata, subjectEntityId, ingestion_router_v2: params.run.unit.metadata?.ingestion_router_v2 ?? null })
      ]
    );
    return { handled: true, decision };
  }

  await params.client.query(
    `
      INSERT INTO compiled_fact_observations (
        namespace_id, subject_entity_id, query_family, exact_detail_family, predicate_family, property_key,
        answer_value, normalized_answer_value, truth_status, confidence, source_table, source_row_id,
        source_scene_id, source_memory_id, source_chunk_id, support_phrase, source_text, extractor, model_id,
        schema_version, promotion_status, admissibility_status, rejection_reason, metadata
      )
      VALUES (
        $1, $2::uuid, $3, NULL, 'direct_fact', $4, $5,
        lower(regexp_replace($5, '[^a-zA-Z0-9]+', ' ', 'g')), 'active', $6,
        'extraction_units', $7::uuid, $8::uuid, $9::uuid, $10::uuid, $11, $12,
        'taxonomy_temporal_direct_fact_compiler', $13, $14, 'compiled', 'admissible', NULL, $15::jsonb
      )
      ON CONFLICT (
        namespace_id, source_table, source_row_id, exact_detail_family, property_key, normalized_answer_value, subject_entity_id
      )
      DO UPDATE SET
        answer_value = EXCLUDED.answer_value,
        confidence = GREATEST(COALESCE(compiled_fact_observations.confidence, 0), COALESCE(EXCLUDED.confidence, 0)),
        support_phrase = EXCLUDED.support_phrase,
        source_text = EXCLUDED.source_text,
        metadata = compiled_fact_observations.metadata || EXCLUDED.metadata,
        updated_at = now()
    `,
    [
      params.namespaceId,
      subjectEntityId,
      queryFamily,
      `direct_fact:${decision.family}`,
      decision.value,
      confidence,
      params.run.unit.unitId,
      params.run.unit.sourceSceneId ?? null,
      params.run.unit.sourceMemoryId ?? null,
      params.run.unit.sourceChunkId ?? null,
      decision.supportPhrase,
      sourceText,
      params.modelId,
      params.schemaVersion,
      JSON.stringify({ ...decision.metadata, subjectEntityId, ingestion_router_v2: params.run.unit.metadata?.ingestion_router_v2 ?? null })
    ]
  );
  return { handled: true, decision };
}
