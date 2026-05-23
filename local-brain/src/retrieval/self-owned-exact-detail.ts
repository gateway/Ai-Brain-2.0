import type { RecallResult } from "../types.js";
import { inferExactDetailQuestionFamily } from "./exact-detail-question-family.js";
import { extractEntityNameHints } from "./query-entity-focus.js";

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function isFirstPersonQueryText(queryText: string): boolean {
  return /\b(?:my|mine|me|i|i'm|i’ve|i've|i’d|i'd|i’ll|i'll)\b/iu.test(queryText);
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

function sourceTextHasFirstPersonOwnershipCue(text: string): boolean {
  const normalized = normalizeWhitespace(text);
  if (!normalized) {
    return false;
  }
  return /^(?:[A-Z][a-z]+:\s*)?(?:i\b|i'm\b|i’ve\b|i've\b|i’d\b|i'd\b|my\b|me\b|we\b|our\b)/iu.test(normalized);
}

function sourceTextHasAssistantAddressedOwnershipCue(text: string): boolean {
  const normalized = normalizeWhitespace(text);
  if (!normalized) {
    return false;
  }
  return /^(?:[A-Z][a-z]+:\s*)?(?:you\b|you're\b|you’re\b|you've\b|you’ve\b|you'd\b|you’d\b|your\b)/iu.test(normalized);
}

function resultHasFirstPersonOwnershipCue(result: RecallResult): boolean {
  const metadata =
    typeof result.provenance.metadata === "object" && result.provenance.metadata !== null
      ? (result.provenance.metadata as Record<string, unknown>)
      : null;
  const directSignals = [
    result.provenance.subject_name,
    result.provenance.speaker_name,
    result.provenance.transcript_speaker_name,
    metadata?.subject_name,
    metadata?.speaker_name,
    metadata?.primary_speaker_name
  ]
    .map((value) => (typeof value === "string" ? normalizeWhitespace(value).toLowerCase() : ""))
    .filter(Boolean);
  if (
    directSignals.some((signal) =>
      signal === "self" ||
      signal === "owner" ||
      signal.startsWith("self:") ||
      signal.startsWith("owner:")
    )
  ) {
    return true;
  }
  if (sourceTextHasFirstPersonOwnershipCue(result.content)) {
    return true;
  }
  return recallResultSourceTexts(result).some((text) => sourceTextHasFirstPersonOwnershipCue(text));
}

function supportsSelfOwnedExactDetailOwnershipBridge(queryText: string): boolean {
  return isFirstPersonQueryText(queryText) && inferExactDetailQuestionFamily(queryText) !== "generic";
}

function resultHasAssistantAddressedOwnershipCueForExactDetail(
  queryText: string,
  result: RecallResult
): boolean {
  if (!supportsSelfOwnedExactDetailOwnershipBridge(queryText)) {
    return false;
  }

  const texts = [result.content, ...recallResultSourceTexts(result)];
  if (!texts.some((text) => sourceTextHasAssistantAddressedOwnershipCue(text))) {
    return false;
  }

  const metadata =
    typeof result.provenance.metadata === "object" && result.provenance.metadata !== null
      ? (result.provenance.metadata as Record<string, unknown>)
      : null;
  const directSignals = [
    result.provenance.subject_name,
    result.provenance.speaker_name,
    result.provenance.transcript_speaker_name,
    metadata?.subject_name,
    metadata?.speaker_name,
    metadata?.primary_speaker_name,
    metadata?.transcript_speaker_name,
    metadata?.owner_entity_hint
  ]
    .map((value) => (typeof value === "string" ? normalizeWhitespace(value).toLowerCase() : ""))
    .filter(Boolean);
  if (directSignals.some((signal) => signal !== "self" && signal !== "owner" && signal !== "speaker")) {
    return false;
  }

  return !extractEntityNameHints(queryText)
    .map((value) => normalizeWhitespace(value).toLowerCase())
    .filter(Boolean)
    .some((hint) => texts.some((text) => normalizeWhitespace(text).toLowerCase().includes(hint)));
}

export function hasSelfOwnedExactDetailOwnershipSupport(
  queryText: string,
  results: readonly RecallResult[]
): boolean {
  if (!supportsSelfOwnedExactDetailOwnershipBridge(queryText)) {
    return false;
  }
  return results.some((result) =>
    resultHasFirstPersonOwnershipCue(result) ||
    resultHasAssistantAddressedOwnershipCueForExactDetail(queryText, result)
  );
}

export function filterResultsForSelfOwnedExactDetail(
  queryText: string,
  results: readonly RecallResult[]
): readonly RecallResult[] {
  if (!supportsSelfOwnedExactDetailOwnershipBridge(queryText)) {
    return results;
  }

  const ownedResults = results.filter((result) => resultHasFirstPersonOwnershipCue(result));
  if (ownedResults.length > 0) {
    return ownedResults;
  }

  const assistantAddressedResults = results.filter((result) =>
    resultHasAssistantAddressedOwnershipCueForExactDetail(queryText, result)
  );
  return assistantAddressedResults.length > 0 ? assistantAddressedResults : results;
}
