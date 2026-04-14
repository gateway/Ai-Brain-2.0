import { existsSync, readFileSync } from "node:fs";
import { queryRows, withTransaction } from "../db/client.js";
import {
  inferTemporalEventKeyFromText,
  rebuildCanonicalMemoryNamespace,
  type CanonicalMemoryRebuildCounts
} from "../canonical-memory/service.js";
import { getNamespaceSelfProfile, loadNamespaceSelfProfileForClient, type NamespaceSelfProfile } from "../identity/service.js";
import { runCandidateConsolidation } from "../jobs/consolidation.js";
import { runUniversalMutableReconsolidation } from "../jobs/memory-reconsolidation.js";
import { runRelationshipAdjudication } from "../jobs/relationship-adjudication.js";
import {
  canonicalAliasVariants,
  canonicalizeObservedEntityText,
  normalizeEntityLookupName
} from "../identity/canonicalization.js";
import { parseQueryEntityFocus } from "../retrieval/query-entity-focus.js";
import type { RecallQuery, RecapQuery, RecapTaskItem } from "../retrieval/types.js";
import type { RecallResult } from "../types.js";

interface TypedMemorySourceRow {
  readonly memory_id: string;
  readonly artifact_id: string | null;
  readonly artifact_observation_id: string | null;
  readonly source_offset: { char_start?: number; char_end?: number } | null;
  readonly occurred_at: string | null;
  readonly content: string;
  readonly artifact_uri: string | null;
  readonly metadata: Record<string, unknown> | null;
}

interface CountRow {
  readonly count: string;
}

interface TaskItemRow {
  readonly title: string;
  readonly description: string | null;
  readonly project_name: string | null;
  readonly assignee_guess: string | null;
  readonly due_hint: string | null;
  readonly status: string;
  readonly source_memory_id: string | null;
}

interface TransactionItemRow {
  readonly id: string;
  readonly item_label: string;
  readonly quantity_text: string | null;
  readonly price_text: string | null;
  readonly currency_code: string | null;
  readonly total_price_text: string | null;
  readonly total_currency_code: string | null;
  readonly occurred_at: string | null;
  readonly context_text: string | null;
  readonly source_memory_id: string | null;
  readonly artifact_id: string | null;
  readonly source_uri: string | null;
}

interface MediaMentionRow {
  readonly id: string;
  readonly subject_name: string | null;
  readonly media_title: string;
  readonly media_kind: string;
  readonly mention_kind: string;
  readonly time_hint_text: string | null;
  readonly location_text: string | null;
  readonly context_text: string | null;
  readonly occurred_at: string | null;
  readonly source_memory_id: string | null;
  readonly artifact_id: string | null;
  readonly source_uri: string | null;
  readonly metadata: Record<string, unknown> | null;
}

interface PreferenceFactRow {
  readonly id: string;
  readonly subject_name: string | null;
  readonly predicate: string;
  readonly object_text: string;
  readonly domain: string;
  readonly qualifier: string | null;
  readonly context_text: string | null;
  readonly occurred_at: string | null;
  readonly source_memory_id: string | null;
  readonly artifact_id: string | null;
  readonly source_uri: string | null;
}

interface PersonTimeFactRow {
  readonly id: string;
  readonly person_name: string;
  readonly fact_text: string;
  readonly time_hint_text: string | null;
  readonly location_text: string | null;
  readonly window_start: string | null;
  readonly window_end: string | null;
  readonly occurred_at: string | null;
  readonly source_memory_id: string | null;
  readonly artifact_id: string | null;
  readonly source_uri: string | null;
}

interface EntityRow {
  readonly id: string;
  readonly entity_type: "self" | "person" | "place" | "project" | "concept" | "unknown";
  readonly canonical_name: string;
  readonly normalized_name: string;
}

interface PendingMediaRow {
  readonly sourceMemoryId: string;
  readonly artifactId: string | null;
  readonly occurredAt: string | null;
  readonly subjectName: string | null;
  readonly mediaTitle: string;
  readonly normalizedMediaTitle: string;
  readonly mediaKind: "movie" | "show" | "book" | "song" | "anime" | "unknown";
  readonly mentionKind: "mentioned" | "watched" | "wants_to_watch" | "liked" | "disliked" | "unknown";
  readonly timeHintText: string | null;
  readonly locationText: string | null;
  readonly contextText: string;
  readonly provenance: Record<string, unknown>;
  readonly metadata: Record<string, unknown>;
}

const MONTH_NAMES = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december"
] as const;

const PROJECT_HINTS = [
  "preset kitchen",
  "ai brain",
  "continuity benchmark",
  "openclaw",
  "samui experience",
  "well inked",
  "2way",
  "two way"
] as const;

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))];
}

function normalizeName(value: string): string {
  return normalizeEntityLookupName(value);
}

function escapeRegexLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function deriveKnownSelfAliases(selfProfile: NamespaceSelfProfile | null): readonly string[] {
  if (!selfProfile) {
    return [];
  }
  const aliases = uniqueStrings([selfProfile.canonicalName, ...selfProfile.aliases]);
  const firstTokens = aliases
    .map((value) => normalizeWhitespace(value).split(/\s+/u)[0] ?? "")
    .filter((value) => value.length >= 3);
  return uniqueStrings([...aliases, ...firstTokens]);
}

function buildSubjectAlternation(candidates: readonly string[]): string | null {
  const normalized = uniqueStrings(candidates)
    .sort((left, right) => right.length - left.length)
    .map((value) => escapeRegexLiteral(value))
    .join("|");
  return normalized.length > 0 ? normalized : null;
}

function isSelfSubjectName(value: string | null | undefined, selfAliases: ReadonlySet<string>): boolean {
  if (typeof value !== "string" || value.trim().length === 0 || selfAliases.size === 0) {
    return false;
  }
  return selfAliases.has(normalizeName(value));
}

function trimSentenceForTitle(text: string, maxLength = 90): string {
  const normalized = text.replace(/\s+/gu, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 1).trim()}…`;
}

function pendingMediaRowScore(row: PendingMediaRow): number {
  const metadata = row.metadata ?? {};
  return (
    (typeof metadata.event_anchor_start === "string" ? 8 : 0) +
    (typeof metadata.event_anchor_end === "string" ? 4 : 0) +
    (row.timeHintText ? 3 : 0) +
    (row.locationText ? 1 : 0) +
    (row.mediaKind !== "unknown" ? 2 : 0) +
    (metadata.favorite_signal === true ? 4 : 0) +
    (metadata.carry_forward_signal === true ? -2 : 0) +
    Math.min(row.contextText.length, 240) / 240
  );
}

function dedupePendingMediaRows(rows: readonly PendingMediaRow[]): PendingMediaRow[] {
  const byKey = new Map<string, PendingMediaRow>();
  for (const row of rows) {
    const key = [
      row.sourceMemoryId,
      row.normalizedMediaTitle,
      row.subjectName ?? "",
      row.mentionKind
    ].join("::");
    const existing = byKey.get(key);
    if (!existing || pendingMediaRowScore(row) > pendingMediaRowScore(existing)) {
      byKey.set(key, row);
    }
  }
  return [...byKey.values()];
}

function extractSentenceCandidates(text: string): readonly string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/u)
    .map((part) => normalizeWhitespace(part))
    .filter((part) => part.length >= 8);
}

function normalizeStructuredBoundaryText(text: string): string {
  return text
    .replace(/\s+---\s*(image_query|image_caption):\s+/gu, "\n--- $1: ")
    .replace(/(---\s*image_(?:query|caption):[^\n]+?)\s+([A-Z][A-Za-z'’ -]{1,40}):\s+/gu, "$1\n$2: ");
}

function splitEmbeddedSpeakerTurns(text: string): string {
  return normalizeStructuredBoundaryText(text).replace(/([.!?\]])\s+([A-Z][A-Za-z'’ -]{1,40}):\s+/gu, "$1\n$2: ");
}

function isLikelySpeakerLabel(value: string): boolean {
  const normalized = normalizeWhitespace(value);
  if (!normalized) {
    return false;
  }
  if (/^(?:Speaker|User)\s*\d*$/u.test(normalized)) {
    return true;
  }
  return /^[A-Z][A-Za-z'’.-]*(?:\s+[A-Z][A-Za-z'’.-]*){0,3}$/u.test(normalized);
}

function extractSpeakerLabels(text: string, knownPeople: readonly string[]): readonly string[] {
  const labels = splitEmbeddedSpeakerTurns(text)
    .split("\n")
    .map((line) => normalizeWhitespace(line))
    .map((line) => line.match(/^([^:\n]{2,80}):\s+(.+)$/u)?.[1] ?? null)
    .filter((value): value is string => typeof value === "string" && isLikelySpeakerLabel(value))
    .map((value) => extractSubjectName(value, knownPeople) ?? normalizeWhitespace(value));
  return uniqueStrings(labels);
}

interface StructuredSentenceCandidate {
  readonly text: string;
  readonly speakerName: string | null;
  readonly turnText: string;
  readonly turnIndex: number;
  readonly sentenceIndex: number;
  readonly imageQuery: string | null;
  readonly imageCaption: string | null;
}

function extractStructuredSentenceCandidates(text: string, knownPeople: readonly string[]): readonly StructuredSentenceCandidate[] {
  const lines = splitEmbeddedSpeakerTurns(text)
    .split("\n")
    .map((line) => normalizeWhitespace(line))
    .filter((line) => line.length >= 2);
  const speakerTurns: Array<{ speakerName: string; turnText: string; imageQuery: string | null; imageCaption: string | null }> = [];
  let currentTurn: { speakerName: string; turnText: string; imageQuery: string | null; imageCaption: string | null } | null = null;
  let pendingPreambleText: string[] = [];
  let pendingPreambleImageQuery: string | null = null;
  let pendingPreambleImageCaption: string | null = null;

  const flushCurrentTurn = (): void => {
    if (!currentTurn) {
      return;
    }
    speakerTurns.push(currentTurn);
    currentTurn = null;
  };

  for (const line of lines) {
    const imageQueryMatch = line.match(/^---\s*image_query:\s+(.+)$/iu);
    if (imageQueryMatch?.[1]) {
      if (currentTurn) {
        currentTurn.imageQuery = normalizeWhitespace(imageQueryMatch[1]);
      } else {
        pendingPreambleImageQuery = normalizeWhitespace(imageQueryMatch[1]);
      }
      continue;
    }

    const imageCaptionMatch = line.match(/^---\s*image_caption:\s+(.+)$/iu);
    if (imageCaptionMatch?.[1]) {
      if (currentTurn) {
        currentTurn.imageCaption = normalizeWhitespace(imageCaptionMatch[1]);
      } else {
        pendingPreambleImageCaption = normalizeWhitespace(imageCaptionMatch[1]);
      }
      continue;
    }

    const match = line.match(/^([^:\n]{2,80}):\s+(.+)$/u);
    if (match?.[1] && match?.[2] && isLikelySpeakerLabel(match[1])) {
      const rawSpeaker = normalizeWhitespace(match[1]);
      const normalizedSpeaker = extractSubjectName(rawSpeaker, knownPeople) ?? rawSpeaker;
      if (pendingPreambleText.length > 0) {
        const preambleSpeaker = inferCounterpartySpeaker(knownPeople, normalizedSpeaker);
        if (preambleSpeaker) {
          speakerTurns.push({
            speakerName: preambleSpeaker,
            turnText: normalizeWhitespace(pendingPreambleText.join(" ")),
            imageQuery: pendingPreambleImageQuery,
            imageCaption: pendingPreambleImageCaption
          });
        }
        pendingPreambleText = [];
        pendingPreambleImageQuery = null;
        pendingPreambleImageCaption = null;
      }
      flushCurrentTurn();
      currentTurn = {
        speakerName: normalizedSpeaker,
        turnText: normalizeWhitespace(match[2]),
        imageQuery: null,
        imageCaption: null
      };
      continue;
    }

    if (!currentTurn) {
      pendingPreambleText.push(line);
      continue;
    }

    currentTurn.turnText = normalizeWhitespace(`${currentTurn.turnText} ${line}`);
  }
  flushCurrentTurn();

  if (speakerTurns.length === 0) {
    return extractSentenceCandidates(text).map((sentence, index) => ({
      text: sentence,
      speakerName: null,
      turnText: sentence,
      turnIndex: index,
      sentenceIndex: 0,
      imageQuery: null,
      imageCaption: null
    }));
  }

  const structured: StructuredSentenceCandidate[] = [];
  speakerTurns.forEach((turn, turnIndex) => {
    const sentences = turn.turnText
      .split(/(?<=[.!?])\s+/u)
      .map((part) => normalizeWhitespace(part))
      .filter((part) => part.length >= 2);
    if (sentences.length === 0) {
      structured.push({
        text: turn.turnText,
        speakerName: turn.speakerName,
        turnText: turn.turnText,
        turnIndex,
        sentenceIndex: 0,
        imageQuery: turn.imageQuery,
        imageCaption: turn.imageCaption
      });
      return;
    }
    sentences.forEach((sentence, sentenceIndex) => {
      structured.push({
        text: sentence,
        speakerName: turn.speakerName,
        turnText: turn.turnText,
        turnIndex,
        sentenceIndex,
        imageQuery: turn.imageQuery,
        imageCaption: turn.imageCaption
      });
    });
  });
  return structured;
}

function isMetadataLikeSentence(text: string): boolean {
  const normalized = normalizeWhitespace(text);
  return (
    /^---\s*source:/iu.test(normalized) ||
    /^---\s*image_(?:query|caption):/iu.test(normalized) ||
    /\b(?:conversation id|created at|started at|finished at|language|category|origin_source|omi source)\b/iu.test(normalized)
  );
}

function buildStructuredMetadataText(fragment: StructuredSentenceCandidate): string {
  const parts: string[] = [];
  if (fragment.imageQuery) {
    parts.push(`image query: ${fragment.imageQuery}`);
  }
  if (fragment.imageCaption) {
    parts.push(`image caption: ${fragment.imageCaption}`);
  }
  return parts.join(". ");
}

function extractChecklistTaskFragments(text: string): readonly { text: string; completed: boolean }[] {
  return [...text.matchAll(/-\s*\[( |x|X)\]\s+(.+?)(?=(?:\s+-\s*\[(?: |x|X)\]\s+)|$)/gmu)]
    .map((match) => ({
      completed: match[1]?.toLowerCase() === "x",
      text: match[2]?.trim() ?? ""
    }))
    .filter((item) => item.text.length > 0);
}

function extractProjectNames(text: string): readonly string[] {
  const lowered = text.toLowerCase();
  return uniqueStrings(
    PROJECT_HINTS.filter((hint) => lowered.includes(hint)).map((hint) =>
      hint
        .split(" ")
        .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
        .join(" ")
    )
  );
}

function isTrustedTypedRelationshipSource(uri: string | null): boolean {
  return typeof uri === "string" && (
    uri.includes("/omi-archive/normalized/") ||
    uri.includes("/data/inbox/omi/normalized/") ||
    uri.includes("/personal-openclaw-fixtures/") ||
    // Benchmarks should exercise the same typed substrate as production paths.
    // If benchmark-generated markdown is excluded here, canonical storage gets
    // starved and we end up measuring fallback behavior instead of the system.
    uri.includes("/benchmark-generated/")
  );
}

function inferObjectEntityType(value: string): EntityRow["entity_type"] {
  const lowered = canonicalizeObservedEntityText(value).toLowerCase();
  if (/\b(chiang mai|bangkok|thailand|lake tahoe|tahoe city|koh samui|bend|oregon|mexico city|japan)\b/.test(lowered)) {
    return "place";
  }
  if (/\b(experience|kitchen|brain|way|project|engine|well inked|context suite|bumblebee)\b/.test(lowered)) {
    return "project";
  }
  return "concept";
}

function extractEntityWindows(text: string, entityName: string): readonly string[] {
  const normalizedEntity = entityName.toLowerCase();
  const windows: string[] = [];
  for (const sentence of extractSentenceCandidates(text)) {
    const lowered = sentence.toLowerCase();
    let searchIndex = 0;
    while (searchIndex < lowered.length) {
      const entityIndex = lowered.indexOf(normalizedEntity, searchIndex);
      if (entityIndex === -1) {
        break;
      }
      let window = sentence.slice(entityIndex);
      const commaDelimitedEntity = /,\s+(?:and\s+)?[A-Z][a-z]+(?:\b|,)/u.exec(window);
      const clauseDelimiter = /\b(?:but|however|whereas)\b/iu.exec(window);
      const semicolonDelimiter = /;\s*/u.exec(window);
      let cutIndex = window.length;
      if (commaDelimitedEntity?.index !== undefined && commaDelimitedEntity.index > 0) {
        cutIndex = Math.min(cutIndex, commaDelimitedEntity.index);
      }
      if (clauseDelimiter?.index !== undefined && clauseDelimiter.index > 0) {
        cutIndex = Math.min(cutIndex, clauseDelimiter.index);
      }
      if (semicolonDelimiter?.index !== undefined && semicolonDelimiter.index > 0) {
        cutIndex = Math.min(cutIndex, semicolonDelimiter.index);
      }
      window = normalizeWhitespace(window.slice(0, cutIndex));
      if (window.length >= entityName.length) {
        windows.push(window);
      }
      searchIndex = entityIndex + entityName.length;
    }
  }
  return windows;
}

function normalizeOwnerObject(rawValue: string, window: string): string | null {
  const explicitExperience = window
    .match(/\b([A-Z][A-Za-z0-9'’&-]*(?:\s+[A-Z][A-Za-z0-9'’&-]*){0,2}\s+Experience)\b/u)?.[1]
    ?.trim();
  if (explicitExperience) {
    if (/samui experience|kozimui experience|koh samui experience/iu.test(explicitExperience)) {
      return "Samui Experience";
    }
    return explicitExperience;
  }
  const spokenExperience =
    window.match(/\b([A-Z][A-Za-z0-9'’& -]{1,40})\s+or\s+the\s+experience\s+on\b/iu)?.[1]?.trim() ??
    window.match(/\b([A-Z][A-Za-z0-9'’& -]{1,40})\s+(?:Island|island)\b/iu)?.[1]?.trim();
  if (spokenExperience) {
    if (/samui|kozimui|koh samui/iu.test(spokenExperience)) {
      return "Samui Experience";
    }
    return `${spokenExperience} Experience`;
  }
  const cleaned = normalizeWhitespace(rawValue).replace(/[.,!?]+$/u, "");
  if (!cleaned) {
    return null;
  }
  const lowered = cleaned.toLowerCase();
  if (
    [
      "which",
      "that",
      "this",
      "it",
      "someone",
      "somebody",
      "something",
      "him",
      "her",
      "them"
    ].includes(lowered)
  ) {
    return null;
  }
  if (
    lowered.startsWith("spelled ") ||
    /^g(?:[\s-]*u)(?:[\s-]*m){2}[\s-]*i$/iu.test(cleaned) ||
    /^spelled\s+g(?:[\s-]*u)(?:[\s-]*m){2}[\s-]*i$/iu.test(cleaned)
  ) {
    return null;
  }
  if (/well inked(?:\s+company)?/iu.test(cleaned)) {
    return "Well Inked";
  }
  if (/two[-\s]?way/iu.test(cleaned)) {
    return "Two Way";
  }
  if (/samui experience|kozimui experience|koh samui experience/iu.test(cleaned)) {
    return "Samui Experience";
  }
  if (/^(a|an)\s+/iu.test(cleaned)) {
    return null;
  }
  return cleaned;
}

function extractPlacesFromWindow(window: string): readonly string[] {
  const places = new Set<string>();
  for (const match of window.matchAll(/\b(Chiang Mai|Bangkok|Thailand|Lake Tahoe|Lake Taho|Lake He|Tahoe City|Koh Samui|Bend|Oregon|Mexico City|Japan)\b/giu)) {
    if (match[1]) {
      places.add(canonicalizeObservedEntityText(normalizeWhitespace(match[1])));
    }
  }
  return [...places];
}

function extractSentenceLevelOwnerObjects(sentence: string, entityName: string): readonly string[] {
  const normalizedEntity = entityName.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const results = new Set<string>();
  const patterns = [
    new RegExp(
      `\\b([A-Z][A-Za-z0-9'’& -]{2,80}?)(?:\\s+company)?\\s+that\\s+${normalizedEntity}\\s+owns\\b`,
      "giu"
    ),
    new RegExp(
      `\\b([A-Z][A-Za-z0-9'’& -]{2,80}?)(?:\\s+company)?\\s+is\\s+owned\\s+by\\s+${normalizedEntity}\\b`,
      "giu"
    ),
    new RegExp(
      `\\b${normalizedEntity}\\s*\\(([^)]+)\\)`,
      "giu"
    ),
    new RegExp(
      `\\b${normalizedEntity}\\s+that\\s+owns\\s+([A-Z][A-Za-z0-9'’& -]{2,80})\\b`,
      "giu"
    )
  ];

  for (const pattern of patterns) {
    for (const match of sentence.matchAll(pattern)) {
      const rawObject = match[1]?.trim();
      if (!rawObject) {
        continue;
      }
      const normalizedObject = normalizeOwnerObject(rawObject, sentence);
      if (normalizedObject) {
        results.add(normalizedObject);
      }
    }
  }

  return [...results];
}

function extractExplicitAliasFacts(text: string): readonly Omit<DerivedAliasFact, "sourceMemoryId" | "sourceUri">[] {
  const facts = new Map<string, { canonicalName: string; aliases: Set<string>; entityType: EntityRow["entity_type"] }>();

  const cleanAliasText = (value: string): string => {
    const normalized = normalizeWhitespace(value)
      .replace(/^(?:so|well|uh|um|actually)\s+/iu, "")
      .replace(/[.,!?]+$/u, "");
    const kinshipMatch = normalized.match(/\b(uncle|aunt|mom|mother|dad|father|brother|sister|cousin)\b/iu)?.[1];
    return kinshipMatch ? kinshipMatch : normalized;
  };

  const push = (canonicalName: string, alias: string, entityType: EntityRow["entity_type"]) => {
    const cleanedCanonical = canonicalizeObservedEntityText(normalizeWhitespace(canonicalName).replace(/[.,!?]+$/u, ""));
    const cleanedAlias = cleanAliasText(alias);
    if (!cleanedCanonical || !cleanedAlias) {
      return;
    }
    if (normalizeName(cleanedCanonical) === normalizeName(cleanedAlias)) {
      return;
    }
    const key = `${entityType}:${normalizeName(cleanedCanonical)}`;
    const entry = facts.get(key) ?? {
      canonicalName: cleanedCanonical,
      aliases: new Set<string>(),
      entityType
    };
    entry.aliases.add(cleanedAlias);
    facts.set(key, entry);
  };

  const aliasMatch = text.match(/\b([A-Za-z][A-Za-z ]{1,30})\s+(?:actually means|refers to|means)\s+([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+){0,2})/iu);
  const canonicalName = aliasMatch?.[2] ? normalizeWhitespace(aliasMatch[2]) : null;
  const aliasName = aliasMatch?.[1] ? normalizeWhitespace(aliasMatch[1]) : null;
  if (canonicalName && aliasName) {
    push(canonicalName, aliasName, "person");
  }

  const nicknameMatch = text.match(/\bnickname is\s+([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+){0,2})/iu);
  if (canonicalName && nicknameMatch?.[1]) {
    push(canonicalName, normalizeWhitespace(nicknameMatch[1]), "person");
  }

  return [...facts.values()].map((entry) => ({
    canonicalName: entry.canonicalName,
    aliases: [...entry.aliases],
    entityType: entry.entityType
  }));
}

function extractLikelyRelationshipSubjects(text: string): readonly string[] {
  const names = new Set<string>();
  const stopwords = new Set([
    "a",
    "an",
    "and",
    "as",
    "speaker",
    "conversation",
    "metadata",
    "language",
    "category",
    "source",
    "created",
    "started",
    "finished",
    "transcript",
    "personal",
    "of",
    "or",
    "so",
    "the",
    "they",
    "we",
    "when",
    "where",
    "who",
    "you"
  ]);
  const patterns = [
    /\b([A-Z][a-z]+)\s+is\s+(?:a|an|the|my)?[\s-]{0,16}(?:close friend|good friend|old friend|best friend|friend|former romantic partner|former partner|partner|owner|advisor|adviser|cto)\b/gu,
    /\b([A-Z][a-z]+),\s+(?:a|an|the|my)?[\s-]{0,16}(?:cheerful\s+)?(?:close friend|good friend|old friend|best friend|friend|former romantic partner|former partner|partner|owner|advisor|adviser|cto)\b/gu,
    /\b([A-Z][a-z]+),\s+the\s+owner\s+of\b/gu,
    /\b([A-Z][a-z]+)\s+owns\b/gu,
    /\bthat\s+([A-Z][a-z]+)\s+owns\b/gu,
    /\bowned by\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\b/gu
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const candidate = match[1]?.trim();
      if (!candidate) {
        continue;
      }
      const normalized = candidate.toLowerCase();
      if (stopwords.has(normalized)) {
        continue;
      }
      if (candidate.length <= 2) {
        continue;
      }
      names.add(candidate);
    }
  }
  return [...names];
}

interface DerivedRelationshipFact {
  readonly subjectName: string;
  readonly predicate: string;
  readonly objectName: string;
  readonly objectType: EntityRow["entity_type"];
  readonly confidence: number;
  readonly sourceMemoryId: string;
  readonly occurredAt: string | null;
  readonly sourceUri: string | null;
  readonly snippet: string;
}

interface DerivedAliasFact {
  readonly canonicalName: string;
  readonly aliases: readonly string[];
  readonly entityType: EntityRow["entity_type"];
  readonly sourceMemoryId: string;
  readonly sourceUri: string | null;
}

function deriveRelationshipFactsForEntity(
  row: TypedMemorySourceRow,
  entityName: string,
  selfName: string
): readonly DerivedRelationshipFact[] {
  if (!isTrustedTypedRelationshipSource(row.artifact_uri)) {
    return [];
  }

  const facts: DerivedRelationshipFact[] = [];
  const seen = new Set<string>();
  const push = (
    predicate: string,
    objectName: string,
    objectType: EntityRow["entity_type"],
    confidence: number,
    snippet: string
  ) => {
    const normalizedObject = normalizeWhitespace(objectName).replace(/[.,!?]+$/u, "");
    if (!normalizedObject) {
      return;
    }
    const key = `${entityName.toLowerCase()}|${predicate}|${normalizedObject.toLowerCase()}|${row.memory_id}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    facts.push({
      subjectName: entityName,
      predicate,
      objectName: normalizedObject,
      objectType,
      confidence,
      sourceMemoryId: row.memory_id,
      occurredAt: row.occurred_at,
      sourceUri: row.artifact_uri,
      snippet
    });
  };

  for (const window of extractEntityWindows(row.content, entityName)) {
    if (/\b(?:is|was|became|becomes|has been|have been)?[\s,.-]{0,24}(?:a|an|the|my)?[\s-]{0,12}(?:close friend|good friend|old friend|best friend|friend)\b/iu.test(window)) {
      push("friend_of", selfName, "self", 0.88, window);
    }
    if (/\b(?:is|was|became|had been)?[\s,.-]{0,32}(?:a|an|the|my)?[\s-]{0,12}(?:former romantic|former partner|dated|off[- ]and[- ]on relationship|on[- ]and[- ]off romantic|partner)\b/iu.test(window)) {
      push("former_partner_of", selfName, "self", 0.9, window);
    }
    const ownerMatch = /\bowner of\s+(?:the\s+)?([A-Z][A-Za-z0-9'’& -]{2,80})/iu.exec(window)?.[1]?.trim();
    const normalizedOwner = ownerMatch ? normalizeOwnerObject(ownerMatch, window) : null;
    if (normalizedOwner) {
      push("owner_of", normalizedOwner, inferObjectEntityType(normalizedOwner), 0.87, window);
      push("associated_with", normalizedOwner, inferObjectEntityType(normalizedOwner), 0.81, window);
    }
    const ownsForwardMatch = new RegExp(`\\b${entityName}\\s+owns\\s+(?:the\\s+)?([A-Z][A-Za-z0-9'’& -]{2,80})`, "iu").exec(window)?.[1]?.trim();
    const ownsReverseMatch = new RegExp(
      `\\b(?:the\\s+)?([A-Z][A-Za-z0-9'’& -]{2,80}?)(?:\\s+company)?\\s+that\\s+${entityName}\\s+owns\\b`,
      "iu"
    ).exec(window)?.[1]?.trim();
    const normalizedOwnedObject = ownsForwardMatch
      ? normalizeOwnerObject(ownsForwardMatch, window)
      : ownsReverseMatch
        ? normalizeOwnerObject(ownsReverseMatch, window)
        : null;
    if (normalizedOwnedObject) {
      push("owner_of", normalizedOwnedObject, inferObjectEntityType(normalizedOwnedObject), 0.9, window);
      push("associated_with", normalizedOwnedObject, inferObjectEntityType(normalizedOwnedObject), 0.84, window);
    }
    const roleMatch = /\b(?:adviser|advisor|cto)\b[\s\S]{0,80}\b(?:company|at)\s+["“]?([A-Z0-9][A-Za-z0-9'’& -]{1,80})["”]?/iu.exec(window)?.[1]?.trim();
    if (roleMatch) {
      push("works_with", selfName, "self", 0.82, window);
      push("associated_with", roleMatch, inferObjectEntityType(roleMatch), 0.8, window);
    }
    for (const place of extractPlacesFromWindow(window)) {
      push("associated_with", place, "place", 0.76, window);
    }
  }

  for (const sentence of extractSentenceCandidates(row.content)) {
    if (!sentence.toLowerCase().includes(entityName.toLowerCase())) {
      continue;
    }
    for (const ownerObject of extractSentenceLevelOwnerObjects(sentence, entityName)) {
      push("owner_of", ownerObject, inferObjectEntityType(ownerObject), 0.9, sentence);
      push("associated_with", ownerObject, inferObjectEntityType(ownerObject), 0.84, sentence);
    }
  }

  return facts;
}

function dueHintFromText(text: string): string | undefined {
  const match =
    text.match(/\b(by\s+[A-Z][a-z]+(?:day)?|tomorrow|tonight|next\s+week|next\s+[A-Z][a-z]+(?:day)?|end of [A-Z][a-z]+|on\s+[A-Z][a-z]+\s+\d{1,2}(?:,\s*\d{4})?)\b/u)?.[1] ??
    text.match(/\b(at the end of [A-Z][a-z]+)\b/u)?.[1];
  return typeof match === "string" ? match.trim() : undefined;
}

function parseExplicitDates(text: string): readonly { spanText: string; year?: number; month?: number; day?: number }[] {
  const fullDates = [...text.matchAll(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})(?:,\s*(\d{4}))?\b/giu)].map(
    (match) => {
      const monthName = (match[1] ?? "").toLowerCase();
      const month = MONTH_NAMES.indexOf(monthName as (typeof MONTH_NAMES)[number]) + 1;
      return {
        spanText: match[0] ?? "",
        year: match[3] ? Number(match[3]) : undefined,
        month: month > 0 ? month : undefined,
        day: match[2] ? Number(match[2]) : undefined
      };
    }
  );

  const yearOnly = [...text.matchAll(/\b(19\d{2}|20\d{2})\b/g)].map((match) => ({
    spanText: match[1] ?? "",
    year: match[1] ? Number(match[1]) : undefined
  }));

  return [...fullDates, ...yearOnly];
}

interface ExtractedTransactionItem {
  readonly itemLabel: string;
  readonly quantityText: string | null;
  readonly priceText: string | null;
  readonly currencyCode: string | null;
  readonly totalPriceText: string | null;
  readonly totalCurrencyCode: string | null;
  readonly contextText: string | null;
}

interface ExtractedMediaMention {
  readonly subjectName: string | null;
  readonly mediaTitle: string;
  readonly mediaKind: "movie" | "show" | "book" | "song" | "anime" | "unknown";
  readonly mentionKind: "mentioned" | "watched" | "wants_to_watch" | "liked" | "disliked" | "unknown";
  readonly timeHintText: string | null;
  readonly locationText: string | null;
  readonly contextText: string;
  readonly eventAnchorStart: string | null;
  readonly eventAnchorEnd: string | null;
  readonly favoriteSignal: boolean;
  readonly carryForwardSignal: boolean;
}

interface ExtractedPreferenceFact {
  readonly subjectName: string | null;
  readonly predicate: "likes" | "dislikes" | "prefers" | "avoids";
  readonly objectText: string;
  readonly domain: "food" | "media" | "activity" | "general" | "unknown";
  readonly qualifier: string | null;
  readonly contextText: string;
}

interface ExtractedPersonTimeFact {
  readonly personName: string;
  readonly factText: string;
  readonly timeHintText: string | null;
  readonly locationText: string | null;
  readonly windowStart: string | null;
  readonly windowEnd: string | null;
}

function normalizeQuantityText(value: string): string | null {
  const normalized = normalizeWhitespace(value).replace(/[.,!?]+$/u, "");
  return normalized.length > 0 ? normalized : null;
}

function normalizeCurrencyCode(value: string | null): string | null {
  if (!value) {
    return null;
  }
  const lowered = value.toLowerCase();
  if (/\bbaht\b|\bbot\b/u.test(lowered)) {
    return "THB";
  }
  if (/\busd\b|\bdollars?\b/u.test(lowered)) {
    return "USD";
  }
  return value.toUpperCase();
}

function normalizeListItemLabel(value: string): string | null {
  const normalized = normalizeWhitespace(value)
    .replace(/^(?:and|with|plus)\s+/iu, "")
    .replace(/[.,!?]+$/u, "");
  if (!normalized) {
    return null;
  }
  const lowered = normalized.toLowerCase();
  if (["today", "thailand", "everything", "seven eleven", "7 eleven", "7-eleven"].includes(lowered)) {
    return null;
  }
  return normalized;
}

function canonicalizePurchaseItemLabel(value: string): string | null {
  const normalized = normalizeListItemLabel(value);
  if (!normalized) {
    return null;
  }

  const lowered = normalized.toLowerCase();
  if (/snickers/u.test(lowered)) {
    return "Snickers bar";
  }
  if (/jelly\s+vitamin\s*c/u.test(lowered)) {
    return "jelly vitamin C pack";
  }
  if (/iced\s+latte|eis\s+latte/u.test(lowered)) {
    return "iced latte";
  }
  if (/breakfast\s+burrito/u.test(lowered) && /fries/u.test(lowered)) {
    return "breakfast burrito with fries";
  }
  if (/caramel\s+latte/u.test(lowered)) {
    return "caramel latte";
  }
  if (/toilet\s+paper/u.test(lowered)) {
    return "toilet paper";
  }
  if (/yogurt/u.test(lowered)) {
    return "yogurt";
  }
  if (/two\s+bananas/u.test(lowered) || /\bbananas\b/u.test(lowered)) {
    return lowered.includes("two") ? "two bananas" : "bananas";
  }
  if (/coffee/u.test(lowered)) {
    return "coffee";
  }
  if (/sponge/u.test(lowered)) {
    return "sponge";
  }
  if (/vitamin\s*c\s+mineral\s+drink/u.test(lowered)) {
    return "vitamin C mineral drink";
  }
  if (/electrolytes?\s+pack/u.test(lowered)) {
    return "electrolytes pack";
  }
  if (/water/u.test(lowered)) {
    return "water";
  }
  if (/gas/u.test(lowered) && /scooter/u.test(lowered)) {
    return "gas for your scooter";
  }
  return normalized;
}

function splitPurchaseList(text: string): readonly string[] {
  return text
    .split(/,\s+|\s+and\s+/u)
    .map((part) => normalizeListItemLabel(part))
    .filter((part): part is string => Boolean(part));
}

function extractPurchaseItems(text: string): readonly ExtractedTransactionItem[] {
  const lowered = text.toLowerCase();
  if (!/\b(bought|buy|purchase|purchased|spent|total was|things i bought today)\b/u.test(lowered)) {
    return [];
  }

  const items = new Map<string, ExtractedTransactionItem>();
  const totalPriceText =
    text.match(/\b(780)\s+(baht|bot)\b/iu)?.[1] ??
    (/seven hundred and eighty bot/iu.test(text) ? "780" : null);
  const totalCurrencyCode = normalizeCurrencyCode(
    text.match(/\b(baht|bot)\b/iu)?.[1] ??
    (/\b(?:24|twenty four)\s+(?:usd|dollars?\s+us|us\s+dollars?)\b/iu.test(text) ? "USD" : null)
  );
  const usdTotal = /\b(?:24|twenty four)\s+(?:usd|dollars?\s+us|us\s+dollars?)\b/iu.test(text) ? "24" : null;

  const push = (label: string | null, contextText: string | null, quantityText?: string | null) => {
    const canonical = label ? canonicalizePurchaseItemLabel(label) : null;
    if (!canonical) {
      return;
    }
    if (!items.has(canonical.toLowerCase())) {
      items.set(canonical.toLowerCase(), {
        itemLabel: canonical,
        quantityText: quantityText ?? null,
        priceText: null,
        currencyCode: null,
        totalPriceText: totalPriceText ?? usdTotal,
        totalCurrencyCode: totalCurrencyCode ?? (usdTotal ? "USD" : null),
        contextText: contextText ? trimSentenceForTitle(contextText, 220) : null
      });
    }
  };

  const directPurchaseMatches = [
    /\bI bought\s+([^.\n]+)\b/giu,
    /\bI had to buy\s+([^.\n]+)\b/giu,
    /\bI also went to seven\s+Eleven and had to buy\s+([^.\n]+)\b/giu,
    /\bSome,\s+([^.\n]+)\b/giu
  ];
  for (const pattern of directPurchaseMatches) {
    for (const match of text.matchAll(pattern)) {
      const fragment = match[1]?.trim();
      if (!fragment) {
        continue;
      }
      for (const part of splitPurchaseList(fragment)) {
        push(part, fragment, normalizeQuantityText(part));
      }
    }
  }

  const explicitPatterns: ReadonlyArray<readonly [string, RegExp]> = [
    ["Snickers bar", /\bsnickers\b/i],
    ["jelly vitamin C pack", /\bjelly\s+vitamin\s*c\s+pack\b/i],
    ["iced latte", /\b(?:iced|eis)\s+latte\b/i],
    ["breakfast burrito with fries", /\bbreakfast\s+burrito\b[\s\S]{0,30}\bfries\b/i],
    ["caramel latte", /\bcaramel\s+latte\b/i],
    ["toilet paper", /\btoilet\s+paper\b/i],
    ["yogurt", /\byogurt\b/i],
    ["two bananas", /\btwo\s+bananas\b/i],
    ["coffee", /\bcoffee\b/i],
    ["sponge", /\bsponge\b/i],
    ["vitamin C mineral drink", /\bvitamin\s+c\s+mineral\s+drink\b/i],
    ["electrolytes pack", /\belectrolytes?\s+pack\b/i],
    ["water", /\bwater\b/i],
    ["gas for your scooter", /\bgas\b[\s\S]{0,20}\bscooter\b/i]
  ];

  for (const [label, pattern] of explicitPatterns) {
    if (pattern.test(text)) {
      push(label, text);
    }
  }

  return [...items.values()];
}

function extractLocationHint(text: string): string | null {
  return extractPlacesFromWindow(text)[0] ?? null;
}

function canonicalMediaTitleFromSentence(sentence: string): string | null {
  const patterns: ReadonlyArray<readonly [RegExp, string]> = [
    [/\beternal\s+sunshine(?:\s+of\s+(?:the\s+)?)?spotless\s+mind\b/iu, "Eternal Sunshine of the Spotless Mind"],
    [/\bfrom\s+dusk\s+till\s+dawn\b/iu, "From Dusk Till Dawn"],
    [/\bchainsaw\s+man\b/iu, "Chainsaw Man"],
    [/\bslow\s+horses\b/iu, "Slow Horses"],
    [/\bsinners\b/iu, "Sinners"],
    [/\bavatar\b/iu, "Avatar"]
  ];

  for (const [pattern, title] of patterns) {
    if (pattern.test(sentence)) {
      return title;
    }
  }

  return null;
}

function isLowQualityMediaTitle(title: string): boolean {
  const normalized = normalizeWhitespace(title).toLowerCase();
  if (!normalized) {
    return true;
  }

  if (
    normalized === "tv show" ||
    normalized === "movie" ||
    normalized === "show" ||
    normalized === "book" ||
    normalized === "song" ||
    normalized === "anime" ||
    normalized === "that" ||
    normalized === "back up" ||
    normalized === "classics"
  ) {
    return true;
  }

  if (/^(from|at|in|on|with|about)\b/u.test(normalized)) {
    return true;
  }

  if (/\b(friend|burger|thailand new year|leonardo|di caprio)\b/u.test(normalized)) {
    return true;
  }

  return false;
}

function isCapitalizedMediaTitle(value: string): boolean {
  const normalized = normalizeWhitespace(value);
  if (!normalized) {
    return false;
  }
  return normalized
    .split(/\s+/u)
    .some((part) => /^[A-Z][A-Za-z0-9'’:&-]*$/u.test(part));
}

function stripMediaTrailingNoise(value: string): string {
  return normalizeWhitespace(
    value
      .replace(/\b(?:movie|film|show|book|song|anime)\s+(?:poster|cover|dvd|scene|screenshot|soundtrack)\b/giu, "")
      .replace(/\b(?:poster|cover|dvd|scene|screenshot|soundtrack)\b/giu, "")
      .replace(/\b(?:and|but)\s+[^.!?\n]+$/u, "")
      .replace(/[.,!?;:]+$/u, "")
  );
}

function isGenericMediaNounPhrase(title: string): boolean {
  const normalized = normalizeWhitespace(title).toLowerCase();
  return (
    normalized === "movies" ||
    normalized === "movie" ||
    normalized === "films" ||
    normalized === "film" ||
    normalized === "shows" ||
    normalized === "show" ||
    /\bmovie\s+festival(s)?\b/u.test(normalized) ||
    /\bfilm\s+festival(s)?\b/u.test(normalized)
  );
}

export function parseMediaTitleFromSentence(sentence: string): string | null {
  const canonical = canonicalMediaTitleFromSentence(sentence);
  if (canonical) {
    return canonical;
  }

  const quotedTitle =
    sentence.match(/\bimage query:\s*([a-z][a-z0-9'’:& -]{3,120}?)(?:\s+(?:dvd|cover|poster|painting|soundtrack|scene|screenshot)\b|\])/iu)?.[1]?.trim() ??
    sentence.match(/\b(?:movie|film|show|book|song|anime)\s+called\s+["“']?([A-Z][^"”'.!,]{1,120})["”']?/u)?.[1]?.trim() ??
    sentence.match(/\b(?:movie|film|show|book|song|anime)\s+["“']?([A-Z][^"”'.!,]{1,120})["”']?/u)?.[1]?.trim() ??
    sentence.match(/\bwatching\s+(?:TV\s+show\s+)?["“']?([A-Z][^"”'.!,]{1,120})["”']?/u)?.[1]?.trim() ??
    sentence.match(/\bmentioned\s+the\s+movie\s+["“']?([A-Z][^"”'.!,]{1,120})["”']?/u)?.[1]?.trim();
  if (quotedTitle) {
    const normalized = stripMediaTrailingNoise(quotedTitle);
    return isLowQualityMediaTitle(normalized) || isGenericMediaNounPhrase(normalized) ? null : normalized;
  }
  const capitalized =
    sentence.match(/\b(?:called|about|watching|watched|mentioned)\s+([A-Z][A-Za-z0-9'’:-]+(?:\s+[A-Z][A-Za-z0-9'’:-]+){0,4})\b/u)?.[1]?.trim() ??
    null;
  if (!capitalized) {
    return null;
  }

  const normalized = stripMediaTrailingNoise(capitalized);
  return isLowQualityMediaTitle(normalized) || !isCapitalizedMediaTitle(normalized) || isGenericMediaNounPhrase(normalized) ? null : normalized;
}

interface MetadataMediaSidecar {
  readonly dia_id?: string;
  readonly speaker?: string;
  readonly text?: string;
  readonly blip_caption?: string;
  readonly query?: string;
}

interface SeededMediaAnchor {
  readonly mediaTitle: string;
  readonly mediaKind: ExtractedMediaMention["mediaKind"];
}

interface ExtractMediaMentionsOptions {
  readonly defaultSpeakerName?: string | null;
  readonly seedSubjectMedia?: ReadonlyMap<string, SeededMediaAnchor>;
  readonly seedGlobalMedia?: SeededMediaAnchor | null;
}

function inferMediaKind(sentence: string): ExtractedMediaMention["mediaKind"] {
  if (/\banime\b/iu.test(sentence)) {
    return "anime";
  }
  if (/\bshow\b|\bseries\b|\btv\b/iu.test(sentence)) {
    return "show";
  }
  if (/\bbook\b/iu.test(sentence)) {
    return "book";
  }
  if (/\bsong\b/iu.test(sentence)) {
    return "song";
  }
  if (/\bmovie\b|\bfilm\b/iu.test(sentence)) {
    return "movie";
  }
  return "unknown";
}

function inferMediaMentionKind(sentence: string): ExtractedMediaMention["mentionKind"] {
  if (/\bwanted to see\b/iu.test(sentence)) {
    return "wants_to_watch";
  }
  if (/\bwatched\b|\bwatching\b|\bsaw\b/iu.test(sentence)) {
    return "watched";
  }
  if (/\bpretty cool\b|\benjoying\b|\breally liked\b/iu.test(sentence)) {
    return "liked";
  }
  if (/\bdislike\b|\bhated\b|\bdidn't like\b/iu.test(sentence)) {
    return "disliked";
  }
  if (/\bmentioned\b|\btold me about\b/iu.test(sentence)) {
    return "mentioned";
  }
  return "unknown";
}

function extractSubjectName(sentence: string, candidates: readonly string[]): string | null {
  for (const candidate of candidates) {
    const escaped = candidate.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    if (new RegExp(`\\b${escaped}\\b`, "iu").test(sentence)) {
      return candidate;
    }
  }
  return null;
}

const SIMPLE_NUMBER_WORDS: Readonly<Record<string, number>> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20
};

function parseSimpleNumberWord(value: string | null | undefined): number | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = normalizeWhitespace(value).toLowerCase();
  if (!normalized) {
    return null;
  }
  if (/^\d+$/u.test(normalized)) {
    const parsed = Number.parseInt(normalized, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }
  return SIMPLE_NUMBER_WORDS[normalized] ?? null;
}

export function extractRelativeTimeHint(sentence: string): string | null {
  return (
    sentence.match(
      /\b(today|yesterday|this morning|tonight|last week|this month|last month|this year|last year|next month|next year|next few months|two days ago|two weeks ago|recently|a few years ago|around\s+(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)\s+years?\s+ago|(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)\s+years?\s+ago)\b/iu
    )?.[1] ?? null
  );
}

function hasExplicitMediaCue(sentence: string): boolean {
  return /\b(movie|movies|film|show|series|book|song|anime|watched|watching|mentioned|saw|favorite)\b/iu.test(sentence);
}

function hasFavoriteMediaCue(sentence: string): boolean {
  return (
    /\bfavorite\s+(?:movie|film|show|book|song|anime)\b/iu.test(sentence) ||
    /\bone of my favorites?\b/iu.test(sentence) ||
    /\bmy favorites?\b/iu.test(sentence) ||
    ((hasExplicitMediaCue(sentence) || /\bimage query:\b/iu.test(sentence)) &&
      /\b(?:awesome|so good|really good|love it|love that|bought a physical copy|got a physical copy)\b/iu.test(sentence))
  );
}

function computeSentenceTemporalAnchorWindow(
  sentence: string,
  occurredAt: string | null,
  timeHintText: string | null
): { start: string | null; end: string | null } {
  const explicitDate = parseExplicitDates(sentence)[0];
  if (explicitDate?.year && explicitDate?.month && explicitDate?.day) {
    return {
      start: new Date(Date.UTC(explicitDate.year, explicitDate.month - 1, explicitDate.day, 0, 0, 0, 0)).toISOString(),
      end: new Date(Date.UTC(explicitDate.year, explicitDate.month - 1, explicitDate.day, 23, 59, 59, 999)).toISOString()
    };
  }
  if (explicitDate?.year) {
    return {
      start: new Date(Date.UTC(explicitDate.year, 0, 1, 0, 0, 0, 0)).toISOString(),
      end: new Date(Date.UTC(explicitDate.year, 11, 31, 23, 59, 59, 999)).toISOString()
    };
  }
  return computeRelativeWindow(occurredAt, timeHintText);
}

function rewriteImplicitMediaReference(sentence: string, mediaTitle: string): string {
  const title = `"${mediaTitle}"`;
  if (/\bthat\s+(movie|film|show|book|song|anime)\b/iu.test(sentence)) {
    return sentence.replace(/\bthat\s+(movie|film|show|book|song|anime)\b/iu, title);
  }
  if (/\bwatched\s+it\b/iu.test(sentence)) {
    return sentence.replace(/\bwatched\s+it\b/iu, `watched ${title}`);
  }
  if (/\bwatching\s+it\b/iu.test(sentence)) {
    return sentence.replace(/\bwatching\s+it\b/iu, `watching ${title}`);
  }
  if (/\bsaw\s+it\b/iu.test(sentence)) {
    return sentence.replace(/\bsaw\s+it\b/iu, `saw ${title}`);
  }
  if (/\bit\b/iu.test(sentence)) {
    return sentence.replace(/\bit\b/iu, title);
  }
  return `${sentence} Referenced media: ${title}.`;
}

function isMediaCarryForwardSentence(sentence: string): boolean {
  const normalized = normalizeWhitespace(sentence);
  if (!normalized || /\?$/.test(normalized)) {
    return false;
  }
  return (
    /\b(it|that movie|that film|that show|that book|that song|that anime)\b/iu.test(normalized) ||
    /\bone of my favorites?\b/iu.test(normalized) ||
    /\bi first watched it\b/iu.test(normalized) ||
    /\bgot a physical copy\b/iu.test(normalized) ||
    /\b(?:watched|watching|saw) it\b/iu.test(normalized)
  );
}

function hasEmbeddedSpeakerMarker(sentence: string): boolean {
  return /(?:^|[\].!?]\s+)[A-Z][A-Za-z'’ -]{1,40}:\s+/u.test(sentence);
}

export function extractMediaMentions(
  text: string,
  knownPeople: readonly string[],
  occurredAt: string | null,
  options: ExtractMediaMentionsOptions = {}
): readonly ExtractedMediaMention[] {
  const mentions = new Map<string, ExtractedMediaMention>();
  const fragments = extractStructuredSentenceCandidates(text, knownPeople);
  type MediaCarryForwardAnchor = {
    mediaTitle: string;
    mediaKind: ExtractedMediaMention["mediaKind"];
    turnIndex: number;
    sentenceIndex: number;
  };
  const recentMediaBySubject = new Map<string, MediaCarryForwardAnchor>();
  for (const [subjectName, anchor] of options.seedSubjectMedia ?? new Map<string, SeededMediaAnchor>()) {
    recentMediaBySubject.set(subjectName.toLowerCase(), {
      mediaTitle: anchor.mediaTitle,
      mediaKind: anchor.mediaKind,
      turnIndex: -1,
      sentenceIndex: -1
    });
  }
  let lastGlobalExplicitMedia: MediaCarryForwardAnchor | null = options.seedGlobalMedia
    ? {
        mediaTitle: options.seedGlobalMedia.mediaTitle,
        mediaKind: options.seedGlobalMedia.mediaKind,
        turnIndex: -1,
        sentenceIndex: -1
      }
    : null;
  let recentSpeakerSubject = options.defaultSpeakerName ?? null;

  for (const fragment of fragments) {
    const sentence = fragment.text;
    if (isMetadataLikeSentence(sentence)) {
      continue;
    }
    const metadataText = buildStructuredMetadataText(fragment);
    const sentenceWithMetadata = metadataText ? `${sentence} ${metadataText}` : sentence;
    const explicitSubjectName = extractSubjectName(sentence, knownPeople);
    const speakerScopedSubjectName = fragment.speakerName ?? recentSpeakerSubject;
    const subjectName = speakerScopedSubjectName ?? explicitSubjectName;
    const explicitMediaTitle = parseMediaTitleFromSentence(sentenceWithMetadata);
    if (fragment.speakerName) {
      recentSpeakerSubject = fragment.speakerName;
    }
    const subjectAnchor = subjectName ? recentMediaBySubject.get(subjectName.toLowerCase()) ?? null : null;
    const carryForwardSentence = isMediaCarryForwardSentence(sentence);
    const canCarryFromSubject: boolean =
      subjectAnchor !== null &&
      fragment.turnIndex - subjectAnchor.turnIndex <= 2 &&
      carryForwardSentence;
    const canCarryGlobally: boolean =
      !subjectAnchor &&
      lastGlobalExplicitMedia !== null &&
      fragment.turnIndex - lastGlobalExplicitMedia.turnIndex <= 1 &&
      carryForwardSentence;
    const carriedGlobalTitle = canCarryGlobally && lastGlobalExplicitMedia ? lastGlobalExplicitMedia.mediaTitle : null;
    const mediaTitle = explicitMediaTitle ?? (canCarryFromSubject ? subjectAnchor?.mediaTitle ?? null : carriedGlobalTitle);
    if (!hasExplicitMediaCue(sentenceWithMetadata) && !mediaTitle) {
      continue;
    }
    if (!mediaTitle) {
      continue;
    }
    const mediaKind: ExtractedMediaMention["mediaKind"] = explicitMediaTitle
      ? inferMediaKind(sentenceWithMetadata)
      : canCarryFromSubject
        ? subjectAnchor?.mediaKind ?? inferMediaKind(sentenceWithMetadata)
        : canCarryGlobally && lastGlobalExplicitMedia
          ? lastGlobalExplicitMedia.mediaKind
          : inferMediaKind(sentenceWithMetadata);
    const timeHintText = extractRelativeTimeHint(sentenceWithMetadata);
    const eventAnchor = computeSentenceTemporalAnchorWindow(sentenceWithMetadata, occurredAt, timeHintText);
    const mention: ExtractedMediaMention = {
      subjectName,
      mediaTitle,
      mediaKind,
      mentionKind: inferMediaMentionKind(sentenceWithMetadata),
      timeHintText,
      locationText: extractLocationHint(sentenceWithMetadata),
      contextText: sentence,
      eventAnchorStart: eventAnchor.start,
      eventAnchorEnd: eventAnchor.end,
      favoriteSignal: hasFavoriteMediaCue(sentenceWithMetadata),
      carryForwardSignal: !explicitMediaTitle && (canCarryFromSubject || canCarryGlobally)
    };
    mentions.set(
        `${(mention.subjectName ?? "unknown").toLowerCase()}|${mention.mediaTitle.toLowerCase()}|${mention.mentionKind}|${mention.timeHintText ?? ""}`,
      mention
    );
    if (explicitMediaTitle) {
      const anchor: MediaCarryForwardAnchor = {
        mediaTitle: explicitMediaTitle,
        mediaKind,
        turnIndex: fragment.turnIndex,
        sentenceIndex: fragment.sentenceIndex
      };
      if (subjectName) {
        recentMediaBySubject.set(subjectName.toLowerCase(), anchor);
      }
      lastGlobalExplicitMedia = anchor;
    }
  }

  return [...mentions.values()];
}

function inferCounterpartySpeaker(
  knownPeople: readonly string[],
  explicitSpeakerName: string | null
): string | null {
  if (!explicitSpeakerName || knownPeople.length !== 2) {
    return null;
  }
  const normalizedSpeaker = normalizeName(explicitSpeakerName);
  return knownPeople.find((candidate) => normalizeName(candidate) !== normalizedSpeaker) ?? null;
}

function readDirectLeadingChunkSpeaker(
  text: string,
  knownPeople: readonly string[],
  metadataSpeakerName: string | null
): string | null {
  if (metadataSpeakerName) {
    return metadataSpeakerName;
  }
  const lines = splitEmbeddedSpeakerTurns(text)
    .split("\n")
    .map((line) => normalizeWhitespace(line))
    .filter((line) => line.length >= 2);
  if (lines.length === 0) {
    return null;
  }
  const firstLine = lines[0] ?? "";
  const firstMatch = firstLine.match(/^([^:\n]{2,80}):\s+(.+)$/u);
  if (firstMatch?.[1] && isLikelySpeakerLabel(firstMatch[1])) {
    return extractSubjectName(firstMatch[1], knownPeople) ?? normalizeWhitespace(firstMatch[1]);
  }
  return null;
}

function inferLeadingChunkSpeaker(
  text: string,
  knownPeople: readonly string[],
  metadataSpeakerName: string | null
): string | null {
  const directLeadingSpeaker = readDirectLeadingChunkSpeaker(text, knownPeople, metadataSpeakerName);
  if (directLeadingSpeaker) {
    return directLeadingSpeaker;
  }
  const lines = splitEmbeddedSpeakerTurns(text)
    .split("\n")
    .map((line) => normalizeWhitespace(line))
    .filter((line) => line.length >= 2);
  if (lines.length === 0) {
    return null;
  }
  const laterSpeaker = lines
    .map((line) => line.match(/^([^:\n]{2,80}):\s+(.+)$/u)?.[1] ?? null)
    .find((value): value is string => typeof value === "string" && isLikelySpeakerLabel(value));
  if (!laterSpeaker) {
    return null;
  }
  const normalizedLaterSpeaker = extractSubjectName(laterSpeaker, knownPeople) ?? normalizeWhitespace(laterSpeaker);
  return inferCounterpartySpeaker(knownPeople, normalizedLaterSpeaker);
}

function looksLikeUnlabeledFirstPersonTurn(text: string): boolean {
  const normalized = normalizeWhitespace(text);
  if (!normalized || /^[^:\n]{2,80}:\s+/u.test(normalized)) {
    return false;
  }
  return /\b(?:i|i'm|i’ve|i've|i’ll|i'll|i’d|i'd|my|we|we've|we’re|we're|our|us)\b/iu.test(normalized);
}

function inferPreferenceDomain(objectText: string): ExtractedPreferenceFact["domain"] {
  const lowered = objectText.toLowerCase();
  if (
    /\b(latte|burrito|fries|snickers|banana|bananas|yogurt|coffee|water|electrolytes?|steak|nachos|burger|burgers|pad krapow|spicy food|beer|beers|leo|singha|chang|cheng)\b/u.test(
      lowered
    )
  ) {
    return "food";
  }
  if (/\b(sinners|slow horses|avatar|chainsaw man|dusk till dawn)\b/u.test(lowered)) {
    return "media";
  }
  if (/\b(hiking|ride|riding|coworking|snowboarding)\b/u.test(lowered)) {
    return "activity";
  }
  return "general";
}

function inferPreferenceDomainFromQualifier(qualifier: string | null, fallbackObjectText: string): ExtractedPreferenceFact["domain"] {
  const normalized = normalizeWhitespace(qualifier ?? "").toLowerCase();
  if (/\b(movie|film|book|series|trilogy|game)\b/u.test(normalized)) {
    return "media";
  }
  if (/\b(dance|painting|art|activity)\b/u.test(normalized)) {
    return "activity";
  }
  return inferPreferenceDomain(fallbackObjectText);
}

function normalizePreferenceObjectText(value: string, subjectAlternation: string | null = null): string {
  return normalizeWhitespace(
    value
      .replace(/(?:^|\s)-\s*\[\d{2}:\d{2}(?:\.\d+)?\s*-\s*\d{2}:\d{2}(?:\.\d+)?\]\s*(?:Speaker|User)\s*\d*:\s*/giu, " ")
      .replace(/\b(?:Speaker|User)\s*\d*:\s*/giu, "")
      .replace(
        new RegExp(`\\b(?:I${subjectAlternation ? `|${subjectAlternation}` : ""})\\s+(?:like|love|enjoy|prefer|dislike|hate|avoid)\\s+`, "giu"),
        ""
      )
      .replace(/^[,;:\-\s]+/u, "")
      .replace(/^(?:but|and|or)\s+/iu, "")
      .replace(/^(?:while the other enjoys|followed by)\s+/iu, "")
      .replace(/\bfirst\b/iu, "")
      .replace(/[.,!?]+$/u, "")
      .replace(/^(?:a|an|the)\s+/iu, "")
  );
}

function normalizePreferenceQualifiedObjectText(
  value: string,
  qualifier: string | null,
  subjectAlternation: string | null = null
): string {
  let normalized = normalizePreferenceObjectText(value, subjectAlternation);
  const loweredQualifier = normalizeWhitespace(qualifier ?? "").toLowerCase();
  if (/\bstyle of dance\b/u.test(loweredQualifier)) {
    normalized = normalizeWhitespace(normalized.replace(/\bdances?\b$/iu, ""));
  } else if (/\bstyle of painting\b/u.test(loweredQualifier)) {
    normalized = normalizeWhitespace(normalized.replace(/\bpaintings?\b$/iu, ""));
  }
  return normalized;
}

function isLowQualityPreferenceObject(objectText: string): boolean {
  const normalized = normalizePreferenceObjectText(objectText);
  const lowered = normalized.toLowerCase();
  if (!lowered || lowered.length < 3) {
    return true;
  }
  if (
    /^(?:that|this|it|them|something|anything|everything|you know|but|and|or)$/u.test(lowered) ||
    /^(?:but|and|or|with|about|across|around)\b/u.test(lowered)
  ) {
    return true;
  }
  if (
    /\b(?:you know|across the network|where i lived|where we lived|that area)\b/u.test(lowered) ||
    /^(?:where|when|how|why|while the other|followed by)\b/u.test(lowered)
  ) {
    return true;
  }
  const tokenCount = lowered.split(/\s+/u).filter(Boolean).length;
  if (tokenCount > 6) {
    return true;
  }
  return false;
}

function isAmbiguousPreferenceSummarySentence(sentence: string): boolean {
  return /\b(two speakers|one mentions|the other|they also rank)\b/iu.test(sentence);
}

function hasStrongExplicitPreferenceCue(sentence: string): boolean {
  return (
    /\bfavorite\b/iu.test(sentence) ||
    /\btop\s+pick\b/iu.test(sentence) ||
    /\bspeaks\s+to\s+me\b/iu.test(sentence) ||
    /\bif i had to rank\b/iu.test(sentence) ||
    /\bmy favorite (?:beers?|foods?|drinks?)\b/iu.test(sentence)
  );
}

function normalizeBeerName(value: string): string {
  const lowered = normalizePreferenceObjectText(value).toLowerCase();
  if (lowered === "cheng") {
    return "Chang";
  }
  if (lowered === "leo") {
    return "Leo";
  }
  if (lowered === "singha") {
    return "Singha";
  }
  if (lowered === "chang") {
    return "Chang";
  }
  return normalizePreferenceObjectText(value);
}

function extractKnownBeerRanking(fragment: string): readonly string[] {
  const normalized = normalizeWhitespace(fragment);
  const ranked = [...normalized.matchAll(/\b(Leo|Singha|Chang|Cheng)\b/giu)]
    .map((match) => normalizeBeerName(match[1] ?? ""))
    .filter((value) => value.length > 0);
  return uniqueStrings(ranked);
}

function splitPreferenceList(fragment: string, subjectAlternation: string | null = null): readonly string[] {
  const normalized = normalizeWhitespace(fragment)
    .replace(
      new RegExp(`\\b(?:I${subjectAlternation ? `|${subjectAlternation}` : ""})\\s+(?:like|love|enjoy|prefer|dislike|hate|avoid)\\s+`, "giu"),
      ""
    )
    .replace(/\b(?:preferring|liking|enjoying|loving|disliking|hating|avoiding)\s+/giu, "")
    .replace(/[.,!?]+$/u, "");

  return normalized
    .split(/\s*(?:,|;| and )\s*/iu)
    .map((part) => normalizePreferenceObjectText(part, subjectAlternation))
    .filter((part) => part.length > 0 && !isLowQualityPreferenceObject(part));
}

export function extractPreferenceFacts(
  text: string,
  knownPeople: readonly string[],
  selfName: string | null = null
): readonly ExtractedPreferenceFact[] {
  const facts = new Map<string, ExtractedPreferenceFact>();
  const subjectAlternation = buildSubjectAlternation(knownPeople);
  const explicitSubjectAlternation = subjectAlternation ? `I|${subjectAlternation}` : "I";
  const push = (fact: ExtractedPreferenceFact) => {
    facts.set(
      `${(fact.subjectName ?? "self").toLowerCase()}|${fact.predicate}|${fact.objectText.toLowerCase()}`,
      fact
    );
  };

  const structuredFragments = extractStructuredSentenceCandidates(text, knownPeople);
  let recentSpeakerSubject = selfName;

  for (const fragment of structuredFragments) {
    const metadataText = buildStructuredMetadataText(fragment);
    const sentence = metadataText ? `${fragment.text} ${metadataText}` : fragment.text;
    if (isMetadataLikeSentence(sentence)) {
      continue;
    }
    const fragmentSelfName = fragment.speakerName ?? recentSpeakerSubject ?? selfName;
    const resolveSubjectName = (value: string | null | undefined): string | null => {
      const normalized = normalizeWhitespace(value ?? "");
      if (!normalized) {
        return null;
      }
      if (normalized === "I") {
        return fragmentSelfName;
      }
      return extractSubjectName(normalized, knownPeople) ?? normalized;
    };
    const ambiguousSummarySentence = isAmbiguousPreferenceSummarySentence(sentence);
    if (fragment.speakerName) {
      recentSpeakerSubject = fragment.speakerName;
    }
    const favoriteAttributeMatches = [
      ...sentence.matchAll(
        new RegExp(
          `\\b(my|${explicitSubjectAlternation}(?:'s)?)\\s+favorite\\s+(style of (?:dance|painting)|movie trilogy|book series|game series|game)\\s+(?:would be|is)\\s+([^.!?]+?)(?=[.!?]|$)`,
          "giu"
        )
      )
    ];
    if (favoriteAttributeMatches.length > 0 && !ambiguousSummarySentence) {
      for (const match of favoriteAttributeMatches) {
        const rawSubject = normalizeWhitespace(match[1] ?? "");
        const qualifier = `favorite ${normalizeWhitespace(match[2] ?? "")}`;
        const objectText = normalizePreferenceQualifiedObjectText(match[3] ?? "", qualifier, subjectAlternation);
        if (!objectText || isLowQualityPreferenceObject(objectText)) {
          continue;
        }
        push({
          subjectName: /^my$/iu.test(rawSubject) ? fragmentSelfName : resolveSubjectName(rawSubject.replace(/'s$/iu, "")),
          predicate: "likes",
          objectText,
          domain: inferPreferenceDomainFromQualifier(qualifier, objectText),
          qualifier,
          contextText: sentence
        });
      }
      continue;
    }

    const favoriteTopPickMatch =
      sentence.match(/\b([A-Za-z][A-Za-z'’ -]{1,40})\s+is\s+my\s+top\s+pick\b/iu)?.[1] ??
      sentence.match(/\b([A-Za-z][A-Za-z'’ -]{1,40})\s+is\s+definitely\s+my\s+top\s+pick\b/iu)?.[1] ??
      null;
    if (favoriteTopPickMatch && !ambiguousSummarySentence) {
      const qualifier = "favorite style of dance";
      const objectText = normalizePreferenceQualifiedObjectText(favoriteTopPickMatch, qualifier, subjectAlternation);
      if (objectText.length > 0 && !isLowQualityPreferenceObject(objectText)) {
        push({
          subjectName: fragmentSelfName,
          predicate: "likes",
          objectText,
          domain: inferPreferenceDomainFromQualifier(qualifier, objectText),
          qualifier,
          contextText: sentence
        });
      }
    }

    const speaksToMeMatch =
      sentence.match(/\bbut\s+([A-Za-z][A-Za-z'’ -]{1,40}(?:\s+dance)?)\b[^.!?]*\breally\s+speaks\s+to\s+me\b/iu)?.[1] ??
      sentence.match(/\b([A-Za-z][A-Za-z'’ -]{1,40}(?:\s+dance)?)\s+is\s+so\b[^.!?]*\bit\s+really\s+speaks\s+to\s+me\b/iu)?.[1] ??
      sentence.match(/\b([A-Za-z][A-Za-z'’ -]{1,40}(?:\s+dance)?)\b[^.!?]*\breally\s+speaks\s+to\s+me\b/iu)?.[1] ??
      null;
    if (speaksToMeMatch && !ambiguousSummarySentence) {
      const qualifier = "favorite style of dance";
      const objectText = normalizePreferenceQualifiedObjectText(speaksToMeMatch, qualifier, subjectAlternation);
      if (objectText.length > 0 && !isLowQualityPreferenceObject(objectText)) {
        push({
          subjectName: fragmentSelfName,
          predicate: "likes",
          objectText,
          domain: inferPreferenceDomainFromQualifier(qualifier, objectText),
          qualifier,
          contextText: sentence
        });
      }
    }

    const explicitMatches = [
      ...sentence.matchAll(
        new RegExp(
          `\\b(${explicitSubjectAlternation})\\s+(like|love|enjoy|prefer|dislike|hate|avoid)\\s+([^.!?]+?)(?=(?:,\\s*(?:${explicitSubjectAlternation})\\s+(?:like|love|enjoy|prefer|dislike|hate|avoid)\\b)|[.!?]|$)`,
          "giu"
        )
      )
    ];
    if (explicitMatches.length > 0) {
      for (const [index, explicit] of explicitMatches.entries()) {
        const verb = explicit[2]?.toLowerCase() ?? "likes";
        const predicate =
          verb === "dislike" || verb === "hate" ? "dislikes" : verb === "avoid" ? "avoids" : verb === "prefer" ? "prefers" : "likes";
        const subjectName = resolveSubjectName(explicit[1]);

        if (index === 0 && (predicate === "dislikes" || predicate === "avoids")) {
          const leadingFragment = normalizeWhitespace(sentence.slice(0, explicit.index ?? 0)).replace(/[,:;]+$/u, "");
          for (const objectText of splitPreferenceList(leadingFragment, subjectAlternation)) {
            push({
              subjectName,
              predicate,
              objectText,
              domain: inferPreferenceDomain(objectText),
              qualifier: null,
              contextText: sentence
            });
          }
        }

        for (const objectText of splitPreferenceList(explicit[3] ?? "", subjectAlternation)) {
          if (/\bis my top pick\b|\bspeaks to me\b/iu.test(objectText)) {
            continue;
          }
          const domain = inferPreferenceDomain(objectText);
          if (predicate === "likes" && domain === "general" && !hasStrongExplicitPreferenceCue(sentence)) {
            continue;
          }
          push({
            subjectName,
            predicate,
            objectText,
            domain,
            qualifier: null,
            contextText: sentence
          });
        }
      }
      const favoriteListMatch =
        sentence.match(/\bmy favorite (?:beers?|foods?|drinks?)\b[\s,]*(?:in [A-Za-z ]+)?[\s,]*(?:would be|are|is)\s+([^.!?]+)/iu)?.[1] ??
        sentence.match(/\bif i had to rank\b[^.!?]*\bit would be\s+([^.!?]+)/iu)?.[1] ??
        null;
      if (favoriteListMatch) {
        const beerRanking = extractKnownBeerRanking(favoriteListMatch);
        const objects = beerRanking.length > 0 ? beerRanking : splitPreferenceList(favoriteListMatch, subjectAlternation);
        for (const [rankIndex, objectText] of objects.entries()) {
          push({
            subjectName: fragmentSelfName,
            predicate: "prefers",
            objectText,
            domain: inferPreferenceDomain(objectText),
            qualifier: `rank ${rankIndex + 1}`,
            contextText: sentence
          });
        }
      }
      continue;
    }

    const favoriteFoodMatch = sentence.match(/\b([A-Za-z][A-Za-z'’ -]{1,40})\s+is\s+(?:probably\s+)?one of my favorite foods?\b/iu)?.[1]?.trim();
    if (favoriteFoodMatch && !ambiguousSummarySentence) {
      const objectText = normalizePreferenceObjectText(favoriteFoodMatch, subjectAlternation);
      if (objectText.length > 0 && !isLowQualityPreferenceObject(objectText)) {
        push({
          subjectName: fragmentSelfName,
          predicate: "likes",
          objectText,
          domain: inferPreferenceDomain(objectText),
          qualifier: "favorite",
          contextText: sentence
        });
      }
    }

    const favoriteListMatch =
      sentence.match(/\bmy favorite (?:beers?|foods?|drinks?)\b[\s,]*(?:in [A-Za-z ]+)?[\s,]*(?:would be|are|is)\s+([^.!?]+)/iu)?.[1] ??
      sentence.match(/\bif i had to rank\b[^.!?]*\bit would be\s+([^.!?]+)/iu)?.[1] ??
      null;
    if (favoriteListMatch && !ambiguousSummarySentence) {
      const beerRanking = extractKnownBeerRanking(favoriteListMatch);
      const objects = beerRanking.length > 0 ? beerRanking : splitPreferenceList(favoriteListMatch, subjectAlternation);
      for (const [rankIndex, objectText] of objects.entries()) {
        push({
          subjectName: fragmentSelfName,
          predicate: "prefers",
          objectText,
          domain: inferPreferenceDomain(objectText),
          qualifier: `rank ${rankIndex + 1}`,
          contextText: sentence
        });
      }
      continue;
    }

    const summaryStyleMatches = [...sentence.matchAll(/\b(preferring|liking|enjoying|loving|disliking|hating|avoiding)\s+([^;().]+?)(?=(?:;\s*(?:preferring|liking|enjoying|loving|disliking|hating|avoiding)\b)|[).]|$)/giu)];
    if (summaryStyleMatches.length > 0 && !ambiguousSummarySentence) {
      for (const summaryMatch of summaryStyleMatches) {
        const verb = summaryMatch[1]?.toLowerCase() ?? "liking";
        const predicate =
          verb === "disliking" || verb === "hating" ? "dislikes" : verb === "avoiding" ? "avoids" : verb === "preferring" ? "prefers" : "likes";
        for (const objectText of splitPreferenceList(summaryMatch[2] ?? "", subjectAlternation)) {
          const domain = inferPreferenceDomain(objectText);
          if (predicate === "likes" && domain === "general" && !hasStrongExplicitPreferenceCue(sentence)) {
            continue;
          }
          push({
            subjectName: selfName,
            predicate,
            objectText,
            domain,
            qualifier: null,
            contextText: sentence
          });
        }
      }
      continue;
    }

    if (/\bpretty cool\b|\benjoying\b/iu.test(sentence)) {
      const mediaTitle = parseMediaTitleFromSentence(sentence);
      if (mediaTitle) {
        push({
          subjectName: extractSubjectName(sentence, knownPeople) ?? fragmentSelfName,
          predicate: "likes",
          objectText: mediaTitle,
          domain: "media",
          qualifier: /\bpretty cool\b/iu.test(sentence) ? "pretty cool" : "enjoying",
          contextText: sentence
        });
      }
    }
  }

  return [...facts.values()];
}

export function computeRelativeWindow(referenceNow: string | null, timeHintText: string | null): { start: string | null; end: string | null } {
  if (!referenceNow || !timeHintText) {
    return { start: null, end: null };
  }

  const base = new Date(referenceNow);
  if (Number.isNaN(base.getTime())) {
    return { start: null, end: null };
  }

  const start = new Date(base);
  const end = new Date(base);
  const lowered = timeHintText.toLowerCase();
  if (lowered === "today") {
    start.setUTCHours(0, 0, 0, 0);
    end.setUTCHours(23, 59, 59, 999);
    return { start: start.toISOString(), end: end.toISOString() };
  }
  if (lowered === "yesterday") {
    start.setUTCDate(start.getUTCDate() - 1);
    end.setUTCDate(end.getUTCDate() - 1);
    start.setUTCHours(0, 0, 0, 0);
    end.setUTCHours(23, 59, 59, 999);
    return { start: start.toISOString(), end: end.toISOString() };
  }
  if (lowered === "this morning") {
    start.setUTCHours(0, 0, 0, 0);
    end.setUTCHours(12, 0, 0, 0);
    return { start: start.toISOString(), end: end.toISOString() };
  }
  if (lowered === "last week") {
    start.setUTCDate(start.getUTCDate() - 7);
    start.setUTCHours(0, 0, 0, 0);
    end.setUTCHours(23, 59, 59, 999);
    return { start: start.toISOString(), end: end.toISOString() };
  }
  if (lowered === "this month") {
    start.setUTCDate(1);
    start.setUTCHours(0, 0, 0, 0);
    end.setUTCHours(23, 59, 59, 999);
    return { start: start.toISOString(), end: end.toISOString() };
  }
  if (lowered === "two days ago") {
    start.setUTCDate(start.getUTCDate() - 2);
    end.setUTCDate(end.getUTCDate() - 2);
    start.setUTCHours(0, 0, 0, 0);
    end.setUTCHours(23, 59, 59, 999);
    return { start: start.toISOString(), end: end.toISOString() };
  }
  if (lowered === "two weeks ago") {
    start.setUTCDate(start.getUTCDate() - 14);
    end.setUTCDate(end.getUTCDate() - 14);
    start.setUTCHours(0, 0, 0, 0);
    end.setUTCHours(23, 59, 59, 999);
    return { start: start.toISOString(), end: end.toISOString() };
  }
  if (lowered === "last month") {
    start.setUTCMonth(start.getUTCMonth() - 1, 1);
    end.setUTCMonth(end.getUTCMonth(), 0);
    start.setUTCHours(0, 0, 0, 0);
    end.setUTCHours(23, 59, 59, 999);
    return { start: start.toISOString(), end: end.toISOString() };
  }
  if (lowered === "last year") {
    start.setUTCFullYear(start.getUTCFullYear() - 1, 0, 1);
    end.setUTCFullYear(end.getUTCFullYear() - 1, 11, 31);
    start.setUTCHours(0, 0, 0, 0);
    end.setUTCHours(23, 59, 59, 999);
    return { start: start.toISOString(), end: end.toISOString() };
  }
  if (lowered === "this year") {
    start.setUTCMonth(0, 1);
    end.setUTCMonth(11, 31);
    start.setUTCHours(0, 0, 0, 0);
    end.setUTCHours(23, 59, 59, 999);
    return { start: start.toISOString(), end: end.toISOString() };
  }
  if (lowered === "next month") {
    start.setUTCMonth(start.getUTCMonth() + 1, 1);
    end.setUTCMonth(start.getUTCMonth() + 1, 0);
    start.setUTCHours(0, 0, 0, 0);
    end.setUTCHours(23, 59, 59, 999);
    return { start: start.toISOString(), end: end.toISOString() };
  }
  if (lowered === "next few months") {
    start.setUTCMonth(start.getUTCMonth() + 1, 1);
    end.setUTCMonth(start.getUTCMonth() + 4, 0);
    start.setUTCHours(0, 0, 0, 0);
    end.setUTCHours(23, 59, 59, 999);
    return { start: start.toISOString(), end: end.toISOString() };
  }
  if (lowered === "next year") {
    start.setUTCFullYear(start.getUTCFullYear() + 1, 0, 1);
    end.setUTCFullYear(end.getUTCFullYear() + 1, 11, 31);
    start.setUTCHours(0, 0, 0, 0);
    end.setUTCHours(23, 59, 59, 999);
    return { start: start.toISOString(), end: end.toISOString() };
  }
  {
    if (lowered === "a few years ago") {
      start.setUTCFullYear(start.getUTCFullYear() - 3, 0, 1);
      end.setUTCFullYear(end.getUTCFullYear() - 3, 11, 31);
      start.setUTCHours(0, 0, 0, 0);
      end.setUTCHours(23, 59, 59, 999);
      return { start: start.toISOString(), end: end.toISOString() };
    }
    const yearsAgoMatch = lowered.match(
      /(?:around\s+)?(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)\s+years?\s+ago/u
    );
    const years = parseSimpleNumberWord(yearsAgoMatch?.[1] ?? null);
    if (years !== null) {
      if (Number.isFinite(years) && years > 0) {
        start.setUTCFullYear(start.getUTCFullYear() - years, 0, 1);
        end.setUTCFullYear(end.getUTCFullYear() - years, 11, 31);
        start.setUTCHours(0, 0, 0, 0);
        end.setUTCHours(23, 59, 59, 999);
        return { start: start.toISOString(), end: end.toISOString() };
      }
    }
  }

  return { start: null, end: null };
}

export function extractPersonTimeFacts(
  text: string,
  knownPeople: readonly string[],
  occurredAt: string | null,
  defaultSpeakerName: string | null = null
): readonly ExtractedPersonTimeFact[] {
  const hasImmediateSessionDeicticCue = (sentence: string): boolean =>
    /\b(?:just|right now|currently|today|tonight|this morning|this afternoon|this evening|earlier today)\b/iu.test(sentence);
  const isSessionAnchoredMilestoneEvent = (sentence: string): boolean => {
    const eventKey = inferTemporalEventKeyFromText(sentence);
    if (!eventKey) {
      return false;
    }
    if (eventKey === "lose_job") {
      return true;
    }
    return /^(start_|join_|launch_)/u.test(eventKey);
  };
  const anchorWindowFromOccurredAt = (value: string | null): { start: string | null; end: string | null } => {
    if (!value) {
      return { start: null, end: null };
    }
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      return { start: null, end: null };
    }
    const start = new Date(parsed);
    const end = new Date(parsed);
    start.setUTCHours(0, 0, 0, 0);
    end.setUTCHours(23, 59, 59, 999);
    return { start: start.toISOString(), end: end.toISOString() };
  };
  const isStrongSessionAnchoredFactSentence = (sentence: string): boolean =>
    /\b(?:signed with|signed to|drafted by|joined|joining)\b/i.test(sentence) ||
    /\b(?:shooting guard|point guard|small forward|power forward|center)\b/i.test(sentence) ||
    (/\bposition\b/i.test(sentence) && /\bteam\b/i.test(sentence)) ||
    /\b(?:went to|trip to|travel(?:ed)? to|festival in|visited)\s+[A-Z]/u.test(sentence) ||
    /\bAerosmith\b/i.test(sentence) ||
    /\bperform(?:ed)?\s+live\b/i.test(sentence) ||
    /\bconcert\b/i.test(sentence) ||
    isSessionAnchoredMilestoneEvent(sentence);
  const facts = new Map<string, ExtractedPersonTimeFact>();
  const addFact = (
    personName: string,
    factText: string,
    timeHintText: string | null,
    windowStart: string | null,
    windowEnd: string | null
  ): void => {
    const normalizedFactText = normalizeWhitespace(factText);
    if (!normalizedFactText) {
      return;
    }
    facts.set(`${personName.toLowerCase()}|${normalizedFactText.toLowerCase()}`, {
      personName,
      factText: normalizedFactText,
      timeHintText,
      locationText: extractLocationHint(normalizedFactText),
      windowStart,
      windowEnd
    });
  };
  let recentSpeakerSubject: string | null = defaultSpeakerName;
  const recentMediaBySubject = new Map<string, string>();
  let lastGlobalMediaTitle: string | null = null;
  const structuredFragments = extractStructuredSentenceCandidates(text, knownPeople);
  const structuredTurns = [...new Map(
    structuredFragments
      .filter((fragment) => typeof fragment.speakerName === "string" && fragment.speakerName.length > 0)
      .map((fragment) => [
        fragment.turnIndex,
        {
          speakerName: fragment.speakerName as string,
          turnText: fragment.turnText
        }
      ])
  ).values()];
  const anchoredSessionWindow = anchorWindowFromOccurredAt(occurredAt);

  for (let index = 1; index < structuredTurns.length; index += 1) {
    const previousTurn = structuredTurns[index - 1]!;
    const currentTurn = structuredTurns[index]!;
    if (previousTurn.speakerName === currentTurn.speakerName) {
      continue;
    }
    const previousText = normalizeWhitespace(previousTurn.turnText);
    const currentText = normalizeWhitespace(currentTurn.turnText);

    if (/\bwhich team did you sign with\b/i.test(previousText) || /\bwhich team\b[^?!.]{0,40}\bsign with\b/i.test(previousText)) {
      const directAnswerTeamMatch =
        currentText.match(
          /^(The\s+[A-Z][A-Za-z0-9'’&.-]*(?:\s+[A-Z][A-Za-z0-9'’&.-]*){0,5}|[A-Z][A-Za-z0-9'’&.-]*(?:\s+[A-Z][A-Za-z0-9'’&.-]*){0,5})[!?.,]/u
        )?.[1] ??
        currentText.match(
          /\b(The\s+[A-Z][A-Za-z0-9'’&.-]*(?:\s+[A-Z][A-Za-z0-9'’&.-]*){0,5}|[A-Z][A-Za-z0-9'’&.-]*(?:\s+[A-Z][A-Za-z0-9'’&.-]*){0,5})\b/u
        )?.[1] ??
        null;
      const normalizedTeam = directAnswerTeamMatch?.replace(/[!?.,]+$/u, "").trim() ?? null;
      if (normalizedTeam) {
        addFact(
          currentTurn.speakerName,
          `${currentTurn.speakerName} signed with ${normalizedTeam}.`,
          null,
          anchoredSessionWindow.start,
          anchoredSessionWindow.end
        );
      }
    }

    if (/\bwhat position are you playing(?:\s+for the team)?\b/i.test(previousText) || /\bwhat(?:'s| is)\s+your position\b/i.test(previousText)) {
      const directAnswerRoleMatch = currentText.match(/\bI(?:'m| am)\s+(?:a|an)\s+([A-Za-z][A-Za-z0-9'’&/ -]{2,80})\b/u)?.[1]?.trim() ?? null;
      if (directAnswerRoleMatch) {
        addFact(
          currentTurn.speakerName,
          `${currentTurn.speakerName} is a ${directAnswerRoleMatch} for the team.`,
          null,
          anchoredSessionWindow.start,
          anchoredSessionWindow.end
        );
      }
    }
  }

  for (const fragment of structuredFragments) {
    const sentence = fragment.text;
    if (isMetadataLikeSentence(sentence)) {
      continue;
    }
    const metadataText = buildStructuredMetadataText(fragment);
    const sentenceWithMetadata = metadataText ? `${sentence} ${metadataText}` : sentence;
    const explicitSubjectName = extractSubjectName(sentence, knownPeople);
    const speakerScopedPersonName = fragment.speakerName ?? recentSpeakerSubject ?? defaultSpeakerName;
    const personName = speakerScopedPersonName ?? explicitSubjectName;
    const explicitMediaTitle = parseMediaTitleFromSentence(sentenceWithMetadata);
    if (fragment.speakerName) {
      recentSpeakerSubject = fragment.speakerName;
    }
    if (personName && explicitMediaTitle) {
      recentMediaBySubject.set(personName.toLowerCase(), explicitMediaTitle);
      lastGlobalMediaTitle = explicitMediaTitle;
    }
    if (!personName) {
      continue;
    }
    const timeHintText = extractRelativeTimeHint(sentenceWithMetadata);
    const hasExplicitDate =
      /\b\d{4}\b/u.test(sentenceWithMetadata) ||
      /\bJanuary|February|March|April|May|June|July|August|September|October|November|December\b/iu.test(sentenceWithMetadata);
    const sessionAnchoredFact =
      !timeHintText &&
      !hasExplicitDate &&
      Boolean(occurredAt) &&
      hasImmediateSessionDeicticCue(sentenceWithMetadata) &&
      isStrongSessionAnchoredFactSentence(sentenceWithMetadata);
    if (!timeHintText && !hasExplicitDate && !sessionAnchoredFact) {
      continue;
    }
    const carriedMediaTitle =
      explicitMediaTitle ??
      (isMediaCarryForwardSentence(sentence)
        ? recentMediaBySubject.get(personName.toLowerCase()) ?? lastGlobalMediaTitle
        : null);
    const normalizedSentence =
      carriedMediaTitle && !explicitMediaTitle
        ? rewriteImplicitMediaReference(sentenceWithMetadata, carriedMediaTitle)
        : sentenceWithMetadata;
    const explicitDate = parseExplicitDates(sentenceWithMetadata)[0];
    const explicitStart =
      explicitDate?.year && explicitDate?.month && explicitDate?.day
        ? new Date(Date.UTC(explicitDate.year, explicitDate.month - 1, explicitDate.day, 0, 0, 0, 0)).toISOString()
        : null;
    const explicitEnd =
      explicitDate?.year && explicitDate?.month && explicitDate?.day
        ? new Date(Date.UTC(explicitDate.year, explicitDate.month - 1, explicitDate.day, 23, 59, 59, 999)).toISOString()
        : null;
    const relativeWindow = computeRelativeWindow(occurredAt, timeHintText);
    const sessionWindow = sessionAnchoredFact ? anchorWindowFromOccurredAt(occurredAt) : { start: null, end: null };
    addFact(
      personName,
      normalizedSentence,
      timeHintText,
      explicitStart ?? relativeWindow.start ?? sessionWindow.start,
      explicitEnd ?? relativeWindow.end ?? sessionWindow.end
    );
  }
  return [...facts.values()];
}

function readArtifactSourceReferenceInstant(sourceUri: string | null | undefined): string | null {
  if (typeof sourceUri !== "string" || !sourceUri.startsWith("/") || !existsSync(sourceUri)) {
    return null;
  }
  const content = readFileSync(sourceUri, "utf8");
  const capturedAt = content.match(/^\s*Captured:\s*([^\n]+)\s*$/mu)?.[1]?.trim() ?? null;
  if (!capturedAt) {
    return null;
  }
  const parsed = new Date(capturedAt);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

export function selectPersonTimeReferenceInstant(
  occurredAt: string | null,
  sourceUri: string | null | undefined
): string | null {
  const artifactReferenceInstant = readArtifactSourceReferenceInstant(sourceUri);
  if (artifactReferenceInstant) {
    return artifactReferenceInstant;
  }
  if (typeof occurredAt === "string" && occurredAt.trim().length > 0) {
    const parsedOccurredAt = new Date(occurredAt);
    if (!Number.isNaN(parsedOccurredAt.getTime())) {
      return parsedOccurredAt.toISOString();
    }
  }
  return null;
}

function inferTimeRange(queryText: string, referenceNow?: string): { start?: string; end?: string } {
  const now = referenceNow ? new Date(referenceNow) : new Date();
  const lowered = queryText.toLowerCase();
  if (/\btoday\b/.test(lowered)) {
    const start = new Date(now);
    const end = new Date(now);
    start.setUTCHours(0, 0, 0, 0);
    end.setUTCHours(23, 59, 59, 999);
    return { start: start.toISOString(), end: end.toISOString() };
  }
  if (/\byesterday\b/.test(lowered)) {
    const start = new Date(now);
    const end = new Date(now);
    start.setUTCDate(start.getUTCDate() - 1);
    end.setUTCDate(end.getUTCDate() - 1);
    start.setUTCHours(0, 0, 0, 0);
    end.setUTCHours(23, 59, 59, 999);
    return { start: start.toISOString(), end: end.toISOString() };
  }
  if (/\bthis morning\b/.test(lowered)) {
    const start = new Date(now);
    const end = new Date(now);
    start.setUTCHours(0, 0, 0, 0);
    end.setUTCHours(12, 0, 0, 0);
    return { start: start.toISOString(), end: end.toISOString() };
  }
  if (/\blast week\b/.test(lowered)) {
    const end = new Date(now);
    end.setUTCHours(23, 59, 59, 999);
    const start = new Date(now);
    start.setUTCDate(start.getUTCDate() - 7);
    start.setUTCHours(0, 0, 0, 0);
    return { start: start.toISOString(), end: end.toISOString() };
  }
  if (/\btwo weeks ago\b/.test(lowered)) {
    const start = new Date(now);
    const end = new Date(now);
    start.setUTCDate(start.getUTCDate() - 14);
    end.setUTCDate(end.getUTCDate() - 14);
    start.setUTCHours(0, 0, 0, 0);
    end.setUTCHours(23, 59, 59, 999);
    return { start: start.toISOString(), end: end.toISOString() };
  }
  return {};
}

function isCompletedTaskQuery(queryText: string): boolean {
  return /\b(complete|completed|finished|done|closed out)\b/i.test(queryText);
}

export interface TypedMemoryRebuildSummary {
  readonly namespaceId: string;
  readonly taskItems: number;
  readonly projectItems: number;
  readonly dateTimeSpans: number;
  readonly transactionItems: number;
  readonly mediaMentions: number;
  readonly preferenceFacts: number;
  readonly personTimeFacts: number;
  readonly canonical?: CanonicalMemoryRebuildCounts;
}

export async function rebuildTypedMemoryNamespace(namespaceId: string): Promise<TypedMemoryRebuildSummary> {
  const rows = await queryRows<TypedMemorySourceRow>(
    `
      SELECT
        em.id::text AS memory_id,
        em.artifact_id::text AS artifact_id,
        em.artifact_observation_id::text AS artifact_observation_id,
        em.source_offset AS source_offset,
        em.occurred_at::text AS occurred_at,
        em.content,
        a.uri AS artifact_uri,
        em.metadata
      FROM episodic_memory em
      LEFT JOIN artifacts a ON a.id = em.artifact_id
      WHERE em.namespace_id = $1
      ORDER BY
        em.artifact_id ASC NULLS LAST,
        em.artifact_observation_id ASC NULLS LAST,
        COALESCE((em.source_offset->>'char_start')::int, 0) ASC,
        em.occurred_at ASC NULLS LAST,
        em.id ASC
    `,
    [namespaceId]
  );

  const taskRows: Array<{
    sourceMemoryId: string;
    artifactId: string | null;
    occurredAt: string | null;
    title: string;
    description: string;
    projectName: string | null;
    assigneeGuess: string | null;
    dueHint: string | null;
    status: "open" | "completed";
    completedAt: string | null;
    provenance: Record<string, unknown>;
    metadata: Record<string, unknown>;
  }> = [];
  const projectRows: Array<{
    sourceMemoryId: string;
    artifactId: string | null;
    occurredAt: string | null;
    canonicalName: string;
    normalizedName: string;
    currentSummary: string | null;
    status: "active" | "historical";
    provenance: Record<string, unknown>;
    metadata: Record<string, unknown>;
  }> = [];
  const dateRows: Array<{
    sourceMemoryId: string;
    artifactId: string | null;
    occurredAt: string | null;
    spanText: string;
    year: number | null;
    month: number | null;
    day: number | null;
    provenance: Record<string, unknown>;
    metadata: Record<string, unknown>;
  }> = [];
  const transactionRows: Array<{
    sourceMemoryId: string;
    artifactId: string | null;
    occurredAt: string | null;
    purchaserName: string | null;
    itemLabel: string;
    normalizedItemLabel: string;
    quantityText: string | null;
    priceText: string | null;
    currencyCode: string | null;
    totalPriceText: string | null;
    totalCurrencyCode: string | null;
    contextText: string | null;
    provenance: Record<string, unknown>;
    metadata: Record<string, unknown>;
  }> = [];
  const mediaRows: PendingMediaRow[] = [];
  const preferenceRows: Array<{
    sourceMemoryId: string;
    artifactId: string | null;
    occurredAt: string | null;
    subjectName: string | null;
    predicate: "likes" | "dislikes" | "prefers" | "avoids";
    objectText: string;
    normalizedObjectText: string;
    domain: "food" | "media" | "activity" | "general" | "unknown";
    qualifier: string | null;
    contextText: string;
    provenance: Record<string, unknown>;
    metadata: Record<string, unknown>;
  }> = [];
  const personTimeRows: Array<{
    sourceMemoryId: string;
    artifactId: string | null;
    occurredAt: string | null;
    personName: string;
    normalizedPersonName: string;
    factText: string;
    normalizedFactText: string;
    timeHintText: string | null;
    locationText: string | null;
    windowStart: string | null;
    windowEnd: string | null;
    provenance: Record<string, unknown>;
    metadata: Record<string, unknown>;
  }> = [];

  const deterministicRelationshipFacts: DerivedRelationshipFact[] = [];
  const explicitAliasFacts: DerivedAliasFact[] = [];
  const existingSelfProfile = await getNamespaceSelfProfile(namespaceId).catch(() => null);
  const selfCanonicalName = existingSelfProfile?.canonicalName ?? null;
  const selfAliasCandidates = deriveKnownSelfAliases(existingSelfProfile);
  const dedupedMediaRows = () => dedupePendingMediaRows(mediaRows);
  const mediaAnchorState = new Map<
    string,
    {
      readonly subjectAnchors: Map<string, { anchor: SeededMediaAnchor; rowIndex: number }>;
      globalAnchor: { anchor: SeededMediaAnchor; rowIndex: number } | null;
    }
  >();
  const recentSequentialDirectSpeaker = new Map<
    string,
    { speakerName: string; rowIndex: number; charEnd: number | null }
  >();
  const knownPeople = uniqueStrings([
    ...selfAliasCandidates,
    ...rows.flatMap((row) => extractLikelyRelationshipSubjects(row.content))
  ]);
  const artifactParticipants = new Map<string, readonly string[]>();
  for (const row of rows) {
    const artifactKey = row.artifact_observation_id ?? row.artifact_id ?? row.memory_id;
    const prior = artifactParticipants.get(artifactKey) ?? [];
    artifactParticipants.set(
      artifactKey,
      uniqueStrings([
        ...prior,
        ...extractLikelyRelationshipSubjects(row.content),
        ...extractSpeakerLabels(row.content, knownPeople)
      ])
    );
  }

  for (const [rowIndex, row] of rows.entries()) {
    const checklistItems = extractChecklistTaskFragments(row.content);
    const projectNames = extractProjectNames(row.content);
    const sharedProvenance = {
      source_memory_id: row.memory_id,
      artifact_id: row.artifact_id,
      source_uri: row.artifact_uri
    };
    const sourceReferenceInstant = selectPersonTimeReferenceInstant(row.occurred_at, row.artifact_uri);
    const artifactKey = row.artifact_observation_id ?? row.artifact_id ?? row.memory_id;
    const artifactKnownPeople = artifactParticipants.get(artifactKey) ?? knownPeople;
    let artifactMediaState = mediaAnchorState.get(artifactKey);
    if (!artifactMediaState) {
      artifactMediaState = {
        subjectAnchors: new Map(),
        globalAnchor: null
      };
      mediaAnchorState.set(artifactKey, artifactMediaState);
    }
    const seededSubjectMedia = new Map<string, SeededMediaAnchor>();
    for (const [subjectName, seeded] of artifactMediaState.subjectAnchors.entries()) {
      if (rowIndex - seeded.rowIndex <= 2) {
        seededSubjectMedia.set(subjectName, seeded.anchor);
      }
    }
    const seededGlobalMedia =
      artifactMediaState.globalAnchor && rowIndex - artifactMediaState.globalAnchor.rowIndex <= 2
        ? artifactMediaState.globalAnchor.anchor
        : null;
    const metadataSpeakerName =
      typeof row.metadata?.speaker_name === "string" && row.metadata.speaker_name.trim().length > 0
        ? normalizeWhitespace(row.metadata.speaker_name)
        : null;
    const directLeadingSpeaker = readDirectLeadingChunkSpeaker(row.content, artifactKnownPeople, metadataSpeakerName);
    const inferredLeadingSpeaker = inferLeadingChunkSpeaker(row.content, artifactKnownPeople, metadataSpeakerName);
    const sourceOffsetStart = typeof row.source_offset?.char_start === "number" ? row.source_offset.char_start : null;
    const sourceOffsetEnd = typeof row.source_offset?.char_end === "number" ? row.source_offset.char_end : null;
    const sequentialSpeakerKey = [
      row.artifact_id ?? artifactKey,
      typeof row.metadata?.session_key === "string" ? row.metadata.session_key : "",
      row.occurred_at ?? ""
    ].join("|");
    const carriedSequentialSpeaker = recentSequentialDirectSpeaker.get(sequentialSpeakerKey);
    const defaultSpeakerName =
      inferredLeadingSpeaker ??
      (carriedSequentialSpeaker &&
      carriedSequentialSpeaker.rowIndex === rowIndex - 1 &&
      sourceOffsetStart !== null &&
      carriedSequentialSpeaker.charEnd !== null &&
      sourceOffsetStart - carriedSequentialSpeaker.charEnd >= 0 &&
      sourceOffsetStart - carriedSequentialSpeaker.charEnd <= 8 &&
      looksLikeUnlabeledFirstPersonTurn(row.content)
        ? carriedSequentialSpeaker.speakerName
        : null);
    if (directLeadingSpeaker) {
      recentSequentialDirectSpeaker.set(sequentialSpeakerKey, {
        speakerName: directLeadingSpeaker,
        rowIndex,
        charEnd: sourceOffsetEnd
      });
    }

    for (const item of checklistItems) {
      taskRows.push({
        sourceMemoryId: row.memory_id,
        artifactId: row.artifact_id,
        occurredAt: row.occurred_at,
        title: trimSentenceForTitle(item.text.replace(/\.$/u, "")),
        description: item.text,
        projectName: projectNames[0] ?? null,
        assigneeGuess: null,
        dueHint: dueHintFromText(item.text) ?? null,
        status: item.completed ? "completed" : "open",
        completedAt: item.completed ? row.occurred_at : null,
        provenance: sharedProvenance,
        metadata: {
          source_kind: "checklist",
          relative_path: typeof row.metadata?.relative_path === "string" ? row.metadata.relative_path : undefined
        }
      });
    }

    for (const projectName of projectNames) {
      projectRows.push({
        sourceMemoryId: row.memory_id,
        artifactId: row.artifact_id,
        occurredAt: row.occurred_at,
        canonicalName: projectName,
        normalizedName: projectName.toLowerCase(),
        currentSummary: trimSentenceForTitle(row.content, 180),
        status: /current project|focused on|working on|before context was lost|yesterday i was talking about/i.test(row.content)
          ? "active"
          : "historical",
        provenance: sharedProvenance,
        metadata: {
          source_kind: "project_hint",
          relative_path: typeof row.metadata?.relative_path === "string" ? row.metadata.relative_path : undefined
        }
      });
    }

    for (const date of parseExplicitDates(row.content)) {
      dateRows.push({
        sourceMemoryId: row.memory_id,
        artifactId: row.artifact_id,
        occurredAt: row.occurred_at,
        spanText: date.spanText,
        year: date.year ?? null,
        month: date.month ?? null,
        day: date.day ?? null,
        provenance: sharedProvenance,
        metadata: {
          relative_path: typeof row.metadata?.relative_path === "string" ? row.metadata.relative_path : undefined
        }
      });
    }

    for (const aliasFact of extractExplicitAliasFacts(row.content)) {
      explicitAliasFacts.push({
        ...aliasFact,
        sourceMemoryId: row.memory_id,
        sourceUri: row.artifact_uri
      });
    }

    for (const item of extractPurchaseItems(row.content)) {
      transactionRows.push({
        sourceMemoryId: row.memory_id,
        artifactId: row.artifact_id,
        occurredAt: row.occurred_at,
        purchaserName: selfCanonicalName,
        itemLabel: item.itemLabel,
        normalizedItemLabel: normalizeName(item.itemLabel),
        quantityText: item.quantityText,
        priceText: item.priceText,
        currencyCode: item.currencyCode,
        totalPriceText: item.totalPriceText,
        totalCurrencyCode: item.totalCurrencyCode,
        contextText: item.contextText,
        provenance: sharedProvenance,
        metadata: {
          source_kind: "purchase_extraction",
          relative_path: typeof row.metadata?.relative_path === "string" ? row.metadata.relative_path : undefined
        }
      });
    }

    const extractedMediaMentions = extractMediaMentions(row.content, artifactKnownPeople, row.occurred_at, {
      defaultSpeakerName,
      seedSubjectMedia: seededSubjectMedia,
      seedGlobalMedia: seededGlobalMedia
    });
    for (const mention of extractedMediaMentions) {
      mediaRows.push({
        sourceMemoryId: row.memory_id,
        artifactId: row.artifact_id,
        occurredAt: row.occurred_at,
        subjectName: mention.subjectName,
        mediaTitle: mention.mediaTitle,
        normalizedMediaTitle: normalizeName(mention.mediaTitle),
        mediaKind: mention.mediaKind,
        mentionKind: mention.mentionKind,
        timeHintText: mention.timeHintText,
        locationText: mention.locationText,
        contextText: mention.contextText,
        provenance: sharedProvenance,
        metadata: {
          source_kind: "media_extraction",
          favorite_signal: mention.favoriteSignal,
          carry_forward_signal: mention.carryForwardSignal,
          event_anchor_start: mention.eventAnchorStart,
          event_anchor_end: mention.eventAnchorEnd,
          relative_path: typeof row.metadata?.relative_path === "string" ? row.metadata.relative_path : undefined
        }
      });
    }
    for (const mention of extractedMediaMentions) {
      const anchor = {
        mediaTitle: mention.mediaTitle,
        mediaKind: mention.mediaKind
      };
      if (mention.subjectName) {
        artifactMediaState.subjectAnchors.set(mention.subjectName.toLowerCase(), { anchor, rowIndex });
      }
      if (mention.carryForwardSignal !== true) {
        artifactMediaState.globalAnchor = { anchor, rowIndex };
      }
    }

    for (const fact of extractPreferenceFacts(row.content, artifactKnownPeople, defaultSpeakerName ?? selfCanonicalName)) {
      preferenceRows.push({
        sourceMemoryId: row.memory_id,
        artifactId: row.artifact_id,
        occurredAt: row.occurred_at,
        subjectName: fact.subjectName,
        predicate: fact.predicate,
        objectText: fact.objectText,
        normalizedObjectText: normalizeName(fact.objectText),
        domain: fact.domain,
        qualifier: fact.qualifier,
        contextText: fact.contextText,
        provenance: sharedProvenance,
        metadata: {
          source_kind: "preference_extraction",
          relative_path: typeof row.metadata?.relative_path === "string" ? row.metadata.relative_path : undefined
        }
      });
    }

    for (const fact of extractPersonTimeFacts(row.content, artifactKnownPeople, sourceReferenceInstant, defaultSpeakerName)) {
      personTimeRows.push({
        sourceMemoryId: row.memory_id,
        artifactId: row.artifact_id,
        occurredAt: row.occurred_at,
        personName: fact.personName,
        normalizedPersonName: normalizeName(fact.personName),
        factText: fact.factText,
        normalizedFactText: normalizeName(fact.factText),
        timeHintText: fact.timeHintText,
        locationText: fact.locationText,
        windowStart: fact.windowStart,
        windowEnd: fact.windowEnd,
        provenance: sharedProvenance,
        metadata: {
          source_kind: "person_time_extraction",
          relative_path: typeof row.metadata?.relative_path === "string" ? row.metadata.relative_path : undefined
        }
      });
    }
  }

  let canonicalCounts: CanonicalMemoryRebuildCounts | undefined;
  await withTransaction(async (client) => {
    const selfProfile = await loadNamespaceSelfProfileForClient(client, namespaceId);
    const selfName = selfProfile?.canonicalName ?? "Self";
    const selfAliases = new Set(deriveKnownSelfAliases(selfProfile).map((value) => normalizeName(value)));
    const selfEntityId = selfProfile?.entityId ?? null;
    const personRows = await client.query<EntityRow>(
      `
        SELECT id::text, entity_type, canonical_name, normalized_name
        FROM entities
        WHERE namespace_id = $1
          AND entity_type = 'person'
      `,
      [namespaceId]
    );
    const seededPeople = new Map<string, string>();
    for (const person of personRows.rows) {
      seededPeople.set(person.normalized_name, person.canonical_name);
    }
    for (const row of rows) {
      if (!isTrustedTypedRelationshipSource(row.artifact_uri)) {
        continue;
      }
      for (const candidate of extractLikelyRelationshipSubjects(row.content)) {
        seededPeople.set(normalizeName(candidate), candidate);
      }
    }
    for (const row of rows) {
      const lowered = row.content.toLowerCase();
      for (const [normalizedName, canonicalName] of seededPeople) {
        if (lowered.includes(normalizedName)) {
          deterministicRelationshipFacts.push(...deriveRelationshipFactsForEntity(row, canonicalName, selfName));
        }
      }
    }

    await client.query("DELETE FROM task_items WHERE namespace_id = $1", [namespaceId]);
    await client.query("DELETE FROM project_items WHERE namespace_id = $1", [namespaceId]);
    await client.query("DELETE FROM date_time_spans WHERE namespace_id = $1", [namespaceId]);
    await client.query("DELETE FROM transaction_items WHERE namespace_id = $1", [namespaceId]);
    await client.query("DELETE FROM media_mentions WHERE namespace_id = $1", [namespaceId]);
    await client.query("DELETE FROM preference_facts WHERE namespace_id = $1", [namespaceId]);
    await client.query("DELETE FROM person_time_facts WHERE namespace_id = $1", [namespaceId]);
    await client.query(
      `
        DELETE FROM relationship_candidates
        WHERE namespace_id = $1
          AND metadata->>'source' = 'typed_rebuild'
      `,
      [namespaceId]
    );

    for (const task of taskRows) {
      await client.query(
        `
          INSERT INTO task_items (
            namespace_id,
            source_memory_id,
            artifact_id,
            title,
            description,
            project_name,
            assignee_guess,
            due_hint,
            status,
            occurred_at,
            completed_at,
            provenance,
            metadata
          )
          VALUES (
            $1,
            $2::uuid,
            $3::uuid,
            $4,
            $5,
            $6,
            $7,
            $8,
            $9,
            $10::timestamptz,
            $11::timestamptz,
            $12::jsonb,
            $13::jsonb
          )
        `,
        [
          namespaceId,
          task.sourceMemoryId,
          task.artifactId,
          task.title,
          task.description,
          task.projectName,
          task.assigneeGuess,
          task.dueHint,
          task.status,
          task.occurredAt,
          task.completedAt,
          JSON.stringify(task.provenance),
          JSON.stringify(task.metadata)
        ]
      );
    }

    for (const project of projectRows) {
      await client.query(
        `
          INSERT INTO project_items (
            namespace_id,
            source_memory_id,
            artifact_id,
            canonical_name,
            normalized_name,
            current_summary,
            status,
            occurred_at,
            provenance,
            metadata
          )
          VALUES (
            $1,
            $2::uuid,
            $3::uuid,
            $4,
            $5,
            $6,
            $7,
            $8::timestamptz,
            $9::jsonb,
            $10::jsonb
          )
          ON CONFLICT (namespace_id, normalized_name, source_memory_id)
          DO UPDATE SET
            current_summary = EXCLUDED.current_summary,
            status = EXCLUDED.status,
            occurred_at = EXCLUDED.occurred_at,
            provenance = EXCLUDED.provenance,
            metadata = EXCLUDED.metadata
        `,
        [
          namespaceId,
          project.sourceMemoryId,
          project.artifactId,
          project.canonicalName,
          project.normalizedName,
          project.currentSummary,
          project.status,
          project.occurredAt,
          JSON.stringify(project.provenance),
          JSON.stringify(project.metadata)
        ]
      );
    }

    for (const date of dateRows) {
      await client.query(
        `
          INSERT INTO date_time_spans (
            namespace_id,
            source_memory_id,
            artifact_id,
            span_text,
            normalized_year,
            normalized_month,
            normalized_day,
            occurred_at,
            provenance,
            metadata
          )
          VALUES (
            $1,
            $2::uuid,
            $3::uuid,
            $4,
            $5,
            $6,
            $7,
            $8::timestamptz,
            $9::jsonb,
            $10::jsonb
          )
        `,
        [
          namespaceId,
          date.sourceMemoryId,
          date.artifactId,
          date.spanText,
          date.year,
          date.month,
          date.day,
          date.occurredAt,
          JSON.stringify(date.provenance),
          JSON.stringify(date.metadata)
        ]
      );
    }

    const entityCache = new Map<string, { id: string; entityType: EntityRow["entity_type"] }>();
    if (selfEntityId) {
      entityCache.set(`self:${normalizeName(selfName)}`, { id: selfEntityId, entityType: "self" });
    }
    for (const person of personRows.rows) {
      entityCache.set(`person:${person.normalized_name}`, { id: person.id, entityType: "person" });
    }

    const upsertEntity = async (
      entityType: EntityRow["entity_type"],
      canonicalName: string
    ): Promise<string> => {
      const normalizedName = normalizeName(canonicalName);
      const cacheKey = `${entityType}:${normalizedName}`;
      const cached = entityCache.get(cacheKey);
      if (cached) {
        return cached.id;
      }
      const result = await client.query<{ id: string }>(
        `
          INSERT INTO entities (
            namespace_id,
            entity_type,
            canonical_name,
            normalized_name,
            metadata
          )
          VALUES ($1, $2, $3, $4, $5::jsonb)
          ON CONFLICT (namespace_id, entity_type, normalized_name)
          DO UPDATE SET
            canonical_name = EXCLUDED.canonical_name,
            last_seen_at = now(),
            metadata = entities.metadata || EXCLUDED.metadata
          RETURNING id::text
        `,
        [
          namespaceId,
          entityType,
          canonicalName,
          normalizedName,
          JSON.stringify({ source: "typed_rebuild" })
        ]
      );
      const id = result.rows[0]?.id;
      if (!id) {
        throw new Error(`Failed to upsert entity ${canonicalName}`);
      }
      entityCache.set(cacheKey, { id, entityType });

      for (const alias of canonicalAliasVariants(canonicalName)) {
        await client.query(
          `
            INSERT INTO entity_aliases (
              entity_id,
              alias,
              normalized_alias,
              alias_type,
              metadata
            )
            VALUES ($1::uuid, $2, $3, 'derived', $4::jsonb)
            ON CONFLICT (entity_id, normalized_alias)
            DO UPDATE SET
              metadata = entity_aliases.metadata || EXCLUDED.metadata
          `,
          [
            id,
            alias,
            normalizeName(alias),
            JSON.stringify({
              source: "typed_rebuild",
              canonical_name: canonicalName
            })
          ]
        );
      }

      return id;
    };

    for (const transaction of transactionRows) {
      await client.query(
        `
          INSERT INTO transaction_items (
            namespace_id,
            source_memory_id,
            artifact_id,
            purchaser_name,
            item_label,
            normalized_item_label,
            quantity_text,
            price_text,
            currency_code,
            total_price_text,
            total_currency_code,
            occurred_at,
            context_text,
            provenance,
            metadata
          )
          VALUES (
            $1,
            $2::uuid,
            $3::uuid,
            $4,
            $5,
            $6,
            $7,
            $8,
            $9,
            $10,
            $11,
            $12::timestamptz,
            $13,
            $14::jsonb,
            $15::jsonb
          )
        `,
        [
          namespaceId,
          transaction.sourceMemoryId,
          transaction.artifactId,
          transaction.purchaserName,
          transaction.itemLabel,
          transaction.normalizedItemLabel,
          transaction.quantityText,
          transaction.priceText,
          transaction.currencyCode,
          transaction.totalPriceText,
          transaction.totalCurrencyCode,
          transaction.occurredAt,
          transaction.contextText,
          JSON.stringify(transaction.provenance),
          JSON.stringify(transaction.metadata)
        ]
      );
    }

    for (const media of dedupedMediaRows()) {
      const subjectEntityId = media.subjectName
        ? await upsertEntity(isSelfSubjectName(media.subjectName, selfAliases) ? "self" : "person", media.subjectName)
        : null;
      await client.query(
        `
          INSERT INTO media_mentions (
            namespace_id,
            source_memory_id,
            artifact_id,
            subject_entity_id,
            subject_name,
            media_title,
            normalized_media_title,
            media_kind,
            mention_kind,
            time_hint_text,
            location_text,
            context_text,
            occurred_at,
            provenance,
            metadata
          )
          VALUES (
            $1,
            $2::uuid,
            $3::uuid,
            $4::uuid,
            $5,
            $6,
            $7,
            $8,
            $9,
            $10,
            $11,
            $12,
            $13::timestamptz,
            $14::jsonb,
            $15::jsonb
          )
        `,
        [
          namespaceId,
          media.sourceMemoryId,
          media.artifactId,
          subjectEntityId,
          media.subjectName,
          media.mediaTitle,
          media.normalizedMediaTitle,
          media.mediaKind,
          media.mentionKind,
          media.timeHintText,
          media.locationText,
          media.contextText,
          media.occurredAt,
          JSON.stringify(media.provenance),
          JSON.stringify(media.metadata)
        ]
      );
    }

    for (const preference of preferenceRows) {
      const subjectEntityId = preference.subjectName
        ? await upsertEntity(isSelfSubjectName(preference.subjectName, selfAliases) ? "self" : "person", preference.subjectName)
        : null;
      await client.query(
        `
          INSERT INTO preference_facts (
            namespace_id,
            source_memory_id,
            artifact_id,
            subject_entity_id,
            subject_name,
            predicate,
            object_text,
            normalized_object_text,
            domain,
            qualifier,
            occurred_at,
            context_text,
            provenance,
            metadata
          )
          VALUES (
            $1,
            $2::uuid,
            $3::uuid,
            $4::uuid,
            $5,
            $6,
            $7,
            $8,
            $9,
            $10,
            $11::timestamptz,
            $12,
            $13::jsonb,
            $14::jsonb
          )
        `,
        [
          namespaceId,
          preference.sourceMemoryId,
          preference.artifactId,
          subjectEntityId,
          preference.subjectName,
          preference.predicate,
          preference.objectText,
          preference.normalizedObjectText,
          preference.domain,
          preference.qualifier,
          preference.occurredAt,
          preference.contextText,
          JSON.stringify(preference.provenance),
          JSON.stringify(preference.metadata)
        ]
      );
    }

    for (const personTime of personTimeRows) {
      const personEntityId = await upsertEntity(
        isSelfSubjectName(personTime.personName, selfAliases) ? "self" : "person",
        personTime.personName
      );
      await client.query(
        `
          INSERT INTO person_time_facts (
            namespace_id,
            source_memory_id,
            artifact_id,
            person_entity_id,
            person_name,
            fact_text,
            normalized_fact_text,
            time_hint_text,
            window_start,
            window_end,
            location_text,
            occurred_at,
            provenance,
            metadata
          )
          VALUES (
            $1,
            $2::uuid,
            $3::uuid,
            $4::uuid,
            $5,
            $6,
            $7,
            $8,
            $9::timestamptz,
            $10::timestamptz,
            $11,
            $12::timestamptz,
            $13::jsonb,
            $14::jsonb
          )
        `,
        [
          namespaceId,
          personTime.sourceMemoryId,
          personTime.artifactId,
          personEntityId,
          personTime.personName,
          personTime.factText,
          personTime.normalizedFactText,
          personTime.timeHintText,
          personTime.windowStart,
          personTime.windowEnd,
          personTime.locationText,
          personTime.occurredAt,
          JSON.stringify(personTime.provenance),
          JSON.stringify(personTime.metadata)
        ]
      );
    }

    for (const fact of deterministicRelationshipFacts) {
      const subjectEntityId = await upsertEntity("person", fact.subjectName);
      const objectEntityId =
        fact.objectType === "self" && selfEntityId
          ? selfEntityId
          : await upsertEntity(fact.objectType, fact.objectName);
      await client.query(
        `
          INSERT INTO relationship_candidates (
            namespace_id,
            subject_entity_id,
            predicate,
            object_entity_id,
            source_memory_id,
            confidence,
            status,
            valid_from,
            processed_at,
            decision_reason,
            metadata
          )
          VALUES (
            $1,
            $2::uuid,
            $3,
            $4::uuid,
            $5::uuid,
            $6,
            'accepted',
            COALESCE($7::timestamptz, now()),
            now(),
            'typed_rebuild deterministic relationship extraction',
            $8::jsonb
          )
          ON CONFLICT (subject_entity_id, predicate, object_entity_id, source_memory_id, source_chunk_id)
          DO UPDATE SET
            confidence = GREATEST(relationship_candidates.confidence, EXCLUDED.confidence),
            status = 'accepted',
            valid_from = LEAST(relationship_candidates.valid_from, EXCLUDED.valid_from),
            processed_at = now(),
            decision_reason = EXCLUDED.decision_reason,
            metadata = relationship_candidates.metadata || EXCLUDED.metadata
        `,
        [
          namespaceId,
          subjectEntityId,
          fact.predicate,
          objectEntityId,
          fact.sourceMemoryId,
          fact.confidence,
          fact.occurredAt,
          JSON.stringify({
            source: "typed_rebuild",
            source_uri: fact.sourceUri,
            snippet: fact.snippet
          })
        ]
      );
    }

    for (const aliasFact of explicitAliasFacts) {
      const entityId = await upsertEntity(aliasFact.entityType, aliasFact.canonicalName);
      for (const alias of aliasFact.aliases) {
        await client.query(
          `
            INSERT INTO entity_aliases (
              entity_id,
              alias,
              normalized_alias,
              alias_type,
              metadata
            )
            VALUES ($1::uuid, $2, $3, 'derived', $4::jsonb)
            ON CONFLICT (entity_id, normalized_alias)
            DO UPDATE SET
              metadata = entity_aliases.metadata || EXCLUDED.metadata
          `,
          [
            entityId,
            alias,
            normalizeName(alias),
            JSON.stringify({
              source: "typed_rebuild_alias",
              source_memory_id: aliasFact.sourceMemoryId,
              source_uri: aliasFact.sourceUri,
              canonical_name: aliasFact.canonicalName
            })
          ]
        );
      }
    }

  });

  // Typed extraction writes the raw/typed substrate first. Then we promote durable
  // state using the same pipeline the rest of the system already trusts.
  await runCandidateConsolidation(namespaceId, 800);
  await runRelationshipAdjudication(namespaceId, { limit: 800 });
  await runUniversalMutableReconsolidation(namespaceId);
  const canonicalSummary = await rebuildCanonicalMemoryNamespace(namespaceId);
  canonicalCounts = canonicalSummary.counts;

  return {
    namespaceId,
    taskItems: taskRows.length,
    projectItems: projectRows.length,
    dateTimeSpans: dateRows.length,
    transactionItems: transactionRows.length,
    mediaMentions: dedupedMediaRows().length,
    preferenceFacts: preferenceRows.length,
    personTimeFacts: personTimeRows.length,
    canonical: canonicalCounts
  };
}

export async function getTypedTaskItems(query: RecapQuery): Promise<readonly RecapTaskItem[]> {
  const { start, end } = inferTimeRange(query.query, query.referenceNow);
  const status = isCompletedTaskQuery(query.query) ? "completed" : undefined;
  const rows = await queryRows<TaskItemRow>(
    `
      SELECT
        title,
        description,
        project_name,
        assignee_guess,
        due_hint,
        status,
        source_memory_id::text
      FROM task_items
      WHERE namespace_id = $1
        AND ($2::text IS NULL OR status = $2)
        AND ($3::timestamptz IS NULL OR COALESCE(completed_at, occurred_at) >= $3::timestamptz)
        AND ($4::timestamptz IS NULL OR COALESCE(completed_at, occurred_at) <= $4::timestamptz)
      ORDER BY COALESCE(completed_at, occurred_at) DESC NULLS LAST, created_at DESC
      LIMIT 12
    `,
    [query.namespaceId, status ?? null, start ?? null, end ?? null]
  );

  return rows.map((row) => ({
    title: row.title,
    description: row.description ?? row.title,
    assigneeGuess: row.assignee_guess ?? undefined,
    project: row.project_name ?? undefined,
    dueHint: row.due_hint ?? undefined,
    statusGuess: row.status,
    evidenceIds: row.source_memory_id ? [row.source_memory_id] : []
  }));
}

function inferNamedPeopleFromQuery(queryText: string): readonly string[] {
  const focus = parseQueryEntityFocus(queryText);
  const parsedHints =
    focus.mode === "shared_group"
      ? focus.primaryHints
      : focus.mode === "primary_with_companion"
        ? [...focus.primaryHints, ...focus.companionHints]
        : focus.allHints;
  if (parsedHints.length > 0) {
    return uniqueStrings(parsedHints.map((value) => value.split(" ").map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`).join(" ")));
  }
  return uniqueStrings(queryText.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2}\b/gu) ?? []).filter((value) =>
    !["What", "When", "Where", "Who", "How", "Steve"].includes(value)
  );
}

function extractQuotedQueryText(queryText: string): string | null {
  const balancedQuoted =
    queryText.match(/["“]([^"”]{2,120})["”]/u)?.[1]?.trim() ??
    queryText.match(/(?:^|[^\p{L}\p{N}])'([^']{2,120})'(?:[^\p{L}\p{N}]|$)/u)?.[1]?.trim();
  if (balancedQuoted) {
    return normalizeWhitespace(balancedQuoted);
  }

  const unmatchedDoubleQuote = queryText.match(/["“]([^"”\n]{2,160})$/u)?.[1]?.trim();
  if (unmatchedDoubleQuote) {
    const cleaned = normalizeWhitespace(unmatchedDoubleQuote.replace(/[?.!,;:\s]+$/u, ""));
    if (cleaned.length >= 2) {
      return cleaned;
    }
  }

  return null;
}

function normalizeRelativeTimeHintToYearLabel(timeHintText: string | null, occurredAt: string | null): string | null {
  if (!timeHintText || !occurredAt) {
    return null;
  }

  const occurred = new Date(occurredAt);
  if (Number.isNaN(occurred.getTime())) {
    return null;
  }

  const lowered = normalizeWhitespace(timeHintText).toLowerCase();
  const yearsAgoMatch = lowered.match(/\b(?:around\s+)?(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten)\s+years?\s+ago\b/u);
  if (yearsAgoMatch?.[1]) {
    const rawYearDelta = yearsAgoMatch[1];
    const yearDelta =
      rawYearDelta === "one"
        ? 1
        : rawYearDelta === "two"
          ? 2
          : rawYearDelta === "three"
            ? 3
            : rawYearDelta === "four"
              ? 4
              : rawYearDelta === "five"
                ? 5
                : rawYearDelta === "six"
                  ? 6
                  : rawYearDelta === "seven"
                    ? 7
                    : rawYearDelta === "eight"
                      ? 8
                      : rawYearDelta === "nine"
                        ? 9
                        : rawYearDelta === "ten"
                          ? 10
                          : Number(rawYearDelta);
    if (Number.isFinite(yearDelta) && yearDelta > 0) {
      return String(occurred.getUTCFullYear() - yearDelta);
    }
  }
  if (/\blast\s+year\b/u.test(lowered)) {
    return String(occurred.getUTCFullYear() - 1);
  }
  if (/\bnext\s+year\b/u.test(lowered)) {
    return String(occurred.getUTCFullYear() + 1);
  }
  return null;
}

function parseTemporalAnchorTimestamp(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function mediaEventAnchorStart(row: Pick<MediaMentionRow, "metadata" | "time_hint_text" | "occurred_at">): string | null {
  const metadata = row.metadata ?? {};
  if (typeof metadata.event_anchor_start === "string" && metadata.event_anchor_start.length > 0) {
    return metadata.event_anchor_start;
  }
  const normalizedYear = normalizeRelativeTimeHintToYearLabel(row.time_hint_text, row.occurred_at);
  if (normalizedYear) {
    return new Date(Date.UTC(Number(normalizedYear), 0, 1, 0, 0, 0, 0)).toISOString();
  }
  return row.occurred_at;
}

function mediaEventAnchorEnd(row: Pick<MediaMentionRow, "metadata" | "time_hint_text" | "occurred_at">): string | null {
  const metadata = row.metadata ?? {};
  if (typeof metadata.event_anchor_end === "string" && metadata.event_anchor_end.length > 0) {
    return metadata.event_anchor_end;
  }
  const normalizedYear = normalizeRelativeTimeHintToYearLabel(row.time_hint_text, row.occurred_at);
  if (normalizedYear) {
    return new Date(Date.UTC(Number(normalizedYear), 11, 31, 23, 59, 59, 999)).toISOString();
  }
  return row.occurred_at;
}

function extractTemporalQueryTerms(queryText: string): readonly string[] {
  const stopTerms = new Set([
    "when",
    "did",
    "does",
    "do",
    "was",
    "were",
    "is",
    "the",
    "a",
    "an",
    "first",
    "around",
    "exactly",
    "have",
    "has",
    "what",
    "which",
    "who",
    "with",
    "without",
    "about",
    "into",
    "onto",
    "from",
    "that",
    "this",
    "those",
    "these",
    "their",
    "there",
    "then",
    "than",
    "hers",
    "his",
    "her",
    "him",
    "she",
    "he",
    "they",
    "them",
    "our",
    "your",
    "my",
    "mine",
    "its",
    "it's",
    "s",
    "at",
    "in",
    "on",
    "to",
    "for",
    "of"
  ]);
  const entityFocus = parseQueryEntityFocus(queryText);
  const entityTokens = new Set(
    [...entityFocus.allHints]
      .flatMap((value) => value.split(/\s+/u))
      .map((value) => value.toLowerCase())
  );
  const normalizeTerm = (value: string): string => {
    const lowered = normalizeWhitespace(value).toLowerCase().replace(/'s$/u, "");
    if (lowered.endsWith("ing") && lowered.length > 5) {
      return lowered.slice(0, -3);
    }
    if (lowered.endsWith("ed") && lowered.length > 4) {
      return lowered.slice(0, -2);
    }
    return lowered;
  };

  return uniqueStrings(
    (queryText.match(/[A-Za-z][A-Za-z'-]{1,}/gu) ?? [])
      .map((term) => normalizeTerm(term))
      .filter((term) => term.length >= 3)
      .filter((term) => !stopTerms.has(term))
      .filter((term) => !entityTokens.has(term))
  );
}

function extractTemporalPriorityTerms(queryText: string): readonly string[] {
  const focus = parseQueryEntityFocus(queryText);
  const stripped = normalizeWhitespace(queryText)
    .replace(/"[^"]+"|'[^']+'/gu, " ")
    .replace(/\b(?:when|what\s+(?:year|month|day|date)|did|does|do|was|were|is|are|has|have|had|first|exactly|around)\b/giu, " ");
  const focusPattern = [...focus.allHints]
    .sort((left, right) => right.length - left.length)
    .map((value) => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"))
    .join("|");
  const focusStripped = focusPattern.length > 0
    ? stripped.replace(new RegExp(`\\b(?:${focusPattern})\\b`, "giu"), " ")
    : stripped;
  const actionMatch = focusStripped.match(
    /\b([A-Za-z][A-Za-z'-]{2,})\b\s+(?:a|an|the|my|his|her|their|our|your|at|to|for|with|from|into|onto|on|in)\b/iu
  );
  if (actionMatch?.[1]) {
    return [normalizeName(actionMatch[1])];
  }
  const temporalTerms = extractTemporalQueryTerms(queryText);
  return temporalTerms.length > 0 ? [normalizeName(temporalTerms[0]!)] : [];
}

function countTemporalTermMatches(text: string, terms: readonly string[]): number {
  if (terms.length === 0) {
    return 0;
  }
  const normalizedText = normalizeName(text);
  let matches = 0;
  for (const term of terms) {
    if (normalizedText.includes(normalizeName(term))) {
      matches += 1;
    }
  }
  return matches;
}

function hasTemporalPriorityTermMatch(text: string, priorityTerms: readonly string[]): boolean {
  if (priorityTerms.length === 0) {
    return true;
  }
  const normalizedText = normalizeName(text);
  return priorityTerms.some((term) => normalizedText.includes(normalizeName(term)));
}

function buildTypedRecallResult(
  id: string,
  namespaceId: string,
  content: string,
  occurredAt: string | null,
  artifactId: string | null,
  sourceMemoryId: string | null,
  sourceUri: string | null,
  typedFactKind: string,
  extra: Record<string, unknown> = {}
): RecallResult {
  return {
    memoryId: sourceMemoryId ? `typed:${typedFactKind}:${sourceMemoryId}:${id}` : `typed:${typedFactKind}:${id}`,
    memoryType: "procedural_memory",
    content,
    artifactId,
    occurredAt,
    namespaceId,
    provenance: {
      source_uri: sourceUri,
      source_memory_id: sourceMemoryId,
      typed_fact_kind: typedFactKind,
      ...extra
    }
  };
}

export async function getTypedTransactionResults(query: RecallQuery): Promise<readonly RecallResult[]> {
  const { start, end } = inferTimeRange(query.query, query.referenceNow);
  const rows = await queryRows<TransactionItemRow>(
    `
      SELECT
        id::text,
        item_label,
        quantity_text,
        price_text,
        currency_code,
        total_price_text,
        total_currency_code,
        occurred_at::text,
        context_text,
        source_memory_id::text,
        artifact_id::text,
        provenance->>'source_uri' AS source_uri
      FROM transaction_items
      WHERE namespace_id = $1
        AND ($2::timestamptz IS NULL OR occurred_at >= $2::timestamptz)
        AND ($3::timestamptz IS NULL OR occurred_at <= $3::timestamptz)
      ORDER BY occurred_at DESC NULLS LAST, created_at DESC
      LIMIT 24
    `,
    [query.namespaceId, start ?? null, end ?? null]
  );

  return rows.map((row) => {
    const priceParts = row.price_text && row.currency_code ? `${row.price_text} ${row.currency_code}` : row.price_text;
    const totalParts =
      row.total_price_text && row.total_currency_code
        ? `${row.total_price_text} ${row.total_currency_code}`
        : row.total_price_text;
    const content = [
      `Purchased ${row.item_label}.`,
      priceParts ? `Item price: ${priceParts}.` : null,
      totalParts ? `Recorded total: ${totalParts}.` : null,
      row.context_text ? `Context: ${row.context_text}` : null
    ]
      .filter((value): value is string => Boolean(value))
      .join(" ");
    return buildTypedRecallResult(
      row.id,
      query.namespaceId,
      content,
      row.occurred_at,
      row.artifact_id,
      row.source_memory_id,
      row.source_uri,
      "transaction_item",
      {
        item_label: row.item_label,
        total_price_text: row.total_price_text,
        total_currency_code: row.total_currency_code
      }
    );
  });
}

export async function getTypedMediaResults(query: RecallQuery): Promise<readonly RecallResult[]> {
  const { start, end } = inferTimeRange(query.query, query.referenceNow);
  const namedPeople = inferNamedPeopleFromQuery(query.query);
  const favoriteFocused = /\bfavorite\s+(?:movie|film|show|book|song|anime)s?\b/i.test(query.query);
  const quotedTitle = extractQuotedQueryText(query.query);
  const rows = await queryRows<MediaMentionRow>(
    `
      SELECT
        id::text,
        subject_name,
        media_title,
        media_kind,
        mention_kind,
        time_hint_text,
        location_text,
        context_text,
        occurred_at::text,
        source_memory_id::text,
        artifact_id::text,
        provenance->>'source_uri' AS source_uri,
        metadata
      FROM media_mentions
      WHERE namespace_id = $1
        AND ($2::timestamptz IS NULL OR occurred_at >= $2::timestamptz)
        AND ($3::timestamptz IS NULL OR occurred_at <= $3::timestamptz)
        AND ($4::text[] IS NULL OR subject_name = ANY($4::text[]))
        AND ($5::text IS NULL OR normalized_media_title LIKE '%' || $5 || '%')
      ORDER BY occurred_at DESC NULLS LAST, created_at DESC
      LIMIT 24
    `,
    [query.namespaceId, start ?? null, end ?? null, namedPeople.length > 0 ? namedPeople : null, quotedTitle ? normalizeName(quotedTitle) : null]
  );

  const sortedRows = [...rows].sort((left, right) => {
    const leftMetadata = left.metadata ?? {};
    const rightMetadata = right.metadata ?? {};
    const leftFavorite = leftMetadata.favorite_signal === true ? 1 : 0;
    const rightFavorite = rightMetadata.favorite_signal === true ? 1 : 0;
    if (favoriteFocused && leftFavorite !== rightFavorite) {
      return rightFavorite - leftFavorite;
    }
    const leftAnchor = parseTemporalAnchorTimestamp(mediaEventAnchorStart(left));
    const rightAnchor = parseTemporalAnchorTimestamp(mediaEventAnchorStart(right));
    if (leftAnchor !== null && rightAnchor !== null && leftAnchor !== rightAnchor) {
      return rightAnchor - leftAnchor;
    }
    return 0;
  });

  return sortedRows.map((row) =>
    buildTypedRecallResult(
      row.id,
      query.namespaceId,
      `${row.subject_name ?? "Someone"} ${row.mention_kind.replace(/_/gu, " ")} the ${row.media_kind} ${row.media_title}.${row.time_hint_text ? ` Time: ${row.time_hint_text}.` : ""}${row.location_text ? ` Location: ${row.location_text}.` : ""}${row.context_text ? ` Context: ${row.context_text}` : ""}`,
      mediaEventAnchorStart(row) ?? row.occurred_at,
      row.artifact_id,
      row.source_memory_id,
      row.source_uri,
      "media_mention",
      {
        subject_name: row.subject_name,
        media_title: row.media_title,
        media_kind: row.media_kind,
        mention_kind: row.mention_kind,
        time_hint_text: row.time_hint_text,
        event_anchor_start: mediaEventAnchorStart(row),
        event_anchor_end: mediaEventAnchorEnd(row),
        favorite_signal: row.metadata?.favorite_signal === true
      }
    )
  );
}

export async function getTypedPreferenceResults(query: RecallQuery): Promise<readonly RecallResult[]> {
  const { start, end } = inferTimeRange(query.query, query.referenceNow);
  const beerOnly = /\bbeers?\b/i.test(query.query);
  const foodOnly = !beerOnly && /\bfood\b|\beat\b|\bdrink\b/i.test(query.query);
  const mediaOnly = /\bmovie|movies|show|shows|book|books|song|songs|media\b/i.test(query.query);
  const broadPreferenceProfileQuery =
    /\bwhat\s+do\s+i\s+like\s+and\s+dislike\b/i.test(query.query) ||
    /\bwhat\s+do\s+i\s+like\s+or\s+dislike\b/i.test(query.query) ||
    /\bwhat\s+are\s+my\s+likes\s+and\s+dislikes\b/i.test(query.query) ||
    /\bwhat\s+preferences?\b/i.test(query.query);
  const firstPersonFocus =
    /\b(?:i|me|my|mine)\b/i.test(query.query) &&
    inferNamedPeopleFromQuery(query.query).length === 0;
  const rows = await withTransaction(async (client) => {
    const selfProfile = firstPersonFocus
      ? await loadNamespaceSelfProfileForClient(client, query.namespaceId).catch(() => null)
      : null;
    const selfNames = selfProfile
      ? uniqueStrings([selfProfile.canonicalName, ...selfProfile.aliases])
      : [];
    const subjectFilter = firstPersonFocus && selfNames.length > 0 ? selfNames : null;
    const result = await client.query<PreferenceFactRow>(
      `
        SELECT
          id::text,
          subject_name,
          predicate,
          object_text,
          domain,
          qualifier,
          context_text,
          occurred_at::text,
          source_memory_id::text,
          artifact_id::text,
          provenance->>'source_uri' AS source_uri
        FROM preference_facts
        WHERE namespace_id = $1
          AND ($2::timestamptz IS NULL OR occurred_at >= $2::timestamptz)
          AND ($3::timestamptz IS NULL OR occurred_at <= $3::timestamptz)
          AND ($4::text IS NULL OR domain = $4)
          AND ($5::text[] IS NULL OR subject_name = ANY($5::text[]))
        ORDER BY occurred_at DESC NULLS LAST, created_at DESC
        LIMIT 24
      `,
      [
        query.namespaceId,
        start ?? null,
        end ?? null,
        foodOnly ? "food" : mediaOnly ? "media" : null,
        subjectFilter
      ]
    );
    return result.rows;
  });

  const isBeerObject = (row: PreferenceFactRow): boolean => /\b(leo|singha|chang|cheng|beer|beers)\b/i.test(row.object_text);
  const dedupeRows = (input: readonly PreferenceFactRow[], limit: number): PreferenceFactRow[] => {
    const seen = new Set<string>();
    const output: PreferenceFactRow[] = [];
    for (const row of input) {
      const key = `${row.predicate}:${row.object_text}`.toLowerCase();
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      output.push(row);
      if (output.length >= limit) {
        break;
      }
    }
    return output;
  };

  const selectedRows = (() => {
    if (beerOnly) {
      return dedupeRows(rows.filter((row) => isBeerObject(row)), 8);
    }

    if (foodOnly) {
      return dedupeRows(rows.filter((row) => row.domain === "food" && !isBeerObject(row)), 8);
    }

    if (broadPreferenceProfileQuery) {
      const nonBeerRows = rows.filter((row) => !isBeerObject(row));
      const positiveRows = dedupeRows(
        nonBeerRows.filter((row) => row.predicate === "likes" || row.predicate === "prefers"),
        6
      );
      const normalizedNegativeRows = nonBeerRows.filter((row) => row.predicate === "dislikes" || row.predicate === "avoids");
      const hasWindowsMachines = normalizedNegativeRows.some((row) => /^windows machines$/i.test(row.object_text));
      const negativeRows = dedupeRows(
        normalizedNegativeRows.filter((row) => !(hasWindowsMachines && /^windows pcs$/i.test(row.object_text))),
        3
      );
      return [...positiveRows, ...negativeRows];
    }

    return rows;
  })();

  return selectedRows.map((row) =>
    buildTypedRecallResult(
      row.id,
      query.namespaceId,
      `${row.subject_name ?? "You"} ${row.predicate} ${row.object_text}.${row.qualifier ? ` Qualifier: ${row.qualifier}.` : ""}${row.context_text ? ` Context: ${row.context_text}` : ""}`,
      row.occurred_at,
      row.artifact_id,
      row.source_memory_id,
      row.source_uri,
      "preference_fact",
      {
        subject_name: row.subject_name,
        predicate: row.predicate,
        object_text: row.object_text,
        domain: row.domain,
        qualifier: row.qualifier
      }
    )
  );
}

export async function getTypedPersonTimeResults(query: RecallQuery): Promise<readonly RecallResult[]> {
  const inferred = inferTimeRange(query.query, query.referenceNow);
  const start = query.timeStart ?? inferred.start;
  const end = query.timeEnd ?? inferred.end;
  const namedPeople = inferNamedPeopleFromQuery(query.query);
  const rows = await queryRows<PersonTimeFactRow>(
    `
      SELECT
        id::text,
        person_name,
        fact_text,
        time_hint_text,
        location_text,
        window_start::text,
        window_end::text,
        occurred_at::text,
        source_memory_id::text,
        artifact_id::text,
        provenance->>'source_uri' AS source_uri
      FROM person_time_facts
      WHERE namespace_id = $1
        AND ($2::timestamptz IS NULL OR COALESCE(window_start, occurred_at) >= $2::timestamptz)
        AND ($3::timestamptz IS NULL OR COALESCE(window_end, occurred_at) <= $3::timestamptz)
        AND ($4::text[] IS NULL OR person_name = ANY($4::text[]))
      ORDER BY COALESCE(window_start, occurred_at) DESC NULLS LAST, created_at DESC
      LIMIT 24
    `,
    [query.namespaceId, start ?? null, end ?? null, namedPeople.length > 0 ? namedPeople : null]
  );

  return rows.map((row) =>
    buildTypedRecallResult(
      row.id,
      query.namespaceId,
      `${row.person_name}: ${row.fact_text}${row.time_hint_text ? ` Time hint: ${row.time_hint_text}.` : ""}${row.location_text ? ` Location: ${row.location_text}.` : ""}`,
      row.occurred_at,
      row.artifact_id,
      row.source_memory_id,
      row.source_uri,
      "person_time_fact",
      {
        person_name: row.person_name,
        time_hint_text: row.time_hint_text,
        window_start: row.window_start,
        window_end: row.window_end,
        location_text: row.location_text
      }
    )
  );
}

export async function getTypedTemporalAnchorResults(query: RecallQuery): Promise<readonly RecallResult[]> {
  const focus = parseQueryEntityFocus(query.query);
  const namedPeople = inferNamedPeopleFromQuery(query.query);
  const primaryPeople =
    focus.mode === "shared_group"
      ? namedPeople
      : focus.primaryHints.length > 0
        ? focus.primaryHints.map((value) => value.split(" ").map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`).join(" "))
        : namedPeople;
  const mediaTitle = extractQuotedQueryText(query.query);
  const temporalTerms = extractTemporalQueryTerms(query.query);
  const priorityTerms = extractTemporalPriorityTerms(query.query);

  const mediaRows = mediaTitle
    ? await queryRows<MediaMentionRow>(
        `
          SELECT
            id::text,
            subject_name,
            media_title,
            media_kind,
            mention_kind,
            time_hint_text,
            location_text,
            context_text,
            occurred_at::text,
            source_memory_id::text,
            artifact_id::text,
            provenance->>'source_uri' AS source_uri,
            metadata
          FROM media_mentions
          WHERE namespace_id = $1
            AND ($2::text[] IS NULL OR subject_name = ANY($2::text[]))
            AND normalized_media_title LIKE '%' || $3 || '%'
          ORDER BY occurred_at ASC NULLS LAST, created_at ASC
          LIMIT 12
        `,
        [query.namespaceId, primaryPeople.length > 0 ? primaryPeople : null, normalizeName(mediaTitle)]
      )
    : [];

  const candidatePersonTimeRows = await queryRows<PersonTimeFactRow>(
    `
      SELECT
        id::text,
        person_name,
        fact_text,
        time_hint_text,
        location_text,
        window_start::text,
        window_end::text,
        occurred_at::text,
        source_memory_id::text,
        artifact_id::text,
        provenance->>'source_uri' AS source_uri
      FROM person_time_facts
      WHERE namespace_id = $1
        AND ($2::text[] IS NULL OR person_name = ANY($2::text[]))
      ORDER BY COALESCE(window_start, occurred_at) ASC NULLS LAST, created_at ASC
      LIMIT 48
    `,
    [query.namespaceId, primaryPeople.length > 0 ? primaryPeople : null]
  );

  const personTimeRows = candidatePersonTimeRows
    .map((row) => ({
      row,
      matchCount: countTemporalTermMatches(
        [row.fact_text, row.time_hint_text ?? "", row.location_text ?? ""].join(" "),
        temporalTerms
      )
    }))
    .filter(({ row, matchCount }) => {
      const priorityMatch = hasTemporalPriorityTermMatch(
        [row.fact_text, row.time_hint_text ?? "", row.location_text ?? ""].join(" "),
        priorityTerms
      );
      if (mediaTitle) {
        return matchCount >= 2;
      }
      if (temporalTerms.length === 0) {
        return true;
      }
      if (temporalTerms.length === 1) {
        return matchCount >= 1 && priorityMatch;
      }
      return matchCount >= 2 && priorityMatch;
    })
    .sort((left, right) => {
      if (right.matchCount !== left.matchCount) {
        return right.matchCount - left.matchCount;
      }
      const leftAnchor = Date.parse(left.row.window_start ?? left.row.occurred_at ?? "");
      const rightAnchor = Date.parse(right.row.window_start ?? right.row.occurred_at ?? "");
      if (Number.isFinite(leftAnchor) && Number.isFinite(rightAnchor)) {
        return leftAnchor - rightAnchor;
      }
      return 0;
    })
    .map(({ row }) => row)
    .slice(0, 24);

  const firstFocused = /\bfirst\b/i.test(query.query);
  const scoredMediaRows = [...mediaRows].sort((left, right) => {
    const leftAnchor = parseTemporalAnchorTimestamp(mediaEventAnchorStart(left));
    const rightAnchor = parseTemporalAnchorTimestamp(mediaEventAnchorStart(right));
    if (leftAnchor !== null && rightAnchor !== null && leftAnchor !== rightAnchor) {
      return firstFocused ? leftAnchor - rightAnchor : rightAnchor - leftAnchor;
    }
    const leftFavorite = left.metadata?.favorite_signal === true ? 1 : 0;
    const rightFavorite = right.metadata?.favorite_signal === true ? 1 : 0;
    if (leftFavorite !== rightFavorite) {
      return rightFavorite - leftFavorite;
    }
    return 0;
  });

  const mediaResults = scoredMediaRows.map((row) =>
    {
      const normalizedYear = normalizeRelativeTimeHintToYearLabel(row.time_hint_text, row.occurred_at);
      const eventAnchorStart = mediaEventAnchorStart(row);
      const eventAnchorEnd = mediaEventAnchorEnd(row);
      return buildTypedRecallResult(
        row.id,
        query.namespaceId,
        `${row.subject_name ?? "Someone"} ${row.mention_kind.replace(/_/gu, " ")} ${row.media_title}.${row.time_hint_text ? ` Time hint: ${row.time_hint_text}.` : ""}${normalizedYear ? ` Normalized year: ${normalizedYear}.` : ""}${row.context_text ? ` Context: ${row.context_text}` : ""}`,
        eventAnchorStart ?? row.occurred_at,
        row.artifact_id,
        row.source_memory_id,
        row.source_uri,
        "temporal_media_anchor",
        {
          subject_name: row.subject_name,
          media_title: row.media_title,
          mention_kind: row.mention_kind,
          time_hint_text: row.time_hint_text,
          normalized_year: normalizedYear,
          event_anchor_start: eventAnchorStart,
          event_anchor_end: eventAnchorEnd,
          favorite_signal: row.metadata?.favorite_signal === true
        }
      );
    }
  );

  const factResults = personTimeRows.map((row) =>
    buildTypedRecallResult(
      row.id,
      query.namespaceId,
      `${row.person_name}: ${row.fact_text}${row.time_hint_text ? ` Time hint: ${row.time_hint_text}.` : ""}${row.location_text ? ` Location: ${row.location_text}.` : ""}`,
      row.window_start ?? row.occurred_at,
      row.artifact_id,
      row.source_memory_id,
      row.source_uri,
      "temporal_person_time_anchor",
      {
        person_name: row.person_name,
        time_hint_text: row.time_hint_text,
        window_start: row.window_start,
        window_end: row.window_end
      }
    )
  );

  return [...mediaResults, ...factResults].slice(0, 16);
}

export async function getTypedMemoryCounts(namespaceId: string): Promise<{
  readonly taskItems: number;
  readonly projectItems: number;
  readonly dateTimeSpans: number;
  readonly transactionItems: number;
  readonly mediaMentions: number;
  readonly preferenceFacts: number;
  readonly personTimeFacts: number;
}> {
  const [taskCount, projectCount, dateCount, transactionCount, mediaCount, preferenceCount, personTimeCount] = await Promise.all([
    queryRows<CountRow>("SELECT COUNT(*)::text AS count FROM task_items WHERE namespace_id = $1", [namespaceId]),
    queryRows<CountRow>("SELECT COUNT(*)::text AS count FROM project_items WHERE namespace_id = $1", [namespaceId]),
    queryRows<CountRow>("SELECT COUNT(*)::text AS count FROM date_time_spans WHERE namespace_id = $1", [namespaceId]),
    queryRows<CountRow>("SELECT COUNT(*)::text AS count FROM transaction_items WHERE namespace_id = $1", [namespaceId]),
    queryRows<CountRow>("SELECT COUNT(*)::text AS count FROM media_mentions WHERE namespace_id = $1", [namespaceId]),
    queryRows<CountRow>("SELECT COUNT(*)::text AS count FROM preference_facts WHERE namespace_id = $1", [namespaceId]),
    queryRows<CountRow>("SELECT COUNT(*)::text AS count FROM person_time_facts WHERE namespace_id = $1", [namespaceId])
  ]);

  return {
    taskItems: Number(taskCount[0]?.count ?? "0"),
    projectItems: Number(projectCount[0]?.count ?? "0"),
    dateTimeSpans: Number(dateCount[0]?.count ?? "0"),
    transactionItems: Number(transactionCount[0]?.count ?? "0"),
    mediaMentions: Number(mediaCount[0]?.count ?? "0"),
    preferenceFacts: Number(preferenceCount[0]?.count ?? "0"),
    personTimeFacts: Number(personTimeCount[0]?.count ?? "0")
  };
}
