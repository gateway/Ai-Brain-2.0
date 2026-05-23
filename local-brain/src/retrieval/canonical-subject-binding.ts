import type { RecallResult } from "../types.js";
import type { RecallSubjectMatch } from "./types.js";
import {
  extractAnchoredQuerySurfaceNames,
  extractPairQuerySurfaceNames,
  extractPossessiveQuerySurfaceNames,
  extractPrimaryQuerySurfaceNames,
  extractQuerySurfaceNames
} from "./query-subjects.js";

export type CanonicalSubjectBindingStatus = "resolved" | "ambiguous" | "unresolved";

export interface CanonicalSubjectBindingResult {
  readonly status: CanonicalSubjectBindingStatus;
  readonly subjectEntityId: string | null;
  readonly canonicalName: string | null;
  readonly candidateEntityIds: readonly string[];
  readonly candidateNames: readonly string[];
  readonly reason: string;
}

interface SubjectCandidate {
  readonly entityId: string;
  readonly canonicalName: string | null;
  readonly score: number;
}

function normalize(value: string | null | undefined): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ");
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function isFirstPersonQueryText(queryText: string): boolean {
  return /\b(?:my|mine|me|i|i'm|i’ve|i've|i’d|i'd|i’ll|i'll)\b/iu.test(queryText);
}

function readNamedProvenanceValue(result: RecallResult, key: string): string | null {
  const direct = result.provenance[key];
  if (typeof direct === "string" && direct.trim()) {
    return direct.trim();
  }
  const metadata =
    typeof result.provenance.metadata === "object" && result.provenance.metadata !== null
      ? (result.provenance.metadata as Record<string, unknown>)
      : null;
  const nested = metadata?.[key];
  return typeof nested === "string" && nested.trim() ? nested.trim() : null;
}

function resultHasFirstPersonOwnershipCue(result: RecallResult): boolean {
  const directSignals = [
    readNamedProvenanceValue(result, "subject_name"),
    readNamedProvenanceValue(result, "speaker_name"),
    readNamedProvenanceValue(result, "transcript_speaker_name"),
    readNamedProvenanceValue(result, "primary_speaker_name"),
    readNamedProvenanceValue(result, "owner_entity_hint"),
    readNamedProvenanceValue(result, "speaker_entity_hint")
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

  const metadata =
    typeof result.provenance.metadata === "object" && result.provenance.metadata !== null
      ? (result.provenance.metadata as Record<string, unknown>)
      : null;
  const sourceTexts = [
    result.content,
    typeof metadata?.source_sentence_text === "string" ? metadata.source_sentence_text : null,
    typeof metadata?.source_turn_text === "string" ? metadata.source_turn_text : null,
    typeof metadata?.full_source_text === "string" ? metadata.full_source_text : null
  ].filter((value): value is string => typeof value === "string" && value.trim().length > 0);
  return sourceTexts.some((text) => /\b(?:my|mine|me|i|i'm|i’ve|i've|i’d|i'd|i’ll|i'll)\b/iu.test(text));
}

function collectCandidates(results: readonly RecallResult[], includeObjectCandidates: boolean): SubjectCandidate[] {
  const scored = new Map<string, SubjectCandidate>();

  for (const result of results) {
    const pairs = [
      {
        entityId: readNamedProvenanceValue(result, "subject_entity_id"),
        canonicalName: readNamedProvenanceValue(result, "subject_name"),
        baseScore: 1.25
      }
    ];
    if (includeObjectCandidates) {
      pairs.push({
        entityId: readNamedProvenanceValue(result, "object_entity_id"),
        canonicalName: readNamedProvenanceValue(result, "object_name"),
        baseScore: 0.8
      });
    }

    for (const pair of pairs) {
      if (!pair.entityId) {
        continue;
      }
      const existing = scored.get(pair.entityId);
      const score = (existing?.score ?? 0) + pair.baseScore;
      scored.set(pair.entityId, {
        entityId: pair.entityId,
        canonicalName: pair.canonicalName ?? existing?.canonicalName ?? null,
        score
      });
    }
  }

  return [...scored.values()];
}

function collectSelfOwnedCandidates(results: readonly RecallResult[]): SubjectCandidate[] {
  const scored = new Map<string, SubjectCandidate>();
  let anonymousSelfScore = 0;
  let anonymousSelfName: string | null = null;

  for (const result of results) {
    if (!resultHasFirstPersonOwnershipCue(result)) {
      continue;
    }
    const entityId = readNamedProvenanceValue(result, "subject_entity_id");
    const canonicalName =
      readNamedProvenanceValue(result, "subject_name") ??
      readNamedProvenanceValue(result, "speaker_name") ??
      readNamedProvenanceValue(result, "primary_speaker_name") ??
      null;
    if (entityId) {
      const existing = scored.get(entityId);
      scored.set(entityId, {
        entityId,
        canonicalName: canonicalName ?? existing?.canonicalName ?? null,
        score: (existing?.score ?? 0) + 2
      });
      continue;
    }
    anonymousSelfScore += 1;
    if (!anonymousSelfName && canonicalName) {
      anonymousSelfName = canonicalName;
    }
  }

  const candidates = [...scored.values()];
  if (candidates.length > 0) {
    return candidates.sort((left, right) => right.score - left.score);
  }
  if (anonymousSelfScore > 0) {
    return [{
      entityId: "__self__",
      canonicalName: anonymousSelfName ?? "self",
      score: anonymousSelfScore
    }];
  }
  return [];
}

export function resolveCanonicalSubjectBinding(params: {
  readonly queryText: string;
  readonly results: readonly RecallResult[];
  readonly subjectMatch: RecallSubjectMatch;
  readonly matchedParticipants: readonly string[];
  readonly missingParticipants: readonly string[];
  readonly foreignParticipants: readonly string[];
}): CanonicalSubjectBindingResult {
  const anchoredNames = extractAnchoredQuerySurfaceNames(params.queryText);
  const possessiveNames = extractPossessiveQuerySurfaceNames(params.queryText);
  const primaryNames = extractPrimaryQuerySurfaceNames(params.queryText);
  const pairNames = extractPairQuerySurfaceNames(params.queryText);
  const genericNames = anchoredNames.length === 0 ? extractQuerySurfaceNames(params.queryText) : [];
  const selfOwnedQuery =
    isFirstPersonQueryText(params.queryText) &&
    possessiveNames.length === 0 &&
    primaryNames.length === 0 &&
    pairNames.length === 0;
  const selfOwnedCandidates = selfOwnedQuery ? collectSelfOwnedCandidates(params.results) : [];
  if (selfOwnedCandidates.length === 1) {
    const candidate = selfOwnedCandidates[0]!;
    return {
      status: "resolved",
      subjectEntityId: candidate.entityId === "__self__" ? null : candidate.entityId,
      canonicalName: candidate.canonicalName,
      candidateEntityIds: candidate.entityId === "__self__" ? [] : [candidate.entityId],
      candidateNames: candidate.canonicalName ? [candidate.canonicalName] : [],
      reason: "First-person query resolved from self-owned provenance-backed rows."
    };
  }
  if (selfOwnedCandidates.length > 1) {
    return {
      status: "ambiguous",
      subjectEntityId: null,
      canonicalName: null,
      candidateEntityIds: selfOwnedCandidates
        .map((candidate) => candidate.entityId)
        .filter((entityId) => entityId !== "__self__"),
      candidateNames: selfOwnedCandidates
        .map((candidate) => candidate.canonicalName)
        .filter((value): value is string => Boolean(value)),
      reason: "Multiple self-owned subject candidates remained after first-person binding."
    };
  }
  const candidates = collectCandidates(params.results, anchoredNames.length === 0);
  const targetNames = [
    ...possessiveNames,
    ...primaryNames,
    ...params.matchedParticipants,
    ...params.missingParticipants,
    ...pairNames,
    ...genericNames
  ].map(normalize).filter(Boolean);
  const foreignNames = params.foreignParticipants.map(normalize).filter(Boolean);

  if (candidates.length === 0) {
    return {
      status: params.subjectMatch === "mixed" || params.subjectMatch === "mismatched" ? "ambiguous" : "unresolved",
      subjectEntityId: null,
      canonicalName: null,
      candidateEntityIds: [],
      candidateNames: [],
      reason: "No subject-backed provenance rows were available for canonical binding."
    };
  }

  const rescored = candidates.map((candidate) => {
    const name = normalize(candidate.canonicalName);
    let score = candidate.score;
    const exactPossessiveMatch = possessiveNames.some((target) => normalize(target) === name);
    if (exactPossessiveMatch) {
      score += 5;
    }
    if (targetNames.some((target) => target === name || target.includes(name) || name.includes(target))) {
      score += 3;
    }
    if (foreignNames.some((foreign) => foreign === name || foreign.includes(name) || name.includes(foreign))) {
      score -= 2;
    }
    return { ...candidate, score };
  }).sort((left, right) => right.score - left.score);

  const exactPreferredCandidate =
    rescored.find((candidate) => {
      const name = normalize(candidate.canonicalName);
      return possessiveNames.some((target) => normalize(target) === name) || primaryNames.some((target) => normalize(target) === name);
    }) ?? null;
  const top = exactPreferredCandidate ?? rescored[0]!;
  const second = rescored[1] ?? null;
  const topNames = rescored.map((candidate) => candidate.canonicalName).filter((value): value is string => Boolean(value));
  const exactPossessiveTop = possessiveNames.some((target) => normalize(target) === normalize(top.canonicalName));
  const exactPrimaryTop = primaryNames.some((target) => normalize(target) === normalize(top.canonicalName));
  const ambiguous =
    ((!exactPossessiveTop && !exactPrimaryTop && params.subjectMatch === "mixed") ||
      (!exactPossessiveTop && !exactPrimaryTop && params.subjectMatch === "mismatched")) ||
    (!exactPossessiveTop && !exactPrimaryTop && second !== null && Math.abs(top.score - second.score) < 1);

  if (ambiguous) {
    return {
      status: "ambiguous",
      subjectEntityId: null,
      canonicalName: null,
      candidateEntityIds: rescored.map((candidate) => candidate.entityId),
      candidateNames: topNames,
      reason: "Multiple plausible subject candidates remained after subject binding."
    };
  }

  return {
    status: "resolved",
    subjectEntityId: top.entityId,
    canonicalName: top.canonicalName,
    candidateEntityIds: rescored.map((candidate) => candidate.entityId),
    candidateNames: topNames,
    reason: "Canonical subject resolved from provenance-backed candidates."
  };
}
