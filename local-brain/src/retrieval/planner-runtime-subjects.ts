import { normalizeEntityLookupName } from "../identity/canonicalization.js";
import type { RecallResult } from "../types.js";
import type { AnswerRetrievalPlan } from "./types.js";
import { extractRecallResultSubjectSignals } from "./recall-content.js";

function normalize(value: string | null | undefined): string {
  return String(value ?? "").trim();
}

function extractPlannerRuntimeResultSubjectEntityId(result: RecallResult): string | null {
  if (typeof result.provenance.subject_entity_id === "string" && result.provenance.subject_entity_id.trim().length > 0) {
    return result.provenance.subject_entity_id.trim();
  }
  const metadata =
    typeof result.provenance.metadata === "object" && result.provenance.metadata !== null
      ? (result.provenance.metadata as Record<string, unknown>)
      : null;
  if (typeof metadata?.subject_entity_id === "string" && metadata.subject_entity_id.trim().length > 0) {
    return metadata.subject_entity_id.trim();
  }
  return null;
}

function extractPlannerRuntimeResultSubjectSignals(result: RecallResult): readonly string[] {
  return extractRecallResultSubjectSignals(result);
}

export function extractPlannerRuntimePrimarySubjectSignals(result: RecallResult): readonly string[] {
  const metadata =
    typeof result.provenance.metadata === "object" && result.provenance.metadata !== null
      ? (result.provenance.metadata as Record<string, unknown>)
      : null;
  return [
    result.provenance.subject_name,
    result.provenance.transcript_speaker_name,
    result.provenance.speaker_name,
    result.provenance.canonical_name,
    (result.provenance as Record<string, unknown>).person_name,
    metadata?.subject_name,
    metadata?.transcript_speaker_name,
    metadata?.speaker_name,
    metadata?.canonical_name,
    metadata?.primary_speaker_name,
    metadata?.person_name
  ]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map((value) => normalizeEntityLookupName(value))
    .filter(Boolean);
}

export function inferPlannerRuntimeResolvedSubjectEntityId(params: {
  readonly retrievalPlan: AnswerRetrievalPlan;
  readonly results: readonly RecallResult[];
}): string | null {
  if (params.retrievalPlan.resolvedSubjectEntityId) {
    return params.retrievalPlan.resolvedSubjectEntityId;
  }
  const subjectName = params.retrievalPlan.subjectNames[0];
  const normalizedSubjectName = subjectName ? normalizeEntityLookupName(subjectName) : null;
  const candidateIds = new Set<string>();
  for (const result of params.results) {
    const entityId = extractPlannerRuntimeResultSubjectEntityId(result);
    if (!entityId) {
      continue;
    }
    if (!normalizedSubjectName) {
      candidateIds.add(entityId);
      continue;
    }
    const signals = extractPlannerRuntimeResultSubjectSignals(result);
    if (signals.some((signal) => signal.includes(normalizedSubjectName))) {
      candidateIds.add(entityId);
    }
  }
  return candidateIds.size === 1 ? [...candidateIds][0] : null;
}

export function filterPlannerRuntimeResultsForExplicitSubject(
  subjectHints: readonly string[],
  results: readonly RecallResult[]
): readonly RecallResult[] {
  const normalizedHints = subjectHints.map((value) => normalizeEntityLookupName(value)).filter(Boolean);
  if (normalizedHints.length === 0) {
    return results;
  }
  const strictPrimaryMatches = results.filter((result) => {
    const primarySignals = extractPlannerRuntimePrimarySubjectSignals(result);
    return primarySignals.length > 0 && normalizedHints.some((hint) => primarySignals.some((signal) => signal.includes(hint)));
  });
  if (strictPrimaryMatches.length > 0) {
    return strictPrimaryMatches;
  }
  const filtered = results.filter((result) => {
    const primarySignals = extractPlannerRuntimePrimarySubjectSignals(result);
    if (primarySignals.length > 0 && !normalizedHints.some((hint) => primarySignals.some((signal) => signal.includes(hint)))) {
      return false;
    }
    const signals = extractPlannerRuntimeResultSubjectSignals(result);
    return normalizedHints.some((hint) => signals.some((signal) => signal.includes(hint)));
  });
  return filtered.length > 0 ? filtered : results;
}

export function hasStrongPlannerRuntimeNameBoundSubject(params: {
  readonly subjectHints: readonly string[];
  readonly retrievalPlan: AnswerRetrievalPlan;
  readonly results: readonly RecallResult[];
}): boolean {
  if (params.retrievalPlan.subjectNames.length !== 1) {
    return false;
  }
  const subjectName = params.retrievalPlan.subjectNames[0];
  const normalizedSubjectName = subjectName ? normalizeEntityLookupName(subjectName) : null;
  if (!normalizedSubjectName) {
    return false;
  }
  const filteredResults = filterPlannerRuntimeResultsForExplicitSubject(params.subjectHints, params.results);
  if (filteredResults.length === 0) {
    return false;
  }
  const boundCount = filteredResults.filter((result) =>
    extractPlannerRuntimeResultSubjectSignals(result).some((signal) => signal.includes(normalizedSubjectName))
  ).length;
  return boundCount > 0 && boundCount >= Math.max(1, Math.ceil(filteredResults.length * 0.6));
}
