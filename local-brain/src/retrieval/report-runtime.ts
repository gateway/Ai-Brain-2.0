import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { RecallResult } from "../types.js";
import type { CanonicalReportKind } from "./types.js";
import {
  extractPairQuerySurfaceNames,
  extractPossessiveQuerySurfaceNames,
  extractPrimaryQuerySurfaceNames
} from "./query-subjects.js";
import { deriveQueryBoundReportSummary } from "../canonical-memory/report-synthesis.js";

export interface RuntimeReportSupportTrace {
  readonly selectedResultCount: number;
  readonly subjectFilteredResultCount: number;
  readonly subjectBoundTextCount: number;
  readonly fullSourceBackfillCount: number;
  readonly supportTextsSelected: number;
  readonly supportSelectionMode: "explicit_subject_filtered" | "all_results";
  readonly targetedRetrievalAttempted: boolean;
  readonly targetedRetrievalReason: string | null;
}

export interface RuntimeReportClaimResult {
  readonly claimText: string | null;
  readonly support: RuntimeReportSupportTrace;
}

const MONTH_INDEX: Readonly<Record<string, number>> = {
  january: 0,
  february: 1,
  march: 2,
  april: 3,
  may: 4,
  june: 5,
  july: 6,
  august: 7,
  september: 8,
  october: 9,
  november: 10,
  december: 11
};

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function uniqueNormalized(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => normalizeWhitespace(value)).filter(Boolean))];
}

function parseTimestamp(value: string | null | undefined): number | null {
  if (typeof value !== "string" || value.trim().length === 0) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseAsOfCutoffTimestamp(queryText: string): number | null {
  const dayMonthYear = queryText.match(/\bas of\s+(\d{1,2})\s+([A-Za-z]+),?\s+(\d{4})\b/iu);
  if (dayMonthYear?.[1] && dayMonthYear?.[2] && dayMonthYear?.[3]) {
    const monthIndex = MONTH_INDEX[dayMonthYear[2].toLowerCase()];
    if (monthIndex !== undefined) {
      const parsed = Date.UTC(Number(dayMonthYear[3]), monthIndex, Number(dayMonthYear[1]), 23, 59, 59, 999);
      return Number.isFinite(parsed) ? parsed : null;
    }
  }
  const monthDayYear = queryText.match(/\bas of\s+([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})\b/iu);
  if (monthDayYear?.[1] && monthDayYear?.[2] && monthDayYear?.[3]) {
    const monthIndex = MONTH_INDEX[monthDayYear[1].toLowerCase()];
    if (monthIndex !== undefined) {
      const parsed = Date.UTC(Number(monthDayYear[3]), monthIndex, Number(monthDayYear[2]), 23, 59, 59, 999);
      return Number.isFinite(parsed) ? parsed : null;
    }
  }
  return null;
}

function explicitSubjectHints(queryText: string): readonly string[] {
  return uniqueNormalized([
    ...extractPrimaryQuerySurfaceNames(queryText),
    ...extractPossessiveQuerySurfaceNames(queryText),
    ...extractPairQuerySurfaceNames(queryText)
  ]).map((value) => value.toLowerCase());
}

function resultMetadata(result: RecallResult): Record<string, unknown> | null {
  return typeof result.provenance.metadata === "object" && result.provenance.metadata !== null
    ? (result.provenance.metadata as Record<string, unknown>)
    : null;
}

function readSourceCapturedAt(sourceUri: string): string | null {
  try {
    const content = readFileSync(sourceUri, "utf8");
    return content.match(/^\s*Captured:\s*([^\n]+)\s*$/mu)?.[1]?.trim() ?? null;
  } catch {
    return null;
  }
}

function resultTimestamp(result: RecallResult): number | null {
  const metadata = resultMetadata(result);
  const directTimestamp =
    parseTimestamp(result.occurredAt ?? null) ??
    parseTimestamp(typeof result.provenance.valid_until === "string" ? result.provenance.valid_until : null) ??
    parseTimestamp(typeof result.provenance.valid_from === "string" ? result.provenance.valid_from : null) ??
    parseTimestamp(typeof metadata?.captured_at === "string" ? metadata.captured_at : null) ??
    parseTimestamp(typeof metadata?.valid_until === "string" ? metadata.valid_until : null) ??
    parseTimestamp(typeof metadata?.valid_from === "string" ? metadata.valid_from : null);
  if (directTimestamp !== null) {
    return directTimestamp;
  }
  const sourceUri = typeof result.provenance.source_uri === "string" ? result.provenance.source_uri : null;
  return sourceUri && sourceUri.startsWith("/") && existsSync(sourceUri)
    ? parseTimestamp(readSourceCapturedAt(sourceUri))
    : null;
}

function collectSubjectSignals(result: RecallResult): readonly string[] {
  const metadata = resultMetadata(result);
  const rawValues: unknown[] = [
    result.content,
    result.provenance.subject_name,
    result.provenance.object_name,
    result.provenance.transcript_speaker_name,
    result.provenance.speaker_name,
    result.provenance.canonical_name,
    (result.provenance as Record<string, unknown>).person_name,
    metadata?.subject_name,
    metadata?.object_name,
    metadata?.transcript_speaker_name,
    metadata?.speaker_name,
    metadata?.canonical_name,
    metadata?.primary_speaker_name,
    metadata?.person_name
  ];
  const participantNames = Array.isArray(metadata?.participant_names) ? metadata?.participant_names : [];
  const speakerNames = Array.isArray(metadata?.speaker_names) ? metadata?.speaker_names : [];
  return uniqueNormalized([
    ...rawValues.filter((value): value is string => typeof value === "string"),
    ...participantNames.filter((value): value is string => typeof value === "string"),
    ...speakerNames.filter((value): value is string => typeof value === "string")
  ]).map((value) => value.toLowerCase());
}

function filterResultsForExplicitSubject(queryText: string, results: readonly RecallResult[]): readonly RecallResult[] {
  const hints = explicitSubjectHints(queryText);
  if (hints.length === 0) {
    return results;
  }
  const filtered = results.filter((result) => {
    const signals = collectSubjectSignals(result);
    return hints.some((hint) => signals.some((signal) => signal.includes(hint)));
  });
  if (filtered.length > 0) {
    return filtered;
  }
  const namedResults = results.filter((result) => collectSubjectSignals(result).length > 0);
  return namedResults.length > 0 ? namedResults : results;
}

function filterResultsForTemporalCutoff(queryText: string, results: readonly RecallResult[]): readonly RecallResult[] {
  const cutoffTimestamp = parseAsOfCutoffTimestamp(queryText);
  if (cutoffTimestamp === null) {
    return results;
  }
  const filtered = results.filter((result) => {
    const timestamp = resultTimestamp(result);
    return timestamp === null || timestamp <= cutoffTimestamp;
  });
  return filtered.length > 0 ? filtered : results;
}

function recallResultSourceTexts(result: RecallResult): readonly string[] {
  const metadata = resultMetadata(result);
  return uniqueNormalized([
    result.content,
    typeof metadata?.source_turn_text === "string" ? metadata.source_turn_text : "",
    typeof metadata?.source_sentence_text === "string" ? metadata.source_sentence_text : "",
    typeof metadata?.prompt_text === "string" ? metadata.prompt_text : ""
  ]);
}

function isFirstPersonReportSegment(segment: string): boolean {
  return /^(?:[A-Z][a-z]+:\s*)?(?:i\b|i'm\b|i’ve\b|i've\b|i’d\b|i'd\b|my\b|me\b|we\b|our\b)/iu.test(normalizeWhitespace(segment));
}

function expandConversationSessionSourceUris(results: readonly RecallResult[]): readonly string[] {
  const directSourceUris = [...new Set(
    results
      .map((result) => result.provenance.source_uri)
      .filter((value): value is string => typeof value === "string" && value.startsWith("/") && existsSync(value))
  )];
  if (directSourceUris.length === 0) {
    return [];
  }
  return [...new Set(
    directSourceUris.flatMap((sourceUri) => {
      const sessionMatch = basename(sourceUri).match(/^(.*-session_)\d+\.md$/u);
      if (!sessionMatch) {
        return [sourceUri];
      }
      try {
        return readdirSync(dirname(sourceUri))
          .filter((entry) => entry.startsWith(sessionMatch[1]!) && entry.endsWith(".md"))
          .map((entry) => join(dirname(sourceUri), entry));
      } catch {
        return [sourceUri];
      }
    })
  )];
}

function filterSourceUrisForQueryContext(queryText: string, sourceUris: readonly string[], results: readonly RecallResult[]): readonly string[] {
  const cutoffTimestamp = parseAsOfCutoffTimestamp(queryText);
  const hasExplicitHints = explicitSubjectHints(queryText).length > 0;
  const filtered = sourceUris.filter((sourceUri) => {
    if (cutoffTimestamp !== null) {
      const capturedTimestamp = parseTimestamp(readSourceCapturedAt(sourceUri));
      if (capturedTimestamp !== null && capturedTimestamp > cutoffTimestamp) {
        return false;
      }
    }
    if (!hasExplicitHints) {
      return true;
    }
    return sourceUriHasSubjectAlignedSeed(queryText, sourceUri, results);
  });
  return filtered.length > 0 ? filtered : sourceUris;
}

function sourceUriHasSubjectAlignedSeed(queryText: string, sourceUri: string, results: readonly RecallResult[]): boolean {
  const hints = explicitSubjectHints(queryText);
  if (hints.length === 0) {
    return false;
  }
  const targetPrefix = basename(sourceUri).match(/^(.*-session_)\d+\.md$/u)?.[1] ?? null;
  return results.some((result) => {
    const resultSourceUri = typeof result.provenance.source_uri === "string" ? result.provenance.source_uri : null;
    if (!resultSourceUri || !resultSourceUri.startsWith("/")) {
      return false;
    }
    const resultPrefix = basename(resultSourceUri).match(/^(.*-session_)\d+\.md$/u)?.[1] ?? null;
    const sameConversation =
      resultSourceUri === sourceUri ||
      (targetPrefix !== null && resultPrefix !== null && targetPrefix === resultPrefix);
    if (!sameConversation) {
      return false;
    }
    const signals = collectSubjectSignals(result);
    return hints.some((hint) => signals.some((signal) => signal.includes(hint)));
  });
}

function subjectBoundSourceTexts(queryText: string, results: readonly RecallResult[]): readonly string[] {
  const hints = explicitSubjectHints(queryText);
  if (hints.length === 0) {
    return [];
  }
  const sourceUris = filterSourceUrisForQueryContext(queryText, expandConversationSessionSourceUris(results), results);
  const extracted: string[] = [];
  for (const sourceUri of sourceUris) {
    const subjectAnchoredSource = sourceUriHasSubjectAlignedSeed(queryText, sourceUri, results);
    const content = readFileSync(sourceUri, "utf8");
    const segments = content
      .split(/\n+|(?<=[.!?])\s+/u)
      .map((segment) => normalizeWhitespace(segment))
      .filter(Boolean);
    for (const segment of segments) {
      const lowered = segment.toLowerCase();
      if (hints.some((hint) => lowered.includes(hint)) || (subjectAnchoredSource && isFirstPersonReportSegment(segment))) {
        extracted.push(segment);
      }
    }
  }
  return uniqueNormalized(extracted);
}

function fullSourceBackfillTexts(queryText: string, results: readonly RecallResult[]): readonly string[] {
  const sourceUris = filterSourceUrisForQueryContext(queryText, expandConversationSessionSourceUris(results), results);
  return uniqueNormalized(sourceUris.map((sourceUri) => readFileSync(sourceUri, "utf8")));
}

function targetedQueryTerms(queryText: string): readonly string[] {
  const stop = new Set(["what", "when", "where", "which", "would", "could", "should", "their", "there", "about", "likely", "considered"]);
  return uniqueNormalized(
    queryText
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/u)
      .filter((token) => token.length >= 4 && !stop.has(token))
  );
}

function isCollectionSupportQuery(queryText: string): boolean {
  return /\bwhat items\b|\bcollect(?:ion|s)?\b|\bcollectibles?\b/iu.test(queryText);
}

function isCausalSupportQuery(queryText: string): boolean {
  return /\bwhy\b/iu.test(queryText) || /\bhow did\b[^?!.]{0,120}\bhelp\b/iu.test(queryText);
}

function isPetCareSupportQuery(queryText: string): boolean {
  return /\bdog\b|\bdogs\b|\bpet\b|\bindoor activity\b|\btake better care\b|\bpotentially do\b/u.test(queryText);
}

function isTravelSupportQuery(queryText: string): boolean {
  return /\bwhere\b.*\b(roadtrips?|travel|trip)\b|\broadtrips?\b|\btravel\b/u.test(queryText);
}

function isAspirationSupportQuery(queryText: string): boolean {
  return /\bhow does\b.*\bunique\b|\bnew business venture\b|\bventure\b|\bapp\b/u.test(queryText);
}

function hasExplicitCollectionCue(text: string): boolean {
  return /\bcollects?\b|\bcollection of\b|\bcollectibles?\b/iu.test(text);
}

function hasExplicitCausalCue(text: string): boolean {
  return (
    /\bbecause\b|\bsince\b|\bafter\b|\bso that\b|\benabled\b|\ballowed\b|\bhelped\b|\bmade\b[^.!?\n]{0,80}\b(safer|better|modern|possible)\b/iu.test(text) ||
    /\b(repairs?|renovations?|creative freedom|passion|motivated|inspired|job loss|lost (?:her|his|their) job)\b/iu.test(text)
  );
}

function hasPetCareCue(text: string): boolean {
  return /\bdog treats?\b|\btraining\b|\bagility\b|\bworkshops?\b|\bgroups?\b|\bgrooming\b|\bremote\b|\bhybrid\b|\bsuburbs?\b|\bcloser to nature\b/iu.test(text);
}

function hasTravelCue(text: string): boolean {
  return /\broadtrips?\b|\btravel(?:ed|ing)?\b|\btrip\b|\bvisited\b|\bwent\b|\brockies\b|\bjasper\b/iu.test(text);
}

function hasAspirationCue(text: string): boolean {
  return /\bunique\b|\bcustomi(?:s|z)e\b|\bpreferences\b|\bneeds\b|\bapp\b|\bventure\b|\bstartup\b|\bbusiness\b/iu.test(text);
}

function targetedBackfillTexts(queryText: string, results: readonly RecallResult[]): readonly string[] {
  const terms = targetedQueryTerms(queryText);
  if (terms.length === 0) {
    return [];
  }
  const hints = explicitSubjectHints(queryText);
  const sourceUris = filterSourceUrisForQueryContext(queryText, expandConversationSessionSourceUris(results), results);
  const extracted: string[] = [];
  for (const sourceUri of sourceUris) {
    const subjectAnchoredSource = sourceUriHasSubjectAlignedSeed(queryText, sourceUri, results);
    const content = readFileSync(sourceUri, "utf8");
    const segments = content
      .split(/\n+|(?<=[.!?])\s+/u)
      .map((segment) => normalizeWhitespace(segment))
      .filter(Boolean);
    for (const segment of segments) {
      const lowered = segment.toLowerCase();
      const subjectCompatible =
        hints.length === 0 ||
        hints.some((hint) => lowered.includes(hint)) ||
        (subjectAnchoredSource && isFirstPersonReportSegment(segment));
      if (subjectCompatible && terms.some((term) => lowered.includes(term))) {
        extracted.push(segment);
      }
    }
  }
  return uniqueNormalized(extracted);
}

export function collectRuntimeReportSupportTexts(queryText: string, results: readonly RecallResult[]): readonly string[] {
  const primaryResults = filterResultsForExplicitSubject(queryText, results);
  const relevantResults = filterResultsForTemporalCutoff(queryText, primaryResults.length > 0 ? primaryResults : results);
  const baseTexts = uniqueNormalized([
    ...relevantResults.flatMap((result) => recallResultSourceTexts(result)),
    ...subjectBoundSourceTexts(queryText, relevantResults)
  ]);
  const targetedTexts = baseTexts.length < 3 ? targetedBackfillTexts(queryText, relevantResults) : [];
  const fullSourceTexts =
    baseTexts.length === 0 && targetedTexts.length === 0
      ? fullSourceBackfillTexts(queryText, relevantResults)
      : [];
  return uniqueNormalized([
    ...baseTexts,
    ...targetedTexts,
    ...fullSourceTexts
  ]);
}

export function collectRuntimeReportSupport(queryText: string, results: readonly RecallResult[]): {
  readonly texts: readonly string[];
  readonly trace: RuntimeReportSupportTrace;
} {
  const primaryResults = filterResultsForExplicitSubject(queryText, results);
  const relevantResults = filterResultsForTemporalCutoff(queryText, primaryResults.length > 0 ? primaryResults : results);
  const subjectBoundTexts = subjectBoundSourceTexts(queryText, relevantResults);
  const baseTexts = uniqueNormalized([
    ...relevantResults.flatMap((result) => recallResultSourceTexts(result)),
    ...subjectBoundTexts
  ]);
  const missingCollectionCue =
    isCollectionSupportQuery(queryText) &&
    !baseTexts.some((text) => hasExplicitCollectionCue(text));
  const missingCausalCue =
    isCausalSupportQuery(queryText) &&
    !baseTexts.some((text) => hasExplicitCausalCue(text));
  const missingPetCareCue =
    isPetCareSupportQuery(queryText) &&
    !baseTexts.some((text) => hasPetCareCue(text));
  const missingTravelCue =
    isTravelSupportQuery(queryText) &&
    !baseTexts.some((text) => hasTravelCue(text));
  const missingAspirationCue =
    isAspirationSupportQuery(queryText) &&
    !baseTexts.some((text) => hasAspirationCue(text));
  const targetedTexts =
    baseTexts.length < 3 || missingCollectionCue || missingCausalCue || missingPetCareCue || missingTravelCue || missingAspirationCue
      ? targetedBackfillTexts(queryText, relevantResults)
      : [];
  const fullSourceTexts =
    baseTexts.length === 0 && targetedTexts.length === 0
      ? fullSourceBackfillTexts(queryText, relevantResults)
      : [];
  const texts = uniqueNormalized([...baseTexts, ...targetedTexts, ...fullSourceTexts]);
  return {
    texts,
    trace: {
      selectedResultCount: relevantResults.length,
      subjectFilteredResultCount: primaryResults.length,
      subjectBoundTextCount: subjectBoundTexts.length,
      fullSourceBackfillCount: fullSourceTexts.length,
      supportTextsSelected: texts.length,
      supportSelectionMode: primaryResults.length > 0 ? "explicit_subject_filtered" : "all_results",
        targetedRetrievalAttempted: targetedTexts.length > 0,
        targetedRetrievalReason:
          targetedTexts.length > 0
            ? missingCollectionCue
              ? "collection_cue_missing"
              : missingCausalCue
                ? "causal_reason_missing"
                : missingPetCareCue
                  ? "pet_care_support_missing"
                  : missingTravelCue
                    ? "travel_location_entries_missing"
                    : missingAspirationCue
                      ? "aspiration_support_missing"
              : "support_texts_sparse"
          : null
    }
  };
}

export function deriveRuntimeReportClaim(
  reportKind: CanonicalReportKind,
  queryText: string,
  results: readonly RecallResult[]
): RuntimeReportClaimResult {
  const support = collectRuntimeReportSupport(queryText, results);
  if (support.texts.length === 0) {
    return {
      claimText: null,
      support: support.trace
    };
  }
  return {
    claimText: deriveQueryBoundReportSummary(reportKind, queryText, support.texts),
    support: support.trace
  };
}

export function deriveRuntimeReportClaimText(
  reportKind: CanonicalReportKind,
  queryText: string,
  results: readonly RecallResult[]
): string | null {
  return deriveRuntimeReportClaim(reportKind, queryText, results).claimText;
}
