import { resolveCanonicalEntityReference } from "../identity/service.js";
import type {
  PairBindingVerificationResult,
  SubjectBoundAggregationRequest
} from "./types.js";
import {
  extractPairQuerySurfaceNames,
  extractPrimaryQuerySurfaceNames
} from "./query-subjects.js";

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values.map((value) => String(value ?? "").trim()).filter((value) => value.length > 0))];
}

function normalize(value: string | null | undefined): string {
  return String(value ?? "").trim();
}

export async function verifyPairBinding(
  request: SubjectBoundAggregationRequest
): Promise<PairBindingVerificationResult | null> {
  const queryPairNames = extractPairQuerySurfaceNames(request.queryText);
  const contract = request.retrievalPlan.controllerIntent?.primaryTypedContract ?? null;
  const explicitPairRequired =
    queryPairNames.length >= 2 ||
    contract === "book_recommendation_pair" ||
    contract === "pair_event_inventory";
  if (!explicitPairRequired) {
    const primaryName =
      request.retrievalPlan.subjectNames[0] ??
      extractPrimaryQuerySurfaceNames(request.queryText)[0] ??
      request.subjectHints[0] ??
      null;
    if (!primaryName) {
      return {
        required: false,
        verified: false,
        primarySubjectId: null,
        primarySubjectName: null,
        pairSubjectId: null,
        pairSubjectName: null,
        reason: "no_subject_name"
      };
    }
    const primary = await resolveCanonicalEntityReference(request.namespaceId, primaryName);
    return {
      required: false,
      verified: primary !== null,
      primarySubjectId: primary?.entityId ?? null,
      primarySubjectName: primary?.canonicalName ?? primaryName,
      pairSubjectId: null,
      pairSubjectName: null,
      reason: primary ? "single_subject_resolved" : "single_subject_unresolved"
    };
  }

  const pairNames = unique([
    ...queryPairNames,
    ...request.retrievalPlan.subjectNames.slice(0, 2),
    ...request.subjectHints.slice(0, 2)
  ]).slice(0, 2);
  const primaryName = normalize(pairNames[0]);
  const pairName = normalize(pairNames[1]);
  if (!primaryName || !pairName) {
    return {
      required: true,
      verified: false,
      primarySubjectId: null,
      primarySubjectName: primaryName || null,
      pairSubjectId: null,
      pairSubjectName: pairName || null,
      reason: "pair_names_incomplete"
    };
  }

  const [primary, counterpart] = await Promise.all([
    resolveCanonicalEntityReference(request.namespaceId, primaryName),
    resolveCanonicalEntityReference(request.namespaceId, pairName)
  ]);

  return {
    required: true,
    verified: primary !== null && counterpart !== null,
    primarySubjectId: primary?.entityId ?? null,
    primarySubjectName: primary?.canonicalName ?? primaryName,
    pairSubjectId: counterpart?.entityId ?? null,
    pairSubjectName: counterpart?.canonicalName ?? pairName,
    reason:
      primary && counterpart
        ? "pair_subjects_resolved"
        : primary
          ? "pair_counterpart_unresolved"
          : counterpart
            ? "pair_primary_unresolved"
            : "pair_subjects_unresolved"
  };
}
