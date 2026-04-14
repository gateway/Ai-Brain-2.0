import {
  extractPairQuerySurfaceNames,
  extractPossessiveQuerySurfaceNames,
  extractPrimaryQuerySurfaceNames,
  extractQuerySurfaceNames
} from "./query-subjects.js";
import type { SubjectPlan } from "./types.js";

function normalize(value: string | null | undefined): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ");
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))];
}

export function buildCanonicalSubjectPlan(params: {
  readonly queryText: string;
  readonly matchedParticipants: readonly string[];
  readonly missingParticipants: readonly string[];
  readonly foreignParticipants: readonly string[];
  readonly subjectEntityId?: string | null;
  readonly canonicalSubjectName?: string | null;
  readonly pairSubjectEntityId?: string | null;
  readonly pairSubjectName?: string | null;
  readonly bindingStatus?: "resolved" | "ambiguous" | "unresolved";
  readonly candidateEntityIds?: readonly string[];
  readonly candidateNames?: readonly string[];
}): SubjectPlan {
  const pairNames = extractPairQuerySurfaceNames(params.queryText);
  const possessiveNames = extractPossessiveQuerySurfaceNames(params.queryText);
  const primaryNames = extractPrimaryQuerySurfaceNames(params.queryText);
  const genericNames = extractQuerySurfaceNames(params.queryText);
  const candidateNames = uniqueStrings([
    ...possessiveNames,
    ...primaryNames,
    ...params.matchedParticipants,
    ...params.missingParticipants,
    ...pairNames,
    ...genericNames,
    ...(params.candidateNames ?? [])
  ]);
  const candidateEntityIds = uniqueStrings([...(params.candidateEntityIds ?? [])]);
  const status = params.bindingStatus ?? "unresolved";

  if (
    pairNames.length >= 2 ||
    (params.subjectEntityId && params.pairSubjectEntityId) ||
    (params.canonicalSubjectName && params.pairSubjectName)
  ) {
    const canonicalSubjectName = params.canonicalSubjectName ?? pairNames[0] ?? null;
    const pairSubjectName = params.pairSubjectName ?? pairNames[1] ?? null;
    if ((status === "resolved" && params.subjectEntityId && params.pairSubjectEntityId) || (canonicalSubjectName && pairSubjectName)) {
      return {
        kind: "pair_subject",
        subjectEntityId: params.subjectEntityId ?? null,
        canonicalSubjectName,
        pairSubjectEntityId: params.pairSubjectEntityId ?? null,
        pairSubjectName,
        candidateEntityIds,
        candidateNames,
        reason:
          params.subjectEntityId && params.pairSubjectEntityId
            ? "Pair subject plan resolved from canonical graph subjects."
            : `Pair subject plan anchored to explicit query names ${canonicalSubjectName} and ${pairSubjectName}.`
      };
    }
    return {
      kind: status === "ambiguous" ? "ambiguous_subject" : "no_subject",
      subjectEntityId: null,
      canonicalSubjectName: null,
      pairSubjectEntityId: null,
      pairSubjectName: null,
      candidateEntityIds,
      candidateNames,
      reason:
        status === "ambiguous"
          ? "Pair query remained ambiguous after canonical subject planning."
          : "Pair query could not resolve both canonical subjects."
    };
  }

  if (status === "resolved" && params.subjectEntityId) {
    return {
      kind: "single_subject",
      subjectEntityId: params.subjectEntityId,
      canonicalSubjectName: params.canonicalSubjectName ?? possessiveNames[0] ?? primaryNames[0] ?? candidateNames[0] ?? null,
      candidateEntityIds,
      candidateNames,
      reason: "Single-subject plan resolved from canonical subject binding."
    };
  }

  if (status === "ambiguous") {
    const foreignNames = params.foreignParticipants.map(normalize).filter(Boolean);
    const overlapping = candidateNames.filter((name) => foreignNames.includes(normalize(name)));
    if (possessiveNames.length > 0) {
      return {
        kind: "single_subject",
        subjectEntityId: params.subjectEntityId ?? null,
        canonicalSubjectName: possessiveNames[0] ?? null,
        candidateEntityIds,
        candidateNames,
        reason:
          params.subjectEntityId
            ? `Possessive anchor ${possessiveNames[0]} resolved the subject plan.`
            : `Possessive anchor ${possessiveNames[0]} kept the query single-subject while canonical evidence stayed incomplete.`
      };
    }
    if (primaryNames.length === 1) {
      return {
        kind: "single_subject",
        subjectEntityId: params.subjectEntityId ?? null,
        canonicalSubjectName: primaryNames[0] ?? null,
        candidateEntityIds,
        candidateNames,
        reason:
          params.subjectEntityId
            ? `Primary name anchor ${primaryNames[0]} resolved the subject plan despite ambiguous evidence.`
            : `Primary name anchor ${primaryNames[0]} kept the query single-subject while canonical evidence stayed incomplete.`
      };
    }
    return {
      kind: "ambiguous_subject",
      subjectEntityId: null,
      canonicalSubjectName: null,
      candidateEntityIds,
      candidateNames,
      reason:
        overlapping.length > 0
          ? `Subject plan stayed ambiguous because foreign participants overlapped with query names: ${overlapping.join(", ")}.`
          : "Subject plan stayed ambiguous after canonical subject binding."
    };
  }

  if (primaryNames.length === 1) {
    return {
      kind: "single_subject",
      subjectEntityId: params.subjectEntityId ?? null,
      canonicalSubjectName: primaryNames[0] ?? null,
      candidateEntityIds,
      candidateNames,
      reason: `Primary name anchor ${primaryNames[0]} kept the subject plan single-subject.`
    };
  }

  if (possessiveNames.length > 0) {
    return {
      kind: "single_subject",
      subjectEntityId: params.subjectEntityId ?? null,
      canonicalSubjectName: possessiveNames[0] ?? null,
      candidateEntityIds,
      candidateNames,
      reason: `Possessive anchor ${possessiveNames[0]} kept the subject plan single-subject.`
    };
  }

  return {
    kind: "no_subject",
    subjectEntityId: null,
    canonicalSubjectName: null,
    candidateEntityIds,
    candidateNames,
    reason: "No canonical subject plan could be established for the query."
  };
}
