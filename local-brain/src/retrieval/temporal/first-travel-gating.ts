import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { RecallResult } from "../../types.js";

function normalize(value: string | null | undefined): string {
  return String(value ?? "").trim();
}

function normalizeLower(value: string | null | undefined): string {
  return normalize(value).toLowerCase();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function extractSentenceCandidates(text: string): readonly string[] {
  return normalize(text)
    .split(/(?<=[.!?])\s+/u)
    .map((sentence) => normalize(sentence))
    .filter(Boolean);
}

function formatUtcDayLabel(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return normalize(iso);
  }
  return date.toLocaleDateString("en-GB", {
    timeZone: "UTC",
    day: "numeric",
    month: "long",
    year: "numeric"
  });
}

function extractFirstTravelSubjectName(queryText: string): string | null {
  const normalized = normalize(queryText);
  const directMatch = normalized.match(/\bwhen did\s+([A-Z][A-Za-z0-9'’&.-]*(?:\s+[A-Z][A-Za-z0-9'’&.-]*){0,2})\s+first\s+travel\b/iu);
  return directMatch?.[1] ? normalize(directMatch[1]) : null;
}

function extractResultSourceUri(result: RecallResult): string | null {
  const metadata =
    typeof result.provenance === "object" &&
    result.provenance !== null &&
    typeof (result.provenance as Record<string, unknown>).metadata === "object" &&
    (result.provenance as Record<string, unknown>).metadata !== null
      ? ((result.provenance as Record<string, unknown>).metadata as Record<string, unknown>)
      : null;
  const metadataSourceUri = metadata?.source_uri;
  if (typeof metadataSourceUri === "string" && normalize(metadataSourceUri)) {
    return normalize(metadataSourceUri);
  }
  return typeof result.provenance.source_uri === "string" && normalize(result.provenance.source_uri)
    ? normalize(result.provenance.source_uri)
    : null;
}

function extractSpeakerTurns(content: string): ReadonlyArray<{ readonly speaker: string; readonly text: string }> {
  return [...content.matchAll(/(?:^|\n)([A-Z][A-Za-z0-9'’&.-]{1,40}):\s*([^\n]*)/gu)]
    .map((match) => ({
      speaker: normalize(match[1]),
      text: normalize(match[2])
    }))
    .filter((turn) => turn.speaker && turn.text);
}

function hasBoundedActualTravelCue(sentence: string, targetLocation: string): boolean {
  const targetPattern = new RegExp(`\\b${escapeRegExp(targetLocation)}\\b`, "iu");
  if (!targetPattern.test(sentence)) {
    return false;
  }
  return (
    new RegExp(`\\b(?:just went|went to|travel(?:ed|led)? to|trip to|visited|flew to|arrived in|first time in)\\b[^.!?\\n]{0,80}\\b${escapeRegExp(targetLocation)}\\b`, "iu").test(sentence) ||
    new RegExp(`\\b${escapeRegExp(targetLocation)}\\b[^.!?\\n]{0,80}\\b(?:trip|visit(?:ed)?|travel(?:ed|ling)?|arriv(?:ed|ing)|flew)\\b`, "iu").test(sentence)
  );
}

export function extractFirstTravelTargetLocation(queryText: string): string | null {
  const normalized = normalize(queryText);
  if (!/\bfirst\b/iu.test(normalized) || !/\btravel\b/iu.test(normalized)) {
    return null;
  }
  const directMatch = normalized.match(/\btravel(?:ed|ing)?\s+to\s+([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+){0,2})\b/u);
  if (directMatch?.[1]) {
    return normalize(directMatch[1]);
  }
  const visitedMatch = normalized.match(/\bvisit(?:ed|ing)?\s+([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+){0,2})\b/u);
  if (visitedMatch?.[1]) {
    return normalize(visitedMatch[1]);
  }
  const inMatch = normalized.match(/\b(?:to|in)\s+([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+){0,2})\b/u);
  return inMatch?.[1] ? normalize(inMatch[1]) : null;
}

export function isFirstTravelLocationQuery(queryText: string): boolean {
  return Boolean(extractFirstTravelTargetLocation(queryText));
}

export function hasExplicitTravelCueForLocation(queryText: string, text: string): boolean {
  const targetLocation = extractFirstTravelTargetLocation(queryText);
  const normalizedText = normalize(text);
  if (!targetLocation || !normalizedText) {
    return false;
  }
  return extractSentenceCandidates(normalizedText).some((sentence) => {
    if (/\b(?:next month|next week|upcoming|can'?t wait|looking forward|gonna|going to)\b/iu.test(sentence)) {
      return false;
    }
    if (/\bhave you ever\b/iu.test(sentence)) {
      return false;
    }
    return hasBoundedActualTravelCue(sentence, targetLocation);
  });
}

function hasTravelSpilloverCue(text: string): boolean {
  const normalizedText = normalizeLower(text);
  if (!normalizedText) {
    return false;
  }
  return /\b(?:festival|concert|crowd|perform(?:ed|ing)?|tour(?:ed|ing)?|album|video|skyline|photo|picture|shot)\b/u.test(
    normalizedText
  );
}

export function scoreFirstTravelLocationEvidence(queryText: string, text: string | null | undefined): number {
  const normalizedText = normalize(text);
  if (!isFirstTravelLocationQuery(queryText) || !normalizedText) {
    return 0;
  }
  const targetLocation = extractFirstTravelTargetLocation(queryText);
  if (!targetLocation) {
    return 0;
  }
  const locationPattern = new RegExp(`\\b${escapeRegExp(targetLocation)}\\b`, "iu");
  if (!locationPattern.test(normalizedText)) {
    return -2.5;
  }
  if (/\b(?:next month|next week|upcoming|can'?t wait|looking forward|gonna|going to)\b/iu.test(normalizedText)) {
    return -6;
  }
  if (/\bhave you ever\b/iu.test(normalizedText)) {
    return -6;
  }
  if (hasExplicitTravelCueForLocation(queryText, normalizedText)) {
    return 3.5;
  }
  if (hasTravelSpilloverCue(normalizedText)) {
    return -7;
  }
  return -3.5;
}

export function deriveFirstTravelChronologyClaimText(queryText: string, results: readonly RecallResult[]): string | null {
  if (!isFirstTravelLocationQuery(queryText) || results.length === 0) {
    return null;
  }
  const targetLocation = extractFirstTravelTargetLocation(queryText);
  const subjectName = extractFirstTravelSubjectName(queryText)?.toLowerCase() ?? null;
  if (!targetLocation || !subjectName) {
    return null;
  }
  const sourceUris = [...new Set(results
    .map((result) => extractResultSourceUri(result))
    .filter((value): value is string => Boolean(value && value.startsWith("/") && existsSync(value)))
    .flatMap((sourceUri) => {
      const sessionPrefix = basename(sourceUri).match(/^(.*-session_)\d+\.md$/u)?.[1] ?? null;
      if (!sessionPrefix) {
        return [sourceUri];
      }
      try {
        return readdirSync(dirname(sourceUri))
          .filter((entry) => entry.startsWith(sessionPrefix) && entry.endsWith(".md"))
          .map((entry) => join(dirname(sourceUri), entry));
      } catch {
        return [sourceUri];
      }
    }))];
  const chronologyRows = sourceUris
    .map((sourceUri) => {
      const content = readFileSync(sourceUri, "utf8");
      const capturedAt = content.match(/^Captured:\s+([^\n]+)/mu)?.[1]?.trim() ?? null;
      const subjectText = extractSpeakerTurns(content)
        .filter((turn) => turn.speaker.toLowerCase() === subjectName)
        .map((turn) => turn.text)
        .join(" ");
      return capturedAt && subjectText
        ? { capturedAt, hasActualTravel: hasExplicitTravelCueForLocation(queryText, subjectText) }
        : null;
    })
    .filter((row): row is { readonly capturedAt: string; readonly hasActualTravel: boolean } => Boolean(row?.capturedAt))
    .sort((left, right) => Date.parse(left.capturedAt) - Date.parse(right.capturedAt));
  const earliestActual = chronologyRows.find((row) => row.hasActualTravel) ?? null;
  if (!earliestActual) {
    return null;
  }
  const priorAnchor = chronologyRows.filter((row) => Date.parse(row.capturedAt) < Date.parse(earliestActual.capturedAt)).at(-1) ?? null;
  return priorAnchor
    ? `between ${formatUtcDayLabel(priorAnchor.capturedAt)} and ${formatUtcDayLabel(earliestActual.capturedAt)}`
    : `The best supported date is ${formatUtcDayLabel(earliestActual.capturedAt)}`;
}
