import { normalizeWhitespace } from "./canonicalization.js";

export type EntityResolutionDecision = "auto_attach" | "prompt_merge" | "prompt_choose" | "create_new" | "keep_separate";

export interface EntityResolutionCandidateInput {
  readonly entityId: string;
  readonly canonicalName: string;
  readonly entityType: string;
  readonly aliases?: readonly string[];
  readonly relationshipNeighbors?: readonly string[];
  readonly places?: readonly string[];
  readonly sourceUris?: readonly string[];
  readonly activeFrom?: string | null;
  readonly activeUntil?: string | null;
}

export interface EntityResolutionMentionInput {
  readonly observedName: string;
  readonly expectedEntityType?: string;
  readonly relationshipNeighbors?: readonly string[];
  readonly places?: readonly string[];
  readonly sourceUris?: readonly string[];
  readonly occurredAt?: string | null;
}

export interface EntityResolutionCandidate {
  readonly entityId: string;
  readonly canonicalName: string;
  readonly entityType: string;
  readonly score: number;
  readonly scoreBreakdown: {
    readonly name: number;
    readonly type: number;
    readonly relationship: number;
    readonly place: number;
    readonly source: number;
    readonly time: number;
  };
  readonly reasons: readonly string[];
}

export interface EntityResolutionCandidateSet {
  readonly observedName: string;
  readonly candidates: readonly EntityResolutionCandidate[];
  readonly decision: EntityResolutionDecision;
  readonly promptRequired: boolean;
  readonly promptKind: "one_candidate" | "multiple_candidates" | "no_candidates" | "none";
  readonly selectedEntityId: string | null;
  readonly ambiguousMergeSilentAccept: boolean;
}

function key(value: string): string {
  return normalizeWhitespace(value).toLowerCase();
}

function diceSimilarity(left: string, right: string): number {
  const a = key(left);
  const b = key(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const bigrams = (value: string) => new Set(Array.from({ length: Math.max(value.length - 1, 0) }, (_, index) => value.slice(index, index + 2)));
  const leftSet = bigrams(a);
  const rightSet = bigrams(b);
  if (leftSet.size === 0 || rightSet.size === 0) return 0;
  let overlap = 0;
  for (const item of leftSet) {
    if (rightSet.has(item)) overlap += 1;
  }
  return Number(((2 * overlap) / (leftSet.size + rightSet.size)).toFixed(4));
}

function overlapScore(left: readonly string[] = [], right: readonly string[] = []): number {
  const leftSet = new Set(left.map(key).filter(Boolean));
  const rightSet = new Set(right.map(key).filter(Boolean));
  if (leftSet.size === 0 || rightSet.size === 0) return 0;
  let overlap = 0;
  for (const item of leftSet) {
    if (rightSet.has(item)) overlap += 1;
  }
  return Number((overlap / Math.max(leftSet.size, rightSet.size)).toFixed(4));
}

function year(value: string | null | undefined): number | null {
  const match = value?.match(/\b(19|20)\d{2}\b/u)?.[0] ?? null;
  return match ? Number(match) : null;
}

function timeScore(mentionAt: string | null | undefined, candidate: EntityResolutionCandidateInput): number {
  const mentionYear = year(mentionAt);
  if (mentionYear === null) return 0;
  const fromYear = year(candidate.activeFrom);
  const untilYear = year(candidate.activeUntil);
  if (fromYear === null && untilYear === null) return 0;
  if ((fromYear === null || mentionYear >= fromYear) && (untilYear === null || mentionYear <= untilYear)) return 1;
  return 0;
}

function nameScore(mention: EntityResolutionMentionInput, candidate: EntityResolutionCandidateInput): number {
  const names = [candidate.canonicalName, ...(candidate.aliases ?? [])];
  return Math.max(...names.map((name) => diceSimilarity(mention.observedName, name)), 0);
}

export function buildEntityResolutionCandidateSet(
  mention: EntityResolutionMentionInput,
  candidates: readonly EntityResolutionCandidateInput[]
): EntityResolutionCandidateSet {
  const scored = candidates
    .map((candidate) => {
      const scoreBreakdown = {
        name: nameScore(mention, candidate),
        type: mention.expectedEntityType && key(mention.expectedEntityType) === key(candidate.entityType) ? 1 : mention.expectedEntityType ? 0 : 0.25,
        relationship: overlapScore(mention.relationshipNeighbors, candidate.relationshipNeighbors),
        place: overlapScore(mention.places, candidate.places),
        source: overlapScore(mention.sourceUris, candidate.sourceUris),
        time: timeScore(mention.occurredAt, candidate)
      };
      const score = Number(
        (
          scoreBreakdown.name * 0.42 +
          scoreBreakdown.type * 0.18 +
          scoreBreakdown.relationship * 0.16 +
          scoreBreakdown.place * 0.1 +
          scoreBreakdown.source * 0.08 +
          scoreBreakdown.time * 0.06
        ).toFixed(4)
      );
      const reasons = Object.entries(scoreBreakdown)
        .filter(([, value]) => value > 0)
        .map(([field]) => `${field}_support`);
      return {
        entityId: candidate.entityId,
        canonicalName: candidate.canonicalName,
        entityType: candidate.entityType,
        score,
        scoreBreakdown,
        reasons
      };
    })
    .filter((candidate) => candidate.scoreBreakdown.name >= 0.55 || candidate.score >= 0.55)
    .sort((left, right) => right.score - left.score);

  const top = scored[0] ?? null;
  const second = scored[1] ?? null;
  const ambiguous = Boolean(top && second && top.score - second.score < 0.12);
  let decision: EntityResolutionDecision = "create_new";
  let promptKind: EntityResolutionCandidateSet["promptKind"] = "no_candidates";
  let selectedEntityId: string | null = null;

  if (!top) {
    decision = "create_new";
    promptKind = "no_candidates";
  } else if (ambiguous) {
    decision = "prompt_choose";
    promptKind = "multiple_candidates";
  } else if (top.score >= 0.9 && key(mention.observedName) === key(top.canonicalName)) {
    decision = "auto_attach";
    promptKind = "none";
    selectedEntityId = top.entityId;
  } else {
    decision = "prompt_merge";
    promptKind = "one_candidate";
  }

  return {
    observedName: normalizeWhitespace(mention.observedName),
    candidates: scored.slice(0, 6),
    decision,
    promptRequired: promptKind !== "none",
    promptKind,
    selectedEntityId,
    ambiguousMergeSilentAccept: ambiguous && selectedEntityId !== null
  };
}
