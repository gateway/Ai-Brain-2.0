import { normalizeEntityLookupName } from "../identity/canonicalization.js";
import type { RecallResult } from "../types.js";

function normalize(value: string | null | undefined): string {
  return String(value ?? "").trim();
}

function uniqueNormalized(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => normalize(value)).filter(Boolean))];
}

function readResultMetadata(result: RecallResult): Record<string, unknown> | null {
  return typeof result.provenance.metadata === "object" && result.provenance.metadata !== null
    ? (result.provenance.metadata as Record<string, unknown>)
    : null;
}

export function extractStructuredContentRecord(value: string | null | undefined): Record<string, unknown> | null {
  const normalized = normalize(value);
  if (!normalized.startsWith("{")) {
    return null;
  }
  try {
    const parsed = JSON.parse(normalized);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function readStructuredContentString(
  value: string | null | undefined,
  key: string
): string | null {
  const record = extractStructuredContentRecord(value);
  const fieldValue = record?.[key];
  return typeof fieldValue === "string" && normalize(fieldValue) ? normalize(fieldValue) : null;
}

export function extractStructuredClaimText(value: string | null | undefined): string | null {
  const normalized = normalize(value);
  if (!normalized) {
    return null;
  }
  const record = extractStructuredContentRecord(value);
  if (!record) {
    return normalized;
  }
  const directText =
    (typeof record.text === "string" ? normalize(record.text) : "") ||
    (typeof record.claimText === "string" ? normalize(record.claimText) : "") ||
    (typeof record.claim_text === "string" ? normalize(record.claim_text) : "") ||
    (typeof record.summary === "string" ? normalize(record.summary) : "") ||
    (typeof record.summary_text === "string" ? normalize(record.summary_text) : "") ||
    (typeof record.source_turn_text === "string" ? normalize(record.source_turn_text) : "") ||
    (typeof record.source_sentence_text === "string" ? normalize(record.source_sentence_text) : "") ||
    (typeof record.leaf_fact_text === "string" ? normalize(record.leaf_fact_text) : "") ||
    (typeof record.fact_value === "string" ? normalize(record.fact_value) : "");
  if (directText) {
    return directText;
  }
  const answerPayload =
    typeof record.answer_payload === "object" && record.answer_payload !== null
      ? (record.answer_payload as Record<string, unknown>)
      : null;
  const answerValue = typeof answerPayload?.answer_value === "string" ? normalize(answerPayload.answer_value) : "";
  return answerValue || normalized;
}

export function collectRecallResultTextCandidates(result: RecallResult): readonly string[] {
  const metadata = readResultMetadata(result);
  return uniqueNormalized([
    typeof metadata?.source_turn_text === "string" ? metadata.source_turn_text : "",
    typeof metadata?.source_sentence_text === "string" ? metadata.source_sentence_text : "",
    typeof metadata?.sentence_text === "string" ? metadata.sentence_text : "",
    typeof metadata?.fact_value === "string" ? metadata.fact_value : "",
    typeof metadata?.anchor_text === "string" ? metadata.anchor_text : "",
    typeof metadata?.event_surface_text === "string" ? metadata.event_surface_text : "",
    typeof metadata?.location_surface_text === "string" ? metadata.location_surface_text : "",
    typeof metadata?.leaf_fact_text === "string" ? metadata.leaf_fact_text : "",
    typeof metadata?.leaf_time_hint_text === "string" ? metadata.leaf_time_hint_text : "",
    typeof metadata?.leaf_location_text === "string" ? metadata.leaf_location_text : "",
    readStructuredContentString(result.content, "source_turn_text") ?? "",
    readStructuredContentString(result.content, "source_sentence_text") ?? "",
    readStructuredContentString(result.content, "fact_value") ?? "",
    readStructuredContentString(result.content, "anchor_text") ?? "",
    readStructuredContentString(result.content, "event_surface_text") ?? "",
    readStructuredContentString(result.content, "location_surface_text") ?? "",
    readStructuredContentString(result.content, "leaf_fact_text") ?? "",
    extractStructuredClaimText(result.content) ?? "",
    normalize(result.content)
  ]);
}

export function collectObservationMetadataTextCandidates(result: RecallResult): readonly string[] {
  const metadata = readResultMetadata(result);
  return uniqueNormalized([
    typeof result.provenance.query === "string" ? result.provenance.query : "",
    typeof result.provenance.blip_caption === "string" ? result.provenance.blip_caption : "",
    typeof metadata?.query === "string" ? metadata.query : "",
    typeof metadata?.blip_caption === "string" ? metadata.blip_caption : "",
    typeof metadata?.image_query === "string" ? metadata.image_query : "",
    typeof metadata?.image_caption === "string" ? metadata.image_caption : ""
  ]);
}

export function extractInlineSubjectSignalsFromText(value: string | null | undefined): readonly string[] {
  const normalized = normalize(value);
  if (!normalized) {
    return [];
  }
  const matches = [
    ...normalized.matchAll(/(?:^|[\n\r])\s*([A-Z][A-Za-z.'-]{1,40}(?:\s+[A-Z][A-Za-z.'-]{1,40}){0,2})\s*:/gu),
    ...normalized.matchAll(
      /\b([A-Z][A-Za-z.'-]{1,40}(?:\s+[A-Z][A-Za-z.'-]{1,40}){0,2})\s+(?:started|began|joined|achieved|scored|performed|went|was|is|had)\b/gu
    ),
    ...normalized.matchAll(/\bparticipant-bound turn for\s+([A-Z][A-Za-z.'-]{1,40}(?:\s+[A-Z][A-Za-z.'-]{1,40}){0,2})\b/giu)
  ]
    .map((match) => match[1] ?? "")
    .map((candidate) => normalize(candidate))
    .filter(Boolean);
  return uniqueNormalized(matches).map((candidate) => normalizeEntityLookupName(candidate));
}

export function extractRecallResultSubjectSignals(result: RecallResult): readonly string[] {
  const metadata = readResultMetadata(result);
  const participantNames = Array.isArray(metadata?.participant_names) ? metadata.participant_names : [];
  const inlineSignals = collectRecallResultTextCandidates(result).flatMap((value) =>
    extractInlineSubjectSignalsFromText(value)
  );
  return [
    result.provenance.subject_name,
    result.provenance.object_name,
    result.provenance.transcript_speaker_name,
    result.provenance.speaker_name,
    typeof metadata?.subject_name === "string" ? metadata.subject_name : null,
    typeof metadata?.object_name === "string" ? metadata.object_name : null,
    typeof metadata?.transcript_speaker_name === "string" ? metadata.transcript_speaker_name : null,
    typeof metadata?.speaker_name === "string" ? metadata.speaker_name : null,
    ...participantNames,
    ...inlineSignals
  ]
    .filter((value): value is string => typeof value === "string" && normalize(value).length > 0)
    .map((value) => normalizeEntityLookupName(value));
}
